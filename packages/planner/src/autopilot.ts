// Autopilot: writes a fleet side's swarm jobs from the route supply bill, account skills and holdings, and tick waste,
// so no person picks jobs, restarts ended ones or spots loops (plan Lanes table, Autopilot).
// plan() is pure: one assignment per account of this side, highest value per tick first, from proven templates only,
// never more accounts on one resource (a knight spot, a chicken pen, a shop) across all sides than its capacity
// (CAPACITY: four farmers to a knight spot, one to a pen or a shop). A job on a resource other accounts already hold
// keeps that resource's shared rate of its value once per holder (SHARED), so the empty spots fill first.
// Value is an estimate in coins per game tick: each output's rate times its unit value, minus coin spend, times the
// script family's measured work share (1 - idle - move, scripts/tick-waste.ts). A training template is worth a share
// of the best job it unlocks, and reserves that job's resource. assess() reads a job's recent log lines and retires
// it after repeated fail RESULTs or a run that was nearly all idle and walking. finishedTrainers() names the accounts
// whose trainer reached its target, so the next pass needs no timer. scripts/autopilot.ts applies it.
import type { BillRow } from './supply-bill';
import { missionSignature } from '../../core/src/session-admission';
import { xpForLevel } from './curve';

// `combat`: the combat level the account's status reports (absent: worked out from `skills`). `quests`: the quests its
// status reports complete, by norm() name (absent: none known complete). `questPoints`: the quest points its status
// reports (absent: none known, which counts as 0).
export type Acct = { name: string; side: string; skills: Record<string, number>; items: Record<string, number>; combat?: number; quests?: ReadonlySet<string>; questPoints?: number };
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
export type Needs = {
    combat?: number; quests?: readonly string[]; questPoints?: number; frail?: { hitpoints: number; of: readonly string[]; count: number };
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
    // A goal band whose target is a holding: it stands while the account holds fewer than `to` of `item`.
    stock?: { item: string; to: number };
    // Kit lines the band's own supply job brings (the hunt's shop run): the kit tier neither buys them on the market
    // nor asks another account for them.
    ownSupply?: readonly string[];
    // An AIO route (scripts/aio.ts): `aio` is its bench key (scripts/measure/aio-bench-cases.ts) and `worker` the script
    // the dispatcher runs, so a retirement lapses when the worker changes, not only the dispatcher.
    aio?: string; worker?: string;
    // Proved on practice only. The planner gives it only while the plan's `aio` list names its id (Inputs.pilots), so
    // each first live run is a bounded pilot the owner starts.
    pilot?: true;
    // A goal band whose missing kit is bought as a candidate of the band itself, as the weapon buy is: an account that
    // can start a later band still gets it. Without the flag a kit is bought only when no band can start.
    kitFirst?: true;
    // A band whose kit only a shop job of its own brings: the kit tier neither buys nor asks a donor for it.
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
// places the fleet order), and the account takes the job on the pass after the coins arrive.
export type Funding = { from: string; to: string; coins: number; template: string };
export type Assignment = { account: string; template?: Template; value: number; reason: string; resources: string[]; fund?: Funding; send?: ItemFunding };
export type Inputs = {
    side: string; accounts: readonly Acct[]; owners: ReadonlyMap<string, { side: string }>; bill: readonly BillRow[];
    templates: readonly Template[]; prices: Readonly<Record<string, number>>; waste?: Readonly<Record<string, number>>;
    taken?: Readonly<Record<string, number>>; retired?: ReadonlySet<string>; capacity?: Readonly<Record<string, number>>;
    // The share of its value a job keeps on a resource another account already holds (default 1).
    shared?: Readonly<Record<string, number>>;
    // The template each account holds now, by lower-case name: on a value tie the account keeps it.
    current?: ReadonlyMap<string, string>;
    // Accounts of this side free to trade now (no enabled swarm job), with their coins. Each keeps FUND_RESERVE.
    donors?: readonly { name: string; coins: number }[];
    // Lower-case names of accounts with an enabled job. Funding one would remove its running job, and the stop file
    // scripts/swarm.ts writes for it would block the trade, so such an account is never funded.
    unfundable?: ReadonlySet<string>;
    // Lower-case names of the accounts on this side's army roster: only they take goal bands. A specialist's board
    // time counts every tick it plays, so combat training is opt-in per account, never global.
    army?: ReadonlySet<string>;
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
    // What one coin is worth to this side now (coinValueFor; default 1).
    coinValue?: number;
    // Each account's kit-buy count, by lower-case name (kitBuyTemplate `seq`; default 0).
    kitSeq?: ReadonlyMap<string, number>;
    // Donor and recipient pairs whose item order failed lately, as `from>to` in lower case: no new order for them.
    noSend?: ReadonlySet<string>;
    // The ids of the `pilot` templates this plan admits (its `aio` list). Absent: none.
    pilots?: ReadonlySet<string>;
};
export const FUND_RESERVE = 50_000;
// The template id of a kit buy for a goal band: `kit-buy:<band id>`. A retired pair (two fail RESULTs with no
// progress: no stock under the cap) sends the account to the donors instead.
export const KIT_BUY = 'kit-buy:', KIT_BUY_SCRIPT = 'scripts/buy-owned-ge-item.ts';
// The army's melee weapon. Most army accounts fight with the bronze sword they started with: at Strength 99 it hits 12
// at most, an adamant scimitar 15 or 16 by style (combat.rs2 combat_maxhit: (effective * (64 + strength bonus) + 320) /
// 640, effective 107 to 110, bonus 5 and 28). The trainer wields the best blade the account owns (scripts/gather-combat.ts selectGiantWeapon), so the
// planner only has to put one in the bank: an army account with Attack 30 and no blade of WEAPON_HELD buys one adamant
// scimitar on the Grand Exchange, as a kit buy, at WEAPON_BAND: before its Ranged band, so every account gets one now
// (owner: all of them, until rune blades arrive), WEAPON_BUYERS accounts away for it at a time.
export const WEAPON = { id: 'army-weapon', item: 'adamant scimitar', attack: 30, goal: 'fight with an adamant scimitar' } as const;
export const WEAPON_HELD = ['adamant scimitar', 'adamant sword', 'adamant longsword', 'rune scimitar', 'rune sword', 'rune longsword', 'dragon longsword'] as const;
export const WEAPON_BAND = 3.5, WEAPON_BUYERS = 2, WEAPON_MARKET = 'ge:weapon';
// The quest band of the army: after the blade, before Ranged, so an account does its quests once and goes back to
// training. One account at a time does Lost City: its tree spirit serves one fighter (practice: of three accounts at
// the dramen tree together one finished and two ended "Someone else is fighting that"). LOST_CITY_MEALS is the food
// the run carries with no prayer potion (scripts/quest-sweep.ts STURDY_MEALS).
export const QUEST_BAND = 3.6, LOST_CITY = 'quest:lostcity', LOST_CITY_PLACES = 1, LOST_CITY_MEALS = 10;
// Holy Grail after Merlin's Crystal: 275,000 Prayer experience at the server's rate (quest_grail; research/quest-plan.md
// 1k), what about 150 bought dragon bones give. One account at a time: Sir Mordred and the Black Knight Titan are
// single fights. GRAIL_RUNES: the two quests' teleports (Falador five times, Camelot five, Varrock once).
export const GRAIL_BAND = QUEST_BAND + 0.1, GRAIL_PLACE = 'quest:camelot', GRAIL_PLACES = 1, GRAIL_MEALS = 12;
export const GRAIL_RUNES: Readonly<Record<string, number>> = { 'law rune': 12, 'air rune': 46, 'water rune': 6, 'fire rune': 1 };
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
export const REGICIDE_RUNES: Readonly<Record<string, number>> = { 'law rune': 5, 'air rune': 3, 'water rune': 5 };
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

// A bill line still short is worth twice its shop value: it is acquisition work the route needs. A unit nobody needs
// is worth half, the price a sale would fetch. A share of a job a training run unlocks counts for the training.
export const BILL_PREMIUM = 2, SURPLUS = 0.5, TRAIN_SHARE = 0.25;
// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
export const FEEDS: Record<string, string[]> = { feather: ['headless arrow'], 'arrow shaft': ['headless arrow'], 'raw lobster': ['lobster'],
    log: ['arrow shaft', 'headless arrow'], flax: ['bow string'], 'rune essence': ['air rune'] };
export const norm = (s: string) => s.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim().replace(/s$/, '');
export const pairKey = (account: string, template: string) => `${account.toLowerCase()}:${template}`;
// HP one held item heals over all its bites, by item name: scripts/gather-combat.ts COW_FOOD_BITES × COW_BITE_HEAL
// (trout 7; a cake bite 4, a chocolate cake bite 5). scripts/autopilot.test.ts checks the two tables agree.
export const FOOD_HEAL: Readonly<Record<string, number>> = {
    trout: 7, cake: 12, '2/3 cake': 8, 'slice of cake': 4, 'chocolate cake': 15, '2/3 chocolate cake': 10, 'chocolate slice': 5,
};
export const foodHeal = (a: Acct) => Object.entries(FOOD_HEAL).reduce((n, [item, hp]) => n + (a.items[item] ?? 0) * hp, 0);

// Gold is a supply, never a goal (AGENTS.md). A side that banks COIN_GLUT coins or more holds more than its kits and
// supplies cost, so one more coin is worth COIN_GLUT_VALUE: a coin job then ranks under every job that makes a short
// bill line, and stays only as the last job for an account nothing else fits. Estimate: the level is not priced from
// the bill.
export const COIN_GLUT = 10_000_000, COIN_GLUT_VALUE = 0.01;
export const coinValueFor = (sideCoins: number) => sideCoins >= COIN_GLUT ? COIN_GLUT_VALUE : 1;
export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>, coin = 1): number {
    const k = norm(item);
    if (k === 'coin') return coin;
    const short = new Set(bill.filter(r => r.short > 0).flatMap(r => [r.item, ...(r.aliases ?? [])].map(norm)));
    return (prices[k] ?? 0) * (short.has(k) || (FEEDS[k] ?? []).some(f => short.has(f)) ? BILL_PREMIUM : SURPLUS);
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
const isShort = (a: Acct, needs: Template['needs']) => (!needs?.shortOf || Object.entries(needs.shortOf).some(([i, n]) => (a.items[norm(i)] ?? 0) < n))
    && Object.entries(needs?.holds ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) >= n);
