// Unified WorkerModule implementation and role dispatcher for fleet logistics operations.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Outcome } from '../../../core/src/act';
import type { Session } from '../../../core/src/inprocess';
import type { SessionCore } from '../../../core/src/session-types';
import {
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    isWorkerTile,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
    type PreflightBlocker,
    type PreflightResult,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerTile,
    type WorkerWorldView,
} from '../contracts';
import { HUB_BANKS, isWildernessTile } from './location';
import { watchWorkerStop } from '../stop';
import {
    GLORY_UNCHARGED,
    altarText,
    canEnterHeroesBasement,
    parseAltar,
    parseCoins,
    parseFanin,
    parseFanout,
    parseRecoveryTargetArg,
    parseTakeFromBankerArgs,
} from './preflight';
import type { BankSortPolicy, BootstrapPhase, BootstrapRole, SupplyActors } from './stage';
import {
    LOGISTICS_OPERATIONS,
    REPO_ROOT,
    findLogisticsRole,
    resolveLogisticsStep,
    type LogisticsConfig,
    type LogisticsOperation,
    type LogisticsRole,
} from './types';

const GRAPES_ID = 1987;
const JUG_WATER_ID = 1937;
const DEFAULT_HEROES_COORDS: WorkerTile = { x: 2916, z: 9893, level: 0 };

function defaultRoleForOperation(operation: LogisticsOperation): LogisticsRole {
    switch (operation) {
        case 'trade': return 'fleet-trade';
        case 'hub_bank': return 'banker';
        case 'stage': return 'loadout';
        case 'walk': return 'walk-to';
        case 'recover': return 'recover-trapped';
        case 'inspect': return 'inspect';
    }
}

function readJsonArg(rawPath: string): unknown {
    const file = resolve(REPO_ROOT, rawPath);
    if (!existsSync(file)) throw Error(`file not found: ${rawPath}`);
    if (statSync(file).size > 262_144) throw Error(`JSON input exceeds 256 KiB cap: ${rawPath}`);
    return JSON.parse(readFileSync(file, 'utf8'));
}

export function importAioLoadout(args: readonly string[]) {
    if (args.length !== 2) throw Error('aio-logistics loadout-import requires <donor-setup.json> <native-bindings.json>');
    const { compileInventorySetup } = require('./stage') as typeof import('./stage');
    return compileInventorySetup(readJsonArg(args[0]!), readJsonArg(args[1]!));
}

function questNamesCompleted(acct: WorkerAccountView): Set<string> {
    const out = new Set<string>();
    for (const [k, state] of Object.entries(acct.quests)) {
        if (state !== 'complete') continue;
        const lower = k.toLowerCase();
        out.add(lower);
        if (lower === 'hero' || lower === 'heroquest') out.add("hero's quest");
    }
    return out;
}

function numericSkillMap(acct: WorkerAccountView): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, s] of Object.entries(acct.skills)) out[k] = s.level;
    return out;
}

function validateSupplyChainCliArgs(args: readonly string[], env: Record<string, string | undefined>) {
    const producer = args.find(a => a.startsWith('--producer='))?.slice(11) ?? env.PRODUCER ?? '';
    const courier = args.find(a => a.startsWith('--courier='))?.slice(10) ?? env.COURIER ?? '';
    const consumer = args.find(a => a.startsWith('--consumer='))?.slice(11) ?? env.CONSUMER ?? '';
    const dir = resolve(REPO_ROOT, args.find(a => a.startsWith('--dir='))?.slice(6) ?? env.CHAIN_DIR ?? '.practice/supply-chain');
    const cycles = Number(args.find(a => a.startsWith('--cycles='))?.slice(9) ?? env.CYCLES ?? 1);
    const server = args.find(a => a.startsWith('--server='))?.slice(9) ?? env.SERVER ?? '';
    const actors: SupplyActors = { producer, courier, consumer };
    return { actors, dir, cycles, server };
}

