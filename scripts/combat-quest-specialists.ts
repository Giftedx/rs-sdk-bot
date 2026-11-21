// Shared specialist combat-quest kits, navigation, supplier/tank companion helpers, and PvP training loops.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, awaitBotReady, botWork, closeWithin, finish, getWorld, logoutSession, openBot } from '../packages/core/src/bot';
import { protectedFromMelee } from '../packages/core/src/danger';
import { withDoorPolicy } from '../packages/core/src/door-policy';
import { connectInProcess, type Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { componentId } from '../packages/core/src/logout';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { createTickRecorder } from '../packages/core/src/tick-record';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { applyKnownDoorBlocks, goTo, sessionWalker, walkPath } from '../packages/core/src/walk';
import { leaveRuneStarter, onStarterIsland } from './rune-starter';

export interface SpecialistBoardTarget {
    readonly board: 'hitpoints' | 'strength' | 'defence';
    readonly liveChampion: string;
    readonly liveTicks: number;
    readonly targetTicks: number;
}

export const SPECIALIST_TARGETS: Readonly<Record<'hitpoints' | 'strength' | 'defence', SpecialistBoardTarget>> = {
    hitpoints: { board: 'hitpoints', liveChampion: 'nickvitalsq', liveTicks: 11343, targetTicks: 11116 },
    strength: { board: 'strength', liveChampion: 'nicksinew', liveTicks: 3288, targetTicks: 3222 },
    defence: { board: 'defence', liveChampion: 'nickbicep', liveTicks: 4323, targetTicks: 4236 },
};

export interface KitSpecItem {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly stackable: boolean;
}

export const DUELING_RING_IDS = [2552, 2554, 2556, 2558, 2560, 2562, 2564, 2566] as const;
export const PRAYER_POT_IDS = [2434, 139, 141, 143] as const;
export const SUPER_ENERGY_IDS = [3016, 3018, 3020, 3022] as const;

export const LUMBRIDGE_HANDOFF = { x: 3222, z: 3222, level: 0 } as const;
export const LUMBRIDGE_STAIRS = { x: 3205, z: 3209, level: 0 } as const;
export const LUMBRIDGE_BANK = { x: 3208, z: 3220, level: 2 } as const;
export const CASTLE_WARS_LAND = { x: 2440, z: 3090, level: 0 } as const;
export const CASTLE_WARS_BANK = { x: 2444, z: 3083, level: 0 } as const;
export const GRAND_TREE_BANK = { x: 2449, z: 3482, level: 1 } as const;
export const ARDY_NORTH_BANK = { x: 2619, z: 3332, level: 0 } as const;
export const ARDY_LEVER = { x: 2561, z: 3311, level: 0 } as const;
export const DESERTED_KEEP = { x: 3154, z: 3924, level: 0 } as const;
export const KEEP_SPECIALIST_POST = { x: 3155, z: 3924, level: 0 } as const;
export const KEEP_LEVER_TILE = { x: 3153, z: 3923, level: 0 } as const;

export function configureSpecialistGuardEnv(): void {
    process.env.FLEE_GUARD = '0';
    process.env.EAT_GUARD = '0';
    process.env.PRAYER_GUARD = '0';
    process.env.DEATH_RECOVERY = '0';
    process.env.VALUE_GUARD = '0';
    process.env.LOOT_WATCH ??= '0';
    process.env.RANDOM_EVENTS ??= '0';
}

export const PROTECT_MELEE_INDEX = 14;
export const INCREDIBLE_REFLEXES_INDEX = 11;
export const ULTIMATE_STRENGTH_INDEX = 10;
export const AUTO_RETALIATE_COMPONENT = 151;

export const BURY_KEEP_IDS_HP = new Set([556, 558]);
export const BURY_KEEP_IDS_MELEE = new Set([556, 557, 555]);

// 28 slots exact: 7 stackables + 4 unnoted immediate quest items + 11 Dragon bones + 6 noted bank supplies.
export const HP_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 556, name: 'Air rune', count: 2500, stackable: true },
    { id: 558, name: 'Mind rune', count: 140, stackable: true },
    { id: 562, name: 'Chaos rune', count: 220, stackable: true },
    { id: 560, name: 'Death rune', count: 220, stackable: true },
    { id: 563, name: 'Law rune', count: 60, stackable: true },
    { id: 555, name: 'Water rune', count: 35, stackable: true },
    { id: 995, name: 'Coins', count: 5000, stackable: true },
    { id: 1387, name: 'Staff of fire', count: 1, stackable: false },
    { id: 1059, name: 'Leather gloves', count: 1, stackable: false },
    { id: 1985, name: 'Cheese', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 1512, name: 'Logs', count: 6, stackable: true },
    { id: 2435, name: 'Prayer potion(4)', count: 18, stackable: true },
    { id: 386, name: 'Shark', count: 20, stackable: true },
    { id: 2358, name: 'Gold bar', count: 1, stackable: true },
    { id: 1760, name: 'Ball of wool', count: 1, stackable: true },
    { id: 2449, name: 'Superantipoison(4)', count: 2, stackable: true },
] as const;

export const HP_ANTIPOISON_ACCEPT_IDS = [176, 175, 2447, 2446, 2449, 2448] as const;

export function countAntipoisonDoses(items: readonly { id: number; baseId?: number; count?: number }[]): number {
    const doseByBase: Readonly<Record<number, number>> = { 2448: 4, 2446: 4, 175: 3, 181: 3, 177: 2, 183: 2, 179: 1, 185: 1 };
    let doses = 0;
    for (const item of items) {
        const base = item.baseId ?? (item.id === 176 ? 175 : item.id === 2447 ? 2446 : item.id === 2449 ? 2448 : item.id);
        doses += (doseByBase[base] ?? 0) * (item.count ?? 0);
    }
    return doses;
}

// 28 slots exact: Waterfall (83 Atk/Str) + 7x Super energy for 100% run + 1-tick Rune 2h relog Keep PvP.
export const MELEE_PVP_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 556, name: 'Air rune', count: 6, stackable: true },
    { id: 557, name: 'Earth rune', count: 6, stackable: true },
    { id: 555, name: 'Water rune', count: 6, stackable: true },
    { id: 1319, name: 'Rune 2h sword', count: 1, stackable: false },
    { id: 1725, name: 'Amulet of strength', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 954, name: 'Rope', count: 1, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 2, stackable: false },
    { id: 385, name: 'Shark', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 7, stackable: false },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
] as const;

export const STRENGTH_SPECIALIST_KIT: readonly KitSpecItem[] = MELEE_PVP_SPECIALIST_KIT;
export const DEFENCE_SPECIALIST_KIT: readonly KitSpecItem[] = MELEE_PVP_SPECIALIST_KIT;

export const KIT_BY_BOARD: Readonly<Record<'hitpoints' | 'strength' | 'defence', readonly KitSpecItem[]>> = {
    hitpoints: HP_SPECIALIST_KIT,
    strength: STRENGTH_SPECIALIST_KIT,
    defence: DEFENCE_SPECIALIST_KIT,
};

export const SPELLS = {
    windStrike: componentId('magic:wind_strike'),
    fireStrike: componentId('magic:fire_strike'),
    enchantLvl1: componentId('magic:enchant_lvl1'),
    enchantLvl2: componentId('magic:enchant_lvl2'),
    enchantLvl4: componentId('magic:enchant_lvl4'),
    enchantLvl5: componentId('magic:enchant_lvl5'),
    varrockTeleport: componentId('magic:varrock_teleport'),
    faladorTeleport: componentId('magic:falador_teleport'),
    camelotTeleport: componentId('magic:camelot_teleport'),
    charge: componentId('magic:charge'),
    flamesOfZamorak: componentId('magic:flames_of_zamorak'),
} as const;

export type StopFn = () => boolean;
export type Point = { x: number; z: number; tol?: number };

export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactNameRe = (name: string): RegExp => new RegExp('^' + escapeRe(name) + '$', 'i');

export function kitSlotTotal(kit: readonly KitSpecItem[]): number {
    return kit.reduce((sum, item) => sum + (item.stackable ? 1 : item.count), 0);
}

export function kitRequirements(kit: readonly KitSpecItem[]) {
    return [...kit].sort((a, b) => a.id - b.id).map(item => ({ item: item.name, count: item.count, itemId: item.id }));
}

export function countById(items: readonly { id: number; baseId?: number; count?: number }[], id: number): number {
    let total = 0;
    for (const item of items) {
        if ((item.baseId ?? item.id) === id || item.id === id) total += item.count ?? 0;
    }
    return total;
}

export function hasAtLeastKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[]): boolean {
    return kit.every(spec => countById(items, spec.id) >= spec.count);
}

export function hasExactKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[]): boolean {
    const allowed = new Set(kit.map(k => k.id));
    if (items.some(i => !allowed.has(i.id) && !allowed.has(i.baseId ?? i.id))) return false;
    return kit.every(spec => countById(items, spec.id) === spec.count);
}

export function assertNonReservedAccount(name: string, label = 'account'): string {
    if (!name || !/^[A-Za-z0-9_ -]{1,12}$/.test(name)) throw Error(`combat-specialists: invalid ${label}: ${name}`);
    if (RESERVED_ACCOUNTS.includes(name.toLowerCase())) throw Error(`combat-specialists: refuses reserved ${label}: ${name}`);
    return name;
}

export function readServerHost(root: string, bot: string): string {
    const raw = readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', bot, 'bot.env'), 'utf8');
    return (raw.match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
}

export function posOf(s: Session) {
    return s.sdk.getState()?.player as { worldX: number; worldZ: number; level: number; hp?: number; isDead?: boolean } | undefined;
}

export function d8(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

export function skillInfo(s: Session, name: string): { level: number; baseLevel: number; experience: number } {
    const sk = s.sdk.getSkill(name) as { level?: number; baseLevel?: number; experience?: number } | undefined;
    return {
        level: sk?.level ?? 1,
        baseLevel: sk?.baseLevel ?? sk?.level ?? 1,
        experience: sk?.experience ?? 0,
    };
}

export function activeContinueDialog(s: Session): boolean {
    const d: any = s.sdk.getDialog();
    if (!d?.isOpen || d.isWaiting) return false;
    const opts: any[] = d.options ?? [];
    return opts.length === 0 || opts.every(o => /click here to continue/i.test(o.text ?? ''));
}

export async function dismissContinueDialogs(s: Session, stop: StopFn, maxTicks = 8): Promise<void> {
    for (let i = 0; i < maxTicks && !stop(); i++) {
        const d: any = s.sdk.getDialog();
        if (!d?.isOpen) return;
        if (!d.isWaiting && activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
        await waitTicks(s, 1);
    }
}

export async function walkWaypoints(
    s: Session,
    pts: Point[],
    maxTicks: number,
    stop: StopFn,
    label: string,
    opts: { ignoreMeleeHunters?: boolean; onTickExtra?: () => void; look?: number } = {},
): Promise<void> {
    const walker = await sessionWalker(s);
    if (opts.ignoreMeleeHunters) {
        const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
        const grid = await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
        const { withDanger } = await import('../packages/core/src/danger');
        const basePlan = walker.plan;
        const baseHunters = walker.hunters;
        walker.hunters = () => (protectedFromMelee(s.sdk.getState()) ? [] : (baseHunters?.() ?? []));
        walker.plan = (level, from, to, avoid) => {
            const pfm = protectedFromMelee(s.sdk.getState());
            if (!pfm) return basePlan(level, from, to, avoid);
            pf.initPathfinding();
            const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map(b =>
                b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b,
            );
            const find = () =>
                withDoorPolicy(grid, blocks, () =>
                    pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, (s.sdk as any).temporaryDoorBlocks?.active?.() ?? []),
                );
            return avoid?.length ? withDanger(grid, avoid.map(t => ({ ...t, level })), [{ ...from, level }, { ...to, level }], find, 'live') : find();
        };
    }
    const offDialog = s.onTick(() => {
        if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
        opts.onTickExtra?.();
    });
    try {
        const r = await walkPath(walker, pts, { maxTicks, stop, look: opts.look ?? 20 });
        if (!r.ok) throw Error(`walk failed (${label}): ${r.detail ?? JSON.stringify(r)}`);
    } finally {
        offDialog();
    }
}

export async function mazeWalkWaypoints(
    s: Session,
    pts: Point[],
    maxTicks: number,
    stop: StopFn,
    label: string,
): Promise<void> {
    const walker = await sessionWalker(s);
    const pf: any = await import('../vendor/rs-sdk/sdk/pathfinding');
    const grid = await import('../vendor/rs-sdk/server/vendor/rsmod-pathfinder');
    const mazeWalker: typeof walker = {
        ...walker,
        hunters: () => [],
        plan: (level, from, to) => {
            pf.initPathfinding();
            const blocks = applyKnownDoorBlocks(s.sdk, level, from, to).map((b: any) =>
                b.whenAxis === undefined ? { ...b, ...pf.getDoorAt(b.level, b.x, b.z) } : b,
            );
            return withDoorPolicy(grid, blocks, () =>
                pf.findLongPath(level, from.x, from.z, to.x, to.z, 500, (s.sdk as any).temporaryDoorBlocks?.active?.() ?? []),
            );
        },
    };
    const offDialog = s.onTick(() => {
        if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
    });
    try {
        const r = await walkPath(mazeWalker, pts, { maxTicks, stop, look: 4, reclickAt: 2 });
        if (!r.ok) throw Error(`walk failed (${label}): ${r.detail ?? JSON.stringify(r)}`);
    } finally {
        offDialog();
    }
}

export async function moveToTile(
    s: Session,
    to: { x: number; z: number; level: number },
    tol: number,
    stop: StopFn,
    label = `${to.x},${to.z},${to.level}`,
): Promise<void> {
    const near = () => {
        const p = posOf(s);
        return !!p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= tol;
    };
    if (near()) return;
    const p = posOf(s);
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 32) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol }], { maxTicks: 120, stop });
        if (r.ok && near()) return;
    }
    const world = await getWorld();
    const r = await goTo(s, world, to, accountOf(s), { legTimeoutTicks: 240 });
    if (!r.ok || !near()) throw Error(`moveToTile(${label}) failed: ${r.ok ? 'not at destination' : r.detail}`);
}

