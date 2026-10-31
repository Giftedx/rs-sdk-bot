import {expect,test} from 'bun:test';
import {MEATS,BEAR_SPAWNS,HOP,STALL_TICKS,missingMeats,bearRefusal,runDruidMeats,waypointChain,floorExit} from './druid-meats';

test('Carnillean upper floor approaches the known stairstop loc, not the nearer door or climb-up ladder',()=>{
 const op=(text:string)=>[{text,opIndex:1}];
 const locs=[{id:1533,x:2572,z:3268,optionsWithIndex:op('Open')},{id:1747,x:2573,z:3271,optionsWithIndex:op('Climb-up')},
  {id:1,x:2571,z:3266,optionsWithIndex:op('Climb-down')},{id:1723,x:2568,z:3268,optionsWithIndex:op('Climb-down')}];
 const exit=floorExit({x:2572,z:3268,level:1},locs)!;
 expect([exit.loc.id,exit.opIndex,exit.known,exit.stand]).toEqual([1723,1,true,{x:2568,z:3268}]);
 expect(floorExit({x:2572,z:3268,level:1},locs.slice(0,2))).toBeNull();
});

test('ownership skips exact meats in either bank or pack',()=>{
 expect(missingMeats([{id:2132,count:1}],[{id:2134,count:1},{id:2136,count:1},{id:2139,count:1}]).map(m=>m.item)).toEqual([2138]);
 expect(MEATS.map(m=>m.item)).toEqual([2132,2134,2136,2138]);
});
test('bear admission names missing strength and health',()=>{
 expect(bearRefusal(75,94,83,76)).toBeNull();
 expect(bearRefusal(10,1,1,1)).toContain('too-weak-for-bear');
 expect(bearRefusal(NaN,94,83,76)).toContain('too-weak-for-bear');
});
function fixture(items:number[],weak=false){
 const st:any={inGame:true,player:{worldX:2619,worldZ:3332,level:0,lifeId:1},bank:{isOpen:true},inventory:[],equipment:[],nearbyNpcs:[],groundItems:[]};
 const bank=items.map(id=>({id,count:1}));
 let travel=0,attacks=0;
 const s:any={name:'fixture',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),
  bankObservation:()=>({generation:1,items:bank}),sdk:{getState:()=>st,getInventory:()=>st.inventory,getEquipment:()=>[],getSkill:()=>({level:weak?10:75,baseLevel:weak?10:75})},
  bot:{closeBank:async()=>({success:true}),attack:async()=>{attacks++;throw Error('unexpected attack');}}};
 return {s,travel:async()=>{travel++;},counts:()=>({travel,attacks})};
}
test('all-owned rerun refuses before travel or attack',async()=>{
 const f=fixture(MEATS.map(m=>m.item));
 await expect(runDruidMeats(f.s,{travel:f.travel})).rejects.toThrow('all-meats-owned');
 expect(f.counts()).toEqual({travel:0,attacks:0});
});

