import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BankProfile } from '../../../core/src/bank-trip';
import { settle } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import { inProcessSdkConfig, type Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { gameDialAddress } from '../../../core/src/websocket-proxy';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import { MarketClient } from '../../../../vendor/rs-sdk/sdk/market';
import { runMarketBankProfile } from './bank-runner';
import { runOwnedItem } from './ge-buy';
import { loadGeItemCatalogue, marketEntryFailure, orderAccounting, orderItemMatcher, orderPaths, validateRequest } from './ge-common';
import { runOwnedSale, saleResting, saleStopRequested, validateSale } from './ge-sell';
import { PROFILES, maximumUnitCost } from './shop-buy';
import type {
    BankSellerJournal,
    BankSellerPolicy,
    BuyListEntry,
    BuyListJournal,
    BuyListRequest,
    GEPlanJournal,
    GEPlanRound,
    GEPricePlan,
    GETripJournal,
    GETripRequest,
    ItemOrder,
    ItemRequest,
    Quote,
    SaleJournal,
    SaleRequest,
    ShopToBidConfig,
} from './types';
import { productionStopRequested, walkTargetPersist } from './walk';

type NativeItem = { id: number; name: string; tradeable?: boolean; members?: boolean; cost?: number; debugname?: string; baseId?: number };
type Row = { id: number; count: number };
type Snapshot = { assets: Record<number, number>; bank: Row[]; gear: { id: number; slot: number; count: number }[] };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameSorted = (a: unknown, b: unknown): boolean => {
    const key = (_k: string, v: any) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)))
            : v;
    return JSON.stringify(a, key) === JSON.stringify(b, key);
};
const positive = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
const whole = (v: number, min = 0, max = 2147483647) => Number.isSafeInteger(v) && v >= min && v <= max;

const BUY_LIST_BANK = { x: 3185, z: 3436 };
const nativeItems = (): NativeItem[] => loadGeItemCatalogue() as NativeItem[];

// --- GE Buy List (from scripts/microbot-ge-buy-list.ts) ---

export function percentagePrice(base: number, percent: number) {
    if (!positive(base) || ![5, 10, 50, 99].includes(percent)) throw Error('unsupported native buy percentage/base');
    let price = base;
    if (percent === 99) return Math.min(2147483647, base + Math.max(1, Number((BigInt(base) * 99n) / 100n)));
    for (let i = 0; i < percent / 5; i++) price = Math.min(2147483647, price + Math.max(1, Math.floor(price / 20)));
    return price;
}

export function parseBuyList(text: string, catalogue: readonly NativeItem[] = nativeItems()) {
    if (typeof text !== 'string' || !text.trim()) throw Error('explicit finite buy list required');
    const out = new Map<number, { item: number; quantity: number }>();
    for (const raw of text.split(',')) {
        const m = raw.trim().match(/^([^\[\]]+?)(?:\[(\d+)\])?$/);
        if (!m) throw Error('invalid Name[quantity] buy list');
        const name = m[1]!.trim().toLowerCase();
        const matches = catalogue.filter(i => i.name.toLowerCase() === name && i.tradeable === true);
        if (matches.length !== 1 || matches[0]!.id === 995) throw Error('buy name must resolve one exact native tradeable item: ' + name);
        const quantity = Number(m[2] ?? 1);
        if (!positive(quantity)) throw Error('invalid finite buy quantity');
        out.set(matches[0]!.id, { item: matches[0]!.id, quantity });
    }
    if (out.size > 32) throw Error('buy list exceeds 32 distinct native items');
    return [...out.values()];
}

export function validateBuyList(r: BuyListRequest, catalogue: readonly NativeItem[] = nativeItems()) {
    if (!r || !Array.isArray(r.entries) || !r.entries.length || r.entries.length > 32
        || new Set(r.entries.map(e => e.item)).size !== r.entries.length || !positive(r.budget)
        || !Number.isSafeInteger(r.reserve) || r.reserve < 0 || !Number.isSafeInteger(r.cap) || r.cap < 1000 || r.cap > 100000
        || !Number.isSafeInteger(r.fillWait) || r.fillWait < 0 || r.fillWait > 200
        || !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.deadline) || r.createdAt <= 0 || r.deadline <= r.createdAt) {
        throw Error('invalid finite buy-list budget');
    }
    let exposure = 0;
    for (const e of r.entries) {
        if (!positive(e.quantity) || !positive(e.unitCap) || percentagePrice(e.basePrice, e.percent) > e.unitCap
            || !catalogue.some(i => i.id === e.item && i.tradeable === true) || e.item === 995) {
            throw Error('native item/percentage exceeds explicit unit cap');
        }
        exposure += e.quantity * percentagePrice(e.basePrice, e.percent);
    }
    if (!Number.isSafeInteger(exposure) || exposure > r.budget || r.budget + r.reserve > 2147483647) {
        throw Error('buy list exceeds explicit owned budget');
    }
    validateRequest({
        actor: r.actor,
        server: r.server,
        goal: r.goal,
        item: r.entries[0]!.item,
        quantity: 1,
        limit: 1,
        reserve: r.reserve,
        createdAt: r.createdAt,
        reviewAt: r.createdAt,
        deadline: r.deadline,
    });
    if (r.goal.length > 52) throw Error('buy-list key must leave room for child identity');
}

export function buyListPaths(r: BuyListRequest) {
    const p = orderPaths(r.server, r.actor, r.goal);
    return { lock: p.lock, parent: p.journal + '.buy-list', children: r.entries.map((_e, i) => orderPaths(r.server, r.actor, `${r.goal}-buy-${i}`).journal) };
}

export function buyListStop(actor: string, stopped = false, exists: (p: string) => boolean = existsSync) {
    return stopped || [`.practice/stop-${actor}`, '.practice/stop-all', '.practice/stop-microbot-ge-buy-list'].some(exists);
}

export type BuyListDeps = {
    buyer?: typeof runOwnedItem;
    catalogue?: readonly NativeItem[];
    paths?: ReturnType<typeof buyListPaths>;
    bankAudit?: (s: Session) => Promise<Record<number, number>>;
};

