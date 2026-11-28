// PK hunter: restocks a tribrid kit at Edgeville bank, walks into the shallow Wilderness north of Edgeville, fights the
// nearest attackable player who is not a fleet account (or anyone who attacks it) with scripts/pk.ts, loots a kill and
// banks again when food runs low or after a glory escape. A death ends the run; so do the tick cap and a stop file.
// Usage: bun scripts/pk-hunt.ts <bot> [CAP ticks, default 6000]. Environment: HUNT_FOOD sharks per trip (default 18),
// MIN_FOOD sharks that send it back to bank (default 6), ESCAPE_AT HP (default 35). For a build other than the maxed
// tribrid: PK_KIT the switch weapons as JSON {"magic":[ids],"ranged":[ids],"melee":[ids]}, PK_TRIP what a trip carries
// besides sharks as JSON [{"id":n,"count":n}], PK_SPELL the damage spell's component id (scripts/pk.ts SPELLS),
// PK_ROTATION the style order, e.g. "ranged,magic" for a pure with Strength 1, PK_TELE a teleport spell's component
// id (scripts/pk.ts SPELLS) used where no glory is carried, both to reach Edgeville and to escape. An account that starts
// more than 60 tiles from Edgeville rubs a carried glory there first, or casts PK_TELE and walks on. PK_SPOTS replaces
// the hunt spots as JSON [{"x":n,"z":n,"dwell":ticks}], visited in order (dwell 0 makes a waypoint), so a route can
// reach the deep Wilderness; HUNT_MAX_DEATHS the deaths that the hunt re-kits after (default 1; a PvP death sends the account to
// Lumbridge with 1 Hitpoints: it walks to the bank, eats up and wears its starting kit again); PK_OBSERVE=1 only watches and logs (it still fights back when attacked). Every player seen
// is logged as `HUNT seen` when first seen and whenever its verdict changes. openBot refuses a non-local server without DEMO_OK=1.
import { existsSync } from 'node:fs';
import type { Session } from '../../../core/src/inprocess';
import { loadOwners } from '../../../core/src/fleet';
import { isLocalServer } from '../../../core/src/localserver';
import { PVP_DEATH_LIMITS, pvpDeathRefusal, recordPvpDeath } from '../../../core/src/pvp-deaths';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { attackable, bestFood, rewearStart, castableFreeze, defaultSpec, fightPlayer, getObjNames as objNames, isMulti, ITEMS, nextTick, observePlayer, packGain, recordKillLoot, SPELLS, wildernessLevel, type FightOptions, type FightResult, type Kit, type Style } from './fight';
import { armourDefence } from './pk-read';
import { assessWildernessThreat, connectRadar, hasVarrockTeleport, itemCost, planWildernessEscape, Radar, slashWebThrough, wildernessCombatMargin, wildernessDepth } from './wild-rules';
import type { ItemCount, ItemRequirement, RequirementResolution } from '../../../core/src/item-requirements';
import { lootCapacity } from '../../../core/src/loot-policy';

let itemReqMod: typeof import('../../../core/src/item-requirements') | undefined;
function getItemReqs(): typeof import('../../../core/src/item-requirements') {
    return (itemReqMod ??= require('../../../core/src/item-requirements') as typeof import('../../../core/src/item-requirements'));
}

