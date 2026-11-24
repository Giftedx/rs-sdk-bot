// Haggis Overall Nature Altar Runecraft tick-transfer benchmark:
// Measures 6x27 pure essence packs crafted at Nature Altar (2399,4840, loc 2486) via burstTradeHost + 4-tick bind delay.
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { closeWithin, finish, openBot } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { tick, xp } from '../../packages/practice/src/floor-lib';
import { configureSpecialistGuardEnv } from '../combat-quest-specialists';
import { burstTradeHost, countItem, findLocBy, ITEM_IDS, waitUntil } from '../fast-skills-lib';

const NATURE_STAND = { x: 2400, z: 4840, level: 0 } as const;
const NATURE_ALTAR_ID = 2486;
const PACKS = 6;

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function craftNatureAltar(spec: Session, deadlineTick: number): Promise<void> {
    while (spec.tick() < deadlineTick) {
        if (countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0) return;
        const st = spec.sdk.getState();
        if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
            await spec.direct({ type: 'closeModal', reason: 'SDK' });
            await tick(spec, 1);
            continue;
        }
        const altar = findLocBy(spec, l => l.id === NATURE_ALTAR_ID || /altar/i.test(l.name));
        if (altar) {
            const sentTick = spec.tick();
            await spec.direct({ type: 'interactLoc', x: altar.x, z: altar.z, locId: altar.id, optionIndex: 1, reason: 'SDK' });
            const crafted = await waitUntil(
                spec,
                () => spec.tick() > sentTick && (countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0 || !!spec.sdk.getState()?.dialog?.isOpen),
                { timeoutTicks: 6 },
            );
            if (crafted && countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0) {
                for (let i = 0; i < 4; i++) {
                    if (spec.sdk.getState()?.dialog?.isOpen) {
                        await spec.direct({ type: 'closeModal', reason: 'SDK' });
                    }
                    await tick(spec, 1);
                }
                return;
            }
        } else {
            await tick(spec, 1);
        }
    }
    throw Error('craftNatureAltar exceeded cap');
}

async function main(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage-rc needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB)`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    configureSpecialistGuardEnv();
    process.env.DEMO_OK = '';

    const crafterName = runBotName('hrc', 1);
    const runnerNames = Array.from({ length: PACKS }, (_, i) => runBotName('hrc', i + 2));
    const allNames = [crafterName, ...runnerNames];
    const botsDir = join(rsSdkRoot(), 'bots');
    const cleanup = () => {
        for (const n of allNames) {
            rmSync(join(botsDir, n), { recursive: true, force: true });
            rmSync(playerSavePath(n), { force: true });
        }
    };
    cleanup();

    const stack = await startIsolatedStack();
    const sessions: Session[] = [];
    try {
        const makeBot = async (name: string, preset: Parameters<typeof applyPreset>[1]) => {
            const created = await createBot(name);
            pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
            await applyPreset(name, { varps: { 29: 2, 31: 100, 159: 12, 173: 1, 281: 1000 }, ...preset });
        };

        await makeBot(crafterName, {
            position: { ...NATURE_STAND },
            skills: { Runecraft: 44 },
            inventory: [{ id: 1462, count: 1 }],
        });
        for (let i = 0; i < runnerNames.length; i++) {
            await makeBot(runnerNames[i]!, {
                position: { x: NATURE_STAND.x + 1, z: NATURE_STAND.z + (i % 2 === 0 ? 0 : -1), level: 0 },
                skills: { Runecraft: 44 },
                inventory: Array.from({ length: 27 }, () => ({ id: ITEM_IDS.blankrune, count: 1 })),
            });
        }

        const crafter = await openBot(crafterName);
        sessions.push(crafter);
        const runners: Session[] = [];
        for (const rn of runnerNames) {
            const r = await openBot(rn);
            sessions.push(r);
            runners.push(r);
        }
        await tick(crafter, 2);

        const t0 = crafter.tick();
        const xp0 = xp(crafter, 'Runecraft');
        const deadline = t0 + 200;

        for (let i = 0; i < runners.length; i++) {
            await burstTradeHost(crafter, runners[i]!, {
                giveIds: [ITEM_IDS.blankrune],
                deadlineTick: deadline,
            });
            await craftNatureAltar(crafter, deadline);
        }

        const ticks = crafter.tick() - t0;
        const xpGained = xp(crafter, 'Runecraft') - xp0;
        const ticksPerPack = ticks / PACKS;
        const xpPerTick = xpGained / Math.max(1, ticks);
        console.log(
            `STAGE_RC nature=${ticks}t(packs=${PACKS},tPerPack=${ticksPerPack.toFixed(2)},xp=${xpGained},xpPerTick=${xpPerTick.toFixed(2)})`,
        );
        await finish(sessions, true, 'haggis-stage-rc done').catch(() => {});
    } finally {
        await closeWithin(sessions, 3000).catch(() => {});
        await stack.stop().catch(() => {});
        cleanup();
    }
}

if (import.meta.main) {
    main().catch(err => {
        console.log(`STAGE_RC fail ${err instanceof Error ? err.stack || err.message : String(err)}`);
        process.exit(1);
    });
}
