// Unified firemaking workers: line firemaking order, multi-helper line drops, and Varrock GE regular-fire loop.
// Supports banked normal logs ladder method.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBot, finish, getWorld, accountOf, settle } from '../../../core/src/bot';
import { BotActions } from '../../../../vendor/rs-sdk/sdk/actions';
import type { Session } from '../../../core/src/inprocess';
import { statusReadDirs } from '../../../core/src/practice-paths';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { walkPath, sessionWalker, walkRoute, FAR_WALK_TILES, type PathPoint } from '../../../core/src/walk';
import { installDoorPolicy, type Account, type Leg } from '../../../core/src/world';
import { loadTravel, travelAllowed, type Travel } from '../../../core/src/travel';
import { planTripOffThread } from '../../../core/src/route-plan';
import { depositObserved } from '../../../core/src/deposit';
import { planShopPurchases, buyWithBudget, maximumUnitCost } from '../market';
import { xpForLevel, levelForXp, REPO_ROOT } from './catalog';
import { productionStopRequested } from './runtime';

export const LOGS = {
    normal: { id: 1511, name: 'Logs', level: 1 },
    oak: { id: 1521, name: 'Oak logs', level: 15 },
    willow: { id: 1519, name: 'Willow logs', level: 30 },
    maple: { id: 1517, name: 'Maple logs', level: 45 },
    yew: { id: 1515, name: 'Yew logs', level: 60 },
    magic: { id: 1513, name: 'Magic logs', level: 75 },
} as const;

export type LogKind = keyof typeof LOGS;

export function progressiveFiremakingLog(level: number): LogKind {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99) throw Error('native Firemaking base level unknown');
    return (Object.keys(LOGS) as LogKind[]).filter(k => LOGS[k].level <= level).at(-1)!;
}

export function progressiveStockLog(level: number, owned: (id: number) => number): LogKind | undefined {
    if (!Number.isSafeInteger(level) || level < 1 || level > 99) throw Error('native Firemaking base level unknown');
    return (Object.keys(LOGS) as LogKind[]).filter(k => LOGS[k].level <= level && owned(LOGS[k].id) > 0).at(-1);
}

export const TINDERBOX = 590;
export const COINS = 995;
export const FIREMAKING = 'Firemaking';
export const DRAYNOR_BANK = { x: 3092, z: 3243 };
export const BURN_ROWS = [{ z: 3248, sx: 3098, ex: 3072 }, { z: 3250, sx: 3105, ex: 3077 }] as const;
export type BurnRow = { z: number; sx: number; ex: number };
export interface FiremakingSite { name: string; bank: { x: number; z: number }; rows: readonly BurnRow[]; localEntry?: boolean }
export const DRAYNOR_SITE: FiremakingSite = { name: 'Draynor', bank: DRAYNOR_BANK, rows: BURN_ROWS };
export const CATHERBY_SITE: FiremakingSite = {
    name: 'Catherby',
    bank: { x: 2809, z: 3441 },
    rows: [{ z: 3433, sx: 2812, ex: 2789 }, { z: 3436, sx: 2829, ex: 2806 }],
    localEntry: true,
};

export const firemakingSite = (p: { x: number; z: number; level: number }): FiremakingSite =>
    p.level === 0 && Math.max(Math.abs(p.x - CATHERBY_SITE.bank.x), Math.abs(p.z - CATHERBY_SITE.bank.z)) <= 64
        ? CATHERBY_SITE
        : DRAYNOR_SITE;

export const TINDER_SHOP = {
    npc: /^(shopkeeper|shop assistant)$/i,
    item: /^tinderbox$/i,
    baseCost: 1,
    sellMultiplier: 1300,
    route: [
        { x: 3092, z: 3250, tol: 1 },
        { x: 3089, z: 3266, tol: 2 },
        { x: 3100, z: 3270, tol: 2 },
        { x: 3140, z: 3270, tol: 2 },
        { x: 3180, z: 3258, tol: 2 },
        { x: 3212, z: 3246, tol: 2 },
    ] as PathPoint[],
};

export const PACK_LOGS = 27;
export const LIGHT_TICKS = 120;
export const TILE_WAIT_TICKS = 40;

export interface FiremakingOptions {
    target: number;
    maxLogs: number;
    cap: number;
    log: LogKind;
    toolBudget: number;
    cashReserve: number;
    progressive?: boolean;
    stock?: boolean;
    batch?: number;
    burnOnly?: boolean;
    clearPack?: boolean;
}

export function firemakingOptions(env: Record<string, string | undefined> = process.env): FiremakingOptions {
    const int = (key: string, fallback: number | undefined, min: number, max: number) => {
        const n = Number(env[key] ?? fallback);
        if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`invalid ${key}`);
        return n;
    };
    const log = (env.LOG ?? 'normal').toLowerCase();
    if (!Object.hasOwn(LOGS, log)) throw Error('invalid native LOG');
    if (env.BURN_ONLY !== undefined && !['0', '1'].includes(env.BURN_ONLY)) throw Error('invalid BURN_ONLY');
    if (env.PROGRESSIVE !== undefined && !['0', '1', 'stock'].includes(env.PROGRESSIVE)) throw Error('invalid PROGRESSIVE');
    if (env.CLEAR_PACK !== undefined && !['0', '1'].includes(env.CLEAR_PACK)) throw Error('invalid CLEAR_PACK');
    return {
        ...(env.BURN_ONLY === '1' ? { burnOnly: true } : {}),
        target: int('TARGET_LEVEL', env.BURN_ONLY === '1' ? 99 : undefined, 2, 99),
        maxLogs: int('MAX_LOGS', 10000, 1, 1000000),
        cap: int('CAP', 20000, 1, 10000000),
        log: log as LogKind,
        toolBudget: int('TOOL_BUDGET', 50, 0, 1000000),
        cashReserve: int('CASH_RESERVE', 0, 0, 2000000000),
        ...(env.PROGRESSIVE === '1' || env.PROGRESSIVE === 'stock'
            ? { progressive: true, batch: int('BATCH', 27, 1, 27), ...(env.PROGRESSIVE === 'stock' ? { stock: true } : {}) }
            : {}),
        ...(env.CLEAR_PACK === '1' ? { clearPack: true } : {}),
    };
}

export { xpForLevel, levelForXp };

export function logShortfall(target: number, xp: number, xpPerLog: number, owned: number) {
    if (!(xpPerLog > 0)) return Math.max(1 - owned, 0);
    return Math.max(0, Math.ceil((xpForLevel(target) - xp) / xpPerLog) - owned);
}

