// Readiness of the gang squad's accounts (scripts/pk-squad.ts), from the status files only: it logs in no account.
// For each account it gives the kit that the account can wear and carry from its own stock (worn, pack and bank),
// each missing piece with the nearest owned account that holds a spare one, and a verdict. scripts/pk-squad.ts takes
// its pack from what an account holds at login (scripts/pk-gang.ts packOf) and asks for the same pack again at each
// bank trip (bankTrip), so an account must hold the whole kit before the squad starts.
// The rule gang-chain-bind is the bench kit live-walker-iron-rune-chain-bind (scripts/pk-kits.ts) with each piece
// widened to its class, and the checks are the faults of the live pilots (research/pvp-fight-loop.md):
//   body and leg armour (an account with no leg armour died), a melee weapon with a special attack or a rune blade,
//   a bow with arrows that it can fire, the runes of an escape teleport that the account can cast (pk-squad.ts
//   squadEscapeSpell: an account clicked Camelot Teleport with no law runes), the runes of Bind, an antipoison on the
//   first two accounts of the list (poison did 139 of 455 damage; Rule antipoisonHolders), food for a full pack (the food list of the bank trip, scripts/pk-hunt.ts FOOD_LIST:
//   sharks first, then lobsters), a bank read of a stated age, and a place the walker leaves.
// Usage: bun scripts/squad-ready.ts [<account> ...] [--root <checkout>] [--max-age <hours>] [--json]
//          [--loadouts <dir>] [--orders <dir>] [--receipt <dir>] [--ignore-prayer] [--before-kit]
//   --before-kit  leaves out the check of what each account wears and carries now (the check is on otherwise, and off for
//               --receipt), to write the kit files before the kit step.
//   No account named: every account of this fleet side with 99 in the seven combat skills.
//   --ignore-prayer  leaves the prayer points out of the check, to write the kit files (a blocked account gets none) before
//               the altar step. It cannot be combined with --receipt: a receipt always checks the prayer points.
//   --root      the checkout whose .practice/status, .practice/market-all.json and fleet owners the tool reads
//               (default: the main checkout of this repository).
//   --loadouts  writes <account>.json for each account that holds its kit: the input of the kit step,
//               `bun scripts/aio-logistics.ts <account> loadout <file>` at the bank the file names.
//   --receipt   writes <account>.json for each account that it checked: schema squad-ready/1, ok, the rule, the time, the faults, and the
//               SHA-256 of the account's status file that it read (the fresh bank and worn snapshot). The swarm's kit-restored
//               repair (scripts/swarm.ts applyKitRestored) clears the hold of a PvP death on a passing receipt.
//   --orders    writes one fleet order file for each transfer of the plan into <dir>, for review. The tool refuses the
//               fleet's own orders folder; `bun scripts/fleet-order.ts`, which the plan prints, places an order.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BANK_MEETS } from './coin-courier';
import { makeOrder, writeFleetOrder } from './fleet-order';
import { castableFreeze, defaultSpec, ITEMS, wildernessLevel } from './pk';
import { packOf } from './pk-gang';
import { FOOD_LIST } from './pk-hunt';
import { kitItems } from './pk-kits';
import { kitFrom } from './pk-roam';
import { SQUAD_OPTS, SQUAD_POST, squadEscapeSpell, squadStartFood } from './pk-squad';
import { PROFILES } from './shop-buyer';

export type Item = { id: number; name: string; count: number };
export type Worn = Item & { slot: number };
export type Account = { name: string; at: number; bankAt: number | null; pos: { x: number; z: number; level: number }; levels: Readonly<Record<string, number>>; quests: ReadonlySet<string>;
    worn: Worn[]; pack: Item[]; bank: Item[]; side?: string; reservation?: string;
    // The current Prayer level (prayer points); absent when the status file does not name it.
    prayerPoints?: number };
// A member fights with at least this share of its base Prayer level as prayer points. Live: all four fighting members of
// the first run stood at Prayer 99 with 0 points and took 56 HP a kill; the clone replay with full points took half.
// The fix is the altar step: Varrock east church (scripts/pray-at-altar.ts PRAYER_ALTARS), never the nearest altar of an
// account at Edgeville, which is the Wilderness chaos temple.
export const PRAYER_FLOOR = 0.7;
export const PRAYER_ALTAR = '3253,3486';
export const prayerFloor = (base: number) => Math.ceil(base * PRAYER_FLOOR);
export type Gear = { id: number; name: string; slot: string; tier?: number; special?: { pvp?: boolean }; requires?: { skills?: Record<string, number>; quest?: string };
    bonuses: Record<string, number>; tradeable?: boolean };
// antipoisonHolders: the first accounts of the list that must hold an antipoison. The gang clone bench (five of ours,
// seeds 1 to 3, hosted run 44262314889) killed 9 of 9 with no death with a potion on all five, on the first two, on the
// first one and on none; the others carry the extra food (2 lobsters or 1 shark a kill).
export type Rule = {
    name: string;
    benchKit: string;
    maxBankAgeHours: number;
    maxDonorBankAgeHours: number;
    minArrows: number;
    antipoisonHolders: number;
    minHours?: number;
    requireQuests?: readonly string[];
    bisSupplies?: boolean;
};
export const SUPPLY_QUESTS = ['Lost City', 'Dragon Slayer', 'Death Plateau', 'Druidic Ritual', 'Tai Bwo Wannai Trio'] as const;
export const TRIBRID_BIS_ITEMS = {
    shark: 385,
    swordfish: 373,
    lobster: 379,
    cookedKarambwan: 3144,
    runeArrow: 892,
    adamantArrow: 890,
    earthRune: 557,
    waterRune: 555,
    natureRune: 561,
    lawRune: 563,
    airRune: 556,
    fireRune: 554,
    bloodRune: 565,
    cosmicRune: 564,
    climbingBoots: 3105,
    dragonDaggerP: 1231,
    magicShortbow: 861,
    blackBody: 2503,
    blackChaps: 2497,
    blackVambs: 2491,
    ringOfRecoil: 2550,
    berserkerHelm: 3751,
    runeFullHelm: 1163,
    runePlatebody: 1127,
    runePlatelegs: 1079,
    runeKiteshield: 1201,
} as const;
export const TRIBRID_POTION_DOSE_IDS: Readonly<Record<string, readonly [id: number, doses: number][]>> = {
    'Prayer potion(3)': [[139, 3], [2434, 4]],
    'Super attack(3)': [[145, 3], [2436, 4]],
    'Super strength(3)': [[157, 3], [2440, 4]],
    'Super defence(3)': [[163, 3], [2442, 4]],
    'Ranging potion(3)': [[169, 3], [2444, 4]],
    'Antipoison(3)': [[175, 3], [2446, 4], [181, 3], [2448, 4]],
};
export const RULES: Readonly<Record<string, Rule>> = {
    'gang-chain-bind': { name: 'gang-chain-bind', benchKit: 'live-walker-iron-rune-chain-bind', maxBankAgeHours: 6, maxDonorBankAgeHours: 168, minArrows: 100, antipoisonHolders: 2 },
    'gang-tribrid-bis': {
        name: 'gang-tribrid-bis',
        benchKit: 'live-walker-iron-rune-chain-bind',
        maxBankAgeHours: 6,
        maxDonorBankAgeHours: 168,
        minArrows: 100,
        antipoisonHolders: 4,
        minHours: 4,
        requireQuests: ['Lost City', 'Dragon Slayer', 'Death Plateau', 'Druidic Ritual'],
        bisSupplies: true,
    },
};

