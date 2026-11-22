import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accountOf, getWorld } from '../../../core/src/bot';
import { equipmentObserved } from '../../../core/src/container-observation';
import type { Session } from '../../../core/src/inprocess';
import { orderRefusal } from '../../../core/src/order-refusal';
import { waitUntil } from '../../../core/src/ticks';
import { expandPath, goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { ROUTE_BUDGET_MS } from '../../../core/src/world';
import type { GEActionResult, GEOffer } from '../../../../vendor/rs-sdk/sdk/ge-types';
import { marketProgress } from './market-progress';
import type { ItemOrder, ItemRequest, OrderView, RescueReceipt } from './types';
import { ferryWalk, walkTargetPersist } from './walk';

export { orderRefusal };

export const GE_VARROCK_BANK = { x: 3185, z: 3436 };
export const GE_EXCHANGE_SPOT = { x: 3181, z: 3443 };
export const HEAL_FOOD = [333, 329, 361, 379, 373, 385] as const;
export const NORTH_ENTRY = { x: 3165, z: 3487 };
export const NORTH_APPROACH = [{ x: 3198, z: 3508 }, { x: 3241, z: 3507 }, { x: 3244, z: 3503 }, { ...GE_VARROCK_BANK, tol: 1 }];
const BROWN_BEAR = { x: 3230, z: 3500 };
export const BATTLEFIELD = [2480, 3200, 2600, 3290] as const;
export const ARDOUGNE_NORTH = { x: 2619, z: 3332, level: 0 };

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export const productionMode = (profile: string) =>
    profile === 'owned-talismans' ? 'talismans' : profile === 'owned-craft' ? 'craft' : undefined;

export const orderQuantity = (r: ItemRequest) => r.quantity ?? 1;
export const orderEscrow = (r: ItemRequest) => orderQuantity(r) * r.limit;

export function priorRounds(j: ItemOrder) {
    let acquired = 0;
    let spent = 0;
    const ids = new Set<number>();
    const total = orderQuantity(j.request);
    if ((j.rounds && !Array.isArray(j.rounds)) || (j.rounds?.length ?? 0) > 16) throw Error('invalid settled rounds');
    for (const r of j.rounds ?? []) {
        const gross = r.quantity * j.request.limit - r.refund;
        if (!Number.isSafeInteger(r.offerId) || r.offerId <= 0 || ids.has(r.offerId) || r.quantity !== total - acquired
            || !Number.isSafeInteger(r.acquired) || r.acquired < 0 || r.acquired >= r.quantity
            || !Number.isSafeInteger(r.refund) || r.refund < 0 || r.refund > r.quantity * j.request.limit
            || (r.acquired === 0 ? gross !== 0 : gross < r.acquired || gross > r.acquired * j.request.limit)) {
            throw Error('invalid settled round');
        }
        if (r.progress) {
            marketProgress(null, r.progress);
            if (r.progress.actor.toLowerCase() !== j.request.actor.toLowerCase() || r.progress.server !== j.request.server
                || r.progress.offerId !== r.offerId || r.progress.itemId !== j.request.item || r.progress.side !== 'buy'
                || r.progress.quantity !== r.quantity || r.progress.limit !== j.request.limit
                || r.progress.filled !== r.acquired || r.progress.gross !== gross || r.progress.tax !== 0) {
                throw Error('invalid settled round progress');
            }
        }
        ids.add(r.offerId);
        acquired += r.acquired;
        spent += gross;
    }
    if (j.offerId !== undefined && ids.has(j.offerId)) throw Error('reused settled offer ID');
    return { acquired, spent, quantity: total - acquired, escrow: (total - acquired) * j.request.limit };
}

export function orderAccounting(journal?: ItemOrder) {
    if (!journal) return { acquired: 0, refund: 0, spent: 0, escrow: 0, maximumExposure: 0, outcomeUnresolved: false };
    const total = orderEscrow(journal.request);
    let prior: { acquired: number; spent: number; quantity: number; escrow: number };
    try {
        prior = priorRounds(journal);
    } catch {
        return { acquired: 0, refund: 0, spent: 0, escrow: null, maximumExposure: total, outcomeUnresolved: true };
    }
    let valid = true;
    if (journal.progress) {
        try {
            marketProgress(null, journal.progress);
            const p = journal.progress;
            valid = p.actor.toLowerCase() === journal.request.actor.toLowerCase() && p.server === journal.request.server
                && p.offerId === journal.offerId && p.itemId === journal.request.item && p.side === 'buy'
                && p.quantity === prior.quantity && p.limit === journal.request.limit;
        } catch {
            valid = false;
        }
    }
    const settled = journal.phase === 'settled';
    const a = journal.acquired!;
    const refund = journal.refund!;
    const spent = total - refund;
    const active = a - prior.acquired;
    const gross = spent - prior.spent;
    if (settled) {
        valid = valid && Number.isSafeInteger(a) && active >= 0 && active <= prior.quantity
            && Number.isSafeInteger(refund) && refund >= 0 && refund <= total
            && (active === 0 ? gross === 0 : gross >= active && gross <= active * journal.request.limit)
            && (!journal.progress || (journal.progress.filled === active && journal.progress.gross === gross && journal.progress.tax === 0));
    }
    const unresolved = !valid || ['entry', 'placing', 'cancelling', 'collecting'].includes(journal.phase);
    const knownSpent = settled && valid ? spent : prior.spent + (journal.phase === 'open' && valid ? (journal.progress?.gross ?? 0) : 0);
    return {
        acquired: settled && valid ? a : prior.acquired,
        refund: settled && valid ? refund : 0,
        spent: knownSpent,
        escrow: unresolved ? null : settled ? 0 : prior.escrow - (journal.progress?.gross ?? 0),
        maximumExposure: settled && valid ? 0 : prior.escrow,
        outcomeUnresolved: unresolved,
    };
}

export function earthShopFallback(request: ItemRequest, journal: ItemOrder | undefined, cap: number, spent = 0, profile = 'aubury') {
    validateRequest(request);
    const q = orderQuantity(request);
    const a = orderAccounting(journal);
    const production = productionMode(profile);
    const refill = profile.endsWith('-refill');
    const shop = refill ? profile.slice(0, -7) : profile;
    if (!journal || journal.phase !== 'settled' || JSON.stringify(journal.request) !== JSON.stringify(request)
        || request.item !== 557 || request.rescueMode || request.expectedOwned === undefined || journal.itemsBefore !== request.expectedOwned
        || a.outcomeUnresolved || a.escrow !== 0 || a.acquired !== 0 || a.spent !== 0 || a.refund !== orderEscrow(request)
        || (!production && !['aubury', 'betty'].includes(shop))
        || !Number.isSafeInteger(cap) || cap < 1 || cap > (production ? 20000 : refill ? 16000 : shop === 'betty' ? 3000 : 1600)
        || !Number.isSafeInteger(spent) || spent < 0 || spent >= orderEscrow(request)) {
        throw Error('earth shop fallback requires the matching fully refunded zero-fill intent and bounded acquisition cap');
    }
    return {
        entry: production ? 'scripts/earth-production.ts' : 'scripts/aio-market.ts',
        mode: production ? 'earth-production' : refill ? 'earth-shop' : 'shop-buy',
        args: production ? [production, String(cap)] : [refill ? 'earth-shop' : 'shop-buy', shop, String(cap), '2000'],
        env: {
            ITEMS: 'earth rune',
            STOP_AT_TARGET: '1',
            STOCK_TARGET: String(request.expectedOwned + q),
            MAX_ITEMS: String(q),
            MAX_SPEND: String(orderEscrow(request) - spent),
            COIN_RESERVE: String(request.reserve),
            FLOAT: String(request.reserve + orderEscrow(request) - spent),
            NO_BUY_TICKS: '25',
            BANK_PACK: '1',
        },
    };
}

export function shopFallbackSpent(state: any, request: ItemRequest) {
    if (state === undefined) return 0;
    if (state?.phase !== 'settled' || JSON.stringify(state.request) !== JSON.stringify(request)
        || !Number.isSafeInteger(state.spent) || state.spent < 0 || state.spent > orderEscrow(request)) {
        throw Error('shop fallback spend is unresolved; reconcile retained intent before retry');
    }
    return state.spent as number;
}

export function roundBaseline(j: ItemOrder) {
    const p = priorRounds(j);
    return { ...p, coins: j.coinsBefore - p.spent, items: j.itemsBefore + p.acquired };
}

export function claimSettlement(j: ItemOrder, c: { items: number; coins: number }) {
    const p = priorRounds(j);
    return { acquired: p.acquired + c.items, refund: orderEscrow(j.request) - p.spent - p.escrow + c.coins };
}

export function validateRequest(r: ItemRequest) {
    if (r.rescueMode !== undefined && r.rescueMode !== 'npc-respawn-once') throw Error('unsupported RESCUE_MODE');
    if (!/^[a-z0-9]{1,12}$/i.test(r.actor) || !r.server || !/^[a-z0-9_-]{1,64}$/i.test(r.goal)
        || ![r.item, r.limit].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647)
        || (r.quantity !== undefined && !(Number.isSafeInteger(r.quantity) && r.quantity > 0))
        || (r.expectedOwned !== undefined && !(Number.isSafeInteger(r.expectedOwned) && r.expectedOwned >= 0 && r.expectedOwned <= 2147483647))
        || orderEscrow(r) > 2147483647 || !Number.isSafeInteger(r.reserve) || r.reserve < 0
        || ![r.createdAt, r.reviewAt, r.deadline].every(n => Number.isSafeInteger(n) && n > 0)
        || r.reviewAt < r.createdAt || r.deadline <= r.reviewAt) {
        throw Error('invalid item order request');
    }
}

