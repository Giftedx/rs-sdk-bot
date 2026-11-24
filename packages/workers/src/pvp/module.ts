import {
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    preflightFail,
    preflightOk,
    type PreflightBlocker,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../contracts';
import type { Session } from '../../../core/src/inprocess';
import { PVP_MODES_LIST, type PvpConfig, type PvpMode } from './types';

const PVP_MODES_SET = new Set<string>(PVP_MODES_LIST);
const SHARK_ID = 385;
const LAW_RUNE_ID = 563;
const GLORY_IDS = [1712, 1710, 1708, 1706] as const;
const FOOD_IDS = [SHARK_ID, 379, 373, 333, 329] as const;

function isPvpModeLocal(mode: string): mode is PvpMode {
    return PVP_MODES_SET.has(mode);
}

const MODE_RISK: Record<PvpMode, number> = {
    fight: 0.25,
    spar: 0.1,
    gang: 0.2,
    army: 0.22,
    squad: 0.22,
    team: 0.15,
    hunt: 0.25,
    roam: 0.2,
    pilot: 0.25,
    standby: 0.02,
    'stage-kit': 0,
    'escort-ore': 0.2,
    'microbot-pvp': 0.05,
    'special-swap': 0,
    monitor: 0,
};

function ownedCounts(acct: WorkerAccountView): Record<number, number> {
    const out: Record<number, number> = {};
    const addBag = (bag: Readonly<Record<number, number>>) => {
        for (const k in bag) {
            if (!Object.prototype.hasOwnProperty.call(bag, k)) continue;
            const n = bag[k as unknown as number]!;
            if (n > 0) {
                const id = Number(k);
                out[id] = (out[id] ?? 0) + n;
            }
        }
    };
    addBag(acct.inventory);
    addBag(acct.equipment);
    addBag(acct.bank.items);
    return out;
}

function preflightPvp(acct: WorkerAccountView, cfg: PvpConfig, world: WorkerWorldView): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    if (acct.protectedClock) {
        blockers.push({ kind: 'protected_clock', message: `${acct.name} protected clock cannot run unprotected PvP` });
        return preflightFail(blockers);
    }
    if (!isPvpModeLocal(cfg.mode)) {
        blockers.push({ kind: 'invalid_config', message: `unknown PvP mode ${String(cfg.mode)}` });
        return preflightFail(blockers);
    }
    if (cfg.capTicks !== undefined && (!Number.isSafeInteger(cfg.capTicks) || cfg.capTicks < 1)) {
        blockers.push({ kind: 'invalid_config', message: 'capTicks must be a positive integer' });
    }
    if (cfg.maxMinutes !== undefined && (!Number.isFinite(cfg.maxMinutes) || cfg.maxMinutes <= 0)) {
        blockers.push({ kind: 'invalid_config', message: 'maxMinutes must be positive' });
    }
    if (cfg.maxWilderness !== undefined && (!Number.isSafeInteger(cfg.maxWilderness) || cfg.maxWilderness < 1 || cfg.maxWilderness > 56)) {
        blockers.push({ kind: 'invalid_config', message: 'maxWilderness must be in 1..56' });
    }
    if (cfg.mode === 'fight' && cfg.target !== undefined && !cfg.target.trim()) {
        blockers.push({ kind: 'invalid_config', message: 'fight target cannot be blank' });
    }
    if (cfg.requireBankTrusted && !acct.bank.trusted) {
        blockers.push({ kind: 'invalid_config', message: 'bank observation is not trusted' });
    }
    const minHp = cfg.minHitpointsLevel ?? 1;
    const hpLevel = acct.skills.Hitpoints?.level ?? 1;
    if (hpLevel < minHp) {
        blockers.push({ kind: 'skill_level', skill: 'Hitpoints', required: minHp, current: hpLevel });
    }

    const reserveCoins = accountReserveFor(acct, world, 995);
    const escrow = accountEscrowCoins(acct, world);
    const availCoins = availableCoinsAfterReserves(accountOwnedItemCount(acct, 995), reserveCoins, escrow, 0);
    if (cfg.minCoins !== undefined && availCoins < cfg.minCoins) {
        blockers.push({
            kind: 'missing_coins',
            required: cfg.minCoins,
            available: accountOwnedItemCount(acct, 995),
            reserved: reserveCoins,
            escrow,
        });
    }

    for (const req of cfg.requiredItems ?? []) {
        const res = accountReserveFor(acct, world, req.id);
        const have = Math.max(0, accountOwnedItemCount(acct, req.id) - res);
        if (have < req.count) {
            blockers.push({
                kind: 'missing_supply',
                itemId: req.id,
                itemName: req.itemName,
                required: req.count,
                available: have,
                reserved: res,
            });
        }
    }

    if (cfg.foodFloor !== undefined && cfg.foodFloor > 0) {
        let foodHeld = 0;
        for (let i = 0; i < FOOD_IDS.length; i++) foodHeld += accountOwnedItemCount(acct, FOOD_IDS[i]!);
        if (foodHeld < cfg.foodFloor) {
            blockers.push({
                kind: 'combat_survivability',
                reason: 'food',
                required: cfg.foodFloor,
                current: foodHeld,
            });
        }
    }

    if (cfg.requireEscape) {
        let hasEscape = accountOwnedItemCount(acct, LAW_RUNE_ID) > 0;
        if (!hasEscape) {
            for (let i = 0; i < GLORY_IDS.length; i++) {
                if (accountOwnedItemCount(acct, GLORY_IDS[i]!) > 0) {
                    hasEscape = true;
                    break;
                }
            }
        }
        if (!hasEscape) {
            blockers.push({
                kind: 'missing_supply',
                itemId: GLORY_IDS[0],
                itemName: 'escape_item',
                required: 1,
                available: 0,
                reserved: 0,
            });
        }
    }

    return blockers.length ? preflightFail(blockers) : preflightOk({ travelTicks: 25 });
}