export async function runBuyList(s: Session, r: BuyListRequest, requestStop: () => boolean = () => false, deps: BuyListDeps = {}) {
    const catalogue = deps.catalogue ?? nativeItems();
    validateBuyList(r, catalogue);
    if (s.name.toLowerCase() !== r.actor.toLowerCase()) throw Error('buy-list actor mismatch');
    const paths = deps.paths ?? buyListPaths(r);
    const buyer = deps.buyer ?? runOwnedItem;
    let parent: BuyListJournal | undefined = existsSync(paths.parent) ? JSON.parse(readFileSync(paths.parent, 'utf8')) : undefined;
    const load = (i: number) => {
        if (!existsSync(paths.children[i]!)) return;
        const j = JSON.parse(readFileSync(paths.children[i]!, 'utf8')) as ItemOrder;
        if (!parent || j.version !== 1 || !same(j.request, parent.children[i])
            || !['entry', 'placing', 'open', 'cancelling', 'collecting', 'settled'].includes(j.phase)) {
            throw Error('buy child missing parent/corrupt identity');
        }
        return j;
    };
    if (!parent && paths.children.some(existsSync)) throw Error('buy child exists without parent intent');
    if (parent && (parent.version !== 1 || !same(parent.request, r) || !['prepared', 'running', 'banked'].includes(parent.phase)
        || !parent.initial || Object.entries(parent.initial).some(([id, n]) => !/^\d+$/.test(id) || !Number.isSafeInteger(n) || n < 0)
        || !Array.isArray(parent.children) || parent.children.length !== r.entries.length
        || !Array.isArray(parent.outcomes) || parent.outcomes.length !== r.entries.length || typeof parent.aborted !== 'boolean')) {
        throw Error('buy-list parent corrupt/config changed');
    }
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = s.tick();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return ended || !p || p.isDead || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp || hp <= 0 || s.tick() - start >= r.cap;
    };
    const stop = () => fatal() || requestStop() || Date.now() >= r.deadline || s.tick() - start >= r.cap - 700;
    const gear = () => s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
    const canonical = (rows: readonly { id: number; name?: string; count: number }[]) => {
        const result: Record<number, number> = {};
        for (const row of rows) {
            const e = r.entries.find(ent => orderItemMatcher(ent.item, catalogue)(row));
            const id = e?.item ?? row.id;
            result[id] = (result[id] ?? 0) + row.count;
        }
        return result;
    };
    const outputsBanked = () =>
        [...s.sdk.getInventory(), ...s.sdk.getEquipment()].every(i => i.id !== 995 && !r.entries.some(e => orderItemMatcher(e.item, catalogue)(i)));
    const audit = deps.bankAudit ?? (async () => {
        if (fatal() || s.tick() - start >= r.cap - 30) throw Error('buy-list original life/audit budget unavailable');
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== 0 || p.worldX < 3180 || p.worldX > 3188 || p.worldZ < 3433 || p.worldZ > 3447) {
            throw Error('buy-list starts/returns in known Varrock bank/GE rectangle');
        }
        if (Math.max(Math.abs(p.worldX - BUY_LIST_BANK.x), Math.abs(p.worldZ - BUY_LIST_BANK.z)) > 1
            && !(await walkPath(await sessionWalker(s), [{ ...BUY_LIST_BANK, tol: 1 }], { maxTicks: 100, stop: fatal })).ok) {
            throw Error('buy-list bank route failed');
        }
        const generation = s.bankObservation?.()?.generation ?? -1;
        const closedAt = s.tick();
        await s.sdk.sendCloseModal();
        if (!await waitUntil(s, () => fatal() || (s.tick() > closedAt && !s.sdk.getState()?.bank.isOpen && !s.sdk.getGEState() && !s.sdk.getState()?.interface.isOpen && !s.sdk.getState()?.modalOpen), { timeoutTicks: 12 }) || fatal()) {
            throw Error('buy-list observed modal closure absent');
        }
        if (!(await s.bot.openBank()).success
            || !await waitUntil(s, () => fatal() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 12 })
            || fatal()) {
            throw Error('buy-list fresh bank unavailable');
        }
        const observed = s.bankObservation?.();
        if (!observed || !s.sdk.getState()?.bank.isOpen) throw Error('buy-list bank observation unknown');
        const result = canonical([...observed.items, ...s.sdk.getInventory(), ...s.sdk.getEquipment()]);
        await s.bot.closeBank();
        return result;
    });
    const save = () => {
        mkdirSync(dirname(paths.parent), { recursive: true });
        writeFileSync(paths.parent + '.tmp', JSON.stringify(parent, null, 2));
        renameSync(paths.parent + '.tmp', paths.parent);
    };
    const outcome = (j: ItemOrder) => {
        const a = orderAccounting(j);
        if (j.phase !== 'settled' || a.outcomeUnresolved || a.escrow !== 0) throw Error('buy child escrow not settled');
        return { acquired: a.acquired, spent: a.spent };
    };
    const balanced = (after: Record<number, number>) => {
        const delta: Record<number, number> = {};
        let spent = 0;
        for (let i = 0; i < r.entries.length; i++) {
            const o = parent!.outcomes[i];
            if (o) {
                delta[r.entries[i]!.item] = (delta[r.entries[i]!.item] ?? 0) + o.acquired;
                spent += o.spent;
            }
        }
        delta[995] = -spent;
        return spent <= r.budget && (after[995] ?? 0) >= r.reserve && same(parent!.gear, gear())
            && [...new Set([...Object.keys(parent!.initial), ...Object.keys(after)])].every(k => (after[Number(k)] ?? 0) === (parent!.initial[Number(k)] ?? 0) + (delta[Number(k)] ?? 0));
    };
    let failure = '';
    let pending = false;
    const replay = parent?.phase === 'banked';
    try {
        if (!parent) {
            if (stop()) throw Error('buy list stopped before intent');
            const initial = await audit(s);
            if ((initial[995] ?? 0) < r.budget + r.reserve) throw Error('buy list owned cash/reserve short');
            const children = r.entries.map((e, i) => ({
                actor: r.actor,
                server: r.server,
                goal: `${r.goal}-buy-${i}`,
                item: e.item,
                quantity: e.quantity,
                expectedOwned: initial[e.item] ?? 0,
                limit: percentagePrice(e.basePrice, e.percent),
                reserve: r.reserve,
                createdAt: r.createdAt,
                reviewAt: r.createdAt,
                deadline: r.deadline,
            }));
            parent = { version: 1, request: r, initial, gear: gear(), children, outcomes: r.entries.map(() => null), phase: 'prepared', aborted: false };
            save();
        }
        for (let i = 0; i < r.entries.length; i++) {
            const e = r.entries[i]!;
            const q = parent.children[i]!;
            validateRequest(q);
            if (q.actor !== r.actor || q.server !== r.server || q.goal !== `${r.goal}-buy-${i}` || q.item !== e.item
                || q.quantity !== e.quantity || q.limit !== percentagePrice(e.basePrice, e.percent)
                || q.expectedOwned !== (parent.initial[e.item] ?? 0) || q.reserve !== r.reserve
                || q.deadline !== r.deadline || q.createdAt !== r.createdAt || q.reviewAt !== r.createdAt) {
                throw Error('buy-list persisted child request changed');
            }
            const j = load(i);
            if (j && i > 0 && load(i - 1)?.phase !== 'settled') throw Error('buy-list child sequence ambiguous');
            if (parent.outcomes[i] && (!j || !same(outcome(j), parent.outcomes[i]))) throw Error('buy-list outcome disagrees with child');
        }
        for (let i = 0; i < r.entries.length; i++) {
            const e = r.entries[i]!;
            const q = parent.children[i]!;
            const j = load(i);
            const recorded = parent.outcomes[i];
            if (recorded) {
                if (!j || !same(outcome(j), recorded)) throw Error('buy-list outcome disagrees with child');
                continue;
            }
            if (replay) {
                if (parent.aborted && !j) break;
                throw Error('banked buy list has unresolved child');
            }
            if (!j && (stop() || parent.aborted)) {
                parent.aborted = true;
                save();
                break;
            }
            if (!j && !balanced(await audit(s))) throw Error('buy-list initial assets changed before next order');
            parent.phase = 'running';
            save();
            const result = await buyer(s, q, paths.children[i]!, j ? fatal : stop, !!j, r.fillWait);
            const settled = load(i);
            if (!settled || settled.phase !== 'settled') {
                pending = !!settled;
                throw Error('buy-list child outcome unresolved; no later item authorized');
            }
            if (!result.banked || !result.conserved || !result.unrelated || !result.reserveKept || result.outcomeUnresolved || result.died || result.damaged || !outputsBanked()) {
                throw Error('buy-list settled child bank return unconfirmed; no later item authorized');
            }
            parent.outcomes[i] = outcome(settled);
            if (parent.outcomes[i]!.acquired !== e.quantity) {
                parent.aborted = true;
                failure = 'finite buy child partially filled';
            }
            save();
            if (parent.aborted) break;
        }
        if (paths.children.some((_p, i) => {
            const j = load(i);
            return !!j && j.phase !== 'settled';
        })) {
            pending = true;
            throw Error('buy-list active escrow remains');
        }
        const after = await audit(s);
        if (!balanced(after) || !outputsBanked()) throw Error('buy-list final initial-assets/owned budget/banked outputs audit failed');
        parent.phase = 'banked';
        if (failure) parent.failure = failure;
        else delete parent.failure;
        save();
        const targetMet = parent.outcomes.every((o, i) => o?.acquired === r.entries[i]!.quantity);
        return {
            ok: !fatal(),
            banked: true,
            targetMet,
            replay,
            pending: false,
            outcomes: parent.outcomes,
            spent: parent.outcomes.reduce((n, o) => n + (o?.spent ?? 0), 0),
            failure: failure || '-',
        };
    } catch (error) {
        failure = String(error);
        if (parent) {
            parent.failure = failure;
            save();
        }
        return { ok: false, banked: false, targetMet: false, replay, pending, failure, outcomes: parent?.outcomes };
    }
}

// --- GE Trip (from scripts/microbot-ge-trip.ts) ---

const GE_TRIP_BANK = { x: 3185, z: 3436, level: 0 };
const GE_TRIP_SPOT = { x: 3181, z: 3443, level: 0 };
type TripOutcome = { filled: number; gross: number; tax: number; net: number; unsubmitted: boolean };

export function geSaleRequest(r: GETripRequest): SaleRequest {
    return { actor: r.actor, server: r.server, goal: r.goal, item: r.item, quantity: r.quantity, price: r.price, floor: r.floor, reserveItems: 0, deadline: r.deadline };
}

export function validateGETrip(r: GETripRequest) {
    validateSale(geSaleRequest(r));
    if (!Number.isSafeInteger(r.reserve) || r.reserve < 0 || !Number.isSafeInteger(r.fillWait) || r.fillWait < 0 || r.fillWait > 200
        || !Number.isSafeInteger(r.cap) || r.cap < 500 || r.cap > 100000 || r.quantity > 24) {
        throw Error('invalid finite bank GE lot');
    }
}

export function geTripPaths(r: GETripRequest) {
    const paths = orderPaths(r.server, r.actor, 'ge-trip-' + r.goal);
    return { parent: paths.journal, lower: orderPaths(r.server, r.actor, 'sell-' + r.goal).journal, lock: paths.lock };
}

function atomicWrite(path: string, value: unknown) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path + '.tmp', JSON.stringify(value, null, 2));
    renameSync(path + '.tmp', path);
}

const emptyTripOutcome = (): TripOutcome => ({ filled: 0, gross: 0, tax: 0, net: 0, unsubmitted: true });

export function geOutcome(lower: SaleJournal): TripOutcome {
    const p = lower.progress;
    const c = lower.claim;
    const r = lower.request;
    if (lower.phase !== 'settled' || !p || !c || ![p.filled, p.gross, p.tax, c.items, c.coins].every(n => Number.isSafeInteger(n) && n >= 0)
        || p.filled > r.quantity || p.gross < p.filled * r.price || p.tax !== Math.floor(p.gross / 20)
        || c.items !== r.quantity - p.filled || c.coins !== p.gross - p.tax) {
        throw Error('settled sale outcome corrupt');
    }
    return { filled: p.filled, gross: p.gross, tax: p.tax, net: c.coins, unsubmitted: false };
}

export function geTripAudit(initial: Record<number, number>, after: Record<number, number>, r: GETripRequest, o: TripOutcome) {
    return [...new Set([...Object.keys(initial), ...Object.keys(after)].map(Number))].every(
        id => (after[id] ?? 0) - (initial[id] ?? 0) === (id === r.item ? -o.filled : id === 995 ? o.net : 0),
    ) && (after[r.item] ?? 0) >= r.reserve;
}

export type GETripDeps = {
    bankRunner?: typeof runMarketBankProfile;
    seller?: typeof runOwnedSale;
    paths?: { parent: string; lower: string };
};

