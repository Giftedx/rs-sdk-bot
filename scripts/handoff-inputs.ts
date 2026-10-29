// One exact owned handoff. HANDOFF_ORDER is mandatory; saved bank/pack totals govern recovery.
// HANDOFF_ORDER=order-key bun scripts/handoff-inputs.ts <donor> <receiver> 153:Flax --notes --keep='food|tool' --bank-x=2725 --bank-z=3493
// Both jobs must already be paused externally. Existing stop files are never cleared.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { assertServerAllowed, serverFromEnv, openBot, settle } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {preparePayout} from './banker';
import {exactOrder,acquireExclusiveLease,ownerAlive} from './payout-order';
import {reconcileOrder, type OrderSnapshot} from './courier-handoff';

type Item = { name: string; count: number };
export type Handoff = { donor: string; receiver: string; items: Item[]; notes: boolean; keep?: string;
    x: number; z: number; requestMs: number; timeoutMs: number; graceMs: number };
const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
export function parseHandoff(args: string[]): Handoff {
    const [donor, receiver, ...rest] = args;
    if (!donor || !receiver || ![donor,receiver].every(n => n.trim() === n && ACCOUNT.test(n) && !/^(main|haggis)$/i.test(n)) || donor.toLowerCase() === receiver.toLowerCase())
        throw new Error('two distinct non-reserved account names required');
    const cfg: Handoff = { donor, receiver, items: [], notes: false, x: 2654, z: 3283, requestMs: 30_000, timeoutMs: 240_000, graceMs: 45_000 };
    const seen = new Set<string>();
    for (const arg of rest) {
        if (!arg.startsWith('--')) {
            const m = arg.match(/^(\d+):(.+)$/);
            const count = Number(m?.[1]), name = m?.[2]?.trim();
            if (!name || /[\r\n\0]/.test(name) || name.length > 80 || !Number.isSafeInteger(count) || count < 1) throw new Error('invalid handoff item/count');
            if (cfg.items.some(i => i.name.toLowerCase() === name.toLowerCase())) throw new Error('duplicate handoff item');
            cfg.items.push({ name, count }); continue;
        }
        const [key, ...value] = arg.split('=');
        if (seen.has(key!)) throw new Error('duplicate handoff option'); seen.add(key!);
        const v = value.join('=');
        if (key === '--notes' && !value.length) cfg.notes = true;
        else if (key === '--keep' && v && v.length <= 300) { new RegExp(v, 'i'); cfg.keep = v; }
        else if (['--bank-x','--bank-z','--request-ms','--timeout-ms','--grace-ms'].includes(key!) && /^\d+$/.test(v)) {
            const fields: Record<string,'x'|'z'|'requestMs'|'timeoutMs'|'graceMs'> = { '--bank-x': 'x', '--bank-z': 'z', '--request-ms': 'requestMs', '--timeout-ms': 'timeoutMs', '--grace-ms': 'graceMs' };
            const field = fields[key!]!;
            cfg[field] = Number(v);
        } else throw new Error(`unknown/invalid handoff option ${key}`);
    }
    if (!cfg.items.length || ![cfg.x,cfg.z].every(n => Number.isSafeInteger(n) && n > 0 && n < 16384)
        || !Number.isSafeInteger(cfg.requestMs) || cfg.requestMs < 1000 || cfg.requestMs > 60_000
        || !Number.isSafeInteger(cfg.timeoutMs) || cfg.timeoutMs < cfg.requestMs || cfg.timeoutMs > 600_000
        || !Number.isSafeInteger(cfg.graceMs) || cfg.graceMs < 1000 || cfg.graceMs > 60_000) throw new Error('invalid handoff bounds/items');
    if (cfg.keep && cfg.items.some(i => new RegExp(cfg.keep!, 'i').test(i.name))) throw new Error('requested item overlaps protected KEEP');
    return cfg;
}

