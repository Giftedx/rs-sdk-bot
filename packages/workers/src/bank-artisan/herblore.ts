// Unified herblore worker combining brew-potions and druid-meats.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { accountOf, finish, getWorld, openBot, sessionDied } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import { sellersByDistance } from '../../../core/src/shop-index';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo } from '../../../core/src/walk';
import type { Tile } from '../../../core/src/world';
import { abortable, executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';
import { KNOWLEDGE_DIR } from './catalog';
import { nearestBank, productionStopRequested } from './runtime';
import type { Session } from './types';

const OPEN_OP_RE = /^open$/i;
const CLIMB_DOWN_RE = /^climb-down$/i;
const ROUTE_FAILED_SPAWN_RE = /^route-failed \d+,\d+: no route to \d+,\d+,0( within \d+-tile hops)?$/;

// ---- Brew Potions (brew-potions.ts) ----

export async function boundedHerbloreMove(
    s: Session,
    move: (signal: AbortSignal) => ReturnType<typeof goTo>,
    timeoutTicks: number,
): ReturnType<typeof goTo> {
    const start = s.tick();
    const controller = new AbortController();
    const deadline = Error(`travel exceeded ${timeoutTicks} ticks`);
    const parent = executionContext.getStore();
    const signal = parent ? AbortSignal.any([parent.signal, controller.signal]) : controller.signal;
    const timer = waitUntil(s, () => false, { timeoutTicks, signal: controller.signal }).then(() => {
        if (!controller.signal.aborted) controller.abort(deadline);
    });
    void timer.catch(error => controller.abort(error));
    try {
        return await executionContext.run({ ...parent, signal }, () => abortable(move(signal)));
    } catch (error) {
        if (error === deadline) return { ok: false, reason: 'timeout', detail: deadline.message, ticks: s.tick() - start };
        throw error;
    } finally {
        controller.abort('travel settled');
        await timer.catch(() => {});
    }
}

export function tracedWalker<T extends Pick<Session, 'direct' | 'bot'>>(s: T) {
    let sent = 0;
    const walker = Object.create(s) as T;
    walker.direct = action => {
        sent++;
        return s.direct(action);
    };
    walker.bot = new Proxy(s.bot, {
        get(target, key) {
            const value = Reflect.get(target, key);
            return typeof value === 'function'
                ? (...args: unknown[]) => {
                      sent++;
                      return value.apply(target, args);
                  }
                : value;
        },
    });
    return { walker, sent: () => sent };
}

export async function observeHerbloreStep<T>(
    step: string,
    s: Pick<Session, 'tick' | 'sdk'>,
    action: () => Promise<T>,
    log: (line: string) => void = console.log,
): Promise<T> {
    const report = (phase: string, error?: string) => {
        const state = s.sdk.getState();
        const p = state?.player;
        log(
            `HERBLORE_STEP ${JSON.stringify({
                step,
                phase,
                tick: s.tick(),
                position: p ? { x: p.worldX, z: p.worldZ, level: p.level } : null,
                bank: state?.bank?.isOpen,
                interface: state?.interface?.isOpen,
                coins: s.sdk.getInventory().filter(i => i.id === 995).reduce((n, i) => n + i.count, 0),
                error,
            })}`,
        );
    };
    report('enter');
    try {
        const result = await action();
        report('return');
        return result;
    } catch (error) {
        report('throw', String(error));
        throw error;
    }
}

export async function reachSeller(
    item: string,
    at: Tile,
    reach: (tile: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }>,
) {
    const sellers = sellersByDistance(item, at);
    let detail = 'no stocked sellers on this level';
    for (const seller of sellers) {
        const result = await reach(seller.tile);
        if (result.ok) return seller;
        detail = `${seller.npc} at ${seller.tile.x},${seller.tile.z},${seller.tile.level}: ${result.reason} ${result.detail}`;
    }
    throw Error(`no reachable seller for ${item} (${sellers.length} tried): ${detail}`);
}

type Stock = Record<number, number>;
export type BrewRecipe = { key: string; level: number; dirty: number; clean: number; unf: number; sec: number; pot: number };

export const RECIPES: Record<string, BrewRecipe> = Object.fromEntries(
    [
        ['attack', 3, 199, 249, 91, 221, 121],
        ['antipoison', 5, 201, 251, 93, 235, 175],
        ['strength', 12, 203, 253, 95, 225, 115],
        ['fishing', 50, 211, 261, 103, 231, 151],
        ['magic', 76, 2485, 2481, 2483, 3138, 3042],
        ['ranging', 72, 217, 267, 109, 245, 169],
        ['energy', 26, 205, 255, 97, 1975, 3010],
        ['prayer', 38, 207, 257, 99, 231, 139],
        ['super_attack', 45, 209, 259, 101, 221, 145],
        ['super_str', 55, 213, 263, 105, 225, 157],
        ['super_def', 66, 215, 265, 107, 239, 163],
    ].map(([key, level, dirty, clean, unf, sec, pot]) => [key, { key, level, dirty, clean, unf, sec, pot }]),
) as Record<string, BrewRecipe>;

const RECIPES_BY_LEVEL_DESC: readonly BrewRecipe[] = Object.values(RECIPES).sort((a, b) => b.level - a.level);

export function selectRecipe(level: number, stock: Stock, key = 'auto'): BrewRecipe {
    if (key !== 'auto' && key !== 'unf') {
        const r = RECIPES[key];
        if (r && r.level <= level && ((stock[r.dirty] ?? 0) > 0 || (stock[r.clean] ?? 0) > 0 || (stock[r.unf] ?? 0) > 0)) {
            return r;
        }
        throw Error(`herbs missing: no usable owned herbs or unfinished potions for ${key} at level ${level}`);
    }
    for (let i = 0; i < RECIPES_BY_LEVEL_DESC.length; i++) {
        const r = RECIPES_BY_LEVEL_DESC[i]!;
        if (r.level <= level && ((stock[r.dirty] ?? 0) > 0 || (stock[r.clean] ?? 0) > 0 || (stock[r.unf] ?? 0) > 0)) {
            return r;
        }
    }
    throw Error(`herbs missing: no usable owned herbs or unfinished potions for ${key} at level ${level}`);
}

export function supplyPlan(herbs: number, vials: number, eyes: number, coins: number, vialBudget: number, eyeBudget: number) {
    const v = Math.max(0, herbs - vials);
    const e = Math.max(0, herbs - eyes);
    if (v * 4 > vialBudget) throw Error('vial budget cannot cover shortfall');
    if (e * 3 > eyeBudget) throw Error('secondary budget cannot cover shortfall');
    const reserve = v * 4 + e * 3;
    if (reserve > coins) throw Error('owned coins cannot cover supply shortfall');
    return { vials: v, eyes: e, reserve };
}

export const workingBatch = (herbs: number, unf: number, secondaries: number) => Math.min(27, herbs + unf, secondaries);

export function brewTripPlan(r: BrewRecipe, bankStock: Stock, mode: string): { input: number; count: number; needsVial: boolean; needsSec: boolean } {
    if (mode === 'unf') {
        const input = (bankStock[r.clean] ?? 0) > 0 ? r.clean : r.dirty;
        return { input, count: Math.min(14, bankStock[input] ?? 0, bankStock[227] ?? 0), needsVial: true, needsSec: false };
    }
    if ((bankStock[r.unf] ?? 0) > 0) {
        return { input: r.unf, count: Math.min(14, bankStock[r.unf] ?? 0, bankStock[r.sec] ?? 0), needsVial: false, needsSec: true };
    }
    const input = (bankStock[r.clean] ?? 0) > 0 ? r.clean : r.dirty;
    return { input, count: Math.min(9, bankStock[input] ?? 0, bankStock[227] ?? 0, bankStock[r.sec] ?? 0), needsVial: true, needsSec: true };
}

export function supplyPurchases(o: { batch: number; make: number; vials: number; eyes: number; buyEyes: boolean }): [227 | 221, number][] {
    if (!(o.make > 0 && o.vials < 1) && !(o.buyEyes && o.eyes < 1)) return [];
    return (
        [
            [221, o.buyEyes ? Math.max(0, o.batch - o.eyes) : 0],
            [227, Math.max(0, o.make - o.vials)],
        ] as [227 | 221, number][]
    ).filter(([, n]) => n > 0);
}

export function reconcile(before: Stock, after: Stock, delta: Stock) {
    for (const k in before) {
        const id = +k;
        if ((after[id] ?? 0) !== (before[id] ?? 0) + (delta[id] ?? 0)) return false;
    }
    for (const k in after) {
        if (k in before) continue;
        const id = +k;
        if ((after[id] ?? 0) !== (delta[id] ?? 0)) return false;
    }
    for (const k in delta) {
        if (k in before || k in after) continue;
        if ((delta[+k] ?? 0) !== 0) return false;
    }
    return true;
}

export function herbloreOptions(args: string[], env: Record<string, string | undefined> = process.env) {
    const [name, capArg, recipeArg] = args;
    const cap = Number(capArg ?? env.CAP ?? 15000);
    const target = Number(env.TARGET_LEVEL ?? 50);
    const vialBudget = Number(env.VIAL_BUDGET ?? 1000);
    const secondaryBudget = Number(env.SECONDARY_BUDGET ?? 1000);
    const recipe = (recipeArg ?? env.RECIPE ?? 'auto').toLowerCase();
    if (
        !name ||
        !Number.isSafeInteger(cap) ||
        cap <= 0 ||
        !Number.isInteger(target) ||
        target < 1 ||
        target > 99 ||
        ![vialBudget, secondaryBudget].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000) ||
        !['auto', 'unf', ...Object.keys(RECIPES)].includes(recipe)
    ) {
        throw Error('invalid account, CAP, TARGET_LEVEL, recipe or budgets (0..1000 coins)');
    }
    return { name, cap, target, recipe, vialBudget, secondaryBudget };
}

