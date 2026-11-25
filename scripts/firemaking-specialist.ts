import { existsSync } from 'node:fs';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';
import { openBot, finish } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { waitTicks } from '../packages/core/src/ticks';
import {
    skipTutorialFast,
    externalSupplierName,
    receiveTradeFast,
    startHelperTradeArm,
    rubTeleport,
    slotOfId,
} from './gathering-specialist-lib';

export const OBJ_TINDERBOX = 590;
export const OBJ_GLORY_IDS = [1712, 1710, 1708, 1706] as const;
export const OBJ_ENERGY_IDS = [3016, 3018, 3020, 3022, 3008, 3010, 3012, 3014] as const;
export const OBJ_LOGS = 1511;
export const OBJ_OAK_LOGS = 1521;
export const OBJ_WILLOW_LOGS = 1519;
export const OBJ_MAPLE_LOGS = 1517;
export const OBJ_YEW_LOGS = 1515;
export const OBJ_MAGIC_LOGS = 1513;

// Timing constants from firemaking.rs2 / WorldConfig.ts / drop.rs2:
// ground drops reveal to other players at +100t and despawn at +300t.
export const FM_REVEAL_TICKS = 100;
export const FM_DESPAWN_TICKS = 300;
export const FM_LIGHT_OPOBJ = 4;

export interface FiremakingTier {
    readonly name: string;
    readonly itemId: number;
    readonly reqLevel: number;
    readonly xp25x: number;
}

// XP from firemaking.obj productexp * 25 / 10.
export const FIREMAKING_TIERS: readonly FiremakingTier[] = [
    { name: 'normal', itemId: OBJ_LOGS, reqLevel: 1, xp25x: 1000 },
    { name: 'oak', itemId: OBJ_OAK_LOGS, reqLevel: 15, xp25x: 1500 },
    { name: 'willow', itemId: OBJ_WILLOW_LOGS, reqLevel: 30, xp25x: 2250 },
    { name: 'maple', itemId: OBJ_MAPLE_LOGS, reqLevel: 45, xp25x: 3375 },
    { name: 'yew', itemId: OBJ_YEW_LOGS, reqLevel: 60, xp25x: 5062.5 },
    { name: 'magic', itemId: OBJ_MAGIC_LOGS, reqLevel: 75, xp25x: 7595 },
];

// 160 distinct active-loc-free, danger-free tiles north of Lumbridge castle, BFS-verified door-free from (3222,3222)
// against collision-data.json WALK_BLOCKED, active locs (map_locaddunsafe), and aggressive NPC hunt ranges.
export const LUMBRIDGE_FM_PATH: readonly [number, number][] = [
    [3222, 3222], [3221, 3222], [3220, 3222], [3219, 3222],
    [3228, 3254], [3227, 3254], [3226, 3254], [3225, 3254], [3224, 3254], [3223, 3254], [3222, 3254], [3221, 3254], [3220, 3254], [3219, 3254], [3218, 3254], [3217, 3254], [3216, 3254], [3215, 3254], [3214, 3254], [3213, 3254], [3212, 3254], [3211, 3254], [3210, 3254], [3209, 3254], [3208, 3254], [3207, 3254], [3206, 3254], [3205, 3254], [3204, 3254], [3203, 3254], [3202, 3254], [3201, 3254], [3200, 3254], [3199, 3254], [3198, 3254], [3197, 3254], [3196, 3254], [3195, 3254], [3194, 3254], [3193, 3254], [3192, 3254], [3191, 3254], [3190, 3254], [3189, 3254],
    [3192, 3263], [3191, 3263], [3190, 3263], [3189, 3263], [3188, 3263], [3187, 3263], [3186, 3263], [3185, 3263], [3184, 3263], [3183, 3263], [3182, 3263], [3181, 3263], [3180, 3263], [3179, 3263], [3178, 3263], [3177, 3263], [3176, 3263], [3175, 3263], [3174, 3263], [3173, 3263], [3172, 3263], [3171, 3263], [3170, 3263], [3169, 3263], [3168, 3263], [3167, 3263], [3166, 3263], [3165, 3263], [3164, 3263], [3163, 3263], [3162, 3263], [3161, 3263], [3160, 3263], [3159, 3263], [3158, 3263], [3157, 3263], [3156, 3263], [3155, 3263], [3154, 3263], [3153, 3263], [3152, 3263], [3151, 3263], [3150, 3263], [3149, 3263],
    [3148, 3264], [3147, 3264], [3146, 3264], [3145, 3264], [3144, 3264], [3143, 3264], [3142, 3264], [3141, 3264], [3140, 3264], [3139, 3264], [3138, 3264], [3137, 3264], [3136, 3264], [3135, 3264], [3134, 3264], [3133, 3264], [3132, 3264], [3131, 3264], [3130, 3264], [3129, 3264], [3128, 3264], [3127, 3264], [3126, 3264], [3125, 3264], [3124, 3264], [3123, 3264], [3122, 3264], [3121, 3264], [3120, 3264], [3119, 3264], [3118, 3264], [3117, 3264], [3116, 3264], [3115, 3264], [3114, 3264], [3113, 3264], [3112, 3264], [3111, 3264], [3110, 3264], [3109, 3264], [3108, 3264], [3107, 3264], [3106, 3264], [3105, 3264], [3104, 3264], [3103, 3264], [3102, 3264], [3101, 3264], [3100, 3264], [3099, 3264], [3098, 3264], [3097, 3264], [3096, 3264], [3095, 3264], [3094, 3264], [3093, 3264], [3092, 3264], [3091, 3264], [3090, 3264], [3089, 3264],
    [3104, 3262], [3103, 3262], [3102, 3262], [3101, 3262], [3100, 3262], [3099, 3262], [3098, 3262], [3097, 3262], [3096, 3262], [3095, 3262], [3094, 3262], [3093, 3262],
];

