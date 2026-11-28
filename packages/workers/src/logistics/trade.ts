// Trade logistics execution: coin courier, fan-out, item fan-in, note courier, food courier, food chain, and fleet trades.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COOKED_FOOD, cookedFoodRestock, selectCookedFoodSource } from '../../../core/src/bank-demand';
import { disembark as disembarkBoat, sail as sailBoat } from '../../../core/src/boat';
import { accountOf, assertServerAllowed, countItems, finish, getWorld, openBot, serverFromEnv, sessionDied, settle } from '../../../core/src/bot';
import { cargoDir, exactItem, type Cargo } from '../../../core/src/cargo';
import { depositObserved } from '../../../core/src/deposit';
import { FLEET_DIR, loadOwners, sideOf } from '../../../core/src/fleet';
import { readHeldFleetTradeClaims } from '../../../core/src/fleet-trade-claim';
import { clearPreloginFailure, orderLines, validOrder, writePreloginFailure, writeTradeReceipt, type Order, type OrderLine, type TradeReceipt } from '../../../core/src/fleet-trade-settlement';
export type { OrderLine };
import type { Outcome } from '../../../core/src/act';
import type { Session } from '../../../core/src/inprocess';
import { isLocalServer } from '../../../core/src/localserver';
import { resolveBotEnvPath } from '../../../core/src/practice-paths';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { ownedAccounts, tradePartners } from '../../../core/src/tradeguard';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';
import { cachedReleaseFor, releaseEntries } from '../../../core/src/worker-release';
import { acquireAccountLeases, checkTransferAccounts, transferOrderKey } from './admission';
import { createHandoff } from './handoff';
import { meetingTiles } from './location';
import { exitLumberYard } from './recover';
import {
    ARDY_BANK, BOAT_FARES_OUT, BOAT_FARES_ROUND, assertTradeAdmission, coinTradeObservation, courierCargo, courierFoodAllocation,
    courierIslandProblem, courierRecord, deliveryRecipientAtBank, deliveryResume, draynorApproach, exactCoinDelta,
    featherBatchAmount, featherPurchaseAmount, featherPurchaseEffect, fleetTradeOutcome, fleetTradeRecord,
    absentTakerWatch, giverReadyFile, heldItems, itemDefinition, markGiverReady, NORTH_BANK, NORTH_TO_SOUTH, noteCourierOwned, noteCourierPreflight, noteIdOf,
    onKaramja, outboundStart, parseCoins, parseFanin, parseFanout, partnerFailed, performFleetTransfer, pickOrder,
    prepareCoinSlot, releaseWatch, requestCourierFunding, runOrderWork, SARIM, separateTroutNotes,
    waitForGiver, watchTradeScreen, type CoinState, type FleetTradeProgress,
} from './trade-helpers';
import { REPO_ROOT } from './types';
import { walkTarget } from './walk';
import { leaveElementalWorkshop } from './walk-helpers';

export async function moveCoins(c: ReturnType<typeof parseCoins>, sessions: Session[], root: string, server: string, check: () => void) {
    const [donor, receiver] = sessions;
    if (!donor || !receiver || donor.name.toLowerCase() !== c.donor.toLowerCase() || receiver.name.toLowerCase() !== c.receiver.toLowerCase()) {
        throw Error('coin session identity mismatch');
    }
    const started = Date.now();
    const guard = () => { check(); if (Date.now() - started >= c.timeoutMs) throw Error('coin courier deadline; reconcile before retry'); };
    const observe = async (s: Session, pred: () => boolean, detail: string) => {
        if (!await waitUntil(s, () => { guard(); return pred(); }, { timeoutTicks: 20 })) throw Error(detail);
    };
    const bank = async (s: Session) => {
        guard();
        const generation = s.bankObservation?.()?.generation ?? -1;
        if (s.sdk.getState()?.bank?.isOpen) {
            if (!(await s.bot.closeBank()).success) throw Error(`coin bank closure failed: ${s.name}`);
            await observe(s, () => !s.sdk.getState()?.bank?.isOpen, `coin bank closure unobserved: ${s.name}`);
        }
        if (!(await s.bot.openBank()).success) throw Error(`coin bank entry failed: ${s.name}`);
        await observe(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation, `coin fresh bank entry unobserved: ${s.name}`);
    };
    const coins = (items: { id: number; count: number }[]) => items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
    const state = (s: Session): CoinState => {
        const b = s.bankObservation?.();
        if (!b || !s.sdk.getState()?.bank?.isOpen) throw Error('coin open bank snapshot unavailable');
        return { bank: coins(b.items), pack: coins(s.sdk.getInventory()) };
    };
    const world = await getWorld();
    for (const s of sessions) {
        guard();
        const travel = await goTo(s, world, { x: c.x, z: c.z, level: 0 }, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 100 });
        if (!travel.ok) throw Error('coin meeting route failed: ' + JSON.stringify(travel));
        await observe(s, () => { const p = s.sdk.getState()?.player; return !!p && p.level === 0 && Math.max(Math.abs(p.worldX - c.x), Math.abs(p.worldZ - c.z)) <= 2; }, 'coin bank location unobserved');
        await bank(s);
    }
    const before = sessions.map(state);
    if (before[0]!.bank < c.amount) throw Error('coin bank funds short');
    if (before[0]!.bank - c.amount < c.reserve) throw Error('coin donor bank reserve short');
    for (const s of sessions) await prepareCoinSlot(s, guard);
    if (before[0]!.pack + c.amount > 2147483647 || before[1]!.pack + c.amount > 2147483647 || before[1]!.bank + c.amount > 2147483647) throw Error('coin stack overflow');
    if (!before[1]!.pack && receiver.sdk.getInventory().length >= 28) throw Error('coin receiver pack full');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'before.json'), JSON.stringify({ from: c.donor, to: c.receiver, amount: c.amount, reserve: c.reserve, server, before }), { flag: 'wx' });
    const withdraw = async (s: Session, amount: number, target: CoinState) => {
        guard();
        const generation = s.bankObservation!()!.generation;
        await s.bot.withdrawItem(exactItem('Coins'), amount);
        await observe(s, () => { const b = s.bankObservation?.(); return !!b && b.generation > generation && coins(b.items) === target.bank && coins(s.sdk.getInventory()) === target.pack; }, 'exact coin withdrawal unobserved');
    };
    await withdraw(donor, c.amount, { bank: before[0]!.bank - c.amount, pack: before[0]!.pack + c.amount });
    for (const s of sessions) {
        guard();
        await s.bot.closeBank();
        await observe(s, () => !s.sdk.getState()?.bank?.isOpen, 'coin bank did not close');
    }
    const tradeState = () => [coinTradeObservation(donor, c.receiver), coinTradeObservation(receiver, c.donor)];
    const meet = meetingTiles(c);
    if (meet) for (const [i, s] of sessions.entries()) {
        guard();
        const tile = meet[i]!;
        const travel = await goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 100 });
        if (!travel.ok) throw Error('coin meeting tile route failed: ' + JSON.stringify({ account: s.name, tile, travel }));
        await s.bot.walkTo(tile.x, tile.z, 0);
        await observe(s, () => { const p = s.sdk.getState()?.player; return !!p && p.level === tile.level && p.worldX === tile.x && p.worldZ === tile.z; }, `coin meeting tile unobserved: ${s.name}`);
    }
    if (!await waitUntil(donor, () => { guard(); return tradeState().every(o => o.partner?.reachable === true); }, { timeoutTicks: 10 })) {
        const refused = tradeState();
        console.log('COIN_TRADE_REFUSED ' + JSON.stringify(refused));
        throw Error('coin trade refused: partner unreachable, nothing sent; reconcile before retry: ' + JSON.stringify(refused.map(o => ({ account: o.account, position: o.position, partner: o.partner }))));
    }
    const tradeEntry = tradeState();
    writeFileSync(join(root, 'trade-entry.json'), JSON.stringify(tradeEntry), { flag: 'wx' });
    console.log('COIN_TRADE_ENTRY ' + JSON.stringify(tradeEntry));
    const handoff = createHandoff([995], join(root, 'trade'));
    const childResults: unknown[] = [];
    const transfers = await Promise.allSettled([
        handoff.sendHandoff(donor, c.receiver, server, [{ id: 995, count: c.amount }], async () => {
            const result = await donor.bot.serveTrades({ from: exactItem(c.receiver), give: [{ item: exactItem('Coins'), amount: c.amount }], accept: offer => offer.length === 0, maxTrades: 1, timeout: c.requestMs });
            childResults.push(result);
            console.log('COIN_TRADE ' + JSON.stringify({ account: donor.name, result }));
        }),
        handoff.receiveHandoff(receiver, c.donor, server, async () => {
            const result = await receiver.bot.trade(exactItem(c.donor), { accept: offer => offer.length === 1 && offer[0]!.id === 995 && offer[0]!.count === c.amount, requestTimeout: c.requestMs, timeout: c.requestMs });
            childResults.push(result);
            console.log('COIN_TRADE ' + JSON.stringify({ account: receiver.name, result }));
        }),
    ]);
    const tradeExit = { childResults, state: tradeState(), transfers: transfers.map(r => r.status === 'rejected' ? { status: r.status, reason: String(r.reason) } : r) };
    writeFileSync(join(root, 'trade-results.json'), JSON.stringify(tradeExit), { flag: 'wx' });
    console.log('COIN_TRADE_EXIT ' + JSON.stringify(tradeExit));
    const failed = transfers.find(r => r.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    guard();
    for (const s of sessions) await bank(s);
    const item = receiver.sdk.getInventory().find(i => i.id === 995);
    if (!item) throw Error('received coins missing');
    await depositObserved(receiver, item);
    if (before[1]!.pack) await withdraw(receiver, before[1]!.pack, { bank: before[1]!.bank + c.amount, pack: before[1]!.pack });
    const after = sessions.map(state);
    if (!exactCoinDelta(before, after, c.amount, c.reserve)) throw Error('exact coin bank deltas/reserve unproved: ' + JSON.stringify({ before, after, reserve: c.reserve }));
    const receipt = { from: c.donor, to: c.receiver, amount: c.amount, reserve: c.reserve, server, before, after, childResults };
    writeFileSync(join(root, 'settled.json'), JSON.stringify(receipt), { flag: 'wx' });
    console.log('COIN_RECEIPT ' + JSON.stringify(receipt));
    return receipt;
}

