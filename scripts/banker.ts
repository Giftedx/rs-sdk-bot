// Banker: stands in the Ardougne south bank, takes trades from our own accounts only, and banks what it gets.
// Finished accounts hand over coins and spare items with scripts/give-to-banker.ts; suppliers and the speedrunner
// draw from here. Each trade appends a line to .practice/vault-log.jsonl ({at, from, to, items}); the dashboard sums
// the vault from the status files. The account must already be in Ardougne:
//   DEMO_OK=1 ARRIVE_ONLY=1 bun scripts/generated/thieving60.ts Moneyshot   (Lumbridge men to 60 coins, boat)
// Usage: DEMO_OK=1 bun scripts/banker.ts [banker=Moneyshot]. Runs until .practice/stop-<banker> exists.
// Skill boards store the playtime tick each level was reached at (server engine/entity/Player.ts levelPlaytime),
// so a finished account that logs in to give does not lose board time.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
    while (!existsSync(stop)) {
        const from = new RegExp(`^(${ourAccounts().filter(n => n.toLowerCase() !== name.toLowerCase()).join('|')})$`, 'i');
        const r = await s.bot.serveTrades({ from, maxTrades: 1, timeout: 60_000 });
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
