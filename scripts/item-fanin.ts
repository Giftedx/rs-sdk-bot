// Several owned donors hand one stackable item to one receiver, one after another, at Varrock West bank (the
// meeting tiles scripts/coin-courier.ts proved live). The receiver stays logged in between donors; each donor
// takes the whole banked stack out at Varrock West (arrowtips bought into a bank) and trades every one it holds,
// then logs out. At the end the receiver banks what it got. The trade runs
// through courier-handoff.ts with a receipt per pair under .practice/item-fanin/<order>-<donor>.
// Built for feathers: the chicken farmers (scripts/gather-feathers.ts) keep theirs in the pack, and BowBeforeMe
// holds the arrow shafts for headless arrows.
// Usage: bun scripts/item-fanin.ts <receiver> <donor> [donor ...] <item name>   (a swarm orchestrate job passes
// its accounts first, then its args)
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, settle, serverFromEnv, assertServerAllowed, getWorld, accountOf } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { goTo } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { exactItem } from '../packages/core/src/cargo';
import { createHandoff } from './courier-handoff';
import { meetingTiles } from './coin-courier';
import { parseHandoff, acquireAccountLeases } from './handoff-inputs';
import {checkTransferAccounts,transferOrderKey} from './transfer-admission';

const BANK = { x: 3185, z: 3436 };

export function parseFanin(args: string[]) {
    const item = args.at(-1), [receiver, ...donors] = args.slice(0, -1);
    if (!receiver || !donors.length || !item || /^\d+$/.test(item)) throw Error('usage: item-fanin.ts <receiver> <donor> [donor ...] <item name>');
    if (new Set([receiver, ...donors].map(n => n.toLowerCase())).size !== donors.length + 1) throw Error('each account once');
    for(const donor of donors)parseHandoff([donor,receiver,'1:'+item]);
    return { receiver, donors, item };
}

export const held = (items: readonly { id: number; count: number }[], id: number) => items.filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