export const EDGEVILLE_BANK = { x: 3092, z: 3496 };
// Wilderness levels 3-7 north of Edgeville, inside single-way combat (multiway.csv: east Wilderness starts at x 3136).
export type Spot = { x: number; z: number; dwell?: number };
export const HUNT_SPOTS: readonly Spot[] = [{ x: 3094, z: 3540 }, { x: 3100, z: 3556 }, { x: 3094, z: 3562 }];
// Named rev 289 Wilderness patrol routes selectable via HUNT_SPOT=<name>.
export const HUNT_PRESETS: Readonly<Record<string, readonly Spot[]>> = {
    edgeville: HUNT_SPOTS,
    'varrock-multi': [{ x: 3240, z: 3540 }, { x: 3255, z: 3565 }, { x: 3235, z: 3585 }],
    'chaos-temple': [{ x: 3236, z: 3630 }, { x: 3242, z: 3640 }, { x: 3228, z: 3635 }],
    'dark-warriors': [{ x: 3028, z: 3630 }, { x: 3036, z: 3638 }, { x: 3022, z: 3638 }],
    'bone-yard': [{ x: 3230, z: 3740 }, { x: 3248, z: 3752 }, { x: 3236, z: 3762 }],
    'green-dragons': [{ x: 3092, z: 3810 }, { x: 3107, z: 3812 }, { x: 3118, z: 3820 }],
    'lava-maze': [{ x: 3067, z: 3856 }, { x: 3055, z: 3868 }, { x: 3045, z: 3855 }],
    'mage-bank': [{ x: 3090, z: 3955 }, { x: 3098, z: 3956 }, { x: 3104, z: 3952 }],
};
export function resolveHuntSpots(env: Record<string, string | undefined>): readonly Spot[] | undefined {
    if (env.PK_SPOTS) return JSON.parse(env.PK_SPOTS) as Spot[];
    if (!env.HUNT_SPOT) return undefined;
    const preset = HUNT_PRESETS[env.HUNT_SPOT];
    if (!preset) throw new Error(`unknown HUNT_SPOT ${env.HUNT_SPOT} (expected ${Object.keys(HUNT_PRESETS).join(', ')})`);
    return preset;
}
export const KIT_IDS = { mysticFireStaff: 1401, magicShortbow: 861, runeArrow: 892, dragonDaggerP: 1231, runeKiteshield: 1201 } as const;
export const TRIBRID_KIT: Kit = { magic: [KIT_IDS.mysticFireStaff], ranged: [KIT_IDS.magicShortbow], melee: [KIT_IDS.dragonDaggerP, KIT_IDS.runeKiteshield] };
// What a trip carries besides food: the switch weapons, Fire Wave runes (air, blood; the staff gives fire), two prayer
// potions and a glory for the escape.
export type TripItem = ItemCount & { minDoses?: number; minCharges?: number; minCount?: number; maxSlots?: number };
export const TRIP: readonly TripItem[] = [
    { id: KIT_IDS.mysticFireStaff, count: 1 }, { id: KIT_IDS.magicShortbow, count: 1 },
    { id: ITEMS.airRune, count: 300 }, { id: ITEMS.bloodRune, count: 60 }, { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1, minCharges: 1, maxSlots: 1 },
] as const;

// The snare kit (scripts/pk-kits.ts tribrid-snare): bow and dagger for the fight, the runes of Entangle for a target that
// runs (5 earth, 5 water and 4 nature a cast), no staff and no wave runes. It beat the staff kit against the melee
// build, the hybrid and the ranger (research/pvp-fight-loop.md). PK_KIT=snare selects the kit and this trip.
export const SNARE_KIT: Kit = { ranged: [KIT_IDS.magicShortbow], melee: [KIT_IDS.dragonDaggerP, KIT_IDS.runeKiteshield] };
export const SNARE_TRIP: readonly TripItem[] = [
    { id: KIT_IDS.magicShortbow, count: 1 }, { id: ITEMS.earthRune, count: 50 }, { id: ITEMS.waterRune, count: 50 }, { id: ITEMS.natureRune, count: 40 },
    { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1, minCharges: 1, maxSlots: 1 },
] as const;

// Never fight our own accounts: every fleet side's owners plus the main account.
export function fleetNames(owners = loadOwners()): Set<string> {
    const out = new Set<string>(['haggis']);
    for (const k of owners.keys()) out.add(k.toLowerCase());
    return out;
}

