// Stationed hub banking, banker payouts/receipts, supply holder staging, and wine-stock preservation.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countItems, serverFromEnv } from '../../../core/src/bot';
import { exactItem } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { sessionWalker, walkPath } from '../../../core/src/walk';
import { payoutOrder } from './admission';
import {
    courierDeliveryWaiting,
    ourAccounts,
    payoutItems,
    preparePayout,
    type PayoutItem,
} from './trade-helpers';
import { REPO_ROOT } from './types';

export { ourAccounts, payoutItems, preparePayout, type PayoutItem };

export function parseBankSpot(env: Record<string, string | undefined> = process.env): { x: number; z: number } {
    const spot = { x: Number(env.BANK_X ?? 2654), z: Number(env.BANK_Z ?? 3283) };
    if (!Number.isInteger(spot.x) || !Number.isInteger(spot.z)) throw new Error('invalid bank coordinates');
    return spot;
}

export async function runBanker(
    s: Session,
    options: {
        env?: Record<string, string | undefined>;
        stop?: () => boolean;
        rootDir?: string;
    } = {},
): Promise<{ ok: boolean; summary: string; trades: number }> {
    const env = options.env ?? process.env;
    const rootDir = options.rootDir ?? REPO_ROOT;
    const BANK_SPOT = parseBankSpot(env);
    const keep = env.KEEP ? new RegExp(env.KEEP, 'i') : null;
    const logFile = join(rootDir, '.practice', 'vault-log.jsonl');
    const demandMode = env.ON_DEMAND === '1';
    const couriers = (env.COURIERS ?? 'Bigpackage').split(',').filter(Boolean);
    const server = serverFromEnv(readFileSync(join(rootDir, 'vendor', 'rs-sdk', 'bots', s.name, 'bot.env'), 'utf8'));
    const accounts = () => ourAccounts(server);
    const order = payoutOrder(env, join(rootDir, '.practice', 'item-handoffs'));

    await waitTicks(s, 3);
    const p = s.sdk.getState()?.player;
    if (!p || p.level !== 0 || Math.max(Math.abs(p.worldX - BANK_SPOT.x), Math.abs(p.worldZ - BANK_SPOT.z)) > 80) {
        return { ok: false, summary: `not near configured bank (${BANK_SPOT.x},${BANK_SPOT.z}): ${p?.worldX},${p?.worldZ},${p?.level}`, trades: 0 };
    }
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    console.log('MILESTONE banking');
    mkdirSync(join(rootDir, '.practice'), { recursive: true });
    const stopFile = join(rootDir, '.practice', `stop-${s.name}`);
    const isStopped = () => !!options.stop?.() || existsSync(stopFile);

    const bankAll = async () => {
        const names = [...new Set(s.sdk.getInventory().map(i => i.name))].filter(item => !keep?.test(item));
        if (!names.length) return;
        const o = await s.bot.openBank();
        if (!o.success) {
            console.log(`WARN openBank ${o.message}`);
            return;
        }
        for (const item of names) {
            const exact = exactItem(item);
            const r = order
                ? { success: (await depositObserved(s, s.sdk.getInventory().find(i => i.name === item)!)) > 0, message: '' }
                : await s.bot.depositItem(exact, -1);
            if (!r.success) console.log(`WARN deposit ${item}: ${r?.message}`);
        }
        await waitTicks(s, 1);
        await s.bot.closeBank();
    };

    let trades = 0;
    await bankAll();
    const reqDir = join(rootDir, '.practice', 'withdraw');
    const fails = new Map<string, number>();

    const payOut = async (bot: string) => {
        if (!accounts().some(n => n.toLowerCase() === bot.toLowerCase())) return;
        const file = join(reqDir, `${bot}.json`);
        if (Date.now() - statSync(file).mtimeMs > 10 * 60_000 || (fails.get(bot) ?? 0) >= 2) {
            console.log(`WARN dropped stale payout request from ${bot}`);
            rmSync(file, { force: true });
            fails.delete(bot);
            return;
        }
        const request = JSON.parse(readFileSync(file, 'utf8'));
        order?.preflight(s.name, bot);
        const prepared = await preparePayout(s, request.items, env.PAYOUT_NOTES === '1', keep);
        const want = prepared.want;
        console.log(`PAYOUT_READY ${JSON.stringify({ to: bot, ...prepared })}`);
        try {
            let r: Awaited<ReturnType<typeof s.bot.serveTrades>> | undefined;
            const serve = async () => {
                r = await s.bot.serveTrades({
                    from: exactItem(bot),
                    give: want.map(w => ({ item: exactItem(w.name), amount: w.count })),
                    maxTrades: 1,
                    timeout: order ? 60000 : 120000,
                });
                return r;
            };
            if (order) {
                const expected = order.expected(want, s.sdk.getInventory());
                await order.receipt.sendHandoff(s, bot, server, expected, serve);
            } else {
                await serve();
            }
            if (!r && !order) throw Error('no payout progress: trade result missing');
            const t = order ? { gave: want } : r?.trades.find(tr => tr.success);
            if (t) {
                const items = t.gave.map(i => ({ name: i.name, count: i.count }));
                appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: s.name, to: bot, items }) + '\n');
                console.log(`MILESTONE paid ${bot} ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
                rmSync(file);
            } else {
                fails.set(bot, (fails.get(bot) ?? 0) + 1);
                console.log(`WARN payout to ${bot} not taken: ${r?.message}`);
            }
        } finally {
            if (order) await bankAll();
        }
        if (!order) await bankAll();
    };

    while (!isStopped()) {
        for (const f of existsSync(reqDir) ? readdirSync(reqDir).filter(f => f.endsWith('.json')) : []) {
            await payOut(f.slice(0, -5));
        }
        const pending = new Set((existsSync(reqDir) ? readdirSync(reqDir) : []).map(f => f.slice(0, -5).toLowerCase()));
        const from = new RegExp(`^(${accounts().filter(n => n.toLowerCase() !== s.name.toLowerCase() && !pending.has(n.toLowerCase())).join('|')})$`, 'i');
        const hasRequest = () => existsSync(reqDir) && readdirSync(reqDir).some(f => f.endsWith('.json') && accounts().some(n => n.toLowerCase() === f.slice(0, -5).toLowerCase()));
        if (demandMode && !courierDeliveryWaiting(couriers) && !hasRequest()) break;
        const r = await s.bot.serveTrades({
            from,
            maxTrades: 1,
            timeout: demandMode ? 30_000 : 120_000,
            until: () => hasRequest() || isStopped() || (demandMode && !courierDeliveryWaiting(couriers)),
        });
        for (const t of r.trades.filter(tr => !tr.success)) console.log(`WARN donor trade failed: ${t.partner ?? '?'} ${t.reason ?? ''} ${t.message}`);
        for (const t of r.trades.filter(tr => tr.success)) {
            trades++;
            const items = t.received.map(i => ({ name: i.name, count: i.count }));
            appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: t.partner ?? '?', to: s.name, items }) + '\n');
            console.log(`MILESTONE got ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
        }
        await bankAll();
    }

    return {
        ok: true,
        summary: `${isStopped() ? 'stop file' : 'waiting offline for owned cargo'} trades=${trades}`,
        trades,
    };
}

