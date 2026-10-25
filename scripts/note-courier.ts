// Kandarin Overland Banknote Courier: circuits Ardougne -> Seers' Village -> Catherby -> Ardougne.
// Collects banknotes from regional collectors (Bigchopper, Ballspinner, Mightyrod) and hands them
// to the central banker (Moneyshot) at Ardougne South Bank.
// Zero boat fares, zero boat menus: pure 2-tile-per-tick overland running across Kandarin.
// Usage: bun scripts/note-courier.ts [courier=Bigpackage] [banker=Moneyshot] [CAP ticks, default 15000]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cargoDir, exactItem, type Cargo } from '../packages/core/src/cargo';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import {courierCargo, retainedTrout, separateTroutNotes} from './courier-cargo';

const ARDY_BANK = { x: 2654, z: 3283 };

const courierName = process.argv[2] ?? 'Bigpackage';
const bankerName = process.argv[3] ?? 'Moneyshot';
const CAP = Number(process.argv[4] ?? process.env.CAP ?? 15000);
const reserve=retainedTrout(process.env);
const owned = ownedAccounts('rs-sdk-demo.fly.dev');
if (!owned.has(courierName.toLowerCase()) || !owned.has(bankerName.toLowerCase())) throw new Error('courier and banker must be owned accounts');

