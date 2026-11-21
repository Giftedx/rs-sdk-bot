// Haggis Overall Stage-2 isolated/practice rehearsal: Lumbridge kitchen -> Glory Draynor -> Lumbridge-North 157-log
// Firemaking line 1->99 -> Glory Draynor -> Draynor bank dragon-bone burst burying Prayer 1->43.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { GLORY_IDS } from '../fast-skills-lib';
import {
    OBJ_GLORY_4,
    closeWithin,
    finish,
    openBot,
    rubTeleport,
    settle,
    waitTicks,
    waitUntil,
    walkWaypointsSafe,
} from '../gathering-specialist-lib';
import { planOf } from './floor-fm-line';
import { band, dialogOpen, inv, level, meter, send, tick, xp } from './floor-lib';

export const FM_NORTH_ROWS = '3306,3211,3182;3307,3185,3171;3311,3176,3098;3312,3103,3071';
export const STAGE2_PACK = 26; // tinderbox + Glory(4) + 26 first logs fill all 28 inventory slots
export const STAGE2_CHUNK = 28;
export const STAGE2_HELPER_SUFFIXES = 'bcdef';
export const OBJ_TINDERBOX = 590;
export const OBJ_DRAGON_BONES = 536;
export const LUMBRIDGE_KITCHEN = { x: 3207, z: 3215, level: 0 } as const;
export const DRAYNOR_BANK = { x: 3092, z: 3243, level: 0 } as const;
const FM_LEAD = 36;
const DEFAULT_DRAGON_BONES = 28; // Prayer 1->43 needs 19,684 XP (11 bones x 1,800 XP at 25x)

export interface Stage2Phases {
    readonly toFmLineTicks: number;
    readonly fmBurnTicks: number;
    readonly toDraynorBankTicks: number;
    readonly prayerTicks: number;
    readonly totalElapsedTicks: number;
    readonly firemakingLevel: number;
    readonly firemakingXp: number;
    readonly prayerLevel: number;
    readonly prayerXp: number;
    readonly logsLit: number;
    readonly bonesBuried: number;
    readonly fmWaitTicks: number;
    readonly endPlaytime: number | null;
}

export interface Stage2Plan {
    readonly totalLogs: number;
    readonly packLogs: ReturnType<typeof planOf>;
    readonly helperChunks: ReadonlyArray<ReturnType<typeof planOf>>;
    readonly mainInventory: ReadonlyArray<{ id: number; count: number }>;
    readonly mainBank: ReadonlyArray<{ id: number; count: number }>;
}

/** Validates main and line-dropper helper account names against reserved live accounts and collisions. */
export function assertSafeStage2Accounts(mainName: string, helperCount = STAGE2_HELPER_SUFFIXES.length): {
    readonly mainName: string;
    readonly helperNames: readonly string[];
} {
    const cleanMain = mainName.trim();
    if (!cleanMain) throw Error('haggis-stage2: main account name required');
    if (RESERVED_ACCOUNTS.includes(cleanMain.toLowerCase())) {
        throw Error(`haggis-stage2: refuses reserved account ${cleanMain}`);
    }
    if (helperCount < 1 || helperCount > STAGE2_HELPER_SUFFIXES.length) {
        throw Error(`haggis-stage2: invalid helperCount=${helperCount}`);
    }
    const helperNames: string[] = [];
    for (let i = 0; i < helperCount; i++) {
        const name = `${cleanMain}${STAGE2_HELPER_SUFFIXES[i]!}`;
        if (RESERVED_ACCOUNTS.includes(name.toLowerCase())) {
            throw Error(`haggis-stage2: refuses reserved helper account ${name}`);
        }
        helperNames.push(name);
    }
    if (new Set(helperNames.map(n => n.toLowerCase())).size !== helperNames.length) {
        throw Error('haggis-stage2: duplicate helper names');
    }
    return { mainName: cleanMain, helperNames };
}

/** Builds main pack (Glory, tinderbox, first 26 logs), bank bones, and helper ground-drop chunks. */
export function buildStage2Plan(boneCount = DEFAULT_DRAGON_BONES): Stage2Plan {
    if (!Number.isSafeInteger(boneCount) || boneCount < 11) {
        throw Error(`haggis-stage2: need at least 11 dragon bones for Prayer 43, got ${boneCount}`);
    }
    const full = planOf(FM_NORTH_ROWS);
    const packLogs = full.slice(0, STAGE2_PACK);
    const helperChunks: ReturnType<typeof planOf>[] = [];
    for (let offset = STAGE2_PACK; offset < full.length; offset += STAGE2_CHUNK) {
        helperChunks.push(full.slice(offset, offset + STAGE2_CHUNK));
    }
    return {
        totalLogs: full.length,
        packLogs,
        helperChunks,
        mainInventory: [
            { id: OBJ_GLORY_4, count: 1 },
            { id: OBJ_TINDERBOX, count: 1 },
            ...packLogs.map(p => ({ id: p.id, count: 1 })),
        ],
        mainBank: [{ id: OBJ_DRAGON_BONES, count: boneCount }],
    };
}

