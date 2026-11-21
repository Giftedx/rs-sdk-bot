// Core autopilot domain model, account/name normalization, RuneScape world geometry, capacities, reachability, and job resource admission.
import type { BillRow } from '../supply-bill';
import type { SquadInput } from '../squad';
import type { GearWantRow } from '../gear-want-jobs';
import { parseStep, tokenizeStep, type Step } from '../../../core/src/chain-step';
import { validateBankRouteJob, type BankRouteJob } from '../../../core/src/bank-trip';
import { resolveRouteStep, resolveSkillerMethod } from '../../../../scripts/aio-route-step';

// `combat`: the combat level the account's status reports (absent: worked out from `skills`). `quests`: the quests its
// status reports complete, by norm() name (absent: none known complete). `questPoints`: the quest points its status
// reports (absent: none known, which counts as 0). `pos`: the tile where the account stands while it is offline
// (absent: not known, and the reach rule does not apply).
// `currentHP`: the observed current Hitpoints; absent means unknown, never the base level.
// `exact`: the holdings of unnoted items by name, as the buy script counts them (its matcher takes the item id and skips banknotes); `items`
// counts a banknote under its item's name. Absent: no observation.
// `observedAt`: when the observation behind this account was taken (its status `at`); absent: no observation.
export type Acct = { name: string; side: string; skills: Record<string, number>; items: Record<string, number>; exact?: Record<string, number>; observedAt?: number; currentHP?: number; combat?: number; quests?: ReadonlySet<string>; questPoints?: number; pos?: { x: number; z: number; level: number } };
export type Flow = { item: string; perTick: number };
// `under`: skills that must stay below a level (a band hands an account on to the next band at that level).
// `holdsUnder`: holdings that end the job at once. The account must hold fewer, or the run finds its target met and fails.
// `food`: HP the account's food heals, pack and bank (FOOD_HEAL). `pieces`: at least `count` items of any of `of`.
// `anyOf`: at least one of these needs met in full (fire runes or a fire staff; a bow the account wields with arrows it fires).
// `shortOf`: holdings of which the account must be short of at least one (a supply run that brings several items).
// `holds`: holdings the account gets by its own job (flax it picked): short of them the job waits, and nothing is
// bought or sent for them.
// `combat`: the least combat level (a mine inside an aggressive monster's range). `quests`: quests that must be complete.
// `questPoints`: the least quest points (a place behind a door that counts them).
// `frail`: an account with fewer Hitpoints than `hitpoints` must hold `count` items of `of`; any other account needs none.
// `hpAboveHalf`: observed current HP must exceed half the base Hitpoints, rounded up, as stall food staging requires.
export type Needs = {
    // `meleeWeapon`: one wearable melee weapon held, worn or banked (gear-progression ownsWearableMeleeWeapon: any weapon the
    // account can wear at its levels and quests). A missing weapon is the kit line COW_WEAPONS, so a shop job or a donor fills it.
    meleeWeapon?: true;
    combat?: number; quests?: readonly string[]; questPoints?: number; hpAboveHalf?: true; frail?: { hitpoints: number; of: readonly string[]; count: number };
    skills?: Record<string, number>; items?: Record<string, number>; under?: Record<string, number>; holdsUnder?: Record<string, number>; shortOf?: Record<string, number>; holds?: Record<string, number>; food?: number;
    pieces?: { of: readonly string[]; count: number }; anyOf?: readonly Needs[];
};
export type Template = {
    id: string; family: string; script: string; args?: string[]; env?: Record<string, string>; role: string; goal: string;
    needs?: Needs;
    yields: (a: Acct) => Flow[]; spends?: (a: Acct) => Flow[];
    resources?: string[]; trains?: { skill: string; to: number; unlocks: string[] };
    // A goal band (AGENTS.md goals: the PK army of maxed tribrids) trains an army account toward its target and is
    // assigned before any coin job; `band` orders the bands by PK value, lowest first. Gold only buys their kits.
    tier?: 'goal'; band?: number;
    // A goal band that only fills time (burying trooper bones for Prayer): an account takes it after the kit tier,
    // so a kit buy or a send for an earlier band comes first, and a kit buy replaces it while it runs.
    filler?: boolean;
    // A trainer whose script runs a fixed amount (not to its target level) repeats until the planner moves it on.
    repeats?: boolean;
    // Declared finite makers only. Counts are input actions; outputPerUnit keeps native recipe multiples explicit.
    production?: { output: string; outputPerUnit: number; maximum: number; inputs: Readonly<Record<string, number>>;
        strictOutput?: true; reserves?: Readonly<Record<string, number>>; resize: (units: number, held?: number) => { args: string[]; env?: Record<string, string> } };
    // The stock a kit buy brings an item up to, by item name: more than the start minimum in `needs`, so one login
    // buys a batch (nature runes for many alchemy casts) and not one start's worth.
    batch?: Record<string, number>;
    // The same, worked out for the account (bought bones: what its Prayer still needs). `partBatch`: a batch worth
    // having in part, so an account that cannot pay for all of it buys what it can pay for, not only the start.
    batchFor?: (a: Acct) => Record<string, number>;
    partBatch?: true;
    // Coins a kit buy for this band leaves the account, beyond the kit reserve: what its other bands still cost.
    keepCoins?: (a: Acct) => number;
    // A quest run: a candidate until the account's status reports the quest complete, and worth a share of each job
    // the quest unlocks (as a trainer is). It does not repeat.
    quest?: { name: string; unlocks: string[] };
    // A supply job for the gang squad: a candidate only while the plan's squad or specialist staging is active.
    squadOnly?: true;
    // Enters Wilderness: excluded from planning unless Inputs.allowWilderness is true.
    wilderness?: true;
    // Goal band kit is omitted from donor kitReserve (single-use trainer supplies such as headless arrows).
    noReserve?: true;
    // A shop step for a maker: it buys one `item` that a shop sells and no market lists (a ring mould), and is a candidate
    // only for an account that lacks the item and meets every other need of an admitted maker of `unlocks`. It is worth
    // a share of that maker, as a trainer is worth a share of the job it unlocks.
    provides?: { item: string; unlocks: string[] };
    // A goal band whose target is a holding: it stands while the account holds fewer than `to` of `item`.
    stock?: { item: string; to: number };
    // Kit lines the band's own supply job buys instead of the market.
    // Spare owned stock can still supply them through a bounded item order.
    ownSupply?: readonly string[];
    // An AIO route (scripts/aio.ts): `aio` is its bench key (scripts/measure/aio-bench-cases.ts) and `worker` the script
    // the dispatcher runs, so a retirement lapses when the worker changes, not only the dispatcher.
    aio?: string; worker?: string;
    // Proved on practice only. The planner gives it only while the plan's `aio` list names its id (Inputs.pilots), so
    // each first live run is a bounded pilot the owner starts.
    pilot?: true;
    // A quest that one account of the fleet does once (QUEST_DEMAND): a candidate only while Inputs.questsDone lists no
    // account that completed it. With no list there is no candidate.
    once?: true;
    // A goal band whose missing kit is bought as a candidate of the band itself, as the weapon buy is: an account that
    // can start a later band still gets it. Without the flag a kit is bought only when no band can start.
    kitFirst?: true;
    // A band whose missing kit is bought only by its shop job. Owned donations remain eligible.
    shopKit?: true;
    // A goal band for accounts with a PK build only (buildBand): no other army account takes it.
    buildOnly?: true;
    // A band that serves one quest of a build's route: only an account with that quest on its route and not done
    // takes it (buildBand).
    route?: string;
    // A quest band for builds: the combat skills that the rewards of its chain, and its fights with a set style,
    // give XP in. Only these skills must be at or under the level before the route (buildBand). Absent: every skill.
    gives?: readonly string[];
};
// One missing kit line: `count` more units of any one item of `of`.
export type Lack = { of: readonly string[]; count: number };
// `send`: a free account (this side first, then another side) gives the item; scripts/autopilot.ts places the fleet
// order, and the account takes the band on the pass after the item arrives.
export type ItemFunding = { from: string; to: string; item: string; count: number; template: string; itemId?: number };
// A free account that can give: no enabled job on its side, no stop file, no open order. `items` by norm() name.
export type Stock = { name: string; side: string; items: Record<string, number> };
// Items a kit buy may order on the Grand Exchange, by norm() name: the item id, its display name and the unit price cap.
export type Market = Readonly<Record<string, { id: number; name: string; limit: number }>>;
// `fund`: the template needs coins the account lacks; a donor of this side sends them first (scripts/autopilot.ts
// places the fleet order), and the account takes the job on the pass after the coins arrive. `meet`: the order
// meets at the Ardougne north bank, for an account that stands in Kandarin (absent: at Varrock West).
export type Funding = { from: string; to: string; coins: number; template: string; meet?: 'ardougne' };
export type Assignment = { account: string; template?: Template; value: number; reason: string; resources: string[]; fund?: Funding; send?: ItemFunding };
export type Inputs = {
    side: string; accounts: readonly Acct[]; owners: ReadonlyMap<string, { side: string }>; bill: readonly BillRow[];
    templates: readonly Template[]; prices: Readonly<Record<string, number>>; waste?: Readonly<Record<string, number>>;
    // Bind a fresh qualified adaptive method before this pass reserves its place.
    templateFor?: (template: Template, account: Acct) => Template;
    taken?: Readonly<Record<string, number>>; retired?: ReadonlySet<string>; capacity?: Readonly<Record<string, number>>;
    // The share of its value a job keeps on a resource another account already holds (default 1).
    shared?: Readonly<Record<string, number>>;
    // The template each account holds now, by lower-case name: on a value tie the account keeps it.
    current?: ReadonlyMap<string, string>;
    // Lower-case accounts whose current matching job has a confirmed live session. This only keeps an existing
    // army band through consumed kit stock; an enabled or parked job alone is not a running session.
    running?: ReadonlySet<string>;
    // Accounts of this side free to trade now (no enabled swarm job), with their coins. Each keeps FUND_RESERVE.
    donors?: readonly { name: string; coins: number }[];
    // Lower-case names of accounts with an enabled job. Funding one would remove its running job, and the stop file
    // scripts/swarm.ts writes for it would block the trade, so such an account is never funded.
    unfundable?: ReadonlySet<string>;
    // Lower-case account -> its gear wants for the style it trains (scripts/gear-wants.ts). The gear pass buys them: market wants as a kit buy, shop wants as one shop trip.
    gearWants?: ReadonlyMap<string, readonly GearWantRow[]>;
    // Lower-case names of the accounts on this side's army roster: only they take goal bands. A specialist's board
    // time counts every tick it plays, so combat training is opt-in per account, never global.
    army?: ReadonlySet<string>;
    // The gang squad's supply demand (packages/planner/src/squad.ts): an active squad adds a stock target of its members'
    // consumption as demand rows, and a donor's spare stock moves to a member that is short. Absent or inactive: none.
    squad?: SquadInput;
    // The time of this pass (ms). With it a vacant reason names an observation older than OBSERVATION_FRESH_MS.
    now?: number;
    // The free accounts of this side that no donor stock was read for: their observation is older than
    // OBSERVATION_FRESH_MS or missing, so their stock is not offered to a kit (scripts/autopilot.ts donorStock).
    unobserved?: readonly string[];
    // The bot slots left for planner jobs (the swarm's limit less the hand jobs and the live bots that the swarm counts but
    // does not run). plan() gives a job to at most this many accounts, best first, and names the rest "waits for a bot
    // slot"; a running job always keeps its slot. Absent: no limit.
    slots?: number;
    // Lower-case accounts whose bot holds a slot now: a run in the swarm's run list, a start inside its window included.
    holding?: ReadonlySet<string>;
    // Lower-case account name -> the levels of its PK build (scripts/pk-kits.ts kitSkills): an army account that
    // trains to those levels and no further (buildBand). An account with no entry trains every band to its end.
    builds?: ReadonlyMap<string, Readonly<Record<string, number>>>;
    // Lower-case account name -> the quests on the route of its build (BUILD_QUESTS of its kit). An account with a
    // build and no entry takes no quest band.
    buildQuests?: ReadonlyMap<string, readonly string[]>;
    // Lower-case account name -> the levels its build may have before the quests of its route
    // (scripts/pk-kits.ts levelsBeforeRoute): a quest reward on top of a higher level ends over the build.
    buildBefore?: ReadonlyMap<string, Readonly<Record<string, number>>>;
    // Free accounts of every side with their holdings: item and coin donors for an army account's kit. This side's
    // donors give first; another side's give only when none of this side can.
    stock?: readonly Stock[];
    // The items a kit buy may order. Absent: the planner plans no buy.
    market?: Market;
    // Standalone jobValue callers may price coins differently. plan derives finite funding demand and prices a
    // required coin at one; a bank balance does not change the value of funding a missing kit.
    coinValue?: number;
    // Legacy aggregate balance. Funding uses each recipient's own coins and usable donors; excluded or reserved
    // wealth cannot pay another account's kit. This value does not override those funding limits.
    sideCoins?: number;
    // Each account's supply episode, by lower-case name (kit buys and settled held-bone batches; default 0).
    kitSeq?: ReadonlyMap<string, number>;
    // Donor and recipient pairs whose item order failed lately, as `from>to` in lower case: no new order for them.
    noSend?: ReadonlySet<string>;
    // The ids of the `pilot` templates this plan admits (its `aio` list). Absent: none.
    pilots?: ReadonlySet<string>;
    // Admit the self-serve production pilots (selfServePilot) to a free account that is not on the army roster, whatever the
    // `aio` list names, at PILOT_FALLBACK_SHARE of their worth so every listed job and every other supply job ranks first.
    // Each place keeps its capacity, and finite demand sizes each run, so the fallback stays bounded. Absent: off.
    pilotFallback?: boolean;
    // The quests (lower case journal names) that some observed account of any side completed. A `once` template needs it.
    questsDone?: ReadonlySet<string>;
    // Whether the walker lets the account walk over White Wolf Mountain (scripts/autopilot.ts mountainWalk). Absent:
    // every account walks it.
    mountain?: (a: Acct) => boolean;
    // Active non-Wilderness specialist staging kit keys (SPECIALIST_STAGE_BILLS) demanded from mainland suppliers.
    specialists?: readonly string[];
    // Permit templates marked `wilderness: true`; default false keeps live planning outside Wilderness.
    allowWilderness?: boolean;
};

