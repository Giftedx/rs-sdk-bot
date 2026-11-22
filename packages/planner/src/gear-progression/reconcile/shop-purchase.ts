// Reconciled tool/staff shop purchase flow with coin withdrawal, verification, and rollback-to-bank recovery.
import { TOOL_SHOP_LOCATIONS, type KnownToolShop, type ShopToolPurchaseHooks } from './model';
import { checkStop, countIn, tryCloseBank, tryOpenBank } from './bank-plan';

const COINS_ID = 995;

async function returnAndRedepositCoins(
    hooks: ShopToolPurchaseHooks,
    walkedToShop: boolean,
    withdrewCoins: number,
    returnBankSpot?: { x: number; z: number; level?: number },
): Promise<void> {
    if (hooks.getShopState()?.isOpen) {
        await hooks.closeShop().catch(() => undefined);
        await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getShopState()?.isOpen, 6);
        checkStop(hooks, 'shop tool purchase stopped closing shop');
    }
    if (walkedToShop && returnBankSpot) {
        const back = await hooks.walkTo(returnBankSpot);
        checkStop(hooks, 'shop tool purchase stopped walking back to bank');
        if (!back) throw new Error('shop tool purchase return-to-bank walk failed');
    }
    if (withdrewCoins <= 0) return;

    if (!hooks.getBankState()?.isOpen) {
        if (!(await tryOpenBank(hooks, 'shop tool purchase stopped reopening bank', 10))) {
            throw new Error('shop tool purchase bank reopen unobserved');
        }
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
        return !!bst?.isOpen
            && countIn(hooks.getInventory(), COINS_ID) === invBefore - depositAmt
            && countIn(bst.items, COINS_ID) === bankBefore + depositAmt
            && (gen0 === undefined || (gen ?? -1) > gen0);
    }, 10);
    checkStop(hooks, 'shop tool purchase stopped depositing withdrawn coins');
    if (!deposited) throw new Error('shop coin return deposit unconfirmed');
}

async function prepareCoinBudget(
    hooks: ShopToolPurchaseHooks,
    targetId: number,
    maxBudget: number,
): Promise<{ ok: true; withdrewCoins: number } | { ok: false; failure: { bought: false; id: number; coinsSpent: 0; reason: string } }> {
    let invCoins = countIn(hooks.getInventory(), COINS_ID);
    let withdrewCoins = 0;
    if (invCoins >= maxBudget) return { ok: true, withdrewCoins };

    if (!hooks.getBankState()?.isOpen) {
        if (!(await tryOpenBank(hooks, 'shop tool purchase stopped opening bank', 10))) {
            return { ok: false, failure: { bought: false, id: targetId, coinsSpent: 0, reason: 'bank unavailable for coins' } };
        }
    }
    const st = hooks.getBankState()!;
    const bankCoinRow = st.items.find(i => i.id === COINS_ID);
    const bankCoins = countIn(st.items, COINS_ID);
    if (invCoins + bankCoins < maxBudget) {
        await hooks.closeBank();
        return { ok: false, failure: { bought: false, id: targetId, coinsSpent: 0, reason: 'insufficient coins' } };
    }
    const need = maxBudget - invCoins;
    if (need > 0 && bankCoinRow) {
        if (hooks.getInventory().length >= (invCoins === 0 ? 27 : 28)) {
            await hooks.closeBank();
            return { ok: false, failure: { bought: false, id: targetId, coinsSpent: 0, reason: 'no free slot for coins and tool' } };
        }
        const gen0 = hooks.getBankGeneration?.();
        await hooks.withdrawItem(bankCoinRow, need);
        const ok = await hooks.waitUntil(() => {
            if (hooks.stop?.()) return true;
            const bst = hooks.getBankState();
            const gen = hooks.getBankGeneration?.();
            return !!bst?.isOpen
                && countIn(hooks.getInventory(), COINS_ID) === invCoins + need
                && countIn(bst.items, COINS_ID) === bankCoins - need
                && (gen0 === undefined || (gen ?? -1) > gen0);
        }, 10);
        if (ok) withdrewCoins += need;
        checkStop(hooks, 'shop tool purchase stopped withdrawing coins');
        if (!ok) throw new Error('shop coin withdrawal unconfirmed');
    }
    return { ok: true, withdrewCoins };
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
    const reserve = Math.max(0, params.coinReserve ?? 0);
    const shopDef = TOOL_SHOP_LOCATIONS[params.shop];
    let withdrewCoins = 0;
    let walkedToShop = false;
    const recoverToBank = () => returnAndRedepositCoins(hooks, walkedToShop, withdrewCoins, params.returnBankSpot);

    checkStop(hooks, 'shop tool purchase stopped');
    const prep = await prepareCoinBudget(hooks, params.targetId, params.maxBudget);
    if (!prep.ok) return prep.failure;
    withdrewCoins = prep.withdrewCoins;

    if (hooks.getBankState()?.isOpen) {
        await tryCloseBank(hooks, 'shop tool purchase stopped closing bank', 8);
    }

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
    const confirmed = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        return countIn(hooks.getInventory(), params.targetId) === heldBefore + 1
            && countIn(hooks.getInventory(), COINS_ID) === cashBefore - price;
    }, 10);
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
