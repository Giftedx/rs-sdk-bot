// The two files the hosted dashboard (rs-fleet-command) reads, from the local dashboard server's own state
// (server.ts /api/state, already masked: every string has the main account's name replaced by ⟦MAIN⟧) and its
// operator metadata (/api/control). control.json is for the signed-in owner; public.json is a whitelist of the
// same data without the main account (see publicView).
import {priceName,projectItemPrices,type ItemPrice,type ItemPrices,type PriceIdentity} from './item-prices';
import {examineName,projectItemExamine,type ExamineTables} from './item-examine';

export const MAIN_ACCOUNT='Haggis';
export const MAIN_MARK='⟦MAIN⟧';
export const WHY_LIMIT=400,DETAIL_LIMIT=300,FINISHED_KEEP=200;

// Coordinator tasks are the bulk of the state (a review spec can run to kilobytes; hundreds of tasks are finished).
// The page shows a line per task: texts are capped, and only the newest FINISHED_KEEP finished tasks travel.
export function trimState(state:any){
 if(!Array.isArray(state?.coordination?.tasks))return state;
 const all=state.coordination.tasks.map((t:any)=>{
  const next:any={...t,why:String(t.why??'').slice(0,WHY_LIMIT)};
  const d=t.detail?String(t.detail).slice(0,DETAIL_LIMIT):'';
  if(d)next.detail=d;else delete next.detail;
  return next;
 });
 const open=all.filter((t:any)=>t.status==='running'||t.status==='pending');
 const finished=all.filter((t:any)=>t.status!=='running'&&t.status!=='pending').sort((a:any,b:any)=>(b.finishedAt??b.createdAt??0)-(a.finishedAt??a.createdAt??0)).slice(0,FINISHED_KEEP);
 return {...state,coordination:{...state.coordination,tasks:[...open,...finished]}};
}
const FALSE_DEFAULTS=['practice','reserved','roleInferred','processActive','training','production','phaseExact','remote','bounded','seenInFeed'] as const;
const EMPTY_DEFAULTS=['ground','spark'] as const;
const NULL_DEFAULTS=['action','eta','finish','pace','lastRes','nativeProof','xpPerTick','xpPerHour','xpLeft','goalNow','goalXp','ranksAt','bankAt','questsAt','phaseSince','snapshotAt','uptime','death','outcome','flow','planJob','job','lastSeen','live'] as const;
function compactItemList(list:any){
 if(!Array.isArray(list))return list;
 return list.map((it:any)=>{
  if(!it||typeof it!=='object'||!('baseId'in it)||it.baseId!==it.id)return it;
  const {baseId:_baseId,...rest}=it;
  return rest;
 });
}
function compactRanksList(list:any){
 if(!Array.isArray(list))return list;
 return list.map((r:any)=>{
  if(!r||typeof r!=='object')return r;
  const {hist:_hist,...rest}=r;
  if(rest.delta===0)delete rest.delta;
  if(rest.since==null)delete rest.since;
  return rest;
 });
}
function compactBotCommon(bot:any){
 if(!bot||typeof bot!=='object')return bot;
 const out:any={...bot};
 for(const k of ['inventory','equipment','bank'])if(Array.isArray(out[k]))out[k]=compactItemList(out[k]);
 if(out.flow&&typeof out.flow==='object'){
  const flow:any={...out.flow};
  for(const k of ['loot','used'])if(Array.isArray(flow[k]))flow[k]=compactItemList(flow[k]);
  out.flow=flow;
 }
 if(Array.isArray(out.ranks))out.ranks=compactRanksList(out.ranks);
 if(out.equipmentObserved===true)delete out.equipmentObserved;
 for(const k of FALSE_DEFAULTS)if(out[k]===false)delete out[k];
 for(const k of EMPTY_DEFAULTS)if(Array.isArray(out[k])&&out[k].length===0)delete out[k];
 for(const k of NULL_DEFAULTS)if(out[k]===null)delete out[k];
 if(out.result===''||out.result===null)delete out.result;
 return out;
}
function slimProgressionContext(pc:any){
 if(!pc||typeof pc!=='object')return undefined;
 const out:any={};
 if(pc.target!==undefined)out.target=pc.target;
 if(Array.isArray(pc.prayers))out.prayers=pc.prayers;
 if(pc.style&&typeof pc.style==='object'){
  const cs=pc.style;
  out.style={currentStyle:cs.currentStyle,known:cs.known,...(Array.isArray(cs.styles)?{styles:cs.styles.filter((x:any)=>x&&x.index===cs.currentStyle)}:{})};
 }
 return Object.keys(out).length?out:undefined;
}
function controlScoreboard(sb:any){
 if(!sb||typeof sb!=='object')return sb;
 const g=sb.goals;
 return {
  available:sb.available,...(sb.version!==undefined?{version:sb.version}:{}),at:sb.at,
  skillLevels:sb.skillLevels,skills99:sb.skills99,
  quests:sb.quests?{live:sb.quests.live,total:sb.quests.total}:sb.quests,
  items:sb.items?{held:sb.items.held,total:sb.items.total}:sb.items,
  done:sb.done,remaining:sb.remaining,
  ...(g?{goals:{
   version:g.version,at:g.at,
   ...(g.main?{main:{rank:g.main.rank,rankAt:g.main.rankAt}}:{main:null}),
   ...(g.specialists?{specialists:{rank1s:g.specialists.rank1s}}:{}),
   ...(g.quests?{quests:{complete:g.quests.complete,total:g.quests.total}}:{}),
   ...(g.collection?{collection:{missing:g.collection.missing}}:{}),
   ...(g.army?{army:{maxed:g.army.maxed,roster:g.army.roster}}:{}),
  }}:{}),
 };
}
function usedIcons(icons:any,roots:unknown[]){
 if(!icons||typeof icons!=='object')return icons;
 const seen=new Set<string>(),walk=(v:any)=>{
  if(Array.isArray(v))v.forEach(walk);
  else if(v&&typeof v==='object'){
   if(typeof v.name==='string')seen.add(v.name);
   if(typeof v.item==='string')seen.add(v.item);
   for(const x of Object.values(v))if(x&&typeof x==='object')walk(x);
  }
 };
 roots.forEach(walk);
 return Object.fromEntries(Object.entries(icons).filter(([k])=>seen.has(k)));
}
// Each bot row names its fleet side, so the page can show worlds. A remote row keeps the side of the snapshot it came
// from: a new cloud account can sync its snapshot before its fleet/owners.json entry arrives. Other rows use
// fleet/owners.json; an unlisted account is local.
export function withSides(state:any,owners:ReadonlyMap<string,{side:string}>){
 if(!Array.isArray(state?.bots))return state;
 return {...state,bots:state.bots.map((b:any)=>({...b,side:(b?.remote&&typeof b.side==='string'&&b.side)||(owners.get(String(b?.name??'').toLowerCase())?.side??'local')}))};
}
const CONTROL_STRIP_BOT=['inputs','progression','guildFacts','workRevision','sessionAttemptId','coordinatorRunId','doorStates'] as const;
export function controlView(state:any,controlMeta:any,main=MAIN_ACCOUNT){
 const {nonce:_nonce,...meta}=controlMeta??{};
 const s=trimState(state);
 const bots=Array.isArray(s?.bots)?s.bots.map((b:any)=>{
  const next=compactBotCommon(b);
  for(const k of CONTROL_STRIP_BOT)delete next[k];
  if('progressionContext'in next){
   const pc=slimProgressionContext(next.progressionContext);
   if(pc)next.progressionContext=pc;else delete next.progressionContext;
  }
  return next;
 }):s?.bots;
 const vault=s?.vault&&typeof s.vault==='object'?(()=>{const {items:_items,holders:_holders,log:_log,...rest}=s.vault;return rest;})():s?.vault;
 const scoreboard=s?.scoreboard?controlScoreboard(s.scoreboard):s?.scoreboard;
 const fleetSides=s?.fleetSides&&typeof s.fleetSides==='object'&&Array.isArray(s.fleetSides.orders)
  ?{...s.fleetSides,orders:s.fleetSides.orders.map(({id:_id,start:_start,late,...o}:any)=>late?{...o,late}:o)}:s?.fleetSides;
 const icons=usedIcons(s?.icons,[bots?.map((b:any)=>([b?.inventory,b?.bank,b?.equipment,b?.flow])),s?.lookups,s?.collection?.items,s?.economy?.supplies,s?.economy?.gearTargets,s?.race?.supplies,scoreboard?.goals?.collection?.missing,vault?.flow]);
 const control=controlMeta?{...meta,...(Array.isArray(meta.capabilities)?{capabilities:meta.capabilities.map((c:any)=>c&&Array.isArray(c.checks)?{...c,checks:c.checks.map(({id,phase,timeoutMs}:any)=>({id,phase,timeoutMs}))}:c)}:{})}:null;
 return {...s,...(bots!==undefined?{bots}:{}),...(vault!==undefined?{vault}:{}),...(scoreboard!==undefined?{scoreboard}:{}),...(fleetSides!==undefined?{fleetSides}:{}),...(icons!==undefined?{icons}:{}),control,revealName:main,hosted:{at:Date.now(),kind:'control'}};
}
// The public page is open to anyone with its link, rival players included. It carries a whitelist, so a new state
// field stays private until it is added here: what any player could learn in the game or on the public hiscores
// (where each bot stands, its levels, quests, worn items and ranks, other players), plus each bot's pack and goal,
// which the spectator view shows. Banks, coins and income, the plan and its strategy, scripts, jobs, pull requests of
// the private repository and this PC's resources stay with the owner (control.json).
const PUBLIC_BOT=['name','server','side','remote','practice','reserved','at','started','fresh','inWorld','operation','pos','live','hp','hpAt','combat','questPoints',
 'skills','quests','questsDone','questsStarted','questsUnknown','questsAt','equipment','equipmentObserved','inventory','ranks','ranksAt','role','goal','currentGoal','goalSkill','goalLevel',
 'goalNow','goalXp','xpPerTick','xpPerHour','xpLeft','eta','rateSkill','spark','uptime','action','death','seenInFeed','lastSeen','outcome','training','snapshotAt','ground'] as const;
