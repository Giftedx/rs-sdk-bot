import {beforeAll,expect,test} from 'bun:test';
import {smithRecipe,planSmithLoad,smithEffect,runSmithBatch,HAMMER} from './smith-batch';
import {smithStageRoute} from '../packages/planner/src/travel';
import {loadPathfinding} from '../packages/core/src/pathcache';
// initPathfinding() alone takes about 14 s for each process (packages/core/src/pathcache.ts). The snapshot loader makes
// the same grid first, so the call in the test returns at once.
beforeAll(async()=>{await loadPathfinding();},120_000);

test('pinned iron platebody: level 33, five bars, 3125 XP at 25x, floor-smithing column/slot',()=>{
 const r=smithRecipe(1115);
 expect(r).toEqual({product:1115,amount:1,level:33,bar:2351,bars:5,xpPerBar:250,component:1121,slot:3});
 // stat_advance takes tenths: 5 bars x 250 = 1250 = 125 XP, x25 server rate.
 expect(r.bars*r.xpPerBar/10*25).toBe(3125);expect(3*r.bars*r.xpPerBar/10*25).toBe(9375);
 expect(smithRecipe(1117)).toMatchObject({level:18,bar:2349,bars:5,component:1121,slot:3});
 expect(smithRecipe(1203)).toMatchObject({level:15,bars:1,component:1119,slot:0});
 for(const id of [HAMMER,440,2351,-1,1.5,99999])expect(()=>smithRecipe(id)).toThrow('unsupported smith recipe');
});
test('load plan keeps the bar reserve and the slot bound',()=>{
 const r=smithRecipe(1115);
 expect(planSmithLoad(r,[{id:2351,count:349}],26,3,334)).toEqual({possible:3,planned:3,targetMet:true});
 expect(planSmithLoad(r,[{id:2351,count:345}],26,3,334).planned).toBe(2);
 expect(planSmithLoad(r,[{id:2351,count:349}],12,3,334).planned).toBe(2);
});
test('an anvil effect needs the exact bar debit, one product and XP',()=>{
 const r=smithRecipe(1115);
 expect(smithEffect(r,[{id:2351,count:15}],[{id:2351,count:15}],0,0)).toBe(0);
 expect(smithEffect(r,[{id:2351,count:15}],[{id:2351,count:10},{id:1115,count:1}],0,3125)).toBe(1);
 expect(()=>smithEffect(r,[{id:2351,count:15}],[{id:2351,count:10}],0,3125)).toThrow();
 expect(()=>smithEffect(r,[{id:2351,count:15}],[{id:2351,count:10},{id:1115,count:1}],0,0)).toThrow();
 expect(()=>smithEffect(r,[{id:2351,count:15}],[{id:2351,count:5},{id:1115,count:2}],0,6250)).toThrow();
});
test('Al Kharid staging reverses the toll corridor to the Varrock West bank',()=>{
 const route=smithStageRoute({worldX:3269,worldZ:3166,level:0});
 expect(route).toMatchObject({name:'al-kharid-toll',fare:10});
 expect(route.toll.at(-1)).toEqual({x:3272,z:3227});
 expect(route.points[0]).toEqual({x:3262,z:3232});expect(route.points.at(-1)).toEqual({x:3185,z:3436});
 expect(smithStageRoute({worldX:3185,worldZ:3436,level:0})).toMatchObject({fare:0,points:[],toll:[]});
 expect(()=>smithStageRoute({worldX:3222,worldZ:3218,level:0})).toThrow();
 expect(()=>smithStageRoute({worldX:3269,worldZ:3167,level:1})).toThrow();
});

