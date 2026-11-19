import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { parsePack } from '../packages/knowledge/src/pack';
import { contentRoot } from '../packages/knowledge/src/paths';
import { attackStyleOfAnim, attackStyleOfSeq, holdProtect, protectOf, readSighting, retreatOf, ThreatWatch } from './pk-threat';

const idOf = (pack: string, name: string) => { for (const [id, n] of parsePack(read(join(contentRoot(), `pack/${pack}.pack`), 'utf8'))) if (n === name) return id; throw new Error(`${name} not in ${pack}`); };
const STAFF = idOf('obj', 'staff_of_air'), BOW = idOf('obj', 'shortbow'), SCIM = idOf('obj', 'rune_scimitar');
const CAST = idOf('seq', 'human_caststrike'), SHOOT = idOf('seq', 'human_bow');

test('the animations of the dragon dagger swings and of every special attack have a style from the content', () => {
    const style = (name: string) => attackStyleOfAnim(idOf('seq', name));
    // The swings of the dragon dagger: 376 and 377.
    expect(style('human_ddagger_lunge')).toBe('melee');
    expect(style('human_ddagger_hack')).toBe('melee');
    // The specials: dragon dagger 1062, magic shortbow 1074, dragon spear 1064, dragon longsword 1058, rune thrown axe 1068, dragon halberd 1203.
    expect(style('puncture')).toBe('melee');
    expect(style('snapshot')).toBe('ranged');
    expect(style('shove')).toBe('melee');
    expect(style('cleave')).toBe('melee');
    expect(style('chainhit')).toBe('ranged');
    expect(style('dragon_halberd_special_attack')).toBe('melee');
    expect([376, 377, 1062, 1074, 1064, 1058, 1068, 1203].map(id => attackStyleOfAnim(id))).toEqual(['melee', 'melee', 'melee', 'ranged', 'melee', 'melee', 'ranged', 'melee']);
    // Not attacks.
    for (const name of ['human_blunt_block', 'human_unarmed_def', 'giant_casting']) expect(style(name)).toBeNull();
});

test('the style of an animation comes from the name of its sequence', () => {
    expect(attackStyleOfSeq('human_caststrike')).toBe('magic');
    expect(attackStyleOfSeq('human_castentangle')).toBe('magic');
    expect(attackStyleOfSeq('human_castheal')).toBeNull();
    expect(attackStyleOfSeq('human_bow')).toBe('ranged');
    expect(attackStyleOfSeq('human_blunt_pound')).toBe('melee');
    expect(attackStyleOfSeq('human_unarmedpunch')).toBe('melee');
    for (const name of ['human_blunt_block', 'human_unarmed_def', 'human_speartrap', 'human_walk', 'giant_casting', undefined]) expect(attackStyleOfSeq(name)).toBeNull();
    expect(attackStyleOfAnim(CAST)).toBe('magic');
    expect(attackStyleOfAnim(SHOOT)).toBe('ranged');
    expect(attackStyleOfAnim(-1)).toBeNull();
});

type Fake = { index: number; name: string; combat: number; x: number; z: number; weapon?: number; anim?: number; head?: number };
// A session whose client lists `players` (slot = index) and whose nearby list shows the ones in `view`.
function session(name: string, me: Fake, players: Fake[], view: number[], o: { prayer?: number; active?: boolean[] } = {}) {
    const all = [me, ...players];
    const slots: unknown[] = [];
    for (const p of all) slots[p.index] = { name: p.name, combatLevel: p.combat, headicons: p.head ?? 0, appearance: [0, 0, 0, p.weapon !== undefined ? 0x200 + p.weapon : 0], primaryAnim: p.anim ?? -1, spotanimId: -1 };
    const toggles: number[] = [];
    const s = {
        name, client: { localPlayer: slots[me.index], players: slots },
        sdk: {
            getState: () => ({
                player: { name, worldX: me.x, worldZ: me.z, combatLevel: me.combat, isDead: false },
                nearbyPlayers: view.map(i => all.find(p => p.index === i)!).map(p => ({ index: p.index, name: p.name, combatLevel: p.combat, x: p.x, z: p.z, distance: Math.max(Math.abs(p.x - me.x), Math.abs(p.z - me.z)) })),
                prayers: { activePrayers: o.active ?? [] },
            }),
            getSkill: () => ({ level: o.prayer ?? 99 }), sendTogglePrayer: async (i: number) => { toggles.push(i); },
        },
    };
    return { s: s as never, toggles };
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ME1: Fake = { index: 1, name: 'Ours1', combat: 126, x: 3070, z: 3640 }, ME2: Fake = { index: 2, name: 'Ours2', combat: 126, x: 3072, z: 3640 };
const MAGE: Fake = { index: 9, name: 'Mage', combat: 120, x: 3075, z: 3644, weapon: STAFF };

function watch(players: Fake[], view: number[], o: { act?: boolean; expected?: string[] } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'threat-')); roots.push(root);
    const a = session('Ours1', ME1, [ME2, ...players], view), b = session('Ours2', ME2, [ME1, ...players], view);
    const lines: string[] = [];
    const w = new ThreatWatch({ sessions: () => [a.s, b.s], server: 'demo.example:43594', friends: new Set(['ours1', 'ours2']), log: l => lines.push(l), recordRoot: root, act: o.act, decide: { expected: new Set(o.expected ?? []) }, now: () => 1000 });
    return { w, lines, root, a, b };
}