function readPlaytimeTicks(account: string): number | null {
    try {
        return readFileSync(playerSavePath(account)).readInt32BE(24);
    } catch {
        return null;
    }
}

async function teleportDraynor(s: Session, isStopped: () => boolean): Promise<void> {
    await rubTeleport(
        s,
        GLORY_IDS,
        /draynor/i,
        p => p.level === 0 && p.worldX >= 3098 && p.worldX <= 3115 && p.worldZ >= 3240 && p.worldZ <= 3260,
        isStopped,
    );
}

async function runHelperChunk(
    h: Session,
    chunk: ReturnType<typeof planOf>,
    k: number,
    firstIndex: number,
    shouldStart: () => boolean,
    isStopped: () => boolean,
): Promise<void> {
    while (!shouldStart() && !isStopped()) await tick(h);
    const pos = () => h.sdk.getState()!.player!;
    for (let j = 0; j < chunk.length && !isStopped(); j++) {
        const p = chunk[j]!;
        const t1 = h.tick();
        while ((pos().worldX !== p.x || pos().worldZ !== p.z) && h.tick() - t1 < 40 && !isStopped()) {
            if ((h.tick() - t1) % 4 === 0) {
                await h.direct({ type: 'walkTo', x: p.x, z: p.z, running: true, reason: 'SDK' });
            }
            await tick(h);
        }
        const it = inv(h).find(i => i.id === p.id);
        if (!it) throw Error(`helper ${k} missing log ${p.id} at job ${firstIndex + j}`);
        const n0 = inv(h).length;
        await h.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
        const td = h.tick();
        while (inv(h).length >= n0 && h.tick() - td < 6 && !isStopped()) await tick(h);
    }
    if (!isStopped()) {
        const e = pos();
        await h.direct({ type: 'walkTo', x: e.worldX, z: e.worldZ + 2, running: true, reason: 'SDK' });
    }
}

