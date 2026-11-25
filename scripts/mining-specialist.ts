import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { xpForLevel } from '../packages/planner/src/curve';
import { finish } from '../packages/core/src/bot';
import { miningProfiles, MINING_SITES, incidentalMiningGems, runRotationMining, siteTiles } from '../packages/workers/src/gather';
import {
    openHelperAndMain,
    skipTutorialFast,
    dropTutorialJunk,
    startHelperTradeArm,
    receiveTradeFast,
    settleHelper,
    rubTeleport,
    walkWaypointsSafe,
    sailBrimhavenToArdougne,
    isLiveSupplyVariant,
    itemQty,
    chebDist,
    SKILL_MULTI3_MAKE1_A,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_COINS,
    OBJ_GLORY_4,
    OBJ_DUELING_8,
    RING_OF_DUELING_IDS,
    OBJ_GAMES_8,
} from './gathering-specialist-lib';

export const OBJ_RUNE_PICKAXE = 1275;
export const OBJ_CLAY = 434;
export const OBJ_COPPER_ORE = 436;
export const OBJ_IRON_ORE = 440;
export const IRON_ORE_XP_25X = 875;

export const MINING_GLORY_IDS = [OBJ_GLORY_4, 1710, 1708, 1706] as const;

const CWARS_TO_ARDY_ZOO_WAYPOINTS: readonly [number, number, number][] = [
    [2470, 3100, 4], [2505, 3145, 4], [2540, 3185, 4], [2580, 3215, 4], [2603, 3234, 1],
];

// 19 supply slots (no Super energy(4) — NODE_INFINITE_RUN=true): Doric's Quest (Mining 1->49) + Ardougne Zoo 3t knife.
export const MINING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_PICKAXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 2,
    [OBJ_CLAY]: 6,
    [OBJ_COPPER_ORE]: 4,
    [OBJ_IRON_ORE]: 2,
    [OBJ_COINS]: 150,
    [OBJ_GLORY_4]: 1,
    [OBJ_GAMES_8]: 1,
};

export const MINING_SPECIALIST_LIVE_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_PICKAXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 2,
    [OBJ_CLAY]: 6,
    [OBJ_COPPER_ORE]: 4,
    [OBJ_IRON_ORE]: 2,
    [OBJ_GLORY_4]: 1,
    [OBJ_DUELING_8]: 1,
};

async function exitGamesRoomToBurthorpe(main: Awaited<ReturnType<typeof openHelperAndMain>>['main'], stop: () => boolean): Promise<void> {
    let lastClickLvl = -1;
    let lastClickAt = -10;
    for (let i = 0; i < 30 && !stop(); i++) {
        const p = main.sdk.getState()?.player;
        if (!p) {
            await waitTicks(main, 1);
            continue;
        }
        if (p.level === 0 && p.worldX >= 2890 && p.worldX <= 2910 && p.worldZ >= 3555 && p.worldZ <= 3575) return;
        const targetLocId = p.level === 0 ? 4622 : 4627;
        const locs = (main.sdk.getState()?.nearbyLocs ?? [])
            .filter(l => l.id === targetLocId && (p.level !== 0 || l.x === 2207))
            .sort((a, b) => chebDist({ x: a.x, z: a.z }, { x: p.worldX, z: p.worldZ }) - chebDist({ x: b.x, z: b.z }, { x: p.worldX, z: p.worldZ }));
        const loc = locs[0];
        if (loc && (lastClickLvl !== p.level || i - lastClickAt >= 5)) {
            lastClickLvl = p.level;
            lastClickAt = i;
            await main.sdk.sendInteractLoc(loc.x, loc.z, loc.id, 1);
        }
        await waitTicks(main, 1);
    }
    throw Error('failed climbing Games Room stairs to Burthorpe');
}

export function remainingIronOresTo99(currentXp: number): number {
    return Math.max(0, Math.ceil((xpForLevel(99) - currentXp) / IRON_ORE_XP_25X));
}

async function completeDoricQuest(main: Awaited<ReturnType<typeof openHelperAndMain>>['main'], stop: () => boolean): Promise<void> {
    const converse = async (pats: readonly RegExp[], done: () => boolean, maxTicks = 25): Promise<void> => {
        for (let i = 0; i < maxTicks && !stop(); i++) {
            if (done()) return;
            const d = main.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await main.direct({ type: 'clickDialogOption', optionIndex: opt ? opt.index : 0, reason: 'SDK' });
            }
            await waitTicks(main, 1);
        }
    };

    const talkDoric = async () => {
        for (let t = 0; t < 4 && !stop(); t++) {
            const npc = main.sdk.findNearbyNpc(/^doric$/i);
            if (npc && chebDist({ x: npc.x, z: npc.z }, { x: main.sdk.getState()!.player!.worldX, z: main.sdk.getState()!.player!.worldZ }) <= 5) {
                const r = await main.bot.talkTo(/^doric$/i);
                if (r.success || main.sdk.getDialog()?.isOpen) return;
            }
            await main.bot.walkTo(2952, 3451, 1);
            await waitTicks(main, 1);
        }
        throw Error('could not talk to Doric');
    };

    await talkDoric();
    let part1Open = false;
    await converse(
        [/wanted to use your anvils/i, /yes, i will get you materials/i],
        () => {
            const open = !!main.sdk.getDialog()?.isOpen;
            if (open) part1Open = true;
            return part1Open && !open;
        },
        25,
    );

    await talkDoric();
    await converse(
        [/have my materials/i, /yes/i],
        () => (main.sdk.getSkill('Mining')?.baseLevel ?? 1) >= 49,
        35,
    );
    if ((main.sdk.getSkill('Mining')?.baseLevel ?? 1) < 49) {
        throw Error(`Doric's Quest did not grant Mining 49 (level=${main.sdk.getSkill('Mining')?.baseLevel})`);
    }
}