const PUBLIC_KEYS=['now','questList','world','worldPlayers','boards','roster','rivals','contention','lookups','farms','icons','map','pageVersion','snapshotAt','liveTopsAt','liveTops'] as const;
// Goal texts can carry a coordinator task id ("run-x [task-1a2b]") and, after a colon or in brackets, stock counts
// ("Smithing from banked ore: 1630 bronze and 571 iron", "cooked lobsters (607 short)"): the public keeps the headline.
// A coordinator job id ("run-ranged-<account>-band50") is a file name, not a goal: the public text names its kind.
const RUN_KIND:Record<string,string>={ranged:'Ranged training',ge:'Grand Exchange trade',handoff:'item hand-off',quest:'quests'};
const publicGoal=(g:any)=>{
 if(typeof g!=='string')return g;
 const run=/^run-([a-z]+)-/.exec(g.trim());
 if(run)return RUN_KIND[run[1]!]??run[1]+' run';
 // A script file name ("magic-order.ts") reads as its words.
 if(/^[\w-]+\.ts$/.test(g.trim()))return g.trim().replace(/\.ts$/,'').replace(/[-_]+/g,' ');
 return g.replace(/\s*\[task-[^\]]*\]/g,'').split(':')[0]!.replace(/\s*\([^)]*\)/g,'').trim();
};
// The server has read the market and the board tops since it started: what the public page shows first.
// The server starts with pricesAt 0 and sets it when a market read finishes.
export const stateWarm=(s:any)=>Array.isArray(s?.rivals)&&s.rivals.length>0&&Number(s?.economy?.pricesAt)>0;
const observedAt=(at:any,now:any):number|null=>Number.isFinite(now)&&now>0&&Number.isFinite(at)&&at>0&&at<=now?at:null;
function publicQuestPoints(value:any,now:any){
 const at=observedAt(value?.at,now);
 return value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.points)&&value.points>=0&&at!==null&&(value.source==='status'||value.source==='hiscores')
  ?{points:value.points,at,source:value.source}:null;
}
function publicPrice(value:any):ItemPrice|null{
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.name!=='string'||!value.name.trim()
  ||typeof value.value!=='number'||!Number.isFinite(value.value)||value.value<0)return null;
 const quote=(n:any)=>Number.isSafeInteger(n)&&n>0?n:null;
 return{name:value.name,value:value.value,ask:quote(value.ask),bid:quote(value.bid)};
}
function publicPrices(economy:any,visible:any[]){
 const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
 const table=(raw:any,ids:boolean):Record<string,ItemPrice>=>{
  const out:Record<string,ItemPrice>=Object.create(null);
  if(record(raw))for(const [key,row]of Object.entries(raw)){
   const value=publicPrice(row),id=Number(key);
   if(value&&(ids?Number.isSafeInteger(id)&&id>=0&&String(id)===key:key!==''&&priceName(key)===key&&priceName(value.name)===key))out[key]=value;
  }
  return out;
 };
 const source={byId:table(economy?.itemPricesById,true),byName:table(economy?.itemPricesByName,false)},prices=projectItemPrices(source,visible);
 for(const id of Object.keys(prices.byId))if(!Object.hasOwn(source.byId,id))delete prices.byId[id];
 const out:{itemPricesById?:ItemPrices['byId']|null;itemPricesByName?:ItemPrices['byName']|null}={};
 if(Object.hasOwn(economy??{},'itemPricesById'))out.itemPricesById=record(economy.itemPricesById)?prices.byId:null;
 if(Object.hasOwn(economy??{},'itemPricesByName'))out.itemPricesByName=record(economy.itemPricesByName)?prices.byName:null;
 return out;
}
function publicExamines(economy:any,visible:any[]){
 const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
 const table=(raw:any,ids:boolean)=>{
  const out:Record<string,string>={};
  if(record(raw))for(const [key,value]of Object.entries(raw)){
   const id=Number(key);
   if(typeof value==='string'&&value.trim()&&(ids?Number.isSafeInteger(id)&&id>=0&&String(id)===key:key!==''&&examineName(key)===key))out[key]=value;
  }
  return out;
 };
 const source:ExamineTables={byId:table(economy?.itemExamineById,true),byName:table(economy?.itemExamineByName,false)};
 const selected=projectItemExamine(source,visible),out:any={};
 for(const field of ['itemExamineById','itemExamineByName']as const)
  if(Object.hasOwn(economy??{},field))out[field]=record(economy[field])?selected[field]:null;
 return out;
}
export function publicView(state:any,main=MAIN_ACCOUNT,expectedDrops:readonly (PriceIdentity|string)[]=[]){
 const s=trimState(state);
 const isMain=(n:any)=>n===MAIN_MARK||String(n??'').toLowerCase()===main.toLowerCase();
 const pick=(o:any,keys:readonly string[])=>Object.fromEntries(keys.filter(k=>o&&k in o).map(k=>[k,o[k]]));
 // Practice bots play on this PC's local test server, not the public world: their runs are the owner's testing.
 const bots=(s.bots??[]).filter((b:any)=>!isMain(b?.name)&&!b?.reserved&&!b?.practice).map((b:any)=>{
  const copy:any=compactBotCommon(pick(b,PUBLIC_BOT));
  if(Object.hasOwn(b,'hpAt')){const at=observedAt(copy.hpAt,s.now),accountAt=observedAt(copy.at,s.now);copy.hpAt=at!==null&&accountAt!==null&&at<=accountAt?at:null;}else delete copy.hpAt;
  if(Object.hasOwn(b,'questPoints'))copy.questPoints=publicQuestPoints(copy.questPoints,s.now);else delete copy.questPoints;
  for(const k of ['goal','currentGoal'])if(k in copy)copy[k]=publicGoal(copy[k]);
  if(copy.death)copy.death={at:copy.death.at,text:'died'};
  return copy;
 });
 const out:any=pick(s,PUBLIC_KEYS);
 // Retained data still needs a fault flag; the collector's exception can contain private paths and names.
 if(s.stateError)out.stateError='Fleet data could not be refreshed; showing the last snapshot.';
 out.bots=bots;
 // A finished or stopped run, by its goal: the run's counters (coins banked, items bought) are the owner's.
 out.results=(s.results??[]).filter((r:any)=>!isMain(r?.name)&&!r?.practice).map((r:any)=>({at:r.at,name:r.name,ok:r.ok,text:publicGoal(r.goal)??''}));
 out.events=[];out.alerts=[];
 // Market prices are public; the fleet's income and its farmers are the owner's.
 // Item values only for what a public bot carries or wears: the bank's item list is the owner's.
 const carried=new Set(bots.flatMap((b:any)=>[...(b.inventory??[]),...(b.equipment??[])]).map((i:any)=>i?.name).filter(Boolean));
 const items=(value:any)=>Array.isArray(value)?value:[];
 const groundItems=(value:any)=>items(value).flatMap((row:any)=>Array.isArray(row)
  ?row.length===5&&row.every(Number.isSafeInteger)&&row[3]>=0&&row[4]>=1?[{id:row[3]}]:[]
  :row&&typeof row==='object'?[row]:[]);
 const prices=publicPrices(s.economy,[...bots.flatMap((b:any)=>[...items(b.inventory),...items(b.equipment),...groundItems(b.ground)]),...items(s.economy?.supplies),...expectedDrops]);
 const examines=publicExamines(s.economy,bots.flatMap((b:any)=>[...items(b.inventory),...items(b.equipment)]));
 out.economy=s.economy&&typeof s.economy==='object'?{supplies:s.economy.supplies??[],pricesAt:s.economy.pricesAt??null,itemValues:Object.fromEntries(Object.entries(s.economy.itemValues??{}).filter(([n])=>carried.has(n))),itemExamine:Object.fromEntries(Object.entries(s.economy.itemExamine??{}).filter(([n])=>carried.has(n))),...prices,...examines,goldPerTick:0,farmers:[],trend:[]}:null;
 // The queue's counts and agents stay; the task texts are the agents' working notes.
 out.coordination=s.coordination&&typeof s.coordination==='object'?{available:s.coordination.available,fresh:s.coordination.fresh,paused:s.coordination.paused,counts:s.coordination.counts,agents:s.coordination.agents,tasks:[]}:null;
 // Other sides' accounts and sync times are public; their coins are bank stock.
 out.fleetSides=s.fleetSides&&Array.isArray(s.fleetSides.sides)?{at:s.fleetSides.at??null,sides:s.fleetSides.sides.map((side:any)=>({...side,accounts:(side.accounts??[]).filter((a:any)=>!isMain(a?.name)).map(({coins:_coins,...a}:any)=>a)}))}:null;
 // Other players are public game data (world feed, hiscores); the main account leaves every list.
 if(Array.isArray(out.roster))out.roster=out.roster.filter((r:any)=>!isMain(r?.[0]));
 if(Array.isArray(out.rivals))out.rivals=out.rivals.map((b:any)=>({...b,ours:isMain(b?.ours?.name)?null:b?.ours??null,rows:(b.rows??[]).filter((r:any)=>!isMain(r?.name))}));
 if(Array.isArray(out.contention))out.contention=out.contention.map((c:any)=>({...c,others:(c.others??[]).filter((n:any)=>!isMain(n)),ours:(c.ours??[]).filter((n:any)=>!isMain(n))}));
 if(out.lookups&&typeof out.lookups==='object')out.lookups=Object.fromEntries(Object.entries(out.lookups).filter(([k,v]:any)=>!isMain(k)&&!isMain(v?.name)));
 if(Array.isArray(out.farms))out.farms=out.farms.map((g:any)=>({...g,names:(g.names??[]).filter((n:any)=>!isMain(n))}));
 // An icon entry names an item. The public keeps the icons of items it can see: packs, worn items and lookups.
 if(out.icons&&typeof out.icons==='object')out.icons=usedIcons(out.icons,[out.bots.map((b:any)=>[b.inventory,b.equipment]),out.lookups]);
 out.hosted={at:Date.now(),kind:'public'};
 const text=JSON.stringify(out);
 if(new RegExp(main.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(text))throw Error('public view still names the main account; nothing published');
 return out;
}

// A published file changes every cycle through its clocks alone (`hosted.at`, `now`, each row's `at`). This is the
// file with every epoch-millisecond number (2017 to 2065) set to 0: two files are the same news when this is equal.
export const HEARTBEAT_MS=10*60_000;
export function withoutClocks(json:string):string{
 return JSON.stringify(JSON.parse(json),(_k,v)=>typeof v==='number'&&v>1.5e12&&v<3e12?0:v);
}
// Push when the content changed, or when the last push is older than the heartbeat (the page reads its age from `hosted.at`).
export function pushDue(next:string,last:{stable:string;at:number}|null,now:number):boolean{
 return !last||now-last.at>=HEARTBEAT_MS||withoutClocks(next)!==last.stable;
}
