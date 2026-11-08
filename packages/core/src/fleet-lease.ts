import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { LEASE_MAX_AGE_MS, SIDE_NAME } from './fleet';

export const FLEET_LEASE_TTL_MS = 10 * 60_000;
export const FLEET_LEASE_RENEW_MS = 3 * 60_000;
// Stop locally before another host may claim. This leaves time for logout and clock skew.
const DRAIN_MS = 2 * 60_000;
const GIT_DEADLINE_MS = 11_000;
const HOLDER = /^[0-9a-f-]{36}$/;
const WORKER_HOLDER = /^[a-z][a-z0-9-]{0,23}:[0-9a-f-]{36}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LEGACY_REF = 'refs/heads/fleet-data';
type RemoteLease = { side: string; host: string; holder: string; epoch: string; pid: number; at: number };

export function fleetGitWindow(root: string, authority = 'fleet controller lease authority') {
    const deadline = performance.now() + GIT_DEADLINE_MS;
    return (args: string[], input?: string): string => {
        const timeout = Math.floor(deadline - performance.now());
        if (timeout <= 0) throw Error(authority + ' timed out');
        try {
            return execFileSync('git', args, {
                cwd: root, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
            }).trim();
        } catch {
            throw Error(authority + ' unavailable or changed');
        }
    };
}

type FleetGit = ReturnType<typeof fleetGitWindow>;

export function readFleetGitRefs(git: FleetGit, refs: readonly string[]) {
    const found = new Map<string, string>();
    for (const line of git(['ls-remote', '--refs', 'origin', ...refs]).split('\n').filter(Boolean)) {
        const [sha, name] = line.trim().split(/\s+/);
        if (!sha || !SHA.test(sha) || !name || !refs.some(ref => ref.endsWith('*') ? name.startsWith(ref.slice(0, -1)) : name === ref)) {
            throw Error('fleet Git authority has an invalid ref');
        }
        found.set(name, sha);
    }
    return found;
}

// Publishing a child of the observed head gives one winner without forcing the remote ref.
export function appendFleetGitRecord(git: FleetGit, ref: string, head: string | undefined, tree: string, message: string) {
    const next = git(['-c', 'user.name=Fleet Controller', '-c', 'user.email=fleet-controller@users.noreply.github.com',
        'commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], message + '\n');
    git(['-c', 'push.followTags=false', 'push', '--quiet', 'origin', next + ':' + ref]);
    return next;
}

function localHolder(root: string): string {
    const dir = join(root, '.practice'), file = join(dir, 'fleet-controller-id');
    mkdirSync(dir, { recursive: true });
    try { writeFileSync(file, randomUUID(), { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const holder = readFileSync(file, 'utf8').trim();
    if (!HOLDER.test(holder)) throw Error('fleet controller identity unreadable');
    return holder;
}

const fenceFile = (root: string) => join(root, '.practice', 'fleet-controller-fence.json');

export function fleetLeaseAllowsWorker(root: string, holder = process.env.SWARM_LEASE_HOLDER, now = Date.now()): boolean {
    if (holder === undefined) return true; // Workers launched outside swarm have their own admission path.
    if (!WORKER_HOLDER.test(holder)) return false;
    try {
        const fence = JSON.parse(readFileSync(fenceFile(root), 'utf8'));
        return fence.holder === holder && Number.isSafeInteger(fence.until) && now < fence.until;
    } catch { return false; }
}

function writeFence(root: string, holder: string, until: number) {
    const path = fenceFile(root), tmp = path + '.' + process.pid;
    writeFileSync(tmp, JSON.stringify({ holder, until }));
    renameSync(tmp, path);
}

function deadLocalPid(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function parseRemote(raw: string, side: string): RemoteLease {
    const lease = JSON.parse(raw);
    if (lease?.side !== side || typeof lease.host !== 'string' || !lease.host || !HOLDER.test(lease.holder) || !HOLDER.test(lease.epoch)
        || !Number.isSafeInteger(lease.pid) || lease.pid <= 0 || !Number.isSafeInteger(lease.at) || lease.at <= 0) {
        throw Error('fleet controller lease authority has an invalid record');
    }
    return lease;
}

// The remote ref is the authority. A contender writes a child of the exact head it read.
// An ordinary fast-forward push lets only one child of that head win. No local branch,
// worktree, remote-tracking ref, or fleet-data index is changed by an acquisition or renewal.
export function acquireFleetLease(root: string, side: string, now = Date.now) {
    if (!SIDE_NAME.test(side)) throw Error('invalid fleet lease side');
    const holder = localHolder(root), host = hostname(), pid = process.pid;
    let epoch: string = randomUUID();
    const ref = 'refs/heads/fleet-lease/' + side;
    const git = fleetGitWindow(root);
    const refs = readFleetGitRefs(git, [ref, LEGACY_REF]);
    let head = refs.get(ref);
    if (head) {
        git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', head]);
        const old = parseRemote(git(['show', '-s', '--format=%B', head]), side);
        const localSuccessor = old.host === host && old.holder === holder && deadLocalPid(old.pid);
        if (now() - old.at < FLEET_LEASE_TTL_MS && !localSuccessor) throw Error('fleet controller lease held by ' + old.host + ' pid ' + old.pid);
        // A routine controller rollout can adopt detached workers. After an expiry or
        // remote takeover, use a new epoch so an old orphan cannot start another session.
        if (localSuccessor && now() - old.at < FLEET_LEASE_TTL_MS - DRAIN_MS
            && fleetLeaseAllowsWorker(root, side + ':' + old.epoch, now())) epoch = old.epoch;
    } else {
        const legacy = refs.get(LEGACY_REF);
        if (legacy) {
            git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', 'origin', legacy]);
            const path = 'fleet/leases/' + side + '.json';
            if (git(['ls-tree', '--name-only', legacy, '--', path]) === path) {
                const old = JSON.parse(git(['show', legacy + ':' + path]));
                if (typeof old?.host !== 'string' || !Number.isSafeInteger(old?.at) || !Number.isSafeInteger(old?.pid)) throw Error('legacy fleet lease has an invalid record');
                if (now() - old.at < LEASE_MAX_AGE_MS && !(old.host === host && deadLocalPid(old.pid))) {
                    throw Error('legacy fleet controller lease held by ' + old.host + ' pid ' + old.pid);
                }
            }
        }
    }
    const workerHolder = side + ':' + epoch;
    const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], '');
    let at = 0, deadline = 0, lost = false;
    const publish = (runGit: FleetGit) => {
        const proposed = now();
        const proposedDeadline = performance.now() + FLEET_LEASE_TTL_MS - DRAIN_MS;
        const record: RemoteLease = { side, host, holder, epoch, pid, at: proposed };
        const next = appendFleetGitRecord(runGit, ref, head, tree, JSON.stringify(record));
        writeFence(root, workerHolder, proposed + FLEET_LEASE_TTL_MS - DRAIN_MS);
        head = next;
        at = proposed;
        deadline = proposedDeadline;
    };
    publish(git);
    const allows = () => !lost && performance.now() < deadline && now() < at + FLEET_LEASE_TTL_MS - DRAIN_MS
        && fleetLeaseAllowsWorker(root, workerHolder, now());
    return {
        holder: workerHolder,
        allows,
        renew() {
            try {
                if (!allows()) throw Error('fleet controller lease expired');
                publish(fleetGitWindow(root));
            } catch (error) {
                lost = true;
                // A failed invalidation leaves the previous conservative deadline in place.
                try { writeFence(root, workerHolder, 0); } catch { /* expiry remains the fence */ }
                throw error;
            }
        },
    };
}
