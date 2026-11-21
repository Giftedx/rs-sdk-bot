import { existsSync } from 'node:fs';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';
import {
    openHelperAndMain,
    skipTutorialFast,
    startHelperTradeArm,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    finish,
    waitTicks,
    slotOfId,
    itemQty,
    OBJ_DUELING_8,
    RING_OF_DUELING_IDS,
} from './gathering-specialist-lib';

export const OBJ_UNFERMENTED_WINE = 1995;
export const OBJ_CERT_UNFERMENTED_WINE = 1996;
export const OBJ_UNFINISHED_FRUIT_BLAST = 2082;
export const OBJ_LEMON_SLICES = 2106;
export const OBJ_FRUIT_BLAST = 2084;

// wine.rs2: 1100 tenths * 25x = 2,750 XP per fermented wine; fermenting_wine fires in 15 batches.
export const COOKING_WINE_XP_25X = 2750;
export const COOKING_COCKTAIL_XP_25X = 1500;
export const COOKING_WINE_BATCHES = 15;
// Engine floor: login.rs2/wine.rs2 sets fermenting_wine at +20t; RankedHiscoresWorker breaks (99, 20) ties on account_id ASC.
export const COOKING_FERMENT_TICKS = 20;

export const COOKING_SPECIALIST_WINES = 6000;
export const COOKING_SPECIALIST_COCKTAILS = 4;

export const CASTLE_WARS_BANK_CHEST = { id: 4483, x: 2444, z: 3083, optionIndex: 1 } as const;

// Fits in 10 free tutorial slots (1 noted wine + 1 dueling ring + 4 unfinished cocktails + 4 lemon slices).
export const COOKING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_CERT_UNFERMENTED_WINE]: COOKING_SPECIALIST_WINES,
    [OBJ_DUELING_8]: 1,
    [OBJ_UNFINISHED_FRUIT_BLAST]: COOKING_SPECIALIST_COCKTAILS,
    [OBJ_LEMON_SLICES]: COOKING_SPECIALIST_COCKTAILS,
};

export function minBankedWinesForSingleBatch99(goalXp = xpForLevel(99)): number {
    return Math.ceil(goalXp / COOKING_WINE_XP_25X) * COOKING_WINE_BATCHES;
}

export function cookingWineBatchOdds(cookingLevel: number): number {
    // wine.rs2 rolls stat_random(cooking, 48, 352) per batch of floor(bank_total / 15).
    const low = 48;
    const high = 352;
    const lvl = Math.max(1, Math.min(99, cookingLevel));
    const chance = Math.floor((low * (99 - lvl)) / 98 + (high * (lvl - 1)) / 98) + 1;
    return Math.min(1, Math.max(0, chance / 256));
}

export function planCookingSummary(cocktails = COOKING_SPECIALIST_COCKTAILS, wines = COOKING_SPECIALIST_WINES): {
    cocktailXp: number;
    boostedLevel: number;
    perBatchWines: number;
    perBatchXp: number;
    batchOdds: number;
    allFailProb: number;
    minTotalWines: number;
} {
    const cocktailXp = cocktails * COOKING_COCKTAIL_XP_25X;
    const boostedLevel = levelForXp(cocktailXp);
    const perBatchWines = Math.floor(wines / COOKING_WINE_BATCHES);
    const perBatchXp = perBatchWines * COOKING_WINE_XP_25X;
    const batchOdds = cookingWineBatchOdds(boostedLevel);
    const allFailProb = Math.pow(1 - batchOdds, COOKING_WINE_BATCHES);
    return {
        cocktailXp,
        boostedLevel,
        perBatchWines,
        perBatchXp,
        batchOdds,
        allFailProb,
        minTotalWines: minBankedWinesForSingleBatch99(),
    };
}

