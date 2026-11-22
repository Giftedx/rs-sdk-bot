// Run the fresh-clock Attack 99 specialist route from Tutorial Island through Tree Gnome Village, Grand Tree, and Fight Arena.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, openBot } from '../packages/core/src/bot';
import { protectedFromMelee } from '../packages/core/src/danger';
import { withDoorPolicy } from '../packages/core/src/door-policy';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { componentId } from '../packages/core/src/logout';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { applyKnownDoorBlocks, sessionWalker, walkPath } from '../packages/core/src/walk';
import { agilityOptions, runAgility } from './agility-order';
import { runQuestArena } from './generated/quest-arena';
import { runQuestGrandTree } from './generated/quest-grandtree';
import { runQuestTree } from './generated/quest-tree';
import { leaveRuneStarter, onStarterIsland } from './rune-starter';
import {
    ATTACK_SPECIALIST_KIT,
    countById,
    exactNameRe,
    hasAtLeastKit,
    LUMBRIDGE_HANDOFF,
} from '../packages/workers/src/logistics';

const TUTORIAL_KEEP_IDS = new Set([556, 558]); // Tutorial Air and Mind runes stack with the kit.
const PROTECT_MELEE_INDEX = 14;
export const RAILING_PROTECT_Z = 3255;
const AUTO_RETALIATE_OFF_ID = 151;
const PRAYER_POT_IDS = [2434, 139, 141, 143];
const ALLOWED_KIT_IDS = new Set(ATTACK_SPECIALIST_KIT.map(item => item.id));

const SPELLS = {
    windStrike: componentId('magic:wind_strike'),
    fireStrike: componentId('magic:fire_strike'),
    varrockTeleport: componentId('magic:varrock_teleport'),
    camelotTeleport: componentId('magic:camelot_teleport'),
} as const;

type StopFn = () => boolean;
type Point = { x: number; z: number; tol?: number };