type Seen = { index: number; name: string; combatLevel: number; z: number; distance: number; inCombat?: boolean; combatTargetType?: string };
// Why a seen player is or is not a target: a fleet account, outside the Wilderness combat range, already in a player
// fight (single-way combat refuses a second attacker), or attackable.
export function verdict(me: { z: number; combatLevel: number }, p: Seen, ours: Set<string>, multi = false): 'fleet' | 'out of range' | 'busy' | 'attackable' {
    if (ours.has(p.name.toLowerCase())) return 'fleet';
    if (!attackable(me, p)) return 'out of range';
    if (!multi && p.inCombat && p.combatTargetType === 'player') return 'busy';
    return 'attackable';
}
// The player to fight: whoever is hitting us first, else the nearest attackable stranger who is not fighting someone else
// in single-way combat (or any attackable stranger in multi-way).
// The hunt's choice (HUNT_PICK, default soft): of the attackable players, the one whose worn armour gives the least
// melee defence (read from what the client shows it wearing), then the nearest; HUNT_PICK=near takes the nearest.
export function pickTarget<P extends Seen>(me: { z: number; combatLevel: number }, players: readonly P[], ours: Set<string>, attackerIndex: number | null,
    armour?: (p: P) => number, multi = false): P | undefined {
    let best: P | undefined;
    let bestArmour = Infinity;
    let bestDist = Infinity;
    for (let i = 0; i < players.length; i++) {
        const p = players[i]!;
        if (attackerIndex !== null && p.index === attackerIndex) return p;
        if (verdict(me, p, ours, multi) !== 'attackable') continue;
        const arm = armour ? armour(p) : 0;
        if (!best || arm < bestArmour || (arm === bestArmour && p.distance < bestDist)) {
            best = p;
            bestArmour = arm;
            bestDist = p.distance;
        }
    }
    return best;
}

// A hit we took from another player. The SDK also reports an NPC's damage from someone else as damage_taken, with
// targetType npc and source index -1; those are not attacks on us.
export const hitByPlayer = (e: { type: string; sourceType: string; targetType: string; sourceIndex: number }) =>
    e.type === 'damage_taken' && e.sourceType === 'other_player' && e.targetType === 'player' && e.sourceIndex >= 0;

const held = (s: Session, id: number) => {
    const inv = s.sdk.getInventory();
    let total = 0;
    for (let i = 0; i < inv.length; i++) {
        const row = inv[i]!;
        if (row.id === id) total += row.count;
    }
    return total;
};
// The food of a trip, best first, with the Hitpoints that one piece heals (content consume_effects.dbrow: shark 20, lobster 12).
// The restock and the bank trips take sharks first and fill what the bank lacks with lobsters.
// A member starts a run, or leaves a bank, with at least this share of the food of its pack. Under it the missing food
// blocks (scripts/pk-squad.ts squadStartFood, restock below).
export const FOOD_START_FLOOR = 0.5;
export const FOOD_LIST: readonly { id: number; heal: number }[] = [{ id: ITEMS.shark, heal: 20 }, { id: 379, heal: 12 }];
export const healOf = (id: number): number => FOOD_LIST.find(f => f.id === id)?.heal ?? 12;
// The pieces of food in a pack.
export const foodHeld = (s: Session) => FOOD_LIST.reduce((n, f) => n + held(s, f.id), 0);
// `want` pieces of food from what `have` counts (the bank and the pack): sharks first, then lobsters. A shortfall is a row of sharks
// for the rest, so that the requirement check names it.
export function planFood(have: (id: number) => number, want: number): ItemCount[] {
    const out: ItemCount[] = [];
    let left = want;
    for (const f of FOOD_LIST) {
        const n = Math.min(left, have(f.id));
        if (n > 0) { out.push({ id: f.id, count: n }); left -= n; }
    }
    if (left > 0) { const shark = out.find(r => r.id === ITEMS.shark); if (shark) shark.count += left; else out.push({ id: ITEMS.shark, count: left }); }
    return out;
}

async function walk(s: Session, to: { x: number; z: number }, stop: () => boolean, maxTicks = 400) {
    return walkPath(await sessionWalker(s), [{ ...to, tol: 2 }], { maxTicks, idleMs: 9000, stop });
}

