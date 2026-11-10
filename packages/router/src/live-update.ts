// Live update: fast-forwards this checkout to origin/master and tells the daemons whose code changed to reload.
// scripts/fleet-agent.ts runs it before each sync, so a fix merged to master reaches the live fleet in one agent cycle.
//
// It moves the checkout only when all of these hold:
//   - the checkout is on master and has no commit that origin/master lacks;
//   - no qualification runs, no build waits to publish and no build lock is held (a source change fails those);
//   - no running coordinator build owns a file that the update changes (its publish would refuse);
//   - no dependency manifest changes (that needs `bun install` by a person);
//   - each changed file that is edited or untracked here already holds the bytes of origin/master. A coordinator build
//     publishes its files here before its pull request merges, so that state is usual. Such a file is adopted.
// Any other local edit to a changed file stops the update, and the RESULT line names the file.
//
// After the move it writes .practice/live-update.json (packages/core/src/live-reload.ts). The fleet agent and the
// autopilot restart themselves from it. The coordinator gets its reload request (`coordinator-cli.ts --restart`,
// which keeps its children). The coordinator restarts the swarm itself when the swarm's files change (ensureSwarm).
// This file is tooling: runtime code starts it as a process and never imports it (packages/core/src/worker-release.ts).
//
// Usage: bun packages/router/src/live-update.ts [--dry]   Env: LIVE_UPDATE=0 turns it off. .practice/stop-live-update pauses it.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveUpdateFile, type LiveUpdateMark } from '../../core/src/live-reload';

export type Dirty = { path: string; sameAsTarget: boolean; untracked: boolean };
export type UpdateInput = { branch: string; ahead: number; behind: number; incoming: readonly string[]; dirty: readonly Dirty[]; holds: readonly string[]; heldFiles: readonly string[] };
export type UpdatePlan = { action: 'none' | 'wait'; reason: string } | { action: 'update'; adopt: Dirty[] };

const MANIFEST = /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml)$/;
const few = (files: readonly string[]) => files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');

export function planUpdate(i: UpdateInput): UpdatePlan {
    if (i.branch !== 'master') return { action: 'none', reason: `checkout is on ${i.branch}` };
    if (!i.behind) return { action: 'none', reason: 'current' };
    if (i.ahead) return { action: 'wait', reason: `${i.ahead} local commits are not on origin/master` };
    if (i.holds.length) return { action: 'wait', reason: i.holds[0]! };
    const incoming = new Set(i.incoming);
    const manifests = i.incoming.filter(f => MANIFEST.test(f));
    if (manifests.length) return { action: 'wait', reason: `dependency change needs bun install: ${few(manifests)}` };
    const owned = i.heldFiles.filter(f => incoming.has(f));
    if (owned.length) return { action: 'wait', reason: `a running build owns ${few(owned)}` };
    const touched = i.dirty.filter(d => incoming.has(d.path));
    const differs = touched.filter(d => !d.sameAsTarget).map(d => d.path);
    if (differs.length) return { action: 'wait', reason: `local edit differs from master: ${few(differs)}` };
    return { action: 'update', adopt: touched };
}

// `git status --porcelain -z`: "XY path" records split by NUL; a rename or copy record is followed by its source path.
export function parseStatus(out: string): { path: string; untracked: boolean }[] {
    const rows: { path: string; untracked: boolean }[] = [], parts = out.split('\0');
    for (let n = 0; n < parts.length; n++) {
        const part = parts[n]!;
        if (part.length < 4) continue;
        const code = part.slice(0, 2);
        rows.push({ path: part.slice(3), untracked: code === '??' });
        if (/[RC]/.test(code)) { const source = parts[++n]; if (source) rows.push({ path: source, untracked: false }); }
    }
    return rows;
}

// The daemons whose import closure holds a changed file.
export function reloadsFor(incoming: readonly string[], closures: Readonly<Record<string, readonly string[]>>): string[] {
    const changed = new Set(incoming);
    return Object.keys(closures).filter(name => closures[name]!.some(f => changed.has(f))).sort();
}

