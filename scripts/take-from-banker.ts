// Take stock from the banker (scripts/banker.ts, Ardougne south bank): writes .practice/withdraw/<bot>.json, walks
// to the banker and trades until the items arrive. Usage: DEMO_OK=1 bun scripts/take-from-banker.ts <bot> <count>:<item>
// [...] [--banker=Moneyshot], e.g. `Bigpackage 20000:Coins`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks } from '../packages/core/src/ticks';

const BANK_SPOT = { x: 2654, z: 3283 };
const args = process.argv.slice(2);
const name = args[0]!;
const banker = args.find(a => a.startsWith('--banker='))?.slice(9) ?? 'Moneyshot';
const items = args.slice(1).filter(a => !a.startsWith('--')).map(a => { const [c, ...n] = a.split(':'); return { name: n.join(':'), count: Number(c) }; });
if (!items.length || items.some(i => !i.name || !(i.count > 0))) throw new Error('usage: <bot> <count>:<item> ...');
const dir = join(resolve(import.meta.dir, '..'), '.practice', 'withdraw');
const file = join(dir, `${name}.json`);
const exact = (n: string) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ items }));
    await waitTicks(s, 2);
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    const before = items.map(i => countItems(s, exact(i.name)));
    let ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
        const r = await s.bot.trade(exact(banker), { want: items.map(i => ({ item: exact(i.name), amount: i.count })), timeout: 90_000 });
        ok = r.success;
        if (!ok) { console.log(`WARN trade ${r.reason} ${r.message}`); await waitTicks(s, 5); }
    }
    const got = items.map((it, k) => `${countItems(s, exact(it.name)) - before[k]!} ${it.name}`).join(', ');
    if (!ok) rmSync(file, { force: true });
    await finish([s], ok, `got ${got}`);
} catch (e) {
    rmSync(file, { force: true });
    await finish([s], false, `error: ${String(e)}`);
}