export async function runCoinCourier(args: string[], env: Record<string, string | undefined> = process.env): Promise<{ ok: boolean; detail: string }> {
    const c = parseCoins(args), dir = join(REPO_ROOT, '.practice');
    const host = (name: string) => serverFromEnv(readFileSync(resolveBotEnvPath(name, REPO_ROOT), 'utf8'));
    const server = host(c.donor);
    if (host(c.receiver) !== server) throw Error('coin accounts must use the same server');
    assertServerAllowed(server);
    const runId = env.COORDINATOR_RUN_ID ?? '';
    const key = transferOrderKey(env.COIN_ORDER ?? (runId || crypto.randomUUID()), 'COIN_ORDER');
    const journal = join(dir, 'coin-courier', key);
    if (existsSync(join(journal, 'before.json'))) throw Error('coin order already attempted; reconcile before retry');
    const sessions: Session[] = [];
    let cancelled = false, ok = false, detail = '', release: (() => void) | undefined;
    const cancel = () => { cancelled = true; };
    const check = () => {
        if (cancelled) throw Error('coin courier cancelled');
        checkTransferAccounts(REPO_ROOT, [c.donor, c.receiver], server, sessions, runId);
    };
    try {
        check();
        release = acquireAccountLeases([c.donor, c.receiver], runId);
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        const record = courierRecord(c, args, env);
        for (const name of [c.donor, c.receiver]) {
            check();
            sessions.push(await openBot(name, { record, onStop: async () => cancel(), onSessionEnd: async () => cancel() }));
        }
        await moveCoins(c, sessions, journal, server, check);
        ok = true;
        detail = `transferred ${c.amount} coins ${c.donor} -> ${c.receiver}`;
    } catch (error) {
        detail = String(error);
    } finally {
        try { ok = await settle(sessions, ok, detail); }
        finally {
            process.off('SIGINT', cancel);
            process.off('SIGTERM', cancel);
            release?.();
        }
    }
    console.log('COIN_RESULT ' + JSON.stringify({ ok, detail }));
    return { ok, detail };
}

export async function coinFanoutMain(
    argv: string[],
    env: Record<string, string | undefined> = process.env,
    deps: { moveCoins?: typeof moveCoins } = {},
) {
    const f = parseFanout(argv), dir = join(REPO_ROOT, '.practice');
    const all = [f.donor, ...f.receivers];
    const host = (name: string) => serverFromEnv(readFileSync(resolveBotEnvPath(name, REPO_ROOT), 'utf8'));
    const server = host(f.donor);
    if (all.some(n => host(n) !== server)) throw Error('coin accounts must use the same server');
    assertServerAllowed(server);
    const runId = env.COORDINATOR_RUN_ID ?? '', order = transferOrderKey(env.COIN_ORDER ?? `fanout-${Date.now()}`, 'COIN_ORDER');
    let cancelled = false;
    const closing = new Set<string>();
    const cancel = () => { cancelled = true; };
    const sessionEnd = (name: string) => async () => { if (!closing.has(name.toLowerCase())) cancel(); };
    const check = (names: string[], open: Session[]) => () => {
        if (cancelled) throw Error('coin fan-out cancelled');
        checkTransferAccounts(REPO_ROOT, names, server, open, runId);
    };
    const results: { to: string; ok: boolean; detail: string }[] = [];
    let donor: Session | undefined, release: (() => void) | undefined;
    try {
        check(all, [])();
        release = acquireAccountLeases(all, runId);
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        const record = { script: 'scripts/aio-logistics.ts', argv: ['coin-fanout', ...argv], env };
        donor = await openBot(f.donor, { record, onStop: async () => cancel(), onSessionEnd: sessionEnd(f.donor) });
        for (const c of f.pairs) {
            if (cancelled) break;
            const open: Session[] = [donor];
            let ok = false, detail = '';
            try {
                check([f.donor, c.receiver], open)();
                open.push(await openBot(c.receiver, { record, onStop: async () => cancel(), onSessionEnd: sessionEnd(c.receiver) }));
                await (deps.moveCoins ?? moveCoins)(c, open, join(dir, 'coin-courier', `${order}-${c.receiver}`), server, check([f.donor, c.receiver], open));
                ok = true;
                detail = `transferred ${c.amount} coins ${f.donor} -> ${c.receiver}`;
            } catch (error) { detail = String(error); }
            if (open[1]) {
                closing.add(c.receiver.toLowerCase());
                try { if (!await settle([open[1]], ok, detail)) { ok = false; detail += '; receiver settlement failed'; } }
                catch (error) { ok = false; detail += '; receiver settlement: ' + String(error); }
            }
            results.push({ to: c.receiver, ok, detail });
            console.log('FANOUT_PAIR ' + JSON.stringify(results.at(-1)));
        }
    } catch (error) { results.push({ to: '-', ok: false, detail: String(error) }); }
    finally {
        let ok = !cancelled && results.length === f.receivers.length && results.every(r => r.ok);
        closing.add(f.donor.toLowerCase());
        try { ok = !!donor && await settle([donor], ok, `fan-out ${results.filter(r => r.ok).length}/${f.receivers.length}: ${results.map(r => `${r.to} ${r.ok ? 'ok' : 'fail'}`).join(', ')}`) && ok; }
        catch (error) { ok = false; results.push({ to: '-', ok: false, detail: 'donor settlement: ' + String(error) }); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
        console.log('FANOUT_RESULT ' + JSON.stringify(results));
        console.log('FANOUT_SUMMARY ' + JSON.stringify({ ok, completed: results.filter(r => r.to !== '-' && r.ok).length, requested: f.receivers.length, cancelled }));
        process.exitCode = ok ? 0 : 1;
        return { ok, results };
    }
}

export async function itemFaninMain(args: string[], env: Record<string, string | undefined> = process.env) {
    const f = parseFanin(args), dir = join(REPO_ROOT, '.practice'), BANK = { x: 3185, z: 3436 };
    const all = [f.receiver, ...f.donors];
    const host = (name: string) => serverFromEnv(readFileSync(resolveBotEnvPath(name, REPO_ROOT), 'utf8'));
    const server = host(f.receiver);
    if (all.some(n => host(n) !== server)) throw Error('fan-in accounts must use the same server');
    assertServerAllowed(server);
    const runId = env.COORDINATOR_RUN_ID ?? '', order = transferOrderKey(env.ITEM_ORDER ?? `fanin-${Date.now()}`, 'ITEM_ORDER');
    let cancelled = false;
    const closing = new Set<string>();
    const cancel = () => { cancelled = true; };
    const sessionEnd = (name: string) => async () => { if (!closing.has(name.toLowerCase())) cancel(); };
    const check = (names: string[], open: Session[]) => {
        if (cancelled) throw Error('item fan-in cancelled');
        checkTransferAccounts(REPO_ROOT, names, server, open, runId);
    };
    const meet = meetingTiles(BANK)!;
    const results: { from: string; ok: boolean; count: number; detail: string }[] = [];
    let receiver: Session | undefined, release: (() => void) | undefined, banked = false;
    const record = { script: 'scripts/aio-logistics.ts', argv: ['item-fanin', ...args], env };
    try {
        check(all, []);
        release = acquireAccountLeases(all, runId);
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        receiver = await openBot(f.receiver, { record, onStop: async () => cancel(), onSessionEnd: sessionEnd(f.receiver) });
        const world = await getWorld();
        const to = async (s: Session, tile: typeof meet[0]) => {
            const r = await goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 100 });
            if (!r.ok) throw Error(`route to ${tile.x},${tile.z} failed for ${s.name}: ${r.reason} ${r.detail}`);
            await s.bot.walkTo(tile.x, tile.z, 0);
            if (!await waitUntil(s, () => { const p = s.sdk.getState()?.player; return !!p && p.worldX === tile.x && p.worldZ === tile.z; }, { timeoutTicks: 20 })) {
                throw Error(`meeting tile unobserved for ${s.name}`);
            }
        };
        const openBank = async (s: Session) => {
            const generation = s.bankObservation?.()?.generation ?? -1;
            if (s.sdk.getState()?.bank?.isOpen) {
                if (!(await s.bot.closeBank()).success || !await waitUntil(s, () => !s.sdk.getState()?.bank?.isOpen, { timeoutTicks: 20 })) throw Error('fan-in bank did not close: ' + s.name);
            }
            if (!(await s.bot.openBank()).success || !await waitUntil(s, () => {
                check([s.name], [s]);
                return !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? -1) > generation;
            }, { timeoutTicks: 20 })) throw Error('fan-in fresh bank unavailable: ' + s.name);
            return s.bankObservation!()!;
        };
        await to(receiver, meet[1]);
        const initialBank = await openBank(receiver), before = new Map<number, number>();
        for (const item of [...initialBank.items, ...receiver.sdk.getInventory()]) before.set(item.id, (before.get(item.id) ?? 0) + item.count);
        if (receiver.sdk.getInventory().length >= 28 && !receiver.sdk.getInventory().some(i => exactItem(f.item).test(i.name))) {
            await depositObserved(receiver, receiver.sdk.getInventory().at(-1)!);
        }
        await receiver.bot.closeBank();
        const received = new Map<number, number>();
        for (const name of f.donors) {
            if (cancelled) break;
            let donor: Session | undefined, ok = false, count = 0, detail = '';
            try {
                check([f.receiver, name], [receiver]);
                donor = await openBot(name, { record, onStop: async () => cancel(), onSessionEnd: sessionEnd(name) });
                await to(donor, meet[0]);
                const bank = await openBank(donor), row = bank.items.find(i => exactItem(f.item).test(i.name));
                if (row) {
                    const n0 = heldItems(donor.sdk.getInventory(), row.id), generation = bank.generation;
                    if (!(await donor.bot.withdrawItem(exactItem(row.name), row.count)).success || !await waitUntil(donor, () => {
                        check([f.receiver, name], [receiver!, donor!]);
                        const observed = donor!.bankObservation?.();
                        return !!observed && observed.generation > generation && heldItems(donor!.sdk.getInventory(), row.id) === n0 + row.count && heldItems(observed.items, row.id) === 0;
                    }, { timeoutTicks: 20 })) throw Error('fan-in exact withdrawal unobserved: ' + name);
                }
                if (!(await donor.bot.closeBank()).success || !await waitUntil(donor, () => !donor!.sdk.getState()?.bank?.isOpen, { timeoutTicks: 20 })) throw Error('fan-in donor bank did not close: ' + name);
                const stack = donor.sdk.getInventory().find(i => exactItem(f.item).test(i.name));
                if (!stack) { detail = `no ${f.item} in the pack or bank`; ok = true; }
                else {
                    count = heldItems(donor.sdk.getInventory(), stack.id);
                    const beforeRx = heldItems(receiver.sdk.getInventory(), stack.id);
                    const handoff = createHandoff([stack.id], join(dir, 'item-fanin', `${order}-${name}`));
                    const transfers = await Promise.allSettled([
                        handoff.sendHandoff(donor, f.receiver, server, [{ id: stack.id, count }], async () => {
                            const r = await donor!.bot.serveTrades({ from: exactItem(f.receiver), give: [{ item: exactItem(f.item), amount: count }], accept: offer => offer.length === 0, maxTrades: 1, timeout: 60_000 });
                            console.log('FANIN_TRADE ' + JSON.stringify({ account: name, result: r }));
                        }),
                        handoff.receiveHandoff(receiver, name, server, async () => {
                            const r = await receiver!.bot.trade(exactItem(name), { accept: offer => offer.length === 1 && offer[0]!.id === stack.id && offer[0]!.count === count, requestTimeout: 60_000, timeout: 60_000 });
                            console.log('FANIN_TRADE ' + JSON.stringify({ account: f.receiver, result: r }));
                        }),
                    ]);
                    const failed = transfers.find(r => r.status === 'rejected');
                    if (failed?.status === 'rejected') throw failed.reason;
                    ok = await waitUntil(receiver, () => heldItems(receiver!.sdk.getInventory(), stack.id) === beforeRx + count && heldItems(donor!.sdk.getInventory(), stack.id) === 0, { timeoutTicks: 20 });
                    detail = ok ? `${name} gave ${count} ${f.item}` : `trade effect unobserved: ${name} ${count} ${f.item}`;
                    if (ok) received.set(stack.id, (received.get(stack.id) ?? 0) + count);
                }
            } catch (error) { detail = String(error); }
            if (donor) {
                closing.add(name.toLowerCase());
                try { if (!await settle([donor], ok, detail)) { ok = false; detail += '; donor settlement failed'; } }
                catch (error) { ok = false; detail += '; donor settlement: ' + String(error); }
            }
            results.push({ from: name, ok, count, detail });
            console.log('FANIN_PAIR ' + JSON.stringify(results.at(-1)));
        }
        check([f.receiver], [receiver]);
        await openBank(receiver);
        for (const item of receiver.sdk.getInventory().filter(i => exactItem(f.item).test(i.name))) await depositObserved(receiver, item);
        const final = receiver.bankObservation?.();
        if (!final) throw Error('fan-in final bank receipt unavailable');
        banked = received.size > 0 && [...received].every(([id, count]) => heldItems(final.items, id) === (before.get(id) ?? 0) + count && heldItems(receiver!.sdk.getInventory(), id) === 0);
        if (!banked) throw Error('fan-in exact banked output unproved');
        if (!(await receiver.bot.closeBank()).success) throw Error('fan-in final bank did not close');
    } catch (error) { results.push({ from: '-', ok: false, count: 0, detail: String(error) }); }
    finally {
        let ok = !cancelled && banked && results.length === f.donors.length && results.every(r => r.ok) && results.some(r => r.count > 0);
        closing.add(f.receiver.toLowerCase());
        try { ok = !!receiver && await settle([receiver], ok, `fan-in ${results.filter(r => r.ok).length}/${f.donors.length}: ${results.map(r => `${r.from} ${r.ok ? r.count : 'fail'}`).join(', ')}`) && ok; }
        catch (error) { ok = false; results.push({ from: '-', ok: false, count: 0, detail: 'receiver settlement: ' + String(error) }); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
        console.log('FANIN_RESULT ' + JSON.stringify(results));
        console.log('FANIN_SUMMARY ' + JSON.stringify({ ok, banked, completed: results.filter(r => r.from !== '-' && r.ok).length, requested: f.donors.length, cancelled }));
        process.exitCode = ok ? 0 : 1;
        return { ok, banked, results };
    }
}

