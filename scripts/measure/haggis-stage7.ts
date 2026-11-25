// Haggis Overall Stage-7 isolated/practice rehearsal: Varrock West Bank (post-Stage-6) -> Glory Draynor
// -> Imp Catcher (Magic 1->44, Combat 8->29) -> Glory Edgeville -> Magic 44->99 (Enchant)
// -> Games Necklace Burthorpe -> Druidic Ritual at 10 HP under Protect from Melee -> Herblore 28->99.
import { existsSync, rmSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { getWorld } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { componentId } from '../../packages/core/src/logout';
import { PRACTICE_STARTUP_GB } from '../../packages/core/src/memory';
import { PROTECT } from '../../packages/core/src/prayer-guard';
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
import { GAMES_NECKLACE_IDS, GLORY_IDS } from '../fast-skills-lib';
import { OBJ_GLORY_4, OBJ_SHARK, openBot, rubTeleport, settle } from '../gathering-specialist-lib';
import { openQuest } from '../generated/quest-lib';
import { HERBLORE, MAGIC, ladder, objId } from '../../packages/practice/src/floor-bands';
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
} from '../../packages/practice/src/floor-lib';
import { VARROCK_WEST_BANK_SPOT } from './haggis-stage6';

export const STAGE7_START_SPOT = VARROCK_WEST_BANK_SPOT;
export const EDGEVILLE_BANK_SPOT = { x: 3094, z: 3491, level: 0 } as const;
export const OBJ_GAMES_8 = 3853;
export const OBJ_PRAYER_POTION_4 = 2434;
export const IMP_BEAD_IDS = [1470, 1472, 1474, 1476] as const;
export const DRUID_RAW_MEATS = [2132, 2134, 2136, 2138] as const;
export const DRUID_ENCH_MEATS = [522, 523, 524, 525] as const;

const ENCHANT_SPELLS: Record<string, string> = {
    'enchant 1 sapphire ring': 'magic:enchant_lvl1',
    'enchant 2 emerald ring': 'magic:enchant_lvl2',
    'enchant 3 ruby ring': 'magic:enchant_lvl3',
    'enchant 4 diamond ring': 'magic:enchant_lvl4',
    'enchant 5 dragonstone amulet': 'magic:enchant_lvl5',
};

const MAGIC_RUNE_STACKS: ReadonlyArray<{ id: number; count: number; name: string }> = [
    { id: 564, count: 600, name: 'Cosmic rune' },
    { id: 556, count: 120, name: 'Air rune' },
    { id: 554, count: 120, name: 'Fire rune' },
    { id: 557, count: 7400, name: 'Earth rune' },
    { id: 555, count: 7000, name: 'Water rune' },
];

const RESERVED_SET = new Set(RESERVED_ACCOUNTS.map(name => name.toLowerCase()));

export interface Stage7Phases {
    readonly impCatcherTicks: number;
    readonly magicAfterImp: number;
    readonly magicTicks: number;
    readonly magicLevel: number;
    readonly magicXp: number;
    readonly druidicTicks: number;
    readonly druidicHpMin: number;
    readonly herbloreAfterDruidic: number;
    readonly herbloreTicks: number;
    readonly herbloreLevel: number;
    readonly herbloreXp: number;
    readonly totalElapsedTicks: number;
}

/** Rejects empty or reserved account names before any Stage-7 session opens. */
export function assertSafeStage7Account(accountName: string): string {
    const clean = accountName.trim();
    if (!clean) throw Error('haggis-stage7: main account name required');
    if (RESERVED_SET.has(clean.toLowerCase())) {
        throw Error(`haggis-stage7: refuses reserved account ${clean}`);
    }
    return clean;
}

