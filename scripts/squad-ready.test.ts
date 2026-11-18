import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateOwnedKit } from './microbot-owned-loadout';
import { accountOf, loadoutOf, meetNear, orderCommands, pickKit, report, RULES, shopSource, stagingPlan, type Account, type Gear, type Item, type Shop, type Worn } from './squad-ready';

const root = join(import.meta.dir, '..');
const gear = new Map((JSON.parse(readFileSync(join(root, 'knowledge', 'gear.json'), 'utf8')) as Gear[]).map(g => [g.id, g]));
const shops = JSON.parse(readFileSync(join(root, 'knowledge', 'shops.json'), 'utf8')) as Shop[];
const rule = RULES['gang-chain-bind']!, NOW = 1_800_000_000_000, HOUR = 3_600_000;
const name = (id: number) => gear.get(id)?.name ?? ({ 385: 'Shark', 175: 'Antipoison(3)', 563: 'Law rune', 556: 'Air rune', 557: 'Earth rune', 555: 'Water rune', 561: 'Nature rune', 72: 'Magic shortbow', 379: 'Lobster' } as Record<number, string>)[id] ?? `item ${id}`;
const it = (id: number, count = 1): Item => ({ id, name: name(id), count });
const worn = (id: number, slot: number, count = 1): Worn => ({ ...it(id, count), slot });
const MAXED = { attack: 99, strength: 99, defence: 99, ranged: 99, magic: 99, prayer: 99, hitpoints: 99 };
const account = (n: string, o: Partial<Account> = {}): Account => ({ name: n, at: NOW, bankAt: NOW - HOUR, pos: { x: 3094, z: 3491, level: 0 }, levels: MAXED, quests: new Set(['lost city']), worn: [], pack: [], bank: [], ...o });
// Rune full helm 1163, rune chainbody 1113, rune platelegs 1079, amulet of power 1731, dragon dagger 1215, magic
// shortbow 861, iron arrow 884.
const KIT_WORN = [worn(1163, 0), worn(1731, 2), worn(1215, 3), worn(1113, 4), worn(1079, 7), worn(884, 13, 300)];
const KIT_PACK = [it(861), it(175), it(563, 2), it(556, 10), it(557, 30), it(555, 30), it(561, 20)];
const full = (n: string, o: Partial<Account> = {}) => account(n, { worn: KIT_WORN, pack: KIT_PACK, bank: [it(385, 60)], ...o });
const without = (rows: readonly Item[], ...ids: number[]) => rows.filter(r => !ids.includes(r.id));