export async function runGETrip(s: Session, r: GETripRequest, requestStop: () => boolean = () => false, deps: GETripDeps = {}) {
    validateGETrip(r);
    if (s.name.toLowerCase() !== r.actor.toLowerCase()) throw Error('GE trip actor mismatch');
    const paths = deps.paths ?? geTripPaths(r);
    const seller = deps.seller ?? runOwnedSale;
    const runner = deps.bankRunner ?? runMarketBankProfile;
    const loadLower = () => {
        if (!existsSync(paths.lower)) return;
        const j = JSON.parse(readFileSync(paths.lower, 'utf8')) as SaleJournal;
        if (j.version !== 1 || !sameSorted(j.request, geSaleRequest(r))
            || !['prepared', 'attempted', 'open', 'cancelling', 'collecting', 'settled'].includes(j.phase)
            || !Number.isSafeInteger(j.coinsBefore) || j.coinsBefore < 0 || !Number.isSafeInteger(j.itemsBefore) || j.itemsBefore < r.quantity
            || !Array.isArray(j.previousIds) || j.previousIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
            throw Error('GE lower journal corrupt/identity mismatch');
        }
        return j;
    };
    let lower = loadLower();
    let parent: GETripJournal | undefined = existsSync(paths.parent) ? JSON.parse(readFileSync(paths.parent, 'utf8')) : undefined;
    if (!parent && lower) throw Error('GE lower journal without parent intent');
    if (parent && (parent.version !== 1 || !sameSorted(parent.request, r)
        || !['prepared', 'staging', 'market', 'settled', 'aborted', 'banked'].includes(parent.phase)
        || !parent.initial || Object.entries(parent.initial).some(([id, n]) => !/^\d+$/.test(id) || !Number.isSafeInteger(n) || n < 0))) {
        throw Error('GE parent intent corrupt/identity mismatch');
    }
    if (parent && ((parent.initial[r.item] ?? 0) < r.quantity + r.reserve || !Array.isArray(parent.initialGear)
        || parent.initialGear.some(i => ![i.id, i.slot, i.count].every(Number.isSafeInteger) || i.id < 0 || i.slot < 0 || i.count < 1))) {
        throw Error('GE parent initial stock/gear ledger corrupt');
    }
    if (parent && ['settled', 'banked'].includes(parent.phase) && (!parent.outcome || (!lower && !parent.outcome.unsubmitted))) {
        throw Error('GE terminal parent lacks outcome/lower evidence');
    }
    if (parent?.outcome && (parent.outcome.unsubmitted
        ? !sameSorted(parent.outcome, emptyTripOutcome())
        : !lower || lower.phase !== 'settled' || !sameSorted(parent.outcome, geOutcome(lower)))) {
        throw Error('GE parent terminal outcome corrupt');
    }
    if (parent?.outcome?.unsubmitted && lower && lower.phase !== 'prepared') throw Error('GE unsubmitted parent conflicts with escrow journal');
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = s.tick();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return ended || !p || p.isDead || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0 || hp0 <= 0 || s.tick() - start >= r.cap;
    };
    const stop = () => fatal() || requestStop() || Date.now() >= r.deadline || s.tick() - start >= r.cap - 150;
    const entry = marketEntryFailure(first, hp0);
    if (entry || fatal()) throw Error(entry ?? 'GE original session unavailable');
    const save = () => atomicWrite(paths.parent, parent);
    const gear = () => s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot);
    const atBank = () => {
        const p = s.sdk.getState()?.player;
        return !fatal() && !!p && p.level === 0 && Math.max(Math.abs(p.worldX - GE_TRIP_BANK.x), Math.abs(p.worldZ - GE_TRIP_BANK.z)) <= 3;
    };
    const freshBank = async () => {
        if (!atBank() || s.tick() - start >= r.cap - 30) throw Error('GE final bank/original life/audit budget unavailable');
        const generation = s.bankObservation?.()?.generation ?? -1;
        await s.sdk.sendCloseModal();
        if (fatal() || !(await s.bot.openBank()).success
            || !await waitUntil(s, () => fatal() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 12 })
            || !atBank() || !s.sdk.getState()?.bank.isOpen || !s.bankObservation?.()) {
            throw Error('GE fresh bank observation absent');
        }
    };
    const assets = () => {
        const bank = s.bankObservation?.();
        if (!bank || !s.sdk.getState()?.bank.isOpen || !atBank()) throw Error('GE asset audit bank unknown');
        const out: Record<number, number> = {};
        for (const i of [...s.sdk.getInventory(), ...s.sdk.getEquipment(), ...bank.items]) out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    };
    const replay = !!parent;
    let route: any;
    let failure = '';
    let recoveryDeferred = false;
    try {
        if (!parent) {
            if (stop()) throw Error('GE stopped before initial intent');
            if (!atBank()) throw Error('new GE lot starts at known Varrock bank');
            await freshBank();
            const initial = assets();
            if ((initial[r.item] ?? 0) < r.quantity + r.reserve) throw Error('owned GE bank surplus short');
            parent = { version: 1, request: r, phase: 'prepared', initial, initialGear: gear() };
            save();
            await s.bot.closeBank();
        }
        lower = loadLower();
        if (lower && ['attempted', 'open', 'cancelling', 'collecting'].includes(lower.phase)) {
            const result = await seller(s, geSaleRequest(r), paths.lower, fatal, 0, true);
            lower = loadLower();
            if (!result.ok || lower?.phase !== 'settled') {
                recoveryDeferred = true;
                throw Error('GE escrow recovery unresolved ' + result.error);
            }
            parent.outcome = geOutcome(lower);
            parent.phase = 'settled';
            save();
        } else if (lower?.phase === 'settled') {
            const outcome = geOutcome(lower);
            if (parent.outcome && !sameSorted(parent.outcome, outcome)) throw Error('GE parent/lower outcome changed');
            parent.outcome = outcome;
            parent.phase = 'settled';
            save();
        } else if (replay || stop()) {
            if (parent.phase === 'banked' || parent.phase === 'aborted') {
                if (!parent.outcome) throw Error('GE terminal outcome missing');
            } else {
                parent.outcome = emptyTripOutcome();
                parent.phase = 'aborted';
                save();
            }
        }
        if (!parent.outcome) {
            parent.phase = 'staging';
            save();
            const profile: BankProfile = {
                bank: GE_TRIP_BANK,
                site: GE_TRIP_SPOT,
                inputs: { [r.item]: 1 },
                tools: [],
                outputs: [r.item, 995],
                capacityOutputs: { [r.item]: 1, 995: 1 },
                deferBankRecovery: () => {
                    const j = loadLower();
                    if (j && ['attempted', 'open', 'cancelling', 'collecting'].includes(j.phase)) return true;
                    parent!.outcome = j?.phase === 'settled' ? geOutcome(j) : emptyTripOutcome();
                    parent!.phase = j?.phase === 'settled' ? 'settled' : 'aborted';
                    save();
                    return false;
                },
                run: async (n, _cap, halt) => {
                    if (n !== r.quantity || halt() || stop()) throw Error('GE whole lot/entry stopped');
                    if (loadLower()) throw Error('GE placement journal appeared before new lot');
                    parent!.phase = 'market';
                    save();
                    const result = await seller(s, geSaleRequest(r), paths.lower, () => fatal() || halt(), r.fillWait);
                    const j = loadLower();
                    if (!result.ok || j?.phase !== 'settled') throw Error('GE finite sale unresolved ' + result.error);
                    parent!.outcome = geOutcome(j);
                    parent!.phase = 'settled';
                    save();
                    return n;
                },
            };
            route = await runner(s, { family: 'ge-surplus', recipe: String(r.item), target: r.quantity, batch: r.quantity, cap: r.cap - (s.tick() - start) - 60, returnTicks: 120, members: false, reserve: r.reserve }, profile, stop);
            recoveryDeferred = !!route.recoveryDeferred;
            if (recoveryDeferred) throw Error('GE escrow uncertain; bank return deferred');
            lower = loadLower();
            if (!parent.outcome && (!lower || lower.phase === 'prepared')) {
                parent.outcome = emptyTripOutcome();
                parent.phase = 'aborted';
                save();
            }
            if (!route.ok) failure = route.failure;
        } else {
            const profile: BankProfile = { bank: GE_TRIP_BANK, site: GE_TRIP_BANK, inputs: {}, tools: [], outputs: [r.item, 995], run: async () => {} };
            route = await runner(s, { family: 'ge-return', recipe: String(r.item), target: 1, batch: 1, cap: r.cap - (s.tick() - start) - 60, returnTicks: 120, members: false }, profile, fatal);
            if (!route.atBank) throw Error('GE recovery return bank absent');
        }
        if (!parent.outcome) throw Error('GE parent outcome unresolved');
        await freshBank();
        const after = assets();
        const audited = geTripAudit(parent.initial, after, r, parent.outcome) && sameSorted(parent.initialGear, gear());
        const outputsBanked = [...s.sdk.getInventory(), ...s.sdk.getEquipment()].every(i => i.id !== r.item && i.id !== 995);
        await s.bot.closeBank();
        if (!audited) throw Error('GE final exact initial asset ledger changed');
        if (!outputsBanked) throw Error('GE sale outputs not banked');
        parent.phase = 'banked';
        delete parent.failure;
        save();
        const o = parent.outcome;
        return {
            ok: !fatal(),
            replay,
            targetMet: o.filled === r.quantity,
            settled: true,
            banked: true,
            filled: o.filled,
            gross: o.gross,
            tax: o.tax,
            net: o.net,
            unsubmitted: o.unsubmitted,
            recoveryDeferred: false,
            failure: failure || '-',
            journal: parent,
            ticks: s.tick() - start,
        };
    } catch (error) {
        failure = String(error);
        try {
            lower = loadLower();
            recoveryDeferred ||= !!lower && ['attempted', 'open', 'cancelling', 'collecting'].includes(lower.phase);
        } catch {
            recoveryDeferred = true;
        }
        if (parent) {
            parent.failure = failure;
            save();
        }
        return {
            ok: false,
            replay,
            targetMet: false,
            settled: !!parent?.outcome,
            banked: false,
            recoveryDeferred,
            failure,
            journal: parent,
            filled: parent?.outcome?.filled,
            gross: parent?.outcome?.gross,
            tax: parent?.outcome?.tax,
            net: parent?.outcome?.net,
            unsubmitted: parent?.outcome?.unsubmitted,
            ticks: s.tick() - start,
        };
    }
}

