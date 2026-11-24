// Haggis Overall fast-cut isolated benchmarks:
// 1) druidBurst: Druidic Ritual (burst: true) at 10 HP + Protect from Melee from Edgeville Bank (Games necklace)
// 2) herb10: Herblore 28 -> 99 via 10-pair 5/tick Edgeville bank cycles
// 3) mageArenaStaff + charge5: Kolodion + pool + statue + guardian ONLY (no 99 Flames casts) -> 5/tick Charge 80 -> 99
// 4) vampire10hp: Vampire Slayer (burst: true) at 10 HP + Attack 1 + Protect from Melee + Fire Wave
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { PROTECT } from '../../packages/core/src/prayer-guard';
import { questFlags } from '../../packages/core/src/quest-status';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { sessionWalker, walkPath } from '../../packages/core/src/walk';
import { xpForLevel } from '../../packages/planner/src/curve';
import { HERBLORE, ladder, objId } from '../../packages/practice/src/floor-bands';
import { bankItems, bankOpen, clearDialogs, countId, inv, level, meter, openBank, send, tick, withdrawN, xp } from '../../packages/practice/src/floor-lib';
import { createBot } from '../../packages/practice/src/bots';
import { rsSdkRoot } from '../../packages/practice/src/paths';
import { applyPreset } from '../../packages/practice/src/presets';
import { runBotName } from '../../packages/practice/src/prove';
import { ISOLATED, pointBotAt, startIsolatedStack } from '../../packages/practice/src/rehearse';
import { playerSavePath } from '../../packages/practice/src/save-library';
import { GAMES_NECKLACE_IDS, GLORY_IDS } from '../fast-skills-lib';
import { OBJ_GLORY_4, OBJ_SHARK, openBot, rubTeleport, settle } from '../gathering-specialist-lib';
import { openQuest } from '../generated/quest-lib';
import { DRUID_ENCH_MEATS, DRUID_RAW_MEATS, EDGEVILLE_BANK_SPOT, OBJ_GAMES_8, OBJ_PRAYER_POTION_4 } from './haggis-stage7';

const MAGE_ARENA_CELLAR_SPOT = { x: 2540, z: 4716, level: 0 };
const VAMPIRE_START_SPOT = { x: 3097, z: 3268, level: 0 };

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for haggis-stage-fast...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolatedAccount<T>(
    prefix: string,
    preset: Parameters<typeof applyPreset>[1],
    fn: (s: Session) => Promise<T>,
): Promise<T> {
    const name = runBotName(prefix, 1);
    const botsDir = join(rsSdkRoot(), 'bots');
    const save = playerSavePath(name);
    rmSync(save, { force: true });
    const created = await createBot(name);
    pointBotAt(created.envPath, ISOLATED.engine, ISOLATED.gateway, 'localhost');
    await applyPreset(name, {
        varps: { 29: 2, 31: 100, 159: 12, 173: 1 },
        ...preset,
    });
    try {
        const s = await openBot(name);
        await tick(s, 3);
        try {
            return await fn(s);
        } finally {
            await settle([s], true, `${prefix} done`).catch(() => {});
        }
    } finally {
        rmSync(join(botsDir, name), { recursive: true, force: true });
        rmSync(save, { force: true });
    }
}

async function setPrayer(s: Session, prayerIdx: number, wantOn: boolean): Promise<void> {
    for (let i = 0; i < 6; i++) {
        if (!!s.sdk.getState()?.prayers?.activePrayers?.[prayerIdx] === wantOn) return;
        await s.direct({ type: 'togglePrayer', prayerIndex: prayerIdx, reason: 'SDK' });
        await tick(s);
    }
    if (!!s.sdk.getState()?.prayers?.activePrayers?.[prayerIdx] !== wantOn) {
        throw Error(`prayer ${prayerIdx} failed to reach ${wantOn}`);
    }
}

