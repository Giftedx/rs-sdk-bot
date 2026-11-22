// Core autopilot domain types, name/key normalization, combat level calculation, and quest progress helpers.
import type { BillRow } from '../../supply-bill';
import type { SquadInput } from '../../squad';
import type { GearWantRow } from '../../gear-want-jobs';

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
export type Spot = { x: number; z: number; level?: number };
export type QuestDemandRow = { slug: string; name: string; ticks: number; skills: Record<string, number>; quests: string[]; questPoints?: number; items: Record<string, number>; meals: number; wilderness?: true };

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