describe('pickKit', () => {
    test('an account that holds the bench kit is ready', () => {
        const p = pickKit(full('A'), gear, rule, NOW);
        expect(p.reasons).toEqual([]);
        expect(p.ready).toBe(true);
        expect(p.styles.sort()).toEqual(['melee', 'ranged']);
        expect([p.special, p.escape, p.freeze]).toEqual(['melee', 'Camelot Teleport', 'Bind']);
        expect([p.foodSlots, p.food, p.foodHeld]).toEqual([20, 20, 60]);
        expect(p.worn.find(w => w.slot === 13)).toMatchObject({ id: 884, count: 300 });
    });
    test('the pack of a bank trip holds the antipoison by its doses and the arrows at their count', () => {
        const p = pickKit(full('A'), gear, rule, NOW);
        expect(p.pack.items).toContainEqual({ id: 2446, count: 1, minDoses: 1, maxSlots: 1 });
        expect(p.pack.items).toContainEqual({ id: 884, count: 300 });
        expect(p.pack.food).toBe(20);
    });
    test('no leg armour, or green dragonhide chaps, blocks', () => {
        for (const legs of [[], [worn(1099, 7)]]) {
            const p = pickKit(full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 7), ...legs] }), gear, rule, NOW);
            expect(p.ready).toBe(false);
            expect(p.reasons).toEqual(['no leg armour (melee defence 74 or more)']);
        }
        const adamant = pickKit(full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 7), worn(1073, 7)] }), gear, rule, NOW);
        expect(adamant.ready).toBe(true);
        expect(adamant.notes).toContain("Adamant platelegs is weaker than the bench kit's Rune platelegs");
    });
    test('a rune platebody is no body armour without Dragon Slayer', () => {
        const p = pickKit(full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 4), worn(1127, 4)] }), gear, rule, NOW);
        expect(p.reasons).toEqual(['no body armour (melee defence 107 or more)']);
        const done = pickKit(full('A', { quests: new Set(['lost city', 'dragon slayer']), worn: [...KIT_WORN.filter(w => w.slot !== 4), worn(1127, 4)] }), gear, rule, NOW);
        expect(done.worn.find(w => w.slot === 4)?.id).toBe(1127);
    });
    test('a dragon dagger is no weapon without Lost City, and a rune scimitar is one', () => {
        expect(pickKit(full('A', { quests: new Set() }), gear, rule, NOW).reasons).toEqual(['no melee weapon with a special attack or a rune blade']);
        const p = pickKit(full('A', { quests: new Set(), bank: [it(385, 60), it(1333)] }), gear, rule, NOW);
        expect([p.ready, p.worn.find(w => w.slot === 3)?.id, p.special]).toEqual([true, 1333, 'ranged']);
    });
    test('no law rune: no escape teleport', () => {
        const p = pickKit(full('A', { pack: without(KIT_PACK, 563) }), gear, rule, NOW, undefined, name);
        expect(p.escape).toBeNull();
        expect(p.reasons).toEqual(['no Law rune (2 short)']);
    });
    test('one cast of each spell passes, with the rest wanted', () => {
        const p = pickKit(full('A', { pack: [...without(KIT_PACK, 563, 556, 557), it(563, 1), it(556, 5), it(557, 3)] }), gear, rule, NOW, undefined, name);
        expect(p.ready).toBe(true);
        expect(p.needs.map(n => [n.what, n.count, n.blocking])).toEqual([['Law rune', 1, false], ['Air rune', 5, false], ['Earth rune', 27, false]]);
    });
    test('no water rune: no Bind', () => {
        const p = pickKit(full('A', { pack: without(KIT_PACK, 555) }), gear, rule, NOW, undefined, name);
        expect([p.freeze, p.reasons]).toEqual([null, ['no Water rune (30 short)']]);
    });
    test('an unstrung magic shortbow is no bow', () => {
        const p = pickKit(full('A', { pack: [...without(KIT_PACK, 861), it(72)] }), gear, rule, NOW);
        expect(p.reasons).toEqual(['no bow']);
        expect(p.notes.join(' ')).toContain('unstrung Magic shortbow (item 72)');
    });
    test('bronze arrows pass with iron arrows wanted, and few arrows block', () => {
        const bronze = pickKit(full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 13), worn(882, 13, 300)] }), gear, rule, NOW);
        expect(bronze.ready).toBe(true);
        expect(bronze.needs.map(n => [n.what, n.count, n.blocking])).toEqual([['Iron arrow', 300, false]]);
        const few = pickKit(full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 13), worn(884, 13, 60)] }), gear, rule, NOW);
        expect(few.reasons).toEqual(['no arrows that a Magic shortbow fires (300 short)']);
    });
    test('no antipoison, few sharks, an old bank read and West Ardougne each block', () => {
        expect(pickKit(full('A', { pack: without(KIT_PACK, 175) }), gear, rule, NOW).reasons).toEqual(['no antipoison']);
        expect(pickKit(full('A', { bank: [it(385, 12)] }), gear, rule, NOW).reasons).toEqual(['no food (shark or lobster) (8 short)']);
        expect(pickKit(full('A', { bank: [it(385, 5), it(379, 6)] }), gear, rule, NOW).reasons).toEqual(['no food (shark or lobster) (9 short)']);
        expect(pickKit(full('A', { bankAt: NOW - 56 * HOUR }), gear, rule, NOW).reasons).toEqual(['bank read 56.0 h old (limit 6 h)']);
        expect(pickKit(full('A', { pos: { x: 2555, z: 3324, level: 0 } }), gear, rule, NOW).reasons).toEqual(['stands inside West Ardougne, which the walker cannot leave']);
    });
    test('lobsters fill the food slots that the sharks leave, as the bank trip takes them', () => {
        const lobsters = pickKit(full('A', { bank: [it(379, 500)] }), gear, rule, NOW);
        expect([lobsters.ready, lobsters.food, lobsters.foodHeld, lobsters.foodRows]).toEqual([true, 20, 500, [{ id: 379, name: 'Lobster', count: 20 }]]);
        const mixed = pickKit(full('A', { bank: [it(379, 100), it(385, 12)] }), gear, rule, NOW);
        expect([mixed.ready, mixed.foodRows, mixed.pack.food]).toEqual([true, [{ id: 385, name: 'Shark', count: 12 }, { id: 379, name: 'Lobster', count: 8 }], 20]);
        expect(mixed.foodStock).toEqual([{ id: 385, name: 'Shark', count: 12 }, { id: 379, name: 'Lobster', count: 100 }]);
        const kit = loadoutOf(mixed, { x: 3094, z: 3491 });
        expect(() => validateOwnedKit(kit)).not.toThrow();
        expect(kit.pack.slice(-2)).toEqual([{ id: 385, count: 12 }, { id: 379, count: 8 }]);
        // Sharks alone, as before: one row.
        expect(pickKit(full('A'), gear, rule, NOW).foodRows).toEqual([{ id: 385, name: 'Shark', count: 20 }]);
    });
    test('the loadout of a ready account is a valid owned kit', () => {
        const kit = loadoutOf(pickKit(full('A'), gear, rule, NOW), { x: 3094, z: 3491 });
        expect(() => validateOwnedKit(kit)).not.toThrow();
        expect(kit.pack).toContainEqual({ id: 385, count: 20 });
        expect(kit.wear).toContainEqual({ id: 884, count: 300, slot: 13 });
    });
});

