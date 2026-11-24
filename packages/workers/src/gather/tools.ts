// Rev-289 skilling tool selection, bank tool swap reconciliation, and shop tool purchases.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Gear } from '../../../knowledge/src/gear';
import { loadGear } from '../../../knowledge/src/gear-query';
import type { Shop } from '../../../knowledge/src/shops';

export const WOODCUTTING_AXES_DESC = [1359, 1357, 1355, 1361, 1353, 1349, 1351] as const;
export const MINING_PICKAXES_DESC = [1275, 1271, 1273, 1269, 1267, 1265] as const;
export const SHOP_RESTOCK_COOLDOWN_TICKS = 700;
const COINS_ID = 995;

export type GearCount = { id: number; count: number };
export type GearSkillLevels = Partial<Record<string, number | { level: number; baseLevel?: number } | null | undefined>> | null | undefined;
export type QuestInput =
    | ReadonlySet<string>
    | readonly string[]
    | readonly { name: string; state: string }[]
    | Record<string, boolean | null | undefined>
    | null
    | undefined;

export interface ShopSource {
    shop: string;
    file: string;
    itemDebugName: string;
    itemId: number;
    stock: number;
    restockTicks: number | null;
    cost: number;
    requiresQuest?: string;
    requiresSkill?: { skill: string; level: number };
    requiresQuestPoints?: number;
}

export interface ToolCandidate {
    item: Gear;
    useSkill: 'woodcutting' | 'mining';
    useLevel: number;
    paramLevel: number;
    wieldAttackLevel: number;
    canUse: boolean;
    canWield: boolean;
    carryMode: 'wield' | 'inventory';
    shops: ShopSource[];
    tradeable: boolean;
}

export interface ToolRecommendation {
    kind: 'woodcutting-axe' | 'mining-pickaxe';
    current: ToolCandidate | null;
    bestUsable: ToolCandidate | null;
    nextAcquirable: ToolCandidate | null;
    nextUnlock: ToolCandidate | null;
}

export interface ToolShopUpgradePlan {
    kind: 'woodcutting-axe' | 'mining-pickaxe';
    currentId: number | null;
    target: Gear;
    shop: ShopSource;
    price: number;
    coinBudgetNeeded: number;
}

export interface ToolShopUpgradeOptions {
    allowedShops?: readonly string[];
    coinReserve?: number;
    priceBufferRatio?: number;
    onlyWhenStarterOrMissing?: boolean;
    enforceAxeLevel?: boolean;
    quests?: QuestInput;
    questPoints?: number;
}

export interface BankToolSwapPlan {
    targetId: number;
    withdrawFromBank: boolean;
    equipInWeaponSlot: boolean;
    depositInventoryIds: number[];
    alreadyActive: boolean;
}

export interface ReconcileBankToolHooks {
    openBank: () => Promise<unknown>;
    closeBank: () => Promise<unknown>;
    withdrawItem: (item: { id: number; name: string; count: number; slot?: number }, count: number) => Promise<unknown>;
    depositItem: (item: { id: number; name: string; count: number; slot?: number }, count: number) => Promise<unknown>;
    equipItem?: (item: { id: number; name: string; count: number; slot?: number }) => Promise<unknown>;
    getInventory: () => readonly { id: number; name: string; count: number; slot?: number }[];
    getEquipment: () => readonly { id: number; name?: string; count?: number; slot: number }[];
    getBankState: () => { isOpen: boolean; items: readonly { id: number; name: string; count: number; slot?: number }[] } | undefined;
    getBankGeneration?: () => number | undefined;
    waitUntil: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
    stop?: () => boolean;
}

export const TOOL_SHOP_LOCATIONS = {
    axeshop: { shop: 'axeshop', npc: /^bob$/i, spot: { x: 3231, z: 3203, level: 0 } },
    pickaxeshop: { shop: 'pickaxeshop', npc: /^nurmof$/i, spot: { x: 2998, z: 9844, level: 0 } },
    staffshop: { shop: 'staffshop', npc: /^zaff$/i, spot: { x: 3203, z: 3433, level: 0 } },
    fishingshop2: { shop: 'fishingshop2', npc: /^harry$/i, spot: { x: 2834, z: 3445, level: 0 } },
} as const;

export type KnownToolShop = keyof typeof TOOL_SHOP_LOCATIONS;

export interface ShopToolPurchaseHooks extends ReconcileBankToolHooks {
    walkTo: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
    openShop: (npc: RegExp) => Promise<{ success: boolean; message?: string }>;
    buyFromShop: (item: { id: number; name: string; count: number; buyPrice?: number; slot?: number } | RegExp, amount: number) => Promise<{ success: boolean; message?: string }>;
    closeShop: () => Promise<unknown>;
    getShopState: () => { isOpen: boolean; shopItems: readonly { id: number; name: string; count: number; buyPrice?: number; slot?: number }[] } | undefined;
}