const stockMap = (rows: { id: number; count: number }[]) =>
    rows.reduce<Stock>((out, i) => {
        out[i.id] = (out[i.id] ?? 0) + i.count;
        return out;
    }, {});

export async function brew(s: Session, o: ReturnType<typeof herbloreOptions> & { stop?: () => boolean }) {
    const start = s.tick();
    const world = await getWorld();
    const delta: Stock = {};
    const spent: Stock = { 227: 0, 221: 0 };
    let brewed = 0;
    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const inv = () => s.sdk.getInventory();
    const held = (id: number) => stockMap(inv())[id] ?? 0;
    const bankRows = () => s.sdk.getBankItems();
    const totals = () => stockMap([...inv(), ...bankRows()]);
    const here = () => {
        const p = s.sdk.getState()!.player!;
        return { x: p.worldX, z: p.worldZ, level: p.level };
    };
    const level = () => s.sdk.getSkill('Herblore')!.baseLevel;
    const check = () => {
        if (ended || productionStopRequested(s.name, o.stop)) throw Error('herblore stopped');
        if (s.tick() - start >= o.cap) throw Error(`CAP ${o.cap} reached`);
    };
    const observed = async (pred: () => boolean, detail: string) => {
        check();
        if (!await waitUntil(s, pred, { timeoutTicks: Math.min(15, Math.max(1, o.cap - (s.tick() - start))) })) throw Error(`${detail} unobserved`);
        check();
    };
    const add = (id: number, n: number) => {
        delta[id] = (delta[id] ?? 0) + n;
    };
    const attemptMove = async (to: Tile) => {
        check();
        const coins = totals()[995] ?? 0;
        const from = here();
        const trace = tracedWalker(s);
        let r: Awaited<ReturnType<typeof goTo>> | undefined;
        try {
            r = await boundedHerbloreMove(
                s,
                signal => goTo(trace.walker, world, to, accountOf(s), { legTimeoutTicks: 100, signal }),
                Math.min(300, o.cap - (s.tick() - start)),
            );
            check();
            return r;
        } finally {
            const change = (totals()[995] ?? 0) - coins;
            add(995, change);
            const doors = (s.sdk.getState()?.nearbyLocs ?? [])
                .filter(l => (l.options ?? []).some(x => /^open$/i.test(x)))
                .slice(0, 8)
                .map(l => `${l.name} ${l.x},${l.z}`);
            console.log(`HERBLORE_TRAVEL ${JSON.stringify({ to, coins: change, from, at: here(), result: r, sent: trace.sent(), doors })}`);
        }
    };
    const move = async (to: Tile) => {
        const r = await attemptMove(to);
        if (!r.ok) throw Error(`travel failed: ${r.reason} ${r.detail}`);
    };
    const openBank = async () => {
        check();
        if (!(await s.bot.openBank()).success) {
            await move(nearestBank(here()));
            if (!(await s.bot.openBank()).success) throw Error('bank unavailable');
        }
        await observed(() => s.sdk.isBankOpen(), 'bank');
    };
    const deposit = async () => {
        for (const id of new Set(inv().map(i => i.id))) {
            check();
            const row = inv().find(i => i.id === id)!;
            const n = held(id);
            const b = stockMap(bankRows())[id] ?? 0;
            await s.bot.depositItem(row, -1);
            await observed(() => held(id) === 0 && (stockMap(bankRows())[id] ?? 0) === b + n, `deposit ${id}`);
        }
    };
    const withdraw = async (id: number, n: number) => {
        const row = bankRows().find(i => i.id === id);
        if (!row || row.count < n) throw Error(`bank missing ${id}:${n}`);
        const b = held(id);
        await s.bot.withdrawItem(row, n);
        await observed(() => held(id) === b + n, `withdraw ${id}`);
    };
    const combine = async (a: number, b: number, c: number) => {
        const aa = held(a);
        const bb = held(b);
        const cc = held(c);
        check();
        await s.sdk.sendUseItemOnItem(inv().find(i => i.id === a)!.slot, inv().find(i => i.id === b)!.slot);
        await observed(() => held(a) === aa - 1 && held(b) === bb - 1 && held(c) === cc + 1, `mix ${a}+${b}->${c}`);
        add(a, -1);
        add(b, -1);
        add(c, 1);
    };
    const buy = async (id: 227 | 221, n: number) => {
        if (n <= 0) return;
        const startingSpend = spent[id] ?? 0;
        const budget = (id === 227 ? o.vialBudget : o.secondaryBudget) - startingSpend;
        if (n * (id === 227 ? 4 : 3) > budget) throw Error(`${id === 227 ? 'vial' : 'secondary'} budget cannot cover shortfall`);
        const step = <T>(name: string, action: () => Promise<T>) => observeHerbloreStep(`buy ${id}: ${name}`, s, action);
        await step('withdraw coins', () => withdraw(995, Math.min(totals()[995] ?? 0, budget)));
        await step('close bank', () => s.bot.closeBank());
        const seller = await step('reach seller', () =>
            reachSeller(id === 227 ? 'vial_water' : 'eye_of_newt', here(), tile => step(`goTo ${tile.x},${tile.z},${tile.level}`, () => attemptMove(tile))),
        );
        const npc = s.sdk.getState()?.nearbyNpcs.find(x => x.id === seller.npcId);
        if (!npc || !(await s.bot.openShop(npc)).success) throw Error(`shop unavailable: ${seller.npc}`);
        await observed(() => !!s.sdk.getState()?.shop?.isOpen, 'shop');
        for (let bought = 0; bought < n; bought++) {
            check();
            const row = s.sdk.getState()?.shop?.shopItems.find(i => i.id === id);
            const coins = held(995);
            const before = held(id);
            const left = budget - ((spent[id] ?? 0) - startingSpend);
            if (!row || row.count < 1) throw Error(`shop ${seller.npc} out of stock ${id}`);
            if (!Number.isSafeInteger(row.buyPrice) || row.buyPrice < 0 || row.buyPrice > left || row.buyPrice > coins) {
                throw Error(`${id === 227 ? 'vial' : 'secondary'} budget or coins exhausted`);
            }
            await s.bot.buyFromShop(row, 1);
            await observed(() => held(id) === before + 1 && held(995) <= coins, 'purchase');
            const cost = coins - held(995);
            if (cost > left) throw Error('shop exceeded quoted budget');
            spent[id] = (spent[id] ?? 0) + cost;
            add(id, 1);
            add(995, -cost);
            console.log(`HERBLORE_BUY ${JSON.stringify({ id, count: 1, cost, seller: seller.npc, shop: seller.shop })}`);
        }
        await step('close shop', () => s.bot.closeShop());
        await step('open bank', openBank);
        await step('deposit', deposit);
    };
    await observed(() => !!s.sdk.getState()?.player && !!s.sdk.getSkill('Herblore'), 'entry');
    await openBank();
    const before = totals();
    const xp = s.sdk.getSkillXp('Herblore')!;
    const worn = JSON.stringify(s.sdk.getState()?.equipment ?? []);
    await deposit();
    try {
        if (level() >= o.target) throw Error(`target already met: ${level()} >= ${o.target}`);
        while (level() < o.target) {
            check();
            const r = selectRecipe(level(), totals(), o.recipe);
            const all = totals();
            const herbs = (all[r.dirty] ?? 0) + (all[r.clean] ?? 0);
            const unf = all[r.unf] ?? 0;
            const secondaries = r.sec === 221 || o.recipe === 'unf' ? 27 : (all[r.sec] ?? 0);
            const batch = workingBatch(herbs, unf, secondaries);
            const make = Math.max(0, batch - Math.min(batch, unf));
            const purchases = supplyPurchases({ batch, make, vials: all[227] ?? 0, eyes: all[221] ?? 0, buyEyes: r.sec === 221 && o.recipe !== 'unf' });
            if (purchases.length) {
                supplyPlan(make, all[227] ?? 0, r.sec === 221 ? Math.max(0, (all[221] ?? 0) - Math.min(unf, batch)) : make, all[995] ?? 0, o.vialBudget - (spent[227] ?? 0), o.secondaryBudget - (spent[221] ?? 0));
            }
            if (secondaries < 1) throw Error(`secondary missing ${r.sec}`);
            for (const [id, n] of purchases) await buy(id, n);
            const current = stockMap(bankRows());
            const plan = brewTripPlan(r, current, o.recipe);
            const input = plan.input;
            const n = plan.count;
            if (n < 1) throw Error(`bank missing supplies for ${r.key}`);
            await withdraw(input, n);
            if (plan.needsVial) await withdraw(227, n);
            if (plan.needsSec) await withdraw(r.sec, n);
            await s.bot.closeBank();
            if (input === r.dirty) {
                while (held(r.dirty) > 0 && level() < o.target) {
                    check();
                    const d0 = held(r.dirty);
                    const c0 = held(r.clean);
                    await s.sdk.sendUseItem(inv().find(i => i.id === r.dirty)!.slot, 1);
                    await observed(() => held(r.dirty) === d0 - 1 && held(r.clean) === c0 + 1, `clean ${r.dirty}`);
                    add(r.dirty, -1);
                    add(r.clean, 1);
                }
            }
            if (plan.needsVial) {
                while (held(r.clean) > 0 && held(227) > 0 && level() < o.target) await combine(r.clean, 227, r.unf);
            }
            if (plan.needsSec) {
                while (held(r.unf) > 0 && held(r.sec) > 0 && level() < o.target) {
                    await combine(r.unf, r.sec, r.pot);
                    brewed++;
                }
            }
            await openBank();
            await deposit();
            if (o.recipe === 'unf') throw Error('unfinished-only output does not meet a Herblore target');
        }
        const after = totals();
        const assets = reconcile(before, after, delta);
        const gained = s.sdk.getSkillXp('Herblore')! - xp;
        const equipment = worn === JSON.stringify(s.sdk.getState()?.equipment ?? []);
        const result = { ok: level() >= o.target && brewed > 0 && gained > 0 && assets && equipment, target: o.target, level: level(), brewed, xp: gained, ticks: s.tick() - start, before, after, delta, spent, assets, equipment };
        console.log(`HERBLORE_RESULT ${JSON.stringify(result)}`);
        if (!result.ok) throw Error('target, XP or asset reconciliation failed');
        return result;
    } catch (e) {
        if (s.sdk.isBankOpen()) await deposit();
        console.log(`HERBLORE_REFUSAL ${JSON.stringify({ reason: String(e), assets: reconcile(before, totals(), delta), delta, spent })}`);
        throw e;
    }
}