export function firemakingPreflight(o: FiremakingOptions, s: { plane: number; baseLevel: number; level: number }) {
    if (!Number.isSafeInteger(s.baseLevel) || s.baseLevel < 1) return 'firemaking state unknown';
    if (!o.burnOnly && s.baseLevel >= o.target) return 'already at target';
    if (s.plane !== 0) return 'off plane 0';
    if (s.level < LOGS[o.log].level) return `${LOGS[o.log].name} need Firemaking ${LOGS[o.log].level}`;
    return null;
}

export const lineTiles = (rows: readonly BurnRow[] = BURN_ROWS) =>
    rows.flatMap((r, row) => Array.from({ length: r.sx - r.ex + 1 }, (_, i) => ({ x: r.sx - i, z: r.z, row })));

export function nextFreeTile(tiles: readonly { x: number; z: number }[], from: number, blocked: (t: { x: number; z: number }) => boolean) {
    for (let i = 0; i < tiles.length; i++) {
        const k = (from + i) % tiles.length;
        if (!blocked(tiles[k]!)) return k;
    }
    return -1;
}

export function packWant(heldLogs: number, usedSlots: number, remaining: number) {
    return Math.max(0, Math.min(PACK_LOGS, 28 - usedSlots + heldLogs, remaining) - heldLogs);
}

export function rowStart(row: number, rows: readonly BurnRow[] = BURN_ROWS) {
    return rows.slice(0, row % rows.length).reduce((n, r) => n + r.sx - r.ex + 1, 0);
}

export function tinderboxPlan(
    owned: number,
    shop: { name: string; count: number; buyPrice: number }[],
    inventory: { name: string; count: number }[],
    budget: number,
) {
    if (owned > 0) return [];
    return planShopPurchases([{ re: TINDER_SHOP.item, buyPerTick: 1 }], shop, inventory, new Map(), budget, 1, 1);
}

export const tinderboxUnitMax = () => maximumUnitCost({ baseCost: TINDER_SHOP.baseCost }, { sellMultiplier: TINDER_SHOP.sellMultiplier });

export class Refusal extends Error {}

export function freeRouteAccount(a: Account, travel: readonly Travel[] = loadTravel()): Account {
    const used = new Set(
        travel.flatMap(t => [
            ...t.runes.map(r => r.item),
            ...(t.run.how === 'rub' ? t.run.items : []),
            ...t.needs.flatMap(n => ('held' in n ? [n.held] : [])),
        ]),
    );
    return {
        ...a,
        coins: 0,
        counts: Object.fromEntries(Object.entries(a.counts ?? {}).filter(([i]) => !used.has(i))),
        items: a.items.filter(i => !used.has(i)),
    };
}

export const routeDebits = (legs: readonly Leg[], free: Account) =>
    legs.flatMap(l => (l.kind === 'travel' && (l.travel.coins > 0 || !travelAllowed(l.travel, free)) ? [l.travel.name] : []));

export const ENTRY_BANK_TICKS = 40;
export const ENTRY_BURN_TICKS = 20;
export const entryBudget = (o: FiremakingOptions, used: number) => o.cap - used - ENTRY_BANK_TICKS - ENTRY_BURN_TICKS * Math.min(o.maxLogs, PACK_LOGS);

