// Harness entry only. Import and --verify do not start services or log in.
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
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {xpForLevel,levelForXp} from '../../planner/src/curve';

type Save=ReturnType<typeof readPracticeSave>;
export type Child={code:number;timedOut:boolean};
const root=resolve(import.meta.dir,'../../..'),BONE=526,PRAYER=5;
export const ENTRY={x:3237,z:3296,level:0},BANK={x:3092,z:3243,level:0},TARGET=60,RESERVE=384;
export const NATIVE_ADMISSION_GB=Math.max(FREE_FLOOR_GB,PRACTICE_STARTUP_GB);
export const cases=['entry','short'] as const;
export type Kind=typeof cases[number];
export const NATIVE_DEADLINE_MS=900000;
const owned=['scripts/train-prayer.ts','scripts/train-prayer.test.ts','packages/practice/src/prayer-order-proof.ts','packages/practice/test/prayer-order-proof.test.ts'];
const pinned=['packages/core/src/bot.ts','packages/core/src/ticks.ts','packages/core/src/walk.ts','packages/planner/src/curve.ts',
 'scripts/measure/fleet-player-save.ts','vendor/rs-sdk/server/content/scripts/skill_prayer/scripts/bury_bone.rs2',
 'vendor/rs-sdk/server/content/scripts/skill_prayer/scripts/prayers/protectfrommelee.rs2',
 'vendor/rs-sdk/server/engine/src/network/game/server/codec/UpdateStatEncoder.ts'];
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
export const sources=()=>({runtime:workerSourceRevision(),files:Object.fromEntries([...owned,...pinned].map(p=>[p,hash(join(root,p))]))});
const names=['Attack','Defence','Strength','Hitpoints','Ranged','Prayer','Magic','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Stat18','Stat19','Runecraft'];
// Ordinary Bigchopper entry; no extra combat, access or movement unlocks.
export const ENTRY_SKILLS=[{level:65,xp:97200},{level:10,xp:1000},{level:11,xp:1200},{level:69,xp:128867},{level:81,xp:294100},
 {level:1,xp:0},{level:1,xp:0},{level:1,xp:0},{level:99,xp:11036250},{level:45,xp:24375},{level:20,xp:3250},
 {level:99,xp:999500},{level:51,xp:35150},{level:1,xp:0},{level:1,xp:0},{level:1,xp:0},{level:1,xp:0},{level:99,xp:19128687},
 {level:1,xp:0},{level:1,xp:0},{level:1,xp:0}];
