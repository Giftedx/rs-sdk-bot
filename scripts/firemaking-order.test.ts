import {expect,test} from 'bun:test';
import {firemakingOptions,firemakingPreflight,xpForLevel,levelForXp,logShortfall,lineTiles,nextFreeTile,rowStart,packWant,
 tinderboxPlan,tinderboxUnitMax,runFiremaking,BURN_ROWS,DRAYNOR_BANK,TINDERBOX} from './firemaking-order';

test('options need a target and validate every bound',()=>{
 expect(()=>firemakingOptions({})).toThrow('invalid TARGET_LEVEL');
 expect(firemakingOptions({TARGET_LEVEL:'30'})).toEqual({target:30,maxLogs:10000,cap:20000,log:'normal',toolBudget:50,cashReserve:0});
 expect(firemakingOptions({TARGET_LEVEL:'45',LOG:'Willow',MAX_LOGS:'27',CAP:'900',TOOL_BUDGET:'0',CASH_RESERVE:'100'}))
  .toEqual({target:45,maxLogs:27,cap:900,log:'willow',toolBudget:0,cashReserve:100});
 for(const bad of [{TARGET_LEVEL:'1'},{TARGET_LEVEL:'100'},{TARGET_LEVEL:'30',LOG:'yew'},{TARGET_LEVEL:'30',CAP:'0'},{TARGET_LEVEL:'30',MAX_LOGS:'1.5'},{TARGET_LEVEL:'30',TOOL_BUDGET:'-1'}])
  expect(()=>firemakingOptions(bad)).toThrow();
});
test('XP table matches the server curve (Player.ts levelExperience)',()=>{
 expect([2,10,30,48].map(xpForLevel)).toEqual([80,980,7345,28266]);
 expect(levelForXp(0)).toBe(1);expect(levelForXp(79)).toBe(1);expect(levelForXp(80)).toBe(2);
 expect(levelForXp(28265)).toBe(47);expect(levelForXp(28266)).toBe(48);expect(levelForXp(1e9)).toBe(99);
});
test('preflight refuses at target, off plane 0 and below the log level',()=>{
 const o=firemakingOptions({TARGET_LEVEL:'30'});
 expect(firemakingPreflight(o,{plane:0,baseLevel:30,level:30})).toBe('already at target');
 expect(firemakingPreflight(o,{plane:1,baseLevel:1,level:1})).toBe('off plane 0');
 expect(firemakingPreflight({...o,log:'oak'},{plane:0,baseLevel:14,level:14})).toBe('Oak logs need Firemaking 15');
 expect(firemakingPreflight({...o,log:'oak'},{plane:0,baseLevel:15,level:15})).toBeNull();
 expect(firemakingPreflight(o,{plane:0,baseLevel:0,level:0})).toBe('firemaking state unknown');
});
test('shortfall counts the logs still needed at the observed XP per log',()=>{
 expect(logShortfall(48,0,1000,0)).toBe(29);
 expect(logShortfall(48,27000,1000,0)).toBe(2);
 expect(logShortfall(48,27000,1000,5)).toBe(0);
 expect(logShortfall(30,0,0,0)).toBe(1);
});
test('the burn line runs west on two rows next to Draynor bank, outside the bank zone',()=>{
 const t=lineTiles();
 expect(t.length).toBe(27+29);
 expect(t[0]).toEqual({x:3098,z:3248,row:0});expect(t[26]).toEqual({x:3072,z:3248,row:0});
 expect(t[rowStart(1)]).toEqual({x:3105,z:3250,row:1});expect(rowStart(2)).toBe(0);
 for(let i=1;i<t.length;i++)if(t[i]!.row===t[i-1]!.row)expect(t[i]!.x).toBe(t[i-1]!.x-1);
 for(const r of BURN_ROWS)expect(Math.max(Math.abs(r.sx-DRAYNOR_BANK.x),Math.abs(r.z-DRAYNOR_BANK.z))).toBeLessThanOrEqual(13);
});
test('a fire or refused tile is skipped without a stall, and a full line reports -1',()=>{
 const t=lineTiles(),fire=new Set(['3098,3248','3097,3248']);
 expect(nextFreeTile(t,0,p=>fire.has(`${p.x},${p.z}`))).toBe(2);
 expect(nextFreeTile(t,t.length-1,()=>false)).toBe(t.length-1);
 expect(nextFreeTile(t,t.length-1,p=>p.z===3250)).toBe(0);
 expect(nextFreeTile(t,5,()=>true)).toBe(-1);
});
test('a pack holds at most 27 logs, bounded by free slots and MAX_LOGS',()=>{
 expect(packWant(0,0,1000)).toBe(27);
 expect(packWant(0,1,1000)).toBe(27);
 expect(packWant(0,2,1000)).toBe(26);
 expect(packWant(10,12,1000)).toBe(16);
 expect(packWant(10,11,1000)).toBe(17);
 expect(packWant(0,1,5)).toBe(5);
 expect(packWant(27,28,1000)).toBe(0);
});
test('one tinderbox is bought only when none is owned and the budget covers it',()=>{
 const shop=[{name:'Tinderbox',count:2,buyPrice:1},{name:'Hammer',count:5,buyPrice:1}];
 expect(tinderboxPlan(0,shop,[{name:'Coins',count:25}],50)).toEqual([{name:'Tinderbox',amount:1}]);
 expect(tinderboxPlan(1,shop,[],50)).toEqual([]);
 expect(tinderboxPlan(0,[{name:'Tinderbox',count:0,buyPrice:1}],[],50)).toEqual([]);
 expect(tinderboxPlan(0,shop,[],0)).toEqual([]);
 // shop.rs2 worst case for cost 1 at sell multiplier 1300.
 expect(tinderboxUnitMax()).toBe(7);
});

