import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {featherPurchaseAmount,selectFoodSource} from './courier-route';

test('source selection uses the configured endpoint and the shared cooked-shark stock contract',()=>{
 const now=100000,server='127.0.0.1:21000',owned=new Set(['first','second']);
 const status=(name:string,id:number,count:number)=>({name,server,at:now,bankAt:now-1,bank:[{id,count}]});
 const first=status('First',333,10),second=status('Second',385,100);
 expect(selectFoodSource(['First','Second'],[first,second],owned,now,1,server)).toBe('Second');
 expect(selectFoodSource(['First','Second'],[first,second],owned,now)).toBeUndefined();
 expect(selectFoodSource(['First','Second'],[first,{...second,server:'rs-sdk-demo.fly.dev'}],owned,now,1,server)).toBe('First');
 for(const change of [{at:now-30000},{at:now+1},{result:'ok finished'},{bankAt:now+1},{bank:[{id:385,count:-1}]}])
  expect(selectFoodSource(['Second'],[{...second,...change}],owned,now,1,server)).toBeUndefined();
 expect(selectFoodSource(['First','Second'],[first,second],new Set(['first']),now,1,server)).toBeUndefined();
});

test('local feather stock suppresses excess purchases while stale or foreign stock keeps the configured limit',()=>{
 const now=100000,server='127.0.0.1:21000',status={name:'Cook',server,at:now,inventory:[{id:314,count:1200}]};
 expect(featherPurchaseAmount(500,'Cook',status,now,server)).toBe(0);
 expect(featherPurchaseAmount(500,'Cook',{...status,inventory:[{id:314,count:800}]},now,server)).toBe(200);
 expect(featherPurchaseAmount(500,'Cook',status,now)).toBe(500);
 for(const change of [{server:'rs-sdk-demo.fly.dev'},{server:'127.0.0.1:21010'},{at:now-30000},{at:now+1},{result:'fail stopped'},{name:'Foreign'},{inventory:[{id:314,count:-1}]}])
  expect(featherPurchaseAmount(500,'Cook',{...status,...change},now,server)).toBe(500);
});

function cliCase(mode:'sources'|'foreign'|'feathers'){
 const code=`
 import {mock} from 'bun:test';import {resolve} from 'node:path';
 const mode=${JSON.stringify(mode)},server='127.0.0.1:21000',now=100000,ownedRequests=[],selections=[],results=[];
 Date.now=()=>now;
 const realFs=await import('node:fs'),demand=await import('./packages/core/src/bank-demand');
 const readFile=realFs.readFileSync,selectSource=demand.selectCookedFoodSource;
 const player={worldX:mode==='feathers'?2654:3092,worldZ:mode==='feathers'?3283:3243,level:0,combatLevel:99};
 let tick=0,shopOpens=0,moves=0;
 const statuses={CookA:{name:'CookA',server,at:now,bankAt:now-1,bank:[{id:333,count:10}],inventory:[{id:314,count:1500}]},
  CookB:{name:'CookB',server,at:now,bankAt:now-1,bank:[{id:385,count:100}],inventory:[]}};
 if(mode==='foreign')for(const status of Object.values(statuses))status.server='rs-sdk-demo.fly.dev';
 mock.module('node:fs',()=>({...realFs,readFileSync:(path,...args)=>{
  const name=String(path);
  if(name.endsWith('/Fixture/bot.env'))return 'SERVER=rs-sdk-demo.fly.dev\\n';
  for(const [cook,status]of Object.entries(statuses))if(name.endsWith('/status/'+cook+'.json'))return JSON.stringify(status);
  return readFile(path,...args);
 }}));
 const s={name:'Fixture',lifecycle:{server},tick:()=>tick,onTick:()=>()=>{},sdk:{getState:()=>({player,inventory:[]}),getSkill:()=>({level:99})},
  bot:{openShop:async()=>{shopOpens++;throw Error('unexpected shop purchase');}}};
 const modules={
  './packages/core/src/bot':{openBot:async()=>s,finish:async(_sessions,ok,message)=>{results.push({ok,message});throw Error('fixture-finish');},
   countItems:()=>500,serverFromEnv:env=>env.match(/^SERVER=(.*)/m)[1],sessionDied:()=>false},
  './packages/core/src/ticks':{waitTicks:async(_s,n)=>{tick+=n;},waitUntil:async(_s,p)=>p()},
  './packages/core/src/tradeguard':{ownedAccounts:endpoint=>{ownedRequests.push(endpoint);return new Set(endpoint===server?['cooka','cookb']:[]);}},
  './packages/core/src/bank-demand':{...demand,selectCookedFoodSource:(...args)=>{const selected=selectSource(...args);selections.push({server:args[5],selected});return selected;}},
  './packages/core/src/walk':{sessionWalker:async()=>({}),walkPath:async(_deps,points)=>{moves++;const p=points.at(-1);player.worldX=p.x;player.worldZ=p.z;return{ok:true,next:points.length};}},
  './packages/core/src/boat':{sail:async(_s,{deck})=>{player.worldX=deck.x;player.worldZ=deck.z;player.level=1;return{ok:true};},
   disembark:async()=>{player.level=0;return{ok:true};}},
  './packages/core/src/deposit':{depositObserved:async()=>{throw Error('unexpected deposit');}},
  './scripts/courier-funding':{requestCourierFunding:async()=>{throw Error('unexpected funding');}},
  './scripts/courier-handoff':{awaitCollectionOffer:async()=>{throw Error('unexpected collection');},collectHandoff:async()=>{},sendHandoff:async()=>{}},
 };
 for(const [path,module]of Object.entries(modules))mock.module(resolve(path),()=>module);
 process.argv=[process.execPath,'scripts/foodcourier.ts','Fixture'];
 console.log=()=>{};
 try{await import('./scripts/foodcourier');}catch(error){if(!String(error).includes('fixture-finish'))throw error;}
 process.stdout.write(JSON.stringify({ownedRequests,selections,result:results[0],shopOpens,moves,player}));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:10000,
  env:{...process.env,FROM:mode==='feathers'?'CookA':'CookA,CookB',OUTBOUND_ONLY:'1',HOME_ONLY:'',START:'',FUND_FROM:'',FUND_ONLY:'',RESERVE_OPENING_CASH:'',
   FARMERS:'',PER:'',TOTAL_PER:'0',FEATHERS:mode==='feathers'?'500':'0',CAP:'1200'}});
 if(child.exitCode!==0)throw Error(child.stdout.toString()+child.stderr.toString());
 return JSON.parse(child.stdout.toString());
}

test('actual courier CLI selects only owned cooks at its configured endpoint before movement',()=>{
 const selected=cliCase('sources');
 expect(selected.ownedRequests).toEqual(['127.0.0.1:21000']);
 expect(selected.selections).toEqual([{server:'127.0.0.1:21000',selected:'CookB'}]);
 expect(selected.result.message).toContain('outbound supply trip requires Ardougne bank start');
 expect(selected.moves).toBe(0);
 const foreign=cliCase('foreign');
 expect(foreign.result.message).toContain('no active owned cook with banked food');
 expect(foreign.moves).toBe(0);
});

test('actual courier CLI retains the cook feather surplus on a local outbound trip',()=>{
 const result=cliCase('feathers');
 expect(result.result).toMatchObject({ok:true});
 expect(result.result.message).toContain('outboundOnly=true');
 expect(result.shopOpens).toBe(0);
 expect(result.moves).toBeGreaterThan(0);
 expect(result.player).toMatchObject({worldX:3092,worldZ:3243,level:0});
});
