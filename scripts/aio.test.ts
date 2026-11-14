import {describe,test,expect} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {claimOrderJournal,settleOrderJournal} from '../packages/core/src/order-journal';
import {defaultEatAt,questFoodDefinitions,selectQuestFood,expandFoodStages,totalAvailableHeal} from '../packages/core/src/sustain';
import {bankTravelTolerance,fittingBankBatch,validateBankRouteJob,planBankTripSchedule} from '../packages/core/src/bank-trip';
import {capabilityRevision,type ReleaseMemo} from '../packages/core/src/worker-release';
import {
 AIO_CATEGORIES,aioCatalog,resolveAioStep,planAioPipeline,toSwarmChainJob,recommendNextAioJob,
 planProgressiveSkiller,discoverBankedProduction,planAutoFighterBand,assessBossReadiness,
 pvpCombatBracket,assessTribridReadiness,assessQuestReadiness,prioritizeQuestsForAccount,
 planGeRestockOrders,planFleetDistribution,
} from './aio';
import {SKILLER_ROUTES,resolveSkillerStep,smeltRecipe,smithRecipe,planHeadless,LOGS,COURSES,RUNE_ALTARS,BONE_XP} from './aio-skiller';
import {FIGHTER_PROFILES,resolveFighterStep,cowProfile,chickenTrainingProfile,qolDropSelection} from './aio-fighter';
import {BOSS_ENCOUNTERS,resolveBossStep,KBD_KIT,BLUE_KIT} from './aio-boss';
import {PVP_MODES,resolvePvpStep,TRIBRID_KIT,HUNT_SPOTS,wildernessLevel} from './aio-pvp';
import {QUESTER_MODES,listGeneratedQuestScripts,resolveQuesterStep,resolveQuestScript,QUEST_ORDERS} from './aio-quester';
import {MARKET_MODES,resolveMarketStep,SHOP_PROFILES,orderQuantity} from './aio-market';
import {LOGISTICS_ROLES,resolveLogisticsStep,ARDY_BANK,DRAYNOR_BANK} from './aio-logistics';

const root = resolve(import.meta.dir, '..');

describe('Step 1: Shared Core Primitives (order-journal, sustain, bank-trip)', () => {
 test('order-journal claims once, rejects duplicate/uncertain keys, and settles cleanly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'order-journal-'));
  try {
   const path = claimOrderJournal(dir, 'Moneyshot', 'order-1', { target: 25 }, 1000, 'test order');
   expect(() => claimOrderJournal(dir, 'Moneyshot', 'order-1', { target: 25 }, 1001, 'test order')).toThrow('has uncertain output (started); no retry');
   settleOrderJournal(path, { ok: true, count: 25 }, r => ({ count: r.count }), 2000, 'test order');
   expect(() => claimOrderJournal(dir, 'Moneyshot', 'order-1', { target: 25 }, 2001, 'test order')).toThrow('already completed; duplicate refused');
  } finally {
   rmSync(dir, { recursive: true, force: true });
  }
 });

 test('sustain loads pinned food definitions and multi-stage cakes and selects optimal heal', () => {
  expect(defaultEatAt(10)).toBe(10);
  expect(defaultEatAt(50)).toBe(30);
  expect(defaultEatAt(99)).toBe(40);
  const defs = questFoodDefinitions();
  expect(defs.get(385)?.heal).toBeGreaterThan(0); // Shark
  expect(defs.get(1891)?.next).toBe(1893); // Cake -> 2/3 cake
  const state = {
   skills: [{ name: 'Hitpoints', level: 20, baseLevel: 40 }],
   inventory: [
    { id: 1893, slot: 0, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
    { id: 385, slot: 1, count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 1 }] },
   ],
  };
  const choice = selectQuestFood(state, { food: [1891, 385], eatAt: 25 });
  expect(choice?.item.id).toBe(1893);
 });

 test('bank-trip validates route jobs and computes fitting batch sizes', () => {
  expect(bankTravelTolerance('cooking', true)).toBe(0);
  expect(bankTravelTolerance('mining', true)).toBe(2);
  expect(() => validateBankRouteJob({
   family: 'cooking', recipe: 'shark', target: 25, batch: 25, cap: 5000, returnTicks: 300, members: true,
  })).not.toThrow();
  expect(fittingBankBatch({ 436: 1, 438: 1 }, [], 28, 28, () => false, { 2349: 1 })).toBe(14);
 });
});

