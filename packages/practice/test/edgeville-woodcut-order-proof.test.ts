import { expect, test } from 'bun:test';
import type { readPracticeSave } from '../../../scripts/measure/fleet-player-save';
import { savedBatch } from '../src/edgeville-woodcut-order-proof';

type Save = ReturnType<typeof readPracticeSave>;
function fixture(complete = false): Save {
    const skills = Array.from({ length: 21 }, (_, index) => ({ index, rawExperience: 0, xp: 0, level: 1 }));
    skills[3]!.level = 52;
    const rawExperience = 18_600 + (complete ? 11 * 9_375 : 0);
    skills[8] = { index: 8, rawExperience, xp: Math.floor(rawExperience / 10), level: complete ? 36 : 15 };
    return {
        version: 9, position: { x: 3094, z: 3491, level: 0 }, skills, vars: {},
        inventories: {
            93: [{ slot: 0, id: 385, count: 1 }],
            95: [
                { slot: complete ? 4 : 0, id: 1351, count: 1 },
                { slot: 1, id: 1521, count: complete ? 16 : 5 },
                { slot: 2, id: 995, count: 216372 },
            ],
        },
    };
}

test('accepts only the exact saved oak XP and bank increase', () => {
    expect(savedBatch(fixture(), fixture(true))).toMatchObject({ ok: true, banked: 11, delta: 103125 });
    const after = fixture(true);
    after.inventories[95]![1]!.count--;
    expect(savedBatch(fixture(), after).ok).toBe(false);
});

test('refuses a lost tool, unrelated asset debit, injury or off-route logout', () => {
    const bad = [
        (after: Save) => { after.inventories[95]!.shift(); },
        (after: Save) => { after.inventories[95]![2]!.count--; },
        (after: Save) => { after.skills[3]!.level--; },
        (after: Save) => { after.position.z = 3520; },
    ];
    for (const change of bad) {
        const after = fixture(true);
        change(after);
        expect(savedBatch(fixture(), after).ok).toBe(false);
    }
});
