// Autopilot: writes a fleet side's swarm jobs from the route supply bill, account skills and holdings, and tick waste,
// so no person picks jobs, restarts ended ones or spots loops (plan Lanes table, Autopilot).
// plan() is pure: one assignment per account of this side, highest value per tick first, from proven templates only,
// never more accounts on one resource (a knight spot, a chicken pen, a shop) across all sides than its capacity
// (CAPACITY: four farmers to a knight spot, one to a pen or a shop). A job on a resource other accounts already hold
// keeps that resource's shared rate of its value once per holder (SHARED), so the empty spots fill first.
// Value estimates the finite route or army supply a job brings before the next planning pass, minus its spend,
// times the script family's measured work share (1 - idle - move, scripts/tick-waste.ts). A training template is
// worth a share of the needed job it unlocks, and reserves that job's resource and supply. assess() reads recent logs and retires
// it after repeated fail RESULTs or a run that was nearly all idle and walking. finishedTrainers() names the accounts
// whose trainer reached its target, so the next pass needs no timer. scripts/autopilot.ts applies it.
import type { BillRow } from './supply-bill';
import { missionSignature } from '../../core/src/session-admission';
import { xpForLevel } from './curve';
import { ammoTier, boneXp, castRunes, objId, spellFact, toolLevel, wearLevel } from '../../core/src/content-facts';
import { parseStep, tokenizeStep, type Step } from '../../core/src/chain-step';
import { alchSupplies } from './alch-plan';
import { validateBankRouteJob, type BankRouteJob } from '../../core/src/bank-trip';
import { resolveRouteStep, resolveSkillerMethod } from '../../../scripts/aio-route-step';
import { SQUAD_FOOD_HEAL, SQUAD_POTION_ALIASES, squadKeeps, squadRows, type SquadInput } from './squad';
import { ownsWearableMeleeWeapon, type CombatFocus } from './gear-progression';
import { GEAR_GE_ID, GEAR_GE_PILOT, GEAR_SHOP_PILOT, gearJobFor, gearShopId, type GearWantRow } from './gear-want-jobs';
import { cowFoodIds, foodTotalHeal } from '../../core/src/sustain';
import { ORDER_COIN_MARGIN, REFUSAL_ANY_SOURCE } from '../../core/src/order-refusal';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
export type ItemFunding = { from: string; to: string; item: string; count: number; template: string };
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
export const FUND_RESERVE = 50_000;
// The pseudo template of an item order that restocks a gang squad member (the order is the whole job).
export const SQUAD_RESTOCK: Template = { id: 'squad-restock', family: 'kit-buy', script: 'scripts/buy-owned-ge-item.ts', role: 'supply', goal: 'restock the gang squad', yields: () => [] };
// An account's stock is offered to another account's kit only from an observation younger than this
// (scripts/autopilot.ts SIDE_STOCK_MAX_AGE_MS equals it; scripts/autopilot.test.ts checks).
export const OBSERVATION_FRESH_MS = 30 * 60_000;
// The template id of a kit buy for a goal band: `kit-buy:<band id>`. A retired pair (two fail RESULTs with no
// progress: no stock under the cap) sends the account to the donors instead.
export const KIT_BUY = 'kit-buy:', KIT_BUY_SCRIPT = 'scripts/buy-owned-ge-item.ts';
// The army's melee weapon. Most army accounts fight with the bronze sword they started with: at Strength 99 it hits 12
// at most, an adamant scimitar 15 or 16 by style (combat.rs2 combat_maxhit: (effective * (64 + strength bonus) + 320) /
// 640, effective 107 to 110, bonus 5 and 28). The trainer wields the best blade the account owns (scripts/gather-combat.ts selectGiantWeapon), so the
// planner only has to put one in the bank: an army account with Attack 30 and no blade of WEAPON_HELD buys one adamant
// scimitar on the Grand Exchange, as a kit buy, at WEAPON_BAND: before its Ranged band, so every account gets one now
// (owner: all of them, until rune blades arrive), WEAPON_BUYERS accounts away for it at a time.
// Progressive weapon, armour, and skilling-tool tiers (rev-289 equipment requirements and shop/GE sources).
export const WEAPON = { id: 'army-weapon', item: 'adamant scimitar', attack: wearLevel('adamant scimitar', 'attack'), goal: 'fight with an adamant scimitar' } as const;
export const WEAPON_HELD = ['adamant scimitar', 'adamant sword', 'adamant longsword', 'rune scimitar', 'rune sword', 'rune longsword', 'dragon longsword', 'dragon dagger'] as const;
// WEAPON_BUYERS: a blade raises the damage of every later tick (max hit 12 with the bronze sword, 15 or 16 with the
// adamant scimitar), and a buy may take an account from its running band, so four go at a time.
export const WEAPON_BAND = 3.5, WEAPON_BUYERS = 4, WEAPON_MARKET = 'ge:weapon';
export const ARMOUR_BAND = 3.55, RANGED_ARMOUR_BAND = 3.95, ARMOUR_MARKET = 'ge:armour', ARMOUR_BUYERS = 2;
type WeaponStage = { id: string; item: string; fallbacks?: readonly string[]; attack: number; quest?: string; goal: string; held: readonly string[] };
const RUNE_WEAPONS = ['rune scimitar', 'rune longsword', 'rune sword', 'dragon longsword', 'dragon dagger'] as const;
const DRAGON_WEAPONS = ['dragon longsword', 'dragon dagger'] as const;
const WEAPON_STAGES: readonly WeaponStage[] = [
    { id: 'army-weapon-dragon', item: 'dragon dagger', attack: wearLevel('dragon dagger', 'attack'), quest: 'Lost City', goal: 'fight with a dragon dagger', held: DRAGON_WEAPONS },
    { id: 'army-weapon-rune', item: 'rune scimitar', fallbacks: ['rune longsword'], attack: wearLevel('rune scimitar', 'attack'), goal: 'fight with a rune blade', held: RUNE_WEAPONS },
    { id: WEAPON.id, item: WEAPON.item, attack: WEAPON.attack, goal: WEAPON.goal, held: WEAPON_HELD },
];
const RUNE_ARMOUR_BAND = 'army-armour-rune';
const DHIDE_ARMOUR_BAND = 'army-armour-dhide';
// The ids start with `army-weapon-`, so a buy holds the weapon market place (acquire) and may replace a running band.
const BOW_STAGE = 'army-weapon-bow', AMMO_STAGE = 'army-weapon-ammo';
// The levels come from the content (toolLevel); the coins are the price cap of a purchase, which is policy.
const toolLadder = (rows: readonly (readonly [item: string, coins: number])[]): readonly (readonly [level: number, item: string, coins: number])[] =>
    rows.map(([item, coins]) => [toolLevel(item), item, coins] as const);
const PICKAXE_LADDER = toolLadder([['rune pickaxe', 40_000], ['adamant pickaxe', 5_000], ['mithril pickaxe', 2_500], ['steel pickaxe', 1_000], ['iron pickaxe', 300]]);
const AXE_LADDER = toolLadder([['rune axe', 25_000], ['adamant axe', 10_000], ['mithril axe', 4_000], ['steel axe', 1_500], ['iron axe', 200]]);
// A pickaxe or an axe over the account's level is no kit: the account cannot use it. The cheapest pickaxe with a
// price cap is adamant (Mining 31), and a kit buy took it for an account with Mining 1.
export const usableTool = (a: Pick<Acct, 'skills'>, item: string): boolean => {
    const pick = PICKAXE_LADDER.find(([, name]) => name === item), axe = AXE_LADDER.find(([, name]) => name === item);
    return (!pick || (a.skills.Mining ?? 1) >= pick[0]) && (!axe || (a.skills.Woodcutting ?? 1) >= axe[0]);
};
// The quest band of the army: after the blade, before Ranged, so an account does its quests once and goes back to
// training. One account at a time does Lost City: its tree spirit serves one fighter (practice: of three accounts at
// the dramen tree together one finished and two ended "Someone else is fighting that"). LOST_CITY_MEALS is the food
// the run carries with no prayer potion (scripts/quest-sweep.ts STURDY_MEALS).
export const QUEST_BAND = 3.6, LOST_CITY = 'quest:lostcity', LOST_CITY_PLACES = 1, LOST_CITY_MEALS = 10;
// Holy Grail after Merlin's Crystal: 275,000 Prayer experience at the server's rate (quest_grail; research/quest-plan.md
// 1k), what about 150 bought dragon bones give. One account at a time: Sir Mordred and the Black Knight Titan are
// single fights. GRAIL_RUNES: the two quests' teleports (Falador six times, Camelot five, Varrock once; the cast counts
// are the route, the cost of a cast is the content's).
export const GRAIL_BAND = QUEST_BAND + 0.1, GRAIL_PLACE = 'quest:camelot', GRAIL_PLACES = 1, GRAIL_MEALS = 12;
export const GRAIL_RUNES: Readonly<Record<string, number>> = castRunes({ falador_teleport: 6, camelot_teleport: 5, varrock_teleport: 1 });
export const LOST_CITY_FOOD = ['lobster', 'swordfish', 'shark'] as const;
// The Fremennik Trials for a build with a Fremennik helm, just after Lost City. One account at a time: Koschei and
// the Draugen are single fights. FREMENNIK_MEALS: the four sharks of the quest pack.
export const FREMENNIK_BAND = QUEST_BAND + 0.05, FREMENNIK = 'quest:rellekka', FREMENNIK_PLACES = 1, FREMENNIK_MEALS = 4;
// Underground Pass and Regicide for a build with the dragon halberd (BUILD_QUESTS; ROUTE_BEFORE). One account at a
// time: the fights of the pass are single fights. UPASS_AGILITY: a bridge of the pass rolls stat_random(agility, 160,
// 300) (upass_obstacles.rs2:374; PlayerOps.ts STAT_RANDOM: the value 256 of 256 from level 68, 255 at 67), so it
// cannot fail from level 68, and a fall puts the account on the floor of the chasm, which the quest scripts do not
// leave. UPASS_THIEVING: the two cage doors of the pass ask Thieving 50.
// QUEST_BOW_ARROWS: the rune arrows of the practice cases. The meals are the sharks of the cases: 12 for the pass, and
// for Regicide 10 in the pack with 20 in the bank for its second crossing.
export const UPASS_BAND = QUEST_BAND + 0.06, REGICIDE_BAND = QUEST_BAND + 0.07, UPASS = 'quest:upass', UPASS_PLACES = 1;
export const UPASS_AGILITY = 68, UPASS_THIEVING = 50, UPASS_MEALS = 12, REGICIDE_MEALS = 30, QUEST_BOW_ARROWS = 600;
// The runes of Regicide: the Falador and the Ardougne teleport (the quest pack of quest_regicide).
export const REGICIDE_RUNES: Readonly<Record<string, number>> = castRunes({ falador_teleport: 1, ardougne_teleport: 2 });
// What the account holds for Regicide beside the bow pack, the items of the practice case
// extra:sweep-regicide-pure-hally. The quest script takes the coal of the still, the rabbit and a second rope out of
// the bank at Falador, and the sweep takes the first rope for the pack. No shop sells the limestone and the iron fire
// arrows of the quest pack: without them the sweep ends "missing 2532:2,3211:1". For the pestle and mortar the sweep
// goes to the ogre merchant, whose shop does not open. The Grand Exchange lists coal and ropes (a rope from 79,564
// coins; a shop sells one for 23) and none of the others.
export const REGICIDE_PACK: Readonly<Record<string, number>> = { coal: 8, 'cooked rabbit': 1, limestone: 1, 'iron fire arrow': 2, 'pestle and mortar': 1, rope: 2 };
// Fletching 25 for the lyre of The Fremennik Trials: FLETCH_MAKE headless arrows give 25 XP each at the server's
// rate, 5,250 XP against the 4,863 of level 25. The worker keeps FLETCH_KEEP shafts and feathers in the bank
// (scripts/fletch-arrows.ts planHeadless), so the band asks both amounts of each.
export const FLETCH_TO = 25, FLETCH_MAKE = 210, FLETCH_KEEP = 100, ARMY_BANK = { x: 2615, z: 3332 } as const;
// Lost City for an account with a Defence 1 build: the levels, the food and the prayer potions of the practice case
// `extra:lostcity-pure-pray` (scripts/measure/aio-bench-cases.ts). Four seeds: 844 to 1,174 ticks, no food eaten, lowest
// Hitpoints 73 of 93, XP in Strength and Hitpoints only (research/pvp-fight-loop.md, "Quest routes of the builds").
// Under Defence 90 the sweep takes the two prayer potions of the quest pack and reports them when the bank has none.
export const LOST_CITY_BUILD: Needs = {
    skills: { Attack: 60, Strength: 99, Prayer: 43, Hitpoints: 93 }, items: { 'prayer potion(4)': 2 }, pieces: { of: LOST_CITY_FOOD, count: 6 },
};
// The coins a kit buy leaves in the bank (the buy script's CASH_RESERVE). A kit costs far less than FUND_RESERVE, which
// guards a coin donor, so a buyer keeps only this.
export const KIT_CASH_RESERVE = 1_000;
// Coins the plan leaves above the reserve when it sizes a kit buy (see acquire): the observed coins are minutes old when the buy runs.
export const KIT_COIN_MARGIN = ORDER_COIN_MARGIN;
// Unit price caps for kit buys, in coins. Estimates: the owner's hand jobs cap a law rune at 1,600 (shop value 40) and
// a shark at 810 to 1,200 (shop value 300), so a rune caps at about 40 times and food at about 4 times its shop value.
// An offer fills at or under its cap, and scripts/buy-owned-ge-item.ts refunds what does not fill. Gap: no measured
// Grand Exchange price for these items.
export const KIT_PRICE_CAPS: Readonly<Record<string, number>> = {
    'mind rune': 120, 'air rune': 160, 'fire rune': 160, 'nature rune': 800, feather: 20,
    // Live claude-cloud read: body runes 1,460 listed from 184 (bids at 38), earth runes 27,408 from 92 (bids at 39).
    'body rune': 200, 'earth rune': 110,
    // Water runes: 310 listed from 78 in the same read, and Aubury's shelf read 0 on three visits, so the kit buy
    // takes what the market lists and the shop job (army-water-aubury) is the way when a buy gets none.
    'water rune': 110,
    'bronze arrow': 20, 'iron arrow': 40, 'steel arrow': 100, 'mithril arrow': 200, 'adamant arrow': 400, 'rune arrow': 1200,
    trout: 100, lobster: 500, swordfish: 700, shark: 1200,
    // Live claude-cloud read: 42 listed at 72,000, bids at 33,068, volume-weighted price 38,089.
    'adamant scimitar': 80_000,
    'rune scimitar': 50_000, 'rune longsword': 45_000, 'dragon dagger': 50_000, 'dragon longsword': 120_000,
    shortbow: 500, 'oak shortbow': 800, 'willow shortbow': 2_500, 'maple shortbow': 5_000, 'yew shortbow': 15_000,
    coif: 1_000, 'studded body': 2_500, 'studded chap': 2_000,
    'dragonhide body': 15_000, 'dragonhide chap': 8_000, 'dragon vambrace': 6_000,
    'adamant full helm': 8_000, 'adamant plateleg': 15_000, 'adamant platebody': 25_000,
    'rune full helm': 45_000, 'rune kiteshield': 65_000, 'rune plateleg': 75_000, 'rune plateskirt': 75_000, 'rune chainbody': 60_000, 'rune platebody': 80_000,
    // Lumber & mining skilling tools (Bob's Axes in Lumbridge lacks mithril+ axes and has no shop profile).
    'steel axe': 1_500, 'mithril axe': 4_000, 'adamant axe': 10_000, 'rune axe': 25_000,
    'adamant pickaxe': 6_000, 'rune pickaxe': 40_000,
    // The hunters' kit (army-hunt-black-dragons). Live claude-cloud: 5 law runes for 5,260 coins and 7 sharks for 7,189;
    // magic shortbows 108 listed from 51,000.
    'law rune': 1_600, 'magic shortbow': 60_000,
    // The Zanaris market door's tax (army-jakut-swords). Live claude-cloud read: 1,219 listed from 145,000.
    diamond: 150_000,
    // Live claude-cloud read: dragon bones 1,009 listed from 9,000 (mean 9,687); big bones 1,686 from 2,399 (mean 2,526).
    'dragon bone': 10_000, 'big bone': 2_600,
    // The two prayer potions of Lost City for a Defence 1 build (LOST_CITY_BUILD). No shop sells them and the bank
    // snapshots of the sides hold none. Live read: 38 listed from 250,000, bids at 25,000.
    'prayer potion(4)': 260_000,
    // The coal of Regicide's still (REGICIDE_PACK). Live read: 17,157 listed from 499, bids at 104, volume-weighted
    // price 586.
    coal: 600,
};

// Only a finite consumer gives an output value. Shop prices compare needed supplies; an unpriced needed item keeps
// a value of one so missing price data cannot turn a route requirement into surplus.
export const BILL_PREMIUM = 2, TRAIN_SHARE = 0.25;
// scripts/autopilot.ts plans every ten minutes: 1,000 game ticks at 600 ms per tick. This is an output estimate,
// not a claim that a worker stops at this bound; the next pass reads its actual holdings.
export const VALUE_TICKS = 1000;
// A production pilot that the `aio` list does not name ranks at this share of its worth (Inputs.pilotFallback).
export const PILOT_FALLBACK_SHARE = 0.05;
// A pilot that makes or gathers a bill item for the route or the army kit and needs no quest, band or combat: the AIO skiller
// routes (mining, woodcutting, smelting, smithing, fletching, crafting, runecraft, cooking, fishing) and the maker chains.
export const selfServePilot = (t: Template): boolean => !!t.pilot && !t.tier && !t.quest && !t.once && !t.buildOnly && !t.trains && !t.provides
    && (!!t.production || !!t.aio?.startsWith('skiller:'));
// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
// A steel bar is on no line of the bill: it is needed while cannonballs are short (one bar casts 4, cannonballs.rs2).
export const FEEDS: Record<string, string[]> = {
    feather: ['headless arrow'],
    'arrow shaft': ['headless arrow'],
    'raw lobster': ['lobster'],
    'raw karambwanji': ['raw karambwan', 'cooked karambwan'],
    'raw karambwan': ['cooked karambwan'],
    cake: ['chocolate cake'],
    'chocolate bar': ['chocolate cake', 'chocolate dust'],
    log: ['arrow shaft', 'headless arrow'],
    logs: ['arrow shaft', 'headless arrow'],
    flax: ['bow string'],
    'magic log': ['magic shortbow', 'unstrung magic shortbow'],
    'bow string': ['magic shortbow', 'yew shortbow'],
    'unstrung magic shortbow': ['magic shortbow'],
    'rune essence': ['air rune', 'water rune', 'earth rune', 'fire rune'],
    'steel bar': ['cannonball', 'nail'],
    'gold ore': ['gold bar'],
    'gold bar': ['sapphire ring', 'ring of recoil', 'emerald ring', 'ring of dueling(8)', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory'],
    'uncut sapphire': ['sapphire', 'sapphire ring', 'ring of recoil'],
    sapphire: ['sapphire ring', 'ring of recoil'],
    'sapphire ring': ['ring of recoil'],
    'uncut emerald': ['emerald', 'emerald ring', 'ring of dueling(8)'],
    emerald: ['emerald ring', 'ring of dueling(8)'],
    'emerald ring': ['ring of dueling(8)'],
    'uncut dragonstone': ['dragonstone', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory'],
    dragonstone: ['dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory'],
    'dragonstone ring': ['ring of wealth'],
    'unstrung dragonstone amulet': ['strung dragonstone amulet', 'amulet of glory'],
    'strung dragonstone amulet': ['amulet of glory'],
    'ball of wool': ['strung dragonstone amulet', 'amulet of glory'],
    'cosmic rune': ['ring of recoil', 'ring of dueling(8)', 'amulet of glory', 'ring of wealth'],
    'air rune': ['ring of dueling(8)'],
    'earth rune': ['amulet of glory', 'ring of wealth'],
    'water rune': ['amulet of glory', 'ring of wealth'],
    'runite bar': ['rune arrowtips', 'rune arrow', 'rune arrow(p)', 'rune full helm', 'rune platebody', 'rune plateleg', 'rune kiteshield'],
    'runite ore': ['runite bar'],
    coal: ['runite bar'],
    'rune arrowtip': ['rune arrow', 'rune arrow(p)'],
    'rune arrowtips': ['rune arrow', 'rune arrow(p)'],
    'headless arrow': ['rune arrow', 'rune arrow(p)'],
    'rune arrow': ['rune arrow(p)'],
    dragonhide_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    dragon_leather_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    'dragon dagger': ['dragon dagger(p)'],
    'weapon poison': ['dragon dagger(p)', 'rune arrow(p)'],
    keyhalf1: ['crystal key'],
    keyhalf2: ['crystal key'],
    'vial of water': [
        'guam potion (unf)', 'tarromin potion (unf)', 'harralander potion (unf)', 'ranarr potion (unf)', 'toadflax potion (unf)',
        'irit potion (unf)', 'avantoe potion (unf)', 'kwuarm potion (unf)', 'snapdragon potion (unf)', 'cadantine potion (unf)',
        'lantadyme potion (unf)', 'dwarf weed potion (unf)', 'torstol potion (unf)', 'marrentill potion (unf)',
        'prayer potion(3)', 'prayer potion(4)', 'super attack(3)', 'super attack(4)', 'super strength(3)', 'super strength(4)',
        'super defence(3)', 'super defence(4)', 'ranging potion(3)', 'ranging potion(4)',
        'super energy(3)', 'super energy(4)', 'agility potion(3)', 'agility potion(4)',
        'super restore(3)', 'super restore(4)', 'magic potion(3)', 'magic potion(4)', 'zamorak potion(3)', 'zamorak potion(4)',
        'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)', 'weapon poison',
    ],
    'harralander': ['harralander potion (unf)'],
    'unidentified harralander': ['harralander', 'harralander potion (unf)'],
    'lantadyme': ['lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'unidentified lantadyme': ['lantadyme', 'lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'lantadyme potion (unf)': ['magic potion(3)', 'magic potion(4)'],
    'potato cactu': ['magic potion(3)', 'magic potion(4)'],
    'magic potion(3)': ['magic potion(4)'],
    'torstol': ['torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'unidentified torstol': ['torstol', 'torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'torstol potion (unf)': ['zamorak potion(3)', 'zamorak potion(4)'],
    jangerberrie: ['zamorak potion(3)', 'zamorak potion(4)'],
    'zamorak potion(3)': ['zamorak potion(4)'],
    'snapdragon': ['snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'unidentified snapdragon': ['snapdragon', 'snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'snapdragon potion (unf)': ['super restore(3)', 'super restore(4)'],
    "red spiders' egg": ['super restore(3)', 'super restore(4)'],
    'super restore(3)': ['super restore(4)'],
    'ranarr weed': ['ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'unidentified ranarr': ['ranarr weed', 'ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'ranarr potion (unf)': ['prayer potion(3)', 'prayer potion(4)'],
    'snape grass': ['prayer potion(3)', 'prayer potion(4)'],
    'prayer potion(3)': ['prayer potion(4)'],
    'toadflax': ['toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'unidentified toadflax': ['toadflax', 'toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'toadflax potion (unf)': ['agility potion(3)', 'agility potion(4)'],
    'swamp toad': ["toad's leg", 'agility potion(3)', 'agility potion(4)'],
    "toad's leg": ['agility potion(3)', 'agility potion(4)'],
    'agility potion(3)': ['agility potion(4)'],
    avantoe: ['avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'unidentified avantoe': ['avantoe', 'avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'avantoe potion (unf)': ['super energy(3)', 'super energy(4)'],
    'mort myre fungi': ['super energy(3)', 'super energy(4)'],
    'super energy(3)': ['super energy(4)'],
    'irit leaf': ['irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'unidentified irit': ['irit leaf', 'irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'irit potion (unf)': ['super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'eye of newt': ['super attack(3)', 'super attack(4)'],
    'super attack(3)': ['super attack(4)'],
    kwuarm: ['kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'unidentified kwuarm': ['kwuarm', 'kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'kwuarm potion (unf)': ['super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'limpwurt root': ['super strength(3)', 'super strength(4)'],
    'super strength(3)': ['super strength(4)'],
    cadantine: ['cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'unidentified cadantine': ['cadantine', 'cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'cadantine potion (unf)': ['super defence(3)', 'super defence(4)'],
    'white berrie': ['super defence(3)', 'super defence(4)'],
    'super defence(3)': ['super defence(4)'],
    'dwarf weed': ['dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'unidentified dwarf weed': ['dwarf weed', 'dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'dwarf weed potion (unf)': ['ranging potion(3)', 'ranging potion(4)'],
    'wine of zamorak': ['ranging potion(3)', 'ranging potion(4)'],
    'ranging potion(3)': ['ranging potion(4)'],
    marrentill: ['marrentill potion (unf)', 'antipoison(3)'],
    'unidentified marentill': ['marrentill', 'marrentill potion (unf)', 'antipoison(3)'],
    'marrentill potion (unf)': ['antipoison(3)'],
    'unicorn horn': ['unicorn horn dust', 'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'unicorn horn dust': ['antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'superantipoison(3)': ['superantipoison(4)'],
    'blue dragon scale': ['dragon scale dust', 'weapon poison', 'rune arrow(p)'],
    'dragon scale dust': ['weapon poison', 'rune arrow(p)'],
};
const POTION_FEED_FOUR = new Set([
    'prayer potion(4)', 'super attack(4)', 'super strength(4)', 'super defence(4)',
    'ranging potion(4)', 'super energy(4)', 'agility potion(4)', 'superantipoison(4)',
    'super restore(4)', 'magic potion(4)', 'zamorak potion(4)', 'restore potion(4)',
]);
const feedUnits = (item: string, output: string) => {
    if (!(FEEDS[item] ?? []).includes(output)) return 0;
    if (item === 'log' || item === 'logs') return 1 / 15;
    if (item === 'raw karambwanji') return 3;
    if (item === 'steel bar') return output === 'nail' ? 0.5 : 1 / 4;
    if (item === 'air rune' && output === 'ring of dueling(8)') return 3;
    if ((item === 'earth rune' || item === 'water rune') && (output === 'amulet of glory' || output === 'ring of wealth')) return 15;
    if ((item === 'weapon poison' || item === 'dragon scale dust' || item === 'blue dragon scale' || item === 'kwuarm' || item === 'unidentified kwuarm' || item === 'kwuarm potion (unf)') && output === 'rune arrow(p)') return 1 / 5;
    if (item === 'runite bar') return output === 'rune arrowtips' || output === 'rune arrow' || output === 'rune arrow(p)' ? 1 / 15 : output === 'rune platebody' ? 5 : output === 'rune full helm' ? 2 : output === 'rune plateleg' || output === 'rune kiteshield' ? 3 : 1;
    if (item === 'coal') return 8;
    if (item === 'dragonhide_black' || item === 'dragon_leather_black') return output === 'black_dragonhide_body' ? 3 : output === 'black_dragonhide_chaps' ? 2 : 1;
    if (POTION_FEED_FOUR.has(output)) return 4 / 3;
    return 1;
};
export const norm = (s: string) => s.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim().replace(/s$/, '');
export const pairKey = (account: string, template: string) => `${account.toLowerCase()}:${template}`;
// HP one held item heals over all its bites, by item name. The content gives it (consume_normal.dbrow heal of each
// bite, cooking_inv next_obj_stage for the bites), for the cow farm's food of core/sustain.ts cowFoodIds.
const itemNames = new Map((JSON.parse(readFileSync(resolve(import.meta.dir, '../../../knowledge/items.json'), 'utf8')) as { id: number; name: string }[]).map(i => [i.id, i.name]));
export const FOOD_HEAL: Readonly<Record<string, number>> = Object.fromEntries(cowFoodIds().map(id => [norm(itemNames.get(id)!), foodTotalHeal(id)!]));
export const foodHeal = (a: Acct) => Object.entries(FOOD_HEAL).reduce((n, [item, hp]) => n + (a.items[item] ?? 0) * hp, 0);

const billUnits = (item: string, bill: readonly BillRow[]) => bill.reduce((n, r) => {
    const names = [r.item, ...(r.aliases ?? [])].map(norm);
    return n + Math.max(0, r.short) * (names.includes(item) ? 1 : Math.max(0, ...names.map(name => feedUnits(item, name))));
}, 0);
export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>, coin = 1): number {
    const k = norm(item);
    if (billUnits(k, bill) <= 0) return 0;
    return k === 'coin' ? coin : Math.max(1, prices[k] ?? 0) * BILL_PREMIUM;
}
// The shop values that unitValue reads, by norm() name: the cost of the first item with each name. A bill line whose
// name is no item's name takes the highest cost of the item ids of the line (supply-bill.ts idsFor): every unfinished
// potion is the item "Unfinished potion", and the line "mort myre fungus" is the item "Mort myre fungi". Without the
// entry a maker of such a line has no value.
export function priceTable(items: readonly { id: number; name?: string; debugname?: string; cost?: number }[], bill: readonly BillRow[]): Record<string, number> {
    const prices: Record<string, number> = {}, cost = new Map(items.map(i => [i.id, i.cost ?? 0]));
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    for (const r of bill) for (const name of [r.item, ...(r.aliases ?? [])])
        if (r.ids.length && !(norm(name) in prices)) prices[norm(name)] = Math.max(...r.ids.map(id => cost.get(id) ?? 0));
    return prices;
}

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
// The combat style an account trains, for its gear wants: the style of the band it runs now, else of the next army band it has levels
// left in (the lowest band number first). An account off the army with no such job, or with no band left, has none.
const SKILL_STYLE: Readonly<Record<string, CombatFocus>> = { Attack: 'melee', Strength: 'melee', Defence: 'melee', Hitpoints: 'melee', Ranged: 'ranged', Magic: 'magic' };
export function accountStyle(a: Acct, templates: readonly Template[], currentId: string | undefined, army: boolean): CombatFocus | null {
    const own = templates.find(t => t.id === currentId)?.trains?.skill;
    if (own && SKILL_STYLE[own]) return SKILL_STYLE[own]!;
    if (!army) return null;
    const next = templates.filter(t => t.tier === 'goal' && !t.filler && t.trains && SKILL_STYLE[t.trains.skill] && bandLeft(t, a) > 0).sort((x, y) => (x.band ?? 0) - (y.band ?? 0) || x.id.localeCompare(y.id))[0];
    return next?.trains ? SKILL_STYLE[next.trains.skill]! : null;
}
const isShort = (a: Acct, needs: Template['needs']) => (!needs?.shortOf || Object.entries(needs.shortOf).some(([i, n]) => (a.items[norm(i)] ?? 0) < n))
    && Object.entries(needs?.holds ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n);
// The items a frail account is short of for these needs: 0 for an account with the Hitpoints, or with no such need.
// The cheap weapons that fill a missing melee weapon line, by the Attack level that wears each (the Varrock sword shop and
// Zeke's scimitars), cheapest first.
export const COW_WEAPONS: readonly (readonly [item: string, attack: number])[] = [['bronze sword', 1], ['iron scimitar', 1], ['steel scimitar', 5], ['mithril scimitar', 20]];
// The gear check selects a whole loadout, so it is cached for the holdings object of an account (one per plan input) and
// the levels and quests that it reads.
const meleeCache = new WeakMap<object, Map<string, boolean>>();
const ownsMelee = (a: Acct): boolean => {
    const key = `${a.skills.Attack ?? 1}|${a.skills.Strength ?? 1}|${[...(a.quests ?? [])].join(',')}`;
    let by = meleeCache.get(a.items);
    if (!by) meleeCache.set(a.items, by = new Map());
    let owned = by.get(key);
    if (owned === undefined) by.set(key, owned = ownsWearableMeleeWeapon(a.items, a.skills, a.quests));
    return owned;
};
const weaponLine = (a: Acct): Lack => ({ of: COW_WEAPONS.filter(([, attack]) => (a.skills.Attack ?? 1) >= attack).map(([item]) => item), count: 1 });
const frailShort = (a: Acct, needs: Template['needs']) => !needs?.frail || (a.skills.Hitpoints ?? 10) >= needs.frail.hitpoints ? 0
    : Math.max(0, needs.frail.count - needs.frail.of.reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0));
const healthMet = (a: Acct, needs: Template['needs']) => !needs?.hpAboveHalf
    || (Number.isFinite(a.currentHP) && a.currentHP! > Math.ceil((a.skills.Hitpoints ?? 10) / 2));
const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }): boolean =>
    (a.combat ?? combatLevel(a.skills)) >= (needs?.combat ?? 0)
    && healthMet(a, needs)
    && (!needs?.meleeWeapon || ownsMelee(a))
    && (needs?.quests ?? []).every(q => questDone(a, q))
    && (a.questPoints ?? 0) >= (needs?.questPoints ?? 0)
    && frailShort(a, needs) === 0
    && Object.entries(needs?.skills ?? {}).every(([s, l]) => (skillOverride?.skill === s ? Math.max(skillOverride.to, a.skills[s] ?? 1) : a.skills[s] ?? 1) >= l)
    && Object.entries(needs?.items ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n)
    && Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
    && Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n)
    && isShort(a, needs)
    && foodHeal(a) >= (needs?.food ?? 0)
    && (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0) >= (needs?.pieces?.count ?? 0)
    && (needs?.anyOf === undefined || needs.anyOf.some(alt => meets(a, alt, skillOverride)));
// The coins a template needs beyond what the account holds, and its needs without the coin line.
const coinShort = (a: Acct, needs: Template['needs']) => Math.max(0, (Object.entries(needs?.items ?? {}).find(([i]) => norm(i) === 'coin')?.[1] ?? 0) - (a.items.coin ?? 0));
const withoutCoins = (needs: Template['needs']): Template['needs'] => ({ ...needs, items: Object.fromEntries(Object.entries(needs?.items ?? {}).filter(([i]) => norm(i) !== 'coin')) });

// What an account still lacks of these needs, each as a short phrase: a level, a quest, a holding. The coin line and
// holdings that a purchase fixes are listed too, so a vacant slot names the first thing that stops its template.
export function unmet(a: Acct, needs: Template['needs']): string[] {
    if (!needs) return [];
    const out: string[] = [];
    const combat = a.combat ?? combatLevel(a.skills);
    if (combat < (needs.combat ?? 0)) out.push(`combat ${needs.combat}`);
    for (const q of needs.quests ?? []) if (!questDone(a, q)) out.push(`quest ${q}`);
    if ((a.questPoints ?? 0) < (needs.questPoints ?? 0)) out.push(`${needs.questPoints} quest points`);
    for (const [s, l] of Object.entries(needs.skills ?? {})) if ((a.skills[s] ?? 1) < l) out.push(`${s} ${l}`);
    for (const [s, l] of Object.entries(needs.under ?? {})) if ((a.skills[s] ?? 1) >= l) out.push(`${s} under ${l}`);
    for (const [i, n] of Object.entries(needs.items ?? {})) if ((a.items[norm(i)] ?? 0) < n) out.push(`${n - (a.items[norm(i)] ?? 0)} ${norm(i)}`);
    for (const [i, n] of Object.entries(needs.holdsUnder ?? {})) if ((a.items[norm(i)] ?? 0) >= n) out.push(`fewer than ${n} ${norm(i)}`);
    for (const [i, n] of Object.entries(needs.holds ?? {})) if ((a.items[norm(i)] ?? 0) < n) out.push(`${n} ${norm(i)} from its own job`);
    if (needs.shortOf && !isShort(a, { shortOf: needs.shortOf })) out.push(`to be short of ${Object.keys(needs.shortOf).join(' or ')}`);
    if (needs.pieces) { const n = needs.pieces.count - needs.pieces.of.reduce((sum, i) => sum + (a.items[norm(i)] ?? 0), 0); if (n > 0) out.push(`${n} of ${needs.pieces.of.join('/')}`); }
    if (needs.meleeWeapon && !ownsMelee(a)) out.push('a wearable melee weapon');
    if (foodHeal(a) < (needs.food ?? 0)) out.push(`${needs.food} HP of food`);
    if (!healthMet(a, needs)) out.push('current Hitpoints above half');
    if (frailShort(a, needs) > 0) out.push(`${frailShort(a, needs)} of ${needs.frail!.of.slice(0, 3).join('/')}`);
    if (needs.anyOf && !needs.anyOf.some(alt => meets(a, alt))) {
        const alts = needs.anyOf.map(alt => unmet(a, alt)).sort((x, y) => x.length - y.length);
        out.push(...(alts[0] ?? []));
    }
    return out;
}
// The kit lines an account still lacks for these needs, or null when a level it does not have (or a holding it must
// not have) stops the job: no item fixes that. The coin line is not a kit line (coinShort). Of several `anyOf`
// kits the account takes one whose every line it `can` get (a buy: 250 fire runes, not a fire staff no market sells),
// then the one with the fewest missing units.
export function kitLacks(a: Acct, needs: Template['needs'], can: (item: string, count: number) => boolean = () => true): Lack[] | null {
    if (!healthMet(a, needs) || (a.combat ?? combatLevel(a.skills)) < (needs?.combat ?? 0) || !(needs?.quests ?? []).every(q => questDone(a, q))
        || (a.questPoints ?? 0) < (needs?.questPoints ?? 0)
        || !Object.entries(needs?.skills ?? {}).every(([s, l]) => (a.skills[s] ?? 1) >= l)
        || !Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
        || !Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n) || !isShort(a, needs)) return null;
    const out: Lack[] = [];
    for (const [i, n] of Object.entries(needs?.items ?? {})) {
        const short = n - (a.items[norm(i)] ?? 0);
        if (norm(i) !== 'coin' && short > 0) out.push({ of: [norm(i)], count: short });
    }
    if (needs?.meleeWeapon && !ownsMelee(a)) out.push(weaponLine(a));
    const hp = (needs?.food ?? 0) - foodHeal(a);
    if (hp > 0) out.push({ of: ['trout'], count: Math.ceil(hp / FOOD_HEAL.trout!) });
    const pieces = (needs?.pieces?.count ?? 0) - (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0);
    if (pieces > 0) out.push({ of: needs!.pieces!.of.map(norm), count: pieces });
    const frail = frailShort(a, needs);
    if (frail > 0) out.push({ of: needs!.frail!.of.map(norm), count: frail });
    if (needs?.anyOf) {
        const units = (lacks: readonly Lack[]) => lacks.reduce((n, l) => n + l.count, 0), blocked = (lacks: readonly Lack[]) => lacks.filter(l => !l.of.some(i => can(i, l.count))).length;
        const kits = needs.anyOf.map(alt => kitLacks(a, alt, can)).filter((k): k is Lack[] => k !== null).sort((x, y) => blocked(x) - blocked(y) || units(x) - units(y));
        if (!kits.length) return null;
        out.push(...kits[0]!);
    }
    return out;
}
// The most of each item any goal band needs to start, by norm() name: a donor keeps that many, so it never gives away
// its own kit. For `own`, also the batch a band works out for that account (the runes its Magic still casts). A band
// for build accounts only is left out: its kit (310 arrow shafts and feathers) is not a kit of the donors. So is a `once`
// quest: its pack (700 fire runes for Hero's Quest) is one account's single run, not a stock every donor keeps.
export function kitReserve(templates: readonly Template[], own?: Acct): Record<string, number> {
    const reserve: Record<string, number> = {};
    const count = (needs: Template['needs']) => {
        for (const [i, n] of Object.entries(needs?.items ?? {})) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        for (const i of needs?.pieces?.of ?? []) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, needs!.pieces!.count);
        for (const alt of needs?.anyOf ?? []) count(alt);
    };
    for (const t of templates) if (t.tier === 'goal' && !t.buildOnly && !t.once && !t.noReserve) {
        count(t.needs);
        if (own && t.batchFor) for (const [i, n] of Object.entries(t.batchFor(own))) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        // A band that needs a melee weapon keeps the cheap weapon an account holds: giving away its only one ends the band at once. An
        // account of known holdings (`own`) keeps the weapons it holds; every other donor (another side's, a local account outside the
        // roster) keeps one of each, since its own band is not known here.
        if (t.needs?.meleeWeapon) for (const [weapon] of COW_WEAPONS) if (!own || (own.items[weapon] ?? 0) > 0) reserve[weapon] = Math.max(reserve[weapon] ?? 0, 1);
    }
    delete reserve.coin;
    return reserve;
}
// A batch of several lines that the account cannot pay in full: the same share of every line's batch that the coins reach, never under
// the line's start. The cost counts each line at its price cap (`limit`). With less than the start it returns the start.
export function proportionalLines(full: readonly KitLine[], start: readonly KitLine[], budget: number): KitLine[] {
    const cost = (lines: readonly KitLine[]) => lines.reduce((n, l) => n + l.quantity * l.limit, 0), floor = cost(start);
    if (budget <= floor) return [...start];
    const extra = cost(full) - floor;
    if (extra <= 0) return [...start];
    const share = Math.min(1, (budget - floor) / extra);
    return full.map((l, i) => ({ ...l, quantity: start[i]!.quantity + Math.floor((l.quantity - start[i]!.quantity) * share) }));
}
// One Grand Exchange order of a kit buy. `held` is what the account holds now: the buy script tops up exactly that many.
export type KitLine = { item: string; id: number; quantity: number; held: number; limit: number };
// The job that buys an army account's missing kit for a goal band: one login, one capped order per item
// (scripts/chain.ts runs scripts/buy-owned-ge-item.ts once per line). The buy script keeps one journal per order key
// and never buys again under a settled key. The key names the account's kit-buy count (`seq`, which
// scripts/autopilot.ts raises when the account leaves a kit buy) and the holding before and after: a rerun of one buy
// continues its order, and a later top-up from the same holding is a new order. Not a trainer: it does not repeat, and
// the account takes the band on the pass after its RESULT.
export function kitBuyTemplate(band: Template, account: string, lines: readonly KitLine[], seq = 0, cashReserve = KIT_CASH_RESERVE): Template {
    const step = (l: KitLine) => [KIT_BUY_SCRIPT, `ITEM_ID=${l.id}`, `QUANTITY=${l.quantity}`, ...(l.held > 0 ? [`EXPECTED_OWNED=${l.held}`] : []), `LIMIT_PRICE=${l.limit}`,
        `CASH_RESERVE=${cashReserve}`, `ORDER_KEY=${account.toLowerCase()}-kit${seq}-${l.id}-${l.held}to${l.held + l.quantity}`, 'ORDER_MS=900000', 'FILL_WAIT_TICKS=200'].join(' ');
    return { id: KIT_BUY + band.id, family: 'kit-buy', script: 'scripts/chain.ts', args: lines.map(step), env: { ROUNDS: '1' }, role: 'supply',
        goal: `buy ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} on the Grand Exchange to ${band.goal}`, repeats: false, yields: () => [] };
}

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste' | 'coinValue'>,
    needed: (item: string) => number = item => billUnits(norm(item), inp.bill)): number {
    const coin = inp.coinValue ?? 1;
    const flows = t.yields(a).filter(f => f.perTick > 0);
    const work = Math.min(VALUE_TICKS, Math.max(0, ...flows.map(f => needed(norm(f.item)) / f.perTick)));
    const gross = flows.reduce((v, f) => v + Math.min(f.perTick * work, needed(norm(f.item))) * unitValue(f.item, inp.bill, inp.prices, coin), 0) / VALUE_TICKS;
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? coin : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost * work / VALUE_TICKS) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
}

const hasMarket = (inp: Inputs, item: string) => !!inp.market?.[item];
const hasStock = (inp: Inputs, item: string) => !!(inp.stock ?? []).some(s => (s.items[item] ?? 0) > 0);
const hasSupply = (inp: Inputs, item: string) => hasMarket(inp, item) || hasStock(inp, item);
function weaponStageFor(a: Acct, inp: Inputs): { id: string; item: string; goal: string } | null {
    const att = a.skills.Attack ?? 1;
    for (const s of WEAPON_STAGES) {
        if (att < s.attack || (s.quest && !questDone(a, s.quest))) continue;
        if (s.held.some(w => (a.items[w] ?? 0) > 0)) return null;
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + s.id));
        const choices = [s.item, ...(s.fallbacks ?? [])];
        const available = choices.find(c => hasStock(inp, c) || (!buyRetired && hasMarket(inp, c)));
        if (available) return { id: s.id, item: available, goal: s.goal };
        if (s.id === WEAPON.id && !buyRetired) return { id: s.id, item: s.item, goal: s.goal };
    }
    return null;
}
// The kit stages follow the style that the account trains: a ranged trainer gets a bow, arrows and dragonhide, never
// the melee blade and rune armour (rune armour costs Ranged accuracy); a magic trainer gets no kit stage, so the gear pass
// (gear-want-jobs.ts) buys its staff and robes. An account with no band left keeps the melee kit and the dragonhide.
type KitStyles = { melee: boolean; ranged: boolean };
const KIT_STAGE_STYLE: Readonly<Record<string, CombatFocus>> = Object.fromEntries([...WEAPON_STAGES.map(s => [s.id, 'melee']),
    [RUNE_ARMOUR_BAND, 'melee'], [DHIDE_ARMOUR_BAND, 'ranged'], [BOW_STAGE, 'ranged'], [AMMO_STAGE, 'ranged']] as [string, CombatFocus][]);
export function kitStyle(a: Acct, inp: Pick<Inputs, 'templates' | 'current' | 'running'>, bands: readonly { template: Template; lacks?: unknown }[] = []): CombatFocus | null {
    const lower = a.name.toLowerCase(), now = inp.current?.get(lower);
    // A kit buy that runs keeps the style of its own stage, so the account does not change its buy when its band changes.
    // A finished bow buy leads on to its arrows and dragonhide. A finished melee buy does not lead on to the rest of the rune
    // set: an account that left its melee band takes the style of its next band.
    const stage = now?.startsWith(KIT_BUY) ? KIT_STAGE_STYLE[now.slice(KIT_BUY.length)] : undefined;
    if (stage && (stage === 'ranged' || inp.running?.has(lower))) return stage;
    // The band that it runs now.
    const own = accountStyle(a, inp.templates, now, false);
    if (own) return own;
    // Else the first combat band that it can start now (its needs are met, or a kit buy supplies them), the one with no missing
    // kit first: a band whose level it lacks is no candidate, so a Magic 1 account is not a magic trainer for the Magic band
    // alone. `bands` are the goal candidates of the pass in band order.
    const combat = bands.filter(c => c.template.trains && SKILL_STYLE[c.template.trains.skill] && !c.template.filler);
    const first = combat.find(c => !c.lacks) ?? combat[0];
    if (first) return SKILL_STYLE[first.template.trains!.skill]!;
    return accountStyle(a, inp.templates, now, true);
}
const kitStylesOf = (style: CombatFocus | null): KitStyles => ({ melee: style === null || style === 'melee', ranged: style === null || style === 'ranged' });
export type KitStage = { id: string; goal: string; items: { item: string; count: number }[] };
// The shortbows by Ranged level, the highest first (a shortbow fires faster than a longbow of its level).
const bowLadder = () => BOWS.filter(([bow]) => bow.endsWith('shortbow')).sort((x, y) => y[1] - x[1]);
// The Ranged level of the best bow that the account owns and can wear, or 0.
const ownedBowLevel = (a: Acct) => Math.max(0, ...BOWS.filter(([bow, level]) => level <= (a.skills.Ranged ?? 1) && (a.items[bow] ?? 0) > 0).map(([, level]) => level));
// A bow upgrade for a Ranged account: the best shortbow for its Ranged level that a market or owned stock supplies, unless it
// owns a bow of that level or better.
export function bowStageFor(a: Acct, inp: Inputs): (KitStage & { level: number }) | null {
    const ranged = a.skills.Ranged ?? 1, owned = ownedBowLevel(a), buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + BOW_STAGE));
    for (const [bow, level] of bowLadder()) {
        if (ranged < level) continue;
        if (owned >= level) return null;
        if (hasStock(inp, bow) || (!buyRetired && hasMarket(inp, bow))) return { id: BOW_STAGE, goal: `fire a ${bow}`, level, items: [{ item: bow, count: 1 }] };
    }
    return null;
}
// Arrows for the bow the account fires: the best tier that the bow and the Ranged level allow and that its coins pay for in
// a batch (a consumable, so a margin stays), unless it holds a stock of that tier or better. `bowLevel` is the level of the bow
// it will wield.
// The arrows are a consumable and the stage buys again when they run low, so it is bounded: it fires only when the account holds
// under AMMO_LOW arrows of the tier or better (a bought batch of AMMO_BATCH lasts hundreds of thousands of Ranged experience:
// the band loses 0.67 to 2.02 arrows per 1,000 experience), it never replaces a running band (its place is AMMO_MARKET, not the
// weapon market), and a batch at the price caps may cost at most half of the account's coins.
export const AMMO_BATCH = 300, AMMO_LOW = 50, AMMO_MARKET = 'ge:ammo';
export function ammoStageFor(a: Acct, inp: Inputs, bowLevel: number): KitStage | null {
    const top = Math.min(a.skills.Ranged ?? 1, bowLevel), buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + AMMO_STAGE));
    // Bronze arrows are the Ranged band's own kit (its batch), so a stage never orders them.
    for (const [arrow, tier] of [...ARROWS].reverse().sort((x, y) => y[1] - x[1])) {
        if (tier > top || arrow === 'bronze arrow') continue;
        const held = ARROWS.filter(([, t]) => t >= tier && t <= top).reduce((n, [name]) => n + (a.items[name] ?? 0), 0);
        if (held >= AMMO_LOW) return null;
        const count = AMMO_BATCH - held, quote = inp.market?.[arrow];
        if (hasStock(inp, arrow) || (!buyRetired && quote && count * quote.limit + KIT_CASH_RESERVE + KIT_COIN_MARGIN <= (a.items.coin ?? 0) && count * quote.limit * 2 <= (a.items.coin ?? 0)))
            return { id: AMMO_STAGE, goal: `fire ${arrow}s`, items: [{ item: arrow, count }] };
    }
    return null;
}
// Every bow and arrow stage of an account that trains Ranged, in the order that they buy: the bow first, then the arrows
// that the new bow fires.
function rangedStagesFor(a: Acct, inp: Inputs): KitStage[] {
    const bow = bowStageFor(a, inp), ammo = ammoStageFor(a, inp, Math.max(ownedBowLevel(a), bow?.level ?? 0));
    return [...(bow ? [bow] : []), ...(ammo ? [ammo] : [])];
}
function armourItemsFor(a: Acct, inp: Inputs, styles: KitStyles = { melee: true, ranged: true }): { id: string; band: number; items: string[]; goal: string }[] {
    const out: { id: string; band: number; items: string[]; goal: string }[] = [];
    if (styles.melee && (a.skills.Defence ?? 1) >= 40) {
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + RUNE_ARMOUR_BAND));
        const torso = questDone(a, 'Dragon Slayer') ? 'rune platebody' : 'rune chainbody';
        const heldTorso = (a.items['rune platebody'] ?? 0) > 0 || (!questDone(a, 'Dragon Slayer') && (a.items['rune chainbody'] ?? 0) > 0);
        const need = [
            ...(heldTorso ? [] : [torso]),
            ...((a.items['rune plateleg'] ?? 0) > 0 || (a.items['rune plateskirt'] ?? 0) > 0 ? [] : ['rune plateleg']),
            ...((a.items['rune full helm'] ?? 0) > 0 ? [] : ['rune full helm']),
            ...((a.items['rune kiteshield'] ?? 0) > 0 ? [] : ['rune kiteshield']),
        ].filter(item => hasStock(inp, item) || (!buyRetired && hasMarket(inp, item)));
        if (need.length) out.push({ id: RUNE_ARMOUR_BAND, band: ARMOUR_BAND, items: need, goal: 'wear rune armour' });
    }
    if (styles.ranged && (a.skills.Ranged ?? 1) >= 40) {
        const buyRetired = !!inp.retired?.has(pairKey(a.name, KIT_BUY + DHIDE_ARMOUR_BAND));
        const bodyReady = (a.skills.Defence ?? 1) >= 40 && questDone(a, 'Dragon Slayer');
        const need = [
            ...(bodyReady && !(a.items['dragonhide body'] ?? 0) ? ['dragonhide body'] : []),
            ...((a.items['dragonhide chap'] ?? 0) > 0 ? [] : ['dragonhide chap']),
            ...((a.items['dragon vambrace'] ?? 0) > 0 ? [] : ['dragon vambrace']),
        ].filter(item => hasStock(inp, item) || (!buyRetired && hasMarket(inp, item)));
        if (need.length) out.push({ id: DHIDE_ARMOUR_BAND, band: RANGED_ARMOUR_BAND, items: need, goal: "wear green dragonhide armour" });
    }
    return out;
}
function toolUpgradeNeed(a: Acct, routeDemand: ReadonlySet<string>): string | null {
    const miningDemand = ['iron ore', 'mithril bar', 'adamantite bar', 'steel bar', 'rune essence', 'coal'].some(x => routeDemand.has(x));
    const wcDemand = ['yew log', 'maple log', 'yew shortbow', 'arrow shaft'].some(x => routeDemand.has(x));
    if (miningDemand) {
        const mining = a.skills.Mining ?? 1;
        for (const [lvl, item] of PICKAXE_LADDER) {
            if (mining < lvl) continue;
            if (PICKAXE_LADDER.filter(([l]) => l >= lvl).some(([, p]) => (a.items[p] ?? 0) > 0)) break;
            return item;
        }
    }
    if (wcDemand && (a.skills.Woodcutting ?? 1) >= 60) {
        const wc = a.skills.Woodcutting ?? 1;
        for (const [lvl, item] of AXE_LADDER) {
            if (wc < lvl) continue;
            if (AXE_LADDER.filter(([l]) => l >= lvl).some(([, x]) => (a.items[x] ?? 0) > 0)) break;
            return item;
        }
    }
    return null;
}

