// WorkerModule preflight(), estimate(), and RunOutcome translation for Agility courses.
import {
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
} from '../contracts';
import { AGILITY_FOOD_PATTERN, BRIMHAVEN_ARENA, SUPPORTED_AGILITY_COURSES, onCourse, progressiveCourseForLevel } from './courses';
import { DRAYNOR_ENTRY, gnomeEntry } from './entry';
import { type AgilityConfig, type AgilitySessionOutcome, type NormalizedAgilityConfig, normalizeAgilityConfig } from './types';

const KNOWN_AGILITY_FOOD_IDS = [379, 373, 385, 333, 329, 361, 315, 2142, 2309, 1963, 1985, 1891, 1893, 1895] as const;
const AGILITY_POTION_IDS = [3032, 3034, 3036, 3038] as const;
const SUPPORTED_COURSE_SET = new Set<string>(SUPPORTED_AGILITY_COURSES);
const BARCRAWL_RE = /barcrawl/i;

function skillLevel(acct: WorkerAccountView, name: string): number {
    const direct = acct.skills[name];
    if (direct !== undefined) return direct.level;
    const lower = name.toLowerCase();
    for (const k in acct.skills) {
        if (k.toLowerCase() === lower) return acct.skills[k]!.level;
    }
    return lower === 'hitpoints' ? 10 : 1;
}

function barcrawlState(acct: WorkerAccountView): number {
    for (const k in acct.quests) {
        if (BARCRAWL_RE.test(k) && acct.quests[k] === 'complete') return 2;
    }
    return 0;
}

function ownedFoodCount(acct: WorkerAccountView, world: WorkerWorldView): number {
    let total = 0;
    for (const id of KNOWN_AGILITY_FOOD_IDS) {
        const owned = accountOwnedItemCount(acct, id, { includeBank: true, requireTrustedBank: false });
        total += reserveAdjustedStock(owned, accountReserveFor(acct, world, id));
    }
    return total;
}

function hasAgilityPotion(acct: WorkerAccountView, world: WorkerWorldView): boolean {
    for (const id of AGILITY_POTION_IDS) {
        const owned = accountOwnedItemCount(acct, id, { includeBank: true, requireTrustedBank: false });
        if (reserveAdjustedStock(owned, accountReserveFor(acct, world, id)) > 0) return true;
    }
    return false;
}