// ---- Druidic Ritual Meats (druid-meats.ts) ----

export const MEATS = [
    { item: 2132, npc: 81, x: 2660, z: 3344, name: 'raw beef' },
    { item: 2134, npc: 86, x: 2517, z: 3184, name: 'raw rat meat' },
    { item: 2136, npc: 105, x: 3159, z: 3233, name: 'raw bear meat' },
    { item: 2138, npc: 41, x: 2691, z: 3273, name: 'raw chicken' },
] as const;

type Meat = Omit<(typeof MEATS)[number], 'x' | 'z'> & { x: number; z: number };

const DRAYNOR_MEATS: readonly Meat[] = MEATS.map(m => ({
    ...m,
    ...{ 2132: { x: 3154, z: 3325 }, 2134: { x: 3192, z: 3207 }, 2136: { x: 3159, z: 3233 }, 2138: { x: 3185, z: 3277 } }[m.item],
}));

type SpawnBox = readonly [number, number, number, number];
export const BEAR_SPAWNS = [
    [2691, 3341],
    [2692, 3333],
    [2484, 3155],
    [2477, 3143],
    [3159, 3233],
    [3176, 3223],
    [3230, 3500],
] as const;

const cheb = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
export const STALL_TICKS = 20;
export const HOP = 150;

