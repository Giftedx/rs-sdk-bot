// AIO bench coverage manifest: one key per AIO catalog route, and the practice case that measures it.
// A route with no case is a coverage gap; benchCoverage() lists the gaps so the bench can grow to the full catalog.
import {aioCatalog} from '../aio';
import {PRESETS, type SaveConfig} from '../../packages/practice/src/presets';
import {firemakingFixture} from '../../packages/practice/src/firemaking-order-proof';
import {agilityFixturePreset} from '../../packages/practice/src/agility-order-proof';

export type BenchCase = {
  key: string;
  script: string;
  preset: string;
  presetConfig?: SaveConfig;
  scriptArgs: string[];
  pass: (stdout: string) => boolean;
  timeoutMs?: number;
  // Files the worker reads, written before each run: path to JSON value. In a path, in the JSON and in `scriptArgs`,
  // `{bot}` is the account name of the run, `{bot:b}` the partner with suffix `b`, and `{save}` the account's save file.
  jobFiles?: Record<string, unknown>;
  // Partner accounts the worker opens itself, named `<bot><suffix>` (one letter: a bench name has 11 characters).
  companions?: {suffix: string; preset: string; presetConfig?: SaveConfig}[];
  // A case that ends at a tick cap shows no speed in its ticks. `output` reads the useful amount from the RESULT
  // line (coins, items, kills); the bench then compares the amount for each 1,000 ticks.
  output?: RegExp;
  // Why the case cannot pass today. A default run skips it and coverage does not count it; BENCH_ALL=1 runs it.
  known?: string;
};

const ok = (s: string) => /^RESULT ok\b/m.test(s);
const questSlug = (script: string) => script.replace('scripts/generated/', '').replace(/^quest-/, '').replace(/\.ts$/, '');

// Every route the AIO catalog can dispatch. Owned-account quest runners are quester modes, not quest keys.
export function aioRouteKeys(): string[] {
  const c = aioCatalog().categories;
  return [
    ...c.skiller.routes.map(r => `skiller:${r.skill}:${r.method}`),
    ...c.fighter.profiles.map(r => `fighter:${r.target}`),
    ...c.boss.encounters.map(r => `boss:${r.boss}`),
    ...c.pvp.modes.map(r => `pvp:${r.mode}`),
    ...c.quester.modes.map(r => `quester:mode:${r.mode}`),
    ...c.quester.questScripts.map(questSlug).filter(s => !s.endsWith('-owned')).map(s => `quester:quest:${s}`),
    ...c.market.modes.map(r => `market:${r.mode}`),
    ...c.logistics.roles.map(r => `logistics:${r.role}`),
  ];
}

const COOK_JOB_PATH = '.practice/aio-cook-job.json', CUT_JOB_PATH = '.practice/aio-cut-job.json';
export const BENCH_JOB_FILES: Record<string, unknown> = {
  [COOK_JOB_PATH]: {family: 'cooking', recipe: 'cooking_generic_lobster', target: 10, batch: 10, cap: 2000, returnTicks: 300, members: true, bank: {x: 2809, z: 3441, level: 0}, site: {x: 2816, z: 3443, level: 0}, heat: 'range'},
  [CUT_JOB_PATH]: {family: 'inventory', recipe: 'cut-dragonstone', target: 10, batch: 10, cap: 2000, returnTicks: 300, members: true, bank: {x: 3092, z: 3243, level: 0}, site: {x: 3092, z: 3243, level: 0}},
};

// Draynor-bank chicken fixture: sword and shrimps in the pack, banked at the booth train-chickens opens.
// Melee 20 keeps the combat-unlock planner feasible; 20 to 25 Strength is a few kills.
const CHICKEN_FIXTURE: SaveConfig = {
  position: {x: 3092, z: 3247, level: 0},
  skills: {Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30},
  inventory: [{id: 1277, count: 1}, {id: 315, count: 5}],
  bank: [{id: 1351, count: 1}],
};

