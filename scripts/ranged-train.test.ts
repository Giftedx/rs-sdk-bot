import {test,expect,spyOn} from 'bun:test';
import {bestBow,usableArrows,chooseArrow,buyChunk,arrowAccount,rangedTrainOptions,runRangedTrain,rangedEntry,preparationFunds,needsRangedRecovery,recoveryBank,recoveryWalker,recoverRangedStart,openShopWithDoor,runAdaptiveRanged,rangedComparisonMethod} from './ranged-train';
import * as combat from './gather-combat';
import * as walking from '../packages/core/src/walk';
import * as bot from '../packages/core/src/bot';
import {setEquipmentObserved} from '../packages/core/src/container-observation';
import * as trips from '../packages/core/src/route-plan';
import type {Session} from '../packages/core/src/inprocess';
import {rangedProofSource,rangedChildConfiguration,rangedMemoryFloor,rangedSaveSettled,rangedStackOptions,rangedLevelXp,RANGED_SEED_XP,pointRangedBot} from '../packages/practice/src/ranged-train-proof';
import {readFileSync} from 'node:fs';
import {capabilityRevision} from '../packages/core/src/worker-release';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../packages/core/src/memory';
import {xpForLevel} from '../packages/planner/src/curve';
import {rangedComparisonChecks} from '../packages/practice/src/ranged-progression-case';
import rangedEntryFixture from '../packages/practice/src/ranged-progression-entry.json';

test('the native exact-entry check refuses extra practice supplies that the observed account does not own',()=>{
 const rows=(items:readonly {id:number;count:number}[])=>items.map((i,slot)=>({...i,slot}));
 const save={version:10,position:rangedEntryFixture.pos,vars:{},
  skills:rangedEntryFixture.skills.map((s,index)=>({index,xp:s.xp,level:s.currentLevel,rawExperience:s.xp*10})),
  inventories:{93:rows(rangedEntryFixture.inventory),94:rows(rangedEntryFixture.equipment),95:rows(rangedEntryFixture.bank)}};
 const inflated=structuredClone(save);inflated.inventories[95].push({slot:99,id:892,count:500});
 expect(rangedComparisonChecks(inflated,inflated,null,'',1).exactEntry).toBe(false);
});

test('adaptive Ranged reads a fresh bank, selects the existing trooper worker and counts approach fares',async()=>{
 const client={};setEquipmentObserved(client,true);let generation=1,open=false;
 const pack:{id:number;count:number}[]=[];
 const bank=[{id:841,count:1},{id:882,count:500},{id:2142,count:43},{id:995,count:382923}];
 const skills=[{name:'Ranged',baseLevel:80,level:80,xp:285700},{name:'Hitpoints',baseLevel:99,level:99,xp:1080130}];
 const s={name:'ordinary',client,tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
  bankObservation:()=>open?{at:Date.now(),generation,items:generation>1?bank:[]}:null,
  sdk:{getState:()=>({player:{worldX:3252,worldZ:3420,level:0},bank:{isOpen:open}}),getSkills:()=>skills,
   getSkill:(name:string)=>skills.find(k=>k.name===name),getSkillXp:(name:string)=>skills.find(k=>k.name===name)?.xp??0,getInventory:()=>pack,getEquipment:()=>[]},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   withdrawItem:async(item:{id:number},amount:number)=>{expect(open).toBe(true);bank.find(i=>i.id===item.id)!.count-=amount;pack.push({id:item.id,count:amount});generation++;return{success:true};}},
 } as unknown as Session;
 const worker=spyOn(combat,'runGiants').mockImplementation(async(session,o)=>{
  expect(o.site).toBe(combat.TROOPER_SITE);expect(o.trainSkill).toBe('Ranged');expect(o.targetLevel).toBe(85);
  await session.bot.openBank();await session.bot.withdrawItem({id:995} as any,60);await session.bot.closeBank();pack.splice(0);
  await session.bot.openBank();skills[0]!.baseLevel=85;skills[0]!.level=85;skills[0]!.xp+=100000;
  return{ok:true,targetMet:true,preserved:true,foodAccounted:true,selectedXp:100000,ammoId:882,ammoUsed:4,finalLevel:85} as any;
 });
 try{
  const r=await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','ordinary','85','20000']),coinReserve:382483});
  expect(worker).toHaveBeenCalledTimes(1);expect(r).toMatchObject({method:'ranged/troopers',ok:true,targetMet:true,coinsSpent:60,coinDebit:60});
 }finally{worker.mockRestore();}
});

test('a public live ranged invocation cannot force the comparison chicken method',()=>{
 expect(()=>rangedComparisonMethod('chickens','rs-sdk-demo.fly.dev')).toThrow('local practice server');
 expect(rangedComparisonMethod('chickens','127.0.0.1:8888')).toBe('chickens');
});

test('adaptive Ranged finishes an owned gear unlock band then reobserves before the next band',async()=>{
 const client={};setEquipmentObserved(client,true);let generation=0,open=false,tick=0,level=19,xp=xpForLevel(19);
 const bank=[{id:843,count:1},{id:849,count:1},{id:882,count:300},{id:888,count:300},{id:2142,count:43},{id:995,count:382923}];
 const skills=()=>[{name:'Ranged',baseLevel:level,level,xp},{name:'Hitpoints',baseLevel:99,level:99,xp:1080130}];
 const s={name:'ordinary',client,tick:()=>tick,ended:new Promise(()=>{}),onTick:()=>()=>{},
  bankObservation:()=>({at:Date.now(),generation,items:bank}),
  sdk:{getState:()=>({player:{worldX:2619,worldZ:3332,level:0},bank:{isOpen:open}}),getSkills:skills,
   getSkill:(name:string)=>skills().find(k=>k.name===name),getSkillXp:(name:string)=>skills().find(k=>k.name===name)?.xp??0,getInventory:()=>[],getEquipment:()=>[]},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};}},
 } as unknown as Session;
 const bands:number[]=[],kits:number[]=[];
 const worker=spyOn(combat,'runGiants').mockImplementation(async(_s,o)=>{
  bands.push(o.targetLevel!);kits.push(o.rangedKit!.bow);const start=xp;
  level=o.targetLevel!;xp=xpForLevel(level);tick+=100;
  return{ok:true,targetMet:true,preserved:true,foodAccounted:true,selectedXp:xp-start,ammoId:o.rangedKit!.arrow,ammoUsed:1,finalLevel:level} as any;
 });
 try{
  const r=await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','ordinary','25','3000']),coinReserve:382483});
  expect(bands).toEqual([20,25]);expect(kits).toEqual([843,849]);expect(r).toMatchObject({ok:true,targetMet:true,finalLevel:25});
 }finally{worker.mockRestore();}
});