export async function runGiveToBanker(
    s: Session,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<{ ok: boolean; summary: string }> {
    const BANK_SPOT = { x: 2654, z: 3283 };
    const banker = args[0] ?? 'Moneyshot';
    const keep = env.KEEP ? new RegExp(env.KEEP, 'i') : null;
    const only = env.GIVE
        ? env.GIVE.split(',').map(g => { const [n, c] = g.split(':'); return { name: n!, count: Number(c ?? -1) }; })
        : null;

    await waitTicks(s, 3);
    const p = s.sdk.getState()?.player;
    if (!p || Math.max(Math.abs(p.worldX - BANK_SPOT.x), Math.abs(p.worldZ - 3300)) > 80) {
        return { ok: false, summary: `not in Ardougne (${p?.worldX},${p?.worldZ})` };
    }
    for (let i = 0; i < 3; i++) {
        const q = s.sdk.getState()?.player;
        if (q && Math.max(Math.abs(q.worldX - BANK_SPOT.x), Math.abs(q.worldZ - BANK_SPOT.z)) <= 3) break;
        await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    }
    const wantCoins = only?.find(g => /^coins$/i.test(g.name))?.count ?? 0;
    if (only && wantCoins > 0 && countItems(s, /^coins$/i) < wantCoins) {
        const o = await s.bot.openBank();
        if (o.success) {
            await s.bot.withdrawItem(/^coins$/i, wantCoins - countItems(s, /^coins$/i));
            await s.bot.closeBank();
        } else {
            console.log(`WARN openBank ${o.message}`);
        }
    }
    if (!only) {
        const o = await s.bot.openBank();
        if (o.success) {
            const banked = (s.sdk.getState()?.bank?.items ?? []).find((i: any) => /^coins$/i.test(i.name));
            if (banked) await s.bot.withdrawItem(/^coins$/i, -1);
            await s.bot.closeBank();
        } else {
            console.log(`WARN openBank ${o.message}`);
        }
    }
    const giveable = () => s.sdk.getInventory().filter(i => !keep?.test(i.name));
    const coins0 = countItems(s, /^coins$/i);
    let trades = 0, items = 0;
    for (let i = 0; i < 6 && giveable().length && !(only && trades > 0); i++) {
        const before = giveable().length;
        const names = [...new Set(giveable().map(item => item.name))];
        const r = await s.bot.trade(exactItem(banker), {
            give: only ? only.map(g => ({ item: exactItem(g.name), amount: g.count })) : names.map(n => ({ item: exactItem(n), amount: -1 })),
            timeout: 60_000,
        });
        if (!r.success) {
            console.log(`WARN trade ${r.reason} ${r.message}`);
            await waitTicks(s, 5);
            continue;
        }
        trades++;
        items += before - giveable().length;
        console.log(`MILESTONE gave ${r.gave.map(g => `${g.count} ${g.name}`).join(', ')}`);
    }
    const left = only ? 0 : giveable().length;
    return {
        ok: only ? trades > 0 : left === 0,
        summary: `trades=${trades} slots=${items} coins=${coins0} left=${left}`,
    };
}

export function parseTakeFromBankerArgs(args: readonly string[]) {
    const banker = args.find(a => a.startsWith('--banker='))?.slice(9) ?? 'Moneyshot';
    const items = args.filter(a => !a.startsWith('--')).map(a => {
        const [c, ...n] = a.split(':');
        return { name: n.join(':'), count: Number(c) };
    });
    if (!items.length || items.some(i => !i.name || !Number.isSafeInteger(i.count) || i.count <= 0)) {
        throw new Error('usage: take-from-banker <bot> <count>:<item> ... [--banker=Moneyshot]');
    }
    return { banker, items };
}

export async function runTakeFromBanker(
    s: Session,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
    rootDir = REPO_ROOT,
): Promise<{ ok: boolean; summary: string }> {
    const BANK_SPOT = parseBankSpot(env);
    const { banker, items } = parseTakeFromBankerArgs(args);
    const dir = join(rootDir, '.practice', 'withdraw');
    const file = join(dir, `${s.name}.json`);
    const order = payoutOrder(env, join(rootDir, '.practice', 'item-handoffs'));
    order?.preflight(banker, s.name);
    const server = serverFromEnv(readFileSync(join(rootDir, 'vendor/rs-sdk/bots', s.name, 'bot.env'), 'utf8'));

    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ items }));
        await waitTicks(s, 2);
        await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
        if (!await waitUntil(s, st => st.nearbyPlayers.some((p: { name: string }) => p.name.toLowerCase() === banker.toLowerCase()), { timeoutTicks: 150 })) {
            throw new Error('owned banker did not arrive within150ticks');
        }
        const before = items.map(i => countItems(s, exactItem(i.name)));
        const beforeExact = order ? s.sdk.getInventory().filter(i => i.id === order.id).reduce((n, i) => n + i.count, 0) : 0;
        let ok = false;
        if (order) {
            await order.receipt.awaitCollectionOffer(s, banker, server, 150);
            const collected = await order.receipt.collectHandoff(
                s,
                banker,
                server,
                () => s.bot.trade(exactItem(banker), { want: items.map(i => ({ item: exactItem(i.name), amount: i.count })), timeout: 60000 }),
            );
            ok = items.length === 1 && collected.received === items[0]!.count && countItems(s, exactItem(items[0]!.name)) - before[0]! === items[0]!.count;
            if (!ok) throw Error('payout prerequisite: exact collection unproved');
        } else {
            for (let i = 0; i < 8 && !ok; i++) {
                const r = await s.bot.trade(exactItem(banker), { want: items.map(it => ({ item: exactItem(it.name), amount: it.count })), timeout: 90_000 });
                ok = r.success;
                if (!ok) {
                    console.log(`WARN trade ${r.reason} ${r.message}`);
                    await waitTicks(s, 5);
                }
            }
        }
        const got = items.map((it, k) => `${countItems(s, exactItem(it.name)) - before[k]!} ${it.name}`).join(', ');
        if (order && ok) {
            if (!(await s.bot.openBank()).success) throw Error('payout prerequisite: receiver bank unavailable');
            const item = s.sdk.getInventory().find(i => i.id === order.id);
            if (!item || await depositObserved(s, item) !== beforeExact + items[0]!.count) throw Error('payout prerequisite: receiver bank credit unproved');
            await s.bot.closeBank();
        }
        if (!ok) rmSync(file, { force: true });
        return { ok, summary: `got ${got}` };
    } catch (e) {
        rmSync(file, { force: true });
        throw e;
    }
}

