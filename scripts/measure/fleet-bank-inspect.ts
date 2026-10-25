// Local endpoint observation after a production route has logged out.
import {openBot,finish} from '../../packages/core/src/bot';
import {waitTicks,waitUntil} from '../../packages/core/src/ticks';
const s=await openBot(process.argv[2]!);
try{
 await waitUntil(s,()=> (s.sdk.getSkill('Hitpoints')?.level??0)>0,{timeoutTicks:15});
 if(!(await s.bot.openBank()).success)throw new Error('endpoint bank unavailable');
 await waitTicks(s,2);
 console.log('ENDPOINT_BANK '+JSON.stringify({bank:s.sdk.getState()?.bank?.items,inventory:s.sdk.getInventory(),pos:s.sdk.getState()?.player}));
 await s.bot.closeBank();await finish([s],true,'endpoint bank inspected');
}catch(e){await finish([s],false,String(e));}
