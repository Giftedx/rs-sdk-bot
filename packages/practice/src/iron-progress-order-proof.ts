// Harness entry only. Import and --verify never start services or log in.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack,PROOF_TICK_MS,type StackOptions} from './stack';
import {canBind} from './ports';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import { FREE_FLOOR_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/smelt-bars.ts','scripts/smelt-bars.test.ts','scripts/smelt-batch.ts','scripts/smelt-batch.test.ts','scripts/smith-batch.ts','scripts/smith-batch.test.ts','packages/planner/src/travel.ts','packages/planner/src/production-batch.ts','packages/practice/src/iron-progress-order-proof.ts','packages/practice/test/iron-progress-order-proof.test.ts'];
const smithing='vendor/rs-sdk/server/content/scripts/skill_smithing/';
const serverFiles=[smithing+'scripts/smelting/smelting.rs2',smithing+'configs/smelting/smelting.struct','vendor/rs-sdk/server/content/scripts/areas/area_alkharid/scripts/border_gate.rs2',
 smithing+'scripts/smithing/smithing.rs2',smithing+'configs/smithing/smithing.dbrow',smithing+'configs/smithing/smithing.struct',smithing+'configs/smithing/smithing.inv',smithing+'configs/smelting/smelting.obj'];
// Delivery takes the practice turn and admits native startup at startupGb; this proof keeps the floor per child.
export const ADMISSION={floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB};
export function ironProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^iron-[a-z0-9-]{1,25}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof ironProofEndpoints>;
export function selectIronProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return ironProofEndpoints(ports,'iron-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function ironProofAccountEnv(text:string,p:ProofEndpoints){
 if(!/^SERVER=localhost:8888\r?$/m.test(text)||!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
 return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startIronProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:PROOF_TICK_MS,xpRate:25,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...serverFiles].map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function ironResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('SMELT_RESULT ')).at(-1)?.slice(13)??'null');}catch{return null;}}
