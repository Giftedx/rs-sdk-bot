import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

test('idle169/170 cannot settle the queued level-up171 or its rejected approach',()=>{
 const code=`
 import {mock} from 'bun:test';import {resolve} from 'node:path';
 mock.module(resolve('packages/core/src/bot'),()=>({openBot:()=>{},finish:()=>{},countItems:()=>0}));
 let tick=167,dialog=false,rejected=0,walkAt=-1,dispatchAt=-1,closedAt=-1,levelAt=171;
 let player={worldX:2843,worldZ:4832,level:0,animId:791};
 const walks=[],dispatches=[],observations=[];
 const advance=()=>{tick++;if(tick>=169)player.animId=-1;
  if(tick===levelAt){dialog=true;rejected++;walkAt=-1;}
  if(walkAt>=0&&tick>walkAt&&closedAt>=171&&!dialog)
   player={worldX:2841,worldZ:4829,level:0,animId:-1};
  if(dispatchAt>=0&&tick>dispatchAt)player={worldX:2983,worldZ:3288,level:0,animId:-1};
  observations.push({tick,dialog,rejected,player:{...player}});
 };
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p,{timeoutTicks})=>{
  if(p())return true;for(let i=0;i<timeoutTicks;i++){advance();if(p())return true;}return false;
 }}));
 const {exitAirAltar}=await import('./scripts/generated/rcair');
 const s={tick:()=>tick,onTick:()=>()=>{},sdk:{
  getState:()=>({player,dialog:{isOpen:dialog},interface:{isOpen:dialog},modalOpen:dialog,
   opFeedback:{opRejectedCount:rejected,mapFlagUnsetCount:6+rejected},
   gameMessages:tick>=levelAt?[{text:'Congratulations, you just advanced a runecraft level.',tick:levelAt,observationId:213}]:[]}),
  findNearbyLoc:()=>({id:2465,x:2841,z:4828,optionsWithIndex:[{opIndex:1,text:'Use'}]}),
  findPath:()=>({success:true,reachedDestination:true}),
  sendWalk:async(x,z)=>{walkAt=tick;walks.push({tick,x,z,closedAt});return {success:true};},
  sendInteractLoc:async()=>{dispatchAt=tick;dispatches.push({tick,dialog,player:{...player}});return {success:true};}},
  bot:{dismissBlockingUI:async()=>{if(dialog){dialog=false;closedAt=tick;}}}};
 const rows=[];
 for(levelAt of [171,174]){
  tick=167;dialog=false;rejected=0;walkAt=dispatchAt=closedAt=-1;
  player={worldX:2843,worldZ:4832,level:0,animId:791};walks.length=dispatches.length=observations.length=0;
  await exitAirAltar(s);
  rows.push({levelAt,walks:[...walks],dispatches:[...dispatches],observations:[...observations],closedAt,player});
 }
 console.log('LEVEL_RESULT '+JSON.stringify(rows));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:30000});
 if(child.exitCode!==0)throw Error(child.signalCode?`child killed by ${child.signalCode} (30 s limit)`:child.stderr.toString());
 const rows=JSON.parse(child.stdout.toString().split(/\r?\n/).find(l=>l.startsWith('LEVEL_RESULT '))!.slice(13));
 for(const row of rows){
 expect(row.observations.filter((o:{tick:number})=>o.tick===169||o.tick===170).map((o:any)=>[o.player.animId,o.dialog])).toEqual([[-1,false],[-1,false]]);
 expect(row.observations.find((o:{tick:number})=>o.tick===row.levelAt)).toMatchObject({dialog:true,rejected:1,player:{worldX:2843,worldZ:4832}});
 expect(row.closedAt).toBe(row.levelAt);expect(row.walks).toHaveLength(row.levelAt===171?1:2);
 expect(row.walks.at(-1).tick).toBeGreaterThan(row.closedAt);
 if(row.levelAt===174)expect(row.walks[0].tick).toBeLessThan(row.closedAt);
 expect(row.dispatches).toHaveLength(1);
 expect(row.dispatches[0]).toMatchObject({dialog:false,player:{worldX:2841,worldZ:4829,animId:-1}});
 expect(row.dispatches[0].tick).toBeGreaterThan(row.walks.at(-1).tick+1);
 expect(row.player).toMatchObject({worldX:2983,worldZ:3288});
 }
},40_000); // The child runs a full simulated session: past 10 s on the loaded Windows PC

test('air exit settles the delayed craft and waypoint trace before one portal dispatch',()=>{
 const code=`
 import {mock} from 'bun:test';import {resolve} from 'node:path';
 let tick=171,mode='',walkAt=-1,dispatchAt=-1,closes=0;
 mock.module(resolve('packages/core/src/bot'),()=>({openBot:()=>{},finish:()=>{},countItems:()=>0}));
 let player,dialog,faceTicks=0;const walks=[],dispatches=[];
 const portal={id:2465,x:2841,z:4828,optionsWithIndex:[{opIndex:1,text:'Use'}]};
 const state=()=>({player,dialog:{isOpen:dialog},interface:{isOpen:dialog},gameMessages:
  mode==='rejected'&&dispatchAt>=0&&tick>dispatchAt?[{text:"I can't reach that!",tick,observationId:tick}]:[]});
 const advance=()=>{tick++;
  if(tick===175)dialog=true;
  if(tick>=177)player.animId=-1;
  if(walkAt>=0&&tick>walkAt){
   // A momentary arrival can precede a late waypoint from the craft-busy walk.
   const dz=mode==='drift'&&faceTicks++===1?4831:4829;
   player={worldX:dz===4829?2841:2842,worldZ:dz,level:0,animId:-1};
  }
  if(dispatchAt>=0&&mode!=='rejected'&&mode!=='no-effect'&&tick>dispatchAt)
   player={worldX:2983,worldZ:3288,level:0,animId:-1};
 };
 mock.module(resolve('packages/core/src/ticks'),()=>({waitUntil:async(_s,p,{timeoutTicks})=>{
  if(p())return true;for(let i=0;i<timeoutTicks;i++){advance();if(p())return true;}return false;
 }}));
 const {exitAirAltar}=await import('./scripts/generated/rcair');
 const results=[];
 for(mode of ['trace','drift','rejected','no-effect','stopped']){
  tick=171;walkAt=dispatchAt=-1;faceTicks=closes=0;walks.length=dispatches.length=0;
  player={worldX:2843,worldZ:4832,level:0,animId:791};dialog=false;
  const s={tick:()=>tick,onTick:()=>()=>{},sdk:{getState:state,findNearbyLoc:()=>portal,
   findPath:()=>({success:true,reachedDestination:true}),
   sendWalk:async(x,z)=>{walks.push({tick,x,z});walkAt=tick;return {success:true};},
   sendInteractLoc:async()=>{dispatchAt=tick;dispatches.push({tick,player:{...player},dialog});return {success:true};}},
   bot:{dismissBlockingUI:async()=>{if(dialog){closes++;dialog=false;}},
    walkTo:async()=>{
     // Saved failure: a craft-busy waypoint walk returns on its earlier destination,
     // with a later move to2842,4831 still pending after the tick177 portal click.
     while(tick<177)advance();player={worldX:2841,worldZ:4829,level:0,animId:-1};
     walkAt=177;return {success:true};
    }}};
  let error='';try{await exitAirAltar(s,()=>mode==='stopped'&&tick>=176);}catch(e){error=String(e);}
  results.push({mode,error,closes,walks:[...walks],dispatches:[...dispatches],player});
 }
 console.log('TRACE_RESULT '+JSON.stringify(results));
 `;
 const child=Bun.spawnSync([process.execPath,'-e',code],{cwd:resolve(import.meta.dir,'..'),windowsHide:true,stdout:'pipe',stderr:'pipe',timeout:30000});
 if(child.exitCode!==0)throw Error(child.signalCode?`child killed by ${child.signalCode} (30 s limit)`:child.stderr.toString());
 expect(child.exitCode).toBe(0);
 const rows=JSON.parse(child.stdout.toString().split(/\r?\n/).find(l=>l.startsWith('TRACE_RESULT '))!.slice(13));
 for(const row of rows){
  if(row.mode==='stopped'){expect(row.error).toContain('air exit stopped');expect(row.dispatches).toHaveLength(0);continue;}
  expect(row.closes).toBe(1);expect(row.walks).toHaveLength(1);
  expect(row.walks[0].tick).toBeGreaterThanOrEqual(177);
  expect(row.walks[0]).toMatchObject({x:2841,z:4829});expect(row.dispatches).toHaveLength(1);
  expect(row.dispatches[0]).toMatchObject({player:{worldX:2841,worldZ:4829,animId:-1},dialog:false});
  expect(row.dispatches[0].tick).toBeGreaterThan(row.walks[0].tick+1);
  if(row.mode==='rejected')expect(row.error).toContain('rejected after dispatch; no unchanged retry');
  else if(row.mode==='no-effect')expect(row.error).toContain('air portal exit unobserved');
  else {expect(row.error).toBe('');expect(row.player).toMatchObject({worldX:2983,worldZ:3288});}
 }
 expect(rows.find((r:{mode:string})=>r.mode==='drift').dispatches[0].tick).toBeGreaterThan(rows[0].dispatches[0].tick);
},40_000); // The child runs a full simulated session: past 10 s on the loaded Windows PC
