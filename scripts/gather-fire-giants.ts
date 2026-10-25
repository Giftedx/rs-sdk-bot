// Phase 1: reclaim OWN Glarial amulet, bank it, restore original kit. Fire-giant combat remains gated.
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitTicks,waitUntil} from '../packages/core/src/ticks';
import {sessionWalker,walkPath,type PathPoint} from '../packages/core/src/walk';
import {guardCowWalker} from './gather-combat';
const BANK={x:2619,z:3332},FOOD=329,PEBBLE=294,AMULET=295;
export function fireHomeEntryPoints(p:{x:number;z:number;level:number}):PathPoint[]{
 if(p.level!==0)throw new Error('Fire reclaim entry requires a known surface bank');
 if(Math.max(Math.abs(p.x-BANK.x),Math.abs(p.z-BANK.z))<=3)return [];
 if(Math.max(Math.abs(p.x-2655),Math.abs(p.z-3283))<=3)return [{x:2644,z:3293,tol:0},{...BANK,tol:0}];
 throw new Error('Fire reclaim entry requires actual Ardy South or North bank');
}
export function reclaimAssetsValid(before:ReadonlyMap<number,number>,after:ReadonlyMap<number,number>,eaten:number){
 return Number.isSafeInteger(eaten)&&eaten>=0&&[...new Set([...before.keys(),...after.keys(),AMULET])].every(id=>(after.get(id)??0)===(before.get(id)??0)+(id===AMULET?1:0)-(id===FOOD?eaten:0));
}
export function reclaimInputs(items:readonly {id:number;count:number}[]){const n=(id:number)=>items.filter(i=>i.id===id).reduce((a,i)=>a+i.count,0);return n(PEBBLE)>=1&&n(FOOD)>=16&&n(AMULET)===0;}
// BotActions.withdrawItem(number) means BANK SLOT, not item ID. Keep the actual
// slotted BankItem and cross-check its count against the fresh bank observation.
export async function withdrawFireOwned(s:Session,id:number,amount:number){
 const n=()=>s.sdk.getInventory().filter(i=>i.id===id).reduce((v,i)=>v+i.count,0),before=n();
 const observed=s.bankObservation?.(),summary=observed?.items.find(i=>i.id===id),item=s.sdk.getState()?.bank.items.find(i=>i.id===id);
 if(!summary||!item||summary.count<amount||item.count<amount||summary.count!==item.count)throw new Error(`no fire access progress: OWN bank item/count unknown ${id}:${amount}`);
 if(!(await s.bot.withdrawItem(item,amount,{asNote:false})).success||!await waitUntil(s,()=>n()===before+amount,{timeoutTicks:10}))throw new Error(`no fire access progress: OWN withdrawal unobserved ${id}:${amount}`);
}
export async function runFireReclaim(s:Session,o:{cap:number;stop?:()=>boolean}){
 const start=s.tick(),state=()=>s.sdk.getState(),pos=()=>state()?.player,inv=()=>s.sdk.getInventory(),eq=()=>s.sdk.getEquipment(),hp=()=>s.sdk.getSkill('Hitpoints')?.level??0;
 const n=(a:readonly {id:number;count:number}[],id:number)=>a.filter(i=>i.id===id).reduce((v,i)=>v+i.count,0),held=(id:number)=>n(inv(),id);
 const p0=pos();if(!p0||p0.level!==0||hp()<60)throw new Error('no fire access progress: require mature Mighty surface HP>=60');
 const originalHeld=inv().map(i=>({id:i.id,count:i.count})),originalWorn=eq().map(i=>({id:i.id,count:i.count,slot:i.slot}));
 let ended=false,died=false,eaten=0,hpMin=hp(),failure='',banked=false,amuletObserved=false,kitRestored=false,initial:Map<number,number>|undefined,eating:Promise<void>|undefined,foodFailure='';
 void s.ended.then(()=>{ended=true;});
 const over=()=>ended||died||!!o.stop?.()||s.tick()-start>=o.cap;
 const totals=()=>{const m=new Map<number,number>();for(const i of [...inv(),...eq(),...(s.bankObservation?.()?.items??[])])m.set(i.id,(m.get(i.id)??0)+i.count);return m;};
 const eat=async()=>{const item=inv().find(i=>i.id===FOOD),before=held(FOOD),h=hp();if(!item)throw new Error('no fire access progress: owned Salmon exhausted');await s.bot.eatFood(item);await waitUntil(s,()=>held(FOOD)<before&&hp()>h||died||ended,{timeoutTicks:6});eaten+=Math.max(0,before-held(FOOD));if(held(FOOD)!==before-1||hp()<=h)throw new Error('no fire access progress: Salmon debit/heal unobserved');};
 const off=s.onTick(()=>{const p=pos();if(hp()>0)hpMin=Math.min(hpMin,hp());if(hp()<=0||p?.isDead||p?.lifeId!==p0.lifeId||(p?.respawnCount??0)>(p0.respawnCount??0))died=true;if(hp()>0&&hp()<=40&&!eating&&!ended&&!died&&held(FOOD)>0){eating=eat().catch(e=>{foodFailure=String(e);}).finally(()=>{eating=undefined;});}});
 const guard=async()=>{if(eating)await eating;if(over()||foodFailure||hp()<=20)throw new Error(`no fire access progress: ${foodFailure||(died?'died':over()?'stop/cap/session-ended':'unsafe HP')}`);};
 const walk=async(x:number,z:number,tol=1,entry?:PathPoint[])=>{await guard();const base=await sessionWalker(s),p=pos()!,bearRoute=p.worldZ<4000&&z<4000&&(p.worldZ<3390||z<3390),plans:{level:number;from:{x:number;z:number};to:{x:number;z:number};corners:{x:number;z:number}[]}[]=[];
  const traced={...base,plan:(level:number,from:{x:number;z:number},to:{x:number;z:number})=>{const corners=base.plan(level,from,to);plans.push({level,from:{...from},to:{...to},corners:corners.map(c=>({...c}))});if(plans.length>16)plans.shift();return corners;}};
  let deps=traced,why:()=>string|null=()=>null;const points=entry??[{x,z,tol}];
  if(bearRoute){const g=guardCowWalker(traced,()=>over()||hp()<=20?'fire access stop/HP':null);deps=g.deps;why=g.reason;}
  const r=await walkPath(deps,points,{maxTicks:Math.min(250,Math.max(1,o.cap-(s.tick()-start))),look:4,stop:()=>over()||hp()<=20||!!foodFailure});if(!r.ok||why()){console.log('FIRE_ROUTE_REFUSED '+JSON.stringify({from:[p.worldX,p.worldZ,p.level],points,reason:why()??r.detail,plans}));throw new Error(`no fire access progress: walk ${why()??r.detail}`);}await guard();};
 const open=async()=>{await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??0;if(!state()?.bank.isOpen){if(!(await s.bot.openBank()).success||!await waitUntil(s,()=>!!state()?.bank.isOpen&&(s.bankObservation?.()?.generation??0)>gen,{timeoutTicks:15}))throw new Error('no fire access progress: fresh bank unavailable');}if(!s.bankObservation?.())throw new Error('no fire access progress: bank unknown');};
 const deposit=async()=>{await open();for(const id of new Set(inv().map(i=>i.id))){const item=inv().find(i=>i.id===id);if(!item)continue;const before=n(s.bankObservation!()!.items,id),amount=held(id);if(!(await s.bot.depositItem(item,-1)).success||!await waitUntil(s,()=>held(id)===0&&n(s.bankObservation!()!.items,id)===before+amount,{timeoutTicks:10}))throw new Error(`no fire access progress: deposit mismatch ${id}`);}};
 const withdraw=async(id:number,amount:number)=>{await open();await withdrawFireOwned(s,id,amount);};
 const close=async()=>{await s.bot.closeBank();if(!await waitUntil(s,()=>!state()?.bank.isOpen,{timeoutTicks:5}))throw new Error('no fire access progress: bank close');};
 const prayer=()=>state()?.prayers?.prayerPoints??0;
 const setPrayer=async(active:boolean)=>{await s.bot.dismissBlockingUI();if(state()?.prayers?.activePrayers[14]!==active)await s.direct({type:'togglePrayer',prayerIndex:14,reason:'Fire access protection'});if(!await waitUntil(s,()=>state()?.prayers?.activePrayers[14]===active,{timeoutTicks:8}))throw new Error('no fire access progress: protection unobserved');};
 const loc=(id:number,x:number,z:number)=>state()?.nearbyLocs.find(l=>l.id===id&&l.x===x&&l.z===z);
 const op=async(l:{id:number;x:number;z:number},re:RegExp)=>{const current=loc(l.id,l.x,l.z),option=current?.optionsWithIndex.find(o=>re.test(o.text));if(!current||!option)throw new Error(`no fire access progress: observed loc/op missing ${l.id}`);await s.sdk.sendInteractLoc(l.x,l.z,l.id,option.opIndex);};
 const inTomb=()=>!!pos()&&pos()!.worldZ>=9795&&pos()!.worldZ<=9850&&pos()!.worldX>=2520&&pos()!.worldX<=2560;
 const leaveTomb=async()=>{if(!inTomb())return;await walk(2556,9844,1);const ladder=state()?.nearbyLocs.find(l=>/ladder/i.test(l.name)&&Math.max(Math.abs(l.x-2556),Math.abs(l.z-9844))<=2&&l.optionsWithIndex.some(o=>/climb.up/i.test(o.text)));if(!ladder)throw new Error('no fire access progress: tomb exit ladder absent');await op(ladder,/climb.up/i);if(!await waitUntil(s,()=>!!pos()&&pos()!.worldZ<4000,{timeoutTicks:20}))throw new Error('no fire access progress: tomb exit unobserved');};
 const rawQuest=(s.client as {var?:number[]}|undefined)?.var?.[65];const questEvidence={rawClient65:Number.isFinite(rawQuest)?rawQuest:null,packetVerified:false,historicalCompleted:true,note:'SDK has no quest varps; raw client slot can be default/untransmitted. Historical Waterfall milestones10 is the completion hypothesis, not fresh client proof.'};
 console.log('FIRE_ACCESS_INITIAL '+JSON.stringify({pos:p0,hp:hp(),originalHeld,originalWorn,questEvidence}));
 try{
  const entry=fireHomeEntryPoints({x:p0.worldX,z:p0.worldZ,level:p0.level});console.log('FIRE_HOME_ENTRY '+JSON.stringify({home:BANK,points:entry}));if(entry.length)await walk(BANK.x,BANK.z,0,entry);await open();initial=totals();if(!reclaimInputs([...inv(),...eq(),...s.bankObservation!()!.items]))throw new Error('no fire access progress: need OWN pebble+16Salmon and missing amulet');
  await deposit();await close();for(const item of [...eq()]){await s.bot.unequipItem(item);if(!await waitUntil(s,()=>!eq().some(i=>i.id===item.id),{timeoutTicks:8}))throw new Error('no fire access progress: worn gear not removed');}await deposit();await withdraw(PEBBLE,1);await withdraw(FOOD,16);await close();
  if(state()?.autoRetaliateEnabled===true)await s.direct({type:'clickComponent',componentId:151,reason:'Fire access auto-retaliate OFF'});if(!await waitUntil(s,()=>state()?.autoRetaliateEnabled===false,{timeoutTicks:8}))throw new Error('no fire access progress: auto-retaliate OFF absent');
  await walk(2617,3309,1);const altar=state()?.nearbyLocs.find(l=>l.id===409&&Math.max(Math.abs(l.x-2617),Math.abs(l.z-3309))<=1);if(!altar)throw new Error('no fire access progress: altar409 absent');await op(altar,/pray/i);if(!await waitUntil(s,()=>prayer()>=(s.sdk.getSkill('Prayer')?.baseLevel??43),{timeoutTicks:10}))throw new Error('no fire access progress: altar recharge unobserved');
  await walk(2558,3444,1);await setPrayer(true);const pebble=inv().find(i=>i.id===PEBBLE);if(!pebble)throw new Error('owned pebble vanished');await s.sdk.sendUseItemOnLoc(pebble.slot,2558,3444,1992);if(!await waitUntil(s,()=>inTomb()||died,{timeoutTicks:20})||!inTomb())throw new Error('no fire access progress: pebble/tomb entry unobserved');
  if(prayer()<15)throw new Error('no fire access progress: Prayer reserve before chest');await walk(2530,9845,1);
  if(loc(1994,2530,9844)){await op({id:1994,x:2530,z:9844},/^open$/i);if(!await waitUntil(s,()=>!!loc(1995,2530,9844),{timeoutTicks:15}))throw new Error('no fire access progress: chest open absent');}
  await op({id:1995,x:2530,z:9844},/^search$/i);amuletObserved=await waitUntil(s,()=>held(AMULET)===1,{timeoutTicks:15});if(!amuletObserved)throw new Error('no fire access progress: reclaimed amulet unobserved');console.log(`FIRE_ACCESS_AMULET tick=${s.tick()-start} id=295 actual=1 prayer=${prayer()}`);
 }catch(e){failure=String(e);}
 finally{
  if(!ended&&!died&&!o.stop?.())try{await leaveTomb();await setPrayer(false);await walk(BANK.x,BANK.z,1);await deposit();
   for(const item of originalWorn)await withdraw(item.id,item.count);await close();for(const item of originalWorn){const actual=inv().find(i=>i.id===item.id);if(!actual)throw new Error('restore worn item absent');await s.bot.equipItem(actual);if(!await waitUntil(s,()=>eq().some(i=>i.slot===item.slot&&i.id===item.id),{timeoutTicks:8}))throw new Error('restore worn kit unobserved');}
   await open();for(const id of new Set(originalHeld.map(i=>i.id)))await withdraw(id,n(originalHeld,id));kitRestored=originalWorn.every(w=>eq().some(i=>i.id===w.id&&i.slot===w.slot))&&[...new Set([...originalHeld.map(i=>i.id),...inv().map(i=>i.id)])].every(id=>held(id)===n(originalHeld,id));banked=n(s.bankObservation!()!.items,AMULET)===(initial?.get(AMULET)??0)+1;
  }catch(e){failure=[failure,String(e)].filter(Boolean).join('; ');}if(eating)await eating;off();
 }
 const preserved=!!initial&&reclaimAssetsValid(initial,totals(),eaten),ok=!failure&&!ended&&!died&&amuletObserved&&banked&&kitRestored&&preserved;
 return{ok,phase:'reclaim',amuletObserved,banked,kitRestored,preserved,eaten,foodId:FOOD,hpMin,finalHp:hp(),died,ended,questEvidence,ticks:s.tick()-start,failure:failure||'-'};
}
if(import.meta.main){
 const name=process.argv[2];if(!name)throw new Error('Fire access actor required');if((process.env.FIRE_MODE??'reclaim')!=='reclaim')throw new Error('Fire combat phase not admitted: reclaim native gate first');let stopped=false;
 const s=await openBot(name,{onStop:async()=>{stopped=true;}}).catch(e=>finish([],false,`login ${String(e)}`));try{const r=await runFireReclaim(s,{cap:Number(process.env.CAP??1000),stop:()=>stopped});console.log('FIRE_ACCESS_BANK '+JSON.stringify(r));await finish([s],r.ok,`fire-access ${JSON.stringify(r)}`);}catch(e){await finish([s],false,String(e));}
}
