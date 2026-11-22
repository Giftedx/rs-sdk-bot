import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workspaceRoot } from '../../../core/src/build-workspace-root';
import { writeLiveUpdate, type LiveUpdateMark } from '../../../core/src/live-reload';
import { hasStopFile } from '../../../core/src/practice-paths';
import { applyUpdate } from './adopt';
import { gitHash, gitIn, importClosure, mergedDeliveryCopies, mergeText, readCheckout, readRebased, rebasableDeliveryEdits, REBASED_FILE } from './inspect';
import { coordinatorHolds, LIVE_SERVER, liveRuns, planUpdate, releaseClosure, type LiveRunsOptions } from './plan';
import { few } from './inspect';
import { patchCollisions, resetVendor, SDK, SDK_PATCH, vendorExact, vendorReleaseFiles, vendorState } from './vendor';

export const DAEMONS: Record<string, string[]> = {
    swarm: ['scripts/swarm.ts'],
    'fleet-agent': ['scripts/fleet-agent.ts'],
    dashboard: ['packages/dashboard/server.ts'],
    'dashboard-publish': ['packages/dashboard/publish.ts'],
};

// The daemons whose import closure holds a changed file.
export function reloadsFor(incoming: readonly string[], closures: Readonly<Record<string, readonly string[]>>): string[] {
    const changed = new Set(incoming);
    return Object.keys(closures).filter(name => closures[name]!.some(f => changed.has(f))).sort();
}

