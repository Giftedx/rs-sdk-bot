// Haggis Overall Stage-6 isolated/practice rehearsal: Ardougne Zoo -> Ardougne South Bank
// Crafting 1->99 (5-per-tick gem cutting) -> Glory Edgeville -> Varrock West Bank Smithing 1->99.
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { getWorld } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { RESERVED_ACCOUNTS } from '../../packages/core/src/specialist-boards';
import { waitUntil } from '../../packages/core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../packages/core/src/walk';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { FISHING_GLORY_IDS } from '../fishing-specialist';
import { OBJ_GLORY_4, openBot, rubTeleport, settle } from '../gathering-specialist-lib';
import { CRAFTING, SMITHING, ladder, objId, odds } from './floor-bands';
import {
    type Job,
    type Meter,
    band,
    bankItems,
    bankOpen,
    bankProduction,
    clearDialogs,
    countId,
    dialogOpen,
    inv,
    level,
    meter,
    openBank,
    send,
    tick,
    withdrawN,
    xp,
} from './floor-lib';

export const ARDOUGNE_ZOO_START = { x: 2603, z: 3234, level: 0 } as const;
export const ARDOUGNE_SOUTH_BANK_SPOT = { x: 2655, z: 3283, level: 0 } as const;
export const VARROCK_WEST_BANK_SPOT = { x: 3185, z: 3436, level: 0 } as const;
export const OBJ_CHISEL = 1755;
export const OBJ_HAMMER = 2347;

const SMITHING_PRODUCT: Record<string, readonly [number, number]> = {
    'bronze dagger': [1119, 0],
    'bronze sq shield': [1122, 2],
    'bronze warhammer': [1120, 2],
    'bronze platebody': [1121, 3],
    'iron warhammer': [1120, 2],
    'iron platebody': [1121, 3],
    'steel platebody': [1121, 3],
    'mithril platebody': [1121, 3],
    'adamant platebody': [1121, 3],
};

export interface Stage6Phases {
    readonly toArdyBankTicks: number;
    readonly craftingTicks: number;
    readonly craftingLevel: number;
    readonly craftingXp: number;
    readonly toVarrockBankTicks: number;
    readonly smithingTicks: number;
    readonly smithingLevel: number;
    readonly smithingXp: number;
    readonly totalElapsedTicks: number;
}

const RESERVED_SET = new Set(RESERVED_ACCOUNTS.map(name => name.toLowerCase()));

/** Rejects empty or reserved account names before any Stage-6 session opens. */
export function assertSafeStage6Account(accountName: string): string {
    const clean = accountName.trim();
    if (!clean) throw Error('haggis-stage6: main account name required');
    if (RESERVED_SET.has(clean.toLowerCase())) {
        throw Error(`haggis-stage6: refuses reserved account ${clean}`);
    }
    return clean;
}

/** Builds the deterministic Stage-6 preset starting at Ardougne Zoo after Stage 5 (Mining 99). */
export function buildStage6Plan(dragonstoneBuffer = 2) {
    if (!Number.isSafeInteger(dragonstoneBuffer) || dragonstoneBuffer < 0 || dragonstoneBuffer > 20) {
        throw Error(`haggis-stage6: dragonstoneBuffer must be between 0 and 20, got ${dragonstoneBuffer}`);
    }
    return {
        startingPosition: ARDOUGNE_ZOO_START,
        startingSkills: {
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
            Mining: 99,
        },
        mainInventory: [] as { id: number; count: number }[],
        mainBank: [
            { id: OBJ_CHISEL, count: 1 },
            { id: OBJ_HAMMER, count: 1 },
            { id: OBJ_GLORY_4, count: 1 },
            { id: 1625, count: 13 }, // uncut opal (+4 smash buffer)
            { id: 1627, count: 8 },  // uncut jade (+4 smash buffer)
            { id: 1629, count: 8 },  // uncut red topaz (+4 smash buffer)
            { id: 1623, count: 4 },  // uncut sapphire
            { id: 1621, count: 3 },  // uncut emerald
            { id: 1619, count: 6 },  // uncut ruby
            { id: 1617, count: 11 }, // uncut diamond
            { id: 1631, count: 278 + dragonstoneBuffer }, // uncut dragonstone
            { id: 2349, count: 20 },  // bronze bar
            { id: 2351, count: 37 },  // iron bar
            { id: 2353, count: 96 },  // steel bar
            { id: 2359, count: 281 }, // mithril bar
            { id: 2361, count: 345 }, // adamant bar (+4 safety buffer)
        ],
    };
}

