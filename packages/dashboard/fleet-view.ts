// Read-only projections of files the Brain runtime and the fleet agent write, for the page's board progress and
// fleet sides plugins: .practice/live/scoreboard.json (coverage per skill, quests and items, with the list of
// what remains) and the fleet-data branch's fleet/snapshots/<side>.json, fleet/orders/*.json and fleet/receipts/*.json
// (each side's last sync and the cross-side orders not yet done; scripts/fleet-trade.ts keeps an order file after it is done).
import {terminalTradeReceipt,tradeSettlement,validOrder} from '../core/src/fleet-trade-settlement';
import {fleetStatusRows,type OwnerOf} from '../core/src/fleet-snapshots';
import {isLocalServer} from '../core/src/localserver';

export const SIDE_SYNC_MS=10*60_000;

export function scoreboardView(raw:any){
 if(!raw||!Array.isArray(raw.skills)||!raw.progress)return{available:false};
 const at=Date.parse(raw.at);
 const goals=raw.goals?.version===1?raw.goals:null;
 return{available:true,at:Number.isFinite(at)?at:null,
  remaining:(goals?.remaining??raw.progress.remaining??[]).map(String),done:goals?.done===true,goals,
  skillLevels:raw.progress.skillLevels??null,skills99:raw.progress.skills99??null,
  quests:{live:goals?.quests?.complete??raw.progress.questsLive??null,total:goals?.quests?.total??raw.progress.questTotal??null},
  items:{held:raw.items?.tradeableHeld??null,total:raw.items?.tradeable??null},
  actions:{named:raw.totals?.actionsNamed??null,total:raw.totals?.actions??null},
  skills:raw.skills.map((s:any)=>({skill:String(s.skill),bestLive:Number.isFinite(s.bestLive)?s.bestLive:null,bands:(s.bands??[]).map((b:any)=>({band:String(b.band),stage:String(b.stage)}))}))};
}

const coinsIn=(list:any)=>(Array.isArray(list)?list:[]).filter((i:any)=>i?.id===995||i?.name==='Coins').reduce((n:number,i:any)=>n+(Number(i.count)||0),0);
// A side is late when its snapshot is older than three sync periods (fleet-agent --daemon syncs every 10 minutes).
// A settled order has matching evidence from both accounts. Keep uncertain orders visible.
export function fleetSidesView(snapshots:any[],orders:any[],now:number,receipts:any[]=[]){
 const sides=snapshots.filter(s=>s&&typeof s.side==='string'&&Array.isArray(s.accounts)).map(s=>({
  side:s.side,at:Number.isFinite(s.at)?s.at:null,late:!Number.isFinite(s.at)||now-s.at>3*SIDE_SYNC_MS,
  accounts:s.accounts.filter((a:any)=>a&&typeof a==='object').map((a:any)=>({name:String(a.name),at:Number.isFinite(a.at)?a.at:null,
   total:Array.isArray(a.skills)?a.skills.filter((k:any)=>k?.name!=='Overall'&&!/^Stat\d+$/.test(String(k?.name))).reduce((n:number,k:any)=>n+(Number(k.level)||0),0):null,
   coins:coinsIn(a.bank)+coinsIn(a.inventory)})).sort((x:any,y:any)=>x.name.localeCompare(y.name))}))
  .sort((a,b)=>(a.side==='local'?-1:b.side==='local'?1:a.side.localeCompare(b.side)));
 const receiptsByOrder=new Map<string,any[]>();
 for(const r of receipts){
  if(!r?.id)continue;
  let list=receiptsByOrder.get(r.id);
  if(!list){list=[];receiptsByOrder.set(r.id,list);}
  list.push(r);
 }
 const state=(order:any)=>{
  const rows=receiptsByOrder.get(order.id)??[];
  if(rows.some(r=>r.version!==undefined)){
   if(!validOrder(order))return 'reconcile';
   const settlement=tradeSettlement(order,rows,now);
   if(settlement.state==='settled')return 'done';
   if(settlement.state==='failed')return 'failed';
   if(settlement.state!=='pending')return 'reconcile';
   return rows.some(r=>terminalTradeReceipt(order,r.role,r,now)&&r.state==='settled')?'half':'open';
  }
  if(rows.some(r=>r.ok===false))return 'failed';
  const ok=new Set(rows.filter(r=>r.ok===true).map(r=>r.role));
  return ok.has('from')&&ok.has('to')?'done':ok.size?'half':'open';
 };
 const open=orders.filter(o=>o&&typeof o.from==='string'&&typeof o.to==='string').map(o=>({id:String(o.id??''),from:o.from,to:o.to,item:String(o.item??''),count:Number(o.count)||0,start:o.start??null,end:o.end??null,state:state(o),late:Number.isFinite(o.end)&&now>o.end}))
  .filter(o=>o.state!=='done').sort((a,b)=>(b.start??0)-(a.start??0));
 return{at:now,sides,orders:open};
}

