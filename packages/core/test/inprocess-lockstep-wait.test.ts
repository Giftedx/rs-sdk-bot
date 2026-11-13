import {test,expect,afterEach} from 'bun:test';
import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';
import {createShim} from '../src/inprocess';

// A client whose game ticks the test fires by hand.
function tickClient(){
 let notify:(()=>void)|null=null;
 const state={inGame:true,player:{worldX:3094,worldZ:3491,level:0},skills:[],inventory:[],gameMessages:[],opFeedback:{opRejectedCount:0}};
 const client={
  collectBotState:(tick:number)=>structuredClone({...state,tick}),
  executeBotAction:()=>({success:true,message:'dispatched'}),
  setOnGameTickCallback:(cb:(()=>void)|null)=>{notify=cb;},
  fire:()=>notify?.(),
 };
 const sdk=new BotSDK({botUsername:'waittest',password:'fixture',autoLaunchBrowser:false,autoReconnect:false} as any);
 return{client,sdk,state};
}
const saved={lockstep:process.env.SIM_LOCKSTEP,tickMs:process.env.SIM_WAIT_TICK_MS};
afterEach(()=>{
 if(saved.lockstep===undefined)delete process.env.SIM_LOCKSTEP;else process.env.SIM_LOCKSTEP=saved.lockstep;
 if(saved.tickMs===undefined)delete process.env.SIM_WAIT_TICK_MS;else process.env.SIM_WAIT_TICK_MS=saved.tickMs;
});

test('on a lockstep engine an SDK wait times out in game ticks, not in wall time',async()=>{
 process.env.SIM_LOCKSTEP='1';process.env.SIM_WAIT_TICK_MS='400';
 const {client,sdk}=tickClient(),shim=createShim(client,sdk);
 shim.start();
 try{
  client.fire();
  let failed:unknown=null;
  // 1000 ms at 400 ms a tick: the wait fails on the third tick after it starts.
  const wait=sdk.waitForCondition(()=>false,1000).catch(e=>{failed=e;});
  client.fire();client.fire();
  await Promise.resolve();
  expect(failed).toBeNull();
  client.fire();
  await wait;
  expect(String(failed)).toContain('waitForCondition timed out');
 }finally{shim.stop('fixture-ended');}
});

test('on a lockstep engine an SDK wait still ends on the tick its condition comes true',async()=>{
 process.env.SIM_LOCKSTEP='1';
 const {client,sdk,state}=tickClient(),shim=createShim(client,sdk);
 shim.start();
 try{
  client.fire();
  const wait=sdk.waitForCondition(s=>s.player?.worldX===3095,30_000);
  client.fire();
  state.player.worldX=3095;
  client.fire();
  expect((await wait).player?.worldX).toBe(3095);
 }finally{shim.stop('fixture-ended');}
});

test('on a lockstep engine the client ages animations by game ticks, just before the next tick is read',async()=>{
 process.env.SIM_LOCKSTEP='1';
 const {client:base,sdk}=tickClient();
 let cycles=0,available=0;
 const client={...base,tickSpeedMultiplier:7,tickCycle(){cycles++;},pumpPackets:async()=>{},conn:{stream:{get available(){return available;}}}};
 const shim=createShim(client,sdk);
 shim.start();
 try{
  // The session loop's 20 ms pass no longer ages, and the speed is the one of a 300 ms server.
  client.tickCycle();
  expect(cycles).toBe(0);
  expect(client.tickSpeedMultiplier).toBeCloseTo(1.4);
  base.fire();base.fire();
  await client.pumpPackets();
  expect(cycles).toBe(0); // nothing to read: the cycles wait for the next tick's packets
  available=10;
  await client.pumpPackets();
  expect(cycles).toBe(30); // two ticks of 15 cycles
  await client.pumpPackets();
  expect(cycles).toBe(30);
 }finally{shim.stop('fixture-ended');}
 expect(client.tickSpeedMultiplier).toBe(7);
});
