// Continuous fresh-clock Ranged 1->99 specialist route from Tutorial Island through Prayer 43, Dwarf Cannon, and Poison Spiders.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountOf, closeWithin, finish, getWorld, logoutSession, openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { componentId } from '../packages/core/src/logout';
import { messageTally } from '../packages/core/src/message-tally';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo, sessionWalker, walkPath, type PathPoint } from '../packages/core/src/walk';
import {
    bandTicks,
    CANNON_REFRESH,
    CANNON_SPOTS,
    MSB,
    pickupCannon,
    pickTarget,
    reloadDue,
    setupCannon,
    specialDue,
    type PlacedCannon,
    type TargetNpc,
} from './cannon-fight';
import { runDwarfCannon } from './generated/dwarfcannon';
import { leaveRuneStarter, onStarterIsland } from './rune-starter';

export interface KitSpecItem {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly stackable: boolean;
}

export type RangedKitVariant = 'knives' | 'msb';

// Trade 1 at Lumbridge (27 slots): bones buried immediately (15 free slots left for Dwarf Cannon).
export const RANGED_SPECIALIST_TRADE1: readonly KitSpecItem[] = [
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 6, name: 'Cannon base', count: 1, stackable: false },
    { id: 8, name: 'Cannon stand', count: 1, stackable: false },
    { id: 10, name: 'Cannon barrels', count: 1, stackable: false },
    { id: 12, name: 'Cannon furnace', count: 1, stackable: false },
    { id: 2, name: 'Cannonball', count: 2000, stackable: true },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 863, name: 'Iron knife', count: 250, stackable: true },
    { id: 1129, name: 'Leather body', count: 1, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 4, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 2, stackable: false },
] as const;

// Trade 2 at Edgeville after Dwarf Cannon (18 slots): knives, full 1-def BIS Ranged armor, pots, and 28 Super restore doses.
export const RANGED_SPECIALIST_TRADE2: readonly KitSpecItem[] = [
    { id: 868, name: 'Rune knife', count: 2000, stackable: true },
    { id: 2581, name: 'Robin hood hat', count: 1, stackable: false },
    { id: 2577, name: 'Ranger boots', count: 1, stackable: false },
    { id: 2497, name: 'Dragonhide chaps', count: 1, stackable: false },
    { id: 2491, name: 'Dragon vambraces', count: 1, stackable: false },
    { id: 2448, name: 'Superantipoison(4)', count: 2, stackable: false },
    { id: 2444, name: 'Ranging potion(4)', count: 2, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 7, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 1, stackable: false },
] as const;

export const RANGED_SPECIALIST_MSB_TRADE1: readonly KitSpecItem[] = RANGED_SPECIALIST_TRADE1;

// MSB Trade 2 at Edgeville after Dwarf Cannon (19 slots): Magic shortbow + Rune arrows, full BIS armor, pots, and restores.
export const RANGED_SPECIALIST_MSB_TRADE2: readonly KitSpecItem[] = [
    { id: 861, name: 'Magic shortbow', count: 1, stackable: false },
    { id: 892, name: 'Rune arrow', count: 1000, stackable: true },
    { id: 2581, name: 'Robin hood hat', count: 1, stackable: false },
    { id: 2577, name: 'Ranger boots', count: 1, stackable: false },
    { id: 2497, name: 'Dragonhide chaps', count: 1, stackable: false },
    { id: 2491, name: 'Dragon vambraces', count: 1, stackable: false },
    { id: 2448, name: 'Superantipoison(4)', count: 2, stackable: false },
    { id: 2444, name: 'Ranging potion(4)', count: 2, stackable: false },
    { id: 3024, name: 'Super restore(4)', count: 7, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 1, stackable: false },
] as const;

function mergeKitSpecs(a: readonly KitSpecItem[], b: readonly KitSpecItem[]): readonly KitSpecItem[] {
    const order: KitSpecItem[] = [];
    const byId = new Map<number, KitSpecItem>();
    for (const item of [...a, ...b]) {
        const cur = byId.get(item.id);
        if (cur) {
            const merged = { ...cur, count: cur.count + item.count };
            byId.set(item.id, merged);
            order[order.findIndex(x => x.id === item.id)] = merged;
        } else {
            const copy = { ...item };
            byId.set(item.id, copy);
            order.push(copy);
        }
    }
    return order;
}

export const RANGED_SPECIALIST_KIT: readonly KitSpecItem[] = mergeKitSpecs(RANGED_SPECIALIST_TRADE1, RANGED_SPECIALIST_TRADE2);

export const RANGED_SPECIALIST_MSB_KIT: readonly KitSpecItem[] = mergeKitSpecs(RANGED_SPECIALIST_MSB_TRADE1, RANGED_SPECIALIST_MSB_TRADE2);

export function variantTrades(variant: RangedKitVariant = 'knives'): { trade1: readonly KitSpecItem[]; trade2: readonly KitSpecItem[] } {
    return variant === 'msb'
        ? { trade1: RANGED_SPECIALIST_MSB_TRADE1, trade2: RANGED_SPECIALIST_MSB_TRADE2 }
        : { trade1: RANGED_SPECIALIST_TRADE1, trade2: RANGED_SPECIALIST_TRADE2 };
}

export function variantKit(variant: RangedKitVariant = 'knives'): readonly KitSpecItem[] {
    return variant === 'msb' ? RANGED_SPECIALIST_MSB_KIT : RANGED_SPECIALIST_KIT;
}

export const LUMBRIDGE_HANDOFF = { x: 3222, z: 3222, level: 0 } as const;
export const SUPPLIER_STAND = { x: 3223, z: 3222, level: 0 } as const;
export const EDGEVILLE_HANDOFF = { x: 3088, z: 3496, level: 0 } as const;
export const EDGEVILLE_SUPPLIER_STAND = { x: 3089, z: 3496, level: 0 } as const;
export const CASTLE_WARS = { x: 2440, z: 3089, level: 0 } as const;
export const EDGEVILLE = { x: 3087, z: 3496, level: 0 } as const;
export const LAWGOF = { x: 2571, z: 3463, level: 0 } as const;
export const NULODION_DOOR = { x: 3015, z: 3453, level: 0 } as const;
// Optimal cannon centre matching CANNON_SPOTS.spiders (7.8/8 rays covered, clear 3x3 at 3287,3810).
export const SPIDERS_CENTRE = { x: 3287, z: 3810, level: 0 } as const;
export const SPIDERS_CLEAR = { x: 3287, z: 3755, level: 0 } as const;

export const ITEM_IDS = {
    cannonball: 2,
    cannonParts: [6, 8, 10, 12] as readonly number[],
    cannonLocIds: [7, 8, 9, 6] as readonly number[],
    bones: 536,
    toolkit: 1,
    ironKnife: 863,
    runeKnife: 868,
    msb: MSB,
    runeArrow: 892,
    leatherBody: 1129,
    blackChaps: 2497,
    blackVambs: 2491,
    rangerBoots: 2577,
    robinHood: 2581,
    duelRings: [2552, 2554, 2556, 2558, 2560, 2562, 2564, 2566] as readonly number[],
    glories: [1712, 1710, 1708, 1706] as readonly number[],
    gloriesAll: [1712, 1710, 1708, 1706, 1704] as readonly number[],
    antipoison: [2448, 181, 183, 185] as readonly number[],
    rangingPot: [2444, 169, 171, 173] as readonly number[],
    superRestore: [3024, 3026, 3028, 3030] as readonly number[],
    superEnergy: [3016, 3018, 3020, 3022] as readonly number[],
    cake: [1897, 1899, 1901] as readonly number[],
    vial: 229,
} as const;

const PROTECT_MELEE = 14;
const RETALIATE_ON = 150;
const RETALIATE_OFF = 151;
const RUN_ON = 153;
const HEAD_SLOT = 0;
const NECK_SLOT = 2;
const WEAPON_SLOT = 3;
const LEGS_SLOT = 7;
const HANDS_SLOT = 9;
const FEET_SLOT = 10;
const AMMO_SLOT = 13;
const ACCOUNT_RE = /^[A-Za-z0-9_ -]{1,12}$/;