export function geTripStop(actor: string, stopped = false, exists: (p: string) => boolean = existsSync) {
    return stopped || [`.practice/stop-${actor}`, '.practice/stop-all', '.practice/stop-microbot-ge-trip'].some(exists);
}

// --- GE Price Plan (from scripts/microbot-ge-plan.ts) ---

export function validateGEPlan(r: GEPricePlan) {
    if (!r || !Array.isArray(r.prices) || r.prices.length < 1 || r.prices.length > 8 || !/^[a-z0-9_-]{1,40}$/i.test(r.goal)
        || !Number.isSafeInteger(r.cap) || r.cap < 600 || r.cap > 100000) {
        throw Error('invalid finite explicit GE plan');
    }
    for (const p of r.prices) validateGETrip({ ...r, goal: r.goal + '-p0', price: p.price, fillWait: p.fillWait });
}

export function gePlanPaths(r: GEPricePlan) {
    return orderPaths(r.server, r.actor, 'ge-plan-' + r.goal);
}

export function reclaimGEPlanLock(
    path: string,
    alive: (pid: number) => boolean = pid => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
            throw e;
        }
    },
) {
    if (!existsSync(path)) return;
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw Error('GE plan lock owner unknown');
    if (alive(owner.pid)) throw Error('GE plan actor already owned');
    unlinkSync(path);
}

export function gePlanRound(r: GEPricePlan, index: number, remaining: number, cap: number): GETripRequest {
    const p = r.prices[index];
    if (!p) throw Error('GE price suggestion absent');
    return {
        actor: r.actor,
        server: r.server,
        goal: r.goal + '-p' + index,
        item: r.item,
        quantity: remaining,
        reserve: r.reserve,
        floor: r.floor,
        price: p.price,
        fillWait: p.fillWait,
        deadline: r.deadline,
        cap,
    };
}

export function gePlanTotals(rows: readonly GEPlanRound[]) {
    return rows.reduce((a, r) => ({ filled: a.filled + r.filled, gross: a.gross + r.gross, tax: a.tax + r.tax, net: a.net + r.net }), {
        filled: 0,
        gross: 0,
        tax: 0,
        net: 0,
    });
}

const afterRound = (r: GEPlanRound) => {
    const after = { ...r.initial };
    after[r.request.item] = (after[r.request.item] ?? 0) - r.filled;
    after[995] = (after[995] ?? 0) + r.net;
    return after;
};
const sameAssets = (a: Record<number, number>, b: Record<number, number>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (a[Number(k)] ?? 0) === (b[Number(k)] ?? 0));

export function gePlanEntry(previous: GEPlanRound | undefined, current: Pick<GETripJournal, 'initial' | 'initialGear'>) {
    if (previous && (!sameAssets(afterRound(previous), current.initial) || !same(previous.gear, current.initialGear))) {
        throw Error('GE plan between-round assets/gear changed before sale');
    }
}

export function gePlanResting(s: Session, q: GETripRequest, paths: { parent: string; lower: string }) {
    const parent = JSON.parse(readFileSync(paths.parent, 'utf8')) as GETripJournal;
    const lower = JSON.parse(readFileSync(paths.lower, 'utf8')) as SaleJournal;
    const ge = s.sdk.getGEState();
    if (s.name.toLowerCase() !== q.actor.toLowerCase() || parent.version !== 1 || !same(parent.request, q)
        || lower.version !== 1 || !same(lower.request, geSaleRequest(q)) || lower.phase !== 'open' || !ge || s.sdk.getStateAge() > 5000) {
        throw Error('fresh owned resting GE identity absent');
    }
    const count = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    if (!same(parent.initialGear, s.sdk.getEquipment().map(i => ({ id: i.id, slot: i.slot, count: i.count })).sort((a, b) => a.slot - b.slot))) {
        throw Error('resting GE gear changed');
    }
    return { ...saleResting(lower, { actor: s.name, server: q.server, items: count(q.item), coins: count(995), offers: ge.offers }), quantity: q.quantity, unlisted: 0, settled: false, banked: false };
}

type GEPlanDeps = { path?: string; trip?: typeof runGETrip };

export async function runGEPlan(
    s: Session,
    r: GEPricePlan,
    requestStop: () => boolean = () => false,
    deps: GEPlanDeps = {},
    finish = false,
) {
    validateGEPlan(r);
    if (s.name.toLowerCase() !== r.actor.toLowerCase()) throw Error('GE plan actor mismatch');
    const path = deps.path ?? gePlanPaths(r).journal;
    const trip = deps.trip ?? runGETrip;
    const roundPaths = (q: GETripRequest) =>
        deps.path ? { parent: path + '.' + q.goal + '.json', lower: path + '.' + q.goal + '.sell.json' } : geTripPaths(q);
    let j: GEPlanJournal | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (j && (j.version !== 1 || !same(j.request, r) || !Array.isArray(j.rounds) || !['prepared', 'running', 'resting', 'complete', 'stopped'].includes(j.phase))) {
        throw Error('GE plan journal identity invalid');
    }
    const save = () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path + '.tmp', JSON.stringify(j, null, 2));
        renameSync(path + '.tmp', path);
    };
    const readRound = (q: GETripRequest): GEPlanRound => {
        validateGETrip(q);
        const p = roundPaths(q);
        if (!existsSync(p.parent)) throw Error('GE round durable settlement absent');
        const parent = JSON.parse(readFileSync(p.parent, 'utf8')) as GETripJournal;
        if (parent.version !== 1 || parent.phase !== 'banked' || !same(parent.request, q)) throw Error('GE round identity/bank settlement invalid');
        const lower = existsSync(p.lower) ? (JSON.parse(readFileSync(p.lower, 'utf8')) as SaleJournal) : undefined;
        const outcome = parent.outcome?.unsubmitted ? { filled: 0, gross: 0, tax: 0, net: 0, unsubmitted: true } : lower && geOutcome(lower);
        if (!outcome || !same(outcome, parent.outcome) || (lower && (lower.version !== 1 || !same(lower.request, geSaleRequest(q))))
            || (outcome.unsubmitted && lower && lower.phase !== 'prepared')) {
            throw Error('GE round outcome changed');
        }
        if (!parent.initial || !Array.isArray(parent.initialGear)
            || Object.entries(parent.initial).some(([id, n]) => !/^\d+$/.test(id) || !Number.isSafeInteger(n) || n < 0)
            || (parent.initial[q.item] ?? 0) < q.quantity + q.reserve) {
            throw Error('GE round initial assets invalid');
        }
        return { request: q, filled: outcome.filled, gross: outcome.gross, tax: outcome.tax, net: outcome.net, unsubmitted: outcome.unsubmitted, initial: parent.initial, gear: parent.initialGear };
    };
    const validateRounds = () => {
        for (let i = 0; i < j!.rounds.length; i++) {
            const row = j!.rounds[i]!;
            const remaining = r.quantity - gePlanTotals(j!.rounds.slice(0, i)).filled;
            if (!same(row.request, gePlanRound(r, i, remaining, row.request.cap)) || !same(row, readRound(row.request))) {
                throw Error('GE plan recorded round changed');
            }
            if (i && (!sameAssets(afterRound(j!.rounds[i - 1]!), row.initial) || !same(j!.rounds[0]!.gear, row.gear))) {
                throw Error('GE plan between-round assets/gear changed');
            }
        }
        if (j!.rounds.length > r.prices.length) throw Error('GE plan extra round');
    };
    if (j) {
        validateRounds();
        if (['complete', 'stopped'].includes(j.phase) && j.current) throw Error('GE terminal plan retains unresolved round');
        if (j.phase === 'complete' && j.rounds.length < r.prices.length && gePlanTotals(j.rounds).filled < r.quantity) {
            throw Error('GE terminal plan lacks completed price/quantity bound');
        }
    }
    if (j && ['complete', 'stopped'].includes(j.phase)) {
        return {
            ok: true,
            replay: true,
            finished: j.phase === 'complete',
            remaining: r.quantity - gePlanTotals(j.rounds).filled,
            ...gePlanTotals(j.rounds),
            journal: j,
            assetAudit: 'durable banked round receipts; current bank unobserved',
        };
    }
    const first = s.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = s.tick();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = s.sdk.getState()?.player;
        return ended || !first || !p || p.isDead || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns
            || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp || hp < 1;
    };
    const stop = () => fatal() || requestStop() || geTripStop(r.actor) || Date.now() >= r.deadline || s.tick() - start >= r.cap - 150;
    try {
        if (!j) {
            if (stop()) throw Error('GE plan stopped before durable intent');
            j = { version: 1, request: r, phase: 'prepared', rounds: [] };
            save();
        }
        if (j.phase === 'resting' && finish && !stop()) {
            return { ok: true, replay: true, resting: gePlanResting(s, j.current!, roundPaths(j.current!)), ...gePlanTotals(j.rounds), journal: j };
        }
        while (j.current || (j.rounds.length < r.prices.length && gePlanTotals(j.rounds).filled < r.quantity)) {
            if (!j.current) {
                if (stop() || (finish && j.rounds.length > 0)) break;
                const cap = r.cap - (s.tick() - start);
                if (cap < 600) break;
                j.current = gePlanRound(r, j.rounds.length, r.quantity - gePlanTotals(j.rounds).filled, cap);
                j.phase = 'running';
                save();
            }
            const q = j.current;
            if (!same(q, gePlanRound(r, j.rounds.length, r.quantity - gePlanTotals(j.rounds).filled, q.cap))) throw Error('GE pending round changed');
            if (fatal()) throw Error('GE original life/HP unavailable');
            const paths = roundPaths(q);
            const lower = existsSync(paths.lower) ? (JSON.parse(readFileSync(paths.lower, 'utf8')) as SaleJournal) : undefined;
            if (finish && lower?.phase === 'open') {
                const kept = await runOwnedSale(s, geSaleRequest(q), paths.lower, stop, 0, false, { leaveOpen: true, fatal });
                if (!kept.ok) throw Error('GE Finish observation/recovery pending');
                if (kept.resting) {
                    const resting = gePlanResting(s, q, paths);
                    j.phase = 'resting';
                    delete j.failure;
                    save();
                    return { ok: true, replay: false, resting, ...gePlanTotals(j.rounds), journal: j };
                }
            }
            const seller: typeof runOwnedSale = (...args) => {
                if (!args[5]) gePlanEntry(j!.rounds.at(-1), JSON.parse(readFileSync(roundPaths(q).parent, 'utf8')));
                return runOwnedSale(args[0], args[1], args[2], args[3], args[4], args[5], { leaveOpen: finish && !stop(), fatal });
            };
            const result = await trip(s, q, stop, { paths: roundPaths(q), seller });
            if (finish && !stop() && result.recoveryDeferred) {
                const resting = gePlanResting(s, q, roundPaths(q));
                j.phase = 'resting';
                delete j.failure;
                save();
                return { ok: true, replay: false, resting, ...gePlanTotals(j.rounds), journal: j };
            }
            if (!result.ok || !result.banked) throw Error('GE round pending: ' + result.failure);
            const row = readRound(q);
            if (j.rounds.length && (!sameAssets(afterRound(j.rounds.at(-1)!), row.initial) || !same(j.rounds[0]!.gear, row.gear))) {
                throw Error('GE plan between-round assets/gear changed');
            }
            j.rounds.push(row);
            delete j.current;
            save();
            if (stop() || finish || row.unsubmitted) break;
        }
        j.phase = stop() || finish || j.rounds.at(-1)?.unsubmitted || (j.rounds.length < r.prices.length && gePlanTotals(j.rounds).filled < r.quantity)
            ? 'stopped'
            : 'complete';
        delete j.failure;
        save();
        const total = gePlanTotals(j.rounds);
        return {
            ok: !fatal(),
            replay: false,
            finished: j.phase === 'complete',
            remaining: r.quantity - total.filled,
            ...total,
            journal: j,
            assetAudit: 'each round exact owned bank ledger; per-offer native tax summed',
        };
    } catch (error) {
        if (j) {
            j.failure = String(error);
            save();
        }
        return { ok: false, replay: false, pending: !!j?.current, failure: String(error), journal: j };
    }
}