// One of each boost the fight loop drinks, in any dose.
export const BOOST_POTIONS = [ITEMS.superAttack, ITEMS.superStrength, ITEMS.rangingPotion] as const;
// Re-equip the melee set and any unequipped body armour, bank everything else in the pack, then withdraw the trip and food.
// The bow trip: the snare trip with no runes and three more sharks in their place. In a stand-up fight the kit with 21
// sharks and no freeze beat the snare kit 33 to 13 (research/pvp-fight-loop.md), and up to Wilderness level 30 a
// glory works at once, so no freeze holds a target there.
export const BOW_TRIP: readonly TripItem[] = [{ id: KIT_IDS.magicShortbow, count: 1 }, { id: 2434, count: 2 }, { id: ITEMS.glory[0], count: 1, minCharges: 1, maxSlots: 1 }] as const;
export type TripPick = { name: 'bow' | 'snare' | 'staff'; kit: Kit; trip: readonly TripItem[]; moreFood: number; resolution: RequirementResolution };

export function tripRequirements(trip: readonly TripItem[], worn: readonly ItemCount[] = [], stock?: readonly ItemCount[]): ItemRequirement[] {
    const whole = (n: unknown, max = 2147483647) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= max;
    const whole0 = (n: unknown, max = 2147483647) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
    if (!Array.isArray(trip) || trip.length > 28 || trip.some(row => !row || typeof row !== 'object'
        || !Number.isSafeInteger(row.id) || row.id < 0 || row.id > 2147483647 || !whole(row.count)
        || row.minDoses !== undefined && !whole(row.minDoses) || row.minCharges !== undefined && !whole(row.minCharges)
        || row.minCount !== undefined && !whole0(row.minCount)
        || row.maxSlots !== undefined && !whole(row.maxSlots, 28)
        || row.minDoses !== undefined && row.minCharges !== undefined
        || row.minCount !== undefined && (row.minDoses !== undefined || row.minCharges !== undefined))) return [{ id: -1, count: NaN }];
    let wornMap: Map<number, number> | undefined;
    let stockMap: Map<number, number> | undefined;
    const out: ItemRequirement[] = [];
    for (let i = 0; i < trip.length; i++) {
        const row = trip[i]!;
        const unit = getItemReqs().nativeRequirementMetadata(row.id)?.unit;
        if (row.minDoses !== undefined && row.minCharges !== undefined || (row.minCount !== undefined && unit?.kind !== undefined) || !Number.isSafeInteger(row.count) || row.count < 1) {
            out.push({ id: row.id, count: NaN });
            continue;
        }
        const kind = row.minDoses !== undefined ? 'doses' : row.minCharges !== undefined ? 'charges' : unit?.kind;
        if (kind) {
            out.push({ id: row.id, kind, minUnits: row.minDoses ?? row.minCharges ?? row.count * (unit?.units ?? NaN), maxSlots: row.maxSlots ?? row.count });
            continue;
        }
        if (!wornMap) {
            wornMap = new Map<number, number>();
            for (let w = 0; w < worn.length; w++) {
                const item = worn[w]!;
                wornMap.set(item.id, (wornMap.get(item.id) ?? 0) + item.count);
            }
        }
        const wornCount = wornMap.get(row.id) ?? 0;
        const wantNeed = Math.max(0, row.count - wornCount);
        if (row.minCount === undefined) {
            if (wantNeed > 0) out.push({ id: row.id, count: wantNeed });
            continue;
        }
        const minNeed = Math.max(0, Math.min(row.count, row.minCount) - wornCount);
        if (!stock) {
            if (minNeed > 0) out.push({ id: row.id, count: minNeed });
            continue;
        }
        if (!stockMap) {
            stockMap = new Map<number, number>();
            for (let sIdx = 0; sIdx < stock.length; sIdx++) {
                const item = stock[sIdx]!;
                stockMap.set(item.id, (stockMap.get(item.id) ?? 0) + item.count);
            }
        }
        const have = stockMap.get(row.id) ?? 0;
        const count = have >= wantNeed ? wantNeed : have >= minNeed ? have : minNeed;
        if (count > 0) out.push({ id: row.id, count });
    }
    return out;
}
const resolveTrip = (stock: readonly ItemCount[], trip: readonly TripItem[], worn: readonly ItemCount[] = []) => {
    const { nativeRequirementMetadata, resolveItemRequirements } = getItemReqs();
    return resolveItemRequirements(tripRequirements(trip, worn, stock), stock, nativeRequirementMetadata);
};
export const invalidTrip = (trip: readonly TripItem[]) => resolveTrip([], trip).shortages.filter(row => ['invalid', 'unknown', 'noted'].includes(row.reason));
// The trip a bank can fill. `shallow`: every hunt spot is at Wilderness level 30 or less; the bow trip is first there.
// Else the snare trip where the bank holds all of it, else the staff trip.
export function pickTrip(bank: readonly ItemCount[], shallow = false, worn: readonly ItemCount[] = []): TripPick {
    const bow = resolveTrip(bank, BOW_TRIP, worn);
    if (shallow && bow.ok) return { name: 'bow', kit: SNARE_KIT, trip: BOW_TRIP, moreFood: 3, resolution: bow };
    const snare = resolveTrip(bank, SNARE_TRIP, worn);
    return snare.ok ? { name: 'snare', kit: SNARE_KIT, trip: SNARE_TRIP, moreFood: 0, resolution: snare }
        : { name: 'staff', kit: TRIBRID_KIT, trip: TRIP, moreFood: 0, resolution: resolveTrip(bank, TRIP, worn) };
}