const MEAT_BANKS = [
    { x: 2619, z: 3332 },
    { x: 2654, z: 3283 },
    { x: 2612, z: 3093 },
    { x: 3092, z: 3243 },
] as const;
const HUBS = [...MEAT_BANKS, ...MEATS.filter(m => m.npc !== 105).map(({ x, z }) => ({ x, z })), ...DRAYNOR_MEATS.map(({ x, z }) => ({ x, z }))];

export function waypointChain(from: { x: number; z: number }, to: { x: number; z: number }, hubs: readonly { x: number; z: number }[] = HUBS, hop = HOP) {
    const nodes = [...hubs, to];
    const dist = nodes.map(n => (cheb(from, n) <= hop ? cheb(from, n) : Infinity));
    const prev = nodes.map(() => -1);
    const done = nodes.map(() => false);
    for (;;) {
        let i = -1;
        for (let k = 0; k < nodes.length; k++) if (!done[k] && dist[k]! < Infinity && (i < 0 || dist[k]! < dist[i]!)) i = k;
        if (i < 0) return null;
        if (i === nodes.length - 1) {
            const chain: { x: number; z: number }[] = [];
            for (let k = i; k >= 0; k = prev[k]!) chain.unshift(nodes[k]!);
            return chain;
        }
        done[i] = true;
        for (let k = 0; k < nodes.length; k++) {
            const d = cheb(nodes[i]!, nodes[k]!);
            if (!done[k] && d <= hop && dist[i]! + d < dist[k]!) {
                dist[k] = dist[i]! + d;
                prev[k] = i;
            }
        }
    }
}

