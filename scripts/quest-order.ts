// Quest order: one named generated quest (scripts/generated/quest-*.ts) for one owned account from staged pack items.
// Entry: bun scripts/quest-order.ts <account> <quest> [--save=<path>] [--timeout-ms=300000]
// --save is the account's own engine save, named <account>.sav. A finished quest or a missing item refuses before login,
// and the quest varp and quest points are confirmed in the save after the final logout. Without it the order
// refuses before login: a quest-list colour cannot prove saved quest points or a pre-login rerun refusal.
// The atomic <save>.quest-order.json retains the original baseline and child result. Only that pending order
// can resume banking for a complete quest. Settled orders refuse. Unknown completion/logout requires reconciliation.
// Stages: preflight -> generated quest child (it owns its session and logout) -> bank session -> saved-state check.
import {existsSync,readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {acquireExclusiveLease} from './payout-order';
import {openBot,settle,serverFromEnv} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {questFlags,type QuestFlag} from '../packages/core/src/quest-status';
import {sessionWalker,walkPath,type PathPoint} from '../packages/core/src/walk';
import {readPracticeSave,waitPracticeSave} from './measure/fleet-player-save';
import {walkQuestCorridor} from './quest-walk';
import {killTree} from '../packages/practice/src/proc';

const root=resolve(import.meta.dir,'..');
type Item={id:number;name:string;count:number};
type Save=ReturnType<typeof readPracticeSave>;
// exact: the generated script requires the pack to hold no copy of the item after the hand-in
// (quest-cook.ts end check), so a surplus copy would fail the child after the quest is done.
interface Order{key:string;label:string;script:string;varp:string;items:(Item&{exact?:boolean})[];bank:PathPoint[];deadlineTicks:number}
// Lumbridge -> Draynor bank by the northern corridor (collect-wool.ts bank(): rev 289 has no castle bank, and the
// direct line crosses the dark wizards south of Draynor).
const DRAYNOR_BANK:PathPoint[]=[{x:3218,z:3256,tol:2},{x:3180,z:3258,tol:2},{x:3140,z:3270,tol:2},{x:3100,z:3270,tol:2},{x:3089,z:3266,tol:2},{x:3092,z:3250,tol:2},{x:3092,z:3243,tol:1}];
export const QUEST_ORDERS:Readonly<Record<string,Order>>={
 // quest_cook.rs2:76-91: the hand-in deletes one of each item; the queued completion sets %cookquest and %qp.
 cook:{key:'cook',label:"Cook's Assistant",script:'scripts/generated/quest-cook.ts',varp:'cookquest',
  items:[{id:1944,name:'Egg',count:1,exact:true},{id:1927,name:'Bucket of milk',count:1,exact:true},{id:1933,name:'Pot of flour',count:1,exact:true}],
  bank:DRAYNOR_BANK,deadlineTicks:600},
};

let varpIds:Map<string,number>|undefined;
function varpId(name:string){
 varpIds??=new Map(readFileSync(resolve(root,'vendor/rs-sdk/server/content/pack/varp.pack'),'utf8').split(/\r?\n/).flatMap(l=>{const m=l.match(/^(\d+)=(\w+)$/);return m?[[m[2]!,Number(m[1])] as const]:[];}));
 const id=varpIds.get(name);if(id===undefined)throw Error(`quest order: varp ${name} not in pinned pack`);return id;
}
export type QuestSpec=Order&{varpId:number;qpVarpId:number;complete:number;questPoints:number};
// Complete value and quest points come from the generated knowledge (count_questpoints), not from the script.
export function questSpec(key:string):QuestSpec{
 const order=Object.hasOwn(QUEST_ORDERS,key)?QUEST_ORDERS[key]:undefined;
 if(!order)throw Error(`quest order: unknown quest ${key}; known ${Object.keys(QUEST_ORDERS).join(',')}`);
 const facts=(JSON.parse(readFileSync(resolve(root,'knowledge/quests.json'),'utf8')) as {varp:string;complete:number;questPoints:number}[]).find(q=>q.varp===order.varp);
 if(!facts||!Number.isSafeInteger(facts.complete)||!Number.isSafeInteger(facts.questPoints)||facts.questPoints<1)throw Error(`quest order: no quest facts for ${order.varp}`);
 return{...order,varpId:varpId(order.varp),qpVarpId:varpId('qp'),complete:facts.complete,questPoints:facts.questPoints};
}

const total=(items:readonly {id:number;count:number}[]|undefined,id:number)=>(items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
// A save omits a zero varp. In the server's own save that is the real value, unlike a client default.
export function savedQuest(save:Save,spec:QuestSpec){
 const progress=save.vars[spec.varpId]??0,qp=save.vars[spec.qpVarpId]??0;
 return{progress,qp,done:progress>=spec.complete};
}
export type Refusal={ok:false;refused:string};
// Inputs are observations: saved progress (a number) or the quest list flag, and the pack. Unknown state refuses.
export function questPreflight(spec:QuestSpec,seen:{progress?:number;flag?:QuestFlag['state']|null;pack:readonly {id:number;count:number}[]|null}):{ok:true}|Refusal{
 if(seen.progress!==undefined){if(!Number.isSafeInteger(seen.progress))return{ok:false,refused:'quest progress unknown'};if(seen.progress>=spec.complete)return{ok:false,refused:'quest already complete'};}
 else if(seen.flag==='complete')return{ok:false,refused:'quest already complete'};
 else if(seen.flag!=='not started'&&seen.flag!=='started')return{ok:false,refused:'quest state unknown'};
 if(!seen.pack)return{ok:false,refused:'pack unknown'};
 for(const item of spec.items){
  const held=total(seen.pack,item.id);
  if(held<item.count)return{ok:false,refused:`missing item ${item.name} ${held}/${item.count}`};
  if(item.exact&&held!==item.count)return{ok:false,refused:`surplus item ${item.name} ${held}/${item.count}`};
 }
 return{ok:true};
}
// Saved-state acceptance: 93 is the pack, 95 the bank. Every non-quest pack item before the order is in the bank after.
export function questSavedChecks(spec:QuestSpec,before:Save,after:Save){
 const b=savedQuest(before,spec),a=savedQuest(after,spec),quest=new Set(spec.items.map(i=>i.id));
 const left=(before.inventories[93]??[]).filter(i=>!quest.has(i.id)).map(i=>i.id);
 return{
  entry:questPreflight(spec,{progress:b.progress,pack:before.inventories[93]??[]}).ok,
  varp:a.progress===spec.complete,
  questPoints:a.qp===b.qp+spec.questPoints,
  consumed:spec.items.every(i=>total(after.inventories[93],i.id)+total(after.inventories[95],i.id)===total(before.inventories[93],i.id)+total(before.inventories[95],i.id)-i.count),
  banked:(after.inventories[93]??[]).length===0&&[...new Set(left)].every(id=>total(after.inventories[95],id)===total(before.inventories[95],id)+total(before.inventories[93],id)),
  assets:questAssets(spec,before,after),
 };
}

// The only permitted asset change is the recipe debit. Include bank-only assets and worn kit.
export function questAssets(spec:QuestSpec,before:Save,after:Save){
 const ids=new Set([before,after].flatMap(s=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])].map(i=>i.id)));
 if(![...ids].every(id=>total(after.inventories[93],id)+total(after.inventories[95],id)===total(before.inventories[93],id)+total(before.inventories[95],id)-(spec.items.find(i=>i.id===id)?.count??0)))return false;
 const containers=new Set([...Object.keys(before.inventories),...Object.keys(after.inventories)].map(Number).filter(id=>id!==93&&id!==95));
 return [...containers].every(inv=>JSON.stringify(before.inventories[inv]??[])===JSON.stringify(after.inventories[inv]??[]));
}
export function questCompleted(spec:QuestSpec,before:Save,after:Save){
 const checks=questSavedChecks(spec,before,after);
 return checks.entry&&checks.varp&&checks.questPoints&&checks.consumed&&checks.assets;
}