function checkLogisticsPreflight(acct: WorkerAccountView, cfg: LogisticsConfig, world: WorkerWorldView): PreflightResult {
    const blockers: PreflightBlocker[] = [];
    if (!cfg || typeof cfg !== 'object' || !(LOGISTICS_OPERATIONS as readonly string[]).includes(cfg.operation)) {
        return preflightFail([{ kind: 'invalid_config', message: 'unknown logistics operation' }]);
    }

    let role = cfg.role;
    if (role !== undefined) {
        const spec = findLogisticsRole(role);
        if (!spec) {
            return preflightFail([{ kind: 'invalid_config', message: `unknown logistics role: ${String(role)}` }]);
        }
        if (spec.operation !== cfg.operation) {
            return preflightFail([{ kind: 'invalid_config', message: `role ${spec.role} belongs to operation ${spec.operation}, got ${cfg.operation}` }]);
        }
        role = spec.role;
    }
    if (cfg.capTicks !== undefined && (!Number.isSafeInteger(cfg.capTicks) || cfg.capTicks < 1)) {
        blockers.push({ kind: 'invalid_config', message: 'capTicks must be a positive integer' });
    }
    if (cfg.reserve !== undefined && (!Number.isSafeInteger(cfg.reserve) || cfg.reserve < 0)) {
        blockers.push({ kind: 'invalid_config', message: 'reserve must be a non-negative integer' });
    }
    if (cfg.count !== undefined && (!Number.isSafeInteger(cfg.count) || cfg.count < 0)) {
        blockers.push({ kind: 'invalid_config', message: 'count must be a non-negative integer' });
    }
    if (cfg.bank !== undefined && !isWorkerTile(cfg.bank)) {
        blockers.push({ kind: 'invalid_config', message: 'bank must be a valid world tile' });
    }

    const args = cfg.args ?? [];
    const env = { ...(cfg.env ?? {}) };
    const effectiveRole = role ?? defaultRoleForOperation(cfg.operation);

    if (cfg.itemId !== undefined && cfg.count !== undefined && cfg.count > 0) {
        const owned = accountOwnedItemCount(acct, cfg.itemId, { requireTrustedBank: true });
        const reserved = accountReserveFor(acct, world, cfg.itemId);
        if (reserveAdjustedStock(owned, reserved) < cfg.count) {
            blockers.push({
                kind: 'missing_supply',
                itemId: cfg.itemId,
                ...(cfg.itemName ? { itemName: cfg.itemName } : {}),
                required: cfg.count,
                available: owned,
                reserved,
            });
        }
    }

    switch (cfg.operation) {
        case 'trade': {
            if (cfg.coins !== undefined && (!Number.isSafeInteger(cfg.coins) || cfg.coins <= 0)) {
                blockers.push({ kind: 'invalid_config', message: 'coins must be a positive integer' });
            } else if (cfg.coins !== undefined && cfg.coins > 0) {
                const ownedCoins = accountOwnedItemCount(acct, 995, { requireTrustedBank: true });
                const reservedCoins = (cfg.reserve ?? 0) + accountReserveFor(acct, world, 995);
                const escrow = accountEscrowCoins(acct, world);
                const available = availableCoinsAfterReserves(ownedCoins, reservedCoins, escrow, 0);
                if (available < cfg.coins) {
                    blockers.push({
                        kind: 'missing_coins',
                        required: cfg.coins,
                        available: ownedCoins,
                        reserved: reservedCoins,
                        escrow,
                    });
                }
            }
            if (args.length > 0) {
                try {
                    if (effectiveRole === 'coin-courier') parseCoins([cfg.account ?? acct.name, ...args]);
                    else if (effectiveRole === 'coin-fanout') parseFanout([cfg.account ?? acct.name, ...args]);
                    else if (effectiveRole === 'item-fanin') parseFanin([cfg.account ?? acct.name, ...args]);
                } catch (err) {
                    blockers.push({ kind: 'invalid_config', message: err instanceof Error ? err.message : String(err) });
                }
            }
            break;
        }
        case 'hub_bank': {
            if (effectiveRole === 'wine-stock' || cfg.targetBatches !== undefined) {
                const cooking = acct.skills.Cooking?.level ?? 1;
                if (cooking < 35) {
                    blockers.push({ kind: 'skill_level', skill: 'Cooking', required: 35, current: cooking });
                }
                if (cfg.targetBatches !== undefined) {
                    if (!Number.isSafeInteger(cfg.targetBatches) || cfg.targetBatches < 1) {
                        blockers.push({ kind: 'invalid_config', message: 'targetBatches must be a positive integer' });
                    } else if (cfg.reserveBatches !== undefined && (!Number.isSafeInteger(cfg.reserveBatches) || cfg.reserveBatches < 0)) {
                        blockers.push({ kind: 'invalid_config', message: 'reserveBatches must be a non-negative integer' });
                    } else {
                        const needed = cfg.targetBatches + (cfg.reserveBatches ?? 0);
                        for (const [id, itemName] of [[GRAPES_ID, 'Grapes'], [JUG_WATER_ID, 'Jug of water']] as const) {
                            const owned = accountOwnedItemCount(acct, id, { requireTrustedBank: true });
                            const reserved = accountReserveFor(acct, world, id);
                            if (reserveAdjustedStock(owned, reserved) < needed) {
                                blockers.push({
                                    kind: 'missing_supply',
                                    itemId: id,
                                    itemName,
                                    required: needed,
                                    available: owned,
                                    reserved,
                                });
                            }
                        }
                    }
                }
            }
            if (effectiveRole === 'take-from-banker' && args.length > 0) {
                try {
                    parseTakeFromBankerArgs(args);
                } catch (err) {
                    blockers.push({ kind: 'invalid_config', message: err instanceof Error ? err.message : String(err) });
                }
            }
            break;
        }
        case 'stage': {
            if (effectiveRole === 'loadout-import') {
                const count = cfg.setupFile && cfg.bindingsFile ? 2 : args.length;
                if (count !== 2) {
                    blockers.push({ kind: 'invalid_config', message: 'loadout-import requires donor setup and native bindings files' });
                }
            }
            if (effectiveRole === 'bank-sort' && args[1] !== undefined) {
                const maxMoves = Number(args[1]);
                if (!Number.isSafeInteger(maxMoves) || maxMoves < 1 || maxMoves > 576) {
                    blockers.push({ kind: 'invalid_config', message: 'bank-sort maxMoves must be between 1 and 576' });
                }
            }
            break;
        }
        case 'walk': {
            if (cfg.target !== undefined && !isWorkerTile(cfg.target)) {
                blockers.push({ kind: 'invalid_config', message: 'target must be a valid world tile' });
            }
            if (effectiveRole === 'walk-to' && !cfg.target && args.length < 2) {
                blockers.push({ kind: 'invalid_config', message: 'walk-to requires target tile or x z coordinates' });
            }
            break;
        }
        case 'recover': {
            if (cfg.target !== undefined) {
                if (!isWorkerTile(cfg.target)) {
                    blockers.push({ kind: 'invalid_config', message: 'target must be a valid world tile' });
                } else if (effectiveRole === 'recover-trapped' && isWildernessTile({ worldX: cfg.target.x, worldZ: cfg.target.z, level: cfg.target.level })) {
                    blockers.push({
                        kind: 'unreachable_tile',
                        target: cfg.target,
                        from: acct.pos,
                        reason: 'no_route',
                        message: 'refusing automated Wilderness recovery target',
                    });
                }
            }
            if (effectiveRole === 'recover-trapped' && acct.pos && isWildernessTile({ worldX: acct.pos.x, worldZ: acct.pos.z, level: acct.pos.level })) {
                blockers.push({
                    kind: 'unreachable_tile',
                    target: cfg.target ?? HUB_BANKS.varrockWest,
                    from: acct.pos,
                    reason: 'no_route',
                    message: 'refusing automated recovery from Wilderness',
                });
            }
            if (effectiveRole === 'charge-glory') {
                const skills = numericSkillMap(acct);
                const quests = questNamesCompleted(acct);
                const gate = canEnterHeroesBasement({ skills, quests });
                if (!gate.ok) {
                    if (!quests.has("hero's quest")) {
                        blockers.push({
                            kind: 'quest_incomplete',
                            quest: 'heroquest',
                            requiredState: 'complete',
                            currentState: acct.quests.heroquest ?? acct.quests.hero ?? 'not_started',
                            message: gate.reason,
                        });
                    } else {
                        blockers.push({
                            kind: 'combat_survivability',
                            reason: 'hitpoints',
                            required: 75,
                            current: acct.skills.Hitpoints?.level ?? 10,
                            message: gate.reason,
                        });
                    }
                }
                if (acct.bank.trusted) {
                    const unchargedOwned = GLORY_UNCHARGED.reduce(
                        (sum, id) => sum + accountOwnedItemCount(acct, id, { requireTrustedBank: true }),
                        0,
                    );
                    if (unchargedOwned < 1) {
                        blockers.push({
                            kind: 'missing_supply',
                            itemId: GLORY_UNCHARGED[0],
                            itemName: 'Amulet of glory (uncharged)',
                            required: 1,
                            available: 0,
                            reserved: 0,
                        });
                    }
                }
            }
            if (effectiveRole === 'restore-prayer' && (cfg.altar || env.ALTAR || args.some(a => /^ALTAR=/.test(a)))) {
                try {
                    const spec = cfg.altar ? `${cfg.altar.x},${cfg.altar.z}` : altarText(args, env.ALTAR);
                    parseAltar(spec);
                } catch (err) {
                    blockers.push({ kind: 'invalid_config', message: err instanceof Error ? err.message : String(err) });
                }
            }
            break;
        }
        case 'inspect':
            break;
    }

    return blockers.length > 0 ? preflightFail(blockers) : preflightOk();
}

