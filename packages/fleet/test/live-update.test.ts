import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DAEMONS,
    LIVE_UPDATE_GIT_TIMEOUT_MS,
    SDK,
    SDK_PATCH,
    addedPreloads,
    gitIn,
    patchChangedFiles,
    patchCollisions,
    patchSections,
    planUpdate,
    preloadOnlyChange,
    reloadsFor,
    type UpdateInput,
} from '../src/live-update';
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
});
