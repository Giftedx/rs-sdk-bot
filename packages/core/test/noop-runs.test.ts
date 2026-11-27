import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOOP_RUN_LIMIT, NoOpRunGuard, noOpLines, readNoOpRuns, statusFingerprint } from '../src/noop-runs';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const status = (over: Record<string, unknown> = {}) => ({
    name: 'Woodpecker',
    pos: { x: 3185, z: 3436, level: 0 },
    skills: [{ name: 'Mining', level: 99, xp: 2_155_812 }, { name: 'Attack', level: 99, xp: 1_458_700 }],
    inventory: [{ id: 1269, baseId: 1269, count: 1, slot: 2 }],
    guildFacts: { questStages: { cook: 2 }, varps: {} },
    ...over,
});
const SIG = '["scripts/aio-logistics.ts",false,["woodpecker"],[["RECOVERY_TARGET_HUB","varrock_west"]],false,["walk-to","3185","3436","0"]]';
const JOB = 'scripts/aio-logistics.ts walk-to 3185 3436 0';

test('statusFingerprint changes with XP, items, position and quest stages, and needs a position and skills', () => {
    const a = statusFingerprint(status())!;
    expect(a).toBeDefined();
    expect(statusFingerprint(status())).toEqual(a);
    expect(statusFingerprint(status({ pos: { x: 3186, z: 3436, level: 0 } }))).not.toEqual(a);
    expect(statusFingerprint(status({ skills: [{ name: 'Mining', xp: 2_155_900 }, { name: 'Attack', xp: 1_458_700 }] }))).not.toEqual(a);
    expect(statusFingerprint(status({ inventory: [{ id: 1269, count: 1 }, { id: 1436, count: 27 }] }))).not.toEqual(a);
    expect(statusFingerprint(status({ guildFacts: { questStages: { cook: 3 }, varps: {} } }))).not.toEqual(a);
    expect(statusFingerprint({ name: 'x', skills: [] })).toBeUndefined();
    expect(statusFingerprint(null)).toBeUndefined();
});

test('a job held after two ok runs with no change in a row, until the account state changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noop-')); dirs.push(dir);
    const file = join(dir, 'noop-runs.json');
    const guard = new NoOpRunGuard(file);
    const fp = statusFingerprint(status())!;
    expect(NOOP_RUN_LIMIT).toBe(2);
    expect(guard.note({ account: 'Woodpecker', signature: SIG, job: JOB, ok: true, before: fp, after: fp, now: 1 })).toBeUndefined();
    expect(guard.hold('Woodpecker', SIG, fp)).toBeUndefined();
    const held = guard.note({ account: 'Woodpecker', signature: SIG, job: JOB, ok: true, before: fp, after: fp, now: 2 });
    expect(held?.runs).toBe(2);
    expect(guard.hold('woodpecker', SIG, fp)).toMatch(/^ended: no-op 2 runs in a row .*walk-to 3185 3436 0; held until the account state changes$/);
    // Another job of the same account is not held.
    expect(guard.hold('Woodpecker', `${SIG}x`, fp)).toBeUndefined();
    // The records survive a controller restart, and now.ts reads them.
    expect(new NoOpRunGuard(file).hold('Woodpecker', SIG, fp)).toBeDefined();
    expect(noOpLines(readNoOpRuns(file))).toEqual([`Woodpecker 2x ok with no change at 3185,3436,0: ${JOB}`]);
    // A changed state ends the hold.
    const moved = statusFingerprint(status({ pos: { x: 3253, z: 3420, level: 0 } }))!;
    expect(guard.hold('Woodpecker', SIG, moved)).toBeUndefined();
    expect(guard.hold('Woodpecker', SIG, fp)).toBeUndefined();
    expect(readNoOpRuns(file)).toEqual([]);
});

test('a failed run, a run with a change or a run of another job resets the count', () => {
    const guard = new NoOpRunGuard();
    const fp = statusFingerprint(status())!;
    const xp = statusFingerprint(status({ skills: [{ name: 'Mining', xp: 2_200_000 }, { name: 'Attack', xp: 1_458_700 }] }))!;
    const note = (o: { ok?: boolean; before?: typeof fp; after?: typeof fp; signature?: string }) =>
        guard.note({ account: 'Woodpecker', signature: o.signature ?? SIG, job: JOB, ok: o.ok ?? true, before: o.before ?? fp, after: o.after ?? fp, now: 1 });
    note({});
    expect(note({ ok: false })).toBeUndefined();
    expect(note({})).toBeUndefined();
    expect(note({ after: xp })).toBeUndefined();
    expect(note({ before: xp, after: xp })).toBeUndefined();
    expect(note({ signature: 'other', before: xp, after: xp })).toBeUndefined();
    expect(note({ before: xp, after: xp })).toBeUndefined();
    expect(note({ before: xp, after: xp })?.runs).toBe(2);
    // No proof of state (a missing status) is no no-op.
    const g2 = new NoOpRunGuard();
    for (let i = 0; i < 3; i++) expect(g2.note({ account: 'A', signature: SIG, job: JOB, ok: true, before: undefined, after: fp, now: i })).toBeUndefined();
});