type GoalNeed = { names: string[]; short: number; consumer: string; account?: string; bought?: number; budget?: () => number };
// Route shortages and the missing kits of eligible army bands are the consumers. Army purchase budgets retain
// their recipient, so wealth that account cannot spend or receive cannot hide its funding gap.
export type SpecialistStageLine = { names: readonly string[]; count: number };
const specPot = (k: string): readonly string[] => SQUAD_POTION_ALIASES[k]?.map(([n]) => norm(n)) ?? [norm(k)];
const NON_WILDY_ANTIPOISON = specPot('antipoison(3)');
export const SPECIALIST_STAGE_BILLS: Readonly<Record<string, readonly SpecialistStageLine[]>> = {
    hitpoints: [
        { names: ['air rune'], count: 2500 }, { names: ['mind rune'], count: 140 }, { names: ['chaos rune'], count: 220 },
        { names: ['death rune'], count: 220 }, { names: ['law rune'], count: 60 }, { names: ['water rune'], count: 35 },
        { names: ['coin'], count: 5000 }, { names: ['staff of fire'], count: 1 }, { names: ['leather glove'], count: 1 },
        { names: ['cheese'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 }, { names: ['dragon bone'], count: 11 },
        { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 18 }, { names: ['shark'], count: 20 },
        { names: ['gold bar'], count: 1 }, { names: ['ball of wool'], count: 1 }, { names: NON_WILDY_ANTIPOISON, count: 3 },
    ],
    'thieving-live': [
        { names: ['chocolate cake'], count: 27 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    attack: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 50 }, { names: ['air rune'], count: 1300 },
        { names: ['law rune'], count: 30 }, { names: ['chaos rune'], count: 240 }, { names: ['coin'], count: 200 },
        { names: ['dragon bone'], count: 11 }, { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 3 },
        { names: ['lobster'], count: 2 },
    ],
    strength: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    defence: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    'ranged-live': [
        { names: ['dragon bone'], count: 11 }, { names: ['cannon base'], count: 1 }, { names: ['cannon stand'], count: 1 },
        { names: ['cannon barrel'], count: 1 }, { names: ['cannon furnace'], count: 1 }, { names: ['cannonball'], count: 1500 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['shortbow'], count: 1 }, { names: ['iron arrow'], count: 300 },
        { names: ['leather body'], count: 1 }, { names: ['prayer potion(4)'], count: 8 }, { names: ['lobster'], count: 5 },
        { names: ['magic shortbow'], count: 1 }, { names: ['rune arrow'], count: 1000 },
        { names: ['black_dragonhide_chaps', 'black_dragonhide_chap'], count: 1 },
        { names: ['black_dragon_vambraces', 'black_dragon_vambrace'], count: 1 },
        { names: NON_WILDY_ANTIPOISON, count: 8 },
    ],
    'fletching-live': [
        { names: ['bronze arrowtip'], count: 60 }, { names: ['iron arrowtip'], count: 90 }, { names: ['steel arrowtip'], count: 135 },
        { names: ['mithril arrowtip'], count: 225 }, { names: ['adamant arrowtip'], count: 495 }, { names: ['rune arrowtip'], count: 2595 },
        { names: ['headless arrow'], count: 3600 },
    ],
    fishing: [
        { names: ['small fishing net'], count: 1 }, { names: ['fishing rod'], count: 1 }, { names: ['fly fishing rod'], count: 1 },
        { names: ['fishing bait'], count: 60 }, { names: ['feather'], count: 1500 }, { names: ['knife'], count: 1 },
        { names: ['log'], count: 5 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'mining-live': [
        { names: ['clay'], count: 6 }, { names: ['copper ore'], count: 4 }, { names: ['iron ore'], count: 2 },
        { names: ['knife'], count: 1 }, { names: ['rune pickaxe'], count: 1 }, { names: ['log'], count: 2 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    prayer: [{ names: ['dragon bone'], count: 555 }],
    smithing: [
        { names: ['hammer'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 }, { names: ['bronze bar'], count: 9 },
        { names: ['iron bar'], count: 42 }, { names: ['steel bar'], count: 100 }, { names: ['mithril bar'], count: 275 },
        { names: ['adamantite bar'], count: 375 },
    ],
    runecraft: [
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['air talisman'], count: 1 },
        { names: ['body talisman'], count: 1 }, { names: ['rune essence'], count: 5355 },
    ],
    crafting: [
        { names: ['chisel'], count: 1 }, { names: ['uncut opal'], count: 18 }, { names: ['uncut sapphire'], count: 3 },
        { names: ['uncut emerald'], count: 6 }, { names: ['uncut ruby'], count: 3 }, { names: ['uncut diamond'], count: 9 },
        { names: ['uncut dragonstone'], count: 277 },
    ],
    herblore: [
        { names: ['games necklace(8)'], count: 1 }, { names: ['raw beef'], count: 1 }, { names: ['raw rat meat'], count: 1 },
        { names: ['raw bear meat'], count: 1 }, { names: ['raw chicken'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
        { names: ['harralander potion (unf)'], count: 10 }, { names: ['chocolate dust'], count: 10 }, { names: ['irit potion (unf)'], count: 10 },
        { names: ['eye of newt'], count: 10 }, { names: ['kwuarm potion (unf)'], count: 30 }, { names: ['limpwurt root'], count: 10 },
        { names: ['dragon scale dust'], count: 50 }, { names: ['lantadyme potion (unf)'], count: 30 }, { names: ['torstol potion (unf)'], count: 170 },
        { names: ['jangerberrie'], count: 170 },
    ],
    magic: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 25 }, { names: ['cosmic rune'], count: 150 },
        { names: ['water rune'], count: 20 }, { names: ['air rune'], count: 1500 }, { names: ['earth rune'], count: 400 },
        { names: ['sapphire ring'], count: 12 }, { names: ['emerald ring'], count: 27 }, { names: ['shark'], count: 3 },
        { names: ['ruby ring'], count: 72 }, { names: ['diamond ring'], count: 36 }, { names: ['law rune'], count: 12 },
        { names: ['blood rune'], count: 850 }, { names: ['knife'], count: 1 }, { names: ['dragon bone'], count: 8 },
        { names: ['prayer potion(4)'], count: 2 }, { names: ['amulet of magic'], count: 1 }, { names: ['super energy(4)'], count: 1 },
    ],
    'cooking-live': [
        { names: ['raw lobster'], count: 1000 }, { names: ['raw karambwan'], count: 1000 }, { names: ['raw shark'], count: 1000 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    'woodcutting-live': [
        { names: ['bronze axe'], count: 1 }, { names: ['steel axe'], count: 1 }, { names: ['mithril axe'], count: 1 },
        { names: ['adamant axe'], count: 1 }, { names: ['rune axe'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'firemaking-live': [
        { names: ['tinderbox'], count: 1 }, { names: ['log'], count: 100 }, { names: ['oak log'], count: 200 },
        { names: ['willow log'], count: 500 }, { names: ['maple log'], count: 800 }, { names: ['yew log'], count: 800 },
        { names: ['magic log'], count: 500 },
    ],
    'agility-live': [
        { names: ['summer pie'], count: 20 }, { names: ['super energy(4)'], count: 20 }, { names: ['shark'], count: 50 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'haggis-mainland': [
        { names: ['uncut dragonstone'], count: 277 }, { names: ['gold bar'], count: 277 }, { names: ['ball of wool'], count: 277 },
        { names: ['chisel'], count: 1 }, { names: ['ring mould'], count: 1 }, { names: ['necklace mould'], count: 1 },
        { names: ['amulet mould'], count: 1 }, { names: ['amulet of glory(4)'], count: 2 }, { names: ['ring of dueling(8)'], count: 4 },
        { names: ['games necklace(8)'], count: 2 }, { names: ['prayer potion(4)'], count: 25 }, { names: ['super restore(4)'], count: 10 },
        { names: ['super energy(4)'], count: 20 }, { names: NON_WILDY_ANTIPOISON, count: 10 },
    ],
};

export function specialistStagingNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const requested = [...new Set((inp.specialists ?? []).map(s => s.toLowerCase()))].filter(k => k in SPECIALIST_STAGE_BILLS);
    if (!requested.length) return [];
    const squadMembers = new Set((inp.squad?.active ? inp.squad.all ?? inp.squad.members.map(m => m.name) : []).map(n => n.toLowerCase()));
    const byHolder = new Map<string, Record<string, number>>();
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        byHolder.set(lower, a.items);
    }
    for (const s of inp.stock ?? []) {
        const lower = s.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        const prev = byHolder.get(lower) ?? {};
        const merged: Record<string, number> = { ...prev };
        for (const [item, n] of Object.entries(s.items)) merged[item] = Math.max(merged[item] ?? 0, n);
        byHolder.set(lower, merged);
    }
    const freePool = new Map<string, number>();
    for (const items of byHolder.values()) for (const [item, n] of Object.entries(items)) freePool.set(item, (freePool.get(item) ?? 0) + n);
    // Reserve direct route need so specialist staging only consumes uncommitted free stock.
    for (const r of inp.bill) if (r.need > 0) for (const k of [r.item, ...(r.aliases ?? [])].map(norm)) {
        const held = freePool.get(k) ?? 0;
        if (held > 0) { freePool.set(k, Math.max(0, held - r.need)); break; }
    }
    const out: GoalNeed[] = [];
    for (const key of requested) for (const line of SPECIALIST_STAGE_BILLS[key]!) {
        let left = line.count;
        for (const name of line.names) {
            const avail = freePool.get(name) ?? 0;
            const take = Math.min(left, avail);
            if (take > 0) { freePool.set(name, avail - take); left -= take; }
        }
        if (left > 0) out.push({ names: [...line.names], short: left, consumer: `specialist ${key}: ${line.names[0]}` });
    }
    return out;
}

export function goalNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const route: GoalNeed[] = inp.bill.filter(r => r.short > 0).map(r => ({ names: [r.item, ...(r.aliases ?? [])].map(norm), short: r.short, consumer: `Overall route: ${r.item}` }));
    const routeDemand = new Set(route.flatMap(r => r.names));
    const needs = [...route];
    const budget = (consumer: string, cost: () => number, account?: string) => {
        const coins = cost();
        if (coins > 0) needs.push({ names: ['coin'], short: coins, consumer, budget: cost, account });
    };
    const price = (item: string) => inp.market?.[item]?.limit ?? KIT_PRICE_CAPS[item] ?? inp.prices[item] ?? 0;
    const startable = (a: Acct, listed: Template) => {
        if (listed.wilderness && !inp.allowWilderness) return undefined;
        const lower = a.name.toLowerCase(), t = buildBand(listed, a, inp.builds?.get(lower), inp.buildQuests?.get(lower), inp.buildBefore?.get(lower));
        return !t || t.tier !== 'goal' || bandLeft(t, a) <= 0 || (t.pilot && !inp.pilots?.has(t.id)) || inp.retired?.has(pairKey(a.name, t.id)) ? undefined : t;
    };
    // A `once` quest is one account's run: only the first army account (by name, as the kit tier takes them) that can
    // start it asks for its pack, so 21 accounts that meet the Temple of Ikov journal do not ask for 21 packs.
    const onceOwner = new Map<string, string>();
    for (const listed of inp.templates) if (listed.once) {
        const owner = [...mine].sort((x, y) => x.name.localeCompare(y.name)).find(a => inp.army?.has(a.name.toLowerCase()) && !!startable(a, listed) && kitLacks(a, listed.needs, item => !!inp.market?.[item]) !== null);
        if (owner) onceOwner.set(listed.id, owner.name.toLowerCase());
    }
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower)) continue;
        const kit = new Map<string, { count: number; bands: Set<string> }>();
        let cash = 0, keep = 0;
        const bands: { template: Template; lacks?: Lack[] }[] = [];
        for (const listed of inp.templates) {
            const t = startable(a, listed);
            if (!t || (t.once && onceOwner.get(t.id) !== lower)) continue;
            const lacks = kitLacks(a, t.needs, item => !!inp.market?.[item]);
            if (lacks === null) continue;
            bands.push({ template: t, lacks: lacks.length ? lacks : undefined });
            cash = Math.max(cash, ...Object.entries(t.needs?.items ?? {}).filter(([item]) => norm(item) === 'coin').map(([, count]) => count));
            keep = Math.max(keep, t.keepCoins?.(a) ?? 0);
            const batch = t.batchFor?.(a) ?? t.batch;
            for (const lack of lacks) {
                const choices = [...lack.of].sort((x, y) => Number(!!inp.market?.[y]) - Number(!!inp.market?.[x]) || (price(x) || Infinity) - (price(y) || Infinity) || x.localeCompare(y));
                const item = choices[0];
                if (!item) continue;
                const count = Math.max(lack.count, (batch?.[item] ?? 0) - (a.items[item] ?? 0));
                const entry = kit.get(item) ?? { count: 0, bands: new Set<string>() };
                entry.count = Math.max(entry.count, count); entry.bands.add(t.id); kit.set(item, entry);
            }
        }
        bands.sort((x, y) => (x.template.band ?? 0) - (y.template.band ?? 0));
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) kit.set(wStage.item, { count: 1, bands: new Set([wStage.id]) });
        for (const arm of armourItemsFor(a, inp, styles)) for (const item of arm.items) if (!kit.has(item)) kit.set(item, { count: 1, bands: new Set([arm.id]) });
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) for (const { item, count } of stage.items) if (!kit.has(item)) kit.set(item, { count, bands: new Set([stage.id]) });
        const toolItem = toolUpgradeNeed(a, routeDemand);
        if (toolItem && !kit.has(toolItem)) kit.set(toolItem, { count: 1, bands: new Set(['tool-upgrade']) });
        const lines = [...kit].map(([item, entry]) => {
            const need: GoalNeed = { names: [item], short: entry.count, consumer: `army kit ${a.name}: ${[...entry.bands].join(', ')}`, account: lower };
            needs.push(need);
            return { need, price: price(item) };
        });
        budget(`army kit ${a.name}`, () => {
            const cost = lines.reduce((n, l) => n + (l.need.short + (l.need.bought ?? 0)) * l.price, 0);
            return cash + keep + cost + (cost > 0 ? KIT_CASH_RESERVE + KIT_COIN_MARGIN : 0);
        }, lower);
    }
    for (const need of route) if (!need.names.includes('coin')) {
        const cost = Math.max(0, ...need.names.map(item => inp.market?.[item]?.limit ?? inp.prices[item] ?? 0));
        if (cost > 0) budget(need.consumer, () => (need.short + (need.bought ?? 0)) * cost);
    }
    // The gang squad's stock targets, after every kit line: a row has no coin budget, so it never takes coins that a
    // member's own kit buy or a route purchase needs, and it never counts toward their funding.
    for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) needs.push({ names: row.names, short: row.short, consumer: row.consumer, account: row.account });
    for (const row of specialistStagingNeeds(inp, mine)) needs.push(row);
    return needs;
}

// The quest route of each PK build (scripts/pk-kits.ts), by kit name: the quests that the items and varps of the kit
// need. No reward of those quests, or of the quests they need, gives a level over the kit: scripts/pk-kits.ts
// `kitRoute` works the route out from the wear rules and the quest rewards of the content, and scripts/pk-kits.test.ts
// keeps this table equal to it (research/pvp-fight-loop.md, "Quest routes of the builds"). A band of the route runs
// every quest of its chain. The fights of Lost City give their XP to Strength and Hitpoints: the quest script sets
// that style before each fight (quest-lib.ts strengthStyle). A kit with no entry has no route.
const LOST: readonly string[] = ['Lost City'], NONE: readonly string[] = [], TRIALS: readonly string[] = ['The Fremennik Trials'];
export const BUILD_QUESTS: Readonly<Record<string, readonly string[]>> = {
    'pure-bolt': NONE, 'pure-dds': LOST, 'pure-dds-msb': LOST, 'pure-r2h': NONE,
    'pure-hally': ['Regicide'], 'pure-ranger': NONE, 'pure-mage': NONE, 'pure-tribrid': LOST, 'pure-pray': LOST, 'rune-pure': LOST,
    zerker: ['Lost City', 'The Fremennik Trials'], dragon: LOST, 'range-tank': TRIALS, 'mage-tank': NONE, 'pure-scim': NONE, 'pure-dlong': LOST,
    'pure-knives': LOST, 'pure-pray31': LOST, 'pure-god': ['Mage Arena'], 'pure-max': LOST, 'addy-pure': LOST, def50: LOST, 'tank-range': TRIALS,
    'baby-pure': NONE, 'low-ranger': NONE, 'low-mage': NONE, 'low-addy': NONE, skiller: NONE,
    // The least build that fights the dagger gang at its post (combat 111).
    'live-walker-iron-snare-rune-nopot-b111': ['Dragon Slayer', 'Lost City'],
};
// A quest of a route with the quests that it needs and that have a band of their own: a band for one of those is on
// the route too (scripts/pk-kits.ts QUEST_CHAIN has the whole chain of each quest).
export const ROUTE_BEFORE: Readonly<Record<string, readonly string[]>> = { Regicide: ['Underground Pass'] };
const onRoute = (quests: readonly string[], name: string) => quests.some(q => norm(q) === norm(name) || (ROUTE_BEFORE[q] ?? []).some(b => norm(b) === norm(name)));
// A goal band for an account with a PK build, or null when the account must not take it. A build is its levels: one
// level over the Defence or Prayer of a build is a different build, and no account goes back. So such an account
// takes only bands that train one skill, and a band stops at the level of the build:
// - a skill at its level takes no band;
// - a band of scripts/gather-combat.ts whose TRAIN_SKILL is the skill of the band stops at the level (TARGET_LEVEL;
//   giantStyle picks a style that gives XP to that skill and to Hitpoints only). It buries no bones (GIANT_BURY):
//   bones give Prayer XP whatever the band trains;
// - a gather-combat band with another TRAIN_SKILL or a kill count (GIANT_KILLS) is refused: the kill count replaces
//   the level stop, and TRAIN_SKILL=Hitpoints keeps the style the account had, which can train any melee skill;
// - the Prayer band that buries held normal bones (scripts/train-prayer.ts) stops at the level: its target argument;
// - the adaptive Ranged worker stops at its target argument and delegates troopers without burying bones;
// - a band of another script that ends above the level is refused: that script has no proved stop;
// - a quest band is refused unless the quest is on the route of the build (BUILD_QUESTS): a quest reward gives XP in
//   skills nobody chose. A quest of the route is refused too while a skill of the account is over its level before
//   the route (`before`): the reward on top of that level ends over the build. A band that names the skills its
//   chain gives XP in (`gives`) checks only those: Regicide gives no Attack, so the Attack 61 that Underground Pass
//   gave does not refuse it;
// - while a quest of the route is open, a training band stops at the level before the route, not at the level of
//   the build: the quest brings the rest;
// - a stock band is refused: a fight for loot gives XP in skills nobody chose.
// A `buildOnly` band goes to no account without a build.
export function buildBand(t: Template, a: Acct, build?: Readonly<Record<string, number>>, quests: readonly string[] = [], before?: Readonly<Record<string, number>>): Template | null {
    if (!build) return t.buildOnly ? null : t;
    if (t.tier !== 'goal') return t;
    if (t.quest) return onRoute(quests, t.quest.name) && Object.entries(before ?? {}).every(([skill, level]) => skill === 'Hitpoints' || (t.gives && !t.gives.includes(skill)) || (a.skills[skill] ?? 1) <= level) ? t : null;
    if (t.id === 'army-quest-fletch-30') return null;
    if (!t.trains) return null;
    if (t.route && !(onRoute(quests, t.route) && !questDone(a, t.route))) return null;
    const open = quests.some(q => !questDone(a, q)), cap = build[t.trains.skill];
    const level = cap !== undefined && open && before?.[t.trains.skill] !== undefined ? Math.min(cap, before[t.trains.skill]!) : cap;
    const combat = t.script === 'scripts/gather-combat.ts';
    if (combat && (t.env?.TRAIN_SKILL !== t.trains.skill || t.env.GIANT_KILLS !== undefined)) return null;
    if (level === undefined) return combat ? { ...t, env: { ...t.env, GIANT_BURY: '0' } } : t;
    if ((a.skills[t.trains.skill] ?? 1) >= level) return null;
    const to = Math.min(t.trains.to, level);
    if (combat) return { ...t, env: { ...t.env, TARGET_LEVEL: String(to), GIANT_BURY: '0' }, trains: { ...t.trains, to } };
    if (t.script === 'scripts/ranged-train.ts' && t.trains.skill === 'Ranged') return {...t,args:[String(to),...(t.args??[]).slice(1)],env:{...t.env,TARGET_LEVEL:String(to)},trains:{...t.trains,to}};
    // Normal bones give 112.5 Prayer XP each, under the XP of one level from level 6 up, and the worker counts its
    // buries from the XP still needed (planPrayer). A band of bought bones (BONE_ID) is refused: one dragon bone gives
    // 1,800 XP, more than the level after 43.
    if (t.script === 'scripts/train-prayer.ts' && t.env?.BONE_ID === undefined && !t.batchFor) return { ...t, args: [String(to)], trains: { ...t.trains, to } };
    return t.trains.to <= level ? t : null;
}

export function plan(input: Inputs): Assignment[] {
    let inp: Inputs = { ...input, templates: input.templates.filter(t => (!t.wilderness || !!input.allowWilderness) && (!t.once || (!!input.questsDone && !!t.quest && !input.questsDone.has(norm(t.quest.name))))) };
    // An active squad's members never give their kit or supplies to another account's order: they leave the donor stock
    // and the coin donors, and only the squad's own restock (below) reads their stock, above their squad reserve.
    const squadNames = new Set(inp.squad?.active ? (inp.squad.all ?? inp.squad.members.map(m => m.name)).map(n => n.toLowerCase()) : []);
    const memberStock = (inp.stock ?? []).filter(s => squadNames.has(s.name.toLowerCase()));
    // Only the members that are free (`members`: observed, with no live session or stop file) may send each other stock: a held member is in `all`, not here.
    const freeMembers = new Set((inp.squad?.active ? inp.squad.members : []).map(m => m.name.toLowerCase()));
    if (squadNames.size) inp = { ...inp, stock: (inp.stock ?? []).filter(s => !squadNames.has(s.name.toLowerCase())), donors: (inp.donors ?? []).filter(d => !squadNames.has(d.name.toLowerCase())) };
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    // An active squad's members take no band, kit buy or supply job: they are held for the squad's staging, and only its restock
    // (below) gives them anything.
    const demand = goalNeeds(inp, mine.filter(a => !squadNames.has(a.name.toLowerCase()))), fed = new Map<string, number>();
    const values = { ...inp, coinValue: 1, bill: demand.map(d => ({ item: d.names[0]!, aliases: d.names.slice(1), short: d.short, need: d.short, owned: 0, ids: [], holders: [] })) };
    const localByName = new Map(mine.map(a => [a.name.toLowerCase(), a]));
    const earnedCoins = new Map<string, number>();
    const bridges = new Map<string, { recipient: string; target: number }>(), bridged = new Set<string>();
    const fundingDonors = (inp.donors ?? []).filter(d => !inp.unfundable?.has(d.name.toLowerCase()) && !inp.running?.has(d.name.toLowerCase())
        && (inp.owners.get(d.name.toLowerCase())?.side ?? inp.side) === inp.side);
    const fareCache = new Map<string, number | null>();
    const cachedWayCost = (from: Parameters<typeof wayCost>[0], to: Parameters<typeof wayCost>[1], mountain: boolean): number | null => {
        if (!to) return 0;
        if (!from) return wayCost(from, to, mountain);
        const k = `${from.x},${from.z},${from.level ?? 0}>${to.x},${to.z},${to.level ?? 0}:${mountain ? 1 : 0}`;
        if (fareCache.has(k)) return fareCache.get(k)!;
        const c = wayCost(from, to, mountain);
        fareCache.set(k, c);
        return c;
    };
    const canGiveCache = new Map<string, boolean>();
    const canGiveCoins = (name: string, recipient: string) => {
        const lower = recipient.toLowerCase(), fromKey = name.toLowerCase(), cacheKey = `${fromKey}>${lower}`;
        if (canGiveCache.has(cacheKey)) return canGiveCache.get(cacheKey)!;
        const to = localByName.get(lower), from = localByName.get(fromKey);
        let ok = false;
        if (to && fromKey !== lower && !inp.unfundable?.has(lower)) {
            const meet = meetFor(to.pos);
            if (meet !== null) {
                const fare = cachedWayCost(from?.pos, meet === 'ardougne' ? ARMY_BANK : PLACES['shop:zaff'], from ? inp.mountain?.(from) ?? true : true);
                ok = fare !== null && (fare === 0 || (from?.items.coin ?? 0) >= fare);
            }
        }
        canGiveCache.set(cacheKey, ok);
        return ok;
    };
    // Own kit cash stays with its recipient. A free donor contributes only transferable surplus, once across all
    // recipients. One donor must be able to give each credited share: several small, unusable trades are no funding.
    let fundingEpoch = 0;
    let cachedFunding: { epoch: number; value: { army: Map<string, number>; kits: Map<string, number>; route: number } } | undefined;
    const funding = () => {
        if (cachedFunding?.epoch === fundingEpoch) return cachedFunding.value;
        const army = new Map<string, number>();
        let route = 0;
        for (const d of demand) if (d.budget) {
            if (d.account) army.set(d.account, (army.get(d.account) ?? 0) + d.budget());
            else route += d.budget();
        }
        const cash = new Map(mine.map(a => [a.name.toLowerCase(), (a.items.coin ?? 0) + (earnedCoins.get(a.name.toLowerCase()) ?? 0)]));
        const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE - (army.get(d.name.toLowerCase()) ?? 0))]));
        const given = new Map<string, number>(), lacks = new Map<string, number>();
        for (const [name, cost] of [...army].sort(([x], [y]) => x.localeCompare(y))) {
            let short = Math.max(0, cost - (cash.get(name) ?? 0));
            const donor = [...pool].filter(([from, left]) => left > 0 && canGiveCoins(from, name)).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
            if (donor && short > 0) {
                const coins = Math.min(short, donor[1]);
                short -= coins; pool.set(donor[0], donor[1] - coins);
                given.set(donor[0].toLowerCase(), (given.get(donor[0].toLowerCase()) ?? 0) + coins);
            }
            lacks.set(name, short);
        }
        let available = [...cash].reduce((n, [name, coins]) => n + Math.max(0, coins - Math.max(army.get(name) ?? 0, bridges.get(name)?.target ?? 0) - (given.get(name) ?? 0)), 0);
        for (const [name, coins] of pool) if (!cash.has(name.toLowerCase()) && mine.some(a => canGiveCoins(name, a.name))) available += coins;
        const value = { army: lacks, kits: army, route: Math.max(0, route - available) };
        cachedFunding = { epoch: fundingEpoch, value };
        return value;
    };
    // Banked inputs already cover their downstream need. Reserve direct bill stock and army kits before treating
    // an input as spare; producing it again would count the same route requirement twice.
    const inputStock = new Map<string, number>();
    const armyKits = mine.filter(a => inp.army?.has(a.name.toLowerCase())).map(a => [a, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a)] as const);
    for (const item of Object.keys(FEEDS)) {
        const holders = new Map<string, number>();
        for (const a of inp.accounts) holders.set(a.name.toLowerCase(), a.items[item] ?? 0);
        for (const s of inp.stock ?? []) holders.set(s.name.toLowerCase(), Math.max(holders.get(s.name.toLowerCase()) ?? 0, s.items[item] ?? 0));
        const rows = inp.bill.filter(r => [r.item, ...(r.aliases ?? [])].some(name => norm(name) === item));
        const held = Math.max([...holders.values()].reduce((n, count) => n + count, 0), rows.reduce((n, r) => n + r.owned, 0));
        const army = armyKits.reduce((n, [a, kit]) => n + Math.min(a.items[item] ?? 0, kit[item] ?? 0), 0);
        inputStock.set(item, Math.max(0, held - rows.reduce((n, r) => n + r.need, 0) - army));
    }
    let demandCacheEpoch = -1, directCache = new Map<string, number>(), strictDirectCache = new Map<string, number>(), downstreamCache = new Map<string, number>();
    const ensureDemandCaches = () => {
        if (demandCacheEpoch === fundingEpoch) return;
        demandCacheEpoch = fundingEpoch;
        directCache = new Map<string, number>();
        strictDirectCache = new Map<string, number>();
        downstreamCache = new Map<string, number>();
        for (const d of demand) if (!d.budget && d.short > 0) {
            for (const name of d.names) directCache.set(name, (directCache.get(name) ?? 0) + d.short);
            if (d.names.length === 1) strictDirectCache.set(d.names[0]!, (strictDirectCache.get(d.names[0]!) ?? 0) + d.short);
        }
    };
    const direct = (item: string, strict = false) => { ensureDemandCaches(); return (strict ? strictDirectCache : directCache).get(item) ?? 0; };
    const downstream = (item: string) => {
        ensureDemandCaches();
        if (downstreamCache.has(item)) return downstreamCache.get(item)!;
        const val = demand.reduce((n, d) => n + (d.names.includes(item) ? 0 : d.short * Math.max(0, ...d.names.map(name => feedUnits(item, name)))), 0);
        downstreamCache.set(item, val);
        return val;
    };
    const needed = (item: string, account?: string, strict = false) => {
        if (item !== 'coin') return direct(item, strict) + (strict ? 0 : Math.max(0, downstream(item) - (inputStock.get(item) ?? 0) - (fed.get(item) ?? 0)));
        const cash = funding();
        const lower = account?.toLowerCase(), bridge = lower ? bridges.get(lower) : undefined;
        const own = lower ? bridged.has(lower) ? 0 : cash.army.get(lower) ?? 0 : [...cash.army.values()].reduce((n, coins) => n + coins, 0);
        const gift = bridge ? Math.max(0, bridge.target - (localByName.get(lower!)?.items.coin ?? 0) - (earnedCoins.get(lower!) ?? 0)) : 0;
        return direct(item) + cash.route + own + gift;
    };
    const finiteOrder = (t: Template, a: Acct): Template | null => {
        const p=t.production;if(!p)return t.script==='scripts/train-prayer.ts'&&t.env?.BURY_HELD==='1'
            ?{...t,repeats:false,env:{...t.env,AUTOPILOT_ORDER:String(inp.kitSeq?.get(a.name.toLowerCase())??0)}}:t;
        const demand=Math.ceil(needed(norm(p.output),a.name,!!p.strictOutput)/p.outputPerUnit);
        if(demand<1)return null;
        const available=Math.min(...Object.entries(p.inputs).map(([item,n])=>Math.max(0,Math.floor(((a.items[norm(item)]??0)-(p.reserves?.[item]??0))/n))));
        const units=Math.min(p.maximum,demand,available>0?available:Infinity),items={...t.needs?.items};
        for(const [item,n]of Object.entries(p.inputs))items[item]=n*units+(p.reserves?.[item]??0);
        const resized=p.resize(units,a.items[norm(p.output)]??0);
        const baseline=JSON.stringify([a.items[norm(p.output)]??0,...Object.keys(p.inputs).sort().map(item=>[norm(item),a.items[norm(item)]??0])]);
        return{...t,...resized,env:{...t.env,...resized.env,AUTOPILOT_ORDER:baseline},repeats:false,
            needs:{...t.needs,items},production:{...p,maximum:units}};
    };
    const consume = (item: string, count: number, account?: string, bought = false) => {
        for (const d of demand) if (count > 0 && !d.budget && d.names.includes(item) && (account === undefined || d.account === account.toLowerCase())) {
            const used = Math.min(d.short, count); d.short -= used; count -= used;
            if (bought) d.bought = (d.bought ?? 0) + used;
            if (used > 0) fundingEpoch++;
        }
        return count;
    };
    const reserveKit = (account: string, lines: readonly { item: string; quantity: number }[], bought = true) => {
        for (const l of lines) consume(norm(l.item), l.quantity, account, bought);
    };
    const reserveOutput = (t: Template, a: Acct) => {
        const strict = !!t.production?.strictOutput;
        for (const f of t.yields(a)) {
            const item = norm(f.item), count = Math.min(t.production&&item===norm(t.production.output)?t.production.maximum*t.production.outputPerUnit:Math.max(0, f.perTick) * VALUE_TICKS, needed(item, a.name, strict));
            const rest = consume(item, count);
            if (item === 'coin') { earnedCoins.set(a.name.toLowerCase(), (earnedCoins.get(a.name.toLowerCase()) ?? 0) + rest); if (rest > 0) fundingEpoch++; }
            else if (rest > 0) fed.set(item, (fed.get(item) ?? 0) + rest);
        }
    };
    const valueOf = (t: Template, a: Acct) => jobValue(t, a, values, item => needed(item, a.name, !!t.production?.strictOutput)) * (onList(t) ? 1 : PILOT_FALLBACK_SHARE);
    // `fare`: the ferry fare inside the coin need of the candidate's template.
    type Cand = { account: string; template: Template; value: number; resources: string[]; reason: string; coins?: number; fare?: number; goal?: { band: number; left: number }; lacks?: Lack[];
        supply?: { template: Template; account: Acct; share: number }; kit?: readonly KitLine[] };
    const cands: Cand[] = [];
    // Keep qualified coin opportunities until the kit tier has used existing funds. A helper gets value only if
    // the finite transfer below chooses it; a coin opportunity alone never gives an account work.
    const makesCoins = (t: Template, a: Acct) => t.yields(a).some(f => norm(f.item) === 'coin' && f.perTick > 0);
    const onList = (t: Template) => !t.pilot || !!inp.pilots?.has(t.id);
    const admitted = (t: Template, a?: Acct) => onList(t) || (!!inp.pilotFallback && selfServePilot(t) && !(a && (inp.army?.has(a.name.toLowerCase()) || squadNames.has(a.name.toLowerCase()))));
    const shopLine = (l: Lack) => !l.of.some(i => inp.market?.[i]) && l.of.some(i => SHOP_SUPPLIED.has(i));
    // A donor can fund the account: it has no enabled job, and a meeting place that it can reach (meetFor).
    const meetOf = new Map(mine.map(a => [a.name, meetFor(a.pos)]));
    const fundable = (a: Acct) => (!!inp.donors?.length || !!inp.stock?.some(s=>s.side!==inp.side&&(s.items.coin??0)>FUND_RESERVE))
        && !inp.unfundable?.has(a.name.toLowerCase()) && meetOf.get(a.name) !== null;
    // The jobs an account could start but for coins of a ferry fare: the constraint of a slot that ends vacant.
    const fareShort = new Map<string, { id: string; coins: number; fare: number; resources: string[] }[]>();
    const lacksFare = (a: Acct, t: Template, fare: number) => { fareShort.set(a.name, [...(fareShort.get(a.name) ?? []), { id: t.id, coins: coinShort(a, t.needs), fare, resources: t.resources ?? [] }]); };
    // Why a slot ends vacant (AGENTS.md: a vacant slot names its constraint). A template that stops at a gate before it
    // is a candidate leaves the gate here. Only an account that ends with no job reads its list (vacancy, below).
    type Miss = { template: Template; gate: 'retired' | 'pilot' | 'demand' | 'reach' | 'roster' | 'needs' | 'coins' };
    const misses = new Map<string, Miss[]>();
    const miss = (a: Acct, template: Template, gate: Miss['gate']) => { const list = misses.get(a.name); if (list) list.push({ template, gate }); else misses.set(a.name, [{ template, gate }]); };
    for (const a of mine) for (const listed of inp.templates) {
        if (listed.squadOnly && !inp.squad?.active && !(inp.specialists?.length ?? 0)) continue;
        if (squadNames.has(a.name.toLowerCase())) continue;
        const band = buildBand(listed, a, inp.builds?.get(a.name.toLowerCase()), inp.buildQuests?.get(a.name.toLowerCase()), inp.buildBefore?.get(a.name.toLowerCase()));
        if (!band) continue;
        if (inp.retired?.has(pairKey(a.name, band.id))) { miss(a, band, 'retired'); continue; }
        if (!admitted(band, a)) { miss(a, band, 'pilot'); continue; }
        // The reach rule (wayCost): no candidate for a place with no way from where the account stands. The ferry fare
        // of the way is a coin need of the job, so an account without the fare is funded as for any coin need.
        const finite=finiteOrder(band,a);if(!finite){miss(a,band,'demand');continue;}
        const selected=inp.templateFor?.(finite,a)??finite;
        const place = placeOf(selected);
        // Surface combat and goldfarm workers only walk/route from ground level (level 0); upstairs accounts wait until recovered.
        if ((selected.script === 'scripts/gather-combat.ts' || selected.script === 'scripts/goldfarm.ts') && (place?.level ?? 0) === 0 && a.pos && a.pos.level !== 0) {
            miss(a, selected, 'reach');
            continue;
        }
        const fare = cachedWayCost(a.pos, place, inp.mountain?.(a) ?? true);
        if (fare === null) { miss(a, selected, 'reach'); continue; }
        const t = fare ? withFare(selected, fare) : selected;
        if (t.quest && t.tier !== 'goal') {
            const lacks=kitLacks(a,t.needs,i=>!!inp.market?.[i]);
            if (questDone(a, t.quest.name)) continue;
            if (lacks===null || coinShort(a,t.needs)>0) { miss(a, t, lacks === null ? 'needs' : 'coins'); continue; }
            const after: Acct = { ...a, quests: new Set([...(a.quests ?? []), norm(t.quest.name)]) }, before = cands.length;
            for (const u of t.quest.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(after, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, after);
                if (value > 0 || makesCoins(u, after)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `completes ${t.quest.name} for ${u.id}`, supply: { template: u, account: after, share: TRAIN_SHARE },...(lacks.length?{lacks}:{}) });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.tier === 'goal') {
            // One candidate per goal band whose target an army account has not met; never for anyone else. A band's
            // target is a skill level, or a quest: that one stands until the account's status lists the quest complete,
            // and an account whose status names no quests gets none.
            const left = bandLeft(t, a);
            if (left <= 0) continue;
            if (!inp.army?.has(a.name.toLowerCase())) { miss(a, t, kitLacks(a, t.needs) === null ? 'needs' : 'roster'); continue; }
            const goal = { band: t.band ?? 0, left }, reason = t.trains ? `army band ${goal.band}: ${t.trains.skill} to ${t.trains.to}` : t.quest ? `army band ${goal.band}: ${t.quest.name}` : `army band ${goal.band}: ${t.stock!.to} ${t.stock!.item}`;
            // Keep only a confirmed live instance of this exact band. A parked enabled job still needs its full kit
            // before a new start. kitLacks preserves the band's level, quest and under-target admission rules.
            if (inp.running?.has(a.name.toLowerCase()) && inp.current?.get(a.name.toLowerCase()) === t.id && kitLacks(a, t.needs) !== null) {
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
                continue;
            }
            if (fare && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) lacksFare(a, t, fare);
            // Notes remain owned stock for acquisition, but the held-normal Prayer worker can bury only id526.
            // This gates a new execution; the active instance above and missing-kit acquisition below keep their rules.
            const usableNormalBones = t.script !== 'scripts/train-prayer.ts' || t.env?.BURY_HELD !== '1' || t.env?.BONE_ID !== undefined
                || (a.items['bone (unnoted)'] ?? 0) >= (t.needs?.items?.bones ?? 0);
            if (meets(a, t.needs) && usableNormalBones) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
            else if (usableNormalBones && fundable(a) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)))
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, coins: coinShort(a, t.needs), fare });
            else {
                // Acquisition chooses the source, purchase batch and price after donor arbitration.
                const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]);
                if (lacks?.length) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, lacks, coins:coinShort(a,t.needs) });
                else miss(a, t, 'needs');
            }
            continue;
        }
        if (t.provides) {
            // A shop step for a maker. The item is the one input the maker lacks: every other need is met.
            const item = norm(t.provides.item), held: Acct = { ...a, items: { ...a.items, [item]: Math.max(1, a.items[item] ?? 0) } }, before = cands.length;
            if ((a.items[item] ?? 0) >= 1) continue;
            if (coinShort(a, t.needs) > 0 || !meets(a, withoutCoins(t.needs))) { miss(a, t, coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)) ? 'coins' : 'needs'); continue; }
            for (const u of t.provides.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(held, u.needs)) continue;
                const value = TRAIN_SHARE * valueOf(u, held);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `buys a ${t.provides.item} for ${u.id}`, supply: { template: u, account: held, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
            continue;
        }
        if (t.trains) {
            if ((a.skills[t.trains.skill] ?? 1) >= t.trains.to) continue;
            if (!meets(a, t.needs)) { miss(a, t, 'needs'); continue; }
            const trained: Acct = { ...a, skills: { ...a.skills, [t.trains.skill]: t.trains.to } }, before = cands.length;
            for (const u of t.trains.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u, a) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                // The frail rule counts what the account holds when the unlocked job starts, which is not known yet.
                if (!meets(a, { ...u.needs, frail: undefined }, t.trains)) continue;
                const value = TRAIN_SHARE * valueOf(u, trained);
                if (value > 0 || makesCoins(u, trained)) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `trains ${t.trains.skill} ${t.trains.to} for ${u.id}`, supply: { template: u, account: trained, share: TRAIN_SHARE } });
            }
            if (cands.length === before) miss(a, t, 'demand');
        } else if (meets(a, t.needs)) {
            const value = valueOf(t, a);
            if (value > 0 || makesCoins(t, a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), supply: { template: t, account: a, share: 1 } });
            else miss(a, t, 'demand');
        } else if (coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) {
            const value = valueOf(t, a);
            if (value > 0 && fare) lacksFare(a, t, fare);
            if ((value > 0 || makesCoins(t, a)) && fundable(a)) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), coins: coinShort(a, t.needs), fare, supply: { template: t, account: a, share: 1 } });
            else miss(a, t, value > 0 || makesCoins(t, a) ? 'coins' : 'demand');
        } else if (t.needs?.frail && frailShort(a, t.needs) > 0 && meets(a, { ...t.needs, frail: undefined })) {
            // Spare owned food precedes the existing full food purchase. Both
            // routes require finite coin demand and a free knight spot.
            const value = TRAIN_SHARE * valueOf(t, a), lacks = kitLacks(a, t.needs);
            if (lacks?.length && (value > 0 || makesCoins(t, a))) cands.push({ account: a.name,
                template: { ...t, id: FRAIL_FOOD_BUY_ID, batchFor: account => Object.fromEntries(t.needs!.frail!.of.map(item => [norm(item), (account.items[norm(item)] ?? 0) + FRAIL_FOOD_BUY])) },
                value, resources: t.resources ?? [], reason: `prepares food for ${t.family}`, lacks, supply: { template: t, account: a, share: TRAIN_SHARE } });
            else miss(a, t, 'demand');
        } else {
            const lacks=kitLacks(a,t.needs,i=>!!inp.market?.[i]),value=valueOf(t,a);
            if(lacks?.length&&value>0)cands.push({account:a.name,template:t,value,resources:t.resources??[],reason:`prepares ${t.goal}`,lacks,coins:coinShort(a,t.needs),
                supply:{template:t,account:a,share:1}});
            else miss(a, t, lacks === null ? 'needs' : 'demand');
        }
    }
    // Progressive weapon & armour kit buys precede combat bands. Owned stock can supply them without a market quote.
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (!inp.army?.has(lower) || squadNames.has(lower)) continue;
        const bands = cands.filter(c => c.account === a.name && c.goal).sort((x, y) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left);
        const style = kitStyle(a, inp, bands), styles = kitStylesOf(style);
        const wStage = styles.melee ? weaponStageFor(a, inp) : null;
        if (wStage) {
            const template: Template = { id: wStage.id, item: wStage.item, attack: 30, goal: wStage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: { [wStage.item]: 1 } } } as Template & { item: string; attack: number };
            cands.push({ account: a.name, template, value: 0, resources: [WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages 1 ${wStage.item}`, goal: { band: WEAPON_BAND, left: 0 }, lacks: [{ of: [wStage.item], count: 1 }] });
        }
        if (style === 'ranged') for (const stage of rangedStagesFor(a, inp)) {
            const template: Template = { id: stage.id, goal: stage.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true,
                needs: { items: Object.fromEntries(stage.items.map(i => [i.item, i.count])) } };
            cands.push({ account: a.name, template, value: 0, resources: [stage.id === AMMO_STAGE ? AMMO_MARKET : WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: stages ${stage.items.map(i => `${i.count} ${i.item}`).join(', ')}`,
                goal: { band: WEAPON_BAND + (stage.id === AMMO_STAGE ? 0.01 : 0), left: 0 }, lacks: stage.items.map(i => ({ of: [i.item], count: i.count })) });
        }
        for (const arm of armourItemsFor(a, inp, styles)) {
            const needsItems = Object.fromEntries(arm.items.map(i => [i, 1]));
            const template: Template = { id: arm.id, goal: arm.goal, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [], kitFirst: true, needs: { items: needsItems } };
            cands.push({ account: a.name, template, value: 0, resources: [ARMOUR_MARKET], reason: `army band ${arm.band}: stages ${arm.items.join(', ')}`, goal: { band: arm.band, left: 0 }, lacks: arm.items.map(i => ({ of: [i], count: 1 })) });
        }
    }
    // On a value tie an account keeps the template it holds: a level change must not move it to another spot of the
    // same worth, which would replace a running job with a fresh one that changes nothing useful.
    const keeps = (c: Cand) => inp.current?.get(c.account.toLowerCase()) === c.template.id ? 1 : 0;
    const used = new Map(Object.entries(inp.taken ?? {})), done = new Map<string, Assignment>();
    // A candidate's worth with the holders taken so far: each holder of a resource scales it by that resource's shared
    // rate, so a third farmer on a spot is worth less than a second and new farmers spread over the spots. The place an
    // account already holds keeps its full worth: crowding counts only against a move, so a farmer stays put until its
    // spot is full (capacity is a hard limit below), and sides do not chase each other's lagging claims.
    const worth = (c: Cand) => c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : (used.get(r) ?? 0)),
        c.supply ? c.supply.share * valueOf(c.supply.template, c.supply.account) : c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // Donor coins above the reserve, spent as funded candidates take them; a funded account gives nothing.
    // A donor that gives stays free this pass, so the fleet agent can log it in for the trade.
    const pool = new Map(fundingDonors.map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)])), gave = new Set<string>();
    // Accounts that give an item this pass, and accounts that leave a coin job so a kit order can reach them.
    const gaveItems = new Set<string>(), vacated = new Map<string, string>();
    const take = (c: Cand, value: number, far=false) => {
        if (c.lacks || (!c.goal && value <= 0) || done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        if(far&&(ready.has(c.account)||inp.unfundable?.has(c.account.toLowerCase())||inp.running?.has(c.account.toLowerCase())))return;
        const selected=finiteOrder(c.template,localByName.get(c.account.toLowerCase())!);if(!selected)return;
        let fund: Funding | undefined;
        if (c.coins) {
            const from = cashSource(c.account,c.coins,far);
            if (!from) return;
            if(pool.has(from))pool.set(from, pool.get(from)! - c.coins); gave.add(from);
            fund = { from, to: c.account, coins: c.coins, template: c.template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) };
        }
        pool.delete(c.account);
        for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
        const bridge = bridges.get(c.account.toLowerCase()), reason = bridge ? `${c.reason} for ${bridge.recipient}'s army kit, up to ${bridge.target} coins including donor reserve` : c.reason;
        done.set(c.account, { account: c.account, template: selected, value, reason: fund ? `${reason}, funded ${c.coins} coins by ${fund.from}${c.fare ? `, ferry fare ${c.fare}` : ''}` : reason, resources: c.resources, ...(fund ? { fund } : {}) });
        if (c.supply) reserveOutput(c.supply.template.id===selected.id?selected:c.supply.template, c.supply.account);
        if (c.kit) reserveKit(c.account, c.kit);
    };
    // The goal tier first: each army account takes the earliest band it can (a full band's resource sends it to the
    // next), the account nearest its target first; it never competes with coin jobs on coins per tick.
    const goalOrder = (x: Cand, y: Cand) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // A quest the account holds comes before every band: a stop in the middle of a quest leaves the account wherever
    // the quest stood (live: an account on Lost City, band 3.6, was moved to the rune buy of band 2).
    // Then the kit tier: an army account with no band it can start gets the kit of its earliest band, before any coin
    // job. This side's available spare stock supplies the kit before a repurchase. Its item orders start without
    // the cross-side sync lead. A remote transfer retains that lead, so an affordable local purchase precedes it.
    // A running band, an open purchase or a productive remote recipient keeps its assignment.
    const reserve = kitReserve(inp.templates), byName = new Map(mine.map(a => [a.name, a]));
    const stock = [...(inp.stock ?? [])].sort((x, y) => Number(y.side === inp.side) - Number(x.side === inp.side));
    // What a donor keeps of an item: the most a band needs to start. An army account of this side keeps that only for
    // the bands it has still to do, so a maxed account gives all it holds (live: two maxed accounts held 41 dragon
    // bones, 1,900 nature runes and 29,000 feathers while others waited for a donor of another side). The levels of
    // another side's account are not read here: it keeps the reserve of every band.
    const ownReserve = new Map<string, Record<string, number>>();
    const squadKeep = inp.squad?.active ? squadKeeps(inp.squad.hours) : undefined, squadMember = new Set((inp.squad?.all ?? inp.squad?.members.map(m => m.name) ?? []).map(n => n.toLowerCase()));
    const keepsOf = (s: Stock) => {
        if (squadKeep && squadMember.has(s.name.toLowerCase())) return { ...reserve, ...Object.fromEntries(Object.entries(squadKeep).map(([i, n]) => [i, Math.max(n, reserve[i] ?? 0)])) };
        const a = s.side === inp.side ? byName.get(s.name) : undefined;
        if (!a || !inp.army?.has(a.name.toLowerCase())) return reserve;
        if (!ownReserve.has(a.name)) ownReserve.set(a.name, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a));
        return ownReserve.get(a.name)!;
    };
    const spare = (s: Stock, item: string) => Math.max(0, (s.items[item] ?? 0) - (keepsOf(s)[item] ?? 0));
    // Remote stock has already passed the publishing side's freshness, ownership and free-account checks. Its
    // cash keeps the same reserve as local donors and is used only by the idle-recipient fallback below.
    const cashSource=(recipient:string,coins:number,far:boolean):string|undefined=>{
        const own=[...pool].filter(([name,left])=>left>=coins&&!done.has(name)&&!gaveItems.has(name)&&canGiveCoins(name,recipient)).sort((x,y)=>y[1]-x[1])[0]?.[0];
        if(own||!far)return own;
        return stock.filter(s=>s.side!==inp.side&&!gave.has(s.name)&&!gaveItems.has(s.name)&&!done.has(s.name)
            &&!inp.unfundable?.has(s.name.toLowerCase())&&!inp.running?.has(s.name.toLowerCase())
            &&!inp.noSend?.has(`${s.name}>${recipient}`.toLowerCase())&&(s.items.coin??0)-FUND_RESERVE>=coins&&canGiveCoins(s.name,recipient))
            .sort((x,y)=>(y.items.coin??0)-(x.items.coin??0)||x.name.localeCompare(y.name))[0]?.name;
    };
    const banded = (id: string) => byId.get(id)?.tier === 'goal' && !byId.get(id)?.filler;
    const goalNow = (account: string) => { const id = inp.current?.get(account.toLowerCase()); return !!id && (id.startsWith(KIT_BUY) || banded(id)); };
    const acquire = (c: Cand, step: 'buy' | 'send', far: boolean) => {
        const a = byName.get(c.account)!, busy = !!inp.unfundable?.has(c.account.toLowerCase()), buyId = KIT_BUY + c.template.id;
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account)) return;
        if(!c.goal&&(worth(c)<=0||inp.running?.has(c.account.toLowerCase())))return;
        // Another side's stock and coins are asked only for an account with no job it can start and none running: such
        // a trade needs the account offline until the other side's agent runs it, up to the order's window (live: 13
        // of 14 accounts stood parked at once, most for 1 to 13 items of another side, one with 123,028 coins for 3
        // air runes that a shop sells).
        if (far && (busy || ready.has(c.account))) return;
        // An account in a running band job keeps the rule it had before the kit tier: its live holdings dip while it
        // works (food eaten, runes cast), and a kit buy must not replace a band that is still running. A weapon or
        // armour buy is the exception: the band does not use the item up, the account lacks it for as long as the
        // band runs (live: Attack 99, Strength 99, Defence 94 and 1,090,000 coins with a bronze sword, held on the
        // Defence band), and one buy run pays back on every later tick. The buy below starts only from the account's
        // own coins: a busy account takes no funding and no item order.
        const now = inp.current?.get(c.account.toLowerCase());
        const wornKit = c.resources.includes(WEAPON_MARKET) || c.resources.includes(ARMOUR_MARKET);
        if (busy && now && !now.startsWith(KIT_BUY) && banded(now) && !wornKit) return;
        // No kit for a band whose place is full: the account tries its next band.
        if (c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        const reachesMeet = (name: string) => { const p = byName.get(name), cost = cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true); return cost !== null && (cost === 0 || (p!.items.coin ?? 0) >= cost); };
        const donorFor = (item: string, count: number, remote=far) => stock.find(s => (s.side !== inp.side) === remote && s.name.toLowerCase() !== c.account.toLowerCase() && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= count
            && !inp.noSend?.has(`${s.name}>${c.account}`.toLowerCase()) && reachesMeet(s.name));
        // Fund the worker's own cash prerequisite first, then reobserve before acquiring its missing items.
        // fundOrders parks the intended worker until this one owned transfer settles.
        if(c.coins){
            if(busy)return;
            const mountain=inp.mountain?.(a)??true,toMeet=cachedWayCost(a.pos,ARMY_BANK,mountain),fromMeet=cachedWayCost(ARMY_BANK,placeOf(c.template),mountain);
            // The cash transfer precedes the item trip. Its recipient can use that staged cash for the meeting
            // fare, and must still retain the consumer's cash and return fare after the item arrives.
            const canMeet=toMeet!==null&&fromMeet!==null;
            const itemSource=(item:string,count:number)=>donorFor(item,count,false)??(far?donorFor(item,count,true):undefined);
            const obtainable=(item:string,count:number)=>!!c.template.ownSupply?.includes(item)||!c.template.shopKit&&!!inp.market?.[item]||canMeet&&!!itemSource(item,count);
            const lacks=kitLacks(a,c.template.needs,obtainable);
            if(!lacks||lacks.some(l=>!l.of.some(item=>obtainable(item,l.count))))return;
            const owned=canMeet&&lacks.some(l=>l.of.some(item=>!!itemSource(item,l.count)));
            const detour=a.pos&&owned?Math.max(0,toMeet!+fromMeet!-(cachedWayCost(a.pos,placeOf(c.template),mountain)??0)):0;
            const coins=c.coins+detour;
            const from=cashSource(c.account,coins,far);
            if(!from)return;
            if(pool.has(from))pool.set(from,pool.get(from)!-coins);gave.add(from);pool.delete(c.account);
            done.set(c.account,{account:c.account,template:c.template,value:0,reason:`funds ${coins} coins before preparing ${c.template.id}`,resources:[],
                fund:{from,to:c.account,coins,template:c.template.id,...(meetOf.get(c.account)?{meet:'ardougne' as const}:{})}});
            return;
        }
        if (step === 'buy' && (c.template.shopKit || cachedWayCost(a.pos, PLACES['shop:zaff'], inp.mountain?.(a) ?? true) === null)) return;
        const own = (l: Lack) => l.of.some(i => !!c.template.ownSupply?.includes(i));
        const picks = c.lacks!.filter(l => !shopLine(l) && !own(l)).map(l => { const item = l.of.filter(i => inp.market?.[i] && usableTool(a, i)).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]; return item ? { item, count: l.count } : null; });
        if (step === 'buy' && picks.length && picks.every(p => p !== null) && !inp.retired?.has(pairKey(c.account, buyId))) {
            // The batch when the account can pay for it, else only what the band needs to start. A one-line band with
            // `partBatch` takes as much of its batch as the account can pay for.
            const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
            // `held` is what the buy script will count (EXPECTED_OWNED, the order key): the unnoted units. The batch top-up counts every unit, notes included.
            const sized = (batch: boolean): KitLine[] => picks.map(p => { const owned = a.items[p!.item] ?? 0, held = a.exact ? a.exact[p!.item] ?? 0 : owned, m = inp.market![p!.item]!; return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(p!.count, batch ? (batchOf?.[p!.item] ?? 0) - owned : 0) }; });
            const price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0), coins = a.items.coin ?? 0;
            const keep = Math.max(c.template.keepCoins?.(a) ?? 0,...Object.entries(c.template.needs?.items??{}).filter(([item])=>norm(item)==='coin').map(([,count])=>count));
            const free = coins - keep;
            // The buy script refuses a round whose escrow and reserve pass the coins it finds, and the status that sized the buy is older than
            // the run: KIT_COIN_MARGIN keeps the planned buy under the coins by what a few minutes of fares, food and fees can take.
            const room = KIT_CASH_RESERVE + KIT_COIN_MARGIN;
            const full = sized(true), start = sized(false), part = Math.floor((free - room) / (full[0]?.limit ?? 1));
            const frailFood = c.template.id === FRAIL_FOOD_BUY_ID;
            const lines = frailFood || price(full) + room <= free ? full
                : c.template.partBatch && full.length === 1 && part > start[0]!.quantity ? [{ ...full[0]!, quantity: Math.min(full[0]!.quantity, part) }]
                : c.template.partBatch && full.length > 1 ? proportionalLines(full, start, free - room) : start;
            const template = kitBuyTemplate(c.template, c.account, lines, inp.kitSeq?.get(c.account.toLowerCase()) ?? 0, KIT_CASH_RESERVE + keep), cost = price(lines), short = cost + room - free;
            const what = lines.map(l => `${l.quantity} ${l.item}`).join(', ');
            // A `once` quest buys its kit for one account at a time, and for QUEST_DEMAND_PLACES quests at a time: the buy holds
            // the places of the quest, and the run that follows holds them too.
            const purchaseResources=c.template.id===WEAPON.id||c.template.id.startsWith('army-weapon-')||c.template.id.startsWith('army-armour-')||c.template.once||frailFood?c.resources:[];
            const reservePurchase=()=>{for(const r of purchaseResources)used.set(r,(used.get(r)??0)+1);reserveKit(c.account,lines);if(c.supply)reserveOutput(c.supply.template,c.supply.account);};
            const buyReason=`${c.goal&&c.template.kitFirst?`army band ${c.goal.band}: `:''}buys ${what} for ${c.template.id}, at most ${cost} coins`;
            if (short <= 0) { done.set(c.account, { account: c.account, template, value: 0, reason:buyReason, resources:purchaseResources });reservePurchase();return; }
            if (frailFood) return;
            if (!busy && meetOf.get(c.account) !== null) {
                // A coin donor of this side, else a free account of another side with coins above the reserve.
                const from = cashSource(c.account,short,far);
                if (from) {
                    if(pool.has(from))pool.set(from,pool.get(from)!-short);
                    gave.add(from); pool.delete(c.account);
                    done.set(c.account, { account: c.account, template, value: 0, reason: `${c.reason}, funded ${short} coins by ${from} to buy ${what}`, resources:purchaseResources, fund: { from, to: c.account, coins: short, template: template.id, ...(meetOf.get(c.account) ? { meet: 'ardougne' as const } : {}) } });
                    reservePurchase();
                    return;
                }
            }
        }
        if (step === 'buy') return;
        // An item order meets at the Ardougne north bank (scripts/autopilot.ts itemOrder). A party of this side whose
        // place is known must have a way there and hold the fare of that way. A party with no known place has no rule.
        if (!reachesMeet(c.account)) return;
        // A market alternative can be unaffordable while a donor holds another complete kit. Reconsider the choice
        // against this pass's reachable, unreserved stock, including donors already taken by another account.
        const lacks = kitLacks(a, c.template.needs, (item, count) => !!donorFor(item, count)) ?? [];
        // One order per pass. A line no market sells goes first, so the lines left at the end are one buy.
        const sold = (l: Lack) => Number(l.of.some(i => !!inp.market?.[i]));
        for (const l of lacks.sort((x, y) => sold(x) - sold(y))) for (const item of l.of) {
            const from = donorFor(item, l.count);
            if (!from) continue;
            // A donor of this side sends the band's batch, as a buy would bring it, as far as its spare stock goes: one
            // trade, not one for every start amount. Another side's donor sends what the band needs to start.
            const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
            const count = far ? l.count : Math.min(spare(from, item), Math.max(l.count, (batchOf?.[item] ?? 0) - (a.items[item] ?? 0)));
            // A trade needs the account offline with no stop file (scripts/fleet-agent.ts). One in a coin job leaves that
            // job on this pass and gets the order on the next; one already on a band or a kit buy keeps it.
            // The donor is held for this account, so a second account does not leave its job for the same stock.
            if (busy) { if (!goalNow(c.account)) { vacated.set(c.account, `vacant: leaves its job for ${count} ${item} from ${from.name} for ${c.template.id}`); gaveItems.add(from.name); pool.delete(from.name); } return; }
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(c.account);
            const resources = c.template.id === FRAIL_FOOD_BUY_ID ? c.resources : [];
            for (const resource of resources) used.set(resource, (used.get(resource) ?? 0) + 1);
            done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `${c.reason}, sent ${count} ${item} by ${from.name}`, resources, send: { from: from.name, to: c.account, item, count, template: c.template.id } });
            reserveKit(c.account, [{ item, quantity: count }], false);
            if(c.supply)reserveOutput(c.supply.template,c.supply.account);
            return;
        }
    };
    // This side's own coins and stock before another side's: a trade across sides waits on the other side's agent,
    // and the account stands vacant meanwhile (live: five accounts parked for donors of another side, one for 22
    // bones, while this side's maxed accounts held what they needed).
    const kits = [...cands.filter(c => c.goal && c.lacks).sort(goalOrder),...cands.filter(c=>!c.goal&&c.lacks).sort(order)];
    // The accounts with a job of any tier that they can start now with what they hold.
    const ready = new Set(cands.filter(c => !c.lacks && !c.coins && (c.goal || worth(c) > 0)).map(c => c.account));
    // An active gang squad's supply jobs take their places first: a goal band that takes the same shop (army-hunt-supply holds
    // shop:lowe) would leave the squad's line with no place. A place that a running job of its current template holds stays
    // with that job, and an account that runs a job keeps it. An account with a goal band (ready, or short of its kit) keeps the
    // band's way: the squad's supply goes first to the accounts with no band.
    if (inp.squad?.active || (inp.specialists?.length ?? 0) > 0) {
        const runningHolds = new Set(cands.filter(k => inp.running?.has(k.account.toLowerCase()) && inp.current?.get(k.account.toLowerCase()) === k.template.id).flatMap(k => k.resources));
        const banded = new Set(cands.filter(k => k.goal).map(k => k.account));
        for (const c of cands.filter(c => c.template.squadOnly && !banded.has(c.account) && !inp.running?.has(c.account.toLowerCase()) && !c.resources.some(r => runningHolds.has(r))).sort((p, q) => worth(q) - worth(p)))
            take(c, worth(c));
    }
    for(const c of cands.filter(c=>c.goal&&!c.lacks&&!!c.template.quest&&keeps(c)).sort(goalOrder))take(c,0);
    for(const c of cands.filter(c=>c.goal&&!c.template.filler).sort(goalOrder)){
        if(!c.lacks){
            if(c.template.family==='shop-buyer'&&!inp.running?.has(c.account.toLowerCase()))
                for(const kit of kits.filter(kit=>kit.account===c.account&&kit.goal?.band===c.goal!.band))acquire(kit,'send',false);
            take(c,0);
        }
        else if(c.template.kitFirst){acquire(c,'send',false);acquire(c,'buy',false);}
    }
    for (const c of kits) acquire(c, 'send', false);
    for (const c of kits) acquire(c, 'buy', false);
    for (const step of ['buy', 'send'] as const) for (const c of kits) acquire(c, step, true);
    // The gang squad's restock, after every kit order: a free donor of this side sends a member that is short a line it
    // holds above its own reserve, one order for a member in a pass. The member must be a plannable, offline account
    // that no kit order or job took; a member that runs a hand job is restocked when it is free.
    if (inp.squad?.active) for (const row of squadRows(inp.squad, item => inp.prices[item] ?? inp.market?.[item]?.limit, SQUAD_UNIT_COST)) {
        const member = byName.get([...byName.keys()].find(n => n.toLowerCase() === row.account) ?? '');
        if (!member || done.has(member.name) || gave.has(member.name) || gaveItems.has(member.name) || vacated.has(member.name) || inp.unfundable?.has(row.account)) continue;
        const cost = (p: Acct | undefined) => cachedWayCost(p?.pos, ARMY_BANK, p ? inp.mountain?.(p) ?? true : true);
        const nonUniqueTradeNames = new Set(['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces']);
        for (const item of row.names) {
            if (nonUniqueTradeNames.has(item)) continue;
            const from = [...stock, ...memberStock.filter(s => freeMembers.has(s.name.toLowerCase()))].find(s => s.side === inp.side && s.name.toLowerCase() !== row.account && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= 1
                && !inp.noSend?.has(`${s.name}>${member.name}`.toLowerCase()) && (cost(byName.get(s.name)) ?? -1) >= 0 && (cost(member) ?? -1) >= 0);
            if (!from) continue;
            // A food row is in lobsters (squad.ts): a donor's item is counted by the HP it heals against the lobster's.
            const count = Math.min(spare(from, item), item in SQUAD_FOOD_HEAL ? Math.ceil(row.short * SQUAD_FOOD_HEAL.shark! / SQUAD_FOOD_HEAL[item]!) : row.short);
            gaveItems.add(from.name); pool.delete(from.name); pool.delete(member.name);
            done.set(member.name, { account: member.name, template: SQUAD_RESTOCK, value: 0, reason: `restocks ${count} ${item} for the gang squad, sent by ${from.name}`, resources: [],
                send: { from: from.name, to: member.name, item, count, template: SQUAD_RESTOCK.id } });
            break;
        }
    }
    // Then the filler bands, for an army account that no band and no kit took.
    for (const c of cands.filter(c => c.goal && !c.lacks && c.template.filler).sort(goalOrder)) take(c, 0);
    // The gear pass: an account that no band, kit or send took and that has a want above the gain floor (gear-want-jobs.ts)
    // buys it before any coin job, from its own coins only. A running training session is replaced only for a larger gain.
    const gearValue = new Map<string, number>();
    for (const a of mine) {
        const lower = a.name.toLowerCase(), rows = inp.gearWants?.get(lower);
        if (!rows?.length || done.has(a.name) || gave.has(a.name) || gaveItems.has(a.name) || vacated.has(a.name)) continue;
        // Both jobs are pilots: nothing starts live until the `aio` list of swarm.json names `gear-ge` or `gear-shop` (Inputs.pilots).
        // The room keeps what the account's bands keep (keepCoins), as the kit buy of a band does.
        const keepCoins = Math.max(0, ...inp.templates.filter(t => t.tier === 'goal' && bandLeft(t, a) > 0 || t.id === inp.current?.get(lower)).map(t => t.keepCoins?.(a) ?? 0));
        const job = gearJobFor(rows, { coins: a.items.coin ?? 0, room: KIT_CASH_RESERVE + KIT_COIN_MARGIN + keepCoins, running: !!inp.running?.has(lower),
            held: id => !inp.pilots?.has(id === GEAR_GE_ID ? GEAR_GE_PILOT : GEAR_SHOP_PILOT) || !!inp.retired?.has(pairKey(a.name, id === GEAR_GE_ID ? KIT_BUY + id : id)) });
        if (!job) continue;
        const place = job.kind === 'ge' ? ARMOUR_MARKET : `shop:${job.profile}`;
        if ((used.get(place) ?? 0) >= (inp.capacity?.[place] ?? 1)) continue;
        used.set(place, (used.get(place) ?? 0) + 1);
        gearValue.set(a.name, job.value);
        const bonus = `${job.gain.toFixed(1)} points of bonus`;
        if (job.kind === 'ge') {
            const lines: KitLine[] = job.lines.map(l => ({ item: l.name, id: l.id, quantity: 1, held: 0, limit: l.limit }));
            const template = kitBuyTemplate({ id: GEAR_GE_ID, goal: 'wear better gear' } as Template, a.name, lines, inp.kitSeq?.get(lower) ?? 0, KIT_CASH_RESERVE);
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${lines.map(l => l.item).join(', ')} on the market for ${bonus}, at most ${job.cost} coins` });
        } else {
            const items = job.items.map(i => i.name.replace(/[^a-zA-Z0-9 '-]/g, c => `\\${c}`)).join('|');
            const template: Template = { id: gearShopId(job.profile), family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: [job.profile, '1500'],
                env: { ITEMS: items, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(job.spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(job.spend) },
                role: 'supply', goal: `buy ${job.items.map(i => i.name).join(', ')} from the ${job.shop} to wear better gear`, repeats: false, resources: [place], yields: () => [] };
            done.set(a.name, { account: a.name, template, value: 0, resources: [place], reason: `gear: buys ${job.items.map(i => i.name).join(', ')} at ${job.shop} for ${bonus}, at most ${job.spend} coins` });
        }
    }
    // A recipient that cannot earn its kit may need a helper to become a donor. Reserve one helper for one finite
    // recipient, including the donor's retained cash. Compare full estimated ticks: earning on the recipient avoids
    // that reserve and wins whenever it costs less. Existing donors and kit orders have already had their turn.
    const cash = funding();
    const coinOptions = cands.filter(c => !c.goal && c.supply && makesCoins(c.supply.template, c.supply.account));
    const free = (c: Cand) => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account)
        && c.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1))
        && (!c.coins || [...pool].some(([name, coins]) => !done.has(name) && coins >= c.coins! && canGiveCoins(name, c.account)));
    for (const [recipient, short] of [...cash.army].sort(([x], [y]) => x.localeCompare(y))) {
        const owner = localByName.get(recipient)!;
        if (short <= 0 || done.has(owner.name) || gave.has(owner.name) || gaveItems.has(owner.name) || vacated.has(owner.name)) continue;
        const gap = Math.max(0, (cash.kits.get(recipient) ?? 0) - (owner.items.coin ?? 0) - (earnedCoins.get(recipient) ?? 0));
        const options = coinOptions.filter(c => free(c) && !bridges.has(c.account.toLowerCase())
            && (c.account.toLowerCase() === recipient || (!(cash.army.get(c.account.toLowerCase()) ?? 0) && canGiveCoins(c.account, recipient)
                && (!inp.unfundable?.has(c.account.toLowerCase()) || (inp.current?.get(c.account.toLowerCase()) === c.template.id && c.template.id === c.supply!.template.id)))))
            .map(c => {
                const lower = c.account.toLowerCase(), own = lower === recipient, target = FUND_RESERVE + gap;
                const coins = own ? short : Math.max(0, target - (localByName.get(lower)?.items.coin ?? 0) - (earnedCoins.get(lower) ?? 0));
                const rate = c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : used.get(r) ?? 0),
                    c.supply!.share * jobValue(c.supply!.template, c.supply!.account, values, item => item === 'coin' ? Infinity : 0));
                return { c, own, target, ticks: rate > 0 ? coins / rate : Infinity };
            }).filter(x => Number.isFinite(x.ticks))
            .sort((x, y) => x.ticks - y.ticks || Number(y.own) - Number(x.own) || keeps(y.c) - keeps(x.c) || x.c.account.localeCompare(y.c.account) || x.c.template.id.localeCompare(y.c.template.id));
        const chosen = options[0];
        if (chosen && !chosen.own) { bridges.set(chosen.c.account.toLowerCase(), { recipient: owner.name, target: chosen.target }); bridged.add(recipient); fundingEpoch++; }
    }
    // The supply tier, re-sorted after every assignment: each job reserves the useful output it can bring before
    // the next pass, and each resource holder lowers the worth of candidates that share its resource.
    let rest = cands.filter(c => !c.goal && !c.lacks && !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account));
    let dirty = true;
    const scores = new Map<Cand, number>();
    while (rest.length) {
        if (dirty) {
            rest = rest.filter(c => !done.has(c.account) && !gave.has(c.account) && !gaveItems.has(c.account) && !vacated.has(c.account) && !c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            if (!rest.length) break;
            scores.clear();
            for (const c of rest) scores.set(c, worth(c));
            rest.sort((x, y) => scores.get(y)! - scores.get(x)! || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id));
            dirty = false;
        }
        const c = rest.shift()!;
        const v = scores.get(c)!;
        if (v <= 0) break;
        const prevDone = done.size;
        take(c, v);
        if (done.size !== prevDone) dirty = true;
    }
    // A fully owned recipe or band may lack only its cash/fare. Keep local work and its donor arbitration first;
    // only a remaining idle slot asks remote cash through the same Funding order.
    for(const c of [...cands.filter(c=>c.goal&&!c.lacks&&c.coins).sort(goalOrder),...cands.filter(c=>!c.goal&&!c.lacks&&c.coins).sort(order)])take(c,worth(c),true);
    // A vacant slot names its constraint: the fare it lacks for a job whose place is still free, when that is all it lacks.
    const noFare = (a: Acct) => { const x = fareShort.get(a.name)?.find(x => x.resources.every(r => (used.get(r) ?? 0) < (inp.capacity?.[r] ?? 1)));
        return x ? `vacant: lacks ${x.coins} coins for the way to ${x.id} (ferry fare ${x.fare}), and no free account can give them` : undefined; };
    // More jobs than free bot slots: the best keep theirs. An account whose bot holds a slot now (a confirmed live session,
    // or a run that the swarm lists, a start inside its window included) keeps a job whatever the count, so a hand job that
    // the owner enables never stops a running planner job, and a kit buy that replaces a running band keeps its account's
    // slot. The rest rank by goal band and the levels left, then supply jobs by worth, and fill the slots that remain. The
    // others wait for a slot (the swarm admits no more).
    const waits = new Map<string, string>();
    if (inp.slots !== undefined) {
        // A fund or send assignment starts an order that logs in two accounts (the recipient and the donor): it costs two bots.
        const cost = (x: Assignment) => x.fund || x.send ? 2 : 1;
        const jobs = [...done.values()].filter(x => x.template);
        if (jobs.reduce((n, x) => n + cost(x), 0) > inp.slots) {
            const holds = (x: Assignment) => !!inp.running?.has(x.account.toLowerCase()) || !!inp.holding?.has(x.account.toLowerCase());
            // The gang squad's stock comes first while the squad is active: its restock, then its supply jobs, then the goal bands.
            // The squad is the live consumer of these lines: a bank trip that is short of one of them ends the squad's run.
            const rank = (x: Assignment): number[] => {
                const id = x.template!.id, c = cands.find(k => k.account === x.account && (k.template.id === id || KIT_BUY + k.template.id === id));
                if (id === SQUAD_RESTOCK.id) return [0, -2, 0];
                if (c?.template.squadOnly) return [0, -1, -worth(c)];
                return c?.goal ? [0, c.goal.band, c.goal.left] : c ? [1, -worth(c), 0] : gearValue.has(x.account) ? [0, 1e6, -gearValue.get(x.account)!] : [2, 0, 0];
            };
            const holders = jobs.filter(holds);
            let room = Math.max(0, inp.slots - holders.reduce((n, x) => n + cost(x), 0));
            const others = jobs.filter(x => !holds(x)).map(x => ({ x, r: rank(x) })).sort((p, q) => { for (let i = 0; i < 3; i++) if (p.r[i] !== q.r[i]) return p.r[i]! - q.r[i]!; return p.x.account.localeCompare(q.x.account); });
            for (const { x } of others) {
                if (cost(x) <= room) { room -= cost(x); continue; }
                done.delete(x.account);
                if (x.fund) gave.delete(x.fund.from);
                if (x.send) gaveItems.delete(x.send.from);
                waits.set(x.account, `vacant: waits for a bot slot (${inp.slots} free, ${holders.length} held by running bots): ${x.template!.id} ranks below the jobs that hold them`);
            }
        }
    }
    // The first gate that stopped the account's nearest template (see `misses`), or what its candidates met.
    const full = (c: Cand) => c.resources.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
    const vacancy = (a: Acct): string => {
        const list = misses.get(a.name) ?? [], has = (gate: Miss['gate']) => list.filter(m => m.gate === gate);
        // The nearest job the account could do but for one gate: a candidate that no pass took, then a template that
        // stopped before it was a candidate.
        const job = (): string | undefined => {
            const own = cands.filter(c => c.account === a.name).sort((x, y) => Number(!!y.goal) - Number(!!x.goal) || (x.goal?.band ?? 0) - (y.goal?.band ?? 0) || worth(y) - worth(x) || x.template.id.localeCompare(y.template.id));
            for (const c of own) {
                const id = c.template.id, place = full(c);
                if (place) return `${id} has no free place on ${place}`;
                if (c.lacks) return `${id} needs ${c.lacks.map(l => `${l.count} ${l.of[0]}`).join(', ')} and no source gives them`;
                if (c.coins) return `${id} needs ${c.coins} coins and no free account can give them`;
            }
            const coins = has('coins').find(m => !(m.template.resources ?? []).some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1)));
            const crowded = has('coins')[0]?.template.resources?.find(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1));
            if (crowded && !coins) return `${has('coins')[0]!.template.id} has no free place on ${crowded}`;
            if (coins) return `${coins.template.id} needs ${coinShort(a, coins.template.needs)} coins and no free account can give them`;
            const none = has('demand')[0];
            const needs = has('needs').map(m => ({ m, lacking: unmet(a, m.template.needs) })).filter(x => x.lacking.length)
                .sort((x, y) => x.lacking.length - y.lacking.length || x.m.template.id.localeCompare(y.m.template.id))[0];
            if (needs && (!none || needs.lacking.length <= 1)) return `${needs.m.template.id} needs ${needs.lacking.join(', ')}`;
            if (none) return `${none.template.id} has no finite demand`;
            const reach = has('reach')[0];
            if (reach) return `${reach.template.id} has no way from where the account stands`;
            const pilot = has('pilot').find(m => meets(a, m.template.needs));
            if (pilot) return `${pilot.template.id} is a pilot that the aio list does not name`;
            const retired = has('retired')[0];
            if (retired) return `${retired.template.id} is retired for this account`;
            return undefined;
        };
        // With no finite demand no supply job has value, whatever it lacks; a goal band still stands apart from demand.
        // An observation that is too old to offer stock is a cause of "no source", so the reason says so.
        const sourceless = (text: string | undefined) => {
            if (!text || !/ and no source/.test(text)) return text;
            const notes: string[] = [];
            if (inp.now !== undefined && a.observedAt !== undefined && inp.now - a.observedAt > OBSERVATION_FRESH_MS) notes.push(`its own observation is ${Math.round((inp.now - a.observedAt) / 3_600_000 * 10) / 10} h old`);
            if (inp.unobserved?.length) notes.push(`${inp.unobserved.length} free accounts have no observation under ${OBSERVATION_FRESH_MS / 60_000} minutes old, so their stock is not offered`);
            return notes.length ? `${text} (${notes.join('; ')})` : text;
        };
        const roster = has('roster')[0], other = sourceless(demand.some(d => d.short > 0) ? job() : 'no finite route or army supply demand');
        if (roster) return `vacant: not on the army roster (${has('roster').length} bands, nearest ${roster.template.id})${other ? `; otherwise ${other}` : ''}`;
        return `vacant: ${other ?? 'no template meets its skills and holdings'}`;
    };
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass'
        : gaveItems.has(a.name) ? 'vacant: gives a kit item this pass' : waits.get(a.name) ?? vacated.get(a.name) ?? noFare(a) ?? vacancy(a) });
}

// The swarm job for an assignment. `autopilot` marks it as this side's planner job; the CLI replaces only marked jobs.
// A training job or a quest job does not repeat: its ok RESULT means the target level is met (or the quest is done), and a rerun would log in, find the level
// met and log out (a scored login for nothing). The swarm keeps the account's `done` end until the next pass hands it
// a job with a different mission, which the met level unlocks. A run that ends short of the target is a fail RESULT,
// which the supervisor retries and the swarm's standing retry resumes, with or without repeat. Declared finite
// makers take one attempt: success needs a fresh stock observation, and a failed end needs the supported repair path.
// finishedTrainers() brings that next pass forward.
export function jobFor(x: Assignment, side: string) {
    const t = x.template!;
    return { account: x.account, script: t.script, args: t.args ?? [], env: t.env ?? {}, role: t.role, goal: t.goal, enabled: true, repeat: t.repeats ?? !(t.trains || t.quest), standing: true,...(t.production?{standingRetry:false,maxRestarts:0}:{}),
        autopilot: side, template: t.id, resources: x.resources, note: `autopilot ${t.id}: ${x.reason}, ${x.value.toFixed(2)} coins/tick (estimate)` };
}

// A trainer or quest that succeeded, or a finite maker that ended: the current assignment and job fingerprint must
// match the complete result. The daemon reobserves these accounts at once through its existing planning pass.
export function finishedTrainers(jobs: readonly any[], side: string, assigned: Readonly<Record<string, { template: string; offset: number }>>, templates: readonly Template[],
    linesSince: (account: string, offset: number, job: any) => readonly string[]): string[] {
    // A quest job ends as a trainer does: its ok RESULT frees the account for the job the quest unlocks.
    const watched = new Map(templates.filter(t => t.trains || t.quest || t.production).map(t => [t.id,t]));
    return jobs.filter(j => {
        if(j?.autopilot!==side||typeof j.account!=='string'||!watched.has(j.template)||assigned[j.account]?.template!==j.template)return false;
        const lines=linesSince(j.account,assigned[j.account]!.offset,j);
        // runChild indents chain steps; only the outer job's column-zero RESULT settles a finite maker.
        const result=assess(watched.get(j.template)!.production?lines.filter(l=>l.startsWith('RESULT ')):lines);
        return watched.get(j.template)!.production?result.ok+result.fail+result.drains>0:result.ok>0;
    }).map(j=>j.account);
}

// Retirement from a job's own log lines (since the autopilot assigned it): the last RETIRE_FAILS RESULTs all fail with
// no progress, a RESULT reports a death, or the last LEDGER spent WASTE_LIMIT or more of its ticks idle or walking.
// The ledger counts the ticks between two hits of a fight as idle and the walk to the next target as move, so a
// fighter on a shared field passes WASTE_LIMIT while it gains XP: a ledger whose own run ended ok with progress (the
// RESULT printed after it) does not retire. Live claude-cloud, 12 accounts on the trooper field: ok trooper and cow
// runs at 91-93% idle+move were retired and their accounts sent back to a lower band.
// A trainer that hits its tick cap short of the target ends fail with the XP it gained (scripts/generated/thieving60.ts
// prints xp=<gain>), so the supervisor runs it again; such a fail is progress and does not count toward retirement.
// A run the server or the relayed gateway dropped says nothing about the job, so it is counted as a drain, never as a
// failure: a dropped session (`RESULT fail session ended: disconnected`; the cloud proxy's 1012 `server_draining`
// closes), a game socket that errors at login (`RESULT fail login: [object WebSocket]`), and a server that stops
// ticking (`RESULT fail TickStallError`). Its supervisor logs the account back in and the next run banks the carried
// pack. Counting these as failures retired every knight spot of every account in one server outage. A login refused
// because a dropped session still holds the account's fleet claim (the worker logs `RESULT fail login: Error: fleet
// account claim held by swarm` until an authenticated recovery confirms the logout) is a drain too: the job never ran,
// and the recovered account resumes it. So is a world planner `precondition no route to`: it says where the account
// stands, not whether the job works, and a routing fix makes the same job run. And so is a market buy that did not
// reach the market bank (`market bank travel failed`, scripts/buy-owned-ge-item.ts): no order was placed, and the
// account stands nearer the bank for its next try (live claude-cloud: after the second ferry a relayed session's
// state went stale at Port Sarim, the route was planned from it, and two such trips retired an account's rune buy;
// the same walk from that tile takes 249 ticks on practice). And so is a market buy refused at the bank because the
// account owns another count of the item than the planner read (`owned item baseline N differs from EXPECTED_OWNED
// M`): no order was placed, the run's bank visit gives the planner the count, and the next pass sizes the buy from it
// (live: three accounts' rune buys retired on a count 36 to 124 over the bank's).
export const RETIRE_FAILS = 2, WASTE_LIMIT = 0.9;
// The ledger length under which a stop file's end exempts a run from the tick-waste retirement: the shortest job caps
// (a shop trip, a kit buy) are 1,200 to 1,500 ticks, so a ledger under 1,000 ticks is the walk to the work.
export const STOP_LEDGER_TICKS = 1000;
// Cow mode reports its progress as selectedXp, damageXp and creditedKills.
// A shop run reports what it bought as boughtTotal (scripts/shop-buyer.ts), and a Grand Exchange buy as "acquired" in
// its JSON result (scripts/buy-owned-ge-item.ts). Without the second, a kit buy that ended ok after its long trip read
// as tick waste and its pair was retired, so the account's next buy for that band never came (live claude-cloud: the
// alchemy kit buys of KnightRider, Deeppockets and Fatstack, one of them after 1,000 nature runes bought).
// A blood chest run reports "loots" in its JSON result (scripts/blood-chest.ts): it waits on the surface for the
// chests to come back, so most of its ticks are idle.
export const progressed = (result: string) => /\b(?:xp|gained|coinsGained|banked|selectedXp|damageXp|creditedKills|boughtTotal|hides)=[1-9]\d*\b|"(?:acquired|loots)":[1-9]/.test(result);
// A run that ended on a stop file is a drain as well: the owner paused the account or the controller removed the job,
// which says nothing about whether the job works (live claude-cloud: a quest chain stopped for an open fleet order
// logged two such fails, and the account's Lost City band was retired).
// An offline login server or an unavailable swarm claim authority refuses the session before the worker runs.
// Supervisor retry bounds and claim recovery still apply; neither refusal establishes a broken worker.
const DRAIN_BASE = /^RESULT fail (?:session ended: disconnected\b|login: \[object WebSocket\]|login: LoginError: Login server offline\b|TickStallError\b|(?:login: )?(?:Error: )?fleet account claim held\b|(?:login: )?(?:Error: )?fleet swarm claim authority (?:unavailable or changed|timed out)\b|.*\bprecondition no route to\b|.*\bmarket bank travel failed\b|.*\bowned item baseline \d+ differs from EXPECTED_OWNED \d+|.*\bstop"?[=:]"?preparation\b|.*\bprogression requires acquire\b|stop file\b|.*\bworker finished: stop file\b)/;
// A buy that ends before it places an offer, on any refusal of packages/core/src/order-refusal.ts, is no failure of its job.
export const DRAIN_RESULT = new RegExp(DRAIN_BASE.source.replace('^RESULT fail (?:', `^RESULT fail (?:.*"phase":"unplaced",.*"escrow":0,.*"failure":"Error: (?:${REFUSAL_ANY_SOURCE})|`));
export function assess(lines: readonly string[]): { retire: boolean; reason: string; ok: number; fail: number; drains: number } {
    const clean = lines.map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, ''));
    const drains = clean.filter(l => DRAIN_RESULT.test(l)).length;
    const results = clean.filter(l => /^RESULT (ok|fail)\b/.test(l) && !DRAIN_RESULT.test(l));
    const ok = results.filter(l => l.startsWith('RESULT ok')).length, fail = results.length - ok;
    // goldfarm and thieving60 print died=false on a healthy run, and scripts/buy-owned-ge-item.ts prints "died":false in
    // its JSON: only a bare word or a field that is not false counts.
    const died = results.find(l => /\b(?:died|death)\b(?!=|"\s*:\s*false\b)|\b(?:died|death)=(?!false\b)/i.test(l));
    if (died) return { retire: true, reason: `death: ${died.slice(0, 120)}`, ok, fail, drains };
    const tail = results.slice(-RETIRE_FAILS);
    if (tail.length === RETIRE_FAILS && tail.every(l => l.startsWith('RESULT fail') && !progressed(l))) return { retire: true, reason: `${RETIRE_FAILS} fail RESULTs: ${tail.at(-1)!.slice(0, 120)}`, ok, fail, drains };
    // A single preparation/acquire block is a drain, but RETIRE_FAILS consecutive blocks with no progress is a fast-fail loop.
    const allResults = clean.filter(l => /^RESULT (ok|fail)\b/.test(l));
    const prepTail = allResults.slice(-RETIRE_FAILS);
    if (prepTail.length === RETIRE_FAILS && prepTail.every(l => l.startsWith('RESULT fail') && /\b(?:stop"?[=:]"?preparation\b|progression requires acquire\b)/.test(l) && !progressed(l)))
        return { retire: true, reason: `${RETIRE_FAILS} preparation/acquire RESULTs: ${prepTail.at(-1)!.slice(0, 120)}`, ok, fail, drains };
    const at = clean.reduce((last, l, i) => l.startsWith('LEDGER ') ? i : last, -1);
    const ledger = clean[at]?.match(/^LEDGER ticks=(\d+).* move=(\d+).* idle=(\d+)/), ended = clean.slice(at + 1).find(l => /^RESULT (ok|fail)\b/.test(l));
    // A run that an owner or controller stop file cut while its ledger was still short says nothing about the waste of
    // its job: the ledger is the walk to the work. A long ledger (STOP_LEDGER_TICKS or more) has shown its waste, and any
    // other drain ending leaves the rule as it was.
    const stopCut = !!ended && /^RESULT fail (?:.*\bworker finished: )?stop file\b/.test(ended) && !!ledger && +ledger[1]! < STOP_LEDGER_TICKS;
    if (ledger && +ledger[1]! >= 300 && (+ledger[2]! + +ledger[3]!) / +ledger[1]! >= WASTE_LIMIT && !(ended?.startsWith('RESULT ok') && progressed(ended)) && !stopCut)
        return { retire: true, reason: `tick waste ${(100 * (+ledger[2]! + +ledger[3]!) / +ledger[1]!).toFixed(0)}% idle+move`, ok, fail, drains };
    return { retire: false, reason: '', ok, fail, drains };
}

// Thieving success at a knight of Ardougne (pickpocket.dbrow: 50..240 of 256 from level 1 to 99), scaled from the
// goldfarm model of 18.8 coins per tick at 99 (scripts/goldfarm.ts header). Estimate.
export const knightCoinsPerTick = (thieving: number) => thieving < 55 ? 0 : 18.8 * (50 + 190 * (Math.min(99, thieving) - 1) / 98) / 240;
export const KNIGHT_SPOTS = ['2652,3318', '2653,3300', '2669,3298', '2671,3313', '2582,3297'];
// The food that scripts/goldfarm.ts eats, and its rule for a thief with few Hitpoints (FRAIL_HP and FRAIL_FLOOR there;
// scripts/goldfarm.test.ts keeps the numbers equal): with fewer food items than the floor in its pack and its bank,
// that worker ends the run at once, so such an account gets no knight spot.
export const GOLDFARM_FOOD = ['slice of cake', '2/3 cake', 'cake', 'chocolate slice', 'bread', 'trout', 'salmon', 'lobster', 'shark'] as const;
export const GOLDFARM_FRAIL = { hitpoints: 20, of: GOLDFARM_FOOD, count: 2 } as const;
// The food buy of a frail thief that has coins and no food (plan): 200 units feed about one 9,000 tick run of an
// account with 99 Thieving (16 of 256 picks fail for 3 damage, about 0.19 damage a pick; estimate, not measured).
export const FRAIL_FOOD_BUY = 200, FRAIL_FOOD_BUY_ID = 'goldfarm-food';
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
export const BLACK_CAVE = 'cave:taverley-black-dragons', BLACK_CAVE_PLACES = 2, HUNT_BAND = 10, HIDE_TARGET = 42;
export const HUNT_ARROWS = 600, HUNT_KILLS = 9, HUNT_FOOD = 6;
// The rune arrows of a hunt trip: a kill used 35, 47 and 14 rune arrows against 60, 81 and 52 mithril arrows, and took 236,
// 271 and 184 ticks against 312, 388 and 298 (bench cases extra:black-dragon-rune and boss:black-dragon, hosted run
// 44473165322, seeds 1 to 3). Nine kills at the most that one kill used, and the Ranging Guild shelf holds 400.
export const HUNT_RUNE_ARROWS = 400;
// Their price off a full shelf: 400 coins and 1% of it more for each arrow bought before (shop.rs2), 479,200 for 400.
export const HUNT_RUNE_SPEND = 500_000;
// What a hunter's supply run brings it up to: the arrows of two trips, and the air and fire runes of twenty teleports.
export const HUNT_ARROW_STOCK = 1200, HUNT_RUNE_STOCK = 60;
// Dragon longswords from Jakut (scripts/shop-buyer.ts profile jukat): the swords one visit buys (his shelf holds two,
// a unit of an emptied shelf costs 101,000), the coins the run takes for them with its reserve, the ticks it waits
// inside with no buy (six restocks: one diamond pays for the wait) and the run's tick cap.
export const JAKUT_SWORDS = 2, JAKUT_RESERVE = 5_000, JAKUT_COINS = JAKUT_SWORDS * 103_000 + JAKUT_RESERVE, JAKUT_WAIT = 3000, JAKUT_CAP = 9000;
// The armour of the hides (scripts/black-dhide-sets.ts): a set is a body, chaps and vambraces of SET_HIDES hides, the
// body asks Crafting LEATHER_LEVEL, a hide costs TAN_COIN to tan and a run takes SET_SHOP coins for a needle and
// thread. ARMOUR_SETS: the bodies one account makes, half the army's. FLAX_SPIN: the flax one spinning run takes.
export const LEATHER_LEVEL = 84, SET_HIDES = 6, TAN_COIN = 20, SET_SHOP = 100, ARMOUR_SETS = 7, FLAX_SPIN = 168;
// The tile south of the Ardougne cow field's fence (scripts/splash-train.ts SPLASH_TILE): a curse cast over the fence
// reaches the cows and no cow reaches the caster. A cow whose stat a cast lowered refuses the next cast until the stat
// grows back, one level every 100 ticks, so the ten cows give about one cast in ten ticks, shared by the casters.
// Practice: one account 40 casts in 608 ticks; two at once 138 and 135 casts in 4,043 and 4,011 ticks, the same field
// rate (research/combat-measure.md, Magic by a curse over the fence). More than two at once is not measured.
// SPLASH_TO is the level the Magic Guild's door in Yanille asks: behind it are fire runes, a staff of fire and nature
// runes for the alchemy band. SPLASH_KIT covers the runes to that level from any start (144 casts from Magic 1: 142
// body, 290 water, 420 earth; 135 curses from Magic 21). SPLASH_START is what a run needs to start: ten casts of any
// of its spells, which is the last level's casts. splashKit is what an account's level still casts (a curse is 1
// body, 2 water and 3 earth runes for CURSE_XP; under Curse's level the whole kit): the size of a buy or a send, and
// what the account keeps of its own runes.
export const SPLASH_FENCE = 'splash:ardougne-cow-fence', SPLASH_PLACES = 2, SPLASH_TO = 66;
export const SPLASH_KIT = { 'body rune': 150, 'earth rune': 425, 'water rune': 300 } as const;
export const SPLASH_START = { 'body rune': 10, 'earth rune': 30, 'water rune': 30 } as const, CURSE_LEVEL = spellFact('curse').level, CURSE_XP = spellFact('curse').xp;
export function splashKit(magic: number): Record<string, number> {
    const casts = Math.max(SPLASH_START['body rune'], Math.ceil((xpForLevel(SPLASH_TO) - xpForLevel(magic)) / CURSE_XP));
    return magic < CURSE_LEVEL ? { ...SPLASH_KIT } : { 'body rune': casts, 'earth rune': 3 * casts, 'water rune': Math.max(SPLASH_START['water rune'], 2 * casts) };
}
// The places the AIO routes hold (aioTemplates). Each takes one account until a live pilot measures two.
export const AIO_PLACES = { flax: 'aio:seers-flax', yews: 'aio:seers-yews', ore: 'aio:varrock-east-mine', essence: 'aio:essence-mine', air: 'aio:air-altar', blood: 'aio:ardougne-blood-chests' } as const;
// The quests that no owned account has done, as sweep jobs for army accounts with time left (QUEST_DEMAND_BAND: after the
// build bands, before the open-ended fields). One account does each quest once: `once` stops the demand when any
// observed account has it done (Inputs.questsDone). `ticks`: the game ticks of the saved practice run (the bench case
// `quester:quest:<slug>`), which orders the bands, the cheapest first. `skills` and `quests` are the journal's asks
// (packages/dashboard/client-assets/quest-reqs.json) and `items` is the pack of the practice run
// (scripts/quest-sweep.ts presetFor), with `meals` of food; Hitpoints 90 stands where the practice run fell under 70
// Hitpoints with 99 in every skill (the saved `hpMin`). A quest is a `kitFirst` band: an account that lacks its pack gets the items from a donor, or buys them
// within the caps of questKitCaps below, and one that cannot shows the missing item as the vacant reason. The table leaves out the quests that no one-account sweep can run: Shield of Arrav, Hero's Quest and
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
// The price caps of the quest packs' items that the Grand Exchange can sell and KIT_PRICE_CAPS does not list: four times the item's base
// value (knowledge/items.json `cost`), at least QUEST_CAP_MIN coins. The cap bounds each buy; the market read (packages/planner kitMarket,
// scripts/autopilot.ts) drops an item whose lowest ask is over it. Added to KIT_PRICE_CAPS once, here, after the table that names the items.
export const QUEST_CAP_FACTOR = 4, QUEST_CAP_MIN = 25;
export function questKitCaps(rows: readonly { items: Readonly<Record<string, number>> }[] = QUEST_DEMAND_ROWS): Record<string, number> {
    const content = new Map((JSON.parse(readFileSync(resolve(import.meta.dir, '../../../knowledge/items.json'), 'utf8')) as { name: string; debugname?: string; cost: number; tradeable?: boolean }[])
        .filter(i => !/^cert_/.test(i.debugname ?? '')).map(i => [norm(i.name), i] as const).reverse());
    const out: Record<string, number> = {};
    for (const row of rows) for (const item of Object.keys(row.items)) {
        const found = content.get(norm(item));
        if (found?.tradeable && found.cost > 0 && !(norm(item) in KIT_PRICE_CAPS) && coinItem(norm(item)) === false) out[norm(item)] = Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * found.cost);
    }
    return out;
}
const coinItem = (item: string) => item === 'coin';
for (const [item, cap] of Object.entries(questKitCaps())) (KIT_PRICE_CAPS as Record<string, number>)[item] ??= cap;
// CAPACITY: accounts at one resource at a time. Every number is policy (a place, a market or a spot holds this many), not a game fact.
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, 'squad:catherby-sharks': 3, 'squad:taverley-druids': 2, 'squad:taverley-black-knights': 2, 'squad:barbarian-planks': 1, 'squad:gnome-toads': 1, 'squad:taverley-scales': 2, 'squad:taverley-black-dragons': 2, 'squad:chaos-temple-wine': 2, 'squad:seers-magic-trees': 2, 'squad:edgeville-unicorns': 2, 'squad:ardougne-giants': 2, 'squad:hobgoblin-snape': 2, [WEAPON_MARKET]: WEAPON_BUYERS, [ARMOUR_MARKET]: ARMOUR_BUYERS, [LOST_CITY]: LOST_CITY_PLACES, [GRAIL_PLACE]: GRAIL_PLACES, [FREMENNIK]: FREMENNIK_PLACES, [UPASS]: UPASS_PLACES, [QUEST_DEMAND]: QUEST_DEMAND_PLACES, ...Object.fromEntries(QUEST_DEMAND_ROWS.map(q => [questResource(q.slug), 1])), ...Object.fromEntries(Object.values(AIO_PLACES).map(p => [p, 1])), [COW_FIELD]: COW_FIELD_CAPACITY, [TROOPER_FIELD]: TROOPER_FIELD_CAPACITY, [STRIKE_TILE]: 1, [SPLASH_FENCE]: SPLASH_PLACES, [BLACK_CAVE]: BLACK_CAVE_PLACES, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
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
const SEERS_BANK: Spot = { x: 2727, z: 3492 }, CATHERBY_BANK: Spot = { x: 2809, z: 3441 }, DRAYNOR_BANK: Spot = { x: 3092, z: 3243 }, VARROCK_EAST_BANK: Spot = { x: 3253, z: 3420 };
export const PLACES: Readonly<Record<string, Spot>> = {
    [COW_FIELD]: ARMY_BANK, [STRIKE_TILE]: ARMY_BANK, [SPLASH_FENCE]: ARMY_BANK, [TROOPER_FIELD]: ARMY_BANK,
    'catherby:lobster': CATHERBY_BANK, [AIO_PLACES.flax]: { x: 2744, z: 3445 }, [AIO_PLACES.yews]: SEERS_BANK,
    'shop:ardy': { x: 2654, z: 3283 }, 'shop:catherby': CATHERBY_BANK, 'shop:catherby_arrows': CATHERBY_BANK, 'shop:dargaud': SEERS_BANK, 'shop:magic_guild': { x: 2612, z: 3093 },
    'shop:magic_guild_elemental': { x: 2612, z: 3093 }, 'shop:alfonse': { x: 2654, z: 3283 }, 'shop:tiadeche': { x: 2654, z: 3283 },
    'shop:oziach': { x: 3094, z: 3491 }, 'shop:herquin': { x: 2946, z: 3368 }, 'shop:gem_trader': { x: 3269, z: 3167 },
    'shop:tenzing': { x: 2946, z: 3368 }, 'shop:jukat_dagger': { x: 3152, z: 9578 }, 'shop:taverley': { x: 2934, z: 3376 },
    'shop:siegfried': { x: 2654, z: 3283 }, 'shop:helemos': { x: 2946, z: 3368 },
    'aio:water-altar': DRAYNOR_BANK, 'fighter:wizards-tower': DRAYNOR_BANK, 'squad:catherby-sharks': CATHERBY_BANK,
    'squad:shilo-karambwan': { x: 2852, z: 2955 }, 'squad:catherby-cooking': CATHERBY_BANK,
    'squad:seers-magic-trees': SEERS_BANK, 'squad:seers-fletch': SEERS_BANK,
    'squad:varrock-smithing': { x: 3185, z: 3436 }, 'squad:al-kharid-craft': { x: 3269, z: 3167 },
    'squad:rimmington-gold': { x: 2946, z: 3368 }, 'squad:hobgoblin-snape': { x: 2946, z: 3368 },
    'squad:chaos-temple-wine': { x: 2946, z: 3368 }, 'squad:edgeville-unicorns': { x: 3092, z: 3496 },
    'squad:ardougne-giants': ARMY_BANK, 'squad:taverley-druids': { x: 2946, z: 3368 },
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
function withFare(t: Template, fare: number): Template {
    const key = Object.keys(t.needs?.items ?? {}).find(i => norm(i) === 'coin') ?? 'coins';
    return { ...t, needs: { ...t.needs, items: { ...t.needs?.items, [key]: (t.needs?.items?.[key] ?? 0) + fare } } };
}
// Army goal bands (AGENTS.md goals: maxed tribrids), in order: Strength, Attack, Magic, Prayer, Ranged, Defence
// last. Bands 6-8 are the Khazard troopers (TROOPER_BANDS), 9 is Prayer on the field (PRAYER_FIELD_BAND). Ardougne cows (scripts/gather-combat.ts cow mode, north bank profile, MAX_KILLS=8): live 4/4 runs
// RESULT ok at 15.7 Strength XP per tick from Strength 1 to 46 (research/combat-measure.md, live cow training);
// practice 3/3 from Hitpoints 32 with trout and 3/3 with cake only (claude-cloud-4 .practice/combat-ladder). This
// server's level table puts 45 at 22,767 XP, 60 at 66,193, 70 at 133,230, 80 at 267,169, 90 at 534,888 and 99 at
// 998,458, so the cows take each skill to 45 (about 1,450 ticks) and, while nothing faster is qualified, on through 60,
// 70, 80, 90 and 99 (about 2,800, 4,200, 8,400, 16,700 and 29,000 more ticks a pass; estimates, as XP per kill is
// fixed). Live, TrouserSnake and TheFullMonty finished the 45 and 60 passes with RESULT ok runs. Cow mode
// needs 14 HP of trout or cake held (COW_FOOD_HP) and the bronze sword and wooden shield held or worn, starts at the
// north bank and never wields better gear; COW_STAGE=1 (scripts/cow-stage.ts) walks the account there and takes the
// sword, shield and food from its bank first, banking the rest of the pack: 3/3 on practice from the knight spot
// with the kit and 8 HP of cake banked, RESULT ok with 8 kills and logged out (.practice/cow-stage-proof). A fresh
// account (every combat skill 1, Hitpoints 10) runs it too: practice 7/7 RESULT ok with 8 kills, Strength 1 to 28, at
// most one bite eaten and lowest HP 6, with trout (4 runs) and with cake only (3 runs), three at once
// (research/combat-measure.md, fresh accounts). Gap: the rate above level 46 is not measured.
// The first pass takes bands 0, 1 and 5; each later pass takes the next three bands from 10.
export const COW_PASSES = [45, 60, 70, 80, 90, 99] as const;
export const COW_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number; to: number }[] = COW_PASSES.flatMap((to, k) =>
    (['Strength', 'Attack', 'Defence'] as const).map((skill, i) => ({ skill, to, band: k === 0 ? [0, 1, 5][i]! : 7 + 3 * k + i })));
// Khazard troopers (scripts/gather-combat.ts TARGET=trooper): practice 3/3 RESULT ok at xpRate 25 for an account with
// Attack 69, Strength 60, Defence 61, Hitpoints 84, a bronze sword and banked sharks, Strength 60 to 72-73 in 1,585
// ticks (60.9-63.4 XP per tick, about 4 times the cows), 0-3 sharks eaten, lowest HP 41 (research/combat-measure.md).
// It walks to the Ardougne north bank from anywhere, wields the best owned metal blade, carries GIANT_FOOD pieces of
// food (shark, swordfish, lobster, trout, cooked meat, or the baker's stall's bread, chocolate slice and cake) and
// eats at half HP. Bands 6-8 come after the first
// cow pass and before the cow passes from 60, for accounts at 60 or more in all three skills; without the food an
// account stays on the cows. Raw beef counts as food (TROOPER_STOCK): an account leaves the cows with one raw beef a
// kill banked, and TROOPER_COOK=1 cooks it at the range by the bank before the run (scripts/trooper-food.ts). With the
// beef gone the same stage steals a pack of cake, bread and chocolate slices at the Ardougne baker's stalls, so an
// account with Thieving 5 and current HP above half needs no food to start (TROOPER_FED); the trainer eats cake a bite at a time. Live, TheFullMonty trained Ranged 1 to 61 and Strength 61 to 78 there. GIANT_BURY=1 has the trainer bury
// the bones each kill leaves until Prayer 99: practice, six at once, about 2.5 Prayer XP per tick for 16% of the
// Strength rate (research/combat-measure.md, bones buried on the field). Gap: live rates with several accounts at
// once are not measured.
export const TROOPER_FOOD = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake'] as const;
export const TROOPER_STOCK = [...TROOPER_FOOD, 'raw beef'] as const;
// What feeds a trooper run: 10 pieces of stock held, or Thieving 5 with observed HP above half, with which the job's
// food stage steals a pack at the Ardougne baker's stalls (scripts/trooper-food.ts). Injury or unknown HP needs stock.
export const TROOPER_FED: readonly Needs[] = [{ pieces: { of: TROOPER_STOCK, count: 10 } }, { skills: { Thieving: 5 }, hpAboveHalf: true }];
export const TROOPER_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number }[] = [
    { skill: 'Strength', band: 6 }, { skill: 'Attack', band: 7 }, { skill: 'Defence', band: 8 },
];
// Magic, band 2: alchemy at the Ardougne north bank (scripts/alch-train.ts) walks there from anywhere, banks the pack,
// takes nature runes, fire (runes, or a fire staff it wields) and feathers, low-alchs to 55 and high-alchs to the
// target. At xpRate 25 a High Alchemy cast gives 1,625 XP and takes 4.75 ticks (castTicks in alch-plan.ts: 12 casts in 57 ticks on the bench), 342 XP
// a tick, so Magic 50 to 99 is about 2,840 ticks (alchTicks). A run that runs out of supplies ends ok after a level;
// the account takes the band again once restocked. Prayer, band 3: scripts/train-prayer.ts BURY_HELD=1 buries the held
// bones above BONE_RESERVE up to 99 from the Ardougne north bank (entry within 60 tiles) and ends ok when they run
// out after a level; practice from the knights buried 114 of 120 bones in 282 ticks to Prayer 75, about 2.2 ticks a
// bone. Gap: neither is run live.
export const MAGIC_BAND = 2, PRAYER_BAND = 3;
// Bought bones: Prayer XP a bury (scripts/train-prayer.ts BONE_XP; a test keeps the two tables equal), the bones the
// trainer keeps (its BONE_RESERVE floor) and the bones a bury band starts with.
export const BOUGHT_BONE_XP: Readonly<Record<number, number>> = { [objId('dragon bones')]: boneXp('dragon bones'), [objId('big bones')]: boneXp('big bones') };
export const BONE_KEEP = 6, BONE_START = 16, BONE_PURSE = 100_000, BONE_SKILL = 90;
// Prayer on the field, band 9, a filler: an account with every melee skill at 99 kills troopers only for their bones
// and buries each on the spot (trooper mode with TRAIN_SKILL=Hitpoints, which takes any style, and GIANT_KILLS past the
// tick cap, so each run ends on the cap). An account takes it when no other band and no kit buy serves it; without it
// a melee-maxed account short of 100 bones fell to a coin job (live: TrouserSnake at Prayer 89).
export const PRAYER_FIELD_BAND = 9;
// Ranged, band 4: trooper mode with TRAIN_SKILL=Ranged wields the best owned bow for the Ranged level and the best
// owned arrows that bow fires (an arrow's level may not exceed the bow's), on rapid, and restocks arrows on bank trips;
// out of arrows it ends stop=ammo, ok after kills. It takes its fired arrows back after each kill. Practice 3/3
// RESULT ok with bronze arrows: Ranged 1 to 59-62 in about 1,600 ticks, 41.1-46.7 XP a tick, 0.67-2.02 arrows lost
// per 1,000 XP (research/combat-measure.md). It shares the battlefield with the melee trooper bands.
export const RANGED_BAND = 4, GUILD_BAND = 3.9, RANGED_TROOPER_DEFENCE = 60;
// The level of a bow and of an arrow comes from the content (a bow fires arrows of its tier or lower); the order is the planner's.
const BOWS: readonly (readonly [string, number])[] = ['shortbow', 'longbow', 'oak shortbow', 'oak longbow', 'willow shortbow', 'willow longbow',
    'maple shortbow', 'maple longbow', 'yew shortbow', 'yew longbow', 'magic shortbow', 'magic longbow'].map(bow => [bow, wearLevel(bow, 'ranged')] as const);
