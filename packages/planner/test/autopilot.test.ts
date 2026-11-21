import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alchSupplies } from '../src/alch-plan';
import { orderRefusal } from '../../core/src/order-refusal';
import { DRAIN_RESULT } from '../src/autopilot';
import { AIR_STOCK, NATURE_STOCK, ARROW_LOW, ARROW_STOCK, FEATHER_STOCK, FIRE_STOCK, BONE_KEEP, BONE_PURSE, BONE_SKILL, BONE_START, LOWE_STOCK, WEAPON, WEAPON_HELD, WEAPON_MARKET, AIO_PLACES, TRAIN_SHARE, aioTemplates, combatLevel, CAPACITY, STRIKE_TILE, COW_BANDS, COW_FIELD_CAPACITY, TROOPER_FIELD_CAPACITY, FEATHER_TARGET, KNIGHT_SHARE, KNIGHT_SPOTS, SHARED, recoveringOwnerJobs, accountFrom, assess, catalogue, freshest, claimFor, finishedTrainers, jobFor, jobResources, knightCoinsPerTick, mergeJobs, pairKey, plan, plannableAccounts, reservedResources, unitValue, CHICKEN_PENS, PEN_QUEST_POINTS, type Acct, type Inputs, type Template } from '../src/autopilot';
import { PILOT_FALLBACK_SHARE, selfServePilot, GEM_RINGS, MAKE_BATCH, RING_BATCH, RUNE_ARROW_COST, RUNE_ARROW_SPEND, SPECIALIST_STAGE_BILLS, specialistStagingNeeds, buildBand, STEW_BATCH, UNF_POTIONS, makerChains, priceTable, norm, usableTool } from '../src/autopilot';

const side = 'claude-cloud';
// A fixture that can pick the knights (Thieving 55) has 20 Hitpoints, so the frail rule of the goldfarm job
// (GOLDFARM_FRAIL) does not apply to it. A test of that rule gives its own Hitpoints.
// Named bone stock in these fixtures is normal stock. Observation tests supply exact item ids through accountFrom.
const acct = (name: string, skills: Record<string, number> = {}, items: Record<string, number> = {}, s = side): Acct => ({ name, side: s, skills: { Hitpoints: (skills.Thieving ?? 1) >= 55 ? 20 : 10, ...skills }, currentHP: skills.Hitpoints ?? ((skills.Thieving ?? 1) >= 55 ? 20 : 10), items: { ...('bone' in items ? { 'bone (unnoted)': items.bone } : {}), ...items } });
const row = (item: string, short: number) => ({ item, need: short, owned: 0, short, ids: [1], holders: [] });
const prices = { feather: 2, 'headless arrow': 1, lobster: 150, 'fire rune': 4, 'air rune': 4, 'earth rune': 4, 'rune arrowtip': 200, 'adamant arrowtip': 80, 'arrow shaft': 1 };
const bill = [row('feathers', 800), row('headless arrows', 3615), row('lobster', 610), row('fire rune', 2000)];
// These cases test admission, ownership and shared resources with a finite route funding request. Cases about
// whether work has a consumer supply their own bill; autopilot-goals.test.ts covers an empty bill.
const fundedRouteBill = [...bill, row('coins', 1_000_000)];
const inputs = (accounts: Acct[], extra: Partial<Inputs> = {}): Inputs => ({
    side, accounts, owners: new Map(accounts.map(a => [a.name.toLowerCase(), { side: a.side }])), bill: fundedRouteBill, templates: catalogue(), prices, ...extra,
});
const ids = (xs: ReturnType<typeof plan>) => Object.fromEntries(xs.map(x => [x.account, x.template?.id ?? 'vacant']));
// Cohort allocation cases receive the fresh qualified method that the CLI binds before reserving its place.
const qualifiedTrooperTemplate=(t:Template):Template=>t.script==='scripts/ranged-train.ts'?{...t,env:{...t.env,PROGRESSION_METHOD:'ranged/troopers',PROGRESSION_SOURCE:'fixture-native-proof'},resources:['trooper:battlefield']}:t;

test('a bill line still short, or one it feeds, has value; surplus and unneeded coins have none', () => {
    expect(unitValue('Feather', bill, prices)).toBe(4);
    expect(unitValue('Feather', [row('feathers', 0), row('headless arrows', 10)], prices)).toBe(4);
    expect(unitValue('Feather', [row('feathers', 0)], prices)).toBe(0);
    expect(unitValue('coins', [], prices)).toBe(0);
    expect(unitValue('coins', [row('coins', 10)], prices)).toBe(1);
    // Steel bars are useful while cannonballs are short, and have no value with that line met.
    const bars = { 'steel bar': 100, cannonball: 5 };
    expect(unitValue('Steel bar', [row('cannonball', 1700)], bars)).toBe(200);
    expect(unitValue('Steel bar', [row('cannonball', 0)], bars)).toBe(0);
    expect(unitValue('Steel bar', [row('cannonball', 0), row('iron bar', 2)], bars)).toBe(0);
    expect(unitValue('Steel bar', [], bars)).toBe(0);
});

test('a bill line that no item is named after takes the price of its item ids, so its maker has the value of the line', () => {
    const items = [{ id: 91, name: 'Unfinished potion', debugname: 'guamvial', cost: 3 }, { id: 111, name: 'Unfinished potion', debugname: 'torstolvial', cost: 25 },
        { id: 2970, name: 'Mort myre fungi', debugname: 'mortmyremushroom', cost: 7 }, { id: 314, name: 'Feather', debugname: 'feather', cost: 2 },
        { id: 315, name: 'Feather', debugname: 'cert_feather', cost: 9 }, { id: 68, name: 'Yew shortbow', debugname: 'unstrung_yew_shortbow', cost: 400 },
        { id: 857, name: 'Yew shortbow', debugname: 'yew_shortbow', cost: 800 }];
    const line = (item: string, ids: number[], short = 1) => ({ item, need: short, owned: 0, short, ids, holders: [] });
    const lines = [line('torstol potion (unf)', [111], 176), line('guam potion (unf)', [91]), line('mort myre fungus', [2970], 4), line('feathers', [314]), line('yew shortbow', [68, 857]),
        line('no such thing', [])];
    const table = priceTable(items, lines);
    // An item name keeps the cost of its first item that is not a note; a line with no item id gets no price.
    expect(table).toEqual({ 'unfinished potion': 3, 'mort myre fungi': 7, feather: 2, 'yew shortbow': 400, 'torstol potion (unf)': 25, 'guam potion (unf)': 3, 'mort myre fungu': 7 });
    expect(unitValue('torstol potion (unf)', lines, table)).toBe(50);
    expect(unitValue('torstol potion (unf)', [line('torstol potion (unf)', [111], 0)], table)).toBe(0);
    expect(unitValue('Mort myre fungus', lines, table)).toBe(14);
    // A missing price keeps a needed output useful, at the fallback value of one before the bill premium.
    expect(unitValue('torstol potion (unf)', lines, priceTable(items, []))).toBe(2);
    // A second name of a line gets the same price.
    expect(priceTable(items, [{ ...line('unf torstol', [111]), aliases: ['torstol potion (unf)'] }])['torstol potion (unf)']).toBe(25);
});

test('knight coins scale with Thieving and are zero below 55', () => {
    expect(knightCoinsPerTick(54)).toBe(0);
    expect(knightCoinsPerTick(99)).toBeCloseTo(18.8, 5);
    expect(knightCoinsPerTick(70)).toBeGreaterThan(knightCoinsPerTick(55));
});

test('only this side plans, one account per exclusive resource, and taken resources stay taken', () => {
    const accounts = [acct('ThiefA', { Thieving: 80 }), acct('ThiefB', { Thieving: 70 }), acct('Theirs', { Thieving: 99 }, {}, 'local')];
    const taken = { 'knight:2652,3318': 1, 'knight:2653,3300': 1, 'knight:2669,3298': 1, 'knight:2671,3313': 1 };
    const out = plan(inputs(accounts, { taken }));
    expect(out.map(x => x.account)).toEqual(['ThiefA', 'ThiefB']);
    expect(ids(out).ThiefA).toBe('goldfarm@2582,3297');
    expect(ids(out).ThiefB).toMatch(/^feathers@/);
    // An account the owners file gives another side is never planned, whatever its status says.
    const owners = new Map([['thiefa', { side: 'local' }], ['thiefb', { side }]]);
    expect(plan({ ...inputs(accounts), owners }).map(x => x.account)).toEqual(['ThiefB']);
});

test('a fresh account trains toward a free knight spot and reserves it; with no free spot it gathers', () => {
    const fresh = [acct('NewA'), acct('NewB')];
    const four = { 'knight:2652,3318': 1, 'knight:2653,3300': 1, 'knight:2669,3298': 1, 'knight:2671,3313': 1 };
    const out = plan(inputs(fresh, { taken: four }));
    expect(ids(out)).toEqual({ NewA: 'thieving55', NewB: expect.stringMatching(/^feathers@/) });
    expect(out[0]!.resources).toEqual(['knight:2582,3297']);
    expect(ids(plan(inputs(fresh, { taken: { ...four, 'knight:2582,3297': 1 } })))).toEqual({ NewA: expect.stringMatching(/^feathers@/), NewB: expect.stringMatching(/^feathers@/) });
});

test('a knight spot takes KNIGHT_SHARE farmers, each worth less: the empty spots fill first, then the least-held', () => {
    const fresh = [acct('NewA'), acct('NewB'), acct('NewC')];
    const knights = (n: number) => Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, n]));
    const shared = (taken: Record<string, number>) => plan(inputs(fresh, { taken, capacity: CAPACITY, shared: SHARED }));
    // One empty spot: the first account takes it at full worth, the others take a second place on a held spot.
    const one = shared({ ...knights(1), 'knight:2582,3297': 0 });
    expect(ids(one)).toEqual({ NewA: 'thieving55', NewB: 'thieving55', NewC: 'thieving55' });
    expect(one[0]!.resources).toEqual(['knight:2582,3297']);
    const holders = (taken: Record<string, number>, out: ReturnType<typeof plan>) => out.reduce((m, x) => ({ ...m, [x.resources[0]!]: (m[x.resources[0]!] ?? 0) + 1 }), { ...taken });
    expect(Math.max(...Object.values(holders({ ...knights(1), 'knight:2582,3297': 0 }, one)))).toBe(2);
    expect(one[1]!.value).toBeCloseTo(one[0]!.value * SHARED['knight:2652,3318']!, 9);
    // No account takes a place beyond a spot's capacity.
    expect(KNIGHT_SHARE).toBe(4);
    expect(ids(shared({ ...knights(KNIGHT_SHARE), 'knight:2582,3297': KNIGHT_SHARE - 1 }))).toEqual({ NewA: 'thieving55', NewB: expect.stringMatching(/^feathers@/), NewC: expect.stringMatching(/^feathers@/) });
    expect(Object.values(ids(shared(knights(KNIGHT_SHARE)))).every(id => id.startsWith('feathers@'))).toBe(true);
    // With every spot at two farmers, the third places still take fresh accounts, one to a spot, each worth less than a
    // second place.
    const third = shared(knights(2));
    expect(ids(third)).toEqual({ NewA: 'thieving55', NewB: 'thieving55', NewC: 'thieving55' });
    expect(Math.max(...Object.values(holders(knights(2), third)))).toBe(3);
    expect(third[0]!.value).toBeCloseTo(one[0]!.value * SHARED['knight:2652,3318']! ** 2, 9);
    expect(third[0]!.value).toBeLessThan(one[1]!.value);
    // Two accounts of this side on empty spots spread out instead of sharing.
    const spread = shared({});
    expect(new Set(spread.map(x => x.resources[0])).size).toBe(3);
    expect(spread.every(x => x.value === spread[0]!.value)).toBe(true);
});

test('skills and holdings gate templates; coins pick a shop; a retired pair picks the next best', () => {
    const fisher = acct('Fisher', { Fishing: 60, Cooking: 60 }, { 'lobster pot': 1 });
    expect(ids(plan(inputs([fisher])))).toEqual({ Fisher: 'lobster-chain' });
    expect(ids(plan(inputs([acct('Fisher', { Fishing: 60, Cooking: 60 })])))).toEqual({ Fisher: expect.stringMatching(/^thieving55$|^feathers@/) });
    expect(ids(plan(inputs([fisher], { retired: new Set([pairKey('Fisher', 'lobster-chain')]) }))).Fisher).not.toBe('lobster-chain');
    const knights = Object.fromEntries(['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'].map(s => [`knight:${s}`, 1]));
    expect(ids(plan(inputs([acct('Rich', {}, { coin: 50_000 })], { taken: knights }))).Rich).toBe('shop-feathers');
    expect(ids(plan(inputs([acct('Fletch', {}, { 'arrow shaft': 1000, feather: 1000 })]))).Fletch).toBe('fletch-headless');
});
test('an account whose pack meets the feather target gets no feather job', () => {
    const knights = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, 1]));
    expect(ids(plan(inputs([acct('Full', {}, { feather: FEATHER_TARGET })], { taken: knights }))).Full).not.toMatch(/^feathers@/);
    expect(ids(plan(inputs([acct('Room', {}, { feather: FEATHER_TARGET - 1 })], { taken: knights }))).Room).toMatch(/^feathers@/);
});
test('a thief with few Hitpoints gets a knight spot only when it holds food; a fresh account still trains toward one', () => {
    const job = (a: Acct) => ids(plan(inputs([a])))[a.name];
    const frail = (items: Record<string, number> = {}) => acct('Frail', { Thieving: 99, Hitpoints: 10 }, items);
    expect(job(frail())).not.toMatch(/^goldfarm@/);
    expect(job(frail({ 'slice of cake': 1 }))).not.toMatch(/^goldfarm@/);
    // Food that the worker does not eat does not count.
    expect(job(frail({ 'slice of cake': 1, 'raw lobster': 5 }))).not.toMatch(/^goldfarm@/);
    expect(job(frail({ 'slice of cake': 1, lobster: 1 }))).toMatch(/^goldfarm@/);
    expect(job(acct('Edge', { Thieving: 99, Hitpoints: 19 }))).not.toMatch(/^goldfarm@/);
    expect(job(acct('Hale', { Thieving: 99, Hitpoints: 20 }))).toMatch(/^goldfarm@/);
    // The worth of the trainer comes from the spot that the level unlocks. The food rule does not take that away.
    expect(job(acct('New'))).toBe('thieving55');
});
test('a frail thief with coins and no food buys food with its own coins, then takes a knight spot', async () => {
    const { FRAIL_FOOD_BUY, FRAIL_FOOD_BUY_ID, KIT_BUY, KIT_CASH_RESERVE, KIT_COIN_MARGIN, KIT_PRICE_CAPS } = await import('../src/autopilot');
    const food = { trout: { id: 333, name: 'Trout', limit: KIT_PRICE_CAPS.trout! }, lobster: { id: 379, name: 'Lobster', limit: KIT_PRICE_CAPS.lobster! } };
    const frail = (items: Record<string, number> = {}) => acct('Frail', { Thieving: 99, Hitpoints: 10 }, items);
    const pick = (a: Acct, extra: Partial<Inputs> = {}) => plan(inputs([a], { market: food, ...extra })).find(x => x.account === a.name);
    const cost = FRAIL_FOOD_BUY * KIT_PRICE_CAPS.trout!;
    // The cheapest food of the job that the market lists, in one order with the price cap.
    const buy = pick(frail({ coin: cost + KIT_CASH_RESERVE + KIT_COIN_MARGIN }))!;
    expect(buy.template!.id).toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
    expect(buy.template!.args).toHaveLength(1);
    expect(buy.template!.args![0]).toContain(`ITEM_ID=333 QUANTITY=${FRAIL_FOOD_BUY} LIMIT_PRICE=${KIT_PRICE_CAPS.trout}`);
    expect(buy.reason).toContain(`at most ${cost} coins`);
    // The buy holds one knight spot, the one that the food is for. With each spot full there is no buy: the account
    // would pay for food and then have no spot to use it on.
    expect(buy.resources).toHaveLength(1);
    expect(buy.resources![0]).toMatch(/^knight:/);
    const full = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, 99]));
    expect(pick(frail({ coin: 1_000_000 }), { taken: full })?.template?.id).not.toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
    const oneFree = { ...full, [`knight:${KNIGHT_SPOTS[0]}`]: 0 };
    expect(pick(frail({ coin: 1_000_000 }), { taken: oneFree })!.resources).toEqual([`knight:${KNIGHT_SPOTS[0]}`]);
    // One coin short of the order and the reserve: no buy.
    expect(pick(frail({ coin: cost + KIT_CASH_RESERVE + KIT_COIN_MARGIN - 1 }))?.template?.id).not.toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
    // No market, a retired buy, or an account that is not frail: no buy.
    expect(plan(inputs([frail({ coin: 1_000_000 })])).find(x => x.account === 'Frail')?.template?.id).not.toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
    expect(pick(frail({ coin: 1_000_000 }), { retired: new Set([pairKey('Frail', KIT_BUY + FRAIL_FOOD_BUY_ID)]) })?.template?.id).not.toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
    expect(pick(acct('Hale', { Thieving: 99, Hitpoints: 20 }, { coin: 1_000_000 }))!.template!.id).toMatch(/^goldfarm@/);
    // With the food in the bank the account takes the knights.
    expect(pick(frail({ coin: 1_000_000, trout: FRAIL_FOOD_BUY }))!.template!.id).toMatch(/^goldfarm@/);
    // A thief under the Thieving level of the job buys nothing: food does not fix that.
    expect(pick(acct('Low', { Thieving: 40, Hitpoints: 10 }, { coin: 1_000_000 }))?.template?.id).not.toBe(KIT_BUY + FRAIL_FOOD_BUY_ID);
});
test("the chicken pen in the Champions' Guild yard goes only to an account with 32 quest points", () => {
    const guild = Object.keys(PEN_QUEST_POINTS).map(p => `feathers@${p}`);
    expect(guild).toEqual(['feathers@3197,3353']);
    // Each knight spot and each open pen has an account, so the guild pen is the one feather job left.
    const taken = Object.fromEntries([...KNIGHT_SPOTS.map(s => `knight:${s}`), ...CHICKEN_PENS.filter(p => !PEN_QUEST_POINTS[p]).map(p => `pen:${p}`)].map(r => [r, 1]));
    const job = (a: Acct) => ids(plan(inputs([a], { taken })))[a.name];
    expect(job(acct('Unknown'))).not.toMatch(/^feathers@/);
    expect(job({ ...acct('Short'), questPoints: 31 })).not.toMatch(/^feathers@/);
    expect(job({ ...acct('Member'), questPoints: 32 })).toBe(guild[0]);
    // With the open pens free, an account with too few points still gets a feather job, at an open pen.
    const open = ids(plan(inputs([{ ...acct('A'), questPoints: 11 }, { ...acct('B'), questPoints: 11 }, { ...acct('C'), questPoints: 11 }, { ...acct('D'), questPoints: 11 }],
        { taken: Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, 1])) })));
    expect(Object.values(open).filter(id => /^feathers@/.test(id)).sort()).toEqual(CHICKEN_PENS.filter(p => !PEN_QUEST_POINTS[p]).map(p => `feathers@${p}`).sort());
    expect(Object.values(open)).not.toContain(guild[0]);
    // An account that holds the guild pen with too few points moves to an open pen.
    const held = plan(inputs([{ ...acct('Held'), questPoints: 11 }], { taken: Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, 1])), current: new Map([['held', guild[0]!]]) }));
    expect(ids(held).Held).toMatch(/^feathers@/);
    expect(ids(held).Held).not.toBe(guild[0]);
});

test('a shop blocked only by coins is funded by the richest free donor above its reserve', () => {
    const knights = Object.fromEntries(['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'].map(s => [`knight:${s}`, 1]));
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const poor = acct('Poor', {}, { coin: 500 });
    const out = plan(inputs([poor], { templates: shops, taken: knights, donors: [{ name: 'Small', coins: 51_000 }, { name: 'Big', coins: 900_000 }] }));
    expect(out[0]!.template?.id).toBe('shop-feathers');
    expect(out[0]!.fund).toEqual({ from: 'Big', to: 'Poor', coins: 1_500, template: 'shop-feathers' });
    // No donor holds the need above FUND_RESERVE (50,000): the account stays vacant and nothing is funded.
    const none = plan(inputs([poor], { templates: shops, donors: [{ name: 'Small', coins: 51_000 }] }));
    expect(none[0]!.template).toBeUndefined();
    // Without donors the old rule stands: the coin need gates the shop.
    expect(plan(inputs([poor], { templates: shops }))[0]!.template).toBeUndefined();
});

test('a donor that gives stays free that pass; an account that holds the coins needs no fund', () => {
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const show = (out: ReturnType<typeof plan>) => Object.fromEntries(out.map(x => [x.account, x.fund ? `funded by ${x.fund.from}` : x.template?.id ?? x.reason]));
    const opts = (donor: string) => ({ templates: shops, capacity: { 'shop:sarim': 2 }, donors: [{ name: donor, coins: 900_000 }] });
    // Equal values go in name order. Poor comes first: Zed funds it and takes no job.
    expect(show(plan(inputs([acct('Poor'), acct('Zed', {}, { coin: 900_000 })], opts('Zed'))))).toEqual({ Poor: 'funded by Zed', Zed: 'vacant: gives coins this pass' });
    // Big comes first and takes the job itself: an assigned account never gives.
    expect(show(plan(inputs([acct('Poor'), acct('Big', {}, { coin: 900_000 })], opts('Big'))))).toEqual({ Poor: 'vacant: shop-feathers needs 2000 coins and no free account can give them', Big: 'shop-feathers' });
    expect(plan(inputs([acct('Rich', {}, { coin: 5_000 })], { templates: shops, donors: [{ name: 'Big', coins: 900_000 }] }))[0]!.fund).toBeUndefined();
});

test('an account with an enabled job is never funded, so no running job is removed for a trade', () => {
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const out = plan(inputs([acct('Poor', {}, { coin: 500 })], { templates: shops, donors: [{ name: 'Big', coins: 900_000 }], unfundable: new Set(['poor']) }));
    expect(out[0]!.fund).toBeUndefined();
    expect(out[0]!.template).toBeUndefined();
});

test('an account with nothing useful is vacant with its constraint', () => {
    const out = plan(inputs([acct('Idle')], { templates: catalogue().filter(t => t.id === 'lobster-chain') }));
    expect(out).toEqual([{ account: 'Idle', value: 0, resources: [], reason: expect.stringMatching(/^vacant: /) }]);
});

test('tick waste discounts a family', () => {
    const a = [acct('ThiefA', { Thieving: 80 })];
    const plain = plan(inputs(a))[0]!.value, wasted = plan(inputs(a, { waste: { goldfarm: 0.5 } }))[0]!.value;
    expect(wasted).toBeCloseTo(plain / 2, 5);
});

test('planner jobs carry the marker, repeat and standing, and the merge keeps unmarked and unchanged jobs', () => {
    const [x] = plan(inputs([acct('ThiefA', { Thieving: 80 })]));
    const job = jobFor(x!, side);
    expect(job).toMatchObject({ account: 'ThiefA', script: 'scripts/goldfarm.ts', enabled: true, repeat: true, standing: true, autopilot: side, template: x!.template!.id });
    // A training job runs once: its ok RESULT is the target met, so a repeat would be a no-op login.
    const [fresh] = plan(inputs([acct('Fresh')]));
    expect(fresh!.template!.id).toBe('thieving55');
    expect(jobFor(fresh!, side)).toMatchObject({ script: 'scripts/generated/thieving60.ts', repeat: false, standing: true });
    const human = { account: 'Other', script: 'scripts/goldfarm.ts', enabled: true }, theirs = { account: 'Far', script: 'x', enabled: true, autopilot: 'cloud' };
    const stale = { account: 'Gone', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side, template: 'feathers@3229,3298' };
    const kept = { ...job, note: 'kept as is' };
    const merged = mergeJobs([human, theirs, stale, kept], side, [x!]);
    expect(merged.jobs).toEqual([human, theirs, kept]);
    expect(merged.fresh).toEqual([]);
    expect(mergeJobs([human], side, [x!]).fresh).toEqual(['ThiefA']);
    // An owner pause on the old template stays on the new one.
    const paused = { ...stale, account: 'ThiefA', enabled: false, repeat: false };
    expect(mergeJobs([paused], side, [x!]).jobs).toEqual([{ ...job, enabled: false, repeat: false }]);
    // A job carrying the template's id but another script, args or env (a hand edit, or a template changed in code) is
    // replaced by the template's own job; an owner pause on it holds.
    for (const drift of [{ script: 'scripts/gather-combat.ts' }, { env: { ...job.env, KNIGHT_SPOT: '0,0' } }, { args: ['5000'] }]) {
        expect(mergeJobs([{ ...job, ...drift }], side, [x!])).toEqual({ jobs: [job], fresh: ['ThiefA'] });
        expect(mergeJobs([{ ...job, ...drift, enabled: false, repeat: false }], side, [x!]).jobs).toEqual([{ ...job, enabled: false, repeat: false }]);
    }
});

test('a training job does not repeat, and its ok RESULT names the account for an early pass', () => {
    const [x] = plan(inputs([acct('NewA')]));
    const trainer = jobFor(x!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', enabled: true, repeat: false, standing: true });
    const farm = jobFor(plan(inputs([acct('ThiefA', { Thieving: 80 })]))[0]!, side);
    const assigned = { NewA: { template: 'thieving55', offset: 10 }, ThiefA: { template: farm.template, offset: 0 } };
    const logs: Record<string, string[]> = { NewA: ['[x] RESULT ok thieving=55 xp=16000 ticks=1736 died=false'], ThiefA: ['RESULT ok coinsGained=900 died=false banked=900'] };
    const lines = (a: string, offset: number) => offset === assigned[a as keyof typeof assigned].offset ? logs[a]! : [];
    // Only a trains template counts; a producing job's ok RESULT is its normal repeat.
    expect(finishedTrainers([trainer, farm], side, assigned, catalogue(), lines)).toEqual(['NewA']);
    expect(finishedTrainers([trainer], side, assigned, catalogue(), () => ['RESULT fail thieving 52 < 55 ...'])).toEqual([]);
    // A job the state no longer assigns, or another side's, is not this planner's trainer.
    expect(finishedTrainers([trainer], side, { NewA: { template: 'goldfarm@2582,3297', offset: 10 } }, catalogue(), lines)).toEqual([]);
    expect(finishedTrainers([{ ...trainer, autopilot: 'cloud' }], side, assigned, catalogue(), lines)).toEqual([]);
});

test('existing jobs hold their resources, chain steps included', () => {
    expect(jobResources({ script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' } })).toEqual(['knight:2671,3313']);
    expect(jobResources({ script: 'scripts/goldfarm.ts' })).toEqual(['knight:2653,3300']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/shop-buyer.ts harry 300', 'scripts/goldfarm.ts KNIGHT_SPOT=2582,3297'] })).toEqual(['shop:harry', 'knight:2582,3297']);
    expect(jobResources({ script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'] })).toEqual(['catherby:lobster']);
    expect(jobResources({ script: 'scripts/gather-fish.ts', args: ['harpoon'] })).toEqual([]);
    // An adaptive entry without a bound route claims both possible fields until its fresh choice is known.
    expect(jobResources({ script: 'scripts/ranged-train.ts', args: ['97', '30000'], env: { FOOD: '2' } })).toEqual(['pen:3229,3298','trooper:battlefield']);
    expect(jobResources({ script: 'scripts/ranged-train.ts', resources:['pen:3229,3298','shop:lowe'],env:{PROGRESSION_METHOD:'ranged/troopers'} })).toEqual(['trooper:battlefield','shop:lowe']);
    expect(jobResources({ script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' } })).toEqual(['pen:3017,3288']);
    expect(jobResources({ script: 'x', resources: ['shop:betty'] })).toEqual(['shop:betty']);
});

test('assess retires repeated fails, a death and near-total waste, and keeps progress', () => {
    expect(assess(['RESULT ok feathers=30 gained=30', 'RESULT fail no chickens']).retire).toBe(false);
    expect(assess(['[x] RESULT fail no chickens', '| RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2 });
    expect(assess(['RESULT fail died at 2652,3318']).reason).toMatch(/^death/);
    // A world planner `no route` is where the account stands, not the job's failure: a drain, never a retirement.
    const noRoute = 'RESULT fail travel to Ardougne from 3185,3436 failed: precondition no route to 2654,3283,0';
    expect(assess([noRoute, noRoute])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    // A market buy that did not reach the market bank placed no order (live: a stale state at Port Sarim, off the
    // second ferry, in a relayed session). Its two forms are drains; a buy that reached the bank and failed is not.
    const trip = 'RESULT fail market bank travel failed: position=3029,3217,0 currentHP=99 ticks=207; Error: no route to 3185,3436,0';
    const budget = 'RESULT fail Error: market bank travel failed: position=3029,3217,0 currentHP=99 ticks=41; Error: market trip health/stop/tick budget';
    expect(assess([trip, budget])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    expect(assess(['RESULT fail {"ok":false,"phase":"unplaced","acquired":0,"failure":"final bank/reserve/asset reconciliation failed"}', 'RESULT fail {"ok":false,"phase":"unplaced","acquired":0,"failure":"x"}']).retire).toBe(true);
    // A buy refused because the planner's count of the item was stale placed no order either (live: baseline 104
    // against EXPECTED_OWNED 140); the chain's result line carries the step's text.
    const stale = 'RESULT fail {"ok":false,"phase":"unplaced","pending":false,"quantity":10,"acquired":0,"spent":0,"finalItems":104,"ticks":4,"failure":"Error: owned item baseline 104 differs from EXPECTED_OWNED 140"} chain rounds=1 ok=0 failed=1';
    expect(assess([stale, stale])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    expect(assess(['RESULT fail no combat progress: cow stage: walk to Ardougne north bank failed: precondition no route to 2619,3332,0', noRoute]).retire).toBe(false);
    // A cow run that killed and trained before failing made progress; two runs with no kill did not.
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=6 selectedXp=5200', 'RESULT fail mode=cow ok=false creditedKills=2 selectedXp=1600']).retire).toBe(false);
    expect(assess(['RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0', 'RESULT fail mode=cow ok=false creditedKills=0 selectedXp=0']).retire).toBe(true);
    expect(assess(['RESULT fail coinsGained=10 died=true banked=0']).reason).toMatch(/^death/);
    expect(assess(['RESULT ok coinsGained=1000 died=false banked=1000']).retire).toBe(false);
    expect(assess(['LEDGER ticks=1000 xp=0 move=500 anim=10 dialog=0 stun=0 idle=450', 'RESULT ok feathers=0 gained=0']).reason).toMatch(/^tick waste 95%/);
    expect(assess(['LEDGER ticks=1000 xp=0 move=300 anim=600 dialog=0 stun=0 idle=100', 'RESULT ok feathers=90 gained=90']).retire).toBe(false);
    expect(assess(['LEDGER ticks=100 xp=0 move=50 anim=0 dialog=0 stun=0 idle=50']).retire).toBe(false);
    // A fight is mostly ticks between hits: a run that ended ok with progress is not retired on its ledger.
    const fight = 'LEDGER ticks=2000 xp=120 inventory=20 move=700 anim=20 dialog=0 stun=0 idle=1140 idlePct=57.0 xpGain=60000';
    expect(assess([fight, 'RESULT ok mode=giant ok=true creditedKills=30 trainSkill=Defence selectedXp=52000']).retire).toBe(false);
    expect(assess([fight, 'RESULT ok mode=giant ok=true creditedKills=0 trainSkill=Defence selectedXp=0']).reason).toMatch(/^tick waste 92%/);
    expect(assess([fight, 'RESULT fail mode=giant ok=false creditedKills=30 selectedXp=52000 stop=cap']).reason).toMatch(/^tick waste 92%/);
    expect(assess(['RESULT ok mode=giant creditedKills=30 selectedXp=52000', fight]).reason).toMatch(/^tick waste 92%/);
    // A trainer at its tick cap short of the target ends fail with the XP it gained: progress, not a fail toward retirement.
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=16000 ticks=2500 died=false', 'RESULT fail thieving 54 < 55 thieving=54 xp=9000 ticks=2500 died=false'])).toMatchObject({ retire: false, fail: 2 });
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false', 'RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false'])).toMatchObject({ retire: true, fail: 2 });
    // A run stopped by a stop file after such a fail is not a second one.
    expect(assess(['RESULT fail thieving 52 < 55 thieving=52 xp=0 ticks=2500 died=false', 'RESULT fail stop file thieving=52 xp=0 ticks=3 died=false'])).toMatchObject({ retire: false, fail: 1, drains: 1 });
});

test('a status file becomes base levels and held counts by name', () => {
    const a = accountFrom('Pal', side, { skills: [{ name: 'Thieving', level: 56 }], inventory: [{ id: 314, name: 'Feather', count: 40 }], bank: [{ id: 314, count: 60 }], equipment: null }, id => id === 314 ? 'Feather' : undefined);
    expect(a).toEqual({ name: 'Pal', side, skills: { Hitpoints: 10, Thieving: 56 }, items: { feather: 100 }, exact: { feather: 100 } });
    expect(accountFrom('New', side, null, () => undefined).skills).toEqual({ Hitpoints: 10 });
});
test('bow kit stock uses native base IDs instead of shared unstrung display names', () => {
    const a = accountFrom('Archer', side, { inventory: [
        { id: 72, name: 'Magic shortbow', count: 2 }, { id: 73, baseId: 72, name: 'Magic shortbow (noted)', count: 3 },
        { id: 861, name: 'Shortbow', count: 1 }, { id: 862, baseId: 861, name: 'Magic shortbow (noted)', count: 4 },
        { id: 50, name: 'Shortbow', count: 2 }, { name: 'Shortbow', count: 99 }, { id: 999999, name: 'Magic shortbow', count: 99 },
    ] }, () => undefined);
    expect(a.items['magic shortbow']).toBe(5);
    expect(a.items['unstrung magic shortbow']).toBe(5);
    expect(a.items['unstrung shortbow']).toBe(2);
    expect(a.items.shortbow).toBeUndefined();
});
test('account health comes from observed current HP, including shared skill rows, and stays unknown when absent', () => {
    const from = (status: unknown) => accountFrom('Fighter', side, status, () => undefined);
    const skills = [{ name: 'Hitpoints', level: 99, currentLevel: 51 }];
    expect(from({ hp: { now: 29, max: 99 }, skills }).currentHP).toBe(29);
    expect(from({ skills }).currentHP).toBe(51);
    for (const hp of [null, {}, { now: -1 }, { now: NaN }, { now: '99' }])
        expect(from({ hp, skills: [{ name: 'Hitpoints', level: 99 }] }).currentHP).toBeUndefined();
    expect(from(null).currentHP).toBeUndefined();
});

test('the planner gets handed-over and unnamed accounts; enabled jobs, reservations and stop files keep theirs', () => {
    const jobs = [
        { account: 'Haggis', script: '', enabled: false },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side },
        { account: 'YewFirst', script: 'scripts/session-check.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'YewFirst', script: 'scripts/shop-buyer.ts', enabled: true, autopilot: side },
        { account: 'Shaftmaker', script: 'scripts/firemaking-order.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'Moneyshot', script: 'scripts/quest-cook-job.ts', enabled: true, coordinatorOwner: 'coordinator' },
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side },
        { accounts: ['NabTheKnob', 'Swordinhand'], host: true, script: 'scripts/quest-chain.ts', enabled: false, standing: true },
    ];
    const listed = ['Haggis', 'Woodpecker', 'YewFirst', 'Shaftmaker', 'Moneyshot', 'Hocuspokeus', 'NabTheKnob', 'Fresh'];
    expect(plannableAccounts(jobs, side, listed, new Set(['hocuspokeus']))).toEqual(['Woodpecker', 'YewFirst', 'Fresh']);
    expect(plannableAccounts(jobs, 'other', listed, new Set())).toEqual(['Fresh']);
});

test('a paused handed-over job stays in the merge with its own settings', () => {
    const jobs = [
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: false, repeat: false, autopilot: side, template: 'feathers@3017,3288' },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', enabled: true, repeat: true, autopilot: side, template: 'feathers@3229,3298' },
        { account: 'Haggis', script: '', enabled: false },
    ];
    const merged = mergeJobs(jobs, side, [], new Set(['hocuspokeus']));
    expect(merged.jobs.map(j => j.account)).toEqual(['Hocuspokeus', 'Haggis']);
    expect(merged.jobs[0]).toEqual(jobs[0]);
    expect(mergeJobs(jobs, side, []).jobs.map(j => j.account)).toEqual(['Haggis']);
});

test('a paused handed-over job keeps its pen reserved', () => {
    const jobs = [
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', env: { PEN: '3017,3288' }, enabled: true, autopilot: side },
        { account: 'Woodpecker', script: 'scripts/gather-feathers.ts', env: { PEN: '3229,3298' }, enabled: true, autopilot: side },
        { account: 'CoinCock', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2670,3306' }, enabled: true },
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: false },
    ];
    expect(Object.keys(reservedResources(jobs, side, new Set(['hocuspokeus']))).sort()).toEqual(['knight:2671,3313', 'pen:3017,3288']);
});

test('the claim lists every spot, pen and shop the enabled jobs of this side hold, planner-made or not, once per job', () => {
    const jobs = [
        { account: 'Pocketpython', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2582,3297' }, enabled: true },
        { account: 'Shaftsinker', script: 'scripts/chain.ts', args: ['scripts/goldfarm.ts KNIGHT_SPOT=2653,3300'], env: { ROUNDS: '1', RUN: '2' }, enabled: true },
        { account: 'PickpockDick', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2653,3302' }, enabled: true },
        { account: 'Hocuspokeus', script: 'scripts/gather-feathers.ts', enabled: true, autopilot: side, template: 'feathers@3017,3288', resources: ['pen:3017,3288'] },
        { account: 'Woodpecker', script: 'scripts/chain.ts', args: ['scripts/generated/thieving60.ts TARGET=55 CAP=3000', 'scripts/goldfarm.ts KNIGHT_SPOT=2669,3298'], enabled: false },
        { account: 'Quickhandjob', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2652,3318' }, enabled: true },
        { accounts: ['NabTheKnob', 'Swordinhand'], host: true, script: 'scripts/quest-chain.ts', enabled: true },
        { account: 'Haggis', script: '', enabled: false },
    ];
    const claim = claimFor(jobs, side, a => a === 'Quickhandjob' ? 'cloud' : side, 1234);
    // Shaftsinker and PickpockDick both farm the 2653,3300 knights, so the other sides count two farmers there.
    expect(claim).toEqual({ side, at: 1234, resources: ['knight:2582,3297', 'knight:2653,3300', 'knight:2653,3300', 'pen:3017,3288'] });
    expect(claimFor([], side, () => side, 5).resources).toEqual([]);
    // Only a job with an active account holds its resources: a parked job's spot is free for the other sides.
    expect(claimFor(jobs, side, a => a === 'Quickhandjob' ? 'cloud' : side, 1234, a => a === 'Pocketpython' || a === 'Hocuspokeus').resources).toEqual(['knight:2582,3297', 'pen:3017,3288']);
});

test('an account the coordinator is recovering keeps its own job in the claim; other coordinator work does not', () => {
    const own = [
        { account: 'Kiltlifter', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, autopilot: side, resources: ['knight:2671,3313'] },
        { account: 'SporranDip', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2652,3318' }, enabled: true, autopilot: side, resources: ['knight:2652,3318'] },
        { account: 'Knightstick', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2669,3298' }, enabled: true, autopilot: side, resources: ['knight:2669,3298'] },
    ];
    const coord = [
        { account: 'Kiltlifter', script: 'scripts/session-check.ts', enabled: false, coordinatorOwner: 'coordinator' },
        { account: 'Knightstick', script: 'scripts/generated/quest-cook.ts', enabled: true, coordinatorOwner: 'coordinator' },
    ];
    expect(recoveringOwnerJobs(own, coord).map(j => j.account)).toEqual(['Kiltlifter']);
    expect(recoveringOwnerJobs(own, [{ ...coord[0], script: './scripts/session-check.ts' }]).map(j => j.account)).toEqual(['Kiltlifter']);
    expect(recoveringOwnerJobs(own, [])).toEqual([]);
    // The merged plan drops both shadowed jobs; adding the recovering one back keeps only Kiltlifter's place.
    const merged = [own[1]!, ...coord];
    expect(claimFor([...merged, ...recoveringOwnerJobs(own, coord)], side, () => side, 1).resources).toEqual(['knight:2652,3318', 'knight:2671,3313']);
});

test('a marked reservation opts its account in, and planning replaces it with an enabled job', () => {
    const jobs = [
        { account: 'Magicwanda', script: '', enabled: true, autopilot: 'local' },
        { account: 'Pocketpython', script: 'scripts/goldfarm.ts', enabled: false, env: { KNIGHT_SPOT: '2582,3297' } },
        { account: 'Moneyshot', script: 'scripts/goldfarm.ts', enabled: true, env: { KNIGHT_SPOT: '2652,3318' } },
    ];
    expect(plannableAccounts(jobs, 'local', ['Magicwanda', 'Pocketpython', 'Moneyshot', 'Wandwaver'], new Set())).toEqual(['Magicwanda', 'Wandwaver']);
    expect(reservedResources(jobs, 'local', new Set())).toEqual({ 'knight:2652,3318': 1 });
    const t = catalogue().find(x => x.id === 'goldfarm@2669,3298')!;
    const { jobs: next, fresh } = mergeJobs(jobs, 'local', [{ account: 'Magicwanda', template: t, value: 10, resources: ['knight:2669,3298'], reason: 'best' }]);
    expect(fresh).toEqual(['Magicwanda']);
    const made = next.find(j => j.account === 'Magicwanda')!;
    expect(made.enabled).toBe(true); expect(made.script).toBe('scripts/goldfarm.ts'); expect(made.env.KNIGHT_SPOT).toBe('2669,3298');
    expect(next.filter(j => j.account === 'Magicwanda')).toHaveLength(1);
});

test('the freshest observation wins by its time stamp; nothing observed is null', () => {
    const status = { at: 10, skills: [{ name: 'Thieving', level: 1 }] }, snapshotRow = { at: 20, skills: [{ name: 'Thieving', level: 99 }] };
    expect(freshest(status, snapshotRow)).toBe(snapshotRow);
    expect(freshest(snapshotRow, status)).toBe(snapshotRow);
    expect(freshest(null, snapshotRow)).toBe(snapshotRow);
    expect(freshest(undefined, null)).toBeNull();
    expect(accountFrom('Quickhandjob', 'claude-cloud', freshest(null, snapshotRow), () => undefined).skills.Thieving).toBe(99);
});

test('on a value tie an account keeps the template it holds, so a level change does not move it to another spot', () => {
    const a = acct('UnderMyKilt', { Thieving: 99 }), b = acct('TheFullMonty', { Thieving: 99 });
    expect(ids(plan(inputs([a, b])))).toEqual({ TheFullMonty: 'goldfarm@2582,3297', UnderMyKilt: 'goldfarm@2652,3318' });
    const current = new Map([['undermykilt', 'goldfarm@2669,3298'], ['thefullmonty', 'goldfarm@2671,3313']]);
    expect(ids(plan(inputs([a, b], { current })))).toEqual({ TheFullMonty: 'goldfarm@2671,3313', UnderMyKilt: 'goldfarm@2669,3298' });
    // A held spot another side now claims is taken: the account moves, the other keeps its own.
    expect(ids(plan(inputs([a, b], { current, taken: { 'knight:2669,3298': 1 } })))).toEqual({ TheFullMonty: 'goldfarm@2671,3313', UnderMyKilt: 'goldfarm@2582,3297' });
});

test('a farmer keeps its knight place while the spot has room, so sides do not chase each other\'s claims', () => {
    const a = acct('UnderMyKilt', { Thieving: 99 }), current = new Map([['undermykilt', 'goldfarm@2669,3298']]);
    const held = (others: number) => plan(inputs([a], { current, capacity: CAPACITY, shared: SHARED, taken: { 'knight:2669,3298': others } }));
    // Two other farmers on its spot while four spots stand empty: it stays.
    expect(ids(held(2))).toEqual({ UnderMyKilt: 'goldfarm@2669,3298' });
    // A full spot (KNIGHT_SHARE other farmers) moves it to an empty spot.
    expect(ids(held(KNIGHT_SHARE)).UnderMyKilt).toMatch(/^goldfarm@/);
    expect(ids(held(KNIGHT_SHARE)).UnderMyKilt).not.toBe('goldfarm@2669,3298');
    // An account with no place still takes an empty spot over the crowded one.
    const fresh = plan(inputs([acct('NewA', { Thieving: 99 })], { capacity: CAPACITY, shared: SHARED, taken: { 'knight:2669,3298': 2 } }));
    expect(ids(fresh).NewA).not.toBe('goldfarm@2669,3298');
});

test('a server outage is a drain: a socket error at login or a stalled tick stream never retires a job', () => {
    const login = 'RESULT fail login: [object WebSocket]', stall = 'RESULT fail TickStallError: tick stream stalled: no new game tick for 15000ms';
    expect(assess([login, login, stall, stall])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 4 });
    expect(assess(['RESULT fail no chickens', login, stall, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 2 });
    expect(assess(['RESULT fail login: LoginError: Account already logged in', 'RESULT fail login: LoginError: Account already logged in']).retire).toBe(true);
});
test('an offline login server or unavailable swarm claim is a drain, not a broken worker', () => {
    const offline = 'RESULT fail login: LoginError: Login server offline';
    const claim = 'RESULT fail login: Error: fleet swarm claim authority unavailable or changed: rejected HEAD -> fleet-trade-claim/worker';
    expect(assess([offline, offline, claim, claim])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 4 });
    expect(assess(['RESULT fail no chickens', offline, claim, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 2 });
    expect(assess(['RESULT fail login: LoginError: Invalid password', 'RESULT fail login: LoginError: Invalid password'])).toMatchObject({ retire: true, fail: 2, drains: 0 });
});
test('a run that ended on a stop file is a drain: the job was stopped, it did not fail', () => {
    const inner = 'RESULT fail quest-sweep murder Error: worker finished: stop file', outer = 'RESULT fail stop file quest-chain done=drunkmonk failed=murder';
    expect(assess([inner, outer])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 2 });
    expect(assess(['  | ' + inner, outer, 'RESULT fail stop file'])).toMatchObject({ retire: false, fail: 0, drains: 3 });
    // Real fails around a stop still count.
    expect(assess(['RESULT fail no chickens', outer, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
});

test('a login refused while a dropped session holds the fleet claim is a drain, not a failure', () => {
    const held = 'RESULT fail Error: fleet account claim held by swarm';
    expect(assess([held, held, held])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 3 });
    expect(assess(['RESULT fail fleet account claim held by swarm'])).toMatchObject({ fail: 0, drains: 1 });
    expect(assess(['RESULT fail no chickens', held, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
});

test('a held account refusing logins after a drop is a drain: the refusal as the worker logs it (`login: Error: …`) never retires the spot', () => {
    const drop = 'RESULT fail session ended: disconnected', held = 'RESULT fail login: Error: fleet account claim held by swarm';
    expect(assess([drop, held, held, held])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 4 });
    expect(assess(['RESULT fail no chickens', held, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
});
test('a run the gateway dropped is a drain, not a failure: two drains keep the job, two real fails after them retire it', () => {
    const drain = 'RESULT fail session ended: disconnected';
    expect(assess([drain, drain])).toMatchObject({ retire: false, ok: 0, fail: 0, drains: 2 });
    expect(assess(['RESULT fail no chickens', drain, 'RESULT fail no chickens'])).toMatchObject({ retire: true, fail: 2, drains: 1 });
    expect(assess(['RESULT fail no chickens', drain, 'RESULT ok feathers=30 gained=30'])).toMatchObject({ retire: false, ok: 1, fail: 1, drains: 1 });
});

test('goal bands go only to army accounts, before any coin job, earliest band first and nearest target first', () => {
    const band = (id: string, n: number, skill: string, to: number, extra: Partial<Template> = {}): Template => ({ id, family: 'combat-train', script: 'scripts/gather-combat.ts', role: 'combat',
        goal: `${skill} to ${to}`, tier: 'goal', band: n, trains: { skill, to, unlocks: [] }, yields: () => [], resources: ['giant:edge'], ...extra });
    const bands = [band('str60', 0, 'Strength', 60), band('att60', 1, 'Attack', 60)];
    const farm = catalogue().filter(t => t.family === 'goldfarm');
    const thief = (name: string, skills: Record<string, number> = {}) => acct(name, { Thieving: 99, ...skills });
    const army = new Set(['nearer', 'farther']);
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => ids(plan(inputs(accounts, { templates: [...bands, ...farm], army, capacity: { 'giant:edge': 1 }, ...extra })));
    // An army account trains even though goldfarm pays coins; a specialist off the roster keeps farming.
    expect(run([thief('Nearer'), thief('Specialist')])).toEqual({ Nearer: 'str60', Specialist: expect.stringMatching(/^goldfarm@/) });
    // One giant place, shared by both bands: the account nearest its band target takes it, and the other, with no free
    // band left, falls to the coin tier rather than idling.
    expect(run([thief('Nearer', { Strength: 50 }), thief('Farther', { Strength: 10 })])).toEqual({ Nearer: 'str60', Farther: expect.stringMatching(/^goldfarm@/) });
    // A met band is skipped: Strength 60 goes on to Attack.
    expect(run([thief('Nearer', { Strength: 60 })])).toEqual({ Nearer: 'att60' });
    // Kit money: a band an account cannot pay for is funded by a donor of its side, or left to the coin tier.
    const kit = [band('str60', 0, 'Strength', 60, { needs: { items: { coins: 100_000 } } })];
    expect(ids(plan(inputs([thief('Nearer')], { templates: [...kit, ...farm], army })))).toEqual({ Nearer: expect.stringMatching(/^goldfarm@/) });
    const funded = plan(inputs([thief('Nearer')], { templates: [...kit, ...farm], army, donors: [{ name: 'Bank', coins: 1_000_000 }] }));
    expect(funded[0]).toMatchObject({ template: { id: 'str60' }, fund: { from: 'Bank', to: 'Nearer', coins: 100_000 } });
});

test('the Ardougne cow bands train army accounts, fresh ones too, with 14 HP of food and the bronze kit, as repeating jobs', () => {
    const kit = { trout: 2, 'bronze sword': 1, 'wooden shield': 1 };
    const fighter = (name: string, skills: Record<string, number>, items: Record<string, number> = kit) => acct(name, { Thieving: 99, ...skills }, items);
    const holders = Array.from({ length: COW_FIELD_CAPACITY }, (_, i) => `Holder${i + 1}`);
    const army = new Set(['cowhand', 'pure', 'broke', ...holders.map(h => h.toLowerCase())]);
    const run = (accounts: Acct[]) => plan(inputs(accounts, { army, capacity: CAPACITY }));
    const pick = (accounts: Acct[]) => ids(run(accounts));
    // Strength, Attack, then Defence to 45; then each on through 60, 70, 80, 90 and 99; then the coin tier.
    expect(pick([fighter('Cowhand', { Hitpoints: 35 })])).toEqual({ Cowhand: 'army-cow-strength-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45 })])).toEqual({ Cowhand: 'army-cow-attack-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45, Attack: 45 })])).toEqual({ Cowhand: 'army-cow-defence-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 45, Attack: 45, Defence: 45 })])).toEqual({ Cowhand: 'army-cow-strength-60' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 60, Attack: 60, Defence: 60 })])).toEqual({ Cowhand: 'army-cow-strength-70' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 70, Attack: 61, Defence: 60 })])).toEqual({ Cowhand: 'army-cow-attack-70' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 99, Attack: 99, Defence: 90 })])).toEqual({ Cowhand: 'army-cow-defence-99' });
    expect(pick([fighter('Cowhand', { Hitpoints: 35, Strength: 99, Attack: 99, Defence: 99 })]).Cowhand).toMatch(/^goldfarm@/);
    expect(COW_BANDS.map(b => b.band)).toEqual([0, 1, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
    // A first pass outranks a second: a fresh account takes a place from a holder training past 45.
    const second = { Hitpoints: 50, Strength: 50, Attack: 45, Defence: 45 };
    const current = new Map(holders.map(h => [h.toLowerCase(), 'army-cow-strength-60']));
    const pass = ids(plan(inputs([fighter('Cowhand', { Hitpoints: 35 }), ...holders.map(h => fighter(h, second))], { army, capacity: CAPACITY, current })));
    expect(pass.Cowhand).toBe('army-cow-strength-45');
    expect(Object.values(pass).filter(id => id === 'army-cow-strength-60')).toHaveLength(COW_FIELD_CAPACITY - 1);
    // With no giant band, a range pure at Hitpoints 82 trains Strength on the cows too; Hitpoints 10 has too little
    // food margin and farms.
    expect(pick([fighter('Pure', { Hitpoints: 82 })])).toEqual({ Pure: 'army-cow-strength-45' });
    expect(pick([fighter('Cowhand', { Hitpoints: 10 })])).toEqual({ Cowhand: 'army-cow-strength-45' });
    // Cake counts by its bites: a 2/3 cake and a slice heal 12 HP, short of 14, and the account farms; add a whole cake
    // (pack or bank) and it trains.
    const bronze = { 'bronze sword': 1, 'wooden shield': 1 };
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { ...bronze, '2/3 cake': 1, 'slice of cake': 1 })]).Broke).toMatch(/^goldfarm@/);
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { ...bronze, '2/3 cake': 1, 'slice of cake': 1, cake: 1 })])).toEqual({ Broke: 'army-cow-strength-45' });
    expect(pick([fighter('Broke', { Hitpoints: 35 }, { trout: 2 })]).Broke).toMatch(/^goldfarm@/);
    // The field takes COW_FIELD_CAPACITY (six); one more army account farms.
    expect(COW_FIELD_CAPACITY).toBe(6);
    const full = pick([fighter('Cowhand', { Hitpoints: 35 }), ...holders.map((h, i) => fighter(h, { Hitpoints: 36 + i }))]);
    expect(Object.values(full).filter(id => id.startsWith('army-cow-'))).toHaveLength(COW_FIELD_CAPACITY);
    // Cow mode runs a fixed 8 kills, so its job repeats until the band's target moves the account on.
    const job = jobFor(run([fighter('Cowhand', { Hitpoints: 35 })])[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['3000', 'cow'], env: { TRAIN_SKILL: 'Strength', COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1' }, repeat: true, resources: ['cow:ardougne-north'] });
});

test('army accounts at 60 in all three melee skills train to 99 on the Khazard troopers when they hold 10 fish', () => {
    const ready = Array.from({ length: TROOPER_FIELD_CAPACITY + 1 }, (_, i) => `Ready${i + 1}`);
    const army = new Set(['soldier', 'young', ...ready.map(n => n.toLowerCase())]);
    const kit = { 'bronze sword': 1, 'wooden shield': 1, cake: 2 };
    const soldier = (name: string, items: Record<string, number> = { ...kit, shark: 10 }, skills: Record<string, number> = {}) =>
        acct(name, { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 84, ...skills }, items);
    const pick = (accounts: Acct[]) => ids(plan(inputs(accounts, { army, capacity: CAPACITY })));
    expect(pick([soldier('Soldier')])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // An account that cannot steal (Thieving under 5) needs 10 pieces of stock. Any mix of the fish, cooked meat and
    // the baker's stall food counts; short of that it stays on the cows.
    const honest = { Thieving: 1 };
    expect(pick([soldier('Soldier', { ...kit, shark: 4, lobster: 3, swordfish: 2, trout: 1 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, shark: 4, 'cooked meat': 6 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, bread: 4, 'slice of cake': 6 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // The kit's two cakes count as two pieces.
    expect(pick([soldier('Soldier', { ...kit, shark: 7 }, honest)])).toEqual({ Soldier: 'army-cow-strength-70' });
    expect(pick([soldier('Soldier', { ...kit, shark: 8 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    // The raw beef a cow leaver banked counts: the trooper job cooks it first (TROOPER_COOK).
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 300 }, honest)])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', { ...kit, 'raw beef': 7 }, honest)])).toEqual({ Soldier: 'army-cow-strength-70' });
    // With Thieving 5 the job steals its food at the baker's stalls, so it starts with none.
    expect(pick([soldier('Soldier', kit, { Thieving: 5 })])).toEqual({ Soldier: 'army-trooper-strength-99' });
    expect(pick([soldier('Soldier', kit, { Thieving: 4 })])).toEqual({ Soldier: 'army-cow-strength-70' });
    // Strength, Attack, then Defence; an account under 60 in any of them finishes the cow passes to 60 first.
    expect(pick([soldier('Soldier', undefined, { Strength: 99 })])).toEqual({ Soldier: 'army-trooper-attack-99' });
    expect(pick([soldier('Young', undefined, { Attack: 45, Strength: 45, Defence: 45 })])).toEqual({ Young: 'army-cow-strength-60' });
    // The battlefield takes TROOPER_FIELD_CAPACITY; one more ready account trains on the cows.
    expect(TROOPER_FIELD_CAPACITY).toBe(14);
    const full = pick(ready.map(n => soldier(n)));
    expect(Object.values(full).filter(id => id.startsWith('army-trooper-'))).toHaveLength(TROOPER_FIELD_CAPACITY);
    expect(Object.values(full).filter(id => id === 'army-cow-strength-70')).toHaveLength(1);
    const job = jobFor(plan(inputs([soldier('Soldier')], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'], env: { TRAIN_SKILL: 'Strength', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
});
test('injured trooper entries acquire food while healthy thieves and owned food retain their valid entry', () => {
    const template = catalogue().find(t => t.id === 'army-trooper-ranged-99')!;
    const templates = [template], market = { trout: { id: 333, name: 'Trout', limit: 100 } }, army = new Set(['archer']);
    const archer = (currentHP: number | undefined, food = 0): Acct => ({
        ...acct('Archer', { Hitpoints: 99, Defence: 99, Ranged: 70, Thieving: 99 }, { shortbow: 1, 'bronze arrow': 100, coin: 100_000, trout: food }), currentHP,
    });
    const pick = (a: Acct, extra: Partial<Inputs> = {}) => plan(inputs([a], { templates, army, market, ...extra }))[0]!;
    for (const hp of [29, 50, undefined]) {
        const out = pick(archer(hp));
        expect(out.template?.id).toBe('kit-buy:army-trooper-ranged-99');
        expect(out.template?.args?.join(' ')).toContain('ITEM_ID=333');
        expect(out.template?.args?.join(' ')).toContain('QUANTITY=100');
        expect(pick(archer(hp, 10)).template?.id).toBe(template.id);
    }
    expect(pick(archer(51)).template?.id).toBe(template.id);
    const sent = pick(archer(29), { market: {}, stock: [{ name: 'Donor', side, items: { trout: 50 } }] });
    expect(sent.send).toMatchObject({ from: 'Donor', to: 'Archer', item: 'trout', template: template.id });
    expect(sent.send?.count).toBeGreaterThan(0);
    expect(sent.send?.count).toBeLessThanOrEqual(50);
    const held = pick(archer(29), { current: new Map([['archer', template.id]]), running: new Set(['archer']) });
    expect(held.template?.id).toBe(template.id);
    expect(held.send).toBeUndefined();
});

test('army accounts alch Magic to 99 with natures, feathers and fire, then bury held bones for Prayer', () => {
    const army = new Set(['caster']);
    const melee = { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 84, Magic: 48, Prayer: 74 };
    const pick = (skills: Record<string, number>, items: Record<string, number>) => ids(plan(inputs([acct('Caster', { ...melee, ...skills }, items)], { army, capacity: CAPACITY }))).Caster;
    const alch = { 'nature rune': 50, feather: 50 };
    // Magic comes before the troopers and the later cow passes; fire is 250 runes or any fire staff.
    expect(pick({}, { ...alch, 'fire rune': 250, shark: 20 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'staff of fire': 1 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'mystic fire staff': 1 })).toBe('army-alch-magic-99');
    expect(pick({}, { ...alch, 'fire rune': 249 })).not.toBe('army-alch-magic-99');
    expect(pick({}, { 'nature rune': 49, feather: 50, 'fire rune': 250 })).not.toBe('army-alch-magic-99');
    // Below Magic 21 the Wind Strike start comes first, one account at a time on its tile; it needs only mind and air runes.
    const strike = { 'mind rune': 35, 'air rune': 35 };
    expect(pick({ Magic: 1 }, { ...alch, 'fire rune': 250, ...strike })).toBe('army-strike-magic-21');
    expect(pick({ Magic: 20 }, strike)).toBe('army-strike-magic-21');
    expect(pick({ Magic: 1 }, { ...alch, 'fire rune': 250, 'mind rune': 34, 'air rune': 35 })).not.toBe('army-strike-magic-21');
    expect(pick({ Magic: 21 }, { ...alch, 'fire rune': 250, ...strike })).toBe('army-alch-magic-99');
    const pair = ids(plan(inputs(['Caster', 'Second'].map(n => acct(n, { ...melee, Magic: 1 }, strike)), { army: new Set(['caster', 'second']), capacity: CAPACITY })));
    expect(Object.values(pair).filter(id => id === 'army-strike-magic-21')).toHaveLength(1);
    expect(CAPACITY[STRIKE_TILE]).toBe(1);
    // Prayer comes next and needs 100 bones (accountFrom keys items by norm, so Bones is 'bone'); with fewer it moves on.
    expect(pick({ Magic: 99 }, { bone: 1674 })).toBe('army-bury-prayer-99');
    expect(pick({}, { bone: 1674 })).toBe('army-bury-prayer-99');
    expect(pick({ Magic: 99 }, { bone: 99 })).not.toBe('army-bury-prayer-99');
    expect(pick({ Magic: 99, Prayer: 99 }, { bone: 1674 })).not.toBe('army-bury-prayer-99');
    const job = jobFor(plan(inputs([acct('Caster', { ...melee, Magic: 99 }, { bone: 500 })], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000', AUTOPILOT_ORDER:'0' }, repeat: false, resources: [] });
});

test('prayer bands do not repeat on preserved bone notes after normal stock is spent', () => {
    const templates = catalogue().filter(t => ['army-bury-prayer-99', 'army-bury-big-99', 'army-bury-dragon-99'].includes(t.id));
    const skills = [{ name: 'Prayer', level: 68 }, { name: 'Magic', level: 99 }, { name: 'Ranged', level: 99 }];
    const observed = (id: number, name: string, bank: number, normal = 0) => accountFrom('Monk', side, {
        at: 2000, bankAt: 1990, skills,
        inventory: [{ id: id + 1, baseId: id, name, count: 94 }, ...(normal ? [{ id, baseId: id, name, count: normal }] : [])],
        bank: [{ id, baseId: id, name, count: bank }],
    }, () => undefined);
    const pick = (a: Acct, current: string) => plan(inputs([a], { army: new Set(['monk']), templates, current: new Map([['monk', current]]) }))[0]!;
    const normal = observed(526, 'Bones', 6);
    expect(pick(normal, 'army-bury-prayer-99').template).toBeUndefined();
    expect(normal.items.bone).toBe(100);
    expect(normal.items['bone (unnoted)']).toBe(6);
    // The 100 normal-bone start and six-bone reserve stay unchanged.
    const restocked = pick(observed(526, 'Bones', 6, 94), 'army-bury-prayer-99');
    expect(restocked.template?.id).toBe('army-bury-prayer-99');
    expect(jobFor(restocked, side)).toMatchObject({ env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' } });
    // Other workers keep their existing handling of noted inputs.
    const feathers = accountFrom('Monk', side, { inventory: [{ id: 315, baseId: 314, name: 'Feather', count: 94 }], bank: [{ id: 314, name: 'Feather', count: 6 }] }, () => undefined);
    expect(feathers.items.feather).toBe(100);
});

test('army accounts train Ranged to 99 on the troopers with a bow they wield and 100 arrows it fires', () => {
    const army = new Set(['archer']);
    const base = { Thieving: 99, Attack: 69, Strength: 60, Defence: 61, Hitpoints: 62, Magic: 99, Prayer: 99, Ranged: 1 };
    const pick = (skills: Record<string, number>, items: Record<string, number>) => ids(plan(inputs([acct('Archer', { ...base, ...skills }, items)], { army, capacity: CAPACITY }))).Archer;
    const fish = { shark: 20 };
    expect(pick({}, { ...fish, shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...fish, longbow: 1, 'bronze arrow': 100 })).toBe('army-trooper-ranged-99');
    // A yew bow needs Ranged 40; a shortbow cannot fire rune arrows; 99 arrows are too few; no fish, no band.
    expect(pick({}, { ...fish, 'yew shortbow': 1, 'rune arrow': 500 })).toBe('army-trooper-strength-99');
    expect(pick({ Ranged: 40 }, { ...fish, 'yew shortbow': 1, 'rune arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...fish, shortbow: 1, 'rune arrow': 500 })).toBe('army-trooper-strength-99');
    expect(pick({}, { ...fish, shortbow: 1, 'iron arrow': 99 })).toBe('army-trooper-strength-99');
    expect(pick({ Thieving: 1 }, { shortbow: 1, 'iron arrow': 500 })).not.toBe('army-trooper-ranged-99');
    // A thief feeds itself, so the bow and arrows are all it needs.
    expect(pick({}, { shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 99 }, { ...fish, shortbow: 1, 'iron arrow': 500 })).toBe('army-trooper-strength-99');
    const job = jobFor(plan(inputs([acct('Archer', base, { ...fish, shortbow: 1, 'iron arrow': 500 })], { army, capacity: CAPACITY }))[0]!, side);
    expect(job).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'], env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
    // The band holds a place on the trooper field only, so every kitted account trains at once.
    const archers = ['Archer', 'Bowman', 'Fletcher'].map(n => acct(n, base, { ...fish, shortbow: 1, 'iron arrow': 500 }));
    expect(Object.values(ids(plan(inputs(archers, { army: new Set(['archer', 'bowman', 'fletcher']), capacity: CAPACITY }))))).toEqual(Array(3).fill('army-trooper-ranged-99'));
});

import { xpForLevel } from '../src/curve';
import { KIT_BUY, KIT_CASH_RESERVE, KIT_COIN_MARGIN, KIT_PRICE_CAPS, kitLacks, kitReserve, type Market, type Stock } from '../src/autopilot';
const market: Market = { 'mind rune': { id: 558, name: 'Mind rune', limit: KIT_PRICE_CAPS['mind rune']! }, 'air rune': { id: 556, name: 'Air rune', limit: KIT_PRICE_CAPS['air rune']! },
    'nature rune': { id: 561, name: 'Nature rune', limit: KIT_PRICE_CAPS['nature rune']! }, trout: { id: 333, name: 'Trout', limit: KIT_PRICE_CAPS.trout! },
    'bronze arrow': { id: 882, name: 'Bronze arrow', limit: KIT_PRICE_CAPS['bronze arrow']! } };
const strike = () => catalogue().filter(t => t.id === 'army-strike-magic-21' || t.family === 'goldfarm');
// The band alone: an account with no other job to start.
const bandOnly = () => strike().filter(t => t.tier === 'goal');
const mage = (name: string, items: Record<string, number>, skills: Record<string, number> = {}) => acct(name, { Thieving: 99, ...skills }, items);

test('kit lines: what an account lacks, the smallest of several kits, and null when a level stops the job', () => {
    const band = catalogue().find(t => t.id === 'army-strike-magic-21')!, ranged = catalogue().find(t => t.id === 'army-trooper-ranged-99')!;
    expect(kitLacks(acct('A', {}, { 'mind rune': 15, 'air rune': 25 }), band.needs)).toEqual([{ of: ['mind rune'], count: 20 }, { of: ['air rune'], count: 10 }]);
    expect(kitLacks(acct('A', {}, { 'mind rune': 35, 'air rune': 35 }), band.needs)).toEqual([]);
    // Hitpoints 40 and Defence 60 are levels, not kit lines.
    expect(kitLacks(acct('A', { Hitpoints: 39, Defence: 60 }, {}), ranged.needs)).toBeNull();
    expect(kitLacks(acct('A', { Hitpoints: 40, Defence: 59 }, { shortbow: 1, 'bronze arrow': 500, shark: 20 }), ranged.needs)).toBeNull();
    // A shortbow with 25 bronze arrows is the nearest ranged kit: 75 arrows short, and 10 pieces of food for an account
    // that cannot steal them.
    const stock = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake', 'raw beef'];
    expect(kitLacks(acct('A', { Hitpoints: 40, Defence: 60 }, { shortbow: 1, 'bronze arrow': 25 }), ranged.needs)).toEqual([{ of: ['bronze arrow'], count: 75 }, { of: stock, count: 10 }]);
    expect(kitLacks(acct('A', { Hitpoints: 40, Defence: 60, Thieving: 5 }, { shortbow: 1, 'bronze arrow': 25 }), ranged.needs)).toEqual([{ of: ['bronze arrow'], count: 75 }]);
    expect(kitReserve(catalogue())).toMatchObject({ 'mind rune': 35, 'air rune': 50, 'nature rune': 50, feather: 50, bone: 100 });
});

test('a rich army account buys its missing kit with its own coins in one login, in place of a coin job', () => {
    const army = new Set(['rich']), rich = mage('Rich', { coin: 5_000_000, 'mind rune': 15, 'air rune': 25 });
    // No market and no donor: a coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
    // In a running coin job (unfundable) it still takes the buy: a buy needs no trade partner.
    const [x] = plan(inputs([rich], { templates: strike(), army, market, unfundable: new Set(['rich']) }));
    expect(x!.template!.id).toBe(KIT_BUY + 'army-strike-magic-21');
    expect(x!.template!.script).toBe('scripts/chain.ts');
    expect(x!.template!.args).toEqual([
        'scripts/buy-owned-ge-item.ts ITEM_ID=558 QUANTITY=20 EXPECTED_OWNED=15 LIMIT_PRICE=120 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-558-15to35 ORDER_MS=900000 FILL_WAIT_TICKS=200',
        'scripts/buy-owned-ge-item.ts ITEM_ID=556 QUANTITY=10 EXPECTED_OWNED=25 LIMIT_PRICE=160 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-556-25to35 ORDER_MS=900000 FILL_WAIT_TICKS=200']);
    expect(jobFor(x!, side)).toMatchObject({ repeat: false, standing: true, template: KIT_BUY + 'army-strike-magic-21', env: { ROUNDS: '1' } });
    // With the kit held it takes the band.
    expect(ids(plan(inputs([mage('Rich', { coin: 5_000_000, 'mind rune': 35, 'air rune': 35 })], { templates: strike(), army, market })))).toEqual({ Rich: 'army-strike-magic-21' });
    // The band's place is full: no kit for it, and the account keeps a coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army, market, capacity: CAPACITY, taken: { [STRIKE_TILE]: 1 } })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
    // An account off the roster keeps its coin job.
    expect(ids(plan(inputs([rich], { templates: strike(), army: new Set(), market })))).toEqual({ Rich: expect.stringMatching(/^goldfarm@/) });
});

// The alchemy band's consumables for the casts left to Magic 99 (src/alch-plan.ts): Magic 30 casts 637 times.
const ALCH30 = alchSupplies(30);
test('a kit buy brings the batch, not one start: the nature runes for the casts left to Magic 99', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const [x] = plan(inputs([mage('Rich', { coin: 5_000_000, 'nature rune': 10, feather: 500, 'staff of fire': 1 }, { Magic: 30 })], { templates: alch, army, market }));
    expect(x!.template!.args).toEqual([`scripts/buy-owned-ge-item.ts ITEM_ID=561 QUANTITY=${ALCH30.nature - 10} EXPECTED_OWNED=10 LIMIT_PRICE=800 CASH_RESERVE=1000 ORDER_KEY=rich-kit0-561-10to${ALCH30.nature} ORDER_MS=900000 FILL_WAIT_TICKS=200`]);
    expect(x!.reason).toContain(`at most ${(ALCH30.nature - 10) * 800} coins`);
});

test('an account that cannot pay gets the coins first: from this side, else from a free account of another side', () => {
    const army = new Set(['poor']), poor = mage('Poor', { coin: 100, 'mind rune': 15, 'air rune': 25 }), cost = 20 * 120 + 10 * 160, short = cost + KIT_CASH_RESERVE + KIT_COIN_MARGIN - 100;
    const own = plan(inputs([poor], { templates: strike(), army, market, donors: [{ name: 'Bank', coins: 1_000_000 }] }))[0]!;
    expect(own.fund).toEqual({ from: 'Bank', to: 'Poor', coins: short, template: KIT_BUY + 'army-strike-magic-21' });
    // Another side's coins only for an account with no job it can start: with a coin job open it keeps that.
    const far: Stock[] = [{ name: 'CloudBank', side: 'local', items: { coin: 2_000_000 } }];
    expect(ids(plan(inputs([poor], { templates: strike(), army, market, stock: far })))).toEqual({ Poor: expect.stringMatching(/^goldfarm@/) });
    expect(plan(inputs([poor], { templates: bandOnly(), army, market, stock: far }))[0]!.fund).toEqual({ from: 'CloudBank', to: 'Poor', coins: short, template: KIT_BUY + 'army-strike-magic-21' });
    // A running job is never funded: the trade could not reach the account.
    expect(ids(plan(inputs([poor], { templates: strike(), army, market, stock: far, unfundable: new Set(['poor']) })))).toEqual({ Poor: expect.stringMatching(/^goldfarm@/) });
});

test('with no buy, a free account sends the item: this side first, another side next, and never from its own kit', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 });
    const stock: Stock[] = [{ name: 'Far', side: 'local', items: { 'mind rune': 400 } }, { name: 'Near', side, items: { 'mind rune': 60 } }, { name: 'Thin', side, items: { 'mind rune': 54 } }];
    const run = (extra: Partial<Inputs>) => plan(inputs([needy], { templates: strike(), army, ...extra }))[0]!;
    // Near holds 60 and keeps the band's 35: 25 spare covers the 20.
    expect(run({ stock }).send).toEqual({ from: 'Near', to: 'Needy', item: 'mind rune', count: 20, template: 'army-strike-magic-21' });
    // Thin holds 54: 19 spare is one short. Another side gives only to an account with no job it can start (live:
    // 13 of 14 accounts stood parked for another side's sends); with a coin job open the account keeps that.
    expect(run({ stock: [stock[0]!, stock[2]!] }).template!.id).toMatch(/^goldfarm@/);
    expect(run({ stock: [stock[0]!, stock[2]!], templates: bandOnly() }).send).toMatchObject({ from: 'Far' });
    expect(run({ stock: [stock[2]!] }).template!.id).toMatch(/^goldfarm@/);
    // Spare local stock also supplies an account that could afford a purchase.
    const paying = { accounts: [mage('Needy', { ...needy.items, coin: 1_000_000 })] };
    expect(run({ ...paying, stock, market }).send).toMatchObject({ from: 'Near' });
    expect(run({ ...paying, stock, market, retired: new Set([pairKey('Needy', KIT_BUY + 'army-strike-magic-21')]) }).send).toMatchObject({ from: 'Near' });
});

test('an army account in a coin job leaves it for a kit order; one on a band or a kit buy stays', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 }), stock: Stock[] = [{ name: 'Near', side, items: { 'mind rune': 60 } }];
    const run = (current: string) => plan(inputs([needy], { templates: [...strike(), ...catalogue().filter(t => t.id === 'army-bury-prayer-99')], army, stock, unfundable: new Set(['needy']), current: new Map([['needy', current]]) }))[0]!;
    const left = run('goldfarm@2652,3318');
    expect(left.template).toBeUndefined();
    expect(left.reason).toBe('vacant: leaves its job for 20 mind rune from Near for army-strike-magic-21');
    expect(run('army-bury-prayer-99').template!.id).toMatch(/^goldfarm@/);
    expect(run(KIT_BUY + 'army-strike-magic-21').template!.id).toMatch(/^goldfarm@/);
});

test('a donor that gives a kit item takes no job on that pass', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 }), near = mage('Near', { 'mind rune': 60 });
    const out = plan(inputs([needy, near], { templates: strike(), army, stock: [{ name: 'Near', side, items: near.items }] }));
    expect(out.find(x => x.account === 'Needy')!.send).toMatchObject({ from: 'Near', count: 20 });
    const giver = out.find(x => x.account === 'Near')!;
    expect(giver.template).toBeUndefined();
    expect(giver.reason).toBe('vacant: gives a kit item this pass');
});

test('held coins cover a finite purchase bill so the planner supplies the missing item', () => {
    const thief = acct('Thief', { Thieving: 99 }, { coin: 5_000_000 }), shortTips = [row('rune arrowtips', 1588)];
    expect(ids(plan(inputs([thief], { bill: shortTips })))['Thief']).toBe('shop-arrowtips');
    expect(ids(plan(inputs([thief], { bill: shortTips, templates: catalogue().filter(t => t.family === 'goldfarm') })))['Thief']).toBe('vacant');
});

test('a kit buy RESULT with "died":false is not a death, and a real death still is', () => {
    const ok = '  | RESULT ok {"ok":true,"phase":"settled","acquired":30,"died":false,"damaged":false}';
    expect(assess([ok])).toMatchObject({ retire: false, ok: 1 });
    expect(assess(['RESULT fail {"ok":false,"died":true}']).retire).toBe(true);
    expect(assess(['RESULT fail died after 1 runs']).retire).toBe(true);
    expect(assess(['RESULT ok ticks=9001 died=false']).retire).toBe(false);
});

test('a later top-up from the same holding gets a new order key', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const rich = mage('Rich', { coin: 5_000_000, feather: 500, 'staff of fire': 1 }, { Magic: 30 });
    const key = (kitSeq?: Map<string, number>) => plan(inputs([rich], { templates: alch, army, market, kitSeq }))[0]!.template!.args![0]!.match(/ORDER_KEY=(\S+)/)![1];
    expect(key()).toBe(`rich-kit0-561-0to${ALCH30.nature}`);
    expect(key(new Map([['rich', 3]]))).toBe(`rich-kit3-561-0to${ALCH30.nature}`);
});

test('with no fire staff the alchemy kit buys fire runes, not a staff no market sells', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['rich']);
    const full: Market = { ...market, 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! }, feather: { id: 314, name: 'Feather', limit: KIT_PRICE_CAPS.feather! } };
    const [x] = plan(inputs([mage('Rich', { coin: 5_000_000 }, { Magic: 30 })], { templates: alch, army, market: full }));
    expect(x!.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(x!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).join('x'))).toEqual([`561x${ALCH30.nature}`, `314x${ALCH30.item}`, `554x${ALCH30.fire}`]);
    // With no rule for what it can get, the nearest kit is the one-item staff.
    const band = alch[0]!;
    expect(kitLacks(mage('Rich', {}, { Magic: 30 }), band.needs)!.at(-1)).toEqual({ of: ['staff of fire'], count: 1 });
    expect(kitLacks(mage('Rich', {}, { Magic: 30 }), band.needs, i => !/staff/.test(i))!.at(-1)).toEqual({ of: ['fire rune'], count: 250 });
});

test('a market quote cannot hide a compatible donor kit when the account cannot afford the buy', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99');
    const caster = mage('Caster', { 'nature rune': 50, feather: 50 }, { Magic: 30 }), army = new Set(['caster']);
    const fire: Market = { 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! } };
    for (const donorSide of [side, 'local']) {
        const stock = [{ name: 'StaffMule', side: donorSide, items: { 'staff of fire': 2 } }];
        for (const market of [{}, fire]) {
            const [next] = plan(inputs([caster], { templates, army, stock, market }));
            expect(next!.send).toEqual({ from: 'StaffMule', to: 'Caster', item: 'staff of fire', count: 1, template: 'army-alch-magic-99' });
        }
        expect(plan(inputs([caster], { templates, army, stock: [{ ...stock[0]!, items: { 'staff of fire': 1 } }], market: fire }))[0]!.send).toBeUndefined();
    }
});

test('available owned kit stock supplies a free recipient before an affordable market alternative', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99');
    const caster = mage('Caster', { coin: 50_000, 'nature rune': 50, feather: 50 }, { Magic: 30 });
    const market: Market = { 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! } };
    const [next] = plan(inputs([caster], { templates, army: new Set(['caster']), market, stock: [{ name: 'StaffMule', side, items: { 'staff of fire': 2 } }] }));
    expect(next!.send).toEqual({ from: 'StaffMule', to: 'Caster', item: 'staff of fire', count: 1, template: 'army-alch-magic-99' });
    const [reserved] = plan(inputs([caster], { templates, army: new Set(['caster']), market, stock: [{ name: 'StaffMule', side, items: { 'staff of fire': 1 } }] }));
    expect(reserved!.send).toBeUndefined();
    // The coins reach more than the 250 fire runes a start needs: the buy takes the share of the batch they pay for.
    expect(Number(reserved!.template!.args![0]!.match(/ITEM_ID=554 QUANTITY=(\d+)/)![1])).toBeGreaterThanOrEqual(250);
});

test('a frail thief receives spare owned food before buying, without a quote or cash', () => {
    const thief = acct('Frail', { Thieving: 99, Hitpoints: 10 });
    const stock = [{ name: 'FoodMule', side, items: { trout: 500 } }];
    const markets: Market[] = [{}, { trout: { id: 333, name: 'Trout', limit: KIT_PRICE_CAPS.trout! } }];
    for (const market of markets) {
        for (const coin of [0, 1_000_000]) {
            const [next] = plan(inputs([{ ...thief, items: { coin } }], { stock, market }));
            expect(next!.send).toMatchObject({ from: 'FoodMule', to: 'Frail', item: 'trout', count: 200 });
        }
    }
    expect(plan(inputs([thief], { stock, bill: [] }))[0]!.send).toBeUndefined();
    const taken = Object.fromEntries(KNIGHT_SPOTS.map(spot => [`knight:${spot}`, 99]));
    expect(plan(inputs([thief], { stock, taken }))[0]!.send).toBeUndefined();
});

test('a ready alchemy shop run cannot preempt a spare owned ingredient for the same band', () => {
    const caster = mage('Caster', { coin: 12_000, 'nature rune': 50, 'staff of fire': 1 }, { Magic: 30 });
    const templates = catalogue().filter(t => ['army-alch-magic-99', 'army-feathers-sarim'].includes(t.id));
    const stock = [{ name: 'FeatherMule', side, items: { feather: 500 } }];
    const opts = { templates, army: new Set(['caster']), stock };
    expect(plan(inputs([caster], opts))[0]!.send).toMatchObject({ from: 'FeatherMule', item: 'feather', count: 450, template: 'army-alch-magic-99' });
    expect(plan(inputs([caster], { ...opts, stock: [] }))[0]!.template?.id).toBe('army-feathers-sarim');
    expect(plan(inputs([caster], { ...opts, stock: [{ ...stock[0]!, side: 'local' }] }))[0]!.template?.id).toBe('army-feathers-sarim');
    expect(plan(inputs([caster], { ...opts, unfundable: new Set(['caster']), running: new Set(['caster']), current: new Map([['caster', 'army-feathers-sarim']]) }))[0]!.send).toBeUndefined();
});

test('shop-only alchemy kit lines can still receive owned air runes without becoming a market buy', () => {
    const caster = mage('Caster', { 'nature rune': 50, 'staff of fire': 1 }, { Magic: 66 });
    const templates = catalogue().filter(t => t.id === 'army-alch-air-magic-99');
    const opts = { templates, army: new Set(['caster']), stock: [{ name: 'AirMule', side, items: { 'air rune': 100 } }] };
    expect(plan(inputs([caster], opts))[0]!.send).toEqual({ from: 'AirMule', to: 'Caster', item: 'air rune', count: 50, template: 'army-alch-air-magic-99' });
    expect(plan(inputs([{ ...caster, items: { ...caster.items, coin: 1_000_000 } }], { ...opts, stock: [], market }))[0]!.template?.id.startsWith(KIT_BUY)).not.toBe(true);
});

test('black dragon shop-supplied arrows and teleport runes accept spare owned stock', () => {
    const maxed = { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD };
    const templates = catalogue().filter(t => t.id === 'army-hunt-black-dragons');
    for (const [item, need] of [['iron arrow', HUNT_ARROWS], ['air rune', 3], ['fire rune', 1]] as const) {
        const hunter = acct('Hunter', maxed, { ...kit, [item]: 0 });
        const stock = [{ name: 'HuntMule', side, items: { [item]: need * 3 } }];
        const [next] = plan(inputs([hunter], { templates, army: new Set(['hunter']), pilots: new Set(['army-hunt-black-dragons']), stock }));
        expect(next!.send).toEqual({ from: 'HuntMule', to: 'Hunter', item, count: need, template: 'army-hunt-black-dragons' });
    }
});

test('a failed owned transfer falls back to a bounded buy without reusing that donor', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99');
    const caster = mage('Caster', { coin: 50_000, 'nature rune': 50, feather: 50 }, { Magic: 30 });
    const market: Market = { 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! } };
    const [next] = plan(inputs([caster], { templates, army: new Set(['caster']), market,
        stock: [{ name: 'StaffMule', side, items: { 'staff of fire': 2 } }], noSend: new Set(['staffmule>caster']) }));
    expect(next!.send).toBeUndefined();
    expect(next!.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
});

test('a demanded non-army crafting batch receives owned ingredients then launches its real worker', () => {
    const t=catalogue().find(t=>t.id==='aio-sapphire-rings')!;
    const crafter=acct('Crafter',{Crafting:20},{'ring mould':1,'gold bar':RING_BATCH});
    const extra:Partial<Inputs>={templates:[t],pilots:new Set([t.id]),bill:[row('sapphire ring',RING_BATCH)],prices:{'sapphire ring':1000},
        stock:[{name:'GemMule',side,items:{sapphire:RING_BATCH*2}}]};
    const [prep]=plan(inputs([crafter],extra));
    expect(prep!.send).toEqual({from:'GemMule',to:'Crafter',item:'sapphire',count:RING_BATCH,template:t.id});
    expect(prep!.template!.id).toBe(t.id);
    const [ready]=plan(inputs([{...crafter,items:{...crafter.items,sapphire:RING_BATCH}}],{...extra,stock:[]}));
    expect(ready!.send).toBeUndefined();
    expect(jobFor(ready!,side)).toMatchObject({script:'scripts/aio.ts',template:t.id,enabled:true});
    expect(jobFor(ready!,side).args).toContain('jewellery-trip');
    expect(plan(inputs([crafter],{...extra,bill:[]}))[0]!.send).toBeUndefined();
    expect(plan(inputs([{...crafter,skills:{Crafting:19}}],extra))[0]!.send).toBeUndefined();
});

test('preparing a finite crafting consumer reserves its output against duplicate transfers', () => {
    const t=catalogue().find(t=>t.id==='aio-sapphire-rings')!;
    const make=(name:string)=>acct(name,{Crafting:20},{'ring mould':1,'gold bar':RING_BATCH});
    const planned=plan(inputs([make('CrafterA'),make('CrafterB')],{templates:[t],pilots:new Set([t.id]),
        bill:[row('sapphire ring',RING_BATCH)],prices:{'sapphire ring':1000},
        stock:[{name:'GemMuleA',side,items:{sapphire:RING_BATCH*2}},{name:'GemMuleB',side,items:{sapphire:RING_BATCH*2}}]}));
    expect(planned.filter(a=>a.send)).toHaveLength(1);
});

test('a quest unlock can receive its missing route item from another owned bank',()=>{
    const templates=catalogue().filter(t=>['aio-quest-runemysteries','aio-essence'].includes(t.id));
    const actor={...acct('Quester',{Mining:20},{'bronze pickaxe':1,trout:4,'law rune':1,'air rune':6,'fire rune':1,'earth rune':1}),quests:new Set<string>()};
    const extra:Partial<Inputs>={templates,pilots:new Set(templates.map(t=>t.id)),bill:[row('rune essence',28)],prices:{'rune essence':50},
        stock:[{name:'RuneMule',side,items:{'law rune':3}}]};
    const [supply]=plan(inputs([actor],extra));
    expect(supply!.send).toEqual({from:'RuneMule',to:'Quester',item:'law rune',count:1,template:'aio-quest-runemysteries'});
    const [quest]=plan(inputs([{...actor,items:{...actor.items,'law rune':2}}],{...extra,stock:[]}));
    expect(quest!.template!.id).toBe('aio-quest-runemysteries');
    const [mine]=plan(inputs([{...actor,quests:new Set(['rune mysteries quest'])}],{...extra,stock:[]}));
    expect(mine!.template!.id).toBe('aio-essence');
});

test('an early kitFirst band uses owned stock before buying while retaining its band priority',()=>{
    const templates=catalogue().filter(t=>['army-splash-magic-66','army-alch-magic-99'].includes(t.id));
    const caster=mage('Caster',{coin:5_000_000,'earth rune':30,'water rune':30,'mind rune':2,'air rune':2,'nature rune':50,feather:50,'staff of fire':1},{Magic:21});
    const extra:Partial<Inputs>={templates,army:new Set(['caster']),pilots:new Set(['army-splash-magic-66']),
        market:{'body rune':{id:559,name:'Body rune',limit:100}},stock:[{name:'BodyMule',side,items:{'body rune':1000}}]};
    const [next]=plan(inputs([caster],extra));
    expect(next!.send).toMatchObject({from:'BodyMule',to:'Caster',item:'body rune',template:'army-splash-magic-66'});
    expect(next!.send!.count).toBeGreaterThanOrEqual(10);
    const [purchase]=plan(inputs([caster],{...extra,stock:[]}));
    expect(purchase!.template!.id).toBe(KIT_BUY+'army-splash-magic-66');
});

test('coin-funded non-army preparation reserves the useful output before funding another maker',()=>{
    const t=catalogue().find(t=>t.id==='aio-steel-bars')!;
    const make=(name:string)=>acct(name,{Smithing:30},{'iron ore':9});
    const planned=plan(inputs([make('SmithA'),make('SmithB')],{templates:[t],pilots:new Set([t.id]),bill:[row('steel bar',9)],prices:{'steel bar':9000},
        market:{coal:{id:453,name:'Coal',limit:600}},donors:[{name:'CashA',coins:100_000},{name:'CashB',coins:100_000}]}));
    expect(planned.filter(a=>a.fund)).toHaveLength(1);
});

test('an owned upgrade weapon supplies an army account before the upgrade market buy',()=>{
    const fighter=acct('Fighter',{Thieving:99,Attack:99,Strength:99,Defence:80,Hitpoints:90,Ranged:99,Magic:99,Prayer:99},{'bronze sword':1,shark:40,coin:1_000_000});
    const cases: Partial<Inputs>[] = [
        {market:{[WEAPON.item]:{id:1331,name:'Adamant scimitar',limit:12_000}}},
        {market:{}},
        {market:{},retired:new Set([pairKey('Fighter',KIT_BUY+WEAPON.id)])},
    ];
    for(const extra of cases){
        const [next]=plan(inputs([fighter],{templates:catalogue().filter(t=>t.id==='army-cow-strength-45'),army:new Set(['fighter']),
            ...extra,stock:[{name:'BladeMule',side,items:{[WEAPON.item]:2}}]}));
        expect(next!.send).toMatchObject({from:'BladeMule',to:'Fighter',item:WEAPON.item,count:1,template:WEAPON.id});
    }
});

test('donor alternatives reconsider quantities and donors taken by an earlier account', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99');
    const accounts = ['CasterA', 'CasterB'].map(name => mage(name, { 'nature rune': 50, feather: 50 }, { Magic: 30 }));
    const market: Market = { 'fire rune': { id: 554, name: 'Fire rune', limit: KIT_PRICE_CAPS['fire rune']! } };
    const stock: Stock[] = [{ name: 'StaffMule', side, items: { 'staff of fire': 2 } }, { name: 'RuneMule', side, items: { 'fire rune': 500 } }];
    const next = plan(inputs(accounts, { templates, army: new Set(['castera', 'casterb']), market, stock }));
    expect(next.map(x => x.send)).toEqual([
        { from: 'StaffMule', to: 'CasterA', item: 'staff of fire', count: 1, template: 'army-alch-magic-99' },
        { from: 'RuneMule', to: 'CasterB', item: 'fire rune', count: 250, template: 'army-alch-magic-99' },
    ]);
    // A donor's retained 250 runes cannot cover the alternative, and the staff can fund only one account.
    const short = plan(inputs(accounts, { templates, army: new Set(['castera', 'casterb']), market, stock: [stock[0]!, { ...stock[1]!, items: { 'fire rune': 499 } }] }));
    expect(short.filter(x => x.send)).toHaveLength(1);
});

test('an army account with no other band to start buys the bones its Prayer still needs, dragon bones first, and buries them', () => {
    const army = new Set(['monk']);
    const bones: Market = { ...market, 'dragon bone': { id: 536, name: 'Dragon bones', limit: KIT_PRICE_CAPS['dragon bone']! }, 'big bone': { id: 532, name: 'Big bones', limit: KIT_PRICE_CAPS['big bone']! } };
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 90 };
    const kit = { shark: 40, 'adamant scimitar': 1 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Monk', { ...maxed, ...s }, { ...kit, ...items })], { army, market: bones, capacity: CAPACITY, ...extra }))[0]!;
    const order = (x: { template?: Template }) => x.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number));
    // What Prayer 90 still needs in dragon bones, and the 6 the trainer keeps.
    const need = BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(90)) / 1800);
    const rich = pick({}, { coin: 5_000_000 });
    expect(rich.template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    expect(order(rich)).toEqual([[536, need]]);
    // An account that cannot pay for all of it buys what it can pay for, with the kit reserve left.
    expect(order(pick({}, { coin: 1_700_398 }))).toEqual([[536, 169]]);
    // A buy for a later band comes before a donor's send for an earlier one: 63 bones held leave the held-bones band
    // 37 short, and another side has them, but the account buys its dragon bones. With no bones on the market the
    // donor sends.
    const donor: Stock[] = [{ name: 'Far', side: 'local', items: { bone: 500 } }], near = pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor });
    expect(near.template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    expect(order(near)).toEqual([[536, BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(97)) / 1800)]]);
    expect(near.send).toBeUndefined();
    const boneBands = catalogue().filter(t => /^army-bury-/.test(t.id));
    expect(pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor, market, templates: boneBands }).send).toEqual({ from: 'Far', to: 'Monk', item: 'bone', count: 37, template: 'army-bury-prayer-99' });
    // With a job it can start (the troopers' field, a coin job) it does not wait for another side.
    expect(pick({ Prayer: 97 }, { coin: 879_278, bone: 63 }, { stock: donor, market }).send).toBeUndefined();
    // An account with Ranged or Magic still to finish keeps BONE_PURSE back for their kits (Magic 92 here, with its
    // alchemy runes and feathers but no fire, and the Magic Guild shop taken, so it has no other band).
    const mage = { 'nature rune': 604, feather: 500 }, guildBusy = { capacity: { ...CAPACITY, 'shop:magic_guild': 0 } };
    expect(order(pick({ Magic: 92 }, { ...mage, coin: 830_492 }, guildBusy))).toEqual([[536, Math.floor((830_492 - BONE_PURSE - 1_000) / 10_000)]]);
    expect(pick({ Magic: 92 }, { ...mage, coin: BONE_PURSE + 100_000 }, guildBusy).template!.id).not.toBe(KIT_BUY + 'army-bury-dragon-99');
    // With the shop free it fetches its staff first, with nature runes or with none: the guild sells them too.
    expect(pick({ Magic: 92 }, { ...mage, coin: 830_492 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 92 }, { coin: 830_492 }).template!.id).toBe('army-staff-guild');
    // The listed bones finish about three accounts: one with Ranged or Magic under BONE_SKILL buys none, even with its
    // arrow shops taken and millions of coins, and does not bury a stack it happens to hold before those skills.
    const busyShops = { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0, 'shop:dargaud': 0, 'shop:lowe': 0 };
    const { 'bronze arrow': _arrow, 'nature rune': _nature, ...bonesOnly } = bones;
    expect(pick({ Ranged: BONE_SKILL - 1 }, { coin: 8_000_000, shortbow: 1 }, { capacity: busyShops, market: bonesOnly }).template!.id).toBe('army-trooper-prayer-99');
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000 }, { market: bonesOnly, ...guildBusy }).template!.id).toBe('army-trooper-prayer-99');
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000, 'dragon bone': 300 }, { market: bonesOnly, ...guildBusy }).template!.id).toBe('army-trooper-prayer-99');
    // With the Magic Guild free that account goes for its alchemy kit, still not for bones.
    expect(pick({ Magic: BONE_SKILL - 1 }, { coin: 8_000_000 }, { market: bonesOnly }).template!.id).toBe('army-staff-guild');
    // The buy replaces the Prayer filler while it runs, as any kit buy does.
    expect(pick({}, { coin: 5_000_000 }, { unfundable: new Set(['monk']), current: new Map([['monk', 'army-trooper-prayer-99']]) }).template!.id).toBe(KIT_BUY + 'army-bury-dragon-99');
    // With the bones held, a part-filled order too, it buries them before anything else.
    const bury = pick({}, { coin: 1_000, 'dragon bone': BONE_START });
    expect(jobFor(bury, side)).toMatchObject({ script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_ID: '536', BONE_RESERVE: String(BONE_KEEP), AUTOPILOT_ORDER:'0' }, repeat: false });
    // No dragon bones under the cap: big bones, sized by their own XP. Neither: the filler on the field.
    const { 'dragon bone': _, ...onlyBig } = bones;
    const big = pick({}, { coin: 5_000_000 }, { market: onlyBig });
    expect(big.template!.id).toBe(KIT_BUY + 'army-bury-big-99');
    expect(order(big)).toEqual([[532, BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(90)) / 375)]]);
    expect(pick({}, { coin: 5_000_000, 'big bone': 300 }, { market: onlyBig }).template!.id).toBe('army-bury-big-99');
    expect(pick({}, { coin: 5_000_000 }, { market }).template!.id).toBe('army-trooper-prayer-99');
    // An account with a band it can start keeps to it: bones are for the account that has only the filler left.
    expect(pick({ Defence: 80 }, { coin: 5_000_000 }).template!.id).toBe('army-trooper-defence-99');
    // Prayer 99 buys none.
    expect(pick({ Prayer: 99 }, { coin: 5_000_000 }).template?.id.startsWith(KIT_BUY)).not.toBe(true);
});

test('the alchemy band gets its feathers at Port Sarim, its fire runes at Aubury under Magic 66 and its staff at the Magic Guild from 66', () => {
    const army = new Set(['mage']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Prayer: 99, Magic: 21 };
    const base = { coin: 900_000, shark: 40, 'adamant scimitar': 1, 'nature rune': 1000 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Mage', { ...skills, ...s }, { ...base, ...items })], { army, market, capacity: CAPACITY, ...extra }))[0]!;
    const step = (profile: string, cap: number, items: string, target: number, spend: number) =>
        `scripts/shop-buyer.ts ${profile} ${cap} ITEMS=${items} STOCK_TARGET=${target} STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=${spend + 1000} COIN_RESERVE=500 MAX_SPEND=${spend}`;
    // No feathers: Port Sarim first.
    const feathers = pick({}, {});
    expect(feathers.template!.id).toBe('army-feathers-sarim');
    expect(jobFor(feathers, side)).toMatchObject({ script: 'scripts/chain.ts', args: [step('sarim', 3000, 'feather', FEATHER_STOCK, 10000)], env: { ROUNDS: '1' }, repeat: true, resources: ['shop:sarim'] });
    // Feathers held, no fire, under Magic 66: fire runes at Aubury.
    const fire = pick({}, { feather: 700 });
    expect(fire.template!.id).toBe('army-fire-aubury');
    expect(jobFor(fire, side)).toMatchObject({ args: [step('aubury', 3000, 'fire.rune', FIRE_STOCK, 9000)], resources: ['shop:aubury'] });
    // With the fire runes it casts; when they run under 250 at Magic 66 or more it goes to the Magic Guild.
    expect(pick({}, { feather: 700, 'fire rune': 500 }).template!.id).toBe('army-alch-magic-99');
    const guild = pick({ Magic: 66 }, { feather: 700, 'fire rune': 249 });
    expect(guild.template!.id).toBe('army-staff-guild');
    const runes = [step('magic_guild', 900, 'nature.rune', NATURE_STOCK, 45000), step('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)];
    expect(jobFor(guild, side)).toMatchObject({ args: [step('magic_guild', 1500, 'staff.of.fire', 1, 12000), step('magic_guild', 600, 'fire.rune', FIRE_STOCK, 9000), ...runes], resources: ['shop:magic_guild'] });
    // The guild's shelf is the whole kit from 66: an account with coins and no rune of the band goes there, not to
    // the market or to Port Sarim. Under 80,000 coins it does not.
    expect(pick({ Magic: 66 }, { 'nature rune': 0 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 66 }, {}).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 66 }, { 'nature rune': 0, coin: 79_999 }).template?.id).not.toBe('army-staff-guild');
    // With the guild's air runes it casts on them; with its fire and no nature runes left it goes back for runes only.
    const air = pick({ Magic: 66 }, { 'air rune': AIR_STOCK, 'staff of fire': 1 });
    expect(jobFor(air, side)).toMatchObject({ script: 'scripts/alch-train.ts', args: ['99', '5000'], env: { ALCH_ITEM: 'airrune' }, repeat: true });
    expect(air.template!.id).toBe('army-alch-air-magic-99');
    expect(pick({ Magic: 65 }, { 'air rune': AIR_STOCK, feather: 700, 'staff of fire': 1 }).template!.id).toBe('army-alch-magic-99');
    const top = pick({ Magic: 80 }, { 'nature rune': 49, 'air rune': 30, 'staff of fire': 1 });
    expect(top.template!.id).toBe('army-nature-guild');
    expect(jobFor(top, side)).toMatchObject({ args: runes, resources: ['shop:magic_guild'] });
    expect(pick({ Magic: 80 }, { 'nature rune': 49, 'air rune': 30 }).template!.id).toBe('army-staff-guild');
    expect(pick({ Magic: 65 }, { feather: 700, 'fire rune': 249 }).template!.id).toBe('army-fire-aubury');
    expect(pick({ Magic: 66 }, { feather: 700, 'staff of fire': 1 }).template!.id).toBe('army-alch-magic-99');
    // The trips follow the kit buy: with no nature runes held none of them is given, and the buy leaves feathers and
    // fire to them.
    const none = pick({}, { 'nature rune': 0 });
    expect(none.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(none.template!.args!.map(a => a.match(/ITEM_ID=(\d+)/)![1])).toEqual(['561']);
    // An account with nature runes, fire staff, no air runes and no feathers restocks air runes at the Magic Guild.
    const airRestock = pick({ Magic: 98 }, { 'nature rune': 373, 'staff of fire': 1 });
    expect(airRestock.template!.id).toBe('army-air-guild');
    expect(jobFor(airRestock, side)).toMatchObject({ args: [step('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)], resources: ['shop:magic_guild'] });
    // An account that still holds feathers keeps alching on feathers instead of making a Magic Guild trip.
    expect(pick({ Magic: 80 }, { 'nature rune': 373, feather: 500, 'staff of fire': 1 }).template!.id).toBe('army-alch-magic-99');
    // Magic 99 needs none of it.
    expect(['army-feathers-sarim', 'army-fire-aubury', 'army-staff-guild', 'army-nature-guild', 'army-air-guild', 'army-alch-air-magic-99']).not.toContain(pick({ Magic: 99 }, {}).template?.id);
});

test('an army account with no better blade buys one adamant scimitar before its Ranged and melee bands, four accounts at a time', () => {
    const army = new Set(['blade', 'edge', 'point', 'hilt', 'guard']);
    const sold: Market = { ...market, 'adamant scimitar': { id: 1331, name: 'Adamant scimitar', limit: KIT_PRICE_CAPS['adamant scimitar']! } };
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 80, Hitpoints: 90, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { coin: 900_000, shark: 40, 'bronze sword': 1 };
    const pick = (s: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Blade', { ...skills, ...s }, items)], { army, market: sold, capacity: CAPACITY, ...extra }))[0]!;
    const buy = pick({}, kit);
    expect(buy.template!.id).toBe(KIT_BUY + WEAPON.id);
    expect(buy.template!.args).toEqual([`scripts/buy-owned-ge-item.ts ITEM_ID=1331 QUANTITY=1 LIMIT_PRICE=${KIT_PRICE_CAPS['adamant scimitar']} CASH_RESERVE=1000 ORDER_KEY=blade-kit0-1331-0to1 ORDER_MS=900000 FILL_WAIT_TICKS=200`]);
    expect(jobFor(buy, side)).toMatchObject({ script: 'scripts/chain.ts', repeat: false, resources: [WEAPON_MARKET] });
    // A later buy takes the account's next order key.
    expect(pick({}, kit, { kitSeq: new Map([['blade', 2]]) }).template!.args![0]).toContain('ORDER_KEY=blade-kit2-1331-0to1');
    // With an adamant or rune blade, worn or banked, it fights on.
    for (const blade of WEAPON_HELD) expect(pick({}, { ...kit, [blade]: 1 }).template!.id).toBe('army-trooper-defence-99');
    // Under Attack 30, short of coins, with no seller under the cap, or after the buy was retired: no buy.
    expect(pick({ Attack: 29 }, kit).template!.id).not.toBe(KIT_BUY + WEAPON.id);
    expect(pick({}, { ...kit, coin: KIT_PRICE_CAPS['adamant scimitar']! }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, kit, { market }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, kit, { retired: new Set([pairKey('Blade', KIT_BUY + WEAPON.id)]) }).template!.id).toBe('army-trooper-defence-99');
    // A melee trainer buys it before the Prayer filler. A Ranged trainer buys no blade: it keeps its Ranged band.
    expect(pick({ Ranged: 30 }, { ...kit, shortbow: 1, 'iron arrow': 500 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 30 }, { ...kit, shortbow: 1, 'iron arrow': 500, 'adamant scimitar': 1 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Defence: 99, Prayer: 80 }, kit).template!.id).toBe(KIT_BUY + WEAPON.id);
    // Four accounts are away for it at a time; the fifth keeps its band.
    const five = ids(plan(inputs(['Blade', 'Edge', 'Point', 'Hilt', 'Guard'].map(n => acct(n, skills, kit)), { army, market: sold, capacity: CAPACITY })));
    expect(Object.values(five).sort()).toEqual(['army-trooper-defence-99', ...Array(4).fill(KIT_BUY + WEAPON.id)]);
    // A blade is not used up by a band, so an account leaves its running band for the buy when its own coins pay it.
    const onBand = { unfundable: new Set(['blade']), current: new Map([['blade', 'army-trooper-defence-99']]), running: new Set(['blade']) };
    expect(pick({}, kit, onBand).template!.id).toBe(KIT_BUY + WEAPON.id);
    // Short of coins it keeps the band: a busy account takes no funding and no item order.
    const donors = [{ name: 'Big', coins: 5_000_000 }];
    expect(pick({}, { ...kit, coin: 500 }, { ...onBand, donors }).template!.id).toBe('army-trooper-defence-99');
    // With the blade held it keeps the band.
    expect(pick({}, { ...kit, 'adamant scimitar': 1 }, onBand).template!.id).toBe('army-trooper-defence-99');
    // An account outside the army is not armed.
    expect(plan(inputs([acct('Blade', skills, kit)], { army: new Set(['other']), market: sold, capacity: CAPACITY })).some(x => x.template?.id === KIT_BUY + WEAPON.id)).toBe(false);
});

test('a kit buy takes only a pickaxe or an axe that the account can use', () => {
    expect(usableTool({ skills: { Mining: 1 } }, 'adamant pickaxe')).toBe(false);
    expect(usableTool({ skills: { Mining: 31 } }, 'adamant pickaxe')).toBe(true);
    expect(usableTool({ skills: { Mining: 40 } }, 'rune pickaxe')).toBe(false);
    expect(usableTool({ skills: { Woodcutting: 41 } }, 'rune axe')).toBe(true);
    expect(usableTool({ skills: {} }, 'adamant scimitar')).toBe(true);
    const dig: Template = { id: 'army-test-dig', family: 'mine', script: 'scripts/gather-ore.ts', role: 'mining', goal: 'mine', tier: 'goal', band: 1,
        trains: { skill: 'Mining', to: 60, unlocks: [] }, yields: () => [], needs: { pieces: { of: ['adamant pickaxe', 'rune pickaxe'], count: 1 } } };
    const picks: Market = { 'adamant pickaxe': { id: 1271, name: 'Adamant pickaxe', limit: 6_000 }, 'rune pickaxe': { id: 1275, name: 'Rune pickaxe', limit: 40_000 } };
    const pick = (mining: number) => plan(inputs([acct('Digger', { Mining: mining }, { coin: 500_000 })], { templates: [dig], army: new Set(['digger']), market: picks, capacity: CAPACITY }))[0]!;
    // Mining 1: adamant (Mining 31) and rune (Mining 41) are no use, so nothing is bought.
    expect(pick(1).template).toBeUndefined();
    expect(pick(31).template!.args![0]).toContain('ITEM_ID=1271');
    // The cheaper usable one first.
    expect(pick(41).template!.args![0]).toContain('ITEM_ID=1271');
});

test('with no fire on the market the alchemy kit buys its other lines, then the account buys a staff of fire at Zaff\'s', () => {
    const templates = catalogue().filter(t => t.id === 'army-alch-magic-99' || t.id === 'army-staff-zaff'), army = new Set(['rich']);
    // The staff job is a pilot: a plan names it to turn it on.
    const pilots = new Set(['army-staff-zaff']);
    const pick = (items: Record<string, number>, skills: Record<string, number> = { Magic: 30 }) => plan(inputs([mage('Rich', items, skills)], { templates, army, market, capacity: CAPACITY, pilots }))[0];
    // The market sells nature runes and no fire: the buy takes the nature runes and leaves the fire line to the shop job.
    const buy = pick({ coin: 5_000_000, feather: 500 })!;
    expect(buy.template!.id).toBe(KIT_BUY + 'army-alch-magic-99');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).join('x'))).toEqual([`561x${ALCH30.nature}`]);
    // With the nature runes and feathers held and no fire, the staff job; with a staff or 250 fire runes, the band.
    const held = { coin: 4_000_000, feather: 500, 'nature rune': 1000 };
    const shop = pick(held)!;
    expect(shop.template!.id).toBe('army-staff-zaff');
    expect(jobFor(shop, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['zaff', '3000'], repeat: true, resources: ['shop:zaff'],
        env: { ITEMS: 'staff of fire', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '1100' } });
    expect(pick({ ...held, 'fire rune': 249 })!.template!.id).toBe('army-staff-zaff');
    expect(pick({ ...held, 'staff of fire': 1 })!.template!.id).toBe('army-alch-magic-99');
    expect(pick({ ...held, 'mystic fire staff': 1 })!.template!.id).toBe('army-alch-magic-99');
    expect(pick({ ...held, 'fire rune': 250 })!.template!.id).toBe('army-alch-magic-99');
    // Under Magic 21, short of coins, or with nothing else of the kit held: no trip to the shop.
    expect(pick(held, { Magic: 20 })?.template?.id).not.toBe('army-staff-zaff');
    expect(pick({ ...held, coin: 14_000 })?.template?.id).not.toBe('army-staff-zaff');
    expect(pick({ coin: 4_000_000, feather: 500, 'nature rune': 49 })?.template?.id).not.toBe('army-staff-zaff');
    // Only the fire line is short and no market sells it: there is nothing to buy on the Grand Exchange.
    expect(plan(inputs([mage('Rich', { coin: 5_000, feather: 500, 'nature rune': 1000 }, { Magic: 30 })], { templates, army, market, capacity: CAPACITY, pilots }))
        .some(x => x.template?.id.startsWith(KIT_BUY))).toBe(false);
    // Unnamed, the staff job is not given.
    expect(plan(inputs([mage('Rich', held, { Magic: 30 })], { templates, army, market, capacity: CAPACITY })).some(x => x.template?.id === 'army-staff-zaff')).toBe(false);
});

test('a line no market sells is sent first; a pair whose order failed is not asked again', () => {
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45' || t.family === 'goldfarm'), army = new Set(['needy']);
    const needy = acct('Needy', { Thieving: 99, Hitpoints: 35 }, { 'wooden shield': 1, coin: 100_000 });
    const stock: Stock[] = [{ name: 'Near', side, items: { 'bronze sword': 3, trout: 500 } }, { name: 'Next', side, items: { 'bronze sword': 2 } }];
    const run = (extra: Partial<Inputs> = {}) => plan(inputs([needy], { templates: cow, army, market, stock, capacity: CAPACITY, ...extra }))[0]!;
    // The sword is missing first; a later pass can transfer spare food for the same kit.
    expect(run().send).toEqual({ from: 'Near', to: 'Needy', item: 'bronze sword', count: 1, template: 'army-cow-strength-45' });
    expect(run({ noSend: new Set(['near>needy']) }).send).toMatchObject({ from: 'Next' });
    const armed = acct('Needy', { Thieving: 99, Hitpoints: 35 }, { 'wooden shield': 1, 'bronze sword': 1, coin: 100_000 });
    expect(plan(inputs([armed], { templates: cow, army, market, stock, capacity: CAPACITY }))[0]!.send)
        .toMatchObject({from:'Near',to:'Needy',item:'trout',count:30});
});

test('an account in a running band job gets no kit buy over it', () => {
    const army = new Set(['busy']), templates = [...strike(), ...catalogue().filter(t => t.id === 'army-bury-prayer-99')];
    const busy = mage('Busy', { coin: 5_000_000, 'mind rune': 15, 'air rune': 35, bone: 40 });
    const on = (current: string) => plan(inputs([busy], { templates, army, market, unfundable: new Set(['busy']), current: new Map([['busy', current]]) }))[0]!.template!.id;
    // Its bones dipped under the band's start count while it buries: the kit tier leaves it to the rule it had before.
    expect(on('army-bury-prayer-99')).toMatch(/^goldfarm@/);
    expect(on('goldfarm@2652,3318')).toBe(KIT_BUY + 'army-strike-magic-21');
});

test('an account that cannot pay for the batch buys the share its coins reach, never under the start', () => {
    const alch = catalogue().filter(t => t.id === 'army-alch-magic-99'), army = new Set(['thin']);
    const thin = mage('Thin', { coin: 50_000, 'nature rune': 10, feather: 500, 'staff of fire': 1 }, { Magic: 30 });
    const [x] = plan(inputs([thin], { templates: alch, army, market, unfundable: new Set(['thin']) }));
    expect(x!.template!.args![0]).toContain('QUANTITY=60 EXPECTED_OWNED=10 LIMIT_PRICE=800');
    expect(x!.reason).toContain('at most 48000 coins');
});

// AIO routes (aioTemplates): practice-proved options the plan's `aio` list admits.
const aioIds = aioTemplates().map(t => t.id);
const aioPrices = { flax: 5, 'iron ore': 17, 'copper ore': 3, 'tin ore': 3, 'rune essence': 4, 'air rune': 4, 'bow string': 10, 'arrow shaft': 1, 'yew log': 160, 'steel bar': 100 };
const aioDemand = [...new Set(aioTemplates().flatMap(t => [acct('Demand'), acct('Demand', { Mining: 15 })].flatMap(a => t.yields(a).map(f => f.item))))].map(item => row(item, 10_000));
const aioInputs = (accounts: Acct[], pilots: string[], extra: Partial<Inputs> = {}): Inputs =>
    inputs(accounts, { templates: aioTemplates(), bill: aioDemand, prices: aioPrices, pilots: new Set(pilots), capacity: CAPACITY, ...extra });
const sweepKit = { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1, trout: 4, 'bronze pickaxe': 1 };

test('every AIO template is in the catalogue as a pilot that runs the dispatcher with its category first', () => {
    const all = new Map(catalogue().map(t => [t.id, t]));
    expect(aioIds).toEqual(['aio-flax', 'aio-bowstrings', 'aio-yews', 'aio-shafts', 'aio-ore', 'aio-essence', 'aio-air-runes', 'aio-runite-bars', 'aio-adamantite-bars', 'aio-mithril-bars', 'aio-iron-bars', 'aio-steel-bars', 'aio-cannonballs', 'aio-rune-scimitars', 'aio-rune-axe',
        ...UNF_POTIONS.map(([herb]) => `aio-unf-${herb.replace(' ', '-')}`), 'aio-unicorn-horn-dust', 'aio-dragon-scale-dust', ...GEM_RINGS.map(([gem]) => `aio-${gem}-rings`),
        'aio-blood-chest', 'aio-quest-runemysteries']);
    for (const t of aioTemplates()) {
        expect(all.get(t.id)).toBeDefined();
        expect(t.pilot).toBe(true);
        expect(t.script).toBe('scripts/aio.ts');
        expect(t.args![0]).toBe(t.aio!.split(':')[0]!);
        expect(t.worker).toMatch(/^scripts\/[a-z-]+\.ts$/);
        for (const r of t.resources ?? []) expect(CAPACITY[r]).toBe(1);
    }
});

test('an unfinished potion is mixed at its Herblore level from one herb and one vial, and has the value of its bill line', () => {
    const run = (a: Acct, id: string, extra: Partial<Inputs> = {}) => plan(aioInputs([a], [id], extra))[0]!;
    const potionPrices = priceTable([{ id: 111, name: 'Unfinished potion', cost: 25 }, { id: 109, name: 'Unfinished potion', cost: 70 }], [row('torstol potion (unf)', 176), row('dwarf weed potion (unf)', 13)].map((r, k) => ({ ...r, ids: [[111], [109]][k]! })));
    const short = [row('torstol potion (unf)', 176)];
    const brewer = acct('A', { Herblore: 78 }, { torstol: 1, 'vial of water': 1, 'dwarf weed': 5 });
    expect(UNF_POTIONS.map(([herb]) => herb)).toEqual(['guam', 'marrentill', 'tarromin', 'harralander', 'ranarr', 'toadflax', 'irit', 'avantoe', 'kwuarm', 'snapdragon', 'cadantine', 'lantadyme', 'dwarf weed', 'torstol']);
    expect(run(brewer, 'aio-unf-torstol', { bill: short, prices: potionPrices }).template?.id).toBe('aio-unf-torstol');
    // Twice the price of the line while it is short, zero after it is met or for a different output.
    expect(run(brewer, 'aio-unf-torstol', { bill: short, prices: potionPrices }).value).toBeCloseTo(0.1 * 25 * 2);
    expect(run(brewer, 'aio-unf-torstol', { bill: [row('torstol potion (unf)', 0)], prices: potionPrices }).value).toBe(0);
    expect(run(brewer, 'aio-unf-dwarf-weed', { bill: short, prices: potionPrices }).value).toBe(0);
    // A level under the potion, no herb, or no vial: no job.
    for (const a of [acct('A', { Herblore: 77 }, { torstol: 1, 'vial of water': 1 }), acct('A', { Herblore: 78 }, { 'vial of water': 1 }), acct('A', { Herblore: 78 }, { torstol: 1 })])
        expect(run(a, 'aio-unf-torstol', { bill: short, prices: potionPrices }).template).toBeUndefined();
    expect(jobFor(run(brewer, 'aio-unf-dwarf-weed', { bill: [row('dwarf weed potion (unf)', 100)], prices: potionPrices }), side)).toMatchObject({ script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'inventory', 'brew:unf_dwarf_weed_potion', 'MAX_MAKE=1', 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], repeat: false });
    // The dusts: a pestle and mortar and one horn or scale.
    const dustPrices = { 'unicorn horn dust': 20, 'dragon scale dust': 52 };
    expect(run(acct('A', {}, { 'pestle and mortar': 1, 'unicorn horn': 1 }), 'aio-unicorn-horn-dust', { prices: dustPrices }).template?.args).toContain('grind:unicorn_horn');
    expect(run(acct('A', {}, { 'pestle and mortar': 1, 'blue dragon scale': 1 }), 'aio-dragon-scale-dust', { prices: dustPrices }).template?.args).toContain('grind:blue_dragon_scale');
    expect(run(acct('A', {}, { 'unicorn horn': 1 }), 'aio-unicorn-horn-dust', { prices: dustPrices }).template).toBeUndefined();
});

test('a ring trip needs its Crafting level, the mould and one complete owned recipe; one rune axe needs Smithing 86', () => {
    const run = (a: Acct, id: string) => plan(aioInputs([a], [id], { prices: { 'sapphire ring': 900, 'emerald ring': 1275, 'ruby ring': 2025, 'diamond ring': 3525, 'rune axe': 12800 } }))[0]!;
    for (const [gem, level] of GEM_RINGS) {
        const id = `aio-${gem}-rings`, kit = { 'ring mould': 1, 'gold bar': RING_BATCH, [gem]: RING_BATCH };
        expect(`${id} ${run(acct('A', { Crafting: level }, kit), id).template?.id}`).toBe(`${id} ${id}`);
        for (const a of [acct('A', { Crafting: level - 1 }, kit), acct('A', { Crafting: level }, { ...kit, 'ring mould': 0 }), acct('A', { Crafting: level }, { ...kit, 'gold bar': 0 }),
            acct('A', { Crafting: level }, { ...kit, [gem]: 0, [`uncut ${gem}`]: RING_BATCH, chisel: 1 })])
            expect(run(a, id).template).toBeUndefined();
        expect(run(acct('A',{Crafting:level},{...kit,'gold bar':RING_BATCH-1}),id).template?.args).toContain(`TARGET=${RING_BATCH-1}`);
    }
    expect(GEM_RINGS.map(([gem, level]) => `${gem} ${level}`)).toEqual(['sapphire 20', 'emerald 27', 'ruby 34', 'diamond 43']);
    expect(jobFor(run(acct('A', { Crafting: 43 }, { 'ring mould': 1, 'gold bar': 13, diamond: 13 }), 'aio-diamond-rings'), side).args)
        .toEqual(['skiller', 'crafting', 'jewellery-trip', 'RECIPE=diamond_ring', 'TARGET=13', 'BATCH=13', 'CAP=1500']);
    const smith = (level: number, items: Record<string, number>) => acct('A', { Smithing: level }, { hammer: 1, 'runite bar': 1, coin: 10, ...items });
    expect(run(smith(86, {}), 'aio-rune-axe').template?.args).toEqual(['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0']);
    expect(run(smith(86, {}), 'aio-rune-axe').value).toBeCloseTo(0.003 * 12800 * 2);
    // A level under the axe, no bar, no hammer, or an axe already held: no job.
    for (const a of [smith(85, {}), smith(86, { 'runite bar': 0 }), smith(86, { hammer: 0 }), smith(86, { 'rune axe': 1 })]) expect(run(a, 'aio-rune-axe').template).toBeUndefined();
});

test('the two-recipe makers are pilots that run the bank-standing worker twice in one chain', () => {
    const all = new Map(catalogue().map(t => [t.id, t]));
    expect(makerChains().map(t => t.id)).toEqual(['make-yew-shortbow', 'make-uncooked-stew']);
    for (const t of makerChains()) {
        expect(all.get(t.id)).toBeDefined();
        expect(t.pilot).toBe(true);
        expect(t.script).toBe('scripts/chain.ts');
        expect(t.env).toEqual({ ROUNDS: '1' });
        expect(t.args).toHaveLength(2);
        for (const step of t.args!) expect(step).toMatch(/^scripts\/aio\.ts skiller crafting inventory \S+ MAX_MAKE=\d+ CAP=\d+ MEMBERS=1 ORDER_MODE=best-effort$/);
    }
    const run = (a: Acct, id: string, pilots = [id]) => plan(inputs([a], { templates: makerChains(), bill: [row('yew shortbow', 1), row('uncooked stew', STEW_BATCH)], prices: { 'yew shortbow': 400, 'uncooked stew': 10 }, pilots: new Set(pilots) }))[0]!;
    const fletcher = (level: number, items: Record<string, number>) => acct('A', { Fletching: level }, { knife: 1, 'yew log': 1, 'bow string': 1, ...items });
    expect(run(fletcher(65, {}), 'make-yew-shortbow').template?.id).toBe('make-yew-shortbow');
    expect(run(fletcher(65, {}), 'make-yew-shortbow', []).template).toBeUndefined();
    // A level under the bow, a missing input, or a yew shortbow already held (strung or not: one name): no job.
    for (const a of [fletcher(64, {}), fletcher(65, { knife: 0 }), fletcher(65, { 'yew log': 0 }), fletcher(65, { 'bow string': 0 }), fletcher(65, { 'yew shortbow': 1 })])
        expect(run(a, 'make-yew-shortbow').template).toBeUndefined();
    expect(jobFor(run(fletcher(65, {}), 'make-yew-shortbow'), side)).toMatchObject({ script: 'scripts/chain.ts', repeat: false, args: [
        'scripts/aio.ts skiller crafting inventory cut-bow:unstrung_yew_shortbow MAX_MAKE=1 CAP=600 MEMBERS=1 ORDER_MODE=best-effort',
        'scripts/aio.ts skiller crafting inventory bow-string:yew_shortbow MAX_MAKE=1 CAP=600 MEMBERS=1 ORDER_MODE=best-effort'] });
    const cook = (level: number, items: Record<string, number>) => acct('A', { Cooking: level }, { potato: STEW_BATCH, 'bowl of water': STEW_BATCH, 'cooked meat': STEW_BATCH, ...items });
    expect(run(cook(25, {}), 'make-uncooked-stew').template?.args).toEqual([
        `scripts/aio.ts skiller crafting inventory prepare:potato-stew MAX_MAKE=${STEW_BATCH} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`,
        `scripts/aio.ts skiller crafting inventory prepare:uncooked-stew MAX_MAKE=${STEW_BATCH} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`]);
    for (const a of [cook(24, {}), cook(25, { potato: 0 }), cook(25, { 'bowl of water': 0 }), cook(25, { 'cooked meat': 0 })]) expect(run(a, 'make-uncooked-stew').template).toBeUndefined();
    // Both steps use the same complete recipe count, so a short meat stock still makes useful whole stews.
    for(const count of [1,STEW_BATCH-1]){
        const partial=run(cook(25,{potato:100,'bowl of water':100,'cooked meat':count}),'make-uncooked-stew');
        expect(partial.template!.args).toEqual([
            `scripts/aio.ts skiller crafting inventory prepare:potato-stew MAX_MAKE=${count} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`,
            `scripts/aio.ts skiller crafting inventory prepare:uncooked-stew MAX_MAKE=${count} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`]);
        expect(partial.template!.needs!.items).toEqual({potato:count,'bowl of water':count,'cooked meat':count});
    }
    expect(run(cook(25, { potato: 100, 'bowl of water': 100 }), 'make-uncooked-stew').template?.id).toBe('make-uncooked-stew');
});

test('an account under a top-up of rune arrows buys them at the Ranging Guild shop, as a pilot, while the bill is short', () => {
    const shop = catalogue().filter(t => t.id === 'shop-rune-arrows' || t.id === 'army-arrows-guild');
    const line = [row('rune arrow', 38)], arrowPrices = { 'rune arrow': 400 };
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { templates: shop, bill: line, prices: arrowPrices, pilots: new Set(['shop-rune-arrows']), ...extra }));
    const buyer = (name: string, ranged: number, items: Record<string, number>) => acct(name, { Ranged: ranged }, { coin: RUNE_ARROW_SPEND + 2000, ...items });
    const [x] = run([buyer('A', 40, {})]);
    expect(x!.template!.id).toBe('shop-rune-arrows');
    // Only the 38 needed arrows count over the 1,000-tick planning window; spend scales with that useful work.
    expect(RUNE_ARROW_COST).toBe(Array.from({ length: ARROW_LOW }, (_, k) => 400 + 4 * k).reduce((a, b) => a + b, 0));
    expect(x!.value).toBeCloseTo((ARROW_LOW / 800 * 400 * 2 - RUNE_ARROW_COST / 800) * 38 / (ARROW_LOW / 800 * 1000));
    expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['dargaud', '800'], resources: ['shop:dargaud'],
        env: { ITEMS: 'rune arrow', STOCK_TARGET: String(ARROW_LOW), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', MAX_SPEND: String(RUNE_ARROW_SPEND), COIN_RESERVE: '500' } });
    // Not admitted, under the level of the guild door, with the top-up held, or with the line met and coins at full worth: no run.
    expect(ids(run([buyer('A', 40, {})], { pilots: new Set() }))).toEqual({ A: 'vacant' });
    expect(ids(run([buyer('A', 39, {})]))).toEqual({ A: 'vacant' });
    expect(ids(run([buyer('A', 40, { 'rune arrow': ARROW_LOW })]))).toEqual({ A: 'vacant' });
    expect(ids(run([buyer('A', 40, {})], { bill: [row('rune arrow', 0)] }))).toEqual({ A: 'vacant' });
    // Short of coins with no donor: no run. One account at the shop at a time.
    expect(ids(run([buyer('A', 40, { coin: 1000 })]))).toEqual({ A: 'vacant' });
    expect(ids(run([buyer('A', 40, {}), buyer('B', 40, {})]))).toEqual({ A: 'shop-rune-arrows', B: 'vacant' });
});

test('no AIO route is planned until the plan admits its id', () => {
    const rich = acct('A', { Crafting: 20, Woodcutting: 70, Attack: 30, Strength: 30 }, { flax: 100, knife: 1, log: 50, 'rune axe': 1, 'rune pickaxe': 1, 'air talisman': 1, 'rune essence': 100, ...sweepKit });
    expect(ids(plan(aioInputs([rich], [])))).toEqual({ A: 'vacant' });
    expect(ids(plan(inputs([rich], { prices: { ...prices, ...aioPrices }, bill: [] }))).A).not.toMatch(/^aio-/);
    expect(ids(plan(aioInputs([rich], ['aio-flax'])))).toEqual({ A: 'aio-flax' });
});

test('an AIO job runs scripts/aio.ts with its category and route as arguments', () => {
    const [x] = plan(aioInputs([acct('A')], ['aio-flax']));
    const job = jobFor(x!, side);
    expect(job).toMatchObject({ account: 'A', script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'], repeat: true, standing: true, template: 'aio-flax', resources: [AIO_PLACES.flax] });
});

test('the ore route needs combat 13 and a pickaxe; the status combat level wins over the one worked out from skills', () => {
    const run = (a: Acct) => ids(plan(aioInputs([a], ['aio-ore']))).A;
    expect(combatLevel({ Hitpoints: 10 })).toBe(3);
    expect(combatLevel({ Attack: 20, Strength: 20, Hitpoints: 10 })).toBe(15);
    expect(run(acct('A', {}, { 'bronze pickaxe': 1 }))).toBe('vacant');
    expect(run(acct('A', { Attack: 20, Strength: 20 }, {}))).toBe('vacant');
    expect(run(acct('A', { Attack: 20, Strength: 20 }, { 'bronze pickaxe': 1 }))).toBe('aio-ore');
    expect(run({ ...acct('A', { Attack: 20, Strength: 20 }, { 'bronze pickaxe': 1 }), combat: 12 })).toBe('vacant');
    expect(run({ ...acct('A', {}, { 'rune pickaxe': 1 }), combat: 13 })).toBe('aio-ore');
});

test('production routes need their level and tools, and resize to complete owned recipes', () => {
    const run = (a: Acct, id: string) => ids(plan(aioInputs([a], [id]))).A;
    expect(run(acct('A', { Crafting: 9 }, { flax: 56 }), 'aio-bowstrings')).toBe('vacant');
    expect(run(acct('A', { Crafting: 10 }, { flax: 0 }), 'aio-bowstrings')).toBe('vacant');
    expect(run(acct('A', { Crafting: 10 }, { flax: 56 }), 'aio-bowstrings')).toBe('aio-bowstrings');
    expect(run(acct('A', {}, { knife: 0, log: 25 }), 'aio-shafts')).toBe('vacant');
    expect(run(acct('A', {}, { knife: 1, log: 25 }), 'aio-shafts')).toBe('aio-shafts');
    expect(run(acct('A', { Woodcutting: 59 }, { 'bronze axe': 1 }), 'aio-yews')).toBe('vacant');
    expect(run(acct('A', { Woodcutting: 60 }, { 'bronze axe': 1 }), 'aio-yews')).toBe('aio-yews');
    expect(run(acct('A', {}, { 'air talisman': 1, 'rune essence': 27 }), 'aio-air-runes')).toBe('vacant');
    expect(run(acct('A', {}, { 'air talisman': 1, 'rune essence': 28 }), 'aio-air-runes')).toBe('aio-air-runes');
    // Steel takes one iron ore and two coal per complete bar; partial pack loads remain useful.
    expect(run(acct('A', { Smithing: 29 }, { 'iron ore': 9, coal: 18 }), 'aio-steel-bars')).toBe('vacant');
    expect(run(acct('A', { Smithing: 30 }, { 'iron ore': 0, coal: 18 }), 'aio-steel-bars')).toBe('vacant');
    expect(run(acct('A', { Smithing: 30 }, { 'iron ore': 9, coal: 1 }), 'aio-steel-bars')).toBe('vacant');
    expect(run(acct('A', { Smithing: 30 }, { 'iron ore': 9, coal: 18 }), 'aio-steel-bars')).toBe('aio-steel-bars');
    for(const [id,a,units,items]of [
        ['aio-bowstrings',acct('A',{Crafting:10},{flax:55}),55,{flax:55}],
        ['aio-shafts',acct('A',{},{knife:1,log:24}),24,{knife:1,logs:24}],
        ['aio-steel-bars',acct('A',{Smithing:30},{'iron ore':8,coal:18}),8,{'iron ore':8,coal:16}],
        ['aio-steel-bars',acct('A',{Smithing:30},{'iron ore':9,coal:17}),8,{'iron ore':8,coal:16}],
    ]as const){
        const [partial]=plan(aioInputs([a],[id]));
        expect(partial!.template!.id).toBe(id);expect(partial!.template!.args).toContain(`MAX_MAKE=${units}`);
        expect(partial!.template!.needs!.items).toEqual(items);expect(jobFor(partial!,side).repeat).toBe(false);
    }
});

test('Rune Mysteries is planned for the essence mine it unlocks, once, and only with the sweep pack', () => {
    const both = ['aio-quest-runemysteries', 'aio-essence'];
    const [x] = plan(aioInputs([acct('A', {}, sweepKit)], both));
    expect(x!.template!.id).toBe('aio-quest-runemysteries');
    expect(x!.reason).toBe('completes Rune Mysteries Quest for aio-essence');
    expect(x!.value).toBeCloseTo(TRAIN_SHARE * 0.03 * 4 * 2);
    expect(x!.resources).toEqual([AIO_PLACES.essence]);
    expect(jobFor(x!, side)).toMatchObject({ args: ['quester', 'sweep', 'runemysteries'], repeat: false });
    // No essence route admitted, a missing rune, three meals, or no pickaxe for the mine: no quest run.
    expect(ids(plan(aioInputs([acct('A', {}, sweepKit)], ['aio-quest-runemysteries'])))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, 'law rune': 1 })], both)))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, trout: 3 })], both)))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { ...sweepKit, 'bronze pickaxe': 0 })], both)))).toEqual({ A: 'vacant' });
    // The status reports the quest complete: the account mines essence, and the quest is never run again.
    const done: Acct = { ...acct('A', {}, sweepKit), quests: new Set(['rune mysteries quest']) };
    expect(ids(plan(aioInputs([done], both)))).toEqual({ A: 'aio-essence' });
    expect(ids(plan(aioInputs([done], ['aio-quest-runemysteries'])))).toEqual({ A: 'vacant' });
    expect(ids(plan(aioInputs([acct('A', {}, { 'bronze pickaxe': 1 })], ['aio-essence'])))).toEqual({ A: 'vacant' });
});

test('a place takes one AIO account, and a retired pair stays out', () => {
    expect(ids(plan(aioInputs([acct('A'), acct('B')], ['aio-flax'])))).toEqual({ A: 'aio-flax', B: 'vacant' });
    expect(ids(plan(aioInputs([acct('A')], ['aio-flax'], { retired: new Set([pairKey('A', 'aio-flax')]) })))).toEqual({ A: 'vacant' });
});

test('a quest job with an ok RESULT is re-planned at once, as a finished trainer is', () => {
    const [x] = plan(aioInputs([acct('A', {}, sweepKit)], ['aio-quest-runemysteries', 'aio-essence']));
    const job = jobFor(x!, side), assigned = { A: { template: job.template, offset: 0 } };
    expect(finishedTrainers([job], side, assigned, aioTemplates(), () => ['RESULT ok quest-sweep runemysteries'])).toEqual(['A']);
    expect(finishedTrainers([job], side, assigned, aioTemplates(), () => [])).toEqual([]);
});

test('an account row carries its combat level and its complete quests', () => {
    const a = accountFrom('A', side, { combat: 23, quests: [{ name: 'Rune Mysteries Quest', state: 'complete' }, { name: 'Imp Catcher', state: 'not started' }], skills: [], inventory: [] }, () => undefined);
    expect(a.combat).toBe(23);
    expect([...a.quests!]).toEqual(['rune mysteries quest']);
    // A fleet snapshot row lists the complete quests by name.
    expect([...accountFrom('S', side, { quests: ['Lost City', "Merlin's Crystal"], skills: [] }, () => undefined).quests!]).toEqual(['lost city', "merlin's crystal"]);
    const bare = accountFrom('B', side, null, () => undefined);
    expect(bare.combat).toBeUndefined();
    expect(bare.quests).toBeUndefined();
    // Quest points come from the quest point varp of the status. A row with no such fact has none known.
    expect(accountFrom('Q', side, { skills: [], guildFacts: { varps: { qp: 13 }, questStages: {}, unlocks: [] } }, () => undefined).questPoints).toBe(13);
    expect(a.questPoints).toBeUndefined();
    expect(bare.questPoints).toBeUndefined();
});

import { PRAYER_FIELD_BAND } from '../src/autopilot';
test('a melee-maxed army account buries trooper bones for Prayer when no band and no kit serves it', () => {
    const army = new Set(['maxed']);
    const melee = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 89 };
    const field = catalogue().find(t => t.id === 'army-trooper-prayer-99')!;
    expect(field).toMatchObject({ band: PRAYER_FIELD_BAND, filler: true, resources: ['trooper:battlefield'] });
    const pick = (skills: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Maxed', { ...melee, ...skills }, items)], { army, capacity: CAPACITY, ...extra }))[0]!;
    // Short of the 100 bones the bones-held band needs, it kills troopers for theirs; no coin job takes it.
    const x = pick({}, { shark: 30, bone: 63 });
    expect(x.template!.id).toBe('army-trooper-prayer-99');
    expect(jobFor(x, side)).toMatchObject({ script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, repeat: true, resources: ['trooper:battlefield'] });
    // With the bones held, that band comes first; at Prayer 99 neither is a candidate; without food it has no place.
    expect(pick({}, { shark: 30, bone: 100 }).template!.id).toBe('army-bury-prayer-99');
    expect(pick({ Prayer: 99 }, { shark: 30, bone: 63 }).template?.id ?? 'vacant').not.toMatch(/^army-/);
    expect(pick({ Thieving: 1 }, { bone: 63 }).template?.id).not.toBe('army-trooper-prayer-99');
    expect(pick({}, { bone: 63 }).template!.id).toBe('army-trooper-prayer-99');
    // An account with melee left takes its trooper band, never the filler.
    expect(pick({ Defence: 82 }, { shark: 30 }).template!.id).toBe('army-trooper-defence-99');
});

test('the Prayer filler waits behind a kit buy and gives way to one while it runs', () => {
    const army = new Set(['archer']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 87, Magic: 99, Prayer: 74 };
    const archer = acct('Archer', skills, { coin: 4_000_000, shark: 40, shortbow: 1 });
    // Its Ranged band lacks only arrows, and other accounts hold the arrow shops: the market buy comes before the filler.
    const capacity = { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0, 'shop:dargaud': 0, 'shop:lowe': 0 };
    expect(plan(inputs([archer], { army, market, capacity }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // The same while the filler is its running job: a kit buy replaces a filler, as it replaces a coin job.
    const busy = { army, market, capacity, unfundable: new Set(['archer']) };
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-prayer-99']]) }))[0]!.template!.id).toBe(KIT_BUY + 'army-trooper-ranged-99');
    // A band proper still keeps its place over a kit buy.
    expect(plan(inputs([archer], { ...busy, current: new Map([['archer', 'army-trooper-defence-99']]) }))[0]!.template!.id).not.toBe(KIT_BUY + 'army-trooper-ranged-99');
    // With no market for the arrows and the shops taken it fills the time on the field.
    expect(plan(inputs([archer], { army, capacity }))[0]!.template!.id).toBe('army-trooper-prayer-99');
});

test('an army account whose bow is short of arrows buys bronze arrows at the Ardougne shop, one account at a time', () => {
    const army = new Set(['archer', 'bowman']);
    const skills = { Thieving: 99, Attack: 99, Strength: 99, Defence: 80, Hitpoints: 90, Ranged: 1, Magic: 99, Prayer: 99 };
    const kit = { coin: 800_000, shark: 40, shortbow: 1, 'bronze arrow': 25 };
    const pick = (s: Record<string, number>, items: Record<string, number>) => plan(inputs([acct('Archer', { ...skills, ...s }, items)], { army, capacity: CAPACITY }))[0]!;
    // The shop comes at the Ranged band, before the Defence troopers, with no market and no donor.
    const shop = pick({}, kit);
    expect(shop.template!.id).toBe('army-arrows-ardy');
    expect(jobFor(shop, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['ardy', '400'], repeat: true, resources: ['shop:ardy'],
        env: { ITEMS: 'bronze arrow', STOCK_TARGET: String(ARROW_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', COIN_RESERVE: '500', MAX_SPEND: '4000', FLOAT: '5000' } });
    // With ARROW_LOW arrows the bow fires, the account trains Ranged; iron arrows count as bronze do.
    expect(pick({}, { ...kit, 'bronze arrow': ARROW_LOW }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({}, { ...kit, 'iron arrow': ARROW_LOW }).template!.id).toBe('army-trooper-ranged-99');
    // No bow, too few coins or Ranged 99: no shop run.
    expect(pick({}, { ...kit, shortbow: 0 }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({}, { ...kit, coin: 4_000 }).template!.id).toBe('army-trooper-defence-99');
    expect(pick({ Ranged: 99 }, kit).template!.id).toBe('army-trooper-defence-99');
    // One account holds each shop: the second walks to Hickton's in Catherby, the third takes the ferries to Lowe's in
    // Varrock, and the fourth keeps its melee band until a shop is free.
    const names = ['Archer', 'Bowman', 'Crossbow', 'Dart'];
    const four = ids(plan(inputs(names.map(n => acct(n, skills, kit)), { army: new Set(names.map(n => n.toLowerCase())), capacity: CAPACITY })));
    expect(Object.values(four).sort()).toEqual(['army-arrows-ardy', 'army-arrows-catherby', 'army-arrows-lowe', 'army-trooper-defence-99']);
    const hickton = plan(inputs([acct('Archer', skills, kit)], { army, capacity: { ...CAPACITY, 'shop:ardy': 0 } }))[0]!;
    expect(jobFor(hickton, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['catherby_arrows', '600'], repeat: true, resources: ['shop:catherby_arrows'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0' } });
    // Arrows of any kind end the shop runs: steel arrows a shortbow cannot fire are a kit matter, not a reason to shop again.
    expect(pick({}, { ...kit, 'steel arrow': ARROW_LOW }).template!.id).toBe('army-trooper-defence-99');
    // From Ranged 40 an account short of arrows goes to the Ranging Guild before any other shop, for a willow shortbow
    // and arrows up to mithril; with arrows of any kind it trains, and under 40 it uses the other shops.
    const guild = pick({ Ranged: 40 }, kit);
    expect(guild.template!.id).toBe('army-arrows-guild');
    expect(jobFor(guild, side)).toMatchObject({ script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeat: true, resources: ['shop:dargaud'] });
    expect(jobFor(guild, side).args).toEqual([
        'scripts/shop-buyer.ts dargaud 800 ITEMS=willow.shortbow STOCK_TARGET=1 STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=4000 COIN_RESERVE=500 MAX_SPEND=3000',
        `scripts/shop-buyer.ts dargaud 800 ITEMS=mithril.arrow|steel.arrow|iron.arrow|bronze.arrow STOCK_TARGET=${ARROW_STOCK} STOP_AT_TARGET=1 BANK_PACK=1 BANK_AT=0 NO_BUY_TICKS=25 FLOAT=51000 COIN_RESERVE=500 MAX_SPEND=50000`]);
    expect(pick({ Ranged: 39 }, kit).template!.id).toBe('army-arrows-ardy');
    expect(pick({ Ranged: 40 }, { ...kit, 'bronze arrow': 500 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 40 }, { ...kit, 'willow shortbow': 1, 'mithril arrow': 500 }).template!.id).toBe('army-trooper-ranged-99');
    expect(pick({ Ranged: 40 }, { ...kit, coin: 59_000 }).template!.id).toBe('army-arrows-ardy');
    const lowe = plan(inputs([acct('Archer', skills, kit)], { army, capacity: { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0 } }))[0]!;
    expect(jobFor(lowe, side)).toMatchObject({ script: 'scripts/shop-buyer.ts', args: ['lowe', '2500'], repeat: true, resources: ['shop:lowe'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0' } });
    // Lowe's trip needs more coins than Aemad's.
    expect(plan(inputs([acct('Archer', skills, { ...kit, coin: 24_000 })], { army, capacity: { ...CAPACITY, 'shop:ardy': 0, 'shop:catherby_arrows': 0 } }))[0]!.template!.id).toBe('army-trooper-defence-99');
    // A Grand Exchange buy that acquired its items made progress, however long the trip; one that acquired none did not.
    const trip = 'LEDGER ticks=1400 xp=0 inventory=8 move=600 anim=0 dialog=4 stun=0 idle=780';
    expect(assess([trip, 'RESULT ok {"ok":true,"phase":"settled","quantity":1000,"targetMet":true,"acquired":1000,"refund":554000}', 'RESULT ok chain rounds=1 ok=1 failed=0']).retire).toBe(false);
    expect(assess([trip, 'RESULT ok {"ok":true,"phase":"settled","quantity":1,"acquired":1,"cashDeltaThisSession":-72000}']).retire).toBe(false);
    expect(assess([trip, 'RESULT fail {"ok":false,"phase":"settled","quantity":50,"acquired":0,"refund":1000}']).reason).toMatch(/^tick waste/);
    // A shop run that bought arrows made progress; one that bought none on a long wait is retired as waste.
    const wait = 'LEDGER ticks=1000 xp=0 inventory=12 move=120 anim=0 dialog=0 stun=0 idle=868';
    expect(assess([wait, 'RESULT ok ticks=1000 boughtTotal=96 bankedTotal=96 stop=cap targetMet=0']).retire).toBe(false);
    expect(assess([wait, 'RESULT ok ticks=1000 boughtTotal=0 bankedTotal=0 stop=stock-wait targetMet=0']).reason).toMatch(/^tick waste 99%/);
    // A blood chest run waits for the chests to come back: its loots are its progress.
    expect(assess([wait, 'RESULT ok {"ok":true,"stop":"target","targetMet":true,"conserved":true,"loots":6,"runes":12,"coins":3000}']).retire).toBe(false);
    expect(assess([wait, 'RESULT fail {"ok":false,"stop":"idle","targetMet":false,"conserved":true,"loots":0,"runes":0,"coins":0}']).reason).toMatch(/^tick waste 99%/);
});

test('a smith with runite ore and coal smelts bars, then smiths rune scimitars, once the plan admits the routes', () => {
    const gear = ['aio-runite-bars', 'aio-rune-scimitars'], gearPrices = { ...aioPrices, 'runite bar': 5000, 'rune scimitar': 25600, 'runite ore': 3200, coal: 45 };
    const run = (a: Acct, pilots = gear) => plan(aioInputs([a], pilots, { prices: gearPrices }))[0]!;
    const smith = (items: Record<string, number>, skills: Record<string, number> = { Smithing: 99 }) => acct('Smith', skills, items);
    // The PC smith's stock: 13 runite ore, a hammer, and coal once mined.
    expect(run(smith({ 'runite ore': 13, coal: 104, hammer: 1 })).template!.id).toBe('aio-runite-bars');
    expect(jobFor(run(smith({ 'runite ore': 13, coal: 104, hammer: 1 })), side)).toMatchObject({ script: 'scripts/aio.ts', repeat:false,args: ['skiller', 'smithing', 'smelt', '1500', 'runite', 'MAX_MAKE=13', 'ORE_RESERVE=0'] });
    // Without 8 coal a bar, under Smithing 85, or not admitted: no smelt.
    expect(run(smith({ 'runite ore': 13, coal: 7, hammer: 1 })).template).toBeUndefined();
    const single=run(smith({'runite ore':13,coal:15,hammer:1}));
    expect(single.template!.args).toContain('MAX_MAKE=1');expect(single.template!.needs!.items).toEqual({'runite ore':1,coal:8});
    expect(run(smith({ 'runite ore': 13, coal: 104 }, { Smithing: 84 })).template).toBeUndefined();
    expect(run(smith({ 'runite ore': 13, coal: 104 }), []).template).toBeUndefined();
    // Bars banked: the anvil order, one blade a run, with the hammer and the toll.
    const bars = smith({ 'runite bar': 12, hammer: 1, coin: 5000 });
    expect(run(bars).template!.id).toBe('aio-rune-scimitars');
    expect(jobFor(run(bars), side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'] });
    expect(run(smith({ 'runite bar': 1, hammer: 1, coin: 5000 })).template).toBeUndefined();
    expect(run(smith({ 'runite bar': 12, coin: 5000 })).template).toBeUndefined();
    expect(run(smith({ 'runite bar': 12, hammer: 1, coin: 5000 }, { Smithing: 89 })).template).toBeUndefined();
});

import { LOST_CITY, LOST_CITY_MEALS, LOST_CITY_PLACES, QUEST_BAND } from '../src/autopilot';
test('an army account without Lost City takes the quest chain as a pilot, before Ranged, a few at a time', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 80, Magic: 99, Prayer: 77 };
    const kit = { shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, coin: 100_000 };
    const quests = (...done: string[]) => new Set(done.map(q => q.toLowerCase()));
    const soldier = (name: string, done: ReadonlySet<string> | undefined, s: Record<string, number> = {}, items: Record<string, number> = {}): Acct =>
        ({ ...acct(name, { ...maxed, ...s }, { ...kit, ...items }), ...(done ? { quests: done } : {}) });
    const pilots = new Set(['army-quest-lostcity']);
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots,templateFor:qualifiedTrooperTemplate, ...extra }));
    const [x] = run([soldier('Kilt', quests())]);
    expect(x!.template!.id).toBe('army-quest-lostcity');
    expect(x!.reason).toBe(`army band ${QUEST_BAND}: Lost City`);
    expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,zanaris'], repeat: false, resources: [LOST_CITY] });
    // Not a pilot the plan names: the account trains Ranged. The same with the quest done, an unknown quest list,
    // Prayer under Protect from Melee, or too few coins for the sweep's shop buys.
    const ranged = (accounts: Acct[], extra: Partial<Inputs> = {}) => run(accounts, extra)[0]!.template!.id;
    expect(ranged([soldier('Kilt', quests())], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests('Lost City'))])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', undefined)])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests(), { Prayer: 42 })])).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt', quests(), {}, { coin: 4_000 })])).toBe('army-trooper-ranged-99');
    // With too little of the food the quest eats, the band buys the cheapest of it first, as a candidate of its own:
    // the account could train Ranged, and still goes to the market. Sharks banked count as that food.
    const food: Market = { lobster: { id: 379, name: 'Lobster', limit: KIT_PRICE_CAPS.lobster! }, shark: { id: 385, name: 'Shark', limit: KIT_PRICE_CAPS.shark! } };
    const hungry = (items: Record<string, number>, extra: Partial<Inputs> = {}) => run([soldier('Kilt', quests(), {}, { shark: 0, trout: 200, ...items })], { market: food, ...extra })[0]!;
    const buy = hungry({});
    expect(buy.template!.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[379, LOST_CITY_MEALS]]);
    expect(buy.reason).toBe(`army band ${QUEST_BAND}: buys ${LOST_CITY_MEALS} Lobster for army-quest-lostcity, at most ${LOST_CITY_MEALS * KIT_PRICE_CAPS.lobster!} coins`);
    expect(hungry({ shark: 4 }).template!.args!.map(a => a.match(/QUANTITY=(\d+)/)![1])).toEqual([String(LOST_CITY_MEALS - 4)]);
    expect(hungry({ shark: LOST_CITY_MEALS }).template!.id).toBe('army-quest-lostcity');
    // No such food on the market, or a retired buy: the account trains on.
    expect(hungry({}, { market: {} }).template!.id).toBe('army-trooper-ranged-99');
    expect(hungry({}, { retired: new Set([pairKey('Kilt', KIT_BUY + 'army-quest-lostcity')]) }).template!.id).toBe('army-trooper-ranged-99');
    // LOST_CITY_PLACES accounts are away for it at a time; the rest keep training.
    const many = run(['A', 'B', 'C', 'D'].map(n => soldier(n, quests())));
    expect(many.filter(a => a.template!.id === 'army-quest-lostcity').length).toBe(LOST_CITY_PLACES);
    expect(many.filter(a => a.template!.id === 'army-trooper-ranged-99').length).toBe(4 - LOST_CITY_PLACES);
});

import { MAGIC_BAND, SPLASH_FENCE, SPLASH_KIT, SPLASH_PLACES, SPLASH_START, SPLASH_TO, splashKit } from '../src/autopilot';
test('an army account under the Magic Guild level buys curse runes, then water at the shop, then casts over the fence', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 80, Magic: 21, Prayer: 99 };
    const kit = { shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, coin: 500_000, 'mind rune': 15, 'air rune': 15 };
    const soldier = (name: string, items: Record<string, number> = {}, s: Record<string, number> = {}): Acct => acct(name, { ...maxed, ...s }, { ...kit, ...items });
    const pilots = new Set(['army-splash-magic-66', 'army-water-aubury']);
    const runes: Market = { 'body rune': { id: 559, name: 'Body rune', limit: KIT_PRICE_CAPS['body rune']! }, 'earth rune': { id: 557, name: 'Earth rune', limit: KIT_PRICE_CAPS['earth rune']! } };
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: runes,templateFor:qualifiedTrooperTemplate, ...extra }));
    // What a level still casts: 135 curses from Magic 21, ten from Magic 65, the whole kit under Curse's level.
    const need = splashKit(21);
    expect(need).toEqual({ 'body rune': 135, 'earth rune': 405, 'water rune': 270 });
    expect(splashKit(65)).toEqual({ 'body rune': 10, 'earth rune': 30, 'water rune': 30 });
    expect(splashKit(1)).toEqual({ ...SPLASH_KIT });
    // With no runes: one buy of the body and earth runes its level still casts, as a candidate of the band (the
    // account could train Ranged). The water line is the shop job's and holds nothing back.
    const [buy] = run([soldier('Kilt', { 'body rune': 2, 'water rune': 6, 'earth rune': 4 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-splash-magic-66');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[559, need['body rune']! - 2], [557, need['earth rune']! - 4]]);
    // With water runes listed on the market the same buy takes them too.
    const wet = run([soldier('Kilt', { 'body rune': 2, 'water rune': 6, 'earth rune': 4 })], { market: { ...runes, 'water rune': { id: 555, name: 'Water rune', limit: KIT_PRICE_CAPS['water rune']! } } })[0]!;
    expect(wet.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number)).sort((x, y) => x[0]! - y[0]!)).toEqual([[555, need['water rune']! - 6], [557, need['earth rune']! - 4], [559, need['body rune']! - 2]]);
    // Part of a kit is enough to start: the band at once with 200 water runes at Magic 21, and with ten casts' runes
    // at Magic 65, not a shop run for the rest.
    const part = run([soldier('Kilt', { 'body rune': 150, 'earth rune': 425, 'water rune': 200 })], { pilots: new Set([...pilots, 'army-water-betty']) })[0]!;
    expect(part.template!.id).toBe('army-splash-magic-66');
    expect(run([soldier('Kilt', { 'body rune': 25, 'earth rune': 50, 'water rune': 50 }, { Magic: 65 })])[0]!.template!.id).toBe('army-splash-magic-66');
    // An account keeps the runes its own level still casts: one at Magic 21 gives none of its 270 water runes, one
    // past the band gives all.
    const own = (magic: number) => kitReserve(catalogue().filter(t => t.id === 'army-splash-magic-66'), acct('K', { Magic: magic }))['water rune'];
    expect([own(21), kitReserve(catalogue().filter(t => t.id === 'army-splash-magic-66'))['water rune']]).toEqual([270, SPLASH_START['water rune']]);
    // Holding those, short of the start's water: the shop run at Aubury's, up to the kit's water.
    const stocked = { 'body rune': SPLASH_KIT['body rune'], 'earth rune': SPLASH_KIT['earth rune'] };
    const [shop] = run([soldier('Kilt', { ...stocked, 'water rune': 6 })]);
    expect(shop!.template!.id).toBe('army-water-aubury');
    expect(jobFor(shop!, side)).toMatchObject({ script: 'scripts/chain.ts', resources: ['shop:aubury'] });
    expect(shop!.template!.args![0]).toContain(`scripts/shop-buyer.ts aubury 3000 ITEMS=water.rune STOCK_TARGET=${SPLASH_KIT['water rune']} `);
    // A second account short of water, or the first with Aubury's shop taken, goes to Betty's in Port Sarim.
    const two = run(['A', 'B'].map(n => soldier(n, { ...stocked, 'water rune': 6 })), { pilots: new Set([...pilots, 'army-water-betty']) });
    expect(two.map(a => a.template!.id).sort()).toEqual(['army-water-aubury', 'army-water-betty']);
    const betty = run([soldier('Kilt', { ...stocked, 'water rune': 6 })], { pilots: new Set([...pilots, 'army-water-betty']), capacity: { ...CAPACITY, 'shop:aubury': 0 } })[0]!;
    expect(jobFor(betty, side)).toMatchObject({ script: 'scripts/chain.ts', resources: ['shop:betty'] });
    expect(betty.template!.args![0]).toContain(`scripts/shop-buyer.ts betty 3000 ITEMS=water.rune STOCK_TARGET=${SPLASH_KIT['water rune']} `);
    // With earth and water runes held and body runes short (absent from market or buy retired): Aubury's body-rune shop run.
    const noBody = run([soldier('Kilt', { 'earth rune': SPLASH_KIT['earth rune'], 'water rune': SPLASH_KIT['water rune'], 'body rune': 6 })],
        { pilots: new Set([...pilots, 'army-body-aubury']), market: { 'earth rune': runes['earth rune']! } })[0]!;
    expect(noBody.template!.id).toBe('army-body-aubury');
    expect(jobFor(noBody, side)).toMatchObject({ script: 'scripts/chain.ts', resources: ['shop:aubury'] });
    expect(noBody.template!.args![0]).toContain(`scripts/shop-buyer.ts aubury 3000 ITEMS=body.rune STOCK_TARGET=${SPLASH_KIT['body rune']} `);
    // With the whole kit: the band, to the Magic Guild's level, on the fence tile.
    const full = { ...stocked, 'water rune': SPLASH_KIT['water rune'] };
    const [cast] = run([soldier('Kilt', full)]);
    expect(cast!.template!.id).toBe('army-splash-magic-66');
    expect(cast!.reason).toBe(`army band ${MAGIC_BAND}: Magic to ${SPLASH_TO}`);
    expect(jobFor(cast!, side)).toMatchObject({ script: 'scripts/splash-train.ts', args: [String(SPLASH_TO), '6000'], repeat: true, resources: [SPLASH_FENCE] });
    // A fresh account casts too: Wind Strike needs the two mind and air runes it holds.
    expect(run([soldier('Kilt', full, { Magic: 1 })])[0]!.template!.id).toBe('army-splash-magic-66');
    // At the level the band is done and the Magic Guild's shelf is next. With the pilot off, or with the buy retired
    // and no runes: Ranged.
    const ranged = (accounts: Acct[], extra: Partial<Inputs> = {}) => run(accounts, extra)[0]!.template!.id;
    expect(ranged([soldier('Kilt', full, { Magic: SPLASH_TO })])).toBe('army-staff-guild');
    expect(ranged([soldier('Kilt', full)], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt')], { pilots: new Set() })).toBe('army-trooper-ranged-99');
    expect(ranged([soldier('Kilt')], { retired: new Set([pairKey('Kilt', KIT_BUY + 'army-splash-magic-66')]) })).toBe('army-trooper-ranged-99');
    // An account in the middle of Lost City finishes the quest before the rune buy of the earlier band; one that has
    // not started the quest buys first.
    const questing: Acct = { ...soldier('Kilt'), quests: new Set<string>() }, both = new Set([...pilots, 'army-quest-lostcity']);
    expect(ranged([questing], { pilots: both, current: new Map([['kilt', 'army-quest-lostcity']]) })).toBe('army-quest-lostcity');
    expect(ranged([questing], { pilots: both })).toBe(KIT_BUY + 'army-splash-magic-66');
    // SPLASH_PLACES accounts cast at a time; the rest keep training.
    const many = run(['A', 'B', 'C', 'D'].map(n => soldier(n, full)));
    expect(many.filter(a => a.template!.id === 'army-splash-magic-66').length).toBe(SPLASH_PLACES);
    expect(many.filter(a => a.template!.id === 'army-trooper-ranged-99').length).toBe(4 - SPLASH_PLACES);
});

test('the kit tier uses this side\'s own stock first: a maxed account gives all it holds, and a send brings the batch', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { shark: 40, 'adamant scimitar': 1 };
    // Monk is at Prayer 97 with 6 dragon bones and too few coins for a buy; Done is maxed and holds 41.
    const monk = acct('Monk', { ...maxed, Prayer: 97 }, { ...kit, coin: 20_000, 'dragon bone': 6 });
    const done = acct('Done', maxed, { ...kit, 'dragon bone': 41, 'nature rune': 900 });
    const army = new Set(['monk', 'done', 'half']);
    const near: Stock = { name: 'Done', side, items: done.items }, other: Stock = { name: 'Far', side: 'local', items: { 'dragon bone': 500, coin: 9_000_000 } };
    const bones: Market = { ...market, 'dragon bone': { id: 536, name: 'Dragon bones', limit: KIT_PRICE_CAPS['dragon bone']! } };
    const run = (stock: Stock[], accounts: Acct[] = [monk, done], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army, market: bones, capacity: CAPACITY, stock, ...extra })).find(a => a.account === 'Monk')!;
    // The maxed account of this side keeps nothing: Monk gets every bone it holds, up to what Prayer 99 still needs,
    // in one send, though another side has more bones and the coins to fund a buy.
    const need = BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(97)) / 1800) - 6;
    expect(need).toBeGreaterThan(41);
    expect(run([other, near]).send).toEqual({ from: 'Done', to: 'Monk', item: 'dragon bone', count: 41, template: 'army-bury-dragon-99' });
    // A donor that holds more than the batch sends the batch.
    expect(run([{ ...near, items: { ...near.items, 'dragon bone': 400 } }], [monk, acct('Done', maxed, { ...kit, 'dragon bone': 400 })]).send).toMatchObject({ from: 'Done', count: need });
    // An account of this side outside the army keeps the reserve of every band: its levels say nothing here.
    const mule = (n: number): Stock => ({ name: 'Mule', side, items: { 'dragon bone': n } });
    expect(run([mule(BONE_START + 4)], [monk]).send).toBeUndefined();
    expect(run([mule(BONE_START + 10)], [monk]).send).toEqual({ from: 'Mule', to: 'Monk', item: 'dragon bone', count: 10, template: 'army-bury-dragon-99' });
    // With no stock on this side the other side's coins fund the buy, for an account with no job it can start.
    const boneBands = catalogue().filter(t => /^army-bury-/.test(t.id));
    const funded = run([other], [monk], { templates: boneBands });
    expect(funded.send).toBeUndefined();
    expect(funded.fund).toMatchObject({ from: 'Far', to: 'Monk' });
    expect(run([other], [monk]).fund).toBeUndefined();
    // And with no market for bones the other side sends what the band needs to start, not its whole stock.
    expect(run([other], [monk], { market, templates: boneBands }).send).toEqual({ from: 'Far', to: 'Monk', item: 'dragon bone', count: BONE_START - 6, template: 'army-bury-dragon-99' });
});

import { BLACK_CAVE, BLACK_CAVE_PLACES, HIDE_TARGET, HUNT_ARROWS, HUNT_ARROW_STOCK, HUNT_BAND, HUNT_FOOD, HUNT_KILLS, HUNT_RUNE_STOCK, HUNT_RUNE_ARROWS, HUNT_RUNE_SPEND, bandLeft } from '../src/autopilot';
test('the black dragon hunt goes on rune arrows first, and a hunter short of them buys rune arrows before iron', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD };
    const pilots = new Set(['army-hunt-black-dragons-rune', 'army-hunt-black-dragons', 'army-hunt-supply-rune', 'army-hunt-supply', 'army-dusty-key']);
    const run = (items: Record<string, number>) => plan(inputs([acct('Kilt', maxed, items)], { army: new Set(['kilt']), capacity: CAPACITY, pilots }))[0]!;
    // A trip of rune arrows and a trip of iron arrows: the rune hunt, with the rune trip's arrow count.
    const trip = run({ ...kit, 'rune arrow': HUNT_RUNE_ARROWS, 'iron arrow': HUNT_ARROWS });
    expect(trip.template!.id).toBe('army-hunt-black-dragons-rune');
    expect(jobFor(trip, side)).toMatchObject({ env: { ARROW: 'rune_arrow', ARROWS: String(HUNT_RUNE_ARROWS) } });
    // Iron only: the iron hunt still runs, so the account is not idle.
    expect(run({ ...kit, 'iron arrow': HUNT_ARROWS }).template!.id).toBe('army-hunt-black-dragons');
    // No trip of either and the coins of a rune trip: the rune shop run.
    expect(run({ ...kit, 'iron arrow': 60, coin: HUNT_RUNE_SPEND + 10_000 }).template!.id).toBe('army-hunt-supply-rune');
});

test('a maxed army account hunts black dragons for hides: the key first, the kit bought, two in the cave, and its kit is not spare stock', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, coin: 200_000 };
    const pilots = new Set(['army-hunt-black-dragons', 'army-dusty-key', 'army-hunt-supply']);
    const hunter = (name: string, items: Record<string, number> = kit, s: Record<string, number> = {}): Acct => acct(name, { ...maxed, ...s }, items);
    const caps: Market = Object.fromEntries([['iron arrow', 884, 'Iron arrow'], ['law rune', 563, 'Law rune'], ['magic shortbow', 861, 'Magic shortbow'], ['shark', 385, 'Shark'], ['air rune', 556, 'Air rune'], ['fire rune', 554, 'Fire rune']]
        .map(([k, id, name]) => [k, { id: id as number, name: name as string, limit: KIT_PRICE_CAPS[k as string]! }]));
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: caps, ...extra }));
    // With the kit: the trip, nine kills on iron arrows, in the cave.
    const [trip] = run([hunter('Kilt')]);
    expect(trip!.template!.id).toBe('army-hunt-black-dragons');
    expect(trip!.reason).toBe(`army band ${HUNT_BAND}: ${HIDE_TARGET} dragonhide`);
    expect(jobFor(trip!, side)).toMatchObject({ script: 'scripts/black-dragon-camp.ts', args: ['9000'], env: { KILLS: String(HUNT_KILLS), ARROW: 'iron_arrow', ARROWS: String(HUNT_ARROWS) }, repeat: true, resources: [BLACK_CAVE] });
    // Without the key: the key job, once; the key is not a market line and holds no buy back.
    const { 'dusty key': _key, ...keyless } = kit;
    const [key] = run([hunter('Kilt', keyless)]);
    expect(key!.template!.id).toBe('army-dusty-key');
    expect(jobFor(key!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], repeat: false });
    // Short of sharks: the market buy. Short of arrows after a trip: the shop run, though a market lists arrows.
    const [buy] = run([hunter('Kilt', { ...kit, shark: 1, 'iron arrow': 60 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-hunt-black-dragons');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[385, HUNT_FOOD - 1]]);
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })])[0]!.template!.id).toBe('army-hunt-supply');
    // Local owned shop supplies arrive before a purchase. Another side's order
    // does not preempt a shop run the recipient can start.
    const donors = (s: string) => [{ name: 'Giver', side: s, items: { 'air rune': 500, 'iron arrow': 5000, shark: 50 } }];
    const noRunes = hunter('Kilt', { ...kit, 'air rune': 0, 'iron arrow': 60 }), { shark: _shark, ...noSharks } = caps;
    for (const s of [side, 'local']) {
        const out = run([noRunes], { stock: donors(s) })[0]!;
        if (s === side) expect(out.send).toMatchObject({ from: 'Giver', item: 'iron arrow', count: HUNT_ARROWS - 60 });
        else { expect(out.template!.id).toBe('army-hunt-supply'); expect(out.send).toBeUndefined(); }
    }
    const hungry = hunter('Kilt', { ...kit, shark: 1, 'iron arrow': 60 });
    expect(run([hungry], { market: noSharks, stock: donors(side) })[0]!.send).toMatchObject({ from: 'Giver', item: 'shark' });
    const first = run([hungry], { market: noSharks, stock: donors('local') })[0]!;
    expect(first.template!.id).toBe('army-hunt-supply');
    expect(first.send).toBeUndefined();
    const huntOnly = catalogue().filter(t => t.id === 'army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, shark: 1 })], { market: noSharks, stock: donors('local') })[0]!.send).toBeUndefined();
    expect(run([hunter('Kilt', { ...kit, shark: 1 })], { market: noSharks, stock: donors('local'), templates: huntOnly })[0]!.send).toMatchObject({ from: 'Giver', item: 'shark', count: HUNT_FOOD - 1 });
    // With no market for iron arrows: the shop run, arrows at Lowe's and then the teleport's runes at Aubury's.
    const { 'iron arrow': _arrows, 'fire rune': _fire, ...noShopLines } = caps;
    const [shop] = run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: noShopLines });
    expect(shop!.template!.id).toBe('army-hunt-supply');
    const job = jobFor(shop!, side);
    expect(job).toMatchObject({ script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeat: true, resources: ['shop:lowe', 'shop:aubury'] });
    expect(job.args![0]).toContain(`scripts/shop-buyer.ts lowe 2500 ITEMS=iron.arrow|bronze.arrow STOCK_TARGET=${HUNT_ARROW_STOCK} `);
    expect(job.args![1]).toContain(`scripts/shop-buyer.ts aubury 800 ITEMS=air.rune|fire.rune STOCK_TARGET=${HUNT_RUNE_STOCK} `);
    // Each step leaves a shelf it has emptied: its wait is under the shelves' restock intervals (10 ticks the least).
    expect(job.args!.map(a => Number(a.match(/NO_BUY_TICKS=(\d+)/)![1]))).toEqual([8, 8]);
    // With a trip's bronze arrows and too few iron: the same trip on bronze, before another shop run. Iron first
    // when both are held. A market that lists bronze arrows does not make them a kit buy.
    const withBronze = new Set([...pilots, 'army-hunt-black-dragons-bronze']);
    const bronze = run([hunter('Kilt', { ...kit, 'iron arrow': 60, 'bronze arrow': HUNT_ARROWS })], { market: noShopLines, pilots: withBronze })[0]!;
    expect(bronze.template!.id).toBe('army-hunt-black-dragons-bronze');
    expect(jobFor(bronze, side)).toMatchObject({ script: 'scripts/black-dragon-camp.ts', env: { KILLS: String(HUNT_KILLS), ARROW: 'bronze_arrow', ARROWS: String(HUNT_ARROWS) }, resources: [BLACK_CAVE] });
    expect(run([hunter('Kilt', { ...kit, 'bronze arrow': HUNT_ARROWS })], { market: noShopLines, pilots: withBronze })[0]!.template!.id).toBe('army-hunt-black-dragons');
    const bronzeListed: Market = { ...noShopLines, 'bronze arrow': { id: 882, name: 'Bronze arrow', limit: KIT_PRICE_CAPS['bronze arrow']! } };
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: bronzeListed, pilots: withBronze })[0]!.template!.id).toBe('army-hunt-supply');
    // The two variants share the cave's two places.
    expect(run(['A', 'B', 'C'].map(n => hunter(n, { ...kit, 'bronze arrow': HUNT_ARROWS, 'iron arrow': n === 'A' ? HUNT_ARROWS : 0 })), { market: noShopLines, pilots: withBronze }).filter(a => /^army-hunt-black-dragons/.test(a.template?.id ?? '')).length).toBe(BLACK_CAVE_PLACES);
    // The same for a teleport's fire rune alone; a full kit hunts, and the run ends with the hunt.
    expect(run([hunter('Kilt', { ...kit, 'fire rune': 0 })], { market: noShopLines })[0]!.template!.id).toBe('army-hunt-supply');
    expect(run([hunter('Kilt')], { market: noShopLines })[0]!.template!.id).toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60, dragonhide: HIDE_TARGET })], { market: noShopLines })[0]!.template?.id).not.toBe('army-hunt-supply');
    expect(run([hunter('Kilt', { ...kit, 'iron arrow': 60 })], { market: noShopLines, pilots: new Set(['army-hunt-black-dragons']) })[0]!.template?.id).not.toBe('army-hunt-supply');
    // The band stands down at its hides, is off without the pilot, and is not for an account with training left.
    expect(bandLeft(trip!.template!, hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET - 3 }))).toBe(3);
    expect(run([hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET })])[0]!.template?.id).not.toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt')], { pilots: new Set() })[0]!.template?.id).not.toBe('army-hunt-black-dragons');
    expect(run([hunter('Kilt', { ...kit, shortbow: 1, 'bronze arrow': 500 }, { Ranged: 95 })])[0]!.template!.id).toBe('army-trooper-ranged-99');
    // Two hunters at a time.
    expect(run(['A', 'B', 'C'].map(n => hunter(n))).filter(a => a.template?.id === 'army-hunt-black-dragons').length).toBe(BLACK_CAVE_PLACES);
    // A hunter between trips is a free maxed account, and still keeps its kit: a Prayer account that lacks sharks
    // for nothing of its own gets none of the hunter's six, and gets its spare dragon bones.
    const monk = acct('Monk', { ...maxed, Prayer: 97 }, { 'adamant scimitar': 1, coin: 20_000, 'dragon bone': 6 });
    const idle = hunter('Kilt', { ...kit, dragonhide: HIDE_TARGET - 1, 'dragon bone': 30 });
    const sent = plan(inputs([monk, idle], { army: new Set(['monk', 'kilt']), capacity: { ...CAPACITY, [BLACK_CAVE]: 0 }, pilots, market: caps, stock: [{ name: 'Kilt', side, items: idle.items }] })).find(a => a.account === 'Monk')!;
    expect(sent.send).toMatchObject({ from: 'Kilt', item: 'dragon bone', count: 30 });
});

import { ARMOUR_SETS, FLAX_SPIN, LEATHER_LEVEL, SET_HIDES, SET_SHOP, TAN_COIN } from '../src/autopilot';
test('a hunter makes its hides into armour: flax to Crafting 84 when it cannot hunt, then whole sets, and no flax or hide is traded for it', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, coin: 200_000 };
    const pilots = new Set(['army-hunt-black-dragons', 'army-dusty-key', 'army-hunt-supply', 'army-black-dhide-sets', 'army-leather-flax', 'army-leather-spin']);
    const hunter = (name: string, items: Record<string, number>, crafting: number): Acct => acct(name, { ...maxed, Crafting: crafting }, { ...kit, ...items });
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: {}, ...extra }));
    const first = (a: Acct, extra: Partial<Inputs> = {}) => run([a], extra)[0]!;
    // With arrows it hunts, whatever its Crafting.
    expect(first(hunter('Kilt', { dragonhide: 9 }, 54)).template!.id).toBe('army-hunt-black-dragons');
    // Short of arrows and under Crafting 84: flax first, then the wheel once a run's flax is banked; before the shop.
    const flax = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9 }, 54));
    expect(flax.template!.id).toBe('army-leather-flax');
    expect(flax.reason).toBe(`army band ${HUNT_BAND + 0.2}: Crafting to ${LEATHER_LEVEL}`);
    expect(jobFor(flax, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'], repeat: true });
    const spin = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9, flax: FLAX_SPIN }, 54));
    expect(spin.template!.id).toBe('army-leather-spin');
    expect(jobFor(spin, side).args).toEqual(['skiller', 'crafting', 'bowstrings', '2500', `MAX_MAKE=${FLAX_SPIN}`, 'RAW_RESERVE=0', 'MAX_TRIPS=8']);
    // Under the wheel's Crafting 10 the band is not for it: the shop run.
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: 9 }, 9)).template!.id).toBe('army-hunt-supply');
    // At Crafting 84 with a set's hides: the sets, before the shop; with fewer hides, or its bodies made, the shop.
    const sets = first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES }, LEATHER_LEVEL));
    expect(sets.template!.id).toBe('army-black-dhide-sets');
    expect(sets.reason).toBe(`army band ${HUNT_BAND + 0.1}: ${ARMOUR_SETS} dragonhide body`);
    expect(jobFor(sets, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['skiller', 'crafting', 'black-dhide-sets'], repeat: true });
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES - 1 }, LEATHER_LEVEL)).template!.id).toBe('army-hunt-supply');
    expect(first(hunter('Kilt', { 'iron arrow': 40, dragonhide: SET_HIDES, 'dragonhide body': ARMOUR_SETS }, LEATHER_LEVEL)).template!.id).toBe('army-hunt-supply');
    expect(catalogue().find(t => t.id === 'army-black-dhide-sets')!.needs!.items!.coins).toBe(SET_HIDES * TAN_COIN + SET_SHOP);
    // One account in the flax field: the second, short of arrows too, takes the shop run.
    const pair = run([hunter('Kilt', { 'iron arrow': 40 }, 54), hunter('Snake', { 'iron arrow': 40 }, 54)]);
    expect(pair.map(a => a.template!.id).sort()).toEqual(['army-hunt-supply', 'army-leather-flax']);
    // No trade for the band's flax or for a set's hides: an account with flax to spare and hides to spare gives none.
    const rich = { name: 'Rich', side, items: { flax: 2000, dragonhide: 40 } }, far = { name: 'Far', side: 'local', items: { flax: 2000, dragonhide: 40 } };
    for (const a of [hunter('Kilt', { 'iron arrow': 40 }, 54), hunter('Kilt', { 'iron arrow': 40, dragonhide: 2 }, LEATHER_LEVEL)]) {
        const out = first(a, { stock: [rich, far] });
        expect(out.send).toBeUndefined();
    }
});

import { JAKUT_CAP, JAKUT_COINS, JAKUT_RESERVE, JAKUT_SWORDS, JAKUT_WAIT } from '../src/autopilot';
test('an account with Lost City buys its dragon longswords from Jakut: the diamond on the market first, then one visit', () => {
    const maxed = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99 };
    const done = new Set(['lost city']), pilots = new Set(['army-jakut-swords']);
    const diamond: Market = { diamond: { id: 1601, name: 'Diamond', limit: KIT_PRICE_CAPS.diamond! } };
    const who = (items: Record<string, number>, quests: ReadonlySet<string> | undefined = done): Acct => ({ ...acct('Snake', maxed, { 'dramen staff': 1, coin: 900_000, ...items }), ...(quests ? { quests } : {}) });
    const first = (a: Acct, extra: Partial<Inputs> = {}) => plan(inputs([a], { army: new Set(['snake']), capacity: CAPACITY, pilots, market: diamond, ...extra }))[0]!;
    // No diamond: the market buy of one, under its cap.
    const buy = first(who({}));
    expect(buy.template!.id).toBe(KIT_BUY + 'army-jakut-swords');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+) .*LIMIT_PRICE=(\d+)/)!.slice(1).map(Number))).toEqual([[1601, 1, 150_000]]);
    // With the diamond: the visit by the shop run, two swords, a buy request each tick on a shelf other players
    // empty, the coins of two units of an emptied shelf over the run's reserve.
    const visit = first(who({ diamond: 1 }));
    expect(visit.template!.id).toBe('army-jakut-swords');
    expect(visit.reason).toBe(`army band ${HUNT_BAND + 0.05}: 1 dragon longsword`);
    expect(jobFor(visit, side)).toMatchObject({ script: 'scripts/chain.ts', repeat: false, resources: ['shop:jukat'],
        args: [`scripts/shop-buyer.ts jukat ${JAKUT_CAP} BLIND_BUY=1 STOCK_TARGET=${JAKUT_SWORDS} STOP_AT_TARGET=1 BANK_AT=0 NO_BUY_TICKS=${JAKUT_WAIT} STALL_TICKS=0 COIN_RESERVE=${JAKUT_RESERVE} FLOAT=${JAKUT_COINS}`] });
    expect(catalogue().find(t => t.id === 'army-jakut-swords')!.needs!.items!.coins).toBe(JAKUT_COINS);
    expect(JAKUT_COINS - JAKUT_RESERVE).toBeGreaterThanOrEqual(JAKUT_SWORDS * 101_000);
    expect(JAKUT_WAIT).toBeGreaterThan(500);
    // One account at the shelf at a time.
    const pair = plan(inputs([who({ diamond: 1 }), { ...who({ diamond: 1 }), name: 'Adder' }], { army: new Set(['snake', 'adder']), capacity: CAPACITY, pilots, market: diamond }));
    expect(pair.filter(a => a.template?.id === 'army-jakut-swords').length).toBe(1);
    // Not with a sword held (one more would cost a second diamond), not without the quest, not without the pilot.
    expect(first(who({ diamond: 1, 'dragon longsword': 1 })).template?.id).not.toBe('army-jakut-swords');
    expect(first(who({ diamond: 1 }, new Set())).template?.id).not.toBe('army-jakut-swords');
    expect(first(who({ diamond: 1 }), { pilots: new Set() }).template?.id).not.toBe('army-jakut-swords');
    // A hunter with arrows hunts first; short of arrows it goes to Jakut before the shop run.
    const kit = { 'dusty key': 1, 'magic shortbow': 1, 'iron arrow': HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD, diamond: 1 };
    const both = new Set(['army-jakut-swords', 'army-hunt-black-dragons', 'army-hunt-supply']);
    expect(first(who(kit), { pilots: both }).template!.id).toBe('army-hunt-black-dragons');
    expect(first(who({ ...kit, 'iron arrow': 40 }), { pilots: both }).template!.id).toBe('army-jakut-swords');
});

import { GRAIL_BAND, GRAIL_MEALS, GRAIL_PLACE, GRAIL_RUNES } from '../src/autopilot';
test('an army account takes Merlin\'s Crystal and Holy Grail for its Prayer: the runes bought first, one account at a time', () => {
    const base = { Thieving: 99, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 78 };
    const kit = { 'rune scimitar': 1, shark: 40, coin: 300_000, 'law rune': 12, 'air rune': 46, 'water rune': 6, 'fire rune': 1 };
    const pilots = new Set(['army-quest-holygrail']), done = (...q: string[]) => new Set(q.map(n => n.toLowerCase()));
    const who = (name: string, items: Record<string, number> = kit, s: Record<string, number> = {}, quests: ReadonlySet<string> = done('Lost City')): Acct => ({ ...acct(name, { ...base, ...s }, items), quests });
    const runes: Market = Object.fromEntries([['law rune', 563, 'Law rune'], ['air rune', 556, 'Air rune'], ['water rune', 555, 'Water rune'], ['fire rune', 554, 'Fire rune']]
        .map(([k, id, name]) => [k, { id: id as number, name: name as string, limit: KIT_PRICE_CAPS[k as string]! }]));
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY, pilots, market: runes, ...extra }));
    // With the kit: the chain of the two quests.
    const [x] = run([who('Monk')]);
    expect(x!.template!.id).toBe('army-quest-holygrail');
    expect(x!.reason).toBe(`army band ${GRAIL_BAND}: Holy Grail`);
    expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'chain', 'merlin,grail'], repeat: false, resources: [GRAIL_PLACE] });
    expect(catalogue().find(t => t.id === 'army-quest-holygrail')!.needs).toMatchObject({ items: { 'rune scimitar': 1, ...GRAIL_RUNES }, pieces: { count: GRAIL_MEALS } });
    // Short of the teleports' law runes: the band's own buy, of what is short.
    const [buy] = run([who('Monk', { ...kit, 'law rune': 2 })]);
    expect(buy!.template!.id).toBe(KIT_BUY + 'army-quest-holygrail');
    expect(buy!.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[563, 10]]);
    // One account in Camelot's fights at a time.
    expect(run([who('A'), who('B')]).filter(a => a.template?.id === 'army-quest-holygrail').length).toBe(1);
    // Not once the quest is done, not under the Magic the Camelot teleport asks, not without the pilot.
    expect(run([who('Monk', kit, {}, done('Lost City', "Merlin's Crystal", 'Holy Grail'))])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk', kit, { Magic: 40 })])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk')], { pilots: new Set() })[0]!.template?.id).not.toBe('army-quest-holygrail');
    // Not at Prayer 99, with the kit or short of it: the quests pay a maxed account nothing.
    expect(run([who('Monk', kit, { Prayer: 99 })])[0]!.template?.id).not.toBe('army-quest-holygrail');
    expect(run([who('Monk', { ...kit, 'law rune': 2 }, { Prayer: 99 })])[0]!.template?.id).not.toBe(KIT_BUY + 'army-quest-holygrail');
});


test('army combat jobs leave optional loot to the worker that reconciles its assets', () => {
    const training = catalogue().filter(t => t.tier === 'goal' && t.script === 'scripts/gather-combat.ts');
    expect(training.length).toBeGreaterThan(5);
    for (const template of training) {
        const job = jobFor({ account: 'Soldier', template, reason: 'train a missing army level', value: 0, resources: template.resources ?? [] }, side);
        expect(job.env?.LOOT_WATCH).toBe('0');
    }
});

test('an account with a PK build trains to the levels of the build and no further', async () => {
    const { buildBand, catalogue: all } = await import('../src/autopilot');
    const dragon = { Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, pure = { ...dragon, Defence: 1, Prayer: 1 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!;
    const fresh = acct('Build', { Attack: 1, Strength: 1, Defence: 1 });
    // No build: the band as listed. A skill at its level: no band. Defence 1 never trains Defence.
    expect(buildBand(byId('army-cow-defence-45'), fresh)).toBe(byId('army-cow-defence-45'));
    expect(buildBand(byId('army-cow-defence-45'), fresh, pure)).toBeNull();
    expect(buildBand(byId('army-cow-attack-45'), acct('Build', { Attack: 60 }), dragon)).toBeNull();
    // A cow band stops at its own end, and the trooper band at the level of the build.
    expect(buildBand(byId('army-cow-defence-45'), fresh, dragon)!.env!.TARGET_LEVEL).toBe('45');
    const trooper = buildBand(byId('army-trooper-defence-99'), acct('Build', { Defence: 55 }), dragon)!;
    expect(trooper.env!.TARGET_LEVEL).toBe('60');
    expect(trooper.trains!.to).toBe(60);
    expect(buildBand(byId('army-trooper-strength-99'), fresh, dragon)!.env!.TARGET_LEVEL).toBe('99');
    // No band buries bones: bones give Prayer XP. The Prayer band of the trooper field counts kills and keeps the
    // style of the account, so it is refused even for a build with Prayer above the account's level.
    expect(byId('army-trooper-ranged-99').env!.GIANT_BURY).toBe('1');
    expect(buildBand(byId('army-trooper-ranged-99'), fresh, pure)!.env!.GIANT_BURY).toBe('0');
    const ranged45=buildBand(byId('army-trooper-ranged-99'),acct('Build',{Ranged:40}),{...pure,Ranged:45})!;
    expect(ranged45.args).toEqual(['1500','trooper']);expect(ranged45.env!.TARGET_LEVEL).toBe('45');expect(ranged45.trains!.to).toBe(45);
    expect(trooper.env!.GIANT_BURY).toBe('0');
    expect(buildBand(byId('army-trooper-prayer-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    // Prayer comes from held normal bones only, to the level of the build: the worker's target argument.
    const bury = buildBand(byId('army-bury-prayer-99'), acct('Build', { Prayer: 20 }), dragon)!;
    expect(bury.args).toEqual(['43']); expect(bury.trains!.to).toBe(43); expect(bury.env!.BURY_HELD).toBe('1');
    expect(buildBand(byId('army-bury-prayer-99'), acct('Build', { Prayer: 43 }), dragon)).toBeNull();
    expect(buildBand(byId('army-bury-prayer-99'), fresh, pure)).toBeNull();
    expect(buildBand(byId('army-bury-dragon-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    expect(buildBand(byId('army-bury-big-99'), acct('Build', { Prayer: 20 }), dragon)).toBeNull();
    for (const t of templates.filter(t => t.tier === 'goal')) for (const build of [pure, dragon]) {
        const got = buildBand(t, fresh, build);
        if (got?.script === 'scripts/gather-combat.ts') { expect(got.env!.GIANT_BURY).toBe('0'); expect(got.env!.GIANT_KILLS).toBeUndefined(); expect(got.env!.TRAIN_SKILL).toBe(got.trains!.skill); }
    }
    // A band of another script that ends above the level, a quest band and a stock band are refused.
    for (const t of templates.filter(t => t.tier === 'goal')) {
        const got = buildBand(t, fresh, pure);
        if (t.quest || t.stock || t.trains?.skill === 'Defence' || t.trains?.skill === 'Prayer') expect(got).toBeNull();
        if (got && got.trains && pure[got.trains.skill as keyof typeof pure] !== undefined) expect(got.trains.to).toBeLessThanOrEqual(pure[got.trains.skill as keyof typeof pure]);
    }
    // In a plan: the build account gets no Defence band, the plain army account does.
    const melee = { Attack: 45, Strength: 45, Defence: 1, Hitpoints: 40 }, kit = { 'bronze sword': 1, 'wooden shield': 1, trout: 30 };
    const army = new Set(['build', 'plain']);
    const planned = plan(inputs([acct('Build', melee, kit), acct('Plain', melee, kit)], { army, builds: new Map([['build', pure]]), capacity: CAPACITY }));
    const of = (name: string) => planned.find(x => x.account === name)?.template;
    expect(of('Plain')?.trains?.skill).toBe('Defence');
    expect(of('Build')?.trains?.skill).not.toBe('Defence');
    if (of('Build')?.script === 'scripts/gather-combat.ts') expect(Number(of('Build')!.env!.TARGET_LEVEL)).toBeLessThanOrEqual(99);
});

test('a build with a Fremennik helm takes The Fremennik Trials under its levels before the quest, and trains to them first', async () => {
    const { buildBand, catalogue: all, FREMENNIK, FREMENNIK_BAND } = await import('../src/autopilot');
    const tank = { Attack: 74, Strength: 73, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, before = { Attack: 68, Strength: 61, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!, band = byId('army-quest-fremennik'), route = ['The Fremennik Trials'];
    expect(band).toMatchObject({ buildOnly: true, pilot: true, band: FREMENNIK_BAND, resources: [FREMENNIK], args: ['quester', 'chain', 'drunkmonk,murder,viking'] });
    const ready = { ...acct('Tank', { Attack: 68, Strength: 61, Defence: 1, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 96, Fletching: 25 }), quests: new Set<string>() };
    // No build: an army account never takes the band. A build with the route: at or under the levels before it.
    expect(buildBand(band, ready)).toBeNull();
    expect(buildBand(band, ready, tank, route, before)).toBe(band);
    expect(buildBand(band, ready, tank, [], before)).toBeNull();
    // One level over a level before the route: the reward would end over the build. Hitpoints are not a limit.
    expect(buildBand(band, { ...ready, skills: { ...ready.skills, Attack: 69 } }, tank, route, before)).toBeNull();
    expect(buildBand(band, { ...ready, skills: { ...ready.skills, Defence: 8 } }, tank, route, before)).toBeNull();
    // While the quest is open a training band stops at the level before the route; with the quest done, at the build.
    const low = { ...ready, skills: { ...ready.skills, Attack: 50, Strength: 50 } };
    expect(buildBand(byId('army-trooper-attack-99'), low, tank, route, before)!.env!.TARGET_LEVEL).toBe('68');
    expect(buildBand(byId('army-trooper-strength-99'), low, tank, route, before)!.env!.TARGET_LEVEL).toBe('61');
    expect(buildBand(byId('army-trooper-attack-99'), ready, tank, route, before)).toBeNull();
    expect(buildBand(byId('army-cow-defence-45'), ready, tank, route, before)!.env!.TARGET_LEVEL).toBe('7');
    const done = { ...low, quests: new Set(['the fremennik trial']) };
    expect(buildBand(byId('army-trooper-attack-99'), done, tank, route, before)!.env!.TARGET_LEVEL).toBe('74');
    // In a plan: the build account with the levels, the coins and the meals is a candidate; a plain army account is not.
    const who = (name: string) => ({ ...acct(name, { ...ready.skills, Hitpoints: 94 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set(['lost city']) });
    const run = (extra: Partial<Inputs>) => plan(inputs([who('Tank')], { army: new Set(['tank']), pilots: new Set(['army-quest-fremennik']), capacity: CAPACITY, ...extra }))[0]!.template?.id;
    expect(run({ builds: new Map([['tank', tank]]), buildQuests: new Map([['tank', route]]), buildBefore: new Map([['tank', before]]) })).toBe('army-quest-fremennik');
    expect(run({})).not.toBe('army-quest-fremennik');
    expect(CAPACITY[FREMENNIK]).toBe(1);
    // The Berserker helm build goes with Attack 7 and Strength 99; an account with neither set of levels does not.
    const zerk = { Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, zBefore = { Attack: 7, Strength: 99, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 99 };
    const z = (strength: number) => ({ ...acct('Zerk', { Attack: 7, Strength: strength, Defence: 1, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94, Fletching: 25 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set(['lost city']) });
    const zrun = (strength: number) => plan(inputs([z(strength)], { army: new Set(['zerk']), pilots: new Set(['army-quest-fremennik']), capacity: CAPACITY,
        builds: new Map([['zerk', zerk]]), buildQuests: new Map([['zerk', ['Lost City', 'The Fremennik Trials']]]), buildBefore: new Map([['zerk', zBefore]]) }))[0]!.template?.id;
    expect(zrun(99)).toBe('army-quest-fremennik');
    expect(zrun(80)).not.toBe('army-quest-fremennik');
});

test('a build with The Fremennik Trials on its route makes headless arrows to Fletching 25 before the quest', async () => {
    const { buildBand, catalogue: all, FLETCH_MAKE, FLETCH_KEEP, FREMENNIK_BAND, ARMY_BANK } = await import('../src/autopilot');
    const { xpForLevel } = await import('../src/curve');
    const tank = { Attack: 74, Strength: 73, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }, before = { Attack: 68, Strength: 60, Defence: 7, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94 };
    const templates = all(), band = templates.find(t => t.id === 'army-fletch-25')!, route = ['The Fremennik Trials'];
    expect(band).toMatchObject({ buildOnly: true, pilot: true, route: 'The Fremennik Trials', script: 'scripts/chain.ts', env: { ROUNDS: '1' }, repeats: false, trains: { skill: 'Fletching', to: 25, unlocks: ['army-quest-fremennik'] } });
    expect(band.band!).toBeLessThan(FREMENNIK_BAND);
    expect(band.args).toEqual([`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, 'scripts/fletch-arrows.ts 3000 headless MAX_MAKE=210 SHAFT_RESERVE=100 FEATHER_RESERVE=100 BANK_PACK=1']);
    // 25 XP an arrow at the server's rate reaches level 25 from level 1; the worker makes sets of 15 and keeps 100.
    expect(FLETCH_MAKE * 25).toBeGreaterThanOrEqual(xpForLevel(25));
    expect(FLETCH_MAKE % 15).toBe(0);
    expect(band.needs).toEqual({ items: { 'arrow shaft': FLETCH_MAKE + FLETCH_KEEP, feather: FLETCH_MAKE + FLETCH_KEEP } });
    const a = { ...acct('Tank', { Attack: 68, Strength: 60, Prayer: 43, Hitpoints: 94 }), quests: new Set<string>() };
    // Only a build with the quest on its route and open: not a plain army account, not another build, not after the quest.
    expect(buildBand(band, a)).toBeNull();
    expect(buildBand(band, a, tank, route, before)).toBe(band);
    expect(buildBand(band, a, tank, ['Lost City'], before)).toBeNull();
    expect(buildBand(band, { ...a, quests: new Set(['the fremennik trial']) }, tank, route, before)).toBeNull();
    // In a plan: with the shafts and the feathers the account takes the band; at Fletching 25 it does not.
    const who = (fletching: number) => ({ ...acct('Tank', { ...a.skills, Ranged: 99, Magic: 99, Fletching: fletching }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, 'arrow shaft': 310, feather: 310 }), quests: new Set(['lost city']) });
    const run = (fletching: number) => plan(inputs([who(fletching)], { army: new Set(['tank']), pilots: new Set(['army-fletch-25', 'army-quest-fremennik']), capacity: CAPACITY,
        builds: new Map([['tank', tank]]), buildQuests: new Map([['tank', route]]), buildBefore: new Map([['tank', before]]) }))[0]!.template?.id;
    expect(run(1)).toBe('army-fletch-25');
    expect(run(25)).toBe('army-quest-fremennik');
});

test('a Defence 1 build buys the two prayer potions of Lost City on the Grand Exchange', async () => {
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43 };
    const who = (items: Record<string, number>) => ({ ...acct('Pure', { Attack: 60, Strength: 99, Ranged: 99, Prayer: 43, Hitpoints: 93 }, { coin: 600_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500, ...items }), quests: new Set<string>() });
    const market: Market = { 'prayer potion(4)': { id: 2434, name: 'Prayer potion(4)', limit: KIT_PRICE_CAPS['prayer potion(4)']! } };
    const run = (items: Record<string, number>, extra: Partial<Inputs> = {}) => plan(inputs([who(items)], { army: new Set(['pure']), pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY,
        builds: new Map([['pure', pure]]), buildQuests: new Map([['pure', ['Lost City']]]), buildBefore: new Map([['pure', pure]]), market, ...extra }))[0]!;
    // No potion held: one order of two, at the cap. With the potions: the quest. With no listing: no quest and no buy.
    const buy = run({});
    expect(buy.template!.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.template!.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+) .*LIMIT_PRICE=(\d+)/)!.slice(1).map(Number))).toEqual([[2434, 2, 260_000]]);
    expect(run({ 'prayer potion(4)': 2 }).template!.id).toBe('army-quest-lostcity');
    expect(run({}, { market: {} }).template?.id).not.toBe(KIT_BUY + 'army-quest-lostcity');
    expect(run({}, { market: {} }).template?.id).not.toBe('army-quest-lostcity');
});

test('an account with a PK build takes a quest band only on the quest route of its kit', async () => {
    const { buildBand, BUILD_QUESTS, catalogue: all } = await import('../src/autopilot');
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43 };
    const templates = all(), byId = (id: string) => templates.find(t => t.id === id)!, fresh = acct('Build', { Attack: 1 });
    const lostCity = byId('army-quest-lostcity'), grail = byId('army-quest-holygrail');
    // The route table: Lost City for a build with a dragon dagger, The Fremennik Trials for the Archer helm, no quest
    // for a build whose gear needs none.
    expect(BUILD_QUESTS).toMatchObject({ 'pure-pray': ['Lost City'], 'baby-pure': [], dragon: ['Lost City'], 'tank-range': ['The Fremennik Trials'] });
    // On the route: the band as listed. Off the route, with an empty route or with none: refused.
    expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS['pure-pray'])).toBe(lostCity);
    expect(buildBand(grail, fresh, pure, BUILD_QUESTS['pure-pray'])).toBeNull();
    for (const kit of ['baby-pure', 'tank-range', 'pure-ranger']) expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS[kit])).toBeNull();
    expect(buildBand(lostCity, fresh, pure, BUILD_QUESTS.dragon)).toBe(lostCity);
    expect(buildBand(lostCity, fresh, pure)).toBeNull();
    // A route changes no other band: every band that is not a quest gets the same answer with it and without it.
    for (const t of templates.filter(t => t.tier === 'goal' && !t.quest)) expect(buildBand(t, fresh, pure, ['Lost City'])).toEqual(buildBand(t, fresh, pure));
    for (const t of templates.filter(t => t.tier === 'goal' && t.stock)) expect(buildBand(t, fresh, pure, ['Lost City'])).toBeNull();
    // In a plan: the account with a route is a candidate for Lost City, the account with the same build and no route is not.
    // The account has the levels that the Lost City band asks of every army account (Defence 90 and Hitpoints 90).
    const who = (name: string) => ({ ...acct(name, { Attack: 60, Strength: 99, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 93, Defence: 90 }, { coin: 100_000, shark: 40, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 }), quests: new Set<string>() });
    const run = (buildQuests?: Map<string, readonly string[]>) => plan(inputs([who('Build')], { army: new Set(['build']), builds: new Map([['build', pure]]), buildQuests, pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY }))[0]!.template?.id;
    expect(run(new Map([['build', ['Lost City']]]))).toBe('army-quest-lostcity');
    expect(run()).not.toBe('army-quest-lostcity');
    expect(run(new Map([['build', []]]))).not.toBe('army-quest-lostcity');
});

test('a Defence 1 build account takes Lost City with the levels, potions and food of the practice run', async () => {
    const { LOST_CITY_BUILD, KIT_BUY, KIT_PRICE_CAPS } = await import('../src/autopilot');
    // The levels of the `pure-pray` kit (scripts/pk-kits.ts kitSkills): Defence 1 and Magic 1.
    const pure = { Attack: 60, Strength: 99, Defence: 1, Ranged: 99, Magic: 1, Prayer: 43, Hitpoints: 93 };
    expect(LOST_CITY_BUILD).toEqual({ skills: { Attack: 60, Strength: 99, Prayer: 43, Hitpoints: 93 }, items: { 'prayer potion(4)': 2 }, pieces: { of: ['lobster', 'swordfish', 'shark'], count: 6 } });
    for (const [skill, level] of Object.entries(LOST_CITY_BUILD.skills!)) expect(pure[skill as keyof typeof pure]).toBeGreaterThanOrEqual(level);
    const kit = { coin: 100_000, 'prayer potion(4)': 2, lobster: 6, 'adamant scimitar': 1, shortbow: 1, 'bronze arrow': 500 };
    const food: Market = { lobster: { id: 379, name: 'Lobster', limit: KIT_PRICE_CAPS.lobster! } };
    const first = (skills: Record<string, number>, items: Record<string, number>, extra: Partial<Inputs> = {}) => plan(inputs([{ ...acct('Build', skills, items), quests: new Set<string>() }],
        { army: new Set(['build']), builds: new Map([['build', pure]]), buildQuests: new Map([['build', ['Lost City']]]), pilots: new Set(['army-quest-lostcity']), capacity: CAPACITY, ...extra }))[0]!.template;
    expect(first(pure, kit)!.id).toBe('army-quest-lostcity');
    // One level short, or no prayer potion (no market sells one): no Lost City and no buy for it.
    for (const short of [{ Hitpoints: 92 }, { Prayer: 42 }, { Strength: 98 }, { Attack: 59 }]) expect(first({ ...pure, ...short }, kit, { market: food })?.id ?? '').not.toContain('army-quest-lostcity');
    expect(first(pure, { ...kit, 'prayer potion(4)': 1 }, { market: food })?.id ?? '').not.toContain('army-quest-lostcity');
    // Short of food only: the band buys the 6 meals of the practice pack, not the 10 of an account with Defence 90.
    const buy = first(pure, { ...kit, lobster: 0 }, { market: food })!;
    expect(buy.id).toBe(KIT_BUY + 'army-quest-lostcity');
    expect(buy.args!.map(a => a.match(/ITEM_ID=(\d+) QUANTITY=(\d+)/)!.slice(1).map(Number))).toEqual([[379, 6]]);
});

test('the halberd build trains Thieving and Agility, then takes Underground Pass and Regicide', async () => {
    const { buildBand, catalogue: all, BUILD_QUESTS, ROUTE_BEFORE, UPASS, UPASS_AGILITY, UPASS_THIEVING, UPASS_MEALS, REGICIDE_MEALS, QUEST_BOW_ARROWS, REGICIDE_RUNES, REGICIDE_PACK, KIT_BUY, KIT_PRICE_CAPS } = await import('../src/autopilot');
    // The levels of the `pure-hally` kit and its levels before the route (scripts/pk-kits.ts): the reward of
    // Underground Pass takes Attack from 11 to 61.
    const hally = { Attack: 61, Strength: 99, Defence: 1, Ranged: 99, Magic: 54, Prayer: 43 }, before = { Attack: 11, Strength: 99, Defence: 1, Ranged: 99, Magic: 53, Prayer: 43, Hitpoints: 93 };
    const route = BUILD_QUESTS['pure-hally']!, templates = all(), byId = (id: string) => templates.find(t => t.id === id)!;
    const thieve = byId('army-thieve-50'), agility = byId('army-agility-68'), upass = byId('army-quest-upass'), regicide = byId('army-quest-regicide');
    expect(route).toEqual(['Regicide']);
    expect(ROUTE_BEFORE.Regicide).toEqual(['Underground Pass']);
    expect([UPASS_THIEVING, UPASS_AGILITY, CAPACITY[UPASS]]).toEqual([50, 68, 1]);
    expect(thieve).toMatchObject({ buildOnly: true, pilot: true, route: 'Underground Pass', script: 'scripts/generated/thieving60.ts', env: { TARGET: '50' }, trains: { skill: 'Thieving', to: 50 } });
    expect(agility).toMatchObject({ buildOnly: true, pilot: true, route: 'Underground Pass', args: ['skiller', 'agility', 'order', 'gnome', '68'], trains: { skill: 'Agility', to: 68 } });
    expect(upass).toMatchObject({ buildOnly: true, pilot: true, gives: ['Attack'], args: ['quester', 'chain', 'elena,biohazard,upass'], quest: { name: 'Underground Pass' } });
    expect(regicide).toMatchObject({ buildOnly: true, pilot: true, gives: ['Magic'], args: ['quester', 'chain', 'murder,regicide'], quest: { name: 'Regicide' } });
    expect(upass.needs).toEqual({ skills: { Ranged: 99, Prayer: 43, Hitpoints: 90, Thieving: 50, Agility: 68 }, items: { coins: 5000, 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS, 'prayer potion(4)': 2 },
        pieces: { of: ['lobster', 'swordfish', 'shark'], count: UPASS_MEALS } });
    expect(regicide.needs).toEqual({ quests: ['Underground Pass'], skills: { Ranged: 99, Magic: 51, Prayer: 43, Hitpoints: 90, Agility: 68 }, items: { coins: 2000, 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS, ...REGICIDE_RUNES, ...REGICIDE_PACK },
        pieces: { of: ['lobster', 'swordfish', 'shark'], count: REGICIDE_MEALS } });
    expect(REGICIDE_PACK).toEqual({ coal: 8, 'cooked rabbit': 1, limestone: 1, 'iron fire arrow': 2, 'pestle and mortar': 1, rope: 2 });
    expect([UPASS_MEALS, REGICIDE_MEALS]).toEqual([12, 30]);
    expect([thieve.band!, agility.band!, upass.band!, regicide.band!]).toEqual([...[thieve.band!, agility.band!, upass.band!, regicide.band!]].sort((a, b) => a - b));
    // Every item of the two kits that a buy may order has a price cap.
    for (const item of ['magic shortbow', 'rune arrow', 'prayer potion(4)', 'shark', 'coal', ...Object.keys(REGICIDE_RUNES)]) expect(KIT_PRICE_CAPS[item]).toBeGreaterThan(0);
    const fresh = { ...acct('Hally', before), quests: new Set<string>() }, passed = { ...acct('Hally', { ...before, Attack: 61 }), quests: new Set(['underground pas']) };
    // Only a build with Regicide on its route: not a plain army account, not a build with another route.
    for (const band of [thieve, agility, upass, regicide]) {
        expect(buildBand(band, fresh)).toBeNull();
        expect(buildBand(band, fresh, hally, ['Lost City'], before)).toBeNull();
        expect(buildBand(band, fresh, hally, route, before)).toBe(band);
    }
    // After Underground Pass the two trainers and the quest band of the pass are gone for the planner (the quest band
    // by its target), and Regicide stays although Attack is over its level before the route. Magic over it refuses.
    expect(buildBand(thieve, passed, hally, route, before)).toBeNull();
    expect(buildBand(agility, passed, hally, route, before)).toBeNull();
    expect(buildBand(regicide, passed, hally, route, before)).toBe(regicide);
    expect(buildBand(regicide, { ...passed, skills: { ...passed.skills, Magic: 54 } }, hally, route, before)).toBeNull();
    // Attack over the level before the route refuses Underground Pass: its reward would end over the build.
    expect(buildBand(upass, { ...fresh, skills: { ...fresh.skills, Attack: 12 } }, hally, route, before)).toBeNull();
    // In a plan, step by step.
    const kit = { coin: 100_000, shark: 40, 'magic shortbow': 1, 'rune arrow': 600, 'prayer potion(4)': 2, 'law rune': 5, 'air rune': 3, 'water rune': 5, ...REGICIDE_PACK };
    const pilots = new Set(['army-thieve-50', 'army-agility-68', 'army-quest-upass', 'army-quest-regicide']);
    const first = (skills: Record<string, number>, items: Record<string, number> = kit, quests: string[] = [], extra: Partial<Inputs> = {}) => plan(inputs([{ ...acct('Hally', { ...before, ...skills }, items), quests: new Set(quests) }],
        { army: new Set(['hally']), builds: new Map([['hally', hally]]), buildQuests: new Map([['hally', route]]), buildBefore: new Map([['hally', before]]), pilots, capacity: CAPACITY, ...extra }))[0]!.template?.id;
    expect(first({})).toBe('army-thieve-50');
    expect(first({ Thieving: 50 })).toBe('army-agility-68');
    expect(first({ Thieving: 50, Agility: 67 })).toBe('army-agility-68');
    expect(first({ Thieving: 50, Agility: 68 })).toBe('army-quest-upass');
    expect(first({ Thieving: 50, Agility: 68, Attack: 61 }, kit, ['underground pas'])).toBe('army-quest-regicide');
    // Without the limestone, which no shop and no market sells, the account does not take Regicide.
    expect(first({ Thieving: 50, Agility: 68, Attack: 61 }, { ...kit, limestone: 0 }, ['underground pas'])).not.toBe('army-quest-regicide');
    // Regicide waits for Underground Pass, and neither is given outside the plan's pilots.
    expect(first({ Thieving: 50, Agility: 68 }, { ...kit, 'prayer potion(4)': 0 })).not.toBe('army-quest-regicide');
    expect(first({ Thieving: 50, Agility: 68 }, kit, [], { pilots: new Set() }) ?? '').not.toContain('army-');
    // Short of the bow and the arrows: the band buys them.
    const market: Market = { 'magic shortbow': { id: 861, name: 'Magic shortbow', limit: KIT_PRICE_CAPS['magic shortbow']! }, 'rune arrow': { id: 892, name: 'Rune arrow', limit: KIT_PRICE_CAPS['rune arrow']! } };
    expect(first({ Thieving: 50, Agility: 68 }, { ...kit, coin: 2_000_000, 'magic shortbow': 0, 'rune arrow': 100 }, [], { market })).toBe(KIT_BUY + 'army-quest-upass');
});

import { ARMY_BANK, FERRY_FARE, KNIGHT_BANK, PLACES, TOLL, inWestArdougne, meetFor, onKaramja, placeOf, wayCost } from '../src/autopilot';

const TAVERLEY = { x: 2877, z: 3501, level: 0 }, DRAYNOR = { x: 3092, z: 3242, level: 0 }, ARDOUGNE = { x: 2654, z: 3283, level: 0 }, SEERS = { x: 2727, z: 3493, level: 0 };
const MUSA_POINT = { x: 2920, z: 3160, level: 0 }, TUTORIAL = { x: 3094, z: 3106, level: 0 }, TOLL_SIDE = { x: 3269, z: 3164, level: 0 };
const at = (a: Acct, pos: NonNullable<Acct['pos']>): Acct => ({ ...a, pos });
const only = (...wanted: string[]) => catalogue().filter(t => wanted.includes(t.id));
const big = [{ name: 'Big', coins: 900_000 }];

test('the way to a place costs the ferry fares the shared walker asks, or has no way', () => {
    const knight = { x: 2652, z: 3318 }, flax = { x: 2744, z: 3445 }, pen = { x: 3017, z: 3288 };
    // East side to Ardougne: two ferries, and the toll from the Al Kharid side of the gate.
    expect(wayCost(TAVERLEY, knight, true)).toBe(2 * FERRY_FARE);
    expect(wayCost(TOLL_SIDE, knight, true)).toBe(2 * FERRY_FARE + TOLL);
    // East side to the rest of Kandarin: the walk over White Wolf Mountain, for an account the walker lets over.
    expect(wayCost(DRAYNOR, flax, true)).toBe(0);
    expect(wayCost(DRAYNOR, flax, false)).toBeNull();
    // Kandarin to the east side: two ferries from Ardougne. Inside one region: no fare.
    expect(wayCost(SEERS, pen, false)).toBe(2 * FERRY_FARE);
    expect(wayCost(ARDOUGNE, knight, false)).toBe(0);
    expect(wayCost(SEERS, knight, false)).toBe(0);
    expect(wayCost(DRAYNOR, pen, false)).toBe(0);
    // Karamja: one ferry off the island. Tutorial Island counts as Lumbridge. A floor above counts as its ground.
    expect(wayCost(MUSA_POINT, pen, true)).toBe(FERRY_FARE);
    expect(wayCost(TUTORIAL, pen, false)).toBe(0);
    expect(wayCost(TUTORIAL, knight, false)).toBe(2 * FERRY_FARE);
    expect(wayCost({ ...ARDOUGNE, level: 1 }, pen, true)).toBe(2 * FERRY_FARE);
    // No place, no start, a cave or a place outside the regions: no rule.
    expect(wayCost(undefined, knight, false)).toBe(0);
    expect(wayCost(DRAYNOR, undefined, false)).toBe(0);
    expect(wayCost({ x: 2884, z: 9797, level: 0 }, knight, false)).toBe(0);
    expect(wayCost(DRAYNOR, { x: 3285, z: 3365 }, false)).toBe(0);
    // Karamja holds both docks and Brimhaven, and not Rimmington, Ardougne, Draynor or Yanille.
    expect([{ x: 2953, z: 3147 }, { x: 2772, z: 3225 }, { x: 2760, z: 3180 }].every(onKaramja)).toBe(true);
    expect([{ x: 2956, z: 3214 }, ARDOUGNE, DRAYNOR, { x: 2612, z: 3093 }].some(onKaramja)).toBe(false);
    // A coin order meets a Kandarin account at the Ardougne north bank, and no account on Karamja.
    expect([meetFor(SEERS), meetFor(ARDOUGNE), meetFor(DRAYNOR), meetFor(TUTORIAL), meetFor(MUSA_POINT), meetFor(undefined)]).toEqual(['ardougne', 'ardougne', undefined, undefined, null, undefined]);
});

test('each known place belongs to a template; a pen carries its own tile, and each knight spot has the Ardougne south bank', () => {
    const all = catalogue(), used = new Set(all.flatMap(t => t.resources ?? []));
    expect(Object.keys(PLACES).filter(r => !used.has(r))).toEqual([]);
    expect(all.filter(t => t.family === 'goldfarm').map(placeOf)).toEqual([KNIGHT_BANK, KNIGHT_BANK, KNIGHT_BANK, KNIGHT_BANK, KNIGHT_BANK]);
    expect(placeOf(all.find(t => t.id === 'feathers@3017,3288')!)).toEqual({ x: 3017, z: 3288 });
    expect(placeOf(all.find(t => t.id === 'army-cow-strength-45')!)).toEqual({ x: 2615, z: 3332 });
    expect(placeOf(all.find(t => t.id === 'thieving55')!)).toBeUndefined();
});

test('an account at Taverley with 1 coin gets the ferry fare for a knight spot from a donor, or a job on its own side', () => {
    const thief = at(acct('Thief', { Thieving: 89, Hitpoints: 54 }, { coin: 1 }), TAVERLEY), spot = only('goldfarm@2652,3318');
    // No donor: the spot behind the ferries is not offered, and the vacant slot names the fare. A full spot is no
    // reason to name it.
    expect(plan(inputs([thief], { templates: spot }))[0]).toEqual({ account: 'Thief', value: 0, resources: [],
        reason: 'vacant: lacks 59 coins for the way to goldfarm@2652,3318 (ferry fare 60), and no free account can give them' });
    expect(plan(inputs([thief], { templates: spot, taken: { 'knight:2652,3318': 1 } }))[0]!.reason).toBe('vacant: goldfarm@2652,3318 has no free place on knight:2652,3318');
    // A free donor sends the 59 coins it lacks. The order meets at Varrock West, which the account can walk to.
    const funded = plan(inputs([thief], { templates: spot, donors: big }))[0]!;
    expect(funded.template?.id).toBe('goldfarm@2652,3318');
    expect(funded.fund).toEqual({ from: 'Big', to: 'Thief', coins: 59, template: 'goldfarm@2652,3318' });
    expect(funded.reason).toBe('coins, funded 59 coins by Big, ferry fare 60');
    // From the Al Kharid side of the toll gate the need is 70.
    expect(plan(inputs([at(thief, TOLL_SIDE)], { templates: spot, donors: big }))[0]!.fund?.coins).toBe(69);
    // An account with a running job is never funded: it takes the job on its own side.
    const both = only('goldfarm@2652,3318', 'feathers@3017,3288');
    expect(ids(plan(inputs([thief], { templates: both, donors: big, unfundable: new Set(['thief']) })))).toEqual({ Thief: 'feathers@3017,3288' });
    expect(ids(plan(inputs([thief], { templates: both })))).toEqual({ Thief: 'feathers@3017,3288' });
    // The fare in its pack or its bank: the spot with no fund. No known place: the rule is off.
    expect(plan(inputs([{ ...thief, items: { coin: 60 } }], { templates: spot, donors: big }))[0]).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    const { pos: _none, ...unplaced } = thief;
    expect(plan(inputs([unplaced], { templates: spot }))[0]!.template?.id).toBe('goldfarm@2652,3318');
});

test('an account with 10 Hitpoints gets no job behind White Wolf Mountain', () => {
    const flax = { templates: only('aio-flax'), pilots: new Set(['aio-flax']), bill: [row('flax', 1000)], prices: { ...prices, flax: 5 } };
    const weak = at(acct('Weak', { Thieving: 99, Hitpoints: 10 }, { coin: 2_000_000, cake: 2 }), DRAYNOR);
    expect(plan(inputs([weak], { ...flax, mountain: () => false, donors: big }))[0]!.template).toBeUndefined();
    // An account the walker lets over the mountain gets the job, and so does the weak account once it stands in Kandarin.
    expect(plan(inputs([weak], { ...flax, mountain: () => true }))[0]!.template?.id).toBe('aio-flax');
    expect(plan(inputs([at(weak, SEERS)], { ...flax, mountain: () => false }))[0]!.template?.id).toBe('aio-flax');
    // The ferries to Ardougne stay open to it, and it holds the fare. That is so for each knight spot, the one west of
    // the ferry rule's Ardougne box too: the worker goes to the south bank first.
    for (const spot of ['goldfarm@2652,3318', 'goldfarm@2582,3297'])
        expect(plan(inputs([weak], { templates: only(spot), mountain: () => false }))[0]!.template?.id).toBe(spot);
    // With no fare that west spot is a funded job as the others are, for a strong account too: not a free walk.
    const poor = at(acct('Poor', { Thieving: 89, Hitpoints: 54 }, { coin: 1 }), DRAYNOR);
    expect(plan(inputs([poor], { templates: only('goldfarm@2582,3297'), mountain: () => true }))[0]!.template).toBeUndefined();
    expect(plan(inputs([poor], { templates: only('goldfarm@2582,3297'), mountain: () => true, donors: big }))[0]!.fund).toEqual({ from: 'Big', to: 'Poor', coins: 59, template: 'goldfarm@2582,3297' });
});

test('an account at Ardougne with no coins has no fare need for a knight spot', () => {
    const there = at(acct('There', { Thieving: 89, Hitpoints: 54 }), ARDOUGNE);
    const [x] = plan(inputs([there], { templates: only('goldfarm@2652,3318'), donors: big, mountain: () => false }));
    expect(x).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    expect(x!.fund).toBeUndefined();
    // With no fare the candidate carries the catalogue's template as it is.
    expect(x!.template!.needs?.items).toBeUndefined();
});

test('a Kandarin account with no fare meets its donor at the Ardougne north bank; an account on Karamja is not funded', () => {
    // A feather job on the east side: the fare east is the whole need.
    const pen = plan(inputs([at(acct('West'), SEERS)], { templates: only('feathers@3017,3288'), donors: big }))[0]!;
    expect(pen.fund).toEqual({ from: 'Big', to: 'West', coins: 60, template: 'feathers@3017,3288', meet: 'ardougne' });
    // A shop's own coin need and the fare are one need, and one order.
    const shop = plan(inputs([at(acct('West', {}, { coin: 500 }), ARDOUGNE)], { templates: only('shop-feathers'), donors: big }))[0]!;
    expect(shop.fund).toEqual({ from: 'Big', to: 'West', coins: 1_560, template: 'shop-feathers', meet: 'ardougne' });
    // On Karamja no order can reach the account: with fewer coins than one fare it gets no job off the island.
    const island = at(acct('Island', {}, { coin: 29 }), MUSA_POINT);
    expect(plan(inputs([island], { templates: only('feathers@3017,3288'), donors: big }))[0]!.template).toBeUndefined();
    expect(plan(inputs([{ ...island, items: { coin: 30 } }], { templates: only('feathers@3017,3288'), donors: big }))[0]).toMatchObject({ template: { id: 'feathers@3017,3288' } });
    // A new account on Tutorial Island counts as Lumbridge: an east pen with no fare.
    expect(plan(inputs([at(acct('New'), TUTORIAL)], { templates: only('feathers@3017,3288') }))[0]!.template?.id).toBe('feathers@3017,3288');
});

test('an item order asks only a party of this side that can reach the Ardougne north bank', () => {
    const army = new Set(['needy']), needy = mage('Needy', { 'mind rune': 15, 'air rune': 35 });
    const stock: Stock[] = [{ name: 'Near', side, items: { 'mind rune': 60 } }, { name: 'Next', side, items: { 'mind rune': 60 } }];
    const giver = (pos: NonNullable<Acct['pos']>, coin: number) => at(acct('Near', {}, { 'mind rune': 60, coin }), pos);
    const run = (accounts: Acct[]) => plan(inputs(accounts, { templates: bandOnly(), army, stock })).find(x => x.account === 'Needy')!;
    // Near stands at Draynor with 1 coin: the two ferries to Ardougne cost 60, so the next donor gives.
    expect(run([at(needy, ARDOUGNE), giver(DRAYNOR, 1)]).send?.from).toBe('Next');
    // With the fare, or in Ardougne, or with no known place, Near gives.
    expect(run([at(needy, ARDOUGNE), giver(DRAYNOR, 60)]).send?.from).toBe('Near');
    expect(run([at(needy, ARDOUGNE), giver(ARDOUGNE, 0)]).send?.from).toBe('Near');
    expect(run([needy]).send?.from).toBe('Near');
    // A taker east of the ferries with no fare gets no item order.
    expect(run([at(needy, DRAYNOR)]).send).toBeUndefined();
    expect(run([at({ ...needy, items: { ...needy.items, coin: 60 } }, DRAYNOR)]).send?.from).toBe('Near');
});

import { SHOP_STOCK } from '../src/autopilot';
test('a shop job needs an account that is short of an item the shop run buys', () => {
    const shops = ['shop-feathers', 'shop-runes', 'shop-arrowtips'];
    const wanted = [row('feathers', 800), row('fire rune', 2000), row('air rune', 2000), row('earth rune', 2000), row('rune arrowtips', 2000), row('adamant arrowtips', 2000)];
    const job = (items: Record<string, number>, id: string) =>
        ids(plan(inputs([acct('Rich', {}, { coin: 50_000, ...items })], { bill: wanted, templates: catalogue().filter(t => t.id === id) }))).Rich;
    const pick = (items: Record<string, number>) => shops.filter(id => job(items, id) === id);
    const full = { feather: SHOP_STOCK, 'fire rune': SHOP_STOCK, 'air rune': SHOP_STOCK, 'earth rune': SHOP_STOCK, 'rune arrowtip': SHOP_STOCK, 'adamant arrowtip': SHOP_STOCK };
    expect(pick({})).toEqual(shops);
    expect(pick(full)).toEqual([]);
    // One rune under the stock keeps the rune run. The feather run and the arrowtip run stay shut.
    expect(pick({ ...full, 'earth rune': SHOP_STOCK - 1 })).toEqual(['shop-runes']);
    expect(pick({ ...full, feather: 760 })).toEqual([]);
});

test('finite ring production sizes the actual order and ingredient minima to the remaining demand', () => {
    const t=catalogue().find(t=>t.id==='aio-sapphire-rings')!;
    const crafter=acct('Crafter',{Crafting:20},{'ring mould':1,'gold bar':13,sapphire:13});
    const run=(short:number,accounts=[crafter])=>plan(inputs(accounts,{templates:[t],pilots:new Set([t.id]),bill:[row('sapphire ring',short)],prices:{'sapphire ring':1000}}));
    const [one]=run(1),job=jobFor(one!,side);
    expect(job.repeat).toBe(false);
    expect(job.args).toEqual(['skiller','crafting','jewellery-trip','RECIPE=sapphire_ring','TARGET=1','BATCH=1','CAP=1500']);
    expect(one!.template!.needs!.items).toEqual({'ring mould':1,'gold bar':1,sapphire:1});
    expect(run(0)[0]!.template).toBeUndefined();
    expect(run(1,[crafter,{...crafter,name:'Second'}]).filter(x=>x.template)).toHaveLength(1);
    const [partial]=run(5,[{...crafter,items:{...crafter.items,sapphire:2,'gold bar':2}}]);
    expect(jobFor(partial!,side).args).toContain('TARGET=2');
});

test('finite inventory, bars, cannonballs and both stew steps retain their native input and output ratios', () => {
    const run=(id:string,a:Acct,item:string,short:number)=>{
        const t=catalogue().find(t=>t.id===id)!;
        return plan(inputs([a],{templates:[t],pilots:new Set([id]),bill:[row(item,short)],prices:{[norm(item)]:100}}))[0]!;
    };
    const potion=run('aio-unf-torstol',acct('Herb',{Herblore:78},{torstol:3,'vial of water':3}),'torstol potion (unf)',7);
    expect(jobFor(potion,side)).toMatchObject({repeat:false});
    expect(potion.template!.args).toContain('MAX_MAKE=3');
    const bars=run('aio-steel-bars',acct('Smith',{Smithing:30},{'iron ore':9,coal:18}),'cannonball',5);
    expect(jobFor(bars,side).repeat).toBe(false);
    expect(bars.template!.args).toContain('MAX_MAKE=2');
    expect(bars.template!.needs!.items).toEqual({'iron ore':2,coal:4});
    const cannon=run('aio-cannonballs',acct('Smith',{Smithing:35},{'steel bar':27,'ammo mould':1}),'cannonball',5);
    expect(jobFor(cannon,side).repeat).toBe(false);
    expect(cannon.template!.args!.slice(0,4)).toEqual(['skiller','smithing','cannonballs','2']);
    expect(cannon.template!.needs!.items).toEqual({'ammo mould':1,'steel bar':2});
    const shafts=run('aio-shafts',acct('Fletcher',{},{knife:1,log:25}),'arrow shaft',16);
    expect(shafts.template!.args).toContain('MAX_MAKE=2');
    expect(shafts.template!.needs!.items).toEqual({knife:1,logs:2});expect(jobFor(shafts,side).repeat).toBe(false);
    const stew=run('make-uncooked-stew',acct('Cook',{Cooking:25},{potato:3,'bowl of water':3,'cooked meat':3}),'uncooked stew',1);
    expect(jobFor(stew,side).repeat).toBe(false);
    expect(stew.template!.args).toHaveLength(2);
    for(const step of stew.template!.args!)expect(step).toContain('MAX_MAKE=1');
    expect(stew.template!.needs!.items).toEqual({potato:1,'bowl of water':1,'cooked meat':1});
});

test('a combined cash and item shortfall serializes existing funding and item orders before the Zaff consumer', () => {
    const t=catalogue().find(t=>t.id==='army-staff-zaff')!;
    const caster=acct('Caster',{Magic:30},{feather:50,coin:0});
    const extra:Partial<Inputs>={templates:[t],army:new Set(['caster']),pilots:new Set([t.id]),bill:[],
        donors:[{name:'CashMule',coins:100000}],stock:[{name:'RuneMule',side,items:{'nature rune':100}}]};
    const [cash]=plan(inputs([caster],extra));
    expect(cash!.fund).toMatchObject({from:'CashMule',to:'Caster',coins:15000,template:t.id});
    expect(cash!.send).toBeUndefined();
    const funded={...caster,items:{...caster.items,coin:15000}};
    const [runes]=plan(inputs([funded],extra));
    expect(runes!.send).toEqual({from:'RuneMule',to:'Caster',item:'nature rune',count:50,template:t.id});
    expect(runes!.fund).toBeUndefined();
    const [ready]=plan(inputs([{...funded,items:{...funded.items,'nature rune':50}}],extra));
    expect(ready!.template!.id).toBe(t.id);
    expect(ready!.send).toBeUndefined();expect(ready!.fund).toBeUndefined();
    const [held]=plan(inputs([caster],{...extra,unfundable:new Set(['caster']),current:new Map([['caster',t.id]]),running:new Set(['caster'])}));
    expect(held!.send).toBeUndefined();expect(held!.fund).toBeUndefined();
    expect(plan(inputs([caster],{...extra,stock:[]}))[0]!.fund).toBeUndefined();
    expect(plan(inputs([caster],{...extra,stock:[{name:'RuneMule',side,items:{'nature rune':50}}]}))[0]!.fund).toBeUndefined();
});

test('a demanded scimitar with cash and bar shortfalls starts only after both arrive', () => {
    const t=catalogue().find(t=>t.id==='aio-rune-scimitars')!;
    const smith=acct('Smith',{Smithing:90},{hammer:1,'runite bar':1});
    const extra:Partial<Inputs>={templates:[t],pilots:new Set([t.id]),bill:[row('rune scimitar',1)],prices:{'rune scimitar':15000},
        donors:[{name:'CashMule',coins:50010}],stock:[{name:'BarMule',side,items:{'runite bar':3}}]};
    const [cash]=plan(inputs([smith],extra));expect(cash!.fund?.coins).toBe(10);expect(cash!.send).toBeUndefined();
    const funded={...smith,items:{...smith.items,coin:10}};
    const [bar]=plan(inputs([funded],extra));expect(bar!.send).toMatchObject({from:'BarMule',item:'runite bar',count:1});expect(bar!.fund).toBeUndefined();
    expect(plan(inputs([funded],{...extra,stock:[{name:'BarMule',side,items:{'runite bar':1}}]}))[0]!.send).toMatchObject({from:'BarMule',item:'runite bar',count:1});
    const [ready]=plan(inputs([{...funded,items:{...funded.items,'runite bar':2}}],extra));
    expect(jobFor(ready!,side)).toMatchObject({template:t.id,repeat:false});
    expect(ready!.send).toBeUndefined();expect(ready!.fund).toBeUndefined();
});

test('market preparation retains the consumer fare and cash buffer without adding an overlapping explicit reserve',()=>{
    const t=catalogue().find(t=>t.id==='aio-rune-scimitars')!;
    const smith=acct('Smith',{Smithing:90},{hammer:1,'runite bar':1});
    const run=(coins:number,template=t)=>plan(inputs([{...smith,items:{...smith.items,coin:coins}}],{
        templates:[template],pilots:new Set([template.id]),bill:[row('rune scimitar',1)],prices:{'rune scimitar':15000},
        donors:[{name:'CashMule',coins:100000}],market:{'runite bar':{id:2363,name:'Runite bar',limit:10000}}}))[0]!;
    expect(run(0).fund).toMatchObject({coins:10,template:t.id});
    for(const template of [t,{...t,keepCoins:()=>10}]){
        const preparation=run(10,template);
        expect(preparation.fund).toMatchObject({coins:11000+KIT_COIN_MARGIN,template:KIT_BUY+t.id});
        const buy=run(11010+KIT_COIN_MARGIN,template);
        expect(buy.fund).toBeUndefined();expect(buy.template!.id).toBe(KIT_BUY+t.id);
        expect(buy.template!.args).toHaveLength(1);
        expect(buy.template!.args![0]).toContain('QUANTITY=1');
        expect(buy.template!.args![0]).toContain(`CASH_RESERVE=${KIT_CASH_RESERVE+10}`);
    }
    const zaff=catalogue().find(t=>t.id==='army-staff-zaff')!;
    const caster=acct('Caster',{Magic:30},{feather:50});
    const staff=(coins:number,template=zaff)=>plan(inputs([{...caster,items:{...caster.items,coin:coins}}],{
        templates:[template],army:new Set(['caster']),pilots:new Set([template.id]),bill:[],
        donors:[{name:'CashMule',coins:100000}],market:{'nature rune':{id:561,name:'Nature rune',limit:100}}}))[0]!;
    expect(staff(0).fund).toMatchObject({coins:15000,template:zaff.id});
    for(const template of [zaff,{...zaff,keepCoins:()=>15000}]){
        expect(staff(15000,template).fund).toMatchObject({coins:6000+KIT_COIN_MARGIN,template:KIT_BUY+zaff.id});
        const buy=staff(21000+KIT_COIN_MARGIN,template);expect(buy.fund).toBeUndefined();
        expect(buy.template!.args![0]).toContain('QUANTITY=50');
        expect(buy.template!.args![0]).toContain(`CASH_RESERVE=${KIT_CASH_RESERVE+15000}`);
    }
});

test('cash-first local item staging funds the known meeting trip and the consumer return fare',()=>{
    const t=catalogue().find(t=>t.id==='army-staff-zaff')!,varrock={x:3185,z:3436,level:0},bank={...ARMY_BANK,level:0};
    const caster={...acct('Caster',{Magic:30},{feather:50}),pos:varrock};
    const mule={...acct('RuneMule',{}, {'nature rune':100}),pos:bank};
    const extra:Partial<Inputs>={templates:[t],army:new Set(['caster']),pilots:new Set([t.id]),bill:[],market:{},
        donors:[{name:'CashMule',coins:100000}],stock:[{name:mule.name,side,items:mule.items}]};
    const run=(a:Acct)=>plan(inputs([a,mule],extra)).find(x=>x.account===a.name)!;
    expect(wayCost(varrock,bank,true)).toBe(60);expect(wayCost(bank,placeOf(t),true)).toBe(60);
    const cash=run(caster);expect(cash.fund).toMatchObject({coins:15120,template:t.id});expect(cash.send).toBeUndefined();
    const funded={...caster,items:{...caster.items,coin:15120}};
    expect(run(funded).send).toMatchObject({from:mule.name,to:caster.name,item:'nature rune',count:50});
    const arrived={...funded,pos:bank,items:{...funded.items,coin:15060,'nature rune':50}};
    const ready=run(arrived);expect(ready.template!.id).toBe(t.id);
    expect(ready.template!.needs!.items!.coins).toBe(15060);expect(ready.fund).toBeUndefined();expect(ready.send).toBeUndefined();
    const held=plan(inputs([caster,mule],{...extra,unfundable:new Set(['caster']),current:new Map([['caster',t.id]]),running:new Set(['caster'])})).find(x=>x.account===caster.name)!;
    expect(held.fund).toBeUndefined();expect(held.send).toBeUndefined();
});

for(const source of ['local-cash-remote-item','remote-cash-local-item','remote-cash-remote-item'] as const)
test(`remote shortage preparation serializes ${source} with meeting and return fares`,()=>{
    const t=catalogue().find(t=>t.id==='army-staff-zaff')!,varrock={x:3185,z:3436,level:0},bank={...ARMY_BANK,level:0};
    const caster={...acct('Caster',{Magic:30},{feather:50}),pos:varrock};
    const itemSide=source==='remote-cash-local-item'?side:'local';
    const stock:Stock[]=[{name:'RuneMule',side:itemSide,items:{'nature rune':100}},
        ...(source==='local-cash-remote-item'?[]:[{name:'CloudCash',side:'local',items:{coin:100000}}])];
    const extra:Partial<Inputs>={templates:[t],army:new Set(['caster']),pilots:new Set([t.id]),bill:[],stock,
        donors:source==='local-cash-remote-item'?[{name:'CashMule',coins:100000}]:[]};
    const run=(account:Acct)=>plan(inputs([account],extra))[0]!;
    const cash=run(caster);
    expect(cash.fund).toEqual({from:source==='local-cash-remote-item'?'CashMule':'CloudCash',to:'Caster',coins:15120,template:t.id});
    expect(cash.send).toBeUndefined();
    const funded={...caster,items:{...caster.items,coin:15120}};
    const item=run(funded);
    expect(item.send).toEqual({from:'RuneMule',to:'Caster',item:'nature rune',count:50,template:t.id});expect(item.fund).toBeUndefined();
    const received={...funded,pos:bank,items:{...funded.items,coin:15060,'nature rune':50}};
    const ready=run(received);
    expect(ready.template!.id).toBe(t.id);expect(ready.template!.needs!.items!.coins).toBe(15060);
    expect(ready.fund).toBeUndefined();expect(ready.send).toBeUndefined();
});

test('remote shortage preparation resolves mixed local and remote item lines before funding',()=>{
    const t=catalogue().find(t=>t.id==='army-staff-zaff')!,caster=acct('Caster',{Magic:30});
    const extra:Partial<Inputs>={templates:[t],army:new Set(['caster']),pilots:new Set([t.id]),bill:[],
        donors:[{name:'CashMule',coins:100000}],stock:[{name:'NearFeathers',side,items:{feather:100}},{name:'FarRunes',side:'local',items:{'nature rune':100}}]};
    const run=(items:Record<string,number>)=>plan(inputs([{...caster,items}],extra))[0]!;
    expect(run({}).fund).toMatchObject({from:'CashMule',coins:15000,template:t.id});
    const first=run({coin:15000});expect(first.send).toMatchObject({from:'NearFeathers',item:'feather',count:50});expect(first.fund).toBeUndefined();
    const second=run({coin:15000,feather:50});expect(second.send).toMatchObject({from:'FarRunes',item:'nature rune',count:50});expect(second.fund).toBeUndefined();
    expect(run({coin:15000,feather:50,'nature rune':50}).template!.id).toBe(t.id);
    expect(plan(inputs([caster],{...extra,stock:extra.stock!.slice(0,1)}))[0]!.fund).toBeUndefined();
});

test('remote coins fund a finite producer whose item inputs are already owned',()=>{
    const t=catalogue().find(t=>t.id==='aio-rune-scimitars')!,smith=acct('Smith',{Smithing:90},{hammer:1,'runite bar':2});
    const extra:Partial<Inputs>={templates:[t],pilots:new Set([t.id]),bill:[row('rune scimitar',1)],prices:{'rune scimitar':15000},
        stock:[{name:'CloudCash',side:'local',items:{coin:50010}}]};
    const preparation=plan(inputs([smith],extra))[0]!;
    expect(preparation.fund).toEqual({from:'CloudCash',to:'Smith',coins:10,template:t.id});expect(preparation.send).toBeUndefined();
    const ready=plan(inputs([{...smith,items:{...smith.items,coin:10}}],extra))[0]!;
    expect(ready.fund).toBeUndefined();expect(ready.send).toBeUndefined();expect(jobFor(ready,side)).toMatchObject({template:t.id,repeat:false,maxRestarts:0});
    expect(plan(inputs([smith],{...extra,stock:[{name:'CloudCash',side:'local',items:{coin:50009}}]}))[0]!.fund).toBeUndefined();
    expect(plan(inputs([smith],{...extra,noSend:new Set(['cloudcash>smith'])}))[0]!.fund).toBeUndefined();
});

test('remote shortage preparation preserves productive local work and held recipients',()=>{
    const t=catalogue().find(t=>t.id==='army-staff-zaff')!,bowstrings=catalogue().find(t=>t.id==='aio-bowstrings')!;
    const caster=acct('Caster',{Magic:30,Crafting:10},{feather:50,flax:1});
    const extra:Partial<Inputs>={templates:[t,bowstrings],army:new Set(['caster']),pilots:new Set([t.id,bowstrings.id]),bill:[row('bow string',1)],prices:{'bow string':100},
        donors:[{name:'CashMule',coins:100000}],stock:[{name:'FarRunes',side:'local',items:{'nature rune':100}},{name:'CloudCash',side:'local',items:{coin:100000}}]};
    const local=plan(inputs([caster],extra))[0]!;
    expect(local.template!.id).toBe(bowstrings.id);expect(local.fund).toBeUndefined();expect(local.send).toBeUndefined();
    const idle={...caster,items:{feather:50}};
    for(const held of [true,false]){
        const outcome=plan(inputs([idle],{...extra,templates:[t],bill:[],...(held?{unfundable:new Set(['caster']),current:new Map([['caster',t.id]]),running:new Set(['caster'])}:{noSend:new Set(['farrunes>caster'])})}))[0]!;
        expect(outcome.fund).toBeUndefined();expect(outcome.send).toBeUndefined();
    }
    const island={...idle,pos:{x:2915,z:3174,level:0}};
    expect(plan(inputs([island],{...extra,templates:[t],bill:[]}))[0]!.fund).toBeUndefined();
});

test('remote shortage preparation spends a remote cash donor once and retains its reserve',()=>{
    const t={...catalogue().find(t=>t.id==='army-staff-zaff')!,resources:[]};
    const accounts=['CasterA','CasterB'].map(name=>acct(name,{Magic:30},{feather:50}));
    const extra:Partial<Inputs>={templates:[t],army:new Set(['castera','casterb']),pilots:new Set([t.id]),bill:[],
        stock:[{name:'CloudCash',side:'local',items:{coin:100000}},{name:'FarRunes',side:'local',items:{'nature rune':150}}]};
    const out=plan(inputs(accounts,extra));expect(out.filter(x=>x.fund)).toHaveLength(1);
    expect(out.find(x=>x.fund)!.fund).toMatchObject({from:'CloudCash',coins:15000});
    expect(plan(inputs(accounts,{...extra,stock:[{name:'CloudCash',side:'local',items:{coin:64999}},extra.stock![1]!]})).some(x=>!!x.fund)).toBe(false);
});

test('plan stays fast with an expanded army roster, pilot allowlist and full supply bill',()=>{
    const templates=catalogue(),pilots=new Set(templates.filter(t=>t.pilot&&t.id!=='aio-ore').map(t=>t.id));
    const spots=[{x:2582,z:3297,level:0},{x:3185,z:3436,level:0},{x:2653,z:3300,level:0},{x:3269,z:3166,level:0}];
    const accounts=Array.from({length:28},(_,i)=>({...acct(`Helper${i}`,{Thieving:70,Cooking:50,Crafting:50,Smithing:70,Woodcutting:60,Magic:30},{coin:100_000,flax:56,'yew logs':20}),pos:spots[i%4]}));
    const army=new Set(accounts.map(a=>a.name.toLowerCase()));
    const names=['sapphire ring','emerald ring','ruby ring','diamond ring','mithril bar','adamantite bar','yew shortbow','uncooked stew','unicorn horn dust','dragon scale dust'];
    const bill=Array.from({length:30},(_,i)=>row(names[i%10]!,50));
    const started=performance.now();
    const out=plan(inputs(accounts,{templates,pilots,army,bill,capacity:CAPACITY,prices:{...prices,'bow string':200,'yew shortbow':800,flax:50,'mithril bar':500},donors:accounts.map(a=>({name:a.name,coins:100_000}))}));
    expect(performance.now()-started).toBeLessThan(5000);
    expect(out.filter(x=>x.template).length).toBeGreaterThan(0);
});

test('accounts trapped inside West Ardougne cannot reach outside targets, donors or kit-buy GE trips',()=>{
    const west={x:2547,z:3325,level:0};
    expect(inWestArdougne(west)).toBe(true);
    expect(inWestArdougne(ARDOUGNE)).toBe(false);
    expect(inWestArdougne({x:2525,z:3242,level:0})).toBe(false);
    expect(wayCost(west,KNIGHT_BANK,true)).toBeNull();
    expect(wayCost(west,{x:3185,z:3436},true)).toBeNull();
    expect(meetFor(west)).toBeNull();
    const dragon=catalogue().find(t=>t.id==='army-hunt-black-dragons')!;
    const trapped={...acct('Mightyrod',{Attack:99,Strength:99,Defence:99,Ranged:99,Magic:99,Prayer:99,Hitpoints:99},{coin:500_000,'law rune':4}),pos:west};
    const out=plan(inputs([trapped],{templates:[dragon],army:new Set(['mightyrod']),pilots:new Set([dragon.id]),donors:[{name:'Rich',coins:500_000}]}))[0]!;
    expect(out.template).toBeUndefined();expect(out.fund).toBeUndefined();expect(out.send).toBeUndefined();
});

test('assess keeps a single preparation/acquire block as drain but retires RETIRE_FAILS consecutive blocks',()=>{
    const prep='RESULT fail no Ranged progress: {"ok":false,"stop":"preparation","failure":"progression requires acquire"}';
    expect(assess([prep])).toMatchObject({retire:false,drains:1});
    expect(assess([prep,prep])).toMatchObject({retire:true,drains:2});
    expect(assess([prep,'RESULT ok xpGain=50',prep])).toMatchObject({retire:false,drains:2});
});

import { ARMOUR_BAND, ARMOUR_MARKET, RANGED_ARMOUR_BAND, WEAPON_BAND } from '../src/autopilot';

test('progressive weapon and armour ladder stages Zeke, Adamant, Rune, Dragon, and Green Dhide tiers', () => {
    const all = catalogue();
    const zekeIron = all.find(t => t.id === 'army-weapon-zeke-iron')!;
    const zekeMith = all.find(t => t.id === 'army-weapon-zeke-mithril')!;
    const scavvo = all.find(t => t.id === 'army-armour-scavvo')!;
    expect(zekeIron.resources).toEqual(['shop:zeke']);
    expect(zekeMith.needs?.skills).toEqual({ Attack: 20 });
    expect(scavvo.resources).toEqual(['shop:scavvo']);
    expect(scavvo.needs?.questPoints).toBe(32);

    const army = new Set(['fighter']);
    const cowOnly = all.filter(t => t.id === 'army-cow-strength-45');
    const mk = (skills: Record<string, number>, items: Record<string, number>, quests: string[] = []): Acct =>
        ({ ...acct('Fighter', { Hitpoints: 70, ...skills }, { shark: 40, coin: 1_000_000, ...items }), quests: new Set(quests) });
    const runeMkt = {
        'rune scimitar': { id: 1333, name: 'Rune scimitar', limit: KIT_PRICE_CAPS['rune scimitar']! },
        'rune longsword': { id: 1303, name: 'Rune longsword', limit: KIT_PRICE_CAPS['rune longsword']! },
        'dragon dagger': { id: 1215, name: 'Dragon dagger', limit: KIT_PRICE_CAPS['dragon dagger']! },
        'rune chainbody': { id: 1113, name: 'Rune chainbody', limit: KIT_PRICE_CAPS['rune chainbody']! },
        'rune platebody': { id: 1127, name: 'Rune platebody', limit: KIT_PRICE_CAPS['rune platebody']! },
        'rune plateleg': { id: 1079, name: 'Rune platelegs', limit: KIT_PRICE_CAPS['rune plateleg']! },
        'rune full helm': { id: 1163, name: 'Rune full helm', limit: KIT_PRICE_CAPS['rune full helm']! },
        'rune kiteshield': { id: 1201, name: 'Rune kiteshield', limit: KIT_PRICE_CAPS['rune kiteshield']! },
        'dragonhide body': { id: 1135, name: 'Dragonhide body', limit: KIT_PRICE_CAPS['dragonhide body']! },
        'dragonhide chap': { id: 1099, name: 'Dragonhide chaps', limit: KIT_PRICE_CAPS['dragonhide chap']! },
        'dragon vambrace': { id: 1065, name: 'Dragon vambraces', limit: KIT_PRICE_CAPS['dragon vambrace']! },
    };

    const at40 = plan(inputs([mk({ Attack: 40, Strength: 30 }, {})], { templates: cowOnly, army, market: runeMkt }))[0]!;
    expect(at40.template!.id).toBe(KIT_BUY + 'army-weapon-rune');
    expect(at40.resources).toEqual([WEAPON_MARKET]);
    expect(WEAPON_BAND).toBe(3.5);

    const longFallback = plan(inputs([mk({ Attack: 40, Strength: 30 }, {})], {
        templates: cowOnly, army, market: { 'rune longsword': runeMkt['rune longsword'] },
    }))[0]!;
    expect(longFallback.template!.id).toBe(KIT_BUY + 'army-weapon-rune');
    expect(longFallback.reason).toContain('Rune longsword');

    const dragonPreQuest = plan(inputs([mk({ Attack: 60, Strength: 60 }, { 'rune scimitar': 1 })], {
        templates: cowOnly, army, market: runeMkt,
    }))[0]!;
    expect(dragonPreQuest.template?.id).not.toBe(KIT_BUY + 'army-weapon-dragon');

    const dragonReady = plan(inputs([mk({ Attack: 60, Strength: 60 }, { 'rune scimitar': 1 }, ['lost city'])], {
        templates: cowOnly, army, market: runeMkt,
    }))[0]!;
    expect(dragonReady.template!.id).toBe(KIT_BUY + 'army-weapon-dragon');

    const runeArmourPreDs = plan(inputs([mk({ Attack: 60, Defence: 40, Strength: 60 }, { 'dragon dagger': 1 }, ['lost city'])], {
        templates: cowOnly, army, market: runeMkt,
    }))[0]!;
    expect(runeArmourPreDs.template!.id).toBe(KIT_BUY + 'army-armour-rune');
    expect(runeArmourPreDs.resources).toEqual([ARMOUR_MARKET]);
    expect(runeArmourPreDs.reason).toContain(`army band ${ARMOUR_BAND}`);
    expect(runeArmourPreDs.reason).toContain('Rune chainbody');
    expect(runeArmourPreDs.reason).not.toContain('Rune platebody');

    const dhideAt40 = plan(inputs([mk({ Attack: 60, Defence: 1, Ranged: 40, Strength: 60 }, { 'dragon dagger': 1 }, ['lost city'])], {
        templates: cowOnly, army, market: runeMkt,
    }))[0]!;
    expect(dhideAt40.template!.id).toBe(KIT_BUY + 'army-armour-dhide');
    expect(dhideAt40.reason).toContain(`army band ${RANGED_ARMOUR_BAND}`);
    expect(dhideAt40.reason).toContain('Dragonhide chaps');
    expect(dhideAt40.reason).not.toContain('Dragonhide body');
});

test('Nurmof pickaxe shop tiers upgrade miners only up to their Mining level threshold', () => {
    const all = catalogue().filter(t => t.id.startsWith('tool-pickaxe-'));
    expect(all.map(t => [t.id, t.resources?.[0]])).toEqual([
        ['tool-pickaxe-rune', 'shop:nurmof'],
        ['tool-pickaxe-adamant', 'shop:nurmof'],
        ['tool-pickaxe-mithril', 'shop:nurmof'],
        ['tool-pickaxe-steel', 'shop:nurmof'],
        ['tool-pickaxe-iron', 'shop:nurmof'],
    ]);
    const miner = acct('Miner', { Mining: 41 }, { coin: 50_000, 'bronze pickaxe': 1 });
    const next = plan(inputs([miner], { templates: all, army: new Set(['miner']), bill: [row('iron ore', 10)], prices: { 'iron ore': 100 } }))[0]!;
    expect(next.template!.id).toBe('tool-pickaxe-rune');

    const alreadyRune = acct('Miner', { Mining: 41 }, { coin: 50_000, 'rune pickaxe': 1 });
    const none = plan(inputs([alreadyRune], { templates: all, army: new Set(['miner']), bill: [row('iron ore', 10)], prices: { 'iron ore': 100 } }))[0]!;
    expect(none.template).toBeUndefined();
});

test('autopilot runs the Ranged band on the trooper trainer, excludes rune platebody holders from Scavvo, normalizes wc tool demand, and narrows ranged jobResources', () => {
    const ranged = catalogue().find(t => t.id === 'army-trooper-ranged-99')!;
    expect(ranged.script).toBe('scripts/gather-combat.ts');
    expect(ranged.resources).toEqual(['trooper:battlefield']);

    const scavvo = catalogue().find(t => t.id === 'army-armour-scavvo')!;
    const mkScavvo = (items: Record<string, number>) => ({ ...acct('Tank', { Defence: 40 }, { coin: 120_000, ...items }), questPoints: 32 });
    const needScavvo = plan(inputs([mkScavvo({})], { templates: [scavvo], army: new Set(['tank']) }))[0]!;
    expect(needScavvo.template?.id).toBe('army-armour-scavvo');
    const skipScavvo = plan(inputs([mkScavvo({ 'rune platebody': 1, 'rune plateleg': 1 })], { templates: [scavvo], army: new Set(['tank']) }))[0]!;
    expect(skipScavvo.template).toBeUndefined();

    const zekeIron = catalogue().find(t => t.id === 'army-weapon-zeke-iron')!;
    const freshBlade = acct('NewBlade', { Attack: 1 }, { coin: 500 });
    expect(plan(inputs([freshBlade], { templates: [zekeIron], army: new Set(['newblade']) }))[0]?.template?.id).toBe('army-weapon-zeke-iron');

    const goldfarm = catalogue().find(t => t.id === 'goldfarm@2652,3318')!;
    const lumber = acct('Lumber', { Woodcutting: 60, Attack: 1 }, { 'bronze axe': 1 });
    const thief = acct('Helper', { Thieving: 60 }, {});
    const withDemand = plan(inputs([lumber, thief], {
        templates: [goldfarm], army: new Set(['lumber']), bill: [row('yew log', 10)], prices: {},
    }));
    expect(withDemand.find(x => x.account === 'Helper')?.template?.id).toBe('goldfarm@2652,3318');
    const noDemand = plan(inputs([lumber, thief], {
        templates: [goldfarm], army: new Set(['lumber']), bill: [], prices: {},
    }));
    expect(noDemand.find(x => x.account === 'Helper')?.template).toBeUndefined();

    expect(jobResources({ script: 'scripts/ranged-train.ts', env: { PROGRESSION_METHOD: 'ranged/chickens-oak' } })).toEqual(['pen:3229,3298']);
    for (const m of ['ranged/troopers-oak', 'ranged/troopers-willow', 'ranged/troopers-maple']) {
        expect(jobResources({ script: 'scripts/ranged-train.ts', env: { PROGRESSION_METHOD: m } })).toEqual(['trooper:battlefield']);
    }
});

test('assess does not retire a job for tick waste when its run ended on a stop file or another drain', () => {
    // The log of MeatNTwoVeg's pickaxe buy: a 300-tick ferry walk, then the owner's stop file cut the run.
    const ledger = 'LEDGER ticks=300 xp=0 inventory=2 move=160 anim=0 dialog=11 stun=0 idle=127 idlePct=42.3 xpGain=0 bot=MeatNTwoVeg';
    const log = ['SWARM_JOB 81a7', 'START shop-buyer MeatNTwoVeg profile=nurmof coins=3050', ledger, 'PRAYER_GUARD {}', '[lite] MeatNTwoVeg: session ended (logged-out) ',
        'LOGOUT logged-out', 'RESULT fail stop file', 'SUPERVISE run 1 exit 1: RESULT fail stop file', 'SUPERVISE end stopped after 1 runs'];
    expect(assess(log)).toMatchObject({ retire: false, drains: 1 });
    // Any other drain ending leaves the waste rule as it was.
    for (const drain of ['RESULT fail session ended: disconnected', 'RESULT fail travel failed: precondition no route to 2654,3283,0', 'RESULT fail market bank travel failed: x'])
        expect(assess([ledger, drain]).reason).toMatch(/^tick waste 96%/);
    // A long wasteful run (5,000 ticks, 96% idle and walking) that ends on a stop file is still retired.
    const long = 'LEDGER ticks=5000 xp=0 move=2400 anim=0 dialog=0 stun=0 idle=2400 bot=Long';
    expect(assess([long, 'RESULT fail stop file']).reason).toMatch(/^tick waste 96%/);
    expect(assess(['LEDGER ticks=999 xp=0 move=480 anim=0 dialog=0 stun=0 idle=480', 'RESULT fail stop file']).retire).toBe(false);
    expect(assess(['LEDGER ticks=1000 xp=0 move=480 anim=0 dialog=0 stun=0 idle=480', 'RESULT fail stop file']).retire).toBe(true);
    // A run that ended on its own failure at the same waste still retires, and so does a stop file after a real end.
    expect(assess([ledger, 'RESULT fail no shop reached']).reason).toMatch(/^tick waste 96%/);
    expect(assess([ledger, 'RESULT fail no shop reached', 'RESULT fail stop file']).reason).toMatch(/^tick waste 96%/);
});

test('a vacant slot names the nearest template and the first gate that stopped it', () => {
    const supply = (id: string, extra: Partial<Template> = {}, item = 'feather'): Template =>
        ({ id, family: id, script: `scripts/${id}.ts`, role: 'supply', goal: id, yields: () => [{ item, perTick: 5 }], ...extra });
    const reason = (a: Acct, templates: Template[], extra: Partial<Inputs> = {}) => plan(inputs([a], { templates, ...extra }))[0]!.reason;
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    // Not on the army roster: the band's levels are met, so only the roster stops it.
    expect(reason(acct('Rookie'), band)).toBe('vacant: not on the army roster (1 bands, nearest army-cow-strength-45)');
    // On the roster with no sword in any source: the missing kit line.
    expect(reason(acct('Rookie'), band, { army: new Set(['rookie']) })).toMatch(/^vacant: army-cow-strength-45 needs 1 bronze sword, 2 trout and no source gives them$/);
    // A level the template asks and the account lacks.
    expect(reason(acct('Rookie'), [supply('deep-mine', { needs: { skills: { Mining: 41 } } })])).toBe('vacant: deep-mine needs Mining 41');
    // A holding the template asks and no purchase fixes: the coin line is named as coins.
    expect(reason(acct('Rookie'), [supply('rich-job', { needs: { items: { coin: 9000 } } })])).toBe('vacant: rich-job needs 9000 coins and no free account can give them');
    // A job with no finite consumer has no value.
    expect(reason(acct('Rookie'), [supply('idle-job', {}, 'zzz item')])).toBe('vacant: idle-job has no finite demand');
    // A pilot that the plan's aio list does not name, then named.
    const pilot = supply('pilot-job', { pilot: true });
    expect(reason(acct('Rookie'), [pilot])).toBe('vacant: pilot-job is a pilot that the aio list does not name');
    expect(plan(inputs([acct('Rookie')], { templates: [pilot], pilots: new Set(['pilot-job']) }))[0]!.template?.id).toBe('pilot-job');
    // A retired pair.
    expect(reason(acct('Rookie'), [supply('worn-job')], { retired: new Set(['rookie:worn-job']) })).toBe('vacant: worn-job is retired for this account');
    // A place no way leads to: West Ardougne has no exit to the cow field.
    const walled = { ...acct('Rookie'), pos: { x: 2520, z: 3300, level: 0 } };
    expect(reason(walled, [supply('far-job', { resources: ['cow:ardougne-north'] })])).toBe('vacant: far-job has no way from where the account stands');
    // A full place beats the other gates.
    expect(reason(acct('Rookie'), [supply('crowded-job', { resources: ['pen:1,1'] })], { taken: { 'pen:1,1': 1 } })).toBe('vacant: crowded-job has no free place on pen:1,1');
    // No demand at all, with no bill.
    expect(reason(acct('Rookie'), [supply('any-job')], { bill: [] })).toBe('vacant: no finite route or army supply demand');
});

import { SQUAD_ESCAPE, SQUAD_GEAR_ALIASES, SQUAD_HOURLY, SQUAD_POTION_ALIASES, SQUAD_SPARES, SQUAD_WAVE_BC, squadBlock, squadBurnBudget, squadHeld, squadKeeps, squadRows, squadTarget, type SquadInput } from '../src/squad';
import { squadSupplies, SQUAD_RESTOCK, SQUAD_UNIT_COST } from '../src/autopilot';

test('the squad block reads members and hours; only an active block with members is active', () => {
    expect(squadBlock({ squad: { active: true, members: ['A', 'B', 'bad name'], hours: 6 } })).toEqual({ active: true, hours: 6, members: ['A', 'B'], maxCoins: 2_000_000 });
    expect(squadBlock({ squad: { active: true, members: ['A'], maxCoins: 5000 } }).maxCoins).toBe(5000);
    expect(squadBlock({ squad: { active: true, members: ['A'], maxCoins: -1 } }).maxCoins).toBe(2_000_000);
    expect(squadBlock({ squad: { active: true, members: ['A'], hours: 99 } }).hours).toBe(4);
    expect(squadBlock({ squad: { active: false, members: ['A'] } }).active).toBe(false);
    expect(squadBlock({ squad: { active: true, members: [] } }).active).toBe(false);
    expect(squadBlock({ squad: { active: 'yes', members: ['A'] } }).active).toBe(false);
    expect(squadBlock({}).active).toBe(false);
    expect(squadBlock(null).active).toBe(false);
});

test('the squad rows are a stock target of the member minus what it holds, food by heal, and none while inactive', () => {
    // Four hours, per member: the middle of each hourly range over four members.
    expect(squadTarget('arrow', 4)).toBe(Math.ceil(((SQUAD_HOURLY.arrow![0] + SQUAD_HOURLY.arrow![1]) / 2) / 4 * 4));
    expect(squadTarget('food', 4)).toBe(355);
    const squad = (items: Record<string, number>, active = true): SquadInput => ({ active, hours: 4, members: [{ name: 'Hunter', items }] });
    const rows = squadRows(squad({}));
    expect(rows.map(r => r.consumer)).toEqual([...Object.keys(SQUAD_HOURLY), ...Object.keys(SQUAD_SPARES)].map(i => `gang squad Hunter: ${i}`));
    expect(rows.every(r => r.account === 'hunter')).toBe(true);
    expect(rows.find(r => /: arrow$/.test(r.consumer))!.short).toBe(squadTarget('arrow', 4));
    // Held stock counts first; a line at its target gives no row. Lobsters held count 12/20 of a shark; new food is sharks.
    const full = {
        ...Object.fromEntries(Object.keys(SQUAD_HOURLY).filter(i => i !== 'food').map(i => [i === 'arrow' ? 'rune arrow' : i, Math.max(squadTarget(i, 4), SQUAD_ESCAPE[i] ?? 0)])),
        ...SQUAD_SPARES,
    };
    expect(squadRows(squad({ ...SQUAD_ESCAPE, ...full, shark: 355 }))).toEqual([]);
    expect(squadRows(squad({ ...SQUAD_ESCAPE, ...full, lobster: 592 }))).toEqual([]);
    expect(squadRows(squad({ ...SQUAD_ESCAPE, ...full, lobster: 296 }))[0]).toMatchObject({ names: ['shark'], short: 178 });
    // The arrow line counts rune (poisoned and unpoisoned) and adamant arrows, and asks for poisoned rune arrows first; iron arrows held do not count.
    expect(squadRows(squad({ ...SQUAD_ESCAPE, ...full, shark: 355, 'rune arrow': 0, 'iron arrow': 5000 }))[0]).toMatchObject({ names: ['rune arrow(p)', 'rune arrow', 'adamant arrow'], short: squadTarget('arrow', 4) });
    expect(squadHeld('food', { shark: 10, lobster: 20 })).toBe(22);
    expect(squadRows(squad({}, false))).toEqual([]);
    expect(squadRows(undefined)).toEqual([]);
    expect(squadKeeps(4)['rune arrow']).toBe(squadTarget('arrow', 4));
    expect(squadKeeps(4).lobster).toBe(Math.ceil(355 * 20 / 12));
});

test('every squad line has a template that fills it today, or is named as a gap; the antipoison filter matches its item', () => {
    const all = catalogue(), a = acct('X', { Magic: 99, Hitpoints: 99, Herblore: 99, Cooking: 99, Fletching: 99, Smithing: 99, Crafting: 99, Mining: 99, Woodcutting: 99, Thieving: 99, Fishing: 99, Ranged: 99 }, { 'pestle and mortar': 1, hammer: 1, knife: 1, chisel: 1 });
    const fills = (item: string) => all.filter(t => t.yields(a).some(f => norm(f.item) === norm(item) && f.perTick > 0)).map(t => t.id);
    for (const item of [
        'rune arrow', 'water rune', 'nature rune', 'law rune', 'antipoison(3)', 'earth rune', 'air rune', 'fire rune', 'blood rune', 'cosmic rune',
        'cooked karambwan', 'prayer potion(3)', 'super attack(3)', 'super strength(3)', 'super defence(3)', 'ranging potion(3)',
        'ring of recoil', 'climbing boot', 'dragon dagger(p)', 'magic shortbow', 'rune full helm', 'rune platebody', 'rune plateleg', 'rune kiteshield',
        'black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces', 'lobster',
    ]) expect([item, fills(item).length > 0]).toEqual([item, true]);
    expect(fills('shark')).toContain('squad-sharks');
    expect(fills('rune arrow')).toEqual(expect.arrayContaining(['squad-rune-arrows', 'squad-fletch-rune-arrows-bank', 'squad-arrows-dargaud']));
    for (const t of squadSupplies()) {
        expect(t.squadOnly).toBe(true);
        const spot = placeOf(t);
        expect(spot).toBeDefined();
        const inWildySurface = spot!.x >= 2944 && spot!.x <= 3391 && spot!.z >= 3520 && spot!.z < 6400;
        const inWildyDungeon = spot!.x >= 2944 && spot!.x <= 3391 && spot!.z >= 9920;
        expect(inWildySurface || inWildyDungeon).toBe(false);
        expect(t.resources?.some(r => /magearena/i.test(r))).toBe(false);
    }
});

test('an active squad gives free accounts supply jobs with no hand edit and stops when inactive', () => {
    const squad = (active: boolean, items: Record<string, number> = {}): SquadInput => ({ active, hours: 4, members: [{ name: 'Hunter', items }] });
    const supply = catalogue().filter(t => t.id === 'squad-arrows-lowe' || t.id === 'squad-water-betty' || t.id === 'shop-runes');
    const free = acct('Supplier', {}, { coin: 100_000 });
    const run = (s?: SquadInput, extra: Partial<Inputs> = {}) => plan(inputs([free], { templates: supply, bill: [], capacity: CAPACITY, squad: s, prices: { 'rune arrow': 3, 'water rune': 4, 'earth rune': 4, 'air rune': 4 }, ...extra }))[0]!;
    expect(run(squad(true)).template?.id).toMatch(/^(squad-arrows-lowe|squad-water-betty|shop-runes)$/);
    // Inactive or absent: no demand, no job.
    expect(run(squad(false)).template).toBeUndefined();
    expect(run(undefined).template).toBeUndefined();
    // The member holdings count first: a member that holds every target, escape and spare item needs nothing.
    const stocked = {
        ...SQUAD_ESCAPE,
        ...Object.fromEntries(Object.keys(SQUAD_HOURLY).filter(i => i !== 'food').map(i => [i, Math.max(squadTarget(i, 4), SQUAD_ESCAPE[i] ?? 0)])),
        ...SQUAD_SPARES, shark: 400,
    };
    expect(run(squad(true, stocked)).template).toBeUndefined();
});

test('a free donor sends a squad member its spare stock once, only while the squad is active, and a donor member keeps its own target', () => {
    const member = acct('Hunter', {}, { coin: 1000 }), donor = acct('Spare', {}, { 'rune arrow': 5000, 'earth rune': 100 });
    const stock = [{ name: 'Spare', side, items: { 'rune arrow': 5000, 'earth rune': 100 } }];
    const squad = (active: boolean): SquadInput => ({ active, hours: 4, members: [{ name: 'Hunter', items: {} }] });
    const run = (active: boolean, extra: Partial<Inputs> = {}) => plan(inputs([member, donor], { templates: [], bill: [], stock, squad: squad(active), ...extra }));
    const out = run(true), sent = out.find(x => x.account === 'Hunter')!;
    expect(sent.send).toMatchObject({ from: 'Spare', to: 'Hunter', item: 'rune arrow', count: squadTarget('arrow', 4), template: SQUAD_RESTOCK.id });
    expect(out.find(x => x.account === 'Spare')!.reason).toBe('vacant: gives a kit item this pass');
    expect(run(false).find(x => x.account === 'Hunter')!.send).toBeUndefined();
    // A donor that is itself a squad member keeps its own target: its 100 earth runes are under it, so none moves.
    const both = plan(inputs([acct('Hunter', {}, { coin: 1000 }), acct('Mate', {}, { 'earth rune': 100 })], { templates: [], bill: [],
        stock: [{ name: 'Mate', side, items: { 'earth rune': 100 } }], squad: { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }, { name: 'Mate', items: { 'earth rune': 100 } }] } }));
    expect(both.find(x => x.account === 'Hunter')!.send).toBeUndefined();
    // A member that is busy (an enabled job) is not interrupted for a trade.
    expect(run(true, { unfundable: new Set(['hunter']) }).find(x => x.account === 'Hunter')!.send).toBeUndefined();
});

test('an active squad member takes no band, kit buy or supply job, only the restock', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const hunter = acct('Hunter', { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, { 'wooden shield': 1, trout: 20, coin: 50_000 });
    const market = { 'bronze sword': { id: 1277, name: 'Bronze sword', limit: 100 } };
    const run = (active: boolean) => plan(inputs([hunter, acct('Spare', {}, { 'rune arrow': 5000 })], { templates: band, army: new Set(['hunter']), market, stock: [{ name: 'Spare', side, items: { 'rune arrow': 5000 } }],
        capacity: { 'cow:ardougne-north': 6 }, squad: { active, hours: 4, members: [{ name: 'Hunter', items: {} }] } })).find(x => x.account === 'Hunter')!;
    // Inactive: an ordinary army account with a kit buy. Active: no band and no kit buy; the restock is its only order.
    expect(run(false).template?.id).toBe('kit-buy:army-cow-strength-45');
    const held = run(true);
    expect(held.template?.id).toBe('squad-restock');
    expect(held.send).toMatchObject({ from: 'Spare', to: 'Hunter', item: 'rune arrow' });
});

test('with few bot slots, the squad restock and then a squad supply job rank above a goal band', () => {
    const templates = [...catalogue().filter(t => t.id === 'army-cow-strength-45'), ...squadSupplies().filter(t => t.id === 'squad-arrows-dargaud')];
    const trainer = () => acct('Trainer', { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, { 'wooden shield': 1, trout: 20, coin: 50_000 });
    const market = { 'bronze sword': { id: 1277, name: 'Bronze sword', limit: 100 } };
    const squad = { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] };
    const run = (accounts: Acct[], slots: number, stock: Stock[] = []) => plan(inputs([trainer(), acct('Hunter', {}, {}), ...accounts], { templates, army: new Set(['trainer']), market,
        capacity: { ...CAPACITY, 'cow:ardougne-north': 6 }, squad, slots, stock, prices: { 'rune arrow': 500 } }));
    // One slot: the arrow buyer takes it, the band waits.
    const bought = run([acct('Buyer', { Ranged: 40 }, { coin: 400_000 })], 1);
    expect(bought.find(x => x.account === 'Buyer')!.template?.id).toBe('squad-arrows-dargaud');
    expect(bought.find(x => x.account === 'Trainer')!.reason).toMatch(/^vacant: waits for a bot slot/);
    // Two slots and a donor that holds arrows: the restock (two bots, the donor and the member) takes both.
    const sent = run([acct('Spare', {}, { 'rune arrow': 5000 })], 2, [{ name: 'Spare', side, items: { 'rune arrow': 5000 } }]);
    expect(sent.find(x => x.account === 'Hunter')!.send).toMatchObject({ from: 'Spare', to: 'Hunter', item: 'rune arrow' });
    expect(sent.find(x => x.account === 'Trainer')!.reason).toMatch(/^vacant: waits for a bot slot/);
});

test('an active squad supply job takes its shop before a goal band that holds the same shop, unless a running job holds it', () => {
    const band = { ...catalogue().find(t => t.id === 'army-cow-strength-45')!, resources: ['shop:dargaud'] };
    const templates = [band, ...squadSupplies().filter(t => t.id === 'squad-arrows-dargaud')];
    const trainer = acct('Trainer', { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, { 'wooden shield': 1, 'bronze sword': 1, trout: 20, coin: 50_000 });
    const run = (extra: Partial<Inputs> = {}) => plan(inputs([trainer, acct('Buyer', { Ranged: 40 }, { coin: 400_000 }), acct('Hunter', {}, {})], { templates, army: new Set(['trainer']),
        capacity: { ...CAPACITY, 'shop:dargaud': 1 }, prices: { 'rune arrow': 500 }, squad: { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] }, ...extra }));
    const first = run();
    expect(first.find(x => x.account === 'Buyer')!.template?.id).toBe('squad-arrows-dargaud');
    expect(first.find(x => x.account === 'Trainer')!.template?.id).toBeUndefined();
    // The band runs on the shop now: it keeps the place, and the squad job waits.
    const kept = run({ running: new Set(['trainer']), current: new Map([['trainer', band.id]]) });
    expect(kept.find(x => x.account === 'Trainer')!.template?.id).toBe(band.id);
    expect(kept.find(x => x.account === 'Buyer')!.template).toBeUndefined();
});

test('a squad supply template is a candidate only while the squad is active: the full catalogue with no squad plans as without them', () => {
    const all = catalogue(), without = all.filter(t => !t.squadOnly);
    expect(all.length - without.length).toBe(squadSupplies().length);
    // A route bill that asks the squad items would value the new templates if they were ungated.
    const bill = [row('rune arrow', 900), row('water rune', 900), row('nature rune', 900), row('law rune', 100), row('antipoison(3)', 10), row('feathers', 800)];
    const accounts = ['A', 'B', 'C', 'D'].map(n => acct(n, { Magic: 70 }, { coin: 500_000 }));
    const show = (templates: Template[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { templates, bill, capacity: CAPACITY, prices: { 'rune arrow': 3, 'water rune': 4, 'nature rune': 20, 'law rune': 40, 'antipoison(3)': 288, feather: 2 }, ...extra }))
        .map(x => [x.account, x.template?.id, x.reason]);
    expect(show(all)).toEqual(show(without));
    expect(show(all, { squad: { active: false, hours: 4, members: [{ name: 'Hunter', items: {} }] } })).toEqual(show(without));
    expect(show(all).some(([, id]) => String(id).startsWith('squad-'))).toBe(false);
});

test('a squad run is sized by the squad demand: the stock target is the holding plus the demand and the spend is capped', () => {
    const squad: SquadInput = { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] };
    const supplier = acct('Supplier', { Ranged: 40 }, { coin: 400_000, 'rune arrow': 40 });
    const arrows = catalogue().filter(t => t.id === 'squad-arrows-dargaud');
    const out = plan(inputs([supplier], { templates: arrows, bill: [], capacity: CAPACITY, squad, prices: { 'rune arrow': 500 } }))[0]!;
    expect(out.template?.id).toBe('squad-arrows-dargaud');
    const want = Math.min(squadTarget('arrow', 4), 400), env = out.template!.env!;
    expect(env.STOCK_TARGET).toBe(String(40 + want));
    expect(env.STOP_AT_TARGET).toBe('1');
    expect(env.MAX_SPEND).toBe(String(Math.ceil(want * SQUAD_UNIT_COST['rune arrow']! * 2)));
    expect(Number(env.FLOAT)).toBe(Number(env.MAX_SPEND) + 200);
    // Antipoison: a small target and a small cap (the Jiminua shelf is nearly empty).
    const potion = plan(inputs([acct('S', {}, { coin: 100_000 })], { templates: catalogue().filter(t => t.id === 'squad-antipoison-jiminua'), bill: [], capacity: CAPACITY, squad,
        prices: { 'antipoison(3)': 288 } }))[0]!;
    expect(Number(potion.template!.env!.STOCK_TARGET)).toBeLessThanOrEqual(12);
    expect(Number(potion.template!.env!.MAX_SPEND)).toBeLessThan(8000);
});

test('an active squad member never gives its kit or supplies to another account, and never vacates for an order', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45' || t.id === 'army-alch-magic-99');
    // The member holds sharks, runes, an antipoison, cooked food and a spare sword; the other account lacks them all.
    const held = { shark: 500, 'rune arrow': 4000, 'earth rune': 900, 'water rune': 900, 'nature rune': 600, 'antipoison(3)': 12, 'law rune': 20, 'air rune': 60, 'bronze sword': 3, 'wooden shield': 3, trout: 80, 'cooked meat': 50, coin: 9000 };
    const member = acct('Member', { Strength: 99, Attack: 99, Defence: 99, Magic: 99 }, held), needy = acct('Needy', { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, { 'wooden shield': 1, coin: 100 });
    const stock = [{ name: 'Member', side, items: held }];
    const run = (squadActive: boolean) => plan(inputs([member, needy], { templates: band, army: new Set(['needy']), stock, donors: [{ name: 'Member', coins: 900_000 }], capacity: { 'cow:ardougne-north': 6 },
        squad: { active: squadActive, hours: 4, members: [{ name: 'Member', items: held }] } }));
    // Control: with the squad inactive the member is an ordinary donor and gives the sword.
    expect(run(false).find(x => x.account === 'Needy')!.send?.from ?? run(false).find(x => x.account === 'Needy')!.fund?.from).toBe('Member');
    const out = run(true);
    expect(out.flatMap(x => [x.send?.from, x.fund?.from]).filter(Boolean)).toEqual([]);
    expect(out.find(x => x.account === 'Member')!.reason).not.toMatch(/^vacant: gives/);
});

test('accounts above ground level are excluded from surface combat gather dispatch until back at level 0', () => {
    const druids = squadSupplies().filter(t => t.id === 'squad-taverley-druids');
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const squad: SquadInput = { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] };
    const upstairs = at(acct('BraveHardon', { Attack: 50, Strength: 13, Defence: 1, Hitpoints: 36, Prayer: 47, Magic: 31 }, { trout: 20, coin: 1000 }), { x: 2686, z: 3268, level: 1 });
    const ground = at(upstairs, { x: 2686, z: 3268, level: 0 });
    expect(plan(inputs([upstairs], { templates: druids, squad, prices: { 'unidentified ranarr': 2000 } }))[0]!.template).toBeUndefined();
    expect(plan(inputs([ground], { templates: druids, squad, prices: { 'unidentified ranarr': 2000 } }))[0]!.template?.id).toBe('squad-taverley-druids');
    const upstairsCow = at(acct('Train', { Strength: 10, Hitpoints: 30 }, { 'bronze sword': 1, 'wooden shield': 1, trout: 20, coin: 1000 }), { x: 2686, z: 3268, level: 1 });
    expect(plan(inputs([upstairsCow], { templates: cow, army: new Set(['train']) }))[0]!.template).toBeUndefined();
    expect(plan(inputs([at(upstairsCow, { x: 2686, z: 3268, level: 0 })], { templates: cow, army: new Set(['train']) }))[0]!.template?.id).toBe('army-cow-strength-45');
    const goldfarm = catalogue().filter(t => t.script === 'scripts/goldfarm.ts');
    if (goldfarm.length) {
        const upstairsThief = at(acct('Toss', { Thieving: 99, Hitpoints: 30 }, { lobster: 20, coin: 1000 }), { x: 2678, z: 3268, level: 1 });
        expect(plan(inputs([upstairsThief], { templates: goldfarm }))[0]!.template).toBeUndefined();
    }
});

test('the squad spare of a member is what it holds above the squad reserve, never negative', () => {
    // A member short of its own target gives nothing; a member above it gives only the excess, to another member.
    const squad: SquadInput = { active: true, hours: 4, members: [{ name: 'Rich', items: { 'rune arrow': 5000 } }, { name: 'Poor', items: {} }] };
    const target = squadTarget('arrow', 4);
    const run = (richArrows: number) => plan(inputs([acct('Rich', {}, { 'rune arrow': richArrows }), acct('Poor', {}, { coin: 100 })], { templates: [], bill: [],
        stock: [{ name: 'Rich', side, items: { 'rune arrow': richArrows } }], squad: { ...squad, members: [{ name: 'Rich', items: { 'rune arrow': richArrows } }, { name: 'Poor', items: {} }] } }));
    expect(run(target - 1).find(x => x.account === 'Poor')!.send?.item).not.toBe('rune arrow');
    expect(run(target).find(x => x.account === 'Poor')!.send?.item).not.toBe('rune arrow');
    const give = run(target + 700).find(x => x.account === 'Poor')!.send;
    expect(give).toMatchObject({ from: 'Rich', item: 'rune arrow', count: Math.min(700, target) });
});

test('the squad rows are priced from the plan and capped by maxCoins, first lines first', () => {
    const squad = (maxCoins?: number): SquadInput => ({ active: true, hours: 4, ...(maxCoins === undefined ? {} : { maxCoins }), members: [{ name: 'Hunter', items: {} }] });
    const all = squadRows(squad(), item => ({ 'rune arrow': 3 } as Record<string, number | undefined>)[item]);
    expect(all.length).toBe(Object.keys(SQUAD_HOURLY).length + Object.keys(SQUAD_SPARES).length);
    // Food first: 355 sharks at 250 coins, 88,750. A cap of 90,750 leaves 2,000: arrows (1,965) and climbing boots (24) fit.
    // With a 90,000 cap (1,250 left), arrows (1,965), earth (1,292), water (1,292) and nature exceed it, so antipoison (1,152) and climbing boots (24) stay.
    const prices = { ...SQUAD_UNIT_COST, shark: 250, 'rune arrow(p)': 3, 'rune arrow': 3, 'earth rune': 4, 'water rune': 4, 'nature rune': 20, 'antipoison(3)': 288, 'law rune': 40, 'air rune': 4 } as Record<string, number>;
    expect(squadRows(squad(90_750), item => prices[item]).map(r => r.consumer.split(': ')[1])).toEqual(['food', 'arrow', 'climbing boot']);
    expect(squadRows(squad(90_000), item => prices[item]).map(r => r.consumer.split(': ')[1])).toEqual(['food', 'antipoison(3)', 'climbing boot']);
    expect(squadRows(squad(0), () => 1).length).toBe(0);
    // The fallback table prices a line the plan has no price for: 1,965 coins of arrows do not fit a cap of 1,000.
    const lines = squadRows(squad(1000), () => undefined, { 'rune arrow(p)': 3, 'rune arrow': 3 }).map(r => r.consumer.split(': ')[1]);
    expect(lines).not.toContain('arrow');
    expect(lines).not.toContain('food');
});

test('squadHeld counts 4-dose and super potions cleanly, keeps karambwans separate from sharks, and skips non-unique black dhide trades', () => {
    expect(Object.keys(SQUAD_POTION_ALIASES)).toContain('prayer potion(3)');
    expect(squadHeld('prayer potion(3)', { 'prayer potion(4)': 9 })).toBe(12);
    expect(squadHeld('antipoison(3)', { 'superantipoison(4)': 3 })).toBe(4);
    expect(squadHeld('food', { 'cooked karambwan': 50 })).toBe(0);
    expect(squadHeld('cooked karambwan', { shark: 500, 'cooked karambwan': 15 })).toBe(15);

    const parsed = accountFrom('Skiller', side, {
        inventory: [{ id: 2503, count: 2, name: 'Dragonhide body' }, { id: 1135, count: 1, name: 'Dragonhide body' }, { id: 3146, count: 3, name: 'Cooked karambwan' }, { id: 3144, count: 4, name: 'Cooked karambwan' }],
        bank: [{ id: 99, count: 5, name: 'Unfinished potion' }, { id: 207, count: 6, name: 'Herb' }],
    }, () => undefined);
    expect(parsed.items['black_dragonhide_body']).toBe(2);
    expect(parsed.items['dragonhide body']).toBe(1);
    expect(parsed.items['poorly cooked karambwan']).toBe(3);
    expect(parsed.items['cooked karambwan']).toBe(4);
    expect(parsed.items['ranarr potion (unf)']).toBe(5);
    expect(parsed.items['unidentified ranarr']).toBe(6);

    const squad: SquadInput = { active: true, hours: 4, all: ['Hunter'], members: [{ name: 'Hunter', items: { ...Object.fromEntries(Object.keys(SQUAD_HOURLY).filter(i => i !== 'food').map(i => [i === 'arrow' ? 'rune arrow' : i, 1000])), shark: 500, 'ring of recoil': 10, 'climbing boot': 5, 'dragon dagger(p)': 5, 'magic shortbow': 5, 'berserker helm': 5, 'rune full helm': 5, 'rune platebody': 5, 'rune plateleg': 5, 'rune kiteshield': 5 } }] };
    const donorItems = { black_dragonhide_body: 10, black_dragonhide_chaps: 10, black_dragon_vambraces: 10 };
    const out = plan(inputs([acct('Hunter', {}, { coin: 100 }), acct('Crafter', {}, donorItems)], { templates: [], bill: [], squad, stock: [{ name: 'Crafter', side, items: donorItems }] }));
    expect(out.find(x => x.account === 'Hunter')?.send).toBeUndefined();
});

test('a held squad member (live hunt) is still held out of jobs and donor stock: every block member drives the hold-out', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const base = { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 };
    const hunter = acct('Hunter', base, { 'bronze sword': 1, trout: 100, coin: 50_000 }), needy = acct('Needy', base, { 'bronze sword': 1, coin: 100 });
    const stock = [{ name: 'Hunter', side, items: { trout: 100, 'bronze sword': 1 } }];
    const run = (squad?: SquadInput, army = ['hunter', 'needy']) => plan(inputs([hunter, needy], { templates: band, army: new Set(army), capacity: { 'cow:ardougne-north': 6 }, stock, donors: [{ name: 'Hunter', coins: 900_000 }], ...(squad ? { squad } : {}) }));
    // Control: with no squad Hunter is an ordinary free donor (off the roster, it takes no band itself): it sends its trout to Needy.
    expect(run(undefined, ['needy']).find(x => x.account === 'Needy')!.send).toMatchObject({ from: 'Hunter', item: 'trout' });
    // Held: it is in `all` but not in `members` (a live session, a stop file): no band, no kit buy, no donation.
    const held = run({ active: true, hours: 4, all: ['Hunter'], members: [] });
    expect(held.find(x => x.account === 'Hunter')!.template).toBeUndefined();
    expect(held.flatMap(x => [x.send?.from, x.fund?.from]).filter(Boolean)).toEqual([]);
});

test('a food restock sends sharks: a shark donor sends the sharks short, a lobster donor sends none', () => {
    const squad: SquadInput = { active: true, hours: 4, all: ['Hunter'], members: [{ name: 'Hunter', items: {} }] };
    const run = (item: string) => plan(inputs([acct('Hunter', {}, { coin: 100 }), acct('Donor', {}, { [item]: 5000 })], { templates: [], bill: [], squad, stock: [{ name: 'Donor', side, items: { [item]: 5000 } }] }))
        .find(x => x.account === 'Hunter')!.send;
    expect(run('shark')).toMatchObject({ item: 'shark', count: squadTarget('food', 4) });
    expect(run('lobster')?.item).not.toBe('lobster');
});

test('a cow band needs one wearable melee weapon, not a bronze sword by name; a missing weapon is a weapon step', () => {
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45'), zeke = catalogue().filter(t => t.id.startsWith('army-weapon-zeke-'));
    const base = { Strength: 10, Defence: 10, Hitpoints: 30 }, kit = { trout: 20 };
    const run = (a: Acct, templates: Template[], extra: Partial<Inputs> = {}) => plan(inputs([a], { templates, army: new Set([a.name.toLowerCase()]), capacity: { 'cow:ardougne-north': 6, 'shop:zeke': 1 }, ...extra }))[0]!;
    // A rune scimitar and no bronze sword (and no shield): the band runs.
    expect(run(acct('Rune', { ...base, Attack: 40 }, { ...kit, 'rune scimitar': 1 }), cow).template?.id).toBe('army-cow-strength-45');
    // A banked or worn weapon counts the same: the holdings are one map.
    expect(run(acct('Dagger', { ...base, Attack: 1 }, { ...kit, 'bronze dagger': 1 }), cow).template?.id).toBe('army-cow-strength-45');
    // A weapon the Attack level cannot wear is no weapon: Attack 1 with a rune scimitar gets none.
    expect(run(acct('Weak', { ...base, Attack: 1 }, { ...kit, 'rune scimitar': 1 }), cow).reason).toBe('vacant: army-cow-strength-45 needs 1 bronze sword and no source gives them');
    // No weapon: the Zeke scimitar step, not a dead end.
    const bare = acct('Bare', { ...base, Attack: 10 }, { ...kit, coin: 5_000 });
    expect(run(bare, [...cow, ...zeke]).template?.id).toBe('army-weapon-zeke-steel');
    // Food stays a need: a weapon and no food is no band start.
    expect(run(acct('Hungry', { ...base, Attack: 40 }, { 'rune scimitar': 1 }), cow).reason).toBe('vacant: army-cow-strength-45 needs 2 trout and no source gives them');
    // A donor with a cheap weapon fills the line (one item order), and the vacant reason names the line when no source has it.
    const sent = run(bare, cow, { stock: [{ name: 'Spare', side, items: { 'iron scimitar': 2 } }] });
    expect(sent.send).toMatchObject({ from: 'Spare', to: 'Bare', item: 'iron scimitar', count: 1 });
    expect(run(bare, cow).reason).toMatch(/^vacant: army-cow-strength-45 needs 1 bronze sword and no source gives them$/);
});

test('an army donor keeps the one melee weapon its band needs, and gives only the spare', () => {
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const base = { Strength: 10, Defence: 10, Hitpoints: 30, Attack: 10 };
    // The donor has no food, so it cannot start its own band and is free stock; the band still needs its one weapon.
    const run = (donorSwords: number) => plan(inputs([acct('Needy', base, { trout: 20, coin: 100 }), acct('Donor', base, { 'bronze sword': donorSwords })], { templates: cow, army: new Set(['needy', 'donor']),
        capacity: { 'cow:ardougne-north': 6 }, stock: [{ name: 'Donor', side, items: { 'bronze sword': donorSwords } }] }));
    // One sword is the donor's own weapon: it stays, and the needy account gets no order for it.
    expect(run(1).find(x => x.account === 'Needy')!.send).toBeUndefined();
    // A second sword is spare.
    expect(run(2).find(x => x.account === 'Needy')!.send).toMatchObject({ from: 'Donor', item: 'bronze sword', count: 1 });
});

import { canWearGear, gearById, gearIdByName } from '../src/gear-progression';
import { COW_WEAPONS } from '../src/autopilot';
test('COW_WEAPONS levels are the Attack levels that wear each weapon in the gear data', () => {
    for (const [item, attack] of COW_WEAPONS) {
        const gear = gearById(gearIdByName(item)!)!;
        expect([item, canWearGear(gear, { attack })]).toEqual([item, true]);
        if (attack > 1) expect([item, canWearGear(gear, { attack: attack - 1 })]).toEqual([item, false]);
    }
});

test('a donor of another side or outside the roster keeps the one cheap weapon: only its spare is sent', () => {
    const cow = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const base = { Strength: 10, Defence: 10, Hitpoints: 30, Attack: 10 };
    const run = (donorSide: string, swords: number) => plan(inputs([acct('Needy', base, { trout: 20, coin: 100 })], { templates: cow, army: new Set(['needy']), capacity: { 'cow:ardougne-north': 6 },
        stock: [{ name: 'Far', side: donorSide, items: { 'bronze sword': swords } }] }))[0]!;
    // A cloud-side account with one sword keeps it; with two it sends one.
    expect(run('cloud', 1).send).toBeUndefined();
    expect(run('cloud', 2)).toMatchObject({ send: { from: 'Far', item: 'bronze sword', count: 1 } });
    // Same for a local account outside the army roster.
    expect(run(side, 1).send).toBeUndefined();
});

test('plan fills at most the free bot slots, best band first, and names the rest', () => {
    const band = catalogue().filter(t => t.family === 'combat-train' && t.tier === 'goal' && t.id.startsWith('army-cow-'));
    const kit = { 'bronze sword': 1, 'wooden shield': 1, trout: 20 };
    const crew = ['A', 'B', 'C', 'D'].map(n => acct(n, { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, kit));
    const army = new Set(crew.map(a => a.name.toLowerCase()));
    const run = (slots?: number) => plan(inputs(crew, { templates: band, army, capacity: { 'cow:ardougne-north': 6 }, ...(slots === undefined ? {} : { slots }) }));
    const open = run();
    expect(open.filter(x => x.template).length).toBe(4);
    const two = run(2);
    expect(two.filter(x => x.template).map(x => x.account)).toEqual(open.filter(x => x.template).slice(0, 2).map(x => x.account));
    const waiting = two.filter(x => !x.template);
    expect(waiting.length).toBe(2);
    for (const x of waiting) expect(x.reason).toMatch(/^vacant: waits for a bot slot \(2 free, 0 held by running bots\): army-cow-\w+-45 ranks below/);
    expect(run(0).every(x => !x.template && /waits for a bot slot \(0 free, 0 held/.test(x.reason))).toBe(true);
    // A job that runs now keeps its slot over a better new band.
    const running = plan(inputs(crew, { templates: band, army, capacity: { 'cow:ardougne-north': 6 }, slots: 1, running: new Set(['d']), current: new Map([['d', open.find(x => x.account === 'D')!.template!.id]]) }));
    expect(running.filter(x => x.template).map(x => x.account)).toEqual(['D']);
});

test('a running bot keeps its slot whatever the count, including a kit buy that replaces its band', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const kit = { 'bronze sword': 1, 'wooden shield': 1, trout: 20 };
    const crew = ['A', 'B', 'C'].map(n => acct(n, { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, kit));
    const army = new Set(['a', 'b', 'c', 'd']);
    // D lost its sword: a market buy replaces its running band (template kit-buy:army-cow-strength-45).
    const d = acct('D', { Strength: 10, Attack: 10, Defence: 10, Hitpoints: 30 }, { 'wooden shield': 1, trout: 20, coin: 50_000 });
    const market = { 'bronze sword': { id: 1277, name: 'Bronze sword', limit: 100 } };
    const base = { templates: band, army, market, capacity: { 'cow:ardougne-north': 6 }, current: new Map([['d', 'army-cow-strength-45']]) };
    const open = plan(inputs([...crew, d], base));
    expect(open.find(x => x.account === 'D')!.template?.id).toBe('kit-buy:army-cow-strength-45');
    // Fewer slots than jobs: the running account D keeps its buy, by the account, not by the template it ran.
    const two = plan(inputs([...crew, d], { ...base, slots: 2, running: new Set(['d']) }));
    expect(two.filter(x => x.template).map(x => x.account)).toContain('D');
    expect(two.filter(x => x.template)).toHaveLength(2);
    // A run in the swarm's list holds its slot as a confirmed session does (a start inside its window included).
    expect(plan(inputs([...crew, d], { ...base, slots: 2, holding: new Set(['d']) })).find(x => x.account === 'D')!.template?.id).toBe('kit-buy:army-cow-strength-45');
    // Zero slots, or fewer than the running bots: every running job stays and nothing else starts.
    const none = plan(inputs([...crew, d], { ...base, slots: 0, running: new Set(['a', 'd']) }));
    expect(none.filter(x => x.template).map(x => x.account).sort()).toEqual(['A', 'D']);
    expect(none.filter(x => !x.template && /waits for a bot slot \(0 free, 2 held by running bots\)/.test(x.reason))).toHaveLength(2);
});

test('an order costs two slots: the plan never holds more bots than the slots, donors included', () => {
    const shops = catalogue().filter(t => t.id === 'shop-feathers');
    const accounts = [acct('Poor'), acct('Zed', {}, { coin: 900_000 })];
    const run = (slots?: number) => plan(inputs(accounts, { templates: shops, capacity: { 'shop:sarim': 2 }, donors: [{ name: 'Zed', coins: 900_000 }], ...(slots === undefined ? {} : { slots }) }));
    // No cap: Zed funds Poor, an order that logs in both accounts.
    expect(run().find(x => x.account === 'Poor')!.fund).toMatchObject({ from: 'Zed', to: 'Poor' });
    // Two slots hold the order (recipient and donor); one slot cannot, so the order waits and the donor is free again.
    expect(run(2).find(x => x.account === 'Poor')!.fund).toBeDefined();
    const one = run(1);
    expect(one.find(x => x.account === 'Poor')!.reason).toMatch(/^vacant: waits for a bot slot \(1 free, 0 held by running bots\)/);
    expect(one.find(x => x.account === 'Zed')!.reason).not.toBe('vacant: gives coins this pass');
    for (const slots of [0, 1, 2, 3]) expect([slots, run(slots).filter(x => x.template).reduce((n, x) => n + (x.fund || x.send ? 2 : 1), 0) <= slots]).toEqual([slots, true]);
});

test('a vacant reason names an observation too old to offer stock, and accountFrom keeps the observation time', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const now = 100 * 3_600_000, old = { ...acct('Rookie'), observedAt: now - 52 * 3_600_000 };
    const reason = (a: Acct, extra: Partial<Inputs> = {}) => plan(inputs([a], { templates: band, army: new Set(['rookie']), ...extra }))[0]!.reason;
    expect(reason(old)).toMatch(/and no source gives them$/);
    expect(reason(old, { now, unobserved: ['Idle1', 'Idle2'] })).toMatch(/and no source gives them \(its own observation is 52 h old; 2 free accounts have no observation under 30 minutes old, so their stock is not offered\)$/);
    // A fresh observation and no unobserved donor add nothing.
    expect(reason({ ...old, observedAt: now - 60_000 }, { now, unobserved: [] })).toMatch(/and no source gives them$/);
    expect(accountFrom('Seen', side, { at: 1234, skills: [] }, () => undefined).observedAt).toBe(1234);
    expect(accountFrom('Unseen', side, null, () => undefined).observedAt).toBeUndefined();
});

test('the stale-observation note follows only a missing source, not a coin lack', () => {
    const band = catalogue().filter(t => t.id === 'army-cow-strength-45');
    const now = 100 * 3_600_000, old = { ...acct('Rookie'), observedAt: now - 52 * 3_600_000 };
    const run = (templates: Template[], a: Acct = old) => plan(inputs([a], { templates, army: new Set(['rookie']), now, unobserved: ['Idle1'] }))[0]!.reason;
    expect(run(band)).toMatch(/and no source gives them \(its own observation is 52 h old/);
    const poor = catalogue().filter(t => t.id === 'goldfarm@2652,3318');
    const coin = plan(inputs([acct('Thief', { Thieving: 70, Hitpoints: 54 }, { coin: 1 })], { templates: poor, now, unobserved: ['Idle1'], taken: {} }))[0]!;
    expect(coin.reason).toMatch(/coins/);
    expect(coin.reason).not.toMatch(/observation/);
});

test('a ring maker that lacks only the mould gets the Dommik shop trip first, behind the pilot gate and the other needs', () => {
    const rings = [...aioTemplates().filter(t => /^aio-\w+-rings$/.test(t.id)), ...catalogue().filter(t => t.id === 'shop-ring-mould')];
    const diamond = { Crafting: 43 }, kit = { 'gold bar': RING_BATCH, diamond: RING_BATCH, coin: 5_000 };
    const bill = [row('diamond ring', 81), row('emerald ring', 46)];
    const run = (a: Acct, pilots: string[] = ['aio-diamond-rings'], extra: Partial<Inputs> = {}) => plan(inputs([a], { templates: rings, bill, prices: { 'diamond ring': 3525, 'emerald ring': 1275 }, capacity: CAPACITY, pilots: new Set(pilots), ...extra }))[0]!;
    // The three makers of the finding: each holds the bars, the gems and the Crafting level, and no mould.
    for (const name of ['TrouserSnake', 'UnderMyKilt', 'TheFullMonty']) {
        const out = run(acct(name, { Attack: 99, Strength: 99, Defence: 99, ...diamond }, kit));
        expect(`${name} ${out.template?.id} ${out.reason}`).toBe(`${name} shop-ring-mould buys a ring mould for aio-diamond-rings`);
        expect(out.resources).toEqual(['shop:dommik']);
        expect(jobFor(out, side).args).toEqual(['dommik', '600']);
    }
    // Holding the mould, the maker itself runs and the shop is skipped.
    expect(run(acct('A', diamond, { ...kit, 'ring mould': 1 })).template?.id).toBe('aio-diamond-rings');
    // A maker the aio list does not name is not unlocked, so no shop trip; a missing bar or gem means the trip alone does not unlock it.
    expect(run(acct('A', diamond, kit), []).template).toBeUndefined();
    expect(run(acct('A', diamond, { ...kit, 'gold bar': 0 })).template).toBeUndefined();
    expect(run(acct('A', { Crafting: 42 }, kit)).template).toBeUndefined();
    // Without the 100 coins the trip needs there is no shop job, and the reason names the coins.
    expect(run(acct('A', diamond, { ...kit, coin: 10 })).template).toBeUndefined();
    // Dommik's shelf serves one account at a time.
    const two = plan(inputs([acct('A', diamond, kit), acct('B', diamond, kit)], { templates: rings, bill, prices: { 'diamond ring': 3525 }, capacity: CAPACITY, pilots: new Set(['aio-diamond-rings']) }));
    expect(two.filter(x => x.template?.id === 'shop-ring-mould')).toHaveLength(1);
});

test('a claim authority timeout is a drain, like an unavailable authority', () => {
    for (const line of ['RESULT fail login: Error: fleet swarm claim authority timed out', 'RESULT fail fleet swarm claim authority timed out chain rounds=1 ok=0 failed=1',
        'RESULT fail login: Error: fleet swarm claim authority unavailable or changed', 'RESULT fail fleet account claim held by swarm']) {
        expect([line, DRAIN_RESULT.test(line)]).toEqual([line, true]);
        expect(assess([line, line])).toMatchObject({ retire: false, drains: 2, fail: 0 });
    }
    expect(DRAIN_RESULT.test('RESULT fail fleet swarm claim authority exploded')).toBe(false);
});

import { QUEST_CAP_FACTOR, QUEST_CAP_MIN, questKitCaps, goalNeeds, QUEST_DEMAND, QUEST_DEMAND_BAND, QUEST_DEMAND_PLACES, QUEST_DEMAND_ROWS, questDemand, questResource, questsDoneIn } from '../src/autopilot';
describe('quest demand: the quests no owned account has done', () => {
    const MAXED = { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99, Thieving: 99, Agility: 99, Cooking: 99, Fletching: 99, Crafting: 99, Mining: 99, Smithing: 99 };
    const row = (slug: string) => QUEST_DEMAND_ROWS.find(q => q.slug === slug)!;
    // The pack of one quest: its items and its meals as sharks.
    const packOf = (...slugs: string[]) => { const pack: Record<string, number> = {}; for (const s of slugs) { for (const [i, n] of Object.entries(row(s).items)) pack[norm(i)] = Math.max(pack[norm(i)] ?? 0, n); pack.shark = Math.max(pack.shark ?? 0, row(s).meals); } return pack; };
    const soldier = (name: string, slugs: string[], done: string[] = ['lost city'], items: Record<string, number> = {}): Acct =>
        ({ ...acct(name, { ...MAXED, Ranged: 99 }, { ...packOf(...slugs), coin: 100_000, ...items }), quests: new Set(done) });
    const names = (slugs: string[]) => new Set(slugs.map(s => `quest-${s}`));
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(inputs(accounts, { army: new Set(accounts.map(a => a.name.toLowerCase())), capacity: CAPACITY,
        pilots: names(QUEST_DEMAND_ROWS.map(q => q.slug)), questsDone: new Set(), templateFor: qualifiedTrooperTemplate, ...extra }));
    const quest = (x: { template?: Template }) => x.template?.id.startsWith('quest-') ? x.template.id : undefined;
    const id = (accounts: Acct[], extra: Partial<Inputs> = {}) => quest(run(accounts, extra)[0]!);

    test('an army account that holds the pack of a quest nobody has done takes it as a pilot, behind its own place', () => {
        const [x] = run([soldier('Kilt', ['elemental'])]);
        expect(x!.template!.id).toBe('quest-elemental');
        expect(x!.reason).toBe(`army band ${QUEST_DEMAND_BAND}: Elemental Workshop`);
        expect(jobFor(x!, side)).toMatchObject({ script: 'scripts/aio.ts', args: ['quester', 'sweep', 'elemental'], repeat: false, resources: [questResource('elemental'), QUEST_DEMAND] });
        // The cheapest quest of the practice runs first.
        expect(id([soldier('Kilt', ['elemental', 'chompybird'])])).toBe('quest-elemental');
        expect(id([soldier('Kilt', ['chompybird'])])).toBe('quest-chompybird');
    });

    test('there is no job without the proof, the list, the roster, the pack or a quest left to do', () => {
        const kilt = soldier('Kilt', ['elemental']);
        // Not a pilot the plan names; no list of done quests; a quest that an observed account has done; one this account has done.
        expect(id([kilt], { pilots: new Set() })).toBeUndefined();
        expect(id([kilt], { questsDone: undefined })).toBeUndefined();
        expect(id([kilt], { questsDone: new Set(['elemental workshop']) })).toBeUndefined();
        expect(id([soldier('Kilt', ['elemental'], ['lost city', 'elemental workshop'])])).toBeUndefined();
        // An account whose status lists no quests, a pack short of one knife, no roster seat.
        expect(id([{ ...kilt, quests: undefined }])).toBeUndefined();
        expect(id([{ ...kilt, items: { ...kilt.items, knife: 0 } }])).toBeUndefined();
        expect(id([kilt], { army: new Set() })).toBeUndefined();
        // Skills the journal asks for: Ikov wants Thieving 42 and Ranged 40.
        const ikov = soldier('Kilt', ['ikov']);
        expect(id([ikov])).toBe('quest-ikov');
        expect(id([{ ...ikov, skills: { ...ikov.skills, Thieving: 41 } }])).toBeUndefined();
        // A quest that wants another quest first: Biohazard wants Plague City.
        expect(id([soldier('Kilt', ['biohazard'])])).toBeUndefined();
        expect(id([soldier('Kilt', ['biohazard'], ['lost city', 'plague city'])])).toBe('quest-biohazard');
    });

    test('one account does a quest once and at most QUEST_DEMAND_PLACES quest jobs run at a time', () => {
        const slugs = ['elemental', 'chompybird', 'horror', 'ikov'];
        const four = ['A', 'B', 'C', 'D'].map(n => soldier(n, slugs));
        const out = run(four).map(quest);
        expect(out.filter(Boolean).length).toBe(QUEST_DEMAND_PLACES);
        expect(new Set(out.filter(Boolean)).size).toBe(QUEST_DEMAND_PLACES);
        // The Fremennik Trials and the Underground Pass use the place of their build templates.
        expect(questResource('viking')).toBe(catalogue().find(t => t.id === 'army-quest-fremennik')!.resources![0]);
        expect(questResource('upass')).toBe(catalogue().find(t => t.id === 'army-quest-upass')!.resources![0]);
        expect(questResource('regicide')).toBe(questResource('upass'));
    });

    test('a kit buy for a quest goes to one account for each quest, and never for more quests than the shared place holds', () => {
        const market: Market = { 'law rune': { id: 563, name: 'Law rune', limit: KIT_PRICE_CAPS['law rune'] ?? 400 } };
        const lacking = (name: string) => { const a = soldier(name, ['ikov', 'dig']); return { ...a, items: { ...a.items, 'law rune': 0 } }; };
        const out = run(['A', 'B', 'C', 'D', 'E'].map(lacking), { market });
        const buys = out.map(x => x.template?.id).filter((t): t is string => !!t && t.startsWith(KIT_BUY + 'quest-'));
        expect(buys.length).toBeGreaterThan(0);
        expect(new Set(buys).size).toBe(buys.length);
        expect(buys.length).toBeLessThanOrEqual(QUEST_DEMAND_PLACES);
    });

    test('the bill asks for the pack of a quest once, however many accounts could run it', () => {
        const market: Market = { 'law rune': { id: 563, name: 'Law rune', limit: KIT_PRICE_CAPS['law rune'] ?? 400 } };
        const lacking = (name: string) => { const a = soldier(name, ['ikov']); return { ...a, items: { ...a.items, 'law rune': 0 } }; };
        const rows = (n: number) => goalNeeds(inputs(Array.from({ length: n }, (_, i) => lacking(`Soldier${i}`)), { army: new Set(Array.from({ length: n }, (_, i) => `soldier${i}`)), market,
            pilots: names(['ikov']), questsDone: new Set() }), Array.from({ length: n }, (_, i) => lacking(`Soldier${i}`))).filter(r => /quest-ikov/.test(r.consumer));
        expect(rows(1).length).toBe(1);
        expect(rows(5).length).toBe(1);
        expect(rows(5)[0]).toMatchObject({ names: ['law rune'], short: 1, account: 'soldier0' });
    });

    test('the pack items that the exchange can sell have a price cap of four times their base value, and no cap changes', () => {
        const content = new Map((JSON.parse(readFileSync(resolve(import.meta.dir, '../../../knowledge/items.json'), 'utf8')) as { name: string; debugname?: string; cost: number; tradeable?: boolean }[])
            .filter(i => !/^cert_/.test(i.debugname ?? '')).map(i => [norm(i.name), i] as const).reverse());
        // Existing caps stand.
        expect([KIT_PRICE_CAPS['nature rune'], KIT_PRICE_CAPS.feather, KIT_PRICE_CAPS['fire rune']]).toEqual([800, 20, 160]);
        const items = new Set(QUEST_DEMAND_ROWS.flatMap(q => Object.keys(q.items).map(norm)));
        const unsellable = [...items].filter(item => item !== 'coin' && !(content.get(item)?.tradeable && content.get(item)!.cost > 0));
        // An item that the content does not mark tradeable gets no cap from the rule (wolfbane, druid pouch, serum 207), and a pack item that the rule caps stands at four times its base value.
        expect(unsellable.length).toBeGreaterThan(0);
        for (const item of unsellable) expect([item, item in KIT_PRICE_CAPS]).toEqual([item, false]);
        const ruled = [...items].filter(item => !unsellable.includes(item) && item !== 'coin' && KIT_PRICE_CAPS[item] === Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * content.get(item)!.cost));
        expect(ruled.length).toBeGreaterThan(20);
        expect(KIT_PRICE_CAPS.knife).toBe(Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * content.get('knife')!.cost));
        expect(KIT_PRICE_CAPS.rope).toBe(Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * content.get('rope')!.cost));
        // A second call adds nothing: every item already has its cap.
        expect(questKitCaps()).toEqual({});
    });

    test('an account without a quest pack buys it within the caps, one account for a quest and at most QUEST_DEMAND_PLACES quests at a time', () => {
        const market: Market = Object.fromEntries([...new Set(QUEST_DEMAND_ROWS.flatMap(q => Object.keys(q.items).map(norm)).concat(['shark', 'lobster']))]
            .filter(item => item in KIT_PRICE_CAPS).map((item, i) => [item, { id: 1000 + i, name: item, limit: KIT_PRICE_CAPS[item]! }]));
        const bare = (name: string): Acct => ({ ...acct(name, { ...MAXED }, { coin: 5_000_000 }), quests: new Set(['lost city']) });
        const out = run(['A', 'B', 'C', 'D'].map(bare), { market });
        const buys = out.map(x => x.template?.id).filter((t): t is string => !!t && t.startsWith(KIT_BUY + 'quest-'));
        // Elemental Workshop first (the shortest practice run): its whole pack is on the market.
        expect(buys[0]).toBe(KIT_BUY + 'quest-elemental');
        expect(new Set(buys).size).toBe(buys.length);
        expect(buys.length).toBeLessThanOrEqual(QUEST_DEMAND_PLACES);
        const first = out.find(x => x.template?.id === KIT_BUY + 'quest-elemental')!;
        const ids = first.template!.args!.map(a => Number(a.match(/ITEM_ID=(\d+)/)![1]));
        // One line for each pack item, the food as one line; every line is under its cap.
        expect(ids.length).toBeGreaterThanOrEqual(Object.keys(QUEST_DEMAND_ROWS.find(q => q.slug === 'elemental')!.items).length);
        for (const a of first.template!.args!) expect(Number(a.match(/LIMIT_PRICE=(\d+)/)![1])).toBeLessThanOrEqual(Math.max(...Object.values(KIT_PRICE_CAPS)));
    });

    test('the table gives each quest one template with the AIO route of its bench case, in order of practice ticks', () => {
        const ts = questDemand();
        expect(ts.map(t => t.id)).toEqual(QUEST_DEMAND_ROWS.map(q => `quest-${q.slug}`));
        expect(new Set(QUEST_DEMAND_ROWS.map(q => q.slug)).size).toBe(QUEST_DEMAND_ROWS.length);
        expect(QUEST_DEMAND_ROWS.map(q => q.ticks)).toEqual([...QUEST_DEMAND_ROWS.map(q => q.ticks)].sort((a, b) => a - b));
        for (const t of ts) expect([t.id, t.pilot, t.once, t.tier, t.worker, t.aio, t.args!.slice(0, 2)]).toEqual([t.id, true, true, 'goal', 'scripts/quest-sweep.ts', `quester:quest:${t.id.slice(6)}`, ['quester', 'sweep']]);
        expect(ts.map(t => t.band)).toEqual([...ts.map(t => t.band)].sort((a, b) => a! - b!));
        // Two quest jobs at a time: one or two accounts.
        expect(QUEST_DEMAND_PLACES).toBe(2);
        expect(CAPACITY[QUEST_DEMAND]).toBe(2);
        for (const t of ts) expect([t.id, CAPACITY[t.resources![0]!]]).toEqual([t.id, 1]);
        // A donor keeps nothing for a quest pack.
        expect(kitReserve(ts)).toEqual({});
        // The ids are in the catalogue.
        const all = new Set(catalogue().map(t => t.id));
        for (const t of ts) expect(all.has(t.id)).toBe(true);
    });

    test('questsDoneIn reads the complete quests of the rows, in the two journal forms, and no other', () => {
        const done = questsDoneIn([
            { quests: ['Cook\'s Assistant', { name: 'Biohazard', state: 'complete' }, { name: 'Plague City', state: 'started' }] },
            { questJournal: [{ name: 'Lost City', state: 'complete' }, 'Shield of Arrav'] }, null, {}, { quests: 'x' },
        ]);
        expect([...done].sort()).toEqual(["biohazard", "cook's assistant", 'lost city', 'shield of arrav']);
    });
});

test('a held squad member is no restock donor: only free members send each other stock', () => {
    // A is on a live hunt (held: in `all`, not in `members`) with 4,000 arrows above its keep; B is free and short.
    const squad: SquadInput = { active: true, hours: 4, all: ['A', 'B'], members: [{ name: 'B', items: {} }] };
    const stock = [{ name: 'A', side, items: { 'rune arrow': 4000 } }];
    const run = (sq: SquadInput) => plan(inputs([acct('A', {}, { 'rune arrow': 4000 }), acct('B', {}, { coin: 100 })], { templates: [], bill: [], stock, squad: sq }));
    const held = run(squad);
    expect(held.find(x => x.account === 'B')!.send).toBeUndefined();
    expect(held.find(x => x.account === 'A')!.reason).not.toBe('vacant: gives a kit item this pass');
    // Control: with A free (a member that is observed and not held) it may send B its surplus.
    const free = run({ ...squad, members: [{ name: 'A', items: { 'rune arrow': 4000 } }, { name: 'B', items: {} }] });
    expect(free.find(x => x.account === 'B')!.send).toMatchObject({ from: 'A', item: 'rune arrow' });
});

test('the game facts of the planner read from the revision-289 content', async () => {
    const a = await import('../src/autopilot');
    expect(a.WEAPON.attack).toBe(30);
    expect(a.GRAIL_RUNES).toEqual({ 'law rune': 12, 'air rune': 46, 'water rune': 6, 'fire rune': 1 });
    expect(a.REGICIDE_RUNES).toEqual({ 'law rune': 5, 'air rune': 3, 'water rune': 5 });
    expect(a.BOUGHT_BONE_XP).toEqual({ 536: 1800, 532: 375 });
    expect([a.CURSE_LEVEL, a.CURSE_XP]).toEqual([19, 725]);
    expect(a.BOW_IDS).toMatchObject({ shortbow: 841, 'yew longbow': 855, 'magic shortbow': 861 });
    expect(a.ARMOUR_IDS).toEqual({ 'dragonhide body': 1135, 'dragonhide chap': 1099, 'dragon vambrace': 1065 });
    expect(a.RANGED_KIT.filter(k => k.skills?.Ranged === 40).map(k => Object.keys(k.items ?? {}).join('+'))).toContain('yew shortbow+rune arrow');
    expect(a.usableTool({ skills: { Mining: 40 } }, 'rune pickaxe')).toBe(false);
    expect(a.usableTool({ skills: { Mining: 41 } }, 'rune pickaxe')).toBe(true);
    expect(a.usableTool({ skills: { Woodcutting: 6 } }, 'steel axe')).toBe(true);
});

test('a kit buy is planned only with the margin above the escrow and reserve: 16 dragon bones at 10,000 need 161,500 coins, not 161,000', () => {
    const band = catalogue().filter(t => t.id === 'army-bury-dragon-99');
    const market = { 'dragon bone': { id: 536, name: 'Dragon bones', limit: 10_000 } };
    const hunter = (coin: number) => acct('Hunter', { Prayer: 50, Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Magic: 99, Ranged: 99 }, { coin, 'rune scimitar': 1 });
    const run = (coin: number) => plan(inputs([hunter(coin), acct('Mule', {}, { coin: 900_000 })], { templates: band, army: new Set(['hunter']), market, prices: { 'dragon bone': 10_000 }, donors: [{ name: 'Mule', coins: 900_000 }] })).find(x => x.account === 'Hunter')!;
    // 160,940 coins for 16 x 10,000 plus the 1,000 reserve is 60 short at the buy script: the plan funds the gap (escrow + reserve + margin
    // - coins) first and buys only once the coins cover the margin.
    const short = run(160_940);
    expect(short.fund).toMatchObject({ from: 'Mule', to: 'Hunter', coins: 16 * 10_000 + KIT_CASH_RESERVE + KIT_COIN_MARGIN - 160_940 });
    const buy = run(16 * 10_000 + KIT_CASH_RESERVE + KIT_COIN_MARGIN);
    expect(buy.fund).toBeUndefined();
    expect(buy.template!.args![0]).toContain('QUANTITY=16');
    expect(buy.template!.args![0]).toContain(`CASH_RESERVE=${KIT_CASH_RESERVE}`);
    // The run meets coins 60 under what the status showed: the planned order still passes the buy script's refusal check, where an order planned
    // at exactly escrow + reserve does not.
    const step = buy.template!.args![0]!, read = (key: string) => Number(step.match(new RegExp(`${key}=([0-9]+)`))![1]);
    const check = (coins: number) => orderRefusal({ now: 1, deadline: 2, over: false, coins, escrow: read('QUANTITY') * read('LIMIT_PRICE'), quantity: read('QUANTITY'), limit: read('LIMIT_PRICE'), reserve: read('CASH_RESERVE'), pack: 5 });
    const planned = 16 * 10_000 + KIT_CASH_RESERVE + KIT_COIN_MARGIN;
    expect(check(planned - 60)).toBeNull();
    expect(check(16 * 10_000 + KIT_CASH_RESERVE - 60)).toMatch(/^coins \d+ are under the escrow 160000 \(16 x 10000\) plus the reserve 1000: 60 short$/);
});

test('the kit buy expects the unnoted count that the buy script reads, not the count with banknotes', () => {
    // The count by name is 4 (1 unnoted and 3 noted); the buy script counts 1 (it matches the item id, never a note).
    const a = accountFrom('Masterbaiter', side, { inventory: [{ id: 561, name: 'Nature rune', count: 1 }, { id: 5561, baseId: 561, name: 'Nature rune (noted)', count: 3 }], bank: [], coins: 0 }, () => undefined);
    expect(a.items['nature rune']).toBe(4);
    expect(a.exact?.['nature rune']).toBe(1);
    expect(accountFrom('Nobody', side, null, () => undefined).exact).toBeUndefined();
    const market = { 'nature rune': { id: 561, name: 'Nature rune', limit: 800 } };
    const band = catalogue().filter(t => t.id === 'army-alch-magic-99');
    const buy = plan(inputs([{ ...a, skills: { ...a.skills, Magic: 70 }, items: { ...a.items, coin: 900_000, 'fire rune': 1 }, exact: { ...a.exact, coin: 900_000, 'fire rune': 1 } }],
        { templates: band, army: new Set(['masterbaiter']), market, prices: { 'nature rune': 800 } }))[0]!;
    const step = buy.template?.args?.find(x => /ITEM_ID=561/.test(x));
    expect(step).toBeDefined();
    expect(step!).toContain('EXPECTED_OWNED=1');
    expect(step!).not.toContain('EXPECTED_OWNED=4');
});

import { proportionalLines, type KitLine } from '../src/autopilot';
import { alchCasts, CAST_XP, FIRE_PER } from '../src/alch-plan';
describe('the alchemy band buys the consumables of the casts left, as far as the coins reach', () => {
    test('one rule gives the supplies from the XP left: a nature rune and an item a cast, fire runes by the spell', () => {
        for (const level of [21, 30, 54, 55, 66, 90, 98]) {
            const { low, high } = alchCasts(xpForLevel(level), 99), need = alchSupplies(level);
            expect(need).toEqual({ nature: low + high, item: low + high, fire: low * FIRE_PER['low-alch'] + high * FIRE_PER['high-alch'] });
            // The casts reach Magic 99, and one fewer cast of each spell would not.
            const xp = low * CAST_XP['low-alch'] + high * CAST_XP['high-alch'];
            expect(xpForLevel(level) + xp).toBeGreaterThanOrEqual(xpForLevel(99));
        }
        // Magic 99 needs nothing; fewer levels left need less.
        expect(alchSupplies(99)).toEqual({ nature: 0, item: 0, fire: 0 });
        expect(alchSupplies(80).fire).toBeLessThan(alchSupplies(60).fire);
        // The table of the band: High Alchemy only from Magic 55, so the first 34 levels cost Low Alchemy casts.
        expect(alchCasts(xpForLevel(55), 99).low).toBe(0);
        expect(alchCasts(xpForLevel(21), 99).low).toBeGreaterThan(0);
    });
    test('a batch that the coins do not reach shrinks in every line by one share and never under the start', () => {
        const line = (item: string, quantity: number, limit: number): KitLine => ({ item, id: 1, quantity, held: 0, limit });
        const full = [line('Nature rune', 600, 800), line('Feather', 600, 20), line('Fire rune', 3000, 160)], start = [line('Nature rune', 50, 800), line('Feather', 50, 20), line('Fire rune', 250, 160)];
        const cost = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0);
        const startCost = cost(start), fullCost = cost(full);
        // Budget for the whole batch: the batch. Under the start: the start. Between: one share of the extra on every line.
        expect(proportionalLines(full, start, fullCost)).toEqual(full);
        expect(proportionalLines(full, start, startCost - 1)).toEqual(start);
        const half = proportionalLines(full, start, startCost + (fullCost - startCost) / 2);
        expect(half.map(l => l.quantity)).toEqual([325, 325, 1625]);
        expect(cost(half)).toBeLessThanOrEqual(startCost + (fullCost - startCost) / 2);
        expect(half.every((l, i) => l.quantity >= start[i]!.quantity && l.quantity <= full[i]!.quantity)).toBe(true);
        // A batch no larger than the start has nothing to share.
        expect(proportionalLines(start, start, 1e9)).toEqual(start);
    });
    test('an account with coins for part of the batch buys part of every line', () => {
        const alch = catalogue().filter(t => t.id === 'army-alch-magic-99');
        const market: Market = { 'nature rune': { id: 561, name: 'Nature rune', limit: 800 }, feather: { id: 314, name: 'Feather', limit: 20 }, 'fire rune': { id: 554, name: 'Fire rune', limit: 160 } };
        const need = alchSupplies(30), start = { nature: 50, feather: 50, fire: 250 };
        const lines = (coin: number) => {
            const [x] = plan(inputs([mage('Rich', { coin }, { Magic: 30 })], { templates: alch, army: new Set(['rich']), market, unfundable: new Set(['rich']) }));
            return x!.template?.args?.map(a => Number(a.match(/QUANTITY=(\d+)/)![1])) ?? [];
        };
        const fullCost = need.nature * 800 + need.item * 20 + need.fire * 160;
        expect(lines(fullCost + 10_000)).toEqual([need.nature, need.item, need.fire]);
        const part = lines(Math.floor(fullCost / 2));
        expect(part.length).toBe(3);
        expect(part[0]).toBeGreaterThan(start.nature);
        expect(part[0]).toBeLessThan(need.nature);
        expect(part[2]).toBeGreaterThan(start.fire);
        expect(part[2]).toBeLessThan(need.fire);
    });
});

import { alchTicks, castTicks, CAST_BENCH } from '../src/alch-plan';
test('the ticks of the alchemy band come from the measured cast times: 12 casts in 57 and 35 ticks', () => {
    expect(castTicks('high-alch')).toBe(CAST_BENCH['high-alch'].ticks / CAST_BENCH['high-alch'].casts);
    expect([castTicks('high-alch'), Math.round(castTicks('low-alch') * 100) / 100]).toEqual([4.75, 2.92]);
    // XP a tick: High Alchemy 1,625 over 4.75 ticks.
    expect(Math.round(CAST_XP['high-alch'] / castTicks('high-alch'))).toBe(342);
    // Magic 50 to 99: 18 Low and 586 High Alchemy casts (the comment of the band says about 2,840 ticks).
    const { low, high } = alchCasts(xpForLevel(50), 99);
    expect(alchTicks(50)).toBe(Math.ceil(low * castTicks('low-alch') + high * castTicks('high-alch')));
    expect(Math.round(alchTicks(50) / 10) * 10).toBe(2840);
    // More levels left take more ticks, and Magic 99 takes none.
    expect(alchTicks(21)).toBeGreaterThan(alchTicks(66));
    expect(alchTicks(99)).toBe(0);
});

import { kitStyle, bowStageFor, ammoStageFor, AMMO_BATCH, AMMO_LOW, AMMO_MARKET } from '../src/autopilot';
import { GEAR_GE_ID, GEAR_SHOP_PILOT, type GearWantRow } from '../src/gear-want-jobs';

describe('army kit stages follow the style that the account trains', () => {
    const army = new Set(['fighter']);
    const listed = (name: string, id: number): Market => ({ [name]: { id, name, limit: KIT_PRICE_CAPS[name]! } });
    const mkt: Market = {
        ...listed('adamant scimitar', 1331), ...listed('rune scimitar', 1333), ...listed('rune chainbody', 1113), ...listed('rune plateleg', 1079), ...listed('rune full helm', 1163),
        ...listed('rune kiteshield', 1201), ...listed('magic shortbow', 861), ...listed('rune arrow', 892), ...listed('bronze arrow', 882), ...listed('dragonhide chap', 1099),
    };
    const base = { Thieving: 99, Attack: 69, Strength: 45, Defence: 43, Hitpoints: 64, Ranged: 64, Magic: 74, Prayer: 21 };
    const ranged = catalogue().filter(t => t.id === 'army-trooper-ranged-99');
    const run = (skills: Record<string, number>, items: Record<string, number>, current?: string, extra: Partial<Inputs> = {}) =>
        plan(inputs([acct('Fighter', { ...base, ...skills }, { shark: 40, coin: 998_000, ...items })], { army, market: mkt, capacity: CAPACITY, ...(current ? { current: new Map([['fighter', current]]) } : {}), ...extra }))[0]!;

    test('a Ranged trainer with a plain shortbow buys the magic shortbow, then rune arrows, never the melee kit', () => {
        const kit = { shortbow: 1, 'bronze arrow': 354 };
        const bow = run({}, kit, 'army-trooper-ranged-99', { templates: ranged });
        expect(bow.template!.id).toBe(KIT_BUY + 'army-weapon-bow');
        expect(bow.template!.args![0]).toContain('ITEM_ID=861 QUANTITY=1');
        expect(bow.resources).toEqual([WEAPON_MARKET]);
        const ammo = run({}, { ...kit, 'magic shortbow': 1 }, 'army-trooper-ranged-99', { templates: ranged });
        expect(ammo.template!.id).toBe(KIT_BUY + 'army-weapon-ammo');
        expect(ammo.template!.args![0]).toContain(`ITEM_ID=892 QUANTITY=${AMMO_BATCH}`);
        // A kit buy that runs keeps the style of its stage, so the buy does not change with the band.
        const idle = run({}, { ...kit, 'rune scimitar': 1, 'rune chainbody': 1 }, KIT_BUY + 'army-armour-rune', { templates: ranged });
        // A finished rune-armour buy does not lead on to the rest of the rune set for a Ranged trainer; a running one keeps its stage.
        expect(idle.template!.id).toBe(KIT_BUY + 'army-weapon-bow');
        expect(run({}, { ...kit, 'rune scimitar': 1, 'rune chainbody': 1 }, KIT_BUY + 'army-armour-rune', { templates: ranged, running: new Set(['fighter']) }).template!.id).toBe(KIT_BUY + 'army-armour-rune');
        expect(run({}, kit, KIT_BUY + 'army-weapon-bow', { templates: ranged }).template!.id).toBe(KIT_BUY + 'army-weapon-bow');
        for (const t of [bow, ammo, run({}, { ...kit, 'magic shortbow': 1, 'rune arrow': 300 }, 'army-trooper-ranged-99', { templates: ranged })])
            expect(t.template?.id).not.toMatch(/army-armour-rune|army-weapon-rune|army-weapon$/);
        // The planner row of the live account named: the chainbody is not planned for a Ranged trainer.
        expect(JSON.stringify(bow.template!.args)).not.toContain('ITEM_ID=1113');
    });

    test('a Ranged trainer that owns the bow and holds the arrows keeps its band, and a bow it cannot wear is not bought', () => {
        const full = { 'magic shortbow': 1, 'rune arrow': 300, 'dragonhide chap': 1, 'dragon vambrace': 1 };
        // With no bow or arrow to buy, the ranged armour comes next: dragonhide, not rune.
        expect(run({}, { 'magic shortbow': 1, 'rune arrow': 300 }, 'army-trooper-ranged-99', { templates: ranged }).template?.id).toBe(KIT_BUY + 'army-armour-dhide');
        expect(run({}, full, 'army-trooper-ranged-99', { templates: ranged }).template?.id ?? '').not.toMatch(/^kit-buy:army-(weapon|armour)/);
        const low = { ...base, Ranged: 45 } as unknown as Record<string, number>;
        const a = acct('Fighter', low, { shortbow: 1, coin: 998_000 });
        expect(bowStageFor(a, inputs([a], { market: mkt }))).toBeNull();
    });

    test('the arrows follow the bow, the Ranged level and the coins, and a stock of better arrows holds', () => {
        const withBow = (items: Record<string, number>, skills: Record<string, number> = {}) => acct('Fighter', { ...base, ...skills }, { 'magic shortbow': 1, coin: 998_000, ...items });
        const arrows = (a: Acct, bow: number, market: Market = mkt) => ammoStageFor(a, inputs([a], { market }), bow)?.items;
        expect(arrows(withBow({}), 50)).toEqual([{ item: 'rune arrow', count: AMMO_BATCH }]);
        // A bow of level 1 fires only arrows of level 1: nothing to order beyond the band's bronze arrows.
        expect(arrows(withBow({}), 1)).toBeUndefined();
        // Too few coins for a batch of the best tier, or no seller: nothing, never a tier the bow cannot fire.
        expect(arrows(withBow({ coin: 1_000 }), 50)).toBeUndefined();
        expect(arrows(withBow({}), 50, listed('bronze arrow', 882))).toBeUndefined();
        // The batch at the price caps may cost at most half of the coins: 720,000 for 300 rune arrows.
        expect(arrows(withBow({ coin: 700_000 }), 50)).toBeUndefined();
        expect(arrows(withBow({ coin: 720_000 }), 50)).toEqual([{ item: 'rune arrow', count: AMMO_BATCH }]);
        // The stage fires only when the arrows run low: 50 held of the tier are a stock, 49 are topped up to the batch.
        expect(arrows(withBow({ 'rune arrow': AMMO_LOW }), 50)).toBeUndefined();
        expect(arrows(withBow({ 'rune arrow': AMMO_LOW - 1 }), 50)).toEqual([{ item: 'rune arrow', count: AMMO_BATCH - AMMO_LOW + 1 }]);
    });

    test('the arrow buy is bounded: it never replaces a running band, and it comes again only when the arrows run low', () => {
        const kit = { 'magic shortbow': 1, 'dragonhide chap': 1, 'dragon vambrace': 1 };
        const idle = run({}, { ...kit, 'rune arrow': 10 }, undefined, { templates: ranged });
        expect(idle.template!.id).toBe(KIT_BUY + 'army-weapon-ammo');
        expect(idle.resources).toEqual([AMMO_MARKET]);
        // A running Ranged band keeps its place: a buy of the weapon market may replace it, the arrow buy may not.
        const busy = { templates: ranged, running: new Set(['fighter']), unfundable: new Set(['fighter']) };
        expect(run({}, { ...kit, 'rune arrow': 10 }, 'army-trooper-ranged-99', busy).template?.id ?? '').not.toBe(KIT_BUY + 'army-weapon-ammo');
        // After a buy the stock holds, and the buy does not repeat until the arrows fall under AMMO_LOW again.
        expect(run({}, { ...kit, 'rune arrow': 10 + AMMO_BATCH }, undefined, { templates: ranged }).template?.id ?? '').not.toBe(KIT_BUY + 'army-weapon-ammo');
        // A retired pair buys no more.
        expect(run({}, { ...kit, 'rune arrow': 10 }, undefined, { templates: ranged, retired: new Set([pairKey('Fighter', KIT_BUY + 'army-weapon-ammo')]) }).template?.id ?? '').not.toBe(KIT_BUY + 'army-weapon-ammo');
    });

    test('with no running band the style is that of the first band it can start: Magic first, then Ranged, then melee', () => {
        const bands = (...ids: string[]) => ids.map(id => ({ template: catalogue().find(t => t.id === id)! }));
        const who = (skills: Record<string, number>) => acct('Fighter', { ...base, ...skills });
        const none = { templates: catalogue(), current: new Map<string, string>() };
        expect(kitStyle(who({}), none, bands('army-alch-magic-99', 'army-trooper-ranged-99', 'army-trooper-defence-99'))).toBe('magic');
        // The Magic band is no candidate (the pass lists none): the next one gives the style. A candidate with no missing kit comes first.
        expect(kitStyle(who({}), none, bands('army-trooper-ranged-99', 'army-trooper-defence-99'))).toBe('ranged');
        expect(kitStyle(who({}), none, [{ template: catalogue().find(t => t.id === 'army-alch-magic-99')!, lacks: [{ of: ['nature rune'], count: 50 }] }, ...bands('army-trooper-defence-99')])).toBe('melee');
        // No band left: no style, so the old kit stays (a blade and rune armour).
        const maxed = acct('Fighter', { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99, Thieving: 99 });
        expect(kitStyle(maxed, none, [])).toBeNull();
        // A running band gives its own style, whatever the pass lists.
        expect(kitStyle(who({}), { ...none, current: new Map([['fighter', 'army-trooper-defence-99']]) }, bands('army-alch-magic-99'))).toBe('melee');
    });

    test('a magic trainer buys no melee kit: the gear pass serves its staff and robes', () => {
        const noBands = (t: Template) => t.id === 'army-alch-magic-99';
        const mage = run({ Magic: 80 }, { 'bronze sword': 1, 'nature rune': 500, 'fire rune': 800 }, 'army-alch-magic-99', { templates: catalogue().filter(noBands) });
        expect(kitStyle(acct('Fighter', { ...base, Magic: 80 }), { templates: catalogue().filter(noBands), current: new Map([['fighter', 'army-alch-magic-99']]) })).toBe('magic');
        expect(mage.template?.id ?? '').not.toMatch(/^kit-buy:army-(weapon|armour)/);
        // The gear pass takes the account when a want is listed: a staff from a shop.
        const want: GearWantRow = { style: 'magic', slot: 'weapon', id: 1389, name: 'Magic staff', current: null, source: { kind: 'shop', shop: 'staffshop', cost: 200 }, profile: 'zaff' };
        const gear = run({ Magic: 80 }, { 'bronze sword': 1, 'nature rune': 500, 'fire rune': 800 }, 'army-alch-magic-99', { templates: catalogue().filter(noBands), gearWants: new Map([['fighter', [want]]]), pilots: new Set([GEAR_GE_ID, GEAR_SHOP_PILOT]) });
        expect(gear.reason).toContain('gear:');
    });

    test('a melee trainer keeps the blade and the rune armour', () => {
        const cow = catalogue().filter(t => t.id === 'army-cow-strength-45');
        const melee = (items: Record<string, number>, skills: Record<string, number> = {}) => run({ Strength: 30, Defence: 45, ...skills }, { 'bronze sword': 1, ...items }, 'army-cow-strength-45', { templates: cow });
        expect(melee({}).template!.id).toBe(KIT_BUY + 'army-weapon-rune');
        expect(melee({ 'rune scimitar': 1 }).template!.id).toBe(KIT_BUY + 'army-armour-rune');
        // No bow or arrow stage for it: it has no Ranged band to train.
        expect(melee({ 'rune scimitar': 1, 'rune chainbody': 1, 'rune plateleg': 1, 'rune full helm': 1, 'rune kiteshield': 1 }).template?.id ?? '').not.toMatch(/army-weapon-(bow|ammo)/);
    });
});

// Inputs.pilotFallback: a free account outside the army roster takes a self-serve production pilot that the `aio` list does not name.
describe('pilot fallback for a free account', () => {
    const chopper = () => acct('Chopper', { Woodcutting: 60 }, { 'bronze axe': 1 });
    const run = (accounts: Acct[], extra: Partial<Inputs> = {}) => plan(aioInputs(accounts, [], extra));
    test('a non-army account gets the production pilot it qualifies for, and none without the switch', () => {
        expect(ids(run([chopper()], { pilotFallback: true }))).toEqual({ Chopper: 'aio-yews' });
        expect(ids(run([chopper()]))).toEqual({ Chopper: 'vacant' });
        expect(ids(run([chopper()], { pilotFallback: false }))).toEqual({ Chopper: 'vacant' });
        // A level under the template's need still gets no job.
        expect(ids(run([acct('Low', { Woodcutting: 59 }, { 'bronze axe': 1 })], { pilotFallback: true })).Low).not.toBe('aio-yews');
    });
    test('met demand gives no job', () => {
        expect(ids(run([chopper()], { pilotFallback: true, bill: [] }))).toEqual({ Chopper: 'vacant' });
        expect(ids(run([chopper()], { pilotFallback: true, bill: [row('yew logs', 0)] }))).toEqual({ Chopper: 'vacant' });
    });
    test('an army account and a squad member get none, and quest, band and combat pilots stay on the list', () => {
        expect(ids(run([chopper()], { pilotFallback: true, army: new Set(['chopper']) })).Chopper).not.toBe('aio-yews');
        const squad = { active: true, hours: 4, all: ['Chopper'], members: [{ name: 'Chopper', items: {} }] };
        expect(ids(run([chopper()], { pilotFallback: true, squad })).Chopper).not.toBe('aio-yews');
        const open = catalogue().filter(selfServePilot).map(t => t.id);
        expect(open).toContain('aio-yews');
        for (const id of ['aio-quest-runemysteries', 'army-quest-lostcity', 'army-hunt-black-dragons', 'army-splash-magic-66', 'quest-ikov', 'army-fletch-25']) expect(open).not.toContain(id);
    });
    test('a listed pilot ranks above the fallback and the fallback is worth a fraction', () => {
        const listed = plan(aioInputs([chopper()], ['aio-yews']))[0]!, fallback = run([chopper()], { pilotFallback: true })[0]!;
        expect(fallback.template?.id).toBe('aio-yews');
        expect(fallback.value).toBeCloseTo(listed.value * PILOT_FALLBACK_SHARE, 6);
    });
});

describe('continuous mainland supplies, strict 4-dose decanting, quest safety and specialist staging', () => {
    test('squad-vial-of-water uses ardy and new mainland supply chains cover nails, toads, planks, chocolate cake and dueling rings', () => {
        const supply = squadSupplies();
        const byId = new Map(supply.map(t => [t.id, t]));
        expect(byId.get('squad-vial-of-water')?.resources).toEqual(['shop:ardy']);
        expect(byId.get('squad-berserker-helm')?.resources).toEqual(['shop:skulgrimen']);
        expect(byId.get('squad-berserker-helm')?.needs).toMatchObject({ quests: ['The Fremennik Trials'], skills: { Hitpoints: 45 } });
        expect(byId.get('squad-smith-steel-nails')?.production).toMatchObject({ output: 'nail', outputPerUnit: 2, inputs: { 'steel bar': 1 } });
        expect(byId.get('squad-chocolate-cake')?.production).toMatchObject({ output: 'chocolate cake', inputs: { cake: 1, 'chocolate bar': 1 } });
        expect(byId.get('squad-strip-swamp-toad')?.production).toMatchObject({ output: "toad's leg", inputs: { 'swamp toad': 1 } });
        expect(byId.get('squad-ring-of-dueling')?.production).toMatchObject({ output: 'ring of dueling(8)', inputs: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 } });
        expect(byId.get('squad-barbarian-planks')?.script).toBe('scripts/chain.ts');
        expect(byId.get('squad-barbarian-planks')?.args).toContain('scripts/walk-to.ts 2552 3574');
        expect(byId.get('squad-white-berries')?.args).toContain('scripts/walk-to.ts 2262 3168');
        expect(byId.get('squad-gnome-toads')?.args).toContain('scripts/walk-to.ts 2417 3512');
    });

    test('strictOutput keeps 3-dose potions intact for squad trade unless a 4-dose-only demand exists, while partial 2-dose vials decant cleanly', () => {
        const decantOnly = catalogue().filter(t => t.id === 'squad-decant-prayer_restore' || t.id === 'squad-decant2-prayer_restore');
        const holder = acct('PotionMaker', { Herblore: 38 }, { 'prayer potion(3)': 6 });
        const squadOnly = plan(inputs([holder], {
            templates: decantOnly,
            bill: [],
            squad: { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] },
        }));
        expect(squadOnly[0]!.template).toBeUndefined();

        const forSpecialist = plan(inputs([holder], {
            templates: decantOnly,
            bill: [],
            specialists: ['hitpoints'],
        }));
        expect(forSpecialist[0]!.template?.id).toBe('squad-decant-prayer_restore');

        const twoDoseHolder = acct('HalfMaker', { Herblore: 38 }, { 'prayer potion(2)': 4 });
        const recoverPartial = plan(inputs([twoDoseHolder], {
            templates: decantOnly,
            bill: [],
            squad: { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] },
        }));
        expect(recoverPartial[0]!.template?.id).toBe('squad-decant2-prayer_restore');
    });

    test('Inputs.specialists drives mainland supply demand from free stock and excludes held specialist counts once gathered', () => {
        expect(Object.keys(SPECIALIST_STAGE_BILLS)).toEqual(expect.arrayContaining(['hitpoints', 'thieving-live', 'ranged-live', 'fletching-live']));
        const bare = acct('Supplier', { Cooking: 50 }, { coin: 10_000, cake: 10, 'chocolate bar': 10 });
        const needs = specialistStagingNeeds(inputs([bare], { bill: [], specialists: ['thieving-live'] }), [bare]);
        expect(needs).toEqual([
            { names: ['chocolate cake'], short: 27, consumer: 'specialist thieving-live: chocolate cake' },
            { names: ['ring of dueling(8)'], short: 1, consumer: 'specialist thieving-live: ring of dueling(8)' },
        ]);
        const cakeJob = plan(inputs([bare], { templates: catalogue().filter(t => t.id === 'squad-chocolate-cake'), bill: [], specialists: ['thieving-live'] }));
        expect(cakeJob[0]!.template?.id).toBe('squad-chocolate-cake');
        expect(cakeJob[0]!.template?.args).toContain('MAX_MAKE=10');

        const done = acct('Supplier', { Cooking: 50 }, { 'chocolate cake': 27, 'ring of dueling(8)': 1 });
        expect(specialistStagingNeeds(inputs([done], { bill: [], specialists: ['thieving-live'] }), [done])).toEqual([]);
        expect(plan(inputs([done], { templates: catalogue().filter(t => t.id === 'squad-chocolate-cake'), bill: [], specialists: ['thieving-live'] }))[0]!.template).toBeUndefined();
    });

    test('quest-crest stays excluded by default unless allowWilderness is enabled, and army-quest-fletch-30 trains unrestricted soldiers while restricted builds skip it', () => {
        const crestRow = QUEST_DEMAND_ROWS.find(r => r.slug === 'crest')!;
        const crestSoldier: Acct = {
            ...acct('CrestBot', { ...crestRow.skills, Attack: 99, Strength: 99, Defence: 99, Prayer: 99, Ranged: 99, Hitpoints: 99 }, {
                ...Object.fromEntries(Object.entries(crestRow.items).map(([i, n]) => [norm(i), n])),
                shark: crestRow.meals, coin: 50_000,
            }),
            quests: new Set(['lost city']),
        };
        const crestTemplates = catalogue().filter(t => t.id === 'quest-crest');
        expect(plan(inputs([crestSoldier], { templates: crestTemplates, army: new Set(['crestbot']), pilots: new Set(['quest-crest']), questsDone: new Set() }))[0]!.template).toBeUndefined();
        expect(plan(inputs([crestSoldier], { templates: crestTemplates, army: new Set(['crestbot']), pilots: new Set(['quest-crest']), questsDone: new Set(), allowWilderness: true }))[0]!.template?.id).toBe('quest-crest');

        const f30 = catalogue().find(t => t.id === 'army-quest-fletch-30')!;
        expect(f30.band).toBeLessThan(QUEST_DEMAND_BAND);
        expect(buildBand(f30, acct('Pure', { Fletching: 20 }), { Attack: 60, Strength: 99, Defence: 1 }, ['Lost City'])).toBeNull();
        expect(buildBand(f30, acct('Main', { Fletching: 20 }))?.id).toBe('army-quest-fletch-30');
    });

    test('Wave B/C supply pipelines cover poisoned arrows, Legends/Heroes guild shops, dragonstone glory chain, extra potions, and specialist mainland bills', () => {
        expect(SQUAD_WAVE_BC.winnerKit).toBe('tribrid-bis-zerk-tele-karam2');
        expect(SQUAD_WAVE_BC.optimalSquadRange).toEqual([8, 12]);
        expect(SQUAD_WAVE_BC.tripFood).toEqual({ shark: 12, 'cooked karambwan': 2 });
        expect(SQUAD_ESCAPE).toEqual({ 'law rune': 3, 'air rune': 15 });
        const budget10 = squadBurnBudget(10, 4);
        expect(budget10['shark']).toBe(1200);
        expect(budget10['cooked karambwan']).toBe(200);
        expect(budget10['rune arrow(p)']).toBe(6400);
        expect(squadBurnBudget(10, 4, { comboFood: false })['cooked karambwan']).toBeUndefined();
        expect(squadBurnBudget(8, 4)).toMatchObject({ shark: 960, 'cooked karambwan': 160 });
        expect(squadBurnBudget(12, 4)).toMatchObject({ shark: 1440, 'cooked karambwan': 240 });
        expect(squadTarget('cooked karambwan', 4)).toBe(60);

        expect(Object.keys(SQUAD_GEAR_ALIASES)).toEqual(expect.arrayContaining(['amulet of glory(4)', 'rune platebody', 'rune kiteshield', 'rune plateleg']));
        expect(squadHeld('amulet of glory(4)', { 'amulet of glory(2)': 2 })).toBe(2);
        expect(squadHeld('rune platebody', { 'dragon chainbody': 2 })).toBe(2);
        expect(squadHeld('rune kiteshield', { 'dragon sq shield': 2 })).toBe(2);
        expect(squadHeld('rune plateleg', { 'dragon plateleg': 2 })).toBe(2);
        expect(squadKeeps(4)['dragon chainbody']).toBe(2);
        expect(squadKeeps(4)['cape of legend']).toBe(2);

        const parsed = accountFrom('AliasTest', side, {
            bank: [
                { id: 985, count: 1, name: 'Half of a key' },
                { id: 987, count: 2, name: 'Half of a key' },
                { id: 1683, count: 3, name: 'Dragonstoneamulet' },
                { id: 1702, count: 4, name: 'Dragonstoneamulet' },
            ],
        }, () => undefined);
        expect(parsed.items.keyhalf1).toBe(1);
        expect(parsed.items.keyhalf2).toBe(2);
        expect(parsed.items['unstrung dragonstone amulet']).toBe(3);
        expect(parsed.items['strung dragonstone amulet']).toBe(4);

        const poisoner = acct('Poisoner', { Herblore: 1 }, { 'rune arrow': 50, 'weapon poison': 10 });
        const poisonPlan = plan(inputs([poisoner], {
            templates: catalogue().filter(t => t.id === 'squad-poison-rune-arrows'),
            bill: [],
            squad: { active: true, hours: 4, members: [{ name: 'Hunter', items: {} }] },
        }));
        expect(poisonPlan[0]!.template?.id).toBe('squad-poison-rune-arrows');
        expect(poisonPlan[0]!.template?.args).toContain('MAX_MAKE=50');

        const allIds = new Set(catalogue().map(t => t.id));
        for (const id of [
            'squad-poison-rune-arrows', 'squad-grind-chocolate', 'squad-combine-crystal-key',
            'squad-karamja-red-spiders-eggs', 'squad-super-restore', 'squad-magic-potion', 'squad-zamorak-potion',
            'squad-decant-super_restore', 'squad-decant2-magic_potion', 'squad-decant31-zamorak_potion', 'squad-decant-restore_potion',
            'squad-cut-dragonstone', 'squad-dragonstone-ring', 'squad-dragon-necklace', 'squad-dragonstone-amulet',
            'squad-string-dragonstone-amulet', 'squad-enchant-glory', 'squad-cape-of-legends',
            'squad-shield-right-half', 'squad-dragon-battleaxe', 'squad-dragon-mace',
            'shop-necklace-mould', 'shop-amulet-mould',
        ]) expect([id, allIds.has(id)]).toEqual([id, true]);

        expect(Object.keys(SPECIALIST_STAGE_BILLS)).toEqual(expect.arrayContaining(['cooking-live', 'woodcutting-live', 'firemaking-live', 'agility-live', 'haggis-mainland']));

        // Karamja Red spiders' eggs refuses level-3 skillers (Deadly red spiders combat 34) and admits HP>=23 or Prayer>=43.
        const eggTemplate = catalogue().filter(t => t.id === 'squad-karamja-red-spiders-eggs');
        const eggSquad: SquadInput = { active: true, hours: 4, members: [{ name: 'Hunter', items: { 'prayer potion(3)': 100 } }] };
        const eggBill = [row('super restore(3)', 20)];
        const frailEgg = acct('Skiller3', { Hitpoints: 10 }, { coin: 500, trout: 4 });
        expect(plan(inputs([frailEgg], { templates: eggTemplate, bill: eggBill, squad: eggSquad }))[0]!.template).toBeUndefined();
        const safeEgg = acct('PrayerOrHp', { Hitpoints: 23 }, { coin: 500, trout: 4 });
        expect(plan(inputs([safeEgg], { templates: eggTemplate, bill: eggBill, squad: eggSquad }))[0]!.template?.id).toBe('squad-karamja-red-spiders-eggs');
        const combatEgg = acct('Combat34', { Attack: 50, Strength: 50, Hitpoints: 10 }, { coin: 500, trout: 4 });
        expect(plan(inputs([combatEgg], { templates: eggTemplate, bill: eggBill, squad: eggSquad }))[0]!.template?.id).toBe('squad-karamja-red-spiders-eggs');
        const prayEgg = acct('Prayer43', { Hitpoints: 10, Prayer: 43 }, { coin: 500, trout: 4 });
        expect(plan(inputs([prayEgg], { templates: eggTemplate, bill: eggBill, squad: eggSquad }))[0]!.template?.id).toBe('squad-karamja-red-spiders-eggs');

        // Glory enchantment runs via aio-skiller bank-job with members: true and resized batch<=24.
        const gloryTemplate = catalogue().filter(t => t.id === 'squad-enchant-glory');
        const enchanter = acct('Enchanter', { Magic: 68 }, { 'strung dragonstone amulet': 3, 'cosmic rune': 10, 'earth rune': 100, 'water rune': 100 });
        const gloryPlan = plan(inputs([enchanter], { templates: gloryTemplate, bill: [row('amulet of glory', 10)], squad: eggSquad }))[0]!;
        expect(gloryPlan.template?.id).toBe('squad-enchant-glory');
        expect(gloryPlan.template?.script).toBe('scripts/aio-skiller.ts');
        expect(gloryPlan.template?.args?.[0]).toBe('bank-job');
        const decodedJob = JSON.parse(decodeURIComponent(gloryPlan.template!.args![1]!.slice('--job='.length)));
        expect(decodedJob).toMatchObject({ family: 'magic', recipe: 'enchant:strung_dragonstone_amulet', target: 3, batch: 3, members: true, bank: { x: 3092, z: 3243, level: 0 }, site: { x: 3092, z: 3243, level: 0 } });

        // Mainland Shilo/Tai Bwo Wannai karambwan chain enforces Prayer 43 + returnTicks >= 400 + walkable shore sites,
        // separates bait vs karambwan resource concurrency, and reacquires a karambwan vessel from Tiadeche when absent.
        const kQuests = new Set(['shilo village', 'tai bwo wannai trio']);
        const kSquad: SquadInput = { active: true, hours: 4, members: [{ name: 'Hunter', items: { shark: 355 } }] };
        const kTemplates = catalogue().filter(t => ['squad-karambwanji-fish', 'squad-karambwan-fish', 'squad-karambwan-vessel', 'squad-karambwan-cook'].includes(t.id));
        const noPrayer: Acct = { ...acct('NoPray', { Fishing: 99, Cooking: 99, Prayer: 1 }, { 'small fishing net': 1, 'karambwan vessel': 1, 'raw karambwanji': 75 }), quests: kQuests };
        expect(plan(inputs([noPrayer], { templates: kTemplates, bill: [], squad: kSquad }))[0]!.template).toBeUndefined();

        const fisher: Acct = { ...acct('Fisher', { Fishing: 99, Cooking: 99, Prayer: 43 }, { 'small fishing net': 1 }), quests: kQuests, pos: { x: 2852, z: 2955, level: 0 } };
        const baitPlan = plan(inputs([fisher], { templates: kTemplates, bill: [], squad: kSquad }))[0]!;
        expect(baitPlan.template?.id).toBe('squad-karambwanji-fish');
        const baitJob = JSON.parse(decodeURIComponent(baitPlan.template!.args![1]!.slice('--job='.length)));
        expect(baitJob).toMatchObject({ family: 'fishing', recipe: 'karambwanji', target: 100, batch: 25, returnTicks: 600, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2806, z: 3009, level: 0 } });

        const needVessel: Acct = { ...acct('VesselBuyer', { Fishing: 99, Prayer: 43 }, { 'small fishing net': 1, 'raw karambwanji': 30, coin: 1000 }), quests: kQuests, pos: { x: 2654, z: 3283, level: 0 } };
        expect(plan(inputs([needVessel], { templates: kTemplates, bill: [], squad: kSquad, prices: { ...prices, 'raw karambwan': 200, 'raw karambwanji': 10 } }))[0]!.template?.id).toBe('squad-karambwan-vessel');

        const catcher: Acct = { ...acct('Catcher', { Fishing: 99, Prayer: 43 }, { 'karambwan vessel': 1, 'raw karambwanji': 30 }), quests: kQuests, pos: { x: 2852, z: 2955, level: 0 } };
        const fishPlan = plan(inputs([catcher], { templates: kTemplates, bill: [], squad: kSquad }))[0]!;
        expect(fishPlan.template?.id).toBe('squad-karambwan-fish');
        const fishJob = JSON.parse(decodeURIComponent(fishPlan.template!.args![1]!.slice('--job='.length)));
        expect(fishJob).toMatchObject({ family: 'fishing', recipe: 'karambwan', target: 10, batch: 9, returnTicks: 600, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3118, level: 0 } });

        const cooker: Acct = { ...acct('Cooker', { Cooking: 99 }, { 'raw karambwan': 56 }), quests: kQuests, pos: { x: 2809, z: 3441, level: 0 } };
        const cookPlan = plan(inputs([cooker], { templates: kTemplates, bill: [], squad: kSquad }))[0]!;
        expect(cookPlan.template?.id).toBe('squad-karambwan-cook');
        const cookJob = JSON.parse(decodeURIComponent(cookPlan.template!.args![1]!.slice('--job='.length)));
        expect(cookJob).toMatchObject({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: 56, batch: 28 });

        expect(CAPACITY['squad:shilo-karambwanji']).toBe(2);
        expect(CAPACITY['squad:shilo-karambwan']).toBe(2);
        expect(CAPACITY['squad:catherby-cooking']).toBe(2);
    });
});