export interface FiremakingPlanStep {
    readonly index: number;
    readonly itemId: number;
    readonly tier: string;
    readonly x: number;
    readonly z: number;
}

export function planFiremakingRoute(goalXp = xpForLevel(99)): {
    steps: FiremakingPlanStep[];
    counts: Record<number, number>;
    totalXp: number;
} {
    const steps: FiremakingPlanStep[] = [];
    const counts: Record<number, number> = {};
    let xp = 0;
    let idx = 0;
    while (xp < goalXp + 25 && idx < LUMBRIDGE_FM_PATH.length) {
        const lvl = levelForXp(xp);
        const tier = [...FIREMAKING_TIERS].reverse().find(t => lvl >= t.reqLevel)!;
        const [x, z] = LUMBRIDGE_FM_PATH[idx]!;
        steps.push({ index: idx, itemId: tier.itemId, tier: tier.name, x, z });
        counts[tier.itemId] = (counts[tier.itemId] ?? 0) + 1;
        xp += tier.xp25x;
        idx++;
        if (xp >= goalXp && idx >= 157 && steps.length < LUMBRIDGE_FM_PATH.length && xp < goalXp + 10) {
            // Buffer 1 extra Magic log in case fractional XP rounds 1 XP short.
            continue;
        }
        if (xp >= goalXp) break;
    }
    if (xp < goalXp) throw Error(`LUMBRIDGE_FM_PATH exhausted at xp=${xp}`);
    return { steps, counts, totalXp: xp };
}

export const FIREMAKING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = planFiremakingRoute().counts;

export function firemakingSupplierBatches(
    plan: readonly FiremakingPlanStep[],
    batchSize = 28,
): FiremakingPlanStep[][] {
    const batches: FiremakingPlanStep[][] = [];
    for (let i = 0; i < plan.length; i += batchSize) {
        batches.push(plan.slice(i, i + batchSize));
    }
    return batches;
}

export function buildFiremakingWaves(plan: readonly FiremakingPlanStep[]): FiremakingPlanStep[][] {
    const waves: FiremakingPlanStep[][] = [];
    if (plan.length === 0) return waves;
    waves.push(plan.slice(0, Math.min(27, plan.length)));
    for (let i = 27; i < plan.length; i += 26) {
        waves.push(plan.slice(i, i + 26));
    }
    return waves;
}