export type HandoffChild = { code(): number | null; output(): string; goal?: string };
type Request = { at: number; items: unknown };
export type HandoffDeps = {
    server: string; owned: ReadonlySet<string>; now(): number; pause(ms: number): Promise<void>;
    status(name: string): any; request(): Request | undefined; otherRequests(): string[]; stopped(name: string): boolean;
    spawn(role: 'receiver' | 'donor'): HandoffChild; stop(name: string): void; log?(line: string): void;
};
function sameItems(raw: unknown, want: Item[]): boolean {
    return Array.isArray(raw) && raw.length === want.length && want.every(i => raw.filter(w => w && typeof w.name === 'string'
        && w.name.toLowerCase() === i.name.toLowerCase() && w.count === i.count).length === 1);
}
function active(s: any, name: string, server: string, now: number) {
    if (!s) return false;
    if (s.name?.toLowerCase() !== name.toLowerCase() || s.server?.toLowerCase() !== server.toLowerCase() || !Number.isFinite(s.at)) throw new Error(`invalid status identity for ${name}`);
    return !s.result && now - s.at < 30_000; // A future timestamp also fails closed.
}
const result = (c: HandoffChild) => c.output().split(/\r?\n/).filter(l => l.startsWith('RESULT ')).pop() ?? '';

export async function runHandoff(c: Handoff, d: HandoffDeps) {
    const children: { name: string; child: HandoffChild }[] = [];
    let phase = 'preflight', ok = false, reason = '', cleanupPending: string[] = [];
    const start = d.now();
    try {
        for (const n of [c.donor,c.receiver]) {
            if (!d.owned.has(n.toLowerCase())) throw new Error(`not authenticated owned: ${n}`);
            if (d.stopped(n)) throw new Error(`existing stop file: ${n}; clear manually after review`);
            if (active(d.status(n), n, d.server, d.now())) throw new Error(`account active: ${n}; pause its job externally`);
        }
        if (d.otherRequests().length) throw new Error('other payout requests pending; donor must serve only this handoff');
        const previous = d.request()?.at ?? -1;
        phase = 'request'; const receiverStarted = d.now();
        const receiver = d.spawn('receiver'); children.push({ name: c.receiver, child: receiver });
        d.log?.('HANDOFF phase=request receiver started');
        while (true) {
            if (receiver.code() !== null) throw new Error(`receiver exited before donor: ${result(receiver) || receiver.code()}`);
            if (d.stopped(c.receiver) || d.stopped(c.donor)) throw new Error('stop file during request phase');
            const req = d.request(), status = d.status(c.receiver);
            if (req && req.at >= receiverStarted && req.at > previous && req.at <= d.now()+1) {
                if (!sameItems(req.items,c.items)) throw new Error('fresh request does not match exact handoff items');
                if (/^START /m.test(receiver.output()) && status?.name?.toLowerCase() === c.receiver.toLowerCase()
                    && status.server?.toLowerCase() === d.server.toLowerCase() && status.started >= receiverStarted && status.at >= receiverStarted && status.at <= d.now() && !status.result
                    && (!receiver.goal || status.goal === receiver.goal)
                    && status.pos?.level === 0 && Math.max(Math.abs(status.pos.x-c.x),Math.abs(status.pos.z-c.z)) <= 8) break;
            }
            if (d.now()-receiverStarted >= c.requestMs || d.now()-start >= c.timeoutMs) throw new Error('fresh authenticated exact request timeout');
            await d.pause(200);
        }
        // No await between the final liveness/idle check and donor spawn.
        if (receiver.code() !== null || active(d.status(c.donor),c.donor,d.server,d.now())) throw new Error('receiver ended or donor became active');
        if (d.otherRequests().length) throw new Error('another payout request appeared before donor start');
        phase = 'transfer';
        const donor = d.spawn('donor'); children.push({ name: c.donor, child: donor });
        d.log?.('HANDOFF phase=transfer fresh exact request verified; donor started');
        const expected = c.items.map(i => `${i.count} ${i.name}`).join(', ');
        const receiptOk = () => receiver.code() === 0 && result(receiver).toLowerCase() === `RESULT ok got ${expected}`.toLowerCase();
        const paid = `MILESTONE paid ${c.receiver} ${expected}`.toLowerCase();
        const payoutOk = () => donor.code() === 0 && /^RESULT ok /.test(result(donor)) && donor.output().split(/\r?\n/).some(l => l.toLowerCase() === paid);
        while (receiver.code() === null || donor.code() === null) {
            if (receiver.code() !== null && !receiptOk()) throw new Error(`receiver exact receipt not proved: ${result(receiver)}`);
            if (donor.code() !== null && !payoutOk()) throw new Error(`donor exited without exact payout: ${result(donor)}`);
            if (d.now()-start >= c.timeoutMs) throw new Error('handoff timeout');
            if (d.stopped(c.receiver) || d.stopped(c.donor)) throw new Error('stop file during transfer');
            await d.pause(200);
        }
        if (!receiptOk()) throw new Error(`receiver exact receipt not proved: ${result(receiver)}`);
        if (!payoutOk()) throw new Error('donor exact payout not proved');
        ok = true; phase = 'done'; reason = `received ${expected}`;
    } catch (e) { reason = String(e); }
    finally {
        const running = children.filter(c => c.child.code() === null);
        for (const c of running) { try { d.stop(c.name); } catch (e) { ok=false;reason+=`; stop failed ${c.name}: ${String(e)}`; } }
        const until = d.now()+c.graceMs;
        while (running.some(c => c.child.code() === null) && d.now()<until) await d.pause(200);
        cleanupPending = running.filter(c => c.child.code() === null).map(c => c.name);
        if (cleanupPending.length) { ok = false; reason += '; graceful stop pending: '+cleanupPending.join(', '); }
    }
    return { ok, phase, reason, cleanupPending, elapsedMs: d.now()-start };
}