test('trooper preparation banks entry coins before a zero-spend order can approach the field',async()=>{
 const client={};setEquipmentObserved(client,true);let generation=0,open=false,level=80,xp=285700;
 const pack=[{id:995,name:'Coins',slot:0,count:100}],bank=[{id:841,count:1},{id:882,count:149},{id:2142,count:43},{id:995,count:100}].map(i=>({...i,name:i.id===995?'Coins':String(i.id)}));
 const skills=()=>[{name:'Ranged',baseLevel:level,level,xp},{name:'Hitpoints',baseLevel:99,level:99,xp:1080130}];
 const s={name:'ordinary',client,tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
  bankObservation:()=>({at:Date.now(),generation,items:bank}),
  sdk:{getState:()=>({player:{worldX:2619,worldZ:3332,level:0},inventory:pack,bank:{isOpen:open,items:bank}}),getSkills:skills,
   getSkill:(name:string)=>skills().find(k=>k.name===name),getSkillXp:(name:string)=>skills().find(k=>k.name===name)?.xp??0,getInventory:()=>pack,getEquipment:()=>[]},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   depositItem:async()=>{bank.find(i=>i.id===995)!.count+=100;pack.splice(0);generation++;return{success:true};},
   withdrawItem:async()=>{throw Error('unbudgeted withdrawal reached the bot');}},
 } as unknown as Session;
 const worker=spyOn(combat,'runGiants').mockImplementation(async(session)=>{
  expect(session.sdk.getInventory().some(i=>i.id===995)).toBe(false);
  await expect(session.bot.withdrawItem({id:995} as any,60)).rejects.toThrow('fare budget refused');
  level=85;xp=xpForLevel(85);return{ok:true,targetMet:true,preserved:true,foodAccounted:true,selectedXp:xp-285700,ammoId:882,ammoUsed:0,finalLevel:85} as any;
 });
 try{expect(await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','ordinary','85','3000']),maxSpend:0})).toMatchObject({ok:true,coinDebit:0});}
 finally{worker.mockRestore();}
});

test('the adaptive CLI budget and result include its unsupported-entry recovery walk',async()=>{
 const client={};setEquipmentObserved(client,true);let generation=0,open=false,tick=0,level=80,xp=285700;
 const p={worldX:3185,worldZ:3436,level:0},bank=[{id:841,count:1},{id:882,count:149},{id:2142,count:43},{id:995,count:382923}];
 const skills=()=>[{name:'Ranged',baseLevel:level,level,xp},{name:'Hitpoints',baseLevel:99,level:99,xp:1080130}];
 const s={name:'ordinary',client,tick:()=>tick,ended:new Promise(()=>{}),onTick:()=>()=>{},
  bankObservation:()=>({at:Date.now(),generation,items:bank}),
  sdk:{getState:()=>({player:p,bank:{isOpen:open}}),getSkills:skills,getSkill:(n:string)=>skills().find(k=>k.name===n),getSkillXp:(n:string)=>skills().find(k=>k.name===n)?.xp??0,getInventory:()=>[],getEquipment:()=>[]},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};}},
 } as unknown as Session;
 const world=spyOn(bot,'getWorld').mockImplementation(async()=>({} as any)),actor=spyOn(bot,'accountOf').mockImplementation(()=>({skills:{magic:99},items:[],coins:0} as any));
 const go=spyOn(walking,'goTo').mockImplementation(async()=>{tick+=77;p.worldX=3253;p.worldZ=3421;return{ok:true} as any;});
 const worker=spyOn(combat,'runGiants').mockImplementation(async(_s,o)=>{
  expect(o.cap).toBe(2923);tick+=100;level=85;xp=xpForLevel(85);
  return{ok:true,targetMet:true,preserved:true,foodAccounted:true,selectedXp:xp-285700,ammoId:882,ammoUsed:0,finalLevel:85} as any;
 });
 try{
  const r=await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','ordinary','85','3000']),coinReserve:382483});
  expect(go).toHaveBeenCalledTimes(1);expect(r).toMatchObject({ok:true,ticks:177});
 }finally{worker.mockRestore();go.mockRestore();world.mockRestore();actor.mockRestore();}
});

test('stock-only native continuation disables arrow buying without reducing admission or target checks',()=>{
 const c=rangedChildConfiguration('fixture',{LOOT_WATCH:'1'});expect(c.env.BUY_ARROWS).toBe('0');expect(c.env.COIN_RESERVE).toBe('400000');
 expect(c.env.RANGED_COMPARE_METHOD).toBe('chickens');
 expect(c.env.LOOT_WATCH).toBe('0');
 expect(c.cmd.slice(-2)).toEqual(['71','10000']);expect(c.env.KILLS_PER_TRIP).toBe('8');
});
test('native Ranged proof binds its actual worker closure and owned files',()=>{
 const s=rangedProofSource();expect(s.runtime).toBe(capabilityRevision(['scripts/ranged-train.ts']));
 expect(Object.keys(s.files)).toEqual(['scripts/ranged-train.ts','scripts/ranged-train.test.ts','packages/practice/src/ranged-train-proof.ts',
  'scripts/gather-combat.ts','scripts/gather-combat-giant.test.ts',
  'packages/practice/src/ranged-progression-case.ts','packages/practice/src/ranged-progression-case.test.ts',
  'packages/practice/src/ranged-progression-entry.json','scripts/measure/progression-bench-cases.ts','scripts/measure/fleet-player-save.ts','scripts/measure/fleet-player-save.test.ts']);
},30_000); // Two closure hashes take about 3 s on an idle PC; the default 5 s limit fails under load.

