// AIO bench coverage manifest: one key per AIO catalog route, and the practice case that measures it.
// A route with no case is a coverage gap; benchCoverage() lists the gaps so the bench can grow to the full catalog.
import {aioCatalog} from '../aio';
import {PRESETS, type SaveConfig} from '../../packages/practice/src/presets';
import {firemakingFixture} from '../../packages/practice/src/firemaking-order-proof';
import {agilityFixturePreset} from '../../packages/practice/src/agility-order-proof';
import {KITS, kitItems, kitSkills, kitVarps, levelsBeforeRoute, overBuild} from '../pk-kits';

// Food that a bot eats has one inventory entry for each piece. An entry with count 5 is one slot of 5, and the server
// deletes the whole slot on an eat (consume_effects.rs2, inv_delslot).
export type BenchCase = {
  key: string;
  // Environment for the engine of the case. It takes effect when the case has its own engine (a fresh-engine run).
  engineEnv?: Record<string, string>;
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
export const VIKING_BUILDS = ['zerker', 'range-tank', 'tank-range'] as const;
// The iron arrows a bench case gives a build that fights a quest with the bow.
export const RANGED_PACK = 600;
// A quest run on a build account passes when the quest script ends ok with no death and the XP of the run leaves
// every combat skill at or under the level of the kit (scripts/pk-kits.ts overBuild).
export const questKeepsBuild = (kit: string, before: Readonly<Record<string, number>>) => (s: string) => {
  const line = s.match(/^RESULT ok\b.*$/m)?.[0];
  if (!line || !/ died=false /.test(line)) return false;
  const gains = Object.fromEntries((line.match(/ xp=(\S*)/)?.[1] ?? '').split(',').filter(Boolean).map(p => { const [k, v] = p.split('='); return [k!, Number(v)]; }));
  return overBuild(kit, before, gains) === null;
};
// The skills of the halberd pure before a quest of its route, with every skill outside the build at level 1 but the
// ones the quest and the planner's bands ask (packages/planner/src/autopilot.ts UPASS_THIEVING, UPASS_AGILITY).
const hallyQuestSkills = (quest: 'upass' | 'regicide'): Record<string, number> => ({
  ...Object.fromEntries(Object.keys(PRESETS.quest_upass!.skills ?? {}).map(k => [k, 1])), ...levelsBeforeRoute('pure-hally'),
  Thieving: 50, Agility: 68, ...(quest === 'regicide' ? {Attack: kitSkills('pure-hally').Attack!, Crafting: 10} : {})});
// The RESULT line of a quest script lists the XP of the run as `xp=skill=n,...` (scripts/generated/quest-lib.ts gains).
export const lostCityKeepsBuild = (s: string) => {
  const line = s.match(/^RESULT ok\b.*$/m)?.[0];
  return !!line && / milestones=\S*,6\b/.test(line) && / died=false /.test(line) && !/\b(attack|defence|ranged|magic|prayer)=\d/.test(line.match(/ xp=(\S*)/)?.[1] ?? 'attack=1');
};
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
  inventory: [{id: 1277, count: 1}, ...Array.from({length: 5}, () => ({id: 315, count: 1}))],
  bank: [{id: 1351, count: 1}],
};

// One side of the mirror spar: 99 combat stats, Lost City done (dragon weapons wield, levelrequire.rs2:156), Dragon
// Slayer done (the rune platebody goes back on after a cast, levelrequire.rs2:132; without it the game refuses), special
// energy 1000 (varp 300), rune full helm, cape of legends, glory, rune platebody, platelegs, ranger boots, dragon
// dagger (p), rune kiteshield and 300 rune arrows worn; staff, bow, runes, 2 prayer potions and 18 sharks carried.
// `food` changes the sharks; `glory` adds a charged glory to the pack for an escape; `teleport` adds the law and fire
// runes of Varrock Teleport; `potions` swaps 3 sharks for a super attack, a super strength and a ranging potion;
// `god` is the potion kit with the Zamorak cape and staff, fire runes, and the Mage Arena done with Flames of
// Zamorak learnt (varps 267 and 270), for one more shark.
export const sparFixture = (x: number, z = 3555, o: {food?: number; glory?: boolean; teleport?: boolean; potions?: boolean; god?: boolean; noDragonSlayer?: boolean} = {}): SaveConfig => ({
  position: {x, z, level: 0},
  skills: {Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99, Prayer: 99, Hitpoints: 99},
  varps: o.god ? {147: 6, 176: 10, 300: 1000, 267: 8, 270: 99} : o.noDragonSlayer ? {147: 6, 300: 1000} : {147: 6, 176: 10, 300: 1000},
  equipment: [[1163, 0], [o.god ? 2414 : 1052, 1], [1712, 2], [1231, 3], [1127, 4], [1201, 5], [1079, 7], [2577, 10], [892, 13]].map(([id, slot]) => ({id: id!, count: id === 892 ? 300 : 1, slot: slot!})),
  inventory: [{id: o.god ? 2417 : 1401, count: 1}, ...(o.god ? [{id: 554, count: 400}] : []), {id: 861, count: 1}, {id: 556, count: 500}, {id: 565, count: 100}, {id: 557, count: 200}, {id: 555, count: 200}, {id: 561, count: 100},
    {id: 2434, count: 1}, {id: 2434, count: 1}, ...(o.glory ? [{id: 1712, count: 1}] : []), ...(o.teleport ? [{id: 563, count: 2}, {id: 554, count: 2}] : []), ...(o.potions || o.god ? [{id: 2436, count: 1}, {id: 2440, count: 1}, {id: 2444, count: 1}] : []), ...Array.from({length: o.food ?? (o.god ? 14 : o.potions ? 15 : 18)}, () => ({id: 385, count: 1}))],
});
// The league's opponents: a build and a profile of scripts/pk-spar.ts each.
export const LEAGUE: readonly {kit: string; profile: string}[] = [
  {kit: 'tribrid-pots', profile: 'base'},       // our own fighter, as it was
  {kit: 'tribrid-pots', profile: 'reader'},     // one that predicts our style and hits our weak armour
  {kit: 'tribrid-lean', profile: 'reader-mix'}, // the same with no fixed order
  {kit: 'melee', profile: 'base'},              // the tank: 22 sharks, one style
  {kit: 'hybrid', profile: 'base'},             // bow and dagger, 21 sharks
  {kit: 'ranger', profile: 'base'},
  {kit: 'mage', profile: 'base'},
  {kit: 'tribrid-food', profile: 'spec-mid'},   // 21 sharks, the special kept for half health
];
// The trained builds of scripts/pk-kits.ts that can attack each other at Wilderness level 34: the Defence 1 builds,
// and the builds with Defence 40 to 60 with the best three of the Defence 1 builds.
export const BUILD_BRACKETS: Readonly<Record<string, readonly string[]>> = {
  pure: ['pure-dds', 'pure-dds-msb', 'pure-r2h', 'pure-hally', 'pure-ranger', 'pure-mage', 'pure-tribrid', 'pure-pray'],
  def: ['rune-pure', 'zerker', 'dragon', 'range-tank', 'mage-tank', 'pure-pray', 'pure-ranger', 'pure-dds-msb'],
};
// Every pair of a bracket once, a pair of both brackets once. A case lasts as long as its longest fight, so the pairs
// stand in the order of the Defence, Hitpoints and food of their two builds: fights of about the same length share a
// case.
export const BUILD_CASE_PAIRS = 14;
const buildPairs = (brackets: Readonly<Record<string, readonly string[]>>, known: ReadonlySet<string> = new Set()): readonly (readonly [string, string])[] => {
  const bulk = (kit: string) => { const s = kitSkills(kit); return s.Defence! + s.Hitpoints! + 4 * KITS[kit]!.food; };
  const pairs = new Map<string, [string, string]>();
  for (const kits of Object.values(brackets)) kits.forEach((a, i) => kits.slice(i + 1).forEach(b => { const key = [a, b].sort().join(':'); if (!known.has(key)) pairs.set(key, [a, b]); }));
  return [...pairs.values()].sort((x, y) => bulk(x[0]) + bulk(x[1]) - bulk(y[0]) - bulk(y[1]) || x.join().localeCompare(y.join()))
    // Each build stands on side A in every second pair of the list.
    .map((pair, i) => (i % 2 ? [pair[1], pair[0]] as const : pair));
};
export const BUILD_PAIRS = buildPairs(BUILD_BRACKETS);
// The second set of builds, each bracket with the best builds of the first set for a reference. A pair of two
// reference builds is in BUILD_PAIRS already and has no place here. `low` holds the builds under combat 61, and `top`
// the best two builds with a Defence level against the maxed tribrid of the army (combat 126), with and without
// boost potions.
export const BUILD_BRACKETS_2: Readonly<Record<string, readonly string[]>> = {
  pure: ['pure-scim', 'pure-dlong', 'pure-knives', 'pure-pray31', 'pure-god', 'pure-pray', 'pure-dds-msb', 'pure-ranger'],
  def: ['addy-pure', 'def50', 'tank-range', 'pure-max', 'dragon', 'zerker', 'rune-pure', 'pure-pray'],
  low: ['baby-pure', 'low-ranger', 'low-mage', 'low-addy'],
  top: ['tank-range', 'dragon', 'tribrid-pots', 'tribrid'],
};
export const BUILD_PAIRS_2 = buildPairs(BUILD_BRACKETS_2, new Set(BUILD_PAIRS.map(p => [...p].sort().join(':'))));
// An account in a kit of scripts/pk-kits.ts at the levels of the kit (default maxed), with the quests of the kit's
// route done (kitVarps) and full special energy.
export const kitFixture = (kit: string, x: number, z = 3555): SaveConfig => ({
  position: {x, z, level: 0},
  skills: kitSkills(kit),
  varps: kitVarps(kit),
  ...kitItems(kit),
});
// One spar for each pair of kits, all at once at the mirror spot: `matchups` is side A's kit and side B's kit.
// A spar needs no npc far from its players: the engine of a spar case gives a turn only to an npc within about 64
// tiles of a player (patches/rs-sdk.md, item 10).
const SPAR_ENGINE = {SIM_NPC_NEAR: '64'};
// `at` moves the spot: side A at x, side B two tiles east.
const sparMatrix = (key: string, matchups: readonly (readonly [string, string])[], args: string[] = [], at: {x: number; z: number} = {x: 3094, z: 3555}): BenchCase => {
  // One character for each account after the first: up to 18 pairs.
  const letters = 'bcdefghijklmnopqrstuvwxyz0123456789'.slice(0, matchups.length * 2 - 1).split('');
  return {key, engineEnv: SPAR_ENGINE, script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', pass: ok, presetConfig: kitFixture(matchups[0]![0], at.x, at.z),
    scriptArgs: ['spar', '{bot:b}', '900', ...letters.slice(1).map(l => `{bot:${l}}`), `SPAR_KITS=${matchups.map(m => m.join(':')).join(',')}`, ...args],
    companions: letters.map((suffix, i) => ({suffix, preset: 'fresh_lumbridge', presetConfig: kitFixture(matchups[(i + 1) >> 1]![(i + 1) % 2]!, (i + 1) % 2 ? at.x + 2 : at.x, at.z)}))};
};
// `pairs` spars at once: the account of the run and its partner `b`, then partners `c` and `d`, `e` and `f`, and so on.
const sparBatch = (key: string, pairs: number, a: SaveConfig, b: SaveConfig, args: string[] = []): BenchCase => {
  // One character for each account after the first: up to 18 pairs.
  const letters = 'bcdefghijklmnopqrstuvwxyz0123456789'.slice(0, pairs * 2 - 1).split('');
  return {key, engineEnv: SPAR_ENGINE, script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['spar', '{bot:b}', '900', ...letters.slice(1).map(l => `{bot:${l}}`), ...args], pass: ok, presetConfig: a,
    companions: letters.map((suffix, i) => ({suffix, preset: 'fresh_lumbridge', presetConfig: i % 2 ? a : b}))};
};
const sparCase = (key: string, a: SaveConfig, b: SaveConfig, args: string[] = []): BenchCase =>
  ({key, engineEnv: SPAR_ENGINE, script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['spar', '{bot:b}', '900', ...args], pass: ok, presetConfig: a, companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: b}]});