export function questBlockers(a: { quests: ReadonlySet<string> }, quests: readonly string[] = SUPPLY_QUESTS): string[] {
    return quests.filter(q => !a.quests.has(q.toLowerCase()));
}

export function enduranceHours(a: Account): { hours: number; limiting: string; foodHours: number; comboHours: number; ammoHours: number; runeHours: number; potionHours: number } {
    const own = holdings(a);
    const qty = (id: number) => own.get(id)?.count ?? 0;
    const foodUnits = qty(TRIBRID_BIS_ITEMS.shark) + qty(TRIBRID_BIS_ITEMS.swordfish) * 14 / 20 + qty(TRIBRID_BIS_ITEMS.lobster) * 12 / 20;
    const foodHours = foodUnits / 88.75;
    const comboHours = qty(TRIBRID_BIS_ITEMS.cookedKarambwan) / 25;
    const ammoHours = (qty(TRIBRID_BIS_ITEMS.runeArrow) + qty(TRIBRID_BIS_ITEMS.adamantArrow)) / 163.75;
    const runeRates: [string, number, number][] = [
        ['earth rune', TRIBRID_BIS_ITEMS.earthRune, 80.75],
        ['water rune', TRIBRID_BIS_ITEMS.waterRune, 80.75],
        ['nature rune', TRIBRID_BIS_ITEMS.natureRune, 53.75],
        ['law rune', TRIBRID_BIS_ITEMS.lawRune, 5],
        ['air rune', TRIBRID_BIS_ITEMS.airRune, 75],
        ['blood rune', TRIBRID_BIS_ITEMS.bloodRune, 27.5],
    ];
    let runeHours = Infinity, limitingRune = 'runes';
    for (const [label, id, perHr] of runeRates) {
        const h = qty(id) / perHr;
        if (h < runeHours) { runeHours = h; limitingRune = label; }
    }
    const potionRates: [string, readonly [number, number][], number][] = [
        ['prayer potion', TRIBRID_POTION_DOSE_IDS['Prayer potion(3)']!, 3],
        ['super attack', TRIBRID_POTION_DOSE_IDS['Super attack(3)']!, 1.5],
        ['super strength', TRIBRID_POTION_DOSE_IDS['Super strength(3)']!, 1.5],
        ['super defence', TRIBRID_POTION_DOSE_IDS['Super defence(3)']!, 1.5],
        ['ranging potion', TRIBRID_POTION_DOSE_IDS['Ranging potion(3)']!, 1.5],
        ['antipoison', TRIBRID_POTION_DOSE_IDS['Antipoison(3)']!, 1],
    ];
    let potionHours = Infinity, limitingPotion = 'potions';
    for (const [label, pairs, perHr] of potionRates) {
        const eq3 = pairs.reduce((n, [id, d]) => n + qty(id) * d / 3, 0);
        const h = eq3 / perHr;
        if (h < potionHours) { potionHours = h; limitingPotion = label; }
    }
    const candidates: [string, number][] = [
        ['sharks/food', foodHours],
        ['cooked karambwan', comboHours],
        ['rune arrows', ammoHours],
        [limitingRune, runeHours],
        [limitingPotion, potionHours],
    ];
    const [limiting, hours] = candidates.sort((x, y) => x[1] - y[1])[0]!;
    return { hours, limiting, foodHours, comboHours, ammoHours, runeHours, potionHours };
}

const SLOT: Readonly<Record<string, number>> = { hat: 0, back: 1, front: 2, righthand: 3, torso: 4, lefthand: 5, legs: 7, hands: 9, feet: 10, ring: 12, quiver: 13 };
const COMBAT = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Prayer', 'Hitpoints'] as const;
const MELEE_BLADE = /dagger|scimitar|longsword|sword|mace|battleaxe|warhammer|spear|halberd/i, BOW = /bow$/i, CROSSBOW = /crossbow/i;
// The food that a bank trip takes, in its order (scripts/pk-hunt.ts restock).
const FOOD_IDS: readonly number[] = FOOD_LIST.map(f => f.id), PACK_SLOTS = 27;
const isFood = (id: number) => FOOD_IDS.includes(id);
const armour = (g: Gear) => (g.bonuses.stabDefence ?? 0) + (g.bonuses.slashDefence ?? 0) + (g.bonuses.crushDefence ?? 0);
const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
// West Ardougne behind its wall (x 2558): the city doors stay shut until Biohazard is complete, and the walker has no
// route across the wall (packages/planner/src/autopilot.ts inWestArdougne).
export const inWestArdougne = (p: { x: number; z: number }) => p.x >= 2496 && p.x <= 2557 && p.z >= 3264 && p.z <= 3335;

export const maxed = (a: Account) => COMBAT.every(s => (a.levels[s.toLowerCase()] ?? 1) >= 99);
// Everything an account owns, by item id.
export function holdings(a: Account): Map<number, Item> {
    const out = new Map<number, Item>();
    for (const i of [...a.worn, ...a.pack, ...a.bank]) out.set(i.id, { id: i.id, name: i.name, count: (out.get(i.id)?.count ?? 0) + i.count });
    return out;
}
export function wearable(g: Gear, a: Account): boolean {
    return Object.entries(g.requires?.skills ?? {}).every(([skill, level]) => (a.levels[skill.toLowerCase()] ?? 1) >= level)
        && (!g.requires?.quest || a.quests.has(g.requires.quest.toLowerCase()));
}

// A piece that the account lacks. `accept` says which item of a donor fills it for this account; `blocking`: the
// verdict is "not ready" without it. `id`: the item to buy when no account has a spare one (the bench kit's piece
// for a class of items).
export type Need = { what: string; count: number; blocking: boolean; id?: number; accept: (item: Item) => boolean };
export type Pick = { account: string; ready: boolean; reasons: string[]; notes: string[]; worn: Worn[]; carried: Item[]; food: number; foodRows: Item[]; foodSlots: number; foodHeld: number; foodStock: Item[];
    styles: string[]; special: string | null; escape: string | null; freeze: string | null; needs: Need[]; pack: ReturnType<typeof packOf>;
    endurance?: ReturnType<typeof enduranceHours>; questBlockers?: string[] };

const SPELL_NAME: Readonly<Record<number, string>> = { 1174: 'Camelot Teleport', 1164: 'Varrock Teleport' };