export async function noteCourierMain(argv: readonly string[], env: Record<string, string | undefined> = process.env) {
    const { courierName, bankerName, cap: CAP, maxDeliveries, reserve, server } = noteCourierPreflight(argv, env);
    const record = { script: 'scripts/aio-logistics.ts', argv: ['note-courier', ...argv], env };
    const s = await openBot(courierName, { record }).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const currentOwned = () => noteCourierOwned(courierName, bankerName, server, s.lifecycle?.server);
        currentOwned();
        await waitTicks(s, 5);
        const pos = () => s.sdk.getState()?.player, inv = () => s.sdk.getInventory();
        const delivery = () => {
            const cargo = courierCargo(inv(), reserve);
            if (cargo.blocked.length) throw new Error(`no delivery progress: ${cargo.blocked.join(', ')}`);
            return cargo.items;
        };
        const t0 = s.tick(), used = () => s.tick() - t0;
        let ended = false, died = false;
        const life = pos()?.lifeId, respawns = pos()?.respawnCount ?? 0;
        void s.ended.then(() => { ended = true; });
        const over = () => used() >= CAP || ended || died || maxDeliveries !== undefined && cycles >= maxDeliveries;
        const off = s.onTick(() => {
            const p = pos();
            if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && (p?.lifeId ?? life) !== life)) died = true;
        });
        let cycles = 0, itemsCollected = 0, tradesCompleted = 0;
        const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
            for (let i = 0; i < 3 && !over(); i++) {
                const p = pos();
                if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
                const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
                if (!r.ok) { console.log(`WALK fail ${r.detail} ticks=${r.ticks}`); await waitTicks(s, 1); }
            }
            const p = pos();
            return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
        };
        const tradeNearby = async (targetBot: string, role: 'collect' | 'deposit'): Promise<number> => {
            if (!currentOwned().has(targetBot.toLowerCase())) throw Error('note courier trade partner is not authenticated on its server');
            if (role === 'deposit' && courierCargo(inv(), reserve).blocked.includes('Trout: need-bank-separation')) {
                const readyBank = async () => {
                    if (s.sdk.getState()?.bank?.isOpen && s.bankObservation?.()) return true;
                    const generation = s.bankObservation?.()?.generation ?? 0;
                    if (!(await s.bot.openBank()).success) return false;
                    return waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, { timeoutTicks: 20 });
                };
                const notes = await separateTroutNotes({
                    inventory: inv,
                    bank: () => {
                        const state = s.sdk.getState(), observed = s.bankObservation?.();
                        if (!state?.bank?.isOpen || !observed) return null;
                        const sum = (items: readonly { id: number; count: number }[]) => items.filter(i => i.id === 333).reduce((n, i) => n + i.count, 0);
                        return sum(observed.items) === sum(state.bank.items) ? state.bank.items : null;
                    },
                    openBank: readyBank,
                    closeBank: async () => (await s.bot.closeBank()).success,
                    deposit: async item => { const current = inv().find(i => i.id === 333 && i.slot === item.slot); return !!current && (await s.bot.depositItem(current, -1)).success; },
                    withdraw: async (item, count) => { const current = s.sdk.getState()?.bank?.items.find(i => i.id === 333 && i.slot === item.slot); return !!current && (await s.bot.withdrawItem(current, count, { asNote: false })).success; },
                    observed: predicate => waitUntil(s, predicate, { timeoutTicks: 20 }),
                    tradeNotes: async count => {
                        await waitUntil(s, () => !!s.sdk.findNearbyPlayer(exactItem(targetBot)) || over(), { timeoutTicks: 180 });
                        if (over() || !s.sdk.findNearbyPlayer(exactItem(targetBot))) return { success: false, given: 0 };
                        const result = await s.bot.trade(exactItem(targetBot), { give: [{ item: exactItem('Trout'), amount: count }], accept: items => items.length === 0, timeout: 30000 });
                        return { success: result.success && result.gave.every(i => i.id === 334), given: result.gave.filter(i => i.id === 334).reduce((n, i) => n + i.count, 0) };
                    },
                });
                tradesCompleted++;
                console.log(`MILESTONE handed to ${targetBot}: ${notes} Trout notes; working food restored`);
                return notes;
            }
            if (role === 'collect') await waitUntil(s, () => !!s.sdk.findNearbyPlayer(exactItem(targetBot)) || over(), { timeoutTicks: 180 });
            const target = s.sdk.findNearbyPlayer(exactItem(targetBot));
            if (!target) return 0;
            console.log(`TRADE target ${targetBot} spotted, role=${role}`);
            if (role === 'deposit') {
                const giveItems = delivery().map(i => ({ item: exactItem(i.name), amount: i.count }));
                if (giveItems.length === 0) return 0;
                const res = await s.bot.trade(exactItem(targetBot), { give: giveItems, timeout: 30000 });
                if (res.success) {
                    tradesCompleted++;
                    console.log(`MILESTONE handed to ${targetBot}: ${res.gave.map(g => `${g.count} ${g.name}`).join(', ')}`);
                    return res.gave.reduce((n, g) => n + g.count, 0);
                }
            } else {
                const res = await s.bot.trade(exactItem(targetBot), { give: [], timeout: 30000, requestTimeout: 90000, retryOnBusy: true, accept: items => items.length > 0 });
                if (res.success) {
                    tradesCompleted++;
                    const receivedCount = res.received.reduce((n, g) => n + g.count, 0);
                    itemsCollected += receivedCount;
                    console.log(`MILESTONE received from ${targetBot}: ${res.received.map(g => `${g.count} ${g.name}`).join(', ')}`);
                    return receivedCount;
                }
            }
            return 0;
        };
        console.log(`START note-courier ${courierName} -> banker ${bankerName}`);
        const attempted = new Map<string, number>();
        const sources = () => {
            const owned = currentOwned();
            let files: string[];
            try { files = readdirSync(cargoDir); } catch { return []; }
            const p = pos();
            return files.filter(f => !f.startsWith('request-') && f.endsWith('.json')).flatMap(f => {
                try {
                    const c: Cargo = JSON.parse(readFileSync(join(cargoDir, f), 'utf8'));
                    if (typeof c.name !== 'string' || f !== `${c.name}.json` || c.server?.toLowerCase() !== server.toLowerCase() || !owned.has(c.name.toLowerCase())
                        || c.name.toLowerCase() === courierName.toLowerCase() || c.name.toLowerCase() === bankerName.toLowerCase()
                        || c.bank?.level !== 0 || !Number.isFinite(c.bank.x) || !Number.isFinite(c.bank.z)
                        || !Number.isFinite(c.at) || c.at > Date.now() || Date.now() - c.at > 1800_000
                        || !Array.isArray(c.items) || c.items.some(i => typeof i.name !== 'string' || !Number.isSafeInteger(i.count) || i.count <= 0)) return [];
                    if (!p || (p.worldX < 3000) !== (c.bank.x < 3000)) return [];
                    const status = JSON.parse(readFileSync(join(cargoDir, '../status', `${c.name}.json`), 'utf8'));
                    if (status.server?.toLowerCase() !== server.toLowerCase() || status.name?.toLowerCase() !== c.name.toLowerCase()
                        || !Number.isFinite(status.at) || status.at > Date.now() || Date.now() - status.at > 30_000 || Date.now() - (attempted.get(c.name) ?? 0) < 60_000) return [];
                    if (c.items.reduce((n, i) => n + i.count, 0) < Number(env.MIN_CARGO ?? 20)) return [];
                    return [c];
                } catch { return []; }
            }).sort((a, b) => Math.max(Math.abs(a.bank.x - (p?.worldX ?? 0)), Math.abs(a.bank.z - (p?.worldZ ?? 0))) - Math.max(Math.abs(b.bank.x - (p?.worldX ?? 0)), Math.abs(b.bank.z - (p?.worldZ ?? 0))));
        };
        while (!over()) {
            const carried = courierCargo(inv(), reserve);
            if (carried.items.length || carried.blocked.includes('Trout: need-bank-separation')) {
                if (!(await walk(ARDY_BANK.x, ARDY_BANK.z, 2))) throw new Error('cannot reach owned banker');
                const deposited = await tradeNearby(bankerName, 'deposit');
                if (!deposited) { await waitTicks(s, 15); continue; }
                cycles++;
                console.log(`MILESTONE delivered=${deposited} deliveries=${cycles} collected=${itemsCollected}`);
                if (over()) break;
            } else if (carried.blocked.length) {
                delivery();
            }
            const cargo = sources()[0];
            if (!cargo) { await waitTicks(s, 25); continue; }
            const request = join(cargoDir, `request-${cargo.name}.json`);
            writeFileSync(request, JSON.stringify({ worker: cargo.name, courier: courierName, server, at: Date.now() }));
            console.log(`MILESTONE pickup ${cargo.name} items=${cargo.items.map(i => `${i.count} ${i.name}`).join(', ')}`);
            try {
                if (await walk(cargo.bank.x, cargo.bank.z, 2)) {
                    writeFileSync(request, JSON.stringify({ worker: cargo.name, courier: courierName, server, at: Date.now(), ready: true }));
                    await tradeNearby(cargo.name, 'collect');
                }
            } finally {
                try { rmSync(request, { force: true }); }
                catch (e) {
                    if (!['ENOENT', 'EFAULT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
                    console.log(`WARN pickup request cleanup ${(e as NodeJS.ErrnoException).code}; expires after 180 seconds`);
                }
                attempted.set(cargo.name, Date.now());
            }
        }
        off();
        await finish([s], cycles > 0 && (maxDeliveries === undefined || cycles === maxDeliveries) && !died && !ended, `ticks=${used()} died=${died} deliveries=${cycles} itemsCollected=${itemsCollected} trades=${tradesCompleted}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export async function runFoodCourier(account: string, env: Record<string, string | undefined> = process.env): Promise<void> {
    type Pt = [number, number, number];
    const DRAYNOR = { x: 3092, z: 3243 };
    const BRIM_DECK = { x: 2775, z: 3234 };
    const SARIM_DECK = { x: 3032, z: 3217 };
    const MUSA_DECK = { x: 2956, z: 3143 };
    const ARDY_DECK = { x: 2683, z: 3268 };
    const SOURCES = (env.FROM ?? '').split(',').map(n => n.trim()).filter(Boolean);
    let FROM = SOURCES[0] ?? '';
    const WAIT = Number(env.WAIT ?? 1500);
    const CAP = Number(env.CAP ?? 3000);
    const FARMERS = (env.FARMERS ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const PER = env.PER ? Number(env.PER) : 0;
    const TOTAL_PER = Number(env.TOTAL_PER ?? 0);
    courierFoodAllocation([], 0, PER, TOTAL_PER);
    const HOME_ONLY = env.HOME_ONLY === '1';
    const OUTBOUND_ONLY = env.OUTBOUND_ONLY === '1';
    const START_DRAYNOR = env.START === 'draynor' || HOME_ONLY;
    const FEATHERS = Number(env.FEATHERS ?? 0);
    const FUND_FROM = env.FUND_FROM?.trim() || '';
    const FUND_ONLY = env.FUND_ONLY === '1';
    const RESERVE_OPENING_CASH = env.RESERVE_OPENING_CASH === '1';
    const FISH = COOKED_FOOD;
    const SARIM_TO_DRAYNOR: Pt[] = [[3047, 3237, 3], [3060, 3265, 3], [3089, 3266, 2], [3092, 3250, 1], [DRAYNOR.x, DRAYNOR.z, 2]];
    const DRAYNOR_TO_SARIM: Pt[] = [[3092, 3250, 1], [3089, 3266, 2], [3060, 3265, 3], [3047, 3237, 3], [3029, 3217, 3]];

    if (OUTBOUND_ONLY && START_DRAYNOR) { console.log('RESULT fail OUTBOUND_ONLY requires an Ardougne start'); process.exitCode = 1; return; }
    if (!FROM && !HOME_ONLY && !OUTBOUND_ONLY && !FUND_ONLY) { console.log('RESULT fail FROM=<fish cook account> is required'); process.exitCode = 1; return; }
    if (FUND_ONLY && (!FUND_FROM || HOME_ONLY || OUTBOUND_ONLY || START_DRAYNOR) || RESERVE_OPENING_CASH && !FUND_ONLY) { console.log('RESULT fail funding-only requires FUND_FROM at the destination bank'); process.exitCode = 1; return; }
    if (SOURCES.some(n => !/^[A-Za-z0-9_ -]{1,12}$/.test(n))) { console.log('RESULT fail invalid food source account'); process.exitCode = 1; return; }

    const handoffHelper = createHandoff([330, 334, 380], join(REPO_ROOT, '.practice/courier-handoffs'));
    const s = await openBot(account).catch(e => finish([], false, `login: ${String(e)}`));
    try {
        const courierServer = s.lifecycle?.server ?? serverFromEnv(readFileSync(resolveBotEnvPath(s.name, REPO_ROOT), 'utf8'));
        const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
        const pos = () => s.sdk.getState()?.player;
        const cheb = (a: { x: number; z: number }, p: { worldX: number; worldZ: number }) => Math.max(Math.abs(a.x - p.worldX), Math.abs(a.z - p.worldZ));
        const inv = () => (s.sdk.getState()?.inventory ?? []) as any[];
        const notes = () => inv().filter(i => FISH.test(i.name) && !(i.optionsWithIndex ?? []).some((o: any) => /^eat$/i.test(o.text)));
        const fishNotes = () => notes().reduce((n, i) => n + i.count, 0);
        const coins = () => countItems(s, /^coins$/i);
        await waitTicks(s, 3);
        let hpMin = hp(), died = false, last = pos();
        const jumps: string[] = [];
        const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
        const off = s.onTick(() => {
            const p = pos();
            hpMin = Math.min(hpMin, hp());
            if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
            if (p && last && cheb({ x: last.worldX, z: last.worldZ }, p) > 20) jumps.push(`${s.tick()}:${last.worldX},${last.worldZ}->${p.worldX},${p.worldZ},${p.level}`);
            last = p;
        });
        const t0 = s.tick(), used = () => s.tick() - t0, over = () => used() >= CAP;
        let walkTicks = 0, boatTicks = 0, waitTicksAt = 0, giveTicks = 0, received = 0, handed = 0, featherTicks = 0, feathersBought = 0;
        const legs: string[] = [];
        const leg = (name: string) => { legs.push(`${name}@${used()}`); console.log(`MILESTONE ${name} ${used()}`); };
        const timed = async <T>(add: (n: number) => void, f: () => Promise<T>): Promise<T> => { const a = s.tick(); try { return await f(); } finally { add(s.tick() - a); } };
        const detail = () => `ticks=${used()} received=${received} handed=${handed} fishNotes=${fishNotes()} coins=${coins()} walkTicks=${walkTicks} boatTicks=${boatTicks} waitTicks=${waitTicksAt} giveTicks=${giveTicks} featherTicks=${featherTicks} feathersBought=${feathersBought} feathersLeft=${countItems(s, /^feather$/i)} legs=${legs.join(',')} hpMin=${hpMin} died=${died} jumps=${jumps.join(';')}`;
        const fail = async (why: string): Promise<never> => {
            off();
            const p = pos();
            return finish([s], false, `${why} at=${p?.worldX},${p?.worldZ},${p?.level} ${detail()}`);
        };
        const walk = (points: Pt[]): Promise<boolean> => timed(n => walkTicks += n, async () => {
            const [gx, gz, gtol] = points[points.length - 1]!;
            let left = points.map(([x, z, tol]) => ({ x, z, tol }));
            for (let i = 0; i < 3 && !died && !over(); i++) {
                const p = pos();
                if (p && p.level === 0 && cheb({ x: gx, z: gz }, p) <= gtol + 1) break;
                const r = await walkPath(await sessionWalker(s), left, { stop: () => died || over() });
                if (!r.ok) { console.log(`WALK fail ${r.detail} ticks=${r.ticks}`); await waitTicks(s, 1); }
                left = left.slice(Math.min(r.next, left.length - 1));
            }
            const p = pos();
            return !died && !!p && cheb({ x: gx, z: gz }, p) <= gtol + 1;
        });
        const stopBoat = () => died || over();
        const disembark = (): Promise<boolean> => timed(n => boatTicks += n, async () => (await disembarkBoat(s, { stop: stopBoat })).ok);
        const sail = (npc: RegExp, pats: RegExp[], deck: { x: number; z: number }): Promise<boolean> =>
            timed(n => boatTicks += n, async () => (await sailBoat(s, { npc, choices: pats, deck, stop: stopBoat, onTalkFail: m => console.log(`TALK fail ${m}`) })).ok);
        const CUSTOMS = [/journey on this ship/i, /search away/i, /^ok\.?$/i];
        const SAILOR = [/^yes please/i];
        const FEATHER = /^feather$/i;
        const buyFeathers = () => timed(n => featherTicks += n, async () => {
            let source: any;
            if (/^[A-Za-z0-9_ -]{1,12}$/.test(FROM)) try { source = JSON.parse(readFileSync(join(REPO_ROOT, '.practice', 'status', `${FROM}.json`), 'utf8')); } catch { /* unknown */ }
            const wanted = featherPurchaseAmount(FEATHERS, FROM, source, Date.now(), courierServer);
            if (wanted <= 0) { console.log(`MILESTONE feathers-sufficient t=${used()}`); return; }
            if (!(await walk([[3014, 3224, 2]]))) { console.log('WARN walk to Gerrant failed'); return; }
            const o = await s.bot.openShop(/^gerrant$/i);
            if (!o.success) { console.log(`WARN openShop ${o.message}`); await waitTicks(s, 1); return; }
            const f0 = countItems(s, FEATHER);
            for (let i = 0; i < 20 && countItems(s, FEATHER) - f0 < wanted; i++) {
                const n = featherBatchAmount(coins(), wanted - (countItems(s, FEATHER) - f0));
                if (n <= 0) break;
                const before = countItems(s, FEATHER), coinsBefore = coins(), tickBefore = s.tick();
                const b = await s.bot.buyFromShop(FEATHER, n);
                const effect = featherPurchaseEffect(coinsBefore, before, coins(), countItems(s, FEATHER), n);
                console.log('FEATHER_PURCHASE_RECEIPT ' + JSON.stringify({ account: s.name, server: courierServer, supplier: FROM, requested: n, coinsBefore, coinsAfter: coins(), feathersBefore: before, feathersAfter: countItems(s, FEATHER), ...effect, tickBefore, tickAfter: s.tick(), sdkSuccess: b.success }));
                if (effect.bought === 0) { console.log(`WARN buy feathers ${b.message}`); break; }
            }
            feathersBought = countItems(s, FEATHER) - f0;
            await s.bot.closeShop();
            console.log(`MILESTONE feathers ${feathersBought} coins=${coins()} t=${used()}`);
        });

        const p0 = pos();
        const resume = !HOME_ONLY && !OUTBOUND_ONLY ? deliveryResume(p0, fishNotes(), FARMERS.length) : null;
        const islandProblem = courierIslandProblem(p0?.combatLevel);
        if (resume !== 'bank' && islandProblem) await fail(islandProblem);
        if (SOURCES.length > 1 && !resume && !HOME_ONLY) {
            const statuses = SOURCES.flatMap(name => { try { return [JSON.parse(readFileSync(join(REPO_ROOT, '.practice', 'status', `${name}.json`), 'utf8'))]; } catch { return []; } });
            const selected = selectCookedFoodSource(SOURCES, statuses, ownedAccounts(courierServer), Date.now(), 1, courierServer);
            if (!selected) await fail('no active owned cook with banked food');
            FROM = selected!;
        }
        if (OUTBOUND_ONLY && (!p0 || p0.level !== 0 || cheb(ARDY_BANK, p0) > 10)) await fail('outbound supply trip requires Ardougne bank start');
        if (FUND_ONLY && RESERVE_OPENING_CASH) {
            if (!p0 || p0.level !== 0 || cheb(ARDY_BANK, p0) > 6) await fail('opening cash reservation requires the funding bank');
            const amount = coins();
            if (amount > 0) {
                if (!(await s.bot.openBank()).success) await fail('opening cash bank unavailable');
                const item = s.sdk.getInventory().find(i => i.id === 995);
                if (!item || await depositObserved(s, item) !== amount) await fail('opening cash reservation unconfirmed');
                await s.bot.closeBank();
            }
            console.log('OPENING_CASH_RESERVED ' + JSON.stringify({ account: s.name, server: courierServer, amount, held: coins(), tick: s.tick() }));
        }
        let funding: { received: number; reason: string } | undefined;
        if (FUND_FROM) {
            funding = await requestCourierFunding(s, FUND_FROM, courierServer);
            console.log(`FUNDING_RECEIPT received=${funding.received} reason=${funding.reason} coins=${coins()}`);
        }
        if (FUND_ONLY) {
            if (!funding || !['paid', 'sufficient'].includes(funding.reason) || coins() < BOAT_FARES_ROUND) await fail('consumer funding unavailable');
            off();
            await finish([s], true, `fundingOnly=true received=${funding!.received} coins=${coins()} at=${p0?.worldX},${p0?.worldZ},${p0?.level}`);
            return;
        }
        console.log(`FOODCOURIER from=${FROM} farmers=${FARMERS.join(',') || '-'} coins=${coins()} fishNotes=${fishNotes()} at=${p0?.worldX},${p0?.worldZ}`);
        const start = START_DRAYNOR || resume ? null : outboundStart(p0);
        if (start === 'refuse') await fail('no courier progress: start is not an Ardougne bank or east of White Wolf Mountain');
        if (start === 'boat-north' || resume === 'bank' && outboundStart(p0) === 'boat-north') {
            if (!(await walk([[NORTH_TO_SOUTH.x, NORTH_TO_SOUTH.z, 2], [ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('walk to Ardougne south bank');
        }
        if (start !== null) {
            const requiredFare = OUTBOUND_ONLY ? BOAT_FARES_OUT : BOAT_FARES_ROUND;
            if (coins() < requiredFare) {
                const o = await s.bot.openBank();
                if (o.success) {
                    for (const item of [...new Set(inv().filter(i => !/^coins$/i.test(i.name) && !notes().some(n => n.slot === i.slot)).map(i => i.name as string))]) {
                        await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                    }
                    await s.bot.withdrawItem(/^coins$/i, 500);
                    await s.bot.closeBank();
                }
                console.log(`MILESTONE fares from bank coins=${coins()} t=${used()}`);
            }
            if (start === 'land') {
                console.log('MILESTONE east start; land route to Port Sarim');
                if (!(await walk([[SARIM.x, SARIM.z, 3]]))) await fail('land route to Port Sarim');
                leg('land-sarim');
            } else if (coins() < requiredFare) {
                await fail(`no courier progress: needs ${requiredFare} coins for the boat fares; refusing the White Wolf Mountain land route`);
            } else {
                if (!(await walk([[2679, 3275, 3]]))) await fail('walk to Barnaby');
                if (!(await sail(/^captain barnaby$/i, SAILOR, BRIM_DECK))) await fail('sail to Brimhaven');
                if (!(await disembark())) await fail('Brimhaven gangplank');
                if (!(await walk([[2774, 3228, 3], [2800, 3200, 5], [2850, 3175, 5], [2920, 3160, 5], [2956, 3146, 3]]))) await fail('walk to Musa Point');
                if (!(await sail(/^customs officer$/i, CUSTOMS, SARIM_DECK))) await fail('sail to Port Sarim');
                if (!(await disembark())) await fail('Port Sarim gangplank');
                leg('sarim');
            }
            if (FEATHERS > 0) await buyFeathers();
            if (!(await walk(SARIM_TO_DRAYNOR))) await fail('walk to Draynor bank');
            leg('draynor');
        }
        if (OUTBOUND_ONLY) {
            off();
            const p = pos();
            await finish([s], !died && !!p && p.level === 0 && cheb(DRAYNOR, p) <= 4, `outboundOnly=true ${detail()} coins=${coins()} at=${p?.worldX},${p?.worldZ},${p?.level}`);
            return;
        }
        const fromKaramja = (HOME_ONLY || resume === 'karamja') && onKaramja(pos());
        if (START_DRAYNOR && !fromKaramja) {
            if (!(await walk(draynorApproach(pos())))) await fail('walk to Draynor bank');
            if (coins() < 60) {
                const o = await s.bot.openBank();
                if (o.success) {
                    for (const item of [...new Set(inv().filter(i => !/^coins$/i.test(i.name) && !notes().some(n => n.slot === i.slot)).map(i => i.name as string))]) {
                        await s.bot.depositItem(new RegExp(`^${item}$`, 'i'), -1);
                    }
                    await s.bot.withdrawItem(/^coins$/i, 200);
                    await s.bot.closeBank();
                }
            }
            leg(`draynor coins=${coins()}`);
        }
        const before = fishNotes(), who = new RegExp(`^${FROM.replace(/[^a-zA-Z0-9 _-]/g, '')}$`, 'i');
        if (!resume) await timed(n => waitTicksAt += n, async () => {
            console.log(`MILESTONE collecting ${FROM}`);
            const deadline = s.tick() + (HOME_ONLY ? 0 : WAIT);
            while (fishNotes() <= before && s.tick() < deadline && !died) {
                await handoffHelper.awaitCollectionOffer(s, FROM, courierServer, Math.max(1, deadline - s.tick()));
                const give = countItems(s, FEATHER) > 0 ? [{ item: FEATHER, amount: -1 }] : [];
                const collection = await handoffHelper.collectHandoff(s, FROM, courierServer, () =>
                    s.bot.serveTrades({ from: who, maxTrades: 1, give, timeout: Math.max(1000, (deadline - s.tick()) * 400) }));
                received += collection.received;
                const r = collection.result;
                if (fishNotes() <= before) { console.log(`TRADE ${r.reason} ${r.message}`); await waitTicks(s, 1); }
            }
        });
        leg(`received${received}`);
        if (received <= 0 && !HOME_ONLY && !resume) await fail('no fish notes from the cook');
        if (resume) leg(`resumed-cargo-${resume}`);
        if (resume !== 'bank') {
            const fareNeed = fromKaramja ? BOAT_FARES_OUT / 2 : BOAT_FARES_OUT;
            if (coins() < fareNeed && !fromKaramja) {
                const o = await s.bot.openBank();
                if (o.success) { await s.bot.withdrawItem(/^coins$/i, 200); await s.bot.closeBank(); }
                console.log(`MILESTONE home fares from Draynor bank coins=${coins()} t=${used()}`);
            }
            if (coins() < fareNeed) {
                await fail(`no courier progress: needs ${fareNeed} coins for the boats home; refusing the White Wolf Mountain land route`);
            } else {
                if (!fromKaramja) {
                    if (!(await walk(DRAYNOR_TO_SARIM))) await fail('walk to Port Sarim');
                    if (!(await sail(/^(seaman|captain tobias)/i, SAILOR, MUSA_DECK))) await fail('sail to Karamja');
                    if (!(await disembark())) await fail('Musa Point gangplank');
                } else console.log(`MILESTONE resume on Karamja t=${used()}`);
                const toBrim: Pt[] = [[2920, 3160, 5], [2850, 3175, 5], [2800, 3200, 5], [2774, 3228, 3]];
                const px = pos()?.worldX ?? 9999;
                if (!(await walk(toBrim.filter(([x], i) => i === toBrim.length - 1 || x < px)))) await fail('walk to Brimhaven');
                if (!(await sail(/^customs officer$/i, CUSTOMS, ARDY_DECK))) await fail('sail to Ardougne');
                if (!(await disembark())) await fail('Ardougne gangplank');
                if (!(await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('walk to Ardougne bank');
                leg('ardougne');
            }
        }
        const recipients = FARMERS.flatMap(name => {
            if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return [];
            try {
                const status = JSON.parse(readFileSync(join(REPO_ROOT, '.practice', 'status', `${name}.json`), 'utf8'));
                const need = cookedFoodRestock(name, status, Date.now(), courierServer);
                return need !== undefined && need > 0 ? [{ name, need }] : [];
            } catch { return []; }
        }).sort((a, b) => b.need - a.need);
        console.log(`MILESTONE delivery-demand ${recipients.map(r => `${r.name}:${r.need}`).join(',') || 'none'} t=${used()}`);
        await timed(n => giveTicks += n, async () => {
            for (const { name: f, need } of recipients) {
                const cargo = notes(), amounts = courierFoodAllocation(cargo.map(i => i.count), need, PER, TOTAL_PER);
                const give = cargo.map((i, index) => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: amounts[index]! })).filter(g => g.amount > 0);
                if (give.length === 0) break;
                const n0 = fishNotes(), isNorth = /^mightyrod$/i.test(f);
                if (isNorth) await walk([[2644, 3293, 2], [NORTH_BANK.x, NORTH_BANK.z, 2]]);
                else if (!(await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]))) await fail('delivery bank rendezvous');
                const meetBank = isNorth ? NORTH_BANK : ARDY_BANK, meetDeadline = s.tick() + 180;
                const ready = () => deliveryRecipientAtBank(pos(), s.sdk.getState()?.nearbyPlayers ?? [], f, meetBank);
                for (let tryN = 0; tryN < 3 && fishNotes() === n0 && !died; tryN++) {
                    if (!(await walk([[meetBank.x, meetBank.z, 2]]))) break;
                    if (!ready() && s.tick() < meetDeadline) await waitUntil(s, () => ready() || died || over(), { timeoutTicks: meetDeadline - s.tick() });
                    if (!ready() || died || over()) { console.log(`WARN rendezvous ${f} not at delivery bank`); break; }
                    const expected = give.map(g => ({ id: notes().find(i => g.item.test(i.name))!.id, count: g.amount }));
                    const delivered = await handoffHelper.sendHandoff(s, f, courierServer, expected, () =>
                        s.bot.trade(new RegExp(`^${f}$`, 'i'), { give, timeout: 60_000, requestTimeout: 30_000, retryOnBusy: false }));
                    handed += delivered;
                    console.log(`MILESTONE gave ${f} ${delivered} t=${used()}`);
                    break;
                }
            }
        });
        { const q = pos(); if (q && cheb(ARDY_BANK, q) > 6 && cheb(NORTH_BANK, q) > 6) await walk([[ARDY_BANK.x, ARDY_BANK.z, 2]]); }
        off();
        const p = pos();
        const ok = !died && (received > 0 || HOME_ONLY || !!resume) && !!p && (cheb(ARDY_BANK, p) <= 6 || cheb(NORTH_BANK, p) <= 6) && (FARMERS.length === 0 || handed > 0 || recipients.length === 0);
        await finish([s], ok, `${detail()} at=${p?.worldX},${p?.worldZ},${p?.level}`);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

export const FOOD_CHAIN_SCRIPTS = {
    cook: { script: 'scripts/aio-skiller.ts', extraArgs: ['gather', 'fishing', 'fishcook'] },
    farmer: { script: 'scripts/aio-skiller.ts', extraArgs: ['gather', 'thieving', 'knights'] },
    foodCourier: { script: 'scripts/aio-logistics.ts', extraArgs: ['food-courier'] },
    banker: { script: 'scripts/aio-logistics.ts', extraArgs: ['banker'] },
} as const;

export async function runFoodChain(args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<void> {
    const prac = join(REPO_ROOT, '.practice'), logDir = join(prac, 'foodchain-logs');
    const COOK = args[0] ?? 'Mightyrod';
    const COURIER = args[1] ?? 'Bigpackage';
    let FARMERS = (args[2] ?? 'Pocketrocket,mmtha0205').split(',').map(x => x.trim()).filter(Boolean);
    const CONF = join(REPO_ROOT, '.practice', 'foodchain.json');
    const MIN_FISH = Number(env.MIN_FISH ?? 100), LOW = Number(env.LOW ?? 40), MIN_GIVE = Number(env.MIN_GIVE ?? 8);
    if (env.DEMO_OK !== '1') throw Error('foodchain: set DEMO_OK=1 (live server)');
    if ([COOK, COURIER, ...FARMERS].some(a => /^haggis$/i.test(a))) throw Error('foodchain: the main account is never part of the chain');
    const FOOD = /^(trout|salmon|lobster|swordfish|shark|tuna|bread|cake|meat|cooked chicken)$/i;
    type Status = { name: string; at: number; result?: string; phase?: string; inventory?: any[]; bank?: any[] | null; pos?: { x: number; z: number } };
    const status = (a: string): Status | null => { try { return JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8')); } catch { return null; } };
    const count = (l: any[] | null | undefined, re: RegExp) => (l ?? []).filter(i => re.test(i?.name ?? '')).reduce((n, i) => n + (i.count ?? 0), 0);
    const say = (t: string) => { const l = `${new Date().toISOString().slice(11, 19)} ${t}`; console.log(l); appendFileSync(join(prac, 'foodchain.log'), l + '\n'); };
    const readConf = () => { try { const f = JSON.parse(readFileSync(CONF, 'utf8')).farmers; if (Array.isArray(f) && f.every(x => typeof x === 'string' && /^[A-Za-z0-9 _-]{1,12}$/.test(x) && !/^haggis$/i.test(x))) { if (f.join() !== FARMERS.join()) say(`farmers ${f.join(',')}`); FARMERS = f; } } catch { /* keep */ } };
    const running = new Map<string, { proc: ReturnType<typeof Bun.spawn>; log: string; started: number }>(), dead = new Set<string>();
    let courierBusy = false;
    const DRY = env.DRY === '1';
    const readLog = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
    // The chain removes only the stop files it wrote itself ('foodchain'); any other stop file is a pause it honours.
    const ownerStopped = (a: string) => { try { return readFileSync(join(prac, `stop-${a}`), 'utf8').trim() !== 'foodchain'; } catch { return false; } };
    function start(account: string, script: string, childEnv: Record<string, string>, tag = script, extraArgs: readonly string[] = []): string {
        if (running.has(account)) throw new Error(`${account} already runs`);
        if (DRY) { say(`DRY would start ${account} ${tag} ${JSON.stringify(childEnv)}`); return ''; }
        if (ownerStopped(account)) { say(`skip ${account} ${tag}: stop file`); return ''; }
        const log = join(logDir, `${account}-${Date.now()}.log`);
        rmSync(join(prac, `stop-${account}`), { force: true });
        const proc = Bun.spawn(['bun', script, account, ...extraArgs], { cwd: REPO_ROOT, env: { ...env, DEMO_OK: '1', RANDOM_EVENTS: '0', ...childEnv }, stdout: Bun.file(log), stderr: Bun.file(log + '.err'), windowsHide: true });
        running.set(account, { proc, log, started: Date.now() });
        say(`start ${account} ${tag} ${JSON.stringify(childEnv)}`);
        void proc.exited.then(() => {
            running.delete(account);
            const res = (readLog(log).match(/^RESULT .*$/m) ?? [''])[0];
            say(`end ${account} ${res.slice(0, 160)}`);
            if (/died=true|fail died/.test(res)) { dead.add(account); say(`DEAD ${account}: never started again`); }
        });
        return log;
    }
    const until = async (f: () => boolean, ms: number) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await Bun.sleep(2000); return f(); };
    const external = (a: string) => !running.has(a) && (() => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs < 30_000; } catch { return false; } })();
    const runOnce = async (account: string, script: string, childEnv: Record<string, string>, ms: number, extraArgs: readonly string[] = []) => {
        const log = start(account, script, childEnv, script, extraArgs);
        await until(() => !running.has(account), ms);
        return readLog(log);
    };
    const farmerFood = (a: string) => { const s = status(a); return count(s?.inventory, FOOD) + count(s?.bank, FOOD); };
    const courierFish = () => count(status(COURIER)?.inventory, /^(trout|salmon)$/i);
    const courierCoins = () => count(status(COURIER)?.inventory, /^coins$/i);
    const lastTry = new Map<string, number>();
    const waitingFarmer = () => FARMERS.find(f => {
        const r = running.get(f);
        if (!r || Date.now() - (lastTry.get(f) ?? 0) < 120_000) return false;
        const last = readLog(r.log).split(/\r?\n/).filter(l => /^(MILESTONE|TRADE|BANK|RESULT)\b/.test(l)).pop() ?? '';
        return /waiting for food trade/.test(last);
    });
    async function runGive(giver: string, receiver: string, give: string) {
        if (DRY) { say(`DRY would give ${giver} -> ${receiver} ${give}`); return false; }
        if (ownerStopped(giver)) { say(`skip give ${giver} -> ${receiver}: stop file`); return false; }
        const log = join(logDir, `${giver}-give-${Date.now()}.log`);
        rmSync(join(prac, `stop-${giver}`), { force: true });
        const proc = Bun.spawn(['bun', 'scripts/aio-logistics.ts', giver, 'give-to-banker', receiver], { cwd: REPO_ROOT, env: { ...env, DEMO_OK: '1', RANDOM_EVENTS: '0', GIVE: give }, stdout: Bun.file(log), stderr: Bun.file(log + '.err'), windowsHide: true });
        running.set(giver, { proc, log, started: Date.now() });
        say(`give ${giver} -> ${receiver} ${give}`);
        await proc.exited;
        running.delete(giver);
        const out = readLog(log);
        say(`give done: ${(out.match(/^RESULT .*$/m) ?? ['no RESULT'])[0].slice(0, 120)}`);
        return /^RESULT ok/m.test(out);
    }
    async function giveFish(farmer: string) {
        courierBusy = true;
        lastTry.set(farmer, Date.now());
        try {
            const inv = status(COURIER)?.inventory, hungry = Math.max(1, FARMERS.filter(f => !dead.has(f) && farmerFood(f) < LOW).length);
            const share = (re: RegExp) => Math.ceil(count(inv, re) / hungry);
            const give = [['Trout', share(/^trout$/i)], ['Salmon', share(/^salmon$/i)]].filter(([, n]) => (n as number) > 0).map(([k, n]) => `${k}:${n}`).join(',');
            if (give) await runGive(COURIER, farmer, give);
        } finally { courierBusy = false; }
    }
    async function topUpFares() {
        const donor = FARMERS.find(f => !running.has(f) && !external(f) && !dead.has(f) && !ownerStopped(f));
        if (!donor) return false;
        courierBusy = true;
        try {
            const bankLog = start(COURIER, 'scripts/aio-logistics.ts', {}, 'banker (fares)', ['banker']);
            await until(() => /MILESTONE banking/.test(readLog(bankLog)) || !running.has(COURIER), 120_000);
            const ok = running.has(COURIER) && await runGive(donor, COURIER, 'Coins:1000');
            writeFileSync(join(prac, `stop-${COURIER}`), 'foodchain');
            await until(() => !running.has(COURIER), 200_000);
            say(`fares from ${donor}: ${ok ? 'ok' : 'failed'}`);
            return ok;
        } finally { courierBusy = false; }
    }
    mkdirSync(logDir, { recursive: true });
    say(`foodchain cook=${COOK} courier=${COURIER} farmers=${FARMERS.join(',')} minFish=${MIN_FISH} low=${LOW}`);
    const loop = async (): Promise<boolean> => {
        readConf();
        if (existsSync(join(prac, 'stop-foodchain'))) {
            if (running.size === 0) { say('stopped (stop-foodchain)'); return false; }
            return true;
        }
        if (!running.has(COOK) && !external(COOK) && !dead.has(COOK) && !ownerStopped(COOK)) {
            start(COOK, FOOD_CHAIN_SCRIPTS.cook.script, { TICKS: '9000', GIVE_TO: COURIER }, 'fishcook', FOOD_CHAIN_SCRIPTS.cook.extraArgs);
        }
        if (courierBusy) return true;
        const w = waitingFarmer();
        if (w && courierFish() >= MIN_GIVE && !running.has(COURIER) && !ownerStopped(COURIER)) { void giveFish(w); return true; }
        for (const f of FARMERS) {
            if (running.has(f) || external(f) || dead.has(f) || ownerStopped(f)) continue;
            if (farmerFood(f) >= 5 || courierFish() >= MIN_GIVE) {
                start(f, FOOD_CHAIN_SCRIPTS.farmer.script, { FOOD_FROM: COURIER, FOOD_ONLY_TRADE: '1' }, 'goldfarm', FOOD_CHAIN_SCRIPTS.farmer.extraArgs);
            }
        }
        if (running.has(COURIER) || external(COURIER) || dead.has(COURIER) || ownerStopped(COURIER) || courierFish() >= MIN_GIVE) return true;
        const ready = count(status(COOK)?.bank, /^(trout|salmon)$/i);
        const low = FARMERS.filter(f => !dead.has(f)).some(f => farmerFood(f) < LOW);
        if (ready < MIN_FISH || !low) return true;
        if (courierCoins() < 120) { if (!(await topUpFares())) return true; }
        courierBusy = true;
        void runOnce(COURIER, FOOD_CHAIN_SCRIPTS.foodCourier.script, { FROM: COOK, FEATHERS: '0', WAIT: '1500' }, 3_600_000, FOOD_CHAIN_SCRIPTS.foodCourier.extraArgs).finally(() => { courierBusy = false; });
        return true;
    };
    while (true) {
        try { if (!await loop()) return; } catch (e) { say(`error ${String(e)}`); }
        await Bun.sleep(15_000);
    }
}

export async function prepareFleetSender(
    s: Session,
    order: Order,
    progress: FleetTradeProgress,
    wait: typeof waitUntil = waitUntil,
): Promise<void> {
    if (!validOrder(order)) return;
    const orderLineMatches = (r: { id: number; name: string }, re: RegExp, itemId?: number) => {
        if (!re.test(r.name)) return false;
        if (itemId === undefined) return true;
        const def = itemDefinition(s, r.id);
        const base = def && typeof def.certtemplate === 'number' && def.certtemplate !== -1 && typeof def.certlink === 'number' && def.certlink >= 0 ? def.certlink : r.id;
        return base === itemId;
    };
    const allLines = orderLines(order);
    const prep = allLines
        .map((line, i) => {
            const item = exactItem(line.item);
            const wrongId = line.itemId !== undefined && s.sdk.getInventory().some(r => item.test(r.name) && !orderLineMatches(r, item, line.itemId));
            const heldTotal = line.itemId === undefined
                ? countItems(s, item)
                : s.sdk.getInventory().filter(r => orderLineMatches(r, item, line.itemId)).reduce((n, r) => n + r.count, 0);
            return { line, i, item, wrongId, need: heldTotal < line.count };
        })
        .filter(l => l.need || l.wrongId);
    if (!prep.length) return;

    if (!(await s.bot.openBank()).success || !await wait(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) {
        throw Error('bank did not open');
    }

    const depositRow = async (
        row: Parameters<Session['bot']['depositItem']>[0],
        done: () => boolean,
        errorDetail: string,
    ) => {
        const generation = s.bankObservation?.()?.generation ?? -1;
        progress.uncertain = true;
        await s.bot.depositItem(row, -1);
        if (!await wait(s, () => (s.bankObservation?.()?.generation ?? -1) > generation && done(), { timeoutTicks: 10 })) {
            throw Error(errorDetail);
        }
        progress.uncertain = false;
    };

    const matchesAnyOrderLine = (r: { id: number; name: string }) =>
        allLines.some(l => orderLineMatches(r, exactItem(l.item), l.itemId));

    for (const { line, i, item } of prep) {
        const held = () => line.itemId === undefined
            ? countItems(s, item)
            : s.sdk.getInventory().filter(r => orderLineMatches(r, item, line.itemId)).reduce((n, r) => n + r.count, 0);

        if (line.itemId !== undefined) {
            for (const wrong of [...new Map(s.sdk.getInventory().filter(r => item.test(r.name) && !orderLineMatches(r, item, line.itemId)).map(r => [r.id, r])).values()]) {
                await depositRow(
                    wrong,
                    () => !s.sdk.getInventory().some(r => r.id === wrong.id),
                    `sender conflicting ${line.item}#${wrong.id} deposit not confirmed`,
                );
            }
        }
        const loose = s.sdk.getInventory().filter(r => orderLineMatches(r, item, line.itemId) && r.count === 1);
        if (line.count > 1 && !/^coins$/i.test(line.item) && loose.length) {
            await depositRow(
                loose[0]!,
                () => !s.sdk.getInventory().some(r => orderLineMatches(r, item, line.itemId) && r.count === 1),
                `sender loose ${line.item} deposit not confirmed`,
            );
        }
        if (held() >= line.count) continue;

        const bankBefore = s.bankObservation?.();
        const row = bankBefore?.items.find(r => orderLineMatches(r, item, line.itemId));
        const amount = line.count - held(), bankCount = row?.count ?? 0;
        if (!bankBefore || !row || bankCount < amount) throw Error(`stock short: ${line.item} ${bankCount} banked + ${held()} held < ${line.count}`);
        const target = s.sdk.getState()?.bank.items.find(r => r.id === row.id);
        if (!target) throw Error(`sender bank item is unavailable: ${line.item}`);

        const stack = s.sdk.getInventory().find(r => orderLineMatches(r, item, line.itemId));
        // Copy the fields at once: the client lends shared definition objects, and noteIdOf reads others.
        const rowDef = itemDefinition(s, row.id);
        const rowStackable = rowDef?.stackable === true, rowLinkKnown = typeof rowDef?.certlink === 'number';
        const inherentlyStackable = /^coins$/i.test(line.item)
            || rowStackable
            || (!!stack && stack.id === row.id && stack.count > 1);
        const unnoteable = amount > 1 && !inherentlyStackable && rowLinkKnown && noteIdOf(s, row.id) === undefined;
        const asNote = amount > 1 && !inherentlyStackable && !unnoteable;
        const neededSlots = inherentlyStackable
            ? (stack ? 0 : 1)
            : asNote
                ? (stack && stack.id !== row.id ? 0 : 1)
                : amount;

        if (28 - s.sdk.getInventory().length < neededSlots) {
            const unrelated = s.sdk.getInventory().filter(r => !matchesAnyOrderLine(r));
            // Free non-coin multi-slot items first so full packs clear in minimal bank calls.
            const slotCounts = new Map<number, number>();
            for (const r of unrelated) slotCounts.set(r.id, (slotCounts.get(r.id) ?? 0) + 1);
            const sortedIds = [...new Set(unrelated.map(r => r.id))].sort((a, b) => {
                if (a === 995) return 1;
                if (b === 995) return -1;
                return (slotCounts.get(b) ?? 0) - (slotCounts.get(a) ?? 0);
            });
            for (const id of sortedIds) {
                if (28 - s.sdk.getInventory().length >= neededSlots) break;
                const candidate = s.sdk.getInventory().find(r => r.id === id);
                if (!candidate) continue;
                await depositRow(
                    candidate,
                    () => !s.sdk.getInventory().some(r => r.id === id),
                    `sender pack space deposit not confirmed: ${candidate.name}`,
                );
            }
            const freeAfter = 28 - s.sdk.getInventory().length;
            if (freeAfter < neededSlots) {
                throw Error(`sender pack full: need ${neededSlots} slots for ${line.item}, ${freeAfter} free`);
            }
        }

        progress.uncertain = true;
        await s.bot.withdrawItem(target, amount, { asNote });
        const confirmed = () => {
            const after = s.bankObservation?.();
            const remaining = after?.items.filter(r => r.id === row.id).reduce((n, r) => n + r.count, 0);
            return after && after.generation > bankBefore.generation && remaining === bankCount - amount && held() === line.count ? after : null;
        };
        if (!await wait(s, () => !!confirmed(), { timeoutTicks: 10 })) throw Error(`sender withdrawal debit or pack credit not confirmed: ${line.item}`);
        const bankAfter = confirmed();
        if (!bankAfter) throw Error('sender withdrawal observation changed');
        const bank = { count: amount, at: bankAfter.at };
        if (i === 0) progress.bank = bank;
        else (progress.lines ??= [])[i - 1] = { count: 0, bank };
    }
    await s.bot.closeBank();
    progress.uncertain = false;
}

