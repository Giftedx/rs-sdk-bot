import { expect, test } from 'bun:test';
import { questSweepCoins, questSweepNeeds, spentAtEveryStage } from '../../workers/src/quest/bank-needs';
import type { AccountState, ActivityDefinition, GoalDemand, WorldSnapshot } from '../src/contracts';
import { createActivityCatalog } from '../src/catalog';
import { planAccount, xpForLevel } from '../src/planner';
import { activityPreflightFromConfig } from '../src/preflight';

// The quest sweep ends "missing <id>:<count>" for a preset item that it can take only from the bank: prayer potions
// (2434) for the Mage Arena, rune essence (1436) for Priest in Peril, and a redberry pie (2325), which no shop sells,
// for The Knight's Sword.

const NOW = 1_700_000_000_000;
const level = (n: number) => ({ level: n, xp: xpForLevel(n) });
const catalog = createActivityCatalog();
const quest = (slug: string): ActivityDefinition => {
    const act = catalog.get(`quest:${slug}`);
    if (!act) throw Error(`no catalog activity quest:${slug}`);
    return act;
};

function makeAcct(overrides: Partial<AccountState> = {}): AccountState {
    return {
        name: 'QuestBot',
        side: 'local',
        role: 'auto',
        protectedClock: false,
        lifecycle: 'idle',
        skills: {
            Attack: level(40), Strength: level(40), Defence: level(40), Hitpoints: level(40),
            Prayer: level(1), Magic: level(60), Ranged: level(1), Mining: level(20), Smithing: level(20), Cooking: level(20),
        },
        quests: {},
        pos: { x: 3222, z: 3218, level: 0 },
        inventory: {},
        equipment: {},
        bank: { items: { 995: 200_000 }, observedAt: NOW - 10_000, trusted: true },
        ...overrides,
    };
}

const worldOf = (acct: AccountState): WorldSnapshot => ({ schemaVersion: 1, at: NOW, side: 'local', server: 'rs-sdk-demo.fly.dev', accounts: { [acct.name]: acct } });
const questDemand = (slug: string): GoalDemand => ({
    id: `goal:quest_board:${slug}`,
    goalKind: 'quest_board',
    valueScore: 300,
    valuePerHour: 1000,
    target: { kind: 'quest', questSlug: slug },
    fulfilled: 0,
    remaining: 1,
    priorityWeight: 1,
    active: true,
});
const missing = (acct: AccountState, slug: string) =>
    activityPreflightFromConfig(acct, quest(slug), worldOf(acct), 1).blockers.flatMap((b) => (b.kind === 'missing_supply' ? [`${b.itemId}:${b.required}`] : []));

test('the sweep needs list names each preset item that no shop sells and no gather plan covers', () => {
    const lv = (n: number) => () => n;
    expect(questSweepNeeds('magearena', lv(1)).bank).toContainEqual(expect.objectContaining({ id: 2434, count: 4 }));
    expect(questSweepNeeds('priestperil', lv(1)).bank).toContainEqual(expect.objectContaining({ id: 1436, count: 23 }));
    const squire = questSweepNeeds('squire', lv(1));
    expect(squire.bank).toContainEqual(expect.objectContaining({ id: 2325, count: 1 }));
    // A shop sells the rune pickaxe: the sweep buys it, so it is a coin need and no bank need.
    expect(squire.bank.some((i) => i.id === 1275)).toBe(false);
    expect(squire.shop).toContainEqual(expect.objectContaining({ id: 1275, count: 1 }));
    // Food and runes are optional: the sweep stages what the bank holds.
    expect(questSweepNeeds('priestperil', lv(1)).bank.some((i) => [554, 556, 563].includes(i.id))).toBe(false);
});

test('a started journal keeps an item that the quest spends only at a later stage', () => {
    // squire spends the pie from stage 3 (resume.ts QUEST_RESUME.squire.spent); a stage-2 account still needs it.
    expect(spentAtEveryStage('squire')).toEqual([]);
    expect(questSweepNeeds('squire', () => 1, true).bank).toContainEqual(expect.objectContaining({ id: 2325, count: 1 }));
});

test('levels that the sweep reads change the needs: Prayer covers the potions of a fire quest', () => {
    // prayerCovers: Tree Gnome Village uses 64 prayer points; 64 + 15 covers it.
    expect(questSweepNeeds('tree', () => 1).bank.some((i) => i.id === 2434)).toBe(true);
    expect(questSweepNeeds('tree', (s) => (s === 'Prayer' ? 79 : 1)).bank.some((i) => i.id === 2434)).toBe(false);
});

test('the coin need is the preset coins and the shop price of the shop items that the account lacks', () => {
    const squire = questSweepNeeds('squire', () => 1);
    const none = () => 0;
    const lacking = questSweepCoins(squire, none);
    expect(lacking).toBeGreaterThan(squire.coins);
    expect(questSweepCoins(squire, (id) => (squire.shop.some((s) => s.id === id) ? 99 : 0))).toBe(squire.coins);
});

