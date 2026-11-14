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

// Bench --profile, extra:firemaking-stock-low: 18 ticks held to SIM_BUSY_MS with sdk=waitForObservation,waitForCondition
// and state=1/1. A script whose first SDK wait is open at the first tick check set the lowest listener count to that
// wait, and the ack then never counted a single SDK wait again.
test('a lockstep tick is acknowledged at once while an SDK wait that was open at the first check is pending', async () => {
    const saved = { lockstep: process.env.SIM_LOCKSTEP, busy: process.env.SIM_BUSY_MS };
    process.env.SIM_LOCKSTEP = '1'; process.env.SIM_BUSY_MS = '400';
    try {
        let cb: (() => void) | null = null;
        const acks: number[] = [];
        const client: any = {
            collectBotState: (tick: number) => ({ tick, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0 }, skills: [], inventory: [], gameMessages: [] }),
            executeBotAction: () => ({ success: true, message: 'ok' }),
            setOnGameTickCallback(c: () => void) { cb = c; }, getMaxMessageLength: () => 400,
            flush() {}, writeOpcode() { acks.push(performance.now()); },
        };
        const sdk = new BotSDK({ botUsername: 't', password: 'x', autoLaunchBrowser: false, autoReconnect: false } as any);
        const shim = createShim(client, sdk);
        shim.start();
        // The wait opens before the first tick, so the first check already sees it.
        const wait = sdk.waitForCondition(st => st.tick >= 99, 5000).catch(() => {});
        const held: number[] = [];
        for (let t = 0; t < 3; t++) {
            const t0 = performance.now(), n0 = acks.length;
            cb!();
            while (acks.length === n0 && performance.now() - t0 < 1500) await new Promise(r => setTimeout(r, 2));
            held.push(acks[n0]! - t0);
        }
        shim.stop('done'); void wait;
        expect(held.every(ms => ms < 200)).toBe(true);
    } finally {
        if (saved.lockstep === undefined) delete process.env.SIM_LOCKSTEP; else process.env.SIM_LOCKSTEP = saved.lockstep;
        if (saved.busy === undefined) delete process.env.SIM_BUSY_MS; else process.env.SIM_BUSY_MS = saved.busy;
    }
});
