// Progressive combat loadout selection, slot upgrade/goal planning, and melee/kit convenience selectors.
import type { Bonus, Gear, Skill } from '../../../knowledge/src/gear';
import { sumBonuses } from '../../../knowledge/src/gear-query';
import { gearSources, sourceCost, valueOf, type GearSource, type MarketAsks } from '../gear-sources';
import { ownedBestLoadout, type GearCount, type GearSlot, type OptionalGearSlot, type OwnedLoadout } from '../owned-loadout';
import { canWearGear, gearById, gearCatalog, gearIdByName, shopAccessible, shopCatalog, weaponSupportsTrainSkill } from './catalog';
import {
    GEAR_KEY_BY_SLOT,
    GOD_ALIGN_BY_ID,
    LOADOUT_SLOTS,
    RANGED_RUN_AMMO,
    WEARPOS_BY_SLOT,
    normalizeCompletedQuests,
    normalizeSkills,
    stockTotals,
    type CombatFocus,
    type GearSkillLevels,
    type LoadoutSlotName,
    type QuestInput,
    type RangedLoadoutSlotName,
    type ShopSource,
} from './model';
import {
    isRangedWeapon,
    isStandardArrow,
    isStandardRangedBow,
    isThrownWeapon,
    meleeDefenceMean,
    missingRequirements,
    rapidRate,
    scoreGearForStyle,
    tieOrder,
    unlockRank,
} from './scoring';

function unreservedCounts(stock: readonly GearCount[], reserved: readonly GearCount[] = []): Map<number, number> {
    const avail = stockTotals(stock);
    for (const r of reserved) avail.set(r.id, Math.max(0, (avail.get(r.id) ?? 0) - r.count));
    return avail;
}

function arrowCompatibility(bow: Gear | null, arrow: Gear): boolean {
    if (!bow) return isStandardArrow(arrow);
    if (bow.debugname === 'ogre_bow') return arrow.debugname === 'ogre_arrow';
    if (bow.debugname.includes('crossbow')) return /\bbolt/i.test(arrow.name);
    if (isStandardRangedBow(bow)) {
        return isStandardArrow(arrow) && (arrow.tier ?? 1) <= (bow.tier ?? 1);
    }
    return false;
}

export interface SlotUpgrade {
    slot: RangedLoadoutSlotName;
    wearpos: number;
    current: Gear | null;
    bestWearable: Gear | null;
    /** The best item the account can obtain now, with all its usable sources and the first (the cheapest) of them. */
    acquirableUpgrade: { item: Gear; shops: ShopSource[]; tradeable: boolean; sources: GearSource[]; source: GearSource } | null;
    /** The best wearable item whatever its source: the long-term target. `sources` is empty when nothing supplies it now. */
    goal: { item: Gear; sources: GearSource[] } | null;
    nextUnlock: {
        item: Gear;
        missingSkills: Partial<Record<Skill, number>>;
        missingQuests: string[];
        shops: ShopSource[];
        tradeable: boolean;
    } | null;
}

export interface ProgressiveLoadout {
    style: CombatFocus;
    worn: Record<LoadoutSlotName, Gear | null>;
    ammo: Gear | null;
    /** True when the weapon is a thrown stack: the weapon slot holds the ammunition. */
    thrown: boolean;
    /** Unreserved owned count of the ammunition: the quiver item, or the thrown weapon. 0 with none. */
    ammoCount: number;
    items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[];
    gearSlots: GearSlot[];
    ownedLoadout: OwnedLoadout;
    upgrades: Partial<Record<RangedLoadoutSlotName, SlotUpgrade>>;
    bonuses: Record<Bonus, number>;
}

