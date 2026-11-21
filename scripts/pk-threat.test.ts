import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { parsePack } from '../packages/knowledge/src/pack';
import { contentRoot } from '../packages/knowledge/src/paths';
import { attackStyleOfAnim, attackStyleOfSeq, holdProtect, KitSwapper, protectLevels, protectOf, readSighting, retreatOf, ThreatWatch, threatOptions } from './pk-threat';

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
function session(name: string, me: Fake, players: Fake[], view: number[], o: { prayer?: number; active?: boolean[]; worn?: number[]; pack?: number[] } = {}) {
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
            getEquipment: () => (o.worn ?? []).map(id => ({ id })), getInventory: () => (o.pack ?? []).map((id, slot) => ({ id, slot, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] })),
            getSkill: () => ({ level: o.prayer ?? 99 }), sendTogglePrayer: async (i: number) => { toggles.push(i); },
        },
    };
    return { s: s as never, toggles };
}

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ME1: Fake = { index: 1, name: 'Ours1', combat: 126, x: 3070, z: 3640 }, ME2: Fake = { index: 2, name: 'Ours2', combat: 126, x: 3072, z: 3640 };
const MAGE: Fake = { index: 9, name: 'Mage', combat: 120, x: 3075, z: 3644, weapon: STAFF };

function watch(players: Fake[], view: number[], o: { act?: boolean; expected?: string[]; worn?: number[]; pack?: number[]; multi?: boolean; outclass?: boolean; odds?: false; cooldown?: number; recordMaxBytes?: number; recordMaxFiles?: number } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'threat-')); roots.push(root);
    const a = session('Ours1', ME1, [ME2, ...players], view, o), b = session('Ours2', ME2, [ME1, ...players], view);
    const lines: string[] = [];
    const w = new ThreatWatch({ sessions: () => [a.s, b.s], server: 'demo.example:43594', friends: new Set(['ours1', 'ours2']), log: l => lines.push(l), recordRoot: root, act: o.act, cooldown: o.cooldown, recordMaxBytes: o.recordMaxBytes, recordMaxFiles: o.recordMaxFiles, odds: o.odds,
        decide: { expected: new Set(o.expected ?? []), ...(o.multi ? { multiAt: () => true, singleWayFrom: () => null } : {}), ...(o.outclass ? { outclasses: () => true } : {}) }, now: () => 1000 });
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
    // Three strangers against the two members of the fake squad outnumber it (members + 1), on multi-way or single-way ground.
    // (The counting rules: `odds: false`. The win-chance estimate counts the targets too: see the odds tests.)
    expect(retreatOf(watch(gang, [9, 10, 11], { multi: true, odds: false }).w.step(5).actions)).toContain('outnumbered: 3 attackers against 2 members');
    expect(retreatOf(watch(gang, [9, 10, 11], { odds: false }).w.step(5).actions)).toContain('outnumbered: 3 attackers against 2 members');
    const expected = watch(gang, [9, 10, 11], { expected: ['a', 'b', 'c'], multi: true, odds: false }).w.step(5);
    expect(retreatOf(expected.actions)).toBeNull();
    expect(protectOf(expected.actions, 'Ours1')).toBe('magic');
});