async function measureDruidBurst(s: Session): Promise<{ ticks: number; gamesToKaqTicks: number; hpMin: number }> {
    const t0 = s.tick();
    let gamesToKaqTicks = 0;
    const isStopped = () => s.tick() - t0 > 600;
    let hpMin = s.sdk.getState()?.player?.hp ?? 10;
    const offWatch = s.onTick(() => {
        const st = s.sdk.getState();
        const hp = st?.player?.hp;
        if (typeof hp === 'number' && hp > 0 && hp < hpMin) hpMin = hp;
        if ((st?.prayers?.prayerPoints ?? 99) <= 12) {
            const pot = inv(s).find(i => i.id === OBJ_PRAYER_POTION_4);
            if (pot) void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
        }
    });
    try {
        await rubTeleport(s, GAMES_NECKLACE_IDS, /burthorpe/i, p => p.worldZ > 4500, isStopped);
        for (let i = 0; i < 40 && !isStopped(); i++) {
            const p = s.sdk.getState()?.player;
            if (p && p.worldZ < 4000) break;
            if (p?.level === 0) {
                const st0 = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 4622 && l.x <= 2208);
                if (st0) await s.direct({ type: 'interactLoc', x: st0.x, z: st0.z, locId: st0.id, optionIndex: 1, reason: 'SDK' });
                else await s.direct({ type: 'walkTo', x: 2207, z: 4936, running: true, reason: 'SDK' });
            } else {
                const st1 = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 4627);
                if (st1) await s.direct({ type: 'interactLoc', x: st1.x, z: st1.z, locId: st1.id, optionIndex: 1, reason: 'SDK' });
                else await s.direct({ type: 'walkTo', x: 2206, z: 4934, running: true, reason: 'SDK' });
            }
            await tick(s);
        }
        const q = await openQuest({ session: s, burst: true, cap: 500, eatAt: 6, food: [OBJ_SHARK], lumbridgeOk: true, keepAlive: true });
        try {
            q.blockDoor(0, 2901, 3473);
            const inDungeon = () => (q.pos()?.worldZ ?? 0) > 9000;
            const inside = () => inDungeon() && (q.pos()?.worldX ?? 0) >= 2889;
            const doorClosed = () => !!q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889)
                ?.optionsWithIndex?.some((o: any) => /open/i.test(o.text));
            await q.walk('to kaqemeex', [{ x: 2924, z: 3485, tol: 2 }]);
            gamesToKaqTicks = s.tick() - t0;
            await q.talk('kaqemeex 1', /^kaqemeex$/i, [/search of a quest/i, /will try and help/i], () => q.sawText(/speak to my fellow sanfew|go to the village south/i), { x: 2924, z: 3486 });
            await q.walk('to sanfew stairs', [{ x: 2898, z: 3427, tol: 1 }]);
            await q.climb('sanfew stairs up', () => q.locAt(2898, 3428), /climb-up/i, () => q.lvl() === 1);
            await q.talk('sanfew 1', /^sanfew$/i, [/sent to help purify/i, /i'll do that then/i], () => q.sawText(/well thank you very much|ok, i'll do that then/i), { x: 2897, z: 3426 });
            await q.climb('sanfew stairs down', () => q.locAt(2898, 3428), /climb-down/i, () => q.lvl() === 0);
            await q.walk('to dungeon ladder', [{ x: 2885, z: 3398, tol: 1 }]);
            await setPrayer(s, PROTECT.melee, true);
            await q.climb('ladder down', () => q.locAt(2884, 3397), /climb-down/i, inDungeon);
            await q.walk('to prison door', [{ x: 2888, z: 9831, tol: 0 }]);
            for (let i = 0; i < 8 && !inside() && doorClosed() && !isStopped(); i++) {
                await q.guard('prison door');
                const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
                if (d) await q.opLoc(d, q.opIndex(d, /open/i));
                await q.waitUntil(() => inside() || !doorClosed() || q.msgCount(/comes to life/i) > i, 6);
            }
            await q.walk('to cauldron', [{ x: 2892, z: 9831, tol: 1 }]);
            for (let k = 0; k < DRUID_RAW_MEATS.length; k++) {
                await q.step(`dip ${DRUID_RAW_MEATS[k]}`, () => q.useOnLoc(DRUID_RAW_MEATS[k]!, { id: 2142, x: 2893, z: 9831 }), () => q.has(DRUID_ENCH_MEATS[k]!), 6, 5);
            }
            for (let i = 0; i < 6 && inside() && doorClosed() && !isStopped(); i++) {
                await q.guard('door out');
                const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
                if (d) await q.opLoc(d, q.opIndex(d, /open/i));
                await q.waitUntil(() => !inside() || !doorClosed(), 6);
            }
            await q.walk('to ladder up', [{ x: 2884, z: 9798, tol: 1 }]);
            await q.climb('ladder up', () => q.locAt(2884, 9797), /climb-up/i, () => !inDungeon());
            await setPrayer(s, PROTECT.melee, false);
            await q.walk('back to sanfew stairs', [{ x: 2898, z: 3427, tol: 1 }]);
            await q.climb('sanfew stairs up 2', () => q.locAt(2898, 3428), /climb-up/i, () => q.lvl() === 1);
            await q.talk('sanfew 2', /^sanfew$/i, [], () => DRUID_ENCH_MEATS.every(id => !q.has(id)), { x: 2897, z: 3426 });
            await q.climb('sanfew stairs down 2', () => q.locAt(2898, 3428), /climb-down/i, () => q.lvl() === 0);
            await q.walk('back to kaqemeex', [{ x: 2924, z: 3485, tol: 3 }]);
            await q.talk('kaqemeex 2', /^kaqemeex$/i, [], () => xp(s, 'Herblore') >= 6_250, { x: 2924, z: 3486 }, 30, true);
        } finally {
            await q.dispose();
        }
        return { ticks: s.tick() - t0, gamesToKaqTicks, hpMin };
    } finally {
        offWatch();
    }
}