const skiller = (skill: string, method: string, preset: string, args: string[] = [], extra: Partial<BenchCase> = {}): BenchCase =>
  ({key: `skiller:${skill}:${method}`, script: 'scripts/aio-skiller.ts', preset, scriptArgs: [skill, method, ...args], pass: ok, ...extra});

const ROUTE_CASES: BenchCase[] = [
  skiller('fishing', 'cage', 'gather_fish_catherby', ['cage', '1500'], {output: /totalCaught=(\d+)/}),
  skiller('smithing', 'smelt', 'smelt_bars_alkharid'),
  // Start states and arguments below come from each worker's proof or fleet fixture (the source is named per case).
  skiller('fishing', 'harpoon', 'gather_fish_catherby', ['harpoon', '1500'], {presetConfig: {position: {x: 2840, z: 3432, level: 0}, skills: {Fishing: 70}, inventory: [{id: 311, count: 1}]}}),
  skiller('cooking', 'food', 'cook_food_catherby', ['600', 'lobster']),
  // The default route of each skill runs for about 1,000 ticks, so its XP for each 1,000 ticks is a rate and not one unit of work.
  skiller('woodcutting', 'yews', 'gather_yews', ['1000', '200', 'MAX_TRIPS=4']),
  skiller('woodcutting', 'fresh45', 'wc_fresh', [], {timeoutMs: 900_000}),
  // The same 600 ticks at the knights with no guest action, with a bone buried in each stun, and with an enchant cast in each stun. Hitpoints 99, so a run of failed picks does not kill the account before the cap.
  skiller('thieving', 'stun-base', 'stun_base', ['600', 'MODE=base'], {presetConfig: {...PRESETS.stun_base!, skills: {...PRESETS.stun_base!.skills, Hitpoints: 99}}}),
  skiller('thieving', 'stun-bury', 'stun_bury', ['600', 'MODE=bury'], {presetConfig: {...PRESETS.stun_bury!, skills: {...PRESETS.stun_bury!.skills, Hitpoints: 99}}}),
  skiller('thieving', 'stun-enchant', 'stun_enchant', ['600', 'MODE=enchant'], {presetConfig: {...PRESETS.stun_enchant!, skills: {...PRESETS.stun_enchant!.skills, Hitpoints: 99}}}),
  skiller('fletching', 'arrows', 'fletch_arrows_bank', ['600', 'arrows', 'rune']),
  skiller('mining', 'ore', 'gather_ore_varrock', ['1500', '27', 'MAX_TRIPS=3'], {presetConfig: {position: {x: 3286, z: 3368, level: 0}, skills: {Mining: 50, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1275, count: 1}]}}),
  // scripts/measure/fleet-practice.ts `flax`
  skiller('crafting', 'bowstrings', 'spin_bowstrings_seers', ['1250', 'MAX_MAKE=56', 'RAW_RESERVE=50', 'MAX_TRIPS=4'], {presetConfig: {position: {x: 2727, z: 3492, level: 0}, skills: {Crafting: 13}, inventory: [{id: 1735, count: 1}, {id: 315, count: 1}, {id: 2309, count: 1}], bank: [{id: 1779, count: 106}, {id: 1737, count: 40}, {id: 1759, count: 25}, {id: 995, count: 5}]}}),
  skiller('crafting', 'legacy-jewelry', 'craft_jewelry_bank', ['300', 'cut', 'sapphire']),
  skiller('herblore', 'potions', 'brew_potions_bank', ['1000', 'auto', 'TARGET_LEVEL=78']),
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
  skiller('crafting', 'inventory', 'bank_gems', ['cut-dragonstone', 'MAX_MAKE=180', 'CAP=1100', 'MEMBERS=1']),
  // packages/practice/src/druid-meats-proof.ts
  skiller('herblore', 'meats', 'fresh_lumbridge', ['CAP=4000'], {timeoutMs: 900_000, presetConfig: {position: {x: 3092, z: 3242, level: 0}, skills: {Attack: 94, Strength: 83, Defence: 76, Hitpoints: 75}, equipment: [{id: 1289, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], inventory: [{id: 954, count: 1}, {id: 329, count: 2}], bank: [{id: 995, count: 1000}, {id: 590, count: 1}, {id: 1511, count: 13}, {id: 2132, count: 265}]}}),
  // packages/practice/src/rune-bank-craft-proof.ts
  skiller('runecraft', 'bank-craft', 'fresh_lumbridge', ['99', 'CAP=4000'], {presetConfig: {position: {x: 3013, z: 3355, level: 0}, varps: {63: 6, 101: 1, 281: 1000}, skills: {Attack: 47, Hitpoints: 33, Runecraft: 1}, bank: [{id: 1436, count: 30}, {id: 556, count: 25}, {id: 1438, count: 1}, {id: 1448, count: 1}], inventory: [{id: 556, count: 5}]}}),
  // packages/practice/src/magic-order-proof.ts `varrock`
  skiller('magic', 'order', 'fresh_lumbridge', ['TARGET_LEVEL=32', 'MAX_CASTS=5', 'RUNE_BUDGET=1000', 'CASH_RESERVE=10000', 'CAP=1500'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Magic: 31}, inventory: [{id: 333, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 1351, count: 1}], bank: [{id: 556, count: 25}, {id: 557, count: 4}, {id: 563, count: 5}, {id: 995, count: 14911}, {id: 1511, count: 5}]}}),
  skiller('prayer', 'bury', 'fresh_lumbridge', ['46', 'CAP=1000', 'MAX_BURY=175', 'BONE_RESERVE=6'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Prayer: 42}, bank: [{id: 526, count: 200}]}}),
  // packages/practice/src/goldfarm-order-proof.ts `entry99`
  skiller('thieving', 'knights-stable', 'fresh_lumbridge', ['TICKS=600', 'BANK_AT=50000'], {output: /coinsGained=(\d+)/, presetConfig: {position: {x: 2654, z: 3283, level: 0}, skills: {Thieving: 99, Hitpoints: 10}, inventory: [{id: 1265, count: 1}, {id: 590, count: 1}, {id: 995, count: 37}], equipment: [{id: 1277, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], bank: [{id: 995, count: 1000}, {id: 440, count: 5}, {id: 333, count: 10}, {id: 329, count: 4}, {id: 385, count: 3}]}}),
  // The baker spawns at 2654,3311, west of the stall. The start tile is east of the stall, so the stall blocks the baker's sight.
  skiller('thieving', 'stalls', 'fresh_lumbridge', ['stealing_bakery_stall', '1', '300'], {presetConfig: {position: {x: 2657, z: 3311, level: 0}, skills: {Thieving: 5}}}),
  // packages/practice/src/blood-chest-proof.ts `entry`
  skiller('thieving', 'blood-chest', 'fresh_lumbridge', ['2500', 'MAX_LOOTS=2', 'CAP=2500'], {timeoutMs: 900_000, presetConfig: {position: {x: 2584, z: 3337, level: 0}, skills: {Thieving: 99, Attack: 72, Hitpoints: 56, Agility: 60}, inventory: [{id: 1895, count: 1}, {id: 1895, count: 1}, {id: 1895, count: 1}, {id: 995, count: 40}], bank: [{id: 995, count: 1000}, {id: 314, count: 7}]}}),
  // scripts/measure/fleet-practice.ts `wool`
  skiller('foraging', 'wool', 'fresh_lumbridge', ['CAP=2200', 'MAX_TRIPS=3'], {presetConfig: {position: {x: 3207, z: 3218, level: 2}, inventory: [{id: 1735, count: 1}]}}),
  // Start states below were read from each worker's entry checks, proofs and the map files (not from a run).
  skiller('fishing', 'fishcook', 'fresh_lumbridge', ['MAX_CATCHES=2', 'TICKS=1500'], {presetConfig: {position: {x: 3239, z: 3251, level: 0}, skills: {Fishing: 99, Cooking: 99, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30, Fletching: 18}, inventory: [{id: 309, count: 1}, {id: 314, count: 300}, {id: 946, count: 1}, {id: 1511, count: 1}, {id: 1511, count: 1}]}}),
  skiller('fishing', 'village', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-village.json'], {presetConfig: {position: {x: 3094, z: 3491, level: 0}, skills: {Fishing: 20, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, bank: [{id: 309, count: 1}, {id: 314, count: 5}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-village.json': {method: 'fly', mode: 'DROP_RAW', target: 1, batch: 1, reserve: 0, cap: 1200, returnTicks: 300, xpRate: 25}}}),
  skiller('fishing', 'staged', 'fresh_lumbridge', ['fly', '1', '300'], {presetConfig: {position: {x: 3239, z: 3251, level: 0}, skills: {Fishing: 20, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 309, count: 1}, {id: 314, count: 5}]}}),
  skiller('fishing', 'fly30', 'fresh_lumbridge', ['CAP=1000'], {presetConfig: {position: {x: 3222, z: 3218, level: 0}, skills: {Fishing: 29, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 309, count: 1}, {id: 314, count: 10}, {id: 946, count: 1}, {id: 1511, count: 1}, {id: 1511, count: 1}, {id: 1511, count: 1}]}}),
  skiller('cooking', 'mixed-wine', 'fresh_lumbridge', ['MAX_MAKE=1', 'CAP=300'], {presetConfig: {position: {x: 3092, z: 3243, level: 0}, skills: {Cooking: 99}, bank: [{id: 1987, count: 1}, {id: 1937, count: 1}]}}),
  skiller('fletching', 'shafts', 'fresh_lumbridge', ['600', 'MAX_MAKE=1', 'LOG_RESERVE=0'], {presetConfig: {position: {x: 3092, z: 3243, level: 0}, inventory: [{id: 946, count: 1}], bank: [{id: 1511, count: 1}]}}),
  skiller('fletching', 'worker', 'fresh_lumbridge', ['--wood-job', '.practice/aio-bench/jobs/{bot}-wood.json'], {timeoutMs: 900_000, presetConfig: {position: {x: 3092, z: 3243, level: 0}, skills: {Fletching: 10, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1351, count: 1}], bank: [{id: 946, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-wood.json': {tree: 'normal', product: 'shortbow', string: false, finish: 'bank', maximum: 1, minimumHP: 10, cap: 2000, reserve: 0}}}),
  skiller('mining', 'essence', 'fresh_lumbridge', ['CAP=150', 'BANK_AT=28'], {presetConfig: {position: {x: 3253, z: 3420, level: 0}, varps: {63: 6}, inventory: [{id: 1265, count: 1}]}}),
  skiller('mining', 'at-site', 'fresh_lumbridge', ['iron_rock_table', '1', '300'], {presetConfig: {position: {x: 3286, z: 3368, level: 0}, skills: {Mining: 41, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1275, count: 1}]}}),
  skiller('mining', 'drop', 'fresh_lumbridge', ['iron_rock_table', '2', '400', '1275'], {presetConfig: {position: {x: 3286, z: 3368, level: 0}, skills: {Mining: 41, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1275, count: 1}]}}),
  skiller('mining', 'progressive', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-mine.json'], {presetConfig: {position: {x: 3286, z: 3368, level: 0}, skills: {Mining: 29, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}, inventory: [{id: 1265, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-mine.json': {maximum: 1, batch: 1, cap: 600, returnTicks: 100, travelTicks: 100, members: false, mode: 'drop', keep: [1265], routes: [{profile: 'iron_rock_table', bank: {x: 3253, z: 3420, level: 0}, site: {x: 3286, z: 3368, level: 0}, tool: 1265}]}}}),
  skiller('mining', 'loot', 'fresh_lumbridge', ['LOOT_MODE=list', 'LOOT_IDS=1511', 'RADIUS=2', 'MAX_UNITS=1', 'CAP=200', 'IDLE_TICKS=150'], {presetConfig: {position: {x: 3089, z: 3266, level: 0}, skills: {Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30}}}),
  skiller('smithing', 'anvil', 'fresh_lumbridge', ['600', 'PRODUCT_ID=1205', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, inventory: [{id: 2347, count: 1}], bank: [{id: 2349, count: 1}]}}),
  skiller('smithing', 'cannonballs', 'fresh_lumbridge', ['1', '600', 'CANNON_XP_RATE=25'], {presetConfig: {position: {x: 3269, z: 3167, level: 0}, skills: {Smithing: 35}, bank: [{id: 2353, count: 1}, {id: 4, count: 1}]}}),
  skiller('crafting', 'jewellery', 'fresh_lumbridge', ['gold_ring', '1', '200'], {presetConfig: {position: {x: 3274, z: 3186, level: 0}, skills: {Crafting: 5}, inventory: [{id: 2357, count: 1}, {id: 1592, count: 1}]}}),
  skiller('crafting', 'jewellery-trip', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-jewel.json'], {presetConfig: {position: {x: 3269, z: 3167, level: 0}, skills: {Crafting: 10}, bank: [{id: 2357, count: 1}, {id: 1592, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-jewel.json': {recipe: 'gold_ring', target: 1, batch: 1, cap: 800, returnTicks: 100, reserve: 0, members: false, stringAmulet: false, bank: {x: 3269, z: 3167, level: 0}, furnace: {x: 3275, z: 3186, level: 0}}}}),
  skiller('crafting', 'tanning', 'fresh_lumbridge', ['soft', '1', '80'], {presetConfig: {position: {x: 3276, z: 3193, level: 0}, inventory: [{id: 1739, count: 1}, {id: 995, count: 5}]}}),
  // From the Al Kharid bank with seven banked hides: six tanned, a needle and thread from Dommik, one set crafted and
  // banked, one hide left (scripts/black-dhide-sets.ts).
  skiller('crafting', 'black-dhide-sets', 'fresh_lumbridge', [], {pass: s => ok(s) && /sets=1 banked=1 bodies=1 chaps=1 vambraces=1 tanned=6 .*hidesLeft=1 /.test(s), timeoutMs: 600_000,
    presetConfig: {position: {x: 3269, z: 3167, level: 0}, skills: {Crafting: 84}, inventory: [{id: 385, count: 2}], bank: [{id: 1747, count: 7}, {id: 995, count: 400}]}}),
  skiller('crafting', 'soften-clay', 'fresh_lumbridge', ['CAP=500', 'MAX_MAKE=1', 'RAW_RESERVE=0'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, inventory: [{id: 1925, count: 1}], bank: [{id: 434, count: 1}]}}),
  skiller('crafting', 'progressive', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-prog.json'], {presetConfig: {position: {x: 3092, z: 3243, level: 0}, bank: [{id: 1511, count: 1}, {id: 946, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-prog.json': {mode: 'fletch', targetLevel: 99, maximum: 1, batch: 1, reserve: 0, cap: 600, members: false, bank: {x: 3092, z: 3243, level: 0}}}}),
  skiller('runecraft', 'supply', 'fresh_lumbridge', ['20', 'CAP=1500'], {presetConfig: {position: {x: 2843, z: 4832, level: 0}, skills: {Runecraft: 20, Mining: 20, Hitpoints: 16, Attack: 12, Defence: 11, Strength: 11}, varps: {63: 6, 101: 1, 281: 1000}, inventory: [{id: 1438, count: 1}, {id: 556, count: 26}, {id: 315, count: 1}, {id: 1436, count: 1}], equipment: [{id: 1265, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], bank: [{id: 556, count: 25}, {id: 995, count: 25}, {id: 1277, count: 1}, {id: 2140, count: 8}, {id: 2309, count: 1}, {id: 1351, count: 1}, {id: 590, count: 1}]}}),
  skiller('magic', 'items', 'fresh_lumbridge', ['enchant:sapphire_ring', '-', '3', '200'], {presetConfig: {position: {x: 3092, z: 3243, level: 0}, skills: {Magic: 7}, inventory: [{id: 564, count: 3}, {id: 555, count: 3}, {id: 1637, count: 1}, {id: 1637, count: 1}, {id: 1637, count: 1}]}}),
  skiller('magic', 'npc', 'fresh_lumbridge', ['wind_strike', '41', '1', '200'], {presetConfig: {position: {x: 3229, z: 3298, level: 0}, skills: {Magic: 50, Defence: 99, Hitpoints: 20}, equipment: [{id: 1381, count: 1, slot: 3}], inventory: [{id: 558, count: 10}, {id: 556, count: 10}]}}),
  skiller('magic', 'teleport', 'floor_tele25', ['varrock', '2', '100']),
  skiller('magic', 'trip', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-magic-trip.json'], {presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Magic: 25}, bank: [{id: 554, count: 5}, {id: 556, count: 15}, {id: 563, count: 5}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-magic-trip.json': {family: 'magic-teleport', recipe: 'varrock', target: 1, batch: 1, cap: 600, returnTicks: 200, members: false, bank: {x: 3185, z: 3436, level: 0}}}}),
  skiller('magic', 'orbs', 'fresh_lumbridge', ['earth', '1', '1500'], {timeoutMs: 900_000, presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Magic: 60, Hitpoints: 99, Prayer: 99, Defence: 99}, bank: [{id: 567, count: 1}, {id: 564, count: 3}, {id: 557, count: 30}, {id: 385, count: 6}, {id: 2434, count: 1}, {id: 2448, count: 1}, {id: 554, count: 1}, {id: 556, count: 3}, {id: 563, count: 1}]}}),
  skiller('magic', 'orbs-at-site', 'fresh_lumbridge', ['water', '1', '80'], {presetConfig: {position: {x: 2844, z: 3424, level: 0}, skills: {Magic: 56}, inventory: [{id: 567, count: 1}, {id: 564, count: 3}, {id: 555, count: 30}]}}),
  skiller('magic', 'bones', 'fresh_lumbridge', ['MAX_MAKE=3', 'CAP=300'], {presetConfig: {position: {x: 3092, z: 3243, level: 0}, skills: {Magic: 15}, inventory: [{id: 557, count: 2}, {id: 555, count: 2}, {id: 561, count: 1}], bank: [{id: 526, count: 3}]}}),
  skiller('magic', 'earth-production', 'fresh_lumbridge', ['craft', '1400', 'STOCK_TARGET=1', 'COIN_RESERVE=0'], {presetConfig: {position: {x: 3253, z: 3420, level: 0}, skills: {Runecraft: 20, Hitpoints: 30}, varps: {63: 6, 101: 1}, bank: [{id: 1440, count: 1}, {id: 1436, count: 1}]}}),
  skiller('prayer', 'flick', 'fresh_lumbridge', ['10', '1', '1500'], {presetConfig: {position: {x: 2654, z: 3283, level: 0}, skills: {Attack: 20, Strength: 1, Defence: 99, Hitpoints: 99, Prayer: 99, Agility: 99}, equipment: [{id: 1277, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], inventory: [{id: 333, count: 1}, {id: 333, count: 1}]}}),
  skiller('thieving', 'bootstrap55', 'fresh_lumbridge', ['TARGET=41', 'CAP=1000'], {presetConfig: {position: {x: 2654, z: 3304, level: 0}, skills: {Thieving: 40, Hitpoints: 50}}}),
  skiller('thieving', 'pickpocket', 'fresh_lumbridge', ['.practice/aio-bench/jobs/{bot}-pickpocket.json'], {presetConfig: {position: {x: 3094, z: 3491, level: 0}, skills: {Thieving: 99, Hitpoints: 99}, bank: [{id: 379, count: 10}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-pickpocket.json': {profile: 'man', food: 379, foodPerSuccess: 2, attemptsPerSuccess: 4, hpFloor: 10, eatAt: 20, xpRate: 25, target: 2, batch: 2, cap: 1500, returnTicks: 300, members: true, reserve: 0, bank: {x: 3094, z: 3491, level: 0}, site: {x: 3099, z: 3510, level: 0}}}}),
  skiller('thieving', 'pickpocket-at-site', 'fresh_lumbridge', ['man', '1', '3', '300', 'MEMBERS=1'], {presetConfig: {position: {x: 3099, z: 3510, level: 0}, skills: {Thieving: 99, Hitpoints: 99}}}),
  skiller('thieving', 'nature-chest', 'fresh_lumbridge', ['CHEST_X=2671', 'CHEST_Z=3301', 'CHEST_LEVEL=1', 'MAX_LOOTS=1', 'CAP=200'], {presetConfig: {position: {x: 2672, z: 3301, level: 1}, skills: {Thieving: 50}}}),
  skiller('foraging', 'feathers', 'fresh_lumbridge', ['TARGET=5', 'TICKS=600'], {presetConfig: {position: {x: 3228, z: 3297, level: 0}, skills: {Attack: 30, Strength: 30, Hitpoints: 20}}}),
  skiller('foraging', 'spawn', 'fresh_lumbridge', ['1059', '1', 'TICKS=600'], {presetConfig: {position: {x: 3094, z: 3491, level: 0}}}),
  skiller('foraging', 'care', 'quest_misc_weed', ['miscellania', '1', '200']),
  skiller('foraging', 'miscellania-coffer', 'fresh_lumbridge', ['1000', '200'], {presetConfig: {position: {x: 2500, z: 3857, level: 1}, coins: 5000, varps: {359: 100, 361: 1367343104, 362: -1073741824, 188: 15, 347: 10}}}),
  skiller('foraging', 'qol', 'fresh_lumbridge', ['prayer', '0', '10', '40'], {presetConfig: {position: {x: 3222, z: 3218, level: 0}, skills: {Prayer: 43}}}),
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
    presetConfig: {position: {x: 2545, z: 3144, level: 0}, skills: {Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60}, equipment: [{id: 1333, count: 1, slot: 3}, {id: 1113, count: 1, slot: 4}, {id: 1079, count: 1, slot: 7}], inventory: Array.from({length: 5}, () => ({id: 379, count: 1}))}},
  {key: 'fighter:ranged-gather', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['ranged-gather', 'CAP=1500', 'MAX_KILLS=2', 'AMMO=90', 'FOOD=3', 'FOOD_ID=333'], pass: s => ok(s) && s.includes('RANGED_BANK'),
    presetConfig: {position: {x: 3253, z: 3421, level: 0}, skills: {Ranged: 30, Hitpoints: 30}, bank: [{id: 841, count: 1}, {id: 884, count: 90}, {id: 333, count: 5}]}},
  {key: 'pvp:monitor', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['monitor', '50', '12', 'stop'], pass: ok},
  {key: 'quester:mode:chain', script: 'scripts/aio-quester.ts', preset: 'quest_cook', scriptArgs: ['chain', 'cook'], pass: ok,},
  // packages/practice/src/shop-supply-order-proof.ts
  {key: 'market:earth-shop', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['earth-shop', 'aubury', '1600', 'STOCK_TARGET=53', 'MAX_ITEMS=50', 'MAX_SPEND=2000', 'COIN_RESERVE=30000'], pass: ok,
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Attack: 49, Strength: 10, Defence: 11, Hitpoints: 35}, inventory: [{id: 1277, count: 1}], bank: [{id: 995, count: 352288}, {id: 554, count: 1482}, {id: 557, count: 3}, {id: 1521, count: 7}]}},
  {key: 'market:buy-sword', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['buy-sword', 'CAP=900', 'MAX_SPEND=2500'], pass: s => ok(s) && s.includes('OWNED_SWORD_BANK'),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, bank: [{id: 995, count: 5000}]}},
  // scripts/measure/fleet-practice.ts `courier`
  {key: 'logistics:food-courier', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['food-courier', 'OUTBOUND_ONLY=1', 'FEATHERS=0', 'CAP=1200'], pass: s => ok(s) && s.includes('outboundOnly=true'),
    presetConfig: {position: {x: 2654, z: 3283, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 40}, coins: 20380, inventory: [{id: 315, count: 1}, {id: 2309, count: 1}]}},
  {key: 'logistics:bank-sort', script: 'scripts/aio-logistics.ts', preset: 'bank_gems', scriptArgs: ['bank-sort', '200', '20', 'name'], pass: ok, presetConfig: {...PRESETS.bank_gems!, position: {x: 3092, z: 3242, level: 0}, bank: [{id: 1631, count: 270}, {id: 995, count: 50}, {id: 1511, count: 5}, {id: 314, count: 40}, {id: 2349, count: 3}]}},
  {key: 'logistics:relocate-bank', script: 'scripts/aio-logistics.ts', preset: 'bank_gems', scriptArgs: ['relocate-bank', 'CAP=1500'], pass: ok},
  {key: 'logistics:arrive-draynor', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['arrive-draynor', 'CAP=1250'], pass: ok},
  {key: 'fighter:imp', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['imp', 'CAP=1400', 'MAX_KILLS=1'], pass: ok, presetConfig: {position: {x: 2655, z: 3283, level: 0}, skills: {Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60}, equipment: [{id: 1277, count: 1, slot: 3}, {id: 1171, count: 1, slot: 5}], inventory: [{id: 333, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}, {id: 333, count: 1}]}},
  {key: 'fighter:fire-giant', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['fire-giant', 'CAP=1400'], pass: ok, presetConfig: {position: {x: 2619, z: 3332, level: 0}, skills: {Hitpoints: 99, Prayer: 99, Defence: 99}, varps: {65: 10}, bank: [{id: 294, count: 1}, {id: 329, count: 16}]}},
  {key: 'fighter:fire-combat', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['fire-combat', 'CAP=1600'], pass: ok, timeoutMs: 900_000, presetConfig: {position: {x: 2619, z: 3332, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 43}, varps: {65: 10}, bank: [{id: 295, count: 1}, {id: 954, count: 1}, {id: 329, count: 16}, {id: 1331, count: 1}, {id: 1171, count: 1}]}},
  {key: 'fighter:shade', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['shade', '.practice/aio-bench/jobs/{bot}-shade.json'], pass: ok, timeoutMs: 900_000, presetConfig: {position: {x: 3510, z: 3480, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99}, varps: {172: 1, 307: 110, 339: 85, 340: 1 << 29}, bank: [{id: 1289, count: 1}, {id: 1171, count: 1}, {id: 3465, count: 1}, {id: 2963, count: 1}, {id: 379, count: 4}, {id: 2434, count: 1}, {id: 2958, count: 80}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-shade.json': {xpRate: 25, target: 1, cap: 2000, returnTicks: 600, foodPerKill: 4, potionsPerKill: 1, pouchChargesPerTrip: 80, maximumDoses: 4, reserve: 0, wear: [{id: 1289, slot: 3, count: 1}, {id: 1171, slot: 5, count: 1}]}},},
  {key: 'fighter:ranged-starter', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['ranged-starter', 'CAP=1800'], pass: ok, timeoutMs: 900_000, presetConfig: {position: {x: 3094, z: 3106, level: 0}, varps: {281: 0}}},
  {key: 'fighter:ranged-camp', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['ranged-camp', '1400', 'STAGED=1'], pass: ok, presetConfig: {position: {x: 2895, z: 9792, level: 0}, skills: {Ranged: 99, Hitpoints: 99, Defence: 99}, equipment: [{id: 837, count: 1, slot: 3}, {id: 1540, count: 1, slot: 5}, {id: 877, count: 500, slot: 13}]}},
  {key: 'fighter:ranged', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['ranged', '11', '1500', 'MIN_ARROWS=30', 'BUY_ARROWS=0', 'AMMO=60', 'FOOD=3', 'FOOD_ID=333', 'KILLS_PER_TRIP=5', 'MAX_TRIPS=2'], pass: s => ok(s) && s.includes('mode=ranged-train'),
    presetConfig: {position: {x: 3253, z: 3421, level: 0}, skills: {Ranged: 10, Hitpoints: 30}, bank: [{id: 841, count: 1}, {id: 884, count: 90}, {id: 333, count: 5}]}},
  {key: 'fighter:chompy', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['chompy', '1', '1', '1500'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2614, z: 3093, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Prayer: 99}, varps: {293: 65},
      equipment: [{id: 1718, count: 1, slot: 2}, {id: 544, count: 1, slot: 4}, {id: 542, count: 1, slot: 7}],
      bank: [{id: 2883, count: 1}, {id: 2866, count: 32}, {id: 2434, count: 1}, {id: 2872, count: 1}]}},
  {key: 'fighter:chompy-at-site', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['chompy-at-site', '1', '1500', '5'], pass: ok,
    presetConfig: {position: {x: 2547, z: 2982, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99}, varps: {293: 65},
      equipment: [{id: 2883, count: 1, slot: 3}, {id: 2866, count: 50, slot: 13}], inventory: [{id: 2872, count: 1}]}},
  {key: 'fighter:loot-trip', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['loot-trip', '.practice/aio-bench/jobs/{bot}-loot-trip.json'], pass: ok,
    presetConfig: {position: {x: 3185, z: 3436, level: 0}},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-loot-trip.json': {target: 2, batch: 2, cap: 1200, returnTicks: 300, members: true, bank: {x: 3185, z: 3436, level: 0}, site: {x: 3152, z: 3399, level: 0}, policy: {mode: 'list', ids: [1573], names: [], minimumValue: 0, maximumValue: 2147483647, radius: 8, idleTicks: 20}}}},
  {key: 'boss:kbd', script: 'scripts/aio-boss.ts', preset: 'fresh_lumbridge', scriptArgs: ['kbd', 'STAGED=1', 'CAP=1000'], pass: ok,
    presetConfig: {position: {x: 2717, z: 9802, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Magic: 99, Prayer: 99},
      equipment: [{id: 1289, count: 1, slot: 3}, {id: 1113, count: 1, slot: 4}, {id: 1540, count: 1, slot: 5}, {id: 1079, count: 1, slot: 7}],
      inventory: [{id: 2448, count: 1}, {id: 2452, count: 1}, {id: 2436, count: 1}, {id: 2440, count: 1}, {id: 2434, count: 1}, {id: 2434, count: 1}, {id: 563, count: 1}, {id: 556, count: 3}, {id: 554, count: 1}, ...Array.from({length: 12}, () => ({id: 385, count: 1}))]}},
  // One kill from the corridor south of the cave, the hide and bones fetched (scripts/black-dragon-camp.ts STAGED=1).
  {key: 'boss:black-dragon', script: 'scripts/aio-boss.ts', preset: 'fresh_lumbridge', scriptArgs: ['black-dragon', '1500', 'STAGED=1', 'KILLS=1'], pass: s => ok(s) && /kills=1 hides=1 bones=1/.test(s), timeoutMs: 900_000,
    presetConfig: {position: {x: 2835, z: 9820, level: 0}, skills: {Ranged: 99, Hitpoints: 99, Defence: 99, Prayer: 60},
      equipment: [{id: 861, count: 1, slot: 3}, {id: 888, count: 400, slot: 13}], inventory: [{id: 385, count: 1}, {id: 385, count: 1}, {id: 385, count: 1}]}},
  {key: 'boss:trawler', script: 'scripts/aio-boss.ts', preset: 'fresh_lumbridge', scriptArgs: ['trawler', '2200'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2675, z: 3170, level: 0}, skills: {Fishing: 99, Crafting: 99, Hitpoints: 50}, inventory: [{id: 1941, count: 200}, {id: 583, count: 1}, ...Array.from({length: 10}, () => ({id: 954, count: 1}))]}},
  {key: 'boss:trawler-at-site', script: 'scripts/aio-boss.ts', preset: 'fresh_lumbridge', scriptArgs: ['trawler-at-site', 'trip', '2200'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2675, z: 3170, level: 0}, skills: {Fishing: 99, Crafting: 99, Hitpoints: 50}, inventory: [{id: 1941, count: 200}, {id: 583, count: 1}, ...Array.from({length: 10}, () => ({id: 954, count: 1}))]}},
  {key: 'pvp:standby', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['standby', 'stage'], pass: ok,
    presetConfig: {position: {x: 3252, z: 3420, level: 0}, skills: {Hitpoints: 11, Ranged: 7, Magic: 7}, bank: [{id: 841, count: 1}, {id: 882, count: 8}, {id: 556, count: 10}, {id: 558, count: 5}, {id: 1985, count: 1}, {id: 1277, count: 1}, {id: 1171, count: 1}]}},
  {key: 'pvp:stage-kit', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['stage-kit', '2000'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2809, z: 3441, level: 0}, bank: [{id: 995, count: 8352}, {id: 1277, count: 1}, {id: 1171, count: 1}, {id: 841, count: 1}, {id: 882, count: 25}, {id: 556, count: 25}, {id: 558, count: 15}, {id: 44, count: 3}]}},
  {key: 'pvp:special-swap', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['special-swap', '35', '1000', '60'], pass: ok,
    presetConfig: {position: {x: 3222, z: 3218, level: 0}, skills: {Hitpoints: 99, Attack: 99}, inventory: [{id: 35, count: 1}], varps: {172: 1, 300: 1000}}},
  {key: 'pvp:microbot-pvp', script: 'scripts/aio-pvp.ts', preset: 'fresh_lumbridge', scriptArgs: ['microbot-pvp', '{bot:b}', '.practice/aio-bench/jobs/{bot}-pvp-plan.json'], pass: ok,
    presetConfig: {position: {x: 3222, z: 3218, level: 0}, skills: {Hitpoints: 99}, varps: {172: 1}},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: {position: {x: 3223, z: 3218, level: 0}, skills: {Hitpoints: 99}, varps: {172: 1}}}],
    jobFiles: {'.practice/aio-bench/jobs/{bot}-pvp-plan.json': {cap: 60, hpFloor: 10, steps: [{kind: 'tank'}]}}},
  // Mirror spar at Wilderness level 5 (scripts/measure/pk-duel.ts start state): both sides maxed, in rune armour, with the
  // tribrid switches, Fire Wave and freeze runes, 2 prayer potions, 18 sharks and full special energy. SPAR_A and SPAR_B
  // (--set) choose the profile of each side.
  sparCase('pvp:spar', sparFixture(3094), sparFixture(3096)),
  // The mirror with Dragon Slayer not done: the loop must leave the rune platebody on, because the game does not let
  // such an account put it back.
  // Hill giants with Prayer 60: the prayer guard (packages/core/src/prayer-guard.ts) shows its counts in the
  // PRAYER_GUARD line; `--set PRAYER_GUARD=0` runs the comparison without it.
  {key: 'extra:giant-prayer-guard', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['giant', '1500', 'giant'], pass: ok, output: /kills=(\d+)/,
    presetConfig: {position: {x: 2545, z: 3144, level: 0}, skills: {Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60, Prayer: 60}, equipment: [{id: 1333, count: 1, slot: 3}, {id: 1113, count: 1, slot: 4}, {id: 1079, count: 1, slot: 7}], inventory: Array.from({length: 5}, () => ({id: 379, count: 1}))}},
  // The same fight with a 500 tick cap: the short run for a change to the guard.
  {key: 'extra:guard-giant-short', script: 'scripts/aio-fighter.ts', preset: 'fresh_lumbridge', scriptArgs: ['giant', '500', 'giant'], pass: ok, output: /kills=(\d+)/,
    presetConfig: {position: {x: 2545, z: 3144, level: 0}, skills: {Attack: 60, Strength: 60, Defence: 60, Hitpoints: 60, Prayer: 60}, equipment: [{id: 1333, count: 1, slot: 3}, {id: 1113, count: 1, slot: 4}, {id: 1079, count: 1, slot: 7}], inventory: Array.from({length: 5}, () => ({id: 379, count: 1}))}},
  // Chaos druids cast and hit in melee: the guard changes the protection prayer with the distance.
  {key: 'extra:guard-druid', script: 'scripts/aio-fighter.ts', preset: 'gather_combat_druid', scriptArgs: ['druid', '600', 'druid'], pass: ok, output: /kills=(\d+)/,
    presetConfig: {...PRESETS.gather_combat_druid!, skills: {...PRESETS.gather_combat_druid!.skills, Prayer: 60}}},
  // Iron at the Al Kharid mine at combat level 13, on the open tile west of two iron rocks (maps/m51_51.jm2): the
  // scorpions (level 14, hunt range 2) attack while the pick swings. A scorpion cannot reach the tile between the
  // three iron rocks at 3295,3310, so that tile tests no attack. With `--set PRAYER_GUARD=0` the worker dies here.
  {key: 'extra:guard-mine', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['mining', 'at-site', 'iron_rock_table', '25', '600'], pass: ok,
    presetConfig: {position: {x: 3302, z: 3310, level: 0}, skills: {Mining: 41, Hitpoints: 30, Prayer: 45}, inventory: [{id: 1275, count: 1}]}},
  // Thrower trolls on the Death Plateau path (level 67, hunt range 8, no too-strong rule) throw rocks at each player
  // in range. The worker stands still: the guard must turn Protect from Missiles on before the first rock.
  {key: 'extra:guard-thrower', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['300'], pass: ok,
    presetConfig: {position: {x: 2860, z: 3595, level: 0}, skills: {Hitpoints: 60, Defence: 60, Prayer: 60}}},
  // The script turns three prayers on and stands: the guard keeps them free with its two-tick flick.
  {key: 'extra:guard-three', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['300', 'PRAYERS=9,10,11'], pass: ok,
    presetConfig: {position: {x: 3222, z: 3218, level: 0}, skills: {Hitpoints: 60, Prayer: 60}}},
  // Fly fishing at Lumbridge with Protect from Melee on: the guard flicks and sends the click on the spot again.
  // With `--set PRAYER_GUARD=0` the prayer is held and the run shows the same catch at the normal point cost.
  // With `--set GUARD_STAND_FISH=riverBait:4` the run uses the rod and bait.
  {key: 'extra:guard-fish', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['500', 'PRAYERS=14', 'FISH=fly:8'], pass: ok,
    presetConfig: {position: {x: 3239, z: 3251, level: 0}, skills: {Fishing: 50, Hitpoints: 60, Prayer: 60}, inventory: [{id: 309, count: 1}, {id: 314, count: 60}, {id: 307, count: 1}, {id: 313, count: 60}]}},
  // Two accounts at Wilderness level 11, 7 combat levels apart. The second one attacks with a rune scimitar: the
  // guard of the first must turn Protect Item and Protect from Melee on.
  {key: 'extra:guard-rival', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['200', 'RIVAL={bot:b}'], pass: ok,
    presetConfig: {position: {x: 3200, z: 3600, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 60, Prayer: 60}, equipment: [{id: 1333, count: 1, slot: 3}]},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: {position: {x: 3201, z: 3600, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 60}, equipment: [{id: 1333, count: 1, slot: 3}]}}]},
  // The same two accounts 3 tiles apart: the second one shoots with a shortbow, so the guard must turn Protect
  // from Missiles on.
  {key: 'extra:guard-rival-bow', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['200', 'RIVAL={bot:b}'], pass: ok,
    presetConfig: {position: {x: 3200, z: 3600, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 60, Prayer: 60}, equipment: [{id: 1333, count: 1, slot: 3}]},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: {position: {x: 3203, z: 3600, level: 0}, skills: {Ranged: 50, Defence: 40, Hitpoints: 60}, equipment: [{id: 841, count: 1, slot: 3}, {id: 882, count: 500, slot: 13}]}}]},
  // The second account wears a staff of air and casts Wind Strike from 3 tiles: the guard must turn Protect from
  // Magic on.
  {key: 'extra:guard-rival-staff', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['200', 'RIVAL={bot:b}', 'RIVAL_SPELL=magic:wind_strike'], pass: ok,
    presetConfig: {position: {x: 3200, z: 3600, level: 0}, skills: {Attack: 40, Strength: 40, Defence: 40, Hitpoints: 60, Prayer: 60}, equipment: [{id: 1333, count: 1, slot: 3}]},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: {position: {x: 3203, z: 3600, level: 0}, skills: {Magic: 50, Defence: 40, Hitpoints: 60}, equipment: [{id: 1381, count: 1, slot: 3}], inventory: [{id: 558, count: 500}]}}]},
  // Lobster cages on the Karamja dock (maps/m45_49.jm2) with Protect from Melee on: the fishing cycle on a spot with
  // two options. With `--set GUARD_STAND_FISH=harpoon:4` the run uses the harpoon.
  {key: 'extra:guard-fish-cage', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['500', 'PRAYERS=14', 'FISH=cage:6'], pass: ok,
    presetConfig: {position: {x: 2924, z: 3178, level: 0}, skills: {Fishing: 60, Hitpoints: 60, Prayer: 60}, inventory: [{id: 301, count: 1}, {id: 311, count: 1}]}},
  // The dark wizards south of Varrock (maps/m50_52.jm2) at combat level 13: the young ones (level 7, hunt range 3)
  // and the bearded ones (level 20, hunt range 5) cast strike spells. The worker stands on an open tile of their circle: a hunt needs a line of sight
  // (hunt `ranged`, check_vis=lineofsight), and the centre tiles have none. With `--set PRAYER_GUARD=0` the worker dies.
  {key: 'extra:guard-wizard', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['300'], pass: ok,
    presetConfig: {position: {x: 3226, z: 3372, level: 0}, skills: {Hitpoints: 30, Prayer: 45}}},
  // Oaks west of Lumbridge castle (maps/m50_50.jm2) with Protect from Melee on: the guard flicks and sends the
  // click on the tree again. With `--set PRAYER_GUARD=0` the prayer is held at the normal point cost.
  {key: 'extra:guard-chop', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['500', 'PRAYERS=14', 'CHOP=oak:8'], pass: ok,
    presetConfig: {position: {x: 3205, z: 3243, level: 0}, skills: {Woodcutting: 50, Hitpoints: 60, Prayer: 60}, inventory: [{id: 1359, count: 1}]}},
  // Draynor (maps/m48_50.jm2) at combat level 13: two young dark wizards (level 7, hunt range 3) stand at the
  // willows. Willows with a bronze axe under their spells. With `--set GUARD_STAND_RETALIATE=off` the run shows the
  // same work with auto-retaliate off.
  {key: 'extra:guard-chop-wizard', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['500', 'CHOP=willow:12'], pass: ok,
    presetConfig: {position: {x: 3086, z: 3238, level: 0}, skills: {Woodcutting: 30, Hitpoints: 30, Prayer: 45}, inventory: [{id: 1351, count: 1}]}},
  // Net fishing on the Al Kharid shore (maps/m51_49.jm2) at combat level 13, where a scorpion (level 14, hunt range 2)
  // wanders to the fishing spots.
  {key: 'extra:guard-fish-scorpion', script: 'scripts/measure/guard-stand.ts', preset: 'fresh_lumbridge', scriptArgs: ['500', 'FISH=net:12'], pass: ok,
    presetConfig: {position: {x: 3278, z: 3143, level: 0}, skills: {Fishing: 50, Hitpoints: 30, Prayer: 45}, inventory: [{id: 303, count: 1}]}},
  // Hill giants with Hitpoints 20, no armour and no eat input from the script: the eat guard
  // (packages/core/src/eat-guard.ts) must eat lobsters, and the account must live. The first 5 slots hold edible
  // items that are not plain food (cake, cheese, bread, redberry pie, stew): the guard must eat none of them.
  // `--set EAT_GUARD=0` runs the comparison.
  {key: 'extra:giant-eat-guard', script: 'scripts/measure/eat-guard-fight.ts', preset: 'fresh_lumbridge', scriptArgs: ['600'], pass: s => ok(s) && /^EAT_GUARD \{"eats":[1-9]/m.test(s) && / otherKept=5\/5 /.test(s), output: /kills=(\d+)/,
    presetConfig: {position: {x: 2545, z: 3144, level: 0}, skills: {Attack: 40, Strength: 40, Hitpoints: 20}, equipment: [{id: 1333, count: 1, slot: 3}], inventory: [...[1891, 1985, 2309, 2325, 2003].map(id => ({id, count: 1})), ...Array.from({length: 20}, () => ({id: 379, count: 1}))]}},
  sparCase('extra:spar-no-slayer', sparFixture(3094, 3555, {noDragonSlayer: true}), sparFixture(3096, 3555, {noDragonSlayer: true})),
  // The tribrid against every build of scripts/pk-kits.ts in one run, and a mirror of 8 for each build: the cases that
  // the hill climb and the kit matrix run (scripts/measure/pk-spar-climb.ts, pk-spar-matrix.ts).
  sparMatrix('extra:spar-kits-x8', [['tribrid', 'tribrid'], ['tribrid', 'tribrid-pots'], ['tribrid', 'melee'], ['tribrid', 'ranger'], ['tribrid', 'mage'],
    ['tribrid', 'tribrid-adamant'], ['tribrid', 'tribrid-mithril'], ['tribrid-pots', 'tribrid-pots']]),
  ...Object.keys(KITS).map(kit => sparMatrix(`extra:spar-kit-${kit}-x8`, Array.from({length: 8}, () => [kit, kit] as const))),
  // The league: our fighter (the tribrid with potions, side A, profile SPAR_A) against eight opponents that each have
  // their own build and their own way to play (LEAGUE). A fighter is ready for a skilled player when it beats them all.
  sparMatrix('extra:spar-league-x8', LEAGUE.map(o => ['tribrid-pots', o.kit] as const), [`SPAR_B_PROFILES=${LEAGUE.map(o => o.profile).join(',')}`]),
  // The champion against itself in the snare kit: the hardest opponent on the bench. Use SPAR_SWAP=1.
  // Our fighter (the hybrid kit, the hunter's bow trip) against the Defence 99 range tank, at Wilderness level 34 so
  // that combat 126 can attack combat 102. Sides by two pairs at a time.
  sparMatrix('extra:spar-duel-hybrid-tank-range-x12', Array.from({length: 12}, (_, i) => ((i >> 1) % 2 ? ['tank-range', 'hybrid'] : ['hybrid', 'tank-range']) as [string, string]), [], {x: 3125, z: 3790}),
  // The snare kit against the hybrid kit, sides by two pairs at a time.
  sparMatrix('extra:spar-duel-snare-hybrid-x12', Array.from({length: 12}, (_, i) => ((i >> 1) % 2 ? ['hybrid', 'tribrid-snare'] : ['tribrid-snare', 'hybrid']) as [string, string])),
  sparMatrix('extra:spar-mirror-snare-x12', Array.from({length: 12}, () => ['tribrid-snare', 'tribrid-snare'] as const)),
  sparMatrix('extra:spar-league-snare-x8', LEAGUE.map(o => ['tribrid-snare', o.kit] as const), [`SPAR_B_PROFILES=${LEAGUE.map(o => o.profile).join(',')}`]),
  // The league for a fighter with three more sharks and no freeze runes.
  // The builds that beat the tribrid on food: four spars each against the melee build, the hybrid and the ranger.
  sparMatrix('extra:spar-rivals-x12', Array.from({length: 12}, (_, i) => ['tribrid-pots', ['melee', 'hybrid', 'ranger'][i % 3]!] as const)),
  // One whole hunter trip (scripts/measure/pk-hunt-trip.ts): the hunter starts at Edgeville bank with an empty pack and
  // its kit in the bank; the target stands at the first hunt spot with no food.
  // `auto` has the snare stock and names no kit: at the first hunt spot (Wilderness level 3) the hunter must pick the
  // bow trip from its bank.
  ...(['staff', 'snare', 'auto'] as const).map((kit): BenchCase => ({key: `extra:hunt-trip-${kit}`, engineEnv: SPAR_ENGINE, script: 'scripts/measure/pk-hunt-trip.ts', preset: 'fresh_lumbridge',
    scriptArgs: ['{bot:b}', '900', kit], pass: kit === 'auto' ? s => ok(s) && /HUNT trip bow/.test(s) : ok, output: /kills=(\d+)/,
    presetConfig: {...sparFixture(3092, 3496), inventory: [], bank: [{id: 861, count: 1}, {id: 557, count: 200}, {id: 555, count: 200}, {id: 561, count: 100}, {id: 2434, count: 4}, {id: 1712, count: 2},
      {id: 2436, count: 2}, {id: 2440, count: 2}, {id: 2444, count: 2}, {id: 385, count: 60}, ...(kit === 'staff' ? [{id: 1401, count: 1}, {id: 556, count: 600}, {id: 565, count: 200}] : [])]},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: sparFixture(3094, 3540, {food: 0})}]})),
  // A hunter in each kit against a target that leaves by its glory at 60 health, at Wilderness level 34.
  ...['tribrid-pots', 'tribrid-snare'].map(kit => sparMatrix(`extra:spar-escape-${kit}-x8`, Array.from({length: 8}, () => [kit, 'runner'] as const), ['SPAR_SCENARIO=escape'], {x: 3125, z: 3790})),
  sparMatrix('extra:spar-escape-tribrid-snare-x12', Array.from({length: 12}, () => ['tribrid-snare', 'runner'] as const), ['SPAR_SCENARIO=escape'], {x: 3125, z: 3790}),
  // The same rivals against the kits with more food.
  ...['tribrid-snare', 'tribrid-snare-addy', 'hybrid'].map(kit => sparMatrix(`extra:spar-rivals-${kit}-x12`, Array.from({length: 12}, (_, i) => [kit, ['melee', 'hybrid', 'ranger'][i % 3]!] as const))),
  sparMatrix('extra:spar-league-lean-x8', LEAGUE.map(o => ['tribrid-lean', o.kit] as const), [`SPAR_B_PROFILES=${LEAGUE.map(o => o.profile).join(',')}`]),
  // A build against the standard tribrid, four pairs on each side of the map: what the build is worth by itself.
  ...Object.keys(KITS).filter(kit => kit !== 'melee' && !KITS[kit]!.skills).map(kit => sparMatrix(`extra:spar-duel-${kit}-vs-melee-x8`, Array.from({length: 8}, (_, i) => ((i >> 1) % 2 ? ['melee', kit] : [kit, 'melee']) as [string, string]))),
  ...Object.keys(KITS).filter(kit => kit !== 'tribrid' && !KITS[kit]!.skills).map(kit => sparMatrix(`extra:spar-duel-${kit}-x8`, Array.from({length: 8}, (_, i) => ((i >> 1) % 2 ? ['tribrid', kit] : [kit, 'tribrid']) as [string, string]))),
  // A pure against a combat-3 skiller, 4 pairs. The spot is deep enough for the combat gap (pvp_combat.rs2:32-41):
  // Wilderness level 34 for combat 27 and 19, level 45 for combat 46. A maxed opponent is out of a pure's range at
  // the mirror spot, so a build with its own levels has no duel against the tribrid or the melee kit.
  ...(['pure-iban', 'pure-bolt'] as const).map(kit => sparMatrix(`extra:spar-${kit}-vs-skiller-x4`, Array.from({length: 4}, () => [kit, 'skiller'] as const), [], {x: 3125, z: 3790})),
  sparMatrix('extra:spar-pure-rock-vs-skiller-x4', Array.from({length: 4}, () => ['pure-rock', 'skiller'] as const), [], {x: 3055, z: 3872}),
  // The trained builds against each other, 14 pairs in a case, at Wilderness level 34 (the widest combat gap of a
  // bracket is 27). `bun scripts/measure/pk-spar-matrix.ts --case <key>` runs one. A case of 8 pairs takes 34 s, and
  // about half of that is the start of the engine and the logins, so the 53 pairs stand in 4 cases. The pairs run in
  // 8 processes, and the cap is 600 ticks: the offline simulator has no fight of two of these builds that lasts so long.
  ...Array.from({length: Math.ceil(BUILD_PAIRS.length / BUILD_CASE_PAIRS)}, (_, n) => sparMatrix(`extra:spar-builds-${n + 1}`, BUILD_PAIRS.slice(n * BUILD_CASE_PAIRS, (n + 1) * BUILD_CASE_PAIRS), ['SPAR_PROCS=8', 'SPAR_CAP=600'], {x: 3125, z: 3790})),
  // One pair 14 times, each build on side A in 7 of them: 3 fights of a pair in the build cases decide nothing.
  sparMatrix('extra:spar-head-tank-dragon-x14', Array.from({length: 14}, (_, i) => (i % 2 ? ['dragon', 'tank-range'] : ['tank-range', 'dragon']) as [string, string]), ['SPAR_PROCS=8', 'SPAR_CAP=600'], {x: 3125, z: 3790}),
  ...Array.from({length: Math.ceil(BUILD_PAIRS_2.length / BUILD_CASE_PAIRS)}, (_, n) => sparMatrix(`extra:spar-builds2-${n + 1}`, BUILD_PAIRS_2.slice(n * BUILD_CASE_PAIRS, (n + 1) * BUILD_CASE_PAIRS), ['SPAR_PROCS=8', 'SPAR_CAP=600'], {x: 3125, z: 3790})),
  // Map cases of the spar. Gap: the same mirror from 12 tiles apart. Trees: 6 tiles apart at Wilderness level 3 with a
  // blocker on tiles 3101-3103 between the two, so neither has line of sight at the start. Escape: Wilderness level 34
  // at a spot with no monster in view (green dragons at (3094, 3800) attack both sides and block their hits); side B
  // has 3 sharks and a glory and runs south to level 30 to rub it, and side A must kill it first.
  sparCase('extra:spar-gap', sparFixture(3088), sparFixture(3100)),
  sparCase('extra:spar-trees', sparFixture(3099, 3536), sparFixture(3105, 3536)),
  sparCase('extra:spar-escape', sparFixture(3125, 3790), sparFixture(3127, 3790, {food: 3, glory: true}), ['SPAR_SCENARIO=escape']),
  // Eight glory chases at once in one world, at the same spot: eight samples for the ticks of one.
  sparBatch('extra:spar-escape-x8', 8, sparFixture(3125, 3790), sparFixture(3127, 3790, {food: 3, glory: true}), ['SPAR_SCENARIO=escape']),
  sparBatch('extra:spar-x8', 8, sparFixture(3094), sparFixture(3096)),
  // 16 pairs in 8 worker processes: twice the fights of the x8 batch in about the same time.
  sparBatch('extra:spar-x16', 16, sparFixture(3094), sparFixture(3096), ['SPAR_PROCS=8']),
  sparBatch('extra:spar-escape-spell-x8', 8, sparFixture(3125, 3790), sparFixture(3127, 3790, {food: 3, teleport: true}), ['SPAR_SCENARIO=escape-spell']),
  sparBatch('extra:spar-escape-spell-pots-x8', 8, sparFixture(3125, 3790, {potions: true}), sparFixture(3127, 3790, {food: 3, teleport: true}), ['SPAR_SCENARIO=escape-spell']),
  sparBatch('extra:spar-escape-god-x8', 8, sparFixture(3125, 3790, {god: true}), sparFixture(3127, 3790, {food: 3, glory: true}), ['SPAR_SCENARIO=escape-god']),
  sparBatch('extra:spar-escape-spell-god-x8', 8, sparFixture(3125, 3790, {god: true}), sparFixture(3127, 3790, {food: 3, teleport: true}), ['SPAR_SCENARIO=escape-spell-god']),
  sparBatch('extra:spar-flee-x8', 8, sparFixture(3125, 3790, {food: 3, glory: true}), sparFixture(3127, 3790, {potions: true}), ['SPAR_SCENARIO=flee']),
  sparBatch('extra:spar-escape-pots-x8', 8, sparFixture(3125, 3790, {potions: true}), sparFixture(3127, 3790, {food: 3, glory: true}), ['SPAR_SCENARIO=escape']),
  // The glory chase with boost potions on the hunter.
  sparCase('extra:spar-escape-pots', sparFixture(3125, 3790, {potions: true}), sparFixture(3127, 3790, {food: 3, glory: true}), ['SPAR_SCENARIO=escape']),
  // The same chase with no glory on the runner: it runs about 110 tiles to level 20 and casts Varrock Teleport.
  sparCase('extra:spar-escape-spell', sparFixture(3125, 3790), sparFixture(3127, 3790, {food: 3, teleport: true}), ['SPAR_SCENARIO=escape-spell']),
  {key: 'quester:mode:order', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['order', 'cook', '--save={save}', '--timeout-ms=300000'], pass: s => ok(s) && /QUEST_ORDER_RESULT \{"ok":true/.test(s),
    presetConfig: {position: {x: 3208, z: 3214, level: 0}, inventory: [{id: 1944, count: 1}, {id: 1927, count: 1}, {id: 1933, count: 1}, {id: 1351, count: 1}, {id: 995, count: 37}], bank: [{id: 1351, count: 2}, {id: 995, count: 100}, {id: 1511, count: 8}], equipment: [{id: 1205, count: 1, slot: 3}]}},
  {key: 'quester:mode:items', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['items', 'cook', '--save={save}', 'CAP=600'], pass: s => ok(s) && /QUEST_ITEMS_ORDER_RESULT \{"ok":true/.test(s),
    presetConfig: {position: {x: 3092, z: 3243, level: 0}, bank: [{id: 1944, count: 1}, {id: 1927, count: 1}, {id: 1933, count: 1}]}},
  {key: 'quester:mode:cook-job', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['cook-job', 'CAP=1500'], pass: s => ok(s) && /QUEST_COOK_JOB_RESULT \{"ok":true/.test(s),
    presetConfig: {position: {x: 3092, z: 3243, level: 0}, bank: [{id: 1944, count: 1}, {id: 1927, count: 1}, {id: 1933, count: 1}], varps: {4: -1, 9: -1, 13: -1, 16: -1, 28: -1, 64: -1, 181: -1, 209: -1}}},
  // From the Taverley dungeon ladder: the Jailer, Velrak's cell, the key, back up (scripts/dusty-key.ts).
  {key: 'quester:mode:dusty-key', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['dusty-key'], pass: s => ok(s) && s.includes('dustyKey=1'), timeoutMs: 900_000,
    presetConfig: {position: {x: 2884, z: 3398, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99}, equipment: [{id: 1331, count: 1, slot: 3}], inventory: Array.from({length: 4}, () => ({id: 385, count: 1}))}},
  {key: 'quester:mode:seaslug-leave', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['seaslug-leave', 'CAP=600'], pass: ok,
    presetConfig: {position: {x: 2782, z: 3273, level: 0}, skills: {Hitpoints: 60}, varps: {159: 12}}},
  {key: 'quester:mode:tbwt-owned', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['tbwt-owned', '6000'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2781, z: 3086, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Ranged: 99, Magic: 99, Prayer: 99, Agility: 99, Cooking: 99, Fishing: 99}, varps: {175: 12},
      equipment: [{id: 579, count: 1, slot: 0}, {id: 1381, count: 1, slot: 3}, {id: 577, count: 1, slot: 4}, {id: 1540, count: 1, slot: 5}, {id: 1011, count: 1, slot: 7}],
      inventory: [{id: 3150, count: 21}, {id: 3032, count: 1}, {id: 3171, count: 1}, {id: 3128, count: 1}, {id: 3164, count: 1}, {id: 401, count: 1}, {id: 379, count: 1}, {id: 558, count: 25}]}},
  {key: 'quester:mode:watchtower-owned', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['watchtower-owned', 'WATCHTOWER_CAP=6000'], pass: ok, timeoutMs: 900_000,
    presetConfig: {position: {x: 2548, z: 3118, level: 0}, skills: {Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Magic: 99, Mining: 99, Herblore: 99, Thieving: 99, Agility: 99}, varps: {172: 1},
      equipment: [{id: 1163, count: 1, slot: 0}, {id: 1289, count: 1, slot: 3}, {id: 1127, count: 1, slot: 4}, {id: 1540, count: 1, slot: 5}, {id: 1079, count: 1, slot: 7}],
      inventory: [{id: 995, count: 20}, {id: 954, count: 1}, {id: 954, count: 1}, {id: 536, count: 1}, {id: 2357, count: 1}, {id: 560, count: 1}, {id: 91, count: 1}, {id: 247, count: 1}, {id: 2391, count: 1}, {id: 33, count: 1}, {id: 1265, count: 1}, ...Array.from({length: 8}, () => ({id: 385, count: 1}))]}},
  {key: 'quester:mode:clue', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['clue', '3511', '60'], pass: ok,
    presetConfig: {position: {x: 3222, z: 3218, level: 0}, inventory: [{id: 3511, count: 1}]}},
  {key: 'quester:mode:clue-puzzle', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['clue-puzzle', '2795', '400'], pass: ok,
    presetConfig: {position: {x: 3222, z: 3218, level: 0}, inventory: [{id: 2795, count: 1}]}},
  {key: 'quester:mode:clue-guardian', script: 'scripts/aio-quester.ts', preset: 'fresh_lumbridge', scriptArgs: ['clue-guardian', '2743', 'fire_blast', '30', '400'], pass: ok,
    presetConfig: {position: {x: 3168, z: 3677, level: 0}, skills: {Hitpoints: 99, Defence: 99, Magic: 99, Prayer: 99}, varps: {172: 1},
      equipment: [{id: 1381, count: 1, slot: 3}, {id: 1540, count: 1, slot: 5}],
      inventory: [{id: 2743, count: 1}, {id: 952, count: 1}, {id: 2574, count: 1}, {id: 2575, count: 1}, {id: 2576, count: 1}, ...Array.from({length: 4}, () => ({id: 379, count: 1})), {id: 554, count: 151}, {id: 556, count: 123}, {id: 560, count: 30}, {id: 563, count: 1}]}},
  {key: 'market:shop-trip', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['shop-trip', '.practice/aio-bench/jobs/{bot}-shop-trip.json'], pass: ok,
    presetConfig: {position: {x: 3269, z: 3167, level: 0}, bank: [{id: 1277, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-shop-trip.json': {merchant: 'alkharid-general', item: 1277, minimumUnit: 1, target: 1, batch: 1, cap: 800, returnTicks: 200, members: true}}},
  {key: 'logistics:loadout', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['loadout', '.practice/aio-bench/jobs/{bot}-loadout.json'], pass: ok,
    presetConfig: {position: {x: 3092, z: 3243, level: 0}, bank: [{id: 1351, count: 1}, {id: 1171, count: 1}]},
    jobFiles: {'.practice/aio-bench/jobs/{bot}-loadout.json': {bank: {x: 3092, z: 3243, level: 0}, pack: [{id: 1351, count: 1}], wear: [{id: 1171, count: 1, slot: 5}], cap: 300, maximumMoves: 64}}},
  {key: 'quester:mode:sweep', script: 'scripts/aio-quester.ts', preset: 'quest_cook', scriptArgs: ['sweep', 'cook'], pass: ok},
  {key: 'market:shop-buy', script: 'scripts/aio-market.ts', preset: 'shop_catherby', scriptArgs: ['shop-buy'], pass: ok},
  {key: 'logistics:walk-to', script: 'scripts/aio-logistics.ts', preset: 'fresh_lumbridge', scriptArgs: ['walk-to', '3092', '3243', '0'], pass: ok},
];

// Cases outside the catalog keys: the direct worker and master-dispatcher twins of one route, and bank-job profiles.
const EXTRA_CASES: BenchCase[] = [
  {key: 'extra:direct-quest-cook', script: 'scripts/generated/quest-cook.ts', preset: 'quest_cook', scriptArgs: [], pass: s => ok(s) && s.includes('Cook flag=complete')},
  {key: 'extra:master-quest-cook', script: 'scripts/aio.ts', preset: 'quest_cook', scriptArgs: ['quester', 'sweep', 'cook'], pass: ok},
  {key: 'extra:bank-job-cook-lobster', script: 'scripts/aio-skiller.ts', preset: 'cook_food_catherby', scriptArgs: ['bank-job', COOK_JOB_PATH], pass: s => ok(s) && s.includes('cooking_generic_lobster')},
  // Jakut's dragon longswords in Zanaris (scripts/shop-buyer.ts profile jukat) from Ardougne with Lost City done: the
  // Dramen staff, the coins and the doorman's diamond from the bank, the Lumbridge swamp shed door, the shelf of 2 and one restock for the
  // third sword, the ladder out, the rune scimitar it wore wielded again and the Al Kharid bank.
  {key: 'extra:shop-jukat', script: 'scripts/aio-market.ts', preset: 'fresh_lumbridge', scriptArgs: ['shop-buy', 'jukat', '4000', 'STOCK_TARGET=3', 'STOP_AT_TARGET=1', 'BANK_AT=0', 'NO_BUY_TICKS=600', 'STALL_TICKS=0', 'COIN_RESERVE=5000', 'FLOAT=400000'],
    pass: s => ok(s) && /boughtTotal=3 bankedTotal=3 /.test(s) && /realm-leave t=\d+ out=1 weapon=1333/.test(s), timeoutMs: 900_000,
    presetConfig: {position: {x: 2581, z: 3298, level: 0}, varps: {147: 6}, skills: {Attack: 60}, equipment: [{id: 1333, count: 1, slot: 3}], bank: [{id: 772, count: 1}, {id: 995, count: 400000}, {id: 1601, count: 1}]}},
  // The same shelf with a second buyer at Jakut that has taken both swords (scripts/measure/shop-rival.ts), and
  // BLIND_BUY=1: the account buys the two units that come back. `rival-look`: the rival logged in first, so the engine
  // runs it first in each tick, and buys in each tick that its shelf shows stock. `rival-blind`: the rival logged in
  // second and sends a buy request each tick. `rival-ahead`: that rival logged in first, takes each unit in the tick the
  // account's request arrives too, and the account ends its wait with nothing.
  ...([['look', 'look', 'first', 2], ['blind', 'blind', 'last', 2], ['ahead', 'blind', 'first', 0]] as const).map(([name, mode, order, units]): BenchCase => ({key: `extra:shop-jukat-rival-${name}`, script: 'scripts/measure/shop-rival.ts', preset: 'fresh_lumbridge',
    scriptArgs: ['{bot:b}', order, mode, 'shop-buy', 'jukat', '4000', 'BLIND_BUY=1', 'STOCK_TARGET=2', 'STOP_AT_TARGET=1', 'BANK_AT=0', 'NO_BUY_TICKS=1200', 'STALL_TICKS=0', 'COIN_RESERVE=5000', 'FLOAT=400000'],
    pass: s => ok(s) && s.includes(`boughtTotal=${units} bankedTotal=${units} `) && s.includes(units ? 'stop=stock-target' : 'stop=stock-wait') && s.includes('rival end') && s.includes('out=1'), timeoutMs: 900_000,
    presetConfig: {position: {x: 2581, z: 3298, level: 0}, varps: {147: 6}, bank: [{id: 772, count: 1}, {id: 995, count: 400000}, {id: 1601, count: 1}]},
    companions: [{suffix: 'b', preset: 'fresh_lumbridge', presetConfig: {position: {x: 3252, z: 9573, level: 0}, varps: {147: 6}, inventory: [{id: 995, count: 3000000}]}}]})),
  // Rune armour at the Varrock West anvils from banked runite bars: chainbody 3 bars, platelegs 3, full helm 2, kiteshield 3.
  {key: 'extra:smith-rune-chainbody', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['smithing', 'anvil', '600', 'PRODUCT_ID=1113', 'MAX_MAKE=1', 'BAR_RESERVE=0'], pass: s => ok(s) && /"made":1,"banked":1/.test(s),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Smithing: 99}, inventory: [{id: 2347, count: 1}], bank: [{id: 2363, count: 3}]}},
  {key: 'extra:smith-rune-platelegs', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['smithing', 'anvil', '600', 'PRODUCT_ID=1079', 'MAX_MAKE=1', 'BAR_RESERVE=0'], pass: s => ok(s) && /"made":1,"banked":1/.test(s),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Smithing: 99}, inventory: [{id: 2347, count: 1}], bank: [{id: 2363, count: 3}]}},
  {key: 'extra:smith-rune-full-helm', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['smithing', 'anvil', '600', 'PRODUCT_ID=1163', 'MAX_MAKE=1', 'BAR_RESERVE=0'], pass: s => ok(s) && /"made":1,"banked":1/.test(s),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Smithing: 99}, inventory: [{id: 2347, count: 1}], bank: [{id: 2363, count: 2}]}},
  {key: 'extra:smith-rune-kiteshield', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['smithing', 'anvil', '600', 'PRODUCT_ID=1201', 'MAX_MAKE=1', 'BAR_RESERVE=0'], pass: s => ok(s) && /"made":1,"banked":1/.test(s),
    presetConfig: {position: {x: 3185, z: 3436, level: 0}, skills: {Smithing: 99}, inventory: [{id: 2347, count: 1}], bank: [{id: 2363, count: 3}]}},
  {key: 'extra:bank-job-cut-dragonstone', script: 'scripts/aio-skiller.ts', preset: 'bank_gems', scriptArgs: ['bank-job', CUT_JOB_PATH], pass: s => ok(s) && s.includes('cut-dragonstone')},
  // Lost City on an account of the `pure-pray` build: the levels of the kit, the Woodcutting and Crafting that Monk's
  // Friend and Murder Mystery give before it in the chain, nothing worn and the pack of quest_zanaris. The build
  // stays: the run passes only when the quest is complete and no XP went to Attack, Defence, Ranged, Magic or Prayer.
  {key: 'extra:lostcity-pure-pray', script: 'scripts/aio-quester.ts', preset: 'quest_zanaris', scriptArgs: ['zanaris'], pass: lostCityKeepsBuild, timeoutMs: 900_000,
    presetConfig: {...PRESETS.quest_zanaris!, skills: {...kitSkills('pure-pray'), Woodcutting: 56, Crafting: 51}}},
  // The Fremennik Trials on an account of a build with a Fremennik helm, at the levels the build has before the quest
  // (levelsBeforeRoute). The whole quest, and for a short loop the two stages with a fight: `-draugen` starts at the
  // Draugen hunt and `-thorvald` at Koschei (run those with `--set VK_FROM=draugen` or `--set VK_FROM=thorvald`).
  ...VIKING_BUILDS.flatMap(kit => (['', 'draugen', 'thorvald'] as const).map(stage => {
    const preset = stage ? `quest_viking_${stage}` : 'quest_viking', before = levelsBeforeRoute(kit);
    return {key: `extra:viking-${kit}${stage ? `-${stage}` : ''}`, script: 'scripts/aio-quester.ts', preset, scriptArgs: ['viking'], pass: questKeepsBuild(kit, before), timeoutMs: 900_000,
      presetConfig: {...PRESETS[preset]!, skills: {...PRESETS[preset]!.skills, ...before}},
      ...(stage ? {known: `a stage of the quest: run it with --set VK_FROM=${stage}`} : {})};
  })),
  // Fletching 1 to 25 for The Fremennik Trials, the planner's band army-fletch-25: 210 headless arrows from banked
  // arrow shafts and feathers (25 XP an arrow at the server's rate; level 25 is 4,863 XP), 100 of each kept. The
  // worker starts at the bank: 25 tiles away it ends "bank did not open", so the band walks there first.
  {key: 'extra:fletch-headless-25', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['fletching', 'arrows', '3000', 'headless', 'MAX_MAKE=210', 'SHAFT_RESERVE=100', 'FEATHER_RESERVE=100', 'BANK_PACK=1'],
    pass: s => ok(s) && / made=210 /.test(s) && / xpGain=5250 /.test(s), presetConfig: {position: {x: 2615, z: 3332, level: 0}, skills: {Fletching: 1}, bank: [{id: 52, count: 310}, {id: 314, count: 310}]}},
  // The two Magic trainers of the planner's army bands, from the Ardougne north bank. Alchemy: Magic 54 to 56 on
  // feathers with a staff of fire in the bank, so the run casts Low Alchemy and then High Alchemy. The curse trainer:
  // Magic 19 to 21 over the fence of the cow field.
  skiller('magic', 'alch-train', 'fresh_lumbridge', ['56', '1500'],
    {presetConfig: {position: {x: 2615, z: 3332, level: 0}, skills: {Magic: 54, Hitpoints: 40}, bank: [{id: 561, count: 60}, {id: 314, count: 60}, {id: 1387, count: 1}]}}),
  skiller('magic', 'splash', 'fresh_lumbridge', ['21', '1500'],
    {presetConfig: {position: {x: 2615, z: 3332, level: 0}, skills: {Magic: 19, Hitpoints: 40}, bank: [{id: 559, count: 40}, {id: 557, count: 120}, {id: 555, count: 120}, {id: 558, count: 2}, {id: 556, count: 2}]}}),
  // Underground Pass and Regicide on the halberd pure (Ranged 99, Prayer 43, Defence 1): nothing worn, a magic
  // shortbow and RANGED_PACK rune arrows in the pack, so the quest scripts fight with the bow in the Ranged-only
  // style. Underground Pass starts at the levels before the route (Attack 11, Magic 53) with two prayer potions in
  // the place of two sharks; Regicide starts with Underground Pass done (Attack 61). Every other skill is at level
  // 1 but Thieving 50 and Agility 68 (the planner's bands army-thieve-50 and army-agility-68) and, for Regicide, the
  // Crafting 10 of its loom. Under Agility 68 a bridge of the pass can fail, and the scripts do not leave the floor
  // of the chasm: Underground Pass passed 1 of 3 seeds at Agility 56 and 2 of 3 at 62.
  ...(['upass', 'regicide'] as const).map(quest => {
    const preset = PRESETS[`quest_${quest}`]!, before = {...levelsBeforeRoute('pure-hally'), ...(quest === 'regicide' ? {Attack: kitSkills('pure-hally').Attack!} : {})};
    const sharks = (preset.inventory ?? []).filter(i => i.id === 385), rest = (preset.inventory ?? []).filter(i => i.id !== 385);
    const inventory = [...rest, ...(quest === 'upass' ? [...sharks.slice(2), {id: 2434, count: 1}, {id: 2434, count: 1}] : sharks), {id: 861, count: 1}, {id: 892, count: RANGED_PACK}];
    return {key: `extra:${quest}-pure-hally`, script: 'scripts/aio-quester.ts', preset: `quest_${quest}`, scriptArgs: [quest], pass: questKeepsBuild('pure-hally', before), timeoutMs: 900_000,
      presetConfig: {...preset, equipment: [], inventory, skills: hallyQuestSkills(quest)}};
  }),
  // The same Underground Pass through the quest sweep: the account stands at the Ardougne north bank and wears the
  // kit, with the quest pack, the rune arrows, two prayer potions and 12 sharks in the bank. The sweep banks what is
  // worn and takes the pack of the build (scripts/quest-sweep.ts BUILD_PACK), then the quest script runs.
  {key: 'extra:sweep-upass-pure-hally', script: 'scripts/aio-quester.ts', preset: 'quest_upass', scriptArgs: ['sweep', 'upass'], pass: questKeepsBuild('pure-hally', levelsBeforeRoute('pure-hally')), timeoutMs: 900_000,
    presetConfig: {...PRESETS.quest_upass!, position: {x: 2615, z: 3332, level: 0}, equipment: kitItems('pure-hally').equipment, inventory: [], skills: hallyQuestSkills('upass'),
      bank: [...(PRESETS.quest_upass!.inventory ?? []).filter(i => i.id !== 385), {id: 385, count: 12}, {id: 892, count: RANGED_PACK}, {id: 2434, count: 2}]}},
  // Regicide through the quest sweep, with what the planner's band asks in the bank (the bow pack, the runes, 30
  // sharks, 8 coal, a cooked rabbit, a limestone, 2 iron fire arrows, a pestle and mortar and 2 ropes) and the King's
  // message in the pack. The sweep buys the rest of the quest pack in shops. Without the limestone and the fire
  // arrows it ends "missing 2532:2,3211:1": no shop sells them. Without the pestle it ends "Ogre merchant shop did
  // not open". Without the second rope the quest script ends "bank items" at Falador.
  {key: 'extra:sweep-regicide-pure-hally', script: 'scripts/aio-quester.ts', preset: 'quest_regicide', scriptArgs: ['sweep', 'regicide'], pass: questKeepsBuild('pure-hally', {...levelsBeforeRoute('pure-hally'), Attack: kitSkills('pure-hally').Attack!}), timeoutMs: 900_000,
    presetConfig: {...PRESETS.quest_regicide!, position: {x: 2615, z: 3332, level: 0}, equipment: kitItems('pure-hally').equipment, inventory: [{id: 3206, count: 1}], skills: hallyQuestSkills('regicide'),
      bank: [{id: 995, count: 5000}, {id: 385, count: 30}, {id: 892, count: RANGED_PACK}, {id: 563, count: 5}, {id: 556, count: 3}, {id: 555, count: 5}, {id: 453, count: 8}, {id: 3228, count: 1}, {id: 3211, count: 1}, {id: 2532, count: 2}, {id: 233, count: 1}, {id: 954, count: 2}]}},
  // The two trainers before those quests, the planner's bands army-thieve-50 and army-agility-68, at the levels of the
  // build before its route. Thieving 1 to 50 from the Ardougne market. Agility 60 to 68 on the Gnome Stronghold
  // course from its start: the course worker has no other method up to its target, and the case
  // skiller:agility:order has the first levels.
  {key: 'extra:thieve-50-pure-hally', script: 'scripts/aio-skiller.ts', preset: 'fresh_lumbridge', scriptArgs: ['thieving', 'bootstrap55', 'TARGET=50', 'CAP=2500', 'CLEAN_FOOD=1'], pass: s => ok(s) && / died=false/.test(s), timeoutMs: 900_000,
    presetConfig: {position: {x: 2654, z: 3304, level: 0}, skills: {...levelsBeforeRoute('pure-hally'), Thieving: 1}}},
  {key: 'extra:agility-68-pure-hally', script: 'scripts/aio-skiller.ts', preset: 'agility_gnome_1', scriptArgs: ['agility', 'order', 'gnome', '68', 'AGI_POTION=0', 'AGI_MAX_TICKS=6000', 'AGI_PROGRESS_TICKS=150', 'AGI_ENTRY_TICKS=400'], pass: ok, timeoutMs: 900_000,
    presetConfig: {...agilityFixturePreset(PRESETS.agility_gnome_1!), skills: {...levelsBeforeRoute('pure-hally'), Agility: 60}}},
  // Underground Pass on the Iban pure at its levels before the quest (Attack 11, Hitpoints 10).
  {key: 'extra:upass-pure-iban', script: 'scripts/aio-quester.ts', preset: 'quest_upass', scriptArgs: ['upass'], pass: questKeepsBuild('pure-iban', levelsBeforeRoute('pure-iban')), timeoutMs: 900_000,
    known: 'the fights of the quest give 53,400 XP and 17,690 Hitpoints XP; the build has no skill at 99 to take them and Hitpoints 10',
    presetConfig: {...PRESETS.quest_upass!, skills: {...PRESETS.quest_upass!.skills, ...levelsBeforeRoute('pure-iban')}}},
  // The Mage Arena on the two builds with Flames of Zamorak, at their levels before the arena: the pack of
  // quest_magearena and a staff of fire worn. `pure-god` has Prayer 37 and prays. `pure-rock` has Prayer 1: the
  // case runs the leash method (MA_MODE=leash) with 23 sharks in the place of the prayer potions.
  ...(['pure-god', 'pure-rock'] as const).map((kit): BenchCase => {
    const preset = PRESETS.quest_magearena!, before = levelsBeforeRoute(kit);
    const sharks = [...(preset.inventory ?? []).filter(i => i.id !== 2434 && i.id !== 385), ...Array.from({length: 23}, () => ({id: 385, count: 1}))];
    return {key: `extra:magearena-${kit}`, script: 'scripts/aio-quester.ts', preset: 'quest_magearena', scriptArgs: ['magearena'], pass: questKeepsBuild(kit, before), timeoutMs: 900_000,
      ...(KITS[kit]!.noRoute ? {known: KITS[kit]!.noRoute, scriptArgs: ['magearena', 'MA_MODE=leash']} : {}),
      presetConfig: {...preset, skills: before, ...(KITS[kit]!.noRoute ? {inventory: sharks} : {})}};
  }),
];

const KNOWN_QUEST: Readonly<Record<string, string>> = {
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
  'pvp:escort-ore': 'the engine must start with WORLD_FEED=true, and the bench gives each engine a fixed environment',
  'market:shop-sell': 'the worker needs its shop open at entry and never opens one; market:shop-trip runs the same sale after it opens the shop',
  'logistics:coin-courier': 'both accounts must be in the owned-account registry before login; a new bench account is not',
  'logistics:coin-fanout': 'both accounts must be in the owned-account registry before login; a new bench account is not',
  'logistics:item-fanin': 'both accounts must be in the owned-account registry before login; a new bench account is not',
  'logistics:note-courier': 'requires accounts owned on the live server address',
  'logistics:give-to-banker': 'needs scripts/banker.ts running for the banker account',
  'logistics:take-from-banker': 'needs scripts/banker.ts running for the banker account',
  'logistics:supply-holder': 'serves trades from a specialist and a courier that other processes drive',
  'logistics:supply-bootstrap': 'requires SERVER=localhost:8888 in the account file; a bench account has 127.0.0.1 and its own port',
  'skiller:runecraft:nature': 'the worker requires Runecraft XP of 9 for each essence (XP rate 1); the practice engine runs rate 25',
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
