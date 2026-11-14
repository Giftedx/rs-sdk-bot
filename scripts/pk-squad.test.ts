import { describe, expect, test } from 'bun:test';
import { leaveWilderness, squadTarget } from './pk-squad';

const session = (z: number) => ({ sdk: { getState: () => ({ player: { worldX: 3092, worldZ: z, hp: 50, maxHp: 99 } }), getInventory: () => [] } }) as any;

describe('leaveWilderness', () => {
    test('an account out of the Wilderness stays where it is', async () => {
        expect(await leaveWilderness(session(3496), () => false)).toBeNull();
    });
    test('a dead account does not walk', async () => {
        expect(await leaveWilderness(session(3640), () => true)).toBeNull();
    });
});

describe('squadTarget', () => {
    test('takes the lowest health bar of the targets in view', () => {
        const view = [{ name: 'Ligma', index: 1, distance: 2 }, { name: 'Sugma', index: 2, distance: 5 }, { name: 'Other', index: 3, distance: 1 }];
        const hp: Record<number, number> = { 1: 0.8, 2: 0.3, 3: 0.1 };
        expect(squadTarget(view, new Set(['ligma', 'sugma']), p => hp[p.index]!)?.name).toBe('Sugma');
    });
});
