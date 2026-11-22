import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitUntil } from '../../../core/src/ticks';
import type { GEOffer } from '../../../../vendor/rs-sdk/sdk/ge-types';
import { collectClaim, loadGeItemCatalogue, marketEntryFailure, marketTileSafe, orderItemMatcher } from './ge-common';
import { marketProgress } from './market-progress';
import type { SaleJournal, SaleRequest, SaleView } from './types';
import { walkTargetPersist } from './walk';

export type { SaleJournal, SaleRequest, SaleView };

const VARROCK_BANK = { x: 3185, z: 3436, level: 0 };
const GE_SPOT = { x: 3184, z: 3440, level: 0 };

let cachedItems: { id: number; name: string }[] | undefined;
const itemCatalogue = () => (cachedItems ??= loadGeItemCatalogue());

export function saleItemMatcher(itemId: number, catalogue: readonly { id: number; name: string }[] = itemCatalogue()) {
    const match = orderItemMatcher(itemId, catalogue);
    return (i: { id: number; baseId?: number; name?: string }) => i.id === itemId || i.baseId === itemId || match(i);
}

export function validateSale(r: SaleRequest) {
    if (!/^[a-z0-9]{1,12}$/i.test(r.actor) || !r.server || !/^[a-z0-9_-]{1,64}$/i.test(r.goal)
        || ![r.item, r.quantity, r.price, r.floor, r.deadline].every(n => Number.isSafeInteger(n) && n > 0)
        || !Number.isSafeInteger(r.reserveItems) || r.reserveItems < 0 || r.price < r.floor
        || r.price * r.quantity > 2147483647 || r.item === 995) {
        throw Error('invalid finite sale request');
    }
}

function identity(j: SaleJournal, v: SaleView) {
    if (j.request.actor.toLowerCase() !== v.actor.toLowerCase() || j.request.server !== v.server) throw Error('sale actor/server changed');
}

function matches(j: SaleJournal, o: GEOffer) {
    const r = j.request;
    return o.item === r.item && o.quantity === r.quantity && o.price === r.price && o.side === 'sell';
}

export function saleProgress(j: SaleJournal, o: GEOffer) {
    if (o.id !== j.offerId || !matches(j, o) || o.tax !== Math.floor(o.gross / 20)) throw Error('sale identity/cumulative tax mismatch');
    return marketProgress(j.progress ?? null, {
        actor: j.request.actor,
        server: j.request.server,
        offerId: o.id,
        itemId: o.item,
        side: o.side,
        quantity: o.quantity,
        limit: o.price,
        filled: o.filled,
        gross: o.gross,
        tax: o.tax,
        at: Date.now(),
    }).current;
}

export function salePlacement(j: SaleJournal, v: SaleView) {
    identity(j, v);
    const found = v.offers.filter(o => !j.previousIds.includes(o.id) && matches(j, o));
    if (found.length > 1) throw Error('ambiguous sale placement');
    if (!found.length) return;
    if (v.items !== j.itemsBefore - j.request.quantity || v.coins !== j.coinsBefore) throw Error('sale escrow debit mismatch');
    return found[0];
}

export function salePlacementReady(j: SaleJournal, v: SaleView) {
    try {
        return !!salePlacement(j, v);
    } catch (e) {
        if (String(e).includes('sale escrow debit mismatch')) return false;
        throw e;
    }
}

export function saleClaim(j: SaleJournal, o: GEOffer) {
    saleProgress(j, o);
    if (o.state === 'open' || o.remaining !== 0 || o.items !== j.request.quantity - o.filled
        || o.coins !== o.gross - o.tax || (o.state === 'completed' && o.filled !== j.request.quantity)) {
        throw Error('sale terminal escrow mismatch');
    }
    return { items: o.items, coins: o.coins };
}

export function saleCollected(j: SaleJournal, v: SaleView) {
    identity(j, v);
    return !!j.claim && !!j.progress && j.claim.items === j.request.quantity - j.progress.filled
        && j.claim.coins === j.progress.gross - j.progress.tax && !v.offers.some(o => o.id === j.offerId)
        && v.items === j.itemsBefore - j.request.quantity + j.claim.items && v.coins === j.coinsBefore + j.claim.coins;
}

export function saleResting(j: SaleJournal, v: SaleView) {
    identity(j, v);
    const o = v.offers.find(offer => offer.id === j.offerId);
    if (j.phase !== 'open' || !o || o.state !== 'open' || v.items !== j.itemsBefore - j.request.quantity || v.coins !== j.coinsBefore) {
        throw Error('resting sale escrow/offer changed');
    }
    const progress = saleProgress(j, o);
    if (o.remaining !== j.request.quantity - o.filled || o.remaining < 1 || o.items !== 0 || o.coins !== o.gross - o.tax) {
        throw Error('resting sale private escrow inconsistent');
    }
    return {
        offerId: o.id,
        remaining: o.remaining,
        filled: o.filled,
        gross: progress.gross,
        tax: progress.tax,
        itemsEscrow: o.remaining + o.items,
        unfilledItems: o.remaining,
        collectibleItems: o.items,
        coinsEscrow: o.coins,
    };
}