describe('stagingPlan', () => {
    test('the nearest donor with a spare piece in its bank fills a need', () => {
        const a = full('A', { pack: without(KIT_PACK, 175) });
        const far = account('Far', { pos: { x: 2655, z: 3283, level: 0 }, bank: [it(175, 2)] }), near = account('Near', { pos: { x: 3185, z: 3436, level: 0 }, bank: [it(175, 1)] });
        const plan = stagingPlan([a], [a, far, near], gear, rule, NOW);
        expect(plan.moves.map(m => [m.from, m.to, m.item, m.count, m.blocking])).toEqual([['Near', 'A', 'Antipoison(3)', 1, true]]);
        expect(plan.gaps).toEqual([]);
    });
    test('one piece goes to one account, and the second account has a gap', () => {
        const a = full('A', { pack: without(KIT_PACK, 175) }), b = full('B', { pack: without(KIT_PACK, 175) });
        const donor = account('Donor', { bank: [it(175, 1)] });
        const plan = stagingPlan([a, b], [a, b, donor], gear, rule, NOW);
        expect(plan.moves.map(m => m.to)).toEqual(['A']);
        expect(plan.gaps).toEqual([{ account: 'B', what: 'antipoison', id: 175, count: 1, blocking: true }]);
    });
    test('a donor keeps what it wears and carries, and a candidate keeps its sharks and runes', () => {
        const a = full('A', { worn: KIT_WORN.filter(w => w.slot !== 7), bank: [it(385, 5)] });
        const wearer = account('Wearer', { worn: [worn(1079, 7)], pack: [it(385, 28)] }), other = full('B', { bank: [it(385, 200), it(1079, 1)] });
        const plan = stagingPlan([a, other], [a, wearer, other], gear, rule, NOW);
        expect(plan.moves.map(m => [m.from, m.item])).toEqual([['B', 'Rune platelegs']]);
        expect(plan.gaps).toEqual([{ account: 'A', what: 'food (shark or lobster)', id: 385, count: 15, blocking: true }]);
    });
    test('a donor inside West Ardougne or with an old bank read gives nothing', () => {
        const a = full('A', { pack: without(KIT_PACK, 175) });
        const walled = account('Walled', { pos: { x: 2555, z: 3324, level: 0 }, bank: [it(175, 1)] }), old = account('Old', { bankAt: NOW - 200 * HOUR, bank: [it(175, 1)] });
        expect(stagingPlan([a], [a, walled, old], gear, rule, NOW).moves).toEqual([]);
    });
    test('a wanted supply comes from one donor that covers it, or stays a gap', () => {
        const a = full('A', { worn: [...KIT_WORN.filter(w => w.slot !== 13), worn(884, 13, 200)] });
        const small = account('Small', { bank: [it(884, 60)] }), big = account('Big', { pos: { x: 2655, z: 3283, level: 0 }, bank: [it(884, 500)] });
        expect(stagingPlan([a], [a, small], gear, rule, NOW)).toMatchObject({ moves: [], gaps: [{ account: 'A', what: 'Iron arrow', count: 100, blocking: false }] });
        expect(stagingPlan([a], [a, small, big], gear, rule, NOW).moves.map(m => [m.from, m.count])).toEqual([['Big', 100]]);
    });
    test('the order commands hold one trade for each pair, at the bank near the receiver', () => {
        const a = full('A', { pack: without(KIT_PACK, 175, 563) });
        const donor = account('Donor', { bank: [it(175, 1), it(563, 9)] });
        const plan = stagingPlan([a], [a, donor], gear, rule, NOW, undefined, name);
        const orders = orderCommands(plan.moves, () => a.pos);
        expect(orders.map(o => o.command)).toEqual(['MEET=edgeville TAKER_WAITS=1 bun scripts/fleet-order.ts Donor A 1 Antipoison(3) --with "2 Law rune"']);
        expect(meetNear({ x: 2655, z: 3283 }).bank).toBe('ardougne-south');
    });
    test('the report names the verdict, the kit and each source', () => {
        const a = full('A', { pack: without(KIT_PACK, 175) }), b = full('B');
        const plan = stagingPlan([a, b], [a, b], gear, rule, NOW);
        const lines = report(plan, [a, b], rule, NOW, gap => `source of ${gap.id}`);
        expect(lines[0]).toStartWith('NOT READY A  at 3094,3491  bank read 1.0 h ago');
        expect(lines).toContain('  blocked  no antipoison');
        expect(lines).toContain('  missing  1 antipoison <- no owned spare: source of 175');
        expect(lines.at(-1)).toBe('SQUAD_READY rule=gang-chain-bind ready=B notReady=A');
    });
});

