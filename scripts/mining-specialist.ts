import { existsSync } from 'node:fs';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { xpForLevel } from '../packages/planner/src/curve';
import { miningProfiles, incidentalMiningGems } from './microbot-b-mining';
import { runRotationMining, siteTiles, MINING_SITES } from './mining-rotation';
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
    finish,
    chebDist,
    SKILL_MULTI3_MAKE1_A,
    OBJ_KNIFE,
    OBJ_LOGS,
    OBJ_COINS,
    OBJ_GLORY_4,
    OBJ_SUPER_ENERGY_4,
    ENERGY_POTION_IDS,
} from './gathering-specialist-lib';

export const OBJ_RUNE_PICKAXE = 1275;
export const OBJ_CLAY = 434;
export const OBJ_COPPER_ORE = 436;
export const OBJ_IRON_ORE = 440;
export const IRON_ORE_XP_25X = 875;

export const MINING_GLORY_IDS = [1712, 1710, 1708, 1706] as const;

export const MINING_SPECIALIST_SUPPLIES: Readonly<Record<number, number>> = {
    [OBJ_RUNE_PICKAXE]: 1,
    [OBJ_KNIFE]: 1,
    [OBJ_LOGS]: 2,
    [OBJ_CLAY]: 6,
    [OBJ_COPPER_ORE]: 4,
    [OBJ_IRON_ORE]: 2,
    [OBJ_COINS]: 150,
    [OBJ_GLORY_4]: 1,
    [OBJ_SUPER_ENERGY_4]: 2,
};

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

    // Part 1: accept quest and exit immediately when dialog closes.
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

    // Part 2: hand in 6 clay, 4 copper ore, 2 iron ore -> 32,500 Mining XP (lvl 49).
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

    let readyForTrade = false;
    const arm = startHelperTradeArm(helper, main.name, isStopped, () => readyForTrade);
    try {
        const tutTicks = await skipTutorialFast(main, isStopped);
        await dropTutorialJunk(main, isStopped, 12);
        readyForTrade = true;
        const tradeTicks = await receiveTradeFast(main, helper, MINING_SPECIALIST_SUPPLIES, isStopped, arm);
        helperDone = settleHelper(helper).catch(err => {
            console.log(`WARN helper settle: ${String(err)}`);
        });

        // Glory option 1 -> Edgeville (3087,3496), direct southern path around Ice Mountain to Doric (2952,3451).
        await rubTeleport(
            main,
            MINING_GLORY_IDS,
            1,
            p => p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        await walkWaypointsSafe(
            main,
            [[2952, 3451, 2]],
            isStopped,
        );

        await completeDoricQuest(main, isStopped);
        const doricTicks = main.tick() - t0;

        // Glory option 2 -> Karamja -> Brimhaven boat -> Ardougne dock -> Ardougne Zoo 6-rock iron.
        await rubTeleport(
            main,
            MINING_GLORY_IDS,
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
        await walkWaypointsSafe(main, [[2603, 3234, 1]], isStopped);

        const zooStart = main.tick() - t0;
        const ironProfile = miningProfiles().find(p => p.name === 'iron_rock_table');
        if (!ironProfile) throw Error('missing iron_rock_table profile');
        const zooSite = MINING_SITES.find(s => s.key === 'ardougne-zoo-iron');
        if (!zooSite) throw Error('missing ardougne-zoo-iron site');
        const rocks = siteTiles(ironProfile, zooSite);
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
                    for (const a of acts) await main.direct({ ...a, reason: 'SDK' });
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
                keep: [OBJ_RUNE_PICKAXE, ...MINING_GLORY_IDS, OBJ_COINS, ...ENERGY_POTION_IDS],
            },
            2,
            incidentalMiningGems,
        );

        const totalTicks = main.tick() - t0;
        const lvl = main.sdk.getSkill('Mining')?.baseLevel ?? 0;
        const xp = main.sdk.getSkillXp('Mining') ?? 0;
        ok = lvl >= 99;
        detail = `level=${lvl} xp=${xp} ticks=${totalTicks} tut=${tutTicks} trade=${tradeTicks} doric=${doricTicks} zooStart=${zooStart} ores=${rot.made}`;
    } catch (error) {
        detail = String(error);
    } finally {
        arm.close();
    }

    await helperDone;
    await finish([main], ok, detail);
}