test('proof selects a whole isolated endpoint set and refuses eight exhausted candidates',()=>{
 const endpoints=(o:ReturnType<typeof rangedStackOptions>)=>[o.ports.engine,o.ports.gateway,...Object.values(o.enginePreload!.env).map(Number)];
 const first=rangedStackOptions(()=>true),ports=endpoints(first);
 expect(ports).toEqual([19100,19101,19102,44100,44101,44102,44103]);
 expect(first).toMatchObject({tickMs:150,xpRate:25,readyTimeoutMs:60000,instance:`ranged-train-${process.pid}`});
 expect(first.enginePreload!.module.endsWith('save-endpoint.ts')).toBe(true);
 for(const blocked of ports){
  const checked:number[]=[];
  const next=rangedStackOptions(port=>{checked.push(port);return port!==blocked;});
  expect(endpoints(next)).toEqual([19110,19111,19112,44110,44111,44112,44113]);
  expect(checked).toContain(blocked);
  expect(checked).not.toContain(8888);expect(checked).not.toContain(7780);
 }
 const checked:number[]=[];
 expect(()=>rangedStackOptions(port=>{checked.push(port);return port%10!==3;})).toThrow('no bindable isolated ranged-train port set (8 candidates)');
 expect(checked).toHaveLength(56);
 expect(new Set(checked).size).toBe(56);
});
test('native Ranged proof points its bot at IPv4 loopback, not localhost',()=>{
 const dir=mkdtempSync(join(tmpdir(),'ranged-env-')),env=join(dir,'bot.env');
 try{
  writeFileSync(env,'BOT_USERNAME=flrng\r\nSERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\n');
  const {ports}=rangedStackOptions(()=>true);pointRangedBot(env,ports);
  const text=readFileSync(env,'utf8');
  expect(text).toMatch(/^SERVER=127\.0\.0\.1:19100$/m);
  expect(text).toMatch(/^GATEWAY_URL=ws:\/\/127\.0\.0\.1:19101$/m);
  expect(text).not.toContain('localhost');
  expect(readFileSync(new URL('../packages/practice/src/ranged-train-proof.ts',import.meta.url),'utf8')).toContain('pointRangedBot(envPath,options.ports)');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('proof holds the free-memory floor, not the start reserve that delivery admits',()=>{
 for(const free of [FREE_FLOOR_GB,PRACTICE_STARTUP_GB-0.1,PRACTICE_STARTUP_GB])expect(()=>rangedMemoryFloor(free,'before stack')).not.toThrow();
 for(const free of [FREE_FLOOR_GB-0.01,0,NaN])expect(()=>rangedMemoryFloor(free,'before child')).toThrow('practice memory floor reached before child');
});
test('proof captures only the save whose XP delta equals the final result at the bank',()=>{
 const save=(xp:number,x:number,z:number)=>({skills:Object.assign([],{4:{xp}}),position:{x,z,level:0}}) as any,before=save(1000,2807,3441);
 expect(rangedSaveSettled(before,save(3400,3253,3421),{xpGain:2400})).toBe(true);
 expect(rangedSaveSettled(before,save(3100,3253,3421),{xpGain:2400})).toBe(false);
 expect(rangedSaveSettled(before,save(3400,3236,3294),{xpGain:2400})).toBe(false);
 expect(rangedSaveSettled(before,save(3400,3253,3421),null)).toBe(false);
});
test('best bow is the highest owned tier the Ranged level can wield; shortbow wins a tie',()=>{
 const all=[841,839,843,845,849,847,853,851,857,855,861,859].map(id=>({id,count:1}));
 for(const [level,id] of [[1,841],[4,841],[5,843],[19,843],[20,849],[30,853],[40,857],[50,861],[99,861]] as const)expect(bestBow(all,level)?.id).toBe(id);
 expect(bestBow([{id:845,count:1},{id:841,count:1}],7)?.id).toBe(845);
 expect(bestBow([{id:861,count:1}],49)).toBeUndefined();
 expect(bestBow([{id:841,count:0}],10)).toBeUndefined();
});
test('arrows follow the bow levelrequire and the wearer level',()=>{
 expect(usableArrows(1,99)).toEqual([882,884]);
 expect(usableArrows(5,4)).toEqual([882,884]);
 expect(usableArrows(5,7)).toEqual([882,884,886]);
 expect(usableArrows(40,40)).toEqual([882,884,886,888,890,892]);
 expect(chooseArrow([{id:884,count:10},{id:882,count:45},{id:886,count:99}],1,7)).toEqual({id:884,count:10});
 expect(chooseArrow([{id:886,count:99}],1,7)).toBeUndefined();
});
test('Catherby entry and preparation budget preserve the total reserve',()=>{
 expect(rangedEntry({worldX:2807,worldZ:3441,level:0})).toEqual({x:2809,z:3441});
 expect(rangedEntry({worldX:2807,worldZ:3441,level:1})).toBeNull();
 expect(rangedEntry({worldX:3000,worldZ:3000,level:0})).toBeNull();
 expect(preparationFunds(455452,0,5000,400000)).toBe(5000);
 expect(preparationFunds(400100,50,5000,400000)).toBe(100);
 expect(preparationFunds(455452,4999,5000,400000)).toBe(1);
 expect(preparationFunds(399999,0,5000,400000)).toBe(0);
});
test('purchase chunk stays inside budget, wallet reserve, shelf and packet size',()=>{
 expect(buyChunk(60,2000,10,800,800,0)).toBe(10);
 expect(buyChunk(60,2000,10,40,800,0)).toBe(2);
 expect(buyChunk(60,2000,10,800,100,90)).toBe(0);
 expect(buyChunk(3,2000,10,800,800,0)).toBe(3);
 expect(buyChunk(60,1,10,800,800,0)).toBe(1);
 for(const price of [0,-1,NaN])expect(buyChunk(60,2000,price,800,800,0)).toBe(0);
});
test('arrows spent are bounded by observed shots; unexplained gain or loss fails',()=>{
 expect(arrowAccount(15,40,50,7)).toEqual({spent:5,ok:true});
 expect(arrowAccount(15,40,50,4).ok).toBe(false);
 expect(arrowAccount(15,0,20,9).ok).toBe(false);
});
test('options keep defaults, accept argv target and cap, and refuse unbounded input',()=>{
 const o=rangedTrainOptions({},['bun','s','Bot']);
 expect(o).toMatchObject({target:10,cap:3000,minArrows:30,buyArrowId:882,maxSpend:500,foodId:329,killsPerTrip:5,maxTrips:10});
 expect(rangedTrainOptions({TARGET_LEVEL:'20'},['bun','s','Bot','12','4000'])).toMatchObject({target:12,cap:4000});
 for(const env of [{CAP:'100'},{BUY_ARROW_ID:'888'},{FOOD_ID:'315'},{MAX_TRIPS:'0'},{AMMO:'x'},{MAX_SPEND:'-1'}])expect(()=>rangedTrainOptions(env,['bun','s','Bot'])).toThrow('bounded options');
});
test('recovery runs only off a supported entry or with the bow or quiver worn',()=>{
 expect(needsRangedRecovery({worldX:3253,worldZ:3421,level:0},[])).toBe(false);
 expect(needsRangedRecovery({worldX:3253,worldZ:3421,level:0},[1171])).toBe(false);
 expect(needsRangedRecovery({worldX:3231,worldZ:3299,level:0},[])).toBe(true);
 expect(needsRangedRecovery({worldX:3253,worldZ:3421,level:1},[])).toBe(true);
 expect(needsRangedRecovery({worldX:3254,worldZ:3420,level:0},[841,884])).toBe(true);
});
test('bones another player takes lose only the item; the kill and accounting stand',async()=>{
 const f=trainingFixture(['kill','kill'],false,false,false,'bones-taken');
 try{const r=await f.run();expect(r).toMatchObject({ok:true,targetMet:true,kills:2,bonesPicked:0,chickenPicked:2,accounting:true,preserved:true});}finally{f.close();}
});
test('a shut shop door is opened once before the keeper is asked again',async()=>{
 const run=async(shopResults:boolean[],door:boolean)=>{const calls:string[]=[];
  const bot={openShop:async()=>{calls.push('shop');return{success:shopResults.shift()??false};},openDoor:async()=>{calls.push('door');return{success:door};}};
  return{ok:await openShopWithDoor(bot,/^lowe$/i,async()=>true),calls};};
 expect(await run([true],true)).toEqual({ok:true,calls:['shop']});
 expect(await run([false,true],true)).toEqual({ok:true,calls:['shop','door','shop']});
 expect(await run([false,false],true)).toEqual({ok:false,calls:['shop','door','shop']});
 expect(await run([false],false)).toEqual({ok:false,calls:['shop','door']});
});
test('the recovery walk plans with no Magic, items, worn gear or coins, so it can spend nothing',()=>{
 const w=recoveryWalker({skills:{magic:55,ranged:70},varps:{a:1},items:['law_rune'],counts:{law_rune:9},worn:['staff_of_air'],coins:90000});
 expect(w).toEqual({skills:{magic:0,ranged:70},varps:{a:1},items:[],counts:{},worn:[],coins:0});
});
function recoverySession(position={worldX:3236,worldZ:3296,level:0},arrowId=884){
 const client={};setEquipmentObserved(client,true);
 let tick=0;const callbacks=new Set<()=>void>(),unequipped:number[]=[];
 const equipment=[{id:841,name:'Shortbow',count:1},{id:arrowId,name:'Arrow',count:50}];
 const s={name:'unit',client,tick:()=>tick,onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>{callbacks.delete(cb);};},
  sdk:{getState:()=>({player:position}),getEquipment:()=>equipment},
  bot:{unequipItem:async(i:{id:number})=>{unequipped.push(i.id);equipment.splice(equipment.findIndex(e=>e.id===i.id),1);}}};
 const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
 return{s:s as unknown as Session,unequipped,stop:()=>clearInterval(timer)};
}
test('Ardougne bank recovery observes worn bow and quiver removal without unfunded travel',async()=>{
 const position={worldX:2618,worldZ:3332,level:0};
 const go=spyOn(walking,'goTo').mockImplementation(async()=>{throw Error('recovery travel before bank funding');});
 try{
  expect(rangedEntry(position)).toEqual({x:2619,z:3332});
  expect(rangedEntry({...position,level:1})).toBeNull();
  expect(rangedEntry({...position,worldX:2612})).toBeNull();
  for(const observed of [true,false]){
   const f=recoverySession(position,882);
   const unequip=observed?undefined:spyOn(f.s.bot,'unequipItem').mockImplementation(async()=>({success:true} as any));
   try{
    expect(f.s.sdk.getEquipment().map(i=>i.id)).toEqual([841,882]);
    if(observed){
     expect(await recoverRangedStart(f.s)).toEqual({from:{x:2618,z:3332,level:0},stopped:false});
     expect(f.unequipped).toEqual([841,882]);expect(f.s.sdk.getEquipment()).toEqual([]);
    }else{
     await expect(recoverRangedStart(f.s)).rejects.toThrow('ranged-train recovery unequip unobserved 841');
     expect(f.s.sdk.getEquipment().map(i=>i.id)).toEqual([841,882]);
    }
    expect(go).not.toHaveBeenCalled();expect(f.s.sdk.getState()!.player).toMatchObject(position);
   }finally{unequip?.mockRestore();f.stop();}
  }
 }finally{go.mockRestore();}
});

test('a stop before recovery starts no route and leaves the kit worn',async()=>{
 const f=recoverySession(),go=spyOn(walking,'goTo').mockImplementation(async()=>({ok:true} as any));
 try{const r=await recoverRangedStart(f.s,()=>true);expect(r).toEqual({from:{x:3236,z:3296,level:0},stopped:true});expect(go).not.toHaveBeenCalled();expect(f.unequipped).toEqual([]);}
 finally{go.mockRestore();f.stop();}
});
test('a stop during the recovery walk aborts the route and skips the unwield',async()=>{
 const f=recoverySession();let stop=false,actor:any,signal:AbortSignal|undefined;
 const world=spyOn(bot,'getWorld').mockImplementation(async()=>({} as any)),acct=spyOn(bot,'accountOf').mockImplementation(()=>({skills:{magic:40},varps:{},items:['law_rune'],coins:500} as any));
 const go=spyOn(walking,'goTo').mockImplementation(async(_s,_w,_to,a,o)=>{actor=a;signal=o?.signal;stop=true;
  await new Promise<void>(res=>o!.signal!.addEventListener('abort',()=>res()));return{ok:false,reason:'aborted'} as any;});
 try{
  const r=await recoverRangedStart(f.s,()=>stop);
  expect(r?.stopped).toBe(true);expect(signal?.aborted).toBe(true);expect(actor).toMatchObject({items:[],coins:0,skills:{magic:0}});expect(f.unequipped).toEqual([]);
 }finally{go.mockRestore();world.mockRestore();acct.mockRestore();f.stop();}
});

// Only travel is stubbed. The worker observes tick, XP, target, loot and bank effects.
function trainingFixture(outcomes:('lost'|'kill'|'retry'|'stalled'|'noloot')[],catherby=false,upgrade=false,underground=false,ammoRace?:'foreign'|'own-missing'|'bones-taken',observeBankMoves=false,missingFood=false){
 type Item={id:number;name:string;count:number};
 const item=(id:number,count:number):Item=>({id,name:id===995?'Coins':id===1985?'Cheese':String(id),count});
 let tick=0,xp=0,level=7,generation=0,trip=0,active=-1,attempt=0,firstAttack=0,respawnAt:number|undefined;
 let pack:Item[]=catherby?[item(995,3250),item(1515,2),item(946,1),item(1893,4)]:[],equipment:Item[]=[],bank=[item(843,1),item(882,60),...(catherby?[item(995,452202)]:missingFood?[item(995,52)]:[item(329,3)])];
 if(upgrade)bank.push(item(849,1),item(888,20));
 if(underground){pack=[item(556,3),item(557,1),item(553,1)];equipment=[item(552,1),item(1277,1),item(1171,1)];}
 const state:any={player:{worldX:catherby?2807:3253,worldZ:catherby?3441:3421,level:0},autoRetaliateEnabled:false,bank:{isOpen:false,items:bank},nearbyNpcs:[],groundItems:[]};
 if(underground){state.player.worldX=3113;state.player.worldZ=9555;}
 const attacks:{target:number;trip:number;tick:number;kit:number[]}[]=[],listeners=new Set<()=>void>();
 const add=(items:Item[],id:number,n:number)=>{const found=items.find(i=>i.id===id);if(found)found.count+=n;else items.push(item(id,n));};
 const target=()=>({index:active,id:41,x:3233,z:3297,tileX:3233,tileZ:3297,distance:1,reachable:true,inCombat:false,hp:3,maxHp:3});
 const next=()=>{active++;attempt=0;state.nearbyNpcs=active<outcomes.length?[target()]:[];};
 const kill=()=>{const npc=state.nearbyNpcs[0]??target();xp+=300;level=upgrade?(xp>=600?30:20):xp>=600||outcomes[active]==='retry'?10:8;state.nearbyNpcs=[];
  state.groundItems=[{...item(526,1),x:npc.tileX,z:npc.tileZ,distance:0},{...item(2138,1),x:npc.tileX,z:npc.tileZ,distance:0}];
  if(ammoRace){equipment.find(i=>i.id===882)!.count--;for(const cb of [...listeners])cb();
   state.groundItems.push({ ...item(882,1),x:npc.tileX,z:npc.tileZ,distance:0},...(ammoRace==='foreign'?[{...item(884,1),x:npc.tileX,z:npc.tileZ,distance:0}]:[]));}
 };
 const timer=setInterval(()=>{
  tick++;
  if(attempt===1&&tick===firstAttack+4&&['retry','stalled'].includes(outcomes[active]!))xp+=200;
  // Same index returns on another tile; its loot never appears on the frozen tile.
  if(tick===respawnAt){respawnAt=undefined;state.nearbyNpcs=[{...target(),x:3236,z:3294,tileX:3236,tileZ:3294}];}
  if(respawnAt===undefined&&state.player.worldZ===3297&&!state.nearbyNpcs.length&&!state.groundItems.length)next();
  for(const cb of [...listeners])cb();
 },1);
 const s={name:'unit',tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  bankObservation:()=>({generation,items:bank}),
  sdk:{getState:()=>({...state,inventory:pack}),getInventory:()=>pack,getEquipment:()=>equipment,getSkill:(name:string)=>name==='Ranged'?{baseLevel:level,level}:{level:16},getSkillXp:()=>xp,
   sendSetCombatStyle:async()=>{state.combatStyle={known:true,currentStyle:1,styles:[{index:1,trainsSkills:['Ranged']}]};}},
   bot:{openBank:async()=>{if(state.player.worldZ>9000)throw Error('bank before underground exit');state.bank.isOpen=true;generation++;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;},
   openShop:async()=>{state.shop={isOpen:true,shopItems:[{id:1985,name:'Cheese',count:3,baseCost:4,buyPrice:5}],shopConfig:{sellMultiplier:1000}};return{success:true};},
   closeShop:async()=>{state.shop.isOpen=false;},
   buyFromShop:async(_name:RegExp,n:number)=>{add(pack,1985,n);add(pack,995,-5*n);state.shop.shopItems[0].count-=n;return{success:true};},
   withdrawItem:async(i:Item,n:number)=>{i.count-=n;add(pack,i.id,n);generation++;},
   depositItem:async(i:Item)=>{add(bank,i.id,i.count);pack=pack.filter(p=>p.id!==i.id);generation++;if(observeBankMoves)for(const cb of [...listeners])cb();return{success:true};},
   equipItem:async(i:Item)=>{const bows=[843,849],arrows=[882,888],group=bows.includes(i.id)?bows:arrows;for(const old of equipment.filter(e=>group.includes(e.id)))add(pack,old.id,old.count);equipment=equipment.filter(e=>!group.includes(e.id));equipment.push({...i});pack=pack.filter(p=>p.id!==i.id);},
   unequipItem:async(i:Item)=>{add(pack,i.id,i.count);equipment=equipment.filter(p=>p.id!==i.id);},
   attack:async()=>{attempt++;attacks.push({target:active,trip,tick,kit:equipment.map(i=>i.id)});if(attempt===1)firstAttack=tick;
    if(outcomes[active]==='lost')state.nearbyNpcs=[];
    if(outcomes[active]==='noloot'&&attempt===1){xp+=300;state.nearbyNpcs=[];respawnAt=tick+3;}
    if(outcomes[active]==='kill'||outcomes[active]==='retry'&&attempt===4||outcomes[active]==='noloot'&&attempt===2)kill();
    return{success:true};},
   pickupItem:async(i:Item)=>{if(!(ammoRace==='own-missing'&&i.id===882)&&!(ammoRace==='bones-taken'&&i.id===526))add(pack,i.id,i.count);state.groundItems=state.groundItems.filter((g:Item)=>g!==i&&!(ammoRace==='foreign'&&i.id===882&&g.id===884));}},
 }as unknown as Session;
 const walker=spyOn(walking,'sessionWalker').mockImplementation(async()=>({} as any));
 const planner=spyOn(trips,'planTripOffThread').mockImplementation(async(from,to)=>({cost:1,legs:from.x===to.x&&from.z===to.z?[]:[{kind:'travel',to,travel:{coins:30,runes:[],needs:[]}}]} as any));
 const worldRoute=spyOn(walking,'walkRoute').mockImplementation(async(_s,legs)=>{
  const last=legs.at(-1);if(last){const cellar=state.player.worldZ>9000;state.player.worldX=last.to.x;state.player.worldZ=last.to.z;if(!cellar)add(pack,995,-30);}return{ok:true,ticks:1};
 });
 const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
  const p=points.at(-1)!;state.player.worldX=p.x;state.player.worldZ=p.z;
  if(p.z===3297){trip++;if(!state.nearbyNpcs.length)next();}
  return{ok:true,ticks:0,still:0,clicks:0,repaths:0,doors:0,next:points.length};
 });
 if(underground)planner.mockImplementation(async(from,to)=>({cost:1,legs:from.z>9000?[{kind:'transport',to,at:{x:3103,z:9576,level:0}}]:[]} as any));
 return{s,attacks,planner,worldRoute,route,assets:()=>[...bank,...pack,...equipment],run:(overrides={})=>runRangedTrain(s,{...rangedTrainOptions({},['bun','s','unit']),maxTrips:2,buyArrows:0,...(catherby?{maxSpend:5000,coinReserve:400000}:{}),...overrides}),
  close:()=>{clearInterval(timer);route.mockRestore();walker.mockRestore();planner.mockRestore();worldRoute.mockRestore();}};
}