export type KitLine = { item: string; id: number; quantity: number; held: number; limit: number };
export type KitStage = { id: string; goal: string; items: { item: string; count: number }[] };
export type SpecialistStageLine = { names: readonly string[]; count: number };
export type GoalNeed = { names: string[]; short: number; consumer: string; account?: string; bought?: number; budget?: () => number };

export const norm = (s: string) => s.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim().replace(/s$/, '');
export const pairKey = (account: string, template: string) => `${account.toLowerCase()}:${template}`;

// The combat level of the 2004 game, from base levels. Used when a status row carries no `combat`.
export function combatLevel(skills: Readonly<Record<string, number>>): number {
    const s = (k: string, d = 1) => skills[k] ?? d;
    const base = (s('Defence') + s('Hitpoints', 10) + Math.floor(s('Prayer') / 2)) / 4;
    return Math.floor(base + 0.325 * Math.max(s('Attack') + s('Strength'), Math.floor(s('Ranged') * 1.5), Math.floor(s('Magic') * 1.5)));
}
export const questDone = (a: Acct, quest: string) => !!a.quests?.has(norm(quest));
// What a goal band still has to do for an account: levels to its skill target, 1 for a quest its status does not list
// complete (0 with no quest list), or the items short of a stock target.
export const bandLeft = (t: Template, a: Acct): number => t.trains ? t.trains.to - (a.skills[t.trains.skill] ?? 1)
    : t.quest ? (a.quests && !questDone(a, t.quest.name) ? 1 : 0) : t.stock ? Math.max(0, t.stock.to - (a.items[norm(t.stock.item)] ?? 0)) : 0;