export async function runGEPlanSession(
    s: Session,
    r: GEPricePlan,
    stop: () => boolean = () => false,
    deps: GEPlanDeps = {},
    finish = false,
    finishSession: typeof settle = settle,
) {
    let ok = false;
    try {
        const result = await runGEPlan(s, r, stop, deps, finish);
        console.log('GE_PLAN ' + JSON.stringify(result));
        ok = result.ok;
    } catch (error) {
        console.error('GE_PLAN_ERROR ' + String(error));
    }
    const settled = await finishSession([s], ok, 'finite explicit GE price plan');
    return ok && settled ? 0 : 1;
}

// --- Bank Seller (from scripts/microbot-bank-seller.ts) ---

let bankSellerItems: NativeItem[] | undefined;
export function bankSellerCatalogue() {
    if (bankSellerItems) return bankSellerItems;
    const normal = loadGeItemCatalogue() as NativeItem[];
    const byName = new Map(normal.map(i => [i.debugname, i]));
    bankSellerItems = [...normal];
    for (const line of readFileSync(new URL('../../../../vendor/rs-sdk/server/content/pack/obj.pack', import.meta.url), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(\d+)=cert_(\w+)$/);
        const base = m && byName.get(m[2]!);
        if (m && base) bankSellerItems.push({ ...base, id: Number(m[1]), baseId: base.id });
    }
    return bankSellerItems;
}

const equalAssets = (a: Record<number, number>, b: Record<number, number>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => (a[+k] ?? 0) === (b[+k] ?? 0));

export function validateBankSeller(r: BankSellerPolicy) {
    if (!r || r.allTradeable !== true || !Array.isArray(r.protect) || r.protect.some(id => !whole(id))
        || !r.reserves || Object.entries(r.reserves).some(([id, n]) => !/^\d+$/.test(id) || !whole(n))
        || !whole(r.maxItems, 1, 32) || !whole(r.maxUnits, 1, 768) || !whole(r.perItem, 1, 24)
        || ![0, 5, 10, 50].includes(r.discount) || !whole(r.floor, 1) || !whole(r.unitCap, r.floor)
        || !whole(r.childCap, 600, 100000) || !whole(r.cap, r.childCap + 200, 100000)
        || !whole(r.fillWait, 0, 200) || !whole(r.deadline, 1, Number.MAX_SAFE_INTEGER) || !/^[a-z0-9_-]{1,20}$/i.test(r.goal)) {
        throw Error('invalid finite bank-wide sale policy');
    }
    if (r.liquidation !== undefined
        && (!r.liquidation || r.floor !== 1 || !whole(r.liquidation.waitTicks, 150, 200)
            || !whole(r.liquidation.fillWait, 0, 200) || r.childCap < 1500)) {
        throw Error('liquidation requires declared floor1,150..200tick wait and bounded recovery budget');
    }
    validateGEPlan({
        actor: r.actor,
        server: r.server,
        goal: r.goal + '-0',
        item: 1511,
        quantity: 1,
        reserve: 0,
        floor: r.floor,
        deadline: r.deadline,
        cap: r.childCap,
        prices: [{ price: r.floor, fillWait: r.fillWait }],
    });
}

export function bankSellerPrice(base: number, discount: number) {
    if (!whole(base, 1) || ![0, 5, 10, 50].includes(discount)) throw Error('native sale guide/discount invalid');
    if (discount === 50) return Math.max(1, Math.floor(base / 2));
    let price = base;
    for (let n = 0; n < discount / 5; n++) price = Math.max(1, price - Math.max(1, Math.floor(price / 20)));
    return price;
}

export function bankSellerPrices(price: number, r: BankSellerPolicy) {
    return [{ price, fillWait: r.liquidation?.waitTicks ?? r.fillWait }, ...(r.liquidation && price > 1 ? [{ price: 1, fillWait: r.liquidation.fillWait }] : [])];
}

export function selectBankSales(
    bank: readonly Row[],
    protectedIds: readonly number[],
    r: BankSellerPolicy,
    native: readonly NativeItem[] = bankSellerCatalogue(),
) {
    const base = (id: number) => native.find(i => i.id === id)?.baseId ?? id;
    const protectedSet = new Set([995, ...protectedIds, ...r.protect].map(base));
    const seen = new Set<number>();
    const selected: Row[] = [];
    const skipped: { item: number; reason: string }[] = [];
    let units = 0;
    for (const row of bank) {
        if (!whole(row.id) || !whole(row.count, 1) || seen.has(row.id)) throw Error('bank item identity/count unknown');
        seen.add(row.id);
        const item = native.find(i => i.id === row.id);
        if (!item) throw Error('native bank metadata absent ' + row.id);
        if (item.baseId !== undefined) throw Error('native bank contains unexpected certificate');
        const available = row.count - (r.reserves[row.id] ?? 0);
        const reason = protectedSet.has(row.id)
            ? 'protected starting/offer/policy item'
            : !item.tradeable
                ? 'native untradeable'
                : available <= 0
                    ? 'reserved stock'
                    : selected.length >= r.maxItems || units >= r.maxUnits
                        ? 'finite selection bound'
                        : '';
        if (reason) {
            skipped.push({ item: row.id, reason });
            continue;
        }
        const count = Math.min(available, r.perItem, r.maxUnits - units);
        selected.push({ id: row.id, count });
        units += count;
        if (count < available) skipped.push({ item: row.id, reason: 'surplus beyond finite per-item/unit bound' });
    }
    return { selected, skipped };
}

export function bankSellerPaths(r: BankSellerPolicy) {
    const p = orderPaths(r.server, r.actor, 'bank-seller-' + r.goal);
    return { ...p, journal: p.journal + '.bank-seller' };
}

const expectedAssets = (j: BankSellerJournal) => {
    const a = { ...j.initial };
    for (let i = 0; i < j.outcomes.length; i++) {
        const o = j.outcomes[i]!;
        const p = j.plans[i]!;
        a[p.item] = (a[p.item] ?? 0) - o.filled;
        a[995] = (a[995] ?? 0) + o.net;
    }
    return a;
};

