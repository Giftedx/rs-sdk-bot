// Read-only projections of two files the coordinator and the fleet agent write, for the page's board progress and
// fleet sides plugins: .practice/coordinator/scoreboard.json (coverage per skill, quests and items, with the list of
// what remains) and the fleet-data branch's fleet/snapshots/<side>.json, fleet/orders/*.json and fleet/receipts/*.json
// (each side's last sync and the cross-side orders not yet done; scripts/fleet-trade.ts keeps an order file after it is done).
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
// An order is done when both accounts wrote a good receipt; a bad receipt marks it failed; one good receipt is half done.
export function fleetSidesView(snapshots:any[],orders:any[],now:number,receipts:any[]=[]){
 const sides=snapshots.filter(s=>s&&typeof s.side==='string'&&Array.isArray(s.accounts)).map(s=>({
  side:s.side,at:Number.isFinite(s.at)?s.at:null,late:!Number.isFinite(s.at)||now-s.at>3*SIDE_SYNC_MS,
  accounts:s.accounts.map((a:any)=>({name:String(a.name),at:Number.isFinite(a.at)?a.at:null,
   total:Array.isArray(a.skills)?a.skills.filter((k:any)=>k?.name!=='Overall').reduce((n:number,k:any)=>n+(Number(k.level)||0),0):null,
   coins:coinsIn(a.bank)+coinsIn(a.inventory)})).sort((x:any,y:any)=>x.name.localeCompare(y.name))}))
  .sort((a,b)=>(a.side==='local'?-1:b.side==='local'?1:a.side.localeCompare(b.side)));
 const state=(id:string)=>{const r=receipts.filter(x=>x&&x.id===id);if(r.some(x=>x.ok===false))return 'failed';const ok=new Set(r.filter(x=>x.ok===true).map(x=>x.role));return ok.has('from')&&ok.has('to')?'done':ok.size?'half':'open';};
 const open=orders.filter(o=>o&&typeof o.from==='string'&&typeof o.to==='string').map(o=>({id:String(o.id??''),from:o.from,to:o.to,item:String(o.item??''),count:Number(o.count)||0,start:o.start??null,end:o.end??null,state:state(String(o.id??'')),late:Number.isFinite(o.end)&&now>o.end}))
  .filter(o=>o.state!=='done').sort((a,b)=>(b.start??0)-(a.start??0));
 return{at:now,sides,orders:open};
}
