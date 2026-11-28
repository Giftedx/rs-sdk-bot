// Unified WorkerModule<GatherConfig> entrypoint and consolidated gather exports.
import type { Session } from '../../../core/src/inprocess';
import {
    type RunOutcome,
    type SessionCore,
    type WorkerAccountView,
    type WorkerModule,
    type WorkerWorldView,
} from '../contracts';
import { watchWorkerStop } from '../stop';
import { runGather, runGatherCli } from './dispatch';
import { gatherEstimate, gatherPreflight, toWorkerOutcome } from './preflight';
import { type GatherConfig, normalizeGatherConfig } from './types';

export const gatherWorker: WorkerModule<GatherConfig, WorkerAccountView, WorkerWorldView, SessionCore> = {
    id: 'gather:unified',
    family: 'gather',
    kind: 'gather',
    trust: 'practice_passed',
    protectedAllowed: false,

    preflight(acct, cfg, world) {
        return gatherPreflight(acct, cfg, world);
    },

    estimate(acct, cfg, world) {
        return gatherEstimate(acct, cfg, world);
    },

    async run(session, cfg): Promise<RunOutcome> {
        const s = session as Session;
        const norm = normalizeGatherConfig(cfg);
        const startTick = s.tick?.() ?? 0;
        const { isStopped } = watchWorkerStop(s, (cfg as { stop?: () => boolean }).stop);
        await Promise.resolve();
        if (isStopped()) {
            return toWorkerOutcome(
                { ok: false, kind: 'aborted', detail: 'stop or session end requested', delta: { elapsedTicks: 0 } },
                s.name ?? 'unknown',
                norm,
                0,
                { stopped: true },
            );
        }
        try {
            const outcome = await runGather(s, norm, isStopped);
            const ticksElapsed = Math.max(0, (s.tick?.() ?? startTick) - startTick);
            return toWorkerOutcome(outcome, s.name ?? 'unknown', norm, ticksElapsed, { stopped: isStopped() });
        } catch (error) {
            await Promise.resolve();
            const detail = String(error);
            const ticksElapsed = Math.max(0, (s.tick?.() ?? startTick) - startTick);
            const stopped = isStopped();
            return toWorkerOutcome(
                { ok: false, kind: stopped ? 'aborted' : 'failed', detail, delta: { elapsedTicks: ticksElapsed } },
                s.name ?? 'unknown',
                norm,
                ticksElapsed,
                { stopped },
            );
        }
    },
};