export function ironSaveChecks(before:Save,after:Save,result:any,kind:'entry'|'limited'|'interrupted'){
 const used=total(before,440)-total(after,440),made=count(after,95,2351)-count(before,95,2351),spent=total(before,995)-total(after,995);
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const ordinary=before.position.level===0&&before.position.x===3252&&before.position.z===3420&&before.skills[13]?.level===31&&before.skills[3]?.level===16&&count(before,95,440)===684&&total(before,995)===24;
 const p=after.position;
 return {
  entry:kind!=='entry'||ordinary,
  bank:p.level===0&&Math.max(Math.abs(p.x-3269),Math.abs(p.z-3167))<=3&&count(after,93,440)===0&&count(after,93,2351)===0,
  target:kind==='entry'?made===6&&result?.ok===true:made>=0&&made<6&&result?.ok===false,
  ore:Number.isSafeInteger(result?.losses)&&result.losses>=0&&Number.isSafeInteger(result?.consumedOre)&&used===result.consumedOre&&used===made+result.losses&&count(after,95,440)>=1,
  output:result?.bar==='iron'&&result?.mode==='exact'&&result?.target===6&&result?.targetMet===(made===6)&&result?.made===made&&result?.banked===made,
  // The client sees whole XP: floor(raw tenths / 10).
  xp:result?.xpGain===Math.floor(after.skills[13]!.rawExperience/10)-Math.floor(before.skills[13]!.rawExperience/10)&&(made>0?after.skills[13]!.rawExperience>before.skills[13]!.rawExperience:after.skills[13]!.rawExperience===before.skills[13]!.rawExperience),
  coins:spent===(kind==='entry'?10:0)&&spent===result?.coinsSpent&&result?.initialCoins===total(before,995)&&result?.finalCoins===total(after,995),
  assets:[...ids].every(id=>[440,2351,995].includes(id)||total(before,id)===total(after,id))
   &&[93,94].every(inv=>(before.inventories[inv]??[]).filter(i=>![440,2351,995].includes(i.id)).every(i=>count(before,inv,i.id)===count(after,inv,i.id))),
  skills:before.skills.every((s,i)=>i===13||after.skills[i]?.rawExperience===s.rawExperience),
  health:after.skills[3]?.level===before.skills[3]?.level&&after.skills[3]!.level>0&&result?.died===false&&result?.hpMin===before.skills[3]?.level,
 };
}
export function ironChildChecks(code:number,timedOut:boolean,log:string,kind:'entry'|'limited'|'interrupted'){
 return {exit:!timedOut&&(kind==='entry'?code===0:code!==0),logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  result:kind==='entry'?/^RESULT ok /m.test(log):/^RESULT fail /m.test(log)};
}
// Anvil order: the OreElse Smithing84->85 consumer. Iron platebody 1115 = 5 iron bars 2351 and
// 5 x 250 tenths x 25 = 31250 raw XP each (smithing.dbrow, smithing.struct). Hammer 2347 is retained.
export const SMITH_ORDER={product:1115,bar:2351,bars:5,maximum:3,reserve:334,cap:1600,rawXpPerProduct:5*250*25};
export function smithResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('SMITH_RESULT ')).at(-1)?.slice(13)??'null');}catch{return null;}}
export function smithSaveChecks(before:Save,after:Save,result:any,kind:'anvil'|'refusal'){
 const o=SMITH_ORDER,made=kind==='anvil'?o.maximum:0,material=[o.bar,o.product,995];
 const ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const spent=total(before,995)-total(after,995),p=after.position,q=before.position;
 const raw=(s:Save)=>s.skills[13]!.rawExperience;
 return {
  entry:q.level===0&&q.x===3269&&q.z===3166&&before.skills[13]?.level===(kind==='anvil'?84:30)&&count(before,95,o.bar)===349&&count(before,95,2347)===1&&total(before,995)===404168,
  place:kind==='anvil'?p.level===0&&Math.max(Math.abs(p.x-3185),Math.abs(p.z-3436))<=3:JSON.stringify(p)===JSON.stringify(q),
  target:kind==='anvil'?result?.ok===true&&result?.stop==='target':result?.ok===false&&result?.stop==='refused'&&String(result?.failure).startsWith('smith refused: Smithing 30 is below level 33'),
  // A level refusal stops before the bank is observed: the worker reports no ledger (zeros, banked null),
  // so the saves alone prove that nothing moved.
  output:count(after,95,o.product)-count(before,95,o.product)===made&&total(after,o.product)-total(before,o.product)===made&&count(after,93,o.product)===0
   &&result?.action==='smith'&&result?.product===o.product&&result?.target===o.maximum&&result?.made===made&&result?.banked===(kind==='anvil'?made:null),
  bars:total(before,o.bar)-total(after,o.bar)===made*o.bars&&count(after,95,o.bar)===349-made*o.bars&&count(after,93,o.bar)===0&&result?.reserve===o.reserve
   &&(kind==='refusal'||result?.finalBars===349-made*o.bars),
  // The client sees whole XP: floor(raw tenths / 10).
  xp:raw(after)-raw(before)===made*o.rawXpPerProduct&&result?.xpGain===Math.floor(raw(after)/10)-Math.floor(raw(before)/10),
  coins:spent===(kind==='anvil'?10:0)&&spent===result?.coinsSpent&&(kind==='refusal'||result?.initialCoins===total(before,995)&&result?.finalCoins===total(after,995)),
  hammer:total(after,2347)===total(before,2347)&&count(after,95,2347)===1&&result?.hammerRetained===(kind==='anvil'),
  assets:[...ids].every(id=>material.includes(id)||total(before,id)===total(after,id))
   &&[93,94].every(inv=>(before.inventories[inv]??[]).filter(i=>!material.includes(i.id)).every(i=>count(before,inv,i.id)===count(after,inv,i.id))),
  skills:before.skills.every((s,i)=>i===13||after.skills[i]?.rawExperience===s.rawExperience),
  health:after.skills[3]?.level===before.skills[3]?.level&&after.skills[3]!.level>0&&result?.died===false&&result?.hpMin===before.skills[3]?.level,
 };
}
const cases=['entry','limited','interrupted','anvil','refusal'] as const;
type Case=typeof cases[number];
const smithCase=(id:Case):id is 'anvil'|'refusal'=>id==='anvil'||id==='refusal';
export function verifyIron(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const endpoints=ironProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 checks.endpoints=meta.server===endpoints.server;
 for(const id of cases){
  const dir=join(directory,id),c=meta.cases?.find((v:any)=>v.id===id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...(smithCase(id)?smithSaveChecks(before,after,smithResult(log),id):ironSaveChecks(before,after,ironResult(log),id)),...ironChildChecks(c?.code,c?.timedOut,log,id==='anvil'?'entry':id==='refusal'?'interrupted':id),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,scope:'Native installed iron CLI only: smelt entry/interrupt and the anvil order with a level refusal. No live release, unattended or speed claim.',nextConsumer:'run-iron-oreelse-anvil85: OreElse Smithing84->85, three banked iron platebodies'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
const smithPreset=(level:number):SaveConfig=>({position:{x:3269,z:3166,level:0},skills:{Smithing:level,Hitpoints:35},inventory:[{id:995,count:7340}],
 bank:[{id:2351,count:349},{id:2349,count:1641},{id:2347,count:1},{id:995,count:396828},{id:440,count:1}]});
const smithEnv={ORDER_ACTION:'smith',PRODUCT_ID:String(SMITH_ORDER.product),MAX_MAKE:String(SMITH_ORDER.maximum),BAR_RESERVE:String(SMITH_ORDER.reserve)};
const smeltPreset=(id:Case):SaveConfig=>({position:id==='entry'?{x:3252,z:3420,level:0}:{x:3269,z:3167,level:0},skills:{Mining:99,Smithing:31,Hitpoints:16},
 inventory:[{id:1265,count:1},{id:315,count:2}],bank:[{id:440,count:id==='limited'?2:684},{id:995,count:24},{id:436,count:7},{id:438,count:9},{id:2349,count:3}]});
const CASES:Record<Case,{preset:SaveConfig;cap:string;env:Record<string,string>;timeoutMs:number}>={
 entry:{preset:smeltPreset('entry'),cap:'2500',env:{MAX_MAKE:'6',ORE_RESERVE:'1',ORDER_MODE:'exact'},timeoutMs:240000},
 limited:{preset:smeltPreset('limited'),cap:'2500',env:{MAX_MAKE:'6',ORE_RESERVE:'1',ORDER_MODE:'exact'},timeoutMs:240000},
 interrupted:{preset:smeltPreset('interrupted'),cap:'1',env:{MAX_MAKE:'6',ORE_RESERVE:'1',ORDER_MODE:'exact'},timeoutMs:240000},
 // CAP 1600 ticks is 240 s at 150 ms; the margin covers the bounded final bank walk and logout.
 anvil:{preset:smithPreset(84),cap:String(SMITH_ORDER.cap),env:smithEnv,timeoutMs:330000},
 refusal:{preset:smithPreset(30),cap:String(SMITH_ORDER.cap),env:smithEnv,timeoutMs:60000},
};
export function childConfiguration(name:string,id:Case,inherited:NodeJS.ProcessEnv=process.env,endpoints?:ProofEndpoints){
 const c=CASES[id];
 return{cmd:['bun','scripts/smelt-bars.ts',name,c.cap,'iron'],cwd:root,windowsHide:true,
  env:{...inherited,...endpoints?.env,...(endpoints?{GATEWAY_URL:endpoints.gateway}:{}),DEMO_OK:'',RANDOM_EVENTS:'0',...c.env}};
}
async function run(directory:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient free memory: below the floor');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('iron proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'iron-progress-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts=[],endpoints=selectIronProofEndpoints();
  stack=await startIronProofStack(endpoints);
  for(const [index,id] of cases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('insufficient practice free memory floor');
   const dir=join(directory,id);mkdirSync(dir);
   const name=runBotName('knobiron',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('isolated practice identity already exists');
   const account=await createBot(name);
   writeFileSync(account.envPath,ironProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
   const c=CASES[id],path=await applyPreset(name,c.preset);copyFileSync(path,join(dir,'before.sav'));
   const child=Bun.spawn({...childConfiguration(name,id,process.env,endpoints),windowsHide:true,stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err'))});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},c.timeoutMs);
   const code=await child.exited;clearTimeout(timer);await termination;
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log'))});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance},cases:receipts},null,2));
   // Preserve the failed case; do not proceed with a still-owned account.
   if(!persisted.matched||timedOut)throw Error('iron child logout/save deadline; evidence retained');
  }
  return verifyIron(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the iron-progress-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyIron(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
