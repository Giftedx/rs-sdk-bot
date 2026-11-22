// Per-session shop upgrade retry and restock cooldown gates.
import { SHOP_RESTOCK_COOLDOWN_TICKS, type ShopRetryGate } from './model';

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