export interface ShopRetryGate {
    checkedTier?: number;
    failedAt?: { tier: number; tick: number };
}

export interface SessionToolLike {
    sdk: {
        getState: () => {
            bank?: { isOpen: boolean; items: readonly { id: number; name: string; count: number; slot?: number }[] };
            shop?: { isOpen: boolean; shopItems: readonly { id: number; name: string; count: number; buyPrice?: number; slot?: number }[] };
            equipment?: readonly { id: number; name?: string; count?: number; slot: number }[];
        } | null | undefined;
        getInventory: () => readonly { id: number; name: string; count: number; slot?: number }[];
        getEquipment?: () => readonly { id: number; name?: string; count?: number; slot: number }[];
    };
    bot: {
        openBank: () => Promise<unknown>;
        closeBank: () => Promise<unknown>;
        withdrawItem: (item: any, count: number, opts?: any) => Promise<unknown>;
        depositItem: (item: any, count: number) => Promise<unknown>;
        equipItem?: (item: any) => Promise<unknown>;
        openShop: (npc: RegExp) => Promise<{ success: boolean; message?: string }>;
        buyFromShop: (item: any, amount: number) => Promise<{ success: boolean; message?: string }>;
        closeShop: () => Promise<unknown>;
    };
    bankObservation?: () => { generation: number; items: readonly { id: number; name: string; count: number; slot?: number }[] } | null | undefined;
}

const ROOT = resolve(import.meta.dir, '../../../..');
const EXCLUDED_DEBUG_RE = /^macro_|^xmas_yoyoworn$|^ikov_bootsoflightnessworn$|^death_spikedboots$|^flowers_waterfall|^trollromance_rare_flower$/;
const READ_SKILL_NAMES = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic', 'Hitpoints', 'Prayer', 'Woodcutting', 'Mining', 'Fishing'] as const;

let cachedGear: Gear[] | undefined;
let cachedGearById: Map<number, Gear> | undefined;
let cachedShopsById: Map<number, ShopSource[]> | undefined;
let cachedSkillTools: { axes: { id: number; woodcuttingLevel?: number | null; paramLevelrequire?: number | null }[]; pickaxes: { id: number; miningLevel?: number | null }[] } | undefined;
let cachedAxeTierLevels: number[] | undefined;
let cachedPickaxeTierLevels: number[] | undefined;

const SHOP_GATES: Readonly<Record<string, Pick<ShopSource, 'requiresQuest' | 'requiresSkill' | 'requiresQuestPoints'>>> = {
    dragonaxeshop: { requiresQuest: "Hero's Quest" },
    legendsguildshop: { requiresQuest: 'Legends Quest' },
    generallegends: { requiresQuest: 'Legends Quest' },
    championshop: { requiresQuestPoints: 32 },
    runiteshop: { requiresQuestPoints: 32 },
};

function gearCatalog(): readonly Gear[] {
    if (cachedGear) return cachedGear;
    cachedGear = loadGear().filter(g => !g.staffOnly && !EXCLUDED_DEBUG_RE.test(g.debugname));
    cachedGearById = new Map(cachedGear.map(g => [g.id, g]));
    return cachedGear;
}

export function gearById(id: number): Gear | undefined {
    gearCatalog();
    return cachedGearById!.get(id);
}

export function shopCatalog(): ReadonlyMap<number, readonly ShopSource[]> {
    if (cachedShopsById) return cachedShopsById;
    const items = JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'items.json'), 'utf8')) as { id: number; debugname: string; cost?: number }[];
    const shops = JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'shops.json'), 'utf8')) as Shop[];
    const byDebug = new Map(items.map(i => [i.debugname, i]));
    const out = new Map<number, ShopSource[]>();
    for (const shop of shops) {
        if (/^(skill_guide_|smithing_|crafting_make_)|_free$/.test(shop.inv)) continue;
        const gate = SHOP_GATES[shop.inv];
        for (const row of shop.stock) {
            if (row.count <= 0) continue;
            const item = byDebug.get(row.item);
            if (!item) continue;
            const entry: ShopSource = {
                shop: shop.inv,
                file: shop.file,
                itemDebugName: row.item,
                itemId: item.id,
                stock: row.count,
                restockTicks: row.restockTicks,
                cost: item.cost ?? 1,
                ...(gate ?? {}),
            };
            const list = out.get(item.id);
            if (list) list.push(entry);
            else out.set(item.id, [entry]);
        }
    }
    cachedShopsById = out;
    return out;
}