// Native bows and their unstrung inputs share display names. Only the strung base ID supplies a combat kit.
const BOW_IDENTITIES: Readonly<Record<string, readonly [strung: number, unstrung: number]>> = Object.fromEntries(BOWS.map(([bow]) => [bow, [objId(bow), objId(`unstrung ${bow}`)] as const]));
export const BOW_IDS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(BOW_IDENTITIES).map(([name, [id]]) => [name, id]));
export const ARMOUR_IDS: Readonly<Record<string, number>> = { 'dragonhide body': objId('dragonhide body'), 'dragonhide chap': objId('dragonhide chaps'), 'dragon vambrace': objId('dragon vambraces') };
const bowStockNames = new Map(Object.entries(BOW_IDENTITIES).flatMap(([name, [strung, unstrung]]) => [[strung, name], [unstrung, `unstrung ${name}`]] as [number, string][]));
const ARROWS: readonly (readonly [string, number])[] = ['bronze arrow', 'iron arrow', 'steel arrow', 'mithril arrow', 'adamant arrow', 'rune arrow'].map(arrow => [arrow, ammoTier(arrow)] as const);
// A staff that stands for the fire runes of a cast.
export const FIRE_STAFFS = ['staff of fire', 'fire battlestaff', 'mystic fire staff'] as const;
// Kit items a goal-tier shop job brings (the alchemy supply jobs and the army-arrows jobs). A kit line of these that no market sells
// does not hold back the market buy of the band's other lines: the shop job follows once those are held.
export const SHOP_SUPPLIED: ReadonlySet<string> = new Set(['fire rune', ...FIRE_STAFFS, 'feather', 'water rune', 'body rune', 'dusty key', 'bronze arrow', 'iron arrow', 'steel arrow', 'mithril arrow']);
// ARROW_LOW: the arrows of one kind the Ranged band needs to start. ARROW_STOCK: what a shop run brings the account up to.
export const ARROW_LOW = 100, ARROW_STOCK = 500, LOWE_STOCK = 1000;
// ARROW_LOW rune arrows off the full shelf of the Ranging Guild shop: the base cost of 400 coins, and 1% of it more
// for each arrow bought before (59,800 coins). The buy script reserves six times the base cost for each unit it
// asks for (scripts/shop-buyer.ts maximumUnitCost), so the spend limit adds that for the last arrow.
export const RUNE_ARROW_COST = 59_800, RUNE_ARROW_SPEND = RUNE_ARROW_COST + 2_400;
export const ZAFF_WAIT = 1100;
// What the alchemy supply jobs bring an account up to: feathers for every cast to 99, fire runes for Magic 21 to 66.
export const FEATHER_STOCK = 700, FIRE_STOCK = 500;
// What a Magic Guild trip brings an account up to: a nature rune and an air rune for every High Alchemy cast from
// Magic 66 to 99 (553 casts of 1,625 XP).
export const NATURE_STOCK = 600, AIR_STOCK = 600;
// An account short of arrows of every kind: what sends it to an arrow shop. One with ARROW_LOW of any kind is left to
// the Ranged band, or to a kit line when its bow cannot fire them.
const NO_ARROWS: Readonly<Record<string, number>> = Object.fromEntries(ARROWS.map(([arrow]) => [arrow, ARROW_LOW]));
// A bow the account's Ranged level wields, with ARROW_LOW arrows of one kind that bow fires.
export const RANGED_KIT: readonly Needs[] = BOWS.flatMap(([bow, level]) =>
    ARROWS.filter(([, arrowLevel]) => arrowLevel <= level).map(([arrow]) => ({ skills: { Ranged: level }, items: { [bow]: 1, [arrow]: ARROW_LOW } })));

