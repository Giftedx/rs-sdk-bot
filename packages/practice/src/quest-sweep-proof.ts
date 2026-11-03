// Harness only: real quest-sweep CLI, then saved quest flags, asset deltas and confirmed logout.
import {openSync,writeFileSync,rmSync,closeSync,mkdirSync,readFileSync,copyFileSync,existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {freemem} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startStack,type StackOptions} from './stack';
import {canBind} from './ports';
import {rsSdkRoot} from './paths';
import {applyPreset} from './presets';
import {createBot} from './bots';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {PRACTICE_STARTUP_GB,FREE_FLOOR_GB} from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
type CaseRecord={id:string;exit:number;timedOut:boolean;saveMatched:boolean;seconds:number};
const root=resolve(import.meta.dir,'../../..');
export function questSweepProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^quest-sweep-[a-z0-9]{20}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
type ProofEndpoints=ReturnType<typeof questSweepProofEndpoints>;
export function selectQuestSweepProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return questSweepProofEndpoints(ports,'quest-sweep-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function questSweepProofAccountEnv(text:string,p:ProofEndpoints){
 if(!/^SERVER=localhost(?::8888)?\r?$/m.test(text)||/^GATEWAY_URL=/m.test(text)&&!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/m.test(text))throw Error('new practice account required');
 const server=text.replace(/^SERVER=[^\r\n]*/gm,`SERVER=${p.server}`);
 return /^GATEWAY_URL=/m.test(server)?server.replace(/^GATEWAY_URL=[^\r\n]*/gm,`GATEWAY_URL=${p.gateway}`):server.trimEnd()+`\nGATEWAY_URL=${p.gateway}\n`;
}
export async function startQuestSweepProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs:150,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function questSweepChildConfiguration(name:string,quest:string,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun','scripts/quest-sweep.ts',name,quest],cwd:root,windowsHide:true,
  env:{...inherited,...p.env,GATEWAY_URL:p.gateway,QUEST_SWEEP_OBSERVE_BANK:'',RANDOM_EVENTS:'0'}};
}
const lines=(log:string,prefix:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(prefix+' ')).map(l=>JSON.parse(l.slice(prefix.length+1)));
const total=(s:Save,id:number)=>[93,95].reduce((n,t)=>n+(s.inventories[t]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
// The server writes an empty worn row (94) on first logout; an empty row and an absent row hold the same items.
export const equipment=(s:Pick<Save,'inventories'>)=>JSON.stringify(Object.entries(s.inventories)
 .filter(([k,rows])=>!['93','95'].includes(k)&&(rows??[]).length).sort(([a],[b])=>Number(a)-Number(b))
 .map(([k,rows])=>[k,[...rows!].sort((a,b)=>a.slot-b.slot).map(i=>[i.slot,i.id,i.count])]));
const sameAssets=(a:Save,b:Save,cost:Record<number,number>)=>{
 const ids=new Set([a,b].flatMap(s=>[93,95].flatMap(t=>(s.inventories[t]??[]).map(i=>i.id))));
 return [...ids].every(id=>total(b,id)===total(a,id)+(cost[id]??0))&&equipment(a)===equipment(b);
};

export function questSweepChecks(id:string,before:Save,after:Save,log:string,record:CaseRecord){
 const success=id==='bank-stage',ghost=id==='retained-ghost'||id==='banked-ghost',banked=id==='banked-ghost',boats=lines(log,'QUEST_SWEEP_BOAT');
 const checks={
  child:!record.timedOut&&record.exit===(success||ghost?0:1),
  saved:record.saveMatched,
  oneLogin:(log.match(/^START /gm)??[]).length===1,
  logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(?:logout|session close)/m.test(log),
  alive:after.skills[3]!.level>0&&!/\bdied=true\b|^RESULT fail .*died/m.test(log),
  entryHp:before.skills[3]!.level===(ghost?26:10),
  assets:sameAssets(before,after,ghost?{553:-1}:success?{1759:-20,995:0}:{}),
  unrelatedXp:before.skills.every((s,i)=>success&&i===12||ghost&&i===5||s.rawExperience===after.skills[i]!.rawExperience),
 };
 if(ghost)return{...checks,
  entry:before.position.x===(banked?3094:3113)&&before.position.z===(banked?3491:9555)&&before.position.level===0&&before.vars[107]===4&&total(before,553)===1&&(before.inventories[94]??[]).some(i=>i.id===552)&&before.skills[6]!.level===1&&total(before,563)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  retained:lines(log,'QUEST_SWEEP_RETAINED_SKULL').length===1&&lines(log,'GHOST_RETAINED_SKULL').length===1&&!/^MILESTONE [1-4](?:\s|$)/m.test(log),
  bankedSkull:!banked||(before.inventories[95]??[]).some(i=>i.id===553&&i.count===1)&&lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===553&&r.count===1&&r.before===0&&r.after===1&&r.bankBefore===1&&r.bankAfter===0&&r.observed),
  quest:after.vars[107]===5&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='The Restless Ghost'&&q.state==='complete'),
  reward:after.skills[5]!.rawExperience===before.skills[5]!.rawExperience+281250,
  skull:total(after,553)===0,
  amulet:(after.inventories[94]??[]).some(i=>i.id===552),
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3249),Math.abs(after.position.z-3192))<=6,
 };
 if(success)return{...checks,
  entry:before.position.x===2459&&before.position.z===3385&&before.position.level===0&&total(before,1759)===20&&(before.vars[179]??0)===0,
  result:/^RESULT ok(?: |$)/m.test(log),
  gate:lines(log,'QUEST_SWEEP_GATE').some(r=>r.ok&&r.at.x===2461&&r.at.z===3382&&r.at.level===0),
  withdrawn:lines(log,'QUEST_SWEEP_WITHDRAW').some(r=>r.id===1759&&r.count===20&&r.before===0&&r.after===20&&r.bankBefore===20&&r.bankAfter===0&&r.observed),
  boats:boats.length===2&&boats[0].id==='npc:captain_barnaby:brimhaven@2679,3275'&&boats[1].id==='npc:customs_officer:port-sarim@2953,3147'&&boats.every(r=>r.coins===30),
  // sheep_complete debits the last of 20 wool, gives 60 coins and one QP. Two boat fares cost 60 coins.
  quest:after.vars[179]===22&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  questList:lines(log,'QUEST_SWEEP_FLAG').some(q=>q.name==='Sheep Shearer'&&q.state==='complete'),
  wool:total(after,1759)===total(before,1759)-20,
  reward:after.skills[12]!.xp===before.skills[12]!.xp+3750,
  location:after.position.level===0&&Math.max(Math.abs(after.position.x-3189),Math.abs(after.position.z-3273))<=6,
 };
 return{...checks,
  result:/^RESULT fail quest-sweep doric missing 434:6,436:4,440:2\s*$/m.test(log),
  noQuestTravel:!/^MILESTONE quest-sweep /m.test(log)&&boats.length===0,
  questUnchanged:(after.vars[31]??0)===(before.vars[31]??0)&&(after.vars[101]??0)===(before.vars[101]??0),
  atBank:after.position.level===0&&Math.max(Math.abs(after.position.x-2947),Math.abs(after.position.z-3368))<=3,
 };
}