export async function setAutoRetaliate(s: Session, want: boolean): Promise<void> {
    if (s.sdk.getState()?.autoRetaliateEnabled === want) return;
    await s.direct({ type: 'clickComponent', componentId: AUTO_RETALIATE_COMPONENT, reason: 'SDK' });
    await waitUntil(s, () => s.sdk.getState()?.autoRetaliateEnabled === want, { timeoutTicks: 5 });
}

export async function setPrayerState(s: Session, prayerIndex: number, on: boolean, stop: StopFn): Promise<void> {
    const isOn = () => !!s.sdk.getState()?.prayers?.activePrayers?.[prayerIndex];
    if (isOn() === on) return;
    if (on && (s.sdk.getState()?.prayers?.prayerPoints ?? 0) <= 0) return;
    for (let i = 0; i < 4 && !stop() && isOn() !== on; i++) {
        await s.direct({ type: 'togglePrayer', prayerIndex, reason: 'SDK' });
        if (await waitUntil(s, () => isOn() === on || stop(), { timeoutTicks: 3 })) return;
    }
}

export async function startAndExitTutorial(s: Session, keepIds: ReadonlySet<number>, stop: StopFn): Promise<void> {
    await leaveRuneStarter(s, stop);
    if (onStarterIsland(posOf(s)) || posOf(s)?.level !== 0) {
        throw Error('still on Tutorial Island after leaveRuneStarter');
    }
    const deadline = s.tick() + 45;
    while (!stop()) {
        const junk = s.sdk.getInventory().filter(i => !keepIds.has(i.id));
        if (junk.length === 0) return;
        if (s.tick() >= deadline) throw Error(`failed to drop starter items: ${junk.map(i => i.id).join(',')}`);
        await dismissContinueDialogs(s, stop, 2);
        const batch = junk.slice(0, 5);
        await Promise.all(batch.map(i => s.direct({ type: 'dropItem', slot: i.slot, reason: 'SDK' })));
        await waitTicks(s, 1);
    }
}

export interface ReceiveSupplyKitOpts {
    altSlots?: ReadonlyMap<number, { allowedIds: readonly number[]; satisfied: (items: readonly { id: number; baseId?: number; count?: number }[]) => boolean }>;
    skipWalk?: boolean;
    timeoutTicks?: number;
}

export async function receiveSupplyKit(
    s: Session,
    supplierName: string,
    kit: readonly KitSpecItem[],
    stop: StopFn,
    opts: ReceiveSupplyKitOpts = {},
): Promise<void> {
    if (!opts.skipWalk) {
        const p0 = posOf(s);
        if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, LUMBRIDGE_HANDOFF) > 2) {
            await walkWaypoints(s, [{ ...LUMBRIDGE_HANDOFF, tol: 2 }], 80, stop, 'lumbridge handoff');
        }
    }
    const peerRe = exactNameRe(supplierName);
    const allowed = new Set(kit.map(k => k.id));
    for (const alt of opts.altSlots?.values() ?? []) {
        for (const id of alt.allowedIds) allowed.add(id);
    }
    const satisfied = (items: readonly { id: number; baseId?: number; count?: number }[]) =>
        kit.every(k => {
            const alt = opts.altSlots?.get(k.id);
            return alt ? alt.satisfied(items) : countById(items, k.id) >= k.count;
        });
    const offerSatisfied = (offer: readonly { id: number; baseId?: number; count?: number }[]) =>
        offer.every(o => allowed.has(o.id)) &&
        kit.every(k => {
            const alt = opts.altSlots?.get(k.id);
            return alt ? alt.satisfied(offer) : countById(offer, k.id) === k.count;
        });
    const deadline = s.tick() + (opts.timeoutTicks ?? 180);
    while (!stop() && !satisfied(s.sdk.getInventory())) {
        if (s.tick() >= deadline) throw Error(`did not receive supply kit from ${supplierName}`);
        await dismissContinueDialogs(s, stop, 2);
        await s.bot.dismissBlockingUI();
        const near = (s.sdk.getState()?.nearbyPlayers ?? []).find((n: any) => peerRe.test(n.name));
        if (!near) {
            await waitTicks(s, 1);
            continue;
        }
        const tr = await s.bot.trade(peerRe, {
            accept: offerSatisfied,
            requestTimeout: opts.timeoutTicks ? 4_000 : 10_000,
            timeout: opts.timeoutTicks ? 6_000 : 45_000,
            retryOnBusy: true,
        });
        if (tr.success) {
            await waitUntil(s, () => satisfied(s.sdk.getInventory()) || stop(), { timeoutTicks: 10 });
            if (satisfied(s.sdk.getInventory())) return;
        }
        await waitTicks(s, 1);
    }
    if (!satisfied(s.sdk.getInventory())) {
        throw Error('stopped waiting for specialist supply kit');
    }
}

export async function equipFirstAvailableId(s: Session, itemIds: readonly number[], stop: StopFn, label?: string): Promise<void> {
    if (s.sdk.getEquipment().some(e => itemIds.includes(e.id))) return;
    const item = itemIds.map(id => s.sdk.getInventory().find(i => i.id === id)).find(Boolean);
    if (!item) throw Error(`missing ${label ?? `item ${itemIds.join('/')}`} to equip`);
    const eq = await s.bot.equipItem(item);
    if (!eq.success && !s.sdk.getEquipment().some(e => e.id === item.id)) {
        throw Error(`failed to equip ${label ?? item.name}: ${eq.message}`);
    }
    if (!await waitUntil(s, () => s.sdk.getEquipment().some(e => e.id === item.id) || stop(), { timeoutTicks: 6 })) {
        throw Error(`equip not observed for ${label ?? item.name}`);
    }
}

export async function equipItemById(s: Session, itemId: number, stop: StopFn, label?: string): Promise<void> {
    return equipFirstAvailableId(s, [itemId], stop, label);
}