const flagOf=(s:Session,label:string)=>questFlags(s.client)?.find(q=>q.name===label)?.state??null;
const pack=(s:Session)=>{const inv=s.sdk.getState()?.inventory;return Array.isArray(inv)?inv:null;};
// The quest list colour arrives after login. Wait for a known colour within a deadline; never read the red default.
async function observeFlag(s:Session,label:string){
 if(!await waitUntil(s,()=>{const f=flagOf(s,label);return f!==null&&f!=='unknown'&&pack(s)!==null;},{timeoutTicks:10}))throw Error('quest entry state unobserved within deadline');
 return flagOf(s,label);
}

async function runChild(spec:QuestSpec,name:string,timeoutMs:number){
 const child=Bun.spawn(['bun',spec.script,name],{cwd:root,env:process.env,stdout:'pipe',stderr:'pipe',windowsHide:true});
 let expired=false,termination:Promise<void>|undefined;const timer=setTimeout(()=>{expired=true;termination=killTree(child.pid);},timeoutMs);
 let out:string,err:string,code:number;
 try{[out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);}
 finally{clearTimeout(timer);await termination;}
 process.stdout.write(out);process.stderr.write(err);
 const result=out.split(/\r?\n/).filter(l=>l.startsWith('RESULT ')).at(-1)??'';
 const logout=!expired&&/^LOGOUT logged-out$/m.test(out)&&!/^WARN .*?(?:logout|session close)/m.test(out+err);
 return{ok:logout&&code===0&&/^RESULT ok(?: |$)/.test(result),logout,code:expired?-1:code,result};
}

