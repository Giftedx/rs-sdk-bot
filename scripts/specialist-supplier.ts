// Stage and hand off a specialist supply kit with observed bank and trade receipts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { accountOf, finish, getWorld, openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { planTripOffThread } from '../packages/core/src/route-plan';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { goTo, sessionWalker, walkPath, walkRoute, withoutSpells, withoutTeleports } from '../packages/core/src/walk';
import { DEFENCE_SPECIALIST_KIT, HP_SPECIALIST_KIT, STRENGTH_SPECIALIST_KIT } from './combat-quest-specialists';
import { CRAFTING_BATCHES, CRAFTING_SUPPLY_BILL } from './crafting-specialist';
import {
    findLocBy,
    GLORY_IDS,
    ITEM_IDS,
    loadItemCatalog,
    playerPos,
    restockAtBank,
    TRADE_CONFIRM_ACCEPT,
    TRADE_MAIN_ACCEPT,
    TRADE_OFFER_INV,
} from './fast-skills-lib';
import { HERBLORE_BANK_HELPER_SPOT, HERBLORE_NOTED_BATCH, HERBLORE_STARTER_BATCH, HERBLORE_SUPPLY_BILL } from './herblore-specialist';
import { LUMBRIDGE_SAFE_SPOT, MAGIC_BATCHES, MAGIC_SUPPLY_BILL } from './magic-specialist';
import { PRAYER_BONES_NEEDED, PRAYER_SUPPLY_BILL } from './prayer-specialist';
import {
    EDGEVILLE_SUPPLIER_STAND,
    RANGED_SPECIALIST_KIT,
    RANGED_SPECIALIST_LIVE_KIT,
    RANGED_SPECIALIST_MSB_KIT,
    variantTrades,
} from './ranged-specialist';
export { buildLeatherBodyShopInvocation, planPrayerBrewBatch, planPrayerDecantSteps } from './ranged-live-prep';
import { BODY_ALTAR_STAND, BODY_RUINS, EDGEVILLE_BANK, RUNECRAFT_SUPPLY_BILL } from './runecraft-specialist';
import { SMITHING_RUNNER_QUEUE, SMITHING_SUPPLY_BILL, VARROCK_WEST_ANVIL, VARROCK_WEST_BANK } from './smithing-specialist';

export { EDGEVILLE_BANK };

export interface KitSpecItem {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly stackable: boolean;
    readonly altIds?: readonly number[];
}

// 28 inventory slots exact: 5 stackables + 1 staff + 11 bones + 6 logs + 3 prayer potions + 2 lobsters.
export const ATTACK_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1387, name: 'Staff of fire', count: 1, stackable: false },
    { id: 558, name: 'Mind rune', count: 50, stackable: true },
    { id: 556, name: 'Air rune', count: 1300, stackable: true },
    { id: 563, name: 'Law rune', count: 30, stackable: true },
    { id: 562, name: 'Chaos rune', count: 240, stackable: true },
    { id: 995, name: 'Coins', count: 200, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 1511, name: 'Logs', count: 6, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 379, name: 'Lobster', count: 2, stackable: false },
] as const;

// 21 inventory slots exact: 1 stackable (500 coins) + 1 glory + 11 dragon bones + 3 prayer pots + 5 chocolate cake (100% in stock).
export const AGILITY_SPECIALIST_NOPOT_KIT: readonly KitSpecItem[] = [
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 500, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 5, stackable: false },
] as const;

// 28 inventory slots exact: 1 stackable (500 coins) + 1 glory + 11 dragon bones + 3 prayer pots + 6 agility pots + 2 super energy + 4 cakes.
export const AGILITY_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 500, stackable: true },
    { id: 536, name: 'Dragon bones', count: 11, stackable: false },
    { id: 2434, name: 'Prayer potion(4)', count: 3, stackable: false },
    { id: 3032, name: 'Agility potion(4)', count: 6, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 1897, name: 'Chocolate cake', count: 4, stackable: false },
] as const;

export const AGILITY_SPECIALIST_POTION_KIT: readonly KitSpecItem[] = AGILITY_SPECIALIST_KIT;

// 7 stackable slots: exact 240 arrow-fletching actions (1-99, 0 spare buffer; 100% in local stock).
export const FLETCHING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 39, name: 'Bronze arrowtips', count: 60, stackable: true },
    { id: 40, name: 'Iron arrowtips', count: 90, stackable: true },
    { id: 41, name: 'Steel arrowtips', count: 135, stackable: true },
    { id: 42, name: 'Mithril arrowtips', count: 225, stackable: true },
    { id: 43, name: 'Adamant arrowtips', count: 495, stackable: true },
    { id: 44, name: 'Rune arrowtips', count: 2595, stackable: true },
    { id: 53, name: 'Headless arrow', count: 3600, stackable: true },
] as const;

export const FLETCHING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = FLETCHING_SPECIALIST_KIT;

// 12 inventory slots: nets/rods/bait/feathers + knife + 5 logs + glory for 3t Sea Slug/Trio/Barbarian fishing.
export const FISHING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 303, name: 'Small fishing net', count: 1, stackable: false },
    { id: 307, name: 'Fishing rod', count: 1, stackable: false },
    { id: 309, name: 'Fly fishing rod', count: 1, stackable: false },
    { id: 313, name: 'Fishing bait', count: 60, stackable: true },
    { id: 314, name: 'Feather', count: 1500, stackable: true },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 5, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false, altIds: [1710, 1708] },
] as const;

// 21 inventory slots: Doric quest ores + Rune pickaxe + 3t knife/logs + coins + glory + 2x super energy + games neck.
export const MINING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 434, name: 'Clay', count: 6, stackable: false },
    { id: 436, name: 'Copper ore', count: 4, stackable: false },
    { id: 440, name: 'Iron ore', count: 2, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 995, name: 'Coins', count: 150, stackable: true },
    { id: 1275, name: 'Rune pickaxe', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 2, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 2, stackable: false },
    { id: 3853, name: 'Games necklace(8)', count: 1, stackable: false },
] as const;

// 18 inventory slots: live Mining kit (0 Games necklace, 0 Super energy, 0 Coins) using 1 Glory(4) + Ring of dueling(8).
export const MINING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = [
    { id: 434, name: 'Clay', count: 6, stackable: false },
    { id: 436, name: 'Copper ore', count: 4, stackable: false },
    { id: 440, name: 'Iron ore', count: 2, stackable: false },
    { id: 946, name: 'Knife', count: 1, stackable: false },
    { id: 1275, name: 'Rune pickaxe', count: 1, stackable: false },
    { id: 1511, name: 'Logs', count: 2, stackable: false },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
] as const;

// 28 inventory slots: coins + glory + super energy(4) + 25 pineapple pizzas for Ardougne pickpocketing.
export const THIEVING_SPECIALIST_KIT: readonly KitSpecItem[] = [
    { id: 995, name: 'Coins', count: 200, stackable: true },
    { id: 1712, name: 'Amulet of glory(4)', count: 1, stackable: false },
    { id: 2301, name: 'Pineapple pizza', count: 25, stackable: false },
    { id: 3016, name: 'Super energy(4)', count: 1, stackable: false },
] as const;

const STACKABLE_IDS = new Set<number>([
    995,
    ITEM_IDS.airrune,
    ITEM_IDS.waterrune,
    ITEM_IDS.earthrune,
    ITEM_IDS.firerune,
    ITEM_IDS.mindrune,
    ITEM_IDS.cosmicrune,
    ITEM_IDS.lawrune,
    ITEM_IDS.bloodrune,
    ITEM_IDS.bodyrune,
]);