export async function buryBonesTo43(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 60;
    while (!stop()) {
        const before = countById(s.sdk.getInventory(), 536);
        if (before === 0) break;
        if (s.tick() >= deadline) throw Error(`stalled burying Dragon bones (${before} remaining)`);
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
    const free = npcs.filter(n => inZoneMob(n) && !n.inCombat && !opts.avoid.has(n.index));
    const preferred = free.find(n => n.index === opts.activeTargetIndex);
    if (preferred) return preferred;
    return free.sort((a, b) => (/^(man|woman)$/i.test(a.name ?? '') ? 0 : 1) - (/^(man|woman)$/i.test(b.name ?? '') ? 0 : 1) || (a.distance ?? 99) - (b.distance ?? 99))[0];
}

export async function trainCourtyardMagicTo25(s: Session, stop: StopFn): Promise<void> {
    await setAutoRetaliate(s, false);
    const inCourtyard = (x: number, z: number) => x >= 3217 && x <= 3225 && z >= 3210 && z <= 3229;
    const inPlaza = (x: number, z: number) => x >= 3228 && x <= 3246 && z >= 3212 && z <= 3232;
    const deadline = s.tick() + 450;
    const avoid = new Map<number, number>();
    let movedEast = false;
    let emptyTicks = 0;
    let activeTarget: number | null = null;
    let lastCastTick = -10;

    while (!stop() && skillInfo(s, 'Magic').baseLevel < 25) {
        if (s.tick() >= deadline) throw Error(`Magic 1->25 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        for (const [idx, exp] of avoid) if (s.tick() >= exp) avoid.delete(idx);

        const st = s.sdk.getState();
        const zoneOk = movedEast ? inPlaza : inCourtyard;
        const engaged = st?.player?.combat?.inCombat && st.player.combat.targetType === 'npc' ? st.player.combat.targetIndex : null;
        const selfSlot = (s.client as any)?.selfSlot;
        const target = pickCourtyardMagicTarget(st?.nearbyNpcs ?? [], {
            selfSlot,
            engagedTargetIndex: engaged,
            activeTargetIndex: activeTarget,
            avoid: new Set(avoid.keys()),
            zoneOk,
        });
        if (!target) {
            emptyTicks++;
            if (!movedEast && emptyTicks >= 8) {
                movedEast = true;
                emptyTicks = 0;
                activeTarget = null;
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
        await dismissContinueDialogs(s, stop, 2);
        if (stop() || skillInfo(s, 'Magic').baseLevel >= 25) break;

        const spell = skillInfo(s, 'Magic').baseLevel < 13 ? SPELLS.windStrike : SPELLS.fireStrike;
        const xp0 = skillInfo(s, 'Magic').experience;
        const castAt = s.tick();
        activeTarget = target.index;
        lastCastTick = castAt;
        await s.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent: spell, reason: 'SDK' });
        const gotXp = await waitUntil(
            s,
            () => stop() || skillInfo(s, 'Magic').baseLevel >= 25 || skillInfo(s, 'Magic').experience > xp0,
            { timeoutTicks: 6 },
        );
        if (skillInfo(s, 'Magic').baseLevel >= 25) break;
        if (!gotXp || skillInfo(s, 'Magic').experience <= xp0) {
            avoid.set(target.index, s.tick() + 25);
            activeTarget = null;
            lastCastTick = -10;
            continue;
        }
        while (!stop() && skillInfo(s, 'Magic').baseLevel < 25 && s.tick() - castAt < 5) {
            if (activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
        }
    }
}

export async function teleportTo45Falador(s: Session, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 220;
    while (!stop() && skillInfo(s, 'Magic').baseLevel < 37) {
        if (s.tick() >= deadline) throw Error(`Varrock teleport Magic 25->37 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        if (countById(s.sdk.getInventory(), 563) < 1) throw Error('out of Law runes during Varrock teleport');
        const xp0 = skillInfo(s, 'Magic').experience;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.varrockTeleport, reason: 'SDK' });
        if (await waitUntil(s, () => skillInfo(s, 'Magic').experience > xp0 || stop(), { timeoutTicks: 5 }) && !stop()) {
            await waitTicks(s, 3);
        }
    }
    while (!stop() && (skillInfo(s, 'Magic').baseLevel < 45 || (posOf(s)?.worldX ?? 9999) > 3010)) {
        if (s.tick() >= deadline) throw Error(`Falador teleport Magic 37->45 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        if (countById(s.sdk.getInventory(), 563) < 1 || countById(s.sdk.getInventory(), 555) < 1) {
            throw Error('out of Law or Water runes during Falador teleport');
        }
        const xp0 = skillInfo(s, 'Magic').experience;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.faladorTeleport, reason: 'SDK' });
        if (await waitUntil(s, () => skillInfo(s, 'Magic').experience > xp0 || stop(), { timeoutTicks: 5 }) && !stop()) {
            await waitTicks(s, 3);
        }
    }
}

export async function rubRingOfDueling(
    s: Session,
    optionRe: RegExp,
    destTile: { x: number; z: number },
    stop: StopFn,
    radius = 8,
): Promise<void> {
    const deadline = s.tick() + 40;
    while (!stop() && s.tick() < deadline) {
        const p = posOf(s);
        if (p && p.level === 0 && d8({ x: p.worldX, z: p.worldZ }, destTile) <= radius) return;
        const d: any = s.sdk.getDialog();
        if (d?.isOpen && !d.isWaiting) {
            const pick = (d.options ?? []).find((o: any) => optionRe.test(o.text ?? ''));
            await s.sdk.sendClickDialog(pick ? pick.index : 0);
            await waitUntil(s, () => {
                const cur = posOf(s);
                return (!!cur && d8({ x: cur.worldX, z: cur.worldZ }, destTile) <= radius) || stop();
            }, { timeoutTicks: 8 });
            continue;
        }
        const ring = s.sdk.getInventory().find(i => (DUELING_RING_IDS as readonly number[]).includes(i.id));
        if (!ring) throw Error('missing Ring of dueling in inventory');
        const rubOp = (ring.optionsWithIndex ?? []).find((o: any) => /rub/i.test(o.text ?? ''))?.opIndex ?? 4;
        await s.direct({ type: 'useInventoryItem', slot: ring.slot, optionIndex: rubOp, reason: 'SDK' });
        await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen || stop(), { timeoutTicks: 5 });
    }
    const p = posOf(s);
    if (!p || d8({ x: p.worldX, z: p.worldZ }, destTile) > radius) {
        throw Error(`Ring of dueling teleport to ${destTile.x},${destTile.z} failed at ${p ? `${p.worldX},${p.worldZ}` : 'unknown'}`);
    }
}

export async function openFreshBank(s: Session, stop: StopFn): Promise<void> {
    let lastMsg = 'unknown';
    for (let attempt = 0; attempt < 5 && !stop(); attempt++) {
        if (s.sdk.getState()?.bank?.isOpen) return;
        await dismissContinueDialogs(s, stop, 3);
        await s.bot.dismissBlockingUI();
        const r = await (s.bot as any).openBank(1500);
        if (r.success || s.sdk.getState()?.bank?.isOpen) {
            if (await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen || stop(), { timeoutTicks: 10 })) {
                return;
            }
        }
        lastMsg = r.message ?? r.reason ?? lastMsg;
        await waitTicks(s, 1);
    }
    if (!s.sdk.getState()?.bank?.isOpen) {
        throw Error(`openBank failed: ${lastMsg}`);
    }
}

export async function depositIds(s: Session, ids: readonly number[], stop: StopFn): Promise<void> {
    const idSet = new Set(ids);
    for (let guard = 0; guard < 30 && !stop(); guard++) {
        const item = s.sdk.getInventory().find(i => idSet.has(i.id));
        if (!item) return;
        const before = s.sdk.getInventory().length;
        const r = await s.bot.depositItem(item, -1);
        if (!r.success) throw Error(`deposit ${item.name} failed: ${r.message ?? r.reason}`);
        await waitUntil(s, () => s.sdk.getInventory().length < before || !s.sdk.getInventory().some(i => i.slot === item.slot && i.id === item.id) || stop(), { timeoutTicks: 8 });
    }
}

export async function withdrawExactCount(s: Session, id: number, count: number, stop: StopFn, label?: string): Promise<void> {
    const row = s.sdk.getState()?.bank?.items.find(i => i.id === id);
    if (!row || row.count < count) {
        throw Error(`missing bank stock for ${label ?? id}: need ${count}, have ${row?.count ?? 0}`);
    }
    const before = countById(s.sdk.getInventory(), id);
    const w = await s.bot.withdrawItem(row, count, { asNote: false });
    if (!w.success || !await waitUntil(s, () => countById(s.sdk.getInventory(), id) >= before + count || stop(), { timeoutTicks: 12 })) {
        throw Error(`withdraw ${label ?? row.name} failed: ${w.message ?? w.reason ?? 'count mismatch'}`);
    }
}

export async function closeBankClean(s: Session, stop: StopFn): Promise<void> {
    if (!s.sdk.getState()?.bank?.isOpen) return;
    await s.bot.closeBank();
    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen || stop(), { timeoutTicks: 8 });
}

export async function pullArdougneLeverToWildy(s: Session, stop: StopFn): Promise<void> {
    const p0 = posOf(s);
    if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, ARDY_LEVER) > 140) {
        await walkWaypoints(s, [{ x: 2660, z: 3405, tol: 3 }], 160, stop, 'walk camelot mid');
        await walkWaypoints(s, [{ x: ARDY_LEVER.x, z: ARDY_LEVER.z, tol: 1 }], 160, stop, 'walk mid to ardougne lever');
    } else {
        await walkWaypoints(s, [{ x: ARDY_LEVER.x, z: ARDY_LEVER.z, tol: 1 }], 200, stop, 'walk to ardougne lever');
    }
    const deadline = s.tick() + 50;
    while (!stop() && s.tick() < deadline) {
        const p = posOf(s);
        if (p && p.worldZ >= 3900) return;
        const d: any = s.sdk.getDialog();
        if (d?.isOpen) {
            if (!d.isWaiting) {
                const opts: any[] = d.options ?? [];
                const pick = opts.find(o => /yes please/i.test(o.text ?? '')) ?? opts.find(o => /brave/i.test(o.text ?? ''));
                await s.sdk.sendClickDialog(pick ? pick.index : 0);
            }
            await waitTicks(s, 1);
            continue;
        }
        const lever = (s.sdk.getState()?.nearbyLocs ?? [])
            .filter((l: any) => l.id === 1814 || (/lever/i.test(l.name ?? '') && d8(l, ARDY_LEVER) <= 2))
            .sort((a: any, b: any) => d8(a, ARDY_LEVER) - d8(b, ARDY_LEVER))[0];
        if (!lever) {
            await waitTicks(s, 1);
            continue;
        }
        const op = (lever.optionsWithIndex ?? [])[0];
        await s.sdk.sendInteractLoc(lever.x, lever.z, lever.id, op?.opIndex ?? 1);
        await waitUntil(s, () => (posOf(s)?.worldZ ?? 0) >= 3900 || !!s.sdk.getDialog()?.isOpen || stop(), { timeoutTicks: 8 });
    }
    if ((posOf(s)?.worldZ ?? 0) < 3900) {
        throw Error('failed to teleport via Ardougne wilderness lever');
    }
}

export function rankKeepRelogTanks<T extends { index: number; name?: string; x?: number; z?: number; worldX?: number; worldZ?: number; hp?: number | null }>(
    players: readonly T[],
    tankNames: readonly string[],
    lastHitSeq?: ReadonlyMap<string, number>,
): T[] {
    const tankRes = tankNames.map(exactNameRe);
    return players
        .filter(p => {
            if (!tankRes.some(re => re.test(p.name ?? ''))) return false;
            const z = p.z ?? p.worldZ ?? 0;
            if (z < 3900) return false;
            if (p.hp !== undefined && p.hp !== null && p.hp <= 0) return false;
            return d8({ x: p.x ?? p.worldX ?? 0, z }, KEEP_SPECIALIST_POST) <= 1;
        })
        .sort((a, b) => {
            const sa = lastHitSeq?.get((a.name ?? '').toLowerCase()) ?? 0;
            const sb = lastHitSeq?.get((b.name ?? '').toLowerCase()) ?? 0;
            if (sa !== sb) return sa - sb;
            const da = d8({ x: a.x ?? a.worldX ?? 0, z: a.z ?? a.worldZ ?? 0 }, KEEP_SPECIALIST_POST);
            const db = d8({ x: b.x ?? b.worldX ?? 0, z: b.z ?? b.worldZ ?? 0 }, KEEP_SPECIALIST_POST);
            return da - db;
        });
}

function readRelogCredentials(root: string, bot: string): { password: string; server: string } {
    const raw = readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', bot, 'bot.env'), 'utf8');
    const password = raw.match(/^PASSWORD=(.*)$/m)?.[1]?.trim() ?? '';
    const server = raw.match(/^SERVER=(.*)$/m)?.[1]?.trim() ?? '';
    if (!password || !server) throw Error(`missing credentials in bots/${bot}/bot.env`);
    return { password, server };
}

export async function connectWithTransientRetry<T>(
    connect: () => Promise<T>,
    isStopped: () => boolean,
    maxAttempts = 8,
    waitRetry: (attempt: number) => Promise<void> = () => Bun.sleep(600),
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await connect();
        } catch (err) {
            const msg = String(err instanceof Error ? err.message : err);
            const retryable = /already logged in|too many incorrect|try again/i.test(msg);
            if (!retryable || attempt + 1 >= maxAttempts || isStopped()) throw err;
            await waitRetry(attempt);
            if (isStopped()) throw err;
        }
    }
}

export async function runWildyPvpRelogLoop(
    initSess: Session,
    opts: {
        botName: string;
        board: 'strength' | 'defence';
        skill: 'Strength' | 'Defence';
        targetLevel: number;
        tankNames: readonly string[];
        setupTicks: number;
        cap: number;
        shouldStop: () => boolean;
        onRetireSession?: (s: Session) => void;
    },
): Promise<{ session: Session; totalTicks: number; swings: number }> {
    const root = resolve(import.meta.dir, '..');
    const creds = readRelogCredentials(root, opts.botName);
    const members = isLocalServer(creds.server) || process.env.NODE_MEMBERS === 'true' ? true : undefined;
    const work = botWork(opts.botName);
    const logoutCom = componentId('logout:try_logout');
    const ultStrCom = componentId('prayer:prayer_ultimatestrength');
    const incRefCom = componentId('prayer:prayer_incrediblereflexes');
    const styleCom = componentId(opts.board === 'strength' ? 'combat_heavysword:heavy1' : 'combat_heavysword:heavy3');

    let totalTicks = opts.setupTicks;
    let swings = 0;
    const lastHitSeq = new Map<string, number>();

    opts.onRetireSession?.(initSess);
    await logoutSession(initSess);
    await closeWithin([initSess], 5000);
    await Bun.sleep(40);
    totalTicks += 1;

    while (!opts.shouldStop() && totalTicks < opts.cap) {
        let sess: Session | undefined;
        let rec: ReturnType<typeof createTickRecorder> = null;
        try {
            sess = await connectWithTransientRetry(
                () => connectInProcess({ name: opts.botName, password: creds.password, server: creds.server, ...(members ? { members } : {}), work }),
                () => opts.shouldStop() || totalTicks >= opts.cap,
            );
            await awaitBotReady(sess, () => {});
            const p0 = posOf(sess);
            if (p0?.isDead) throw Error(`${opts.skill} relog PvP died on entry`);
            sess.lifecycle?.record('ready', `${p0?.worldX ?? 0} ${p0?.worldZ ?? 0} ${p0?.level ?? 0}`);
            rec = createTickRecorder({ account: opts.botName, server: creds.server, script: work.script, argv: work.args, startedAt: Date.now() });
            if (rec && sess.record) sess.record(rec);

            const tick0 = sess.tick();
            const curStat = skillInfo(sess, opts.skill);
            if (curStat.baseLevel >= opts.targetLevel) {
                await logoutSession(sess);
                const doneTick = sess.tick();
                await closeWithin([sess], 5000);
                if (rec) await Promise.race([rec.flushed, Bun.sleep(3000)]);
                totalTicks += Math.max(0, doneTick - tick0) + 1;

                const finalSess = await openBot(opts.botName, { log: () => {} });
                await dismissContinueDialogs(finalSess, () => true, 4);
                return { session: finalSess, totalTicks, swings };
            }

            if (!p0 || p0.worldZ < 3900) {
                if (!p0 || p0.worldZ < 3800) await pullArdougneLeverToWildy(sess, opts.shouldStop);
                await walkWaypoints(sess, [{ ...KEEP_SPECIALIST_POST, tol: 0 }], 30, opts.shouldStop, 'walk keep relog');
            } else if (d8({ x: p0.worldX, z: p0.worldZ }, KEEP_SPECIALIST_POST) > 0) {
                await walkWaypoints(sess, [{ ...KEEP_SPECIALIST_POST, tol: 0 }], 15, opts.shouldStop, 'recenter keep relog');
            }

            if (!sess.sdk.getEquipment().some(e => e.id === 1319)) {
                await equipItemById(sess, 1319, opts.shouldStop, 'Rune 2h sword');
            }

            let target = rankKeepRelogTanks(sess.sdk.getState()?.nearbyPlayers ?? [], opts.tankNames, lastHitSeq)[0];
            if (!target) {
                await waitUntil(
                    sess,
                    st => rankKeepRelogTanks(st?.nearbyPlayers ?? [], opts.tankNames, lastHitSeq).length > 0 || opts.shouldStop(),
                    { timeoutTicks: 40 },
                );
                target = rankKeepRelogTanks(sess.sdk.getState()?.nearbyPlayers ?? [], opts.tankNames, lastHitSeq)[0];
            }
            if (!target) {
                await logoutSession(sess);
                const tOut = sess.tick();
                await closeWithin([sess], 5000);
                if (rec) await Promise.race([rec.flushed, Bun.sleep(3000)]);
                totalTicks += Math.max(0, tOut - tick0) + 1;
                continue;
            }

            const prayPts = sess.sdk.getState()?.prayers?.prayerPoints ?? 0;
            const prayBase = skillInfo(sess, 'Prayer').baseLevel;
            lastHitSeq.set((target.name ?? '').toLowerCase(), swings + 1);
            if (prayPts > 0 && prayBase >= 31) void sess.direct({ type: 'clickComponent', componentId: ultStrCom, reason: 'SDK' });
            if (prayPts > 0 && prayBase >= 34) void sess.direct({ type: 'clickComponent', componentId: incRefCom, reason: 'SDK' });
            void sess.direct({ type: 'clickComponent', componentId: styleCom, reason: 'SDK' });
            void sess.direct({ type: 'interactPlayer', playerIndex: target.index, optionIndex: 2, reason: 'SDK' });
            void sess.direct({ type: 'clickComponent', componentId: logoutCom, reason: 'SDK' });

            const endReason = await Promise.race([
                sess.ended.then(e => e.reason),
                waitTicks(sess, 4).then(() => 'timeout'),
            ]);
            if (endReason === 'timeout') await logoutSession(sess);
            const endTick = sess.tick();
            const deadAfter = posOf(sess)?.isDead === true;
            await closeWithin([sess], 5000);
            if (rec) await Promise.race([rec.flushed, Bun.sleep(3000)]);
            if (deadAfter) throw Error(`${opts.skill} relog PvP died during combat at swing ${swings}`);
            if (endReason !== 'timeout' && endReason !== 'logged-out') {
                throw Error(`${opts.skill} relog PvP unexpected session end: ${endReason}`);
            }
            swings++;
            totalTicks += Math.max(0, endTick - tick0) + 1;

            if (swings % 100 === 0) {
                console.log(`PVP_RELOG_PROGRESS tick=${totalTicks} ${opts.skill}=${curStat.baseLevel} xp=${curStat.experience} swings=${swings}`);
            }
        } catch (err) {
            if (sess) {
                await logoutSession(sess).catch(() => {});
                await closeWithin([sess], 3000).catch(() => {});
            }
            if (rec) await Promise.race([rec.flushed, Bun.sleep(1000)]).catch(() => {});
            throw err;
        }
    }

    throw Error(`${opts.skill} relog PvP stopped/capped at totalTicks=${totalTicks} swings=${swings}`);
}

async function bankAndReturnToKeep(s: Session, stop: StopFn): Promise<void> {
    // Unequip worn Ring of dueling if needed, teleport to Castle Wars Chest, stock 1 Law + Manta rays, Camelot -> Lever.
    const hasInvRing = () => s.sdk.getInventory().some(i => (DUELING_RING_IDS as readonly number[]).includes(i.id));
    if (!hasInvRing()) {
        const wornRing = s.sdk.getEquipment().find(e => (DUELING_RING_IDS as readonly number[]).includes(e.id));
        if (wornRing) {
            await s.bot.unequipItem(wornRing);
            await waitUntil(s, () => hasInvRing() || stop(), { timeoutTicks: 6 });
        }
    }
    await rubRingOfDueling(s, /castle wars/i, CASTLE_WARS_LAND, stop);
    await walkWaypoints(s, [{ x: CASTLE_WARS_BANK.x, z: CASTLE_WARS_BANK.z, tol: 1 }], 40, stop, 'castle wars bank');
    await openFreshBank(s, stop);
    await depositIds(s, [...DUELING_RING_IDS], stop);
    if (!s.sdk.getEquipment().some(e => (DUELING_RING_IDS as readonly number[]).includes(e.id))) {
        await withdrawExactCount(s, 2552, 1, stop, 'Ring of dueling(8)');
    }
    if (countById(s.sdk.getInventory(), 563) < 1) {
        await withdrawExactCount(s, 563, 1, stop, 'Law rune');
    }
    const freeSlots = Math.max(0, 28 - s.sdk.getInventory().length);
    if (freeSlots > 0) await withdrawExactCount(s, 391, freeSlots, stop, 'Manta ray');
    await closeBankClean(s, stop);
    if (s.sdk.getInventory().some(i => i.id === 2552)) {
        await equipItemById(s, 2552, stop, 'Ring of dueling(8)');
    }

    for (let attempt = 0; attempt < 5 && !stop(); attempt++) {
        const p = posOf(s);
        if (p && p.level === 0 && p.worldX <= 2800 && p.worldZ >= 3440) break;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.camelotTeleport, reason: 'SDK' });
        await waitUntil(s, () => {
            const cur = posOf(s);
            return (!!cur && cur.level === 0 && cur.worldX <= 2800 && cur.worldZ >= 3440) || stop();
        }, { timeoutTicks: 8 });
    }
    await pullArdougneLeverToWildy(s, stop);
}

async function pullKeepLeverOutAndRebank(s: Session, stop: StopFn): Promise<boolean> {
    const outLever = (s.sdk.getState()?.nearbyLocs ?? [])
        .filter((l: any) => l.id === 1815 || (/lever/i.test(l.name ?? '') && d8(l, DESERTED_KEEP) <= 3))
        .sort((a: any, b: any) => d8(a, DESERTED_KEEP) - d8(b, DESERTED_KEEP))[0];
    if (!outLever) return false;
    const op = (outLever.optionsWithIndex ?? [])[0];
    await s.sdk.sendInteractLoc(outLever.x, outLever.z, outLever.id, op?.opIndex ?? 1);
    const leftWildy = await waitUntil(s, () => {
        const cur = posOf(s);
        return (!!cur && cur.worldZ < 3800) || stop();
    }, { timeoutTicks: 10 });
    if (!leftWildy || stop() || (posOf(s)?.worldZ ?? 9999) >= 3800) return false;

    await walkWaypoints(s, [{ x: ARDY_NORTH_BANK.x, z: ARDY_NORTH_BANK.z, tol: 1 }], 120, stop, 'ardougne north bank');
    await openFreshBank(s, stop);
    const freeSlots = Math.max(0, 28 - s.sdk.getInventory().length);
    if (freeSlots > 0) await withdrawExactCount(s, 391, freeSlots, stop, 'Manta ray');
    await closeBankClean(s, stop);
    await pullArdougneLeverToWildy(s, stop);
    return true;
}

export async function runCompanionRole(
    s: Session,
    opts: {
        role: 'supplier' | 'supplier-tank' | 'tank';
        specialistName: string;
        board?: 'hitpoints' | 'strength' | 'defence';
        kit?: readonly KitSpecItem[];
        postTileOffsetX?: number;
        stopFile?: string;
        cap: number;
    },
): Promise<{ ok: boolean; detail: string }> {
    const root = resolve(import.meta.dir, '..');
    const serverHost = readServerHost(root, s.name);
    const t0 = s.tick();
    const stop: StopFn = () =>
        s.tick() - t0 >= opts.cap ||
        (!!opts.stopFile && existsSync(resolve(root, opts.stopFile))) ||
        existsSync(join(root, '.practice', `stop-${s.name}`)) ||
        (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));

    await waitUntil(s, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
    await setAutoRetaliate(s, false);

    if (opts.role === 'supplier' || opts.role === 'supplier-tank') {
        const kit = opts.kit!;
        await moveToTile(s, LUMBRIDGE_HANDOFF, 2, stop, 'lumbridge handoff');
        const p = posOf(s)!;
        console.log('COMPANION_READY ' + JSON.stringify({ role: opts.role, name: s.name, at: { x: p.worldX, z: p.worldZ, level: p.level } }));

        const giveList = kit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
        const peerRe = exactNameRe(opts.specialistName);
        let handoffDone = false;
        while (!stop() && !handoffDone) {
            const served = await s.bot.serveTrades({
                from: peerRe,
                give: giveList,
                accept: offer => offer.length === 0,
                maxTrades: 1,
                tradeTimeout: 60_000,
                timeout: 30_000,
                until: stop,
            });
            handoffDone = served.trades.some(t => t.success && kit.every(k => countById(t.gave, k.id) === k.count) && t.received.length === 0);
            if (!handoffDone) await waitTicks(s, 1);
        }
        if (!handoffDone) return { ok: false, detail: `supplier failed handoff to ${opts.specialistName}` };
        console.log('COMPANION_HANDOFF ' + JSON.stringify({ name: s.name, specialist: opts.specialistName, tick: s.tick() - t0 }));
        if (opts.role === 'supplier') {
            return { ok: true, detail: `supplied ${opts.specialistName} in ${s.tick() - t0} ticks` };
        }
        await bankAndReturnToKeep(s, stop);
    } else {
        const p = posOf(s)!;
        console.log('COMPANION_READY ' + JSON.stringify({ role: opts.role, name: s.name, at: { x: p.worldX, z: p.worldZ, level: p.level } }));
    }

    // Specialist stands at (3155,3924); tanks occupy (3154,3924), (3155,3923), and (3154,3923), all d8=1 from specialist.
    const postTile = opts.postTileOffsetX === 0
        ? { x: 3154, z: 3924, level: 0 }
        : opts.postTileOffsetX === 1
            ? { x: 3155, z: 3923, level: 0 }
            : { x: 3154, z: 3923, level: 0 };
    const specialistRe = exactNameRe(opts.specialistName);
    let lastEatTick = -10;
    try {
        while (!stop()) {
            if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
            const p = posOf(s);
            if (!p || p.isDead) {
                await waitTicks(s, 2);
                continue;
            }
            if (p.worldZ < 3800) {
                await setAutoRetaliate(s, false);
                await bankAndReturnToKeep(s, stop);
                continue;
            }
            if (d8({ x: p.worldX, z: p.worldZ }, postTile) > 0) {
                await walkWaypoints(s, [{ x: postTile.x, z: postTile.z, tol: 0 }], 20, stop, 'tank step to post');
            }
            const mantaCount = countById(s.sdk.getInventory(), 391);
            const hp = skillInfo(s, 'Hitpoints').level;
            const otherTanksAtPost = (s.sdk.getState()?.nearbyPlayers ?? []).filter((np: any) =>
                !specialistRe.test(np.name ?? '') &&
                d8({ x: np.x ?? np.worldX ?? 0, z: np.z ?? np.worldZ ?? 0 }, KEEP_SPECIALIST_POST) <= 1 &&
                (np.hp === undefined || np.hp === null || np.hp > 0),
            ).length;
            if (hp > 0 && hp <= 77 && mantaCount > 0 && s.tick() - lastEatTick >= 3) {
                const food = s.sdk.getInventory().find(i => i.id === 391);
                if (food) {
                    lastEatTick = s.tick();
                    await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
                }
            }
            if ((mantaCount <= 10 && otherTanksAtPost >= 2) || (mantaCount <= 5 && otherTanksAtPost >= 1) || mantaCount <= 1) {
                if (await pullKeepLeverOutAndRebank(s, stop)) continue;
            }
            await waitTicks(s, 1);
        }
    } catch (e) {
        if (!stop()) throw e;
    }
    return { ok: true, detail: `tank ${s.name} finished in ${s.tick() - t0} ticks` };
}

function createPfmSustainer(s: Session): (want: boolean) => void {
    let lastPrayDrink = -10;
    return (want: boolean) => {
        const st = s.sdk.getState();
        const pts = st?.prayers?.prayerPoints ?? 0;
        if (want && pts <= 15 && s.tick() - lastPrayDrink >= 3) {
            const pp = s.sdk.getInventory().find(i => (PRAYER_POT_IDS as readonly number[]).includes(i.id));
            if (pp) {
                lastPrayDrink = s.tick();
                void s.direct({ type: 'useInventoryItem', slot: pp.slot, optionIndex: 1, reason: 'SDK' });
            }
        }
        const on = !!st?.prayers?.activePrayers?.[PROTECT_MELEE_INDEX];
        if (want !== on && (!want || pts > 0)) {
            void s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE_INDEX, reason: 'SDK' });
        }
    };
}

export async function runSpecialistWaterfall(
    s: Session,
    stop: StopFn,
    opts: { onEnergy?: () => void } = {},
): Promise<{ attackXp: number; strengthXp: number }> {
    const LOC = {
        raft: { id: 1987, x: 2509, z: 3493 },
        bookcase: { id: 1989, x: 2520, z: 3426 },
        golrieCrate: { id: 1990, x: 2548, z: 9565 },
        golrieGate: { id: 1991, x: 2515, z: 9575 },
        tombstone: { id: 1992, x: 2558, z: 3444 },
        coffin: { id: 1993, x: 2542, z: 9811 },
        chestClosed: 1994,
        chestOpen: 1995,
        chest: { x: 2530, z: 9844 },
        rock: { id: 1996, x: 2512, z: 3468 },
        ledgeDoor: { id: 2010, x: 2511, z: 3464 },
        tree: { id: 2020, x: 2512, z: 3465 },
        barrel: { id: 2022, x: 2512, z: 3463 },
        baxCrate: { id: 1999, x: 2589, z: 9888 },
        giantDoor: { id: 2002, x: 2568, z: 9893 },
        puzzleDoor: { id: 2002, x: 2566, z: 9901 },
        pillar: 2004,
        statue: { id: 2006, x: 2565, z: 9916 },
        chalice: { id: 2014, x: 2603, z: 9910 },
    } as const;
    const ITEM = { book: 292, golrieKey: 293, pebble: 294, amulet: 295, urn: 296, baxKey: 298, rope: 954, scim: 1319, air: 556, earth: 557, water: 555 } as const;
    const RUNES = [ITEM.air, ITEM.earth, ITEM.water] as const;
    const PILLARS: readonly [number, number][] = [[2569, 9910], [2569, 9912], [2569, 9914], [2562, 9910], [2562, 9912], [2562, 9914]];

    await setAutoRetaliate(s, false);
    const inv = () => s.sdk.getInventory();
    const has = (id: number) => countById(inv(), id) > 0;
    const cnt = (id: number) => countById(inv(), id);
    const inBox = (x0: number, z0: number, x1: number, z1: number) => {
        const p = posOf(s);
        return !!p && p.worldX >= x0 && p.worldX <= x1 && p.worldZ >= z0 && p.worldZ <= z1;
    };
    const near = (x: number, z: number, tol: number) => {
        const p = posOf(s);
        return !!p && d8({ x: p.worldX, z: p.worldZ }, { x, z }) <= tol;
    };
    const findLoc = (pred: (l: any) => boolean) =>
        (s.sdk.getState()?.nearbyLocs ?? []).filter(pred).sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99))[0];
    const opIndex = (loc: any, re: RegExp) => loc?.optionsWithIndex?.find((o: any) => re.test(o.text ?? ''))?.opIndex ?? 1;
    const sawMsg = (re: RegExp) => (s.sdk.getState()?.gameMessages ?? []).some((m: any) => re.test(m.text ?? ''));
    const dialogPages: string[] = [];
    const sawDialog = (re: RegExp) => {
        const d: any = s.sdk.getDialog();
        if (d?.isOpen && d.text && dialogPages[dialogPages.length - 1] !== d.text) {
            dialogPages.push(d.text);
            if (dialogPages.length > 200) dialogPages.shift();
        }
        if (dialogPages.some(t => re.test(t))) return true;
        return (s.sdk.getState()?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
    };
    const converse = async (choices: RegExp[], donePred: () => boolean, maxTicks = 45): Promise<boolean> => {
        let lastClick = -10;
        const end = s.tick() + maxTicks;
        while (!stop() && s.tick() < end) {
            opts.onEnergy?.();
            if (donePred()) return true;
            const d: any = s.sdk.getDialog();
            if (d?.isOpen && !d.isWaiting && s.tick() - lastClick >= 1) {
                const optsList: any[] = d.options ?? [];
                const pick = optsList.find(o => choices.some(re => re.test(o.text ?? '')));
                lastClick = s.tick();
                await s.sdk.sendClickDialog(pick ? pick.index : 0);
            }
            await waitTicks(s, 1);
        }
        return donePred();
    };
    const stepAct = async (label: string, act: () => Promise<unknown>, donePred: () => boolean, maxTries = 12, period = 4) => {
        for (let i = 0; i < maxTries && !stop(); i++) {
            if (donePred()) return;
            await act();
            if (await waitUntil(s, () => { opts.onEnergy?.(); return donePred() || stop(); }, { timeoutTicks: period })) return;
        }
        if (!donePred()) throw Error(`fast waterfall stalled at ${label}`);
    };
    const opLoc = async (loc: { id: number; x: number; z: number }, re?: RegExp) => {
        const live = findLoc(l => l.id === loc.id && l.x === loc.x && l.z === loc.z) ?? findLoc(l => l.id === loc.id);
        const target = live ?? loc;
        return s.sdk.sendInteractLoc(target.x, target.z, target.id, re ? opIndex(target, re) : 1);
    };
    const useOnLoc = async (itemId: number, loc: { id: number; x: number; z: number }) => {
        const item = inv().find(i => i.id === itemId);
        if (!item) return;
        const live = findLoc(l => l.id === loc.id && l.x === loc.x && l.z === loc.z) ?? loc;
        return s.sdk.sendUseItemOnLoc(item.slot, live.x, live.z, live.id);
    };
    const walkFast = (pts: Point[], maxTicks: number, label: string, extra?: () => void) =>
        walkWaypoints(s, pts, maxTicks, stop, label, {
            ignoreMeleeHunters: true,
            onTickExtra: () => {
                opts.onEnergy?.();
                extra?.();
            },
        });
    const climb = (label: string, x: number, z: number, dir: RegExp, donePred: () => boolean) =>
        stepAct(label, async () => {
            const l = findLoc(k => Math.max(Math.abs(k.x - x), Math.abs(k.z - z)) <= 3 && (k.optionsWithIndex ?? []).some((o: any) => dir.test(o.text ?? '')));
            if (l) await s.sdk.sendInteractLoc(l.x, l.z, l.id, opIndex(l, dir));
        }, donePred, 10, 4);

    const atk0 = skillInfo(s, 'Attack').experience;
    const str0 = skillInfo(s, 'Strength').experience;

    // 1. Almera -> Raft -> Hudon -> Rock -> Tree -> Barrel -> Hadley bookcase.
    let almeraErr = 'Dialog did not open';
    for (let attempt = 0; attempt < 5 && !s.sdk.getDialog()?.isOpen && !stop(); attempt++) {
        opts.onEnergy?.();
        if (attempt > 0 || !inBox(2520, 3493, 2524, 3497)) {
            await walkFast([{ x: 2522, z: 3494, tol: 1 }], 25, 'to almera');
        }
        const a = s.sdk.findNearbyNpc(/^almera$/i);
        if (a) {
            await s.direct({ type: 'interactNpc', npcIndex: a.index, optionIndex: 1, reason: 'SDK' });
            if (await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen || stop(), { timeoutTicks: 8 })) break;
        }
        const talkAlmera = await s.bot.talkTo(/^almera$/i);
        if (talkAlmera.success || s.sdk.getDialog()?.isOpen) break;
        almeraErr = talkAlmera.message ?? almeraErr;
        await waitTicks(s, 1);
    }
    if (!s.sdk.getDialog()?.isOpen) throw Error(`talk Almera failed: ${almeraErr}`);
    const almeraDone = await converse([/how can i help/i], () => sawDialog(/small raft out back|you are kind/i) && !s.sdk.getDialog()?.isOpen, 40);
    if (!almeraDone) throw Error('Almera dialogue incomplete');

    const onIsland = () => inBox(2510, 3476, 2514, 3481);
    const crossToLedge = async (withHudon: boolean) => {
        await walkFast([{ x: 2511, z: 3494, tol: 1 }], withHudon ? 40 : 120, 'to raft');
        await stepAct('board raft', () => opLoc(LOC.raft), onIsland, 10, 8);
        if (withHudon) {
            const hudonProof = /fine alone|so you're still here|find that treasure soon/i;
            let ok = await converse([], () => sawDialog(hudonProof) && !s.sdk.getDialog()?.isOpen, 24);
            for (let i = 0; i < 2 && !ok && !stop(); i++) {
                await walkFast([{ x: 2512, z: 3481, tol: 0 }], 15, 'to hudon');
                const h = s.sdk.findNearbyNpc(/^hudon$/i);
                if (h) await s.direct({ type: 'interactNpc', npcIndex: h.index, optionIndex: 1, reason: 'SDK' });
                await waitUntil(s, () => !!s.sdk.getDialog()?.isOpen || stop(), { timeoutTicks: 6 });
                ok = await converse([], () => sawDialog(hudonProof) && !s.sdk.getDialog()?.isOpen, 24);
            }
            if (!ok) throw Error('Hudon dialogue incomplete');
        }
        await walkFast([{ x: 2512, z: 3477, tol: 0 }], 20, 'to rock bank');
        await stepAct('rope rock', async () => {
            const roped = findLoc(l => l.id === 1997 && l.x === LOC.rock.x && l.z === LOC.rock.z);
            if (!roped) await useOnLoc(ITEM.rope, LOC.rock);
        }, () => near(LOC.rock.x + 1, LOC.rock.z, 0), 12, 4);
        await waitTicks(s, 1);
        await stepAct('rope tree', () => useOnLoc(ITEM.rope, LOC.tree), () => inBox(2510, 3462, 2513, 3464), 10, 4);
    };

    await crossToLedge(true);
    await stepAct('barrel', () => opLoc(LOC.barrel), () => near(2527, 3413, 4), 10, 4);

    await walkFast([{ x: 2517, z: 3427, tol: 2 }], 40, 'to hadley');
    await climb('hadley up', 2517, 3428, /climb-up/i, () => posOf(s)?.level === 1);
    await stepAct('bookcase', () => opLoc(LOC.bookcase), () => has(ITEM.book), 10, 4);
    const readDone = await stepAct('read book', async () => {
        const b = inv().find(x => x.id === ITEM.book);
        if (b) await s.direct({ type: 'useInventoryItem', slot: b.slot, optionIndex: 1, reason: 'SDK' });
    }, () => sawMsg(/book is old/i), 4, 3).then(() => true).catch(() => false);
    if (!readDone) throw Error('failed reading Book on Baxtorian');
    await s.direct({ type: 'closeModal', reason: 'SDK' });
    await climb('hadley down', 2518, 3429, /climb-down/i, () => posOf(s)?.level === 0);

    // 2. Hadley -> Golrie cellar -> Pebble -> Ring of dueling directly to CW -> Tomb.
    const syncWaterfallPfm = createPfmSustainer(s);
    const khazardPfm = (maxZ: number) => () => {
        const p = posOf(s);
        syncWaterfallPfm(!!p && p.worldZ <= maxZ);
    };
    await walkFast([{ x: 2561, z: 3280, tol: 4 }], 140, 'hadley to khazard border');
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await walkFast([{ x: 2533, z: 3156, tol: 2 }], 220, 'khazard to golrie cellar', () => syncWaterfallPfm(true));

    const inCellar = () => (posOf(s)?.worldZ ?? 0) > 9500 && (posOf(s)?.worldZ ?? 0) < 9600;
    await climb('cellar down', 2533, 3155, /climb-down/i, inCellar);
    await stepAct('golrie crate', () => { syncWaterfallPfm(true); return opLoc(LOC.golrieCrate); }, () => has(ITEM.golrieKey), 25, 4);
    await walkFast([{ x: 2515, z: 9574, tol: 0 }], 90, 'to golrie gate', () => syncWaterfallPfm(true));
    await stepAct('golrie gate', () => { syncWaterfallPfm(true); return useOnLoc(ITEM.golrieKey, LOC.golrieGate); }, () => inBox(2502, 9576, 2523, 9593), 10, 6);
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);

    let golrieShut = 0;
    const gotPebble = () => {
        golrieShut = s.sdk.getDialog()?.isOpen ? 0 : golrieShut + 1;
        return has(ITEM.pebble) && !has(ITEM.golrieKey) && ((sawDialog(/take care golrie/i) && !s.sdk.getDialog()?.isOpen) || golrieShut >= 5);
    };
    await stepAct('talk golrie', async () => {
        const g = s.sdk.findNearbyNpc(/^golrie$/i);
        if (g) await s.direct({ type: 'interactNpc', npcIndex: g.index, optionIndex: 1, reason: 'SDK' });
        await converse([], gotPebble, 30);
    }, gotPebble, 3, 2);

    // Teleport out of Golrie's room straight to Castle Wars, pre-arming PFM so guardWalk skips the Observatory detour.
    await rubRingOfDueling(s, /castle wars/i, CASTLE_WARS_LAND, stop);
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await walkFast([{ x: 2470, z: 3170, tol: 4 }, { x: 2557, z: 3444, tol: 2 }], 300, 'cw to tomb', khazardPfm(3270));
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);

    // 3. Tomb: drop only banned weapons/runes (keep Ring, Amulet, and all potions).
    const wornWeapon = s.sdk.getEquipment().find(e => e.id === ITEM.scim);
    if (wornWeapon) {
        await s.bot.unequipItem(wornWeapon);
        await waitUntil(s, () => has(ITEM.scim) || stop(), { timeoutTicks: 5 });
    }
    const tombDropIds = [...RUNES, ITEM.scim] as const;
    const targetDropCount = new Map(tombDropIds.map(id => [id, id === ITEM.scim ? 1 : 6]));
    for (let i = 0; i < 4 && tombDropIds.some(has) && !stop(); i++) {
        await Promise.all(inv().filter(x => (tombDropIds as readonly number[]).includes(x.id)).map(r => s.direct({ type: 'dropItem', slot: r.slot, reason: 'SDK' })));
        await waitUntil(s, () => !tombDropIds.some(has) || stop(), { timeoutTicks: 2 });
    }
    if (tombDropIds.some(has)) throw Error('failed dropping banned Tomb items');

    const inTomb = () => inBox(2520, 9795, 2560, 9850);
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await stepAct('enter tomb', () => { syncWaterfallPfm(true); return useOnLoc(ITEM.pebble, LOC.tombstone); }, inTomb, 10, 4);
    await walkFast([{ x: 2532, z: 9844, tol: 2 }], 30, 'to tomb chest', () => syncWaterfallPfm(true));
    await stepAct('tomb chest', async () => {
        syncWaterfallPfm(true);
        const shut = findLoc(l => l.id === LOC.chestClosed && l.x === LOC.chest.x && l.z === LOC.chest.z);
        if (shut) {
            await opLoc({ id: shut.id, x: shut.x, z: shut.z }, /open/i);
            await waitUntil(s, () => { syncWaterfallPfm(true); return !!findLoc(l => l.id === LOC.chestOpen && l.x === LOC.chest.x && l.z === LOC.chest.z) || stop(); }, { timeoutTicks: 20 });
        }
        const open = findLoc(l => l.id === LOC.chestOpen && l.x === LOC.chest.x && l.z === LOC.chest.z);
        if (open) await opLoc({ id: open.id, x: open.x, z: open.z }, /search/i);
    }, () => has(ITEM.amulet), 8, 5);
    await walkFast([{ x: 2542, z: 9813, tol: 2 }], 45, 'to tomb coffin', () => syncWaterfallPfm(true));
    await stepAct('tomb coffin', () => { syncWaterfallPfm(true); return opLoc(LOC.coffin); }, () => has(ITEM.urn), 12, 4);
    await walkFast([{ x: 2555, z: 9844, tol: 1 }], 45, 'to tomb ladder', () => syncWaterfallPfm(true));
    await climb('tomb up', 2556, 9844, /climb-up/i, () => (posOf(s)?.worldZ ?? 0) < 4000);
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);

    for (let i = 0; i < 20 && tombDropIds.some(id => cnt(id) < (targetDropCount.get(id) ?? 1)) && !stop(); i++) {
        opts.onEnergy?.();
        const id = tombDropIds.find(r => cnt(r) < (targetDropCount.get(r) ?? 1))!;
        const g = (s.sdk.getState()?.groundItems ?? []).filter((x: any) => x.id === id).sort((a: any, b: any) => (a.distance ?? 99) - (b.distance ?? 99))[0];
        if (g) await s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: id, reason: 'SDK' });
        await waitUntil(s, () => cnt(id) >= (targetDropCount.get(id) ?? 1) || stop(), { timeoutTicks: 3 });
    }
    if (tombDropIds.some(id => cnt(id) < (targetDropCount.get(id) ?? 1))) {
        throw Error(`failed recovering Tomb drops: ${tombDropIds.map(cnt).join('/')}`);
    }

    // 4. Waterfall Dungeon -> Baxtorian key -> Puzzle room -> Pillars -> Statue -> Chalice -> Exit.
    await crossToLedge(false);
    const inFalls = () => inBox(2555, 9860, 2615, 9925);
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await stepAct('ledge door', () => opLoc(LOC.ledgeDoor), inFalls, 10, 4);

    await walkFast([{ x: 2574, z: 9873, tol: 2 }, { x: 2584, z: 9876, tol: 2 }, { x: 2589, z: 9887, tol: 1 }], 60, 'falls crate', () => syncWaterfallPfm(true));
    await stepAct('falls crate', () => { syncWaterfallPfm(true); return opLoc(LOC.baxCrate); }, () => has(ITEM.baxKey), 10, 4);
    await walkFast([{ x: 2584, z: 9876, tol: 2 }, { x: 2569, z: 9876, tol: 2 }, { x: 2564, z: 9880, tol: 0 }], 50, 'double door', () => syncWaterfallPfm(true));

    const doorShut = () => !!findLoc(l => (l.id === 1516 || l.id === 1519) && l.z === 9881 && Math.abs(l.x - 2564.5) <= 1);
    const openDoubleDoor = async () => {
        const d = findLoc(l => (l.id === 1516 || l.id === 1519) && l.z === 9881 && Math.abs(l.x - 2564.5) <= 1);
        if (d) await opLoc({ id: d.id, x: d.x, z: d.z }, /^open$/i);
    };
    await stepAct('open double door', openDoubleDoor, () => !doorShut(), 6, 4);

    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    const pastGiantDoor = () => inBox(2562, 9894, 2572, 9901);
    let lastWalk = -99, keySent = -99;
    for (let i = 0; i < 45 && !pastGiantDoor() && !stop(); i++) {
        opts.onEnergy?.();
        syncWaterfallPfm(true);
        if (near(2568, 9893, 0)) {
            if (s.tick() - keySent >= 3) { keySent = s.tick(); await useOnLoc(ITEM.baxKey, LOC.giantDoor); }
        } else if (lastWalk < 0 || s.tick() - lastWalk >= 3) {
            lastWalk = s.tick();
            const w: any = await s.direct({ type: 'walkTo', x: 2568, z: 9893, running: true, reason: 'SDK' });
            if (w && w.success === false) await openDoubleDoor();
        }
        await waitTicks(s, 1);
    }
    if (!pastGiantDoor()) throw Error('failed crossing giant room');

    await stepAct('puzzle door', () => useOnLoc(ITEM.baxKey, LOC.puzzleDoor), () => inBox(2561, 9902, 2570, 9917), 10, 4);
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);

    // Apply all 18 runes on the exact 2-tick p_delay(0) rhythm without extra waitTicks waste.
    for (const [px, pz] of PILLARS) {
        for (const id of RUNES) {
            const before = cnt(id);
            const sentAt = s.tick();
            await stepAct(`pillar ${px},${pz} ${id}`, () => useOnLoc(id, { id: LOC.pillar, x: px, z: pz }),
                () => cnt(id) < before || sawMsg(/remember putting that type/i), 5, 3);
            while (s.tick() < sentAt + 2 && !stop()) await waitTicks(s, 1);
        }
    }
    if (RUNES.some(has)) throw Error(`runes remained after pillars: ${RUNES.map(cnt).join('/')}`);

    await stepAct('statue', () => useOnLoc(ITEM.amulet, LOC.statue), () => inBox(2598, 9895, 2610, 9920), 10, 4);

    // Ensure 5 free slots before claiming reward from chalice.
    const freeDropIds = [229, ITEM.book, ITEM.pebble];
    for (let i = 0; i < 4 && inv().length > 23 && !stop(); i++) {
        const dropBatch = inv().filter(x => freeDropIds.includes(x.id)).slice(0, 5);
        if (dropBatch.length === 0) break;
        await Promise.all(dropBatch.map(x => s.direct({ type: 'dropItem', slot: x.slot, reason: 'SDK' })));
        await waitTicks(s, 1);
    }
    if (inv().length > 23) throw Error(`needs 5 free slots for Chalice reward, has ${28 - inv().length}`);

    await stepAct('chalice', () => useOnLoc(ITEM.urn, LOC.chalice), () => skillInfo(s, 'Attack').experience - atk0 >= 300_000, 10, 4);

    // Exit raised room & falls to 2527,3413 with PFM back on across the giant rooms.
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, stop);
    await walkFast([{ x: 2604, z: 9901, tol: 1 }], 25, 'raised room exit', () => syncWaterfallPfm(true));
    await stepAct('raised door', () => { syncWaterfallPfm(true); return useOnLoc(ITEM.baxKey, { id: 2002, x: 2604, z: 9900 }); }, () => inBox(2562, 9894, 2572, 9901), 10, 4);
    await stepAct('south giant door', () => { syncWaterfallPfm(true); return useOnLoc(ITEM.baxKey, LOC.giantDoor); }, () => !findLoc(l => l.id === 2002 && l.x === LOC.giantDoor.x && l.z === LOC.giantDoor.z), 10, 4);
    await walkFast([{ x: 2568, z: 9891, tol: 1 }, { x: 2565, z: 9883, tol: 1 }], 45, 'return giant room', () => syncWaterfallPfm(true));
    await stepAct('return double door', openDoubleDoor, () => !doorShut(), 6, 4);
    await walkFast([{ x: 2564, z: 9880, tol: 1 }, { x: 2584, z: 9876, tol: 2 }, { x: 2575, z: 9863, tol: 1 }], 60, 'return ledge exit', () => syncWaterfallPfm(true));
    await stepAct('falls exit', () => opLoc({ id: 2000, x: 2575, z: 9861 }), () => near(2511, 3463, 3), 10, 4);
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, stop);
    await stepAct('return barrel', () => opLoc(LOC.barrel), () => near(2527, 3413, 4), 10, 4);

    return {
        attackXp: skillInfo(s, 'Attack').experience - atk0,
        strengthXp: skillInfo(s, 'Strength').experience - str0,
    };
}

export async function runMeleePvpSpecialist(
    s: Session,
    opts: {
        botName?: string;
        board: 'strength' | 'defence';
        supplierName: string;
        tankNames: readonly string[];
        cap: number;
        t0: number;
        stop: StopFn;
        onRetireSession?: (sess: Session) => void;
        runWaterfallFn?: (o: { session: Session; stop: StopFn; cap: number; food: { id: number; heal: number; count: number; eatAt: number; crossAt: number }; mighty: boolean; exitFalls: boolean; keepAlive: boolean; protectMelee?: boolean; tombHoldIds?: readonly number[]; looseRailing?: boolean; superEnergy?: boolean }) => Promise<unknown>;
    },
): Promise<{ session: Session; message: string }> {
    const skill = opts.board === 'strength' ? 'Strength' : 'Defence';
    const kit = KIT_BY_BOARD[opts.board];
    const target = SPECIALIST_TARGETS[opts.board];
    const elapsed = () => s.tick() - opts.t0;
    const milestone = (step: string, extra = '') => {
        console.log(`MILESTONE ${step} tick=${elapsed()}${extra ? ' ' + extra : ''}`);
    };

    let lastEnergyTick = -10;
    const syncCwPfm = createPfmSustainer(s);
    const ensureRunAndEnergy = () => {
        const p: any = posOf(s);
        const energy = p?.runEnergy ?? 100;
        if (energy <= 78 && s.tick() - lastEnergyTick >= 3) {
            const ep = s.sdk.getInventory().find(i => (SUPER_ENERGY_IDS as readonly number[]).includes(i.id));
            if (ep) {
                lastEnergyTick = s.tick();
                void s.direct({ type: 'useInventoryItem', slot: ep.slot, optionIndex: 1, reason: 'SDK' });
                return;
            }
        }
        const vial = s.sdk.getInventory().find(i => i.id === 229);
        if (vial) void s.direct({ type: 'dropItem', slot: vial.slot, reason: 'SDK' });
    };

    milestone('start');
    await startAndExitTutorial(s, new Set(), opts.stop);
    milestone('tutorial');

    await receiveSupplyKit(s, opts.supplierName, kit, opts.stop);
    milestone('kit', `slots=${s.sdk.getInventory().length}`);

    await equipFirstAvailableId(s, [1725, 1731], opts.stop, 'Amulet of strength/power');
    await buryBonesTo43(s, opts.stop);
    milestone('prayer43', `prayer=${skillInfo(s, 'Prayer').baseLevel}`);

    await rubRingOfDueling(s, /castle wars/i, { x: 2440, z: 3090 }, opts.stop);
    await setPrayerState(s, PROTECT_MELEE_INDEX, true, opts.stop);
    await walkWaypoints(
        s,
        [
            { x: 2470, z: 3170, tol: 4 },
            { x: 2522, z: 3494, tol: 1 },
        ],
        340,
        opts.stop,
        'castle wars to almera',
        {
            ignoreMeleeHunters: true,
            onTickExtra: () => {
                ensureRunAndEnergy();
                const p = posOf(s);
                syncCwPfm(!!p && p.worldZ <= 3265);
            },
        },
    );
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, opts.stop);
    milestone('almera');

    if (opts.runWaterfallFn) {
        await opts.runWaterfallFn({
            session: s,
            stop: opts.stop,
            cap: Math.max(300, opts.cap - elapsed()),
            food: { id: 385, heal: 20, count: 6, eatAt: 8, crossAt: 9 },
            mighty: false,
            exitFalls: true,
            keepAlive: true,
            protectMelee: true,
            tombHoldIds: [1319],
            looseRailing: true,
            superEnergy: true,
        });
    } else {
        await runSpecialistWaterfall(s, opts.stop, { onEnergy: ensureRunAndEnergy });
    }
    await setPrayerState(s, PROTECT_MELEE_INDEX, false, opts.stop);
    milestone('waterfall', `atk=${skillInfo(s, 'Attack').baseLevel} str=${skillInfo(s, 'Strength').baseLevel} at=${posOf(s)?.worldX},${posOf(s)?.worldZ}`);

    // Drop Waterfall rewards and equip Keep melee gear while running to Ardougne lever.
    const postWaterfallJunk = new Set<number>([1601, 2357, 299, 297, 298, 292, 293, 294, 295, 296, 229, 954]);
    let preEquippedWait = -10;
    await walkWaypoints(s, [{ x: ARDY_LEVER.x, z: ARDY_LEVER.z, tol: 1 }], 120, opts.stop, 'waterfall exit to ardougne lever', {
        onTickExtra: () => {
            ensureRunAndEnergy();
            if (s.tick() - preEquippedWait >= 2) {
                const gear = s.sdk.getInventory().find(i => i.id === 1319);
                if (gear) {
                    const wieldOp = (gear.optionsWithIndex ?? []).find((o: any) => /wield|wear|equip/i.test(o.text ?? ''))?.opIndex ?? 2;
                    preEquippedWait = s.tick();
                    void s.direct({ type: 'useInventoryItem', slot: gear.slot, optionIndex: wieldOp, reason: 'SDK' });
                }
            }
            const junk = s.sdk.getInventory().find(i => postWaterfallJunk.has(i.id));
            if (junk) void s.direct({ type: 'dropItem', slot: junk.slot, reason: 'SDK' });
        },
    });
    await pullArdougneLeverToWildy(s, opts.stop);
    milestone('wildy_keep', `at=${posOf(s)?.worldX},${posOf(s)?.worldZ}`);

    await walkWaypoints(s, [{ ...KEEP_SPECIALIST_POST, tol: 0 }], 30, opts.stop, 'step to keep post');
    await setAutoRetaliate(s, false);
    await equipItemById(s, 1319, opts.stop, 'Rune 2h sword');
    await equipFirstAvailableId(s, [1725, 1731], opts.stop, 'Amulet of strength/power');

    const { session: finalSess, totalTicks } = await runWildyPvpRelogLoop(s, {
        botName: opts.botName ?? s.name,
        board: opts.board,
        skill,
        targetLevel: 99,
        tankNames: opts.tankNames,
        setupTicks: elapsed(),
        cap: opts.cap,
        shouldStop: opts.stop,
        onRetireSession: opts.onRetireSession,
    });

    try {
        await finalSess.bot.dismissBlockingUI();
        const sk = skillInfo(finalSess, skill);
        console.log(`MILESTONE complete tick=${totalTicks} ${opts.board}=${sk.baseLevel} xp=${sk.experience} targetTicks=${target.targetTicks}`);
        if (sk.baseLevel < 99) throw Error(`${skill} finished at ${sk.baseLevel} (< 99), xp=${sk.experience}`);
        return {
            session: finalSess,
            message: `${opts.board}=${sk.baseLevel} xp=${sk.experience} ticks=${totalTicks} liveTarget=${target.targetTicks}`,
        };
    } catch (err) {
        await logoutSession(finalSess).catch(() => {});
        await closeWithin([finalSess], 3000).catch(() => {});
        throw err;
    }
}

async function trainMagicToLevel(s: Session, targetLevel: number, stop: StopFn): Promise<void> {
    await setAutoRetaliate(s, false);
    const inCourtyard = (x: number, z: number) => x >= 3217 && x <= 3225 && z >= 3210 && z <= 3229;
    const deadline = s.tick() + 180;
    const avoid = new Map<number, number>();
    let activeTarget: number | null = null;
    let lastCastTick = -10;
    while (!stop() && skillInfo(s, 'Magic').baseLevel < targetLevel) {
        if (s.tick() >= deadline) throw Error(`Magic 1->${targetLevel} timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        for (const [idx, exp] of avoid) if (s.tick() >= exp) avoid.delete(idx);
        const st = s.sdk.getState();
        const engaged = st?.player?.combat?.inCombat && st.player.combat.targetType === 'npc' ? st.player.combat.targetIndex : null;
        const selfSlot = (s.client as any)?.selfSlot;
        const target = pickCourtyardMagicTarget(st?.nearbyNpcs ?? [], {
            selfSlot,
            engagedTargetIndex: engaged,
            activeTargetIndex: activeTarget,
            avoid: new Set(avoid.keys()),
            zoneOk: inCourtyard,
        });
        if (!target || s.tick() - lastCastTick < 5) {
            await waitTicks(s, 1);
            continue;
        }
        await dismissContinueDialogs(s, stop, 2);
        if (stop() || skillInfo(s, 'Magic').baseLevel >= targetLevel) break;
        const xp0 = skillInfo(s, 'Magic').experience;
        const castAt = s.tick();
        activeTarget = target.index;
        lastCastTick = castAt;
        await s.direct({ type: 'spellOnNpc', npcIndex: target.index, spellComponent: SPELLS.windStrike, reason: 'SDK' });
        const gotXp = await waitUntil(s, () => stop() || skillInfo(s, 'Magic').baseLevel >= targetLevel || skillInfo(s, 'Magic').experience > xp0, { timeoutTicks: 6 });
        if (skillInfo(s, 'Magic').baseLevel >= targetLevel) break;
        if (!gotXp || skillInfo(s, 'Magic').experience <= xp0) {
            avoid.set(target.index, s.tick() + 25);
            activeTarget = null;
            lastCastTick = -10;
            continue;
        }
        while (!stop() && skillInfo(s, 'Magic').baseLevel < targetLevel && s.tick() - castAt < 5) {
            if (activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
            await waitTicks(s, 1);
        }
    }
}

async function enchantRingsTo80AtBank(s: Session, stop: StopFn): Promise<void> {
    const ALL_RING_IDS = [1637, 1638, 1639, 1640, 1643, 1644, 1645, 1646, 2550, 2552, 2554, 2556, 2558, 2560, 2562, 2564, 2566, 2570, 2572];
    const pickRingSpec = (lvl: number) => {
        if (lvl < 27) return { ringId: 1637, spell: SPELLS.enchantLvl1, label: 'Sapphire ring', untilLevel: 27 };
        if (lvl < 57) return { ringId: 1639, spell: SPELLS.enchantLvl2, label: 'Emerald ring', untilLevel: 57 };
        if (lvl < 68) return { ringId: 1643, spell: SPELLS.enchantLvl4, label: 'Diamond ring', untilLevel: 68 };
        return { ringId: 1645, spell: SPELLS.enchantLvl5, label: 'Dragonstone ring', untilLevel: 80 };
    };

    const deadline = s.tick() + 900;
    while (!stop() && skillInfo(s, 'Magic').baseLevel < 80) {
        if (s.tick() >= deadline) throw Error(`Enchant Magic -> 80 timed out at ${skillInfo(s, 'Magic').baseLevel}`);
        await openFreshBank(s, stop);
        await depositIds(s, [...ALL_RING_IDS, 558, 2435, 386], stop);
        const lvl = skillInfo(s, 'Magic').baseLevel;
        if (lvl >= 80) break;
        const spec = pickRingSpec(lvl);
        const freeSlots = Math.max(0, 28 - s.sdk.getInventory().length);
        const row = s.sdk.getState()?.bank?.items.find(i => i.id === spec.ringId);
        const take = Math.min(freeSlots, row?.count ?? 0);
        if (!row || take <= 0) throw Error(`out of ${spec.label} in bank at Magic ${lvl}`);
        await withdrawExactCount(s, spec.ringId, take, stop, spec.label);
        await closeBankClean(s, stop);

        let lastCast = -10;
        let dryCasts = 0;
        while (!stop() && skillInfo(s, 'Magic').baseLevel < spec.untilLevel) {
            if (activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
            const ring = s.sdk.getInventory().find(i => i.id === spec.ringId);
            if (!ring) break;
            if (s.tick() - lastCast < 3) {
                await waitTicks(s, 1);
                continue;
            }
            const xp0 = skillInfo(s, 'Magic').experience;
            lastCast = s.tick();
            await s.direct({ type: 'spellOnItem', slot: ring.slot, spellComponent: spec.spell, reason: 'SDK' });
            await waitUntil(s, () => skillInfo(s, 'Magic').experience > xp0 || stop(), { timeoutTicks: 4 });
            if (skillInfo(s, 'Magic').experience <= xp0) {
                dryCasts++;
                if (dryCasts >= 4) throw Error(`enchant ${spec.label} gave no Magic XP at Magic ${skillInfo(s, 'Magic').baseLevel}`);
            } else {
                dryCasts = 0;
            }
        }
        await waitTicks(s, 2);
        await dismissContinueDialogs(s, stop, 3);
    }

    await openFreshBank(s, stop);
    await depositIds(s, [...ALL_RING_IDS, 558, 555, 557, 564, 2435, 386], stop);
    await withdrawExactCount(s, 2434, 5, stop, 'Prayer potion(4)');
    await withdrawExactCount(s, 385, 3, stop, 'Shark');
    await closeBankClean(s, stop);
}

async function slashWebAt(s: Session, wx: number, wz: number, stop: StopFn): Promise<void> {
    const deadline = s.tick() + 45;
    while (!stop() && s.tick() < deadline) {
        const web = (s.sdk.getState()?.nearbyLocs ?? []).find(
            (l: any) => l.id === 733 && l.x === wx && l.z === wz && (l.optionsWithIndex ?? []).some((o: any) => /slash/i.test(o.text ?? '')),
        );
        if (!web) return;
        const knife = s.sdk.getInventory().find(i => i.id === 946);
        if (!knife) throw Error(`missing Knife to slash web at ${wx},${wz}`);
        await s.direct({ type: 'useItemOnLoc', itemSlot: knife.slot, x: wx, z: wz, locId: web.id, reason: 'SDK' });
        await waitTicks(s, 3);
    }
    if ((s.sdk.getState()?.nearbyLocs ?? []).some((l: any) => l.id === 733 && l.x === wx && l.z === wz)) {
        throw Error(`failed to slash web at ${wx},${wz}`);
    }
}

async function walkKeepToMageArenaHut(s: Session, stop: StopFn): Promise<void> {
    await walkWaypoints(s, [{ x: 3158, z: 3950, tol: 0 }], 60, stop, 'keep to north web');
    await slashWebAt(s, 3158, 3951, stop);
    await walkWaypoints(s, [{ x: 3158, z: 3952, tol: 0 }], 15, stop, 'step north past keep web');
    await walkWaypoints(s, [{ x: 3096, z: 3957, tol: 1 }], 120, stop, 'keep web to mage arena webs');
    await slashWebAt(s, 3095, 3957, stop);
    await slashWebAt(s, 3093, 3957, stop);
    await walkWaypoints(s, [{ x: 3091, z: 3957, tol: 1 }], 30, stop, 'webs to mage arena ladder');
}

async function runWildyMagicDefenceLoop(
    s: Session,
    opts: {
        targetLevel: number;
        tankNames: readonly string[];
        stop: StopFn;
    },
): Promise<void> {
    await setAutoRetaliate(s, false);
    await equipItemById(s, 2414, opts.stop, 'Zamorak cape');
    await equipItemById(s, 2417, opts.stop, 'Zamorak staff');

    await waitUntil(s, () => {
        const c = s.sdk.getState()?.combatStyle;
        return (!!c?.known && /zamorak/i.test(c.weaponName ?? '')) || opts.stop();
    }, { timeoutTicks: 10 });
    if (s.sdk.getState()?.combatStyle?.currentStyle !== 2) {
        await s.sdk.sendSetCombatStyle(2);
        if (!await waitUntil(s, () => s.sdk.getState()?.combatStyle?.currentStyle === 2 || opts.stop(), { timeoutTicks: 10 })) {
            throw Error('failed to set Zamorak staff to Defensive style (2)');
        }
    }

    const tankRes = opts.tankNames.map(exactNameRe);
    let lastCastTick = -10;
    let lastStatusTick = -100;
    let chargeExpiresTick = s.tick() + 650;
    let lastChargeCheckTick = s.tick();

    const sawFade = (sinceTick: number) =>
        (s.sdk.getState()?.gameMessages ?? []).some(
            (m: any) => m.type === 0 && (m.tick ?? 0) >= sinceTick && /magical charge fades away/i.test(m.text ?? ''),
        );
    const ensureCharge = async () => {
        if (s.tick() < chargeExpiresTick && !sawFade(lastChargeCheckTick)) return;
        lastChargeCheckTick = s.tick();
        const prevCount = (s.sdk.getState()?.gameMessages ?? []).filter((m: any) => m.type === 0 && /feel charged with magic power/i.test(m.text ?? '')).length;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.charge, reason: 'SDK' });
        await waitUntil(
            s,
            () => (s.sdk.getState()?.gameMessages ?? []).filter((m: any) => m.type === 0 && /feel charged with magic power/i.test(m.text ?? '')).length > prevCount || opts.stop(),
            { timeoutTicks: 4 },
        );
        chargeExpiresTick = s.tick() + 680;
    };

    while (!opts.stop() && skillInfo(s, 'Defence').baseLevel < opts.targetLevel) {
        if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
        if (countById(s.sdk.getInventory(), 565) < 2 || countById(s.sdk.getInventory(), 554) < 4 || countById(s.sdk.getInventory(), 556) < 1) {
            throw Error('out of runes for Flames of Zamorak');
        }
        await ensureCharge();

        const st = s.sdk.getState();
        const players: any[] = st?.nearbyPlayers ?? [];
        const tanks = players
            .filter(p => tankRes.some(re => re.test(p.name ?? '')) && (p.z ?? p.worldZ ?? 0) >= 3900 && (p.hp === undefined || p.hp === null || p.hp > 0))
            .sort((a, b) => d8({ x: a.x ?? a.worldX ?? 0, z: a.z ?? a.worldZ ?? 0 }, DESERTED_KEEP) - d8({ x: b.x ?? b.worldX ?? 0, z: b.z ?? b.worldZ ?? 0 }, DESERTED_KEEP));

        if (s.tick() - lastStatusTick >= 100) {
            lastStatusTick = s.tick();
            const def = skillInfo(s, 'Defence');
            const mag = skillInfo(s, 'Magic');
            console.log(`PVP_STATUS tick=${s.tick()} Defence=${def.baseLevel} xp=${def.experience} Magic=${mag.baseLevel} tanks=${tanks.length} at=${posOf(s)?.worldX},${posOf(s)?.worldZ}`);
        }

        if (tanks.length > 0 && s.tick() - lastCastTick >= 5) {
            const target = tanks[0]!;
            lastCastTick = s.tick();
            await s.direct({ type: 'spellOnPlayer', playerIndex: target.index, spellComponent: SPELLS.flamesOfZamorak, reason: 'SDK' });
        } else if (tanks.length === 0 && d8({ x: posOf(s)?.worldX ?? 0, z: posOf(s)?.worldZ ?? 0 }, DESERTED_KEEP) > 3) {
            await walkWaypoints(s, [{ ...DESERTED_KEEP, tol: 1 }], 40, opts.stop, 'recenter deserted keep');
        }

        await waitTicks(s, 1);
    }
}

export async function runMagicDefenceSpecialist(
    s: Session,
    opts: {
        supplierName: string;
        tankNames: readonly string[];
        cap: number;
        t0: number;
        stop: StopFn;
        runMageArenaFn: (o: { session?: Session; cap?: number; stop?: () => boolean; god?: 'zamorak'; mode?: 'pray'; charge?: boolean; earlyCharge?: boolean; defensive?: boolean; stopOutside?: boolean; keepAlive?: boolean }) => Promise<void>;
    },
): Promise<string> {
    const target = SPECIALIST_TARGETS.defence;
    const elapsed = () => s.tick() - opts.t0;
    const milestone = (step: string, extra = '') => {
        console.log(`MILESTONE ${step} tick=${elapsed()}${extra ? ' ' + extra : ''}`);
    };

    milestone('start');
    await startAndExitTutorial(s, BURY_KEEP_IDS_HP, opts.stop);
    milestone('tutorial');

    await receiveSupplyKit(s, opts.supplierName, DEFENCE_SPECIALIST_KIT, opts.stop);
    milestone('kit', `slots=${s.sdk.getInventory().length}`);

    await equipItemById(s, 1387, opts.stop, 'Staff of fire');
    await buryBonesTo43(s, opts.stop);
    milestone('prayer43', `prayer=${skillInfo(s, 'Prayer').baseLevel}`);

    await trainMagicToLevel(s, 7, opts.stop);
    milestone('magic7', `magic=${skillInfo(s, 'Magic').baseLevel}`);

    await rubRingOfDueling(s, /castle wars/i, CASTLE_WARS_LAND, opts.stop);
    await walkWaypoints(s, [{ x: CASTLE_WARS_BANK.x, z: CASTLE_WARS_BANK.z, tol: 1 }], 40, opts.stop, 'cw to bank');
    await enchantRingsTo80AtBank(s, opts.stop);
    milestone('magic80', `magic=${skillInfo(s, 'Magic').baseLevel} xp=${skillInfo(s, 'Magic').experience}`);

    for (let attempt = 0; attempt < 5 && !opts.stop(); attempt++) {
        const p = posOf(s);
        if (p && p.level === 0 && p.worldX <= 2800 && p.worldZ >= 3440) break;
        await s.direct({ type: 'clickComponent', componentId: SPELLS.camelotTeleport, reason: 'SDK' });
        await waitUntil(s, () => {
            const cur = posOf(s);
            return (!!cur && cur.level === 0 && cur.worldX <= 2800 && cur.worldZ >= 3440) || opts.stop();
        }, { timeoutTicks: 8 });
    }
    await pullArdougneLeverToWildy(s, opts.stop);
    await walkKeepToMageArenaHut(s, opts.stop);
    milestone('mage_arena_hut');

    await opts.runMageArenaFn({
        session: s,
        cap: Math.max(300, opts.cap - elapsed()),
        stop: opts.stop,
        god: 'zamorak',
        mode: 'pray',
        charge: true,
        earlyCharge: true,
        defensive: true,
        stopOutside: true,
        keepAlive: true,
    });
    milestone('mage_arena', `def=${skillInfo(s, 'Defence').baseLevel} defXp=${skillInfo(s, 'Defence').experience}`);

    await walkWaypoints(s, [{ x: 3158, z: 3952, tol: 0 }], 80, opts.stop, 'mage arena to keep north web');
    await slashWebAt(s, 3158, 3951, opts.stop);
    await walkWaypoints(s, [{ ...DESERTED_KEEP, tol: 1 }], 40, opts.stop, 'north web to keep');
    milestone('wildy_keep', `at=${posOf(s)?.worldX},${posOf(s)?.worldZ}`);

    await runWildyMagicDefenceLoop(s, { targetLevel: 99, tankNames: opts.tankNames, stop: opts.stop });

    await dismissContinueDialogs(s, opts.stop, 4);
    await s.bot.dismissBlockingUI();

    const def = skillInfo(s, 'Defence');
    milestone('complete', `defence=${def.baseLevel} xp=${def.experience} targetTicks=${target.targetTicks}`);
    if (def.baseLevel < 99) throw Error(`Defence finished at ${def.baseLevel} (< 99), xp=${def.experience}`);
    return `defence=${def.baseLevel} xp=${def.experience} ticks=${elapsed()} liveTarget=${target.targetTicks}`;
}
