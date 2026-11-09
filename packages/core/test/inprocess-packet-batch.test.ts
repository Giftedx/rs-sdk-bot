import {test,expect} from 'bun:test';
import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';
import {createShim} from '../src/inprocess';

function batchClient(){
 let notify:(()=>void)|null=null;
 const state={inGame:true,player:{worldX:2522,worldZ:4832,level:0},trade:{isOpen:true,screen:'offer'},skills:[],inventory:[],gameMessages:[],opFeedback:{opRejectedCount:0}};
 const client={
  collectBotState:(tick:number)=>structuredClone({...state,tick}),
  executeBotAction:()=>({success:true,message:'dispatched'}),
  setOnGameTickCallback:(cb:(()=>void)|null)=>{notify=cb;},
  async pumpPackets(){
   notify?.(); // PLAYER_INFO precedes the remaining interface packets and snapEntities.
   await Promise.resolve();
   state.trade.screen='confirm';state.player.worldX=2523;
  },
  fire:()=>notify?.(),
 };
 const sdk=new BotSDK({botUsername:'batchtest',password:'fixture',autoLaunchBrowser:false,autoReconnect:false} as any);
 return{client,sdk,state};
}

test('tick observers see interface packets and snapped positions from the completed packet pump',async()=>{
 const {client,sdk}=batchClient(),shim=createShim(client,sdk),seen:any[]=[];
 shim.start();const off=shim.onTick(()=>seen.push(sdk.getState()));
 try{
  await client.pumpPackets();
  expect(seen).toHaveLength(1);
  expect(seen[0].trade.screen).toBe('confirm');
  expect(seen[0].player.worldX).toBe(2523);
  expect(shim.tick()).toBe(1);
 }finally{off();shim.stop('fixture-ended');}
});

test('stopping during packet decoding suppresses queued tick callbacks and restores the pump',async()=>{
 const {client,sdk}=batchClient();
 let stop=()=>{};
 const pump=async()=>{client.fire();stop();await Promise.resolve();};
 client.pumpPackets=pump;
 const shim=createShim(client,sdk);stop=()=>shim.stop('fixture-ended');
 let calls=0;shim.start();shim.onTick(()=>calls++);
 await client.pumpPackets();
 expect(calls).toBe(0);
 expect(client.pumpPackets).toBe(pump);
});

test('a pump that drains several tick packets retains their count and listener boundaries',async()=>{
 const {client,sdk}=batchClient();
 client.pumpPackets=async()=>{client.fire();await Promise.resolve();client.fire();};
 const shim=createShim(client,sdk),ticks:number[]=[];
 shim.start();shim.onTick(()=>ticks.push(shim.tick()));
 try{await client.pumpPackets();expect(ticks).toEqual([1,2]);expect(shim.tick()).toBe(2);}
 finally{shim.stop('fixture-ended');}
});