export function evaluateAgilityPreflight(
    acct: WorkerAccountView,
    rawCfg: AgilityConfig,
    world: WorkerWorldView,
): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];
    const cfg = normalizeAgilityConfig(rawCfg);

    if (cfg.course === 'ape-atoll') {
        return preflightFail([{
            kind: 'invalid_config',
            message: 'ape-atoll agility course is unsupported on this rev-289 server',
        }]);
    }
    if (!SUPPORTED_COURSE_SET.has(cfg.course)) {
        return preflightFail([{ kind: 'invalid_config', message: `unknown agility course: ${cfg.course}` }]);
    }
    if (!Number.isSafeInteger(cfg.targetLevel) || cfg.targetLevel < 1 || cfg.targetLevel > 99) {
        return preflightFail([{ kind: 'invalid_config', message: `invalid agility target level: ${cfg.targetLevel}` }]);
    }
    if (cfg.maxLaps !== undefined && (!Number.isSafeInteger(cfg.maxLaps) || cfg.maxLaps < 1)) {
        return preflightFail([{ kind: 'invalid_config', message: `invalid maxLaps: ${cfg.maxLaps}` }]);
    }
    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: 'protected account clock restricts ordinary agility worker' });
    }

    const currentAgility = skillLevel(acct, 'Agility');
    const hp = skillLevel(acct, 'Hitpoints');
    const barcrawl = cfg.barcrawl ?? barcrawlState(acct);

    if (acct.maxLevels?.Agility !== undefined && currentAgility >= acct.maxLevels.Agility) {
        blockers.push({ kind: 'max_level_cap', skill: 'Agility', maxLevel: acct.maxLevels.Agility, current: currentAgility });
    }
    if (currentAgility >= cfg.targetLevel && !cfg.stopOnMaxLaps) {
        blockers.push({ kind: 'invalid_config', message: 'already at target' });
    }

    const effectiveCourse = cfg.course === 'progressive'
        ? progressiveCourseForLevel(currentAgility, { barcrawl, potion: cfg.usePotion })
        : cfg.course;

    const foodHeld = ownedFoodCount(acct, world);
    if (hp < 8 && foodHeld <= 0 && acct.pos && !(effectiveCourse === 'gnome' && gnomeEntry({ worldX: acct.pos.x, worldZ: acct.pos.z, level: acct.pos.level }) === 'draynor')) {
        blockers.push({ kind: 'combat_survivability', reason: 'food', required: 8, current: hp, message: 'low HP with no owned food' });
    }

    const totalCoins = accountOwnedItemCount(acct, 995, { includeBank: true, requireTrustedBank: false });
    const reservedCoins = accountReserveFor(acct, world, 995);
    const escrowCoins = accountEscrowCoins(acct, world);
    const spendableCoins = availableCoinsAfterReserves(totalCoins, reservedCoins, escrowCoins, 0);

    let travelCoins = 0;
    let travelTicks = 0;

    if (effectiveCourse === 'barbarian') {
        if (currentAgility < 35) {
            blockers.push({ kind: 'skill_level', skill: 'Agility', required: 35, current: currentAgility });
        }
        if (barcrawl !== 2) {
            blockers.push({
                kind: 'quest_incomplete',
                quest: 'Alfred Grimhand Barcrawl',
                requiredState: 'complete',
                currentState: 'not_started',
                message: 'barbarian requires Alfred Grimhand Barcrawl complete',
            });
        }
    } else if (effectiveCourse === 'wilderness') {
        const boostedOk = Boolean(cfg.usePotion && currentAgility >= 49 && hasAgilityPotion(acct, world));
        if (currentAgility < 52 && !boostedOk) {
            if (cfg.usePotion && currentAgility >= 49 && !hasAgilityPotion(acct, world)) {
                blockers.push({ kind: 'missing_supply', itemId: 3032, itemName: 'Agility potion(4)', required: 1, available: 0, reserved: 0 });
                missingItems.push({ itemId: 3032, count: 1, itemName: 'Agility potion(4)' });
            } else {
                blockers.push({ kind: 'skill_level', skill: 'Agility', required: 52, current: currentAgility });
            }
        }
    } else if (effectiveCourse === 'brimhaven') {
        if (spendableCoins < BRIMHAVEN_ARENA.feeCoins && (!acct.pos || acct.pos.level !== 3)) {
            blockers.push({
                kind: 'missing_coins',
                required: BRIMHAVEN_ARENA.feeCoins,
                available: totalCoins,
                reserved: reservedCoins + escrowCoins,
                message: 'brimhaven entry requires 200 coins',
            });
        }
        travelCoins = BRIMHAVEN_ARENA.feeCoins;
        travelTicks = 60;
    } else if (effectiveCourse === 'gnome' && acct.pos) {
        const pos = { worldX: acct.pos.x, worldZ: acct.pos.z, level: acct.pos.level };
        if (!onCourse('gnome', pos)) {
            if (pos.level !== 0) {
                blockers.push({
                    kind: 'unreachable_tile',
                    target: { x: 2474, z: 3437, level: 0 },
                    from: acct.pos,
                    reason: 'plane_mismatch',
                });
            } else {
                const region = gnomeEntry(pos);
                if (!region) {
                    blockers.push({
                        kind: 'unreachable_tile',
                        target: { x: 2474, z: 3437, level: 0 },
                        from: acct.pos,
                        reason: 'no_route',
                        message: 'unsupported gnome entry region: no safe route from here',
                    });
                } else if (region === 'draynor') {
                    const needCoins = DRAYNOR_ENTRY.fare * DRAYNOR_ENTRY.fares + (foodHeld > 0 ? 0 : DRAYNOR_ENTRY.foodReserve);
                    if (spendableCoins < needCoins) {
                        blockers.push({
                            kind: 'missing_coins',
                            required: needCoins,
                            available: totalCoins,
                            reserved: reservedCoins + escrowCoins,
                            ferryFare: DRAYNOR_ENTRY.fare * DRAYNOR_ENTRY.fares,
                        });
                    }
                    travelCoins = DRAYNOR_ENTRY.fare * DRAYNOR_ENTRY.fares;
                    travelTicks = 280;
                }
            }
        }
    }

    return blockers.length > 0
        ? preflightFail(blockers, { ...(missingItems.length ? { missingItems } : {}), travelCoins, travelTicks })
        : preflightOk({ travelCoins, travelTicks });
}

