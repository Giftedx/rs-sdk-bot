import {payoutOrder} from './payout-order';
import {depositObserved} from '../packages/core/src/deposit';
// Banker: stands in the Ardougne south bank, takes trades from our own accounts only, and banks what it gets.
// Finished accounts hand over coins and spare items with scripts/give-to-banker.ts; suppliers and the speedrunner
// draw from here. Each trade appends a line to .practice/vault-log.jsonl ({at, from, to, items}); the dashboard sums
// the vault from the status files. The account must already be in Ardougne:
//   DEMO_OK=1 ARRIVE_ONLY=1 bun scripts/generated/thieving60.ts Moneyshot   (Lumbridge men to 60 coins, boat)
// PAYOUT_NOTES=1 withdraws payouts as banknotes; default withdrawal behavior is unchanged.
// Usage: DEMO_OK=1 bun scripts/banker.ts [banker=Moneyshot]. Runs until .practice/stop-<banker> exists.
// Skill boards store the playtime tick each level was reached at (server engine/entity/Player.ts levelPlaytime),
// so a finished account that logs in to give does not lose board time.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, serverFromEnv } from '../packages/core/src/bot';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { waitTicks } from '../packages/core/src/ticks';
import { courierDeliveryWaiting } from './courier-cargo';

import type { Session } from '../packages/core/src/inprocess';

export type PayoutItem = { name: string; count: number };
const exactItem = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
export function payoutItems(raw: unknown): PayoutItem[] {
    if (!Array.isArray(raw) || !raw.length) throw new Error('no payout progress: invalid empty payout');
    const items = new Map<string, PayoutItem>();
    for (const w of raw) {
        if (!w || typeof w.name !== 'string' || !w.name.trim() || !Number.isSafeInteger(w.count) || w.count <= 0)
            throw new Error('no payout progress: invalid requested item/count');
        const key = w.name.toLowerCase(), prior = items.get(key);
        const count = (prior?.count ?? 0) + w.count;
        if (!Number.isSafeInteger(count)) throw new Error('no payout progress: requested count overflow');
        items.set(key, { name: prior?.name ?? w.name, count });
    }
    return [...items.values()];
}

// A payout must be fully present before the trade window starts. On a partial
// withdrawal return only newly withdrawn assets, leaving the initial working kit held.
export async function preparePayout(s: Session, raw: unknown, notes = false, keep: RegExp | null = null) {
    const want = payoutItems(raw);
    if (want.some(w => { if (!keep) return false; keep.lastIndex = 0; return keep.test(w.name); }))
        throw new Error('no payout progress: requested item overlaps protected KEEP kit');
    const inv = () => s.sdk.getInventory();
    const count = (name: string) => inv().filter(i => i.name.toLowerCase() === name.toLowerCase()).reduce((n, i) => n + i.count, 0);
    const original = new Map<number, number>();
    for (const i of inv()) original.set(i.id, (original.get(i.id) ?? 0) + i.count);
    const opened = await s.bot.openBank();
    if (!opened.success) throw new Error(`no payout progress: bank open failed ${opened.message}`);
    try {
        for (const w of want) {
            const before = count(w.name);
            if (notes) await s.bot.withdrawItem(exactItem(w.name), w.count, { asNote: true });
            else await s.bot.withdrawItem(exactItem(w.name), w.count);
            const actual = count(w.name) - before;
            if (actual !== w.count) throw new Error(`no payout progress: withdrawal incomplete ${w.name} requested=${w.count} actual=${actual}`);
        }
        return { want, notes, withdrawn: want.reduce((n, w) => n + w.count, 0) };
    } catch (error) {
        for (const id of new Set(inv().map(i => i.id))) {
            const actual = inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
            const surplus = actual - (original.get(id) ?? 0);
            if (surplus > 0) {
                await s.bot.depositItem(inv().find(i => i.id === id)!, surplus);
                const left = inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
                if (left !== (original.get(id) ?? 0)) throw new Error(`no payout progress: partial withdrawal cleanup failed id=${id}; ${String(error)}`);
            }
        }
        throw error;
    } finally { await s.bot.closeBank(); }
}

// Regional owned-fund staging can override the bank. KEEP retains a courier's working kit.
export const BANK_SPOT = { x: Number(process.env.BANK_X ?? 2654), z: Number(process.env.BANK_Z ?? 3283) };
if(!Number.isInteger(BANK_SPOT.x)||!Number.isInteger(BANK_SPOT.z)) throw new Error('invalid bank coordinates');
const keep=process.env.KEEP?new RegExp(process.env.KEEP,'i'):null;
const root = resolve(import.meta.dir, '..');
const name = process.argv[2] ?? 'Moneyshot';
const logFile = join(root, '.practice', 'vault-log.jsonl');
const demandMode=process.env.ON_DEMAND==='1';
const couriers=(process.env.COURIERS??'Bigpackage').split(',').filter(Boolean);

// Authentication proof and credential host must agree with this banker's server.
export function ourAccounts(server = 'rs-sdk-demo.fly.dev', lookup: (server: string) => ReadonlySet<string> = ownedAccounts): string[] {
    return [...lookup(server)];
}