// Compact pre-projection for an expired unsettled order so historical trade JSON objects do not stay pinned in RAM
// while preserving exact fleetSidesView() state parity across v2 (pending open/half, failed, reconcile) and legacy receipts.
export function compactExpiredOrderSummary(order:any,orderReceipts:readonly any[],now:number):{order:any;receipts:any[]}{
 const slimOrder={id:order.id,from:order.from,to:order.to,item:order.item,count:order.count,start:order.start,end:order.end};
 let slimReceipts:any[];
 if(orderReceipts.some(r=>r?.version!==undefined)){
  if(!validOrder(order)){
   slimReceipts=[{id:order.id,version:2,role:'from',state:'reconcile'}];
  }else{
   const s=tradeSettlement(order,orderReceipts,now).state;
   if(s==='failed')slimReceipts=[{id:order.id,ok:false}];
   else if(s==='pending'){
    const half=orderReceipts.some(r=>terminalTradeReceipt(order,r.role,r,now)&&r.state==='settled');
    slimReceipts=half?[{id:order.id,role:'from',ok:true}]:[];
   }else{
    slimReceipts=[{id:order.id,version:2,role:'from',state:s}];
   }
  }
 }else if(orderReceipts.some(r=>r?.ok===false)){
  slimReceipts=[{id:order.id,ok:false}];
 }else{
  const okRoles=new Set<string>(orderReceipts.filter(r=>r?.ok===true).map(r=>r.role));
  slimReceipts=[...okRoles].map(role=>({id:order.id,role,ok:true}));
 }
 return{order:slimOrder,receipts:slimReceipts};
}

