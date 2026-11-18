import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, settle, accountOf, getWorld, serverFromEnv, assertServerAllowed } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { goTo } from '../packages/core/src/walk';
import type { Tile } from '../packages/core/src/world';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { createHandoff } from './courier-handoff';
import { parseHandoff, acquireAccountLeases } from './handoff-inputs';
import {checkTransferAccounts,transferOrderKey} from './transfer-admission';

// --reserve=N keeps at least N coins in the donor's freshly observed bank; omitted means zero.
export function parseCoins(args: string[]) {
    const [from, to, amount, ...options] = args;
    if (!amount || !/^\d+$/.test(amount) || Number(amount) > 2147483647) throw Error('positive exact coin amount required');
    const reserves=options.filter(option=>option.split('=')[0]==='--reserve');
    if(reserves.length>1)throw Error('duplicate coin reserve option');
    const text=reserves[0]?.slice('--reserve='.length)??'0',reserve=Number(text);
    if(reserves.length&&(!reserves[0]!.startsWith('--reserve=')||!/^\d+$/.test(text))||!Number.isSafeInteger(reserve)||reserve<0||reserve>2147483647)
        throw Error('coin donor bank reserve must be an integer from 0 to 2147483647');
    const rest=options.filter(option=>option.split('=')[0]!=='--reserve');
    const defaults = ['--bank-x=3185', '--bank-z=3436'].filter(d => !rest.some(o => o.split('=')[0] === d.split('=')[0]));
    const c = parseHandoff([from ?? '', to ?? '', `${amount}:Coins`, ...defaults, ...rest]);
    if (c.notes || c.keep) throw Error('coin courier does not accept notes or keep options');
    return { ...c, amount: Number(amount), reserve };
}
const coins = (items: { id: number; count: number }[]) => items.filter(i => i.id === 995).reduce((n, i) => n + i.count, 0);
export type CoinState = { bank: number; pack: number };
export function exactCoinDelta(before: CoinState[], after: CoinState[], amount: number, reserve=0): boolean {
    return Number.isSafeInteger(amount) && amount > 0 && before.length === 2 && after.length === 2
        && Number.isSafeInteger(reserve) && reserve >= 0 && reserve <= 2147483647 && after[0]!.bank >= reserve
        && [...before, ...after].every(s => Number.isSafeInteger(s.bank) && s.bank >= 0 && Number.isSafeInteger(s.pack) && s.pack >= 0)
        && before[0]!.bank - after[0]!.bank === amount && after[1]!.bank - before[1]!.bank === amount
        && before.every((s, i) => s.pack === after[i]!.pack);
}

// The bank is already open. Keep the item by observing its pack debit and bank credit.
export async function prepareCoinSlot(s: Session, check: () => void) {
    check();
    const pack = s.sdk.getInventory();
    if (coins(pack) || pack.length < 28) return;
    const item = pack.find(i => pack.filter(other => other.id === i.id).length === 1) ?? pack.at(-1)!;
    await depositObserved(s, item);
    if (!await waitUntil(s, () => { check(); return s.sdk.getInventory().length < 28; }, { timeoutTicks: 20 }))
        throw Error(`coin pack full: ${s.name}`);
}