// The items a frail account is short of for these needs: 0 for an account with the Hitpoints, or with no such need.
const frailShort = (a: Acct, needs: Template['needs']) => !needs?.frail || (a.skills.Hitpoints ?? 10) >= needs.frail.hitpoints ? 0
    : Math.max(0, needs.frail.count - needs.frail.of.reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0));
const meets = (a: Acct, needs: Template['needs'], skillOverride?: { skill: string; to: number }): boolean =>
    (a.combat ?? combatLevel(a.skills)) >= (needs?.combat ?? 0)
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

// The kit lines an account still lacks for these needs, or null when a level it does not have (or a holding it must
// not have) stops the job: no item fixes that. The coin line is not a kit line (coinShort). Of several `anyOf`
// kits the account takes one whose every line it `can` get (a buy: 250 fire runes, not a fire staff no market sells),
// then the one with the fewest missing units.
export function kitLacks(a: Acct, needs: Template['needs'], can: (item: string) => boolean = () => true): Lack[] | null {
    if ((a.combat ?? combatLevel(a.skills)) < (needs?.combat ?? 0) || !(needs?.quests ?? []).every(q => questDone(a, q))
        || (a.questPoints ?? 0) < (needs?.questPoints ?? 0)
        || !Object.entries(needs?.skills ?? {}).every(([s, l]) => (a.skills[s] ?? 1) >= l)
        || !Object.entries(needs?.under ?? {}).every(([s, l]) => (a.skills[s] ?? 1) < l)
        || !Object.entries(needs?.holdsUnder ?? {}).every(([i, n]) => (a.items[norm(i)] ?? 0) < n) || !isShort(a, needs)) return null;
    const out: Lack[] = [];
    for (const [i, n] of Object.entries(needs?.items ?? {})) {
        const short = n - (a.items[norm(i)] ?? 0);
        if (norm(i) !== 'coin' && short > 0) out.push({ of: [norm(i)], count: short });
    }
    const hp = (needs?.food ?? 0) - foodHeal(a);
    if (hp > 0) out.push({ of: ['trout'], count: Math.ceil(hp / FOOD_HEAL.trout!) });
    const pieces = (needs?.pieces?.count ?? 0) - (needs?.pieces?.of ?? []).reduce((n, i) => n + (a.items[norm(i)] ?? 0), 0);
    if (pieces > 0) out.push({ of: needs!.pieces!.of.map(norm), count: pieces });
    const frail = frailShort(a, needs);
    if (frail > 0) out.push({ of: needs!.frail!.of.map(norm), count: frail });
    if (needs?.anyOf) {
        const units = (lacks: readonly Lack[]) => lacks.reduce((n, l) => n + l.count, 0), blocked = (lacks: readonly Lack[]) => lacks.filter(l => !l.of.some(can)).length;
        const kits = needs.anyOf.map(alt => kitLacks(a, alt, can)).filter((k): k is Lack[] => k !== null).sort((x, y) => blocked(x) - blocked(y) || units(x) - units(y));
        if (!kits.length) return null;
        out.push(...kits[0]!);
    }
    return out;
}
// The most of each item any goal band needs to start, by norm() name: a donor keeps that many, so it never gives away
// its own kit. For `own`, also the batch a band works out for that account (the runes its Magic still casts). A band
// for build accounts only is left out: its kit (310 arrow shafts and feathers) is not a kit of the donors.
export function kitReserve(templates: readonly Template[], own?: Acct): Record<string, number> {
    const reserve: Record<string, number> = {};
    const count = (needs: Template['needs']) => {
        for (const [i, n] of Object.entries(needs?.items ?? {})) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
        for (const i of needs?.pieces?.of ?? []) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, needs!.pieces!.count);
        for (const alt of needs?.anyOf ?? []) count(alt);
    };
    for (const t of templates) if (t.tier === 'goal' && !t.buildOnly) {
        count(t.needs);
        if (own && t.batchFor) for (const [i, n] of Object.entries(t.batchFor(own))) reserve[norm(i)] = Math.max(reserve[norm(i)] ?? 0, n);
    }
    delete reserve.coin;
    return reserve;
}
// One Grand Exchange order of a kit buy. `held` is what the account holds now: the buy script tops up exactly that many.
export type KitLine = { item: string; id: number; quantity: number; held: number; limit: number };
// The job that buys an army account's missing kit for a goal band: one login, one capped order per item
// (scripts/chain.ts runs scripts/buy-owned-ge-item.ts once per line). The buy script keeps one journal per order key
// and never buys again under a settled key. The key names the account's kit-buy count (`seq`, which
// scripts/autopilot.ts raises when the account leaves a kit buy) and the holding before and after: a rerun of one buy
// continues its order, and a later top-up from the same holding is a new order. Not a trainer: it does not repeat, and
// the account takes the band on the pass after its RESULT.
export function kitBuyTemplate(band: Template, account: string, lines: readonly KitLine[], seq = 0): Template {
    const step = (l: KitLine) => [KIT_BUY_SCRIPT, `ITEM_ID=${l.id}`, `QUANTITY=${l.quantity}`, ...(l.held > 0 ? [`EXPECTED_OWNED=${l.held}`] : []), `LIMIT_PRICE=${l.limit}`,
        `CASH_RESERVE=${KIT_CASH_RESERVE}`, `ORDER_KEY=${account.toLowerCase()}-kit${seq}-${l.id}-${l.held}to${l.held + l.quantity}`, 'ORDER_MS=900000', 'FILL_WAIT_TICKS=200'].join(' ');
    return { id: KIT_BUY + band.id, family: 'kit-buy', script: 'scripts/chain.ts', args: lines.map(step), env: { ROUNDS: '1' }, role: 'supply',
        goal: `buy ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} on the Grand Exchange to ${band.goal}`, repeats: false, yields: () => [] };
}

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste' | 'coinValue'>): number {
    const coin = inp.coinValue ?? 1;
    const gross = t.yields(a).reduce((v, f) => v + f.perTick * unitValue(f.item, inp.bill, inp.prices, coin), 0);
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? coin : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
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
    // Normal bones give 112.5 Prayer XP each, under the XP of one level from level 6 up, and the worker counts its
    // buries from the XP still needed (planPrayer). A band of bought bones (BONE_ID) is refused: one dragon bone gives
    // 1,800 XP, more than the level after 43.
    if (t.script === 'scripts/train-prayer.ts' && t.env?.BONE_ID === undefined && !t.batchFor) return { ...t, args: [String(to)], trains: { ...t.trains, to } };
    return t.trains.to <= level ? t : null;
}