function estimateLogistics(_acct: WorkerAccountView, cfg: LogisticsConfig, _world: WorkerWorldView): RateEstimate {
    const role = cfg.role ?? defaultRoleForOperation(cfg.operation);
    const minBatchUnits = cfg.count !== undefined && Number.isSafeInteger(cfg.count) && cfg.count > 0 ? cfg.count : 1;
    switch (role) {
        case 'wine-stock':
            return { xpPerTick: 0, unitsPerTick: 0.15, gpPerTick: 0, setupTicks: 15, minBatchUnits: cfg.operation === 'hub_bank' && cfg.targetBatches ? cfg.targetBatches : minBatchUnits, confidence: 'practice' };
        case 'bank-sort':
            return { xpPerTick: 0, unitsPerTick: 1, gpPerTick: 0, setupTicks: 15, minBatchUnits: 1, confidence: 'practice' };
        case 'loadout':
        case 'loadout-import':
            return { xpPerTick: 0, unitsPerTick: 0.5, gpPerTick: 0, setupTicks: 12, minBatchUnits: 1, confidence: 'practice' };
        case 'inspect':
            return { xpPerTick: 0, unitsPerTick: 0.2, gpPerTick: 0, setupTicks: 5, minBatchUnits: 1, confidence: 'practice' };
        case 'cure-poison':
            return { xpPerTick: 0, unitsPerTick: 0.1, gpPerTick: 0, setupTicks: 8, minBatchUnits: 1, confidence: 'practice' };
        case 'restore-prayer':
            return { xpPerTick: 0, unitsPerTick: 0.05, gpPerTick: 0, setupTicks: 25, minBatchUnits: 1, confidence: 'practice' };
        case 'recover-trapped':
            return { xpPerTick: 0, unitsPerTick: 0.02, gpPerTick: 0, setupTicks: 30, minBatchUnits: 1, confidence: 'practice' };
        case 'charge-glory':
            return { xpPerTick: 0, unitsPerTick: 0.03, gpPerTick: 0, setupTicks: 60, minBatchUnits: 1, confidence: 'practice' };
        default:
            return {
                xpPerTick: 0,
                unitsPerTick: cfg.operation === 'walk' ? 0.015 : 0.02,
                gpPerTick: 0,
                setupTicks: cfg.operation === 'walk' ? 40 : 30,
                minBatchUnits,
                confidence: 'practice',
            };
    }
}

function playerTileOrNull(s: Session): WorkerTile | null {
    const p = s.sdk.getState()?.player;
    return p ? { x: p.worldX, z: p.worldZ, level: p.level } : null;
}

function stopChecker(account: string): () => boolean {
    const lower = account.toLowerCase();
    return () => existsSync(join(REPO_ROOT, '.practice', 'stop-all'))
        || existsSync(join(REPO_ROOT, '.practice', `stop-${account}`))
        || existsSync(join(REPO_ROOT, '.practice', `stop-${lower}`));
}

