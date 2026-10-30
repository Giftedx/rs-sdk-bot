import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, settle, accountOf, getWorld, serverFromEnv, assertServerAllowed } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { goTo } from '../packages/core/src/walk';
import type { Tile } from '../packages/core/src/world';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { createHandoff } from './courier-handoff';
import { parseHandoff, assertAccountOwnership, acquireAccountLeases, assertRecoverableStatus } from './handoff-inputs';

export function parseCoins(args: string[]) {
    const [from, to, amount, ...options] = args;
    if (!amount || !/^\d+$/.test(amount) || Number(amount) > 2147483647) throw Error('positive exact coin amount required');
    const defaults = ['--bank-x=3185', '--bank-z=3436'].filter(d => !options.some(o => o.split('=')[0] === d.split('=')[0]));
    const c = parseHandoff([from ?? '', to ?? '', `${amount}:Coins`, ...defaults, ...options]);
    if (c.notes || c.keep) throw Error('coin courier does not accept notes or keep options');
    return { ...c, amount: Number(amount) };
}
const coins = (items: { id: number; count: number }[]) => items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
export type CoinState = { bank: number; pack: number };
export function exactCoinDelta(before: CoinState[], after: CoinState[], amount: number): boolean {
    return Number.isSafeInteger(amount) && amount > 0 && before.length === 2 && after.length === 2
        && [...before, ...after].every(s => Number.isSafeInteger(s.bank) && s.bank >= 0 && Number.isSafeInteger(s.pack) && s.pack >= 0)
        && before[0]!.bank - after[0]!.bank === amount && after[1]!.bank - before[1]!.bank === amount
        && before.every((s, i) => s.pack === after[i]!.pack);
}

// Varrock West bank: the booths stand at x 3186 and the counter cuts the public floor (x 3180-3185) off from
// x 3186-3190. The meeting pair is open floor 3 tiles west of the booths, clear of the x 3180 tables.
// A bank without a known pair keeps its bank tile and still needs the reachability check.
export function meetingTiles(bank: { x: number; z: number }): [Tile, Tile] | null {
    return bank.x === 3185 && bank.z === 3436 ? [{ x: 3183, z: 3440, level: 0 }, { x: 3182, z: 3440, level: 0 }] : null;
}

export function coinTradeObservation(s: Session, partnerName: string) {
    const state = s.sdk.getState(), player = state?.player;
    const partner = s.sdk.findNearbyPlayer(exactItem(partnerName));
    const bank = s.bankObservation?.();
    return {
        account: s.name, tick: s.tick(),
        position: player ? { x: player.worldX, z: player.worldZ, level: player.level } : null,
        partner: partner ? { name: partner.name, index: partner.index, x: partner.x, z: partner.z, distance: partner.distance, reachable: partner.reachable ?? null } : null,
        bankOpen: state?.bank?.isOpen ?? null,
        bank: bank ? { generation: bank.generation, coins: coins(bank.items) } : null,
        pack: coins(s.sdk.getInventory()),
        trade: s.sdk.getTradeState(),
    };
}