// AIO routes (scripts/aio.ts <account> <category> <route> [arguments]) as planner options. Each one names its bench
// key; the arguments are those of the bench case with a longer tick cap, unless the line says otherwise. Every one is
// a `pilot`: the bench proves the route on practice from the start state of its case, and a live account starts
// elsewhere with less. Rates are estimates from one bench run (`.practice/aio-bench/baseline-seed7.json`) or the
// live trial named. The requirement of each route is the entry check its worker makes:
// - flax (scripts/gather-flax.ts): none. The worker goes to the field with the shared walker from another floor or a
//   far start (bench case extra:flax-from-ardougne-upstairs). Live trial: one account from the Seers bank, four runs
//   that ended ok, 1,320 flax banked in 7,317 ticks (0.18 a tick), lowest Hitpoints 46. The bench preset is a bare
//   account in the field: 364 flax in 1,524 ticks. Gap: one account in the field; two at once are not run. Gap: an
//   account with 10 Hitpoints got no route to the field (`no flax progress: no route`, 357 ticks); the template
//   asks no Hitpoints.
// - bow strings (scripts/spin-bowstrings.ts): Crafting 10 (`flax requires Crafting 10`); it ends ok only with
//   MAX_MAKE made, so it needs that much flax banked at Seers. Bench: Crafting 13, 56 made in 457 ticks. Live
//   trial: two accounts made 56 and then sent no logout (`ACTION_SETTLEMENT_DEFERRED`, `RESULT fail no result`,
//   then `fleet account claim held by swarm`); the worker's own session owner refused the logout step.
// - yew logs (scripts/gather-yews.ts): Woodcutting 60 for a yew, and an axe. Bench: Woodcutting 99 with a rune axe,
//   37 logs in 1,023 ticks; the rate here is half of that. BANK_AT is the worker's default 27, not the bench's 200.
//   Gap: no live run.
// - arrow shafts (scripts/fletch-arrows.ts, MODE=shafts): a knife and MAX_MAKE logs. Bench: a bare account at the
//   Draynor bank, one log in 15 ticks. Gap: a start away from a bank is not run. Live trial: one account away from
//   a bank ended at tick 0 with `shafts bank unavailable`; the template does not take the account to a bank.
// - ore (scripts/gather-ore.ts mixedOreCombatProblem): combat 13 (rats at the Varrock East mine hunt below it) and a
//   pickaxe. Live trial: 75 ores banked in 1,169 ticks at combat 13 (scripts/fleet.ts, OreElse). Bench: Mining 50.
//   Live trial through the AIO route: two accounts ended `no ore progress: bounded safety retreat failed`, and one
//   of them then timed out at logout. Gap: the cause of the retreat is not read.
// - rune essence (scripts/gather-essence.ts): Rune Mysteries complete (Aubury refuses the teleport without it) and a
//   pickaxe. Bench: a bare account with the quest done, 6 essence in 189 ticks.
// - air runes (scripts/rune-bank-craft.ts): an air talisman and banked essence. Bench: Runecraft 1, 30 essence
//   crafted in 324 ticks. Live trial: an account with Runecraft 99 ended `RESULT ok runecraft=99 trips=0 consumed=0
//   crafted=0`: the argument 99 is a target level, so the worker makes nothing at 99 and reports ok.
// - Rune Mysteries (scripts/quest-sweep.ts with scripts/generated/quest-runemysteries.ts): the sweep takes the
//   preset's pack from the bank and ends `missing id:count` without it: 2 law, 6 air, 1 fire and 1 earth rune and 4
//   meals. The quest has no fight and no level check, and walks where a teleport fails. Gap: the bench runs the sweep
//   on Cook's Assistant, and this quest script from a preset with every skill 99; the two together are not run.
// - runite bars (scripts/smelt-bars.ts runite): Smithing 85, one runite ore and 8 coal a bar, banked at Al Kharid.
//   The bench case smelts iron; practice with Smithing 99 at the Al Kharid bank: 12 bars in 198 ticks
//   (research/combat-measure.md, rune scimitars).
// - rune scimitars (scripts/smelt-bars.ts, the anvil order): Smithing 90, a hammer, 2 runite bars a blade and 10
//   coins for the Al Kharid toll gate; it stages to the Varrock West anvils. The bench case smiths a bronze dagger;
//   practice: 6 blades in 463 ticks, 337 of them the walk from Al Kharid. The PK army's fight loop wants rune weapons
//   and the live market has no rune scimitar sellers (docs/plans/joined-plan.md, PK army).
// Makers of route supply lines that are short on the Overall bill (packages/planner/src/supply-bill.ts). The item of
// each `yields` is the bill line's name, which is also the item's name (knowledge/items.json), so unitValue matches
// the line and finds its price.
// - mithril, adamantite and iron bars (scripts/smelt-bars.ts, the route of the runite bars): the Smithing level of
//   the bar (smelting.struct `levelrequired`: iron 15, mithril 50, adamantite 70), which scripts/smelt-batch.ts
//   runSmeltBatch waits for and ends `smelt entry level/state unobserved` without; one ore a bar, with 4 coal for
//   mithril and 6 for adamantite. `needs` asks one pack load: 5 mithril bars, 4 adamantite bars, 28 iron ore. Iron:
//   the bench case itself, Smithing 50 at the Al Kharid furnace, 28 bars in 377 ticks; half the ore is lost
//   (smelting.rs2), and a pack with 2 coal at Smithing 30 ends `iron entry requires coal banked`. Mithril and
//   adamantite: estimates from the runite run above (3 bars a load, about 50 ticks a load), as the furnace takes the
//   same time for each bar. Gap: no practice run smelts mithril or adamantite, and a start away from the Al Kharid
//   bank is not run.
// - steel bars (scripts/smelt-bars.ts steel, the same route): Smithing 30, one iron ore and 2 coal a bar
//   (smelting.struct smelting_steel_bar), so a pack load is 9 bars and `needs` asks 9 iron ore and 18 coal. No bill
//   line names the bar: it has the value of the cannonball line while that line is short (FEEDS). Bench case
//   extra:smelt-steel: Smithing 30 at the Al Kharid bank with 28 iron ore and 56 coal banked, 28 bars banked in 279
//   ticks, four loads. The rate is that run's, 0.1 bars a tick: an estimate, as one run on practice. Gap: a start
//   away from the Al Kharid bank is not run, and no job brings the coal (aio-ore mines iron ore at Varrock East).
// - cannonballs (scripts/microbot-a-cannonballs.ts): a members world and Smithing 35 (smelt-batch.ts cannonAdmission:
//   `cannonballs need observed member and current Smithing35`), an ammo mould held or banked (`smelt owned reusable
//   tool missing`) and CANNON_BARS steel bars banked: the order is exact, so a run with fewer bars fails. One bar
//   makes 4 balls. CANNON_XP_RATE is the XP rate of the server (a dragon bone gives 1,800 Prayer XP, BOUGHT_BONE_XP);
//   the worker ends on an XP gain that differs. Bench: Smithing 35 at the Al Kharid bank, 1 bar in 47 ticks. The rate
//   is an estimate: 27 bars at about 8 ticks a bar (cannonballs.rs2) and the bench's 39 ticks of bank and walk give
//   0.42 balls a tick, and the rate here is half of that. Gap: a run of more than 3 bars is not measured
//   (research/microbot-ports.md: 3 bars to 12 banked balls).
//   The ammo mould: Dwarf Cannon leaves the account with none. Nulodion gives one with his notes
//   (quest_mcannon/scripts/npcs/nulodion.rs2:22-23) and the Dwarf Commander takes both at the end (lawgof2.rs2:201-202;
//   scripts/generated/dwarfcannon.ts:361-368). With the quest complete, Nulodion's Trade option (nulodion.rs2:1-6) opens
//   his shop, which stocks 5 moulds at a shop value of 5 coins (area_falador/configs/dwarven_workshop.inv:14,
//   quest_mcannon.obj:62); his cannon for 750,000 coins comes with one too (nulodion.rs2:148-157). The mould is not
//   tradeable (quest_mcannon.obj:65), so no fleet order moves it: the account that casts does the quest and buys its
//   own. Gap: no template runs Dwarf Cannon and no job buys the mould. The quest script starts from the preset
//   quest_dwarfcannon, beside the commander with the levels of the main account, and Nulodion stands behind a quest
//   door that no planned walk opens (dwarfcannon.ts:358-360).
// - blood runes (scripts/blood-chest.ts): Thieving 59 and a start on the ground floor (bloodRefusal); it travels to
//   the Ardougne north bank from any such start. Each of the two chests gives 2 blood runes and 500 coins and comes back in
//   400 ticks at most (RESPAWN_TICKS). A run ends ok only with MAX_LOOTS loots. The ogres by the chests hit: under 60%
//   of its Hitpoints the account leaves, eats banked food of BLOOD_FOOD (the worker's BANK_FOOD) and ends `stop=hp`
//   with none, so `needs` asks BLOOD_MEALS pieces (an estimate: the worker's note gives 12 of 47 Hitpoints a trip).
//   Bench: Thieving 99 and Hitpoints 56 by the tower, 2 loots in 165 ticks. The rate is an estimate from the respawn
//   time: 4 runes and 1,000 coins in 400 ticks. Live trial: one account from the Draynor bank, three runs that
//   ended ok, 6 loots each, 36 blood runes and 9,000 coins banked in 3,739 ticks (0.0096 runes a tick), lowest
//   Hitpoints 23. Gap: another player at the chests takes loots from the run.
// - unfinished potions (scripts/microbot-production.ts, recipe `brew:unf_<herb>_potion`): a members world (MEMBERS=1;
//   `production recipe requires confirmed members world`), the Herblore level of the potion (brew_potion.struct
//   `brew_potion_level`; `production level missing`), and the clean herb and a vial of water in the bank. The worker
//   stands at a bank and opens it for each unit: it takes one of each input, makes the unit and banks it. With
//   ORDER_MODE=best-effort MAX_MAKE is a limit: the run ends ok when the bank has no more inputs after one unit or
//   more. The item of `yields` is the bill line (`torstol potion (unf)`); every such item is named "Unfinished
//   potion", so priceTable gives the line its price. Bench case skiller:crafting:inventory: the recipe
//   cut-dragonstone, 180 gems in 941 ticks, 0.19 a tick. The rate here is half of that: an estimate, as a brew takes
//   two items from the bank for each unit. Gap: no practice run brews an unfinished potion with this worker, a start
//   away from a bank is not run (`production bank unavailable`), and no job brings the herbs.
// - unicorn horn dust and dragon scale dust (the same worker, recipes `grind:unicorn_horn` and
//   `grind:blue_dragon_scale`): a members world, a pestle and mortar and the horn or the scale in the bank. Evidence,
//   rate and gaps as for the unfinished potions. No job brings the horns or the scales.
// - rune axe (scripts/smelt-bars.ts, the anvil order of the rune scimitars with PRODUCT_ID=1359): Smithing 86 and one
//   runite bar (scripts/smith-batch.ts smithRecipe reads both from smithing.dbrow), a hammer and the 10 coins of the
//   toll gate. One axe: the job does not repeat, and an account that holds a rune axe takes no run. The rate is that
//   of the rune scimitar.
// - sapphire, emerald, ruby and diamond rings (scripts/microbot-jewellery-trip.ts with the order in its environment):
//   the Crafting level of the ring (jewellery.struct `levelrequired`: 20, 27, 34, 43), a ring mould, and RING_BATCH
//   gold bars and RING_BATCH cut gems. The order is exact: with fewer bars the run fails, and with fewer cut gems the
//   worker cuts uncut ones (planJewelleryOrder), which are lines of the bill themselves, so `needs` asks the cut
//   gems. The worker starts at the Al Kharid bank (`jewellery fresh bank position/budget absent` from another start).
//   Bench case skiller:crafting:jewellery-trip: 1 gold ring in 56 ticks, bank to furnace and back. The rate is an
//   estimate: 13 rings a trip at about 5 ticks a ring after the first (runJewellery: one furnace use, one menu click
//   and one wait for each ring) give 0.11 a tick, and the rate here is half of that. Gap: no practice run makes a gem
//   ring or more than one ring, and no job brings the gold bars or the gems.
const PICKAXES = ['bronze pickaxe', 'iron pickaxe', 'steel pickaxe', 'mithril pickaxe', 'adamant pickaxe', 'rune pickaxe'] as const;
const AXES = ['bronze axe', 'iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe'] as const;
// scripts/quest-sweep.ts MEALS, by item name (scripts/autopilot.test.ts checks the two agree).
export const SWEEP_MEALS = ['shark', 'swordfish', 'lobster', 'bass', 'tuna', 'trout', 'salmon', 'cake', '2/3 cake', 'slice of cake', 'bread'] as const;
export const BOWSTRING_BATCH = 56, SHAFT_LOGS = 25;
// One pack of steel bars beside the ammo mould, the loots of one blood chest run, and the food that run asks.
export const CANNON_BARS = 27, BLOOD_LOOTS = 6, BLOOD_MEALS = 5;
// scripts/blood-chest.ts BANK_FOOD, by item name (scripts/autopilot.test.ts checks the two agree).
export const BLOOD_FOOD = ['shark', 'swordfish', 'lobster', 'tuna', 'salmon', 'trout', 'cake'] as const;
// The most units one run at the bank makes (scripts/microbot-production.ts MAX_MAKE), and the rings of one furnace
// trip: 13 gold bars and 13 gems fit beside the mould.
export const MAKE_BATCH = 100, RING_BATCH = 13, STEW_BATCH = 3;
// The unfinished potions of the route bill: the herb of the bill line (`<herb> potion (unf)`), the item the bank
// holds, and the Herblore level (brew_potion.struct; scripts/autopilot.test.ts checks each against the worker's recipe).
export const UNF_POTIONS: readonly (readonly [herb: string, item: string, level: number])[] = [
    ['guam', 'guam leaf', 3], ['marrentill', 'marrentill', 5], ['tarromin', 'tarromin', 12], ['harralander', 'harralander', 22], ['ranarr', 'ranarr weed', 30],
    ['toadflax', 'toadflax', 34], ['irit', 'irit leaf', 45], ['avantoe', 'avantoe', 50], ['kwuarm', 'kwuarm', 55], ['snapdragon', 'snapdragon', 63],
    ['cadantine', 'cadantine', 66], ['lantadyme', 'lantadyme', 69], ['dwarf weed', 'dwarf weed', 72], ['torstol', 'torstol', 78]];
