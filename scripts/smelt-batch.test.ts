import {expect,test} from 'bun:test';
import {smeltRecipe,planSmeltLoad,smeltEffect,runSmeltBatch} from './smelt-batch';

test('pinned recipes and short stock produce feasible reserved loads, including mithril',()=>{
 const steel=smeltRecipe('steel');expect(steel.ingredients).toEqual([{id:440,units:1},{id:453,units:2}]);
 expect(planSmeltLoad(steel,[{id:440,count:20},{id:453,count:9}],25,10,{453:1})).toEqual({possible:4,planned:4,targetMet:false});
 const mithril=smeltRecipe('mithril');expect(mithril.product).toBe(2359);expect(mithril.ingredients).toEqual([{id:447,units:1},{id:453,units:4}]);
 expect(planSmeltLoad(steel,[{id:440,count:20}],28,10,{}).planned).toBe(0);
});
test('iron loss is an ore debit, not a bar or XP gain; wrong/missing secondary debits fail',()=>{
 const iron=smeltRecipe('iron'),steel=smeltRecipe('steel');
 expect(smeltEffect(iron,[{id:440,count:2}],[{id:440,count:1}],0,0)).toEqual({kind:'loss',made:0});
 expect(smeltEffect(steel,[{id:440,count:2},{id:453,count:4}],[{id:440,count:1},{id:453,count:2},{id:2353,count:1}],0,100)).toEqual({kind:'made',made:1});
 expect(()=>smeltEffect(steel,[{id:440,count:2},{id:453,count:4}],[{id:440,count:1},{id:453,count:4},{id:2353,count:1}],0,100)).toThrow();
});

function fake(bar='steel',stock=[{id:440,count:3},{id:453,count:6}],losses=0){
 const recipe=smeltRecipe(bar),names:Record<number,string>={995:'Coins',440:'Iron ore',453:'Coal',2353:'Steel bar',2351:'Iron bar',447:'Mithril ore',2359:'Mithril bar',946:'Knife'};
 let tick=0,generation=1,xp=0,open=false,held:{id:number;name:string;count:number;slot:number}[]=[{id:946,name:'Knife',count:1,slot:0}];
 const messages:{text:string;tick:number;observationId:number}[]=[];
 const bank=stock.map(i=>({...i,name:names[i.id]!})),listeners=new Set<()=>void>();
 const player={worldX:3269,worldZ:3167,level:0,lifeId:1,respawnCount:0};
 const count=(id:number)=>held.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0);
 const add=(id:number,n:number)=>{for(let a=0;a<n;a++)held.push({id,name:names[id]!,count:1,slot:held.length});};
 const take=(id:number,n:number)=>{for(let a=0;a<n;a++){const at=held.findIndex(i=>i.id===id);if(at<0)throw Error('mock input short');held.splice(at,1);}held.forEach((v,n)=>v.slot=n);};
 const state=()=>({player,inventory:held,equipment:[],gameMessages:messages,bank:{isOpen:open,items:bank},skills:[{name:'Hitpoints',level:30,baseLevel:30},{name:'Smithing',level:99,baseLevel:99,experience:xp}]});
 const s:any={name:'fixture',direct:async()=>{s.sdk.getDialog=()=>null;return{success:true};},sdk:{getState:state,getInventory:()=>held,getEquipment:()=>[],getDialog:()=>null,getSkill:(k:string)=>state().skills.find(v=>v.name===k),getSkillXp:()=>xp,findNearbyLoc:()=>({id:2781,x:3274,z:3186}),sendUseItemOnLoc:async()=>{
  for(const i of recipe.ingredients)take(i.id,i.units);if(losses>0){losses--;messages.push({text:'The ore is too impure and you fail to refine it.',tick,observationId:messages.length+1});}else{add(recipe.product,1);xp+=100;}return{success:true};
 }},tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},bankObservation:()=>open?{generation,at:Date.now(),items:bank.map(i=>({...i}))}:null,
 bot:{openBank:async()=>{open=true;generation++;return{success:true}},closeBank:async()=>{open=false;return{success:true}},depositItem:async(item:{id:number})=>{const n=count(item.id);take(item.id,n);const row=bank.find(i=>i.id===item.id);if(row)row.count+=n;else bank.push({id:item.id,name:names[item.id]!,count:n});generation++;return{success:true}},withdrawItem:async(item:{id:number},n:number)=>{const row=bank.find(i=>i.id===item.id)!;row.count-=n;add(item.id,n);generation++;return{success:true}}},ended:new Promise(()=>{})};
 const timer=setInterval(()=>{tick++;for(const f of listeners)f();},1);
 return {s,bank,held:()=>held,stop:()=>clearInterval(timer),walk:async(x:number,z:number)=>{player.worldX=x;player.worldZ=z;return true;}};
}

