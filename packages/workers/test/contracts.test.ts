import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Session } from '../../core/src/inprocess';
import type { SessionCore } from '../../core/src/session-types';
import {
    OUTCOME_KINDS,
    PREFLIGHT_BLOCKER_KINDS,
    TRUST_TIERS,
    WORKER_FAMILIES,
    WORKER_KINDS,
    accountEscrowCoins,
    accountOwnedItemCount,
    accountReserveFor,
    availableCoinsAfterReserves,
    createWorkerRegistry,
    effectiveTicksForBatch,
    isOutcomeKind,
    isPreflightBlocker,
    isPreflightResult,
    isRateEstimate,
    isRunOutcome,
    isTrustTier,
    isWorkerFamily,
    isWorkerKind,
    isWorkerModule,
    preflightFail,
    preflightOk,
    reserveAdjustedStock,
    trustMeetsMinimum,
    validatePreflightResult,
    validateRateEstimate,
    validateRunOutcome,
    type RateEstimate,
    type RunOutcome,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../src';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

function walkTs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const full = join(d, entry.name);
            if (entry.isDirectory()) visit(full);
            else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
                out.push(relative(repoRoot, full).replaceAll('\\', '/'));
            }
        }
    };
    visit(dir);
    return out.sort();
}

function resolveImportTarget(fromAbs: string, spec: string): string {
    const target = relative(repoRoot, resolve(dirname(fromAbs), spec)).replaceAll('\\', '/');
    if (target.endsWith('.ts')) return target;
    if (existsSync(join(repoRoot, `${target}.ts`))) return `${target}.ts`;
    if (existsSync(join(repoRoot, target, 'index.ts'))) return `${target}/index.ts`;
    return `${target}.ts`;
}

function tarjanSccs(files: readonly string[]): string[][] {
    const graph = new Map<string, string[]>();
    for (const rel of files) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        const deps: string[] = [];
        for (const imp of info.importedFiles) {
            if (!imp.fileName.startsWith('.')) continue;
            deps.push(resolveImportTarget(abs, imp.fileName));
        }
        graph.set(rel, deps);
    }
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let idx = 0;

    function strong(v: string) {
        index.set(v, idx);
        low.set(v, idx);
        idx++;
        stack.push(v);
        onStack.add(v);
        for (const w of graph.get(v) ?? []) {
            if (!graph.has(w)) continue;
            if (!index.has(w)) {
                strong(w);
                low.set(v, Math.min(low.get(v)!, low.get(w)!));
            } else if (onStack.has(w)) {
                low.set(v, Math.min(low.get(v)!, index.get(w)!));
            }
        }
        if (low.get(v) === index.get(v)) {
            const comp: string[] = [];
            while (true) {
                const w = stack.pop()!;
                onStack.delete(w);
                comp.push(w);
                if (w === v) break;
            }
            if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) sccs.push(comp.sort());
        }
    }

    for (const v of graph.keys()) if (!index.has(v)) strong(v);
    return sccs;
}

const sampleAccount = (overrides: Partial<WorkerAccountView> = {}): WorkerAccountView => ({
    name: 'Packhorse',
    side: 'local',
    protectedClock: false,
    skills: { Fishing: { level: 76, xp: 1_350_000 } },
    quests: { cook: 'complete' },
    pos: { x: 3185, z: 3436, level: 0 },
    inventory: { 995: 5000, 311: 1 },
    equipment: {},
    bank: { items: { 383: 40, 995: 20_000 }, observedAt: 1_700_000_000_000, trusted: true },
    ...overrides,
});

const sampleWorld = (acct: WorkerAccountView): WorkerWorldView => ({
    at: 1_700_000_001_000,
    side: 'local',
    server: 'rs-sdk-demo.fly.dev',
    accounts: { [acct.name.toLowerCase()]: acct },
    reserves: { [acct.name.toLowerCase()]: { 995: 1000 } },
    geEscrowCoins: { [acct.name.toLowerCase()]: 2500 },
});