export async function runFleetTrade(account: string, onlyId?: string, env: Record<string, string | undefined> = process.env): Promise<void> {
    const readJson = (dirPath: string) =>
        existsSync(dirPath) ? readdirSync(dirPath).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dirPath, f), 'utf8'))]; } catch { return []; } }) : [];
    const dir = FLEET_DIR(), receipts = join(dir, 'receipts'), preloginDir = join(dir, 'prelogin-failed');
    const orders = readJson(join(dir, 'orders')).filter(validOrder).filter(o => !onlyId || o.id === onlyId);
    const picked = pickOrder(orders, readJson(receipts), account, Date.now());
    if (!picked) {
        console.log(`RESULT ok fleet-trade no open order for ${account}`);
        return;
    }
    const { order, role } = picked, partner = role === 'from' ? order.to : order.from;
    if (isLocalServer(order.server)) {
        console.log('RESULT fail fleet-trade shared orders require a live server');
        process.exitCode = 2;
        return;
    }
    if (!tradePartners(order.server).has(partner.toLowerCase())) {
        console.log(`RESULT fail fleet-trade ${order.id}: ${partner} is not a listed fleet account`);
        process.exitCode = 1;
        return;
    }
    const releaseMoved = releaseWatch(() => cachedReleaseFor(releaseEntries(env.WORKER_ENTRY)), env.WORKER_RELEASE);
    let prepared: TradeReceipt | undefined;
    const progress: FleetTradeProgress = { uncertain: false, count: 0 };
    const complete = (s: Session, ok: boolean, detail: string) => finish([s], ok, settled => {
        if (!prepared) throw Error('trade claim journal unavailable');
        const receipt = fleetTradeOutcome(prepared, progress, settled, readLogoutProof(account, order.server), s.lifecycle?.attemptId, Date.now(), detail);
        writeTradeReceipt(receipts, receipt);
        console.log('FLEET_RECEIPT ' + JSON.stringify(receipt));
        if (settled && !receipt.ok) throw Error('trade requires reconciliation');
        const extra = receipt.lines?.length ? ` +${receipt.lines.length} lines` : '';
        return `fleet-trade ${order.id} ${receipt.state} ${receipt.count}/${order.count}${extra}: ${detail}`;
    });
    while (Date.now() < order.start) await Bun.sleep(Math.min(5000, order.start - Date.now()));
    // The fleet agent starts both parties on one side in the same pass, so a refused login of the partner from before
    // this run is an earlier attempt. The margin covers the start of the partner's process before this one; the agent
    // waits PRELOGIN_RETRY_MS (fleet/src/trade-preflight.ts) after a refusal. A partner on another side runs on its own
    // clock: each refusal counts.
    const owners = loadOwners(), sameSide = sideOf(partner, owners) === sideOf(account, owners);
    const since = sameSide ? performance.timeOrigin - 30_000 : -Infinity;
    const failed = () => partnerFailed(receipts, order, role, preloginDir, since);
    // The giver writes its ready file in this checkout, so only a giver on this side can mark it. The agent starts a
    // taker whose giver is on another side once that giver holds its claim for the order (fleet-agent.ts tradePartnerWait).
    if (role === 'to' && order.takerWaits && sameSide) {
        const waited = await waitForGiver(order, { ready: () => existsSync(giverReadyFile(REPO_ROOT, order.id)), failed });
        console.log(`FLEET_TAKER_WAIT ${order.id} ${waited}`);
    }
    if (failed()) {
        await finish([], false, `fleet-trade ${order.id}: partner failed before login`);
        return;
    }
    const s = await openBot(account, {
        record: fleetTradeRecord(dir, order, account, onlyId ? ['fleet-trade', onlyId] : ['fleet-trade'], env),
        trade: {
            orderId: order.id,
            role,
            check: server => assertTradeAdmission(order, account, server, { receipts, orders: join(dir, 'orders') }),
            prepare: claim => {
                clearPreloginFailure(preloginDir, order.id, role);
                prepared = {
                    version: 2, state: 'prepared', id: order.id, account, partner, role, side: claim.side, server: order.server,
                    item: order.item, requested: order.count, claim: claim.nonce, count: 0, ok: false, at: Date.now(), detail: 'trade claimed',
                    ...(order.extra ? { lines: order.extra.map(l => ({ item: l.item, requested: l.count, count: 0 })) } : {}),
                };
                writeTradeReceipt(receipts, prepared);
            },
        },
        onStop: (session, detail) => complete(session, false, detail),
        onSessionEnd: (session, detail) => complete(session, false, detail),
    }).catch(e => {
        if (!prepared) {
            writePreloginFailure(preloginDir, { version: 1, id: order.id, role, account, partner, server: order.server, at: Date.now(), detail: String(e) });
        }
        return finish([], false, `login: ${String(e)}`);
    });
    let ok = false, detail: string;
    watchTradeScreen(s, progress);
    const takerWatch = role === 'from' && !sameSide
        ? absentTakerWatch({ order, partner, partnerSide: sideOf(partner, owners), receipts, readClaims: () => readHeldFleetTradeClaims(REPO_ROOT, [partner]) })
        : null;
    try {
        await runOrderWork(order, async () => {
            const meet = order.meet ?? meetingTiles({ x: 3185, z: 3436 })!, tile = role === 'from' ? meet[0] : meet[1];
            const exited = await leaveElementalWorkshop(s);
            if (exited && !exited.ok) throw Error(`elemental workshop exit: ${exited.reason} ${exited.detail}`);
            await exitLumberYard(s);
            // Signal a waiting same-side taker as soon as the giver is near the meet so taker login overlaps with
            // final approach and bank withdrawal instead of leaving the giver idle at the bank.
            let readyMarked = false;
            const p0 = s.sdk.getState()?.player;
            if (role === 'from' && order.takerWaits && p0 && p0.level === tile.level && Math.max(Math.abs(p0.worldX - tile.x), Math.abs(p0.worldZ - tile.z)) <= 30) {
                markGiverReady(REPO_ROOT, order.id);
                readyMarked = true;
            }
            const there = await walkTarget(s, tile, false, undefined, { noJewelry: true }) as Outcome;
            if (!there.ok) throw Error(`route to ${tile.x}, ${tile.z}: ${there.reason} ${there.detail}`);
            const p1 = s.sdk.getState()?.player;
            if (!p1 || p1.worldX !== tile.x || p1.worldZ !== tile.z) await s.bot.walkTo(tile.x, tile.z, 0);
            if (role === 'from' && order.takerWaits && !readyMarked) {
                markGiverReady(REPO_ROOT, order.id);
                readyMarked = true;
            }
            if (role === 'from') await prepareFleetSender(s, order, progress);
            takerWatch?.arrived();
            await performFleetTransfer(s, order, role, progress, { gone: () => failed() || releaseMoved() || !!takerWatch?.why() });
        });
        ok = true;
        detail = 'transfer observed';
    } catch (error) {
        const absent = takerWatch?.why();
        detail = releaseMoved() ? `release moved under the session: ${String(error)}` : absent ? `${absent}: ${String(error)}` : String(error);
    }
    await complete(s, ok, detail);
}
