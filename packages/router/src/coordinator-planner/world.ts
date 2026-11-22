import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {freemem} from 'node:os';
import {join} from 'node:path';
import type {TaskRecord} from '../coordinator';
import {freshScoreboard} from '../coverage';
import {projectRoot} from '../coordinator-store';
import {diskFreeGB} from '../coordinator-decisions';
import {PRACTICE_STARTUP_GB} from '../../../core/src/memory';
import {observePracticeTurn} from '../../../practice/src/proof-lock';
import {readMergedPlan} from '../../../core/src/coordinator-jobs';
import {progressionSummary} from '../../../core/src/progression-session';
import {liveHelperStatuses,observedStock,overallSupplyDemand,supplyBill} from '../../../planner/src/supply-bill';
import {readPlannerControllerCapacity,readPlannerStatuses,readRecoveryProblems} from './observations';

export const GAME_SKILLS=['Attack','Defence','Strength','Hitpoints','Ranged','Prayer','Magic','Cooking','Woodcutting','Fletching','Fishing','Firemaking','Crafting','Smithing','Mining','Herblore','Agility','Thieving','Runecraft'];
export function gameCoverage(methods:any[],quests:any[],statuses:any[],protectedNames:string[],scripts:string[]){
 const ordinary=statuses.filter(s=>!protectedNames.some(n=>n.toLowerCase()===s.name?.toLowerCase()));
 return{scope:'Pinned server content; script presence and saved skill levels are discovery, not live automation coverage.',
  skills:GAME_SKILLS.map(name=>({name,cataloguedMethods:methods.filter(m=>m.skill===name.toLowerCase()).length,
   bestObserved:ordinary.flatMap(s=>(s.skills??[]).filter((v:any)=>v.name?.toLowerCase()===name.toLowerCase()).map((v:any)=>({account:s.name,level:v.level,at:s.at}))).sort((a:any,b:any)=>b.level-a.level)[0]??null})),
  questCount:quests.length,quests:quests.map(q=>({key:q.varp,folder:q.folder,questPoints:q.questPoints,source:q.src})),
  scriptCandidates:scripts,methodCount:methods.length,
  otherGoals:['wealth and market logistics','quest access and travel unlocks','equipment and combat','items and collection','specialist records','main Overall record'],
  unknown:'Catalogue extraction is incomplete. Zero methods means inspect pinned content, not unavailable. Presence, native proof, live pilot and repeat qualification are separate states.'};
}

// A fresh status cannot refresh an older bank observation.
function recentStockStatus(status:any,now:number){
 const isRecent=(at:unknown)=>typeof at==='number'&&at>0&&at<=now&&now-at<=300_000;
 const recent=isRecent(status.at);
 return{...status,inventory:recent?status.inventory:[],equipment:recent?status.equipment:[],
  bank:recent&&isRecent(status.bankAt)&&status.bankAt<=status.at?status.bank:[]};
}

