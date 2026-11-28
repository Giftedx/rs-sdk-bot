// Master All-In-One Bot Suite ("Vortex / Sythe Premium Plugin Taxonomy"):
// Single unified entry point and catalog across all 7 reusable bot categories:
//   1. skiller   ("Vortex All In One" — 15 skills, gathering, artisan, runecraft, thieving, agility)
//   2. fighter   ("Auto Fighter"      — general monster combat, melee/ranged training, combat/drop farming)
//   3. boss      ("PvM Helper"        — King Black Dragon, Taverley Blue Dragons, Fishing Trawler)
//   4. pvp       ("PK Fighter"        — 1v1 tribrid switches, Wilderness hunt/roam, kit staging, Lava Maze escort)
//   5. quester   ("Quest Helper"      — all 68 quests, bank-staged quest sweep, quest chains, clue scrolls)
//   6. market    ("MK Auto Buyer/GE"  — NPC shop buyer/seller, Grand Exchange single & bulk orders)
//   7. logistics ("RC Runners/Mules"  — couriers, essence runners, bank loadouts, global auto-walker)
//
// Usage:
//   bun scripts/aio.ts --list
//   bun scripts/aio.ts <category> <account> <method|target|mode|quest|role> [args...] [KEY=value...]
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {isStopFilePresent} from '../packages/workers/src/stop';
import {runChild,runDirectChild} from '../packages/core/src/run-child';
import {formatStep,tokenizeStep,runChainSteps,type Step} from '../packages/core/src/chain-step';

const require = createRequire(import.meta.url);
type SkillerMod = typeof import('./aio-skiller');
type FighterMod = typeof import('./aio-fighter');
type BossMod = typeof import('./aio-boss');
type PvpMod = typeof import('./aio-pvp');
type QuesterMod = typeof import('./aio-quester');
type MarketMod = typeof import('./aio-market');
type LogisticsMod = typeof import('./aio-logistics');

let skillerMod: SkillerMod | undefined;
let fighterMod: FighterMod | undefined;
let bossMod: BossMod | undefined;
let pvpMod: PvpMod | undefined;
let questerMod: QuesterMod | undefined;
let marketMod: MarketMod | undefined;
let logisticsMod: LogisticsMod | undefined;

const getSkiller = () => (skillerMod ??= require('./aio-skiller') as SkillerMod);
const getFighter = () => (fighterMod ??= require('./aio-fighter') as FighterMod);
const getBoss = () => (bossMod ??= require('./aio-boss') as BossMod);
const getPvp = () => (pvpMod ??= require('./aio-pvp') as PvpMod);
const getQuester = () => (questerMod ??= require('./aio-quester') as QuesterMod);
const getMarket = () => (marketMod ??= require('./aio-market') as MarketMod);
const getLogistics = () => (logisticsMod ??= require('./aio-logistics') as LogisticsMod);

export const planProgressiveSkiller: SkillerMod['planProgressiveSkiller'] = (...a) => getSkiller().planProgressiveSkiller(...a);
export const discoverBankedProduction: SkillerMod['discoverBankedProduction'] = (...a) => getSkiller().discoverBankedProduction(...a);
export const planAutoFighterBand: FighterMod['planAutoFighterBand'] = (...a) => getFighter().planAutoFighterBand(...a);
export const assessBossReadiness: BossMod['assessBossReadiness'] = (...a) => getBoss().assessBossReadiness(...a);
export const pvpCombatBracket: PvpMod['pvpCombatBracket'] = (...a) => getPvp().pvpCombatBracket(...a);
export const assessTribridReadiness: PvpMod['assessTribridReadiness'] = (...a) => getPvp().assessTribridReadiness(...a);
export const assessQuestReadiness: QuesterMod['assessQuestReadiness'] = (...a) => getQuester().assessQuestReadiness(...a);
export const prioritizeQuestsForAccount: QuesterMod['prioritizeQuestsForAccount'] = (...a) => getQuester().prioritizeQuestsForAccount(...a);
export const planGeRestockOrders: MarketMod['planGeRestockOrders'] = (...a) => getMarket().planGeRestockOrders(...a);
export const planFleetDistribution: LogisticsMod['planFleetDistribution'] = (...a) => getLogistics().planFleetDistribution(...a);

