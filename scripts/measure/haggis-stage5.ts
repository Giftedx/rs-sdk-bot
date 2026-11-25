// Haggis Overall Stage-5 isolated/practice rehearsal: Barbarian Village river -> Edgeville Bank ->
// Doric's Quest (Mining 1->49) -> Ring of dueling Castle Wars -> Ardougne Zoo 6-rock 3-tick knife-reset iron (49->99).
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { getWorld } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { goTo } from '../../packages/core/src/walk';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import {
    CWARS_TO_ARDY_ZOO_WAYPOINTS,
    OBJ_COINS,
    OBJ_DUELING_8,
    OBJ_KNIFE,
    OBJ_LOGS,
    RING_OF_DUELING_IDS,
    SKILL_MULTI3_MAKE1_A,
    chebDist,
    openBot,
    rubTeleport,
    settle,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';
import { incidentalMiningGems, miningProfiles, MINING_SITES, runRotationMining, siteTiles } from '../../packages/workers/src/gather';
import {
    OBJ_CLAY,
    OBJ_COPPER_ORE,
    OBJ_IRON_ORE,
    OBJ_RUNE_PICKAXE,
    remainingIronOresTo99,
} from '../mining-specialist';
import { dialogOpen, inv, level, meter, send, tick, withdrawN, xp } from '../../packages/practice/src/floor-lib';

export const BARBARIAN_FLY_START = { x: 3109, z: 3434, level: 0 } as const;
export const EDGEVILLE_BANK_SPOT = { x: 3094, z: 3491, level: 0 } as const;
export const DORIC_SPOT = { x: 2952, z: 3451, level: 0 } as const;
export const ARDOUGNE_ZOO_IRON_SPOT = { x: 2603, z: 3234, level: 0 } as const;
export const STAGE5_DEFAULT_LOGS = 2;

export interface Stage5Phases {
    readonly toBankTicks: number;
    readonly bankTicks: number;
    readonly toDoricTicks: number;
    readonly doricTicks: number;
    readonly miningAfterDoric: number;
    readonly toZooTicks: number;
    readonly zooMiningTicks: number;
    readonly oresMined: number;
    readonly miningLevel: number;
    readonly miningXp: number;
    readonly totalElapsedTicks: number;
}

const RESERVED_SET = new Set(RESERVED_ACCOUNTS.map(name => name.toLowerCase()));

/** Rejects empty or reserved account names before any Stage-5 session opens. */
export function assertSafeStage5Account(accountName: string): string {
    const clean = accountName.trim();
    if (!clean) throw Error('haggis-stage5: main account name required');
    if (RESERVED_SET.has(clean.toLowerCase())) {
        throw Error(`haggis-stage5: refuses reserved account ${clean}`);
    }
    return clean;
}

/** Builds the deterministic Stage-5 preset starting at Barbarian Village river after Stage 4 (Fishing 99). */
export function buildStage5Plan(extraLogs = STAGE5_DEFAULT_LOGS) {
    if (!Number.isSafeInteger(extraLogs) || extraLogs < 1 || extraLogs > 10) {
        throw Error(`haggis-stage5: extraLogs must be between 1 and 10, got ${extraLogs}`);
    }
    return {
        startingPosition: BARBARIAN_FLY_START,
        startingSkills: {
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
        },
        mainInventory: [] as { id: number; count: number }[],
        mainBank: [
            { id: OBJ_RUNE_PICKAXE, count: 1 },
            { id: OBJ_KNIFE, count: 1 },
            { id: OBJ_LOGS, count: extraLogs },
            { id: OBJ_DUELING_8, count: 1 },
            { id: OBJ_CLAY, count: 6 },
            { id: OBJ_COPPER_ORE, count: 4 },
            { id: OBJ_IRON_ORE, count: 2 },
        ],
    };
}

async function withdrawStage5Pack(main: Session, extraLogs: number): Promise<void> {
    const m = meter(main, 'Mining');
    if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
    if (!(await main.bot.openBank()).success || !await waitUntil(main, () => !!main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 })) {
        throw Error('haggis-stage5: Edgeville bank did not open');
    }
    if (inv(main).length > 0) {
        const seen = new Set<number>();
        for (const it of inv(main)) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
        }
        await waitUntil(main, () => inv(main).length === 0, { timeoutTicks: 10 });
    }
    const items: ReadonlyArray<readonly [number, number]> = [
        [OBJ_RUNE_PICKAXE, 1],
        [OBJ_KNIFE, 1],
        [OBJ_LOGS, extraLogs],
        [OBJ_DUELING_8, 1],
        [OBJ_CLAY, 6],
        [OBJ_COPPER_ORE, 4],
        [OBJ_IRON_ORE, 2],
    ];
    for (const [id, neededCount] of items) {
        const bankItem = main.sdk.getState()?.bank?.items.find(i => i.id === id);
        if (!bankItem || bankItem.count < neededCount) {
            throw Error(`haggis-stage5: Edgeville bank short on item ${id} (${bankItem?.count ?? 0} < ${neededCount})`);
        }
        await withdrawN(main, m, bankItem.slot, neededCount);
        const received = await waitUntil(
            main,
            () => inv(main).filter(i => i.id === id).reduce((n, i) => n + i.count, 0) >= neededCount,
            { timeoutTicks: 12 },
        );
        if (!received) throw Error(`haggis-stage5: withdraw ${id} unobserved`);
    }
    await main.bot.closeBank();
    await waitUntil(main, () => !main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
}