// The quests (lower case journal names) that some status row lists complete: a name as a string, or a journal entry whose
// state is "complete" (the rows of scripts/autopilot.ts: this side's status files and every side's published snapshots).
export function questsDoneIn(rows: readonly unknown[]): Set<string> {
    const done = new Set<string>();
    for (const row of rows as any[]) {
        const journal = Array.isArray(row?.questJournal) ? row.questJournal : Array.isArray(row?.quests) ? row.quests : [];
        for (const q of journal) { const name = typeof q === 'string' ? q : q?.state === 'complete' ? q?.name : undefined; if (typeof name === 'string') done.add(norm(name)); }
    }
    return done;
}

export const WEAPON_BAND = 3.5, WEAPON_BUYERS = 4, WEAPON_MARKET = 'ge:weapon';
export const ARMOUR_BAND = 3.55, RANGED_ARMOUR_BAND = 3.95, ARMOUR_MARKET = 'ge:armour', ARMOUR_BUYERS = 2;
export const AMMO_MARKET = 'ge:ammo';
export const QUEST_BAND = 3.6, LOST_CITY = 'quest:lostcity', LOST_CITY_PLACES = 1, LOST_CITY_MEALS = 10;
export const GRAIL_BAND = QUEST_BAND + 0.1, GRAIL_PLACE = 'quest:camelot', GRAIL_PLACES = 1, GRAIL_MEALS = 12;
export const FREMENNIK_BAND = QUEST_BAND + 0.05, FREMENNIK = 'quest:rellekka', FREMENNIK_PLACES = 1, FREMENNIK_MEALS = 4;
export const UPASS_BAND = QUEST_BAND + 0.06, REGICIDE_BAND = QUEST_BAND + 0.07, UPASS = 'quest:upass', UPASS_PLACES = 1;
export const ARMY_BANK = { x: 2615, z: 3332 } as const;