function skillToolsData() {
    return cachedSkillTools ??= JSON.parse(readFileSync(resolve(ROOT, 'knowledge', 'skill-tools.json'), 'utf8')) as {
        axes: { id: number; woodcuttingLevel?: number | null; paramLevelrequire?: number | null }[];
        pickaxes: { id: number; miningLevel?: number | null }[];
    };
}

function normalizeSkills(levels: GearSkillLevels): Record<string, number> {
    const out: Record<string, number> = { attack: 1, woodcutting: 1, mining: 1, fishing: 1, hitpoints: 10 };
    if (!levels) return out;
    for (const [k, v] of Object.entries(levels)) {
        const val = typeof v === 'number' ? v : v && typeof v === 'object' ? (v.baseLevel ?? v.level) : undefined;
        if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 1) out[k.toLowerCase()] = val;
    }
    return out;
}

function normalizeCompletedQuests(quests: QuestInput): Set<string> {
    const out = new Set<string>();
    if (!quests) return out;
    if (quests instanceof Set) { for (const q of quests) if (typeof q === 'string' && q.trim()) out.add(q.trim()); return out; }
    if (Array.isArray(quests)) {
        for (const q of quests) {
            if (typeof q === 'string' && q.trim()) out.add(q.trim());
            else if (q && typeof q === 'object' && 'state' in q && 'name' in q && q.state === 'complete' && typeof q.name === 'string') out.add(q.name.trim());
        }
        return out;
    }
    for (const [q, done] of Object.entries(quests)) if (done === true) out.add(q.trim());
    return out;
}

function stockTotals(stock: readonly GearCount[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const row of stock) out.set(row.id, (out.get(row.id) ?? 0) + row.count);
    return out;
}

export function readSkillLevels(
    source?:
        | { getSkill?: (name: string) => { level: number; baseLevel?: number } | null | undefined }
        | ((name: string) => { level: number; baseLevel?: number } | null | undefined),
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of READ_SKILL_NAMES) {
        const sk = typeof source === 'function' ? source(name) : source?.getSkill?.(name);
        const val = sk?.baseLevel ?? sk?.level;
        out[name] = typeof val === 'number' && Number.isSafeInteger(val) && val >= 1 ? val : name === 'Hitpoints' ? 10 : 1;
    }
    return out;
}

function buildToolCandidates(
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolCandidate[] {
    const skillMap = normalizeSkills(levels);
    const useStat = skillMap[useSkill] ?? 1;
    const attackStat = skillMap.attack ?? 1;
    const out: ToolCandidate[] = [];
    for (let i = 0; i < orderedIdsDesc.length; i++) {
        const id = orderedIdsDesc[i]!;
        const item = gearById(id);
        if (!item) continue;
        const paramLevel = Math.max(1, item.tier ?? 1);
        const useLevel = enforceUseLevel ? paramLevel : 1;
        const wieldAttackLevel = item.requires.skills.attack ?? 1;
        const canUse = useStat >= useLevel;
        const canWield = attackStat >= wieldAttackLevel;
        let cachedShops: ShopSource[] | undefined;
        const candidate: ToolCandidate = {
            item,
            useSkill,
            useLevel,
            paramLevel,
            wieldAttackLevel,
            canUse,
            canWield,
            carryMode: canWield ? 'wield' : 'inventory',
            shops: undefined as unknown as ShopSource[],
            tradeable: item.tradeable,
        };
        Object.defineProperty(candidate, 'shops', {
            enumerable: true,
            configurable: true,
            get() {
                return (cachedShops ??= [...(shopCatalog().get(item.id) ?? [])]);
            },
        });
        out.push(candidate);
    }
    return out;
}

function selectTool(
    kind: 'woodcutting-axe' | 'mining-pickaxe',
    orderedIdsDesc: readonly number[],
    useSkill: 'woodcutting' | 'mining',
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    enforceUseLevel = true,
): ToolRecommendation {
    const owned = stockTotals(stock);
    const candidates = buildToolCandidates(orderedIdsDesc, useSkill, levels, enforceUseLevel);
    let bestUsable: ToolCandidate | null = null;
    let current: ToolCandidate | null = null;
    let currentIdx = candidates.length;
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        if (!c.canUse) continue;
        if (!bestUsable) bestUsable = c;
        if (!current && (owned.get(c.item.id) ?? 0) > 0) {
            current = c;
            currentIdx = i;
            break;
        }
    }
    const nextAcquirable = bestUsable && (!current || bestUsable.item.id !== current.item.id) ? bestUsable : null;
    let nextUnlock: ToolCandidate | null = null;
    for (let i = currentIdx - 1; i >= 0; i--) {
        const c = candidates[i]!;
        if (!c.canUse) {
            nextUnlock = c;
            break;
        }
    }
    return { kind, current, bestUsable, nextAcquirable, nextUnlock };
}

