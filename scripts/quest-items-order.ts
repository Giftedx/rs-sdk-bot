// bun scripts/quest-items-order.ts <account> <quest> --save=<own-save>
// CAP bounds game ticks (default 2400). Server comes from the account's existing configuration.
// pinned pickables.rs2 op2, cow_milking.rs2 and windmills.rs2
// -> Cook pack -> adapt observed item transitions -> saved pack and quest-order consumer checks.
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,settle,getWorld,accountOf} from '../packages/core/src/bot';
import {holdSessionEater} from '../packages/core/src/sustain';
import type {Session,BankObservation} from '../packages/core/src/inprocess';
import {waitUntil} from '../packages/core/src/ticks';
import {depositObserved} from '../packages/core/src/deposit';
import {FAR_WALK_TILES,goTo,sessionWalker,walkPath,walkRoute,type PathPoint} from '../packages/core/src/walk';
import {questFlags} from '../packages/core/src/quest-status';
import {planTripOffThread} from '../packages/core/src/route-plan';
import type {Leg} from '../packages/core/src/world';
import {questSpec,savedQuest} from './quest-order';
import {readPracticeSave,waitPracticeSave} from './measure/fleet-player-save';

type Item={id:number;count:number};
type Save=ReturnType<typeof readPracticeSave>;
export const QUEST_ITEM_RECIPES={cook:{items:[1944,1927,1933],containers:[1925,1931],grain:1947},
 hetty:{items:[1957,221,2146],containers:[],grain:1947}} as const;
const total=(items:readonly Item[]|undefined,id:number)=>(items??[]).filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
export function itemRecipe(key:string){
 if(!Object.hasOwn(QUEST_ITEM_RECIPES,key))throw Error(`quest items: unknown quest ${key}`);
 return QUEST_ITEM_RECIPES[key as keyof typeof QUEST_ITEM_RECIPES];
}
export function itemEntry(key:string,save:Save){
 const recipe=itemRecipe(key),spec=questSpec(key),pack=save.inventories[93]??[];
 if(savedQuest(save,spec).done)return 'quest already complete';
 if(recipe.items.every(id=>total(pack,id)===1))return 'items already in pack';
 if(key==='cook')for(const [product,container] of [[1927,1925],[1933,1931]])
  if(!total(pack,product!)&&!total(save.inventories[95],product!)&&!total(pack,container!)&&!total(save.inventories[95],container!))return `missing container ${container}`;
 return null;
}
export function itemSaveChecks(key:string,before:Save,after:Save,travel:HettyTravelDebit[]=[]){
 const r=itemRecipe(key),spec=questSpec(key),pack=after.inventories[93]??[];
 if(key==='hetty'){
  const assets=(s:Save,id:number)=>total(s.inventories[93],id)+total(s.inventories[95],id);
  const meat=[2146,2142,2132].find(id=>assets(before,id)>0);
  const ids=new Set([before,after].flatMap(s=>[...(s.inventories[93]??[]),...(s.inventories[95]??[])].map(i=>i.id)));
  const coins=(assets(before,221)?0:3)+(meat?0:1);
  return {
   pack:r.items.every(id=>total(pack,id)===1)&&pack.every(i=>[1957,221,2146,300,995].includes(i.id)),
   quest:savedQuest(after,spec).progress===savedQuest(before,spec).progress&&savedQuest(after,spec).qp===savedQuest(before,spec).qp,
   ingredients:[1957,221].every(id=>assets(after,id)===Math.max(1,assets(before,id)))&&assets(after,2146)===Math.max(1,assets(before,2146))&&[2132,2142].every(id=>assets(after,id)===assets(before,id)-(meat===id?1:0)),
   travel:hettyTravelChecks(travel),
   coins:assets(after,995)===assets(before,995)-coins-travel.reduce((n,d)=>n+d.coins,0),
   assets:[...ids].filter(id=>![1957,221,2146,2142,2132,995].includes(id)).every(id=>assets(before,id)===assets(after,id)),
   equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
   alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
  };
 }
 const changed=new Set<number>([...r.items,...r.containers,r.grain]);
 const ids=new Set([...(before.inventories[93]??[]),...(before.inventories[95]??[]),...pack,...(after.inventories[95]??[])].map(i=>i.id));
 const assets=(s:Save,id:number)=>total(s.inventories[93],id)+total(s.inventories[95],id);
 return{
  pack:r.items.every(id=>total(pack,id)===1)&&pack.every(i=>(r.items as readonly number[]).includes(i.id)),
  quest:savedQuest(after,spec).progress===savedQuest(before,spec).progress&&savedQuest(after,spec).qp===savedQuest(before,spec).qp,
  assets:[...ids].filter(id=>!changed.has(id)).every(id=>assets(before,id)===assets(after,id)),
  containers:[[1927,1925],[1933,1931]].every(([product,container])=>assets(after,product!)>=1&&assets(after,product!)-assets(before,product!)===assets(before,container!)-assets(after,container!)),
  eggs:assets(after,1944)===Math.max(1,assets(before,1944)),
  equipment:JSON.stringify(before.inventories[94]??[])===JSON.stringify(after.inventories[94]??[]),
  alive:(after.skills.find(s=>s.index===3)?.level??0)>0,
 };
}

