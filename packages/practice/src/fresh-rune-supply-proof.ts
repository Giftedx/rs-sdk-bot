// Harness-owned native proof. Import and --verify never launch services or workers.
// No presets, stat setters, quest setters, teleports or staged essence.
import {readFileSync,writeFileSync,existsSync,copyFileSync,mkdirSync,openSync,closeSync,unlinkSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {canBind} from './ports';
import {createBot} from './bots';
import {runBotName} from './prove';
import {killTree} from './proc';
import {readPracticeSave,waitPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {workerSourceRevision} from '../../core/src/worker-release';
import {runeSupplyPreserved} from '../../../scripts/rune-supply';
import {applyPreset} from './presets';
import {setPracticeSkills} from '../../../scripts/measure/fleet-player-save';
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
const root=resolve(import.meta.dir,'../../..');
// Native check is 900s. Stop work at 810s, leaving 90s for owned cleanup.
const workMs=810000;
export function freshRuneChildTimeout(label:string,deadline:number,now=Date.now()){
 const timeoutMs=Math.min(label==='registration'||label==='cooking'?45000:label==='essence-diagnostic'?480000:label==='interrupted'?180000:workMs,deadline-now-60000);
 if(timeoutMs<=0)throw Error('no child budget remains at '+label);
 return timeoutMs;
}
type ProofBudget={deadline:number;check():void};
export async function withFreshRuneStack<T>(directory:string,work:(budget:ProofBudget)=>Promise<T>,deps={
 practice:join(root,'.practice'),free:freemem,portsFree:()=>canBind(8888)&&canBind(7780),start:startStack,
},tickMs:150|400=150):Promise<T>{
 const deadline=Date.now()+workMs;
 if(deps.free()<12*2**30)throw Error('insufficient practice startup reserve: need12GiB');
 const lock=join(deps.practice,'delivery-practice.lock'),pids=join(deps.practice,'pids.json');
 const owner=JSON.stringify({pid:process.pid,directory,task:'fresh-rune-supply-order'});
 const fd=openSync(lock,'wx');
 let stack:Awaited<ReturnType<typeof startStack>>|undefined,ownedPids:string|undefined;
 const ownsLock=()=>existsSync(lock)&&readFileSync(lock,'utf8')===owner;
 const budget={deadline,check:()=>{
  if(Date.now()>=deadline)throw Error('fresh rune proof work deadline; retain evidence');
  if(deps.free()<8*2**30)throw Error('practice memory floor: need8GiB free');
  if(!ownsLock())throw Error('practice lock ownership changed; retain evidence');
 }};
 try{
  writeFileSync(fd,owner);writeFileSync(join(directory,'practice-owner.json'),owner,{flag:'wx'});
  // Do not overwrite even stale owner evidence. Recovery belongs to the harness.
  if(existsSync(pids)||!deps.portsFree())throw Error('practice stack ownership or occupied ports; refuse adoption');
  if(deps.free()<12*2**30)throw Error('insufficient fresh practice startup reserve: need12GiB');
  stack=await deps.start({tickMs,xpRate:25,readyTimeoutMs:60000});
  ownedPids=readFileSync(pids,'utf8');
  writeFileSync(join(directory,'stack-owner.json'),ownedPids,{flag:'wx'});
  budget.check();
  return await work(budget);
 }finally{
  try{
   if(stack){
    // Stack.stop uses pids.json. Never let it target a replacement owner's PIDs.
    if(!ownsLock()||ownedPids===undefined||!existsSync(pids)||readFileSync(pids,'utf8')!==ownedPids)
     throw Error('practice stack ownership changed; retained lock/PID evidence, no foreign stop');
    try{for(const [service,path] of Object.entries(stack.logs))if(existsSync(path))copyFileSync(path,join(directory,'stack-'+service+'.log'));}
    finally{await stack.stop();}
   }
  }finally{closeSync(fd);if(ownsLock())unlinkSync(lock);}
 }
}
const sum=(s:Save,id:number,container?:number)=>Object.entries(s.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .reduce((n,[,items])=>n+items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
const assets=(s:Save)=>{const a:Record<number,number>={};for(const i of Object.values(s.inventories).flat())a[i.id]=(a[i.id]??0)+i.count;return a;};
const summary=(r:Run)=>{try{return JSON.parse(r.log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_SUPPLY_RESULT ')).at(-1)?.slice(19)??'null');}catch{return null;}};
const logout=(r:Run)=>(r.log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*logout/m.test(r.log);
// PlayerLoading -> getExpByLevel(10): pinned levelExperience[8] is9800
// raw tenths, or980XP. The reader truncates tenths; check both fields exactly.
export const freshRuneDefaultSkills=(s:Save)=>s.skills.length===21&&s.skills.every((s,i)=>
 i===3?s.level===10&&s.xp===980&&s.rawExperience===9800:s.level===1&&s.xp===0&&s.rawExperience===0);
const retainedProgress=(before:Save,interrupted:Save)=>interrupted.skills.some((s,i)=>s.xp>(before.skills[i]?.xp??0))||(interrupted.vars[63]??0)>(before.vars[63]??0);
export function freshRuneSupportedInterruption(first:Run){
 const a=summary(first);
 return first.code!==0&&a?.ok===false&&typeof a?.stage==='string'&&a.stage!=='entry'&&a?.stopReason==='tick-cap'&&Number.isSafeInteger(a?.ticks)&&a.ticks>=1000;
}
export function freshRuneSupplyChecks(p:{before:Save;interrupted:Save;after:Save;first:Run;resume:Run;xpRate:number;target:number;additional?:Run[]}){
 const {before,interrupted,after,first,resume,xpRate,target}=p;
 const a=summary(first),b=summary(resume),initialAir=sum(before,556),tutorial=(before.vars[281]??0)<1000;
 const grantedAir=tutorial?25:0,mining=(after.skills[14]?.xp??0)-(before.skills[14]?.xp??0),rc=(after.skills[20]?.xp??0)-(before.skills[20]?.xp??0);
 const mined=mining/(5*xpRate),used=rc/(5*xpRate),stock=sum(after,1436)-sum(before,1436);
 const runs=[first,...(p.additional??[]),resume],results=runs.map(summary);
 const total=(get:(r:any)=>number)=>results.reduce((n,r)=>n+(get(r)??0),0);
 const crafted=total(r=>r?.crafted);
 const food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const cooked=total(r=>r?.stages?.food?.cooked),burnt=total(r=>r?.stages?.food?.burnt);
 const eaten=total(r=>(r?.travelFoodEaten??0)+(r?.stages?.quest?.eats??0)+(r?.stages?.questExit?.eats??0));
 return {
  defaultSkills:freshRuneDefaultSkills(before),
  defaultQuest:(before.vars[63]??0)===0&&(before.vars[101]??0)===0,
  noSeededEssence:sum(before,1436)===0&&sum(before,7936)===0,
  tutorial:after.vars[281]===1000,
  quest:after.vars[63]===6&&(after.vars[101]??0)===(before.vars[101]??0)+1,
  reward:sum(after,1438)===1,
  target:(after.skills[20]?.level??0)>=target&&rc>0&&mining>0,
  minedOwnInput:Number.isSafeInteger(mined)&&mined>0&&Number.isSafeInteger(used)&&used>0&&mined===used+stock,
  newBankedRunes:crafted>0&&sum(after,556,95)===initialAir+grantedAir+crafted&&sum(after,556,93)===0,
  kit:[1277,1171,1265,1351,590,303,1925,1931,1205,841].every(id=>sum(after,id)>=1),
  food:food(after)===food(before)+(tutorial?2:0)+cooked-eaten,
  cooking:after.skills[7]!.rawExperience-before.skills[7]!.rawExperience===cooked*30*xpRate*10&&sum(after,2144)-sum(before,2144)===burnt,
  cash:sum(after,995)===sum(before,995)+(tutorial?25:0),
  preserved:runeSupplyPreserved(assets(before),assets(after)),
  stopped:freshRuneSupportedInterruption(first),
  retainedProgress:retainedProgress(before,interrupted),
  resume:resume.code===0&&b?.ok===true&&b?.preserved===true&&b?.target===target,
  life:after.skills[3]!.level>0&&runs.every(r=>! /"isDead":true|"died":true/.test(r.log)),
  logout:runs.every(logout),
 };
}
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const files=['scripts/rune-supply.ts','scripts/rune-supply.test.ts','scripts/train-chickens.ts','scripts/train-chickens.test.ts',
 'scripts/generated/quest-runemysteries.ts','scripts/generated/quest-lib.ts','scripts/rune-mysteries-route.ts','scripts/rune-mysteries-route.test.ts',
 'scripts/gather-essence.ts','scripts/gather-essence.test.ts','scripts/generated/rcair.ts','scripts/fishcook.ts','scripts/fishcook.test.ts',
 'packages/practice/src/fresh-rune-supply-proof.ts','packages/practice/test/fresh-rune-supply-proof.test.ts'];
const sources=()=>Object.fromEntries(files.map(p=>[p,hash(join(root,p))]));

// Both native paths use the same child admission, floor, deadline and cleanup owner.
async function freshRuneCommand(directory:string,budget:ProofBudget,label:string,args:string[],save:string,env:Record<string,string>={}){
 budget.check();
 const timeoutMs=freshRuneChildTimeout(label,budget.deadline);
 const child=Bun.spawn(['bun',...args],{cwd:root,env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'1',RUNE_COOK_DIAGNOSTIC:'',RUNE_AIR_EXIT_DIAGNOSTIC:'',...env},
  stdout:Bun.file(join(directory,label+'.log')),stderr:Bun.file(join(directory,label+'.err')),windowsHide:true});
 let failure='',termination:Promise<void>|undefined;
 const terminate=(reason:string)=>{if(!termination){failure=reason;termination=killTree(child.pid);}};
 const timer=setTimeout(()=>terminate('child deadline'),timeoutMs);
 const floor=setInterval(()=>{try{budget.check();}catch(error){terminate(String(error));}},1000);
 try{
  const code=await child.exited;await termination;
  writeFileSync(join(directory,label+'-outcome.json'),JSON.stringify({code:failure?-1:code,failure,timeoutMs}),{flag:'wx'});
  if(failure)throw Error(`${label}: ${failure}; retain logs and save`);
  return code;
 }catch(error){
  if(existsSync(save))copyFileSync(save,join(directory,label+'-failed.sav'));
  throw error;
 }finally{clearTimeout(timer);clearInterval(floor);if(child.exitCode===null)await killTree(child.pid);await termination;}
}

export function freshRuneCookingDiagnosticInput(name:string,retained:string){
 if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('diagnostic requires an existing practice account');
 if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('diagnostic account has a stop file; preserve the stop');
 const botDir=join(root,'vendor/rs-sdk/bots',name),save=join(root,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
 if(!existsSync(save)||!existsSync(join(botDir,'bot.env'))||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))
  throw Error('diagnostic requires retained local identity; never register or restore a save');
 if(resolve(retained)===resolve(save)||hash(retained)!==hash(save))throw Error('diagnostic current save differs from retained evidence; do not reseed');
 const before=readPracticeSave(save);
 if(before.position.level!==0||Math.max(Math.abs(before.position.x-3214),Math.abs(before.position.z-3249))>2||sum(before,2138,93)<1)
  throw Error('diagnostic requires retained raw chicken at the failed fireplace boundary');
 return {save,before};
}

export function freshRuneCookingDiagnosticChecks(before:Save,after:Save,run:Run){
 const cooked=sum(after,2140)-sum(before,2140),burnt=sum(after,2144)-sum(before,2144),debit=sum(before,2138)-sum(after,2138);
 const xp=after.skills[7]!.xp-before.skills[7]!.xp;
 const a=assets(before),b=assets(after),converted=new Set([2138,2140,2144]);
 return {child:run.code===0,logout:logout(run),oneConversion:debit===1&&cooked>=0&&burnt>=0&&cooked+burnt===debit,
  xp:cooked>0?xp>0:xp===0,questUnchanged:after.vars[63]===before.vars[63]&&after.vars[101]===before.vars[101],
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  otherSkills:after.skills.every((s,i)=>i===7||s.rawExperience===before.skills[i]!.rawExperience),
  preserved:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  observations:run.log.includes('STARTER_COOKING ')&&run.log.includes('"phase":"dispatch"')&&run.log.includes('"phase":"action"')&&run.log.includes('RUNE_COOK_DIAGNOSTIC_RESULT ')};
}

// Continue the ordinary retained identity. Copy evidence, never restore or seed
// the engine's save. Full-delivery registration and predicates stay separate.
export function freshRuneEssenceDiagnosticInput(name:string,retained:string){
 if(!/^[a-z0-9]{1,12}$/i.test(name))throw Error('diagnostic requires an existing practice account');
 if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('diagnostic account has a stop file; preserve the stop');
 const botDir=join(root,'vendor/rs-sdk/bots',name),save=join(root,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
 if(!existsSync(save)||!existsSync(join(botDir,'bot.env'))||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))
  throw Error('diagnostic requires retained local identity; never register or restore a save');
 if(resolve(retained)===resolve(save)||hash(retained)!==hash(save))throw Error('diagnostic current save differs from retained evidence; do not reseed');
 const before=readPracticeSave(save);
 if(before.vars[63]!==6||before.vars[101]!==1||before.vars[281]!==1000||before.position.level!==0||before.position.z>=4000
  ||before.skills[3]!.level<=0||before.skills[14]!.xp<=0||before.skills[20]!.xp!==0||before.skills[20]!.rawExperience!==0||before.skills[20]!.level!==1||sum(before,1436)<=0||sum(before,1438)!==1)
  throw Error('diagnostic requires completed Rune Mysteries and retained self-mined essence before first craft');
 return {save,before};
}

export function freshRuneEssenceDiagnosticChecks(before:Save,after:Save,run:Run){
 const r=summary(run),used=sum(before,1436)-sum(after,1436),newAir=sum(after,556)-sum(before,556);
 const xp=after.skills[20]!.xp-before.skills[20]!.xp,food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 const observations=run.log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_SUPPLY_ACTION ')).map(l=>{try{return JSON.parse(l.slice(19));}catch{return null;}});
 return {child:run.code===0&&r?.ok===true&&r?.target===2,logout:logout(run),
  questUnchanged:before.vars[63]===6&&after.vars[63]===6&&after.vars[101]===before.vars[101]&&after.vars[281]===before.vars[281],
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit&&!/ESSENCE_START|STARTER_COOKING_RESULT|MILESTONE training/.test(run.log),
  noMining:r?.mined===0&&after.skills[14]!.rawExperience===before.skills[14]!.rawExperience,
  // Pinned runecraft.rs2 snapshots level before XP. Air multiplier is
  // floor(level/11)+1, so this first level1 craft produces exactly one per essence.
  conversion:before.skills[20]!.xp===0&&before.skills[20]!.level===1&&r?.stages?.batches===1&&used>0&&xp===used*125
   &&after.skills[20]!.rawExperience-before.skills[20]!.rawExperience===used*1250&&r?.consumed===used&&newAir===used&&r?.crafted===newAir,
  banked:sum(after,556,93)===0&&sum(after,556,95)===sum(before,556)+newAir&&r?.banked===newAir,
  otherSkills:after.skills.every((s,i)=>i===20||s.rawExperience===before.skills[i]!.rawExperience&&s.xp===before.skills[i]!.xp),
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  preserved:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  observations:['craft-air','deposit-air'].every(action=>observations.some(o=>o?.action===action&&o?.phase==='end'))};
}

export async function diagnoseFreshRuneEssence(directory:string,name:string,retained:string){
 freshRuneEssenceDiagnosticInput(name,retained);
 mkdirSync(directory,{recursive:true});
 if(['native.json','before.sav','essence-before.sav','essence-diagnostic.json'].some(f=>existsSync(join(directory,f))))
  throw Error('use a separate new essence diagnostic directory');
 const retainedHash=hash(retained),source=workerSourceRevision(),files=sources();
 return withFreshRuneStack(directory,async budget=>{
  const {save,before}=freshRuneEssenceDiagnosticInput(name,retained);
  copyFileSync(save,join(directory,'essence-before.sav'));
  const startedAt=Date.now();
  const code=await freshRuneCommand(directory,budget,'essence-diagnostic',['scripts/rune-supply.ts',name,'2'],save,{CAP:'3000'});
  const elapsedMs=Date.now()-startedAt;
  // A supported failure also retains the first saved boundary. Never replay it.
  const publication=await waitPracticeSave(save,s=>code!==0||s.skills[20]!.xp>before.skills[20]!.xp);
  copyFileSync(save,join(directory,'essence-after.sav'));
  const after=readPracticeSave(save),log=readFileSync(join(directory,'essence-diagnostic.log'),'utf8')+readFileSync(join(directory,'essence-diagnostic.err'),'utf8');
  const checks={...freshRuneEssenceDiagnosticChecks(before,after,{code,log}),published:publication.matched,retained:hash(retained)===retainedHash,
   source:workerSourceRevision()===source&&JSON.stringify(files)===JSON.stringify(sources())};
  const report={ok:Object.values(checks).every(Boolean),checks,name,source,files,retained:resolve(retained),retainedHash,
   beforeHash:hash(join(directory,'essence-before.sav')),afterHash:hash(join(directory,'essence-after.sav')),elapsedMs,tickMs:150,xpRate:25,
   scope:'Retained essence through installed CLI to first banked crafted output only. Not default-entry, Runecraft20, continuation, live or full delivery proof.'};
  writeFileSync(join(directory,'essence-diagnostic.json'),JSON.stringify(report,null,2),{flag:'wx'});
  return report;
 });
}

// Harness-only reduced run. No new identity, restore, training, quest or native.json.
export async function diagnoseFreshRuneCooking(directory:string,name:string,retained:string){
 const input=freshRuneCookingDiagnosticInput(name,retained);
 mkdirSync(directory,{recursive:true});
 if(['native.json','before.sav','cooking-before.sav','cooking-diagnostic.json'].some(f=>existsSync(join(directory,f))))
  throw Error('use a separate new cooking diagnostic directory');
 const retainedHash=hash(retained),source=workerSourceRevision(),files=sources();
 return withFreshRuneStack(directory,async budget=>{
  // Recheck after admission. Failed delivery saves remain read-only evidence.
  const {save,before}=freshRuneCookingDiagnosticInput(name,retained);
  copyFileSync(save,join(directory,'cooking-before.sav'));
  const code=await freshRuneCommand(directory,budget,'cooking',['scripts/rune-supply.ts',name,'20'],save,{RUNE_COOK_DIAGNOSTIC:'1'});
  await waitPracticeSave(save,s=>code!==0||sum(s,2138,93)===sum(before,2138,93)-1);copyFileSync(save,join(directory,'cooking-after.sav'));
  const after=readPracticeSave(save),log=readFileSync(join(directory,'cooking.log'),'utf8')+readFileSync(join(directory,'cooking.err'),'utf8');
  const cooked=sum(after,2140)-sum(before,2140),burnt=sum(after,2144)-sum(before,2144),debit=sum(before,2138)-sum(after,2138);
  const xp=after.skills[7]!.xp-before.skills[7]!.xp;
  const checks={...freshRuneCookingDiagnosticChecks(before,after,{code,log}),retained:hash(retained)===retainedHash,
   source:workerSourceRevision()===source&&JSON.stringify(files)===JSON.stringify(sources())};
  const report={ok:Object.values(checks).every(Boolean),checks,name,source,files,retained:resolve(retained),retainedHash,
   beforeHash:hash(join(directory,'cooking-before.sav')),afterHash:hash(join(directory,'cooking-after.sav')),cooked,burnt,debit,xp,
   scope:'Single retained-state cooking diagnostic. Does not qualify the full fresh rune supply delivery.'};
  writeFileSync(join(directory,'cooking-diagnostic.json'),JSON.stringify(report,null,2),{flag:'wx'});
  return report;
 });
}
// Recovery fixtures never contribute to genuine-registration predicates.
export const airRecoveryPositions=[{x:2843,z:4832,level:0},{x:2842,z:4831,level:0},{x:2841,z:4830,level:0}];
type RecoverySession={mode:'refused'|'exit';clockBefore:number;clockAfter:number};
export function freshRuneRecoveryContentsEqual(before:Save,after:Save,session?:RecoverySession){
 // The ordinary generator writes v6/dense varps. PlayerLoading/Player.save
 // upgrade to v9/sparse varps on logout. Compare values, not serialization.
 const expected={...before.vars};
 if(session){
  // Only these three ordinary altar fixtures are supported, never arbitrary saves.
  if(!airRecoveryPositions.some(p=>same(p,before.position))||before.vars[63]!==6||before.vars[101]!==1||before.vars[281]!==1000
   ||!['refused','exit'].includes(session.mode)||!Number.isSafeInteger(session.clockBefore)||!Number.isSafeInteger(session.clockAfter)
   ||session.clockBefore<1||session.clockAfter<session.clockBefore||session.clockAfter-session.clockBefore>6000
   ||!Number.isSafeInteger(after.vars[134])||after.vars[134]!<session.clockBefore||after.vars[134]!>session.clockAfter)return false;
  // login_logout/login.rs2: defaults run only when brightness is zero.
  if((before.vars[166]??0)===0)Object.assign(expected,{166:2,168:2,169:2});
  // musicregion.dbrow 44_75 -> Serene, music.dbrow unlock 4,13.
  expected[23]=((before.vars[23]??0)|8192)>>>0;
  // An observed exit enters 46_51 -> Nightfall, unlock 3,26. No other bits.
  if(session.mode==='exit')expected[22]=((before.vars[22]??0)|67108864)>>>0;
  // pet.rs2 follower_login: object0 has no follower_id and is cleared.
  if((before.vars[275]??0)===0)expected[275]=0xffffffff;
  // anti_fire.rs2 set_antifire_logout: zero expires at positive map_clock.
  // An active timer is outside this fixture contract, rather than silently erased.
  if((before.vars[277]??0)!==0&&(before.vars[277]>>>0)!==0xffffffff)return false;
  expected[277]=0xffffffff;
  // Player constructor defaults non-int types to -1. The v6 generator ends at
  // varp308, so absent coord367 keeps that default. An explicit value must match.
  if(before.vars[367]===undefined)expected[367]=0xffffffff;
  // logout.rs2 writes map_clock. Both bounds come from the owned server's
  // read-only /tickstats before/after this CLI, retained and hashed per session.
  expected[134]=after.vars[134]!;
 }
 const vars=(v:Save['vars'])=>Object.fromEntries(Object.entries(v).map(([id,value])=>[id,value>>>0] as const).filter(([,value])=>value!==0));
 const position=session?.mode==='exit'?{x:2983,z:3288,level:0}:before.position;
 return same(position,after.position)&&same(before.skills,after.skills)&&same(before.inventories,after.inventories)&&same(vars(expected),vars(after.vars));
}
async function freshRuneRecoveryClock(tickMs=150){
 const response=await fetch('http://localhost:8898/tickstats',{signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw Error('air recovery server clock unavailable');
 const stats=await response.json() as {tick:number;tickRate:number};
 if(!Number.isSafeInteger(stats.tick)||stats.tick<1||stats.tickRate!==tickMs)throw Error('air recovery server clock/configuration differs');
 return stats.tick;
}
export function freshRuneAirRecoveryChecks(before:Save,after:Save,run:Run,target:20|21){
 const r=summary(run),food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 const raw=(s:Save,i:number)=>s.skills[i]!.rawExperience;
 const mined=(raw(after,14)-raw(before,14))/1250,used=(raw(after,20)-raw(before,20))/1250;
 const newAir=sum(after,556)-sum(before,556),a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 return {child:run.code===0&&r?.ok===true&&r?.target===target,logout:logout(run),savedResult:freshRuneSavedResult(after,run),
  entry:before.vars[63]===6&&before.vars[101]===1&&before.vars[281]===1000&&sum(before,556)===51
   &&before.skills[20]!.level===20&&raw(before,20)===32500
   &&sum(before,1436)===0&&sum(before,7936)===0&&[1438,1265,1171].every(id=>sum(before,id)===1),
  quest:after.vars[63]===6&&after.vars[101]===1&&after.vars[281]===1000,
  target:after.skills[20]!.level>=target,
  inherited:target===20?r?.inheritedBanked===26&&r?.banked===26&&r?.newBanked===0&&r?.crafted===0&&r?.consumed===0&&r?.mined===0
   &&sum(before,556,93)===26&&sum(before,556,95)===25&&sum(after,556)===51
   :r?.inheritedBanked===0&&sum(before,556,93)===0&&sum(before,556,95)===51,
  banked:sum(after,556,93)===0&&sum(after,556,95)===sum(before,556)+newAir&&r?.banked===r?.inheritedBanked+r?.newBanked,
  production:target===20?newAir===0&&raw(after,20)===raw(before,20)&&raw(after,14)===raw(before,14)
   :Number.isSafeInteger(mined)&&mined>0&&Number.isSafeInteger(used)&&used>0&&mined===used+sum(after,1436)
    &&r?.mined===mined&&r?.consumed===used&&r?.crafted===newAir&&newAir>0&&r?.newBanked===newAir,
  otherSkills:after.skills.every((s,i)=>i===14||i===20||s.rawExperience===before.skills[i]!.rawExperience&&s.level===before.skills[i]!.level),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level>0&&!/"isDead":true|"died":true/.test(run.log),
  outside:target===21||run.log.split(/\r?\n/).some(l=>{try{const o=JSON.parse(l.slice(9));return l.startsWith('AIR_EXIT ')&&o.phase==='outside'&&o.position?.worldX===2983&&o.position?.worldZ===3288&&o.position?.level===0;}catch{return false;}}),
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit};
}
// Ordinary seeded recovery evidence stays separate from genuine registration.
export function freshRunePostCraftChecks(before:Save,after:Save,run:Run){
 const r=summary(run),events=run.log.split(/\r?\n/).flatMap(line=>{
  const prefix=line.startsWith('AIR_EXIT ')?'AIR_EXIT':line.startsWith('RUNE_SUPPLY_ACTION ')?'RUNE_SUPPLY_ACTION':null;
  if(!prefix)return [];try{return [{prefix,...JSON.parse(line.slice(prefix.length+1))}];}catch{return [];}
 });
 const craft=events.findIndex(e=>e.prefix==='RUNE_SUPPLY_ACTION'&&e.action==='craft-air'&&e.phase==='end');
 const selected=events.findIndex((e,i)=>i>craft&&e.prefix==='AIR_EXIT'&&e.phase==='selected');
 const exit=events.filter(e=>e.prefix==='AIR_EXIT'),outside=exit.find(e=>e.phase==='outside');
 const a=assets(before),b=assets(after),converted=new Set([1436,556,315,2309,2140]);
 const food=(s:Save)=>[315,2309,2140].reduce((n,id)=>n+sum(s,id),0);
 return {child:run.code===0&&r?.ok===true&&r?.target===20,logout:logout(run),savedResult:freshRuneSavedResult(after,run),
  entry:same(before.position,airRecoveryPositions[0])&&before.vars[63]===6&&before.vars[101]===1&&before.vars[281]===1000
   &&before.skills[20]!.level===20&&before.skills[20]!.rawExperience===32500&&sum(before,1436,93)===1&&sum(before,1436)===1
   &&sum(before,7936)===0&&sum(before,556,93)===26&&sum(before,556,95)===25&&[1438,1265,1171].every(id=>sum(before,id)===1),
  quest:after.vars[63]===6&&after.vars[101]===1&&after.vars[281]===1000,
  production:r?.consumed===1&&r?.crafted===2&&r?.mined===0&&r?.stages?.resumedCraft?.ok===true
   &&r?.stages?.resumedCraft?.consumed===1&&r?.stages?.resumedCraft?.runes===2&&r?.stages?.resumedCraft?.xp===125
   &&sum(after,1436)===0&&sum(after,7936)===0&&sum(after,556)-sum(before,556)===2
   &&after.skills[20]!.rawExperience-before.skills[20]!.rawExperience===1250&&after.skills[20]!.level===20,
  banked:r?.inheritedBanked===26&&r?.newBanked===2&&r?.banked===28&&sum(after,556,93)===0&&sum(after,556,95)===53,
  craftThenExit:craft>=0&&selected>craft&&events[selected].tick-events[craft].tick>=0&&events[selected].tick-events[craft].tick<=1
   &&events[craft].essence===0&&events[craft].air===28&&events[craft].runecraftXp===3375,
  approach:exit.some(e=>e.phase==='path'&&e.reply?.path?.success===true&&e.reply?.path?.reachedDestination===true)
   &&exit.some(e=>e.phase==='approached'&&e.reply?.success===true&&e.position?.level===0
    &&Math.abs(e.position.worldX-2841)+Math.abs(e.position.worldZ-4828)===1),
  dispatch:exit.some(e=>e.phase==='dispatch'&&e.portal?.id===2465&&e.portal?.x===2841&&e.portal?.z===4828)
   &&exit.some(e=>e.phase==='action'&&e.reply?.success===true),
  outside:outside?.position?.worldX===2983&&outside?.position?.worldZ===3288&&outside?.position?.level===0,
  otherSkills:after.skills.every((sk,i)=>i===20||sk.rawExperience===before.skills[i]!.rawExperience&&sk.level===before.skills[i]!.level),
  food:food(after)===food(before)-(r?.travelFoodEaten??0),
  assets:[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>converted.has(Number(id))||(a[Number(id)]??0)===(b[Number(id)]??0)),
  life:after.skills[3]!.level===before.skills[3]!.level&&!/"isDead":true|"died":true/.test(run.log),
  noPreparation:!r?.stages?.training&&!r?.stages?.food&&!r?.stages?.quest&&!r?.stages?.questExit};
}
export function verifyFreshRuneAirRecovery(parent:string,deps={binding:freshRuneBinding}){
 const directory=join(parent,'air-recovery'),meta=json(join(directory,'native.json'));
 if(meta.at<=1793211592453||meta.fixtures?.length!==5||meta.source!==workerSourceRevision()||!same(meta.files,sources()))throw Error('missing fresh air recovery evidence');
 const checks:Record<string,boolean>={};
 for(const [i,fixture] of meta.fixtures.entries()){
  const dir=join(directory,String(i)),binding=deps.binding(fixture.binding.name,i===4?400:150);
  checks['binding'+i]=same(binding,fixture.binding);
  const labels=i>=3?['postcraft']:i===0?['refused','recovery','higher']:['exit'];
  const required=['fixture.json','before.sav','after.sav',...(i===0?['refused.sav','higher.sav']:[]),...labels.flatMap(l=>[l+'.log',l+'.err',l+'-outcome.json']),
   ...(i>=3?['postcraft-clock.json']:[(i===0?'refused':'exit')+'-session.json'])];
  checks['hashes'+i]=required.every(file=>fixture.hashes[file]===hash(join(dir,file)))
   &&Object.entries(fixture.hashes).every(([file,digest])=>hash(join(dir,file))===digest);
  checks['codes'+i]=same(Object.keys(fixture.codes).sort(),[...labels].sort());
  const before=readPracticeSave(join(dir,'before.sav')),after=readPracticeSave(join(dir,'after.sav'));
  checks['position'+i]=same(before.position,airRecoveryPositions[i>=3?0:i]!);
  checks['pacing'+i]=fixture.tickMs===(i===4?400:150);
  if(i===0){
   checks.noReseed=fixture.higherInputHash===hash(join(dir,'after.sav'));
   const run=readRun(dir,'recovery',fixture.codes.recovery),higher=readRun(dir,'higher',fixture.codes.higher);
   Object.assign(checks,Object.fromEntries(Object.entries(freshRuneAirRecoveryChecks(before,after,run,20)).map(([k,v])=>['recovery-'+k,v])));
   Object.assign(checks,Object.fromEntries(Object.entries(freshRuneAirRecoveryChecks(after,readPracticeSave(join(dir,'higher.sav')),higher,21)).map(([k,v])=>['higher-'+k,v])));
   const refused=readRun(dir,'refused',fixture.codes.refused),refusedSave=readPracticeSave(join(dir,'refused.sav'));
   const session=json(join(dir,'refused-session.json'));
   checks.refused=session.mode==='refused'&&refused.code===0&&logout(refused)&&freshRuneRecoveryContentsEqual(before,refusedSave,session)&&refused.log.includes('AIR_EXIT_REJECTION {"ok":true,')&&refused.log.includes('"reason":"no_matching_option"');
  }else if(i>=3){
   const clock=json(join(dir,'postcraft-clock.json'));
   checks['clock'+i]=clock.tickMs===(i===4?400:150)&&clock.after>=clock.before&&clock.before>0;
   Object.assign(checks,Object.fromEntries(Object.entries(freshRunePostCraftChecks(before,after,readRun(dir,'postcraft',fixture.codes.postcraft))).map(([k,v])=>['postcraft'+i+'-'+k,v])));
  }else{
   const run=readRun(dir,'exit',fixture.codes.exit);
   const session=json(join(dir,'exit-session.json'));
   checks['nearby'+i]=session.mode==='exit'&&run.code===0&&logout(run)&&freshRuneRecoveryContentsEqual(before,after,session)
    &&same(after.position,{x:2983,z:3288,level:0})&&run.log.includes('"phase":"outside"');
  }
  checks['outcomes'+i]=Object.entries(fixture.codes).every(([label,code])=>{const o=json(join(dir,label+'-outcome.json'));return o.code===code&&o.failure==='';});
 }
 return {ok:Object.values(checks).every(Boolean),checks,at:meta.at};
}
export async function proveFreshRuneAirRecovery(parent:string){
 const directory=join(parent,'air-recovery');mkdirSync(directory,{recursive:true});
 // No replay after any partial fixture. Preserve its first missing effect.
 writeFileSync(join(directory,'attempt.json'),JSON.stringify({at:Date.now(),source:workerSourceRevision(),files:sources()}),{flag:'wx'});
 const fixtures:any[]=[];
 try{
 for(const tickMs of [150,400] as const){
 const stackDir=join(directory,'stack-'+tickMs);mkdirSync(stackDir,{recursive:true});
 await withFreshRuneStack(stackDir,async budget=>{
  for(const i of tickMs===150?[3,0,1,2]:[4]){
   const position=airRecoveryPositions[i>=3?0:i]!;
   budget.check();const dir=join(directory,String(i));mkdirSync(dir,{recursive:true});
   const name=runBotName('flair',i+1),save=engineSave(name);
   if(existsSync(save)||existsSync(join(root,'vendor/rs-sdk/bots',name)))throw Error('air recovery fixture identity already exists');
   await createBot(name);
   const binding=freshRuneBinding(name,tickMs);writeFileSync(join(dir,'fixture.json'),JSON.stringify({binding,position,scope:'ordinary recovery fixture; never default registration'}),{flag:'wx'});
   // Seed once, only for this separate ordinary fixture. Postcraft fixtures
   // carry one essence. The existing continuation fixture mines its own.
   await applyPreset(name,{position,skills:{Runecraft:20,Mining:20,Hitpoints:16,Attack:12,Defence:11,Strength:11},varps:{63:6,101:1,281:1000},
    inventory:[{id:1438,count:1},{id:556,count:26},{id:315,count:1},...(i>=3?[{id:1436,count:1}]:[])],equipment:[{id:1265,count:1,slot:3},{id:1171,count:1,slot:5}],
    bank:[{id:556,count:25},{id:995,count:25},{id:1277,count:1},{id:2140,count:8},{id:2309,count:1},{id:1351,count:1},{id:590,count:1}]});
   const seeded=readPracticeSave(save);setPracticeSkills(save,seeded.skills.map((s,index)=>({level:s.level,xp:index===20?3250:index===14?3375:s.xp})));
   copyFileSync(save,join(dir,'before.sav'));
   const codes:Record<string,number>={};let higherInputHash:string|undefined;
   const command=async(label:string,target:number,env:Record<string,string>={})=>{
    const mode=env.RUNE_AIR_EXIT_DIAGNOSTIC,clockBefore=mode?await freshRuneRecoveryClock(tickMs):undefined;
    codes[label]=await freshRuneCommand(dir,budget,label,['scripts/rune-supply.ts',name,String(target)],save,{CAP:'4000',...env});
    if(mode)writeFileSync(join(dir,label+'-session.json'),JSON.stringify({mode,clockBefore,clockAfter:await freshRuneRecoveryClock(tickMs)}),{flag:'wx'});
    copyFileSync(save,join(dir,label+'-observed.sav'));
    if(codes[label]!==0)throw Error('air recovery first boundary: '+label+'; retain action reply/messages/save; no full replay');
   };
   if(i>=3){
    const clockBefore=await freshRuneRecoveryClock(tickMs);
    await command('postcraft',20);
    writeFileSync(join(dir,'postcraft-clock.json'),JSON.stringify({tickMs,before:clockBefore,after:await freshRuneRecoveryClock(tickMs)}),{flag:'wx'});
    const observed=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'postcraft',codes.postcraft!)));
    copyFileSync(save,join(dir,'after.sav'));
    const checks=freshRunePostCraftChecks(readPracticeSave(join(dir,'before.sav')),readPracticeSave(save),readRun(dir,'postcraft',codes.postcraft!));
    if(!observed.matched||!Object.values(checks).every(Boolean))throw Error('postcraft recovery predicates failed '+JSON.stringify(checks));
   }else if(i===0){
    await command('refused',20,{RUNE_AIR_EXIT_DIAGNOSTIC:'refused'});
    const refusedBefore=readPracticeSave(join(dir,'before.sav')),session=json(join(dir,'refused-session.json'));
    const refused=await waitPracticeSave(save,s=>freshRuneRecoveryContentsEqual(refusedBefore,s,session));
    copyFileSync(save,join(dir,'refused.sav'));
    if(!refused.matched)throw Error('refused action changed fixture state');
    await command('recovery',20);
    const observed=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'recovery',codes.recovery!)));
    copyFileSync(save,join(dir,'after.sav'));
    const checks=freshRuneAirRecoveryChecks(readPracticeSave(join(dir,'before.sav')),readPracticeSave(save),readRun(dir,'recovery',codes.recovery!),20);
    if(!observed.matched||!Object.values(checks).every(Boolean))throw Error('air recovery predicates failed '+JSON.stringify(checks));
    // Same save and identity. Nothing restores it between these installed CLI calls.
    higherInputHash=hash(save);if(higherInputHash!==hash(join(dir,'after.sav')))throw Error('higher recovery input changed; refuse reseed');
    await command('higher',21);
    const higher=await waitPracticeSave(save,s=>freshRuneSavedResult(s,readRun(dir,'higher',codes.higher!)));
    copyFileSync(save,join(dir,'higher.sav'));if(!higher.matched)throw Error('higher recovery save unobserved');
    const later=freshRuneAirRecoveryChecks(readPracticeSave(join(dir,'after.sav')),readPracticeSave(save),readRun(dir,'higher',codes.higher!),21);
    if(!Object.values(later).every(Boolean))throw Error('higher recovery predicates failed '+JSON.stringify(later));
   }else{
    await command('exit',20,{RUNE_AIR_EXIT_DIAGNOSTIC:'exit'});
    const observed=await waitPracticeSave(save,s=>same(s.position,{x:2983,z:3288,level:0}));
    copyFileSync(save,join(dir,'after.sav'));if(!observed.matched)throw Error('nearby air exit save unobserved');
   }
   const paths=readdirSync(dir).filter(p=>/\.(sav|log|err|json)$/.test(p));
   fixtures[i]={binding,codes,tickMs,higherInputHash,hashes:Object.fromEntries(paths.map(p=>[p,hash(join(dir,p))]))};
  }
 },undefined,tickMs);
 }
 const meta={at:Date.now(),fixtures,source:workerSourceRevision(),files:sources()};
 writeFileSync(join(directory,'native.json'),JSON.stringify(meta,null,2),{flag:'wx'});
 const report=verifyFreshRuneAirRecovery(parent);writeFileSync(join(directory,'report.json'),JSON.stringify(report,null,2),{flag:'wx'});return report;
 }catch(error){
  writeFileSync(join(directory,'report.json'),JSON.stringify({ok:false,at:Date.now(),source:workerSourceRevision(),files:sources(),
   boundary:String(error),scope:'Reduced ordinary air recovery failed. Preserve all identities, saves and logs. Do not replay full starter stages.'},null,2),{flag:'wx'});
  throw error;
 }
}

export const freshRuneStages=['start','first-bank','target','higher'] as const;
export type FreshRuneStage=typeof freshRuneStages[number];
const checkpoints=['interrupted.sav','first-bank.sav','after.sav','higher.sav'] as const;
type Binding={name:string;source:string;files:Record<string,string>;identity:string;configuration:{server:string;tickMs:number;xpRate:number;content:string}};
type StageRecord={stage:FreshRuneStage;binding:Binding;previous:string|null;inputHash:string|null;output:string;outputHash:string;
 evidence:Record<string,string>;codes:Record<string,number>;checks:Record<string,boolean>;at:number};
const stageFile=(stage:FreshRuneStage)=>`stage-${stage}.json`;
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const readRun=(directory:string,label:string,code:number):Run=>({code,log:readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8')});
// Hash the installed engine, packed collision/content and pinned script inputs.
// Mutable saves, databases, logs and credentials are excluded from this stamp.
function freshRuneServerHash(tickMs=150){
 const digest=createHash('sha256');
 const walk=(path:string)=>{for(const entry of readdirSync(join(root,path),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['node_modules','.git'].includes(entry.name))continue;
  const file=path+'/'+entry.name;
  if(entry.isSymbolicLink())throw Error('linked server input unsupported: '+file);
  if(entry.isDirectory())walk(file);else digest.update(file+'\0').update(readFileSync(join(root,file))).update('\0');
 }};
 for(const path of ['vendor/rs-sdk/server/engine/src','vendor/rs-sdk/server/engine/data/pack/server','vendor/rs-sdk/server/content/scripts','vendor/rs-sdk/server/content/maps','vendor/rs-sdk/server/gateway'])walk(path);
 for(const path of ['vendor/rs-sdk/server/engine/package.json','vendor/rs-sdk/server/engine/bun.lock'])digest.update(path+'\0').update(readFileSync(join(root,path)));
 for(const path of ['vendor/rs-sdk/server/engine/data/config/world.json','vendor/rs-sdk/server/engine/.env'])
  digest.update(path+'\0').update(existsSync(join(root,path))?hash(join(root,path)):'absent');
 const environment={...process.env,NODE_TICKRATE:String(tickMs),NODE_XPRATE:'25',WEB_PORT:'8888',GATEWAY_HOSTNAME:'127.0.0.1',AGENT_PORT:'7780'};
 // Only a digest is published. Configuration secrets must never enter evidence.
 for(const key of Object.keys(environment).filter(k=>/^(NODE_|WEB_|ENGINE_|LOGIN_|FRIEND_|LOGGER_|CACHE_|GE_|GATEWAY_|AGENT_PORT$|EASY_STARTUP$|WEBSITE_REGISTRATION$)/.test(k)).sort())
  digest.update(key+'\0').update(environment[key as keyof typeof environment]??'').update('\0');
 return digest.digest('hex');
}
function freshRuneBinding(name:string,tickMs=150):Binding{
 const env=join(root,'vendor/rs-sdk/bots',name,'bot.env');
 if(!/^[a-z0-9]{1,12}$/i.test(name)||!existsSync(env)||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(env,'utf8')))
  throw Error('stage requires the same retained local account; no registration on restart');
 if(existsSync(join(root,'.practice',`stop-${name}`)))throw Error('preserve account stop file');
 return {name,source:workerSourceRevision(),files:sources(),identity:hash(env),
  configuration:{server:'localhost:8888',tickMs,xpRate:25,content:freshRuneServerHash(tickMs)}};
}
const engineSave=(name:string)=>join(root,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');

// Read-only chain validation. Check every preceding receipt, save and log before
// acquiring a stack or logging in. An attempt without publication is a failure,
// never permission to replay. The harness retains that first boundary.
export function freshRuneStageInput(directory:string,stage:FreshRuneStage,binding:Binding,currentSave:string,ownedAttempt=false){
 const index=freshRuneStages.indexOf(stage);
 if(index<0)throw Error('unknown fresh rune stage');
 if(existsSync(join(directory,'native.json')))throw Error('completed native proof; refuse duplicate stage');
 for(let i=index;i<freshRuneStages.length;i++){
  const file=stageFile(freshRuneStages[i]!);
  if(existsSync(join(directory,file))||(!(ownedAttempt&&i===index)&&existsSync(join(directory,file+'.attempt'))))throw Error('duplicate or out-of-order stage; retain first attempt');
 }
 const fixture=json(join(directory,'fixture.json'));
 if(fixture.name!==binding.name||fixture.saveAbsent!==true||fixture.credentialsAbsent!==true)throw Error('stage account/default fixture binding changed');
 const chain=freshRunePublishedStages(directory,binding,index);
 if(index>0&&(!existsSync(currentSave)||hash(currentSave)!==chain.inputHash))throw Error('engine save differs from prior checkpoint; never restore or reseed');
 return chain;
}
export function freshRunePublishedStages(directory:string,binding:Binding,count=4){
 let previous:string|null=null,inputHash:string|null=null;
 const records:StageRecord[]=[];
 for(let i=0;i<count;i++){
  const record:StageRecord=json(join(directory,stageFile(freshRuneStages[i]!)));
  if(record.stage!==freshRuneStages[i]||!same(record.binding,binding)||record.previous!==previous||record.inputHash!==inputHash
   ||record.output!==checkpoints[i]||record.outputHash!==hash(join(directory,checkpoints[i]!))
   ||!Object.keys(record.checks).length||!Object.values(record.checks).every(v=>v===true)
   ||!Object.keys(record.evidence).length||!Object.entries(record.evidence).every(([p,h])=>hash(join(directory,p))===h))
   throw Error('stale stage source/account/configuration/save/evidence binding');
  records.push(record);previous=hash(join(directory,stageFile(freshRuneStages[i]!)));inputHash=record.outputHash;
 }
 return {previous,inputHash,records};
}

export function freshRuneStageWorker(stage:Exclude<FreshRuneStage,'start'>,name:string,deadline:number,now=Date.now()){
 const label=stage==='target'?'resume':stage==='first-bank'?'first-bank':'higher';
 const timeoutMs=freshRuneChildTimeout(label,deadline,now);
 // Leave30s inside the child wall envelope for opening and the owner's logout.
 const cap=Math.floor((timeoutMs-30000)/150);
 if(cap<1)throw Error('no finite tick budget with logout reserve');
 return {label,args:['scripts/rune-supply.ts',name,String(stage==='first-bank'?2:stage==='target'?20:21)],env:{CAP:String(cap)},timeoutMs};
}

function stagedChecks(directory:string,stage:FreshRuneStage,codes:Record<string,number>){
 const before=readPracticeSave(join(directory,'before.sav')),interrupted=readPracticeSave(join(directory,'interrupted.sav'));
 const first=readRun(directory,'interrupted',codes.interrupted!);
 if(stage==='start')return {defaultSkills:freshRuneDefaultSkills(before),defaultQuest:(before.vars[63]??0)===0&&(before.vars[101]??0)===0,
  noSeededEssence:sum(before,1436)===0&&sum(before,7936)===0,registration:codes.registration===0&&logout(readRun(directory,'registration',codes.registration)),
  stopped:freshRuneSupportedInterruption(first),progress:retainedProgress(before,interrupted),logout:logout(first)};
 const bank=readRun(directory,'first-bank',codes['first-bank']!);
 const target=stage==='first-bank'?2:stage==='target'?20:21;
 const resume=stage==='first-bank'?bank:readRun(directory,stage==='target'?'resume':'higher',codes[stage==='target'?'resume':'higher']!);
 const additional=stage==='first-bank'?[]:stage==='target'?[bank]:[bank,readRun(directory,'resume',codes.resume!)];
 const after=readPracticeSave(join(directory,checkpoints[freshRuneStages.indexOf(stage)]!));
 const checks:Record<string,boolean>=freshRuneSupplyChecks({before,interrupted,after,first,resume,additional,xpRate:25,target});
 if(stage!=='first-bank'){
  const prior=readPracticeSave(join(directory,stage==='target'?'first-bank.sav':'after.sav')),result=summary(resume);
  const used=(after.skills[20]!.rawExperience-prior.skills[20]!.rawExperience)/1250;
  const mined=(after.skills[14]!.rawExperience-prior.skills[14]!.rawExperience)/1250;
  const productive=after.skills[20]!.xp>prior.skills[20]!.xp&&sum(after,556,95)>sum(prior,556,95);
  // At25x the first26 essence already reach20 on the pinned flatter curve.
  // Still run the target20 CLI; its valid no-op must preserve every saved asset/XP.
  const alreadyTarget=stage==='target'&&prior.skills[20]!.level>=20&&after.skills.every((s,i)=>s.rawExperience===prior.skills[i]!.rawExperience)
   &&same(assets(prior),assets(after))&&result?.crafted===0&&result?.consumed===0&&result?.mined===0;
  checks.continuation=(productive||alreadyTarget)
   &&sum(after,556,95)-sum(prior,556,95)===result?.crafted&&result?.banked===result?.crafted
   &&result?.consumed===used&&result?.mined===mined&&mined===used+sum(after,1436)-sum(prior,1436)
   &&after.vars[63]===prior.vars[63]&&after.vars[101]===prior.vars[101]&&runeSupplyPreserved(assets(prior),assets(after));
  checks.noRepeatedPreparation=!result?.stages?.training&&!result?.stages?.food&&!result?.stages?.quest&&!result?.stages?.questExit
   &&! /MILESTONE training|STARTER_COOKING_RESULT/.test(resume.log);
 }
 return checks;
}

export function freshRuneSavedResult(save:Save,run:Run){
 if(summary(run)?.stages?.food?.settlement==='unresolved')return false;
 const final=summary(run)?.final;
 if(!final||final.skills?.length!==save.skills.length||!Array.isArray(final.inventory)||!Array.isArray(final.equipment))return false;
 const totals=(items:{id:number;count:number}[])=>items.reduce((a,i)=>{a[i.id]=(a[i.id]??0)+i.count;return a;},{} as Record<number,number>);
 const equalItems=(a:Record<number,number>,b:Record<number,number>)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(id=>(a[Number(id)]??0)===(b[Number(id)]??0));
 // Pinned UpdateStatEncoder sends (exp / 10) | 0. Compare that whole-XP
 // projection only here; raw saved tenths remain authoritative for effects.
 return save.skills.every((s,i)=>Math.trunc(s.rawExperience/10)===final.skills[i].experience&&s.level===final.skills[i].level)
  &&equalItems(totals(save.inventories[93]??[]),totals(final.inventory))&&equalItems(totals(save.inventories[94]??[]),totals(final.equipment));
}
const stageDeps={stack:withFreshRuneStack,binding:freshRuneBinding,save:engineSave,create:createBot,name:()=>runBotName('flrune',1),command:freshRuneCommand,wait:waitPracticeSave,verify:verifyFreshRuneSupply,recovery:verifyFreshRuneAirRecovery};
export async function proveFreshRuneStage(directory:string,stage:FreshRuneStage,deps=stageDeps){
 if(!deps.recovery(directory).ok)throw Error('air recovery gate failed; no full replay');
 mkdirSync(directory,{recursive:true});
 let binding:Binding|undefined;
 if(stage==='start'){
  if(['fixture.json','before.sav','native.json',...freshRuneStages.flatMap(s=>[stageFile(s),stageFile(s)+'.attempt'])].some(p=>existsSync(join(directory,p))))
   throw Error('retain existing identity and stage attempts; use a new delivery directory');
 }else{
  binding=deps.binding(json(join(directory,'fixture.json')).name);
  freshRuneStageInput(directory,stage,binding,deps.save(binding.name));
 }
 writeFileSync(join(directory,stageFile(stage)+'.attempt'),JSON.stringify({stage,at:Date.now(),binding}),{flag:'wx'});
 const evidenceDir=join(directory,'stack-'+stage);mkdirSync(evidenceDir,{recursive:true});
 const record=await deps.stack(evidenceDir,async budget=>{
  let input:{previous:string|null;inputHash:string|null;records:StageRecord[]}={previous:null,inputHash:null,records:[]};
  if(stage==='start'){
   const name=deps.name(),save=deps.save(name),botDir=join(root,'vendor/rs-sdk/bots',name);
   if(existsSync(save)||existsSync(botDir))throw Error('genuine unclaimed default fixture required');
   writeFileSync(join(directory,'fixture.json'),JSON.stringify({name,saveAbsent:true,credentialsAbsent:true}),{flag:'wx'});
   await deps.create(name);binding=deps.binding(name);
  }else{
   if(!same(binding,deps.binding(binding!.name)))throw Error('stage binding changed during admission');
   input=freshRuneStageInput(directory,stage,binding!,deps.save(binding!.name),true);
  }
  const save=deps.save(binding!.name),codes={...input.records.at(-1)?.codes};
  const command=async(label:string,args:string[],env:Record<string,string>={})=>codes[label]=await deps.command(directory,budget,label,args,save,env);
  if(stage==='start'){
   if(await command('registration',['packages/practice/src/register-proof-account.ts',binding!.name])!==0)throw Error('default registration failed');
   const observed=await deps.wait(save,s=>freshRuneDefaultSkills(s)&&(s.vars[63]??0)===0&&(s.vars[101]??0)===0&&sum(s,1436)===0&&sum(s,7936)===0);
   copyFileSync(save,join(directory,'before.sav'));if(!observed.matched)throw Error('default registration save unobserved');
   await command('interrupted',['scripts/rune-supply.ts',binding!.name,'20'],{CAP:'1000'});
  }else{
   const worker=freshRuneStageWorker(stage,binding!.name,budget.deadline);
   if(await command(worker.label,worker.args,worker.env)!==0){copyFileSync(save,join(directory,worker.label+'-failed.sav'));throw Error('stage worker failed; retain first boundary');}
  }
  const output=checkpoints[freshRuneStages.indexOf(stage)]!;
  const label=stage==='start'?'interrupted':stage==='target'?'resume':stage,run=readRun(directory,label,codes[label]!);
  const observed=await deps.wait(save,s=>freshRuneSavedResult(s,run)&&(stage==='start'?retainedProgress(readPracticeSave(join(directory,'before.sav')),s)
   :(s.skills[20]?.level??0)>=(stage==='first-bank'?2:stage==='target'?20:21)&&sum(s,556,93)===0));
  copyFileSync(save,join(directory,output));
  if(!observed.matched)throw Error('stage checkpoint publication unobserved; retain save');
  const checks=stagedChecks(directory,stage,codes);
  checks.savedResult=freshRuneSavedResult(readPracticeSave(join(directory,output)),run);
  checks.source=same(binding,deps.binding(binding!.name));
  if(!Object.values(checks).every(Boolean))throw Error('stage predicates failed: '+JSON.stringify(checks));
  const labels=stage==='start'?['registration','interrupted']:[stage==='target'?'resume':stage];
  const paths=['fixture.json',...(stage==='start'?['before.sav']:[]),output,...labels.flatMap(l=>[l+'.log',l+'.err',l+'-outcome.json'])];
  return {stage,binding:binding!,previous:input.previous,inputHash:input.inputHash,output,outputHash:hash(join(directory,output)),
   evidence:Object.fromEntries(paths.map(p=>[p,hash(join(directory,p))])),codes,checks,at:Date.now()} satisfies StageRecord;
 });
 // Publish only after the owned stack has stopped and released its lock.
 writeFileSync(join(directory,stageFile(stage)),JSON.stringify(record,null,2),{flag:'wx'});
 if(stage==='higher'){
  const meta={at:Date.now(),source:record.binding.source,files:record.binding.files,name:record.binding.name,saveAbsent:true,credentialsAbsent:true,
   registrationCode:record.codes.registration,codes:record.codes,tickMs:150,xpRate:25,staged:true,
   hashes:Object.fromEntries(['before.sav',...checkpoints].map(p=>[p,hash(join(directory,p))]))};
  writeFileSync(join(directory,'native.json'),JSON.stringify(meta,null,2),{flag:'wx'});
  return deps.verify(directory);
 }
 return {ok:true,stage,checkpoint:record.output,hash:record.outputHash};
}

export function verifyFreshRuneSupply(directory:string,deps={binding:freshRuneBinding,source:workerSourceRevision,files:sources,recovery:verifyFreshRuneAirRecovery}){
 const recovery=deps.recovery(directory);
 const meta=JSON.parse(readFileSync(join(directory,'native.json'),'utf8'));
 const run=(label:string):Run=>({code:meta.codes[label],log:readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8')});
 let stageChecks:Record<string,boolean>={};
 if(meta.staged){
  const chain=freshRunePublishedStages(directory,deps.binding(meta.name));
  stageChecks={stageChain:chain.records.length===4&&chain.records.every(r=>same(r.codes,Object.fromEntries(Object.keys(r.codes).map(k=>[k,meta.codes[k]])))),
   ...Object.fromEntries(chain.records.map(r=>{
    const labels=r.stage==='start'?['registration','interrupted']:[r.stage==='target'?'resume':r.stage];
    const label=labels.at(-1)!;
    return [r.stage,Object.values(stagedChecks(directory,r.stage,r.codes)).every(Boolean)
     &&freshRuneSavedResult(readPracticeSave(join(directory,r.output)),run(label))
     &&labels.every(l=>{const outcome=json(join(directory,l+'-outcome.json'));return outcome.code===r.codes[l]&&outcome.failure==='';})];
   }))};
 }
 const checks={...freshRuneSupplyChecks({before:readPracticeSave(join(directory,'before.sav')),interrupted:readPracticeSave(join(directory,'interrupted.sav')),after:readPracticeSave(join(directory,'after.sav')),first:run('interrupted'),resume:run('resume'),additional:meta.staged?[run('first-bank')]:[],xpRate:meta.xpRate,target:20}),
  ...stageChecks,airRecovery:recovery.ok,...Object.fromEntries(Object.entries(recovery.checks).map(([k,v])=>['airRecovery-'+k,v])),
  source:meta.source===deps.source()&&JSON.stringify(meta.files)===JSON.stringify(deps.files()),
  registration:meta.saveAbsent===true&&meta.credentialsAbsent===true&&meta.registrationCode===0&&logout(run('registration')),
  configuration:meta.tickMs===150&&meta.xpRate===25,
  snapshots:['before.sav','interrupted.sav',...(meta.staged?['first-bank.sav']:[]),'after.sav','higher.sav'].every(p=>meta.hashes[p]===hash(join(directory,p))),
 };
 const later=readPracticeSave(join(directory,'higher.sav')),higher=run('higher'),b=summary(higher),prior=readPracticeSave(join(directory,'after.sav'));
 const report={ok:Object.values(checks).every(Boolean)&&higher.code===0&&b?.ok===true&&later.skills[20]!.level>=21&&later.skills[20]!.xp>prior.skills[20]!.xp&&sum(later,556,95)>sum(prior,556,95)&&runeSupplyPreserved(assets(prior),assets(later))&&logout(higher),checks,at:Date.now(),source:meta.source,
  scope:'Native default registration, installed CLI interruption/resume to20 and finite continuation to21. Server stays owned by the harness. No live release or unattended claim.'};
 return report;
}
export async function proveFreshRuneSupply(directory:string){
 if(!verifyFreshRuneAirRecovery(directory).ok)throw Error('air recovery gate failed; no full replay');
 mkdirSync(directory,{recursive:true});
 if(existsSync(join(directory,'native.json'))||existsSync(join(directory,'before.sav')))throw Error('retain existing proof; use a new delivery directory');
 return withFreshRuneStack(directory,async budget=>{
 const name=runBotName('flrune',1),botDir=join(root,'vendor/rs-sdk/bots',name),save=join(root,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
 const saveAbsent=!existsSync(save),credentialsAbsent=!existsSync(botDir);if(!saveAbsent||!credentialsAbsent)throw Error('genuine unclaimed default fixture required');
 writeFileSync(join(directory,'fixture.json'),JSON.stringify({name,saveAbsent,credentialsAbsent}),{flag:'wx'});
 budget.check();
 await createBot(name);
 if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
 const codes:Record<string,number>={};
 const command=async(label:string,args:string[],env:Record<string,string>={})=>{
  codes[label]=await freshRuneCommand(directory,budget,label,args,save,env);
  return codes[label]!;
 };
 const source=workerSourceRevision(),files=sources();
 // The registration helper only logs in and out. The server creates the initial save.
 const registrationCode=await command('registration',['packages/practice/src/register-proof-account.ts',name]);
 if(registrationCode!==0)throw Error('normal registration failed; retain registration logs');
 await waitPracticeSave(save,()=>true);copyFileSync(save,join(directory,'before.sav'));
 const before=readPracticeSave(save);
 if(!freshRuneDefaultSkills(before)||(before.vars[63]??0)!==0||(before.vars[101]??0)!==0||sum(before,1436)>0||sum(before,7936)>0)throw Error('registration was not default; do not seed a replacement');
 const interruptedCode=await command('interrupted',['scripts/rune-supply.ts',name,'20'],{CAP:'1000'});
 await waitPracticeSave(save,()=>true);copyFileSync(save,join(directory,'interrupted.sav'));
 const interrupted={code:interruptedCode,log:readFileSync(join(directory,'interrupted.log'),'utf8')+readFileSync(join(directory,'interrupted.err'),'utf8')};
 if(!freshRuneSupportedInterruption(interrupted)||!retainedProgress(before,readPracticeSave(join(directory,'interrupted.sav')))||!logout(interrupted))
  throw Error('unexpected interruption boundary; retain interrupted save and logs, no resume');
 const resumeCode=await command('resume',['scripts/rune-supply.ts',name,'20'],{CAP:'30000'});
 if(resumeCode!==0){copyFileSync(save,join(directory,'resume-failed.sav'));throw Error('fresh rune resume failed; inspect resume.log and resume.err before any further run');}
 const resumed=await waitPracticeSave(save,s=>(s.skills[20]?.level??0)>=20);copyFileSync(save,join(directory,'after.sav'));
 if(!resumed.matched)throw Error('resume target save not observed; retain after.sav, no higher run');
 const higherCode=await command('higher',['scripts/rune-supply.ts',name,'21'],{CAP:'10000'});
 if(higherCode!==0){copyFileSync(save,join(directory,'higher-failed.sav'));throw Error('fresh rune higher target failed; retain first boundary');}
 const higher=await waitPracticeSave(save,s=>(s.skills[20]?.level??0)>=21);copyFileSync(save,join(directory,'higher.sav'));
 if(!higher.matched)throw Error('higher target save not observed; retain higher.sav');
 writeFileSync(join(directory,'native.json'),JSON.stringify({at:Date.now(),source,files,name,saveAbsent,credentialsAbsent,registrationCode,codes,tickMs:150,xpRate:25,
  hashes:Object.fromEntries(['before.sav','interrupted.sav','after.sav','higher.sav'].map(p=>[p,hash(join(directory,p))]))},null,2));
 const report=verifyFreshRuneSupply(directory);writeFileSync(join(directory,'consumer.json'),JSON.stringify(report,null,2));return report;
 });
}
if(import.meta.main){
 try{
  if(!process.env.DELIVERY_DIR)throw Error('harness must set DELIVERY_DIR');
  const directory=resolve(process.env.DELIVERY_DIR);
  const stage=freshRuneStages.find(s=>process.argv[2]==='--stage-'+s);
  const report=process.argv[2]==='--air-recovery'?await proveFreshRuneAirRecovery(directory):stage?await proveFreshRuneStage(directory,stage):process.argv[2]==='--verify'?verifyFreshRuneSupply(directory):process.argv[2]==='--diagnose-essence'
   ?await diagnoseFreshRuneEssence(directory,process.argv[3]??'',resolve(process.argv[4]??'')):process.argv[2]==='--diagnose-cooking'
   ?await diagnoseFreshRuneCooking(directory,process.argv[3]??'',resolve(process.argv[4]??'')):await proveFreshRuneSupply(directory);
  console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;
 }catch(error){console.error(String(error));process.exitCode=1;}
}