async function completeDoricQuestStage5(main: Session, stop: () => boolean): Promise<void> {
    const m = meter(main, 'Mining');
    const converse = async (pats: readonly RegExp[], done: () => boolean, maxTicks = 30): Promise<void> => {
        for (let i = 0; i < maxTicks && !stop(); i++) {
            if (done()) return;
            const d = main.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) {
                const opt = d.options.find(o => pats.some(re => re.test(o.text)));
                await send(main, m, { type: 'clickDialogOption', optionIndex: opt ? opt.index : 0 });
            }
            await waitTicks(main, 1);
        }
    };
    const talkDoric = async () => {
        for (let t = 0; t < 5 && !stop(); t++) {
            const p = main.sdk.getState()?.player;
            const npc = main.sdk.findNearbyNpc(/^doric$/i);
            if (p && npc && chebDist({ x: npc.x, z: npc.z }, { x: p.worldX, z: p.worldZ }) <= 5) {
                const r = await main.bot.talkTo(/^doric$/i);
                if (r.success || main.sdk.getDialog()?.isOpen) return;
            }
            await main.bot.walkTo(DORIC_SPOT.x, DORIC_SPOT.z, 1);
            await waitTicks(main, 1);
        }
        throw Error('haggis-stage5: could not talk to Doric');
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
        () => level(main, 'Mining') >= 49,
        35,
    );
    if (level(main, 'Mining') < 49) {
        throw Error(`haggis-stage5: Doric's Quest did not grant Mining 49 (level=${level(main, 'Mining')})`);
    }
    await waitTicks(main, 1);
    if (dialogOpen(main)) {
        await send(main, m, { type: 'closeModal' });
        await waitUntil(main, () => !dialogOpen(main), { timeoutTicks: 6 });
    }
}