// A session double that throws on any game action not expected by the case.
function fakeSession(o:{x:number;z:number;level:number;fm:number;fmXp:number;bank?:{id:number;name:string;count:number}[];inventory?:any[]}){
 const calls:string[]=[];let generation=0,open=false;
 const deny=(n:string)=>()=>{calls.push(n);throw Error(`unexpected ${n}`);};
 const skills=[{name:'Firemaking',level:o.fm,baseLevel:o.fm,experience:o.fmXp},{name:'Hitpoints',level:10,baseLevel:10,experience:1154}];
 const state=()=>({player:{worldX:o.x,worldZ:o.z,level:o.level},inventory:o.inventory??[],equipment:[],skills,gameMessages:[],nearbyLocs:[],
  bank:{isOpen:open,items:open?o.bank??[]:[]}});
 const s:any={name:'fake',tick:()=>100,onTick:()=>()=>{},ended:new Promise(()=>{}),direct:deny('direct'),
  bankObservation:()=>open?{generation,at:100,items:o.bank??[]}:null,
  sdk:{getState:state,getInventory:()=>o.inventory??[],getSkill:(n:string)=>skills.find(k=>k.name===n),getSkillXp:(n:string)=>skills.find(k=>k.name===n)?.experience,
   sendUseItemOnItem:deny('light')},
  bot:{openBank:async()=>{calls.push('openBank');open=true;generation++;return{success:true,message:'ok'};},closeBank:deny('closeBank'),
   withdrawItem:deny('withdraw'),depositItem:deny('deposit'),openShop:deny('openShop'),closeShop:deny('closeShop'),buyFromShop:deny('buy')}};
 return{s,calls};
}
test('a rerun at the target refuses before any game action',async()=>{
 const {s,calls}=fakeSession({x:3090,z:3248,level:0,fm:48,fmXp:28266});
 const r=await runFiremaking(s,firemakingOptions({TARGET_LEVEL:'48'}));
 expect(r).toMatchObject({ok:false,stop:'refused',refused:'already at target',logsBurnt:0,bankTrips:0});
 expect(calls).toEqual([]);
});
test('off plane 0 refuses before any game action',async()=>{
 const {s,calls}=fakeSession({x:3092,z:3243,level:1,fm:1,fmXp:0});
 const r=await runFiremaking(s,firemakingOptions({TARGET_LEVEL:'30'}));
 expect(r).toMatchObject({ok:false,stop:'refused',refused:'off plane 0'});
 expect(calls).toEqual([]);
});
test('short log stock refuses after the bank observation with the exact shortfall',async()=>{
 const {s,calls}=fakeSession({x:3092,z:3243,level:0,fm:1,fmXp:0,bank:[{id:1521,name:'Oak logs',count:5},{id:TINDERBOX,name:'Tinderbox',count:1}]});
 const r=await runFiremaking(s,firemakingOptions({TARGET_LEVEL:'10'}));
 expect(r).toMatchObject({ok:false,stop:'refused',refused:'short log stock: need 1 Logs, own 0, shortfall 1',shortfall:1,ownedLogs:0,bankTrips:1});
 expect(calls).toEqual(['openBank']);
});
