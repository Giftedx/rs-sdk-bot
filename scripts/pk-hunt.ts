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
import type { Session } from '../packages/core/src/inprocess';
import { loadOwners } from '../packages/core/src/fleet';
import { isLocalServer } from '../packages/core/src/localserver';
import { PVP_DEATH_LIMITS, pvpDeathRefusal, recordPvpDeath } from '../packages/core/src/pvp-deaths';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { attackable, bestFood, rewearStart, castableFreeze, defaultSpec, fightPlayer, getObjNames as objNames, isMulti, ITEMS, nextTick, observePlayer, packGain, recordKillLoot, SPELLS, wildernessLevel, type FightOptions, type FightResult, type Kit, type Style } from './pk';
import { armourDefence } from './pk-read';
import { assessWildernessThreat, connectRadar, hasVarrockTeleport, itemCost, planWildernessEscape, Radar, slashWebThrough, wildernessCombatMargin, wildernessDepth } from './pk-roam';
import { KitSwapper, protectOf, retreatOf, ThreatWatch } from './pk-threat';
import { nativeRequirementMetadata, resolveItemRequirements, type ItemCount, type ItemRequirement, type RequirementResolution } from '../packages/core/src/item-requirements';
import { lootCapacity } from '../packages/core/src/loot-policy';

// HUNT_PROFILE=<profile of scripts/pk-spar.ts>: that profile's fight options for each fight of the hunt (the kit,
// special weapon, escape and caps stay the hunt's). auto (default): the champion for a hunter of combat 115 or more,
// as the roam (research/pvp-fight-loop.md finding 58); none: the hunt's own options.
const huntProfileCache: Record<string, Partial<FightOptions>> = {};
async function huntProfile(combat: number): Promise<Partial<FightOptions>> {
    const want = process.env.HUNT_PROFILE ?? 'auto';
    const name = want === 'auto' ? (combat >= 115 ? 'champion' : '') : want === 'none' ? '' : want;
    if (!name) return {};
    if (!huntProfileCache[name]) {
        const { PROFILES } = await import('./pk-spar');
        const { specBelow: _below, ...profile } = PROFILES[name] ?? (() => { throw new Error(`unknown HUNT_PROFILE ${name}`); })();
        huntProfileCache[name] = profile;
    }
    return huntProfileCache[name]!;
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
    return new Set([...owners.keys(), 'haggis'].map(n => n.toLowerCase()));
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
    const attacker = attackerIndex === null ? undefined : players.find(p => p.index === attackerIndex);
    if (attacker) return attacker;
    return [...players].filter(p => verdict(me, p, ours, multi) === 'attackable').sort((a, b) => (armour ? armour(a) - armour(b) : 0) || a.distance - b.distance)[0];
}

// A hit we took from another player. The SDK also reports an NPC's damage from someone else as damage_taken, with
// targetType npc and source index -1; those are not attacks on us.
export const hitByPlayer = (e: { type: string; sourceType: string; targetType: string; sourceIndex: number }) =>
    e.type === 'damage_taken' && e.sourceType === 'other_player' && e.targetType === 'player' && e.sourceIndex >= 0;

const held = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
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
    return trip.flatMap((row): ItemRequirement[] => {
        const unit = nativeRequirementMetadata(row.id)?.unit;
        if (row.minDoses !== undefined && row.minCharges !== undefined || (row.minCount !== undefined && unit?.kind !== undefined) || !Number.isSafeInteger(row.count) || row.count < 1) return [{ id: row.id, count: NaN }];
        const kind = row.minDoses !== undefined ? 'doses' : row.minCharges !== undefined ? 'charges' : unit?.kind;
        if (kind) return [{ id: row.id, kind, minUnits: row.minDoses ?? row.minCharges ?? row.count * (unit?.units ?? NaN), maxSlots: row.maxSlots ?? row.count }];
        const wornCount = worn.filter(item => item.id === row.id).reduce((n, item) => n + item.count, 0);
        const wantNeed = Math.max(0, row.count - wornCount);
        if (row.minCount === undefined) return wantNeed > 0 ? [{ id: row.id, count: wantNeed }] : [];
        const minNeed = Math.max(0, Math.min(row.count, row.minCount) - wornCount);
        if (!stock) return minNeed > 0 ? [{ id: row.id, count: minNeed }] : [];
        const have = stock.filter(item => item.id === row.id).reduce((n, item) => n + item.count, 0);
        const count = have >= wantNeed ? wantNeed : have >= minNeed ? have : minNeed;
        return count > 0 ? [{ id: row.id, count }] : [];
    });
}
const resolveTrip = (stock: readonly ItemCount[], trip: readonly TripItem[], worn: readonly ItemCount[] = []) =>
    resolveItemRequirements(tripRequirements(trip, worn, stock), stock, nativeRequirementMetadata);