export interface ProgressiveLoadoutOptions {
    reserved?: readonly GearCount[];
    trainSkill?: string;
    requireWeapon?: boolean;
    requireShield?: boolean;
    minWeaponStrength?: number;
    minShieldDefence?: number;
    /** Ammunition count that carries a run (default RANGED_RUN_AMMO). A smaller stack is used only with no such stack. */
    arrowMinCount?: number;
    /** False keeps thrown weapons out of the Ranged weapon choice (a worker that counts its shots by arrows). */
    thrown?: boolean;
    /** The account's quest points, for shops behind a quest-point gate. Unknown counts as 0. */
    questPoints?: number;
    /** Market asks (marketQuotes of .practice/market-all.json): the Grand Exchange is a source only for an item with one. */
    market?: MarketAsks;
    /** The account's tile: the nearest shop or NPC among the sources of an item. */
    position?: { x: number; z: number } | null;
    godAlign?: 'saradomin' | 'guthix' | 'zamorak';
    /** When specified, overrides bow/arrow scoring with current Ranged bow+arrow pairing. */
    preferFastShortbow?: boolean;
}

export function selectProgressiveLoadout(
    style: CombatFocus,
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options: ProgressiveLoadoutOptions = {},
): ProgressiveLoadout {
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(quests);
    const avail = unreservedCounts(stock, options.reserved);
    const shops = shopCatalog();
    const arrowMin = Math.max(1, options.arrowMinCount ?? RANGED_RUN_AMMO);
    const have = (g: Gear) => avail.get(g.id) ?? 0;

    // The ammunition a weapon fires from the owned stock: the strongest kind with a run's worth (arrowMin), and with
    // no such kind the largest stack. Three rune arrows never displace 300 mithril arrows.
    const ownedAmmo = style === 'ranged'
        ? gearCatalog().filter(g => g.slot === 'quiver' && have(g) > 0)
        : [];
    const ammoFor = (weapon: Gear): Gear | null => {
        const fits = ownedAmmo.filter(a => {
            if (isStandardRangedBow(weapon)) return (a.tier ?? 1) <= (skillMap.ranged ?? 1) && arrowCompatibility(weapon, a);
            return arrowCompatibility(weapon, a);
        });
        const byStrength = (a: Gear, b: Gear) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id;
        return fits.filter(a => have(a) >= arrowMin).sort(byStrength)[0]
            ?? [...fits].sort((a, b) => have(b) - have(a) || byStrength(a, b))[0]
            ?? null;
    };
    // Owned ammunition count behind a Ranged weapon: the thrown stack itself, or the stack ammoFor picks.
    const ammoCountFor = (weapon: Gear): number => {
        if (isThrownWeapon(weapon)) return have(weapon);
        const ammo = ammoFor(weapon);
        return ammo ? have(ammo) : 0;
    };

    const maxArrowStrengthForTier = (tier: number): number => {
        if (tier >= 40) return 49; // Rune arrow
        if (tier >= 30) return 31; // Adamant arrow
        if (tier >= 20) return 22; // Mithril arrow
        if (tier >= 5) return 16;  // Steel arrow
        return 10;                 // Iron arrow
    };

    // Owned Ranged weapons are compared by the damage they do on rapid with the ammunition the account holds:
    // (64 + ranged strength) * (64 + ranged attack) / rapid rate. A weapon with a run's worth of ammunition outranks
    // one with a smaller stack, and that one outranks a weapon with none. A knife fires every 2 ticks on rapid and a
    // shortbow every 3, so a full knife stack can beat a bow with weak arrows; five knives never do.
    const AMMO_READY = 2_000_000, AMMO_SOME = 1_000_000;
    const ownedRangedScore = (g: Gear): number => {
        if (!isRangedWeapon(g)) return -1e9;
        const ammo = isThrownWeapon(g) ? null : ammoFor(g);
        const count = ammoCountFor(g);
        // With no owned ammunition a bow is ranked as if it fired its tier's arrows, so the best bow is still named.
        const strength = isThrownWeapon(g) ? g.bonuses.rangeStrength
            : ammo ? g.bonuses.rangeStrength + ammo.bonuses.rangeStrength
            : isStandardRangedBow(g) ? maxArrowStrengthForTier(g.tier ?? 1) : g.bonuses.rangeStrength;
        const damage = ((64 + strength) * (64 + g.bonuses.rangeAttack)) / rapidRate(g);
        return damage + (count >= arrowMin ? AMMO_READY : count > 0 ? AMMO_SOME : 0);
    };
    const scoreOf = (g: Gear, useCatalogArrow: boolean) => {
        if (style === 'ranged' && g.slot === 'righthand') {
            if (!useCatalogArrow) return ownedRangedScore(g);
            if (isStandardRangedBow(g)) {
                // The catalog choice (what to acquire) keeps a bow ahead of a thrown weapon: shops sell arrows.
                return scoreGearForStyle(g, style, maxArrowStrengthForTier(Math.min(g.tier ?? 1, skillMap.ranged ?? 1))) + 500;
            }
            return scoreGearForStyle(g, style, 0);
        }
        return scoreGearForStyle(g, style);
    };

    const slotCandidates = (slot: RangedLoadoutSlotName, currentWeapon: Gear | null, useCatalogArrow = true): Gear[] => {
        const wearSlot = GEAR_KEY_BY_SLOT[slot];
        const all = gearCatalog().filter(g => {
            if (g.slot !== wearSlot) return false;
            if (!canWearGear(g, skillMap, done)) return false;
            if (slot === 'weapon') {
                if (!weaponSupportsTrainSkill(g, options.trainSkill)) return false;
                if (options.minWeaponStrength !== undefined && g.bonuses.strength < options.minWeaponStrength) return false;
                if (options.requireShield && g.covers.includes('lefthand')) return false;
                if (style === 'ranged' && options.thrown === false && isThrownWeapon(g)) return false;
            }
            if (slot === 'shield' && options.minShieldDefence !== undefined) {
                if (meleeDefenceMean(g.bonuses) < options.minShieldDefence) return false;
            }
            if (slot === 'cape' && style === 'magic' && currentWeapon) {
                const wGod = GOD_ALIGN_BY_ID[currentWeapon.id];
                const cGod = GOD_ALIGN_BY_ID[g.id];
                if (wGod && cGod && wGod !== cGod) return false;
            }
            if (slot === 'cape' && options.godAlign) {
                const cGod = GOD_ALIGN_BY_ID[g.id];
                if (cGod && cGod !== options.godAlign) return false;
            }
            return true;
        });

        return all
            .filter(g => {
                const sc = scoreOf(g, useCatalogArrow);
                if (sc <= -1e8) return false;
                if (slot !== 'weapon' && sc <= 0) return false;
                return true;
            })
            .sort((a, b) => scoreOf(b, useCatalogArrow) - scoreOf(a, useCatalogArrow) || tieOrder(a, b, style));
    };

    const ownedShields = slotCandidates('shield', null, false).filter(g => (avail.get(g.id) ?? 0) > 0);
    const bestShieldScore = ownedShields.length ? scoreOf(ownedShields[0]!, false) : 0;

    // Compute preference relative to each slot's best owned option so missing an unowned BiS
    // never makes ownedBestLoadout prefer skipping an optional slot over wearing a lower owned tier.
    const toOptions = (list: Gear[], _slot: LoadoutSlotName) => {
        const owned = list.filter(g => (avail.get(g.id) ?? 0) > 0);
        if (!owned.length) return [];
        const topOwnedScore = Math.max(0, scoreOf(owned[0]!, false));
        return owned.map(g => ({
            id: g.id,
            count: 1,
            preference: Math.max(0, Math.round((topOwnedScore - scoreOf(g, false)) * 10)),
            equippable: true as const,
            ...(g.covers.includes('lefthand') ? { occupies: ['shield'] } : {}),
        }));
    };

    const solveSlots: OptionalGearSlot[] = [];
    for (const slot of LOADOUT_SLOTS) {
        const list = slotCandidates(slot, null, false);
        const opts = toOptions(list, slot);
        const required = (slot === 'weapon' && options.requireWeapon) || (slot === 'shield' && options.requireShield);
        if (!opts.length && !required) continue;
        solveSlots.push({
            key: slot,
            optional: !required,
            missPreference: slot === 'shield' ? Math.max(1, Math.round(bestShieldScore * 10)) : 1000000,
            options: opts,
        });
    }

    const solved = ownedBestLoadout(solveSlots, stock, options.reserved);
    const worn = Object.fromEntries(LOADOUT_SLOTS.map(s => [s, null])) as Record<LoadoutSlotName, Gear | null>;
    for (const choice of solved.selected) {
        const g = gearById(choice.id) ?? null;
        worn[choice.slot as LoadoutSlotName] = g;
    }

    // Re-check cape against chosen weapon for god-cape / god-staff conflict.
    if (style === 'magic' && worn.weapon && worn.cape) {
        const wGod = GOD_ALIGN_BY_ID[worn.weapon.id];
        const cGod = GOD_ALIGN_BY_ID[worn.cape.id];
        if (wGod && cGod && wGod !== cGod) {
            const safeCape = slotCandidates('cape', worn.weapon).find(g => (avail.get(g.id) ?? 0) > 0) ?? null;
            worn.cape = safeCape;
        }
    }

    const thrown = style === 'ranged' && !!worn.weapon && isThrownWeapon(worn.weapon);
    const ammo: Gear | null = style === 'ranged' && worn.weapon && !thrown ? ammoFor(worn.weapon) : null;
    const ammoCount = style === 'ranged' && worn.weapon ? ammoCountFor(worn.weapon) : 0;

    const items: { slot: RangedLoadoutSlotName; wearpos: number; item: Gear }[] = [];
    for (const slot of LOADOUT_SLOTS) {
        const item = worn[slot];
        if (item) items.push({ slot, wearpos: WEARPOS_BY_SLOT[slot], item });
    }
    if (ammo) items.push({ slot: 'ammo', wearpos: WEARPOS_BY_SLOT.ammo, item: ammo });

    // Compute slot-by-slot bestWearable, acquirableUpgrade, and nextUnlock across all rev-289 items.
    const upgrades: Partial<Record<RangedLoadoutSlotName, SlotUpgrade>> = {};
    const upgradeSlots: RangedLoadoutSlotName[] = style === 'ranged' ? [...LOADOUT_SLOTS, 'ammo'] : [...LOADOUT_SLOTS];
    const upgradeScore = (g: Gear, assumeUnlocked: boolean): number => {
        if (style === 'ranged' && g.slot === 'righthand' && isStandardRangedBow(g)) {
            const tier = assumeUnlocked ? (g.tier ?? 1) : Math.min(g.tier ?? 1, skillMap.ranged ?? 1);
            return scoreGearForStyle(g, style, maxArrowStrengthForTier(tier)) + 500;
        }
        return scoreGearForStyle(g, style);
    };

    for (const slot of upgradeSlots) {
        const current = slot === 'ammo' ? ammo : worn[slot];
        const wearSlot = GEAR_KEY_BY_SLOT[slot];
        const wearableList = slot === 'ammo'
            ? gearCatalog()
                .filter(g => g.slot === 'quiver' && arrowCompatibility(worn.weapon, g) && (g.tier ?? 1) <= (skillMap.ranged ?? 1))
                .sort((a, b) => scoreGearForStyle(b, 'ranged') - scoreGearForStyle(a, 'ranged') || a.id - b.id)
            : slotCandidates(slot, worn.weapon);
        const bestWearable = wearableList[0] ?? null;
        const currentScore = current ? upgradeScore(current, false) : -Infinity;
        const bestScore = bestWearable ? upgradeScore(bestWearable, false) : -Infinity;

        // The item the account can obtain now: wearable, better than the current one, not owned, and with a source
        // (gearSources). Each is valued by its gain, halved for each GEAR_COST_SCALE coins of its cheapest source; the
        // best value is the want. An item with no source (a god cape, the Unholy book, or a market ask over the limit)
        // is never the want. `goal` is the best wearable item whatever its source.
        const openShops = (g: Gear) => (shops.get(g.id) ?? []).filter(sh => shopAccessible(sh, skillMap, done, undefined, options.questPoints));
        const sourcesOf = (g: Gear) => gearSources(g, { skills: skillMap, done, market: options.market, position: options.position, openShops: openShops(g) });
        const gainOf = (g: Gear) => currentScore === -Infinity ? Math.max(upgradeScore(g, false), 1) : upgradeScore(g, false) - currentScore;
        let wanted: Gear | undefined, wantedSources: GearSource[] = [], wantedValue = -Infinity;
        for (const g of wearableList) {
            if (g.id === current?.id || upgradeScore(g, false) <= currentScore || have(g) >= (slot === 'ammo' ? arrowMin : 1)) continue;
            const found = sourcesOf(g);
            if (!found.length) continue;
            const value = valueOf(gainOf(g), sourceCost(g, found[0]!));
            if (value > wantedValue) { wanted = g; wantedSources = found; wantedValue = value; }
        }
        const acquirableUpgrade = wanted
            ? { item: wanted, shops: openShops(wanted), tradeable: wanted.tradeable, sources: wantedSources, source: wantedSources[0]! }
            : null;
        const goal = bestWearable && bestWearable.id !== current?.id && bestScore > currentScore && have(bestWearable) < (slot === 'ammo' ? arrowMin : 1)
            ? { item: bestWearable, sources: sourcesOf(bestWearable) }
            : null;

        // Next unlock: items better than both current and bestWearable that fail at least one skill/quest req.
        const threshold = Math.max(currentScore, bestScore);
        const locked = gearCatalog()
            .filter(g => {
                if (g.slot !== wearSlot) return false;
                if (slot === 'weapon' && !weaponSupportsTrainSkill(g, options.trainSkill)) return false;
                if (slot === 'ammo') {
                    if (!isStandardArrow(g)) return false;
                    return (g.tier ?? 1) > (skillMap.ranged ?? 1) && upgradeScore(g, true) > threshold;
                }
                if (canWearGear(g, skillMap, done)) return false;
                return upgradeScore(g, true) > threshold;
            })
            .map(g => {
                if (slot === 'ammo') {
                    const reqRanged = g.tier ?? 1;
                    const missingSkills: Partial<Record<Skill, number>> = (skillMap.ranged ?? 1) < reqRanged ? { ranged: reqRanged } : {};
                    return { item: g, missingSkills, missingQuests: [] as string[], score: upgradeScore(g, true) };
                }
                const reqs = missingRequirements(g, skillMap, done);
                return { item: g, ...reqs, score: upgradeScore(g, true) };
            })
            .filter(x => Object.keys(x.missingSkills).length > 0 || x.missingQuests.length > 0)
            .sort((a, b) =>
                unlockRank(a.item, a.missingSkills, a.missingQuests, slot === 'ammo')
                - unlockRank(b.item, b.missingSkills, b.missingQuests, slot === 'ammo')
                || b.score - a.score
                || a.item.id - b.item.id);

        const next = locked[0]
            ? {
                item: locked[0].item,
                missingSkills: locked[0].missingSkills,
                missingQuests: locked[0].missingQuests,
                shops: [...(shops.get(locked[0].item.id) ?? [])],
                tradeable: locked[0].item.tradeable,
            }
            : null;

        upgrades[slot] = {
            slot,
            wearpos: WEARPOS_BY_SLOT[slot],
            current,
            bestWearable,
            acquirableUpgrade,
            goal,
            nextUnlock: next,
        };
    }

    const gearSlots: GearSlot[] = items.map(({ slot, item }) => ({
        key: slot,
        options: [{
            id: item.id,
            count: 1,
            preference: 0,
            equippable: true,
            ...(slot === 'weapon' && item.covers.includes('lefthand') ? { occupies: ['shield'] } : {}),
        }],
    }));

    return {
        style,
        worn,
        ammo,
        thrown,
        ammoCount,
        items,
        gearSlots,
        ownedLoadout: solved,
        upgrades,
        bonuses: sumBonuses(items.map(i => i.item)),
    };
}

