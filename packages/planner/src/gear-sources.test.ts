import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GearSources } from '../../knowledge/src/gear-sources';
import { gearById, selectProgressiveLoadout, shopCatalog } from './gear-progression';
import { GEAR_ASK_LIMIT, gearSources, valueOf, type SourceContext } from './gear-sources';

const CLIMBING_BOOTS = 3105, DRAGONFIRE_SHIELD = 1540, DRAGON_CHAINBODY = 3140, MAGIC_SHORTBOW = 861;
const ctx = (over: Partial<SourceContext> = {}): SourceContext => ({ skills: {}, done: new Set(), openShops: [], ...over });
const item = (id: number) => gearById(id)!;

test('Climbing boots are an npc sale for 12 coins only after Death Plateau', () => {
    expect(gearSources(item(CLIMBING_BOOTS), ctx()).some(s => s.kind === 'npc')).toBe(false);
    const after = gearSources(item(CLIMBING_BOOTS), ctx({ done: new Set(['Death Plateau']) }));
    const npc = after.find(s => s.kind === 'npc');
    expect(npc).toMatchObject({ kind: 'npc', npc: 'death_sherpa', cost: 12, gate: { quest: 'Death Plateau' } });
    expect(npc && npc.kind === 'npc' && npc.src).toBe('scripts/quests/quest_death/scripts/death_sherpa.rs2:22');
    expect(npc && npc.kind === 'npc' && npc.gate?.src).toBe('scripts/quests/quest_death/scripts/death_sherpa.rs2:2');
});

test('the Dragonfire shield is a free npc hand-out behind Dragon Slayer', () => {
    expect(gearSources(item(DRAGONFIRE_SHIELD), ctx()).some(s => s.kind === 'npc')).toBe(false);
    const got = gearSources(item(DRAGONFIRE_SHIELD), ctx({ done: new Set(['Dragon Slayer']) })).find(s => s.kind === 'npc');
    expect(got).toMatchObject({ kind: 'npc', npc: 'duke_of_lumbridge', cost: 0, gate: { quest: 'Dragon Slayer', src: 'scripts/areas/area_lumbridge/scripts/duke_horacio.rs2:4' } });
    expect(got && got.kind === 'npc' && got.src).toBe('scripts/areas/area_lumbridge/scripts/duke_horacio.rs2:63');
});

test('a market ask over GEAR_ASK_LIMIT times the content value is not a source', () => {
    const chain = item(DRAGON_CHAINBODY), limit = GEAR_ASK_LIMIT * chain.cost;
    expect(gearSources(chain, ctx({ market: { [chain.id]: { ask: limit + 1, sell: 2 } } })).some(s => s.kind === 'ge')).toBe(false);
    expect(gearSources(chain, ctx({ market: { [chain.id]: { ask: limit, sell: 2 } } })).some(s => s.kind === 'ge')).toBe(true);
    expect(gearSources(chain, ctx({ market: { [chain.id]: { ask: limit, sell: 0 } } })).some(s => s.kind === 'ge')).toBe(false);
    expect(gearSources(chain, ctx({ market: { [chain.id]: { ask: null, sell: 2 } } })).some(s => s.kind === 'ge')).toBe(false);
    // Dragon chainbody has no other source in the content, so it is the goal and never the want.
    const levels = { attack: 99, strength: 99, defence: 99, hitpoints: 99 };
    const quests = ['Dragon Slayer', "Heroes' Quest", "Legends' Quest", 'Lost City'];
    const body = selectProgressiveLoadout('melee', [], levels, quests, { market: { [chain.id]: { ask: 350_000_000, sell: 1 } }, questPoints: 200 }).upgrades.body;
    expect(body?.acquirableUpgrade?.item.id).not.toBe(chain.id);
    expect(body?.goal?.item.id).toBe(chain.id);
    expect(body?.goal?.sources.some(s => s.kind === 'ge')).toBe(false);
});

test('a market ask far under the item value, or an item with no recent trade, is not a source', () => {
    const staff = item(1389), cost = staff.cost; // Magic staff: a 1-coin ask never fills
    const ge = (market: SourceContext['market']) => gearSources(staff, ctx({ market })).some(s => s.kind === 'ge');
    expect(ge({ [staff.id]: { ask: 1, sell: 510 } })).toBe(false);
    expect(ge({ [staff.id]: { ask: Math.ceil(0.2 * cost) - 1, sell: 5 } })).toBe(false);
    expect(ge({ [staff.id]: { ask: Math.ceil(0.2 * cost), sell: 5 } })).toBe(true);
    expect(ge({ [staff.id]: { ask: cost, sell: 5, trades: 0 } })).toBe(false);
    expect(ge({ [staff.id]: { ask: cost, sell: 5, trades: 4 } })).toBe(true);
});

