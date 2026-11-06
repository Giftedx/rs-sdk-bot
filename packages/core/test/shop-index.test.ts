import { expect, test } from 'bun:test';

test('Entrana sellers are off the map: Frincos sells no eye of newt to the sweep', async () => {
    const { shopSellers, offMap } = await import('../src/shop-index');
    expect(offMap({ x: 2808, z: 3342, level: 0 })).toBe(true);
    expect(offMap({ x: 2528, z: 3048, level: 0 })).toBe(false);
    expect((shopSellers().get('eye_of_newt') ?? []).map(s => s.npc)).not.toContain('Frincos');
    expect((shopSellers().get('eye_of_newt') ?? []).map(s => s.npc)).toContain('Betty');
});