test('a level-up continue yields to incoming ticks before another furnace action',async()=>{
 const g=fake(),use=g.s.sdk.sendUseItemOnLoc;let dialog=false,clicked=false,clicks=0,waitingTicks=0;
 g.s.sdk.sendUseItemOnLoc=async()=>{const r=await use();dialog=true;return r;};
 g.s.sdk.getDialog=()=>dialog?{isOpen:true,isWaiting:clicked,options:[{index:0,text:'Click here to continue'}]}:null;
 g.s.sdk.sendClickDialog=async()=>{if(clicked)throw Error('dialog clicked twice before incoming tick');clicked=true;clicks++;return{success:true};};
 const off=g.s.onTick(()=>{if(clicked&&++waitingTicks>=2){dialog=false;clicked=false;waitingTicks=0;}});
 try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:3,reserve:0,mode:'exact'},{walk:g.walk});expect(r).toMatchObject({ok:true,made:3,banked:3});expect(clicks).toBe(2);}finally{off();g.stop();}
});

test('Varrock entry pays the observed toll and includes travel in asset reconciliation',async()=>{
 const g=fake('iron',[{id:440,count:30},{id:995,count:24}],2);
 const p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 let dialog=false,paid=false;
 g.s.sdk.getNearbyNpcs=()=>[{id:925,index:1,distance:1}];
 g.s.sdk.sendInteractNpc=async()=>{dialog=true;return{success:true};};
 g.s.sdk.getDialog=()=>dialog?{isOpen:true,isWaiting:false,options:[{text:'Yes, ok.',index:3}]}:null;
 g.s.sdk.clickDialogByText=async()=>{const coins=g.held().filter(i=>i.id===995);expect(coins.length).toBe(10);for(const coin of coins)g.held().splice(g.held().indexOf(coin),1);dialog=false;paid=true;p.worldX=3268;p.worldZ=3227;return{success:true};};
 const points:number[][]=[];
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:500,maximum:6,reserve:1,mode:'exact'},{walk:async(x,z)=>{points.push([x,z]);return g.walk(x,z);}});
  expect(r).toMatchObject({ok:true,made:6,banked:6,consumedOre:8,losses:2,coinsSpent:10,initialCoins:24,finalCoins:14,conserved:true,entry:'varrock-east-toll'});
  expect(paid).toBe(true);expect(points).toContainEqual([3295,3370]);expect(points).toContainEqual([3266,3227]);
 }finally{g.stop();}
});

test('limited iron keeps reserve and banks partial output without an exact pass',async()=>{
 const g=fake('iron',[{id:440,count:3}],1);try{
  expect(await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:g.walk})).toMatchObject({ok:false,made:1,banked:1,losses:1,consumedOre:2,reserveMet:true,conserved:true});
 }finally{g.stop();}
});