const skiller = (skill: string, method: string, preset: string, args: string[] = [], extra: Partial<BenchCase> = {}): BenchCase =>
  ({key: `skiller:${skill}:${method}`, script: 'scripts/aio-skiller.ts', preset, scriptArgs: [skill, method, ...args], pass: ok, ...extra});

const ROUTE_CASES: BenchCase[] = [
  skiller('fishing', 'cage', 'gather_fish_catherby', ['cage', '1500'], {output: /totalCaught=(\d+)/}),
  skiller('smithing', 'smelt', 'smelt_bars_alkharid'),
  // Start states and arguments below come from each worker's proof or fleet fixture (the source is named per case).
  skiller('fishing', 'harpoon', 'gather_fish_catherby', ['harpoon', '1500'], {presetConfig: {position: {x: 2840, z: 3432, level: 0}, skills: {Fishing: 70}, inventory: [{id: 311, count: 1}]}}),
  skiller('cooking', 'food', 'cook_food_catherby', ['600', 'lobster']),
  skiller('woodcutting', 'yews', 'gather_yews', ['1500', '5', 'MAX_TRIPS=1']),
  skiller('fletching', 'arrows', 'fletch_arrows_bank', ['600', 'arrows', 'rune']),
  skiller('mining', 'ore', 'gather_ore_varrock', ['1500', '5', 'MAX_TRIPS=1'], {presetConfig: {position: {x: 3286, z: 3368, level: 0}, skills: {Mining: 50, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1275, count: 1}]}}),
  // scripts/measure/fleet-practice.ts `flax`
  skiller('crafting', 'bowstrings', 'spin_bowstrings_seers', ['1250', 'MAX_MAKE=56', 'RAW_RESERVE=50', 'MAX_TRIPS=4'], {presetConfig: {position: {x: 2727, z: 3492, level: 0}, skills: {Crafting: 13}, inventory: [{id: 1735, count: 1}, {id: 315, count: 1}, {id: 2309, count: 1}], bank: [{id: 1779, count: 106}, {id: 1737, count: 40}, {id: 1759, count: 25}, {id: 995, count: 5}]}, known: 'made=56 but spunTotal=0 and stop=incomplete'}),
  skiller('crafting', 'legacy-jewelry', 'craft_jewelry_bank', ['300', 'cut', 'sapphire'], {known: 'crafted=0 in 300 ticks'}),
  skiller('herblore', 'potions', 'brew_potions_bank', ['1500', 'auto', 'TARGET_LEVEL=51']),
  // packages/practice/src/agility-order-proof.ts
  skiller('agility', 'order', 'agility_gnome_1', ['gnome', '20', 'AGI_POTION=0', 'AGI_MAX_LAPS=100', 'AGI_MAX_TICKS=2500', 'AGI_PROGRESS_TICKS=150', 'AGI_ENTRY_TICKS=400'], {presetConfig: agilityFixturePreset(PRESETS.agility_gnome_1!)}),
  // packages/practice/src/shark-supply-order-proof.ts
  skiller('fishing', 'shark', 'fresh_lumbridge', ['25', '9000'], {timeoutMs: 900_000, presetConfig: {position: {x: 2618, z: 3332, level: 0}, skills: {Attack: 70, Strength: 70, Defence: 70, Hitpoints: 75, Fishing: 99, Cooking: 99}, inventory: [{id: 995, count: 5408}], bank: [{id: 329, count: 312}, {id: 333, count: 560}, {id: 385, count: 5}, {id: 436, count: 17}], equipment: [{id: 1275, count: 1, slot: 3}], varps: {4: -1, 9: -1, 13: -1, 16: -1, 28: -1, 64: -1, 181: -1, 209: -1, 300: 1000}}}),
  // scripts/measure/fleet-practice.ts `cook-badpoint`
  skiller('cooking', 'stock', 'fresh_lumbridge', ['1500', 'COOK_ROUTE=near', 'RAW_RESERVE=50', 'MAX_COOK=60', 'MAX_TRIPS=1'], {presetConfig: {position: {x: 3099, z: 3256, level: 0}, skills: {Cooking: 99}, coins: 200, inventory: [{id: 309, count: 1}, {id: 946, count: 1}, {id: 1511, count: 1}, {id: 1511, count: 1}, {id: 314, count: 100}, {id: 2140, count: 1}, {id: 2140, count: 1}], bank: [{id: 335, count: 80}, {id: 331, count: 80}, {id: 2140, count: 133}]}}),
  // packages/practice/src/wine-order-proof.ts
  skiller('cooking', 'wine', 'fresh_lumbridge', ['99', '80'], {pass: s => ok(s) || (/WINE_ORDER_RESULT/.test(s) && !/^RESULT fail/m.test(s)), presetConfig: {position: {x: 3092, z: 3243, level: 0}, bank: [{id: 1995, count: 150}], inventory: [{id: 1996, count: 600}]}}),
  skiller('cooking', 'batch', 'cook_food_catherby', ['cooking_generic_lobster', 'range', '10', '400']),
  // packages/practice/src/edgeville-woodcut-order-proof.ts
  skiller('woodcutting', 'edgeville', 'fresh_lumbridge', ['STALL_TICKS=0'], {presetConfig: {position: {x: 3094, z: 3491, level: 0}, skills: {Attack: 67, Strength: 25, Defence: 24, Hitpoints: 52, Woodcutting: 15}, inventory: Array.from({length: 8}, () => ({id: 385, count: 1})), bank: [{id: 1351, count: 1}, {id: 1521, count: 5}, {id: 995, count: 216372}]}}),
  // packages/practice/src/firemaking-order-proof.ts
  skiller('firemaking', 'order', 'fresh_lumbridge', ['TARGET_LEVEL=15', 'LOG=normal', 'TOOL_BUDGET=0', 'CASH_RESERVE=0', 'CAP=2000', 'MAX_LOGS=2'], {presetConfig: firemakingFixture('entry')}),
  // packages/practice/src/glass-supply-proof.ts `owned`
  skiller('crafting', 'glass', 'fresh_lumbridge', ['SUPPLY_MODE=1', 'MEMBERS=1', 'MAX_MAKE=1', 'MAX_SPEND=0', 'CASH_RESERVE=1000', 'CAP=4000'], {timeoutMs: 900_000, presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Crafting: 51, Hitpoints: 39}, varps: {160: 2}, inventory: [{id: 995, count: 17}, {id: 590, count: 1}, {id: 1775, count: 1}], equipment: [{id: 1205, count: 1, slot: 3}], bank: [{id: 995, count: 2000}, {id: 314, count: 23}, {id: 1775, count: 2}]}}),
  skiller('crafting', 'inventory', 'bank_gems', ['cut-dragonstone', 'MAX_MAKE=10', 'CAP=500', 'MEMBERS=1']),
  // packages/practice/src/druid-meats-proof.ts
  skiller('herblore', 'meats', 'fresh_lumbridge', ['CAP=4000'], {timeoutMs: 900_000, presetConfig: {position: {x: 3092, z: 3242, level: 0}, skills: {Attack: 94, Strength: 83, Defence: 76, Hitpoints: 75}, equipment: [{id: 1289, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], inventory: [{id: 954, count: 1}, {id: 329, count: 2}], bank: [{id: 995, count: 1000}, {id: 590, count: 1}, {id: 1511, count: 13}, {id: 2132, count: 265}]}}),
  // packages/practice/src/rune-bank-craft-proof.ts
  skiller('runecraft', 'bank-craft', 'fresh_lumbridge', ['99', 'CAP=4000'], {presetConfig: {position: {x: 3013, z: 3355, level: 0}, varps: {63: 6, 101: 1, 281: 1000}, skills: {Attack: 47, Hitpoints: 33, Runecraft: 1}, bank: [{id: 1436, count: 30}, {id: 556, count: 25}, {id: 1438, count: 1}, {id: 1448, count: 1}], inventory: [{id: 556, count: 5}]}}),
  // packages/practice/src/magic-order-proof.ts `varrock`
  skiller('magic', 'order', 'fresh_lumbridge', ['TARGET_LEVEL=32', 'MAX_CASTS=5', 'RUNE_BUDGET=1000', 'CASH_RESERVE=10000', 'CAP=1500'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Magic: 31}, inventory: [{id: 333, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 1351, count: 1}], bank: [{id: 556, count: 25}, {id: 557, count: 4}, {id: 563, count: 5}, {id: 995, count: 14911}, {id: 1511, count: 5}]}}),
  skiller('prayer', 'bury', 'fresh_lumbridge', ['43', 'CAP=1500', 'MAX_BURY=175', 'BONE_RESERVE=6'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Prayer: 42}, bank: [{id: 526, count: 200}]}}),
  // packages/practice/src/goldfarm-order-proof.ts `entry99`
  skiller('thieving', 'knights-stable', 'fresh_lumbridge', ['TICKS=600', 'BANK_AT=50000'], {output: /coinsGained=(\d+)/, presetConfig: {position: {x: 2654, z: 3283, level: 0}, skills: {Thieving: 99, Hitpoints: 10}, inventory: [{id: 1265, count: 1}, {id: 590, count: 1}, {id: 995, count: 37}], equipment: [{id: 1277, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], bank: [{id: 995, count: 1000}, {id: 440, count: 5}, {id: 333, count: 10}, {id: 329, count: 4}, {id: 385, count: 3}]}}),
  skiller('thieving', 'stalls', 'cake_stall', ['stealing_bakery_stall', '1', '120'], {known: 'the steal does not complete from the preset tile in 120 ticks'}),
  // packages/practice/src/blood-chest-proof.ts `entry`
  skiller('thieving', 'blood-chest', 'fresh_lumbridge', ['2500', 'MAX_LOOTS=2', 'CAP=2500'], {timeoutMs: 900_000, presetConfig: {position: {x: 2584, z: 3337, level: 0}, skills: {Thieving: 99, Attack: 72, Hitpoints: 56, Agility: 60}, inventory: [{id: 1895, count: 1}, {id: 1895, count: 1}, {id: 1895, count: 1}, {id: 995, count: 40}], bank: [{id: 995, count: 1000}, {id: 314, count: 7}]}}),
  // scripts/measure/fleet-practice.ts `wool`
  skiller('foraging', 'wool', 'fresh_lumbridge', ['CAP=2200', 'MAX_TRIPS=3'], {presetConfig: {position: {x: 3207, z: 3218, level: 2}, inventory: [{id: 1735, count: 1}]}}),
  skiller('runecraft', 'air', 'rc_air_inside'),
  skiller('thieving', 'knights', 'goldfarm_knights', ['TICKS=1500'], {output: /coinsGained=(\d+)/}),
  skiller('foraging', 'flax', 'gather_flax', ['1500'], {output: /banked=(\d+)/}),
  skiller('foraging', 'grapes', 'grapes_cooksguild'),
  {key: 'fighter:chicken', script: 'scripts/aio-fighter.ts', preset: 'bank_draynor', presetConfig: CHICKEN_FIXTURE, scriptArgs: ['chicken', 'TARGET_LEVEL=25', 'CAP=1500'], pass: s => ok(s) && s.includes('chicken-qualification'), timeoutMs: 300_000},
  {key: 'fighter:druid', script: 'scripts/aio-fighter.ts', preset: 'gather_combat_druid', scriptArgs: ['druid', '1500', 'druid'], pass: ok, output: /kills=(\d+)/},
  // packages/practice/src/cow-progress-order-proof.ts
  {key: 'fighter:cow', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['cow', '1500', 'cow', 'MAX_KILLS=5', 'TRAIN_SKILL=Attack', 'TARGET_LEVEL=20', 'COW_BANK_PROFILE=south', 'COW_FOOD_MODE=held'], pass: ok,
    presetConfig: {position: {x: 2655, z: 3283, level: 0}, skills: {Attack: 9, Defence: 20, Strength: 20, Hitpoints: 20},
      inventory: [{id: 995, count: 140}, {id: 333, count: 1}, {id: 315, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 2309, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 1277, count: 1}, {id: 1171, count: 1}],
      equipment: [{id: 1277, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}],
      bank: [{id: 995, count: 25}, {id: 1351, count: 1}, {id: 590, count: 1}, {id: 303, count: 1}, {id: 1925, count: 1}, {id: 1931, count: 1}, {id: 1265, count: 1}, {id: 1205, count: 1}, {id: 841, count: 1}, {id: 882, count: 25}, {id: 556, count: 25}, {id: 558, count: 15}, {id: 555, count: 6}, {id: 557, count: 4}, {id: 559, count: 2}, {id: 1739, count: 8}, {id: 526, count: 8}, {id: 2132, count: 8}]}},
  {key: 'fighter:giant', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['giant', '1500', 'giant'], pass: ok, output: /kills=(\d+)/,
    presetConfig: {position: {x: 2545, z: 3144, level: 0}, skills: {Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60}, equipment: [{id: 1333, count: 1, slot: 3}, {id: 1113, count: 1, slot: 4}, {id: 1079, count: 1, slot: 7}], inventory: [{id: 379, count: 5}]}},
  {key: 'fighter:ranged-gather', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['ranged-gather', 'CAP=1500', 'MAX_KILLS=2', 'AMMO=90', 'FOOD=3', 'FOOD_ID=333'], pass: s => ok(s) && s.includes('RANGED_BANK'),
    presetConfig: {position: {x: 3253, z: 3421, level: 0}, skills: {Ranged: 30, Hitpoints: 30}, bank: [{id: 841, count: 1}, {id: 884, count: 90}, {id: 333, count: 5}]}},
  {key: 'pvp:monitor', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['monitor', '50', '12', 'stop'], pass: ok},
  {key: 'quester:mode:chain', script: 'scripts/aio-quester.ts', preset: 'quest_cook', scriptArgs: ['chain', 'cook'], pass: ok, known: 'the chain completes (RESULT ok quest-chain done=cook) but prints no START line, so the start check fails'},
  // packages/practice/src/shop-supply-order-proof.ts
  {key: 'market:earth-shop', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['earth-shop', 'aubury', '1600', 'STOCK_TARGET=53', 'MAX_ITEMS=50', 'MAX_SPEND=2000', 'COIN_RESERVE=30000'], pass: ok,
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Attack: 49, Strength: 10, Defence: 11, Hitpoints: 35}, inventory: [{id: 1277, count: 1}], bank: [{id: 995, count: 352288}, {id: 554, count: 1482}, {id: 557, count: 3}, {id: 1521, count: 7}]}},
  {key: 'market:buy-sword', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['buy-sword', 'CAP=900', 'MAX_SPEND=2500'], pass: s => ok(s) && s.includes('OWNED_SWORD_BANK'),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, bank: [{id: 995, count: 5000}]}},
  // scripts/measure/fleet-practice.ts `courier`
  {key: 'logistics:food-courier', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['food-courier', 'OUTBOUND_ONLY=1', 'FEATHERS=0', 'CAP=1200'], pass: s => ok(s) && s.includes('outboundOnly=true'),
    presetConfig: {position: {x: 2654, z: 3283, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 40}, coins: 20380, inventory: [{id: 315, count: 1}, {id: 2309, count: 1}]}},
  {key: 'logistics:bank-sort', script: 'scripts/aio-logistics.ts', preset: 'bank_gems', scriptArgs: ['bank-sort', '200', '20', 'name'], pass: ok, known: 'RESULT fail Error: bank open unconfirmed'},
  {key: 'logistics:relocate-bank', script: 'scripts/aio-logistics.ts', preset: 'bank_gems', scriptArgs: ['relocate-bank', 'CAP=1500'], pass: ok},
  {key: 'logistics:arrive-draynor', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['arrive-draynor', 'CAP=1250'], pass: ok},
  {key: 'quester:mode:sweep', script: 'scripts/aio-quester.ts', preset: 'quest_cook', scriptArgs: ['sweep', 'cook'], pass: ok},
  {key: 'market:shop-buy', script: 'scripts/aio-market.ts', preset: 'shop_catherby', scriptArgs: ['shop-buy'], pass: ok},
  {key: 'logistics:walk-to', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['walk-to', '3092', '3243', '0'], pass: ok},
];