// The gem rings of the route bill: the gem and the Crafting level (jewellery.struct).
export const GEM_RINGS: readonly (readonly [gem: string, level: number])[] = [['sapphire', 20], ['emerald', 27], ['ruby', 34], ['diamond', 43]];
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
// One sweep job for each quest of QUEST_DEMAND_ROWS, run through the AIO route `quester:quest:<slug>`.
export function questDemand(): Template[] {
    return QUEST_DEMAND_ROWS.map((q, i): Template => ({
        id: `quest-${q.slug}`, family: `aio:quester:quest:${q.slug}`, script: 'scripts/aio.ts', args: ['quester', 'sweep', q.slug], aio: `quester:quest:${q.slug}`,
        worker: 'scripts/quest-sweep.ts', pilot: true, once: true, role: 'quest', goal: `complete ${q.name} once for the quest board`, tier: 'goal',
        ...(q.wilderness ? { wilderness: true as const } : {}),
        band: QUEST_DEMAND_BAND + i / 100, quest: { name: q.name, unlocks: [] }, resources: [questResource(q.slug), QUEST_DEMAND], yields: () => [],
        needs: { ...(Object.keys(q.skills).length ? { skills: q.skills } : {}), ...(q.quests.length ? { quests: q.quests } : {}), ...(q.questPoints ? { questPoints: q.questPoints } : {}),
            ...(Object.keys(q.items).length ? { items: q.items } : {}), ...(q.meals ? { pieces: { of: SWEEP_MEALS, count: q.meals } } : {}) },
        kitFirst: true,
    }));
}

export function aioTemplates(): Template[] {
    const aio = (id: string, key: string, worker: string, args: string[], rest: Omit<Template, 'id' | 'family' | 'script' | 'args' | 'aio' | 'worker' | 'pilot'>): Template =>
        ({ id, family: `aio:${key}`, script: 'scripts/aio.ts', args: [key.split(':')[0]!, ...args], aio: key, worker, pilot: true, ...rest });
    const essence = aio('aio-essence', 'skiller:mining:essence', 'scripts/gather-essence.ts', ['mining', 'essence', 'CAP=1800', 'BANK_AT=28'], {
        role: 'mining', goal: 'mine rune essence through Aubury and bank it at Varrock East', resources: [AIO_PLACES.essence],
        needs: { quests: ['Rune Mysteries Quest'], pieces: { of: PICKAXES, count: 1 } }, yields: () => [{ item: 'rune essence', perTick: 0.03 }] });
    // `load`: the bars of one pack load, which `needs` asks the ore and the coal for.
    const bars = (bar: string, level: number, ore: string, coal: number, load: number, perTick: number) =>
        aio(`aio-${bar}-bars`, 'skiller:smithing:smelt', 'scripts/smelt-bars.ts', ['smithing', 'smelt', '1500', bar, 'MAX_MAKE=28', 'ORE_RESERVE=0'], {
            role: 'smithing', goal: `smelt banked ${ore}${coal ? ' and coal' : ''} into ${bar} bars at Al Kharid`,
            repeats:false,production:{output:`${bar} bar`,outputPerUnit:1,maximum:28,inputs:{[ore]:1,...coal?{coal}:{}},
                resize:n=>({args:['skiller','smithing','smelt','1500',bar,`MAX_MAKE=${n}`,'ORE_RESERVE=0']})},
            needs: { skills: { Smithing: level }, items: { [ore]: load, ...(coal ? { coal: coal * load } : {}) } }, yields: () => [{ item: `${bar} bar`, perTick }] });
    // One recipe of the bank-standing worker, up to MAKE_BATCH units of what the bank holds.
    const make = (id: string, recipe: string, goal: string, role: string, needs: Needs, item: string,consumed:Record<string,number>=needs.items??{}) =>
        aio(id, 'skiller:crafting:inventory', 'scripts/microbot-production.ts', ['crafting', 'inventory', recipe, `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], {
            role, goal, needs,repeats:false,production:{output:item,outputPerUnit:1,maximum:MAKE_BATCH,inputs:consumed,
                resize:n=>({args:['skiller','crafting','inventory',recipe,`MAX_MAKE=${n}`,'CAP=1500','MEMBERS=1','ORDER_MODE=best-effort']})}, yields: () => [{ item, perTick: 0.1 }] });
    const potions = UNF_POTIONS.map(([herb, item, level]) => make(`aio-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`,
        `mix banked ${item} and vials of water into unfinished ${herb} potions`, 'herblore', { skills: { Herblore: level }, items: { [item]: 1, 'vial of water': 1 } }, `${herb} potion (unf)`));
    const dust = (id: string, raw: string, item: string) => make(id, `grind:${raw.replace(/ /g, '_')}`, `grind banked ${raw}s into ${item}`, 'herblore', { items: { 'pestle and mortar': 1, [raw]: 1 } }, item,{[raw]:1});
    const rings = GEM_RINGS.map(([gem, level]) => aio(`aio-${gem}-rings`, 'skiller:crafting:jewellery-trip', 'scripts/microbot-jewellery-trip.ts',
        ['crafting', 'jewellery-trip', `RECIPE=${gem}_ring`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], {
            role: 'crafting', goal: `make ${RING_BATCH} ${gem} rings from banked gold bars and gems at the Al Kharid furnace`,
            repeats:false,production:{output:`${gem} ring`,outputPerUnit:1,maximum:RING_BATCH,inputs:{'gold bar':1,[gem]:1},
                resize:n=>({args:['skiller','crafting','jewellery-trip',`RECIPE=${gem}_ring`,`TARGET=${n}`,`BATCH=${n}`,'CAP=1500']})},
            needs: { skills: { Crafting: level }, items: { 'ring mould': 1, 'gold bar': RING_BATCH, [gem]: RING_BATCH } },
            yields: () => [{ item: `${gem} ring`, perTick: 0.05 }] }));
    return [
        aio('aio-flax', 'skiller:foraging:flax', 'scripts/gather-flax.ts', ['foraging', 'flax', '1800', '28'], {
            role: 'crafting', goal: 'pick flax at Seers and bank it', resources: [AIO_PLACES.flax], yields: () => [{ item: 'flax', perTick: 0.18 }] }),
        aio('aio-bowstrings', 'skiller:crafting:bowstrings', 'scripts/spin-bowstrings.ts', ['crafting', 'bowstrings', '1250', `MAX_MAKE=${BOWSTRING_BATCH}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'], {
            role: 'crafting', goal: `spin ${BOWSTRING_BATCH} banked flax into bow strings at Seers`, needs: { skills: { Crafting: 10 }, items: { flax: BOWSTRING_BATCH } },
            repeats:false,production:{output:'bow string',outputPerUnit:1,maximum:BOWSTRING_BATCH,inputs:{flax:1},resize:n=>({args:['skiller','crafting','bowstrings','1250',`MAX_MAKE=${n}`,'RAW_RESERVE=0','MAX_TRIPS=4']})},
            yields: () => [{ item: 'bow string', perTick: 0.12 }] }),
        aio('aio-yews', 'skiller:woodcutting:yews', 'scripts/gather-yews.ts', ['woodcutting', 'yews', '1800', '27', 'MAX_TRIPS=4'], {
            role: 'woodcutting', goal: 'cut yew logs at Seers and bank them', resources: [AIO_PLACES.yews],
            needs: { skills: { Woodcutting: 60 }, pieces: { of: AXES, count: 1 } }, yields: () => [{ item: 'yew logs', perTick: 0.018 }] }),
        aio('aio-shafts', 'skiller:fletching:shafts', 'scripts/fletch-arrows.ts', ['fletching', 'shafts', '600', `MAX_MAKE=${SHAFT_LOGS}`, 'LOG_RESERVE=0'], {
            role: 'fletching', goal: `cut ${SHAFT_LOGS} banked logs into arrow shafts`, needs: { items: { knife: 1, logs: SHAFT_LOGS } },
            repeats:false,production:{output:'arrow shaft',outputPerUnit:15,maximum:SHAFT_LOGS,inputs:{logs:1},resize:n=>({args:['skiller','fletching','shafts','600',`MAX_MAKE=${n}`,'LOG_RESERVE=0']})},
            yields: () => [{ item: 'arrow shaft', perTick: 1 }] }),
        aio('aio-ore', 'skiller:mining:ore', 'scripts/gather-ore.ts', ['mining', 'ore', '1800', '25', 'MAX_TRIPS=3'], {
            role: 'mining', goal: 'mine ore at Varrock East and bank three loads', resources: [AIO_PLACES.ore],
            needs: { combat: 13, pieces: { of: PICKAXES, count: 1 } },
            // Iron from Mining 15; copper and tin before it.
            yields: a => (a.skills.Mining ?? 1) >= 15 ? [{ item: 'iron ore', perTick: 0.064 }] : [{ item: 'copper ore', perTick: 0.032 }, { item: 'tin ore', perTick: 0.032 }] }),
        essence,
        aio('aio-air-runes', 'skiller:runecraft:bank-craft', 'scripts/rune-bank-craft.ts', ['runecraft', 'bank-craft', '99', 'RUNE_ALTAR=air', 'ESSENCE_TARGET=28', 'CAP=4000'], {
            role: 'magic', goal: 'craft 28 banked rune essence into air runes', resources: [AIO_PLACES.air],
            needs: { items: { 'air talisman': 1, 'rune essence': 28 } }, yields: () => [{ item: 'air rune', perTick: 0.09 }] }),
        bars('runite', 85, 'runite ore', 8, 2, 0.06),
        bars('adamantite', 70, 'adamantite ore', 6, 4, 0.07),
        bars('mithril', 50, 'mithril ore', 4, 5, 0.08),
        bars('iron', 15, 'iron ore', 0, 28, 0.074),
        bars('steel', 30, 'iron ore', 2, 9, 0.1),
        aio('aio-cannonballs', 'skiller:smithing:cannonballs', 'scripts/microbot-a-cannonballs.ts', ['smithing', 'cannonballs', String(CANNON_BARS), '1500', 'CANNON_XP_RATE=25'], {
            role: 'smithing', goal: `cast ${CANNON_BARS} banked steel bars into cannonballs at Al Kharid`,
            repeats:false,production:{output:'cannonball',outputPerUnit:4,maximum:CANNON_BARS,inputs:{'steel bar':1},resize:n=>({args:['skiller','smithing','cannonballs',String(n),'1500','CANNON_XP_RATE=25']})},
            needs: { skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } }, yields: () => [{ item: 'cannonball', perTick: 0.2 }] }),
        aio('aio-rune-scimitars', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune scimitar from two banked runite bars at the Varrock West anvils',
            repeats:false,production:{output:'rune scimitar',outputPerUnit:1,maximum:1,inputs:{'runite bar':2},resize:()=>({args:['skiller','smithing','anvil','1500','PRODUCT_ID=1333','MAX_MAKE=1','BAR_RESERVE=0']})},
            needs: { skills: { Smithing: 90 }, items: { hammer: 1, 'runite bar': 2, coins: 10 } }, yields: () => [{ item: 'rune scimitar', perTick: 0.003 }] }),
        aio('aio-rune-axe', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1359', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune axe from a banked runite bar at the Varrock West anvils',
            repeats: false,production:{output:'rune axe',outputPerUnit:1,maximum:1,inputs:{'runite bar':1},resize:()=>({args:['skiller','smithing','anvil','1500','PRODUCT_ID=1359','MAX_MAKE=1','BAR_RESERVE=0']})},
            needs: { skills: { Smithing: 86 }, items: { hammer: 1, 'runite bar': 1, coins: 10 }, holdsUnder: { 'rune axe': 1 } }, yields: () => [{ item: 'rune axe', perTick: 0.003 }] }),
        ...potions,
        dust('aio-unicorn-horn-dust', 'unicorn horn', 'unicorn horn dust'),
        dust('aio-dragon-scale-dust', 'blue dragon scale', 'dragon scale dust'),
        ...rings,
        aio('aio-blood-chest', 'skiller:thieving:blood-chest', 'scripts/blood-chest.ts', ['thieving', 'blood-chest', '4000', `MAX_LOOTS=${BLOOD_LOOTS}`, 'CAP=4000'], {
            role: 'thieving', goal: `loot the Ardougne blood rune chests ${BLOOD_LOOTS} times and bank the runes`, resources: [AIO_PLACES.blood],
            needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
            yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }] }),
        aio('aio-quest-runemysteries', 'quester:mode:sweep', 'scripts/quest-sweep.ts', ['sweep', 'runemysteries'], {
            role: 'quest', goal: 'complete Rune Mysteries for the essence mine', quest: { name: 'Rune Mysteries Quest', unlocks: [essence.id] },
            needs: { items: { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1 }, pieces: { of: SWEEP_MEALS, count: 4 } }, yields: () => [] }),
    ];
}

