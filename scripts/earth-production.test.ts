import {expect,test,spyOn} from 'bun:test';
import {productionBatch,productionConserved,talismanTarget,huntFight,collectHuntLoot,depositEarthInventory,runEarthProduction} from './earth-production';
import * as coreBot from '../packages/core/src/bot';
import * as walking from '../packages/core/src/walk';
import {setEquipmentObserved} from '../packages/core/src/container-observation';
import {waitTicks} from '../packages/core/src/ticks';

test('death during approach returns uncredited and selects fresh goblins without extending the no-progress bound',async()=>{
 const world=spyOn(coreBot,'getWorld').mockResolvedValue({} as any),account=spyOn(coreBot,'accountOf').mockReturnValue({skills:{}} as any);
 const travel=spyOn(walking,'goTo').mockResolvedValue({ok:true} as any);
 try{for(const fresh of [true,false]){
  let tick=0,generation=0,stopped=false;
  const callbacks=new Set<()=>void>(),client={},pack:any[]=[],stock=[{id:995,count:352310},{id:554,count:1482},{id:557,count:26},{id:1440,count:1},{id:1891,count:8}].map(i=>({...i,name:String(i.id)}));
  const equipment=[1277,1171,1115].map(id=>({id,count:1}));setEquipmentObserved(client,true);
  const npc=(index:number)=>({id:100,index,hp:5,inCombat:false,reachable:true,x:3255,z:3226,distance:3});
  const state={revision:0,player:{worldX:3255,worldZ:3226,level:0,combat:{inCombat:false,targetType:'none',targetIndex:-1}},
   nearbyNpcs:[npc(2888)],inventory:pack,groundItems:[],combatEvents:[] as any[],bank:{isOpen:false,items:stock},combatStyle:{currentStyle:0},autoRetaliateEnabled:false};
  const selected:{index:number;tick:number}[]=[],xp=82100;
  const s:any={client,name:'fltargetloss',tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
   bankObservation:()=>state.bank.isOpen?{generation,items:stock}:null,
   sdk:{getState:()=>state,getInventory:()=>pack,getEquipment:()=>equipment,getSkillXp:()=>xp,getSkill:()=>({level:52,baseLevel:49}),
    sendSetCombatStyle:async(n:number)=>{state.combatStyle.currentStyle=n;return{success:true};}},
   bot:{dismissBlockingUI:async()=>{},openBank:async()=>{state.bank.isOpen=true;generation++;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;},
    withdrawItem:async(item:any,n:number)=>{item.count-=n;generation++;pack.push({id:item.id,name:item.name,count:n});return{success:true};},
    depositItem:async(item:any)=>{stock.find(i=>i.id===item.id)!.count+=item.count;pack.splice(pack.indexOf(item),1);generation++;return{success:true};},
    attack:async(n:any)=>{
     selected.push({index:n.index,tick});
     if(fresh&&selected.length===2){stopped=true;return{success:false,reason:'out_of_reach',message:'Cannot reach Goblin'};}
     await waitTicks(s,3);state.nearbyNpcs[0]!.hp=0;
     state.combatEvents=[{tick,observationId:state.revision,type:'damage_taken',sourceType:'other_player',targetType:'npc',targetIndex:n.index,damage:5}];
     await waitTicks(s,2);state.nearbyNpcs=[];
     await waitTicks(s,4);state.nearbyNpcs=[npc(n.index+1)];
     // attackNpcEntity maps the raw target_not_found refusal to timeout.
     return{success:false,reason:'timeout',message:'Failed to interact with NPC: target_not_found'};
    }}};
  const timer=setInterval(()=>{tick++;state.revision++;for(const cb of callbacks)cb();},1);
  try{
   const result=await runEarthProduction(s,{mode:'talismans',cap:20000,target:1139,reserve:30000,stop:()=>stopped});
   expect(result.kills).toBe(0);expect(xp).toBe(82100);expect(result.ok).toBe(false);
   expect(selected[0]!.index).toBe(2888);expect(selected[1]!.index).toBe(2889);
   expect(selected[1]!.tick-selected[0]!.tick).toBe(9);
   if(!fresh){expect(result.failure).toBe('Error: earth hunt no kill progress');expect(result.ticks).toBeGreaterThan(240);expect(result.ticks).toBeLessThan(260);expect(result.conserved).toBe(true);}
   expect(callbacks.size).toBe(0);
  }finally{clearInterval(timer);}
 }}finally{travel.mockRestore();account.mockRestore();world.mockRestore();}
},10000);