// Cases outside the catalog keys: the direct worker and master-dispatcher twins of one route, and bank-job profiles.
const EXTRA_CASES: BenchCase[] = [
  {key: 'extra:direct-quest-cook', script: 'scripts/generated/quest-cook.ts', preset: 'quest_cook', scriptArgs: [], pass: s => ok(s) && s.includes('Cook flag=complete')},
  {key: 'extra:master-quest-cook', script: 'scripts/aio.ts', preset: 'quest_cook', scriptArgs: ['quester', 'sweep', 'cook'], pass: ok},
  {key: 'extra:bank-job-cook-lobster', script: 'scripts/aio-skiller.ts', preset: 'cook_food_catherby', scriptArgs: ['bank-job', COOK_JOB_PATH], pass: s => ok(s) && s.includes('cooking_generic_lobster')},
  {key: 'extra:bank-job-cut-dragonstone', script: 'scripts/aio-skiller.ts', preset: 'bank_gems', scriptArgs: ['bank-job', CUT_JOB_PATH], pass: s => ok(s) && s.includes('cut-dragonstone')},
];

const KNOWN_QUEST: Readonly<Record<string, string>> = {
  waterfall: 'the walk to the Tree Gnome Village maze mouth 2505,3190 stops at 2509,3187, and the planner has no route from there to the first maze waypoint 2512,3190; the route search to the goal goes round the hedge to 2529,3140, where the client refuses the walk',
};

