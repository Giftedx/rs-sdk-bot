// Harness entry. Creates only fresh local fixtures and invokes the real worker CLI.
import {existsSync,readFileSync,writeFileSync,copyFileSync,openSync,closeSync,rmSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {freemem} from 'node:os';
import {createHash} from 'node:crypto';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../../core/src/memory';
import {workerSourceRevision} from '../../core/src/worker-release';
import {createBot} from './bots';
import {applyPreset} from './presets';
import {runBotName} from './prove';
import {rsSdkRoot} from './paths';
import {killTree} from './proc';
import {selectQuestSweepProofEndpoints,questSweepProofAccountEnv,startQuestSweepProofStack} from './quest-sweep-proof';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {reconcile} from '../../../scripts/brew-potions';
const root=resolve(import.meta.dir,'../../..');
type Save=ReturnType<typeof readPracticeSave>;
const stock=(s:Save)=>[93,95].flatMap(k=>s.inventories[k]??[]).reduce<Record<number,number>>((a,i)=>{a[i.id]=(a[i.id]??0)+i.count;return a;},{});
const entries=(log:string,key:string)=>log.split(/\r?\n/).filter(l=>l.startsWith(key+' ')).map(l=>{try{return JSON.parse(l.slice(key.length+1));}catch{return null;}});
export function herbloreSavedChecks(id:string,before:Save,after:Save,log:string,exit:number){
 const success=id==='vial-shortfall',result=entries(log,'HERBLORE_RESULT').at(-1),buys=entries(log,'HERBLORE_BUY'),travel=entries(log,'HERBLORE_TRAVEL');
 const a=stock(before),b=stock(after),made=(b[121]??0)-(a[121]??0),vials=buys.filter(x=>x?.id===227).reduce((n,x)=>n+x.count,0),eyes=buys.filter(x=>x?.id===221).reduce((n,x)=>n+x.count,0);
 const cost=buys.reduce((n,x)=>n+(x?.cost??NaN),0);
 const fares=travel.reduce((n,x)=>n+(x?.coins??NaN),0);
 const delta:Record<number,number>=success?{199:-made,121:made,227:vials-made,221:eyes-made,995:-cost+fares}:{};
 return {
  child:exit===(success?0:1),logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(?:logout|session close)/m.test(log),
  result:success?result?.ok===true&&result?.assets===true&&result?.target===50:/^RESULT fail herblore Error: (?:herbs missing|vial budget)/m.test(log),
  xp:success?after.skills[15]!.rawExperience>before.skills[15]!.rawExperience&&after.skills[15]!.level>=50:after.skills[15]!.rawExperience===before.skills[15]!.rawExperience,
  assets:travel.every(x=>x&&Number.isSafeInteger(x.coins)&&x.coins<=0)&&reconcile(a,b,delta),equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  banked:!success||(after.inventories[95]??[]).some(x=>x.id===121&&x.count>=made)&&!(after.inventories[93]??[]).some(x=>x.id===121),
  entry:before.skills[15]!.level===46&&(a[227]??0)===0&&(a[199]??0)===(id==='missing-herbs'?0:60),
  purchase:!success||vials>0&&vials<=60&&eyes>0&&eyes<=60&&buys.every(x=>x&&[227,221].includes(x.id)&&x.count===1&&Number.isSafeInteger(x.cost)&&x.cost>=0)
   &&buys.filter(x=>x?.id===227).reduce((n,x)=>n+x.cost,0)<=1000&&buys.filter(x=>x?.id===221).reduce((n,x)=>n+x.cost,0)<=1000,
  useful:!success||made>0&&made<=60&&result?.brewed===made,
  otherXp:before.skills.every((s,i)=>i===15||s.rawExperience===after.skills[i]!.rawExperience),
  alive:after.skills[3]!.level>0,
 };
}
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'herblore-native.json'),'utf8'));
 const cases=['vial-shortfall','missing-herbs','vial-budget'].map(id=>{
  const record=meta.cases.find((c:any)=>c.id===id);if(!record)throw Error(`missing case ${id}`);
  const checks=herbloreSavedChecks(id,readPracticeSave(join(dir,id+'-before.sav')),readPracticeSave(join(dir,id+'-after.sav')),readFileSync(join(dir,id+'.log'),'utf8'),record.exit);
  return {id,ok:record.saved&&!record.timedOut&&Object.values(checks).every(Boolean),checks};
 });
 const source=meta.source===workerSourceRevision(),artifacts=Object.entries(meta.hashes as Record<string,string>).every(([p,h])=>hash(join(dir,p))===h);
 const report={ok:source&&artifacts&&cases.every(c=>c.ok),source,artifacts,cases,scope:'Practice 150ms/25x only. Real CLI at Herblore46, owned banked Herb199, no water vials or eyes. Target50, bought shortfalls, Attack potions banked, exact assets, refusal and logout. Live consumer run-herblore-mightyrod-band50 remains harness-owned.'};
 writeFileSync(join(dir,'herblore-saved.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
export function herbloreHeadroom(gib:number){return gib>=PRACTICE_STARTUP_GB?null:{status:'hostDeferred',freeGiB:gib,requiredGiB:PRACTICE_STARTUP_GB,floorGiB:FREE_FLOOR_GB};}
async function run(dir:string){
 if(!existsSync(join(root,'.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 const deferred=herbloreHeadroom(freemem()/2**30);if(deferred){console.log(JSON.stringify(deferred));return {ok:false,...deferred};}
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,task:'herblore-order',directory:dir}));closeSync(fd);
 let stack:Awaited<ReturnType<typeof startQuestSweepProofStack>>|undefined;
 const cases:{id:string;exit:number;timedOut:boolean;saved:boolean}[]=[],source=workerSourceRevision();
 const hashes:Record<string,string>={};
 const retain=()=>writeFileSync(join(dir,'herblore-native.json'),JSON.stringify({source,cases,hashes},null,2));
 try{
  const endpoints=selectQuestSweepProofEndpoints();stack=await startQuestSweepProofStack(endpoints);
  for(const id of ['vial-shortfall','missing-herbs','vial-budget']){
   if(freemem()/2**30<FREE_FLOOR_GB){console.log(JSON.stringify({status:'hostDeferred',floorGiB:FREE_FLOOR_GB}));throw Error('hostDeferred: memory floor');}
   const before=join(dir,id+'-before.sav');if(existsSync(before))throw Error(`preserve before snapshot ${before}`);
   const name=runBotName('herb',cases.length);
   if(existsSync(join(rsSdkRoot(),'bots',name))||existsSync(join(rsSdkRoot(),'server/engine/data/players/main',name.toLowerCase()+'.sav')))throw Error('fresh practice account required');
   const {envPath}=await createBot(name);writeFileSync(envPath,questSweepProofAccountEnv(readFileSync(envPath,'utf8'),endpoints));
   const save=await applyPreset(name,{position:{x:3092,z:3243,level:0},skills:{Herblore:46,Hitpoints:50},bank:[{id:995,count:2000},{id:952,count:1},...(id==='missing-herbs'?[]:[{id:199,count:60}])]});
   copyFileSync(save,before);const stamp=statSync(save).mtimeMs;
   const record={id,exit:-1,timedOut:false,saved:false};cases.push(record);retain();
   const child=Bun.spawn(['bun','scripts/brew-potions.ts',name,'6000'],{cwd:root,windowsHide:true,env:{...process.env,...endpoints.env,GATEWAY_URL:endpoints.gateway,DEMO_OK:'',TARGET_LEVEL:'50',RECIPE:'auto',VIAL_BUDGET:id==='vial-budget'?'0':'1000',SECONDARY_BUDGET:'1000',RANDOM_EVENTS:'0'},stdout:'pipe',stderr:'pipe'});
   let termination:Promise<void>|undefined;const timer=setTimeout(()=>{record.timedOut=true;termination=killTree(child.pid);},750000);
   try{
    const [out,err]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);record.exit=await child.exited;
    writeFileSync(join(dir,id+'.log'),out+'\n'+err);
    const saved=await waitPracticeSave(save,()=>statSync(save).mtimeMs>stamp,{timeoutMs:10000});record.saved=saved.matched;
   }finally{clearTimeout(timer);await termination;copyFileSync(save,join(dir,id+'-after.sav'));
    for(const file of [id+'-before.sav',id+'-after.sav',id+'.log'])if(existsSync(join(dir,file)))hashes[file]=hash(join(dir,file));retain();}
  }
  return verify(dir);
 }finally{try{await stack?.stop();}finally{rmSync(lock,{force:true});retain();}}
}
if(import.meta.main){
 try{if(!process.env.DELIVERY_DIR)throw Error('run through delivery');const dir=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv.includes('--verify')?verify(dir):await run(dir)).ok?0:1;}
 catch(e){console.error(String(e));process.exitCode=1;}
}