// Makers of a bill line that take two recipes of the bank-standing worker in a row, as one swarm job
// (scripts/chain.ts). Each step is the AIO route skiller:crafting:inventory with ORDER_MODE=best-effort, so the
// evidence, the rate and the gaps are those of the unfinished potions (aioTemplates). A chain ends at its first
// failed step. Pilots.
// - yew shortbow: Fletching 65 for the cut and for the string (cut_logs.dbrow, bows.dbrow), a knife, a yew log and a
//   bow string in the bank. One bow: the job does not repeat. The unstrung bow has the name of the strung one, so the
//   bill and `holdsUnder` count both: an account that holds either takes no run. Bench case skiller:fletching:worker
//   cuts a shortbow from normal logs with the same worker. The rate is an estimate: one bow for two logins, taken as
//   100 ticks. Gap: no practice run strings a bow in this chain.
// - uncooked stew: Cooking 25 (stew.rs2), and a potato, a bowl of water and a cooked meat in the bank for each stew:
//   the potato goes in first, then the meat. One run makes up to STEW_BATCH useful stews, bounded by complete owned
//   recipes; both steps receive that count. The rate is half that of one recipe, as a stew takes two. Gaps: no
//   practice run makes this chain, and no template finishes an incomplete stew left by a failed second step.
// Supply jobs for the gang squad's lines that no template filled (packages/planner/src/squad.ts). Each is a finite shop
// run of scripts/shop-buyer.ts for one item: the run buys up to the stock the squad rows still lack (STOCK_TARGET is the
// supplier's holding plus that demand, STOP_AT_TARGET ends the run there) and spends at most twice the shop cost of it
// (MAX_SPEND, with FLOAT and COIN_RESERVE). A template is `squadOnly`: it is a candidate only while the plan's squad is
// active, so a plan with no squad block never values it. Lines that already have a template: earth and air runes
// (shop-runes). Food is sharks (squad-sharks) and arrows are rune arrows (squad-rune-arrows, squad-arrows-dargaud). Antipoison(3): the shop run is a
// fallback with a small cap, and a maker (Herblore) takes the line by yielding `antipoison(3)`.
export const SQUAD_RUN_MAX: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'water rune': 1500, 'earth rune': 1500, 'air rune': 1500, 'fire rune': 1500,
    'nature rune': 1000, 'law rune': 200, 'blood rune': 200, 'death rune': 500, 'chaos rune': 1000, 'mind rune': 1000,
    'antipoison(3)': 12, 'cooked karambwan': 50, 'raw karambwan': 50, 'climbing boot': 10, 'dragon dagger': 2,
    'cape of legend': 2, 'shield right half': 1, 'dragon battleaxe': 2, 'dragon mace': 2,
    'berserker helm': 2, 'rune platebody': 2, 'rune plateleg': 4, 'black full helm': 2, 'black platebody': 2, 'black plateleg': 2,
    'uncut sapphire': 28, 'uncut emerald': 28, 'eye of newt': 100, 'vial of water': 100,
    'waterskin(4)': 8, 'bronze bar': 20, 'chocolate bar': 28, cake: 28, 'priest gown': 4, 'leather glove': 4,
    'fishing bait': 500, papyrus: 20, 'ball of wool': 20, charcoal: 20,
};
// The shop cost of one unit (knowledge/items.json), the fallback of a run's spend cap: the rows are priced from the plan's
// price table (`prices`, from priceTable) when it holds the item.
export const SQUAD_UNIT_COST: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'rune arrow(p)': 420, 'rune arrowtips': 200, shark: 300, 'cooked karambwan': 320, 'raw karambwan': 240,
    'water rune': 4, 'earth rune': 4, 'air rune': 4, 'fire rune': 4, 'nature rune': 20, 'law rune': 40,
    'cosmic rune': 50, 'blood rune': 550, 'death rune': 180, 'chaos rune': 90, 'mind rune': 4,
    'antipoison(3)': 288, 'prayer potion(3)': 500, 'prayer potion(4)': 667,
    'super attack(3)': 400, 'super attack(4)': 533, 'super strength(3)': 500, 'super strength(4)': 667,
    'super defence(3)': 600, 'super defence(4)': 800, 'ranging potion(3)': 650, 'ranging potion(4)': 867,
    'super restore(3)': 240, 'super restore(4)': 320, 'magic potion(3)': 250, 'magic potion(4)': 333,
    'zamorak potion(3)': 25, 'zamorak potion(4)': 33, 'restore potion(3)': 80, 'restore potion(4)': 107,
    'superantipoison(3)': 400, 'superantipoison(4)': 533,
    'super energy(3)': 230, 'super energy(4)': 300, 'agility potion(3)': 150, 'agility potion(4)': 200,
    'ring of recoil': 300, 'emerald ring': 1275, 'ring of dueling(8)': 1275,
    'dragonstone': 10_000, 'uncut dragonstone': 10_000, 'dragonstone ring': 17_625, 'dragon necklace': 18_375,
    'unstrung dragonstone amulet': 17_625, 'strung dragonstone amulet': 17_625, 'amulet of glory': 17_625, 'amulet of glory(4)': 25_000, 'ring of wealth': 17_625,
    'climbing boot': 12, 'cape of legend': 675, 'dragon dagger': 30_000, 'dragon dagger(p)': 32_000,
    'dragon battleaxe': 200_000, 'dragon mace': 50_000, 'shield right half': 750_000, 'crystal key': 1, keyhalf1: 1, keyhalf2: 1,
    'dragon chainbody': 250_000, 'dragon sq shield': 1_250_000, 'dragon plateleg': 270_000,
    'magic shortbow': 1600, 'berserker helm': 78_000, 'rune full helm': 35_200, 'rune platebody': 84_500, 'rune plateleg': 64_000, 'rune kiteshield': 54_400,
    'black full helm': 1056, 'black platebody': 3840, 'black plateleg': 1920,
    black_dragonhide_body: 13_480, black_dragonhide_chaps: 6_500, black_dragon_vambraces: 4_200,
    'uncut sapphire': 250, 'uncut emerald': 500, emerald: 500, 'eye of newt': 3, 'vial of water': 5,
    'waterskin(4)': 30, 'bronze bar': 16, nail: 3, plank: 1, 'swamp toad': 2, "toad's leg": 2,
    'chocolate bar': 10, 'chocolate dust': 2, cake: 50, 'chocolate cake': 70,
    'priest gown': 5, 'leather glove': 6, 'fishing bait': 3, papyrus: 10, 'ball of wool': 2, charcoal: 45,
};
// The essence of one water-rune craft run, as aio-air-runes (ESSENCE_TARGET=28).
export const SQUAD_CRAFT_ESSENCE = 28;
// The 15-arrow sets of one rune-arrow run, and the sharks of one shark run (the default count of scripts/shark-supply.ts).
export const SQUAD_RUNE_SETS = 20, SQUAD_SHARK_RUN = 25;
export function squadSupplies(): Template[] {
    const shop = (id: string, profile: string, item: string, items: string, perTick: number, goal: string, needs: Needs): Template => {
        const cost = SQUAD_UNIT_COST[item]!, max = SQUAD_RUN_MAX[item]!;
        const sized = (units: number, held = 0) => {
            const spend = Math.ceil(units * cost * 2);
            return { args: [profile, '1200'], env: { ITEMS: items, STOCK_TARGET: String(held + units), STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '25', FLOAT: String(spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(spend) } };
        };
        return { id, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', ...sized(max), role: 'bank', goal, resources: [`shop:${profile}`], needs, squadOnly: true,
            yields: () => [{ item, perTick }], spends: () => [{ item: 'coins', perTick: perTick * cost }], repeats: false,
            production: { output: item, outputPerUnit: 1, maximum: max, inputs: {}, resize: sized } };
    };
    const invMake = (
        id: string, recipe: string, item: string, level: number,
        inputs: Readonly<Record<string, number>>, tools: Readonly<Record<string, number>>,
        perTick = 0.1, goal = `make ${item} at the bank for the gang squad`, max = MAKE_BATCH,
        opts: { skill?: string; role?: string; members?: 0 | 1; strictOutput?: true; ownSupply?: readonly string[] } = {},
    ): Template => {
        const argsFor = (n: number) => [recipe, `MAX_MAKE=${n}`, 'CAP=1500', `MEMBERS=${opts.members ?? 1}`, 'ORDER_MODE=best-effort'];
        const skill = opts.skill ?? 'Herblore', role = opts.role ?? 'herblore';
        return {
            id, family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts', args: argsFor(max), role,
            goal, resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
            ...(opts.ownSupply ? { ownSupply: opts.ownSupply } : {}),
            needs: { skills: { [skill]: level }, items: { ...inputs, ...tools } },
            production: { output: item, outputPerUnit: 1, maximum: max, inputs, ...(opts.strictOutput ? { strictOutput: true as const } : {}), resize: n => ({ args: argsFor(n) }) },
            yields: () => [{ item, perTick }],
        };
    };
    const bankJobArg = (job: Record<string, unknown>) => ['bank-job', `--job=${encodeURIComponent(JSON.stringify(job))}`];
    const smithAnvil = (id: string, productId: number, item: string, level: number, bars: number, outputPerUnit = 1, max = Math.max(1, Math.floor(27 / bars)), barName = 'runite bar'): Template => {
        const argsFor = (n: number) => ['skiller', 'smithing', 'anvil', '1500', 'ORDER_ACTION=smith', `PRODUCT_ID=${productId}`, `MAX_MAKE=${n}`, 'BAR_RESERVE=0'];
        return {
            id, family: 'aio:skiller:smithing:anvil', script: 'scripts/aio.ts', args: argsFor(max), role: 'smithing',
            goal: `smith ${item} from banked ${barName}s at Varrock West for supply demand`, resources: ['squad:varrock-smithing'], squadOnly: true, repeats: false,
            needs: { skills: { Smithing: level }, items: { hammer: 1, [barName]: bars, coins: 10 } },
            production: { output: item, outputPerUnit, maximum: max, inputs: { [barName]: bars }, resize: n => ({ args: argsFor(n) }) },
            yields: () => [{ item, perTick: 0.005 * outputPerUnit }],
        };
    };
    // Water runes crafted from banked rune essence at the water altar (scripts/rune-bank-craft.ts RUNE_ALTAR=water, bench case
    // extra:water-supply): one rune for each essence under Runecraft 19. The talisman is held for good; the essence comes from
    // the fleet's stock through the planner's item orders. The bench case makes 10 runes in 399 to 403 ticks from the Draynor
    // bank (hosted run 44464164017, seeds 1 to 3); the rate below is an estimate for a 28-essence run.
    const waterCraft: Template = { id: 'squad-water-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into water runes at the water altar for the gang squad', resources: ['aio:water-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 5 }, items: { 'water talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'water rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'water rune', perTick: 0.08 }] };
    const earthCraft: Template = { id: 'squad-earth-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into earth runes at the earth altar for the gang squad', resources: ['squad:varrock-earth-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 9 }, items: { 'earth talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'earth rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'earth rune', perTick: 0.08 }] };
    // The water talisman that squad-water-craft needs: wizards at the Wizards' Tower until one drops (3 in 128; scripts/
    // gather-combat.ts TARGET=wizard UNTIL_ITEM, bench case fighter:wizard). No shop sells one and the Grand Exchange holds none.
    const waterTalisman: Template = { id: 'squad-water-talisman', family: 'aio:fighter:wizard', script: 'scripts/aio.ts', aio: 'fighter:wizard',
        worker: 'scripts/gather-combat.ts', args: ['fighter', 'wizard', '10000', 'wizard', 'MAX_KILLS=200', 'UNTIL_ITEM=water talisman'],
        role: 'combat', goal: "kill wizards at the Wizards' Tower until a water talisman drops, for the gang squad's water runes", resources: ['fighter:wizards-tower'], squadOnly: true,
        needs: { combat: 40, holdsUnder: { 'water talisman': 1 } }, repeats: false, yields: () => [], provides: { item: 'water talisman', unlocks: ['squad-water-craft'] } };
    // Rune arrows from the fleet's headless arrows, one chain job: rune arrowtips bought at Hickton's in Catherby (200 coins,
    // half the price of a finished rune arrow), then 15 tips with 15 headless arrows into 15 rune arrows at the Catherby bank
    // (scripts/fletch-arrows.ts MODE=native-arrows TIP_TYPE=rune, arrows.dbrow: Fletching 75). One job, because the planner
    // finds a missing input only in stock and on the market, not from another maker. Bench case extra:fletch-rune-arrows: 30
    // arrows in 14 ticks (hosted run 44470543603); the tip purchase is not in that time.
    const runeSteps = (sets: number) => {
        const tips = sets * 15, spend = tips * SQUAD_UNIT_COST['rune arrowtips']! * 2;
        return [`scripts/shop-buyer.ts catherby 1200 ITEMS=rune.arrowtips STOCK_TARGET=${tips} STOP_AT_TARGET=1 BANK_PACK=1 NO_BUY_TICKS=25 FLOAT=${spend + 200} COIN_RESERVE=200 MAX_SPEND=${spend}`,
            `scripts/fletch-arrows.ts 3000 native-arrows rune MAX_MAKE=${tips} HEADLESS_RESERVE=0 TIP_RESERVE=0`];
    };
    const runeArrows: Template = { id: 'squad-rune-arrows', family: 'fletch', script: 'scripts/chain.ts', args: runeSteps(SQUAD_RUNE_SETS), env: { ROUNDS: '1' },
        role: 'fletching', goal: "buy rune arrowtips at Catherby and fletch them with banked headless arrows into rune arrows for the gang squad",
        resources: ['shop:catherby'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { coins: SQUAD_RUNE_SETS * 15 * SQUAD_UNIT_COST['rune arrowtips']! * 2 + 200, 'headless arrow': SQUAD_RUNE_SETS * 15 } },
        production: { output: 'rune arrow', outputPerUnit: 15, maximum: SQUAD_RUNE_SETS, inputs: { 'headless arrow': 15 }, resize: n => ({ args: runeSteps(n) }) },
        yields: () => [{ item: 'rune arrow', perTick: 1 }], spends: () => [{ item: 'coins', perTick: SQUAD_UNIT_COST['rune arrowtips']! }] };
    const bankedRuneArrowSets = SQUAD_RUNE_SETS * 2;
    const fletchBankedRuneArrows: Template = {
        id: 'squad-fletch-rune-arrows-bank', family: 'fletch', script: 'scripts/fletch-arrows.ts',
        args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(bankedRuneArrowSets * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' },
        role: 'fletching', goal: 'fletch banked rune arrowtips and headless arrows into rune arrows for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { 'headless arrow': 15, 'rune arrowtips': 15 } },
        production: {
            output: 'rune arrow', outputPerUnit: 15, maximum: bankedRuneArrowSets, inputs: { 'headless arrow': 15, 'rune arrowtips': 15 },
            resize: n => ({ args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(n * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' } }),
        },
        yields: () => [{ item: 'rune arrow', perTick: 2 }],
    };
    // Sharks fished and cooked at Catherby (scripts/shark-supply.ts: Fishing 76, Cooking 80; it buys a harpoon when it has none,
    // and it carries two banked trout, salmon or lobsters for the way back). Bench case extra:shark-supply: 3 sharks in 182, 250 and
    // 348 ticks (hosted run 44470543603, seeds 1 to 3); the rate is from those runs.
    const sharkSteps = (n: number) => ({ args: [String(n), '9000'], env: { SHARK_CONSUMER: 'gang squad' } });
    const sharks: Template = { id: 'squad-sharks', family: 'shark-supply', script: 'scripts/shark-supply.ts', ...sharkSteps(SQUAD_SHARK_RUN),
        role: 'fishing', goal: 'fish and cook sharks at Catherby for the gang squad', resources: ['squad:catherby-sharks'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 76, Cooking: 80 }, items: { lobster: 2 } },
        production: { output: 'shark', outputPerUnit: 1, maximum: SQUAD_SHARK_RUN, inputs: {}, resize: n => sharkSteps(n) },
        yields: () => [{ item: 'shark', perTick: 0.01 }] };
    // Karambwanji and karambwan fishing (Shilo Village + Tai Bwo Wannai Trio), plus Catherby karambwan cooking.
    const karambwanjiFish: Template = {
        id: 'squad-karambwanji-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwanji', target: 50, batch: 25, cap: 2000, returnTicks: 300, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2791, z: 3019, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwanji near Tai Bwo Wannai for karambwan bait', resources: ['squad:shilo-karambwan'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 5 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'small fishing net': 1 } },
        yields: () => [{ item: 'raw karambwanji', perTick: 0.05 }],
    };
    const karambwanFish: Template = {
        id: 'squad-karambwan-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: 25, batch: 25, cap: 2500, returnTicks: 300, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3119, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwan north of Tai Bwo Wannai and bank at Shilo Village', resources: ['squad:shilo-karambwan'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 65 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'karambwan vessel': 1, 'raw karambwanji': 75 } },
        production: { output: 'raw karambwan', outputPerUnit: 1, maximum: 25, inputs: { 'raw karambwanji': 3 },
            resize: n => ({ args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: n, batch: Math.min(25, n), cap: 2500, returnTicks: 300, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3119, level: 0 } }) }) },
        yields: () => [{ item: 'raw karambwan', perTick: 0.02 }],
    };
    const karambwanCook: Template = {
        id: 'squad-karambwan-cook', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: 28, batch: 28, cap: 1500, returnTicks: 300, members: true, reserve: 0 }),
        role: 'cooking', goal: 'cook banked raw karambwan at Catherby range for the gang squad', resources: ['squad:catherby-cooking'], squadOnly: true, repeats: false,
        needs: { skills: { Cooking: 30 }, quests: ['Tai Bwo Wannai Trio'], items: { 'raw karambwan': 28 } },
        production: { output: 'cooked karambwan', outputPerUnit: 1, maximum: 28, inputs: { 'raw karambwan': 1 },
            resize: n => ({ args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: n, batch: Math.min(28, n), cap: 1500, returnTicks: 300, members: true, reserve: 0 }) }) },
        yields: () => [{ item: 'cooked karambwan', perTick: 0.15 }],
    };
    // Magic logs and Magic shortbow stringing chain at Seers' Village.
    const magicLogs: Template = {
        id: 'squad-magic-logs', family: 'aio:skiller:woodcutting:yews', script: 'scripts/aio.ts',
        args: ['skiller', 'woodcutting', 'yews', '3000', '27', 'MAX_TRIPS=4', 'TREE=magic', 'WOOD_GROVE=native-processing'],
        role: 'woodcutting', goal: "chop magic logs at Seers' Village for squad magic shortbows", resources: ['squad:seers-magic-trees'], squadOnly: true, repeats: false,
        needs: { skills: { Woodcutting: 75 }, pieces: { of: AXES, count: 1 } },
        yields: () => [{ item: 'magic log', perTick: 0.01 }],
    };
    const bowStep = (recipe: string, n: number) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${n} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`;
    const magicShortbow: Template = {
        id: 'squad-magic-shortbow', family: 'fletch', script: 'scripts/chain.ts',
        args: [bowStep('cut-bow:unstrung_magic_shortbow', 4), bowStep('bow-string:magic_shortbow', 4)], env: { ROUNDS: '1' },
        role: 'fletching', goal: 'cut banked magic logs into magic shortbows and string them for the gang squad', resources: ['squad:seers-fletch'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 80 }, items: { knife: 1, 'magic log': 1, 'bow string': 1 } },
        production: { output: 'magic shortbow', outputPerUnit: 1, maximum: 4, inputs: { 'magic log': 1, 'bow string': 1 },
            resize: n => ({ args: [bowStep('cut-bow:unstrung_magic_shortbow', n), bowStep('bow-string:magic_shortbow', n)] }) },
        yields: () => [{ item: 'magic shortbow', perTick: 0.02 }],
    };
    // Black dragonhide from non-Wilderness Taverley Black Dragons -> tanned and crafted sets at Al Kharid.
    const taverleyBlackDragons: Template = {
        id: 'squad-taverley-black-dragon', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_black_dragon'], env: { MAX_KILLS: '10' }, role: 'combat',
        goal: 'slay Black dragons in Taverley Dungeon (non-Wilderness) for black dragonhide and blood/law runes',
        resources: ['squad:taverley-black-dragons'], squadOnly: true, repeats: false,
        needs: { combat: 85, items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 8 },
        yields: () => [{ item: 'dragonhide_black', perTick: 0.01 }, { item: 'blood rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.02 }],
    };
    const blackDhideSets: Template = {
        id: 'squad-black-dhide-sets', family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/black-dhide-sets.ts',
        args: [], role: 'crafting', goal: 'tan banked black dragonhide at Al Kharid and craft full black dragonhide sets for the gang squad',
        resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP, dragonhide_black: SET_HIDES } },
        yields: () => [{ item: 'black_dragonhide_body', perTick: 0.02 }, { item: 'black_dragonhide_chaps', perTick: 0.02 }, { item: 'black_dragon_vambraces', perTick: 0.02 }],
    };
    // Rings of Recoil: mine gold ore -> smelt gold bars -> cut sapphires -> craft sapphire rings -> enchant lvl 1.
    const goldOre: Template = {
        id: 'squad-gold-ore', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'mining', recipe: 'gold_rock_table', target: 28, batch: 28, cap: 2500, returnTicks: 300, members: true, reserve: 0, bank: { x: 2946, z: 3368, level: 0 }, site: { x: 2977, z: 3233, level: 0 } }),
        role: 'mining', goal: 'mine gold ore at Rimmington and bank at Falador West for sapphire rings', resources: ['squad:rimmington-gold'], squadOnly: true, repeats: false,
        needs: { skills: { Mining: 40 }, pieces: { of: PICKAXES, count: 1 } },
        yields: () => [{ item: 'gold ore', perTick: 0.05 }],
    };
    const goldBars: Template = {
        id: 'squad-gold-bars', family: 'aio:skiller:smithing:smelt', script: 'scripts/aio.ts',
        args: ['skiller', 'smithing', 'smelt', '1500', 'gold', 'MAX_MAKE=28', 'ORE_RESERVE=0'], role: 'smithing',
        goal: 'smelt banked gold ore into gold bars at Al Kharid for sapphire rings', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Smithing: 40 }, items: { 'gold ore': 28 } },
        production: { output: 'gold bar', outputPerUnit: 1, maximum: 28, inputs: { 'gold ore': 1 },
            resize: n => ({ args: ['skiller', 'smithing', 'smelt', '1500', 'gold', `MAX_MAKE=${n}`, 'ORE_RESERVE=0'] }) },
        yields: () => [{ item: 'gold bar', perTick: 0.08 }],
    };
    const cutSapphire: Template = {
        id: 'squad-cut-sapphire', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-sapphire', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut sapphires for sapphire rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { chisel: 1, 'uncut sapphire': 1 } },
        production: { output: 'sapphire', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut sapphire': 1 },
            resize: n => ({ args: ['cut-sapphire', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'sapphire', perTick: 0.15 }],
    };
    const cutEmerald: Template = {
        id: 'squad-cut-emerald', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-emerald', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut emeralds for emerald rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { chisel: 1, 'uncut emerald': 1 } },
        production: { output: 'emerald', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut emerald': 1 },
            resize: n => ({ args: ['cut-emerald', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'emerald', perTick: 0.15 }],
    };
    const sapphireRings: Template = {
        id: 'squad-sapphire-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut sapphires into sapphire rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { 'ring mould': 1, 'gold bar': 1, sapphire: 1 } },
        production: { output: 'sapphire ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, sapphire: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'sapphire ring', perTick: 0.05 }],
    };
    const emeraldRings: Template = {
        id: 'squad-emerald-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut emeralds into emerald rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { 'ring mould': 1, 'gold bar': 1, emerald: 1 } },
        production: { output: 'emerald ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, emerald: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'emerald ring', perTick: 0.05 }],
    };
    const enchantRecoil: Template = {
        id: 'squad-ring-of-recoil', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked sapphire rings into rings of recoil at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 7 }, items: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 } },
        production: { output: 'ring of recoil', outputPerUnit: 1, maximum: 27, inputs: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of recoil', perTick: 0.25 }],
    };
    const enchantDueling: Template = {
        id: 'squad-ring-of-dueling', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked emerald rings into rings of dueling(8) at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 27 }, items: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 } },
        production: { output: 'ring of dueling(8)', outputPerUnit: 1, maximum: 27, inputs: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of dueling(8)', perTick: 0.25 }],
    };
    // Non-Wilderness mainland gatherers for potions, secondaries and runes.
    const taverleyDruids: Template = {
        id: 'squad-taverley-druids', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_druid'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Chaos druids (non-Wilderness) for herbs, snape grass, law and nature runes',
        resources: ['squad:taverley-druids'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 4 },
        yields: () => [
            { item: 'unidentified ranarr', perTick: 0.01 }, { item: 'unidentified irit', perTick: 0.01 },
            { item: 'unidentified kwuarm', perTick: 0.008 }, { item: 'unidentified cadantine', perTick: 0.006 },
            { item: 'unidentified dwarf weed', perTick: 0.006 }, { item: 'unidentified marentill', perTick: 0.012 },
            { item: 'unidentified avantoe', perTick: 0.005 }, { item: 'unidentified toadflax', perTick: 0.004 },
            { item: 'unidentified harralander', perTick: 0.008 }, { item: 'snape grass', perTick: 0.005 },
            { item: 'nature rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.015 },
        ],
    };
    const taverleyBlackKnights: Template = {
        id: 'squad-taverley-black-knights', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_black_knight'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Black Knights (non-Wilderness) for death, chaos, cosmic and law runes',
        resources: ['squad:taverley-black-knights'], squadOnly: true, repeats: false,
        needs: { combat: 45, food: 6 },
        yields: () => [
            { item: 'death rune', perTick: 0.015 }, { item: 'chaos rune', perTick: 0.025 },
            { item: 'cosmic rune', perTick: 0.008 }, { item: 'law rune', perTick: 0.01 },
            { item: 'unidentified ranarr', perTick: 0.004 }, { item: 'mithril bar', perTick: 0.005 },
        ],
    };
    const ardougneGiants: Template = {
        id: 'squad-ardougne-giants', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'giant'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm surface Hill Giants for limpwurt roots, cosmic, death, chaos and nature runes and herbs',
        resources: ['squad:ardougne-giants'], squadOnly: true, repeats: false,
        needs: { combat: 30, food: 4 },
        yields: () => [
            { item: 'limpwurt root', perTick: 0.02 }, { item: 'nature rune', perTick: 0.03 },
            { item: 'cosmic rune', perTick: 0.015 }, { item: 'law rune', perTick: 0.015 },
            { item: 'chaos rune', perTick: 0.01 }, { item: 'death rune', perTick: 0.004 },
            { item: 'uncut sapphire', perTick: 0.003 }, { item: 'uncut emerald', perTick: 0.003 },
            { item: 'unidentified ranarr', perTick: 0.005 },
        ],
    };
    const edgevilleUnicorns: Template = {
        id: 'squad-edgeville-unicorns', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'unicorn'], env: { MAX_KILLS: '28' }, role: 'combat',
        goal: 'hunt Edgeville surface Unicorns (south of Wilderness border) for unicorn horns',
        resources: ['squad:edgeville-unicorns'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 2 },
        yields: () => [{ item: 'unicorn horn', perTick: 0.06 }],
    };
    const snapeGrass: Template = {
        id: 'squad-snape-grass', family: 'gather-spawn', script: 'scripts/gather-spawn.ts',
        args: ['231', '27'], env: { TICKS: '3000' }, role: 'herblore',
        goal: 'gather snape grass at Hobgoblin peninsula (non-Wilderness) for prayer potions',
        resources: ['squad:hobgoblin-snape'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'snape grass', perTick: 0.08 }],
    };
    const taverleyScales: Template = {
        id: 'squad-taverley-scales', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'taverley_scales'], env: { MAX_KILLS: '27' }, role: 'herblore',
        goal: 'gather blue dragon scales in Taverley Dungeon (Dusty key + Anti-dragon shield) for weapon poison',
        resources: ['squad:taverley-scales'], squadOnly: true, repeats: false,
        needs: { items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 4 },
        yields: () => [{ item: 'blue dragon scale', perTick: 0.04 }],
    };
    const chaosWine: Template = {
        id: 'squad-chaos-wine', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'chaos_wine'], env: { MAX_KILLS: '25', TELEGRAB_MAX: '25' }, role: 'magic',
        goal: 'telekinetic-grab Wine of Zamorak at the Chaos Temple south of Wilderness for ranging potions',
        resources: ['squad:chaos-temple-wine'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 33 }, items: { 'law rune': 25, 'air rune': 25 } },
        yields: () => [{ item: 'wine of zamorak', perTick: 0.03 }],
    };
    const whiteBerries: Template = {
        id: 'squad-white-berries', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2262 3168', 'scripts/gather-spawn.ts 239 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather white berries in Isafdar (post-Regicide, non-Wilderness) for super defence potions',
        resources: ['squad:isafdar-berries'], squadOnly: true, repeats: false,
        needs: { quests: ['Regicide'] },
        yields: () => [{ item: 'white berrie', perTick: 0.05 }],
    };
    const barbarianPlanks: Template = {
        id: 'squad-barbarian-planks', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2552 3574', 'scripts/gather-spawn.ts 960 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'supply',
        goal: 'gather planks at Barbarian Outpost (non-Wilderness) for quest demand',
        resources: ['squad:barbarian-planks'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'plank', perTick: 0.08 }],
    };
    const gnomeToads: Template = {
        id: 'squad-gnome-toads', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2417 3512', 'scripts/gather-spawn.ts 2150 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather swamp toads in Tree Gnome Stronghold for agility potions',
        resources: ['squad:gnome-toads'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'swamp toad', perTick: 0.12 }],
    };
    const bloodChest: Template = {
        id: 'squad-blood-chest', family: 'aio:skiller:thieving:blood-chest', script: 'scripts/blood-chest.ts',
        args: [], role: 'thieving', goal: 'loot the Ardougne Castle blood rune chests for the gang squad',
        resources: ['squad:ardougne-blood-chest'], squadOnly: true, repeats: false,
        needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
        yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }],
    };
    // Herb cleaning templates feeding unfinished potion brewers.
    const cleanHerbs = ([
        ['guam', 'identify:guam_leaf', 'unidentified guam', 'guam leaf', 3],
        ['marentill', 'identify:marentill', 'unidentified marentill', 'marrentill', 5],
        ['tarromin', 'identify:tarromin', 'unidentified tarromin', 'tarromin', 11],
        ['harralander', 'identify:harralander', 'unidentified harralander', 'harralander', 20],
        ['ranarr', 'identify:ranarr_weed', 'unidentified ranarr', 'ranarr weed', 25],
        ['toadflax', 'identify:toadflax', 'unidentified toadflax', 'toadflax', 30],
        ['irit', 'identify:irit_leaf', 'unidentified irit', 'irit leaf', 40],
        ['avantoe', 'identify:avantoe', 'unidentified avantoe', 'avantoe', 48],
        ['kwuarm', 'identify:kwuarm', 'unidentified kwuarm', 'kwuarm', 54],
        ['snapdragon', 'identify:snapdragon', 'unidentified snapdragon', 'snapdragon', 59],
        ['cadantine', 'identify:cadantine', 'unidentified cadantine', 'cadantine', 65],
        ['lantadyme', 'identify:lantadyme', 'unidentified lantadyme', 'lantadyme', 67],
        ['dwarf-weed', 'identify:dwarf_weed', 'unidentified dwarf weed', 'dwarf weed', 70],
        ['torstol', 'identify:torstol', 'unidentified torstol', 'torstol', 75],
    ] as const).map(([slug, recipe, raw, clean, lvl]) =>
        invMake(`squad-identify-${slug}`, recipe, clean, lvl, { [raw]: 1 }, {}, 0.2, `identify banked ${raw} for squad potions`));
    const unfPotions = UNF_POTIONS.map(([herb, item, lvl]) =>
        invMake(`squad-unf-${herb.replace(' ', '-')}`, `brew:unf_${herb.replace(' ', '_')}_potion`, `${herb} potion (unf)`, lvl,
            { [item]: 1, 'vial of water': 1 }, {}, 0.15, `mix banked ${item} and vials of water into ${herb} potion (unf)`));
    const decantPotions = ([
        ['prayer_restore', 'prayer potion'],
        ['super_attack', 'super attack'],
        ['super_strength', 'super strength'],
        ['super_defense', 'super defence'],
        ['ranging_potion', 'ranging potion'],
        ['super_energy', 'super energy'],
        ['agility_potion', 'agility potion'],
        ['super_antipoison', 'superantipoison'],
        ['super_restore', 'super restore'],
        ['magic_potion', 'magic potion'],
        ['zamorak_potion', 'zamorak potion'],
        ['restore_potion', 'restore potion'],
    ] as const).flatMap(([slug, label]) => [
        invMake(`squad-decant-${slug}`, `decant:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 2 }, {}, 0.3,
            `decant ${label}(3) doses into ${label}(4) at the bank`, MAKE_BATCH, { strictOutput: true, ownSupply: [`${label}(3)`] }),
        invMake(`squad-decant2-${slug}`, `decant2:${slug}`, `${label}(4)`, 1, { [`${label}(2)`]: 2 }, {}, 0.4,
            `decant ${label}(2) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(2)`] }),
        invMake(`squad-decant31-${slug}`, `decant31:${slug}`, `${label}(4)`, 1, { [`${label}(3)`]: 1, [`${label}(1)`]: 1 }, {}, 0.4,
            `decant ${label}(3) and (1) doses into ${label}(4) at the bank`, MAKE_BATCH, { ownSupply: [`${label}(3)`, `${label}(1)`] }),
    ]);
    const poisonArrowsArgs = (units: number) => ['poison:rune-arrow', `MAX_MAKE=${units * 5}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'];
    const poisonRuneArrows: Template = {
        id: 'squad-poison-rune-arrows', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: poisonArrowsArgs(MAKE_BATCH), role: 'herblore',
        goal: 'poison banked rune arrows with weapon poison at the bank for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Herblore: 1 }, items: { 'rune arrow': 5, 'weapon poison': 1 } },
        production: {
            output: 'rune arrow(p)', outputPerUnit: 5, maximum: MAKE_BATCH,
            inputs: { 'rune arrow': 5, 'weapon poison': 1 },
            resize: n => ({ args: poisonArrowsArgs(n) }),
        },
        yields: () => [{ item: 'rune arrow(p)', perTick: 0.5 }],
    };
    const karamjaRedSpidersEggs: Template = {
        id: 'squad-karamja-red-spiders-eggs', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/walk-to.ts 2832 9586', 'scripts/gather-spawn.ts 223 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: "gather red spiders' eggs in Karamja Volcano (non-Wilderness) for super restore potions",
        resources: ['squad:karamja-red-spiders-eggs'], squadOnly: true, repeats: false,
        needs: { items: { coins: 120 }, food: 4, anyOf: [{ skills: { Hitpoints: 23 } }, { combat: 34 }, { skills: { Prayer: 43 } }] },
        yields: () => [{ item: "red spiders' egg", perTick: 0.04 }],
    };
    const cutDragonstone: Template = {
        id: 'squad-cut-dragonstone', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-dragonstone', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut dragonstones into dragonstones for dragonstone jewellery', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 55 }, items: { chisel: 1, 'uncut dragonstone': 1 } },
        production: { output: 'dragonstone', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut dragonstone': 1 },
            resize: n => ({ args: ['cut-dragonstone', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'dragonstone', perTick: 0.15 }],
    };
    const dragonstoneJewellery = (id: string, recipe: string, output: string, level: number, mould: string): Template => ({
        id, family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500', 'MEMBERS=1'], role: 'crafting',
        goal: `smith banked gold bars and cut dragonstones into ${output}s at Al Kharid`, resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: level }, items: { [mould]: 1, 'gold bar': 1, dragonstone: 1 } },
        production: { output, outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, dragonstone: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500', 'MEMBERS=1'] }) },
        yields: () => [{ item: output, perTick: 0.05 }],
    });
    const DRAYNOR_TILE = { ...DRAYNOR_BANK, level: 0 };
    const enchantGloryArgs = (n: number) => bankJobArg({ family: 'magic', recipe: 'enchant:strung_dragonstone_amulet', target: n, batch: Math.min(24, n), cap: 1500, returnTicks: 300, members: true, reserve: 0, bank: DRAYNOR_TILE, site: DRAYNOR_TILE });
    const enchantGlory: Template = {
        id: 'squad-enchant-glory', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: enchantGloryArgs(24), role: 'magic',
        goal: 'enchant banked strung dragonstone amulets into amulets of glory at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 68 }, items: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 } },
        production: { output: 'amulet of glory', outputPerUnit: 1, maximum: 24, inputs: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 },
            resize: n => ({ args: enchantGloryArgs(n) }) },
        yields: () => [{ item: 'amulet of glory', perTick: 0.25 }],
    };
    return [
        waterCraft, earthCraft, waterTalisman, runeArrows, fletchBankedRuneArrows, sharks,
        karambwanjiFish, karambwanFish, karambwanCook,
        smithAnvil('squad-smith-rune-tips', 44, 'rune arrowtips', 90, 1, 15, 27),
        smithAnvil('squad-smith-rune-full-helm', 1163, 'rune full helm', 92, 2, 1, 10),
        smithAnvil('squad-smith-rune-kiteshield', 1201, 'rune kiteshield', 97, 3, 1, 8),
        smithAnvil('squad-smith-rune-platelegs', 1079, 'rune plateleg', 99, 3, 1, 8),
        smithAnvil('squad-smith-rune-platebody', 1127, 'rune platebody', 99, 5, 1, 5),
        smithAnvil('squad-smith-steel-nails', 1539, 'nail', 34, 1, 2, 27, 'steel bar'),
        magicLogs, magicShortbow, taverleyBlackDragons, blackDhideSets,
        goldOre, goldBars, cutSapphire, cutEmerald, sapphireRings, emeraldRings, enchantRecoil, enchantDueling,
        taverleyDruids, taverleyBlackKnights, ardougneGiants, edgevilleUnicorns, snapeGrass, taverleyScales, chaosWine, whiteBerries,
        barbarianPlanks, gnomeToads, bloodChest,
        ...cleanHerbs, ...unfPotions, ...decantPotions,
        invMake('squad-grind-unicorn-horn', 'grind:unicorn_horn', 'unicorn horn dust', 1, { 'unicorn horn': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-dragon-scale', 'grind:blue_dragon_scale', 'dragon scale dust', 1, { 'blue dragon scale': 1 }, { 'pestle and mortar': 1 }, 0.2),
        invMake('squad-grind-chocolate', 'grind:chocolate_bar', 'chocolate dust', 1, { 'chocolate bar': 1 }, { 'pestle and mortar': 1 }, 0.2,
            'grind banked chocolate bars into chocolate dust for potions and cakes'),
        invMake('squad-combine-crystal-key', 'combine:crystal-key', 'crystal key', 1, { keyhalf1: 1, keyhalf2: 1 }, {}, 0.2,
            'combine banked crystal key halves into crystal keys'),
        invMake('squad-strip-swamp-toad', 'strip:swamp-toad', "toad's leg", 1, { 'swamp toad': 1 }, {}, 0.2, "strip banked swamp toads into toad's legs"),
        invMake('squad-chocolate-cake', 'prepare:chocolate-cake', 'chocolate cake', 50, { cake: 1, 'chocolate bar': 1 }, {}, 0.15,
            'combine banked cakes and chocolate bars into chocolate cakes', MAKE_BATCH, { skill: 'Cooking', role: 'cooking', members: 0 }),
        invMake('squad-prayer-potion', 'brew:3doseprayerrestore', 'prayer potion(3)', 38, { 'ranarr potion (unf)': 1, 'snape grass': 1 }, {}),
        invMake('squad-super-attack', 'brew:3dose2attack', 'super attack(3)', 45, { 'irit potion (unf)': 1, 'eye of newt': 1 }, {}),
        invMake('squad-super-strength', 'brew:3dose2strength', 'super strength(3)', 55, { 'kwuarm potion (unf)': 1, 'limpwurt root': 1 }, {}),
        invMake('squad-super-defence', 'brew:3dose2defense', 'super defence(3)', 66, { 'cadantine potion (unf)': 1, 'white berrie': 1 }, {}),
        invMake('squad-ranging-potion', 'brew:3doserangerspotion', 'ranging potion(3)', 72, { 'dwarf weed potion (unf)': 1, 'wine of zamorak': 1 }, {}),
        invMake('squad-super-energy', 'brew:3dose2energy', 'super energy(3)', 52, { 'avantoe potion (unf)': 1, 'mort myre fungi': 1 }, {}),
        invMake('squad-agility-potion', 'brew:3dose1agility', 'agility potion(3)', 34, { 'toadflax potion (unf)': 1, "toad's leg": 1 }, {}),
        invMake('squad-super-restore', 'brew:3dose2restore', 'super restore(3)', 63, { 'snapdragon potion (unf)': 1, "red spiders' egg": 1 }, {}),
        invMake('squad-magic-potion', 'brew:3dose1magic', 'magic potion(3)', 76, { 'lantadyme potion (unf)': 1, 'potato cactu': 1 }, {}),
        invMake('squad-zamorak-potion', 'brew:3dosepotionofzamorak', 'zamorak potion(3)', 78, { 'torstol potion (unf)': 1, jangerberrie: 1 }, {}),
        invMake('squad-superantipoison', 'brew:3dose2antipoison', 'superantipoison(3)', 48, { 'irit potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-antipoison-brew', 'brew:3doseantipoison', 'antipoison(3)', 5, { 'marrentill potion (unf)': 1, 'unicorn horn dust': 1 }, {}),
        invMake('squad-weapon-poison', 'brew:weapon_poison', 'weapon poison', 60, { 'kwuarm potion (unf)': 1, 'dragon scale dust': 1 }, {}),
        invMake('squad-poison-dds', 'poison:dragon-dagger', 'dragon dagger(p)', 1, { 'dragon dagger': 1, 'weapon poison': 1 }, {}),
        poisonRuneArrows,
        karamjaRedSpidersEggs,
        cutDragonstone,
        dragonstoneJewellery('squad-dragonstone-ring', 'dragonstone_ring', 'dragonstone ring', 55, 'ring mould'),
        dragonstoneJewellery('squad-dragon-necklace', 'dragonstone_necklace', 'dragon necklace', 72, 'necklace mould'),
        dragonstoneJewellery('squad-dragonstone-amulet', 'unstrung_dragonstone_amulet', 'unstrung dragonstone amulet', 80, 'amulet mould'),
        invMake('squad-string-dragonstone-amulet', 'string-dragonstone-amulet', 'strung dragonstone amulet', 1, { 'unstrung dragonstone amulet': 1, 'ball of wool': 1 }, {}, 0.15,
            'string banked unstrung dragonstone amulets with balls of wool', MAKE_BATCH, { skill: 'Crafting', role: 'crafting' }),
        enchantGlory,
        shop('squad-arrows-dargaud', 'dargaud', 'rune arrow', 'rune arrow', 0.4, 'buy rune arrows in the Ranging Guild for the gang squad', { skills: { Ranged: 40 }, items: { coins: 30_000 } }),
        shop('squad-karambwan-shop', 'alfonse', 'cooked karambwan', 'cooked karambwan', 0.05, 'buy cooked karambwan at Brimhaven Fish Restaurant for the gang squad', { items: { coins: 32_000 } }),
        shop('squad-raw-karambwan-shop', 'tiadeche', 'raw karambwan', 'raw karambwan', 0.05, 'buy raw karambwan from Tiadeche for the gang squad', { quests: ['Tai Bwo Wannai Trio'], items: { coins: 24_000 } }),
        shop('squad-water-betty', 'betty', 'water rune', 'water rune', 0.7, "buy water runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-aubury', 'aubury', 'water rune', 'water rune', 0.7, "buy water runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-guild', 'magic_guild_elemental', 'water rune', 'water rune', 0.7, 'buy water runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-earth-betty', 'betty', 'earth rune', 'earth rune', 0.7, "buy earth runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-earth-guild', 'magic_guild_elemental', 'earth rune', 'earth rune', 0.7, 'buy earth runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-air-betty', 'betty', 'air rune', 'air rune', 0.7, "buy air runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-air-aubury', 'aubury', 'air rune', 'air rune', 0.7, "buy air runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-betty', 'betty', 'fire rune', 'fire rune', 0.7, "buy fire runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-aubury', 'aubury', 'fire rune', 'fire rune', 0.7, "buy fire runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-guild', 'magic_guild', 'fire rune', 'fire rune', 0.7, 'buy fire runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-blood-guild', 'magic_guild', 'blood rune', 'blood rune', 0.2, 'buy blood runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 110_000 } }),
        shop('squad-death-betty', 'betty', 'death rune', 'death rune', 0.3, "buy death runes at Betty's in Port Sarim", { items: { coins: 40_000 } }),
        shop('squad-death-aubury', 'aubury', 'death rune', 'death rune', 0.3, "buy death runes at Aubury's in Varrock", { items: { coins: 40_000 } }),
        shop('squad-death-guild', 'magic_guild', 'death rune', 'death rune', 0.4, 'buy death runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 80_000 } }),
        shop('squad-chaos-betty', 'betty', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Betty's in Port Sarim", { items: { coins: 30_000 } }),
        shop('squad-chaos-aubury', 'aubury', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Aubury's in Varrock", { items: { coins: 30_000 } }),
        shop('squad-chaos-guild', 'magic_guild_elemental', 'chaos rune', 'chaos rune', 0.5, 'buy chaos runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 60_000 } }),
        shop('squad-mind-betty', 'betty', 'mind rune', 'mind rune', 0.7, "buy mind runes at Betty's in Port Sarim", { items: { coins: 4000 } }),
        shop('squad-mind-aubury', 'aubury', 'mind rune', 'mind rune', 0.7, "buy mind runes at Aubury's in Varrock", { items: { coins: 4000 } }),
        shop('squad-nature-guild', 'magic_guild', 'nature rune', 'nature rune', 0.4, 'buy nature runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 40_000 } }),
        shop('squad-law-guild', 'magic_guild', 'law rune', 'law rune', 0.4, 'buy law runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 17_000 } }),
        shop('squad-antipoison-jiminua', 'jiminua', 'antipoison(3)', 'antipoison', 0.02, "buy antipoison(3) at Jiminua's in Karamja for the gang squad", { items: { coins: 8000 } }),
        shop('squad-dragon-dagger', 'jukat_dagger', 'dragon dagger', 'dragon dagger', 0.01, 'buy dragon daggers from Jakut in Zanaris for weapon poisoning', { quests: ['Lost City'], items: { coins: 130_000, diamond: 1 } }),
        shop('squad-berserker-helm', 'skulgrimen', 'berserker helm', 'berserker helm', 0.01, 'buy berserker helms from Skulgrimen after The Fremennik Trials for the gang squad', { quests: ['The Fremennik Trials'], skills: { Hitpoints: 45 }, items: { coins: 160_000 } }),
        shop('squad-oziach-platebody', 'oziach', 'rune platebody', 'rune platebody', 0.01, 'buy rune platebodies from Oziach after Dragon Slayer for the gang squad', { quests: ['Dragon Slayer'], items: { coins: 170_000 } }),
        shop('squad-scavvo-platelegs', 'scavvo', 'rune plateleg', 'rune platelegs', 0.01, "buy rune platelegs from Scavvo at the Champions' Guild for the gang squad", { quests: ['Dragon Slayer'], items: { coins: 130_000 } }),
        shop('squad-tenzing-boots', 'tenzing', 'climbing boot', 'climbing boots', 0.05, 'buy climbing boots from Tenzing after Death Plateau for the gang squad', { quests: ['Death Plateau'], items: { coins: 300 } }),
        shop('squad-sapphire-herquin', 'herquin', 'uncut sapphire', 'uncut sapphire', 0.02, "buy uncut sapphires at Herquin's in Falador for rings of recoil", { items: { coins: 15_000 } }),
        shop('squad-sapphire-gem-trader', 'gem_trader', 'uncut sapphire', 'uncut sapphire', 0.02, 'buy uncut sapphires in Al Kharid for rings of recoil', { items: { coins: 15_000 } }),
        shop('squad-emerald-gem-trader', 'gem_trader', 'uncut emerald', 'uncut emerald', 0.02, 'buy uncut emeralds in Al Kharid for rings of dueling(8)', { items: { coins: 20_000 } }),
        shop('squad-eye-of-newt', 'taverley', 'eye of newt', 'eye of newt', 0.3, "buy eye of newt at Jatix's Herblore shop in Taverley", { items: { coins: 1000 } }),
        shop('squad-vial-of-water', 'ardy', 'vial of water', 'vial of water', 0.3, "buy vials of water from Aemad's store in East Ardougne", { items: { coins: 1500 } }),
        shop('squad-shantay-waterskin', 'shantay', 'waterskin(4)', 'waterskin', 0.05, 'buy waterskins(4) at Shantay Pass for quest supply demand', { items: { coins: 1000 } }),
        shop('squad-shantay-bronze-bar', 'shantay', 'bronze bar', 'bronze bar', 0.02, 'buy bronze bars at Shantay Pass for quest and smithing demand', { items: { coins: 1000 } }),
        shop('squad-horvik-black-body', 'horvik', 'black platebody', 'black platebody', 0.005, "buy black platebodies at Horvik's Armoury in Varrock", { items: { coins: 8000 } }),
        shop('squad-louie-black-legs', 'louie', 'black plateleg', 'black platelegs', 0.005, 'buy black platelegs from Louie Legs in Al Kharid', { items: { coins: 4000 } }),
        shop('squad-valaine-black-helm', 'valaine', 'black full helm', 'black full helm', 0.005, "buy black full helms at Valaine's shop in the Champions' Guild", { questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 2500 } }),
        shop('squad-chocolate-bar', 'wydin_choc', 'chocolate bar', 'chocolate bar', 0.05, "buy chocolate bars at Wydin's Food Store in Port Sarim", { items: { coins: 600 } }),
        shop('squad-cake-baker', 'baker', 'cake', 'cake', 0.03, 'buy cakes at the East Ardougne bakery for chocolate cakes', { items: { coins: 800 } }),
        shop('squad-priest-gown', 'thessalia_gown', 'priest gown', 'priest gown', 0.02, "buy priest gowns at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-leather-gloves', 'thessalia', 'leather glove', 'leather gloves', 0.03, "buy leather gloves at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-fishing-bait', 'sarim', 'fishing bait', 'fishing bait', 0.3, "buy fishing bait at Gerrant's in Port Sarim", { items: { coins: 1500 } }),
        shop('squad-papyrus', 'ardy', 'papyrus', 'papyrus', 0.05, "buy papyrus from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-ball-of-wool', 'ardy', 'ball of wool', 'ball of wool', 0.05, "buy balls of wool from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-charcoal', 'jiminua', 'charcoal', 'charcoal', 0.02, "buy charcoal at Jiminua's Jungle Store on Karamja", { items: { coins: 1500 } }),
        shop('squad-cape-of-legends', 'siegfried', 'cape of legend', 'cape of legends', 0.01, "buy capes of legends from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 2000 } }),
        shop('squad-shield-right-half', 'siegfried', 'shield right half', 'shield right half', 0.005, "buy shield right halves from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 1_500_000 } }),
        shop('squad-dragon-battleaxe', 'helemos', 'dragon battleaxe', 'dragon battleaxe', 0.005, "buy dragon battleaxes from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 400_000 } }),
        shop('squad-dragon-mace', 'helemos', 'dragon mace', 'dragon mace', 0.005, "buy dragon maces from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 100_000 } }),
    ];
}

// The shop step of a maker whose only missing input is a ring mould: Dommik's Crafting Store in Al Kharid sells it
// (scripts/shop-buyer.ts profile dommik: ring mould shelf 4, necklace/amulet moulds shelf 2). The moulds cost 5 coins each in item data and the run
// stops at the first one held (STOCK_TARGET 1).
export const RING_MOULD_COINS = 100;
export function makerShopSteps(): Template[] {
    return [{
        id: 'shop-ring-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik', '600'],
        env: { ITEMS: 'ring mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a ring mould from Dommik's Crafting Store in Al Kharid for the ring makers", repeats: false,
        resources: ['shop:dommik'], yields: () => [], provides: { item: 'ring mould', unlocks: [...GEM_RINGS.map(([gem]) => `aio-${gem}-rings`), 'squad-sapphire-ring', 'squad-emerald-ring', 'squad-dragonstone-ring'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'ring mould': 1 } },
    }, {
        id: 'shop-necklace-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'necklace mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy a necklace mould from Dommik's Crafting Store in Al Kharid for necklace makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'necklace mould', unlocks: ['squad-dragon-necklace'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'necklace mould': 1 } },
    }, {
        id: 'shop-amulet-mould', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dommik_moulds', '600'],
        env: { ITEMS: 'amulet mould', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RING_MOULD_COINS), COIN_RESERVE: '50', MAX_SPEND: '50' },
        role: 'supply', goal: "buy an amulet mould from Dommik's Crafting Store in Al Kharid for amulet makers", repeats: false,
        resources: ['shop:dommik_moulds'], yields: () => [], provides: { item: 'amulet mould', unlocks: ['squad-dragonstone-amulet'] },
        needs: { items: { coins: RING_MOULD_COINS }, holdsUnder: { 'amulet mould': 1 } },
    }];
}
export function makerChains(): Template[] {
    const step = (recipe: string, max: number, cap = 1500) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${max} CAP=${cap} MEMBERS=1 ORDER_MODE=best-effort`;
    const chain = (id: string, steps: string[], rest: Pick<Template, 'role' | 'goal' | 'needs' | 'yields' | 'repeats'|'production'>): Template =>
        ({ id, pilot: true, family: 'aio:skiller:crafting:inventory', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, worker: 'scripts/microbot-production.ts', ...rest });
    return [
        chain('make-yew-shortbow', [step('cut-bow:unstrung_yew_shortbow', 1, 600), step('bow-string:yew_shortbow', 1, 600)], {
            role: 'fletching', goal: 'cut a banked yew log into a shortbow and string it', repeats: false,
            production:{output:'yew shortbow',outputPerUnit:1,maximum:1,inputs:{'yew logs':1,'bow string':1},resize:n=>({args:[step('cut-bow:unstrung_yew_shortbow',n,600),step('bow-string:yew_shortbow',n,600)]})},
            needs: { skills: { Fletching: 65 }, items: { knife: 1, 'yew logs': 1, 'bow string': 1 }, holdsUnder: { 'yew shortbow': 1 } },
            yields: () => [{ item: 'yew shortbow', perTick: 0.01 }] }),
        chain('make-uncooked-stew', [step('prepare:potato-stew', STEW_BATCH), step('prepare:uncooked-stew', STEW_BATCH)], {
            role: 'cooking', goal: 'make uncooked stews from banked potatoes, bowls of water and cooked meat',
            repeats:false,production:{output:'uncooked stew',outputPerUnit:1,maximum:STEW_BATCH,inputs:{potato:1,'bowl of water':1,'cooked meat':1},resize:n=>({args:[step('prepare:potato-stew',n),step('prepare:uncooked-stew',n)]})},
            needs: { skills: { Cooking: 25 }, items: { potato: STEW_BATCH, 'bowl of water': STEW_BATCH, 'cooked meat': STEW_BATCH } },
            yields: () => [{ item: 'uncooked stew', perTick: 0.05 }] }),
    ];
}

