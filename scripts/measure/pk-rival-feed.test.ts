import { expect, test } from 'bun:test';
import { digest, model } from './pk-rival-feed';

// The appearance block of the feed: gender, head icons, 12 wear slots (0x200 + object id, or one 0 byte), 5 colours,
// 7 animation ids, the base-37 name, the combat level.
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

test('the digest reads a fight of a watched name: the order of its attacks, its specials and eats, the damage by the prayer of the target, and its end', () => {
    const lines = [
        JSON.stringify({ t: 'roster', k: 100, p: [[1, 'Sugma', 3000, 3880, 0, 125], [2, 'Miner', 3001, 3880, 0, 96]] }),
        tick(100, { i: 1, f: 1, x: 3000, z: 3880, ap: appearance('sugma', 125, 1, 5698) }, { i: 2, f: 1, x: 3001, z: 3880, ap: appearance('miner', 96, 0, 1275) }),
        // An attack with no faced player (an NPC) is no part of a fight.
        tick(101, { i: 1, an: [376, 0] }),
        tick(110, { i: 1, fe: 32768 + 2, an: [376, 0] }, { i: 2, hm: [[13, 1]], hp: [86, 99] }),
        tick(114, { i: 1, an: [1062, 0], sp: [252, 96, 0] }, { i: 2, hm: [[9, 1], [4, 1]], hp: [73, 99] }),
        // The target turns Protect from Melee on; a poison splat is not the dagger's hit.
        tick(116, { i: 2, ap: appearance('miner', 96, 8, 1275) }, { i: 1, hm: [[20, 1]], hp: [74, 99] }),
        tick(118, { i: 1, an: [376, 0] }, { i: 2, hm: [[6, 1], [4, 2]], hp: [63, 99] }),
        tick(121, { i: 1, an: [829, 0] }),
        // The watched name turns Protect from Melee on, then the target dies.
        tick(122, { i: 1, ap: appearance('sugma', 125, 9, 5698) }),
        tick(125, { i: 1, an: [376, 0] }, { i: 2, hm: [[0, 0]], hp: [63, 99] }),
        tick(126, { i: 2, an: [836, 0] }),
    ];
    const d = digest(lines, new Set(['sugma']), id => (id === 5698 ? 'dragon_dagger_p' : id === 1275 ? 'rune_pickaxe' : String(id)));
    expect(d.fights).toEqual([{ by: 'sugma', target: 'miner', targetCombat: 96, wild: 46, start: 110, end: 125, order: 'LSLEL', open: [13, 9, 4], prayed: [6, 0], eatAt: [74], hpLow: 74,
        targetWorn: ['rune_pickaxe'], ended: 'target died' }]);
    expect(d.intervals).toEqual({ 9: 1, 4: 2, 7: 1 });
    expect(d.prayers).toEqual([{ tick: 122, name: 'sugma', on: 'melee', near: 'miner: rune_pickaxe' }]);
    expect(model(d)).toMatchObject({ fights: 1, attacks: 4, specials: 1, firstSpecialAfterAttacks: [1], eatAt: [74], hpLow: 74, maxHitOpen: 13, hitsOpen: 3, maxHitPrayed: 6, hitsPrayed: 2, prayers: 1, deaths: 0, ends: { 'target died': 1 } });
});

test('a fight ends when the feed drops the target, when the watched name dies, and when the attacks stop', () => {
    const start = [JSON.stringify({ t: 'roster', k: 10, p: [[1, 'Ligma', 3000, 3600, 0, 125], [2, 'Runner', 3001, 3600, 0, 120]] }),
        tick(10, { i: 1, f: 1, x: 3000, z: 3600, ap: appearance('ligma', 125, 0, 5698) }, { i: 2, f: 1, x: 3001, z: 3600, ap: appearance('runner', 120, 0, 861) }),
        tick(12, { i: 1, fe: 32768 + 2, an: [376, 0] })];
    const names = new Set(['ligma']);
    expect(digest([...start, JSON.stringify({ t: 'tick', r: 0, k: 14, rp: [2] })], names).fights[0]).toMatchObject({ order: 'L', ended: 'target left', wild: 11 });
    const died = digest([...start, tick(16, { i: 1, an: [836, 0] })], names);
    expect(died.fights[0]!.ended).toBe('attacker died');
    expect(died.deaths).toEqual([{ tick: 16, name: 'ligma' }]);
    expect(digest([...start, tick(60, { i: 2, m: [4] })], names).fights[0]!.ended).toBe('stopped');
    expect(digest(['not json', ''], names)).toEqual({ fights: [], intervals: {}, prayers: [], deaths: [] });
});