const boxDistance = (x: number, z: number, [x1, z1, x2, z2]: SpawnBox) => Math.max(x1 - x, 0, x - x2, z1 - z, 0, z - z2);

function spawnApproaches(m: Meat, x: number, z: number) {
    const boxes: readonly SpawnBox[] = [[m.x, m.z, m.x, m.z]];
    return [...boxes]
        .sort((a, b) => boxDistance(x, z, a) - boxDistance(x, z, b))
        .flatMap(box => {
            const [x1, z1, x2, z2] = box;
            const tiles: { x: number; z: number }[] = [];
            for (let tx = x1 - 1; tx <= x2 + 1; tx++) for (let tz = z1 - 1; tz <= z2 + 1; tz++) tiles.push({ x: tx, z: tz });
            tiles.sort((a, b) => Math.max(Math.abs(a.x - x), Math.abs(a.z - z)) - Math.max(Math.abs(b.x - x), Math.abs(b.z - z)));
            const ordered = m.x >= x1 && m.x <= x2 && m.z >= z1 && m.z <= z2 ? [{ x: m.x, z: m.z }, ...tiles.filter(t => t.x !== m.x || t.z !== m.z)] : tiles;
            return ordered.map(tile => ({ ...tile, box }));
        });
}

type Item = { id: number; count: number };
const countList = (items: readonly Item[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
export const missingMeats = (pack: readonly Item[], bank: readonly Item[]) => MEATS.filter(m => countList(pack, m.item) + countList(bank, m.item) < 1);

export function bearRefusal(hp: number, attack: number, strength: number, defence: number) {
    return [hp, attack, strength, defence].every(Number.isFinite) && hp >= 60 && attack >= 40 && strength >= 40 && defence >= 40
        ? null
        : 'too-weak-for-bear: requires current HP60, Attack40, Strength40, Defence40';
}

type Floor = { x: number; z: number; level: number };
type Transport = { from: Floor; to: Floor };
type ExitLoc = { id: number; x: number; z: number; optionsWithIndex: readonly { text: string; opIndex: number }[] };
let transportRows: { key: string; checkedAt: number; rows: readonly Transport[] } | undefined;
const downTransportIndex = new WeakMap<readonly Transport[], Set<number>>();
const packDownCoord = (level: number, x: number, z: number) => level * 268_435_456 + (x & 0x3fff) * 16_384 + (z & 0x3fff);

const transports = (): readonly Transport[] => {
    const now = Date.now();
    if (transportRows && now >= transportRows.checkedAt && now - transportRows.checkedAt < 1000) return transportRows.rows;
    const path = join(KNOWLEDGE_DIR, 'transports.json');
    const st = statSync(path);
    const key = `${st.mtimeMs}:${st.size}`;
    if (transportRows && transportRows.key === key) {
        transportRows.checkedAt = now;
        return transportRows.rows;
    }
    const rows = Object.freeze(JSON.parse(readFileSync(path, 'utf8')) as Transport[]);
    transportRows = { key, checkedAt: now, rows };
    return rows;
};

function downCoordsFor(rows: readonly Transport[]): Set<number> {
    let index = downTransportIndex.get(rows);
    if (!index) {
        index = new Set<number>();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            if (r.to.level < r.from.level) {
                index.add(packDownCoord(r.from.level, r.from.x, r.from.z));
            }
        }
        downTransportIndex.set(rows, index);
    }
    return index;
}

export function floorExit<L extends ExitLoc>(at: Floor, locs: readonly L[], rows: readonly Transport[] = transports()) {
    const downIndex = downCoordsFor(rows);
    let best: { loc: L; opIndex: number; known: boolean; stand: { x: number; z: number } } | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < locs.length; i++) {
        const loc = locs[i]!;
        let opIndex = -1;
        const opts = loc.optionsWithIndex;
        for (let j = 0; j < opts.length; j++) {
            if (CLIMB_DOWN_RE.test(opts[j]!.text)) {
                opIndex = opts[j]!.opIndex;
                break;
            }
        }
        if (opIndex < 0) continue;
        const known = downIndex.has(packDownCoord(at.level, loc.x, loc.z));
        const dist = cheb(at, loc);
        if (!best || (known && !best.known) || (known === best.known && dist < bestDist)) {
            best = { loc, opIndex, known, stand: { x: loc.x, z: loc.z } };
            bestDist = dist;
        }
    }
    return best;
}

