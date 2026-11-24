// FleetScheduler: allocates global maxBots slots, shared-spot capacity, and safe hub-banker TransferOrders
// across one unified FleetPlan, enforcing unblock priority order, +15% retention hysteresis,
// anti-ping-pong rules, protectedClock isolation, and versioned FleetState (schemaVersion: 1) output.
import type { LogoutProof } from '../../core/src/session-lifecycle';
import type { TrustTier } from '../../workers/src/contracts';
import {
    DEFAULT_RETENTION_MARGIN_RATIO,
    FLEET_STATE_SCHEMA_VERSION,
    HUB_BANKER_LOCATIONS,
    RECOVERY_PRIORITY_ORDER,
    accountFrozenValue,
    canScheduleTransferOrder,
    compareRecoveryPriority,
    isProtectedAccountName,
    marketCooldownKey,
    type AccountPlan,
    type AccountState,
    type AcquireSourceKind,
    type ActivityDefinition,
    type AcquireStep,
    type Campaign,
    type DefectRecord,
    type FleetPlan,
    type FleetState,
    type GearUpgradePlannedStep,
    type GoalDemand,
    type HubBankId,
    type InfraCircuitBreakerState,
    type Mission,
    type RateSummary,
    type RecoveryQueueEntry,
    type TargetWorkPlannedStep,
    type TransferOrder,
    type WorldSnapshot,
} from './contracts';
import { DEFAULT_ANTI_PING_PONG_MS, type MarketQuotesMap } from './acquire';
import {
    buildPlannerSharedIndex,
    canProtectedAccountLaunch,
    createAccountPlannerReuse,
    planAccount,
    planAccountWithCandidates,
    type AccountPlannerReuse,
    type RateEstimator,
    type RateStoreLike,
} from './planner';
import { loadItemsMap } from './preflight';

export interface FleetSchedulerInput {
    readonly world: WorldSnapshot;
    readonly activities: readonly ActivityDefinition[];
    readonly demands: readonly GoalDemand[];
    readonly campaigns?: readonly Campaign[];
    readonly missions?: readonly Mission[];
    readonly defects?: readonly DefectRecord[];
    readonly maxBots?: number;
    readonly ignoreSideStop?: boolean;
    readonly retentionMarginRatio?: number;
    readonly rateEstimator?: RateEstimator;
    readonly rateStore?: RateStoreLike;
    readonly rateStats?: Readonly<Record<string, RateSummary>>;
    readonly infraCircuitBreaker?: InfraCircuitBreakerState;
    readonly marketQuotes?: MarketQuotesMap;
    readonly requireMarketQuote?: boolean;
    readonly minTrust?: TrustTier;
    readonly allowExperimentalFallback?: boolean;
    readonly logoutProofs?: ReadonlyMap<string, LogoutProof>;
    readonly confirmedLogoutAt?: ReadonlyMap<string, number>;
    readonly recentTransfers?: readonly TransferOrder[];
    readonly antiPingPongWindowMs?: number;
    readonly transferOrderTtlMs?: number;
    readonly stationedHubBankers?: Readonly<Partial<Record<HubBankId, string>>>;
    readonly xpRate?: number;
}

let cachedBaseItemPrices: Readonly<Record<number, number>> | undefined;

function getBaseItemPrices(): Readonly<Record<number, number>> {
    if (cachedBaseItemPrices) return cachedBaseItemPrices;
    const prices: Record<number, number> = {};
    for (const [id, meta] of loadItemsMap()) {
        if (meta.cost > 0) prices[id] = meta.cost;
    }
    cachedBaseItemPrices = prices;
    return cachedBaseItemPrices;
}

function buildItemPriceTable(marketQuotes?: MarketQuotesMap): Record<number, number> {
    const base = getBaseItemPrices();
    if (!marketQuotes) return base as Record<number, number>;
    const prices: Record<number, number> = { ...base };
    for (const [idStr, quote] of Object.entries(marketQuotes)) {
        if (quote && quote.ask !== null && quote.ask > 0) {
            prices[Number(idStr)] = Math.ceil(quote.ask);
        } else if (quote && quote.sell > 0) {
            prices[Number(idStr)] = Math.ceil(quote.sell);
        }
    }
    return prices;
}

