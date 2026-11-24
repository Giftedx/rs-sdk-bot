// Run the fresh-clock Attack 99 specialist route from Tutorial Island through Waterfall Quest, Tree Gnome Village, Fight Arena, and Vampire Slayer.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, openBot, serverFromEnv } from '../packages/core/src/bot';
import { protectedFromMelee } from '../packages/core/src/danger';
import { withDoorPolicy } from '../packages/core/src/door-policy';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { componentId } from '../packages/core/src/logout';
import { simBotsDir } from '../packages/core/src/practice-paths';
import { questFlags } from '../packages/core/src/quest-status';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { applyKnownDoorBlocks, sessionWalker, walkPath } from '../packages/core/src/walk';
import { runQuestArena } from './generated/quest-arena';
import { runQuestTree } from './generated/quest-tree';
import {
    configureSpecialistGuardEnv,
    mazeWalkWaypoints,
    MELEE_PVP_CORE_KIT,
    runMeleePvpSpecialist,
    runSpecialistWaterfall,
    type KitSpecItem,
} from './combat-quest-specialists';
import { leaveRuneStarter, onStarterIsland } from './rune-starter';
import {
    ATTACK_SPECIALIST_KIT,
    countById,
    exactNameRe,
    hasAtLeastKit,
    LUMBRIDGE_HANDOFF,
} from '../packages/workers/src/logistics';

export const ATTACK_PVP_SPECIALIST_KIT: readonly KitSpecItem[] = MELEE_PVP_CORE_KIT;

const TUTORIAL_KEEP_IDS = new Set([556, 558]); // Tutorial Air and Mind runes stack with the kit.
const PROTECT_MELEE_INDEX = 14;
export const RAILING_PROTECT_Z = 3255;
const AUTO_RETALIATE_OFF_ID = 151;
const PRAYER_POT_IDS = [2434, 139, 141, 143];
const ALLOWED_KIT_IDS = new Set(ATTACK_SPECIALIST_KIT.map(item => item.id));

const SPELLS = {
    windStrike: componentId('magic:wind_strike'),
    fireStrike: componentId('magic:fire_strike'),
    fireBolt: componentId('magic:fire_bolt'),
    varrockTeleport: componentId('magic:varrock_teleport'),
    lumbridgeTeleport: componentId('magic:lumbridge_teleport'),
    camelotTeleport: componentId('magic:camelot_teleport'),
} as const;

type StopFn = () => boolean;
type Point = { x: number; z: number; tol?: number };

function readServerHost(root: string, bot: string): string {
    for (const p of [join(simBotsDir(root), bot, 'bot.env'), join(root, 'vendor', 'rs-sdk', 'bots', bot, 'bot.env')]) {
        if (existsSync(p)) return serverFromEnv(readFileSync(p, 'utf8'));
    }
    return '';
}

function posOf(s: Session) {
    return s.sdk.getState()?.player as { worldX: number; worldZ: number; level: number; hp?: number } | undefined;
}

function d8(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function skillInfo(s: Session, name: string): { level: number; baseLevel: number; experience: number } {
    const sk = s.sdk.getSkill(name) as { level?: number; baseLevel?: number; experience?: number } | undefined;
    return {
        level: sk?.level ?? 1,
        baseLevel: sk?.baseLevel ?? sk?.level ?? 1,
        experience: sk?.experience ?? 0,
    };
}

function activeContinueDialog(s: Session): boolean {
    const d: any = s.sdk.getDialog();
    if (!d?.isOpen || d.isWaiting) return false;
    const opts: any[] = d.options ?? [];
    return opts.length === 0 || opts.every(o => /click here to continue/i.test(o.text ?? ''));
}

async function dismissContinueDialogs(s: Session, stop: StopFn, maxTicks = 8): Promise<void> {
    for (let i = 0; i < maxTicks && !stop(); i++) {
        const d: any = s.sdk.getDialog();
        if (!d?.isOpen) return;
        if (!d.isWaiting && activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
        await waitTicks(s, 1);
    }
}

async function walkWaypoints(
    s: Session,
    pts: Point[],
    maxTicks: number,
    stop: StopFn,
    label: string,
    opts: { ignoreMeleeHunters?: boolean; onTickExtra?: () => void } = {},
): Promise<void> {
    const walker = await sessionWalker(s);
    if (opts.ignoreMeleeHunters) {
        const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
        const grid = await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
        const { withDanger } = await import('../packages/core/src/danger');
        const basePlan = walker.plan;
        walker.plan = (level, from, to, avoid) => {
            if (!protectedFromMelee(s.sdk.getState())) return basePlan(level, from, to, avoid);
            pf.initPathfinding();
            const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map(b => (b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b));
            const find = () => withDoorPolicy(grid, blocks, () => pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, (s.sdk as any).temporaryDoorBlocks?.active?.() ?? []));
            return avoid?.length ? withDanger(grid, avoid.map(t => ({ ...t, level })), [{ ...from, level }, { ...to, level }], find, 'live') : find();
        };
    }
    const offDialog = s.onTick(() => {
        if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
        opts.onTickExtra?.();
    });
    try {
        const r = await walkPath(walker, pts, { maxTicks, stop, look: 20 });
        if (!r.ok) throw Error(`walk failed (${label}): ${r.detail ?? JSON.stringify(r)}`);
    } finally {
        offDialog();
    }
}

async function setProtectMelee(s: Session, on: boolean, stop: StopFn): Promise<void> {
    const prayers = () => s.sdk.getState()?.prayers;
    const isOn = () => !!prayers()?.activePrayers?.[PROTECT_MELEE_INDEX];
    if (isOn() === on) return;
    if (on && (prayers()?.prayerPoints ?? 0) <= 0) return;
    for (let i = 0; i < 4 && !stop() && isOn() !== on; i++) {
        await s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE_INDEX, reason: 'SDK' });
        if (await waitUntil(s, () => isOn() === on || stop(), { timeoutTicks: 3 })) return;
    }
}

async function topUpPrayer(s: Session, minPoints: number, stop: StopFn): Promise<void> {
    while (!stop() && (s.sdk.getState()?.prayers?.prayerPoints ?? 0) < minPoints) {
        const pot = s.sdk.getInventory().find(i => PRAYER_POT_IDS.includes(i.id));
        if (!pot) return;
        const before = s.sdk.getState()?.prayers?.prayerPoints ?? 0;
        await s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
        await waitUntil(s, () => (s.sdk.getState()?.prayers?.prayerPoints ?? 0) > before || stop(), { timeoutTicks: 4 });
    }
}

