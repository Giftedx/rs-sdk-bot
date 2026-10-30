import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildNpcTravel, parseCoord, type TravelRecord } from '../src/npc-travel';
import { contentRoot } from '../src/paths';

const { records, excluded } = buildNpcTravel();
const line = (src: string) => { const [file, n] = [src.slice(0, src.lastIndexOf(':')), Number(src.slice(src.lastIndexOf(':') + 1))]; return readFileSync(join(contentRoot(), file), 'utf8').split(/\r?\n/)[n - 1] ?? ''; };
const one = (npc: string, dest: RegExp): TravelRecord => {
    const r = records.filter(r => r.npc.debugname === npc && dest.test(r.destination));
    expect(r).toHaveLength(1);
    return r[0]!;
};

test('parseCoord packs level_mx_mz_lx_lz', () => {
    expect(parseCoord('0_48_51_10_20')).toEqual({ x: 3082, z: 3284, level: 0 });
});

test('Captain Barnaby sails to Brimhaven for 30 coins onto a deck', () => {
    const r = one('captain_barnaby', /Brimhaven/);
    expect(r.kind).toBe('boat');
    expect(r.npc.id).toBe(381);
    expect(r.fare.coins).toBe(30);
    expect(line(r.fare.src!)).toContain('inv_del(inv, coins, 30);');
    expect(r.to).toMatchObject({ x: 2775, z: 3234, level: 1, raw: '1_43_50_23_34' });
    expect(r.options.map(o => o.text)).toEqual(['Yes please.']);
    expect(r.deck.onDeck).toBe(true);
    expect(r.deck.gangplank?.loc).toBe('ardougneshipplank_off');
    expect(r.from).toEqual([expect.objectContaining({ x: 2679, z: 3275, level: 0 })]);
});

test('Port Sarim seamen sail to Karamja for 30 coins', () => {
    for (const npc of ['seaman_lorris', 'seaman_thresnor', 'captain_tobias']) {
        const r = one(npc, /Karamja/);
        expect(r.fare.coins).toBe(30);
        expect(r.to).toMatchObject({ x: 2956, z: 3143, level: 1 });
        expect(r.deck.gangplank?.loc).toBe('sarimshipplank_off');
    }
});

test('Customs officers split by x: Brimhaven to Ardougne, Musa Point to Port Sarim', () => {
    const a = one('customs_officer', /Ardougne/), s = one('customs_officer', /Port Sarim/);
    expect(a.from.every(f => f.x < 2815)).toBe(true);
    expect(s.from.every(f => f.x >= 2815)).toBe(true);
    expect(a.to).toMatchObject({ x: 2683, z: 3268, level: 1 });
    expect(s.to).toMatchObject({ x: 3032, z: 3217, level: 1 });
    expect(a.options.map(o => o.text)).toEqual(['Can I journey on this ship?', 'Search away, I have nothing to hide.', 'Ok.']);
});

test('Al Kharid toll gate costs 10 coins and lands on the far side', () => {
    const east = one('borderguard1', /Al Kharid/), west = one('borderguard2', /Lumbridge/);
    expect(east.fare.coins).toBe(10);
    expect(east.to).toMatchObject({ x: 3268, z: 3227, level: 0 });
    expect(west.to).toMatchObject({ x: 3267, z: 3227, level: 0 });
    expect(east.options.map(o => o.text)).toEqual(['Yes, ok.']);
});

test('Gnome glider Ta Quir Priw to Kar-Hewo needs The Grand Tree and lands within 1 tile', () => {
    const r = one('gnomepilot', /^Kar-Hewo/);
    expect(r.to).toMatchObject({ x: 3284, z: 3211, level: 0, radius: 1 });
    expect(r.button?.component).toBe('glidermap:com_25');
    expect(r.requires).toEqual([expect.objectContaining({ varp: 'grandtree', op: '=', value: 160 })]);
    expect(r.from).toEqual([expect.objectContaining({ x: 2464, z: 3501, level: 3 })]);
});

test('Captain Shanks needs a ship ticket, not a fixed fare', () => {
    const r = one('captain_shanks', /Khazard/);
    expect(r.fare.coins).toBeNull();
    expect(r.fare.ruleSrc?.map(line).join('\n')).toContain('inv_del(inv, coins, 25);');
    expect(r.items.find(i => i.item === 'shiloshipticket')?.use).toBe('consumed');
    expect(r.to).toMatchObject({ x: 2680, z: 3150, level: 0 });
});

test('Aubury essence teleport lists the mine tiles and the return tile', () => {
    const r = one('aubury', /essence/);
    expect(r.op).toMatchObject({ index: 4, label: 'Teleport' });
    expect(r.to).toBeNull();
    expect(r.toCandidates!.length).toBeGreaterThan(0);
    expect(r.returnTo).toMatchObject({ x: 3253, z: 3401, level: 0, radius: 2 });
});

test('every cited line exists and every literal coordinate is on its cited line', () => {
    for (const r of records) {
        for (const src of [r.npc.src, r.op.trigger, ...r.options.map(o => o.src), ...r.requires.map(q => q.src), ...r.items.map(i => i.src)]) expect(line(src).length).toBeGreaterThan(0);
        for (const o of r.options) expect(line(o.src)).toContain(`"${o.text}"`);
        if (r.to) expect(line(r.to.src)).toContain(r.to.raw);
        if (r.fare.src) expect(line(r.fare.src)).toContain(`coins, ${r.fare.coins}`);
        expect(r.from.length).toBeGreaterThan(0);
    }
    for (const e of excluded) expect(line(e.src).length).toBeGreaterThan(0);
});