function resolveLogoutMaps(
    world: WorldSnapshot,
    logoutProofs?: ReadonlyMap<string, LogoutProof>,
    explicitConfirmedAt?: ReadonlyMap<string, number>,
): {
    states: Map<string, 'confirmed' | 'none' | 'held' | 'invalid'>;
    confirmedAt: Map<string, number>;
} {
    const states = new Map<string, 'confirmed' | 'none' | 'held' | 'invalid'>();
    const confirmedAt = new Map<string, number>();

    if (logoutProofs) {
        for (const [name, proof] of logoutProofs) {
            const lower = name.toLowerCase();
            states.set(lower, proof.state);
            if (proof.state === 'confirmed') {
                confirmedAt.set(lower, proof.loggedOutAt);
            }
        }
    }
    if (explicitConfirmedAt) {
        for (const [name, at] of explicitConfirmedAt) {
            const lower = name.toLowerCase();
            if (Number.isFinite(at) && at > 0) {
                states.set(lower, 'confirmed');
                confirmedAt.set(lower, at);
            }
        }
    }
    // Preserve account names without forcing unverified confirmation unless explicitly supplied.
    for (const acct of Object.values(world.accounts)) {
        const lower = acct.name.toLowerCase();
        if (!states.has(lower) && acct.lastSettledTransferAt && acct.lastSettledTransferAt > 0) {
            // Do not synthesize logout proof from transfer timestamps; leave state unconfirmed unless provided.
        }
    }
    return { states, confirmedAt };
}

function buildDonorDemandItems(
    demands: readonly GoalDemand[],
    world: WorldSnapshot,
): Map<string, Set<number>> {
    const map = new Map<string, Set<number>>();
    const add = (account: string | undefined, itemId: number) => {
        if (!account) return;
        const lower = account.toLowerCase();
        const set = map.get(lower) ?? new Set<number>();
        set.add(itemId);
        map.set(lower, set);
    };

    for (const d of demands) {
        if (!d.active || d.remaining <= 0) continue;
        if (d.target.kind === 'item') {
            add(d.assignedAccount, d.target.itemId);
            add(d.target.holder, d.target.itemId);
        }
    }
    for (const acct of Object.values(world.accounts)) {
        if (acct.reserves) {
            for (const [idStr, amt] of Object.entries(acct.reserves)) {
                if (amt > 0) add(acct.name, Number(idStr));
            }
        }
        const worldRes = world.reserves?.[acct.name] ?? world.reserves?.[acct.name.toLowerCase()];
        if (worldRes) {
            for (const [idStr, amt] of Object.entries(worldRes)) {
                if (amt > 0) add(acct.name, Number(idStr));
            }
        }
    }
    return map;
}

function buildRecentReceivedMap(
    world: WorldSnapshot,
    recentTransfers: readonly TransferOrder[] = [],
): Map<string, number> {
    const map = new Map<string, number>();
    const all = [...(world.activeTransfers ?? []), ...recentTransfers];
    for (const order of all) {
        if (order.state !== 'settled' && order.state !== 'in_progress') continue;
        const at = Math.max(order.createdAt, order.recipientLogoutConfirmedAt, order.donorLogoutConfirmedAt);
        const recipLower = order.to.toLowerCase();
        for (const line of order.items) {
            const key = `${recipLower}:${line.itemId}`;
            const prev = map.get(key) ?? 0;
            if (at > prev) map.set(key, at);
        }
    }
    return map;
}

function buildPausedMissionIdSet(missions: readonly Mission[]): ReadonlySet<string> {
    const out = new Set<string>();
    for (const m of missions) {
        if (m.state === 'paused') out.add(m.id);
    }
    return out;
}