type StopFn = () => boolean;
type Point = { x: number; z: number; tol?: number };
type InvItem = { id: number; baseId?: number; slot?: number; count: number; name?: string; optionsWithIndex?: { text: string; opIndex: number }[] };
type WornItem = { id: number; slot?: number; count?: number };

export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactNameRe = (name: string): RegExp => new RegExp('^' + escapeRe(name) + '$', 'i');

export function kitRequirements(kit: readonly KitSpecItem[] = RANGED_SPECIALIST_KIT) {
    return [...kit]
        .sort((a, b) => a.id - b.id)
        .map(item => ({ item: item.name, count: item.count, itemId: item.id }));
}

export function kitSlotTotal(kit: readonly KitSpecItem[] = RANGED_SPECIALIST_KIT): number {
    return kit.reduce((sum, item) => sum + (item.stackable ? 1 : item.count), 0);
}

export function countById(items: readonly { id: number; baseId?: number; count?: number }[], id: number): number {
    let total = 0;
    for (const item of items) {
        if ((item.baseId ?? item.id) === id) total += item.count ?? 0;
    }
    return total;
}

export function countAnyId(items: readonly { id: number; baseId?: number; count?: number }[], ids: readonly number[]): number {
    return ids.reduce((sum, id) => sum + countById(items, id), 0);
}

export function totalDoses(items: readonly { id: number; baseId?: number; count?: number }[], chain: readonly number[]): number {
    // chain is ordered [4-dose, 3-dose, 2-dose, 1-dose].
    return chain.reduce((sum, id, idx) => sum + countById(items, id) * (chain.length - idx), 0);
}

export function hasExactKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = RANGED_SPECIALIST_KIT): boolean {
    const allowed = new Set(kit.map(k => k.id));
    if (items.some(i => !allowed.has(i.baseId ?? i.id))) return false;
    return kit.every(spec => countById(items, spec.id) === spec.count);
}

export function hasAtLeastKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = RANGED_SPECIALIST_KIT): boolean {
    return kit.every(spec => countById(items, spec.id) >= spec.count);
}

export function assertSupplierAccount(name: string, label = 'account'): string {
    if (!name || !ACCOUNT_RE.test(name)) throw Error(`ranged-specialist: invalid ${label}: ${name}`);
    if (RESERVED_ACCOUNTS.includes(name.toLowerCase())) throw Error(`ranged-specialist: refuses reserved ${label}: ${name}`);
    return name;
}

export function chooseDesiredWeapon(
    rangedLevel: number,
    inv: readonly InvItem[],
    worn: readonly WornItem[],
    variant: RangedKitVariant = 'knives',
): InvItem | undefined {
    const wornWeaponId = worn.find(w => w.slot === WEAPON_SLOT)?.id;
    if (variant === 'msb' && rangedLevel >= 50) {
        if (wornWeaponId === ITEM_IDS.msb) return undefined;
        return inv.find(i => i.id === ITEM_IDS.msb);
    }
    if (variant === 'knives' && rangedLevel >= 40) {
        if (wornWeaponId === ITEM_IDS.runeKnife) return undefined;
        return inv.find(i => i.id === ITEM_IDS.runeKnife);
    }
    if (wornWeaponId === ITEM_IDS.ironKnife || wornWeaponId === ITEM_IDS.runeKnife || wornWeaponId === ITEM_IDS.msb) return undefined;
    return inv.find(i => i.id === ITEM_IDS.ironKnife);
}

export function chooseDesiredChaps(rangedLevel: number, inv: readonly InvItem[], worn: readonly WornItem[]): InvItem | undefined {
    if (rangedLevel < 70) return undefined;
    if (worn.some(w => w.slot === LEGS_SLOT && w.id === ITEM_IDS.blackChaps)) return undefined;
    return inv.find(i => i.id === ITEM_IDS.blackChaps);
}

const RANGED_ARMOR_TIERS: readonly { level: number; slot: number; id: number }[] = [
    { level: 70, slot: LEGS_SLOT, id: ITEM_IDS.blackChaps },
    { level: 70, slot: HANDS_SLOT, id: ITEM_IDS.blackVambs },
    { level: 40, slot: HEAD_SLOT, id: ITEM_IDS.robinHood },
    { level: 40, slot: FEET_SLOT, id: ITEM_IDS.rangerBoots },
];

export function chooseDesiredArmor(rangedLevel: number, inv: readonly InvItem[], worn: readonly WornItem[]): InvItem | undefined {
    for (const tier of RANGED_ARMOR_TIERS) {
        if (rangedLevel < tier.level) continue;
        if (worn.some(w => w.slot === tier.slot && w.id === tier.id)) continue;
        const found = inv.find(i => i.id === tier.id);
        if (found) return found;
    }
    return undefined;
}

export function isAdjacentToCannon(me: { x: number; z: number }, cannon: { x: number; z: number }): boolean {
    return (
        ((me.z === cannon.z - 1 || me.z === cannon.z + 3) && me.x >= cannon.x && me.x <= cannon.x + 2)
        || ((me.x === cannon.x - 1 || me.x === cannon.x + 3) && me.z >= cannon.z && me.z <= cannon.z + 2)
    );
}

export function weaponReach(worn: readonly WornItem[]): number {
    const w = worn.find(e => e.slot === WEAPON_SLOT)?.id;
    return w === ITEM_IDS.msb ? 7 : 4;
}

// Schedule up to 8 Ranging potion doses across 1->99 so ranged level stays boosted continuously.
export function shouldDrinkRanging(baseLevel: number, curLevel: number, dosesLeft: number): boolean {
    if (dosesLeft <= 0) return false;
    if (dosesLeft >= 8) return curLevel <= baseLevel;
    if (dosesLeft === 7) return baseLevel >= 22 && curLevel <= baseLevel + 1;
    if (dosesLeft === 6) return baseLevel >= 40 && curLevel <= baseLevel + 2;
    if (dosesLeft === 5) return baseLevel >= 54 && curLevel <= baseLevel + 3;
    if (dosesLeft === 4) return baseLevel >= 68 && curLevel <= baseLevel + 4;
    if (dosesLeft === 3) return baseLevel >= 77 && curLevel <= baseLevel + 5;
    if (dosesLeft === 2) return baseLevel >= 86 && curLevel <= baseLevel + 6;
    return baseLevel >= 93 && curLevel <= baseLevel + 7;
}

export function shouldDrinkSuperRestore(prayerPoints: number, basePrayer: number): boolean {
    const gain = 8 + Math.floor(basePrayer * 0.25);
    return prayerPoints <= Math.max(12, basePrayer - gain - 6);
}

export function shouldDrinkAntipoison(poisoned: boolean, ticksSinceDrink: number): boolean {
    return poisoned || ticksSinceDrink >= 540;
}