async function withdrawSingleItem(main: Session, m: Meter, itemId: number, label: string): Promise<void> {
    if (countId(main, itemId) >= 1) return;
    const item = bankItems(main).find(i => i.id === itemId && i.count > 0);
    if (!item) throw Error(`haggis-stage6: bank missing ${label} (${itemId})`);
    await withdrawN(main, m, item.slot, 1);
    const got = await waitUntil(main, () => countId(main, itemId) >= 1, { timeoutTicks: 10 });
    if (!got) throw Error(`haggis-stage6: withdraw ${label} unobserved`);
}

async function prepareTravelFromArdyBank(main: Session, m: Meter): Promise<void> {
    await clearDialogs(main, m, 'close');
    if (await openBank(main, m) < 0) throw Error('haggis-stage6: Ardougne south bank did not reopen for travel kit');
    const seen = new Set<number>();
    for (const it of inv(main)) {
        if (it.id === OBJ_HAMMER || it.id === OBJ_GLORY_4 || seen.has(it.id)) continue;
        seen.add(it.id);
        await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
    }
    await withdrawSingleItem(main, m, OBJ_GLORY_4, 'Amulet of glory(4)');
    await withdrawSingleItem(main, m, OBJ_HAMMER, 'Hammer');
    await send(main, m, { type: 'closeModal' });
    await waitUntil(
        main,
        () => !bankOpen(main) && countId(main, OBJ_GLORY_4) >= 1 && countId(main, OBJ_HAMMER) >= 1,
        { timeoutTicks: 12 },
    );
}

async function runSmithingTo99(main: Session, m: Meter, isStopped: () => boolean): Promise<void> {
    interface SmithJob { bar: number; bars: number; band: string; xp: number; level: number }
    const jobs: SmithJob[] = [];
    for (const st of ladder(SMITHING)) {
        const [bar, bars] = Object.entries(st.band.inputs)[0]!;
        for (let i = 0; i < st.actions; i++) {
            jobs.push({ bar: objId(bar), bars, band: st.band.name, xp: st.band.xp, level: st.band.from });
        }
    }

    let i = 0;
    while (i < jobs.length && !isStopped()) {
        await clearDialogs(main, m, 'close');
        const tb = main.tick();
        if (await openBank(main, m) < 0) {
            await walkPath(await sessionWalker(main), [{ ...VARROCK_WEST_BANK_SPOT, tol: 1 }], { maxTicks: 25, stop: isStopped });
            if (await openBank(main, m) < 0) {
                throw Error(`haggis-stage6: Varrock west bank did not open at smithing job ${i}`);
            }
        }
        const seen = new Set<number>();
        for (const it of inv(main)) {
            if (it.id === OBJ_HAMMER || seen.has(it.id)) continue;
            seen.add(it.id);
            await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
        }

        let slots = 27;
        let n = 0;
        while (i + n < jobs.length && jobs[i + n]!.band === jobs[i]!.band && jobs[i + n]!.bars <= slots) {
            slots -= jobs[i + n]!.bars;
            n++;
        }
        const need = new Map<number, number>();
        for (const j of jobs.slice(i, i + n)) need.set(j.bar, (need.get(j.bar) ?? 0) + j.bars);
        for (const [id, c] of need) {
            let b = bankItems(main).find(x => x.id === id);
            for (let r = 0; r < 3 && (!b || b.count < c); r++) {
                await tick(main);
                b = bankItems(main).find(x => x.id === id);
            }
            if (!b || b.count < c) {
                throw Error(`haggis-stage6: Varrock bank short of bar ${id}: have ${b?.count ?? 0}, need ${c}`);
            }
            await withdrawN(main, m, b.slot, c);
        }
        await send(main, m, { type: 'closeModal' });
        await waitUntil(
            main,
            () => !bankOpen(main) && [...need].every(([id, c]) => countId(main, id) >= c),
            { timeoutTicks: 30 },
        );
        m.bankTicks += main.tick() - tb;
        m.bankCycles++;

        let k = i;
        while (k < i + n && !isStopped()) {
            let r = 1;
            while (k + r < i + n && jobs[k + r]!.band === jobs[k]!.band) r++;
            const j = jobs[k]!;
            if (level(main, 'Smithing') < j.level) {
                throw Error(`haggis-stage6: Smithing ${level(main, 'Smithing')} < required ${j.level} for ${j.band}`);
            }
            const findAnvil = () => ((main.sdk.getState()?.nearbyLocs ?? []) as any[])
                .filter(l => /^anvil$/i.test(l.name ?? ''))
                .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
            let anvil = findAnvil();
            if (!anvil) {
                await walkPath(await sessionWalker(main), [{ x: 3188, z: 3426, tol: 3 }], { maxTicks: 20, stop: isStopped });
                anvil = findAnvil();
            }
            if (!anvil) throw Error('haggis-stage6: Varrock west anvil not nearby');
            const bar = inv(main).find(x => x.id === j.bar);
            if (!bar) throw Error(`haggis-stage6: missing bar ${j.bar} in inventory`);

            const tw = main.tick();
            await clearDialogs(main, m, 'close');
            const useAct = { type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.x, z: anvil.z, locId: anvil.id };
            await send(main, m, useAct);
            while (!(main.sdk.getState() as any)?.interface?.isOpen && main.tick() - tw < 40 && !isStopped()) {
                await tick(main);
                if (dialogOpen(main)) {
                    await send(main, m, { type: 'closeModal' });
                    await send(main, m, useAct);
                    m.levelTicks++;
                }
            }
            if (!(main.sdk.getState() as any)?.interface?.isOpen) {
                throw Error(`haggis-stage6: smithing interface did not open for ${j.band}`);
            }

            const ts = main.tick();
            const [com, slot] = SMITHING_PRODUCT[j.band]!;
            const op = r === 1 ? 1 : r <= 5 ? 2 : 3;
            const x0 = xp(main, 'Smithing');
            const before = countId(main, j.bar);
            await send(main, m, { type: 'clickComponentWithOption', componentId: com, optionIndex: op, slot });
            const target = before - r * j.bars;
            while (countId(main, j.bar) > target && main.tick() - ts < 80 && !isStopped()) {
                await tick(main);
            }
            const made = (before - countId(main, j.bar)) / j.bars;
            band(m, j.band, xp(main, 'Smithing') - x0, main.tick() - ts, made);
            m.actions += made;
            if (made <= 0) throw Error(`haggis-stage6: nothing smithed for ${j.band}`);
            k += made;
        }
        i += n;
    }
}