test('upper-floor exit interacts beside the stair when the reverse landing has no path',async()=>{
 const f=fixture(MEATS.map(m=>m.item)),st=f.s.sdk.getState();
 Object.assign(st.player,{worldX:2572,worldZ:3268,level:1});
 st.nearbyLocs=[{id:1723,x:2568,z:3268,level:1,distance:4,optionsWithIndex:[{text:'Climb-down',opIndex:1}]}];
 const walks:number[][]=[],interactions:number[][]=[];
 f.s.bot.walkTo=async(x:number,z:number,tolerance:number)=>{
  walks.push([x,z,tolerance]);
  Object.assign(st.player,{worldX:2568,worldZ:3267});
  st.nearbyLocs[0].distance=1;
  return z===3264?{success:false,message:'No path to (2568, 3264) from (2568, 3267): no waypoints'}:{success:true};
 };
 f.s.bot.interactLoc=async(loc:any,op:number)=>{
  interactions.push([loc.id,op,st.player.worldX,st.player.worldZ,st.player.level]);
  Object.assign(st.player,{worldX:2568,worldZ:3271,level:0});
  return {success:true};
 };
 await expect(runDruidMeats(f.s,{travel:f.travel})).rejects.toThrow('all-meats-owned');
 expect(walks).toEqual([[2568,3268,1]]);
 expect(interactions).toEqual([[1723,1,2568,3267,1]]);
 expect(st.player.level).toBe(0);
 expect(f.counts()).toEqual({travel:0,attacks:0});
});
test('weak account refuses missing bear before outbound travel',async()=>{
 const f=fixture([2132,2134,2138],true);
 await expect(runDruidMeats(f.s,{travel:f.travel})).rejects.toThrow('too-weak-for-bear');
 expect(f.counts()).toEqual({travel:0,attacks:0});
});
test('waypoint chain keeps every hop within HOP and refuses Yanille to Lumbridge',()=>{
 expect(waypointChain({x:2612,z:3093},{x:3159,z:3233})).toBeNull();
 const chain=waypointChain({x:2692,z:3333},{x:2484,z:3155})!;
 expect(chain.map(t=>[t.x,t.z])).toEqual([[2654,3283],[2517,3184],[2484,3155]]);
 chain.reduce((a,b)=>{expect(Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z))).toBeLessThanOrEqual(HOP);return b;},{x:2692,z:3333});
});
test('a travel leg with no movement for 20 ticks is retried once, then refused with the leg named',async()=>{
 const f=fixture([2132,2134,2138]);
 let tick=0,settled=false;const listeners=new Set<()=>void>(),legs:{x:number;z:number;tick:number}[]=[];
 f.s.tick=()=>tick;
 f.s.onTick=(cb:()=>void)=>{listeners.add(cb);return ()=>listeners.delete(cb);};
 const pending=runDruidMeats(f.s,{travel:(x,z,signal)=>{
  legs.push({x,z,tick});
  return new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
 }}).then(()=>({error:undefined}),error=>({error})).finally(()=>{settled=true;});
 for(let turns=0;!settled&&turns<200;turns++){
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(listeners.size>1){tick++;for(const cb of [...listeners])cb();}
 }
 expect(settled).toBe(true);
 const {error}=await pending;
 expect(String(error)).toContain(`travel-stalled leg 2619,3332->2691,3341: no movement for ${STALL_TICKS} ticks after one retry`);
 expect(legs.map(l=>[l.x,l.z])).toEqual([[2691,3341],[2691,3341]]);
 expect(legs[1]!.tick-legs[0]!.tick).toBe(STALL_TICKS);
 expect(f.counts().attacks).toBe(0);
});
for(const fallback of [false,true])test(fallback?'bear search takes the nearest untried spawn through short hops and skips failed routes and unreachable bears within 12 ticks':'worker skips banked and carried meat, credits kills, and deposits only meat',async()=>{
 const f=fixture([2132]),st=f.s.sdk.getState();
 st.inventory=[{id:2134,count:1,name:'Raw rat meat'},{id:954,count:1,name:'Rope'}];
 const bank=[{id:2132,count:1,name:'Raw beef'}];let gen=1,xp=0;
 const attacked:number[]=[],routes:{x:number;z:number;tick:number}[]=[];
 let tick=0,settled=false;
 const listeners=new Set<()=>void>();
 f.s.tick=()=>tick;
 f.s.onTick=(cb:()=>void)=>{listeners.add(cb);return ()=>listeners.delete(cb);};
 f.s.bankObservation=()=>({generation:gen,items:bank});
 f.s.sdk.getSkillXp=()=>xp;
 f.s.bot.openBank=async()=>{st.bank.isOpen=true;gen++;return {success:true};};
 f.s.bot.closeBank=async()=>{st.bank.isOpen=false;return {success:true};};
 f.s.bot.depositItem=async(item:any)=>{
  const held=st.inventory.filter((i:any)=>i.id===item.id).reduce((n:number,i:any)=>n+i.count,0);
  st.inventory=st.inventory.filter((i:any)=>i.id!==item.id);bank.push({...item,count:held});gen++;return {success:true};
 };
 f.s.bot.attack=async(npc:any)=>{
  expect(npc.reachable).toBe(true);
  if(fallback&&npc.id===105)expect([st.player.worldX,st.player.worldZ]).toEqual([2484,3155]);
  attacked.push(npc.id);xp++;st.nearbyNpcs=[];
  const meat=MEATS.find(m=>m.npc===npc.id)!;
  st.groundItems=[{id:meat.item,count:1,x:npc.x,z:npc.z}];return {success:true};
 };
 f.s.bot.pickupItem=async(item:any)=>{
  st.inventory.push({...item,name:MEATS.find(m=>m.item===item.id)!.name});st.groundItems=[];return {success:true};
 };
 const pending=runDruidMeats(f.s,{travel:async(x,z)=>{
  routes.push({x,z,tick});
  // A nearer fenced spawn must never be attempted. No single goTo may cross more than HOP tiles.
  expect(x>=2631&&x<=2634&&z>=3273&&z<=3281).toBe(false);
  expect(Math.max(Math.abs(st.player.worldX-x),Math.abs(st.player.worldZ-z))).toBeLessThanOrEqual(HOP);
  if(fallback&&x===2691&&z===3341)throw Error(`route-failed ${x},${z}: walk to ${x},${z},0: no effect in 400 ticks`);
  if(fallback&&x===2691&&z===3273)throw Error(`route-failed ${x},${z}: no route to ${x},${z},0`);
  Object.assign(st.player,{worldX:x,worldZ:z});
  const m=BEAR_SPAWNS.some(([bx,bz])=>x===bx&&z===bz)?MEATS[2]:MEATS.find(m=>m.x===x&&m.z===z)??(x>=2690&&x<=2692&&z>=3272&&z<=3274?MEATS[3]:undefined);
  st.nearbyNpcs=m?[{id:m.npc,index:m.npc,x,z,inCombat:false,reachable:!(fallback&&x===2692&&z===3333)}]:[];
  if(m?.npc===105)st.nearbyNpcs.unshift({id:105,index:999,x,z,inCombat:false,reachable:false});
 }}).then(result=>{settled=true;return {result};},error=>{settled=true;return {error};});
 // Advance real tick waiters without a server or wall-clock waits.
 for(let turns=0;!settled&&turns<200;turns++){
  await new Promise<void>(resolve=>setImmediate(resolve));
  if(listeners.size>1){tick++;for(const cb of [...listeners])cb();}
 }
 expect(settled).toBe(true);
 const outcome=await pending;
 if('error' in outcome)throw outcome.error;
 const result=outcome.result;
 if(fallback){
  const bears=routes.filter(p=>BEAR_SPAWNS.some(([bx,bz])=>p.x===bx&&p.z===bz));
  expect(bears.map(p=>[p.x,p.z])).toEqual([[2691,3341],[2692,3333],[2484,3155]]);
  const after=routes.findIndex(p=>p.x===2692&&p.z===3333)+1;
  expect(routes.slice(after,after+3).map(p=>[p.x,p.z])).toEqual([[2654,3283],[2517,3184],[2484,3155]]);
  expect(routes[after]!.tick-routes[after-1]!.tick).toBe(12);
  expect(routes.some(p=>Math.max(Math.abs(p.x-2691),Math.abs(p.z-3273))===1)).toBe(true);
 }
 expect(attacked).toEqual([105,41]);
 expect(result.skipped).toEqual([2132,2134]);
 expect(result.bank).toEqual({2132:1,2134:1,2136:1,2138:1});
 expect(st.inventory).toEqual([{id:954,count:1,name:'Rope'}]);
});
