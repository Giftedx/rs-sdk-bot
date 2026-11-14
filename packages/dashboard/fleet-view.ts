// Read-only projections of two files the coordinator and the fleet agent write, for the page's board progress and
// fleet sides plugins: .practice/coordinator/scoreboard.json (coverage per skill, quests and items, with the list of
// what remains) and the fleet-data branch's fleet/snapshots/<side>.json, fleet/orders/*.json and fleet/receipts/*.json
// (each side's last sync and the cross-side orders not yet done; scripts/fleet-trade.ts keeps an order file after it is done).
import {terminalTradeReceipt,tradeSettlement,validOrder} from '../../scripts/fleet-trade-settlement';
import {fleetStatusRows,type OwnerOf} from '../core/src/fleet-snapshots';
import {isLocalServer} from '../core/src/localserver';

export const SIDE_SYNC_MS=10*60_000;

export function scoreboardView(raw:any){
 if(!raw||!Array.isArray(raw.skills)||!raw.progress)return{available:false};
 const at=Date.parse(raw.at);
 return{available:true,at:Number.isFinite(at)?at:null,
  remaining:(raw.progress.remaining??[]).map(String),done:raw.progress.done===true,
  skillLevels:raw.progress.skillLevels??null,skills99:raw.progress.skills99??null,
  quests:{live:raw.progress.questsLive??null,total:raw.progress.questTotal??null},
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
   total:Array.isArray(a.skills)?a.skills.filter((k:any)=>k?.name!=='Overall').reduce((n:number,k:any)=>n+(Number(k.level)||0),0):null,
   coins:coinsIn(a.bank)+coinsIn(a.inventory)})).sort((x:any,y:any)=>x.name.localeCompare(y.name))}))
  .sort((a,b)=>(a.side==='local'?-1:b.side==='local'?1:a.side.localeCompare(b.side)));
 const state=(order:any)=>{
  const rows=receipts.filter(r=>r?.id===order.id);
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

type Seen={x:number;z:number;level:number;combat:number;seen:number};
const dated=(at:any,now:number)=>Number.isFinite(at)&&at>0&&at<=now;
function snapshotObservation(a:any,snapshotAt:any,now:number){
 const at=dated(a.at,now)?a.at:null,observedAt=(value:any)=>at!==null&&dated(value,now)&&value<=at?value:null;
 return{name:String(a.name??''),server:String(a.server??''),at,snapshotAt:dated(snapshotAt,now)?snapshotAt:null,
  skills:Array.isArray(a.skills)?a.skills.map((k:any)=>({name:String(k.name),level:Number(k.level)||1,xp:Number.isFinite(k.xp)&&k.xp>=0?k.xp:null,...(Number.isSafeInteger(k.currentLevel)&&k.currentLevel>=0?{currentLevel:k.currentLevel}:{})})):[],
  inventory:Array.isArray(a.inventory)?a.inventory:null,equipment:Array.isArray(a.equipment)?a.equipment:null,bank:Array.isArray(a.bank)?a.bank:null,bankAt:Array.isArray(a.bank)?observedAt(a.bankAt):null,
  equipmentObserved:Array.isArray(a.equipment)&&a.equipmentObserved===true,
  quests:Array.isArray(a.questJournal)?a.questJournal:null,questsAt:observedAt(a.questsAt),guildFacts:a.guildFacts??null,
  pos:a.pos&&[a.pos.x,a.pos.z,a.pos.level].every(Number.isSafeInteger)&&a.pos.level>=0&&a.pos.level<=3?a.pos:null,
  combat:Number.isSafeInteger(a.combat)&&a.combat>0?a.combat:null};
}
function publishedJob(plans:any[],side:string,name:string,ownerOf:OwnerOf,now:number){
 const owner=ownerOf(name);
 if(name.toLowerCase()==='haggis'||owner&&owner!==side)return null;
 const plan=plans.filter(p=>p?.side===side&&Array.isArray(p.jobs)&&dated(p.at,now)&&now-p.at<=3*SIDE_SYNC_MS)
  .sort((a,b)=>b.at-a.at)[0];
 const jobs=(plan?.jobs??[]).filter((j:any)=>j&&typeof j==='object'&&[j.account,...(Array.isArray(j.accounts)?j.accounts:[])]
  .some(n=>typeof n==='string'&&n.toLowerCase()===name.toLowerCase()));
 const job=jobs.find((j:any)=>j.enabled!==false&&typeof j.script==='string')??jobs[jobs.length-1];
 return job?{account:name,side,at:plan.at,state:'configured',
  script:typeof job.script==='string'?job.script:null,goal:typeof job.goal==='string'?job.goal:null,
  role:typeof job.role==='string'?job.role:null,enabled:job.enabled!==false}:null;
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
 for(const s of snapshots){
  if(!s||typeof s.side!=='string'||s.side===mySide||!Array.isArray(s.accounts))continue;
  for(const a of s.accounts){
   const name=String(a?.name??'');if(!/^[A-Za-z0-9]{1,12}$/.test(name)||name.toLowerCase()==='haggis'||localNames.has(name.toLowerCase()))continue;
   const observation=snapshotObservation(a,s.at,now),{at,pos}=observation;
   const live=roster.get(name.toLowerCase()),inWorld=!!live&&dated(live.seen,now)&&now-live.seen<30_000;
   const useFeed=!!live&&dated(live.seen,now)&&(inWorld||!pos||at===null||live.seen>=at);
   const planJob=publishedJob(plans,s.side,name,ownerOf,now);
   const row:any={...observation,side:s.side,remote:true,
    role:null,goal:null,planJob,currentGoal:planJob?.goal?`${planJob.enabled?'Planned':'Disabled'}: ${planJob.goal}`:'',
    pos:useFeed?{x:live!.x,z:live!.z,level:live!.level}:pos,live:inWorld?live:null,combat:useFeed?live!.combat:observation.combat,
    fresh:inWorld,inWorld,operation:inWorld?'observed':'offline',practice:false,reserved:false,
    seenInFeed:firstSeen.has(name.toLowerCase()),lastSeen:live?.seen??null};
   const index=place.get(name.toLowerCase());
   if(index===undefined){place.set(name.toLowerCase(),rows.length);rows.push(row);}else if(time(row)>time(rows[index]))rows[index]=row;
  }
 }
 return rows;
}
