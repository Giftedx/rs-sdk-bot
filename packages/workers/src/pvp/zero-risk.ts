// Zero-Risk 3+1 PvP kit enforcement and enemy weapon / high-value loot priority tables.
// Under rev-289 death.rs2 (pvp_death_lose_items):
// - An unskulled player keeps the 3 highest-cost items (or 4 with Protect Item active).
// - Every bait/retaliate kit under NEVER_SKULL=1 must guarantee ZERO weapons and ZERO
//   valuable gear pieces are lost on death.

export const DEFAULT_VALUABLE_GEAR_COST = 5000;

/**
 * Enemy PvP weapons prioritized for immediate looting on every kill tick (dearest / highest impact first).
 * Verified against knowledge/items.json (rev 289).
 */
export const ENEMY_WEAPON_LIST: readonly number[] = [
    3204, // Dragon halberd (250k)
    1377, // Dragon battleaxe (200k)
    1305, // Dragon longsword (100k)
    2415, // Staff of saradomin (80k)
    2416, // Staff of guthix (80k)
    2417, // Staff of zamorak (80k)
    1319, // Rune 2h sword (64k)
    1249, // Dragon spear (62.4k)
    1263, // Dragon spear(p) (62.4k)
    3176, // Dragon spear(kp)
    1434, // Dragon mace (50k)
    1401, // Mystic fire staff (42.5k)
    1403, // Mystic water staff (42.5k)
    1405, // Mystic air staff (42.5k)
    1407, // Mystic earth staff (42.5k)
    1373, // Rune battleaxe (41.6k)
    1347, // Rune warhammer (41.5k)
    1303, // Rune longsword (32k)
    1215, // Dragon dagger (30k)
    1333, // Rune scimitar (25.6k)
    1231, // Dragon dagger(p) (24k)
    1247, // Rune spear
    1261, // Rune spear(p)
    3101, // Rune claws
    1213, // Rune dagger
    1229, // Rune dagger(p)
    859,  // Magic longbow (2.56k)
    861,  // Magic shortbow (1.6k)
    805,  // Rune thrownaxe
    857,  // Yew shortbow
    1387, // Staff of fire
    1381, // Staff of air
    1383, // Staff of water
    1385, // Staff of earth
];

export const ENEMY_WEAPON_IDS: ReadonlySet<number> = new Set(ENEMY_WEAPON_LIST);

/**
 * High-value enemy PvP armour, jewelry, ammo, runes, and supplies in strict priority order.
 * Enemy weapons come FIRST so every weapon is vacuumed before armour or consumables.
 */
export const HIGH_VALUE_ARMOUR_AND_GEAR_LIST: readonly number[] = [
    1187, // Dragon sq shield (500k)
    4087, // Dragon platelegs (270k)
    3140, // Dragon chainbody (250k)
    1149, // Dragon med helm (100k)
    1127, // Rune platebody (65k)
    1079, // Rune platelegs (64k)
    1093, // Rune plateskirt (64k)
    3751, // Berserker helm (60k)
    3753, // Warrior helm (60k)
    3749, // Archer helm (60k)
    3755, // Farseer helm (60k)
    1201, // Rune kiteshield (54.4k)
    1113, // Rune chainbody (50k)
    1185, // Rune sq shield (38.4k)
    1163, // Rune full helm (35.2k)
    1147, // Rune med helm (19.2k)
    1712, // Amulet of glory(4) (17.6k)
    1710, // Amulet of glory(3)
    1708, // Amulet of glory(2)
    1706, // Amulet of glory(1)
    1704, // Amulet of glory (uncharged)
    2503, // Black d'hide body (13.48k)
    2497, // Black d'hide chaps (6.22k)
    2491, // Black d'hide vambraces (4.32k)
    1731, // Amulet of power (3.525k)
    1725, // Amulet of strength (2.025k)
    2550, // Ring of recoil (900)
    2570, // Ring of life
    3105, // Climbing boots
    // Valuable stackable PvP ammo & runes (zero extra slot if already carried)
    893,  // Rune arrow(p)
    892,  // Rune arrow
    565,  // Blood rune
    560,  // Death rune
    561,  // Nature rune
    563,  // Law rune
    // High-value potions & combo food
    2434, // Prayer potion(4)
    139,  // Prayer potion(3)
    3024, // Super restore(4)
    3026, // Super restore(3)
    3144, // Cooked karambwan
];

