// Domain contracts, cooldown defaults, and shop coordinates for tool bank/shop reconciliation.
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

export const SHOP_RESTOCK_COOLDOWN_TICKS = 700;

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
