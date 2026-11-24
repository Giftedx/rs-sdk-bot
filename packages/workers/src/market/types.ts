import type { BankProfile, BankRouteJob, Tile } from '../../../core/src/bank-trip';
import type { GEOffer } from '../../../../vendor/rs-sdk/sdk/ge-types';
import type { MarketProgress } from './market-progress';

export type { BankProfile, BankRouteJob, MarketProgress, Tile };

export const MARKET_MODE_IDS = [
    'shop-buy',
    'shop-trip',
    'shop-sell',
    'earth-shop',
    'buy-sword',
    'ge-buy',
    'ge-sell',
    'ge-buy-list',
    'ge-trip',
    'ge-plan',
    'shop-to-bid',
    'bank-seller',
] as const;
export type MarketMode = (typeof MARKET_MODE_IDS)[number];

export type ShopRule = { inv: string; npc: string; sell: number; delta: number; stock: ReadonlyMap<string, number>; src: string };

export interface ShopProfileItem {
    re: RegExp;
    buyPerTick: number;
    shelf?: number;
}

export interface ShopProfile {
    npc: RegExp;
    npcSpot: { x: number; z: number; level?: number };
    bankSpot: { x: number; z: number };
    items: ShopProfileItem[];
    need?: { skill: string; level: number };
    via?: { x: number; z: number }[];
    fare?: number;
    realm?: {
        inside: (p: { worldX: number; worldZ: number }) => boolean;
        wear: RegExp;
        stand: { x: number; z: number };
        door: { id: number; x: number; z: number };
        toll: { id: number; x: number; z: number; stand: { x: number; z: number }; item: RegExp; say: RegExp };
        ladder: { id: number; x: number; z: number; say: RegExp };
        outBank: { x: number; z: number };
    };
    dialogOpen?: RegExp;
    dialogBuy?: { choices: readonly RegExp[]; cost: number; item: RegExp };
    door?: {
        id: number;
        x: number;
        z: number;
        outside: { x: number; z: number };
        insideStand?: { x: number; z: number };
        inside: (p: { worldX: number; worldZ: number; level?: number }) => boolean;
    };
}

export interface ShopPurchaseTarget {
    re: RegExp;
    buyPerTick: number;
}

export interface ShopStock {
    name: string;
    count: number;
    buyPrice: number;
}

export interface ItemRequest {
    actor: string;
    server: string;
    goal: string;
    item: number;
    quantity?: number;
    expectedOwned?: number;
    rescueMode?: 'npc-respawn-once';
    limit: number;
    reserve: number;
    createdAt: number;
    reviewAt: number;
    deadline: number;
}

export interface OrderView {
    actor: string;
    server: string;
    offers: readonly GEOffer[];
    coins: number;
    items: number;
}

export interface SettledRound {
    offerId: number;
    quantity: number;
    acquired: number;
    refund: number;
    progress?: MarketProgress;
}

export interface RescueReceipt {
    phase: 'attempted' | 'respawned' | 'bank-reconciled';
    lifeId: number;
    respawnCount: number;
    targetIndex: number;
    bank: { id: number; count: number }[];
    bankAt: number;
}

export interface ItemOrder {
    rescue?: RescueReceipt;
    submission?: 'prepared' | 'attempted';
    rounds?: SettledRound[];
    version: 1;
    request: ItemRequest;
    phase: 'entry' | 'placing' | 'open' | 'cancelling' | 'collecting' | 'settled';
    coinsBefore: number;
    itemsBefore: number;
    previousIds: number[];
    at: number;
    offerId?: number;
    progress?: MarketProgress;
    claim?: { coinsBefore: number; itemsBefore: number; coins: number; items: number };
    acquired?: number;
    refund?: number;
    failure?: string;
}

export interface SaleRequest {
    actor: string;
    server: string;
    goal: string;
    item: number;
    quantity: number;
    price: number;
    floor: number;
    reserveItems: number;
    deadline: number;
}