function readServerHost(root: string, bot: string): string {
    const raw = readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', bot, 'bot.env'), 'utf8');
    return (raw.match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
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

async function teleportTo45AndCamelot(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 180;
    while (!stop() && skillInfo(s, 'Magic').baseLevel < 45) {
        if (s.tick() >= deadline) throw Error(`Varrock teleport Magic 25->45 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        if (countById(s.sdk.getInventory(), 563) < 1) throw Error('out of Law runes during Varrock teleport');
        const xp0 = skillInfo(s, 'Magic').experience;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.varrockTeleport, reason: 'SDK' });
        const gained = await waitUntil(s, () => skillInfo(s, 'Magic').experience > xp0 || stop(), { timeoutTicks: 5 });
        if (gained && skillInfo(s, 'Magic').experience > xp0 && !stop()) {
            // teleport.rs2 closes dialogs itself and holds player delay across p_delay(1)+p_delay(0).
            await waitTicks(s, 3);
        }
    }
    for (let attempt = 0; attempt < 6 && !stop(); attempt++) {
        const p = posOf(s);
        if (p && p.worldX <= 2800 && p.worldZ >= 3440) return;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.camelotTeleport, reason: 'SDK' });
        await waitUntil(s, () => {
            const cur = posOf(s);
            return (!!cur && cur.worldX <= 2800 && cur.worldZ >= 3440) || stop();
        }, { timeoutTicks: 8 });
    }
    const p = posOf(s);
    if (!p || p.worldX > 2800 || p.worldZ < 3440) {
        throw Error(`Camelot teleport failed at ${p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'}`);
    }
}

export function shouldEnableRailingProtectMelee(
    pos: { worldZ?: number } | undefined,
    activePrayers: readonly boolean[] | undefined,
): boolean {
    return !!pos && (pos.worldZ ?? 9999) <= RAILING_PROTECT_Z && activePrayers?.[PROTECT_MELEE_INDEX] !== true;
}

async function squeezeLooseRailingAndReachBolren(s: Session, stop: StopFn): Promise<void> {
    let prayedAt = -10;
    let drankAt = -10;
    const monitorSouth = () => {
        const st = s.sdk.getState();
        if (shouldEnableRailingProtectMelee(posOf(s), st?.prayers?.activePrayers) && (st?.prayers?.prayerPoints ?? 0) > 0 && s.tick() - prayedAt >= 2) {
            prayedAt = s.tick();
            void s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE_INDEX, reason: 'SDK' });
        }
        if (st?.prayers?.activePrayers?.[PROTECT_MELEE_INDEX] && (st.prayers.prayerPoints ?? 0) <= 8 && s.tick() - drankAt >= 3) {
            const pot = s.sdk.getInventory().find(i => PRAYER_POT_IDS.includes(i.id));
            if (pot) {
                drankAt = s.tick();
                void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
            }
        }
    };
    await walkWaypoints(s, [{ x: 2561, z: 3242, tol: 4 }], 350, stop, 'camelot to khazard edge', {
        ignoreMeleeHunters: true,
        onTickExtra: monitorSouth,
    });
    await setProtectMelee(s, true, stop);
    await walkWaypoints(s, [{ x: 2515, z: 3160, tol: 0 }], 350, stop, 'khazard edge to railing', {
        ignoreMeleeHunters: true,
        onTickExtra: monitorSouth,
    });
    for (let attempt = 0; attempt < 8 && !stop(); attempt++) {
        if ((posOf(s)?.worldZ ?? 0) >= 3161) break;
        await dismissContinueDialogs(s, stop, 1);
        const locs: any[] = s.sdk.getState()?.nearbyLocs ?? [];
        const railing = locs
            .filter(l => (l.id === 2186 || /railing/i.test(l.name ?? '')) && (l.optionsWithIndex ?? []).some((o: any) => /squeeze/i.test(o.text ?? '')))
            .sort((a, b) => d8(a, { x: 2515, z: 3161 }) - d8(b, { x: 2515, z: 3161 }))[0];
        if (!railing) throw Error('loose railing not found at 2515,3161');
        const op = railing.optionsWithIndex.find((o: any) => /squeeze/i.test(o.text ?? ''));
        await s.sdk.sendInteractLoc(railing.x, railing.z, railing.id, op?.opIndex ?? 1);
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3161 || stop(), { timeoutTicks: 8 });
    }
    if ((posOf(s)?.worldZ ?? 0) < 3161) throw Error('failed to squeeze through loose railing');
    await setProtectMelee(s, false, stop);
    await topUpPrayer(s, 26, stop);
    await walkWaypoints(
        s,
        [
            { x: 2529, z: 3165, tol: 2 },
            { x: 2542, z: 3171, tol: 1 },
        ],
        120,
        stop,
        'railing to bolren',
    );
}

async function rideSpiritTree(s: Session, treeTile: Point, choices: RegExp[], dest: Point, stop: StopFn): Promise<void> {
    if (d8({ x: posOf(s)?.worldX ?? 0, z: posOf(s)?.worldZ ?? 0 }, treeTile) > 4) {
        await walkWaypoints(s, [{ x: treeTile.x, z: treeTile.z + 2, tol: 2 }], 80, stop, `approach spirit tree ${treeTile.x},${treeTile.z}`);
    }
    const deadline = s.tick() + 80;
    let interactedAt = -10;
    while (!stop()) {
        const p = posOf(s);
        if (p && d8({ x: p.worldX, z: p.worldZ }, dest) <= 8) return;
        if (s.tick() >= deadline) throw Error(`spirit tree travel to ${dest.x},${dest.z} timed out`);
        const d: any = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) {
                const opts: any[] = d.options ?? [];
                const pick = opts.find(o => choices.some(re => re.test(o.text ?? '')));
                await s.sdk.sendClickDialog(pick ? pick.index : 0);
            }
        } else if (s.tick() - interactedAt >= 4) {
            const tree = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter((l: any) => /spirit tree/i.test(l.name ?? ''))
                .sort((a: any, b: any) => d8(a, treeTile) - d8(b, treeTile))[0];
            if (!tree) throw Error(`Spirit tree not visible near ${treeTile.x},${treeTile.z}`);
            const op = (tree.optionsWithIndex ?? [])[0];
            interactedAt = s.tick();
            await s.sdk.sendInteractLoc(tree.x, tree.z, tree.id, op?.opIndex ?? 1);
        }
        await waitTicks(s, 1);
    }
}