test('Varrock food staging uses its bounded mainland corridor instead of a cold global route search',async()=>{
 const f=trainingFixture(['kill','kill'],false,false,false,undefined,false,true);
 f.planner.mockImplementation(async()=>{throw Error('cold global food search must not start');});
 try{
  const r=await f.run({food:2,maxSpend:52});
  expect(r).toMatchObject({ok:true,targetMet:true,kills:2,foodId:1985,foodBought:2,foodSpent:10,travelSpent:0,coinsSpent:10,coinDebit:10,preserved:true,accounting:true,equipmentRestored:true});
  expect(f.planner).not.toHaveBeenCalled();expect(f.worldRoute).not.toHaveBeenCalled();
  const paths=f.route.mock.calls.map(([,points])=>points);
  expect(paths.some(points=>points.at(-1)?.x===3015&&points.at(-1)?.z===3206)).toBe(true);
  expect(paths.some(points=>points.at(-1)?.x===3253&&points.at(-1)?.z===3421)).toBe(true);
 }finally{f.close();}
});

test('Varrock food corridor keeps its stop bound and buys nothing after an interrupted walk',async()=>{
 const f=trainingFixture(['kill'],false,false,false,undefined,false,true);let stopped=false;
 f.planner.mockImplementation(async()=>{throw Error('cold global food search must not start');});
 f.route.mockImplementation(async(_deps,points,options)=>{
  expect(points.at(-1)).toMatchObject({x:3015,z:3206});
  expect(options?.maxTicks).toBeLessThanOrEqual(500);expect(options?.stop?.()).toBe(false);
  stopped=true;expect(options?.stop?.()).toBe(true);
  return {ok:false,detail:'stop requested',ticks:1} as any;
 });
 try{
  const r=await f.run({food:2,maxSpend:52,stop:()=>stopped});
  expect(f.route).toHaveBeenCalledTimes(1);expect(f.planner).not.toHaveBeenCalled();
  expect(r).toMatchObject({ok:false,kills:0,foodBought:0,foodSpent:0,coinsSpent:0,coinDebit:0,preserved:true,accounting:true});
  expect(f.attacks).toHaveLength(0);expect(r.failure).toContain('stop requested');
 }finally{f.close();}
});