async function dropTutorialJunk(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 45;
    while (!stop()) {
        const junk = s.sdk.getInventory().filter(i => !TUTORIAL_KEEP_IDS.has(i.id));
        if (junk.length === 0) return;
        if (s.tick() >= deadline) throw Error(`failed to drop tutorial items: ${junk.map(i => i.id).join(',')}`);
        await dismissContinueDialogs(s, stop, 2);
        const batch = junk.slice(0, 4);
        await Promise.all(batch.map(i => s.direct({ type: 'dropItem', slot: i.slot, reason: 'SDK' })));
        await waitTicks(s, 1);
    }
}

async function receiveSupplyKit(s: Session, supplierName: string, stop: StopFn): Promise<void> {
    const p0 = posOf(s);
    if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, LUMBRIDGE_HANDOFF) > 2) {
        await walkWaypoints(s, [{ ...LUMBRIDGE_HANDOFF, tol: 2 }], 80, stop, 'lumbridge handoff');
    }
    const peerRe = exactNameRe(supplierName);
    const deadline = s.tick() + 180;
    while (!stop() && !hasAtLeastKit(s.sdk.getInventory(), ATTACK_SPECIALIST_KIT)) {
        if (s.tick() >= deadline) throw Error(`did not receive specialist kit from ${supplierName}`);
        await dismissContinueDialogs(s, stop, 2);
        await s.bot.dismissBlockingUI();
        const near = (s.sdk.getState()?.nearbyPlayers ?? []).find((n: any) => peerRe.test(n.name));
        if (!near) {
            await waitTicks(s, 1);
            continue;
        }
        const tr = await s.bot.trade(peerRe, {
            accept: offer =>
                offer.every(o => ALLOWED_KIT_IDS.has(o.id)) &&
                ATTACK_SPECIALIST_KIT.every(k => countById(offer, k.id) === k.count),
            requestTimeout: 10_000,
            timeout: 45_000,
            retryOnBusy: true,
        });
        if (tr.success) {
            await waitUntil(s, () => hasAtLeastKit(s.sdk.getInventory(), ATTACK_SPECIALIST_KIT) || stop(), { timeoutTicks: 10 });
            if (hasAtLeastKit(s.sdk.getInventory(), ATTACK_SPECIALIST_KIT)) return;
        }
        await waitTicks(s, 1);
    }
    if (!hasAtLeastKit(s.sdk.getInventory(), ATTACK_SPECIALIST_KIT)) {
        throw Error('stopped waiting for specialist supply kit');
    }
}

async function equipStaffAndBuryBones(s: Session, stop: StopFn): Promise<void> {
    if (!s.sdk.getEquipment().some(e => e.id === 1387)) {
        const staff = s.sdk.getInventory().find(i => i.id === 1387);
        if (!staff) throw Error('missing Staff of fire (1387)');
        const eq = await s.bot.equipItem(staff);
        if (!eq.success && !s.sdk.getEquipment().some(e => e.id === 1387)) {
            throw Error(`failed to equip Staff of fire: ${eq.message}`);
        }
        await waitUntil(s, () => s.sdk.getEquipment().some(e => e.id === 1387) || stop(), { timeoutTicks: 6 });
    }
    if (!s.sdk.getEquipment().some(e => e.id === 1387)) throw Error('Staff of fire not equipped');

    const boneDeadline = s.tick() + 60;
    while (!stop()) {
        const before = countById(s.sdk.getInventory(), 536);
        if (before === 0) break;
        if (s.tick() >= boneDeadline) throw Error(`stalled burying Dragon bones (${before} remaining)`);
        const bone = s.sdk.getInventory().find(i => i.id === 536);
        if (!bone) break;
        await s.sdk.sendUseItem(bone.slot, 1);
        await waitUntil(s, () => countById(s.sdk.getInventory(), 536) < before || stop(), { timeoutTicks: 5 });
    }
    const prayer = skillInfo(s, 'Prayer');
    if (prayer.baseLevel < 43) {
        throw Error(`Prayer ${prayer.baseLevel} < 43 after burying Dragon bones (xp=${prayer.experience})`);
    }
}

function inLumbridgeCourtyard(x: number, z: number): boolean {
    return x >= 3217 && x <= 3225 && z >= 3210 && z <= 3229;
}

function inLumbridgeEastPlaza(x: number, z: number): boolean {
    return x >= 3228 && x <= 3246 && z >= 3212 && z <= 3232;
}

export interface CourtyardNpc {
    index: number;
    name?: string;
    x?: number;
    z?: number;
    tileX?: number;
    tileZ?: number;
    distance?: number;
    hp?: number | null;
    inCombat?: boolean;
    targetIndex?: number;
    reachable?: boolean;
    optionsWithIndex?: readonly { text?: string }[];
}

// Prioritize any NPC already engaged with us in single-way combat before picking a fresh courtyard target.
export function pickCourtyardMagicTarget(
    npcs: readonly CourtyardNpc[],
    opts: {
        selfSlot?: number;
        engagedTargetIndex?: number | null;
        activeTargetIndex?: number | null;
        avoid: ReadonlySet<number>;
        zoneOk: (x: number, z: number) => boolean;
    },
): CourtyardNpc | undefined {
    const attackable = (n: CourtyardNpc) =>
        (n.hp === undefined || n.hp === null || n.hp > 0) &&
        n.reachable !== false &&
        (n.optionsWithIndex ?? []).some(o => /^attack$/i.test(o.text ?? ''));
    const selfTarget = Number.isSafeInteger(opts.selfSlot) ? 32768 + opts.selfSlot! : -1;

    if (opts.engagedTargetIndex !== null && opts.engagedTargetIndex !== undefined && opts.engagedTargetIndex >= 0) {
        const engaged = npcs.find(n => n.index === opts.engagedTargetIndex && attackable(n));
        if (engaged) return engaged;
    }
    if (selfTarget >= 32768) {
        const attacker = npcs
            .filter(n => n.inCombat && n.targetIndex === selfTarget && attackable(n))
            .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0];
        if (attacker) return attacker;
    }
    const inZoneMob = (n: CourtyardNpc) => {
        const nx = n.tileX ?? n.x ?? 0;
        const nz = n.tileZ ?? n.z ?? 0;
        return /^(man|woman|rat|goblin)$/i.test(n.name ?? '') && attackable(n) && opts.zoneOk(nx, nz);
    };
    if (opts.activeTargetIndex !== null && opts.activeTargetIndex !== undefined) {
        const kept = npcs.find(
            n =>
                n.index === opts.activeTargetIndex &&
                !opts.avoid.has(n.index) &&
                (!n.inCombat || (selfTarget >= 32768 && n.targetIndex === selfTarget)) &&
                inZoneMob(n),
        );
        if (kept) return kept;
    }
    const free = npcs
        .filter(n => !n.inCombat && !opts.avoid.has(n.index) && inZoneMob(n))
        .sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99));
    return free.find(n => (n.distance ?? 99) <= 8 && /^(man|woman|goblin)$/i.test(n.name ?? '')) ?? free[0];
}