export async function runSupplyHolder(
    s: Session,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<{ ok: boolean; summary: string }> {
    const specialistName = args[0] ?? env.SPEC ?? 'Haggis';
    const courierName = args[1] ?? env.COURIER ?? 'Bigpackage';
    const CAP = Number(args[2] ?? env.CAP ?? 15000);
    const spotStr = env.SPOT ?? '2654,3283';
    const [spotX, spotZ] = spotStr.split(',').map(Number);
    const HOLD_SPOT = { x: spotX ?? 2654, z: spotZ ?? 3283 };
    const supplyPattern = new RegExp(env.SUPPLY_ITEM ?? '.', 'i');
    const BATCH_SIZE = Number(env.BATCH_SIZE ?? 27);

    await waitUntil(s, st => (st?.inGame ?? false) && st?.player !== null, { timeoutTicks: 10 });
    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let courierTrades = 0, specialistTrades = 0, itemsSupplied = 0, itemsStored = 0;

    const walkToSpot = async () => {
        const p = pos();
        if (p && Math.max(Math.abs(p.worldX - HOLD_SPOT.x), Math.abs(p.worldZ - HOLD_SPOT.z)) <= 2) return true;
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: HOLD_SPOT.x, z: HOLD_SPOT.z, tol: 1 }], { stop: over });
        return r.ok;
    };

    const isNearBank = () => (s.sdk.getState()?.nearbyLocs?.filter(l => /bank/i.test(l.name)) ?? []).length > 0;

    const prepareStagedInventory = async () => {
        if (!isNearBank()) return;
        const unnotedCount = inv().filter(i => supplyPattern.test(i.name) && !i.name.includes('(noted)')).length;
        if (unnotedCount >= BATCH_SIZE) return;
        const b = await s.bot.openBank();
        if (!b.success) return;
        for (const item of inv()) if (!supplyPattern.test(item.name)) await s.bot.depositItem(item.name, -1);
        const withdrawCount = BATCH_SIZE - unnotedCount;
        if (withdrawCount > 0) await s.bot.withdrawItem(supplyPattern, withdrawCount);
        await waitTicks(s, 1);
        await s.bot.closeInterface();
    };

    console.log(`START supply-holder ${s.name} staging at=${HOLD_SPOT.x},${HOLD_SPOT.z} for specialist=${specialistName} courier=${courierName}`);
    await walkToSpot();

    while (!over()) {
        const nearbyPlayers = s.sdk.getState()?.nearbyPlayers ?? [];
        const specialistNearby = nearbyPlayers.find(p => new RegExp(`^${specialistName}$`, 'i').test(p.name));
        const courierNearby = nearbyPlayers.find(p => new RegExp(`^${courierName}$`, 'i').test(p.name));

        if (specialistNearby) {
            console.log(`SPECIALIST ${specialistName} spotted! Serving trade immediately...`);
            const stageItems = inv().filter(i => supplyPattern.test(i.name));
            const giveList = stageItems.slice(0, BATCH_SIZE).map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: i.count }));
            const tradeRes = await s.bot.trade(new RegExp(`^${specialistName}$`, 'i'), { give: giveList, timeout: 30000 });
            if (tradeRes.success) {
                specialistTrades++;
                const countGave = tradeRes.gave.reduce((acc, g) => acc + g.count, 0);
                itemsSupplied += countGave;
                console.log(`MILESTONE supplied ${countGave} items to ${specialistName} in 1 trade! totalSupplied=${itemsSupplied}`);
                await waitTicks(s, 1);
                await prepareStagedInventory();
                continue;
            }
        }

        if (courierNearby) {
            console.log(`COURIER ${courierName} spotted! Receiving cargo...`);
            const serveRes = await s.bot.serveTrades({ from: new RegExp(`^${courierName}$`, 'i'), maxTrades: 1, timeout: 30000 });
            if (serveRes.success && serveRes.trades.some(t => t.success)) {
                courierTrades++;
                const receivedTrade = serveRes.trades.find(t => t.success)!;
                const countGot = receivedTrade.received.reduce((acc, r) => acc + r.count, 0);
                itemsStored += countGot;
                console.log(`MILESTONE received ${countGot} items from ${courierName}! totalStored=${itemsStored}`);
                if (isNearBank()) {
                    const b = await s.bot.openBank();
                    if (b.success) {
                        for (const item of inv()) if (!supplyPattern.test(item.name)) await s.bot.depositItem(item.name, -1);
                        await s.bot.closeInterface();
                    }
                }
                await prepareStagedInventory();
                continue;
            }
        }

        await s.bot.serveTrades({ from: new RegExp(`^(${specialistName}|${courierName})$`, 'i'), maxTrades: 1, timeout: 5000 });
        await waitTicks(s, 2);
    }

    return {
        ok: specialistTrades > 0 || courierTrades > 0 || itemsSupplied > 0,
        summary: `ticks=${used()} specialistTrades=${specialistTrades} courierTrades=${courierTrades} itemsSupplied=${itemsSupplied} itemsStored=${itemsStored}`,
    };
}