const billToKit = (bill: readonly { itemId: number; item: string; count: number }[]): readonly KitSpecItem[] =>
    bill.map(b => ({ id: b.itemId, name: b.item, count: b.count, stackable: STACKABLE_IDS.has(b.itemId) }));

export const PRAYER_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(PRAYER_SUPPLY_BILL);
export const SMITHING_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(SMITHING_SUPPLY_BILL);
export const RUNECRAFT_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(RUNECRAFT_SUPPLY_BILL);
export const CRAFTING_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(CRAFTING_SUPPLY_BILL);
export const HERBLORE_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(HERBLORE_SUPPLY_BILL);
export const MAGIC_SPECIALIST_KIT: readonly KitSpecItem[] = billToKit(MAGIC_SUPPLY_BILL);

// 28 inventory slots: live Thieving kit using Ring of dueling(8) + 27 Chocolate cakes (405 HP; Ring dropped after Castle Wars teleport).
export const THIEVING_SPECIALIST_LIVE_KIT: readonly KitSpecItem[] = [
    { id: 1897, name: 'Chocolate cake', count: 27, stackable: false },
    { id: 2552, name: 'Ring of dueling(8)', count: 1, stackable: false },
] as const;

export const SPECIALIST_KITS = {
    attack: ATTACK_SPECIALIST_KIT,
    agility: AGILITY_SPECIALIST_KIT,
    hitpoints: HP_SPECIALIST_KIT,
    strength: STRENGTH_SPECIALIST_KIT,
    defence: DEFENCE_SPECIALIST_KIT,
    ranged: RANGED_SPECIALIST_KIT,
    'ranged-msb': RANGED_SPECIALIST_MSB_KIT,
    'ranged-live': RANGED_SPECIALIST_LIVE_KIT,
    fletching: FLETCHING_SPECIALIST_KIT,
    'fletching-live': FLETCHING_SPECIALIST_LIVE_KIT,
    fishing: FISHING_SPECIALIST_KIT,
    mining: MINING_SPECIALIST_KIT,
    'mining-live': MINING_SPECIALIST_LIVE_KIT,
    thieving: THIEVING_SPECIALIST_KIT,
    'thieving-live': THIEVING_SPECIALIST_LIVE_KIT,
    prayer: PRAYER_SPECIALIST_KIT,
    smithing: SMITHING_SPECIALIST_KIT,
    runecraft: RUNECRAFT_SPECIALIST_KIT,
    crafting: CRAFTING_SPECIALIST_KIT,
    herblore: HERBLORE_SPECIALIST_KIT,
    magic: MAGIC_SPECIALIST_KIT,
} as const satisfies Record<string, readonly KitSpecItem[]>;

export type SpecialistKitName = keyof typeof SPECIALIST_KITS;
export type SupplierKitName = SpecialistKitName;

export function parseKitOption(args: readonly string[]): { name: SpecialistKitName; kit: readonly KitSpecItem[] } | null;
export function parseKitOption(args: readonly string[], defaultName: SpecialistKitName): { name: SpecialistKitName; kit: readonly KitSpecItem[] };
export function parseKitOption(
    args: readonly string[],
    defaultName?: SpecialistKitName,
): { name: SpecialistKitName; kit: readonly KitSpecItem[] } | null {
    const rawInput = args.find(a => a.startsWith('--kit='))?.slice(6).trim().toLowerCase();
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    if (!raw) return defaultName ? { name: defaultName, kit: SPECIALIST_KITS[defaultName] } : null;
    if (!(raw in SPECIALIST_KITS)) {
        throw Error(`specialist-supplier: unknown --kit=${rawInput}; expected ${Object.keys(SPECIALIST_KITS).join('|')}`);
    }
    const name = raw as SpecialistKitName;
    return { name, kit: SPECIALIST_KITS[name] };
}

export function parseKitArg(args: readonly string[], env: Record<string, string | undefined> = process.env): SpecialistKitName {
    const rawInput = (args.find(a => a.startsWith('--kit='))?.slice(6) ?? env.SUPPLIER_KIT ?? 'attack').trim().toLowerCase();
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    if (raw in SPECIALIST_KITS) return raw as SpecialistKitName;
    throw Error(`unknown --kit: ${rawInput} (expected ${Object.keys(SPECIALIST_KITS).join('|')})`);
}

export function resolveSupplierKit(kitName: SpecialistKitName): readonly KitSpecItem[] {
    return SPECIALIST_KITS[kitName];
}

let certToBaseMap: Map<number, number> | null = null;

/** Maps noted cert_<name> item IDs to their unnoted base ID using obj.pack. */
export function resolveBaseId(id: number): number {
    if (!certToBaseMap) {
        const packPath = resolve(import.meta.dir, '../vendor/rs-sdk/server/content/pack/obj.pack');
        const byName = new Map<string, number>();
        const certs: Array<[number, string]> = [];
        for (const line of readFileSync(packPath, 'utf8').split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const parsedId = Number(line.slice(0, eq));
            const name = line.slice(eq + 1).trim();
            if (!Number.isFinite(parsedId) || !name) continue;
            if (name.startsWith('cert_')) certs.push([parsedId, name.slice(5)]);
            else byName.set(name, parsedId);
        }
        const map = new Map<number, number>();
        for (const [certId, baseName] of certs) {
            const base = byName.get(baseName);
            if (base !== undefined) map.set(certId, base);
        }
        certToBaseMap = map;
    }
    return certToBaseMap.get(id) ?? id;
}

export const LUMBRIDGE_HANDOFF = { x: 3222, z: 3222, level: 0 } as const;
export const DEFAULT_STAGE_BANK = { x: 3092, z: 3243, level: 0 } as const;
const ACCOUNT_RE = /^[A-Za-z0-9_ -]{1,12}$/;

export interface SupplierTradeLeg {
    readonly kit: readonly KitSpecItem[];
    readonly handoff: { readonly x: number; readonly z: number; readonly level: number };
    readonly bank: { readonly x: number; readonly z: number; readonly level: number };
    readonly noted?: boolean;
}

export interface SupplierKitPlan {
    readonly name: SupplierKitName;
    readonly legs: readonly SupplierTradeLeg[];
    readonly combined: readonly KitSpecItem[];
}