function readServerHost(root: string, bot: string): string {
    const p = join(root, 'vendor', 'rs-sdk', 'bots', bot, 'bot.env');
    if (!existsSync(p)) return '';
    return (readFileSync(p, 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
}

function posOf(s: Session) {
    return s.sdk.getState()?.player as { worldX: number; worldZ: number; level: number; hp?: number; runEnergy?: number; combat?: { inCombat?: boolean; targetIndex?: number } } | undefined;
}

function d8(a: { x: number; z: number }, b: { x: number; z: number }): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function skillInfo(s: Session, name: string): { level: number; baseLevel: number; experience: number } {
    const sk = s.sdk.getSkill(name) as { level?: number; baseLevel?: number; experience?: number } | undefined;
    return { level: sk?.level ?? 1, baseLevel: sk?.baseLevel ?? sk?.level ?? 1, experience: sk?.experience ?? 0 };
}

function activeContinueDialog(s: Session): boolean {
    const d: any = s.sdk.getDialog();
    if (!d?.isOpen || d.isWaiting) return false;
    const opts: any[] = d.options ?? [];
    return opts.length === 0 || opts.every(o => /click here to continue/i.test(o.text ?? ''));
}

async function dismissContinueDialogs(s: Session, stop: StopFn, maxTicks = 6): Promise<void> {
    for (let i = 0; i < maxTicks && !stop(); i++) {
        const d: any = s.sdk.getDialog();
        if (!d?.isOpen) return;
        if (!d.isWaiting && activeContinueDialog(s)) await s.sdk.sendClickDialog(0);
        await waitTicks(s, 1);
    }
}

function attachEnergySipper(
    s: Session,
    stop: StopFn,
    opts: { threshold?: number; requireMoving?: boolean } = {},
): () => void {
    const threshold = opts.threshold ?? 65;
    let lastSip = -10;
    let prevPos = '';
    return s.onTick(() => {
        if (stop()) return;
        const st = s.sdk.getState();
        const p = posOf(s);
        if (!p) return;
        const curPos = `${p.worldX},${p.worldZ},${p.level}`;
        const moved = !!prevPos && curPos !== prevPos;
        prevPos = curPos;
        if (opts.requireMoving && (!moved || p.worldX === 2576)) return;
        if (st?.dialog?.isOpen || st?.modalOpen) return;
        const energy = p.runEnergy ?? 100;
        const now = s.tick();
        if (energy <= threshold && now - lastSip >= 3) {
            const pot = (st?.inventory as InvItem[] | undefined)?.find(it => ITEM_IDS.superEnergy.includes(it.id));
            if (pot && pot.slot !== undefined) {
                lastSip = now;
                void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                if (energy < 5) void s.direct({ type: 'clickComponent', componentId: RUN_ON, reason: 'SDK' });
            }
        }
    });
}

async function topUpEnergy(s: Session, targetEnergy: number, stop: StopFn): Promise<void> {
    for (let i = 0; i < 6 && !stop(); i++) {
        const energy = posOf(s)?.runEnergy ?? 100;
        if (energy >= targetEnergy) break;
        const pot = (s.sdk.getInventory() as InvItem[]).find(it => ITEM_IDS.superEnergy.includes(it.id));
        if (!pot || pot.slot === undefined) break;
        await s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
        await waitTicks(s, 1);
    }
    if ((posOf(s)?.runEnergy ?? 100) >= 5) {
        await s.direct({ type: 'clickComponent', componentId: RUN_ON, reason: 'SDK' });
    }
}

async function walkWaypoints(s: Session, pts: Point[], maxTicks: number, stop: StopFn, label: string): Promise<void> {
    const walker = await sessionWalker(s);
    const offEnergy = attachEnergySipper(s, stop, { threshold: 65 });
    const offDialog = s.onTick(() => {
        if (activeContinueDialog(s)) void s.sdk.sendClickDialog(0);
    });
    try {
        const r = await walkPath(walker, pts, { maxTicks, stop, look: 20 });
        if (r.ok) return;
        const target = pts[pts.length - 1]!;
        const p = posOf(s);
        if (p && d8({ x: p.worldX, z: p.worldZ }, target) <= (target.tol ?? 2) + 1) return;
        const world = await getWorld();
        const g = await goTo(s, world, { x: target.x, z: target.z, level: 0 }, accountOf(s), { legTimeoutTicks: Math.max(120, maxTicks) });
        if (!g.ok) throw Error(`walk failed (${label}): ${r.detail ?? g.detail ?? JSON.stringify(r)}`);
    } finally {
        offEnergy();
        offDialog();
    }
}

async function dropItemsMatching(s: Session, pred: (i: InvItem) => boolean, stop: StopFn, label: string): Promise<void> {
    const deadline = s.tick() + 45;
    while (!stop()) {
        const drop = (s.sdk.getInventory() as InvItem[]).filter(pred);
        if (drop.length === 0) return;
        if (s.tick() >= deadline) throw Error(`failed to drop ${label}: ${drop.map(i => i.id).join(',')}`);
        await dismissContinueDialogs(s, stop, 2);
        await Promise.all(drop.slice(0, 4).map(i => s.direct({ type: 'dropItem', slot: i.slot, reason: 'SDK' })));
        await waitTicks(s, 1);
    }
}

async function equipItemFast(s: Session, item: InvItem): Promise<void> {
    if (item.slot === undefined) return;
    const op = item.optionsWithIndex?.find(o => /^(wield|wear|equip)$/i.test(o.text))?.opIndex;
    if (op) await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: op, reason: 'SDK' });
    else await s.bot.equipItem(item as any);
}

async function rubJewellery(
    s: Session,
    ids: readonly number[],
    optionRe: RegExp,
    dest: { x: number; z: number; level: number },
    tol: number,
    stop: StopFn,
    label: string,
): Promise<void> {
    const arrived = () => {
        const p = posOf(s);
        return !!p && p.level === dest.level && d8({ x: p.worldX, z: p.worldZ }, dest) <= tol;
    };
    if (arrived()) return;
    for (let attempt = 0; attempt < 4 && !stop(); attempt++) {
        await dismissContinueDialogs(s, stop, 2);
        const item = (s.sdk.getInventory() as InvItem[]).find(i => ids.includes(i.id));
        if (!item || item.slot === undefined) throw Error(`missing jewellery for ${label} (${ids.join(',')})`);
        const rubOp = item.optionsWithIndex?.find(o => /rub/i.test(o.text))?.opIndex ?? 4;
        await s.direct({ type: 'useInventoryItem', slot: item.slot, optionIndex: rubOp, reason: 'SDK' });
        const opened = await waitUntil(s, () => {
            const d: any = s.sdk.getDialog();
            return stop() || arrived() || (!!d?.isOpen && !d.isWaiting && (d.options ?? []).some((o: any) => optionRe.test(o.text)));
        }, { timeoutTicks: 8 });
        if (arrived()) return;
        if (!opened) continue;
        const opts: any[] = s.sdk.getDialog()?.options ?? [];
        const opt = opts.find(o => optionRe.test(o.text));
        if (!opt) continue;
        await s.sdk.sendClickDialog(opt.index);
        if (await waitUntil(s, () => stop() || arrived(), { timeoutTicks: 10 })) return;
    }
    throw Error(`jewellery teleport failed (${label})`);
}

async function setProtectMelee(s: Session, on: boolean, stop: StopFn): Promise<void> {
    const isOn = () => !!s.sdk.getState()?.prayers?.activePrayers?.[PROTECT_MELEE];
    const pts = () => s.sdk.getState()?.prayers?.prayerPoints ?? 0;
    if (on && pts() <= 0) return;
    if (isOn() === on) return;
    for (let i = 0; i < 3 && isOn() !== on && !stop(); i++) {
        if (on && pts() <= 0) return;
        await s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE, reason: 'SDK' });
        await waitUntil(s, () => stop() || isOn() === on || (on && pts() <= 0), { timeoutTicks: 2 });
    }
}

async function receiveSupplyKit(
    s: Session,
    supplierName: string,
    kit: readonly KitSpecItem[],
    stop: StopFn,
    handoff: { x: number; z: number; level: number } = LUMBRIDGE_HANDOFF,
): Promise<void> {
    const p0 = posOf(s);
    if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, handoff) > 2) {
        await walkWaypoints(s, [{ ...handoff, tol: 1 }], 80, stop, 'supply handoff');
    }
    const before = new Map(kit.map(k => [k.id, countById(s.sdk.getInventory(), k.id)]));
    const receivedAll = () => kit.every(spec => countById(s.sdk.getInventory(), spec.id) >= (before.get(spec.id) ?? 0) + spec.count);
    const allowed = new Set(kit.map(k => k.id));
    const peerRe = exactNameRe(supplierName);
    const deadline = s.tick() + 250;
    while (!stop() && !receivedAll()) {
        if (s.tick() >= deadline) throw Error(`did not receive ranged kit from ${supplierName}`);
        await dismissContinueDialogs(s, stop, 2);
        await s.bot.dismissBlockingUI();
        const near = (s.sdk.getState()?.nearbyPlayers ?? []).find((n: any) => peerRe.test(n.name));
        if (!near) {
            await waitTicks(s, 1);
            continue;
        }
        const tr = await s.bot.trade(peerRe, {
            accept: offer => offer.every(o => allowed.has(o.id)) && kit.every(k => countById(offer, k.id) === k.count),
            requestTimeout: 10_000,
            timeout: 45_000,
            retryOnBusy: true,
        });
        if (tr.success) {
            await waitUntil(s, () => receivedAll() || stop(), { timeoutTicks: 10 });
            if (receivedAll()) return;
        }
        await waitTicks(s, 1);
    }
    if (!receivedAll()) {
        throw Error('stopped waiting for ranged supply kit');
    }
}