export type AioCategory = 'skiller' | 'fighter' | 'boss' | 'pvp' | 'quester' | 'market' | 'logistics';

export const AIO_CATEGORIES: readonly AioCategory[] = [
 'skiller',
 'fighter',
 'boss',
 'pvp',
 'quester',
 'market',
 'logistics',
];

export function aioCatalog() {
 const sk = getSkiller(), fi = getFighter(), bo = getBoss(), pv = getPvp(), qu = getQuester(), mk = getMarket(), lo = getLogistics();
 const quests = qu.listGeneratedQuestScripts();
 return {
  categories: {
   skiller: {
    pluginName: 'Vortex All In One (Skiller)',
    entry: 'scripts/aio-skiller.ts',
    summary: sk.skillerCatalogSummary(),
    routes: sk.SKILLER_ROUTES,
   },
   fighter: {
    pluginName: 'Auto Fighter (Combat & Drops)',
    entry: 'scripts/aio-fighter.ts',
    profiles: fi.FIGHTER_PROFILES,
   },
   boss: {
    pluginName: 'PvM Helper (Bosses & Minigames)',
    entry: 'scripts/aio-boss.ts',
    encounters: bo.BOSS_ENCOUNTERS,
   },
   pvp: {
    pluginName: 'PK Fighter (Wilderness PvP & Tribrid)',
    entry: 'scripts/aio-pvp.ts',
    modes: pv.PVP_MODES,
   },
   quester: {
    pluginName: 'Quest Helper & Clue Solver',
    entry: 'scripts/aio-quester.ts',
    modes: qu.QUESTER_MODES,
    questScriptsCount: quests.length,
    questScripts: quests,
   },
   market: {
    pluginName: 'MK Auto Buyer & GE Trader',
    entry: 'scripts/aio-market.ts',
    modes: mk.MARKET_MODES,
   },
   logistics: {
    pluginName: 'RC Runners, Loadouts & Fleet Mules',
    entry: 'scripts/aio-logistics.ts',
    roles: lo.LOGISTICS_ROLES,
   },
  },
  totals: {
   categories: AIO_CATEGORIES.length,
   skillerRoutes: sk.SKILLER_ROUTES.length,
   fighterProfiles: fi.FIGHTER_PROFILES.length,
   bossEncounters: bo.BOSS_ENCOUNTERS.length,
   pvpModes: pv.PVP_MODES.length,
   questerModes: qu.QUESTER_MODES.length,
   questScripts: quests.length,
   marketModes: mk.MARKET_MODES.length,
   logisticsRoles: lo.LOGISTICS_ROLES.length,
  },
 };
}

export function resolveAioStep(categoryInput: string, args: readonly string[]): Step {
 const category = categoryInput.toLowerCase().replace(/^--category=/, '') as AioCategory;
 const [first, ...rest] = args;
 if (!first) throw Error(`aio: category "${category}" requires a target/method argument`);
 switch (category) {
  case 'skiller': return getSkiller().resolveSkillerStep(first, rest[0], rest.slice(1));
  case 'fighter': return getFighter().resolveFighterStep(first, rest);
  case 'boss': return getBoss().resolveBossStep(first, rest);
  case 'pvp': return getPvp().resolvePvpStep(first, rest);
  case 'quester': return getQuester().resolveQuesterStep(first, rest);
  case 'market': return getMarket().resolveMarketStep(first, rest);
  case 'logistics': return getLogistics().resolveLogisticsStep(first, rest);
  default:
   throw Error(`aio: unknown category "${categoryInput}"; known: ${AIO_CATEGORIES.join(', ')}`);
 }
}

