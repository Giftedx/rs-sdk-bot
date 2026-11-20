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
    isLiveSupplyVariant,
    itemQty,
    chebDist,
    CWARS_TO_ARDY_ZOO_WAYPOINTS,
    OBJ_COINS,
    OBJ_SHARK,
    OBJ_GLORY_4,
    OBJ_DUELING_8,
    RING_OF_DUELING_IDS,
    OBJ_SUPER_ENERGY_4,
    OBJ_PINEAPPLE_PIZZA,
} from './gathering-specialist-lib';
import type { Session } from '../packages/core/src/inprocess';

export const THIEVING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export const THIEVING_PIZZAS = 25;

export const THIEVING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_GLORY_4]: 1,
    [OBJ_COINS]: 200,
    [OBJ_SUPER_ENERGY_4]: 1,
    [OBJ_PINEAPPLE_PIZZA]: THIEVING_PIZZAS,
};

// Live-stockable variant using local.json stock only (0 Glory, 0 Super energy, 0 Pineapple pizza).
export const THIEVING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_DUELING_8]: 1,
    [OBJ_SHARK]: THIEVING_PIZZAS,
};

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

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 3200);
    if (!account) throw Error('usage: bun scripts/thieving-specialist.ts <account> [helperAccount]');

    let stopFlag = false;
    let intentionalRelog = false;
    let helperSettled = false;
    let totalTicks = 0;
    const isStopped = () => stopFlag || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || totalTicks >= cap;

    const helper = externalSupplierName() ? undefined : await openBot(helperName, { onStop: async () => { stopFlag = true; } });
    const onUnexpectedEnd = async (sess: Session, detail: string) => {
        if (intentionalRelog) return;
        await finish(helperSettled || !helper ? [sess] : [helper, sess], false, `unexpected end: ${detail}`);
    };

    let main = await openBot(account, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: onUnexpectedEnd,
    });

    let helperDone: Promise<void> | undefined;
    let sessStart = main.tick();
    let relogs = 0;
    let stuns = 0;
    let attempts = 0;
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
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropTutorialJunk(main, isStopped, 18);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, supplies, isStopped, arm);
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
            await walkWaypointsSafe(main, [...CWARS_TO_ARDY_ZOO_WAYPOINTS, [2621, 3293, 2]], isStopped);
        }

        const travelTicks = elapsedNow();
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
                main = await openBot(account, {
                    onStop: async () => { stopFlag = true; },
                    onSessionEnd: onUnexpectedEnd,
                });
                intentionalRelog = false;
                sessStart = main.tick();
                lastMsgMark = latestMark(main.sdk.getState()?.gameMessages ?? [], -1);
                lastPickTick = -99;
                continue;
            }

            // Safety guard: never attempt a pickpocket while HP <= stunDamage. Wait a tick after eating so heal lands cleanly.
            if (st.player.hp <= tier.stunDamage) {
                if (await eatAnyFood(main)) {
                    await waitTicks(main, 1);
                    continue;
                }
            }

            const npc = st.nearbyNpcs
                .filter(n => tier.pattern.test(n.name) && n.optionsWithIndex.some(o => /^pickpocket$/i.test(o.text)))
                .sort((a, b) => a.distance - b.distance)[0];

            if (!npc) {
                if (chebDist({ x: st.player.worldX, z: st.player.worldZ }, tier.anchor) > 4) {
                    await main.bot.walkTo(tier.anchor.x, tier.anchor.z, 2);
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
        detail = `level=${finalLvl} xp=${finalXp} totalTicks=${totalTicks} relogs=${relogs} stuns=${stuns} attempts=${attempts} tut=${tutTicks} trade=${tradeTicks} travel=${travelTicks}`;
    } catch (error) {
        totalTicks = elapsedNow();
        detail = `${String(error)} totalTicks=${totalTicks} relogs=${relogs}`;
    } finally {
        arm.close();
    }

    await helperDone;
    await finish(helperSettled || !helper ? [main] : [helper, main], ok, detail);
}