const NAMES:Record<number,string>={995:'Coins',2351:'Iron bar',2349:'Bronze bar',1115:'Iron platebody',2347:'Hammer',440:'Iron ore',946:'Knife',820:'Iron dart tip',3095:'Bronze claws'};
function fake(o:{bank?:{id:number;count:number}[];pack?:{id:number;count:number}[];level?:number;at?:[number,number];effect?:boolean;product?:number;questColour?:number}={}){
 const recipe=smithRecipe(o.product??1115);
 let tick=0,generation=1,xp=369042,open=false,iface=false,dialog:any=null;
 const held:{id:number;name:string;count:number;slot:number}[]=[];
 const bank=(o.bank??[{id:2351,count:349},{id:2349,count:1641},{id:HAMMER,count:1},{id:995,count:396828},{id:440,count:1}]).map(i=>({...i,name:NAMES[i.id]!}));
 const listeners=new Set<()=>void>(),player={worldX:o.at?.[0]??3269,worldZ:o.at?.[1]??3166,level:0,lifeId:1,respawnCount:0};
 const count=(id:number)=>held.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const reslot=()=>held.forEach((v,n)=>v.slot=n);
 const add=(id:number,n:number)=>{const stack=(id===995||id===820)&&held.find(i=>i.id===id);if(stack){stack.count+=n;return;}if(id===995||id===820){held.push({id,name:NAMES[id]!,count:n,slot:0});reslot();return;}for(let a=0;a<n;a++)held.push({id,name:NAMES[id]!,count:1,slot:0});reslot();};
 const take=(id:number,n:number)=>{if(id===995||id===820){held.find(i=>i.id===id)!.count-=n;if(!count(id))held.splice(held.findIndex(i=>i.id===id),1);reslot();return;}for(let a=0;a<n;a++){const at=held.findIndex(i=>i.id===id);if(at<0)throw Error('mock input short');held.splice(at,1);}reslot();};
 for(const i of o.pack??[{id:995,count:7340}])add(i.id,i.count);
 const levelOf=()=>o.level??84;
 const state=()=>({tick,player,inventory:held,equipment:[],gameMessages:[],bank:{isOpen:open,items:bank},interface:{isOpen:iface,interfaceId:iface?994:-1,options:[]},
  skills:[{name:'Hitpoints',level:35,baseLevel:35},{name:'Smithing',level:levelOf(),baseLevel:levelOf(),experience:xp}]});
 const s:any={name:'fixture',client:{ingame:true,ifType:()=>({colour:o.questColour??0xff0000})},tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),
  direct:async()=>{dialog=null;iface=false;return{success:true};},
  bankObservation:()=>open?{generation,at:Date.now(),items:bank.map(i=>({...i}))}:null,
  sdk:{getState:state,getInventory:()=>held,getEquipment:()=>[],getDialog:()=>dialog,getSkill:(k:string)=>state().skills.find(v=>v.name===k),getSkillXp:()=>xp,
   findNearbyLoc:()=>({id:2783,x:3188,z:3421}),
   getNearbyNpcs:()=>[{id:926,index:7,distance:2}],
   sendInteractNpc:async()=>{dialog={isOpen:true,isWaiting:false,options:[{text:"No thank you, I'll walk around.",index:1},{text:'Yes, ok.',index:3}]};return{success:true};},
   clickDialogByText:async()=>{take(995,10);dialog=null;player.worldX=3267;player.worldZ=3227;return{success:true};},
   sendClickDialog:async()=>{dialog=null;return{success:true};},
   sendUseItemOnLoc:async()=>{if(count(HAMMER))iface=true;return{success:true};},
   sendClickComponentWithOption:async(component:number,option:number,slot:number)=>{
    expect([component,option,slot]).toEqual([recipe.component,1,recipe.slot]);iface=false;
    if(o.effect!==false){take(recipe.bar,recipe.bars);add(recipe.product,recipe.amount);xp+=recipe.bars*recipe.xpPerBar/10*25;}return{success:true};
   }},
  bot:{openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
   depositItem:async(item:{id:number})=>{const n=count(item.id);take(item.id,n);const row=bank.find(i=>i.id===item.id);if(row)row.count+=n;else bank.push({id:item.id,name:NAMES[item.id]!,count:n});generation++;return{success:true};},
   withdrawItem:async(item:{id:number},n:number)=>{const row=bank.find(i=>i.id===item.id)!;row.count-=n;add(item.id,n);generation++;return{success:true};}}};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);
 const walks:number[][]=[];
 return {s,bank,held:()=>held,walks,stop:()=>clearInterval(timer),walk:async(x:number,z:number)=>{walks.push([x,z]);player.worldX=x;player.worldZ=z;return true;}};
}
const ORDER={product:1115,cap:1600,maximum:3,reserve:334};
test('native claws resolve separate interface and darts retain their quest-gated column',()=>{expect(smithRecipe(3095)).toMatchObject({bar:2349,bars:2,amount:1,component:8430,slot:0,quest:'Death Plateau'});expect(smithRecipe(820)).toMatchObject({bar:2351,bars:1,amount:10,component:1123,slot:0,quest:'The Tourist Trap'});});
test('gated smithing refuses unknown and incomplete quest flags before bank or input',async()=>{for(const product of [820,3095])for(const questColour of [0xff0000,0xf80000,0xf8f800]){const g=fake({product,questColour,at:[3185,3436]});try{const r=await runSmithBatch(g.s,{...ORDER,product,maximum:1,reserve:0},{walk:g.walk});expect(r).toMatchObject({ok:false,made:0,attempts:0,stop:'refused'});expect(r.failure).toContain('quest');expect(g.walks).toEqual([]);expect(g.bank.find(i=>i.id===2351)?.count).toBe(349);}finally{g.stop();}}});
test('completed quest flags enable native dart tips and claws with conserved bars and outputs',async()=>{for(const product of [820,3095]){const r=smithRecipe(product),g=fake({product,questColour:0x00f800,at:[3185,3436]});try{const result=await runSmithBatch(g.s,{...ORDER,product,maximum:1,reserve:0},{walk:g.walk});expect(result).toMatchObject({ok:true,made:1,banked:r.amount,conserved:true,coinsSpent:0,baseXpPerProduct:r.bars*r.xpPerBar/10});}finally{g.stop();}}});
test('explicit native dart admission credits its one intended product or stops after one unpaid refusal',async()=>{for(const effect of [true,false]){const g=fake({product:820,questColour:0xf8f800,at:[3185,3436],effect});try{const r=await runSmithBatch(g.s,{...ORDER,product:820,maximum:1,reserve:0,allowNativeQuestProbe:true},{walk:g.walk});expect(r).toMatchObject({ok:effect,made:effect?1:0,banked:effect?10:0,attempts:1,conserved:true});if(!effect)expect(r.failure).toContain('native dart admission');}finally{g.stop();}}});