const invalidTrip = (trip: readonly TripItem[]) => resolveTrip([], trip).shortages.filter(row => ['invalid', 'unknown', 'noted'].includes(row.reason));
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
    const stock = () => [...s.sdk.getBankItems(), ...s.sdk.getInventory()];
    let selected: RequirementResolution | undefined;
    if (choose) { const pick = choose(stock(), equip()); trip = pick.trip; food += pick.moreFood; selected = pick.resolution; }
    const fail = async (r: RequirementResolution) => { await s.bot.closeBank(); return 'bank lacks trip requirements ' + JSON.stringify(r.shortages) + ` (${shortageText(r.shortages, id => objNames().get(id))})`; };
    selected ??= resolveTrip(stock(), trip, equip());
    if (!selected.ok) return fail(selected);
    // Resolve the trip before optional boosts. A boost never consumes declared
    // trip stock. Each optional bottle replaces one shark.
    const reserved = new Map(selected.items.map(row => [row.id, row.count]));
    const boosts: ItemCount[] = [];
    for (const doses of BOOST_POTIONS) {
        if (boosts.length >= food - 1) break;
        const totals = new Map<number, number>();
        for (const row of stock()) totals.set(row.id, (totals.get(row.id) ?? 0) + row.count);
        const remaining = [...totals].map(([id, count]) => ({ id, count: Math.max(0, count - (reserved.get(id) ?? 0)) }));
        const boost = resolveItemRequirements([{ id: doses[0], kind: 'doses', minUnits: 1, maxSlots: 1 }], remaining, nativeRequirementMetadata);
        if (!boost.ok) continue;
        for (const row of boost.items) { boosts.push(row); reserved.set(row.id, (reserved.get(row.id) ?? 0) + row.count); }
    }
    food -= boosts.length;
    const total = (id: number) => stock().filter(r => r.id === id).reduce((n, r) => n + r.count, 0);
    // A bank that holds at least the food floor of the pack's food fills the pack with what it holds: one meal eaten
    // since the pack was taken must not end a trip (live: `required 21, available 20`, `required 16, available 15`).
    const foodOwned = FOOD_LIST.reduce((n, f) => n + total(f.id), 0);
    if (foodOwned < food && foodOwned >= Math.ceil(food * FOOD_START_FLOOR)) food = foodOwned;
    const target = resolveItemRequirements([...selected.items, ...boosts, ...planFood(total, food)], stock(), nativeRequirementMetadata);
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

export type HuntOptions = { cap: number; food: number; minFood: number; escapeAt: number; stop: () => boolean; log?: (l: string) => void;
    kit?: Kit; trip?: readonly TripItem[]; damageSpell?: number; rotation?: Style[]; teleSpell?: number;
    spots?: readonly Spot[]; observe?: boolean;
    // Deaths that the hunt re-kits after (default 1, DEFAULT_MAX_DEATHS). The death after that ends the run with its record.
    // `onDeath` is called for each death, at its tile (the death ledger of packages/core/src/pvp-deaths.ts).
    maxDeaths?: number; onDeath?: (near: { x: number; z: number } | null) => void;
    // The threat radar (scripts/pk-threat.ts, HUNT_THREAT=1): a protect prayer for the style of a threat, the armour swap of the pack, and a retreat
    // when a player outclasses us or a team comes. The hunt's own threat check stays.
    threats?: ThreatWatch };