async function travelCourseToNarnode(s: Session, stop: StopFn): Promise<void> {
    const settleDeadline = s.tick() + 60;
    while (!stop() && (posOf(s)?.level ?? 0) > 0) {
        if (s.tick() >= settleDeadline) throw Error(`failed to descend from Gnome Agility level ${posOf(s)?.level}`);
        await dismissContinueDialogs(s, stop, 1);
        const p = posOf(s);
        if (!p) { await waitTicks(s, 1); continue; }
        if (p.level === 1) {
            const branch = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2313);
            if (branch) await s.sdk.sendInteractLoc(branch.x, branch.z, branch.id, 1);
            await waitUntil(s, () => (posOf(s)?.level ?? 1) !== 1 || stop(), { timeoutTicks: 10 });
        } else if (p.level === 2 && p.worldX < 2483) {
            const rope = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2312);
            if (rope) await s.sdk.sendInteractLoc(rope.x, rope.z, rope.id, 1);
            await waitUntil(s, () => (posOf(s)?.worldX ?? 0) >= 2483 || (posOf(s)?.level ?? 2) !== 2 || stop(), { timeoutTicks: 12 });
        } else {
            const treeDown = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => l.id === 2314);
            if (treeDown) await s.sdk.sendInteractLoc(treeDown.x, treeDown.z, treeDown.id, 1);
            await waitUntil(s, () => (posOf(s)?.level ?? 2) === 0 || stop(), { timeoutTicks: 10 });
        }
    }
    const p0 = posOf(s);
    if (p0 && p0.level === 0 && p0.worldX >= 2482 && p0.worldX <= 2489 && p0.worldZ >= 3426 && p0.worldZ <= 3431) {
        const pipe = (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => (l.id === 154 || l.id === 4058) && l.z === 3431);
        if (pipe) {
            await s.sdk.sendInteractLoc(pipe.x, pipe.z, pipe.id, 1);
            await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3436 || stop(), { timeoutTicks: 12 });
        }
    }
    if ((posOf(s)?.worldZ ?? 0) < 3493) {
        await walkWaypoints(s, [{ x: 2465, z: 3490, tol: 1 }], 80, stop, 'agility course to grand tree door');
        const doorDeadline = s.tick() + 30;
        while (!stop() && (posOf(s)?.worldZ ?? 0) < 3493) {
            if (s.tick() >= doorDeadline) throw Error('failed to enter Grand Tree south door');
            const door = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter((l: any) => /tree door/i.test(l.name ?? '') && d8(l, { x: 2465, z: 3492 }) <= 2)
                .sort((a: any, b: any) => d8(a, { x: 2465, z: 3492 }) - d8(b, { x: 2465, z: 3492 }))[0];
            if (door) {
                const op = (door.optionsWithIndex ?? []).find((o: any) => /open/i.test(o.text ?? ''));
                if (op) await s.sdk.sendInteractLoc(door.x, door.z, door.id, op.opIndex);
            }
            await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3493 || stop(), { timeoutTicks: 6 });
        }
    }
}