// --- Wine Stock Preservation ---

type WineItem = { id: number; count: number };
export type WineStock = { items: Record<number, number>; equipment: (WineItem & { slot: number })[]; xp: number };
export type WineStockOptions = { maximum: number; cap: number; reserve?: number };
const sumWine = (rows: readonly WineItem[], id: number) => rows.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
const wornWine = (rows: WineStock['equipment']) => rows.map(i => ({ id: i.id, count: i.count, slot: i.slot })).sort((a, b) => a.slot - b.slot);

const GRAPES_ID = 1987;
const JUG_WATER_ID = 1937;
const UNFERMENTED_WINE_ID = 1995;
const UNFERMENTED_WINE_NOTE_ID = 1996;
const WINE_LEVEL_REQUIRED = 35;

export function wineStockChecks(before: WineStock, after: WineStock, maximum: number) {
    const delta: Record<number, number> = { [GRAPES_ID]: -maximum, [JUG_WATER_ID]: -maximum, [UNFERMENTED_WINE_NOTE_ID]: maximum };
    return {
        inputs: (after.items[GRAPES_ID] ?? 0) === (before.items[GRAPES_ID] ?? 0) - maximum && (after.items[JUG_WATER_ID] ?? 0) === (before.items[JUG_WATER_ID] ?? 0) - maximum,
        output: (before.items[UNFERMENTED_WINE_ID] ?? 0) === 0 && (after.items[UNFERMENTED_WINE_ID] ?? 0) === 0 && (after.items[UNFERMENTED_WINE_NOTE_ID] ?? 0) === (before.items[UNFERMENTED_WINE_NOTE_ID] ?? 0) + maximum,
        assets: [...new Set([...Object.keys(before.items), ...Object.keys(after.items), ...Object.keys(delta)])].every(id => (after.items[+id] ?? 0) === (before.items[+id] ?? 0) + (delta[+id] ?? 0)),
        equipment: JSON.stringify(wornWine(before.equipment)) === JSON.stringify(wornWine(after.equipment)),
        xp: before.xp === after.xp,
    };
}