async function burnNorthLine(
    main: Session,
    plan: ReturnType<typeof planOf>,
    isStopped: () => boolean,
    onLit: () => void,
): Promise<{ logsLit: number; waitTicks: number }> {
    const m = meter(main, 'Firemaking');
    const pos = () => main.sdk.getState()!.player!;
    const ground = () => ((main.sdk.getState() as any)?.groundItems ?? []) as any[];
    const msgs = () => ((main.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(' | ');
    const tinder = inv(main).find(i => i.id === OBJ_TINDERBOX);
    if (!tinder) throw Error('haggis-stage2: missing tinderbox');

    let lit = 0;
    let waitTicks = 0;
    for (let i = 0; i < plan.length && level(main, 'Firemaking') < 99 && !isStopped(); i++) {
        const p = plan[i]!;
        const before = xp(main, 'Firemaking');
        const tl = main.tick();
        if (i < STAGE2_PACK) {
            if (pos().worldX !== p.x || pos().worldZ !== p.z) {
                await walkWaypointsSafe(main, [[p.x, p.z, 0]], isStopped);
            }
            const logIt = inv(main).find(x => x.id === p.id);
            if (!logIt) throw Error(`missing pack log ${p.id} at job ${i}`);
            if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
            await send(main, m, { type: 'useItemOnItem', sourceSlot: tinder.slot, targetSlot: logIt.slot });
            while (xp(main, 'Firemaking') === before && main.tick() - tl < 120 && !isStopped()) {
                await tick(main);
                if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
                if (/can't light a fire here/i.test(msgs())) throw Error(`cannot light pack log at ${p.x},${p.z}`);
                if ((main.tick() - tl) % 6 === 0 && inv(main).some(x => x.slot === logIt.slot && x.id === p.id)) {
                    await send(main, m, { type: 'useItemOnItem', sourceSlot: tinder.slot, targetSlot: logIt.slot });
                }
            }
        } else {
            const visible = () => ground().some(g => g.id === p.id && g.x === p.x && g.z === p.z);
            const tw = main.tick();
            while (!visible() && main.tick() - tw < 300 && !isStopped()) await tick(main);
            if (!visible()) throw Error(`ground log ${i} (${p.id}) never appeared at ${p.x},${p.z}`);
            waitTicks += main.tick() - tw;
            if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
            await send(main, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
            const turnNext = plan[i + 1] && plan[i + 1]!.row !== p.row;
            let onTile = false;
            while (visible() && main.tick() - tl < 120 && !isStopped()) {
                await tick(main);
                const me = pos();
                if (me.worldX === p.x && me.worldZ === p.z) onTile = true;
                else if (onTile && turnNext) break;
                if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
                if (/can't light a fire here/i.test(msgs())) throw Error(`cannot light ground log at ${p.x},${p.z}`);
                if ((main.tick() - tl) % 6 === 0 && visible()) {
                    await send(main, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
                }
            }
        }
        lit++;
        onLit();
        band(m, p.band, xp(main, 'Firemaking') - before, main.tick() - tl, 1);
    }
    if (level(main, 'Firemaking') < 99) throw Error(`Firemaking stopped at level=${level(main, 'Firemaking')}`);
    return { logsLit: lit, waitTicks };
}

async function buryBonesTo43(main: Session, isStopped: () => boolean): Promise<number> {
    const m = meter(main, 'Prayer');
    if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
    if (!(await main.bot.openBank()).success || !await waitUntil(main, () => !!main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 15 })) {
        throw Error('Draynor bank did not open');
    }
    const bankBones = main.sdk.getState()?.bank?.items.find(i => i.id === OBJ_DRAGON_BONES);
    if (!bankBones || bankBones.count < 11) throw Error(`Draynor bank short of dragon bones: ${bankBones?.count ?? 0}`);
    await send(main, m, { type: 'bankWithdraw', slot: bankBones.slot, amount: -1 });
    await waitUntil(main, () => inv(main).some(i => i.id === OBJ_DRAGON_BONES), { timeoutTicks: 10 });
    await main.bot.closeBank();
    await waitUntil(main, () => !main.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });

    const goalPrayerXp = xpForLevel(43);
    let buried = 0;
    let stall = 0;
    while (level(main, 'Prayer') < 43 && (main.sdk.getSkillXp('Prayer') ?? 0) < goalPrayerXp && stall < 20 && !isStopped()) {
        const bones = inv(main).filter(i => i.id === OBJ_DRAGON_BONES);
        if (bones.length === 0) break;
        const beforeCount = bones.length;
        if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
        for (const b of bones.slice(0, 5)) {
            await send(main, m, { type: 'useInventoryItem', slot: b.slot, optionIndex: 1 });
        }
        await tick(main);
        const nowCount = inv(main).filter(i => i.id === OBJ_DRAGON_BONES).length;
        const delta = beforeCount - nowCount;
        buried += Math.max(0, delta);
        stall = delta > 0 || dialogOpen(main) ? 0 : stall + 1;
    }
    if (level(main, 'Prayer') < 43) {
        throw Error(`Prayer reached ${level(main, 'Prayer')} (${main.sdk.getSkillXp('Prayer')}) < 43 after burying ${buried} bones`);
    }
    return buried;
}

/** Runs Stage 2 on already-staged practice accounts: Lumbridge kitchen -> fm-burn (99) -> Draynor Prayer (43). */
export async function runHaggisStage2(
    mainName: string,
    opts: { cap?: number; boneCount?: number } = {},
): Promise<{ phases: Stage2Phases }> {
    const planData = buildStage2Plan(opts.boneCount);
    const { helperNames } = assertSafeStage2Accounts(mainName, planData.helperChunks.length);
    const fullPlan = planOf(FM_NORTH_ROWS);
    const cap = opts.cap ?? 1200;

    let stopFlag = false;
    const main = await openBot(mainName, { onStop: async () => { stopFlag = true; } });
    const helpers: Session[] = [];
    for (const hName of helperNames) {
        helpers.push(await openBot(hName, { onStop: async () => { stopFlag = true; } }));
    }
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;

    try {
        await tick(main, 3);
        let lit = 0;
        const helperDone = Promise.all(helpers.map((h, k) => {
            const first = STAGE2_PACK + k * STAGE2_CHUNK;
            const shouldStart = () => k === 0 ? (main.tick() - t0 >= 25) : lit >= first - FM_LEAD;
            return runHelperChunk(h, planData.helperChunks[k]!, k, first, shouldStart, isStopped);
        }));

        const walkStart = main.tick();
        await teleportDraynor(main, isStopped);
        await walkWaypointsSafe(main, [[fullPlan[0]!.x, fullPlan[0]!.z, 0]], isStopped);
        const toFmLineTicks = main.tick() - walkStart;

        const fmStart = main.tick();
        const { logsLit, waitTicks: fmWaitTicks } = await burnNorthLine(main, fullPlan, isStopped, () => { lit++; });
        const fmBurnTicks = main.tick() - fmStart;
        await helperDone;

        const bankTravelStart = main.tick();
        await teleportDraynor(main, isStopped);
        await walkWaypointsSafe(main, [[DRAYNOR_BANK.x, DRAYNOR_BANK.z, 2]], isStopped);
        const toDraynorBankTicks = main.tick() - bankTravelStart;

        const prayStart = main.tick();
        const bonesBuried = await buryBonesTo43(main, isStopped);
        const prayerTicks = main.tick() - prayStart;

        const totalElapsedTicks = main.tick() - t0;
        const firemakingLevel = level(main, 'Firemaking');
        const firemakingXp = xp(main, 'Firemaking');
        const prayerLevel = level(main, 'Prayer');
        const prayerXp = xp(main, 'Prayer');
        const ok = await settle(
            [main, ...helpers],
            firemakingLevel >= 99 && prayerLevel >= 43,
            `fm=${firemakingLevel} prayer=${prayerLevel} lit=${logsLit} bones=${bonesBuried} total=${totalElapsedTicks}`,
        );
        await Bun.sleep(150);
        const endPlaytime = readPlaytimeTicks(mainName);
        if (!ok) throw Error(`haggis-stage2 failed end checks: fm=${firemakingLevel} prayer=${prayerLevel}`);

        return {
            phases: {
                toFmLineTicks,
                fmBurnTicks,
                toDraynorBankTicks,
                prayerTicks,
                totalElapsedTicks,
                firemakingLevel,
                firemakingXp,
                prayerLevel,
                prayerXp,
                logsLit,
                bonesBuried,
                fmWaitTicks,
                endPlaytime,
            },
        };
    } catch (error) {
        stopFlag = true;
        await closeWithin([main, ...helpers], 3000).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-2 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage2 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const planData = buildStage2Plan();
    const mainName = runBotName('hs2m', 1);
    const { helperNames } = assertSafeStage2Accounts(mainName, planData.helperChunks.length);
    const allBots = [mainName, ...helperNames];
    const botsDir = join(rsSdkRoot(), 'bots');
    const saves = allBots.map(b => playerSavePath(b));
    try {
        const created = await Promise.all(allBots.map(b => createBot(b)));
        for (const { envPath } of created) pointBotAt(envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        for (const p of saves) rmSync(p, { force: true });
        await applyPreset(mainName, {
            position: LUMBRIDGE_KITCHEN,
            skills: { Cooking: 99, Fletching: 99, Hitpoints: 10 },
            varps: { 29: 2, 173: 1 },
            inventory: [...planData.mainInventory],
            bank: [...planData.mainBank],
        });
        for (let k = 0; k < planData.helperChunks.length; k++) {
            const chunk = planData.helperChunks[k]!;
            await applyPreset(helperNames[k]!, {
                position: { x: chunk[0]!.x, z: chunk[0]!.z, level: 0 },
                varps: { 173: 1 },
                inventory: chunk.map(p => ({ id: p.id, count: 1 })),
            });
        }
        const stack = await startIsolatedStack();
        try {
            const { phases } = await runHaggisStage2(mainName);
            console.log(
                `STAGE2 pass fm=${phases.firemakingLevel}(${phases.firemakingXp}xp) prayer=${phases.prayerLevel}(${phases.prayerXp}xp)`
                + ` playtime=${phases.endPlaytime} toFmLine=${phases.toFmLineTicks} fmBurn=${phases.fmBurnTicks}`
                + ` toDraynorBank=${phases.toDraynorBankTicks} prayer=${phases.prayerTicks} logsLit=${phases.logsLit}`
                + ` bones=${phases.bonesBuried} fmWait=${phases.fmWaitTicks} totalSession=${phases.totalElapsedTicks}`,
            );
        } finally {
            await stack.stop();
        }
    } finally {
        for (const b of allBots) rmSync(join(botsDir, b), { recursive: true, force: true });
        for (const p of saves) rmSync(p, { force: true });
    }
}

if (import.meta.main) {
    const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const isolated = process.argv.includes('--isolated') || positional.length === 0;
    if (isolated) {
        await runIsolated();
    } else {
        const { phases } = await runHaggisStage2(positional[0]!);
        console.log(`STAGE2 pass ${JSON.stringify(phases)}`);
    }
    process.exit(0);
}