function estimatePvp(_acct: WorkerAccountView, cfg: PvpConfig): RateEstimate {
    const mode = isPvpModeLocal(cfg.mode) ? cfg.mode : 'hunt';
    const isPracticeDuel = mode === 'spar' || mode === 'gang' || mode === 'team';
    const isPreparation = mode === 'stage-kit' || mode === 'standby' || mode === 'monitor' || mode === 'special-swap';
    return {
        xpPerTick: isPreparation ? 0 : 12,
        unitsPerTick: isPreparation ? 0.02 : 0.004,
        gpPerTick: mode === 'stage-kit' ? -1 : mode === 'roam' || mode === 'hunt' || mode === 'squad' ? 45 : 0,
        setupTicks: isPracticeDuel ? 20 : 60,
        minBatchUnits: 1,
        riskPerHour: MODE_RISK[mode],
        confidence: 'practice',
    };
}

function accountViewFromSession(session: SessionCore): WorkerAccountView {
    const st = session.sdk?.getState?.();
    const skills: Record<string, { level: number; xp: number }> = {};
    for (const sk of st?.skills ?? []) {
        skills[sk.name] = { level: sk.baseLevel ?? sk.level ?? 1, xp: sk.experience ?? 0 };
    }
    const bag = (rows: readonly { id: number; count: number }[]) => {
        const map: Record<number, number> = {};
        for (const r of rows) map[r.id] = (map[r.id] ?? 0) + r.count;
        return map;
    };
    const p = st?.player;
    return {
        name: session.name,
        side: 'local',
        protectedClock: false,
        skills,
        quests: {},
        pos: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
        inventory: bag(session.sdk?.getInventory?.() ?? []),
        equipment: bag(session.sdk?.getEquipment?.() ?? []),
        bank: { items: {}, observedAt: 0, trusted: false },
    };
}

