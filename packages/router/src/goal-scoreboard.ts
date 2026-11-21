// Read-only owner-goal observations. Coverage, preparation and recorded goal proof stay separate.
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {mySide,loadOwners} from '../../core/src/fleet';
import {SPECIALIST_BOARDS} from '../../core/src/specialist-launch';
import {readBound} from '../../core/src/launch-evidence';
import {readKillReceipts} from '../../core/src/kill-receipt';
import {boardsFromSnapshot,haggisActivities,haggisTravel,scheduleOverall,overallRequirementsFor,SKILLS,TRICKS} from '../../planner/src/haggis';
import {supplyBill,type BillRow} from '../../planner/src/supply-bill';
import {kitItems} from '../../planner/src/pk-kits';
import {handNamed,ruleRoster} from '../../core/src/army-roster';

export const COMBAT_SKILLS=['Attack','Strength','Defence','Ranged','Magic','Prayer','Hitpoints'] as const;
export type CombatSkill=typeof COMBAT_SKILLS[number];
export type GoalEvidence={source:string;at:number|null;ageMs:number|null;gap?:string};
export type GoalRank={account:string;board:string;rank:number;at:number;source:string};
export type SpecialistGoal={account:string;board:string;planTicks:number|null;recordTicks:number|null;rehearsalTicks:number|null;marginTicks:number|null;rank:number|null;rankAt:number|null;rank1:boolean|null;evidence:GoalEvidence[]};
export type CollectionNeed={item:string;id?:number;need:number;owned:number;consumer:string;verifyOwned?:number};
// One credited kill: a live receipt of an own account for a player that is not an own account.
export type ArmyKill={account:string;victim:string;at:number;wilderness:number;multi:boolean;feedMatched:boolean|null;receipt:string};
export type ArmyAccount={account:string;levels:Record<CombatSkill,number|null>;missingLevels:number;maxed:boolean;at:number|null};
export type OwnerGoals={
 version:1;at:number;
 main:{modelTicks:number|null;recordTicks:number|null;launchTargetTicks:number|null;gapTicks:number|null;rank:number|null;rankAt:number|null;rank1:boolean|null;evidence:GoalEvidence[]};
 specialists:{targets:SpecialistGoal[];rank1s:(GoalRank&{rank:1})[];scopeKnown:boolean;evidence:GoalEvidence[]};
 quests:{complete:number;total:number;remaining:string[];observedAccounts:number;evidence:GoalEvidence[]};
 collection:{targets:number;held:number;missing:CollectionNeed[];scopeKnown:boolean;evidence:GoalEvidence[]};
 army:{roster:string[];accounts:ArmyAccount[];maxed:number;missingLevels:number;creditedKills:number|null;kills?:ArmyKill[];wildernessControl:null;evidence:GoalEvidence[]};
 metrics:Record<string,number>;remaining:string[];done:boolean;
};
export type OwnerGoalInputs={root:string;now:number;statuses:readonly any[];questNames:readonly string[];fleetDir?:string};
const SERVER='rs-sdk-demo.fly.dev',RANK_AGE=3_600_000,STOCK_AGE=300_000;
const dated=(at:unknown,now:number):at is number=>typeof at==='number'&&Number.isFinite(at)&&at>0&&at<=now;
const fresh=(at:unknown,now:number)=>dated(at,now)&&now-at<RANK_AGE;
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
const read=(path:string):any=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
const key=(s:string)=>s.toLowerCase();
const boardKey=(s:string)=>key(s).replace(/[^a-z]/g,'');
function evidence(source:string,at:unknown,now:number,gap?:string):GoalEvidence{return{source,at:dated(at,now)?at:null,ageMs:dated(at,now)?now-at:null,...(gap?{gap}:{})};}
const snapshotTime=(s:any)=>typeof s?.takenAt==='string'?Date.parse(s.takenAt):NaN;
const compatibleSnapshot=(s:any)=>s?.base==='https://'+SERVER&&s.tickMs===400&&Array.isArray(s.boards);
const record=(s:any,board:string)=>compatibleSnapshot(s)?s.boards.find((b:any)=>boardKey(String(b?.board))===boardKey(board))?.rows?.find((r:any)=>r?.rank===1&&positive(r.ticks)):undefined;
const sourceStatus=(s:any)=>s.side&&s.side!==mySide()?`fleet/snapshots/${s.side}.json`:`.practice/status/${s.name}.json`;