export { runGather, runGatherCli } from './dispatch';
export { gatherEstimate, gatherPreflight, toWorkerOutcome } from './preflight';
export * from './types';
export * from './knife-reset';
export * from './loot';
export * from './tools';
export {
    BANK_TILES_FALLBACK,
    defaultApproach,
    defaultNearestBanks,
    defaultWalkTargetPersist,
    walkGroundLeg,
} from './runtime';
export {
    MINING_SITES,
    contentSites,
    firstRoll,
    oreLag,
    pathSteps,
    respawnTicks,
    runRotationMining,
    siteRocks,
    siteTiles,
    standTiles,
    type MiningSite,
    type RotationOptions,
    type RotationResult,
    type Tile as MiningRotationTile,
} from './mining-rotation';
export * from './foraging';
export * from './woodcutting';
export * from './fishing';
export {
    BANK as ESCORT_BANK,
    CAMP as ESCORT_CAMP,
    STAGE as ESCORT_STAGE,
    RosterEvidence,
    alignAtBank,
    corridorThreat,
    dist,
    eligiblePickaxe,
    entryRosterReady,
    equipUsablePickaxeInPack,
    escortInterceptDecision,
    escortProvokedByThreat,
    essencePickWieldLevel,
    essenceTeleportProblem,
    HEROES_RUNITE_ROCKS,
    inPerfectMine,
    incidentalMiningGems,
    isEssence,
    LAVA_MAZE_RUNITE_ROCKS,
    mineEssenceBatch,
    mineRock,
    miningEffect,
    miningProfiles,
    mixedOreCombatProblem,
    oreDamageEvidence,
    oreStalled,
    progressiveMiningProfile,
    readEscortRoute,
    reconcileOrePickaxeAtBank,
    retreatOrTeleportPlan,
    retreatOre,
    RUNITE_ROCK_IDS,
    runiteDepletionAction,
    runAtSiteMining,
    runDropMining,
    runEscortedOre,
    runEssenceGatherer,
    runMiningCli,
    runMiningSession,
    runProgressiveMining,
    selectActiveOrePickaxe,
    selectAvailableRuniteRock,
    selectInboundRecovery,
    selectMiningRock,
    selectRock,
    stageRelease,
    upgradeOwnedEssencePick,
    waitForRosterEntry,
    watchOreDamage,
    type MiningDropDriver,
    type MiningDropJob,
    type ProgressiveMiningJob,
    type RosterPlayer,
    type Tile as EscortTile,
} from './mining';
export {
    ARDOUGNE_RADIUS,
    ARRIVAL as BLOOD_ARRIVAL,
    BANK_FOOD,
    BANK_SPOT,
    BLOOD_BANK,
    BLOOD_RUNE,
    BLOOD_STAGE,
    CHEST,
    CHESTS,
    COINS_PER_LOOT,
    COINS_RE,
    COURIER_COOLDOWN,
    COURIER_WANT_BELOW,
    DMG,
    DOOR,
    EXIT_TICKS,
    FAR_RADIUS,
    FED_SHARE,
    FOOD_NAMES,
    FOOD_ORDER,
    FRAIL_FLOOR,
    FRAIL_HP,
    FRAIL_RESERVE,
    IDLE_LIMIT,
    KEEP_FREE,
    KNIGHT,
    KNIGHT_SPOT,
    LADDER_DOWN,
    LADDER_FOOT,
    LADDER_UP,
    LEAVE_SHARE,
    MEAL_LIMIT,
    NATURE_CHEST,
    NATURE_RUNE,
    PICK_LIMIT,
    RANGE,
    REFUGE_NONE,
    REFUGE_WINDOW,
    REGEN_TICKS,
    RESPAWN_TICKS,
    RUNES_PER_LOOT,
    THIEVING_COINS_ID,
    THIEVING_COINS_ID as COINS,
    THIEVING_LEVEL,
    TRAVEL_TICKS,
    WITHDRAW_FOOD,
    bloodChestEffect,
    bloodOptions,
    bloodRefusal,
    bloodZone,
    calcEatAt,
    chestOptions,
    courierCheckDue,
    courierFoodReady,
    failureResult,
    farmEatReceipt,
    farmErrorCheckpoint,
    farmFinishCheckpoint,
    farmPickCancellation,
    farmPickTarget,
    farmProgressTick,
    farmSettlePicks,
    farmStartProblem,
    farmWalk,
    foodBiteHeal,
    foodReserve,
    foodTripDue,
    foodWaitLimit,
    guardHit,
    healOf,
    incomingCookedFood,
    isFoodItem,
    natureChestEffect,
    noKnightReason,
    ownerSeesTile,
    pickFoodForLoss,
    pickpocketProfiles,
    pocketEffect,
    pocketOwnedActions,
    pocketTripStop,
    receiveFoodAtBank,
    refugeDue,
    replenishFarmFood,
    runBloodChest,
    runBloodChestSession,
    runGoldfarmKnights,
    runGoldfarmStableSession,
    runNatureChest,
    runPickpocketTrips,
    runPickpockets,
    runThievingCli,
    runThievingSession,
    selectFoodToEat,
    stallEffect,
    stallRecipes,
    stallSight,
    stallWatched,
    stealStall,
    validatePickpocketTrip,
    validatePocketOptions,
    walkBloodDungeon,
    withStallSightBlocker,
    withStallSightBlockers,
    type BloodDeps,
    type BloodOptions,
    type BloodResult,
    type BloodStop,
    type BloodZone,
    type ChestOptions,
    type KnightView,
    type NoKnight,
    type PickpocketTrip,
    type PocketOptions,
    type PocketProfile,
    type PocketSnapshot,
    type StallRecipe,
    type StallSight,
    type Tile as GoldfarmTile,
} from './thieving';
