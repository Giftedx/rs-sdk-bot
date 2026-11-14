// AIO Market ("MK Auto Buyer & GE Trader"): unified entry for NPC shop buying/selling and Grand Exchange orders.
// Usage:
//   bun scripts/aio-market.ts <account> <mode> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import {parseStep,type Step} from '../packages/core/src/chain-step';
import {
 orderQuantity,orderEscrow,orderAccounting,earthShopFallback,shopFallbackSpent,
 validateRequest,orderItemMatcher,orderPaths,type ItemRequest,type ItemOrder,
} from './buy-owned-ge-item';
import {
 validateSale,saleProgress,salePlacement,saleClaim,saleCollected,saleResting,runOwnedSale,
 type SaleRequest,type SaleJournal,type SaleView,
} from './sell-owned-ge-item';
import {PROFILES as SHOP_PROFILES,planShopPurchases,buyWithBudget,maximumUnitCost} from './shop-buyer';

export {
 orderQuantity,orderEscrow,orderAccounting,earthShopFallback,shopFallbackSpent,
 validateRequest,orderItemMatcher,orderPaths,type ItemRequest,type ItemOrder,
 validateSale,saleProgress,salePlacement,saleClaim,saleCollected,saleResting,runOwnedSale,
 type SaleRequest,type SaleJournal,type SaleView,
 SHOP_PROFILES,planShopPurchases,buyWithBudget,maximumUnitCost,
};

export interface MarketModeSpec {
 mode: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const MARKET_MODES: readonly MarketModeSpec[] = [
 {mode:'shop-buy',script:'scripts/shop-buyer.ts',description:'Buy items from any mapped NPC shop (Aubury, Betty, Hickton, Harry, Lowe, Zeke, etc.) and bank'},
 {mode:'shop-trip',script:'scripts/microbot-shop-trip.ts',description:'Bank-staged NPC shop buying trip with exact coin/item reconciliation'},
 {mode:'shop-sell',script:'scripts/microbot-a-shop-sell.ts',description:'Sell inventory items to NPC shopkeeper with minimum stock/price rules'},
 {mode:'earth-shop',script:'scripts/earth-shop.ts',description:'Refill earth/elemental runes from magic shops'},
 {mode:'buy-sword',script:'scripts/buy-owned-sword.ts',description:'Buy owned training sword from Varrock sword shop'},
 {mode:'ge-buy',script:'scripts/buy-owned-ge-item.ts',description:'Place, track, collect, and bank a finite Grand Exchange buy order with journal accounting'},
 {mode:'ge-sell',script:'scripts/sell-owned-ge-item.ts',description:'Place, track, collect, and bank a finite Grand Exchange sell order'},
 {mode:'ge-buy-list',script:'scripts/microbot-ge-buy-list.ts',description:'Execute a multi-item Grand Exchange shopping list'},
 {mode:'ge-trip',script:'scripts/microbot-ge-trip.ts',description:'Bank-to-GE round trip for buying/selling'},
 {mode:'ge-plan',script:'scripts/microbot-ge-plan.ts',description:'Compute Grand Exchange order plan from bank state'},
 {mode:'shop-to-bid',script:'scripts/shop-to-bid.ts',description:'Buy a stackable item from an NPC shop and sell it into an open Grand Exchange bid above the shop price'},
 {mode:'bank-seller',script:'scripts/microbot-bank-seller.ts',description:'Withdraw and liquidate banked surplus items'},
];

// Convert a map of item shortfalls ({ [itemId]: deficitCount }) and unit price limits into validated, budget-bounded GE ItemRequests.
export function planGeRestockOrders(options: {
 actor: string;
 server: string;
 goalPrefix: string;
 shortfalls: Readonly<Record<number, { quantity: number; limitPrice: number; expectedOwned?: number }>>;
 coinsAvailable: number;
 coinReserve: number;
 now?: number;
 reviewMs?: number;
 deadlineMs?: number;
}): { funded: ItemRequest[]; unfunded: number[]; totalEscrow: number; remainingCoins: number } {
 const now = options.now ?? Date.now(), reviewAt = now + (options.reviewMs ?? 60_000), deadline = now + (options.deadlineMs ?? 900_000);
 let spendable = Math.max(0, options.coinsAvailable - options.coinReserve), totalEscrow = 0;
 const funded: ItemRequest[] = [], unfunded: number[] = [];
 for (const [rawId, spec] of Object.entries(options.shortfalls)) {
  const item = Number(rawId);
  if (!Number.isSafeInteger(spec.quantity) || spec.quantity < 1 || !Number.isSafeInteger(spec.limitPrice) || spec.limitPrice < 1) {
   throw Error(`aio-market: invalid shortfall spec for item ${item}`);
  }
  const escrow = spec.quantity * spec.limitPrice;
  if (escrow > spendable) {
   unfunded.push(item);
   continue;
  }
  const req: ItemRequest = {
   actor: options.actor,
   server: options.server,
   goal: `${options.goalPrefix}-${item}`.slice(0, 64),
   item,
   quantity: spec.quantity,
   ...(spec.expectedOwned !== undefined ? { expectedOwned: spec.expectedOwned } : {}),
   limit: spec.limitPrice,
   reserve: options.coinReserve,
   createdAt: now,
   reviewAt,
   deadline,
  };
  validateRequest(req);
  funded.push(req);
  spendable -= escrow;
  totalEscrow += escrow;
 }
 return { funded, unfunded, totalEscrow, remainingCoins: spendable + options.coinReserve };
}

export function resolveMarketStep(modeInput: string, rest: readonly string[] = []): Step {
 const mode = modeInput.toLowerCase().replace(/^--mode=/, '').replace(/^--type=/, '');
 const spec = MARKET_MODES.find(m => m.mode === mode);
 if (!spec) {
  throw Error(`aio-market: unknown mode "${mode}"; known: ${MARKET_MODES.map(m => m.mode).join(', ')}`);
 }
 const tokens = rest.length ? rest : [...(spec.defaultArgs ?? [])];
 const step = parseStep([spec.script, ...tokens].join(' '));
 return { script: step.script, args: step.args, env: { ...(spec.defaultEnv ?? {}), ...step.env } };
}

export async function runAioMarket(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-market requires account');
 const [mode, ...rest] = args;
 if (!mode) throw Error('aio-market requires <mode>');
 const step = resolveMarketStep(mode, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
}

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify(MARKET_MODES, null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-market.ts <account> <shop-buy|shop-trip|shop-sell|ge-buy|ge-sell|ge-buy-list|bank-seller> [args...]');
  process.exit(2);
 }
 const result = await runAioMarket(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