// `choose` picks the trip from the bank once the pack is banked (the hunter with no kit named: pickTrip).
export async function restock(s: Session, food: number, trip: readonly TripItem[] = TRIP, kit: Kit = TRIBRID_KIT,
    choose?: (bank: readonly ItemCount[], worn?: readonly ItemCount[]) => { trip: readonly TripItem[]; moreFood: number; resolution?: RequirementResolution }): Promise<string | null> {
    const invalid = invalidTrip(trip);
    if (invalid.length) return 'invalid trip requirements ' + JSON.stringify(invalid);
    const equip = typeof s.sdk.getEquipment === 'function' ? () => s.sdk.getEquipment() : () => s.sdk.getState()?.equipment ?? [];
    const gloryIds = new Set<number>(ITEMS.glory);
    let gloryWorn = equip().some(e => gloryIds.has(e.id));
    let switched = false;
    for (const item of [...s.sdk.getInventory()]) {
        const wantGlory = gloryIds.has(item.id) && !gloryWorn;
        const wantArmour = /(platebody|chainbody|platelegs|plateskirt|full helm|med helm|kiteshield|sq shield|berserker helm)/i.test(item.name);
        if (!(kit.melee ?? []).includes(item.id) && !wantArmour && !wantGlory) continue;
        if (!wantGlory && equip().some(e => e.id === item.id)) continue;
        const op = item.optionsWithIndex?.find(x => /^(Wield|Wear)$/i.test(x.text));
        if (op) { await s.sdk.sendUseItem(item.slot, op.opIndex); switched = true; if (wantGlory) gloryWorn = true; }
    }
    if (switched && typeof s.onTick === 'function') await nextTick(s);
    if (!(await s.bot.openBank()).success) return 'bank did not open';
    // What the bank holds once the pack is deposited: the bank and the pack together. The trip is resolved against it
    // before the deposit, so a trip that cannot be filled leaves the pack in the pack (a deposit with no way back
    // stranded an account with an empty pack at the bank).
    const initialStock = [...s.sdk.getBankItems(), ...s.sdk.getInventory()];
    let selected: RequirementResolution | undefined;
    if (choose) { const pick = choose(initialStock, equip()); trip = pick.trip; food += pick.moreFood; selected = pick.resolution; }
    const fail = async (r: RequirementResolution) => { await s.bot.closeBank(); return 'bank lacks trip requirements ' + JSON.stringify(r.shortages) + ` (${shortageText(r.shortages, id => objNames().get(id))})`; };
    selected ??= resolveTrip(initialStock, trip, equip());
    if (!selected.ok) return fail(selected);
    // Resolve the trip before optional boosts. A boost never consumes declared
    // trip stock. Each optional bottle replaces one shark.
    const reserved = new Map<number, number>();
    for (let i = 0; i < selected.items.length; i++) {
        const row = selected.items[i]!;
        reserved.set(row.id, row.count);
    }
    const stockTotals = new Map<number, number>();
    for (let i = 0; i < initialStock.length; i++) {
        const row = initialStock[i]!;
        stockTotals.set(row.id, (stockTotals.get(row.id) ?? 0) + row.count);
    }
    const boosts: ItemCount[] = [];
    for (const doses of BOOST_POTIONS) {
        if (boosts.length >= food - 1) break;
        const remaining: ItemCount[] = [];
        for (const [id, count] of stockTotals) {
            remaining.push({ id, count: Math.max(0, count - (reserved.get(id) ?? 0)) });
        }
        const { nativeRequirementMetadata, resolveItemRequirements } = getItemReqs();
        const boost = resolveItemRequirements([{ id: doses[0], kind: 'doses', minUnits: 1, maxSlots: 1 }], remaining, nativeRequirementMetadata);
        if (!boost.ok) continue;
        for (const row of boost.items) { boosts.push(row); reserved.set(row.id, (reserved.get(row.id) ?? 0) + row.count); }
    }
    food -= boosts.length;
    const total = (id: number) => stockTotals.get(id) ?? 0;
    // A bank that holds at least the food floor of the pack's food fills the pack with what it holds: one meal eaten
    // since the pack was taken must not end a trip (live: `required 21, available 20`, `required 16, available 15`).
    const foodOwned = FOOD_LIST.reduce((n, f) => n + total(f.id), 0);
    if (foodOwned < food && foodOwned >= Math.ceil(food * FOOD_START_FLOOR)) food = foodOwned;
    const { nativeRequirementMetadata, resolveItemRequirements } = getItemReqs();
    const target = resolveItemRequirements([...selected.items, ...boosts, ...planFood(total, food)], initialStock, nativeRequirementMetadata);
    if (!target.ok) return fail(target);
    for (const item of [...s.sdk.getInventory()]) await s.bot.depositItem(item, -1);
    for (const want of target.items) {
        let left = want.count - held(s, want.id);
        for (const row of s.sdk.getBankItems().filter(row => row.id === want.id && row.count > 0)) {
            if (left <= 0) break;
            const count = Math.min(left, row.count);
            await s.bot.withdrawItem(row, count, { asNote: false });
            left = want.count - held(s, want.id);
        }
        if (left > 0) { await s.bot.closeBank(); return 'trip withdrawal short for item ' + want.id; }
    }
    await s.bot.closeBank();
    const observed = resolveTrip(s.sdk.getInventory(), trip, equip());
    return observed.ok && foodHeld(s) >= food ? null : 'trip withdrawal short ' + JSON.stringify(observed.shortages);
}