// A rank requires a dated live observation for the same account and server.
export function observedGoalRanks(statuses:readonly any[],snapshots:readonly {source:string;value:any}[],owned:ReadonlySet<string>,now:number):GoalRank[]{
 const chosen=new Map<string,GoalRank>();
 const add=(r:GoalRank)=>{const id=key(r.account)+':'+boardKey(r.board),prior=chosen.get(id);if(!prior||r.at>prior.at)chosen.set(id,{...r,account:key(r.account)});};
 for(const s of statuses){
  if(s?.practice||key(String(s?.server))!==SERVER||typeof s?.name!=='string'||!owned.has(key(s.name)))continue;
  for(const r of Array.isArray(s.ranks)?s.ranks:[]){
   const at=Object.hasOwn(r??{},'at')?r.at:s.ranksAt;
   if(!r||typeof r.board!=='string'||!positive(r.rank)||!fresh(at,now)||r.practice
    ||(Object.hasOwn(r,'server')&&key(String(r.server))!==SERVER)
    ||['name','account'].some(k=>Object.hasOwn(r,k)&&key(String(r[k]))!==key(s.name)))continue;
   add({account:s.name,board:r.board,rank:r.rank,at,source:sourceStatus(s)});
  }
 }
 for(const {source,value:s}of snapshots){
  const at=snapshotTime(s);if(!compatibleSnapshot(s)||!fresh(at,now))continue;
  for(const b of s.boards)for(const r of Array.isArray(b?.rows)?b.rows:[])
   if(typeof b?.board==='string'&&typeof r?.name==='string'&&owned.has(key(r.name))&&positive(r.rank))add({account:r.name,board:b.board,rank:r.rank,at,source});
 }
 return [...chosen.values()].sort((a,b)=>a.board.localeCompare(b.board)||a.account.localeCompare(b.account));
}

type Demand={item:string;count:number;itemId?:number;consumer:string};
function collectionRows(demands:Demand[],catalog:any[],statuses:readonly any[],historical:readonly any[]):{bill:BillRow[];targets:CollectionNeed[];missing:CollectionNeed[]}{
 const bill=supplyBill(demands,catalog,statuses);
 const old=supplyBill(demands,catalog,historical);
 const targets=bill.map((r,index)=>{
  const labels=new Set(demands.filter(d=>d.itemId!==undefined?r.ids.includes(d.itemId):d.item===r.item||(r.aliases??[]).includes(d.item)).map(d=>d.consumer));
  const verifyOwned=Math.max(0,Math.min(r.need,old[index]?.owned??0)-Math.min(r.need,r.owned));
  return{item:r.item,...(r.ids.length===1?{id:r.ids[0]}:{}),need:r.need,owned:r.owned,consumer:[...labels].sort().join('; ')||'unresolved named supply',...(verifyOwned?{verifyOwned}:{})};
 });
 return{bill,targets,missing:targets.filter(r=>r.owned<r.need)};
}