export async function hunt(s: Session, o: HuntOptions) {
    const log = o.log ?? ((l: string) => console.log(l)), start = s.tick(), ours = fleetNames(), swapper = new KitSwapper();
    const tally = { kills: 0, deaths: 0, rekits: 0, retreatsFailed: 0, escapes: 0, fights: 0, looted: 0, trips: 0 };
    if (o.trip !== undefined) { const invalid = invalidTrip(o.trip); if (invalid.length) return { ...tally, end: 'invalid trip requirements ' + JSON.stringify(invalid) }; }
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const over = () => ended || o.stop() || s.tick() - start >= o.cap;
    // With no kit and no trip named, each restock takes the snare trip where the bank holds it: it won more spars than
    // the staff trip (research/pvp-fight-loop.md, finding 25).
    const auto = !o.kit && !o.trip, sighted = new Map<string, string>();
    let kit = o.kit ?? TRIBRID_KIT;
    // The shield the hunter wears at the start takes the rune kiteshield's place in the melee list: a fixed list put
    // no other shield back on after a two-handed bow turn (a dragon square shield came off for good).
    const startShield = s.sdk.getEquipment().find(e => e.slot === 5)?.id;
    const ownKit = (k: Kit): Kit => (startShield === undefined || startShield === KIT_IDS.runeKiteshield ? k
        : { ...k, melee: (k.melee ?? []).map(id => (id === KIT_IDS.runeKiteshield ? startShield : id)) });
    const shallow = (o.spots ?? HUNT_SPOTS).every(sp => wildernessLevel(sp.z) <= 30);
    let spot = 0, needsRestock = false;
    // A death: the account respawns at Lumbridge with 1 Hitpoints and what it kept. `afterDeath` re-kits it from the bank and
    // the next pass restocks the trip, or it returns the end of the run with the record of the death (rekitAfterDeath).
    const wornAtStart = (typeof s.sdk.getEquipment === 'function' ? s.sdk.getEquipment() : s.sdk.getState()?.equipment ?? []).map(e => ({ id: e.id, count: e.count ?? 1 }));
    let life = s.sdk.getState()?.player?.lifeId, lastTile: { x: number; z: number } | null = null;
    const died = () => { const p = s.sdk.getState()?.player; return !!p && life !== undefined && p.lifeId !== undefined && p.lifeId !== life; };
    const afterDeath = async (near: { x: number; z: number } | null | undefined): Promise<{ end: string; death: DeathRecord } | null> => {
        tally.deaths++;
        try { o.onDeath?.(near ?? lastTile); } catch (error) { log(`HUNT death ledger write failed: ${String(error)}`); }
        const record = await rekitAfterDeath(s, { lifeBefore: life, diedNear: near ?? lastTile, wornAtStart, stop: over, log, recordOnly: tally.deaths > (o.maxDeaths ?? DEFAULT_MAX_DEATHS) });
        life = record.lifeAfter ?? life;
        if (record.rekit !== 'ok') return { end: record.rekit === 'death limit' ? 'died' : 'died: ' + record.rekit, death: record };
        tally.rekits++; needsRestock = true;
        return null;
    };
    // The end of the run when nothing else ends it: a death on the way (a bank walk, a retreat, the last tick) is recovered or ends the run
    // as died, never as a plain failure, a stop or the cap. `openBot` no longer ends a death (continueAfterDeath), so each end checks it.
    const ending = async (end: string): Promise<{ end: string; death?: DeathRecord }> => {
        if (died()) { const d = await afterDeath(lastTile); if (d) return d; }
        return { end };
    };
    const far = () => { const p = s.sdk.getState()?.player; return !p || Math.max(Math.abs(p.worldX - EDGEVILLE_BANK.x), Math.abs(p.worldZ - EDGEVILLE_BANK.z)) > 60; };
    const exitWilderness = async (why: string): Promise<'out' | 'died' | 'failed'> => {
        const position = () => { const p = s.sdk.getState()?.player; return p ? `${p.worldX},${p.worldZ}` : ''; };
        for (let step = 0; step < 30 && !over(); step++) {
            const p = s.sdk.getState()?.player;
            if (!p) break;
            if (p.isDead || p.hp <= 0) return 'died';
            const wild = wildernessDepth(p.worldX, p.worldZ);
            if (wild === 0 && !far()) return 'out';
            const magicLv = s.sdk.getState()?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
            const glory = s.sdk.getInventory().find(i => (ITEMS.glory as readonly number[]).includes(i.id));
            const teleSpell = o.teleSpell ?? (hasVarrockTeleport(magicLv, s.sdk.getInventory(), s.sdk.getEquipment()) ? SPELLS.varrockTeleport : undefined);
            const plan = wild === 0
                ? (glory ? { kind: 'glory' as const } : teleSpell !== undefined ? { kind: 'teleport' as const } : { kind: 'out' as const })
                : planWildernessEscape({ x: p.worldX, z: p.worldZ }, { glory: !!glory, teleport: teleSpell !== undefined });
            if (plan.kind === 'glory' && glory) {
                const op = glory.optionsWithIndex.find(x => /^Rub$/i.test(x.text));
                if (op) await s.sdk.sendUseItem(glory.slot, op.opIndex);
                for (let t = 0; t < 20 && far() && !over(); t++) {
                    await nextTick(s);
                    if (s.sdk.getState()?.dialog?.isOpen) await s.sdk.clickDialogByText(/^Edgeville/i);
                }
                if (!far()) return 'out';
                return 'failed';
            }
            if (plan.kind === 'teleport' && teleSpell !== undefined) {
                const from = position();
                await s.sdk.sendClickComponent(teleSpell);
                for (let t = 0; t < 12 && position() === from && !over(); t++) await nextTick(s);
                if (position() !== from) {
                    const walked = await walk(s, EDGEVILLE_BANK, over, 600);
                    return walked.ok ? 'out' : 'failed';
                }
                return 'failed';
            }
            if ((plan.kind === 'lever' || plan.kind === 'ladder') && plan.loc) {
                const findLoc = (loc: { id: number; x: number; z: number }) => s.sdk.getState()?.nearbyLocs.find(l => l.id === loc.id && Math.max(Math.abs(l.x - loc.x), Math.abs(l.z - loc.z)) <= 2)
                    ?? s.sdk.getState()?.nearbyLocs.find(l => l.id === loc.id);
                log(`HUNT ${why} via ${plan.detail}`);
                if (plan.web) await slashWebThrough(s, plan.web, over);
                await walk(s, { x: plan.loc.x, z: plan.loc.z }, over, 120);
                const exitLoc = findLoc(plan.loc);
                if (exitLoc && typeof s.bot?.interactLoc === 'function') {
                    await s.bot.interactLoc(exitLoc, plan.loc.option).catch(() => {});
                    await nextTick(s);
                    continue;
                }
            }
            if (wild > 0) {
                log(`HUNT ${why} walking south from level ${wild}`);
                await walk(s, { x: p.worldX, z: Math.max(3518, p.worldZ - 24) }, over, 80);
                continue;
            }
            return 'failed';
        }
        return far() ? 'failed' : 'out';
    };
    if (far()) {
        const res = await exitWilderness('retreat to Edgeville');
        if (res === 'died') { const d = await afterDeath(null); if (d) return { ...tally, ...d }; }
        else if (res === 'failed') {
            const p = s.sdk.getState()?.player;
            const magicLv = s.sdk.getState()?.skills?.find(k => k.name === 'Magic')?.level ?? 1;
            const hasTele = o.teleSpell !== undefined || hasVarrockTeleport(magicLv, s.sdk.getInventory(), s.sdk.getEquipment());
            if (p && wildernessDepth(p.worldX, p.worldZ) === 0 && !hasTele && !s.sdk.getInventory().some(i => (ITEMS.glory as readonly number[]).includes(i.id))) {
                return { ...tally, ...await ending('far from Edgeville with no glory or PK_TELE') };
            }
            return { ...tally, ...await ending(hasTele ? 'travel teleport did not move the account' : 'glory to Edgeville failed') };
        }
    }
    while (!over()) {
        if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
        if (needsRestock || foodHeld(s) < o.minFood) {
            const back = await walk(s, EDGEVILLE_BANK, over, 600);
            // A death on the walk to the bank is recovered (the next pass restocks) or ends the run as died, whether or not the walk failed.
            if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; continue; }
            if (!back.ok) return { ...tally, end: 'bank walk failed ' + JSON.stringify(back) };
            const missing = await restock(s, o.food, o.trip, kit, auto ? (bank, worn) => { const pick = pickTrip(bank, shallow, worn); kit = pick.kit; log(`HUNT trip ${pick.name}`); return pick; } : undefined);
            if (missing) return { ...tally, ...await ending(missing) };
            needsRestock = false;
            tally.trips++;
        }
        const spots = o.spots ?? HUNT_SPOTS, here = spots[spot % spots.length]!;
        const out = await walk(s, here, over);
        spot++;
        if (!out.ok && !over()) { log(`HUNT walk to spot failed ${JSON.stringify(out)}`); continue; }
        // Wait at the spot for a target or an attacker.
        let attackerIndex: number | null = null, seen = 0, foodReady = 0;
        const waitUntil = s.tick() + (here.dwell ?? 60);
        while (!over() && s.tick() < waitUntil) {
            await nextTick(s);
            const state = s.sdk.getState(), me = state?.player;
            if (!state || !me) continue;
            if (died()) { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; break; }
            lastTile = { x: me.worldX, z: me.worldZ };
            let maxSeen = seen;
            for (const e of state.combatEvents) {
                const id = e.observationId ?? e.tick;
                if (id <= seen) continue;
                if (id > maxSeen) maxSeen = id;
                if (hitByPlayer(e)) attackerIndex = e.sourceIndex;
            }
            seen = maxSeen;
            // Heal between fights: eat while 20 or more under full, and start a fight only near full unless attacked.
            const meal = bestFood(state.inventory);
            if (me.hp <= me.maxHp - 20 && meal && s.tick() >= foodReady) {
                const op = meal.optionsWithIndex.find(x => /^Eat$/i.test(x.text));
                if (op) { void s.sdk.sendUseItem(meal.slot, op.opIndex); foodReady = s.tick() + 3; }
            }
            const self = { z: me.worldZ, combatLevel: me.combatLevel }, multi = isMulti(me.worldX, me.worldZ);
            for (const p of state.nearbyPlayers) {
                const v = verdict(self, p, ours, multi);
                if (sighted.get(p.name) === v) continue;
                sighted.set(p.name, v);
                log(`HUNT seen ${p.name} combat ${p.combatLevel} at ${p.x},${p.z} wild ${wildernessLevel(p.z)} ${v}${p.inCombat ? ` fighting ${p.combatTargetType}` : ''}`);
            }
            // HUNT_MIN_FOOD=<n>: no new fight of our own choosing with fewer than n pieces of food (an attacker is still
            // fought): a hunter that has spent its food on one kill does not take on the next target.
            const foodLeft = state.inventory.filter(i => i.optionsWithIndex?.some(op => /^eat$/i.test(op.text))).reduce((n, i) => n + i.count, 0);
            const magicLevel = state.skills.find(k => k.name === 'Magic')?.level ?? 1;
            const hasGlory = state.inventory.some(i => (ITEMS.glory as readonly number[]).includes(i.id)) || s.sdk.getEquipment().some(i => (ITEMS.glory as readonly number[]).includes(i.id));
            const hasTele = o.teleSpell !== undefined || hasVarrockTeleport(magicLevel, state.inventory, s.sdk.getEquipment());
            const threat = attackerIndex === null ? assessWildernessThreat(
                { x: me.worldX, z: me.worldZ, combat: me.combatLevel, foodCount: foodLeft, glory: hasGlory, teleport: hasTele },
                state.nearbyPlayers.map(p => ({ ...p, wornWeapon: observePlayer(s.client, p.index)?.worn[3] })),
                ours,
            ) : null;
            // The threat radar: the armour swap first (it uses the tick), then a retreat that it decides when the hunt's own check has none.
            const radar = o.threats?.act ? o.threats.step(s.tick()) : null;
            if (radar && await swapper.step(s, radar.actions, s.tick(), () => nextTick(s), log)) continue;
            const radarReason = attackerIndex === null && radar ? retreatOf(radar.actions) : null;
            const retreatReason = threat?.retreatReason ?? radarReason;
            if (retreatReason) {
                if (!threat?.retreatReason && radarReason) o.threats!.acted(s.tick());
                const margin = wildernessCombatMargin({ z: me.worldZ, combat: me.combatLevel }, me.combatLevel);
                const escapePlan = threat?.escapePlan ?? planWildernessEscape({ x: me.worldX, z: me.worldZ }, { glory: hasGlory, teleport: hasTele });
                log(`HUNT threat retreat (${retreatReason}, bracket=${margin.minCombat}-${margin.maxCombat}): ${escapePlan.detail}`);
                needsRestock = true;
                if (wildernessLevel(me.worldZ) > 30 || threat?.multiPile) {
                    // The result of the retreat: a death is handled, and a retreat that did not leave the Wilderness is counted
                    // and logged. The restock walk that follows goes on south either way.
                    const out = await exitWilderness(retreatReason);
                    if (out === 'died') { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
                    else if (out === 'failed' && !died()) { tally.retreatsFailed++; log(`HUNT threat retreat did not leave the Wilderness (${retreatReason})`); }
                }
                break;
            }
            if (attackerIndex === null && (o.observe || me.hp < me.maxHp - 20 || foodLeft < Number(process.env.HUNT_MIN_FOOD ?? 0))) continue;
            const target = pickTarget(self, state.nearbyPlayers, ours, attackerIndex, process.env.HUNT_PICK !== 'near'
                ? p => { const o = observePlayer(s.client, p.index); return o ? armourDefence(o.worn.map(id => objNames().get(id) ?? '')).melee : 0; } : undefined, multi);
            if (!target) continue;
            log(`HUNT engage ${target.name} (combat ${target.combatLevel}) at ${target.x},${target.z}`);
            tally.fights++;
            const r: FightResult = await fightPlayer(s, target.name, {
                ...(o.threats?.act ? { threatPrayer: () => protectOf(o.threats!.step(s.tick()).actions, s.name) } : {}),
                // The freeze goes out when the target runs: cast whenever the target was free, it lost a stand-up spar (2 wins,
                // 4 losses), and a hunter with it killed no more runners (research/pvp-fight-loop.md).
                // The overhead changes one tick before the target's next attack: 42 kills to 6 in mirror spars against 24 to 24.
                kit: ownKit(kit), spec: defaultSpec(ownKit(kit)), freeze: castableFreeze(magicLevel, state.inventory) !== null ? 'flee' : false, exitOnDanger: true, predictPrayer: true, snapPrayer: true, counterRead: true, adaptStyles: true,
                escapeAt: o.escapeAt, escapeSpell: o.teleSpell, cap: 900, damageSpell: o.damageSpell, escapeOutnumbered: 2, allies: [...ours], stop: over, log,
                // A stand-up fight with bow and dagger only: a spell takes 5 ticks, the bow 3 and the dagger 4. Magic stays
                // for the freeze. Random styles: an overhead that predicts cannot follow them.
                rotation: o.rotation ?? (kit.ranged?.length && kit.melee?.length ? ['ranged', 'melee'] : undefined), mixStyles: true,
                ...(await huntProfile(me.combatLevel)),
                // HUNT_RACE_WINDOW: the ticks of the danger check's damage race (default the fight loop's 30).
                ...(process.env.HUNT_RACE_WINDOW ? { raceWindow: Number(process.env.HUNT_RACE_WINDOW) } : {}),
                // HUNT_EXIT=0: no danger exit; the fight goes on to its own escape rules (escapeAt and the crowd escape).
                ...(process.env.HUNT_EXIT === '0' ? { exitOnDanger: false } : {}),
                // HUNT_RACE=0: the danger exit keeps its food, crowd and prayer rules and leaves the damage race out.
                ...(process.env.HUNT_RACE === '0' ? { raceExit: false } : {}),
                // HUNT_PRESS=<fraction>: the no-food exit waits while the target's health bar is at that or lower.
                ...(process.env.HUNT_PRESS ? { pressLow: Number(process.env.HUNT_PRESS) } : {}),
                // HUNT_NOFOOD=<multiple>: the no-food exit at that many times the opponent's max hit (default 1.5).
                ...(process.env.HUNT_NOFOOD ? { noFoodAt: Number(process.env.HUNT_NOFOOD) } : {}),
            });
            log(`HUNT fight ${r.outcome} ${JSON.stringify(r)}`);
            // The armour that a freeze stripped goes back on (pk.ts rewearStart): not after a death or a dropped session.
            if (r.outcome !== 'died' && r.outcome !== 'session ended') await rewearStart(s, wornAtStart.map(w => w.id), log);
            if (r.outcome === 'kill') {
                tally.kills++; const pack = s.sdk.getInventory().map(i => ({ id: i.id, count: i.count }));
                const n = await loot(s, r.targetAt ?? target, over); tally.looted += n;
                recordKillLoot(r, packGain(pack, s.sdk.getInventory()));
                log(`HUNT looted ${n} piles at ${JSON.stringify(r.targetAt ?? target)}`);
            }
            // A danger exit (no food, two attackers) leaves the fight but not the place: the escape (glory, teleport or a
            // run, the fight loop's own) goes at once, or each hit starts a new fight that stops at the danger check
            // again and the hunter stands until it dies (extra:hunt-pick).
            // So does a fight that the hunt's tick cap or stop ended (timeout): the hunt ends, and an account left
            // standing beside its attacker dies there. This escape has its own 200-tick cap and stops only out of the
            // Wilderness.
            const curP = s.sdk.getState()?.player;
            if (r.outcome === 'danger' || (r.outcome === 'timeout' && curP && wildernessDepth(curP.worldX, curP.worldZ) > 0)) {
                const e = await fightPlayer(s, target.name, { kit: ownKit(kit), exitOnDanger: false, escapeSpell: o.teleSpell, cap: 200, log,
                    predictPrayer: true, snapPrayer: true, flee: true });
                log(`HUNT escape after danger: ${e.outcome}`);
                if (e.outcome === 'escaped') { tally.escapes++; needsRestock = true; }
                else if (e.outcome === 'died') { const d = await afterDeath(r.targetAt ?? lastTile); if (d) return { ...tally, ...d }; }
                else {
                    const postP = s.sdk.getState()?.player;
                    if (postP && wildernessDepth(postP.worldX, postP.worldZ) > 0) {
                        const outRes = await exitWilderness('post-fight retreat');
                        if (outRes === 'died') { const d = await afterDeath(lastTile); if (d) return { ...tally, ...d }; }
                        if (outRes === 'out') { tally.escapes++; needsRestock = true; }
                    }
                }
            }
            if (r.outcome === 'died') { const d = await afterDeath(r.targetAt ?? lastTile); if (d) return { ...tally, ...d }; break; }
            if (r.outcome === 'session ended') return { ...tally, end: 'session ended' };
            if (r.outcome === 'escaped') { tally.escapes++; needsRestock = true; }
            break;
        }
    }
    return { ...tally, ...await ending(ended ? 'session ended' : o.stop() ? 'stopped' : 'cap') };
}