export function orderItemMatcher(item: number, catalogue: readonly { id: number; name: string }[]) {
    const name = catalogue.find(i => i.id === item)?.name.toLowerCase();
    const known = new Set(catalogue.map(i => i.id));
    return (i: { id: number; name?: string }) => i.id === item || (!!name && i.name?.toLowerCase() === name && !known.has(i.id));
}

export function orderPaths(server: string, actor: string, goal: string) {
    const base = resolve(REPO_ROOT, '.practice/market-orders', createHash('sha256').update(server).digest('hex').slice(0, 12));
    return { base, lock: base + '/' + actor.toLowerCase() + '.lock', journal: base + '/' + actor.toLowerCase() + '-' + goal + '.json' };
}

function identity(j: ItemOrder, v: OrderView) {
    if (j.request.actor.toLowerCase() !== v.actor.toLowerCase() || j.request.server !== v.server) throw Error('order identity mismatch');
}

export const orderMatchesOffer = (j: ItemOrder, o: GEOffer) =>
    o.item === j.request.item && o.side === 'buy' && o.quantity === priorRounds(j).quantity && o.price === j.request.limit;

export function observeOrderProgress(j: ItemOrder, o: GEOffer, at: number) {
    if (j.offerId !== o.id || !orderMatchesOffer(j, o)) throw Error('private progress order identity mismatch');
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
        at,
    });
}

