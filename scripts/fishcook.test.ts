import { expect, test, spyOn } from 'bun:test';
import * as walking from '../packages/core/src/walk';
import * as ticks from '../packages/core/src/ticks';
import { fundFishingTool, buyFishingSupplies, cookCourierReady, cookStarterChickens, finiteFoodProfile, finiteFoodWork, finiteFoodCanCatch, finiteFoodEntryPosition } from './fishcook';
function account(bankCoins = 25, coins = 0, rod = false) {
    const inventory: any[] = [{ name: 'Coins', count: coins }, ...(rod ? [{ name: 'Fly fishing rod', count: 1 }] : [])];
    let withdrew = 0;
    const session = { sdk: {
        getInventory: () => inventory,
        getState: () => ({ inventory }),
        findBankItem: () => bankCoins ? { name: 'Coins', count: bankCoins } : undefined,
    }, bot: { withdrawItem: async (_item: any, amount: number) => { withdrew += amount; bankCoins -= amount; inventory[0].count += amount; return { success: true }; } } } as any;
    return { session, held: () => inventory[0].count, bank: () => bankCoins, withdrew: () => withdrew };
}
test('a staged new fisher uses its banked starter coins for the missing fly rod', async () => {
    const a = account();
    await fundFishingTool(a.session);
    expect(a.held()).toBe(25);
    expect(a.bank()).toBe(0);
});
test('Gerrant supplies the rod before feathers spend the starter budget', async () => {
    const inventory: any[] = [{name:'Coins', count:25}];
    const calls: string[] = [];
    const s: any = { sdk: {getState:()=>({inventory})}, bot:{buyFromShop:async (pattern:RegExp,n:number)=>{
        const rod=pattern.test('Fly fishing rod'), price=rod?5:2;
        const bought=Math.min(n,Math.floor(inventory[0].count/price));
        calls.push(rod?'rod':'feathers'); inventory[0].count-=bought*price;
        if(bought)inventory.push({name:rod?'Fly fishing rod':'Feather',count:bought});
        return {success:bought>0};
    }}};
    await buyFishingSupplies(s,1000);
    expect(calls).toEqual(['rod','feathers']);
    expect(inventory.find(i=>i.name==='Fly fishing rod')?.count).toBe(1);
    expect(inventory.find(i=>i.name==='Feather')?.count).toBe(10);
});
test('tool funding preserves bank coins when the rod or enough cash is already held', async () => {
    for (const a of [account(25, 0, true), account(25, 10)]) {
        await fundFishingTool(a.session);
        expect(a.withdrew()).toBe(0);
        expect(a.bank()).toBe(25);
    }
    const empty = account(0);
    await fundFishingTool(empty.session);
    expect(empty.held()).toBe(0);
    expect(empty.withdrew()).toBe(0);
});
test('a fisher that spent its coins can sell its own banked net catch to recover a rod', async () => {
    const inventory:any[]=[{name:'Coins',count:1}];
    let bankFish=13,noted=false;
    const s:any={sdk:{getState:()=>({inventory}),findBankItem:(re:RegExp)=>re.test('Raw shrimps')&&bankFish?{name:'Raw shrimps',count:bankFish}:undefined},
        bot:{withdrawItem:async(i:any,n:number,o:any)=>{noted=o?.asNote===true;bankFish-=n;inventory.push({name:i.name,count:n});return{success:true};}}};
    await fundFishingTool(s);
    expect(bankFish).toBe(0);
    expect(noted).toBe(true);
    expect(inventory.find(i=>i.name==='Raw shrimps')?.count).toBe(13);
});

test('only the named cook responds to a targeted live collection at Draynor',()=>{
    const now=100000,s={name:'Courier',server:'rs-sdk-demo.fly.dev',at:now,result:'',pos:{x:3092,z:3243,level:0},phase:'collecting Second'};
    expect(cookCourierReady(s,'Courier','Second',now,true)).toBe(true);
    expect(cookCourierReady(s,'Courier','First',now,true)).toBe(false);
    expect(cookCourierReady({...s,phase:'draynor 274'},'Courier','Second',now,true)).toBe(false);
    expect(cookCourierReady({...s,phase:'draynor 274'},'Courier','Second',now,false)).toBe(true);
    for(const patch of [{name:'Foreign'},{at:now-30000},{at:now+1},{result:'ok done'},{server:'localhost:8888'},{pos:{x:3092,z:3243,level:1}},{pos:{x:3230,z:3254,level:0}}])
        expect(cookCourierReady({...s,...patch},'Courier','Second',now,true)).toBe(false);
});