export function plan(inp: Inputs): Assignment[] {
    const byId = new Map(inp.templates.map(t => [t.id, t]));
    const mine = inp.accounts.filter(a => (inp.owners.get(a.name.toLowerCase())?.side ?? 'local') === inp.side && a.side === inp.side);
    type Cand = { account: string; template: Template; value: number; resources: string[]; reason: string; coins?: number; goal?: { band: number; left: number }; lacks?: Lack[] };
    const cands: Cand[] = [];
    const admitted = (t: Template) => !t.pilot || !!inp.pilots?.has(t.id);
    const shopLine = (l: Lack) => !l.of.some(i => inp.market?.[i]) && l.of.some(i => SHOP_SUPPLIED.has(i));
    for (const a of mine) for (const listed of inp.templates) {
        const t = buildBand(listed, a, inp.builds?.get(a.name.toLowerCase()), inp.buildQuests?.get(a.name.toLowerCase()), inp.buildBefore?.get(a.name.toLowerCase()));
        if (!t || inp.retired?.has(pairKey(a.name, t.id)) || !admitted(t)) continue;
        if (t.quest && t.tier !== 'goal') {
            if (questDone(a, t.quest.name) || !meets(a, t.needs)) continue;
            const after: Acct = { ...a, quests: new Set([...(a.quests ?? []), norm(t.quest.name)]) };
            for (const u of t.quest.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                if (!meets(after, u.needs)) continue;
                const value = TRAIN_SHARE * jobValue(u, after, inp);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `completes ${t.quest.name} for ${u.id}` });
            }
            continue;
        }
        if (t.tier === 'goal') {
            // One candidate per goal band whose target an army account has not met; never for anyone else. A band's
            // target is a skill level, or a quest: that one stands until the account's status lists the quest complete,
            // and an account whose status names no quests gets none.
            const left = bandLeft(t, a);
            if (!inp.army?.has(a.name.toLowerCase()) || left <= 0) continue;
            const goal = { band: t.band ?? 0, left }, reason = t.trains ? `army band ${goal.band}: ${t.trains.skill} to ${t.trains.to}` : t.quest ? `army band ${goal.band}: ${t.quest.name}` : `army band ${goal.band}: ${t.stock!.to} ${t.stock!.item}`;
            if (meets(a, t.needs)) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal });
            else if (inp.donors?.length && !inp.unfundable?.has(a.name.toLowerCase()) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs)))
                cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, coins: coinShort(a, t.needs) });
            else if (coinShort(a, t.needs) === 0) {
                // The band lacks only kit items: a buy with the account's own coins, or a free account's spare stock.
                // A line no market sells and a shop job brings (shopLine) is left to that job.
                const lacks = kitLacks(a, t.needs, i => !!inp.market?.[i]), buys = t.kitFirst ? (lacks ?? []).filter(l => !shopLine(l)) : [];
                const picks = buys.map(l => l.of.filter(i => inp.market?.[i]).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]);
                // The band's batch for the account when it can pay for it, else what the band needs to start.
                const batchOf = t.batchFor?.(a) ?? t.batch, price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0);
                const sized = (batch: boolean): KitLine[] => picks.length && picks.every(p => p !== undefined) ? picks.map((p, n) => { const held = a.items[p!] ?? 0, m = inp.market![p!]!;
                    return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(buys[n]!.count, batch ? (batchOf?.[p!] ?? 0) - held : 0) }; }) : [];
                const afford = (ls: readonly KitLine[]) => (a.items.coin ?? 0) >= price(ls) + KIT_CASH_RESERVE + (t.needs?.items?.coins ?? 0);
                const lines = afford(sized(true)) ? sized(true) : sized(false), cost = price(lines);
                if (lines.length && afford(lines) && !inp.retired?.has(pairKey(a.name, KIT_BUY + t.id)))
                    cands.push({ account: a.name, template: kitBuyTemplate(t, a.name, lines, inp.kitSeq?.get(a.name.toLowerCase()) ?? 0), value: 0, resources: [],
                        reason: `army band ${goal.band}: buys ${lines.map(l => `${l.quantity} ${l.item}`).join(', ')} for ${t.id}, at most ${cost} coins`, goal });
                else if (lacks?.length && !t.shopKit) cands.push({ account: a.name, template: t, value: 0, resources: t.resources ?? [], reason, goal, lacks });
            }
            continue;
        }
        if (t.trains) {
            if ((a.skills[t.trains.skill] ?? 1) >= t.trains.to || !meets(a, t.needs)) continue;
            const trained: Acct = { ...a, skills: { ...a.skills, [t.trains.skill]: t.trains.to } };
            for (const u of t.trains.unlocks.map(id => byId.get(id)).filter((u): u is Template => !!u && admitted(u) && !inp.retired?.has(pairKey(a.name, u.id)))) {
                // The frail rule counts what the account holds when the unlocked job starts, which is not known yet.
                if (!meets(a, { ...u.needs, frail: undefined }, t.trains)) continue;
                const value = TRAIN_SHARE * jobValue(u, trained, inp);
                if (value > 0) cands.push({ account: a.name, template: t, value, resources: [...(t.resources ?? []), ...(u.resources ?? [])], reason: `trains ${t.trains.skill} ${t.trains.to} for ${u.id}` });
            }
        } else if (meets(a, t.needs)) {
            const value = jobValue(t, a, inp);
            if (value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+') });
        } else if (inp.donors?.length && !inp.unfundable?.has(a.name.toLowerCase()) && coinShort(a, t.needs) > 0 && meets(a, withoutCoins(t.needs))) {
            const value = jobValue(t, a, inp);
            if (value > 0) cands.push({ account: a.name, template: t, value, resources: t.resources ?? [], reason: t.yields(a).map(f => f.item).join('+'), coins: coinShort(a, t.needs) });
        }
    }
    // The weapon buy (WEAPON): a kit buy made for the account, offered as a goal candidate so it comes before the melee
    // bands even while one of them can start. The buy script refuses a second scimitar (scripts/buy-owned-ge-item.ts
    // ownedBaseline), so a stale status cannot buy twice.
    for (const a of mine) {
        const lower = a.name.toLowerCase(), m = inp.market?.[WEAPON.item];
        if (!m || !inp.army?.has(lower) || (a.skills.Attack ?? 1) < WEAPON.attack || WEAPON_HELD.some(w => (a.items[w] ?? 0) > 0)
            || (a.items.coin ?? 0) < m.limit + KIT_CASH_RESERVE || inp.retired?.has(pairKey(a.name, KIT_BUY + WEAPON.id))) continue;
        const template = kitBuyTemplate({ ...WEAPON, family: 'kit-buy', script: KIT_BUY_SCRIPT, role: 'supply', yields: () => [] }, a.name,
            [{ item: m.name, id: m.id, held: 0, limit: m.limit, quantity: 1 }], inp.kitSeq?.get(lower) ?? 0);
        cands.push({ account: a.name, template, value: 0, resources: [WEAPON_MARKET], reason: `army band ${WEAPON_BAND}: buys 1 ${m.name}, at most ${m.limit} coins`, goal: { band: WEAPON_BAND, left: 0 } });
    }
    // On a value tie an account keeps the template it holds: a level change must not move it to another spot of the
    // same worth, which would replace a running job with a fresh one that changes nothing useful.
    const keeps = (c: Cand) => inp.current?.get(c.account.toLowerCase()) === c.template.id ? 1 : 0;
    const used = new Map(Object.entries(inp.taken ?? {})), done = new Map<string, Assignment>();
    // A candidate's worth with the holders taken so far: each holder of a resource scales it by that resource's shared
    // rate, so a third farmer on a spot is worth less than a second and new farmers spread over the spots. The place an
    // account already holds keeps its full worth: crowding counts only against a move, so a farmer stays put until its
    // spot is full (capacity is a hard limit below), and sides do not chase each other's lagging claims.
    const worth = (c: Cand) => c.resources.reduce((v, r) => v * (inp.shared?.[r] ?? 1) ** (keeps(c) ? 0 : (used.get(r) ?? 0)), c.value);
    const order = (x: Cand, y: Cand) => worth(y) - worth(x) || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // Donor coins above the reserve, spent as funded candidates take them; a funded account gives nothing.
    // A donor that gives stays free this pass, so the fleet agent can log it in for the trade.
    const pool = new Map((inp.donors ?? []).map(d => [d.name, Math.max(0, d.coins - FUND_RESERVE)])), gave = new Set<string>();
    // Accounts that give an item this pass, and accounts that leave a coin job so a kit order can reach them.
    const gaveItems = new Set<string>(), vacated = new Map<string, string>();
    const take = (c: Cand, value: number) => {
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account) || c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        let fund: Funding | undefined;
        if (c.coins) {
            const from = [...pool].filter(([n, left]) => n.toLowerCase() !== c.account.toLowerCase() && !done.has(n) && left >= c.coins!).sort((x, y) => y[1] - x[1])[0]?.[0];
            if (!from) return;
            pool.set(from, pool.get(from)! - c.coins); gave.add(from);
            fund = { from, to: c.account, coins: c.coins, template: c.template.id };
        }
        pool.delete(c.account);
        for (const r of c.resources) used.set(r, (used.get(r) ?? 0) + 1);
        done.set(c.account, { account: c.account, template: c.template, value, reason: fund ? `${c.reason}, funded ${c.coins} coins by ${fund.from}` : c.reason, resources: c.resources, ...(fund ? { fund } : {}) });
    };
    // The goal tier first: each army account takes the earliest band it can (a full band's resource sends it to the
    // next), the account nearest its target first; it never competes with coin jobs on coins per tick.
    const goalOrder = (x: Cand, y: Cand) => x.goal!.band - y.goal!.band || x.goal!.left - y.goal!.left || keeps(y) - keeps(x) || x.account.localeCompare(y.account) || x.template.id.localeCompare(y.template.id);
    // A quest the account holds comes before every band: a stop in the middle of a quest leaves the account wherever
    // the quest stood (live: an account on Lost City, band 3.6, was moved to the rune buy of band 2).
    for (const c of cands.filter(c => c.goal && !c.lacks && !!c.template.quest && keeps(c)).sort(goalOrder)) take(c, 0);
    for (const c of cands.filter(c => c.goal && !c.lacks && !c.template.filler).sort(goalOrder)) take(c, 0);
    // Then the kit tier: an army account with no band it can start gets the kit of its earliest band, before any coin
    // job, so banked gold becomes a band and not more gold. A buy is one login with the account's own coins. A send
    // takes a partner off its work for a trade window and keeps the account vacant until the order closes, so it comes
    // second: every band the account can buy for is tried before a donor is asked for any of them (an account at
    // Prayer 97 buys its dragon bones and does not wait for 37 bones from another side), this side's donors before
    // another side's, and another side's only for an account with no job of any tier that it can start.
    const reserve = kitReserve(inp.templates), byName = new Map(mine.map(a => [a.name, a]));
    const stock = [...(inp.stock ?? [])].sort((x, y) => Number(y.side === inp.side) - Number(x.side === inp.side));
    // What a donor keeps of an item: the most a band needs to start. An army account of this side keeps that only for
    // the bands it has still to do, so a maxed account gives all it holds (live: two maxed accounts held 41 dragon
    // bones, 1,900 nature runes and 29,000 feathers while others waited for a donor of another side). The levels of
    // another side's account are not read here: it keeps the reserve of every band.
    const ownReserve = new Map<string, Record<string, number>>();
    const keepsOf = (s: Stock) => {
        const a = s.side === inp.side ? byName.get(s.name) : undefined;
        if (!a || !inp.army?.has(a.name.toLowerCase())) return reserve;
        if (!ownReserve.has(a.name)) ownReserve.set(a.name, kitReserve(inp.templates.filter(t => t.tier !== 'goal' || bandLeft(t, a) > 0), a));
        return ownReserve.get(a.name)!;
    };
    const spare = (s: Stock, item: string) => (s.items[item] ?? 0) - (keepsOf(s)[item] ?? 0);
    const banded = (id: string) => byId.get(id)?.tier === 'goal' && !byId.get(id)?.filler;
    const goalNow = (account: string) => { const id = inp.current?.get(account.toLowerCase()); return !!id && (id.startsWith(KIT_BUY) || banded(id)); };
    const acquire = (c: Cand, step: 'buy' | 'send', far: boolean) => {
        const a = byName.get(c.account)!, busy = !!inp.unfundable?.has(c.account.toLowerCase()), buyId = KIT_BUY + c.template.id;
        if (done.has(c.account) || gave.has(c.account) || gaveItems.has(c.account) || vacated.has(c.account)) return;
        // Another side's stock and coins are asked only for an account with no job it can start and none running: such
        // a trade needs the account offline until the other side's agent runs it, up to the order's window (live: 13
        // of 14 accounts stood parked at once, most for 1 to 13 items of another side, one with 123,028 coins for 3
        // air runes that a shop sells).
        if (far && (busy || ready.has(c.account))) return;
        // An account in a running band job keeps the rule it had before the kit tier: its live holdings dip while it
        // works (food eaten, runes cast), and a kit buy must not replace a band that is still running.
        const now = inp.current?.get(c.account.toLowerCase());
        if (busy && now && !now.startsWith(KIT_BUY) && banded(now)) return;
        // No kit for a band whose place is full: the account tries its next band.
        if (c.resources.some(r => (used.get(r) ?? 0) >= (inp.capacity?.[r] ?? 1))) return;
        const own = (l: Lack) => l.of.some(i => !!c.template.ownSupply?.includes(i));
        const picks = c.lacks!.filter(l => !shopLine(l) && !own(l)).map(l => { const item = l.of.filter(i => inp.market?.[i]).sort((x, y) => inp.market![x]!.limit - inp.market![y]!.limit)[0]; return item ? { item, count: l.count } : null; });
        if (step === 'buy' && picks.length && picks.every(p => p !== null) && !inp.retired?.has(pairKey(c.account, buyId))) {
            // The batch when the account can pay for it, else only what the band needs to start. A one-line band with
            // `partBatch` takes as much of its batch as the account can pay for.
            const batchOf = c.template.batchFor?.(a) ?? c.template.batch;
            const sized = (batch: boolean): KitLine[] => picks.map(p => { const held = a.items[p!.item] ?? 0, m = inp.market![p!.item]!; return { item: m.name, id: m.id, held, limit: m.limit, quantity: Math.max(p!.count, batch ? (batchOf?.[p!.item] ?? 0) - held : 0) }; });
            const price = (ls: readonly KitLine[]) => ls.reduce((n, l) => n + l.quantity * l.limit, 0), coins = a.items.coin ?? 0;
            const free = coins - (c.template.keepCoins?.(a) ?? 0);
            const full = sized(true), start = sized(false), part = Math.floor((free - KIT_CASH_RESERVE) / (full[0]?.limit ?? 1));
            const lines = price(full) + KIT_CASH_RESERVE <= free ? full
                : c.template.partBatch && full.length === 1 && part > start[0]!.quantity ? [{ ...full[0]!, quantity: Math.min(full[0]!.quantity, part) }] : start;
            const template = kitBuyTemplate(c.template, c.account, lines, inp.kitSeq?.get(c.account.toLowerCase()) ?? 0), cost = price(lines), short = cost + KIT_CASH_RESERVE - free;
            const what = lines.map(l => `${l.quantity} ${l.item}`).join(', ');
            if (short <= 0) { done.set(c.account, { account: c.account, template, value: 0, reason: `buys ${what} for ${c.template.id}, at most ${cost} coins`, resources: [] }); return; }
            if (!busy) {
                // A coin donor of this side, else a free account of another side with coins above the reserve.
                const coinsOf = (s: Stock) => Math.max(0, (s.items.coin ?? 0) - FUND_RESERVE);
                const own = [...pool].filter(([n, left]) => n.toLowerCase() !== c.account.toLowerCase() && !done.has(n) && !gaveItems.has(n) && left >= short).sort((x, y) => y[1] - x[1])[0]?.[0];
                const other = own || !far ? undefined : stock.filter(s => s.side !== inp.side && !gave.has(s.name) && !gaveItems.has(s.name) && coinsOf(s) >= short).sort((x, y) => coinsOf(y) - coinsOf(x))[0]?.name;
                const from = own ?? other;
                if (from) {
                    if (own) pool.set(own, pool.get(own)! - short);
                    gave.add(from); pool.delete(c.account);
                    done.set(c.account, { account: c.account, template, value: 0, reason: `${c.reason}, funded ${short} coins by ${from} to buy ${what}`, resources: [], fund: { from, to: c.account, coins: short, template: template.id } });
                    return;
                }
            }
        }
        if (step === 'buy') return;
        // One order per pass. A line no market sells goes first, so the lines left at the end are one buy.
        const sold = (l: Lack) => Number(l.of.some(i => !!inp.market?.[i]));
        for (const l of [...c.lacks!].filter(l => !own(l)).sort((x, y) => sold(x) - sold(y))) for (const item of l.of) {
            const from = stock.find(s => (s.side !== inp.side) === far && s.name.toLowerCase() !== c.account.toLowerCase() && !done.has(s.name) && !gave.has(s.name) && !gaveItems.has(s.name) && spare(s, item) >= l.count
                && !inp.noSend?.has(`${s.name}>${c.account}`.toLowerCase()));
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
            done.set(c.account, { account: c.account, template: c.template, value: 0, reason: `${c.reason}, sent ${count} ${item} by ${from.name}`, resources: [], send: { from: from.name, to: c.account, item, count, template: c.template.id } });
            return;
        }
    };
    // This side's own coins and stock before another side's: a trade across sides waits on the other side's agent,
    // and the account stands vacant meanwhile (live: five accounts parked for donors of another side, one for 22
    // bones, while this side's maxed accounts held what they needed).
    const kits = cands.filter(c => c.goal && c.lacks).sort(goalOrder);
    // The accounts with a job of any tier that they can start now with what they hold.
    const ready = new Set(cands.filter(c => !c.lacks && !c.coins).map(c => c.account));
    for (const far of [false, true]) for (const step of ['buy', 'send'] as const) for (const c of kits) acquire(c, step, far);
    // Then the filler bands, for an army account that no band and no kit took.
    for (const c of cands.filter(c => c.goal && !c.lacks && c.template.filler).sort(goalOrder)) take(c, 0);
    // The coin tier, re-sorted after every assignment: one more holder lowers the worth of the candidates that share
    // its resource.
    for (const rest = cands.filter(c => !c.goal); rest.length;) {
        rest.sort(order);
        const c = rest.shift()!;
        take(c, worth(c));
    }
    return mine.map(a => done.get(a.name) ?? { account: a.name, value: 0, resources: [], reason: gave.has(a.name) ? 'vacant: gives coins this pass'
        : gaveItems.has(a.name) ? 'vacant: gives a kit item this pass' : vacated.get(a.name) ?? 'vacant: no template meets its skills and holdings with a free resource' });
}