export function terminalOrderClaim(j: ItemOrder, o: GEOffer) {
    observeOrderProgress(j, o, Math.max(j.progress?.at ?? 1, j.at));
    if (!['completed', 'cancelled'].includes(o.state) || o.items !== o.filled || o.coins !== priorRounds(j).escrow - o.gross
        || !Number.isSafeInteger(o.coins) || o.coins < 0 || o.remaining !== 0
        || (o.state === 'completed' && o.filled !== priorRounds(j).quantity)) {
        throw Error('terminal order fill/refund does not conserve escrow');
    }
    return { items: o.items, coins: o.coins };
}

export function reconcilePlacement(j: ItemOrder, v: OrderView): GEOffer | undefined {
    identity(j, v);
    const found = v.offers.filter(o => !j.previousIds.includes(o.id) && orderMatchesOffer(j, o));
    if (found.length > 1) throw Error('ambiguous new GE offers');
    if (!found.length) return;
    if (v.coins !== roundBaseline(j).coins - priorRounds(j).escrow) throw Error('owned escrow debit mismatch');
    if (v.items !== roundBaseline(j).items) throw Error('owned item baseline changed');
    return found[0];
}

export function placementRetrySafe(j: ItemOrder, v: OrderView): boolean {
    identity(j, v);
    const p = roundBaseline(j);
    return j.phase === 'placing' && j.submission === 'prepared' && j.offerId === undefined
        && v.coins === p.coins && v.items === p.items && v.offers.length === j.previousIds.length
        && v.offers.every(o => j.previousIds.includes(o.id));
}