export const KNIGHT_SPOTS = ['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'];
export const CHICKEN_PENS = ['3229,3298', '3017,3288', '3187,3277', '3197,3353'];
// The pen at 3197,3353 is the yard of the Champions' Guild. Its door lets in an account with 32 quest points
// (championdoor in knowledge/doors.json), and the route search refuses the pen to any other account.
export const PEN_QUEST_POINTS: Readonly<Record<string, number>> = { '3197,3353': 32 };
// scripts/gather-feathers.ts stops when its pack holds TARGET feathers.
export const FEATHER_TARGET = 2000;
// scripts/shop-buyer.ts buys each item up to STOCK_TARGET (default 500), pack and bank. A run for an account that
// holds that many of every item buys nothing.
export const SHOP_STOCK = 500;
// Claim: four farmers can share one knight spot. A pickpocket does not hold the knight. Practice: 4 bots at one spot
// each earned 13.3-15.1 coins per tick (mean 14.7) against the 18.8 model, every run RESULT ok and logged out
// (goldfarm.ts at its default spot 2653,3302, 3 runs of 600 ticks and one of 9,000; research/bot-host.md section 3).
// Live (claude-cloud-3 swarm logs): two full 9,000-tick goldfarm runs, RESULT ok and logged out, made 7.46
// coins per tick with 3 holders on 2652,3318 and 7.57 with 3 holders on 2669,3298 (4 for its last part), against about
// 8.1 near-solo. Gap: one live run per condition, not three matched, so KNIGHT_SHARED_RATE is an estimate, applied
// once per holder; the planner's tick-waste discount and retirement still apply per job.
export const KNIGHT_SHARE = 4, KNIGHT_SHARED_RATE = 0.75;
// Ardougne north cow field: six army accounts at once on its ten cows. Practice (research/combat-measure.md), 8-kill
// runs: solo median 550 ticks; 3 triples 9/9 RESULT ok, median 590 per account; 3 sets of six fresh accounts 18/18
// RESULT ok, median 779, so six make about 1.5 times the field output of three. More than six is not measured.
export const COW_FIELD = 'cow:ardougne-north', COW_FIELD_CAPACITY = 6;
// Gnome battlefield Khazard troopers: about 41 on multiway ground. Practice, fourteen accounts at once, 3 sets: 42 of
// 42 RESULT ok at a median 38.4 Strength XP per tick an account (49.7 with nine, 56.7 with six, 61-63 alone), the
// slowest 29.5, and a field total 20% over nine (research/combat-measure.md, troopers shared). The cows give about 16,
// so every army account trains there. Gap: more than fourteen at once is not measured.
export const TROOPER_FIELD = 'trooper:battlefield', TROOPER_FIELD_CAPACITY = 14;
// The Wind Strike tile north of the Ardougne north bank (scripts/alch-train.ts STRIKE): one Guard dog, fought by one
// player at a time. Practice: of three accounts at once, one landed no cast in 200 ticks, in each of three sets.
export const STRIKE_TILE = 'strike:ardougne-guard-dog';
// Taverley's black dragons (scripts/black-dragon-camp.ts): two dragons, one camp tile. Practice: two accounts on the
// tile at once made six kills each with no stray and no hitpoint lost; more than two is not run. HUNT_BAND comes after
// every training band, so only an account with none of them left to start hunts. HIDE_TARGET is the hides one hunter
// gathers before the band stands down: a set of body, chaps and vambraces takes six.
export const BLACK_CAVE = 'cave:taverley-black-dragons', BLACK_CAVE_PLACES = 2;
export const SPLASH_FENCE = 'splash:ardougne-cow-fence', SPLASH_PLACES = 2;
// The places the AIO routes hold (aioTemplates). Each takes one account until a live pilot measures two.
export const AIO_PLACES = { flax: 'aio:seers-flax', yews: 'aio:seers-yews', ore: 'aio:varrock-east-mine', essence: 'aio:essence-mine', air: 'aio:air-altar', blood: 'aio:ardougne-blood-chests' } as const;
// The quests that no owned account has done, as sweep jobs for army accounts with time left (QUEST_DEMAND_BAND: after the
// build bands, before the open-ended fields). One account does each quest once: `once` stops the demand when any
// observed account has it done (Inputs.questsDone). `ticks`: the game ticks of the saved practice run (the bench case
// `quester:quest:<slug>`), which orders the bands, the cheapest first. `skills` and `quests` are the journal's asks
// (packages/dashboard/client-assets/quest-reqs.json) and `items` is the pack of the practice run
// (scripts/quest-sweep.ts presetFor), with `meals` of food; Hitpoints 90 stands where the practice run fell under 70
// Hitpoints with 99 in every skill (the saved `hpMin`). A quest is a `kitFirst` band: an account that lacks its pack gets the items from a donor, or buys them
// within the caps of questKitCaps, and one that cannot shows the missing item as the vacant reason. The table leaves out the quests that no one-account sweep can run: Shield of Arrav, Hero's Quest and
// Legends Quest open companion accounts (scripts/generated/quest-<slug>.ts take a helper name), the sweep refuses Hero's
// Quest (scripts/quest-sweep.ts), and Throne of Miscellania needs Hero's Quest. They wait for an owned-pair path. QUEST_DEMAND_PLACES: quest jobs at once.
export const QUEST_DEMAND_BAND = 5, QUEST_DEMAND = 'quest:demand', QUEST_DEMAND_PLACES = 2;
export type QuestDemandRow = { slug: string; name: string; ticks: number; skills: Record<string, number>; quests: string[]; questPoints?: number; items: Record<string, number>; meals: number; wilderness?: true };
export const QUEST_DEMAND_ROWS: readonly QuestDemandRow[] = [
    { slug: 'elemental', name: 'Elemental Workshop', ticks: 188, skills: { Crafting: 20, Mining: 20, Smithing: 20 }, quests: [], items: { knife: 1, needle: 1, leather: 1, thread: 1, hammer: 1, 'rune pickaxe': 1, coal: 4 }, meals: 6 },
    { slug: 'chompybird', name: 'Big Chompy Bird Hunting', ticks: 387, skills: { Cooking: 30, Ranged: 30, Fletching: 5 }, quests: [], items: { knife: 1, chisel: 1, 'achey tree logs': 1, 'wolf bones': 1, feather: 8, 'ogre arrow': 6, potato: 1, onion: 1, 'equa leaves': 1, cabbage: 1, tomato: 1, 'doogle leaves': 1 }, meals: 2 },
    { slug: 'horror', name: 'Horror from the Deep', ticks: 655, skills: { Agility: 35 }, quests: [], items: { plank: 2, nails: 8, hammer: 1, 'swamp tar': 1, 'molten glass': 1, tinderbox: 1, 'bronze dagger': 1, 'bronze arrow': 1, 'air rune': 200, 'water rune': 100, 'earth rune': 100, 'fire rune': 100, 'blood rune': 40 }, meals: 12 },
    { slug: 'druidspirit', name: 'Nature Spirit', ticks: 665, skills: { Crafting: 18 }, quests: ['Priest in Peril', 'The Restless Ghost'], items: { wolfbane: 1, 'silver sickle': 1 }, meals: 4 },
    { slug: 'routequest', name: 'In Search of the Myreque', ticks: 696, skills: { Agility: 25 }, quests: ['Nature Spirit'], items: { 'silver sickle(b)': 1, 'druid pouch': 6, 'steel longsword': 1, 'steel sword': 2, 'steel dagger': 1, 'steel mace': 1, 'steel warhammer': 1, plank: 6, nails: 30, hammer: 1 }, meals: 6 },
    { slug: 'ikov', name: 'Temple of Ikov', ticks: 984, skills: { Thieving: 42, Ranged: 40 }, quests: [], items: { 'lit candle': 1, knife: 1, 'limpwurt root': 20, 'law rune': 1, 'air rune': 3, 'fire rune': 1 }, meals: 2 },
    { slug: 'trolllove', name: 'Troll Romance', ticks: 1004, skills: { Agility: 28 }, quests: ['Death Plateau', 'Troll Stronghold'], items: { 'maple logs': 1, 'iron bar': 1, rope: 1, 'bucket of wax': 1, 'swamp tar': 1, 'cake tin': 1, 'law rune': 6, 'fire rune': 6 }, meals: 14 },
    { slug: 'crest', name: 'Family Crest', ticks: 1030, skills: { Magic: 59, Crafting: 40, Mining: 40, Smithing: 40, Hitpoints: 90 }, quests: [], items: { shrimps: 1, "'perfect' gold bar": 2, ruby: 2, 'ring mould': 1, 'necklace mould': 1, 'antipoison(4)': 2, 'air rune': 100, 'water rune': 12, 'earth rune': 15, 'fire rune': 70, 'death rune': 24, 'law rune': 6 }, meals: 12, wilderness: true },
    { slug: 'mortton', name: 'Shades of Mortton', ticks: 1115, skills: { Crafting: 20, Herblore: 15, Firemaking: 5 }, quests: ['Priest in Peril'], items: { hammer: 1, tinderbox: 1, logs: 1, tarromin: 1, 'vial of water': 1, ashes: 1, 'serum 207 (3)': 2 }, meals: 2 },
    { slug: 'desertrescue', name: 'The Tourist Trap', ticks: 1217, skills: { Smithing: 20, Fletching: 10 }, quests: [], items: { hammer: 1, 'bronze bar': 5, feather: 40, 'waterskin(4)': 2 }, meals: 6 },
    { slug: 'biohazard', name: 'Biohazard', ticks: 1285, skills: {}, quests: ['Plague City'], items: { 'priest gown': 2, 'law rune': 4, 'water rune': 4 }, meals: 2 },
    { slug: 'dig', name: 'Digsite Quest', ticks: 1486, skills: { Thieving: 25, Agility: 10, Herblore: 10 }, quests: [], items: { 'law rune': 1, 'air rune': 3, 'fire rune': 1, 'cup of tea': 1, opal: 1, rope: 2, vial: 1, charcoal: 1, 'pestle and mortar': 1, tinderbox: 1 }, meals: 2 },
    { slug: 'tbwt', name: 'Tai Bwo Wannai Trio', ticks: 1488, skills: { Cooking: 30, Firemaking: 30, Agility: 15, Fishing: 5 }, quests: ['Jungle Potion'], items: { 'raw karambwan': 4, 'pestle and mortar': 1, 'iron spear': 1, 'agility potion(4)': 1, 'small fishing net': 1, 'jogre bones': 1, seaweed: 1, 'sliced banana': 1, 'karambwan vessel': 1, 'fire rune': 31, 'nature rune': 1, 'air rune': 18, 'mind rune': 9, 'amulet of glory(4)': 1 }, meals: 0 },
    { slug: 'itwatchtower', name: 'Watch Tower', ticks: 1951, skills: { Mining: 40, Agility: 25, Thieving: 15, Herblore: 14, Magic: 14, Hitpoints: 90 }, quests: [], items: { rope: 2, 'dragon bones': 1, 'gold bar': 1, 'death rune': 1, 'lit candle': 1, 'guam leaf': 1, 'vial of water': 1, 'ground bat bones': 1, jangerberries: 1, 'rune pickaxe': 1 }, meals: 8 },
    { slug: 'upass', name: 'Underground Pass', ticks: 2645, skills: { Thieving: 50, Ranged: 25, Hitpoints: 90 }, quests: ['Biohazard'], items: { shortbow: 1, 'iron arrow': 5, tinderbox: 1, rope: 1, bucket: 1, spade: 1 }, meals: 14 },
    { slug: 'viking', name: 'The Fremennik Trials', ticks: 2784, skills: { Crafting: 40, Woodcutting: 40, Fletching: 25, Hitpoints: 90 }, quests: [], items: { coins: 5300, beer: 1, tinderbox: 1, 'rune axe': 1, knife: 1, cabbage: 1, potato: 1, onion: 1, 'raw shark': 1 }, meals: 4 },
    { slug: 'zombiequeen', name: 'Shilo Village', ticks: 2977, skills: { Agility: 32, Crafting: 20, Prayer: 10, Hitpoints: 90 }, quests: ['Jungle Potion'], items: { spade: 1, 'lit candle': 1, rope: 1, chisel: 1, 'bronze wire': 1, bones: 3 }, meals: 14 },
    { slug: 'regicide', name: 'Regicide', ticks: 3195, skills: { Agility: 56, Crafting: 10, Hitpoints: 90 }, quests: ['Underground Pass'], items: { "king's message": 1, 'iron fire arrows': 2, rope: 2, shortbow: 1, tinderbox: 1, spade: 1, 'pestle and mortar': 1, pot: 1, limestone: 1, 'ball of wool': 4, 'law rune': 5, 'air rune': 3, 'water rune': 5, coal: 8, 'cooked rabbit': 1 }, meals: 30 },
];
// The Fremennik Trials and the Underground Pass share the place of their build templates, so one account does each.
export const questResource = (slug: string) => slug === 'viking' ? FREMENNIK : slug === 'upass' || slug === 'regicide' ? UPASS : `quest:${slug}`;