// The swarm job for an assignment. `autopilot` marks it as this side's planner job; the CLI replaces only marked jobs.
// A training job or a quest job does not repeat: its ok RESULT means the target level is met (or the quest is done), and a rerun would log in, find the level
// met and log out (a scored login for nothing). The swarm keeps the account's `done` end until the next pass hands it
// a job with a different mission, which the met level unlocks. A run that ends short of the target is a fail RESULT,
// which the supervisor retries and the swarm's standing retry resumes, with or without repeat.
// finishedTrainers() brings that next pass forward.
export function jobFor(x: Assignment, side: string) {
    const t = x.template!;
    return { account: x.account, script: t.script, args: t.args ?? [], env: t.env ?? {}, role: t.role, goal: t.goal, enabled: true, repeat: t.repeats ?? !(t.trains || t.quest), standing: true,
        autopilot: side, template: t.id, resources: x.resources, note: `autopilot ${t.id}: ${x.reason}, ${x.value.toFixed(2)} coins/tick (estimate)` };
}

// Accounts whose planner trainer has reached its target: the job's template trains, the state still assigns that
// template, and the job's log since the assignment holds an ok RESULT. The daemon re-plans these accounts at once.
export function finishedTrainers(jobs: readonly any[], side: string, assigned: Readonly<Record<string, { template: string; offset: number }>>, templates: readonly Template[],
    linesSince: (account: string, offset: number, job: any) => readonly string[]): string[] {
    // A quest job ends as a trainer does: its ok RESULT frees the account for the job the quest unlocks.
    const trains = new Set(templates.filter(t => t.trains || t.quest).map(t => t.id));
    return jobs.filter(j => j?.autopilot === side && typeof j.account === 'string' && trains.has(j.template) && assigned[j.account]?.template === j.template
        && assess(linesSince(j.account, assigned[j.account]!.offset, j)).ok > 0).map(j => j.account);
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
export const DRAIN_RESULT = /^RESULT fail (?:session ended: disconnected\b|login: \[object WebSocket\]|TickStallError\b|(?:login: )?(?:Error: )?fleet account claim held\b|.*\bprecondition no route to\b|.*\bmarket bank travel failed\b|.*\bowned item baseline \d+ differs from EXPECTED_OWNED \d+|stop file\b|.*\bworker finished: stop file\b)/;
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
    const at = clean.reduce((last, l, i) => l.startsWith('LEDGER ') ? i : last, -1);
    const ledger = clean[at]?.match(/^LEDGER ticks=(\d+).* move=(\d+).* idle=(\d+)/), ended = clean.slice(at + 1).find(l => /^RESULT (ok|fail)\b/.test(l));
    if (ledger && +ledger[1]! >= 300 && (+ledger[2]! + +ledger[3]!) / +ledger[1]! >= WASTE_LIMIT && !(ended?.startsWith('RESULT ok') && progressed(ended)))
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
export const CHICKEN_PENS = ['3229,3298', '3017,3288', '3187,3277', '3197,3353'];
// The pen at 3197,3353 is the yard of the Champions' Guild. Its door lets in an account with 32 quest points
// (championdoor in knowledge/doors.json), and the route search refuses the pen to any other account.
export const PEN_QUEST_POINTS: Readonly<Record<string, number>> = { '3197,3353': 32 };
// scripts/gather-feathers.ts stops when its pack holds TARGET feathers.
export const FEATHER_TARGET = 2000;
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
export const SPLASH_START = { 'body rune': 10, 'earth rune': 30, 'water rune': 30 } as const, CURSE_LEVEL = 19, CURSE_XP = 725;
export function splashKit(magic: number): Record<string, number> {
    const casts = Math.max(SPLASH_START['body rune'], Math.ceil((xpForLevel(SPLASH_TO) - xpForLevel(magic)) / CURSE_XP));
    return magic < CURSE_LEVEL ? { ...SPLASH_KIT } : { 'body rune': casts, 'earth rune': 3 * casts, 'water rune': Math.max(SPLASH_START['water rune'], 2 * casts) };
}
// The places the AIO routes hold (aioTemplates). Each takes one account until a live pilot measures two.
export const AIO_PLACES = { flax: 'aio:seers-flax', yews: 'aio:seers-yews', ore: 'aio:varrock-east-mine', essence: 'aio:essence-mine', air: 'aio:air-altar', blood: 'aio:ardougne-blood-chests' } as const;
export const CAPACITY: Readonly<Record<string, number>> = { 'catherby:lobster': 3, [WEAPON_MARKET]: WEAPON_BUYERS, [LOST_CITY]: LOST_CITY_PLACES, [GRAIL_PLACE]: GRAIL_PLACES, [FREMENNIK]: FREMENNIK_PLACES, [UPASS]: UPASS_PLACES, ...Object.fromEntries(Object.values(AIO_PLACES).map(p => [p, 1])), [COW_FIELD]: COW_FIELD_CAPACITY, [TROOPER_FIELD]: TROOPER_FIELD_CAPACITY, [STRIKE_TILE]: 1, [SPLASH_FENCE]: SPLASH_PLACES, [BLACK_CAVE]: BLACK_CAVE_PLACES, ...Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARE])) };
export const SHARED: Readonly<Record<string, number>> = Object.fromEntries(KNIGHT_SPOTS.map(s => [`knight:${s}`, KNIGHT_SHARED_RATE]));
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
// account with Thieving 5 needs no food to start (TROOPER_FED); the trainer eats cake a bite at a time. Live, TheFullMonty trained Ranged 1 to 61 and Strength 61 to 78 there. GIANT_BURY=1 has the trainer bury
// the bones each kill leaves until Prayer 99: practice, six at once, about 2.5 Prayer XP per tick for 16% of the
// Strength rate (research/combat-measure.md, bones buried on the field). Gap: live rates with several accounts at
// once are not measured.
export const TROOPER_FOOD = ['shark', 'swordfish', 'lobster', 'trout', 'cooked meat', 'bread', 'chocolate slice', 'slice of cake', '2/3 cake', 'cake'] as const;
export const TROOPER_STOCK = [...TROOPER_FOOD, 'raw beef'] as const;
// What feeds a trooper run: 10 pieces of stock held, or Thieving 5, with which the job's food stage steals a pack at
// the Ardougne baker's stalls when the stock is short (scripts/trooper-food.ts).
export const TROOPER_FED: readonly Needs[] = [{ pieces: { of: TROOPER_STOCK, count: 10 } }, { skills: { Thieving: 5 } }];
export const TROOPER_BANDS: readonly { skill: 'Strength' | 'Attack' | 'Defence'; band: number }[] = [
    { skill: 'Strength', band: 6 }, { skill: 'Attack', band: 7 }, { skill: 'Defence', band: 8 },
];
// Magic, band 2: alchemy at the Ardougne north bank (scripts/alch-train.ts) walks there from anywhere, banks the pack,
// takes nature runes, fire (runes, or a fire staff it wields) and feathers, low-alchs to 55 and high-alchs to the
// target. Practice at xpRate 25: 1,625 XP a High Alchemy cast at 6.5-7 ticks, 233-250 XP a tick, about 10 times
// combat training, so Magic 50 to 99 is about 4,000 ticks. A run that runs out of supplies ends ok after a level;
// the account takes the band again once restocked. Prayer, band 3: scripts/train-prayer.ts BURY_HELD=1 buries the held
// bones above BONE_RESERVE up to 99 from the Ardougne north bank (entry within 60 tiles) and ends ok when they run
// out after a level; practice from the knights buried 114 of 120 bones in 282 ticks to Prayer 75, about 2.2 ticks a
// bone. Gap: neither is run live.
export const MAGIC_BAND = 2, PRAYER_BAND = 3;
// Bought bones: Prayer XP a bury (scripts/train-prayer.ts BONE_XP; a test keeps the two tables equal), the bones the
// trainer keeps (its BONE_RESERVE floor) and the bones a bury band starts with.
export const BOUGHT_BONE_XP: Readonly<Record<number, number>> = { 536: 1800, 532: 375 };
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
export const RANGED_BAND = 4, GUILD_BAND = 3.9;
const BOWS: readonly (readonly [string, number])[] = [['shortbow', 1], ['longbow', 1], ['oak shortbow', 5], ['oak longbow', 5], ['willow shortbow', 20],
    ['willow longbow', 20], ['maple shortbow', 30], ['maple longbow', 30], ['yew shortbow', 40], ['yew longbow', 40], ['magic shortbow', 50], ['magic longbow', 50]];
