import {expect,test,spyOn} from 'bun:test';
import * as sessionOwner from '../packages/core/src/bot';
import * as saves from './measure/fleet-player-save';
import * as walking from '../packages/core/src/walk';
import * as routePlan from '../packages/core/src/route-plan';
import {itemRecipe,itemEntry,itemSaveChecks,runQuestItemsOrder,gatherQuestItems,operateQuestHopper,probeQuestFlourBin,cookHettyMeat,openHettyFoodShop} from './quest-items-order';
export const fixture=(pack:{id:number;count:number}[]=[],bank:{id:number;count:number}[]=[],vars:Record<number,number>={})=>({version:9,position:{x:3092,z:3247,level:0},skills:[{index:3,level:10,rawExperience:11540,xp:1154}],vars,
 inventories:{93:pack.map((i,slot)=>({...i,slot})),95:bank.map((i,slot)=>({...i,slot}))}});
const kit=[{id:1925,count:1},{id:1931,count:1}],products=[{id:1944,count:1},{id:1927,count:1},{id:1933,count:1}];
function foodShopFixture(x=3010,reachable=false){
 const npc={id:557,index:42,name:'Wydin',x,z:3204,reachable,optionsWithIndex:[{text:'Trade',opIndex:3}]};
 const state={player:{worldX:3015,worldZ:3206,level:0},nearbyNpcs:[npc],shop:{isOpen:false}};
 const actions:number[][]=[];
 const s:any={sdk:{getState:()=>state,getDialog:()=>({isOpen:false}),sendInteractNpc:async(...args:number[])=>{
  actions.push(args);state.shop.isOpen=true;return {success:true};
 }},bot:{openShop:()=>{throw Error('automatic door walk forbidden');}}};
 const observe=async(pred:()=>boolean,label:string,ticks?:number)=>{expect(ticks).toBe(24);if(!pred())throw Error(`${label}: effect unobserved`);};
 return {s,npc,state,actions,observe};
}
test('Hetty refuses the closed employee-room boundary without dispatching Trade or walking',async()=>{
 const f=foodShopFixture();
 await expect(openHettyFoodShop(f.s,f.observe,()=>{})).rejects.toThrow('Hetty public Wydin');
 expect(f.actions).toEqual([]);expect(f.state.shop.isOpen).toBe(false);
});
test('Hetty waits for the observed reachable public keeper and sends its actual Trade option',async()=>{
 const f=foodShopFixture();
 await openHettyFoodShop(f.s,async(pred,label,ticks)=>{
  if(label==='Hetty public Wydin'){expect(pred()).toBe(false);f.npc.x=3014;f.npc.reachable=true;}
  await f.observe(pred,label,ticks);
 },()=>{});
 expect(f.actions).toEqual([[42,3]]);expect(f.state.shop.isOpen).toBe(true);
});
test('Hetty trades with the reachable public keeper at 3012,3206',async()=>{
 const f=foodShopFixture(3012,true);f.npc.z=3206;
 await openHettyFoodShop(f.s,f.observe,()=>{});
 expect(f.actions).toEqual([[42,3]]);expect(f.state.shop.isOpen).toBe(true);
});
test('Hetty never treats a dispatch acknowledgement as an open shop or acts after stop',async()=>{
 const f=foodShopFixture(3014,true);
 f.s.sdk.sendInteractNpc=async()=>({success:true});
 await expect(openHettyFoodShop(f.s,f.observe,()=>{})).rejects.toThrow('Hetty food shop open');
 await expect(openHettyFoodShop(f.s,f.observe,()=>{throw Error('stopped');})).rejects.toThrow('stopped');
 expect(f.actions).toEqual([]);
});
test('Hetty recipe reuses owned ingredients and needs no Cook containers',()=>{
 expect(itemRecipe('hetty').items).toEqual([1957,221,2146]);
 expect(itemEntry('hetty',fixture([], [{id:995,count:25}]))).toBeNull();
 expect(itemEntry('hetty',fixture([],[],{67:3}))).toBe('quest already complete');
});
test('meat conversion needs actual debit and credit; owned burnt meat does no work',async()=>{
 for(const mode of ['raw-cooked','raw-burnt','cooked','burnt','no-effect']){
  const state:any={inventory:[{id:mode==='cooked'?2142:mode==='burnt'?2146:2132,count:1}]};
  const actions:number[]=[];
  const s:any={sdk:{getState:()=>state,findNearbyLoc:()=>({id:2728,x:2970,z:3209})},bot:{useItemOnLoc:async(item:any)=>{
   actions.push(item.id);if(mode!=='no-effect')state.inventory=[{id:item.id===2142||mode==='raw-burnt'?2146:2142,count:1}];return {success:true};
  }}};
  const observe=async(pred:()=>boolean,label:string)=>{if(!pred())throw Error(label+': effect unobserved');};
  if(mode==='no-effect'){await expect(cookHettyMeat(s,observe)).rejects.toThrow('effect unobserved');continue;}
  const transitions=await cookHettyMeat(s,observe);
  expect(state.inventory).toEqual([{id:2146,count:1}]);
  expect(actions.length).toBe(mode==='burnt'?0:mode==='raw-cooked'?2:1);
  expect(transitions.length).toBe(actions.length);
 }
});
test('Hetty acquisition saved check includes costs, owned tail and retained stock',()=>{
 const b=fixture([{id:1277,count:1}],[{id:995,count:25},{id:300,count:1}]);
 const a=fixture([{id:1957,count:1},{id:221,count:1},{id:2146,count:1},{id:300,count:1}],[{id:1277,count:1},{id:995,count:21}]);
 expect(Object.values(itemSaveChecks('hetty',b,a)).every(Boolean)).toBe(true);
 expect(itemSaveChecks('hetty',b,fixture(a.inventories[93],[])).assets).toBe(false);
});
test('entry keeps missing containers, complete quests and duplicate orders explicit',()=>{
 expect(itemEntry('cook',fixture([],kit))).toBeNull();
 expect(itemEntry('cook',fixture([],kit.slice(1)))).toBe('missing container 1925');
 expect(itemEntry('cook',fixture(products,kit))).toBe('items already in pack');
 expect(itemEntry('cook',fixture([],kit,{29:2}))).toBe('quest already complete');
 expect(itemEntry('cook',fixture([{id:1944,count:2}],kit))).toBeNull();
 expect(()=>itemRecipe('constructor')).toThrow('unknown quest');
});
test('saved pack checks require conversion, exact pack and all unrelated assets',()=>{
 const before=fixture([{id:1351,count:1}],kit),after=fixture(products,[{id:1351,count:1}]);
 expect(Object.values(itemSaveChecks('cook',before,after)).every(Boolean)).toBe(true);
 expect(itemSaveChecks('cook',before,fixture(products,[...kit,{id:1351,count:1}])).containers).toBe(false);
 expect(itemSaveChecks('cook',before,fixture(products,[])).assets).toBe(false);
 expect(itemSaveChecks('cook',before,fixture([...products,{id:1944,count:1}],[{id:1351,count:1}])).pack).toBe(false);
 expect(itemSaveChecks('cook',before,fixture(products,[{id:1351,count:1}],{29:2})).quest).toBe(false);
 expect(itemSaveChecks('cook',before,fixture(products,[{id:1351,count:1},{id:995,count:1}])).assets).toBe(false);
});
test('save requirement and invalid budgets refuse without session access',async()=>{
 expect(await runQuestItemsOrder('nobody1','cook',{cap:10})).toMatchObject({ok:false,login:false});
 await expect(runQuestItemsOrder('nobody1','cook',{cap:NaN})).rejects.toThrow('CAP');
});
test('unknown entry waits to its deadline, propagates failure and leaves cleanup to caller',async()=>{
 let tick=0,off=false;
 const listeners=new Set<()=>void>();
 const s:any={client:{},sdk:{getState:()=>({inventory:[],player:{level:0}})},tick:()=>tick,
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>{off=true;listeners.delete(cb);};},ended:new Promise(()=>{})};
 const work=gatherQuestItems(s,'cook',fixture([],kit),3);
 for(let i=0;i<4;i++){tick++;for(const cb of [...listeners])cb();await Promise.resolve();}
 await expect(work).rejects.toThrow('entry state: effect unobserved');expect(off).toBe(true);
});