export function collectionApplied(j: ItemOrder, v: OrderView): boolean {
    identity(j, v);
    const c = j.claim;
    return j.phase === 'collecting' && j.offerId !== undefined && !!c
        && c.coinsBefore === roundBaseline(j).coins - priorRounds(j).escrow && c.itemsBefore === roundBaseline(j).items
        && !orderAccounting({ ...j, phase: 'settled', ...claimSettlement(j, c) }).outcomeUnresolved
        && !v.offers.some(o => o.id === j.offerId) && v.coins === c.coinsBefore + c.coins && v.items === c.itemsBefore + c.items;
}

export function collectionRetrySafe(j: ItemOrder, v: OrderView): boolean {
    identity(j, v);
    const c = j.claim;
    const o = v.offers.find(offer => offer.id === j.offerId);
    if (j.phase !== 'collecting' || !c || !o || v.coins !== c.coinsBefore || v.items !== c.itemsBefore
        || c.coinsBefore !== roundBaseline(j).coins - priorRounds(j).escrow || c.itemsBefore !== roundBaseline(j).items) {
        return false;
    }
    try {
        const claim = terminalOrderClaim(j, o);
        return claim.coins === c.coins && claim.items === c.items;
    } catch {
        return false;
    }
}

export async function collectClaim(collect: (offerId: number, notes: boolean) => Promise<GEActionResult>, offerId: number, notes: boolean) {
    const result = await collect(offerId, notes);
    return !result.success && notes && result.reason === 'no_control' ? collect(offerId, false) : result;
}

export const marketTileSafe = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && p.x >= 3180 && p.x <= 3188 && p.z >= 3433 && p.z <= 3447;

export const northEntryTile = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && Math.max(Math.abs(p.x - NORTH_ENTRY.x), Math.abs(p.z - NORTH_ENTRY.z)) <= 3;

export const northApproachTile = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && p.x >= 3160 && p.x <= 3248 && p.z >= 3428 && p.z <= 3512
    && Math.max(Math.abs(p.x - BROWN_BEAR.x), Math.abs(p.z - BROWN_BEAR.z)) >= 6;

async function northApproach(s: Session, signal: AbortSignal) {
    const deps = await sessionWalker(s);
    const plan = deps.plan;
    deps.plan = (level, from, goal) => {
        const corners = plan(level, from, goal);
        if (!corners.length || [from, ...expandPath(from, corners)].some(p => !northApproachTile({ ...p, level }))) {
            throw Error('north approach path outside known corridor');
        }
        return corners;
    };
    return walkPath(deps, NORTH_APPROACH, { signal, maxTicks: 400 });
}