export function bestWoodcuttingAxe(
    stock: readonly GearCount[],
    levels?: GearSkillLevels,
    options?: { enforceAxeLevel?: boolean },
): ToolRecommendation {
    return selectTool('woodcutting-axe', WOODCUTTING_AXES_DESC, 'woodcutting', stock, levels, options?.enforceAxeLevel ?? false);
}

export function bestMiningPickaxe(stock: readonly GearCount[], levels?: GearSkillLevels): ToolRecommendation {
    return selectTool('mining-pickaxe', MINING_PICKAXES_DESC, 'mining', stock, levels, true);
}

/** The highest boundary of `tiers` at or under the level, or 1. */
export function tierBoundaryOf(level: number, tiers: readonly number[]): number {
    let highest = 1;
    for (const t of tiers) if (level >= t) highest = t;
    return highest;
}

function skillToolTierLevels(kind: 'woodcutting-axe' | 'mining-pickaxe'): readonly number[] {
    if (kind === 'woodcutting-axe') {
        if (cachedAxeTierLevels) return cachedAxeTierLevels;
        const set = new Set<number>();
        for (const r of skillToolsData().axes) {
            const lvl = r.woodcuttingLevel ?? r.paramLevelrequire;
            if (typeof lvl === 'number' && lvl >= 1) set.add(lvl);
        }
        return (cachedAxeTierLevels = [...set].sort((a, b) => a - b));
    }
    if (cachedPickaxeTierLevels) return cachedPickaxeTierLevels;
    const set = new Set<number>();
    for (const r of skillToolsData().pickaxes) {
        if (typeof r.miningLevel === 'number' && r.miningLevel >= 1) set.add(r.miningLevel);
    }
    return (cachedPickaxeTierLevels = [...set].sort((a, b) => a - b));
}

function readNormalizedSkill(levels: GearSkillLevels, lowerKey: string): number {
    if (!levels) return lowerKey === 'hitpoints' ? 10 : 1;
    const direct = levels[lowerKey];
    if (direct !== undefined) {
        const val = typeof direct === 'number' ? direct : direct && typeof direct === 'object' ? (direct.baseLevel ?? direct.level) : undefined;
        if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 1) return val;
    }
    for (const k in levels) {
        if (k.toLowerCase() === lowerKey) {
            const v = levels[k];
            const val = typeof v === 'number' ? v : v && typeof v === 'object' ? (v.baseLevel ?? v.level) : undefined;
            if (typeof val === 'number' && Number.isSafeInteger(val) && val >= 1) return val;
            break;
        }
    }
    return lowerKey === 'hitpoints' ? 10 : 1;
}

export function crossedTierBoundary(
    previous: GearSkillLevels,
    current: GearSkillLevels,
    skills: readonly string[],
    kindOrLevels: 'woodcutting-axe' | 'mining-pickaxe' | readonly number[],
): boolean {
    const levels = Array.isArray(kindOrLevels)
        ? [...kindOrLevels].sort((a, b) => a - b)
        : skillToolTierLevels(kindOrLevels as 'woodcutting-axe' | 'mining-pickaxe');
    for (let i = 0; i < skills.length; i++) {
        const k = skills[i]!.toLowerCase();
        if (tierBoundaryOf(readNormalizedSkill(current, k), levels) > tierBoundaryOf(readNormalizedSkill(previous, k), levels)) {
            return true;
        }
    }
    return false;
}

function shopAccessible(
    shop: ShopSource,
    skills: Record<string, number>,
    done: Set<string>,
    allowedShops?: readonly string[],
    questPoints?: number,
): boolean {
    if (allowedShops && !allowedShops.includes(shop.shop)) return false;
    if (shop.requiresQuest && !done.has(shop.requiresQuest)) return false;
    if (shop.requiresSkill && (skills[shop.requiresSkill.skill.toLowerCase()] ?? 1) < shop.requiresSkill.level) return false;
    if (shop.requiresQuestPoints && (questPoints ?? 0) < shop.requiresQuestPoints) return false;
    return true;
}

