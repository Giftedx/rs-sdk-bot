// The courier requests a fixed cash float from one owned thief. A persistent claim prevents a repeated payment
// after a lost acknowledgement or process exit. Unknown settlements stay claimed for review, never retry blind.
import {constants,copyFileSync,existsSync,mkdirSync,readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Session} from '../packages/core/src/inprocess';
import {hasPayout} from '../packages/core/src/bank-demand';
import {ownedAccounts} from '../packages/core/src/tradeguard';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {preparePayout} from './banker';

const NAME=/^[A-Za-z0-9_ -]{1,12}$/,TOKEN=/^[a-f0-9-]{36}$/i;
const BANK={x:2654,z:3283,radius:6};
export const FUND_AMOUNT=5000,FUND_BELOW=1500,FUND_RESERVE=10000;
const root=resolve(import.meta.dir,'..'),defaultDir=join(root,'.practice/courier-funding');
type Options={dir?:string;owned?:ReadonlySet<string>;readStatus?:(name:string)=>any};
type Request={token:string;funder:string;items:{name:string;count:number}[]};
type Receipt={token:string;from:string;to:string;amount:number;state:'prepared'|'paid'|'failed'|'declined'|'unknown';at:number;detail?:string};
const coinCount=(s:Session)=>s.sdk.getInventory().filter(i=>i.id===995).reduce((n,i)=>n+i.count,0);
const readJSON=(file:string,limit=4096)=>{if(statSync(file).size>limit)throw Error('funding record too large');return JSON.parse(readFileSync(file,'utf8'));};
const status=(name:string,o:Options)=>o.readStatus?o.readStatus(name):readJSON(join(root,'.practice/status',`${name}.json`),256*1024);
const paths=(courier:string,o:Options)=>{
    if(!NAME.test(courier))throw Error('invalid funding courier');
    const dir=o.dir??defaultDir;return{dir,request:join(dir,`${courier}.json`),claim:join(dir,`${courier}.claimed.json`)};
};
const receiptPath=(dir:string,token:string)=>{if(!TOKEN.test(token))throw Error('invalid funding token');return join(dir,`${token}.result.json`);};
function receipt(dir:string,r:Receipt){
    mkdirSync(dir,{recursive:true});const file=receiptPath(dir,r.token),temp=`${file}.tmp-${process.pid}`;
    writeFileSync(temp,JSON.stringify({...r,detail:r.detail?.slice(0,500)}));renameSync(temp,file);console.log('FUNDING '+JSON.stringify(r));
}
export function fundingRequestValid(funder:string,courier:string,s:any,r:any,at:number,server:string,owned:ReadonlySet<string>,now=Date.now()):boolean {
    return NAME.test(funder)&&NAME.test(courier)&&owned.has(funder.toLowerCase())&&owned.has(courier.toLowerCase())
        &&typeof r?.funder==='string'&&r.funder.toLowerCase()===funder.toLowerCase()&&typeof r.token==='string'&&TOKEN.test(r.token)
        &&r.items?.length===1&&r.items[0]?.name==='Coins'&&r.items[0]?.count===FUND_AMOUNT
        &&hasPayout(courier,s,r,at,now,BANK,server)&&Array.isArray(s.inventory)
        &&s.inventory.every((i:any)=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0)
        &&s.inventory.filter((i:any)=>i.id===995).reduce((n:number,i:any)=>n+i.count,0)<FUND_BELOW;
}
// Known terminal claims can be cleaned after a process exit. Prepared/unknown claims never become a second trade.
function settlePriorClaim(funder:string,courier:string,o:Options):void {
    const p=paths(courier,o);if(!existsSync(p.claim))return;
    let claim:any;try{claim=readJSON(p.claim);}catch{throw Error('no courier progress: unreadable funding claim');}
    if(typeof claim?.funder!=='string'||claim.funder.toLowerCase()!==funder.toLowerCase())throw Error('no courier progress: funding claim has another owner');
    let r:Receipt|undefined;try{r=readJSON(receiptPath(p.dir,claim.token));}catch{}
    if(!r||r.token!==claim.token||typeof r.from!=='string'||typeof r.to!=='string'||r.from.toLowerCase()!==funder.toLowerCase()||r.to.toLowerCase()!==courier.toLowerCase()
        ||r.amount!==FUND_AMOUNT||!['paid','failed','declined'].includes(r.state))throw Error('no courier progress: unresolved funding claim');
    if(existsSync(p.request)&&readJSON(p.request).token===claim.token)rmSync(p.request);
    rmSync(p.claim);
}
function pendingRecord(funder:string,courier:string,server:string,o:Options) {
    settlePriorClaim(funder,courier,o);
    try{const p=paths(courier,o),request:Request=readJSON(p.request),client=status(courier,o),at=statSync(p.request).mtimeMs;
        return fundingRequestValid(funder,courier,client,request,at,server,o.owned??ownedAccounts(server))
            &&!existsSync(receiptPath(p.dir,request.token))?{request,client,at}:null;}
    catch{return null;}
}
export function pendingCourierFunding(funder:string,courier:string,server:string,o:Options={}):boolean {
    return !!pendingRecord(funder,courier,server,o);
}
export async function serviceCourierFunding(s:Session,courier:string,server:string,o:Options={}):Promise<Receipt|null>{
    const pending=pendingRecord(s.name,courier,server,o);if(!pending)return null;
    const p=paths(courier,o);
    // COPYFILE_EXCL claims once without overwriting an existing settlement on Windows or Unix.
    try{copyFileSync(p.request,p.claim,constants.COPYFILE_EXCL);}
    catch(e){if(['ENOENT','EEXIST'].includes((e as NodeJS.ErrnoException).code??''))return null;throw Error(`no courier progress: funding claim failed: ${String(e)}`);}
    let request:Request;
    try{request=readJSON(p.claim);}catch{rmSync(p.claim);return null;}
    // Keep the eligibility snapshot and original request age. A copied file's timestamp is not request age.
    if(request.token!==pending.request.token||!fundingRequestValid(s.name,courier,pending.client,request,pending.at,server,o.owned??ownedAccounts(server))){
        rmSync(p.claim);return null;
    }
    if(existsSync(receiptPath(p.dir,request.token))){settlePriorClaim(s.name,courier,o);return null;}
    try{if(readJSON(p.request).token===request.token)rmSync(p.request,{force:true});}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error(`no courier progress: funding claim cleanup failed: ${String(e)}`);}
    const base={token:request.token,from:s.name,to:courier,amount:FUND_AMOUNT};
    let withdrawn=false,dispatched=false;const original=coinCount(s);
    const finish=(state:Receipt['state'],detail?:string)=>{const r={...base,state,detail,at:Date.now()};receipt(p.dir,r);if(state!=='unknown'&&state!=='prepared')rmSync(p.claim);return r;};
    try{
        if(!(await s.bot.openBank()).success)return finish('declined','bank unavailable');
        await waitTicks(s,1);
        const bank=s.sdk.getState()?.bank.items.find(i=>i.id===995)?.count??0;
        if(!Number.isSafeInteger(bank)||bank<FUND_RESERVE+FUND_AMOUNT){await s.bot.closeBank();return finish('declined','bank reserve');}
        await preparePayout(s,request.items);withdrawn=true;
        // preparePayout closes the bank; its SDK item list is then empty. Reopen for a completed reserve check.
        if(!(await s.bot.openBank()).success)return finish('unknown','reserve bank unavailable');
        await waitTicks(s,1);
        if((s.sdk.getState()?.bank.items.find(i=>i.id===995)?.count??0)<FUND_RESERVE){
            await s.bot.openBank();await s.bot.depositItem(/^coins$/i,FUND_AMOUNT);await waitTicks(s,1);await s.bot.closeBank();
            if(coinCount(s)!==original)return finish('unknown','reserve refund not confirmed');
            withdrawn=false;return finish('declined','bank reserve after withdrawal');
        }
        await s.bot.closeBank();
        receipt(p.dir,{...base,state:'prepared',at:Date.now()});
        const before=coinCount(s);dispatched=true;
        const result=await s.bot.serveTrades({from:new RegExp(`^${courier}$`,'i'),give:[{item:/^coins$/i,amount:FUND_AMOUNT}],maxTrades:1,timeout:60000});
        const confirmed=result.trades.some(t=>t.success&&t.gave.filter(i=>/^coins$/i.test(i.name)).reduce((n,i)=>n+i.count,0)===FUND_AMOUNT);
        if(confirmed)await waitUntil(s,()=>coinCount(s)===before-FUND_AMOUNT,{timeoutTicks:8});
        const debit=before-coinCount(s);
        if(confirmed&&debit===FUND_AMOUNT)return finish('paid');
        if(debit!==0||confirmed)return finish('unknown','trade and wallet do not agree');
        if(!(await s.bot.openBank()).success)return finish('unknown','refund bank unavailable');
        await s.bot.depositItem(/^coins$/i,FUND_AMOUNT);await waitTicks(s,1);await s.bot.closeBank();
        if(coinCount(s)!==original)return finish('unknown','refund not confirmed');
        withdrawn=false;return finish('failed',result.message);
    }catch(e){
        if(withdrawn||dispatched){try{receipt(p.dir,{...base,state:'unknown',at:Date.now(),detail:String(e)});}catch{}throw Error(`no courier progress: funding settlement uncertain: ${String(e)}`);}
        await s.bot.closeBank();return finish('failed',String(e));
    }
}
export async function requestCourierFunding(s:Session,funder:string,server:string,o:Options={}):Promise<{received:number;reason:string}>{
    if(coinCount(s)>=FUND_BELOW)return{received:0,reason:'sufficient'};
    const owned=o.owned??ownedAccounts(server),p0=s.sdk.getState()?.player;
    if(!NAME.test(funder)||!owned.has(funder.toLowerCase())||!owned.has(s.name.toLowerCase()))throw Error('no courier progress: funding identity is not owned');
    if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-BANK.x),Math.abs(p0.worldZ-BANK.z))>BANK.radius)return{received:0,reason:'away from funding bank'};
    let donor:any;try{donor=status(funder,o);}catch{return{received:0,reason:'funder unavailable'};}
    if(typeof donor?.name!=='string'||donor.name.toLowerCase()!==funder.toLowerCase()||donor.server!==server||donor.result||!Number.isFinite(donor.at)
        ||Date.now()-donor.at<0||Date.now()-donor.at>=30000||donor.pos?.level!==0
        ||Math.max(Math.abs(donor.pos.x-BANK.x),Math.abs(donor.pos.z-BANK.z))>45)return{received:0,reason:'funder unavailable'};
    const p=paths(s.name,o);mkdirSync(p.dir,{recursive:true});
    if(existsSync(p.request)||existsSync(p.claim))return{received:0,reason:'funding request already owned'};
    const token=randomUUID(),request:Request={token,funder,items:[{name:'Coins',count:FUND_AMOUNT}]},before=coinCount(s);
    writeFileSync(p.request,JSON.stringify(request),{flag:'wx'});
    console.log(`MILESTONE funding-request ${funder} token=${token}`);
    try{
        const near=()=>s.sdk.getState()?.nearbyPlayers.some(p=>p.name.toLowerCase()===funder.toLowerCase()&&p.distance<=6
            &&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=6);
        const progress=()=>{try{return readJSON(receiptPath(p.dir,token)) as Receipt;}catch{return undefined;}};
        const terminal=()=>['paid','declined','failed','unknown'].includes(progress()?.state??'');
        await waitUntil(s,()=>!!near()&&progress()?.state==='prepared'||terminal(),{timeoutTicks:150});
        let r:Receipt|undefined;try{r=readJSON(receiptPath(p.dir,token));}catch{}
        if(r&&['declined','failed','unknown'].includes(r.state))return{received:0,reason:r.state};
        if(!near()||r?.state!=='prepared')return{received:0,reason:'funder not ready'};
        const trade=await s.bot.trade(new RegExp(`^${funder}$`,'i'),{want:[{item:/^coins$/i,amount:FUND_AMOUNT}],timeout:60000,requestTimeout:30000,retryOnBusy:true});
        if(trade.success)await waitUntil(s,()=>coinCount(s)-before===FUND_AMOUNT,{timeoutTicks:8});
        const got=coinCount(s)-before;
        if(trade.success&&got===FUND_AMOUNT){console.log(`MILESTONE funding-received ${got} from=${funder} token=${token}`);return{received:got,reason:'paid'};}
        if(got!==0)throw Error('no courier progress: funding receipt uncertain');
        return{received:0,reason:trade.message};
    }finally{
        // Only the requester owns an unclaimed request. A payer's claim survives timeouts and process exits.
        try{if(!existsSync(p.claim)&&readJSON(p.request).token===token&&!existsSync(p.claim))rmSync(p.request,{force:true});}
        catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT'&&existsSync(p.request))throw e;}
    }
}