async function measureHerb10(s: Session): Promise<{ ticks: number; bankTicks: number; brewTicks: number; cycles: number; level: number; xp: number }> {
    const t0 = s.tick();
    let bankTicks = 0, brewTicks = 0, cycles = 0;
    const m = meter(s, 'Herblore');
    const steps = ladder(HERBLORE, 28).filter(st => st.band.out).map(st => {
        const [u, sec] = Object.keys(st.band.inputs);
        return { unf: objId(u!), sec: objId(sec!), count: st.actions };
    });
    const jobs: { unf: number; sec: number }[] = [];
    for (const st of steps) for (let i = 0; i < st.count; i++) jobs.push({ unf: st.unf, sec: st.sec });
    let idx = 0;
    while ((level(s, 'Herblore') < 99 || xp(s, 'Herblore') < xpForLevel(99)) && s.tick() - t0 < 600) {
        const tb = s.tick();
        await clearDialogs(s, m, 'close');
        if (await openBank(s, m) < 0) throw Error('herb10: failed to open bank');
        const seen = new Set<number>();
        for (const it of inv(s)) {
            if (seen.has(it.id)) continue;
            seen.add(it.id);
            await send(s, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
        }
        const batch = jobs.slice(idx, idx + 10);
        if (!batch.length) break;
        const need = new Map<number, number>();
        for (const j of batch) {
            need.set(j.unf, (need.get(j.unf) ?? 0) + 1);
            need.set(j.sec, (need.get(j.sec) ?? 0) + 1);
        }
        for (const [id, c] of need) {
            let b = bankItems(s).find(x => x.id === id);
            for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(s); b = bankItems(s).find(x => x.id === id); }
            if (!b || b.count < c) throw Error(`herb10: missing ${id} (need ${c}, have ${b?.count ?? 0})`);
            await withdrawN(s, m, b.slot, c);
        }
        await send(s, m, { type: 'closeModal' });
        await waitUntil(s, () => !bankOpen(s) && [...need].every(([id, c]) => countId(s, id) >= c), { timeoutTicks: 20 });
        bankTicks += s.tick() - tb;
        cycles++;

        const tr0 = s.tick();
        for (let off = 0; off < batch.length; off += 5) {
            const slice = batch.slice(off, off + 5);
            const cur = inv(s);
            const usedU = new Set<number>(), usedS = new Set<number>();
            const sends: Promise<unknown>[] = [];
            for (const pair of slice) {
                const u = cur.find(it => it.id === pair.unf && !usedU.has(it.slot));
                const sec = cur.find(it => it.id === pair.sec && !usedS.has(it.slot));
                if (!u || !sec) break;
                usedU.add(u.slot);
                usedS.add(sec.slot);
                sends.push(s.direct({ type: 'useItemOnItem', sourceSlot: u.slot, targetSlot: sec.slot, reason: 'SDK' }));
            }
            if (sends.length) await Promise.all(sends);
            await tick(s);
        }
        brewTicks += s.tick() - tr0;
        idx += batch.length;
    }
    return { ticks: s.tick() - t0, bankTicks, brewTicks, cycles, level: level(s, 'Herblore'), xp: xp(s, 'Herblore') };
}