function pickHubBanker(
    hub: HubBankId,
    world: WorldSnapshot,
    stationed?: Readonly<Partial<Record<HubBankId, string>>>,
): string | undefined {
    const explicit = stationed?.[hub];
    if (explicit) return explicit;
    const bankTile = HUB_BANKER_LOCATIONS[hub].bankTile;
    let best: { name: string; dist: number } | null = null;
    for (const acct of Object.values(world.accounts)) {
        if (acct.protectedClock || isProtectedAccountName(acct.name)) continue;
        if (acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead') continue;
        if (acct.role !== 'helper' && acct.role !== 'auto') continue;
        if (!acct.pos) continue;
        const dist = Math.max(Math.abs(acct.pos.x - bankTile.x), Math.abs(acct.pos.z - bankTile.z));
        if (dist <= 15 && (!best || dist < best.dist)) {
            best = { name: acct.name, dist };
        }
    }
    return best?.name;
}

function estimateDemandContribution(
    plan: AccountPlan,
    demand: GoalDemand,
    activityById: ReadonlyMap<string, ActivityDefinition>,
): number {
    const workStep = plan.steps.find((s): s is TargetWorkPlannedStep => s.stepKind === 'work');
    if (!workStep || workStep.demandId !== demand.id) return 0;
    const act = activityById.get(workStep.activityId);
    switch (demand.target.kind) {
        case 'quest':
            return 1;
        case 'item': {
            const targetItemId = demand.target.itemId;
            const outPerUnit = act?.outputs?.find((o) => o.itemId === targetItemId)?.countPerUnit
                ?? act?.baselineRate.outputsPerUnit?.[targetItemId]
                ?? 1;
            return Math.max(1, Math.round(workStep.batchUnits * Math.max(0.01, outPerUnit)));
        }
        case 'coins': {
            const gpPerTick = Math.max(1, act?.baselineRate.gpPerTick ?? 1);
            return Math.max(1, Math.round(workStep.estimatedTicks * gpPerTick));
        }
        case 'skill':
        case 'combat_readiness':
            return 0;
    }
}

export function scheduleFleet(input: FleetSchedulerInput): FleetPlan {
    const { world, activities } = input;
    const now = world.at;
    const campaigns = input.campaigns ?? [];
    const missions = input.missions ?? [];
    const defects = input.defects ?? [];
    const retentionMarginRatio = Math.max(0, input.retentionMarginRatio ?? DEFAULT_RETENTION_MARGIN_RATIO);
    const maxBots = Math.max(
        0,
        input.maxBots ?? world.fleetSides?.[world.side]?.capacity ?? Object.keys(world.accounts).length,
    );
    const antiPingPongWindowMs = input.antiPingPongWindowMs ?? DEFAULT_ANTI_PING_PONG_MS;
    const transferOrderTtlMs = input.transferOrderTtlMs ?? 15 * 60_000;

    // Gate out any demands owned by paused missions.
    const pausedMissionIds = buildPausedMissionIdSet(missions);
    const activeDemands = input.demands.filter(
        (d) => d.active && d.remaining > 0 && (!d.sourceId || !pausedMissionIds.has(d.sourceId)),
    );
    const demandOrder = new Map<string, number>();
    for (let i = 0; i < activeDemands.length; i++) demandOrder.set(activeDemands[i]!.id, i);

    const activityById = new Map(activities.map((a) => [a.id, a]));
    const spotMaxBySpotId = new Map<string, number>();
    for (const a of activities) {
        if (a.spotId && a.maxConcurrentAccounts !== undefined) {
            const prev = spotMaxBySpotId.get(a.spotId);
            spotMaxBySpotId.set(
                a.spotId,
                prev === undefined ? a.maxConcurrentAccounts : Math.min(prev, a.maxConcurrentAccounts),
            );
        }
    }
    const demandById = new Map(activeDemands.map((d) => [d.id, d]));
    const remainingByDemand = new Map(activeDemands.map((d) => [d.id, d.remaining]));
    const shrunkNonZeroDemands = new Set<string>();

    const consumeDemandAllocation = (plan: AccountPlan) => {
        const workStep = plan.steps.find((s) => s.stepKind === 'work');
        const demandId = plan.demandId ?? workStep?.demandId;
        if (!demandId) return;
        const dem = demandById.get(demandId);
        if (!dem) return;
        const contrib = estimateDemandContribution(plan, dem, activityById);
        if (contrib <= 0) return;
        const cur = remainingByDemand.get(demandId) ?? 0;
        const next = Math.max(0, cur - contrib);
        remainingByDemand.set(demandId, next);
        if (next === 0) shrunkNonZeroDemands.delete(demandId);
        else if (next < cur) shrunkNonZeroDemands.add(demandId);
    };

    const currentUnallocatedDemands = (): GoalDemand[] => {
        const out: GoalDemand[] = [];
        for (const d of activeDemands) {
            const rem = remainingByDemand.get(d.id) ?? 0;
            if (rem > 0) {
                out.push(rem === d.remaining ? d : { ...d, remaining: rem });
            }
        }
        return out;
    };
    const itemPrices = buildItemPriceTable(input.marketQuotes);
    const { states: logoutStates, confirmedAt: confirmedLogoutAt } = resolveLogoutMaps(
        world,
        input.logoutProofs,
        input.confirmedLogoutAt,
    );
    const donorDemandItemIds = buildDonorDemandItems(activeDemands, world);
    const recentReceivedAt = buildRecentReceivedMap(world, input.recentTransfers);

    const accountPlans: Record<string, AccountPlan> = {};
    const spotAllocations: Record<string, string[]> = {};
    const transferOrders: TransferOrder[] = [];

    const recoveryCandidates: AccountState[] = [];
    const runningAccounts: AccountState[] = [];
    const inTradeAccounts: AccountState[] = [];
    const idleAccounts: AccountState[] = [];

    const sideAccounts = Object.values(world.accounts).sort((a, b) => a.name.localeCompare(b.name));
    const accountsByLower = new Map<string, AccountState>();
    for (const acct of sideAccounts) accountsByLower.set(acct.name.toLowerCase(), acct);

    for (const acct of sideAccounts) {
        if (acct.side !== world.side) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: `owned_by_other_side:${acct.side}`,
            };
            continue;
        }
        if (acct.lifecycle === 'paused_owner') {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'paused_owner',
            };
            continue;
        }
        if (acct.lifecycle === 'dead') {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'dead',
            };
            continue;
        }

        const prot = canProtectedAccountLaunch(acct, campaigns, world);
        if (!prot.allowed) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: prot.reason ?? 'protected_clock_reserved',
            };
            continue;
        }

        if (acct.lifecycle === 'in_trade') {
            inTradeAccounts.push(acct);
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'in_trade',
            };
            continue;
        }

        if (acct.lifecycle === 'needs_logout_recovery' || acct.lifecycle === 'needs_location_recovery') {
            recoveryCandidates.push(acct);
            continue;
        }

        if (acct.lifecycle === 'running') {
            runningAccounts.push(acct);
            continue;
        }

        // 'idle' or launch-ready 'reserved'
        idleAccounts.push(acct);
    }

    // Sort recovery queue: needs_logout_recovery by frozen GP + critical supply value descending,
    // followed by needs_location_recovery by frozen value descending.
    recoveryCandidates.sort((a, b) =>
        compareRecoveryPriority(a, b, (x) => accountFrozenValue(x, itemPrices)),
    );

    const recoveryQueue: RecoveryQueueEntry[] = recoveryCandidates.map((acct) => ({
        account: acct.name,
        lifecycle: acct.lifecycle as (typeof RECOVERY_PRIORITY_ORDER)[number],
        priorityValue: accountFrozenValue(acct, itemPrices),
    }));

    const sideStopped = world.fleetSides?.[world.side]?.stopped === true && !input.ignoreSideStop;
    const circuitOpen = input.infraCircuitBreaker?.open === true
        && (input.infraCircuitBreaker.retryAt === undefined || now < input.infraCircuitBreaker.retryAt);

    let remainingSlots = Math.max(0, maxBots - inTradeAccounts.length);
    const activeTransferParties = new Set<string>();
    for (const acct of inTradeAccounts) activeTransferParties.add(acct.name.toLowerCase());
    for (const existing of world.activeTransfers ?? []) {
        if (existing.state === 'planned' || existing.state === 'in_progress') {
            activeTransferParties.add(existing.from.toLowerCase());
            activeTransferParties.add(existing.to.toLowerCase());
        }
    }
    const busyAccounts = new Set<string>(activeTransferParties);

    const spotHasCapacity = (spotId: string | undefined, maxConcurrent: number | undefined): boolean => {
        if (!spotId || maxConcurrent === undefined) return true;
        const ext = world.spotOccupancy?.[spotId] ?? 0;
        const cur = spotAllocations[spotId]?.length ?? 0;
        return ext + cur < maxConcurrent;
    };

    const reserveSpot = (acctName: string, spotId: string | undefined) => {
        if (!spotId) return;
        const list = spotAllocations[spotId] ?? [];
        list.push(acctName);
        spotAllocations[spotId] = list;
    };

    const currentFullSpots = (extraSpotId?: string): Set<string> => {
        const full = new Set<string>();
        if (extraSpotId) full.add(extraSpotId);
        for (const [spotId, maxConc] of spotMaxBySpotId.entries()) {
            if ((world.spotOccupancy?.[spotId] ?? 0) + (spotAllocations[spotId]?.length ?? 0) >= maxConc) {
                full.add(spotId);
            }
        }
        return full;
    };

    // Enforce 1-per-venue concurrency for market shop-buy (itemId + shopId) and GE-buy (itemId + ge)
    // within a single scheduling cycle so accounts do not dogpile shared NPC shop stock or GE asks.
    const allocatedMarketVenues = new Set<string>();
    const planMarketVenues = (plan: AccountPlan): string[] => {
        const venues: string[] = [];
        for (const st of plan.steps) {
            if (st.stepKind !== 'work' || !st.config) continue;
            const itemId = st.config.itemId;
            if (typeof itemId !== 'number' || !Number.isFinite(itemId)) continue;
            if (st.config.mode === 'shop-buy' && typeof st.config.shopId === 'string' && st.config.shopId.length > 0) {
                venues.push(marketCooldownKey(itemId, `shop:${st.config.shopId}`));
            } else if (st.config.mode === 'ge-buy') {
                venues.push(marketCooldownKey(itemId, 'ge'));
            }
        }
        return venues;
    };
    const marketVenueHasCapacity = (plan: AccountPlan): boolean => {
        for (const v of planMarketVenues(plan)) {
            if (allocatedMarketVenues.has(v)) return false;
        }
        return true;
    };
    const reserveMarketVenues = (plan: AccountPlan) => {
        for (const v of planMarketVenues(plan)) {
            allocatedMarketVenues.add(v);
        }
    };

    const sharedIndex = buildPlannerSharedIndex({
        world,
        activities,
        defects,
        minTrust: input.minTrust,
        allowExperimentalFallback: input.allowExperimentalFallback,
    });

    const basePlannerOpts = {
        world,
        activities,
        demands: activeDemands,
        campaigns,
        defects,
        rateEstimator: input.rateEstimator,
        rateStore: input.rateStore,
        marketQuotes: input.marketQuotes,
        requireMarketQuote: input.requireMarketQuote,
        minTrust: input.minTrust,
        allowExperimentalFallback: input.allowExperimentalFallback,
        donorDemandItemIds,
        recentReceivedAt,
        confirmedLogoutAt,
        requireConfirmedLogoutForTransfer: true,
        xpRate: input.xpRate,
        _sharedIndex: sharedIndex,
    };

    const reuseByAccount = new Map<string, AccountPlannerReuse>();
    const getAccountReuse = (acct: AccountState): AccountPlannerReuse => {
        const key = acct.name.toLowerCase();
        let reuse = reuseByAccount.get(key);
        if (!reuse) {
            reuse = createAccountPlannerReuse(acct, world, campaigns);
            reuseByAccount.set(key, reuse);
        }
        return reuse;
    };

    // 1. Retain healthy running accounts with +15% retention hysteresis.
    // Running accounts cannot materialize hub_banker transfers (transfers require idle recipients).
    const runningPlannerOpts = {
        ...basePlannerOpts,
        excludedAcquireSources: new Set<AcquireSourceKind>(['hub_banker']),
    };
    const evaluatedRunning: { acct: AccountState; plan: AccountPlan }[] = [];
    for (const acct of runningAccounts) {
        const job = acct.activeJob;
        const activeAct = job ? activityById.get(job.activityId) : undefined;
        const activeDem = job ? demandById.get(job.demandId) : undefined;
        const acctReuse = getAccountReuse(acct);

        let currentPlan: AccountPlan | null = null;
        if (activeAct && activeDem) {
            const p = planAccount(acct, {
                ...runningPlannerOpts,
                activities: [activeAct],
                demands: [activeDem],
                _sharedIndex: undefined,
                _reuse: acctReuse,
            });
            if (p.steps.length > 0) currentPlan = p;
        }

        const bestAlt = planAccount(acct, { ...runningPlannerOpts, _reuse: acctReuse });
        let chosen: AccountPlan;
        if (currentPlan && currentPlan.steps.length > 0) {
            const threshold = currentPlan.scorePerHour * (1 + retentionMarginRatio);
            if (bestAlt.steps.length === 0 || bestAlt.scorePerHour <= threshold) {
                chosen = {
                    ...currentPlan,
                    retentionMarginApplied: true,
                };
            } else {
                chosen = bestAlt;
            }
        } else {
            chosen = bestAlt;
        }
        evaluatedRunning.push({ acct, plan: chosen });
    }

    evaluatedRunning.sort((a, b) => b.plan.scorePerHour - a.plan.scorePerHour || a.acct.name.localeCompare(b.acct.name));

    for (const { acct, plan } of evaluatedRunning) {
        if (sideStopped) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'side_paused_owner',
            };
            continue;
        }
        if (plan.steps.length === 0) {
            accountPlans[acct.name] = plan;
            continue;
        }
        if (remainingSlots <= 0) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'max_bots_limit',
            };
            continue;
        }
        const workStep = plan.steps.at(-1);
        const workAct = workStep?.stepKind === 'work' ? activityById.get(workStep.activityId) : undefined;
        const spotOk = !workAct || spotHasCapacity(workAct.spotId, workAct.maxConcurrentAccounts);
        const marketOk = marketVenueHasCapacity(plan);
        if (!spotOk || !marketOk) {
            const excludedSpots = currentFullSpots(!spotOk ? workAct?.spotId : undefined);
            const rerouted = planAccount(acct, {
                ...runningPlannerOpts,
                excludedSpotIds: excludedSpots,
                excludedMarketVenues: allocatedMarketVenues,
                _reuse: getAccountReuse(acct),
            });
            const altWork = rerouted.steps.at(-1);
            const altAct = altWork?.stepKind === 'work' ? activityById.get(altWork.activityId) : undefined;
            if (
                rerouted.steps.length === 0
                || (altAct && !spotHasCapacity(altAct.spotId, altAct.maxConcurrentAccounts))
                || !marketVenueHasCapacity(rerouted)
            ) {
                accountPlans[acct.name] = {
                    account: acct.name,
                    steps: [],
                    scorePerHour: 0,
                    idleReason: 'spot_capacity_full',
                };
                continue;
            }
            reserveSpot(acct.name, altAct?.spotId);
            reserveMarketVenues(rerouted);
            consumeDemandAllocation(rerouted);
            accountPlans[acct.name] = rerouted;
            busyAccounts.add(acct.name.toLowerCase());
            remainingSlots -= 1;
            continue;
        }
        reserveSpot(acct.name, workAct?.spotId);
        reserveMarketVenues(plan);
        consumeDemandAllocation(plan);
        accountPlans[acct.name] = plan;
        busyAccounts.add(acct.name.toLowerCase());
        remainingSlots -= 1;
    }

    // 2. Unblock execution order: needs_logout_recovery first, then needs_location_recovery.
    for (const entry of recoveryQueue) {
        const acct = world.accounts[entry.account] ?? accountsByLower.get(entry.account.toLowerCase());
        if (!acct) continue;
        if (sideStopped) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'side_paused_owner',
            };
            continue;
        }
        if (circuitOpen) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'infra_circuit_breaker_open',
            };
            continue;
        }
        if (remainingSlots <= 0) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'max_bots_limit',
            };
            continue;
        }
        const recPlan = planAccount(acct, basePlannerOpts);
        accountPlans[acct.name] = recPlan;
        if (recPlan.steps.length > 0) {
            busyAccounts.add(acct.name.toLowerCase());
            remainingSlots -= 1;
        }
    }

    // 3. Plan idle (and launch-ready reserved) accounts ordered by value/hour descending.
    const initialUnallocated = currentUnallocatedDemands();
    const initialExcludedSpots = currentFullSpots();
    const initialExcludedMarketVenuesSize = allocatedMarketVenues.size;
    const idleEvaluations = idleAccounts
        .map((acct) => {
            const res = planAccountWithCandidates(acct, {
                ...basePlannerOpts,
                demands: initialUnallocated,
                excludedSpotIds: initialExcludedSpots,
                excludedMarketVenues: allocatedMarketVenues,
                excludedDonorAccounts: busyAccounts,
                _reuse: getAccountReuse(acct),
            });
            return {
                acct,
                plan: res.bestPlan,
                candidates: res.candidates,
            };
        })
        .sort((a, b) => b.plan.scorePerHour - a.plan.scorePerHour || a.acct.name.localeCompare(b.acct.name));

    const assignedIdleDonors = new Set<string>();
    let transferSeq = 0;

    const hasBusyHubDonor = (cand: AccountPlan): boolean => {
        for (const st of cand.steps) {
            if ((st.stepKind === 'acquire' || st.stepKind === 'gear_upgrade') && st.source === 'hub_banker' && st.donorAccount) {
                const dl = st.donorAccount.toLowerCase();
                if (busyAccounts.has(dl) || assignedIdleDonors.has(dl) || activeTransferParties.has(dl)) {
                    return true;
                }
            }
        }
        return false;
    };

    for (const { acct, plan: initialPlan, candidates } of idleEvaluations) {
        if (sideStopped) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'side_paused_owner',
            };
            continue;
        }
        if (circuitOpen) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'infra_circuit_breaker_open',
            };
            continue;
        }
        if (remainingSlots <= 0) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'max_bots_limit',
            };
            continue;
        }
        if (activeTransferParties.has(acct.name.toLowerCase()) || assignedIdleDonors.has(acct.name.toLowerCase())) {
            accountPlans[acct.name] = {
                account: acct.name,
                steps: [],
                scorePerHour: 0,
                idleReason: 'reserved_for_transfer',
            };
            continue;
        }

        const excludedSpots = currentFullSpots();
        const candidateUsesExcludedSpot = (cand: AccountPlan): boolean => {
            if (excludedSpots.size === 0) return false;
            for (const st of cand.steps) {
                if ('activityId' in st && st.activityId) {
                    const spot = activityById.get(st.activityId)?.spotId;
                    if (spot && excludedSpots.has(spot)) return true;
                }
            }
            return false;
        };
        const candidateUsesExcludedMarketVenue = (cand: AccountPlan): boolean => !marketVenueHasCapacity(cand);

        let plan: AccountPlan | undefined;
        let availableDemands: GoalDemand[] | undefined;
        const getAvailableDemands = (): GoalDemand[] => (availableDemands ??= currentUnallocatedDemands());

        if (
            initialPlan.steps.length === 0
            && shrunkNonZeroDemands.size === 0
            && excludedSpots.size === initialExcludedSpots.size
            && allocatedMarketVenues.size === initialExcludedMarketVenuesSize
        ) {
            plan = initialPlan;
        } else if (candidates.length > 0) {
            let bestUnchanged: AccountPlan | undefined;
            const dirtyDemandIds = new Set<string>();
            for (let ci = 0; ci < candidates.length; ci++) {
                const cand = candidates[ci]!;
                const did = cand.demandId;
                if (did) {
                    const rem = remainingByDemand.get(did) ?? 0;
                    if (rem <= 0) continue;
                    if (shrunkNonZeroDemands.has(did)) continue;
                }
                if (candidateUsesExcludedSpot(cand) || candidateUsesExcludedMarketVenue(cand) || hasBusyHubDonor(cand)) {
                    if (did) dirtyDemandIds.add(did);
                    continue;
                }
                bestUnchanged = cand;
                break;
            }

            if (bestUnchanged) {
                const reevalDemands: GoalDemand[] = [];
                for (const did of shrunkNonZeroDemands) {
                    const rem = remainingByDemand.get(did) ?? 0;
                    if (rem <= 0) continue;
                    const base = demandById.get(did);
                    if (base) reevalDemands.push(rem === base.remaining ? base : { ...base, remaining: rem });
                }
                for (const did of dirtyDemandIds) {
                    if (shrunkNonZeroDemands.has(did)) continue;
                    const rem = remainingByDemand.get(did) ?? 0;
                    if (rem <= 0) continue;
                    const base = demandById.get(did);
                    if (base) reevalDemands.push(rem === base.remaining ? base : { ...base, remaining: rem });
                }

                if (reevalDemands.length === 0) {
                    plan = bestUnchanged;
                } else if (reevalDemands.length * 2 < activeDemands.length) {
                    if (reevalDemands.length > 1) {
                        reevalDemands.sort((a, b) => (demandOrder.get(a.id) ?? 0) - (demandOrder.get(b.id) ?? 0));
                    }
                    const reevalBest = planAccount(acct, {
                        ...basePlannerOpts,
                        demands: reevalDemands,
                        excludedSpotIds: excludedSpots,
                        excludedMarketVenues: allocatedMarketVenues,
                        excludedDonorAccounts: busyAccounts,
                        _reuse: getAccountReuse(acct),
                    });
                    if (reevalBest.steps.length === 0) {
                        plan = bestUnchanged;
                    } else if (reevalBest.scorePerHour > bestUnchanged.scorePerHour) {
                        plan = reevalBest;
                    } else if (reevalBest.scorePerHour < bestUnchanged.scorePerHour) {
                        plan = bestUnchanged;
                    } else {
                        const reevalIdx = reevalBest.demandId ? (demandOrder.get(reevalBest.demandId) ?? Infinity) : Infinity;
                        const unchIdx = bestUnchanged.demandId ? (demandOrder.get(bestUnchanged.demandId) ?? Infinity) : Infinity;
                        plan = reevalIdx < unchIdx ? reevalBest : bestUnchanged;
                    }
                }
            }
        }

        if (!plan) {
            plan = planAccount(acct, {
                ...basePlannerOpts,
                demands: getAvailableDemands(),
                excludedSpotIds: excludedSpots,
                excludedMarketVenues: allocatedMarketVenues,
                excludedDonorAccounts: busyAccounts,
                _reuse: getAccountReuse(acct),
            });
        }

        // Validate and materialize any hub_banker AcquireSteps or GearUpgradePlannedSteps as safe TransferOrders.
        if (plan.steps.length > 0) {
            const hubSteps = plan.steps.filter(
                (s): s is AcquireStep | GearUpgradePlannedStep =>
                    (s.stepKind === 'acquire' || s.stepKind === 'gear_upgrade') && s.source === 'hub_banker',
            );
            if (hubSteps.length > 0) {
                let transfersOk = true;
                const stagedOrders: TransferOrder[] = [];
                const updatedSteps = [...plan.steps];

                for (let i = 0; i < updatedSteps.length; i++) {
                    const step = updatedSteps[i]!;
                    if ((step.stepKind !== 'acquire' && step.stepKind !== 'gear_upgrade') || step.source !== 'hub_banker') continue;
                    const quantity = step.stepKind === 'acquire' ? step.quantity : 1;
                    const donorName = step.donorAccount;
                    const hub: HubBankId = step.hub ?? 'varrock_west';
                    const donor = donorName
                        ? accountsByLower.get(donorName.toLowerCase())
                        : undefined;
                    if (
                        !donor
                        || busyAccounts.has(donor.name.toLowerCase())
                        || assignedIdleDonors.has(donor.name.toLowerCase())
                        || activeTransferParties.has(donor.name.toLowerCase())
                    ) {
                        transfersOk = false;
                        break;
                    }
                    const donorLower = donor.name.toLowerCase();
                    const recipLower = acct.name.toLowerCase();
                    const donorLogoutAt = confirmedLogoutAt.get(donorLower) ?? 0;
                    const recipLogoutAt = confirmedLogoutAt.get(recipLower) ?? 0;
                    const donorLogoutState = logoutStates.get(donorLower) ?? 'none';
                    const recipientLogoutState = logoutStates.get(recipLower) ?? 'none';
                    const recentAt = recentReceivedAt.get(`${donorLower}:${step.itemId}`);
                    const donorDemands = donorDemandItemIds.get(donorLower);
                    const donorHasDemand = donorDemands?.has(step.itemId) ?? false;
                    const orderId = `xfer-${now}-${++transferSeq}`;
                    const banker = pickHubBanker(hub, world, input.stationedHubBankers);

                    const order: TransferOrder = {
                        id: orderId,
                        server: world.server,
                        from: donor.name,
                        to: acct.name,
                        hub,
                        ...(banker ? { hubBanker: banker } : {}),
                        items: [{
                            itemId: step.itemId,
                            ...(step.itemName ? { itemName: step.itemName } : {}),
                            count: quantity,
                        }],
                        demandId: plan.demandId ?? `demand:${acct.name}:${step.itemId}`,
                        reason: `supply ${quantity}x ${step.itemName ?? step.itemId} for ${acct.name}`,
                        createdAt: now,
                        expiresAt: now + transferOrderTtlMs,
                        state: 'planned',
                        bothIdleVerified: donor.lifecycle === 'idle' && acct.lifecycle === 'idle',
                        donorLogoutConfirmedAt: donorLogoutAt,
                        recipientLogoutConfirmedAt: recipLogoutAt,
                        antiPingPong: {
                            ...(recentAt !== undefined ? { donorRecentReceivedAt: recentAt } : {}),
                            donorHoldsDemandForItems: donorHasDemand,
                            cooldownWindowMs: antiPingPongWindowMs,
                        },
                    };

                    const check = canScheduleTransferOrder(order, donor, acct, {
                        now,
                        donorLogoutState,
                        recipientLogoutState,
                        donorDemandItemIds: donorDemands,
                    });
                    if (!check.ok) {
                        transfersOk = false;
                        break;
                    }
                    stagedOrders.push(order);
                    updatedSteps[i] = { ...step, transferOrderId: orderId };
                }

                const uniqueStagedDonors = new Set(stagedOrders.map((ord) => ord.from.toLowerCase()));
                if (transfersOk && remainingSlots < 1 + uniqueStagedDonors.size) {
                    transfersOk = false;
                }
                if (!transfersOk) {
                    // Re-plan forbidding hub_banker transfers when a safe transfer check fails.
                    const replan = planAccount(acct, {
                        ...basePlannerOpts,
                        demands: getAvailableDemands(),
                        excludedSpotIds: excludedSpots,
                        excludedMarketVenues: allocatedMarketVenues,
                        excludedDonorAccounts: busyAccounts,
                        excludedAcquireSources: new Set<AcquireSourceKind>(['hub_banker']),
                        _reuse: getAccountReuse(acct),
                    });
                    plan = replan.steps.length > 0
                        ? replan
                        : {
                              account: acct.name,
                              steps: [],
                              scorePerHour: 0,
                              idleReason: 'transfer_safety_gate_unmet',
                          };
                } else {
                    for (const ord of stagedOrders) {
                        transferOrders.push(ord);
                        assignedIdleDonors.add(ord.from.toLowerCase());
                        activeTransferParties.add(ord.from.toLowerCase());
                        activeTransferParties.add(ord.to.toLowerCase());
                        busyAccounts.add(ord.from.toLowerCase());
                        busyAccounts.add(ord.to.toLowerCase());
                    }
                    remainingSlots -= uniqueStagedDonors.size;
                    plan = { ...plan, steps: updatedSteps };
                }
            }
        }

        if (plan.steps.length === 0) {
            accountPlans[acct.name] = plan;
            continue;
        }

        const workStep = plan.steps.at(-1);
        const workAct = workStep?.stepKind === 'work' ? activityById.get(workStep.activityId) : undefined;
        reserveSpot(acct.name, workAct?.spotId);
        reserveMarketVenues(plan);
        consumeDemandAllocation(plan);
        accountPlans[acct.name] = plan;
        busyAccounts.add(acct.name.toLowerCase());
        remainingSlots -= 1;
    }

    const plansWithSteps = Object.values(accountPlans).filter((p) => p.steps.length > 0).length;
    const selectedSlots = Math.min(maxBots, inTradeAccounts.length + plansWithSteps + assignedIdleDonors.size);

    return {
        schemaVersion: 1,
        plannedAt: now,
        side: world.side,
        maxBots,
        retentionMarginRatio,
        recoveryQueue,
        accountPlans,
        transferOrders,
        spotAllocations,
        selectedSlots,
    };
}