// The kit of one account under the rule, from its own stock, with the pieces that it lacks.
// The faults of what an account wears and carries now against the kit that pickKit chose: a piece of the kit that is not
// worn, a worn quiver under the least arrows, a supply or the bow that is not in the pack, and a pack with food under
// the food floor. The fix of each is the kit step (`bun scripts/aio-logistics.ts <account> loadout <file>`).
export function carriedFaults(a: Account, worn: readonly Worn[], carried: readonly Item[], foodSlots: number, rule: Rule, nameOf: (id: number) => string | undefined = () => undefined): string[] {
    const out: string[] = [], count = (rows: readonly Item[], id: number) => rows.filter(r => r.id === id).reduce((n, r) => n + r.count, 0);
    for (const w of worn) {
        if (w.slot === 13) { const held = a.worn.find(x => x.slot === 13 && x.id === w.id)?.count ?? 0; if (held < Math.min(w.count, rule.minArrows)) out.push(`not worn: ${held} ${w.name} in the quiver (needs ${Math.min(w.count, rule.minArrows)}): the kit step wears it`); continue; }
        if (!a.worn.some(x => x.slot === w.slot && x.id === w.id)) out.push(`not worn: ${w.name}: the kit step wears it`);
    }
    for (const c of carried) { const held = count(a.pack, c.id); if (held < c.count) out.push(`pack lacks ${c.count - held} ${c.name}${c.count > 1 ? ` (${held} of ${c.count})` : ''}: the kit step takes it`); }
    const food = a.pack.filter(i => FOOD_IDS.includes(i.id)).reduce((n, i) => n + i.count, 0);
    if (!squadStartFood(food, foodSlots).ok) out.push(`pack holds ${food} food, under the floor of ${squadStartFood(food, foodSlots).floor} of ${foodSlots}: the kit step takes it`);
    return out;
}
// Stock for a second trip: the runes and arrows that the pack and the quiver carry, against what the pack, the bank and the quiver hold
// together. Under one pack's worth the member cannot even refill after a trip (a block); under two it can make one trip only (a note).
// Live run 4: every bank trip after the retreat failed for want of arrows and law runes (75 needed, 33 in the bank).
export function stockFaults(a: Account, worn: readonly Worn[], carried: readonly Item[], rule: Rule, nameOf: (id: number) => string | undefined = () => undefined): { blocks: string[]; notes: string[] } {
    const blocks: string[] = [], notes: string[] = [], total = (id: number) => [...a.pack, ...a.bank, ...a.worn.filter(w => w.slot === 13)].filter(r => r.id === id).reduce((n, r) => n + r.count, 0);
    const lines = [...carried.filter(c => c.count > 1).map(c => ({ id: c.id, name: c.name, need: c.count })), ...worn.filter(w => w.slot === 13).map(w => ({ id: w.id, name: w.name, need: Math.min(w.count, rule.minArrows) }))];
    for (const l of lines) {
        const have = total(l.id);
        if (have < l.need) blocks.push(`stock under one pack: ${have} ${l.name} in the pack, bank and quiver (a pack needs ${l.need})`);
        else if (have < 2 * l.need) notes.push(`stock for one trip only: ${have} ${l.name} of ${2 * l.need} for two trips`);
    }
    return { blocks, notes };
}
export function pickKit(a: Account, gear: ReadonlyMap<number, Gear>, rule: Rule, now: number, kit = kitItems(rule.benchKit), nameOf: (id: number) => string | undefined = () => undefined, post = SQUAD_POST, antipoisonRequired = true, carry = false): Pick {
    const own = holdings(a), needs: Need[] = [], reasons: string[] = [], notes: string[] = [];
    const benchPiece = (test: (g: Gear) => boolean) => [...kit.equipment, ...kit.inventory].map(i => gear.get(i.id)).find(g => !!g && test(g))?.id;
    const owned = [...own.values()].filter(i => i.count > 0), g = (i: Item) => gear.get(i.id);
    const canWear = (i: Item) => { const row = g(i); return !!row && wearable(row, a); };
    const benchWorn = new Map(kit.equipment.map(e => [e.slot, gear.get(e.id)] as const));
    const worn: Worn[] = [];
    const wear = (i: Item | undefined, slot: number, count = 1) => { if (i) worn.push({ id: i.id, name: i.name, count, slot }); };
    // Armour: the piece of each slot with the most melee defence that the account can wear. Body and legs must reach
    // half the defence of the bench kit's piece (green dragonhide chaps and mithril platelegs are under it).
    for (const [slot, required] of [['hat', false], ['torso', true], ['legs', true], ['lefthand', false]] as const) {
        const bench = benchWorn.get(SLOT[slot]!), floor = required && bench ? Math.ceil(armour(bench) / 2) : 1;
        const fits = (i: Item, who: (i: Item) => boolean) => { const row = g(i); return !!row && row.slot === slot && armour(row) >= floor && (slot !== 'lefthand' || /shield$/i.test(row.name)) && who(i); };
        const best = owned.filter(i => fits(i, canWear)).sort((x, y) => armour(g(y)!) - armour(g(x)!))[0];
        wear(best, SLOT[slot]!);
        if (!best && required) needs.push({ what: `${slot === 'torso' ? 'body' : 'leg'} armour (melee defence ${floor} or more)`, count: 1, blocking: true, ...(bench ? { id: bench.id } : {}), accept: i => fits(i, canWear) && g(i)!.tradeable !== false });
        else if (bench && (!best || armour(g(best)!) < armour(bench))) {
            notes.push(best ? `${best.name} is weaker than the bench kit's ${bench.name}` : `no ${bench.name} or other ${slot} piece`);
            needs.push({ what: bench.name, count: 1, blocking: false, id: bench.id, accept: i => fits(i, canWear) && armour(g(i)!) >= armour(bench) && g(i)!.tradeable !== false });
        }
    }
    // Amulet: a charged glory, else the piece with the most strength.
    const amulet = owned.filter(i => g(i)?.slot === 'front' && canWear(i)).sort((x, y) => Number(/glory\([1-4]\)/i.test(y.name)) - Number(/glory\([1-4]\)/i.test(x.name)) || (g(y)!.bonuses.strength ?? 0) - (g(x)!.bonuses.strength ?? 0))[0];
    wear(amulet, SLOT.front!);
    if (!amulet) notes.push('no amulet');
    // Melee weapon: a dragon dagger first (the gang-hunter profile's special), then the other special weapons, then a
    // rune blade, each by its strength bonus.
    const blade = (i: Item) => { const row = g(i); return !!row && row.slot === 'righthand' && MELEE_BLADE.test(row.name) && !BOW.test(row.name) && !/staff/i.test(row.name) && (!!row.special?.pvp || /^rune /i.test(row.name)); };
    const rank = (i: Item) => (/^dragon dagger/i.test(i.name) ? 2000 : g(i)!.special?.pvp ? 1000 : 0) + (g(i)!.bonuses.strength ?? 0);
    const weapon = owned.filter(i => blade(i) && canWear(i)).sort((x, y) => rank(y) - rank(x))[0];
    wear(weapon, SLOT.righthand!);
    if (!weapon) needs.push({ what: 'melee weapon with a special attack or a rune blade', count: 1, blocking: true, ...(benchWorn.get(SLOT.righthand!) ? { id: benchWorn.get(SLOT.righthand!)!.id } : {}), accept: i => blade(i) && canWear(i) && g(i)!.tradeable !== false });
    // Bow and arrows: the bow with the most ranged attack, and the strongest arrows that it fires (tier at or under the
    // bow's tier) with the bench kit's count, else the largest stack.
    const isBow = (i: Item) => { const row = g(i); return !!row && row.slot === 'righthand' && row.tier !== undefined && BOW.test(row.name) && !CROSSBOW.test(row.name); };
    const bow = owned.filter(i => isBow(i) && canWear(i)).sort((x, y) => (g(y)!.bonuses.rangeAttack ?? 0) - (g(x)!.bonuses.rangeAttack ?? 0))[0];
    const wantArrows = kit.equipment.find(e => e.slot === 13)?.count ?? 300, bowTier = bow ? g(bow)!.tier! : 1;
    const fires = (i: Item, tier: number) => { const row = g(i); return !!row && row.slot === 'quiver' && /arrow$/i.test(row.name) && (row.tier ?? 99) <= tier; };
    const stacks = owned.filter(i => fires(i, bowTier)).sort((x, y) => (g(y)!.tier ?? 0) - (g(x)!.tier ?? 0));
    const benchBow = benchPiece(row => BOW.test(row.name)), benchArrow = kit.equipment.find(e => e.slot === 13)?.id;
    // Arrows as strong as the bench kit's first: the first live pilot shot bronze arrows on two accounts.
    const strength = (i: Item) => g(i)!.bonuses.rangeStrength ?? 0, benchStrength = benchArrow !== undefined ? gear.get(benchArrow)?.bonuses.rangeStrength ?? 0 : 0;
    const largest = (rows: readonly Item[]) => [...rows].sort((x, y) => y.count - x.count)[0], strong = stacks.filter(i => strength(i) >= benchStrength);
    const arrows = strong.find(i => i.count >= wantArrows) ?? ((largest(strong)?.count ?? 0) >= rule.minArrows ? largest(strong) : undefined) ?? stacks.find(i => i.count >= wantArrows) ?? largest(stacks);
    const unstrung = owned.find(i => !g(i) && BOW.test(i.name) && !CROSSBOW.test(i.name));
    if (unstrung && (!bow || (benchBow !== undefined && (g(bow)!.bonuses.rangeAttack ?? 0) < (gear.get(benchBow)!.bonuses.rangeAttack ?? 0)))) notes.push(`holds an unstrung ${unstrung.name} (item ${unstrung.id}): it fires nothing until a Fletching account strings it`);
    if (bow && benchBow !== undefined && (g(bow)!.bonuses.rangeAttack ?? 0) < (gear.get(benchBow)!.bonuses.rangeAttack ?? 0)) {
        notes.push(`${bow.name} is weaker than the bench kit's ${gear.get(benchBow)!.name}`);
        needs.push({ what: gear.get(benchBow)!.name, count: 1, blocking: false, id: benchBow, accept: i => i.id === benchBow });
    }
    if (!bow) needs.push({ what: 'bow', count: 1, blocking: true, ...(benchBow !== undefined ? { id: benchBow } : {}), accept: i => isBow(i) && canWear(i) && g(i)!.tradeable !== false });
    if (arrows) wear(arrows, SLOT.quiver!, Math.min(arrows.count, wantArrows));
    const arrowsHeld = arrows ? Math.min(arrows.count, wantArrows) : 0;
    // Under the least count: one whole stack of any kind that the bow fires. Over it: more of the kind held.
    if (arrowsHeld < rule.minArrows) needs.push({ what: `arrows that a ${bow?.name ?? 'bow'} fires`, count: wantArrows, blocking: true, ...(benchArrow !== undefined ? { id: benchArrow } : {}), accept: i => fires(i, bowTier) });
    else if (strength(arrows!) < benchStrength) {
        notes.push(`${arrows!.name} is weaker than the bench kit's ${gear.get(benchArrow!)!.name}`);
        needs.push({ what: gear.get(benchArrow!)!.name, count: wantArrows, blocking: false, id: benchArrow!, accept: i => fires(i, bowTier) && strength(i) >= benchStrength });
    } else if (arrowsHeld < wantArrows) needs.push({ what: arrows!.name, count: wantArrows - arrowsHeld, blocking: false, id: arrows!.id, accept: i => i.id === arrows!.id });
    // The pack: the bow, an antipoison and each supply of the bench kit at its count, then sharks in every slot left.
    const carried: Item[] = [];
    if (bow) carried.push({ id: bow.id, name: bow.name, count: 1 });
    const antipoisons = ITEMS.antipoison as readonly number[], isAntipoison = (i: Item) => antipoisons.includes(i.id);
    const antipoison = owned.filter(isAntipoison).sort((x, y) => antipoisons.indexOf(x.id) % 4 - antipoisons.indexOf(y.id) % 4)[0];
    if (antipoison) carried.push({ id: antipoison.id, name: antipoison.name, count: 1 });
    else needs.push({ what: 'antipoison', count: 1, blocking: antipoisonRequired, ...(kit.inventory.find(i => antipoisons.includes(i.id)) ? { id: kit.inventory.find(i => antipoisons.includes(i.id))!.id } : {}), accept: isAntipoison });
    const supplies = kit.inventory.filter(i => !isFood(i.id) && !antipoisons.includes(i.id) && !gear.has(i.id));
    const short = new Map<number, number>();
    for (const s of supplies) {
        const have = own.get(s.id), take = Math.min(have?.count ?? 0, s.count);
        if (take > 0) carried.push({ id: s.id, name: have!.name, count: take });
        if (take < s.count) short.set(s.id, s.count - take);
    }
    const wornIds = worn.map(w => w.id), magic = a.levels.magic ?? 1;
    const escapeSpell = squadEscapeSpell(post.z, carried, wornIds, magic), freezeSpell = castableFreeze(Math.min(magic, SQUAD_OPTS.freezeMagicCap), carried);
    const freezeRunes: readonly number[] = [ITEMS.earthRune, ITEMS.waterRune, ITEMS.natureRune];
    for (const s of supplies) {
        const n = short.get(s.id);
        if (!n) continue;
        const blocking = freezeRunes.includes(s.id) ? freezeSpell === null : escapeSpell === null;
        needs.push({ what: own.get(s.id)?.name ?? nameOf(s.id) ?? `item ${s.id}`, id: s.id, count: n, blocking, accept: i => i.id === s.id });
    }
    // Food: each kind of the food list that the account holds, the first kind first, up to the free slots of the pack.
    const foodSlots = PACK_SLOTS - carried.length, foodStock = FOOD_IDS.flatMap(id => (own.get(id)?.count ?? 0) > 0 ? [{ ...own.get(id)! }] : []);
    const foodHeld = foodStock.reduce((n, f) => n + f.count, 0), foodRows: Item[] = [];
    for (const f of foodStock) { const take = Math.min(f.count, foodSlots - foodRows.reduce((n, r) => n + r.count, 0)); if (take > 0) foodRows.push({ id: f.id, name: f.name, count: take }); }
    const food = foodRows.reduce((n, r) => n + r.count, 0);
    // A member that holds at least the food floor of its pack starts with what it holds (scripts/pk-squad.ts
    // squadStartFood), so the missing meals are a want; under the floor they block.
    if (foodHeld < foodSlots) needs.push({ what: 'food (shark or lobster)', id: FOOD_IDS[0]!, count: foodSlots - foodHeld, blocking: !squadStartFood(foodHeld, foodSlots).ok, accept: i => isFood(i.id) });
    // The fight kit, the pack of a bank trip, the escape and the freeze, each from the code that the squad runs.
    // The special of the fight kit: the melee weapon's, else the bow's (scripts/pk.ts defaultSpec).
    const fight = kitFrom(worn, carried), special = defaultSpec(fight)?.style ?? null;
    const eat = [{ text: 'Eat' }], none: { text: string }[] = [];
    const pack = packOf([...carried.map(c => ({ id: c.id, count: c.count, optionsWithIndex: none })), ...foodRows.flatMap(r => Array.from({ length: r.count }, () => ({ id: r.id, count: 1, optionsWithIndex: eat })))], worn);
    for (const n of needs) if (n.blocking) reasons.push(`no ${n.what}${n.count > 1 ? ` (${n.count} short)` : ''}`);
    if (!fight.melee?.length && weapon) reasons.push('the fight kit holds no melee weapon');
    if (escapeSpell === null && !reasons.some(r => /Law rune|Air rune/.test(r))) reasons.push(`no escape teleport that Magic ${magic} can cast with the runes held`);
    if (freezeSpell === null && !reasons.some(r => /Earth rune|Water rune|Nature rune/.test(r))) reasons.push('no Bind cast with the runes held');
    const ageHours = a.bankAt === null ? Infinity : (now - a.bankAt) / 3_600_000;
    if (ageHours > rule.maxBankAgeHours) reasons.push(a.bankAt === null ? 'no bank read' : `bank read ${ageHours.toFixed(1)} h old (limit ${rule.maxBankAgeHours} h)`);
    // `carry`: the squad takes its pack from what the account holds at login (scripts/pk-gang.ts packOf), so the check also
    // reads what the account wears and carries now, not what the bank and the pack together could make. Live: an account
    // whose pack a failed trip had deposited was called READY and fought with no bow, no runes and no escape.
    if (carry) {
        for (const fault of carriedFaults(a, worn, carried, foodSlots, rule, nameOf)) reasons.push(fault);
        const stock = stockFaults(a, worn, carried, rule, nameOf);
        reasons.push(...stock.blocks);
        notes.push(...stock.notes);
    }
    const prayerBase = a.levels.prayer ?? 1;
    if (a.prayerPoints !== undefined && a.prayerPoints < prayerFloor(prayerBase)) reasons.push(`prayer points ${a.prayerPoints} of ${prayerBase}, under the floor of ${prayerFloor(prayerBase)}: bun scripts/pray-at-altar.ts ${a.name} ALTAR=${PRAYER_ALTAR}`);
    if (inWestArdougne(a.pos)) reasons.push('stands inside West Ardougne, which the walker cannot leave');
    if (wildernessLevel(a.pos.z) > 0) reasons.push(`stands in the Wilderness at level ${wildernessLevel(a.pos.z)}`);
    if (!maxed(a)) notes.push(`not 99 in ${COMBAT.filter(s => (a.levels[s.toLowerCase()] ?? 1) < 99).join(', ')}`);
    const endurance = enduranceHours(a);
    const missingQuests = questBlockers(a, rule.requireQuests ?? SUPPLY_QUESTS);
    if (rule.bisSupplies) {
        for (const q of missingQuests) reasons.push(`quest blocker: ${q} incomplete`);
        const bisRequirements: readonly [label: string, id: number, minCount: number][] = [
            ['Climbing boots', TRIBRID_BIS_ITEMS.climbingBoots, 1],
            ['Dragon dagger(p)', TRIBRID_BIS_ITEMS.dragonDaggerP, 1],
            ['Magic shortbow', TRIBRID_BIS_ITEMS.magicShortbow, 1],
            ["Black d'hide body", TRIBRID_BIS_ITEMS.blackBody, 1],
            ["Black d'hide chaps", TRIBRID_BIS_ITEMS.blackChaps, 1],
            ["Black d'hide vambraces", TRIBRID_BIS_ITEMS.blackVambs, 1],
            ['Ring of recoil', TRIBRID_BIS_ITEMS.ringOfRecoil, 2],
            ['Cooked karambwan', TRIBRID_BIS_ITEMS.cookedKarambwan, 25],
        ];
        for (const [label, id, count] of bisRequirements) {
            const held = own.get(id)?.count ?? 0;
            if (held < count) {
                const shortCount = count - held;
                needs.push({ what: label, id, count: shortCount, blocking: true, accept: i => i.id === id });
                reasons.push(`no ${label}${shortCount > 1 ? ` (${shortCount} short)` : ''}`);
            }
        }
        if (a.quests.has('the fremennik trials') && (own.get(TRIBRID_BIS_ITEMS.berserkerHelm)?.count ?? 0) < 1) {
            needs.push({ what: 'Berserker helm', id: TRIBRID_BIS_ITEMS.berserkerHelm, count: 1, blocking: false, accept: i => i.id === TRIBRID_BIS_ITEMS.berserkerHelm });
            notes.push('no Berserker helm (upgrade over Rune full helm after The Fremennik Trials)');
        }
        for (const [label, pairs] of Object.entries(TRIBRID_POTION_DOSE_IDS)) {
            if (label === 'Antipoison(3)') continue;
            const eq3 = pairs.reduce((n, [id, d]) => n + (own.get(id)?.count ?? 0) * d / 3, 0);
            if (eq3 < 4) {
                const shortCount = Math.ceil(4 - eq3);
                const ids = new Set(pairs.map(([id]) => id));
                needs.push({ what: label, id: pairs[0]![0], count: shortCount, blocking: true, accept: i => ids.has(i.id) });
                reasons.push(`no ${label} (${shortCount} short)`);
            }
        }
    }
    if (rule.minHours !== undefined && endurance.hours < rule.minHours) {
        reasons.push(`trip endurance ${endurance.hours.toFixed(1)} h under ${rule.minHours}.0 h floor (limiting: ${endurance.limiting})`);
    }
    return { account: a.name, ready: reasons.length === 0, reasons, notes, worn, carried, food, foodRows, foodSlots, foodHeld, foodStock, styles: Object.keys(fight), special,
        escape: escapeSpell === null ? null : SPELL_NAME[escapeSpell] ?? `spell ${escapeSpell}`, freeze: freezeSpell === null ? null : 'Bind', needs, pack, endurance, questBlockers: missingQuests };
}