export async function runOwnedSale(
    s: Session,
    r: SaleRequest,
    path: string,
    stop: () => boolean,
    waitTicks = 40,
    cancel = false,
    options: { leaveOpen?: boolean; fatal?: () => boolean; collectNotes?: boolean; catalogue?: readonly { id: number; name: string }[]; reserveInBank?: boolean } = {},
) {
    validateSale(r);
    if (s.name.toLowerCase() !== r.actor.toLowerCase() || !Number.isSafeInteger(waitTicks) || waitTicks < 0 || waitTicks > 200) {
        throw Error('sale actor/wait invalid');
    }
    if (!await waitUntil(s, () => !!s.sdk.getState()?.player && s.sdk.getStateAge() < 5000, { timeoutTicks: 15 })) {
        throw Error('fresh sale entry absent');
    }
    const entry = marketEntryFailure(s.sdk.getState()?.player, s.sdk.getSkill('Hitpoints')?.level ?? 0);
    if (entry) throw Error(entry);
    const start = s.tick();
    const hp = s.sdk.getSkill('Hitpoints')!.level;
    const original = s.sdk.getState()?.player;
    const life = original?.lifeId;
    const respawns = original?.respawnCount ?? 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return ended || !p || p.isDead || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp || !!options.fatal?.();
    };
    const unsafe = () => fatal() || stop() || s.tick() - start > 350;
    const matchItem = saleItemMatcher(r.item, options.catalogue);
    const held = (id: number) => s.sdk.getInventory().filter(i => (id === r.item ? matchItem(i) : i.id === id)).reduce((n, i) => n + i.count, 0);
    let j: SaleJournal | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (j && (j.version !== 1 || JSON.stringify(j.request) !== JSON.stringify(r)
        || !['prepared', 'attempted', 'open', 'cancelling', 'collecting', 'settled'].includes(j.phase))) {
        throw Error('sale journal identity/config changed');
    }
    const save = () => {
        writeFileSync(path + '.tmp', JSON.stringify(j, null, 2));
        renameSync(path + '.tmp', path);
    };
    const view = (): SaleView => {
        const ge = s.sdk.getGEState();
        if (!ge || s.sdk.getStateAge() > 5000) throw Error('fresh private sale observation absent');
        return { actor: s.name, server: r.server, coins: held(995), items: held(r.item), offers: ge.offers };
    };
    try {
        if (options.leaveOpen && !Number.isSafeInteger(life)) throw Error('Finish original life unknown');
        const finishCleanup = options.leaveOpen && j && ['open', 'cancelling', 'collecting'].includes(j.phase) && !fatal();
        if (unsafe() && !finishCleanup) throw Error('sale stopped before exchange');
        if (!(await s.bot.openGE(15000)).success) throw Error('sale exchange unavailable');
        if (fatal()) throw Error('sale original life/HP changed during exchange entry');
        if (!j) {
            const v = view();
            if (cancel || Date.now() >= r.deadline || v.items < r.quantity + (options.reserveInBank ? 0 : r.reserveItems) || s.sdk.getInventory().length > 26) {
                throw Error('sale surplus/deadline/collection space missing');
            }
            j = { version: 1, request: r, phase: 'prepared', coinsBefore: v.coins, itemsBefore: v.items, previousIds: v.offers.map(o => o.id) };
            save();
        }
        if (j.phase === 'settled') {
            if (!saleCollected(j, view())) throw Error('settled sale assets changed');
            return { ok: true, journal: j, replay: true };
        }
        if (j.phase === 'prepared') {
            const v = view();
            if (unsafe() || cancel || Date.now() >= r.deadline || v.items !== j.itemsBefore || v.coins !== j.coinsBefore
                || v.offers.length !== j.previousIds.length || !v.offers.every(o => j!.previousIds.includes(o.id))) {
                throw Error('prepared sale baseline changed');
            }
            j.phase = 'attempted';
            save();
            try {
                await s.bot.placeGEOffer({ item: r.item, quantity: r.quantity, side: 'sell', price: r.price }, 20000);
            } catch { /* Reconcile native effects before any retry. */ }
        }
        if (j.phase === 'attempted') {
            await waitUntil(s, () => salePlacementReady(j!, view()), { timeoutTicks: 10 });
            const o = salePlacement(j, view());
            if (!o) throw Error('sale dispatch unknown; no second sell authorized');
            j.offerId = o.id;
            j.phase = 'open';
            save();
        }
        if (j.phase === 'open' && options.leaveOpen && !cancel && !unsafe() && Date.now() < r.deadline) {
            const v = view();
            const o = v.offers.find(offer => offer.id === j!.offerId);
            if (!o || v.items !== j.itemsBefore - r.quantity || v.coins !== j.coinsBefore) throw Error('resting sale escrow/offer changed');
            j.progress = saleProgress(j, o);
            save();
            if (o.state === 'open') {
                return { ok: true, resting: true, settled: false, banked: false, journal: j, offer: { id: o.id, ...saleResting(j, v) }, replay: false };
            }
        }
        if (j.phase === 'open' && !cancel && !unsafe() && Date.now() < r.deadline && waitTicks) {
            await waitUntil(s, () => unsafe() || Date.now() >= r.deadline || view().offers.find(o => o.id === j!.offerId)?.state !== 'open', {
                timeoutTicks: waitTicks,
            });
        }
        if (j.phase === 'open' || j.phase === 'cancelling') {
            let v = view();
            let o = v.offers.find(offer => offer.id === j!.offerId);
            if (!o || v.items !== j.itemsBefore - r.quantity || v.coins !== j.coinsBefore) throw Error('sale escrow/offer changed');
            j.progress = saleProgress(j, o);
            save();
            if (o.state === 'open') {
                if (fatal()) throw Error('sale original life/HP unavailable for cancellation');
                j.phase = 'cancelling';
                save();
                try {
                    await s.bot.cancelGEOffer(o.id, 15000);
                } catch { /* A lost response can still have cancelled. */ }
                await waitUntil(s, () => view().offers.find(offer => offer.id === j!.offerId)?.state !== 'open', { timeoutTicks: 10 });
                v = view();
                o = v.offers.find(offer => offer.id === j!.offerId);
                if (!o) throw Error('cancelled sale absent');
            }
            j.progress = saleProgress(j, o);
            j.claim = saleClaim(j, o);
            j.phase = 'collecting';
            save();
        }
        if (j.phase === 'collecting') {
            if (fatal()) throw Error('sale original life/HP unavailable for collection');
            const v = view();
            if (!saleCollected(j, v)) {
                const o = v.offers.find(offer => offer.id === j!.offerId);
                if (!o || JSON.stringify(saleClaim(j, o)) !== JSON.stringify(j.claim)
                    || v.coins !== j.coinsBefore || v.items !== j.itemsBefore - r.quantity) {
                    throw Error('sale collection outcome unknown');
                }
                try {
                    await collectClaim((id, notes) => s.bot.collectGEOffer(id, notes, 15000), j.offerId!, Boolean(options.collectNotes || (j.claim?.items ?? 0) > 0));
                } catch { /* Verify exact pack credit. */ }
                if (!await waitUntil(s, () => saleCollected(j!, view()), { timeoutTicks: 10 })) throw Error('sale collection not reconciled');
            }
            j.phase = 'settled';
            delete j.failure;
            save();
        }
        return { ok: j.phase === 'settled', journal: j, replay: false };
    } catch (e) {
        if (j) {
            j.failure = String(e);
            save();
        }
        return { ok: false, journal: j, error: String(e) };
    }
}

