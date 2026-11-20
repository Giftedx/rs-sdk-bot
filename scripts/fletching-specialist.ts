import { existsSync } from 'node:fs';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';
import {
    openHelperAndMain,
    skipTutorialFast,
    receiveTradeFast,
    finish,
    waitTicks,
    slotOfId,
} from './gathering-specialist-lib';

export const OBJ_HEADLESS_ARROW = 53;

export interface FletchArrowTier {
    readonly name: string;
    readonly tipId: number;
    readonly reqLevel: number;
    readonly xpPerAction: number;
    readonly supplyTips: number;
}

// 240 total actions across 7 stackable slots (arrows-only ladder, 25x curve).
export const FLETCHING_TIERS: readonly FletchArrowTier[] = [
    { name: 'bronze', tipId: 39, reqLevel: 1, xpPerAction: 487.5, supplyTips: 75 },
    { name: 'iron', tipId: 40, reqLevel: 15, xpPerAction: 937.5, supplyTips: 105 },
    { name: 'steel', tipId: 41, reqLevel: 30, xpPerAction: 1875, supplyTips: 150 },
    { name: 'mithril', tipId: 42, reqLevel: 45, xpPerAction: 2812.5, supplyTips: 240 },
    { name: 'adamant', tipId: 43, reqLevel: 60, xpPerAction: 3750, supplyTips: 510 },
    { name: 'rune', tipId: 44, reqLevel: 75, xpPerAction: 4687.5, supplyTips: 2640 },
];

export const FLETCHING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_HEADLESS_ARROW]: 3720,
    ...Object.fromEntries(FLETCHING_TIERS.map(t => [t.tipId, t.supplyTips])),
};

export function planFletchingActionCounts(): { actions: number; xp: number; byTier: Record<string, number> } {
    const goal = xpForLevel(99);
    let xp = 0;
    let actions = 0;
    const byTier: Record<string, number> = {};
    while (xp < goal) {
        const lvl = levelForXp(xp);
        const tier = [...FLETCHING_TIERS].reverse().find(t => lvl >= t.reqLevel)!;
        xp += tier.xpPerAction;
        actions++;
        byTier[tier.name] = (byTier[tier.name] ?? 0) + 1;
    }
    return { actions, xp, byTier };
}

export function pickNextFletchTier(xp: number, counts: Readonly<Record<number, number>>): FletchArrowTier | null {
    const lvl = levelForXp(xp);
    if ((counts[OBJ_HEADLESS_ARROW] ?? 0) < 15) return null;
    for (let i = FLETCHING_TIERS.length - 1; i >= 0; i--) {
        const tier = FLETCHING_TIERS[i]!;
        if (lvl >= tier.reqLevel && (counts[tier.tipId] ?? 0) >= 15) return tier;
    }
    return null;
}

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 200);
    if (!account) throw Error('usage: bun scripts/fletching-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let ok = false;
    let detail = '';

    try {
        const tutTicks = await skipTutorialFast(main, isStopped, helper);
        const tradeTicks = await receiveTradeFast(main, helper, FLETCHING_SPECIALIST_SUPPLIES, isStopped);
        const fletchStart = main.tick() - t0;

        let actionsSent = 0;
        const goalXp = xpForLevel(99);

        while (!isStopped()) {
            const lvl = main.sdk.getSkill('Fletching')?.baseLevel ?? 1;
            const xp = main.sdk.getSkillXp('Fletching') ?? 0;
            if (lvl >= 99 || xp >= goalXp) {
                ok = true;
                break;
            }

            const headlessSlot = slotOfId(main, OBJ_HEADLESS_ARROW);
            if (headlessSlot === undefined) throw Error('missing headless arrows after trade');

            const inv = main.sdk.getInventory();
            const counts: Record<number, number> = {};
            const slots: Record<number, number> = {};
            for (const item of inv) {
                counts[item.id] = (counts[item.id] ?? 0) + item.count;
                if (slots[item.id] === undefined) slots[item.id] = item.slot;
            }

            let simXp = xp;
            let burst = 0;
            while (burst < 5 && simXp < goalXp) {
                const tier = pickNextFletchTier(simXp, counts);
                if (!tier) break;
                const tipSlot = slots[tier.tipId];
                if (tipSlot === undefined) break;
                await main.direct({ type: 'useItemOnItem', sourceSlot: tipSlot, targetSlot: headlessSlot, reason: 'SDK' });
                counts[OBJ_HEADLESS_ARROW] = (counts[OBJ_HEADLESS_ARROW] ?? 0) - 15;
                counts[tier.tipId] = (counts[tier.tipId] ?? 0) - 15;
                simXp += tier.xpPerAction;
                burst++;
                actionsSent++;
            }
            if (burst === 0) throw Error(`stalled at xp=${xp} counts=${JSON.stringify(counts)}`);
            await waitTicks(main, 1);
        }

        const totalTicks = main.tick() - t0;
        const finalLvl = main.sdk.getSkill('Fletching')?.baseLevel ?? 0;
        const finalXp = main.sdk.getSkillXp('Fletching') ?? 0;
        ok = ok && finalLvl >= 99;
        detail = `level=${finalLvl} xp=${finalXp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} fletchStart=${fletchStart} actions=${actionsSent}`;
    } catch (error) {
        detail = String(error);
    }

    await finish([helper, main], ok, detail);
}