async function measureMageArenaAndCharge(s: Session): Promise<{ arenaTicks: number; kolodionXp: number; chargeTicks: number; magicLevel: number; magicXp: number }> {
    const t0 = s.tick();
    const xpStart = xp(s, 'Magic');
    const inCellar = () => (s.sdk.getState()?.player?.worldZ ?? 0) > 4600 && (s.sdk.getState()?.player?.worldX ?? 0) >= 2525;
    const inChamber = () => (s.sdk.getState()?.player?.worldZ ?? 0) > 4600 && (s.sdk.getState()?.player?.worldX ?? 0) < 2525;

    // 1. Talk to Kolodion -> fight 5 forms in arena -> pool -> statue -> cape -> guardian -> staff
    while (s.tick() - t0 < 200 && inCellar()) {
        const d = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) {
                const opt = d.options.find((o: any) => /can i fight|yes|ok, let's fight|ready|sure/i.test(o.text));
                await s.direct({ type: 'clickDialogOption', optionIndex: opt?.index ?? d.options[0]?.index ?? 0, reason: 'SDK' });
            }
        } else {
            const kolo = (s.sdk.getNearbyNpcs() ?? []).find((n: any) => n.id === 905 || /^kolodion$/i.test(n.name));
            if (kolo) await s.direct({ type: 'interactNpc', npcIndex: kolo.index, optionIndex: 1, reason: 'SDK' });
        }
        await tick(s);
    }
    if (inCellar()) throw Error('mageArenaStaff: never teleported to arena');

    const fireWave = componentId('magic:fire_wave');
    let prevXp = xp(s, 'Magic');
    let lastCastTick = -99;
    while (s.tick() - t0 < 600 && !inCellar()) {
        const st = s.sdk.getState();
        if (!st?.prayers?.activePrayers?.[PROTECT.magic] && (st?.prayers?.prayerPoints ?? 0) > 0) {
            await s.direct({ type: 'togglePrayer', prayerIndex: PROTECT.magic, reason: 'SDK' });
        }
        if ((st?.prayers?.prayerPoints ?? 99) <= 14) {
            const pot = inv(s).find(i => [2434, 139, 141, 143].includes(i.id));
            if (pot) await s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
        }
        const nowXp = xp(s, 'Magic');
        if (nowXp > prevXp) { prevXp = nowXp; lastCastTick = s.tick() - 1; }
        if (st?.dialog?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
        const boss = (s.sdk.getNearbyNpcs() ?? []).find((n: any) => [907, 908, 909, 910, 911].includes(n.id) || (/kolodion/i.test(n.name) && n.optionsWithIndex.some((o: any) => /attack/i.test(o.text))));
        if (boss && s.tick() - lastCastTick >= 4) {
            await s.direct({ type: 'spellOnNpc', npcIndex: boss.index, spellComponent: fireWave, reason: 'SDK' });
        }
        await tick(s);
    }
    await setPrayer(s, PROTECT.magic, false);
    const kolodionXp = xp(s, 'Magic') - xpStart;

    while (s.tick() - t0 < 650 && !inChamber()) {
        const d = s.sdk.getDialog();
        const pool = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2878);
        if (d?.isOpen) {
            if (!d.isWaiting) await s.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
        } else if (pool) {
            await s.direct({ type: 'interactLoc', x: pool.x, z: pool.z, locId: pool.id, optionIndex: 1, reason: 'SDK' });
        }
        await tick(s);
    }
    const walker = await sessionWalker(s);
    await walkPath(walker, [{ x: 2516, z: 4718, tol: 2 }], { maxTicks: 30 });
    while (s.tick() - t0 < 720 && countId(s, 2414) === 0) {
        const d = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) await s.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
            await tick(s); continue;
        }
        await s.sdk.scanGroundItems(5);
        const ground = s.sdk.getState()?.groundItems?.find((g: any) => g.id === 2414);
        if (ground) await s.direct({ type: 'pickupItem', x: ground.x, z: ground.z, itemId: 2414, reason: 'SDK' });
        else {
            const statue = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2874);
            if (statue) await s.direct({ type: 'interactLoc', x: statue.x, z: statue.z, locId: statue.id, optionIndex: 1, reason: 'SDK' });
        }
        await tick(s);
    }
    const cape = inv(s).find(i => i.id === 2414);
    if (cape) await s.direct({ type: 'equipItem', slot: cape.slot, reason: 'SDK' });
    await walkPath(walker, [{ x: 2508, z: 4695, tol: 2 }], { maxTicks: 30 });
    while (s.tick() - t0 < 780 && countId(s, 2417) === 0) {
        const d = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) await s.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
        } else {
            const guardian = (s.sdk.getNearbyNpcs() ?? []).find((n: any) => n.id === 904 || /guardian/i.test(n.name));
            if (guardian) await s.direct({ type: 'interactNpc', npcIndex: guardian.index, optionIndex: 1, reason: 'SDK' });
        }
        await tick(s);
    }
    const arenaTicks = s.tick() - t0;

    // 2. Equip Zamorak staff (2417) + spam 5/tick Charge to 99
    const chargeStart = s.tick();
    const staff = inv(s).find(i => i.id === 2417);
    if (staff) { await s.direct({ type: 'equipItem', slot: staff.slot, reason: 'SDK' }); await tick(s); }
    const charge = componentId('magic:charge');
    while (s.tick() - chargeStart < 200 && (level(s, 'Magic') < 99 || xp(s, 'Magic') < xpForLevel(99))) {
        await Promise.all(Array.from({ length: 5 }, () => s.direct({ type: 'clickComponent', componentId: charge, reason: 'SDK' })));
        await tick(s);
    }
    const chargeTicks = s.tick() - chargeStart;
    return { arenaTicks, kolodionXp, chargeTicks, magicLevel: level(s, 'Magic'), magicXp: xp(s, 'Magic') };
}

