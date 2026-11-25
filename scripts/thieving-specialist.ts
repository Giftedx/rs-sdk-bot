import { existsSync } from 'node:fs';
import {
    openBot,
    finish,
    logoutSession,
    closeWithin,
    waitTicks,
    skipTutorialFast,
    dropTutorialJunk,
    startHelperTradeArm,
    externalSupplierName,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    sailBrimhavenToArdougne,
    eatAnyFood,
    hasAnyFood,
    foodBitesCount,
    isLiveSupplyVariant,
    itemQty,
    chebDist,
    OBJ_COINS,
    OBJ_CHOCOLATE_CAKE,
    OBJ_GLORY_4,
    OBJ_DUELING_8,
    RING_OF_DUELING_IDS,
    OBJ_SUPER_ENERGY_4,
    OBJ_PINEAPPLE_PIZZA,
} from './gathering-specialist-lib';
import type { Session } from '../packages/core/src/inprocess';

export const THIEVING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export const THIEVING_PIZZAS = 25;
export const THIEVING_CAKES = 26;

export const THIEVING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_GLORY_4]: 1,
    [OBJ_COINS]: 200,
    [OBJ_SUPER_ENERGY_4]: 1,
    [OBJ_PINEAPPLE_PIZZA]: THIEVING_PIZZAS,
};

// Live-stockable variant: Ring of dueling(8) + Super energy(4) + 26 Chocolate cakes (local stockable, 0 Glory / 0 Pineapple pizza).
export const THIEVING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_DUELING_8]: 1,
    [OBJ_SUPER_ENERGY_4]: 1,
    [OBJ_CHOCOLATE_CAKE]: THIEVING_CAKES,
};

export const THIEVING_DIRECT_CWARS_WAYPOINTS: readonly [number, number, number][] = [
    [2455, 3168, 4],
    [2476, 3197, 3],
    [2486, 3214, 3],
    [2506, 3233, 4],
    [2555, 3236, 4],
    [2602, 3276, 4],
    [2621, 3293, 2],
];