test('Earth cleanup banks eight nonstackable cakes and the remaining kit once per current item ID',async()=>{
 let pack=[...Array.from({length:8},(_,slot)=>({id:1891,name:'Cake',count:1,slot})),
  {id:1277,name:'Bronze sword',count:1,slot:8},{id:1277,name:'Bronze sword',count:1,slot:9}];
 let generation=9,checks=0;
 const bank=[{id:1891,name:'Cake',count:0},{id:1277,name:'Bronze sword',count:3}];
 const calls:number[]=[],receipts:any[]=[];
 const s:any={name:'fixture',tick:()=>1,sdk:{getInventory:()=>pack,getState:()=>({inventory:pack})},
  bankObservation:()=>({generation,at:1,items:bank}),
  bot:{depositItem:async(item:any,amount:number)=>{
   expect(pack.find(i=>i.id===item.id)).toBe(item);expect(amount).toBe(-1);calls.push(item.id);
   bank.find(i=>i.id===item.id)!.count+=pack.filter(i=>i.id===item.id).reduce((n,i)=>n+i.count,0);
   pack=pack.filter(i=>i.id!==item.id).map((i,slot)=>({...i,slot}));generation++;
   return{success:true};
  }}};
 const log=spyOn(console,'log').mockImplementation(line=>{if(String(line).startsWith('DEPOSIT_RECEIPT '))receipts.push(JSON.parse(String(line).slice('DEPOSIT_RECEIPT '.length)));});
 try{
  await depositEarthInventory(s,()=>{checks++;});
  expect(pack).toEqual([]);expect(calls).toEqual([1891,1277]);expect(checks).toBe(2);
  expect(bank.map(i=>i.count)).toEqual([8,5]);
  expect(receipts.map(r=>({id:r.itemId,amount:r.amount,packAfter:r.packAfter,bankBefore:r.bankBefore,bankAfter:r.bankAfter,generationBefore:r.generationBefore,generationAfter:r.generationAfter}))).toEqual([
   {id:1891,amount:8,packAfter:0,bankBefore:0,bankAfter:8,generationBefore:9,generationAfter:10},
   {id:1277,amount:2,packAfter:0,bankBefore:3,bankAfter:5,generationBefore:10,generationAfter:11}]);
  await depositEarthInventory(s,()=>{checks++;});expect(calls).toEqual([1891,1277]);expect(checks).toBe(2);
 }finally{log.mockRestore();}
});

test('a level-one order buys only the air unlock, then switches to earth and bounds its last batch',()=>{
 expect(productionBatch(1,0,1137,625)).toEqual({rune:556,talisman:1438,essence:7,multiple:1});
 expect(productionBatch(9,875,1137,618).rune).toBe(557);
 expect(productionBatch(26,10000,3,100).essence).toBe(2);
 expect(productionBatch(52,100000,1,100).essence).toBe(1);
 expect(productionBatch(52,100000,0,100).essence).toBe(0);
});
test('a mid-fight food action re-engages the same observed target within one fight budget',async()=>{
 let tick=0,food=0,xp=0,attacks=0;const callbacks=new Set<()=>void>(),npc={id:1,index:7,hp:7};let alive=true;
 const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getSkillXp:()=>xp,getState:()=>({nearbyNpcs:alive?[npc]:[]})},bot:{attack:async(n:any)=>{expect(n.index).toBe(7);attacks++;return{success:true};}}} as any;
 const timer=setInterval(()=>{tick++;if(tick===3)food++;if(attacks>=2&&tick>=5){xp=700;alive=false;}for(const cb of callbacks)cb();},1);
 try{await huntFight(s,npc,()=>false,()=>food);expect(attacks).toBe(2);expect(tick).toBeLessThan(100);}finally{clearInterval(timer);}
});
test('a missing-target retry settles already-published or delayed own kill credit',async()=>{
 for(const delay of [0,2]){
  let tick=0,xp=82100,attacks=0,alive=true,creditAt=Infinity;
  const callbacks=new Set<()=>void>(),npc={id:100,index:2888,hp:5};
  const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
   sdk:{getSkillXp:()=>xp,getState:()=>({revision:tick,nearbyNpcs:alive?[npc]:[],combatEvents:[]})},
   bot:{attack:async()=>{
    attacks++;if(attacks===1)return{success:true};
    await waitTicks(s,1);alive=false;creditAt=tick+delay;if(!delay)xp+=500;
    return{success:false,reason:'timeout',message:'Failed to interact with NPC: target_not_found'};
   }}};
  const timer=setInterval(()=>{tick++;if(delay&&tick===creditAt)xp+=500;for(const cb of callbacks)cb();},1);
  try{
   expect(await huntFight(s,npc,()=>false,()=>tick>=3?1:0)).toBe('credited');
   expect(xp).toBe(82600);expect(attacks).toBe(2);expect(tick).toBeLessThan(100);expect(callbacks.size).toBe(0);
  }finally{clearInterval(timer);}
 }
});