export async function itemFaninMain(args:string[]=process.argv.slice(2)) {
    // A swarm orchestrate job may pass the item first among its args: `--args Feather` after the accounts.
    const f = parseFanin(args), root = resolve(import.meta.dir, '..'), dir = join(root, '.practice');
    const all = [f.receiver, ...f.donors];
    const host = (name: string) => serverFromEnv(readFileSync(join(root, 'vendor/rs-sdk/bots', name, 'bot.env'), 'utf8'));
    const server = host(f.receiver);
    if (all.some(n => host(n) !== server)) throw Error('fan-in accounts must use the same server');
    assertServerAllowed(server);
    const runId = process.env.COORDINATOR_RUN_ID ?? '', order = transferOrderKey(process.env.ITEM_ORDER ?? `fanin-${Date.now()}`,'ITEM_ORDER');
    let cancelled = false;
    const closing=new Set<string>();
    const cancel = () => { cancelled = true; };
    const sessionEnd=(name:string)=>async()=>{if(!closing.has(name.toLowerCase()))cancel();};
    const check = (names: string[], open: Session[]) => {
        if (cancelled) throw Error('item fan-in cancelled');
        checkTransferAccounts(root,names,server,open,runId);
    };
    const meet = meetingTiles(BANK)!;
    const results: { from: string; ok: boolean; count: number; detail: string }[] = [];
    let receiver: Session | undefined, release: (() => void) | undefined;
    let banked=false;
    try {
        check(all, []); release = acquireAccountLeases(all, runId);
        process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
        receiver = await openBot(f.receiver, { onStop: async () => cancel(), onSessionEnd: sessionEnd(f.receiver) });
        const world = await getWorld();
        const to = async (s: Session, tile: typeof meet[0]) => {
            const r = await goTo(s, world, tile, accountOf(s), { maxRetriesPerLeg: 2, legTimeoutTicks: 100 });
            if (!r.ok) throw Error(`route to ${tile.x},${tile.z} failed for ${s.name}: ${r.reason} ${r.detail}`);
            await s.bot.walkTo(tile.x, tile.z, 0);
            if (!await waitUntil(s, () => { const p = s.sdk.getState()?.player; return !!p && p.worldX === tile.x && p.worldZ === tile.z; }, { timeoutTicks: 20 }))
                throw Error(`meeting tile unobserved for ${s.name}`);
        };
        const openBank=async(s:Session)=>{
            const generation=s.bankObservation?.()?.generation??-1;
            if(s.sdk.getState()?.bank?.isOpen){
                if(!(await s.bot.closeBank()).success||!await waitUntil(s,()=>!s.sdk.getState()?.bank?.isOpen,{timeoutTicks:20}))throw Error('fan-in bank did not close: '+s.name);
            }
            if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>{
                check([s.name],[s]);return !!s.sdk.getState()?.bank?.isOpen&&(s.bankObservation?.()?.generation??-1)>generation;
            },{timeoutTicks:20}))throw Error('fan-in fresh bank unavailable: '+s.name);
            return s.bankObservation!()!;
        };
        await to(receiver, meet[1]);
        const initialBank=await openBank(receiver),before=new Map<number,number>();
        for(const item of [...initialBank.items,...receiver.sdk.getInventory()])before.set(item.id,(before.get(item.id)??0)+item.count);
        if(receiver.sdk.getInventory().length>=28&&!receiver.sdk.getInventory().some(i=>exactItem(f.item).test(i.name)))
            await depositObserved(receiver,receiver.sdk.getInventory().at(-1)!);
        await receiver.bot.closeBank();
        const received=new Map<number,number>();
        for (const name of f.donors) {
            if (cancelled) break;
            let donor: Session | undefined, ok = false, count = 0, detail = '';
            try {
                check([f.receiver, name], [receiver]);
                donor = await openBot(name, { onStop: async () => cancel(), onSessionEnd: sessionEnd(name) });
                await to(donor, meet[0]);
                const bank=await openBank(donor),row=bank.items.find(i=>exactItem(f.item).test(i.name));
                if(row){
                    const n0=held(donor.sdk.getInventory(),row.id),generation=bank.generation;
                    if(!(await donor.bot.withdrawItem(exactItem(row.name),row.count)).success||!await waitUntil(donor,()=>{
                        check([f.receiver,name],[receiver!,donor!]);const observed=donor!.bankObservation?.();
                        return !!observed&&observed.generation>generation&&held(donor!.sdk.getInventory(),row.id)===n0+row.count&&held(observed.items,row.id)===0;
                    },{timeoutTicks:20}))throw Error('fan-in exact withdrawal unobserved: '+name);
                }
                if(!(await donor.bot.closeBank()).success||!await waitUntil(donor,()=>!donor!.sdk.getState()?.bank?.isOpen,{timeoutTicks:20}))throw Error('fan-in donor bank did not close: '+name);
                const stack = donor.sdk.getInventory().find(i => exactItem(f.item).test(i.name));
                if (!stack) { detail = `no ${f.item} in the pack or bank`; ok = true; }
                else {
                    count = held(donor.sdk.getInventory(), stack.id);
                    const before = held(receiver.sdk.getInventory(), stack.id);
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
                    ok = await waitUntil(receiver, () => held(receiver!.sdk.getInventory(), stack.id) === before + count && held(donor!.sdk.getInventory(), stack.id) === 0, { timeoutTicks: 20 });
                    detail = ok ? `${name} gave ${count} ${f.item}` : `trade effect unobserved: ${name} ${count} ${f.item}`;
                    if(ok)received.set(stack.id,(received.get(stack.id)??0)+count);
                }
            } catch (error) { detail = String(error); }
            if (donor) {
                closing.add(name.toLowerCase());
                try{if(!await settle([donor],ok,detail)){ok=false;detail+='; donor settlement failed';}}
                catch(error){ok=false;detail+='; donor settlement: '+String(error);}
            }
            results.push({ from: name, ok, count, detail });
            console.log('FANIN_PAIR ' + JSON.stringify(results.at(-1)));
        }
        // Bank what came in at Varrock West, next to the meeting tiles.
        check([f.receiver],[receiver]);await openBank(receiver);
        for(const item of receiver.sdk.getInventory().filter(i=>exactItem(f.item).test(i.name)))await depositObserved(receiver,item);
        const final=receiver.bankObservation?.();
        if(!final)throw Error('fan-in final bank receipt unavailable');
        banked=received.size>0&&[...received].every(([id,count])=>held(final.items,id)===(before.get(id)??0)+count&&held(receiver!.sdk.getInventory(),id)===0);
        if(!banked)throw Error('fan-in exact banked output unproved');
        if(!(await receiver.bot.closeBank()).success)throw Error('fan-in final bank did not close');
    } catch (error) { results.push({ from: '-', ok: false, count: 0, detail: String(error) }); }
    finally {
        let ok = !cancelled&&banked&&results.length===f.donors.length&&results.every(r=>r.ok)&&results.some(r=>r.count>0);
        closing.add(f.receiver.toLowerCase());
        try { ok=!!receiver&&await settle([receiver], ok, `fan-in ${results.filter(r => r.ok).length}/${f.donors.length}: ${results.map(r => `${r.from} ${r.ok ? r.count : 'fail'}`).join(', ')}`)&&ok; }
        catch(error){ok=false;results.push({from:'-',ok:false,count:0,detail:'receiver settlement: '+String(error)});}
        finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); release?.(); }
        console.log('FANIN_RESULT ' + JSON.stringify(results));
        console.log('FANIN_SUMMARY '+JSON.stringify({ok,banked,completed:results.filter(r=>r.from!=='-'&&r.ok).length,requested:f.donors.length,cancelled}));
        process.exitCode = ok ? 0 : 1;
        return{ok,banked,results};
    }
}
if(import.meta.main)itemFaninMain().catch(error=>{console.error('RESULT fail '+String(error));process.exitCode=1;});