export function buildFleetState(
    plan: FleetPlan,
    input: {
        readonly world: WorldSnapshot;
        readonly goals: readonly GoalDemand[];
        readonly campaigns?: readonly Campaign[];
        readonly missions?: readonly Mission[];
        readonly defects?: readonly DefectRecord[];
        readonly infraCircuitBreaker?: InfraCircuitBreakerState;
        readonly rateStats?: Readonly<Record<string, RateSummary>>;
    },
): FleetState {
    const activeChains: Record<string, AccountPlan> = {};
    const idleReasons: Record<string, string> = {};

    for (const [acctName, acctPlan] of Object.entries(plan.accountPlans)) {
        if (acctPlan.steps.length > 0) {
            activeChains[acctName] = acctPlan;
        } else {
            idleReasons[acctName] = acctPlan.idleReason ?? 'idle';
        }
    }

    const pendingMap = new Map<string, TransferOrder>();
    for (const t of input.world.activeTransfers ?? []) {
        if (t.state === 'planned' || t.state === 'in_progress') {
            pendingMap.set(t.id, t);
        }
    }
    for (const t of plan.transferOrders) {
        pendingMap.set(t.id, t);
    }

    return {
        schemaVersion: FLEET_STATE_SCHEMA_VERSION,
        emittedAt: plan.plannedAt,
        side: plan.side,
        server: input.world.server,
        maxBots: plan.maxBots,
        ...(input.infraCircuitBreaker ? { infraCircuitBreaker: input.infraCircuitBreaker } : {}),
        accounts: input.world.accounts,
        activeChains,
        idleReasons,
        goals: [...input.goals],
        campaigns: [...(input.campaigns ?? [])],
        missions: [...(input.missions ?? [])],
        pendingTransfers: [...pendingMap.values()],
        quarantinedDefects: [...(input.defects ?? []).filter((d) => d.quarantined)],
        ...(input.rateStats ? { rateStats: input.rateStats } : {}),
    };
}