const WEAPON_NAME_RE = /(?:dragon|rune|adamant|mithril|magic|yew|mystic|saradomin|guthix|zamorak|iban|ancient).*(?:dagger|scimitar|longsword|2h|sword|mace|battleaxe|warhammer|spear|halberd|claw|shortbow|longbow|bow|staff|thrownaxe)|(?:dagger|scimitar|longsword|2h sword|mace|battleaxe|warhammer|spear|halberd|claws|shortbow|longbow|staff|thrownaxe)/i;
const CONSUMABLE_NAME_RE = /^(?:shark|cooked karambwan|tbwt cooked karambwan|swordfish|lobster|bass|tuna|salmon|trout|pike|cheese|.*potion.*|.*restore.*|.*antipoison.*|.*rune|.*arrow.*|.*bolt.*|vial|coins)$/i;

export function isWeaponItem(id: number, name?: string): boolean {
    if (ENEMY_WEAPON_IDS.has(id)) return true;
    if (!name) return false;
    const normalized = name.replace(/_/g, ' ');
    if (CONSUMABLE_NAME_RE.test(normalized)) return false;
    return WEAPON_NAME_RE.test(normalized);
}

export function isConsumableItem(id: number, name?: string): boolean {
    if (id === 385 || id === 3144 || id === 379 || id === 373 || id === 229 || id === 995) return true;
    if (!name) return false;
    return CONSUMABLE_NAME_RE.test(name.replace(/_/g, ' '));
}

export function isValuableGearItem(
    id: number,
    cost: number,
    name?: string,
    threshold = DEFAULT_VALUABLE_GEAR_COST,
): boolean {
    if (isWeaponItem(id, name)) return true;
    if (isConsumableItem(id, name)) return false;
    return cost >= threshold;
}

export interface RiskUnit {
    readonly id: number;
    readonly count: number;
    readonly name?: string;
}

export interface RiskedItem {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly cost: number;
    readonly isWeapon: boolean;
}

export interface ZeroRiskAssessment {
    readonly ok: boolean;
    readonly strict3Ok: boolean;
    readonly kept3: readonly number[];
    readonly kept4: readonly number[];
    readonly riskedWeapons3: readonly RiskedItem[];
    readonly riskedWeapons4: readonly RiskedItem[];
    readonly riskedValuableGear3: readonly RiskedItem[];
    readonly riskedValuableGear4: readonly RiskedItem[];
    readonly lostValue3: number;
    readonly lostValue4: number;
    readonly summary: string;
}

function computeRiskWithKeeps(
    units: readonly RiskUnit[],
    costOf: (id: number) => number,
    nameOf: (id: number) => string | undefined,
    keeps: number,
    valuableThreshold: number,
) {
    const left = new Map<number, { count: number; name: string }>();
    for (const u of units) {
        if (u.count <= 0) continue;
        const cur = left.get(u.id);
        const name = u.name ?? nameOf(u.id) ?? `item ${u.id}`;
        if (cur) cur.count += u.count;
        else left.set(u.id, { count: u.count, name });
    }
    const kept: number[] = [];
    for (let i = 0; i < keeps; i++) {
        let bestId: number | undefined;
        let bestCost = 0;
        for (const id of left.keys()) {
            const c = costOf(id);
            if (c > bestCost) {
                bestCost = c;
                bestId = id;
            }
        }
        if (bestId === undefined) break;
        kept.push(bestId);
        const row = left.get(bestId)!;
        row.count -= 1;
        if (row.count <= 0) left.delete(bestId);
    }
    let lostValue = 0;
    const riskedWeapons: RiskedItem[] = [];
    const riskedValuableGear: RiskedItem[] = [];
    for (const [id, row] of left) {
        const c = costOf(id);
        lostValue += c * row.count;
        const weapon = isWeaponItem(id, row.name);
        if (weapon) {
            riskedWeapons.push({ id, name: row.name, count: row.count, cost: c, isWeapon: true });
        } else if (isValuableGearItem(id, c, row.name, valuableThreshold)) {
            riskedValuableGear.push({ id, name: row.name, count: row.count, cost: c, isWeapon: false });
        }
    }
    riskedWeapons.sort((a, b) => b.cost - a.cost || a.id - b.id);
    riskedValuableGear.sort((a, b) => b.cost - a.cost || a.id - b.id);
    return { kept, lostValue, riskedWeapons, riskedValuableGear };
}