function millFixture(){
 let ready=false,controls=0;
 const listeners=new Set<()=>void>();
 const state:any={player:{level:2,worldX:3166,worldZ:3304},inventory:[{id:1947,count:1}],gameMessages:[{text:'old message',tick:10,observationId:1}]};
 const publish=(text:string,observationId:number)=>{state.gameMessages=[{text,tick:10,observationId}];for(const cb of listeners)cb();};
 const s:any={sdk:{getState:()=>state,findNearbyLoc:(name:RegExp)=>({id:name.test('Hopper')?1:2,x:3166,z:3304})},
  onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  bot:{useItemOnLoc:async()=>{state.inventory=[];return{success:true};},interactLoc:async()=>{
   controls++;expect(ready).toBe(true);
   publish('You operate the hopper. The grain slides down the chute.',3);
   // The message need not remain in the current snapshot until the action returns.
   state.gameMessages=[];return{success:true};
  }}};
 const observe=async(pred:()=>boolean,label:string)=>{
  if(label==='hopper fill complete'){
   expect(controls).toBe(0);expect(pred()).toBe(false);
   ready=true;publish('You put the grain in the hopper.',2);
  }
  if(!pred())throw Error(label+': effect unobserved');
 };
 return{s,state,publish,observe,listeners,setReady:()=>{ready=true;},controls:()=>controls};
}
test('mill waits past early grain debit and latches same-tick publication effects',async()=>{
 const m=millFixture();await operateQuestHopper(m.s,true,m.observe);
 expect(m.controls()).toBe(1);expect(m.listeners.size).toBe(0);
});
test('SDK success and grain debit alone cannot advance to hopper controls',async()=>{
 const m=millFixture();
 await expect(operateQuestHopper(m.s,true,async(pred,label)=>{if(!pred())throw Error(label+': effect unobserved');})).rejects.toThrow('hopper fill complete');
 expect(m.controls()).toBe(0);expect(m.listeners.size).toBe(0);
});
test('saved full hopper resumes without grain and rejects stale operation messages',async()=>{
 const m=millFixture();m.state.inventory=[];m.setReady();
 m.state.gameMessages=[{text:'You operate the hopper. The grain slides down the chute.',tick:10,observationId:1}];
 m.s.bot.interactLoc=async()=>({success:true});
 await expect(operateQuestHopper(m.s,false,m.observe)).rejects.toThrow('hopper operation');
 expect(m.listeners.size).toBe(0);
});
test('saved full hopper can operate without repeating the grain debit',async()=>{
 const m=millFixture();m.state.inventory=[];m.setReady();
 m.s.bot.useItemOnLoc=async()=>{throw Error('must not fill twice');};
 await operateQuestHopper(m.s,false,m.observe);
 expect(m.controls()).toBe(1);expect(m.listeners.size).toBe(0);
});
test('controls refusal remains failure with its target and reason retained',async()=>{
 const m=millFixture();m.state.inventory=[];
 m.s.bot.interactLoc=async()=>({success:false,reason:'cant_reach'});
 await expect(operateQuestHopper(m.s,false,m.observe)).rejects.toThrow('hopper operation');
 expect(m.listeners.size).toBe(0);
});

