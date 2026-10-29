// Harness entry only. Import and --verify never start services or log in.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/smelt-bars.ts','scripts/smelt-bars.test.ts','scripts/smelt-batch.ts','scripts/smelt-batch.test.ts','packages/planner/src/travel.ts','packages/practice/src/iron-progress-order-proof.ts','packages/practice/test/iron-progress-order-proof.test.ts'];
const serverFiles=['vendor/rs-sdk/server/content/scripts/skill_smithing/scripts/smelting/smelting.rs2','vendor/rs-sdk/server/content/scripts/skill_smithing/configs/smelting/smelting.struct','vendor/rs-sdk/server/content/scripts/areas/area_alkharid/scripts/border_gate.rs2'];
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
  xp:result?.xpGain===(after.skills[13]!.rawExperience-before.skills[13]!.rawExperience)/10&&(made>0?after.skills[13]!.rawExperience>before.skills[13]!.rawExperience:after.skills[13]!.rawExperience===before.skills[13]!.rawExperience),
  coins:spent===(kind==='entry'?10:0)&&spent===result?.coinsSpent,
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
const cases=['entry','limited','interrupted'] as const;
export function verifyIron(directory:string){
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases)};
 for(const id of cases){
  const dir=join(directory,id),c=meta.cases?.find((v:any)=>v.id===id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...ironSaveChecks(before,after,ironResult(log),id),...ironChildChecks(c?.code,c?.timedOut,log,id),
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,scope:'Native installed iron CLI only; no live release, unattended or speed claim.',nextConsumer:'Smithing progression or measured iron-tip/ammo conversion on owned stock'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('insufficient practice startup reserve');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('iron proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'iron-progress-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts=[];
  stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [index,id] of cases.entries()){
   const dir=join(directory,id);mkdirSync(dir);
   const name=runBotName('knobiron',index+1),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(botDir))throw Error('isolated practice identity already exists');
   await createBot(name);
   if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
   const preset:SaveConfig={position:id==='entry'?{x:3252,z:3420,level:0}:{x:3269,z:3167,level:0},skills:{Mining:99,Smithing:31,Hitpoints:16},
    inventory:[{id:1265,count:1},{id:315,count:2}],bank:[{id:440,count:id==='limited'?2:684},{id:995,count:24},{id:436,count:7},{id:438,count:9},{id:2349,count:3}]};
   const path=await applyPreset(name,preset);copyFileSync(path,join(dir,'before.sav'));
   const child=Bun.spawn(['bun','scripts/smelt-bars.ts',name,id==='interrupted'?'1':'2500','iron'],{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',MAX_MAKE:'6',ORE_RESERVE:'1',ORDER_MODE:'exact'},stdout:Bun.file(join(dir,'worker.log')),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},240000);
   const code=await child.exited;clearTimeout(timer);await termination;
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(join(dir,'worker.log'))});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,cases:receipts},null,2));
   // Preserve the failed case; do not proceed with a still-owned account.
   if(!persisted.matched||timedOut)throw Error('iron child logout/save deadline; evidence retained');
  }
  return verifyIron(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the iron-progress-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyIron(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
