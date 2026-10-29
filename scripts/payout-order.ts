import {existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHandoff, reconcileOrder, type OrderSnapshot} from './courier-handoff';

export const ownerAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}};

// wx elects one owner. A permanent, token-specific wx tombstone elects only one
// reaper of a dead generation. Never unlink a lock based on a PID check alone:
// a delayed second reaper could otherwise delete the replacement owner's lock.
export function acquireExclusiveLease(file:string,runId:string):()=>void {
    mkdirSync(dirname(file),{recursive:true});
    const value=JSON.stringify({pid:process.pid,runId,token:crypto.randomUUID()});
    try { writeFileSync(file,value,{flag:'wx'}); }
    catch(e:any) {
        if(e.code!=='EEXIST')throw e;
        const raw=readFileSync(file,'utf8'),old=JSON.parse(raw);
        if(!Number.isSafeInteger(old.pid)||old.pid<=0||!/^[a-f0-9-]{36}$/.test(old.token)||ownerAlive(old.pid))
            throw Error('account/order lease conflict: '+file);
        // Retain this tiny tombstone, including after a crash. Its token is never reused.
        writeFileSync(file+'.reaped-'+old.token,value,{flag:'wx'});
        if(readFileSync(file,'utf8')!==raw)throw Error('lease changed during takeover: '+file);
        unlinkSync(file);
        // A fresh claimant may win this gap. wx still permits exactly one winner.
        writeFileSync(file,value,{flag:'wx'});
    }
    return ()=>{if(existsSync(file)&&readFileSync(file,'utf8')===value)unlinkSync(file);};
}

