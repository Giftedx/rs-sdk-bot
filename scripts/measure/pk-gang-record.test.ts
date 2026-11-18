import { expect, test } from 'bun:test';
import { addTrace, groupFile, newRecord, targetFile } from './pk-gang-record';

// The appearance block of the feed (pk-rival-feed.test.ts): head icons, the weapon in wear slot 3, the name, the combat level.
const BASE37 = ' abcdefghijklmnopqrstuvwxyz0123456789';
function appearance(name: string, combat: number, head: number, weapon: number): string {
    const b: number[] = [0, head];
    for (let slot = 0; slot < 12; slot++) { if (slot === 3) { const v = 0x200 + weapon; b.push(v >> 8, v & 255); } else b.push(0); }
    for (let i = 0; i < 5 + 14; i++) b.push(0);
    let v = 0n; for (const c of name) v = v * 37n + BigInt(BASE37.indexOf(c));
    for (let i = 7; i >= 0; i--) b.push(Number((v >> BigInt(i * 8)) & 255n));
    b.push(combat);
    return btoa(String.fromCharCode(...b));
}
const tick = (k: number, ...p: object[]) => JSON.stringify({ t: 'tick', r: 0, k, p });
const roster = (k: number, ...p: unknown[][]) => JSON.stringify({ t: 'roster', k, p });
const OBJ: Record<number, string> = { 1231: 'dragon_dagger_p', 861: 'magic_shortbow', 1215: 'dragon_dagger' }, SEQ: Record<number, string> = { 426: 'human_bow', 376: 'human_ddagger_lunge' };
const build = (lines: string[]) => { const rec = newRecord(); addTrace(rec, 'test.jsonl', lines, () => false, id => SEQ[id] ?? `seq${id}`, id => OBJ[id] ?? ''); return rec; };

test('a trip from the post, the attacks of it, an eat for Hitpoints and a consume that is not one', () => {
    const rec = build([
        JSON.stringify({ t: 'hello', r: 0, at: Date.UTC(2026, 0, 1, 6), tick: 100 }),
        roster(100, [1, 'Sugma', 3078, 3640, 0, 125], [2, 'Hunter', 3078, 3660, 0, 126]),
        tick(100, { i: 1, f: 1, x: 3078, z: 3640, ap: appearance('sugma', 125, 1, 1231) }, { i: 2, f: 1, x: 3078, z: 3660, ap: appearance('hunter', 126, 0, 861) }),
        roster(110, [1, 'Sugma', 3078, 3659, 0, 125], [2, 'Hunter', 3078, 3660, 0, 126]),
        tick(110, { i: 1, x: 3078, z: 3659, fe: 32768 + 2, an: [376, 0] }, { i: 2, hm: [[17, 1]], hp: [82, 99] }),
        tick(112, { i: 2, fe: 32768 + 1, an: [426, 0] }, { i: 1, hm: [[30, 1]], hp: [69, 99] }),
        // The special: two splats, and the Hitpoints of the target before it.
        tick(114, { i: 1, an: [1062, 0] }, { i: 2, hm: [[20, 1], [3, 1]], hp: [59, 99] }),
        // The eat of a tick comes before the splat of that tick: 69 before, 20 healed, 5 lost.
        tick(115, { i: 1, an: [829, 0], hm: [[5, 1]], hp: [84, 99] }),
        tick(121, { i: 1, an: [376, 0] }, { i: 2, hm: [[0, 1]], hp: [59, 99] }),
        // The opponent takes its dagger; the target turns Protect from Melee on 2 ticks later.
        tick(122, { i: 2, ap: appearance('hunter', 126, 0, 1215) }),
        tick(124, { i: 1, ap: appearance('sugma', 125, 1 | 8, 1231) }),
        roster(130, [1, 'Sugma', 3078, 3640, 0, 125]),
        // 300 ticks later, no splat since: animation 829 is not an eat for Hitpoints.
        tick(430, { i: 1, an: [829, 0] }),
    ]);
    const g = rec.acc.sugma!;
    expect(g.attacks).toBe(3);
    expect(g.specials).toBe(1);
    expect(g.intervals).toEqual({ 4: 1, 7: 1 });
    expect(g.intervalsWithEat).toEqual({ 7: 1 });
    expect(g.eatHp).toEqual({ 69: 1 });
    expect(g.heal).toEqual({ 20: 1 });
    expect(g.eatLag).toEqual({ 3: 1 });
    expect(g.otherConsumes.length).toBe(1);
    expect(g.specTargetHp).toEqual({ '80-89': 1 });
    expect(g.damage['special on a player without Protect from Melee']).toEqual({ 20: 1, 3: 1 });
    expect(g.lag.attacked).toEqual({ 2: 1 });
    expect(g.prayedAgainst['ranged: magic_shortbow']).toMatchObject({ attacks: 1, prayed: 0 });
    expect(g.trips.withAttack).toBe(1);
    expect(g.trips.response).toEqual([0]);
    expect(g.trips.back).toEqual([9]);
    expect(g.trips.targetDist).toEqual([20]);
    expect(g.choiceRank).toEqual({ '1 of 1': 1 });
    const file = targetFile('sugma', g, rec.group, undefined, 'none') as any;
    expect(file.eating.hpAtEat).toMatchObject({ status: 'measured', n: 1, value: { 69: 1 } });
    expect(file.kit.foodCount.status).toBe('unknown');
    expect(file.kit.foodCount.closes.length).toBeGreaterThan(10);
    expect((groupFile(rec) as any).post.value.tile).toEqual([3078, 3640]);
});

test('a death: the first tile after it and the ticks to the post, and a low that ends in it', () => {
    const rec = build([
        roster(100, [1, 'Ligma', 3078, 3640, 0, 125]),
        tick(100, { i: 1, f: 1, x: 3078, z: 3640, ap: appearance('ligma', 125, 1, 1231) }),
        tick(105, { i: 1, hm: [[40, 1]], hp: [36, 99] }),
        tick(120, { i: 1, hm: [[36, 1]], hp: [0, 99], an: [836, 0] }),
        roster(130, [1, 'Ligma', 3222, 3218, 0, 125]),
        roster(1200, [1, 'Ligma', 3078, 3640, 0, 125]),
    ]);
    const g = rec.acc.ligma!;
    expect(g.deaths).toEqual([{ k: 120, trace: 'test.jsonl', x: 3078, z: 3640, respawn: [3222, 3218], backOnPost: 1080 }]);
    expect(g.lows).toEqual([{ k: 105, hp: 36, minHp: 0, eatsAfter: 0, died: 15, trace: 'test.jsonl' }]);
});
