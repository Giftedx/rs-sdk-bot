// Finite non-combat prerequisite: owned Catherby kit, two Wydin cheese, Varrock East bank.
// Usage: bun scripts/pvp-kit-stage.ts <account> [CAP=1800]. No training or Wilderness entry.
import {existsSync} from 'node:fs';
import {openBot,finish,accountOf} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {equipmentObserved} from '../packages/core/src/container-observation';
import {depositObserved} from '../packages/core/src/deposit';
import {planTripOffThread} from '../packages/core/src/route-plan';
import {walkRoute} from '../packages/core/src/walk';
import {routeFares} from '../packages/core/src/world';
import {buyWithBudget} from './shop-buyer';

type Item={id:number;count:number};
const count=(items:readonly Item[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const totals=(items:readonly Item[])=>{const m=new Map<number,number>();for(const i of items)m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
const KIT=[[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[44,3]] as const;
export function kitStageAccounting(before:readonly Item[],after:readonly Item[],spent:number){
 const a=totals(before),b=totals(after);
 return Number.isSafeInteger(spent)&&spent>=0&&spent<=108&&(b.get(995)??0)>=8244&&
  [...new Set([...a.keys(),...b.keys()])].every(id=>(b.get(id)??0)===(a.get(id)??0)+(id===995?-spent:id===1985?2:0));
}
export async function runKitStage(s:Session,cap=1800,stop=()=>false){
 if(!Number.isSafeInteger(cap)||cap<1||cap>2000)throw Error('kit stage CAP must be1..2000');
 const state=()=>s.sdk.getState(),inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),p=()=>state()?.player;
 if(!await waitUntil(s,()=>!!p()&&state()?.skills.length===21&&!!s.client&&equipmentObserved(s.client),{timeoutTicks:20}))throw Error('kit stage initial observations missing');
 const born={...p()!},start=s.tick(),hpStart=born.hp,initialXp=JSON.stringify(state()!.skills.map(i=>[i.name,i.experience]));
 if(born.level!==0||Math.max(Math.abs(born.worldX-2807),Math.abs(born.worldZ-3441))>3||hpStart!==10||eq().length)throw Error('kit stage needs fullHP10 Catherby bank start and empty equipment');
 let ended=false,hpMin=hpStart,failure='',spent=0,fares=0,foodSpent=0,bought=0;
 let decks:{x:number;z:number;level:number}[]=[];
 void s.ended.then(()=>{ended=true;});
 const cancel=new AbortController();
 const unsafe=()=>{
  const q=p();hpMin=Math.min(hpMin,q?.hp??0);
  return ended||!q||q.hp!==hpStart||q.isDead||(q.respawnCount??0)!==(born.respawnCount??0)||
   born.lifeId!==undefined&&q.lifeId!==born.lifeId||q.worldZ>=3520||q.level!==0&&!decks.some(t=>q.level===t.level+1&&Math.max(Math.abs(q.worldX-t.x),Math.abs(q.worldZ-t.z))<=12)||s.tick()-start>=cap||stop()||existsSync('.practice/stop-'+s.name);
 };
 const check=()=>{if(unsafe())throw Error('kit stage health/life/route/deadline/stop gate');};
 const off=s.onTick(()=>{if(unsafe())cancel.abort('kit stage safety gate');});
 let bank:Item[]=[],initial:Item[]=[],final:Item[]=[];
 const open=async()=>{
  check();const g=s.bankObservation?.()?.generation??0;
  if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank?.isOpen&&(s.bankObservation?.()?.generation??0)>g,{timeoutTicks:15}))throw Error('kit stage fresh bank missing');
  bank=s.bankObservation!()!.items.map(i=>({...i}));
 };
 const close=async()=>{await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank?.isOpen,{timeoutTicks:5}))throw Error('kit stage bank close unobserved');};
 const deposit=async()=>{for(const id of new Set(inv().map(i=>i.id))){check();await depositObserved(s,inv().find(i=>i.id===id)!);}bank=s.bankObservation!()!.items.map(i=>({...i}));};
 const assets=()=>[...bank,...inv(),...eq()].map(i=>({id:i.id,count:i.count}));
 const travel=async(x:number,z:number)=>{
  check();const q=p()!,actor=accountOf(s),cash=count(inv(),995);
  const plan=await planTripOffThread({x:q.worldX,z:q.worldZ,level:q.level},{x,z,level:0},
   {...actor,skills:{...actor.skills,magic:0},items:[],counts:{},worn:[],coins:cash});
  check();
  if(!plan||plan.bank||plan.legs.some(l=>l.kind==='travel'&&(l.travel.runes.length||l.travel.needs.some(n=>'held' in n))))throw Error('kit stage cash-only route unavailable');
  const fare=routeFares(plan.legs);
  if(fare>cash||spent+fare>108)throw Error('kit stage fare budget refused');
  decks=plan.legs.flatMap(l=>l.kind==='travel'&&l.travel.kind==='boat'&&l.travel.run.how==='npc'&&l.travel.run.deck?[l.travel.to]:[]);
  let r;try{r=await walkRoute(s,plan.legs,{signal:cancel.signal,legTimeoutTicks:100,maxRetriesPerLeg:1});}finally{decks=[];}
  const debit=cash-count(inv(),995);spent+=debit;fares+=debit;check();
  if(!r.ok||debit!==fare||Math.max(Math.abs(p()!.worldX-x),Math.abs(p()!.worldZ-z))>2)throw Error('kit stage route/fare effect unobserved '+JSON.stringify(r));
 };
 try{
  await open();initial=assets();
  if(count(initial,995)!==8352||count(initial,1985)!==0||!KIT.every(([id,n])=>count(bank,id)>=n)||inv().some(i=>i.id!==995))throw Error('kit stage exact funded stock prerequisite changed');
  await deposit();
  const cash=state()!.bank.items.find(i=>i.id===995)!;
  const g=s.bankObservation!()!.generation;
  await s.bot.withdrawItem(cash,108,{asNote:false});
  if(!await waitUntil(s,()=>count(inv(),995)===108&&(s.bankObservation?.()?.generation??0)>g&&count(s.bankObservation!()!.items,995)===8244,{timeoutTicks:10}))throw Error('kit stage travel float unobserved');
  // The walk ends at the shop's east side and a Trade lets the server path to Wydin. walkTo (the final walk leg
  // and bot.openShop) opens any door beside its waypoints: Wydin's staff door at 3012,3204, beside the counter,
  // starts his apron dialogue, which costs about 1,000 bench ticks (pvp:stage-kit seeds 1, 4 and 5). Wydin wanders
  // 5 tiles from 3014,3204, into the staff room too: there no Trade reaches him (seed 6 stood at 3013,3206), so
  // the Trade waits until the client can path to him and is sent again until the shop opens.
  await close();await travel(3019,3208);check();
  const shopDeadline=s.tick()+120;
  while(!state()?.shop?.isOpen){
   check();if(s.tick()>=shopDeadline)throw Error('kit stage Wydin unavailable');
   const wydin=state()?.nearbyNpcs.find(n=>/^wydin$/i.test(n.name)),trade=wydin?.optionsWithIndex.find(o=>/^trade$/i.test(o.text));
   if(!wydin||!trade||wydin.reachable===false){await waitTicks(s,2);continue;}
   if((await s.sdk.sendInteractNpc(wydin.index,trade.opIndex)).success)await waitUntil(s,()=>!!state()?.shop?.isOpen,{timeoutTicks:8});
  }
  const shelf=state()?.shop?.shopItems.find(i=>i.id===1985);
  if(!shelf||shelf.count<2)throw Error('kit stage two cheese not on shelf');
  console.log('KIT_STAGE_SHELF '+JSON.stringify(shelf));
  const purchase=await buyWithBudget(s.bot,s.sdk,shelf.name,2,0,Math.min(48,108-spent));
  bought=purchase.bought;foodSpent=purchase.spent;spent+=foodSpent;
  if(bought!==2||count(inv(),1985)!==2||foodSpent<=0)throw Error('kit stage cheese debit/credit missing');
  await s.bot.closeShop();if(!await waitUntil(s,()=>!state()?.shop?.isOpen,{timeoutTicks:5}))throw Error('kit stage shop close missing');
  await travel(3253,3421);await open();await deposit();final=assets();await close();check();
 }catch(e){failure=String(e);}finally{off();}
 const xpPreserved=JSON.stringify(state()?.skills.map(i=>[i.name,i.experience]))===initialXp;
 const accounting=initial.length>0&&final.length>0&&kitStageAccounting(initial,final,spent);
 const q=p(),atBank=!!q&&q.level===0&&Math.max(Math.abs(q.worldX-3253),Math.abs(q.worldZ-3421))<=2;
 const ok=!failure&&accounting&&xpPreserved&&atBank&&bought===2&&hpMin===10&&!unsafe()&&eq().length===0&&inv().length===0;
 return{ok,ticks:s.tick()-start,spent,fares,foodSpent,bought,hpMin,xpPreserved,accounting,atBank,initial,final,position:q&&{x:q.worldX,z:q.worldZ,level:q.level},failure};
}
if(import.meta.main){let stopped=false;const s=await openBot(process.argv[2]!,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,String(e)));try{
 const r=await runKitStage(s,Number(process.argv[3]??1800),()=>stopped);console.log('KIT_STAGE_RESULT '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));
}catch(e){await finish([s],false,String(e));}}
