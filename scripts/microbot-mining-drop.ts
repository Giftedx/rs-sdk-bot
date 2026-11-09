import {existsSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import {waitUntil,waitTicks} from '../packages/core/src/ticks';
import {eligiblePickaxe,miningProfiles,runAtSiteMining,type MiningDriver,type MiningProfile} from './microbot-b-mining';
import type {BotWorldState} from '../vendor/rs-sdk/sdk/types';

export interface MiningDropJob {maximum:number;cap:number;idleTicks:number;keep:readonly number[]}
export interface MiningDropDriver extends MiningDriver {drop:(slot:number)=>Promise<boolean>}
const stock=(s:BotWorldState)=>{const out:Record<number,number>={};for(const i of s.inventory)out[i.id]=(out[i.id]??0)+i.count;return out;};
// The existing miner owns ore/XP receipts. This adapter owns explicit discard
// receipts and resumes that same miner without changing its default bank mode.
export async function runDropMining(d:MiningDropDriver,p:MiningProfile,o:MiningDropJob){
 if(![o.maximum,o.cap,o.idleTicks].every(n=>Number.isSafeInteger(n)&&n>0)||o.maximum>100000||o.cap>100000||o.keep.some(n=>!Number.isSafeInteger(n)||n<0)||new Set(o.keep).size!==o.keep.length)throw Error('invalid finite mining drop order');
 const initial=d.state();if(!initial?.player)throw Error('mining drop state unknown');
 const pick=eligiblePickaxe(initial);if(!pick||initial.inventory.some(i=>i.id===pick.id)&&!o.keep.includes(pick.id))throw Error('keep the owned inventory pickaxe');
 const life=initial.player.lifeId,level=initial.player.level,hp=initial.skills.find(k=>k.name==='Hitpoints')?.level,kit=JSON.stringify(initial.equipment),start=d.tick(),before=stock(initial),dropped:Record<number,number>={},outputs:Record<number,number>={};
 let made=0,xp=0,sideGems=0,attempts=0,progress=start;
 const state=()=>{const s=d.state();if(d.stop()||!s?.player||s.player.isDead||s.player.lifeId!==life||s.player.level!==level||s.skills.find(k=>k.name==='Hitpoints')?.level!==hp||JSON.stringify(s.equipment)!==kit)throw Error('mining drop stopped or life/kit changed');if(d.tick()-start>=o.cap)throw Error('mining drop cap');return s;};
 while(made<o.maximum){
  let s=state();if(d.tick()-progress>=o.idleTicks)throw Error('mining drop no useful ore progress');
  // Leave room for an incidental gem before the next ore receipt.
  if(s.inventory.length>=27){
   const discard=s.inventory.filter(i=>!o.keep.includes(i.id)).map(i=>({id:i.id,slot:i.slot,count:i.count}));if(!discard.length)throw Error('mining drop pack contains only retained items');
   for(const row of discard){
    s=state();const item=s.inventory.find(i=>i.slot===row.slot&&i.id===row.id&&i.count===row.count),custom=item?.optionsWithIndex?.filter(v=>v.opIndex===5)??[];if(!item||custom.length>1||custom.some(v=>!/^drop$/i.test(v.text)))throw Error('fresh native Drop slot required; custom fifth action refused');
    // StateCollector exposes object-specific options, not the generic Drop.
    // SDK sendDropItem uses native opheld5,_ -> dropslot for ordinary ore.
    const b=stock(s);let accepted=false;try{accepted=await d.drop(item.slot);}catch{/* An exact effect may still settle after a lost reply. */}
    const exact=()=>{const a=stock(state());return[...new Set([...Object.keys(a),...Object.keys(b)].map(Number))].every(id=>(a[id]??0)-(b[id]??0)===(id===row.id?-row.count:0));};
    await d.wait(exact,Math.min(8,o.cap-(d.tick()-start)));if(!exact())throw Error('native drop outcome unconfirmed'+(accepted?'':' after refused/lost reply'));
    dropped[row.id]=(dropped[row.id]??0)+row.count;
   }
  }
  const remaining=o.cap-(d.tick()-start);if(remaining<1)throw Error('mining drop cap');
  const result=await runAtSiteMining({...d,stop:()=>d.stop()||d.tick()-start>=o.cap},p,{maximum:1,cap:remaining,idleTicks:Math.min(o.idleTicks-(d.tick()-progress),remaining)});
  made+=result.made;xp+=result.xp;sideGems+=result.sideGems;attempts+=result.attempts;for(const[id,n]of Object.entries(result.outputs))outputs[Number(id)]=(outputs[Number(id)]??0)+n;progress=d.tick();
 }
 const after=stock(state());for(const id of new Set([...Object.keys(before),...Object.keys(after),...Object.keys(outputs),...Object.keys(dropped)].map(Number)))if((after[id]??0)-(before[id]??0)!==(outputs[id]??0)-(dropped[id]??0))throw Error('mining drop final asset audit');
 return{made,xp,sideGems,attempts,outputs,dropped,banked:0,ticks:d.tick()-start};
}
if(import.meta.main){
 const name=process.argv[2],p=miningProfiles().find(p=>p.name===process.argv[3]);if(!name||!p)throw Error('usage: microbot-mining-drop.ts account native-profile maximum cap keep-ids');
 const s=await openBot(name);let ended=false;void s.ended.then(()=>{ended=true;});
 try{const r=await runDropMining({state:()=>s.sdk.getState(),tick:()=>s.tick(),stop:()=>ended||existsSync('.practice/stop-all')||existsSync(`.practice/stop-${name}`),mine:async l=>(await s.sdk.sendInteractLoc(l.x,l.z,l.id,1)).success,drop:async slot=>(await s.sdk.sendDropItem(slot)).success,wait:(test,ticks)=>waitUntil(s,test,{timeoutTicks:ticks}),step:()=>waitTicks(s,1),clearModal:async()=>{await s.sdk.sendCloseModal();}},p,{maximum:Number(process.argv[4]),cap:Number(process.argv[5]??2000),idleTicks:Number(process.env.IDLE_TICKS??300),keep:(process.argv[6]??'').split(',').filter(Boolean).map(Number)});await finish([s],true,JSON.stringify(r));}catch(error){await finish([s],false,String(error));}
}
