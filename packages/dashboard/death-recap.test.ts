import { expect, test } from 'bun:test';
import { recapFromLines } from './death-recap';

const line = (row: unknown) => JSON.stringify(row);
const player = (t: number, hp: number, isDead = false) => ({ name: 'Alpha', hp, maxHp: 10, worldX: 3100, worldZ: 3700, level: 0, isDead });

test('a death recap names the killer, the hits, the hitpoints, the last actions and what the death took', () => {
    const lines = [
        line({ k: 'meta', v: 1, account: 'alpha', script: 'scripts/pk.ts', startedAt: 1_000_000 }),
        line({ k: 's', t: 10, d: { player: player(10, 10), inventory: [{ name: 'Shark', count: 5 }], equipment: [{ name: 'Rune scimitar', count: 1 }], nearbyPlayers: [{ index: 7, name: 'Goondelf', combatLevel: 80 }] } }),
        line({ k: 'a', t: 11, i: 1, a: { type: 'eatFood' } }),
        line({ k: 's', t: 11, d: { player: player(11, 4), combatEvents: [{ tick: 11, type: 'damage_taken', damage: 6, sourceType: 'other_player', sourceIndex: 7, targetType: 'player' }] } }),
        line({ k: 's', t: 12, d: { player: player(12, 0, true), combatEvents: [{ tick: 11, type: 'damage_taken', damage: 6, sourceType: 'other_player', sourceIndex: 7, targetType: 'player' }, { tick: 12, type: 'damage_taken', damage: 4, sourceType: 'other_player', sourceIndex: 7, targetType: 'player' }, { tick: 12, type: 'damage_taken', damage: 1, sourceType: 'npc', sourceIndex: -1, targetType: 'player' }, { tick: 12, type: 'damage_taken', damage: 9, sourceType: 'other_player', sourceIndex: 3, targetType: 'npc' }] } }),
        line({ k: 's', t: 20, d: { player: { ...player(20, 10), worldX: 3222, worldZ: 3218 }, inventory: [], equipment: [{ name: 'Rune scimitar', count: 1 }] } }),
    ];
    const r = recapFromLines(lines, 'f.gz', 'pk', 600)!;
    expect(r.account).toBe('alpha');
    expect(r.tick).toBe(12);
    expect(r.at).toBe(1_000_000 + 2 * 600);
    expect(r.pos).toEqual({ x: 3100, z: 3700, level: 0 });
    expect(r.hits).toEqual([
        { tick: 11, damage: 6, source: 'Goondelf (level 80)' },
        { tick: 12, damage: 4, source: 'Goondelf (level 80)' },
        { tick: 12, damage: 1, source: 'attacker not seen' },
    ]);
    expect(r.killer).toBe('attacker not seen');
    expect(r.hp).toEqual([[10, 10], [11, 4], [12, 0]]);
    expect(r.actions).toEqual([{ tick: 11, type: 'eatFood' }]);
    expect(r.carried).toEqual([{ name: 'Shark', count: 5 }, { name: 'Rune scimitar', count: 1 }]);
    expect(r.kept).toEqual([{ name: 'Rune scimitar', count: 1 }]);
    expect(r.lost).toEqual([{ name: 'Shark', count: 5 }]);
});

test('a record with no death has no recap, and of two deaths the recap is of the last', () => {
    expect(recapFromLines([line({ k: 's', t: 1, d: { player: player(1, 10) } })])).toBeNull();
    expect(recapFromLines([line({ k: 'meta', startedAt: 5 }), line({ k: 's', t: 1, d: { player: player(1, 10) } }), line({ k: 's', t: 2, d: { player: player(2, 0, true) } })])!.at).toBeNull();
    const two = recapFromLines([
        line({ k: 's', t: 1, d: { player: player(1, 10) } }),
        line({ k: 's', t: 2, d: { player: player(2, 0, true) } }),
        line({ k: 's', t: 3, d: { player: player(3, 10) } }),
        line({ k: 's', t: 9, d: { player: player(9, 0, true) } }),
    ])!;
    expect(two.tick).toBe(9);
    expect(two.kept).toBeNull();
});