/** Builds deterministic Stage-7 supplies continuing from Varrock West Bank after Stage 6. */
export function buildStage7Plan(magicBuffer = 4, herbBuffer = 2) {
    if (!Number.isSafeInteger(magicBuffer) || magicBuffer < 0 || magicBuffer > 20) {
        throw Error(`haggis-stage7: magicBuffer must be between 0 and 20, got ${magicBuffer}`);
    }
    if (!Number.isSafeInteger(herbBuffer) || herbBuffer < 0 || herbBuffer > 20) {
        throw Error(`haggis-stage7: herbBuffer must be between 0 and 20, got ${herbBuffer}`);
    }

    const bank = new Map<number, number>();
    const add = (id: number, count: number) => bank.set(id, (bank.get(id) ?? 0) + count);

    add(OBJ_GLORY_4, 2);
    add(OBJ_GAMES_8, 1);
    add(OBJ_PRAYER_POTION_4, 1);
    add(OBJ_SHARK, 5);
    for (const id of IMP_BEAD_IDS) add(id, 1);
    for (const id of DRUID_RAW_MEATS) add(id, 1);
    for (const r of MAGIC_RUNE_STACKS) add(r.id, r.count);

    // Enchant 44 -> 99 jewellery (from MAGIC ladder + small spares per band).
    const magicSpares: Record<number, number> = { 1639: 2, 1641: 2, 1643: 2, 1702: magicBuffer };
    for (const st of ladder(MAGIC, 44)) {
        const id = objId(Object.keys(st.band.inputs)[0]!);
        add(id, st.actions + (magicSpares[id] ?? 0));
    }

    // Herblore 28 -> 99 finished potions from Druidic Ritual XP (6,250), +1 stack guard each.
    const herbUnique = new Set<number>();
    for (const st of ladder(HERBLORE, 28).filter(x => x.band.out)) {
        const [unf, sec] = Object.keys(st.band.inputs);
        const uId = objId(unf!);
        const sId = objId(sec!);
        add(uId, st.actions);
        add(sId, st.actions);
        herbUnique.add(uId);
        herbUnique.add(sId);
    }
    for (const id of herbUnique) add(id, 1);
    add(111, herbBuffer); // torstolvial safety
    add(247, herbBuffer); // jangerberries safety

    return {
        startingPosition: STAGE7_START_SPOT,
        startingSkills: {
            Cooking: 99,
            Fletching: 99,
            Firemaking: 99,
            Prayer: 43,
            Hitpoints: 10,
            Thieving: 99,
            Fishing: 99,
            Mining: 99,
            Crafting: 99,
            Smithing: 99,
        },
        mainInventory: [] as { id: number; count: number }[],
        mainBank: [...bank.entries()].map(([id, count]) => ({ id, count })),
    };
}

async function rubGloryDest(
    main: Session,
    destRe: RegExp,
    inDest: (p: { worldX: number; worldZ: number; level: number }) => boolean,
    isStopped: () => boolean,
): Promise<void> {
    for (let i = 0; i < 40 && !isStopped(); i++) {
        const st = main.sdk.getState();
        if (st?.player && inDest(st.player)) return;
        const dlg = main.sdk.getDialog();
        const opt = dlg?.isOpen && !dlg.isWaiting ? dlg.options.find(o => destRe.test(o.text)) : undefined;
        if (opt) {
            await main.direct({ type: 'clickDialogOption', optionIndex: opt.index, reason: 'SDK' });
        } else {
            const glory = inv(main).find(it => (GLORY_IDS as readonly number[]).includes(it.id));
            if (!glory) throw Error('haggis-stage7: Amulet of glory missing for teleport');
            // Avoid pairing closeModal with rub; OpHeldHandler clears/closes any quest completion modal itself.
            await main.direct({ type: 'useInventoryItem', slot: glory.slot, optionIndex: 4, reason: 'SDK' });
        }
        await tick(main);
    }
    throw Error(`haggis-stage7: Glory teleport matching ${destRe.source} failed`);
}