// Practice/25x lap rates calibrated from measured laps (research/agility.md).
const COURSE_RATES = {
    gnome: { xpPerLap: 86.5 * 25, ticksPerLap: 52, setupTicks: 40, gpPerTick: 0, risk: 0 },
    barbarian: { xpPerLap: 153.2 * 25, ticksPerLap: 60, setupTicks: 60, gpPerTick: 0, risk: 0.01 },
    wilderness: { xpPerLap: 571.4 * 25, ticksPerLap: 70, setupTicks: 80, gpPerTick: 0, risk: 0.03 },
    brimhaven: { xpPerLap: 340 * 25, ticksPerLap: 98, setupTicks: 120, gpPerTick: -2, risk: 0.02 },
} as const;

export function agilityEstimate(
    acct: WorkerAccountView,
    rawCfg: AgilityConfig,
    world: WorkerWorldView,
): RateEstimate {
    const cfg = normalizeAgilityConfig(rawCfg);
    const level = skillLevel(acct, 'Agility');
    const barcrawl = cfg.barcrawl ?? barcrawlState(acct);
    const key = cfg.course === 'progressive'
        ? progressiveCourseForLevel(level, { barcrawl, potion: cfg.usePotion })
        : (cfg.course in COURSE_RATES ? cfg.course : 'gnome') as keyof typeof COURSE_RATES;
    const row = COURSE_RATES[key];
    const xpPerTick = row.xpPerLap / row.ticksPerLap;
    const entryTicks = key === 'gnome' && acct.pos && gnomeEntry({ worldX: acct.pos.x, worldZ: acct.pos.z, level: acct.pos.level }) === 'draynor'
        ? 280
        : row.setupTicks;
    return {
        xpPerTick,
        skillXpPerTick: { Agility: xpPerTick },
        unitsPerTick: 1 / row.ticksPerLap,
        gpPerTick: row.gpPerTick,
        setupTicks: entryTicks + (world.at < 0 ? 0 : 0),
        minBatchUnits: 1,
        riskPerHour: row.risk,
        confidence: key === 'brimhaven' ? 'model' : 'practice',
        ...(key === 'brimhaven' ? { outputsPerUnit: { [BRIMHAVEN_ARENA.ticketId]: 1 } } : {}),
    };
}

export function toAgilityWorkerOutcome(
    outcome: AgilitySessionOutcome,
    account: string,
    cfg: NormalizedAgilityConfig,
    ticksElapsed: number,
): RunOutcome {
    const base = {
        activityId: `agility:${cfg.course}`,
        account,
        ticksElapsed: outcome.delta?.elapsedTicks ?? ticksElapsed,
        ...(outcome.result?.laps !== undefined ? { unitsCompleted: outcome.result.laps } : {}),
        ...(outcome.delta?.xp ? { xpGained: outcome.delta.xp } : {}),
        ...(outcome.delta?.items ? { itemsDelta: outcome.delta.items } : {}),
        ...(outcome.delta?.coins !== undefined ? { coinsDelta: outcome.delta.coins } : {}),
        summary: outcome.detail,
    };

    if (outcome.ok && outcome.kind === 'completed') {
        return { kind: 'target_met', ...base };
    }
    if (outcome.kind === 'died') {
        return { kind: 'death', ...base, faultSignature: 'death:agility', detail: outcome.detail };
    }
    if (outcome.kind === 'refused') {
        if (/low HP: no owned food|missing owned/i.test(outcome.detail)) {
            const food = /potion/i.test(outcome.detail)
                ? { itemId: 3032, required: 1, available: 0, itemName: 'Agility potion' }
                : { itemId: 379, required: 1, available: 0, itemName: 'Lobster' };
            return { kind: 'missing_supply', ...base, missing: [food] };
        }
        return { kind: 'worker_defect', ...base, faultSignature: `refused:${outcome.detail.slice(0, 64)}`, detail: outcome.detail };
    }
    if (outcome.kind === 'aborted' || /interrupted|budget exhausted/i.test(outcome.detail)) {
        return { kind: 'session_unsettled', ...base, reason: outcome.detail, detail: outcome.detail };
    }
    return {
        kind: 'worker_defect',
        ...base,
        faultSignature: `agility:${outcome.detail.slice(0, 64)}`,
        detail: outcome.detail,
    };
}

export { AGILITY_FOOD_PATTERN };
