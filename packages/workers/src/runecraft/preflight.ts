// WorkerModule preflight(), estimate(), and RunOutcome translation for Runecraft.
import {
    type PreflightBlocker,
    type PreflightMissingItem,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerWorldView,
    accountOwnedItemCount,
    accountReserveFor,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
} from '../contracts';
import {
    ALL_ALTARS,
    ALL_ALTARS_BY_NAME,
    BODY_CARRIER_ALTAR,
    COSMIC_ALTAR,
    DRAMEN_STAFF,
    ESSENCE,
    NATURE,
    RUNE_ALTARS,
    carrierAltar,
    chooseRuneAltar,
    insideAirAltar,
} from './altars';
import {
    RUNECRAFT_MODES,
    type NormalizedRunecraftConfig,
    type RunecraftConfig,
    type RunecraftSessionOutcome,
    normalizeRunecraftConfig,
} from './types';

let cachedCarrierRosterMod: typeof import('./carrier-roster') | undefined;
const loadCarrierRosterMod = (): typeof import('./carrier-roster') => (cachedCarrierRosterMod ??= require('./carrier-roster'));

const LOST_CITY_RE = /^Lost City$/i;
const RUNE_MYSTERIES_RE = /^Rune Mysteries(?: Quest)?$/i;
const SHILO_VILLAGE_RE = /^Shilo Village$/i;

function skillLevel(acct: WorkerAccountView, name: string): number {
    const direct = acct.skills[name];
    if (direct !== undefined) return direct.level;
    const lower = name.toLowerCase();
    for (const k in acct.skills) {
        if (k.toLowerCase() === lower) return acct.skills[k]!.level;
    }
    return lower === 'hitpoints' ? 10 : 1;
}

function questComplete(acct: WorkerAccountView, re: RegExp): boolean {
    for (const k in acct.quests) {
        if (re.test(k) && acct.quests[k] === 'complete') return true;
    }
    return false;
}

function availableStock(acct: WorkerAccountView, world: WorkerWorldView, itemId: number): number {
    const owned = accountOwnedItemCount(acct, itemId, { includeBank: true, requireTrustedBank: false });
    const reserved = accountReserveFor(acct, world, itemId);
    return reserveAdjustedStock(owned, reserved);
}

