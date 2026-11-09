import {expect,test,spyOn} from 'bun:test';
import * as coreBot from '../packages/core/src/bot';
import * as walking from '../packages/core/src/walk';
import * as ticks from '../packages/core/src/ticks';
import {BotActions} from '../vendor/rs-sdk/sdk/actions';
import {firemakingOptions,firemakingPreflight,xpForLevel,levelForXp,logShortfall,lineTiles,nextFreeTile,rowStart,packWant,
 tinderboxPlan,tinderboxUnitMax,runFiremaking,freeRouteAccount,routeDebits,entryBudget,BURN_ROWS,DRAYNOR_BANK,TINDERBOX,
 firemakingSite,CATHERBY_SITE,DRAYNOR_SITE,LOGS,progressiveFiremakingLog} from './firemaking-order';
import type {Leg} from '../packages/core/src/world';
import type {Travel} from '../packages/core/src/travel';

test('options need a target and validate every bound',()=>{
 expect(()=>firemakingOptions({})).toThrow('invalid TARGET_LEVEL');
 expect(firemakingOptions({TARGET_LEVEL:'30'})).toEqual({target:30,maxLogs:10000,cap:20000,log:'normal',toolBudget:50,cashReserve:0});
 expect(firemakingOptions({TARGET_LEVEL:'45',LOG:'Willow',MAX_LOGS:'27',CAP:'900',TOOL_BUDGET:'0',CASH_RESERVE:'100'}))
  .toEqual({target:45,maxLogs:27,cap:900,log:'willow',toolBudget:0,cashReserve:100});
 for(const bad of [{TARGET_LEVEL:'1'},{TARGET_LEVEL:'100'},{TARGET_LEVEL:'30',LOG:'redwood'},{TARGET_LEVEL:'30',CAP:'0'},{TARGET_LEVEL:'30',MAX_LOGS:'1.5'},{TARGET_LEVEL:'30',TOOL_BUDGET:'-1'}])
  expect(()=>firemakingOptions(bad)).toThrow();
});
test('all six native logs have exact level admission, while progressive selects highest level without a stock fallback',()=>{
 for(const [log,id,level]of [['maple',1517,45],['yew',1515,60],['magic',1513,75]]as const){
  expect(LOGS[log]).toMatchObject({id,level});const o=firemakingOptions({TARGET_LEVEL:'99',LOG:log});
  expect(firemakingPreflight(o,{plane:0,baseLevel:level,level})).toBeNull();
  expect(firemakingPreflight(o,{plane:0,baseLevel:level-1,level:level-1})).toContain('need Firemaking');
 }
 for(const[level,log]of [[1,'normal'],[14,'normal'],[15,'oak'],[30,'willow'],[44,'willow'],[45,'maple'],[60,'yew'],[75,'magic'],[99,'magic']]as const)expect(progressiveFiremakingLog(level)).toBe(log);
 expect(()=>progressiveFiremakingLog(0)).toThrow();
 expect(firemakingOptions({TARGET_LEVEL:'99',PROGRESSIVE:'1',BATCH:'1'})).toMatchObject({progressive:true,batch:1});
 expect(()=>firemakingOptions({TARGET_LEVEL:'99',PROGRESSIVE:'1',BATCH:'28'})).toThrow();
});
test('actual progressive burn loop reselects after the bounded paid batch; unavailable next tier never burns a lower log',async()=>{
 const run=async(maple:number,replace=false,bad:'none'|'stock'|'unknown'='none',burnOnly=false)=>{
  let tick=0,generation=0,open=false,pending=0;const burns:number[]=[],withdrawals:number[]=[];
  const player={worldX:2809,worldZ:3441,level:0,lifeId:1,respawnCount:0,isDead:false};
  const skill={name:'Firemaking',level:burnOnly?99:44,baseLevel:burnOnly?99:44,experience:xpForLevel(burnOnly?99:45)-1},health={name:'Hitpoints',level:99,baseLevel:99,experience:10000};
  const bank=[{id:1519,count:2,name:'Willow logs'},...maple?[{id:1517,count:maple,name:'Maple logs'}]:[]],inv:any[]=[{id:590,count:1,slot:0,name:'Tinderbox'}];
  const client={executeBotAction:async()=>{},membersAccount:true};
  const state=()=>({player,inventory:inv,equipment:[],skills:[skill,health],gameMessages:[],nearbyLocs:[],bank:{isOpen:open,items:bank},dialog:{isOpen:false},interface:{isOpen:false}});
  const s:any={name:'progressivefixture',client,tick:()=>tick,onTick:()=>()=>{},ended:new Promise(()=>{}),bankObservation:()=>({generation,items:bank}),
   sdk:{getState:state,getInventory:()=>inv,getSkill:(n:string)=>n==='Firemaking'?skill:health,getSkillXp:(n:string)=>n==='Firemaking'?skill.experience:health.experience,
    sendUseItemOnItem:async(_a:number,b:number)=>{pending=inv.find(i=>i.slot===b).id;burns.push(pending);return{success:true};}},
   bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},withdrawItem:async(row:any,n:number)=>{withdrawals.push(row.id);row.count-=n;for(let i=0;i<n;i++)inv.push({id:row.id,count:1,name:row.name,slot:inv.length});generation++;return{success:true};}}};
  const advance=()=>{tick++;if(pending&&bad!=='unknown'){const index=inv.findIndex(i=>i.id===pending);inv.splice(index,1);skill.experience+=pending===1519?90:135;skill.baseLevel=skill.level=burnOnly?99:45;pending=0;if(bad==='stock')inv.push({id:995,count:1,name:'Coins',slot:2});if(replace)client.executeBotAction=async()=>{};}};
  const spies=[spyOn(BotActions.prototype,'openBank').mockImplementation(s.bot.openBank),spyOn(BotActions.prototype,'closeBank').mockImplementation(s.bot.closeBank),spyOn(BotActions.prototype,'withdrawItem').mockImplementation(s.bot.withdrawItem),spyOn(ticks,'waitTicks').mockImplementation(async()=>{advance();}),spyOn(ticks,'waitUntil').mockImplementation(async(_s,test)=>{for(let i=0;i<4;i++){if(test(undefined))return true;advance();}return false;}),spyOn(walking,'sessionWalker').mockResolvedValue({}as any),spyOn(walking,'walkPath').mockImplementation(async(_d,points)=>{const p=points.at(-1)!;player.worldX=p.x;player.worldZ=p.z;return{ok:true}as any;})];
  try{return{result:await runFiremaking(s,firemakingOptions({TARGET_LEVEL:'99',MAX_LOGS:'2',PROGRESSIVE:burnOnly?'0':'1',LOG:burnOnly?'willow':'normal',BURN_ONLY:burnOnly?'1':'0',BATCH:'1',TOOL_BUDGET:'0'})),burns,withdrawals,bank};}finally{for(const spy of spies)spy.mockRestore();}
 };
 const at99=await run(0,false,'none',true);expect(at99.result.ok).toBe(true);expect(at99.burns).toEqual([1519,1519]);expect(at99.result.level).toBe(99);
 const good=await run(1);expect(good.result.ok).toBe(true);expect(good.burns).toEqual([1519,1517]);expect(good.withdrawals).toEqual([1519,1517]);expect(good.result.ticks).toBe(6);
 const missing=await run(0);expect(missing.result.ok).toBe(false);expect(missing.burns).toEqual([1519]);expect(missing.bank.find(i=>i.id===1519)!.count).toBe(1);
 const foreign=await run(1,true);expect(foreign.result.ok).toBe(false);expect(foreign.burns).toEqual([1519]);expect(foreign.withdrawals).toEqual([1519]);
 const drift=await run(1,false,'stock');expect(drift.result.ok).toBe(false);expect(drift.result.failure).toContain('whole-pack');expect(drift.burns).toEqual([1519]);
 const unknown=await run(1,false,'unknown');expect(unknown.result.ok).toBe(false);expect(unknown.result.failure).toContain('light effect unobserved');expect(unknown.burns).toEqual([1519]);
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
test('the failed western entry walks to nearby Catherby on the ground without a world route or fare',async()=>{
 expect(firemakingSite({x:2863,z:3428,level:0})).toBe(CATHERBY_SITE);
 expect(firemakingSite({...DRAYNOR_BANK,level:0})).toBe(DRAYNOR_SITE);
 const tiles=lineTiles(CATHERBY_SITE.rows);
 expect(tiles[0]).toEqual({x:2812,z:3433,row:0});expect(tiles[23]).toEqual({x:2789,z:3433,row:0});
 expect(tiles[rowStart(1,CATHERBY_SITE.rows)]).toEqual({x:2829,z:3436,row:1});
 expect(rowStart(2,CATHERBY_SITE.rows)).toBe(0);
 const entry={x:2863,z:3428,level:0,fm:1,fmXp:0},{s,calls}=fakeSession(entry);
 const spies=[spyOn(coreBot,'getWorld').mockImplementation(async()=>{throw Error('distant world route forbidden');}),
  spyOn(walking,'sessionWalker').mockResolvedValue({} as any),
  spyOn(walking,'walkPath').mockImplementation(async(_deps,points,opts)=>{
   expect(points).toEqual([{x:2809,z:3441,tol:2}]);expect(opts?.maxTicks).toBe(1920);
   calls.push('Catherby ground walk');entry.x=2809;entry.z=3441;
   return{ok:true,ticks:58} as any;
  })];
 try{
  const r=await runFiremaking(s,firemakingOptions({TARGET_LEVEL:'15',MAX_LOGS:'2',CAP:'2000',TOOL_BUDGET:'0'}));
  expect(r).toMatchObject({stop:'refused',refused:'short log stock: need 1 Logs, own 0, shortfall 1',bankTrips:1,logsBurnt:0});
  expect(calls).toEqual(['Catherby ground walk','openBank']);
 }finally{for(const spy of spies)spy.mockRestore();}
});
const boat={id:'npc:tobias',kind:'boat',name:'Captain Tobias to Port Sarim',from:{x:2954,z:3147,level:0},to:{x:3029,z:3217,level:0},coins:30,
 needs:[],runes:[],run:{how:'npc',npc:'Captain Tobias',op:1,options:[]},cost:40} as Travel;