// CAPACITY: accounts at one resource at a time. Every number is policy (a place, a market or a spot holds this many), not a game fact.
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, 'squad:catherby-sharks': 3, 'squad:shilo-karambwanji': 2, 'squad:shilo-karambwan': 2, 'squad:catherby-cooking': 2, 'squad:herblore-bank': 4, 'squad:magic-enchant': 4, 'squad:al-kharid-craft': 3, 'squad:varrock-smithing': 2, 'squad:seers-fletch': 3, 'squad:crystal-chest': 2, 'squad:heroes-fountain': 2, 'squad:cosmic-altar': 2, 'squad:taverley-druids': 1, 'squad:taverley-black-knights': 2, 'squad:barbarian-planks': 1, 'squad:gnome-toads': 1, 'squad:taverley-scales': 2, 'squad:taverley-black-dragons': 2, 'squad:chaos-temple-wine': 2, 'squad:seers-magic-trees': 2, 'squad:edgeville-unicorns': 2, 'squad:ardougne-giants': 2, 'squad:hobgoblin-snape': 2, [WEAPON_MARKET]: WEAPON_BUYERS, [ARMOUR_MARKET]: ARMOUR_BUYERS, [LOST_CITY]: LOST_CITY_PLACES, [GRAIL_PLACE]: GRAIL_PLACES, [FREMENNIK]: FREMENNIK_PLACES, [UPASS]: UPASS_PLACES, [QUEST_DEMAND]: QUEST_DEMAND_PLACES, ...Object.fromEntries(QUEST_DEMAND_ROWS.map(q => [questResource(q.slug), 1])), ...Object.fromEntries(Object.values(AIO_PLACES).map(p => [p, 1])), [COW_FIELD]: COW_FIELD_CAPACITY, [TROOPER_FIELD]: TROOPER_FIELD_CAPACITY, [STRIKE_TILE]: 1, [SPLASH_FENCE]: SPLASH_PLACES, [BLACK_CAVE]: BLACK_CAVE_PLACES, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
export const SHARED: Readonly<Record<string, number>> = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARED_RATE]));
// The reach rule: a job goes only to an account that has a way to its place. One route query between the Varrock
// side and Kandarin runs for more than 30 s (research/walking.md, Planner reach rule), so the planner asks none. It
// uses the regions of the shared walker's ferry rule (scripts/walk-to.ts walkWithFerryFallback; scripts/autopilot.test.ts
// keeps the fares equal):
// - From the east side to Ardougne the walker takes two ferries, and it wants the fare before it plans: 60 coins, or
//   70 from the Al Kharid side of the toll gate. It takes the coins from a bank, so the pack and the bank count.
// - From Kandarin to the east side it walks to the Ardougne north bank and takes the two ferries: 60 coins.
// - From the east side to the rest of Kandarin it walks over White Wolf Mountain. It refuses that walk to an account
//   that a wolf there can kill (Inputs.mountain), and such an account has no way.
// - An account on Karamja leaves by one ferry: 30 coins. No donor can meet it there (meetFor).
// A start on Tutorial Island counts as Lumbridge: the walker skips the tutorial first. A floor above the ground counts
// as the ground under it. An unknown start (no status, a live session, a cave) has no rule, and neither has a place
// outside these regions or a template with no place.
export type Spot = { x: number; z: number; level?: number };
export const FERRY_FARE = 30, TOLL = 10;
const LUMBRIDGE: Spot = { x: 3222, z: 3218 };
const onTutorialIsland = (p: Spot) => p.x >= 3050 && p.x <= 3160 && p.z >= 3050 && p.z <= 3140;
// The ground of Karamja, in three steps so that Rimmington stays out. Measured on the collision map: the steps hold
// 26,315 of the 26,625 tiles of the island's connected ground and no tile of the mainland.
export const onKaramja = (p: Spot) => p.x >= 2704 && p.z >= 2939 && p.x <= (p.z <= 3149 ? 2959 : p.z <= 3193 ? 2948 : p.z <= 3247 ? 2812 : 0);
const inEast = (p: Spot) => !onKaramja(p) && p.x >= 2870 && p.x <= 3280 && p.z >= 3150 && p.z <= 3510;
const inKandarin = (p: Spot) => !onKaramja(p) && p.x >= 2440 && p.x < 2870 && p.z >= 3040 && p.z <= 3530;
// Walled West Ardougne compound: city doors stay shut until Biohazard completes and world.route finds no exit across the wall.
export const inWestArdougne = (p: Spot) => p.x >= 2496 && p.x <= 2557 && p.z >= 3264 && p.z <= 3335;
const ardougneTarget = (p: Spot) => p.x >= 2600 && p.x <= 2690 && p.z >= 3260 && p.z <= 3360;
// The tile a job's worker walks to first, by resource: the Ardougne north bank for the cow field, its two Magic tiles
// and the troopers; the bank of each shop (scripts/shop-buyer.ts PROFILES bankSpot; scripts/autopilot.test.ts keeps
// them equal); the Catherby and Seers' Village banks; the flax field. Left out: a place that the worker reaches by its
// own travel (the black dragons by teleport, Jakut in Zanaris, a quest) and a place outside the regions.
// A knight spot is not its own first walk: scripts/goldfarm.ts takes an account from far away to the Ardougne south
// bank and walks to the knight from there (scripts/autopilot.test.ts keeps the tile equal), so each spot has the ferry
// rule of Ardougne, the spot west of the rule's Ardougne box too.
export const KNIGHT_BANK: Spot = { x: 2654, z: 3283 };
export const SEERS_BANK: Spot = { x: 2727, z: 3492 }, CATHERBY_BANK: Spot = { x: 2809, z: 3441 }, DRAYNOR_BANK: Spot = { x: 3092, z: 3243 }, VARROCK_EAST_BANK: Spot = { x: 3253, z: 3420 };
export const PLACES: Readonly<Record<string, Spot>> = {
    [COW_FIELD]: ARMY_BANK, [STRIKE_TILE]: ARMY_BANK, [SPLASH_FENCE]: ARMY_BANK, [TROOPER_FIELD]: ARMY_BANK,
    'catherby:lobster': CATHERBY_BANK, [AIO_PLACES.flax]: { x: 2744, z: 3445 }, [AIO_PLACES.yews]: SEERS_BANK,
    'shop:ardy': { x: 2654, z: 3283 }, 'shop:catherby': CATHERBY_BANK, 'shop:catherby_arrows': CATHERBY_BANK, 'shop:dargaud': SEERS_BANK, 'shop:magic_guild': { x: 2612, z: 3093 },
    'shop:magic_guild_elemental': { x: 2612, z: 3093 }, 'shop:alfonse': { x: 2654, z: 3283 }, 'shop:tiadeche': { x: 2654, z: 3283 },
    'shop:oziach': { x: 3094, z: 3491 }, 'shop:herquin': { x: 2946, z: 3368 }, 'shop:gem_trader': { x: 3269, z: 3167 },
    'shop:tenzing': { x: 2946, z: 3368 }, 'shop:jukat_dagger': { x: 3152, z: 9578 }, 'shop:taverley': { x: 2934, z: 3376 },
    'shop:siegfried': { x: 2654, z: 3283 }, 'shop:helemos': { x: 2946, z: 3368 }, 'shop:bob': DRAYNOR_BANK,
    'aio:water-altar': DRAYNOR_BANK, 'squad:cosmic-altar': DRAYNOR_BANK, 'fighter:wizards-tower': DRAYNOR_BANK, 'squad:catherby-sharks': CATHERBY_BANK,
    'squad:crystal-chest': { x: 2946, z: 3368 }, 'squad:heroes-fountain': { x: 2946, z: 3368 },
    'squad:shilo-karambwanji': { x: 2852, z: 2955 }, 'squad:shilo-karambwan': { x: 2852, z: 2955 }, 'squad:catherby-cooking': CATHERBY_BANK,
    'squad:seers-magic-trees': SEERS_BANK, 'squad:seers-fletch': SEERS_BANK,
    'squad:varrock-smithing': { x: 3185, z: 3436 }, 'squad:al-kharid-craft': { x: 3269, z: 3167 },
    'squad:rimmington-gold': { x: 2946, z: 3368 }, 'squad:hobgoblin-snape': { x: 2946, z: 3368 },
    'squad:chaos-temple-wine': { x: 2946, z: 3368 }, 'squad:edgeville-unicorns': { x: 3092, z: 3496 },
    'squad:ardougne-giants': { x: 3092, z: 3496 }, 'squad:taverley-druids': { x: 2946, z: 3368 },
    'squad:taverley-scales': { x: 2946, z: 3368 }, 'squad:taverley-black-dragons': { x: 2946, z: 3368 },
    'squad:karamja-red-spiders-eggs': ARMY_BANK,
    'squad:herblore-bank': CATHERBY_BANK, 'squad:magic-enchant': DRAYNOR_BANK,
    'squad:ardougne-blood-chest': ARMY_BANK, 'squad:varrock-earth-altar': VARROCK_EAST_BANK,
    'squad:isafdar-berries': ARMY_BANK, 'squad:taverley-black-knights': { x: 2946, z: 3368 },
    'squad:barbarian-planks': SEERS_BANK, 'squad:gnome-toads': { x: 2449, z: 3482 },
    'shop:sarim': DRAYNOR_BANK, 'shop:betty': DRAYNOR_BANK, 'shop:aubury': VARROCK_EAST_BANK, 'shop:lowe': VARROCK_EAST_BANK, 'shop:zaff': { x: 3185, z: 3436 },
    'shop:zeke': { x: 3269, z: 3167 }, 'shop:dommik': { x: 3269, z: 3167 }, 'shop:dommik_moulds': { x: 3269, z: 3167 }, 'shop:jiminua': { x: 2654, z: 3283 }, 'shop:nurmof': { x: 3013, z: 3355 }, 'shop:scavvo': { x: 3185, z: 3436 },
    'shop:skulgrimen': SEERS_BANK, 'shop:shantay': { x: 3269, z: 3167 }, 'shop:horvik': VARROCK_EAST_BANK, 'shop:louie': { x: 3269, z: 3167 },
    'shop:valaine': { x: 3185, z: 3436 }, 'shop:wydin_choc': DRAYNOR_BANK, 'shop:thessalia': VARROCK_EAST_BANK, 'shop:thessalia_gown': VARROCK_EAST_BANK, 'shop:baker': { x: 2654, z: 3283 },
};
// A template's place: its first resource with one. A chicken pen carries its tile, and a knight spot has the bank.
export function placeOf(t: Pick<Template, 'resources'>): Spot | undefined {
    for (const r of t.resources ?? []) {
        if (r.startsWith('knight:')) return KNIGHT_BANK;
        const m = r.match(/^pen:(\d+),(\d+)$/);
        if (m) return { x: Number(m[1]), z: Number(m[2]) };
        if (PLACES[r]) return PLACES[r];
    }
    return undefined;
}
// The coins the way from `pos` to `place` costs in ferry fares and the toll: 0 for a way with no fare or with no rule,
// null for no way. `mountain`: the account may walk over White Wolf Mountain.
export function wayCost(pos: Spot | undefined, place: Spot | undefined, mountain: boolean): number | null {
    if (!pos || !place) return 0;
    const at = onTutorialIsland(pos) ? LUMBRIDGE : pos;
    if (inWestArdougne(at) !== inWestArdougne(place)) return null;
    if (onKaramja(at)) return onKaramja(place) ? 0 : FERRY_FARE;
    if (inEast(at) && ardougneTarget(place)) return 2 * FERRY_FARE + (at.x >= 3250 && at.z <= 3230 ? TOLL : 0);
    if (inEast(at) && inKandarin(place)) return mountain ? 0 : null;
    if (inKandarin(at) && inEast(place)) return 2 * FERRY_FARE;
    return 0;
}
// Where a coin order meets an account that stands at `pos`: the Ardougne north bank for a start in Kandarin, which
// has no way east without the fare; null on Karamja or inside West Ardougne, where no order can reach the account; else Varrock West (undefined).
export function meetFor(pos: Spot | undefined): 'ardougne' | null | undefined {
    return !pos ? undefined : onKaramja(pos) || inWestArdougne(pos) ? null : inKandarin(pos) ? 'ardougne' : undefined;
}
// The template with `fare` more coins in its coin need.
export function withFare(t: Template, fare: number): Template {
    const key = Object.keys(t.needs?.items ?? {}).find(i => norm(i) === 'coin') ?? 'coins';
    return { ...t, needs: { ...t.needs, items: { ...t.needs?.items, [key]: (t.needs?.items?.[key] ?? 0) + fare } } };
}