test('closed worker vocabularies match Section 3.2 and 4 specifications', () => {
    expect(WORKER_FAMILIES).toEqual([
        'gather',
        'bank-artisan',
        'combat',
        'agility',
        'runecraft',
        'quest',
        'market',
        'logistics',
        'pvp',
    ]);
    expect(TRUST_TIERS).toEqual(['experimental', 'practice_passed', 'live_proven']);
    expect(WORKER_KINDS).toEqual(['train', 'gather', 'produce', 'quest', 'shop', 'ge_buy', 'pk', 'recover']);
    expect(OUTCOME_KINDS).toEqual([
        'target_met',
        'missing_supply',
        'location_stranded',
        'market_unavailable',
        'session_unsettled',
        'infra_fault',
        'worker_defect',
        'death',
    ]);
    expect(PREFLIGHT_BLOCKER_KINDS.length).toBe(11);

    expect(isWorkerFamily('bank-artisan')).toBe(true);
    expect(isWorkerFamily('unknown')).toBe(false);
    expect(isTrustTier('practice_passed')).toBe(true);
    expect(isTrustTier('verified')).toBe(false);
    expect(isWorkerKind('ge_buy')).toBe(true);
    expect(isWorkerKind('idle')).toBe(false);
    expect(isOutcomeKind('infra_fault')).toBe(true);
    expect(isOutcomeKind('timeout')).toBe(false);

    expect(trustMeetsMinimum('experimental', 'experimental')).toBe(true);
    expect(trustMeetsMinimum('experimental', 'practice_passed')).toBe(false);
    expect(trustMeetsMinimum('practice_passed', 'practice_passed')).toBe(true);
    expect(trustMeetsMinimum('live_proven', 'practice_passed')).toBe(true);
});

test('preflight helpers enforce blocker consistency and reserve math', () => {
    const ok = preflightOk({ travelCoins: 30, travelTicks: 40 });
    expect(isPreflightResult(ok)).toBe(true);

    const fail = preflightFail([
        { kind: 'skill_level', skill: 'Fishing', required: 76, current: 62 },
        { kind: 'quest_incomplete', quest: 'hero', requiredState: 'complete', currentState: 'not_started' },
        { kind: 'missing_supply', itemId: 311, itemName: 'Harpoon', required: 1, available: 0, reserved: 0 },
        { kind: 'missing_coins', required: 1500, available: 500, reserved: 1000, escrow: 200, ferryFare: 30 },
        { kind: 'unreachable_tile', target: { x: 2809, z: 3441, level: 0 }, from: null, reason: 'unknown_pos' },
        { kind: 'combat_survivability', reason: 'food', required: 20, current: 4 },
        { kind: 'max_level_cap', skill: 'Defence', maxLevel: 1, current: 1 },
        { kind: 'protected_clock' },
        { kind: 'cooldown_active', key: '385:ge', expiresAt: 1_700_000_060_000 },
        { kind: 'capacity_full', spotId: 'ardougne-knights', active: 3, limit: 3 },
        { kind: 'invalid_config', message: 'spot missing' },
    ]);
    expect(isPreflightResult(fail)).toBe(true);
    for (const blocker of fail.blockers) expect(isPreflightBlocker(blocker)).toBe(true);

    expect(() => preflightFail([])).toThrow();
    expect(validatePreflightResult({ ok: true, blockers: [{ kind: 'protected_clock' }] }).length).toBeGreaterThan(0);
    expect(validatePreflightResult({ ok: false, blockers: [] }).length).toBeGreaterThan(0);

    expect(reserveAdjustedStock(100, 35)).toBe(65);
    expect(reserveAdjustedStock(10, 25)).toBe(0);
    expect(availableCoinsAfterReserves(25_000, 1000, 2500, 1000)).toBe(20_500);
    expect(availableCoinsAfterReserves(1500, 1000, 1000, 1000)).toBe(0);

    const trustedAcct = sampleAccount();
    expect(accountOwnedItemCount(trustedAcct, 995)).toBe(25_000);
    const untrustedAcct = sampleAccount({
        bank: { items: { 995: 20_000 }, observedAt: 0, trusted: false },
    });
    expect(accountOwnedItemCount(untrustedAcct, 995)).toBe(5000);
    expect(accountOwnedItemCount(untrustedAcct, 995, { requireTrustedBank: false })).toBe(25_000);

    const mixedCaseAcct = sampleAccount({ name: 'PackHorse', reserves: { 995: 800, 385: 5 } });
    const reserveWorld: WorkerWorldView = {
        ...sampleWorld(mixedCaseAcct),
        reserves: { packhorse: { 995: 1200, 385: 2 } },
        globalReserves: { 995: 500, 385: 3 },
        geEscrowCoins: { packhorse: 3400 },
    };
    expect(accountReserveFor(mixedCaseAcct, reserveWorld, 995)).toBe(1700);
    expect(accountReserveFor(mixedCaseAcct, reserveWorld, 385)).toBe(8);
    expect(accountEscrowCoins(mixedCaseAcct, reserveWorld)).toBe(3400);
});