// Pair quests open their partners themselves: quest-arrav.ts and quest-hero.ts use `<main>p`, quest-legends.ts `<main>b` and `<main>c`.
const QUEST_COMPANIONS: Readonly<Record<string, {suffix: string; preset: string}[]>> = {
  arrav: [{suffix: 'p', preset: 'quest_arrav_helper'}],
  hero: [{suffix: 'p', preset: 'quest_hero_helper'}],
  legends: [{suffix: 'b', preset: 'quest_legends_kit_b'}, {suffix: 'c', preset: 'quest_legends_kit_c'}],
};

// A three-minute set that touches each category the bench can run; run it before a full run.
export const SMOKE_KEYS: readonly string[] = [
  'quester:quest:cook', 'quester:quest:imp', 'quester:quest:doric', 'quester:quest:gobdip', 'quester:quest:sheep',
  'quester:quest:hetty', 'quester:quest:rj', 'quester:quest:druid', 'quester:quest:blackknight', 'quester:quest:elemental',
  'quester:mode:sweep', 'logistics:walk-to', 'skiller:runecraft:air', 'extra:bank-job-cook-lobster', 'extra:bank-job-cut-dragonstone',
];

// One case per generated quest that has a quest_<slug> start preset: the quest script through the AIO quester.
function questCases(): BenchCase[] {
  return aioCatalog().categories.quester.questScripts.map(questSlug)
    .filter(s => !s.endsWith('-owned') && PRESETS[`quest_${s}`])
    .map(s => ({key: `quester:quest:${s}`, script: 'scripts/aio-quester.ts', preset: `quest_${s}`, scriptArgs: [s], pass: ok, timeoutMs: 900_000,
      ...(KNOWN_QUEST[s] ? {known: KNOWN_QUEST[s]} : {}), ...(QUEST_COMPANIONS[s] ? {companions: QUEST_COMPANIONS[s]} : {})}));
}