// Varrock West bank: the booths stand at x 3186 and the counter cuts the public floor (x 3180-3185) off from
// x 3186-3190. The meeting pair is open floor 3 tiles west of the booths, clear of the x 3180 tables.
// A bank without a known pair keeps its bank tile and still needs the reachability check.
// Ardougne north bank (2619,3332), the PK army's home: the pair is open floor inside the bank. Practice: two bots walked
// there from the goldfarm knights and each opened the bank from its tile.
// The other banks of packages/planner/src/haggis-travel.json: the booth is the one unwalkable neighbour of the bank
// tile, and the pair is the tile one step back from the booth plus the next tile along the booth row (pathfinder:
// both walkable and joined to the bank tile). The same rule gives the Ardougne north pair. A route account takes
// its next batch of supplies at the bank it visits next, so each route bank needs a pair.
const pair = (a: [number, number], b: [number, number]): [Tile, Tile] => [{ x: a[0], z: a[1], level: 0 }, { x: b[0], z: b[1], level: 0 }];
const VARROCK_WEST = pair([3183, 3440], [3182, 3440]), ARDOUGNE_NORTH = pair([2618, 3333], [2617, 3333]);
export const BANK_MEETS: readonly { bank: string; tiles: readonly [number, number][]; meet: [Tile, Tile] }[] = [
    { bank: 'varrock-west', tiles: [[3185, 3436], [3185, 3440]], meet: VARROCK_WEST },
    { bank: 'ardougne-north', tiles: [[2619, 3332], [2618, 3332]], meet: ARDOUGNE_NORTH },
    { bank: 'draynor', tiles: [[3092, 3243]], meet: pair([3093, 3243], [3093, 3244]) },
    { bank: 'al-kharid', tiles: [[3269, 3167]], meet: pair([3270, 3167], [3270, 3168]) },
    { bank: 'varrock-east', tiles: [[3254, 3420]], meet: pair([3254, 3421], [3253, 3421]) },
    { bank: 'falador-east', tiles: [[3013, 3355]], meet: pair([3013, 3356], [3014, 3356]) },
    { bank: 'falador-west', tiles: [[2947, 3368]], meet: pair([2947, 3369], [2946, 3369]) },
    { bank: 'edgeville', tiles: [[3094, 3491]], meet: pair([3093, 3491], [3093, 3492]) },
    { bank: 'ardougne-south', tiles: [[2655, 3283]], meet: pair([2654, 3283], [2654, 3284]) },
    { bank: 'catherby', tiles: [[2809, 3441]], meet: pair([2809, 3440], [2810, 3440]) },
    { bank: 'seers', tiles: [[2727, 3493]], meet: pair([2727, 3492], [2728, 3492]) },
];
export function meetingTiles(bank: { x: number; z: number }): [Tile, Tile] | null {
    const row = BANK_MEETS.find(r => r.tiles.some(([x, z]) => x === bank.x && z === bank.z));
    return row ? [{ ...row.meet[0] }, { ...row.meet[1] }] : null;
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
        const generation=s.bankObservation?.()?.generation??-1;
        if(s.sdk.getState()?.bank?.isOpen){
            if(!(await s.bot.closeBank()).success)throw Error(`coin bank closure failed: ${s.name}`);
            await observe(s,()=>!s.sdk.getState()?.bank?.isOpen,`coin bank closure unobserved: ${s.name}`);
        }
        if(!(await s.bot.openBank()).success)throw Error(`coin bank entry failed: ${s.name}`);
        await observe(s, () => !!s.sdk.getState()?.bank?.isOpen&&(s.bankObservation?.()?.generation??-1)>generation, `coin fresh bank entry unobserved: ${s.name}`);
    };
    const state = (s: Session): CoinState => {
        const b = s.bankObservation?.();
        if (!b||!s.sdk.getState()?.bank?.isOpen) throw Error('coin open bank snapshot unavailable');
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
    if (before[0]!.bank-c.amount<c.reserve) throw Error('coin donor bank reserve short');
    // Refuse before a full pack's unrelated item is moved, or any withdrawal/journal/trade begins.
    // Both withdrawal and trade receipt need a slot when there is no existing coin stack.
    for (const s of sessions) await prepareCoinSlot(s, guard);
    if (before[0]!.pack + c.amount > 2147483647 || before[1]!.pack + c.amount > 2147483647 || before[1]!.bank + c.amount > 2147483647) throw Error('coin stack overflow');
    if (!before[1]!.pack && receiver.sdk.getInventory().length >= 28) throw Error('coin receiver pack full');
    // A pending journal is never retried without reconciliation by its owner.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'before.json'), JSON.stringify({ from: c.donor, to: c.receiver, amount: c.amount, reserve:c.reserve, server, before }), { flag: 'wx' });
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
    if (!exactCoinDelta(before, after, c.amount,c.reserve)) throw Error('exact coin bank deltas/reserve unproved: ' + JSON.stringify({ before, after, reserve:c.reserve }));
    const receipt = { from: c.donor, to: c.receiver, amount: c.amount, reserve:c.reserve, server, before, after, childResults };
    writeFileSync(join(root, 'settled.json'), JSON.stringify(receipt), { flag: 'wx' });
    console.log('COIN_RECEIPT ' + JSON.stringify(receipt));
    return receipt;
}

// The session record names the catalog entry: the progression gate maps `scripts/coin-courier.ts`, not a bare file name.
export function courierRecord(c: { donor: string; receiver: string }, argv: string[], env: Record<string, string | undefined>) {
    return { script: 'scripts/coin-courier.ts', argv, env: { ...env, COORDINATOR_PARTICIPANTS: JSON.stringify([c.donor, c.receiver]) } };
}

export async function main() {
    const c = parseCoins(process.argv.slice(2)), root = resolve(import.meta.dir, '..'), dir = join(root, '.practice');
    const host = (name: string) => serverFromEnv(readFileSync(join(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const server = host(c.donor);
    if (host(c.receiver) !== server) throw Error('coin accounts must use the same server');
    assertServerAllowed(server);
    const runId = process.env.COORDINATOR_RUN_ID ?? '';
    const key = transferOrderKey(process.env.COIN_ORDER ?? (runId || crypto.randomUUID()),'COIN_ORDER');
    const journal = join(dir, 'coin-courier', key);
    if (existsSync(join(journal, 'before.json'))) throw Error('coin order already attempted; reconcile before retry');
    const sessions: Session[] = [];
    let cancelled = false, ok = false, detail = '', release: (() => void) | undefined;
    const cancel = () => { cancelled = true; };
    const check = () => {
        if (cancelled) throw Error('coin courier cancelled');
        checkTransferAccounts(root,[c.donor,c.receiver],server,sessions,runId);
    };
    try {
        check(); release = acquireAccountLeases([c.donor, c.receiver], runId);
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        const record=courierRecord(c,process.argv.slice(2),process.env);
        for (const name of [c.donor, c.receiver]) { check(); sessions.push(await openBot(name, {record,onStop: async () => cancel(), onSessionEnd: async () => cancel() })); }
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