// Compile a sequence of declarative AIO specs (e.g. ["market:ge-buy ITEM_ID=385 QUANTITY=20", "pvp:pilot 10 20"])
// into verified Step[] compatible with chain.ts, host.ts, and workerEntries release hashing.
export function planAioPipeline(specs: readonly string[]): Step[] {
 if (!specs.length) throw Error('aio pipeline requires at least one step spec');
 return specs.map(raw => {
  const tokens = tokenizeStep(raw);
  const head = tokens[0];
  if (!head) throw Error('aio pipeline step requires a category and route');
  if (head.includes(':')) {
   const [cat, ...route] = head.split(':');
   if (cat === 'quester' && route[0] === 'mode') route.shift();
   return resolveAioStep(cat!, [...route, ...tokens.slice(1)]);
  }
  return resolveAioStep(head, tokens.slice(1));
 });
}

// Convert an AIO pipeline into a swarm.json / coordinator-compatible job record (single script or scripts/chain.ts).
export function toSwarmChainJob(account: string, role: string, goal: string, steps: readonly Step[], standing = true) {
 if (!steps.length) throw Error('toSwarmChainJob requires at least one step');
 if (steps.length === 1) {
  const s = steps[0]!;
  return {
   account,
   role,
   goal,
   script: s.script,
   args: [...s.args],
   ...(Object.keys(s.env).length ? { env: { ...s.env } } : {}),
   enabled: true,
   repeat: false,
   standing,
   maxRestarts: 0,
  };
 }
 return {
  account,
  role,
  goal,
  script: 'scripts/chain.ts',
  args: steps.map(formatStep),
  env: { ROUNDS: '1' },
  enabled: true,
  repeat: false,
  standing,
  maxRestarts: 0,
 };
}

export type AccountRecommendationGoal = 'pk-tribrid' | 'goldfarm' | 'quest-sweep' | 'max-overall';
export type AioRecommendation = {
 category: AioCategory | null;
 reason: string;
 step: Step | null;
 status?: 'complete' | 'blocked';
};

