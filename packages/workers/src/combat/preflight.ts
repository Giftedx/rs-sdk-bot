import {
    accountOwnedItemCount,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../contracts';
import { CHOMPY, CHOMPY_TRIP, SHADE_ROUTE } from './special-mobs';
import { DRAGON_FOOD_IDS, DRAGONFIRE_SHIELD_ID } from './survivability';
import {
    COMBAT_MODE_SET,
    type CombatConfig,
    type CombatMode,
    type CombatSiteMeta,
} from './types';

export const COMBAT_SITES: Readonly<Record<CombatMode, CombatSiteMeta>> = {
    chicken: {
        mode: 'chicken',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:chicken',
        anchor: { x: 3232, z: 3296, level: 0 },
        membersOnly: false,
        defaultCapTicks: 3000,
    },
    cow: {
        mode: 'cow',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:cow',
        anchor: { x: 2630, z: 3366, level: 0 },
        membersOnly: false,
        defaultCapTicks: 3000,
    },
    druid: {
        mode: 'druid',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:druid',
        anchor: { x: 3110, z: 9930, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 20, Hitpoints: 20 },
        minFood: 4,
        defaultCapTicks: 6000,
    },
    unicorn: {
        mode: 'unicorn',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:unicorn',
        anchor: { x: 3087, z: 3452, level: 0 },
        membersOnly: false,
        minCombatStats: { Hitpoints: 20 },
        defaultCapTicks: 1500,
    },
    wizard: {
        mode: 'wizard',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:wizard',
        anchor: { x: 3110, z: 3170, level: 0 },
        membersOnly: false,
        minCombatStats: { Hitpoints: 20 },
        defaultCapTicks: 10000,
    },
    giant: {
        mode: 'giant',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:giant',
        anchor: { x: 3117, z: 9852, level: 0 },
        membersOnly: false,
        minCombatStats: { Hitpoints: 25 },
        minFood: 4,
        defaultCapTicks: 6000,
    },
    trooper: {
        mode: 'trooper',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:trooper',
        anchor: { x: 2619, z: 3332, level: 0 },
        membersOnly: true,
        minCombatStats: { Hitpoints: 35 },
        minFood: 10,
        defaultCapTicks: 1500,
    },
    taverley_druid: {
        mode: 'taverley_druid',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_druid',
        anchor: { x: 2925, z: 9848, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 20, Hitpoints: 25 },
        minFood: 6,
        defaultCapTicks: 6000,
    },
    taverley_black_knight: {
        mode: 'taverley_black_knight',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_black_knight',
        anchor: { x: 2895, z: 9835, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 40, Defence: 30, Hitpoints: 45 },
        minFood: 10,
        defaultCapTicks: 6000,
    },
    taverley_scales: {
        mode: 'taverley_scales',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_scales',
        anchor: { x: 2894, z: 9804, level: 0 },
        membersOnly: true,
        minCombatStats: { Hitpoints: 35 },
        minFood: 6,
        defaultCapTicks: 6000,
    },
    taverley_blue_dragon: {
        mode: 'taverley_blue_dragon',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_blue_dragon',
        anchor: { x: 2905, z: 9802, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 60, Strength: 60, Defence: 50, Hitpoints: 60 },
        requiredQuests: ['Dragon Slayer'],
        minFood: 12,
        defaultCapTicks: 6000,
    },
    taverley_black_dragon: {
        mode: 'taverley_black_dragon',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_black_dragon',
        anchor: { x: 2838, z: 9825, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 70, Strength: 70, Defence: 60, Hitpoints: 70 },
        requiredQuests: ['Dragon Slayer'],
        minFood: 14,
        defaultCapTicks: 6000,
    },
    taverley_giant: {
        mode: 'taverley_giant',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:taverley_giant',
        anchor: { x: 2906, z: 9792, level: 0 },
        membersOnly: true,
        minCombatStats: { Hitpoints: 45 },
        minFood: 10,
        defaultCapTicks: 6000,
    },
    chaos_wine: {
        mode: 'chaos_wine',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:chaos_wine',
        anchor: { x: 2931, z: 3515, level: 0 },
        membersOnly: false,
        minCombatStats: { Magic: 33 },
        defaultCapTicks: 4000,
    },
    'fire-giant': {
        mode: 'fire-giant',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:fire-giant',
        anchor: { x: 2619, z: 3332, level: 0 },
        membersOnly: true,
        requiredQuests: ['Waterfall Quest'],
        minCombatStats: { Hitpoints: 60, Prayer: 43 },
        minFood: 16,
        riskPerHour: 0.05,
        defaultCapTicks: 1400,
    },
    'fire-combat': {
        mode: 'fire-combat',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:fire-combat',
        anchor: { x: 2619, z: 3332, level: 0 },
        membersOnly: true,
        requiredQuests: ['Waterfall Quest'],
        minCombatStats: { Attack: 40, Hitpoints: 60, Prayer: 43 },
        minFood: 16,
        riskPerHour: 0.08,
        defaultCapTicks: 1600,
    },
    imp: {
        mode: 'imp',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:imp',
        anchor: { x: 2655, z: 3283, level: 0 },
        membersOnly: false,
        minCombatStats: { Attack: 10, Hitpoints: 15 },
        minFood: 2,
        defaultCapTicks: 900,
    },
    shade: {
        mode: 'shade',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:shade',
        anchor: { x: 3510, z: 3480, level: 0 },
        membersOnly: true,
        requiredQuests: ['Nature Spirit'],
        minCombatStats: { Attack: 40, Hitpoints: 90, Prayer: 43 },
        minFood: 4,
        riskPerHour: 0.06,
        defaultCapTicks: 2000,
    },
    chompy: {
        mode: 'chompy',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:chompy',
        anchor: { x: 2614, z: 3093, level: 0 },
        membersOnly: true,
        requiredQuests: ['Big Chompy Bird Hunting'],
        minCombatStats: { Ranged: 30, Hitpoints: 30, Prayer: 43 },
        defaultCapTicks: 5000,
    },
    'chompy-at-site': {
        mode: 'chompy-at-site',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:chompy-at-site',
        anchor: { x: 2547, z: 2982, level: 0 },
        membersOnly: true,
        requiredQuests: ['Big Chompy Bird Hunting'],
        minCombatStats: { Ranged: 30, Hitpoints: 10 },
        defaultCapTicks: 2000,
    },
    ranged: {
        mode: 'ranged',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:ranged',
        anchor: { x: 3253, z: 3421, level: 0 },
        membersOnly: false,
        defaultCapTicks: 3000,
    },
    'ranged-starter': {
        mode: 'ranged-starter',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:ranged-starter',
        anchor: { x: 3253, z: 3421, level: 0 },
        membersOnly: false,
        defaultCapTicks: 1800,
    },
    'ranged-gather': {
        mode: 'ranged-gather',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:ranged-gather',
        anchor: { x: 3253, z: 3421, level: 0 },
        membersOnly: false,
        minCombatStats: { Hitpoints: 10 },
        defaultCapTicks: 1500,
    },
    'ranged-camp': {
        mode: 'ranged-camp',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:ranged-camp',
        anchor: { x: 2895, z: 9792, level: 0 },
        membersOnly: true,
        minCombatStats: { Ranged: 30, Hitpoints: 30 },
        defaultCapTicks: 1400,
    },
    cannon: {
        mode: 'cannon',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:cannon',
        anchor: { x: 3287, z: 3810, level: 0 },
        membersOnly: true,
        requiredQuests: ['Dwarf Cannon'],
        minCombatStats: { Prayer: 43, Hitpoints: 40 },
        riskPerHour: 0.12,
        defaultCapTicks: 3000,
    },
    'loot-trip': {
        mode: 'loot-trip',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:loot-trip',
        anchor: { x: 3185, z: 3436, level: 0 },
        membersOnly: false,
        defaultCapTicks: 1200,
    },
    kbd: {
        mode: 'kbd',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:kbd',
        anchor: { x: 3092, z: 3496, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 40, Defence: 40, Magic: 25, Prayer: 43, Hitpoints: 70 },
        minFood: 6,
        minFreeSlots: 2,
        riskPerHour: 0.25,
        defaultCapTicks: 1000,
    },
    'black-dragon': {
        mode: 'black-dragon',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:black-dragon',
        anchor: { x: 2946, z: 3368, level: 0 },
        membersOnly: true,
        minCombatStats: { Ranged: 60, Prayer: 43, Hitpoints: 60 },
        minFood: 3,
        riskPerHour: 0.08,
        defaultCapTicks: 1500,
    },
    'blue-dragon': {
        mode: 'blue-dragon',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:blue-dragon',
        anchor: { x: 2946, z: 3368, level: 0 },
        membersOnly: true,
        minCombatStats: { Ranged: 40, Hitpoints: 50 },
        minFood: 4,
        riskPerHour: 0.1,
        defaultCapTicks: 3000,
    },
    'green-dragon': {
        mode: 'green-dragon',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:green-dragon',
        anchor: { x: 3092, z: 3810, level: 0 },
        membersOnly: true,
        minCombatStats: { Attack: 50, Strength: 50, Defence: 40, Hitpoints: 60 },
        minFood: 6,
        riskPerHour: 0.35,
        defaultCapTicks: 6000,
    },
    trawler: {
        mode: 'trawler',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:trawler',
        anchor: { x: 2675, z: 3170, level: 0 },
        membersOnly: true,
        minCombatStats: { Fishing: 15, Hitpoints: 10 },
        defaultCapTicks: 2200,
    },
    'trawler-at-site': {
        mode: 'trawler-at-site',
        family: 'combat',
        kind: 'gather',
        activityId: 'combat:trawler-at-site',
        anchor: { x: 2675, z: 3170, level: 0 },
        membersOnly: true,
        minCombatStats: { Fishing: 15, Hitpoints: 10 },
        defaultCapTicks: 2200,
    },
    'magic-order': {
        mode: 'magic-order',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:magic-order',
        anchor: { x: 3253, z: 3420, level: 0 },
        membersOnly: false,
        defaultCapTicks: 6000,
    },
    'magic-npc': {
        mode: 'magic-npc',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:magic-npc',
        anchor: { x: 3229, z: 3298, level: 0 },
        membersOnly: false,
        defaultCapTicks: 1200,
    },
    'magic-splash': {
        mode: 'magic-splash',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:magic-splash',
        anchor: { x: 2664, z: 3339, level: 0 },
        membersOnly: true,
        defaultCapTicks: 6000,
    },
    'magic-splash-coop': {
        mode: 'magic-splash-coop',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:magic-splash-coop',
        anchor: { x: 3229, z: 3292, level: 0 },
        membersOnly: false,
        defaultCapTicks: 600,
    },
    'prayer-flick': {
        mode: 'prayer-flick',
        family: 'combat',
        kind: 'train',
        activityId: 'combat:prayer-flick',
        anchor: { x: 3253, z: 3280, level: 0 },
        membersOnly: false,
        minCombatStats: { Prayer: 1, Hitpoints: 10 },
        defaultCapTicks: 1500,
    },
};

const ALL_FOOD_IDS = [385, 373, 379, 329, 333, 315, 2140, 2309, 1891, 1893, 1895] as const;

type SupplyReq = { itemId: number; itemName: string; required: number };

function requiredModeSupplies(acct: WorkerAccountView, mode: CombatMode): SupplyReq[] {
    const agility = acct.skills.Agility?.level ?? 1;
    switch (mode) {
        case 'fire-giant':
            return [
                { itemId: 294, itemName: 'Glarial\'s pebble', required: 1 },
                { itemId: 329, itemName: 'Salmon', required: 16 },
            ];
        case 'fire-combat':
            return [
                { itemId: 295, itemName: 'Glarial\'s amulet', required: 1 },
                { itemId: 954, itemName: 'Rope', required: 1 },
                { itemId: 329, itemName: 'Salmon', required: 16 },
                { itemId: 1171, itemName: 'Wooden shield', required: 1 },
            ];
        case 'shade':
            return [
                { itemId: SHADE_ROUTE.key, itemName: 'Mort\'ton shade key', required: 1 },
                { itemId: 2958, itemName: 'Druid pouch', required: 30 },
                { itemId: 2434, itemName: 'Prayer potion(4)', required: 1 },
                { itemId: 379, itemName: 'Lobster', required: 4 },
                { itemId: 1289, itemName: 'Rune sword', required: 1 },
            ];
        case 'chompy':
            return [
                { itemId: CHOMPY.bow, itemName: 'Ogre bow', required: 1 },
                { itemId: CHOMPY.arrow, itemName: 'Ogre arrow', required: CHOMPY_TRIP.arrowsPerKill },
                { itemId: 2434, itemName: 'Prayer potion(4)', required: 1 },
            ];
        case 'chompy-at-site':
            return [
                { itemId: CHOMPY.bow, itemName: 'Ogre bow', required: 1 },
                { itemId: CHOMPY.arrow, itemName: 'Ogre arrow', required: 10 },
            ];
        case 'kbd':
            return [
                { itemId: DRAGONFIRE_SHIELD_ID, itemName: 'Anti-dragon shield', required: 1 },
                { itemId: 1289, itemName: 'Rune sword', required: 1 },
                { itemId: 2448, itemName: 'Superantipoison(4)', required: 1 },
                { itemId: 2452, itemName: 'Antifire potion(4)', required: 1 },
                { itemId: 2434, itemName: 'Prayer potion(4)', required: 2 },
                { itemId: 385, itemName: 'Shark', required: 6 },
                { itemId: 563, itemName: 'Law rune', required: 1 },
                { itemId: 556, itemName: 'Air rune', required: 3 },
                { itemId: 554, itemName: 'Fire rune', required: 1 },
            ];
        case 'black-dragon':
            return agility < 70 ? [{ itemId: 1590, itemName: 'Dusty key', required: 1 }] : [];
        case 'blue-dragon':
            return [
                { itemId: DRAGONFIRE_SHIELD_ID, itemName: 'Anti-dragon shield', required: 1 },
                { itemId: 837, itemName: 'Crossbow', required: 1 },
                { itemId: 877, itemName: 'Bolts', required: 100 },
                ...(agility < 70 ? [{ itemId: 1590, itemName: 'Dusty key', required: 1 }] : []),
            ];
        case 'green-dragon':
            return [{ itemId: DRAGONFIRE_SHIELD_ID, itemName: 'Anti-dragon shield', required: 1 }];
        case 'trawler':
            return [
                { itemId: 1941, itemName: 'Swamp paste', required: 100 },
                { itemId: 954, itemName: 'Rope', required: 10 },
                { itemId: 583, itemName: 'Bailing bucket', required: 1 },
            ];
        case 'cannon':
            return [
                { itemId: 6, itemName: 'Cannon base', required: 1 },
                { itemId: 8, itemName: 'Cannon stand', required: 1 },
                { itemId: 10, itemName: 'Cannon barrels', required: 1 },
                { itemId: 12, itemName: 'Cannon furnace', required: 1 },
                { itemId: 2, itemName: 'Cannonball', required: 50 },
            ];
        case 'chaos_wine':
            return [{ itemId: 563, itemName: 'Law rune', required: 10 }];
        default:
            return [];
    }
}

function foodIdsForMode(mode: CombatMode): readonly number[] {
    if (mode === 'kbd' || mode === 'green-dragon' || mode === 'black-dragon' || mode === 'blue-dragon') return DRAGON_FOOD_IDS;
    if (mode === 'fire-giant' || mode === 'fire-combat') return [329];
    if (mode === 'shade') return [379];
    if (mode === 'imp') return [333];
    return ALL_FOOD_IDS;
}

export function estimateSetupTicks(acct: WorkerAccountView, site: CombatSiteMeta): number {
    if (!acct.pos) return 45;
    const dist = Math.max(Math.abs(acct.pos.x - site.anchor.x), Math.abs(acct.pos.z - site.anchor.z));
    return Math.min(240, Math.max(10, Math.ceil(dist / 2)));
}

export function combatPreflight(acct: WorkerAccountView, cfg: CombatConfig, world: WorkerWorldView): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];

    if (!cfg || !COMBAT_MODE_SET.has(cfg.mode)) {
        return preflightFail([{ kind: 'invalid_config', message: `unknown combat mode: ${String((cfg as { mode?: unknown })?.mode)}` }]);
    }
    if (cfg.capTicks !== undefined && (!Number.isSafeInteger(cfg.capTicks) || cfg.capTicks <= 0)) {
        return preflightFail([{ kind: 'invalid_config', message: `capTicks must be a positive safe integer (got ${cfg.capTicks})` }]);
    }
    if (cfg.maxKills !== undefined && (!Number.isSafeInteger(cfg.maxKills) || cfg.maxKills <= 0)) {
        return preflightFail([{ kind: 'invalid_config', message: `maxKills must be a positive safe integer (got ${cfg.maxKills})` }]);
    }
    if (cfg.targetLevel !== undefined && (!Number.isSafeInteger(cfg.targetLevel) || cfg.targetLevel < 1 || cfg.targetLevel > 99)) {
        return preflightFail([{ kind: 'invalid_config', message: `targetLevel must be 1..99 (got ${cfg.targetLevel})` }]);
    }

    const site = COMBAT_SITES[cfg.mode];

    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: 'combat worker is scoped to ordinary accounts' });
    }
    if (cfg.members === false && site.membersOnly) {
        blockers.push({ kind: 'invalid_config', message: `combat mode "${cfg.mode}" requires members access` });
    }
    if (cfg.maxRiskPerHour !== undefined && (site.riskPerHour ?? 0) > cfg.maxRiskPerHour) {
        blockers.push({ kind: 'invalid_config', message: `site risk ${site.riskPerHour} exceeds maxRiskPerHour ${cfg.maxRiskPerHour}` });
    }

    if (cfg.targetSkill && acct.maxLevels?.[cfg.targetSkill] !== undefined) {
        const current = acct.skills[cfg.targetSkill]?.level ?? 1;
        const maxLevel = acct.maxLevels[cfg.targetSkill]!;
        const goal = cfg.targetLevel ?? current + 1;
        if (goal > maxLevel) {
            blockers.push({
                kind: 'max_level_cap',
                skill: cfg.targetSkill,
                maxLevel,
                current,
                message: `${cfg.targetSkill} goal ${goal} exceeds max level cap ${maxLevel}`,
            });
        }
    }

    const occupancy = world.spotOccupancy?.[site.activityId] ?? 0;
    if (occupancy >= 4) {
        blockers.push({
            kind: 'capacity_full',
            spotId: site.activityId,
            active: occupancy,
            limit: 4,
            message: `${site.activityId} occupancy ${occupancy} reached limit 4`,
        });
    }

    for (const quest of site.requiredQuests ?? []) {
        const state = acct.quests[quest] ?? 'not_started';
        const allowed = cfg.mode === 'shade' && quest === 'Nature Spirit' ? state === 'started' || state === 'complete' : state === 'complete';
        if (!allowed) {
            blockers.push({
                kind: 'quest_incomplete',
                quest,
                requiredState: cfg.mode === 'shade' && quest === 'Nature Spirit' ? 'started' : 'complete',
                currentState: state,
                message: `quest "${quest}" is ${state}`,
            });
        }
    }

    for (const [skill, reqLevel] of Object.entries(site.minCombatStats ?? {})) {
        if (reqLevel === undefined) continue;
        const current = acct.skills[skill]?.level ?? 1;
        if (current < reqLevel) {
            if (skill === 'Hitpoints' || skill === 'Defence' || skill === 'Prayer') {
                blockers.push({
                    kind: 'combat_survivability',
                    reason: skill.toLowerCase() as 'hitpoints' | 'defence' | 'prayer',
                    required: reqLevel,
                    current,
                    message: `${skill} ${current} is below survivability floor ${reqLevel}`,
                });
            } else {
                blockers.push({
                    kind: 'skill_level',
                    skill,
                    required: reqLevel,
                    current,
                    message: `${skill} ${current} is below required ${reqLevel}`,
                });
            }
        }
    }

