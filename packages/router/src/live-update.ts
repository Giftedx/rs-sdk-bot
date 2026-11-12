// Live update: fast-forwards this checkout to origin/master and tells the daemons whose code changed to reload.
// scripts/fleet-agent.ts runs it before each sync, so a fix merged to master reaches the live fleet in one agent cycle.
//
// It moves the checkout only when all of these hold:
//   - the checkout is on master and has no commit that origin/master lacks;
//   - no qualification runs, no build waits to publish and no build lock is held (a source change fails those);
//   - no running coordinator build owns a file that the update changes (its publish would refuse);
//   - no live coordinator run loads a file that the update changes. Such a run keeps the release it started on, and
//     every new coordinator run then refuses to start until it ends (assertCompatibleWorkers, worker-release.ts);
//   - no dependency manifest changes (that needs `bun install` by a person);
//   - each changed file that is edited or untracked here already holds the bytes of origin/master. A coordinator build
//     publishes its files here before its pull request merges, so that state is usual. Such a file is adopted.
// Any other local edit to a changed file stops the update, and the RESULT line names the file.
//
// The SDK patch (patches/rs-sdk-working.patch) is applied to vendor/rs-sdk, and git does not move those files. When an
// update changes the patch, this script takes the old patch off vendor/rs-sdk after the move and applies the new
// patch. It touches only the files of the old patch. It does that only when vendor/rs-sdk held exactly the old patch, or no patch, and no local file is where the
// new patch creates one. Other edits and such a file stay, and the RESULT line says so. A patch change that alters a
// file of the worker release (runtimeTrees in worker-release.ts) waits while a live coordinator run goes, as a change
// to any other release file does.
// On a checkout that is current, an unpatched vendor/rs-sdk gets the patch, with the same waits, and a vendor/rs-sdk
// with other edits gets a RESULT line that names it.
//
// After the move it writes .practice/live-update.json (packages/core/src/live-reload.ts). The fleet agent and the
// autopilot restart themselves from it. The coordinator gets its reload request (`coordinator-cli.ts --restart`,
// which keeps its children). The coordinator restarts the swarm itself when the swarm's files change (ensureSwarm).
// This file is tooling: runtime code starts it as a process and never imports it (packages/core/src/worker-release.ts).
//
// Usage: bun packages/router/src/live-update.ts [--dry]   Env: LIVE_UPDATE=0 turns it off. .practice/stop-live-update pauses it.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { liveUpdateFile, type LiveUpdateMark } from '../../core/src/live-reload';
import { releaseEntries, runtimeTrees, standingAccounts, standingPeer } from '../../core/src/worker-release';
import { patchNewFiles, patchState, type PatchState } from '../../../scripts/worktree-setup';

export type Dirty = { path: string; sameAsTarget: boolean; untracked: boolean };
// `vendorRelease`: the worker release files that the update changes through the SDK patch (vendorReleaseFiles).
export type UpdateInput = { branch: string; ahead: number; behind: number; incoming: readonly string[]; dirty: readonly Dirty[]; holds: readonly string[]; heldFiles: readonly string[]; liveRuns?: readonly LiveRun[]; vendorRelease?: readonly string[] };
export type LiveRun = { name: string; files: readonly string[] };
export type UpdatePlan = { action: 'none' | 'wait'; reason: string } | { action: 'update'; adopt: Dirty[] };

const MANIFEST = /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml|tsconfig\.json)$/;
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
    for (const run of i.liveRuns ?? []) {
        const loaded = run.files.filter(f => incoming.has(f));
        if (loaded.length) return { action: 'wait', reason: `the live run of ${run.name} loads ${few(loaded)}` };
    }
    // Each worker runs on the SDK release trees, so each live run loads them.
    if (i.vendorRelease?.length && i.liveRuns?.length) return { action: 'wait', reason: `the live run of ${i.liveRuns[0]!.name} loads ${few(i.vendorRelease)} (changed by the SDK patch)` };
    const touched = i.dirty.filter(d => incoming.has(d.path));
    const differs = touched.filter(d => !d.sameAsTarget).map(d => d.path);
    if (differs.length) return { action: 'wait', reason: `local edit differs from master: ${few(differs)}` };
    return { action: 'update', adopt: touched };
}