const tele={id:'tele:falador',kind:'spell',name:'Falador Teleport',from:null,to:{x:2965,z:3378,level:0},coins:0,
 needs:[],runes:[{item:'law_rune',count:1}],run:{how:'spell',component:'x'},cost:5} as Travel;
test('the entry account masks coins and consumable travel items, and any fare or consumable leg is a debit',()=>{
 const a={skills:{Hitpoints:10},varps:{},items:['coins','law_rune','pot_of_flour'],coins:80,counts:{coins:80,law_rune:3,pot_of_flour:3}};
 const free=freeRouteAccount(a,[boat,tele]);
 expect(free).toMatchObject({coins:0,items:['coins','pot_of_flour'],counts:{coins:80,pot_of_flour:3}});
 const walkLeg={kind:'walk',to:{x:3092,z:3243,level:0}} as Leg;
 expect(routeDebits([walkLeg],free)).toEqual([]);
 expect(routeDebits([{kind:'travel',travel:boat,at:boat.from,to:boat.to},walkLeg],free)).toEqual([boat.name]);
 expect(routeDebits([{kind:'travel',travel:tele,at:null,to:tele.to}],free)).toEqual([tele.name]);
 // Shaftmaker's failed entry: CAP 2000, MAX_LOGS 2 leaves 1920 ticks for the route, not 400.
 expect(entryBudget(firemakingOptions({TARGET_LEVEL:'15',MAX_LOGS:'2',CAP:'2000'}),0)).toBe(1920);
});
test('the default distant entry walks a zero-fare route inside the CAP remainder, and refuses a fare or an over-budget route before travel',async()=>{
 const o=firemakingOptions({TARGET_LEVEL:'15',MAX_LOGS:'2',TOOL_BUDGET:'0',CAP:'2000'});
 const account={skills:{Hitpoints:10},varps:{},items:['coins'],coins:80,counts:{coins:80}};
 const free=[{kind:'walk',to:{x:2934,z:3450,level:0}},{kind:'walk',to:{...DRAYNOR_BANK,level:0}}] as Leg[];
 const paid=[{kind:'walk',to:{x:2954,z:3147,level:0}},{kind:'travel',travel:boat,at:boat.from,to:boat.to},{kind:'walk',to:{...DRAYNOR_BANK,level:0}}] as Leg[];
 const run=async(plan:{legs:Leg[];cost:number})=>{
  const entry={x:2950,z:3400,level:0,fm:1,fmXp:0},{s,calls}=fakeSession(entry),planned:any[]=[];
  const world={route:(from:any,to:any,acct:any)=>{planned.push({from,to,acct});return{ok:true,...plan};}};
  const spies=[spyOn(coreBot,'getWorld').mockResolvedValue(world as any),spyOn(coreBot,'accountOf').mockReturnValue(account as any),
   spyOn(walking,'goTo').mockImplementation(async()=>{throw Error('goTo replans with coins');}),
   spyOn(walking,'sessionWalker').mockImplementation(async()=>{throw Error('distant walkPath forbidden');}),
   spyOn(walking,'walkRoute').mockImplementation(async(actor,legs,opts)=>{
    expect(actor).toBe(s);expect(legs).toBe(plan.legs);expect(opts?.signal?.aborted).toBe(false);calls.push('route');
    entry.x=DRAYNOR_BANK.x;entry.z=DRAYNOR_BANK.z;return{ok:true,ticks:plan.cost};})];
  try{return{r:await runFiremaking(s,o),calls,planned};}finally{for(const spy of spies)spy.mockRestore();}
 };
 const ok=await run({legs:free,cost:900});
 expect(ok.planned).toEqual([{from:{x:2950,z:3400,level:0},to:{...DRAYNOR_BANK,level:0},acct:expect.objectContaining({coins:0})}]);
 expect(ok.calls).toEqual(['route','openBank']);
 expect(ok.r).toMatchObject({stop:'refused',refused:'short log stock: need 1 Logs, own 0, shortfall 1',bankTrips:1,logsBurnt:0});
 const fare=await run({legs:paid,cost:500});
 expect(fare.calls).toEqual([]);
 expect(fare.r).toMatchObject({stop:'refused',refused:`route to Draynor bank takes fares or consumables: ${boat.name}`,bankTrips:0});
 const slow=await run({legs:free,cost:1921});
 expect(slow.calls).toEqual([]);
 expect(slow.r).toMatchObject({stop:'refused',refused:'route to Draynor bank estimates 1921 ticks, entry budget 1920',bankTrips:0});
});
