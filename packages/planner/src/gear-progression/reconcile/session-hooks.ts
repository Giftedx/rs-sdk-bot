// Session-to-hook adapter bridging bot/SDK instances into ShopToolPurchaseHooks without SDK imports.
import type { SessionToolLike, ShopToolPurchaseHooks } from './model';

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