test('Al Kharid entry pays the east toll, smiths three platebodies and banks them with assets reconciled',async()=>{
 const g=fake();
 try{const r=await runSmithBatch(g.s,ORDER,{walk:g.walk});
  expect(r).toMatchObject({ok:true,made:3,banked:3,entry:'al-kharid-toll',coinsSpent:10,initialCoins:404168,finalCoins:404158,initialBars:349,finalBars:334,
   xpGain:9375,baseXpPerProduct:125,preserved:true,conserved:true,hammerRetained:true,reserveMet:true,stop:'target',failure:''});
  expect(g.walks).toContainEqual([3272,3227]);expect(g.walks).toContainEqual([3308,3370]);expect(g.walks).toContainEqual([3189,3422]);expect(g.walks.at(-1)).toEqual([3185,3436]);
  expect(g.bank.find(i=>i.id===1115)?.count).toBe(3);expect(g.bank.find(i=>i.id===HAMMER)?.count).toBe(1);
  expect(g.held().map(i=>i.id)).toEqual([995]);
 }finally{g.stop();}
});
test('insufficient level refuses at the starting bank before travel or withdrawal',async()=>{
 const g=fake({level:30});
 try{const r=await runSmithBatch(g.s,ORDER,{walk:g.walk});
  // No bank observation: the proof's refusal case relies on these ledger values.
  expect(r).toMatchObject({ok:false,made:0,attempts:0,coinsSpent:0,stop:'refused',banked:null,initialCoins:0,finalCoins:0,finalBars:0,hammerRetained:false,xpGain:0,reserve:334,product:1115,target:3,action:'smith'});
  expect(r.failure).toBe('smith refused: Smithing 30 is below level 33 for product 1115');
  expect(g.walks).toEqual([]);expect(g.bank.find(i=>i.id===2351)?.count).toBe(349);
 }finally{g.stop();}
});
test('bars short of the order plus reserve, a missing hammer or an unknown start refuse without travel',async()=>{
 for(const [setup,text] of [
  [{bank:[{id:2351,count:348},{id:HAMMER,count:1},{id:995,count:100}]},'cannot cover 3x5 plus reserve 334'],
  [{bank:[{id:2351,count:349},{id:995,count:100}]},'no hammer'],
  [{at:[3222,3218] as [number,number]},'requires Al Kharid'],
  [{pack:[],bank:[{id:2351,count:349},{id:HAMMER,count:1},{id:995,count:9}]},'needs 10 coins'],
 ] as const){
  const g=fake(setup as any);
  try{const r=await runSmithBatch(g.s,ORDER,{walk:g.walk});
   expect(r.ok).toBe(false);expect(r.stop).toBe('refused');expect(r.failure).toContain(text);expect(g.walks).toEqual([]);expect(r.conserved===null||r.conserved).toBe(true);
  }finally{g.stop();}
 }
});
test('accepted no-effect anvil clicks stop after three tries and return bars and hammer to the bank',async()=>{
 const g=fake({at:[3185,3436],effect:false});
 try{const r=await runSmithBatch(g.s,ORDER,{walk:g.walk});
  expect(r).toMatchObject({ok:false,made:0,banked:0,attempts:3,entry:'varrock-west-bank',coinsSpent:0,conserved:true,preserved:true,hammerRetained:true});
  expect(r.failure).toContain('bounded attempts');expect(g.held().map(i=>i.id)).toEqual([995]);expect(g.bank.find(i=>i.id===2351)?.count).toBe(349);
 }finally{g.stop();}
});
test('a stop request after one product banks the partial output and fails the exact order',async()=>{
 const g=fake({at:[3185,3436]});let stop=false;const click=g.s.sdk.sendClickComponentWithOption;
 g.s.sdk.sendClickComponentWithOption=async(...a:[number,number,number])=>{const r=await click(...a);stop=true;return r;};
 try{const r=await runSmithBatch(g.s,{...ORDER,stop:()=>stop},{walk:g.walk});
  expect(r).toMatchObject({ok:false,made:1,banked:1,finalBars:344,conserved:true,hammerRetained:true});expect(g.held().map(i=>i.id)).toEqual([995]);
 }finally{g.stop();}
});
test('a failed staging leg retries once, then fails without a cross-map cleanup walk',async()=>{
 const g=fake();const recovered:number[][]=[];
 try{const r=await runSmithBatch(g.s,ORDER,{walk:async(x,z)=>{if(x===3262&&z===3250)return false;return g.walk(x,z);},recover:async(x,z)=>{recovered.push([x,z]);return false;}});
  expect(recovered).toEqual([[3262,3250]]);expect(r).toMatchObject({ok:false,made:0,banked:null,coinsSpent:10,conserved:true});expect(r.failure).toContain('corridor incomplete at 3262,3250');
  expect(g.walks).not.toContainEqual([3185,3436]);
 }finally{g.stop();}
});
test('every staging leg plans to within one tile on the pinned collision map',async()=>{
 const pf:any=await import('../vendor/rs-sdk/sdk/pathfinding');
 pf.initPathfinding();
 const d8=(a:{x:number;z:number},b:{x:number;z:number})=>Math.max(Math.abs(a.x-b.x),Math.abs(a.z-b.z));
 const ak=smithStageRoute({worldX:3269,worldZ:3167,level:0}),ve=smithStageRoute({worldX:3253,worldZ:3420,level:0});
 const chains=[
  [{x:3269,z:3167},...ak.toll],
  [{x:3267,z:3227},...ak.points,{x:3189,z:3422},{x:3185,z:3436}],
  [{x:3253,z:3420},...ve.points],
 ];
 for(const chain of chains){let at=chain[0]!;for(const goal of chain.slice(1)){
  const end=pf.findLongPath(0,at.x,at.z,goal.x,goal.z,500).at(-1)??at;
  expect({goal,near:d8(end,goal)<=1}).toEqual({goal,near:true});at={x:end.x,z:end.z};
 }}
},60000);
