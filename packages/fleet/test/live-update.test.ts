import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    DAEMONS,
    LIVE_UPDATE_GIT_TIMEOUT_MS,
    SDK,
    SDK_PATCH,
    addedPreloads,
    applyUpdate,
    gitIn,
    patchChangedFiles,
    patchCollisions,
    patchSections,
    LIVE_SERVER,
    PENDING_MAX_AGE_MS,
    clearPendingUpdate,
    drainedFiles,
    liveRuns,
    pendingUpdateFile,
    pendingUpdateReader,
    planUpdate,
    preloadOnlyChange,
    readCheckout,
    readPendingUpdate,
    reloadsFor,
    writePendingUpdate,
    type UpdateInput,
} from '../src/live-update';
import { daemonFiles, runLiveUpdateCli } from '../src/live-update/reload';
import { renewedPendingUpdate, workerDrain } from '../src/live-update/pending';
import { AGENT_SUBPROCESS_TIMEOUT_MS, tradeDrainHold } from '../src/fleet-agent';
import { statusReadDirs } from '../../core/src/practice-paths';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'fleet-live-update-'));
    dirs.push(d);
    return d;
};
afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const baseInput: UpdateInput = {
    branch: 'master',
    behind: 1,
    ahead: 0,
    incoming: ['packages/fleet/src/watchdog.ts'],
    dirty: [],
    holds: [],
    heldFiles: [],
    qualifications: [],
    liveRuns: [],
    bunfigPreloadOnly: false,
};

