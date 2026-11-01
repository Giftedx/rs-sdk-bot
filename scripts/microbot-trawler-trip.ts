import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {walkPath,sessionWalker} from '../packages/core/src/walk';
import {depositObserved} from '../packages/core/src/deposit';
import {insideLegacyTrawler,trawlerEffect,trawlerInterruption} from './microbot-trawler-trip-effects';
import {runVisibleGroundLoot} from './microbot-b-mining-loot';
export function trawlerCatchRows(component:{linkObjType:ArrayLike<number>|null;linkObjNumber:ArrayLike<number>|null}|undefined){
 if(!component?.linkObjType||!component.linkObjNumber)throw Error('owned trawler reward inventory unavailable');
 return Array.from(component.linkObjType,(id,slot)=>({id:id-1,slot,count:component.linkObjNumber![slot]??0})).filter(i=>i.id>=0&&i.count>0);
}
export function trawlerAssetsReconcile(initial:ReadonlyMap<number,number>,banked:Readonly<Record<number,number>>,rewards:Readonly<Record<number,number>>,paste:number,ropes:number){
 const ids=new Set([...Object.keys(banked),...Object.keys(rewards),...initial.keys()].map(Number));
 return [...ids].every(id=>(banked[id]??0)===(initial.get(id)??0)+(rewards[id]??0)-(id===1941?paste:0)-(id===954?ropes:0));
}
export async function runTrawlerTrip(s:Session,o:{cap:number;stop?:()=>boolean;collectOnly?:boolean}){
 if(!Number.isSafeInteger(o.cap)||o.cap<(o.collectOnly?100:1200)||o.cap>10000)throw Error('invalid trawler trip cap');
 const st=()=>s.sdk.getState()!,inv=()=>s.sdk.getInventory(),held=(id:number)=>inv().filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const initialStock=new Map<number,number>();for(const i of inv())initialStock.set(i.id,(initialStock.get(i.id)??0)+i.count);
 const paste0=held(1941),rope0=held(954);
 const first=st(),p0=first.player;if(!p0||p0.level!==0||Math.max(Math.abs(p0.worldX-2675),Math.abs(p0.worldZ-3170))>20||(s.sdk.getSkill('Hitpoints')?.level??0)<3||(s.sdk.getSkill('Fishing')?.level??0)<15||!o.collectOnly&&(held(1941)<100||held(954)<10||held(583)!==1))throw Error('stage trawler at Port Khazard with Fishing15, 100 paste, 10 ropes and bailing bucket');
 const initialMessages=new Set(first.gameMessages.map(m=>m.observationId??`${m.tick}:${m.text}`));const won=()=>st().gameMessages.some(m=>!initialMessages.has(m.observationId??`${m.tick}:${m.text}`)&&/Murphy turns the boat towards shore\./.test(m.text));
 let ended=false,securing=false,secureStart=0;void s.ended.then(()=>{ended=true});const start=s.tick(),hp=s.sdk.getSkill('Hitpoints')?.level;let leaks=0,nets=0,bails=0;
 const check=()=>{if(ended||(!securing&&o.stop?.())||(securing?s.tick()-secureStart>=500:s.tick()-start>=o.cap))throw Error('trawler stopped/cap/session');const p=st().player;if(!p||p.isDead||p.lifeId!==p0.lifeId||s.sdk.getSkill('Hitpoints')?.level!==hp)throw Error('trawler health changed');};
 const step=async()=>{check();await waitTicks(s,1);check()};
 const wait=async(test:()=>boolean,n:number)=>waitUntil(s,()=>{check();return test()},{timeoutTicks:Math.min(n,Math.max(1,securing?500-(s.tick()-secureStart):o.cap-(s.tick()-start)))});
 const walk=async(x:number,z:number)=>{check();const r=await walkPath(await sessionWalker(s),[{x,z,tol:1}],{maxTicks:180,stop:()=>ended||!securing&&!!o.stop?.()});if(!r.ok)throw Error('trawler walking '+JSON.stringify(r));check()};
 const loc=async(id:number,west=false)=>{check();await s.bot.dismissBlockingUI();const l=st().nearbyLocs.filter(l=>l.id===id&&l.level===st().player!.level).sort((a,b)=>west?a.x-b.x:a.distance-b.distance)[0]??(id===2178?{x:2674,z:3170,id}:id===2166?{x:2666,z:3167,id}:undefined);if(!l)throw Error('trawler object absent '+id);if(!(await s.sdk.sendInteractLoc(l.x,l.z,l.id,1)).success)throw Error('trawler object refused '+id);return l;};
 const ladder=async(level:number)=>{const before=st();await loc(level===1?2174:2175,level===1);if(!await wait(()=>st().player?.level===level||won()||!!trawlerInterruption(before,st()),15))throw Error('trawler ladder timeout');if(trawlerInterruption(before,st())&&!won()){await s.bot.dismissBlockingUI();await waitTicks(s,3);check();}};
 const effectWait=async(before:ReturnType<typeof st>,mode:'net'|'leak'|'bail',phase:'fill'|'empty',ticks:number)=>{let effect=false;await wait(()=>{effect=trawlerEffect(before,st(),mode,phase);return effect||won()||!!trawlerInterruption(before,st());},ticks);const interrupted=!!trawlerInterruption(before,st());if(interrupted&&!won()){await s.bot.dismissBlockingUI();await waitTicks(s,3);check();effect=trawlerEffect(before,st(),mode,phase);}return{effect,interrupted};};
 await walk(2613,3094);await s.bot.dismissBlockingUI();const initialGeneration=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await wait(()=>!!st().bank.isOpen&&(s.bankObservation?.()?.generation??-1)>initialGeneration,15))throw Error('trawler initial bank unavailable');for(const i of s.bankObservation!()!.items)initialStock.set(i.id,(initialStock.get(i.id)??0)+i.count);await s.bot.closeBank();
 if(!o.collectOnly){
 await walk(2675,3170);console.log('TRAWLER_PHASE boarding');await loc(2178);if(!await wait(()=>insideLegacyTrawler(st()),160))throw Error('trawler boarding timeout');
 console.log('TRAWLER_PHASE sea');await waitTicks(s,25);let ripped=false,lastMessage=0,lastReport=0;const overlay=s.client as {var:Int32Array;ifType:(id:number)=>{text:string|null}};
 while(insideLegacyTrawler(st())){
  if(won())break;
  check();ripped=overlay.ifType(11936)?.text==='Ripped!'||ripped;const water=overlay.var[391];if(!Number.isInteger(water)||water<0||water>100)throw Error('native trawler water unknown');if(s.tick()-lastReport>=100){console.log('TRAWLER_CONTROL '+JSON.stringify({tick:s.tick(),position:st().player,water,ripped,leaks,nets,bails}));lastReport=s.tick();}for(const m of st().gameMessages){if((m.observationId??m.tick)>lastMessage&&/The net has ripped!/.test(m.text))ripped=true;lastMessage=Math.max(lastMessage,m.observationId??m.tick)}
  await s.bot.dismissBlockingUI();const state=st(),p=state.player!,flooded=Math.floor(p.worldX/64)===31;
  if(held(585)){const before=st(),bucket=inv().find(i=>i.id===585)!;if(!(await s.sdk.sendUseItem(bucket.slot,1)).success)throw Error('trawler empty bucket refused');const result=await effectWait(before,'bail','empty',8);if(won())break;if(!result.effect&&!result.interrupted)throw Error('trawler empty bucket unobserved');continue;}
  if(p.level===1){
   const target=state.nearbyLocs.find(l=>[2172,2173].includes(l.id));
   if(target){if(held(954)<1)throw Error('trawler rope exhausted');const before=st();await loc(target.id);let effect=false;await wait(()=>{effect=trawlerEffect(before,st(),'net');return won()||effect||st().gameMessages.some(m=>m.tick>before.tick&&/fail to repair the net/.test(m.text))},10);if(won())break;if(effect){nets++;ripped=false;}}
   else ripped=false;
   if(!ripped||flooded)await ladder(0);else await step();
  }else{
   const leak=state.nearbyLocs.filter(l=>l.id===2167).sort((a,b)=>a.distance-b.distance)[0];
   if(ripped&&water<=60){await ladder(1);}
   else if(leak){if(held(1941)<1)throw Error('trawler paste exhausted');const before=st();await loc(2167);const result=await effectWait(before,'leak','fill',12);if(result.effect)leaks++;if(won())break;if(!result.effect&&!result.interrupted)throw Error('trawler leak effect absent');}
   else if(flooded){const before=st(),bucket=inv().find(i=>i.id===583);if(!bucket)throw Error('bailing bucket absent');if(!(await s.sdk.sendUseItem(bucket.slot,1)).success)throw Error('trawler bailing refused');const result=await effectWait(before,'bail','fill',8);if(result.effect)bails++;if(won())break;if(!result.effect&&!result.interrupted)throw Error('trawler bailing failed');}
   else if(ripped)await ladder(1);else await step();
  }
 }
 if(!await wait(()=>st().player?.level===0&&Math.floor(st().player!.worldZ/64)===49,40)||!won())throw Error('trawler win unobserved');
 }
 if(held(585)){const before=st(),bucket=inv().find(i=>i.id===585)!;if(!(await s.sdk.sendUseItem(bucket.slot,1)).success||!await wait(()=>trawlerEffect(before,st(),'bail','empty'),8))throw Error('trawler return bucket empty failed');}
 leaks=paste0-held(1941);nets=rope0-held(954);
 let finalBank:{id:number;count:number}[]=[];
 const bank=async()=>{await walk(2613,3094);await s.bot.dismissBlockingUI();const gen=s.bankObservation?.()?.generation??-1;if(!(await s.bot.openBank()).success||!await wait(()=>!!st().bank.isOpen&&(s.bankObservation?.()?.generation??-1)>gen,15))throw Error('trawler bank unavailable');for(const id of new Set(inv().map(i=>i.id))){const item=inv().find(i=>i.id===id);if(item)await depositObserved(s,item);}finalBank=s.bankObservation!()!.items.map(i=>({...i}));await s.bot.closeBank();};
 await bank();await walk(2667,3167);check();const catchApproach={x:st().player!.worldX,z:st().player!.worldZ};const relayTile={x:catchApproach.x-1,z:catchApproach.z};for(const at of [relayTile,catchApproach]){const preflight=await walkPath(await sessionWalker(s),[{...at,tol:0}],{maxTicks:10,stop:()=>ended||!!o.stop?.()});if(!preflight.ok||st().player!.worldX!==at.x||st().player!.worldZ!==at.z)throw Error('trawler relay preflight '+JSON.stringify({at,preflight}));}securing=true;secureStart=s.tick();await loc(2166);if(!await wait(()=>st().modalInterface===4564,15))throw Error('owned trawler catch absent');
 const client=s.client as {ifType:(id:number)=>{linkObjType:Int32Array|null;linkObjNumber:Int32Array|null}};
 const rewards=trawlerCatchRows(client.ifType(4640));if(!rewards.length)throw Error('trawler reward empty');
 const total=(rows:readonly{id:number;count:number}[])=>{const n:Record<number,number>={};for(const i of rows)n[i.id]=(n[i.id]??0)+i.count;return n;};
 const expected=total(rewards),catchAt={x:st().player!.worldX,z:st().player!.worldZ};console.log('TRAWLER_CATCH '+JSON.stringify({component:4640,modal:st().modalInterface,rewards,at:catchAt,peers:st().nearbyPlayers,baseline:st().groundItems.filter(i=>i.x===catchAt.x&&i.z===catchAt.z)}));
 const overflow=rewards.reduce((n,i)=>n+i.count,0)>28;
 if(overflow&&(st().nearbyPlayers.length||st().groundItems.some(i=>i.x===catchAt.x&&i.z===catchAt.z&&expected[i.id])))throw Error('trawler overflow ownership baseline ambiguous');
 for(const r of rewards){
  let left=r.count;while(left&&inv().length<28){const free=28-inv().length,n=left<=free?left:1,before=held(r.id);if(!(await s.sdk.sendClickComponentWithOption(4640,n===left?2:1,r.slot)).success||!await wait(()=>held(r.id)===before+n,8))throw Error('trawler catch withdrawal mismatch');left-=n;}
  if(left)break;
 }
 const remaining=trawlerCatchRows(client.ifType(4640));let overflowTicks=0;const overflowReceipts:unknown[]=[];
 if(remaining.length){
  const urgent=total(remaining),urgentTick=s.tick();console.log('TRAWLER_URGENT_ESCROW '+JSON.stringify({at:catchAt,escrow:urgent,tick:urgentTick,lifetime:100}));await s.bot.dismissBlockingUI();
  const pile=(at:{x:number;z:number},id:number)=>st().groundItems.filter(i=>i.id===id&&i.x===at.x&&i.z===at.z).reduce((n,i)=>n+i.count,0);
  if(!await wait(()=>Object.entries(urgent).every(([id,n])=>pile(catchAt,Number(id))===n),5))throw Error('trawler catch dump escrow absent');
  const relay=relayTile;
  const exact=async(at:{x:number;z:number})=>{const r=await walkPath(await sessionWalker(s),[{...at,tol:0}],{maxTicks:10,stop:()=>ended||!securing&&!!o.stop?.()});if(!r.ok||st().player!.worldX!==at.x||st().player!.worldZ!==at.z)throw Error('trawler relay tile unavailable '+JSON.stringify({at,r,player:st().player}));};
  await exact(relay);if(st().nearbyPlayers.length||st().groundItems.some(i=>i.x===relay.x&&i.z===relay.z&&expected[i.id]))throw Error('trawler relay baseline ambiguous');
  const relayEscrow:Record<number,number>={},relayTick=s.tick(),need=remaining.reduce((n,i)=>n+i.count,0);
  while(28-inv().length<need){
   check();if(st().nearbyPlayers.length)throw Error('trawler relay peers');const item=inv()[0];if(!item||!expected[item.id])throw Error('trawler relay requires owned catch');const before=total(inv()),groundBefore=pile(relay,item.id);
   if(!(await s.sdk.sendDropItem(item.slot)).success||!await wait(()=>held(item.id)===(before[item.id]??0)-item.count&&pile(relay,item.id)===groundBefore+item.count,8))throw Error('trawler owned relay drop unobserved');
   const after=total(inv());for(const id of new Set([...Object.keys(before),...Object.keys(after)].map(Number)))if((after[id]??0)-(before[id]??0)!==(id===item.id?-item.count:0))throw Error('trawler relay drop debit mismatch');relayEscrow[item.id]=(relayEscrow[item.id]??0)+item.count;console.log('TRAWLER_RELAY_DROP '+JSON.stringify({at:relay,id:item.id,units:item.count,packBefore:before[item.id],packAfter:after[item.id]??0,pileBefore:groundBefore,pileAfter:pile(relay,item.id),tick:s.tick(),privateTicks:100,lifetime:300,peers:st().nearbyPlayers}));
  }
  const recover=async(at:{x:number;z:number},escrow:Record<number,number>,began:number,lifetime:number)=>{
   check();if(st().nearbyPlayers.length||s.tick()-began>=lifetime-5||!Object.entries(escrow).every(([id,n])=>pile(at,Number(id))===n))throw Error('trawler escrow peers, expiry or quantity');
   const owned=()=>{check();if(st().nearbyPlayers.length||s.tick()-began>=lifetime-5)throw Error('trawler escrow peers or expiry');return{...st(),groundItems:st().groundItems.filter(i=>i.x===at.x&&i.z===at.z&&escrow[i.id])};};
   const definition=(s.client as {objType:(id:number)=>{cost:number;stackable:boolean}}).objType.bind(s.client);
   const result=await runVisibleGroundLoot({state:owned,tick:()=>s.tick(),stop:()=>!securing&&!!o.stop?.(),definition,pickup:async i=>(await s.sdk.sendPickup(i.x,i.z,i.id)).success,wait,step},{mode:'list',ids:Object.keys(escrow).map(Number),names:[],minimumValue:0,maximumValue:2147483647,radius:2,maximumUnits:Object.values(escrow).reduce((n,i)=>n+i,0),cap:Math.max(1,lifetime-5-(s.tick()-began)),idleTicks:5});
   if(JSON.stringify(Object.entries(result.acquired).sort())!==JSON.stringify(Object.entries(escrow).sort()))throw Error('trawler escrow inventory mismatch');console.log('TRAWLER_ESCROW_RECOVERED '+JSON.stringify({at,escrow,elapsed:s.tick()-began,lifetime,inventoryReceipt:result.acquired,peers:st().nearbyPlayers}));overflowReceipts.push({at,escrow,elapsed:s.tick()-began,lifetime,privateTicks:100,publicAfter:100,inventoryReceipt:result.acquired});
  };
  await exact(catchAt);await recover(catchAt,urgent,urgentTick,100);if(trawlerCatchRows(client.ifType(4640)).length)throw Error('trawler GUI escrow remains');
  await bank();await walk(relay.x,relay.z);await recover(relay,relayEscrow,relayTick,300);overflowTicks=s.tick()-relayTick;
 }

 await bank();const banked=total(finalBank);
 if(!trawlerAssetsReconcile(initialStock,banked,expected,leaks,nets))throw Error('trawler final asset reconciliation');

 return{ok:!o.stop?.(),stopped:!!o.stop?.(),wholeTrip:!o.collectOnly,leaks,nets,bails,rewards,overflowTicks,overflowReceipts,conserved:true,ticks:s.tick()-start};
}
if(import.meta.main){let s:Session|undefined;try{const [name,cap]=process.argv.slice(2);if(!name)throw Error('account required');s=await openBot(name);const result=await runTrawlerTrip(s,{cap:Number(cap??2200),collectOnly:process.argv.includes('--collect-only'),stop:()=>existsSync('.practice/stop-all')||existsSync(`.practice/stop-${name}`)});console.log('TRAWLER_TRIP '+JSON.stringify(result));await finish([s],result.ok,JSON.stringify(result));}catch(e){if(s){const state=s.sdk.getState();console.log('TRAWLER_ERROR_STATE '+JSON.stringify({player:state?.player,locs:state?.nearbyLocs,ground:state?.groundItems,inventory:state?.inventory,messages:state?.gameMessages,modal:state?.modalInterface}));}await finish(s?[s]:[],false,String(e));}}