function hasOwnedWearableWeapon(
    style: CombatFocus,
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    trainSkill?: string,
): boolean {
    const loadout = selectProgressiveLoadout(style, stock, levels, quests, { trainSkill, requireWeapon: true });
    return loadout.worn.weapon !== null;
}

/**
 * True when the owned items hold a melee weapon that the levels and quests let the account wield (spears and
 * halberds count only when `trainSkill` allows them). `owned` maps an item name or id to its count, e.g.
 * { 'bronze sword': 1, 333: 5 }; a key that is not gear is ignored. The planner asks this for a stock of
 * names; the worker side calls selectProgressiveLoadout.
 */
export function ownsWearableMeleeWeapon(
    owned: Readonly<Record<string, number>> | readonly GearCount[],
    levels?: GearSkillLevels,
    quests?: QuestInput,
    trainSkill?: string,
): boolean {
    const rows: GearCount[] = Array.isArray(owned)
        ? [...owned as readonly GearCount[]]
        : Object.entries(owned as Record<string, number>).flatMap(([key, count]) => {
            const id = gearIdByName(key);
            return id === undefined || !(count > 0) ? [] : [{ id, count }];
        });
    return hasOwnedWearableWeapon('melee', rows, levels, quests, trainSkill ?? 'all-melee');
}