test('bootstrap food refuses missing raw input before travel or cooking',async()=>{
 const s:any={tick:()=>0,sdk:{getState:()=>({inventory:[]}),getInventory:()=>[],getSkillXp:()=>0}};
 await expect(cookStarterChickens(s)).rejects.toThrow('train chickens and collect raw chicken2138');
});

// Source-model tests. No game client, accounts or services start.
async function starterCookingModel(mode:string,run:(s:any,model:any)=>Promise<void>,stock={raw:2,cooked:0,burnt:0}){
 let tick=0,xp=0,due=0,started=0,actions=0,direct=0;
 const listeners=new Set<()=>void>(),logs:string[]=[];
 const state:any={inventory:[],player:{worldX:3213,worldZ:3249,level:0,animId:-1},dialog:{isOpen:false},
  interface:{isOpen:false},gameMessages:[],nearbyLocs:[{id:2724,name:'Fireplace',x:3214,z:3249,distance:1}]};
 const sync=()=>{state.inventory=[...Array.from({length:stock.raw},(_,slot)=>({id:2138,name:'Raw chicken',count:1,slot})),
  {id:2140,name:'Cooked chicken',count:stock.cooked,slot:20},{id:2144,name:'Burnt chicken',count:stock.burnt,slot:21}];};sync();
 const dispatch=()=>{actions++;started=tick+12;due=started+2;return{success:true,phase:'dispatch'};};
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},
  sdk:{getState:()=>state,getInventory:()=>state.inventory,getDialog:()=>state.dialog,getSkillXp:()=>xp,
   sendUseItemOnLoc:async()=>{if(mode==='rejected'){actions++;return{success:false,reason:'client_rejected',message:'rejected test action'};}return dispatch();}},
  direct:async()=>{direct++;return dispatch();},bot:{dismissBlockingUI:async()=>{},useItemOnLoc:async(item:any,fire:any)=>{
   expect(item.id).toBe(2138);expect(fire).toMatchObject({id:2724,x:3214,z:3249});
   if(mode==='pre-dispatch')await new Promise<void>(resolve=>{const off=s.onTick(()=>{off();resolve();});});
   const reply=await s.sdk.sendUseItemOnLoc(item.slot,fire.x,fire.z,fire.id);
   if(!reply.success)return{success:false,message:reply.message};
   await new Promise<void>(resolve=>{const off=s.onTick(()=>{if(tick>=started){off();resolve();}});});
   return{success:true,message:'interaction observed'};
  }}};
 const spies=[spyOn(walking,'sessionWalker').mockResolvedValue({} as any),spyOn(walking,'walkPath').mockResolvedValue({ok:true} as any),
  spyOn(console,'log').mockImplementation((...args:any[])=>{logs.push(args.join(' '));})];
 if(mode==='observation-error')spies.push(spyOn(ticks,'waitUntil').mockRejectedValue(Error('tick stream lost')) as any);
 const timer=setInterval(()=>{tick++;if(tick===started)state.player.animId=897;
  if(tick===due&&!['stalled','cancelled'].includes(mode)){
   stock.raw--;if(mode==='lost-output'){}else if(['burnt','late-burnt'].includes(mode)){stock.burnt++;}else{stock.cooked++;if(!['missing-xp','delayed-xp'].includes(mode))xp+=mode==='late-cooked'?750:30;}
   state.gameMessages.push({tick,text:mode==='burnt'?'You accidentally burn the chicken.':'The chicken is now nicely cooked.'});sync();
  }
  if(mode==='delayed-xp'&&tick===due+1)xp+=30;
  for(const cb of [...listeners])cb();
 },1);
 const originalSend=s.sdk.sendUseItemOnLoc;
 try{await run(s,{stock,logs,tick:()=>tick,actions:()=>actions,direct:()=>direct,listeners});}
 finally{expect(s.sdk.sendUseItemOnLoc).toBe(originalSend);expect(listeners.size).toBe(0);clearInterval(timer);for(const spy of spies)spy.mockRestore();}
}
test('bootstrap observes interaction before its conversion deadline; delayed cooking is counted once',async()=>{
 await starterCookingModel('cooked',async(s,m)=>{
  const r=await cookStarterChickens(s);expect(r).toMatchObject({ok:true,raw:2,consumed:2,cooked:2,burnt:0,xp:60,remainingRaw:0});
  expect(m.tick()).toBeGreaterThan(8);expect(m.actions()).toBe(2);expect(m.direct()).toBe(0);
  expect(m.logs.some((l:string)=>l.includes('interaction observed')&&l.includes('2724'))).toBe(true);
 });
});
for(const mode of ['late-cooked','late-burnt'])test(`accepted cooking settles after stop before the owner snapshots and logs out: ${mode}`,async()=>{
 await starterCookingModel(mode,async(s,m)=>{
  let failure='';
  try{await cookStarterChickens(s,()=>m.tick()>=13);}catch(error){failure=String(error);}
  expect(failure).toContain('stopped');
  const final={...m.stock,xp:s.sdk.getSkillXp('Cooking')};
  // The owner may now log out. No helper owns cleanup, and no second use was sent.
  expect(final).toEqual({raw:9,cooked:mode==='late-cooked'?1:0,burnt:mode==='late-burnt'?1:0,xp:mode==='late-cooked'?750:0});
  expect(m.actions()).toBe(1);expect(m.tick()).toBe(14);
  if(mode==='late-cooked'){
   const resumed=await cookStarterChickens(s,()=>false,{requiredFood:3});
   expect(resumed).toMatchObject({ok:true,raw:9,consumed:9,cooked:9,burnt:0,xp:6750,remainingRaw:0});
   expect(m.stock).toEqual({raw:0,cooked:10,burnt:0});expect(s.sdk.getSkillXp('Cooking')).toBe(7500);
  }
 },{raw:10,cooked:0,burnt:0});
});
test('loss of observation after an accepted use remains explicitly unresolved',async()=>{
 await starterCookingModel('observation-error',async(s,m)=>{
  await expect(cookStarterChickens(s)).rejects.toThrow('settlement unresolved: observation failed: Error: tick stream lost');
  expect(m.actions()).toBe(1);
 });
});
test('bootstrap preserves explicit rejected action and boundary observations without retry',async()=>{
 await starterCookingModel('rejected',async(s,m)=>{
  await expect(cookStarterChickens(s)).rejects.toThrow('client_rejected');expect(m.actions()).toBe(1);
  expect(m.stock.raw).toBe(2);expect(m.logs.join('\n')).toContain('rejected test action');
 });
});
test('bootstrap cancellation before dispatch sends nothing; accepted unresolved work uses only its cleanup bound',async()=>{
 await starterCookingModel('cancelled',async(s,m)=>{
  await expect(cookStarterChickens(s,()=>true)).rejects.toThrow('stopped');expect(m.actions()).toBe(0);
  await expect(cookStarterChickens(s,()=>m.tick()>=13)).rejects.toThrow('settlement unresolved: conversion unobserved; stopped=true');
  expect(m.tick()).toBe(20);expect(m.actions()).toBe(1);expect(m.stock.raw).toBe(2);
 });
});
test('stop during helper preparation is checked again at the primitive dispatch boundary',async()=>{
 await starterCookingModel('pre-dispatch',async(s,m)=>{
  await expect(cookStarterChickens(s,()=>m.tick()>=1)).rejects.toThrow('stopped');
  expect(m.actions()).toBe(0);expect(m.stock.raw).toBe(2);
 });
});
test('bootstrap counts actual burnt output and reports the exact finite food deficit',async()=>{
 await starterCookingModel('burnt',async(s,m)=>{
  await expect(cookStarterChickens(s)).rejects.toThrow('cooked chicken2140 needs1');
  expect(m.stock).toEqual({raw:0,cooked:0,burnt:2});expect(m.logs.join('\n')).toContain('"burnt":2');
 });
});
test('bootstrap restart uses retained raw and cooked stock; prior burnt stock is not new output',async()=>{
 await starterCookingModel('cooked',async(s,m)=>{
  expect(await cookStarterChickens(s)).toMatchObject({ok:true,raw:1,consumed:1,cooked:1,burnt:0,xp:30});
  expect(m.stock).toEqual({raw:0,cooked:3,burnt:1});
 },{raw:1,cooked:2,burnt:1});
 await starterCookingModel('cooked',async(s,m)=>{
  expect(await cookStarterChickens(s)).toMatchObject({ok:true,consumed:0,cooked:0,burnt:0,xp:0});expect(m.actions()).toBe(0);
 },{raw:0,cooked:3,burnt:1});
});
test('bootstrap observes Cooking XP independently when its packet follows inventory output',async()=>{
 await starterCookingModel('delayed-xp',async(s)=>{
  expect(await cookStarterChickens(s)).toMatchObject({ok:true,consumed:2,cooked:2,xp:60});
 });
});
test('bootstrap uses the caller food requirement and keeps retained cooked stock after burns',async()=>{
 await starterCookingModel('burnt',async(s,m)=>{
  await expect(cookStarterChickens(s,()=>false,{requiredFood:3})).rejects.toThrow('cooked chicken2140 needs2');
  expect(m.stock).toEqual({raw:0,cooked:1,burnt:2});
 },{raw:1,cooked:1,burnt:1});
});
for(const mode of ['stalled','lost-output','missing-xp'])test(`bootstrap refuses unproved cooking effects: ${mode}`,async()=>{
 await starterCookingModel(mode,async(s,m)=>{
  await expect(cookStarterChickens(s)).rejects.toThrow(mode==='stalled'?'conversion unobserved':mode==='lost-output'?'output mismatch':'Cooking XP unobserved');
  expect(m.actions()).toBe(1);expect(m.tick()).toBeLessThanOrEqual(21);
 });
});