export interface FiremakingSupplierSaveConfig {
    readonly role: 'starter' | 'runner';
    readonly position: { readonly x: number; readonly z: number; readonly level: number };
    readonly inventory: { readonly id: number; readonly count: number }[];
    readonly bank: { readonly id: number; readonly count: number }[];
}

function aggregateItems(ids: readonly number[]): { id: number; count: number }[] {
    const counts = new Map<number, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

export function buildFiremakingSupplierConfigs(goalXp = xpForLevel(99)): FiremakingSupplierSaveConfig[] {
    const { steps: plan } = planFiremakingRoute(goalXp);
    const waves = buildFiremakingWaves(plan);
    const roles: readonly ('starter' | 'runner')[] = ['starter', 'runner'];
    return roles.map((role, rIdx) => {
        const mine = waves.filter((_, idx) => idx % 2 === rIdx);
        const first = mine[0] ?? [];
        const rest = mine.slice(1).flat().map(s => s.itemId);
        const inventory = first.map(s => ({ id: s.itemId, count: 1 }));
        inventory.push({ id: OBJ_GLORY_IDS[0], count: 1 });
        if (role === 'runner' && inventory.length < 28) {
            inventory.push({ id: OBJ_ENERGY_IDS[0], count: 1 });
        }
        const bank = aggregateItems(rest);
        bank.push({ id: OBJ_GLORY_IDS[0], count: 1 });
        bank.push({ id: OBJ_ENERGY_IDS[0], count: 2 });
        return {
            role,
            position: { x: 3223 + rIdx, z: 3222, level: 0 },
            inventory,
            bank,
        };
    });
}

export async function runFiremakingDropper(
    helper: Session,
    plan: readonly FiremakingPlanStep[],
    getLitIndex: () => number,
    stop: () => boolean,
    opts: {
        revealLeadTicks?: number;
        onWave1Ready?: () => void;
        dropAtTicks?: Map<number, number>;
        role?: 'all' | 'starter' | 'runner';
        tradeWave0?: (batch: readonly { id: number; count: number }[]) => Promise<boolean>;
        skipWave0?: boolean;
    } = {},
): Promise<void> {
    const role = opts.role ?? 'all';
    const waves = buildFiremakingWaves(plan);
    const assigned = waves
        .map((chunk, idx) => ({ idx, chunk }))
        .filter(({ idx }) => (role === 'starter' ? idx % 2 === 0 : role === 'runner' ? idx % 2 === 1 : true));
    if (assigned.length === 0) return;

    const pos = () => {
        const p = helper.sdk.getState()?.player;
        return p ? { x: p.worldX, z: p.worldZ, level: p.level } : { x: 0, z: 0, level: 0 };
    };
    const countItem = (id: number) =>
        helper.sdk.getInventory().filter(i => i.id === id).reduce((a, b) => a + b.count, 0);
    const hasGlory = () => OBJ_GLORY_IDS.some(id => countItem(id) > 0);

    const dropChunk = async (chunk: readonly FiremakingPlanStep[], onFirstDrop?: () => void) => {
        for (let i = 0; i < chunk.length && !stop(); i++) {
            const step = chunk[i]!;
            const next = chunk[i + 1];
            if (step.index >= 38) {
                while (!stop() && step.index - getLitIndex() > 52) {
                    const watchIdx = Math.min(plan.length - 1, Math.max(0, step.index - 22));
                    const watch = plan[watchIdx];
                    if (watch && (Math.abs(pos().x - watch.x) > 8 || Math.abs(pos().z - watch.z) > 8)) {
                        await helper.bot.walkTo(watch.x, watch.z, 3);
                    }
                    await waitTicks(helper, 1);
                }
            }
            while (!stop() && (pos().x !== step.x || pos().z !== step.z)) {
                await helper.bot.walkTo(step.x, step.z, 0);
                if (pos().x === step.x && pos().z === step.z) break;
                await waitTicks(helper, 1);
            }
            if (stop()) return;
            const slot = slotOfId(helper, step.itemId);
            if (slot === undefined) throw Error(`helper(${role}) missing log ${step.itemId} for step ${step.index}`);
            const n0 = helper.sdk.getInventory().length;
            if (next && Math.max(Math.abs(next.x - step.x), Math.abs(next.z - step.z)) <= 2) {
                await Promise.all([
                    helper.direct({ type: 'dropItem', slot, reason: 'SDK' }),
                    helper.direct({ type: 'walkTo', x: next.x, z: next.z, running: true, reason: 'SDK' }),
                ]);
            } else {
                await helper.direct({ type: 'dropItem', slot, reason: 'SDK' });
            }
            for (let k = 0; k < 6 && !stop() && helper.sdk.getInventory().length >= n0; k++) {
                await waitTicks(helper, 1);
            }
            opts.dropAtTicks?.set(step.index, helper.tick());
            if (i === 0) onFirstDrop?.();
        }
    };

    let firstDropTick = helper.tick();
    let signalled = false;

    for (let w = 0; w < assigned.length && !stop(); w++) {
        const { idx, chunk } = assigned[w]!;
        if (idx === 0) {
            if (!opts.skipWave0) {
                if (opts.tradeWave0) {
                    const traded = await opts.tradeWave0(aggregateItems(chunk.map(s => s.itemId)));
                    if (!traded) throw Error(`helper(${role}) failed to trade Wave 0 logs`);
                } else {
                    await dropChunk(chunk, () => { firstDropTick = helper.tick(); });
                }
            }
            if (!signalled) {
                signalled = true;
                opts.onWave1Ready?.();
            }
            continue;
        }
        const need = new Map<number, number>();
        for (const s of chunk) need.set(s.itemId, (need.get(s.itemId) ?? 0) + 1);
        const allInInv = [...need].every(([id, qty]) => countItem(id) >= qty);

        if (!allInInv) {
            if (hasGlory()) {
                await rubTeleport(
                    helper,
                    OBJ_GLORY_IDS,
                    /draynor/i,
                    p => p.level === 0 && p.worldX >= 3075 && p.worldX <= 3115 && p.worldZ >= 3230 && p.worldZ <= 3260,
                    stop,
                );
                await helper.bot.walkTo(3092, 3245, 2);
            } else {
                await helper.bot.walkTo(3269, 3167, 2);
            }
            await helper.bot.openBank();
            const bankKeep = new Set<number>([...OBJ_GLORY_IDS]);
            for (const it of helper.sdk.getInventory()) {
                if (!bankKeep.has(it.id) && !need.has(it.id)) {
                    await helper.bot.depositItem(it, it.count);
                }
            }
            if (!hasGlory()) {
                const gloryRow = OBJ_GLORY_IDS.map(id => helper.sdk.getState()?.bank?.items?.find(b => b.id === id)).find(Boolean);
                if (gloryRow && gloryRow.count > 0) {
                    await helper.bot.withdrawItem(gloryRow, 1, { asNote: false });
                }
            }
            for (const [id, qty] of need) {
                const have = countItem(id);
                if (have < qty) {
                    const row = helper.sdk.getState()?.bank?.items?.find(i => i.id === id);
                    if (!row || row.count < qty - have) throw Error(`helper(${role}) bank short of log ${id} (need ${qty - have})`);
                    await helper.bot.withdrawItem(row, qty - have, { asNote: false });
                }
            }
            await helper.bot.closeBank();
        }

        const firstStep = chunk[0]!;
        if (pos().x < 3130) {
            for (const [wx, wz] of [[3104, 3258], [3136, 3258]] as const) {
                while (!stop() && (Math.abs(pos().x - wx) > 5 || Math.abs(pos().z - wz) > 5)) {
                    await helper.bot.walkTo(wx, wz, 3);
                    if (Math.abs(pos().x - wx) <= 5 && Math.abs(pos().z - wz) <= 5) break;
                    await waitTicks(helper, 1);
                }
            }
        }
        while (!stop() && (Math.abs(pos().x - firstStep.x) > 4 || Math.abs(pos().z - firstStep.z) > 4)) {
            await helper.bot.walkTo(firstStep.x, firstStep.z, 2);
            if (Math.abs(pos().x - firstStep.x) <= 4 && Math.abs(pos().z - firstStep.z) <= 4) break;
            await waitTicks(helper, 1);
        }
        await dropChunk(chunk, w === 0 ? () => { firstDropTick = helper.tick(); } : undefined);
        if (!signalled) {
            signalled = true;
            opts.onWave1Ready?.();
        }
    }

    if (!signalled) {
        signalled = true;
        opts.onWave1Ready?.();
    }
    await helper.bot.walkTo(3235, 3235, 0).catch(() => {});
}

export async function serveFiremakingSupplier(
    helper: Session,
    targetName: string,
    role: 'all' | 'starter' | 'runner',
    stop: () => boolean,
    opts: {
        onWave1Ready?: () => void;
        tradeWave0?: (batch: readonly { id: number; count: number }[]) => Promise<boolean>;
    } = {},
): Promise<{ ok: boolean; detail: string }> {
    const { steps: plan } = planFiremakingRoute();
    const dropAtTicks = new Map<number, number>();
    const t0 = helper.tick();
    let estLit = 0;
    let lastAdvTick = t0;

    const getLitEstimate = () => {
        const st = helper.sdk.getState();
        const now = helper.tick();
        const target = (st?.nearbyPlayers ?? []).find(
            p => p.name.toLowerCase() === targetName.toLowerCase(),
        );
        if (target && target.worldX !== undefined && target.worldZ !== undefined) {
            // Restrict matching to a forward rate-bounded window so later crossing tiles cannot jump estLit early.
            const maxStep = Math.min(40, 6 + Math.floor(Math.max(0, now - lastAdvTick) / 4));
            const maxIdx = Math.min(plan.length - 1, estLit + maxStep);
            let bestIdx = -1;
            let bestD = Infinity;
            for (let idx = estLit; idx <= maxIdx; idx++) {
                const s = plan[idx]!;
                const d = Math.abs(s.x - target.worldX) + Math.abs(s.z - target.worldZ);
                if (d < bestD) { bestD = d; bestIdx = s.index; }
            }
            if (bestD <= 1 && bestIdx >= estLit) {
                if (bestIdx > estLit) lastAdvTick = now;
                estLit = bestIdx;
            }
        }
        const gItems = (st as { groundItems?: { id: number; x: number; z: number }[] } | undefined)?.groundItems ?? [];
        const hp = st?.player;
        if (hp) {
            for (const [idx, droppedTick] of dropAtTicks) {
                if (idx < estLit || idx > estLit + 6 || now < droppedTick + FM_REVEAL_TICKS + 20) continue;
                const s = plan[idx]!;
                if (Math.max(Math.abs(s.x - hp.worldX), Math.abs(s.z - hp.worldZ)) <= 6) {
                    const stillHere = gItems.some(g => g.id === s.itemId && g.x === s.x && g.z === s.z);
                    if (!stillHere) {
                        estLit = Math.max(estLit, idx + 1);
                        lastAdvTick = now;
                    }
                }
            }
        }
        return estLit;
    };

    try {
        await runFiremakingDropper(helper, plan, getLitEstimate, stop, {
            dropAtTicks,
            role,
            tradeWave0: opts.tradeWave0,
            onWave1Ready: opts.onWave1Ready,
        });
        return { ok: true, detail: `dropped ${plan.length} logs (${role}) in ${helper.tick() - t0}t` };
    } catch (err) {
        return { ok: false, detail: String(err) };
    }
}

async function dropNonTinderboxTutorialJunk(main: Session, stop: () => boolean): Promise<void> {
    for (let tick = 0; tick < 10 && !stop(); tick++) {
        let keptTinderbox = false;
        const toDrop = main.sdk.getInventory().filter(it => {
            if (!keptTinderbox && it.id === OBJ_TINDERBOX) {
                keptTinderbox = true;
                return false;
            }
            return true;
        });
        if (toDrop.length === 0) return;
        await Promise.all(toDrop.slice(0, 5).map(it => main.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
        if (toDrop.length > 5) await waitTicks(main, 1);
    }
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const roleArg = argv.find(a => a.startsWith('--role='))?.slice(7);
    const isSupplierMode = argv.includes('--supplier') || !!roleArg || !!process.env.SUPPLIER_ROLE;
    const posArgs = argv.filter(a => !a.startsWith('-'));
    const { steps: plan } = planFiremakingRoute();
    const waves = buildFiremakingWaves(plan);
    const wave0 = waves[0] ?? [];
    const wave0Counts = Object.fromEntries(aggregateItems(wave0.map(s => s.itemId)).map(x => [x.id, x.count]));
    const wave0Ids = new Set(wave0.map(s => s.itemId));

    if (isSupplierMode) {
        const helperName = posArgs[0];
        const targetName = posArgs[1];
        const cap = Number(posArgs[2] ?? process.env.CAP ?? 1200);
        if (!helperName || !targetName) throw Error('usage: bun scripts/firemaking-specialist.ts <helper> --supplier <target> [cap]');
        const helper = await openBot(helperName);
        const t0 = helper.tick();
        const stop = () => existsSync(`.practice/stop-${helperName}`) || existsSync('.practice/stop-all') || helper.tick() - t0 >= cap;
        const roleRaw = roleArg ?? process.env.SUPPLIER_ROLE;
        const roleEnv = roleRaw === 'starter'
            ? 'starter'
            : roleRaw === 'runner'
                ? 'runner'
                : 'all';
        const res = await serveFiremakingSupplier(helper, targetName, roleEnv, stop, {
            onWave1Ready: () => {
                console.log(`SUPPLIER_READY ${JSON.stringify({ helper: helperName, target: targetName, tile: LUMBRIDGE_FM_PATH[0], reveal: FM_REVEAL_TICKS })}`);
            },
        });
        await finish([helper], res.ok, res.detail);
        process.exit(res.ok ? 0 : 1);
    }

    const account = posArgs[0];
    const helperTokens = posArgs.slice(1).filter(a => !a.includes('='))
        .flatMap(t => t.split(',').map(x => x.trim()).filter(Boolean));
    const helperNames = helperTokens.length > 0
        ? helperTokens
        : (process.env.HELPER ?? `${account}b`).split(',').map(x => x.trim()).filter(Boolean);
    const cap = Number(process.env.CAP ?? 900);
    if (!account) throw Error('usage: bun scripts/firemaking-specialist.ts <account> [helperAccount...]');

    const extSuppliers = externalSupplierName();
    const helpers: Session[] = [];
    let stopFlag = false;
    let litIdx = 0;
    let helperTail: Promise<void> = Promise.resolve();
    let resolveStarterDrop!: () => void;
    const startStarterDrop = new Promise<void>(res => { resolveStarterDrop = res; });

    if (!extSuppliers) {
        for (const hName of helperNames) {
            helpers.push(await openBot(hName, { onStop: async () => { stopFlag = true; } }));
        }
        if (helpers.length >= 2) {
            const runnerTail = runFiremakingDropper(helpers[1]!, plan, () => litIdx, () => stopFlag, { role: 'runner' });
            const starterTail = startStarterDrop.then(() =>
                stopFlag ? undefined : runFiremakingDropper(helpers[0]!, plan, () => litIdx, () => stopFlag, { role: 'starter', skipWave0: true }),
            );
            helperTail = Promise.all([runnerTail, starterTail]).then(() => undefined);
            void helperTail.catch(err => console.log(`WARN helper: ${String(err)}`));
        } else {
            helperTail = startStarterDrop.then(() =>
                stopFlag ? undefined : runFiremakingDropper(helpers[0]!, plan, () => litIdx, () => stopFlag, { skipWave0: true }),
            );
            void helperTail.catch(err => console.log(`WARN helper: ${String(err)}`));
        }
    } else {
        const preWaitTicks = Number(process.env.FM_PREWAIT_TICKS ?? '0');
        const preWaitMs = Number(
            process.env.FM_PREWAIT_MS
                ?? (preWaitTicks > 0 ? String(preWaitTicks * (process.env.SIM_LOCKSTEP === '1' ? 75 : 400)) : '0'),
        );
        if (preWaitMs > 0) await Bun.sleep(preWaitMs);
    }

    const main = await openBot(account, { onStop: async () => { stopFlag = true; } });
    const t0 = main.tick();
    const isStopped = () => stopFlag || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let ok = false;
    let detail = '';

    const starterSupplierName = extSuppliers?.split(',').map(x => x.trim()).find(Boolean);
    const localArm = !extSuppliers && helpers[0]
        ? startHelperTradeArm(helpers[0], main.name, isStopped, () => true, wave0Ids)
        : undefined;

    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropNonTinderboxTutorialJunk(main, isStopped);
        const tradeTicks = await receiveTradeFast(main, helpers[0], wave0Counts, isStopped, localArm, undefined, starterSupplierName);
        localArm?.close();
        resolveStarterDrop();
        let lastRunClickTick = -10;
        const ensureRunOn = async () => {
            const p = main.sdk.getState()?.player;
            if (!p || p.runEnergy <= 0) return;
            const on = ((main.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) === 1;
            const t = main.tick();
            if (!on && t - lastRunClickTick >= 2) {
                lastRunClickTick = t;
                await main.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
            }
        };
        let waitLogs = 0;

        await ensureRunOn();
        for (let i = 0; i < plan.length && !isStopped(); i++) {
            const lvl = main.sdk.getSkill('Firemaking')?.baseLevel ?? 1;
            if (lvl >= 99 || (main.sdk.getSkillXp('Firemaking') ?? 0) >= xpForLevel(99)) {
                ok = true;
                break;
            }
            const step = plan[i]!;
            litIdx = i;

            const groundHas = () =>
                ((main.sdk.getState() as { groundItems?: { id: number; x: number; z: number }[] } | undefined)?.groundItems ?? []).some(
                    g => g.id === step.itemId && g.x === step.x && g.z === step.z,
                );
            const beforeXp = main.sdk.getSkillXp('Firemaking') ?? 0;

            if (i < wave0.length) {
                const prevStep = i > 0 ? plan[i - 1]! : undefined;
                while (!isStopped()) {
                    const p = main.sdk.getState()?.player;
                    if (p && p.worldX === step.x && p.worldZ === step.z) break;
                    if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                        await main.direct({ type: 'closeModal', reason: 'SDK' });
                    }
                    // On consecutive West steps, ~push_player moves spec onto step.x during the p_delay(0) tick.
                    if (prevStep && prevStep.x - 1 === step.x && prevStep.z === step.z && p?.worldX === prevStep.x && p?.worldZ === prevStep.z) {
                        await waitTicks(main, 1);
                        continue;
                    }
                    await main.bot.walkTo(step.x, step.z, 0);
                }
                if (isStopped()) break;
                const tboxSlot = slotOfId(main, OBJ_TINDERBOX);
                const logSlot = slotOfId(main, step.itemId);
                if (tboxSlot === undefined || logSlot === undefined) {
                    throw Error(`missing tinderbox/log for Wave 0 step ${step.index} tbox=${tboxSlot} log=${logSlot}`);
                }
                const lightInvOp = {
                    type: 'useItemOnItem',
                    sourceSlot: tboxSlot,
                    targetSlot: logSlot,
                    reason: 'SDK',
                } as const;
                if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                    await Promise.all([
                        main.direct({ type: 'closeModal', reason: 'SDK' }),
                        main.direct(lightInvOp),
                    ]);
                } else {
                    await main.direct(lightInvOp);
                }
                if (i === wave0.length - 1) console.log(`PHASE fm_wave0_end tick=${main.tick() - t0}`);
            } else {
                while (!groundHas() && !isStopped()) {
                    waitLogs++;
                    if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                        await main.direct({ type: 'closeModal', reason: 'SDK' });
                    }
                    await waitTicks(main, 1);
                }
                if (isStopped()) break;

                const lightOp = {
                    type: 'interactGroundItem',
                    x: step.x,
                    z: step.z,
                    itemId: step.itemId,
                    optionIndex: FM_LIGHT_OPOBJ,
                    reason: 'SDK',
                } as const;
                if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                    await Promise.all([
                        main.direct({ type: 'closeModal', reason: 'SDK' }),
                        main.direct(lightOp),
                    ]);
                } else {
                    await main.direct(lightOp);
                }
            }

            const lightGroundOp = {
                type: 'interactGroundItem',
                x: step.x,
                z: step.z,
                itemId: step.itemId,
                optionIndex: FM_LIGHT_OPOBJ,
                reason: 'SDK',
            } as const;
            const sentTick = main.tick();
            const isGroundStep = i >= wave0.length;
            const nextStep = plan[i + 1];
            const turnNext = !!nextStep && (nextStep.z !== step.z || nextStep.x !== step.x - 1);
            let wasOnTile = false;

            while (!isStopped() && (main.sdk.getSkillXp('Firemaking') ?? 0) === beforeXp) {
                const p0 = main.sdk.getState()?.player;
                if (p0 && p0.worldX === step.x && p0.worldZ === step.z) wasOnTile = true;
                await waitTicks(main, 1);
                if ((main.sdk.getSkillXp('Firemaking') ?? 0) !== beforeXp) break;
                const pNow = main.sdk.getState()?.player;
                if (isGroundStep && turnNext && wasOnTile && pNow && (pNow.worldX !== step.x || pNow.worldZ !== step.z)) {
                    // ~push_player moves spec off step.x one tick before XP arrives; dispatch next row turn immediately.
                    if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
                        await main.direct({ type: 'closeModal', reason: 'SDK' });
                    }
                    break;
                }
                const dlgOpen = !!(main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen);
                const elapsed = main.tick() - sentTick;
                if (elapsed === 12) {
                    const st = main.sdk.getState() as { player?: { worldX: number; worldZ: number }; gameMessages?: { text: string }[] } | undefined;
                    console.log(`NOTE stall step=${step.index} at=(${step.x},${step.z}) me=(${st?.player?.worldX},${st?.player?.worldZ}) ground=${groundHas()} lvl=${main.sdk.getSkill('Firemaking')?.baseLevel} msgs=${(st?.gameMessages ?? []).slice(-3).map(m => m.text).join('|')}`);
                }
                const retryInvSlot = !groundHas() && !isGroundStep && elapsed >= 1 ? slotOfId(main, step.itemId) : undefined;
                const retryTboxSlot = retryInvSlot !== undefined ? slotOfId(main, OBJ_TINDERBOX) : undefined;
                const retryOp = groundHas()
                    ? lightGroundOp
                    : retryInvSlot !== undefined && retryTboxSlot !== undefined
                        ? { type: 'useItemOnItem', sourceSlot: retryTboxSlot, targetSlot: retryInvSlot, reason: 'SDK' } as const
                        : null;
                if (dlgOpen && retryOp) {
                    await Promise.all([
                        main.direct({ type: 'closeModal', reason: 'SDK' }),
                        main.direct(retryOp),
                    ]);
                } else if (dlgOpen) {
                    await main.direct({ type: 'closeModal', reason: 'SDK' });
                } else if ((elapsed === 1 || (elapsed >= 3 && elapsed % 3 === 0)) && retryOp) {
                    await main.direct(retryOp);
                }
            }
            if ((main.sdk.getSkill('Firemaking')?.baseLevel ?? 1) >= 99) {
                ok = true;
                break;
            }
        }

        if ((main.sdk.getSkill('Firemaking')?.baseLevel ?? 1) >= 99) ok = true;
        if (main.sdk.getState()?.dialog?.isOpen || main.sdk.getState()?.modalOpen) {
            await main.direct({ type: 'closeModal', reason: 'SDK' });
        }
        stopFlag = true;
        await Promise.race([helperTail, waitTicks(main, 2).catch(() => {})]);
        const totalTicks = main.tick() - t0;
        const finalLvl = main.sdk.getSkill('Firemaking')?.baseLevel ?? 0;
        const finalXp = main.sdk.getSkillXp('Firemaking') ?? 0;
        ok = ok && finalLvl >= 99;
        detail = `level=${finalLvl} xp=${finalXp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} lit=${litIdx + 1} waitLogs=${waitLogs}`;
    } catch (error) {
        localArm?.close();
        resolveStarterDrop();
        stopFlag = true;
        detail = String(error);
    }

    await finish([...helpers, main], ok, detail);
}
