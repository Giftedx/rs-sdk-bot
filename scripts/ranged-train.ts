// Thin compatibility facade for progressive ranged training over packages/workers/src/combat/ranged.
import { finish, openBot } from '../packages/core/src/bot';
import {
    ARROWS,
    BOWS,
    MIN_TRIP_ARROWS,
    arrowAccount,
    bestBow,
    buyChunk,
    chooseArrow,
    chooseRangedDecision,
    isRangedAcquireMethod,
    needsRangedRecovery,
    openShopWithDoor,
    preparationFunds,
    rangedAccountObservation,
    rangedBandTarget,
    rangedComparisonMethod,
    rangedEntry,
    rangedKit,
    rangedTrainOptions as combatRangedTrainOptions,
    recoverRangedStart,
    recoveryBank,
    recoveryWalker,
    runAdaptiveRanged as combatRunAdaptiveRanged,
    runRangedTrain,
    usableArrows,
    type RangedAdaptiveDeps,
    type RangedObservedAccount,
    type RangedProgressionDecision,
    type RangedTrainOptions,
} from '../packages/workers/src/combat';

export const RANGED_METHOD_IDS = [
    'ranged/lowe-buy-shortbow',
    'ranged/lowe-buy-oak',
    'ranged/lowe-buy-bronze',
    'ranged/lowe-buy-iron',
    'ranged/lowe-buy-steel',
    'ranged/guild-buy-willow',
    'ranged/guild-buy-mithril',
    'ranged/ge-buy-willow',
    'ranged/ge-buy-mithril',
    'ranged/ge-buy-maple',
    'ranged/chickens',
    'ranged/chickens-oak',
    'ranged/troopers',
    'ranged/troopers-oak',
    'ranged/troopers-willow',
    'ranged/troopers-maple',
    'ranged/guild-willow-mithril',
] as const;

export function rangedTrainOptions(env: Record<string, string | undefined>, argv: string[]): RangedTrainOptions {
    return combatRangedTrainOptions(env, argv);
}

export const RANGED_ADAPTIVE_DEPS: Omit<RangedAdaptiveDeps, 'comparison'> = {
    rangedBandTarget,
    rangedKit,
};

export function runAdaptiveRanged(
    s: Parameters<typeof combatRunAdaptiveRanged>[0],
    o: RangedTrainOptions,
    options: RangedAdaptiveDeps = {},
) {
    return combatRunAdaptiveRanged(s, o, {
        ...RANGED_ADAPTIVE_DEPS,
        ...options,
    });
}

export {
    ARROWS,
    BOWS,
    MIN_TRIP_ARROWS,
    arrowAccount,
    bestBow,
    buyChunk,
    chooseArrow,
    chooseRangedDecision,
    isRangedAcquireMethod,
    needsRangedRecovery,
    openShopWithDoor,
    preparationFunds,
    rangedAccountObservation,
    rangedBandTarget,
    rangedComparisonMethod,
    rangedEntry,
    rangedKit,
    recoverRangedStart,
    recoveryBank,
    recoveryWalker,
    runRangedTrain,
    usableArrows,
    type RangedAdaptiveDeps,
    type RangedObservedAccount,
    type RangedProgressionDecision,
    type RangedTrainOptions,
};

if (import.meta.main) {
    let stopped = false;
    const s = await openBot(process.argv[2]!, { onStop: async () => { stopped = true; } });
    try {
        const comparison = rangedComparisonMethod(
            process.env.RANGED_COMPARE_METHOD,
            s.lifecycle?.server ?? new URL(s.sdk.config.browserLaunchUrl).host,
        );
        const r = await runAdaptiveRanged(s, { ...rangedTrainOptions(process.env, process.argv), stop: () => stopped }, { comparison });
        console.log('RANGED_TRAIN_RESULT ' + JSON.stringify(r));
        await finish(
            [s],
            r.ok,
            (r.ok ? 'mode=ranged-train ' : r.stop === 'stop-file' ? 'stop file ' : 'no Ranged progress: ') + JSON.stringify(r),
        );
    } catch (e) {
        await finish([s], false, 'no Ranged progress: ' + String(e));
    }
}