// Barnaby uses karamja_sailor_dialogue (sailors.rs2); customs_pay charges 30.
// Only these two ground-to-ground boats are authorized. Ship-deck walks are refused.
export type HettyTravelDebit={id:string;coins:number;packBefore:number;packAfter:number};
const barnaby='npc:captain_barnaby:brimhaven@2679,3275';
const customs=['npc:customs_officer:port-sarim@2953,3147','npc:customs_officer:port-sarim@2955,3146'];
export function hettyTravelChecks(debits:readonly HettyTravelDebit[]){
 return debits.length===0||debits.length===2&&debits[0]!.id===barnaby&&customs.includes(debits[1]!.id)&&
  debits.every(d=>d.coins===30&&Number.isSafeInteger(d.packBefore)&&d.packBefore>=30&&d.packAfter===d.packBefore-30)&&
  debits[1]!.packBefore===debits[0]!.packAfter;
}
function hettyRouteAllowed(legs:readonly Leg[]){
 const boats=legs.filter(l=>l.kind==='travel');
 return legs.every(l=>l.to.level===0&&(l.kind==='walk'||l.kind==='travel'&&l.travel.coins===30&&l.travel.kind==='boat'&&l.travel.run.how==='npc'&&l.travel.run.deck===true))&&
  (boats.length===0||boats.length===2&&boats[0]!.travel.id===barnaby&&customs.includes(boats[1]!.travel.id));
}

