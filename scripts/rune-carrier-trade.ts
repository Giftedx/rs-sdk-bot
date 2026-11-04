import type {Session} from "../packages/core/src/inprocess";
import {waitTicks,waitUntil} from "../packages/core/src/ticks";
import {pipelineOpeningReady,type CraftBoundary} from './rune-pipeline';
const eager=true;
const inv=(s:Session)=>s.sdk.getInventory(),ess=(s:Session)=>inv(s).filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0);
const state=(s:Session)=>s.sdk.getState()!,trade=(s:Session)=>state(s).trade;
const index=(s:Session,n:string)=>state(s).nearbyPlayers.find(p=>p.name.toLowerCase()===n.toLowerCase())?.index;
const messages=(s:Session)=>state(s).gameMessages??[];
const cursor=(s:Session)=>Math.max(0,...messages(s).map(m=>m.observationId??0));
export function exactCarrierOffer(t:ReturnType<Session['sdk']['getTradeState']>,giver:boolean,partner:string,amount:number){
 const offered=giver?t.myOffer:t.theirOffer,returned=giver?t.theirOffer:t.myOffer;
 return t.isOpen&&t.partner?.toLowerCase()===partner.toLowerCase()&&(returned??[]).length===0
  &&(offered??[]).every(i=>i.id===1436&&Number.isSafeInteger(i.count)&&i.count>0)&&(offered??[]).reduce((n,i)=>n+i.count,0)===amount;
}
export function runeOpening(){
 const opening=process.env.RUNE_OPEN_AFTER??'incoming';
 if(opening!=='incoming'&&opening!=='helper-ack')throw Error('RUNE_OPEN_AFTER must be incoming or helper-ack');
 return opening;
}
export function runeConfirmation(value=process.env.RUNE_CONFIRM_AFTER??'causal'){
 if(value!=='observed'&&value!=='causal')throw Error('RUNE_CONFIRM_AFTER must be observed or causal');
 return value;
}
async function transfer(s:Session,h:Session,stop:()=>boolean=()=>false,amount=27,craft?:{send:()=>Promise<void>;complete:()=>boolean},pipeline?:{boundary?:CraftBoundary}){
 const opening=runeOpening(),confirmation=runeConfirmation();
 if(!Number.isSafeInteger(amount)||amount<1||amount>27)throw Error('carrier transfer amount must be1..27');
 if(pipeline&&(!craft||!pipeline.boundary))throw Error('pipeline handoff needs the previous exact craft boundary and combined crafting');
 const at=s.tick();
 if(!await waitUntil(s,()=>ess(h)===amount&&ess(s)===0,{timeoutTicks:10}))throw Error('handoff stock unobserved');
 let opened=false,offerSent=false,last='',requestPending=false,responseSent=false,levelupDismissed=false,incomingCursor=0,busyCursor=0;const confirmed=new Set<Session>(),offerAccepted=new Set<Session>();
 let craftAt:number|undefined;
 let receiverEarly=false,receiverRetry=false;const earlyConfirmed=new Set<Session>();
 const acceptedCursors=new Map([[s,cursor(s)],[h,cursor(h)]]);
 const credited=()=>ess(s)===amount&&ess(h)===0;
 const complete=()=>craft?craftAt!==undefined&&ess(s)===0&&ess(h)===0&&craft.complete():credited();
 const accepted=()=>[s,h].every(a=>messages(a).some(m=>m.type===0&&m.sender===''&&m.text==='Accepted trade.'&&(m.observationId??0)>acceptedCursors.get(a)!));
 const tickWaits=new Map<Session,Promise<void>>();
 const nextTick=(actor:Session)=>{
  let pending=tickWaits.get(actor);
  if(!pending){pending=waitTicks(actor,1).then(()=>{tickWaits.delete(actor);});tickWaits.set(actor,pending);}
  return pending;
 };
 // Read-only scheduling evidence: publications can continue while an awaited control step cannot resume.
 const observationCursors=new Map([[s,cursor(s)],[h,cursor(h)]]);
 let phase='loop',phaseAt=s.tick(),phaseTime=performance.now();
 const mark=(next:string)=>{phase=next;phaseAt=s.tick();phaseTime=performance.now();};
 const observe=(event:string)=>console.log('RC_TRADE_WAIT '+JSON.stringify({event,crafter:s.name,helper:h.name,
  tick:s.tick(),helperTick:h.tick(),elapsed:s.tick()-at,phase,phaseAt,phaseMs:Math.round(performance.now()-phaseTime),
  requestPending,responseSent,opened,incomingCursor,busyCursor,
  actors:[s,h].map(a=>({name:a.name,revision:state(a).revision,modal:state(a).dialog?.isOpen,
   open:trade(a)?.isOpen,screen:trade(a)?.screen,essence:ess(a),
   messages:messages(a).filter(m=>(m.observationId??0)>Math.max(observationCursors.get(a)!,a===s?incomingCursor:busyCursor))
    .filter(m=>m.type===4||m.type===0&&(/busy at the moment\.|Sending trade offer/.test(m.text)))
    .map(m=>({type:m.type,sender:m.sender,text:m.text,observationId:m.observationId,tick:m.tick}))}))}));
 const observers=[s,h].map(a=>typeof a.onTick==='function'?a.onTick(()=>{
  if(s.tick()-phaseAt>=3)observe('publication:'+a.name);
 }):()=>{});
 try{
 observe('begin');
 while(s.tick()-at<35&&(craft?!complete():ess(s)!==amount)&&!stop()){
  {
   mark('event-loop-yield');
   await new Promise<void>(resolve=>setImmediate(resolve));
   mark('ground-scans');
   await Promise.all([s.sdk.scanGroundItems(0),h.sdk.scanGroundItems(0)]);
   mark('control');
  }
  if(stop())break;
  if(!craft&&credited())break;
  if(craft&&craftAt===undefined&&[s,h].every(a=>confirmed.has(a)||earlyConfirmed.has(a))&&(accepted()||credited())){
   // Both exact confirmations were sent. The fresh pair of server messages precedes
   // synchronous movement; success still requires the combined craft's exact effects.
   if(stop())break;craftAt=s.tick();await craft.send();
  }
  if(complete())break;
  const snapshot=JSON.stringify([s,h].map(a=>({name:a.name,open:trade(a)?.isOpen,screen:trade(a)?.screen,partner:trade(a)?.partner,
   my:trade(a)?.myOffer?.reduce((n,i)=>n+i.count,0),their:trade(a)?.theirOffer?.reduce((n,i)=>n+i.count,0),accepted:trade(a)?.myAccepted})));
  if(snapshot!==last){console.log('RC_TRADE_STATE '+JSON.stringify({at:Date.now(),tick:s.tick(),actors:JSON.parse(snapshot)}));last=snapshot;}
  if(trade(s)?.isOpen||trade(h)?.isOpen)opened=true;
  if(!trade(s)?.isOpen&&!trade(h)?.isOpen&&!opened&&!responseSent){
   if(pipeline){
    if(pipelineOpeningReady(s,pipeline.boundary!)){
     const main=state(s).player,helper=state(h).player,si=index(h,s.name),hi=index(s,h.name),dialog=state(s).dialog;
     const runeDialog=dialog?.allComponents?.some(c=>/^(@dbl@)?Congratulations, you just advanced a runecraft level\.$/i.test(c.text)
      ||/^(?:Members can now|You can now) craft @dbl@(?:Air|Mind|Water|Earth|Fire|Body|Cosmic|Chaos|Nature|Law|Death) Runes@bla@\.$/.test(c.text));
     if(dialog?.isOpen&&!runeDialog||state(h).dialog?.isOpen)throw Error('pipeline handoff preserves unrelated dialogs');
     if(main&&helper&&si!==undefined&&hi!==undefined&&main.level===helper.level&&Math.max(Math.abs(main.worldX-helper.worldX),Math.abs(main.worldZ-helper.worldZ))<=1){
      if(ess(s)!==0||ess(h)!==amount)throw Error('pipeline opening stock changed');
      const send=(a:Session,playerIndex:number)=>{if(stop())throw Error('pipeline opening stopped');return a.direct({type:'interactPlayer',playerIndex,optionIndex:4,reason:'SDK'});};
      mark('reciprocal-request');const sent=await Promise.all([send(h,si),send(s,hi)]);mark('control');
      if(sent.some(r=>!(r as {success?:boolean})?.success))throw Error('pipeline reciprocal request refused');
      requestPending=true;responseSent=true;
     }
    }
   }else{
   const dialog=state(s).dialog;
   if(!levelupDismissed&&dialog?.isOpen&&dialog.allComponents?.some(c=>/^(@dbl@)?Congratulations, you just advanced a runecraft level\.$/i.test(c.text))){
    // This modal keeps the crafter busy, so an incoming trade request cannot arrive until it closes.
    mark('close-modal');await s.direct({type:'closeModal',reason:'SDK'});mark('control');levelupDismissed=true;
   }
   const incoming=()=>messages(s).some(m=>m.type===4&&m.sender?.toLowerCase()===h.name.toLowerCase()
    &&m.text==='wishes to trade with you.'&&(m.observationId??0)>incomingCursor);
   // This exact server message follows the target's busy check. Only this owner
   // issues the helper's one outstanding request, so its fresh ACK is attributable.
   const ready=()=>incoming()||opening==='helper-ack'&&messages(h).some(m=>m.type===0&&m.sender===''
    &&m.text==='Sending trade offer...'&&(m.observationId??0)>busyCursor);
   // Retry only a server-refused request. The incoming request acknowledges acceptance after the craft delay.
   if(requestPending&&!ready()&&messages(h).some(m=>m.type===0&&m.sender===''
    &&m.text.toLowerCase()===s.name.toLowerCase()+' is busy at the moment.'&&(m.observationId??0)>busyCursor))requestPending=false;
   if(!requestPending&&!stop()){
    const si=index(h,s.name),hi=index(s,h.name);
    if(si!==undefined&&hi!==undefined){
     incomingCursor=cursor(s);busyCursor=cursor(h);
     mark('helper-request');await h.direct({type:'interactPlayer',playerIndex:si,optionIndex:4,reason:'SDK'});mark('control');requestPending=true;
    }
   }
   if(requestPending&&ready()&&!stop()){
    const hi=index(s,h.name);
    if(hi!==undefined){mark('crafter-response');await s.direct({type:'interactPlayer',playerIndex:hi,optionIndex:4,reason:'SDK'});mark('control');responseSent=true;}
   }
   }
  }
  for(const actor of [h,s]){
   mark('offer-or-accept:'+actor.name);
   const t=trade(actor);if(!t?.isOpen)continue;
   if(t.partner&&t.partner.toLowerCase()!==(actor===s?h.name:s.name).toLowerCase())throw Error('unexpected carrier trade partner');
   if(t.myAccepted||confirmed.has(actor))continue;
   const giver=actor===h?t.myOffer:t.theirOffer,receiver=actor===h?t.theirOffer:t.myOffer;
   if(receiver?.length||(giver??[]).some(i=>i.id!==1436)||(giver??[]).reduce((n,i)=>n+i.count,0)>amount)throw Error('unexpected carrier trade stock');
   if(t.screen==='confirm'&&(giver??[]).reduce((n,i)=>n+i.count,0)!==amount)throw Error('incomplete carrier confirmation');
   if(t.screen==='offer'){
    if(offerAccepted.has(actor)){
     // Offering stock resets an optimistic empty first acceptance. One exact-stock
     // retry is idempotent on trademain and invisible after confirmation opens.
     if(pipeline&&actor===s&&receiverEarly&&!receiverRetry&&trade(h)?.screen==='offer'&&trade(h)?.myAccepted
      &&exactCarrierOffer(t,false,h.name,amount)&&exactCarrierOffer(trade(h)!,true,s.name,amount)){
      if(stop())break;const accepted=await s.sdk.sendAcceptTrade();if(!accepted.success)throw Error('carrier offer retry refused '+accepted.message);receiverRetry=true;
     }
     continue;
    }
    if(actor===h&&(t.myOffer?.length??0)===0&&!offerSent){
     const e=inv(h).find(i=>i.id===1436);
     if(!e)continue;
     const result=await h.sdk.sendOfferItem(e.slot,-1);
     if(!result.success)throw Error('helper offer refused '+result.message);
     offerSent=true;
     if(eager){const accepted=await h.sdk.sendAcceptTrade();if(!accepted.success)throw Error('carrier offer acceptance refused '+accepted.message);offerAccepted.add(h);}
     continue;
    }
    const offer=actor===s?t.theirOffer:t.myOffer;
    if((offer??[]).some(i=>i.id!==1436))throw Error('unexpected item in owned handoff');
    const total=(offer??[]).reduce((n,i)=>n+i.count,0);
    // The giver has exclusively staged amount essence and queued Offer-All before its accept.
    // The recipient gives nothing. Final success still requires both inventory publications.
    const helperTrade=trade(h);
    const acknowledgedOwnedOffer=helperTrade?.isOpen&&helperTrade.screen==='offer'&&helperTrade.myAccepted&&offerAccepted.has(h);
    const pendingOwnedOffer=actor===s&&eager&&offerSent&&total===0&&(helperTrade?.myOffer?.reduce((n,i)=>n+i.count,0)===amount||acknowledgedOwnedOffer||!!pipeline&&offerAccepted.has(h));
    if(!pendingOwnedOffer&&total===0)continue;
    if(!pendingOwnedOffer&&total!==amount)throw Error('unexpected essence offer '+total);
    if(!t.myAccepted){
     const accepted=await actor.sdk.sendAcceptTrade();if(!accepted.success)throw Error('carrier offer acceptance refused '+accepted.message);offerAccepted.add(actor);if(pipeline&&actor===s&&total===0)receiverEarly=true;
    }
   }else if(t.screen==='confirm'&&!t.myAccepted){
    const accepted=await actor.sdk.sendAcceptTrade();
    if(!accepted.success)throw Error('carrier confirmation refused '+accepted.message);
    // Interface text and offers may clear before the modal and inventory credit.
    confirmed.add(actor);
   }
  }
  const receiverTrade=trade(s),helperTrade=trade(h);
  // Remote exact-offer publication can follow the receiver's acceptance latch.
  // Recheck the same server-accepted offer without sending another first accept.
  if(confirmation==='causal'&&amount===27&&offerSent&&offerAccepted.has(s)&&offerAccepted.has(h)
   &&helperTrade?.isOpen&&helperTrade.screen==='offer'&&helperTrade.myAccepted&&exactCarrierOffer(helperTrade,true,s.name,amount)
   &&receiverTrade?.isOpen&&receiverTrade.screen==='offer'&&receiverTrade.partner?.toLowerCase()===h.name.toLowerCase()&&(receiverTrade.myOffer??[]).length===0){
   for(const peer of [s,h])if(!earlyConfirmed.has(peer)&&!confirmed.has(peer)){
    if(stop())break;earlyConfirmed.add(peer);
    const result=await peer.direct({type:'clickComponent',componentId:3546,reason:'SDK'});
    if(!(result as {success?:boolean})?.success)throw Error('causal carrier confirmation dispatch refused');
   }
  }
  if(pipeline&&offerAccepted.size===2&&trade(s)?.screen==='offer'&&trade(h)?.screen==='offer'
   &&exactCarrierOffer(trade(s)!,false,h.name,amount)&&exactCarrierOffer(trade(h)!,true,s.name,amount)){
   // Both complete first-screen offers are observed and this owner sends no more
   // offer mutations. A premature confirmation can be ignored by the server;
   // keep the exact observed-confirm fallback instead of treating dispatch as ACK.
   for(const actor of [s,h])if(!earlyConfirmed.has(actor)&&!confirmed.has(actor)){
    if(stop())break;const result=await actor.direct({type:'clickComponent',componentId:3546,reason:'SDK'});
    if(!(result as {success?:boolean})?.success)throw Error('early carrier confirmation dispatch refused');earlyConfirmed.add(actor);
   }
  }
  // Remote interface packets can arrive after PLAYER_INFO in another pump.
  // The next scans publish current client state without sending game packets.
  // Keep the server-tick deadline, but do not hold a ready handshake for a tick.
  mark('next-publication');await Promise.race([nextTick(s),nextTick(h),Bun.sleep(20)]);mark('loop-condition');
 }
 observe('loop-exit');mark('inventory-reconciliation');
 if(!await waitUntil(s,complete,{timeoutTicks:5}))throw Error(craft?'combined essence handoff and craft did not reconcile':'essence transfer did not reconcile');
 return (craftAt??s.tick())-at;
 }finally{observe('end');for(const off of observers)off();}
}