async function bankAndWithdrawKit(
    main: Session,
    m: Meter,
    keep: ReadonlySet<number>,
    reqs: ReadonlyArray<{ id: number; count: number; label: string; all?: boolean }>,
    spot: { x: number; z: number },
    isStopped: () => boolean,
): Promise<void> {
    await clearDialogs(main, m, 'close');
    if (await openBank(main, m) < 0) {
        await walkPath(await sessionWalker(main), [{ ...spot, tol: 1 }], { maxTicks: 25, stop: isStopped });
        if (await openBank(main, m) < 0) throw Error(`haggis-stage7: bank did not open near (${spot.x},${spot.z})`);
    }
    const seen = new Set<number>();
    for (const it of inv(main)) {
        if (keep.has(it.id) || seen.has(it.id)) continue;
        seen.add(it.id);
        await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
    }
    for (const req of reqs) {
        const have = countId(main, req.id);
        if (have >= req.count) continue;
        let b = bankItems(main).find(x => x.id === req.id && x.count >= req.count - have);
        for (let r = 0; r < 3 && !b; r++) {
            await tick(main);
            b = bankItems(main).find(x => x.id === req.id && x.count >= req.count - have);
        }
        if (!b) throw Error(`haggis-stage7: bank short of ${req.label} (${req.id}), need ${req.count}`);
        if (req.all && have === 0) {
            await send(main, m, { type: 'bankWithdraw', slot: b.slot, amount: -1 });
        } else {
            await withdrawN(main, m, b.slot, req.count - have);
        }
    }
    await send(main, m, { type: 'closeModal' });
    const ok = await waitUntil(
        main,
        () => !bankOpen(main) && reqs.every(r => countId(main, r.id) >= r.count),
        { timeoutTicks: 25 },
    );
    if (!ok) throw Error('haggis-stage7: bank kit withdraw timed out');
}

async function depositAllInventory(main: Session, m: Meter, spot: { x: number; z: number }, isStopped: () => boolean): Promise<void> {
    await bankAndWithdrawKit(main, m, new Set(), [], spot, isStopped);
}

async function runImpCatcher(main: Session, capTicks: number): Promise<void> {
    const q = await openQuest({ session: main, burst: true, cap: capTicks, eatAt: 6, food: [OBJ_SHARK], lumbridgeOk: true });
    let done = false;
    const off = q.s.onTick(() => {
        if (q.msgCount(/quest complete|completed.*imp catcher/i) > 0) done = true;
    });
    try {
        // Stay west of the Draynor jail guard (3109,3237) and east of dark wizards (3085,3238) at combat 8.
        await q.walk('safe tower corridor', [
            { x: 3098, z: 3246, tol: 2 },
            { x: 3096, z: 3230, tol: 1 },
            { x: 3097, z: 3212, tol: 1 },
            { x: 3109, z: 3167, tol: 1 },
        ]);
        await q.openDoor('tower door', 3109, 3166);
        await q.walk('tower ground stairs', [{ x: 3104, z: 3161, tol: 1 }]);
        await q.climb(
            'stairs 0->1',
            () => q.findLoc((l: any) => (l.id === 1738 || /staircase/i.test(l.name)) && l.x === 3103 && l.z === 3159),
            /^climb-up$/i,
            () => q.lvl() === 1,
        );
        await q.climb(
            'stairs 1->2',
            () => q.findLoc((l: any) => (l.id === 1739 || /staircase/i.test(l.name)) && l.x === 3103 && l.z === 3159),
            /^climb-up$/i,
            () => q.lvl() === 2,
        );
        const miz = /^wizard mizgog$/i;
        const spot = { x: 3103, z: 3163 };
        await q.talk('mizgog 1', miz, [/^give me a quest!$/i, /give me a quest please/i], () => q.sawText(/get my beads back/i), spot);
        await q.talk('mizgog 2', miz, [], () => done || xp(main, 'Magic') >= 21_875, spot, 40, true);
        await q.converse([], () => !q.dialogOpen(), 10);
    } finally {
        off();
        await q.dispose();
    }
    if (xp(main, 'Magic') < 21_875 || level(main, 'Magic') < 44) {
        throw Error(`haggis-stage7: Imp Catcher ended with Magic ${level(main, 'Magic')} (${xp(main, 'Magic')} xp)`);
    }
}