/**
 * Every melee weapon as the weapon option of an owned-loadout slot, the best first (scoreGearForStyle). An option is
 * equippable when the Attack level and the quests meet the weapon's wear rules, and unknown (null) when the Attack
 * level is unknown. `oneHanded` leaves out two-handed weapons (a worker that wears a fixed shield).
 */
export function meleeWeaponSlot(
    attack: number | null,
    options: { oneHanded?: boolean; trainSkill?: string; quests?: QuestInput } = {},
): GearSlot {
    const known = attack !== null && Number.isSafeInteger(attack) && attack >= 1 && attack <= 99;
    const list = gearCatalog()
        .filter(g => g.slot === 'righthand' && scoreGearForStyle(g, 'melee') > -1e8
            && weaponSupportsTrainSkill(g, options.trainSkill ?? 'all-melee')
            && !(options.oneHanded && g.covers.includes('lefthand')))
        .sort((a, b) => scoreGearForStyle(b, 'melee') - scoreGearForStyle(a, 'melee') || tieOrder(a, b, 'melee'));
    return {
        key: 'weapon',
        options: list.map((g, preference) => ({
            id: g.id, count: 1, preference,
            equippable: known ? canWearGear(g, { attack: attack! }, options.quests) : null,
        })),
    };
}

/** The Fire giant pilot's kit: its best one-handed melee weapon (the engine's choice) with the fixed shield, amulet, rope and Salmon. */
export function fireKit(attack: number | null): GearSlot[] {
    const fixed = [{ key: 'shield', id: 1171, count: 1 }, { key: 'amulet', id: 295, count: 1 }, { key: 'rope', id: 954, count: 1 }, { key: 'salmon', id: 329, count: 16 }];
    return [meleeWeaponSlot(attack, { oneHanded: true, trainSkill: 'Attack' }),
        ...fixed.map(x => ({ key: x.key, options: [{ id: x.id, count: x.count, preference: 0, equippable: true }] }))];
}