export function resolveSupplierKitPlan(kitName: string | undefined = process.env.SUPPLIER_KIT): SupplierKitPlan {
    const rawInput = (kitName ?? 'attack').trim().toLowerCase() || 'attack';
    const raw = rawInput === 'hp' ? 'hitpoints' : rawInput;
    const rangedVariant = raw === 'ranged' || raw === 'ranged-knives' ? 'knives'
        : raw === 'ranged-msb' ? 'msb'
        : raw === 'ranged-live' ? 'live'
        : null;
    if (rangedVariant) {
        const name: SupplierKitName = rangedVariant === 'knives' ? 'ranged' : rangedVariant === 'msb' ? 'ranged-msb' : 'ranged-live';
        const { trade1, trade2 } = variantTrades(rangedVariant);
        return {
            name,
            legs: [
                { kit: trade1, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
                { kit: trade2, handoff: EDGEVILLE_SUPPLIER_STAND, bank: EDGEVILLE_BANK },
            ],
            combined: SPECIALIST_KITS[name],
        };
    }
    if (raw === 'herblore') {
        return {
            name: 'herblore',
            legs: [
                { kit: HERBLORE_STARTER_BATCH.give.map(g => invSpec(g.id, g.count)), handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK },
                { kit: HERBLORE_NOTED_BATCH.give.map(g => invSpec(resolveBaseId(g.id), g.count)), handoff: HERBLORE_BANK_HELPER_SPOT, bank: EDGEVILLE_BANK, noted: true },
            ],
            combined: SPECIALIST_KITS.herblore,
        };
    }
    if (raw in SPECIALIST_KITS) {
        const name = raw as SupplierKitName;
        const kit = SPECIALIST_KITS[name];
        return {
            name,
            legs: [{ kit, handoff: LUMBRIDGE_HANDOFF, bank: DEFAULT_STAGE_BANK }],
            combined: kit,
        };
    }
    throw Error(`specialist-supplier: unknown kit "${kitName}" (expected ${Object.keys(SPECIALIST_KITS).join('|')})`);
}

export function buildLegDeliveryReceipt(o: {
    kitName: SupplierKitName;
    leg: number;
    totalLegs: number;
    server: string;
    from: string;
    to: string;
    at: number;
    before: readonly { id: number; count: number }[];
    after: readonly { id: number; count: number }[];
    kit: readonly KitSpecItem[];
    legs?: readonly string[];
}) {
    return {
        ok: true,
        observed: true,
        kit: o.kitName,
        leg: o.leg,
        totalLegs: o.totalLegs,
        ...(o.legs ? { legs: o.legs } : {}),
        server: o.server,
        from: o.from,
        to: o.to,
        at: o.at,
        before: o.before.map(i => ({ id: i.id, count: i.count })),
        after: o.after.map(i => ({ id: i.id, count: i.count })),
        items: o.kit.map(k => ({ id: resolveBaseId(k.id), count: k.count })),
    };
}

export type SupplierRole = 'auto' | 'starter' | 'runner';

export function parseSupplierRole(
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): SupplierRole {
    const raw = (args.find(a => a.startsWith('--role='))?.slice(7) ?? env.SUPPLIER_ROLE ?? 'auto').trim().toLowerCase();
    if (!raw || raw === 'auto') return 'auto';
    if (raw === 'starter' || raw === 'runner') return raw;
    throw Error(`specialist-supplier: unknown --role=${raw}; expected starter|runner|auto`);
}

export function parseSupplierCliArgs(args: readonly string[]): {
    kitArg?: string;
    cap?: number;
    outArg?: string;
    bankX?: number;
    bankZ?: number;
    batchIndex?: number;
    runnerIndex?: number;
    runnerCount?: number;
    positional: string[];
} {
    const kitArg = args.find(a => a.startsWith('--kit='))?.slice(6);
    const outArg = args.find(a => a.startsWith('--out='))?.slice(6);
    const bxRaw = args.find(a => a.startsWith('--bank-x='))?.slice(9);
    const bzRaw = args.find(a => a.startsWith('--bank-z='))?.slice(9);
    const batchRaw = args.find(a => a.startsWith('--batch='))?.slice(8);
    const runnerRaw = args.find(a => a.startsWith('--runner='))?.slice(9);
    let batchIndex: number | undefined;
    if (batchRaw !== undefined) {
        if (!/^\d+$/.test(batchRaw)) throw Error(`specialist-supplier: invalid --batch=${batchRaw}`);
        batchIndex = Number(batchRaw);
    }
    let runnerIndex: number | undefined;
    let runnerCount: number | undefined;
    if (runnerRaw !== undefined) {
        const m = runnerRaw.match(/^(\d+)\/(\d+)$/);
        if (!m) throw Error(`specialist-supplier: invalid --runner=${runnerRaw} (expected <index>/<count>)`);
        runnerIndex = Number(m[1]);
        runnerCount = Number(m[2]);
        if (runnerCount < 1 || runnerIndex < 0 || runnerIndex >= runnerCount) {
            throw Error(`specialist-supplier: invalid --runner=${runnerRaw} (index out of bounds)`);
        }
    }
    const positional = args.filter(a => !a.startsWith('--'));
    const capCandidate = positional.length >= 3 && /^\d+$/.test(positional[2]!) ? Number(positional[2]) : undefined;
    return {
        kitArg,
        cap: capCandidate,
        outArg,
        bankX: bxRaw !== undefined ? Number(bxRaw) : undefined,
        bankZ: bzRaw !== undefined ? Number(bzRaw) : undefined,
        batchIndex,
        runnerIndex,
        runnerCount,
        positional,
    };
}

export const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const exactNameRe = (name: string): RegExp => new RegExp('^' + escapeRe(name) + '$', 'i');

export function kitRequirements(kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT) {
    return [...kit]
        .sort((a, b) => a.id - b.id)
        .map(item => ({ item: item.name, count: item.count, itemId: item.id }));
}

export function kitSlotTotal(kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): number {
    return kit.reduce((sum, item) => sum + (item.stackable ? 1 : item.count), 0);
}

const isNotedId = (id: number): boolean => resolveBaseId(id) !== id;

export function countById(items: readonly { id: number; baseId?: number; count?: number }[], id: number): number {
    const want = resolveBaseId(id);
    let total = 0;
    for (const item of items) {
        if ((item.baseId ?? resolveBaseId(item.id)) === want) total += item.count ?? 0;
    }
    return total;
}

const specIds = (spec: KitSpecItem): readonly number[] => (spec.altIds?.length ? [spec.id, ...spec.altIds] : [spec.id]);
const countForSpec = (items: readonly { id: number; baseId?: number; count?: number }[], spec: KitSpecItem): number =>
    specIds(spec).reduce((sum, id) => sum + countById(items, id), 0);

export function resolveConcreteKit(
    kit: readonly KitSpecItem[],
    items: readonly { id: number; baseId?: number; count?: number }[],
): readonly KitSpecItem[] {
    return kit.map(spec => {
        if (!spec.altIds?.length) return spec;
        const matchedId = specIds(spec).find(id => countById(items, id) >= spec.count);
        if (matchedId === undefined || matchedId === spec.id) return spec;
        return {
            id: matchedId,
            name: loadItemCatalog().get(matchedId)?.name ?? spec.name,
            count: spec.count,
            stackable: spec.stackable,
        };
    });
}

export function hasExactKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): boolean {
    const allowed = new Set(kit.flatMap(k => specIds(k).map(resolveBaseId)));
    if (items.some(i => !allowed.has(i.baseId ?? resolveBaseId(i.id)))) return false;
    return kit.every(spec =>
        countForSpec(items, spec) === spec.count
        && (!isNotedId(spec.id) || items.some(i => i.id === spec.id && (i.count ?? 0) >= spec.count)),
    );
}

export function hasAtLeastKit(items: readonly { id: number; baseId?: number; count?: number }[], kit: readonly KitSpecItem[] = ATTACK_SPECIALIST_KIT): boolean {
    return kit.every(spec => countForSpec(items, spec) >= spec.count);
}

export function assertSupplierAccount(name: string, label = 'account'): string {
    if (!name || !ACCOUNT_RE.test(name)) throw Error(`specialist-supplier: invalid ${label}: ${name}`);
    if (RESERVED_ACCOUNTS.includes(name.toLowerCase())) throw Error(`specialist-supplier: refuses reserved ${label}: ${name}`);
    return name;
}

function posNear(s: Session, to: { x: number; z: number; level: number }, tol = 2): boolean {
    const p = s.sdk.getState()?.player;
    return !!p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= tol;
}