// The entry retains both sessions and the account leases through settle().
export async function moveCoins(c: ReturnType<typeof parseCoins>, sessions: Session[], root: string, server: string, check: () => void) {
    const [donor, receiver] = sessions;
    if (!donor || !receiver || donor.name.toLowerCase() !== c.donor.toLowerCase() || receiver.name.toLowerCase() !== c.receiver.toLowerCase()) throw Error('coin session identity mismatch');
    const started = Date.now();
    const guard = () => { check(); if (Date.now() - started >= c.timeoutMs) throw Error('coin courier deadline; reconcile before retry'); };
    const observe = async (s: Session, pred: () => boolean, detail: string) => {
        if (!await waitUntil(s, () => { guard(); return pred(); }, { timeoutTicks: 20 })) throw Error(detail);
    };
    const bank = async (s: Session) => {
        guard();
        await s.bot.openBank();
        await observe(s, () => !!s.bankObservation?.(), `coin bank entry unobserved: ${s.name}`);
    };
    const state = (s: Session): CoinState => {
        const b = s.bankObservation?.();
        if (!b) throw Error('coin bank snapshot unavailable');
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
    if (before[0]!.pack + c.amount > 2147483647 || before[1]!.pack + c.amount > 2147483647 || before[1]!.bank + c.amount > 2147483647) throw Error('coin stack overflow');
    if (!before[1]!.pack && receiver.sdk.getInventory().length >= 28) throw Error('coin receiver pack full');
    // A pending journal is never retried without reconciliation by its owner.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'before.json'), JSON.stringify({ from: c.donor, to: c.receiver, amount: c.amount, server, before }), { flag: 'wx' });
    const withdraw = async (s: Session, amount: number, target: CoinState) => {
        guard(); const generation = s.bankObservation!()!.generation;
        await s.bot.withdrawItem(exactItem('Coins'), amount);
        await observe(s, () => { const b = s.bankObservation?.(); return !!b && b.generation > generation && coins(b.items) === target.bank && coins(s.sdk.getInventory()) === target.pack; }, 'exact coin withdrawal unobserved');
    };
    await withdraw(donor, c.amount, { bank: before[0]!.bank - c.amount, pack: before[0]!.pack + c.amount });
    for (const s of sessions) { guard(); await s.bot.closeBank(); await observe(s, () => !s.sdk.getState()?.bank?.isOpen, 'coin bank did not close'); }
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
    // The client drops a trade request to an unreachable partner without sending it.
    if (!await waitUntil(donor, () => { guard(); return tradeState().every(o => o.partner?.reachable === true); }, { timeoutTicks: 10 })) {
        const refused = tradeState();
        console.log('COIN_TRADE_REFUSED ' + JSON.stringify(refused));
        throw Error('coin trade refused: partner unreachable, nothing sent; reconcile before retry: ' + JSON.stringify(refused.map(o => ({ account: o.account, position: o.position, partner: o.partner }))));
    }
    const tradeEntry = tradeState();
    writeFileSync(join(root, 'trade-entry.json'), JSON.stringify(tradeEntry), { flag: 'wx' });
    console.log('COIN_TRADE_ENTRY ' + JSON.stringify(tradeEntry));
    const handoff = createHandoff([995], join(root, 'trade'));
    let childResults: unknown[] = [];
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
    // Restore the receiver's original pocket coins after depositing the transfer.
    if (before[1]!.pack) await withdraw(receiver, before[1]!.pack, { bank: before[1]!.bank + c.amount, pack: before[1]!.pack });
    const after = sessions.map(state);
    if (!exactCoinDelta(before, after, c.amount)) throw Error('exact coin bank deltas unproved: ' + JSON.stringify({ before, after }));
    const receipt = { from: c.donor, to: c.receiver, amount: c.amount, server, before, after, childResults };
    writeFileSync(join(root, 'settled.json'), JSON.stringify(receipt), { flag: 'wx' });
    console.log('COIN_RECEIPT ' + JSON.stringify(receipt));
    return receipt;
}

export async function main() {
    const c = parseCoins(process.argv.slice(2)), root = resolve(import.meta.dir, '..'), dir = join(root, '.practice');
    const read = (p: string, fallback: any) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
    const host = (name: string) => serverFromEnv(readFileSync(join(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const server = host(c.donor);
    if (host(c.receiver) !== server) throw Error('coin accounts must use the same server');
    assertServerAllowed(server);
    const runId = process.env.COORDINATOR_RUN_ID ?? '';
    const key = process.env.COIN_ORDER ?? (runId || crypto.randomUUID());
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(key)) throw Error('invalid COIN_ORDER');
    const journal = join(dir, 'coin-courier', key);
    if (existsSync(join(journal, 'before.json'))) throw Error('coin order already attempted; reconcile before retry');
    const sessions: Session[] = [];
    let cancelled = false, ok = false, detail = '', release: (() => void) | undefined;
    const cancel = () => { cancelled = true; };
    const check = () => {
        if (cancelled) throw Error('coin courier cancelled');
        assertAccountOwnership([c.donor, c.receiver], read(join(dir, 'coordinator/state.json'), null), read(join(root, 'swarm.json'), {}).jobs, n => existsSync(join(dir, 'stop-' + n)), runId);
        const owned = ownedAccounts(server);
        for (const n of [c.donor, c.receiver]) {
            if (!owned.has(n.toLowerCase())) throw Error('not authenticated owned: ' + n);
            if (!sessions.some(s => s.name.toLowerCase() === n.toLowerCase())) assertRecoverableStatus(read(join(dir, 'status', n + '.json'), null), null, () => true);
        }
    };
    try {
        check(); release = acquireAccountLeases([c.donor, c.receiver], runId);
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        for (const name of [c.donor, c.receiver]) { check(); sessions.push(await openBot(name, { onStop: async () => cancel(), onSessionEnd: async () => cancel() })); }
        await moveCoins(c, sessions, journal, server, check);
        ok = true; detail = `transferred ${c.amount} coins ${c.donor} -> ${c.receiver}`;
    } catch (error) { detail = String(error); }
    finally {
        try { ok = await settle(sessions, ok, detail); }
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
    }
    console.log('COIN_RESULT ' + JSON.stringify({ ok, detail }));
    process.exitCode = ok ? 0 : 1;
}
if (import.meta.main) main().catch(error => { console.error('RESULT fail ' + String(error)); process.exitCode = 1; });
