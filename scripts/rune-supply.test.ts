import {expect,test,spyOn} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runeSupplyTarget,runeSupplyAssets,runeSupplyPreserved,leaveRuneStarter,runRuneSupply} from './rune-supply';
import * as walking from '../packages/core/src/walk';
import * as training from './train-chickens';
import * as cooking from './fishcook';
import * as essence from './gather-essence';
import * as questRunner from './generated/quest-runemysteries';
import * as altarActions from './generated/rcair';
import {airCraftEffects,craftAirRunes,insideAirAltar,exitAirAltar} from './generated/rcair';

test('air exit identity and all destinations match the pinned portal and air row',()=>{
 const pinned=(path:string)=>readFileSync(new URL('../vendor/rs-sdk/server/'+path,import.meta.url),'utf8');
 expect(pinned('content/pack/loc.pack')).toMatch(/^2465=airtemple_exit_portal\r?$/m);
 expect(pinned('content/maps/m44_75.jm2')).toMatch(/^0 25 28: 2465 10\r?$/m);
 const air=pinned('content/scripts/skill_runecraft/configs/runecraft.dbrow').split('[runecraft_air]')[1]!.split('[runecraft_mind]')[0]!;
 const exits=air.split(/\r?\n/).filter(l=>l.startsWith('data=exit_coord,'));expect(exits.length).toBe(1);
 for(const line of exits){const [coord,...offsets]=line.slice(16).split(',');expect(offsets).toEqual(['0','0','0']);
  const [level,rx,rz,x,z]=coord!.split('_').map(Number);
  expect(altarActions.outsideAirAltar({level:level!,worldX:rx!*64+x!,worldZ:rz!*64+z!})).toBe(true);
 }
});
async function airExitModel(mode:string,run:(s:any,calls:string[],logs:string[])=>Promise<void>){
 let tick=0,dispatch=-1;
 const callbacks=new Set<()=>void>(),calls:string[]=[],logs:string[]=[];
 const portal={id:2465,x:2841,z:4828,name:'Portal',optionsWithIndex:[{text:'Use',opIndex:1}]};
 const state:any={player:{worldX:2843,worldZ:4832,level:0,animId:791,spotanimId:186},gameMessages:[],opFeedback:{opRejectedCount:0}};
 let essence=1,air=26,xp=3250;
 Object.defineProperty(state,'inventory',{get:()=>[{id:1436,name:'Rune essence',count:essence},{id:556,name:'Air rune',count:air}]});
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  sdk:{getState:()=>state,findNearbyLoc:(pattern:RegExp)=>pattern.test('Altar')?{id:2478,name:'Altar'}:portal,
   getInventory:()=>[{id:1436,name:'Rune essence',count:essence},{id:556,name:'Air rune',count:air}],
   getSkill:()=>({level:20}),getSkillXp:()=>xp,
   findPath:(x:number,z:number)=>({success:true,reachedDestination:mode!=='partial',waypoints:[{x,z,level:0}]}),
   sendInteractLoc:async(x:number,z:number,id:number,op:number)=>{calls.push('use');expect([x,z,id,op]).toEqual([2841,4828,2465,1]);
    expect(state.player.worldX).toBe(2841);expect(state.player.worldZ).toBe(4829);
    dispatch=tick;return{success:mode!=='refused',message:'dispatch'};}},
  bot:{dismissBlockingUI:async()=>{},walkTo:async(x:number,z:number,tolerance:number)=>{calls.push('walk');expect(tolerance).toBe(0);
   if(mode!=='walk-unobserved')Object.assign(state.player,{worldX:x,worldZ:z});return{success:true};},
   interactLoc:async(loc:any)=>{if(loc.name==='Altar'){calls.push('craft');essence=0;air=28;xp=3375;}
    else{calls.push('old-interact');dispatch=tick;}return{success:true};}}};
 const timer=setInterval(()=>{tick++;
  if(dispatch>=0&&tick===dispatch+2){
   if(mode==='arrived')Object.assign(state.player,{worldX:2983,worldZ:3288});
   if(mode==='delayed-refusal')state.gameMessages.push({text:"I can't reach that!",tick,observationId:tick+100});
   if(mode==='rejected-op')state.opFeedback.opRejectedCount++;
   if(mode==='wrong-arrival')Object.assign(state.player,{worldX:2984,worldZ:3288});
  }
  for(const cb of [...callbacks])cb();
 },1);
 const old=console.log;console.log=(...args:unknown[])=>logs.push(args.join(' '));
 try{await run(s,calls,logs);}finally{console.log=old;clearInterval(timer);expect(callbacks.size).toBe(0);}
}
test('craft animation does not prove portal use; exact supported approach reaches outside',async()=>{
 await airExitModel('arrived',async(s,calls,logs)=>{await exitAirAltar(s);
  expect(calls).toEqual(['walk','use']);expect(logs.some(l=>l.includes('"phase":"outside"'))).toBe(true);
  expect(logs.some(l=>l.includes('"animId":791'))).toBe(true);
 });
});
test('real craft helper followed by stale crafting animation still requires observed portal arrival',async()=>{
 await airExitModel('arrived',async(s,calls)=>{
  expect(await craftAirRunes(s)).toMatchObject({ok:true,consumed:1,runes:2,xp:125});
  expect(s.sdk.getState().player.animId).toBe(791);
  await exitAirAltar(s);expect(calls).toEqual(['craft','walk','use']);
 });
});
for(const [mode,error] of [['delayed-refusal','air portal rejected'],['refused','air portal action refused'],
 ['rejected-op','air portal rejected'],['unresolved','air portal exit unobserved'],['wrong-arrival','air portal exit unobserved'],
 ['partial','air portal approach unavailable'],['walk-unobserved','air portal approach unobserved']])
 test('portal failure is bounded without another unchanged dispatch: '+mode,async()=>{
  await airExitModel(mode!,async(s,calls)=>{await expect(exitAirAltar(s)).rejects.toThrow(error!);
   expect(calls.filter(c=>c==='use').length).toBe(mode==='partial'||mode==='walk-unobserved'?0:1);
  });
 });