test('finite supported food profile is explicit and bounds bootstrap, fly catches and a queued catch',()=>{
 expect(finiteFoodProfile(undefined)).toBeUndefined();
 const p=finiteFoodProfile('16')!;expect(p).toEqual({target:16,netCap:16,flyCap:32,catchCap:48,noProgressTicks:240});
 for(const v of ['', '0','29','1.5','NaN'])expect(()=>finiteFoodProfile(v)).toThrow('FOOD_TARGET');
 expect(finiteFoodCanCatch(p,14,0,'net')).toBe(true);
 expect(finiteFoodCanCatch(p,15,0,'net')).toBe(false);
 expect(finiteFoodCanCatch(p,13,30,'fly')).toBe(true);
 expect(finiteFoodCanCatch(p,13,31,'fly')).toBe(false);
});
test('finite useful output stops at16 new deposits and cooks only the remaining deficit after burns',()=>{
 const p=finiteFoodProfile('16')!;
 expect(finiteFoodWork(p,0,0,16)).toEqual({needed:16,cook:true,fish:false,done:false});
 expect(finiteFoodWork(p,0,14,0)).toEqual({needed:2,cook:false,fish:true,done:false});
 expect(finiteFoodWork(p,14,0,2)).toEqual({needed:2,cook:true,fish:false,done:false});
 // An already accepted extra raw catch stays raw; it must not become a seventeenth food.
 expect(finiteFoodWork(p,14,2,1)).toEqual({needed:0,cook:false,fish:false,done:false});
 expect(finiteFoodWork(p,16,0,1)).toEqual({needed:0,cook:false,fish:false,done:true});
});
test('finite rod funding withdraws only5 owned coins and never liquidates bootstrap stock',async()=>{
 const a=account(1123);await fundFishingTool(a.session,5,false);expect(a.held()).toBe(5);expect(a.bank()).toBe(1118);
 let calls=0;const empty:any={sdk:{getState:()=>({inventory:[]}),findBankItem:()=>({name:'Raw shrimps',count:13})},bot:{withdrawItem:async()=>{calls++;return{success:true};}}};
 // This model has no coin row; a missing budget cannot sell or withdraw fish.
 empty.sdk.findBankItem=(re:RegExp)=>re.test('Raw shrimps')?{name:'Raw shrimps',count:13}:undefined;
 expect(await fundFishingTool(empty,5,false)).toBe(0);expect(calls).toBe(0);
});
test('rod-only acquisition leaves the owned feather budget untouched and costs exactly5 coins',async()=>{
 const inventory:any[]=[{name:'Coins',count:5},{name:'Feather',count:32}];const calls:string[]=[];
 const s:any={sdk:{getState:()=>({inventory})},bot:{buyFromShop:async(re:RegExp,n:number)=>{calls.push(re.source);expect(re.test('Fly fishing rod')).toBe(true);expect(n).toBe(1);inventory[0].count-=5;inventory.push({name:'Fly fishing rod',count:1});return{success:true};}}};
 expect(await buyFishingSupplies(s,0)).toBe(0);expect(calls).toHaveLength(1);expect(inventory[0].count).toBe(0);expect(inventory[1].count).toBe(32);
});

test('finite food admits actual Ghost cemetery entry and Draynor while refusing unknown surface routes',()=>{
 expect(finiteFoodEntryPosition({worldX:3248,worldZ:3193,level:0})).toBe(true);
 expect(finiteFoodEntryPosition({worldX:3092,worldZ:3242,level:0})).toBe(true);
 for(const p of [undefined,{worldX:3248,worldZ:3193,level:1},{worldX:2655,worldZ:3283,level:0},{worldX:3104,worldZ:9576,level:0}])expect(finiteFoodEntryPosition(p)).toBe(false);
});
