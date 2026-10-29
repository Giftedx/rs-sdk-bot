import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';

type Items = { id: number; count: number }[];
export type OrderHoldings = {bank:Items;pack:Items};
export type OrderSnapshot = {donor:OrderHoldings;receiver:OrderHoldings};
// Recovery is based on conserved holdings, never on a trade reply or a log line.
export function reconcileOrder(receipt:any, current:OrderSnapshot): 'resume'|'bank'|'settle' {
    if(!receipt?.baseline || !Array.isArray(receipt.expected) || !receipt.expected.length)
        throw Error('order unresolved: bank/pack baseline missing; '+JSON.stringify({receipt,current}));
    const expected:Items=receipt.expected;
    if(new Set(expected.map(i=>i.id)).size!==expected.length || expected.some(i=>!Number.isSafeInteger(i.id)||i.id<=0||!Number.isSafeInteger(i.count)||i.count<=0))
        throw Error('order unresolved: invalid expected items');
    const count=(items:Items,id:number)=>{
        if(!Array.isArray(items)||items.some(i=>!Number.isSafeInteger(i.id)||!Number.isSafeInteger(i.count)||i.count<0))throw Error('order unresolved: invalid saved holdings');
        const n=items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
        if(!Number.isSafeInteger(n))throw Error('order unresolved: holdings overflow');
        return n;
    };
    const total=(s:OrderHoldings,id:number)=>{
        const n=count(s.bank,id)+count(s.pack,id);if(!Number.isSafeInteger(n))throw Error('order unresolved: total overflow');return n;
    };
    const facts=expected.map(i=>({id:i.id,expected:i.count,
        donorDebit:total(receipt.baseline.donor,i.id)-total(current.donor,i.id),
        receiverCredit:total(current.receiver,i.id)-total(receipt.baseline.receiver,i.id),
        bankCredit:count(current.receiver.bank,i.id)-count(receipt.baseline.receiver.bank,i.id),
        receiverPack:count(current.receiver.pack,i.id),initialPack:count(receipt.baseline.receiver.pack,i.id)}));
    if(facts.every(i=>i.donorDebit===0&&i.receiverCredit===0))return 'resume';
    if(facts.every(i=>i.donorDebit===i.expected&&i.receiverCredit===i.expected))
        return facts.every(i=>i.receiverPack===0&&i.bankCredit===i.expected+i.initialPack)?'settle':'bank';
    throw Error('order unresolved: uncertain bank/pack facts '+JSON.stringify({facts,baseline:receipt.baseline,current}));
}
type Request = { token: string; from: string; to: string; server: string; at: number; state: 'prepared' | 'settled'; expected: Items };

const legacyRoot = resolve(import.meta.dir, '../.practice/courier-handoffs');
const canonical = (p:string) => resolve(p).replaceAll('\\','/').toLowerCase();
const inFoodRoot = (p:string) => canonical(p)===canonical(legacyRoot) || canonical(p).startsWith(canonical(legacyRoot)+'/');
export function createHandoff(allowedIds:readonly number[], root:string) {
 if (!allowedIds.length || new Set(allowedIds).size!==allowedIds.length || allowedIds.some(id=>!Number.isSafeInteger(id)||id<=0)) throw Error('invalid handoff item policy');
 const food=new Set(allowedIds),dir=resolve(root),isFood=[330,334,380].every(id=>food.has(id))&&food.size===3;
 if(!isFood&&inFoodRoot(dir))throw Error('item policy cannot use food receipts');
const file = (from: string, to: string, root = dir) => {
    if (![from, to].every(n => /^[A-Za-z0-9_ -]{1,12}$/.test(n))) throw Error('no courier progress: invalid handoff identity');
    if (!isFood && inFoodRoot(root)) throw Error('item policy cannot use food receipts');
    return join(root, `${from.toLowerCase()}-${to.toLowerCase()}.json`);
};
const read = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw Error('no courier progress: unreadable handoff receipt');
} };
const save = (p: string, value: unknown) => { mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value)); renameSync(tmp, p); };
function handoffCounts(items: Items): Items {
    if (!Array.isArray(items) || items.some(i => !Number.isSafeInteger(i.id) || !Number.isSafeInteger(i.count) || i.count < 0))
        throw Error('no courier progress: invalid handoff inventory');
    const counts = new Map<number, number>();
    for (const i of items) if (food.has(i.id)) counts.set(i.id, (counts.get(i.id) ?? 0) + i.count);
    return [...counts].filter(([,count]) => count > 0).sort(([a],[b]) => a-b).map(([id,count]) => ({id,count}));
}
const delta = (before: Items, after: Items) => {
    const a = handoffCounts(before), b = handoffCounts(after);
    return [...new Set([...a,...b].map(i=>i.id))].sort((a,b)=>a-b).map(id=>({id,count:(b.find(i=>i.id===id)?.count??0)-(a.find(i=>i.id===id)?.count??0)})).filter(i=>i.count!==0);
};
const same = (a: Items, b: Items) => JSON.stringify(a) === JSON.stringify(b);