export function handoffCommands(c: Handoff, root: string) {
    const env = { BANK_X: String(c.x), BANK_Z: String(c.z), KEEP: c.keep ?? '', PAYOUT_NOTES: c.notes ? '1' : '0', ON_DEMAND: '1', COURIERS: '' };
    return { env, receiver: [process.execPath, join(root,'scripts/take-from-banker.ts'),c.receiver,...c.items.map(i=>`${i.count}:${i.name}`),`--banker=${c.donor}`],
        donor: [process.execPath,join(root,'scripts/banker.ts'),c.donor] };
}

// Shared with GE: read-only coordinator/swarm/pause checks. A matching runId
// permits only its own assignment. Call acquireAccountLeases before openBot too.
export function assertAccountOwnership(names:string[],state:any,jobs:any[],stopped:(name:string)=>boolean,runId:string) {
    for(const name of ['coordinator','swarm',...names])if(stopped(name))throw Error(`existing stop-${name}; preserve owner pause`);
    if(!state||state.version!==1||!Array.isArray(state.tasks)||!Array.isArray(jobs))throw Error('coordinator account ownership unavailable');
    const targets=names;
    for(const record of state.tasks.filter((r:any)=>r.status==='running')) {
        const spec=record.spec;
        if(!spec)throw Error('coordinator task ownership unknown');
        const bindings=spec.participants??(spec.account?[spec.account]:spec.accountFrom?['@'+spec.accountFrom]:[]);
        const accounts=bindings.map((n:string)=>n.startsWith('@')?state.tasks.find((r:any)=>r.spec?.id===n.slice(1))?.receipt?.output?.account:n);
        if(accounts.some((n:unknown)=>typeof n!=='string'))throw Error('coordinator participant ownership unresolved');
        for(const name of targets)if(accounts.some((n:string)=>n.toLowerCase()===name.toLowerCase())&&(!runId||record.runId!==runId))
            throw Error(`account lease conflict: ${name}; coordinator ${spec.id} ${record.runId}`);
    }
    for(const job of jobs)for(const name of targets)
        if(job.enabled!==false&&(job.accounts??[job.account]).some((n:string)=>n?.toLowerCase()===name.toLowerCase())
            &&(!runId||!String(job.goal??'').includes('['+runId+']')))
            throw Error(`account lease conflict: ${name}; swarm ${job.id??job.coordinatorTask??job.script}`);
}