function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8')) as {source:string;cases:CaseRecord[];endpoints:ProofEndpoints};
 const endpoints=questSweepProofEndpoints(meta.endpoints?.ports,meta.endpoints?.instance??'');
 if(meta.endpoints.server!==endpoints.server||meta.endpoints.gateway!==endpoints.gateway)throw Error('retained practice endpoints mismatch');
 const results=['bank-stage','missing','retained-ghost','banked-ghost'].map(id=>{
  const record=meta.cases.find(c=>c.id===id);
  if(!record)throw Error(`missing retained case ${id}`);
  const checks=questSweepChecks(id,readPracticeSave(join(dir,id+'-before.sav')),readPracticeSave(join(dir,id+'-after.sav')),readFileSync(join(dir,id+'.log'),'utf8'),record);
  return{...record,ok:Object.values(checks).every(Boolean),checks};
 });
 const source=meta.source===workerSourceRevision();
 const report={ok:source&&results.every(r=>r.ok),source,results,scope:'Native practice at150ms/25xXP: existing HP10 Gnome Sheep Shearer/two boat fares, missing-item refusal, and HP26/Magic1 Ghost completion from held-cellar and banked-surface skull entries with no law rune. Exact quest rewards/assets and logout. No live or unattended claim.'};
 writeFileSync(join(dir,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}

async function run(dir:string){
 if(!process.env.DELIVERY_DIR||!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('native turn required: run through delivery');
 // Host memory waits occur before gameplay. Delivery holds the native turn through the saved consumer.
 const deadline=Date.now()+180000;
 while(freemem()/2**30<PRACTICE_STARTUP_GB){
  console.log(`QUEST_SWEEP_MEMORY freeGiB=${(freemem()/2**30).toFixed(2)} startupGiB=${PRACTICE_STARTUP_GB} floorGiB=${FREE_FLOOR_GB}`);
  if(Date.now()>=deadline)throw Error('practice startup headroom deadline');
  await Bun.sleep(1000);
 }
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,directory:dir,task:'quest-sweep'}));closeSync(fd);
 mkdirSync(dir,{recursive:true});
 const cases:CaseRecord[]=[],source=workerSourceRevision();
 let endpoints:ProofEndpoints|undefined;
 const retain=()=>writeFileSync(join(dir,'native.json'),JSON.stringify({source,tickMs:150,xpRate:25,endpoints,cases},null,2));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  endpoints=selectQuestSweepProofEndpoints();
  stack=await startQuestSweepProofStack(endpoints);
  for(const c of [{id:'bank-stage',quest:'sheep',bank:[{id:1759,count:20}]},{id:'missing',quest:'doric',bank:[]},...['retained-ghost','banked-ghost'].map(id=>({id,quest:'priest',bank:[{id:995,count:1127309},{id:1436,count:243},{id:1446,count:1},...(id==='banked-ghost'?[{id:553,count:1}]:[])]}))]){
   const name=runBotName('qsw',cases.length);
   if(existsSync(join(rsSdkRoot(),'bots',name)))throw Error('fresh quest-sweep practice account required');
   const {envPath}=await createBot(name);
   writeFileSync(envPath,questSweepProofAccountEnv(readFileSync(envPath,'utf8'),endpoints));
   const ghost=c.quest==='priest',banked=c.id==='banked-ghost';
   const save=await applyPreset(name,ghost?{position:banked?{x:3094,z:3491,level:0}:{x:3113,z:9555,level:0},skills:{Hitpoints:26,Attack:37,Magic:1,Prayer:1},varps:{107:4},equipment:[{id:552,count:1,slot:2}],bank:c.bank,inventory:[...(!banked?[{id:553,count:1}]:[]),{id:556,count:3},{id:557,count:1}]}:{position:c.id==='bank-stage'?{x:2459,z:3385,level:0}:{x:2965,z:3380,level:0},skills:{Hitpoints:10},bank:c.bank,inventory:[{id:995,count:362},{id:1351,count:1}]});
   const before=join(dir,c.id+'-before.sav');
   if(existsSync(before))throw Error(`preserve before snapshot: ${before}`);
   copyFileSync(save,before);
   if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice free memory below floor');
   const stamp=statSync(save).mtimeMs,t=Date.now();
   const record:CaseRecord={id:c.id,exit:-1,timedOut:false,saveMatched:false,seconds:0};cases.push(record);retain();
   const p=Bun.spawn({...questSweepChildConfiguration(name,c.quest,endpoints),stdout:'pipe',stderr:'pipe'});
   let termination:Promise<void>|undefined;
   const kill=setTimeout(()=>{record.timedOut=true;termination=killTree(p.pid);},300000);
   try{
    const [out,err]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()]);
    record.exit=await p.exited;clearTimeout(kill);await termination;
    writeFileSync(join(dir,c.id+'.log'),out+'\n--stderr--\n'+err);
    const saved=await waitPracticeSave(save,s=>statSync(save).mtimeMs>stamp&&(c.id==='missing'||(ghost?s.vars[107]===5:s.vars[179]===22)),{timeoutMs:6000});
    record.saveMatched=saved.matched;
   }finally{
    clearTimeout(kill);copyFileSync(save,join(dir,c.id+'-after.sav'));record.seconds=Math.round((Date.now()-t)/1000);retain();
   }
  }
  return verify(dir);
 }finally{try{await stack?.stop();}finally{rmSync(lock,{force:true});retain();}}
}

if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('run through delivery');
  const dir=resolve(process.env.DELIVERY_DIR);
  process.exitCode=(process.argv.includes('--verify')?verify(dir):await run(dir)).ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