export type Move = { from: string; to: string; id: number; item: string; count: number; blocking: boolean; distance: number; donorBankAgeHours: number; reserved: boolean };
export type Gap = { account: string; what: string; id?: number; count: number; blocking: boolean };
export type Plan = { picks: Pick[]; moves: Move[]; gaps: Gap[] };

// The staging plan: each need of each candidate, in the order given, from the nearest account with a spare piece.
// Spare: the bank of an account that is no candidate (its worn items and its pack are in use), and the gear that a
// candidate holds over its own kit (a candidate keeps its food, runes and arrows for its own bank trips). One piece
// goes to one account. A donor that covers the whole need comes first, then the nearest; a wanted supply that no one
// donor covers stays a gap, so that the plan holds few trades.
export function stagingPlan(candidates: readonly Account[], fleet: readonly Account[], gear: ReadonlyMap<number, Gear>, rule: Rule, now: number, kit = kitItems(rule.benchKit), nameOf: (id: number) => string | undefined = () => undefined, carry = false): Plan {
    const picks = candidates.map((a, i) => pickKit(a, gear, rule, now, kit, nameOf, SQUAD_POST, i < rule.antipoisonHolders, carry)), byName = new Map(picks.map(p => [p.account.toLowerCase(), p]));
    const spare = new Map<string, Map<number, Item>>();
    for (const a of fleet) {
        // No donor with an old bank read, and none that cannot walk to a meeting.
        if (a.bankAt === null || (now - a.bankAt) / 3_600_000 > rule.maxDonorBankAgeHours || inWestArdougne(a.pos) || wildernessLevel(a.pos.z) > 0) continue;
        const pick = byName.get(a.name.toLowerCase()), stock = new Map<number, Item>();
        for (const i of pick ? [...holdings(a).values()].filter(i => gear.has(i.id) && gear.get(i.id)!.slot !== 'quiver') : a.bank) stock.set(i.id, { id: i.id, name: i.name, count: (stock.get(i.id)?.count ?? 0) + i.count });
        if (pick) {
            const used = (id: number, n: number) => { const row = stock.get(id); if (row) row.count -= n; };
            for (const w of pick.worn) used(w.id, w.count);
            for (const c of pick.carried) used(c.id, c.count);
        }
        spare.set(a.name, stock);
    }
    const moves: Move[] = [], gaps: Gap[] = [];
    for (const [pass, blocking] of [[0, true], [1, false]] as const) for (const pick of picks) {
        void pass;
        const me = candidates.find(a => a.name === pick.account)!;
        for (const need of pick.needs.filter(n => n.blocking === blocking)) {
            let left = need.count;
            const donors = fleet.filter(d => d.name !== me.name && spare.has(d.name)).map(d => ({ d, rows: [...spare.get(d.name)!.values()].filter(i => i.count > 0 && need.accept(i)) }))
                .filter(x => x.rows.length);
            const total = (rows: readonly Item[]) => rows.reduce((n, r) => n + r.count, 0), covers = (rows: readonly Item[]) => total(rows) >= need.count;
            donors.sort((x, y) => Number(covers(y.rows)) - Number(covers(x.rows)) || (covers(x.rows) ? cheb(x.d.pos, me.pos) - cheb(y.d.pos, me.pos) : total(y.rows) - total(x.rows)));
            if (!blocking && donors[0] && !covers(donors[0].rows)) donors.length = 0;
            for (const { d, rows } of donors) {
                // Armour, a weapon and a bow: the best piece that the donor can spare. A supply: its stack.
                for (const row of rows.sort((x, y) => (gear.has(y.id) ? armour(gear.get(y.id)!) + (gear.get(y.id)!.bonuses.strength ?? 0) + (gear.get(y.id)!.bonuses.rangeAttack ?? 0) : y.count) - (gear.has(x.id) ? armour(gear.get(x.id)!) + (gear.get(x.id)!.bonuses.strength ?? 0) + (gear.get(x.id)!.bonuses.rangeAttack ?? 0) : x.count))) {
                    if (left <= 0) break;
                    const n = Math.min(left, row.count);
                    row.count -= n; left -= n;
                    moves.push({ from: d.name, to: me.name, id: row.id, item: row.name, count: n, blocking, distance: cheb(d.pos, me.pos), donorBankAgeHours: (now - d.bankAt!) / 3_600_000, reserved: !!d.reservation });
                }
                if (left <= 0) break;
            }
            if (left > 0) gaps.push({ account: me.name, what: need.what, ...(need.id !== undefined ? { id: need.id } : {}), count: left, blocking });
        }
    }
    return { picks, moves, gaps };
}