/** Walk a ground-only route without bank stops or teleport spells so full-inventory kit suppliers never trigger rune withdrawals. */
export async function moveGroundTo(
    s: Session,
    to: { x: number; z: number; level: number },
    tol = 2,
    stop: () => boolean = () => false,
    legTimeoutTicks = 150,
): Promise<void> {
    if (posNear(s, to, tol)) return;
    const p = s.sdk.getState()?.player;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 24) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol }], { maxTicks: 120, stop });
        if (r.ok && posNear(s, to, tol)) return;
    }
    const cur = s.sdk.getState()?.player;
    if (!cur) throw Error('walk failed: no player state');
    const from = { x: cur.worldX, z: cur.worldZ, level: cur.level };
    const plan = await planTripOffThread(from, to, withoutTeleports(accountOf(s)), undefined);
    if (!plan) throw Error(`ground route to ${to.x},${to.z},${to.level} unavailable from ${from.x},${from.z},${from.level}`);
    const r = await walkRoute(s, plan.legs, { legTimeoutTicks });
    if (!r.ok || !posNear(s, to, tol)) throw Error(`walk to ${to.x},${to.z},${to.level} failed: ${r.ok ? 'not at target' : r.detail}`);
}

async function moveTo(s: Session, to: { x: number; z: number; level: number }, tol = 2, stop: () => boolean): Promise<void> {
    if (posNear(s, to, tol)) return;
    const p = s.sdk.getState()?.player;
    if (p && p.level === to.level && Math.max(Math.abs(p.worldX - to.x), Math.abs(p.worldZ - to.z)) <= 24) {
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: to.x, z: to.z, tol }], { maxTicks: 120, stop });
        if (r.ok && posNear(s, to, tol)) return;
    }
    const world = await getWorld();
    const r = await goTo(s, world, to, accountOf(s), { legTimeoutTicks: 150, noJewelry: true });
    if (!r.ok || !posNear(s, to, tol)) throw Error(`walk to ${to.x},${to.z},${to.level} failed: ${r.ok ? 'not at target' : r.detail}`);
}

async function openFreshBank(s: Session) {
    if (s.sdk.getState()?.bank?.isOpen) {
        await s.bot.closeBank();
        await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
    }
    const gen = s.bankObservation?.()?.generation ?? 0;
    await s.bot.dismissBlockingUI();
    const res = await s.bot.openBank();
    if (!res.success) throw Error(`openBank failed: ${res.message ?? res.reason}`);
    const ok = await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 20 });
    const obs = s.bankObservation?.();
    if (!ok || !obs) throw Error('fresh bank observation unavailable');
    return obs;
}

async function depositAllInventory(s: Session): Promise<void> {
    while (s.sdk.getInventory().length > 0) {
        const first = s.sdk.getInventory()[0];
        if (!first) break;
        const r = await s.bot.depositItem(first, -1);
        if (!r.success) throw Error(`deposit failed for ${first.name}: ${r.message ?? r.reason}`);
        await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === first.id), { timeoutTicks: 10 });
    }
}

export async function withdrawExactKit(s: Session, kit: readonly KitSpecItem[], bankAt: { x: number; z: number; level: number }, stop: () => boolean, allowNoted = false): Promise<readonly KitSpecItem[]> {
    await moveTo(s, bankAt, 2, stop);
    const obs = await openFreshBank(s);
    await depositAllInventory(s);
    const concreteKit = resolveConcreteKit(kit, s.sdk.getState()?.bank?.items ?? []);
    for (const spec of concreteKit) {
        const baseId = resolveBaseId(spec.id);
        const bankRow = s.sdk.getState()?.bank?.items.find(i => i.id === spec.id || i.id === baseId);
        if (!bankRow || bankRow.count < spec.count) {
            await s.bot.closeBank().catch(() => {});
            throw Error(`missing bank stock for ${spec.name} (${spec.id}): need ${spec.count}, have ${bankRow?.count ?? 0}`);
        }
        const before = countById(s.sdk.getInventory(), spec.id);
        const asNote = isNotedId(spec.id) || (allowNoted && !spec.stackable && spec.count > 1);
        const w = await s.bot.withdrawItem(bankRow, spec.count, { asNote });
        if (!w.success || !await waitUntil(s, () => countById(s.sdk.getInventory(), spec.id) === before + spec.count, { timeoutTicks: 12 })) {
            await s.bot.closeBank().catch(() => {});
            throw Error(`withdraw failed for ${spec.name}: ${w.message ?? w.reason ?? 'count mismatch'}`);
        }
    }
    await s.bot.closeBank();
    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
    void obs;
    if (!hasExactKit(s.sdk.getInventory(), concreteKit)) throw Error('withdrawn inventory does not match exact specialist kit');
    return concreteKit;
}

function invSpec(id: number, count: number, altIds?: readonly number[]): KitSpecItem {
    return {
        id,
        name: loadItemCatalog().get(id)?.name ?? `Item ${id}`,
        count,
        stackable: STACKABLE_IDS.has(id) || isNotedId(id),
        ...(altIds?.length ? { altIds } : {}),
    };
}

function uniqueSlotsForBatch(
    inv: readonly { id: number; count: number; slot: number }[],
    batch: readonly KitSpecItem[],
    alreadyOffered: readonly { id: number; count: number }[],
): number[] {
    const offeredCounts = new Map<number, number>();
    for (const o of alreadyOffered) offeredCounts.set(o.id, (offeredCounts.get(o.id) ?? 0) + o.count);
    const needed = new Map<number, number>();
    for (const k of batch) needed.set(k.id, (needed.get(k.id) ?? 0) + k.count);
    const slots: number[] = [];
    for (const [id, want] of needed) {
        if ((offeredCounts.get(id) ?? 0) >= want) continue;
        const hit = inv.find(i => i.id === id);
        if (hit) slots.push(hit.slot);
    }
    return slots;
}