for(const race of ['foreign','own-missing'] as const)test(`optional ammunition race ${race} cannot stop an accounted Ranged band`,async()=>{
 const f=trainingFixture(['kill','kill'],false,false,false,race);
 try{const r=await f.run();expect(r).toMatchObject({ok:true,targetMet:true,kills:2,accounting:true,preserved:true,equipmentRestored:true,died:false});
  expect(r.arrowsSpent).toBe(race==='own-missing'?2:0);
  expect(f.assets().some(i=>i.id===884&&i.count>0)).toBe(false);
 }finally{f.close();}
});

test('observed underground entry routes before banking and preserves the skull, runes and amulet',async()=>{
 expect(rangedEntry({worldX:3113,worldZ:9555,level:0})).toEqual({x:3253,z:3421});
 expect(rangedEntry({worldX:3113,worldZ:9555,level:1})).toBeNull();
 expect(rangedEntry({worldX:3114,worldZ:9555,level:0})).toBeNull();
 const f=trainingFixture(['kill','kill'],false,false,true);
 try{
  const r=await f.run();
  expect(r).toMatchObject({ok:true,targetMet:true,kills:2,travelSpent:0,coinDebit:0,accounting:true,preserved:true,equipmentRestored:true,died:false});
  expect(f.planner.mock.calls[0]!.slice(0,2)).toEqual([{x:3113,z:9555,level:0},{x:3253,z:3421,level:0}]);
  expect(f.worldRoute).toHaveBeenCalledTimes(1);
  for(const [id,n] of [[556,3],[557,1],[553,1],[552,1],[1277,1],[1171,1]])expect(f.assets().filter(i=>i.id===id).reduce((s,i)=>s+i.count,0)).toBe(n!);
 }finally{f.close();}
});

test('Catherby mixed pack is banked, missing food is bought, and fares reconcile with the shared budget',async()=>{
 const f=trainingFixture(['kill','kill'],true);
 try{
  const r=await f.run();
  expect(r).toMatchObject({ok:true,foodId:1985,foodBought:3,foodSpent:15,travelSpent:60,coinsSpent:75,coinDebit:75,accounting:true,preserved:true});
  for(const [id,n] of [[1515,2],[946,1],[1893,4]])expect(f.assets().filter(i=>i.id===id).reduce((s,i)=>s+i.count,0)).toBe(n!);
 }finally{f.close();}
});

test('a reserve shortfall refuses preparation before purchases or attacks',async()=>{
 const f=trainingFixture(['kill'],true);
 try{const r=await f.run({coinReserve:999999});expect(r.ok).toBe(false);expect(r.failure).toContain('coin reserve short');expect(r.coinsSpent).toBe(0);expect(f.attacks).toHaveLength(0);expect(r.preserved).toBe(true);}finally{f.close();}
});

test('lost targets give no kill credit, continue the trip, and bank at five losses per trip',async()=>{
 const f=trainingFixture(['lost','lost','lost','lost','kill','lost','lost','lost','lost','lost','kill']);
 try{
  const r=await f.run();
  expect(r).toMatchObject({ok:true,kills:2,trips:2,accounting:true,preserved:true});
  expect(f.attacks.map(a=>a.trip)).toEqual([1,1,1,1,1,1,2,2,2,2,2]);
 }finally{f.close();}
});

