import {payoutOrder} from './payout-order';
import {depositObserved} from '../packages/core/src/deposit';
import {readFileSync} from 'node:fs';
import {serverFromEnv} from '../packages/core/src/bot';
// Take stock from the banker (scripts/banker.ts, Ardougne south bank): writes .practice/withdraw/<bot>.json, walks
// to the banker and trades until the items arrive. Usage: DEMO_OK=1 bun scripts/take-from-banker.ts <bot> <count>:<item>
// [...] [--banker=Moneyshot], e.g. `Bigpackage 20000:Coins`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';

const BANK_SPOT = { x: Number(process.env.BANK_X ?? 2654), z: Number(process.env.BANK_Z ?? 3283) };
if(!Number.isInteger(BANK_SPOT.x)||!Number.isInteger(BANK_SPOT.z)) throw new Error('invalid bank coordinates');
const args = process.argv.slice(2);
const name = args[0]!;
const banker = args.find(a => a.startsWith('--banker='))?.slice(9) ?? 'Moneyshot';
const items = args.slice(1).filter(a => !a.startsWith('--')).map(a => { const [c, ...n] = a.split(':'); return { name: n.join(':'), count: Number(c) }; });
if (!items.length || items.some(i => !i.name || !Number.isSafeInteger(i.count) || i.count <= 0)) throw new Error('usage: <bot> <count>:<item> ...');
const dir = join(resolve(import.meta.dir, '..'), '.practice', 'withdraw');
const file = join(dir, `${name}.json`);
const exact = (n: string) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

const order=payoutOrder();
order?.preflight(banker,name);
const server=serverFromEnv(readFileSync(join(resolve(import.meta.dir,'..'),'vendor/rs-sdk/bots',name,'bot.env'),'utf8'));
const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ items }));
    await waitTicks(s, 2);
    await s.bot.walkTo(BANK_SPOT.x, BANK_SPOT.z, 2);
    if(!(await waitUntil(s,st=>st.nearbyPlayers.some((p:{name:string})=>p.name.toLowerCase()===banker.toLowerCase()),{timeoutTicks:150})))
        throw new Error('owned banker did not arrive within150ticks');
    const before = items.map(i => countItems(s, exact(i.name)));
    // Incoming quantity is checked separately;bank the full pre-held exact-ID stack too.
    const beforeExact = order ? s.sdk.getInventory().filter(i=>i.id===order.id).reduce((n,i)=>n+i.count,0) : 0;
    let ok = false;
    if(order){
        await order.receipt.awaitCollectionOffer(s,banker,server,150);
        const collected=await order.receipt.collectHandoff(s,banker,server,()=>s.bot.trade(exact(banker),{want:items.map(i=>({item:exact(i.name),amount:i.count})),timeout:60000}));
        ok=items.length===1&&collected.received===items[0]!.count&&countItems(s,exact(items[0]!.name))-(before[0]!)===items[0]!.count;
        if(!ok)throw Error('payout prerequisite: exact collection unproved');
    } else {
for (let i = 0; i < 8 && !ok; i++) {
        const r = await s.bot.trade(exact(banker), { want: items.map(i => ({ item: exact(i.name), amount: i.count })), timeout: 90_000 });
        ok = r.success;
        if (!ok) { console.log(`WARN trade ${r.reason} ${r.message}`); await waitTicks(s, 5); }
    }
    }
    const got = items.map((it, k) => `${countItems(s, exact(it.name)) - before[k]!} ${it.name}`).join(', ');
    if(order&&ok){
        if(!(await s.bot.openBank()).success)throw Error('payout prerequisite: receiver bank unavailable');
        const item=s.sdk.getInventory().find(i=>i.id===order.id);
        if(!item||await depositObserved(s,item)!==beforeExact+items[0]!.count)throw Error('payout prerequisite: receiver bank credit unproved');
        await s.bot.closeBank();
    }
    if (!ok) rmSync(file, { force: true });
    await finish([s], ok, `got ${got}`);
} catch (e) {
    rmSync(file, { force: true });
    await finish([s], false, `error: ${String(e)}`);
}