test('cancelled air exit sends no action',async()=>{
 await airExitModel('unresolved',async(s,calls)=>{await expect(exitAirAltar(s,()=>true)).rejects.toThrow('air exit stopped');expect(calls).toEqual([]);});
});
test('cancellation during observed portal wait cleans its observers',async()=>{
 await airExitModel('unresolved',async(s,calls)=>{await expect(exitAirAltar(s,()=>s.tick()>=2)).rejects.toThrow('air exit stopped');expect(calls).toEqual(['walk','use']);});
});

test('finite targets include20 and50; invalid inputs fail before login',()=>{
 expect(runeSupplyTarget()).toBe(20);expect(runeSupplyTarget(50)).toBe(50);
 for(const n of [NaN,Infinity,0,1,20.1,100])expect(()=>runeSupplyTarget(n)).toThrow('2..99');
});
test('starter assets remain counted across pack, equipment and bank',()=>{
 const before=runeSupplyAssets([{id:1265,count:1},{id:556,count:25},{id:995,count:25},{id:315,count:1}]);
 expect(runeSupplyPreserved(before,{1265:1,556:52,995:25})).toBe(true);
 for(const changed of [{1265:0,556:52,995:25},{1265:1,556:24,995:25},{1265:1,556:52,995:24}])expect(runeSupplyPreserved(before,changed)).toBe(false);
});
test('starting runes, partial essence depletion and XP alone cannot prove crafting',()=>{
 expect(airCraftEffects(27,0,25,52,0,135)).toBe(true);
 for(const args of [[0,0,25,25,0,0],[27,1,25,52,0,135],[27,0,25,25,0,135],[27,0,25,52,10,10]])
  expect(airCraftEffects(...args as [number,number,number,number,number,number])).toBe(false);
});
test('air location excludes the essence mine and ordinary surface',()=>{
 expect(insideAirAltar({worldX:2841,worldZ:4830,level:0})).toBe(true);
 for(const p of [{worldX:2891,worldZ:4847,level:0},{worldX:2985,worldZ:3292,level:0},{worldX:2841,worldZ:4830,level:1}])expect(insideAirAltar(p)).toBe(false);
});
test('craft refuses wrong location even with essence and old runes',async()=>{
 const s:any={sdk:{getState:()=>({inventory:[{id:1436}],player:{worldX:2985,worldZ:3292,level:0}}),getInventory:()=>[{id:1436}],getSkill:()=>({level:1})}};
 await expect(craftAirRunes(s)).rejects.toThrow('inside-altar');
});
test('starter surface entry performs no registration shortcuts or floor edits',async()=>{
 const s:any={sdk:{getState:()=>({player:{worldX:3222,worldZ:3218,level:0}})}};
 await leaveRuneStarter(s,()=>false);
 await expect(leaveRuneStarter(s,()=>true)).rejects.toThrow('stopped');
});