// What the hunt knows about one death. A death in the Wilderness by a player (pvp_death_lose_items in death.rs2) drops the
// pack and the worn items to the killer, except the 3 most valuable items of an unskulled player, and one more with Protect
// Item (a skulled player keeps only that one). The account respawns at Lumbridge with 1 Hitpoints (death.rs2: a death to a
// player leaves 1 Hitpoints) and no skull. The bank is not touched.
export type DeathRecord = {
    diedNear: { x: number; z: number } | null; respawnAt: { x: number; z: number } | null; hpAtRespawn: number | null;
    lifeBefore: number | undefined; lifeAfter: number | undefined; packAtRespawn: number[]; ticks: number;
    // `ok`, or the step that stopped the re-kit: `no respawn`, `walk to the bank` and the walk's outcome, `bank did not open`, `no food in the bank`,
    // `kit lacks <ids>` (pieces of the starting kit that the bank does not hold).
    rekit: string; missing: number[];
};
export const RESPAWN_TICKS = 40;
// Deaths that the hunt re-kits after: the run stops at its PVP_DEATH_LIMITS.perRun-th death (packages/core/src/pvp-deaths.ts).
export const DEFAULT_MAX_DEATHS = PVP_DEATH_LIMITS.perRun - 1;
// The death limit of HUNT_MAX_DEATHS: a whole number of 0 or more, else the default.
export const maxDeathsOf = (value: string | undefined, fallback = DEFAULT_MAX_DEATHS): number => { const n = Number(value); return value !== undefined && value.trim() !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback; };
const WEAR_OPTION = /^(Wield|Wear)$/i;
const isFood = (i: { optionsWithIndex?: { text: string }[] }) => !!i.optionsWithIndex?.some(op => /^eat$/i.test(op.text));
// Eats until the Hitpoints are within a tenth of the maximum (at most 10) of full, or no food is left. Returns the Hitpoints.
export async function eatUp(s: Session, stop: () => boolean): Promise<number> {
    for (let i = 0; i < 12 && !stop(); i++) {
        const p = s.sdk.getState()?.player, meal = s.sdk.getInventory().find(isFood), op = meal?.optionsWithIndex.find(x => /^eat$/i.test(x.text));
        if (!p || !meal || !op || p.hp >= p.maxHp - Math.min(10, Math.floor(p.maxHp / 10))) break;
        await s.sdk.sendUseItem(meal.slot, op.opIndex);
        for (let t = 0; t < 3; t++) if (!await nextTick(s)) break;
    }
    return s.sdk.getState()?.player?.hp ?? 0;
}
// The ids of the pieces of the starting kit that are in the pack, once each, in the order of the kit.
export function kitToWear(wornAtStart: readonly ItemCount[], inventory: readonly { id: number }[]): number[] {
    const inPack = new Set(inventory.map(i => i.id));
    return [...new Set(wornAtStart.map(p => p.id))].filter(id => inPack.has(id));
}
// The shortages of a trip in words, for the log: each item by name with what the trip needs and what the bank holds.
export function shortageText(shortages: readonly { id: number; unit?: string; required: number; available: number }[], nameOf: (id: number) => string | undefined): string {
    return shortages.map(x => `${nameOf(x.id)?.replace(/_/g, ' ') ?? 'item ' + x.id}: ${x.required} ${x.unit ?? 'items'} needed, ${x.available} in the bank`).join('; ');
}
// After a death: wait for the new life, walk to the bank, take sharks and the pieces that the account wore when the hunt began
// (what the bank holds), wear them and eat up from 1 Hitpoints. The caller then restocks the trip. A piece that the bank lacks
// is named in `missing`: the trip check of the restock ends the run when the trip cannot be filled.
export async function rekitAfterDeath(s: Session, o: { lifeBefore: number | undefined; diedNear: { x: number; z: number } | null; wornAtStart: readonly ItemCount[]; stop: () => boolean; log: (l: string) => void; bank?: { x: number; z: number };
    // Only record the death: no walk and no bank (the death limit of the hunt).
    recordOnly?: boolean }): Promise<DeathRecord> {
    const begin = s.tick(), player = () => s.sdk.getState()?.player;
    const record: DeathRecord = { diedNear: o.diedNear, respawnAt: null, hpAtRespawn: null, lifeBefore: o.lifeBefore, lifeAfter: undefined, packAtRespawn: [], ticks: 0, rekit: 'ok', missing: [] };
    const end = (rekit: string): DeathRecord => { record.rekit = rekit; record.ticks = s.tick() - begin; o.log(`HUNT death ${JSON.stringify(record)}`); return record; };
    let alive = false;
    for (let t = 0; t < RESPAWN_TICKS && !o.stop(); t++) {
        const p = player();
        if (p && !p.isDead && p.hp > 0 && (o.lifeBefore === undefined || p.lifeId !== o.lifeBefore)) { alive = true; break; }
        if (!await nextTick(s)) break;
    }
    const p0 = player();
    if (!alive || !p0) return end('no respawn');
    record.respawnAt = { x: p0.worldX, z: p0.worldZ }; record.hpAtRespawn = p0.hp; record.lifeAfter = p0.lifeId;
    record.packAtRespawn = s.sdk.getInventory().map(i => i.id);
    if (o.recordOnly) return end('death limit');
    // Food in the pack first (a kept item can be food): the walk to the bank is long at 1 Hitpoints.
    await eatUp(s, o.stop);
    const back = await walk(s, o.bank ?? EDGEVILLE_BANK, o.stop, 900);
    if (!back.ok) return end('walk to the bank ' + JSON.stringify(back).slice(0, 160));
    if (!(await s.bot.openBank()).success) return end('bank did not open');
    const take = async (id: number, count: number) => {
        let left = count;
        for (const row of s.sdk.getBankItems().filter(r => r.id === id && r.count > 0)) {
            if (left <= 0) break;
            const n = Math.min(left, row.count);
            await s.bot.withdrawItem(row, n, { asNote: false });
            left -= n;
        }
        return count - left;
    };
    const wornNow = () => (typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : s.sdk.getState()?.equipment ?? []);
    const have = (id: number) => wornNow().some(e => e.id === id) || held(s, id) > 0;
    const hp = player()?.hp ?? 1, maxHp = player()?.maxHp ?? 99;
    // Food to eat up with: sharks first, then lobsters (FOOD_LIST), enough pieces to heal the missing Hitpoints and one more.
    let missingHp = maxHp - hp, pieces = 0;
    for (const kind of FOOD_LIST) {
        if (missingHp <= 0 && pieces > 0) break;
        const want = Math.max(1, Math.ceil(missingHp / kind.heal)) + 1, got = await take(kind.id, want);
        pieces += got; missingHp -= got * kind.heal;
    }
    const taken: number[] = [];
    for (const piece of o.wornAtStart) {
        if (have(piece.id)) continue;
        if (await take(piece.id, Math.max(1, piece.count)) > 0) taken.push(piece.id); else record.missing.push(piece.id);
    }
    await s.bot.closeBank();
    // Every piece of the starting kit that the pack holds goes on, the ones taken from the bank and the ones that the death kept
    // (an unskulled account keeps its 3 priciest items, and they respawn in the pack): a trip restock banks the whole pack.
    for (const id of kitToWear(o.wornAtStart, s.sdk.getInventory())) {
        const item = s.sdk.getInventory().find(i => i.id === id), op = item?.optionsWithIndex?.find(x => WEAR_OPTION.test(x.text));
        if (item && op) { await s.sdk.sendUseItem(item.slot, op.opIndex); await nextTick(s); }
    }
    if (!s.sdk.getInventory().some(isFood)) return end('no food in the bank');
    await eatUp(s, o.stop);
    // The pieces of the starting kit that the bank lacks: the account does not go back to the Wilderness without them.
    if (record.missing.length) return end(`kit lacks ${record.missing.join(',')}`);
    return end('ok');
}

// The end of a hunt run: its ok and the detail of its RESULT line. A run that ended in a death starts with `died `, so that the
// supervisor reads `RESULT fail died` as a death (packages/practice/src/supervise.ts, supervise-host.ts classify) and does not log the
// account in again. Its record (the respawn, the kept pack, the step that stopped the re-kit) is the receipt of the end.
export function huntEnd(r: { end: string; kills: number; deaths: number; rekits: number; death?: DeathRecord }): { ok: boolean; detail: string } {
    const died = /^died/.test(r.end), ok = !died && !/failed|lacks|short|invalid|did not open/.test(r.end);
    return { ok, detail: `${died ? 'died ' : ''}hunt ${r.end} kills ${r.kills} deaths ${r.deaths} rekits ${r.rekits}${r.death ? ` death=${JSON.stringify(r.death)}` : ''}` };
}
