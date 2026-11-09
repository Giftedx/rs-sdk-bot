// Legacy Trawler: trip mode boards at Port Khazard, wins, collects and banks; support modes stage aboard.
// This ports native leak/net/bailing mechanics, not modern tentacle/contribution rewards.
import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';
import {insideLegacyTrawler,trawlerEffect,type TrawlerMode} from './microbot-trawler-trip-effects';
export {insideLegacyTrawler,trawlerEffect,type TrawlerMode} from './microbot-trawler-trip-effects';
const count=(s:BotWorldState,id:number)=>s.inventory.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
const hp=(s:BotWorldState)=>s.skills.find(k=>k.name==='Hitpoints')?.level??0;
export interface TrawlerDriver{state:()=>BotWorldState|null;tick:()=>number;stop:()=>boolean;object:(x:number,z:number,id:number,op:number)=>Promise<boolean>;item:(slot:number,op:number)=>Promise<boolean>;wait:(test:()=>boolean,ticks:number)=>Promise<boolean>;step:()=>Promise<void>}
export async function runTrawlerSupport(d:TrawlerDriver,o:{mode:TrawlerMode;maximum:number;cap:number;maxAttempts:number}){
 if(!['net','leak','bail'].includes(o.mode)||![o.maximum,o.cap,o.maxAttempts].every(n=>Number.isSafeInteger(n)&&n>0))throw Error('invalid trawler job');
 const initial=d.state();if(!initial?.player||!insideLegacyTrawler(initial)||hp(initial)<1)throw Error('stage inside native Trawler boat');
 const start=d.tick();let completed=0,attempts=0;
 const state=()=>{const s=d.state();if(!s?.player)throw Error('trawler session ended');if(d.stop())throw Error('trawler stopped');if(d.tick()-start>=o.cap)throw Error('trawler cap');if(!insideLegacyTrawler(s))throw Error('trawler trip ended before support target');if(s.player.lifeId!==initial.player!.lifeId||hp(s)!==hp(initial)||s.player.isDead)throw Error('trawler health changed');return s;};
 const useBucket=async(phase:'fill'|'empty')=>{
  const before=state(),id=phase==='fill'?583:585,item=before.inventory.find(i=>i.id===id),op=item?.optionsWithIndex.find(v=>phase==='fill'?/^bail-with$/i.test(v.text):/^empty$/i.test(v.text));
  if(!item||!op)throw Error('native bailing bucket/action unavailable');
  if(!await d.item(item.slot,op.opIndex))throw Error('trawler bailing refused');
  if(!await d.wait(()=>trawlerEffect(before,state(),'bail',phase),Math.min(8,o.cap-(d.tick()-start))))throw Error('trawler bucket effect unobserved');
 };
 while(completed<o.maximum){
  const before=state();if(attempts>=o.maxAttempts)throw Error('trawler attempt limit');
  if(o.mode==='bail'){
   if(before.player!.level!==0||Math.floor(before.player!.worldX/64)!==31)throw Error('bail only in flooded hold');
   if(count(before,585)!==0)throw Error('start bail cycle with empty bucket');
   attempts++;await useBucket('fill');await useBucket('empty');completed++;
  }else{
   const need=o.mode==='net'?954:1941;if(count(before,need)<1)throw Error('trawler repair supply exhausted');
   const ids=o.mode==='net'?[2172,2173]:[2167],target=before.nearbyLocs.filter(l=>ids.includes(l.id)&&l.distance<=2&&l.level===before.player!.level&&l.reachable!==false).sort((a,b)=>a.distance-b.distance)[0];
   const option=target?.optionsWithIndex.find(v=>o.mode==='net'?/^inspect$/i.test(v.text):/^fill$/i.test(v.text));
   if(!target||!option){await d.step();continue;}
   attempts++;const seen=new Set(before.gameMessages.map(m=>m.observationId??`${m.tick}:${m.text}`));
   if(!await d.object(target.x,target.z,target.id,option.opIndex))throw Error('trawler repair refused');
   let made=false,miss=false;
   await d.wait(()=>{const current=state();made=trawlerEffect(before,current,o.mode);miss=o.mode==='net'&&current.gameMessages.some(m=>m.type===0&&!seen.has(m.observationId??`${m.tick}:${m.text}`)&&/^You fail to repair the net in the harsh conditions\.$/.test(m.text));return made||miss;},Math.min(10,o.cap-(d.tick()-start)));
   if(made)completed++;else if(!miss)throw Error('trawler repair effect unobserved');
  }
  if(completed<o.maximum)await d.step();
 }
 return{mode:o.mode,completed,attempts,ticks:d.tick()-start};
}
if(import.meta.main&&process.argv[3]==='trip'){
 const name=process.argv[2];if(!name)throw Error('account required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));
 try{const {runTrawlerTrip}=await import('./microbot-trawler-trip');const r=await runTrawlerTrip(s,{cap:Number(process.argv[4]??2200),stop:()=>existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all')});console.log('TRAWLER_TRIP '+JSON.stringify(r));await finish([s],r.ok,JSON.stringify(r));}catch(e){const state=s.sdk.getState();console.log('TRAWLER_ERROR_STATE '+JSON.stringify({player:state?.player,locs:state?.nearbyLocs,ground:state?.groundItems,inventory:state?.inventory,messages:state?.gameMessages,modal:state?.modalInterface}));await finish([s],false,String(e));}
}else if(import.meta.main){
 const name=process.argv[2],mode=process.argv[3] as TrawlerMode,maximum=Number(process.argv[4]??1),cap=Number(process.argv[5]??200);if(!name)throw Error('account required');
 const s=await openBot(name).catch(e=>finish([],false,`login: ${String(e)}`));let ended=false;void s.ended.then(()=>{ended=true;});
 try{const result=await runTrawlerSupport({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:()=>ended||existsSync(`.practice/stop-${name}`)||existsSync('.practice/stop-all'),object:async(x,z,id,op)=>(await s.sdk.sendInteractLoc(x,z,id,op)).success,item:async(slot,op)=>(await s.sdk.sendUseItem(slot,op)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1)},{mode,maximum,cap,maxAttempts:Number(process.env.MAX_ATTEMPTS??100)});await finish([s],true,JSON.stringify(result));}catch(e){await finish([s],false,String(e));}
}