test('an interrupted batch returns unspent ore and output to bank',async()=>{
 const g=fake('iron',[{id:440,count:30}]);let stopped=false;const use=g.s.sdk.sendUseItemOnLoc;
 g.s.sdk.sendUseItemOnLoc=async()=>{const r=await use();stopped=true;return r;};
 try{expect(await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact',stop:()=>stopped},{walk:g.walk})).toMatchObject({ok:false,made:1,banked:1,conserved:true,reserveMet:true});expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});

test('unfunded entry fails at the observed starting bank before travel or smelting',async()=>{
 const g=fake('iron',[{id:440,count:30}]),p=g.s.sdk.getState().player;p.worldX=3252;p.worldZ=3420;
 let walks=0;
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:async()=>{walks++;return true;}});
  expect(r.ok).toBe(false);expect(r.failure).toContain('10 coins');expect(r.attempts).toBe(0);expect(walks).toBe(0);expect(r.conserved).toBe(true);
 }finally{g.stop();}
});

test('successful travel acknowledgement without arrival cannot dispatch furnace work',async()=>{
 const g=fake('iron',[{id:440,count:30}]);
 try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:6,reserve:1,mode:'exact'},{walk:async()=>true});
  expect(r.ok).toBe(false);expect(r.attempts).toBe(0);expect(r.failure).toContain('furnace route incomplete');expect(g.held().map(i=>i.id)).toEqual([946]);expect(r.conserved).toBe(true);
 }finally{g.stop();}
});
test('real worker banks a partial feasible steel batch and leaves protected kit/reserves intact',async()=>{
 const g=fake();try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:4,reserve:0,mode:'best-effort'},{walk:g.walk});expect(r).toMatchObject({ok:true,made:3,banked:3,consumedOre:3,losses:0,stop:'depleted',preserved:true,conserved:true});expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});
test('iron impurity losses cannot manufacture target completion',async()=>{
 const g=fake('iron',[{id:440,count:3}],2);try{const r=await runSmeltBatch(g.s,{bar:'iron',cap:200,maximum:3,reserve:0,mode:'exact'},{walk:g.walk});expect(r).toMatchObject({ok:false,made:1,banked:1,consumedOre:3,losses:2,stop:'depleted',conserved:true});}finally{g.stop();}
});
test('mithril reaches the real worker recipe path instead of an empty withdrawal branch',async()=>{
 const g=fake('mithril',[{id:447,count:3},{id:453,count:9}]);try{
  const r=await runSmeltBatch(g.s,{bar:'mithril',cap:200,maximum:2,reserve:1,mode:'exact'},{walk:g.walk});
  expect(r).toMatchObject({ok:true,made:2,banked:2,consumedOre:2,stop:'target',reserveMet:true,conserved:true});
  expect(g.bank.find(i=>i.id===453)?.count).toBe(1);
 }finally{g.stop();}
});
test('missing secondary stock stops before furnace input; unready bank is not depletion',async()=>{
 const g=fake('steel',[{id:440,count:5}]);try{
  expect(await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk})).toMatchObject({ok:false,attempts:0,made:0,stop:'depleted',conserved:true});
 }finally{g.stop();}
 const unready=fake();unready.s.bankObservation=()=>null;try{
  const r=await runSmeltBatch(unready.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:unready.walk});
  expect(r.ok).toBe(false);expect(r.failure).toContain('observation unready');expect(r.stop).not.toBe('depleted');
 }finally{unready.stop();}
});
test('accepted no-effect furnace calls stop after three attempts and return all held inputs',async()=>{
 const g=fake();g.s.sdk.sendUseItemOnLoc=async()=>({success:true});try{
  const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk});
  expect(r).toMatchObject({ok:false,attempts:3,made:0,banked:0,preserved:true,conserved:true});expect(r.failure).toContain('bounded attempts');expect(g.held().map(i=>i.id)).toEqual([946]);
 }finally{g.stop();}
});
test('false-success withdrawal cannot start work and its earlier inputs return to bank',async()=>{
 const g=fake(),withdraw=g.s.bot.withdrawItem;g.s.bot.withdrawItem=async(i:{id:number},n:number)=>i.id===453?{success:true}:withdraw(i,n);
 try{const r=await runSmeltBatch(g.s,{bar:'steel',cap:200,maximum:2,reserve:0,mode:'best-effort'},{walk:g.walk});expect(r).toMatchObject({ok:false,attempts:0,conserved:true,preserved:true});expect(r.failure).toContain('withdrawal unobserved 453');expect(g.held().map(i=>i.id)).toEqual([946]);}finally{g.stop();}
});