export type BankSellerDeps = {
    path?: string;
    catalogue?: readonly NativeItem[];
    quote?: (id: number) => Promise<number>;
    inspect?: () => Promise<{ snapshot: Snapshot; protected: number[]; offers: number[] }>;
    audit?: () => Promise<Snapshot>;
    plan?: typeof runGEPlan;
};

export async function runBankSeller(
    original: Session,
    r: BankSellerPolicy,
    requested: () => boolean = () => false,
    deps: BankSellerDeps = {},
) {
    validateBankSeller(r);
    const native = deps.catalogue ?? bankSellerCatalogue();
    const lifecycle = original.lifecycle;
    const originalSDK = original.sdk;
    const origin = new URL(inProcessSdkConfig({ name: r.actor, password: 'unused-read-only', server: r.server }).browserLaunchUrl!).origin;
    const identity = () => {
        try {
            return original.sdk === originalSDK && original.lifecycle === lifecycle && !!lifecycle
                && lifecycle.account.toLowerCase() === r.actor.toLowerCase() && lifecycle.server === r.server
                && original.name.toLowerCase() === r.actor.toLowerCase()
                && original.sdk.config.botUsername.toLowerCase() === r.actor.toLowerCase()
                && new URL(original.sdk.config.browserLaunchUrl).origin === origin;
        } catch {
            return false;
        }
    };
    if (!identity()) throw Error('bank-seller actual session account/server/origin mismatch');
    const path = deps.path ?? bankSellerPaths(r).journal;
    const plan = deps.plan ?? runGEPlan;
    let j: BankSellerJournal | undefined = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (j && (j.version !== 1 || !sameSorted(j.request, r) || !['prepared', 'running', 'banked'].includes(j.phase)
        || !Array.isArray(j.plans) || !Array.isArray(j.outcomes) || j.outcomes.length > j.plans.length
        || !Array.isArray(j.bank) || !Array.isArray(j.protected) || !Array.isArray(j.offers)
        || !Array.isArray(j.skipped) || !Array.isArray(j.gear) || typeof j.stopped !== 'boolean'
        || (j.phase === 'banked' && !j.stopped && j.outcomes.length !== j.plans.length)
        || !j.initial || Object.values(j.initial).some(n => !whole(n)))) {
        throw Error('bank-seller durable identity invalid');
    }
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = original.tick();
    const client = original.client;
    const executor = (client as any)?.executeBotAction;
    let ended = false;
    let ownerLost = false;
    void original.ended.then(() => { ended = true; });
    const fatal = () => {
        const p = original.sdk.getState()?.player;
        if (original.client !== client || (client as any)?.executeBotAction !== executor) ownerLost = true;
        return !identity() || ownerLost || typeof executor !== 'function' || ended || !first || life === undefined
            || !p || p.isDead || p.lifeId !== life || (p.respawnCount ?? 0) !== respawns || hp < 1
            || (original.sdk.getSkill('Hitpoints')?.level ?? 0) < hp;
    };
    const stop = () => fatal()
        || productionStopRequested(r.actor, requested, existsSync, process.env.STOP_FILE ?? '.practice/stop-microbot-bank-seller')
        || Date.now() >= r.deadline || original.tick() - start >= r.cap - r.childCap - 100;
    const sdk = new Proxy(original.sdk, {
        get(target, key, receiver) {
            const v = Reflect.get(target, key, receiver);
            return typeof v === 'function'
                ? function (...args: unknown[]) {
                    if (typeof key === 'string' && key.startsWith('send') && (fatal() || original.tick() - start >= r.cap)) {
                        throw Error('bank-seller original input owner/life unavailable');
                    }
                    return v.apply(receiver, args);
                }
                : v;
        },
    });
    const s = {
        ...original,
        sdk,
        bot: new BotActions(sdk),
        direct: async (action: Parameters<Session['direct']>[0]) => {
            if (fatal() || original.tick() - start >= r.cap) throw Error('bank-seller direct original input owner/life unavailable');
            return original.direct(action);
        },
    } as Session;
    const save = () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path + '.tmp', JSON.stringify(j, null, 2));
        renameSync(path + '.tmp', path);
    };
    const childPath = (q: GEPricePlan) => path + '.' + q.goal;
    const outcome = (q: GEPricePlan) => {
        const c = JSON.parse(readFileSync(childPath(q), 'utf8')) as GEPlanJournal;
        if (c.version !== 1 || !sameSorted(c.request, q) || !['complete', 'stopped'].includes(c.phase) || c.current) {
            throw Error('bank-seller child escrow unsettled');
        }
        const o = c.rounds.reduce(
            (a, v) => ({ filled: a.filled + v.filled, gross: a.gross + v.gross, tax: a.tax + v.tax, net: a.net + v.net, unsubmitted: a.unsubmitted || v.unsubmitted }),
            { filled: 0, gross: 0, tax: 0, net: 0, unsubmitted: false },
        );
        if (![o.filled, o.gross, o.tax, o.net].every(n => whole(n)) || o.filled > q.quantity || o.net !== o.gross - o.tax) {
            throw Error('bank-seller child accounting invalid');
        }
        return o;
    };
    const audit = deps.audit ?? (async () => {
        if (fatal() || original.tick() - start >= r.cap - 30) throw Error('bank-seller audit life/budget unavailable');
        const p = s.sdk.getState()?.player;
        if (!p || p.level !== 0 || p.worldX < 3180 || p.worldX > 3188 || p.worldZ < 3433 || p.worldZ > 3447) {
            throw Error('bank-seller requires known Varrock bank/GE area');
        }
        const t = s.tick();
        await s.sdk.sendCloseModal();
        if (!await waitUntil(s, () => fatal() || (s.tick() > t && !s.sdk.getState()?.bank.isOpen && !s.sdk.getGEState() && !s.sdk.getState()?.interface.isOpen && !s.sdk.getState()?.modalOpen), { timeoutTicks: 12 }) || fatal()) {
            throw Error('bank-seller modal closure absent');
        }
        if (Math.max(Math.abs(p.worldX - 3185), Math.abs(p.worldZ - 3436)) > 1
            && !(await walkPath(await sessionWalker(s), [{ x: 3185, z: 3436, tol: 1 }], { maxTicks: 100, stop: fatal })).ok) {
            throw Error('bank-seller bank route unavailable');
        }
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success
            || !await waitUntil(s, () => fatal() || (!!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation), { timeoutTicks: 12 })
            || fatal()) {
            throw Error('bank-seller fresh bank absent');
        }
        const view = () => {
            const observation = s.bankObservation?.();
            if (!observation || !s.sdk.getState()?.bank.isOpen) throw Error('bank-seller bank unknown');
            const bank = observation.items.map(i => ({ id: i.id, count: i.count }));
            const gear = s.sdk.getEquipment().map(i => ({ id: i.id, count: i.count, slot: i.slot })).sort((a, b) => a.slot - b.slot);
            const assets: Record<number, number> = {};
            for (const i of [...bank, ...gear, ...s.sdk.getInventory()]) {
                const item = native.find(n => n.id === i.id);
                if (!item) throw Error('bank-seller asset metadata absent ' + i.id);
                const id = item.baseId ?? i.id;
                assets[id] = (assets[id] ?? 0) + i.count;
            }
            return { assets, bank, gear };
        };
        const before = view();
        for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
            if (fatal()) throw Error('bank-seller original owner unavailable for deposit');
            const row = s.sdk.getInventory().find(i => i.id === id);
            if (row) await depositObserved(s, row);
        }
        const after = view();
        if (!equalAssets(before.assets, after.assets) || !sameSorted(before.gear, after.gear)) {
            throw Error('bank-seller initial stock deposit mismatch');
        }
        await s.bot.closeBank();
        if (fatal()) throw Error('bank-seller input owner changed during bank audit');
        return after;
    });
    const verify = (snapshot: Snapshot) => {
        if (!equalAssets(expectedAssets(j!), snapshot.assets) || !sameSorted(j!.gear, snapshot.gear)) {
            throw Error('bank-seller whole assets/gear drift');
        }
    };
    try {
        if (j) {
            const selected = selectBankSales(j.bank, j.protected, r, native).selected;
            const ids = new Set<number>();
            for (let i = 0; i < j.plans.length; i++) {
                const q = j.plans[i]!;
                const row = selected.find(v => v.id === q.item);
                validateGEPlan(q);
                if (!row || ids.has(q.item) || row.count !== q.quantity || q.reserve !== (r.reserves[q.item] ?? 0) || q.floor !== r.floor
                    || q.prices[0]!.price > r.unitCap || !sameSorted(q.prices, bankSellerPrices(q.prices[0]!.price, r))
                    || q.actor !== r.actor || q.server !== r.server || q.goal !== r.goal + '-' + i || q.cap !== r.childCap || q.deadline !== r.deadline) {
                    throw Error('bank-seller child identity changed');
                }
                ids.add(q.item);
                if (i < j.outcomes.length) {
                    const replay = await plan(s, q, () => true, { path: childPath(q) });
                    if (!replay.ok || !replay.replay || !sameSorted(outcome(q), j.outcomes[i])) throw Error('bank-seller child durable outcome changed');
                }
            }
            if (j.phase === 'banked') return { ok: !j.failure, replay: true, journal: j, banked: true };
        }
        if (!j) {
            if (stop()) throw Error('bank-seller stopped before inspection');
            const inspect = deps.inspect ?? (async () => {
                const protectedIds = [...s.sdk.getInventory(), ...s.sdk.getEquipment()].map(i => i.id);
                if (!(await s.bot.openGE(15000)).success || fatal() || stop()) throw Error('bank-seller private offers unavailable');
                const ge = s.sdk.getGEState();
                if (!ge || s.sdk.getStateAge() > 5000) throw Error('bank-seller fresh private offers absent');
                const offers = ge.offers.map(o => o.id);
                protectedIds.push(...ge.offers.map(o => o.item));
                return { snapshot: await audit(), protected: protectedIds, offers };
            });
            const firstView = await inspect();
            if (stop()) throw Error('bank-seller stopped after inspection');
            const selection = selectBankSales(firstView.snapshot.bank, firstView.protected, r, native);
            const plans: GEPricePlan[] = [];
            const config = inProcessSdkConfig({ name: r.actor, password: 'unused-read-only', server: r.server });
            const market = deps.quote ? undefined : new MarketClient(new URL(config.browserLaunchUrl!).origin);
            for (const row of selection.selected) {
                const base = await Promise.race([
                    deps.quote
                        ? deps.quote(row.id)
                        : market!.item(row.id).then(q => {
                            if (q.id !== row.id || q.item !== row.id) throw Error('bank-seller quote item identity mismatch');
                            return q.lastPrice ?? Math.max(1, q.basePrice);
                        }),
                    new Promise<never>((_resolve, reject) => {
                        const timer = setTimeout(() => reject(Error('bank-seller quote deadline')), 5000);
                        timer.unref();
                    }),
                ]);
                if (stop()) throw Error('bank-seller stopped during quote freeze');
                const price = bankSellerPrice(base, r.discount);
                if (price < r.floor || price > r.unitCap) {
                    selection.skipped.push({ item: row.id, reason: 'frozen guide outside declared floor/unit cap' });
                    continue;
                }
                const q: GEPricePlan = {
                    actor: r.actor,
                    server: r.server,
                    goal: r.goal + '-' + plans.length,
                    item: row.id,
                    quantity: row.count,
                    reserve: r.reserves[row.id] ?? 0,
                    floor: r.floor,
                    deadline: r.deadline,
                    cap: r.childCap,
                    prices: bankSellerPrices(price, r),
                };
                validateGEPlan(q);
                plans.push(q);
            }
            if (plans.some(q => existsSync(childPath(q)))) throw Error('bank-seller child exists without parent selection');
            j = {
                version: 1,
                request: r,
                phase: 'prepared',
                initial: firstView.snapshot.assets,
                gear: firstView.snapshot.gear,
                bank: firstView.snapshot.bank,
                protected: firstView.protected,
                offers: firstView.offers,
                plans,
                outcomes: [],
                skipped: selection.skipped,
                stopped: false,
            };
            save();
        }
        while (j.outcomes.length < j.plans.length) {
            const i = j.outcomes.length;
            const q = j.plans[i]!;
            const pending = existsSync(childPath(q));
            if (stop() && !pending) {
                j.stopped = true;
                break;
            }
            if (fatal()) throw Error('bank-seller original life/input owner unavailable');
            if (!pending) verify(await audit());
            j.phase = 'running';
            save();
            const trip: typeof runGETrip = (session, request, halt, dependencies = {}) =>
                runGETrip(session, request, halt, {
                    ...dependencies,
                    seller: async (...args) => {
                        if (!args[5]) {
                            const parent = JSON.parse(readFileSync(dependencies.paths!.parent, 'utf8')) as GETripJournal;
                            verify({ assets: parent.initial, gear: parent.initialGear, bank: [] });
                        }
                        return dependencies.seller!(...args);
                    },
                });
            const result = await plan(s, q, stop, { path: childPath(q), trip });
            if (!result.ok || ('pending' in result && result.pending) || ('resting' in result && result.resting)) {
                throw Error('bank-seller child unresolved: ' + ('failure' in result ? result.failure : 'escrow'));
            }
            const row = outcome(q);
            j.outcomes.push(row);
            save();
            verify(await audit());
            if (row.unsubmitted) {
                j.stopped = true;
                j.phase = 'banked';
                j.failure = 'selected owned sale was not submitted';
                save();
                return { ok: false, replay: false, banked: true, failure: j.failure, journal: j };
            }
            if (stop()) {
                j.stopped = true;
                break;
            }
        }
        verify(await audit());
        j.phase = 'banked';
        delete j.failure;
        save();
        return { ok: !fatal(), replay: false, banked: true, journal: j };
    } catch (error) {
        if (j) {
            j.failure = String(error);
            save();
        }
        return { ok: false, replay: false, banked: false, failure: String(error), journal: j };
    }
}

