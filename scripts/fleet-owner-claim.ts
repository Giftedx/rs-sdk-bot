import {existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {FLEET_DIR, FLEET_WORKTREE, SIDE_NAME, type Owner} from '../packages/core/src/fleet';
import {recoverConcurrentPlanWrite, withPlanWrite} from '../packages/core/src/plan-lock';

const OWNERS = 'fleet/owners.json';
const REF = 'refs/heads/fleet-data';
const TRACKING = 'refs/remotes/origin/fleet-data';
const GIT_TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;

export function withFleetDataWrite<T>(root: string, action: () => T | Promise<T>, timeoutMs?: number) {
    return withPlanWrite(action, join(root, '.practice', 'fleet-data-write'), timeoutMs, recoverConcurrentPlanWrite);
}

type GitOptions = {index?: string; input?: string};
async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<string | null> {
    const child = Bun.spawn(['git', ...args], {
        cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS,
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.index ? {GIT_INDEX_FILE: options.index} : {})},
        stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input),
        stdout: 'pipe', stderr: 'ignore',
    });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 ? out.trimEnd() : null;
}

async function requiredGit(cwd: string, args: string[], options?: GitOptions): Promise<string> {
    const result = await git(cwd, args, options);
    if (result === null) throw Error('fleet registry git ' + args[0] + ' failed');
    return result;
}

type Registry = {accounts: Record<string, Owner & {reservation?: string; home?: string}>};

function registryFrom(raw: string): Registry {
    const registry = JSON.parse(raw) as Registry;
    if (!registry?.accounts || typeof registry.accounts !== 'object' || Array.isArray(registry.accounts)) throw Error('invalid fleet owner registry');
    const seen = new Set<string>();
    for (const [name, row] of Object.entries(registry.accounts)) {
        const lower = name.toLowerCase();
        if (!/^[A-Za-z0-9]{1,12}$/.test(name) || seen.has(lower) || typeof row?.side !== 'string' || !SIDE_NAME.test(row.side)
            || typeof row.server !== 'string' || (row.reservation !== undefined && typeof row.reservation !== 'string')
            || (row.home !== undefined && (typeof row.home !== 'string' || !SIDE_NAME.test(row.home)))) throw Error('invalid fleet owner registry');
        seen.add(lower);
    }
    return registry;
}

export type OwnerMove = {account: string; from: string; to: string; home: string | null};

// Applies the moves whose row still names `from` (another side may have moved it first) to a registry copy.
export function applyMoves(registry: Registry, moves: readonly OwnerMove[]): OwnerMove[] {
    const applied: OwnerMove[] = [];
    for (const m of moves) {
        const name = Object.keys(registry.accounts).find(k => k.toLowerCase() === m.account.toLowerCase());
        const row = name ? registry.accounts[name] : undefined;
        if (!name || !row || row.side !== m.from || row.reservation || !SIDE_NAME.test(m.to) || m.to === m.from) continue;
        const next: Owner & {home?: string} = {side: m.to, server: row.server};
        if (m.home && m.home !== m.to) next.home = m.home;
        registry.accounts[name] = next;
        applied.push({...m, account: name});
    }
    return applied;
}

const gitSync = (cwd: string, args: string[], options: GitOptions = {}): string | null => {
    const p = Bun.spawnSync(['git', ...args], {cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS,
        stdin: options.input === undefined ? 'ignore' : Buffer.from(options.input), stdout: 'pipe', stderr: 'ignore',
        env: {...process.env, GIT_TERMINAL_PROMPT: '0', ...(options.index ? {GIT_INDEX_FILE: options.index} : {})}});
    return p.exitCode === 0 ? p.stdout.toString().trimEnd() : null;
};
const mustSync = (cwd: string, args: string[], options?: GitOptions) => {
    const r = gitSync(cwd, args, options);
    if (r === null) throw Error('fleet registry git ' + args[0] + ' failed');
    return r;
};

/**
 * Moves owner rows on the published fleet-data branch (fleet adoption, packages/core/src/fleet-assign.ts). Each try
 * reads the remote tip, keeps only the moves whose row still names the expected side, and pushes one commit as a
 * fast-forward: the compare-and-swap. The caller holds the fleet-data write lock and has no unpublished fleet-data
 * commits; the worktree then fast-forwards to the result. Returns the moves that landed.
 */