async function serveBenchCompanion(
    sup: Session,
    specialistName: string,
    kit: readonly KitSpecItem[],
    stop: StopFn,
    waitTicksCap = 300,
): Promise<void> {
    try {
        await waitUntil(sup, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        const giveList = kit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
        const peerRe = exactNameRe(specialistName);
        const deadline = sup.tick() + waitTicksCap;
        let done = false;
        while (!stop() && !done && sup.tick() < deadline) {
            const served = await sup.bot.serveTrades({
                from: peerRe,
                give: giveList,
                accept: offer => offer.length === 0,
                maxTrades: 1,
                tradeTimeout: 60_000,
                timeout: 30_000,
                until: () => stop() || sup.tick() >= deadline,
            });
            done = served.trades.some(t => t.success && kit.every(k => countById(t.gave, k.id) === k.count));
            if (!done) await waitTicks(sup, 1);
        }
        if (!done) throw Error(`bench supplier did not finish trade for ${specialistName}`);
    } finally {
        await logoutSession(sup).catch(() => {});
        await closeWithin([sup], 3000).catch(() => {});
    }
}

const CWARS_TO_LAWGOF_PATH: Point[] = [
    { x: 2451, z: 3151, tol: 3 },
    { x: 2463, z: 3178, tol: 3 },
    { x: 2476, z: 3197, tol: 3 },
    { x: 2486, z: 3214, tol: 3 },
    { x: 2506, z: 3233, tol: 3 },
    { x: 2576, z: 3328, tol: 4 },
    { x: LAWGOF.x, z: LAWGOF.z + 1, tol: 3 },
];

async function equipEarlyGearAndBuryBones(s: Session, variant: RangedKitVariant, stop: StopFn): Promise<void> {
    const inv = s.sdk.getInventory() as InvItem[];
    const knife = inv.find(i => i.id === ITEM_IDS.ironKnife);
    if (knife) {
        await equipItemFast(s, knife);
        await s.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
    }
    const body = inv.find(i => i.id === ITEM_IDS.leatherBody);
    if (body) await equipItemFast(s, body);
    if (variant === 'msb') {
        const arrows = inv.find(i => i.id === ITEM_IDS.runeArrow);
        if (arrows) await equipItemFast(s, arrows);
    }
    await waitTicks(s, 1);

    const deadline = s.tick() + 60;
    while (!stop()) {
        const before = countById(s.sdk.getInventory(), ITEM_IDS.bones);
        if (before === 0) break;
        if (s.tick() >= deadline) throw Error(`stalled burying Dragon bones (${before} left)`);
        const bone = s.sdk.getInventory().find(i => i.id === ITEM_IDS.bones);
        if (!bone) break;
        await s.sdk.sendUseItem(bone.slot, 1);
        await waitUntil(s, () => countById(s.sdk.getInventory(), ITEM_IDS.bones) < before || stop(), { timeoutTicks: 4 });
    }
    const prayer = skillInfo(s, 'Prayer');
    if (prayer.baseLevel < 43) {
        throw Error(`Prayer ${prayer.baseLevel} < 43 after burying Dragon bones (xp=${prayer.experience})`);
    }
}

async function walkEdgevilleToSpiders(s: Session, spot: { x: number; z: number; level: number }, stop: StopFn): Promise<void> {
    const walker = await sessionWalker(s);
    const legs: Point[] = [
        { x: 3100, z: 3559, tol: 4 },
        { x: 3161, z: 3631, tol: 4 },
        { x: 3217, z: 3740, tol: 4 },
        { x: spot.x, z: spot.z, tol: 0 },
    ];
    let lastSip = -10;
    let lastPrayToggle = -10;
    let wantPray = false;
    const offWalk = s.onTick(() => {
        if (stop()) return;
        const p = posOf(s);
        const now = s.tick();
        const st = s.sdk.getState();
        const pts = st?.prayers?.prayerPoints ?? 0;
        const basePray = skillInfo(s, 'Prayer').baseLevel;
        if ((p?.worldZ ?? 0) >= 3765 || p?.combat?.inCombat || (p?.hp ?? 10) < 10) wantPray = true;
        if (shouldDrinkSuperRestore(pts, basePray) && now - lastSip >= 3) {
            const pot = (s.sdk.getInventory() as InvItem[]).find(it => ITEM_IDS.superRestore.includes(it.id));
            if (pot && pot.slot !== undefined) {
                lastSip = now;
                void s.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
            }
        }
        if ((p?.runEnergy ?? 100) <= 65 && now - lastSip >= 3) {
            const epot = (s.sdk.getInventory() as InvItem[]).find(it => ITEM_IDS.superEnergy.includes(it.id));
            if (epot && epot.slot !== undefined) {
                lastSip = now;
                void s.direct({ type: 'useInventoryItem', slot: epot.slot, optionIndex: 1, reason: 'SDK' });
            }
        }
        if (wantPray && pts > 0 && !st?.prayers?.activePrayers?.[PROTECT_MELEE] && now - lastPrayToggle >= 2) {
            lastPrayToggle = now;
            void s.direct({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE, reason: 'SDK' });
        }
    });
    try {
        await s.direct({ type: 'clickComponent', componentId: RUN_ON, reason: 'SDK' });
        for (let i = 0; i < legs.length && !stop(); i++) {
            const leg = legs[i]!;
            if (leg.z >= 3765) wantPray = true;
            if (wantPray) await setProtectMelee(s, true, stop);
            await walkPath(walker, [leg], { maxTicks: 220, stop, look: 20 });
        }
        const p = posOf(s);
        if (!p || d8({ x: p.worldX, z: p.worldZ }, spot) > 1) {
            await walkWaypoints(s, [{ x: spot.x, z: spot.z, tol: 0 }], 80, stop, 'to spiders center');
        }
        await setProtectMelee(s, true, stop);
    } finally {
        offWalk();
    }
}

const CANNON_BUILD_STAGES: readonly { locId: number; partId: number; nextLocId: number }[] = [
    { locId: 7, partId: 8, nextLocId: 8 },
    { locId: 8, partId: 10, nextLocId: 9 },
    { locId: 9, partId: 12, nextLocId: 6 },
];

async function ensureCannonSetup(
    s: Session,
    spotCentre: { x: number; z: number; level: number },
    stop: StopFn,
): Promise<PlacedCannon> {
    const t0 = s.tick();
    const origin = { x: spotCentre.x - 1, z: spotCentre.z - 1 };
    const st = (): any => s.sdk.getState();
    const inv = (): InvItem[] => st()?.inventory ?? [];
    const hasPart = (id: number) => inv().some(i => i.id === id);
    const findCannonLoc = (): any => (st()?.nearbyLocs ?? [])
        .filter((l: any) => (/cannon/i.test(l.name ?? '') || ITEM_IDS.cannonLocIds.includes(l.id)) && d8(l, origin) <= 6)
        .sort((a: any, b: any) => d8(a, origin) - d8(b, origin) || (a.distance ?? 0) - (b.distance ?? 0))[0];
    const summarizeLocs = () => (st()?.nearbyLocs ?? [])
        .filter((l: any) => d8(l, spotCentre) <= 5)
        .slice(0, 12)
        .map((l: any) => `${l.id}:${l.name}@${l.x},${l.z}`)
        .join('|');

    const tally = messageTally(() => st()?.gameMessages);
    tally.pull();
    for (let attempt = 0; attempt < 3 && !stop(); attempt++) {
        if (!findCannonLoc() && hasPart(ITEM_IDS.cannonParts[0]!)) {
            if (attempt === 0) {
                const p0 = posOf(s);
                if (!p0 || d8({ x: p0.worldX, z: p0.worldZ }, spotCentre) > 0) {
                    await s.bot.walkTo(spotCentre.x, spotCentre.z, 0);
                    await waitTicks(s, 1);
                }
                const base = inv().find(i => i.id === ITEM_IDS.cannonParts[0]);
                if (base && base.slot !== undefined) {
                    tally.pull();
                    const placed0 = tally.count(/place the cannon base/i);
                    const space0 = tally.count(/isn't enough space/i);
                    const op = base.optionsWithIndex?.find(o => /set-?up/i.test(o.text ?? ''))?.opIndex ?? 1;
                    await s.direct({ type: 'useInventoryItem', slot: base.slot, optionIndex: op, reason: 'SDK' });
                    await waitUntil(
                        s,
                        () => {
                            tally.pull();
                            return stop()
                                || !!findCannonLoc()
                                || !hasPart(ITEM_IDS.cannonParts[0]!)
                                || tally.count(/place the cannon base/i) > placed0
                                || tally.count(/isn't enough space/i) > space0;
                        },
                        { timeoutTicks: 8 },
                    );
                }
            } else {
                try {
                    await waitTicks(s, 1);
                    return await setupCannon(s, { centre: { x: spotCentre.x, z: spotCentre.z }, avoidOld: false });
                } catch (err) {
                    const p = posOf(s);
                    console.log(`WARN cannon_setup attempt=${attempt} err=${String(err)} at=${p?.worldX},${p?.worldZ} inv=${inv().map(i => `${i.id}x${i.count}`).join(',')} nearby=${summarizeLocs()}`);
                }
            }
        }

        if (hasPart(ITEM_IDS.cannonParts[0]!) && !findCannonLoc()) {
            await waitTicks(s, 2);
            continue;
        }

        await waitUntil(s, () => stop() || !!findCannonLoc(), { timeoutTicks: 6 });
        let loc = findCannonLoc();
        const originCoord = loc ? { x: loc.x, z: loc.z } : origin;
        if (!loc) {
            console.log(`WARN cannon_loc_missing at_origin=${origin.x},${origin.z} nearby=${summarizeLocs()}`);
        }

        // Complete any remaining stand/barrels/furnace stages cleanly on the placed cannon.
        for (const stage of CANNON_BUILD_STAGES) {
            if (stop()) break;
            loc = findCannonLoc();
            if (loc && loc.id === 6) break;
            const item = inv().find(i => i.id === stage.partId);
            if (!item || item.slot === undefined) continue;
            const useId = loc?.id ?? stage.locId;
            const beforeCount = countById(inv(), stage.partId);
            await s.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: originCoord.x, z: originCoord.z, locId: useId, reason: 'SDK' });
            await waitUntil(s, () => {
                const n = findCannonLoc();
                return stop() || countById(inv(), stage.partId) < beforeCount || (!!n && n.id !== useId);
            }, { timeoutTicks: 8 });
        }

        await waitUntil(s, () => stop() || findCannonLoc()?.id === 6, { timeoutTicks: 4 });
        loc = findCannonLoc() ?? { x: originCoord.x, z: originCoord.z, id: 6, optionsWithIndex: [{ text: 'Fire', opIndex: 1 }] };

        const balls = inv().find(i => i.id === ITEM_IDS.cannonball);
        if (!balls || balls.slot === undefined) throw Error('no cannonballs in pack');
        tally.pull();
        const loadBefore = tally.count(/load the cannon|already full/i);
        const ballsBefore = countInvOrZero(inv(), ITEM_IDS.cannonball);
        await s.direct({ type: 'useItemOnLoc', itemSlot: balls.slot, x: loc.x, z: loc.z, locId: loc.id, reason: 'SDK' });
        await waitUntil(s, () => {
            tally.pull();
            return stop() || tally.count(/load the cannon|already full/i) > loadBefore || countInvOrZero(inv(), ITEM_IDS.cannonball) < ballsBefore;
        }, { timeoutTicks: 8 });
        const fireOp = (loc.optionsWithIndex ?? []).find((o: any) => /^fire$/i.test(o.text ?? ''))?.opIndex ?? 1;
        await s.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: fireOp, reason: 'SDK' });
        await waitTicks(s, 2);
        return { x: loc.x, z: loc.z, id: loc.id, centre: { x: loc.x + 1, z: loc.z + 1 }, setupTicks: s.tick() - t0 };
    }
    throw Error('failed to setup cannon at spiders');
}