// The bank of BANK_MEETS (scripts/coin-courier.ts) nearest to a tile: where a fleet order for that account meets.
export function meetNear(pos: { x: number; z: number }): { bank: string; x: number; z: number } {
    const rows = BANK_MEETS.map(r => ({ bank: r.bank, x: r.tiles[0]![0], z: r.tiles[0]![1] }));
    return rows.sort((a, b) => cheb(a, pos) - cheb(b, pos))[0]!;
}
// One fleet order command for each donor and receiver pair: `bun scripts/fleet-order.ts <from> <to> <count> <item>`
// with `--with` for each further line, to run when the pause is lifted (an order's window starts at its writing).
export function orderCommands(moves: readonly Move[], posOf: (name: string) => { x: number; z: number }): { from: string; to: string; meet: string; lines: { item: string; count: number }[]; command: string }[] {
    const pairs = new Map<string, Move[]>();
    for (const m of moves) pairs.set(`${m.from}>${m.to}`, [...(pairs.get(`${m.from}>${m.to}`) ?? []), m]);
    return [...pairs.values()].map(rows => {
        const lines = [...rows.reduce((acc, m) => acc.set(m.item, (acc.get(m.item) ?? 0) + m.count), new Map<string, number>())].map(([item, count]) => ({ item, count }));
        const first = lines[0]!, meet = meetNear(posOf(rows[0]!.to)).bank;
        return { from: rows[0]!.from, to: rows[0]!.to, meet, lines,
            command: `MEET=${meet} TAKER_WAITS=1 bun scripts/fleet-order.ts ${rows[0]!.from} ${rows[0]!.to} ${first.count} ${first.item}${lines.slice(1).map(l => ` --with "${l.count} ${l.item}"`).join('')}` };
    });
}