async function measureVampire10hp(s: Session, spellName: 'magic:fire_wave' | 'magic:fire_bolt' = 'magic:fire_wave'): Promise<{ ticks: number; attackLevel: number; attackXp: number; hpMin: number }> {
    const t0 = s.tick();
    let hpMin = s.sdk.getState()?.player?.hp ?? 10;
    const offHp = s.onTick(() => {
        const hp = s.sdk.getState()?.player?.hp;
        if (typeof hp === 'number' && hp > 0 && hp < hpMin) hpMin = hp;
    });
    const q = await openQuest({ session: s, burst: true, cap: 600, lumbridgeOk: true, keepAlive: true });
    try {
        const state = () => questFlags(q.s.client)?.find(f => f.name === 'Vampire Slayer')?.state ?? 'unknown';
        await q.waitUntil(() => state() !== 'unknown', 20);
        await q.talk('morgan', /^morgan$/i, [/up for an adventure/i], () => state() === 'started', VAMPIRE_START_SPOT);
        await q.teleport('varrock teleport 1', 'magic:varrock_teleport', 3212, 3424);
        await q.walk('to harlow', [{ x: 3277, z: 3492, tol: 3 }]);
        await q.talk('harlow 1', /^dr harlow$/i, [/morgan needs your help/i, /ok mate/i], () => q.sawText(/buy ush a drink anyway/i) || q.has(1549), { x: 3277, z: 3492 });
        if (!q.has(1549)) await q.talk('harlow 2', /^dr harlow$/i, [/ok mate/i], () => q.has(1549), { x: 3277, z: 3492 }, 60);
        await q.waitUntil(() => q.has(1549), 5);
        await q.teleport('varrock teleport 2', 'magic:varrock_teleport', 3212, 3424);
        await q.walk('to manor', [{ x: 3108, z: 3352, tol: 1 }]);
        const inManor = () => (q.pos()?.worldZ ?? 0) >= 3354 && (q.pos()?.worldZ ?? 0) < 9000;
        await q.step('manor door', () => { const d = q.findLoc(l => (l.id === 134 || l.id === 135) && l.z === 3353); return d ? q.opLoc(d, 1) : q.waitTicks(1); }, inManor, 8, 4);
        await q.openDoor('hall door', 3109, 3358);
        await q.dash('north room', 3106, 3367, 0);
        await q.openDoor('corridor door', 3106, 3368);
        await q.dash('corridor', 3114, 3370, 0);
        await q.dash('east room', 3118, 3362, 1);
        await q.dash('to crypt stairs', 3115, 3356, 0);
        await q.climb('crypt stairs', () => q.locAt(3115, 3357) ?? { id: 2616, x: 3115, z: 3357 }, /walk-down|climb-down|go-down/i, () => (q.pos()?.worldZ ?? 0) > 9000);
        await setPrayer(s, PROTECT.melee, true);
        const COFFIN = { id: 2614, x: 3077, z: 9775 };
        await q.step('coffin', () => { const c = q.findLoc(l => l.x === COFFIN.x && l.z === COFFIN.z); return c ? q.opLoc(c, 1) : q.opLoc(COFFIN, 1); }, () => !!q.npc(/^count draynor$/i), 10, 4);
        const spellComp = componentId(spellName);
        for (let t = 0; t < 120 && state() !== 'complete'; t++) {
            await q.guard('count');
            const n = q.npc(/^count draynor$/i);
            if (n && q.has(1549) && t % 5 === 0) await s.direct({ type: 'spellOnNpc', npcIndex: n.index, spellComponent: spellComp, reason: 'SDK' });
            await q.waitTicks(1);
        }
        await setPrayer(s, PROTECT.melee, false);
        if (state() !== 'complete') throw Error(`vampire10hp incomplete: state=${state()}`);
        return { ticks: s.tick() - t0, attackLevel: level(s, 'Attack'), attackXp: xp(s, 'Attack'), hpMin };
    } finally {
        offHp();
        await q.dispose();
    }
}