// Pick up what the loser dropped near where it stood, most valuable stacks first, bones aside; eat food to free a slot for valuable drops.
export async function loot(s: Session, at: { x: number; z: number }, stop: () => boolean): Promise<number> {
    let taken = 0;
    // The drop lands after the death animation: wait up to 10 ticks for the first pile.
    const near = (g: { x: number; z: number; name: string }) => Math.max(Math.abs(g.x - at.x), Math.abs(g.z - at.z)) <= 3 && !/bones$/i.test(g.name);
    for (let wait = 0; wait < 10 && !stop() && !(s.sdk.getState()?.groundItems ?? []).some(near); wait++) await nextTick(s);
    for (let tries = 0; tries < 28 && !stop(); tries++) {
        const pile = (s.sdk.getState()?.groundItems ?? []).filter(near)
            .sort((a, b) => (itemCost(b.id) * b.count - itemCost(a.id) * a.count) || (a.distance - b.distance))[0];
        if (!pile) break;
        const native = (s.client as { objType?: (id: number) => { stackable: boolean } | undefined } | undefined)?.objType?.(pile.id);
        if (!lootCapacity({ inventory: s.sdk.getInventory() }, pile, native)) {
            if (typeof native?.stackable !== 'boolean') break;
            const meal = bestFood(s.sdk.getInventory());
            if (!meal || itemCost(pile.id) * pile.count < 1000) break;
            const afterMeal = s.sdk.getInventory().map(item => item.slot === meal.slot ? { ...item, count: item.count - 1 } : item).filter(item => item.count > 0);
            if (!lootCapacity({ inventory: afterMeal }, pile, native)) break;
            const before = held(s, meal.id);
            await s.bot.eatFood(meal);
            if (held(s, meal.id) !== before - 1 || !lootCapacity({ inventory: s.sdk.getInventory() }, pile, native)) break;
        }
        const before = held(s, pile.id), r = await s.bot.pickupItem(pile);
        if (!r.success || held(s, pile.id) !== before + pile.count) break;
        taken++;
    }
    return taken;
}

