// Harness entry only. Import and --verify never start services or log in.
import {copyFileSync,readFileSync,writeFileSync,mkdirSync,existsSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {applyPreset,type SaveConfig} from './presets';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,setPracticeSkills,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {verifyCompletedRecoveryDelivery} from './session-recovery-proof';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';

type Save=ReturnType<typeof readPracticeSave>;
type Kind=typeof cases[number];
const root=resolve(import.meta.dir,'../../..');
const owned=['scripts/gather-combat.ts','scripts/gather-combat.test.ts','scripts/quest-sustain.ts','scripts/quest-sustain.test.ts','packages/practice/src/cow-progress-order-proof.ts','packages/practice/test/cow-progress-order-proof.test.ts'];
const source=()=>({runtime:workerSourceRevision(),files:Object.fromEntries(owned.map(p=>[p,createHash('sha256').update(readFileSync(join(root,p))).digest('hex')]))});
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const DROPS=[1739,526,2132],TROUT=333,SWORD=1277,SHIELD=1171;
const BANK={x:2654,z:3283};
// Swordinhand status 2026-10-26: Attack9/900, Defence20/3200, Strength20/3300, HP19/20 (3385XP) at Ardougne south bank.
export const SWORDINHAND={position:{x:2655,z:3283,level:0},
 skills:[{level:9,xp:900},{level:20,xp:3200},{level:20,xp:3300},{level:19,xp:3385},...Array.from({length:17},()=>({level:1,xp:0}))],
 inventory:[{id:995,count:140},{id:TROUT,count:1},{id:315,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:2309,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:TROUT,count:1},{id:SWORD,count:1},{id:SHIELD,count:1}],
 equipment:[{id:SWORD,count:1,slot:3},{id:SHIELD,count:1,slot:5}],
 bank:[{id:995,count:25},{id:1351,count:1},{id:590,count:1},{id:303,count:1},{id:1925,count:1},{id:1931,count:1},{id:1265,count:1},{id:1205,count:1},{id:841,count:1},{id:882,count:25},{id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2},{id:1739,count:8},{id:526,count:8},{id:2132,count:8}]};
export const cases=['nofood','nokit','entry','stopped','partial','restarted'] as const;
// The native fixture follows the finite south-bank consumer, regardless of the parent profile.
export function cowChildConfiguration(name:string,inherited:NodeJS.ProcessEnv=process.env,kind:Kind='entry'){
 return {cmd:['bun','scripts/gather-combat.ts',name,'1500','cow'],cwd:root,
  env:{...inherited,DEMO_OK:'',RANDOM_EVENTS:'0',TARGET:'cow',MAX_KILLS:kind==='partial'?'1':'5',TRAIN_SKILL:'Attack',TARGET_LEVEL:'20',COW_BANK_PROFILE:'south',COW_FOOD_MODE:'held'},windowsHide:true};
}
// Source decision: session-recovery-proof.ts releaseStopArtifact -> cow CLI proof
// -> reuse mutation-free retention. Path-based compare/rename/delete has a race.
// Retire stop-test identities permanently; prove resume on an unstopped identity.
// Acceptance: replacement/access-failure tests make zero retention filesystem calls.
export type CowStop={path:string;marker:string;ino:bigint;dev:bigint};
export function claimCowStop(path:string,marker:string):CowStop{
 try{writeFileSync(path,marker,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('stop path already exists');throw error;}
 const info=statSync(path,{bigint:true});return {path,marker,ino:info.ino,dev:info.dev};
}
export function retainCowStop(stop:CowStop,_evidence?:string){
 return stop.path;
}
const refusal:Partial<Record<Kind,RegExp>>={nofood:/^RESULT fail .*cow prerequisite: stage2unnoted Trout/m,nokit:/^RESULT fail .*cow prerequisite: missing kit1277/m};
export function cowFixture(kind:Kind):SaveConfig{
 const inventory=SWORDINHAND.inventory.filter((i,n)=>kind==='nofood'?i.id!==TROUT||n===1:kind==='nokit'?i.id!==SWORD:true);
 return {position:SWORDINHAND.position,skills:{Attack:9,Defence:20,Strength:20,Hitpoints:20},inventory,
  equipment:SWORDINHAND.equipment.filter(i=>kind!=='nokit'||i.id!==SWORD),bank:SWORDINHAND.bank};
}
const count=(s:Save,container:number,id:number)=>(s.inventories[container]??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const total=(s:Save,id:number)=>Object.values(s.inventories).flat().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function cowResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('COW_RESULT ')).at(-1)?.slice(11)??'null');}catch{return null;}}
// Dated source entry. The restarted case starts from the unstopped partial save.
export function cowEntry(before:Save,kind:Kind){
 const p=before.position,expectedTrout=kind==='nofood'?1:6;
 return p.level===0&&p.x===2655&&p.z===3283&&SWORDINHAND.skills.every((v,i)=>before.skills[i]?.level===v.level&&before.skills[i]?.xp===v.xp)
  &&total(before,TROUT)===expectedTrout&&count(before,93,TROUT)===expectedTrout&&count(before,95,TROUT)===0
  &&total(before,SWORD)===(kind==='nokit'?0:2)&&total(before,SHIELD)===2&&total(before,995)===165&&DROPS.every(id=>count(before,95,id)===8&&count(before,93,id)===0);
}
export function cowSaveChecks(before:Save,after:Save,result:any,kind:Kind){
 const p=after.position,ids=new Set([...Object.values(before.inventories).flat(),...Object.values(after.inventories).flat()].map(i=>i.id));
 const atBank=p.level===0&&Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=4&&DROPS.every(id=>count(after,93,id)===0);
 const skillsSame=(skip:number[])=>before.skills.every((s,i)=>skip.includes(i)||after.skills[i]?.rawExperience===s.rawExperience);
 const assets=(food:number,loot:number)=>[...ids].every(id=>total(after,id)===total(before,id)+(DROPS.includes(id)?loot:id===TROUT?-food:0))
  &&[93,94].every(inv=>(before.inventories[inv]??[]).filter(i=>!DROPS.includes(i.id)&&i.id!==TROUT).every(i=>count(after,inv,i.id)===count(before,inv,i.id)));
 if(refusal[kind])return {
  entry:cowEntry(before,kind),bank:atBank&&p.x===before.position.x&&p.z===before.position.z,refused:result===null,
  // Natural regeneration may restore one HP during the refusal session.
  skills:skillsSame([]),assets:assets(0,0),health:after.skills[3]!.level>=before.skills[3]!.level&&after.skills[3]!.level<=20};
 const kills=result?.creditedKills,gain=after.skills[0]!.xp-before.skills[0]!.xp;
 const finished=kind==='entry'||kind==='restarted';
 return {
  entry:kind==='restarted'||cowEntry(before,kind),bank:atBank,
  target:finished?result?.ok===true&&result.targetMet===true&&result.stop==='target-level'&&after.skills[0]!.level>=20&&result.finalLevel>=20
   :kind==='partial'?result?.ok===true&&result.targetMet===false&&result.stop==='max-kills'&&result.partial===true&&kills===1&&after.skills[0]!.level<20
   :result?.ok===false&&result.targetMet===false&&result.stop==='stop-file'&&result.partial===false&&after.skills[0]!.level<20,
  order:result?.trainSkill==='Attack'&&result.targetLevel===20&&result.startLevel===before.skills[0]?.level&&result.finalLevel===after.skills[0]?.level,
  xp:Number.isSafeInteger(result?.selectedXp)&&result.selectedXp>0&&gain===result.selectedXp&&result.attackXp===gain
   &&after.skills[3]!.rawExperience>before.skills[3]!.rawExperience&&skillsSame([0,3]),
  loot:Number.isSafeInteger(kills)&&kills>=1&&kills<=5&&['hide','bones','beef'].every(k=>result.banked?.[k]===kills)
   &&DROPS.every(id=>count(after,95,id)-count(before,95,id)===kills),
  food:Number.isSafeInteger(result?.eaten)&&result.eaten>=0&&result.foodAccounted===true&&total(before,TROUT)-total(after,TROUT)===result.eaten&&count(after,93,TROUT)>=2,
  assets:assets(result?.eaten??0,kills??0)&&result?.preserved===true,
  health:after.skills[3]!.level>0&&result?.died===false&&result.respawns===0&&Number.isFinite(result.hpMin)&&result.hpMin>0,
 };
}
export function cowChildChecks(code:number,timedOut:boolean,log:string,kind:Kind){
 log=log.replace(/\r\n/g,'\n');
 const ok=kind==='entry'||kind==='partial'||kind==='restarted';
 const start=log.search(/^START \d+ \d+ 0$/m),owner=log.indexOf('COW_STOP_OWNER stop file\n'),result=log.indexOf('COW_RESULT '),logout=log.indexOf('LOGOUT logged-out');
 return {exit:!timedOut&&(ok?code===0:code!==0),logout:(log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*?(logout|session close)/m.test(log),
  stopOwner:kind!=='stopped'||start>=0&&owner>start&&result>owner&&logout>result,
  result:ok?/^RESULT ok mode=cow /m.test(log):refusal[kind]?refusal[kind]!.test(log):/^RESULT fail mode=cow .*stop=stop-file/m.test(log)};
}
export function cowSequenceChecks(receipts:any[]){
 const receipt=(id:Kind)=>receipts.find((v:any)=>v.id===id),stopped=receipt('stopped'),partial=receipt('partial'),restarted=receipt('restarted');
 return {
  restart:typeof partial?.name==='string'&&restarted?.name===partial.name&&restarted?.before===partial.after&&typeof partial.after==='string',
  retired:typeof stopped?.name==='string'&&receipts.filter(c=>c.name===stopped.name).length===1&&stopped.retired===true&&stopped.stopRequested===true
   &&stopped.stopRetained===join(root,'.practice',`stop-${stopped.name}`),
  unstopped:receipts.filter(c=>c.id!=='stopped').every(c=>c.stopRequested===false&&c.stopRetained===null&&c.retired===false&&c.stopFailure===null),
 };
}
export function verifyCow(directory:string){
 verifyCompletedRecoveryDelivery(directory);
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const receipt=(id:Kind)=>meta.cases?.find((v:any)=>v.id===id);
 const checks:Record<string,boolean>={source:JSON.stringify(meta.source)===JSON.stringify(source()),configuration:meta.tickMs===150&&meta.xpRate===25,
  fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,cases:JSON.stringify(meta.cases?.map((c:any)=>c.id))===JSON.stringify(cases),
  ...cowSequenceChecks(meta.cases??[])};
 for(const id of cases){
  const dir=join(directory,id),c=receipt(id);
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav')),log=readFileSync(join(dir,'worker.log'),'utf8');
  const local={...cowSaveChecks(before,after,cowResult(log),id),...cowChildChecks(c?.code,c?.timedOut,log,id),
   stopRetained:id!=='stopped'||c?.stopFailure===null&&typeof c?.stopMarkerHash==='string'&&hash(c.stopRetained)===c.stopMarkerHash,
   savedLogout:c?.persisted===true&&(after.vars[134]??0)>(before.vars[134]??0),beforeHash:c?.before===hash(join(dir,'before.sav')),afterHash:c?.after===hash(join(dir,'after.sav')),logHash:c?.log===hash(join(dir,'worker.log'))};
  for(const [key,value] of Object.entries(local))checks[id+':'+key]=value;
 }
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),checks,
  scope:'Native installed cow CLI on a dated Swordinhand clone only; no live release, unattended or speed claim; no shark food claim.',
  nextConsumer:'Swordinhand live Attack9->20 order with TARGET=cow TRAIN_SKILL=Attack TARGET_LEVEL=20 MAX_KILLS=5 CAP=1500; then its Arrav alternate Black Arm donor qualification with Bigchopper (research/heroes-partner.md).'};
 writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(directory:string){
 verifyCompletedRecoveryDelivery(directory);
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error('insufficient practice startup reserve');
 mkdirSync(directory,{recursive:true});
 // Exclusive delivery folder: do not overwrite previous before/ snapshots.
 if(existsSync(join(directory,'native.json'))||cases.some(id=>existsSync(join(directory,id))))throw Error('cow proof directory already used');
 const lock=join(root,'.practice/delivery-practice.lock'),fd=openSync(lock,'wx');writeFileSync(fd,JSON.stringify({pid:process.pid,directory,task:'cow-progress-order'}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 try{
  const pin=source(),receipts:any[]=[];let partial:{name:string;path:string}|undefined;
  stack=await startStack({tickMs:150,xpRate:25,readyTimeoutMs:60000});
  for(const [index,id] of cases.entries()){
   const dir=join(directory,id);mkdirSync(dir);
   let name:string,path:string;
   if(id==='restarted'){if(!partial)throw Error('restart requires the unstopped partial account');({name,path}=partial);}
   else{
    // setPracticeSkills accepts only generated fl* practice saves.
    name=runBotName('flcow',index+1);const botDir=join(root,'vendor/rs-sdk/bots',name);
    if(existsSync(botDir))throw Error('isolated practice identity already exists');
    await createBot(name);
    if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
    path=await applyPreset(name,cowFixture(id));setPracticeSkills(path,SWORDINHAND.skills);
   }
   copyFileSync(path,join(dir,'before.sav'));
   const log=join(dir,'worker.log'),stopFile=join(root,'.practice',`stop-${name}`);
   if(existsSync(stopFile))throw Error('stale stop file for practice identity');
   const config=cowChildConfiguration(name,process.env,id);
   const child=Bun.spawn({...config,stdout:Bun.file(log),stderr:Bun.file(join(dir,'worker.err')),windowsHide:true});
   let timedOut=false,exited=false,stopRequested=false,termination:Promise<void>|undefined,ownedStop:CowStop|undefined;
   const timer=setTimeout(()=>{timedOut=true;termination=killTree(child.pid)},270000);
   const exit=child.exited.then(code=>{exited=true;return code;});
   if(id==='stopped'){
    // Request the stop after the first observed credited kill.
    while(!exited&&!timedOut){let text='';try{text=readFileSync(log,'utf8');}catch{}if(/^MILESTONE cow credited=1 /m.test(text))break;await Bun.sleep(250);}
    if(!exited&&!timedOut){ownedStop=claimCowStop(stopFile,`cow-progress-order proof stop ${directory} ${id}\n`);stopRequested=true;}
   }
   const code=await exit;clearTimeout(timer);await termination;
   // No retention observation or mutation. This stop identity is never reused.
   let stopRetained:string|null=null,stopFailure='';
   if(ownedStop)stopRetained=retainCowStop(ownedStop);
   if(!ownedStop&&existsSync(stopFile))stopFailure='foreign stop file for practice identity; retained';
   const before=readPracticeSave(join(dir,'before.sav'));
   const persisted=await waitPracticeSave(path,s=>(s.vars[134]??0)>(before.vars[134]??0),{timeoutMs:15000});
   copyFileSync(path,join(dir,'after.sav'));
   receipts.push({id,name,code,timedOut,stopRequested,stopRetained,retired:!!ownedStop,stopMarkerHash:ownedStop?createHash('sha256').update(ownedStop.marker).digest('hex'):null,stopFailure:stopFailure||null,persisted:persisted.matched,before:hash(join(dir,'before.sav')),after:hash(join(dir,'after.sav')),log:hash(log)});
   writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source:pin,tickMs:150,xpRate:25,cases:receipts},null,2));
   // Preserve the failed case; do not proceed with a still-owned account.
   if(!persisted.matched||timedOut)throw Error('cow child logout/save deadline; evidence retained');
   if(stopFailure)throw Error(stopFailure);
   const local={...cowSaveChecks(before,readPracticeSave(join(dir,'after.sav')),cowResult(readFileSync(log,'utf8')),id),...cowChildChecks(code,timedOut,readFileSync(log,'utf8'),id)};
   if(!Object.values(local).every(Boolean))throw Error(`cow ${id} checks failed; evidence retained`);
   if(id==='partial')partial={name,path};
  }
  return verifyCow(directory);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){try{if(!process.env.DELIVERY_DIR)throw Error('run through the cow-progress-order delivery harness');const directory=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verifyCow(directory):await run(directory)).ok?0:1;}catch(error){console.error(String(error));process.exitCode=1;}}