async function exitGrandTreeAndTravelToServil(s: Session, stop: StopFn): Promise<void> {
    if ((posOf(s)?.worldZ ?? 0) > 6400) {
        const upDeadline = s.tick() + 60;
        while (!stop() && (posOf(s)?.worldZ ?? 0) > 6400) {
            if (s.tick() >= upDeadline) throw Error('failed to climb Grand Tree root exit ladder');
            const p = posOf(s);
            if (!p || d8({ x: p.worldX, z: p.worldZ }, { x: 2464, z: 9897 }) > 3) {
                await walkWaypoints(s, [{ x: 2464, z: 9897, tol: 1 }], 50, stop, 'roots to exit ladder');
            }
            const ladder = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter((l: any) => /ladder/i.test(l.name ?? '') && (l.optionsWithIndex ?? []).some((o: any) => /climb/i.test(o.text ?? '')))
                .sort((a: any, b: any) => d8(a, { x: 2463, z: 9897 }) - d8(b, { x: 2463, z: 9897 }))[0];
            if (!ladder) throw Error('Grand Tree root exit ladder not found near 2463,9897');
            const op = ladder.optionsWithIndex.find((o: any) => /climb/i.test(o.text ?? ''));
            await s.sdk.sendInteractLoc(ladder.x, ladder.z, ladder.id, op?.opIndex ?? 1);
            await waitUntil(s, () => (posOf(s)?.worldZ ?? 9999) < 6400 || stop(), { timeoutTicks: 8 });
        }
    }

    const inTrunk = (p?: { worldX: number; worldZ: number; level: number }) =>
        !!p && p.level === 0 && p.worldX >= 2463 && p.worldX <= 2468 && p.worldZ >= 3493 && p.worldZ <= 3498;
    if (inTrunk(posOf(s))) {
        // Grand Tree trunk has a trapdoor at 2463,3497 that walkPath mistakes for a closed door; step directly through the south tree door.
        for (let i = 0; i < 6 && !stop(); i++) {
            const p = posOf(s);
            if (!p || d8({ x: p.worldX, z: p.worldZ }, { x: 2465, z: 3493 }) <= 1) break;
            await s.direct({ type: 'walkTo', x: 2465, z: 3493, running: true, reason: 'SDK' });
            await waitTicks(s, 2);
        }
        const doorDeadline = s.tick() + 40;
        while (!stop() && (posOf(s)?.worldZ ?? 9999) > 3491) {
            if (s.tick() >= doorDeadline) throw Error('failed to exit Grand Tree south door');
            const door = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter((l: any) => /tree door/i.test(l.name ?? '') && d8(l, { x: 2465, z: 3492 }) <= 2)
                .sort((a: any, b: any) => d8(a, { x: 2465, z: 3492 }) - d8(b, { x: 2465, z: 3492 }))[0];
            if (door) {
                const op = (door.optionsWithIndex ?? []).find((o: any) => /open/i.test(o.text ?? ''));
                if (op) await s.sdk.sendInteractLoc(door.x, door.z, door.id, op.opIndex);
            } else {
                await s.direct({ type: 'walkTo', x: 2465, z: 3488, running: true, reason: 'SDK' });
            }
            await waitUntil(s, () => (posOf(s)?.worldZ ?? 9999) <= 3491 || stop(), { timeoutTicks: 6 });
        }
    }

    await walkWaypoints(s, [{ x: 2461, z: 3446, tol: 2 }], 120, stop, 'grand tree to stronghold tree');
    await rideSpiritTree(s, { x: 2461, z: 3444 }, [/where can i go/i, /battlefield of khazard/i], { x: 2555, z: 3259 }, stop);
    // Avoid the locked Khazard building door at 2567-2569,3237-3239 when walking south to Lady Servil.
    await walkWaypoints(
        s,
        [
            { x: 2561, z: 3241, tol: 2 },
            { x: 2566, z: 3232, tol: 2 },
            { x: 2566, z: 3201, tol: 2 },
        ],
        150,
        stop,
        'khazard battlefield to servil',
    );
}

async function main(): Promise<void> {
    const bot = process.argv[2] ?? '';
    const capArg = process.argv.slice(3).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? 5000);
    if (!bot) throw Error('usage: attack-specialist.ts <bot> [cap]');
    if (!Number.isSafeInteger(CAP) || CAP < 500 || CAP > 20000) throw Error(`invalid CAP: ${CAP}`);
    const supplierName = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
    if (!supplierName) throw Error('missing SUPPLIER (or PRACTICE_SUPPLIER) environment variable');

    const root = resolve(import.meta.dir, '..');
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

        await teleportTo45AndCamelot(s, stop);
        milestone('camelot', `magic=${skillInfo(s, 'Magic').baseLevel} laws=${countById(s.sdk.getInventory(), 563)}`);

        await squeezeLooseRailingAndReachBolren(s, stop);
        milestone('bolren');

        await runQuestTree({ session: s, cap: Math.max(200, CAP - elapsed()), stop, burst: true });
        milestone('tree_gnome_village', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

        await rideSpiritTree(s, { x: 2542, z: 3169 }, [/where can i go/i, /gnome stronghold/i], { x: 2461, z: 3444 }, stop);
        milestone('stronghold_tree');

        const agility = await runAgility(s, agilityOptions('gnome', '25', { ...process.env, CAP: String(Math.max(200, CAP - elapsed())) }));
        if (!agility.ok || skillInfo(s, 'Agility').baseLevel < 25) {
            throw Error(`Gnome agility 1->25 incomplete: ${JSON.stringify(agility)}`);
        }
        milestone('agility25', `agility=${skillInfo(s, 'Agility').baseLevel}`);

        await travelCourseToNarnode(s, stop);
        await topUpPrayer(s, 26, stop);
        await runQuestGrandTree({ session: s, cap: Math.max(200, CAP - elapsed()), stop, burst: true });
        milestone('grand_tree', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

        await exitGrandTreeAndTravelToServil(s, stop);
        await topUpPrayer(s, 26, stop);
        milestone('servil');

        await runQuestArena({ session: s, cap: Math.max(200, CAP - elapsed()), stop, burst: true });
        milestone('fight_arena', `attack=${skillInfo(s, 'Attack').baseLevel} xp=${skillInfo(s, 'Attack').experience}`);

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