// Do not accept a legacy cook's trade and discover the protocol mismatch only
// after assets move. The cook publishes this offer before starting its trade.
async function awaitCollectionOffer(s: Session, from: string, server: string, timeoutTicks: number, root = dir): Promise<void> {
    const p = file(from,s.name,root), started=Date.now();
    const offered=()=>{
        const r=read(p), now=Date.now();
        return r?.state==='prepared' && typeof r.token==='string' && r.token.length>0
            && r.from?.toLowerCase()===from.toLowerCase() && r.to?.toLowerCase()===s.name.toLowerCase()
            && r.server===server && Number.isFinite(r.at) && r.at>=started && r.at<=now
            && now-r.at<=120000 && Array.isArray(r.expected) && r.expected.length>0
            && r.expected.every((i:any)=>food.has(i?.id)&&Number.isSafeInteger(i.count)&&i.count>0);
    };
    if(!Number.isSafeInteger(timeoutTicks)||timeoutTicks<1||!await waitUntil(s,offered,{timeoutTicks})||!offered())
        throw Error('no courier progress: fresh cook receipt offer missing; no trade accepted');
}
function handoffCreditMatches(r: Request, credit: any, before: Items, after: Items, now: number): boolean {
    try {
        const debit = delta(after, before), expected = handoffCounts(r.expected);
        return r.state === 'prepared' && r.expected.every(i => food.has(i.id) && Number.isSafeInteger(i.count) && i.count > 0) && expected.length > 0 && expected.every(i=>i.count>0)
            && Number.isFinite(r.at) && r.at <= now && now-r.at <= 120000
            && credit?.token === r.token && credit.from === r.from && credit.to === r.to && credit.server === r.server
            && Number.isFinite(credit.at) && credit.at >= r.at && credit.at <= now
            && same(debit, expected) && same(delta(credit.before, credit.after), expected);
    } catch { return false; }
}

// Capture before any refill can move the recipient's notes into its bank.
async function receiveHandoff<T>(s: Session, from: string, server: string, serve: () => Promise<T>, root = dir): Promise<T> {
    const p = file(from, s.name, root), before = handoffCounts(s.sdk.getInventory());
    const result = await serve();
    const request = read(p);
    const valid = () => request?.state === 'prepared' && typeof request.token === 'string' && request.token.length > 0
        && request.from?.toLowerCase() === from.toLowerCase() && request.to?.toLowerCase() === s.name.toLowerCase() && request.server === server
        && Number.isFinite(request.at) && request.at <= Date.now() && Date.now()-request.at <= 120000
        && Array.isArray(request.expected) && request.expected.length > 0
        && request.expected.every((i:any)=>food.has(i?.id)&&Number.isSafeInteger(i.count)&&i.count>0);
    if (valid()) {
        // Trade closure can precede the inventory update. Capture credit before refill.
        // Preparation time can precede publication; exact deltas bind the fresh request.
        const matched = () => valid() && same(delta(before,handoffCounts(s.sdk.getInventory())),handoffCounts(request.expected));
        if (!matched()) await waitUntil(s,matched,{timeoutTicks:8});
        if (matched()) {
            const current=read(p);
            if (JSON.stringify(current)!==JSON.stringify(request)) throw Error('no courier progress: handoff changed during settlement');
            save(`${p}.credit`, {token:request.token,from:request.from,to:request.to,server,at:Date.now(),before,after:handoffCounts(s.sdk.getInventory())});
        }
    }
    return result;
}