export {transfer,ess,state};

type Items=Record<number,number>;
const count=(items:readonly {id:number;count:number}[]):Items=>{const result:Items={};for(const i of items)result[i.id]=(result[i.id]??0)+i.count;return result;};
const equal=(a:Items,b:Items)=>[...new Set([...Object.keys(a),...Object.keys(b)])].every(k=>(a[Number(k)]??0)===(b[Number(k)]??0));
// Whole-ID owned swaps. Both complete offers are observed before either screen is accepted.
export async function ownedSwap(a:Session,b:Session,giveA:Items,giveB:Items,stop:()=>boolean=()=>false){
 const actors=[a,b],gives=[giveA,giveB],before=actors.map(s=>count(s.sdk.getInventory()));
 const expected=before.map((items,i)=>{const next={...items};for(const [id,n] of Object.entries(gives[i]!)){if(n<=0||items[Number(id)]!==n)throw Error('swap must give the complete observed item count');next[Number(id)]=(next[Number(id)]??0)-n;}for(const [id,n]of Object.entries(gives[1-i]!))next[Number(id)]=(next[Number(id)]??0)+n;return next;});
 const complete=()=>actors.every((s,i)=>equal(count(s.sdk.getInventory()),expected[i]!));
 const closed=()=>actors.every(s=>!s.sdk.getTradeState().isOpen);
 if(complete())throw Error('swap must change owned stock');
 const start=a.tick(),sent=[false,false];let opened=false,lastRequest=-Infinity;
 while(a.tick()-start<50&&(!complete()||!closed())&&!stop()){
  await new Promise<void>(resolve=>setImmediate(resolve));await Promise.all(actors.map(s=>s.sdk.scanGroundItems(0)));
  const trades=actors.map(s=>s.sdk.getTradeState());
  if(trades.some(t=>t.isOpen))opened=true;
  // Repeated requests can decline a trade that opens while the actors walk together.
  if(!opened&&a.tick()-lastRequest>=10){
   const targets=actors.map((s,i)=>s.sdk.getState()?.nearbyPlayers.find(p=>p.name.toLowerCase()===actors[1-i]!.name.toLowerCase()));
   if(targets.every(Boolean)){for(let i=0;i<2;i++)await actors[i]!.direct({type:'interactPlayer',playerIndex:targets[i]!.index,optionIndex:4,reason:'SDK'});lastRequest=a.tick();}
  }
  for(let i=0;i<2;i++){
   const s=actors[i]!,t=s.sdk.getTradeState();if(!t.isOpen)continue;
   if(t.partner&&t.partner.toLowerCase()!==actors[1-i]!.name.toLowerCase())throw Error('unexpected swap partner');
   if(t.screen==='offer'&&!sent[i]){
    const pack=s.sdk.getInventory();for(const id of Object.keys(gives[i]!)){const item=pack.find(x=>x.id===Number(id));if(!item)throw Error('swap item slot missing');const r=await s.sdk.sendOfferItem(item.slot,-1);if(!r.success)throw Error('swap offer refused');}sent[i]=true;
   }
   const mine=count(t.myOffer),theirs=count(t.theirOffer);
   for(const [ids,allowed]of [[mine,gives[i]!],[theirs,gives[1-i]!]] as const)if(Object.entries(ids).some(([id,n])=>n>(allowed[Number(id)]??0)))throw Error('unexpected swap offer');
   if(equal(mine,gives[i]!)&&equal(theirs,gives[1-i]!)&&!t.myAccepted)await s.sdk.sendAcceptTrade();
  }
  await Promise.race(actors.map(s=>waitTicks(s,1)));
 }
 if(stop())throw Error('owned swap stopped');
 if(!complete())throw Error('owned swap did not reconcile');
 if(!closed())throw Error('owned swap trade windows stayed open');
 return {ticks:a.tick()-start,before,after:actors.map(s=>count(s.sdk.getInventory()))};
}