// Where a missing item comes from when no account has a spare one: the shop-buyer profile whose shop stocks it
// (knowledge/shops.json through `shops`), then the Grand Exchange ask of .practice/market-all.json.
export type Shop = { inv: string; stock: { item: string; count: number }[] };
export const WILDERNESS_SHOPS: ReadonlySet<string> = new Set(['magearena_runeshop', 'magearena_staffshop']);
export const PROFILE_SHOP: Readonly<Record<string, string>> = {
    jiminua: 'junglestore',
    ardy: 'adventurershop',
    lowe: 'archeryshop',
    catherby_arrows: 'archeryshop2',
    dargaud: 'ranging_guild_bowshop',
    aubury: 'runeshop',
    betty: 'magicshop',
    magic_guild: 'magicguildshop',
    magic_guild_elemental: 'magicguildshop',
    scavvo: 'runiteshop',
    oziach: 'runeplateshop',
    jukat: 'dragonswordshop',
    jukat_dagger: 'dragonswordshop',
    skulgrimen: 'viking_weapons_shop',
    shantay: 'shantayshop',
    horvik: 'armourshop',
    louie: 'legsshop',
    valaine: 'championshop',
    thessalia: 'clotheshop',
    thessalia_gown: 'clotheshop',
    wydin_choc: 'wydinstore',
    baker: 'bakery',
    alfonse: 'karamja_fishrestaurant',
    tiadeche: 'tbwt_tiadeche_final_inventory',
    herquin: 'gemshop',
    gem_trader: 'gemshop2',
    taverley: 'herbloreshop',
};
export function shopSource(name: string, debugname: string, shops: readonly Shop[], profiles: Readonly<Record<string, { items: { re: RegExp }[]; need?: { skill: string; level: number } }>> = PROFILES): string | null {
    const out: string[] = [];
    for (const shop of shops) {
        if (WILDERNESS_SHOPS.has(shop.inv)) continue;
        const row = shop.stock.find(s => s.item === debugname && s.count > 0);
        if (!row) continue;
        const profile = Object.entries(PROFILE_SHOP).find(([key, inv]) => inv === shop.inv && profiles[key]?.items.some(i => i.re.test(name)))?.[0];
        out.push(profile ? `shop-buyer profile ${profile} (${shop.inv}, shelf ${row.count}${profiles[profile]!.need ? `, ${profiles[profile]!.need!.skill} ${profiles[profile]!.need!.level}` : ''})` : `${shop.inv} stocks ${row.count}: no shop-buyer profile line`);
    }
    return out.length ? out.sort((a, b) => Number(b.startsWith('shop-buyer')) - Number(a.startsWith('shop-buyer'))).slice(0, 2).join('; ') : null;
}