export function marketHealthFailure(p: { worldX: number; worldZ: number; level: number } | null | undefined, hp: number) {
    const where = p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown';
    if (!p || !Number.isFinite(hp) || hp <= 0) return `market entry: position=${where} currentHP=${hp}; living actor required`;
    if (hp <= 6 && (p.level !== 0 || Math.max(Math.abs(p.worldX - GE_VARROCK_BANK.x), Math.abs(p.worldZ - GE_VARROCK_BANK.z)) > 3)) {
        return `market health preparation: position=${where} currentHP=${hp}; requires bank approach within3 before healing`;
    }
    return null;
}

export function marketEntryFailure(p: { worldX: number; worldZ: number; level: number } | null | undefined, hp: number) {
    const health = marketHealthFailure(p, hp);
    if (health) return health;
    if (!p || !marketTileSafe({ x: p.worldX, z: p.worldZ, level: p.level })) {
        return `unsupported market entry: position=${p?.worldX},${p?.worldZ},${p?.level} currentHP=${hp}; requires observed Varrock West/GE arrival`;
    }
    return null;
}

export function marketEntryTrace(s: Session, stage: string, detail: Record<string, unknown> = {}) {
    const p = s.sdk.getState()?.player;
    console.log('GE_MARKET_ENTRY ' + JSON.stringify({
        stage,
        at: Date.now(),
        tick: s.tick(),
        position: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
        hp: s.sdk.getSkill('Hitpoints')?.level ?? null,
        stateAge: s.sdk.getStateAge(),
        ...detail,
    }));
}

export const onBattlefield = (p: { x: number; z: number; level: number }) =>
    p.level === 0 && p.x >= BATTLEFIELD[0] && p.z >= BATTLEFIELD[1] && p.x <= BATTLEFIELD[2] && p.z <= BATTLEFIELD[3];

