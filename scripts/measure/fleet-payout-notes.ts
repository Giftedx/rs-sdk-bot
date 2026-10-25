// Native preparation proof; no receiver/trade or new stock is claimed.
import {openBot,finish} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
import {preparePayout} from '../banker';
const s=await openBot(process.argv[2]!);
const count=(items:{id:number;count:number}[],id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
try{
 await waitUntil(s,()=> (s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15});
 const t0=s.tick(),kit=s.sdk.getInventory().map(i=>({id:i.id,count:i.count}));
 const r=await preparePayout(s,[{name:'Flax',count:106}],true,/shears|shrimps|bread/i);
 const notes=count(s.sdk.getInventory(),1780),rawHeld=count(s.sdk.getInventory(),1779);
 if(!(await s.bot.openBank()).success)throw new Error('verification bank failed');await waitTicks(s,2);
 const rawRemaining=count(s.sdk.getState()?.bank?.items??[],1779);
 const prepared=notes===106&&rawHeld===0&&rawRemaining===644&&r.withdrawn===106;
 const note=s.sdk.getInventory().find(i=>i.id===1780);if(note)await s.bot.depositItem(note,-1);await waitTicks(s,2);
 const restored=count(s.sdk.getState()?.bank?.items??[],1779),heldNotes=count(s.sdk.getInventory(),1780);
 const preserved=kit.every(i=>count(s.sdk.getInventory(),i.id)===i.count);
 const result={ok:prepared&&restored===750&&heldNotes===0&&preserved,notes,rawHeld,rawRemaining,restored,heldNotes,preserved,ticks:s.tick()-t0,bank:s.sdk.getState()?.bank?.items,inventory:s.sdk.getInventory()};
 console.log('PAYOUT_PROOF '+JSON.stringify(result));await s.bot.closeBank();await finish([s],result.ok,`payoutNotes notes=${notes} rawRemaining=${rawRemaining} restored=${restored} preserved=${preserved}`);
}catch(e){await finish([s],false,String(e));}