test('RateEstimate validates setupTicks, minBatchUnits, riskPerHour, and batch ticks', () => {
    const est: RateEstimate = {
        xpPerTick: 18.5,
        skillXpPerTick: { Cooking: 18.5 },
        unitsPerTick: 0.25,
        gpPerTick: -12,
        setupTicks: 32,
        minBatchUnits: 100,
        riskPerHour: 0.01,
        confidence: 'practice',
        inputsPerUnit: { 383: 1 },
        outputsPerUnit: { 385: 1 },
    };
    expect(isRateEstimate(est)).toBe(true);
    expect(effectiveTicksForBatch(est, 100)).toBe(432);

    expect(validateRateEstimate({ ...est, minBatchUnits: 0 }).length).toBeGreaterThan(0);
    expect(validateRateEstimate({ ...est, setupTicks: -1 }).length).toBeGreaterThan(0);
    expect(validateRateEstimate({ ...est, riskPerHour: 1.5 }).length).toBeGreaterThan(0);
    expect(validateRateEstimate({ ...est, xpPerTick: Number.NaN }).length).toBeGreaterThan(0);
});

test('RunOutcome discriminated union validates all 8 outcome kinds', () => {
    const base = { activityId: 'gather:fish-shark', account: 'LochNessRod', ticksElapsed: 600 };
    const outcomes: RunOutcome[] = [
        { ...base, kind: 'target_met', unitsCompleted: 120, xpGained: { Fishing: 13_200 }, itemsDelta: { 383: 120 } },
        { ...base, kind: 'missing_supply', missing: [{ itemId: 311, required: 1, available: 0, itemName: 'Harpoon' }] },
        { ...base, kind: 'location_stranded', pos: { x: 2683, z: 3268, level: 1 }, detail: 'stuck on gangplank deck' },
        { ...base, kind: 'market_unavailable', itemId: 385, venue: 'ge', cooldownMs: 120_000 },
        { ...base, kind: 'session_unsettled', reason: 'logout timeout' },
        { ...base, kind: 'infra_fault', source: 'claim_authority', retryAfterMs: 30_000 },
        {
            ...base,
            kind: 'worker_defect',
            faultSignature: 'stalled:no_fish_spot_900',
            logPath: '.practice/live/logs/fish.log',
            tickRecordPath: '.practice/live/ticks/fish.jsonl',
        },
        { ...base, kind: 'death', pos: { x: 3222, z: 3218, level: 0 }, logPath: '.practice/live/logs/death.log' },
    ];
    for (const outcome of outcomes) {
        expect(isRunOutcome(outcome)).toBe(true);
    }

    expect(validateRunOutcome({ ...base, kind: 'missing_supply', missing: [] }).length).toBeGreaterThan(0);
    expect(validateRunOutcome({ ...base, kind: 'market_unavailable', itemId: 385, venue: '' }).length).toBeGreaterThan(0);
    expect(validateRunOutcome({ ...base, kind: 'worker_defect', faultSignature: '' }).length).toBeGreaterThan(0);
    expect(validateRunOutcome({ ...base, kind: 'infra_fault', source: 'bad_source' }).length).toBeGreaterThan(0);
});