test('the Magic shortbow is a ge want with the market ask', () => {
    const levels = { ranged: 99, defence: 99 };
    const weapon = selectProgressiveLoadout('ranged', [], levels, [], { market: { [MAGIC_SHORTBOW]: { ask: 1500, sell: 2 } } }).upgrades.weapon;
    expect(weapon?.acquirableUpgrade?.item.id).toBe(MAGIC_SHORTBOW);
    expect(weapon?.acquirableUpgrade?.source).toEqual({ kind: 'ge', ask: 1500, sell: 2 });
    // With no ask the market is no source; the item is still obtainable by its craft or clue source, and it is the goal.
    const none = selectProgressiveLoadout('ranged', [], levels, [], { market: {} }).upgrades.weapon;
    expect(none?.goal?.item.id).toBe(MAGIC_SHORTBOW);
    expect(none?.goal?.sources.some(s => s.kind === 'ge')).toBe(false);
    expect(none?.acquirableUpgrade?.source.kind).not.toBe('ge');
});

test('every want has a source, and a free or shop item beats a market item of a slightly higher gain', () => {
    for (const style of ['melee', 'ranged', 'magic'] as const) {
        const upgrades = selectProgressiveLoadout(style, [], { attack: 60, strength: 60, defence: 60, ranged: 60, magic: 60 }, [], { questPoints: 32 }).upgrades;
        for (const u of Object.values(upgrades)) if (u?.acquirableUpgrade) expect(u.acquirableUpgrade.sources.length).toBeGreaterThan(0);
    }
    expect(valueOf(100, 0)).toBeGreaterThan(valueOf(110, 5_000));
    expect(valueOf(200, 50_000)).toBeGreaterThan(valueOf(100, 0) / 2);
});

test('the nearest shop that sells the item is the source when the account tile is known', () => {
    const sources = JSON.parse(readFileSync(resolve(import.meta.dir, '..', '..', '..', 'knowledge', 'gear-sources.json'), 'utf8')) as GearSources;
    const tiles = (shop: string) => sources.shopNpcs.filter(n => n.shop === shop).flatMap(n => n.spawns);
    const bronzePlatebody = item(1117);
    const open = (shopCatalog().get(bronzePlatebody.id) ?? []).filter(s => s.shop === 'topshop' || s.shop === 'armourshop');
    expect(open.length).toBe(2);
    for (const shop of ['topshop', 'armourshop']) {
        const at = tiles(shop)[0]!;
        const got = gearSources(bronzePlatebody, ctx({ openShops: open, position: at })).find(s => s.kind === 'shop');
        expect(got && got.kind === 'shop' && got.distance).toBe(0);
        expect(got && got.kind === 'shop' && got.tile).toBeDefined();
    }
});

test('quest, craft, drop and clue sources come from the content tables', () => {
    const kinds = (id: number, over?: Partial<SourceContext>) => new Set(gearSources(item(id), ctx(over)).map(s => s.kind));
    // Robin hood hat is a hard clue reward; the Unholy book is a reward of Horror from the Deep.
    const robin = kinds(2581);
    expect(robin.has('clue')).toBe(true);
    expect(gearSources(item(2581), ctx()).find(s => s.kind === 'clue')).toMatchObject({ tier: 'hard' });
    expect(gearSources(item(3842), ctx()).find(s => s.kind === 'quest')).toMatchObject({ quest: 'Horror from the Deep' });
    // A craft source is listed when the level is unknown or enough, and left out below the level the content gives.
    const hide = item(2503);
    expect(kinds(hide.id, { skills: { crafting: 99 } }).has('craft')).toBe(true);
    expect(kinds(hide.id, { skills: { crafting: 50 } }).has('craft')).toBe(false);
    expect(kinds(hide.id).has('craft')).toBe(true);
    expect(gearSources(item(1731), ctx()).find(s => s.kind === 'drop')).toMatchObject({ npc: 'kalphite_flyingqueen' }); // Amulet of power
});