// Deterministic account state router: given an account's observed skills, items (bank + pack + equipment), and completed quests,
// returns the next route or an explicit blocked/completed outcome. Workers validate location, stock and access at entry.
function recommendAuthoredAioJob(
 account: {
  name: string;
  skills: Readonly<Record<string, number>>;
  ownedItems: Readonly<Record<number, number>>;
  completedQuests?: ReadonlySet<string>;
 },
 goal: AccountRecommendationGoal,
): AioRecommendation {
 const s = account.skills;
 if (Object.entries(s).some(([, level]) => !Number.isSafeInteger(level) || level < 1 || level > 99))
  return {category: null, step: null, status: 'blocked', reason: 'Account skill observations must be integer base levels from 1 to 99'};
 if (goal === 'goldfarm') {
  const thieving = s.Thieving ?? 1;
  if (thieving < 55) {
   return {
    category: 'skiller',
    reason: `Thieving ${thieving}/55; bootstrap to 55 before Ardougne knights`,
    step: getSkiller().resolveSkillerStep('thieving', 'bootstrap55', ['TARGET=55', 'CAP=3000']),
   };
  }
  // The banked fish and bakery food accepted by goldfarm.ts FOOD_ORDER.
  const foodCount = [329, 333, 379, 385, 1891, 1893, 1895, 1901, 2309].reduce((sum, id) => sum + (account.ownedItems[id] ?? 0), 0);
  if (foodCount < 10) {
   const cooking = s.Cooking ?? 1;
   const raw = [
    {id: 377, kind: 'lobster', level: 40}, {id: 383, kind: 'shark', level: 80},
    {id: 335, kind: 'trout', level: 15}, {id: 331, kind: 'salmon', level: 25},
   ].find(fish => cooking >= fish.level && (account.ownedItems[fish.id] ?? 0) > 0);
   if (raw) return {
    category: 'skiller', reason: `Food stock low (${foodCount}); cook owned ${raw.kind} before knight pickpocketing`,
    step: getSkiller().resolveSkillerStep('cooking', 'food', ['2000', raw.kind]),
   };
   if ((s.Fishing ?? 1) < 40 || cooking < 40) return {
    category: null, status: 'blocked', step: null,
    reason: 'Knight training needs food supplied or Fishing 40 and Cooking 40 to acquire cooked lobsters',
   };
   if ((account.ownedItems[301] ?? 0) < 1) return {
    category: null, status: 'blocked', step: null, reason: 'Lobster fishing needs an owned lobster pot (301)',
   };
   return {
    category: 'skiller',
    reason: `Food stock low (${foodCount}); fish lobsters for the cooking step`,
    step: getSkiller().resolveSkillerStep('fishing', 'cage', ['cage', '3000']),
   };
  }
  return {
   category: 'skiller',
   reason: `Thieving ${thieving} ready with food stock (${foodCount}); pickpocket Ardougne knights`,
   step: getSkiller().resolveSkillerStep('thieving', 'knights'),
  };
 }
 if (goal === 'pk-tribrid') {
  const atk = s.Attack ?? 1, str = s.Strength ?? 1, def = s.Defence ?? 1, hp = s.Hitpoints ?? 10;
  if (Math.min(atk, str, def) < 99) {
   const band = planAutoFighterBand({ Attack: atk, Strength: str, Defence: def, Hitpoints: hp });
   return {
    category: 'fighter',
    reason: `Maxed tribrid needs melee 99 (${atk}/${str}/${def}); train ${band.trainSkill} to ${band.targetLevel} on ${band.target}`,
    step: band.step,
   };
  }
  if ((s.Ranged ?? 1) < 99) return {
   category: 'fighter', reason: `Maxed tribrid needs Ranged 99 (${s.Ranged ?? 1}); train on Khazard troopers`,
   step: getFighter().resolveFighterStep('trooper', ['TRAIN_SKILL=Ranged', 'TARGET_LEVEL=99']),
  };
  if ((s.Magic ?? 1) < 99) return {
   category: 'skiller', reason: `Maxed tribrid needs Magic 99 (${s.Magic ?? 1}); stage runes and train alchemy`,
   step: getSkiller().resolveSkillerStep('magic', 'alch-train', ['99', '5000']),
  };
  if ((s.Prayer ?? 1) < 99) {
   const bone = [536, 532, 526].find(id => (account.ownedItems[id] ?? 0) > 6);
   return bone ? {
    category: 'skiller', reason: `Maxed tribrid needs Prayer 99 (${s.Prayer ?? 1}); bury owned bones above the reserve`,
    step: getSkiller().resolveSkillerStep('prayer', 'bury', ['99', `BONE_ID=${bone}`, 'BURY_HELD=1']),
   } : {
    category: 'fighter', reason: `Maxed tribrid needs Prayer 99 (${s.Prayer ?? 1}); gather and bury trooper bones`,
    step: getFighter().resolveFighterStep('trooper', ['TRAIN_SKILL=Hitpoints', 'TARGET_LEVEL=99', 'GIANT_KILLS=500', 'GIANT_BURY=1']),
   };
  }
  if (hp < 99) return {
   category: 'fighter', reason: `Maxed tribrid needs Hitpoints 99 (${hp}); finish on Khazard troopers`,
   step: getFighter().resolveFighterStep('trooper', ['TRAIN_SKILL=Hitpoints', 'TARGET_LEVEL=99']),
  };
  const kitCheck = assessTribridReadiness(account.ownedItems);
  if (!kitCheck.ready) {
   return {
    category: 'pvp',
    reason: `Missing tribrid kit items (${Object.keys(kitCheck.missing).join(',')}); stage PvP kit at bank`,
    step: getPvp().resolvePvpStep('stage-kit'),
   };
  }
  return {
   category: 'pvp',
   reason: 'Combat and tribrid kit ready; launch Wilderness PK pilot',
   step: getPvp().resolvePvpStep('pilot', ['10', '20']),
  };
 }
 if (goal === 'quest-sweep') {
  const q = prioritizeQuestsForAccount(account.ownedItems, account.completedQuests, undefined, s);
  if (q.readyNow.length > 0) {
   const first = q.readyNow[0]!;
   return {
    category: 'quester',
    reason: `Quest "${first.slug}" has all required items staged; sweep now`,
    step: first.step,
   };
  }
  const next = q.needsItems[0];
  if (next) return {
   category: null, status: 'blocked', step: null,
   reason: `Quest "${next.slug}" needs supplies: ${Object.entries(next.missingItems).map(([id, count]) => `${count}x${id}`).join(', ')}`,
  };
  return {
   category: null, step: null, status: q.blocked.length ? 'blocked' : 'complete',
   reason: q.blocked.length ? `Quest prerequisites: ${q.blocked.map(row => `${row.slug}: ${row.blockers.join(', ')}`).join('; ')}` : 'All tracked quests complete',
  };
 }
 if (goal !== 'max-overall') throw Error(`aio: unknown account goal "${goal}"`);
 // 'max-overall': pick the lowest non-99 skill and generate its next progressive band
 const combatSkills = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints']);
 const allSkills = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
 const lowest = allSkills
  .map(name => ({ name, level: s[name] ?? (name === 'Hitpoints' ? 10 : 1) }))
  .filter(k => k.level < 99)
  .sort((a, b) => a.level - b.level)[0];
 if (!lowest) return {category: null, step: null, status: 'complete', reason: 'All 19 skills are level 99'};
 if (lowest.name === 'Herblore' && lowest.level < 3) {
  const unlock = assessQuestReadiness('druid', account.ownedItems, account.completedQuests, s);
  if (!unlock.ready) return {category: null, step: null, status: 'blocked', reason: `Herblore needs Druidic Ritual: ${unlock.blockers.concat(Object.entries(unlock.missingItems).map(([id, count]) => `${count}x${id}`)).join(', ') || 'refresh the observed Herblore level'}`};
  return {category: 'quester', reason: 'Unlock Herblore with Druidic Ritual before training', step: getQuester().resolveQuesterStep('sweep', ['druid'])};
 }
 if (combatSkills.has(lowest.name)) {
  const band = planAutoFighterBand({
   Attack: s.Attack ?? 1,
   Strength: s.Strength ?? 1,
   Defence: s.Defence ?? 1,
   Hitpoints: s.Hitpoints ?? 10,
  });
  return {
   category: 'fighter',
   reason: `Lowest skill ${lowest.name} (${lowest.level}); train ${band.trainSkill} to ${band.targetLevel} on ${band.target}`,
   step: band.step,
  };
 }
 if (lowest.name === 'Ranged') {
  const goalLvl = Math.min(99, lowest.level + 10);
  const troopers = Math.min(s.Attack ?? 1, s.Strength ?? 1, s.Defence ?? 1) >= 60 && (s.Hitpoints ?? 10) >= 40;
  return {
   category: 'fighter',
   reason: `Lowest skill Ranged (${lowest.level}); train to ${goalLvl}`,
   step: troopers ? getFighter().resolveFighterStep('trooper', ['TRAIN_SKILL=Ranged', `TARGET_LEVEL=${goalLvl}`]) : getFighter().resolveFighterStep('ranged', [`TARGET_LEVEL=${goalLvl}`]),
  };
 }
 const band = planProgressiveSkiller(lowest.name.toLowerCase(), lowest.level, Math.min(99, lowest.level + 15), 25, account.ownedItems)[0]!;
 if (band.unitsNeeded < 1) return {category: null, step: null, status: 'blocked', reason: `Lowest skill ${lowest.name} (${lowest.level}) has no tier with owned inputs: ${band.shortfall}`};
 return {
  category: 'skiller',
  reason: `Lowest skill ${lowest.name} (${lowest.level}); run ${band.method} to ${band.toLevel}`,
  step: band.step,
 };
}