test('WorkerModule binds cleanly to SessionCore/Session and registers in WorkerRegistry', async () => {
    type HarpoonCfg = { minSharks: number };
    const fishModule: WorkerModule<HarpoonCfg> = {
        id: 'gather:fishing-harpoon',
        family: 'gather',
        kind: 'gather',
        trust: 'practice_passed',
        protectedAllowed: false,
        preflight(acct, cfg, world) {
            const level = acct.skills.Fishing?.level ?? 1;
            if (level < 76) {
                return preflightFail([{ kind: 'skill_level', skill: 'Fishing', required: 76, current: level }]);
            }
            const coins = accountOwnedItemCount(acct, 995);
            const reserve = world.reserves?.[acct.name.toLowerCase()]?.[995] ?? 0;
            const escrow = world.geEscrowCoins?.[acct.name.toLowerCase()] ?? 0;
            if (availableCoinsAfterReserves(coins, reserve, escrow, 1000) < 0 || cfg.minSharks <= 0) {
                return preflightFail([{ kind: 'invalid_config', message: 'invalid shark target' }]);
            }
            return preflightOk();
        },
        estimate() {
            return {
                xpPerTick: 11,
                unitsPerTick: 0.1,
                gpPerTick: 50,
                setupTicks: 40,
                minBatchUnits: 28,
                confidence: 'practice',
            };
        },
        async run(session: SessionCore, cfg: HarpoonCfg): Promise<RunOutcome> {
            return {
                kind: 'target_met',
                activityId: 'gather:fishing-harpoon',
                account: session.name,
                ticksElapsed: 280,
                unitsCompleted: cfg.minSharks,
            };
        },
    };

    // Compile-time structural check: core Session satisfies SessionCore for WorkerModule.run.
    const _sessionCheck = async (sess: Session) => fishModule.run(sess, { minSharks: 28 });
    expect(typeof _sessionCheck).toBe('function');

    expect(isWorkerModule(fishModule)).toBe(true);
    const acct = sampleAccount();
    const world = sampleWorld(acct);
    expect(fishModule.preflight(acct, { minSharks: 28 }, world).ok).toBe(true);
    expect(fishModule.estimate(acct, { minSharks: 28 }, world).minBatchUnits).toBe(28);

    const fakeSession: SessionCore = {
        name: 'Packhorse',
        sdk: {} as SessionCore['sdk'],
        bot: {} as SessionCore['bot'],
        tick: () => 280,
        onTick: () => () => {},
        direct: async () => ({}),
        close: async () => {},
        ended: Promise.resolve({ reason: 'done' }),
    };
    const out = await fishModule.run(fakeSession, { minSharks: 28 });
    expect(out.kind).toBe('target_met');

    const registry = createWorkerRegistry([fishModule]);
    expect(registry.size()).toBe(1);
    expect(registry.has('gather:fishing-harpoon')).toBe(true);
    expect(registry.get('gather:fishing-harpoon')?.family).toBe('gather');
    expect(registry.list({ minTrust: 'practice_passed' }).length).toBe(1);
    expect(registry.list({ minTrust: 'live_proven' }).length).toBe(0);
    expect(() => registry.register(fishModule)).toThrow('Duplicate WorkerModule id');
    expect(() => registry.require('missing')).toThrow('Unknown WorkerModule');
});

test('packages/workers/src obeys acyclic DAG and relative-only import boundaries', () => {
    const workerFiles = walkTs(join(repoRoot, 'packages', 'workers', 'src'));
    expect(workerFiles.length).toBeGreaterThanOrEqual(2);
    const bannedRoots = [
        'packages/brain/',
        'packages/fleet/',
        'packages/practice/',
        'packages/planner/',
        'packages/router/',
        'packages/dashboard/',
        'scripts/',
    ];
    const violations: string[] = [];

    for (const rel of workerFiles) {
        const abs = join(repoRoot, rel);
        const info = ts.preProcessFile(readFileSync(abs, 'utf8'), true, true);
        for (const imp of info.importedFiles) {
            const spec = imp.fileName;
            if (spec.startsWith('@rsbot/')) {
                violations.push(`${rel} -> workspace import forbidden: ${spec}`);
                continue;
            }
            if (!spec.startsWith('.')) continue;
            const target = resolveImportTarget(abs, spec);
            if (bannedRoots.some((r) => target.startsWith(r))) {
                violations.push(`${rel} -> ${target}`);
            }
        }
    }
    expect(violations).toEqual([]);

    const dagFiles = [
        ...walkTs(join(repoRoot, 'packages', 'knowledge', 'src')),
        ...walkTs(join(repoRoot, 'packages', 'core', 'src')),
        ...workerFiles,
    ];
    expect(tarjanSccs(dagFiles)).toEqual([]);
});