/**
 * Audits an unskulled PvP loadout against rev-289 3-keep (no Protect Item) and 3+1-keep (Protect Item ON)
 * rules, verifying that ZERO weapons and ZERO valuable gear pieces are risked on death.
 */
export function assessZeroRiskKit(
    units: readonly RiskUnit[],
    opts: {
        cost: (id: number) => number;
        nameOf?: (id: number) => string | undefined;
        valuableThreshold?: number;
        /** Default true: check 3+1 keeps (4 items with Protect Item). False: require strict 3 keeps. */
        requireProtectItem?: boolean;
    },
): ZeroRiskAssessment {
    const nameOf = opts.nameOf ?? (() => undefined);
    const threshold = opts.valuableThreshold ?? DEFAULT_VALUABLE_GEAR_COST;
    const r3 = computeRiskWithKeeps(units, opts.cost, nameOf, 3, threshold);
    const r4 = computeRiskWithKeeps(units, opts.cost, nameOf, 4, threshold);
    const strict3Ok = r3.riskedWeapons.length === 0 && r3.riskedValuableGear.length === 0;
    const ok4 = r4.riskedWeapons.length === 0 && r4.riskedValuableGear.length === 0;
    const use4 = opts.requireProtectItem !== false;
    const ok = use4 ? ok4 : strict3Ok;
    const activeWeapons = use4 ? r4.riskedWeapons : r3.riskedWeapons;
    const activeGear = use4 ? r4.riskedValuableGear : r3.riskedValuableGear;
    const summary = ok
        ? `zero-risk ${use4 ? '3+1' : '3'}-keep ok (keeps=${use4 ? r4.kept.length : r3.kept.length}, lostValue=${use4 ? r4.lostValue : r3.lostValue})`
        : `risks ${[
            ...activeWeapons.map(w => `weapon ${w.name} (${w.cost}gp)`),
            ...activeGear.map(g => `gear ${g.name} (${g.cost}gp)`),
        ].join(', ')}`;
    return {
        ok,
        strict3Ok,
        kept3: r3.kept,
        kept4: r4.kept,
        riskedWeapons3: r3.riskedWeapons,
        riskedWeapons4: r4.riskedWeapons,
        riskedValuableGear3: r3.riskedValuableGear,
        riskedValuableGear4: r4.riskedValuableGear,
        lostValue3: r3.lostValue,
        lostValue4: r4.lostValue,
        summary,
    };
}

export interface ZeroRiskSlotCandidate<T> {
    readonly item: T;
    readonly id: number;
    readonly name: string;
    readonly cost: number;
    readonly score: number;
}

/**
 * Downgrades excess high-cost non-weapon armour slots in a candidate loadout so all weapons
 * and valuable gear fit strictly within `keepLimit` (3 or 4) unskulled keeps on death.
 * Prefers keeping the highest-defence body/legs/weapon slots and stepping down secondary
 * slots (hat -> shield -> amulet -> legs -> torso) to owned low-cost alternatives.
 */