// Reprice current route demand or an explicitly inspected saved bill. Demand time does not refresh stock.
export function supplyBillSummary({base=projectRoot,now=Date.now(),fleetDir,side,source='saved'}:{
 base?:string; now?:number; fleetDir?:string; side?:string; source?:'route'|'saved';
}={}){
 try{
  const current=source==='route'?overallSupplyDemand(join(base,'research/hiscores-live.json')):null;
  const bill=current?null:JSON.parse(readFileSync(join(base,'.practice/coordinator/supply-bill.json'),'utf8'));
  const demands=current?.supplies??bill.rows.map((row:{item:string;itemId?:number;need:number;aliases?:string[]})=>({item:row.item,itemId:row.itemId,count:row.need,aliases:row.aliases}));
  const items=JSON.parse(readFileSync(join(base,'knowledge/items.json'),'utf8'));
  const statuses=liveHelperStatuses(base,fleetDir,side).filter(s=>!s.practice);
  const recentStatuses=statuses.map(s=>recentStockStatus(s,now));
  const observed=supplyBill(demands,items,statuses);
  const recent=supplyBill(demands,items,recentStatuses);
  const verify=observed.flatMap((row,index)=>{
   const current=recent[index]!;
   const toVerify=Math.min(row.need,row.owned)-current.owned;
   if(toVerify<=0)return [];
   const freshByAccount=new Map(current.holders.map(h=>[h.account,h.count]));
   const holders=row.holders.map(h=>({account:h.account,count:h.count-(freshByAccount.get(h.account)??0)}))
    .filter(h=>h.count>0).sort((a,b)=>b.count-a.count).slice(0,2);
   return [{item:row.item,...(row.itemId===undefined?{}:{itemId:row.itemId}),need:row.need,recent:current.owned,toVerify,holders,...(row.aliases?{aliases:row.aliases}:{})}];
  });
  return {
   at:current?now:bill.at,
   snapshotAt:current?current.snapshotAt:bill.snapshotAt??null,
   scope:current||bill.scope==='overall'?'overall':'unknown',
   overallFinish:current?current.overallFinish:bill.scope==='overall'?bill.overallFinish:null,
   observedAt:now,
   recentlyCovered:recent.filter(r=>r.ids.length>0&&r.short===0).length,
   unmapped:observed.filter(r=>!r.ids.length).map(r=>r.item),
   verificationNeeded:verify.length,
   verify:verify.sort((a,b)=>b.toVerify-a.toVerify).slice(0,25),
   short:observed.filter(r=>r.ids.length>0&&r.short>0).sort((a,b)=>b.short-a.short).slice(0,25)
    .map(r=>({item:r.item,...(r.itemId===undefined?{}:{itemId:r.itemId}),need:r.need,short:r.short,holders:r.holders.slice(0,2),...(r.aliases?{aliases:r.aliases}:{})})),
  };
 }catch{return null;}
}

// Coins and the large stacks each named account holds (inventory, worn and last seen bank), so plans spend and
// convert owned stock: logs to Firemaking, essence to Runecraft, bows and shafts to Ranged, coins to GE and shop buys.
export function assetSummary(statuses:readonly any[],protectedNames:readonly string[]=[],now=Date.now()){
 const names=new Map((JSON.parse(readFileSync(join(projectRoot,'knowledge/items.json'),'utf8')) as any[]).map(i=>[i.id,i.name]));
 const protectedAccounts=new Set(['haggis',...protectedNames.map(name=>name.toLowerCase())]);
 return statuses.filter(s=>typeof s?.name==='string'&&/^[A-Za-z0-9]{1,12}$/.test(s.name)&&s.server==='rs-sdk-demo.fly.dev'
  &&!s.practice&&!protectedAccounts.has(s.name.toLowerCase())).map(s=>{
  const observed=observedStock(s),fresh=observedStock(recentStockStatus(s,now));
  const coins=observed.get(995)??0,recentCoins=fresh.get(995)??0;
  const largeStacks=[...observed].filter(([id,count])=>id!==995&&count>=50).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const recent={coins:recentCoins,stacks:[] as string[]};
  const verify={coins:coins-recentCoins,stacks:[] as string[]};
  for(const [id,count] of largeStacks){
   const current=fresh.get(id)??0,name=names.get(id)??id;
   if(current>0)recent.stacks.push(`${name} ${current}`);
   if(count>current)verify.stacks.push(`${name} ${count-current}`);
  }
  return{account:s.name,...(typeof s.side==='string'?{side:s.side}:{}),at:s.pos?`${s.pos.x},${s.pos.z}`:null,statusAt:s.at??null,bankAt:s.bankAt??null,recent,verify};
 }).filter(a=>a.recent.coins+a.verify.coins>=1000||a.recent.stacks.length||a.verify.stacks.length);
}

// The planner sees the whole-game scoreboard in a compact form: every skill, every quest by stage, weak domains.
export function scoreboardSummary(board:any){
 const byStage=(stage:string)=>board.quests.folders.filter((f:any)=>f.stage===stage).map((f:any)=>f.folder.replace(/^quest_/,''));
 return{at:board.at,scope:board.scope,progress:board.progress,goals:board.goals,totals:board.totals,items:board.items,
  skills:board.skills.map((s:any)=>({skill:s.skill,bestLive:s.bestLive})),
  ...(board.fleetSkills?{fleetSkills:fleetLeads(board.fleetSkills,board.fleet?.side??'local'),fleet:board.fleet}:{}),
  quests:{liveComplete:board.quests.liveComplete,practice:byStage('practice'),named:byStage('named'),none:byStage('none')},
  weakDomains:board.domains.filter((d:any)=>d.share<50).sort((a:any,b:any)=>b.actions-a.actions).slice(0,40)};
}