export function assertHandoffOwnership(c:Handoff,state:any,jobs:any[],stopped:(name:string)=>boolean,runId='') {
    assertAccountOwnership([c.donor,c.receiver],state,jobs,stopped,runId);
}

// Shared with GE. Names are case-insensitive. Throws before login on conflict.
// The caller must retain the returned idempotent release through session cleanup
// and call it in finally on every exit. base is only for isolated test storage.
export function acquireAccountLeases(names:string[],runId:string,base=resolve(import.meta.dir,'../.practice/account-leases')):()=>void {
    if(!names.length||names.some(n=>!ACCOUNT.test(n)||n.trim()!==n))throw Error('invalid account lease names');
    const releases:(()=>void)[]=[];
    const release=()=>{for(const done of releases.splice(0).reverse())done();};
    try {
        for(const name of [...new Set(names.map(n=>n.toLowerCase()))].sort())releases.push(acquireExclusiveLease(join(base,name+'.lock'),runId));
        return release;
    }catch(e){release();throw e;}
}

const exactName=(name:string)=>new RegExp('^'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$','i');

export function assertRecoverableStatus(status:any,owner:any,alive:(pid:number)=>boolean) {
    if(!status||status.result)return;
    // Age alone is never evidence of logout. Only this order's dead, recorded
    // process can explain an unfinished status after a crash.
    if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<=0||!owner.goal||status.goal!==owner.goal||alive(owner.pid))
        throw Error('account session ownership unsettled: '+status.name);
}