const inCastleWars = (p: { level: number; worldX: number; worldZ: number }): boolean =>
    p.level === 0 && p.worldX >= 2430 && p.worldX <= 2455 && p.worldZ >= 3075 && p.worldZ <= 3105;

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 120);
    if (!account) throw Error('usage: bun scripts/cooking-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let ok = false;
    let detail = '';
    let helperSettled = false;

    const arm = startHelperTradeArm(helper, main.name, isStopped);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        const tradeTicks = await receiveTradeFast(
            main,
            helper,
            COOKING_SPECIALIST_SUPPLIES,
            isStopped,
            arm,
            { [OBJ_DUELING_8]: RING_OF_DUELING_IDS },
        );
        const helperDone = settleHelper(helper).then(() => { helperSettled = true; }).catch(() => {});

        await rubTeleport(main, RING_OF_DUELING_IDS, /castle wars/i, inCastleWars, isStopped);
        const tpTicks = main.tick() - t0;

        // Open Castle Wars bank chest directly and deposit noted unfermented wines before fermenting_wine at tick 20.
        let chestClicked = false;
        for (let attempt = 0; attempt < 15 && !isStopped() && !main.sdk.getState()?.bank?.isOpen; attempt++) {
            const chest = (main.sdk.getState()?.nearbyLocs ?? []).find(
                l => l.id === CASTLE_WARS_BANK_CHEST.id || /bank chest/i.test(l.name),
            );
            if (!chestClicked || attempt % 8 === 0) {
                chestClicked = true;
                const x = chest?.x ?? CASTLE_WARS_BANK_CHEST.x;
                const z = chest?.z ?? CASTLE_WARS_BANK_CHEST.z;
                const locId = chest?.id ?? CASTLE_WARS_BANK_CHEST.id;
                const op = chest?.optionsWithIndex?.find(o => /use|bank/i.test(o.text))?.opIndex ?? CASTLE_WARS_BANK_CHEST.optionIndex;
                await main.direct({ type: 'interactLoc', x, z, locId, optionIndex: op, reason: 'SDK' });
            }
            await waitTicks(main, 1);
        }
        if (!main.sdk.getState()?.bank?.isOpen) throw Error('failed to open Castle Wars bank chest before ferment tick');

        const wineSlot = slotOfId(main, OBJ_CERT_UNFERMENTED_WINE);
        const wineCount = itemQty(main, OBJ_CERT_UNFERMENTED_WINE);
        if (wineSlot === undefined || wineCount < minBankedWinesForSingleBatch99()) {
            throw Error(`insufficient noted unfermented wine count=${wineCount}`);
        }

        // Deposit all noted unfermented wines (-1 = INV_BUTTON4) and close bank in the same tick, then mix Fruit Blasts.
        await Promise.all([
            main.direct({ type: 'bankDeposit', slot: wineSlot, amount: -1, reason: 'SDK' }),
            main.direct({ type: 'closeModal', reason: 'SDK' }),
        ]);
        await waitTicks(main, 1);
        if (itemQty(main, OBJ_CERT_UNFERMENTED_WINE) > 0) throw Error('failed to deposit noted unfermented wine');
        const bankTicks = main.tick() - t0;

        const inv = main.sdk.getInventory();
        const bases = inv.filter(i => i.id === OBJ_UNFINISHED_FRUIT_BLAST).map(i => i.slot);
        const slices = inv.filter(i => i.id === OBJ_LEMON_SLICES).map(i => i.slot);
        const mixCount = Math.min(COOKING_SPECIALIST_COCKTAILS, bases.length, slices.length);
        if (mixCount > 0) {
            const mixActs: Promise<unknown>[] = [];
            for (let i = 0; i < mixCount; i++) {
                mixActs.push(main.direct({ type: 'useItemOnItem', sourceSlot: slices[i]!, targetSlot: bases[i]!, reason: 'SDK' }));
            }
            await Promise.all(mixActs);
            await waitTicks(main, 1);
        }

        while (!isStopped()) {
            const lvl = main.sdk.getSkill('Cooking')?.baseLevel ?? 1;
            const xp = main.sdk.getSkillXp('Cooking') ?? 0;
            if (lvl >= 99 || xp >= xpForLevel(99)) {
                ok = true;
                break;
            }
            const st = main.sdk.getState();
            if (st?.dialog?.isOpen || st?.modalOpen) {
                await main.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await waitTicks(main, 1);
        }

        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }

        await helperDone;
        const totalTicks = main.tick() - t0;
        const finalLvl = main.sdk.getSkill('Cooking')?.baseLevel ?? 0;
        const finalXp = main.sdk.getSkillXp('Cooking') ?? 0;
        ok = ok && finalLvl >= 99;
        detail = `level=${finalLvl} xp=${finalXp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} tp=${tpTicks} bank=${bankTicks} cocktails=${mixCount}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await finish(helperSettled || !helper ? [main] : [helper, main], ok, detail);
}