async function disableAutoRetaliate(s: Session, stop: StopFn): Promise<void> {
    if (s.sdk.getState()?.autoRetaliateEnabled !== true) return;
    await s.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_OFF_ID, reason: 'SDK' });
    await waitUntil(s, () => s.sdk.getState()?.autoRetaliateEnabled === false || stop(), { timeoutTicks: 6 });
}

function lastMessageTick(s: Session, re: RegExp): number {
    return Math.max(
        -1,
        ...((s.sdk.getState()?.gameMessages ?? []) as { type?: number; text?: string; observationId?: number; tick?: number }[])
            .filter(m => m.type === 0 && re.test(m.text ?? ''))
            .map(m => m.observationId ?? m.tick ?? -1),
    );
}

async function trainCourtyardMagicTo25(s: Session, stop: StopFn): Promise<void> {
    const p0 = posOf(s);
    if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, LUMBRIDGE_HANDOFF) > 6) {
        await walkWaypoints(s, [{ ...LUMBRIDGE_HANDOFF, tol: 3 }], 60, stop, 'lumbridge courtyard');
    }
    await disableAutoRetaliate(s, stop);
    let activeTargetIndex: number | null = null;
    let lastCastTick = -10;
    let outsideMoved = false;
    let emptyTicks = 0;
    const avoid = new Map<number, number>();
    const deadline = s.tick() + 260;

    while (!stop() && skillInfo(s, 'Magic').baseLevel < 25) {
        if (s.tick() >= deadline) {
            const m = skillInfo(s, 'Magic');
            throw Error(`Magic 1->25 timed out at level=${m.baseLevel} xp=${m.experience}`);
        }
        await disableAutoRetaliate(s, stop);
        await dismissContinueDialogs(s, stop, 2);
        for (const [idx, until] of avoid) {
            if (s.tick() >= until) avoid.delete(idx);
        }
        const zoneOk = (x: number, z: number) => (outsideMoved ? inLumbridgeEastPlaza(x, z) || inLumbridgeCourtyard(x, z) : inLumbridgeCourtyard(x, z));
        const st: any = s.sdk.getState();
        const selfSlot = (s.client as { selfSlot?: number } | undefined)?.selfSlot;
        const engagedTargetIndex = st?.player?.combat?.inCombat && st.player.combat.targetType === 'npc' ? st.player.combat.targetIndex : null;
        const target = pickCourtyardMagicTarget(st?.nearbyNpcs ?? [], {
            selfSlot,
            engagedTargetIndex,
            activeTargetIndex,
            avoid: new Set(avoid.keys()),
            zoneOk,
        });
        if (!target) {
            emptyTicks++;
            if (!outsideMoved && emptyTicks >= 8) {
                outsideMoved = true;
                emptyTicks = 0;
                activeTargetIndex = null;
                await walkWaypoints(s, [{ x: 3234, z: 3221, tol: 2 }], 40, stop, 'lumbridge east plaza');
            } else {
                await waitTicks(s, 1);
            }
            continue;
        }
        emptyTicks = 0;
        if (s.tick() - lastCastTick < 5) {
            await waitTicks(s, 1);
            continue;
        }
        while (!stop() && activeContinueDialog(s)) {
            await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
        }
        if (stop() || skillInfo(s, 'Magic').baseLevel >= 25) break;

        const spellComponent = skillInfo(s, 'Magic').baseLevel < 13 ? SPELLS.windStrike : SPELLS.fireStrike;
        const xpBefore = skillInfo(s, 'Magic').experience;
        const underAttackBefore = lastMessageTick(s, /already under attack/i);
        const selfTarget = Number.isSafeInteger(selfSlot) ? 32768 + selfSlot! : -1;
        const targetingUs = !!(target.inCombat && selfTarget >= 32768 && target.targetIndex === selfTarget) || target.index === engagedTargetIndex;
        const castAt = s.tick();
        activeTargetIndex = target.index;
        lastCastTick = castAt;
        const castReply = await s.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent, reason: 'SDK' });

        const gotXp = await waitUntil(
            s,
            () => stop() || skillInfo(s, 'Magic').baseLevel >= 25 || skillInfo(s, 'Magic').experience > xpBefore,
            { timeoutTicks: 6 },
        );
        if (skillInfo(s, 'Magic').baseLevel >= 25) break;
        if (!gotXp || skillInfo(s, 'Magic').experience <= xpBefore) {
            const nx = target.tileX ?? target.x, nz = target.tileZ ?? target.z;
            const msgs = (s.sdk.getState()?.gameMessages ?? []).slice(-4).map((m: any) => m.text);
            const underAttackNow = lastMessageTick(s, /already under attack/i) > underAttackBefore;
            console.log(`WARN magic1_25 miss ${JSON.stringify({ tick: s.tick(), name: target.name, at: [nx, nz], index: target.index, d: target.distance, pos: posOf(s), castReply, air: countById(s.sdk.getInventory(), 556), mind: countById(s.sdk.getInventory(), 558), worn: s.sdk.getEquipment().map((e: any) => e.id), msgs })}`);
            if (!underAttackNow && !targetingUs) avoid.set(target.index, s.tick() + 25);
            activeTargetIndex = null;
            lastCastTick = -10;
            continue;
        }
        while (!stop() && skillInfo(s, 'Magic').baseLevel < 25 && s.tick() - castAt < 5) {
            if (activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
        }
    }
}