// Routes that cannot run as one bench case, each with the cause. `noEntry` routes point at a file with no command
// line: the dispatcher starts it and it prints no RESULT.
export const BLOCKED_ROUTES: Readonly<Record<string, string>> = {
  'skiller:woodcutting:loop': 'worker scripts/wc-loop.ts needs the lite runner, not the in-process client',
  'skiller:cooking:ge-cook': 'needs the Grand Exchange service',
  'skiller:firemaking:ge': 'needs the Grand Exchange service',
  'skiller:mining:lava-maze': 'needs escort accounts in the Wilderness',
  'quester:mode:hero-owned': 'needs an order file that names two owned accounts',
  'quester:mode:legends-owned': 'needs an order file that names the owned account',
  'logistics:loadout-import': 'dispatcher mismatch: an offline converter with no account argument',
  'logistics:relocate-knight': 'the worker admits three named live accounts only',
  'pvp:roam': 'needs other players in the Wilderness',
  'pvp:fight': 'needs a second logged-in player as the target',
  'pvp:hunt': 'needs attackable players in the Wilderness',
  'pvp:pilot': 'a live run by design',
  'logistics:banker': 'a standing service with no finite end',
  'logistics:food-chain': 'a standing controller for named accounts',
  'logistics:supply-chain': 'a controller for three named accounts on a fixed server address',
  'logistics:fleet-trade': 'needs fleet order files and a live server',
  'market:ge-buy-list': 'needs the Grand Exchange service and a seller account',
  'market:ge-trip': 'needs the Grand Exchange service and a counterparty',
  'market:ge-plan': 'needs Grand Exchange market data',
  'market:bank-seller': 'needs buyers on the Grand Exchange',
  'market:ge-sell': 'needs a buyer on the Grand Exchange',
  'market:ge-buy': 'needs a seller on the Grand Exchange, or two runs for the shop fallback',
};

