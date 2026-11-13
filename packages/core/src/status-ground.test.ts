import { expect, test } from 'bun:test';
import { GROUND_STATUS_MAX, groundStatus } from './status';

test('ground status keeps each valid floor item as [x, z, level, id, count] on the player level', () => {
    const items = [
        { id: 526, name: 'Bones', count: 1, x: 3218, z: 3242, distance: 1 },
        { id: 526, name: 'Bones', count: 1, x: 3218, z: 3242, distance: 1 },
        { id: 995, name: 'Coins', count: 40, x: 3219, z: 3242, distance: 2 },
        { id: -1, name: 'bad', count: 1, x: 3219, z: 3242, distance: 2 },
        { id: 995, name: 'none', count: 0, x: 3219, z: 3242, distance: 2 },
        { id: 1, name: 'bad x', count: 1, x: 1.5, z: 3242, distance: 2 },
    ];
    expect(groundStatus(items, 1)).toEqual([[3218, 3242, 1, 526, 1], [3218, 3242, 1, 526, 1], [3219, 3242, 1, 995, 40]]);
});

test('ground status is empty without a list or a level, and stops at the cap', () => {
    expect(groundStatus(undefined, 0)).toEqual([]);
    expect(groundStatus([{ id: 1, count: 1, x: 1, z: 1 }], undefined)).toEqual([]);
    const many = Array.from({ length: GROUND_STATUS_MAX + 9 }, (_, i) => ({ id: 526, count: 1, x: 3200 + i, z: 3200 }));
    expect(groundStatus(many, 0)).toHaveLength(GROUND_STATUS_MAX);
});