type Observe=(pred:()=>boolean,label:string,ticks?:number)=>Promise<void>;
// food_store.rs2 reserves door2069 for employees. Trade from the public room;
// SDK openShop's automatic walk must not pursue a wandering keeper into it.
export async function openHettyFoodShop(s:Session,observe:Observe,check:()=>void){
 const keeper=()=>(s.sdk.getState()?.nearbyNpcs??[]).find(n=>n.id===557&&/^wydin$/i.test(n.name)
  &&n.x>=3012&&n.reachable===true&&n.optionsWithIndex.some(o=>/^trade$/i.test(o.text)));
 const evidence=()=>({at:s.sdk.getState()?.player,keepers:(s.sdk.getState()?.nearbyNpcs??[])
  .filter(n=>n.id===557).map(n=>({id:n.id,index:n.index,x:n.x,z:n.z,reachable:n.reachable,options:n.optionsWithIndex})),dialog:s.sdk.getDialog()});
 try{
  await observe(()=>!!keeper(),'Hetty public Wydin',24);check();
  const npc=keeper();if(!npc)throw Error('public keeper changed');
  const trade=npc.optionsWithIndex.find(o=>/^trade$/i.test(o.text))!;
  const result=await s.sdk.sendInteractNpc(npc.index,trade.opIndex);check();
  if(!result.success)throw Error(`Trade refused: ${result.message}`);
  await observe(()=>s.sdk.getState()?.shop?.isOpen===true,'Hetty food shop open',24);
 }catch(error){
  const info=evidence();console.log('QUEST_HETTY_SHOP_FAIL '+JSON.stringify({reason:String(error),...info}));
  throw Error(`Hetty food shop refused: ${String(error)} ${JSON.stringify(info)}`);
 }
}
// windmills.rs2 debits grain BEFORE p_arrivedelay/p_delay. The SDK can return on
// that debit. Wait for the script's final message before sending another action.
// Publication IDs also distinguish messages first seen in the same game tick.
export async function operateQuestHopper(s:Session,fill:boolean,observe:Observe){
 const messages=()=>s.sdk.getState()?.gameMessages??[];
 const cursor=()=>({revision:Math.max(0,...messages().map(m=>m.observationId??0)),tick:Math.max(-1,...messages().map(m=>m.tick))});
 const fresh=(m:ReturnType<typeof messages>[number],c:ReturnType<typeof cursor>)=>m.observationId!==undefined?m.observationId>c.revision:m.tick>c.tick;
 const evidence:Record<string,unknown>={entry:s.sdk.getState()?.player};
 const seen:ReturnType<typeof messages>=[];
 let baseline=cursor();
 const capture=()=>{for(const m of messages())if(fresh(m,baseline)&&!seen.some(a=>a.observationId===m.observationId&&a.tick===m.tick&&a.text===m.text))seen.push({...m});};
 const off=s.onTick(capture);
 try{
  if(fill){
   const grain=s.sdk.getState()?.inventory.find(i=>i.id===1947),hopper=s.sdk.findNearbyLoc(/^hopper$/i);
   if(!grain||!hopper)throw Error('grain/hopper missing');
   evidence.hopper={...hopper};
   evidence.fill=await s.bot.useItemOnLoc(grain,hopper);capture();
   await observe(()=>{capture();return seen.some(m=>/there is already grain in the hopper/i.test(m.text))||(!s.sdk.getState()?.inventory.some(i=>i.id===1947)&&seen.some(m=>/you put the grain in the hopper/i.test(m.text)));},'hopper fill complete');
   evidence.fillObserved=seen.map(m=>({...m}));
  }
  baseline=cursor();seen.length=0;
  const controls=s.sdk.findNearbyLoc(/^hopper controls$/i);if(!controls)throw Error('hopper controls missing');
  evidence.controls={...controls};
  evidence.operate=await s.bot.interactLoc(controls,1);capture();
  await observe(()=>{capture();return seen.some(m=>/you operate the hopper\. the grain slides down the chute/i.test(m.text));},'hopper operation');
  return evidence;
 }finally{
  off();
  console.log('QUEST_ITEMS_HOPPER '+JSON.stringify({...evidence,exit:s.sdk.getState()?.player,messages:messages(),observed:seen}));
 }
}

// cooking_generic.dbrow: raw beef -> cooked or burnt meat; cooked meat -> burnt meat.
// Both inventory counts must change before the next action is allowed.
export async function cookHettyMeat(s:Session,observe:Observe){
 const cnt=(id:number)=>total(s.sdk.getState()?.inventory,id);
 const transitions:{from:number;to:number}[]=[];
 if(cnt(2146))return transitions;
 const range=s.sdk.findNearbyLoc(/^range$/i);if(!range)throw Error('Hetty range missing');
 for(const from of [2132,2142])if(cnt(from)){
  const item=s.sdk.getState()!.inventory.find(i=>i.id===from)!;
  const held=cnt(from),cooked=cnt(2142),burnt=cnt(2146);
  await s.bot.useItemOnLoc(item,range);
  await observe(()=>cnt(from)===held-1&&(cnt(2146)===burnt+1||(from===2132&&cnt(2142)===cooked+1)),`meat conversion ${from}`,24);
  transitions.push({from,to:cnt(2146)===burnt+1?2146:2142});
 }
 if(!cnt(2146))throw Error('Hetty burnt meat unobserved');
 return transitions;
}