export function enforceZeroRiskGear<W extends { id: number; name: string; count: number; slot: number }>(opts: {
    worn: readonly W[];
    carried: readonly RiskUnit[];
    alternativesBySlot: ReadonlyMap<number, readonly ZeroRiskSlotCandidate<W>[]>;
    cost: (id: number) => number;
    nameOf?: (id: number) => string | undefined;
    keepLimit?: 3 | 4;
    valuableThreshold?: number;
}): { worn: W[]; downgraded: { slot: number; from: string; to: string | null }[]; assessment: ZeroRiskAssessment } {
    const keepLimit = opts.keepLimit ?? 4;
    const threshold = opts.valuableThreshold ?? DEFAULT_VALUABLE_GEAR_COST;
    const nameOf = opts.nameOf ?? (() => undefined);
    const worn = opts.worn.map(w => ({ ...w }));
    const downgraded: { slot: number; from: string; to: string | null }[] = [];

    // Order in which non-weapon slots are stepped down to protect weapons & primary tank pieces.
    const downgradeOrder = [0, 5, 2, 9, 1, 10, 12, 7, 4];

    const evalNow = () => assessZeroRiskKit([...worn, ...opts.carried], {
        cost: opts.cost,
        nameOf,
        valuableThreshold: threshold,
        requireProtectItem: keepLimit === 4,
    });

    for (let iter = 0; iter < 16; iter++) {
        const assessment = evalNow();
        if (assessment.ok) return { worn, downgraded, assessment };

        const riskedWeapons = keepLimit === 4 ? assessment.riskedWeapons4 : assessment.riskedWeapons3;
        const minWeaponCost = riskedWeapons.length
            ? Math.min(...riskedWeapons.map(w => w.cost))
            : threshold;
        // Any non-weapon item at or above this ceiling could displace a weapon or count as risked valuable gear.
        const safeCostCeiling = Math.min(threshold - 1, Math.max(0, minWeaponCost - 1));

        let changed = false;
        for (const slot of downgradeOrder) {
            const idx = worn.findIndex(w => w.slot === slot);
            if (idx < 0) continue;
            const current = worn[idx]!;
            if (isWeaponItem(current.id, current.name)) continue;
            const curCost = opts.cost(current.id);
            if (curCost <= safeCostCeiling) continue;

            // Find the strongest owned alternative for this slot strictly under the safe cost ceiling.
            const alts = (opts.alternativesBySlot.get(slot) ?? [])
                .filter(c => c.id !== current.id && c.cost <= safeCostCeiling && !isWeaponItem(c.id, c.name))
                .sort((a, b) => b.score - a.score || a.cost - b.cost);
            const bestAlt = alts[0];
            if (bestAlt) {
                downgraded.push({ slot, from: current.name, to: bestAlt.name });
                worn[idx] = { ...bestAlt.item };
                changed = true;
                break;
            }
            // For optional slots (not torso=4 or legs=7), removing the excess high-cost piece protects the weapons.
            if (slot !== 4 && slot !== 7) {
                downgraded.push({ slot, from: current.name, to: null });
                worn.splice(idx, 1);
                changed = true;
                break;
            }
        }
        if (!changed) break;
    }

    return { worn, downgraded, assessment: evalNow() };
}

export const RING_OF_RECOIL_ID = 2550;
export const DEFAULT_POST_LOOT_TROPHY_FLOOR = 20_000;