export async function runLogisticsRole(
    account: string,
    roleInput: string,
    rest: readonly string[] = [],
    env: Record<string, string | undefined> = process.env,
    opts: { captureLog?: boolean } = {},
): Promise<{ ok: boolean; resultLine: string }> {
    const step = resolveLogisticsStep(roleInput, rest);
    const role = step.args[0] as LogisticsRole;
    const args = step.args.slice(1);
    const mergedEnv: Record<string, string | undefined> = { ...env, ...(step.env ?? {}) };

    let lastResultLine = '';
    const log = (line: string) => {
        console.log(line);
        if (/^RESULT (?:ok|fail)\b/.test(line)) lastResultLine = line;
    };

    const isStopped = (name: string) => () =>
        existsSync(join(REPO_ROOT, '.practice', 'stop-all')) || existsSync(join(REPO_ROOT, '.practice', `stop-${name}`));

    if (role === 'loadout-import') {
        console.log(JSON.stringify(importAioLoadout(args), null, 2));
        console.log('RESULT ok loadout-import');
        return { ok: true, resultLine: 'RESULT ok loadout-import' };
    }

    if (role === 'coin-courier') {
        const { runCoinCourier } = await import('./trade');
        const res = await runCoinCourier([account, ...args], mergedEnv);
        return { ok: res.ok, resultLine: `RESULT ${res.ok ? 'ok' : 'fail'} ${res.detail}` };
    }
    if (role === 'coin-fanout') {
        const { coinFanoutMain } = await import('./trade');
        const res = await coinFanoutMain([account, ...args], mergedEnv);
        return { ok: res.ok, resultLine: `RESULT ${res.ok ? 'ok' : 'fail'} fanout completed=${res.results.filter(r => r.ok).length}` };
    }
    if (role === 'item-fanin') {
        const { itemFaninMain } = await import('./trade');
        const res = await itemFaninMain([account, ...args], mergedEnv);
        return { ok: res.ok, resultLine: `RESULT ${res.ok ? 'ok' : 'fail'} fanin banked=${res.banked}` };
    }
    if (role === 'note-courier') {
        const { noteCourierMain } = await import('./trade');
        await noteCourierMain([account, ...args], mergedEnv);
        return { ok: true, resultLine: lastResultLine || 'RESULT ok note-courier' };
    }
    if (role === 'food-courier') {
        const { runFoodCourier } = await import('./trade');
        await runFoodCourier(account, mergedEnv);
        return { ok: true, resultLine: lastResultLine || 'RESULT ok food-courier' };
    }
    if (role === 'food-chain') {
        const { runFoodChain } = await import('./trade');
        await runFoodChain([account, ...args], mergedEnv);
        return { ok: true, resultLine: 'RESULT ok food-chain' };
    }
    if (role === 'specialist-supplier') {
        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            const { runSpecialistServe, runSpecialistStage } = await import('./specialist-supply');
            const stageRaw = account === '--stage' ? [account, ...args] : args.includes('--stage') ? [account, ...args] : null;
            if (stageRaw) {
                await runSpecialistStage(stageRaw, mergedEnv);
            } else {
                await runSpecialistServe([account, ...args], mergedEnv);
            }
            const ok = !process.exitCode || process.exitCode === 0;
            return { ok, resultLine: lastResultLine || `RESULT ${ok ? 'ok' : 'fail'} specialist-supplier` };
        } finally {
            process.exitCode = prevExitCode;
        }
    }
    if (role === 'gathering-supplier') {
        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            const { runGatheringSupplierServe } = await import('./specialist-supply');
            const supplierArgs = account === '--stage' ? [account, ...args] : [account, ...args];
            await runGatheringSupplierServe(supplierArgs, mergedEnv);
            const ok = !process.exitCode || process.exitCode === 0;
            return { ok, resultLine: lastResultLine || `RESULT ${ok ? 'ok' : 'fail'} gathering-supplier` };
        } finally {
            process.exitCode = prevExitCode;
        }
    }
    if (role === 'fleet-trade') {
        const prevExitCode = process.exitCode;
        process.exitCode = 0;
        try {
            const { runFleetTrade } = await import('./trade');
            await runFleetTrade(account, args[0], mergedEnv);
            const ok = process.exitCode !== 2 && process.exitCode !== 1;
            return { ok, resultLine: lastResultLine || `RESULT ${ok ? 'ok' : 'fail'} fleet-trade` };
        } finally {
            process.exitCode = prevExitCode;
        }
    }
    if (role === 'supply-chain') {
        const { runSupplyChain } = await import('./stage');
        const chainCfg = validateSupplyChainCliArgs([account, ...args], mergedEnv);
        const res = await runSupplyChain(chainCfg);
        console.log('SUPPLY_CHAIN ' + JSON.stringify(res));
        return { ok: true, resultLine: `RESULT ok supply-chain cycles=${res.cycles.length}` };
    }

    const { accountOf, getWorld, openBot, settle } = await import('../../../core/src/bot');
    const { waitUntil } = await import('../../../core/src/ticks');
    const { knownBanks } = await import('../../../core/src/trip');
    const { goTo } = await import('../../../core/src/walk');

    if (role === 'supply-bootstrap') {
        try {
            const { bootstrapAccountServer } = await import('./stage');
            const roleArg = (args[0] && !args[0].includes('=') ? args[0] : mergedEnv.ROLE ?? 'producer') as BootstrapRole;
            const phaseArg = (args[1] && !args[1].includes('=') ? args[1] : mergedEnv.PHASE ?? 'all') as BootstrapPhase;
            if (!['producer', 'courier', 'receiver'].includes(roleArg) || !['all', 'clean', 'earn'].includes(phaseArg)) {
                throw Error('supply bootstrap: unknown role/phase');
            }
            bootstrapAccountServer(account);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const settled = await settle([], false, message, { log }).catch(() => false);
            return { ok: false, resultLine: lastResultLine || `RESULT ${settled ? 'ok' : 'fail'} ${message}` };
        }
    }

    const afterLoginAt = Date.now();
    const s = await openBot(account);
    try {
        let ok = false;
        let detail = '';

        switch (role) {
            case 'banker': {
                const { runBanker } = await import('./hub-bank');
                const res = await runBanker(s, { env: mergedEnv, stop: isStopped(account) });
                ok = res.ok;
                detail = res.summary;
                break;
            }
            case 'give-to-banker': {
                const { runGiveToBanker } = await import('./hub-bank');
                const res = await runGiveToBanker(s, args, mergedEnv);
                ok = res.ok;
                detail = res.summary;
                break;
            }
            case 'take-from-banker': {
                const { runTakeFromBanker } = await import('./hub-bank');
                const res = await runTakeFromBanker(s, args, mergedEnv);
                ok = res.ok;
                detail = res.summary;
                break;
            }
            case 'supply-holder': {
                const { runSupplyHolder } = await import('./hub-bank');
                const res = await runSupplyHolder(s, args, mergedEnv);
                ok = res.ok;
                detail = res.summary;
                break;
            }
            case 'wine-stock': {
                const { runPreservedWine } = await import('./hub-bank');
                const maximum = Number(args[0] ?? mergedEnv.MAXIMUM ?? 12);
                const cap = Number(args[1] ?? mergedEnv.CAP ?? 1000);
                const reserve = Number(args[2] ?? mergedEnv.RESERVE ?? 0);
                const r = await runPreservedWine(s, { maximum, cap, reserve }, isStopped(account));
                console.log('WINE_STOCK_RESULT ' + JSON.stringify(r));
                ok = r.ok;
                detail = `preservedWine=${r.noted} grapesUsed=${r.inputs.grapes} waterUsed=${r.inputs.water} assets=${r.assets ? 1 : 0} ticks=${r.ticks} failure=${r.failure}`;
                break;
            }
            case 'supply-bootstrap': {
                const { bootstrapSupplyActor } = await import('./stage');
                const roleArg = (args[0] && !args[0].includes('=') ? args[0] : mergedEnv.ROLE ?? 'producer') as BootstrapRole;
                const phaseArg = (args[1] && !args[1].includes('=') ? args[1] : mergedEnv.PHASE ?? 'all') as BootstrapPhase;
                const r = await bootstrapSupplyActor(s, roleArg, undefined, phaseArg);
                console.log('SUPPLY_BOOTSTRAP ' + JSON.stringify(r));
                ok = true;
                detail = `ordinary zero-resource supply bootstrap ${roleArg} ${phaseArg}`;
                break;
            }
            case 'loadout': {
                const kitPath = args[0] ?? mergedEnv.LOADOUT_FILE;
                if (kitPath) {
                    const { runOwnedLoadoutCured, validateOwnedKit } = await import('./stage');
                    const kit = validateOwnedKit(readJsonArg(kitPath));
                    const r = await runOwnedLoadoutCured(s, kit, isStopped(account));
                    console.log('LOADOUT ' + JSON.stringify(r));
                    ok = r.ok;
                    detail = `loadout ${r.ok ? 'exact' : r.failure} moves=${r.moves} ticks=${r.ticks}${r.cure ? ` cure: ${r.cure.detail}` : ''}`;
                    break;
                }
                if (!mergedEnv.ITEM_ID) throw Error('usage: aio-logistics <account> loadout <kit.json>');
                const itemId = Number(mergedEnv.ITEM_ID);
                const quantity = Math.max(1, Number(mergedEnv.QUANTITY ?? 1));
                const equip = mergedEnv.EQUIP === '1';
                if (!Number.isSafeInteger(itemId) || itemId < 0 || !Number.isSafeInteger(quantity) || quantity < 1) {
                    throw Error(`invalid loadout ITEM_ID=${mergedEnv.ITEM_ID} QUANTITY=${mergedEnv.QUANTITY}`);
                }
                await waitUntil(s, () => !!s.sdk.getState()?.player, { timeoutTicks: 20 });
                const heldCount = () => s.sdk.getInventory().filter(i => i.id === itemId).reduce((sum, i) => sum + i.count, 0);
                const wornCount = () => s.sdk.getEquipment().filter(i => i.id === itemId).reduce((sum, i) => sum + i.count, 0);
                let haveTotal = heldCount() + (equip ? wornCount() : 0);
                if (haveTotal < quantity) {
                    const pos = s.sdk.getState()?.player;
                    if (!pos) throw Error('loadout player state unavailable');
                    const nearestBank = [...knownBanks()]
                        .filter(b => b.level === pos.level)
                        .sort((a, b) => Math.max(Math.abs(a.x - pos.worldX), Math.abs(a.z - pos.worldZ)) - Math.max(Math.abs(b.x - pos.worldX), Math.abs(b.z - pos.worldZ)))[0]
                        ?? HUB_BANKS.varrockWest;
                    const dist = Math.max(Math.abs(pos.worldX - nearestBank.x), Math.abs(pos.worldZ - nearestBank.z));
                    if (dist > 4) {
                        const world = await getWorld();
                        const walked = await goTo(s, world, nearestBank, accountOf(s), { legTimeoutTicks: 120 });
                        if (!walked.ok) throw Error(`loadout bank walk failed: ${walked.reason}`);
                    }
                    const gen = s.bankObservation?.()?.generation ?? 0;
                    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 15 })) {
                        throw Error('loadout bank open failed');
                    }
                    const need = quantity - haveTotal;
                    const { clientStackable, loadoutSpaceRefusal } = await import('./loadout-space');
                    const spaceRefusal = loadoutSpaceRefusal(itemId, need, s.sdk.getInventory(), clientStackable(s.client, itemId));
                    if (spaceRefusal) {
                        await s.bot.closeBank();
                        throw Error(spaceRefusal);
                    }
                    const bankItem = s.sdk.getState()?.bank?.items.find(i => i.id === itemId);
                    if (!bankItem || bankItem.count < need) {
                        await s.bot.closeBank();
                        throw Error(`loadout bank missing itemId=${itemId} need=${need} have=${bankItem?.count ?? 0}`);
                    }
                    const beforeInv = heldCount();
                    const w = await s.bot.withdrawItem(bankItem, need, { asNote: false });
                    if (!w.success || !await waitUntil(s, () => heldCount() >= beforeInv + need, { timeoutTicks: 10 })) {
                        await s.bot.closeBank();
                        throw Error(`loadout withdraw failed itemId=${itemId} need=${need}`);
                    }
                    await s.sdk.sendCloseModal();
                    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
                }
                if (equip && wornCount() < 1) {
                    const invItem = s.sdk.getInventory().find(i => i.id === itemId);
                    if (!invItem) throw Error(`loadout equip missing inv itemId=${itemId}`);
                    const eq = await s.bot.equipItem(invItem);
                    if (!eq.success || !await waitUntil(s, () => wornCount() >= 1, { timeoutTicks: 8 })) {
                        throw Error(`loadout equip failed itemId=${itemId}`);
                    }
                }
                haveTotal = heldCount() + (equip ? wornCount() : 0);
                ok = haveTotal >= quantity && (!equip || wornCount() >= 1);
                detail = `loadout itemId=${itemId} qty=${haveTotal}/${quantity} equip=${equip ? 1 : 0}`;
                break;
            }
            case 'bank-sort': {
                const { sortNativeBank } = await import('./stage');
                const cap = Number(args[0] ?? mergedEnv.CAP ?? 200);
                const maxMoves = Number(args[1] ?? mergedEnv.MAX_MOVES ?? 20);
                const policy = (args[2] ?? mergedEnv.POLICY ?? 'name') as BankSortPolicy;
                const r = await sortNativeBank(s, { cap, maxMoves, policy }, isStopped(account));
                console.log('BANK_SORT ' + JSON.stringify(r));
                ok = r.preserved;
                detail = `bank-sort ${r.preserved ? 'ok' : 'not-preserved'} moves=${r.moves} ticks=${r.ticks}`;
                break;
            }
            case 'walk-to': {
                const { runWalkTo } = await import('./walk');
                // A stage walk takes its pack kit from the nearest bank before it walks.
                const { parseStageKeep, parseStageKit, stagePvpKitAndRestorePrayer, withdrawStageKit } = await import('./stage-kit');
                const stageKit = parseStageKit(mergedEnv.STAGE_KIT);
                const stageKeep = parseStageKeep(mergedEnv.STAGE_KEEP);
                if (mergedEnv.STAGE_RESTORE_PRAYER === '1') {
                    const staged = await stagePvpKitAndRestorePrayer(s, stageKit, stageKeep);
                    if (!staged.ok) {
                        ok = false;
                        detail = staged.detail;
                        break;
                    }
                } else {
                    await withdrawStageKit(s, stageKit, stageKeep);
                }
                const r = await runWalkTo(s, args);
                ok = r.ok;
                detail = r.summary;
                break;
            }
            case 'walk-edge': {
                const { runWalkEdge } = await import('./walk');
                const r = await runWalkEdge(s);
                const settled = await settle([s], r.ok, r.ok ? 'at Edgeville bank' : r.detail, { log });
                console.log('WALK_EDGE ' + JSON.stringify({ ...r, loggedOut: settled }));
                return { ok: settled, resultLine: lastResultLine || `RESULT ${settled ? 'ok' : 'fail'} ${r.detail}` };
            }
            case 'relocate-bank': {
                const { relocateBank } = await import('./walk');
                const cap = Number(mergedEnv.CAP ?? args[0] ?? 1500);
                const startTick = s.tick();
                const r = await relocateBank(s, { stop: () => isStopped(account)() || s.tick() - startTick >= cap });
                console.log('RELOCATE_BANK ' + JSON.stringify(r));
                ok = r.ok;
                detail = `relocate-bank ${r.profile} ticks=${r.ticks} preserved=${r.preserved} xpPreserved=${r.xpPreserved} died=${r.died} failure=${r.failure}`;
                break;
            }
            case 'relocate-knight': {
                const { relocateKnight } = await import('./walk');
                const cap = Number(mergedEnv.CAP ?? args[0] ?? 1500);
                const startTick = s.tick();
                const r = await relocateKnight(s, account, { stop: () => isStopped(account)() || s.tick() - startTick >= cap });
                console.log('RELOCATE_KNIGHT ' + JSON.stringify(r));
                ok = r.ok;
                detail = `relocate-knight ${r.profile} ticks=${r.ticks} preserved=${r.preserved} xpPreserved=${r.xpPreserved} died=${r.died} failure=${r.failure}`;
                break;
            }
            case 'arrive-draynor': {
                const { runArriveDraynor } = await import('./walk');
                const r = await runArriveDraynor(s);
                ok = r.ok;
                detail = r.detail;
                break;
            }
            case 'restore-prayer': {
                const { nearestAltar, prayAtAltar } = await import('./recover');
                await waitUntil(s, () => !!s.sdk.getState()?.player, { timeoutTicks: 20 });
                const spec = altarText(args, mergedEnv.ALTAR);
                const p = s.sdk.getState()?.player;
                const altar = parseAltar(spec) ?? nearestAltar(p ? { x: p.worldX, z: p.worldZ, level: p.level } : { x: 3243, z: 3205, level: 0 });
                const r = await prayAtAltar(s, altar);
                ok = r.ok;
                detail = `pray-at-altar ${r.detail}`;
                break;
            }
            case 'cure-poison': {
                const { cureWithAntipoison } = await import('./recover');
                await waitUntil(s, () => !!s.sdk.getState()?.player, { timeoutTicks: 20 });
                const r = await cureWithAntipoison(s);
                ok = r.ok;
                detail = `cure-poison ${r.detail}`;
                break;
            }
            case 'charge-glory': {
                const { runChargeGlory } = await import('./recover');
                const cap = Number(args.find(a => /^\d+$/.test(a)) ?? mergedEnv.CAP ?? 2000);
                const maxGlories = Number(mergedEnv.MAX_GLORIES ?? 0);
                const r = await runChargeGlory(s, { cap, maxGlories, stop: isStopped(account) });
                ok = r.ok;
                detail = `charge-glory charged=${r.charged} bankGlory4=${r.bankGlory4} ticks=${r.ticks}`;
                break;
            }
            case 'recover-trapped': {
                const { recoverSessionToHub } = await import('./recover');
                const capTicks = Number(args.find(a => /^\d+$/.test(a)) ?? mergedEnv.CAP ?? 900);
                const target = parseRecoveryTargetArg(args);
                await waitUntil(s, () => !!s.sdk.getState()?.player, { timeoutTicks: 20 });
                const r = await recoverSessionToHub(s, { capTicks, target, stop: isStopped(account) });
                console.log('RECOVER_TRAPPED ' + JSON.stringify(r));
                ok = r.ok;
                detail = `recover-trapped kind=${r.kind} from=${r.from} to=${r.to} ${r.detail}`;
                break;
            }
            case 'inspect': {
                const { inspectFleetState } = await import('./inspect');
                const requireBank = mergedEnv.REQUIRE_BANK === '1' || args.includes('--require-bank');
                const observed = await inspectFleetState(s, { requireBank, afterLoginAt, stopped: isStopped(account) });
                ok = true;
                detail = observed
                    ? `inspection bankObserved=1 bankGeneration=${observed.generation} bankObservedAt=${observed.at} bankItems=${observed.items.length}`
                    : 'inspection bankObserved=0';
                break;
            }
            default: {
                throw Error(`unhandled logistics role: ${role}`);
            }
        }

        const settled = await settle([s], ok, detail, { log });
        const resultLine = lastResultLine || `RESULT ${settled ? 'ok' : 'fail'} ${detail}`;
        if (!opts.captureLog && !settled) process.exitCode = 1;
        return { ok: settled, resultLine };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const settled = await settle([s], false, message, { log }).catch(() => false);
        return { ok: false, resultLine: lastResultLine || `RESULT ${settled ? 'ok' : 'fail'} ${message}` };
    }
}

