import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

test('lockstep distinguishes route work from persistent listeners and real server waits',async()=>{
 const probe=`
 import assert from 'node:assert/strict';
 import {BotSDK} from './vendor/rs-sdk/sdk/index';
 import {createShim} from './packages/core/src/inprocess';
 import {executionContext} from './vendor/rs-sdk/sdk/execution-context';
 const workers=[];
 globalThis.Worker=class{constructor(){workers.push(this);}ref(){}unref(){}terminate(){}postMessage(request){this.request=request;}reply(){this.onmessage({data:{id:this.request.id,plan:null}});}};
 const {planTripOffThread}=await import('./packages/core/src/route-plan');
 const until=async(f,ms=1500)=>{const end=performance.now()+ms;while(!f()&&performance.now()<end)await Bun.sleep(2);assert.ok(f(),'fixture event deadline');};
 for(const mode of ['reply','cancel','error','cap','hung','hold','server','tick-wait']){
  process.env.SIM_LOCKSTEP='1';process.env.SIM_BUSY_MS=mode==='hold'||mode==='hung'?'100':'400';
  if(mode==='cap')process.env.SIM_ROUTE_MS='400';else if(mode==='hung')process.env.SIM_ROUTE_MS='600';else delete process.env.SIM_ROUTE_MS;
  let fire,resolveServer;const acks=[];
  const client={collectBotState:tick=>({tick,inGame:true,player:{worldX:3085,worldZ:3250,level:0},skills:[],inventory:[],gameMessages:[]}),
   executeBotAction:()=>new Promise(r=>{resolveServer=r;}),setOnGameTickCallback:f=>{fire=f;},getMaxMessageLength:()=>400,flush(){},writeOpcode(){acks.push(performance.now());}};
  const sdk=new BotSDK({botUsername:'fixture',password:'fixture',autoLaunchBrowser:false,autoReconnect:false});
  const shim=createShim(client,sdk);shim.start();
  const background=sdk.waitForCondition(s=>s.tick>=2,5000).catch(()=>{});
  const controller=new AbortController(),tile={x:1,z:1,level:0};
  const route=executionContext.run({signal:controller.signal},()=>planTripOffThread(tile,tile,{skills:{},varps:{},items:[]})).catch(e=>e.message);
  const w=workers.at(-1);let action;
  try{
   if(mode==='server'){action=sdk.sendAction({type:'clickButton',componentId:1});await until(()=>!!resolveServer);}
   if(mode==='tick-wait'){action=sdk.sendAction({type:'wait',ticks:2});await Bun.sleep(2);}
   const started=performance.now();fire();
   if(mode==='server'||mode==='tick-wait'){await until(()=>acks.length>0);assert.ok(acks[0]-started<250,'real game input wait must advance');}
   else{
    await Bun.sleep(20);assert.equal(acks.length,0,'pending off-tick route must hold ACK despite persistent listener');
    if(mode==='cap'){await until(()=>acks.length>0);assert.ok(acks[0]-started>=300&&acks[0]-started<1500,'SIM_ROUTE_MS must bound route hold');}
    // A worker that never answers: the first tick waits for the bound, and the ticks after it do not wait for it again.
    else if(mode==='hung'){await until(()=>acks.length>0);assert.ok(acks[0]-started>=500,'the search holds its first tick to SIM_ROUTE_MS');const next=performance.now();fire();await until(()=>acks.length>1);assert.ok(acks[1]-next<400,'a search past SIM_ROUTE_MS must not hold the next tick: '+Math.round(acks[1]-next)+' ms');}
    else if(mode==='hold'){await Bun.sleep(350);assert.equal(acks.length,0,'a route search must hold the tick past the busy cap');w.reply();await route;await until(()=>acks.length>0);assert.ok(acks[0]-started<700,'route settlement must release the held tick');}
    else{if(mode==='cancel')controller.abort(Error('fixture cancelled'));else if(mode==='error')w.onerror({message:'fixture worker error'});else w.reply();await route;await until(()=>acks.length>0);assert.ok(acks[0]-started<300,'route settlement must release before busy cap');}
   }
  }finally{w.reply();resolveServer?.({success:true});fire();await route;await action;await background;shim.stop('fixture complete');}
 }
 `;
 const p=Bun.spawn([process.execPath,'-e',probe],{cwd:resolve(import.meta.dir,'../../..'),stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>p.kill(),12000);
 try{const [code,stderr]=await Promise.all([p.exited,new Response(p.stderr).text()]);expect(stderr).toBe('');expect(code).toBe(0);}finally{clearTimeout(timer);}
},14000);