/** Verified rev-289 BiS & fallback multi-style switch item IDs (from knowledge/gear.json & items.json). */
export const BIS_SWITCH_GEAR = {
    dhideBody: [2503, 2501, 2499, 1135] as readonly number[],     // Black -> Red -> Blue -> Green d'hide body
    dhideChaps: [2497, 2495, 2493, 1099] as readonly number[],    // Black -> Red -> Blue -> Green d'hide chaps
    dhideVambs: [2491, 2489, 2487, 1065, 1063] as readonly number[], // Black -> Red -> Blue -> Green -> Leather vambs
    godCapes: [2412, 2413, 2414] as readonly number[],            // Saradomin / Guthix / Zamorak cape (+10 magAtk, 100gp)
    godStaves: [2415, 2416, 2417] as readonly number[],           // Saradomin / Guthix / Zamorak staff
    magicStaves: [2415, 2416, 2417, 1401, 1403, 1405, 1407, 1387, 1381, 1383, 1385] as readonly number[],
    magicBodies: [3387, 577, 581, 1035] as readonly number[],     // Splitbark (+9), Wizard robe (+3, 15gp), Black robe (+3, 13gp), Zamorak robe top (+2, 40gp)
    magicLegs: [3389, 1033] as readonly number[],                 // Splitbark legs (+6), Zamorak robe bottom (+2, 30gp)
    magicHats: [3755, 656, 658, 660, 662, 664, 2900, 2910, 2920, 2930, 2940, 3797, 579, 1017] as readonly number[], // Farseer (+6), Gnome/Fremennik/Wizard hats (+2..+3, 160-500gp)
    magicAmulets: [1712, 1710, 1708, 1706, 1727, 1731] as readonly number[], // Glory (+10), Amulet of magic (+10, 900gp), Power (+6)
    meleeGloves: [1495, 775, 776, 777, 778] as readonly number[], // Klank's gauntlets (6gp), Family Crest / Steel gauntlets (1gp): +2 str, +2 att
    meleeBoots: [3105] as readonly number[],                      // Climbing boots (+2 str, 12gp)
    meleeHelms: [3751, 3753, 1149, 1163] as readonly number[],    // Berserker (+3 str), Warrior (+5 slash), D-med, Rune full
    rangedHelms: [3749, 1169] as readonly number[],               // Archer helm (+6 rng), Coif (+2 rng)
    meleeWeapons: [1231, 1215, 1305, 1434, 1333, 1319, 1303] as readonly number[], // DDS(p), DDS, D-long, D-mace, Rune scimitar, Rune 2h, Rune long
    rangedWeapons: [861, 859, 857] as readonly number[],          // Magic shortbow, Magic longbow, Yew shortbow
} as const;

export const MAGIC_FREEZE_SWITCH_IDS: ReadonlySet<number> = new Set([
    ...BIS_SWITCH_GEAR.godCapes,
    ...BIS_SWITCH_GEAR.magicBodies,
    ...BIS_SWITCH_GEAR.magicLegs,
    ...BIS_SWITCH_GEAR.magicHats,
    1727, // Amulet of magic (+10 magicAttack, 900gp)
]);

export const RANGED_ARMOUR_SWITCH_IDS: ReadonlySet<number> = new Set([
    ...BIS_SWITCH_GEAR.dhideBody,
    ...BIS_SWITCH_GEAR.dhideChaps,
    ...BIS_SWITCH_GEAR.dhideVambs,
    ...BIS_SWITCH_GEAR.rangedHelms,
]);

export const MELEE_ARMOUR_SWITCH_IDS: ReadonlySet<number> = new Set([
    3140, 1127, 1113, 1123, // Dragon chain, Rune plate/chain, Addy plate
    4087, 1079, 1093, 1073, // Dragon legs, Rune legs/skirt, Addy legs
    ...BIS_SWITCH_GEAR.meleeGloves,
    ...BIS_SWITCH_GEAR.meleeHelms,
    ...BIS_SWITCH_GEAR.meleeBoots,
]);

export function dhideTierOf(ids: ReadonlySet<number>): 'black' | 'red' | 'blue' | 'green' | 'none' {
    if (ids.has(2503) || ids.has(2497) || ids.has(2491)) return 'black';
    if (ids.has(2501) || ids.has(2495) || ids.has(2489)) return 'red';
    if (ids.has(2499) || ids.has(2493) || ids.has(2487)) return 'blue';
    if (ids.has(1135) || ids.has(1099) || ids.has(1065)) return 'green';
    return 'none';
}

export interface PostLootBankDecision {
    readonly bankNow: boolean;
    readonly reason: string | null;
    readonly displacedOwnGear: readonly number[];
    readonly riskedWeapons: readonly RiskedItem[];
    readonly assessment: ZeroRiskAssessment;
}