async function main() {
const server = serverFromEnv(readFileSync(join(root, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8'));
const accounts = () => ourAccounts(server);
const order = payoutOrder();
const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const p = s.sdk.getState()?.player;
    if (!p || p.level!==0 || Math.max(Math.abs(p.worldX - BANK_SPOT.x), Math.abs(p.worldZ - BANK_SPOT.z)) > 80) {
        await finish([s], false, `not near configured bank (${BANK_SPOT.x},${BANK_SPOT.z}): ${p?.worldX},${p?.worldZ},${p?.level}`);
    }
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    console.log('MILESTONE banking');
    mkdirSync(join(root, '.practice'), { recursive: true });
    const stop = join(root, '.practice', `stop-${name}`);
    const bankAll = async () => {
        const names=[...new Set(s.sdk.getInventory().map(i=>i.name))].filter(item=>!keep?.test(item));
        if (!names.length) return;
        const o = await s.bot.openBank();
        if (!o.success) { console.log(`WARN openBank ${o.message}`); return; }
        for (const item of names) {
            const exact = new RegExp(`^${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
            const r = order ? {success:(await depositObserved(s,s.sdk.getInventory().find(i=>i.name===item)!))>0,message:''} : await s.bot.depositItem(exact, -1);
            if (!r.success) console.log(`WARN deposit ${item}: ${r?.message}`);
        }
        await waitTicks(s, 1);
        await s.bot.closeBank();
    };
    let trades = 0;
    await bankAll();
    // Payouts: a bot that needs stock writes .practice/withdraw/<bot>.json ({items:[{name,count}]}) and comes to trade
    // (scripts/take-from-banker.ts). The banker withdraws it, gives it in one trade, and deletes the request.
    const reqDir = join(root, '.practice', 'withdraw');
    // A request whose giver died or was killed must not block the banker: drop it after 10 minutes or 2 failed tries.
    const fails = new Map<string, number>();
    const payOut = async (bot: string) => {
        if (!accounts().some(n=>n.toLowerCase()===bot.toLowerCase())) return;
        const file = join(reqDir, `${bot}.json`);
        if (Date.now() - statSync(file).mtimeMs > 10 * 60_000 || (fails.get(bot) ?? 0) >= 2) {
            console.log(`WARN dropped stale payout request from ${bot}`);
            rmSync(file, { force: true });
            fails.delete(bot);
            return;
        }
        const request = JSON.parse(readFileSync(file, 'utf8'));
        order?.preflight(name,bot);
        const prepared = await preparePayout(s, request.items, process.env.PAYOUT_NOTES === '1', keep);
        const want = prepared.want;
        const exact = exactItem;
        console.log(`PAYOUT_READY ${JSON.stringify({ to: bot, ...prepared })}`);
        try {
        let r:Awaited<ReturnType<typeof s.bot.serveTrades>> | undefined;
        const serve=async()=>{r=await s.bot.serveTrades({from:exact(bot),give:want.map(w=>({item:exact(w.name),amount:w.count})),maxTrades:1,timeout:order?60000:120000});return r;};
        if(order){const expected=order.expected(want,s.sdk.getInventory());await order.receipt.sendHandoff(s,bot,server,expected,serve);}
        else await serve();
        if(!r&&!order)throw Error('no payout progress: trade result missing');
        const t = order ? {gave:want} : r?.trades.find(t => t.success);
        if (t) {
            const items = t.gave.map(i => ({ name: i.name, count: i.count }));
            appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: name, to: bot, items }) + '\n');
            console.log(`MILESTONE paid ${bot} ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
            rmSync(file);
        } else { fails.set(bot, (fails.get(bot) ?? 0) + 1); console.log(`WARN payout to ${bot} not taken: ${r?.message}`); }
        } finally { if(order) await bankAll(); }
        if(!order) await bankAll();
    };
    while (!existsSync(stop)) {
        for (const f of existsSync(reqDir) ? readdirSync(reqDir).filter(f => f.endsWith('.json')) : []) await payOut(f.slice(0, -5));
        // A bot with an open payout request is skipped here, so its trade goes to payOut on the next pass.
        const pending = new Set((existsSync(reqDir) ? readdirSync(reqDir) : []).map(f => f.slice(0, -5).toLowerCase()));
        const from = new RegExp(`^(${accounts().filter(n => n.toLowerCase() !== name.toLowerCase() && !pending.has(n.toLowerCase())).join('|')})$`, 'i');
        // A long window so a donor's trade is never cut off mid-session (the SDK caps a session at the window's time
        // left); `until` ends it early when a payout request appears or the stop file is written.
        const hasRequest = () => existsSync(reqDir) && readdirSync(reqDir).some(f => f.endsWith('.json') && accounts().some(n=>n.toLowerCase()===f.slice(0,-5).toLowerCase()));
        if(demandMode&&!courierDeliveryWaiting(couriers)&&!hasRequest()) break;
        const r = await s.bot.serveTrades({ from, maxTrades: 1, timeout: demandMode?30_000:120_000, until: () => hasRequest() || existsSync(stop) || (demandMode&&!courierDeliveryWaiting(couriers)) });
        for (const t of r.trades.filter(t => !t.success)) console.log(`WARN donor trade failed: ${t.partner ?? '?'} ${t.reason ?? ''} ${t.message}`);
        for (const t of r.trades.filter(t => t.success)) {
            trades++;
            const items = t.received.map(i => ({ name: i.name, count: i.count }));
            appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: t.partner ?? '?', to: name, items }) + '\n');
            console.log(`MILESTONE got ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
        }
        await bankAll();
    }
    await finish([s], true, `${existsSync(stop)?'stop file':'waiting offline for owned cargo'} trades=${trades}`);
} catch (e) {
    await finish([s], false, `error: ${String(e)}`);
}

}
if (import.meta.main) await main();