export const nearestMeatBank = (x: number, z: number) => {
    let best: (typeof MEAT_BANKS)[number] = MEAT_BANKS[0];
    let bestDist = Math.max(Math.abs(best.x - x), Math.abs(best.z - z));
    for (let i = 1; i < MEAT_BANKS.length; i++) {
        const b = MEAT_BANKS[i]!;
        const d = Math.max(Math.abs(b.x - x), Math.abs(b.z - z));
        if (d < bestDist) {
            best = b;
            bestDist = d;
        }
    }
    return best;
};

export async function runDruidMeats(
    s: Session,
    o: { cap?: number; stop?: () => boolean; travel?: (x: number, z: number, signal: AbortSignal) => Promise<void> } = {},
) {
    const cap = o.cap ?? 4000;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid CAP: positive tick budget required');
    const state = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    if (!await waitUntil(s, () => !!state()?.player && hp() > 0, { timeoutTicks: 20 })) throw Error('entry-state-timeout');
    const initial = { ...state()!.player! };
    const start = s.tick();
    const ac = new AbortController();
    let ended = false;
    let died = false;
    let admitted = false;
    let hpMin = hp();
    let failure = '';
    let kills = 0;
    let bankTrips = 0;
    const acquired: number[] = [];
    const skipped: number[] = [];
    void s.ended.then(() => {
        ended = true;
        ac.abort('session-ended');
    });
    const observe = () => {
        hpMin = Math.min(hpMin, hp());
        died ||= sessionDied(initial, state()?.player);
        failure ||= died ? 'life-lost' : ended ? 'session-ended' : o.stop?.() ? 'stop-requested' : s.tick() - start >= cap ? 'tick-budget' : admitted && hp() < 35 ? 'low-hp-cutoff' : '';
        if (failure && !ac.signal.aborted) ac.abort(failure);
    };
    const off = s.onTick(observe);
    const check = () => {
        observe();
        if (failure) throw Error(failure);
    };
    const near = (x: number, z: number) => {
        const p = state()?.player;
        return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= 2;
    };
    const leg = async (x: number, z: number) => {
        for (let attempt = 0; ; attempt++) {
            check();
            const p = state()!.player!;
            const from = `${p.worldX},${p.worldZ}`;
            console.log(`DRUID_MEATS_TRAVEL ${x},${z}`);
            const legAc = new AbortController();
            const abort = () => legAc.abort(ac.signal.reason);
            ac.signal.addEventListener('abort', abort, { once: true });
            let mx = p.worldX;
            let mz = p.worldZ;
            let ml = p.level;
            let moved = s.tick();
            let stalled = false;
            let error: unknown;
            const watch = s.onTick(() => {
                const q = state()?.player;
                if (!q || stalled) return;
                if (q.worldX !== mx || q.worldZ !== mz || q.level !== ml) {
                    mx = q.worldX;
                    mz = q.worldZ;
                    ml = q.level;
                    moved = s.tick();
                } else if (s.tick() - moved >= STALL_TICKS) {
                    stalled = true;
                    legAc.abort('stall');
                }
            });
            try {
                if (o.travel) await o.travel(x, z, legAc.signal);
                else {
                    const r = await goTo(s, await getWorld(), { x, z, level: 0 }, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 400, signal: legAc.signal });
                    if (!r.ok) error = Error(`route-failed ${x},${z}: ${r.detail ?? r.reason}`);
                }
            } catch (e) {
                error = e;
            } finally {
                watch();
                ac.signal.removeEventListener('abort', abort);
            }
            check();
            stalled ||= !near(x, z) && s.tick() - moved >= STALL_TICKS;
            if (stalled) {
                if (attempt === 0) {
                    console.log(`DRUID_MEATS_STALL ${from}->${x},${z} retry`);
                    continue;
                }
                throw Error(`travel-stalled leg ${from}->${x},${z}: no movement for ${STALL_TICKS} ticks after one retry`);
            }
            if (error) throw error;
            if (!near(x, z)) throw Error(`arrival-unobserved ${x},${z}`);
            return;
        }
    };
    const travel = async (x: number, z: number) => {
        check();
        if (near(x, z)) return;
        const p = state()!.player!;
        const chain = waypointChain({ x: p.worldX, z: p.worldZ }, { x, z });
        if (!chain) throw Error(`route-failed ${x},${z}: no route to ${x},${z},0 within ${HOP}-tile hops`);
        for (const hop of chain) if (!near(hop.x, hop.z)) await leg(hop.x, hop.z);
    };
    const bankCount = (id: number) => countList(s.bankObservation?.()?.items ?? [], id);
    const open = async () => {
        check();
        if (state()?.bank?.isOpen && s.bankObservation?.()) return;
        const gen = s.bankObservation?.()?.generation ?? 0;
        await s.bot.openBank();
        if (!await waitUntil(s, () => (!!state()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen) || !!failure, { timeoutTicks: 25 })) {
            throw Error('bank-observation-timeout');
        }
        check();
        if (!state()?.bank?.isOpen || !s.bankObservation?.()) throw Error('bank-observation-unavailable');
    };
    const bank = async () => {
        const p = state()!.player!;
        const b = nearestMeatBank(p.worldX, p.worldZ);
        await travel(b.x, b.z);
        await open();
        bankTrips++;
        for (const m of MEATS) {
            check();
            const item = inv().find(i => i.id === m.item);
            if (item) await depositObserved(s, item);
        }
    };
    try {
        for (let floors = 0; state()!.player!.level > 0; floors++) {
            check();
            const p = state()!.player!;
            const level = p.level;
            const here = { x: p.worldX, z: p.worldZ, level };
            const fail = (why: string) => {
                check();
                console.log(`DRUID_MEATS_FLOOR_EXIT failed ${why}`);
                return Error(`upper-floor-exit-failed ${here.x},${here.z},${here.level}`);
            };
            const cur = () => {
                const q = state()!.player!;
                return { x: q.worldX, z: q.worldZ, level: q.level };
            };
            if (floors >= 3) throw fail('floor bound 3');
            await waitUntil(s, () => !!floorExit(cur(), state()!.nearbyLocs) || !!failure, { timeoutTicks: 15 });
            check();
            const exit = floorExit(cur(), state()!.nearbyLocs);
            if (!exit) throw fail('no climb-down loc observed');
            console.log(`DRUID_MEATS_FLOOR_EXIT ${exit.loc.x},${exit.loc.z},${level} stand=${exit.stand ? `${exit.stand.x},${exit.stand.z}` : 'interact'}`);
            if (exit.stand) {
                const stand = exit.stand;
                const at = () => {
                    const q = cur();
                    return q.level === level && cheb(q, stand) <= 1;
                };
                for (let attempt = 0; attempt < 2 && !at(); attempt++) {
                    const r = await s.bot.walkTo(stand.x, stand.z, 1, { timeout: 60000 });
                    check();
                    if (at()) break;
                    const door = state()!
                        .nearbyLocs.filter(l => l.reachable !== false && l.optionsWithIndex.some(o => /^open$/i.test(o.text)) && cheb(cur(), l) <= 1)
                        .sort((a, b) => cheb(cur(), a) - cheb(cur(), b))[0];
                    if (!door || attempt > 0) throw fail(`stand ${stand.x},${stand.z} unreached: ${r.message}`);
                    await s.bot.openDoor(door);
                    check();
                }
                if (!at()) throw fail(`stand ${stand.x},${stand.z} unreached`);
            }
            const loc = state()!.nearbyLocs.find(l => l.id === exit.loc.id && l.x === exit.loc.x && l.z === exit.loc.z);
            if (!loc) throw fail(`exit ${exit.loc.id} unobserved at stand`);
            const r = await s.bot.interactLoc(loc, exit.opIndex);
            await waitUntil(s, () => (state()?.player?.level ?? level) < level || !!failure, { timeoutTicks: 30 });
            check();
            if (state()!.player!.level >= level) throw fail(`level ${level} unchanged after ${exit.loc.id} op${exit.opIndex}: ${r.message}`);
        }
        if (!state()?.bank?.isOpen) {
            const p = state()!.player!;
            const b = nearestMeatBank(p.worldX, p.worldZ);
            await travel(b.x, b.z);
        }
        await open();
        const missing = missingMeats(inv(), s.bankObservation!()!.items);
        if (!missing.length) throw Error('all-meats-owned');
        if (missing.some(m => m.item === 2136)) {
            const reason = bearRefusal(hp(), ...(['Attack', 'Strength', 'Defence'] as const).map(k => s.sdk.getSkill(k)?.level ?? 0) as [number, number, number]);
            if (reason) throw Error(reason);
        }
        skipped.push(...MEATS.filter(m => !missing.includes(m)).map(m => m.item));
        admitted = true;
        check();
        for (const m of MEATS) {
            const item = inv().find(i => i.id === m.item);
            if (item) await depositObserved(s, item);
        }
        await s.bot.closeBank();
        const p = state()!.player!;
        const sources = nearestMeatBank(p.worldX, p.worldZ).x === 3092 ? DRAYNOR_MEATS : MEATS;
        const pending: Meat[] = missing.map(m => sources.find(source => source.item === m.item)!);
        while (pending.length) {
            const here = state()!.player!;
            const at = { x: here.worldX, z: here.worldZ };
            const reach = (m: Meat) => (m.npc === 105 ? Math.min(...BEAR_SPAWNS.map(([x, z]) => cheb(at, { x, z }))) : cheb(at, m));
            pending.sort((a, b) => reach(a) - reach(b));
            const m = pending.shift()!;
            check();
            if (inv().length >= 28) throw Error('pack-full: need one meat slot');
            let anchor: { x: number; z: number } = m;
            const target = () =>
                state()?.nearbyNpcs.find(
                    n =>
                        n.id === m.npc &&
                        ((m.npc !== 105 && m.npc !== 41) || n.reachable === true) &&
                        !n.inCombat &&
                        (n.hp == null || n.maxHp == null || n.hp >= n.maxHp) &&
                        Math.max(Math.abs((n.tileX ?? n.x) - anchor.x), Math.abs((n.tileZ ?? n.z) - anchor.z)) <= 12,
                );
            if (m.npc === 105) {
                let found = false;
                const untried = [...BEAR_SPAWNS];
                while (untried.length) {
                    const pNow = state()!.player!;
                    const from = { x: pNow.worldX, z: pNow.worldZ };
                    untried.sort((a, b) => cheb(from, { x: a[0], z: a[1] }) - cheb(from, { x: b[0], z: b[1] }));
                    const [x, z] = untried.shift()!;
                    check();
                    anchor = { x, z };
                    try {
                        await travel(x, z);
                    } catch (error) {
                        check();
                        if (!(error instanceof Error) || !error.message.startsWith('route-failed ')) throw error;
                        continue;
                    }
                    const seen = await waitUntil(s, () => !!target() || !!failure, { timeoutTicks: 12 });
                    check();
                    if (seen && target()) {
                        found = true;
                        break;
                    }
                }
                if (!found) throw Error('target-unobserved 105: open bear boxes exhausted');
            } else if (m.npc === 41) {
                const pNow = state()!.player!;
                const approaches = spawnApproaches(m, pNow.worldX, pNow.worldZ);
                let arrived = false;
                for (const tile of approaches) {
                    check();
                    try {
                        await travel(tile.x, tile.z);
                        const after = state()!.player!;
                        if (boxDistance(after.worldX, after.worldZ, tile.box) > 1) continue;
                        anchor = tile;
                        arrived = true;
                        break;
                    } catch (error) {
                        check();
                        if (!(error instanceof Error) || !/^route-failed \d+,\d+: no route to \d+,\d+,0( within \d+-tile hops)?$/.test(error.message)) {
                            throw error;
                        }
                    }
                }
                if (!arrived) throw Error(`route-failed spawn ${m.npc}: no routable approach`);
            } else {
                await travel(m.x, m.z);
            }
            if (!await waitUntil(s, () => !!target() || !!failure, { timeoutTicks: 40 })) throw Error(`target-unobserved ${m.npc}`);
            check();
            const npc = target();
            if (!npc) throw Error(`target-unavailable ${m.npc}`);
            const beforeXp = ['Attack', 'Strength', 'Defence', 'Hitpoints'].reduce((n, k) => n + (s.sdk.getSkillXp(k) ?? 0), 0);
            const ground = new Map<string, number>();
            for (const i of state()?.groundItems ?? []) {
                if (i.id === m.item) {
                    const key = `${i.x},${i.z}`;
                    ground.set(key, (ground.get(key) ?? 0) + i.count);
                }
            }
            let lastX = npc.tileX ?? npc.x;
            let lastZ = npc.tileZ ?? npc.z;
            const drop = () =>
                state()?.groundItems.find(
                    i => i.id === m.item && i.count > (ground.get(`${i.x},${i.z}`) ?? 0) && Math.max(Math.abs(i.x - lastX), Math.abs(i.z - lastZ)) <= 3,
                );
            if (!(await s.bot.attack(npc)).success) throw Error(`attack-failed ${m.npc}`);
            const killed = () => {
                const current = state()?.nearbyNpcs.find(n => n.index === npc.index);
                if (current) {
                    lastX = current.tileX ?? current.x;
                    lastZ = current.tileZ ?? current.z;
                }
                const xpNow = ['Attack', 'Strength', 'Defence', 'Hitpoints'].reduce((n, k) => n + (s.sdk.getSkillXp(k) ?? 0), 0);
                return !current && xpNow > beforeXp && !!drop();
            };
            if (!await waitUntil(s, () => killed() || !!failure, { timeoutTicks: 180 })) throw Error(`kill-drop-timeout ${m.npc}`);
            check();
            if (!killed()) throw Error(`kill-uncredited ${m.npc}`);
            kills++;
            const item = drop()!;
            const before = countList(inv(), m.item);
            await s.bot.pickupItem(item);
            if (!await waitUntil(s, () => countList(inv(), m.item) === before + 1 || !!failure, { timeoutTicks: 15 })) {
                throw Error(`meat-pickup-unobserved ${m.item}`);
            }
            check();
            if (countList(inv(), m.item) !== before + 1) throw Error(`meat-pickup-mismatch ${m.item}`);
            acquired.push(m.item);
            await bank();
            await s.bot.closeBank();
        }
        await open();
        check();
        if (MEATS.some(m => bankCount(m.item) < 1)) throw Error('final-bank-meats-missing');
        const result = {
            ok: true,
            kills,
            acquired,
            skipped,
            bankTrips,
            hpMin,
            died,
            ticks: s.tick() - start,
            bank: Object.fromEntries(MEATS.map(m => [m.item, bankCount(m.item)])),
        };
        await s.bot.closeBank();
        return result;
    } finally {
        off();
    }
}

