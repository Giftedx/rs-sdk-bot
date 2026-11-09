import { test, expect } from 'bun:test';
import { decodeHeadicons, decodeWorn, openStyles, readOpponent, readOpponents } from '../src/opponent';

test('headicon bits decode to protect prayers and skull', () => {
    expect(decodeHeadicons(0)).toEqual({ protect: [], skulled: false });
    expect(decodeHeadicons(1 << 3)).toEqual({ protect: ['melee'], skulled: false });
    expect(decodeHeadicons((1 << 0) | (1 << 5))).toEqual({ protect: ['magic'], skulled: true });
    expect(decodeHeadicons(1 << 4).protect).toEqual(['ranged']);
    // Multi-combat, hint and duel icons are not prayers.
    expect(decodeHeadicons((1 << 1) | (1 << 2) | (1 << 6) | (1 << 7))).toEqual({ protect: [], skulled: false });
});

test('worn items come from 0x200 + obj id; kit parts and empty slots are skipped', () => {
    const appearance = new Uint16Array(12);
    appearance[3] = 0x200 + 1215; // dragon dagger, right hand
    appearance[4] = 0x100 + 18;   // kit torso, no item
    appearance[5] = 0x200 + 1540; // anti-dragon shield, left hand
    appearance[0] = 0x200 + 0;    // obj id 0 is a real id
    expect(decodeWorn(appearance)).toEqual({ hat: 0, rhand: 1215, lhand: 1540 });
});

function client(cycle = 1000) {
    const local = { name: 'Me' };
    const players: any[] = [];
    players[7] = local;
    players[12] = { name: 'Goondelf', combatLevel: 126, headicons: (1 << 3) | 1, appearance: [0, 0, 0, 0x200 + 1215], health: 82, totalHealth: 99, combatCycle: cycle + 50 };
    players[30] = { name: 'Fordmine4', combatLevel: 95, headicons: 0, appearance: [], health: 0, totalHealth: 0, combatCycle: -1000 };
    players[31] = { name: 'Stale', combatLevel: 90, headicons: 0, appearance: [], health: 40, totalHealth: 90, combatCycle: cycle - 1 };
    players[44] = null;
    return { localPlayer: local, players, playerIds: [7, 12, 30, 31, 44], playerCount: 5, getClientCycle: () => cycle };
}

test('readOpponents skips self and empty slots and reports HP freshness', () => {
    const list = readOpponents(client());
    expect(list.map(o => o.name)).toEqual(['Goondelf', 'Fordmine4', 'Stale']);
    expect(list[0]).toEqual({ index: 12, name: 'Goondelf', combatLevel: 126, protect: ['melee'], skulled: true, worn: { rhand: 1215 }, hp: { current: 82, max: 99, fresh: true } });
    expect(list[1].hp).toBeNull();
    expect(list[2].hp).toEqual({ current: 40, max: 90, fresh: false });
});

test('readOpponent matches names without case; a client without a local player gives nothing', () => {
    expect(readOpponent(client(), 'goondelf')?.index).toBe(12);
    expect(readOpponent(client(), 'nobody')).toBeNull();
    expect(readOpponents({ players: [], playerIds: [] })).toEqual([]);
    expect(readOpponents(undefined)).toEqual([]);
});

test('openStyles keeps the attacker order and drops the protected style', () => {
    expect(openStyles({ protect: ['melee'] }, ['melee', 'ranged', 'magic'])).toEqual(['ranged', 'magic']);
    expect(openStyles({ protect: [] }, ['magic', 'melee'])).toEqual(['magic', 'melee']);
    expect(openStyles({ protect: ['ranged'] }, ['ranged'])).toEqual([]);
});