function countInvOrZero(items: readonly InvItem[], id: number): number {
    return countById(items, id);
}

async function runSpiderGrind(
    s: Session,
    variant: RangedKitVariant,
    spotCentre: { x: number; z: number; level: number },
    stop: StopFn,
): Promise<{ setupTicks: number; combatTicks: number; reloads: number; specials: number; refills: number; rangePots: number; restores: number; antis: number; cannon: PlacedCannon }> {
    const spot = CANNON_SPOTS.spiders!;
    const st = (): any => s.sdk.getState();
    const inv = (): InvItem[] => st()?.inventory ?? [];
    const worn = (): WornItem[] => st()?.equipment ?? [];
    const cvar = (id: number): number | undefined => (s.client as { var?: Int32Array | number[] } | undefined)?.var?.[id];
    const findLoc = (pred: (l: any) => boolean) => (st()?.nearbyLocs ?? []).filter(pred).sort((a: any, b: any) => a.distance - b.distance)[0];
    const cannonAt = (c: { x: number; z: number }) => findLoc(l => l.x === c.x && l.z === c.z && (/cannon/i.test(l.name ?? '') || ITEM_IDS.cannonLocIds.includes(l.id)));
    const countInv = (ids: readonly number[]) => countAnyId(inv(), ids);

    // Ensure protection, prayer headroom, and poison immunity before setting up cannon.
    const pray0 = st()?.prayers?.prayerPoints ?? 0;
    const basePray0 = skillInfo(s, 'Prayer').baseLevel;
    let restores = 0;
    if (shouldDrinkSuperRestore(pray0, basePray0)) {
        const rest0 = inv().find(i => ITEM_IDS.superRestore.includes(i.id));
        if (rest0 && rest0.slot !== undefined) {
            await s.direct({ type: 'useInventoryItem', slot: rest0.slot, optionIndex: 1, reason: 'SDK' });
            restores++;
            await waitTicks(s, 2);
        }
    }
    await setProtectMelee(s, true, stop);
    const glory = inv().find(i => ITEM_IDS.gloriesAll.includes(i.id));
    if (glory && !worn().some(w => w.slot === NECK_SLOT)) await equipItemFast(s, glory);

    const tally = messageTally(() => st()?.gameMessages);
    const loadSeen = (): number => tally.count(/you load the cannon with|already full of ammo/i);
    const emptySeen = (): number => tally.count(/out of ammo/i);
    const goneSeen = (): number => tally.count(/your cannon has been destroyed/i);
    const poisonSeen = (): number => tally.count(/you have been poisoned/i);

    const anti0 = inv().find(i => ITEM_IDS.antipoison.includes(i.id));
    let lastAnti = -999;
    let antis = 0;
    if (anti0 && anti0.slot !== undefined) {
        await s.direct({ type: 'useInventoryItem', slot: anti0.slot, optionIndex: 1, reason: 'SDK' });
        lastAnti = s.tick();
        antis++;
        await waitTicks(s, 2);
    }

    // Turn Auto-Retaliate OFF (151) while setting up cannon so spider hits do not interrupt cannon_setup p_delay(0).
    if (st()?.autoRetaliateEnabled !== false) {
        await s.direct({ type: 'clickComponent', componentId: RETALIATE_OFF, reason: 'SDK' });
    }

    const cannon = await ensureCannonSetup(s, spotCentre, stop);

    // Re-enable Auto-Retaliate (150) and Rapid style (1) after cannon assembly.
    if (st()?.autoRetaliateEnabled === false) {
        await s.direct({ type: 'clickComponent', componentId: RETALIATE_ON, reason: 'SDK' });
    }
    if (st()?.combatStyle?.currentStyle !== 1) {
        await s.direct({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
    }

    // Sip first Ranging potion dose after cannon setup clears any p_delay(1).
    const rPot0 = inv().find(i => ITEM_IDS.rangingPot.includes(i.id));
    let lastRPot = -999;
    let rangePots = 0;
    if (rPot0 && rPot0.slot !== undefined && shouldDrinkRanging(skillInfo(s, 'Ranged').baseLevel, skillInfo(s, 'Ranged').level, totalDoses(inv(), ITEM_IDS.rangingPot))) {
        await s.direct({ type: 'useInventoryItem', slot: rPot0.slot, optionIndex: 1, reason: 'SDK' });
        lastRPot = s.tick();
        rangePots++;
        await waitTicks(s, 2);
    }

    // Stand cardinal-adjacent SW of cannon so reloads take zero walk ticks.
    const stand = { x: cannon.x, z: cannon.z - 1 };
    const pStart = posOf(s);
    if (pStart && !isAdjacentToCannon({ x: pStart.worldX, z: pStart.worldZ }, cannon)) {
        const w = await sessionWalker(s);
        await walkPath(w, [{ x: stand.x, z: stand.z, tol: 0 }], { maxTicks: 8, stop });
    }

    const combatT0 = s.tick();
    let placedAt = s.tick();
    let lastLoad = s.tick();
    let refills = 0;
    let reloads = 0;
    let specials = 0;
    let lastAttack = -99;
    let lastGain = -99;
    let lastHpXp = skillInfo(s, 'Hitpoints').experience;
    let lastSpec = -99;
    let loadPending = -1;
    let loadMark = 0;
    let needFire = false;
    let firePending = -1;
    let missingLocStreak = 0;
    let currentWeapon = worn().find(w => w.slot === WEAPON_SLOT)?.id;
    const bandAt = new Map<number, number>([[skillInfo(s, 'Ranged').baseLevel, 0]]);
    const bad = new Map<number, number>();
    let targetIdx: number | undefined;
    let seenBalls = countInv([ITEM_IDS.cannonball]);

    tally.pull();
    let empty0 = emptySeen();
    let gone0 = goneSeen();
    let poison0 = poisonSeen();
    let empty = false;
    let maxSaw = skillInfo(s, 'Ranged').baseLevel;

    const sendDirect = async (action: any): Promise<{ success?: boolean }> =>
        ((await s.direct(action)) as { success?: boolean } | undefined) ?? {};

    const reloadOnce = async (): Promise<boolean> => {
        const balls = inv().find(i => i.id === ITEM_IDS.cannonball);
        const loc = cannonAt(cannon) ?? { x: cannon.x, z: cannon.z, id: cannon.id };
        if (!balls || balls.slot === undefined) return false;
        const r = await sendDirect({ type: 'useItemOnLoc', itemSlot: balls.slot, x: loc.x, z: loc.z, locId: loc.id, reason: 'SDK' });
        return !!r.success;
    };

    const off = s.onTick(() => {
        tally.pull();
        if (emptySeen() > empty0) {
            empty0 = emptySeen();
            empty = true;
        }
        const nowBalls = countInv([ITEM_IDS.cannonball]);
        if (nowBalls < seenBalls) {
            lastLoad = s.tick();
            empty = false;
            loadPending = -1;
        }
        seenBalls = nowBalls;
    });

    try {
        while (!stop() && skillInfo(s, 'Ranged').baseLevel < 99) {
            const now = s.tick();
            const r = skillInfo(s, 'Ranged');
            if (r.baseLevel > maxSaw) {
                for (let lv = maxSaw + 1; lv <= r.baseLevel; lv++) bandAt.set(lv, now - combatT0);
                maxSaw = r.baseLevel;
            }
            if (r.baseLevel >= 99) break;

            // 1. Level-up modal pauses cannon_rotate and attacks: clear immediately.
            if (st()?.dialog?.isOpen || st()?.modalOpen) {
                await sendDirect({ type: 'closeModal', reason: 'SDK' });
                targetIdx = undefined;
                await waitTicks(s, 1);
                continue;
            }

            // Keep Protect from Melee, Auto-Retaliate, and Rapid style active without interrupting combat.
            const prayPts = st()?.prayers?.prayerPoints ?? 0;
            if (!st()?.prayers?.activePrayers?.[PROTECT_MELEE] && prayPts > 0) {
                await sendDirect({ type: 'togglePrayer', prayerIndex: PROTECT_MELEE, reason: 'SDK' });
            }
            if (st()?.autoRetaliateEnabled === false) {
                await sendDirect({ type: 'clickComponent', componentId: RETALIATE_ON, reason: 'SDK' });
            }
            if (st()?.combatStyle?.currentStyle !== 1) {
                await sendDirect({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
            }

            // 2. Sustain (eating/drinking clears active NPC target, so re-acquire next tick).
            const hpStat = skillInfo(s, 'Hitpoints');
            if (hpStat.level > 0 && hpStat.level <= Math.max(8, Math.floor(hpStat.baseLevel * 0.25))) {
                const food = inv().find(i => ITEM_IDS.cake.includes(i.id));
                if (food && food.slot !== undefined) {
                    const res = await sendDirect({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
                    if (res.success) { targetIdx = undefined; await waitTicks(s, 1); continue; }
                }
            }

            const basePray = skillInfo(s, 'Prayer').baseLevel;
            if (shouldDrinkSuperRestore(prayPts, basePray)) {
                const pot = inv().find(i => ITEM_IDS.superRestore.includes(i.id));
                if (pot && pot.slot !== undefined) {
                    const res = await sendDirect({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                    if (res.success) { restores++; targetIdx = undefined; await waitTicks(s, 1); continue; }
                }
            }

            const poisonedNow = poisonSeen() > poison0;
            if (shouldDrinkAntipoison(poisonedNow, now - lastAnti)) {
                const pot = inv().find(i => ITEM_IDS.antipoison.includes(i.id));
                if (pot && pot.slot !== undefined) {
                    const res = await sendDirect({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                    if (res.success) { poison0 = poisonSeen(); lastAnti = now; antis++; targetIdx = undefined; await waitTicks(s, 1); continue; }
                }
            }

            if (now - lastRPot >= 12 && shouldDrinkRanging(r.baseLevel, r.level, totalDoses(inv(), ITEM_IDS.rangingPot))) {
                const pot = inv().find(i => ITEM_IDS.rangingPot.includes(i.id));
                if (pot && pot.slot !== undefined) {
                    const res = await sendDirect({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
                    if (res.success) { lastRPot = now; rangePots++; targetIdx = undefined; await waitTicks(s, 1); continue; }
                }
            }

            // 3. Tier weapon and armor upgrades.
            const curWorn = worn();
            const wantWeapon = chooseDesiredWeapon(r.baseLevel, inv(), curWorn, variant);
            if (wantWeapon) {
                await equipItemFast(s, wantWeapon);
                await sendDirect({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
                currentWeapon = wantWeapon.id;
                targetIdx = undefined;
                await waitTicks(s, 1);
                continue;
            }
            const actualWep = curWorn.find(w => w.slot === WEAPON_SLOT)?.id;
            if (actualWep && actualWep !== currentWeapon) {
                await sendDirect({ type: 'setCombatStyle', style: 1, reason: 'SDK' });
                currentWeapon = actualWep;
            }
            const wantArmor = chooseDesiredArmor(r.baseLevel, inv(), curWorn);
            if (wantArmor) {
                await equipItemFast(s, wantArmor);
                await waitTicks(s, 1);
                continue;
            }

            // 4. Refresh decaying cannon or re-setup if destroyed.
            missingLocStreak = cannonAt(cannon) ? 0 : missingLocStreak + 1;
            if (goneSeen() > gone0 || missingLocStreak >= 3) {
                gone0 = goneSeen();
                missingLocStreak = 0;
                if (ITEM_IDS.cannonParts.some(id => countInv([id]) === 0)) {
                    throw Error('cannon missing and parts not in pack');
                }
                const nextCannon = await ensureCannonSetup(s, spotCentre, stop);
                cannon.x = nextCannon.x; cannon.z = nextCannon.z; cannon.id = nextCannon.id;
                placedAt = s.tick(); lastLoad = s.tick(); loadPending = -1; needFire = false; refills++; targetIdx = undefined;
                await waitTicks(s, 1);
                continue;
            } else if (now - placedAt >= CANNON_REFRESH) {
                if (await pickupCannon(s, cannon)) {
                    const nextCannon = await ensureCannonSetup(s, spotCentre, stop);
                    cannon.x = nextCannon.x; cannon.z = nextCannon.z; cannon.id = nextCannon.id;
                    placedAt = s.tick(); lastLoad = s.tick(); loadPending = -1; needFire = false; refills++; targetIdx = undefined;
                    await waitTicks(s, 1);
                    continue;
                }
            }

            // 5. Cannon load and fire state machine.
            if (loadPending >= 0) {
                if (loadSeen() <= loadMark && now - loadPending < 5) {
                    await waitTicks(s, 1);
                    continue;
                }
                loadPending = -1;
                if (needFire) {
                    needFire = false;
                    const loc = cannonAt(cannon) ?? { x: cannon.x, z: cannon.z, id: cannon.id };
                    await sendDirect({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: 1, reason: 'SDK' });
                    firePending = now;
                    targetIdx = undefined;
                    await waitTicks(s, 1);
                    continue;
                }
            }
            if (firePending >= 0 && now - firePending < 2) {
                await waitTicks(s, 1);
                continue;
            }
            firePending = -1;

            if (reloadDue({ now, lastLoad, interval: 25, empty }) && countInv([ITEM_IDS.cannonball]) > 0) {
                if (empty) { needFire = true; empty = false; }
                loadMark = loadSeen();
                if (await reloadOnce()) {
                    loadPending = now;
                    lastLoad = now;
                    reloads++;
                    targetIdx = undefined;
                    await waitTicks(s, 1);
                    continue;
                }
            }

            // 6. Special attack (Magic shortbow) and target engagement.
            const p = posOf(s);
            const me = { x: p?.worldX ?? cannon.centre.x, z: p?.worldZ ?? cannon.centre.z };
            const hx = skillInfo(s, 'Hitpoints').experience;
            if (hx > lastHpXp) { lastHpXp = hx; lastGain = now; }

            const reach = weaponReach(curWorn);
            const npcs: TargetNpc[] = (st()?.nearbyNpcs ?? []) as TargetNpc[];
            const alive = targetIdx !== undefined ? npcs.find(n => n.index === targetIdx && (n.hp ?? 1) > 0 && d8(me, n) <= reach) : undefined;
            const fighting = !!alive && (now - lastGain < 10 || now - lastAttack < 10);

            if (
                fighting
                && now - lastSpec >= 3
                && specialDue({
                    special: variant === 'msb',
                    weapon: currentWeapon,
                    energy: cvar(300),
                    enabled: cvar(301),
                    fighting,
                })
            ) {
                await s.sdk.sendClickComponent(componentId('combat_bow:specbar'));
                specials++;
                lastSpec = now;
            }

            if (!fighting) {
                if (targetIdx !== undefined && now - lastAttack >= 10) bad.set(targetIdx, now + 20);
                if (!isAdjacentToCannon(me, cannon)) {
                    const w = await sessionWalker(s);
                    await walkPath(w, [{ x: stand.x, z: stand.z, tol: 0 }], { maxTicks: 8, stop });
                }
                for (const [k, until] of bad) if (now >= until) bad.delete(k);
                const pick = pickTarget(npcs, {
                    target: new RegExp(spot.target, 'i'),
                    centre: cannon.centre,
                    me,
                    near: 12,
                    reach,
                    skip: idx => (bad.get(idx) ?? 0) > now,
                });
                if (pick && now - lastAttack >= 2) {
                    const op = pick.optionsWithIndex?.find(o => /attack/i.test(o.text))?.opIndex ?? 2;
                    const atk = await sendDirect({ type: 'interactNpc', npcIndex: pick.index, optionIndex: op, reason: 'SDK' });
                    if (atk.success) { targetIdx = pick.index; lastAttack = now; }
                    else bad.set(pick.index, now + 4);
                }
            } else if (alive) {
                targetIdx = alive.index;
            }

            await waitTicks(s, 1);
        }
    } finally {
        off();
    }

    const combatTicks = s.tick() - combatT0;
    console.log('BAND_TICKS ' + JSON.stringify(bandTicks(bandAt, [1, 20, 40, 50, 70, 85, 95, 99])));
    console.log(`SPIDER_SUMMARY variant=${variant} setupTicks=${cannon.setupTicks} combatTicks=${combatTicks} reloads=${reloads} specials=${specials} refills=${refills} rangePots=${rangePots} restores=${restores} antis=${antis} prayLeft=${st()?.prayers?.prayerPoints ?? 0} ballsLeft=${countInv([ITEM_IDS.cannonball])}`);
    return { setupTicks: cannon.setupTicks, combatTicks, reloads, specials, refills, rangePots, restores, antis, cannon };
}

export interface RangedSpecialistOptions {
    bot: string;
    cap?: number;
    variant?: RangedKitVariant;
    supplier?: string;
    benchSupplier?: string;
    benchSupplier2?: string;
    spotCentre?: { x: number; z: number; level: number };
}

export async function runRangedSpecialist(opts: RangedSpecialistOptions): Promise<void> {
    process.env.LOOT_WATCH ??= '0';
    process.env.PRAYER_GUARD ??= '0';
    process.env.EAT_GUARD ??= '0';
    process.env.FLEE_GUARD ??= '0';

    const CAP = opts.cap ?? Number(process.env.CAP ?? 4800);
    const variant: RangedKitVariant = opts.variant ?? (process.env.VARIANT === 'msb' ? 'msb' : 'knives');
    const kit = variantKit(variant);
    const { trade1, trade2 } = variantTrades(variant);
    const spotCentre = opts.spotCentre ?? SPIDERS_CENTRE;
    const root = resolve(import.meta.dir, '..');
    const serverHost = readServerHost(root, opts.bot);
    const benchSupName = (opts.benchSupplier || process.env.BENCH_SUPPLIER || '').trim();
    const benchSup2Name = (opts.benchSupplier2 || process.env.BENCH_SUPPLIER2 || '').trim();
    const [s, benchSup, benchSup2] = await Promise.all([
        openBot(opts.bot),
        benchSupName ? openBot(benchSupName, { onSessionEnd: async () => {}, onStop: async () => {} }) : Promise.resolve(undefined),
        benchSup2Name ? openBot(benchSup2Name, { onSessionEnd: async () => {}, onStop: async () => {} }) : Promise.resolve(undefined),
    ]);
    if (!serverHost) {
        if (benchSup) { await logoutSession(benchSup).catch(() => {}); await closeWithin([benchSup], 3000).catch(() => {}); }
        if (benchSup2) { await logoutSession(benchSup2).catch(() => {}); await closeWithin([benchSup2], 3000).catch(() => {}); }
        await finish([s], false, `missing SERVER in bot.env for ${opts.bot}`);
        return;
    }

    let ended = false;
    let finished = false;
    void s.ended?.then(() => { ended = true; });
    const t0 = s.tick();
    const elapsed = () => s.tick() - t0;
    const stop: StopFn = () =>
        ended
        || finished
        || elapsed() >= CAP
        || existsSync(join(root, '.practice', `stop-${opts.bot}`))
        || (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
    const milestone = (step: string, extra = '') => {
        console.log(`MILESTONE ${step} tick=${elapsed()}${extra ? ' ' + extra : ''}`);
    };

    const companionTask1 = benchSup ? serveBenchCompanion(benchSup, opts.bot, trade1, stop, 300) : undefined;
    const companionTask2 = benchSup2 ? serveBenchCompanion(benchSup2, opts.bot, trade2, stop, Math.max(2500, CAP)) : undefined;
    try {
        const supplierName = (benchSupName || opts.supplier || process.env.PRACTICE_SUPPLIER || process.env.SUPPLIER || '').trim();
        const supplierName2 = (benchSup2Name || supplierName).trim();
        if (!supplierName) throw Error('missing SUPPLIER / PRACTICE_SUPPLIER / BENCH_SUPPLIER');

        milestone('start', `variant=${variant}`);
        await leaveRuneStarter(s, stop);
        if (onStarterIsland(posOf(s)) || posOf(s)?.level !== 0) {
            throw Error('still on Tutorial Island after leaveRuneStarter');
        }
        const allowed = new Set(kit.map(k => k.id));
        await dropItemsMatching(s, i => !allowed.has(i.id), stop, 'tutorial junk');
        milestone('tutorial');

        await receiveSupplyKit(s, supplierName, trade1, stop, LUMBRIDGE_HANDOFF);
        if (companionTask1) await companionTask1;
        milestone('kit', `slots=${s.sdk.getInventory().length}`);

        await equipEarlyGearAndBuryBones(s, variant, stop);
        milestone('prayer43', `prayer=${skillInfo(s, 'Prayer').baseLevel}`);

        await topUpEnergy(s, 80, stop);
        await rubJewellery(s, ITEM_IDS.duelRings, /castle wars/i, CASTLE_WARS, 10, stop, 'castle wars 1');
        milestone('cwars1');
        await walkWaypoints(s, CWARS_TO_LAWGOF_PATH, 320, stop, 'cwars to lawgof');
        milestone('lawgof_arrive');

        const offDcEnergy = attachEnergySipper(s, stop, { threshold: 55, requireMoving: true });
        let dc: { ok: boolean; craftingXp: number; detail: string };
        try {
            dc = await runDwarfCannon({
                session: s,
                cap: Math.max(300, CAP - elapsed()),
                eatAt: 5,
                protectCaveMelee: true,
                stop,
                travelToNulodion: async ({ s: qs }) => {
                    await topUpEnergy(qs, 70, stop);
                    await rubJewellery(qs, ITEM_IDS.glories, /edgeville/i, EDGEVILLE, 10, stop, 'edgeville nulodion');
                },
                travelBackFromNulodion: async ({ s: qs }) => {
                    await topUpEnergy(qs, 80, stop);
                    await rubJewellery(qs, ITEM_IDS.duelRings, /castle wars/i, CASTLE_WARS, 10, stop, 'castle wars 2');
                    await walkWaypoints(qs, CWARS_TO_LAWGOF_PATH, 280, stop, 'cwars back to commander');
                },
            });
        } finally {
            offDcEnergy();
        }
        if (!dc.ok) throw Error(`Dwarf Cannon incomplete: ${dc.detail}`);
        milestone('dwarfcannon', `crafting=${dc.craftingXp}`);

        await rubJewellery(s, ITEM_IDS.glories, /edgeville/i, EDGEVILLE, 10, stop, 'edgeville spiders');
        const gloryEarly = (s.sdk.getInventory() as InvItem[]).find(i => ITEM_IDS.gloriesAll.includes(i.id));
        if (gloryEarly) await equipItemFast(s, gloryEarly);

        await topUpEnergy(s, 85, stop);

        // Drop toolkit, duel ring, empty vials, Super energy leftovers, and partial cakes before Edgeville Trade 2.
        await dropItemsMatching(
            s,
            i => i.id === ITEM_IDS.toolkit
                || i.id === ITEM_IDS.vial
                || ITEM_IDS.duelRings.includes(i.id)
                || ITEM_IDS.superEnergy.includes(i.id)
                || ITEM_IDS.cake.includes(i.id),
            stop,
            'quest leftovers',
        );

        await receiveSupplyKit(s, supplierName2, trade2, stop, EDGEVILLE_HANDOFF);
        if (companionTask2) await companionTask2;
        if (variant === 'msb') {
            const arrows = (s.sdk.getInventory() as InvItem[]).find(i => i.id === ITEM_IDS.runeArrow);
            if (arrows) await equipItemFast(s, arrows);
        }
        milestone('edgeville', `slots=${s.sdk.getInventory().length}`);

        await walkEdgevilleToSpiders(s, spotCentre, stop);
        milestone('spiders_arrive', `at=${posOf(s)?.worldX},${posOf(s)?.worldZ}`);

        const grind = await runSpiderGrind(s, variant, spotCentre, stop);
        milestone('ranged99', `ranged=${skillInfo(s, 'Ranged').baseLevel} xp=${skillInfo(s, 'Ranged').experience} combatTicks=${grind.combatTicks}`);

        const picked = await pickupCannon(s, grind.cannon);
        await walkWaypoints(s, [{ x: SPIDERS_CLEAR.x, z: SPIDERS_CLEAR.z, tol: 3 }], 120, stop, 'clear spiders');
        await setProtectMelee(s, false, stop);
        await dismissContinueDialogs(s, stop, 4);
        await s.bot.dismissBlockingUI();

        const rStat = skillInfo(s, 'Ranged');
        const hpStat = skillInfo(s, 'Hitpoints');
        const prayStat = skillInfo(s, 'Prayer');
        const ok = rStat.baseLevel >= 99 && !stop();
        const detail = `ranged=${rStat.baseLevel} rangedXp=${rStat.experience} hp=${hpStat.baseLevel} prayer=${prayStat.baseLevel} picked=${picked} reloads=${grind.reloads} rangePots=${grind.rangePots} restores=${grind.restores} antis=${grind.antis} ticks=${elapsed()}`;
        milestone('complete', detail);
        await finish([s], ok, detail);
    } catch (e) {
        await finish([s], false, String(e));
    } finally {
        finished = true;
        await Promise.allSettled([companionTask1, companionTask2].filter(Boolean));
    }
}

export function parseSpecialistArgs(argv: readonly string[]): RangedSpecialistOptions {
    const bot = argv[0] ?? '';
    if (!bot) throw Error('usage: ranged-specialist.ts <bot> [cap] [VARIANT=knives|msb] [BENCH_SUPPLIER=name] [SPOT_X=3287] [SPOT_Z=3810]');
    const kv = new Map<string, string>();
    let cap: number | undefined;
    for (const a of argv.slice(1)) {
        if (/^\d+$/.test(a)) cap = Number(a);
        else {
            const m = a.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m) kv.set(m[1]!, m[2]!);
        }
    }
    const variantRaw = kv.get('VARIANT') ?? process.env.VARIANT;
    const variant: RangedKitVariant = variantRaw === 'msb' ? 'msb' : 'knives';
    const sx = Number(kv.get('SPOT_X') ?? process.env.SPOT_X ?? SPIDERS_CENTRE.x);
    const sz = Number(kv.get('SPOT_Z') ?? process.env.SPOT_Z ?? SPIDERS_CENTRE.z);
    return {
        bot,
        cap: cap ?? (kv.has('CAP') ? Number(kv.get('CAP')) : undefined),
        variant,
        supplier: kv.get('SUPPLIER'),
        benchSupplier: kv.get('BENCH_SUPPLIER'),
        benchSupplier2: kv.get('BENCH_SUPPLIER2'),
        spotCentre: { x: sx, z: sz, level: 0 },
    };
}

if (import.meta.main) {
    const opts = parseSpecialistArgs(process.argv.slice(2));
    await runRangedSpecialist(opts);
}