export async function runHerbloreCli(
    method: string,
    botName: string,
    restArgs: readonly string[],
    env: Record<string, string | undefined> = process.env,
) {
    if (method === 'meats') {
        if (!botName) {
            throw Error('Usage: bun scripts/aio-skiller.ts <account> artisan herblore meats');
        }
        const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
        try {
            const r = await runDruidMeats(s, {
                cap: Number(env.CAP ?? 4000),
                stop: () => existsSync(join(KNOWLEDGE_DIR, '..', '.practice', `stop-${botName}`)),
            });
            console.log(`DRUID_MEATS_RESULT ${JSON.stringify(r)}`);
            await finish([s], true, 'mode=druid-meats banked=2132,2134,2136,2138');
        } catch (e) {
            await finish([s], false, `mode=druid-meats ${String(e)}`);
        }
        return;
    }
    let s: Session | undefined;
    let stopped = false;
    try {
        const o = herbloreOptions([botName, ...restArgs], env);
        s = await openBot(o.name, { onStop: async () => { stopped = true; } });
        const r = await brew(s, { ...o, stop: () => stopped });
        await finish([s], true, `Herblore ${r.level} target ${r.target} brewed=${r.brewed} assets=${r.assets}`);
    } catch (e) {
        await finish(s ? [s] : [], false, `herblore ${String(e)}`);
    }
}