export async function runLogisticsWorkerSession(sessionCore: SessionCore, cfg: LogisticsConfig): Promise<RunOutcome> {
    const { sessionDied } = await import('../../../core/src/bot');
    const role = cfg.role ?? defaultRoleForOperation(cfg.operation);
    const activityId = `logistics:${role}`;
    const s = sessionCore as unknown as Session;
    const startTick = s.tick();
    const initialLife = s.sdk.getState()?.player;
    const args = [...(cfg.args ?? [])];
    const env = { ...(cfg.env ?? {}) };
    const { isStopped: watchStopped } = watchWorkerStop(sessionCore, cfg.stop);
    await Promise.resolve();
    const fileStopped = stopChecker(sessionCore.name);
    const died = () => sessionDied(initialLife, s.sdk.getState()?.player);
    const stopSignal = () => watchStopped() || fileStopped() || (cfg.capTicks !== undefined && s.tick() - startTick >= cfg.capTicks);
    const isStopped = () => died() || stopSignal();
    const settleFailure = (fallback: () => RunOutcome, detail?: string): RunOutcome => {
        const ticksElapsed = Math.max(0, s.tick() - startTick);
        if (died()) {
            return {
                kind: 'death',
                activityId,
                account: sessionCore.name,
                ticksElapsed,
                pos: playerTileOrNull(s) ?? { x: 3222, z: 3218, level: 0 },
                ...(detail ? { detail } : {}),
            };
        }
        if (stopSignal()) {
            return {
                kind: 'session_unsettled',
                activityId,
                account: sessionCore.name,
                ticksElapsed,
                reason: 'stop requested during execution',
                ...(detail ? { detail } : {}),
            };
        }
        return fallback();
    };
    if (died()) {
        return { kind: 'death', activityId, account: sessionCore.name, ticksElapsed: 0, pos: playerTileOrNull(s) ?? { x: 3222, z: 3218, level: 0 } };
    }
    if (stopSignal()) {
        return { kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed: 0, reason: 'stop requested before start' };
    }

    try {
        switch (cfg.operation) {
            case 'inspect': {
                const { inspectFleetState } = await import('./inspect');
                await inspectFleetState(s, {
                    requireBank: env.REQUIRE_BANK === '1' || args.includes('--require-bank'),
                    stopped: isStopped,
                });
                return settleFailure(() => ({
                    kind: 'target_met',
                    activityId,
                    account: sessionCore.name,
                    ticksElapsed: Math.max(0, s.tick() - startTick),
                    unitsCompleted: 1,
                }));
            }
            case 'recover': {
                if (role === 'restore-prayer') {
                    const { nearestAltar, prayAtAltar } = await import('./recover');
                    const spec = cfg.altar ? `${cfg.altar.x},${cfg.altar.z}` : altarText(args, env.ALTAR);
                    const p = s.sdk.getState()?.player;
                    const altar = parseAltar(spec) ?? nearestAltar(p ? { x: p.worldX, z: p.worldZ, level: p.level } : { x: 3243, z: 3205, level: 0 });
                    const r = await prayAtAltar(s, altar);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return r.ok
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: r.detail }
                        : settleFailure(() => ({ kind: 'location_stranded', activityId, account: sessionCore.name, ticksElapsed, pos: playerTileOrNull(s) ?? { x: altar.x, z: altar.z, level: altar.level }, detail: r.detail }), r.detail);
                }
                if (role === 'cure-poison') {
                    const { cureWithAntipoison } = await import('./recover');
                    const r = await cureWithAntipoison(s);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    if (r.ok) return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: r.detail };
                    if (/no antipoison/i.test(r.detail)) {
                        return settleFailure(() => ({ kind: 'missing_supply', activityId, account: sessionCore.name, ticksElapsed, missing: [{ itemId: 175, itemName: 'Antipoison', required: 1, available: 0 }] }), r.detail);
                    }
                    return settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: r.detail }), r.detail);
                }
                if (role === 'charge-glory') {
                    const { runChargeGlory } = await import('./recover');
                    const r = await runChargeGlory(s, { cap: cfg.capTicks ?? 2000, maxGlories: cfg.count ?? 0, stop: isStopped });
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return r.ok
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: r.charged }
                        : settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: 'charge-glory stopped before completion' }));
                }
                const { recoverSessionToHub } = await import('./recover');
                const target = cfg.target ?? parseRecoveryTargetArg(args);
                const r = await recoverSessionToHub(s, { capTicks: cfg.capTicks ?? 900, target, stop: isStopped });
                const ticksElapsed = Math.max(0, s.tick() - startTick);
                if (r.ok) return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: r.detail };
                return settleFailure(() => ({
                    kind: 'location_stranded',
                    activityId,
                    account: sessionCore.name,
                    ticksElapsed,
                    pos: playerTileOrNull(s) ?? (target ?? HUB_BANKS.varrockWest),
                    detail: r.detail,
                }), r.detail);
            }
            case 'walk': {
                const target = cfg.target;
                let ok = false;
                let summary = '';
                if (role === 'walk-edge') {
                    const { runWalkEdge } = await import('./walk');
                    const r = await runWalkEdge(s);
                    ok = r.ok;
                    summary = r.detail;
                } else if (role === 'relocate-bank') {
                    const { relocateBank } = await import('./walk');
                    const r = await relocateBank(s, { stop: isStopped });
                    ok = r.ok;
                    summary = r.failure;
                } else if (role === 'relocate-knight') {
                    const { relocateKnight } = await import('./walk');
                    const r = await relocateKnight(s, sessionCore.name, { stop: isStopped });
                    ok = r.ok;
                    summary = r.failure;
                } else if (role === 'arrive-draynor') {
                    const { runArriveDraynor } = await import('./walk');
                    const r = await runArriveDraynor(s);
                    ok = r.ok;
                    summary = r.detail;
                } else {
                    const { runWalkTo } = await import('./walk');
                    const walkArgs = target ? [String(target.x), String(target.z), String(target.level), ...args] : args;
                    const r = await runWalkTo(s, walkArgs);
                    ok = r.ok;
                    summary = r.summary;
                }
                const ticksElapsed = Math.max(0, s.tick() - startTick);
                if (ok) return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary };
                return settleFailure(() => ({
                    kind: 'location_stranded',
                    activityId,
                    account: sessionCore.name,
                    ticksElapsed,
                    pos: playerTileOrNull(s) ?? (target ?? DEFAULT_HEROES_COORDS),
                    detail: summary || 'walk failed',
                }), summary || 'walk failed');
            }
            case 'hub_bank': {
                if (role === 'wine-stock') {
                    const { runPreservedWine } = await import('./hub-bank');
                    const maximum = cfg.targetBatches ?? Number(args[0] ?? 12);
                    const cap = cfg.capTicks ?? Number(args[1] ?? 1000);
                    const reserve = cfg.reserveBatches ?? Number(args[2] ?? 0);
                    const r = await runPreservedWine(s, { maximum, cap, reserve }, isStopped);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    if (r.ok) return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: r.noted };
                    if (/short of order/i.test(r.failure)) {
                        return settleFailure(() => ({ kind: 'missing_supply', activityId, account: sessionCore.name, ticksElapsed, missing: r.short.map(i => ({ itemId: i.id, itemName: i.id === JUG_WATER_ID ? 'Jug of water' : 'Grapes', required: maximum + reserve, available: i.count })) }), r.failure);
                    }
                    return settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: r.failure }), r.failure);
                }
                if (role === 'give-to-banker') {
                    const { runGiveToBanker } = await import('./hub-bank');
                    const gArgs = cfg.partner ? [cfg.partner, ...args] : args;
                    const res = await runGiveToBanker(s, gArgs, env);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return res.ok
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: res.summary }
                        : settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: res.summary }), res.summary);
                }
                if (role === 'take-from-banker') {
                    const { runTakeFromBanker } = await import('./hub-bank');
                    const res = await runTakeFromBanker(s, args, env, cfg.rootDir ?? REPO_ROOT);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return res.ok
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: res.summary }
                        : settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: res.summary }), res.summary);
                }
                if (role === 'supply-holder') {
                    const { runSupplyHolder } = await import('./hub-bank');
                    const res = await runSupplyHolder(s, args, env);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return res.ok
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: 1, summary: res.summary }
                        : settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: res.summary }), res.summary);
                }
                const { runBanker } = await import('./hub-bank');
                const res = await runBanker(s, { env, stop: isStopped, rootDir: cfg.rootDir });
                const ticksElapsed = Math.max(0, s.tick() - startTick);
                return res.ok
                    ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: res.trades, summary: res.summary }
                    : settleFailure(() => ({ kind: 'location_stranded', activityId, account: sessionCore.name, ticksElapsed, pos: playerTileOrNull(s) ?? HUB_BANKS.ardougneNorth, detail: res.summary }), res.summary);
            }
            case 'stage': {
                if (role === 'loadout-import') {
                    const source = cfg.setupFile ?? args[0];
                    const bindings = cfg.bindingsFile ?? args[1];
                    if (!source || !bindings) {
                        return { kind: 'worker_defect', activityId, account: sessionCore.name, ticksElapsed: 0, faultSignature: 'invalid_loadout_import_args' };
                    }
                    importAioLoadout([source, bindings]);
                    return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: Math.max(0, s.tick() - startTick), unitsCompleted: 1 };
                }
                if (role === 'bank-sort') {
                    const { sortNativeBank } = await import('./stage');
                    const cap = cfg.capTicks ?? Number(args[0] ?? 200);
                    const maxMoves = cfg.count ?? Number(args[1] ?? 20);
                    const policy = (args[2] ?? 'name') as BankSortPolicy;
                    const r = await sortNativeBank(s, { cap, maxMoves, policy }, isStopped);
                    const ticksElapsed = Math.max(0, s.tick() - startTick);
                    return r.preserved
                        ? { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: r.moves }
                        : settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason: 'bank-sort assets not preserved' }));
                }
                if (role === 'supply-bootstrap') {
                    const { bootstrapSupplyActor } = await import('./stage');
                    const bootRole = (args[0] ?? env.ROLE ?? 'producer') as BootstrapRole;
                    const phase = (args[1] ?? env.PHASE ?? 'all') as BootstrapPhase;
                    await bootstrapSupplyActor(s, bootRole, undefined, phase);
                    return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed: Math.max(0, s.tick() - startTick), unitsCompleted: 1 };
                }
                if (role === 'supply-chain') {
                    return {
                        kind: 'worker_defect',
                        activityId,
                        account: sessionCore.name,
                        ticksElapsed: 0,
                        faultSignature: 'logistics:supply-chain:requires_cli_orchestrator',
                        detail: 'multi-account supply-chain must run via runLogisticsRole / scripts/aio-logistics.ts',
                    };
                }
                const kitPath = cfg.setupFile ?? args[0];
                if (!kitPath) {
                    return { kind: 'worker_defect', activityId, account: sessionCore.name, ticksElapsed: 0, faultSignature: 'missing_loadout_setup_file' };
                }
                const { runOwnedLoadoutCured, validateOwnedKit } = await import('./stage');
                const kit = validateOwnedKit(readJsonArg(kitPath));
                const r = await runOwnedLoadoutCured(s, kit, isStopped);
                const ticksElapsed = Math.max(0, s.tick() - startTick);
                if (r.ok) return { kind: 'target_met', activityId, account: sessionCore.name, ticksElapsed, unitsCompleted: r.moves };
                // A poisoned account with no antipoison anywhere needs one bought, not another try (as cure-poison above).
                if (r.cure && !r.cure.ok && /no antipoison/i.test(r.cure.detail)) {
                    return settleFailure(() => ({ kind: 'missing_supply', activityId, account: sessionCore.name, ticksElapsed, missing: [{ itemId: 175, itemName: 'Antipoison', required: 1, available: 0 }] }), r.cure.detail);
                }
                const reason = r.cure ? `${r.failure}; cure: ${r.cure.detail}` : r.failure;
                return settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed, reason }), reason);
            }
            case 'trade': {
                return {
                    kind: 'worker_defect',
                    activityId,
                    account: sessionCore.name,
                    ticksElapsed: 0,
                    faultSignature: `logistics:${role}:requires_cli_orchestrator`,
                    detail: `multi-account/CLI logistics trade role ${role} must run via runLogisticsRole / scripts/aio-logistics.ts`,
                };
            }
        }
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return settleFailure(() => ({ kind: 'session_unsettled', activityId, account: sessionCore.name, ticksElapsed: Math.max(0, s.tick() - startTick), reason }), reason);
    }
}

export const logisticsWorker: WorkerModule<LogisticsConfig> = {
    id: 'logistics',
    family: 'logistics',
    kind: 'recover',
    trust: 'practice_passed',
    protectedAllowed: false,
    preflight(acct, cfg, world) {
        return checkLogisticsPreflight(acct, cfg, world);
    },
    estimate(acct, cfg, world) {
        return estimateLogistics(acct, cfg, world);
    },
    run(session, cfg) {
        return runLogisticsWorkerSession(session, cfg);
    },
};

export type { Outcome };