export async function leaveBattlefield(
    s: Session,
    stop: () => boolean,
    walk: (to: { x: number; z: number; level: number }) => Promise<{ ok: boolean; detail?: string }> = to => walkTargetPersist(s, to),
) {
    const at = () => s.sdk.getState()?.player;
    const p = at();
    if (!p || !onBattlefield({ x: p.worldX, z: p.worldZ, level: p.level })) return false;
    if ((s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 10) {
        throw Error(`market entry: on the battlefield at ${p.worldX},${p.worldZ} with 10 HP or less; the trooper trainer's retreat eats first`);
    }
    const retaliate = async (on: boolean) => {
        const state = () => s.sdk.getState() as { autoRetaliateEnabled?: boolean } | null;
        if (state()?.autoRetaliateEnabled === on || state()?.autoRetaliateEnabled === undefined) return false;
        await s.direct({ type: 'clickComponent', componentId: on ? 150 : 151, reason: `market entry auto-retaliate ${on ? 'ON' : 'OFF'}` });
        return await waitUntil(s, () => state()?.autoRetaliateEnabled === on, { timeoutTicks: 5 });
    };
    const start = s.tick();
    const off = await retaliate(false);
    marketEntryTrace(s, 'battlefield-leave', { autoRetaliateOff: off });
    try {
        const result = stop() ? { ok: false, detail: 'stop requested' } : await walk(ARDOUGNE_NORTH);
        const q = at();
        const near = !!q && q.level === 0 && Math.max(Math.abs(q.worldX - ARDOUGNE_NORTH.x), Math.abs(q.worldZ - ARDOUGNE_NORTH.z)) <= 6;
        marketEntryTrace(s, 'battlefield-left', { ok: result.ok && near, ticks: s.tick() - start, detail: result.detail });
        if (!result.ok || !near) throw Error(`market entry: walk from the battlefield to the Ardougne north bank failed: ${result.detail ?? 'not at the bank'}`);
        return true;
    } finally {
        if (off) await retaliate(true);
    }
}

export const marketLeg = <T>(walk: (tile: { x: number; z: number; level: number }, planBudgetMs?: number) => Promise<T>) =>
    (tile: { x: number; z: number; level: number }, planBudgetMs?: number) =>
        walk(tile, tile.level === 0 && tile.x === GE_VARROCK_BANK.x && tile.z === GE_VARROCK_BANK.z ? ROUTE_BUDGET_MS : planBudgetMs);

export async function prepareMarketEntry(
    s: Session,
    stop: () => boolean,
    travel: (signal: AbortSignal) => Promise<{ ok: boolean; ticks: number; detail?: string }> = async signal => {
        const at = s.sdk.getState()?.player;
        if (at && northEntryTile({ x: at.worldX, z: at.worldZ, level: at.level })) {
            marketEntryTrace(s, 'north-approach', { waypoints: NORTH_APPROACH });
            return northApproach(s, signal);
        }
        marketEntryTrace(s, 'world-start');
        const loadingAt = Date.now();
        const world = await getWorld();
        marketEntryTrace(s, 'world-ready', { elapsedMs: Date.now() - loadingAt });
        signal.throwIfAborted();
        const observedWorld = {
            ...world,
            route: (...args: Parameters<typeof world.route>) => {
                const planningAt = Date.now();
                marketEntryTrace(s, 'route-start', { from: args[0], to: args[1] });
                const result = world.route(...args);
                marketEntryTrace(s, 'route-returned', {
                    elapsedMs: Date.now() - planningAt,
                    ok: result.ok,
                    ...(result.ok ? { legs: result.legs.length, cost: result.cost } : { reason: result.reason }),
                });
                return result;
            },
        };
        const account = accountOf(s);
        marketEntryTrace(s, 'go-to-start');
        return ferryWalk(
            s,
            { ...GE_VARROCK_BANK, level: 0 },
            marketLeg((tile, planBudgetMs) => goTo(s, observedWorld, tile, account, { signal, maxRetriesPerLeg: 1, legTimeoutTicks: 1200, planBudgetMs })),
        );
    },
) {
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const initial = s.sdk.getState()?.player;
    const p0 = initial ? { ...initial } : undefined;
    const hp0 = hp();
    const health = marketHealthFailure(p0, hp0);
    if (health || p0?.isDead) throw Error(health ?? 'market entry: living actor required');
    if (!p0) throw Error('market position unknown');
    if (marketTileSafe({ x: p0.worldX, z: p0.worldZ, level: p0.level })) return;
    const start = s.tick();
    const ac = new AbortController();
    let ended = false;
    let lastTrace = start;
    const guard = () => {
        const p = s.sdk.getState()?.player;
        if (ended || stop() || s.tick() - start >= 1200 || !p || hp() < hp0 || !Number.isFinite(hp()) || hp() <= 0 || p.isDead
            || p.lifeId !== p0.lifeId || (p.respawnCount ?? 0) > (p0.respawnCount ?? 0)) {
            if (!ac.signal.aborted) marketEntryTrace(s, 'travel-abort', { ended, elapsedTicks: s.tick() - start });
            ac.abort('market trip health/stop/tick budget');
        }
        if (!ac.signal.aborted && s.tick() - lastTrace >= 100) {
            lastTrace = s.tick();
            marketEntryTrace(s, 'travel-pending', { elapsedTicks: s.tick() - start });
        }
    };
    const off = s.onTick(guard);
    void s.ended.then(() => {
        ended = true;
        guard();
    });
    try {
        guard();
        ac.signal.throwIfAborted();
        marketEntryTrace(s, 'travel-start');
        const result = await travel(ac.signal);
        marketEntryTrace(s, 'travel-returned', { ok: result.ok, ticks: result.ticks, detail: result.detail });
        guard();
        const p = s.sdk.getState()?.player;
        const entry = marketEntryFailure(p, hp());
        if (!result.ok || ac.signal.aborted || entry || s.sdk.getStateAge() > 5000) throw Error(result.detail ?? entry ?? 'bank arrival unproved');
    } catch (error) {
        marketEntryTrace(s, 'travel-error', { error: String(error) });
        const p = s.sdk.getState()?.player;
        throw Error(`market bank travel failed: position=${p ? `${p.worldX},${p.worldZ},${p.level}` : 'unknown'} currentHP=${hp()} ticks=${s.tick() - start}; ${String(error)}`);
    } finally {
        off();
        ac.abort('market trip ended');
    }
}

export function ownedBaseline(r: ItemRequest, held: number) {
    if (r.expectedOwned === undefined) {
        if (held > 0) throw Error('owned item already present;allocate it instead of buying duplicate stock');
    } else if (held !== r.expectedOwned) {
        throw Error(`owned item baseline ${held} differs from EXPECTED_OWNED ${r.expectedOwned}`);
    }
}

export const rescuePocket = (p: { worldX: number; worldZ: number; level: number } | null | undefined) =>
    !!p && p.level === 0 && p.worldX === 2853 && p.worldZ === 3452;

export function rescueKit(s: Session) {
    const st = s.sdk.getState();
    const p = st?.player;
    const pack = s.sdk.getInventory();
    return !!st && s.sdk.getStateAge() <= 5000 && st.isSkulled === false && !!p
        && !!s.client && typeof s.client === 'object' && equipmentObserved(s.client)
        && Array.isArray(st.equipment) && st.equipment.length === 0 && s.sdk.getEquipment().length === 0
        && pack.length === 1 && pack[0]?.id === 590 && pack[0].count === 1;
}

export function bankTotals(rows: readonly { id: number; count: number }[]) {
    const m = new Map<number, number>();
    for (const r of rows) {
        if (!Number.isSafeInteger(r.id) || r.id < 0 || !Number.isSafeInteger(r.count) || r.count <= 0) throw Error('invalid rescue bank snapshot');
        m.set(r.id, (m.get(r.id) ?? 0) + r.count);
    }
    return [...m].sort((a, b) => a[0] - b[0]);
}

export function rescueBank(request: ItemRequest) {
    const snapshot = JSON.parse(readFileSync(resolve(REPO_ROOT, '.practice/status', request.actor + '.json'), 'utf8'));
    if (snapshot.name?.toLowerCase() !== request.actor.toLowerCase() || snapshot.server !== request.server
        || !Number.isSafeInteger(snapshot.bankAt) || snapshot.bankAt <= 0 || snapshot.bankAt > Date.now() || !Array.isArray(snapshot.bank)) {
        throw Error('owned rescue bank snapshot required');
    }
    bankTotals(snapshot.bank);
    return {
        bank: snapshot.bank.map((i: { id: number; count: number }) => ({ id: i.id, count: i.count })),
        bankAt: snapshot.bankAt as number,
    };
}

export type RescueControl = { active: boolean; start: number; lifeId: number; respawnCount: number };

export function expectedRescueStop(s: Session, detail: string, c: RescueControl) {
    const p = s.sdk.getState()?.player;
    return detail === 'died' && c.active && s.tick() - c.start < 240 && !!p && s.sdk.getStateAge() <= 5000
        && p.lifeId >= c.lifeId && p.lifeId <= c.lifeId + 1 && p.respawnCount >= c.respawnCount && p.respawnCount <= c.respawnCount + 1;
}

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
    const now = options.now ?? Date.now();
    const reviewAt = now + (options.reviewMs ?? 60_000);
    const deadline = now + (options.deadlineMs ?? 900_000);
    let spendable = Math.max(0, options.coinsAvailable - options.coinReserve);
    let totalEscrow = 0;
    const funded: ItemRequest[] = [];
    const unfunded: number[] = [];
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

export function loadGeItemCatalogue(): { id: number; name: string }[] {
    return JSON.parse(readFileSync(new URL('../../../../knowledge/items.json', import.meta.url), 'utf8'));
}
