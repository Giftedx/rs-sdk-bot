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
    CWARS_TO_ARDY_MARKET_WAYPOINTS,
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
export const THIEVING_CAKES = 27;

export const THIEVING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_GLORY_4]: 1,
    [OBJ_COINS]: 200,
    [OBJ_SUPER_ENERGY_4]: 1,
    [OBJ_PINEAPPLE_PIZZA]: THIEVING_PIZZAS,
};

// Live-stockable variant: 0 Glory, 0 Super energy, 0 Pineapple pizza (local Ring of dueling(8) + 27 Chocolate cakes).
export const THIEVING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_DUELING_8]: 1,
    [OBJ_CHOCOLATE_CAKE]: THIEVING_CAKES,
};

const BAKERS_STALL_SAFE_CENTER = { x: 2667, z: 3310 };
const BAKERS_STALL_SIDE_OFFSETS: readonly [number, number][] = [
    [2, 0], [2, 1], [-1, 0], [-1, 1], [0, -1], [1, -1], [0, 2], [1, 2],
];

/** Steal a small emergency food buffer from the Ardougne Baker's stall only when no Knight/Baker can spot the tile. */
async function stealEmergencyStallFood(main: Session, stop: () => boolean, targetBites = 8): Promise<void> {
    if (chebDist({ x: main.sdk.getState()?.player?.worldX ?? 0, z: main.sdk.getState()?.player?.worldZ ?? 0 }, BAKERS_STALL_SAFE_CENTER) > 6) {
        await main.bot.walkTo(BAKERS_STALL_SAFE_CENTER.x + 2, BAKERS_STALL_SAFE_CENTER.z, 2);
    }
    for (let i = 0; i < 40 && !stop() && foodBitesCount(main) < targetBites && main.sdk.getInventory().length < 28; i++) {
        const st = main.sdk.getState();
        const me = st?.player;
        if (!st || !me) {
            await waitTicks(main, 1);
            continue;
        }
        const stall = st.nearbyLocs.find(l => /^baker'?s stall$/i.test(l.name) && l.optionsWithIndex.some(o => /steal/i.test(o.text)));
        if (!stall) {
            await waitTicks(main, 1);
            continue;
        }
        const watchers = st.nearbyNpcs.filter(n => /^(knight of ardougne|baker)$/i.test(n.name));
        const safeTile = BAKERS_STALL_SIDE_OFFSETS
            .map(([dx, dz]) => ({ x: stall.x + dx, z: stall.z + dz }))
            .filter(t => watchers.every(w => chebDist({ x: w.x, z: w.z }, t) > 5))
            .sort((a, b) => chebDist(a, { x: me.worldX, z: me.worldZ }) - chebDist(b, { x: me.worldX, z: me.worldZ }))[0];
        if (!safeTile) {
            await waitTicks(main, 1);
            continue;
        }
        if (me.worldX !== safeTile.x || me.worldZ !== safeTile.z) {
            await main.bot.walkTo(safeTile.x, safeTile.z, 0);
            continue;
        }
        const op = stall.optionsWithIndex.find(o => /steal/i.test(o.text));
        if (!op) break;
        const before = foodBitesCount(main);
        await main.direct({ type: 'interactLoc', x: stall.x, z: stall.z, locId: stall.id, optionIndex: op.opIndex, reason: 'SDK' });
        for (let w = 0; w < 4 && !stop() && foodBitesCount(main) === before; w++) {
            await waitTicks(main, 1);
        }
    }
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
    { name: 'knight', minLevel: 55, stunDamage: 3, pattern: /^knight of ardougne$/i, anchor: { x: 2654, z: 3301 } },
];

export function selectPickpocketTier(level: number): PickpocketTier {
    for (let i = ARDOUGNE_PICKPOCKET_TIERS.length - 1; i >= 0; i--) {
        if (level >= ARDOUGNE_PICKPOCKET_TIERS[i]!.minLevel) return ARDOUGNE_PICKPOCKET_TIERS[i]!;
    }
    return ARDOUGNE_PICKPOCKET_TIERS[0]!;
}

export function selectPickpocketTarget<T extends {
    readonly name: string;
    readonly distance: number;
    readonly x: number;
    readonly z: number;
    readonly reachable?: boolean;
    readonly optionsWithIndex: readonly { readonly text: string; readonly opIndex: number }[];
}>(
    npcs: readonly T[],
    tier: PickpocketTier,
): { target: T | undefined; blocked: T | undefined } {
    const matching = npcs
        .filter(n => tier.pattern.test(n.name) && n.optionsWithIndex.some(o => /^pickpocket$/i.test(o.text)))
        .sort((a, b) => a.distance - b.distance);
    return {
        target: matching.find(n => n.reachable !== false),
        blocked: matching.find(n => n.reachable === false),
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
    let stuns = 0;
    let attempts = 0;
    let tutTicks = 0;
    let tradeTicks = 0;
    let travelTicks = 0;
    let ok = false;
    let detail = '';

    const elapsedNow = () => totalTicks + Math.max(0, main.tick() - sessStart);

    const msgMark = (m: { observationId?: number; tick: number }) => m.observationId ?? m.tick;
    const latestMark = (msgs: readonly { observationId?: number; tick: number }[], fallback: number) =>
        msgs.reduce((max, m) => Math.max(max, msgMark(m)), fallback);

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
                // Travel via Karamja Glory -> Brimhaven -> Ardougne dock -> East Ardougne market.
                await rubTeleport(
                    main,
                    THIEVING_GLORY_IDS,
                    2,
                    p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
                    isStopped,
                );
                await walkWaypointsSafe(
                    main,
                    [[2774, 3228, 3]],
                    isStopped,
                );
                await sailBrimhavenToArdougne(main, isStopped);
                await walkWaypointsSafe(main, [[2621, 3293, 2]], isStopped);
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
                await walkWaypointsSafe(main, CWARS_TO_ARDY_MARKET_WAYPOINTS, isStopped);
            }
            travelTicks = elapsedNow();
        }
        let lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
        let lastPickTick = -99;

        while (!stopFlag && elapsedNow() < cap) {
            const st = main.sdk.getState();
            const lvl = main.sdk.getSkill('Thieving')?.baseLevel ?? 1;
            if (lvl >= 99) {
                ok = true;
                break;
            }
            if (!st?.player) {
                await waitTicks(main, 1);
                continue;
            }

            const tier = selectPickpocketTier(lvl);

            // Detect new stun messages via monotonic message watermark (immune to ring-buffer length caps).
            const msgs = st.gameMessages ?? [];
            const newMsgs = msgs.filter(m => msgMark(m) > lastMsgMark);
            lastMsgMark = latestMark(msgs, lastMsgMark);
            if (newMsgs.some(m => /you've been stunned/i.test(m.text))) {
                stuns++;
                if (st.player.hp <= tier.stunDamage) {
                    await eatAnyFood(main);
                }
                totalTicks += Math.max(1, main.tick() - sessStart) + 1;
                relogs++;
                intentionalRelog = true;
                const out = await logoutSession(main);
                if (out !== 'logged-out' && out !== 'disconnected') throw Error(`relog logout failed: ${out}`);
                await closeWithin([main], 5000);
                const nextToken = ++activeMainToken;
                main = await openBot(account, {
                    onStop: async (_s, why) => { if (nextToken === activeMainToken) { stopReason ||= why; stopFlag = true; } },
                    onSessionEnd: onUnexpectedEnd,
                });
                intentionalRelog = false;
                sessStart = main.tick();
                lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
                lastPickTick = -99;
                continue;
            }

            // Safety guard: never attempt a pickpocket while HP <= stunDamage. Restock from Baker's stall only if all cakes run out.
            if (st.player.hp <= tier.stunDamage) {
                if (await eatAnyFood(main)) {
                    await waitTicks(main, 1);
                    continue;
                }
                if (!hasAnyFood(main)) {
                    await stealEmergencyStallFood(main, () => stopFlag || elapsedNow() >= cap);
                    await eatAnyFood(main);
                    await waitTicks(main, 1);
                    continue;
                }
            }

            const { target: npc, blocked } = selectPickpocketTarget(st.nearbyNpcs, tier);

            if (!npc) {
                if (chebDist({ x: st.player.worldX, z: st.player.worldZ }, tier.anchor) > 4) {
                    await main.bot.walkTo(tier.anchor.x, tier.anchor.z, 2);
                } else if (blocked) {
                    await main.bot.walkTo(blocked.x, blocked.z, 1);
                } else {
                    await waitTicks(main, 1);
                }
                continue;
            }

            if (main.tick() - lastPickTick >= 2) {
                const op = npc.optionsWithIndex.find(o => /^pickpocket$/i.test(o.text));
                if (op) {
                    lastPickTick = main.tick();
                    attempts++;
                    await main.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: op.opIndex, reason: 'SDK' });
                }
            }
            await waitTicks(main, 1);
        }

        totalTicks = elapsedNow();
        const finalLvl = main.sdk.getSkill('Thieving')?.baseLevel ?? 0;
        const finalXp = main.sdk.getSkillXp('Thieving') ?? 0;
        ok = ok && finalLvl >= 99;
        detail = `level=${finalLvl} xp=${finalXp} totalTicks=${totalTicks} relogs=${relogs} stuns=${stuns} attempts=${attempts} tut=${tutTicks} trade=${tradeTicks} travel=${travelTicks}${stopReason ? ` stop=${stopReason}` : ''}`;
    } catch (error) {
        totalTicks = elapsedNow();
        detail = `${String(error)} totalTicks=${totalTicks} relogs=${relogs}`;
    } finally {
        arm.close();
    }

    await helperDone;
    await finish(helperSettled || !helper ? [main] : [helper, main], ok, detail);
}