export interface SaleJournal {
    version: 1;
    request: SaleRequest;
    phase: 'prepared' | 'attempted' | 'open' | 'cancelling' | 'collecting' | 'settled';
    coinsBefore: number;
    itemsBefore: number;
    previousIds: number[];
    offerId?: number;
    progress?: MarketProgress;
    claim?: { items: number; coins: number };
    banked?: boolean;
    failure?: string;
}

export interface SaleView {
    actor: string;
    server: string;
    coins: number;
    items: number;
    offers: readonly GEOffer[];
}

export interface ShopContract {
    title: string;
    inventory: string;
}

export type ShopTripJob = Omit<BankRouteJob, 'family' | 'recipe'> & {
    merchant: string;
    item: number;
    minimumUnit: number;
    shop?: ShopContract;
};

export interface ShopSaleOptions {
    item: number;
    quantity: number;
    minimumUnit: number;
    reserve: number;
    shopTitle: string;
    cap: number;
    stop?: () => boolean;
}

export interface BuyListEntry {
    item: number;
    quantity: number;
    basePrice: number;
    unitCap: number;
    percent: 5 | 10 | 50 | 99;
}

export interface BuyListRequest {
    actor: string;
    server: string;
    goal: string;
    entries: BuyListEntry[];
    budget: number;
    reserve: number;
    createdAt: number;
    deadline: number;
    fillWait: number;
    cap: number;
}

export interface BuyListJournal {
    version: 1;
    request: BuyListRequest;
    initial: Record<number, number>;
    gear: unknown;
    children: ItemRequest[];
    outcomes: ({ acquired: number; spent: number } | null)[];
    phase: 'prepared' | 'running' | 'banked';
    aborted: boolean;
    failure?: string;
}

export interface GETripRequest {
    actor: string;
    server: string;
    goal: string;
    item: number;
    quantity: number;
    price: number;
    floor: number;
    reserve: number;
    deadline: number;
    fillWait: number;
    cap: number;
}

export interface GETripJournal {
    version: 1;
    request: GETripRequest;
    phase: 'prepared' | 'staging' | 'market' | 'settled' | 'aborted' | 'banked';
    initial: Record<number, number>;
    initialGear: { id: number; slot: number; count: number }[];
    outcome?: { filled: number; gross: number; tax: number; net: number; unsubmitted: boolean };
    failure?: string;
}

export interface GEPricePlan {
    actor: string;
    server: string;
    goal: string;
    item: number;
    quantity: number;
    reserve: number;
    floor: number;
    deadline: number;
    cap: number;
    prices: { price: number; fillWait: number }[];
}

export type GEPlanRound = {
    request: GETripRequest;
    filled: number;
    gross: number;
    tax: number;
    net: number;
    unsubmitted: boolean;
    initial: Record<number, number>;
    gear: GETripJournal['initialGear'];
};

export interface GEPlanJournal {
    version: 1;
    request: GEPricePlan;
    phase: 'prepared' | 'running' | 'resting' | 'complete' | 'stopped';
    rounds: GEPlanRound[];
    current?: GETripRequest;
    failure?: string;
}

export interface BankSellerPolicy {
    actor: string;
    server: string;
    goal: string;
    allTradeable: true;
    protect: number[];
    reserves: Record<number, number>;
    maxItems: number;
    maxUnits: number;
    perItem: number;
    discount: 0 | 5 | 10 | 50;
    floor: number;
    unitCap: number;
    fillWait: number;
    deadline: number;
    cap: number;
    childCap: number;
    liquidation?: { waitTicks: number; fillWait: number };
}

export interface BankSellerJournal {
    version: 1;
    request: BankSellerPolicy;
    phase: 'prepared' | 'running' | 'banked';
    initial: Record<number, number>;
    gear: { id: number; count: number }[];
    protected: number[];
    bank: { id: number; count: number }[];
    offers: number[];
    plans: GEPricePlan[];
    outcomes: { filled: number; gross: number; tax: number; net: number; unsubmitted: boolean }[];
    skipped: { item: number; reason: string }[];
    stopped: boolean;
    failure?: string;
}