// Helpers never close a session. The entry owns settle and the saved-state check.
export async function gatherQuestItems(s:Session,key:string,start:Save|null,cap:number,options:{onBank?:(bank:BankObservation)=>void;stop?:()=>boolean;fromPack?:boolean}={}){
 if(key==='hetty'&&(!Number.isSafeInteger(cap)||cap<1||cap>6000))throw Error('Hetty CAP must be 1..6000');
 const r=itemRecipe(key),spec=questSpec(key),deadline=s.tick()+cap,abort=new AbortController();
 const travel:HettyTravelDebit[]=[];
 let ended=false;
 void s.ended.then(()=>{ended=true;abort.abort();});
 const stopped=()=>ended||s.tick()>=deadline||abort.signal.aborted||options.stop?.()===true;
 const off=s.onTick(()=>{if(s.tick()>=deadline||s.sdk.getState()?.player?.isDead||options.stop?.())abort.abort();});
 const check=()=>{if(stopped())throw Error('quest items stopped/deadline');};
 const inv=()=>s.sdk.getState()?.inventory??[];
 const cnt=(id:number)=>total(inv(),id);
 const observe=async(pred:()=>boolean,label:string,ticks=12)=>{
  check();if(!await waitUntil(s,pred,{timeoutTicks:Math.max(1,Math.min(ticks,deadline-s.tick())),signal:abort.signal}))throw Error(`${label}: effect unobserved`);check();
 };
 const walk=async(x:number,z:number,level=0)=>{
  check();
  const p=s.sdk.getState()?.player;
  if(p?.level!==level){
   const result=await goTo(s,await getWorld(),{x,z,level},accountOf(s),{legTimeoutTicks:Math.min(100,deadline-s.tick()),signal:abort.signal});
   if(!result.ok)throw Error(`route: ${result.detail}`);
  }else if(Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))>FAR_WALK_TILES){
   // Use observed carried funds, capped independently of the four-coin ingredients.
   const from={x:p.worldX,z:p.worldZ,level},to={x,z,level};
   const remaining=60-travel.reduce((n,d)=>n+d.coins,0);
   const plan=await planTripOffThread(from,to,{...accountOf(s),coins:key==='hetty'?Math.min(cnt(995),remaining):0});check();
   if(!plan)throw Error(`route: no funded HP-safe route ${from.x},${from.z} -> ${x},${z}`);
   if(plan.bank||(key==='hetty'?!hettyRouteAllowed(plan.legs):plan.legs.some(l=>l.kind==='travel')))
    throw Error(`route: unsupported route ${from.x},${from.z} -> ${x},${z}`);
   const fares=plan.legs.reduce((n,l)=>n+(l.kind==='travel'?l.travel.coins:0),0);
   if(fares>remaining||fares>cnt(995))throw Error('Hetty route unfunded');
   for(const leg of plan.legs){
    check();
    const coins=cnt(995),fare=leg.kind==='travel'?leg.travel.coins:0;
    if(fare&&coins<fare)throw Error('Hetty leg unfunded');
    // Never retry a charged crossing. Observe its actual debit before continuing.
    const result=await walkRoute(s,[leg],{maxRetriesPerLeg:fare?1:3,legTimeoutTicks:Math.min(100,deadline-s.tick()),signal:abort.signal});
    if(fare){
     await observe(()=>cnt(995)===coins-fare,'travel debit');
     const debit={id:(leg as Extract<Leg,{kind:'travel'}>).travel.id,coins:fare,packBefore:coins,packAfter:cnt(995)};
     travel.push(debit);console.log('QUEST_HETTY_TRAVEL '+JSON.stringify(debit));
    }else if(cnt(995)!==coins)throw Error('unexpected walking coin delta');
    if(!result.ok)throw Error(`route: ${result.detail}`);
   }
  }else{
   const result=await walkPath(await sessionWalker(s),[{x,z,tol:1}],{maxTicks:deadline-s.tick(),stop:stopped});
   if(!result.ok)throw Error(`walk: ${result.detail}`);
  }
  await observe(()=>{const p=s.sdk.getState()?.player;return !!p&&p.level===level&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=2;},'arrival');
 };
 const corridor:PathPoint[]=[{x:3092,z:3250},{x:3089,z:3266},{x:3100,z:3270},{x:3140,z:3270},{x:3180,z:3258},{x:3218,z:3256}];
 const bank=async()=>{
  if(s.sdk.getState()?.player?.level!==0)await walk(3166,3304,0);
  if((s.sdk.getState()?.player?.worldX??0)>3150)for(const p of [...corridor].reverse())await walk(p.x,p.z);
  await walk(3092,3243);
  const generation=s.bankObservation?.()?.generation??0;
  if(!(await s.bot.openBank()).success)throw Error('bank refused');
  await observe(()=>(s.bankObservation?.()?.generation??0)>generation,'bank observation');
 };
 const withdraw=async(id:number)=>{
  check();const b=s.bankObservation?.(),item=b?.items.find(i=>i.id===id);
  if(!b||!item)throw Error(`bank item missing ${id}`);
  const before=cnt(id),stored=total(b.items,id),generation=b.generation;
  const target=s.sdk.getState()?.bank?.items.find(i=>i.id===id);
  if(!target)throw Error(`bank slot unobserved ${id}`);
  await s.bot.withdrawItem(target,1);
  await observe(()=>{const a=s.bankObservation?.();return !!a&&a.generation>generation&&cnt(id)===before+1&&total(a.items,id)===stored-1;},`withdraw ${id}`);
 };
 const closeBank=async()=>{if(!(await s.bot.closeBank()).success)throw Error('bank close refused');};
 try{
  await observe(()=>{const f=questFlags(s.client)?.find(q=>q.name===spec.label)?.state;return (f==='not started'||f==='started'||f==='complete')&&Array.isArray(s.sdk.getState()?.inventory)&&!!s.sdk.getState()?.player;},'entry state',20);
  if(questFlags(s.client)?.find(q=>q.name===spec.label)?.state==='complete')throw Error('quest already complete');
  if(start&&r.items.every(id=>cnt(id)===1))throw Error('items already in pack');
  // fromPack (Cook's Assistant only): the account stands in Lumbridge with the bucket and the pot in the pack. It
  // opens no bank, keeps the other items of its pack, and gets the egg, the flour and the milk in that order.
  const fromPack=options.fromPack===true&&key==='cook';
  if(fromPack){
   for(const [product,container] of [[1927,1925],[1933,1931]])if(!cnt(product!)&&!cnt(container!))throw Error(`missing container ${container}`);
  }else{
   await bank();
   options.onBank?.(structuredClone(s.bankObservation?.()!));
   // Normalize surplus by depositing first, then withdrawing one. No item is dropped.
   for(const id of new Set(inv().map(i=>i.id))){check();const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}
   for(const id of r.items)if(total(s.bankObservation?.()?.items,id)>0)await withdraw(id);
  }
  if(key==='hetty'){
   // Prefer owned burnt, cooked, then raw meat. Tail stock suppresses the server's rat drop.
   if(total(s.bankObservation?.()?.items,300)>0)await withdraw(300);
   if(!cnt(2146))for(const id of [2142,2132])if(total(s.bankObservation?.()?.items,id)>0){await withdraw(id);break;}
   const meat=!cnt(2146)&&!cnt(2142)&&!cnt(2132),eye=!cnt(221);
   const budget=(meat?1:0)+(eye?3:0);
   for(let n=0;n<budget;n++)await withdraw(995);
   await closeBank();
   const purchases:{id:number;coins:number}[]=[],transitions:{from:number;to:number}[]=[];
   const buy=async(id:number,seller:RegExp,x:number,z:number,limit:number)=>{
    await walk(x,z);check();
    if(id===2132)await openHettyFoodShop(s,observe,check);
    else {const opened=await s.bot.openShop(seller);if(!opened.success)throw Error(`Hetty shop refused: ${opened.message}`);}
    try{
     const shelf=s.sdk.getState()?.shop.shopItems.find(i=>i.id===id);
     if(!shelf||shelf.count<1||!Number.isSafeInteger(shelf.buyPrice)||shelf.buyPrice<1||shelf.buyPrice>limit||cnt(995)<shelf.buyPrice)throw Error(`Hetty price/stock refused ${id}`);
     const coins=cnt(995),held=cnt(id),price=shelf.buyPrice;
     await s.bot.buyFromShop(shelf,1);
     await observe(()=>cnt(id)===held+1&&cnt(995)===coins-price,`purchase ${id}`);
     purchases.push({id,coins:price});
     console.log('QUEST_HETTY_PURCHASE '+JSON.stringify(purchases.at(-1)));
    }finally{if(!(await s.bot.closeShop()).success)throw Error('Hetty shop close refused');}
   };
   // Pinned port_sarim.npc sells at 1000/1000; additives.obj eye cost=3,
   // food_uncooked.obj beef cost=1. Total <=4 of the ordinary 25 starter coins.
   // Both shops are on the walking route; no fare, combat or helper is needed for meat.
   await walk(3089,3266);await walk(3050,3266);
   if(eye)await buy(221,/^betty$/i,3013,3258,3);
   if(meat)await buy(2132,/^wydin$/i,3015,3206,1);
   if(!cnt(1957)){
    await walk(2950,3255);
    const onion=s.sdk.findNearbyLoc(/^onion$/i);if(!onion)throw Error('Hetty onion missing');
    await s.bot.interactLoc(onion,2);await observe(()=>cnt(1957)===1,'onion pick');
   }
   if(!cnt(2146)){
    await walk(2971,3210);
    transitions.push(...await cookHettyMeat(s,observe));
   }
   check();return {ok:true,ticks:cap-(deadline-s.tick()),pack:inv().map(i=>({id:i.id,count:i.count})),purchases,transitions,travel};
  }
  if(!fromPack){
  if(!cnt(1927))await withdraw(1925);
  if(!cnt(1933))await withdraw(1931);
  // A held grain from an interrupted run is reusable. Saved hopper/flour vars are account state.
  if(!cnt(1933)&&!(start?.vars[202]??0)&&!(start?.vars[203]??0)&&total(s.bankObservation?.()?.items,r.grain)>0)await withdraw(r.grain);
  await closeBank();
  }
  // From the bank the stops go west to east: the wheat field and the mill, the cow, then the egg, which is the
  // nearest stop to the cook. One walk with three points goes from the bank to the west side of the wheat field,
  // and the way from there to the mill crosses the field (x 3153-3164, z 3291-3304).
  const gather=!r.items.every(id=>cnt(id)===1);
  if(gather&&(s.sdk.getState()?.player?.worldX??0)<3131){
   const result=await walkPath(await sessionWalker(s),[{x:3092,z:3250,tol:1},{x:3107,z:3279,tol:2},{x:3131,z:3293,tol:2}],{maxTicks:deadline-s.tick(),stop:stopped});
   if(!result.ok)throw Error(`walk: ${result.detail}`);
  }
  const via=async(points:PathPoint[])=>{
   check();const result=await walkPath(await sessionWalker(s),points,{maxTicks:deadline-s.tick(),stop:stopped});
   if(!result.ok)throw Error(`walk: ${result.detail}`);
  };
  const flour=async()=>{
  if(!cnt(1933)){
   // The grain comes first, because the field is on the way. A restart whose bin holds flour then has one grain
   // too many, and the bank visit at the end deposits it.
   if(!(start?.vars[203]??0)&&!(start?.vars[202]??0)&&!cnt(r.grain)){
    await walk(3160,3295);
    // The pick is a direct engine click on the nearest wheat, which can be the wheat under the player. The SDK
    // action sends its own walk first, and the engine then answers "I can't reach that!". A refused click is sent
    // again from the tile where the player then stands.
    for(let tries=0;tries<3&&!cnt(r.grain);tries++){
     const p=s.sdk.getState()?.player,far=(l:{x:number;z:number})=>p?Math.max(Math.abs(l.x-p.worldX),Math.abs(l.z-p.worldZ)):0;
     const wheat=(s.sdk.getState()?.nearbyLocs??[]).filter(l=>/^wheat$/i.test(l.name)).sort((a,b)=>far(a)-far(b))[0];
     if(!wheat)throw Error('wheat missing');
     if(!(await s.sdk.sendInteractLoc(wheat.x,wheat.z,wheat.id,2)).success)throw Error('wheat click refused');
     await waitUntil(s,()=>cnt(r.grain)===1,{timeoutTicks:8,signal:abort.signal});check();
    }
    if(cnt(r.grain)!==1)throw Error('wheat pickup: effect unobserved');
   }
   // Live restart: probe the actor's bin, never infer private mill vars from zero defaults.
   if(!start){
    await walk(3166,3304,0);
    await probeQuestFlourBin(s,observe);
   }
   if(!cnt(1933)&&!(start?.vars[203]??0)){
    // The top of the ladders is 3164,3306. The engine walks from there to the hopper and to the controls.
    await walk(3164,3306,2);
    await operateQuestHopper(s,!(start?.vars[202]??0),observe);
   }
   if(!cnt(1933)){
   // The foot of the ladders is 3165,3307, beside the bin.
   await walk(3165,3307,0);
   const bin=s.sdk.findNearbyLoc(/^flour bin$/i);if(!bin)throw Error('flour bin missing');
   await s.bot.interactLoc(bin,1);await observe(()=>cnt(1933)===1&&cnt(1931)===0,'flour conversion');
   }
  }
  };
  // The cows west of the mill are the default. A run from the pack milks in the field east of the egg farm.
  const milk=async(x=3154,z=3325)=>{
  if(!cnt(1927)){
   await walk(x,z);
   await observe(()=>s.sdk.getState()?.nearbyNpcs.some(n=>n.id===81)??false,'cow',20);
   const me=s.sdk.getState()?.player,off=(n:{x:number;z:number})=>me?Math.max(Math.abs(n.x-me.worldX),Math.abs(n.z-me.worldZ)):0;
   const cow=(s.sdk.getState()?.nearbyNpcs??[]).filter(n=>n.id===81).sort((a,b)=>off(a)-off(b))[0],bucket=inv().find(i=>i.id===1925);
   if(!cow||!bucket)throw Error('cow/bucket missing');
   await s.bot.useItemOnNpc(bucket,cow);
   await observe(()=>cnt(1927)===1&&cnt(1925)===0,'milk conversion');
  }
  };
  const egg=async()=>{
  if(!cnt(1944)){
   if(!fromPack)await walk(3226,3301);
   let egg=await s.sdk.scanFindGroundItem(/^egg$/i,12);
   if(!egg){await observe(()=>s.sdk.getState()?.groundItems.some(i=>i.id===1944)??false,'egg respawn',100);egg=s.sdk.findGroundItem(/^egg$/i);}
   if(!egg)throw Error('egg unavailable');
   const before=cnt(1944);await s.bot.pickupItem(egg);await observe(()=>cnt(1944)===before+1,'egg pickup');
  }
  };
  if(fromPack){
   // Fixed points: from the spawn or the castle to the egg farm through its east gate, then west along the road
   // north of the castle to the east side of the wheat field.
   const at=()=>s.sdk.getState()?.player;
   // The south gate of the east cow field (3252,3267) is 12 tiles from the lane to the egg farm.
   if((!cnt(1944)||!cnt(1927))&&(at()?.worldZ??0)<3264)await via([...((at()?.worldZ??0)<3240?[{x:3226,z:3236,tol:2},{x:3218,z:3256,tol:2}]:[]),{x:3228,z:3262,tol:2},{x:3240,z:3266,tol:2}]);
   if((at()?.worldX??0)>3215)await milk(3255,3263);
   if(!cnt(1944))await via([{x:3240,z:3270,tol:2},{x:3237,z:3294,tol:2},{x:3226,z:3301,tol:1}]);
   await egg();
   if((!cnt(1933)||!cnt(1927))&&(at()?.worldX??0)>3200)
    await via([...((at()?.worldZ??0)>3275?[{x:3237,z:3294,tol:2},{x:3240,z:3270,tol:2},{x:3228,z:3262,tol:2}]:(at()?.worldZ??0)<3240?[{x:3226,z:3236,tol:2},{x:3218,z:3256,tol:2}]:[]),{x:3208,z:3281,tol:2},{x:3194,z:3281,tol:2},{x:3189,z:3295,tol:2}]);
   await flour();await milk();
  }else{await flour();await milk();await egg();}
  // A pack that holds only the quest items needs no second bank visit: the account goes to the east end of the
  // corridor, where the walk to the kitchen starts. A run from the pack keeps its other items and visits no bank.
  if(!fromPack&&inv().some(i=>!(r.items as readonly number[]).includes(i.id))){
   await bank();
   for(const id of new Set(inv().filter(i=>!(r.items as readonly number[]).includes(i.id)).map(i=>i.id))){check();const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}
   await closeBank();
  }else if(gather&&(s.sdk.getState()?.player?.worldX??0)<3215||gather&&(s.sdk.getState()?.player?.worldZ??0)>3275){
   // Fixed points to the east end of the corridor: from the egg farm through its gate, from the mill or the cow
   // along the road south of the mill. The trip planner refuses some of these walks for an account with 10 HP.
   const west=(s.sdk.getState()?.player?.worldX??0)<3200;
   const north=(s.sdk.getState()?.player?.worldZ??0)>3312;
   await via(west?[...(north?[{x:3174,z:3315,tol:2}]:[]),{x:3189,z:3295,tol:2},{x:3194,z:3281,tol:2},{x:3208,z:3281,tol:2},{x:3218,z:3256,tol:2}]:[{x:3237,z:3294,tol:2},{x:3240,z:3270,tol:2},{x:3228,z:3262,tol:2},{x:3218,z:3256,tol:2}]);
  }
  if(!r.items.every(id=>cnt(id)===1)||!fromPack&&inv().some(i=>!(r.items as readonly number[]).includes(i.id)))throw Error('quest pack short/surplus');
  check();return {ok:true,ticks:cap-(deadline-s.tick()),pack:inv().map(i=>({id:i.id,count:i.count}))};
 }finally{off();}
}