export function runecraftPreflight(
    acct: WorkerAccountView,
    rawCfg: RunecraftConfig,
    world: WorkerWorldView,
): PreflightResult {
    const cfg = normalizeRunecraftConfig(rawCfg);
    if (!RUNECRAFT_MODES.includes(cfg.mode)) {
        return preflightFail([{ kind: 'invalid_config', message: `unknown runecraft mode: ${String(cfg.mode)}` }]);
    }
    if (!Number.isSafeInteger(cfg.cap) || cfg.cap < 1) {
        return preflightFail([{ kind: 'invalid_config', message: `invalid runecraft tick cap: ${cfg.cap}` }]);
    }

    const blockers: PreflightBlocker[] = [];
    const missingItems: PreflightMissingItem[] = [];
    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: 'protected account clock restricts ordinary runecraft worker' });
    }

    const rcLevel = skillLevel(acct, 'Runecraft');
    const essence = availableStock(acct, world, ESSENCE);

    if (cfg.mode === 'bank-craft') {
        if (!Number.isSafeInteger(cfg.targetLevel) || cfg.targetLevel < 2 || cfg.targetLevel > 99) {
            return preflightFail([{ kind: 'invalid_config', message: `Runecraft target must be 2..99 (got ${cfg.targetLevel})` }]);
        }
        if (cfg.altar !== undefined && !ALL_ALTARS_BY_NAME.has(cfg.altar)) {
            return preflightFail([{ kind: 'invalid_config', message: `unknown rune altar: ${cfg.altar}` }]);
        }
        if (cfg.essenceTarget !== undefined && (!Number.isSafeInteger(cfg.essenceTarget) || cfg.essenceTarget < 1)) {
            return preflightFail([{ kind: 'invalid_config', message: `invalid essenceTarget: ${cfg.essenceTarget}` }]);
        }
        if (acct.maxLevels?.Runecraft !== undefined && rcLevel >= acct.maxLevels.Runecraft) {
            blockers.push({ kind: 'max_level_cap', skill: 'Runecraft', maxLevel: acct.maxLevels.Runecraft, current: rcLevel });
        }

        const ownedIds = new Set<number>();
        for (let i = 0; i < ALL_ALTARS.length; i++) {
            const altar = ALL_ALTARS[i]!;
            if (availableStock(acct, world, altar.talisman) > 0) ownedIds.add(altar.talisman);
        }

        if (cfg.altar === 'cosmic') {
            if (!cfg.members) blockers.push({ kind: 'invalid_config', message: 'members account required for Cosmic altar (Zanaris)' });
            if (!questComplete(acct, LOST_CITY_RE)) {
                blockers.push({ kind: 'quest_incomplete', quest: 'Lost City', requiredState: 'complete' });
            }
            if (availableStock(acct, world, DRAMEN_STAFF) < 1) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: DRAMEN_STAFF,
                    itemName: 'Dramen staff',
                    required: 1,
                    available: 0,
                    reserved: 0,
                });
                missingItems.push({ itemId: DRAMEN_STAFF, count: 1, itemName: 'Dramen staff' });
            }
            if (rcLevel < COSMIC_ALTAR.level) {
                blockers.push({ kind: 'skill_level', skill: 'Runecraft', required: COSMIC_ALTAR.level, current: rcLevel });
            }
            if (!ownedIds.has(COSMIC_ALTAR.talisman)) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: COSMIC_ALTAR.talisman,
                    itemName: 'Cosmic talisman',
                    required: 1,
                    available: 0,
                    reserved: 0,
                });
                missingItems.push({ itemId: COSMIC_ALTAR.talisman, count: 1, itemName: 'Cosmic talisman' });
            }
        } else if (cfg.altar !== undefined) {
            const altar = ALL_ALTARS_BY_NAME.get(cfg.altar)!;
            if (rcLevel < altar.level) {
                blockers.push({ kind: 'skill_level', skill: 'Runecraft', required: altar.level, current: rcLevel });
            }
            if (!ownedIds.has(altar.talisman)) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: altar.talisman,
                    itemName: `${altar.name} talisman`,
                    required: 1,
                    available: 0,
                    reserved: 0,
                });
                missingItems.push({ itemId: altar.talisman, count: 1, itemName: `${altar.name} talisman` });
            }
        } else {
            const sel = chooseRuneAltar(rcLevel, ownedIds);
            if (!sel.altar) {
                blockers.push({
                    kind: 'missing_supply',
                    itemId: 1438,
                    itemName: 'Air talisman',
                    required: 1,
                    available: 0,
                    reserved: 0,
                    message: 'no accessible altar talisman in pack or bank',
                });
                missingItems.push({ itemId: 1438, count: 1, itemName: 'Air talisman' });
            }
        }

        const neededEssence = cfg.essenceTarget ?? 1;
        if (essence < neededEssence) {
            blockers.push({
                kind: 'missing_supply',
                itemId: ESSENCE,
                itemName: 'Rune essence',
                required: neededEssence,
                available: essence,
                reserved: accountReserveFor(acct, world, ESSENCE),
            });
            missingItems.push({ itemId: ESSENCE, count: neededEssence - essence, itemName: 'Rune essence' });
        }
        return blockers.length ? preflightFail(blockers, { missingItems }) : preflightOk({ travelTicks: 24 });
    }

    if (cfg.mode === 'nature') {
        const j = cfg.natureJob;
        if (!j || !j.members || j.batch < 1 || j.batch > 27 || j.target < 1 || j.target > 100000) {
            return preflightFail([{ kind: 'invalid_config', message: 'nature mode requires valid member NatureJob (batch 1..27)' }]);
        }
        if (acct.maxLevels?.Runecraft !== undefined && rcLevel >= acct.maxLevels.Runecraft) {
            blockers.push({ kind: 'max_level_cap', skill: 'Runecraft', maxLevel: acct.maxLevels.Runecraft, current: rcLevel });
        }
        if (!cfg.members) blockers.push({ kind: 'invalid_config', message: 'members account required for Shilo Village Nature altar' });
        if (rcLevel < 44) blockers.push({ kind: 'skill_level', skill: 'Runecraft', required: 44, current: rcLevel });
        if (!questComplete(acct, RUNE_MYSTERIES_RE)) {
            blockers.push({ kind: 'quest_incomplete', quest: 'Rune Mysteries', requiredState: 'complete' });
        }
        if (!questComplete(acct, SHILO_VILLAGE_RE)) {
            blockers.push({ kind: 'quest_incomplete', quest: 'Shilo Village', requiredState: 'complete' });
        }
        if (j.protectMelee) {
            const prayer = skillLevel(acct, 'Prayer');
            if (prayer < 43) blockers.push({ kind: 'combat_survivability', reason: 'prayer', required: 43, current: prayer });
        }
        if (availableStock(acct, world, NATURE.talisman) < 1) {
            blockers.push({ kind: 'missing_supply', itemId: NATURE.talisman, itemName: 'Nature talisman', required: 1, available: 0, reserved: 0 });
            missingItems.push({ itemId: NATURE.talisman, count: 1, itemName: 'Nature talisman' });
        }
        if (essence < j.batch) {
            blockers.push({
                kind: 'missing_supply',
                itemId: ESSENCE,
                itemName: 'Rune essence',
                required: j.batch,
                available: essence,
                reserved: accountReserveFor(acct, world, ESSENCE),
            });
            missingItems.push({ itemId: ESSENCE, count: j.batch - essence, itemName: 'Rune essence' });
        }
        return blockers.length ? preflightFail(blockers, { missingItems }) : preflightOk({ travelTicks: 40 });
    }

    if (cfg.mode === 'supply') {
        if (!Number.isSafeInteger(cfg.targetLevel) || cfg.targetLevel < 2 || cfg.targetLevel > 99) {
            return preflightFail([{ kind: 'invalid_config', message: `Runecraft supply target must be 2..99 (got ${cfg.targetLevel})` }]);
        }
        if (acct.maxLevels?.Runecraft !== undefined && rcLevel >= acct.maxLevels.Runecraft) {
            blockers.push({ kind: 'max_level_cap', skill: 'Runecraft', maxLevel: acct.maxLevels.Runecraft, current: rcLevel });
        }
        if (rcLevel >= cfg.targetLevel) {
            blockers.push({ kind: 'invalid_config', message: `Runecraft level ${rcLevel} already at target ${cfg.targetLevel}` });
        }
        return blockers.length ? preflightFail(blockers) : preflightOk({ travelTicks: 80 });
    }

    if (cfg.mode === 'air') {
        if (acct.maxLevels?.Runecraft !== undefined && rcLevel >= acct.maxLevels.Runecraft) {
            blockers.push({ kind: 'max_level_cap', skill: 'Runecraft', maxLevel: acct.maxLevels.Runecraft, current: rcLevel });
        }
        if (acct.pos && !insideAirAltar({ worldX: acct.pos.x, worldZ: acct.pos.z, level: acct.pos.level })) {
            blockers.push({
                kind: 'unreachable_tile',
                target: { x: 2841, z: 4830, level: 0 },
                from: acct.pos,
                reason: 'no_route',
                message: 'air mode expects position inside the Air altar',
            });
        }
        const rawPackEss = accountOwnedItemCount(acct, ESSENCE, { includeBank: false });
        const reservedEss = accountReserveFor(acct, world, ESSENCE);
        const packEss = reserveAdjustedStock(rawPackEss, reservedEss);
        if (packEss < 1) {
            blockers.push({
                kind: 'missing_supply',
                itemId: ESSENCE,
                itemName: 'Rune essence',
                required: 1,
                available: rawPackEss,
                reserved: reservedEss,
            });
            missingItems.push({ itemId: ESSENCE, count: 1, itemName: 'Rune essence' });
        }
        return blockers.length ? preflightFail(blockers, { missingItems }) : preflightOk();
    }

    // Multi-account carrier and staging modes validate roster/altar parameters eagerly.
    try {
        const { runeCarrierRoster, runeStageRoster } = loadCarrierRosterMod();
        if (cfg.mode === 'carriers') runeCarrierRoster([...cfg.roster, '--carriers']);
        else if (cfg.mode === 'body-continuation') runeCarrierRoster([...cfg.roster, '--body-continuation']);
        else if (cfg.mode === 'body-measure') runeCarrierRoster([...cfg.roster, `--body-measure=${cfg.measurePacks ?? 12}`]);
        else if (cfg.mode === 'staged') {
            const altarName = cfg.altar ?? 'body';
            carrierAltar(altarName);
            runeCarrierRoster([...cfg.roster, `--staged=${altarName}:${cfg.targetLevel}`]);
        } else if (cfg.mode === 'stage-carriers') runeStageRoster([...cfg.roster, '--rune-carriers']);
        else if (cfg.mode === 'stage-opening') runeStageRoster([...cfg.roster, '--rune-opening']);
    } catch (error) {
        blockers.push({ kind: 'invalid_config', message: String(error) });
    }
    return blockers.length ? preflightFail(blockers) : preflightOk();
}