export function planToolShopUpgrade(
    kind: 'woodcutting-axe' | 'mining-pickaxe',
    stock: readonly GearCount[],
    coins: number,
    levels?: GearSkillLevels,
    options: ToolShopUpgradeOptions = {},
): ToolShopUpgradePlan | null {
    const skillMap = normalizeSkills(levels);
    const done = normalizeCompletedQuests(options.quests);
    const owned = stockTotals(stock);
    const reserve = Math.max(0, options.coinReserve ?? 0);
    const ratio = options.priceBufferRatio ?? 1.25;
    const ordered = kind === 'woodcutting-axe' ? WOODCUTTING_AXES_DESC : MINING_PICKAXES_DESC;
    const skill = kind === 'woodcutting-axe' ? 'woodcutting' : 'mining';
    const enforce = kind === 'mining-pickaxe' || options.enforceAxeLevel === true;
    const usable = buildToolCandidates(ordered, skill, levels, enforce).filter(c => c.canUse);
    const curIdx = usable.findIndex(c => (owned.get(c.item.id) ?? 0) > 0);
    const current = curIdx >= 0 ? usable[curIdx]! : null;
    const currentId = current?.item.id ?? null;
    const starterId = kind === 'woodcutting-axe' ? 1351 : 1265;
    if (options.onlyWhenStarterOrMissing && current && current.item.id !== starterId) return null;
    const betterCandidates = curIdx >= 0 ? usable.slice(0, curIdx) : usable;

    for (const candidate of betterCandidates) {
        const accessibleShops = candidate.shops
            .filter(s => shopAccessible(s, skillMap, done, options.allowedShops, options.questPoints))
            .sort((a, b) => a.cost - b.cost);
        for (const shop of accessibleShops) {
            const coinBudgetNeeded = Math.ceil(shop.cost * ratio) + reserve;
            if (coins >= coinBudgetNeeded) {
                return { kind, currentId, target: candidate.item, shop, price: shop.cost, coinBudgetNeeded };
            }
        }
    }
    return null;
}

const countIn = (rows: readonly { id: number; count?: number }[], id: number) =>
    rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
const checkStop = (hooks: Pick<ReconcileBankToolHooks, 'stop'>, why: string) => {
    if (hooks.stop?.()) throw new Error(why);
};

async function tryOpenBank(hooks: ReconcileBankToolHooks, stopWhy: string, timeoutTicks: number, minGen?: number): Promise<boolean> {
    await hooks.openBank();
    const opened = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        const st = hooks.getBankState();
        const gen = hooks.getBankGeneration?.();
        return !!st?.isOpen && (minGen === undefined || (gen ?? -1) > minGen);
    }, timeoutTicks);
    checkStop(hooks, stopWhy);
    return opened && !!hooks.getBankState()?.isOpen;
}

async function tryCloseBank(hooks: ReconcileBankToolHooks, stopWhy: string, timeoutTicks: number): Promise<boolean> {
    await hooks.closeBank();
    const closed = await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, timeoutTicks);
    checkStop(hooks, stopWhy);
    return closed && !hooks.getBankState()?.isOpen;
}

export function planBankToolSwap(params: {
    targetId: number;
    canWield: boolean;
    allowReplaceWeapon?: boolean;
    inventory: readonly GearCount[];
    equipment: readonly { id: number; slot: number }[];
    bank: readonly GearCount[];
    toolGroupIds: readonly number[];
    refusedWields?: ReadonlySet<number>;
}): BankToolSwapPlan {
    const group = new Set(params.toolGroupIds);
    const weapon = params.equipment.find(i => i.slot === 3);
    const wearingTarget = weapon?.id === params.targetId;
    const heldTarget = countIn(params.inventory, params.targetId) > 0;
    const withdrawFromBank = !wearingTarget && !heldTarget && countIn(params.bank, params.targetId) > 0;
    const canOccupyWeaponSlot = !weapon || group.has(weapon.id) || params.allowReplaceWeapon === true;
    const equipInWeaponSlot = params.canWield
        && !wearingTarget
        && canOccupyWeaponSlot
        && !params.refusedWields?.has(params.targetId)
        && (heldTarget || withdrawFromBank);
    const willWearTarget = wearingTarget || equipInWeaponSlot;
    const depositSet = new Set<number>();
    for (const row of params.inventory) {
        if (!group.has(row.id) || row.count <= 0) continue;
        if (!willWearTarget && row.id === params.targetId) continue;
        depositSet.add(row.id);
    }
    const alreadyActive = !withdrawFromBank && !equipInWeaponSlot && depositSet.size === 0 && (wearingTarget || heldTarget);
    return { targetId: params.targetId, withdrawFromBank, equipInWeaponSlot, depositInventoryIds: [...depositSet], alreadyActive };
}

