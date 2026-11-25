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
    OBJ_PINEAPPLE_PIZZA,
} from './gathering-specialist-lib';
import { ClientProt } from '../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';

export const THIEVING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export const THIEVING_PIZZAS = 26;
export const THIEVING_CAKES = 27;

export const THIEVING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_GLORY_4]: 1,
    [OBJ_COINS]: 200,
    [OBJ_PINEAPPLE_PIZZA]: THIEVING_PIZZAS,
};

// Live-stockable variant: Ring of dueling(8) + 27 Chocolate cakes (local stockable, 0 Glory / 0 Pineapple pizza / no 3016 under infinite run).
export const THIEVING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_DUELING_8]: 1,
    [OBJ_CHOCOLATE_CAKE]: THIEVING_CAKES,
};

export const THIEVING_DIRECT_CWARS_WAYPOINTS: readonly [number, number, number][] = [
    [2445, 3120, 3],
    [2455, 3156, 3],
    [2476, 3194, 3],
    [2486, 3214, 3],
    [2506, 3233, 3],
    [2541, 3244, 3],
    [2592, 3293, 3],
    [2621, 3293, 2],
];

const BAKERS_STALL_SAFE_CENTER = { x: 2667, z: 3310 };
const BAKERS_STALL_SIDE_OFFSETS: readonly [number, number][] = [
    [2, 0], [2, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [0, 2], [1, 2],
];

/** Steal an emergency food buffer from an Ardougne Baker's stall using native sight + walkability checks. */
async function stealEmergencyStallFood(main: Session, stop: () => boolean, targetBites = 6, maxSteals = 4): Promise<boolean> {
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
        if (me.hp <= 5) {
            await eatAnyFood(main);
            if ((main.sdk.getState()?.player?.hp ?? 0) <= 4 && !hasAnyFood(main)) break;
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
    { name: 'man', minLevel: 1, stunDamage: 1, pattern: /^(man|woman)$/i, anchor: { x: 2621, z: 3293 } },
    { name: 'warrior', minLevel: 25, stunDamage: 2, pattern: /^warrior woman$/i, anchor: { x: 2630, z: 3296 } },
    { name: 'guard', minLevel: 40, stunDamage: 2, pattern: /^guard$/i, anchor: { x: 2662, z: 3305 } },
    { name: 'knight', minLevel: 55, stunDamage: 3, pattern: /^knight of ardougne$/i, anchor: { x: 2654, z: 3298 } },
];

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
    const pool = (nearAnchor.length > 0 ? nearAnchor : matching).sort((a, b) => a.distance - b.distance);
    const closest = pool.find(n => n.reachable !== false);
    const sticky = stickyIndex >= 0
        ? nearAnchor.find(n => n.index === stickyIndex && n.distance <= 2 && n.reachable !== false && (!closest || n.distance <= closest.distance))
        : undefined;
    if (sticky) return { target: sticky, blocked: undefined };
    return {
        target: closest,
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
    let stunPending = false;
    let stunPendingTick = -99;
    let stallCooldownUntil = 0;
    const elapsedNow = () => totalTicks + Math.max(0, main.tick() - sessStart);

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

        const tier = selectPickpocketTier(lvl);

        // Detect new pickpocket/stun messages via monotonic watermark (immune to ring-buffer length caps).
        const msgs = st.gameMessages ?? [];
        const newMsgs = msgs.filter(m => msgMark(m) > lastMsgMark);
        lastMsgMark = latestMark(msgs, lastMsgMark);
        const justPicked = newMsgs.some(m => /^you pick the /i.test(m.text));
        const justFailed = newMsgs.some(m => /^you fail to pick /i.test(m.text));
        if (justFailed) {
            stunPending = true;
            stunPendingTick = main.tick();
        }
        if (newMsgs.some(m => /you've been stunned/i.test(m.text))) {
            stuns++;
            stunPending = false;
            const bites = foodBitesCount(main);
            if (st.player.hp <= Math.max(3, tier.stunDamage) && bites === 0) {
                // Never call logoutSession at <= FLEE_HP with no food: flee_guard holds clickComponent until timeout.
                await waitTicks(main, 2);
                lastPickTick = -99;
                continue;
            }
            // Keep >= 1 emergency bite in inventory so randomevents flee_guard never triggers on 0-food HP<=3 stuns.
            if (bites >= 2 && st.player.hp <= tier.stunDamage) {
                await eatAnyFood(main);
            }
            totalTicks += Math.max(1, main.tick() - sessStart) + 1;
            relogs++;
            main = await opts.relogSession(main);
            sessStart = main.tick();
            lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
            lastPickTick = -99;
            lastPickDist = 99;
            lastPickTarget = -1;
            stunPending = false;
            continue;
        }
        if (stunPending && main.tick() - stunPendingTick < 5) {
            await waitTicks(main, 1);
            continue;
        }
        stunPending = false;

        // Restock from Baker's stall when down to 1 reserve bite (skip trip at lv>=98 while hp still >= stun+3).
        const bites = foodBitesCount(main);
        const needRestock = bites === 0 || (bites <= 1 && st.player.hp <= tier.stunDamage + 3 && lvl < 98);
        if (needRestock && elapsedNow() >= stallCooldownUntil) {
            const restocked = await stealEmergencyStallFood(main, () => opts.isStopped() || elapsedNow() >= opts.cap, 4, 2);
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

        // Safety guard: never attempt a pickpocket while HP <= stunDamage.
        if (st.player.hp <= tier.stunDamage) {
            const ate = await eatAnyFood(main);
            if (!ate) {
                stallCooldownUntil = 0;
                await waitTicks(main, 1);
                continue;
            }
        }

        const { target: npc, blocked } = selectPickpocketTarget(st.nearbyNpcs, tier, lastPickTarget);

        if (!npc) {
            if (chebDist({ x: st.player.worldX, z: st.player.worldZ }, tier.anchor) > 4) {
                await main.direct({ type: 'walkTo', x: tier.anchor.x, z: tier.anchor.z, running: true, reason: 'SDK' });
            } else if (blocked) {
                await main.direct({ type: 'walkTo', x: blocked.x, z: blocked.z, running: true, reason: 'SDK' });
            }
            await waitTicks(main, 1);
            continue;
        }

        const sincePick = main.tick() - lastPickTick;
        // Running covers <= 2 tiles inside the interact tick itself, so distance <= 2 completes on tick + 2.
        const approachWait = lastPickTarget === npc.index && npc.distance > 2 && lastPickDist > 2
            ? Math.min(4, Math.ceil(npc.distance / 2) + 1)
            : 2;
        if (justPicked || sincePick >= approachWait) {
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

async function walkDirectNoDetour(
    main: Session,
    points: readonly [number, number, number][],
    stop: () => boolean,
    earlyStop?: () => boolean,
): Promise<void> {
    const base = await sessionWalker(main);
    const runEnabled = () => ((main.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) === 1;
    let lastRunClickTick = -10;
    const deps = {
        ...base,
        hunters: () => [],
        runOn: async () => {
            const t = main.tick();
            if (!runEnabled() && t - lastRunClickTick >= 2) {
                lastRunClickTick = t;
                await main.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
            }
        },
    };
    const pathPts = points.map(([x, z, tol]) => ({ x, z, tol }));
    const res = await walkPath(deps, pathPts, {
        maxTicks: Math.max(220, points.length * 140),
        reclickAt: 10,
        look: 22,
        stop: () => stop() || !!earlyStop?.(),
    });
    if (!res.ok && !earlyStop?.() && !stop()) {
        await walkWaypointsSafe(main, points, stop);
    }
}

async function sailBrimhavenFast(main: Session, stop: () => boolean): Promise<void> {
    const ardyDeck = { x: 2683, z: 3268 };
    const landed = () => {
        const p = main.sdk.getState()?.player;
        return !!p && p.level === 1 && chebDist(ardyDeck, { x: p.worldX, z: p.worldZ }) <= 8;
    };
    const sendBurst = (tokens: readonly ('R' | number)[]): boolean => {
        const c = main.client as {
            chatModalId?: number;
            resumedPauseButton?: boolean;
            dialogInputOpen?: boolean;
            writeOpcode?: (op: number) => void;
            out?: { p2(v: number): void };
            flush?: () => void;
        } | undefined;
        if (!c?.writeOpcode || !c.out || typeof c.chatModalId !== 'number' || c.chatModalId === -1 || c.dialogInputOpen) {
            return false;
        }
        const modalId = c.chatModalId;
        for (const tok of tokens.slice(0, 5)) {
            if (tok === 'R') {
                c.writeOpcode(ClientProt.RESUME_PAUSEBUTTON);
                c.out.p2(modalId);
            } else {
                c.writeOpcode(ClientProt.IF_BUTTON);
                c.out.p2(tok);
            }
        }
        c.flush?.();
        c.resumedPauseButton = tokens[tokens.length - 1] === 'R';
        return true;
    };
    const bursts: readonly (readonly ('R' | number)[])[] = [
        ['R', 2461, 'R', 'R', 2472],
        ['R', 'R', 2461, 'R'],
    ];
    let burstIdx = 0;
    let talked = false;
    for (let i = 0; i < 40 && !stop() && !landed(); i++) {
        const d = main.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            if (burstIdx < bursts.length && sendBurst(bursts[burstIdx]!)) {
                burstIdx++;
            } else {
                const pats = [/journey on this ship/i, /search away/i, /^ok\.?$/i];
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await main.direct({ type: 'clickDialogOption', optionIndex: opt ? opt.index : 0, reason: 'SDK' });
            }
        } else if (!talked || i % 6 === 0) {
            const npc = main.sdk.getState()?.nearbyNpcs.find(n => /^customs officer$/i.test(n.name));
            const op = npc?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text))?.opIndex ?? 1;
            if (npc) {
                talked = true;
                await main.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op, reason: 'SDK' });
            } else {
                await sailBrimhavenToArdougne(main, stop);
                return;
            }
        }
        await waitTicks(main, 1);
    }
    if (!landed()) {
        await sailBrimhavenToArdougne(main, stop);
        return;
    }
    for (let i = 0; i < 8 && !stop(); i++) {
        if (main.sdk.getState()?.player?.level === 0) return;
        const d = main.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            await main.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
            await waitTicks(main, 1);
            continue;
        }
        const plank = main.sdk.findNearbyLoc(/^gangplank$/i);
        const op = plank?.optionsWithIndex.find(o => /cross/i.test(o.text))?.opIndex ?? 1;
        if (plank) {
            await main.direct({ type: 'interactLoc', x: plank.x, z: plank.z, locId: plank.id, optionIndex: op, reason: 'SDK' });
        }
        await waitTicks(main, 1);
    }
    if (main.sdk.getState()?.player?.level !== 0) {
        await sailBrimhavenToArdougne(main, stop);
    }
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
    const sessStart = main.tick();
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

            if (THIEVING_GLORY_IDS.some(id => itemQty(main, id) > 0)) {
                // Travel via Karamja Glory -> Brimhaven dock (direct path, no spider/scorpion detours) -> Ardougne dock -> Market.
                await rubTeleport(
                    main,
                    THIEVING_GLORY_IDS,
                    2,
                    p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
                    isStopped,
                );
                await walkDirectNoDetour(
                    main,
                    [[2772, 3234, 2]],
                    isStopped,
                    () => !!main.sdk.getState()?.nearbyNpcs.find(n => /^customs officer$/i.test(n.name) && n.distance <= 4),
                );
                await sailBrimhavenFast(main, isStopped);
                await walkDirectNoDetour(
                    main,
                    [[2654, 3296, 3]],
                    isStopped,
                    () => !!main.sdk.getState()?.nearbyNpcs.find(n => /^(man|woman)$/i.test(n.name) && n.reachable !== false && n.distance <= 3),
                );
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
                await walkDirectNoDetour(main, THIEVING_DIRECT_CWARS_WAYPOINTS, isStopped);
            }
            travelTicks = elapsedNow();
        }
        const res = await runArdougneStunRelogThieving({
            main,
            cap,
            initialTicks: elapsedNow(),
            isStopped: () => stopFlag,
            relogSession: async current => {
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
            },
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
