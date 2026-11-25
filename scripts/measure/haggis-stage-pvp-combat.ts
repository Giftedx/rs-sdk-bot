// Haggis Overall 1-tick PvP relog Combat benchmark at Deserted Keep:
// Measures full ->99 runs with Vampire Slayer Attack 68 unlock, 1-Def high-CB tanks (1.100x/1.125x),
// Ultimate Strength + Incredible Reflexes, Rune 2h sword, and full Ranged tier upgrades.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { closeWithin, logoutSession, openBot } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { waitTicks } from '../../packages/core/src/ticks';
import { xpForLevel } from '../../packages/planner/src/curve';
import { createBot } from '../../packages/practice/src/bots';
import { level, tick, xp } from '../../packages/practice/src/floor-lib';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { configureSpecialistGuardEnv } from '../combat-quest-specialists';
import { selectRangedKit, styleComponentFor, type PvpCombatSkill } from '../pvp-relog-combat';

const KEEP_SPOT = { x: 3153, z: 3923, level: 0 } as const;
const TANK_COUNT = 5;
const TANK_WAVES = 4; // 4 waves x 5 tanks x 28 mantas x 22 HP = 12,320 HP -> full ->99 with 0 tank banking

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

async function equipId(s: Session, itemId: number): Promise<void> {
    const it = s.sdk.getInventory().find(i => i.id === itemId);
    if (!it) return;
    await s.direct({ type: 'equipItem', slot: it.slot, reason: 'SDK' });
}