if (import.meta.main) {
    const account = process.argv[2];
    const helperName = process.argv.slice(3).find(a => !a.includes('=') && !a.startsWith('-')) ?? process.env.HELPER ?? `${account}b`;
    const cap = Number(process.env.CAP ?? 4400);
    if (!account) throw Error('usage: bun scripts/mining-specialist.ts <account> [helperAccount]');

    const { main, helper, stopped } = await openHelperAndMain(account, helperName);
    const t0 = main.tick();
    const isStopped = () => stopped() || existsSync(`.practice/stop-${account}`) || existsSync('.practice/stop-all') || main.tick() - t0 >= cap;
    let helperDone: Promise<void> | undefined;
    let ok = false;
    let detail = '';

    const supplies = isLiveSupplyVariant() ? MINING_SPECIALIST_LIVE_SUPPLIES : MINING_SPECIALIST_SUPPLIES;
    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropTutorialJunk(main, isStopped, 13);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, supplies, isStopped, arm, { [OBJ_GLORY_4]: MINING_GLORY_IDS });
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        if (itemQty(main, OBJ_GAMES_8) > 0) {
            await rubTeleport(
                main,
                [OBJ_GAMES_8],
                1,
                p => p.level === 0 && p.worldX >= 2195 && p.worldX <= 2220 && p.worldZ >= 4925 && p.worldZ <= 4950,
                isStopped,
            );
            await exitGamesRoomToBurthorpe(main, isStopped);
            await walkWaypointsSafe(main, [[2952, 3451, 2]], isStopped);
        } else if (MINING_GLORY_IDS.some(id => itemQty(main, id) > 0)) {
            await rubTeleport(
                main,
                MINING_GLORY_IDS,
                1,
                p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
                isStopped,
            );
            await walkWaypointsSafe(main, [[3020, 3425, 4], [2952, 3451, 2]], isStopped);
        } else {
            await walkWaypointsSafe(
                main,
                [[3140, 3260, 4], [3075, 3315, 4], [3072, 3375, 4], [3010, 3408, 4], [2952, 3451, 2]],
                isStopped,
            );
        }

        await completeDoricQuest(main, isStopped);
        const doricTicks = main.tick() - t0;

        const useLiveDueling = isLiveSupplyVariant() && RING_OF_DUELING_IDS.some(id => itemQty(main, id) > 0);
        if (useLiveDueling) {
            await rubTeleport(
                main,
                RING_OF_DUELING_IDS,
                /castle wars/i,
                p => p.level === 0 && p.worldX >= 2430 && p.worldX <= 2455 && p.worldZ >= 3075 && p.worldZ <= 3105,
                isStopped,
            );
            await walkWaypointsSafe(main, CWARS_TO_ARDY_ZOO_WAYPOINTS, isStopped);
        } else {
            await rubTeleport(
                main,
                MINING_GLORY_IDS,
                2,
                p => p.worldX >= 2900 && p.worldX <= 2960 && p.worldZ >= 3140 && p.worldZ <= 3200,
                isStopped,
            );
            await walkWaypointsSafe(main, [[2774, 3228, 3]], isStopped);
            await sailBrimhavenToArdougne(main, isStopped);
            await walkWaypointsSafe(main, [[2603, 3234, 1]], isStopped);
        }

        const mineStart = main.tick() - t0;
        const ironProfile = miningProfiles().find(p => p.name === 'iron_rock_table');
        if (!ironProfile) throw Error('missing iron_rock_table profile');
        const site = MINING_SITES.find(s => s.key === 'ardougne-zoo-iron');
        if (!site) throw Error('missing ardougne-zoo-iron site');
        const rocks = siteTiles(ironProfile, site);
        const need = remainingIronOresTo99(main.sdk.getSkillXp('Mining') ?? 0);

        const rot = await runRotationMining(
            {
                state: () => main.sdk.getState(),
                tick: () => main.tick(),
                stop: isStopped,
                mine: l => main.sdk.sendInteractLoc(l.x, l.z, l.id, 1).then(r => r.success),
                wait: (test, ticks) => waitUntil(main, test, { timeoutTicks: ticks }),
                step: () => waitTicks(main, 1),
                clearModal: () => main.direct({ type: 'closeModal', reason: 'SDK' }).then(() => {}),
                send: async acts => {
                    const st = main.sdk.getState();
                    const all: Array<{ type: string; [k: string]: unknown }> = [];
                    if ((st?.dialog?.isOpen || st?.modalOpen) && !acts.some(a => a.type === 'closeModal') && acts.length < 5) {
                        all.push({ type: 'closeModal', reason: 'SDK' });
                    }
                    for (const a of acts) all.push({ ...a, reason: 'SDK' });
                    await Promise.all(all.map(a => main.direct(a)));
                },
            },
            ironProfile,
            {
                maximum: need,
                cap: Math.max(200, cap - (main.tick() - t0)),
                idleTicks: 240,
                knife: true,
                drop: true,
                make1: SKILL_MULTI3_MAKE1_A,
                rocks,
                pick: 'roll',
                keep: [OBJ_RUNE_PICKAXE, ...MINING_GLORY_IDS, ...RING_OF_DUELING_IDS, OBJ_COINS],
            },
            2,
            incidentalMiningGems,
        );

        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Mining')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Mining') ?? 0;
        ok = lvl >= 99;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} doric=${doricTicks} mineStart=${mineStart} ores=${rot.made}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