describe('fleet live-update facade', () => {
    test('a wait on live runs that load incoming files asks for a drain; other waits do not', () => {
        const smithing = 'packages/workers/src/bank-artisan/smithing.ts';
        const loads = planUpdate({ ...baseInput, incoming: [smithing, 'docs/x.md'], liveRuns: [{ name: 'Ballspinner', files: [smithing, 'scripts/aio-skiller.ts'] }] });
        expect(loads).toMatchObject({ action: 'wait', drain: [smithing, 'docs/x.md'] });
        expect((loads as { reason: string }).reason).toContain('the live run of Ballspinner loads');
        // A run that loads none of the incoming files does not hold the update.
        expect(planUpdate({ ...baseInput, liveRuns: [{ name: 'Ballspinner', files: [smithing] }] }).action).toBe('update');
        for (const other of [
            planUpdate({ ...baseInput, holds: ['qualification q1 runs'] }),
            planUpdate({ ...baseInput, ahead: 1 }),
            planUpdate({ ...baseInput, liveRuns: [{ name: 'X', files: [], unknown: true }] }),
            planUpdate({ ...baseInput, incoming: ['package.json'] }),
        ]) {
            expect(other.action).toBe('wait');
            expect((other as { drain?: string[] }).drain).toBeUndefined();
        }
    });

    test('the pending-update mark holds only the jobs that load a pending file, and only while it is fresh', () => {
        const root = scratch();
        const smithing = 'packages/workers/src/bank-artisan/smithing.ts';
        const now = Date.now();
        expect(readPendingUpdate(root, now)).toBeNull();
        writePendingUpdate(root, { at: now, target: 'e5d45c5918abc', files: [smithing] });
        expect(existsSync(pendingUpdateFile(root))).toBe(true);
        const mark = readPendingUpdate(root, now);
        expect(mark).toEqual({ at: now, target: 'e5d45c5918abc', files: [smithing] });
        expect(readPendingUpdate(root, now + PENDING_MAX_AGE_MS)).toBeNull();
        const read = pendingUpdateReader(root);
        expect(read(now)?.target).toBe('e5d45c5918abc');
        expect(read(now + PENDING_MAX_AGE_MS)).toBeNull();
        clearPendingUpdate(root);
        expect(read(now)).toBeNull();
        clearPendingUpdate(root);
        writeFileSync(pendingUpdateFile(root), '{"at":"soon","files":7}');
        expect(readPendingUpdate(root, now)).toBeNull();
        const closure = (entries: readonly string[]) => entries.includes('scripts/aio-skiller.ts') ? [smithing, 'scripts/aio-skiller.ts'] : ['scripts/walk-to.ts'];
        expect(drainedFiles(mark, ['scripts/aio-skiller.ts'], root, closure)).toEqual([smithing]);
        expect(drainedFiles(mark, ['scripts/walk-to.ts'], root, closure)).toEqual([]);
        expect(drainedFiles({ ...mark!, files: ['docs/not-code.md'] }, ['scripts/aio-skiller.ts'], root, closure)).toEqual([]);
        expect(drainedFiles(null, ['scripts/aio-skiller.ts'], root, closure)).toEqual([]);
        expect(drainedFiles(mark, [], root, closure)).toEqual([]);
    });

    test('the fleet agent holds a new trade while a live update drains, but never one whose partner has started', () => {
        const order = { id: 'o1', from: 'Fatstack', to: 'Masterbaiter' };
        const drained = ['packages/workers/src/quest/helpers.ts', 'scripts/generated/quest-lib.ts', 'x.ts'];
        const none = new Map<string, string>();
        const held = tradeDrainHold(order, 'Fatstack', drained, '7c5a6bbe9694ec', none, []);
        expect(held).toBe('live update to 7c5a6bbe96 drains packages/workers/src/quest/helpers.ts, scripts/generated/quest-lib.ts and 1 more');
        // Nothing pending to drain: the trade starts.
        expect(tradeDrainHold(order, 'Fatstack', [], 't', none, [])).toBeNull();
        // The other side already runs this order here, or wrote its receipt: this side starts, so no order waits on one side alone.
        expect(tradeDrainHold(order, 'Fatstack', drained, 't', new Map([['masterbaiter', 'o1']]), [])).toBeNull();
        expect(tradeDrainHold(order, 'Masterbaiter', drained, 't', none, [{ id: 'o1', role: 'from' }])).toBeNull();
        // A partner busy with another order has not started this one.
        expect(tradeDrainHold(order, 'Fatstack', drained, 't', new Map([['masterbaiter', 'o9']]), [])).not.toBeNull();
        // A receipt of another order, or of this side's own role, does not count as the partner's start.
        expect(tradeDrainHold(order, 'Masterbaiter', drained, 't', none, [{ id: 'o2', role: 'from' }, { id: 'o1', role: 'to' }])).not.toBeNull();
    });

    test('a trade is held only once the update waits on trades alone', () => {
        const order = { id: 'o1', from: 'Fatstack', to: 'Masterbaiter' }, none = new Map<string, string>();
        const drained = ['packages/workers/src/market/ge-buy.ts'];
        // A skill run still holds the update: holding the trade does not land it sooner, so the trade starts.
        expect(tradeDrainHold(order, 'Fatstack', drained, 't', none, [], ['Ballspinner'])).toBeNull();
        // Only trades hold the update (or the mark is from a writer that does not name them): the trade waits.
        expect(tradeDrainHold(order, 'Fatstack', drained, 't', none, [], [])).not.toBeNull();
        expect(tradeDrainHold(order, 'Fatstack', drained, 't', none, [])).not.toBeNull();
    });

    test('a drain wait names the live runs that hold the update and are not trades', () => {
        const geBuy = 'packages/workers/src/market/ge-buy.ts', incoming = [geBuy, 'docs/x.md'];
        const trade = { name: 'CoinCock', files: [geBuy, 'scripts/aio-logistics.ts'], trade: true as const };
        const skill = { name: 'Ballspinner', files: [geBuy, 'scripts/aio-skiller.ts'] };
        const idle = { name: 'Walker', files: ['scripts/walk-to.ts'] };
        const unread = { name: 'Odd', files: [], unknown: true as const };
        expect(planUpdate({ ...baseInput, incoming, liveRuns: [trade, skill, idle] })).toMatchObject({ action: 'wait', drain: incoming, others: ['Ballspinner'] });
        expect(planUpdate({ ...baseInput, incoming, liveRuns: [trade, idle] })).toMatchObject({ action: 'wait', drain: incoming, others: [] });
        // A run whose files are unknown also holds the update.
        expect(planUpdate({ ...baseInput, incoming, liveRuns: [trade, unread] })).toMatchObject({ action: 'wait', others: ['Odd'] });
    });

    test('liveRuns marks the runs of the trade worker', () => {
        const root = scratch(), now = Date.now(), dir = statusReadDirs(root)[0]!;
        mkdirSync(dir, { recursive: true });
        const row = (name: string, workEntry: string) => writeFileSync(join(dir, `${name}.json`), JSON.stringify({ name, server: LIVE_SERVER, at: now, started: now, workEntry }));
        row('CoinCock', join(root, 'scripts', 'aio-logistics.ts'));
        row('Ballspinner', 'scripts/aio-skiller.ts');
        const runs = liveRuns(root, LIVE_SERVER, entries => [...entries], now, { fleetDir: join(root, 'no-fleet') });
        expect(runs.find(r => r.name === 'CoinCock')).toEqual({ name: 'CoinCock', files: ['scripts/aio-logistics.ts'], trade: true });
        expect(runs.find(r => r.name === 'Ballspinner')).toEqual({ name: 'Ballspinner', files: ['scripts/aio-skiller.ts'] });
    });

    test('the pending mark keeps the names of the runs that are not trades', () => {
        const root = scratch(), now = Date.now();
        writePendingUpdate(root, { at: now, target: 't', files: ['a.ts'], others: ['Ballspinner'] });
        expect(readPendingUpdate(root, now)).toEqual({ at: now, target: 't', files: ['a.ts'], others: ['Ballspinner'] });
        writeFileSync(pendingUpdateFile(root), JSON.stringify({ at: now, target: 't', files: ['a.ts'], others: [7] }));
        expect(readPendingUpdate(root, now)).toEqual({ at: now, target: 't', files: ['a.ts'] });
    });

    test('a renewed pending mark keeps the time its drain began', () => {
        const root = scratch(), t0 = Date.now() - 600_000;
        const first = renewedPendingUpdate(null, { at: t0, target: 'a', files: ['x.ts'] });
        expect(first.since).toBe(t0);
        writePendingUpdate(root, first);
        // A later merge changes the target; the drain goes on, so `since` stays.
        const later = renewedPendingUpdate(readPendingUpdate(root, t0 + 60_000), { at: t0 + 60_000, target: 'b', files: ['x.ts', 'y.ts'] });
        expect(later).toEqual({ at: t0 + 60_000, target: 'b', files: ['x.ts', 'y.ts'], since: t0 });
        // A mark from a writer with no `since` gives its own time; an expired mark starts a new drain.
        expect(renewedPendingUpdate({ at: t0, target: 'a', files: [] }, { at: t0 + 5, target: 'a', files: [] }).since).toBe(t0);
        expect(renewedPendingUpdate(readPendingUpdate(root, t0 + PENDING_MAX_AGE_MS), { at: t0 + PENDING_MAX_AGE_MS, target: 'c', files: [] }).since).toBe(t0 + PENDING_MAX_AGE_MS);
        // A `since` after the renewal time is not a drain start.
        writeFileSync(pendingUpdateFile(root), JSON.stringify({ at: t0, target: 'a', files: [], since: t0 + 1 }));
        expect(readPendingUpdate(root, t0)?.since).toBeUndefined();
    });

    test('a supervised live worker sees the pending files its next run would load', () => {
        const root = scratch(), now = Date.now(), smithing = 'packages/workers/src/bank-artisan/smithing.ts';
        const closure = (entries: readonly string[]) => entries.includes('scripts/aio-skiller.ts') ? [smithing, 'scripts/aio-skiller.ts'] : ['scripts/walk-to.ts'];
        const live = { DEMO_OK: '1', WORKER_ENTRY: 'scripts/aio-skiller.ts' };
        expect(workerDrain(root, live, now, closure)).toEqual([]);
        writePendingUpdate(root, { at: now, target: 't', files: [smithing, 'docs/x.md'] });
        expect(workerDrain(root, live, now, closure)).toEqual([smithing]);
        // An absolute entry (the fleet agent spells its trade worker that way) names the same files.
        expect(workerDrain(root, { ...live, WORKER_ENTRY: join(root, 'scripts', 'aio-skiller.ts') }, now, closure)).toEqual([smithing]);
        expect(workerDrain(root, { ...live, WORKER_ENTRY: 'scripts/walk-to.ts' }, now, closure)).toEqual([]);
        // A standing job is not drained, a run without DEMO_OK is not a live swarm run, and an old mark holds nothing.
        expect(workerDrain(root, { ...live, STANDING: '1' }, now, closure)).toEqual([]);
        expect(workerDrain(root, { WORKER_ENTRY: 'scripts/aio-skiller.ts' }, now, closure)).toEqual([]);
        expect(workerDrain(root, live, now + PENDING_MAX_AGE_MS, closure)).toEqual([]);
        expect(workerDrain(root, { DEMO_OK: '1' }, now, closure)).toEqual([]);
    });

    test('the real release closure names files the way live-update names incoming files', () => {
        // One parse of the artisan skiller's closure (then cached), the same record each swarm start keeps.
        const repo = resolve(import.meta.dir, '../../..'), smithing = 'packages/workers/src/bank-artisan/smithing.ts';
        expect(drainedFiles({ at: Date.now(), target: 't', files: [smithing, 'docs/not-code.md'] }, ['scripts/aio-skiller.ts'], repo)).toEqual([smithing]);
    }, 120_000);

    test('detects preloads, patch sections, collisions, reloads, and fast-forward update plans', () => {
        expect(SDK).toBe('vendor/rs-sdk');
        expect(SDK_PATCH).toBe('patches/rs-sdk-working.patch');
        expect(Object.keys(DAEMONS)).toContain('swarm');
        expect(Object.keys(DAEMONS)).toContain('fleet-agent');

        expect(addedPreloads('[install]\npreload = ["a.ts"]', '[install]\npreload = ["a.ts", "b.ts"]')).toEqual(['b.ts']);
        expect(preloadOnlyChange('preload = ["a.ts"]', 'preload = ["a.ts", "b.ts"]')).toBe(true);

        const diff = [
            'diff --git a/a.ts b/a.ts',
            'index 111..222 100644',
            '--- a/a.ts',
            '+++ b/a.ts',
            '@@ -1 +1 @@',
            '-x',
            '+y',
        ].join('\n');
        expect(patchChangedFiles('', diff)).toEqual(['a.ts']);
        expect(patchSections(diff).size).toBe(1);

        const root = scratch();
        mkdirSync(join(root, SDK), { recursive: true });
        writeFileSync(join(root, SDK, 'new.ts'), '');
        const newFileDiff = [
            'diff --git a/new.ts b/new.ts',
            'new file mode 100644',
            'index 000..111',
            '--- /dev/null',
            '+++ b/new.ts',
            '@@ -0,0 +1 @@',
            '+export {};',
        ].join('\n');
        expect(patchCollisions(root, '', newFileDiff)).toEqual(['new.ts']);

        const closures = {
            'fleet-agent': ['scripts/fleet-agent.ts'],
            swarm: ['scripts/swarm.ts'],
        };
        expect(reloadsFor(['scripts/fleet-agent.ts'], closures)).toEqual(['fleet-agent']);
        expect(reloadsFor(['packages/fleet/src/live-update/reload.ts'], closures)).toEqual([]);
        // The recovery runner is in the launch release that the swarm records as its source, though the swarm does not
        // import it: a change to it reloads the swarm and no other daemon.
        const imports = (starts: readonly string[]) => starts.map(s => s);
        const launch = () => ['scripts/swarm.ts', 'packages/fleet/src/session-recovery.ts', 'knowledge/items.json'];
        const files = Object.fromEntries(['swarm', 'fleet-agent'].map(name => [name, daemonFiles(name, closures[name as keyof typeof closures], '.', imports, launch)]));
        expect(files).toEqual({ swarm: ['scripts/swarm.ts', 'scripts/swarm.ts', 'packages/fleet/src/session-recovery.ts', 'knowledge/items.json'], 'fleet-agent': ['scripts/fleet-agent.ts'] });
        expect(reloadsFor(['packages/fleet/src/session-recovery.ts'], files)).toEqual(['swarm']);
        expect(reloadsFor(['packages/fleet/src/watchdog.ts'], files)).toEqual([]);

        const none = planUpdate({ ...baseInput, behind: 0, incoming: [] });
        expect(none.action).toBe('none');

        const ff = planUpdate(baseInput);
        expect(ff.action).toBe('update');

        const held = planUpdate({
            ...baseInput,
            holds: ['blocked by coordinator repair'],
        });
        expect(held.action).toBe('wait');

        const liveTradeWait = planUpdate({
            ...baseInput,
            incoming: ['scripts/aio-logistics.ts'],
            liveRuns: [{ name: 'tradebot', files: ['scripts/aio-logistics.ts'] }],
        });
        expect(liveTradeWait.action).toBe('wait');
    });

    test('bounds synchronous git and fleet-agent subprocess calls with timeouts and non-interactive git env', () => {
        expect(LIVE_UPDATE_GIT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
        expect(AGENT_SUBPROCESS_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);

        const dir = scratch();
        const git = gitIn(dir, 5_000);
        // Verify GIT_TERMINAL_PROMPT=0 is propagated to git child processes.
        const probe = git('--version');
        expect(probe.ok).toBe(true);

        const inspectSrc = readFileSync(join(import.meta.dir, '..', 'src', 'live-update', 'inspect.ts'), 'utf8');
        expect(inspectSrc).toContain('spawnSyncTimed');
        expect(inspectSrc).toContain("GIT_TERMINAL_PROMPT: '0'");

        const reloadSrc = readFileSync(join(import.meta.dir, '..', 'src', 'live-update', 'reload.ts'), 'utf8');
        expect(reloadSrc).toContain('spawnSyncTimed');
        expect(reloadSrc).toContain('timeout: LIVE_UPDATE_GIT_TIMEOUT_MS');

        const agentSrc = readFileSync(join(import.meta.dir, '..', 'src', 'fleet-agent.ts'), 'utf8');
        expect(agentSrc).toContain('spawnSyncTimed');
        expect(agentSrc).toContain('timeout: AGENT_SUBPROCESS_TIMEOUT_MS');
    });

    test('pauses on active live-update, coordinator, and swarm stop files without mutating checkout', async () => {
        for (const flag of ['live-update', 'coordinator', 'swarm']) {
            const root = scratch();
            mkdirSync(join(root, '.practice', 'live'), { recursive: true });
            writeFileSync(join(root, '.practice', flag === 'swarm' ? 'live' : '', `stop-${flag}`), 'owner hold');
            // A paused update cannot land, so the pass removes the drain mark; a dry pass keeps it.
            writePendingUpdate(root, { at: Date.now(), target: 't', files: ['a.ts'] });
            const dry: string[] = [];
            expect(await runLiveUpdateCli(root, ['--dry'], {}, line => dry.push(line))).toBe(0);
            expect(dry[0]).toMatch(/^RESULT ok live-update paused\b/);
            expect(existsSync(pendingUpdateFile(root))).toBe(true);
            const lines: string[] = [];
            const code = await runLiveUpdateCli(root, [], {}, line => lines.push(line));
            expect(code).toBe(0);
            expect(lines[0]).toMatch(/^RESULT ok live-update paused\b/);
            expect(existsSync(pendingUpdateFile(root))).toBe(false);
        }
    });

    test('live updates turned off remove the drain mark', async () => {
        const root = scratch();
        mkdirSync(join(root, '.practice', 'live'), { recursive: true });
        writePendingUpdate(root, { at: Date.now(), target: 't', files: ['a.ts'] });
        const lines: string[] = [];
        expect(await runLiveUpdateCli(root, [], { LIVE_UPDATE: '0' }, line => lines.push(line))).toBe(0);
        expect(lines[0]).toBe('RESULT ok live-update off (LIVE_UPDATE=0)');
        expect(existsSync(pendingUpdateFile(root))).toBe(false);
    });

    test('readCheckout detects untracked path-prefix collisions and applyUpdate adopts matching untracked files safely', () => {
        const base = scratch();
        const remote = join(base, 'remote.git');
        const seed = join(base, 'seed');
        const clone = join(base, 'clone');
        const runGit = (cwd: string, ...args: string[]) => {
            const p = Bun.spawnSync(
                ['git', '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args],
                { cwd, windowsHide: true, stdout: 'pipe', stderr: 'pipe' },
            );
            if (p.exitCode !== 0) throw Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
            return p.stdout.toString().trim();
        };

        runGit(base, 'init', '--bare', '-b', 'master', remote);
        runGit(base, 'init', '-b', 'master', seed);
        writeFileSync(join(seed, 'base.txt'), 'v1\n');
        runGit(seed, 'add', '.');
        runGit(seed, 'commit', '-qm', 'init');
        runGit(seed, 'remote', 'add', 'origin', remote);
        runGit(seed, 'push', '-q', 'origin', 'master');

        runGit(base, 'clone', '-q', '--branch', 'master', remote, clone);

        // Upstream adds dir/child.txt and flat.txt.
        mkdirSync(join(seed, 'dir'), { recursive: true });
        writeFileSync(join(seed, 'dir', 'child.txt'), 'child\n');
        writeFileSync(join(seed, 'flat.txt'), 'flat\n');
        runGit(seed, 'add', '.');
        runGit(seed, 'commit', '-qm', 'add dir and flat');
        runGit(seed, 'push', '-q', 'origin', 'master');
        runGit(clone, 'fetch', '-q', 'origin', 'master');

        // 1. Untracked file "dir" collides with incoming "dir/child.txt" -> must hold (wait).
        writeFileSync(join(clone, 'dir'), 'local blocker\n');
        const git = gitIn(clone);
        const collisionCheckout = readCheckout(git, clone, 'origin/master');
        const collisionPlan = planUpdate({ ...collisionCheckout, holds: [], heldFiles: [] });
        expect(collisionPlan.action).toBe('wait');
        if (collisionPlan.action === 'wait') expect(collisionPlan.reason).toContain('dir');

        // 2. Identical untracked file "dir/child.txt" and "flat.txt" adopt cleanly and fast-forward.
        rmSync(join(clone, 'dir'));
        mkdirSync(join(clone, 'dir'), { recursive: true });
        writeFileSync(join(clone, 'dir', 'child.txt'), 'child\n');
        writeFileSync(join(clone, 'flat.txt'), 'flat\n');
        const cleanCheckout = readCheckout(git, clone, 'origin/master');
        const cleanPlan = planUpdate({ ...cleanCheckout, holds: [], heldFiles: [] });
        expect(cleanPlan.action).toBe('update');
        if (cleanPlan.action === 'update') {
            expect(cleanPlan.adopt.map(d => d.path).sort()).toEqual(['dir/child.txt', 'flat.txt']);
            const applied = applyUpdate(git, clone, 'origin/master', cleanPlan.adopt);
            expect(applied).toEqual({ ok: true, detail: '' });
            expect(readFileSync(join(clone, 'dir', 'child.txt'), 'utf8').replace(/\r/g, '')).toBe('child\n');
        }
        // Real git clones and checkouts: about 5.8 s on a Windows PC, past Bun's 5 s default.
    }, 30_000);

    test('all subprocess spawns in packages/fleet/src and owned fleet/cloud scripts specify windowsHide: true', () => {
        const repo = resolve(import.meta.dir, '../../..');
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ts')) files.push(full);
            }
        };
        walk(join(repo, 'packages', 'fleet', 'src'));
        for (const name of readdirSync(join(repo, 'scripts'))) {
            if (/^(?:swarm|fleet.*|cloud-.*)\.ts$/.test(name) && !name.endsWith('.test.ts')) {
                files.push(join(repo, 'scripts', name));
            }
        }
        const missing: string[] = [];
        const spawnCallRe = /\b(?:Bun\.)?spawn(?:Sync)?(?:Timed)?\s*\(/g;
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            let match: RegExpExecArray | null;
            spawnCallRe.lastIndex = 0;
            while ((match = spawnCallRe.exec(src)) !== null) {
                const slice = src.slice(match.index, Math.min(src.length, match.index + 500));
                if (!/windowsHide\s*:\s*true/.test(slice)) {
                    missing.push(`${file}:${src.slice(0, match.index).split('\n').length}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });
});
