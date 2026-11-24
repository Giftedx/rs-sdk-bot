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
    type AccountPlan,
    type AccountState,
    type ActivityDefinition,
    type AcquireStep,
    type Campaign,
    type DefectRecord,
    type FleetPlan,
    type FleetState,
    type GoalDemand,
    type HubBankId,
    type InfraCircuitBreakerState,
    type Mission,
    type RateSummary,
    type RecoveryQueueEntry,
    type TransferOrder,
    type WorldSnapshot,
} from './contracts';
import { DEFAULT_ANTI_PING_PONG_MS, type MarketQuotesMap } from './acquire';
import {
    canProtectedAccountLaunch,
    planAccount,
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

function isPausedMissionDemand(
    demand: GoalDemand,
    missions: readonly Mission[],
): boolean {
    if (!demand.sourceId) return false;
    const match = missions.find((m) => m.id === demand.sourceId);
    return match?.state === 'paused';
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
    const activeDemands = input.demands.filter(
        (d) => d.active && d.remaining > 0 && !isPausedMissionDemand(d, missions),
    );

    const activityById = new Map(activities.map((a) => [a.id, a]));
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

        const prot = canProtectedAccountLaunch(acct, campaigns);
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
    };

    // 1. Retain healthy running accounts with +15% retention hysteresis.
    const evaluatedRunning: { acct: AccountState; plan: AccountPlan }[] = [];
    for (const acct of runningAccounts) {
        const job = acct.activeJob;
        const activeAct = job ? activityById.get(job.activityId) : undefined;
        const activeDem = job ? activeDemands.find((d) => d.id === job.demandId) : undefined;

        let currentPlan: AccountPlan | null = null;
        if (activeAct && activeDem) {
            const p = planAccount(acct, {
                ...basePlannerOpts,
                activities: [activeAct],
                demands: [activeDem],
            });
            if (p.steps.length > 0) currentPlan = p;
        }

        const bestAlt = planAccount(acct, basePlannerOpts);
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
        if (workAct && !spotHasCapacity(workAct.spotId, workAct.maxConcurrentAccounts)) {
            const excludedSpots = new Set<string>([workAct.spotId!]);
            const rerouted = planAccount(acct, { ...basePlannerOpts, excludedSpotIds: excludedSpots });
            if (rerouted.steps.length === 0) {
                accountPlans[acct.name] = {
                    account: acct.name,
                    steps: [],
                    scorePerHour: 0,
                    idleReason: 'spot_capacity_full',
                };
                continue;
            }
            const altWork = rerouted.steps.at(-1);
            const altAct = altWork?.stepKind === 'work' ? activityById.get(altWork.activityId) : undefined;
            reserveSpot(acct.name, altAct?.spotId);
            accountPlans[acct.name] = rerouted;
            remainingSlots -= 1;
            continue;
        }
        reserveSpot(acct.name, workAct?.spotId);
        accountPlans[acct.name] = plan;
        remainingSlots -= 1;
    }

    // 2. Unblock execution order: needs_logout_recovery first, then needs_location_recovery.
    for (const entry of recoveryQueue) {
        const acct = world.accounts[entry.account] ?? sideAccounts.find((a) => a.name === entry.account);
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
        accountPlans[acct.name] = planAccount(acct, basePlannerOpts);
        remainingSlots -= 1;
    }

    // 3. Plan idle (and launch-ready reserved) accounts ordered by value/hour descending.
    const idleEvaluations = idleAccounts
        .map((acct) => ({ acct, plan: planAccount(acct, basePlannerOpts) }))
        .sort((a, b) => b.plan.scorePerHour - a.plan.scorePerHour || a.acct.name.localeCompare(b.acct.name));

    const assignedIdleDonors = new Set<string>();
    let transferSeq = 0;

    for (const { acct } of idleEvaluations) {
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

        const excludedSpots = new Set<string>();
        for (const [spotId, list] of Object.entries(spotAllocations)) {
            const act = activities.find((a) => a.spotId === spotId && a.maxConcurrentAccounts !== undefined);
            if (act?.maxConcurrentAccounts !== undefined
                && (world.spotOccupancy?.[spotId] ?? 0) + list.length >= act.maxConcurrentAccounts) {
                excludedSpots.add(spotId);
            }
        }

        let plan = planAccount(acct, { ...basePlannerOpts, excludedSpotIds: excludedSpots });

        // Validate and materialize any hub_banker AcquireSteps as safe TransferOrders.
        if (plan.steps.length > 0) {
            const hubSteps = plan.steps.filter((s): s is AcquireStep => s.stepKind === 'acquire' && s.source === 'hub_banker');
            if (hubSteps.length > 0) {
                let transfersOk = true;
                const stagedOrders: TransferOrder[] = [];
                const updatedSteps = [...plan.steps];

                for (let i = 0; i < updatedSteps.length; i++) {
                    const step = updatedSteps[i]!;
                    if (step.stepKind !== 'acquire' || step.source !== 'hub_banker') continue;
                    const donorName = step.donorAccount;
                    const hub: HubBankId = step.hub ?? 'varrock_west';
                    const donor = donorName
                        ? Object.values(world.accounts).find((a) => a.name.toLowerCase() === donorName.toLowerCase())
                        : undefined;
                    if (!donor || assignedIdleDonors.has(donor.name.toLowerCase()) || activeTransferParties.has(donor.name.toLowerCase())) {
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
                            count: step.quantity,
                        }],
                        demandId: plan.demandId ?? `demand:${acct.name}:${step.itemId}`,
                        reason: `supply ${step.quantity}x ${step.itemName ?? step.itemId} for ${acct.name}`,
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

                if (!transfersOk) {
                    // Re-plan forbidding hub_banker transfers when a safe transfer check fails.
                    plan = {
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
                    }
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
        accountPlans[acct.name] = plan;
        remainingSlots -= 1;
    }

    const plansWithSteps = Object.values(accountPlans).filter((p) => p.steps.length > 0).length;
    const selectedSlots = Math.min(maxBots, inTradeAccounts.length + plansWithSteps);

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