test('an XP stall retries the present target at eight ticks, at most three times, then retains the stall bound',async()=>{
 for(const outcome of ['retry','stalled'] as const){
  const f=trainingFixture([outcome]);
  try{
   const r=await f.run(),start=f.attacks[0]!.tick;
   expect(f.attacks.map(a=>a.tick-start)).toEqual([0,12,20,28]);
   expect(f.attacks.every(a=>a.target===0)).toBe(true);
   if(outcome==='retry')expect(r).toMatchObject({ok:true,kills:1,accounting:true,preserved:true});
   else{expect(r.ok).toBe(false);expect(r.kills).toBe(0);expect(r.failure).toContain('ranged-train combat/credit stalled');}
  }finally{f.close();}
 }
});

test('valid XP without loot freezes the tile, credits no kill, and continues to the same index respawned elsewhere',async()=>{
 const f=trainingFixture(['noloot']),logs:string[]=[],log=spyOn(console,'log').mockImplementation((line:string)=>{logs.push(String(line));});
 try{
  const r=await f.run();
  expect(r).toMatchObject({ok:true,kills:1,targetMet:true,accounting:true,preserved:true});
  expect(f.attacks.map(a=>a.target)).toEqual([0,0]);
  const gap=f.attacks[1]!.tick-f.attacks[0]!.tick;expect(gap).toBeGreaterThanOrEqual(12);expect(gap).toBeLessThan(50);
  const lost=logs.filter(l=>l.startsWith('RANGED_TRAIN_LOST ')).map(l=>JSON.parse(l.slice(18)));
  expect(lost).toHaveLength(1);expect(lost[0]).toMatchObject({index:0,id:41,tile:{x:3233,z:3297},xp:300,bones:0,chicken:0,appeared:[]});
  for(const [id,n] of [[526,1],[2138,1]])expect(f.assets().filter(i=>i.id===id).reduce((s,i)=>s+i.count,0)).toBe(n!);
 }finally{log.mockRestore();f.close();}
});

test('an owned bow and arrows unlocked by a kill are staged before the next target',async()=>{
 const f=trainingFixture(['kill','kill'],false,true);
 try{
  const r=await f.run({target:30});
  expect(r).toMatchObject({ok:true,trips:2,bow:849,arrow:888,accounting:true,preserved:true});
  expect(f.attacks.map(a=>a.kit.sort((a,b)=>a-b))).toEqual([[843,882],[849,888]]);
 }finally{f.close();}
});

test('a selected kit stays on its field trip while a different legacy tier unlocks',async()=>{
 const f=trainingFixture(['kill','kill'],false,true);
 try{
  const r=await f.run({target:30,kit:{bow:843,arrow:882}});
  expect(r.ok).toBe(true);expect(r.kills).toBe(2);expect(r.trips).toBe(1);expect(r.bow).toBe(843);
 }finally{f.close();}
});

test('a stronger arrow stack too small for a trip gives way to a usable weaker stack',()=>{
 const owned=[{id:884,count:2},{id:882,count:500}] as any;
 expect(chooseArrow(owned,1,1)?.id).toBe(882);
 expect(chooseArrow([{id:884,count:40},{id:882,count:500}] as any,1,1)?.id).toBe(884);
 expect(chooseArrow([{id:884,count:2}] as any,1,1)).toBeUndefined();
});

test('the practice seed starts at Ranged 70 with 3000 XP, ten chickens, to level 71',()=>{
 expect(rangedLevelXp(70)).toBe(133230);expect(rangedLevelXp(71)).toBe(142847);expect(rangedLevelXp(99)).toBe(998458);
 expect(RANGED_SEED_XP).toBe(139847);expect(RANGED_SEED_XP).toBeGreaterThanOrEqual(rangedLevelXp(70));
});

test('underground entry plans its exit before banking and uses the bounded mainland food corridor',async()=>{
 const f=trainingFixture(['kill','kill'],false,false,true,undefined,false,true);
 try{
  const r=await f.run({food:2,maxSpend:52});
  expect(r).toMatchObject({ok:true,targetMet:true,kills:2,foodBought:2,foodSpent:10,travelSpent:0,coinsSpent:10,coinDebit:10,preserved:true,accounting:true,equipmentRestored:true});
  expect(f.planner.mock.calls.map(c=>[c[0],c[1]])).toEqual([[{x:3113,z:9555,level:0},{x:3253,z:3421,level:0}]]);
  expect(Math.max(...f.planner.mock.invocationCallOrder)).toBeLessThan(f.worldRoute.mock.invocationCallOrder[0]!);
  expect(f.worldRoute).toHaveBeenCalledTimes(1);
  const paths=f.route.mock.calls.map(([,points])=>points);
  expect(paths.some(points=>points.at(-1)?.x===3015&&points.at(-1)?.z===3206)).toBe(true);
  expect(paths.some(points=>points.at(-1)?.x===3253&&points.at(-1)?.z===3421)).toBe(true);
 }finally{f.close();}
});

// Idle cause: the shop leg back to the bank waited for a fresh plan at Wydin.
test('the food run plans its return leg during the outbound walk and uses it at the shop',async()=>{
 const f=trainingFixture(['kill','kill'],true);
 try{
  const r=await f.run();expect(r).toMatchObject({ok:true,foodBought:3,travelSpent:60,accounting:true});
  expect(f.planner.mock.calls.map(c=>[c[0],c[1]])).toEqual([[{x:2807,z:3441,level:0},{x:3015,z:3206,level:0}],[{x:3015,z:3206,level:0},{x:3253,z:3421,level:0}]]);
  expect(f.planner.mock.invocationCallOrder[1]!).toBeLessThan(f.worldRoute.mock.invocationCallOrder[0]!);
  expect(f.worldRoute).toHaveBeenCalledTimes(2);
 }finally{f.close();}
});

// Idle cause: outside pen gate 1551 no chicken was selectable, and the worker waited out the 120-tick bound.
test('an empty target list outside the pen walks back to the pen entry instead of waiting out the bound',async()=>{
 const f=trainingFixture(['kill','kill']),bot=(f.s as any).bot,pickup=bot.pickupItem;let moved=false;
 bot.pickupItem=async(i:any)=>{await pickup(i);if(!moved){moved=true;const p=f.s.sdk.getState()!.player as any;p.worldX=3239;p.worldZ=3301;}};
 try{
  const r=await f.run();
  expect(r).toMatchObject({ok:true,kills:2,failure:'-',accounting:true});
  expect(f.attacks).toHaveLength(2);expect(f.attacks[1]!.tick-f.attacks[0]!.tick).toBeLessThan(120);
 }finally{f.close();}
});

test('banking recovered arrows between trips does not count as firing',async()=>{
 const f=trainingFixture(['kill','kill'],false,false,false,'foreign',true);
 try{const r=await f.run({killsPerTrip:1});expect(r).toMatchObject({ok:true,trips:2,kills:2,shots:2,picked:2,arrowsSpent:0,accounting:true});}finally{f.close();}
});

test('Kandarin recovery walks to Ardougne North bank instead of crossing White Wolf Mountain with zero coins',async()=>{
 expect(recoveryBank({worldX:2614,worldZ:3296,level:0})).toEqual({x:2619,z:3332});
 expect(recoveryBank({worldX:3185,worldZ:3436,level:0})).toEqual({x:3253,z:3421});
 const client={};setEquipmentObserved(client,true);
 const p={worldX:2614,worldZ:3296,level:0};
 const s={name:'Bigpackage',client,tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
  sdk:{getState:()=>({player:p}),getEquipment:()=>[]}} as unknown as Session;
 const world=spyOn(bot,'getWorld').mockImplementation(async()=>({} as any));
 const actor=spyOn(bot,'accountOf').mockImplementation(()=>({skills:{magic:99},items:[],coins:5000} as any));
 const go=spyOn(walking,'goTo').mockImplementation(async(_s,_w,to)=>{expect(to).toEqual({x:2619,z:3332,level:0});p.worldX=2619;p.worldZ=3332;return{ok:true} as any;});
 try{
  expect(await recoverRangedStart(s)).toEqual({from:{x:2614,z:3296,level:0},stopped:false});
  expect(go).toHaveBeenCalledTimes(1);
 }finally{go.mockRestore();world.mockRestore();actor.mockRestore();}
});