export const SDK = 'vendor/rs-sdk', SDK_PATCH = 'patches/rs-sdk-working.patch';
// The part of a patch for each file that it changes, by the file's path in the SDK.
export function patchSections(text: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of text.replace(/\r\n/g, '\n').trimEnd().split(/^(?=diff --git )/m)) {
        const m = /^diff --git a\/(\S+) b\//.exec(part);
        if (m) out.set(m[1]!, part.trimEnd());
    }
    return out;
}
// The SDK files whose part differs between two versions of the patch: changed, added to the patch or left out of it.
export function patchChangedFiles(before: string, after: string): string[] {
    const a = patchSections(before), b = patchSections(after);
    return [...new Set([...a.keys(), ...b.keys()])].filter(file => a.get(file) !== b.get(file)).sort();
}
// Those of them that are in a worker release tree, as paths in this repository.
export function vendorReleaseFiles(before: string, after: string, trees: readonly string[] = runtimeTrees): string[] {
    return patchChangedFiles(before, after).map(file => `${SDK}/${file}`).filter(path => trees.some(tree => path.startsWith(tree + '/')));
}
// What vendor/rs-sdk holds against the patch file of this checkout: `applied`, `clean` (no patch) or `other` (edits
// that are not this patch). Null on a checkout without the SDK or without the patch file.
export function vendorState(root: string): PatchState | null {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH);
    if (!existsSync(join(vendor, 'package.json')) || !existsSync(patch)) return null;
    const git = gitIn(vendor);
    return patchState(git('apply', '--check', '-R', patch).ok, git('apply', '--check', patch).ok);
}
// The exact form of vendorState, for a restore: `applied` or `clean` only when the tracked files of vendor/rs-sdk, and
// the files that the patch creates, are the pinned commit with this patch or with no patch, and nothing else.
// `git apply --check -R` passes also when a different tracked file has an edit, and a restore would discard that edit.
// It writes each state as a git tree through an index file of its own, so the index of vendor/rs-sdk does not change.
export function vendorExact(root: string): PatchState | null {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH);
    if (!existsSync(join(vendor, 'package.json'))) return null;
    const text = existsSync(patch) ? readFileSync(patch, 'utf8') : '', dir = mkdtempSync(join(tmpdir(), 'live-update-index-'));
    try {
        const tree = (index: string, steps: string[][]): string | null => {
            const run = (...args: string[]) => { const p = Bun.spawnSync(['git', '-c', 'core.quotepath=off', ...args], { cwd: vendor, env: { ...process.env, GIT_INDEX_FILE: join(dir, index) }, windowsHide: true, stdout: 'pipe', stderr: 'pipe' }); return { ok: p.exitCode === 0, out: p.stdout.toString().trim() }; };
            for (const step of [['read-tree', 'HEAD'], ...steps]) if (!run(...step).ok) return null;
            const written = run('write-tree');
            return written.ok ? written.out : null;
        };
        const created = patchNewFiles(text).filter(file => existsSync(join(vendor, file)));
        const actual = tree('actual', [['add', '-u'], ...(created.length ? [['add', '-f', '--', ...created]] : [])]);
        if (!actual) return 'other';
        if (text && actual === tree('patched', [['apply', '--cached', patch]])) return 'applied';
        return actual === tree('pinned', []) ? 'clean' : 'other';
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
// The files that `newPatch` creates and `oldPatch` does not, and that are in vendor/rs-sdk now. Each one is a local
// file that the SDK does not track. The new patch cannot go on without the loss of it, so the folder stays.
export function patchCollisions(root: string, oldPatch: string, newPatch: string): string[] {
    const had = new Set(patchNewFiles(oldPatch));
    return patchNewFiles(newPatch).filter(file => !had.has(file) && existsSync(join(root, SDK, file)));
}
// Puts the patch file of this checkout on vendor/rs-sdk: takes `oldPatch` off and applies the patch.
// It touches only the files of `oldPatch`: it restores each file that the old patch changed, and removes each file
// that the old patch created. No other file changes, so a local file that is staged in vendor/rs-sdk stays.
// Call it only when vendorExact gave `applied` for `oldPatch`, or `clean`: the restore discards an edit in those files.
// It removes no file that only the new patch creates. Such a file makes the apply fail, and the file stays.
export function resetVendor(root: string, oldPatch: string): { ok: boolean; detail: string } {
    const vendor = join(root, SDK), patch = join(root, SDK_PATCH), git = gitIn(vendor);
    const created = new Set(patchNewFiles(oldPatch)), changed = [...patchSections(oldPatch).keys()].filter(file => !created.has(file));
    // From the pinned commit, not from the index: a patch that is staged in vendor/rs-sdk would come back from the
    // index. The index itself does not change.
    const restore = changed.length ? git('restore', '--source=HEAD', '--worktree', '--', ...changed) : { ok: true, out: '' };
    if (!restore.ok) return { ok: false, detail: `restore of ${SDK}: ${restore.out.slice(0, 160)}` };
    const newPatch = existsSync(patch) ? readFileSync(patch, 'utf8') : '';
    for (const file of created) rmSync(join(vendor, file), { force: true });
    if (!newPatch) return { ok: true, detail: '' };
    const apply = git('apply', patch);
    return apply.ok ? { ok: true, detail: '' } : { ok: false, detail: `apply of ${SDK_PATCH}: ${apply.out.slice(0, 160)}` };
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

// The unfinished live sessions that are not standing jobs, each with the files its entry loads. A standing job is
// exempt from release equality, so an update never holds for it.
export function liveRuns(root: string, server: string, closure: (entries: string[]) => string[], now = Date.now()): LiveRun[] {
    const dir = join(root, '.practice', 'status'), owners = standingAccounts(root), runs: LiveRun[] = [];
    if (!existsSync(dir)) return runs;
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        let row: any; try { row = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
        if (row?.server !== server || row.result || !Number.isFinite(row.at) || now - row.at >= LIVE_ROW_MS || standingPeer(row, owners)) continue;
        runs.push({ name: String(row.name), files: closure(releaseEntries(row.workEntry)) });
    }
    return runs;
}
// A live session rewrites its status every few seconds, and the server drops a lost session after 200 s.
export const LIVE_ROW_MS = 200_000, LIVE_SERVER = 'rs-sdk-demo.fly.dev';

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
        const holds = () => coordinatorHolds(root, c => workspaceRoot(root, c));
        // An update that changes the SDK patch: what vendor/rs-sdk holds before the move, and the worker release files
        // that the new patch changes. Only an exact `applied` or `clean` folder gets the new patch.
        const patchMoves = checkout.incoming.includes(SDK_PATCH);
        const sdk = patchMoves ? vendorExact(root) : null;
        const oldPatch = sdk === 'applied' ? readFileSync(join(root, SDK_PATCH), 'utf8') : '';
        const shown = sdk === 'applied' || sdk === 'clean' ? git('show', `${target}:${SDK_PATCH}`) : null, nextPatch = shown?.ok ? shown.out + '\n' : '';
        // A local file where the new patch creates one: the folder stays, and that file with it.
        const inTheWay = shown ? patchCollisions(root, oldPatch, nextPatch) : [];
        const resets = shown !== null && !inTheWay.length;
        const vendorRelease = resets ? vendorReleaseFiles(oldPatch, nextPatch) : [];
        const runs = () => liveRuns(root, LIVE_SERVER, entries => importClosure(entries, root));
        const plan = planUpdate({ ...checkout, vendorRelease, ...(checkout.behind ? { ...holds(), liveRuns: runs() } : { holds: [], heldFiles: [] }) });
        if (plan.action === 'none' && plan.reason === 'current') {
            // A current checkout. An SDK folder with no patch gets it: an apply discards nothing. It waits for the
            // same things as a move: a coordinator hold, and a live run when the patch changes a worker release file.
            // A folder with other edits is named and stays as it is.
            const state = vendorState(root);
            if (state === 'clean' && !dry && !holds().holds.length) {
                const live = vendorReleaseFiles('', readFileSync(join(root, SDK_PATCH), 'utf8')).length ? runs() : [];
                if (live.length) done(`RESULT ok live-update vendor: the SDK patch waits for the live run of ${live[0]!.name}`);
                const apply = gitIn(join(root, SDK))('apply', join(root, SDK_PATCH));
                done(apply.ok ? `RESULT ok live-update vendor: applied the SDK patch to ${SDK}` : `RESULT fail live-update vendor: ${apply.out.slice(0, 200)}`, apply.ok ? 0 : 1);
            }
            if (state === 'other') done(`RESULT ok live-update vendor: ${SDK} does not hold the SDK patch of this commit; bun scripts/worktree-setup.ts --reset-vendor restores it`);
        }
        if (plan.action !== 'update') done(`RESULT ok live-update ${plan.action}: ${plan.reason}${plan.action === 'wait' ? ` (behind ${checkout.behind})` : ''}`);
        else {
            if (dry) done(`RESULT ok live-update dry: would move ${checkout.behind} commits, ${checkout.incoming.length} files, adopt ${plan.adopt.length}${patchMoves ? (resets ? `, apply the SDK patch to ${SDK}` : `, keep ${SDK} as it is`) : ''}`);
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
            // The move changed the patch file. vendor/rs-sdk gets it now, unless it held edits that are not the old patch.
            const vendor = !patchMoves || sdk === null ? null : resets ? resetVendor(root, oldPatch)
                : { ok: true, detail: inTheWay.length ? `kept: ${few(inTheWay)} in ${SDK} is in the way of the new SDK patch` : `kept: ${SDK} has edits that are not the SDK patch` };
            const note = !vendor ? '' : !vendor.ok ? ` vendor=FAILED ${vendor.detail}` : ` vendor=${vendor.detail || 'patched'}`;
            done(`RESULT ${vendor && !vendor.ok ? 'fail' : 'ok'} live-update moved ${from}..${to} files=${checkout.incoming.length} adopted=${plan.adopt.length} reload=${reload.join(',') || 'none'}${note}`, vendor && !vendor.ok ? 1 : 0);
        }
    } catch (error) { done(`RESULT fail live-update ${String(error).slice(0, 300)}`, 1); }
}