async function serveFastBatch(
    s: Session,
    specialist: string,
    batch: readonly KitSpecItem[],
    t0: number,
    CAP: number,
    stop: () => boolean,
    opts?: {
        allowedReturnIds?: readonly number[];
        exitAfterAbsenceTicks?: number;
        insideCheck?: () => boolean;
        primeOnArrival?: boolean;
    },
): Promise<'ok' | 'finished' | 'aborted'> {
    const specLower = specialist.toLowerCase();
    const specReqRe = new RegExp('^' + specialist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+wishes to trade', 'i');
    const allowedReturns = new Set(opts?.allowedReturnIds ?? []);
    const acceptReturn = (offer: readonly { id: number; baseId?: number }[]) =>
        allowedReturns.size === 0 ? offer.length === 0 : offer.every(o => allowedReturns.has(o.baseId ?? resolveBaseId(o.id)));

    const getMsgs = () => s.sdk.getState()?.gameMessages ?? [];
    const startObsId = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
    let tradeObsBaseline = startObsId;
    let tradeStartTick = s.tick();
    let lastReqObsId = startObsId;
    let lastReplyTick = -10;
    let sawConfirm = false;
    let closedAfterConfirmTicks = 0;
    let sawSpecialist = false;
    let lastSeenSpecTick = s.tick();
    let primeRemaining = opts?.primeOnArrival ? 2 : 0;
    let lastPrimeTick = -10;
    const startCounts = new Map(batch.map(k => [k.id, countById(s.sdk.getInventory(), k.id)]));

    const hasTradeMsg = (re: RegExp) =>
        getMsgs().some(
            m => re.test(m.text) && (m.observationId !== undefined ? m.observationId > tradeObsBaseline : m.tick > tradeStartTick),
        );

    while (!stop() && s.tick() - t0 < CAP) {
        const specNearby = s.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === specLower);
        if (specNearby && (!opts?.insideCheck || opts.insideCheck())) {
            sawSpecialist = true;
            lastSeenSpecTick = s.tick();
        }

        const ht = s.sdk.getTradeState();
        if (!ht.isOpen) {
            if (sawConfirm) {
                if (hasTradeMsg(/Accepted trade\./i)) return 'ok';
                if (hasTradeMsg(/(?:declined trade|enough inventory space)/i)) {
                    sawConfirm = false;
                    closedAfterConfirmTicks = 0;
                    tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                    tradeStartTick = s.tick();
                } else {
                    closedAfterConfirmTicks++;
                    if (closedAfterConfirmTicks >= 3) {
                        if (batch.every(k => countById(s.sdk.getInventory(), k.id) <= (startCounts.get(k.id) ?? 0) - k.count)) {
                            return 'ok';
                        }
                        sawConfirm = false;
                        closedAfterConfirmTicks = 0;
                    }
                    await waitTicks(s, 1);
                    continue;
                }
            }

            if (
                opts?.exitAfterAbsenceTicks !== undefined &&
                sawSpecialist &&
                s.tick() - lastSeenSpecTick >= opts.exitAfterAbsenceTicks
            ) {
                return 'finished';
            }

            const reqMsg = [...getMsgs()]
                .reverse()
                .find(
                    m =>
                        (m.type === 4 || /wishes to trade/i.test(m.text)) &&
                        (m.sender?.toLowerCase() === specLower || specReqRe.test(m.text)) &&
                        ((m.observationId !== undefined && m.observationId > lastReqObsId) || s.tick() - m.tick <= 2),
                );
            if (reqMsg && specNearby && s.tick() - lastReplyTick >= 2) {
                lastReqObsId = Math.max(lastReqObsId, reqMsg.observationId ?? 0);
                lastReplyTick = s.tick();
                primeRemaining = 0;
                tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                tradeStartTick = s.tick();
                await s.direct({ type: 'interactPlayer', playerIndex: specNearby.index, optionIndex: 4, reason: 'SDK' });
            } else if (
                primeRemaining > 0 &&
                specNearby &&
                s.tick() - lastReplyTick >= 2 &&
                s.tick() - lastPrimeTick >= 3 &&
                (primeRemaining === 2 || hasTradeMsg(/is busy at the moment/i))
            ) {
                primeRemaining--;
                lastPrimeTick = s.tick();
                lastReplyTick = s.tick();
                tradeObsBaseline = getMsgs().reduce((mx, m) => Math.max(mx, m.observationId ?? 0), 0);
                tradeStartTick = s.tick();
                await s.direct({ type: 'interactPlayer', playerIndex: specNearby.index, optionIndex: 4, reason: 'SDK' });
            } else if (s.sdk.getState()?.dialog?.isOpen) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            }
            await waitTicks(s, 1);
            continue;
        }

        closedAfterConfirmTicks = 0;
        if (ht.partner && ht.partner.toLowerCase() !== specLower) {
            await s.direct({ type: 'closeModal', reason: 'SDK' });
            sawConfirm = false;
            await waitTicks(s, 1);
            continue;
        }

        if (ht.screen === 'confirm') {
            sawConfirm = true;
            if (!acceptReturn(ht.theirOffer)) {
                await s.direct({ type: 'closeModal', reason: 'SDK' });
            } else if (!ht.myAccepted) {
                await s.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' });
            }
            await waitTicks(s, 1);
            continue;
        }

        const offerSlots = uniqueSlotsForBatch(s.sdk.getInventory(), batch, ht.myOffer);
        const maxOffers = offerSlots.length > 4 ? 5 : 4;
        const toOffer = offerSlots.slice(0, maxOffers);
        const allOffered = offerSlots.length <= toOffer.length;
        const acts: Promise<unknown>[] = [];
        for (const slot of toOffer) {
            acts.push(s.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
        }
        if (allOffered && toOffer.length <= 4 && acceptReturn(ht.theirOffer)) {
            if (!ht.myAccepted) {
                acts.push(s.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
            }
            if (ht.myAccepted || (toOffer.length <= 3 && ht.partnerAccepted)) {
                sawConfirm = true;
                acts.push(s.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
            }
        }
        if (acts.length) await Promise.all(acts);
        await waitTicks(s, 1);
    }
    return 'aborted';
}

async function enterAltar(s: Session, talismanId: number, ruinsId: number, stop: () => boolean, inside: () => boolean): Promise<void> {
    while (!stop() && !inside()) {
        const ruins = findLocBy(s, l => l.id === ruinsId || /mysterious ruins/i.test(l.name));
        const talisman = s.sdk.getInventory().find(i => i.id === talismanId);
        if (ruins && talisman) {
            await s.direct({ type: 'useItemOnLoc', itemSlot: talisman.slot, x: ruins.x, z: ruins.z, locId: ruins.id, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
}

async function exitPortal(s: Session, stop: () => boolean, inside: () => boolean): Promise<void> {
    while (!stop() && inside()) {
        const portal = findLocBy(s, l => l.id === 2470 || /portal/i.test(l.name));
        if (portal) {
            await s.direct({ type: 'interactLoc', x: portal.x, z: portal.z, locId: portal.id, optionIndex: 1, reason: 'SDK' });
        }
        await waitTicks(s, 1);
    }
}

async function runServe(args: string[]): Promise<void> {
    const parsed = parseSupplierCliArgs(args);
    const holder = assertSupplierAccount(parsed.positional[0] ?? '', 'holder');
    const specialist = parsed.positional[1] ?? '';
    if (!specialist || !ACCOUNT_RE.test(specialist)) {
        throw Error(`usage: specialist-supplier.ts <holder> <specialist> [--kit=${Object.keys(SPECIALIST_KITS).join('|')}] [cap]`);
    }
    const plan = resolveSupplierKitPlan(parsed.kitArg ?? process.env.SUPPLIER_KIT);
    const CAP = Number(parsed.cap ?? process.env.CAP ?? (plan.legs.length > 1 ? 6000 : 4000));
    if (!Number.isSafeInteger(CAP) || CAP < 50 || CAP > 50000) throw Error(`invalid CAP: ${CAP}`);
    const root = resolve(import.meta.dir, '..');
    const serverHost = (readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    if (!serverHost) throw Error(`missing SERVER in bot.env for ${holder}`);
    const stopFile = () => existsSync(join(root, '.practice', `stop-${holder}`)) || (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));
    const bankTile = {
        x: parsed.bankX ?? DEFAULT_STAGE_BANK.x,
        z: parsed.bankZ ?? DEFAULT_STAGE_BANK.z,
        level: 0,
    };

    const s = await openBot(holder);
    const stop = () => stopFile();
    try {
        await waitUntil(s, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 });
        const t0 = s.tick();
        let activePlan = plan;
        if (!parsed.kitArg && !process.env.SUPPLIER_KIT) {
            for (const [kName, kItems] of Object.entries(SPECIALIST_KITS)) {
                if (hasExactKit(s.sdk.getInventory(), kItems)) {
                    activePlan = resolveSupplierKitPlan(kName);
                    break;
                }
            }
        }
        const kitName = activePlan.name;
        if (kitName !== 'prayer' && kitName !== 'smithing' && kitName !== 'runecraft' && kitName !== 'crafting' && kitName !== 'herblore' && kitName !== 'magic' && kitName !== 'agility') {
            const peerRe = exactNameRe(specialist);
            for (let legIdx = 0; legIdx < activePlan.legs.length; legIdx++) {
                const leg = activePlan.legs[legIdx]!;
                const legBank = legIdx === 0 && (parsed.bankX !== undefined || parsed.bankZ !== undefined) ? bankTile : leg.bank;
                const concreteKit = hasExactKit(s.sdk.getInventory(), leg.kit)
                    ? resolveConcreteKit(leg.kit, s.sdk.getInventory())
                    : await withdrawExactKit(s, leg.kit, legBank, stop, !!leg.noted);
                await moveGroundTo(s, leg.handoff, 2, stop);
                const p = s.sdk.getState()!.player!;
                console.log('SUPPLIER_READY ' + JSON.stringify({
                    holder,
                    specialist,
                    kit: activePlan.name,
                    trade: legIdx + 1,
                    totalTrades: activePlan.legs.length,
                    server: serverHost,
                    at: { x: p.worldX, z: p.worldZ, level: p.level },
                    slots: s.sdk.getInventory().length,
                }));

                const giveList = concreteKit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
                let handoffDone = false;
                while (!stop() && s.tick() - t0 < CAP && !handoffDone) {
                    const served = await s.bot.serveTrades({
                        from: peerRe,
                        give: giveList,
                        accept: offer => offer.length === 0,
                        maxTrades: 1,
                        tradeTimeout: 60_000,
                        timeout: 30_000,
                        until: () => stop() || s.tick() - t0 >= CAP,
                    });
                    const done = served.trades.find(t => t.success && concreteKit.every(k => countById(t.gave, k.id) === k.count) && t.received.length === 0);
                    if (done) {
                        handoffDone = true;
                        console.log('SUPPLIER_HANDOFF ' + JSON.stringify({
                            holder,
                            specialist,
                            kit: activePlan.name,
                            trade: legIdx + 1,
                            totalTrades: activePlan.legs.length,
                            tick: s.tick() - t0,
                            items: concreteKit.map(k => ({ id: k.id, count: k.count })),
                        }));
                        break;
                    }
                    if (served.trades.length > 0) {
                        console.log('WARN supplier trade retry: ' + JSON.stringify(served.trades.map(t => ({ success: t.success, reason: t.reason, message: t.message }))));
                    }
                    await waitTicks(s, 1);
                }
                if (!handoffDone) {
                    await finish([s], false, `supplier did not complete ${activePlan.name} trade ${legIdx + 1}/${activePlan.legs.length} within ${CAP} ticks`);
                    return;
                }
            }
            await finish([s], true, `supplied ${specialist} (${activePlan.name}, ${activePlan.legs.length} trade(s)) in ${s.tick() - t0} ticks`);
            return;
        }

        let readyPrinted = false;
        const emitReady = () => {
            if (readyPrinted) return;
            readyPrinted = true;
            const p = s.sdk.getState()!.player!;
            console.log('SUPPLIER_READY ' + JSON.stringify({
                holder, specialist, server: serverHost, kit: kitName,
                at: { x: p.worldX, z: p.worldZ, level: p.level },
                slots: s.sdk.getInventory().length,
            }));
        };

        let allDone = false;
        if (kitName === 'prayer') {
            let delivered = 0;
            while (!stop() && s.tick() - t0 < CAP && delivered < PRAYER_BONES_NEEDED) {
                const need = Math.min(28, PRAYER_BONES_NEEDED - delivered);
                const batch = [invSpec(ITEM_IDS.dragon_bones, need)];
                if (!hasExactKit(s.sdk.getInventory(), batch)) {
                    await withdrawExactKit(s, batch, bankTile, stop);
                }
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                const res = await serveFastBatch(s, specialist, batch, t0, CAP, stop, {
                    exitAfterAbsenceTicks: 120,
                });
                if (res === 'ok') {
                    delivered += need;
                } else if (res === 'finished') {
                    delivered = PRAYER_BONES_NEEDED;
                    break;
                } else {
                    break;
                }
            }
            allDone = delivered >= PRAYER_BONES_NEEDED;
        } else if (kitName === 'smithing') {
            const role = parseSupplierRole(args, process.env);
            let ok = true;
            if (role !== 'runner') {
                const starter = [
                    invSpec(ITEM_IDS.hammer, 1),
                    invSpec(ITEM_IDS.amulet_of_glory_4, 1),
                    invSpec(ITEM_IDS.bronze_bar, 9),
                    invSpec(ITEM_IDS.iron_bar, 17),
                ];
                if (!hasExactKit(s.sdk.getInventory(), starter)) {
                    await withdrawExactKit(s, starter, bankTile, stop);
                }
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, starter, t0, CAP, stop)) === 'ok';
            }
            if (ok && role !== 'starter') {
                const runnerIdx = role === 'runner' ? (parsed.runnerIndex ?? 0) : 0;
                const runnerCount = role === 'runner' ? (parsed.runnerCount ?? 1) : 1;
                const runnerBank =
                    role === 'runner' && (parsed.bankX !== undefined || parsed.bankZ !== undefined)
                        ? bankTile
                        : VARROCK_WEST_BANK;
                let idx = runnerIdx;
                let finishedEarly = false;
                while (ok && !stop() && s.tick() - t0 < CAP && idx < SMITHING_RUNNER_QUEUE.length) {
                    const delivery = SMITHING_RUNNER_QUEUE[idx]!;
                    const batch = [invSpec(delivery.barId, delivery.count)];
                    if (!hasExactKit(s.sdk.getInventory(), batch)) {
                        await withdrawExactKit(s, batch, idx === runnerIdx ? runnerBank : VARROCK_WEST_BANK, stop);
                    }
                    await moveGroundTo(s, VARROCK_WEST_ANVIL, 1, stop);
                    emitReady();
                    const res = await serveFastBatch(s, specialist, batch, t0, CAP, stop, {
                        exitAfterAbsenceTicks: 180,
                    });
                    if (res === 'ok') {
                        idx += runnerCount;
                    } else if (res === 'finished') {
                        finishedEarly = true;
                        break;
                    } else {
                        ok = false;
                        break;
                    }
                }
                allDone = ok && (finishedEarly || idx >= SMITHING_RUNNER_QUEUE.length);
            } else {
                allDone = ok;
            }
        } else if (kitName === 'runecraft') {
            const role = parseSupplierRole(args, process.env);
            const insideBody = () => {
                const p = playerPos(s);
                return !!p && p.worldZ > 4500 && p.worldX < 2600;
            };
            let ok = true;
            let readyEmitted = false;
            const markReady = () => {
                if (readyEmitted) return;
                readyEmitted = true;
                emitReady();
            };

            if (role !== 'runner') {
                const starter = [
                    invSpec(ITEM_IDS.amulet_of_glory_4, 1, GLORY_IDS.filter(id => id !== ITEM_IDS.amulet_of_glory_4)),
                    invSpec(ITEM_IDS.air_talisman, 1),
                    invSpec(ITEM_IDS.body_talisman, 1),
                    invSpec(ITEM_IDS.blankrune, 25),
                ];
                const concreteStarter = hasExactKit(s.sdk.getInventory(), starter)
                    ? resolveConcreteKit(starter, s.sdk.getInventory())
                    : await withdrawExactKit(s, starter, bankTile, stop);
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                markReady();
                ok = (await serveFastBatch(s, specialist, concreteStarter, t0, CAP, stop)) === 'ok';
            }

            if (ok && role !== 'starter') {
                const runnerBank =
                    role === 'runner' && (parsed.bankX !== undefined || parsed.bankZ !== undefined)
                        ? bankTile
                        : EDGEVILLE_BANK;
                const keep = new Set<number>([ITEM_IDS.body_talisman]);
                let trips = 0;
                let sawSpecialist = false;
                let autoHasRunnerStock = role === 'runner';

                // In auto mode (single-supplier without explicit --role), only continue into Body Altar runner loops
                // when Edgeville/stage bank actually holds a spare Body talisman + essence.
                if (role === 'auto') {
                    await moveTo(s, runnerBank, 2, stop);
                    const bankObs = await openFreshBank(s);
                    const hasTali = (bankObs.items.find(i => i.id === ITEM_IDS.body_talisman)?.count ?? 0) >= 1;
                    const hasEss = (bankObs.items.find(i => i.id === ITEM_IDS.blankrune)?.count ?? 0) >= 1;
                    await s.bot.closeBank().catch(() => {});
                    await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
                    autoHasRunnerStock = hasTali && hasEss;
                }

                while (autoHasRunnerStock && !stop() && s.tick() - t0 < CAP && trips < 205) {
                    const inv = s.sdk.getInventory();
                    const heldTalisman = countById(inv, ITEM_IDS.body_talisman);
                    const heldEss = countById(inv, ITEM_IDS.blankrune);

                    if (!insideBody() && (heldTalisman < 1 || heldEss < 26)) {
                        if (heldTalisman < 1) {
                            await moveTo(s, trips === 0 ? runnerBank : EDGEVILLE_BANK, 2, stop);
                            const bankObs = await openFreshBank(s);
                            const hasTali = (bankObs.items.find(i => i.id === ITEM_IDS.body_talisman)?.count ?? 0) >= 1;
                            if (!hasTali) {
                                await s.bot.closeBank().catch(() => {});
                                break;
                            }
                            const taliItem = s.sdk.getState()?.bank?.items?.find((i: any) => i.id === ITEM_IDS.body_talisman);
                            if (taliItem) {
                                await s.bot.withdrawItem(taliItem, 1, { asNote: false });
                                await waitUntil(s, () => countById(s.sdk.getInventory(), ITEM_IDS.body_talisman) >= 1, { timeoutTicks: 8 });
                            }
                            await s.bot.closeBank().catch(() => {});
                        }
                        if (countById(s.sdk.getInventory(), ITEM_IDS.body_talisman) < 1) break;
                        const bankSpot = trips === 0 ? runnerBank : EDGEVILLE_BANK;
                        await restockAtBank(
                            s,
                            bankSpot,
                            ITEM_IDS.blankrune,
                            26,
                            keep,
                            () => stop() || s.tick() - t0 >= CAP,
                            t0 + CAP,
                        );
                    }

                    const readyTali = countById(s.sdk.getInventory(), ITEM_IDS.body_talisman);
                    const readyEss = countById(s.sdk.getInventory(), ITEM_IDS.blankrune);
                    if (!insideBody() && (readyTali < 1 || readyEss === 0)) break;

                    if (!insideBody()) {
                        markReady();
                        await moveGroundTo(s, BODY_RUINS, 2, stop);
                        await enterAltar(s, ITEM_IDS.body_talisman, 2457, stop, insideBody);
                    }

                    if (countById(s.sdk.getInventory(), ITEM_IDS.blankrune) === 0) {
                        await exitPortal(s, stop, insideBody);
                        continue;
                    }

                    markReady();
                    await moveGroundTo(s, BODY_ALTAR_STAND, 0, stop);
                    const batchCount = Math.min(26, countById(s.sdk.getInventory(), ITEM_IDS.blankrune));
                    const res = await serveFastBatch(
                        s,
                        specialist,
                        [invSpec(ITEM_IDS.blankrune, batchCount)],
                        t0,
                        CAP,
                        stop,
                        {
                            exitAfterAbsenceTicks: 120,
                            insideCheck: insideBody,
                            primeOnArrival: trips > 0,
                        },
                    );
                    if (res === 'ok') {
                        sawSpecialist = true;
                        trips++;
                        await exitPortal(s, stop, insideBody);
                    } else if (res === 'finished') {
                        sawSpecialist = true;
                        break;
                    } else {
                        ok = false;
                        break;
                    }
                }
                allDone = ok && (role === 'auto' ? (!autoHasRunnerStock || trips > 0 || sawSpecialist) : (trips > 0 || sawSpecialist));
            } else {
                allDone = ok;
            }
        } else if (kitName === 'herblore') {
            const starterBatch = HERBLORE_STARTER_BATCH.give.map(g => invSpec(g.id, g.count));
            const notedBatch = HERBLORE_NOTED_BATCH.give.map(g => invSpec(g.id, g.count));
            if (parsed.batchIndex !== undefined && parsed.batchIndex > 1) {
                throw Error(`herblore --batch=${parsed.batchIndex} out of range (0..1)`);
            }
            let ok = true;
            if (parsed.batchIndex === undefined || parsed.batchIndex === 0) {
                if (!hasExactKit(s.sdk.getInventory(), starterBatch)) {
                    await withdrawExactKit(s, starterBatch, bankTile, stop);
                }
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, starterBatch, t0, CAP, stop)) === 'ok';
            }
            if (ok && (parsed.batchIndex === undefined || parsed.batchIndex === 1)) {
                if (!hasExactKit(s.sdk.getInventory(), notedBatch)) {
                    await withdrawExactKit(s, notedBatch, EDGEVILLE_BANK, stop, true);
                }
                await moveGroundTo(s, HERBLORE_BANK_HELPER_SPOT, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, notedBatch, t0, CAP, stop)) === 'ok';
            }
            allDone = ok;
        } else if (kitName === 'crafting') {
            const batchIndices = parsed.batchIndex !== undefined
                ? [parsed.batchIndex]
                : CRAFTING_BATCHES.map((_, i) => i);
            let ok = true;
            for (const idx of batchIndices) {
                const specBatch = CRAFTING_BATCHES[idx];
                if (!specBatch) throw Error(`crafting --batch=${idx} out of range (0..${CRAFTING_BATCHES.length - 1})`);
                const batch = specBatch.give.map(g => invSpec(g.id, g.count));
                if (!hasExactKit(s.sdk.getInventory(), batch)) {
                    await withdrawExactKit(s, batch, bankTile, stop);
                }
                await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, batch, t0, CAP, stop, { allowedReturnIds: specBatch.returnIds })) === 'ok';
                if (!ok || stop() || s.tick() - t0 >= CAP) break;
            }
            allDone = ok;
        } else if (kitName === 'magic') {
            const batchIndices = parsed.batchIndex !== undefined
                ? [parsed.batchIndex]
                : MAGIC_BATCHES.map((_, i) => i);
            let ok = true;
            for (const idx of batchIndices) {
                const specBatch = MAGIC_BATCHES[idx];
                if (!specBatch) throw Error(`magic --batch=${idx} out of range (0..${MAGIC_BATCHES.length - 1})`);
                const stand = idx === 0 ? LUMBRIDGE_HANDOFF : LUMBRIDGE_SAFE_SPOT;
                const batch = specBatch.give.map(g => invSpec(g.id, g.count));
                if (!hasExactKit(s.sdk.getInventory(), batch)) {
                    await withdrawExactKit(s, batch, bankTile, stop);
                }
                await moveGroundTo(s, stand, 2, stop);
                emitReady();
                ok = (await serveFastBatch(s, specialist, batch, t0, CAP, stop, { allowedReturnIds: specBatch.returnIds })) === 'ok';
                if (!ok || stop() || s.tick() - t0 >= CAP) break;
            }
            allDone = ok;
        } else if (kitName === 'agility') {
            const batch = AGILITY_SPECIALIST_KIT.map(g => invSpec(g.id, g.count));
            if (!hasExactKit(s.sdk.getInventory(), batch)) {
                await withdrawExactKit(s, batch, bankTile, stop);
            }
            await moveGroundTo(s, LUMBRIDGE_HANDOFF, 2, stop);
            emitReady();
            allDone = (await serveFastBatch(s, specialist, batch, t0, CAP, stop)) === 'ok';
        } else {
            throw Error(`unhandled serve kit: ${kitName}`);
        }

        if (allDone) {
            const kit = resolveSupplierKit(kitName);
            console.log('SUPPLIER_HANDOFF ' + JSON.stringify({ holder, specialist, kit: kitName, tick: s.tick() - t0, items: kit.map(k => ({ id: k.id, count: k.count })) }));
        }
        await finish([s], allDone, allDone ? `supplied ${kitName} for ${specialist} in ${s.tick() - t0} ticks` : `supplier did not complete ${kitName} handoff within ${CAP} ticks`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export async function runStage(args: string[]): Promise<void> {
    const parsed = parseSupplierCliArgs(args.filter(a => a !== '--stage'));
    const bx = parsed.bankX ?? DEFAULT_STAGE_BANK.x;
    const bz = parsed.bankZ ?? DEFAULT_STAGE_BANK.z;
    const donor = assertSupplierAccount(parsed.positional[0] ?? '', 'donor');
    const holder = assertSupplierAccount(parsed.positional[1] ?? '', 'holder');
    if (donor.toLowerCase() === holder.toLowerCase()) throw Error('donor and holder must be different accounts');
    if (!parsed.outArg) {
        throw Error(`usage: specialist-supplier.ts --stage <donor> <holder> [--kit=${Object.keys(SPECIALIST_KITS).join('|')}] --out=<.practice-dir>`);
    }
    const plan = resolveSupplierKitPlan(parsed.kitArg ?? process.env.SUPPLIER_KIT);
    const allowNoted = plan.legs.length === 1 && kitSlotTotal(plan.combined) > 28;
    const root = resolve(import.meta.dir, '..');
    const outDir = resolve(root, parsed.outArg);
    const relOut = relative(root, outDir).replaceAll('\\', '/');
    if (!relOut.startsWith('.practice/') || relOut.includes('..')) throw Error('--out must be inside .practice/');
    mkdirSync(outDir, { recursive: true });

    const bankTile = { x: bx, z: bz, level: 0 };
    const server = (readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', holder, 'bot.env'), 'utf8').match(/^SERVER=(.*)$/m)?.[1] ?? '').trim();
    const donorSession = await openBot(donor);
    const holderSession = await openBot(holder);
    const stop = () => existsSync(join(root, '.practice', `stop-${donor}`)) || existsSync(join(root, '.practice', `stop-${holder}`)) || (!isLocalServer(server) && existsSync(join(root, '.practice', 'stop-swarm')));
    try {
        await Promise.all([
            waitUntil(donorSession, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 }),
            waitUntil(holderSession, st => (st?.inGame ?? false) && !!st?.player, { timeoutTicks: 20 }),
        ]);
        await Promise.all([
            moveTo(donorSession, bankTile, 2, stop),
            moveTo(holderSession, bankTile, 2, stop),
        ]);
        await openFreshBank(holderSession);
        await depositAllInventory(holderSession);
        await holderSession.bot.closeBank();
        await waitUntil(holderSession, () => !holderSession.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
        let lastTransferAt = Date.now();
        const legFiles: string[] = [];
        const legReceipts: ReturnType<typeof buildLegDeliveryReceipt>[] = [];
        for (let legIdx = 0; legIdx < plan.legs.length; legIdx++) {
            const leg = plan.legs[legIdx]!;
            const legBefore = holderSession.sdk.getInventory().map(i => ({ id: resolveBaseId(i.id), count: i.count }));
            const concreteKit = hasExactKit(donorSession.sdk.getInventory(), leg.kit)
                ? resolveConcreteKit(leg.kit, donorSession.sdk.getInventory())
                : await withdrawExactKit(donorSession, leg.kit, bankTile, stop, allowNoted || !!leg.noted);
            const giveList = concreteKit.map(k => ({ item: exactNameRe(k.name), amount: k.count }));
            const allowed = new Set(concreteKit.map(k => resolveBaseId(k.id)));
            const [served, given] = await Promise.all([
                holderSession.bot.serveTrades({
                    from: exactNameRe(donor),
                    accept: offer => offer.every(o => allowed.has(resolveBaseId(o.id))) && concreteKit.every(k => countById(offer, k.id) === k.count),
                    maxTrades: 1,
                    timeout: 60_000,
                }),
                donorSession.bot.trade(exactNameRe(holder), {
                    give: giveList,
                    accept: offer => offer.length === 0,
                    requestTimeout: 20_000,
                    timeout: 60_000,
                }),
            ]);
            const rx = served.trades.find(t => t.success);
            if (!given.success || !rx || !concreteKit.every(k => countById(rx.received, k.id) === k.count)) {
                throw Error(`stage transfer mismatch (${plan.name} leg ${legIdx + 1}): given=${given.success} rx=${!!rx}`);
            }
            await waitUntil(holderSession, () => hasExactKit(holderSession.sdk.getInventory(), concreteKit), { timeoutTicks: 10 });
            const legAfter = holderSession.sdk.getInventory().map(i => ({ id: resolveBaseId(i.id), count: i.count }));
            lastTransferAt = Date.now();
            for (const spec of concreteKit) {
                if (countById(legAfter, spec.id) - countById(legBefore, spec.id) !== spec.count) {
                    throw Error(`recipient delta mismatch (${plan.name} leg ${legIdx + 1}) for ${spec.name}`);
                }
            }
            const receipt = buildLegDeliveryReceipt({
                kitName: plan.name,
                leg: legIdx + 1,
                totalLegs: plan.legs.length,
                server,
                from: donor,
                to: holder,
                at: lastTransferAt,
                before: legBefore,
                after: legAfter,
                kit: concreteKit,
            });
            legReceipts.push(receipt);
            if (plan.legs.length > 1) {
                const legFile = `delivery-leg${legIdx + 1}.json`;
                legFiles.push(legFile);
                writeFileSync(join(outDir, legFile), JSON.stringify(receipt, null, 2) + '\n');
            }
            await openFreshBank(holderSession);
            await depositAllInventory(holderSession);
            await holderSession.bot.closeBank();
            await waitUntil(holderSession, () => !holderSession.sdk.getState()?.bank?.isOpen, { timeoutTicks: 8 });
        }

        const bankObs = await openFreshBank(holderSession);
        await holderSession.bot.closeBank();
        const bankAt = bankObs.at;
        if (bankAt < lastTransferAt) throw Error(`bank observation (${bankAt}) older than transfer (${lastTransferAt})`);
        if (!hasAtLeastKit(bankObs.items, plan.combined)) throw Error(`holder final bank observation lacks full ${plan.name} kit`);

        const primaryDelivery = plan.legs.length > 1 ? { ...legReceipts[0]!, legs: legFiles } : legReceipts[0]!;
        const bank = {
            name: holder,
            server,
            bankAt,
            bank: bankObs.items.map(i => ({ id: i.id, count: i.count })),
        };
        writeFileSync(join(outDir, 'delivery.json'), JSON.stringify(primaryDelivery, null, 2) + '\n');
        writeFileSync(join(outDir, 'bank.json'), JSON.stringify(bank, null, 2) + '\n');
        console.log('SPECIALIST_STAGED ' + JSON.stringify({ out: relOut, kit: plan.name, legs: legFiles, donor, holder, transferAt: lastTransferAt, bankAt }));
        await finish([donorSession, holderSession], true, `staged ${plan.name} kit from ${donor} to ${holder} into ${relOut}`);
    } catch (e) {
        await finish([donorSession, holderSession], false, String(e));
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args.includes('--stage')) await runStage(args);
    else await runServe(args);
}