// Levels another side may lead a skill by before local work on it needs to pass that side's best.
const FLEET_BAND=5;
// Each board-gap skill (fleet best under 99): the fleet best, the side and account that hold it, this side's best, and
// whether another side leads this side by more than FLEET_BAND.
export function fleetLeads(rows:any[],side:string){
 return rows.filter((r:any)=>r.best<99).map((r:any)=>{
  const mine=r.bySide?.[side]??null;
  return{skill:r.skill,best:r.best,side:r.side,account:r.account,local:mine,otherSideLeads:r.side!==side&&r.best-(mine?.level??1)>FLEET_BAND};
 });
}

export function readWorld(tasks:readonly TaskRecord[]=[]){
 const plan=readMergedPlan(projectRoot);
 const statuses=readPlannerStatuses();
 const protectedNames=plan.jobs.filter((j:any)=>!j.script||/fresh.clock|main simultaneous|24 boards/i.test(j.goal??'')).flatMap((j:any)=>j.accounts??[j.account]).filter(Boolean);
 const capabilities=readdirSync(join(projectRoot,'packages/router/tasks')).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(join(projectRoot,'packages/router/tasks',f),'utf8')));
 const capabilitySources=Object.fromEntries(capabilities.map(d=>[d.id,createHash('sha256').update(readFileSync(join(projectRoot,'packages/router/tasks',d.id+'.json'))).digest('hex')]));
 const ended=existsSync(join(projectRoot,'.practice/swarm-deaths.json'))?JSON.parse(readFileSync(join(projectRoot,'.practice/swarm-deaths.json'),'utf8')):{};
 const scripts:string[]=[];const walk=(path:string)=>{for(const f of readdirSync(join(projectRoot,path),{withFileTypes:true})){const file=path+'/'+f.name;if(f.isDirectory()&&!['measure'].includes(f.name))walk(file);else if(f.isFile()&&f.name.endsWith('.ts')&&!f.name.endsWith('.test.ts'))scripts.push(file);}};walk('scripts');
 const coverage=gameCoverage(JSON.parse(readFileSync(join(projectRoot,'knowledge/skills.json'),'utf8')),JSON.parse(readFileSync(join(projectRoot,'knowledge/quests.json'),'utf8')),statuses,protectedNames,scripts.sort());
 let scoreboard:any=null;try{scoreboard=scoreboardSummary(freshScoreboard(projectRoot));}catch(error){scoreboard={error:String(error)};}
 let stall:any=null;try{const f=join(projectRoot,'.practice/coordinator/stall.json');if(existsSync(f))stall=JSON.parse(readFileSync(f,'utf8'));}catch{/* no stall note */}
 const controller=readPlannerControllerCapacity();
 const now=Date.now();
 let progressionRequests:unknown={at:null,rows:[],gap:'No fresh coordinator method comparison'};
 try{const saved=JSON.parse(readFileSync(join(projectRoot,'.practice/coordinator/progression-requests.json'),'utf8'));if(Number.isFinite(saved.at)&&saved.at>0&&saved.at<=now&&now-saved.at<=900000&&Array.isArray(saved.rows))progressionRequests=saved;}catch{/* Unknown method requests never refresh account or stock observations. */}
 return{at:now,scoreboard,stall,progression:progressionSummary(projectRoot),progressionRequests,recoveryProblems:readRecoveryProblems(projectRoot,ended,tasks),assets:assetSummary(liveHelperStatuses(),protectedNames,now),supplyBill:supplyBillSummary({source:'route',now}),executionDirective:plan.coordination?.directive??'',deliveryFocus:plan.coordination?.focusCapability??null,capacity:{maxBots:plan.maxBots,minFreeGB:plan.minFreeGB,freeGB:freemem()/2**30,nativeStartupGB:PRACTICE_STARTUP_GB,nativeTurn:observePracticeTurn(join(projectRoot,'.practice/delivery-native.lock')),diskFreeGB:diskFreeGB(projectRoot),maxLive:plan.coordination?.maxLive??plan.maxBots,preferLive:plan.coordination?.preferLive===true,...(controller?{controller}:{})},protectedNames,jobs:plan.jobs,statuses,ended,capabilities,capabilitySources,coverage};
}