async function talkAndChoose(
    s: Session,
    npcRe: RegExp,
    home: Point,
    choices: RegExp[],
    donePred: () => boolean,
    stop: StopFn,
    label: string,
    maxTicks = 45,
): Promise<void> {
    for (let attempt = 0; attempt < 4 && !donePred() && !stop(); attempt++) {
        if (attempt > 0 || d8({ x: posOf(s)?.worldX ?? 0, z: posOf(s)?.worldZ ?? 0 }, home) > 5) {
            await walkWaypoints(s, [{ ...home, tol: 3 }], 80, stop, `approach ${label}`);
        }
        const npc = s.sdk.findNearbyNpc(npcRe);
        if (npc) {
            await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen || donePred() || stop(), { timeoutTicks: 12 });
        }
        if (!s.sdk.getDialog()?.isOpen && !donePred()) {
            await s.bot.talkTo(npcRe);
        }
        const end = s.tick() + maxTicks;
        let lastClick = -10;
        let shutTicks = 0;
        while (!stop() && s.tick() < end) {
            if (donePred() && !s.sdk.getDialog()?.isOpen) return;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen) {
                shutTicks = 0;
                if (!d.isWaiting && s.tick() - lastClick >= 1) {
                    const opts: any[] = d.options ?? [];
                    const pick = opts.find(o => choices.some(re => re.test(o.text ?? '')));
                    lastClick = s.tick();
                    await s.sdk.sendClickDialog(pick ? pick.index : 0);
                }
            } else {
                shutTicks++;
                if (donePred() || shutTicks >= 4) break;
            }
            await waitTicks(s, 1);
        }
    }
    if (!donePred()) throw Error(`${label} dialogue incomplete`);
}

async function teleportTo(
    s: Session,
    spellComponent: number,
    arrived: (p: { worldX: number; worldZ: number; level: number }) => boolean,
    stop: StopFn,
    label: string,
): Promise<void> {
    for (let attempt = 0; attempt < 6 && !stop(); attempt++) {
        const p = posOf(s);
        if (p && arrived(p)) return;
        await s.direct({ type: 'clickComponent', componentId: spellComponent, reason: 'SDK' });
        await waitUntil(s, () => {
            const cur = posOf(s);
            return (!!cur && arrived(cur)) || stop();
        }, { timeoutTicks: 8 });
    }
    const p = posOf(s);
    if (!p || !arrived(p)) {
        throw Error(`${label} failed at ${p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'}`);
    }
}