export function buildOwnerGoals({root,now,statuses,questNames,fleetDir=join(root,'.practice/fleet-data/fleet')}:OwnerGoalInputs):OwnerGoals{
 const ev=(source:string,at?:unknown,gap?:string)=>evidence(source,at,now,gap);
 const mainSource='research/hiscores-live.json',mainSnapshot=read(join(root,mainSource));
 const specialistSource='.practice/specialist-launch/hiscores.json',specialistSnapshot=read(join(root,specialistSource));
 const mainEvidence=[ev(mainSource,snapshotTime(mainSnapshot),compatibleSnapshot(mainSnapshot)?!fresh(snapshotTime(mainSnapshot),now)?'Record snapshot is stale; refresh before a scored launch':undefined:'Live 400 ms record snapshot unavailable')];
 const fleetPath=existsSync(fleetDir)?fleetDir:join(root,'fleet');
 let owners:ReturnType<typeof loadOwners>=new Map();try{owners=loadOwners(join(fleetPath,'owners.json'));}catch{mainEvidence.push(ev('fleet/owners.json',undefined,'Ownership registry unreadable'));}
 const live=statuses.filter(s=>{
  if(typeof s?.name!=='string'||!/^[A-Za-z0-9]{1,12}$/.test(s.name)||s.practice||key(String(s.server))!==SERVER||!dated(s.at,now))return false;
  const owner=owners.get(key(s.name));
  return (!owner||owner.server===SERVER)&&(!owner||(s.side??mySide())===owner.side);
 });
 // The caller supplies canonical rows; duplicate equal-account observations cannot turn into extra stock or levels.
 const byName=new Map<string,any>();for(const s of live){const prior=byName.get(key(s.name));if(!prior||s.at>prior.at)byName.set(key(s.name),s);}
 const rows=[...byName.values()];
 const owned=new Set([...rows.map(s=>key(s.name)),...[...owners].filter(([,o])=>o.server===SERVER).map(([name])=>name)]);
 const ranks=observedGoalRanks(rows,[{source:mainSource,value:mainSnapshot},{source:specialistSource,value:specialistSnapshot}],owned,now);
 const mainRank=ranks.find(r=>r.account==='haggis'&&boardKey(r.board)==='overall');
 let modelTicks:number|null=null,demands:Demand[]=[];
 const mainRecord=record(mainSnapshot,'Overall'),recordTicks=mainRecord?.ticks??null;
 try{
  if(!compatibleSnapshot(mainSnapshot)||!mainRecord)throw Error('Overall record unavailable');
  const path=join(root,'packages/planner/src/haggis-boards.json'),activities=haggisActivities(path);
  const travel=haggisTravel(path,join(root,'packages/planner/src/haggis-travel.json'));
  const opts={mode:'realistic' as const,tricks:new Set(TRICKS),travel};
  const plan=scheduleOverall(boardsFromSnapshot(mainSnapshot),activities,opts);
  modelTicks=plan.overallFinish;
  demands=mainRank?.rank===1?[]:overallRequirementsFor(activities,opts,plan).supplies.map(s=>({...s,consumer:'main Overall'}));
  const unmeasured=plan.order.filter(p=>p.start<(modelTicks??0)).filter(p=>{const a=activities.find(a=>a.id===p.id);return !a||/"evidence":"(?:ESTIMATE|CODE-READ)"/.test(JSON.stringify(a));}).length;
  mainEvidence.push(ev('packages/planner/src/haggis-boards.json',undefined,`${unmeasured} route activities before Overall have unmeasured inputs; model is not a live result`));
 }catch(e){mainEvidence.push(ev('packages/planner/src/haggis-boards.json',undefined,String(e)));}
 const readiness=read(join(root,'.practice/haggis-readiness.json'));
 mainEvidence.push(ev('.practice/haggis-readiness.json',readiness?.at,Array.isArray(readiness?.gates)?readiness.gates.filter((g:any)=>!g?.pass).map((g:any)=>g?.name).join('; ')||'Readiness does not establish a recorded Overall win':'Launch readiness unavailable'));
 const launchTargetTicks=recordTicks===null?null:recordTicks-Math.ceil(recordTicks*.02);
 const gapTicks=modelTicks===null||launchTargetTicks===null?null:Math.max(0,modelTicks-launchTargetTicks);
 const main:OwnerGoals['main']={modelTicks,recordTicks,launchTargetTicks,gapTicks,rank:mainRank?.rank??null,rankAt:mainRank?.at??null,rank1:mainRank?mainRank.rank===1:null,evidence:mainEvidence};

 const specialistEvidence=[ev(specialistSource,snapshotTime(specialistSnapshot),'Formal candidates cover the reserved Ranged, Agility and Attack accounts; all winnable skill targets are not defined')];
 const targets=Object.entries(SPECIALIST_BOARDS).map(([account,board]):SpecialistGoal=>{
  const source=`.practice/specialist-launch/${account}.json`,p=read(join(root,source)),rank=ranks.find(r=>r.account===account&&boardKey(r.board)===boardKey(board.name));
  const valid=p?.version===1&&p.account===account&&p.board===board.name&&positive(p.planTicks)&&/^[a-f0-9]{64}$/.test(String(p.context))&&Array.isArray(p.requirements);
  const targetSnapshot=record(specialistSnapshot,board.name)?specialistSnapshot:mainSnapshot,leader=record(targetSnapshot,board.name);
  const planTicks=valid?p.planTicks:null,e=[ev(source,undefined,valid?'Plan is an estimate until the bound complete rehearsal passes launch validation':'Formal route plan unavailable'),ev(targetSnapshot===specialistSnapshot?specialistSource:mainSource,snapshotTime(targetSnapshot),fresh(snapshotTime(targetSnapshot),now)?undefined:'Specialist record needs a fresh observation')];
  let rehearsalTicks:number|null=null;
  if(valid&&p.rehearsal)try{const r=readBound(root,p.rehearsal,[]);if(r?.context===p.context&&r.ok===true&&r.died===false&&r.logout==='logged-out'&&r.startPlaytime===0&&positive(r.endPlaytime)&&r.planTicks===p.planTicks&&positive(r.boardTicks?.[board.name])&&typeof r.actor==='string'&&r.actor.toLowerCase()!==account&&/^(?:localhost|127\.0\.0\.1):\d+$/.test(String(r.server))&&dated(r.at,now)){rehearsalTicks=r.boardTicks[board.name];e.push(ev(p.rehearsal.path,r.at,'Full launch validator also checks source, raw logs, supplies and target freshness'));}else e.push(ev(p.rehearsal.path,r?.at,'Bound rehearsal is incomplete or mismatched'));}catch(error){e.push(ev(String(p.rehearsal.path),undefined,String(error)));}
  return{account,board:board.name,planTicks,recordTicks:leader?.ticks??null,rehearsalTicks,marginTicks:leader&&planTicks!==null?leader.ticks-Math.max(planTicks,rehearsalTicks??planTicks):null,rank:rank?.rank??null,rankAt:rank?.at??null,rank1:rank?rank.rank===1:null,evidence:e};
 });
 const rank1s=ranks.filter((r):r is GoalRank&{rank:1}=>r.rank===1&&r.account!=='haggis'&&(SKILLS as readonly string[]).includes(boardKey(r.board)));

 const implemented=[...new Set(questNames.filter(n=>typeof n==='string'&&n.trim()))].sort(),completed=new Set<string>(),questEvidence:GoalEvidence[]=[],questStates=new Map<string,Map<string,boolean>>();
 let observedAccounts=0;
 for(const s of rows){
  const at=Object.hasOwn(s,'questsAt')?s.questsAt:s.at;
  const journal=Array.isArray(s.questJournal)?s.questJournal:Array.isArray(s.quests)?s.quests:[];
  if(!dated(at,now)||at>s.at||!journal.length)continue;
  observedAccounts++;questEvidence.push(ev(sourceStatus(s),at));
  const known=new Map<string,boolean>();questStates.set(key(s.name),known);
  for(const q of journal){
   const name=typeof q==='string'?q:q?.name;if(!implemented.includes(name))continue;
   if(typeof q==='string'||q.state==='complete'){completed.add(name);known.set(name,true);}
   else if(now-at<STOCK_AGE&&['started','not started'].includes(q.state))known.set(name,false);
  }
 }
 const quests={complete:completed.size,total:implemented.length,remaining:implemented.filter(n=>!completed.has(n)),observedAccounts,evidence:questEvidence.length?questEvidence:[ev('.practice/status; fleet/snapshots',undefined,'Quest journal observations unavailable')]};

 const side=mySide(),armyEvidence:GoalEvidence[]=[],roster=new Set<string>(),builds=new Map<string,string>();
 const requestedPlan=resolve(root,process.env.SWARM_PLAN??'swarm.json'),relPlan=relative(resolve(root),requestedPlan);
 const planPath=relPlan!=='..'&&!relPlan.startsWith('..\\')&&!relPlan.startsWith('../')&&!isAbsolute(relPlan)?requestedPlan:join(root,'swarm.json');
 const plans:{value:any;source:string;side:string}[]=[{value:read(planPath),source:relative(root,planPath).replaceAll('\\','/'),side}];
 const plansDir=join(fleetPath,'plans');
 if(existsSync(plansDir))for(const file of readdirSync(plansDir).filter(f=>f.endsWith('.json')).sort()){
  const p=read(join(plansDir,file));if(typeof p?.side==='string'&&p.side!==side)plans.push({value:p,source:`fleet/plans/${file}`,side:p.side});
 }
 for(const {value:p,source,side:ownerSide}of plans){
  armyEvidence.push(ev(source,p?.at,Array.isArray(p?.army)?undefined:'Declared army roster unavailable in this plan'));
  for(const entry of Array.isArray(p?.army)?p.army:[]){
   const name=typeof entry==='string'?entry:entry?.account;
   if(typeof name!=='string'||!/^[A-Za-z0-9]{1,12}$/.test(name)||key(name)==='haggis')continue;
   const account=key(name),owner=owners.get(account);
   if((owner?.side??'local')!==ownerSide||owner&&owner.server!==SERVER)continue;
   roster.add(account);const build=typeof entry==='object'?entry.build:p.builds?.[name]??p.builds?.[account];
   if(typeof build==='string')builds.set(account,build);
  }
 }
 // The roster rule of packages/core/src/army-roster.ts for this side's own accounts: Attack, Strength and Defence at 90 or
 // more, not held by an enabled hand job of this side's plan, never the main account or a specialist. Another side's rule
 // accounts count when that side publishes them in its plan's `army` (scripts/fleet-sync.ts planView).
 const handJobs=handNamed(Array.isArray(plans[0]?.value?.jobs)?plans[0]!.value.jobs:[],side);
 for(const account of ruleRoster(rows.filter((s:any)=>owners.get(key(s.name))?.server===SERVER),n=>owners.get(key(n))?.side===side,handJobs))roster.add(account);
 const accounts:ArmyAccount[]=[...roster].sort().map(account=>{
  const s=byName.get(account),levels=Object.fromEntries(COMBAT_SKILLS.map(name=>{
   const observations=(Array.isArray(s?.skills)?s.skills:[]).filter((k:any)=>key(String(k?.name))===key(name));
   const level=observations.length===1&&positive(observations[0].level)&&observations[0].level<=99?observations[0].level:null;
   return[name,level];
  })) as Record<CombatSkill,number|null>;
  return{account,levels,missingLevels:COMBAT_SKILLS.reduce((n,k)=>n+99-(levels[k]??0),0),maxed:COMBAT_SKILLS.every(k=>levels[k]===99),at:s?.at??null};
 });
 for(const [account,build]of builds)try{
  const kit=kitItems(build),catalog=read(join(root,'knowledge/items.json'))??[];
  for(const i of [...kit.equipment,...kit.inventory])demands.push({item:catalog.find((c:any)=>c.id===i.id)?.name??`item ${i.id}`,itemId:i.id,count:i.count,consumer:`army:${account}:${build}`});
 }catch(error){armyEvidence.push(ev('packages/planner/src/pk-kits.ts',undefined,`${account}: ${String(error)}`));}
 armyEvidence.push(ev('.practice/status; fleet/snapshots',undefined,'Missing level observations are unverified target levels, not measured level deficits; no accepted Wilderness-control receipt'));
 // Kill receipts of this machine (packages/core/src/kill-receipt.ts). Only the live tree of the live server is read, and a
 // receipt gives credit only when its own fields also say live. With no credited receipt the count stays unknown.
 const killSource='.practice/kill-receipts/live',verdicts=readKillReceipts({root:join(root,'.practice/kill-receipts'),server:SERVER,owned,now});
 const kills:ArmyKill[]=verdicts.filter(v=>v.credited&&v.receipt).map(v=>({account:key(v.receipt!.account),victim:v.receipt!.victim,at:v.receipt!.at,wilderness:v.receipt!.wilderness,multi:v.receipt!.multi,feedMatched:v.receipt!.feed?v.receipt!.feed.matched:null,receipt:relative(root,v.file).replaceAll('\\','/')}));
 const refused=verdicts.filter(v=>!v.credited),refusedWhy=[...new Set(refused.map(v=>v.reason))].sort().join(', ');
 armyEvidence.push(ev(killSource,kills.length?Math.max(...kills.map(k=>k.at)):undefined,`${kills.length?`${kills.length} credited live kill receipts on this machine`:'No credited live player-kill receipt on this machine'}${refused.length?`; ${refused.length} refused (${refusedWhy})`:''}; receipts of other fleet sides are not read`));
 const army:OwnerGoals['army']={roster:[...roster].sort(),accounts,maxed:accounts.filter(a=>a.maxed).length,missingLevels:accounts.reduce((n,a)=>n+a.missingLevels,0),creditedKills:kills.length||null,kills,wildernessControl:null,evidence:armyEvidence};

 const catalog=read(join(root,'knowledge/items.json'))??[];
 const knownContainer=(value:any)=>Array.isArray(value)&&value.every(i=>positive(i?.count)&&Number.isSafeInteger(i.baseId??i.id));
 const container=(value:any)=>knownContainer(value)?value:[];
 const stock=(recent:boolean)=>rows.filter(s=>key(s.name)!=='haggis').map(s=>({name:s.name,
  inventory:!recent||now-s.at<STOCK_AGE?container(s.inventory):[],equipment:!recent||now-s.at<STOCK_AGE?container(s.equipment):[],
  bank:dated(s.bankAt,now)&&s.bankAt<=s.at&&(!recent||now-s.bankAt<STOCK_AGE)?container(s.bank):[]}));
 const {bill,targets:supported,missing}=collectionRows(demands,catalog,stock(true),stock(false));
 const collectionEvidence=[ev('packages/planner/src/haggis-boards.json',snapshotTime(mainSnapshot),'Route supply and declared army kits are a supported subset; full useful-item and best-in-slot targets are undefined; holdings require reservation and staging'),...rows.map(s=>ev(sourceStatus(s),s.bankAt,now-s.at>=STOCK_AGE||!dated(s.bankAt,now)||now-s.bankAt>=STOCK_AGE?'Old or unknown stock needs a fresh observation before supply coverage; verifyOwned is dated stock to check':'Recent stock observation; pack and bank use the maximum per item to avoid counting a withdrawal twice'))];
 const collection:OwnerGoals['collection']={targets:bill.length,held:bill.filter(r=>r.short===0).length,missing,scopeKnown:false,evidence:collectionEvidence};
 const metrics:Record<string,number>={};
 if(main.rank1!==null)metrics['main.rank1']=main.rank1?1:0;
 for(const rank of ranks)if(rank.account!=='haggis'&&(SKILLS as readonly string[]).includes(boardKey(rank.board)))metrics[`specialists.rank1:${rank.account}:${rank.board}`]=rank.rank===1?1:0;
 for(const name of implemented){
  if(completed.has(name))metrics[`quests.complete:${name}`]=1;
  else if(rows.length&&rows.every(s=>questStates.get(key(s.name))?.get(name)===false))metrics[`quests.complete:${name}`]=0;
 }
 const currentStockObserved=rows.some(s=>key(s.name)!=='haggis'&&((now-s.at<STOCK_AGE&&(knownContainer(s.inventory)||knownContainer(s.equipment)))
  ||dated(s.bankAt,now)&&s.bankAt<=s.at&&now-s.bankAt<STOCK_AGE&&knownContainer(s.bank)));
 const stockObservations=[...owned].sort().map(name=>{
  const s=byName.get(name),current=s&&now-s.at<STOCK_AGE;
  return[name,!!current&&knownContainer(s.inventory),!!current&&s.equipmentObserved!==false&&knownContainer(s.equipment),
   !!s&&dated(s.bankAt,now)&&s.bankAt<=s.at&&now-s.bankAt<STOCK_AGE&&knownContainer(s.bank)];
 });
 // A changed observation set starts a baseline; quantities and recording times do not define its identity.
 const stockObservationId=createHash('sha256').update(JSON.stringify(stockObservations)).digest('hex');
 for(const target of supported)if(!target.verifyOwned&&(target.owned>0||currentStockObserved))metrics[`collection.units:${target.consumer}:${target.id===undefined?'name='+key(target.item).replace(/\s+/g,' '):'id='+target.id}:need=${target.need}:observations=${stockObservationId}`]=Math.min(target.need,target.owned);
 for(const account of accounts){
  for(const skill of COMBAT_SKILLS)if(account.levels[skill]!==null)metrics[`army.level:${account.account}:${skill}:target=99`]=account.levels[skill]!;
  if(COMBAT_SKILLS.every(skill=>account.levels[skill]!==null))metrics[`army.maxed:${account.account}`]=account.maxed?1:0;
 }
 // The count of credited receipts is a fact of this machine, 0 included, so the first kill is an improvement.
 metrics['army.creditedKills']=kills.length;
 if(gapTicks!==null)metrics[`main.gapTicks:record=${recordTicks}`]=gapTicks===0?0:-gapTicks;
 const remaining=[...(main.rank1===true?[]:[`Overall rank 1 ${main.rank===null?'unknown':`rank ${main.rank}`}${gapTicks===null?'; model gap unknown':`; ${gapTicks} ticks to launch margin`}`]),'Specialist target scope and priced winning margins need proof',...(quests.remaining.length?[`Quests ${quests.complete}/${quests.total}: ${quests.remaining.join(', ')}`]:quests.total?[]:['Implemented quest target list unavailable']),'Full useful-item and best-in-slot collection scope unknown',...(missing.length?[`Named supply lines ${collection.held}/${collection.targets} covered`]:[]),...(army.roster.length?[`Army ${army.maxed}/${army.roster.length} maxed; ${army.missingLevels} target levels unverified or missing`]:['Army roster unknown or empty']),...(army.creditedKills===null?['Credited player kills unknown']:[]),'Wilderness control unknown'];
 return{version:1,at:now,main,specialists:{targets,rank1s,scopeKnown:false,evidence:specialistEvidence},quests,collection,army,metrics,remaining,done:false};
}
