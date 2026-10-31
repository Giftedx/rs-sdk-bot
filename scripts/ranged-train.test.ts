import {test,expect,spyOn} from 'bun:test';
import {bestBow,usableArrows,chooseArrow,buyChunk,arrowAccount,rangedTrainOptions,runRangedTrain} from './ranged-train';
import * as walking from '../packages/core/src/walk';
import type {Session} from '../packages/core/src/inprocess';
import {rangedMemoryFloor} from '../packages/practice/src/ranged-train-proof';
import {FREE_FLOOR_GB,PRACTICE_STARTUP_GB} from '../packages/core/src/memory';
test('proof holds the free-memory floor, not the start reserve that delivery admits',()=>{
 for(const free of [FREE_FLOOR_GB,PRACTICE_STARTUP_GB-0.1,PRACTICE_STARTUP_GB])expect(()=>rangedMemoryFloor(free,'before stack')).not.toThrow();
 for(const free of [FREE_FLOOR_GB-0.01,0,NaN])expect(()=>rangedMemoryFloor(free,'before child')).toThrow('practice memory floor reached before child');
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
 expect(chooseArrow([{id:884,count:10},{id:882,count:45},{id:886,count:99}],1,7)).toEqual({id:882,count:45});
 expect(chooseArrow([{id:886,count:99}],1,7)).toBeUndefined();
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

// Only travel is stubbed. The worker observes tick, XP, target, loot and bank effects.
function trainingFixture(outcomes:('lost'|'kill'|'retry'|'stalled')[]){
 type Item={id:number;name:string;count:number};
 const item=(id:number,count:number):Item=>({id,name:String(id),count});
 let tick=0,xp=0,level=7,generation=0,trip=0,active=-1,attempt=0,firstAttack=0;
 let pack:Item[]=[],equipment:Item[]=[],bank=[item(843,1),item(882,60),item(329,3)];
 const state:any={player:{worldX:3253,worldZ:3421,level:0},autoRetaliateEnabled:false,bank:{isOpen:false,items:bank},nearbyNpcs:[],groundItems:[]};
 const attacks:{target:number;trip:number;tick:number}[]=[],listeners=new Set<()=>void>();
 const add=(items:Item[],id:number,n:number)=>{const found=items.find(i=>i.id===id);if(found)found.count+=n;else items.push(item(id,n));};
 const target=()=>({index:active,id:41,x:3233,z:3297,tileX:3233,tileZ:3297,distance:1,reachable:true,inCombat:false,hp:3,maxHp:3});
 const next=()=>{active++;attempt=0;state.nearbyNpcs=active<outcomes.length?[target()]:[];};
 const kill=()=>{xp+=300;level=xp>=600||outcomes[active]==='retry'?10:8;state.nearbyNpcs=[];state.groundItems=[{...item(526,1),x:3233,z:3297,distance:0},{...item(2138,1),x:3233,z:3297,distance:0}];};
 const timer=setInterval(()=>{
  tick++;
  if(attempt===1&&tick===firstAttack+4&&['retry','stalled'].includes(outcomes[active]!))xp+=200;
  if(state.player.worldZ===3297&&!state.nearbyNpcs.length&&!state.groundItems.length)next();
  for(const cb of [...listeners])cb();
 },1);
 const s={name:'unit',tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  bankObservation:()=>({generation,items:bank}),
  sdk:{getState:()=>({...state,inventory:pack}),getInventory:()=>pack,getEquipment:()=>equipment,getSkill:(name:string)=>name==='Ranged'?{baseLevel:level,level}:{level:16},getSkillXp:()=>xp,
   sendSetCombatStyle:async()=>{state.combatStyle={known:true,currentStyle:1,styles:[{index:1,trainsSkills:['Ranged']}]};}},
  bot:{openBank:async()=>{state.bank.isOpen=true;generation++;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;},
   withdrawItem:async(i:Item,n:number)=>{i.count-=n;add(pack,i.id,n);generation++;},
   depositItem:async(i:Item)=>{add(bank,i.id,i.count);pack=pack.filter(p=>p.id!==i.id);generation++;return{success:true};},
   equipItem:async(i:Item)=>{equipment.push({...i});pack=pack.filter(p=>p.id!==i.id);},
   unequipItem:async(i:Item)=>{add(pack,i.id,i.count);equipment=equipment.filter(p=>p.id!==i.id);},
   attack:async()=>{attempt++;attacks.push({target:active,trip,tick});if(attempt===1)firstAttack=tick;
    if(outcomes[active]==='lost')state.nearbyNpcs=[];
    if(outcomes[active]==='kill'||outcomes[active]==='retry'&&attempt===4)kill();
    return{success:true};},
   pickupItem:async(i:Item)=>{add(pack,i.id,i.count);state.groundItems=state.groundItems.filter((g:Item)=>g!==i);}},
 }as unknown as Session;
 const walker=spyOn(walking,'sessionWalker').mockImplementation(async()=>({} as any));
 const route=spyOn(walking,'walkPath').mockImplementation(async(_deps,points)=>{
  const p=points.at(-1)!;state.player.worldX=p.x;state.player.worldZ=p.z;
  if(p.z===3297){trip++;if(!state.nearbyNpcs.length)next();}
  return{ok:true,ticks:0,still:0,clicks:0,repaths:0,doors:0,next:points.length};
 });
 return{s,attacks,run:()=>runRangedTrain(s,{...rangedTrainOptions({},['bun','s','unit']),maxTrips:2,buyArrows:0}),
  close:()=>{clearInterval(timer);route.mockRestore();walker.mockRestore();}};
}

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