// Confirm the quest flag in game, then bank every pack item. Session cleanup stays with settle().
async function bankSession(name:string,spec:QuestSpec){
 const s=await openBot(name);let ok=false,detail='',banked=0;
 try{
  const flag=await observeFlag(s,spec.label);
  if(flag!=='complete')throw Error(`quest flag ${flag??'unknown'} after quest`);
  const observed=pack(s);if(!observed)throw Error('pack unknown after quest');
  const items=observed.filter(i=>i.count>0);
  if(items.length){
   const walker=await sessionWalker(s as any),deadline=s.tick()+spec.deadlineTicks;let ended=false;void s.ended.then(()=>{ended=true;});
   const near=(p:PathPoint,t:number)=>{const me=s.sdk.getState()?.player;return !!me&&me.level===0&&Math.max(Math.abs(me.worldX-p.x),Math.abs(me.worldZ-p.z))<=t;};
   const walk=await walkQuestCorridor({tick:()=>s.tick(),stop:()=>ended,near,walk:(points,options)=>walkPath(walker,points,options)},spec.bank,deadline);
   if(!walk.ok)throw Error('bank walk: '+walk.detail);
   const opened=await s.bot.openBank();if(!opened.success)throw Error('bank refused: '+opened.message);
   const seen=new Set<string>();
   for(const item of items){const k=item.id+':'+item.name;if(seen.has(k))continue;seen.add(k);const current=pack(s)?.find(i=>i.id===item.id&&i.name===item.name);if(current)banked+=await depositObserved(s,current);}
   const remaining=pack(s);if(!remaining||remaining.some(i=>i.count>0))throw Error('pack not empty or unknown after deposits');
   const closed=await s.bot.closeBank();if(!closed.success)throw Error('bank close refused: '+closed.message);
  }
  ok=true;detail=`quest-order bank flag=complete banked=${banked}`;
 }catch(error){detail='quest-order bank '+String(error);}
 let logout=false;
 const passed=await settle([s],ok,detail,{log:line=>{console.log(line);if(line==='LOGOUT logged-out')logout=true;if(/^WARN .*?(?:logout|session close)/.test(line))logout=false;}});
 return{ok:passed,logout,detail,banked};
}