/**
 * Post-loot deathRisk immediate-bank guard: after looting enemy weapons or armour, recompute
 * unskulled keep-3 / keep-3+1 protection. Returns `bankNow: true` if looted drops push any of
 * our own core gear out of the top-3 unskulled keeps, leave any enemy weapon or valuable gear
 * at risk on death, or push unprotected lost value above `trophyValueFloor`.
 */
export function postLootBankDue(
    units: readonly RiskUnit[],
    opts: {
        cost: (id: number) => number;
        nameOf?: (id: number) => string | undefined;
        protectItem?: boolean;
        valuableThreshold?: number;
        ownCoreIds?: ReadonlySet<number>;
        trophyValueFloor?: number;
    },
): PostLootBankDecision {
    const protectItem = opts.protectItem !== false;
    const trophyValueFloor = opts.trophyValueFloor ?? DEFAULT_POST_LOOT_TROPHY_FLOOR;
    const assessment = assessZeroRiskKit(units, {
        cost: opts.cost,
        nameOf: opts.nameOf,
        valuableThreshold: opts.valuableThreshold,
        requireProtectItem: protectItem,
    });
    const kept3Set = new Set(assessment.kept3);
    const displacedOwnGear: number[] = [];
    if (opts.ownCoreIds) {
        const carriedIds = new Set(units.filter(u => u.count > 0).map(u => u.id));
        for (const id of opts.ownCoreIds) {
            if (carriedIds.has(id) && !kept3Set.has(id)) displacedOwnGear.push(id);
        }
    }
    const riskedWeapons = protectItem ? assessment.riskedWeapons4 : assessment.riskedWeapons3;
    const riskedGear = protectItem ? assessment.riskedValuableGear4 : assessment.riskedValuableGear3;
    const lostValue = protectItem ? assessment.lostValue4 : assessment.lostValue3;

    if (displacedOwnGear.length > 0) {
        const labels = displacedOwnGear.map(id => opts.nameOf?.(id) ?? `item ${id}`).join(', ');
        return {
            bankNow: true,
            reason: `loot displaced own top-3 gear (${labels})`,
            displacedOwnGear,
            riskedWeapons,
            assessment,
        };
    }
    if (riskedWeapons.length > 0) {
        return {
            bankNow: true,
            reason: `unprotected looted weapons at risk (${riskedWeapons.map(w => w.name).join(', ')})`,
            displacedOwnGear,
            riskedWeapons,
            assessment,
        };
    }
    if (riskedGear.length > 0) {
        return {
            bankNow: true,
            reason: `unprotected valuable gear at risk (${riskedGear.map(g => g.name).join(', ')})`,
            displacedOwnGear,
            riskedWeapons,
            assessment,
        };
    }
    if (lostValue >= trophyValueFloor) {
        return {
            bankNow: true,
            reason: `unprotected loot value ${lostValue}gp >= ${trophyValueFloor}gp floor`,
            displacedOwnGear,
            riskedWeapons,
            assessment,
        };
    }
    return { bankNow: false, reason: null, displacedOwnGear, riskedWeapons, assessment };
}

/** Summarizes enemy weapons collected from a `picked` map (`itemId -> count`). */
export function summarizeWeaponLoot(
    picked: Readonly<Record<string, number>>,
    nameOf?: (id: number) => string | undefined,
): { totalWeapons: number; weapons: Record<string, number> } {
    const weapons: Record<string, number> = {};
    let totalWeapons = 0;
    for (const [rawId, count] of Object.entries(picked)) {
        if (!(count > 0)) continue;
        const id = Number(rawId);
        const name = nameOf?.(id);
        if (!isWeaponItem(id, name)) continue;
        const label = name ? name.replace(/_/g, ' ') : String(id);
        weapons[label] = (weapons[label] ?? 0) + count;
        totalWeapons += count;
    }
    return { totalWeapons, weapons };
}