describe('Step 2 & 3: 7 All-In-One Bot Engines & Unified Dispatcher', () => {
 test('every registered script across all 7 AIO engines exists on disk', () => {
  const catalog = aioCatalog();
  expect(catalog.totals.categories).toBe(7);
  expect(catalog.totals.questScripts).toBeGreaterThanOrEqual(68);

  for (const r of SKILLER_ROUTES) expect(existsSync(join(root, r.script))).toBe(true);
  for (const p of FIGHTER_PROFILES) expect(existsSync(join(root, p.script))).toBe(true);
  for (const b of BOSS_ENCOUNTERS) expect(existsSync(join(root, b.script))).toBe(true);
  for (const m of PVP_MODES) expect(existsSync(join(root, m.script))).toBe(true);
  for (const q of QUESTER_MODES) expect(existsSync(join(root, q.script))).toBe(true);
  for (const q of listGeneratedQuestScripts(root)) expect(existsSync(join(root, q))).toBe(true);
  for (const m of MARKET_MODES) expect(existsSync(join(root, m.script))).toBe(true);
  for (const l of LOGISTICS_ROLES) expect(existsSync(join(root, l.script))).toBe(true);
 });

 test('step resolution maps declarative domain inputs to concrete worker steps and env', () => {
  expect(resolveSkillerStep('fishing', 'shark', ['25', '9000', 'SHARK_CONSUMER=pk'])).toEqual({
   script: 'scripts/shark-supply.ts',
   args: ['25', '9000'],
   env: { SHARK_CONSUMER: 'pk' },
  });
  expect(resolveSkillerStep('thieving', 'knights', ['KNIGHT_SPOT=2652,3318'])).toEqual({
   script: 'scripts/goldfarm.ts',
   args: [],
   env: { KNIGHT_SPOT: '2652,3318' },
  });
  expect(resolveFighterStep('cow', ['MAX_KILLS=5'])).toEqual({
   script: 'scripts/gather-combat.ts',
   args: [],
   env: { TARGET: 'cow', CAP: '3000', TRAIN_SKILL: 'Defence', TARGET_LEVEL: '40', MAX_KILLS: '5' },
  });
  expect(resolveBossStep('kbd', ['500'])).toEqual({
   script: 'scripts/microbot-b-kbd.ts',
   args: [],
   env: {CAP: '500'},
  });
  expect(resolvePvpStep('pilot')).toEqual({
   script: 'scripts/pk-live/live-pilot.ts',
   args: ['10', '20'],
   env: {},
  });
  expect(resolveQuesterStep('waterfall')).toEqual({
   script: 'scripts/generated/waterfall.ts',
   args: [],
   env: {},
  });
  expect(resolveQuestScript('romeojuliet')).toBe('scripts/generated/quest-rj.ts');
  expect(resolveMarketStep('ge-buy', ['ITEM_ID=385', 'QUANTITY=20'])).toEqual({
   script: 'scripts/buy-owned-ge-item.ts',
   args: [],
   env: { ITEM_ID: '385', QUANTITY: '20' },
  });
  expect(resolveLogisticsStep('coin-courier', ['25000'])).toEqual({
   script: 'scripts/coin-courier.ts',
   args: ['25000'],
   env: {},
  });
  expect(resolveAioStep('skiller', ['woodcutting', 'edgeville', 'TARGET_LEVEL=60'])).toEqual({
   script: 'scripts/edgeville-woodcut-order.ts',
   args: [],
   env: { TARGET_LEVEL: '60' },
  });
 });

 test('mined domain helpers, recipes, and tables are directly exported from the 7 AIO modules', () => {
  expect(smeltRecipe('bronze').product).toBe(2349);
  expect(smithRecipe(1205).bar).toBe(2349); // Bronze dagger
  expect(planHeadless(500, 500, 150, 200, 100)).toBe(150);
  expect(LOGS.oak.level).toBe(15);
  expect(COURSES.gnome.steps.length).toBe(7);
  expect(RUNE_ALTARS.length).toBe(6);
  expect(BONE_XP[532]).toBe(375);
  expect(cowProfile('north', 'banked', 9).limit).toBe(9);
  expect(chickenTrainingProfile('draynor').bank).toBe('draynor');
  expect(qolDropSelection([{ id: 1511, name: 'Logs', slot: 0, count: 1 }], { ids: [1511], names: [], mode: 'listed', order: 'slot', maximumDrops: 5, cap: 50 }).length).toBe(1);
  expect(KBD_KIT.length).toBeGreaterThan(5);
  expect(BLUE_KIT.length).toBeGreaterThan(5);
  expect(TRIBRID_KIT.magic?.length).toBeGreaterThan(0);
  expect(HUNT_SPOTS.length).toBeGreaterThan(0);
  expect(wildernessLevel(3528)).toBe(2);
  expect(Object.keys(QUEST_ORDERS)).toEqual(expect.arrayContaining(['hetty', 'cook']));
  expect(Object.keys(SHOP_PROFILES)).toEqual(expect.arrayContaining(['catherby', 'sarim', 'ardy']));
  expect(orderQuantity({ actor: 'a', server: 's', goal: 'g', item: 385, quantity: 20, limit: 1000, reserve: 100, createdAt: 1, reviewAt: 2, deadline: 3 })).toBe(20);
  expect(ARDY_BANK).toEqual({ x: 2654, z: 3283 });
  expect(DRAYNOR_BANK).toEqual({ x: 3092, z: 3243 });
 });

 test('smart AIO planners: progressive skilling bands, auto-fighter bands, boss/PvP/quest readiness, GE restock & fleet distribution', () => {
  // Sustain stage cache & total heal math
  expect([...expandFoodStages([1891])]).toEqual([1891, 1893, 1895]);
  expect(totalAvailableHeal([{ id: 1891, count: 2 }, { id: 385, count: 1 }], [1891, 385], { 1891: 1 })).toBe(12 + 20);

  // Bank trip schedule pre-flight
  const sched = planBankTripSchedule({
   target: 50,
   inputs: { 436: 1, 438: 1 },
   tools: [],
   outputs: { 2349: 1 },
   bankStock: { 436: 40, 438: 60 },
   reserve: 5,
  });
  expect(sched.perTrip).toBe(14);
  expect(sched.tripsNeeded).toBe(4);
  expect(sched.feasibleUnits).toBe(35);
  expect(sched.shortfalls).toEqual({ 436: 15 });
  expect(sched.ready).toBe(false);

  // Progressive skiller banding (Firemaking 1 -> 60 spans normal -> oak -> willow -> maple)
  const fmBands = planProgressiveSkiller('firemaking', 1, 60);
  expect(fmBands.map(b => [b.fromLevel, b.toLevel, b.step.env.LOG])).toEqual([
   [1, 15, 'normal'],
   [15, 30, 'oak'],
   [30, 45, 'willow'],
   [45, 60, 'maple'],
  ]);

  // Auto-fighter band selector (staged cows -> troopers)
  expect(planAutoFighterBand({ Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10 }).target).toBe('cow');
  expect(planAutoFighterBand({ Attack: 20, Strength: 20, Defence: 20, Hitpoints: 25 }).target).toBe('cow');
  expect(planAutoFighterBand({ Attack: 40, Strength: 40, Defence: 40, Hitpoints: 42 }).target).toBe('cow');

  // Boss readiness check (KBD & Trawler)
  const kbdCheck = assessBossReadiness('kbd', { skills: { Attack: 60, Defence: 40 }, ownedItems: {} });
  expect(kbdCheck.ready).toBe(false);
  expect(Object.keys(kbdCheck.missingItems).length).toBeGreaterThan(0);

  // PvP combat bracket & tribrid readiness
  const bracket = pvpCombatBracket({ Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Ranged: 99, Magic: 99 }, 20);
  expect(bracket.combatLevel).toBe(126);
  expect(bracket.minTargetCombat).toBe(106);
  expect(bracket.maxTargetCombat).toBe(126);
  expect(assessTribridReadiness({}).ready).toBe(false);

  // Quest readiness check (Cook's Assistant needs Egg 1944, Milk 1927, Flour 1933)
  const cookMissing = assessQuestReadiness('cook', { 1944: 1 });
  expect(cookMissing.ready).toBe(false);
  expect(cookMissing.missingItems).toEqual({ 1927: 1, 1933: 1 });
  expect(assessQuestReadiness('cook', { 1944: 1, 1927: 1, 1933: 1 }).ready).toBe(true);

  // GE restock planner
  const gePlan = planGeRestockOrders({
   actor: 'OreElse',
   server: 'rs-sdk-demo.fly.dev',
   goalPrefix: 'pvp-restock',
   shortfalls: {
    385: { quantity: 20, limitPrice: 1200 },
    1333: { quantity: 1, limitPrice: 30000 },
   },
   coinsAvailable: 30000,
   coinReserve: 1000,
  });
  expect(gePlan.funded.map(f => f.item)).toEqual([385]);
  expect(gePlan.unfunded).toEqual([1333]);
  expect(gePlan.totalEscrow).toBe(24000);

  // Fleet distribution planner
  const dist = planFleetDistribution(
   [{ account: 'Moneyshot', held: 100000, reserve: 10000 }],
   [{ account: 'OreElse', held: 5000, target: 45000 }, { account: 'Shaftmaker', held: 0, target: 60000 }],
  );
  expect(dist.transfers).toEqual([
   { from: 'Moneyshot', to: 'Shaftmaker', amount: 60000 },
   { from: 'Moneyshot', to: 'OreElse', amount: 30000 },
  ]);
  expect(dist.unmet).toEqual([{ account: 'OreElse', shortfall: 10000 }]);

  // Multi-step AIO pipeline compiler
  const pipeline = planAioPipeline([
   'market:shop-buy harry 600 MAX_ITEMS=1 MAX_SPEND=500',
   'skiller:fishing cage 3000',
   'skiller:cooking food 1500 lobster',
  ]);
  expect(pipeline.map(s => s.script)).toEqual([
   'scripts/shop-buyer.ts',
   'scripts/gather-fish.ts',
   'scripts/cook-food.ts',
  ]);

  // Swarm chain job generator
  const chainJob = toSwarmChainJob('FishAndChips', 'supply', 'Cooked lobsters', pipeline);
  expect(chainJob.script).toBe('scripts/chain.ts');
  expect(chainJob.args.length).toBe(3);

  // Quest prioritizer & autonomous account router
  const prioritized = prioritizeQuestsForAccount({ 1944: 1, 1927: 1, 1933: 1 }, new Set(), ['cook', 'hetty']);
  expect(prioritized.readyNow.map(q => q.slug)).toEqual(['cook']);
  expect(prioritized.needsItems.map(q => q.slug)).toEqual(['hetty']);

  expect(recommendNextAioJob({ name: 'Fresh', skills: { Thieving: 1 }, ownedItems: {} }, 'goldfarm').step?.script).toBe('scripts/generated/thieving60.ts');
  expect(recommendNextAioJob({ name: 'Knight', skills: { Thieving: 60 }, ownedItems: { 379: 25 } }, 'goldfarm').step?.script).toBe('scripts/goldfarm.ts');
  expect(recommendNextAioJob({ name: 'Trainee', skills: { Attack: 20, Strength: 20, Defence: 20, Hitpoints: 25 }, ownedItems: {} }, 'pk-tribrid').step?.script).toBe('scripts/gather-combat.ts');
  expect(recommendNextAioJob({ name: 'Quester', skills: {}, ownedItems: { 1944: 1, 1927: 1, 1933: 1 } }, 'quest-sweep').step?.script).toBe('scripts/quest-sweep.ts');
  expect(recommendNextAioJob({
   name: 'AllRounder',
   skills: {
    Attack: 50, Strength: 50, Defence: 50, Hitpoints: 50, Ranged: 50, Prayer: 50, Magic: 50,
    Cooking: 50, Woodcutting: 50, Fletching: 50, Fishing: 50, Firemaking: 10,
    Crafting: 50, Smithing: 50, Mining: 50, Herblore: 50, Agility: 50, Thieving: 50, Runecraft: 50,
   },
   ownedItems: {},
  }, 'max-overall').step?.script).toBe('scripts/firemaking-order.ts');
  // Banked production scanner across all 230+ artisan recipes
  const banked = discoverBankedProduction(
   { Cooking: 80, Crafting: 50, Fletching: 60, Smithing: 40 },
   { 383: 25, 2357: 10, 1607: 10, 1592: 1, 436: 15, 438: 15 },
   { reserve: 5 },
  );
  expect(banked.map(b => [b.family, b.recipe, b.feasibleUnits])).toEqual(expect.arrayContaining([
   ['cooking', 'cooking_generic_shark', 20],
   ['jewellery', 'sapphire_ring', 5],
   ['smelting', 'bronze', 10],
  ]));
 });

 test('all 7 AIO entry points and master aio.ts pass capabilityRevision release checks', () => {
  const memo: ReleaseMemo = new Map();
  const entries = [
   'scripts/aio.ts',
   ...AIO_CATEGORIES.map(c => `scripts/aio-${c}.ts`),
  ];
  for (const entry of entries) {
   expect(capabilityRevision([entry], root, memo)).toMatch(/^[a-f0-9]{64}$/);
  }
 }, 30_000);
});

