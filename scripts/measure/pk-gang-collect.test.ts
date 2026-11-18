import { expect, test } from 'bun:test';
import { followRect, inside, POST } from './pk-gang-collect';

test('the rectangle with no name online holds the post', () => {
    const r = followRect([]);
    expect(inside(r, POST.x, POST.z, 8)).toBe(true);
});

test('the rectangle stays while each name is inside its edge, and moves when one leaves', () => {
    const r = followRect([{ x: 3078, z: 3640 }]);
    expect(followRect([{ x: 3090, z: 3650 }], r)).toBe(r);
    const far = followRect([{ x: 3078, z: 3640 }, { x: 2948, z: 3820 }], r);
    expect(far).not.toBe(r);
    expect(inside(far, 3078, 3640, 8)).toBe(true);
    expect(inside(far, 2948, 3820, 8)).toBe(true);
});

test('a box wider than a subscription is cut to 384 tiles a side', () => {
    const r = followRect([{ x: 2950, z: 3525 }, { x: 3380, z: 3960 }]);
    expect(r.w).toBe(384);
    expect(r.h).toBe(384);
});
