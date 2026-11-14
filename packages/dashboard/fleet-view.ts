// Read-only projections of two files the coordinator and the fleet agent write, for the page's board progress and
// fleet sides plugins: .practice/coordinator/scoreboard.json (coverage per skill, quests and items, with the list of
// what remains) and the fleet-data branch's fleet/snapshots/<side>.json, fleet/orders/*.json and fleet/receipts/*.json
// (each side's last sync and the cross-side orders not yet done; scripts/fleet-trade.ts keeps an order file after it is done).
import {terminalTradeReceipt,tradeSettlement,validOrder} from '../../scripts/fleet-trade-settlement';

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
 return new Set([...names].filter(name=>!shared.has(name.toLowerCase())));
}
// The other sides' accounts as fleet rows, preserving the observations and their own ages from the snapshot.
// A row is fresh while the feed saw the account in the last 30 seconds; snapshot position never proves it is online.
// An account that moved from one side to another is in two snapshots until the old side syncs again: the row is the
// one with the newer account time, so the fleet has one row for each name.
export function remoteBots(snapshots:any[],localNames:ReadonlySet<string>,roster:ReadonlyMap<string,Seen>,firstSeen:ReadonlyMap<string,number>,now:number,mySide='local'){
 const rows:any[]=[],place=new Map<string,number>(),time=(r:any)=>r.at??r.snapshotAt??0;
 const dated=(at:any)=>Number.isFinite(at)&&at>0&&at<=now;
 for(const s of snapshots){
  if(!s||typeof s.side!=='string'||s.side===mySide||!Array.isArray(s.accounts))continue;
  for(const a of s.accounts){
   const name=String(a?.name??'');if(!/^[A-Za-z0-9]{1,12}$/.test(name)||localNames.has(name.toLowerCase()))continue;
   const at=dated(a.at)?a.at:null,observedAt=(value:any)=>at!==null&&dated(value)&&value<=at?value:null;
   const live=roster.get(name.toLowerCase()),inWorld=!!live&&dated(live.seen)&&now-live.seen<30_000;
   const pos=a.pos&&[a.pos.x,a.pos.z,a.pos.level].every(Number.isSafeInteger)&&a.pos.level>=0&&a.pos.level<=3?a.pos:null;
   const useFeed=!!live&&dated(live.seen)&&(inWorld||!pos||at===null||live.seen>=at);
   const row:any={name,server:String(a.server??''),side:s.side,remote:true,at,snapshotAt:dated(s.at)?s.at:null,
    role:null,goal:null,currentGoal:'',
    skills:Array.isArray(a.skills)?a.skills.map((k:any)=>({name:String(k.name),level:Number(k.level)||1,xp:Number.isFinite(k.xp)&&k.xp>=0?k.xp:null,...(Number.isSafeInteger(k.currentLevel)&&k.currentLevel>=0?{currentLevel:k.currentLevel}:{})})):[],
    inventory:Array.isArray(a.inventory)?a.inventory:null,equipment:Array.isArray(a.equipment)?a.equipment:null,bank:Array.isArray(a.bank)?a.bank:null,bankAt:Array.isArray(a.bank)?observedAt(a.bankAt):null,
    equipmentObserved:Array.isArray(a.equipment)&&a.equipmentObserved===true,
    quests:Array.isArray(a.questJournal)?a.questJournal:null,questsAt:observedAt(a.questsAt),guildFacts:a.guildFacts??null,
    pos:useFeed?{x:live!.x,z:live!.z,level:live!.level}:pos,live:inWorld?live:null,combat:useFeed?live!.combat:Number.isSafeInteger(a.combat)&&a.combat>0?a.combat:null,
    fresh:inWorld,inWorld,operation:inWorld?'observed':'offline',practice:false,reserved:false,
    seenInFeed:firstSeen.has(name.toLowerCase()),lastSeen:live?.seen??null};
   const index=place.get(name.toLowerCase());
   if(index===undefined){place.set(name.toLowerCase(),rows.length);rows.push(row);}else if(time(row)>time(rows[index]))rows[index]=row;
  }
 }
 return rows;
}