// Source-model regressions, not a claim about the missing historical dialogue.
// Client.ts publishes BUTTON_CONTINUE as an option (buttonType6), even on narration.
const starterGrant=[1351,590,303,315,1925,1931,2309,1265,1205,1277,1171,841].map(id=>({id,count:1}))
 .concat([{id:882,count:25},{id:556,count:25},{id:558,count:15},{id:555,count:6},{id:557,count:4},{id:559,count:2}]);
async function starterModel(mode:string,run:(s:any,actions:string[],tick:()=>number,logs:string[])=>Promise<void>){
 let tick=0,nextPage=0,landing=0,grant=0;
 const actions:string[]=[],logs:string[]=[],listeners=new Set<()=>void>();
 const closed=()=>({isOpen:false,isWaiting:false,options:[] as any[],pageId:'closed'});
 const state:any={inGame:true,modalOpen:false,modalInterface:-1,player:{worldX:3094,worldZ:3106,level:0},dialog:closed(),inventory:[],nearbyNpcs:[{index:1,name:'RuneScape Guide',optionsWithIndex:[{text:'Talk-to',opIndex:1}]}]};
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  // The quest list is only initialized after tutorial_complete in this flow.
  client:{ingame:true,ifType:()=>({colour:state.inventory.length?0xf80000:0xff0000})},
  sdk:{getState:()=>state,getDialog:()=>state.dialog,getInventory:()=>state.inventory,
   sendAcceptCharacterDesign:async()=>{actions.push('design');expect(state.modalOpen).toBe(true);state.modalOpen=false;state.modalInterface=-1;return{success:true};},
   sendInteractNpc:async()=>{actions.push('talk');state.dialog={isOpen:true,isWaiting:mode==='waiting',pageId:'narration',options:mode==='waiting'?[]:[{index:1,text:'Click here to continue',buttonType:6,componentId:9}]};return{success:true};},
   sendClickDialog:async(index:number)=>{actions.push('continue'+index);expect(state.dialog.isWaiting).toBe(false);state.dialog.isWaiting=true;nextPage=tick+2;return{success:true};},
   clickDialogByText:async(pattern:RegExp)=>{actions.push('yes');expect(state.dialog.options.some((o:any)=>pattern.test(o.text))).toBe(true);landing=tick+2;grant=tick+(mode==='delayed-grant'?5:2);state.dialog={...closed(),isOpen:true,isWaiting:true};return{success:true};}},
  bot:{talkTo:async()=>{throw Error('use bounded observed guide dispatch');}}};
 const timer=setInterval(()=>{
  tick++;
  if(tick===3&&mode!=='designed'){state.modalOpen=true;state.modalInterface=3559;}
  if(nextPage&&tick===nextPage)state.dialog={isOpen:true,isWaiting:false,pageId:'choice',options:mode==='unsupported'?[{index:1,text:'Tell me about this place.',buttonType:1}]:[{index:1,text:'Yes please.',buttonType:1},{index:2,text:'No, thank you.',buttonType:1}]};
  if(landing&&tick===landing){state.player={worldX:3222,worldZ:3222,level:0};state.dialog=closed();}
  if(grant&&tick===grant&&mode!=='missing-grant')state.inventory=starterGrant;
  for(const cb of [...listeners])cb();
 },1);
 const old=console.log;console.log=(...args:unknown[])=>{logs.push(args.join(' '));};
 try{await run(s,actions,()=>tick,logs);}finally{console.log=old;clearInterval(timer);}
}
for(const mode of ['normal','delayed-grant'])test(`starter observes delayed design, continuation, waiting, choice and real grant: ${mode}`,async()=>{
 await starterModel(mode,async(s,actions,tick,logs)=>{
  await leaveRuneStarter(s,()=>false);
  expect(actions).toEqual(['design','talk','continue0','yes']);
  expect(tick()).toBeGreaterThanOrEqual(7);
  expect(logs.some(l=>l.startsWith('RUNE_SUPPLY_STARTER ')&&l.includes('"isWaiting":true'))).toBe(true);
  expect(logs.some(l=>l.includes('Yes please.'))).toBe(true);
 });
});
test('starter refuses unsupported choices with their actual text retained',async()=>{
 await starterModel('unsupported',async(s,actions,_tick,logs)=>{
  await expect(leaveRuneStarter(s,()=>false)).rejects.toThrow('unsupported tutorial choice');
  expect(actions).toEqual(['design','talk','continue0']);
  expect(logs.some(l=>l.includes('Tell me about this place.'))).toBe(true);
 });
});
test('waiting page has a hard tick deadline without clicks or claiming skip is unavailable',async()=>{
 await starterModel('waiting',async(s,actions,tick)=>{
  await expect(leaveRuneStarter(s,()=>false)).rejects.toThrow('starter entry deadline');
  expect(tick()).toBeLessThanOrEqual(100);expect(actions).toEqual(['design','talk']);
 });
});
test('cancellation during delayed modal publication sends no character or dialogue action',async()=>{
 await starterModel('normal',async(s,actions,tick)=>{
  await expect(leaveRuneStarter(s,()=>tick()>=2)).rejects.toThrow('stopped during starter exit');expect(actions).toEqual([]);
 });
});
test('mainland arrival without the actual starter grant cannot admit training',async()=>{
 await starterModel('missing-grant',async(s,_actions,tick)=>{
  await expect(leaveRuneStarter(s,()=>false)).rejects.toThrow('starter entry deadline');expect(tick()).toBeLessThanOrEqual(100);
 });
});
test('a registered starter whose design is already accepted can resume the guide',async()=>{
 await starterModel('designed',async(s,actions,tick)=>{
  await leaveRuneStarter(s,()=>false);expect(actions).toEqual(['talk','continue0','yes']);expect(tick()).toBeGreaterThanOrEqual(15);
 });
});
test('cancellation while waiting for the guide sends no further action',async()=>{
 await starterModel('waiting',async(s,actions,tick)=>{
  await expect(leaveRuneStarter(s,()=>tick()>=10)).rejects.toThrow('stopped during starter exit');
  expect(actions).toEqual(['design','talk']);
 });
});
test('a stale guarded choice is retained and refused without an index fallback',async()=>{
 await starterModel('normal',async(s,actions,_tick,logs)=>{
  s.sdk.clickDialogByText=async()=>({success:false,reason:'stale_dialog',message:'page changed'});
  await expect(leaveRuneStarter(s,()=>false)).rejects.toThrow('stale_dialog');
  expect(actions).toEqual(['design','talk','continue0']);expect(logs.some(l=>l.includes('Yes please.'))).toBe(true);
 });
});