test('holdProtect: only the wanted protect prayer is sent (the server turns the others off), one input each 3 ticks, by the prayer level', () => {
    const none = session('Ours1', ME1, [], []);
    holdProtect(none.s, 'magic', 4); expect(none.toggles).toEqual([]);
    holdProtect(none.s, 'magic', 6); expect(none.toggles).toEqual([12]);
    const wrong = session('Ours1', ME1, [], [], { active: Object.assign(Array(15).fill(false), { 14: true }) });
    // Protect from Melee is on and Missiles is wanted: one input, Missiles (13); the server turns Melee off.
    holdProtect(wrong.s, 'ranged', 6); expect(wrong.toggles).toEqual([13]);
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

test('a mage and a pack with dragonhide: the watch decides the armour swap for the member that holds it', () => {
    const { w, lines } = watch([MAGE], [9], { worn: [1127, 1079], pack: [1135, 1099] });
    const kit = w.step(5).actions.filter(a => a.kind === 'kit');
    expect(kit).toEqual([{ kind: 'kit', member: 'Ours1', style: 'magic', wear: [1135, 1099], gain: 38, reason: 'Mage magic: wear 1135+1099 (+38)' }]);
    expect(lines.some(l => l.startsWith('ADAPT kit Ours1 magic: Mage magic: wear 1135+1099'))).toBe(true);
    // A squad with no spare armour has no swap.
    expect(watch([MAGE], [9], { worn: [1127, 1079], pack: [] }).w.step(5).actions.some(a => a.kind === 'kit')).toBe(false);
});

test('KitSwapper wears the swap once, keeps it while a threat needs it, and wears the worn armour again after 60 ticks without one', async () => {
    const used: number[] = [], lines: string[] = [];
    const s: any = { name: 'Ours1', sdk: { getEquipment: () => [{ id: 1127 }, { id: 1079 }], getInventory: () => [{ id: 1135, slot: 5, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, { id: 1127, slot: 6, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }], sendUseItem: async (slot: number) => { used.push(slot); } } };
    const kit: any[] = [{ kind: 'kit', member: 'Ours1', style: 'magic', wear: [1135], gain: 26, reason: 'Mage magic' }];
    const swapper = new KitSwapper(), tick = async () => true, log = (l: string) => lines.push(l);
    expect(await swapper.step(s, kit, 10, tick, log)).toBe(true);
    expect(used).toEqual([5]);
    expect(swapper.active).toBe(true);
    // Still needed: nothing to do, and the clock restarts.
    expect(await swapper.step(s, kit, 40, tick, log)).toBe(false);
    expect(await swapper.step(s, [], 99, tick, log)).toBe(false);
    expect(await swapper.step(s, [], 100, tick, log)).toBe(true);
    expect(used).toEqual([5, 6]);
    expect(swapper.active).toBe(false);
    expect(lines).toEqual(['[Ours1] threat kit swap: Mage magic', '[Ours1] threat kit restore: wear 1127']);
    // A kit action for another member is not ours.
    expect(await new KitSwapper().step(s, [{ ...kit[0], member: 'Ours2' }], 1, tick, log)).toBe(false);
});

test('a retreat stays decided until a member acts on it; then it is not decided again for the same stranger during the cooldown, and a new stranger causes one at once', () => {
    const view = [9];
    const { w, lines } = watch([MAGE, { ...MAGE, index: 10, name: 'Mage2' }], view, { outclass: true, odds: false });
    // Nobody acts (a member in a fight does not read it): the decision stays, tick after tick, and no cooldown starts.
    expect(retreatOf(w.step(5).actions)).toContain('outclassed by Mage');
    expect(retreatOf(w.step(100).actions)).toContain('outclassed by Mage');
    expect(retreatOf(w.step(400).actions)).toContain('outclassed by Mage');
    // A member acts at tick 400: the cooldown starts, and the decision stays 30 ticks for the other members.
    w.acted(400);
    expect(retreatOf(w.step(420).actions)).toContain('outclassed by Mage');
    // The squad comes back: the same stranger, inside the cooldown (600 ticks from tick 400): no retreat, and the protect prayer stays.
    const back = w.step(500);
    expect(retreatOf(back.actions)).toBeNull();
    expect(protectOf(back.actions, 'Ours1')).toBe('magic');
    expect(lines.filter(l => l === 'THREAT retreat held, cooldown: mage')).toHaveLength(1);
    // A second stranger that was not there: a retreat at once.
    view.push(10);
    expect(retreatOf(w.step(530).actions)).toContain('outclassed by');
    w.acted(530);
    // Both are cooled until 1130; a retreat only after that.
    view.length = 0; view.push(9);
    expect(retreatOf(w.step(1000).actions)).toBeNull();
    expect(retreatOf(w.step(1200).actions)).toContain('outclassed by Mage');
    // acted with nothing decided changes nothing.
    expect(() => new (w.constructor as new (...a: never[]) => typeof w)({ sessions: () => [], server: 'x', friends: new Set(), log: () => {} } as never).acted(1)).not.toThrow();
});

test('a record file moves aside at the size cap, and a full directory takes no new name', () => {
    const { w, lines, root } = watch([MAGE, { ...MAGE, index: 10, name: 'Other' }], [9], { recordMaxBytes: 400, recordMaxFiles: 1 });
    // One line each 25 ticks for 'Mage': the file passes 400 bytes after two lines, moves to .1, and a new file starts.
    for (let tick = 5; tick <= 5 + 25 * 6; tick += 25) w.step(tick);
    const dir = join(root, '.practice', 'threat-records', 'demo.example_43594');
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['mage.jsonl', 'mage.jsonl.1']);
    expect(readFileSync(join(dir, 'mage.jsonl.1'), 'utf8').length).toBeGreaterThanOrEqual(400);
    expect(readFileSync(join(dir, 'mage.jsonl'), 'utf8').length).toBeLessThan(800);
    // A second name when the directory holds its limit of one name: not recorded, said once.
    const view2 = watch([MAGE, { ...MAGE, index: 10, name: 'Other' }], [9, 10], { recordMaxFiles: 1 });
    view2.w.step(5); view2.w.step(40);
    expect(readdirSync(join(view2.root, '.practice', 'threat-records', 'demo.example_43594'))).toHaveLength(1);
    expect(view2.lines.filter(l => l.startsWith('THREAT record directory is full'))).toHaveLength(1);
    expect(lines.some(l => l.startsWith('THREAT record write failed'))).toBe(false);
});

test('the protect prayer levels come from the content: Magic 37, Missiles 40, Melee 43', () => {
    expect(protectLevels()).toEqual({ magic: 37, ranged: 40, melee: 43 });
});

test('the watch names the interlopers: dangerous players that are not the squad targets, and nobody else', () => {
    const view = [9, 10];
    const { w } = watch([MAGE, { ...MAGE, index: 10, name: 'Gang1' }], view, { expected: ['gang1'] });
    expect(w.step(5).interlopers).toEqual(['Mage']);
    view.length = 0;
    expect(w.step(6).interlopers).toEqual([]);
});

test('threatOptions: SQUAD_THREAT_OPTS over the environment settings, defaults, and a fail for an unknown key or a bad number', () => {
    const env = (values: Record<string, string>) => (name: string, fallback: string) => values[name] ?? fallback;
    expect(threatOptions('', env({}))).toEqual({ act: true, cooldown: 600, expectedTargets: true, odds: { lose: 0.9, protect: 0.6, pile: 0.7, theirFood: 10, singleWayMin: 1.5 } });
    // The environment settings.
    expect(threatOptions('', env({ SQUAD_THREAT_LOSE: '1.2', SQUAD_THREAT_ACT: '0', SQUAD_THREAT_EXPECTED: '0', SQUAD_THREAT_COOLDOWN: '300' }))).toEqual({ act: false, cooldown: 300, expectedTargets: false, odds: { lose: 1.2, protect: 0.6, pile: 0.7, theirFood: 10, singleWayMin: 1.5 } });
    // The JSON wins over the environment, key by key.
    const o = threatOptions('{"lose":1.5,"singleWayMin":2,"pile":0.5,"cooldown":100,"expected":false}', env({ SQUAD_THREAT_LOSE: '1.2', SQUAD_THREAT_PROTECT: '0.4' }));
    expect(o).toEqual({ act: true, cooldown: 100, expectedTargets: false, odds: { lose: 1.5, protect: 0.4, pile: 0.5, theirFood: 10, singleWayMin: 2 } });
    expect(threatOptions('{"odds":false}', env({})).odds).toBe(false);
    expect(threatOptions('', env({ SQUAD_THREAT_ODDS: '0' })).odds).toBe(false);
    expect(() => threatOptions('{"loose":1}', env({}))).toThrow('unknown key: loose');
    expect(() => threatOptions('{"lose":"x"}', env({}))).toThrow('lose is not a number');
    expect(() => threatOptions('{nope', env({}))).toThrow('not JSON');
    expect(() => threatOptions('[1]', env({}))).toThrow('not a JSON object');
});

test('KitSwapper: the swap stays while a threat of its style can still hit us (the protect action), though the kit action is gone, and is undone 60 ticks after both are gone', async () => {
    const used: number[] = [], lines: string[] = [];
    const s: any = { name: 'Ours1', sdk: { getEquipment: () => [{ id: 1127 }, { id: 1079 }], getInventory: () => [{ id: 1135, slot: 5, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }, { id: 1127, slot: 6, optionsWithIndex: [{ text: 'Wear', opIndex: 2 }] }], sendUseItem: async (slot: number) => { used.push(slot); } } };
    const kit: any[] = [{ kind: 'kit', member: 'Ours1', style: 'magic', wear: [1135], gain: 26, reason: 'Mage magic' }];
    const protect: any[] = [{ kind: 'protect', member: 'Ours1', style: 'magic', reason: 'Mage' }];
    const swapper = new KitSwapper(), tick = async () => true, log = (l: string) => lines.push(l);
    expect(await swapper.step(s, [...protect, ...kit], 10, tick, log)).toBe(true);
    // The armour is worn, so the kit action is gone; the mage is still there (a protect action of its style): no restore, however long.
    for (const now of [40, 100, 400]) expect(await swapper.step(s, protect, now, tick, log)).toBe(false);
    expect(swapper.active).toBe(true);
    // A protect action for another style, or for another member, is not the threat of the swap.
    expect(await swapper.step(s, [{ ...protect[0], style: 'melee' }], 459, tick, log)).toBe(false);
    expect(await swapper.step(s, [{ ...protect[0], style: 'melee' }], 460, tick, log)).toBe(true);
    expect(swapper.active).toBe(false);
    expect(used).toEqual([5, 6]);
});

test('with the win-chance estimate a lost fight against the squad targets alone has a cooldown too, and the counting rules still leave the targets out of it', () => {
    const gang = [{ ...MAGE, index: 9, name: 'A' }, { ...MAGE, index: 10, name: 'B', x: 3076 }, { ...MAGE, index: 11, name: 'C', x: 3076, z: 3643 }, { ...MAGE, index: 12, name: 'D', x: 3075, z: 3643 }];
    const view = [9, 10, 11, 12];
    const { w, lines } = watch(gang, view, { expected: ['a', 'b', 'c', 'd'] });
    expect(retreatOf(w.step(5).actions)).toContain('lost fight');
    w.acted(5);
    // The squad comes back to the same gang inside the cooldown: no retreat, said once.
    expect(retreatOf(w.step(200).actions)).toBeNull();
    expect(lines.filter(l => l.startsWith('THREAT retreat held, cooldown:'))).toHaveLength(1);
    // After the cooldown (600 ticks from the act) the fight is left again.
    expect(retreatOf(w.step(700).actions)).toContain('lost fight');
});

test('acting on single-way cools single-way without blocking an escalation to retreat during cooldown', () => {
    let multi = false;
    const enemies = [MAGE, { ...MAGE, index: 10, name: 'Mage2' }, { ...MAGE, index: 11, name: 'Mage3' }];
    const root = mkdtempSync(join(tmpdir(), 'threat-')); roots.push(root);
    const a = session('Ours1', ME1, [ME2, ...enemies], [9, 10, 11]), b = session('Ours2', ME2, [ME1, ...enemies], [9, 10, 11]);
    const w = new ThreatWatch({
        sessions: () => [a.s, b.s], server: 'demo.example:43594', friends: new Set(['ours1', 'ours2']),
        log: () => {}, recordRoot: root, odds: false,
        decide: { expected: new Set(), outnumberedBy: 2, multiAt: () => true, singleWayFrom: () => multi ? null : { x: 3072, z: 3640 }, outclasses: () => false },
    });
    expect(w.step(10).actions.some(x => x.kind === 'single-way')).toBe(true);
    w.acted(10);
    // Escalate to retreat immediately when no single-way tile exists inside the 600-tick cooldown.
    multi = true;
    expect(retreatOf(w.step(20).actions)).toBeTruthy();
    w.acted(20);
    // Retreats cool down for 600 ticks once retreat is acted on.
    expect(retreatOf(w.step(100).actions)).toBeNull();
});

test('refineProtectActions prioritizes reachable threats targeting the member over out-of-range melee attacks', () => {
    const BOW_ID = idOf('obj', 'magic_shortbow');
    const FAR_HYBRID: Fake = { index: 9, name: 'Hybrid', combat: 126, x: 3078, z: 3640, weapon: SCIM };
    const MAGE_ON_ME: Fake = { index: 10, name: 'MageThreat', combat: 126, x: 3074, z: 3643, weapon: STAFF, anim: CAST };
    const root = mkdtempSync(join(tmpdir(), 'threat-refine-')); roots.push(root);
    const a = session('Ours1', ME1, [ME2, FAR_HYBRID, MAGE_ON_ME], [9, 10]);
    const b = session('Ours2', ME2, [ME1, FAR_HYBRID, MAGE_ON_ME], [9, 10]);
    const w = new ThreatWatch({
        sessions: () => [a.s, b.s], server: 'demo.example:43594', friends: new Set(['ours1', 'ours2']),
        log: () => {}, recordRoot: root, odds: false, decide: { expected: new Set(['hybrid', 'magethreat']), outclasses: () => false },
    });
    // Tick 5: Hybrid at 8 tiles holding melee weapon cannot hit Ours1 in melee, while MageThreat is casting magic in range (dist 3 from Ours2 -> dangerous).
    const step5 = w.step(5);
    expect(protectOf(step5.actions, 'Ours1')).toBe('magic');
    // Hybrid swings melee on tick 6 while another account makes it dangerous, then equips Magic Shortbow at 8 tiles targeting Ours1.
    const slots = ((a.s as any).client.players as any[]);
    slots[9] = { name: 'Hybrid', combatLevel: 126, headicons: 0, appearance: [0, 0, 0, 0x200 + SCIM], primaryAnim: idOf('seq', 'human_ddagger_lunge'), spotanimId: -1 };
    w.step(6);
    slots[9] = { name: 'Hybrid', combatLevel: 126, headicons: 0, appearance: [0, 0, 0, 0x200 + BOW_ID], primaryAnim: -1, spotanimId: -1 };
    const curState = (a.s as any).sdk.getState;
    (a.s as any).sdk.getState = () => {
        const base = curState();
        base.nearbyPlayers = base.nearbyPlayers.map((q: any) => q.index === 9 ? { ...q, combatTargetType: 'player', combatTargetIndex: 1 } : q);
        return base;
    };
    const step7 = w.step(7);
    expect(protectOf(step7.actions, 'Ours1')).toBe('ranged');
});
