import { expect, test } from 'bun:test';
import type { Session } from '../../core/src/inprocess';
import { noRouteResult, walkTargetPersist } from '../src/market/walk';

const session = (pos: { x: number; z: number }) => ({ sdk: { getState: () => ({ player: { worldX: pos.x, worldZ: pos.z, level: 0 } }) } }) as unknown as Session;
const SHOP = { x: 2809, z: 3441, level: 0 };

test('a shop walk whose route search found no route does not search again from the same tile', async () => {
    // Lumbridge to Hickton's archery shop: each search ran to its 45 s budget.
    const noRoute = { ok: false, reason: 'precondition', detail: 'no route to 2809,3441,0' };
    let searches = 0;
    const r = await walkTargetPersist(session({ x: 3221, z: 3220 }), SHOP, 4, async () => { searches++; return noRoute; });
    expect(r).toEqual(noRoute);
    expect(searches).toBe(1);
    expect(noRouteResult({ reason: 'precondition', detail: 'no route (search over 45000 ms) to 2809,3441,0' })).toBe(true);
    expect(noRouteResult({ reason: 'timeout', detail: 'leg timed out' })).toBe(false);
});

test('a shop walk that moved before its search found no route plans again from the new tile', async () => {
    // A boat leg lands the account at Brimhaven, then the next leg finds no route; the next try searches from there.
    const pos = { x: 3221, z: 3220 };
    const landings = [{ x: 2772, z: 3225 }, { x: 2772, z: 3225 }];
    let searches = 0;
    const r = await walkTargetPersist(session(pos), SHOP, 4, async () => {
        const next = landings[searches++];
        if (next) Object.assign(pos, next);
        return { ok: false, reason: 'precondition', detail: 'no route to 2809,3441,0' };
    });
    expect(r.ok).toBe(false);
    // Try 1 moved and found no route, try 2 stayed at Brimhaven and found none again, so it stops.
    expect(searches).toBe(2);
});

test('a shop walk leg that times out while it gets closer still retries', async () => {
    const pos = { x: 3221, z: 3220 };
    let legs = 0;
    const r = await walkTargetPersist(session(pos), SHOP, 3, async () => {
        legs++;
        pos.x -= 100;
        return { ok: false, reason: 'timeout', detail: 'leg timed out' };
    });
    expect(r.ok).toBe(false);
    expect(legs).toBe(3);
});