async function runPvp(session: SessionCore, cfg: PvpConfig): Promise<RunOutcome> {
    const { watchWorkerStop } = await import('../stop');
    const activityId = `pvp:${cfg.mode}`;
    const startTick = session.tick?.() ?? 0;
    const { isStopped: stopCheck } = watchWorkerStop(session, cfg.stop);
    await Promise.resolve();
    if (stopCheck()) {
        return {
            kind: 'session_unsettled',
            activityId,
            account: session.name,
            ticksElapsed: 0,
            reason: 'stop requested before start',
        };
    }

    const acct = accountViewFromSession(session);
    const check = preflightPvp(acct, cfg, {
        at: Date.now(),
        side: 'local',
        server: 'local',
        accounts: { [acct.name.toLowerCase()]: acct },
    });
    if (!check.ok) {
        const b = check.blockers[0]!;
        if (b.kind === 'missing_supply') {
            return {
                kind: 'missing_supply',
                activityId,
                account: session.name,
                ticksElapsed: 0,
                missing: [{ itemId: b.itemId, required: b.required, available: b.available, itemName: b.itemName }],
            };
        }
        return {
            kind: 'worker_defect',
            activityId,
            account: session.name,
            ticksElapsed: 0,
            faultSignature: `preflight:${b.kind}`,
        };
    }

    const { assessTribridReadiness, CLI_ONLY_PVP_MODES, dispatchPvpCli } = await import('./modes');
    if (cfg.execute === false) {
        assessTribridReadiness(ownedCounts(acct), cfg.foodFloor ?? 18);
        return {
            kind: 'target_met',
            activityId,
            account: session.name,
            ticksElapsed: Math.max(0, (session.tick?.() ?? startTick) - startTick),
            unitsCompleted: 1,
        };
    }

    if (CLI_ONLY_PVP_MODES.has(cfg.mode)) {
        return {
            kind: 'worker_defect',
            activityId,
            account: session.name,
            ticksElapsed: Math.max(0, (session.tick?.() ?? startTick) - startTick),
            faultSignature: `pvp:${cfg.mode}:requires_cli_orchestrator`,
            detail: `multi-account/orchestrator PvP mode ${cfg.mode} must run via dispatchPvpCli / scripts/aio-pvp.ts`,
        };
    }

    const cliArgs: string[] = [...(cfg.args ?? [])];
    if (cfg.mode === 'fight' && cfg.target && !cliArgs.includes(cfg.target)) {
        cliArgs.unshift(cfg.target);
    }
    if (cfg.capTicks !== undefined && !cliArgs.some(a => /^\d+$/.test(a))) {
        cliArgs.push(String(cfg.capTicks));
    }

    try {
        const code = await dispatchPvpCli(session.name, cfg.mode, cliArgs, cfg.env, session as unknown as Session);
        const ticksElapsed = Math.max(0, (session.tick?.() ?? startTick) - startTick);
        if (code === 0) {
            return {
                kind: 'target_met',
                activityId,
                account: session.name,
                ticksElapsed,
                unitsCompleted: 1,
            };
        }
        return {
            kind: 'worker_defect',
            activityId,
            account: session.name,
            ticksElapsed,
            faultSignature: `pvp:${cfg.mode}:exit_${code}`,
        };
    } catch (error) {
        return {
            kind: 'worker_defect',
            activityId,
            account: session.name,
            ticksElapsed: Math.max(0, (session.tick?.() ?? startTick) - startTick),
            faultSignature: `pvp:${cfg.mode}:${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

/** Unified WorkerModule wrapping Wilderness PK, sparring, squads, roaming, staging, and monitoring. */
export const pvpModule: WorkerModule<PvpConfig> = {
    id: 'pvp:unified',
    family: 'pvp',
    kind: 'pk',
    trust: 'practice_passed',
    protectedAllowed: false,
    preflight: preflightPvp,
    estimate: estimatePvp,
    run: (session: SessionCore, cfg: PvpConfig) => {
        void (session as unknown as Session);
        return runPvp(session, cfg);
    },
};
