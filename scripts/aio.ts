// Master All-In-One Bot Suite ("Vortex / Sythe Premium Plugin Taxonomy"):
// Single unified entry point and catalog across all 7 reusable bot categories:
//   1. skiller   ("Vortex All In One" — 15 skills, gathering, artisan, runecraft, thieving, agility)
//   2. fighter   ("Auto Fighter"      — general monster combat, melee/ranged training, slayer/drop farming)
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
import {join,resolve} from 'node:path';
import {runChild} from '../packages/core/src/run-child';
import {runChainSteps,type Step} from '../packages/core/src/chain-step';
import {SKILLER_ROUTES,skillerCatalogSummary,resolveSkillerStep,runAioSkiller,planProgressiveSkiller,discoverBankedProduction} from './aio-skiller';
import {FIGHTER_PROFILES,resolveFighterStep,runAioFighter,planAutoFighterBand} from './aio-fighter';
import {BOSS_ENCOUNTERS,resolveBossStep,runAioBoss,assessBossReadiness} from './aio-boss';
import {PVP_MODES,resolvePvpStep,runAioPvp,pvpCombatBracket,assessTribridReadiness} from './aio-pvp';
import {QUESTER_MODES,listGeneratedQuestScripts,resolveQuesterStep,runAioQuester,assessQuestReadiness,prioritizeQuestsForAccount} from './aio-quester';
import {MARKET_MODES,resolveMarketStep,runAioMarket,planGeRestockOrders} from './aio-market';
import {LOGISTICS_ROLES,resolveLogisticsStep,runAioLogistics,planFleetDistribution} from './aio-logistics';

export {
 planProgressiveSkiller,
 discoverBankedProduction,
 planAutoFighterBand,
 assessBossReadiness,
 pvpCombatBracket,
 assessTribridReadiness,
 assessQuestReadiness,
 prioritizeQuestsForAccount,
 planGeRestockOrders,
 planFleetDistribution,
};

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
 const quests = listGeneratedQuestScripts();
 return {
  categories: {
   skiller: {
    pluginName: 'Vortex All In One (Skiller)',
    entry: 'scripts/aio-skiller.ts',
    summary: skillerCatalogSummary(),
    routes: SKILLER_ROUTES,
   },
   fighter: {
    pluginName: 'Auto Fighter (Combat & Drops)',
    entry: 'scripts/aio-fighter.ts',
    profiles: FIGHTER_PROFILES,
   },
   boss: {
    pluginName: 'PvM Helper (Bosses & Minigames)',
    entry: 'scripts/aio-boss.ts',
    encounters: BOSS_ENCOUNTERS,
   },
   pvp: {
    pluginName: 'PK Fighter (Wilderness PvP & Tribrid)',
    entry: 'scripts/aio-pvp.ts',
    modes: PVP_MODES,
   },
   quester: {
    pluginName: 'Quest Helper & Clue Solver',
    entry: 'scripts/aio-quester.ts',
    modes: QUESTER_MODES,
    questScriptsCount: quests.length,
    questScripts: quests,
   },
   market: {
    pluginName: 'MK Auto Buyer & GE Trader',
    entry: 'scripts/aio-market.ts',
    modes: MARKET_MODES,
   },
   logistics: {
    pluginName: 'RC Runners, Loadouts & Fleet Mules',
    entry: 'scripts/aio-logistics.ts',
    roles: LOGISTICS_ROLES,
   },
  },
  totals: {
   categories: AIO_CATEGORIES.length,
   skillerRoutes: SKILLER_ROUTES.length,
   fighterProfiles: FIGHTER_PROFILES.length,
   bossEncounters: BOSS_ENCOUNTERS.length,
   pvpModes: PVP_MODES.length,
   questerModes: QUESTER_MODES.length,
   questScripts: quests.length,
   marketModes: MARKET_MODES.length,
   logisticsRoles: LOGISTICS_ROLES.length,
  },
 };
}

export function resolveAioStep(categoryInput: string, args: readonly string[]): Step {
 const category = categoryInput.toLowerCase().replace(/^--category=/, '') as AioCategory;
 const [first, ...rest] = args;
 if (!first) throw Error(`aio: category "${category}" requires a target/method argument`);
 switch (category) {
  case 'skiller': return resolveSkillerStep(first, rest[0], rest.slice(1));
  case 'fighter': return resolveFighterStep(first, rest);
  case 'boss': return resolveBossStep(first, rest);
  case 'pvp': return resolvePvpStep(first, rest);
  case 'quester': return resolveQuesterStep(first, rest);
  case 'market': return resolveMarketStep(first, rest);
  case 'logistics': return resolveLogisticsStep(first, rest);
  default:
   throw Error(`aio: unknown category "${categoryInput}"; known: ${AIO_CATEGORIES.join(', ')}`);
 }
}