export interface BankSaleDeps {
    walk?: (to: { x: number; z: number; level: number }) => Promise<boolean>;
    deposit?: (item: { id: number; name: string; count: number; slot: number }, amount?: number) => Promise<number>;
    catalogue?: readonly { id: number; name: string }[];
    bankCoins?: boolean;
}

export async function runBankBidSale(
    s: Session,
    r: SaleRequest,
    path: string,
    stop: () => boolean,
    waitTicks = 40,
    cancel = false,
    deps: BankSaleDeps = {},
) {
    validateSale(r);
    const matchItem = saleItemMatcher(r.item, deps.catalogue);
    const bankCoins = deps.bankCoins !== false;
    const walk = deps.walk ?? (async (to: { x: number; z: number; level: number }) => (await walkTargetPersist(s, to)).ok);
    const deposit = deps.deposit ?? (async (item: { id: number; name: string; count: number; slot: number }, amount = -1) => {
        if (amount >= 0 && amount < item.count) {
            const before = held(item.id);
            const want = before - amount;
            const invItem = s.sdk.getInventory().find(i => i.id === item.id && i.slot === item.slot);
            if (!invItem || !(await s.bot.depositItem(invItem, amount)).success || !await waitUntil(s, () => held(item.id) <= want, { timeoutTicks: 10 })) {
                throw Error(`partial bank deposit failed ${item.id}`);
            }
            return amount;
        }
        return depositObserved(s, item);
    });
    const held = (id: number) => s.sdk.getInventory().filter(i => (id === r.item ? matchItem(i) : i.id === id)).reduce((n, i) => n + i.count, 0);
    const openFreshBank = async () => {
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success
            || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 12 })) {
            throw Error('fresh sale bank unavailable');
        }
        const obs = s.bankObservation?.();
        if (!obs) throw Error('fresh sale bank observation missing');
        return obs;
    };
    const ensureAt = async (tile: { x: number; z: number; level: number }, tol = 3) => {
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== tile.level || Math.max(Math.abs(p.worldX - tile.x), Math.abs(p.worldZ - tile.z)) > tol) {
            if (!await walk(tile)) throw Error(`sale travel to ${tile.x},${tile.z} failed`);
        }
    };
    const old: SaleJournal | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (old && (old.version !== 1 || JSON.stringify(old.request) !== JSON.stringify(r)
        || !['prepared', 'attempted', 'open', 'cancelling', 'collecting', 'settled'].includes(old.phase))) {
        throw Error('sale journal identity/config changed');
    }
    if (old?.phase === 'settled' && old.banked === true) return { ok: true, journal: old, replay: true, banked: true };
    if (!old || old.phase === 'prepared') {
        if (stop()) return { ok: false, journal: old, error: 'sale stopped before bank withdrawal', banked: false };
        await ensureAt(VARROCK_BANK);
        const obs = await openFreshBank();
        const bankItems = obs.items;
        const bankRow = bankItems.find(i => i.id === r.item);
        const bankCount = bankRow?.count ?? 0;
        const packCount = held(r.item);
        if (packCount + bankCount < r.quantity + r.reserveItems) {
            await s.bot.closeBank();
            return { ok: false, journal: old, error: 'bank sale surplus short', banked: false };
        }
        if (packCount > r.quantity || (packCount > 0 && packCount < r.quantity && s.sdk.getInventory().some(i => i.id === r.item))) {
            for (const row of [...s.sdk.getInventory().filter(matchItem)]) await deposit(row);
        }
        const need = Math.max(0, r.quantity - held(r.item));
        if (need > 0) {
            const sdkRow = s.sdk.getState()?.bank?.items.find(i => i.id === r.item);
            const refreshedCount = sdkRow?.count ?? s.bankObservation?.()?.items.find(i => i.id === r.item)?.count ?? 0;
            if (refreshedCount - need < r.reserveItems) {
                await s.bot.closeBank();
                return { ok: false, journal: old, error: 'bank sale reserve short', banked: false };
            }
            if (s.sdk.getInventory().length >= 28 && !s.sdk.getInventory().some(matchItem)) {
                await s.bot.closeBank();
                return { ok: false, journal: old, error: 'pack full: need 1 slot for bank GE sale', banked: false };
            }
            const w = await s.bot.withdrawItem(sdkRow ?? r.item, need, { asNote: true });
            if (!w.success || !await waitUntil(s, () => held(r.item) === r.quantity, { timeoutTicks: 10 })) {
                await s.bot.closeBank();
                return { ok: false, journal: old, error: `bank noted withdrawal incomplete: ${w.message}`, banked: false };
            }
        }
        await s.bot.closeBank();
    }
    const pMarket = s.sdk.getState()?.player;
    if (!pMarket || !marketTileSafe({ x: pMarket.worldX, z: pMarket.worldZ, level: pMarket.level })) await ensureAt(GE_SPOT, 2);
    const res = await runOwnedSale(s, r, path, stop, waitTicks, cancel, { collectNotes: true, catalogue: deps.catalogue, reserveInBank: true });
    if (!res.ok || !res.journal) return { ...res, banked: false };
    if (!res.journal.banked) {
        await ensureAt(VARROCK_BANK);
        await openFreshBank();
        for (const row of [...s.sdk.getInventory().filter(matchItem)]) await deposit(row);
        const coinBack = bankCoins ? Math.min(held(995), res.journal.claim?.coins ?? 0) : 0;
        if (coinBack > 0) {
            const coinRow = s.sdk.getInventory().find(i => i.id === 995);
            if (coinRow) await deposit(coinRow, coinBack);
        }
        if (held(r.item) > 0) {
            await s.bot.closeBank();
            return { ok: false, journal: res.journal, error: 'bank sale unsold return not banked', banked: false };
        }
        await s.bot.closeBank();
        res.journal.banked = true;
        writeFileSync(path + '.tmp', JSON.stringify(res.journal, null, 2));
        renameSync(path + '.tmp', path);
    }
    return { ...res, banked: true };
}

export function saleStopRequested(actor: string, exists: (path: string) => boolean = existsSync) {
    return exists(resolve('.practice', 'stop-' + actor)) || exists(resolve('.practice', 'stop-all'));
}