export function transferFleetOwnersLocked(root: string, moves: readonly OwnerMove[], worktree = FLEET_WORKTREE): OwnerMove[] {
    if (!moves.length) return [];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        mustSync(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', REF + ':' + TRACKING]);
        const tip = mustSync(root, ['rev-parse', TRACKING]);
        const registry = registryFrom(mustSync(root, ['show', tip + ':' + OWNERS]));
        const applied = applyMoves(registry, moves);
        if (!applied.length) return [];
        const scratch = mkdtempSync(join(tmpdir(), 'rsbot-owner-index-')), index = join(scratch, 'index');
        let commit: string;
        try {
            const blob = mustSync(root, ['hash-object', '-w', '--stdin'], {input: JSON.stringify(registry, null, 1) + '\n'});
            mustSync(root, ['read-tree', tip], {index});
            mustSync(root, ['update-index', '--cacheinfo', '100644,' + blob + ',' + OWNERS], {index});
            const tree = mustSync(root, ['write-tree'], {index});
            const to = [...new Set(applied.map(m => m.to))].join('+');
            commit = mustSync(root, ['-c', 'user.name=Fleet adoption', '-c', 'user.email=fleet@localhost', 'commit-tree', tree, '-p', tip,
                '-m', `fleet: ${to} takes ${applied.map(m => `${m.account} (${m.from})`).join(', ')}`]);
        } finally {
            if (existsSync(index)) unlinkSync(index);
            rmdirSync(scratch);
        }
        if (gitSync(root, ['push', 'origin', commit + ':' + REF]) !== null) {
            gitSync(worktree, ['merge', '--ff-only', '--quiet', commit]);
            return applied;
        }
    }
    throw Error('fleet owner transfer lost the race three times; the next sync tries again');
}

export interface FleetOwnerClaim {
    account: string;
    side: string;
    server: string;
    /** One coordinator run ID. A lost push result can only be recovered by its original claimant. */
    reservation: string;
}

/**
 * Reserve exactly one name on the published fleet-data branch, then refresh the local registry before login.
 * A normal fast-forward push is the compare-and-swap. The scratch index keeps unrelated orders out of the commit.
 */
export async function reserveFleetOwner(
    root: string, claim: FleetOwnerClaim,
    worktree = FLEET_WORKTREE, fleetDir = FLEET_DIR(),
): Promise<boolean> {
    const {account, side, server, reservation} = claim;
    if (!/^[A-Za-z0-9]{1,12}$/.test(account) || !SIDE_NAME.test(side) || server !== 'rs-sdk-demo.fly.dev'
        || !/^task-[a-f0-9-]{36}$/.test(reservation)) throw Error('invalid fleet owner claim');
    if (resolve(fleetDir) !== resolve(worktree, 'fleet') || !existsSync(join(worktree, '.git')))
        throw Error('provisioning requires the synced fleet-data worktree');

    return withFleetDataWrite(root, async () => {
        if (await git(worktree, ['symbolic-ref', 'HEAD']) !== REF
            || await requiredGit(worktree, ['status', '--porcelain', '--', OWNERS]) !== ''
            || await requiredGit(worktree, ['diff', '--cached', '--name-only']) !== '')
            throw Error('fleet-data worktree has an unresolved local edit');

        const refreshCache=async (revision:string) => {
            await requiredGit(worktree, ['merge', '--ff-only', revision]);
            if (await requiredGit(worktree, ['rev-parse', 'HEAD']) !== revision)
                throw Error('fleet-data worktree has unpublished commits');
        };
        const confirmCache=async (revision:string) => {
            await refreshCache(revision);
            const owner=registryFrom(readFileSync(join(worktree,OWNERS),'utf8')).accounts[account];
            if (owner?.side !== side || owner.server !== server || owner.reservation !== reservation)
                throw Error('fleet owner reservation missing from local registry');
            return true;
        };
        for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
            await requiredGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', REF + ':' + TRACKING]);
            const tip = await requiredGit(root, ['rev-parse', TRACKING]);
            const registry = registryFrom(await requiredGit(root, ['show', tip + ':' + OWNERS]));
            const name = Object.keys(registry.accounts).find(key => key.toLowerCase() === account.toLowerCase());
            if (name) {
                const owner = registry.accounts[name]!;
                if (name !== account || owner.side !== side || owner.server !== server || owner.reservation !== reservation) return false;
                return confirmCache(tip);
            }

            // Catch up before offering the remote change so a locally diverged registry never reaches login.
            await refreshCache(tip);
            registry.accounts[account] = {side, server, reservation};
            const scratch = mkdtempSync(join(tmpdir(), 'rsbot-owner-index-')), index = join(scratch, 'index');
            let commit: string;
            try {
                const blob = await requiredGit(root, ['hash-object', '-w', '--stdin'], {input: JSON.stringify(registry, null, 1) + '\n'});
                await requiredGit(root, ['read-tree', tip], {index});
                await requiredGit(root, ['update-index', '--cacheinfo', '100644,' + blob + ',' + OWNERS], {index});
                const tree = await requiredGit(root, ['write-tree'], {index});
                commit = await requiredGit(root, ['-c', 'user.name=Fleet coordinator', '-c', 'user.email=fleet@localhost',
                    'commit-tree', tree, '-p', tip, '-m', 'fleet: reserve account ' + account]);
            } finally {
                if (existsSync(index)) unlinkSync(index);
                rmdirSync(scratch);
            }
            if (await git(root, ['push', 'origin', commit + ':' + REF]) !== null) return confirmCache(commit);
            // The push may have won even if the transport failed. Read the ref before trying again.
        }
        throw Error('fleet owner reservation could not be confirmed');
    });
}
