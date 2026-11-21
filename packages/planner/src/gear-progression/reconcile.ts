// Bank tool swap reconciliation, shop tool purchase execution, retry gates, and session hook adaptation.
import type { GearCount } from '../owned-loadout';

export interface BankToolSwapPlan {
    targetId: number;
    withdrawFromBank: boolean;
    equipInWeaponSlot: boolean;
    depositInventoryIds: number[];
    alreadyActive: boolean;
}

/** Pure plan for activating `targetId` at an open bank without losing any item in `toolGroupIds`. */
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
    const invCount = (id: number) => params.inventory.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => params.bank.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const weapon = params.equipment.find(i => i.slot === 3);
    const wearingTarget = weapon?.id === params.targetId;
    const heldTarget = invCount(params.targetId) > 0;
    const withdrawFromBank = !wearingTarget && !heldTarget && bankCount(params.targetId) > 0;
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

    const alreadyActive = !withdrawFromBank
        && !equipInWeaponSlot
        && depositSet.size === 0
        && (wearingTarget || heldTarget);

    return {
        targetId: params.targetId,
        withdrawFromBank,
        equipInWeaponSlot,
        depositInventoryIds: [...depositSet],
        alreadyActive,
    };
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

/**
 * Reconcile a chosen tool/staff against an already-open (or openable) bank:
 * deposits redundant tools first when space is tight, withdraws `targetId` if needed,
 * wields when eligible and allowed, and preserves exact item counts across `toolGroupIds`.
 */
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
    const checkStop = (why: string) => {
        if (hooks.stop?.()) throw new Error(why);
    };
    const countIn = (rows: readonly { id: number; count?: number }[], id: number) =>
        rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
    const groupTotals = () => {
        const st = hooks.getBankState();
        if (!st?.isOpen) throw new Error('tool reconcile requires open bank');
        const out = new Map<number, number>();
        for (const id of params.toolGroupIds) {
            out.set(
                id,
                countIn(hooks.getInventory(), id) + countIn(hooks.getEquipment(), id) + countIn(st.items, id),
            );
        }
        return out;
    };

    checkStop('tool reconcile stopped');
    if (!hooks.getBankState()?.isOpen) {
        await hooks.openBank();
        const opened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
        checkStop('tool reconcile stopped opening bank');
        if (!opened || !hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank open unobserved');
    }

    const before = groupTotals();
    let bankSt = hooks.getBankState()!;
    let plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: params.canWield,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: bankSt.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });

    if (plan.alreadyActive) {
        const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
        return { activeId: params.targetId, worn, changed: false };
    }

    const depositOneId = async (id: number) => {
        const item = hooks.getInventory().find(i => i.id === id);
        if (!item) return;
        const inv0 = countIn(hooks.getInventory(), id);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.depositItem(item, -1);
        const ok = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const gen = hooks.getBankGeneration?.();
            return countIn(hooks.getInventory(), id) < inv0 && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop('tool reconcile stopped during deposit');
        if (!ok || countIn(hooks.getInventory(), id) > 0) throw new Error(`tool deposit unconfirmed for ${id}`);
    };

    // Free space first if withdrawing into a full pack and carrying inferior tools.
    if (plan.withdrawFromBank && hooks.getInventory().length >= 28) {
        for (const depId of plan.depositInventoryIds) {
            checkStop('tool reconcile stopped freeing slot');
            await depositOneId(depId);
            if (hooks.getInventory().length < 28) break;
        }
    }

    if (plan.withdrawFromBank) {
        checkStop('tool reconcile stopped before withdraw');
        if (hooks.getInventory().length >= 28) throw new Error(`tool upgrade ${params.targetId} needs one free slot`);
        bankSt = hooks.getBankState()!;
        const bankRow = bankSt.items.find(i => i.id === params.targetId && i.count > 0);
        if (!bankRow) throw new Error(`owned tool ${params.targetId} missing from open bank`);
        const held0 = countIn(hooks.getInventory(), params.targetId);
        const stored0 = countIn(bankSt.items, params.targetId);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.withdrawItem(bankRow, 1);
        const matched = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const st = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!st?.isOpen
                && countIn(hooks.getInventory(), params.targetId) === held0 + 1
                && countIn(st.items, params.targetId) === stored0 - 1
                && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        checkStop('tool reconcile stopped after withdraw');
        if (!matched) throw new Error(`tool withdrawal unconfirmed for ${params.targetId}`);
    }

    if (plan.equipInWeaponSlot && hooks.equipItem) {
        checkStop('tool reconcile stopped before equip');
        const invItem = hooks.getInventory().find(i => i.id === params.targetId);
        if (!invItem) throw new Error(`tool ${params.targetId} missing from inventory before equip`);
        const gen0 = hooks.getBankGeneration?.();
        await hooks.closeBank();
        const closed = await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, 8);
        checkStop('tool reconcile stopped closing bank');
        if (!closed || hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank close unobserved');
        try {
            await hooks.equipItem(invItem);
        } catch {
            // Observe actual worn slot rather than retrying an uncertain wield.
        }
        await hooks.waitUntil(() => !!hooks.stop?.() || hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId), 3);
        if (!hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId)) {
            params.refusedWields?.add(params.targetId);
        }
        checkStop('tool reconcile stopped after equip');
        await hooks.openBank();
        const reopened = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const st = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!st?.isOpen && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 12);
        checkStop('tool reconcile stopped reopening bank');
        if (!reopened || !hooks.getBankState()?.isOpen) throw new Error('tool reconcile bank reopen unobserved');
    }

    // Recompute deposits after equip (wielded tool may have swapped old weapon into inventory).
    // Keep target tool in inventory if wield did not take place.
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
        checkStop('tool reconcile stopped before inferior deposit');
        await depositOneId(depId);
    }

    const after = groupTotals();
    for (const id of params.toolGroupIds) {
        if ((before.get(id) ?? 0) !== (after.get(id) ?? 0)) {
            throw new Error(`tool reconcile asset mismatch for ${id}`);
        }
    }
    const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    const held = hooks.getInventory().some(i => i.id === params.targetId);
    if (!worn && !held) throw new Error(`target tool ${params.targetId} not active after reconcile`);
    return { activeId: params.targetId, worn, changed: true };
}