// The input of scripts/microbot-owned-loadout.ts for an account that holds its kit: the bank tile, the worn pieces
// and the pack. The script needs the account within 3 tiles of the bank tile.
export function loadoutOf(pick: Pick, bank: { x: number; z: number }): { bank: { x: number; z: number; level: number }; pack: { id: number; count: number }[]; wear: { id: number; count: number; slot: number }[]; cap: number; maximumMoves: number } {
    return { bank: { ...bank, level: 0 }, pack: [...pick.carried.map(c => ({ id: c.id, count: c.count })), ...pick.foodRows.map(r => ({ id: r.id, count: r.count }))],
        wear: pick.worn.map(w => ({ id: w.id, count: w.count, slot: w.slot })), cap: 600, maximumMoves: 128 };
}

// The kit step refuses an account that stands more than 3 tiles from the bank tile of its file (`owned loadout life/state/stop/budget`
// at tick 0, with no move). The command that brings the account to the tile, or null when it stands within 3 tiles.
export function walkToKitTile(account: string, at: { x: number; z: number }, bank: { x: number; z: number }): string | null {
    return Math.max(Math.abs(bank.x - at.x), Math.abs(bank.z - at.z)) <= 3 ? null : `bun scripts/walk-to.ts ${account} ${bank.x} ${bank.z}`;
}