test('readSighting reads the weapon, the animation and the overhead prayer of a player of the client', () => {
    const { a } = watch([{ ...MAGE, anim: CAST, head: 16 }], [9]);
    expect(readSighting((a.s as { client: unknown }).client, 9, 'Mage', 120, 3075, 3644)).toMatchObject({ inView: true, worn: { weapon: STAFF }, anim: CAST, protect: ['ranged'], skulled: false });
});

test('a mage in view that can hit us: logged with its record, a protect prayer for the members, the record file written', () => {
    const { w, lines, root } = watch([MAGE], [9]);
    const { actions, classes } = w.step(5);
    expect(classes).toHaveLength(1);
    expect(classes[0]).toMatchObject({ style: 'magic', by: 'weapon', dangerous: true });
    expect(protectOf(actions, 'Ours1')).toBe('magic');
    expect(protectOf(actions, 'Ours2')).toBe('magic');
    expect(retreatOf(actions)).toBeNull();
    expect(lines.some(l => l.startsWith(`THREAT Mage combat=120 style=magic by=weapon wild=16 single`) && l.includes(`weapon=${STAFF}`))).toBe(true);
    expect(lines.some(l => l === 'ADAPT protect Ours1 magic: Mage magic by weapon, 5 tiles')).toBe(true);
    const file = join(root, '.practice', 'threat-records', 'demo.example_43594', 'mage.jsonl');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]!)).toMatchObject({ schema: 'threat-sighting/1', name: 'Mage', combat: 120, style: 'magic', canHit: ['Ours1', 'Ours2'], at: 1000, tick: 5 });
});

test('one reading each tick for the squad: a second ask in the same tick is the same result', () => {
    const { w } = watch([MAGE], [9]);
    expect(w.step(7)).toBe(w.step(7));
    expect(w.step(8)).not.toBe(w.step(7));
});

test('an attack seen on the way in sets the style: a mage in a scimitar that casts is magic', () => {
    const { w } = watch([{ ...MAGE, weapon: SCIM, anim: CAST }], [9]);
    expect(w.step(5).classes[0]).toMatchObject({ style: 'magic', by: 'attack', cover: 'magic' });
});

test('act off: the watch logs and records and the squad is told nothing (the caller reads the act flag)', () => {
    const { w, lines } = watch([MAGE], [9], { act: false });
    w.step(5);
    expect(w.act).toBe(false);
    expect(lines.some(l => l.startsWith('ADAPT protect'))).toBe(true);
});

test('the targets of the squad are expected: protected against, never a retreat', () => {
    const gang = [{ ...MAGE, index: 9, name: 'A' }, { ...MAGE, index: 10, name: 'B', x: 3076 }, { ...MAGE, index: 11, name: 'C', x: 3076, z: 3643 }];
    expect(retreatOf(watch(gang, [9, 10, 11]).w.step(5).actions)).toContain('team of 3');
    const expected = watch(gang, [9, 10, 11], { expected: ['a', 'b', 'c'] }).w.step(5);
    expect(retreatOf(expected.actions)).toBeNull();
    expect(protectOf(expected.actions, 'Ours1')).toBe('magic');
});

test('holdProtect: other protect prayers off first, then the wanted one, one input each 3 ticks, by the prayer level', () => {
    const none = session('Ours1', ME1, [], []);
    holdProtect(none.s, 'magic', 4); expect(none.toggles).toEqual([]);
    holdProtect(none.s, 'magic', 6); expect(none.toggles).toEqual([12]);
    const wrong = session('Ours1', ME1, [], [], { active: Object.assign(Array(15).fill(false), { 14: true }) });
    holdProtect(wrong.s, 'ranged', 6); expect(wrong.toggles).toEqual([14]);
    const on = session('Ours1', ME1, [], [], { active: Object.assign(Array(15).fill(false), { 13: true }) });
    holdProtect(on.s, 'ranged', 6); expect(on.toggles).toEqual([]);
    const low = session('Ours1', ME1, [], [], { prayer: 30 });
    holdProtect(low.s, 'melee', 6); expect(low.toggles).toEqual([]);
});

test('a player in view with a bow: ranged cover for the members that it can hit, and nothing for a player that cannot hit them', () => {
    const { w } = watch([{ index: 9, name: 'Archer', combat: 90, x: 3075, z: 3644, weapon: BOW }], [9]);
    const { classes, actions } = w.step(5);
    expect(classes[0]).toMatchObject({ style: 'ranged', canHit: [], dangerous: false });
    expect(actions).toEqual([]);
});

test('a decision is logged once while only its distances change, and again when its style changes', () => {
    const { w, lines } = watch([MAGE], [9]);
    w.step(5);
    w.step(6);
    expect(lines.filter(l => l.startsWith('ADAPT protect Ours1'))).toHaveLength(1);
    const { w: w2, lines: lines2 } = watch([{ ...MAGE, anim: SHOOT }], [9]);
    w2.step(5);
    expect(lines2.filter(l => l.startsWith('ADAPT protect Ours1 ranged'))).toHaveLength(1);
});