function itemReserveFor(acct: WorkerAccountView, itemId: number, world: WorkerWorldView): number {
    return world.globalReserves?.[itemId] ?? acct.reserves?.[itemId] ?? world.reserves?.[acct.name]?.[itemId] ?? 0;
}

function availableItemStock(acct: WorkerAccountView, itemId: number, world: WorkerWorldView): number {
    const owned = accountOwnedItemCount(acct, itemId);
    const reserved = itemReserveFor(acct, itemId, world);
    return reserveAdjustedStock(owned, reserved);
}

    for (const req of requiredModeSupplies(acct, cfg.mode)) {
        const avail = availableItemStock(acct, req.itemId, world);
        const total = accountOwnedItemCount(acct, req.itemId);
        const reserved = Math.max(0, total - avail);
        if (avail < req.required) {
            blockers.push({
                kind: 'missing_supply',
                itemId: req.itemId,
                itemName: req.itemName,
                required: req.required,
                available: avail,
                reserved,
                message: `missing ${req.itemName}: need ${req.required}, available ${avail}`,
            });
            missingItems.push({ itemId: req.itemId, count: req.required - avail, itemName: req.itemName });
        }
    }

    if (cfg.mode === 'chompy') {
        const bellowsCount = CHOMPY_TRIP.bellows.reduce((sum, id) => sum + availableItemStock(acct, id, world), 0);
        if (bellowsCount < 1) {
            blockers.push({
                kind: 'missing_supply',
                itemId: CHOMPY.full,
                itemName: 'Ogre bellows',
                required: 1,
                available: 0,
                reserved: 0,
                message: 'missing ogre bellows for chompy hunting',
            });
            missingItems.push({ itemId: CHOMPY.empty, count: 1, itemName: 'Ogre bellows' });
        }
    }

    if (cfg.mode === 'chompy-at-site') {
        const charges =
            availableItemStock(acct, CHOMPY.full, world) * 3
            + availableItemStock(acct, CHOMPY.two, world) * 2
            + availableItemStock(acct, CHOMPY.one, world)
            + availableItemStock(acct, CHOMPY.empty, world);
        if (charges < 1 && availableItemStock(acct, CHOMPY.bait, world) < 1) {
            blockers.push({
                kind: 'missing_supply',
                itemId: CHOMPY.empty,
                itemName: 'Ogre bellows',
                required: 1,
                available: 0,
                reserved: 0,
                message: 'at-site chompy hunt requires ogre bellows or bloated toad bait',
            });
            missingItems.push({ itemId: CHOMPY.empty, count: 1, itemName: 'Ogre bellows' });
        }
    }

    if (site.minFood && site.minFood > 0) {
        const foodIds = foodIdsForMode(cfg.mode);
        const availableFood = foodIds.reduce((sum, id) => sum + availableItemStock(acct, id, world), 0);
        if (availableFood < site.minFood) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'food',
                required: site.minFood,
                current: availableFood,
                message: `food stock ${availableFood} is below floor ${site.minFood}`,
            });
            missingItems.push({ itemId: foodIds[0]!, count: site.minFood - availableFood });
        }
    }

    const travelCoins = cfg.mode === 'chompy' || cfg.mode === 'trawler' || cfg.mode === 'green-dragon' ? 500 : 0;
    if (travelCoins > 0) {
        const reservedCoins = itemReserveFor(acct, 995, world);
        const coins = availableCoinsAfterReserves(accountOwnedItemCount(acct, 995), reservedCoins, world.geEscrowCoins?.[acct.name] ?? 0);
        if (coins < travelCoins) {
            blockers.push({
                kind: 'missing_coins',
                required: travelCoins,
                available: coins,
                reserved: reservedCoins,
                ferryFare: travelCoins,
                message: `need ${travelCoins} coins for travel`,
            });
        }
    }

    const travelTicks = estimateSetupTicks(acct, site);
    if (blockers.length > 0) {
        return preflightFail(blockers, {
            travelCoins,
            travelTicks,
            ...(missingItems.length ? { missingItems } : {}),
        });
    }
    return preflightOk({ travelCoins, travelTicks });
}
