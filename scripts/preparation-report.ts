import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {haggisActivities,haggisTravel,loadSnapshot,goalRequirementsFor} from '../packages/planner/src/haggis';
import {supplyRoute,routeGateRequirements,type SupplyRouteRequest} from '../packages/planner/src/supply-route';
import type {TravelModel} from '../packages/planner/src/travel';
import {FLEET} from './fleet';
import {goalReadiness} from './goal-readiness';
import {ownedLoadout,fireKit,type GearSlot,type GearCount} from '../packages/planner/src/owned-loadout';
import {orderAccounting,validateRequest,type ItemOrder} from './buy-owned-ge-item';
import {observedRouteResources,type RouteActor} from './preparation-route-state';

type Requirement={item:string;count:number;consumers?:string[]};
type Holder={name:string;count:number;at:number;state:'recent'|'stale'};
// Verified names in knowledge/items.json: Feather (314), Headless arrow (53).
// Do not guess singular forms for other supplies or expand composite gear requirements.
const aliases:Record<string,string>={'feathers':'feather','headless arrows':'headless arrow'};
const key=(s:string)=>{const name=s.trim().replace(/\s*\(noted\)$/i,'').toLowerCase();return aliases[name]??name;};
const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;

type GearJob={account?:string;accounts?:string[];script:string;goal?:string;role?:string;env?:Record<string,string>};
type GearReservation=GearCount&{account:string};
function gearJobAccounts(job:GearJob):string[]{
 const names=job.accounts??(job.account?[job.account]:[]);
 if(!names.length||names.some(n=>typeof n!=='string'||!n)||job.accounts&&job.account)throw Error('Gear assignment needs exactly one account or accounts list');
 return names;
}
// These are the installed workers' input contracts, not release/route gates.
// Ranged and cow equipment remain exact. Fire keeps its existing alternatives.
export function preparationGear(jobs:GearJob[],statuses:any[],ownedNames:string[],now=Date.now(),reservations:GearReservation[]=[],orderJournals:Record<string,ItemOrder>={}){
 const assignments=jobs.flatMap(j=>gearJobAccounts(j).map(account=>({...j,account})));
 const owned=new Set(ownedNames.map(x=>x.toLowerCase()));
 const fresh=(at:unknown)=>typeof at==='number'&&at>0&&at<=now&&now-at<=300000;
 const rowFor=(name:string)=>statuses.filter(s=>s?.name?.toLowerCase()===name.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.practice).sort((a,b)=>(b.at??0)-(a.at??0))[0];
 const validItems=(items:any)=>Array.isArray(items)&&items.every(i=>integer(i?.id)&&integer(i?.count)&&i.count>0&&(i.baseId===undefined||integer(i.baseId)));
 const snapshots=new Map([...owned].map(name=>{
  const s=rowFor(name),current=!!s&&fresh(s.at);
  const heldKnown=current&&validItems(s.inventory)&&validItems(s.equipment);
  const bankKnown=current&&fresh(s.bankAt)&&s.bankAt<=s.at&&validItems(s.bank);
  const counts=(items:any[],canonical:boolean)=>{const m=new Map<number,number>();for(const i of items){const id=canonical?(i.baseId??i.id):i.id,n=(m.get(id)??0)+i.count;if(!integer(n))throw Error('Gear stock overflow');m.set(id,n);}return m;};
  const held=counts(heldKnown?[...s.inventory,...s.equipment]:[],false),bank=counts(bankKnown?s.bank:[],true),stock=new Map<number,number>();
  // A dated bank can precede pack changes. Use the larger independently seen
  // amount, never add potentially repeated stock across these snapshots.
  for(const id of new Set([...held.keys(),...bank.keys()]))stock.set(id,Math.max(held.get(id)??0,bank.get(id)??0));
  const skill=(name:string)=>{const rows=current&&Array.isArray(s.skills)?s.skills.filter((k:any)=>k?.name===name):[];return rows.length===1&&integer(rows[0].level)&&rows[0].level>=1&&rows[0].level<=99?rows[0].level as number:null;};
  return[name,{stock:[...stock].map(([id,count])=>({id,count})),complete:!!heldKnown&&!!bankKnown,skill,at:current?s.at:null,bankAt:bankKnown?s.bankAt:null}] as const;
 }));
 const exact=(key:string,id:number,count=1,equippable:boolean|null=true):GearSlot=>({key,options:[{id,count,preference:0,equippable}]});
 const spent=new Map<string,GearCount[]>();
 const kits=assignments.flatMap(job=>{
  const name=job.account.toLowerCase();if(!owned.has(name))return[];
  const snapshot=snapshots.get(name)!;let slots:GearSlot[];
  if(job.script==='scripts/gather-fire-combat.ts')slots=fireKit(snapshot.skill('Attack'));
  else if(job.script==='scripts/gather-combat.ts'&&job.env?.TARGET==='cow')slots=[exact('weapon',1277,1,snapshot.skill('Attack')===null?null:true),exact('shield',1171),exact('trout',333,2)];
  else if(job.script==='scripts/gather-ranged.ts'){
   const ranged=snapshot.skill('Ranged');slots=[exact('weapon',841,1,ranged===null?null:ranged>=1),exact('ammo',884,Number(job.env?.AMMO??90)),exact('food',Number(job.env?.FOOD_ID??333),Number(job.env?.FOOD??3))];
  }else return[];
  const reserved=[...reservations.filter(r=>r.account.toLowerCase()===name),...(spent.get(name)??[])];
  const loadout=ownedLoadout(slots,snapshot.stock,reserved,snapshot.complete);
  if(loadout.state==='ready')spent.set(name,[...(spent.get(name)??[]),...loadout.selected]);
  const foreignStock=[...new Set(slots.flatMap(s=>s.options.map(o=>o.id)))].flatMap(id=>{
   const holders=[...snapshots].filter(([holder,s])=>holder!==name&&s.stock.some(i=>i.id===id&&i.count>0)).map(([holder])=>ownedNames.find(n=>n.toLowerCase()===holder)??holder);
   return holders.length?[{id,holders}]:[];
  });
  return[{account:job.account,script:job.script,goal:job.goal??'',at:snapshot.at,bankAt:snapshot.bankAt,loadout,foreignStock,staged:false as const,scope:'Worker input stock only. Does not settle procurement, prove delivery/equip, qualify a route or clear a hold.'}];
 });
 const procurement=assignments.filter(j=>owned.has(j.account.toLowerCase())&&j.script==='scripts/buy-owned-ge-item.ts').map(j=>{
  const itemId=Number(j.env?.ITEM_ID??1331),journal=orderJournals[j.account.toLowerCase()];
  let order:{state:string;at:number|null;age:number|null;accounting:ReturnType<typeof orderAccounting>|null;costBasis:{units:number;coins:number}|null;reason:string}={state:'unknown',at:null,age:null,accounting:null,costBasis:null,reason:'No matching dated private order journal'};
  if(journal)try{
   validateRequest(journal.request);
   if(journal.version!==1||journal.request.actor.toLowerCase()!==j.account.toLowerCase()||journal.request.server!=='rs-sdk-demo.fly.dev'
    ||journal.request.item!==itemId||journal.request.goal!==(j.env?.ORDER_KEY??'combat-sword')||!Number.isSafeInteger(journal.at)||journal.at<=0||journal.at>now
    ||!['placing','open','cancelling','collecting','settled'].includes(journal.phase))throw Error('Order identity, date or phase mismatch');
   const age=now-journal.at,accounting=orderAccounting(journal),settled=journal.phase==='settled'&&!accounting.outcomeUnresolved;
   if(age>300000&&!settled)order={state:'unknown',at:journal.at,age,accounting:null,costBasis:null,reason:'Pending order journal is stale; current private offer required'};
   else order={state:accounting.outcomeUnresolved?'unknown':age>300000?'historical-settled':journal.phase,at:journal.at,age,accounting,
    costBasis:settled?{units:accounting.acquired,coins:accounting.spent}:null,reason:'Dated journal accounting only; not current assets, delivery or realized profit'};
  }catch(error){order={...order,reason:String(error)};}
  return{account:j.account,goal:j.goal??'',itemId,accepted:false as const,order,scope:'Exact order target is unchanged. Worker kit alternatives never settle this order or its delivery.'};
 });
 return{at:now,staged:false as const,kits,procurement};
}

