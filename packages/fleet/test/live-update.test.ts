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
    planUpdate,
    preloadOnlyChange,
    readCheckout,
    reloadsFor,
    type UpdateInput,
} from '../src/live-update';
import { runLiveUpdateCli } from '../src/live-update/reload';
import { AGENT_SUBPROCESS_TIMEOUT_MS } from '../src/fleet-agent';

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
            const lines: string[] = [];
            const code = await runLiveUpdateCli(root, [], {}, line => lines.push(line));
            expect(code).toBe(0);
            expect(lines[0]).toMatch(/^RESULT ok live-update paused\b/);
        }
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
    });

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