type ResourceJob = { script?: string; args?: string[]; env?: Record<string, string>; resources?: string[];
    host?: boolean; orchestrate?: boolean; accounts?: string[]; envByAccount?: Record<string, Record<string, string>> };

// Only location-bearing routes are decoded here. These lightweight contracts avoid
// loading game workers into the planner; their tests compare the actual AIO resolvers.
function resourceSteps(step: Step, inherited: Record<string, string>, depth = 0): Step[] {
    if (depth > 8) throw Error('resource admission: nested chain or AIO pipeline too deep');
    const file = step.script.replace(/\\/g, '/').replace(/^\.\//, ''), env = { ...inherited, ...step.env };
    if (file === 'scripts/chain.ts') return step.args.flatMap(text => resourceSteps(parseStep(text), env, depth + 1));
    const wrapper = /^scripts\/aio-(skiller|fighter|boss|market)\.ts$/.exec(file);
    if (file !== 'scripts/aio.ts' && !wrapper) return [{ script: file, args: step.args, env }];
    const [categoryInput, ...categoryArgs] = wrapper ? [wrapper[1]!, ...step.args] : step.args;
    const category = categoryInput?.toLowerCase().replace(/^--category=/, '');
    if (category === 'pipeline') return categoryArgs.flatMap(text => {
        const [head, ...rest] = tokenizeStep(text);
        if (!head) throw Error('resource admission: empty AIO pipeline step');
        const [cat, ...route] = head.includes(':') ? head.split(':') : [head];
        if (cat === 'quester' && route[0] === 'mode') route.shift();
        return resourceSteps({ script: 'scripts/aio.ts', args: [cat!, ...route, ...rest], env: {} }, env, depth + 1);
    });
    let spec: { script: string; defaultArgs?: readonly string[]; defaultEnv?: Readonly<Record<string, string>> } | undefined;
    let rest: string[] = [];
    if (category === 'fighter') {
        const [target, ...extra] = categoryArgs, key = target?.toLowerCase().replace(/^--target=/, '');
        if (key === 'cow' || key === 'giant' || key === 'druid' || key === 'trooper') spec = { script: 'scripts/gather-combat.ts', defaultEnv: { TARGET: key } };
        if (key === 'chicken') spec = { script: 'scripts/train-chickens.ts', defaultEnv: { TRAIN_BANK: 'draynor' } };
        if (key === 'ranged') spec = { script: 'scripts/ranged-train.ts' };
        rest = extra;
    } else if (category === 'boss') {
        if (categoryArgs[0]?.toLowerCase().replace(/^--boss=/, '') === 'black-dragon') spec = { script: 'scripts/black-dragon-camp.ts' };
        rest = categoryArgs.slice(1);
    } else if (category === 'market') {
        if (categoryArgs[0]?.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '') === 'shop-buy') spec = { script: 'scripts/shop-buyer.ts' };
        rest = categoryArgs.slice(1);
    } else if (category === 'skiller') {
        const [skillInput, methodInput, ...extra] = categoryArgs, skill = skillInput?.toLowerCase().replace(/^--skill=/, '');
        // Inline profiles are self-contained; resource admission never reads job files.
        if (skill === 'bank-job') return [{ script: 'scripts/aio-skiller.ts', args: ['bank-job', ...categoryArgs.slice(1)], env }];
        const { method, args } = resolveSkillerMethod(skill ?? '', methodInput, extra);
        rest = args;
        const workers: Readonly<Record<string, string>> = {
            'woodcutting:yews': 'scripts/gather-yews.ts', 'foraging:flax': 'scripts/gather-flax.ts',
            'foraging:feathers': 'scripts/gather-feathers.ts', 'mining:ore': 'scripts/gather-ore.ts',
            'mining:essence': 'scripts/gather-essence.ts', 'runecraft:air': 'scripts/generated/rcair.ts',
            'runecraft:bank-craft': 'scripts/rune-bank-craft.ts', 'thieving:blood-chest': 'scripts/blood-chest.ts',
            'thieving:knights': 'scripts/goldfarm.ts', 'magic:alch-train': 'scripts/alch-train.ts',
            'magic:splash': 'scripts/splash-train.ts', 'magic:splash-coop': 'scripts/splash-train.ts',
        };
        const route = workers[`${skill}:${method}`] ? [`${skill}:${method}`, workers[`${skill}:${method}`]!] :
            Object.entries(workers).find(([key, worker]) => key.startsWith(`${skill}:`) && worker.endsWith(`${method}.ts`));
        if (route) spec = { script: route[1]!, ...(route[0] === 'magic:splash-coop' ? { defaultEnv: { SPLASH_SITE: 'coop' } } : {}) };
        if (skill === 'fishing' && (method === 'cage' || method === 'harpoon' || method === 'gather-fish')) spec = { script: 'scripts/gather-fish.ts', defaultArgs: [method === 'gather-fish' ? 'cage' : method] };
    }
    return spec ? resourceSteps(resolveRouteStep(spec, rest), env, depth + 1) : [];
}