export function runecraftEstimate(
    acct: WorkerAccountView,
    rawCfg: RunecraftConfig,
    world: WorkerWorldView,
): RateEstimate {
    const cfg = normalizeRunecraftConfig(rawCfg);
    const xpRate = cfg.xpRate;
    const rcLevel = skillLevel(acct, 'Runecraft');

    if (cfg.mode === 'air') {
        return {
            xpPerTick: 5 * 27 * (xpRate / 25) * 2.5,
            skillXpPerTick: { Runecraft: 5 * 27 * (xpRate / 25) * 2.5 },
            unitsPerTick: 27 / 10,
            gpPerTick: 5,
            setupTicks: 0,
            minBatchUnits: 27,
            riskPerHour: 0,
            confidence: 'practice',
            outputsPerUnit: { 556: Math.floor(rcLevel / 11) + 1 },
            inputsPerUnit: { [ESSENCE]: 1 },
        };
    }

    if (cfg.mode === 'nature') {
        const multiplier = Math.floor(rcLevel / 91) + 1;
        return {
            xpPerTick: (9 * xpRate * 27) / 140,
            skillXpPerTick: { Runecraft: (9 * xpRate * 27) / 140 },
            unitsPerTick: 27 / 140,
            gpPerTick: 12 * multiplier,
            setupTicks: 40,
            minBatchUnits: 27,
            riskPerHour: 0.01,
            confidence: 'practice',
            outputsPerUnit: { [NATURE.rune]: multiplier },
            inputsPerUnit: { [ESSENCE]: 1 },
        };
    }

    if (cfg.mode === 'supply') {
        return {
            xpPerTick: 30 * (xpRate / 25),
            skillXpPerTick: { Runecraft: 30 * (xpRate / 25), Mining: 8 * (xpRate / 25) },
            unitsPerTick: 0.15,
            gpPerTick: 3,
            setupTicks: 80,
            minBatchUnits: 27,
            riskPerHour: 0.01,
            confidence: 'model',
            outputsPerUnit: { 556: Math.floor(rcLevel / 11) + 1 },
        };
    }

    if (cfg.mode === 'carriers' || cfg.mode === 'staged' || cfg.mode === 'body-continuation' || cfg.mode === 'body-measure') {
        const altar = carrierAltar(cfg.mode === 'staged' ? cfg.altar ?? 'body' : BODY_CARRIER_ALTAR.name);
        const xpPerEss = (altar.xpTenths / 10) * xpRate;
        return {
            xpPerTick: (27 * xpPerEss) / 8,
            skillXpPerTick: { Runecraft: (27 * xpPerEss) / 8 },
            unitsPerTick: 27 / 8,
            gpPerTick: 0,
            setupTicks: cfg.mode === 'carriers' ? 200 : 10,
            minBatchUnits: 27,
            riskPerHour: 0,
            confidence: 'practice',
            outputsPerUnit: { [altar.rune]: altar.multiplier === null ? 1 : Math.floor(rcLevel / altar.multiplier) + 1 },
            inputsPerUnit: { [ESSENCE]: 1 },
        };
    }

    const ownedIds = new Set<number>();
    for (let i = 0; i < ALL_ALTARS.length; i++) {
        const a = ALL_ALTARS[i]!;
        if (availableStock(acct, world, a.talisman) > 0) ownedIds.add(a.talisman);
    }
    const altar = cfg.altar
        ? ALL_ALTARS_BY_NAME.get(cfg.altar) ?? RUNE_ALTARS[0]!
        : chooseRuneAltar(rcLevel, ownedIds).altar ?? RUNE_ALTARS[0]!;
    const xpPerUnit = altar.xp * xpRate;
    const multiplier = Math.floor(rcLevel / altar.multiplier) + 1;
    const xpPerTick = (27 * xpPerUnit) / 95;
    return {
        xpPerTick,
        skillXpPerTick: { Runecraft: xpPerTick },
        unitsPerTick: 27 / 95,
        gpPerTick: 4 * multiplier,
        setupTicks: 24,
        minBatchUnits: 27,
        riskPerHour: 0,
        confidence: 'practice',
        outputsPerUnit: { [altar.rune]: multiplier },
        inputsPerUnit: { [ESSENCE]: 1 },
    };
}