export async function reconcileBankTool(
    hooks: ReconcileBankToolHooks,
    params: {
        targetId: number;
        canWield: boolean;
        allowReplaceWeapon?: boolean;
        toolGroupIds: readonly number[];
        refusedWields?: Set<number>;
    },
): Promise<{ activeId: number; worn: boolean; changed: boolean }> {
    checkStop(hooks, 'tool reconcile stopped');
    if (!hooks.getBankState()?.isOpen && !(await tryOpenBank(hooks, 'tool reconcile stopped opening bank', 10))) {
        throw new Error('tool reconcile bank open unobserved');
    }
    const before = new Map<number, number>();
    const st0 = hooks.getBankState()!;
    for (const id of params.toolGroupIds) {
        before.set(id, countIn(hooks.getInventory(), id) + countIn(hooks.getEquipment(), id) + countIn(st0.items, id));
    }
    let plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: params.canWield,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: st0.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });
    if (plan.alreadyActive) {
        return { activeId: params.targetId, worn: hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId), changed: false };
    }
    const depositId = async (id: number) => {
        const item = hooks.getInventory().find(i => i.id === id);
        if (!item) return;
        const inv0 = countIn(hooks.getInventory(), id);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.depositItem(item, -1);
        const ok = await hooks.waitUntil(() => !!hooks.stop?.() || (countIn(hooks.getInventory(), id) < inv0 && (gen0 === undefined || (hooks.getBankGeneration?.() ?? -1) > gen0)), 10);
        checkStop(hooks, 'tool reconcile stopped during deposit');
        if (!ok || countIn(hooks.getInventory(), id) > 0) throw new Error(`tool deposit unconfirmed for ${id}`);
    };
    if (plan.withdrawFromBank && hooks.getInventory().length >= 28) {
        for (const depId of plan.depositInventoryIds) {
            checkStop(hooks, 'tool reconcile stopped freeing slot');
            await depositId(depId);
            if (hooks.getInventory().length < 28) break;
        }
    }
    if (plan.withdrawFromBank) {
        checkStop(hooks, 'tool reconcile stopped before withdraw');
        if (hooks.getInventory().length >= 28) throw new Error(`tool upgrade ${params.targetId} needs one free slot`);
        const bst = hooks.getBankState()!;
        const bankRow = bst.items.find(i => i.id === params.targetId && i.count > 0);
        if (!bankRow) throw new Error(`owned tool ${params.targetId} missing from open bank`);
        const held0 = countIn(hooks.getInventory(), params.targetId);
        const stored0 = countIn(bst.items, params.targetId);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.withdrawItem(bankRow, 1);
        const matched = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const st = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!st?.isOpen && countIn(hooks.getInventory(), params.targetId) === held0 + 1 && countIn(st.items, params.targetId) === stored0 - 1 && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop(hooks, 'tool reconcile stopped after withdraw');
        if (!matched) throw new Error(`tool withdrawal unconfirmed for ${params.targetId}`);
    }
    if (plan.equipInWeaponSlot && hooks.equipItem) {
        checkStop(hooks, 'tool reconcile stopped before equip');
        const invItem = hooks.getInventory().find(i => i.id === params.targetId);
        if (!invItem) throw new Error(`tool ${params.targetId} missing from inventory before equip`);
        const gen0 = hooks.getBankGeneration?.();
        if (!(await tryCloseBank(hooks, 'tool reconcile stopped closing bank', 8))) throw new Error('tool reconcile bank close unobserved');
        try { await hooks.equipItem(invItem); } catch {}
        await hooks.waitUntil(() => !!hooks.stop?.() || hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId), 3);
        if (!hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId)) params.refusedWields?.add(params.targetId);
        checkStop(hooks, 'tool reconcile stopped after equip');
        if (!(await tryOpenBank(hooks, 'tool reconcile stopped reopening bank', 12, gen0))) throw new Error('tool reconcile bank reopen unobserved');
    }
    const wornAfterEquip = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: wornAfterEquip,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: hooks.getBankState()!.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });
    for (const depId of plan.depositInventoryIds) {
        checkStop(hooks, 'tool reconcile stopped before inferior deposit');
        await depositId(depId);
    }
    const st1 = hooks.getBankState()!;
    for (const id of params.toolGroupIds) {
        const after = countIn(hooks.getInventory(), id) + countIn(hooks.getEquipment(), id) + countIn(st1.items, id);
        if ((before.get(id) ?? 0) !== after) throw new Error(`tool reconcile asset mismatch for ${id}`);
    }
    const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    if (!worn && !hooks.getInventory().some(i => i.id === params.targetId)) throw new Error(`target tool ${params.targetId} not active after reconcile`);
    return { activeId: params.targetId, worn, changed: true };
}

