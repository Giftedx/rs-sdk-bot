import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTeleports, type Teleport } from '../src/teleports';
import { contentRoot } from '../src/paths';

const out = buildTeleports();
const byId = (id: string): Teleport => {
    const t = out.teleports.find(x => x.id === id);
    if (!t) throw new Error(`missing ${id}`);
    return t;
};
// A src must point at a content line that contains the expected text.
function lineAt(src: string): string {
    const m = src.match(/^(.+):(\d+)/)!;
    return readFileSync(join(contentRoot(), m[1]!), 'utf8').split('\n')[Number(m[2]) - 1]!;
}

test('Varrock teleport: level 25, 1 fire 3 air 1 law, 35 xp, Varrock square radius 2', () => {
    const t = byId('spell:varrock_teleport');
    const lvl = t.requires.find(r => r.type === 'skill');
    expect(lvl).toMatchObject({ skill: 'magic', level: 25 });
    expect(lineAt((lvl as { src: string }).src)).toContain('levelrequired,25');
    expect(t.runes.map(r => [r.item, r.count])).toEqual([['firerune', 1], ['airrune', 3], ['lawrune', 1]]);
    expect(t.xp).toMatchObject({ xp: 35, tenths: 350 });
    expect(t.requires.some(r => r.type === 'members')).toBe(false);
    expect(t.wildernessMax?.level).toBe(20);
    const d = t.to[0]!;
    expect(d.candidates[0]).toMatchObject({ x: 3213, z: 3424, level: 0 }); // 0_50_53_13_32
    expect(lineAt(d.candidates[0]!.src)).toContain('0_50_53_13_32');
    expect(d).toMatchObject({ minRadius: 0, maxRadius: 2, findsquare: 'lineofwalk' });
    expect(d.box).toEqual({ minX: 3211, maxX: 3215, minZ: 3422, maxZ: 3426, level: 0 });
    expect(lineAt(d.moveSrc)).toContain('~player_teleport_normal(map_findsquare(');
});

test('amulet of glory: Edgeville exact tile, 4 charges, level 30 wilderness limit', () => {
    const t = byId('jewellery:amulet_of_glory');
    const e = t.to.find(d => d.option === 'Edgeville')!;
    expect(e.candidates[0]).toMatchObject({ x: 3087, z: 3496, level: 0 }); // 0_48_54_15_40
    expect(e.findsquare).toBeNull();
    expect(lineAt(e.moveSrc)).toContain('0_48_54_15_40');
    expect(t.to.map(d => d.option)).toEqual(['Edgeville', 'Karamja', 'Draynor Village', 'Al Kharid']);
    expect(t.charges.map(c => [c.item, c.charges, c.next])).toEqual([
        ['amulet_of_glory_4', 4, 'amulet_of_glory_3'], ['amulet_of_glory_3', 3, 'amulet_of_glory_2'],
        ['amulet_of_glory_2', 2, 'amulet_of_glory_1'], ['amulet_of_glory_1', 1, 'amulet_of_glory'],
    ]);
    expect(t.wildernessMax?.level).toBe(30);
});

test('Ardougne teleport needs Plague City varp 30 (scroll read), not 29', () => {
    const t = byId('spell:ardougne_teleport');
    const q = t.requires.find(r => r.type === 'varp');
    expect(q).toMatchObject({ varp: 'elenaquest', op: '>=', value: 30 });
    expect(t.runes.map(r => [r.item, r.count])).toEqual([['waterrune', 2], ['lawrune', 2]]);
    expect(t.to[0]!.candidates[0]).toMatchObject({ x: 2661, z: 3301, level: 0 }); // 0_41_51_37_37
});

test('ring of dueling: Duel Arena and Castle Wars, 8 charges, crumbles at the last', () => {
    const t = byId('jewellery:ring_of_dueling');
    expect(t.to.map(d => [d.option, d.candidates[0]!.x, d.candidates[0]!.z])).toEqual([
        ['Al Kharid Duel Arena', 3315, 3235], // 0_51_50_51_35
        ['Castle Wars Arena', 2440, 3090],    // 0_38_48_8_18
    ]);
    expect(t.charges[0]).toMatchObject({ item: 'ring_of_dueling_8', charges: 8, next: 'ring_of_dueling_7' });
    expect(t.charges.at(-1)).toMatchObject({ item: 'ring_of_dueling_1', charges: 1, next: null });
});

test('Ardougne lever lands at wilderness level 51', () => {
    const t = byId('lever:wildinlever');
    expect(t.from!.length).toBeGreaterThan(0);
    expect(t.to[0]!.candidates[0]).toMatchObject({ x: 3154, z: 3924, level: 0, wilderness: 51 }); // ^ardougne_to_wilderness_coord = 0_49_61_18_20
    expect(lineAt(t.to[0]!.candidates[0]!.src)).toContain('0_49_61_18_20');
});

test('staff table: lava staves give fire and earth runes', () => {
    const fire = out.staffs.find(s => s.rune === 'firerune')!;
    const earth = out.staffs.find(s => s.rune === 'earthrune')!;
    expect(fire.staffs).toContain('lava_battlestaff');
    expect(earth.staffs).toContain('mystic_lava_staff');
});

test('every teleport has a destination and every src names a content line', () => {
    for (const t of out.teleports) {
        expect(t.to.length).toBeGreaterThan(0);
        for (const d of t.to) for (const c of d.candidates) expect(c.src).toMatch(/:\d+$/);
        expect(t.triggerSrc).toMatch(/^scripts\/.+:\d+$/);
    }
});