// Proven job templates. Rates are estimates from each script's header model; tick-waste discounts them by measurement.
export function catalogue(): Template[] {
    const goldfarm = KNIGHT_SPOTS.map((spot): Template => ({
        id: `goldfarm@${spot}`, family: 'goldfarm', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot, TICKS: '9000' }, role: 'thieving',
        goal: `goldfarm knights at ${spot}`, needs: { skills: { Thieving: 55 }, frail: GOLDFARM_FRAIL }, resources: [`knight:${spot}`],
        yields: a => [{ item: 'coins', perTick: knightCoinsPerTick(a.skills.Thieving ?? 1) }],
    }));
    const cows = COW_BANDS.map(({ skill, band, to }): Template => ({
        id: `army-cow-${skill.toLowerCase()}-${to}`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['3000', 'cow'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: String(to), COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to ${to} on the Ardougne cows`,
        tier: 'goal', band, repeats: true, trains: { skill, to, unlocks: [] }, resources: [COW_FIELD], yields: () => [],
        needs: { food: 14, meleeWeapon: true },
        // One trip to the Grand Exchange brings food for many runs, not the two trout one start needs.
        batch: { trout: 30 },
    }));
    const troopers = TROOPER_BANDS.map(({ skill, band }): Template => ({
        id: `army-trooper-${skill.toLowerCase()}-99`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to 99 on the Khazard troopers`,
        tier: 'goal', band, repeats: true, trains: { skill, to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    }));
    // The alchemy band's consumables for the casts an account's Magic level still has to Magic 99 (the batch of a kit buy and what a donor keeps).
    const alchBatch = (a: Acct, item: string): Record<string, number> => {
        const need = alchSupplies(a.skills.Magic ?? 1);
        return { 'nature rune': need.nature, [item]: need.item, 'fire rune': need.fire };
    };
    const magic: Template = {
        id: 'army-alch-magic-99', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['99', '5000'], role: 'combat', goal: 'train Magic to 99 with alchemy at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [] }, resources: [], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { 'nature rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] },
        // One buy brings every consumable of the casts left to Magic 99 (alchSupplies: one nature rune and one item a cast, and fire
        // runes for the casts), as far as the account's coins reach (`partBatch`). Magic 21 to 99 is 642 casts: 642 nature runes, 642
        // feathers and 3,098 fire runes. A start's 250 fire runes cover 50 casts, so a band bought by starts returns to the shop many times.
        // With no coins for the whole batch the buy takes the share they pay for, down to the cash reserve and margin (`keepCoins` is not set).
        batchFor: a => alchBatch(a, 'feather'), partBatch: true,
    };
    // Magic 1 to 21 for Low Alchemy: Wind Strike on the fenced Guard dog (scripts/alch-train.ts strikeStart). Practice,
    // fresh accounts started at the goldfarm knights: Magic 1 to 21-23 in 17-22 casts, no damage taken, about 180 ticks alone.
    const strike: Template = {
        id: 'army-strike-magic-21', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['21', '1500'], role: 'combat', goal: 'train Magic to 21 with Wind Strike from the safe tile at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 21, unlocks: [magic.id] }, resources: [STRIKE_TILE], yields: () => [],
        needs: { items: { 'mind rune': 35, 'air rune': 35 } },
    };
    // The alchemy band's fire, band 2. The market lists no fire rune under the kit caps (live claude-cloud: "unsold"),
    // and a cast takes 3 or 5 of them; a staff of fire stands for all of them (scripts/alch-train.ts). An account that
    // holds the band's nature runes and feathers but no fire buys one staff at Zaff's shop in Varrock (staffshop: 2 in
    // stock, one back every 1,000 ticks) and banks it at Varrock West. A kit buy on the Grand Exchange leaves the
    // account next to the shop; from Ardougne scripts/shop-buyer.ts takes the ferries. A pilot (off unless a plan's
    // `aio` list names it): live, the shelf stood at 0 through five visits, one of 1,100 ticks, so another player takes
    // each staff as it comes back. On an empty shelf the run waits
    // ZAFF_WAIT ticks, a little over the 1,000 a staff takes to come back, so one visit brings a staff: a run that
    // waits less ends ok with nothing bought, and a long one of those reads as tick waste (live claude-cloud:
    // UnderMyKilt, 799 ticks, boughtTotal=0 after a 200-tick wait). STALL_TICKS=0: the session's idle guard would end
    // the wait at 900 ticks (packages/core/src/bot.ts); the run's own cap bounds it.
    const staff: Template = {
        id: 'army-staff-zaff', pilot: true, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zaff', '3000'],
        env: { ITEMS: 'staff of fire', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: String(ZAFF_WAIT), STALL_TICKS: '0', FLOAT: '13000', COIN_RESERVE: '500', MAX_SPEND: '12000' },
        role: 'supply', goal: "buy a staff of fire at Zaff's shop in Varrock for the alchemy band",
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: ['shop:zaff'], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { coins: 15000, 'nature rune': 50, feather: 50 }, holdsUnder: { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 } },
    };
    // Fire and feathers for the alchemy band from shelves the army can reach, each a goal job at the Magic band for an
    // account that already holds the band's nature runes (so the trips follow its kit buy and never come early):
    // - feathers, the item the band casts on, at Gerrant's in Port Sarim, for an account with fewer than the band needs
    //   (six army accounts hold none, and the market's feather line ends "unsold");
    // - under Magic 66, FIRE_STOCK fire runes at Aubury's in Varrock: about 360 take Magic 21 to 66;
    // - from Magic 66, the level the Magic Guild door in Yanille asks, a staff of fire there (2 in stock) and
    //   FIRE_STOCK fire runes in case the staff shelf is empty. Yanille is a walk from Ardougne.
    // Practice from the Ardougne north bank: 700 feathers in 674 ticks, 500 fire runes in 614 more, then Magic 21 to 72
    // on them; the staff in 216 to 314 ticks (research/combat-measure.md).
    const noFire = { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 };
    // `wait`: the ticks with no buy that end the run. Under the shelf's restock interval, the run leaves an emptied
    // shelf; over it, the run stays and buys each unit as it comes back.
    const shopRun = (profile: string, cap: number, items: string, target: number, spend: number, wait = 25) => ['scripts/shop-buyer.ts', profile, String(cap), `ITEMS=${items}`, `STOCK_TARGET=${target}`,
        'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', `NO_BUY_TICKS=${wait}`, `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`].join(' ');
    const supply = (id: string, goal: string, shop: string, steps: string[], needs: Needs): Template => ({
        id, family: 'shop-buyer', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, role: 'supply', goal,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: [`shop:${shop}`], yields: () => [], needs });
    const feathers = supply('army-feathers-sarim', "buy feathers at Gerrant's in Port Sarim for the alchemy band", 'sarim',
        [shopRun('sarim', 3000, 'feather', FEATHER_STOCK, 10000)], { under: { Magic: 66 }, items: { coins: 12000, 'nature rune': 50 }, holdsUnder: { feather: 50 } });
    const fireRunes = supply('army-fire-aubury', "buy fire runes at Aubury's in Varrock for the alchemy band", 'aubury',
        [shopRun('aubury', 3000, 'fire.rune', FIRE_STOCK, 9000)], { skills: { Magic: 21 }, under: { Magic: 66 }, items: { coins: 11000, 'nature rune': 50, feather: 50 }, holdsUnder: noFire });
    // From Magic 66 the Magic Guild's shelf is the whole kit of the band (magic_guild.inv, runes.obj, staves.obj): a
    // staff of fire (2, base 1,500 coins), nature runes (1,000, base 20), and air runes (3,000, base 4) to cast on in
    // place of feathers, whose Port Sarim shelf other players empty. So the trip asks for coins only, and an account
    // that reaches 66 with no rune of the band (the curse band's accounts) goes straight on. `natureGuild` is the same
    // trip for an account that has its fire and has run out of nature runes. Practice from the Ardougne north bank,
    // Magic 66 and coins only: the trip and then Magic 66 to 99 on air runes (research/combat-measure.md, Magic by a
    // curse over the fence).
    const guildRunes = [shopRun('magic_guild', 900, 'nature.rune', NATURE_STOCK, 45000), shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)];
    const staffGuild = supply('army-staff-guild', 'buy a staff of fire, fire, nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 1500, 'staff.of.fire', 1, 12000), shopRun('magic_guild', 600, 'fire.rune', FIRE_STOCK, 9000), ...guildRunes],
        { skills: { Magic: 66 }, items: { coins: 80000 }, holdsUnder: noFire });
    const natureGuild = supply('army-nature-guild', 'buy nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild', guildRunes,
        { skills: { Magic: 66 }, items: { coins: 60000 }, holdsUnder: { 'nature rune': 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    const airGuild = supply('army-air-guild', 'buy air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)],
        { skills: { Magic: 66 }, items: { coins: 15000, 'nature rune': 50 }, holdsUnder: { 'air rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    // The alchemy band cast on air runes, for an account at Magic 66 or more that holds them (the guild trip's).
    const magicAir: Template = { ...magic, id: 'army-alch-air-magic-99', env: { ALCH_ITEM: 'airrune' }, goal: 'train Magic to 99 with alchemy on air runes at the Ardougne north bank',
        needs: { skills: { Magic: 66 }, items: { 'nature rune': 50, 'air rune': 50 }, anyOf: magic.needs!.anyOf }, batchFor: a => alchBatch(a, 'air rune'), shopKit: true };
    // Magic to SPLASH_TO with no fire rune, nature rune or feather, band 2: a curse cast over the fence of the Ardougne
    // cow field (scripts/splash-train.ts; Wind Strike, Confuse and Weaken under Magic 19). The kit is body, earth and
    // water runes, under 80,000 coins at the caps for the whole of it. A run starts with ten casts' runes
    // (SPLASH_START) and casts what the account holds, so an account with part of a kit trains at once; a buy or a
    // send brings what its level still casts (splashKit). The market lists few water runes (live claude-cloud read:
    // 310), so the kit buy takes the body and earth runes on the Grand Exchange and an account short of the start's
    // water buys a kit's worth at Aubury's (varrock.inv: 2,000 in stock, one back every 10 ticks) or Betty's. The buy
    // is a candidate of the band itself (`kitFirst`): an account that can train Ranged still goes for it. Pilots (off
    // unless a plan's `aio` list names them). Practice from an army account's state: Magic 21 to 66 in 135 casts and
    // Magic 1 to 65 in 138, no hitpoint lost.
    const splash: Template = {
        id: 'army-splash-magic-66', pilot: true, family: 'combat-train', script: 'scripts/splash-train.ts', args: [String(SPLASH_TO), '6000'], role: 'combat',
        goal: `train Magic to ${SPLASH_TO} with a curse cast over the fence of the Ardougne cow field`,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [magic.id] }, resources: [SPLASH_FENCE], yields: () => [],
        needs: { items: { ...SPLASH_START, 'mind rune': 2, 'air rune': 2 } }, batchFor: a => splashKit(a.skills.Magic ?? 1), kitFirst: true,
    };
    // Two shelves, one account at each: Aubury's (2,000 water runes in stock) read 0 on three live visits, so Betty's
    // in Port Sarim (port_sarim.inv: 1,000, one back every 10 ticks, the ferry's own port) is the second.
    const waterJob = (id: string, where: string, shop: string): Template => ({
        ...supply(id, `buy water runes at ${where} for the curse band`, shop, [shopRun(shop, 3000, 'water.rune', SPLASH_KIT['water rune'], 12000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 14000, 'body rune': SPLASH_START['body rune'], 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'water rune': SPLASH_START['water rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    });
    const water = waterJob('army-water-aubury', "Aubury's in Varrock", 'aubury'), waterBetty = waterJob('army-water-betty', "Betty's in Port Sarim", 'betty');
    const body: Template = {
        ...supply('army-body-aubury', "buy body runes at Aubury's in Varrock for the curse band", 'aubury', [shopRun('aubury', 3000, 'body.rune', SPLASH_KIT['body rune'], 8000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 10000, 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'body rune': SPLASH_START['body rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    };
    const prayer: Template = {
        id: 'army-bury-prayer-99', family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, role: 'combat',
        goal: 'train Prayer to 99 burying the held bones', tier: 'goal', band: PRAYER_BAND, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { items: { bones: 100 } },
    };
    // Prayer from bought bones, bands just after the held bones. On the field a buried trooper kill gives 3.84 Prayer XP
    // a tick, about 130,000 ticks from Prayer 74 to 99 for every account; a dragon bone gives 1,800 XP and a big bone
    // 375 at the bank (scripts/train-prayer.ts BONE_XP). The Grand Exchange lists about 1,000 dragon bones and 1,700 big
    // bones under the caps (KIT_PRICE_CAPS), about 2.4 million XP in all, so the kit tier buys them for an account
    // with no other band to start, the account nearest 99 first: each takes what its Prayer still needs (BONE_KEEP
    // more, which the trainer never buries), or what it can pay for. The band starts with BONE_START bones held, so
    // a part-filled order is buried too. Dragon bones come first: about 5.2 coins an XP against 6.5. The listed bones
    // finish about three accounts, so only an account with Ranged and Magic at BONE_SKILL buys them: they go where
    // they complete a tribrid, not to an account with a day of Ranged ahead of it.
    const boneBand = (id: string, bone: string, boneId: number, band: number): Template => ({
        id, family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_ID: String(boneId), BONE_RESERVE: String(BONE_KEEP), CAP: '4000' }, role: 'combat',
        goal: `train Prayer to 99 burying bought ${bone}`, tier: 'goal', band, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { skills: { Ranged: BONE_SKILL, Magic: BONE_SKILL }, items: { [bone]: BONE_START } }, partBatch: true,
        // An account with Ranged or Magic still to finish keeps BONE_PURSE for arrows, a staff and a blade.
        keepCoins: a => (a.skills.Ranged ?? 1) < 99 || (a.skills.Magic ?? 1) < 99 ? BONE_PURSE : 0,
        batchFor: a => ({ [norm(bone)]: BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(a.skills.Prayer ?? 1)) / BOUGHT_BONE_XP[boneId]!) }),
    });
    const dragonBones = boneBand('army-bury-dragon-99', 'dragon bones', 536, PRAYER_BAND + 0.1), bigBones = boneBand('army-bury-big-99', 'big bones', 532, PRAYER_BAND + 0.2);
    // Lost City, which a dragon weapon asks of its wielder (levelrequire.rs2 levelrequire_zanaris_quest), through the
    // AIO quester's chain (scripts/quest-chain.ts): Monk's Friend first for Woodcutting 56 and Murder Mystery for
    // Crafting 51 (the dramen tree wants 36 and the staff 31; the chain skips a quest the status shows complete and
    // skips Lost City while either level is short). The sweep takes off and banks what the account wears before the
    // Entrana ship (scripts/quest-sweep.ts BARE), takes the quest pack from the bank and buys what a shop sells. The
    // tree spirit is level 101 and is fought bare-handed. An account with Hitpoints and Defence 90 goes without the
    // quest's prayer potions (no shop sells them) and carries LOST_CITY_MEALS of the food the quest script eats; the
    // planner asks those levels and that food, and buys the food as the band's own candidate (`kitFirst`). An account
    // under those levels goes with the levels, the potions and the food of LOST_CITY_BUILD: the quest script sets a
    // melee style that trains only Strength before each fight (scripts/generated/quest-lib.ts strengthStyle).
    // Practice: research/quest-points-board.md (Lost City 3/3 from its preset) and research/combat-measure.md (the
    // chain from an army account's state).
    // Black dragonhide for the army's ranged armour, band 10: nine kills a trip from the corridor south of the cave
    // (scripts/black-dragon-camp.ts), the hides and dragon bones banked at Varrock West. The kit is a magic shortbow,
    // iron arrows (a kill uses 60 to 100, more with two hunters in the cave; mithril costs about 745 coins an arrow), one Varrock teleport and six
    // sharks; the dusty key cannot be traded and has its own job. Both are fillers: an account takes them, and the
    // kit tier gets the kit, only when no training band and no kit of one serves it, so bones for Prayer come before
    // arrows for dragons. The shop run buys arrows and the teleport's air and fire runes (`ownSupply`); the kit
    // tier buys the bow, law rune and sharks. Spare owned stock can supply every kit line. Pilots.
    const dustyKey: Template = {
        id: 'army-dusty-key', pilot: true, family: 'aio:quester:mode:dusty-key', script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], aio: 'quester:mode:dusty-key', worker: 'scripts/dusty-key.ts',
        role: 'quest', goal: "get the dusty key from Velrak for Taverley dungeon's inner gate", tier: 'goal', band: HUNT_BAND, filler: true, repeats: false, stock: { item: 'dusty key', to: 1 }, yields: () => [],
        needs: { skills: { Attack: 90, Strength: 90, Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 } },
    };
    // The same trip on bronze arrows, for an account whose shop run found more bronze than iron: Lowe's bronze shelf
    // holds 2,000 and gives one back every 10 ticks, the iron shelf 1,500 and one every 15. Practice, two hunters at
    // once with 600 arrows each: 7 kills on bronze, 6 on iron.
    const huntOn = (id: string, arrow: string, arrows = HUNT_ARROWS): Template => ({
        id, pilot: true, family: 'combat-train', script: 'scripts/black-dragon-camp.ts', args: ['9000'],
        env: { KILLS: String(HUNT_KILLS), ARROW: arrow.replace(' ', '_'), ARROWS: String(arrows) }, role: 'combat', goal: `kill Taverley's black dragons for their hides and bones, on ${arrow}s`,
        tier: 'goal', band: HUNT_BAND, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: [BLACK_CAVE], yields: () => [],
        ownSupply: ['rune arrow', 'iron arrow', 'bronze arrow', 'air rune', 'fire rune'],
        needs: { skills: { Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 },
            items: { 'dusty key': 1, 'magic shortbow': 1, [arrow]: arrows, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD } },
    });
    // The rune hunt is the first: the best arrow that the magic shortbow fires. The iron and bronze hunts serve an account
    // that holds a trip of those and no trip of rune arrows.
    const huntRune: Template = { ...huntOn('army-hunt-black-dragons-rune', 'rune arrow', HUNT_RUNE_ARROWS), band: HUNT_BAND - 0.01 };
    const hunt = huntOn('army-hunt-black-dragons', 'iron arrow'), huntBronze = huntOn('army-hunt-black-dragons-bronze', 'bronze arrow');
    // The hunt's shop lines. No market lists 600 iron arrows (live claude-cloud: 23 listed), and the arrow and rune
    // shop jobs of the training bands end at Ranged 99 and Magic 66. Lowe's Archery Emporium (archeryshop: 1,500 iron
    // arrows, one back every 15 ticks, and 2,000 bronze, one every 10) and Aubury's rune shop (2,000 air and fire
    // runes, one back every 10 ticks) are both by the Varrock east bank, in the town a trip's teleport ends in. The
    // run stands while the hunt does and the account is short of a trip's iron arrows or of one teleport's air or fire
    // runes; with a trip's bronze arrows held the bronze hunt comes first. The arrows come first: a rune shelf found
    // empty ends its step as a wait, not the run. An iron arrow costs 3 coins from the full shelf and 18 from a
    // drained one, a bronze arrow 1 and 6 (shop.rs2: six times the base cost at most), so the spend covers both
    // stocks at the dearest price. Each step leaves an emptied shelf (practice: with a wait of 25 ticks a run stood
    // 2,500 ticks at Lowe's buying one arrow every 15), and the account hunts or shops again on the planner's next
    // pass.
    // A hunter's rune arrows from the Ranging Guild shop (Ranged 40; HUNT_RUNE_SPEND covers a trip off a full shelf), then the
    // teleport runes at Aubury's. It comes before the iron and bronze run.
    const huntSupplyRune: Template = {
        id: 'army-hunt-supply-rune', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('dargaud', 2500, 'rune.arrow', HUNT_RUNE_ARROWS, HUNT_RUNE_SPEND, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy rune arrows at the Ranging Guild and teleport runes at Aubury's for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:dargaud', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: HUNT_RUNE_SPEND + 4000 }, shortOf: { 'rune arrow': HUNT_RUNE_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    const huntSupply: Template = {
        id: 'army-hunt-supply', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('lowe', 2500, 'iron.arrow|bronze.arrow', HUNT_ARROW_STOCK, 28000, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy iron and bronze arrows at Lowe's and teleport runes at Aubury's in Varrock for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.3, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:lowe', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: 32000 }, shortOf: { 'iron arrow': HUNT_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    // Dragon longswords, which an account wields once Lost City is done. Jakut in the Zanaris market sells two at
    // 100,000 coins (one back every 500 ticks); the way in is the dramen staff the quest leaves the account, and the
    // market door takes one cut diamond, which the kit tier buys. Other players empty the shelf on the live server
    // (a run that looked every 15 ticks saw none for 600), so the visit sends a buy request each tick (BLIND_BUY) and
    // waits JAKUT_WAIT ticks with no buy before it leaves. One visit buys JAKUT_SWORDS: the account's own and one to
    // give. The band stands only while the account holds no sword: a second visit for one more would cost a second
    // diamond. One account at the shelf at a time. It comes after the hunt and before the flax, in the time a hunter
    // is short of arrows. A pilot.
    const jakut: Template = {
        id: 'army-jakut-swords', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts', env: { ROUNDS: '1' },
        args: [['scripts/shop-buyer.ts', 'jukat', String(JAKUT_CAP), 'BLIND_BUY=1', `STOCK_TARGET=${JAKUT_SWORDS}`, 'STOP_AT_TARGET=1', 'BANK_AT=0', `NO_BUY_TICKS=${JAKUT_WAIT}`, 'STALL_TICKS=0',
            `COIN_RESERVE=${JAKUT_RESERVE}`, `FLOAT=${JAKUT_COINS}`].join(' ')],
        role: 'supply', goal: 'buy dragon longswords from Jakut in the Zanaris market', resources: ['shop:jukat'],
        tier: 'goal', band: HUNT_BAND + 0.05, filler: true, repeats: false, stock: { item: 'dragon longsword', to: 1 }, yields: () => [],
        needs: { quests: ['Lost City'], items: { 'dramen staff': 1, diamond: 1, coins: JAKUT_COINS } },
    };
    // The hides made into armour by the accounts that hunt them, so no hide is traded. To wear a black dragonhide
    // piece asks Ranged 70, the body Defence 40 and no quest (levelrequire tier70.rs2); to make the body asks Crafting
    // 84. An account the hunt serves spins flax at Seers to that level (15 Crafting XP a flax at the server's rate of
    // 25: 825 flax from level 54, where Murder Mystery leaves it), one account in the flax field at a time, and then
    // tans its hides at Al Kharid and crafts whole sets, SET_HIDES hides each, until it holds ARMOUR_SETS bodies.
    // After a trip the order is: the next trip, Jakut's swords, a set, the flax, the shop run. So an account short of arrows spins
    // while the other hunter has Lowe's shelf, which gives back fewer arrows than two hunters fire. Pilots.
    const leatherNeeds = { ...hunt.needs!.skills, Crafting: 10 };
    const leatherTrain = { skill: 'Crafting', to: LEATHER_LEVEL, unlocks: [] };
    const dhideSets: Template = {
        id: 'army-black-dhide-sets', pilot: true, family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/aio.ts', args: ['skiller', 'crafting', 'black-dhide-sets'],
        aio: 'skiller:crafting:black-dhide-sets', worker: 'scripts/black-dhide-sets.ts', role: 'crafting', goal: 'tan black dragonhide at Al Kharid and craft sets of body, chaps and vambraces',
        tier: 'goal', band: HUNT_BAND + 0.1, filler: true, repeats: true, stock: { item: 'dragonhide body', to: ARMOUR_SETS }, yields: () => [],
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP }, holds: { dragonhide: SET_HIDES } },
    };
    const leatherFlax: Template = {
        id: 'army-leather-flax', pilot: true, family: 'aio:skiller:foraging:flax', script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'],
        aio: 'skiller:foraging:flax', worker: 'scripts/gather-flax.ts', role: 'crafting', goal: 'pick flax at Seers to spin for the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, resources: [AIO_PLACES.flax], yields: () => [],
        needs: { skills: leatherNeeds, holdsUnder: { flax: FLAX_SPIN } },
    };
    const leatherSpin: Template = {
        id: 'army-leather-spin', pilot: true, family: 'aio:skiller:crafting:bowstrings', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'bowstrings', '2500', `MAX_MAKE=${FLAX_SPIN}`, 'RAW_RESERVE=0', 'MAX_TRIPS=8'],
        aio: 'skiller:crafting:bowstrings', worker: 'scripts/spin-bowstrings.ts', role: 'crafting', goal: 'spin flax at Seers to the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, yields: () => [],
        needs: { skills: leatherNeeds, holds: { flax: FLAX_SPIN } },
    };
    const lostCity: Template = {
        id: 'army-quest-lostcity', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,zanaris'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and Lost City to wield dragon weapons", tier: 'goal', band: QUEST_BAND,
        quest: { name: 'Lost City', unlocks: [] }, resources: [LOST_CITY], yields: () => [],
        needs: { items: { coins: 5000 }, anyOf: [{ skills: { Prayer: 43, Hitpoints: 90, Defence: 90 }, pieces: { of: LOST_CITY_FOOD, count: LOST_CITY_MEALS } }, LOST_CITY_BUILD] }, kitFirst: true,
    };
    // Merlin's Crystal and Holy Grail through the same chain. The quest sweep gathers Merlin's kit itself (insect
    // repellent, a bucket and the wax at the Catherby hives, bat bones from a giant bat, bread and a tinderbox from
    // shops) and takes everything worn off for the Entrana ship of Holy Grail (scripts/quest-sweep.ts BARE), keeping
    // Excalibur and the rune scimitar in the pack: the Titan dies to the scimitar with Excalibur worn at the end. The
    // planner asks what no shop sells: the scimitar, the teleports' runes (and the Magic 45 Camelot's asks) and the
    // meals. Merlin's Crystal walks to the chaos altar at Wilderness level 12 with what the account wears. Only an
    // account under Prayer 99 goes: the quests pay it nothing else. A pilot.
    const holyGrail: Template = {
        id: 'army-quest-holygrail', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'merlin,grail'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Merlin's Crystal and Holy Grail for 275,000 Prayer experience", tier: 'goal', band: GRAIL_BAND,
        quest: { name: 'Holy Grail', unlocks: [] }, resources: [GRAIL_PLACE], yields: () => [],
        needs: { skills: { Prayer: 43, Magic: spellFact('camelot_teleport').level, Attack: 90, Strength: 90, Hitpoints: 90, Defence: 90 }, under: { Prayer: 99 }, items: { coins: 2000, 'rune scimitar': 1, ...GRAIL_RUNES },
            pieces: { of: LOST_CITY_FOOD, count: GRAIL_MEALS } }, kitFirst: true,
    };
    // The Fremennik Trials for a build with a Fremennik helm (BUILD_QUESTS), through the same chain: Monk's Friend gives
    // the Woodcutting 40 and Murder Mystery the Crafting 40 that the lyre asks, and the band asks Fletching 25. The sweep banks what the account wears (scripts/quest-sweep.ts BARE) and takes the quest pack: 5,300
    // coins, a beer, a tinderbox, a rune axe, a knife, a cabbage, a potato, an onion, a raw shark and four sharks. The
    // quest script fights the Draugen and Koschei unarmed with the style that trains only Strength, under the prayer
    // guard's Protect from Melee. Practice at the levels of `range-tank` and `tank-range` before the quest (Attack
    // 68, Strength 60 to 62): 3,408 to 3,570 ticks in 8 runs, no death, Attack and Defence 60 from the reward
    // (research/pvp-fight-loop.md, "Quest routes of the builds"). The band army-fletch-25 brings the Fletching. The
    // band asks Attack 60 and Strength 60, or Strength 99: an account with Attack 7 and Strength 99 (`zerker` before the
    // quest) can lose Koschei's third form to its 1,000 tick limit, and the quest script then starts the trial again
    // (3 practice runs: 1, 2 and 3 tries, 4,597 to 9,253 ticks). A pilot.
    const fremennik: Template = {
        id: 'army-quest-fremennik', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,viking'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and The Fremennik Trials to wear a Fremennik helm", tier: 'goal', band: FREMENNIK_BAND,
        quest: { name: 'The Fremennik Trials', unlocks: [] }, resources: [FREMENNIK], yields: () => [],
        needs: { skills: { Prayer: 43, Hitpoints: 90, Fletching: 25 }, items: { coins: 6000 }, pieces: { of: LOST_CITY_FOOD, count: FREMENNIK_MEALS },
            anyOf: [{ skills: { Attack: 60, Strength: 60 } }, { skills: { Strength: 99 } }] }, kitFirst: true,
    };
    // Fletching 25 for that quest, just before it: a walk to the Ardougne north bank, then headless arrows from banked
    // arrow shafts and feathers with the fletching worker (scripts/fletch-arrows.ts, mode headless), which does not
    // walk to a bank itself. The Grand Exchange lists no arrow shafts and no logs, so the kit comes from a donor: the
    // sides hold about 42,000 shafts and 74,000 feathers in their banks. Practice: 210 arrows in 26 ticks, 5,250 XP
    // (bench case extra:fletch-headless-25). A pilot.
    const fletch: Template = {
        id: 'army-fletch-25', family: 'fletch', script: 'scripts/chain.ts', pilot: true, buildOnly: true, route: 'The Fremennik Trials', role: 'fletching',
        args: [`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to the Fletching 25 that The Fremennik Trials ask', tier: 'goal', band: FREMENNIK_BAND - 0.01, repeats: false,
        trains: { skill: 'Fletching', to: FLETCH_TO, unlocks: [fremennik.id] }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_MAKE + FLETCH_KEEP, feather: FLETCH_MAKE + FLETCH_KEEP } },
    };
    const FLETCH_30_MAKE = 540;
    const questFletch30: Template = {
        id: 'army-quest-fletch-30', family: 'fletch', script: 'scripts/chain.ts', pilot: true, noReserve: true, role: 'fletching',
        args: [`scripts/walk-to.ts ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_30_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to reach Fletching 30 for quest board progression', tier: 'goal', band: QUEST_DEMAND_BAND - 0.02, repeats: false,
        trains: { skill: 'Fletching', to: 30, unlocks: questDemand().map(q => q.id) }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_30_MAKE + FLETCH_KEEP, feather: FLETCH_30_MAKE + FLETCH_KEEP } },
    };
    // Underground Pass for a build with the dragon halberd, through the chain with Plague City and Biohazard, which
    // the pass asks for (quest_upass.rs2:81) and which give no XP in a combat skill. The sweep banks what the account
    // wears and takes the pack of the practice case (scripts/quest-sweep.ts BUILD_PACK): the quest pack, a magic
    // shortbow, QUEST_BOW_ARROWS rune arrows and two prayer potions. The quest script fights with the bow in the
    // style that trains only Ranged. Practice at the levels before the route with Thieving UPASS_THIEVING and Agility
    // UPASS_AGILITY (bench case extra:upass-pure-hally): 3 seeds, 2,697 to 2,858 ticks, 4 to 8 sharks eaten, lowest
    // Hitpoints 33 of 93, no death; the same through the sweep from the bank (extra:sweep-upass-pure-hally): 3 seeds
    // (research/pvp-fight-loop.md, "Quest routes of the builds"). The reward gives Attack 61. A pilot.
    const BOW_KIT = { 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS };
    const upass: Template = {
        id: 'army-quest-upass', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'elena,biohazard,upass'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Attack'],
        goal: 'complete Plague City, Biohazard and Underground Pass on the way to the dragon halberd', tier: 'goal', band: UPASS_BAND,
        quest: { name: 'Underground Pass', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { skills: { Ranged: 99, Prayer: 43, Hitpoints: 90, Thieving: UPASS_THIEVING, Agility: UPASS_AGILITY }, items: { coins: 5000, ...BOW_KIT, 'prayer potion(4)': 2 },
            pieces: { of: LOST_CITY_FOOD, count: UPASS_MEALS } }, kitFirst: true,
    };
    // Regicide after it, for the dragon halberd (tier60.rs2:10), through the chain with Murder Mystery: its reward
    // gives the Crafting 10 that the loom of the quest asks. The quest crosses the pass twice more with the same bow
    // pack and casts the Falador and the Ardougne teleport (Magic 51; REGICIDE_RUNES). Practice with Underground Pass
    // done (bench case extra:regicide-pure-hally): 3 seeds, 3,229 to 3,250 ticks, 10 or 11 sharks eaten, lowest
    // Hitpoints 38 of 93, no death; the same through the sweep (extra:sweep-regicide-pure-hally): 3 seeds.
    // The band asks the items of REGICIDE_PACK; the sweep buys the rest of the quest pack in shops. A pilot.
    const regicide: Template = {
        id: 'army-quest-regicide', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'murder,regicide'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Magic'],
        goal: 'complete Murder Mystery and Regicide to wield the dragon halberd', tier: 'goal', band: REGICIDE_BAND,
        quest: { name: 'Regicide', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { quests: ['Underground Pass'], skills: { Ranged: 99, Magic: spellFact('ardougne_teleport').level, Prayer: 43, Hitpoints: 90, Agility: UPASS_AGILITY }, items: { coins: 2000, ...BOW_KIT, ...REGICIDE_RUNES, ...REGICIDE_PACK },
            pieces: { of: LOST_CITY_FOOD, count: REGICIDE_MEALS } }, kitFirst: true,
    };
    // Thieving UPASS_THIEVING and Agility UPASS_AGILITY for those quests, before them. Thieving: the trainer of the
    // band thieving55 (men, warrior women and guards at Ardougne, bread from the baker) with a lower target. Agility:
    // the Gnome Stronghold course through the course worker, which walks there from Ardougne. A lap gives 2,162 XP at
    // the server's rate, and level 68 is 115,881 XP: 54 laps. Neither gives XP in a combat skill. Pilots.
    const upassThieve: Template = {
        id: 'army-thieve-50', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: String(UPASS_THIEVING), CAP: '2500', CLEAN_FOOD: '1' },
        pilot: true, buildOnly: true, route: 'Underground Pass', role: 'thieving', goal: 'train Thieving to the 50 that the cage doors of Underground Pass ask',
        tier: 'goal', band: UPASS_BAND - 0.02, repeats: true, trains: { skill: 'Thieving', to: UPASS_THIEVING, unlocks: [upass.id] }, yields: () => [],
    };
    const upassAgility: Template = {
        id: 'army-agility-68', family: 'aio:skiller:agility:order', script: 'scripts/aio.ts', args: ['skiller', 'agility', 'order', 'gnome', String(UPASS_AGILITY)],
        aio: 'skiller:agility:order', worker: 'scripts/agility-order.ts', pilot: true, buildOnly: true, route: 'Underground Pass', role: 'agility',
        goal: 'run the Gnome Stronghold course to the Agility 68 from which no bridge of Underground Pass fails',
        tier: 'goal', band: UPASS_BAND - 0.01, repeats: true, trains: { skill: 'Agility', to: UPASS_AGILITY, unlocks: [upass.id, regicide.id] }, yields: () => [],
    };
    const prayerField: Template = {
        id: 'army-trooper-prayer-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Prayer to 99 burying trooper bones on the field',
        tier: 'goal', band: PRAYER_FIELD_BAND, filler: true, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    };
    // The Ranged band runs the trooper trainer itself, as the melee bands do. The adaptive worker
    // (scripts/ranged-train.ts) starts only with a practice proof for the account's exact levels, kit and source
    // release, one proof for each five Ranged levels, so no army account with a bow and arrows started the band, and its
    // unbound job held the one chicken pen. The trooper method from Ranged 1 with a shortbow and iron arrows:
    // research/combat-measure.md, "Ranged on the troopers".
    const ranged: Template = {
        id: 'army-trooper-ranged-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Ranged to 99 on the Khazard troopers',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        // RANGED_TROOPER_DEFENCE: the troopers reach an archer and hit it. Live, accounts with Defence 99 trained Ranged
        // 1 to 45-55 in a run with 0 to 1 food eaten and lowest HP 49 to 92; accounts with Defence 9, 10 and 43 ate 26 to
        // 36 food a run and fell to 16, 8 and 14 HP. An account under the floor takes its Defence bands first.
        needs: { skills: { Hitpoints: 40, Defence: RANGED_TROOPER_DEFENCE }, anyOf: RANGED_KIT.flatMap(kit => TROOPER_FED.map(fed => ({ ...kit, ...fed, skills: { ...kit.skills, ...fed.skills } }))) },
        batch: { trout: 100, ...Object.fromEntries(ARROWS.map(([arrow]) => [arrow, 1000])) },
    };
    // The Ranged band's arrows, band 4. The market lists no arrow under the kit caps (live claude-cloud: every arrow
    // line of a kit buy "unsold"), and each army account holds a shortbow and 25 bronze arrows, so the band never
    // started. An account whose bow has fewer than ARROW_LOW bronze and iron arrows buys bronze arrows at Aemad's shop in
    // East Ardougne (adventurershop: 500 in stock, one back every 10 ticks, shared by every player) and banks them at the
    // south bank. One account shops at a time (shop:ardy). The run ends at ARROW_STOCK arrows owned or at its cap; the
    // planner gives the account the Ranged band on the pass that sees ARROW_LOW arrows.
    const arrows: Template = {
        id: 'army-arrows-ardy', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['ardy', '400'],
        env: { ITEMS: 'bronze arrow', STOCK_TARGET: String(ARROW_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '5000', COIN_RESERVE: '500', MAX_SPEND: '4000' },
        role: 'supply', goal: 'buy bronze arrows at Aemad in East Ardougne for the Ranged band',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:ardy'], yields: () => [],
        needs: { items: { coins: 5000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    // The same need at Hickton's Archery Emporium in Catherby (archeryshop2: bronze 1,000 and iron 800 in stock, one back
    // every 10 and 20 ticks). It is a walk from Ardougne with no ferry: practice, 1,785 arrows bought and banked at the
    // Catherby bank 435 ticks after the start at the north bank. The second account short of arrows goes here.
    const arrowsCatherby: Template = {
        id: 'army-arrows-catherby', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby_arrows', '600'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Hickton's in Catherby for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:catherby_arrows'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    // The arrow shop of an account at Ranged 40, the level the Ranging Guild door asks: Dargaud's shop there sells
    // willow shortbows (20 in stock) and every arrow (bronze 1,000, iron, steel and mithril 500 each; one back every 10,
    // 20, 40 and 60 ticks). A shortbow fires bronze and iron only; a willow shortbow fires up to mithril. Two shop runs
    // in one job (scripts/chain.ts): the bow, then the arrows, banked at Seers' Village. It comes just before the other
    // arrow shops (GUILD_BAND), so accounts that can enter leave Aemad's, Hickton's and Lowe's shelves to those that
    // cannot. The bronze shelf always gives something back, so a visit to an emptied shop still ends with arrows.
    const guildRun = (items: string, target: number, spend: number) => ['scripts/shop-buyer.ts', 'dargaud', '800', `ITEMS=${items}`, `STOCK_TARGET=${target}`,
        'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`].join(' ');
    const arrowsGuild: Template = {
        id: 'army-arrows-guild', family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [guildRun('willow.shortbow', 1, 3000), guildRun('mithril.arrow|steel.arrow|iron.arrow|bronze.arrow', ARROW_STOCK, 50000)],
        env: { ROUNDS: '1' }, role: 'supply', goal: 'buy a willow shortbow and arrows up to mithril at the Ranging Guild for the Ranged band',
        tier: 'goal', band: GUILD_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:dargaud'], yields: () => [],
        needs: { skills: { Ranged: 40 }, items: { coins: 60000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    // The same need at Lowe's Archery Emporium in Varrock (archeryshop: bronze 2,000 and iron 1,500 in stock, one back
    // every 10 and 15 ticks). The trip takes the ferries both ways (practice: about 1,300 ticks out, 900 back) and one
    // run brings up to LOWE_STOCK of each, about ten Ranged runs' worth, where Aemad's shelf holds 500 and then gives
    // one arrow every 10 ticks. A third account short of arrows goes here while others hold Aemad's and Hickton's shops.
    const arrowsLowe: Template = {
        id: 'army-arrows-lowe', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['lowe', '2500'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Lowe's in Varrock for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:lowe'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const holdsUnderKeys = (items: readonly string[]) => Object.fromEntries(items.map(i => [i, 1]));
    const zekeShop = (tier: string, item: string, minAtt: number, maxAtt: number, coins: number, better: readonly string[]): Template => ({
        id: `army-weapon-zeke-${tier}`, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zeke', '1200'],
        env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
        role: 'supply', goal: `buy ${item} from Zeke in Al Kharid`, tier: 'goal', band: WEAPON_BAND, stock: { item, to: 1 }, repeats: false,
        resources: ['shop:zeke'], yields: () => [],
        needs: { ...(minAtt > 1 ? { skills: { Attack: minAtt } } : {}), under: { Attack: maxAtt }, items: { coins }, holdsUnder: holdsUnderKeys([item, ...better]) },
    });
    const zekeIron = zekeShop('iron', 'iron scimitar', 1, 5, 400, ['steel scimitar', 'mithril scimitar', ...WEAPON_HELD]);
    const zekeSteel = zekeShop('steel', 'steel scimitar', 5, 20, 800, ['mithril scimitar', ...WEAPON_HELD]);
    const zekeMithril = zekeShop('mithril', 'mithril scimitar', 20, 30, 2000, [...WEAPON_HELD]);
    const scavvoArmour: Template = {
        id: 'army-armour-scavvo', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['scavvo', '1500'],
        env: { ITEMS: 'rune platelegs|rune chainbody', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '120000', COIN_RESERVE: '5000', MAX_SPEND: '115000' },
        role: 'supply', goal: "buy rune platelegs and rune chainbody from Scavvo in the Champions' Guild",
        tier: 'goal', band: ARMOUR_BAND, stock: { item: 'rune platelegs', to: 1 }, repeats: false, resources: ['shop:scavvo'], yields: () => [],
        needs: { skills: { Defence: 40 }, questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 120_000 }, shortOf: { 'rune platelegs': 1, 'rune chainbody': 1 }, holdsUnder: { 'rune platebody': 1 } },
    };
    const nurmofPickaxes: Template[] = PICKAXE_LADDER.map(([lvl, item, coins], idx) => {
        const better = PICKAXE_LADDER.slice(0, idx + 1).map(([, p]) => p);
        const tier = item.split(' ')[0]!;
        return {
            id: `tool-pickaxe-${tier}`, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['nurmof', '1200'],
            env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
            role: 'mining', goal: `buy ${item} from Nurmof in the Dwarven Mine`, repeats: false,
            resources: ['shop:nurmof'], yields: () => [{ item, perTick: 0.01 }],
            needs: { ...(lvl > 1 ? { skills: { Mining: lvl } } : {}), items: { coins }, holdsUnder: holdsUnderKeys(better) },
        };
    });
    const ardyIronAxe: Template = {
        id: 'tool-axe-iron', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['ardy', '1200'],
        env: { ITEMS: 'iron axe', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '300', COIN_RESERVE: '100', MAX_SPEND: '200' },
        role: 'woodcutting', goal: "buy iron axe from Aemad in East Ardougne (Bob's Axes has no profile)", repeats: false,
        resources: ['shop:ardy'], yields: () => [{ item: 'iron axe', perTick: 0.01 }],
        needs: { items: { coins: 300 }, holdsUnder: holdsUnderKeys(['iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe']) },
    };
    return [
        ...goldfarm,
        ...cows,
        ...troopers,
        strike,
        magic,
        splash,
        water,
        waterBetty,
        body,
        staff,
        feathers,
        fireRunes,
        staffGuild,
        natureGuild,
        airGuild,
        magicAir,
        prayer,
        dragonBones,
        bigBones,
        arrows,
        arrowsCatherby,
        arrowsGuild,
        arrowsLowe,
        ranged,
        lostCity,
        ...questDemand(),
        fletch,
        questFletch30,
        fremennik,
        upassThieve,
        upassAgility,
        upass,
        regicide,
        holyGrail,
        dustyKey,
        huntRune,
        hunt,
        huntBronze,
        huntSupplyRune,
        huntSupply,
        jakut,
        zekeIron,
        zekeSteel,
        zekeMithril,
        scavvoArmour,
        ...nurmofPickaxes,
        ardyIronAxe,
        dhideSets,
        leatherFlax,
        leatherSpin,
        prayerField,
        { id: 'thieving55', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: '55', CAP: '2500', CLEAN_FOOD: '1' }, role: 'thieving',
            goal: 'train Thieving to 55 for a knight spot', trains: { skill: 'Thieving', to: 55, unlocks: goldfarm.map(g => g.id) }, yields: () => [] },
        ...CHICKEN_PENS.map((pen): Template => ({
            id: `feathers@${pen}`, family: 'gather-feathers', script: 'scripts/gather-feathers.ts', env: { PEN: pen, TICKS: '3000', TARGET: String(FEATHER_TARGET) }, role: 'helper',
            goal: `feathers at the chicken pen ${pen}`, resources: [`pen:${pen}`], needs: { holdsUnder: { feather: FEATHER_TARGET }, ...(PEN_QUEST_POINTS[pen] ? { questPoints: PEN_QUEST_POINTS[pen] } : {}) },
            // chicken.rs2: 15 feathers 1/4, 5 feathers 1/4 -> 5 a kill; about one kill and pickup per 16 ticks.
            yields: () => [{ item: 'feather', perTick: 0.3 }],
        })),
        { id: 'lobster-chain', family: 'gather-fish', script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'], role: 'fishing',
            goal: 'Catherby lobsters, caught and cooked', needs: { skills: { Fishing: 40, Cooking: 40 }, items: { 'lobster pot': 1 } }, resources: ['catherby:lobster'],
            yields: a => [{ item: 'lobster', perTick: 0.04 + 0.001 * Math.min(59, (a.skills.Fishing ?? 1) - 40) }] },
        { id: 'shop-runes', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['betty'], env: { ITEMS: 'fire rune|air rune|earth rune', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy elemental runes at Betty', needs: { items: { coins: 3000 }, shortOf: { 'fire rune': SHOP_STOCK, 'air rune': SHOP_STOCK, 'earth rune': SHOP_STOCK } }, resources: ['shop:betty'],
            yields: () => [{ item: 'fire rune', perTick: 0.7 }, { item: 'air rune', perTick: 0.7 }, { item: 'earth rune', perTick: 0.7 }], spends: () => [{ item: 'coins', perTick: 2.1 * 5 }] },
        { id: 'shop-feathers', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['sarim'], env: { ITEMS: 'feather', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy feathers at Gerrant', needs: { items: { coins: 2000 }, shortOf: { feather: SHOP_STOCK } }, resources: ['shop:sarim'],
            yields: () => [{ item: 'feather', perTick: 3 }], spends: () => [{ item: 'coins', perTick: 3 * 3 }] },
        { id: 'shop-arrowtips', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby'], env: { ITEMS: 'rune arrowtips|adamant arrowtips', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy rune and adamant arrowtips at Catherby', needs: { items: { coins: 20000 }, shortOf: { 'rune arrowtips': SHOP_STOCK, 'adamant arrowtips': SHOP_STOCK } }, resources: ['shop:catherby'],
            yields: () => [{ item: 'rune arrowtips', perTick: 0.05 }, { item: 'adamant arrowtips', perTick: 0.05 }], spends: () => [{ item: 'coins', perTick: 0.05 * 260 + 0.05 * 104 }] },
        { id: 'fletch-headless', family: 'fletch', script: 'scripts/fletch-arrows.ts', args: ['15000', 'headless'], env: { BANK_PACK: '1', MAX_MAKE: '390' }, role: 'fletching',
            goal: 'headless arrows from owned shafts and feathers', needs: { items: { 'arrow shaft': 215, feather: 215 } },
            yields: () => [{ item: 'headless arrow', perTick: 5 }] },
        // Rune arrows for the route bill at Dargaud's shop in the Ranging Guild, the profile of army-arrows-guild
        // (ranging.inv ranging_guild_bowshop: 400 in stock, one back every 130 ticks, base cost 400; ranging.npc
        // shop_delta 10, so each unit under the full shelf adds 1% of the base cost). The guild door asks Ranged 40
        // (ranging_guild_door.rs2). The run tops the account up to ARROW_LOW rune arrows, pack and bank, and banks
        // them at Seers' Village; an account that holds that many takes no run. RUNE_ARROW_SPEND covers a top-up from
        // none off a full shelf. The rate is an estimate: one top-up in the 800 ticks of the run's cap. Gap: no run
        // buys the rune arrow line of the profile. A pilot.
        { id: 'shop-rune-arrows', pilot: true, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['dargaud', '800'],
            env: { ITEMS: 'rune arrow', STOCK_TARGET: String(ARROW_LOW), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RUNE_ARROW_SPEND + 1000), COIN_RESERVE: '500', MAX_SPEND: String(RUNE_ARROW_SPEND) },
            role: 'bank', goal: "buy rune arrows at Dargaud's shop in the Ranging Guild", resources: ['shop:dargaud'],
            needs: { skills: { Ranged: 40 }, items: { coins: RUNE_ARROW_SPEND + 2000 }, holdsUnder: { 'rune arrow': ARROW_LOW } },
            yields: () => [{ item: 'rune arrow', perTick: ARROW_LOW / 800 }], spends: () => [{ item: 'coins', perTick: RUNE_ARROW_COST / 800 }] },
        ...aioTemplates(),
        ...makerChains(),
        ...squadSupplies(),
        ...makerShopSteps(),
    ];
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
    if (file !== 'scripts/aio.ts' && !wrapper) return [{script: file, args: step.args, env}];
    const [categoryInput, ...categoryArgs] = wrapper ? [wrapper[1]!, ...step.args] : step.args;
    const category = categoryInput?.toLowerCase().replace(/^--category=/, '');
    if (category === 'pipeline') return categoryArgs.flatMap(text => {
        const [head, ...rest] = tokenizeStep(text);
        if (!head) throw Error('resource admission: empty AIO pipeline step');
        const [cat, ...route] = head.includes(':') ? head.split(':') : [head];
        if (cat === 'quester' && route[0] === 'mode') route.shift();
        return resourceSteps({script: 'scripts/aio.ts', args: [cat!, ...route, ...rest], env: {}}, env, depth + 1);
    });
    let spec: {script: string; defaultArgs?: readonly string[]; defaultEnv?: Readonly<Record<string, string>>} | undefined;
    let rest: string[] = [];
    if (category === 'fighter') {
        const [target, ...extra] = categoryArgs, key = target?.toLowerCase().replace(/^--target=/, '');
        if (key === 'cow' || key === 'giant' || key === 'druid' || key === 'trooper') spec = {script: 'scripts/gather-combat.ts', defaultEnv: {TARGET: key}};
        if (key === 'chicken') spec = {script: 'scripts/train-chickens.ts', defaultEnv: {TRAIN_BANK: 'draynor'}};
        if (key === 'ranged') spec = {script: 'scripts/ranged-train.ts'};
        rest = extra;
    } else if (category === 'boss') {
        if (categoryArgs[0]?.toLowerCase().replace(/^--boss=/, '') === 'black-dragon') spec = {script: 'scripts/black-dragon-camp.ts'};
        rest = categoryArgs.slice(1);
    } else if (category === 'market') {
        if (categoryArgs[0]?.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '') === 'shop-buy') spec = {script: 'scripts/shop-buyer.ts'};
        rest = categoryArgs.slice(1);
    } else if (category === 'skiller') {
        const [skillInput, methodInput, ...extra] = categoryArgs, skill = skillInput?.toLowerCase().replace(/^--skill=/, '');
        // Inline profiles are self-contained; resource admission never reads job files.
        if (skill === 'bank-job') return [{script: 'scripts/aio-skiller.ts', args: ['bank-job', ...categoryArgs.slice(1)], env}];
        const {method,args} = resolveSkillerMethod(skill ?? '', methodInput, extra);
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
        if (route) spec = {script: route[1]!, ...(route[0] === 'magic:splash-coop' ? {defaultEnv: {SPLASH_SITE: 'coop'}} : {})};
        if (skill === 'fishing' && (method === 'cage' || method === 'harpoon' || method === 'gather-fish')) spec = {script: 'scripts/gather-fish.ts', defaultArgs: [method === 'gather-fish' ? 'cage' : method]};
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
    if (Array.isArray(job.resources)&&script!=='scripts/ranged-train.ts') return job.resources.filter(r => typeof r === 'string');
    const chained = script === 'scripts/chain.ts';
    let direct: Step = {script, args: job.args ?? [], env: {}};
    // Preserve the direct-job metadata convention, while AIO gets its own argv so
    // route defaults and explicit KEY=value options keep the execution precedence.
    if (!chained && !/^scripts\/aio(?:-[a-z]+)?\.ts$/.test(script)) {
        direct = {script, args: [], env: {}};
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
            const method=env.PROGRESSION_METHOD;
            if(method==='ranged/chickens'||method==='ranged/chickens-oak')out.push('pen:3229,3298');
            else if(method==='ranged/troopers'||method==='ranged/troopers-oak'||method==='ranged/troopers-willow'||method==='ranged/troopers-maple'||method==='ranged/guild-willow-mithril')out.push(TROOPER_FIELD);
            else out.push('pen:3229,3298',TROOPER_FIELD);
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
    return [...new Set([...out,...(script==='scripts/ranged-train.ts'&&Array.isArray(job.resources)?job.resources.filter(r=>typeof r==='string'&&r!=='pen:3229,3298'&&r!==TROOPER_FIELD):[])])];
}

// The freshest of an account's observations by `at`: its status file and its row in the side's fleet snapshot. A fresh
// cloud container has no status files, so without the snapshot every account would plan as a level-1 start.
export function freshest(...observations: readonly any[]): any {
    return observations.filter(o => o && typeof o === 'object').reduce((best, o) => (Number(o.at) || 0) > (Number(best?.at) || 0) ? o : best, null);
}

// An account as the planner sees it, from its status file (.practice/status/<name>.json) or a fleet snapshot row:
// base levels, pack, bank and worn counts by item name, and its complete quests (a status lists every quest with a
// state, a snapshot row the complete ones by name), and the tile it stands on (a status only). No status: a fresh
// account at level 1 (Hitpoints 10).
const EXACT_ITEM_ALIASES: ReadonlyMap<number, string> = new Map([
    [1747, 'dragonhide_black'],
    [2509, 'dragon_leather_black'],
    [2503, 'black_dragonhide_body'],
    [2497, 'black_dragonhide_chaps'],
    [2491, 'black_dragon_vambraces'],
    [985, 'keyhalf1'],
    [987, 'keyhalf2'],
    [1683, 'unstrung dragonstone amulet'],
    [1702, 'strung dragonstone amulet'],
    [3146, 'poorly cooked karambwan'],
    [91, 'guam potion (unf)'],
    [93, 'marrentill potion (unf)'],
    [95, 'tarromin potion (unf)'],
    [97, 'harralander potion (unf)'],
    [99, 'ranarr potion (unf)'],
    [101, 'irit potion (unf)'],
    [103, 'avantoe potion (unf)'],
    [105, 'kwuarm potion (unf)'],
    [107, 'cadantine potion (unf)'],
    [109, 'dwarf weed potion (unf)'],
    [111, 'torstol potion (unf)'],
    [2483, 'lantadyme potion (unf)'],
    [3002, 'toadflax potion (unf)'],
    [3004, 'snapdragon potion (unf)'],
    [199, 'unidentified guam'],
    [201, 'unidentified marentill'],
    [203, 'unidentified tarromin'],
    [205, 'unidentified harralander'],
    [207, 'unidentified ranarr'],
    [209, 'unidentified irit'],
    [211, 'unidentified avantoe'],
    [213, 'unidentified kwuarm'],
    [215, 'unidentified cadantine'],
    [217, 'unidentified dwarf weed'],
    [219, 'unidentified torstol'],
    [2485, 'unidentified lantadyme'],
    [3049, 'unidentified toadflax'],
    [3051, 'unidentified snapdragon'],
]);
export function accountFrom(name: string, side: string, status: any, itemName: (id: number) => string | undefined): Acct {
    const skills: Record<string, number> = { Hitpoints: 10 }, items: Record<string, number> = {}, exact: Record<string, number> = {};
    for (const k of Array.isArray(status?.skills) ? status.skills : []) if (typeof k?.name === 'string' && Number.isFinite(k.level)) skills[k.name] = k.level;
    const validHP = (hp: unknown): hp is number => Number.isSafeInteger(hp) && (hp as number) >= 0;
    const sharedHP = (Array.isArray(status?.skills) ? status.skills : []).find((k: any) => k?.name === 'Hitpoints')?.currentLevel;
    const currentHP = validHP(status?.hp?.now) ? status.hp.now : validHP(sharedHP) ? sharedHP : undefined;
    for (const r of [status?.inventory, status?.bank, status?.equipment].flatMap(x => Array.isArray(x) ? x : [])) {
        const n = typeof r?.name === 'string' ? r.name : itemName(r?.baseId ?? r?.id);
        const itemId = r?.baseId ?? r?.id;
        const alias = bowStockNames.get(itemId) ?? EXACT_ITEM_ALIASES.get(itemId);
        const key = alias ?? (n && !(norm(n) in BOW_IDS) ? norm(n) : undefined);
        if (key && Number.isFinite(r.count)) items[key] = (items[key] ?? 0) + r.count;
        if (key && Number.isFinite(r.count) && (r?.baseId === undefined || r.baseId === r.id)) exact[key] = (exact[key] ?? 0) + r.count;
        // The held-bones Prayer worker deposits and buries only id526. Keep notes in generic stock for trades and
        // other consumers, while this availability key admits only the exact normal bones that worker can use.
        if (r?.id === 526 && Number.isFinite(r.count)) items['bone (unnoted)'] = (items['bone (unnoted)'] ?? 0) + r.count;
    }
    const quests = Array.isArray(status?.quests)
        ? new Set<string>(status.quests.flatMap((q: any) => typeof q === 'string' ? [norm(q)] : typeof q?.name === 'string' && q.state === 'complete' ? [norm(q.name)] : [])) : undefined;
    const questPoints = status?.guildFacts?.varps?.qp, p = status?.pos;
    return { name, side, skills, items, ...(status ? { exact } : {}), ...(Number.isFinite(status?.at) && status.at > 0 ? { observedAt: status.at } : {}), ...(currentHP !== undefined ? { currentHP } : {}), ...(Number.isFinite(status?.combat) ? { combat: status.combat } : {}), ...(quests ? { quests } : {}), ...(Number.isFinite(questPoints) ? { questPoints } : {}),
        ...(Number.isFinite(p?.x) && Number.isFinite(p?.z) ? { pos: { x: p.x, z: p.z, level: Number.isFinite(p.level) ? p.level : 0 } } : {}) };
}

// This side's new swarm job list: every job without this side's marker stays as it is; a planner job whose account
// keeps its template stays unchanged (its swarm revision and run go on); a changed or new assignment gets a fresh job.
// The accounts this side's planner may give a job: those a marked job names (handed over), or those no job names at all
// (a fresh account). An enabled unmarked job (a hand job or a coordinator run) keeps its account, a reservation (no
// script) keeps its account, and an owner pause (a stop file) keeps its account. An unmarked job that is off holds an
// account only when no marked job names it: a finished coordinator run does not block a handover, but by itself it
// frees nothing, since the coordinator may plan that account next.
// The accounts that a swarm.json reservation holds: a job that is no planner job of `side` and has no script (the main and
// specialist accounts, the gang squad). A reservation gives no job to its account (plannableAccounts) and no stock or coins to
// another account (the donor filters of scripts/autopilot.ts); an order that gives TO it still runs.
export function reservedAccounts(jobs: readonly any[], side: string): Set<string> {
    return new Set(jobs.filter(j => j?.autopilot !== side && !j?.script).flatMap(j => [j?.account, ...(j?.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}
export function plannableAccounts(jobs: readonly any[], side: string, listed: readonly string[], paused: ReadonlySet<string>): string[] {
    const names = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean).map((a: string) => a.toLowerCase());
    const mine = (j: any) => j?.autopilot === side;
    const hard = new Set(jobs.filter(j => !mine(j) && (j?.enabled !== false || !j?.script)).flatMap(names));
    const optIn = new Set(jobs.filter(mine).flatMap(names)), named = new Set(jobs.flatMap(names));
    return listed.filter(n => { const k = n.toLowerCase(); return !hard.has(k) && !paused.has(k) && (optIn.has(k) || !named.has(k)); });
}

const jobNames = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter(Boolean) as string[];

// Resources the jobs in the file hold against this side's planning: every enabled unmarked job, and every enabled
// marked job whose account is paused (a stop file; mergeJobs keeps that job as it is, so its pen or spot stays its own).
export function reservedResources(jobs: readonly any[], side: string, paused: ReadonlySet<string>): Record<string, number> {
    const taken: Record<string, number> = {};
    const holds = (j: any) => j?.enabled !== false && (j?.autopilot !== side || jobNames(j).some(a => paused.has(a.toLowerCase())));
    for (const j of jobs) if (holds(j)) for (const r of jobResources(j)) taken[r] = (taken[r] ?? 0) + 1;
    return taken;
}

// This side's fleet claim (fleet/claims/<side>.json on the fleet-data branch): every exclusive resource an enabled job
// of this side's own accounts holds, planner-made or hand-made, from the plan the swarm runs, when one of the job's
// accounts is `active` (scripts/fleet-sync.ts: seen in the world within CLAIM_MAX_AGE_MS). A plan with more enabled
// jobs than the swarm admits parks some for days; a parked job's spot is free for the other sides, and when the job
// does start, the planner that took the spot sees this side's claim on its next pass and moves its account. fleet-sync
// writes the claim on every sync, so it never depends on the planner running; scripts/autopilot.ts on every side
// ignores a claim older than CLAIM_MAX_AGE_MS, so a side that stops syncing releases its spots. A resource is listed
// once for each active worker that holds it, so a host's farmers each count at a shared spot.
export const CLAIM_MAX_AGE_MS = 2 * 3600_000;
export function claimFor(jobs: readonly any[], side: string, sideOf: (account: string) => string, now = Date.now(), active: (account: string) => boolean = () => true): { side: string; at: number; resources: string[] } {
    const held = jobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => sideOf(a) === side) && jobNames(j).some(active))
        .flatMap(j => jobResources(j.host && !j.orchestrate ? {...j, accounts: jobNames(j).filter(active)} : j));
    return { side, at: now, resources: held.sort() };
}

// A recovery the coordinator runs for an account (scripts/session-check.ts, coordinatorOwner "coordinator") shadows that
// account's own job in the merged plan (packages/core/src/coordinator-jobs.ts mergeJobs). The account returns to its own
// job, so the side's claim keeps that job's places while the recovery runs; without them the other sides see the places
// free and fill them. Other coordinator work keeps the merged plan's claim.
export const RECOVERY_JOB_SCRIPT = 'scripts/session-check.ts';
export function recoveringOwnerJobs(ownerJobs: readonly any[], coordinatorJobs: readonly any[]): any[] {
    const script = (j: any) => String(j?.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    const recovering = new Set(coordinatorJobs.filter(j => j?.coordinatorOwner === 'coordinator' && script(j) === RECOVERY_JOB_SCRIPT)
        .flatMap(jobNames).map(a => a.toLowerCase()));
    return ownerJobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => recovering.has(a.toLowerCase())));
}

// A marked job whose account is in `keep` (an owner pause: a stop file) stays as it is, with its enabled and repeat
// settings, so lifting the pause later resumes that job instead of handing the account a fresh enabled one.
// `finished`: the accounts (lower case) whose planner job has a RESULT ok since its assignment (finishedTrainers). A planner job that a
// coordinator hold or a running buy keeps cannot be replaced by this pass; if it repeats and has finished, it stops repeating, so the
// swarm does not log the account in again every few seconds for a result that is already in (live: Pocketpython, 146 results of
// ticks=10 from `stop=stock-target targetMet=1`). The job stays as a record, and the pass that frees the account replaces it.
export function mergeJobs(jobs: readonly any[], side: string, out: readonly Assignment[], keep: ReadonlySet<string> = new Set(), finished: ReadonlySet<string> = new Set()): { jobs: any[]; fresh: string[] } {
    const mine = (j: any) => j?.autopilot === side, kept = (j: any) => [j?.account, ...(j?.accounts ?? [])].some((a: string) => a && keep.has(a.toLowerCase()));
    const done = (j: any) => mine(j) && j.enabled !== false && j.repeat === true && typeof j.account === 'string' && finished.has(j.account.toLowerCase());
    const next = jobs.filter(j => !mine(j) || kept(j)).map(j => done(j) ? { ...j, repeat: false } : j), fresh: string[] = [];
    for (const x of out) {
        if (!x.template) continue;
        // A job keeps its run only while it still runs its template (script, args and env, as the swarm signs a mission):
        // a hand edit, or a template changed in code, gets a fresh job.
        const prior = jobs.find(j => mine(j) && j.account === x.account && j.template === x.template!.id);
        if (prior && missionSignature(prior) === missionSignature(jobFor(x, side))) { next.push(prior); continue; }
        fresh.push(x.account);
        // An owner pause belongs to the account: a new template keeps it disabled and keeps its repeat policy.
        const paused = jobs.find(j => mine(j) && j.account === x.account && j.enabled === false);
        next.push(paused ? { ...jobFor(x, side), enabled: false, repeat: paused.repeat } : jobFor(x, side));
    }
    return { jobs: next, fresh };
}
