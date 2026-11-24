// Haggis Overall 1-tick PvP relog Magic isolated benchmark at Deserted Keep:
// Measures Magic 44 -> 80 via 1-tick PvP relog casting (Fire Bolt -> Fire Blast -> Fire Wave, or Curse -> Vulnerability -> Enfeeble)
// across 5 Combat-101 1-Def tanks at Deserted Keep (1.125x PvP XP multiplier).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { closeWithin, finish, logoutSession, openBot } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { waitTicks } from '../../packages/core/src/ticks';
import { xpForLevel } from '../../packages/planner/src/curve';
import { configureSpecialistGuardEnv } from '../combat-quest-specialists';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { level, tick, xp } from '../../packages/practice/src/floor-lib';

const KEEP_SPOT = { x: 3153, z: 3923, level: 0 } as const;
const TANK_COUNT = 5;

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

function readPlaytimeTicks(account: string): number {
    try {
        return readFileSync(playerSavePath(account)).readInt32BE(24);
    } catch {
        return 0;
    }
}

function spellForMagicLevel(lvl: number, mode: 'combat' | 'curse'): number {
    if (mode === 'curse') {
        if (lvl >= 73) return componentId('magic:enfeeble');
        if (lvl >= 66) return componentId('magic:vulnerability');
        return componentId('magic:curse');
    }
    if (lvl >= 75) return componentId('magic:fire_wave');
    if (lvl >= 59) return componentId('magic:fire_blast');
    return componentId('magic:fire_bolt');
}

async function runIsolatedMagicRelog(mode: 'combat' | 'curse'): Promise<{ playtimeTicks: number; casts: number; relogs: number; xpGained: number; xpPerTick: number; endLvl: number }> {
    const prefix = mode === 'curse' ? 'hpmcu' : 'hpmcb';
    const mageName = runBotName(prefix, 1);
    const tankNames = Array.from({ length: TANK_COUNT }, (_, i) => runBotName(prefix, i + 2));
    const botsDir = join(rsSdkRoot(), 'bots');
    const allNames = [mageName, ...tankNames];

    const cleanup = () => {
        for (const n of allNames) {
            rmSync(join(botsDir, n), { recursive: true, force: true });
            rmSync(playerSavePath(n), { force: true });
        }
    };
    cleanup();

    const makeBot = async (name: string, preset: Parameters<typeof applyPreset>[1]) => {
        const created = await createBot(name);
        pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
        await applyPreset(name, { varps: { 29: 2, 31: 100, 159: 12, 173: 1 }, ...preset });
    };

    try {
        // CB 66 tanks (Attack 40, Strength 40, Defence 1, Hitpoints 99, Prayer 1, Magic 1, Ranged 70 -> within +/-51 wildy of CB 22 mage)
        for (let i = 0; i < tankNames.length; i++) {
            await makeBot(tankNames[i]!, {
                position: { x: KEEP_SPOT.x + (i % 2 === 0 ? 1 : 0), z: KEEP_SPOT.z, level: 0 },
                skills: { Attack: 40, Strength: 40, Defence: 1, Hitpoints: 99, Prayer: 1, Ranged: 70, Magic: 1 },
                inventory: [
                    { id: 3024, count: 1 }, { id: 3024, count: 1 }, { id: 3024, count: 1 }, { id: 3024, count: 1 },
                    ...Array.from({ length: 24 }, () => ({ id: 385, count: 1 })),
                ],
            });
        }
        await makeBot(mageName, {
            position: { ...KEEP_SPOT },
            skills: { Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 43, Magic: 44 },
            inventory: [
                { id: 554, count: 5000 }, // Fire
                { id: 556, count: 5000 }, // Air
                { id: 555, count: 5000 }, // Water
                { id: 557, count: 5000 }, // Earth
                { id: 559, count: 5000 }, // Body
                { id: 562, count: 5000 }, // Chaos
                { id: 560, count: 5000 }, // Death
                { id: 565, count: 5000 }, // Blood
                { id: 566, count: 5000 }, // Soul
            ],
        });

        const tanks: Session[] = [];
        for (const tn of tankNames) {
            const t = await openBot(tn, { onSessionEnd: async () => {} });
            await tick(t, 2);
            tanks.push(t);
        }

        const pt0 = readPlaytimeTicks(mageName);
        let intentionalRelog = false;
        const openMage = () => openBot(mageName, {
            onSessionEnd: async (_s, detail) => {
                if (!intentionalRelog) throw Error(`unexpected mage session end: ${detail}`);
            },
        });

        let mage = await openMage();
        await tick(mage, 1);
        const startXp = xp(mage, 'Magic');
        const targetXp = xpForLevel(80);
        const logoutCom = componentId('logout:try_logout');
        let casts = 0;
        let relogs = 0;

        try {
            for (let iter = 0; iter < 350 && (level(mage, 'Magic') < 80 || xp(mage, 'Magic') < targetXp); iter++) {
                for (let w = 0; w < 4 && !(mage.sdk.getState()?.nearbyPlayers ?? []).length; w++) {
                    await waitTicks(mage, 1);
                }
                const nearby = mage.sdk.getState()?.nearbyPlayers ?? [];
                const wantName = tankNames[iter % tankNames.length]!;
                const target = nearby.find((p: any) => (p.name ?? '').toLowerCase() === wantName.toLowerCase())
                    ?? nearby.find((p: any) => tankNames.some(tn => tn.toLowerCase() === (p.name ?? '').toLowerCase()))
                    ?? nearby[0];
                if (!target) break;
                const spell = spellForMagicLevel(level(mage, 'Magic'), mode);
                const preXp = xp(mage, 'Magic');
                intentionalRelog = true;
                void mage.direct({ type: 'spellOnPlayer', playerIndex: target.index, spellComponent: spell, reason: 'SDK' });
                void mage.direct({ type: 'clickComponent', componentId: logoutCom, reason: 'SDK' });
                casts++;
                const endReason = await Promise.race([
                    mage.ended.then(e => e.reason),
                    waitTicks(mage, 3).then(() => 'timeout'),
                ]);
                if (endReason === 'timeout') {
                    await logoutSession(mage).catch(() => {});
                } else if (endReason !== 'logged-out' && endReason !== 'disconnected') {
                    throw Error(`unexpected mage relog end: ${endReason}`);
                }
                const postXp = xp(mage, 'Magic');
                if (iter < 5) {
                    console.log(`DBG_PVP_MAGIC mode=${mode} iter=${iter} end=${endReason} xp=${preXp}->${postXp} casts=${casts}`);
                }
                await closeWithin([mage], 5000).catch(() => {});
                intentionalRelog = false;
                relogs++;
                // Refresh tank HP and drained stats between relogs
                for (const tk of tanks) {
                    if ((tk.sdk.getSkill('Hitpoints')?.level ?? 99) < 70) {
                        const sh = tk.sdk.getInventory().find(i => i.id === 385);
                        if (sh) void tk.direct({ type: 'useInventoryItem', slot: sh.slot, optionIndex: 1, reason: 'SDK' });
                    }
                    if (mode === 'curse' && ((tk.sdk.getSkill('Defence')?.level ?? 1) < (tk.sdk.getSkill('Defence')?.baseLevel ?? 1)
                        || (tk.sdk.getSkill('Attack')?.level ?? 40) < (tk.sdk.getSkill('Attack')?.baseLevel ?? 40)
                        || (tk.sdk.getSkill('Strength')?.level ?? 40) < (tk.sdk.getSkill('Strength')?.baseLevel ?? 40))) {
                        const sr = tk.sdk.getInventory().find(i => [3024, 3026, 3028, 3030].includes(i.id));
                        if (sr) void tk.direct({ type: 'useInventoryItem', slot: sr.slot, optionIndex: 1, reason: 'SDK' });
                    }
                }
                mage = await openMage();
            }
            const xpGained = xp(mage, 'Magic') - startXp;
            const endLvl = level(mage, 'Magic');
            intentionalRelog = true;
            await finish([mage, ...tanks], true, `pvp-magic ${mode} done`).catch(() => {});
            const playtimeTicks = Math.max(1, readPlaytimeTicks(mageName) - pt0);
            const xpPerTick = xpGained / playtimeTicks;
            return { playtimeTicks, casts, relogs, xpGained, xpPerTick, endLvl };
        } finally {
            intentionalRelog = true;
            await closeWithin([mage, ...tanks], 3000).catch(() => {});
        }
    } finally {
        cleanup();
    }
}