// Replay the saved bootstrap entry through the worker's actual bank/kit code.
// Travel and cooking are outside this regression. No client or services start.
async function preparationModel(mode:string){
 let tick=0,generation=0,cookedRaw=0,cookingXp=0,due=0,dispatches=0;
 const cookingOrder:string[]=[];
 const realCooking=cooking.cookStarterChickens,settlementMode=['late-cooked','late-burnt','unresolved'].includes(mode);
 const callbacks=new Set<()=>void>(),withdrawals:{id:number;amount:number}[]=[];
 const item=(id:number,count=1)=>({id,count,name:String(id),slot:0,optionsWithIndex:[]});
 const inventory=[...Array.from({length:10},()=>item(2138)),item(315),item(2309),item(1265)];
 const equipment=[item(1277),...(!['mixed','missing','carried'].includes(mode)?[item(1171)]:[])];
 if(mode==='consumable-equipped')equipment.push(item(2138,10),item(315));
 if(mode==='carried'){equipment.length=0;inventory.push(item(1277),item(1171));}
 const bank=mode==='missing'?[]:[...(mode==='equipped'||mode==='carried'||mode==='consumable-equipped'?[]:[item(1171)])];
 const state:any={tick,player:{worldX:3092,worldZ:3243,level:0,combatLevel:15,hp:17,maxHp:17,lifeId:1,respawnCount:0},inventory,bank:{isOpen:false,items:bank},skills:[{name:'Cooking',experience:0,level:1}],
  nearbyLocs:[{id:2724,name:'Fireplace',x:3214,z:3249}],gameMessages:[]};
 const count=(items:typeof inventory,id:number)=>items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const s:any={name:'preparation-model',tick:()=>tick,ended:new Promise(()=>{}),client:{ingame:true,ifType:()=>({colour:0xf80000})},
  onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  bankObservation:()=>({generation,at:tick,items:bank}),
  sdk:{getState:()=>state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkillXp:(name:string)=>name==='Cooking'?cookingXp:0,getDialog:()=>({isOpen:false}),
   sendUseItemOnLoc:async()=>{dispatches++;cookingOrder.push('dispatch');due=tick+2;return{success:true};},
   getSkill:(name:string)=>({level:name==='Hitpoints'?17:1,baseLevel:name==='Hitpoints'?17:1})},
  bot:{useItemOnLoc:async()=>{await s.sdk.sendUseItemOnLoc();return{success:true};},
   openBank:async()=>{state.bank.isOpen=true;generation++;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;return{success:true};},
   depositItem:async(i:{id:number})=>{const n=count(inventory,i.id),old=bank.find(b=>b.id===i.id);if(old)old.count+=n;else bank.push(item(i.id,n));
    for(let j=inventory.length-1;j>=0;j--)if(inventory[j]!.id===i.id)inventory.splice(j,1);generation++;return{success:true};},
   withdrawItem:async(i:{id:number},amount:number)=>{withdrawals.push({id:i.id,amount});const b=bank.find(b=>b.id===i.id)!;
    if(mode!=='no-debit')b.count-=amount;inventory.push(item(i.id,mode==='short-credit'?amount-1:amount));
    if(mode!=='stale-generation')generation++;return{success:true};}},
 };
 const spies=[spyOn(walking,'sessionWalker').mockResolvedValue({} as any),spyOn(walking,'walkPath').mockResolvedValue({ok:true} as any),
  spyOn(training,'trainChickens').mockImplementation(async()=>{throw Error('unneeded training acquisition');}),
  spyOn(cooking,'cookStarterChickens').mockImplementation(async(session,stop,options)=>{
   cookedRaw=count(inventory,2138);
   if(settlementMode){tick=999;return realCooking(session,stop,options);}
   if(['missing-food-output','burnt-food-output'].includes(mode))inventory.find(i=>i.id===2138)!.count--;
   if(mode==='burnt-food-output')inventory.push(item(2144));
   throw Error('preparation reached cooking');
  })];
 const timer=setInterval(()=>{state.tick=++tick;
  if(settlementMode&&tick===1000)cookingOrder.push('cap');
  if(tick===due&&mode!=='unresolved'){
   cookingOrder.push('conversion');
   inventory.find(i=>i.id===2138)!.count--;inventory.push(item(mode==='late-burnt'?2144:2140));
   if(mode==='late-cooked'){cookingXp=750;state.skills=[{name:'Cooking',experience:750,level:8}];}
  }
  for(const cb of [...callbacks])cb();},1);
 try{
  const result=structuredClone(await runRuneSupply(s,20,settlementMode?{cap:1000}:{}));
  cookingOrder.push('snapshot');
  // Owner logout happens after runRuneSupply returns. Capture persisted server stock independently.
  if(settlementMode)await new Promise<void>(resolve=>{const off=s.onTick(()=>{off();resolve();});});
  cookingOrder.push('logout');
  const saved=structuredClone({inventory,equipment,cookingXp});
  return{result,withdrawals,cookedRaw,inventory,bank,equipment,saved,dispatches,cookingOrder};
 }
 finally{clearInterval(timer);for(const spy of spies)spy.mockRestore();}
}
for(const mode of ['late-cooked','late-burnt','unresolved'])test(`worker accounts for the accepted cooking use before its final snapshot and owner logout: ${mode}`,async()=>{
 const r=await preparationModel(mode),burnt=mode==='late-burnt',unresolved=mode==='unresolved';
 expect(r.result.ok).toBe(false);expect(r.result.stopReason).toBe('tick-cap');expect(r.dispatches).toBe(1);
 expect(r.result.ticks).toBe(unresolved?1007:1001);
 expect(r.result.stages.food).toMatchObject({ok:false,raw:10,consumed:unresolved?0:1,cooked:mode==='late-cooked'?1:0,
  burnt:burnt?1:0,xp:mode==='late-cooked'?750:0,remainingRaw:unresolved?10:9});
 expect(r.result.final.inventory).toEqual(r.saved.inventory);expect(r.result.final.equipment).toEqual(r.saved.equipment);
 expect(r.result.final.skills?.find((s:any)=>s.name==='Cooking')?.experience).toBe(r.saved.cookingXp);
 if(unresolved){expect(r.result.stages.food).toMatchObject({settlement:'unresolved'});expect(r.result.failure).toContain('settlement unresolved');}
 else{expect(r.result.failure).toContain('stopped after settled conversion');expect(r.cookingOrder).toEqual(['dispatch','cap','conversion','snapshot','logout']);}
});
for(const mode of ['equipped','mixed','carried','consumable-equipped'])test(`starter preparation reuses owned kit and ten raw chickens: ${mode}`,async()=>{
 const r=await preparationModel(mode);
 expect(r.result.stage).toBe('bootstrap-food');expect(r.result.failure).toContain('preparation reached cooking');
 expect(r.result.stages.training).toEqual({ok:true,resumed:true});expect(r.cookedRaw).toBe(10);
 expect(r.withdrawals.filter(i=>[1277,1171].includes(i.id))).toEqual(mode==='mixed'?[{id:1171,amount:1}]:[]);
 expect(r.withdrawals.filter(i=>[2138,315,2309].includes(i.id))).toEqual([{id:2138,amount:10},{id:315,amount:1},{id:2309,amount:1}]);
 for(const id of [2138,315,2309])expect(r.bank.find(i=>i.id===id)?.count).toBe(0);
});
test('starter preparation refuses a truly absent shield with its exact acquisition need',async()=>{
 const r=await preparationModel('missing');expect(r.result.ok).toBe(false);
 expect(r.result.failure).toBe('Error: next acquisition: owned item1171 needs1, bank has0');
 expect(r.withdrawals).toEqual([]);expect(r.cookedRaw).toBe(0);
});
for(const mode of ['no-debit','short-credit','stale-generation'])test(`starter withdrawal refuses unmatched accounting: ${mode}`,async()=>{
 const r=await preparationModel(mode);expect(r.result.ok).toBe(false);
 expect(r.result.failure).toBe('Error: withdraw debit/credit unobserved item2138');expect(r.cookedRaw).toBe(0);
});
for(const mode of ['missing-food-output','burnt-food-output'])test(`bootstrap failure retains observed output without inventing burns: ${mode}`,async()=>{
 const r=await preparationModel(mode);expect(r.result.ok).toBe(false);expect(r.result.stage).toBe('bootstrap-food');
 expect(r.result.stages.food).toMatchObject({ok:false,raw:10,consumed:1,cooked:0,burnt:mode==='burnt-food-output'?1:0,xp:0,remainingRaw:9,
  acquisition:{itemId:2138,minimum:1}});
});