// Resources are per worker. A hosted job runs one worker for each account, with
// its own environment; an orchestrator is one cooperative worker and keeps its list.
export function jobResources(job: ResourceJob): string[] {
    if (job.host && !job.orchestrate && Array.isArray(job.accounts)) return job.accounts.flatMap(account => jobResources({
        ...job, host: false, accounts: undefined, env: { ...job.env, ...job.envByAccount?.[account] }, envByAccount: undefined,
    }));
    const script = String(job.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (Array.isArray(job.resources) && script !== 'scripts/ranged-train.ts') return job.resources.filter(r => typeof r === 'string');
    const chained = script === 'scripts/chain.ts';
    let direct: Step = { script, args: job.args ?? [], env: {} };
    // Preserve the direct-job metadata convention, while AIO gets its own argv so
    // route defaults and explicit KEY=value options keep the execution precedence.
    if (!chained && !/^scripts\/aio(?:-[a-z]+)?\.ts$/.test(script)) {
        direct = { script, args: [], env: {} };
        for (const token of job.args ?? []) { const m = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/); if (m) direct.env[m[1]!] = m[2]!; else direct.args.push(token); }
    }
    const steps = resourceSteps(direct, job.env ?? {});
    const cheb = (s: string, x: number, z: number) => { const [sx, sz] = s.split(',').map(Number); return Math.max(Math.abs(sx! - x), Math.abs(sz! - z)); };
    const out: string[] = [];
    for (const step of steps) {
        const file = step.script, env = step.env, args = step.args;
        if (file === 'scripts/aio-skiller.ts' && args[0] === 'bank-job') for (const argument of args.slice(1)) {
            if (!argument.startsWith('--job=')) continue;
            const profile = JSON.parse(decodeURIComponent(argument.slice(6))) as BankRouteJob;
            validateBankRouteJob(profile);
            if (profile.family === 'mining' && profile.site?.x === 3286 && profile.site.z === 3368 && profile.site.level === 0
                && profile.bank?.x === 3253 && profile.bank.z === 3420 && profile.bank.level === 0) out.push(AIO_PLACES.ore);
        }
        if (file === 'scripts/goldfarm.ts') {
            const m = (env.KNIGHT_SPOT ?? '2653,3302').match(/^(\d+),(\d+)$/), x = Number(m?.[1] ?? 2653), z = Number(m?.[2] ?? 3302);
            out.push(`knight:${KNIGHT_SPOTS.reduce((b, s) => cheb(s, x, z) < cheb(b, x, z) ? s : b)}`);
        }
        if (file === 'scripts/gather-feathers.ts') {
            const pen = (env.PEN ?? '').match(/^(\d+),(\d+)$/);
            out.push(pen ? `pen:${Number(pen[1])},${Number(pen[2])}` : 'pen:3229,3298');
        }
        if (file === 'scripts/ranged-train.ts') {
            const method = env.PROGRESSION_METHOD;
            if (method === 'ranged/chickens' || method === 'ranged/chickens-oak') out.push('pen:3229,3298');
            else if (method === 'ranged/troopers' || method === 'ranged/troopers-oak' || method === 'ranged/troopers-willow' || method === 'ranged/troopers-maple' || method === 'ranged/guild-willow-mithril') out.push(TROOPER_FIELD);
            else out.push('pen:3229,3298', TROOPER_FIELD);
        }
        if (file === 'scripts/shop-buyer.ts') out.push(`shop:${(args[0] ?? env.PROFILE ?? 'catherby').toLowerCase()}`);
        if (file === 'scripts/gather-fish.ts' && (args[0] ?? env.METHOD ?? 'cage').toLowerCase() === 'cage') out.push('catherby:lobster');
        if (file === 'scripts/gather-combat.ts') {
            const target = (args[1] ?? env.TARGET ?? 'druid').toLowerCase();
            if (target === 'trooper') out.push(TROOPER_FIELD);
            // North/south select the return bank; both profiles fight the same field.
            if (target === 'cow') out.push(COW_FIELD);
        }
        if (file === 'scripts/train-chickens.ts') out.push((env.TRAIN_BANK ?? 'varrock') === 'ardougne' ? 'pen:2691,3277' : 'pen:3229,3298');
        if (file === 'scripts/black-dragon-camp.ts') out.push(BLACK_CAVE);
        if (file === 'scripts/gather-flax.ts') out.push(AIO_PLACES.flax);
        if (file === 'scripts/gather-yews.ts' && env.REGION !== 'lumbridge' && env.REGION !== 'draynor'
            && (env.WOOD_GROVE === undefined || env.WOOD_GROVE === 'native-processing' && ['yew', 'maple'].includes(env.TREE ?? 'yew'))) out.push(AIO_PLACES.yews);
        if (file === 'scripts/gather-ore.ts' && (env.ORE_PROFILE ?? 'mixed') === 'mixed') out.push(AIO_PLACES.ore);
        if (file === 'scripts/gather-essence.ts') out.push(AIO_PLACES.essence);
        if (file === 'scripts/generated/rcair.ts') out.push(AIO_PLACES.air);
        if (file === 'scripts/rune-bank-craft.ts' && env.RUNE_ALTAR === 'air') out.push(AIO_PLACES.air);
        if (file === 'scripts/blood-chest.ts') out.push(AIO_PLACES.blood);
        if (file === 'scripts/splash-train.ts') out.push((env.SPLASH_SITE ?? 'ardougne') === 'coop' ? 'pen:3229,3298' : SPLASH_FENCE);
        // An unknown account can need Wind Strike before alchemy, even with target99.
        // Qualified planner alchemists carry an explicit empty resource override.
        if (file === 'scripts/alch-train.ts' && Number(args[0]) >= 2 && Number(args[0]) <= 99) out.push(STRIKE_TILE);
    }
    return [...new Set([...out, ...(script === 'scripts/ranged-train.ts' && Array.isArray(job.resources) ? job.resources.filter(r => typeof r === 'string' && r !== 'pen:3229,3298' && r !== TROOPER_FIELD) : [])])];
}
