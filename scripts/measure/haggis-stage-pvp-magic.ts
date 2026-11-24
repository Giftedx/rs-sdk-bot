// Haggis Overall 1-tick PvP relog Magic isolated benchmark at Deserted Keep:
// Measures Magic 44 -> 80 via 1-tick PvP relog casting (Fire Bolt -> Fire Blast -> Fire Wave, or Curse -> Vulnerability -> Enfeeble)
// across 5 Combat-101 1-Def tanks at Deserted Keep (1.125x PvP XP multiplier).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { closeWithin, logoutSession } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { level, tick, xp } from '../../packages/practice/src/floor-lib';
import { openBot, settle } from '../gathering-specialist-lib';

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
        // CB 101 1-Def tanks (Attack 99, Strength 99, Defence 1, Hitpoints 99, Ranged 99, Prayer 52, Magic 99 -> CB ~101)
        for (let i = 0; i < tankNames.length; i++) {
            await makeBot(tankNames[i]!, {
                position: { x: KEEP_SPOT.x + (i % 2 === 0 ? 1 : 0), z: KEEP_SPOT.z, level: 0 },
                skills: { Attack: 99, Strength: 99, Defence: 1, Hitpoints: 99, Ranged: 99, Prayer: 52, Magic: 99 },
                inventory: Array.from({ length: 28 }, () => ({ id: 385, count: 1 })),
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
            const t = await openBot(tn);
            await tick(t, 2);
            tanks.push(t);
        }

        const pt0 = readPlaytimeTicks(mageName);
        let mage = await openBot(mageName);
        await tick(mage, 1);
        const startXp = xp(mage, 'Magic');
        const targetXp = xpForLevel(80);
        const logoutCom = componentId('logout:try_logout');
        let casts = 0;
        let relogs = 0;

        try {
            for (let iter = 0; iter < 400 && (level(mage, 'Magic') < 80 || xp(mage, 'Magic') < targetXp); iter++) {
                // Wait up to 3 ticks if nearbyPlayers hasn't populated yet right after login.
                for (let w = 0; w < 3 && !(mage.sdk.getState()?.nearbyPlayers ?? []).length; w++) {
                    await tick(mage);
                }
                const nearby = mage.sdk.getState()?.nearbyPlayers ?? [];
                const target = nearby.find((p: any) => tankNames.some(tn => tn.toLowerCase() === (p.name ?? '').toLowerCase())) ?? nearby[0];
                if (!target) break;
                const spell = spellForMagicLevel(level(mage, 'Magic'), mode);
                // Cast and queue logout in the same game tick; pvp_magic sets %action_delay (non-p_delay), so logout lands cleanly on the same tick.
                const [castRes] = await Promise.all([
                    mage.direct({ type: 'spellOnPlayer', playerIndex: target.index, spellComponent: spell, reason: 'SDK' }),
                    mage.direct({ type: 'clickComponent', componentId: logoutCom, reason: 'SDK' }),
                ]);
                if (castRes && (castRes as any).success !== false) casts++;
                await tick(mage);
                await closeWithin([mage], 5000).catch(() => logoutSession(mage).catch(() => {}));
                relogs++;
                mage = await openBot(mageName);
                // Heal tanks periodically
                if (iter % 4 === 0) {
                    for (const tk of tanks) {
                        if ((tk.sdk.getSkill('Hitpoints')?.level ?? 99) < 70) {
                            const sh = tk.sdk.getInventory().find(i => i.id === 385);
                            if (sh) void tk.direct({ type: 'useInventoryItem', slot: sh.slot, optionIndex: 1, reason: 'SDK' });
                        }
                    }
                }
            }
            const xpGained = xp(mage, 'Magic') - startXp;
            const endLvl = level(mage, 'Magic');
            await settle([mage], true, `pvp-magic ${mode} done`).catch(() => {});
            const playtimeTicks = Math.max(1, readPlaytimeTicks(mageName) - pt0);
            const xpPerTick = xpGained / playtimeTicks;
            return { playtimeTicks, casts, relogs, xpGained, xpPerTick, endLvl };
        } finally {
            await settle(tanks, true, 'tanks done').catch(() => {});
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
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const stack = await startIsolatedStack();
    try {
        const combat = await runIsolatedMagicRelog('combat');
        const curse = await runIsolatedMagicRelog('curse');
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