// Compile a sequence of declarative AIO specs (e.g. ["market:ge-buy ITEM_ID=385 QUANTITY=20", "pvp:pilot 10 20"])
// into verified Step[] compatible with chain.ts, host.ts, and workerEntries release hashing.
export function planAioPipeline(specs: readonly string[]): Step[] {
 if (!specs.length) throw Error('aio pipeline requires at least one step spec');
 return specs.map(raw => {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0]!;
  if (head.includes(':')) {
   const [cat, first] = head.split(':', 2);
   return resolveAioStep(cat!, [first!, ...tokens.slice(1)]);
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
  args: steps.map(s => [s.script, ...s.args, ...Object.entries(s.env).map(([k, v]) => `${k}=${v}`)].join(' ')),
  env: { ROUNDS: '1' },
  enabled: true,
  repeat: false,
  standing,
  maxRestarts: 0,
 };
}

export type AccountRecommendationGoal = 'pk-tribrid' | 'goldfarm' | 'quest-sweep' | 'max-overall';

// Deterministic account state router: given an account's observed skills, items (bank + pack + equipment), and completed quests,
// returns the next immediate executable Step and explanation for the chosen goal.
export function recommendNextAioJob(
 account: {
  name: string;
  skills: Readonly<Record<string, number>>;
  ownedItems: Readonly<Record<number, number>>;
  completedQuests?: ReadonlySet<string>;
 },
 goal: AccountRecommendationGoal,
): { category: AioCategory; reason: string; step: Step } {
 const s = account.skills;
 if (goal === 'goldfarm') {
  const thieving = s.Thieving ?? 1;
  if (thieving < 55) {
   return {
    category: 'skiller',
    reason: `Thieving ${thieving}/55; bootstrap to 55 before Ardougne knights`,
    step: resolveSkillerStep('thieving', 'bootstrap55', ['TARGET=55', 'CAP=3000']),
   };
  }
  const foodCount = [329, 333, 379, 385].reduce((sum, id) => sum + (account.ownedItems[id] ?? 0), 0);
  if (foodCount < 10 && (s.Fishing ?? 1) >= 40) {
   return {
    category: 'skiller',
    reason: `Food stock low (${foodCount}); fish and cook lobsters before knight pickpocketing`,
    step: resolveSkillerStep('fishing', 'cage', ['cage', '3000']),
   };
  }
  return {
   category: 'skiller',
   reason: `Thieving ${thieving} ready with food stock (${foodCount}); pickpocket Ardougne knights`,
   step: resolveSkillerStep('thieving', 'knights'),
  };
 }
 if (goal === 'pk-tribrid') {
  const atk = s.Attack ?? 1, str = s.Strength ?? 1, def = s.Defence ?? 1, hp = s.Hitpoints ?? 10;
  if (Math.min(atk, str, def) < 70) {
   const band = planAutoFighterBand({ Attack: atk, Strength: str, Defence: def, Hitpoints: hp });
   return {
    category: 'fighter',
    reason: `Combat melee (${atk}/${str}/${def}) below 70; train ${band.trainSkill} to ${band.targetLevel} on ${band.target}`,
    step: band.step,
   };
  }
  const kitCheck = assessTribridReadiness(account.ownedItems);
  if (!kitCheck.ready) {
   return {
    category: 'pvp',
    reason: `Missing tribrid kit items (${Object.keys(kitCheck.missing).join(',')}); stage PvP kit at bank`,
    step: resolvePvpStep('stage-kit'),
   };
  }
  return {
   category: 'pvp',
   reason: 'Combat and tribrid kit ready; launch Wilderness PK pilot',
   step: resolvePvpStep('pilot', ['10', '20']),
  };
 }
 if (goal === 'quest-sweep') {
  const q = prioritizeQuestsForAccount(account.ownedItems, account.completedQuests);
  if (q.readyNow.length > 0) {
   const first = q.readyNow[0]!;
   return {
    category: 'quester',
    reason: `Quest "${first.slug}" has all required items staged; sweep now`,
    step: first.step,
   };
  }
  const next = q.needsItems[0];
  return {
   category: 'quester',
   reason: next ? `Acquire missing quest items for "${next.slug}"` : 'All tracked quests complete',
   step: resolveQuesterStep('items'),
  };
 }
 // 'max-overall': pick the lowest non-99 skill and generate its next progressive band
 const combatSkills = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints']);
 const allSkills = ['Attack', 'Strength', 'Defence', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];
 const lowest = allSkills
  .map(name => ({ name, level: s[name] ?? 1 }))
  .filter(k => k.level < 99)
  .sort((a, b) => a.level - b.level)[0] ?? { name: 'Thieving', level: 1 };
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
  return {
   category: 'fighter',
   reason: `Lowest skill Ranged (${lowest.level}); train to ${goalLvl}`,
   step: resolveFighterStep('ranged', [`TARGET_LEVEL=${goalLvl}`]),
  };
 }
 const band = planProgressiveSkiller(lowest.name.toLowerCase(), lowest.level, Math.min(99, lowest.level + 15))[0]!;
 return {
  category: 'skiller',
  reason: `Lowest skill ${lowest.name} (${lowest.level}); run ${band.method} to ${band.toLevel}`,
  step: band.step,
 };
}

export async function runAioPipeline(
 account: string,
 specs: readonly string[],
 rounds = 1,
 env: Record<string, string | undefined> = process.env,
 root = resolve(import.meta.dir, '..'),
): Promise<string> {
 if (!account) throw Error('aio pipeline requires account');
 const steps = planAioPipeline(specs);
 const stopped = () => existsSync(join(root, '.practice', `stop-${account}`)) || existsSync(join(root, '.practice', 'stop-all'));
 return runChainSteps(steps, rounds, {
  stopped,
  log: console.log,
  run: st => runChild([st.script, account, ...st.args], { ...env, ...st.env }),
 });
}

export async function runAio(categoryInput: string, account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 const category = categoryInput.toLowerCase().replace(/^--category=/, '');
 if (category === 'pipeline') return runAioPipeline(account, args, Number(env.ROUNDS ?? 1), env);
 switch (category as AioCategory) {
  case 'skiller': return runAioSkiller(account, args, env);
  case 'fighter': return runAioFighter(account, args, env);
  case 'boss': return runAioBoss(account, args, env);
  case 'pvp': return runAioPvp(account, args, env);
  case 'quester': return runAioQuester(account, args, env);
  case 'market': return runAioMarket(account, args, env);
  case 'logistics': return runAioLogistics(account, args, env);
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
