import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { lightSeaSlugTorch } from './generated/quest-seaslug';
import { parseJm2 } from '../packages/knowledge/src/jm2';

function fixture(torch = false) {
    const pack = new Set([1468, ...(torch ? [596] : [])]);
    let received = true, stopped = false, attempts = 0, failures = 0, lightAt = 1;
    const calls: string[] = [];
    const q = {
        has: (id: number) => pack.has(id),
        guard: async () => { if (stopped) throw Error('stopped'); },
        fail: async (why: string) => { throw Error(why); },
        talk: async (label: string, npc: RegExp, choices: RegExp[], observed: () => boolean, home: unknown, ticks: number) => {
            calls.push(label);
            expect(npc.test('Bailey')).toBe(true); expect(choices).toEqual([]);
            expect(home).toEqual({ x: 2763, z: 3276 }); expect(ticks).toBe(60);
            if (received) pack.add(596);
            // Receipt is checked independently even if a dialogue adapter returns early.
            observed();
        },
        converse: async () => { calls.push('close dialogue'); }, dialogOpen: () => false,
        slot: () => 0, msgCount: () => failures,
        waitUntil: async (observed: () => boolean, ticks: number) => { expect(ticks).toBe(6); return observed(); },
        s: { direct: async () => {
            expect(pack.has(596)).toBe(true); calls.push('rub'); attempts++;
            if (attempts >= lightAt) { pack.delete(596); pack.add(594); } else failures++;
        } },
    } as unknown as Parameters<typeof lightSeaSlugTorch>[0];
    return { q, pack, calls, attempts: () => attempts,
        receive: (x: boolean) => { received = x; }, stop: () => { stopped = true; },
        succeedsAt: (n: number) => { lightAt = n; } };
}

test('normal entry obtains free Bailey torch before lighting and observes its conversion', async () => {
    const f = fixture(); await lightSeaSlugTorch(f.q);
    expect(f.calls).toEqual(['bailey torch', 'close dialogue', 'rub']);
    expect(f.pack.has(596)).toBe(false); expect(f.pack.has(594)).toBe(true);
});
test('prepared unlit or lit torch preserves the existing path without Bailey', async () => {
    const unlit = fixture(true); await lightSeaSlugTorch(unlit.q);
    expect(unlit.calls).toEqual(['rub']);
    const lit = fixture(); lit.pack.add(594); await lightSeaSlugTorch(lit.q);
    expect(lit.calls).toEqual([]);
});
test('unobserved Bailey receipt fails before rubbing', async () => {
    const f = fixture(); f.receive(false);
    await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('Bailey torch not received');
    expect(f.attempts()).toBe(0);
});
test('stop and missing sticks prevent lighting actions', async () => {
    const f = fixture(); f.stop(); await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('stopped');
    expect(f.calls).toEqual([]);
    const missing = fixture(true); missing.pack.delete(1468);
    await expect(lightSeaSlugTorch(missing.q)).rejects.toThrow('no dry sticks');
    expect(missing.attempts()).toBe(0);
});
test('lighting failure is bounded to six attempts; sixth success is accepted', async () => {
    const f = fixture(true); f.succeedsAt(7);
    await expect(lightSeaSlugTorch(f.q)).rejects.toThrow('torch not lit'); expect(f.attempts()).toBe(6);
    const sixth = fixture(true); sixth.succeedsAt(6); await lightSeaSlugTorch(sixth.q);
    expect(sixth.attempts()).toBe(6); expect(sixth.pack.has(594)).toBe(true);
});
test('Bailey approach matches the pinned NPC spawn', () => {
    const map = parseJm2('m43_51.jm2', readFileSync('vendor/rs-sdk/server/content/maps/m43_51.jm2', 'utf8'));
    expect(map.npcs.filter(n => n.id === 695).map(n => [n.x, n.z, n.level])).toEqual([[2763, 3276, 0]]);
    expect(readFileSync('vendor/rs-sdk/server/content/pack/npc.pack', 'utf8')).toContain('695=bailey');
});
