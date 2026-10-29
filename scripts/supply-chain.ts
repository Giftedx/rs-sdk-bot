// Bounded consumer-funded food cycles. Workers own game actions; this controller
// owns sequencing, current-session stock, budgets and useful phase completion.
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {workerSourceRevision} from '../packages/core/src/worker-release';
import {ownedAccounts} from '../packages/core/src/tradeguard';
import {serverFromEnv} from '../packages/core/src/bot';
import {isLocalServer} from '../packages/core/src/localserver';
import {resultCounters} from '../packages/core/src/status';
import {FUND_AMOUNT,FUND_BELOW,FUND_RESERVE} from './courier-funding';

type Role='producer'|'courier'|'consumer';
export type SupplyActors=Record<Role,string>;
type Stock={name:string;at:number;started:number;server:string;inventory:{id:number;count:number}[];bank:{id:number;count:number}[]|null;bankAt:number;pos:{x:number;z:number;level:number}|null;result:string};
type Options={actors:SupplyActors;dir:string;cycles:number;server:string;reserveOpeningCash?:boolean;checkpoint?:(phase:string,active:Role[])=>Promise<void>};
const ROOT=resolve(import.meta.dir,'..'),foodIds=[329,330,333,334];
function need(v:unknown,m:string):asserts v{if(!v)throw Error('supply chain: '+m);}
const rows=(v:unknown):v is {id:number;count:number}[]=>Array.isArray(v)&&v.every(i=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0);
export function supplyCount(s:Pick<Stock,'inventory'|'bank'>,ids:readonly number[],bank=true):number {
    need(rows(s.inventory)&&(!bank||rows(s.bank)),'stock observation unavailable');
    return [...s.inventory,...(bank?s.bank!:[])].filter(i=>ids.includes(i.id)).reduce((n,i)=>n+i.count,0);
}
export function supplyAdmission(food:number,bankCoins:number,courierCoins:number):'earn-reserve'|'drain-food'|'cycle'{
    need([food,bankCoins,courierCoins].every(n=>Number.isSafeInteger(n)&&n>=0),'invalid cycle stock');
    if(courierCoins<FUND_BELOW&&bankCoins<FUND_RESERVE+FUND_AMOUNT)return 'earn-reserve';
    return food>=80?'drain-food':'cycle';
}
export function supplyRestock(feathers:number,target=1000):number {
    need(Number.isSafeInteger(feathers)&&feathers>=0&&Number.isSafeInteger(target)&&target>=50&&target<=1000,'invalid feather stock/target');
    return Math.max(0,target-feathers);
}
export async function runSupplyChain(o:Options){
    need(Number.isSafeInteger(o.cycles)&&o.cycles>=1&&o.cycles<=20,'cycles must be1..20');
    const roles=['producer','courier','consumer'] as const,names=roles.map(r=>o.actors[r]);
    need(names.every(n=>/^[A-Za-z0-9]{1,12}$/.test(n))&&new Set(names.map(n=>n.toLowerCase())).size===3,'three distinct owned actors required');
    const owned=ownedAccounts(o.server);
    for(const n of names){need(owned.has(n.toLowerCase()),'actor ownership unavailable');const env=readFileSync(join(ROOT,'vendor/rs-sdk/bots',n,'bot.env'),'utf8');need(serverFromEnv(env)===o.server,'actor endpoint mismatch');}
    // This new controller is qualified locally first; no live activation here.
    need(isLocalServer(o.server),'local qualification required before live release');
    mkdirSync(o.dir,{recursive:true});const revision=workerSourceRevision(),source=()=>need(workerSourceRevision()===revision,'worker source changed');
    const write=(p:string,v:unknown)=>writeFileSync(join(o.dir,p),JSON.stringify(v,null,2));
    need(!existsSync(join(o.dir,'controller.json')),'existing controller evidence retained');write('controller.json',{pid:process.pid,at:Date.now(),actors:o.actors,cycles:o.cycles,server:o.server,revision});
    const capacity=(pair=false)=>{const gib=freemem()/2**30;write('capacity-'+Date.now()+'.json',{gib,minimum:pair?11:8});need(gib>=(pair?11:8),'host memory floor');};
    const stock={} as Record<Role,Stock>;
    const snapshot=async(role:Role,started:number,requireBank=false):Promise<Stock>=>{
        const deadline=Date.now()+4000;
        do{try{
            const s=JSON.parse(readFileSync(join(ROOT,'.practice/status',o.actors[role]+'.json'),'utf8'));
            if(s.name?.toLowerCase()===o.actors[role].toLowerCase()&&s.server===o.server&&s.started>=started-1000&&s.at>=started&&rows(s.inventory)&&typeof s.result==='string'&&s.result.startsWith('ok')&&(!requireBank||rows(s.bank)&&s.bankAt>=started))return s;
        }catch{}await Bun.sleep(100);}while(Date.now()<deadline);
        throw Error('supply chain: completed current-session stock missing: '+role);
    };
    const start=(role:Role,script:string,env:Record<string,string>,label:string)=>{
        need(!existsSync(join(o.dir,label+'.json'))&&!existsSync(join(o.dir,label+'.log')),'prior job evidence retained: '+label);source();
        const started=Date.now(),name=o.actors[role],p=Bun.spawn([process.execPath,script,name],{cwd:ROOT,env:{...process.env,DEMO_OK:'',WORKER_RELEASE:'',RANDOM_EVENTS:'0',FROM:'',FARMERS:'',GIVE_TO:'',FOOD_FROM:'',FUND_FROM:'',FUND_COURIER:'',FUND_ONLY:'0',RESERVE_OPENING_CASH:'0',START:'',HOME_ONLY:'0',OUTBOUND_ONLY:'0',HANDOFF_ONLY:'0',TARGETED_COLLECTION:'0',FEATHERS:'0',TICK3:'0',...env},stdout:'pipe',stderr:'pipe',windowsHide:true});
        let output='',done=false,timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill();},360000);
        const collect=async(stream:ReadableStream<Uint8Array>)=>{for await(const chunk of stream){output+=new TextDecoder().decode(chunk);writeFileSync(join(o.dir,label+'.log'),output);}};
        const result=(async()=>{
            try{const [,,code]=await Promise.all([collect(p.stdout),collect(p.stderr),p.exited]);
                const result={name,script,env,started,ended:Date.now(),code,timedOut,output};write(label+'.json',result);
                need(code===0&&!timedOut&&/^RESULT ok\b/m.test(output)&&/^LOGOUT logged-out\r?$/m.test(output),'job failed: '+label);
                stock[role]=await snapshot(role,started,role!=='courier');
                const line=output.split(/\r?\n/).find(l=>l.startsWith('RESULT ok '))!;return{...result,counters:resultCounters(line.slice(7))};
            }finally{clearTimeout(timer);done=true;}
        })();
        // Observe rejection immediately even when a readiness boundary is still pending.
        void result.catch(()=>{});
        return{result,waitFor:async(pattern:RegExp,timeout=120000)=>{const end=Date.now()+timeout;while(!pattern.test(output)){if(done){await result;throw Error('missing readiness '+label);}need(Date.now()<end,'readiness timeout '+label);await Bun.sleep(100);}}};
    };
    const checkpoint=async(label:string,active:readonly Role[])=>{source();write(label+'-observed.json',stock);await o.checkpoint?.(label,[...active]);};
    for(const role of roles){capacity();await start(role,'scripts/measure/fleet-bank-inspect.ts',{},'inspect-'+role).result;}
    need(supplyCount(stock.producer,foodIds)===0,'opening producer food must be empty');
    await checkpoint('opening',roles);
    const held=supplyCount(stock.courier,foodIds,false);
    if(held>0){
        capacity(true);
        const farmer=start('consumer','scripts/goldfarm-stable.ts',{FOOD_FROM:o.actors.courier,TICKS:'1000',BANK_AT:'2000'},'recovery-consumer');
        await farmer.waitFor(/^GOLDFARM /m,30000);
        const delivered=await start('courier','scripts/foodcourier.ts',{FROM:o.actors.producer,FARMERS:o.actors.consumer,TOTAL_PER:String(held),CAP:'600'},'recovery-delivery').result;
        await farmer.result;
        need(delivered.counters.handed===held&&supplyCount(stock.courier,foodIds,false)===0,'held cargo recovery incomplete');
        await checkpoint('recovery-delivered',['consumer','courier']);
    }
    const cycles=[];
    for(let cycle=1;cycle<=o.cycles;cycle++){
        const p='cycle'+cycle;capacity();
        for(let attempt=0;;attempt++){
            const decision=supplyAdmission(supplyCount(stock.consumer,foodIds),supplyCount(stock.consumer,[995]),supplyCount(stock.courier,[995],false));
            if(decision==='cycle')break;need(attempt<24,'consumer admission budget exhausted');
            const beforeFood=supplyCount(stock.consumer,foodIds),beforeCash=supplyCount(stock.consumer,[995]);
            await start('consumer','scripts/goldfarm-stable.ts',{TICKS:'1000',BANK_AT:'2000'},p+'-'+decision+'-'+attempt).result;
            need(supplyCount(stock.consumer,[995])>beforeCash&&(decision!=='drain-food'||supplyCount(stock.consumer,foodIds)<beforeFood),'consumer admission made no useful progress');
            await checkpoint(p+'-admission-'+attempt,['consumer']);
        }
        capacity(true);
        const funder=start('consumer','scripts/goldfarm-stable.ts',{TICKS:'200',BANK_AT:'2000',FUND_COURIER:o.actors.courier},p+'-funder');
        await funder.waitFor(/^GOLDFARM /m,30000);
        const fund=await start('courier','scripts/foodcourier.ts',{FUND_ONLY:'1',FUND_FROM:o.actors.consumer,RESERVE_OPENING_CASH:cycle===1&&o.reserveOpeningCash!==false?'1':'0',CAP:'400'},p+'-funding').result;
        const earning=await funder.result;await checkpoint(p+'-funded',['consumer','courier']);
        // The short funding batch may move food below/above the demand boundary.
        for(let attempt=0;supplyCount(stock.consumer,foodIds)>=80;attempt++){
            need(attempt<24,'food demand budget exhausted');capacity();
            await start('consumer','scripts/goldfarm-stable.ts',{TICKS:'1000',BANK_AT:'2000'},p+'-drain-'+attempt).result;
            await checkpoint(p+'-drained-'+attempt,['consumer']);
        }
        capacity();need(supplyCount(stock.producer,foodIds)===0,'retained upstream cargo must settle before new production');
        const produce=await start('producer','scripts/fishcook.ts',{TICKS:'650',MAX_CATCHES:String(Math.max(1,80-supplyCount(stock.consumer,foodIds))),TICK3:'0',FEATHER_MIN:'1',FEATHER_FILL:'60',EXTERNAL_REFILL:'1'},p+'-produce').result;
        const amount=supplyCount(stock.producer,foodIds),feathersBefore=supplyCount(stock.producer,[314]);
        need(amount>0&&amount<=80,'new bounded food lot missing');await checkpoint(p+'-produced',['producer']);
        const wanted=supplyRestock(feathersBefore);capacity(true);
        const carrier=start('courier','scripts/foodcourier.ts',{FROM:o.actors.producer,FEATHERS:String(wanted),WAIT:'600',CAP:'2000'},p+'-collection');
        await carrier.waitFor(/^MILESTONE collecting /m);await Bun.sleep(300);
        const supply=await start('producer','scripts/fishcook.ts',{GIVE_TO:o.actors.courier,HANDOFF_ONLY:'1',WAIT:'900',TICKS:'1200'},p+'-supplier').result;
        const collect=await carrier.result;
        need(supplyCount(stock.producer,foodIds)===0&&supplyCount(stock.courier,foodIds,false)===amount,'collection stock mismatch');
        const purchased=collect.counters.feathersBought??NaN;
        need(Number.isSafeInteger(purchased)&&purchased>=0&&(wanted===0||purchased>0)&&supplyCount(stock.producer,[314])===feathersBefore+purchased,'consumer-funded feather restock unconfirmed');
        await checkpoint(p+'-collected',['producer','courier']);capacity(true);
        const farmer=start('consumer','scripts/goldfarm-stable.ts',{FOOD_FROM:o.actors.courier,TICKS:'1000',BANK_AT:'2000'},p+'-consumer');
        await farmer.waitFor(/^GOLDFARM /m,30000);
        const deliver=await start('courier','scripts/foodcourier.ts',{FROM:o.actors.producer,FARMERS:o.actors.consumer,TOTAL_PER:String(amount),CAP:'600'},p+'-delivery').result;
        const use=await farmer.result;
        need(deliver.counters.handed===amount&&supplyCount(stock.courier,foodIds,false)===0&&use.counters.eaten!>0&&use.counters.coinsGained!>0,'delivery/use/output unconfirmed');
        await checkpoint(p+'-completed',['consumer','courier']);
        const record={cycle,amount,wanted,purchased,fundingReceived:fund.counters.received,fundingEarnings:earning.counters.coinsGained,consumerEarnings:use.counters.coinsGained,eaten:use.counters.eaten,stock:JSON.parse(JSON.stringify(stock))};
        write(p+'-result.json',record);cycles.push(record);console.log('SUPPLY_CYCLE '+JSON.stringify({cycle,amount,purchased,fundingReceived:record.fundingReceived,eaten:record.eaten,consumerEarnings:record.consumerEarnings}));
    }
    source();write('result.json',{ok:true,revision,actors:o.actors,cycles,scope:'Bounded locally qualified consumer-funded cycles; ordinary workers and no preset/profile mutation. Initial courier cash reserved once. Not live activation.'});
    return{revision,cycles};
}
if(import.meta.main){
    const actors={producer:process.env.PRODUCER??'',courier:process.env.COURIER??'',consumer:process.env.CONSUMER??''};
    await runSupplyChain({actors,server:'localhost:8888',dir:resolve(process.env.SUPPLY_DIR??'.practice/supply-chain'),cycles:Number(process.env.CYCLES??4)});
}