export function recommendNextAioJob(account: Parameters<typeof recommendAuthoredAioJob>[0], goal: AccountRecommendationGoal): AioRecommendation {
 return recommendAuthoredAioJob(account, goal);
}

const AIO_DEFAULT_ROOT = resolve(import.meta.dir, '..');

export async function runAioPipeline(
 account: string,
 specs: readonly string[],
 rounds = 1,
 env: Record<string, string | undefined> = process.env,
 root = AIO_DEFAULT_ROOT,
): Promise<string> {
 if (!account) throw Error('aio pipeline requires account');
 const steps = planAioPipeline(specs);
 const stopped = () => root === AIO_DEFAULT_ROOT
  ? isStopFilePresent(account)
  : existsSync(join(root, '.practice', `stop-${account}`))
   || existsSync(join(root, '.practice', `stop-${account.toLowerCase()}`))
   || existsSync(join(root, '.practice', 'stop-all'))
   || Boolean(env.STOP_FILE && existsSync(join(root, env.STOP_FILE)));
 return runChainSteps(steps, rounds, {
  stopped,
  log: console.log,
  run: st => runChild([st.script, account, ...st.args], { ...env, ...st.env }),
 });
}

export async function runAio(categoryInput: string, account: string, args: readonly string[], env: Record<string, string | undefined> = process.env,
 run: (args: string[], env: Record<string, string | undefined>) => Promise<string> = runDirectChild): Promise<string> {
 const category = categoryInput.toLowerCase().replace(/^--category=/, '');
 if (category === 'pipeline') return runAioPipeline(account, args, Number(env.ROUNDS ?? 1), env);
 switch (category as AioCategory) {
  case 'fighter': return (await import('./aio-fighter')).runAioFighter(account, args, env, undefined, run);
  case 'skiller': return (await import('./aio-skiller')).runAioSkiller(account, args, env);
  case 'boss': return (await import('./aio-boss')).runAioBoss(account, args, env);
  case 'pvp': return (await import('./aio-pvp')).runAioPvp(account, args, env);
  case 'quester': return (await import('./aio-quester')).runAioQuester(account, args, env);
  case 'market': return (await import('./aio-market')).runAioMarket(account, args, env);
  case 'logistics': return (await import('./aio-logistics')).runAioLogistics(account, args, env);
  default:
   throw Error(`aio: unknown category "${categoryInput}"; known: ${AIO_CATEGORIES.join(', ')}, pipeline`);
 }
}