import * as shopBuyer from '../packages/workers/src/market';
import * as geBuy from '../packages/workers/src/market';
import {isRangedAcquireMethod} from './ranged-train';

test('runAdaptiveRanged acquires starter bow and arrows via shop purchases then trains cleanly',async()=>{
    expect(isRangedAcquireMethod('ranged/lowe-buy-shortbow')).toBe(true);
    expect(isRangedAcquireMethod('ranged/ge-buy-willow')).toBe(true);
    expect(isRangedAcquireMethod('ranged/chickens')).toBe(false);

    const client={};setEquipmentObserved(client,true);
    let generation=0,tick=0,bankOpen=false,shopOpen=false,rangedLvl=1,rangedXp=0;
    const p={worldX:3253,worldZ:3421,level:0};
    const listeners=new Set<()=>void>();
    const ticker=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},2);
    const pack=[{id:995,name:'Coins',count:10_000,slot:0}];
    const bank:{id:number;name:string;count:number}[]=[{id:2142,name:'Cooked meat',count:3}];
    const equipment:{id:number;name:string;count:number}[]=[];
    const skills=[{name:'Ranged',level:1,baseLevel:1,xp:0},{name:'Hitpoints',level:40,baseLevel:40,xp:xpForLevel(40)},{name:'Defence',level:1,baseLevel:1,xp:0}];
    const sdk={
        config:{browserLaunchUrl:'http://localhost:8880'},
        getState:()=>({tick,player:p,inventory:[...pack],equipment:[...equipment],shop:{isOpen:shopOpen,shopItems:shopOpen?[{id:841,name:'Shortbow',count:4},{id:882,name:'Bronze arrow',count:2000}]:[]},bank:{isOpen:bankOpen,items:[...bank]},skills:skills.map(s=>s.name==='Ranged'?{...s,level:rangedLvl,baseLevel:rangedLvl,xp:rangedXp}:s),quests:[]}),
        getInventory:()=>[...pack],
        getEquipment:()=>[...equipment],
        getSkills:()=>skills.map(s=>s.name==='Ranged'?{...s,level:rangedLvl,baseLevel:rangedLvl,xp:rangedXp}:s),
        getSkill:(name:string)=>name==='Ranged'?{level:rangedLvl,baseLevel:rangedLvl,xp:rangedXp}:skills.find(s=>s.name===name),
        getSkillXp:(name:string)=>name==='Ranged'?rangedXp:0,
    };
    const s={
        name:'StarterBot',client,sdk,tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
        lifecycle:{domain:'live'},
        bankObservation:()=>({at:Date.now(),generation,items:bank.map(i=>({id:i.id,count:i.count}))}),
        bot:{
            openBank:async()=>{bankOpen=true;shopOpen=false;generation++;tick+=2;return{success:true};},
            closeBank:async()=>{bankOpen=false;tick+=1;return{success:true};},
            openShop:async()=>{shopOpen=true;bankOpen=false;tick+=2;return{success:true};},
            openDoor:async()=>({success:true}),
            closeShop:async()=>{shopOpen=false;return{success:true};},
            withdrawItem:async(item:any,amount:number)=>{
                const idx=bank.findIndex(i=>i.id===item.id);if(idx<0)return{success:false};
                const take=Math.min(amount,bank[idx]!.count);bank[idx]!.count-=take;if(bank[idx]!.count<=0)bank.splice(idx,1);
                const held=pack.find(i=>i.id===item.id);if(held)held.count+=take;else pack.push({id:item.id,name:item.name??'Item',count:take,slot:pack.length});
                generation++;tick+=1;return{success:true};
            },
            depositItem:async(slot:any,amount:number)=>{
                const idx=pack.findIndex(i=>i.id===slot.id);if(idx<0)return{success:false};
                const take=Math.min(amount,pack[idx]!.count);pack[idx]!.count-=take;if(pack[idx]!.count<=0)pack.splice(idx,1);
                const b=bank.find(i=>i.id===slot.id);if(b)b.count+=take;else bank.push({id:slot.id,name:slot.name,count:take});
                generation++;tick+=1;return{success:true};
            },
        },
    } as unknown as Session;

    const world=spyOn(bot,'getWorld').mockResolvedValue({} as any);
    const walk=spyOn(walking,'sessionWalker').mockResolvedValue({walk:async(x:number,z:number)=>{p.worldX=x;p.worldZ=z;tick+=4;return{ok:true};}} as any);
    const go=spyOn(walking,'goTo').mockImplementation(async(_s,_w,to)=>{tick+=10;p.worldX=to.x;p.worldZ=to.z;return{ok:true} as any;});
    const buy=spyOn(shopBuyer,'buyWithBudget').mockImplementation(async(_bot,_sdk,item,_want,_res,_allow)=>{
        tick+=4;
        const coins=pack.find(i=>i.id===995)!,label=String(item);
        if(/bronze arrow/i.test(label)){coins.count-=200;pack.push({id:882,name:'Bronze arrow',count:100,slot:1});return{ok:true,bought:100,spent:200} as any;}
        if(/shortbow/i.test(label)){coins.count-=60;pack.push({id:841,name:'Shortbow',count:1,slot:2});return{ok:true,bought:1,spent:60} as any;}
        return{ok:false,bought:0,spent:0} as any;
    });
    const ge=spyOn(geBuy,'runOwnedItem');
    const actor=spyOn(combat,'runGiants').mockImplementation(async()=>{
        rangedLvl=5;rangedXp=xpForLevel(5);tick+=50;
        return{ok:true,targetMet:true,preserved:true,foodAccounted:true,selectedXp:rangedXp,ammoId:882,ammoUsed:20,finalLevel:5} as any;
    });
    try{
        // Step 1: live progression returned state=acquire selected=null with missing kit -> acquires bronze arrow + shortbow
        // via Lowe's shop, then hits state=acquire with kit already held (requires proof) rather than failing on 0 kit.
        const r=await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','StarterBot','5','3000']),coinReserve:1000,maxSpend:2000});
        expect(buy).toHaveBeenCalledTimes(2);
        expect(ge).not.toHaveBeenCalled();
        expect(bank.find(i=>i.id===882)?.count).toBe(100);
        expect(bank.find(i=>i.id===841)?.count).toBe(1);
        expect(r.coinsSpent).toBe(260);
        expect(r.segments.slice(0,2).map(seg=>seg.method)).toEqual(['ranged/lowe-buy-bronze','ranged/lowe-buy-shortbow']);
        expect(r.segments.slice(0,2).every(seg=>seg.ok)).toBe(true);
    }finally{
        clearInterval(ticker);world.mockRestore();walk.mockRestore();go.mockRestore();buy.mockRestore();ge.mockRestore();actor.mockRestore();
    }
});

