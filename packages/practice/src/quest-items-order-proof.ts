// Harness-owned native execution. Importing this module never starts a server or logs in.
import {readFileSync,writeFileSync,copyFileSync,existsSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {startStack} from './stack';
import {createBot} from './bots';
import {runBotName} from './prove';
import {killTree} from './proc';
import {workerSourceRevision} from '../../core/src/worker-release';
import {readPracticeSave,waitPracticeSave,setPracticeSkills} from '../../../scripts/measure/fleet-player-save';
import {questSpec,questSavedChecks} from '../../../scripts/quest-order';
import {itemSaveChecks} from '../../../scripts/quest-items-order';
import { FREE_FLOOR_GB, PRACTICE_RESERVE_GB, PRACTICE_STARTUP_GB } from '../../core/src/memory';
import {applyPreset,type SaveConfig} from './presets';
type Save=ReturnType<typeof readPracticeSave>;
type Run={code:number;log:string};
export function parseItemResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_ITEMS_ORDER_RESULT ')).at(-1)?.slice(25)??'null');}catch{return null;}}
export function parseCookJobResult(log:string){try{return JSON.parse(log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_COOK_JOB_RESULT ')).at(-1)?.slice('QUEST_COOK_JOB_RESULT '.length)??'null');}catch{return null;}}
const logout=(r:Run,n=1)=>(r.log.match(/^LOGOUT logged-out$/gm)??[]).length===n&&!/^WARN .*?(?:logout|session close)/m.test(r.log);
// The v6 fixture generator defaults all varps to 0. Player.ts constructor uses -1
// for non-INT types; PlayerLoading.load overlays only saved varps and Player.save
// omits zeros. Seed these permanent typed nulls so a second login cannot change
// their representation. Names/types: content/pack/varp.pack and the corresponding
// content/scripts configs: ownedmcannon, beehive_free, hemenster_pipe_stashed,
// arhein_crate_coord, ikov_icearrowchest_coord, exit_essence_mine_coord,
// fluffs_crate, macro_event_target_coord. Keep these varps in strict equality.
export const COOK_JOB_NATIVE_NULL_VARPS:Readonly<Record<number,number>>={4:-1,9:-1,13:-1,16:-1,28:-1,64:-1,181:-1,209:-1};
export function cookLiveRepeatSavedChecks(before:Save,after:Save,worker:Run){
 const result=parseCookJobResult(worker.log);
 // Pinned content/pack/varp.pack:134=last_logout. The sole excluded varp is
 // written by content/scripts/login_logout/logout.rs2 [logout,_]:
 // %last_logout = map_clock; even a refused zero-action session logs out.
 const vars=(s:Save)=>Object.fromEntries(Object.entries(s.vars).filter(([id])=>Number(id)!==134));
 return {
  refusal:worker.code!==0&&result?.ok===false&&/quest already complete/.test(result?.detail??'')&&logout(worker),
  assets:[93,94,95].every(id=>JSON.stringify(before.inventories[id]??[])===JSON.stringify(after.inventories[id]??[])),
  vars:JSON.stringify(vars(before))===JSON.stringify(vars(after)),
  skills:JSON.stringify(before.skills)===JSON.stringify(after.skills),
 };
}
export function cookLiveJobSavedChecks(before:Save,after:Save,worker:Run){
 const result=parseCookJobResult(worker.log),spec=questSpec('cook');
 const holdings=(s:Save)=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 const total=(s:Save,id:number)=>holdings(s).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const changed=new Set([1944,1927,1933,1925,1931,1947]);
 const ids=new Set([...holdings(before),...holdings(after)].map(i=>i.id));
 const xp=(s:Save)=>s.skills.find(k=>k.index===7)?.xp;
 return {
  worker:worker.code===0&&result?.ok===true&&result?.logout===true&&result?.gather?.ok===true&&result?.quest?.ok===true&&!!result?.checks&&Object.values(result.checks).length>0&&Object.values(result.checks).every(v=>v===true)&&logout(worker),
  entry:(before.vars[spec.varpId]??0)<spec.complete,
  quest:after.vars[spec.varpId]===spec.complete,
  questPoints:(after.vars[spec.qpVarpId]??0)===(before.vars[spec.qpVarpId]??0)+spec.questPoints,
  // This harness starts the pinned 25x native stack; it does not infer reward from a worker report.
  reward:xp(before)!==undefined&&xp(after)===xp(before)!+7500,
  ingredients:[1944,1927,1933].every(id=>total(after,id)===Math.max(0,total(before,id)-1)),
  containers:[[1927,1925],[1933,1931]].every(([product,container])=>total(after,container!)===total(before,container!)-(total(before,product!)>0?0:1)),
  grain:total(after,1947)>=Math.max(0,total(before,1947)-1)&&total(after,1947)<=Math.max(1,total(before,1947)),
  assets:[...ids].filter(id=>!changed.has(id)).every(id=>total(before,id)===total(after,id)),
  equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
 };
}
export function questItemsConsumerChecks(before:Save,gathered:Save,after:Save,worker:Run,consumer:Run){
 const result=parseItemResult(worker.log);
 const holdings=(s:Save)=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 const assets=new Set([...holdings(gathered),...holdings(after)].map(i=>i.id).filter(id=>![1944,1927,1933].includes(id)));
 const total=(s:Save,id:number)=>holdings(s).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 let quest:any=null;try{quest=JSON.parse(consumer.log.split(/\r?\n/).filter(l=>l.startsWith('QUEST_ORDER_RESULT ')).at(-1)?.slice(19)??'null');}catch{}
 return{
  gathered:Object.values(itemSaveChecks('cook',before,gathered)).every(Boolean),
  acquired:(before.inventories[93]??[]).concat(before.inventories[95]??[]).every(i=>![1944,1927,1933].includes(i.id)),
  worker:worker.code===0&&result?.ok===true&&result?.logout===true&&result?.child?.ok===true&&logout(worker),
  consumer:consumer.code===0&&quest?.ok===true&&quest?.stages?.quest?.ok===true&&quest?.stages?.bank?.ok===true&&logout(consumer,2),
  quest:Object.values(questSavedChecks(questSpec('cook'),gathered,after)).every(Boolean),
  assets:[...assets].every(id=>total(gathered,id)===total(after,id)),
  equipment:JSON.stringify(gathered.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
 };
}
const hash=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
// The saved check computes costs from the entry holdings, independently of the worker's checks.
export function hettyLiveJobSavedChecks(before:Save,after:Save,worker:Run){
 const result=parseCookJobResult(worker.log),spec=questSpec('hetty');
 const holdings=(s:Save)=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 const total=(s:Save,id:number)=>holdings(s).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const b=(id:number)=>total(before,id),a=(id:number)=>total(after,id);
 const ids=new Set([...holdings(before),...holdings(after)].map(i=>i.id));
 const meat=[2146,2142,2132].find(id=>b(id)>0),eye=b(221)?0:1;
 const xp=(s:Save)=>s.skills.find(k=>k.index===6)?.xp;
 const prices=result?.gather?.purchases as {id:number;coins:number}[]|undefined;
 return {
  worker:worker.code===0&&result?.ok===true&&result?.questKey==='hetty'&&result?.logout===true&&result?.gather?.ok===true&&result?.quest?.ok===true&&logout(worker),
  bounded:Number.isSafeInteger(result?.ticks)&&result.ticks<=6000,
  entry:(before.vars[spec.varpId]??0)===0,
  quest:after.vars[spec.varpId]===spec.complete,
  questPoints:(after.vars[spec.qpVarpId]??0)===(before.vars[spec.qpVarpId]??0)+1,
  reward:xp(before)!==undefined&&xp(after)===xp(before)!+8125,
  magic31:before.skills.find(k=>k.index===6)?.level===1&&after.skills.find(k=>k.index===6)?.level===31,
  ingredients:[1957,221,300].every(id=>a(id)===Math.max(0,b(id)-1))&&[2146,2142,2132].every(id=>a(id)===b(id)-(id===meat?1:0)),
  coins:a(995)===b(995)-eye*3-(meat?0:1),
  purchases:Array.isArray(prices)&&prices.length===eye+(meat?0:1)&&prices.filter(p=>p.id===221&&p.coins===3).length===eye&&prices.filter(p=>p.id===2132&&p.coins===1).length===(meat?0:1),
  transitions:!!meat&&meat===2146||Array.isArray(result?.gather?.transitions)&&(
   JSON.stringify(result.gather.transitions)===JSON.stringify([{from:meat??2132,to:2146}])||
   (meat===undefined||meat===2132)&&JSON.stringify(result.gather.transitions)===JSON.stringify([{from:2132,to:2142},{from:2142,to:2146}])),
  assets:[...ids].filter(id=>![995,1957,221,300,2146,2142,2132].includes(id)).every(id=>a(id)===b(id)),
  equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0&&result?.checks?.alive===true&&result?.before?.lifeId===result?.after?.lifeId&&result?.before?.respawns===result?.after?.respawns,
 };
}
// Player.ts getExpByLevel(10)=9800 tenths. No fixture level or XP is supplied.
const defaultSkills=(s:Save)=>s.skills.length===21&&s.skills.every((k,i)=>k.index===i&&(i===3?k.level===10&&k.xp===980&&k.rawExperience===9800:k.level===1&&k.xp===0&&k.rawExperience===0));
// Player.ts constructs an ordinary account at the Tutorial Island start; registration
// does not complete it. Varp281 (content/pack/varp.pack) is tutorial, complete at1000.
export function hettyRegisteredEntry(s:Save){
 return defaultSkills(s)&&(s.vars[67]??0)===0&&(s.vars[101]??0)===0&&(s.vars[281]??0)<1000&&
  [93,94,95].every(id=>(s.inventories[id]??[]).length===0)&&
  s.position.level===0&&s.position.x>=3080&&s.position.x<=3105&&s.position.z>=3080&&s.position.z<=3125;
}
export function hettyMainlandReady(s:Save){
 const all=[...(s.inventories[93]??[]),...(s.inventories[95]??[])];
 return defaultSkills(s)&&(s.vars[67]??0)===0&&(s.vars[101]??0)===0&&
  !all.some(i=>[1957,221,2146,2132,2142,300].includes(i.id))&&
  all.filter(i=>i.id===995).reduce((n,i)=>n+i.count,0)===25&&all.some(i=>i.id===1277)&&
  s.position.level===0&&Math.max(Math.abs(s.position.x-3222),Math.abs(s.position.z-3218))<=10;
}
// Pinned content/scripts/tutorial/scripts/tutorial.rs2 [label,tutorial_complete]
// clears inv, worn and bank, adds this pack kit and banks25 coins.
export const HETTY_TUTORIAL_GRANT={
 pack:[[1351,1],[590,1],[303,1],[315,1],[1925,1],[1931,1],[2309,1],[1265,1],[1205,1],[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[555,6],[557,4],[559,2]],
 bank:[[995,25]],
} as const;
export function tutorialGrantedSave(s:Save):Save{
 const items=(list:readonly (readonly [number,number])[])=>list.map(([id,count],slot)=>({slot,id,count}));
 return {...s,inventories:{...s.inventories,93:items(HETTY_TUTORIAL_GRANT.pack),94:[],95:items(HETTY_TUTORIAL_GRANT.bank)}} as Save;
}
// The tutorial grant is reconciled first. Quest spending is then checked against the granted holdings.
export function hettyTutorialJobSavedChecks(before:Save,after:Save,worker:Run){
 return {tutorialEntry:(before.vars[281]??0)<1000,tutorial:after.vars[281]===1000,...hettyLiveJobSavedChecks(tutorialGrantedSave(before),after,worker)};
}
// Retained QUEST_HETTY_ENTRY: exact ordered pack, bank and worn kit. Staging is
// confined to a fresh localhost fixture; the worker receives only account + hetty.
export const HETTY_MATCHED_ENTRY:SaveConfig={
 position:{x:3209,z:3214,level:0},
 inventory:[[995,1902],[1963,1],[1963,1],[1963,1],[1985,1],[1985,1],[1985,1],[556,6],[557,1],[1438,1],[2132,1],[279,1],[1931,1],[1931,1],[1931,1],[952,1],[307,1],[313,2],[1468,1],[596,1],[1469,1]].map(([id,count])=>({id:id!,count:count!})),
 bank:[[995,15606],[1351,4],[590,40],[303,4],[315,3],[1925,3],[1931,4],[1265,40],[1205,4],[1277,3],[1171,3],[841,5],[882,1710],[556,88],[558,60],[555,18],[557,9],[559,8],[1901,4],[1891,1],[333,11],[329,6],[1779,1791],[227,939],[1759,142],[954,143],[970,41],[1349,36],[2309,1]].map(([id,count])=>({id:id!,count:count!})),
 equipment:[{id:284,count:1,slot:4},{id:285,count:1,slot:7}],
 // Login runs quests.rs2 ~update_questlist, which recounts %qp(101) from quest varps.
 // Moneyshot's six QP: cookquest29=2, runemysteries63=6, sheep179=22, murderquest192=2 (3QP).
 varps:{...COOK_JOB_NATIVE_NULL_VARPS,281:1000,29:2,63:6,179:22,192:2,67:0,101:6},
};
const HETTY_COMPLETED_QUEST_VARPS=[29,63,179,192] as const;
export function hettyCarriedEntry(s:Save){
 const items=(rows:{id:number;count:number}[])=>rows.map((i,slot)=>({slot,id:i.id,count:i.count}));
 const ordered=(rows:{slot:number;id:number;count:number}[]|undefined)=>(rows??[]).map(i=>({slot:i.slot,id:i.id,count:i.count}));
 const exact=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 return s.vars[281]===1000&&(s.vars[67]??0)===0&&s.vars[101]===6&&
  HETTY_COMPLETED_QUEST_VARPS.every(id=>s.vars[id]===HETTY_MATCHED_ENTRY.varps![id])&&
  s.skills.find(k=>k.index===6)?.xp===0&&s.skills.find(k=>k.index===6)?.level===1&&
  s.skills.find(k=>k.index===3)?.level===10&&s.skills.find(k=>k.index===7)?.xp===7500&&
  exact(s.position,HETTY_MATCHED_ENTRY.position)&&
  exact(ordered(s.inventories[93]),items(HETTY_MATCHED_ENTRY.inventory!))&&
  exact(ordered(s.inventories[95]),items(HETTY_MATCHED_ENTRY.bank!))&&
  exact(ordered(s.inventories[94]),ordered(HETTY_MATCHED_ENTRY.equipment));
}
function verify(dir:string){
 const meta=JSON.parse(readFileSync(join(dir,'native.json'),'utf8'));
 const run=(label:string):Run=>({code:meta.codes[label],log:readFileSync(join(dir,label+'.log'),'utf8')+readFileSync(join(dir,label+'.err'),'utf8')});
 const save=(label:string)=>readPracticeSave(join(dir,label+'.sav'));
 const b=save('before'),a=save('after'),r=run('job'),refusal=run('refusal'),f=save('refusal-after'),refused=parseCookJobResult(refusal.log);
 const vars=(s:Save)=>Object.fromEntries(Object.entries(s.vars).filter(([id])=>Number(id)!==134));
 const entry=save('carried-entry');
 const deposits=r.log.split(/\r?\n/).filter(l=>l.startsWith('DEPOSIT_RECEIPT ')).map(l=>JSON.parse(l.slice('DEPOSIT_RECEIPT '.length)));
 const checks={...hettyLiveJobSavedChecks(b,a,r),ordinary:meta.saveAbsent===true&&meta.credentialsAbsent===true&&meta.codes.registration===0&&logout(run('registration')),
  carriedEntry:hettyCarriedEntry(b)&&hettyCarriedEntry(entry),
  carriedDeposit:deposits.some(d=>d.account.toLowerCase()===meta.name.toLowerCase()&&d.itemId===995&&d.amount===1902&&d.packBefore===1902&&d.packAfter===0&&d.bankBefore===15606&&d.bankAfter===17508&&d.generationAfter>d.generationBefore),
  refusal:refusal.code!==0&&refused?.ok===false&&refused?.logout===true&&/quest already complete/.test(refused?.detail??'')&&logout(refusal),
  refusalAssets:[93,94,95].every(id=>JSON.stringify(a.inventories[id]??[])===JSON.stringify(f.inventories[id]??[])),
  refusalVars:JSON.stringify(vars(a))===JSON.stringify(vars(f)),refusalSkills:JSON.stringify(a.skills)===JSON.stringify(f.skills),
  source:meta.source===workerSourceRevision(),fresh:Number.isFinite(meta.at)&&meta.at<=Date.now()&&Date.now()-meta.at<900000,
  artifacts:Object.entries(meta.hashes as Record<string,string>).every(([file,value])=>hash(join(dir,file))===value)};
 const report={ok:Object.values(checks).every(Boolean),at:Date.now(),source:meta.source,checks,
  scope:'Native150ms/25x: real quest-cook-job account hetty CLI from an isolated staged ordinary account matching retained pack1902/bank15606, ordered quest inventory, worn kit and entry3209,3214,0; saved Witch Potion/QP+1/Magic+8125 to31, exact costs, retained assets/life, completed refusal and logout. Live acceptance belongs to the connected finite consumer.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));return report;
}
async function run(dir:string){
 if(freemem()/2**30<PRACTICE_STARTUP_GB)throw Error(`practice needs ${FREE_FLOOR_GB}GiB floor plus ${PRACTICE_RESERVE_GB}GiB startup reserve`);
 if(!existsSync(resolve(import.meta.dir,'../../../.practice/delivery-native.lock')))throw Error('practice turn required: run through delivery');
 const lock=resolve(import.meta.dir,'../../../.practice/delivery-practice.lock'),fd=openSync(lock,'wx');
 writeFileSync(fd,JSON.stringify({pid:process.pid,task:'quest-items-order',directory:dir,at:Date.now()}));
 let stack:Awaited<ReturnType<typeof startStack>>|undefined;
 const codes:Record<string,number>={};
 const command=async(args:string[],label:string)=>{
  if(freemem()/2**30<FREE_FLOOR_GB)throw Error('practice memory floor reached');
  const child=Bun.spawn(['bun',...args],{cwd:resolve(import.meta.dir,'../../..'),env:{...process.env,DEMO_OK:'',RANDOM_EVENTS:'0',CAP:'6000'},stdout:Bun.file(join(dir,label+'.log')),stderr:Bun.file(join(dir,label+'.err')),windowsHide:true});
  let expired=false,termination:Promise<void>|undefined;
  const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},1080000);
  try{codes[label]=await child.exited;if(expired)codes[label]=-1;}finally{clearTimeout(timer);await termination;}
 };
 try{
  const source=workerSourceRevision();stack=await startStack({tickMs:150,readyTimeoutMs:60000});
  const name=runBotName('flqhjob',1),botDir=resolve(import.meta.dir,'../../../vendor/rs-sdk/bots',name);
  const path=resolve(import.meta.dir,'../../../vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');
  const saveAbsent=!existsSync(path),credentialsAbsent=!existsSync(botDir);
  if(!saveAbsent||!credentialsAbsent)throw Error('fresh ordinary unprotected fixture required');
  writeFileSync(join(dir,'fixture.json'),JSON.stringify({name,saveAbsent,credentialsAbsent}),{flag:'wx'});
  await createBot(name);
  if(!/^SERVER=localhost:8888\r?$/m.test(readFileSync(join(botDir,'bot.env'),'utf8')))throw Error('local fixture required');
  const stagedPath=await applyPreset(name,HETTY_MATCHED_ENTRY);
  if(resolve(stagedPath)!==path)throw Error('fixture save path mismatch');
  const staged=readPracticeSave(path);
  // Retained entry observes Cooking XP7500. Set exact XP only in this isolated
  // practice save, before login; Magic remains level1 with zero XP.
  setPracticeSkills(path,staged.skills.map(k=>({level:k.index===7?30:k.level,xp:k.index===7?7500:k.xp})));
  copyFileSync(path,join(dir,'staged-entry.sav'));
  if(!hettyCarriedEntry(readPracticeSave(path)))throw Error('staged matched entry invalid');
  await command(['packages/practice/src/register-proof-account.ts',name],'registration');
  if(codes.registration!==0)throw Error('ordinary fixture registration failed; retain logs');
  const entry=await waitPracticeSave(path,hettyCarriedEntry,{timeoutMs:15000});
  copyFileSync(path,join(dir,'before.sav'));copyFileSync(path,join(dir,'carried-entry.sav'));
  if(!entry.matched)throw Error('matched entry failed; retain evidence; no retry or provision');
  await command(['scripts/quest-cook-job.ts',name,'hetty'],'job');
  const worker={code:codes.job!,log:readFileSync(join(dir,'job.log'),'utf8')+readFileSync(join(dir,'job.err'),'utf8')};
  const saved=await waitPracticeSave(path,s=>Object.values(hettyLiveJobSavedChecks(entry.save,s,worker)).every(Boolean),{timeoutMs:15000});
  copyFileSync(path,join(dir,'after.sav'));
  if(codes.job!==0||!saved.matched)throw Error('Hetty CLI failed; retain logs/after.sav; no retry or provision');
  await command(['scripts/quest-cook-job.ts',name,'hetty'],'refusal');
  const flushed=await waitPracticeSave(path,s=>(s.vars[134]??0)>(saved.save.vars[134]??0),{timeoutMs:15000});copyFileSync(path,join(dir,'refusal-after.sav'));
  if(!flushed.matched)throw Error('refusal post-logout save unobserved');
  writeFileSync(join(dir,'native.json'),JSON.stringify({at:Date.now(),source,name,codes,saveAbsent,credentialsAbsent,
   hashes:Object.fromEntries(['before.sav','carried-entry.sav','after.sav','refusal-after.sav','staged-entry.sav','registration.log','registration.err','job.log','job.err','refusal.log','refusal.err'].map(p=>[p,hash(join(dir,p))]))},null,2));return verify(dir);
 }finally{try{await stack?.stop();}finally{closeSync(fd);unlinkSync(lock);}}
}
if(import.meta.main){
 try{if(!process.env.DELIVERY_DIR)throw Error('run through the delivery harness');const dir=resolve(process.env.DELIVERY_DIR);process.exitCode=(process.argv[2]==='--verify'?verify(dir):await run(dir)).ok?0:1;}
 catch(e){console.error(String(e));process.exitCode=1;}
}