// Normalize CLI args so both `bun scripts/aio.ts <category> <account> ...` AND
// `bun scripts/aio.ts <account> <category> ...` (used by proveInProcess / supervise.ts) work identically.
export function parseAioCliArgs(argv: readonly string[]): { category: string; account: string; rest: string[] } {
 const [first, second, ...rest] = argv;
 if (!first || !second) throw Error('aio CLI requires <category> and <account>');
 const isCategory = (s: string) => AIO_CATEGORIES.includes(s.toLowerCase() as AioCategory) || s.toLowerCase() === 'pipeline';
 if (isCategory(first)) return { category: first.toLowerCase(), account: second, rest };
 if (isCategory(second)) return { category: second.toLowerCase(), account: first, rest };
 throw Error(`aio: neither "${first}" nor "${second}" is a valid category (${AIO_CATEGORIES.join(', ')}, pipeline)`);
}

if (import.meta.main) {
 const args = process.argv.slice(2);
 if (!args.length || args[0] === '--list') {
  console.log(JSON.stringify(aioCatalog(), null, 2));
  process.exit(args[0] === '--list' ? 0 : 2);
 }
 if (args.length < 3) {
  console.log('RESULT fail usage: bun scripts/aio.ts <category> <account> <target|method> [args...] (or <account> <category> <target|method> ...)');
  process.exit(2);
 }
 const { category, account, rest } = parseAioCliArgs(args);
 const result = await runAio(category, account, rest);
 if (category === 'pipeline') console.log(result);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