// Collection must wait for the cook's debit proof, not just publish our credit.
async function collectHandoff<T>(s: Session, from: string, server: string, serve: () => Promise<T>, root = dir): Promise<{result:T;received:number}> {
    const p = file(from,s.name,root), initial = read(p);
    const before = handoffCounts(s.sdk.getInventory()), started = Date.now();
    const result = await receiveHandoff(s, from, server, serve, root);
    const after = handoffCounts(s.sdk.getInventory());
    if (same(before, after)) return {result,received:0};
    const credit = read(`${p}.credit`);
    if (!credit || credit.at < started || (initial?.state === 'settled' && initial.token === credit.token)
        || !same(credit.before,before) || !same(credit.after,after))
        throw Error('no courier progress: collection credit unbound; reconcile before retry');
    let received = 0;
    const settled = () => {
        const r = read(p);
        if (r?.state !== 'settled' || r.token !== credit.token || r.from?.toLowerCase() !== from.toLowerCase()
            || r.to?.toLowerCase() !== s.name.toLowerCase() || r.server !== server
            || !handoffCreditMatches({...r,state:'prepared'},credit,r.before,r.after,Date.now())) return false;
        received = handoffCounts(r.expected).reduce((n,i)=>n+i.count,0);
        return true;
    };
    if (!await waitUntil(s,settled,{timeoutTicks:25}) || !settled())
        throw Error('no courier progress: collection cook debit unobserved; reconcile before retry');
    return {result,received};
}

async function sendHandoff(s: Session, to: string, server: string, expected: Items, trade: () => Promise<unknown>, root = dir): Promise<number> {
    const p = file(s.name,to,root), prior = read(p);
    if (prior && prior.state !== 'settled') throw Error('no courier progress: unresolved handoff; reconcile before retry');
    const request: Request = {token:randomUUID(),from:s.name,to,server,at:Date.now(),state:'prepared',expected:handoffCounts(expected)};
    if (!server || !request.expected.length || expected.some(i=>!food.has(i.id)||i.count<=0)) throw Error('no courier progress: handoff inputs unknown');
    const before = handoffCounts(s.sdk.getInventory());
    if (request.expected.some(i=>(before.find(b=>b.id===i.id)?.count??0)<i.count)) throw Error('no courier progress: handoff stock missing');
    save(p,{...request,before}); // Persist the debit baseline even if the trade process dies.
    try { await trade(); } catch { /* A lost reply can still have transferred the items. */ }
    // The trade reply and inventory messages can arrive separately on either side.
    const matched = () => handoffCreditMatches(request,read(`${p}.credit`),before,handoffCounts(s.sdk.getInventory()),Date.now());
    if (!await waitUntil(s,matched,{timeoutTicks:25}) || !matched())
        throw Error('no courier progress: handoff debit/credit unobserved; reconcile before retry');
    const credit = read(`${p}.credit`);
    const after = handoffCounts(s.sdk.getInventory());
    save(p,{...request,state:'settled',before,after,credit});
    const amount=request.expected.reduce((n,i)=>n+i.count,0);
    console.log('HANDOFF_RECEIPT '+JSON.stringify({...request,state:'settled',before,after,credit,amount}));
    return amount;
}

 return {handoffCounts,awaitCollectionOffer,handoffCreditMatches,receiveHandoff,collectHandoff,sendHandoff};
}
export const {handoffCounts,awaitCollectionOffer,handoffCreditMatches,receiveHandoff,collectHandoff,sendHandoff}=createHandoff([330,334,380],legacyRoot);