describe('sources', () => {
    test('the jungle store stocks the 3-dose antipoison and a shop-buyer profile buys it', () => {
        expect(shopSource('Antipoison(3)', '3doseantipoison', shops)).toBe('shop-buyer profile jiminua (junglestore, shelf 10)');
    });
    test('a shop item with no profile line is named as that', () => {
        expect(shopSource('Dragon dagger', 'dragon_dagger', shops)).toBe('dragonswordshop stocks 2: no shop-buyer profile line');
        expect(shopSource('Shark', 'shark', shops)).toBeNull();
    });
    test('a status file becomes an account, with a noted item as its plain item', () => {
        const a = accountOf({ name: 'A', at: 5, bankAt: 4, pos: { x: 1, z: 2, level: 0 }, skills: [{ name: 'Magic', level: 45 }], quests: [{ name: 'Lost City', state: 'complete' }, { name: 'Dragon Slayer', state: 'started' }],
            equipment: [{ slot: 3, id: 1215, baseId: 1215, name: 'Dragon dagger', count: 1 }], inventory: [{ id: 386, baseId: 385, name: 'Shark', count: 40, slot: 0 }], bank: [{ id: 563, baseId: 563, name: 'Law rune', count: 3 }] }, { side: 'local', reservation: 'task-1' })!;
        expect([a.levels.magic, [...a.quests], a.pack, a.reservation]).toEqual([45, ['lost city'], [{ id: 385, name: 'Shark', count: 40 }], 'task-1']);
        expect(accountOf({ name: 'B' })).toBeNull();
    });
});