/** Runs Stage 6 on an already-staged practice account: Zoo -> Ardougne Crafting 99 -> Varrock Smithing 99. */
export async function runHaggisStage6(
    mainName: string,
    opts: { cap?: number; dragonstoneBuffer?: number } = {},
): Promise<{ phases: Stage6Phases }> {
    const cleanMain = assertSafeStage6Account(mainName);
    buildStage6Plan(opts.dragonstoneBuffer ?? 2);
    const cap = opts.cap ?? 2800;

    let stopFlag = false;
    let settling = false;
    const main = await openBot(cleanMain, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (_s, detail) => { if (!settling) throw Error(`unexpected stage6 end: ${detail}`); },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const cm = meter(main, 'Crafting');

    try {
        await tick(main, 3);
        const world = await getWorld();

        const ardyWalkStart = main.tick();
        const toArdy = await goTo(
            main,
            world,
            ARDOUGNE_SOUTH_BANK_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 80, noJewelry: true },
        );
        if (!toArdy.ok) throw Error(`haggis-stage6: walk to Ardougne south bank failed: ${toArdy.detail ?? toArdy.reason ?? 'unknown'}`);
        const toArdyBankTicks = main.tick() - ardyWalkStart;

        const craftStart = main.tick();
        if (await openBank(main, cm) < 0) throw Error('haggis-stage6: Ardougne south bank did not open');
        await withdrawSingleItem(main, cm, OBJ_CHISEL, 'Chisel');
        await send(main, cm, { type: 'closeModal' });
        await waitUntil(main, () => !bankOpen(main) && countId(main, OBJ_CHISEL) >= 1, { timeoutTicks: 10 });

        const extra: Record<string, number> = { opal: 2, jade: 2, 'red topaz': 2 };
        const craftJobs: Job[] = [];
        for (const st of ladder(CRAFTING, 1, 99, odds)) {
            const gem = objId(Object.keys(st.band.inputs)[0]!);
            for (let i = 0; i < st.actions + (extra[st.band.name] ?? 0); i++) {
                craftJobs.push({ use: gem, on: OBJ_CHISEL, level: st.band.from, band: st.band.name, xp: st.band.xp });
            }
        }
        const craftOk = await bankProduction(main, cm, craftJobs, {
            keep: /^chisel$/i,
            pairSlots: 1,
            perLoad: 27,
            clear: 'close',
            closeWhileProducing: true,
        });
        if (!craftOk) throw Error('haggis-stage6: Crafting gem bankProduction failed');
        if (level(main, 'Crafting') < 99) {
            const topUp: Job[] = Array.from({ length: 2 }, () => ({
                use: 1631,
                on: OBJ_CHISEL,
                level: 55,
                band: 'dragonstone',
                xp: 137.5,
            }));
            await bankProduction(main, cm, topUp, {
                keep: /^chisel$/i,
                pairSlots: 1,
                perLoad: 2,
                clear: 'close',
                closeWhileProducing: true,
            });
        }
        const craftingTicks = main.tick() - craftStart;
        const craftingLevel = level(main, 'Crafting');
        const craftingXp = xp(main, 'Crafting');
        if (craftingLevel < 99) throw Error(`haggis-stage6: Crafting ended below 99 (${craftingLevel})`);

        const travelStart = main.tick();
        await prepareTravelFromArdyBank(main, cm);
        await rubTeleport(
            main,
            FISHING_GLORY_IDS,
            1,
            p => p.level === 0 && p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        const toVarrock = await goTo(
            main,
            world,
            VARROCK_WEST_BANK_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 90, noJewelry: true },
        );
        if (!toVarrock.ok) throw Error(`haggis-stage6: walk to Varrock west bank failed: ${toVarrock.detail ?? toVarrock.reason ?? 'unknown'}`);
        // Stand by the southern booth (3185,3435) so both the bank booths and smithy anvils (3188,3425) stay in range.
        await walkPath(await sessionWalker(main), [{ ...VARROCK_WEST_BANK_SPOT, tol: 1 }], { maxTicks: 25, stop: isStopped });
        const toVarrockBankTicks = main.tick() - travelStart;

        const sm = meter(main, 'Smithing');
        const smithStart = main.tick();
        await runSmithingTo99(main, sm, isStopped);
        const smithingTicks = main.tick() - smithStart;
        const smithingLevel = level(main, 'Smithing');
        const smithingXp = xp(main, 'Smithing');

        const totalElapsedTicks = main.tick() - t0;
        const passed = craftingLevel >= 99
            && craftingXp >= xpForLevel(99)
            && smithingLevel >= 99
            && smithingXp >= xpForLevel(99)
            && totalElapsedTicks <= cap;
        settling = true;
        const ok = await settle(
            [main],
            passed,
            `crafting=${craftingLevel} smithing=${smithingLevel} craftTicks=${craftingTicks} smithTicks=${smithingTicks} total=${totalElapsedTicks}`,
        );
        if (!ok) {
            throw Error(`haggis-stage6 failed end checks: crafting=${craftingLevel} smithing=${smithingLevel} total=${totalElapsedTicks}`);
        }
        return {
            phases: {
                toArdyBankTicks,
                craftingTicks,
                craftingLevel,
                craftingXp,
                toVarrockBankTicks,
                smithingTicks,
                smithingLevel,
                smithingXp,
                totalElapsedTicks,
            },
        };
    } catch (error) {
        stopFlag = true;
        settling = true;
        console.error(`STAGE6_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-6 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(cap?: number): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage6 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStage6Plan();
    const mainName = assertSafeStage6Account(runBotName('hs6m', 1));
    const botsDir = join(rsSdkRoot(), 'bots');
    const save = playerSavePath(mainName);
    try {
        const created = await createBot(mainName);
        pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        rmSync(save, { force: true });
        await applyPreset(mainName, {
            position: plan.startingPosition,
            skills: { ...plan.startingSkills },
            varps: { 29: 2, 31: 100, 159: 12, 173: 1 },
            inventory: [],
            bank: [...plan.mainBank],
        });
        const stack = await startIsolatedStack();
        try {
            const { phases } = await runHaggisStage6(mainName, { cap });
            console.log(
                `STAGE6 pass crafting=${phases.craftingLevel}(${phases.craftingXp}xp) smithing=${phases.smithingLevel}(${phases.smithingXp}xp)`
                + ` toArdy=${phases.toArdyBankTicks} craft=${phases.craftingTicks} toVarrock=${phases.toVarrockBankTicks}`
                + ` smith=${phases.smithingTicks} totalSession=${phases.totalElapsedTicks}`,
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
            const { phases } = await runHaggisStage6(positional[0]!, { cap });
            console.log(`STAGE6 pass ${JSON.stringify(phases)}`);
        }
        process.exit(0);
    } catch (err) {
        console.error(`STAGE6 fail ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