export function prayerFixture(kind:Kind):SaveConfig{
 const bank=[{id:1511,count:15},{id:303,count:2},{id:1925,count:1},{id:1931,count:3},{id:1205,count:1},{id:882,count:28},
  {id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2},{id:52,count:35},{id:1349,count:1},
  {id:1351,count:1},{id:53,count:300},{id:1521,count:8951},{id:BONE,count:kind==='entry'?973:972},{id:2138,count:973},
  {id:1438,count:1},{id:995,count:454160},{id:1933,count:3},{id:1759,count:16},{id:315,count:1},{id:1895,count:2},
  {id:309,count:1},{id:314,count:5705},{id:1893,count:4},{id:590,count:1},{id:1515,count:2},{id:946,count:1},{id:553,count:1}];
 return{position:{...ENTRY},skills:Object.fromEntries(names.map((n,i)=>[n,ENTRY_SKILLS[i]!.level])),
  varps:{4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1,300:1000},bank,
  inventory:[{id:1277,count:1},{id:1985,count:1},{id:1985,count:1},{id:1985,count:1},{id:1171,count:1}],
  equipment:[{id:552,count:1,slot:2},{id:841,count:1,slot:3},{id:884,count:58,slot:13}]};
}
export function prayerProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^prayer-[a-z0-9-]{1,25}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof prayerProofEndpoints>;
export function selectPrayerProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return prayerProofEndpoints(ports,'prayer-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function prayerProofAccountEnv(text:string,p:ProofEndpoints){
 if(!/^SERVER=localhost:8888\r?$/m.test(text)||!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
 return text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`);
}
export async function startPrayerProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:PROOF_TICK_MS,xpRate:25,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function childConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env,endpoints?:ProofEndpoints){
 return{cmd:['bun','scripts/train-prayer.ts',name,String(TARGET)],cwd:root,windowsHide:true,
  env:{...inherited,...endpoints?.env,...(endpoints?{GATEWAY_URL:endpoints.gateway}:{}),DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'5000',MAX_BURY:'600',BONE_RESERVE:String(RESERVE),TARGET_LEVEL:String(TARGET)}};
}
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const ids=(a:Save,b:Save)=>new Set([...Object.values(a.inventories).flat(),...Object.values(b.inventories).flat()].map(i=>i.id));
const nearBank=(s:Save)=>s.position.level===0&&Math.max(Math.abs(s.position.x-BANK.x),Math.abs(s.position.z-BANK.z))<=2;
const records=(log:string,tag:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(tag+' ')).map(l=>{try{return JSON.parse(l.slice(tag.length+1));}catch{return null;}});
export const prayerResult=(log:string)=>{const r=records(log,'PRAYER_BANK');return r.length===1?r[0]:null;};
export function savedBurials(before:Save,after:Save){
 const raw=(after.skills[PRAYER]?.rawExperience??NaN)-(before.skills[PRAYER]?.rawExperience??NaN);
 return Number.isSafeInteger(raw)&&raw>=0&&raw%1125===0?raw/1125:NaN;
}
export function saveChecks(before:Save,after:Save,kind:Kind):Record<string,boolean>{
 const buried=savedBurials(before,after),demand=Math.ceil(xpForLevel(TARGET)/112.5);
 return{
  xp:kind==='entry'?buried===demand&&after.skills[PRAYER]!.xp===Math.floor(demand*112.5)
    &&levelForXp(after.skills[PRAYER]!.xp)>=TARGET&&after.skills[PRAYER]!.level>=TARGET:buried===0,
  bones:total(before,BONE)-total(after,BONE)===buried&&(kind==='short'||total(after,BONE)>=RESERVE),
  bank:(after.inventories[93]??[]).every(i=>i.id!==BONE)&&(after.inventories[95]??[]).filter(i=>i.id===BONE).reduce((n,i)=>n+i.count,0)===total(after,BONE),
  assets:[...ids(before,after)].every(id=>id===BONE||total(before,id)===total(after,id)),
  equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  skills:before.skills.every((s,i)=>i===PRAYER||after.skills[i]?.rawExperience===s.rawExperience),
  alive:after.skills[3]!.level>=before.skills[3]!.level&&after.skills[3]!.level>0,
  position:nearBank(after),savedLogout:(after.vars[134]??0)>(before.vars[134]??0),
 };
}
export function childChecks(child:Child,log:string,kind:Kind):Record<string,boolean>{
 const r=prayerResult(log),e=records(log,'PRAYER_ENTRY'),demand=Math.ceil(xpForLevel(TARGET)/112.5);
 return{
  exit:!child.timedOut&&(kind==='entry'?child.code===0:Number.isInteger(child.code)&&child.code!==0),
  logout:(log.match(/^LOGOUT logged-out\r?$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  entry:e.length===1&&JSON.stringify(e[0]?.position)===JSON.stringify(ENTRY)&&e[0]?.xp===0&&e[0]?.hp===69
    &&e[0]?.target===TARGET&&e[0]?.cap===5000&&e[0]?.maximum===600&&e[0]?.reserve===RESERVE,
  result:kind==='entry'?r?.ok===true&&r.targetMet===true&&r.target===TARGET&&r.buried===demand&&r.consumed===demand&&r.attempts===demand
    &&r.boneBank===384&&r.heldBones===0&&r.finalXp===Math.floor(demand*112.5)&&r.finalLevel===TARGET&&r.rateVerified===true
    &&r.firstBoneXp===112&&r.toggledOn===true&&r.toggledOff===true&&r.prayerPointsOn>0&&r.preserved===true&&r.equipmentPreserved===true
    &&r.hpMin===69&&r.died===false&&r.stop==='target-level'&&r.ticks<=5000&&/^RESULT ok /m.test(log)
   :r?.ok===false&&r.buried===0&&r.consumed===0&&r.attempts===0&&r.boneBank===972&&r.preserved===true&&r.toggledOn===false&&r.toggledOff===true
    &&r.died===false&&r.hpMin===69&&/^no prayer progress: insufficient owned bones: need 589, available 588$/.test(r.failure)&&/^RESULT fail /m.test(log),
 };
}
function fixtureChecks(before:Save,kind:Kind){
 const f=prayerFixture(kind),wanted=[...(f.bank??[]),...(f.inventory??[]),...(f.equipment??[])];
 return JSON.stringify(before.position)===JSON.stringify(ENTRY)&&before.skills.every((s,i)=>s.rawExperience===ENTRY_SKILLS[i]!.xp*10&&s.level===ENTRY_SKILLS[i]!.level)
  &&[...new Set([...Object.values(before.inventories).flat().map(i=>i.id),...wanted.map(i=>i.id)])].every(id=>total(before,id)===wanted.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0));
}
export function verifyPrayer(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const endpoints=prayerProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(sources()),configuration:meta.tickMs===PROOF_TICK_MS&&meta.xpRate===25,
  endpoints:meta.server===endpoints.server,
  fresh:Number.isFinite(meta.at)&&meta.at>=meta.startedAt&&meta.at<=Date.now()&&Date.now()-meta.at<NATIVE_DEADLINE_MS,
  cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 for(const id of cases){
  try{const d=join(directory,id),c=meta.cases.find((c:any)=>c.id===id),before=readPracticeSave(join(d,'before.sav')),after=readPracticeSave(join(d,'after.sav')),log=readFileSync(join(d,'worker.log'),'utf8');
   const local={...saveChecks(before,after,id),...childChecks(c,log,id),fixture:fixtureChecks(before,id),persisted:c.persisted===true,
    beforeHash:c.before===hash(join(d,'before.sav')),afterHash:c.after===hash(join(d,'after.sav')),logHash:c.log===hash(join(d,'worker.log'))};
   for(const [key,value] of Object.entries(local))checks[`${id}:${key}`]=value;
  }catch(e){checks[`${id}:readable`]=false;console.error(String(e));}
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'Native actual worker CLI on ordinary generated Bigchopper entry, 150ms/25x only. Live recovery, live access, speed and unattended readiness remain unproved.',
  nextConsumer:'qualify-recovery-bigchopper-prayer-entry then run-prayer-bigchopper-owned60; stronger-target Ranged follows protection access. Controller owns live execution; independent review remains required.'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 const started=Date.now(),deadline=started+NATIVE_DEADLINE_MS-30000;
 if(freemem()/2**30<NATIVE_ADMISSION_GB)throw Error(`insufficient practice memory: need ${NATIVE_ADMISSION_GB} GiB free`);
 mkdirSync(directory,{recursive:true});
 if(existsSync(join(directory,'native.json'))||cases.some(k=>existsSync(join(directory,k))))throw Error('prayer proof directory already used; preserve before snapshots');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'prayer-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const source=sources(),receipts:any[]=[],endpoints=selectPrayerProofEndpoints();
  stack=await startPrayerProofStack(endpoints);
  for(const [index,id] of cases.entries()){
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice free-memory floor');
   const dir=join(directory,id);mkdirSync(dir);
   const name=runBotName('flpray',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('isolated practice identity already exists');
   const account=await createBot(name);
   writeFileSync(account.envPath,prayerProofAccountEnv(readFileSync(account.envPath,'utf8'),endpoints));
   const path=await applyPreset(name,prayerFixture(id));setPracticeSkills(path,ENTRY_SKILLS);
   copyFileSync(path,join(dir,'before.sav'));
   const before=readPracticeSave(join(dir,'before.sav')),log=join(dir,'worker.log');
   const limit=Math.min(id==='entry'?780000:60000,deadline-Date.now()-15000);
   if(limit<30000)throw Error('practice envelope exhausted');
   if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('practice identity stop file');
   const child=Bun.spawn({...childConfiguration(name,process.env,endpoints),stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err'))});
   let timedOut=false,termination:Promise<void>|undefined;
   const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid);},limit);
   const code=await child.exited;clearTimeout(timer);await termination;
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   const after=readPracticeSave(join(dir,'after.sav')),text=readFileSync(log,'utf8');
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({startedAt:started,at:Date.now(),source,tickMs:PROOF_TICK_MS,xpRate:25,
    server:endpoints.server,endpoints:{ports:endpoints.ports,instance:endpoints.instance},cases:receipts},null,2));
   const checks={...saveChecks(before,after,id),...childChecks({code,timedOut},text,id),fixture:fixtureChecks(before,id),persisted:persisted.matched};
   if(Object.values(checks).some(v=>!v))throw Error(`${id}: failed ${Object.entries(checks).filter(([,v])=>!v).map(([k])=>k).join(',')}; raw evidence retained`);
  }
  return verifyPrayer(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the prayer-order harness');const directory=resolve(process.env.DELIVERY_DIR);
 process.exitCode=(process.argv[2]==='--verify'?verifyPrayer(directory):await run(directory)).ok?0:1;}catch(e){console.error(String(e));process.exitCode=1;}}
