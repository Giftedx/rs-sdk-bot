import type {Session} from "../packages/core/src/inprocess";
import {waitTicks,waitUntil} from "../packages/core/src/ticks";
const eager=true;
const inv=(s:Session)=>s.sdk.getInventory(),ess=(s:Session)=>inv(s).filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0);
const state=(s:Session)=>s.sdk.getState()!,trade=(s:Session)=>state(s).trade;
const index=(s:Session,n:string)=>state(s).nearbyPlayers.find(p=>p.name.toLowerCase()===n.toLowerCase())?.index;
const messages=(s:Session)=>state(s).gameMessages??[];
const cursor=(s:Session)=>Math.max(0,...messages(s).map(m=>m.observationId??0));
async function transfer(s:Session,h:Session,stop:()=>boolean=()=>false,amount=27){
 if(!Number.isSafeInteger(amount)||amount<1||amount>27)throw Error('carrier transfer amount must be1..27');
 const at=s.tick();
 if(!await waitUntil(s,()=>ess(h)===amount&&ess(s)===0,{timeoutTicks:10}))throw Error('handoff stock unobserved');
 let opened=false,offerSent=false,last='',requestPending=false,responseSent=false,levelupDismissed=false,incomingCursor=0,busyCursor=0;const confirmed=new Set<Session>(),offerAccepted=new Set<Session>();
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
 while(s.tick()-at<35&&ess(s)!==amount&&!stop()){
  {
   mark('event-loop-yield');
   await new Promise<void>(resolve=>setImmediate(resolve));
   mark('ground-scans');
   await Promise.all([s.sdk.scanGroundItems(0),h.sdk.scanGroundItems(0)]);
   mark('control');
  }
  if(stop())break;
  if(ess(s)===amount&&ess(h)===0)break;
  const snapshot=JSON.stringify([s,h].map(a=>({name:a.name,open:trade(a)?.isOpen,screen:trade(a)?.screen,partner:trade(a)?.partner,
   my:trade(a)?.myOffer?.reduce((n,i)=>n+i.count,0),their:trade(a)?.theirOffer?.reduce((n,i)=>n+i.count,0),accepted:trade(a)?.myAccepted})));
  if(snapshot!==last){console.log('RC_TRADE_STATE '+JSON.stringify({at:Date.now(),tick:s.tick(),actors:JSON.parse(snapshot)}));last=snapshot;}
  if(trade(s)?.isOpen||trade(h)?.isOpen)opened=true;
  if(!trade(s)?.isOpen&&!trade(h)?.isOpen&&!opened&&!responseSent){
   const dialog=state(s).dialog;
   if(!levelupDismissed&&dialog?.isOpen&&dialog.allComponents?.some(c=>/^(@dbl@)?Congratulations, you just advanced a runecraft level\.$/i.test(c.text))){
    // This modal keeps the crafter busy, so an incoming trade request cannot arrive until it closes.
    mark('close-modal');await s.direct({type:'closeModal',reason:'SDK'});mark('control');levelupDismissed=true;
   }
   const incoming=()=>messages(s).some(m=>m.type===4&&m.sender?.toLowerCase()===h.name.toLowerCase()
    &&m.text==='wishes to trade with you.'&&(m.observationId??0)>incomingCursor);
   // Retry only a server-refused request. The incoming request acknowledges acceptance after the craft delay.
   if(requestPending&&!incoming()&&messages(h).some(m=>m.type===0&&m.sender===''
    &&m.text.toLowerCase()===s.name.toLowerCase()+' is busy at the moment.'&&(m.observationId??0)>busyCursor))requestPending=false;
   if(!requestPending&&!stop()){
    const si=index(h,s.name),hi=index(s,h.name);
    if(si!==undefined&&hi!==undefined){
     incomingCursor=cursor(s);busyCursor=cursor(h);
     mark('helper-request');await h.direct({type:'interactPlayer',playerIndex:si,optionIndex:4,reason:'SDK'});mark('control');requestPending=true;
    }
   }
   if(requestPending&&incoming()&&!stop()){
    const hi=index(s,h.name);
    if(hi!==undefined){mark('crafter-response');await s.direct({type:'interactPlayer',playerIndex:hi,optionIndex:4,reason:'SDK'});mark('control');responseSent=true;}
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
    if(offerAccepted.has(actor))continue;
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
    const pendingOwnedOffer=actor===s&&eager&&offerSent&&total===0&&(helperTrade?.myOffer?.reduce((n,i)=>n+i.count,0)===amount||acknowledgedOwnedOffer);
    if(!pendingOwnedOffer&&total===0)continue;
    if(!pendingOwnedOffer&&total!==amount)throw Error('unexpected essence offer '+total);
    if(!t.myAccepted){const accepted=await actor.sdk.sendAcceptTrade();if(!accepted.success)throw Error('carrier offer acceptance refused '+accepted.message);offerAccepted.add(actor);}
   }else if(t.screen==='confirm'&&!t.myAccepted){
    const accepted=await actor.sdk.sendAcceptTrade();
    if(!accepted.success)throw Error('carrier confirmation refused '+accepted.message);
    // Interface text and offers may clear before the modal and inventory credit.
    confirmed.add(actor);
   }
  }
  // Remote interface packets can arrive after PLAYER_INFO in another pump.
  // The next scans publish current client state without sending game packets.
  // Keep the server-tick deadline, but do not hold a ready handshake for a tick.
  mark('next-publication');await Promise.race([nextTick(s),nextTick(h),Bun.sleep(20)]);mark('loop-condition');
 }
 observe('loop-exit');mark('inventory-reconciliation');
 if(!await waitUntil(s,()=>ess(s)===amount&&ess(h)===0,{timeoutTicks:5}))throw Error('essence transfer did not reconcile');
 return s.tick()-at;
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