// --- Shop to Bid (from scripts/shop-to-bid.ts) ---

const DEMO = 'https://rs-sdk-demo.fly.dev';
export const GE_SPOT = { x: 3184, z: 3440, level: 0 };
export const CHUNK = 50;
export const TRICKLE = 10;
export const trickleOnly = (bought: number, probe: boolean, wait: number) => !probe && wait === 0 && bought > 0 && bought < TRICKLE;
export const chunkTooDear = (spent: number, bought: number, bid: number, minNet: number) => bought > 0 && spent / bought > netPerUnit(bid) - minNet;
export const netPerUnit = (bid: number) => bid - bid / 20;

export function bidPlan(o: { quote: Quote; unitCost: number; coins: number; reserve: number; maxUnits: number; minNet: number }): { units: number; refusal?: string } {
    const q = o.quote;
    if (!q.bid || q.buyQuantity <= 0) return { units: 0, refusal: 'no open bid' };
    const margin = netPerUnit(q.bid) - o.unitCost;
    if (margin < o.minNet) return { units: 0, refusal: `margin ${Math.floor(margin)} is under MIN_NET ${o.minNet}` };
    const afford = Math.floor(Math.max(0, o.coins - o.reserve) / Math.max(1, o.unitCost));
    const units = Math.min(o.maxUnits, q.buyQuantity, afford);
    return units > 0 ? { units } : { units: 0, refusal: 'no coins above the reserve' };
}

export const floatNeed = (packCoins: number, reserve: number, maxSpend: number) => Math.max(0, reserve + maxSpend - packCoins);

export function parseProfiles(arg: string, known: readonly string[]): string[] | null {
    const keys = arg.toLowerCase().split(',').filter(Boolean);
    return keys.length && keys.every(k => known.includes(k)) ? keys : null;
}

export function parseItems(arg: string): number[] | null {
    const ids = arg.split(',').map(Number);
    return ids.length && ids.every(n => Number.isSafeInteger(n) && n > 0) ? [...new Set(ids)] : null;
}

const exactly = (re: RegExp) => new RegExp(re.source.replace(/^\^?/, '^').replace(/\$?$/, '$'), re.flags);

export function lotValue(items: readonly { re: RegExp }[], quotes: readonly Quote[], cap = 5000): number {
    let total = 0;
    for (const q of quotes) if (q.bid && items.some(({ re }) => exactly(re).test(q.name))) total += Math.max(0, netPerUnit(q.bid) - q.basePrice) * Math.min(cap, q.buyQuantity);
    return Math.floor(total);
}

export function scanProfiles(profiles: Record<string, { items: { re: RegExp }[] }>, market: readonly Quote[], minNet: number) {
    const out: { profile: string; id: number; name: string; bid: number; want: number; margin: number }[] = [];
    for (const [profile, conf] of Object.entries(profiles)) {
        for (const { re } of conf.items) {
            for (const q of market.filter(m => exactly(re).test(m.name))) {
                if (!bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: Number.MAX_SAFE_INTEGER, minNet }).units) continue;
                out.push({ profile, id: q.id, name: q.name, bid: q.bid!, want: q.buyQuantity, margin: Math.floor(netPerUnit(q.bid!) - q.basePrice) });
            }
        }
    }
    return out.sort((a, b) => b.margin * b.want - a.margin * a.want);
}

type Get = (url: string) => Promise<any>;
const getJson: Get = async url => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw Error(`market HTTP ${r.status}`);
    return r.json();
};
const toQuote = (j: any): Quote => ({
    id: j.id,
    name: j.name,
    basePrice: j.basePrice,
    bid: Number.isSafeInteger(j.bid) && j.bid > 0 ? j.bid : null,
    buyQuantity: Number.isSafeInteger(j.buyQuantity) ? j.buyQuantity : 0,
});

export async function fetchQuote(item: number, get: Get = getJson): Promise<Quote> {
    const j = await get(gameDialAddress(`${DEMO}/api/market/items/${item}`));
    if (j?.id !== item || typeof j.name !== 'string' || !Number.isSafeInteger(j.basePrice)) throw Error(`invalid market quote for ${item}`);
    return toQuote(j);
}

export async function fetchMarket(get: Get = getJson, pause = (ms: number) => Bun.sleep(ms)): Promise<Quote[]> {
    const all: Quote[] = [];
    for (let offset = 0, total = 1; offset < total; offset += 100) {
        const j = await get(gameDialAddress(`${DEMO}/api/market/items?limit=100&offset=${offset}`));
        if (!Number.isSafeInteger(j?.total) || !Array.isArray(j.items)) throw Error('invalid market page');
        total = Math.min(j.total, 5000);
        all.push(...j.items.filter((i: any) => Number.isSafeInteger(i?.id) && typeof i.name === 'string' && Number.isSafeInteger(i.basePrice)).map(toQuote));
        if (offset + 100 < total) await pause(500);
    }
    return all;
}