test('the coin need holds the NPC fees of a lacking gather item, the Heckel dust price and the boat fares', () => {
    // Goblin Diplomacy: Wyson's woad leaves and Aggie's dye make the blue dye (1767) for 25 coins (NPC_SOURCES).
    const gobdip = questSweepNeeds('gobdip', () => 30);
    expect(gobdip.fees).toContainEqual(expect.objectContaining({ for: 1767, forCount: 1, coins: 25 }));
    const shopItems = (id: number) => (gobdip.shop.some((s) => s.id === id) ? 99 : 0);
    expect(questSweepCoins(gobdip, (id) => shopItems(id) || (id === 1769 ? 1 : 0))).toBe(gobdip.coins + 25);
    expect(questSweepCoins(gobdip, (id) => shopItems(id) || (id === 1769 || id === 1767 ? 1 : 0))).toBe(gobdip.coins);
    // The Plague City chocolate dust is Heckel's, 106 coins (sweep-plan.ts HECKEL_DUST), not a shop item.
    const elena = questSweepNeeds('elena', () => 30);
    expect(elena.shop.some((s) => s.id === 1975)).toBe(false);
    expect(elena.fees).toContainEqual(expect.objectContaining({ for: 1975, coins: 106 }));
    // A boat fare (60) from west of the White Wolf Mountain to a start tile east of it (sweep-plan.ts fares).
    const lowSkills = { attack: 30, strength: 30, defence: 30, hitpoints: 30 };
    const all = () => 99;
    const ardougne = { x: 2655, z: 3283, level: 0 };
    expect(questSweepCoins(gobdip, all, ardougne, lowSkills) - questSweepCoins(gobdip, all)).toBe(60);
    expect(questSweepCoins(gobdip, all, { x: 3185, z: 3436, level: 0 }, lowSkills)).toBe(questSweepCoins(gobdip, all));
});

test('a quest preflight raises missing_supply for each bank-only item the account lacks', () => {
    const acct = makeAcct();
    expect(missing(acct, 'magearena')).toEqual(['2434:4']);
    expect(missing(acct, 'priestperil')).toEqual(['1436:23']);
    expect(missing(acct, 'squire')).toEqual(['2325:1', '2351:2']);
    const stocked = makeAcct({ bank: { items: { 995: 200_000, 2434: 4, 1436: 23, 2325: 1, 2351: 2 }, observedAt: NOW - 10_000, trusted: true } });
    expect(missing(stocked, 'magearena')).toEqual([]);
    expect(missing(stocked, 'priestperil')).toEqual([]);
    expect(missing(stocked, 'squire')).toEqual([]);
    // A started Knight's Sword (stage unknown to the brain) still needs the pie.
    expect(missing(makeAcct({ quests: { "The Knight's Sword": 'started' } }), 'squire')).toEqual(['2325:1', '2351:2']);
    // A complete quest needs nothing.
    expect(missing(makeAcct({ quests: { "The Knight's Sword": 'complete' } }), 'squire')).toEqual([]);
});

test('a quest preflight asks for the coins that the sweep takes for its shop buys, with no operating float', () => {
    const poor = makeAcct({ bank: { items: { 995: 10, 2325: 1, 2351: 2 }, observedAt: NOW - 10_000, trusted: true } });
    const coins = activityPreflightFromConfig(poor, quest('squire'), worldOf(poor), 1).blockers.find((b) => b.kind === 'missing_coins');
    expect(coins?.kind === 'missing_coins' && coins.required).toBe(questSweepCoins(questSweepNeeds('squire', () => 20), () => 0));
    const withPick = makeAcct({ bank: { items: { 995: 10, 2325: 1, 2351: 2, 1275: 1 }, observedAt: NOW - 10_000, trusted: true } });
    expect(activityPreflightFromConfig(withPick, quest('squire'), worldOf(withPick), 1).ok).toBe(true);
});

test('the planner chains a purchase of a missing quest item before the quest', () => {
    // 6 sharks meet the Priest in Peril fight floor (catalog.ts QUEST_FIGHT_FLOORS), so only the quest item is bought.
    const acct = makeAcct({ bank: { items: { 995: 200_000, 385: 6 }, observedAt: NOW - 10_000, trusted: true } });
    const plan = planAccount(acct, {
        world: worldOf(acct),
        activities: [quest('priestperil')],
        demands: [questDemand('priestperil')],
        marketQuotes: { 1436: { ask: 53, sell: 166_029, trades: 113 } },
    });
    expect(plan.steps.map((s) => s.stepKind)).toEqual(['acquire', 'work']);
    const [acquire, work] = plan.steps;
    if (acquire?.stepKind !== 'acquire' || work?.stepKind !== 'work') throw Error('unexpected plan shape');
    expect(acquire.itemId).toBe(1436);
    expect(acquire.quantity).toBe(23);
    expect(acquire.source).toBe('ge');
    expect(acquire.stockTarget).toBe(23);
    expect(work.activityId).toBe('quest:priestperil');
});

test('the planner refuses a quest by name when no source has the missing item', () => {
    // No shop, no GE quote and no catalog activity makes a redberry pie.
    const acct = makeAcct({ quests: { "The Knight's Sword": 'started' }, bank: { items: { 995: 200_000, 2351: 2 }, observedAt: NOW - 10_000, trusted: true } });
    const plan = planAccount(acct, { world: worldOf(acct), activities: [quest('squire')], demands: [questDemand('squire')], marketQuotes: {} });
    expect(plan.steps).toEqual([]);
    expect(plan.idleReason).toContain('unresolvable_supply:2325');
});
