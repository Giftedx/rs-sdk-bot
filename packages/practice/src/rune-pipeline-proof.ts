import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {exactCarrierOffer,transfer} from '../../../scripts/rune-carrier-trade';
const root=resolve(import.meta.dir,'../../..'),engine=join(root,'vendor/rs-sdk/server/engine');
const sourceFiles=['scripts/rune-pipeline.ts','scripts/rune-carrier-trade.ts','packages/practice/src/rune-pipeline-proof.ts',
 'vendor/rs-sdk/server/engine/src/engine/World.ts','vendor/rs-sdk/server/engine/src/engine/entity/Player.ts','vendor/rs-sdk/server/engine/src/engine/entity/NetworkPlayer.ts',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/IfButtonHandler.ts','vendor/rs-sdk/server/engine/src/network/game/client/handler/InvButtonHandler.ts',
 'vendor/rs-sdk/server/engine/src/network/game/client/handler/OpPlayerHandler.ts',
 'vendor/rs-sdk/server/content/scripts/interface_trade/scripts/trade.rs2','vendor/rs-sdk/server/content/scripts/skill_runecraft/scripts/runecraft.rs2'];
const packed=['client/interface','client/config','server/script.dat','server/script.idx','server/interface.dat','server/obj.dat','server/varp.dat','server/inv.dat'];
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const binding=()=>({source:Object.fromEntries(sourceFiles.map(p=>[p,hash(join(root,p))])),packed:Object.fromEntries(packed.map(p=>[p,hash(join(engine,'data/pack',p))]))});
const count=(a:any,id:number)=>[...a.inventory,...a.offer].filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const sdkTrade=(actors:any[],i:number)=>{const a=actors[i],b=actors[1-i];return {isOpen:a.main===3323||a.main===3443,screen:a.main===3323?'offer':'confirm',partner:a.partner===b.uid?b.name:undefined,myOffer:a.offer,theirOffer:b.offer};};
export function runePipelineChecks(raw:any){
 const step=(id:string)=>raw.steps?.find((s:any)=>s.id===id),actors=(id:string)=>step(id)?.actors;
 const finished=(id:string)=>{const a=actors(id);return a?.length===2&&a[0].main===-1&&a[1].main===-1&&count(a[0],1436)===27&&count(a[1],1436)===0&&a.every((p:any)=>p.offer.length===0&&p.partner===-1);};
 const same=(a:string,b:string)=>JSON.stringify(actors(a))===JSON.stringify(actors(b));
 const bad=(name:string)=>{const a=actors(name+':confirm'),z=actors(name+':cancelled');return a?.length===2&&a.every((p:any)=>p.main===3443)
  &&!exactCarrierOffer(sdkTrade(a,0) as any,false,'giver',27)&&!exactCarrierOffer(sdkTrade(a,1) as any,true,'receiver',27)
  &&z?.length===2&&count(z[0],1436)===0&&count(z[1],1436)===27&&z.every((p:any)=>p.main===-1&&p.offer.length===0)
  &&z.every((p:any,i:number)=>count(p,995)===count(actors(name+':opened')[i],995));};
 return {binding:JSON.stringify(raw.binding)===JSON.stringify(binding()),components:JSON.stringify(raw.components)===JSON.stringify({first:3420,confirm:3546,offer:3322}),
  causal:['helper-first','master-first'].every(order=>[1,5].every(quota=>finished('causal-'+order+'-'+quota+':finished'))),
  helperFirst:finished('helper-first:finished'),masterFirst:finished('master-first:finished'),
  reset:actors('master-first:empty-accepted')?.[0].status===2&&actors('master-first:offer-reset')?.[0].status===0,
  premature:step('master-first:premature-confirm')?.accepted===false&&same('master-first:offer-reset','master-first:premature-confirm'),
  duplicates:['helper-first','master-first'].every(name=>step(name+':duplicate-confirm')?.accepted===false&&step(name+':duplicate-first')?.accepted===false&&same(name+':finished',name+':duplicate-confirm')&&same(name+':finished',name+':duplicate-first')),
  cancelled:actors('cancelled:finished')?.every((a:any,i:number)=>a.main===-1&&a.offer.length===0&&count(a,1436)===(i===0?0:27))&&step('cancelled:late-confirm')?.accepted===false&&same('cancelled:finished','cancelled:late-confirm'),
  partial:bad('partial'),wrongItem:bad('wrong-item'),
  noReplay:step('replay:old-confirm')?.accepted===false&&same('replay:request','replay:old-confirm')&&actors('replay:opened')?.every((a:any)=>a.main===3323&&a.status===0),
  delayPhase:step('delay:input-at-deadline')?.accepted===false&&step('delay:input-at-deadline')?.lookups===0&&actors('delay:input-at-deadline')?.[0].delayed===true&&actors('delay:input-at-deadline')?.[0].until===raw.delayTick,
  controller:raw.controllerCases?.length===2&&['helper-first','master-first'].every(order=>raw.controllerCases.some((c:any)=>c.order===order&&!c.error&&!c.fatal
   &&c.requests.length===2&&new Set(c.requests.map((e:any)=>e.actor)).size===2&&c.requests.every((e:any)=>e.sent>=104&&e.processed>=105)
   &&c.events.filter((e:any)=>e.kind==='craft').length===1&&c.events.filter((e:any)=>e.kind==='explicit-confirm').length<=2
   &&c.final[0].xp===1003687.5&&c.final[0].inventory.filter((i:any)=>i.id===559).reduce((n:number,i:any)=>n+i.count,0)===81
   &&c.final.every((a:any)=>a.inventory.every((i:any)=>i.id!==1436)&&a.offer.length===0&&a.main===-1))),
  withheldButtonPublications:raw.buttonCaseClientPublications===0};
}
export function verifyRunePipeline(dir:string){
 const raw=JSON.parse(readFileSync(join(dir,'raw.json'),'utf8')),checks=runePipelineChecks(raw),report={ok:Object.values(checks).every(Boolean),checks,binding:raw.binding,
  scope:'Real pinned button handlers and packed trade/craft scripts on two in-memory actors. Button cases withhold client publications; controller cases use synthetic publications and a controlled input-before-delay-clear clock. Both actor orders reconcile exact XP and product. No socket, authentication, saved profile, sustained speed or LIVE rank evidence.'};
 writeFileSync(join(dir,'consumer.json'),JSON.stringify(report,null,2));return report;
}
export async function runRunePipeline(dir:string){
 mkdirSync(dir,{recursive:true});
 const before=binding();process.chdir(engine);process.env.NODE_XPRATE='25';
 const load=async(p:string)=>(await import(join(engine,'src',p))).default;
 const World=await load('engine/World.ts'),Player=await load('engine/entity/Player.ts'),Scripts=await load('engine/script/ScriptProvider.ts'),Runner=await load('engine/script/ScriptRunner.ts');
 const Component=await load('cache/config/Component.ts'),Inv=await load('cache/config/InvType.ts'),Varp=await load('cache/config/VarPlayerType.ts');
 const IfHandler=await load('network/game/client/handler/IfButtonHandler.ts'),IfButton=await load('network/game/client/model/IfButton.ts'),InvHandler=await load('network/game/client/handler/InvButtonHandler.ts'),InvButton=await load('network/game/client/model/InvButton.ts');
 const OpHandler=await load('network/game/client/handler/OpPlayerHandler.ts'),OpPlayer=await load('network/game/client/model/OpPlayer.ts');
 const Loc=await load('engine/entity/Loc.ts');
 try{
  World.reload();World.currentTick=100;
  const steps:any[]=[],ids={first:Component.getId('trademain:accept'),confirm:Component.getId('tradeconfirm:accept'),offer:Component.getId('tradeside:inv')};
  const items=(p:any,type:number)=>p.getInventory(type).items.flatMap((i:any,slot:number)=>i?[{...i,slot}]:[]);
  const snapshot=(id:string,s:any,h:any,accepted?:boolean)=>{steps.push({id,accepted,actors:[s,h].map(p=>({name:p.username,uid:p.uid,main:p.modalMain,side:p.modalSide,status:p.getVar(Varp.getId('tradestatus')),partner:p.getVar(Varp.getId('tradepartner')),inventory:items(p,Inv.INV),offer:items(p,Inv.getId('tradeoffer')),delayed:p.delayed,until:p.delayedUntil}))});};
  const request=Scripts.getByName('[opplayer4,_]');if(!request)throw Error('Pinned trade request script missing');
  const op=(a:any,b:any)=>a.executeScript(Runner.init(request,a,b),true);
  const pair=(coins=false,opened=true)=>{const [s,h]=['receiver','giver'].map((name,i)=>{const p=new Player(name,BigInt(i+1),BigInt(i+1));p.x=2523;p.z=4833;p.slot=2040+i;p.uid=((i+1)<<11)|p.slot;p.write=()=>{};World.players[p.slot]=p;return p;});h.invAdd(Inv.INV,1436,27);if(coins)h.invAdd(Inv.INV,995,27);if(opened){op(h,s);op(s,h);}return{s,h};};
  const click=(p:any,id:number)=>new IfHandler().handle(new IfButton(id),p),offer=(p:any,obj=1436,slot=0)=>new InvHandler().handle(new InvButton(4,obj,slot,ids.offer),p);
  for(const order of ['helper-first','master-first']){
   const {s,h}=pair();snapshot(order+':opened',s,h);
   if(order==='helper-first'){offer(h);click(h,ids.first);click(s,ids.first);snapshot(order+':confirm',s,h);click(s,ids.confirm);click(h,ids.confirm);}
   else{click(s,ids.first);snapshot(order+':empty-accepted',s,h);offer(h);click(h,ids.first);snapshot(order+':offer-reset',s,h);snapshot(order+':premature-confirm',s,h,click(h,ids.confirm));click(s,ids.first);click(s,ids.confirm);click(h,ids.confirm);}
   snapshot(order+':finished',s,h);snapshot(order+':duplicate-confirm',s,h,click(h,ids.confirm));snapshot(order+':duplicate-first',s,h,click(s,ids.first));
  }
  // Only the helper's accepted, exact offer is published before this burst.
  // A quota split or helper-first processing may ignore its early final click.
  for(const order of ['helper-first','master-first'])for(const quota of [1,5]){
   const{s,h}=pair();offer(h);click(h,ids.first);const name='causal-'+order+'-'+quota;
   snapshot(name+':accepted',s,h);const observed=steps.at(-1).actors;
   if(observed[1].status!==2||!exactCarrierOffer(sdkTrade(observed,1) as any,true,'receiver',27))throw Error('Causal fixture lacks accepted owned offer');
   const actors=[s,h],queues=[[ids.first,ids.confirm],[ids.confirm]],sequence=order==='helper-first'?[1,0]:[0,1];
   for(let turn=0;turn<2;turn++)for(const i of sequence)for(const id of queues[i]!.splice(0,quota))click(actors[i],id);
   snapshot(name+':burst',s,h);
   for(const p of actors)if(p.modalMain===3443){
    const current=actors.map(a=>({name:a.username,uid:a.uid,main:a.modalMain,partner:a.getVar(Varp.getId('tradepartner')),offer:items(a,Inv.getId('tradeoffer'))}));
    const i=actors.indexOf(p);if(!exactCarrierOffer(sdkTrade(current,i) as any,i===1,actors[1-i].username,27))throw Error('Causal fallback lost exact offer');
    click(p,ids.confirm);
   }
   snapshot(name+':finished',s,h);
  }
  {const{s,h}=pair();offer(h);click(h,ids.first);s.closeModal();snapshot('cancelled:finished',s,h);snapshot('cancelled:late-confirm',s,h,click(h,ids.confirm));}
  for(const name of ['partial','wrong-item']){
   const{s,h}=pair(name==='wrong-item');snapshot(name+':opened',s,h);offer(h,name==='wrong-item'?995:1436,name==='wrong-item'?27:0);
   if(name==='partial')new InvHandler().handle(new InvButton(1,1436,0,Component.getId('trademain:inv')),h);
   click(h,ids.first);click(s,ids.first);snapshot(name+':confirm',s,h);
   const observed=steps.at(-1).actors;if(exactCarrierOffer(sdkTrade(observed,0) as any,false,'giver',27)||exactCarrierOffer(sdkTrade(observed,1) as any,true,'receiver',27))throw Error('Real invalid confirmation escaped the worker stock guard');
   s.closeModal();snapshot(name+':cancelled',s,h);
  }
  {const{s,h}=pair();offer(h);click(h,ids.first);click(s,ids.first);click(s,ids.confirm);click(h,ids.confirm);
   op(s,h);snapshot('replay:request',s,h);snapshot('replay:old-confirm',s,h,click(h,ids.confirm));op(h,s);snapshot('replay:opened',s,h);
  }
  {const{s,h}=pair();s.closeModal();s.delayed=true;s.delayedUntil=104;World.currentTick=104;const lookup=World.getPlayer;let lookups=0;World.getPlayer=function(slot:number){lookups++;return lookup.call(this,slot);};
   try{snapshot('delay:input-at-deadline',s,h,new OpHandler().handle(new OpPlayer(4,h.slot),s));steps.at(-1).lookups=lookups;}finally{World.getPlayer=lookup;}}
  const controllerCases:any[]=[];
  for(const order of ['helper-first','master-first']){
   World.currentTick=100;const{s,h}=pair(false,false),actors=[s,h],sequence=order==='helper-first'?[1,0]:[0,1],queues:any[][]=[[],[]],events:any[]=[],listeners=[new Set<()=>void>(),new Set<()=>void>()],cached:any[]=[],messages:any[][]=[[],[]];
   s.stats[20]=9986250;s.levels[20]=99;s.delayed=true;s.delayedUntil=104;let observation=0,fatal:string|null=null,error:string|null=null,end!:(value:{reason:string})=>void;
   const ended=new Promise<{reason:string}>(resolve=>{end=resolve;});
   const live=(i:number)=>({name:actors[i].username,uid:actors[i].uid,main:actors[i].modalMain,status:actors[i].getVar(Varp.getId('tradestatus')),partner:actors[i].getVar(Varp.getId('tradepartner')),inventory:items(actors[i],Inv.INV),offer:items(actors[i],Inv.getId('tradeoffer')),xp:actors[i].stats[20]/10});
   const publish=(i:number)=>{const a=live(i),b=live(1-i),trade=sdkTrade([a,b],0);cached[i]={revision:World.currentTick,tick:World.currentTick,player:{worldX:2523,worldZ:4833,level:0},trade:{...trade,myAccepted:trade.isOpen&&(trade.screen==='offer'?a.status===2:a.status===4)},gameMessages:[...messages[i]],nearbyPlayers:[{name:actors[1-i].username,index:actors[1-i].slot}],xp:a.xp,inventory:a.inventory};};
   actors.forEach((p:any,i:number)=>{p.write=(packet:any)=>{if(packet.constructor.name!=='MessageGame')return;const request=/^(.*):tradereq:$/.exec(packet.msg);messages[i].push({type:request?4:0,sender:request?.[1]??'',text:request?'wishes to trade with you.':packet.msg,observationId:++observation});};publish(i);});
   const enqueue=(i:number,kind:string,data:object={})=>{const event={actor:i,kind,sent:World.currentTick,...data};queues[i].push(event);events.push(event);return{success:true,phase:'dispatch'};};
   const sessions=actors.map((p:any,i:number)=>({name:p.username,tick:()=>World.currentTick,ended,onTick:(cb:()=>void)=>{listeners[i].add(cb);return()=>{listeners[i].delete(cb);};},direct:async(a:any)=>a.type==='interactPlayer'?enqueue(i,'request',{target:a.playerIndex}):a.type==='clickComponent'?enqueue(i,'explicit-confirm',{component:a.componentId}):a.type==='interactLoc'?enqueue(i,'craft'):Promise.reject(Error('Unexpected fixture action '+a.type)),
    sdk:{getState:()=>cached[i],getInventory:()=>cached[i].inventory,getTradeState:()=>cached[i].trade,scanGroundItems:async()=>{publish(i);},sendOfferItem:async(slot:number,amount:number)=>{if(amount!==-1)throw Error('Fixture only accepts Offer-All');return enqueue(i,'offer',{slot});},sendAcceptTrade:async()=>enqueue(i,'accept',{component:cached[i].trade.screen==='confirm'?ids.confirm:ids.first})}}));
   const craft=Scripts.getByName('[oploc1,_rc_altar]');if(!craft)throw Error('Packed body craft script missing');const altar=new Loc(0,2521,4840,1,1,0,2483,10,0);
   const timer=setInterval(()=>{try{
    World.currentTick++;const requests=new Set<number>();
    for(const i of sequence)for(const e of queues[i].splice(0)){e.processed=World.currentTick;const p=actors[i];
     if(e.kind==='request'){if(!p.delayed){p.clearPendingAction();requests.add(i);}}
     else if(e.kind==='offer')new InvHandler().handle(new InvButton(4,1436,e.slot,ids.offer),p);
     else if(e.kind==='craft'){p.clearPendingAction();p.executeScript(Runner.init(craft,p,altar),true);}
     else new IfHandler().handle(new IfButton(e.component),p);
    }
    for(const i of sequence){const p=actors[i];if(p.delayed&&World.currentTick>=p.delayedUntil){p.delayed=false;if(p.activeScript)p.executeScript(p.activeScript,true,true);}if(requests.has(i))op(p,actors[1-i]);}
    for(let i=0;i<2;i++){publish(i);for(const cb of [...listeners[i]])if(listeners[i].has(cb))cb();}
   }catch(e){fatal=String(e);end({reason:'fixture failed'});}},20);
   try{await transfer(sessions[0] as any,sessions[1] as any,()=>fatal!==null,27,{send:async()=>{await sessions[0].direct({type:'interactLoc'});},complete:()=>cached[0].xp===1003687.5&&cached[0].inventory.filter((i:any)=>i.id===559).reduce((n:number,i:any)=>n+i.count,0)===81},{boundary:{tick:()=>100,dispose:()=>{}}});}
   catch(e){error=String(e);}finally{clearInterval(timer);end({reason:'fixture complete'});await Promise.resolve();}
   controllerCases.push({order,error,fatal,events,requests:events.filter(e=>e.kind==='request'),final:[live(0),live(1)]});
  }
  if(JSON.stringify(binding())!==JSON.stringify(before))throw Error('Handler or packed inputs changed during fixture');
  writeFileSync(join(dir,'raw.json'),JSON.stringify({binding:before,components:ids,steps,controllerCases,delayTick:104,buttonCaseClientPublications:0},null,2));
 }finally{await Promise.all([World.loginThread.terminate(),World.friendThread.terminate(),World.loggerThread.terminate()]);process.chdir(root);}
 return verifyRunePipeline(dir);
}
if(import.meta.main){try{
 if(!process.env.DELIVERY_DIR)throw Error('Run through the delivery harness');
 const dir=join(resolve(process.env.DELIVERY_DIR),'rune-pipeline');mkdirSync(dir,{recursive:true});const result=process.argv[2]==='--verify'?verifyRunePipeline(dir):await runRunePipeline(dir);console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;
}catch(error){console.error(String(error));process.exitCode=1;}}