/** Runs Stage 5 on an already-staged practice account: Edgeville bank -> Doric -> Castle Wars -> Ardougne Zoo iron 99. */
export async function runHaggisStage5(
    mainName: string,
    opts: { cap?: number; extraLogs?: number } = {},
): Promise<{ phases: Stage5Phases }> {
    const cleanMain = assertSafeStage5Account(mainName);
    const extraLogs = opts.extraLogs ?? STAGE5_DEFAULT_LOGS;
    buildStage5Plan(extraLogs);
    const cap = opts.cap ?? 5500;

    let stopFlag = false;
    let settling = false;
    const main = await openBot(cleanMain, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (_s, detail) => { if (!settling) throw Error(`unexpected stage5 end: ${detail}`); },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const m = meter(main, 'Mining');

    try {
        await tick(main, 3);
        const world = await getWorld();

        const walkBankStart = main.tick();
        const toBank = await goTo(
            main,
            world,
            EDGEVILLE_BANK_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 90, noJewelry: true },
        );
        if (!toBank.ok) throw Error(`haggis-stage5: walk to Edgeville bank failed: ${toBank.detail ?? toBank.reason ?? 'unknown'}`);
        const toBankTicks = main.tick() - walkBankStart;

        const bankStart = main.tick();
        await withdrawStage5Pack(main, extraLogs);
        const bankTicks = main.tick() - bankStart;

        const walkDoricStart = main.tick();
        const toDoric = await goTo(
            main,
            world,
            DORIC_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 160, noJewelry: true },
        );
        if (!toDoric.ok) throw Error(`haggis-stage5: walk to Doric failed: ${toDoric.detail ?? toDoric.reason ?? 'unknown'}`);
        const toDoricTicks = main.tick() - walkDoricStart;

        const doricStart = main.tick();
        await completeDoricQuestStage5(main, isStopped);
        const doricTicks = main.tick() - doricStart;
        const miningAfterDoric = level(main, 'Mining');

        const travelStart = main.tick();
        await rubTeleport(
            main,
            RING_OF_DUELING_IDS,
            /castle wars/i,
            p => p.level === 0 && p.worldX >= 2430 && p.worldX <= 2455 && p.worldZ >= 3075 && p.worldZ <= 3105,
            isStopped,
        );
        await walkWaypointsSafe(main, CWARS_TO_ARDY_ZOO_WAYPOINTS, isStopped);
        const toZooTicks = main.tick() - travelStart;

        const zooStart = main.tick();
        const ironProfile = miningProfiles().find(p => p.name === 'iron_rock_table');
        if (!ironProfile) throw Error('haggis-stage5: missing iron_rock_table profile');
        const zooSite = MINING_SITES.find(s => s.key === 'ardougne-zoo-iron');
        if (!zooSite) throw Error('haggis-stage5: missing ardougne-zoo-iron site');
        const rocks = siteTiles(ironProfile, zooSite);
        const oresNeeded = Math.max(1, remainingIronOresTo99(xp(main, 'Mining')));

        const rot = await runRotationMining(
            {
                state: () => main.sdk.getState(),
                tick: () => main.tick(),
                stop: isStopped,
                mine: l => main.sdk.sendInteractLoc(l.x, l.z, l.id, 1).then(r => r.success),
                wait: (test, ticks) => waitUntil(main, test, { timeoutTicks: ticks }),
                step: () => waitTicks(main, 1),
                clearModal: () => send(main, m, { type: 'closeModal' }).then(() => {}),
                send: async acts => {
                    for (const a of acts) await send(main, m, a);
                },
            },
            ironProfile,
            {
                maximum: oresNeeded,
                cap: Math.max(200, cap - (main.tick() - t0)),
                idleTicks: 240,
                knife: true,
                drop: true,
                make1: SKILL_MULTI3_MAKE1_A,
                rocks,
                pick: 'roll',
                keep: [OBJ_RUNE_PICKAXE, ...RING_OF_DUELING_IDS, OBJ_COINS],
            },
            2,
            incidentalMiningGems,
        );
        const zooMiningTicks = main.tick() - zooStart;

        const miningLevel = level(main, 'Mining');
        const miningXp = xp(main, 'Mining');
        const totalElapsedTicks = main.tick() - t0;
        const passed = miningLevel >= 99 && miningXp >= xpForLevel(99) && totalElapsedTicks <= cap;
        settling = true;
        const ok = await settle(
            [main],
            passed,
            `mining=${miningLevel} xp=${miningXp} doric=${doricTicks} zoo=${zooMiningTicks} ores=${rot.made} total=${totalElapsedTicks}`,
        );
        if (!ok) {
            throw Error(`haggis-stage5 failed end checks: mining=${miningLevel} xp=${miningXp} total=${totalElapsedTicks}`);
        }
        return {
            phases: {
                toBankTicks,
                bankTicks,
                toDoricTicks,
                doricTicks,
                miningAfterDoric,
                toZooTicks,
                zooMiningTicks,
                oresMined: rot.made,
                miningLevel,
                miningXp,
                totalElapsedTicks,
            },
        };
    } catch (error) {
        stopFlag = true;
        settling = true;
        console.error(`STAGE5_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-5 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(cap?: number): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage5 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStage5Plan();
    const mainName = assertSafeStage5Account(runBotName('hs5m', 1));
    const botsDir = join(rsSdkRoot(), 'bots');
    const save = playerSavePath(mainName);
    try {
        const created = await createBot(mainName);
        pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        rmSync(save, { force: true });
        await applyPreset(mainName, {
            position: plan.startingPosition,
            skills: { ...plan.startingSkills },
            varps: { 29: 2, 159: 12, 173: 1 },
            inventory: [],
            bank: [...plan.mainBank],
        });
        const stack = await startIsolatedStack();
        try {
            const { phases } = await runHaggisStage5(mainName, { cap });
            console.log(
                `STAGE5 pass mining=${phases.miningLevel}(${phases.miningXp}xp) afterDoric=${phases.miningAfterDoric}`
                + ` toBank=${phases.toBankTicks} bank=${phases.bankTicks} toDoric=${phases.toDoricTicks}`
                + ` doric=${phases.doricTicks} toZoo=${phases.toZooTicks} zoo=${phases.zooMiningTicks}`
                + ` ores=${phases.oresMined} totalSession=${phases.totalElapsedTicks}`,
            );
        } finally {
            await stack.stop();
        }
    } finally {
        rmSync(join(botsDir, mainName), { recursive: true, force: true });
        rmSync(save, { force: true });
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const capArg = args.find(a => /^\d+$/.test(a));
    const cap = capArg ? Number(capArg) : undefined;
    const positional = args.filter(a => !/^\d+$/.test(a) && !a.startsWith('-'));
    const isolatedMode = args.includes('--isolated') || positional.length === 0;
    try {
        if (isolatedMode) {
            await runIsolated(cap);
        } else {
            const { phases } = await runHaggisStage5(positional[0]!, { cap });
            console.log(`STAGE5 pass ${JSON.stringify(phases)}`);
        }
        process.exit(0);
    } catch (err) {
        console.error(`STAGE5 fail ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