// Own both sessions in this entry: the shared banker/taker mains are outside the
// definition. Reuse their bounded withdrawal helper, but independently check every effect.
export async function runExactHandoff(c:Handoff,donor:Session,receiver:Session,order:ReturnType<typeof exactOrder>,check:()=>void) {
    if(donor.name.toLowerCase()!==c.donor.toLowerCase()||receiver.name.toLowerCase()!==c.receiver.toLowerCase())throw Error('exact session identity mismatch');
    const sessions=[donor,receiver],start=Date.now();
    const bounded=()=>{check();if(Date.now()-start>=c.timeoutMs)throw Error('exact handoff deadline; reconcile saved state before retry');};
    for(const s of sessions){
        bounded();
        if(!(await s.bot.walkTo(c.x,c.z,2,{timeout:Math.min(c.requestMs,c.timeoutMs)})).success)throw Error(`handoff bank entry failed: ${s.name}`);
        if(!await waitUntil(s,st=>!!st.player&&st.player.level===0&&Math.max(Math.abs(st.player.worldX-c.x),Math.abs(st.player.worldZ-c.z))<=2,{timeoutTicks:20}))throw Error(`handoff bank entry unobserved: ${s.name}`);
    }
    const generations=new Map<Session,number>();
    const bank=async(s:Session)=>{
        bounded();
        const wasOpen=s.sdk.getState()?.bank?.isOpen,prior=generations.get(s)??-1;
        if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>{
            bounded();const b=s.bankObservation?.();return !!b&&(wasOpen||b.generation>prior);
        },{timeoutTicks:10}))throw Error(`bank state unknown: ${s.name}`);
        const b=s.bankObservation!()!;generations.set(s,b.generation);return b;
    };
    await bank(donor);await bank(receiver);
    const saved=order.read(),prior=saved?.state==='prepared'?saved:null;
    const expected:{id:number;count:number}[]=prior?.expected??c.items.map(w=>{
        const matches=donor.bankObservation!()!.items.filter(i=>i.name.toLowerCase()===w.name.toLowerCase());
        if(!matches.length||new Set(matches.map(i=>i.id)).size!==1)throw Error('exact bank item ID unknown: '+w.name);
        return {id:matches[0]!.id,count:w.count};
    });
    if(process.env.HANDOFF_ITEM_ID&&(expected.length!==1||expected[0]!.id!==Number(process.env.HANDOFF_ITEM_ID)))throw Error('HANDOFF_ITEM_ID differs from observed bank item');
    const snapshot=():OrderSnapshot=>{
        const holdings=(s:Session)=>{
            const observed=s.bankObservation?.();if(!observed)throw Error('bank snapshot unavailable: '+s.name);
            const pack=s.sdk.getInventory();
            // Names join noted and unnoted forms. Persist raw IDs too for diagnosis.
            return {bank:expected.map(i=>({id:i.id,count:observed.items.filter(b=>b.id===i.id).reduce((n,b)=>n+b.count,0)})),
                pack:expected.map((i,k)=>({id:i.id,count:pack.filter(p=>p.name.toLowerCase()===c.items[k]!.name.toLowerCase()).reduce((n,p)=>n+p.count,0)})),
                rawBank:observed.items.map(i=>({...i})),rawPack:pack.map(i=>({...i})),generation:observed.generation,at:observed.at};
        };
        return {donor:holdings(donor),receiver:holdings(receiver)};
    };
    const receipt=prior??order.prepare(expected,snapshot());
    let action=reconcileOrder(receipt,snapshot());
    let tradeResults:unknown[]=[];
    if(action==='resume'){
        bounded();
        const missing=c.items.map(w=>({...w,count:Math.max(0,w.count-donor.sdk.getInventory().filter(i=>i.name.toLowerCase()===w.name.toLowerCase()).reduce((n,i)=>n+i.count,0))})).filter(w=>w.count>0);
        if(missing.length)await preparePayout(donor,missing,c.notes,c.keep?new RegExp(c.keep,'i'):null);
        await donor.bot.closeBank();await receiver.bot.closeBank();
        bounded();
        const held=(s:Session,w:Item)=>s.sdk.getInventory().filter(i=>i.name.toLowerCase()===w.name.toLowerCase()).reduce((n,i)=>n+i.count,0);
        const beforeDonor=c.items.map(w=>held(donor,w)),beforeReceiver=c.items.map(w=>held(receiver,w));
        if(c.items.some((w,k)=>beforeDonor[k]!<w.count))throw Error('exact prepared pack stock missing');
        tradeResults=await Promise.allSettled([
            donor.bot.serveTrades({from:exactName(c.receiver),give:c.items.map(w=>({item:exactName(w.name),amount:w.count})),maxTrades:1,timeout:Math.min(60000,c.timeoutMs-(Date.now()-start))}),
            receiver.bot.trade(exactName(c.donor),{want:c.items.map(w=>({item:exactName(w.name),amount:w.count})),requestTimeout:Math.min(c.requestMs,60000),timeout:Math.min(60000,c.timeoutMs-(Date.now()-start))})
        ]);
        await waitUntil(receiver,()=>{
            bounded();return c.items.every((w,k)=>(beforeDonor[k]! - held(donor,w))===w.count&&(held(receiver,w) - beforeReceiver[k]!)===w.count);
        },{timeoutTicks:25});
        // Lost replies do not decide whether items moved. Reopen banks to observe both sides.
        await bank(donor);await bank(receiver);
        action=reconcileOrder(receipt,snapshot());
        if(action==='resume')throw Error('no item moved; prepared order retained for bounded resume; '+JSON.stringify(tradeResults));
    }
    if(action==='bank'){
        bounded();
        for(const w of c.items)for(const id of new Set(receiver.sdk.getInventory().filter(i=>i.name.toLowerCase()===w.name.toLowerCase()).map(i=>i.id))){
            const item=receiver.sdk.getInventory().find(i=>i.id===id);if(item)await depositObserved(receiver,item);
        }
    }
    bounded();
    const settled=order.settle(snapshot());
    console.log('HANDOFF_RECEIPT '+JSON.stringify(settled));
    return {ok:true,phase:'done',reason:'exact donor debit and receiver bank credit',tradeResults,receipt:settled};
}