export async function probeQuestFlourBin(s:Session,observe:Observe){
 const messages=()=>s.sdk.getState()?.gameMessages??[];
 const revision=Math.max(0,...messages().map(m=>m.observationId??0)),tick=Math.max(-1,...messages().map(m=>m.tick));
 let empty=false;
 const capture=()=>{empty ||= messages().some(m=>(m.observationId!==undefined?m.observationId>revision:m.tick>tick)&&/the flour bin is already empty/i.test(m.text));};
 const off=s.onTick(capture);
 try{
  const bin=s.sdk.findNearbyLoc(/^flour bin$/i);if(!bin)throw Error('flour bin missing');
  // The engine walks to the bin itself. The SDK action waits about 100 ticks on an empty bin, because a game message
  // is the only effect.
  const sent=await s.sdk.sendInteractLoc(bin.x,bin.z,bin.id,1);if(!sent.success)throw Error('flour bin probe refused');capture();
  await observe(()=>{capture();return empty||s.sdk.getState()?.inventory.some(i=>i.id===1933)===true;},'flour bin probe');
 }finally{off();}
}

export async function runQuestItemsOrder(name:string,key:string,options:{save?:string;cap:number}){
 itemRecipe(key);
 if(!/^[A-Za-z0-9]{1,12}$/.test(name)||!Number.isSafeInteger(options.cap)||options.cap<1)throw Error('invalid account or CAP');
 if(!options.save||!existsSync(options.save))return {ok:false,refused:'save required or not found',login:false};
 const before=readPracticeSave(options.save),refused=itemEntry(key,before);
 if(refused)return {ok:false,refused,login:false};
 const s=await openBot(name);holdSessionEater(s.sdk);let child:Awaited<ReturnType<typeof gatherQuestItems>>|undefined,detail='';
 try{child=await gatherQuestItems(s,key,before,options.cap);detail=`quest-items ${key} ticks=${child.ticks}`;}
 catch(e){detail=String(e);}
 // settle's return includes work success. Its logout receipt is a separate fact.
 let logout=false;
 const settled=await settle([s],child?.ok===true,detail,{log:line=>{console.log(line);if(line==='LOGOUT logged-out')logout=true;}});
 if(child?.ok!==true||!settled||!logout)return {ok:false,child,logout,detail};
 const saved=await waitPracticeSave(options.save,s=>Object.values(itemSaveChecks(key,before,s,child.travel??[])).every(Boolean),{timeoutMs:15000});
 return {ok:saved.matched,child,logout,checks:itemSaveChecks(key,before,saved.save,child.travel??[])};
}
if(import.meta.main){
 try{
  const args=process.argv.slice(2),[name,key]=args.filter(a=>!a.startsWith('--')),save=args.find(a=>a.startsWith('--save='))?.slice(7);
  if(!name||!key)throw Error('usage: quest-items-order <account> <quest> --save=<own-save>');
  const result=await runQuestItemsOrder(name,key,{save:save?resolve(save):undefined,cap:Number(process.env.CAP??2400)});
  console.log('QUEST_ITEMS_ORDER_RESULT '+JSON.stringify(result));process.exitCode=result.ok?0:1;
 }catch(e){console.error(String(e));process.exitCode=1;}
}