import {aioRouteKeys,benchCases,benchCoverage} from './measure/aio-bench-cases';
import {PRESETS} from '../packages/practice/src/presets';

test('every AIO bench case names a catalog route once and a real preset', () => {
 const routes = new Set(aioRouteKeys()), cases = benchCases(), keys = cases.map(c => c.key);
 expect(new Set(keys).size).toBe(keys.length);
 expect(routes.size).toBe(aioRouteKeys().length);
 for (const c of cases) {
  if (!c.key.startsWith('extra:')) expect(routes.has(c.key)).toBe(true);
  expect(c.presetConfig ?? PRESETS[c.preset]).toBeDefined();
 }
 const coverage = benchCoverage();
 // Every route is in one group: it has a case, it is blocked with a cause, its case is marked known, or it has none.
 const knownRoutes = Object.keys(coverage.known).filter(k => routes.has(k) && !cases.some(c => c.key === k && !c.known));
 expect(coverage.covered + coverage.gaps.length + Object.keys(coverage.blocked).length + knownRoutes.length).toBe(coverage.routes);
});

test('every AIO route points at a script that exists and can be started from a command line', () => {
 const root = resolve(import.meta.dir, '..');
 const c = aioCatalog().categories;
 const scripts = [...c.skiller.routes, ...c.fighter.profiles, ...c.boss.encounters, ...c.pvp.modes, ...c.quester.modes, ...c.market.modes, ...c.logistics.roles].map(r => r.script);
 const unstartable = [...new Set(scripts)].filter(script => !existsSync(join(root, script)) || !/import\.meta\.main|process\.argv|runScript\(|^const \w+ = await openQuest\(/m.test(readFileSync(join(root, script), 'utf8')));
 expect(unstartable).toEqual([]);
});

test('every AIO route has a bench case, a cause that blocks one, or a recorded failure', () => {
 expect(benchCoverage().gaps).toEqual([]);
});