// Injectable I/O lets process-level regressions exercise this entry without
// credentials or a game server. The real CLI always uses the production defaults.
export async function main(io:{root?:string;openBot?:typeof openBot;settle?:typeof settle;ownedAccounts?:typeof ownedAccounts}={}) {
    const c=parseHandoff(process.argv.slice(2)),root=io.root??resolve(import.meta.dir,'..'),dir=join(root,'.practice');
    // Key and duplicate checks precede even opening credentials or sessions.
    const key=process.env.HANDOFF_ORDER??'';
    if(!/^[a-zA-Z0-9-]{1,64}$/.test(key))throw Error('HANDOFF_ORDER is required before login');
    const server=(n:string)=>serverFromEnv(readFileSync(join(root,'vendor/rs-sdk/bots',n,'bot.env'),'utf8'));
    const host=server(c.donor);if(host!==server(c.receiver))throw Error('handoff accounts must use the same server');
    assertServerAllowed(host);
    const order=exactOrder(key,c.donor,c.receiver,host,c.items,join(dir,'item-handoffs'));
    const owned=(io.ownedAccounts??ownedAccounts)(host),sessions:Session[]=[];
    const runId=process.env.COORDINATOR_RUN_ID??(process.env.BOT_GOAL??'').match(/\[(task-[a-z0-9-]+)\]/)?.[1]??'';
    const saved=order.read(),recoveryOwner=saved?.owner,recoveryOwners=[recoveryOwner,...(saved?.previousOwners??[])].filter(Boolean);
    const alive=ownerAlive;
    if(recoveryOwner&&recoveryOwner.pid!==process.pid&&alive(recoveryOwner.pid))throw Error('order owner still alive: '+recoveryOwner.pid);
    process.env.BOT_GOAL=`${process.env.BOT_GOAL??'handoff'} order:${key} attempt:${crypto.randomUUID()}`;
    let cancelled=false;const cancel=()=>{cancelled=true;};
    const read=(p:string,fallback:any)=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):fallback;
    const check=()=>{
        if(cancelled)throw Error('handoff cancelled');
        assertHandoffOwnership(c,read(join(dir,'coordinator/state.json'),null),read(join(root,'swarm.json'),{}).jobs,n=>existsSync(join(dir,'stop-'+n)),runId);
        for(const name of [c.donor,c.receiver]){
            if(!owned.has(name.toLowerCase()))throw Error('not authenticated owned: '+name);
            if(sessions.some(s=>s.name.toLowerCase()===name.toLowerCase()))continue;
            const status=read(join(dir,'status',name+'.json'),null);
            assertRecoverableStatus(status,recoveryOwners.find(o=>o.goal===status?.goal),alive);
        }
    };
    let release:(()=>void)|undefined;
    let out:any={ok:false,phase:'preflight',reason:''};
    try{
        check();release=acquireAccountLeases([c.donor,c.receiver],runId,join(dir,'account-leases'));
        check();order.claim(); // Durable owner/recoveryOwner precede the first login.
        process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
        check();sessions.push(await (io.openBot??openBot)(c.donor,{onStop:async()=>{cancelled=true;},onSessionEnd:async()=>{cancelled=true;}}));
        check();sessions.push(await (io.openBot??openBot)(c.receiver,{onStop:async()=>{cancelled=true;},onSessionEnd:async()=>{cancelled=true;}}));
        out=await runExactHandoff(c,sessions[0]!,sessions[1]!,order,check);
    }catch(e){out={ok:false,phase:'transfer',reason:String(e)};}
    finally{
        // This entry retains session ownership through the logout checks. Each settle
        // emits its own acknowledgement, matching the existing consumer's two logouts.
        try {for(const s of sessions)out.ok=await (io.settle??settle)([s],out.ok,out.reason)&&out.ok;}
        finally {
            process.off('SIGINT',cancel);process.off('SIGTERM',cancel);
            release?.();
        }
    }
    console.log('HANDOFF_RESULT '+JSON.stringify(out));process.exitCode=out.ok?0:1;
}
if(import.meta.main) main().catch(e=>{console.error(`HANDOFF_RESULT ${JSON.stringify({ok:false,phase:'preflight',reason:String(e)})}`);console.log(`RESULT fail no handoff progress: ${String(e)}`);process.exitCode=1;});
