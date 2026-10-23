// Banker: stands in the Ardougne south bank, takes trades from our own accounts only, and banks what it gets.
// Finished accounts hand over coins and spare items with scripts/give-to-banker.ts; suppliers and the speedrunner
// draw from here. Each trade appends a line to .practice/vault-log.jsonl ({at, from, to, items}); the dashboard sums
// the vault from the status files. The account must already be in Ardougne:
//   DEMO_OK=1 ARRIVE_ONLY=1 bun scripts/generated/thieving60.ts Moneyshot   (Lumbridge men to 60 coins, boat)
// Usage: DEMO_OK=1 bun scripts/banker.ts [banker=Moneyshot]. Runs until .practice/stop-<banker> exists.
// Skill boards store the playtime tick each level was reached at (server engine/entity/Player.ts levelPlaytime),
// so a finished account that logs in to give does not lose board time.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';

export const BANK_SPOT = { x: 2654, z: 3283 };
const root = resolve(import.meta.dir, '..');
const name = process.argv[2] ?? 'Moneyshot';
const logFile = join(root, '.practice', 'vault-log.jsonl');

// Our accounts: every bots/<name>/bot.env that points at the demo server.
export function ourAccounts(): string[] {
    const dir = join(root, 'vendor', 'rs-sdk', 'bots');
    return readdirSync(dir).filter(n => {
        try { return n !== '_template' && /SERVER=rs-sdk-demo/.test(readFileSync(join(dir, n, 'bot.env'), 'utf8')); } catch { return false; }
    });
}

const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s, 3);
    const p = s.sdk.getState()?.player;
    if (!p || Math.max(Math.abs(p.worldX - BANK_SPOT.x), Math.abs(p.worldZ - 3300)) > 80) {
        await finish([s], false, `not in Ardougne (${p?.worldX},${p?.worldZ}); run thieving60 with ARRIVE_ONLY=1 first`);
    }
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    console.log('MILESTONE banking');
    mkdirSync(join(root, '.practice'), { recursive: true });
    const stop = join(root, '.practice', `stop-${name}`);
    const bankAll = async () => {
        if (!s.sdk.getInventory().length) return;
        const o = await s.bot.openBank();
        if (!o.success) { console.log(`WARN openBank ${o.message}`); return; }
        await s.bot.depositItem(/./, -1);
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
        const file = join(reqDir, `${bot}.json`);
        if (Date.now() - statSync(file).mtimeMs > 10 * 60_000 || (fails.get(bot) ?? 0) >= 2) {
            console.log(`WARN dropped stale payout request from ${bot}`);
            rmSync(file, { force: true });
            fails.delete(bot);
            return;
        }
        const want: { name: string; count: number }[] = JSON.parse(readFileSync(file, 'utf8')).items;
        const exact = (n: string) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const o = await s.bot.openBank();
        if (!o.success) { console.log(`WARN openBank ${o.message}`); return; }
        for (const w of want) {
            const r = await s.bot.withdrawItem(exact(w.name), w.count);
            if (!r.success) console.log(`WARN withdraw ${w.count} ${w.name}: ${r.message}`);
        }
        await s.bot.closeBank();
        const r = await s.bot.serveTrades({ from: exact(bot), give: want.map(w => ({ item: exact(w.name), amount: w.count })), maxTrades: 1, timeout: 120_000 });
        const t = r.trades.find(t => t.success);
        if (t) {
            const items = t.gave.map(i => ({ name: i.name, count: i.count }));
            appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: name, to: bot, items }) + '\n');
            console.log(`MILESTONE paid ${bot} ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
            rmSync(file);
        } else { fails.set(bot, (fails.get(bot) ?? 0) + 1); console.log(`WARN payout to ${bot} not taken: ${r.message}`); }
        await bankAll();
    };
    while (!existsSync(stop)) {
        for (const f of existsSync(reqDir) ? readdirSync(reqDir).filter(f => f.endsWith('.json')) : []) await payOut(f.slice(0, -5));
        // A bot with an open payout request is skipped here, so its trade goes to payOut on the next pass.
        const pending = new Set((existsSync(reqDir) ? readdirSync(reqDir) : []).map(f => f.slice(0, -5).toLowerCase()));
        const from = new RegExp(`^(${ourAccounts().filter(n => n.toLowerCase() !== name.toLowerCase() && !pending.has(n.toLowerCase())).join('|')})$`, 'i');
        // A long window so a donor's trade is never cut off mid-session (the SDK caps a session at the window's time
        // left); `until` ends it early when a payout request appears or the stop file is written.
        const hasRequest = () => existsSync(reqDir) && readdirSync(reqDir).some(f => f.endsWith('.json'));
        const r = await s.bot.serveTrades({ from, maxTrades: 1, timeout: 120_000, until: () => hasRequest() || existsSync(stop) });
        for (const t of r.trades.filter(t => !t.success)) console.log(`WARN donor trade failed: ${t.partner ?? '?'} ${t.reason ?? ''} ${t.message}`);
        for (const t of r.trades.filter(t => t.success)) {
            trades++;
            const items = t.received.map(i => ({ name: i.name, count: i.count }));
            appendFileSync(logFile, JSON.stringify({ at: Date.now(), from: t.partner ?? '?', to: name, items }) + '\n');
            console.log(`MILESTONE got ${items.map(i => `${i.count} ${i.name}`).join(', ')}`);
        }
        await bankAll();
    }
    await finish([s], true, `stop file trades=${trades}`);
} catch (e) {
    await finish([s], false, `error: ${String(e)}`);
}