async function runCombatPhase(skill: PvpCombatSkill): Promise<{
    skill: PvpCombatSkill;
    playtimeTicks: number;
    swings: number;
    xpGained: number;
    xpPerTick: number;
    endLvl: number;
}> {
    const tag = skill.slice(0, 3).toLowerCase();
    const attackerName = runBotName(`hpc${tag}`, 1);
    const waveTankNames = Array.from({ length: TANK_WAVES }, (_, w) =>
        Array.from({ length: TANK_COUNT }, (_, i) => runBotName(`hpc${tag}`, 2 + w * TANK_COUNT + i)),
    );
    const allTankNames = waveTankNames.flat();
    const botsDir = join(rsSdkRoot(), 'bots');
    const allNames = [attackerName, ...allTankNames];
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

    // Strength starts at Att 68, Str 1, HP 10, Pray 43 (CB 30) -> CB 80 tanks (1.100x) are attackable at Wildy 51 (30+51=81).
    // Attack 68->99 (with Str 99, CB 70+), Defence 1->99 (Att/Str 99, CB 90+), Ranged 1->99 (melee 99, CB 110+) hit CB 101 1-Def tanks (1.125x).
    const useCb80 = skill === 'Strength';
    const tankSkills: Record<string, number> = useCb80
        ? { Attack: 99, Strength: 60, Defence: 1, Hitpoints: 99, Prayer: 1, Ranged: 1, Magic: 1 }
        : { Attack: 99, Strength: 99, Defence: 1, Hitpoints: 99, Prayer: 52, Ranged: 99, Magic: 99 };

    const attackerSkills: Record<string, number> = skill === 'Strength'
        ? { Attack: 68, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 43 }
        : skill === 'Attack'
            ? { Attack: 68, Strength: 99, Defence: 1, Hitpoints: 60, Prayer: 43 }
            : skill === 'Defence'
                ? { Attack: 99, Strength: 99, Defence: 1, Hitpoints: 75, Prayer: 43 }
                : { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 43, Ranged: 1 };

    const attackerEquipment = skill === 'Ranged'
        ? [
            { id: 841, count: 1, slot: 3 },   // Shortbow
            { id: 884, count: 5000, slot: 13 }, // Iron arrow
            { id: 1704, count: 1, slot: 2 },   // Glory
            { id: 1167, count: 1, slot: 0 },   // Leather cowl
            { id: 1061, count: 1, slot: 10 },  // Leather boots
            { id: 1063, count: 1, slot: 9 },   // Leather vambs
            { id: 1095, count: 1, slot: 7 },   // Leather chaps
        ]
        : [
            { id: 1319, count: 1, slot: 3 },  // Rune 2h sword
            { id: 1725, count: 1, slot: 2 },  // Amulet of strength
            { id: 3105, count: 1, slot: 10 }, // Climbing boots
        ];

    const attackerInventory = skill === 'Ranged'
        ? [
            { id: 843, count: 1 }, { id: 849, count: 1 }, { id: 853, count: 1 },
            { id: 857, count: 1 }, { id: 861, count: 1 }, { id: 859, count: 1 },
            { id: 886, count: 5000 }, { id: 888, count: 5000 }, { id: 890, count: 5000 }, { id: 892, count: 5000 },
            { id: 1169, count: 1 }, { id: 1065, count: 1 }, { id: 2487, count: 1 },
            { id: 2491, count: 1 }, { id: 1099, count: 1 }, { id: 2497, count: 1 },
            { id: 2499, count: 1 }, { id: 2503, count: 1 },
        ]
        : [];

    try {
        for (const tn of allTankNames) {
            const idx = allTankNames.indexOf(tn);
            await makeBot(tn, {
                position: { x: KEEP_SPOT.x + (idx % 2 === 0 ? 1 : 0), z: KEEP_SPOT.z, level: 0 },
                skills: tankSkills,
                inventory: Array.from({ length: 28 }, () => ({ id: 391, count: 1 })), // Manta rays
            });
        }
        await makeBot(attackerName, {
            position: { ...KEEP_SPOT },
            skills: attackerSkills,
            equipment: attackerEquipment,
            inventory: attackerInventory,
        });

        let waveIdx = 0;
        let tanks: Session[] = [];
        const openWave = async (w: number) => {
            const opened: Session[] = [];
            for (const tn of waveTankNames[w]!) {
                const t = await openBot(tn, { onStop: async () => {}, onSessionEnd: async () => {} });
                await tick(t, 2);
                opened.push(t);
            }
            return opened;
        };
        tanks = await openWave(waveIdx);
        let activeTankNames = waveTankNames[waveIdx]!;

        const pt0 = readPlaytimeTicks(attackerName);
        let intentionalRelog = false;
        const openAttacker = () => openBot(attackerName, {
            onStop: async () => {},
            onSessionEnd: async (_s, detail) => {
                if (!intentionalRelog) throw Error(`unexpected attacker session end: ${detail}`);
            },
        });

        const logoutCom = componentId('logout:try_logout');
        const ultStrCom = componentId('prayer:prayer_ultimatestrength');
        const incRefCom = componentId('prayer:prayer_incrediblereflexes');
        const targetXp = xpForLevel(99);

        let att = await openAttacker();
        await tick(att, 1);
        const startXp = xp(att, skill);
        let swings = 0;
        const styleCom = skill === 'Ranged' ? null : styleComponentFor(skill, 1319);

        try {
            for (let iter = 0; iter < 2200 && (level(att, skill) < 99 || xp(att, skill) < targetXp); iter++) {
                const curLvl = level(att, skill);
                if (skill === 'Ranged') {
                    const invIds = new Set(att.sdk.getInventory().map(i => i.id));
                    const eqIds = new Set((att.sdk.getState()?.equipment ?? []).map((i: any) => i.id));
                    const held = new Set([...invIds, ...eqIds]);
                    const { bow, arrow } = selectRangedKit(curLvl, held);
                    let upgraded = false;
                    if (bow && !eqIds.has(bow.id) && invIds.has(bow.id)) { await equipId(att, bow.id); upgraded = true; }
                    if (arrow && !eqIds.has(arrow.id) && invIds.has(arrow.id)) { await equipId(att, arrow.id); upgraded = true; }
                    for (const [req, id] of [[20, 1169], [40, 1065], [40, 1099], [50, 2487], [50, 2499], [70, 2491], [70, 2497], [70, 2503]] as const) {
                        if (curLvl >= req && !eqIds.has(id) && invIds.has(id)) { await equipId(att, id); upgraded = true; }
                    }
                    if (upgraded) await waitTicks(att, 1);
                }

                for (let w = 0; w < 4 && !(att.sdk.getState()?.nearbyPlayers ?? []).length; w++) {
                    await waitTicks(att, 1);
                }
                const nearby = att.sdk.getState()?.nearbyPlayers ?? [];
                const wantName = activeTankNames[iter % activeTankNames.length]!;
                const target = nearby.find((p: any) => (p.name ?? '').toLowerCase() === wantName.toLowerCase())
                    ?? nearby.find((p: any) => activeTankNames.some(tn => tn.toLowerCase() === (p.name ?? '').toLowerCase()))
                    ?? nearby[0];
                if (!target) break;

                intentionalRelog = true;
                if (skill !== 'Ranged') {
                    void att.direct({ type: 'clickComponent', componentId: ultStrCom, reason: 'SDK' });
                    // Attack has styleCom === null so it fits incRef within USER_EVENT.limit=5; Strength/Defence have 4 total events.
                    if (styleCom === null) {
                        void att.direct({ type: 'clickComponent', componentId: incRefCom, reason: 'SDK' });
                    }
                }
                if (styleCom !== null) {
                    void att.direct({ type: 'clickComponent', componentId: styleCom, reason: 'SDK' });
                }
                void att.direct({ type: 'interactPlayer', playerIndex: target.index, optionIndex: 2, reason: 'SDK' });
                void att.direct({ type: 'clickComponent', componentId: logoutCom, reason: 'SDK' });
                swings++;

                const endReason = await Promise.race([
                    att.ended.then(e => e.reason),
                    waitTicks(att, 3).then(() => 'timeout'),
                ]);
                if (endReason === 'timeout') {
                    await logoutSession(att).catch(() => {});
                } else if (endReason !== 'logged-out' && endReason !== 'disconnected') {
                    throw Error(`unexpected relog end (${skill}): ${endReason}`);
                }
                await closeWithin([att], 5000).catch(() => {});
                intentionalRelog = false;

                let needWaveSwap = false;
                for (const tk of tanks) {
                    const hp = tk.sdk.getSkill('Hitpoints')?.level ?? 99;
                    const food = tk.sdk.getInventory().find(i => i.id === 391);
                    if (hp < 75 && food) {
                        void tk.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
                    }
                    if (tk.sdk.getInventory().filter(i => i.id === 391).length <= 3) needWaveSwap = true;
                }
                if (needWaveSwap && waveIdx + 1 < TANK_WAVES) {
                    await Promise.all(tanks.map(t => logoutSession(t).catch(() => {})));
                    await closeWithin(tanks, 3000).catch(() => {});
                    waveIdx++;
                    tanks = await openWave(waveIdx);
                    activeTankNames = waveTankNames[waveIdx]!;
                }
                att = await openAttacker();
            }

            const xpGained = xp(att, skill) - startXp;
            const endLvl = level(att, skill);
            intentionalRelog = true;
            await Promise.all([att, ...tanks].map(s => logoutSession(s).catch(() => {})));
            await closeWithin([att, ...tanks], 3000).catch(() => {});
            const playtimeTicks = Math.max(1, readPlaytimeTicks(attackerName) - pt0);
            const xpPerTick = xpGained / playtimeTicks;
            return { skill, playtimeTicks, swings, xpGained, xpPerTick, endLvl };
        } finally {
            intentionalRelog = true;
            await closeWithin([att, ...tanks], 3000).catch(() => {});
        }
    } finally {
        cleanup();
    }
}

async function main(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage-pvp-combat needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB)`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    configureSpecialistGuardEnv();
    process.env.DEMO_OK = '';

    const arg = process.argv.slice(2).find(a => !a.startsWith('-')) ?? 'Strength,Attack,Defence,Ranged';
    const wanted = arg.split(',').map(s => s.trim()).filter(Boolean) as PvpCombatSkill[];

    const stack = await startIsolatedStack();
    try {
        const parts: string[] = [];
        for (const sk of wanted) {
            const res = await runCombatPhase(sk);
            const seg = `${res.skill.toLowerCase()}=${res.playtimeTicks}t(swings=${res.swings},xp=${res.xpGained},rate=${res.xpPerTick.toFixed(1)},lvl=${res.endLvl})`;
            console.log(`PHASE pvp-combat ${seg}`);
            parts.push(seg);
        }
        console.log(`STAGE_PVP_COMBAT ${parts.join(' ')}`);
    } finally {
        await stack.stop().catch(() => {});
    }
}

if (import.meta.main) {
    main().catch(err => {
        console.log(`STAGE_PVP_COMBAT fail ${err instanceof Error ? err.stack || err.message : String(err)}`);
        process.exit(1);
    });
}