export function toRunecraftWorkerOutcome(
    outcome: RunecraftSessionOutcome,
    account: string,
    cfg: NormalizedRunecraftConfig,
    ticksElapsed: number,
): RunOutcome {
    const base = {
        activityId: `runecraft:${cfg.mode}`,
        account,
        ticksElapsed: Math.max(0, ticksElapsed),
        ...(outcome.unitsCompleted !== undefined ? { unitsCompleted: outcome.unitsCompleted } : {}),
        ...(outcome.xpGained !== undefined ? { xpGained: { Runecraft: outcome.xpGained } } : {}),
        ...(outcome.itemsDelta ? { itemsDelta: outcome.itemsDelta } : {}),
        ...(outcome.detail ? { summary: outcome.detail } : {}),
    };
    if (outcome.ok) return { ...base, kind: 'target_met' };
    if (outcome.kind === 'missing_supply') {
        return {
            ...base,
            kind: 'missing_supply',
            missing: outcome.missing?.length ? outcome.missing : [{ itemId: ESSENCE, required: 1, available: 0 }],
        };
    }
    if (outcome.kind === 'stopped') return { ...base, kind: 'session_unsettled', reason: outcome.detail };
    if (outcome.kind === 'refused') {
        const detail = outcome.detail ?? '';
        if (/requires natureJob|multi-account runecraft mode|unknown|must be|already at target/i.test(detail)) {
            return { ...base, kind: 'worker_defect', faultSignature: `runecraft:${cfg.mode}:invalid_config`, detail };
        }
        return { ...base, kind: 'location_stranded', detail };
    }
    return { ...base, kind: 'worker_defect', faultSignature: `runecraft:${cfg.mode}:failed`, detail: outcome.detail };
}