export async function runFiremaking(s: Session, o: FiremakingOptions, selectedSite?: FiremakingSite) {
    let L = LOGS[o.log];
    const start = s.tick();
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const st = () => s.sdk.getState();
    const pos = () => st()!.player!;
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const worn = (id: number) => (st()?.equipment ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const xp = () => s.sdk.getSkillXp(FIREMAKING)!;
    const base = () => s.sdk.getSkill(FIREMAKING)!.baseLevel;
    const hp = () => s.sdk.getSkill('Hitpoints')!.level;
    const ready = () => {
        const p = st()?.player;
        const f = s.sdk.getSkill(FIREMAKING);
        const h = s.sdk.getSkill('Hitpoints');
        return !!p && p.worldX > 0 && !!f && f.baseLevel > 0 && !!h && h.baseLevel > 0 && Number.isFinite(s.sdk.getSkillXp(FIREMAKING)) && Array.isArray(st()?.inventory);
    };
    if (!await waitUntil(s, ready, { timeoutTicks: 20 })) throw Error('entry state unobserved');
    const guarded = !!o.burnOnly || !!o.progressive || L.level >= 45;
    let continuation = () => {};
    if (guarded) {
        const original = s;
        const client = s.client;
        const executor = (client as any)?.executeBotAction;
        const p = st()!.player!;
        const life = p.lifeId;
        const respawns = p.respawnCount ?? 0;
        const plane = p.level;
        const initialHP = hp();
        let lost = false;
        continuation = () => {
            const now = original.sdk.getState()?.player;
            if (original.client !== client || (client as any)?.executeBotAction !== executor) lost = true;
            if (
                lost
                || typeof executor !== 'function'
                || ended
                || life === undefined
                || !now
                || now.isDead
                || now.lifeId !== life
                || (now.respawnCount ?? 0) !== respawns
                || now.level !== plane
                || (original.sdk.getSkill('Hitpoints')?.level ?? 0) < initialHP
                || original.tick() - start >= o.cap
                || productionStopRequested(original.name)
            ) {
                throw Error('firemaking original owner/life/HP/stop/budget unavailable');
            }
        };
        const sdk = new Proxy(original.sdk, {
            get(target, key, receiver) {
                const v = Reflect.get(target, key, receiver);
                return typeof v === 'function'
                    ? function (this: unknown, ...args: unknown[]) {
                        if (typeof key === 'string' && key.startsWith('send')) continuation();
                        return v.apply(receiver, args);
                    }
                    : v;
            },
        });
        s = { ...original, sdk, bot: new BotActions(sdk), direct: async (action: Parameters<Session['direct']>[0]) => { continuation(); return original.direct(action); } } as Session;
    }
    let hpMin = hp();
    const off = s.onTick(() => {
        const h = s.sdk.getSkill('Hitpoints')?.level;
        if (h !== undefined) hpMin = Math.min(hpMin, h);
    });
    const project = (list: { slot: number; id: number; count: number }[] | undefined) => (list ?? []).map(({ slot, id, count }) => ({ slot, id, count }));
    const at = () => ({ x: pos().worldX, z: pos().worldZ, level: pos().level });
    const site = selectedSite ?? firemakingSite(at());
    const bank = site.bank;
    const startXp = xp();
    const startLevel = base();
    if (o.progressive) {
        if (!Number.isSafeInteger(o.batch) || o.batch! < 1 || o.batch! > 27) throw Error('invalid progressive batch');
        L = LOGS[progressiveFiremakingLog(startLevel)];
    }
    console.log(
        'FIREMAKING_INITIAL '
        + JSON.stringify({
            name: s.name,
            options: o,
            tick: s.tick(),
            position: at(),
            hp: hp(),
            xp: startXp,
            level: startLevel,
            inventory: project(st()?.inventory),
            equipment: project(st()?.equipment),
        }),
    );
    const live = () => {
        if (guarded) continuation();
        if (ended) throw Error('session interrupted');
        if (hp() <= 0) throw Error('died');
    };
    const r = {
        ok: false,
        stop: '',
        target: o.target,
        log: o.log,
        startLevel,
        level: startLevel,
        xpGained: 0,
        logsBurnt: 0,
        xpPerLog: 0,
        ticks: 0,
        logsPer1kTicks: 0,
        hpMin,
        bankTrips: 0,
        tinderbox: { source: '', spent: 0 },
        ownedLogs: 0,
        shortfall: 0,
        refused: '',
        failure: '',
    };
    const seen = new Set<string>();
    const fresh = (re: RegExp) => {
        let hit = false;
        for (const m of st()?.gameMessages ?? []) {
            const k = `${(m as any).observationId}:${m.tick}:${m.text}`;
            if (seen.has(k)) continue;
            seen.add(k);
            if (re.test(m.text)) hit = true;
        }
        return hit;
    };
    fresh(/$^/);
    const walk = async (points: PathPoint[], label: string, maxTicks = 400) => {
        live();
        const w = await walkPath(await sessionWalker(s), points, { maxTicks, stop: () => ended || hp() <= 0 });
        live();
        const p = pos();
        const goal = points.at(-1)!;
        if (!w.ok || p.level !== 0 || Math.max(Math.abs(p.worldX - goal.x), Math.abs(p.worldZ - goal.z)) > (goal.tol ?? 0)) {
            throw Error(`${label}: walk unobserved ${JSON.stringify({ detail: w.detail, at: at(), goal })}`);
        }
    };
    let bankItems: { id: number; name: string; count: number }[] = [];
    const banked = (id: number) => bankItems.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const refresh = () => {
        const b = s.bankObservation?.();
        if (!b) throw Error('bank contents unobserved');
        bankItems = b.items.map(i => ({ ...i }));
    };
    const openBank = async () => {
        if (st()?.bank?.isOpen && s.bankObservation?.()) {
            refresh();
            return;
        }
        const p = pos();
        const distance = Math.max(Math.abs(p.worldX - bank.x), Math.abs(p.worldZ - bank.z));
        if (site.localEntry && distance > 3) {
            const budget = entryBudget(o, s.tick() - start);
            if (budget <= 0) throw new Refusal(`no entry budget: CAP ${o.cap}, used ${s.tick() - start}`);
            await walk([{ ...bank, tol: 2 }], `walk to ${site.name} bank`, budget);
        } else if (distance > FAR_WALK_TILES) {
            live();
            const began = s.tick();
            const budget = entryBudget(o, began - start);
            if (budget <= 0) throw new Refusal(`no entry budget: CAP ${o.cap}, used ${began - start}`);
            const free = freeRouteAccount(accountOf(s));
            const world = await getWorld();
            await installDoorPolicy(s.sdk, s.client);
            const from = { x: p.worldX, z: p.worldZ, level: p.level };
            const to = { ...bank, level: 0 };
            const plan = world.offThread ? await planTripOffThread(from, to, free) : (() => { const d = world.route(from, to, free); return d.ok ? d : null; })();
            live();
            if (!plan) throw new Refusal(`no free route to ${site.name} bank from ${from.x},${from.z}`);
            const debits = routeDebits(plan.legs, free);
            if (debits.length) throw new Refusal(`route to ${site.name} bank takes fares or consumables: ${debits.join(', ')}`);
            if (plan.cost > budget) throw new Refusal(`route to ${site.name} bank estimates ${plan.cost} ticks, entry budget ${budget}`);
            console.log('FIREMAKING_ENTRY ' + JSON.stringify({ tick: s.tick(), from, cost: plan.cost, budget, legs: plan.legs.length, fares: 0 }));
            const ac = new AbortController();
            const stop = () => { if (ended || hp() <= 0 || s.tick() - began >= budget) ac.abort('bank entry stopped or tick budget reached'); };
            const unwatch = s.onTick(stop);
            stop();
            try {
                const w = await walkRoute(s, plan.legs, { legTimeoutTicks: 150, signal: ac.signal });
                live();
                const arrived = pos();
                if (!w.ok || arrived.level !== 0 || Math.max(Math.abs(arrived.worldX - bank.x), Math.abs(arrived.worldZ - bank.z)) > 3) {
                    throw Error(`walk to ${site.name} bank: route unobserved ${JSON.stringify({ outcome: w, at: at() })}`);
                }
            } finally {
                unwatch();
                ac.abort('bank entry finished');
            }
        } else if (distance > 3) {
            await walk([{ ...bank, tol: 2 }], `walk to ${site.name} bank`);
        }
        const g = s.bankObservation?.()?.generation ?? 0;
        const b = await s.bot.openBank();
        live();
        if (!b.success || !await waitUntil(s, () => !!st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > g, { timeoutTicks: 20 })) {
            throw Error(`bank open unobserved: ${b.message}`);
        }
        r.bankTrips++;
        refresh();
        console.log('FIREMAKING_BANK ' + JSON.stringify({ tick: s.tick(), trip: r.bankTrips, logs: banked(L.id), tinderbox: banked(TINDERBOX), coins: banked(COINS), pack: project(st()?.inventory) }));
    };
    const withdraw = async (id: number, n: number) => {
        const item = st()?.bank?.items.find(i => i.id === id);
        const h0 = held(id);
        const b0 = banked(id);
        const g = s.bankObservation?.()?.generation ?? 0;
        if (!item || n < 1) throw Error(`bank item ${id} unavailable`);
        const w = await s.bot.withdrawItem(item, n, { asNote: false });
        live();
        const done = () => {
            const b = s.bankObservation?.();
            return !!b && b.generation > g && held(id) === h0 + n && b.items.filter(i => i.id === id).reduce((k, i) => k + i.count, 0) === b0 - n;
        };
        if (!await waitUntil(s, done, { timeoutTicks: 10 })) throw Error(`withdraw ${id} x${n} unobserved: ${w.message}`);
        refresh();
    };
    const deposit = async (id: number) => {
        const item = inv().find(i => i.id === id);
        if (!item) return;
        await depositObserved(s, { id, name: item.name });
        live();
        refresh();
    };
    const closeBank = async () => {
        if (st()?.bank?.isOpen) {
            await s.bot.closeBank();
            live();
        }
        if (!await waitUntil(s, () => !st()?.bank?.isOpen, { timeoutTicks: 10 })) throw Error('bank close unobserved');
    };
    const coins = () => held(COINS);
    const buyTinderbox = async () => {
        const unit = tinderboxUnitMax();
        const total = coins() + banked(COINS);
        if (Math.min(o.toolBudget, total - o.cashReserve) < unit) {
            throw new Refusal(`tinderbox unaffordable: budget ${o.toolBudget}, coins ${total}, reserve ${o.cashReserve}, unit max ${unit}`);
        }
        if (site.localEntry) throw new Refusal(`${site.name} site requires an owned tinderbox`);
        if (coins() < unit) await withdraw(COINS, Math.min(banked(COINS), o.toolBudget));
        const reserve = Math.max(0, o.cashReserve - banked(COINS));
        const coins0 = coins();
        await closeBank();
        await walk(TINDER_SHOP.route, 'walk to Lumbridge general store', 600);
        const shop = await s.bot.openShop(TINDER_SHOP.npc);
        live();
        if (!shop.success || !await waitUntil(s, () => !!st()?.shop?.isOpen, { timeoutTicks: 10 })) {
            throw Error(`tinderbox shop unobserved: ${shop.message}`);
        }
        let bought = 0;
        let spent = 0;
        try {
            const plan = tinderboxPlan(0, st()!.shop!.shopItems, inv(), Math.min(o.toolBudget, coins() - reserve));
            if (plan.length !== 1) throw Error(`tinderbox unavailable inside budget ${JSON.stringify(st()?.shop?.shopItems?.filter(i => TINDER_SHOP.item.test(i.name)))}`);
            ({ bought, spent } = await buyWithBudget(s.bot, s.sdk as any, plan[0]!.name, 1, reserve, o.toolBudget));
            live();
        } finally {
            await s.bot.closeShop();
        }
        if (bought !== 1 || held(TINDERBOX) !== 1 || spent <= 0 || spent > o.toolBudget || coins0 - coins() !== spent) {
            throw Error(`tinderbox purchase effect unobserved ${JSON.stringify({ bought, spent, coins: coins(), coins0 })}`);
        }
        r.tinderbox = { source: 'bought', spent };
        console.log('FIREMAKING_PURCHASE ' + JSON.stringify({ tick: s.tick(), item: 'tinderbox', bought, spent, budget: o.toolBudget, coins: coins() }));
        await walk([...TINDER_SHOP.route].reverse().slice(1).concat([{ ...bank, tol: 2 }]), `walk back to ${site.name} bank`, 600);
        await openBank();
    };
    const light = async (): Promise<number | 'blocked'> => {
        const tb = inv().find(i => i.id === TINDERBOX);
        const log = inv().find(i => i.id === L.id);
        if (!tb || !log) throw Error('tinderbox or log missing from pack');
        if (st()?.dialog?.isOpen || st()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
        const inventoryTotals = () => {
            const out: Record<number, number> = {};
            for (const i of inv()) out[i.id] = (out[i.id] ?? 0) + i.count;
            return out;
        };
        const expected = guarded ? inventoryTotals() : undefined;
        if (expected) expected[L.id] = (expected[L.id] ?? 0) - 1;
        const gear = guarded ? JSON.stringify(project(st()?.equipment)) : undefined;
        const otherXP = () => JSON.stringify((st()?.skills ?? []).filter(k => k.name !== FIREMAKING).map(k => [k.name, k.experience]));
        const xpOther = guarded ? otherXP() : undefined;
        const x0 = xp();
        const n0 = held(L.id);
        const sent = s.tick();
        fresh(/$^/);
        await s.sdk.sendUseItemOnItem(tb.slot, log.slot);
        let resends = 0;
        while (s.tick() - sent < LIGHT_TICKS) {
            await waitTicks(s, 1);
            live();
            if (xp() > x0) {
                await waitUntil(s, () => held(L.id) === n0 - 1, { timeoutTicks: 3 });
                if (guarded) {
                    live();
                    const actual = inventoryTotals();
                    if (
                        [...new Set([...Object.keys(expected!), ...Object.keys(actual)])].some(id => (actual[+id] ?? 0) !== (expected![+id] ?? 0))
                        || JSON.stringify(project(st()?.equipment)) !== gear
                        || otherXP() !== xpOther
                    ) {
                        throw Error('native burn whole-pack/gear/other-XP receipt differs');
                    }
                }
                return xp() - x0;
            }
            if (fresh(/can't light a fire here/i)) return 'blocked';
            if (fresh(/need a firemaking level|need a tinderbox/i)) throw Error('light refused by server');
            if (!guarded && held(L.id) === n0 && s.tick() - sent >= 4 * (resends + 1) && resends < 3) {
                resends++;
                if (st()?.dialog?.isOpen || st()?.modalOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                const t = inv().find(i => i.id === TINDERBOX);
                const l = inv().find(i => i.id === L.id);
                if (t && l) await s.sdk.sendUseItemOnItem(t.slot, l.slot);
            }
        }
        throw Error(`light effect unobserved ${JSON.stringify({ at: at(), ticks: s.tick() - sent, held: held(L.id), n0 })}`);
    };
    const tiles = lineTiles(site.rows);
    const refused = new Map<string, number>();
    const key = (t: { x: number; z: number }) => `${t.x},${t.z}`;
    const fireAt = (t: { x: number; z: number }) => (st()?.nearbyLocs ?? []).some(l => l.x === t.x && l.z === t.z && /^fire$/i.test(l.name));
    const blocked = (t: { x: number; z: number }) => fireAt(t) || (refused.get(key(t)) ?? -1) > s.tick();
    let cursor = 0;
    const owned = () => held(L.id) + banked(L.id);
    const stopReason = () => (!o.burnOnly && base() >= o.target ? 'target' : r.logsBurnt >= o.maxLogs ? 'max-logs' : s.tick() - start >= o.cap ? 'cap' : owned() < 1 ? 'logs-exhausted' : '');
    try {
        if (guarded) continuation();
        const pre = firemakingPreflight(o.progressive ? { ...o, log: progressiveFiremakingLog(startLevel) } : o, { plane: pos().level, baseLevel: startLevel, level: s.sdk.getSkill(FIREMAKING)!.level });
        if (pre) throw new Refusal(pre);
        await openBank();
        const pick = () => {
            const k = o.stock ? progressiveStockLog(base(), id => held(id) + banked(id)) : progressiveFiremakingLog(base());
            if (k) L = LOGS[k];
            return !!k;
        };
        if (o.progressive && o.stock && !pick()) {
            r.shortfall = 1;
            throw new Refusal(`short log stock: no log that Firemaking ${base()} burns`);
        }
        r.ownedLogs = owned();
        if (r.ownedLogs < 1) {
            r.shortfall = 1;
            throw new Refusal(`short log stock: need 1 ${L.name}, own 0, shortfall 1`);
        }
        const tinderOwned = held(TINDERBOX) + banked(TINDERBOX) + worn(TINDERBOX);
        if (held(TINDERBOX) + worn(TINDERBOX) > 0) r.tinderbox.source = 'pack';
        else if (banked(TINDERBOX) > 0) {
            await withdraw(TINDERBOX, 1);
            r.tinderbox.source = 'bank';
        } else if (tinderOwned === 0) {
            await buyTinderbox();
        }
        if (o.clearPack) {
            if (!st()?.bank?.isOpen) await openBank();
            for (const id of new Set(inv().map(i => i.id))) if (id !== TINDERBOX) await deposit(id);
        }
        let row = 0;
        for (;;) {
            const done = stopReason();
            if (done && done !== 'logs-exhausted') {
                r.stop = done;
                break;
            }
            if (o.progressive) {
                if (!pick()) {
                    r.stop = 'logs-exhausted';
                    break;
                }
                if (s.sdk.getSkill(FIREMAKING)!.level < L.level) throw new Refusal('selected progressive Firemaking level drained');
            }
            r.stop = stopReason();
            if (r.stop) break;
            const want = packWant(held(L.id), inv().length, Math.min(o.maxLogs - r.logsBurnt, o.progressive ? o.batch! : Infinity));
            if (want > 0 && banked(L.id) > 0) await withdraw(L.id, Math.min(want, banked(L.id)));
            if (held(L.id) < 1) throw Error('pack has no logs after withdrawal');
            await closeBank();
            cursor = rowStart(row, site.rows);
            row++;
            const batchStart = r.logsBurnt;
            while (held(L.id) > 0 && (!o.progressive || r.logsBurnt - batchStart < o.batch!)) {
                r.stop = stopReason();
                if (r.stop) break;
                let i = nextFreeTile(tiles, cursor, blocked);
                for (let w = 0; i < 0 && w < TILE_WAIT_TICKS; w++) {
                    await waitTicks(s, 1);
                    live();
                    i = nextFreeTile(tiles, cursor, blocked);
                }
                if (i < 0) throw Error('no free line tile within the wait bound');
                const t = tiles[i]!;
                const p = pos();
                if (p.worldX !== t.x || p.worldZ !== t.z) await walk([{ x: t.x, z: t.z, tol: 0 }], `walk to line tile ${key(t)}`, 60);
                const gain = await light();
                if (gain === 'blocked') {
                    refused.set(key(t), s.tick() + 200);
                    cursor = i + 1;
                    continue;
                }
                r.logsBurnt++;
                r.xpPerLog ||= gain;
                if (gain !== r.xpPerLog) console.log('FIREMAKING_WARN ' + JSON.stringify({ event: 'xp-per-log-changed', gain, xpPerLog: r.xpPerLog }));
                cursor = i + 1;
                console.log('FIREMAKING_PROGRESS ' + JSON.stringify({ burns: r.logsBurnt, xp: xp(), level: base(), tick: s.tick(), x: t.x, z: t.z, ...(o.progressive ? { logId: L.id } : {}) }));
            }
            if (r.stop) break;
            await openBank();
            if (o.progressive && held(L.id) > 0) await deposit(L.id);
        }
        if (held(L.id) > 0) {
            await openBank();
            await deposit(L.id);
        }
        if (st()?.bank?.isOpen) await closeBank();
        r.ownedLogs = owned();
        if (r.stop === 'logs-exhausted' && o.burnOnly) r.shortfall = Math.max(0, o.maxLogs - r.logsBurnt);
        if (r.stop === 'logs-exhausted' && !o.burnOnly && base() < o.target) r.shortfall = logShortfall(o.target, xp(), r.xpPerLog, 0);
        r.ok = r.stop === 'target' || r.stop === 'max-logs';
        if (r.stop === 'logs-exhausted') r.failure = `log stock exhausted: shortfall ${r.shortfall} ${L.name}`;
        else if (r.stop === 'cap') r.failure = 'tick cap reached before target';
    } catch (e) {
        if (e instanceof Refusal) {
            r.stop = 'refused';
            r.refused = e.message;
        } else {
            r.stop ||= 'error';
            r.failure = String(e);
        }
    } finally {
        off();
    }
    r.level = base();
    r.xpGained = xp() - startXp;
    r.ticks = s.tick() - start;
    r.hpMin = hpMin;
    r.logsPer1kTicks = Number((r.logsBurnt * 1000 / Math.max(1, r.ticks)).toFixed(2));
    return r;
}

// ---- Multi-helper line firemaking (firemaking-line.ts) ----

export const BATCH = 28;
export const REVEAL_TICKS = 100;
export const DROP_LIFE_TICKS = 300;
export const LOG_XP: Readonly<Record<number, number>> = {
    [LOGS.normal.id]: 1000,
    [LOGS.oak.id]: 1500,
    [LOGS.willow.id]: 2250,
    [LOGS.maple.id]: 3375,
    [LOGS.yew.id]: 5062.5,
    [LOGS.magic.id]: 7595,
};
const LINE_TIERS = Object.values(LOGS);

export function planLine(xp: number, target: number, stock: Readonly<Record<number, number>>): number[] {
    const left: Record<number, number> = { ...stock };
    const out: number[] = [];
    while (xp < xpForLevel(target)) {
        const level = levelForXp(xp);
        const tier = [...LINE_TIERS].reverse().find(t => t.level <= level && (left[t.id] ?? 0) > 0);
        if (!tier) break;
        out.push(tier.id);
        left[tier.id]!--;
        xp += LOG_XP[tier.id]!;
    }
    return out;
}

export function batches(plan: readonly number[]): { from: number; ids: number[]; counts: Record<number, number> }[] {
    const out = [];
    for (let from = 0; from < plan.length; from += BATCH) {
        const ids = plan.slice(from, from + BATCH);
        const counts: Record<number, number> = {};
        for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
        out.push({ from, ids, counts });
    }
    return out;
}

export function assignBatches(work: readonly { counts: Record<number, number> }[], holds: readonly Record<number, number>[]): number[] | undefined {
    const left = holds.map(h => ({ ...h }));
    const out: number[] = [];
    for (let b = 0; b < work.length; b++) {
        const k = [...Array(left.length).keys()]
            .map(i => (b + i) % left.length)
            .find(i => Object.entries(work[b]!.counts).every(([id, n]) => (left[i]![Number(id)] ?? 0) >= n));
        if (k === undefined) return undefined;
        for (const [id, n] of Object.entries(work[b]!.counts)) left[k]![Number(id)]! -= n;
        out.push(k);
    }
    return out;
}

export const AHEAD_TICKS = 220;
export const mayDrop = (i: number, lit: number, ticksPerLog: number, previousDown: boolean) => previousDown && (i - lit) * Math.max(1, ticksPerLog) <= AHEAD_TICKS;

export function pace(lightTicks: readonly number[], window = 10): number {
    const t = lightTicks.slice(-window - 1);
    return t.length < 2 ? 8 : (t.at(-1)! - t[0]!) / (t.length - 1);
}

type LineTile = { x: number; z: number };
const LINE_TILES = lineTiles(BURN_ROWS);
const lineCount = (s: Session, id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const lineBanked = (s: Session, id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const lineAt = (s: Session) => { const p = s.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
const lineFireAt = (s: Session, t: LineTile) => (s.sdk.getState()?.nearbyLocs ?? []).some(l => l.x === t.x && l.z === t.z && /^fire$/i.test(l.name));
const lineGroundAt = (s: Session, t: LineTile, id?: number) => (s.sdk.getState()?.groundItems ?? []).some(g => g.x === t.x && g.z === t.z && (id === undefined || g.id === id));

export async function runFiremakingLineCli(
    runnerName: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
    const helperNames = args.filter(a => !/^[A-Z_]+=/.test(a));
    const target = Number(env.TARGET_LEVEL ?? 99);
    const cap = Number(env.CAP ?? 6000);
    if (!runnerName || !helperNames.length || !Number.isSafeInteger(target) || target < 2 || target > 99) {
        throw Error('usage: firemaking:line <runner> <helper> [helper ...]');
    }
    const stopFile = (n: string) => existsSync(`.practice/stop-${n}`) || existsSync('.practice/stop-all');
    const helpers: Session[] = [];
    let runner: Session | undefined;
    let stop = false;
    let failure = '';
    const fail = (why: string) => {
        if (!failure) failure = why;
        stop = true;
    };
    try {
        for (const n of helperNames) helpers.push(await openBot(n, { onStop: async (_s, why) => fail(`helper ${n}: ${why}`) }));
        const stock: Record<number, number> = {};
        const holds: Record<number, number>[] = [];
        for (const h of helpers) {
            await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 400 });
            if (!(await h.bot.openBank()).success || !await waitUntil(h, () => !!h.bankObservation?.(), { timeoutTicks: 20 })) {
                throw Error(`helper ${h.name}: bank did not open`);
            }
            for (const it of [...h.sdk.getInventory()]) if (h.sdk.getInventory().some(i => i.id === it.id)) await depositObserved(h, it);
            if (h.sdk.getInventory().length) throw Error(`helper ${h.name}: pack not empty after the deposit`);
            const mine: Record<number, number> = {};
            for (const t of LINE_TIERS) {
                mine[t.id] = lineBanked(h, t.id);
                stock[t.id] = (stock[t.id] ?? 0) + mine[t.id]!;
            }
            holds.push(mine);
        }
        const runnerXp = (() => {
            try {
                const statusPath = statusReadDirs(REPO_ROOT).map(dir => join(dir, `${runnerName}.json`)).find(p => existsSync(p))
                    ?? join(REPO_ROOT, `.practice/status/${runnerName}.json`);
                return Number(JSON.parse(readFileSync(statusPath, 'utf8')).skills.find((k: any) => k.name === 'Firemaking').xp) || 0;
            } catch {
                return 0;
            }
        })();
        const plan = planLine(runnerXp, target, stock);
        const work = batches(plan);
        if (!plan.length) throw Error(`no log in the helpers' stock that Firemaking ${levelForXp(runnerXp)} burns`);
        const owner = assignBatches(work, holds);
        if (!owner) throw Error('no helper holds a whole batch: move the logs so that each batch of 28 is in one bank');
        console.log('FM_LINE_PLAN ' + JSON.stringify({ stock, logs: plan.length, batches: work.length, endLevel: levelForXp(runnerXp + plan.reduce((n, id) => n + LOG_XP[id]!, 0)) }));
        const tileOf: (LineTile | undefined)[] = [];
        const droppedAt: number[] = [];
        const clock = () => helpers[0]!.tick();
        let cursor = 0;
        let lit = 0;
        let down = -1;
        const lightTicks: number[] = [];
        const nextTile = (h: Session) => {
            for (let k = 0; k < LINE_TILES.length; k++) {
                const t = LINE_TILES[cursor % LINE_TILES.length]!;
                cursor++;
                if (!lineFireAt(h, t) && !lineGroundAt(h, t)) return t;
            }
            return undefined;
        };
        const helperRun = async (h: Session, k: number) => {
            for (let b = 0; b < work.length && !stop; b++) {
                if (owner[b] !== k) continue;
                const batch = work[b]!;
                if (!h.sdk.getState()?.bank?.isOpen) {
                    await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 200 });
                    await h.bot.openBank();
                    await waitUntil(h, () => !!h.bankObservation?.(), { timeoutTicks: 20 });
                }
                for (const [id, n] of Object.entries(batch.counts)) {
                    const need = n - lineCount(h, Number(id));
                    const row = h.sdk.getState()?.bank?.items.find(i => i.id === Number(id));
                    if (need > 0 && (!row || !(await h.bot.withdrawItem(row, need, { asNote: false })).success || !await waitUntil(h, () => lineCount(h, Number(id)) >= n, { timeoutTicks: 10 }))) {
                        return fail(`helper ${h.name}: withdraw ${need} of ${id} for batch ${b}`);
                    }
                }
                await h.bot.closeBank();
                for (let j = 0; j < batch.ids.length && !stop; j++) {
                    while (!stop && !mayDrop(batch.from + j, lit, pace(lightTicks), down >= b - 1)) await waitTicks(h, 1);
                    if (stop) break;
                    const id = batch.ids[j]!;
                    const t = nextTile(h);
                    if (!t) return fail('no free line tile');
                    const w = await walkPath(await sessionWalker(h), [{ ...t, tol: 0 }], { maxTicks: 60, stop: () => stop });
                    if (!w.ok) return fail(`helper ${h.name}: walk to ${t.x},${t.z}`);
                    const slot = h.sdk.getInventory().find(i => i.id === id)?.slot;
                    const n0 = lineCount(h, id);
                    if (slot === undefined) return fail(`helper ${h.name}: no log ${id} in the pack`);
                    await h.direct({ type: 'dropItem', slot, reason: 'SDK' });
                    if (!await waitUntil(h, () => lineCount(h, id) < n0, { timeoutTicks: 6 })) return fail(`helper ${h.name}: drop at ${t.x},${t.z} unobserved`);
                    tileOf[batch.from + j] = t;
                    droppedAt[batch.from + j] = clock();
                }
                down = Math.max(down, b);
            }
            await walkPath(await sessionWalker(h), [{ ...DRAYNOR_BANK, tol: 2 }], { maxTicks: 200 });
            if ((await h.bot.openBank()).success) {
                for (const t of LINE_TIERS) {
                    const it = h.sdk.getInventory().find(i => i.id === t.id);
                    if (it) await depositObserved(h, it);
                }
            }
        };
        const loops = helpers.map((h, k) => helperRun(h, k).catch(e => fail(`helper ${h.name}: ${String(e)}`)));
        const first = helpers[0]!;
        while (!stop && (droppedAt[0] === undefined || clock() - droppedAt[0] < REVEAL_TICKS - 5)) await waitTicks(first, 1);
        if (stop) throw Error(failure);
        runner = await openBot(runnerName, { onStop: async (_s, why) => fail(`runner: ${why}`) });
        const r = runner;
        const start = r.tick();
        const xp = () => r.sdk.getSkillXp('Firemaking') ?? 0;
        const level = () => r.sdk.getSkill('Firemaking')?.baseLevel ?? 0;
        if (!await waitUntil(r, () => !!r.sdk.getState()?.player && r.sdk.getSkillXp('Firemaking') !== null, { timeoutTicks: 20 })) {
            throw Error('runner state unobserved');
        }
        if (lineCount(r, TINDERBOX) < 1) throw Error('runner has no tinderbox in the pack');
        const startXp = xp();
        if (startXp !== runnerXp) console.log(`FM_LINE_WARN runner XP ${startXp}, plan from ${runnerXp}`);
        let waited = 0;
        let retries = 0;
        let lost = 0;
        for (let i = 0; i < plan.length && level() < target && !stop; i++) {
            if (r.tick() - start >= cap) { fail('cap'); break; }
            if (stopFile(runnerName)) { fail('stop file'); break; }
            const id = plan[i]!;
            const w0 = r.tick();
            const halt = () => (r.tick() - start >= cap ? 'cap' : stopFile(runnerName) ? 'stop file' : '');
            while (!stop && !halt() && (!tileOf[i] || !lineGroundAt(r, tileOf[i]!, id))) {
                const t = tileOf[i];
                if (t && clock() - droppedAt[i]! > DROP_LIFE_TICKS + 20) break;
                if (t) {
                    const p = lineAt(r);
                    if (Math.max(Math.abs(p.x - t.x), Math.abs(p.z - t.z)) > 8) {
                        await walkPath(await sessionWalker(r), [{ ...t, tol: 2 }], { maxTicks: 40, stop: () => stop });
                    }
                }
                await waitTicks(r, 1);
            }
            if (halt()) { fail(halt()); break; }
            waited += r.tick() - w0;
            const t = tileOf[i];
            if (!t || !lineGroundAt(r, t, id)) {
                lit = i + 1;
                lost++;
                console.log(`FM_LINE_WARN log ${i} (${id}) at ${t ? `${t.x},${t.z}` : 'no tile'} not seen`);
                continue;
            }
            const before = xp();
            let sent = r.tick();
            const refused = () => (r.sdk.getState()?.gameMessages ?? []).some(m => m.tick >= sent && /can't light a fire here/i.test(m.text));
            for (let tries = 0; tries < 30 && !stop && lineGroundAt(r, t, id) && xp() === before; tries++) {
                sent = r.tick();
                await r.direct({ type: 'interactGroundItem', x: t.x, z: t.z, itemId: id, optionIndex: 4, reason: 'SDK' });
                await waitUntil(r, () => xp() > before || !lineGroundAt(r, t, id) || refused(), { timeoutTicks: 6 });
                if (refused()) break;
                if (xp() === before && lineGroundAt(r, t, id)) retries++;
            }
            lit = i + 1;
            if (xp() > before) lightTicks.push(r.tick());
            if (xp() === before) {
                lost++;
                console.log(`FM_LINE_WARN log ${i} at ${t.x},${t.z} not lit`);
            }
        }
        stop = true;
        await Promise.race([Promise.all(loops), waitTicks(r, 60)]);
        const out = { ok: level() >= target, level: level(), xp: xp() - startXp, lit, lost, retries, waited, ticks: r.tick() - start, failure };
        console.log('FM_LINE_RESULT ' + JSON.stringify(out));
        await finish([r, ...helpers], out.ok, `firemaking-line level=${out.level} target=${target} lit=${lit} lost=${lost} waited=${waited} ticks=${out.ticks}${failure ? ` failure=${failure}` : ''}`);
        return out.ok ? 0 : 1;
    } catch (e) {
        stop = true;
        await finish([...(runner ? [runner] : []), ...helpers], false, String(e));
        return 1;
    }
}

// ---- Varrock GE regular-fire loop (microbot-ge-firemaking.ts) ----

export const NATIVE_GE_FIREMAKING_SITE: FiremakingSite = {
    name: 'Native GE / Varrock',
    bank: { x: 3185, z: 3436 },
    rows: [{ z: 3431, sx: 3193, ex: 3167 }, { z: 3456, sx: 3180, ex: 3154 }],
    localEntry: true,
};

export function geFiremakingOptions(env: Record<string, string | undefined> = process.env): FiremakingOptions {
    if (
        (env.BURN_ONLY !== undefined && env.BURN_ONLY !== '1')
        || (env.PROGRESSIVE !== undefined && env.PROGRESSIVE !== '0')
        || (env.TOOL_BUDGET !== undefined && Number(env.TOOL_BUDGET) !== 0)
    ) {
        throw Error('GE regular-fire consumer requires finite owned fixed-log burn-only with no purchases');
    }
    const o = firemakingOptions({ ...env, BURN_ONLY: '1', TARGET_LEVEL: '99', MAX_LOGS: env.MAX_LOGS ?? '54', CAP: env.CAP ?? '4000', TOOL_BUDGET: '0' });
    validateGeFiremakingOptions(o);
    return o;
}

export function validateGeFiremakingOptions(o: FiremakingOptions) {
    if (
        !o
        || o.burnOnly !== true
        || o.progressive
        || o.toolBudget !== 0
        || !Object.hasOwn(LOGS, o.log)
        || !Number.isSafeInteger(o.maxLogs)
        || o.maxLogs < 1
        || o.maxLogs > 1000
        || !Number.isSafeInteger(o.cap)
        || o.cap < 120
        || o.cap > 20000
        || !Number.isSafeInteger(o.target)
        || o.target < 2
        || o.target > 99
        || !Number.isSafeInteger(o.cashReserve)
        || o.cashReserve < 0
        || o.cashReserve > 2000000000
    ) {
        throw Error('invalid finite native GE firemaking options');
    }
    return o;
}

export const geFiremakingStop = (name: string, stop: () => boolean = () => false, exists: (p: string) => boolean = existsSync) =>
    productionStopRequested(name, stop, exists) || exists('.practice/stop-microbot-ge-firemaking');

export async function runGeFiremaking(
    original: Session,
    value: FiremakingOptions,
    stop: () => boolean = () => false,
    worker: typeof runFiremaking = runFiremaking,
) {
    const o = validateGeFiremakingOptions(value);
    const client = original.client as any;
    const owner = client.executeBotAction;
    const first = original.sdk.getState()?.player;
    const life = first?.lifeId;
    const respawns = first?.respawnCount ?? 0;
    const hp = original.sdk.getSkill('Hitpoints')?.level ?? 0;
    const start = original.tick();
    let ended = false;
    void original.ended?.then(() => { ended = true; });
    const controls = () =>
        JSON.stringify({
            gear: original.sdk.getEquipment().map(({ id, slot, count }) => ({ id, slot, count })),
            style: original.sdk.getState()?.combatStyle,
            retaliate: original.sdk.getState()?.autoRetaliateEnabled,
            prayers: original.sdk.getState()?.prayers.activePrayers,
        });
    const initialControls = controls();
    const guard = () => {
        const p = original.sdk.getState()?.player;
        if (
            geFiremakingStop(original.name, stop)
            || ended
            || original.client !== client
            || client.executeBotAction !== owner
            || typeof owner !== 'function'
            || !p
            || p.isDead
            || !Number.isSafeInteger(life)
            || p.lifeId !== life
            || (p.respawnCount ?? 0) !== respawns
            || p.level !== 0
            || (original.sdk.getSkill('Hitpoints')?.level ?? 0) < hp
            || original.sdk.getStateAge() > 5000
            || original.tick() - start >= o.cap
        ) {
            throw Error('native GE firemaking original owner/life/HP/stop/cap');
        }
    };
    guard();
    if (!first || first.level !== 0 || Math.max(Math.abs(first.worldX - 3181), Math.abs(first.worldZ - 3443)) > 32) {
        throw Error('stage observed native GE/Varrock bank area');
    }
    const sdk = new Proxy(original.sdk, {
        get(t, k, r) {
            const v = Reflect.get(t, k, r);
            return typeof v === 'function'
                ? function (this: unknown, ...a: unknown[]) {
                    if (typeof k === 'string' && k.startsWith('send')) guard();
                    return v.apply(r, a);
                }
                : v;
        },
    });
    const s = { ...original, sdk, bot: new BotActions(sdk), direct: (a: Parameters<Session['direct']>[0]) => { guard(); return original.direct(a); } } as Session;
    const result = await worker(s, o, NATIVE_GE_FIREMAKING_SITE);
    const p = original.sdk.getState()?.player;
    const atBank = !!p && p.level === 0 && Math.max(Math.abs(p.worldX - NATIVE_GE_FIREMAKING_SITE.bank.x), Math.abs(p.worldZ - NATIVE_GE_FIREMAKING_SITE.bank.z)) <= 3;
    const controlsPreserved = controls() === initialControls;
    return {
        ...result,
        ok: result.ok && atBank && controlsPreserved && original.client === client && client.executeBotAction === owner && !ended && p?.lifeId === life && (p?.respawnCount ?? 0) === respawns && !geFiremakingStop(original.name, stop),
        atBank,
        controlsPreserved,
        site: NATIVE_GE_FIREMAKING_SITE.name,
        scope: 'finite owned native regular fires and existing bank/refill; no bonfire feeding, modern GE quadrant parity, purchases or live qualification',
    };
}

export async function runFiremakingCli(
    method: string,
    account: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    stopFlag?: () => boolean,
): Promise<number> {
    if (method === 'line') {
        return runFiremakingLineCli(account, args, env);
    }
    if (method === 'order') {
        let s: Session | undefined;
        try {
            if (!account || !/^[a-z0-9]{1,12}$/i.test(account)) throw Error('usage: firemaking:order <account>');
            const o = firemakingOptions(env);
            s = await openBot(account);
            const r = await runFiremaking(s, o);
            console.log('FIREMAKING_ORDER_RESULT ' + JSON.stringify(r));
            await finish([s], r.ok, `firemaking-order stop=${r.stop} level=${r.level} target=${r.target} logs=${r.logsBurnt} xp=${r.xpGained}${r.refused ? ` refused: ${r.refused}` : ''}${r.failure ? ` failure: ${r.failure}` : ''}`);
            return r.ok ? 0 : 1;
        } catch (error) {
            await finish(s ? [s] : [], false, String(error));
            return 1;
        }
    }
    if (method === 'ge') {
        if (!account || !/^[a-z0-9]{1,12}$/i.test(account)) throw Error('usage: firemaking:ge <actor> (LOG/MAX_LOGS/CAP)');
        const o = geFiremakingOptions(env);
        let stop = false;
        const s = await openBot(account);
        let ok = false;
        try {
            const r = await runGeFiremaking(s, o, () => stop || !!stopFlag?.());
            console.log('GE_FIREMAKING_RESULT ' + JSON.stringify(r));
            ok = r.ok;
        } finally {
            ok = await settle([s], ok, 'finite native GE regular-fire bank route');
        }
        return ok ? 0 : 1;
    }
    throw Error(`unknown firemaking method: ${method}`);
}
