import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Entrana sellers are off the map: Frincos sells no eye of newt to the sweep', async () => {
    const { shopSellers, offMap } = await import('../src/shop-index');
    expect(offMap({ x: 2808, z: 3342, level: 0 })).toBe(true);
    expect(offMap({ x: 2528, z: 3048, level: 0 })).toBe(false);
    expect((shopSellers().get('eye_of_newt') ?? []).map(s => s.npc)).not.toContain('Frincos');
    expect((shopSellers().get('eye_of_newt') ?? []).map(s => s.npc)).toContain('Betty');
});

test('shopSellers caches built sellers and invalidates when source files change', async () => {
    const { shopSellers } = await import('../src/shop-index');
    const dir = mkdtempSync(join(tmpdir(), 'shop-cache-'));
    try {
        const contentDir = join(dir, 'content');
        mkdirSync(contentDir, { recursive: true });
        const npcFile = join(contentDir, 'keeper.npc');
        const shopsFile = join(dir, 'shops.json');
        const npcsFile = join(dir, 'npcs.json');
        const cacheFile = join(dir, 'cache', 'shop-sellers.json');
        writeFileSync(npcFile, '[keeper]\nparam=owned_shop,general_store\n');
        writeFileSync(shopsFile, JSON.stringify([{ inv: 'general_store', stock: [{ item: 'hammer', count: 5 }] }]));
        writeFileSync(npcsFile, JSON.stringify([{ id: 1, name: 'Keeper', src: 'keeper.npc:1', spawns: [{ x: 3200, z: 3200, level: 0 }] }]));

        const first = shopSellers(cacheFile, shopsFile, npcsFile, contentDir);
        expect(first.get('hammer')?.[0]?.shop).toBe('general_store');
        expect(JSON.parse(readFileSync(cacheFile, 'utf8')).v).toBe(1);

        const hit = shopSellers(cacheFile, shopsFile, npcsFile, contentDir);
        expect(hit.get('hammer')?.[0]?.npc).toBe('Keeper');

        writeFileSync(npcFile, '[keeper]\nparam=owned_shop,other_store\n');
        writeFileSync(shopsFile, JSON.stringify([{ inv: 'other_store', stock: [{ item: 'chisel', count: 3 }] }]));
        const rebuilt = shopSellers(cacheFile, shopsFile, npcsFile, contentDir);
        expect(rebuilt.get('hammer')).toBeUndefined();
        expect(rebuilt.get('chisel')?.[0]?.shop).toBe('other_store');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