export async function executeShopToolPurchase(
    hooks: ShopToolPurchaseHooks,
    params: { targetId: number; shop: KnownToolShop; maxBudget: number; coinReserve?: number; returnBankSpot?: { x: number; z: number; level?: number } },
): Promise<{ bought: boolean; id: number; coinsSpent: number; reason?: string }> {
    const reserve = Math.max(0, params.coinReserve ?? 0);
    const shopDef = TOOL_SHOP_LOCATIONS[params.shop];
    let withdrewCoins = 0;
    let walkedToShop = false;
    const recoverToBank = async () => {
        if (hooks.getShopState()?.isOpen) {
            await hooks.closeShop().catch(() => undefined);
            await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);
            checkStop(hooks, 'shop tool purchase stopped closing shop');
        }
        if (walkedToShop && params.returnBankSpot) {
            const back = await hooks.walkTo(params.returnBankSpot);
            checkStop(hooks, 'shop tool purchase stopped walking back to bank');
            if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
        }
        if (withdrewCoins <= 0) return;
        if (!hooks.getBankState()?.isOpen && !(await tryOpenBank(hooks, 'shop tool purchase stopped reopening bank', 10))) {
            throw new Error('shop tool purchase bank reopen unobserved');
        }
        const coinRow = hooks.getInventory().find(i => i.id === COINS_ID && i.count > 0);
        if (!coinRow) return;
        const depositAmt = Math.min(coinRow.count, withdrewCoins);
        const invBefore = countIn(hooks.getInventory(), COINS_ID);
        const bankBefore = countIn(hooks.getBankState()!.items, COINS_ID);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.depositItem(coinRow, depositAmt === coinRow.count ? -1 : depositAmt);
        const deposited = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const bst = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!bst?.isOpen && countIn(hooks.getInventory(), COINS_ID) === invBefore - depositAmt && countIn(bst.items, COINS_ID) === bankBefore + depositAmt && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop(hooks, 'shop tool purchase stopped depositing withdrawn coins');
        if (!deposited) throw new Error('shop coin return deposit unconfirmed');
    };

    checkStop(hooks, 'shop tool purchase stopped');
    const invCoins = countIn(hooks.getInventory(), COINS_ID);
    if (invCoins < params.maxBudget) {
        if (!hooks.getBankState()?.isOpen && !(await tryOpenBank(hooks, 'shop tool purchase stopped opening bank', 10))) {
            return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'bank unavailable for coins' };
        }
        const st = hooks.getBankState()!;
        const bankCoinRow = st.items.find(i => i.id === COINS_ID);
        const bankCoins = countIn(st.items, COINS_ID);
        if (invCoins + bankCoins < params.maxBudget) {
            await hooks.closeBank();
            return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'insufficient coins' };
        }
        const need = params.maxBudget - invCoins;
        if (need > 0 && bankCoinRow) {
            if (hooks.getInventory().length >= (invCoins === 0 ? 27 : 28)) {
                await hooks.closeBank();
                return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'no free slot for coins and tool' };
            }
            const gen0 = hooks.getBankGeneration?.();
            await hooks.withdrawItem(bankCoinRow, need);
            const ok = await hooks.waitUntil(() => {
                if (hooks.stop?.()) return true;
                const bst = hooks.getBankState();
                const gen = hooks.getBankGeneration?.();
                return !!bst?.isOpen && countIn(hooks.getInventory(), COINS_ID) === invCoins + need && countIn(bst.items, COINS_ID) === bankCoins - need && (gen0 === undefined || (gen ?? -1) > gen0);
            }, 10);
            if (ok) withdrewCoins += need;
            checkStop(hooks, 'shop tool purchase stopped withdrawing coins');
            if (!ok) throw new Error('shop coin withdrawal unconfirmed');
        }
    }
    if (hooks.getBankState()?.isOpen) await tryCloseBank(hooks, 'shop tool purchase stopped closing bank', 8);
    if (hooks.getInventory().length >= 28) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'inventory full' };
    }
    walkedToShop = true;
    const arrived = await hooks.walkTo(shopDef.spot);
    checkStop(hooks, 'shop tool purchase stopped walking to shop');
    if (!arrived) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: `could not reach ${params.shop}` };
    }
    const openReply = await hooks.openShop(shopDef.npc);
    if (!openReply.success) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: openReply.message ?? 'shop open refused' };
    }
    const shopReady = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getShopState()?.isOpen, 10);
    checkStop(hooks, 'shop tool purchase stopped waiting for shop');
    if (!shopReady || !hooks.getShopState()?.isOpen) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'shop observation missing' };
    }
    const row = hooks.getShopState()!.shopItems.find(i => i.id === params.targetId);
    const price = row?.buyPrice ?? 0;
    const cashBefore = countIn(hooks.getInventory(), COINS_ID);
    const heldBefore = countIn(hooks.getInventory(), params.targetId);
    if (!row || row.count <= 0 || cashBefore < price + reserve || price > params.maxBudget - reserve) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'stock absent or price over budget' };
    }
    const buyReply = await hooks.buyFromShop(row, 1);
    const confirmed = await hooks.waitUntil(() => !!hooks.stop?.() || (countIn(hooks.getInventory(), params.targetId) === heldBefore + 1 && countIn(hooks.getInventory(), COINS_ID) === cashBefore - price), 10);
    checkStop(hooks, 'shop tool purchase stopped waiting for purchase');
    await hooks.closeShop().catch(() => undefined);
    await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);
    const spent = cashBefore - countIn(hooks.getInventory(), COINS_ID);
    if (!confirmed || countIn(hooks.getInventory(), params.targetId) < heldBefore + 1 || spent !== price) {
        throw new Error(buyReply.success ? `shop buy reconciliation mismatch for ${params.targetId}` : `shop buy refused: ${buyReply.message ?? params.targetId}`);
    }
    if (params.returnBankSpot) {
        const back = await hooks.walkTo(params.returnBankSpot);
        checkStop(hooks, 'shop tool purchase stopped walking back to bank');
        if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
    }
    return { bought: true, id: params.targetId, coinsSpent: spent };
}