async function runEnchantTo99(main: Session, m: Meter, isStopped: () => boolean): Promise<void> {
    interface EnchantJob { item: number; spell: number; band: string; xp: number }
    const jobs: EnchantJob[] = [];
    for (const st of ladder(MAGIC, Math.max(7, level(main, 'Magic')))) {
        const item = objId(Object.keys(st.band.inputs)[0]!);
        jobs.push(...Array.from({ length: st.actions }, () => ({
            item,
            spell: componentId(ENCHANT_SPELLS[st.band.name]!),
            band: st.band.name,
            xp: st.band.xp,
        })));
    }
    // Two spare dragonstone amulets in case starting XP sits near a boundary.
    for (let s = 0; s < 2; s++) {
        jobs.push({ item: 1702, spell: componentId(ENCHANT_SPELLS['enchant 5 dragonstone amulet']!), band: 'enchant 5 dragonstone amulet', xp: 78 });
    }
    const runeIds = new Set(MAGIC_RUNE_STACKS.map(r => r.id));

    let i = 0;
    while (i < jobs.length && (level(main, 'Magic') < 99 || xp(main, 'Magic') < xpForLevel(99)) && !isStopped()) {
        await clearDialogs(main, m, 'close');
        const tb = main.tick();
        if (await openBank(main, m) < 0) throw Error('haggis-stage7: Edgeville bank did not open during Magic');
        const seen = new Set<number>();
        for (const it of inv(main)) {
            if (runeIds.has(it.id) || seen.has(it.id)) continue;
            seen.add(it.id);
            await send(main, m, { type: 'bankDeposit', slot: it.slot, amount: -1 });
        }
        const free = 28 - inv(main).filter(x => runeIds.has(x.id)).length;
        const n = Math.min(free, jobs.length - i);
        const need = new Map<number, number>();
        for (const j of jobs.slice(i, i + n)) need.set(j.item, (need.get(j.item) ?? 0) + 1);
        for (const [id, c] of need) {
            let b = bankItems(main).find(x => x.id === id);
            for (let r = 0; r < 3 && (!b || b.count < c); r++) {
                await tick(main);
                b = bankItems(main).find(x => x.id === id);
            }
            if (!b || b.count < c) throw Error(`haggis-stage7: Edgeville bank short of item ${id}: have ${b?.count ?? 0}, need ${c}`);
            if (need.size === 1 && c === free && b.count > c) {
                await send(main, m, { type: 'bankWithdraw', slot: b.slot, amount: -1 });
            } else {
                await withdrawN(main, m, b.slot, c);
            }
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
        let stall = 0;
        while (k < i + n && stall < 12 && (level(main, 'Magic') < 99 || xp(main, 'Magic') < xpForLevel(99)) && !isStopped()) {
            const j = jobs[k]!;
            const target = inv(main).find(x => x.id === j.item);
            if (!target) break;
            const x0 = xp(main, 'Magic');
            if (dialogOpen(main)) await send(main, m, { type: 'closeModal' });
            await send(main, m, { type: 'spellOnItem', slot: target.slot, spellComponent: j.spell });
            await tick(main);
            const g = xp(main, 'Magic') - x0;
            if (g > 0) {
                const landed = Math.max(1, Math.round(g / (j.xp * 25)));
                for (let q = 0; q < landed && k < i + n; q++, k++) {
                    band(m, jobs[k]!.band, jobs[k]!.xp * 25, 0, 1);
                }
                m.actions += landed;
                stall = 0;
            } else {
                stall++;
            }
        }
        if (k === i) throw Error(`haggis-stage7: enchant stalled at job ${i} (${jobs[i]!.band})`);
        i = k;
    }
}

async function setProtectMelee(main: Session, wantOn: boolean, isStopped: () => boolean): Promise<void> {
    for (let i = 0; i < 6 && !isStopped(); i++) {
        const active = !!main.sdk.getState()?.prayers?.activePrayers?.[PROTECT.melee];
        if (active === wantOn) return;
        await main.direct({ type: 'togglePrayer', prayerIndex: PROTECT.melee, reason: 'SDK' });
        await tick(main);
    }
    const finalOn = !!main.sdk.getState()?.prayers?.activePrayers?.[PROTECT.melee];
    if (finalOn !== wantOn) throw Error(`haggis-stage7: Protect from Melee failed to reach ${wantOn}`);
}

async function runDruidicRitualLowCombat(
    main: Session,
    m: Meter,
    capTicks: number,
    isStopped: () => boolean,
): Promise<{ hpMin: number }> {
    let hpMin = main.sdk.getState()?.player?.hp ?? 10;
    const offWatch = main.onTick(() => {
        const st = main.sdk.getState();
        const hp = st?.player?.hp;
        if (typeof hp === 'number' && hp > 0 && hp < hpMin) hpMin = hp;
        const pts = st?.prayers?.prayerPoints;
        if (typeof pts === 'number' && pts <= 12) {
            const pot = inv(main).find(i => i.id === OBJ_PRAYER_POTION_4);
            if (pot) void main.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
        }
    });

    try {
        await rubTeleport(
            main,
            GAMES_NECKLACE_IDS,
            /burthorpe/i,
            p => p.worldZ > 4500,
            isStopped,
        );
        for (let i = 0; i < 40 && !isStopped(); i++) {
            const p = main.sdk.getState()?.player;
            if (p && p.worldZ < 4000) break;
            if (p?.level === 0) {
                const st0 = (main.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 4622 && l.x <= 2208);
                if (st0) await main.direct({ type: 'interactLoc', x: st0.x, z: st0.z, locId: st0.id, optionIndex: 1, reason: 'SDK' });
                else await main.direct({ type: 'walkTo', x: 2207, z: 4936, running: true, reason: 'SDK' });
            } else {
                const st1 = (main.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 4627);
                if (st1) await main.direct({ type: 'interactLoc', x: st1.x, z: st1.z, locId: st1.id, optionIndex: 1, reason: 'SDK' });
                else await main.direct({ type: 'walkTo', x: 2206, z: 4934, running: true, reason: 'SDK' });
            }
            await tick(main);
        }

        const q = await openQuest({ session: main, burst: true, cap: capTicks, eatAt: 6, food: [OBJ_SHARK], lumbridgeOk: true });
        try {
            q.blockDoor(0, 2901, 3473);
            const inDungeon = () => (q.pos()?.worldZ ?? 0) > 9000;
            const inside = () => inDungeon() && (q.pos()?.worldX ?? 0) >= 2889;
            const doorClosed = () => !!q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889)
                ?.optionsWithIndex?.some((o: any) => /open/i.test(o.text));

            await q.walk('to kaqemeex', [{ x: 2924, z: 3485, tol: 2 }]);
            await q.talk(
                'kaqemeex 1',
                /^kaqemeex$/i,
                [/search of a quest/i, /will try and help/i],
                () => q.sawText(/speak to my fellow sanfew|go to the village south/i),
                { x: 2924, z: 3486 },
            );
            await q.walk('to sanfew stairs', [{ x: 2898, z: 3427, tol: 1 }]);
            await q.climb('sanfew stairs up', () => q.locAt(2898, 3428), /climb-up/i, () => q.lvl() === 1);
            await q.talk(
                'sanfew 1',
                /^sanfew$/i,
                [/sent to help purify/i, /i'll do that then/i],
                () => q.sawText(/well thank you very much|ok, i'll do that then/i),
                { x: 2897, z: 3426 },
            );
            await q.climb('sanfew stairs down', () => q.locAt(2898, 3428), /climb-down/i, () => q.lvl() === 0);
            await q.walk('to dungeon ladder', [{ x: 2885, z: 3398, tol: 1 }]);

            // Enable Protect from Melee before climbing into Taverley Dungeon (2 armours at 10 HP).
            await setProtectMelee(main, true, isStopped);
            await q.climb('ladder down', () => q.locAt(2884, 3397), /climb-down/i, inDungeon);
            await q.walk('to prison door', [{ x: 2888, z: 9831, tol: 0 }]);

            for (let i = 0; i < 8 && !inside() && doorClosed() && !isStopped(); i++) {
                await q.guard('prison door');
                const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
                if (d) await q.opLoc(d, q.opIndex(d, /open/i));
                await q.waitUntil(() => inside() || !doorClosed() || q.msgCount(/comes to life/i) > i, 6);
            }
            if (!inside() && doorClosed()) throw Error('haggis-stage7: cauldron door did not open');
            await q.walk('to cauldron', [{ x: 2892, z: 9831, tol: 1 }]);

            for (let k = 0; k < DRUID_RAW_MEATS.length; k++) {
                await q.step(
                    `dip ${DRUID_RAW_MEATS[k]}`,
                    () => q.useOnLoc(DRUID_RAW_MEATS[k]!, { id: 2142, x: 2893, z: 9831 }),
                    () => q.has(DRUID_ENCH_MEATS[k]!),
                    6,
                    5,
                );
            }

            for (let i = 0; i < 6 && inside() && doorClosed() && !isStopped(); i++) {
                await q.guard('door out');
                const d = q.findLoc(l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
                if (d) await q.opLoc(d, q.opIndex(d, /open/i));
                await q.waitUntil(() => !inside() || !doorClosed(), 6);
            }
            await q.walk('to ladder up', [{ x: 2884, z: 9798, tol: 1 }]);
            await q.climb('ladder up', () => q.locAt(2884, 9797), /climb-up/i, () => !inDungeon());
            await setProtectMelee(main, false, isStopped);

            await q.walk('back to sanfew stairs', [{ x: 2898, z: 3427, tol: 1 }]);
            await q.climb('sanfew stairs up 2', () => q.locAt(2898, 3428), /climb-up/i, () => q.lvl() === 1);
            await q.talk('sanfew 2', /^sanfew$/i, [], () => DRUID_ENCH_MEATS.every(id => !q.has(id)), { x: 2897, z: 3426 });
            await q.climb('sanfew stairs down 2', () => q.locAt(2898, 3428), /climb-down/i, () => q.lvl() === 0);
            await q.walk('back to kaqemeex', [{ x: 2924, z: 3485, tol: 3 }]);
            await q.talk('kaqemeex 2', /^kaqemeex$/i, [], () => xp(main, 'Herblore') >= 6_250, { x: 2924, z: 3486 }, 30, true);
        } finally {
            await q.dispose();
        }
        await clearDialogs(main, m, 'close');
    } finally {
        offWatch();
    }
    return { hpMin };
}

/** Runs Stage 7 on a staged practice account: Imp Catcher + Magic 99 -> Druidic Ritual (10 HP) -> Herblore 99. */
export async function runHaggisStage7(
    mainName: string,
    opts: { cap?: number; magicBuffer?: number; herbBuffer?: number } = {},
): Promise<{ phases: Stage7Phases }> {
    const cleanMain = assertSafeStage7Account(mainName);
    buildStage7Plan(opts.magicBuffer ?? 4, opts.herbBuffer ?? 2);
    const cap = opts.cap ?? 3500;

    let stopFlag = false;
    let settling = false;
    let sessionEndError: Error | null = null;
    const main = await openBot(cleanMain, {
        onStop: async () => { stopFlag = true; },
        onSessionEnd: async (_s, detail) => {
            if (!settling) {
                stopFlag = true;
                sessionEndError = Error(`unexpected stage7 end: ${detail}`);
            }
        },
    });
    const t0 = main.tick();
    const isStopped = () => stopFlag || main.tick() - t0 >= cap;
    const m = meter(main, 'Magic');

    try {
        await tick(main, 3);
        const world = await getWorld();

        // Phase 1: Varrock West Bank -> Imp Catcher (Magic 1->44) -> Edgeville Bank
        const impStart = main.tick();
        await bankAndWithdrawKit(
            main,
            m,
            new Set(),
            [
                { id: OBJ_GLORY_4, count: 1, label: 'Amulet of glory(4)' },
                ...IMP_BEAD_IDS.map(id => ({ id, count: 1, label: `Bead ${id}` })),
                { id: OBJ_SHARK, count: 2, label: 'Shark' },
            ],
            STAGE7_START_SPOT,
            isStopped,
        );
        await rubGloryDest(
            main,
            /draynor/i,
            p => p.level === 0 && p.worldX >= 3095 && p.worldX <= 3115 && p.worldZ >= 3240 && p.worldZ <= 3265,
            isStopped,
        );
        await runImpCatcher(main, Math.max(400, cap - (main.tick() - t0)));
        const magicAfterImp = level(main, 'Magic');
        await clearDialogs(main, m, 'close');
        await rubGloryDest(
            main,
            /edgeville/i,
            p => p.level === 0 && p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        const toEdge = await goTo(
            main,
            world,
            EDGEVILLE_BANK_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 40, noJewelry: true },
        );
        if (!toEdge.ok) throw Error(`haggis-stage7: walk to Edgeville bank failed: ${toEdge.detail ?? toEdge.reason ?? 'unknown'}`);
        const impCatcherTicks = main.tick() - impStart;

        // Phase 2: Magic 44 -> 99 at Edgeville Bank
        const magicStart = main.tick();
        await bankAndWithdrawKit(
            main,
            m,
            new Set(MAGIC_RUNE_STACKS.map(r => r.id)),
            MAGIC_RUNE_STACKS.map(r => ({ id: r.id, count: r.count, label: r.name, all: true })),
            EDGEVILLE_BANK_SPOT,
            isStopped,
        );
        await runEnchantTo99(main, m, isStopped);
        const magicTicks = main.tick() - magicStart;
        const magicLevel = level(main, 'Magic');
        const magicXp = xp(main, 'Magic');
        if (magicLevel < 99 || magicXp < xpForLevel(99)) {
            throw Error(`haggis-stage7: Magic ended below 99 (${magicLevel}, ${magicXp} xp)`);
        }

        // Phase 3: Druidic Ritual at 10 HP under Protect from Melee -> Edgeville Bank
        const druidStart = main.tick();
        await bankAndWithdrawKit(
            main,
            m,
            new Set(),
            [
                { id: OBJ_GAMES_8, count: 1, label: 'Games necklace(8)' },
                { id: OBJ_GLORY_4, count: 1, label: 'Amulet of glory(4)' },
                { id: OBJ_PRAYER_POTION_4, count: 1, label: 'Prayer potion(4)' },
                { id: OBJ_SHARK, count: 4, label: 'Shark' },
                ...DRUID_RAW_MEATS.map(id => ({ id, count: 1, label: `Raw meat ${id}` })),
            ],
            EDGEVILLE_BANK_SPOT,
            isStopped,
        );
        const { hpMin: druidicHpMin } = await runDruidicRitualLowCombat(
            main,
            m,
            Math.max(400, cap - (main.tick() - t0)),
            isStopped,
        );
        const herbloreAfterDruidic = level(main, 'Herblore');
        if (herbloreAfterDruidic < 28 || xp(main, 'Herblore') < 6_250) {
            throw Error(`haggis-stage7: Druidic Ritual ended at Herblore ${herbloreAfterDruidic} (${xp(main, 'Herblore')} xp)`);
        }
        await rubGloryDest(
            main,
            /edgeville/i,
            p => p.level === 0 && p.worldX >= 3070 && p.worldX <= 3110 && p.worldZ >= 3480 && p.worldZ <= 3515,
            isStopped,
        );
        const backEdge = await goTo(
            main,
            world,
            EDGEVILLE_BANK_SPOT,
            { skills: {}, varps: {}, items: [] },
            { legTimeoutTicks: 40, noJewelry: true },
        );
        if (!backEdge.ok) throw Error(`haggis-stage7: return to Edgeville bank failed: ${backEdge.detail ?? backEdge.reason ?? 'unknown'}`);
        const druidicTicks = main.tick() - druidStart;

        // Phase 4: Herblore 28 -> 99 at Edgeville Bank
        const hm = meter(main, 'Herblore');
        const herbStart = main.tick();
        await depositAllInventory(main, hm, EDGEVILLE_BANK_SPOT, isStopped);
        const herbJobs: Job[] = [];
        for (const st of ladder(HERBLORE, level(main, 'Herblore')).filter(s => s.band.out)) {
            const [unf, sec] = Object.keys(st.band.inputs);
            for (let i = 0; i < st.actions; i++) {
                herbJobs.push({ use: objId(unf!), on: objId(sec!), level: st.band.from, band: st.band.name, xp: st.band.xp });
            }
        }
        const herbOk = await bankProduction(main, hm, herbJobs, {
            keep: /^$/,
            pairSlots: 2,
            perLoad: 14,
            clear: 'close',
            closeWhileProducing: true,
        });
        if (!herbOk) throw Error('haggis-stage7: Herblore bankProduction failed');
        if (level(main, 'Herblore') < 99 || xp(main, 'Herblore') < xpForLevel(99)) {
            const topUp: Job[] = Array.from({ length: 2 }, () => ({
                use: 111,
                on: 247,
                level: 78,
                band: 'zamorak',
                xp: 175,
            }));
            await bankProduction(main, hm, topUp, {
                keep: /^$/,
                pairSlots: 2,
                perLoad: 2,
                clear: 'close',
                closeWhileProducing: true,
            });
        }
        const herbloreTicks = main.tick() - herbStart;
        const herbloreLevel = level(main, 'Herblore');
        const herbloreXp = xp(main, 'Herblore');

        const totalElapsedTicks = main.tick() - t0;
        const passed = magicLevel >= 99
            && magicXp >= xpForLevel(99)
            && herbloreLevel >= 99
            && herbloreXp >= xpForLevel(99)
            && totalElapsedTicks <= cap;
        settling = true;
        const ok = await settle(
            [main],
            passed,
            `magic=${magicLevel} herblore=${herbloreLevel} impTicks=${impCatcherTicks} magicTicks=${magicTicks} druidTicks=${druidicTicks} herbTicks=${herbloreTicks} total=${totalElapsedTicks}`,
        );
        if (!ok) {
            throw Error(`haggis-stage7 failed end checks: magic=${magicLevel} herblore=${herbloreLevel} total=${totalElapsedTicks}`);
        }
        return {
            phases: {
                impCatcherTicks,
                magicAfterImp,
                magicTicks,
                magicLevel,
                magicXp,
                druidicTicks,
                druidicHpMin,
                herbloreAfterDruidic,
                herbloreTicks,
                herbloreLevel,
                herbloreXp,
                totalElapsedTicks,
            },
        };
    } catch (error) {
        stopFlag = true;
        settling = true;
        console.error(`STAGE7_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        await settle([main], false, String(error)).catch(() => {});
        throw error;
    }
}

function ensurePackedGameAssets(): void {
    const engineDir = join(rsSdkRoot(), 'server', 'engine');
    const packed = join(engineDir, 'data', 'pack', 'server', 'script.dat');
    if (existsSync(packed)) return;
    console.log('Packing rs-sdk engine game assets for isolated Stage-7 rehearsal...');
    const res = Bun.spawnSync(['bun', 'run', 'build'], { cwd: engineDir, stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true });
    if (res.exitCode !== 0 || !existsSync(packed)) throw Error(`failed packing rs-sdk game assets (exit=${res.exitCode})`);
}

async function runIsolated(cap?: number): Promise<void> {
    const freeGiB = freemem() / 2 ** 30;
    if (freeGiB < PRACTICE_STARTUP_GB) {
        throw Error(`haggis-stage7 --isolated needs ${PRACTICE_STARTUP_GB} GiB free (currently ${freeGiB.toFixed(1)} GiB); run via hosted CI measure_script`);
    }
    ensurePackedGameAssets();
    process.env.SIM_LOCKSTEP = '1';
    process.env.RANDOM_EVENTS ??= '0';
    process.env.DEMO_OK = '';

    const plan = buildStage7Plan();
    const mainName = assertSafeStage7Account(runBotName('hs7m', 1));
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
            const { phases } = await runHaggisStage7(mainName, { cap });
            console.log(
                `STAGE7 pass magic=${phases.magicLevel}(${phases.magicXp}xp) afterImp=${phases.magicAfterImp}`
                + ` herblore=${phases.herbloreLevel}(${phases.herbloreXp}xp) afterDruid=${phases.herbloreAfterDruidic}`
                + ` hpMin=${phases.druidicHpMin} imp=${phases.impCatcherTicks} magicT=${phases.magicTicks}`
                + ` druid=${phases.druidicTicks} herb=${phases.herbloreTicks} totalSession=${phases.totalElapsedTicks}`,
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
            const { phases } = await runHaggisStage7(positional[0]!, { cap });
            console.log(`STAGE7 pass ${JSON.stringify(phases)}`);
        }
        process.exit(0);
    } catch (err) {
        console.error(`STAGE7 fail ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