type Seen={x:number;z:number;level:number;combat:number;seen:number};
const dated=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now;
// Explicit HP dates stay intact; legacy HP uses the status recording time. Roster and publication times never refresh it.
export function healthObservation(bot:any,now:number):{hp:{now:number;max:number}|null;hpAt:number|null}{
 const unknown={hp:null,hpAt:null},at=Object.hasOwn(bot??{},'hpAt')?bot.hpAt:bot?.at;
 if(!Number.isFinite(now)||now<=0||!dated(bot?.at,now)||!dated(at,now)||at>bot.at)return unknown;
 let hp=bot.hp;
 if(!Object.hasOwn(bot,'hp')){
  const skills=(Array.isArray(bot.skills)?bot.skills:[]).filter((s:any)=>s?.name==='Hitpoints');
  hp=skills.length===1?{now:skills[0].currentLevel,max:skills[0].level}:null;
 }
 return hp&&Number.isSafeInteger(hp.now)&&hp.now>=0&&Number.isSafeInteger(hp.max)&&hp.max>0
  ?{hp:{now:hp.now,max:hp.max},hpAt:at}:unknown;
}
function snapshotObservation(a:any,snapshotAt:any,now:number){
 const at=dated(a.at,now)?a.at:null,observedAt=(value:any)=>at!==null&&dated(value,now)&&value<=at?value:null;
 return{name:String(a.name??''),server:String(a.server??''),at,snapshotAt:dated(snapshotAt,now)?snapshotAt:null,...healthObservation(a,now),
  skills:Array.isArray(a.skills)?a.skills.map((k:any)=>({name:String(k.name),level:Number(k.level)||1,xp:Number.isFinite(k.xp)&&k.xp>=0?k.xp:null,...(Number.isSafeInteger(k.currentLevel)&&k.currentLevel>=0?{currentLevel:k.currentLevel}:{})})):[],
  inventory:Array.isArray(a.inventory)?a.inventory:null,equipment:Array.isArray(a.equipment)?a.equipment:null,bank:Array.isArray(a.bank)?a.bank:null,bankAt:Array.isArray(a.bank)?observedAt(a.bankAt):null,
  equipmentObserved:Array.isArray(a.equipment)&&a.equipmentObserved===true,
  quests:Array.isArray(a.questJournal)?a.questJournal:null,questsAt:observedAt(a.questsAt),guildFacts:a.guildFacts??null,
  pos:a.pos&&[a.pos.x,a.pos.z,a.pos.level].every(Number.isSafeInteger)&&a.pos.level>=0&&a.pos.level<=3?a.pos:null,
  combat:Number.isSafeInteger(a.combat)&&a.combat>0?a.combat:null};
}
function publishedJobsBySide(plans:any[],now:number){
 const latestPlan=new Map<string,any>();
 for(const p of plans){
  if(!p||typeof p.side!=='string'||!Array.isArray(p.jobs)||!dated(p.at,now)||now-p.at>3*SIDE_SYNC_MS)continue;
  const prev=latestPlan.get(p.side);
  if(!prev||p.at>prev.at)latestPlan.set(p.side,p);
 }
 const out=new Map<string,{at:number;byAccount:Map<string,any>}>();
 for(const [side,plan] of latestPlan){
  const grouped=new Map<string,any[]>();
  for(const j of plan.jobs){
   if(!j||typeof j!=='object')continue;
   const names=[j.account,...(Array.isArray(j.accounts)?j.accounts:[])];
   const seen=new Set<string>();
   for(const n of names){
    if(typeof n!=='string')continue;
    const key=n.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);
    let list=grouped.get(key);
    if(!list){list=[];grouped.set(key,list);}
    list.push(j);
   }
  }
  const selected=new Map<string,any>();
  for(const [key,jobs] of grouped){
   const job=jobs.find((j:any)=>j.enabled!==false&&typeof j.script==='string')??jobs[jobs.length-1];
   if(job){
    selected.set(key,{at:plan.at,state:'configured',
     script:typeof job.script==='string'?job.script:null,goal:typeof job.goal==='string'?job.goal:null,
     role:typeof job.role==='string'?job.role:null,enabled:job.enabled!==false});
   }
  }
  out.set(side,{at:plan.at,byAccount:selected});
 }
 return out;
}
function publishedJob(bySide:ReturnType<typeof publishedJobsBySide>,side:string,name:string,ownerOf:OwnerOf){
 const owner=ownerOf(name);
 if(name.toLowerCase()==='haggis'||owner&&owner!==side)return null;
 const job=bySide.get(side)?.byAccount.get(name.toLowerCase());
 return job?{account:name,side,...job}:null;
}
// A fresh container can have this side's published observations before it has any status files. Select them by
// the fleet ownership/freshness rule, without attaching an older local session's activity or rates to the snapshot.
export function dashboardStatuses(local:ReadonlyMap<string,any>,snapshots:any[],ownerOf:OwnerOf,mySide:string,now:number){
 const out=new Map(local),byName=new Map([...local.values()].map(s=>[String(s.name).toLowerCase(),s]));
 const files=snapshots.map(s=>({...s,accounts:(Array.isArray(s?.accounts)?s.accounts:[]).filter((a:any)=>dated(a?.at,now))}));
 for(const row of fleetStatusRows([...local.values()],files,ownerOf,mySide)){
  if(row.side!==mySide||row.name.toLowerCase()==='haggis')continue;
  const prior=byName.get(row.name.toLowerCase());
  if(prior&&(isLocalServer(prior.server)||prior.at===row.at))continue;
  if(prior)out.delete(prior.name);
  const file=files.find(s=>s.side===row.side);
  out.set(row.name,{...snapshotObservation(row,file?.at,now),side:row.side,role:'unknown',goal:'',snapshotOnly:true});
 }
 return out;
}
// A leftover local file, credential or assignment cannot hide an account's current owner's published live row.
// Snapshots are canonical before this projection. Keep local candidates when the shared observation is unavailable.
export function localDisplayNames(names:Iterable<string>,snapshots:any[],ownerOf:(name:string)=>string|undefined,mySide:string,now:number){
 const shared=new Set<string>();
 for(const s of snapshots){
  if(typeof s?.side!=='string'||s.side===mySide||!Array.isArray(s.accounts))continue;
  for(const a of s.accounts){
   if(typeof a?.name!=='string'||a.name.toLowerCase()==='haggis'||a.practice||a.server!=='rs-sdk-demo.fly.dev'
    ||!Number.isFinite(a.at)||a.at<=0||a.at>now)continue;
   const owner=ownerOf(a.name);
   if(owner&&owner!==mySide)shared.add(a.name.toLowerCase());
  }
 }
 const distinct=new Map<string,string>();
 for(const name of names)if(!shared.has(name.toLowerCase())&&!distinct.has(name.toLowerCase()))distinct.set(name.toLowerCase(),name);
 return new Set(distinct.values());
}
// The other sides' accounts as fleet rows, preserving the observations and their own ages from the snapshot.
// A row is fresh while the feed saw the account in the last 30 seconds; snapshot position never proves it is online.
// An account that moved from one side to another is in two snapshots until the old side syncs again: the row is the
// one with the newer account time, so the fleet has one row for each name.
export function remoteBots(snapshots:any[],localNames:ReadonlySet<string>,roster:ReadonlyMap<string,Seen>,firstSeen:ReadonlyMap<string,number>,now:number,mySide='local',plans:any[]=[],ownerOf:OwnerOf=()=>undefined){
 const rows:any[]=[],place=new Map<string,number>(),time=(r:any)=>r.at??r.snapshotAt??0;
 const jobsBySide=plans.length?publishedJobsBySide(plans,now):new Map();
 for(const s of snapshots){
  if(!s||typeof s.side!=='string'||s.side===mySide||!Array.isArray(s.accounts))continue;
  for(const a of s.accounts){
   const name=String(a?.name??'');if(!/^[A-Za-z0-9]{1,12}$/.test(name)||name.toLowerCase()==='haggis'||localNames.has(name.toLowerCase()))continue;
   const observation=snapshotObservation(a,s.at,now),{at,pos}=observation;
   const live=roster.get(name.toLowerCase()),inWorld=!!live&&dated(live.seen,now)&&now-live.seen<30_000;
   const useFeed=!!live&&dated(live.seen,now)&&(inWorld||!pos||at===null||live.seen>=at);
   const planJob=publishedJob(jobsBySide,s.side,name,ownerOf);
   const row:any={...observation,side:s.side,remote:true,
    role:null,goal:null,planJob,currentGoal:planJob?.goal?`${planJob.enabled?'Planned':'Disabled'}: ${planJob.goal}`:'',
    pos:useFeed?{x:live!.x,z:live!.z,level:live!.level}:pos,live:inWorld?live:null,combat:useFeed?live!.combat:observation.combat,
    fresh:inWorld,inWorld,operation:inWorld?'observed':'offline',practice:false,reserved:false,
    seenInFeed:firstSeen.has(name.toLowerCase()),lastSeen:Math.max(at??0,dated(live?.seen,now)?live!.seen:0)||null};
   const index=place.get(name.toLowerCase());
   if(index===undefined){place.set(name.toLowerCase(),rows.length);rows.push(row);}else if(time(row)>time(rows[index]))rows[index]=row;
  }
 }
 return rows;
}