// A status file (packages/core/src/status.ts) as an account. A noted item counts as its plain item.
// The receipt of one check (--receipt): it binds the verdict to the status file that the check read.
export function receiptOf(p: Pick, a: { at: number; bankAt: number | null }, rule: string, now: number, statusBytes: Uint8Array): { schema: 'squad-ready/1'; account: string; ok: boolean; rule: string; at: number; statusAt: number; bankAt: number | null; statusSha256: string; reasons: string[] } {
    return { schema: 'squad-ready/1', account: p.account, ok: p.ready, rule, at: now, statusAt: a.at, bankAt: a.bankAt, statusSha256: createHash('sha256').update(statusBytes).digest('hex'), reasons: p.reasons };
}
export function accountOf(status: any, owner?: { side?: string; reservation?: string }): Account | null {
    if (!status || typeof status.name !== 'string' || !status.name.trim() || !status.pos || !Number.isFinite(status.pos.x) || !Number.isFinite(status.pos.z) || !Array.isArray(status.skills)) return null;
    const validSkills = status.skills.filter((s: any) => s && typeof s.name === 'string' && Number.isFinite(s.level));
    const items = (rows: any): Item[] => (Array.isArray(rows) ? rows : []).filter((i: any) => i && Number.isSafeInteger(i.id) && typeof i.name === 'string' && Number.isFinite(i.count) && i.count > 0).map((i: any) => ({ id: Number.isSafeInteger(i.baseId) ? i.baseId : i.id, name: i.name, count: i.count }));
    const prayerCurrent = validSkills.find((s: any) => s.name === 'Prayer')?.currentLevel;
    return {
        name: status.name,
        at: Number.isFinite(status.at) ? Number(status.at) : 0,
        bankAt: Number.isFinite(status.bankAt) ? status.bankAt : null,
        pos: { x: status.pos.x, z: status.pos.z, level: Number.isSafeInteger(status.pos.level) ? status.pos.level : 0 },
        levels: Object.fromEntries(validSkills.map((s: any) => [String(s.name).toLowerCase(), s.level])),
        ...(Number.isFinite(prayerCurrent) ? { prayerPoints: prayerCurrent as number } : {}),
        quests: new Set((Array.isArray(status.quests) ? status.quests : []).filter((q: any) => q && typeof q.name === 'string' && q.state === 'complete').map((q: any) => String(q.name).toLowerCase())),
        worn: (Array.isArray(status.equipment) ? status.equipment : []).filter((i: any) => i && Number.isSafeInteger(i.id) && Number.isSafeInteger(i.slot) && typeof i.name === 'string').map((i: any) => ({ id: Number.isSafeInteger(i.baseId) ? i.baseId : i.id, name: i.name, count: Number.isFinite(i.count) && i.count > 0 ? i.count : 1, slot: i.slot })),
        pack: items(status.inventory),
        bank: items(status.bank),
        ...(owner?.side ? { side: owner.side } : {}),
        ...(owner?.reservation ? { reservation: owner.reservation } : {}),
    };
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
export function report(plan: Plan, accounts: readonly Account[], rule: Rule, now: number, source: (gap: Gap) => string): string[] {
    const out: string[] = [], byName = new Map(accounts.map(a => [a.name, a]));
    for (const p of plan.picks) {
        const a = byName.get(p.account)!, slot = (n: number) => p.worn.find(w => w.slot === n);
        out.push(`${p.ready ? 'READY    ' : 'NOT READY'} ${p.account}  at ${a.pos.x},${a.pos.z}  bank read ${a.bankAt === null ? 'never' : hours(now - a.bankAt) + ' ago'}${a.reservation ? '  (coordinator reservation)' : ''}`);
        out.push(`  wears    ${[['helm', 0], ['body', 4], ['legs', 7], ['shield', 5], ['amulet', 2], ['weapon', 3]].map(([label, n]) => `${label} ${slot(n as number)?.name ?? '-'}`).join(' | ')} | quiver ${slot(13) ? `${slot(13)!.count} ${slot(13)!.name}` : '-'}`);
        out.push(`  carries  ${p.carried.map(c => (c.count > 1 ? `${c.count} ` : '') + c.name).join(', ') || '-'} | food ${p.food} of ${p.foodSlots}${p.foodRows.length ? ` (${p.foodRows.map(r => `${r.count} ${r.name}`).join(', ')})` : ''}; holds ${p.foodStock.map(f => `${f.count} ${f.name}`).join(', ') || 'none'}: ${Math.floor(p.foodHeld / Math.max(1, p.foodSlots))} full packs`);
        out.push(`  fights   ${p.styles.join('+') || 'no style'}${p.special ? ` with a ${p.special} special attack` : ''} | escape ${p.escape ?? 'none'} | freeze ${p.freeze ?? 'none'}`);
        if (p.endurance) out.push(`  sustain  ${p.endurance.hours.toFixed(1)} h (limiting: ${p.endurance.limiting}; food ${p.endurance.foodHours.toFixed(1)}h, combo ${p.endurance.comboHours.toFixed(1)}h, ammo ${p.endurance.ammoHours.toFixed(1)}h, runes ${p.endurance.runeHours.toFixed(1)}h, pots ${p.endurance.potionHours.toFixed(1)}h) | quests missing: ${p.questBlockers?.join(', ') || 'none'}`);
        for (const r of p.reasons) out.push(`  blocked  ${r}`);
        for (const n of p.notes) out.push(`  note     ${n}`);
        for (const m of plan.moves.filter(m => m.to === p.account)) out.push(`  ${m.blocking ? 'missing ' : 'wanted  '} ${m.count} ${m.item} <- ${m.from} (${m.distance} tiles, bank read ${m.donorBankAgeHours.toFixed(1)} h ago${m.reserved ? ', coordinator reservation' : ''})`);
        for (const gap of plan.gaps.filter(x => x.account === p.account)) out.push(`  ${gap.blocking ? 'missing ' : 'wanted  '} ${gap.count} ${gap.what} <- no owned spare: ${source(gap)}`);
    }
    out.push(`SQUAD_READY rule=${rule.name} ready=${plan.picks.filter(p => p.ready).map(p => p.account).join(',') || 'none'} notReady=${plan.picks.filter(p => !p.ready).map(p => p.account).join(',') || 'none'}`);
    return out;
}

if (import.meta.main) {
    const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    const valued = new Set(['--root', '--max-age', '--loadouts', '--orders', '--rule', '--receipt']);
    const names = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''));
    // The main checkout holds the status files: a worktree's git directory is <main>/.git/worktrees/<name>.
    const here = resolve(import.meta.dir, '..');
    const mainOf = (dir: string) => { try { const m = readFileSync(join(dir, '.git'), 'utf8').match(/^gitdir: (.+?)[\\/]\.git[\\/]worktrees[\\/]/m); return m ? resolve(m[1]!) : dir; } catch { return dir; } };
    const root = resolve(flag('--root') ?? mainOf(here)), now = Date.now();
    const ruleName = flag('--rule') ?? 'gang-chain-bind';
    const baseRule = RULES[ruleName];
    if (!baseRule) throw Error(`unknown squad-ready rule: ${ruleName}`);
    const rule = { ...baseRule, ...(flag('--max-age') ? { maxBankAgeHours: Number(flag('--max-age')) } : {}) };
    const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
    const gearRows = read(join(here, 'knowledge', 'gear.json')) as Gear[], gear = new Map(gearRows.map(r => [r.id, r]));
    const items = read(join(here, 'knowledge', 'items.json')) as { id: number; name: string; debugname: string }[];
    const shops = read(join(here, 'knowledge', 'shops.json')) as Shop[];
    const ownersFile = [join(root, '.practice', 'fleet-data', 'fleet', 'owners.json'), join(root, 'fleet', 'owners.json')].find(existsSync);
    const owners = new Map(Object.entries((ownersFile ? read(ownersFile).accounts : {}) as Record<string, { side: string; server: string; reservation?: string }>).map(([n, o]) => [n.toLowerCase(), o]));
    const side = process.env.FLEET_SIDE || 'local', server = 'rs-sdk-demo.fly.dev';
    const statusDir = join(root, '.practice', 'status');
    const fleet = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => {
        try {
            const status = read(join(statusDir, f)), owner = owners.get(String(status?.name).toLowerCase());
            if (status?.server !== server || !owner || owner.side !== side || String(status.name).toLowerCase() === 'haggis') return [];
            const a = accountOf(status, owner);
            return a ? [a] : [];
        } catch { return []; }
    }) : [];
    // No account named: the maxed accounts, the one with the fewest blocking faults first.
    const nameOf = (id: number) => items.find(i => i.id === id)?.name;
    const blockers = (a: Account) => pickKit(a, gear, rule, now).reasons.length;
    const candidates = names.length ? names.map(n => fleet.find(a => a.name.toLowerCase() === n.toLowerCase()) ?? (() => { throw Error(`no status file of this side's account ${n} in ${statusDir}`); })())
        : fleet.filter(maxed).sort((x, y) => blockers(x) - blockers(y));
    if (args.includes('--ignore-prayer')) {
        if (flag('--receipt')) throw Error('--ignore-prayer cannot be combined with --receipt: a receipt always checks the prayer points');
        for (const a of candidates) delete a.prayerPoints;
    }
    // The pack and worn check is on, except before the kit step (--before-kit, which writes the kit files) and for a receipt
    // (the swarm's kit-restored repair reads the holdings, not the pack).
    const carry = !args.includes('--before-kit') && !flag('--receipt');
    const plan = stagingPlan(candidates, fleet, gear, rule, now, undefined, nameOf, carry);
    let market: Record<string, { ask: number | null; sell: number }> = {};
    try { market = read(join(root, '.practice', 'market-all.json')).items; } catch { /* no market file: the plan names no price */ }
    const source = (gap: Gap) => {
        const row = gap.id !== undefined ? items.find(i => i.id === gap.id) : undefined, m = gap.id !== undefined ? market[String(gap.id)] : undefined;
        const shop = row?.id === TRIBRID_BIS_ITEMS.climbingBoots ? 'shop-buyer profile tenzing (Death Plateau dialog, 12 coins)' : row ? shopSource(row.name, row.debugname, shops) : null;
        return [shop, m?.ask ? `Grand Exchange ask ${m.ask} each (${m.sell} on sale), ${gap.count * m.ask} for ${gap.count}` : row ? 'no Grand Exchange seller' : null].filter(Boolean).join('; ') || 'see the plan';
    };
    if (args.includes('--json')) console.log(JSON.stringify({ rule, now, picks: plan.picks.map(({ needs, ...p }) => ({ ...p, needs: needs.map(({ accept: _accept, ...n }) => n) })), moves: plan.moves, gaps: plan.gaps }, null, 1));
    else {
        console.log(`squad readiness: rule ${rule.name} (bench kit ${rule.benchKit}), status files ${statusDir}, ${fleet.length} accounts of side ${side}`);
        for (const line of report(plan, fleet, rule, now, source)) console.log(line);
        const posOf = (name: string) => fleet.find(a => a.name === name)!.pos, orders = orderCommands(plan.moves, posOf);
        if (orders.length) console.log('PLAN transfers (run each when the pause is lifted; both accounts must have no enabled job):');
        for (const o of orders) console.log(`  ${o.command}`);
    }
    const loadouts = flag('--loadouts');
    if (loadouts) {
        mkdirSync(loadouts, { recursive: true });
        for (const p of plan.picks.filter(p => p.ready)) {
            const a = fleet.find(x => x.name === p.account)!, bank = meetNear(a.pos);
            writeFileSync(join(loadouts, `${p.account}.json`), JSON.stringify(loadoutOf(p, bank), null, 1) + '\n');
            console.log(`LOADOUT ${join(loadouts, `${p.account}.json`)} at the ${bank.bank} bank (${cheb(bank, a.pos)} tiles from the account)`);
            const walk = walkToKitTile(p.account, a.pos, bank);
            if (walk) console.log(`  first (the kit step needs the account within 3 tiles of the bank tile): ${walk}`);
        }
    }
    const receipts = flag('--receipt');
    if (receipts) {
        mkdirSync(receipts, { recursive: true });
        for (const p of plan.picks) {
            const a = fleet.find(x => x.name === p.account)!;
            const body = receiptOf(p, a, rule.name, now, readFileSync(join(statusDir, `${p.account}.json`)));
            writeFileSync(join(receipts, `${p.account}.json`), JSON.stringify(body, null, 1) + '\n');
            console.log(`RECEIPT ${join(receipts, `${p.account}.json`)} ok=${body.ok}`);
        }
    }
    const orderDir = flag('--orders');
    if (orderDir) {
        const fleetOrders = [join(root, '.practice', 'fleet-data', 'fleet', 'orders'), join(root, 'fleet', 'orders'), join(here, 'fleet', 'orders')].map(p => resolve(p).toLowerCase());
        if (fleetOrders.includes(resolve(orderDir).toLowerCase()) || /[\\/]fleet[\\/]orders$/i.test(resolve(orderDir))) throw Error('--orders refuses a fleet orders folder: scripts/fleet-order.ts places an order');
        const fleetOwners = new Map([...owners].map(([n, o]) => [n, { side: o.side, server: o.server }]));
        for (const o of orderCommands(plan.moves, name => fleet.find(a => a.name === name)!.pos)) {
            const meet = BANK_MEETS.find(r => r.bank === o.meet)!.meet;
            const order = { ...makeOrder(o.from, o.to, o.lines[0]!.count, o.lines[0]!.item, now, 15, 40, fleetOwners, meet, o.lines.slice(1)), takerWaits: true as const };
            console.log(`ORDER_FILE ${writeFleetOrder(orderDir, order)}`);
        }
    }
}