test('missing-target credit settlement keeps the fight deadline and honours stops',async()=>{
 for(const stopAt of [6,Infinity]){
  let tick=0,attacks=0,alive=true;const callbacks=new Set<()=>void>(),npc={id:100,index:2888,hp:5};
  const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
   sdk:{getSkillXp:()=>82100,getState:()=>({revision:tick,nearbyNpcs:alive?[npc]:[],combatEvents:[]})},
   bot:{attack:async()=>{if(++attacks===1)return{success:true};alive=false;return{success:false,reason:'npc_not_found',message:'gone'};}}};
  const timer=setInterval(()=>{tick++;for(const cb of callbacks)cb();},1);
  try{
   await expect(huntFight(s,npc,()=>tick>=stopAt,()=>tick>=3?1:0)).rejects.toThrow(stopAt===6?'earth hunt fight stopped':'earth hunt fight credit deadline');
   expect(tick).toBe(stopAt===6?6:100);expect(attacks).toBe(2);expect(callbacks.size).toBe(0);
  }finally{clearInterval(timer);}
 }
});

test('unknown XP and initial or repeated attack refusals remain explicit failures',async()=>{
 for(const scenario of ['unknown-xp','missing-final-xp','initial-refusal','repeated-refusal']){
  let tick=0,xp:number|undefined=scenario==='unknown-xp'?undefined:82100,attacks=0,alive=true;
  const npc={id:100,index:2888,hp:5},callbacks=new Set<()=>void>();
  const state=()=>({revision:tick,nearbyNpcs:alive?[npc]:[],combatEvents:[]});
  const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getState:state,getSkillXp:()=>xp},
   bot:{attack:async()=>{
    attacks++;
    if(scenario==='missing-final-xp'){npc.hp=0;for(const cb of callbacks)cb();alive=false;xp=undefined;return{success:false,reason:'timeout',message:'Failed to interact with NPC: target_not_found'};}
    if(scenario==='repeated-refusal'&&attacks===1)return{success:true};
    return{success:false,reason:'out_of_reach',message:'Cannot reach Goblin'};
   }}};
  const timer=setInterval(()=>{tick++;for(const cb of callbacks)cb();},1);
  try{
   await expect(huntFight(s,npc,()=>false,()=>tick)).rejects.toThrow(scenario==='unknown-xp'?'earth hunt strength XP unknown':'earth hunt attack refused');
   expect(attacks).toBe(scenario==='unknown-xp'?0:scenario==='repeated-refusal'?2:1);expect(callbacks.size).toBe(0);
  }finally{clearInterval(timer);}
 }
});
test('unknown inputs never dispatch crafting or authorize an unsupported hunt',()=>{
 for(const n of [-1,NaN,Infinity,1.2])expect(()=>productionBatch(9,875,n,100)).toThrow();
 expect(talismanTarget(1440)).toEqual({id:1440,npcIds:[1,2,3,4,5,6],spot:{x:3221,z:3219}});
 expect(talismanTarget(1438).npcIds).toEqual([100]);
 expect(()=>talismanTarget(557)).toThrow();
});
test('a talisman published after the NPC death delay is collected before leaving the kill',async()=>{
 let tick=0,picked=0;const callbacks=new Set<()=>void>(),pack:any[]=[],ground:any[]=[];
 const s={tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},sdk:{getInventory:()=>pack,getState:()=>({groundItems:ground})},bot:{pickupItem:async()=>{picked++;pack.push({id:1440,count:1});return{success:true};}}} as any;
 const timer=setInterval(()=>{tick++;if(tick===4)ground.push({id:1440,count:1,distance:1});for(const cb of callbacks)cb();},1);
 try{expect(await collectHuntLoot(s,()=>false,true)).toEqual({id:1440,count:1});expect(picked).toBe(1);}finally{clearInterval(timer);}
});
test('conservation binds essence debit, crafted output and food-stage transformations',()=>{
 const before=new Map([[995,352310],[554,1482],[557,2],[1436,20],[1891,1],[1438,1],[1440,1]]);
 const after=new Map([[995,352310],[554,1482],[557,22],[1436,10],[1893,1],[1438,1],[1440,1]]);
 const ledger={consumed:10,crafted:20,air:0,eaten:{1891:1}};
 expect(productionConserved(before,after,ledger)).toBe(true);
 expect(productionConserved(before,new Map(after).set(995,352309),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(554,1481),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(557,21),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(1436,9),ledger)).toBe(false);
 expect(productionConserved(before,new Map(after).set(1893,0),ledger)).toBe(false);
});