for(const mode of ['retained','mined','cancel-outbound','recovery'])test(`essence reaches the existing crafting consumer once: ${mode}`,async()=>{
 let generation=1,rcXp=mode==='recovery'?3250:0,stopped=false,walks=0;
 const item=(id:number,count=1)=>({id,count,slot:0,name:id===1436?'Rune essence':id===556?'Air rune':String(id)});
 const inventory=mode==='recovery'?[item(556,26),item(1438),item(315)]:mode==='mined'?[]:[item(1436,26),item(1438),item(315)];
 const bank=mode==='recovery'?[item(556,25)]:mode==='mined'?[item(1438),item(315),item(556,25)]:[item(1436),item(556,25)];
 const equipment=[item(1265),item(1171)],callbacks=new Set<()=>void>();
 const state:any={inventory,player:{worldX:mode==='recovery'?2842:3133,worldZ:mode==='recovery'?4831:3313,level:0,hp:17,maxHp:17,combatLevel:15,lifeId:1,respawnCount:0},bank:{isOpen:false,items:bank}};
 const s:any={name:'retained-model',tick:()=>0,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  client:{ingame:true,ifType:()=>({colour:0x00f800})},bankObservation:()=>({generation,items:bank}),
  sdk:{getState:()=>state,getInventory:()=>inventory,getEquipment:()=>equipment,getSkillXp:(name:string)=>name==='Runecraft'?rcXp:0,
   getSkill:(name:string)=>({level:name==='Hitpoints'?17:name==='Runecraft'&&mode==='recovery'?(rcXp===3250?20:21):name==='Runecraft'&&rcXp>0?18:1,baseLevel:name==='Hitpoints'?17:name==='Runecraft'&&mode==='recovery'?(rcXp===3250?20:21):name==='Runecraft'&&rcXp>0?18:1})},
  bot:{openBank:async()=>{state.bank.isOpen=true;generation++;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;return{success:true};},
   depositItem:async(i:{id:number})=>{const n=inventory.filter(a=>a.id===i.id).reduce((n,a)=>n+a.count,0),b=bank.find(a=>a.id===i.id);
    if(b)b.count+=n;else bank.push(item(i.id,n));for(let j=inventory.length-1;j>=0;j--)if(inventory[j]!.id===i.id)inventory.splice(j,1);generation++;return{success:true};},
   withdrawItem:async(i:{id:number},n:number)=>{bank.find(a=>a.id===i.id)!.count-=n;inventory.push(item(i.id,n));generation++;return{success:true};}}
 };
 const spies=[spyOn(walking,'sessionWalker').mockResolvedValue({} as any),spyOn(walking,'walkPath').mockImplementation(async(_w,points)=>{
  walks++;if(mode==='cancel-outbound'&&walks===3){stopped=true;return{ok:false,detail:'stopped'} as any;}
  const p=points.at(-1)!;state.player.worldX=p.x;state.player.worldZ=p.z;return{ok:true} as any;
 }),spyOn(training,'trainChickens').mockRejectedValue(Error('must not train')),spyOn(questRunner,'runRuneMysteries').mockRejectedValue(Error('must not repeat quest')),
 spyOn(essence,'runEssenceGatherer').mockImplementation(async()=>{bank.push(item(1436,27));generation++;return{ok:true,totalMined:27,totalBanked:27,held:0,trips:1,died:false,failure:'-'};}),
 spyOn(altarActions,'enterAirAltar').mockResolvedValue(),spyOn(altarActions,'exitAirAltar').mockResolvedValue(),
 spyOn(altarActions,'craftAirRunes').mockImplementation(async()=>{const used=inventory.filter(i=>i.id===1436).reduce((n,i)=>n+i.count,0);
  for(let j=inventory.length-1;j>=0;j--)if(inventory[j]!.id===1436)inventory.splice(j,1);inventory.push(item(556,used));rcXp+=125*used;
  return{ok:true,consumed:used,runes:used,xp:125*used,ticks:1};})];
 try{
  const r=await runRuneSupply(s,mode==='recovery'?20:2,{stop:()=>stopped});
  if(mode==='recovery'){
   expect(r).toMatchObject({ok:true,banked:26,inheritedBanked:26,newBanked:0,crafted:0,consumed:0,mined:0,xp:{runecraft:0}});
   expect(bank.find(i=>i.id===556)?.count).toBe(51);expect(inventory.some(i=>i.id===556)).toBe(false);
   expect(spies[4]).not.toHaveBeenCalled();expect(spies[7]).not.toHaveBeenCalled();
   const higher=await runRuneSupply(s,21);
   expect(higher).toMatchObject({ok:true,inheritedBanked:0,newBanked:26,banked:26,crafted:26,consumed:26,mined:27});
   expect(higher.xp?.runecraft).toBe(3250);expect(bank.find(i=>i.id===556)?.count).toBe(77);
   expect(equipment.map(i=>i.id)).toEqual([1265,1171]);expect(callbacks.size).toBe(0);return;
  }
  if(r.failure&&!stopped)throw Error(r.failure);
  expect(spies[2]).not.toHaveBeenCalled();expect(spies[3]).not.toHaveBeenCalled();
  expect(spies[4]).toHaveBeenCalledTimes(mode==='mined'?1:0);
  if(mode==='cancel-outbound'){expect(r.ok).toBe(false);expect(r.stopReason).toBe('operator');expect(spies[7]).not.toHaveBeenCalled();}
  else{expect(r.ok).toBe(true);expect(r.mined).toBe(mode==='mined'?27:0);expect(r.consumed).toBe(26);expect(r.crafted).toBe(26);expect(r.banked).toBe(26);
   expect(bank.find(i=>i.id===1436)?.count).toBe(1);expect(bank.find(i=>i.id===556)?.count).toBe(51);expect(spies[7]).toHaveBeenCalledTimes(1);}
  expect(callbacks.size).toBe(0);
 }finally{for(const spy of spies)spy.mockRestore();}
});