async function runIsolated(): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage-fast --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB)`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const stack = await startIsolatedStack();
    try {
        // Build Herblore bank items (28 -> 99)
        const herbBank = new Map<number, number>();
        for (const st of ladder(HERBLORE, 28).filter(x => x.band.out)) {
            const [u, sec] = Object.keys(st.band.inputs);
            herbBank.set(objId(u!), (herbBank.get(objId(u!)) ?? 0) + st.actions + 2);
            herbBank.set(objId(sec!), (herbBank.get(objId(sec!)) ?? 0) + st.actions + 2);
        }

        const druid = await runIsolatedAccount('hfdr', {
            position: EDGEVILLE_BANK_SPOT,
            skills: { Hitpoints: 10, Prayer: 43, Magic: 80 },
            inventory: [
                { id: OBJ_GAMES_8, count: 1 },
                { id: OBJ_GLORY_4, count: 1 },
                { id: OBJ_PRAYER_POTION_4, count: 1 },
                { id: OBJ_SHARK, count: 4 },
                ...DRUID_RAW_MEATS.map(id => ({ id, count: 1 })),
            ],
        }, measureDruidBurst);
        console.log(`PHASE druidBurst=${druid.ticks}(walk=${druid.gamesToKaqTicks},hpMin=${druid.hpMin})`);

        const herb = await runIsolatedAccount('hfhb', {
            position: EDGEVILLE_BANK_SPOT,
            skills: { Herblore: 28, Hitpoints: 10, Prayer: 43, Magic: 80 },
            bank: [...herbBank.entries()].map(([id, count]) => ({ id, count })),
        }, measureHerb10);
        console.log(`PHASE herb10=${herb.ticks}(bank=${herb.bankTicks},brew=${herb.brewTicks},cycles=${herb.cycles},lvl=${herb.level})`);

        const mage = await runIsolatedAccount('hfma', {
            position: MAGE_ARENA_CELLAR_SPOT,
            skills: { Hitpoints: 10, Prayer: 43, Magic: 80 },
            inventory: [
                { id: 554, count: 5000 },
                { id: 556, count: 5000 },
                { id: 565, count: 2000 },
                { id: OBJ_PRAYER_POTION_4, count: 3 },
                { id: OBJ_SHARK, count: 4 },
            ],
        }, measureMageArenaAndCharge);
        console.log(`PHASE mageArenaStaff=${mage.arenaTicks}(koloXp=${mage.kolodionXp}) charge5=${mage.chargeTicks}(lvl=${mage.magicLevel},xp=${mage.magicXp})`);

        const vamp = await runIsolatedAccount('hfva', {
            position: VAMPIRE_START_SPOT,
            skills: { Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 43, Magic: 80 },
            inventory: [
                { id: 1917, count: 1 },
                { id: 2347, count: 1 },
                { id: 1550, count: 1 },
                { id: 563, count: 2 },
                { id: 554, count: 100 },
                { id: 556, count: 100 },
                { id: 565, count: 50 },
                { id: OBJ_SHARK, count: 4 },
                { id: OBJ_PRAYER_POTION_4, count: 1 },
            ],
        }, s => measureVampire10hp(s, 'magic:fire_wave'));

        const vampBolt = await runIsolatedAccount('hfvb', {
            position: VAMPIRE_START_SPOT,
            skills: { Attack: 1, Strength: 1, Defence: 1, Hitpoints: 10, Prayer: 43, Magic: 44 },
            inventory: [
                { id: 1917, count: 1 },
                { id: 2347, count: 1 },
                { id: 1550, count: 1 },
                { id: 563, count: 2 },
                { id: 554, count: 100 },
                { id: 556, count: 100 },
                { id: 562, count: 50 },
                { id: OBJ_SHARK, count: 4 },
                { id: OBJ_PRAYER_POTION_4, count: 1 },
            ],
        }, s => measureVampire10hp(s, 'magic:fire_bolt'));

        console.log(
            `STAGE_FAST druidBurst=${druid.ticks}(walk=${druid.gamesToKaqTicks},hpMin=${druid.hpMin})`
            + ` herb10=${herb.ticks}(bank=${herb.bankTicks},brew=${herb.brewTicks},cycles=${herb.cycles},lvl=${herb.level})`
            + ` mageArenaStaff=${mage.arenaTicks}(koloXp=${mage.kolodionXp}) charge5=${mage.chargeTicks}(lvl=${mage.magicLevel},xp=${mage.magicXp})`
            + ` vampireWave=${vamp.ticks}(att=${vamp.attackLevel},attXp=${vamp.attackXp},hpMin=${vamp.hpMin})`
            + ` vampireBolt=${vampBolt.ticks}(att=${vampBolt.attackLevel},attXp=${vampBolt.attackXp},hpMin=${vampBolt.hpMin})`,
        );
    } finally {
        await stack.stop();
    }
}

if (import.meta.main) {
    try {
        await runIsolated();
        process.exit(0);
    } catch (err) {
        console.error(`STAGE_FAST fail ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        process.exit(1);
    }
}