// Runtime seams let the existing native proof retain real sessions while injecting failures at stage boundaries.
export const questOrderRuntime={child:runChild,bank:bankSession,read:readPracticeSave,wait:waitPracticeSave,
 server:(name:string)=>serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8'))};
type Pending={version:1;account:string;quest:string;save:string;server:string;state:'pending'|'settled';before:Save;child?:Awaited<ReturnType<typeof runChild>>;bank?:Awaited<ReturnType<typeof bankSession>>};
export async function runQuestOrder(name:string,key:string,options:{save?:string;timeoutMs:number},runtime=questOrderRuntime){
 const spec=questSpec(key),stages:Record<string,unknown>={};
 const report=(ok:boolean,extra:Record<string,unknown>)=>({ok,quest:spec.key,account:name,...extra,stages});
 if(!/^[A-Za-z0-9]{1,12}$/.test(name))throw Error('quest order: invalid account');
 if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1000)throw Error('quest order: invalid timeout');
 if(!options.save)return report(false,{refused:'save required',login:false});
 if(!existsSync(options.save))return report(false,{refused:'save not found',login:false});
 const savePath=realpathSync(options.save),account=name.toLowerCase();
 if(basename(savePath).toLowerCase()!==account+'.sav')return report(false,{refused:'save account mismatch',login:false});
 const journal=savePath+'.quest-order.json';
 // Reuse the exact-order lease. It serializes this account's journal through child logout, bank and settlement.
 let release:()=>void;
 try{release=acquireExclusiveLease(journal+'.lock',spec.key);}catch{return report(false,{refused:'quest order owned',login:false});}
 try{
  const current=runtime.read(savePath);
  let pending:Pending|undefined;
  try{if(existsSync(journal))pending=JSON.parse(readFileSync(journal,'utf8'));}
  catch{return report(false,{refused:'pending order unreadable',login:false});}
  if(!pending){
   const gate=questPreflight(spec,{progress:savedQuest(current,spec).progress,pack:current.inventories[93]??[]});
   if(!gate.ok)return report(false,{refused:gate.refused,login:false});
  }
  const server=runtime.server(name);
  if(pending&&(pending.version!==1||pending.account!==account||pending.quest!==key||pending.save!==savePath||pending.server!==server||!pending.before||!['pending','settled'].includes(pending.state)))return report(false,{refused:'pending order identity mismatch',login:false});
  if(pending?.state==='settled')return report(false,{refused:'quest already complete',login:false});
  const resumed=!!pending;
  const publish=()=>{const tmp=journal+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(pending),{flush:true});renameSync(tmp,journal);};
  if(!pending){pending={version:1,account,quest:key,save:savePath,server,state:'pending',before:current};publish();}
  const before=pending.before;
  if(resumed){
   // Never replay a child with uncertain effects. Bank-only recovery requires the original clean logout
   // and independently saved completion, recipe debit and unchanged aggregate assets.
   if(!pending.child?.logout||pending.bank?.logout===false||!questCompleted(spec,before,current))return report(false,{refused:'pending quest requires reconciliation',login:false});
   stages.resumed=true;
  }else{
   pending.child=await runtime.child(spec,name,options.timeoutMs);publish();
  }
  stages.quest=pending.child;
  if(!pending.child?.logout)return report(false,{failed:'generated quest logout'});
  const completion=await runtime.wait(savePath,s=>questCompleted(spec,before,s),{timeoutMs:15000});
  stages.completion={matched:completion.matched,saved:savedQuest(completion.save,spec)};
  if(!completion.matched)return report(false,{failed:'saved quest completion'});
  // A child failure is retained, but independently saved completion can finish this order's bank obligation.
  const bank=await runtime.bank(name,spec);stages.bank=bank;pending.bank=bank;publish();
  if(!bank.ok||!bank.logout)return report(false,{failed:'bank'});
  const done=await runtime.wait(savePath,s=>Object.values(questSavedChecks(spec,before,s)).every(Boolean),{timeoutMs:15000});
  if(done.matched){pending.state='settled';publish();}
  return report(done.matched,{checks:questSavedChecks(spec,before,done.save),saved:savedQuest(done.save,spec)});
 }finally{release();}
}

if(import.meta.main){
 try{
  const [name,key]=process.argv.slice(2).filter(a=>!a.startsWith('--'));
  const flag=(k:string)=>process.argv.find(a=>a.startsWith(`--${k}=`))?.slice(k.length+3);
  if(!name||!key)throw Error('usage: bun scripts/quest-order.ts <account> <quest> [--save=<path>] [--timeout-ms=300000]');
  const save=flag('save');
  const result=await runQuestOrder(name,key,{save:save?resolve(save):undefined,timeoutMs:Number(flag('timeout-ms')??300000)});
  console.log('QUEST_ORDER_RESULT '+JSON.stringify(result));process.exit(result.ok?0:1);
 }catch(error){console.error(String(error));process.exit(1);}
}