const BAKERS_STALL_SAFE_CENTER = { x: 2667, z: 3310 };
const BAKERS_STALL_SIDE_OFFSETS: readonly [number, number][] = [
    [2, 0], [2, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [0, 2], [1, 2],
];

/** Steal an emergency food buffer from an Ardougne Baker's stall using native sight + walkability checks. */
async function stealEmergencyStallFood(main: Session, stop: () => boolean, targetBites = 4, maxSteals = 4): Promise<boolean> {
    const startBites = foodBitesCount(main);
    const curPos = main.sdk.getState()?.player;
    if (curPos && chebDist({ x: curPos.worldX, z: curPos.worldZ }, BAKERS_STALL_SAFE_CENTER) > 8) {
        await walkWaypointsSafe(main, [[2662, 3305, 2], [BAKERS_STALL_SAFE_CENTER.x + 2, BAKERS_STALL_SAFE_CENTER.z, 1]], stop);
    }
    const pf = await import('../vendor/rs-sdk/sdk/pathfinding').catch(() => undefined);
    if (pf) {
        const { loadPathfinding } = await import('../packages/core/src/pathcache');
        await loadPathfinding();
    }
    const { stallRecipes, stallSight, stallWatched } = await import('../packages/workers/src/gather');
    const bakeryRecipe = stallRecipes().find(r => r.name === 'stealing_bakery_stall');
    const sight = bakeryRecipe ? await stallSight(main, bakeryRecipe) : undefined;
    const blockedTiles = new Set<string>();
    let noTileStreak = 0;

    for (let step = 0, steals = 0; step < 36 && steals < maxSteals && !stop() && foodBitesCount(main) < targetBites && main.sdk.getInventory().length < 28; step++) {
        const st = main.sdk.getState();
        const me = st?.player;
        if (!st || !me) {
            await waitTicks(main, 1);
            continue;
        }
        const stalls = st.nearbyLocs
            .filter(l => /^baker'?s stall$/i.test(l.name) && l.x >= 2664 && l.optionsWithIndex.some(o => /steal/i.test(o.text)));
        const useStalls = stalls.length > 0 ? stalls : st.nearbyLocs.filter(l => /^baker'?s stall$/i.test(l.name) && l.optionsWithIndex.some(o => /steal/i.test(o.text)));
        if (useStalls.length === 0) {
            await waitTicks(main, 1);
            continue;
        }
        const watchers = st.nearbyNpcs.filter(n => /^(guard|baker)$/i.test(n.name));
        const tileWatched = (x: number, z: number) => bakeryRecipe && sight
            ? stallWatched(bakeryRecipe, { worldX: x, worldZ: z, level: me.level ?? 0 }, st.nearbyNpcs, sight)
            : watchers.some(w => chebDist({ x: w.x, z: w.z }, { x, z }) <= 5);
        const candidates = useStalls.flatMap(stall =>
            BAKERS_STALL_SIDE_OFFSETS
                .map(([dx, dz]) => ({ stall, x: stall.x + dx, z: stall.z + dz }))
                .filter(t => !blockedTiles.has(`${t.x},${t.z}`))
                .filter(t => !pf || pf.isTileWalkable(me.level ?? 0, t.x, t.z))
                .filter(t => !tileWatched(t.x, t.z)),
        ).sort((a, b) => chebDist(a, { x: me.worldX, z: me.worldZ }) - chebDist(b, { x: me.worldX, z: me.worldZ }));
        const pick = candidates[0];
        if (!pick) {
            if (++noTileStreak >= 6) break;
            await waitTicks(main, 1);
            continue;
        }
        noTileStreak = 0;
        if (me.worldX !== pick.x || me.worldZ !== pick.z) {
            const walkRes = await main.bot.walkTo(pick.x, pick.z, 0);
            const after = main.sdk.getState()?.player;
            if (!walkRes.success || (after?.worldX === me.worldX && after?.worldZ === me.worldZ)) {
                blockedTiles.add(`${pick.x},${pick.z}`);
            }
            continue;
        }
        if (tileWatched(me.worldX, me.worldZ)) {
            await waitTicks(main, 1);
            continue;
        }
        const op = pick.stall.optionsWithIndex.find(o => /steal/i.test(o.text));
        if (!op) break;
        const before = foodBitesCount(main);
        steals++;
        await main.direct({ type: 'interactLoc', x: pick.stall.x, z: pick.stall.z, locId: pick.stall.id, optionIndex: op.opIndex, reason: 'SDK' });
        for (let w = 0; w < 4 && !stop() && foodBitesCount(main) === before; w++) {
            await waitTicks(main, 1);
        }
    }
    return foodBitesCount(main) > startBites || foodBitesCount(main) >= targetBites;
}

export interface PickpocketTier {
    readonly name: string;
    readonly minLevel: number;
    readonly stunDamage: number;
    readonly pattern: RegExp;
    readonly anchor: { readonly x: number; readonly z: number };
}

export const ARDOUGNE_PICKPOCKET_TIERS: readonly PickpocketTier[] = [
    { name: 'man', minLevel: 1, stunDamage: 1, pattern: /^(man|woman)$/i, anchor: { x: 2661, z: 3306 } },
    { name: 'warrior', minLevel: 25, stunDamage: 2, pattern: /^warrior woman$/i, anchor: { x: 2629, z: 3295 } },
    { name: 'guard', minLevel: 40, stunDamage: 2, pattern: /^guard$/i, anchor: { x: 2661, z: 3306 } },
    { name: 'knight', minLevel: 55, stunDamage: 3, pattern: /^knight of ardougne$/i, anchor: { x: 2661, z: 3306 } },
];

interface MarketStallSpec {
    readonly recipeName: string;
    readonly minLevel: number;
    readonly locPattern: RegExp;
    readonly maxX: number;
    readonly lootIds: readonly number[];
    readonly anchor: { readonly x: number; readonly z: number };
    readonly offsets: readonly [number, number][];
}

// Ardougne Market stalls unlocked across Lv 5..54 (0 stun, 0 relog, 3t cycle).
const MARKET_STALLS: readonly MarketStallSpec[] = [
    {
        recipeName: 'stealing_silver_stall',
        minLevel: 50,
        locPattern: /^silver stall$/i,
        maxX: 2675,
        lootIds: [442], // silver ore
        anchor: { x: 2657, z: 3314 },
        offsets: [[1, 2], [0, 2], [2, 1], [2, 0], [-1, 1], [-1, 0], [0, -1], [1, -1]],
    },
    {
        recipeName: 'stealing_fur_stall',
        minLevel: 35,
        locPattern: /^fur stall$/i,
        maxX: 2675,
        lootIds: [958], // grey wolf fur
        anchor: { x: 2663, z: 3296 },
        offsets: [[2, 0], [2, 1], [0, 2], [1, 2], [-1, 0], [-1, 1], [0, -1], [1, -1]],
    },
    {
        recipeName: 'stealing_silk_stall',
        minLevel: 20,
        locPattern: /^silk stall$/i,
        maxX: 2675,
        lootIds: [950], // silk
        anchor: { x: 2662, z: 3314 },
        offsets: [[2, 0], [2, 1], [0, -1], [1, -1], [-1, 0], [-1, 1], [0, 2], [1, 2]],
    },
    {
        recipeName: 'stealing_bakery_stall',
        minLevel: 5,
        locPattern: /^baker'?s stall$/i,
        maxX: 2675,
        lootIds: [1891, 2309, 1901], // cake, bread, chocolate slice
        anchor: { x: 2667, z: 3310 },
        offsets: [[2, 0], [2, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [0, 2], [1, 2]],
    },
];
const MARKET_STALL_LOOT_IDS = new Set<number>(MARKET_STALLS.flatMap(s => s.lootIds));

export function selectPickpocketTier(level: number): PickpocketTier {
    for (let i = ARDOUGNE_PICKPOCKET_TIERS.length - 1; i >= 0; i--) {
        if (level >= ARDOUGNE_PICKPOCKET_TIERS[i]!.minLevel) return ARDOUGNE_PICKPOCKET_TIERS[i]!;
    }
    return ARDOUGNE_PICKPOCKET_TIERS[0]!;
}

export function selectPickpocketTarget<T extends {
    readonly index?: number;
    readonly name: string;
    readonly distance: number;
    readonly x: number;
    readonly z: number;
    readonly reachable?: boolean;
    readonly optionsWithIndex: readonly { readonly text: string; readonly opIndex: number }[];
}>(
    npcs: readonly T[],
    tier: PickpocketTier,
    stickyIndex = -1,
): { target: T | undefined; blocked: T | undefined } {
    const matching = npcs
        .filter(n => tier.pattern.test(n.name) && n.optionsWithIndex.some(o => /^pickpocket$/i.test(o.text)));
    const nearAnchor = matching.filter(
        n => Math.max(Math.abs(n.x - tier.anchor.x), Math.abs(n.z - tier.anchor.z)) <= 9,
    );
    const sticky = stickyIndex >= 0
        ? nearAnchor.find(n => n.index === stickyIndex && n.distance <= 1 && n.reachable !== false)
        : undefined;
    if (sticky) return { target: sticky, blocked: undefined };
    const pool = (nearAnchor.length > 0 ? nearAnchor : matching).sort((a, b) => a.distance - b.distance);
    return {
        target: pool.find(n => n.reachable !== false),
        blocked: pool.find(n => n.reachable === false),
    };
}

export function isArdougneResumeState(
    pos: { worldX: number; worldZ: number; level: number } | null | undefined,
    hasFood: boolean,
): boolean {
    return !!pos
        && pos.level === 0
        && pos.worldX >= 2590 && pos.worldX <= 2700
        && pos.worldZ >= 3260 && pos.worldZ <= 3340
        && hasFood;
}

export function parseThievingCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): {
    account: string;
    helperName: string;
    cap: number;
    resume: boolean;
} {
    const pos: string[] = [];
    const kv = new Map<string, string>();
    for (const raw of argv) {
        const eq = raw.indexOf('=');
        if (eq > 0 && !raw.startsWith('-')) kv.set(raw.slice(0, eq).toUpperCase(), raw.slice(eq + 1));
        else if (!raw.startsWith('-')) pos.push(raw);
    }
    const account = pos[0];
    if (!account) throw Error('usage: bun scripts/thieving-specialist.ts <account> [helperAccount]');
    const helperName = pos[1] ?? kv.get('HELPER') ?? env.HELPER ?? `${account}b`;
    const cap = Number(kv.get('CAP') ?? env.CAP ?? 3200);
    const resume = (kv.get('RESUME') ?? env.RESUME) === '1';
    return { account, helperName, cap, resume };
}

export interface StunRelogThievingResult {
    session: Session;
    readonly totalTicks: number;
    readonly relogs: number;
    readonly stuns: number;
    readonly attempts: number;
    readonly ok: boolean;
    readonly finalLevel: number;
    readonly finalXp: number;
}

const msgMark = (m: { observationId?: number; tick: number }) => m.observationId ?? m.tick;
const latestMark = (msgs: readonly { observationId?: number; tick: number }[], fallback: number) =>
    msgs.reduce((max, m) => Math.max(max, msgMark(m)), fallback);

/** Runs Ardougne stun-relog pickpocketing from current Thieving level until goalLevel or stop/cap. */
export async function runArdougneStunRelogThieving(opts: {
    main: Session;
    cap: number;
    initialTicks?: number;
    goalLevel?: number;
    relogSession: (current: Session) => Promise<Session>;
    isStopped: () => boolean;
}): Promise<StunRelogThievingResult> {
    let main = opts.main;
    const goalLevel = opts.goalLevel ?? 99;
    let totalTicks = opts.initialTicks ?? 0;
    let sessStart = main.tick();
    let relogs = 0;
    let stuns = 0;
    let attempts = 0;
    let ok = false;
    let lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
    let lastPickTick = -99;
    let lastPickDist = 99;
    let lastPickTarget = -1;
    let stallCooldownUntil = 0;
    let prevHp = main.sdk.getState()?.player?.hp ?? 10;
    const elapsedNow = () => totalTicks + Math.max(0, main.tick() - sessStart);

    // Lazy-init stall LoS + pathfinding cache for Lv 5..54 Market stall stealing (0 stun, 0 relog).
    let stallCtxPromise: Promise<{
        pf: { isTileWalkable(level: number, x: number, z: number): boolean } | undefined;
        recipes: Map<string, any>;
        sightMap: Map<string, any>;
    }> | undefined;
    const getStallCtx = () => {
        if (!stallCtxPromise) {
            stallCtxPromise = (async () => {
                const pf = await import('../vendor/rs-sdk/sdk/pathfinding').catch(() => undefined);
                if (pf) {
                    const { loadPathfinding } = await import('../packages/core/src/pathcache');
                    await loadPathfinding();
                }
                const { stallRecipes, stallSight } = await import('../packages/workers/src/gather');
                const recipes = new Map<string, any>();
                const sightMap = new Map<string, any>();
                for (const spec of MARKET_STALLS) {
                    const r = stallRecipes().find(x => x.name === spec.recipeName);
                    if (r) {
                        recipes.set(spec.recipeName, r);
                        const sg = await stallSight(main, r).catch(() => undefined);
                        if (sg) sightMap.set(spec.recipeName, sg);
                    }
                }
                return { pf, recipes, sightMap };
            })();
        }
        return stallCtxPromise;
    };

    while (!opts.isStopped() && elapsedNow() < opts.cap) {
        const st = main.sdk.getState();
        const lvl = main.sdk.getSkill('Thieving')?.baseLevel ?? 1;
        if (lvl >= goalLevel) {
            ok = true;
            break;
        }
        if (!st?.player) {
            await waitTicks(main, 1);
            continue;
        }

        const tier = lvl < 5 && st.player.worldX >= 3150
            ? { ...selectPickpocketTier(lvl), anchor: { x: 3222, z: 3222 } }
            : selectPickpocketTier(lvl);

        // Detect new stun/guard-alert messages or unexpected HP loss during Market stalls via monotonic watermark.
        const msgs = st.gameMessages ?? [];
        const newMsgs = msgs.filter(m => msgMark(m) > lastMsgMark);
        lastMsgMark = latestMark(msgs, lastMsgMark);
        const stallHit = lvl >= 5 && lvl < 55 && st.player.hp < prevHp;
        prevHp = st.player.hp;
        const stallAlert = lvl >= 5 && lvl < 55 && (stallHit || newMsgs.some(m => /hands off there|you're the one who stole|guards guards|during combat/i.test(m.text)));
        if (stallAlert) {
            // Guards in Ardougne Market put the player in combat (blocking logout for 16t); eat and step out of guard range instead of logout.
            if (foodBitesCount(main) >= 2 && st.player.hp <= 7) {
                await eatAnyFood(main);
            }
            await walkWaypointsSafe(main, [[2653, 3284, 1]], () => opts.isStopped() || elapsedNow() >= opts.cap);
            for (let w = 0; w < 10 && !opts.isStopped() && elapsedNow() < opts.cap; w++) {
                if ((main.sdk.getState()?.player?.hp ?? 10) <= 6 && foodBitesCount(main) >= 2) await eatAnyFood(main);
                await waitTicks(main, 1);
            }
            lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
            prevHp = main.sdk.getState()?.player?.hp ?? 10;
            lastPickTick = -99;
            continue;
        }
        if (newMsgs.some(m => /you fail to pick|you've been stunned/i.test(m.text))) {
            stuns++;
            const bites = foodBitesCount(main);
            if (st.player.hp <= Math.max(4, tier.stunDamage) && bites === 0) {
                // Never call logoutSession at <= FLEE_HP with no food: flee_guard holds clickComponent until timeout.
                await waitTicks(main, 2);
                lastPickTick = -99;
                continue;
            }
            // Eat when HP drops to guard/stun danger threshold so we never die at Lv 5..54 stalls or Knight stuns.
            if (bites >= 2 && st.player.hp <= Math.max(lvl < 55 ? 6 : 4, tier.stunDamage)) {
                await eatAnyFood(main);
            }
            totalTicks += Math.max(1, main.tick() - sessStart) + 1;
            relogs++;
            main = await opts.relogSession(main);
            sessStart = main.tick();
            lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
            prevHp = main.sdk.getState()?.player?.hp ?? 10;
            lastPickTick = -99;
            lastPickDist = 99;
            lastPickTarget = -1;
            continue;
        }

        // Emergency food restock only when completely out of food and HP is at stun threshold.
        const bites = foodBitesCount(main);
        const needRestock = bites === 0 && st.player.hp <= tier.stunDamage;
        if (needRestock && elapsedNow() >= stallCooldownUntil) {
            const restocked = await stealEmergencyStallFood(main, () => opts.isStopped() || elapsedNow() >= opts.cap, 4, 4);
            if (!restocked) {
                stallCooldownUntil = elapsedNow() + 6;
            }
            if (foodBitesCount(main) >= 2 && st.player.hp <= tier.stunDamage) {
                await eatAnyFood(main);
            }
            lastPickTick = -99;
            if (restocked) continue;
        }

        // Never pickpocket into <= 3 HP without at least 2 bites left (reserve 1 bite keeps flee_guard disarmed).
        if (foodBitesCount(main) <= 1 && st.player.hp <= tier.stunDamage + 3) {
            await waitTicks(main, 1);
            continue;
        }

        // Safety guard: never attempt a pickpocket/stall steal while HP <= danger threshold.
        const minSafeHp = lvl < 55 ? 6 : Math.max(4, tier.stunDamage);
        if (st.player.hp <= minSafeHp) {
            await eatAnyFood(main);
            if ((main.sdk.getState()?.player?.hp ?? 0) <= minSafeHp) {
                stallCooldownUntil = 0;
                await waitTicks(main, 1);
                continue;
            }
        }

        // Lv 5..54: opportunistically steal Ardougne Market stalls (Silver/Fur/Silk/Baker) whenever present & unwatched.
        const inMarket = st.player.worldX >= 2648 && st.player.worldX <= 2678 && st.player.worldZ >= 3290 && st.player.worldZ <= 3322;
        if (lvl >= 5 && lvl < 55 && inMarket) {
            const junkSlot = main.sdk.getInventory().find(
                i => MARKET_STALL_LOOT_IDS.has(i.id) || i.id === OBJ_SUPER_ENERGY_4 || i.id === 229,
            )?.slot;
            if (junkSlot !== undefined && main.sdk.getInventory().length >= 28) {
                await main.direct({ type: 'dropItem', slot: junkSlot, reason: 'SDK' });
            }
            if (main.sdk.getInventory().length < 28) {
                const { stallWatched } = await import('../packages/workers/src/gather');
                const { pf, recipes, sightMap } = await getStallCtx();
                let pickedStall: { stall: NonNullable<typeof st.nearbyLocs>[number]; x: number; z: number } | undefined;
                for (const spec of MARKET_STALLS) {
                    if (lvl < spec.minLevel) continue;
                    const recipe = recipes.get(spec.recipeName);
                    const sight = sightMap.get(spec.recipeName);
                    const locs = st.nearbyLocs.filter(
                        l => spec.locPattern.test(l.name) && l.x <= spec.maxX && l.optionsWithIndex.some(o => /steal/i.test(o.text)),
                    );
                    if (!locs.length) continue;
                    const watched = (x: number, z: number) => recipe && sight
                        ? stallWatched(recipe, { worldX: x, worldZ: z, level: st.player!.level ?? 0 }, st.nearbyNpcs.map(n => ({ ...n, inCombat: false })), sight)
                        : st.nearbyNpcs.some(n => /^(guard|baker|silk merchant|fur trader|silver merchant|knight of ardougne)$/i.test(n.name) && chebDist({ x: n.x, z: n.z }, { x, z }) <= 5);
                    const tile = locs.flatMap(stall =>
                        spec.offsets.map(([dx, dz]) => ({ stall, x: stall.x + dx, z: stall.z + dz }))
                            .filter(t => !pf || pf.isTileWalkable(st.player!.level ?? 0, t.x, t.z))
                            .filter(t => !watched(t.x, t.z)),
                    ).sort((a, b) => chebDist(a, { x: st.player!.worldX, z: st.player!.worldZ }) - chebDist(b, { x: st.player!.worldX, z: st.player!.worldZ }))[0];
                    if (tile && chebDist(tile, { x: st.player.worldX, z: st.player.worldZ }) <= 6) {
                        pickedStall = tile;
                        break;
                    }
                }
                if (pickedStall) {
                    if (st.player.worldX !== pickedStall.x || st.player.worldZ !== pickedStall.z) {
                        await main.direct({ type: 'walkTo', x: pickedStall.x, z: pickedStall.z, running: true, reason: 'SDK' });
                        await waitTicks(main, 1);
                        continue;
                    }
                    const op = pickedStall.stall.optionsWithIndex.find(o => /steal/i.test(o.text));
                    if (op) {
                        const beforeXp = main.sdk.getSkillXp('Thieving') ?? 0;
                        await main.direct({ type: 'interactLoc', x: pickedStall.stall.x, z: pickedStall.stall.z, locId: pickedStall.stall.id, optionIndex: op.opIndex, reason: 'SDK' });
                        for (let w = 0; w < 3 && !opts.isStopped() && (main.sdk.getSkillXp('Thieving') ?? 0) === beforeXp; w++) {
                            await waitTicks(main, 1);
                        }
                        const dropLoot = main.sdk.getInventory().find(i => MARKET_STALL_LOOT_IDS.has(i.id))?.slot;
                        if (dropLoot !== undefined) {
                            void main.direct({ type: 'dropItem', slot: dropLoot, reason: 'SDK' });
                        }
                        lastPickTick = -99;
                        continue;
                    }
                }
                // Stay on Ardougne Market stalls through Lv 54 (0 stun, 0 food) instead of burning food on Guards/Warriors.
                await waitTicks(main, 1);
                continue;
            }
        }

        const { target: npc, blocked } = selectPickpocketTarget(st.nearbyNpcs, tier, lastPickTarget);

        if (!npc) {
            if (chebDist({ x: st.player.worldX, z: st.player.worldZ }, tier.anchor) > 6) {
                await main.bot.walkTo(tier.anchor.x, tier.anchor.z, 2);
            } else if (blocked) {
                await main.bot.walkTo(blocked.x, blocked.z, 1);
            } else {
                await waitTicks(main, 1);
            }
            continue;
        }

        const sincePick = main.tick() - lastPickTick;
        // Running covers 2 tiles per tick; avoid extra +1 wait pad when closing on moving Ardougne Knights.
        const approachWait = lastPickTarget === npc.index && lastPickDist > 2
            ? Math.max(2, Math.min(3, Math.ceil(lastPickDist / 2)))
            : 2;
        if (sincePick >= approachWait) {
            const op = npc.optionsWithIndex.find(o => /^pickpocket$/i.test(o.text));
            if (op) {
                lastPickTick = main.tick();
                lastPickDist = npc.distance;
                lastPickTarget = npc.index;
                attempts++;
                await main.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op.opIndex, reason: 'SDK' });
            }
        }
        await waitTicks(main, 1);
    }

    totalTicks = elapsedNow();
    const finalLevel = main.sdk.getSkill('Thieving')?.baseLevel ?? 0;
    const finalXp = main.sdk.getSkillXp('Thieving') ?? 0;
    return {
        session: main,
        totalTicks,
        relogs,
        stuns,
        attempts,
        ok: ok && finalLevel >= goalLevel,
        finalLevel,
        finalXp,
    };
}

if (import.meta.main) {
    const { account, helperName, cap, resume } = parseThievingCliArgs(process.argv.slice(2), process.env);

    let stopFlag = false;
    let stopReason = '';
    let activeMainToken = 1;
    let intentionalRelog = false;
    let helperSettled = resume;
    let totalTicks = 0;
    const isStopped = () => stopFlag || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || totalTicks >= cap;

    const helper = resume || externalSupplierName() ? undefined : await openBot(helperName, { onStop: async (_s, why) => { stopReason ||= `helper: ${why}`; stopFlag = true; } });
    const onUnexpectedEnd = async (sess: Session, detail: string) => {
        if (intentionalRelog) return;
        await finish(helperSettled || !helper ? [sess] : [helper, sess], false, `unexpected end: ${detail}`);
    };

    const initialToken = activeMainToken;
    let main = await openBot(account, {
        onStop: async (_s, why) => { if (initialToken === activeMainToken) { stopReason ||= why; stopFlag = true; } },
        onSessionEnd: onUnexpectedEnd,
    });

    let helperDone: Promise<void> | undefined;
    let sessStart = main.tick();
    let relogs = 0;
    let tutTicks = 0;
    let tradeTicks = 0;
    let travelTicks = 0;
    let ok = false;
    let detail = '';

    const elapsedNow = () => totalTicks + Math.max(0, main.tick() - sessStart);

    const supplies = isLiveSupplyVariant() ? THIEVING_SPECIALIST_LIVE_SUPPLIES : THIEVING_SPECIALIST_SUPPLIES;
    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    const relogMainSession = async (current: Session) => {
        intentionalRelog = true;
        try {
            const out = await logoutSession(current);
            if (out !== 'logged-out' && out !== 'disconnected') throw Error(`relog logout failed: ${out}`);
            await closeWithin([current], 5000);
            const nextToken = ++activeMainToken;
            for (let attempt = 0; ; attempt++) {
                try {
                    return await openBot(account, {
                        onStop: async (_s, why) => { if (nextToken === activeMainToken) { stopReason ||= why; stopFlag = true; } },
                        onSessionEnd: onUnexpectedEnd,
                    });
                } catch (err) {
                    if (attempt >= 3 || !/already logged in|try again|econnreset|timeout/i.test(String(err))) throw err;
                    await Bun.sleep(100);
                }
            }
        } finally {
            intentionalRelog = false;
        }
    };

    try {
        if (resume) {
            for (let w = 0; w < 20 && !isStopped() && !main.sdk.getState()?.player; w++) {
                await waitTicks(main, 1);
            }
            const p = main.sdk.getState()?.player;
            if (!isArdougneResumeState(p, hasAnyFood(main))) {
                throw Error(`resume blocked: pos=${p?.worldX},${p?.worldZ},${p?.level} hasFood=${hasAnyFood(main)}`);
            }
        } else {
            tutTicks = await skipTutorialFast(main, isStopped);
            await dropTutorialJunk(main, isStopped, 18);
            readyForTrade = true;
            tradeTicks = await receiveTradeFast(main, helper, supplies, isStopped, arm);
            helperDone = settleHelper(helper)
                .then(() => { helperSettled = true; })
                .catch(err => {
                    console.log(`WARN helper settle: ${String(err)}`);
                });

            // Reach Lv 5 on Lumbridge Man/Woman (Ardougne Market has no Man/Woman NPCs) before teleporting to Market stalls.
            if ((main.sdk.getSkill('Thieving')?.baseLevel ?? 1) < 5) {
                const starterRes = await runArdougneStunRelogThieving({
                    main,
                    cap,
                    initialTicks: elapsedNow(),
                    goalLevel: 5,
                    isStopped: () => stopFlag,
                    relogSession: relogMainSession,
                });
                main = starterRes.session;
                totalTicks = starterRes.totalTicks;
                relogs += starterRes.relogs;
                sessStart = main.tick();
            }

            if (THIEVING_GLORY_IDS.some(id => itemQty(main, id) > 0)) {
                // Travel via Karamja Glory -> Brimhaven -> Ardougne dock -> East Ardougne market.
                await rubTeleport(
                    main,
                    THIEVING_GLORY_IDS,
                    2,
                    p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
                    isStopped,
                );
                // NODE_INFINITE_RUN=true on live & practice: drop Super energy(4) to free slot 28 for Market stalls.
                const energySlot = main.sdk.getInventory().find(i => i.id === OBJ_SUPER_ENERGY_4)?.slot;
                if (energySlot !== undefined) {
                    void main.direct({ type: 'dropItem', slot: energySlot, reason: 'SDK' });
                }
                await walkWaypointsSafe(
                    main,
                    [[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]],
                    isStopped,
                );
                await sailBrimhavenToArdougne(main, isStopped);
                await walkWaypointsSafe(main, [[2661, 3306, 2]], isStopped);
            } else {
                await rubTeleport(
                    main,
                    RING_OF_DUELING_IDS,
                    /castle wars/i,
                    p => p.level === 0 && p.worldX >= 2430 && p.worldX <= 2455 && p.worldZ >= 3075 && p.worldZ <= 3105,
                    isStopped,
                );
                // Drop the spent Ring of dueling to free slot 28 for coins before pickpocketing.
                const ringSlot = main.sdk.getInventory().find(i => (RING_OF_DUELING_IDS as readonly number[]).includes(i.id))?.slot;
                if (ringSlot !== undefined) {
                    await main.direct({ type: 'dropItem', slot: ringSlot, reason: 'SDK' });
                }
                await walkWaypointsSafe(main, THIEVING_DIRECT_CWARS_WAYPOINTS, isStopped);
                const energyJunk = main.sdk.getInventory().find(i => i.id === 229 || i.id === 3016 || i.id === 3018 || i.id === 3020 || i.id === 3022)?.slot;
                if (energyJunk !== undefined) {
                    await main.direct({ type: 'dropItem', slot: energyJunk, reason: 'SDK' });
                }
            }
            travelTicks = elapsedNow();
        }
        const res = await runArdougneStunRelogThieving({
            main,
            cap,
            initialTicks: elapsedNow(),
            isStopped: () => stopFlag,
            relogSession: relogMainSession,
        });
        main = res.session;
        totalTicks = res.totalTicks;
        relogs = res.relogs;
        ok = res.ok;
        detail = `level=${res.finalLevel} xp=${res.finalXp} totalTicks=${totalTicks} relogs=${relogs} stuns=${res.stuns} attempts=${res.attempts} tut=${tutTicks} trade=${tradeTicks} travel=${travelTicks}${stopReason ? ` stop=${stopReason}` : ''}`;
    } catch (error) {
        totalTicks = elapsedNow();
        detail = `${String(error)} totalTicks=${totalTicks} relogs=${relogs}`;
    } finally {
        arm.close();
    }

    await helperDone;
    await finish(helperSettled || !helper ? [main] : [helper, main], ok, detail);
}