async function main(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage-pvp-magic needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB)`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    configureSpecialistGuardEnv();
    process.env.DEMO_OK = '';

    const stack = await startIsolatedStack();
    try {
        const combat = await runIsolatedMagicRelog('combat');
        console.log(`PHASE pvp-magic combat=${combat.playtimeTicks}t(casts=${combat.casts},relogs=${combat.relogs},xp=${combat.xpGained},rate=${combat.xpPerTick.toFixed(1)},lvl=${combat.endLvl})`);
        const curse = await runIsolatedMagicRelog('curse');
        console.log(`PHASE pvp-magic curse=${curse.playtimeTicks}t(casts=${curse.casts},relogs=${curse.relogs},xp=${curse.xpGained},rate=${curse.xpPerTick.toFixed(1)},lvl=${curse.endLvl})`);
        console.log(
            `STAGE_PVP_MAGIC`
            + ` combat44_80=${combat.playtimeTicks}t(casts=${combat.casts},relogs=${combat.relogs},xp=${combat.xpGained},rate=${combat.xpPerTick.toFixed(1)},lvl=${combat.endLvl})`
            + ` curse44_80=${curse.playtimeTicks}t(casts=${curse.casts},relogs=${curse.relogs},xp=${curse.xpGained},rate=${curse.xpPerTick.toFixed(1)},lvl=${curse.endLvl})`,
        );
    } finally {
        await stack.stop();
    }
}

if (import.meta.main) {
    try {
        await main();
        process.exit(0);
    } catch (err) {
        console.error(`STAGE_PVP_MAGIC fail ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exit(1);
    }
}