import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Dargaud shop matches Bow and Arrow salesman, cross-region travelSpent reconciles, and settled GE journals increment goal key',async()=>{
    const client={};setEquipmentObserved(client,true);
    let generation=0,tick=0,bankOpen=false,shopOpen=false,rangedLvl=40;
    const p={worldX:2654,worldZ:3283,level:0};
    const listeners=new Set<()=>void>();
    const ticker=setInterval(()=>{tick++;for(const cb of [...listeners])cb();},2);
    const pack=[{id:995,name:'Coins',count:2000,slot:0}];
    const bank:{id:number;name:string;count:number}[]=[{id:995,name:'Coins',count:50_000}];
    const equipment:{id:number;name:string;count:number}[]=[];
    const baseSkills=[{name:'Ranged',level:40,baseLevel:40,xp:xpForLevel(40)},{name:'Hitpoints',level:40,baseLevel:40,xp:xpForLevel(40)},{name:'Defence',level:10,baseLevel:10,xp:xpForLevel(10)}];
    const skills=()=>baseSkills.map(k=>k.name==='Ranged'?{name:'Ranged',level:rangedLvl,baseLevel:rangedLvl,xp:xpForLevel(rangedLvl)}:k);
    const sdk={
        config:{browserLaunchUrl:'http://localhost:8880'},
        getState:()=>({tick,player:p,inventory:[...pack],equipment:[...equipment],shop:{isOpen:shopOpen,shopItems:shopOpen?[{id:849,name:'Willow shortbow',count:1}]:[]},bank:{isOpen:bankOpen,items:[...bank]},skills:skills(),quests:[]}),
        getInventory:()=>[...pack],
        getEquipment:()=>[...equipment],
        getSkills:()=>skills(),
        getSkill:(name:string)=>skills().find(s=>s.name===name),
        getSkillXp:(name:string)=>skills().find(s=>s.name===name)?.xp??0,
    };
    const openedNpcs:RegExp[]=[];
    const s={
        name:'GuildCross',client,sdk,tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
        bankObservation:()=>({at:Date.now(),generation,items:bank.map(i=>({id:i.id,count:i.count}))}),
        bot:{
            openBank:async()=>{bankOpen=true;shopOpen=false;generation++;tick+=2;return{success:true};},
            closeBank:async()=>{bankOpen=false;tick+=1;return{success:true};},
            openShop:async(re:RegExp)=>{openedNpcs.push(re);shopOpen=true;bankOpen=false;tick+=2;return{success:re.test('Bow and Arrow salesman')};},
            openDoor:async()=>({success:true}),
            closeShop:async()=>{shopOpen=false;return{success:true};},
            withdrawItem:async(item:any,amount:number)=>{
                const idx=bank.findIndex(i=>i.id===item.id);if(idx<0)return{success:false};
                const take=Math.min(amount,bank[idx]!.count);bank[idx]!.count-=take;if(bank[idx]!.count<=0)bank.splice(idx,1);
                const held=pack.find(i=>i.id===item.id);if(held)held.count+=take;else pack.push({id:item.id,name:item.name??'Item',count:take,slot:pack.length});
                generation++;tick+=1;return{success:true};
            },
            depositItem:async(slot:any,amount:number)=>{
                const idx=pack.findIndex(i=>i.id===slot.id);if(idx<0)return{success:false};
                const take=Math.min(amount,pack[idx]!.count);pack[idx]!.count-=take;if(pack[idx]!.count<=0)pack.splice(idx,1);
                const b=bank.find(i=>i.id===slot.id);if(b)b.count+=take;else bank.push({id:slot.id,name:slot.name,count:take});
                generation++;tick+=1;return{success:true};
            },
        },
    } as unknown as Session;

    const dir=mkdtempSync(join(tmpdir(),'ranged-acq-'));
    const world=spyOn(bot,'getWorld').mockResolvedValue({} as any);
    const go=spyOn(walking,'goTo').mockImplementation(async(_s,_w,to)=>{
        tick+=10;
        if(to.x===2673&&to.z===3434){const c=pack.find(i=>i.id===995);if(c)c.count-=60;}
        p.worldX=to.x;p.worldZ=to.z;return{ok:true} as any;
    });
    const buy=spyOn(shopBuyer,'buyWithBudget').mockImplementation(async()=>{
        tick+=4;pack.find(i=>i.id===995)!.count-=200;pack.push({id:849,name:'Willow shortbow',count:1,slot:1});
        rangedLvl=45;
        return{ok:true,bought:1,spent:200} as any;
    });
    const paths=spyOn(geBuy,'orderPaths').mockImplementation((_srv,_act,goal)=>({dir,journal:join(dir,`${goal}.json`),trace:join(dir,`${goal}.trace`)}) as any);
    const seenReqs:geBuy.ItemRequest[]=[];
    const ge=spyOn(geBuy,'runOwnedItem').mockImplementation(async(_s,req)=>{
        seenReqs.push(req);
        rangedLvl=45;
        return{ok:true,acquired:req.quantity,spent:req.limit} as any;
    });
    try{
        const shopDec={state:'execute' as const,selected:'ranged/guild-buy-willow',step:{script:'scripts/aio-market.ts',args:['shop-buy','dargaud'],env:{}},path:[],alternatives:[],reasons:[],reason:[],constraints:[],fingerprint:'f',expectedTicks:50,basis:'model' as const,followUps:[],gaps:[],search:{nodes:1,bound:8,depth:1,exhausted:false}};
        const shopRes=await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','GuildCross','45','3000']),coinReserve:1000,maxSpend:5000},{decision:shopDec as any});
        expect(openedNpcs.some(re=>re.test('Bow and Arrow salesman')&&!re.test('Dargaud'))).toBe(true);
        expect(shopRes.segments[0]?.ok).toBe(true);
        expect(shopRes.coinsSpent).toBe(260);

        rangedLvl=40;
        writeFileSync(join(dir,'ranged-acquire-888.json'),JSON.stringify({version:1,phase:'settled',previousIds:[],request:{actor:'GuildCross',server:'local',goal:'ranged-acquire-888',item:888,quantity:250,limit:120,reserve:1000,createdAt:1,reviewAt:2,deadline:3}}));
        const geDec={state:'execute' as const,selected:'ranged/ge-buy-mithril',step:{script:'scripts/aio-market.ts',args:['ge-buy'],env:{ITEM_ID:'888',QUANTITY:'250',LIMIT_PRICE:'120'}},path:[],alternatives:[],reasons:[],reason:[],constraints:[],fingerprint:'g',expectedTicks:50,basis:'model' as const,followUps:[],gaps:[],search:{nodes:1,bound:8,depth:1,exhausted:false}};
        await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','GuildCross','45','3000']),coinReserve:1000,maxSpend:35_000},{decision:geDec as any});
        expect(seenReqs[0]?.goal).toBe('ranged-acquire-888-1');

        rangedLvl=40;
        writeFileSync(join(dir,'ranged-acquire-853.json'),JSON.stringify({version:1,phase:'open',previousIds:[99],request:{actor:'GuildCross',server:'local',goal:'ranged-acquire-853',item:853,quantity:1,limit:4000,reserve:1000,createdAt:10,reviewAt:20,deadline:30}}));
        const openDec={state:'execute' as const,selected:'ranged/ge-buy-maple',step:{script:'scripts/aio-market.ts',args:['ge-buy'],env:{ITEM_ID:'853',QUANTITY:'1',LIMIT_PRICE:'4000'}},path:[],alternatives:[],reasons:[],reason:[],constraints:[],fingerprint:'h',expectedTicks:50,basis:'model' as const,followUps:[],gaps:[],search:{nodes:1,bound:8,depth:1,exhausted:false}};
        await runAdaptiveRanged(s,{...rangedTrainOptions({},['bun','s','GuildCross','45','3000']),coinReserve:1000,maxSpend:35_000},{decision:openDec as any});
        expect(seenReqs[1]).toMatchObject({goal:'ranged-acquire-853',createdAt:10,reviewAt:20,deadline:30});
    }finally{
        clearInterval(ticker);world.mockRestore();go.mockRestore();buy.mockRestore();paths.mockRestore();ge.mockRestore();
        rmSync(dir,{recursive:true,force:true});
    }
});
