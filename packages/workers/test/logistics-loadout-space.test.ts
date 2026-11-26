import { expect, test } from 'bun:test';
import { clientStackable, loadoutSlotsNeeded, loadoutSpaceRefusal } from '../src/logistics/loadout-space';

const pack = (n: number) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i }));

test('103 unnoted dragon bones cannot fit an empty pack', () => {
    expect(loadoutSlotsNeeded(536, 103, [], false)).toBe(103);
    expect(loadoutSpaceRefusal(536, 103, [], false)).toBe('loadout pack space short itemId=536 need=103 slots=103 free=28');
});

test('28 rune essence do not fit a pack with 2 slots taken, 26 do', () => {
    expect(loadoutSpaceRefusal(1436, 28, pack(2), false)).toBe('loadout pack space short itemId=1436 need=28 slots=28 free=26');
    expect(loadoutSpaceRefusal(1436, 26, pack(2), false)).toBeUndefined();
});

test('stackable runes take one slot, or none when the pack holds them', () => {
    expect(loadoutSlotsNeeded(556, 5000, [], true)).toBe(1);
    expect(loadoutSlotsNeeded(556, 5000, [{ id: 556 }], true)).toBe(0);
    expect(loadoutSpaceRefusal(556, 5000, pack(28), true)).toBe('loadout pack space short itemId=556 need=5000 slots=1 free=0');
    expect(loadoutSpaceRefusal(556, 5000, [...pack(27), { id: 556 }], true)).toBeUndefined();
});

test('unknown stackability does not refuse, and the client item type answers it', () => {
    expect(loadoutSpaceRefusal(536, 103, [], undefined)).toBeUndefined();
    const client = { objType: (id: number) => ({ stackable: id === 556 }) };
    expect(clientStackable(client, 556)).toBe(true);
    expect(clientStackable(client, 536)).toBe(false);
    expect(clientStackable({}, 556)).toBeUndefined();
    expect(clientStackable(undefined, 556)).toBeUndefined();
});