if (import.meta.main) {
    const [bot, capArg] = process.argv.slice(2);
    if (!bot) { console.log('usage: bun scripts/pk-hunt.ts <bot> [CAP ticks]'); process.exit(2); }
    const { openBot, finish } = await import('../packages/core/src/bot');
    // The death ledger: an account that died too often in the last 24 h on a live server does not start (RESULT fail died).
    // The server comes from bot.env, which openBot restores from the vault later: the ledger restores it first. An unreadable bot.env is a fail line.
    const { accountServerBeforeLogin } = await import('./pk-roam');
    let server = '';
    try { server = accountServerBeforeLogin(bot); } catch (e) { console.log(`RESULT fail no server for ${bot}: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`); process.exit(2); }
    const ledgerRefusal = pvpDeathRefusal({ accounts: [bot], server });
    if (ledgerRefusal) { console.log(`RESULT fail died ${ledgerRefusal}`); process.exit(1); }
    const stop = () => existsSync(`.practice/stop-${bot}`) || existsSync('.practice/stop-pk-hunt');
    // A death ends a bot session by default (packages/core/src/bot.ts: the DEATH line, then finish). The hunt handles its own death
    // (rekitAfterDeath): continueAfterDeath prints the DEATH line and goes on, and the stop file, the lease and the stall checks stay live.
    const s = await openBot(bot, { continueAfterDeath: true });
    const env = process.env;
    // HUNT_THREAT=1: the threat radar (HUNT_THREAT_ACT=0 only logs and records). The world feed is the radar's out-of-view source: none on a local server.
    const threatRadar = env.HUNT_THREAT === '1' ? new Radar() : undefined;
    const closeRadar = threatRadar && !isLocalServer(server) ? connectRadar(server, threatRadar) : undefined;
    const threats = threatRadar ? new ThreatWatch({ sessions: () => [s], server, friends: fleetNames(), radar: threatRadar, log: l => console.log(l), act: env.HUNT_THREAT_ACT !== '0' }) : undefined;
    const r = await hunt(s, { threats, cap: Number(capArg ?? 6000), food: Number(env.HUNT_FOOD ?? 18), minFood: Number(env.MIN_FOOD ?? 6), escapeAt: Number(env.ESCAPE_AT ?? 35), stop,
        kit: env.PK_KIT === 'snare' ? SNARE_KIT : env.PK_KIT ? JSON.parse(env.PK_KIT) as Kit : undefined, trip: env.PK_TRIP ? JSON.parse(env.PK_TRIP) : env.PK_KIT === 'snare' ? SNARE_TRIP : undefined, damageSpell: env.PK_SPELL ? Number(env.PK_SPELL) : undefined,
        rotation: env.PK_ROTATION ? env.PK_ROTATION.split(',') as Style[] : undefined, teleSpell: env.PK_TELE ? Number(env.PK_TELE) : undefined,
        spots: resolveHuntSpots(env), observe: env.PK_OBSERVE === '1', maxDeaths: maxDeathsOf(env.HUNT_MAX_DEATHS),
        onDeath: near => { recordPvpDeath({ account: bot, server, at: Date.now(), script: 'scripts/pk-hunt.ts', near }); } });
    closeRadar?.();
    console.log('HUNT ' + JSON.stringify(r));
    // A dropped session reports the swarm's drain wording (planner DRAIN_RESULT), not a hunt outcome.
    if (r.end === 'session ended') await finish([s], false, 'session ended: disconnected');
    // A run that ended in a death is not ok. Its record (the respawn, the pack that it kept, the re-kit step that stopped it)
    // is the receipt of the end. A death that the hunt re-kitted after is in `deaths` and `rekits`.
    const end = huntEnd(r);
    await finish([s], end.ok, end.detail);
}