// Advisory stock only. Possession does not prove reservation, transport, or staging.
export function reconcilePreparation(requirements:Requirement[],statuses:any[],ownedNames:string[],now=Date.now()) {
 const owned=new Set(ownedNames.map(n=>n.toLowerCase())),latest=new Map<string,any>();
 for(const s of statuses){
  if(typeof s?.name!=='string'||!owned.has(s.name.toLowerCase())||s.server!=='rs-sdk-demo.fly.dev'||s.practice)continue;
  const name=s.name.toLowerCase(),prior=latest.get(name);
  if(!prior||(s.bankAt??0)>(prior.bankAt??0))latest.set(name,s);
 }
 const uniqueNames=[...new Map(ownedNames.map(name=>[name.toLowerCase(),name])).values()];
 const banks=uniqueNames.map(name=>{
  const s=latest.get(name.toLowerCase());
  const valid=s&&Number.isFinite(s.bankAt)&&s.bankAt>0&&s.bankAt<=now&&Array.isArray(s.bank)
   &&s.bank.every((i:any)=>integer(i?.baseId??i?.id)&&typeof i.name==='string'&&integer(i.count)&&i.count>0);
  const state:'unknown'|'recent'|'stale'=!valid?'unknown':now-s.bankAt>300000?'stale':'recent';
  return{name,at:s?.bankAt??null,state,items:valid?s.bank as {id:number;baseId?:number;name:string;count:number}[]:[]};
 });
 const shared=new Map<string,Requirement>();
 for(const r of requirements){
  if(!r.item||!integer(r.count)||r.count<1)throw Error('Invalid supply requirement');
  const id=key(r.item),prior=shared.get(id);
  const total=(prior?.count??0)+r.count;
  if(!integer(total))throw Error('Supply requirement exceeds safe integer range');
  shared.set(id,{item:prior?.item??r.item,count:total,consumers:[...new Set([...(prior?.consumers??[]),...(r.consumers??[])])]});
 }
 const items=[...shared.values()].map(r=>{
  if(!r.item||!integer(r.count)||r.count<1)throw Error('Invalid supply requirement');
  const rows=banks.flatMap(b=>b.items.filter(i=>key(i.name)===key(r.item)).map(i=>({bank:b,item:i})));
  const ids=new Set(rows.map(r=>r.item.baseId??r.item.id)),unresolved=ids.size!==1;
  const holders:Holder[]=unresolved?[]:banks.flatMap(b=>{
   const count=rows.filter(r=>r.bank===b).reduce((n,r)=>n+r.item.count,0);
   if(!Number.isSafeInteger(count))throw Error('Supply total exceeds safe integer range');
   return count>0&&b.state!=='unknown'?[{name:b.name,count,at:b.at as number,state:b.state}]:[];
  });
  const recentBanked=holders.filter(h=>h.state==='recent').reduce((n,h)=>n+h.count,0),datedBanked=holders.filter(h=>h.state==='stale').reduce((n,h)=>n+h.count,0);
  const state=!unresolved&&recentBanked>=r.count?'covered':unresolved||banks.some(b=>b.state!=='recent')?'unknown':'short';
  return{item:r.item,consumers:r.consumers,state,itemId:unresolved?null:[...ids][0],required:r.count,recentBanked,datedBanked,shortfall:Math.max(0,r.count-recentBanked),unresolved,holders};
 });
 const readiness=uniqueNames.map(name=>{
  const newest=statuses.filter(s=>s?.name?.toLowerCase()===name.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.practice).sort((a,b)=>(b.at??0)-(a.at??0))[0];
  return goalReadiness(newest,name,now);
 });
 const routeActors:RouteActor[]=uniqueNames.map(name=>{
  const s=statuses.filter(s=>s?.name?.toLowerCase()===name.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev'&&!s.practice).sort((a,b)=>(b.at??0)-(a.at??0))[0];
  return{name,server:s?.server,at:s?.at??null,inventory:s?.inventory??null,equipment:s?.equipment??null,equipmentObserved:s?.equipmentObserved===true,skills:s?.skills??null,guildFacts:s?.guildFacts??null,doorStates:s?.doorStates??null};
 });
 return{at:now,staged:false as const,scope:'Advisory selected-route supplies. No reservations or delivery acceptance.',banks:banks.map(({items,...b})=>b),items,readiness,routeActors};
}

// Bind route stock to this report's dated, owned-bank observations. Never trust
// quantities supplied by a route request, or use stale stock to cover a trip.
export function preparationRoute(report:ReturnType<typeof reconcilePreparation>,model:TravelModel,item:string,request:Omit<SupplyRouteRequest,'stops'>&{stops:Omit<SupplyRouteRequest['stops'][number],'available'>[]}) {
 const row=report.items.find(r=>key(r.item)===key(item));
 const bound={...request,stops:request.stops.map(s=>{
  const holder=row?.holders.find(h=>h.name.toLowerCase()===s.holder.toLowerCase()&&h.state==='recent');
  return {...s,available:holder?.count??null};
 })};
 const gates=routeGateRequirements(model,bound),actor=report.routeActors.find(a=>a.name.toLowerCase()===request.context?.account.toLowerCase());
 const observed=observedRouteResources(actor,request.context?.account,request.context?.server,report.at,gates.flatMap(g=>g.requires.flat()),request.resources?.reserved);
 const budget=gates.length&&observed.resources.held?{...request.budget,coins:Math.min(request.budget.coins,observed.resources.held.coins??0)}:request.budget;
 const stops=gates.length&&!observed.evidence.current?bound.stops.map(s=>({...s,outbound:{...s.outbound,accessible:null},onward:{...s.onward,accessible:null}})):bound.stops;
 // A route without an actor or gates retains the existing declared-budget
 // estimate. Actor-bound routes need the actor's actual coin observation.
 const resources=!gates.length&&!request.context?{...observed.resources,coinsKnown:undefined}:observed.resources;
 return{...supplyRoute(model,{...bound,stops,budget,resources,...(bound.context?{context:{...bound.context,at:report.at}}:{})}),resourceEvidence:observed.evidence};
}

if(import.meta.main){
 const root=resolve(import.meta.dir,'..'),snapshot=resolve(process.argv[2]??join(root,'research/hiscores-live.json'));
 const out=resolve(process.argv[3]??join(root,'.practice/joined-plan/preparation.json'));
 if(out===join(root,'.practice/haggis-supplies.json')||out===join(root,'.practice/haggis-go.json'))throw Error('Advisory output cannot replace a launch gate');
 const opts={mode:'realistic' as const,tricks:new Set<never>(),travel:haggisTravel()};
 const goals=goalRequirementsFor(haggisActivities(),opts,loadSnapshot(snapshot));
 const requirements=goals.supplies;
 const plan=JSON.parse(readFileSync(join(root,'swarm.json'),'utf8')) as {jobs:GearJob[]};
 const names=[...new Set([...FLEET.filter(a=>a.role!=='main'&&a.server==='rs-sdk-demo.fly.dev').map(a=>a.name),...plan.jobs.filter(j=>j.role!=='main').flatMap(gearJobAccounts)])];
 const sources:Record<string,string>={},issues:string[]=[];
 const hash=(f:string)=>createHash('sha256').update(readFileSync(f)).digest('hex');
 const statuses=names.flatMap(name=>{const file=join(root,'.practice/status',name+'.json');if(!existsSync(file)){issues.push(name+': missing status');return[];}try{const raw=readFileSync(file);sources[name]=createHash('sha256').update(raw).digest('hex');return[JSON.parse(raw.toString())];}catch{issues.push(name+': unreadable status');return[];}});
 const stock=reconcilePreparation(requirements,statuses,names);
 const orderJournals:Record<string,ItemOrder>={},orderSources:Record<string,{path:string;sha256:string}>={};
 for(const job of plan.jobs.filter(j=>j.script==='scripts/buy-owned-ge-item.ts'))for(const account of gearJobAccounts(job)){
  const key=job.env?.ORDER_KEY??'combat-sword';
  if(!/^[a-z0-9]{1,12}$/i.test(account)||!/^[a-z0-9_-]{1,64}$/i.test(key)){issues.push('Invalid procurement journal identity');continue;}
  const file=join(root,'.practice/market-orders',createHash('sha256').update('rs-sdk-demo.fly.dev').digest('hex').slice(0,12),account.toLowerCase()+'-'+key+'.json');
  if(!existsSync(file))continue;
  try{orderJournals[account.toLowerCase()]=JSON.parse(readFileSync(file,'utf8'));orderSources[account]={path:file,sha256:hash(file)};}catch{issues.push(account+': unreadable procurement journal');}
 }
 // Optional saved route request: {item, from, to, count, capacity, budget, stops}.
 const requestPath=process.argv[4]?resolve(process.argv[4]):null;
 const request=requestPath?JSON.parse(readFileSync(requestPath,'utf8')):null;
 const route=request?preparationRoute(stock,opts.travel,request.item,request):null;
 const report={...stock,gear:preparationGear(plan.jobs,statuses,names,Date.now(),[],orderJournals),orderSources,unlocks:goals.unlocks,route,routeSource:requestPath?{path:requestPath,sha256:hash(requestPath)}:null,issues,sources,snapshot:{path:snapshot,sha256:hash(snapshot)},sourceHashes:Object.fromEntries(['scripts/preparation-report.ts','scripts/preparation-route-state.ts','scripts/goal-readiness.ts','scripts/buy-owned-ge-item.ts','knowledge/items.json','packages/planner/src/requirements.ts','packages/planner/src/owned-loadout.ts','packages/planner/src/market-progress.ts','packages/planner/src/transport-requirements.ts','packages/core/src/status.ts','packages/core/src/quest-status.ts','scripts/fleet.ts','swarm.json','packages/planner/src/haggis.ts','packages/planner/src/supply-route.ts','packages/planner/src/travel.ts','packages/planner/src/haggis-boards.json','packages/planner/src/haggis-travel.json'].map(p=>[p,hash(join(root,p))]))};
 mkdirSync(resolve(out,'..'),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({output:out,requirements:report.items.length,coveredByRecentBanks:report.items.filter(i=>i.shortfall===0).length,unknownBanks:report.banks.filter(b=>b.state==='unknown').length,staged:false}));
}