test('live filled-hopper recovery keeps the extra grain and operates the owned contents',async()=>{
 const m=millFixture();m.setReady();
 m.s.bot.useItemOnLoc=async()=>{m.publish('There is already grain in the hopper.',2);return {success:true};};
 await operateQuestHopper(m.s,true,async(pred,label)=>{if(!pred())throw Error(label);});
 expect(m.state.inventory).toEqual([{id:1947,count:1}]);expect(m.controls()).toBe(1);expect(m.listeners.size).toBe(0);
});

test('live bin probe requires a new empty message or an observed flour item',async()=>{
 const m=millFixture();m.state.inventory=[{id:1931,count:1}];
 m.state.gameMessages=[{text:'The flour bin is already empty.',tick:10,observationId:1}];
 m.s.sdk.sendInteractLoc=async()=>({success:true});
 const observe=async(pred:()=>boolean,label:string)=>{if(!pred())throw Error(label);};
 await expect(probeQuestFlourBin(m.s,observe)).rejects.toThrow('flour bin probe');
 m.s.sdk.sendInteractLoc=async()=>{m.publish('The flour bin is already empty.',2);m.state.gameMessages=[];return{success:true};};
 await probeQuestFlourBin(m.s,observe);expect(m.listeners.size).toBe(0);
 m.s.sdk.sendInteractLoc=async()=>{m.state.inventory=[{id:1933,count:1}];return{success:true};};
 await probeQuestFlourBin(m.s,observe);expect(m.listeners.size).toBe(0);
});
test('funded HP10 western entry takes the two bounded fares before its first bank',async()=>{
 const state:any={inventory:[{id:995,count:80},{id:1933,count:3}],player:{level:0,worldX:2863,worldZ:3428,hp:10}};
 const s:any={client:{ingame:true,ifType:()=>({colour:0xf80000})},sdk:{getState:()=>state},tick:()=>0,
  onTick:()=>()=>{},ended:new Promise(()=>{}),bot:{openBank:async()=>({success:false})}};
 const account=spyOn(sessionOwner,'accountOf').mockReturnValue({skills:{hitpoints:10},coins:80,varps:{},items:[],worn:[],unlocks:[],questStages:{}} as any);
 const boat=(id:string,to:any)=>({kind:'travel',to,travel:{id,coins:30,kind:'boat',run:{how:'npc',deck:true}}});
 const legs:any[]=[{kind:'walk',to:{x:2679,z:3275,level:0}},
  boat('npc:captain_barnaby:brimhaven@2679,3275',{x:2772,z:3230,level:0}),
  {kind:'walk',to:{x:2953,z:3147,level:0}},
  boat('npc:customs_officer:port-sarim@2953,3147',{x:3029,z:3216,level:0}),
  {kind:'walk',to:{x:3092,z:3243,level:0}}];
 const plan=spyOn(routePlan,'planTripOffThread').mockImplementation(async()=>({cost:760,legs}) as any);
 const route=spyOn(walking,'walkRoute').mockImplementation(async(_s,ls,opts)=>{
  const l:any=ls[0];if(l.kind==='travel'){expect(opts?.maxRetriesPerLeg).toBe(1);state.inventory[0].count-=30;}
  state.player={...state.player,worldX:l.to.x,worldZ:l.to.z};return {ok:true,ticks:1} as any;
 });
 const path=spyOn(walking,'walkPath');
 try{
  await expect(gatherQuestItems(s,'hetty',null,6000)).rejects.toThrow('bank refused');
  expect(plan.mock.calls[0]!.slice(0,2)).toEqual([{x:2863,z:3428,level:0},{x:3092,z:3243,level:0}]);
  expect(plan.mock.calls[0]![2]).toMatchObject({coins:60,skills:{hitpoints:10}});
  expect(state.inventory).toEqual([{id:995,count:20},{id:1933,count:3}]);
  expect(route).toHaveBeenCalledTimes(5);expect(path).not.toHaveBeenCalled();
  state.player={level:0,worldX:2863,worldZ:3428,hp:10};state.inventory[0].count=80;route.mockClear();
  legs.splice(0,legs.length,{kind:'walk',to:{x:3030,z:3217,level:1}});
  await expect(gatherQuestItems(s,'hetty',null,6000)).rejects.toThrow('unsupported route');
  plan.mockImplementation(async()=>null);
  await expect(gatherQuestItems(s,'hetty',null,6000)).rejects.toThrow('no funded HP-safe route');
  expect(route).not.toHaveBeenCalled();expect(path).not.toHaveBeenCalled();
 }finally{account.mockRestore();plan.mockRestore();route.mockRestore();path.mockRestore();}
});

test('failed gather stays failed even when cleanup and the saved pack would pass',async()=>{
 const s:any={client:{},sdk:{getState:()=>({inventory:[],player:{level:0}})},tick:()=>0,
  onTick:()=>()=>{},ended:Promise.resolve({reason:'logged-out'})};
 const open=spyOn(sessionOwner,'openBot').mockResolvedValue(s);
 const read=spyOn(saves,'readPracticeSave').mockReturnValue(fixture([],kit));
 const saved=spyOn(saves,'waitPracticeSave').mockResolvedValue({matched:true,save:fixture(products,[]),first:undefined,reads:1,lastError:''});
 const settle=spyOn(sessionOwner,'settle').mockImplementation(async(_sessions,ok,_detail,options)=>{
  expect(ok).toBe(false);options?.log?.('LOGOUT logged-out');return true;
 });
 try{
  const result=await runQuestItemsOrder('nobody1','cook',{save:import.meta.path,cap:3});
  expect(result).toMatchObject({ok:false,logout:true});
  expect(settle).toHaveBeenCalledTimes(1);expect(saved).not.toHaveBeenCalled();
 }finally{open.mockRestore();read.mockRestore();saved.mockRestore();settle.mockRestore();}
});