const ARROWS: readonly (readonly [string, number])[] = [['bronze arrow', 1], ['iron arrow', 1], ['steel arrow', 5], ['mithril arrow', 20], ['adamant arrow', 30], ['rune arrow', 40]];
// A staff that stands for the fire runes of a cast.
export const FIRE_STAFFS = ['staff of fire', 'fire battlestaff', 'mystic fire staff'] as const;
// Kit items a goal-tier shop job brings (the alchemy supply jobs and the army-arrows jobs). A kit line of these that no market sells
// does not hold back the market buy of the band's other lines: the shop job follows once those are held.
export const SHOP_SUPPLIED: ReadonlySet<string> = new Set(['fire rune', ...FIRE_STAFFS, 'feather', 'water rune', 'dusty key', 'bronze arrow', 'iron arrow', 'steel arrow', 'mithril arrow']);
// ARROW_LOW: the arrows of one kind the Ranged band needs to start. ARROW_STOCK: what a shop run brings the account up to.
export const ARROW_LOW = 100, ARROW_STOCK = 500, LOWE_STOCK = 1000;
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
//   account in the field: 364 flax in 1,524 ticks. Gap: one account in the field; two at once are not run.
// - bow strings (scripts/spin-bowstrings.ts): Crafting 10 (`flax requires Crafting 10`); it ends ok only with
//   MAX_MAKE made, so it needs that much flax banked at Seers. Bench: Crafting 13, 56 made in 457 ticks.
// - yew logs (scripts/gather-yews.ts): Woodcutting 60 for a yew, and an axe. Bench: Woodcutting 99 with a rune axe,
//   37 logs in 1,023 ticks; the rate here is half of that. BANK_AT is the worker's default 27, not the bench's 200.
// - arrow shafts (scripts/fletch-arrows.ts, MODE=shafts): a knife and MAX_MAKE logs. Bench: a bare account at the
//   Draynor bank, one log in 15 ticks. Gap: a start away from a bank is not run.
// - ore (scripts/gather-ore.ts mixedOreCombatProblem): combat 13 (rats at the Varrock East mine hunt below it) and a
//   pickaxe. Live trial: 75 ores banked in 1,169 ticks at combat 13 (scripts/fleet.ts, OreElse). Bench: Mining 50.
// - rune essence (scripts/gather-essence.ts): Rune Mysteries complete (Aubury refuses the teleport without it) and a
//   pickaxe. Bench: a bare account with the quest done, 6 essence in 189 ticks.
// - air runes (scripts/rune-bank-craft.ts): an air talisman and banked essence. Bench: Runecraft 1, 30 essence
//   crafted in 324 ticks.
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
// - cannonballs (scripts/microbot-a-cannonballs.ts): a members world and Smithing 35 (smelt-batch.ts cannonAdmission:
//   `cannonballs need observed member and current Smithing35`), an ammo mould held or banked (`smelt owned reusable
//   tool missing`) and CANNON_BARS steel bars banked: the order is exact, so a run with fewer bars fails. One bar
//   makes 4 balls. CANNON_XP_RATE is the XP rate of the server (a dragon bone gives 1,800 Prayer XP, BOUGHT_BONE_XP);
//   the worker ends on an XP gain that differs. Bench: Smithing 35 at the Al Kharid bank, 1 bar in 47 ticks. The rate
//   is an estimate: 27 bars at about 8 ticks a bar (cannonballs.rs2) and the bench's 39 ticks of bank and walk give
//   0.42 balls a tick, and the rate here is half of that. Gap: a run of more than 3 bars is not measured
//   (research/microbot-ports.md: 3 bars to 12 banked balls).
// - blood runes (scripts/blood-chest.ts): Thieving 59 and a start on the ground floor (bloodRefusal); it travels to
//   the Ardougne north bank from any such start. Each of the two chests gives 2 blood runes and 500 coins and comes back in
//   400 ticks at most (RESPAWN_TICKS). A run ends ok only with MAX_LOOTS loots. The ogres by the chests hit: under 60%
//   of its Hitpoints the account leaves, eats banked food of BLOOD_FOOD (the worker's BANK_FOOD) and ends `stop=hp`
//   with none, so `needs` asks BLOOD_MEALS pieces (an estimate: the worker's note gives 12 of 47 Hitpoints a trip).
//   Bench: Thieving 99 and Hitpoints 56 by the tower, 2 loots in 165 ticks. The rate is an estimate from the respawn
//   time: 4 runes and 1,000 coins in 400 ticks. Gap: no run of more than 2 loots is measured, and another player at
//   the chests takes loots from the run.
const PICKAXES = ['bronze pickaxe', 'iron pickaxe', 'steel pickaxe', 'mithril pickaxe', 'adamant pickaxe', 'rune pickaxe'] as const;
const AXES = ['bronze axe', 'iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe'] as const;
// scripts/quest-sweep.ts MEALS, by item name (scripts/autopilot.test.ts checks the two agree).
export const SWEEP_MEALS = ['shark', 'swordfish', 'lobster', 'bass', 'tuna', 'trout', 'salmon', 'cake', '2/3 cake', 'slice of cake', 'bread'] as const;
export const BOWSTRING_BATCH = 56, SHAFT_LOGS = 25;
// One pack of steel bars beside the ammo mould, the loots of one blood chest run, and the food that run asks.
export const CANNON_BARS = 27, BLOOD_LOOTS = 6, BLOOD_MEALS = 5;
// scripts/blood-chest.ts BANK_FOOD, by item name (scripts/autopilot.test.ts checks the two agree).
export const BLOOD_FOOD = ['shark', 'swordfish', 'lobster', 'tuna', 'salmon', 'trout', 'cake'] as const;
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
            needs: { skills: { Smithing: level }, items: { [ore]: load, ...(coal ? { coal: coal * load } : {}) } }, yields: () => [{ item: `${bar} bar`, perTick }] });
    return [
        aio('aio-flax', 'skiller:foraging:flax', 'scripts/gather-flax.ts', ['foraging', 'flax', '1800', '28'], {
            role: 'crafting', goal: 'pick flax at Seers and bank it', resources: [AIO_PLACES.flax], yields: () => [{ item: 'flax', perTick: 0.18 }] }),
        aio('aio-bowstrings', 'skiller:crafting:bowstrings', 'scripts/spin-bowstrings.ts', ['crafting', 'bowstrings', '1250', `MAX_MAKE=${BOWSTRING_BATCH}`, 'RAW_RESERVE=0', 'MAX_TRIPS=4'], {
            role: 'crafting', goal: `spin ${BOWSTRING_BATCH} banked flax into bow strings at Seers`, needs: { skills: { Crafting: 10 }, items: { flax: BOWSTRING_BATCH } },
            yields: () => [{ item: 'bow string', perTick: 0.12 }] }),
        aio('aio-yews', 'skiller:woodcutting:yews', 'scripts/gather-yews.ts', ['woodcutting', 'yews', '1800', '27', 'MAX_TRIPS=4'], {
            role: 'woodcutting', goal: 'cut yew logs at Seers and bank them', resources: [AIO_PLACES.yews],
            needs: { skills: { Woodcutting: 60 }, pieces: { of: AXES, count: 1 } }, yields: () => [{ item: 'yew logs', perTick: 0.018 }] }),
        aio('aio-shafts', 'skiller:fletching:shafts', 'scripts/fletch-arrows.ts', ['fletching', 'shafts', '600', `MAX_MAKE=${SHAFT_LOGS}`, 'LOG_RESERVE=0'], {
            role: 'fletching', goal: `cut ${SHAFT_LOGS} banked logs into arrow shafts`, needs: { items: { knife: 1, logs: SHAFT_LOGS } },
            yields: () => [{ item: 'arrow shaft', perTick: 1 }] }),
        aio('aio-ore', 'skiller:mining:ore', 'scripts/gather-ore.ts', ['mining', 'ore', '1800', '25', 'MAX_TRIPS=3'], {
            role: 'mining', goal: 'mine ore at Varrock East and bank three loads', resources: [AIO_PLACES.ore],
            needs: { combat: 13, pieces: { of: PICKAXES, count: 1 } },
            // Iron from Mining 15; copper and tin before it.
            yields: a => (a.skills.Mining ?? 1) >= 15 ? [{ item: 'iron ore', perTick: 0.064 }] : [{ item: 'copper ore', perTick: 0.032 }, { item: 'tin ore', perTick: 0.032 }] }),
        essence,
        aio('aio-air-runes', 'skiller:runecraft:bank-craft', 'scripts/rune-bank-craft.ts', ['runecraft', 'bank-craft', '99', 'CAP=4000'], {
            role: 'magic', goal: 'craft banked rune essence into air runes', resources: [AIO_PLACES.air],
            needs: { items: { 'air talisman': 1, 'rune essence': 28 } }, yields: () => [{ item: 'air rune', perTick: 0.09 }] }),
        bars('runite', 85, 'runite ore', 8, 2, 0.06),
        bars('adamantite', 70, 'adamantite ore', 6, 4, 0.07),
        bars('mithril', 50, 'mithril ore', 4, 5, 0.08),
        bars('iron', 15, 'iron ore', 0, 28, 0.074),
        aio('aio-cannonballs', 'skiller:smithing:cannonballs', 'scripts/microbot-a-cannonballs.ts', ['smithing', 'cannonballs', String(CANNON_BARS), '1500', 'CANNON_XP_RATE=25'], {
            role: 'smithing', goal: `cast ${CANNON_BARS} banked steel bars into cannonballs at Al Kharid`,
            needs: { skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } }, yields: () => [{ item: 'cannonball', perTick: 0.2 }] }),
        aio('aio-rune-scimitars', 'skiller:smithing:anvil', 'scripts/smelt-bars.ts', ['smithing', 'anvil', '1500', 'PRODUCT_ID=1333', 'MAX_MAKE=1', 'BAR_RESERVE=0'], {
            role: 'smithing', goal: 'smith a rune scimitar from two banked runite bars at the Varrock West anvils',
            needs: { skills: { Smithing: 90 }, items: { hammer: 1, 'runite bar': 2, coins: 10 } }, yields: () => [{ item: 'rune scimitar', perTick: 0.003 }] }),
        aio('aio-blood-chest', 'skiller:thieving:blood-chest', 'scripts/blood-chest.ts', ['thieving', 'blood-chest', '4000', `MAX_LOOTS=${BLOOD_LOOTS}`, 'CAP=4000'], {
            role: 'thieving', goal: `loot the Ardougne blood rune chests ${BLOOD_LOOTS} times and bank the runes`, resources: [AIO_PLACES.blood],
            needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
            yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }] }),
        aio('aio-quest-runemysteries', 'quester:mode:sweep', 'scripts/quest-sweep.ts', ['sweep', 'runemysteries'], {
            role: 'quest', goal: 'complete Rune Mysteries for the essence mine', quest: { name: 'Rune Mysteries Quest', unlocks: [essence.id] },
            needs: { items: { 'law rune': 2, 'air rune': 6, 'fire rune': 1, 'earth rune': 1 }, pieces: { of: SWEEP_MEALS, count: 4 } }, yields: () => [] }),
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
        env: { TRAIN_SKILL: skill, COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1' }, role: 'combat', goal: `train ${skill} to ${to} on the Ardougne cows`,
        tier: 'goal', band, repeats: true, trains: { skill, to, unlocks: [] }, resources: [COW_FIELD], yields: () => [],
        needs: { food: 14, items: { 'bronze sword': 1, 'wooden shield': 1 } },
        // One trip to the Grand Exchange brings food for many runs, not the two trout one start needs.
        batch: { trout: 30 },
    }));
    const troopers = TROOPER_BANDS.map(({ skill, band }): Template => ({
        id: `army-trooper-${skill.toLowerCase()}-99`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, role: 'combat', goal: `train ${skill} to 99 on the Khazard troopers`,
        tier: 'goal', band, repeats: true, trains: { skill, to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    }));
    const magic: Template = {
        id: 'army-alch-magic-99', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['99', '5000'], role: 'combat', goal: 'train Magic to 99 with alchemy at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [] }, yields: () => [],
        needs: { skills: { Magic: 21 }, items: { 'nature rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] },
        // Magic 99 is 998,458 XP here. Low Alchemy gives 775 XP a cast to 55 and High Alchemy 1,625 from there (xpRate 25),
        // so Magic 21 to 99 takes about 650 nature runes; a buy brings 1,000.
        batch: { 'nature rune': 1000 },
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
    // The alchemy band cast on air runes, for an account at Magic 66 or more that holds them (the guild trip's).
    const magicAir: Template = { ...magic, id: 'army-alch-air-magic-99', env: { ALCH_ITEM: 'airrune' }, goal: 'train Magic to 99 with alchemy on air runes at the Ardougne north bank',
        needs: { skills: { Magic: 66 }, items: { 'nature rune': 50, 'air rune': 50 }, anyOf: magic.needs!.anyOf }, batch: undefined, shopKit: true };
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
    const prayer: Template = {
        id: 'army-bury-prayer-99', family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, role: 'combat',
        goal: 'train Prayer to 99 burying the held bones', tier: 'goal', band: PRAYER_BAND, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
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
        goal: `train Prayer to 99 burying bought ${bone}`, tier: 'goal', band, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
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
    // arrows for dragons. The arrows and the teleport's air and fire runes are the shop run's (`ownSupply`); the kit
    // tier gets the bow, the law rune and the sharks. Live (claude-cloud, by hand): three kills, three hides, no hitpoint lost, banked. Pilots.
    const dustyKey: Template = {
        id: 'army-dusty-key', pilot: true, family: 'aio:quester:mode:dusty-key', script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], aio: 'quester:mode:dusty-key', worker: 'scripts/dusty-key.ts',
        role: 'quest', goal: "get the dusty key from Velrak for Taverley dungeon's inner gate", tier: 'goal', band: HUNT_BAND, filler: true, repeats: false, stock: { item: 'dusty key', to: 1 }, yields: () => [],
        needs: { skills: { Attack: 90, Strength: 90, Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 } },
    };
    // The same trip on bronze arrows, for an account whose shop run found more bronze than iron: Lowe's bronze shelf
    // holds 2,000 and gives one back every 10 ticks, the iron shelf 1,500 and one every 15. Practice, two hunters at
    // once with 600 arrows each: 7 kills on bronze, 6 on iron.
    const huntOn = (id: string, arrow: string): Template => ({
        id, pilot: true, family: 'combat-train', script: 'scripts/black-dragon-camp.ts', args: ['9000'],
        env: { KILLS: String(HUNT_KILLS), ARROW: arrow.replace(' ', '_'), ARROWS: String(HUNT_ARROWS) }, role: 'combat', goal: `kill Taverley's black dragons for their hides and bones, on ${arrow}s`,
        tier: 'goal', band: HUNT_BAND, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: [BLACK_CAVE], yields: () => [],
        ownSupply: ['iron arrow', 'bronze arrow', 'air rune', 'fire rune'],
        needs: { skills: { Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 },
            items: { 'dusty key': 1, 'magic shortbow': 1, [arrow]: HUNT_ARROWS, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD } },
    });
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
        needs: { skills: { Prayer: 43, Magic: 45, Attack: 90, Strength: 90, Hitpoints: 90, Defence: 90 }, under: { Prayer: 99 }, items: { coins: 2000, 'rune scimitar': 1, ...GRAIL_RUNES },
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
        needs: { quests: ['Underground Pass'], skills: { Ranged: 99, Magic: 51, Prayer: 43, Hitpoints: 90, Agility: UPASS_AGILITY }, items: { coins: 2000, ...BOW_KIT, ...REGICIDE_RUNES, ...REGICIDE_PACK },
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
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, role: 'combat', goal: 'train Prayer to 99 burying trooper bones on the field',
        tier: 'goal', band: PRAYER_FIELD_BAND, filler: true, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    };
    const ranged: Template = {
        id: 'army-trooper-ranged-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1' }, role: 'combat', goal: 'train Ranged to 99 on the Khazard troopers',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Hitpoints: 40 }, anyOf: RANGED_KIT.flatMap(kit => TROOPER_FED.map(fed => ({ ...kit, ...fed, skills: { ...kit.skills, ...fed.skills } }))) },
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
    return [
        ...goldfarm,
        ...cows,
        ...troopers,
        strike,
        magic,
        splash,
        water,
        waterBetty,
        staff,
        feathers,
        fireRunes,
        staffGuild,
        natureGuild,
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
        fletch,
        fremennik,
        upassThieve,
        upassAgility,
        upass,
        regicide,
        holyGrail,
        dustyKey,
        hunt,
        huntBronze,
        huntSupply,
        jakut,
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
        { id: 'shop-runes', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['betty'], env: { ITEMS: 'fire rune|air rune|earth rune', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy elemental runes at Betty', needs: { items: { coins: 3000 } }, resources: ['shop:betty'],
            yields: () => [{ item: 'fire rune', perTick: 0.7 }, { item: 'air rune', perTick: 0.7 }, { item: 'earth rune', perTick: 0.7 }], spends: () => [{ item: 'coins', perTick: 2.1 * 5 }] },
        { id: 'shop-feathers', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['sarim'], env: { ITEMS: 'feather', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy feathers at Gerrant', needs: { items: { coins: 2000 } }, resources: ['shop:sarim'],
            yields: () => [{ item: 'feather', perTick: 3 }], spends: () => [{ item: 'coins', perTick: 3 * 3 }] },
        { id: 'shop-arrowtips', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby'], env: { ITEMS: 'rune arrowtips|adamant arrowtips', BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy rune and adamant arrowtips at Catherby', needs: { items: { coins: 20000 } }, resources: ['shop:catherby'],
            yields: () => [{ item: 'rune arrowtips', perTick: 0.05 }, { item: 'adamant arrowtips', perTick: 0.05 }], spends: () => [{ item: 'coins', perTick: 0.05 * 260 + 0.05 * 104 }] },
        { id: 'fletch-headless', family: 'fletch', script: 'scripts/fletch-arrows.ts', args: ['15000', 'headless'], env: { BANK_PACK: '1', MAX_MAKE: '390' }, role: 'fletching',
            goal: 'headless arrows from owned shafts and feathers', needs: { items: { 'arrow shaft': 215, feather: 215 } },
            yields: () => [{ item: 'headless arrow', perTick: 5 }] },
        ...aioTemplates(),
    ];
}

// The exclusive resources an existing swarm job holds, planner-made or not, so no two accounts share one.
export function jobResources(job: { script?: string; args?: string[]; env?: Record<string, string>; resources?: string[] }): string[] {
    if (Array.isArray(job.resources)) return job.resources.filter(r => typeof r === 'string');
    const script = String(job.script ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    // A scripts/chain.ts job runs each argument as a step with its own KEY=value environment.
    const steps = script === 'scripts/chain.ts' ? (job.args ?? []).map(t => t.trim().split(/\s+/)) : [[script, ...(job.args ?? [])]];
    const cheb = (s: string, x: number, z: number) => { const [sx, sz] = s.split(',').map(Number); return Math.max(Math.abs(sx! - x), Math.abs(sz! - z)); };
    const out: string[] = [];
    for (const [file, ...rest] of steps) {
        const env: Record<string, string> = { ...job.env }, args: string[] = [];
        for (const t of rest) { const m = t.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) env[m[1]!] = m[2]!; else args.push(t); }
        if (file === 'scripts/goldfarm.ts') {
            const m = (env.KNIGHT_SPOT ?? '2653,3302').match(/^(\d+),(\d+)$/), x = Number(m?.[1] ?? 2653), z = Number(m?.[2] ?? 3302);
            out.push(`knight:${KNIGHT_SPOTS.reduce((b, s) => cheb(s, x, z) < cheb(b, x, z) ? s : b)}`);
        }
        if (file === 'scripts/gather-feathers.ts') out.push(`pen:${env.PEN ?? '3229,3298'}`);
        // Ranged training kills the Lumbridge pen's chickens (scripts/ranged-train.ts OUT ends at 3233,3297), so it holds
        // that pen like a feather job does: two sides must not farm one pen.
        if (file === 'scripts/ranged-train.ts') out.push('pen:3229,3298');
        if (file === 'scripts/shop-buyer.ts' && args[0]) out.push(`shop:${args[0]}`);
        if (file === 'scripts/gather-fish.ts' && (args[0] ?? 'cage') === 'cage') out.push('catherby:lobster');
    }
    return [...new Set(out)];
}

// The freshest of an account's observations by `at`: its status file and its row in the side's fleet snapshot. A fresh
// cloud container has no status files, so without the snapshot every account would plan as a level-1 start.
export function freshest(...observations: readonly any[]): any {
    return observations.filter(o => o && typeof o === 'object').reduce((best, o) => (Number(o.at) || 0) > (Number(best?.at) || 0) ? o : best, null);
}

// An account as the planner sees it, from its status file (.practice/status/<name>.json) or a fleet snapshot row:
// base levels, pack, bank and worn counts by item name, and its complete quests (a status lists every quest with a
// state, a snapshot row the complete ones by name). No status: a fresh account at level 1 (Hitpoints 10).
export function accountFrom(name: string, side: string, status: any, itemName: (id: number) => string | undefined): Acct {
    const skills: Record<string, number> = { Hitpoints: 10 }, items: Record<string, number> = {};
    for (const k of Array.isArray(status?.skills) ? status.skills : []) if (typeof k?.name === 'string' && Number.isFinite(k.level)) skills[k.name] = k.level;
    for (const r of [status?.inventory, status?.bank, status?.equipment].flatMap(x => Array.isArray(x) ? x : [])) {
        const n = typeof r?.name === 'string' ? r.name : itemName(r?.baseId ?? r?.id);
        if (n && Number.isFinite(r.count)) items[norm(n)] = (items[norm(n)] ?? 0) + r.count;
    }
    const quests = Array.isArray(status?.quests)
        ? new Set<string>(status.quests.flatMap((q: any) => typeof q === 'string' ? [norm(q)] : typeof q?.name === 'string' && q.state === 'complete' ? [norm(q.name)] : [])) : undefined;
    const questPoints = status?.guildFacts?.varps?.qp;
    return { name, side, skills, items, ...(Number.isFinite(status?.combat) ? { combat: status.combat } : {}), ...(quests ? { quests } : {}), ...(Number.isFinite(questPoints) ? { questPoints } : {}) };
}

// This side's new swarm job list: every job without this side's marker stays as it is; a planner job whose account
// keeps its template stays unchanged (its swarm revision and run go on); a changed or new assignment gets a fresh job.
// The accounts this side's planner may give a job: those a marked job names (handed over), or those no job names at all
// (a fresh account). An enabled unmarked job (a hand job or a coordinator run) keeps its account, a reservation (no
// script) keeps its account, and an owner pause (a stop file) keeps its account. An unmarked job that is off holds an
// account only when no marked job names it: a finished coordinator run does not block a handover, but by itself it
// frees nothing, since the coordinator may plan that account next.
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
// once for each job that holds it, so the other sides count both farmers on a shared knight spot.
export const CLAIM_MAX_AGE_MS = 2 * 3600_000;
export function claimFor(jobs: readonly any[], side: string, sideOf: (account: string) => string, now = Date.now(), active: (account: string) => boolean = () => true): { side: string; at: number; resources: string[] } {
    const held = jobs.filter(j => j?.enabled !== false && jobNames(j).length > 0 && jobNames(j).every(a => sideOf(a) === side) && jobNames(j).some(active)).flatMap(jobResources);
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
export function mergeJobs(jobs: readonly any[], side: string, out: readonly Assignment[], keep: ReadonlySet<string> = new Set()): { jobs: any[]; fresh: string[] } {
    const mine = (j: any) => j?.autopilot === side, kept = (j: any) => [j?.account, ...(j?.accounts ?? [])].some((a: string) => a && keep.has(a.toLowerCase()));
    const next = jobs.filter(j => !mine(j) || kept(j)), fresh: string[] = [];
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
