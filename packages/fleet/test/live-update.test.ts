import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DAEMONS,
    SDK,
    SDK_PATCH,
    addedPreloads,
    patchChangedFiles,
    patchCollisions,
    patchSections,
    planUpdate,
    preloadOnlyChange,
    reloadsFor,
    type UpdateInput,
} from '../src/live-update';

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
        expect(Object.keys(DAEMONS)).toContain('autopilot');
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
            autopilot: ['scripts/autopilot.ts'],
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
});