// The named entry owns this journal. Legacy payoutOrder callers retain their interface.
export function exactOrder(key:string,from:string,to:string,server:string,items:{name:string;count:number}[],base=resolve(import.meta.dir,'../.practice/item-handoffs')) {
    if(!/^[a-zA-Z0-9-]{1,64}$/.test(key))throw Error('HANDOFF_ORDER is required: exact key, 1-64 letters/digits/hyphens');
    if(![from,to].every(n=>/^[A-Za-z0-9_ -]{1,12}$/.test(n))||from.toLowerCase()===to.toLowerCase()||!server)throw Error('invalid exact order identity');
    if(!items.length||items.some(i=>!i.name||!Number.isSafeInteger(i.count)||i.count<=0)||new Set(items.map(i=>i.name.toLowerCase())).size!==items.length)throw Error('invalid exact order items');
    const root=join(base,key),file=join(root,`${from.toLowerCase()}-${to.toLowerCase()}.json`);
    const read=():any=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
    const previous=read(),identity={order:key,from:from.toLowerCase(),to:to.toLowerCase(),server,items:items.map(i=>({...i,name:i.name.toLowerCase()}))};
    if(previous?.state==='settled')throw Error('payout prerequisite: order already settled; no login');
    if(previous&&JSON.stringify(previous.identity)!==JSON.stringify(identity))throw Error('order unresolved: identity/items or bank/pack baseline unavailable; '+JSON.stringify(previous));
    if(previous?.state==='entering'&&(!previous.owner||!Number.isSafeInteger(previous.owner.pid)||previous.owner.pid<=0||!previous.owner.goal||previous.baseline||previous.expected))
        throw Error('order unresolved: invalid entry owner or premature baseline');
    if(previous&&previous.state!=='entering'&&(previous.state!=='prepared'||!previous.baseline||!Array.isArray(previous.expected)||previous.expected.length!==items.length
        ||previous.expected.some((i:any,k:number)=>!Number.isSafeInteger(i.id)||i.id<=0||i.count!==items[k]!.count)))throw Error('order unresolved: invalid saved baseline/expected items; '+JSON.stringify(previous));
    const save=(value:any)=>{mkdirSync(root,{recursive:true});const temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(value));renameSync(temp,file);};
    const prepare=(expected:{id:number;count:number}[],baseline:OrderSnapshot)=>{
        const entry=read();
        if(entry&&(entry.state!=='entering'||entry.owner?.pid!==process.pid||entry.owner?.goal!==(process.env.BOT_GOAL??'')))throw Error('order already prepared; reconcile before retry');
        if(expected.length!==items.length||expected.some((i,k)=>i.count!==items[k]!.count))throw Error('order expected quantities differ');
        const receipt={...entry,token:entry?.token??crypto.randomUUID(),from,to,server,at:Date.now(),state:'prepared',expected,identity,baseline,
            owner:entry?.owner??{pid:process.pid,goal:process.env.BOT_GOAL??'',at:Date.now()},
            definitionBoundary:{entry:'scripts/handoff-inputs.ts',settlement:'saved donor bank+pack debit and receiver bank credit',
                sharedDependencies:['scripts/banker.ts::preparePayout','packages/core/src/deposit.ts::depositObserved'],
                excludedExecutors:['scripts/banker.ts::main','scripts/take-from-banker.ts']}};
        if(reconcileOrder(receipt,baseline)!=='resume')throw Error('invalid initial baseline');
        // Exclusive creation prevents two first writers from replacing the baseline.
        mkdirSync(root,{recursive:true});if(entry)save(receipt);else writeFileSync(file,JSON.stringify(receipt),{flag:'wx'});return receipt;
    };
    const settle=(current:OrderSnapshot)=>{
        const receipt=read();
        if(reconcileOrder(receipt,current)!=='settle')throw Error('receiver bank credit not settled');
        const settled={...receipt,state:'settled',afterHoldings:current,settledAt:Date.now()};save(settled);return settled;
    };
    // Compare against the owner this order instance read, under an exclusive
    // journal lease. Account leases alone cannot make this shared API a CAS.
    const claim=()=>{
        const release=acquireExclusiveLease(file+'.claim.lock',key);
        try {
            const r=read();
            if(JSON.stringify(r?.owner??null)!==JSON.stringify(previous?.owner??null)||r?.state==='settled')throw Error('order owner changed; no login');
            if(r?.owner&&r.owner.pid!==process.pid&&ownerAlive(r.owner.pid))throw Error('order owner still alive: '+r.owner.pid);
            const owner={pid:process.pid,goal:process.env.BOT_GOAL??'',at:Date.now(),token:crypto.randomUUID()};
            const next={...(r??{token:crypto.randomUUID(),from,to,server,identity,state:'entering',at:Date.now()}),
                recoveryOwner:r?.owner??null,previousOwners:[...(r?.previousOwners??[]),...(r?.owner?[r.owner]:[])],owner};
            if(r)save(next);else writeFileSync(file,JSON.stringify(next),{flag:'wx'});
            return next;
        } finally {release();}
    };
    return {file,read,prepare,settle,claim};
}
export function payoutOrder(env:Record<string,string|undefined>=process.env, base=resolve(import.meta.dir, '../.practice/item-handoffs')) {
    if (!env.HANDOFF_ORDER && !env.HANDOFF_ITEM_ID) return;
    const order=env.HANDOFF_ORDER??'',id=Number(env.HANDOFF_ITEM_ID);
    if(!/^[a-zA-Z0-9-]{1,64}$/.test(order)||!Number.isSafeInteger(id)||id<=0)throw Error('payout prerequisite: invalid exact order');
    const root=join(base,order),receipt=createHandoff([id],root);
    const preflight=(from:string,to:string)=>{
        if(![from,to].every(n=>/^[A-Za-z0-9_ -]{1,12}$/.test(n)))throw Error('payout prerequisite: invalid order identity');
        const p=join(root,`${from.toLowerCase()}-${to.toLowerCase()}.json`);
        if(existsSync(p)) {
            const prior=JSON.parse(readFileSync(p,'utf8'));
            throw Error(`payout prerequisite: order ${prior.state==='settled'?'already settled':'unresolved'}; reconcile before retry`);
        }
    };
    const expected=(want:{name:string;count:number}[],inventory:{id:number;name:string;count:number}[])=>{
        if(want.length!==1||!Number.isSafeInteger(want[0]!.count)||want[0]!.count<=0)throw Error('payout prerequisite: one exact item required');
        const matching=inventory.filter(i=>i.name.toLowerCase()===want[0]!.name.toLowerCase()&&i.count>0);
        if(!matching.length||matching.some(i=>i.id!==id)||matching.reduce((n,i)=>n+i.count,0)<want[0]!.count)throw Error('payout prerequisite: exact item stock missing');
        return [{id,count:want[0]!.count}];
    };
    return {id,root,receipt,preflight,expected};
}