const TOOL_SHOP_LOCATIONS = {
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

export const SHOP_RESTOCK_COOLDOWN_TICKS = 700;

export interface ShopRetryGate {
    checkedTier?: number;
    failedAt?: { tier: number; tick: number };
}

/**
 * Per-tier and failed-shop cooldown guard for progressive tool/staff purchases.
 * Skips already-bought tiers until a higher tier unlocks, and backs off failed
 * shelf checks for `cooldownTicks` (default 700 ticks for slow restocks).
 */
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

/** Record whether a shop purchase check succeeded or failed for `tier` at `tick`. */
export function recordShopAttempt(
    gate: ShopRetryGate,
    tier: number,
    tick: number,
    bought: boolean,
): void {
    if (bought) {
        gate.checkedTier = Math.max(gate.checkedTier ?? -Infinity, tier);
        if (gate.failedAt && gate.failedAt.tier <= tier) gate.failedAt = undefined;
        return;
    }
    gate.failedAt = { tier, tick };
}

/** Return or allocate a per-session `ShopRetryGate` stored in `cache` unless `explicit` is supplied. */
export function sessionShopGate(
    cache: WeakMap<object, ShopRetryGate>,
    session: object,
    explicit?: ShopRetryGate,
): ShopRetryGate {
    if (explicit) return explicit;
    let gate = cache.get(session);
    if (!gate) {
        gate = {};
        cache.set(session, gate);
    }
    return gate;
}

/**
 * Buy a single tool/staff from a rev-289 shop with exact coin/item reconciliation:
 * withdraws only missing coin budget when needed, verifies stock/price, buys 1, closes shop,
 * returns to `returnBankSpot` if supplied, and re-deposits withdrawn coins if aborted.
 */
export async function executeShopToolPurchase(
    hooks: ShopToolPurchaseHooks,
    params: {
        targetId: number;
        shop: KnownToolShop;
        maxBudget: number;
        coinReserve?: number;
        returnBankSpot?: { x: number; z: number; level?: number };
    },
): Promise<{ bought: boolean; id: number; coinsSpent: number; reason?: string }> {
    const checkStop = (why: string) => {
        if (hooks.stop?.()) throw new Error(why);
    };
    const countIn = (rows: readonly { id: number; count?: number }[], id: number) =>
        rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
    const COINS = 995;
    const reserve = Math.max(0, params.coinReserve ?? 0);
    const shopDef = TOOL_SHOP_LOCATIONS[params.shop];
    let withdrewCoins = 0;
    let walkedToShop = false;

    const recoverToBank = async () => {
        if (hooks.getShopState()?.isOpen) {
            await hooks.closeShop().catch(() => undefined);
            await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);
            checkStop('shop tool purchase stopped closing shop');
        }
        if (walkedToShop && params.returnBankSpot) {
            const back = await hooks.walkTo(params.returnBankSpot);
            checkStop('shop tool purchase stopped walking back to bank');
            if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
        }
        if (withdrewCoins > 0) {
            if (!hooks.getBankState()?.isOpen) {
                await hooks.openBank();
                const reopened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
                checkStop('shop tool purchase stopped reopening bank');
                if (!reopened || !hooks.getBankState()?.isOpen) {
                    throw new Error('shop tool purchase bank reopen unobserved');
                }
            }
            const coinRow = hooks.getInventory().find(i => i.id === COINS && i.count > 0);
            if (coinRow) {
                const depositAmt = Math.min(coinRow.count, withdrewCoins);
                const invBefore = countIn(hooks.getInventory(), COINS);
                const bankBefore = countIn(hooks.getBankState()!.items, COINS);
                const gen0 = hooks.getBankGeneration?.();
                await hooks.depositItem(coinRow, depositAmt === coinRow.count ? -1 : depositAmt);
                const deposited = await hooks.waitUntil(() => {
                    if (hooks.stop?.()) return true;
                    const bst = hooks.getBankState();
                    const gen = hooks.getBankGeneration?.();
                    return !!bst?.isOpen
                        && countIn(hooks.getInventory(), COINS) === invBefore - depositAmt
                        && countIn(bst.items, COINS) === bankBefore + depositAmt
                        && (gen0 === undefined || (gen ?? -1) > gen0);
                }, 10);
                checkStop('shop tool purchase stopped depositing withdrawn coins');
                if (!deposited) throw new Error('shop coin return deposit unconfirmed');
            }
        }
    };

    checkStop('shop tool purchase stopped');
    let invCoins = countIn(hooks.getInventory(), COINS);
    if (invCoins < params.maxBudget) {
        if (!hooks.getBankState()?.isOpen) {
            await hooks.openBank();
            const opened = await hooks.waitUntil(() => !!hooks.stop?.() || !!hooks.getBankState()?.isOpen, 10);
            checkStop('shop tool purchase stopped opening bank');
            if (!opened || !hooks.getBankState()?.isOpen) {
                return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'bank unavailable for coins' };
            }
        }
        const st = hooks.getBankState()!;
        const bankCoinRow = st.items.find(i => i.id === COINS);
        const bankCoins = countIn(st.items, COINS);
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
                return !!bst?.isOpen
                    && countIn(hooks.getInventory(), COINS) === invCoins + need
                    && countIn(bst.items, COINS) === bankCoins - need
                    && (gen0 === undefined || (gen ?? -1) > gen0);
            }, 10);
            if (ok) withdrewCoins += need;
            checkStop('shop tool purchase stopped withdrawing coins');
            if (!ok) throw new Error('shop coin withdrawal unconfirmed');
            invCoins = countIn(hooks.getInventory(), COINS);
        }
    }

    if (hooks.getBankState()?.isOpen) {
        await hooks.closeBank();
        await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, 8);
        checkStop('shop tool purchase stopped closing bank');
    }

    if (hooks.getInventory().length >= 28) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'inventory full' };
    }

    walkedToShop = true;
    const arrived = await hooks.walkTo(shopDef.spot);
    checkStop('shop tool purchase stopped walking to shop');
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
    checkStop('shop tool purchase stopped waiting for shop');
    if (!shopReady || !hooks.getShopState()?.isOpen) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'shop observation missing' };
    }

    const row = hooks.getShopState()!.shopItems.find(i => i.id === params.targetId);
    const price = row?.buyPrice ?? 0;
    const cashBefore = countIn(hooks.getInventory(), COINS);
    const heldBefore = countIn(hooks.getInventory(), params.targetId);
    if (!row || row.count <= 0 || cashBefore < price + reserve || price > params.maxBudget - reserve) {
        await recoverToBank();
        return { bought: false, id: params.targetId, coinsSpent: 0, reason: 'stock absent or price over budget' };
    }

    const buyReply = await hooks.buyFromShop(row, 1);
    const confirmed = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        return countIn(hooks.getInventory(), params.targetId) === heldBefore + 1
            && countIn(hooks.getInventory(), COINS) === cashBefore - price;
    }, 10);
    checkStop('shop tool purchase stopped waiting for purchase');
    await hooks.closeShop().catch(() => undefined);
    await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);

    const spent = cashBefore - countIn(hooks.getInventory(), COINS);
    if (!confirmed || countIn(hooks.getInventory(), params.targetId) < heldBefore + 1 || spent !== price) {
        throw new Error(buyReply.success ? `shop buy reconciliation mismatch for ${params.targetId}` : `shop buy refused: ${buyReply.message ?? params.targetId}`);
    }

    if (params.returnBankSpot) {
        const back = await hooks.walkTo(params.returnBankSpot);
        checkStop('shop tool purchase stopped walking back to bank');
        if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
    }

    return { bought: true, id: params.targetId, coinsSpent: spent };
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

/** Build tool-reconcile & shop-purchase hooks from a bot Session (zero runtime SDK imports in planner). */
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
        // The SDK takes a bank row with a slot. A row from the bank observation has none: use the open bank's row of
        // the same id (without it the SDK looks the item up by name and throws on an object).
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