export const PACKETS_PER_TICK = 5;
export function tickPackets(want: number, perTick = PACKETS_PER_TICK): number[] {
    const out: number[] = [];
    for (let left = Math.floor(want); left > 0 && out.length < perTick;) {
        const n = left >= 10 ? 10 : left >= 5 ? 5 : 1;
        out.push(n);
        left -= n;
    }
    return out;
}

const invHeld = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const invCoins = (s: Session) => invHeld(s, 995);

async function tickBuy(s: Session, q: Quote, want: number, reserve: number, spendLeft: number): Promise<{ bought: number; spent: number }> {
    const shop = s.sdk.getState()?.shop;
    const item = shop?.shopItems.find(i => i.name.toLowerCase() === q.name.toLowerCase());
    if (!shop?.isOpen || !item || item.count <= 0) return { bought: 0, spent: 0 };
    const unit = maximumUnitCost(item, shop.shopConfig);
    const wallet = invCoins(s);
    const before = invHeld(s, q.id);
    const packets = tickPackets(Math.min(want, item.count, Math.floor(Math.min(wallet - reserve, spendLeft) / unit)));
    if (!packets.length) return { bought: 0, spent: 0 };
    for (const amount of packets) await s.direct({ type: 'shopBuy', slot: item.slot, amount, reason: 'SDK' });
    await waitUntil(s, () => invHeld(s, q.id) > before, { timeoutTicks: 3 });
    await waitTicks(s, 1);
    const spent = Math.max(0, wallet - invCoins(s));
    if (invCoins(s) < reserve || spent > spendLeft) throw Error('shop budget violated: observed server cost exceeded reserved maximum');
    return { bought: Math.max(0, invHeld(s, q.id) - before), spent };
}

export async function runShopToBid(
    s: Session,
    server: string,
    cfg: ShopToBidConfig,
    stop: () => boolean = () => saleStopRequested(s.name),
    quotes?: Quote[],
) {
    const maxUnits = cfg.units ?? 5000;
    const minNet = cfg.minNet ?? 50;
    const reserve = cfg.coinReserve ?? 10_000;
    const maxSpend = cfg.maxSpend ?? 200_000;
    const wait = cfg.waitTicks ?? 0;
    const minLot = cfg.minLot ?? 20_000;
    const lotsWanted = Math.max(1, cfg.lots ?? 1);
    const profiles = cfg.profiles;
    const items = cfg.itemIds;

    const quotesNow = async (log: boolean) => {
        if (log === false && quotes?.length) return quotes;
        const out: Quote[] = [];
        for (const id of items) {
            const q = await fetchQuote(id);
            const pre = bidPlan({ quote: q, unitCost: q.basePrice, coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits, minNet });
            if (log) console.log(`QUOTE ${id} ${q.name} bid=${q.bid} want=${q.buyQuantity} base=${q.basePrice}${pre.units ? '' : ` skip: ${pre.refusal}`}`);
            if (pre.units) out.push(q);
        }
        return out;
    };

    const runLot = async (key: string, lotQuotes: Quote[]): Promise<{ gain: number; sold: number; errors: string[] }> => {
        const conf = PROFILES[key]!;
        const need = floatNeed(invCoins(s), reserve, maxSpend);
        if (need > 0) {
            const near = !!(s.sdk.findNearbyNpc(/^banker$/i) || s.sdk.findNearbyLoc(/^bank booth$/i));
            if (!near && !(await walkTargetPersist(s, { x: conf.bankSpot.x, z: conf.bankSpot.z, level: 0 })).ok) {
                throw Error('shop-to-bid: bank walk failed');
            }
            const b = await s.bot.openBank();
            if (!b.success) throw Error(`shop-to-bid: openBank failed: ${b.message}`);
            await s.bot.withdrawItem(/^coins$/i, need);
            await s.bot.closeInterface();
            console.log(`FLOAT took ${need} asked, pack coins ${invCoins(s)}`);
        }
        const startCoins = invCoins(s);
        const lots: { q: Quote; startHeld: number; bought: number; spent: number }[] = [];
        if (!(await walkTargetPersist(s, { x: conf.npcSpot.x, z: conf.npcSpot.z, level: conf.npcSpot.level ?? 0 })).ok) {
            throw Error('shop-to-bid: shop walk failed');
        }
        const open = await s.bot.openShop(conf.npc);
        if (!open.success) throw Error(`shop-to-bid: openShop failed: ${open.message}`);
        let spent = 0;
        const sells = new Set(s.sdk.getState()?.shop?.shopItems.map(i => i.name.toLowerCase()) ?? []);
        for (const q of lotQuotes.filter(quote => sells.has(quote.name.toLowerCase()))) {
            const plan = bidPlan({ quote: q, unitCost: q.basePrice, coins: invCoins(s), reserve, maxUnits, minNet });
            const lot = { q, startHeld: invHeld(s, q.id), bought: 0, spent: 0 };
            lots.push(lot);
            let cap = plan.units;
            let probe = true;
            for (let idle = 0; lot.bought < cap && !stop();) {
                const b = await tickBuy(s, q, Math.min(probe ? 2 : CHUNK, cap - lot.bought), reserve, maxSpend - spent);
                lot.bought += b.bought;
                lot.spent += b.spent;
                spent += b.spent;
                const wasProbe = probe;
                if (probe && b.bought > 0) {
                    probe = false;
                    if (s.sdk.getInventory().filter(i => i.id === q.id).length > 1) {
                        cap = Math.min(cap, lot.bought + Math.max(0, 26 - s.sdk.getInventory().length));
                    }
                }
                if (chunkTooDear(b.spent, b.bought, q.bid!, minNet)) {
                    console.log(`DEAR ${q.name} at ${(b.spent / b.bought).toFixed(1)} a unit`);
                    break;
                }
                if (trickleOnly(b.bought, wasProbe, wait)) {
                    console.log(`TRICKLE ${q.name}: ${b.bought} in a tick, the shelf is empty`);
                    break;
                }
                if (b.bought === 0) {
                    if (++idle > wait) break;
                    await waitTicks(s, 1);
                } else {
                    idle = 0;
                }
            }
            console.log(`BOUGHT ${lot.bought} ${q.name} spent=${lot.spent} at ${key}${plan.units ? '' : ` (${plan.refusal})`}`);
        }
        await s.bot.closeInterface();
        if (!lots.some(l => invHeld(s, l.q.id) > l.startHeld)) return { gain: invCoins(s) - startCoins, sold: 0, errors: [] };
        if (!(await walkTargetPersist(s, GE_SPOT)).ok) throw Error('shop-to-bid: exchange walk failed');
        const errors: string[] = [];
        let sold = 0;
        for (const lot of lots) {
            const units = invHeld(s, lot.q.id) - lot.startHeld;
            if (units <= 0 || stop()) continue;
            const q = await fetchQuote(lot.q.id);
            const sell = bidPlan({ quote: q, unitCost: lot.spent / Math.max(1, lot.bought), coins: Number.MAX_SAFE_INTEGER, reserve: 0, maxUnits: units, minNet });
            if (!sell.units) {
                console.log(`KEPT ${units} ${q.name}: ${sell.refusal}`);
                continue;
            }
            const goal = `bid-${q.id}-${Date.now()}`;
            const paths = orderPaths(server, s.name, 'sell-' + goal);
            mkdirSync(paths.base, { recursive: true });
            const sale = await runOwnedSale(
                s,
                { actor: s.name, server, goal, item: q.id, quantity: sell.units, price: q.bid!, floor: q.bid!, reserveItems: 0, deadline: Date.now() + 120_000 },
                paths.journal,
                stop,
            );
            const filled = sale.journal?.progress?.filled ?? 0;
            sold += filled;
            console.log(`SHOP_TO_BID ${JSON.stringify({ item: q.id, name: q.name, profile: key, bought: lot.bought, spent: lot.spent, sold: filled, bid: q.bid, ok: sale.ok, error: sale.ok ? undefined : sale.error })}`);
            if (!sale.ok) errors.push(`${q.name}: ${sale.error}`);
        }
        return { gain: invCoins(s) - startCoins, sold, errors };
    };

    let total = 0;
    let done = 0;
    let empty = 0;
    for (let n = 0; n < lotsWanted && !stop(); n++) {
        const key = profiles[n % profiles.length]!;
        const qList = n === 0 ? await quotesNow(false) : await quotesNow(true);
        if (!qList.length) {
            console.log('LOT_STOP no item clears MIN_NET');
            break;
        }
        const value = lotValue(PROFILES[key]!.items, qList, maxUnits);
        if (value < minLot) {
            console.log(`LOT_SKIP ${key}: at most ${value} coins at the base price, under MIN_LOT ${minLot}`);
            empty++;
            if (empty >= profiles.length) {
                console.log('LOT_STOP every shop sold nothing');
                break;
            }
            continue;
        }
        const t0 = s.tick();
        const r = await runLot(key, qList);
        total += r.gain;
        done++;
        console.log(`LOT ${n + 1} ${key} coins ${r.gain >= 0 ? '+' : ''}${r.gain} sold ${r.sold} ticks ${s.tick() - t0}`);
        if (r.errors.length) {
            return { ok: false, total, done, sold: r.sold, summary: `shop-to-bid sale failed: ${r.errors.join('; ')}; coins ${total} over ${done} lots` };
        }
        empty = r.sold ? 0 : empty + 1;
        if (empty >= profiles.length) {
            console.log('LOT_STOP every shop sold nothing');
            break;
        }
    }
    const ok = done > 0 && empty < profiles.length;
    return { ok, total, done, summary: `shop-to-bid coins ${total >= 0 ? '+' : ''}${total} over ${done} lots` };
}