type Git = (...args: string[]) => { ok: boolean; out: string };
export const gitIn = (root: string): Git => (...args) => {
    const p = Bun.spawnSync(['git', '-c', 'core.quotepath=off', ...args], { cwd: root, windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    return { ok: p.exitCode === 0, out: (p.stdout.toString() + (p.exitCode === 0 ? '' : p.stderr.toString())).trimEnd() };
};

export function readCheckout(git: Git, root: string, target: string): Omit<UpdateInput, 'holds' | 'heldFiles'> {
    const need = (r: { ok: boolean; out: string }, what: string) => { if (!r.ok) throw Error(`${what}: ${r.out.slice(0, 200)}`); return r.out; };
    const branch = need(git('rev-parse', '--abbrev-ref', 'HEAD'), 'branch');
    const ahead = Number(need(git('rev-list', '--count', `${target}..HEAD`), 'ahead')), behind = Number(need(git('rev-list', '--count', `HEAD..${target}`), 'behind'));
    const incoming = behind ? need(git('diff', '--name-only', '-z', 'HEAD', target), 'diff').split('\0').filter(Boolean) : [];
    const changed = new Set(incoming);
    const dirty = !behind ? [] : parseStatus(need(git('status', '--porcelain', '-z', '--untracked-files=all'), 'status')).filter(r => changed.has(r.path)).map(r => {
        const want = git('rev-parse', '--verify', '--quiet', `${target}:${r.path}`), here = existsSync(join(root, r.path));
        const sameAsTarget = here ? want.ok && git('hash-object', '--', r.path).out === want.out : !want.ok;
        return { ...r, sameAsTarget };
    });
    return { branch, ahead, behind, incoming, dirty };
}

// Adopts the files that already hold master's bytes, then fast-forwards. A refused merge leaves every file's bytes as
// they were: an untracked file removed for the merge is written back from the target.
export function applyUpdate(git: Git, root: string, target: string, adopt: readonly Dirty[]): { ok: boolean; detail: string } {
    const removed: string[] = [];
    for (const d of adopt) {
        if (!d.untracked) { const r = git('checkout', target, '--', d.path); if (!r.ok && existsSync(join(root, d.path))) return { ok: false, detail: `adopt ${d.path}: ${r.out.slice(0, 160)}` }; }
        else if (existsSync(join(root, d.path))) { rmSync(join(root, d.path)); removed.push(d.path); }
    }
    const merge = git('merge', '--ff-only', '--quiet', target);
    if (merge.ok) return { ok: true, detail: '' };
    for (const path of removed) git('checkout', target, '--', path);
    return { ok: false, detail: `merge refused: ${merge.out.slice(0, 200)}` };
}

// The files a build workspace owns: the keys of `base` in its .workspace.json (packages/router/src/build-workspace.ts).
const ownedFiles = (workspace: string): string[] => {
    try { return Object.keys(JSON.parse(readFileSync(join(workspace, '.workspace.json'), 'utf8')).base ?? {}); } catch { return []; }
};

// What the coordinator holds now: a source change fails a running qualification and a pending publish, and a running
// build refuses to publish over a file that changed under it.
export function coordinatorHolds(root: string, workspace: (capability: string) => string): { holds: string[]; heldFiles: string[] } {
    const dir = join(root, '.practice', 'coordinator'), holds: string[] = [], heldFiles: string[] = [];
    if (existsSync(join(dir, 'build-lock.json'))) holds.push('the runtime build lock is held');
    if (existsSync(join(dir, 'publish-request.json'))) holds.push('a build waits to publish');
    const file = join(dir, 'state.json');
    if (existsSync(file)) {
        let tasks: any[];
        try { tasks = JSON.parse(readFileSync(file, 'utf8')).tasks ?? []; } catch { return { holds: [...holds, 'coordinator state is not readable'], heldFiles }; }
        for (const t of tasks) {
            if (t?.status !== 'running') continue;
            if (t.spec?.kind === 'qualify') holds.push(`qualification ${t.spec.id} runs`);
            if (t.spec?.kind === 'build' && typeof t.spec.capability === 'string') heldFiles.push(...ownedFiles(workspace(t.spec.capability)));
        }
    }
    return { holds, heldFiles };
}

const DAEMONS: Record<string, string[]> = {
    coordinator: ['packages/router/src/coordinator-cli.ts'],
    autopilot: ['scripts/autopilot.ts'],
    'fleet-agent': ['scripts/fleet-agent.ts'],
};

if (import.meta.main) {
    const root = resolve(import.meta.dir, '../../..'), dry = process.argv.includes('--dry'), target = 'origin/master';
    const done = (line: string, code = 0): never => { console.log(line); process.exit(code); };
    if (process.env.LIVE_UPDATE === '0') done('RESULT ok live-update off (LIVE_UPDATE=0)');
    if (existsSync(join(root, '.practice', 'stop-live-update'))) done('RESULT ok live-update paused by stop file');
    const git = gitIn(root);
    // A side that works on a branch never moves: skip the fetch too.
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (!branch.ok || branch.out !== 'master') done(`RESULT ok live-update none: checkout is on ${branch.ok ? branch.out : 'no branch'}`);
    const fetch = git('fetch', '--quiet', '--no-tags', 'origin', 'master');
    if (!fetch.ok) done(`RESULT fail live-update fetch: ${fetch.out.slice(0, 200)}`, 1);
    try {
        const { workspaceRoot } = await import('./build-workspace');
        const { importClosure } = await import('./delivery-cli');
        const checkout = readCheckout(git, root, target);
        const plan = planUpdate({ ...checkout, ...(checkout.behind ? coordinatorHolds(root, c => workspaceRoot(root, c)) : { holds: [], heldFiles: [] }) });
        if (plan.action !== 'update') done(`RESULT ok live-update ${plan.action}: ${plan.reason}${plan.action === 'wait' ? ` (behind ${checkout.behind})` : ''}`);
        else {
            if (dry) done(`RESULT ok live-update dry: would move ${checkout.behind} commits, ${checkout.incoming.length} files, adopt ${plan.adopt.length}`);
            const from = git('rev-parse', '--short', 'HEAD').out;
            // The closures before the move hold the files that the update deletes.
            const before = Object.fromEntries(Object.entries(DAEMONS).map(([name, starts]) => [name, importClosure(starts, root)]));
            const applied = applyUpdate(git, root, target, plan.adopt);
            if (!applied.ok) done(`RESULT fail live-update ${applied.detail}`, 1);
            const closures = Object.fromEntries(Object.entries(DAEMONS).map(([name, starts]) => [name, [...before[name]!, ...importClosure(starts, root)]]));
            const reload = reloadsFor(checkout.incoming, closures), to = git('rev-parse', '--short', 'HEAD').out;
            const mark: LiveUpdateMark = { at: Date.now(), from, to, files: checkout.incoming.length, reload };
            writeFileSync(liveUpdateFile(root), JSON.stringify(mark));
            if (reload.includes('coordinator')) {
                let pid = 0; try { pid = JSON.parse(readFileSync(join(root, '.practice', 'coordinator', 'owner.json'), 'utf8')).pid; } catch { /* no coordinator ran here */ }
                let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch { /* gone: the watchdog starts current code */ }
                if (alive) Bun.spawnSync([process.execPath, 'packages/router/src/coordinator-cli.ts', '--restart'], { cwd: root, windowsHide: true, stdout: 'ignore', stderr: 'ignore' });
            }
            done(`RESULT ok live-update moved ${from}..${to} files=${checkout.incoming.length} adopted=${plan.adopt.length} reload=${reload.join(',') || 'none'}`);
        }
    } catch (error) { done(`RESULT fail live-update ${String(error).slice(0, 300)}`, 1); }
}