export function benchCases(): BenchCase[] {
  return [...ROUTE_CASES, ...questCases(), ...EXTRA_CASES];
}

export function benchCoverage() {
  const all = benchCases(), routes = aioRouteKeys(), have = new Set(all.filter(c => !c.known).map(c => c.key));
  const covered = routes.filter(k => have.has(k)), gaps = routes.filter(k => !have.has(k));
  const known = Object.fromEntries(all.filter(c => c.known).map(c => [c.key, c.known!]));
  const blocked = Object.fromEntries(Object.entries(BLOCKED_ROUTES).filter(([k]) => !have.has(k)));
  return {routes: routes.length, covered: covered.length, known, blocked, gaps: gaps.filter(k => !(k in blocked) && !(k in known))};
}

// Rival reference ticks per quest: the median where the notes give one, else the whole-quest figure each TestingPurposes/rs-stun-toolkit `run-<quest>.share.md`
// states for its lockstep sim (MIT, 4e40de3d). Their start tile, stats and kit differ from our quest_<slug> presets,
// so a gap names a route to compare step by step; it is not a measured loss.
export const RIVAL_QUEST_TICKS: Readonly<Record<string, number>> = {
  cook: 4, sheep: 44, doric: 58, gobdip: 88, imp: 108, elemental: 201, drunkmonk: 214, druid: 247, murder: 264,
  hunt: 268, blackknight: 286, fishingcompo: 322, seaslug: 383, chompybird: 482, squire: 500, merlin: 598,
  ball: 654, scorpion: 876, ikov: 924, mortton: 944, grail: 1005, tree: 976, waterfall: 980, crest: 1019,
  dragon: 1114, desertrescue: 1339, zanaris: 1376, troll: 1423, tbwt: 1493, hero: 1745, dwarfcannon: 1938,
  grandtree: 1991, dig: 2120, runemysteries: 2930, legends: 3883,
};
export const rivalTicks = (key: string): number | undefined => RIVAL_QUEST_TICKS[key.replace(/^quester:quest:/, '')];