function wineMixEffect(before: Record<number, number>, after: Record<number, number>): 'none' | 'made' | 'invalid' {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)].map(Number));
    if ([...keys].every(id => (after[id] ?? 0) === (before[id] ?? 0))) return 'none';
    const expected = new Map<number, number>([[GRAPES_ID, -1], [JUG_WATER_ID, -1], [UNFERMENTED_WINE_ID, 1]]);
    const all = new Set([...keys, ...expected.keys()]);
    return [...all].every(id => (after[id] ?? 0) - (before[id] ?? 0) === (expected.get(id) ?? 0)) ? 'made' : 'invalid';
}

export async function runPreservedWine(s: Session, o: WineStockOptions, stop: () => boolean = () => false) {
    if (!Number.isSafeInteger(o.maximum) || o.maximum < 1 || !Number.isSafeInteger(o.cap) || o.cap < 1 || !Number.isSafeInteger(o.reserve ?? 0) || (o.reserve ?? 0) < 0) {
        throw Error('invalid preserved wine order');
    }
    const start = s.tick(), reserve = o.reserve ?? 0;
    const recipeInputs = [GRAPES_ID, JUG_WATER_ID] as const;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const initial = s.sdk.getState()?.player;
    const stopped = () => {
        const p = s.sdk.getState()?.player;
        return ended || stop() || !initial || !p || p.isDead || p.lifeId !== initial.lifeId || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0;
    };
    const guard = () => { if (stopped() || s.tick() - start >= o.cap) throw Error('preserved wine stopped or CAP exhausted'); };
    const pack = () => s.sdk.getInventory(), held = (id: number) => sumWine(pack(), id), stored = (id: number) => sumWine(s.bankObservation?.()?.items ?? [], id);
    const stock = (): WineStock => {
        if (!s.bankObservation?.()) throw Error('preserved wine bank unknown');
        const items: Record<number, number> = {};
        for (const i of [...s.bankObservation()!.items, ...pack()]) items[i.id] = (items[i.id] ?? 0) + i.count;
        return { items, equipment: s.sdk.getEquipment().map(i => ({ id: i.id, count: i.count, slot: i.slot })), xp: s.sdk.getSkillXp('Cooking') ?? 0 };
    };
    const readPack = (): Record<number, number> => {
        const items: Record<number, number> = {};
        for (const i of pack()) items[i.id] = (items[i.id] ?? 0) + i.count;
        return items;
    };
    const open = async () => {
        guard();
        if (s.sdk.getState()?.bank.isOpen && s.bankObservation?.()) return;
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 10 })) {
            throw Error('preserved wine fresh bank unavailable');
        }
        guard();
    };
    let before: WineStock | undefined, after: WineStock | undefined, made = 0, noted = 0, failure = '', assets = false;
    try {
        guard();
        if ((s.sdk.getSkill('Cooking')?.baseLevel ?? 0) < WINE_LEVEL_REQUIRED) throw Error('preserved wine requires Cooking35');
        await open();
        before = stock();
        if ((before.items[UNFERMENTED_WINE_ID] ?? 0) !== 0) throw Error('preserved wine entry has existing raw wine');
        if (recipeInputs.some(id => (before!.items[id] ?? 0) < o.maximum + reserve)) throw Error('preserved wine staged inputs short of order and reserve');

        while (made < o.maximum && !stopped() && s.tick() - start < o.cap) {
            await open();
            for (const inputId of recipeInputs) {
                guard();
                const missing = 1 - held(inputId);
                if (missing <= 0) continue;
                const target = s.sdk.getState()?.bank.items.find(i => i.id === inputId), old = stored(inputId), count = held(inputId), generation = s.bankObservation!()!.generation;
                if (!target || old - missing < reserve) throw Error('preserved wine input reserve unavailable');
                await s.bot.withdrawItem(target, missing, { asNote: false });
                if (!await waitUntil(s, () => held(inputId) === count + missing && stored(inputId) === old - missing && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 8 })) {
                    throw Error('preserved wine paired input withdrawal unobserved');
                }
            }
            guard();
            if (held(UNFERMENTED_WINE_ID) || stored(UNFERMENTED_WINE_ID)) throw Error('preserved wine raw stock before close');
            if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 })) {
                throw Error('preserved wine bank close unobserved');
            }
            guard();
            const beforeSnap = readPack();
            if (recipeInputs.some(id => (beforeSnap[id] ?? 0) < 1)) throw Error('preserved wine input observation missing');
            const grapes = pack().find(i => i.id === GRAPES_ID), water = pack().find(i => i.id === JUG_WATER_ID);
            if (!grapes || !water) throw Error('preserved wine input slots missing');
            const dispatchedAt = s.tick();
            await s.sdk.sendUseItemOnItem(grapes.slot, water.slot);
            await waitUntil(s, () => stopped() || s.tick() - start >= o.cap || wineMixEffect(beforeSnap, readPack()) !== 'none', { timeoutTicks: 8 });
            const effect = wineMixEffect(beforeSnap, readPack());
            if (effect !== 'made') throw Error('production action receipt ' + effect);
            made++;
            guard();
            if (s.tick() - dispatchedAt >= 20) throw Error('preserved wine first timer window missed');
            await open();
            const raw = pack().find(i => i.id === UNFERMENTED_WINE_ID);
            if (!raw || held(UNFERMENTED_WINE_ID) !== 1 || stored(UNFERMENTED_WINE_ID) !== 0) throw Error('preserved wine raw output mismatch');
            if (await depositObserved(s, raw) !== 1) throw Error('preserved wine raw bank credit mismatch');
            guard();
            const target = s.sdk.getState()?.bank.items.find(i => i.id === UNFERMENTED_WINE_ID), previous = held(UNFERMENTED_WINE_NOTE_ID), generation = s.bankObservation!()!.generation;
            if (!target || stored(UNFERMENTED_WINE_ID) !== 1) throw Error('preserved wine raw bank slot missing');
            await s.bot.withdrawItem(target, 1, { asNote: true });
            if (!await waitUntil(s, () => held(UNFERMENTED_WINE_NOTE_ID) === previous + 1 && held(UNFERMENTED_WINE_ID) === 0 && stored(UNFERMENTED_WINE_ID) === 0 && (s.bankObservation?.()?.generation ?? -1) > generation, { timeoutTicks: 8 })) {
                throw Error('preserved wine paired note withdrawal unobserved');
            }
            guard();
            noted++;
        }
        if (made !== o.maximum || s.tick() - start >= o.cap || stopped()) throw Error('production target incomplete');
        guard();
        after = stock();
        const checks = wineStockChecks(before, after, o.maximum);
        assets = Object.values(checks).every(Boolean);
        if (!assets || noted !== o.maximum) throw Error('preserved wine final input/output/assets mismatch');
        if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 })) {
            throw Error('preserved wine final close unobserved');
        }
        guard();
    } catch (error) {
        failure = String(error);
    }
    const used = (id: number) => !before ? 0 : after ? (before.items[id] ?? 0) - (after.items[id] ?? 0) : (before.items[id] ?? 0) - stored(id) - held(id);
    return { ok: !failure, made, noted, inputs: { grapes: used(GRAPES_ID), water: used(JUG_WATER_ID) }, assets, ticks: s.tick() - start, failure: failure || '-' };
}
