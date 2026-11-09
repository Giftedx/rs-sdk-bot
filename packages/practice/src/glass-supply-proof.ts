// Harness entry only. --verify reads saved evidence and never opens an account.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack,PROOF_TICK_MS} from './stack';
import {canBind} from './ports';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {capabilityRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {GLASS_BANK,GLASS_RETURN_BANK,glassSupplyLedger,glassSupplyOptions,planGlassSupply,type GlassStock} from '../../../scripts/microbot-glass';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..'),worker='scripts/microbot-glass.ts',proof='packages/practice/src/glass-supply-proof.ts';
export const ADMISSION={floorGb:FREE_FLOOR_GB,startupGb:PRACTICE_STARTUP_GB};
export const glassCases=['entry','owned','ingredients','refusal'] as const;
export type GlassCase=typeof glassCases[number];
const XP_RATE=25,CRAFTING=12;
const pinned=[
 'scripts/skill_crafting/scripts/glass/glass.rs2','scripts/skill_smithing/scripts/smelting/smelting.rs2',
 'scripts/skill_cooking/scripts/cooking.rs2','scripts/skill_cooking/configs/cooking_source/cooking_generic.dbrow',
 'scripts/areas/area_port_sarim/scripts/monk_of_entrana.rs2','scripts/areas/area_entrana/scripts/monk_of_entrana.rs2',
 'maps/m47_51.jm2','maps/m43_52.jm2','maps/m44_52.jm2',
].map(p=>'vendor/rs-sdk/server/content/'+p);
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function glassProofSource(){return{runtime:capabilityRevision([worker,proof]),files:Object.fromEntries([worker,'scripts/microbot-glass.test.ts',proof,'packages/practice/test/glass-supply-proof.test.ts',...pinned].map(p=>[p,hash(join(root,p))]))};}
export function glassProofPreset(id:GlassCase):SaveConfig{
 return{position:{...GLASS_BANK,level:0},skills:{Crafting:51,Hitpoints:39},varps:{160:2},
  inventory:[{id:995,count:17},{id:590,count:1},...(id==='owned'?[{id:1775,count:1}]:[]),...(id==='ingredients'?[{id:1781,count:1}]:[])],
  equipment:[{id:1205,count:1,slot:3}],bank:[{id:995,count:2000},{id:314,count:23},...(id==='owned'?[{id:1775,count:2}]:[]),...(id==='ingredients'?[{id:1783,count:1}]:[])]};
}
export function glassChildConfiguration(name:string,id:GlassCase,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun',worker,name],cwd:root,windowsHide:true,env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',SUPPLY_MODE:'1',MEMBERS:id==='refusal'?'0':'1',MAX_MAKE:'1',MAX_SPEND:'0',CASH_RESERVE:'1000',CAP:'4000'}};
}
const count=(s:Save,inv:number,id:number)=>(s.inventories[inv]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function glassSaveStock(s:Save):GlassStock{const stock:GlassStock={};for(const item of Object.values(s.inventories).flat())stock[item.id]=(stock[item.id]??0)+item.count;return stock;}
export function glassResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('GLASS_SUPPLY_RESULT ')).at(-1)?.slice(20)??'null');}catch{return null;}}
const near=(s:Save,p:{x:number;z:number},n=3)=>s.position.level===0&&Math.max(Math.abs(s.position.x-p.x),Math.abs(s.position.z-p.z))<=n;
export function glassSaveChecks(before:Save,after:Save,r:any,id:GlassCase){
 const b=glassSaveStock(before),a=glassSaveStock(after),p=planGlassSupply(b,1),refusal=id==='refusal',made=refusal?0:p.make;
 const expected={made,filled:refusal?0:p.fill,cooked:refusal?0:p.cook,seaweed:refusal?0:p.gatherSeaweed,buckets:refusal?0:p.gatherBucket,spent:0};
 const o=glassSupplyOptions({MAX_MAKE:'1',CAP:'4000',MAX_SPEND:'0',CASH_RESERVE:'1000',MEMBERS:'1'});
 return{
  entry:near(before,GLASS_BANK)&&before.skills[CRAFTING]!.level===51&&before.skills[3]!.level===39&&(before.vars[160]??0)===2
   &&(id!=='entry'||[1775,1783,1781,401,1925].every(item=>(b[item]??0)===0)),
  result:refusal?r?.ok===false&&String(r.failure).includes('glass supply refused: MEMBERS=1 required')
   :r?.ok===true&&r.conserved===true&&r.target===1&&r.banked===count(after,95,1775)&&Object.entries(expected).every(([k,v])=>r[k]===v),
  bank:refusal?near(after,GLASS_BANK)&&count(after,95,1775)===count(before,95,1775)
   :near(after,id==='owned'?GLASS_BANK:GLASS_RETURN_BANK)&&count(after,93,1775)===0&&count(after,95,1775)===(b[1775]??0)+made&&count(after,95,1775)>=1,
  assets:glassSupplyLedger(b,a,expected,o),
  // Native glass gives 200 raw tenths per craft, multiplied by the practice XP rate.
  skills:before.skills.every((s,i)=>after.skills[i]?.rawExperience-s.rawExperience===(i===CRAFTING?made*200*XP_RATE:0)),
  health:after.skills[3]!.level===39,
  quests:(after.vars[160]??0)===(before.vars[160]??0),
  bounds:Number.isSafeInteger(r?.ticks)&&r.ticks>=0&&r.ticks<4000,
 };
}
export function glassChildChecks(code:number,timedOut:boolean,log:string,id:GlassCase){return{
 exit:!timedOut&&(id==='refusal'?code!==0:code===0),
 logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
 resultLine:id==='refusal'?/^RESULT fail /m.test(log):/^RESULT ok /m.test(log),
};}
export function verifyGlass(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(glassProofSource()),configuration:meta.tickMs===PROOF_TICK_MS&&meta.xpRate===XP_RATE,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(glassCases)};
 const observed:Record<string,unknown>={};
 for(const id of glassCases){
  const dir=join(directory,id),c=meta.cases?.find((v:any)=>v.id===id),before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...glassSaveChecks(before,after,glassResult(log),id),...glassChildChecks(c?.code,c?.timedOut,log,id),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;observed[id]=glassResult(log);
 }
 const report={ok:Object.values(checks).every(Boolean),checks,observed,scope:'Native supply-mode CLI from Varrock bank at Crafting51/Hitpoints39 after Imp Catcher: free ordinary acquisition, banked glass, reuse, assets, buckets, refusal and logout. No live or unattended claim.',
  consumers:['run-glass-magicwanda-observatory-one','run-observatory-magicwanda-glass-consumer']};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 // delivery-cli holds the shared native turn across all workspaces. Do not take it twice.
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('shared native turn required: run through delivery');
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('glass practice startup headroom unavailable');
 mkdirSync(directory,{recursive:true});if(existsSync(join(directory,'native.json'))||glassCases.some(id=>existsSync(join(directory,id))))throw Error('glass proof directory already used; preserve snapshots');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'glass-supply-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=glassProofSource(),receipts=[];
  let base=0;for(let i=0;i<100;i++){const candidate=20000+Math.floor(Math.random()*20000);if([0,1,2,3].every(n=>canBind(candidate+n))){base=candidate;break;}}if(!base)throw Error('isolated practice endpoints unavailable');
  const ports={engine:base,gateway:base+1,management:base+2,tcp:base+3},instance='glass-'+randomUUID().replaceAll('-','').slice(0,20);
  const env={AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`};
  const previous=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  try{Object.assign(process.env,env);stack=await startStack({ports,instance,tickMs:PROOF_TICK_MS,xpRate:XP_RATE,readyTimeoutMs:60000});}
  finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
  for(const [index,id] of glassCases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('glass practice free memory floor');
   const dir=join(directory,id);mkdirSync(dir);const name=runBotName('gls',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('fresh practice identity required');const account=await createBot(name);
   const text=readFileSync(account.envPath,'utf8');if(!/^SERVER=localhost:8888\r?$/m.test(text))throw Error('local fixture required');
   writeFileSync(account.envPath,text.replace(/^SERVER=.*$/gm,`SERVER=127.0.0.1:${ports.engine}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=ws://127.0.0.1:${ports.gateway}`));
   const path=await applyPreset(name,glassProofPreset(id));copyFileSync(path,join(dir,'before.sav'));
   const child=Bun.spawn({...glassChildConfiguration(name,id,{...process.env,...env}),stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err'))});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},id==='refusal'?90000:660000);
   const code=await child.exited;clearTimeout(timer);await termination;
   const before=readPracticeSave(join(dir,'before.sav')),persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log'))});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:PROOF_TICK_MS,xpRate:XP_RATE,ports,instance,cases:receipts},null,2));
   if(!persisted.matched||timedOut||!Object.values(glassChildChecks(code,timedOut,readFileSync(join(dir,'worker.log'),'utf8'),id)).every(Boolean))throw Error('glass child failed; evidence retained');
  }return verifyGlass(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through glass-supply-order delivery');const dir=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyGlass(dir):await run(dir)).ok?0:1;}catch(e){console.error(String(e));process.exitCode=1;}}