export function shouldAttemptShopUpgrade(
    gate: ShopRetryGate,
    tier: number,
    tick: number,
    cooldownTicks: number = SHOP_RESTOCK_COOLDOWN_TICKS,
): boolean {
    if (gate.checkedTier !== undefined && gate.checkedTier >= tier) return false;
    if (gate.failedAt && gate.failedAt.tier >= tier && tick - gate.failedAt.tick < cooldownTicks) return false;
    return true;
}

export function recordShopAttempt(gate: ShopRetryGate, tier: number, tick: number, bought: boolean): void {
    if (bought) {
        gate.checkedTier = Math.max(gate.checkedTier ?? -Infinity, tier);
        if (gate.failedAt && gate.failedAt.tier <= tier) gate.failedAt = undefined;
        return;
    }
    gate.failedAt = { tier, tick };
}

export function sessionShopGate(cache: WeakMap<object, ShopRetryGate>, session: object, explicit?: ShopRetryGate): ShopRetryGate {
    if (explicit) return explicit;
    let gate = cache.get(session);
    if (!gate) { gate = {}; cache.set(session, gate); }
    return gate;
}

export function sessionToolHooks(
    s: SessionToolLike,
    options: {
        openBank?: () => Promise<unknown>;
        closeBank?: () => Promise<unknown>;
        walkTo?: (spot: { x: number; z: number; level?: number }) => Promise<boolean>;
        waitUntil: (pred: () => boolean, timeoutTicks: number) => Promise<boolean>;
        stop?: () => boolean;
    },
): ShopToolPurchaseHooks {
    return {
        openBank: options.openBank ?? (() => s.bot.openBank()),
        closeBank: options.closeBank ?? (() => s.bot.closeBank()),
        withdrawItem: (item, n) => {
            const row = item.slot === undefined ? s.sdk.getState()?.bank?.items.find(i => i.id === item.id) ?? item : item;
            return s.bot.withdrawItem(row, n, { asNote: false });
        },
        depositItem: (item, n) => s.bot.depositItem(item, n),
        equipItem: s.bot.equipItem ? item => s.bot.equipItem!(item) : undefined,
        getInventory: () => s.sdk.getInventory(),
        getEquipment: () => s.sdk.getEquipment?.() ?? s.sdk.getState()?.equipment ?? [],
        getBankState: () => {
            const b = s.sdk.getState()?.bank;
            if (!b) return undefined;
            const obs = s.bankObservation?.();
            return { isOpen: b.isOpen, items: obs?.items ?? b.items };
        },
        getBankGeneration: () => s.bankObservation?.()?.generation,
        walkTo: options.walkTo ?? (async () => false),
        openShop: npc => s.bot.openShop(npc),
        buyFromShop: (item, n) => s.bot.buyFromShop(item, n),
        closeShop: () => s.bot.closeShop(),
        getShopState: () => s.sdk.getState()?.shop,
        waitUntil: options.waitUntil,
        stop: options.stop,
    };
}