async function teleportVarrockTo45(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 180;
    while (!stop() && skillInfo(s, 'Magic').baseLevel < 45) {
        if (s.tick() >= deadline) throw Error(`Varrock teleport Magic 25->45 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        if (countById(s.sdk.getInventory(), 563) < 2) throw Error('low Law runes during Varrock teleport');
        const xp0 = skillInfo(s, 'Magic').experience;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.varrockTeleport, reason: 'SDK' });
        const gained = await waitUntil(s, () => skillInfo(s, 'Magic').experience > xp0 || stop(), { timeoutTicks: 5 });
        if (gained && skillInfo(s, 'Magic').experience > xp0 && !stop()) {
            await waitTicks(s, 3);
        }
    }
    await teleportTo(s, SPELLS.varrockTeleport, p => p.worldX >= 3195 && p.worldX <= 3230 && p.worldZ >= 3410 && p.worldZ <= 3440, stop, 'Varrock teleport');
}

async function buyExactFromOpenShop(
    s: Session,
    itemRe: RegExp,
    itemId: number,
    amount: number,
    stop: StopFn,
    label: string,
): Promise<void> {
    const targetCount = countById(s.sdk.getInventory(), itemId) + amount;
    const deadline = s.tick() + 20;
    while (!stop() && countById(s.sdk.getInventory(), itemId) < targetCount) {
        if (s.tick() >= deadline) throw Error(`failed buying ${label} (${countById(s.sdk.getInventory(), itemId)}/${targetCount})`);
        const shopItem = (s.sdk.getState()?.shop?.shopItems ?? []).find((it: any) => it?.id === itemId || itemRe.test(it?.name ?? ''));
        if (!shopItem) {
            await waitTicks(s, 1);
            continue;
        }
        let rem = targetCount - countById(s.sdk.getInventory(), itemId);
        const clicks: Promise<unknown>[] = [];
        while (rem > 0 && clicks.length < 4) {
            const step = rem >= 10 ? 10 : rem >= 5 ? 5 : 1;
            clicks.push(s.direct({ type: 'shopBuy', slot: shopItem.slot, amount: step, reason: 'SDK' }));
            rem -= step;
        }
        await Promise.all(clicks);
        await waitUntil(s, () => countById(s.sdk.getInventory(), itemId) >= targetCount || stop(), { timeoutTicks: 3 });
    }
}

async function prepareVampireAndWaterfallInDraynorAndVarrock(s: Session, stop: StopFn): Promise<void> {
    // 1. Draynor: start Vampire Slayer with Morgan and buy Rope (15 gp) from Ned.
    await walkWaypoints(s, [{ x: 3098, z: 3268, tol: 2 }], 140, stop, 'lumbridge to morgan');
    await talkAndChoose(
        s,
        /^morgan$/i,
        { x: 3098, z: 3268 },
        [/up for an adventure/i],
        () => questFlags(s.client)?.find(f => f.name === 'Vampire Slayer')?.state === 'started',
        stop,
        'morgan',
    );
    await walkWaypoints(s, [{ x: 3100, z: 3258, tol: 2 }], 40, stop, 'morgan to ned');
    await talkAndChoose(
        s,
        /^ned$/i,
        { x: 3100, z: 3258 },
        [/yes, i would like some rope/i, /sell me some rope/i],
        () => countById(s.sdk.getInventory(), 954) >= 1,
        stop,
        'ned rope',
    );

    // 2. Varrock Tele 25->45, buy Hammer (Gen Store), 6 Water + 7 Earth runes (Aubury), Beer + Stake (Jolly Boar Inn).
    await teleportVarrockTo45(s, stop);
    await walkWaypoints(s, [{ x: 3217, z: 3415, tol: 2 }], 40, stop, 'varrock square to general store');
    const openGen = await s.bot.openShop(/shop\s*(keeper|assistant)/i);
    if (!openGen.success) throw Error(`Varrock general store open failed: ${openGen.message}`);
    await buyExactFromOpenShop(s, /^hammer$/i, 2347, 1, stop, 'Hammer');
    await s.bot.closeShop();

    await walkWaypoints(s, [{ x: 3253, z: 3402, tol: 2 }], 60, stop, 'general store to aubury');
    const openAubury = await s.bot.openShop(/^aubury$/i);
    if (!openAubury.success) throw Error(`Aubury open failed: ${openAubury.message}`);
    await buyExactFromOpenShop(s, /^water rune$/i, 555, 6, stop, 'Water rune');
    await buyExactFromOpenShop(s, /^earth rune$/i, 557, 7, stop, 'Earth rune');
    await s.bot.closeShop();

    await walkWaypoints(s, [{ x: 3278, z: 3490, tol: 2 }], 100, stop, 'aubury to jolly boar inn');
    await talkAndChoose(
        s,
        /bartender/i,
        { x: 3278, z: 3490 },
        [/beer please/i],
        () => countById(s.sdk.getInventory(), 1917) >= 1,
        stop,
        'jolly boar bartender beer',
    );
    await talkAndChoose(
        s,
        /^dr harlow$/i,
        { x: 3277, z: 3492 },
        [/morgan needs your help/i, /ok mate/i],
        () => countById(s.sdk.getInventory(), 1549) >= 1,
        stop,
        'dr harlow stake',
        65,
    );

    // 3. Camelot Teleport -> Almera.
    await teleportTo(s, SPELLS.camelotTeleport, p => p.worldX <= 2800 && p.worldZ >= 3440, stop, 'Camelot teleport');
    await walkWaypoints(s, [{ x: 2522, z: 3494, tol: 1 }], 220, stop, 'camelot to almera');
}

async function squeezeLooseRailing(s: Session, crossed: (z: number) => boolean, stop: StopFn, label: string): Promise<void> {
    for (let attempt = 0; attempt < 8 && !stop(); attempt++) {
        if (crossed(posOf(s)?.worldZ ?? 0)) return;
        await dismissContinueDialogs(s, stop, 1);
        const railing = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => (l.id === 2186 || /railing/i.test(l.name ?? '')) && (l.optionsWithIndex ?? []).some((o: any) => /squeeze/i.test(o.text ?? '')))
            .sort((a: any, b: any) => d8(a, { x: 2515, z: 3161 }) - d8(b, { x: 2515, z: 3161 }))[0];
        if (!railing) throw Error('loose railing not found at 2515,3161');
        const op = railing.optionsWithIndex.find((o: any) => /squeeze/i.test(o.text ?? ''));
        await s.sdk.sendInteractLoc(railing.x, railing.z, railing.id, op?.opIndex ?? 1);
        await waitUntil(s, () => crossed(posOf(s)?.worldZ ?? 0) || stop(), { timeoutTicks: 8 });
    }
    if (!crossed(posOf(s)?.worldZ ?? 0)) throw Error(`failed loose railing squeeze: ${label}`);
}

async function walkGolrieToBolren(s: Session, stop: StopFn): Promise<void> {
    await mazeWalkWaypoints(s, [{ x: 2515, z: 3160, tol: 0 }], 120, stop, 'golrie to loose railing');
    await squeezeLooseRailing(s, z => z >= 3161, stop, 'enter maze');
    await walkWaypoints(s, [{ x: 2529, z: 3165, tol: 2 }, { x: 2542, z: 3171, tol: 1 }], 80, stop, 'railing to bolren');
}

async function exitMazeAndClearArenaGear(s: Session, stop: StopFn): Promise<void> {
    await walkWaypoints(s, [{ x: 2529, z: 3165, tol: 2 }, { x: 2515, z: 3161, tol: 0 }], 80, stop, 'bolren to loose railing');
    await squeezeLooseRailing(s, z => z > 0 && z <= 3160, stop, 'exit maze');
    // South of the loose railing is an enclosed gate courtyard; talk to Elkoy to jump outside the maze (2504,3192).
    await talkAndChoose(
        s,
        /^elkoy$/i,
        { x: 2515, z: 3159 },
        [/yes please/i],
        () => {
            const p = posOf(s);
            return !!p && d8({ x: p.worldX, z: p.worldZ }, { x: 2504, z: 3192 }) <= 6;
        },
        stop,
        'elkoy out',
        30,
    );
    await dismissContinueDialogs(s, stop, 4);
    await setProtectMelee(s, true, stop);
    await walkWaypoints(s, [{ x: 2566, z: 3201, tol: 2 }], 120, stop, 'elkoy out to lady servil', { ignoreMeleeHunters: true });
}

async function finishVampireSlayer(s: Session, stop: StopFn): Promise<void> {
    await teleportTo(s, SPELLS.lumbridgeTeleport, p => p.worldX >= 3205 && p.worldX <= 3240 && p.worldZ >= 3205 && p.worldZ <= 3235, stop, 'Lumbridge teleport');
    await walkWaypoints(s, [{ x: 3108, z: 3352, tol: 1 }], 180, stop, 'lumbridge to draynor manor');

    const inManor = () => {
        const p = posOf(s);
        return !!p && p.worldZ >= 3354 && p.worldZ < 9000;
    };
    for (let i = 0; i < 6 && !inManor() && !stop(); i++) {
        const d = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => (l.id === 134 || l.id === 135) && l.z === 3353);
        if (d) await s.sdk.sendInteractLoc(d.x, d.z, d.id, 1);
        await waitUntil(s, () => inManor() || stop(), { timeoutTicks: 6 });
    }
    if (!inManor()) throw Error('failed entering Draynor Manor front door');

    const openShutDoor = async (x: number, z: number, label: string) => {
        for (let i = 0; i < 6 && !stop(); i++) {
            const shut = (s.sdk.getState()?.nearbyLocs ?? []).find(
                (l: any) => l.x === x && l.z === z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text ?? '')),
            );
            if (!shut) return;
            const op = shut.optionsWithIndex.find((o: any) => /^open$/i.test(o.text ?? ''));
            await s.sdk.sendInteractLoc(shut.x, shut.z, shut.id, op?.opIndex ?? 1);
            await waitTicks(s, 2);
        }
        const still = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.x === x && l.z === z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text ?? '')),
        );
        if (still) throw Error(`failed opening ${label} at ${x},${z}`);
    };
    const dash = async (x: number, z: number, tol: number, label: string) => {
        for (let i = 0; i < 12 && !stop(); i++) {
            const p = posOf(s);
            if (p && d8({ x: p.worldX, z: p.worldZ }, { x, z }) <= tol) return;
            await s.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
            await waitUntil(s, () => {
                const cur = posOf(s);
                return (!!cur && d8({ x: cur.worldX, z: cur.worldZ }, { x, z }) <= tol) || stop();
            }, { timeoutTicks: 4 });
        }
        throw Error(`failed dash inside Draynor Manor: ${label}`);
    };

    // Exact open route inside Draynor Manor avoiding locked closet_door 131 at 3107,3367.
    await openShutDoor(3109, 3358, 'manor hall door');
    await dash(3106, 3367, 0, 'north room');
    await openShutDoor(3106, 3368, 'corridor door');
    await dash(3114, 3370, 0, 'corridor');
    await dash(3118, 3362, 1, 'east room');
    await dash(3115, 3356, 0, 'crypt stairs');

    for (let i = 0; i < 6 && (posOf(s)?.worldZ ?? 0) < 9000 && !stop(); i++) {
        const stairs = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.x === 3115 && l.z === 3357 && (l.optionsWithIndex ?? []).some((o: any) => /walk-down|climb-down|go-down/i.test(o.text ?? '')),
        );
        if (stairs) {
            const op = stairs.optionsWithIndex.find((o: any) => /walk-down|climb-down|go-down/i.test(o.text ?? ''));
            await s.sdk.sendInteractLoc(stairs.x, stairs.z, stairs.id, op?.opIndex ?? 1);
        }
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) > 9000 || stop(), { timeoutTicks: 6 });
    }
    if ((posOf(s)?.worldZ ?? 0) <= 9000) throw Error('failed descending Draynor Manor crypt stairs');

    await topUpPrayer(s, 20, stop);
    await setProtectMelee(s, true, stop);
    for (let i = 0; i < 8 && !stop(); i++) {
        if (s.sdk.findNearbyNpc(/^count draynor$/i)) break;
        const coffin = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.x === 3077 && l.z === 9775);
        await s.sdk.sendInteractLoc(coffin?.x ?? 3077, coffin?.z ?? 9775, coffin?.id ?? 2614, 1);
        await waitUntil(s, () => !!s.sdk.findNearbyNpc(/^count draynor$/i) || stop(), { timeoutTicks: 6 });
    }

    let lastAttackTick = -10;
    const fightDeadline = s.tick() + 180;
    while (!stop() && skillInfo(s, 'Attack').baseLevel < 99) {
        if (s.tick() >= fightDeadline) throw Error(`Count Draynor fight timed out at Attack ${skillInfo(s, 'Attack').baseLevel}`);
        await dismissContinueDialogs(s, stop, 1);
        await setProtectMelee(s, true, stop);
        if ((s.sdk.getState()?.prayers?.prayerPoints ?? 0) <= 6) await topUpPrayer(s, 20, stop);
        const count = s.sdk.findNearbyNpc(/^count draynor$/i);
        if (count) {
            const canFireBolt =
                skillInfo(s, 'Magic').baseLevel >= 35 &&
                s.sdk.getEquipment().some(e => e.id === 1387) &&
                countById(s.sdk.getInventory(), 562) >= 1 &&
                countById(s.sdk.getInventory(), 556) >= 3;
            if (canFireBolt && s.tick() - lastAttackTick >= 5) {
                lastAttackTick = s.tick();
                await s.direct({ type: 'spellOnNpc', npcIndex: count.index, spellComponent: SPELLS.fireBolt, reason: 'SDK' });
            } else if (!canFireBolt && s.tick() - lastAttackTick >= 4) {
                lastAttackTick = s.tick();
                const atkOp = count.optionsWithIndex?.find((o: any) => /attack/i.test(o.text ?? ''))?.opIndex ?? 2;
                await s.direct({ type: 'interactNpc', npcIndex: count.index, optionIndex: atkOp, reason: 'SDK' });
            }
        } else if (countById(s.sdk.getInventory(), 1549) >= 1 && s.tick() - lastAttackTick >= 10) {
            lastAttackTick = s.tick();
            const coffin = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.x === 3077 && l.z === 9775);
            await s.sdk.sendInteractLoc(coffin?.x ?? 3077, coffin?.z ?? 9775, coffin?.id ?? 2614, 1);
        }
        await waitTicks(s, 1);
    }
}

async function openShutArenaDoor(s: Session, x: number, z: number, label: string, stop: StopFn): Promise<void> {
    for (let i = 0; i < 6 && !stop(); i++) {
        const shut = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.x === x && l.z === z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text ?? '')),
        );
        if (!shut) return;
        const op = shut.optionsWithIndex.find((o: any) => /^open$/i.test(o.text ?? ''));
        await s.sdk.sendInteractLoc(shut.x, shut.z, shut.id, op?.opIndex ?? 1);
        await waitTicks(s, 2);
    }
    const still = (s.sdk.getState()?.nearbyLocs ?? []).find(
        (l: any) => l.x === x && l.z === z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text ?? '')),
    );
    if (still) throw Error(`failed opening ${label} at ${x},${z}`);
}

async function passArenaGuardDoor(
    s: Session,
    door: { x: number; z: number },
    through: () => boolean,
    label: string,
    stop: StopFn,
): Promise<void> {
    for (let i = 0; i < 6 && !through() && !stop(); i++) {
        const loc = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.x === door.x && l.z === door.z && (l.optionsWithIndex ?? []).some((o: any) => /^open$/i.test(o.text ?? '')),
        );
        if (loc) {
            const op = loc.optionsWithIndex.find((o: any) => /^open$/i.test(o.text ?? ''));
            await s.sdk.sendInteractLoc(loc.x, loc.z, loc.id, op?.opIndex ?? 1);
        }
        const deadline = s.tick() + 25;
        while (!stop() && !through() && s.tick() < deadline) {
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting) await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
        }
    }
    if (!through()) throw Error(`Fight Arena stuck at ${label}`);
}

async function runFightArenaThroughKeys(s: Session, stop: StopFn): Promise<void> {
    const sawArenaDialog = (re: RegExp) => {
        const d: any = s.sdk.getDialog();
        if (d?.isOpen && re.test(d.text ?? '')) return true;
        return (s.sdk.getState()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    const talkGuardById = async (label: string, done: () => boolean, maxTicks = 60) => {
        for (let attempt = 0; attempt < 3 && !done() && !stop(); attempt++) {
            const guard = (s.sdk.getState()?.nearbyNpcs ?? [])
                .filter((n: any) => n.id === 254)
                .sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99))[0];
            if (!guard) throw Error(`Fight Arena ${label}: guard 254 not visible`);
            await s.direct({ type: 'interactNpc', npcIndex: guard.index, optionIndex: 1, reason: 'SDK' });
            await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen || done() || stop(), { timeoutTicks: 20 });
            const end = s.tick() + maxTicks;
            let shut = 0;
            while (!stop() && s.tick() < end) {
                const d: any = s.sdk.getDialog();
                if (d?.isOpen) {
                    shut = 0;
                    if (!d.isWaiting) await s.sdk.sendClickDialog(0);
                } else {
                    shut++;
                    if ((done() && shut >= 2) || shut >= 3) break;
                }
                await waitTicks(s, 1);
            }
            if (done()) return;
        }
        if (!done()) throw Error(`Fight Arena ${label} incomplete`);
    };

    // 1. Lady Servil -> 2. Chest (Khazard helmet + armour, equip both).
    await talkAndChoose(
        s,
        /^lady servil$/i,
        { x: 2566, z: 3199 },
        [/can i help you/i],
        () => sawArenaDialog(/i'll be waiting here for you|reward you handsomely/i),
        stop,
        'lady servil 1',
        60,
    );
    await walkWaypoints(s, [{ x: 2613, z: 3190, tol: 0 }], 90, stop, 'servil to arena chest');
    for (let i = 0; i < 12 && (countById(s.sdk.getInventory(), 74) < 1 || countById(s.sdk.getInventory(), 75) < 1) && !stop(); i++) {
        const chest = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.x === 2613 && l.z === 3189 && /chest/i.test(l.name ?? ''));
        if (chest) {
            const op = chest.optionsWithIndex?.find((o: any) => /search|open/i.test(o.text ?? ''))?.opIndex ?? 1;
            await s.sdk.sendInteractLoc(chest.x, chest.z, chest.id, op);
            await waitTicks(s, 2);
            await dismissContinueDialogs(s, stop, 6);
        } else {
            await waitTicks(s, 1);
        }
    }
    for (const gearId of [74, 75]) {
        if (!s.sdk.getEquipment().some(e => e.id === gearId)) {
            const it = s.sdk.getInventory().find(i => i.id === gearId);
            if (!it) throw Error(`missing Khazard guard gear ${gearId}`);
            await s.bot.equipItem(it);
            await waitUntil(s, () => s.sdk.getEquipment().some(e => e.id === gearId) || stop(), { timeoutTicks: 5 });
        }
    }

    // 3. North door -> corridor -> Guard 1 -> West door -> Barman -> West door -> Guard 2 (explicit door 1530 path).
    if ((posOf(s)?.worldZ ?? 0) > 3171) {
        await walkWaypoints(s, [{ x: 2617, z: 3172, tol: 0 }], 60, stop, 'chest to north arena door');
        await passArenaGuardDoor(s, { x: 2617, z: 3171 }, () => (posOf(s)?.worldZ ?? 9999) <= 3171, 'north door', stop);
    }
    for (let i = 0; i < 12 && (posOf(s)?.worldZ ?? 0) > 3151 && !stop(); i++) {
        await s.direct({ type: 'walkTo', x: 2617, z: 3151, running: true, reason: 'SDK' });
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 9999) <= 3151 || stop(), { timeoutTicks: 4 });
    }
    await openShutArenaDoor(s, 2616, 3147, 'guard courtyard north door', stop);
    await walkWaypoints(s, [{ x: 2615, z: 3142, tol: 2 }], 45, stop, 'to drunk guard 1');
    await talkGuardById('guard 1', () => sawArenaDialog(/fall asleep/i));

    await walkWaypoints(s, [{ x: 2610, z: 3143, tol: 1 }], 30, stop, 'to guard west door out');
    await openShutArenaDoor(s, 2609, 3143, 'guard courtyard west door', stop);
    await walkWaypoints(s, [{ x: 2608, z: 3143, tol: 1 }, { x: 2585, z: 3141, tol: 0 }], 60, stop, 'guard to west door');
    await passArenaGuardDoor(s, { x: 2585, z: 3141 }, () => (posOf(s)?.worldX ?? 9999) < 2585, 'west door out', stop);

    await walkWaypoints(s, [{ x: 2567, z: 3141, tol: 2 }], 60, stop, 'to khazard barman');
    await talkAndChoose(
        s,
        /^khazard barman$/i,
        { x: 2566, z: 3140 },
        [/khali brew/i],
        () => countById(s.sdk.getInventory(), 77) >= 1,
        stop,
        'khazard barman',
        45,
    );

    await walkWaypoints(s, [{ x: 2584, z: 3141, tol: 0 }], 60, stop, 'barman back to west door');
    await passArenaGuardDoor(s, { x: 2585, z: 3141 }, () => (posOf(s)?.worldX ?? 0) >= 2585, 'west door in', stop);
    await walkWaypoints(s, [{ x: 2608, z: 3143, tol: 1 }], 60, stop, 'west door to guard courtyard door');
    await openShutArenaDoor(s, 2609, 3143, 'guard courtyard west door return', stop);
    await walkWaypoints(s, [{ x: 2615, z: 3142, tol: 2 }], 30, stop, 'courtyard door to guard 2');
    await talkGuardById('guard 2', () => countById(s.sdk.getInventory(), 76) >= 1, 80);
}

export function shouldEnableRailingProtectMelee(
    pos: { worldZ?: number } | undefined,
    activePrayers: readonly boolean[] | undefined,
): boolean {
    return !!pos && (pos.worldZ ?? 9999) <= RAILING_PROTECT_Z && activePrayers?.[PROTECT_MELEE_INDEX] !== true;
}

async function main(): Promise<void> {
    const bot = process.argv[2] ?? '';
    const capArg = process.argv.slice(3).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? 5000);
    if (!bot) throw Error('usage: attack-specialist.ts <bot> [cap]');
    if (!Number.isSafeInteger(CAP) || CAP < 500 || CAP > 20000) throw Error(`invalid CAP: ${CAP}`);
    const suppliersRaw = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
    const suppliers = suppliersRaw.split(',').map(x => x.trim()).filter(Boolean);
    const supplierName = suppliers[0] ?? '';
    if (!supplierName) throw Error('missing SUPPLIER (or PRACTICE_SUPPLIER) environment variable');
    const tanksRaw = (process.env.PRACTICE_TANKS ?? process.env.TANKS ?? '').trim();
    const tankNames = [...new Set(tanksRaw.split(',').map(x => x.trim()).filter(Boolean))];
    const pvpMode =
        process.env.VARIANT === 'pvp' ||
        process.env.ATTACK_MODE === 'pvp' ||
        tankNames.length > 0;

    const root = resolve(import.meta.dir, '..');
    if (pvpMode) {
        if (tankNames.length === 0) throw Error('Attack PvP mode requires TANKS or PRACTICE_TANKS');
        configureSpecialistGuardEnv();
        const retired = new WeakSet<Session>();
        let ended = false;
        let stopRequested = false;
        const s = await openBot(bot, {
            onStop: async (sess, detail) => {
                if (retired.has(sess)) return;
                stopRequested = true;
                await finish([sess], false, detail);
            },
            onSessionEnd: async (sess, detail) => {
                if (retired.has(sess)) return;
                ended = true;
                await finish([sess], false, detail);
            },
        });
        const serverHost = readServerHost(root, bot);
        if (!serverHost) {
            await finish([s], false, `missing SERVER in bot.env for ${bot}`);
            return;
        }
        const t0 = s.tick();
        const stop: StopFn = () =>
            stopRequested ||
            ended ||
            (!retired.has(s) && s.tick() - t0 >= CAP) ||
            existsSync(join(root, '.practice', `stop-${bot}`)) ||
            (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
        try {
            const res = await runMeleePvpSpecialist(s, {
                botName: bot,
                board: 'attack',
                supplierName,
                tankNames,
                cap: CAP,
                t0,
                stop,
                onRetireSession: sess => retired.add(sess),
            });
            await finish([res.session], true, res.message);
        } catch (e) {
            if (!retired.has(s)) {
                await finish([s], false, String(e));
            } else {
                const errSess = await openBot(bot, { log: () => {} }).catch(() => null);
                await finish(errSess ? [errSess] : [], false, String(e));
            }
        }
        return;
    }

    const s = await openBot(bot);
    const serverHost = readServerHost(root, bot);
    if (!serverHost) {
        await finish([s], false, `missing SERVER in bot.env for ${bot}`);
        return;
    }

    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const t0 = s.tick();
    const elapsed = () => s.tick() - t0;
    const stop: StopFn = () =>
        ended ||
        elapsed() >= CAP ||
        existsSync(join(root, '.practice', `stop-${bot}`)) ||
        (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
    const milestone = (step: string, extra = '') => {
        console.log(`MILESTONE ${step} tick=${elapsed()}${extra ? ' ' + extra : ''}`);
    };

    try {
        milestone('start');
        await leaveRuneStarter(s, stop);
        if (onStarterIsland(posOf(s)) || posOf(s)?.level !== 0) {
            throw Error('still on Tutorial Island after leaveRuneStarter');
        }
        await dropTutorialJunk(s, stop);
        milestone('tutorial');

        await receiveSupplyKit(s, supplierName, stop);
        milestone('kit', `slots=${s.sdk.getInventory().length}`);

        await equipStaffAndBuryBones(s, stop);
        milestone('prayer43', `prayer=${skillInfo(s, 'Prayer').baseLevel}`);

        await trainCourtyardMagicTo25(s, stop);
        milestone('magic25', `magic=${skillInfo(s, 'Magic').baseLevel} air=${countById(s.sdk.getInventory(), 556)} mind=${countById(s.sdk.getInventory(), 558)}`);

        await prepareVampireAndWaterfallInDraynorAndVarrock(s, stop);
        milestone('camelot_almera', `magic=${skillInfo(s, 'Magic').baseLevel} laws=${countById(s.sdk.getInventory(), 563)} coins=${countById(s.sdk.getInventory(), 995)}`);

        await runSpecialistWaterfall(s, stop, {
            extraTombDropIds: [1387, 563, 562, 558],
            skipCwTeleportToTomb: true,
            afterGolrie: async () => {
                milestone('golrie');
                await topUpPrayer(s, 26, stop);
                await walkGolrieToBolren(s, stop);
                await runQuestTree({ session: s, cap: Math.max(200, CAP - elapsed()), stop, burst: true });
                milestone('tree_gnome_village', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

                await exitMazeAndClearArenaGear(s, stop);
                await topUpPrayer(s, 26, stop);
                await runFightArenaThroughKeys(s, stop);
                const prevArenaFrom = process.env.ARENA_FROM;
                process.env.ARENA_FROM = '5';
                try {
                    await runQuestArena({ session: s, cap: Math.max(200, CAP - elapsed()), stop, burst: true });
                } finally {
                    if (prevArenaFrom === undefined) delete process.env.ARENA_FROM;
                    else process.env.ARENA_FROM = prevArenaFrom;
                }
                milestone('fight_arena', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

                // Unequip and drop Fight Arena armour/helmet and TGV gnome amulet before entering Glarial's tomb.
                for (const eq of s.sdk.getEquipment()) {
                    if (eq.id === 74 || eq.id === 75 || eq.id === 589) {
                        await s.bot.unequipItem(eq);
                        await waitUntil(s, () => !s.sdk.getEquipment().some(e => e.id === eq.id) || stop(), { timeoutTicks: 5 });
                    }
                }
                const junkIds = [74, 75, 76, 77, 589];
                for (let i = 0; i < 4 && s.sdk.getInventory().some(it => junkIds.includes(it.id)) && !stop(); i++) {
                    const batch = s.sdk.getInventory().filter(it => junkIds.includes(it.id)).slice(0, 4);
                    await Promise.all(batch.map(it => s.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' })));
                    await waitTicks(s, 1);
                }
                // Walk past Khazard locked building (2567-2569,3237-3239) before Waterfall climbs north to Tomb.
                await setProtectMelee(s, true, stop);
                await walkWaypoints(s, [{ x: 2566, z: 3232, tol: 2 }, { x: 2561, z: 3241, tol: 2 }], 80, stop, 'servil north past khazard building', { ignoreMeleeHunters: true });
                await setProtectMelee(s, false, stop);
            },
        });
        milestone('waterfall', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

        // Re-equip Staff of fire dropped outside Glarial's tomb, then finish Vampire Slayer for 99 Attack.
        if (!s.sdk.getEquipment().some(e => e.id === 1387)) {
            const staff = s.sdk.getInventory().find(i => i.id === 1387);
            if (staff) await s.bot.equipItem(staff);
        }
        await finishVampireSlayer(s, stop);
        milestone('vampire_slayer', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

        if (s.sdk.getState()?.prayers?.activePrayers?.[PROTECT_MELEE_INDEX]) {
            await s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE_INDEX, reason: 'SDK' });
            await waitTicks(s, 1);
        }
        await dismissContinueDialogs(s, stop, 4);
        await s.bot.dismissBlockingUI();

        const atk = skillInfo(s, 'Attack');
        const inv = s.sdk.getInventory();
        const pots = inv.filter(i => PRAYER_POT_IDS.includes(i.id)).length;
        milestone(
            'complete',
            `attack=${atk.baseLevel} xp=${atk.experience} chaosLeft=${countById(inv, 562)} lawsLeft=${countById(inv, 563)} airLeft=${countById(inv, 556)} prayerPots=${pots} lobsters=${countById(inv, 379)}`,
        );
        if (atk.baseLevel < 99) throw Error(`Attack finished at ${atk.baseLevel} (< 99), xp=${atk.experience}`);
        await finish([s], true, `attack=${atk.baseLevel} xp=${atk.experience} ticks=${elapsed()}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

if (import.meta.main) await main();