export type Quote = { id: number; name: string; basePrice: number; bid: number | null; buyQuantity: number };

export type ShopBuyConfig = {
    readonly mode: 'shop-buy';
    readonly profile: string;
    readonly shopId?: string;
    readonly itemId?: number;
    readonly quantity?: number;
    readonly cap?: number;
    readonly bankAt?: number;
    readonly items?: string;
    readonly stockTarget?: number;
    readonly maxItems?: number;
    readonly maxSpend?: number;
    readonly coinReserve?: number;
    readonly float?: number;
    readonly noBuyTicks?: number;
    readonly blindBuy?: boolean;
    readonly stopAtTarget?: boolean;
    readonly bankPack?: boolean;
    readonly stockPollTicks?: number;
};

export type EarthShopConfig = {
    readonly mode: 'earth-shop';
    readonly profile: 'aubury' | 'betty' | string;
    readonly cap: number;
    readonly target: number;
    readonly maximum: number;
    readonly spend: number;
    readonly reserve: number;
    readonly seedUsed?: number;
};

export type BuySwordConfig = {
    readonly mode: 'buy-sword';
    readonly itemId?: number;
    readonly cap?: number;
    readonly maximumSpend?: number;
    readonly prepareEast?: boolean;
};

export type ShopTripConfig = {
    readonly mode: 'shop-trip' | 'shop-sell';
    readonly job?: ShopTripJob;
    readonly jobFile?: string;
};

export type GeBuyConfig = {
    readonly mode: 'ge-buy';
    readonly request?: ItemRequest;
    readonly server?: string;
    readonly goal?: string;
    readonly itemId?: number;
    readonly quantity?: number;
    readonly expectedOwned?: number;
    readonly limitPrice?: number;
    readonly cashReserve?: number;
    readonly orderMs?: number;
    readonly fillWaitTicks?: number;
    readonly cancel?: boolean;
    readonly rescueMode?: 'npc-respawn-once';
    readonly shopProfile?: string;
    readonly cap?: number;
};

export type GeSellConfig = {
    readonly mode: 'ge-sell';
    readonly request?: SaleRequest;
    readonly server?: string;
    readonly goal?: string;
    readonly itemId?: number;
    readonly quantity?: number;
    readonly sellPrice?: number;
    readonly floorPrice?: number;
    readonly reserveItems?: number;
    readonly orderMs?: number;
    readonly fillWaitTicks?: number;
    readonly cancel?: boolean;
    readonly fromBank?: boolean;
    readonly bankCoins?: boolean;
};

export type GeBuyListConfig = {
    readonly mode: 'ge-buy-list';
    readonly request?: BuyListRequest;
    readonly requestFile?: string;
};

export type GeTripConfig = {
    readonly mode: 'ge-trip';
    readonly request?: GETripRequest;
    readonly requestFile?: string;
};

export type GePlanConfig = {
    readonly mode: 'ge-plan';
    readonly plan?: GEPricePlan;
    readonly planFile?: string;
    readonly finish?: boolean;
};

export type BankSellerConfig = {
    readonly mode: 'bank-seller';
    readonly policy?: BankSellerPolicy;
    readonly policyFile?: string;
};

export type ShopToBidConfig = {
    readonly mode: 'shop-to-bid';
    readonly profiles: readonly string[];
    readonly itemIds: readonly number[];
    readonly units?: number;
    readonly minNet?: number;
    readonly coinReserve?: number;
    readonly maxSpend?: number;
    readonly waitTicks?: number;
    readonly minLot?: number;
    readonly lots?: number;
    readonly scanOnly?: boolean;
};

export type MarketConfig = (
    | ShopBuyConfig
    | EarthShopConfig
    | BuySwordConfig
    | ShopTripConfig
    | GeBuyConfig
    | GeSellConfig
    | GeBuyListConfig
    | GeTripConfig
    | GePlanConfig
    | BankSellerConfig
    | ShopToBidConfig
) & {
    readonly stop?: () => boolean;
};