const s = await openBot(courierName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitTicks(s,5); // Inventory arrives after player/skills on a resumed session.
    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const delivery = () => {
        const cargo=courierCargo(inv(),reserve);
        // Fail once into the supervisor's no-progress block. Never idle/relogin
        // while the name-only API cannot separate carried kit from banknotes.
        if(cargo.blocked.length) throw new Error(`no delivery progress: ${cargo.blocked.join(', ')}`);
        return cargo.items;
    };
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let ended = false, died = false;
    const life = pos()?.lifeId, respawns = pos()?.respawnCount ?? 0;
    void s.ended.then(() => { ended = true; });
    const over = () => used() >= CAP || ended || died;
    const off = s.onTick(() => {
        const p = pos();
        if (p?.isDead || (p?.respawnCount ?? 0) > respawns || (life !== undefined && p?.lifeId !== life)) died = true;
    });

    let cycles = 0;
    let itemsCollected = 0;
    let tradesCompleted = 0;
    let walkTicks = 0;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    // Trades with a target bot if nearby: takes what they offer, or gives what we have
    const tradeNearby = async (targetBot: string, role: 'collect' | 'deposit'): Promise<number> => {
        if(role==='deposit'&&courierCargo(inv(),reserve).blocked.includes('Trout: need-bank-separation')) {
            const readyBank=async()=>{
                if(s.sdk.getState()?.bank?.isOpen&&s.bankObservation?.()) return true;
                const generation=s.bankObservation?.()?.generation??0;
                if(!(await s.bot.openBank()).success) return false;
                return waitUntil(s,()=>!!s.sdk.getState()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>generation,{timeoutTicks:20});
            };
            const notes=await separateTroutNotes({
                inventory:inv,
                bank:()=>{
                    const state=s.sdk.getState(),observed=s.bankObservation?.();
                    if(!state?.bank?.isOpen||!observed) return null;
                    const sum=(items:readonly {id:number;count:number}[])=>items.filter(i=>i.id===333).reduce((n,i)=>n+i.count,0);
                    return sum(observed.items)===sum(state.bank.items)?state.bank.items:null;
                },
                openBank:readyBank,closeBank:async()=>(await s.bot.closeBank()).success,
                deposit:async item=>{
                    const current=inv().find(i=>i.id===333&&i.slot===item.slot);
                    return !!current&&(await s.bot.depositItem(current,-1)).success;
                },
                withdraw:async(item,count)=>{
                    const current=s.sdk.getState()?.bank?.items.find(i=>i.id===333&&i.slot===item.slot);
                    return !!current&&(await s.bot.withdrawItem(current,count,{asNote:false})).success;
                },
                observed:predicate=>waitUntil(s,predicate,{timeoutTicks:20}),
                tradeNotes:async count=>{
                    // After banking the food, status exposes only deliverable
                    // notes, so the on-demand banker can wake without false kit demand.
                    await waitUntil(s,()=>!!s.sdk.findNearbyPlayer(exactItem(targetBot))||over(),{timeoutTicks:180});
                    if(over()||!s.sdk.findNearbyPlayer(exactItem(targetBot))) return {success:false,given:0};
                    const result=await s.bot.trade(exactItem(targetBot),{
                        give:[{item:exactItem('Trout'),amount:count}],accept:items=>items.length===0,timeout:30000,
                    });
                    return {success:result.success&&result.gave.every(i=>i.id===334),given:result.gave.filter(i=>i.id===334).reduce((n,i)=>n+i.count,0)};
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

            const res = await s.bot.trade(exactItem(targetBot), {
                give: giveItems,
                timeout: 30000,
            });
            if (res.success) {
                tradesCompleted++;
                console.log(`MILESTONE handed to ${targetBot}: ${res.gave.map(g => `${g.count} ${g.name}`).join(', ')}`);
                return res.gave.reduce((n, g) => n + g.count, 0);
            }
        } else {
            // Receive mode: initiate trade and accept what the collector gives
            const res = await s.bot.trade(exactItem(targetBot), {
                give: [],
                timeout: 30000,
                requestTimeout: 90000,
                retryOnBusy: true,
                accept: items => items.length > 0,
            });
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
        let files: string[];
        try { files = readdirSync(cargoDir); } catch { return []; }
        const p = pos();
        return files.filter(f => !f.startsWith('request-') && f.endsWith('.json')).flatMap(f => {
            try {
                const c: Cargo = JSON.parse(readFileSync(join(cargoDir, f), 'utf8'));
                if (typeof c.name !== 'string' || f !== `${c.name}.json` || !owned.has(c.name.toLowerCase())
                    || c.name.toLowerCase() === courierName.toLowerCase() || c.name.toLowerCase() === bankerName.toLowerCase()
                    || c.bank?.level !== 0 || !Number.isFinite(c.bank.x) || !Number.isFinite(c.bank.z)
                    || !Number.isFinite(c.at) || c.at > Date.now() || Date.now() - c.at > 1800_000
                    || !Array.isArray(c.items) || c.items.some(i => typeof i.name !== 'string' || !Number.isSafeInteger(i.count) || i.count <= 0)) return [];
                if (!p || (p.worldX < 3000) !== (c.bank.x < 3000)) return [];
                const status = JSON.parse(readFileSync(join(cargoDir, '../status', `${c.name}.json`), 'utf8'));
                if (!Number.isFinite(status.at) || status.at > Date.now() || Date.now() - status.at > 30_000 || Date.now() - (attempted.get(c.name) ?? 0) < 60_000) return [];
                if (c.items.reduce((n,i) => n+i.count,0) < Number(process.env.MIN_CARGO ?? 20)) return [];
                return [c];
            } catch { return []; }
        }).sort((a,b) => Math.max(Math.abs(a.bank.x-(p?.worldX??0)),Math.abs(a.bank.z-(p?.worldZ??0))) - Math.max(Math.abs(b.bank.x-(p?.worldX??0)),Math.abs(b.bank.z-(p?.worldZ??0))));
    };

    while (!over()) {
        // Deliver carried goods before another pickup. The banker accepts only owned accounts too.
        const carried=courierCargo(inv(),reserve);
        if (carried.items.length||carried.blocked.includes('Trout: need-bank-separation')) {
            if (!(await walk(ARDY_BANK.x, ARDY_BANK.z, 2))) throw new Error('cannot reach owned banker');
            const deposited = await tradeNearby(bankerName, 'deposit');
            if (!deposited) { await waitTicks(s, 15); continue; }
            cycles++;
            console.log(`MILESTONE delivered=${deposited} deliveries=${cycles} collected=${itemsCollected}`);
        }
        else if(carried.blocked.length) delivery(); // Unknown identity keeps the offline fallback.
        const cargo = sources()[0];
        if (!cargo) { await waitTicks(s, 25); continue; }
        // Keep the first live service on one land mass. The food courier handles the boat route separately.
        const request = join(cargoDir, `request-${cargo.name}.json`);
        writeFileSync(request, JSON.stringify({ worker: cargo.name, courier: courierName, at: Date.now() }));
        console.log(`MILESTONE pickup ${cargo.name} items=${cargo.items.map(i=>`${i.count} ${i.name}`).join(', ')}`);
        try {
            if (await walk(cargo.bank.x, cargo.bank.z, 2)) {
                writeFileSync(request, JSON.stringify({ worker: cargo.name, courier: courierName, at: Date.now(), ready: true }));
                await tradeNearby(cargo.name, 'collect');
            }
        } finally {
            // The courier alone deletes its request; workers only read it.
            try { rmSync(request, { force: true }); }
            catch (e) {
                if (!['ENOENT', 'EFAULT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
                console.log(`WARN pickup request cleanup ${(e as NodeJS.ErrnoException).code}; expires after 180 seconds`);
            }
            attempted.set(cargo.name, Date.now());
        }
    }

    off();
    await finish([s], cycles > 0 && !died && !ended, `ticks=${used()} died=${died} deliveries=${cycles} itemsCollected=${itemsCollected} trades=${tradesCompleted}`);
} catch (e) {
    await finish([s], false, String(e));
}