export async function runLiveUpdateCli(
    root = resolve(import.meta.dir, '../../../..'),
    argv: readonly string[] = process.argv,
    env: Record<string, string | undefined> = process.env,
    log: (line: string) => void = console.log,
): Promise<number> {
    const dry = argv.includes('--dry'), target = 'origin/master';
    const finish = (line: string, code = 0): number => { log(line); return code; };
    if (env.LIVE_UPDATE === '0') return finish('RESULT ok live-update off (LIVE_UPDATE=0)');
    if (hasStopFile('live-update', root)) return finish('RESULT ok live-update paused by stop file');
    const git = gitIn(root);
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (!branch.ok || branch.out !== 'master') return finish(`RESULT ok live-update none: checkout is on ${branch.ok ? branch.out : 'no branch'}`);
    const fetch = git('fetch', '--quiet', '--no-tags', 'origin', 'master');
    if (!fetch.ok) return finish(`RESULT fail live-update fetch: ${fetch.out.slice(0, 200)}`, 1);
    try {
        const read = readCheckout(git, root, target);
        const mergedCache = join(root, '.practice', 'live-update-merged.json');
        let cache: Record<string, true> = {};
        try { cache = JSON.parse(readFileSync(mergedCache, 'utf8')); } catch { /* none yet */ }
        const merged = (url: string) => {
            if (cache[url]) return true;
            const p = Bun.spawnSync(['gh', 'pr', 'view', url, '--json', 'state', '--jq', '.state'], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
            const yes = p.exitCode === 0 && p.stdout.toString().trim() === 'MERGED';
            if (yes) { cache[url] = true; try { writeFileSync(mergedCache, JSON.stringify(cache)); } catch { /* the cache is a speed-up only */ } }
            return yes;
        };
        const copies = read.behind ? mergedDeliveryCopies(root, read.dirty.filter(d => read.incoming.includes(d.path)), merged) : new Set<string>();
        const marked = read.dirty.map(d => copies.has(d.path) ? { ...d, mergedDelivery: true } : d);
        const show = (rev: string) => (path: string) => { const p = Bun.spawnSync(['git', 'show', `${rev}:${path}`], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true }); return p.exitCode === 0 ? p.stdout.toString() : null; };
        const rebases = read.behind ? rebasableDeliveryEdits(root, marked, read.incoming,
            { head: show('HEAD'), target: show(target), local: path => { try { return readFileSync(join(root, path), 'utf8'); } catch { return null; } } }, mergeText) : new Map();
        const checkout = { ...read, dirty: marked.map(d => rebases.has(d.path) ? { ...d, rebase: rebases.get(d.path)!.text } : d) };
        const holds = () => coordinatorHolds(root, c => workspaceRoot(root, c));
        const patchMoves = checkout.incoming.includes(SDK_PATCH);
        const sdk = patchMoves ? vendorExact(root) : null;
        const oldPatch = sdk === 'applied' ? readFileSync(join(root, SDK_PATCH), 'utf8') : '';
        const shown = sdk === 'applied' || sdk === 'clean' ? git('show', `${target}:${SDK_PATCH}`) : null, nextPatch = shown?.ok ? shown.out + '\n' : '';
        const inTheWay = shown ? patchCollisions(root, oldPatch, nextPatch) : [];
        const resets = shown !== null && !inTheWay.length;
        const vendorRelease = resets ? vendorReleaseFiles(oldPatch, nextPatch) : [];
        const liveOpts: LiveRunsOptions | undefined = env.FLEET_DIR ? { fleetDir: resolve(env.FLEET_DIR) } : undefined;
        const runs = () => liveRuns(root, LIVE_SERVER, releaseClosure(root), Date.now(), liveOpts);
        const plan = planUpdate({ ...checkout, vendorRelease, ...(checkout.behind ? { ...holds(), liveRuns: runs() } : { holds: [], heldFiles: [] }) });
        if (plan.action === 'none' && plan.reason === 'current') {
            const state = vendorState(root), held = holds();
            if (state === 'clean' && !dry && !held.holds.length && !held.qualifications.length) {
                const live = vendorReleaseFiles('', readFileSync(join(root, SDK_PATCH), 'utf8')).length ? runs() : [];
                if (live.length) return finish(`RESULT ok live-update vendor: the SDK patch waits for the live run of ${live[0]!.name}`);
                const apply = gitIn(join(root, SDK))('apply', join(root, SDK_PATCH));
                return finish(apply.ok ? `RESULT ok live-update vendor: applied the SDK patch to ${SDK}` : `RESULT fail live-update vendor: ${apply.out.slice(0, 200)}`, apply.ok ? 0 : 1);
            }
            if (state === 'other') return finish(`RESULT ok live-update vendor: ${SDK} does not hold the SDK patch of this commit; bun tools/worktree-setup.ts --reset-vendor restores it`);
        }
        if (plan.action !== 'update') return finish(`RESULT ok live-update ${plan.action}: ${plan.reason}${plan.action === 'wait' ? ` (behind ${checkout.behind})` : ''}`);
        if (dry) return finish(`RESULT ok live-update dry: would move ${checkout.behind} commits, ${checkout.incoming.length} files, adopt ${plan.adopt.length}${patchMoves ? (resets ? `, apply the SDK patch to ${SDK}` : `, keep ${SDK} as it is`) : ''}`);
        const from = git('rev-parse', '--short', 'HEAD').out;
        const before = Object.fromEntries(Object.entries(DAEMONS).map(([name, starts]) => [name, importClosure(starts, root)]));
        const applied = applyUpdate(git, root, target, plan.adopt);
        if (!applied.ok) return finish(`RESULT fail live-update ${applied.detail}`, 1);
        const rebased = plan.adopt.filter(d => d.rebase !== undefined);
        if (rebased.length) {
            const marks = readRebased(root);
            for (const d of rebased) {
                writeFileSync(join(root, d.path), d.rebase!);
                const h = gitHash(join(root, d.path));
                if (h) marks[d.path] = { hash: h, taskId: rebases.get(d.path)!.taskId };
            }
            try { writeFileSync(join(root, REBASED_FILE), JSON.stringify(marks, null, 1)); } catch { /* the next update then waits on these files */ }
        }
        const closures = Object.fromEntries(Object.entries(DAEMONS).map(([name, starts]) => [name, [...before[name]!, ...importClosure(starts, root)]]));
        const reload = reloadsFor(checkout.incoming, closures), to = git('rev-parse', '--short', 'HEAD').out;
        const mark: LiveUpdateMark = { at: Date.now(), from, to, files: checkout.incoming.length, reload };
        writeLiveUpdate(root, mark);
        const vendor = !patchMoves || sdk === null ? null : resets ? resetVendor(root, oldPatch)
            : { ok: true, detail: inTheWay.length ? `kept: ${few(inTheWay)} in ${SDK} is in the way of the new SDK patch` : `kept: ${SDK} has edits that are not the SDK patch` };
        const note = !vendor ? '' : !vendor.ok ? ` vendor=FAILED ${vendor.detail}` : ` vendor=${vendor.detail || 'patched'}`;
        return finish(`RESULT ${vendor && !vendor.ok ? 'fail' : 'ok'} live-update moved ${from}..${to} files=${checkout.incoming.length} adopted=${plan.adopt.length} reload=${reload.join(',') || 'none'}${note}`, vendor && !vendor.ok ? 1 : 0);
    } catch (error) { return finish(`RESULT fail live-update ${String(error).slice(0, 300)}`, 1); }
}
