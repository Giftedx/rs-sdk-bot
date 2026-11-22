import { describe, expect, it, mock, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GEActionResult, GEOffer } from '../../../vendor/rs-sdk/sdk/ge-types';
import * as botCore from '../../core/src/bot';
import { setEquipmentObserved } from '../../core/src/container-observation';
import { FLEE_HP } from '../../core/src/death-recovery';
import type { Session } from '../../core/src/inprocess';
import { watchRandomEvents } from '../../core/src/randomevents';
import { ROUTE_BUDGET_MS } from '../../core/src/world';
import { releaseFiles } from '../../core/src/worker-release';
import { walkWithFerryFallback } from '../src/logistics';
import {
    ARDOUGNE_NORTH,
    HEAL_FOOD,
    NORTH_APPROACH,
    collectClaim,
    collectionApplied,
    collectionRetrySafe,
    earthShopFallback,
    expectedRescueStop,
    leaveBattlefield,
    marketEntryFailure,
    marketLeg,
    marketTileSafe,
    northApproachTile,
    northEntryTile,
    observeOrderProgress,
    onBattlefield,
    openOrderSession,
    orderAccounting,
    orderEscrow,
    orderItemMatcher,
    orderRefusal,
    placementRetrySafe,
    prepareMarketEntry,
    reconcilePlacement,
    rescueMarketEntry,
    runBankBidSale,
    runOwnedSale,
    saleClaim,
    saleCollected,
    salePlacement,
    salePlacementReady,
    saleProgress,
    saleStopRequested,
    shopFallbackSpent,
    terminalOrderClaim,
    validateRequest,
    validateSale,
    type ItemOrder,
    type OrderView,
    type RescueControl,
    type SaleJournal,
    type SaleView,
} from '../src/market';

test('session setup disables corpse recovery before opening only a validated rescue and retains stop ownership',async()=>{
 const previous=process.env.DEATH_RECOVERY,opened:{policy:string|undefined;options:Parameters<typeof botCore.openBot>[1]}[]=[];
 const s={tick:()=>1,sdk:{getState:()=>({player:{lifeId:1,respawnCount:0}}),getStateAge:()=>0}} as unknown as Session;
 const open=spyOn(botCore,'openBot').mockImplementation(async(actor,options)=>{
  expect(actor).toBe(request.actor.toLowerCase());opened.push({policy:process.env.DEATH_RECOVERY,options});return s;
 });
 try{
  for(const rescueMode of [undefined,'npc-respawn-once'] as const)for(const policy of [undefined,'1','0']){
   if(policy===undefined)delete process.env.DEATH_RECOVERY;else process.env.DEATH_RECOVERY=policy;
   const control:RescueControl={active:!!rescueMode,start:0,lifeId:1,respawnCount:0};let stops=0;
   expect(await openOrderSession(request.actor.toLowerCase(),{...request,rescueMode},control,()=>{stops++;})).toBe(s);
   const setup=opened.at(-1)!;
   // openBot captures this policy before installing its automatic corpse handler.
   expect(setup.policy).toBe(rescueMode?'0':policy);
   await setup.options!.onStop!(s,'died');expect(stops).toBe(rescueMode?0:1);
   await setup.options!.onStop!(s,'stop file');expect(stops).toBe(rescueMode?1:2);
   control.active=false;await setup.options!.onStop!(s,'died');expect(stops).toBe(rescueMode?2:3);
   await setup.options!.onSessionEnd!(s,'died');expect(stops).toBe(rescueMode?3:4);
  }
  process.env.DEATH_RECOVERY='1';const calls=opened.length,control:RescueControl={active:false,start:0,lifeId:0,respawnCount:0};
  for(const invalid of [{...request,rescueMode:'npc-respawn-once' as const,limit:0},{...request,rescueMode:'unsupported' as any}]){
   expect(()=>openOrderSession(request.actor.toLowerCase(),invalid,control,()=>{})).toThrow();expect(opened.length).toBe(calls);expect(process.env.DEATH_RECOVERY).toBe('1');
  }
 }finally{open.mockRestore();if(previous===undefined)delete process.env.DEATH_RECOVERY;else process.env.DEATH_RECOVERY=previous;}
});

async function rescueFixture(mode='ok'){
 const dir=mkdtempSync(join(tmpdir(),'ge-rescue-')),path=join(dir,'order.json');
 const bank=[{id:995,count:19911},{id:557,count:4},{id:1351,count:1}],client={};setEquipmentObserved(client,mode!=='unknown-equipment');
 let tick=0,hp=10,attacks=0,stages=0,generation=0,stopped=false;
 const callbacks=new Set<()=>void>(),control:RescueControl={active:false,start:0,lifeId:0,respawnCount:0};
 const player={worldX:2853,worldZ:3452,level:0,lifeId:1,respawnCount:0,isDead:false};
 const state={player,isSkulled:mode==='skulled'?true:mode==='unknown-skull'?undefined:false,equipment:[] as {id:number;count:number}[],
  inventory:[{id:590,count:1}],bank:{isOpen:false},nearbyNpcs:[{kind:'npc',name:'White wolf',index:7,combatLevel:25,reachable:true,distance:11,optionsWithIndex:[{text:'Attack',opIndex:2}]}]};
 if(mode==='kit')state.inventory.push({id:995,count:1});
 if(mode==='equipped')state.equipment.push({id:1277,count:1});
 if(mode==='wrong-pocket')player.worldX++;
 if(mode==='unreachable')state.nearbyNpcs[0]!.reachable=false;
 const s={client,name:'Shaftmaker',tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  sdk:{getState:()=>state,getStateAge:()=>mode==='stale'?6000:0,getInventory:()=>state.inventory,getEquipment:()=>state.equipment,getSkill:()=>({level:hp,baseLevel:10}),
   sendInteractNpc:async(index:number,option:number)=>{expect(index).toBe(7);expect(option).toBe(2);attacks++;expect(JSON.parse(readFileSync(path,'utf8')).rescue.phase).toBe('attempted');if(mode==='throw')throw Error('uncertain attack');return{success:true};}},
  bot:{openBank:async()=>{generation++;state.bank.isOpen=true;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;}},
  bankObservation:()=>state.bank.isOpen?{generation,items:mode==='bank-loss'?bank.slice(0,-1):bank}:null} as unknown as Session;
 const req={...request,actor:'Shaftmaker',item:563,quantity:5,limit:1000,reserve:10000,rescueMode:'npc-respawn-once' as const,createdAt:Date.now(),reviewAt:Date.now()+10000,deadline:Date.now()+60000};
 if(mode==='prior')writeFileSync(path,JSON.stringify({rescue:{phase:'attempted'}}));
 const timer=setInterval(()=>{
  tick++;
  if(attacks&&mode==='owner-stop')stopped=true;
  if(attacks&&mode!=='throw'&&mode!=='timeout'&&tick===2){player.isDead=true;hp=0;expect(expectedRescueStop(s,'died',control)).toBe(true);}
  if(attacks&&mode!=='throw'&&mode!=='timeout'&&tick===3){Object.assign(player,{worldX:3221,worldZ:3218,lifeId:mode==='second-death'?3:2,respawnCount:mode==='second-death'?2:1,isDead:false});hp=mode==='low-respawn'?1:10;}
  for(const cb of [...callbacks])cb();
 },1);
 let error='',journal:any;
 try{await rescueMarketEntry(s,req,path,()=>stopped,control,{bank,bankAt:1},async signal=>{
  stages++;expect(control.active).toBe(false);expect(expectedRescueStop(s,'died',control)).toBe(false);
  Object.assign(player,{worldX:3092,worldZ:3243});
  if(mode==='stage-death')player.lifeId++;
  if(mode==='stage-damage')hp=9;
  return{ok:!signal.aborted};
 });}catch(e){error=String(e);}finally{clearInterval(timer);journal=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;rmSync(dir,{recursive:true,force:true});}
 return{attacks,stages,error,journal,active:control.active,callbacks:callbacks.size};
}
test('exact wolf pocket rescue records one intent, one death, retained kit and Draynor bank reconciliation',async()=>{
 const r=await rescueFixture();expect(r).toMatchObject({attacks:1,stages:1,error:'',active:false,callbacks:0});
 expect(r.journal).toMatchObject({phase:'entry',coinsBefore:19911,itemsBefore:0,rescue:{phase:'bank-reconciled',lifeId:1,respawnCount:0,targetIndex:7}});
});
test('authorized rescue crosses the active flee threshold without fleeing and releases the watcher before staging',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ge-rescue-flee-')),path=join(dir,'order.json'),client={};setEquipmentObserved(client,true);
 const bank=[{id:995,count:19911},{id:557,count:4},{id:1351,count:1}],callbacks=new Set<()=>void>(),walks:unknown[]=[],lines:string[]=[];
 const control:RescueControl={active:false,start:0,lifeId:0,respawnCount:0};let tick=0,attacks=0,generation=0,stageBusy:boolean|undefined;
 const player={worldX:2853,worldZ:3452,level:0,lifeId:1,respawnCount:0,isDead:false,hp:10,maxHp:10};
 const wolf={kind:'npc',name:'White wolf',id:96,index:7,combatLevel:25,reachable:true,distance:1,x:2854,z:3452,targetIndex:32768,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 const state={player,isSkulled:false,equipment:[],inventory:[{id:590,count:1,optionsWithIndex:[]}],bank:{isOpen:false},nearbyNpcs:[wolf]};
 const s={client,name:'Shaftmaker',tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
  direct:async(action:{type:string})=>{if(action.type==='interactNpc')attacks++;if(action.type==='walkTo')walks.push(action);return{success:true};},
  sdk:{getState:()=>state,getStateAge:()=>0,getInventory:()=>state.inventory,getEquipment:()=>state.equipment,getSkill:()=>({level:player.hp,baseLevel:10}),
   sendInteractNpc:async(index:number,option:number)=>{expect(index).toBe(7);expect(option).toBe(2);expect(JSON.parse(readFileSync(path,'utf8')).rescue.phase).toBe('attempted');return s.direct({type:'interactNpc',npcIndex:index,optionIndex:option});}},
  bot:{openBank:async()=>{generation++;state.bank.isOpen=true;return{success:true};},closeBank:async()=>{state.bank.isOpen=false;}},
  bankObservation:()=>state.bank.isOpen?{generation,items:bank}:null} as unknown as Session;
 const watcher=watchRandomEvents(s,{pf:null,ifReader:null,danger:null,events:false,gate:true,log:line=>lines.push(line),flee:{hp:FLEE_HP,onSafe:()=>{}}});
 const watch=spyOn(botCore,'randomEventsOf').mockImplementation(session=>session===s?watcher:undefined);
 const step=async()=>{tick++;for(const cb of [...callbacks])cb();await Promise.resolve();await Promise.resolve();};
 try{
  const now=Date.now(),req={...request,actor:s.name,item:563,quantity:5,limit:1000,reserve:10000,rescueMode:'npc-respawn-once' as const,createdAt:now,reviewAt:now+10000,deadline:now+60000};
  const work=rescueMarketEntry(s,req,path,()=>false,control,{bank,bankAt:1},async()=>{
   stageBusy=watcher.busy();Object.assign(player,{worldX:3092,worldZ:3243});return{ok:true};
  });
  player.hp=1;await step();await step();
  player.hp=0;player.isDead=true;await step();
  const expectedDeath=expectedRescueStop(s,'died',control);
  Object.assign(player,{worldX:3221,worldZ:3218,lifeId:2,respawnCount:1,isDead:false,hp:10});await step();
  const journal=await work;
  expect(attacks).toBe(1);expect(walks).toHaveLength(0);expect(lines).toEqual([]);expect(expectedDeath).toBe(true);
  expect(stageBusy).toBe(false);expect(control.active).toBe(false);expect(watcher.busy()).toBe(false);
  expect(journal.rescue?.phase).toBe('bank-reconciled');expect(journal.rescue?.bank).toEqual(bank);
  player.hp=1;Object.assign(wolf,{x:player.worldX+1,z:player.worldZ});await step();
  expect(watcher.counts()['flee_guard:flee']).toBe(1);expect(walks.length).toBeGreaterThan(0);
 }finally{watcher.stop();watch.mockRestore();rmSync(dir,{recursive:true,force:true});}
 expect(callbacks.size).toBe(0);
});
for(const mode of ['unknown-skull','skulled','kit','equipped','unknown-equipment','wrong-pocket','unreachable','stale','prior'])test(`rescue refuses ${mode} before engagement`,async()=>{
 const r=await rescueFixture(mode);expect(r.attacks).toBe(0);expect(r.stages).toBe(0);expect(r.error).not.toBe('');expect(r.active).toBe(false);
});
for(const mode of ['throw','timeout','owner-stop','second-death','low-respawn','stage-death','stage-damage','bank-loss'])test(`rescue ${mode} stays uncertain and cannot authorize another death`,async()=>{
 const r=await rescueFixture(mode);expect(r.attacks).toBe(1);expect(r.error).not.toBe('');expect(r.journal.rescue.phase).not.toBe('bank-reconciled');expect(r.active).toBe(false);expect(r.callbacks).toBe(0);
});

test('north Varrock entry 3165,3487,0 takes the bounded pinned approach; the market rectangle stays unchanged',async()=>{
 expect(marketEntryFailure({worldX:3165,worldZ:3487,level:0},11)).toContain('unsupported market entry');
 expect(northEntryTile({x:3165,z:3487,level:0})).toBe(true);expect(northEntryTile({x:2654,z:3283,level:0})).toBe(false);
 expect(NORTH_APPROACH).toEqual([{x:3198,z:3508},{x:3241,z:3507},{x:3244,z:3503},{x:3185,z:3436,tol:1}]);
 expect(NORTH_APPROACH.slice(0,-1).every(t=>northApproachTile({...t,level:0}))).toBe(true);
 expect(marketTileSafe({...NORTH_APPROACH.at(-1)!,level:0})).toBe(true);expect(northApproachTile({x:3233,z:3503,level:0})).toBe(false);
 const player={worldX:3165,worldZ:3487,level:0,lifeId:1,respawnCount:0};let calls=0;
 const s={sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:11})},tick:()=>0,
  ended:new Promise(()=>{}),onTick:()=>()=>{}} as unknown as Session;
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try{await prepareMarketEntry(s,()=>false,async()=>{calls++;Object.assign(player,{worldX:3185,worldZ:3436});return{ok:true,ticks:241};});}finally{log.mockRestore();}
 expect(calls).toBe(1);expect(marketEntryFailure(player,11)).toBeNull();
},60000);

test('market travel: diagnostics bracket travel with observed position and ticks',async()=>{
 const player={worldX:2654,worldZ:3283,level:0,lifeId:1,respawnCount:0};let tick=7;
 const s={sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:10})},tick:()=>tick,
  ended:new Promise(()=>{}),onTick:()=>()=>{}} as unknown as Session;
 const lines:string[]=[],log=spyOn(console,'log').mockImplementation((line)=>{lines.push(String(line));});
 try{
  await prepareMarketEntry(s,()=>false,async()=>{
   expect(lines.some(l=>l.includes('"stage":"travel-start"'))).toBe(true);
   tick=12;Object.assign(player,{worldX:3185,worldZ:3436});return{ok:true,ticks:5};
  });
 }finally{log.mockRestore();}
 const rows=lines.filter(l=>l.startsWith('GE_MARKET_ENTRY ')).map(l=>JSON.parse(l.slice('GE_MARKET_ENTRY '.length)));
 expect(rows.map(r=>r.stage)).toEqual(['travel-start','travel-returned']);
 expect(rows[0]).toMatchObject({tick:7,position:{x:2654,z:3283,level:0},hp:10});
 expect(rows[1]).toMatchObject({tick:12,position:{x:3185,z:3436,level:0},hp:10,ok:true});
 expect(rows.every(r=>Number.isFinite(r.at))).toBe(true);
});

test('market travel: remote actors travel once; supported starts skip travel',async()=>{
 for(const remote of [true,false]){
  const player={worldX:remote?2654:3185,worldZ:remote?3283:3436,level:0,lifeId:1,respawnCount:0};
  const callbacks=new Set<()=>void>();let calls=0;
  const s={sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:10})},tick:()=>0,
   ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}} as unknown as Session;
  await prepareMarketEntry(s,()=>false,async()=>{calls++;Object.assign(player,{worldX:3185,worldZ:3436});return{ok:true,ticks:1};});
  expect(calls).toBe(remote?1:0);expect(callbacks.size).toBe(0);
 }
});

test('market travel: refusal, false arrival and tick exhaustion retain the stuck position',async()=>{
 for(const mode of ['refused','false-arrival','timeout','stop','damage','death']){
  const player={worldX:2654,worldZ:3283,level:0,lifeId:1,respawnCount:0};
  const callbacks=new Set<()=>void>();let tick=0,hp=10,stopped=false,aborted=false;
  const s={sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:hp})},tick:()=>tick,
   ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);}} as unknown as Session;
  await expect(prepareMarketEntry(s,()=>stopped,async signal=>{
   if(mode==='timeout')tick=1200;if(mode==='stop')stopped=true;if(mode==='damage')hp=9;if(mode==='death')player.lifeId++;
   for(const cb of callbacks)cb();
   aborted=signal.aborted;
   return{ok:mode==='false-arrival',ticks:tick};
  })).rejects.toThrow('position=2654,3283,0');
  expect(aborted).toBe(['timeout','stop','damage','death'].includes(mode));
  expect(callbacks.size).toBe(0);
 }
});

test('market travel: the leg to the market bank from the Port Sarim dock plans with the full route budget',async()=>{
 for(const start of [{x:2617,z:3333,level:0},{x:3029,z:3217,level:0}]){
  const legs:{x:number;z:number;budget?:number}[]=[];let sailed=0,direct=true;
  const result=await walkWithFerryFallback(start,{x:3185,z:3436,level:0},marketLeg(async(tile,budget)=>{
   legs.push({x:tile.x,z:tile.z,budget});
   if(direct&&start.x===2617){direct=false;return{ok:false,reason:'precondition',detail:'no route to 3185,3436,0',ticks:0};}
   return{ok:true,ticks:1};
  }),async()=>{sailed++;return{ok:true,ticks:1};},()=>17250);
  expect(result.ok).toBe(true);
  expect(legs.at(-1)).toEqual({x:3185,z:3436,budget:ROUTE_BUDGET_MS});
  expect(sailed).toBe(start.x===2617?2:0);
  if(start.x===2617)expect(legs.slice(1,-1).map(l=>l.budget)).toEqual([15000,15000]);
 }
});

test('market travel: low HP approach and living actor checks precede travel',async()=>{
 for(const hp of [0,3,NaN]){
  const s={sdk:{getState:()=>({player:{worldX:2654,worldZ:3283,level:0}}),getSkill:()=>({level:hp})}} as unknown as Session;
  let calls=0;
  await expect(prepareMarketEntry(s,()=>false,async()=>{calls++;return{ok:true,ticks:0};})).rejects.toThrow(hp===3?'bank approach within3':'living actor');
  expect(calls).toBe(0);
 }
});
const request={actor:'Abracadickra',server:'rs-sdk-demo.fly.dev',goal:'combat-sword',item:1331,limit:45000,reserve:5000,createdAt:1000,reviewAt:2000,deadline:3000};
const offer=(extra:Partial<GEOffer>={}):GEOffer=>({id:9,slot:0,item:1331,name:'Adamant scimitar',side:'buy',quantity:1,price:45000,remaining:1,filled:0,state:'open',items:0,coins:0,gross:0,tax:0,...extra});
const journal=():ItemOrder=>({version:1,request,phase:'placing',coinsBefore:50000,itemsBefore:0,previousIds:[2],at:1000});
test('earth shop fallback preserves an exactly settled zero-fill GE journal and its budget',()=>{
 const r={...request,item:557,quantity:1136,expectedOwned:3,limit:40,reserve:30000};
 const j:ItemOrder={...journal(),request:r,phase:'settled',itemsBefore:3,acquired:0,refund:45440};
 const before=JSON.stringify(j),p=earthShopFallback(r,j,1600);
 expect(p.entry).toBe('scripts/aio-market.ts');expect(p.mode).toBe('shop-buy');
 expect(p.args).toEqual(['shop-buy','aubury','1600','2000']);expect(p.env).toMatchObject({ITEMS:'earth rune',MAX_ITEMS:'1136',STOCK_TARGET:'1139',MAX_SPEND:'45440',COIN_RESERVE:'30000',FLOAT:'75440',NO_BUY_TICKS:'25'});
 expect(JSON.stringify(j)).toBe(before);
 const spent=shopFallbackSpent({request:r,phase:'settled',spent:1000},r);
 expect(earthShopFallback(r,j,1600,spent).env.MAX_SPEND).toBe('44440');
 expect(()=>shopFallbackSpent({request:r,phase:'running',spent:1000},r)).toThrow('unresolved');
 expect(()=>shopFallbackSpent({request:{...r,item:555},phase:'settled',spent:1000},r)).toThrow('unresolved');
 expect(()=>earthShopFallback(r,j,1600,45440)).toThrow();
 for(const bad of [undefined,{...j,phase:'open'},{...j,refund:45439},{...j,acquired:1},{...j,itemsBefore:4}])expect(()=>earthShopFallback(r,bad as any,1600)).toThrow();
 expect(()=>earthShopFallback({...r,item:555},j,1600)).toThrow();
 expect(()=>earthShopFallback(r,j,1601)).toThrow();
 expect(earthShopFallback(r,j,3000,1000,'betty').args).toEqual(['shop-buy','betty','3000','2000']);
 expect(earthShopFallback(r,j,3000,1000,'betty').env.MAX_SPEND).toBe('44440');
 expect(()=>earthShopFallback(r,j,3001,0,'betty')).toThrow();
 expect(earthShopFallback(r,j,16000,1000,'betty-refill')).toMatchObject({entry:'scripts/aio-market.ts',mode:'earth-shop',args:['earth-shop','betty','16000','2000'],env:{MAX_SPEND:'44440',MAX_ITEMS:'1136',STOCK_TARGET:'1139',NO_BUY_TICKS:'25'}});
 expect(()=>earthShopFallback(r,j,16001,0,'betty-refill')).toThrow();
 expect(earthShopFallback(r,j,20000,0,'owned-talismans')).toMatchObject({entry:'packages/workers/src/bank-artisan/earth-production.ts',args:['talismans','20000'],env:{STOCK_TARGET:'1139',MAX_SPEND:'45440'}});
 expect(earthShopFallback(r,j,20000,0,'owned-craft').args).toEqual(['craft','20000']);
 expect(()=>earthShopFallback(r,j,20001,0,'owned-craft')).toThrow();
 expect(()=>earthShopFallback(r,j,1600,0,'unknown')).toThrow();
 const marketRelease = releaseFiles(['scripts/aio-market.ts'], resolve(import.meta.dir, '../../..'));
 expect(marketRelease).not.toContain('scripts/aio-skiller.ts');
 expect(marketRelease).toContain('packages/workers/src/bank-artisan/earth-production.ts');
});
const view=(offers:GEOffer[]=[offer()],coins=5000,items=0):OrderView=>({actor:request.actor,server:request.server,offers,coins,items});
test('bank and exchange approaches share one ground-floor boundary',()=>{
 expect(marketTileSafe({x:3185,z:3436,level:0})).toBe(true);expect(marketTileSafe({x:3181,z:3443,level:0})).toBe(true);
 expect(marketTileSafe({x:3181,z:3443,level:1})).toBe(false);expect(marketTileSafe({x:3189,z:3443,level:0})).toBe(false);
});
test('new exact offer plus exact escrow debit resolves an uncertain placement',()=>{expect(reconcilePlacement(journal(),view())?.id).toBe(9);});
test('an existing same-shaped order is not the new order',()=>{expect(reconcilePlacement(journal(),view([offer({id:2})]))).toBeUndefined();});
test('two matching new offers remain ambiguous',()=>{expect(()=>reconcilePlacement(journal(),view([offer(),offer({id:10,slot:1})]))).toThrow('ambiguous');});
test('wrong item,side,quantity or limit never binds an unrelated offer',()=>{
 for(const extra of [{item:1289},{side:'sell' as const},{quantity:2},{price:45001}])expect(reconcilePlacement(journal(),view([offer(extra)]))).toBeUndefined();
});
test('new matching offer without exact owned escrow or item baseline fails',()=>{
 expect(()=>reconcilePlacement(journal(),view([offer()],4999))).toThrow('escrow');
 expect(()=>reconcilePlacement(journal(),view([offer()],5000,1))).toThrow('item');
});
test('owner and server are part of the order identity',()=>{
 expect(()=>reconcilePlacement(journal(),{...view(),actor:'SomeoneElse'})).toThrow('identity');
 expect(()=>reconcilePlacement(journal(),{...view(),server:'localhost'})).toThrow('identity');
});
test('reconnect after an applied collection can settle without sending collection twice',()=>{
 const j={...journal(),phase:'collecting' as const,offerId:9,claim:{coinsBefore:5000,itemsBefore:0,coins:5000,items:1}};
 expect(collectionApplied(j,view([],10000,1))).toBe(true);
 expect(collectionApplied(j,view([offer({state:'completed'})],10000,1))).toBe(false);
 expect(collectionApplied(j,view([],9999,1))).toBe(false);
 expect(collectionApplied(j,view([],10000,0))).toBe(false);
});
test('cancelled unfilled order proves full refund and zero acquired items',()=>{
 const j={...journal(),phase:'collecting' as const,offerId:9,claim:{coinsBefore:5000,itemsBefore:0,coins:45000,items:0}};
 expect(collectionApplied(j,view([],50000,0))).toBe(true);
 expect(collectionApplied(j,view([],50000,1))).toBe(false);
});
test('bad quantities,debit overflow and invalid time order are refused',()=>{
 expect(()=>validateRequest(request)).not.toThrow();
 for(const extra of [{item:0},{limit:-1},{limit:2147483648},{reserve:-1},{deadline:1500},{reviewAt:999},{expectedOwned:-1},{expectedOwned:1.5},{expectedOwned:NaN}])expect(()=>validateRequest({...request,...extra})).toThrow();
 expect(()=>validateRequest({...request,expectedOwned:4})).not.toThrow();
});
test('terminal collection requires conserved cumulative fill cost and an exact refund',()=>{
 const j:ItemOrder={...journal(),phase:'open',offerId:9};
 const filled=offer({filled:1,remaining:0,state:'completed',items:1,coins:5000,gross:40000});
 const progress=observeOrderProgress(j,filled,2000);
 expect(progress.baseline).toBe(true);j.progress=progress.current;
 expect(observeOrderProgress(j,filled,2001).delta).toEqual({filled:0,gross:0,tax:0});
 expect(terminalOrderClaim(j,filled)).toEqual({items:1,coins:5000});
 for(const extra of [{coins:4999},{gross:39999},{remaining:1},{tax:1},{items:0},{state:'open' as const}])expect(()=>terminalOrderClaim(j,{...filled,...extra})).toThrow();
});
const bulkRequest={...request,goal:'wine-grapes',item:1987,quantity:300,limit:5,reserve:100};
const bulkOffer=(extra:Partial<GEOffer>={}):GEOffer=>offer({item:1987,name:'Grapes',quantity:300,price:5,remaining:300,...extra});
const bulkJournal=(extra:Partial<ItemOrder>={}):ItemOrder=>({version:1,request:bulkRequest,phase:'placing',coinsBefore:1600,itemsBefore:0,previousIds:[],at:1000,...extra});
test('a journal written before bulk orders keeps quantity one',()=>{expect(orderEscrow(request)).toBe(45000);expect(orderEscrow(bulkRequest)).toBe(1500);});
test('bulk escrow is quantity times limit and the total must fit one coin stack',()=>{
 expect(()=>validateRequest(bulkRequest)).not.toThrow();
 for(const extra of [{quantity:0},{quantity:1.5},{quantity:-3},{quantity:2147483647,limit:2}])expect(()=>validateRequest({...bulkRequest,...extra})).toThrow();
 expect(reconcilePlacement(bulkJournal(),view([bulkOffer()],100))?.id).toBe(9);
 expect(()=>reconcilePlacement(bulkJournal(),view([bulkOffer()],1595))).toThrow('escrow');
 expect(reconcilePlacement(bulkJournal(),view([bulkOffer({quantity:299})],100))).toBeUndefined();
});
test('banknotes count as the ordered item; a catalogued item with the same name does not',()=>{
 const is=orderItemMatcher(1987,[{id:1987,name:'Grapes'},{id:2000,name:'Grapes'},{id:1937,name:'Jug of water'}]);
 expect(is({id:1987,name:'Grapes'})).toBe(true);expect(is({id:1988,name:'Grapes'})).toBe(true);
 expect(is({id:2000,name:'Grapes'})).toBe(false);expect(is({id:1938,name:'Jug of water'})).toBe(false);
 expect(orderItemMatcher(9999,[])({id:10000,name:'Grapes'})).toBe(false);
});
test('a full bulk fill with price improvement refunds the unspent escrow',()=>{
 const j=bulkJournal({phase:'open',offerId:9});
 const filled=bulkOffer({filled:300,remaining:0,state:'completed',items:300,coins:600,gross:900});
 j.progress=observeOrderProgress(j,filled,2000).current;
 expect(terminalOrderClaim(j,filled)).toEqual({items:300,coins:600});
 expect(()=>terminalOrderClaim(j,{...filled,coins:601})).toThrow();
 expect(()=>terminalOrderClaim(j,{...filled,filled:299,items:299,gross:897})).toThrow();
 const collecting={...j,phase:'collecting' as const,claim:{coinsBefore:100,itemsBefore:0,coins:600,items:300}};
 expect(collectionApplied(collecting,view([],700,300))).toBe(true);
 expect(collectionApplied(collecting,view([],700,299))).toBe(false);
 expect(orderAccounting({...j,phase:'settled',acquired:300,refund:600})).toEqual({acquired:300,refund:600,spent:900,escrow:0,maximumExposure:0,outcomeUnresolved:false});
});
test('a cancelled partial bulk fill settles the filled part and refunds the rest',()=>{
 const j=bulkJournal({phase:'open',offerId:9});
 const partial=bulkOffer({filled:120,remaining:0,state:'cancelled',items:120,coins:1020,gross:480});
 j.progress=observeOrderProgress(j,partial,2000).current;
 expect(terminalOrderClaim(j,partial)).toEqual({items:120,coins:1020});
 expect(orderAccounting({...j,phase:'settled',acquired:120,refund:1020}).spent).toBe(480);
 expect(orderAccounting({...j,phase:'open'})).toMatchObject({spent:480,escrow:1020,maximumExposure:1500});
});
test('a bulk settlement that spends above the limit or acquires extra items is unresolved',()=>{
 const base=bulkJournal({phase:'settled',offerId:9});
 for(const [acquired,refund] of [[301,0],[100,0],[0,1499],[1,1500]])expect(orderAccounting({...base,acquired,refund}).outcomeUnresolved).toBe(true);
});

test('interrupted collection retries only the unchanged terminal claim and exact pre-collection assets',()=>{
 const j=bulkJournal({phase:'collecting',offerId:9,claim:{coinsBefore:100,itemsBefore:0,coins:1020,items:120}});
 const o=bulkOffer({state:'cancelled',filled:120,remaining:0,items:120,coins:1020,gross:480});
 expect(collectionRetrySafe(j,view([o],100,0))).toBe(true);
 for(const v of [view([],100,0),view([o],101,0),view([o],100,1),view([{...o,coins:1021}],100,0),view([{...o,state:'open'}],100,0)])expect(collectionRetrySafe(j,v)).toBe(false);
 expect(collectionApplied(j,view([],1120,120))).toBe(true);
 expect(collectionRetrySafe(j,view([],1120,120))).toBe(false);
});

test('a missing offer cannot prove collection from a corrupt or unrelated claim baseline',()=>{
 const j=bulkJournal({phase:'collecting',offerId:9,claim:{coinsBefore:100,itemsBefore:0,coins:1020,items:120}});
 expect(collectionApplied({...j,claim:{...j.claim!,coins:1500}},view([],1600,120))).toBe(false);
 expect(collectionApplied({...j,claim:{...j.claim!,coinsBefore:101}},view([],1121,120))).toBe(false);
 expect(collectionApplied({...j,claim:{...j.claim!,itemsBefore:1}},view([],1120,121))).toBe(false);
});

if(process.env.GE_BUYER_WORKER_TEST!=='1')test('worker paths run in an isolated simulated session',()=>{
 const child=Bun.spawnSync([process.execPath,'test',import.meta.path,'--test-name-pattern','^worker:','--timeout','15000'],
  {env:{...process.env,GE_BUYER_WORKER_TEST:'1'},timeout:30000,stdout:'pipe',stderr:'pipe'});
 expect(child.stderr.toString()).toContain('0 fail');expect(child.exitCode).toBe(0);
});
else{
 mock.module('../../core/src/walk',()=>({
  goTo:async()=>{throw Error('unexpected remote travel in bank fixture');},
  sessionWalker:async(s:any)=>({s,plan:()=>[]}),expandPath:()=>[],
  walkPath:async(d:any,points:any[])=>{const p=points[0];Object.assign(d.s.sdk.getState().player,{worldX:p.x,worldZ:p.z});return{ok:true};},
 }));
 const {runOwnedItem}=await import('../src/market');
 type Row={id:number;name:string;count:number;slot:number};
 async function fixture(filled:number,phase?:ItemOrder['phase'],applied=false,options:{fillWait?:number;noCollection?:boolean;noDeposit?:boolean;exactBudget?:boolean;lowHp?:boolean;noFood?:boolean;noHeal?:boolean;guardEats?:boolean;replayBankState?:boolean;prepared?:boolean;partialThenFull?:boolean;expireAfterCollect?:boolean;uncertain?:boolean;throwPlacementBefore?:boolean;throwPlacementAfter?:boolean;throwCollectionBefore?:boolean;throwCollectionAfter?:boolean;shortCash?:boolean;ownedStock?:boolean;topUp?:{owned:number;expected?:number}}={}){
  const dir=mkdtempSync(join(tmpdir(),'ge-worker-')),path=join(dir,'journal.json');
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  const req:ItemOrder['request']={...bulkRequest,createdAt:Date.now(),reviewAt:Date.now()+10000,deadline:Date.now()+20000};
  if(options.exactBudget){req.limit=3;req.reserve=0;}
  if(options.topUp){req.quantity=1;if(options.topUp.expected!==undefined)req.expectedOwned=options.topUp.expected;}
  const escrow=orderEscrow(req);
  let generation=1,tick=0,placements=0,collections=0,cancels=0,eats=0,hp=options.lowHp?3:10;
  const commands:{type:string;slot?:number;amount?:number}[]=[];
  const callbacks=new Set<()=>void>(),row=(id:number,count:number):Row=>({id,count,name:id===995?'Coins':'Grapes',slot:0});
  const state={revision:2,player:{worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0},inventory:[] as Row[],bank:{isOpen:false,items:[row(995,escrow+req.reserve)]}};
  let offers:GEOffer[]=[];
  if(options.shortCash)state.bank.items[0]!.count--;
  if(options.ownedStock)state.bank.items.push(row(1987,1));
  if(options.topUp)state.bank.items.push(row(1987,options.topUp.owned));
  if(options.lowHp&&!options.noFood)state.bank.items.push({...row(329,2),name:'Salmon',slot:1});
  const terminal=()=>bulkOffer({price:req.limit,filled,remaining:0,state:filled===300?'completed':'cancelled',items:filled,gross:filled*3,coins:escrow-filled*3});
  if(phase){
   const j:ItemOrder={version:1,request:req,phase,coinsBefore:1600,itemsBefore:0,previousIds:[],at:Date.now(),offerId:9};
   state.bank.items=[row(995,100)];
   offers=[phase==='collecting'?terminal():bulkOffer({filled,remaining:300-filled,items:filled,gross:filled*3})];
   if(phase==='collecting'){
    j.claim={coinsBefore:100,itemsBefore:0,coins:1500-filled*3,items:filled};
    if(applied){offers=[];state.bank.items=[row(995,1600-filled*3),...(filled?[row(1987,filled)]:[])];}
   }
   if(phase==='placing'){delete j.offerId;offers=[];state.bank.items=[row(995,1600)];if(options.prepared)j.submission='prepared';if(options.uncertain)j.submission='attempted';}
   if(phase==='settled'){j.acquired=filled;j.refund=1500-filled*3;offers=[];state.bank.items=[row(995,1600-filled*3),...(filled?[row(1987,filled)]:[])];}
   writeFileSync(path,JSON.stringify(j));
  }
  state.bank.items.push({...row(1351,1),name:'Bronze axe'});
  const sdk={getState:()=>state,getStateAge:()=>0,getInventory:()=>state.inventory,getEquipment:()=>[],getSkill:()=>({level:hp}),
   findBankItem:()=>state.bank.items.find(i=>i.id===995),getGEState:()=>({offers})};
  const bot={dismissBlockingUI:async()=>{},openBank:async()=>{state.bank.isOpen=true;state.revision++;generation++;return{success:true};},
   closeBank:async()=>{state.bank.isOpen=false;if(options.guardEats&&state.inventory.some(i=>i.id===329)){state.inventory=state.inventory.filter(i=>i.id!==329);hp=10;}return{success:true};},openGE:async()=>({success:true}),
   withdrawItem:async(item:Row,n:number)=>{commands.push({type:'bankWithdraw',slot:item.slot,amount:n});state.bank.items.find(i=>i.id===item.id)!.count-=n;state.bank.items=state.bank.items.filter(i=>i.count>0);state.inventory.push({...item,count:n,slot:0});state.revision++;generation++;return{success:true};},
   eatFood:async(item:Row)=>{eats++;if(!options.noHeal){state.inventory=state.inventory.filter(i=>i.id!==item.id);hp=10;}return{success:true};},
   depositItem:async(i:Row)=>{if(options.noDeposit)return{success:true};const n=state.inventory.filter(r=>r.id===i.id).reduce((a,r)=>a+r.count,0),id=i.id===1988?1987:i.id;
    state.inventory=state.inventory.filter(r=>r.id!==i.id);const bank=state.bank.items.find(r=>r.id===id);if(bank)bank.count+=n;else state.bank.items.push(row(id,n));generation++;return{success:true};},
   placeGEOffer:async(r:{quantity:number;price:number})=>{placements++;if(options.throwPlacementBefore&&placements===1)throw Error('placement interrupted before mutation');state.inventory=state.inventory.filter(i=>i.id!==995);const n=options.partialThenFull&&placements>1?r.quantity:Math.min(filled,r.quantity);offers=[bulkOffer({id:9+placements,quantity:r.quantity,price:r.price,filled:n,remaining:r.quantity-n,state:n===r.quantity?'completed':'open',items:n,gross:n*3,coins:n===r.quantity?r.quantity*r.price-n*3:0})];if(options.throwPlacementAfter&&placements===1)throw Error('placement interrupted after mutation');return{success:true};},
   cancelGEOffer:async()=>{cancels++;const o=offers[0]!;offers=[{...o,state:'cancelled',remaining:0,coins:o.quantity*o.price-o.gross}];return{success:true};},
   collectGEOffer:async()=>{collections++;if(options.throwCollectionBefore&&collections===1)throw Error('collection interrupted before mutation');if(options.noCollection)return{success:true};const o=offers[0]!;state.inventory=[...(o.coins?[row(995,o.coins)]:[]),...(o.items?[row(1988,o.items)]:[])];offers=[];if(options.expireAfterCollect)now=req.deadline;if(options.throwCollectionAfter&&collections===1)throw Error('collection interrupted after mutation');return{success:true};}};
  const session={name:req.actor,sdk,bot,tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
   bankObservation:()=>options.replayBankState?null:({generation,items:state.bank.items.map(i=>({...i})),at:Date.now()})};
  const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
  try{
   const run=()=>runOwnedItem(session as any,req,path,()=>false,false,options.fillWait??0);
   const first=await run(),before=JSON.stringify(state.bank.items),second=await run();
   return{first,second,placements,collections,cancels,eats,commands,unchanged:before===JSON.stringify(state.bank.items),journal:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null};
  }finally{Date.now=originalNow;clearInterval(timer);rmSync(dir,{recursive:true,force:true});}
 }
 test('worker: full fill banks the exact stock and a settled rerun does not buy',async()=>{
  const r=await fixture(300);expect(r.first).toMatchObject({ok:true,targetMet:true,banked:true,reserveKept:true,spent:900,finalCoins:700,finalItems:300});
  expect(r.second).toMatchObject({ok:true,newItemsThisSession:0,cashDeltaThisSession:0});expect(r.placements).toBe(1);expect(r.collections).toBe(1);expect(r.unchanged).toBe(true);
 });
 test('worker: low HP at the supported bank uses one owned salmon before funding',async()=>{
  const r=await fixture(300,undefined,false,{lowHp:true});
  expect(r.first).toMatchObject({ok:true,unrelated:true,foodUsed:[{id:329,count:1}],finalItems:300,finalCoins:700});
  expect(r.second.ok).toBe(true);expect(r.placements).toBe(1);expect(r.eats).toBe(1);
 });
 test('worker: recorded low-HP bank state replays the slot 1 food withdrawal',async()=>{
  const old=process.env.REPLAY_ONLY;process.env.REPLAY_ONLY='1';
  try{
   const r=await fixture(300,undefined,false,{lowHp:true,replayBankState:true});
   expect(r.commands[0]).toEqual({type:'bankWithdraw',slot:1,amount:1});
  }finally{if(old===undefined)delete process.env.REPLAY_ONLY;else process.env.REPLAY_ONLY=old;}
 });
 test('worker: a session eat guard that eats the withdrawn salmon first still proves healing and banks the exact stock',async()=>{
  const r=await fixture(300,undefined,false,{lowHp:true,guardEats:true});
  expect(r.first).toMatchObject({ok:true,unrelated:true,banked:true,foodUsed:[{id:329,count:1}],finalItems:300,finalCoins:700});
  expect(r.eats).toBe(0);expect(r.second.ok).toBe(true);expect(r.placements).toBe(1);
 });
 for(const extra of [{noFood:true},{noHeal:true}])test(`worker: low HP cannot buy without observed healing ${JSON.stringify(extra)}`,async()=>{
  const r=await fixture(300,undefined,false,{lowHp:true,...extra});
  expect(r.first.ok).toBe(false);expect(r.placements).toBe(0);expect(r.first.failure).toContain('health preparation');
 });
 test('worker: zero fill refunds all escrow and fails explicitly',async()=>{
  const r=await fixture(0);expect(r.first).toMatchObject({ok:false,phase:'settled',targetMet:false,conserved:true,banked:true,acquired:0,refund:1500,spent:0});
  expect(r.first.failure).toContain('no-progress');expect(r.second.ok).toBe(false);expect(r.placements).toBe(2);expect(r.cancels).toBe(2);expect(r.collections).toBe(2);
 });
 for(const phase of ['open','cancelling','collecting','settled'] as const)test(`worker: resumes ${phase} and buys only missing stock`,async()=>{
  const r=await fixture(120,phase);expect(r.first).toMatchObject({ok:true,phase:'settled',acquired:300,refund:600,spent:900,conserved:true,banked:true,unrelated:true});
  expect(r.placements).toBe(2);expect(r.collections).toBe(phase==='settled'?2:3);expect(r.second.ok).toBe(true);expect(r.unchanged).toBe(true);
 });
 test('worker: four productive rounds stop at a finite boundary and resume only remaining stock',async()=>{
  const r=await fixture(1);expect(r.first).toMatchObject({ok:false,acquired:4,spent:12,refund:1488,conserved:true,banked:true});expect(r.second).toMatchObject({ok:false,acquired:8,spent:24,conserved:true,banked:true});expect(r.placements).toBe(8);expect(r.journal.rounds).toHaveLength(7);
 });
 test('worker: deadline exhaustion retains banked partial stock and refund without another buy',async()=>{
  const r=await fixture(120,undefined,false,{expireAfterCollect:true});expect(r.first).toMatchObject({ok:false,acquired:120,spent:360,refund:1140,banked:true,conserved:true,finalItems:120,finalCoins:1240});
  expect(r.first.failure).toContain('deadline');expect(r.second.ok).toBe(false);expect(r.placements).toBe(1);expect(r.collections).toBe(1);
 });
 for(const flag of ['throwPlacementBefore','throwPlacementAfter'] as const)test(`worker: ${flag} preserves uncertain mutation and never submits twice`,async()=>{
  const r=await fixture(300,undefined,false,{[flag]:true});expect(r.first.ok).toBe(false);expect(r.placements).toBe(1);
  expect(r.second.ok).toBe(flag==='throwPlacementAfter');expect(r.journal.phase).toBe(flag==='throwPlacementAfter'?'settled':'placing');
 });
 for(const flag of ['throwCollectionBefore','throwCollectionAfter'] as const)test(`worker: ${flag} reconciles the saved claim`,async()=>{
  const r=await fixture(300,undefined,false,{[flag]:true});expect(r.first.ok).toBe(false);expect(r.second.ok).toBe(true);expect(r.placements).toBe(1);expect(r.collections).toBe(flag==='throwCollectionBefore'?2:1);
 });
 for(const flag of ['shortCash','ownedStock'] as const)test(`worker: ${flag} refuses before placing`,async()=>{
  const r=await fixture(300,undefined,false,{[flag]:true});expect(r.first.ok).toBe(false);expect(r.placements).toBe(0);
 });
 test('worker: EXPECTED_OWNED four tops up one unit to five banked and the same key reruns without buying',async()=>{
  const r=await fixture(300,undefined,false,{topUp:{owned:4,expected:4}});
  expect(r.first).toMatchObject({ok:true,phase:'settled',quantity:1,acquired:1,spent:3,refund:2,conserved:true,banked:true,reserveKept:true,unrelated:true,finalItems:5,finalCoins:102,newItemsThisSession:1,cashDeltaThisSession:-3});
  expect(r.journal).toMatchObject({itemsBefore:4,acquired:1,request:{quantity:1,expectedOwned:4}});
  expect(r.second).toMatchObject({ok:true,finalItems:5,newItemsThisSession:0,cashDeltaThisSession:0});expect(r.placements).toBe(1);expect(r.unchanged).toBe(true);
 });
 for(const topUp of [{owned:4},{owned:3,expected:4},{owned:5,expected:4}])test(`worker: holding ${topUp.owned} with EXPECTED_OWNED ${topUp.expected??'omitted'} refuses before funding`,async()=>{
  const r=await fixture(300,undefined,false,{topUp});
  expect(r.first).toMatchObject({ok:false,phase:'unplaced',newItemsThisSession:0,cashDeltaThisSession:0,finalItems:topUp.owned});expect(r.placements).toBe(0);
  expect(r.first.failure).toContain(topUp.expected===undefined?'owned item already present':`owned item baseline ${topUp.owned} differs from EXPECTED_OWNED 4`);
 });
 test('worker: an applied collection settles on reconnect without a second collection',async()=>{
  const r=await fixture(300,'collecting',true);expect(r.first.ok).toBe(true);expect(r.collections).toBe(0);expect(r.placements).toBe(0);expect(r.unchanged).toBe(true);
 });
 test('worker: prepared intent resumes exactly once before submission',async()=>{
  const r=await fixture(300,'placing',false,{prepared:true});expect(r.first.ok).toBe(true);expect(r.second.ok).toBe(true);expect(r.placements).toBe(1);
 });
 test('worker: partial stock is banked then only the exact remainder is purchased',async()=>{
  const r=await fixture(120,undefined,false,{partialThenFull:true});expect(r.first).toMatchObject({ok:true,acquired:300,spent:900,refund:600,finalCoins:700,finalItems:300});expect(r.placements).toBe(2);expect(r.collections).toBe(2);expect(r.second.ok).toBe(true);expect(r.journal.rounds).toHaveLength(1);
 });
 test('worker: attempted but unseen placement never repeats even with unchanged assets',async()=>{
  const r=await fixture(0,'placing',false,{uncertain:true});expect(r.first.ok).toBe(false);expect(r.second.ok).toBe(false);expect(r.placements).toBe(0);
 });
 test('worker: legacy uncertain placement keeps the journal and never repeats a buy',async()=>{
  const r=await fixture(0,'placing');expect(r.first.ok).toBe(false);expect(r.journal.phase).toBe('placing');expect(r.placements).toBe(0);expect(r.collections).toBe(0);
 });
 test('worker: fill wait expires in game ticks then refunds instead of returning pending success',async()=>{
  const r=await fixture(0,undefined,false,{fillWait:3});expect(r.first).toMatchObject({ok:false,phase:'settled',pending:false,refund:1500});
  expect(r.first.ticks).toBeGreaterThanOrEqual(3);expect(r.cancels).toBe(2);
 });
 test('worker: SDK collection success without observed assets cannot settle',async()=>{
  const r=await fixture(300,undefined,false,{noCollection:true});expect(r.first).toMatchObject({ok:false,phase:'collecting',outcomeUnresolved:true});
  expect(r.placements).toBe(1);expect(r.journal.phase).toBe('collecting');
 });
 test('worker: SDK deposit success without paired bank credit cannot pass',async()=>{
  const r=await fixture(300,undefined,false,{noDeposit:true});expect(r.first).toMatchObject({ok:false,banked:false});expect(r.placements).toBe(1);
 });
 test('worker: a partial bank credit failure cannot authorize another placement',async()=>{
  const r=await fixture(120,undefined,false,{noDeposit:true});expect(r.first.ok).toBe(false);expect(r.first.banked).toBe(false);expect(r.placements).toBe(1);
 });
 test('worker: a zero reserve permits spending the exact funded budget with no coin row left',async()=>{
  const r=await fixture(300,undefined,false,{exactBudget:true});expect(r.first).toMatchObject({ok:true,conserved:true,finalCoins:0,reserveKept:true,spent:900});expect(r.second.ok).toBe(true);
 });
}

test('only a durable unsubmitted intent with unchanged assets and offer IDs may submit',()=>{
 const j={...bulkJournal(),submission:'prepared' as const};
 expect(placementRetrySafe(j,view([],1600))).toBe(true);
 for(const v of [view([],1599),view([],1600,1),view([bulkOffer()],1600)])expect(placementRetrySafe(j,v)).toBe(false);
 expect(placementRetrySafe({...j,submission:'attempted'},view([],1600))).toBe(false);
 expect(placementRetrySafe(bulkJournal(),view([],1600))).toBe(false);
});

test('partial round receipts retain cumulative stock and cost within the original request',()=>{
 const rounds=[{offerId:8,quantity:300,acquired:120,refund:1140}];
 const j=bulkJournal({rounds,phase:'settled',offerId:9,acquired:300,refund:600});
 expect(orderAccounting(j)).toMatchObject({acquired:300,spent:900,refund:600,escrow:0,outcomeUnresolved:false});
 const active=bulkOffer({quantity:180,filled:180,state:'completed',remaining:0,items:180,gross:540,coins:360});
 expect(terminalOrderClaim({...j,phase:'open'},active)).toEqual({items:180,coins:360});
 expect(orderAccounting({...j,refund:599}).outcomeUnresolved).toBe(false);
 expect(orderAccounting({...j,acquired:119}).outcomeUnresolved).toBe(true);
 expect(orderAccounting({...j,rounds:[...rounds,...rounds]}).outcomeUnresolved).toBe(true);
});

test('remainder collection preserves prior assets before and after the saved claim',()=>{
 const rounds=[{offerId:8,quantity:300,acquired:120,refund:1140}];
 const j=bulkJournal({rounds,phase:'collecting',offerId:9,claim:{coinsBefore:340,itemsBefore:120,coins:360,items:180}});
 const active=bulkOffer({quantity:180,filled:180,state:'completed',remaining:0,items:180,gross:540,coins:360});
 expect(collectionRetrySafe(j,view([active],340,120))).toBe(true);
 expect(collectionApplied(j,view([],700,300))).toBe(true);
 expect(collectionApplied(j,view([],700,180))).toBe(false);
 expect(collectionApplied(j,view([],701,300))).toBe(false);
 expect(reconcilePlacement({...j,phase:'placing',offerId:undefined},view([active],340,120))?.id).toBe(9);
 expect(()=>reconcilePlacement({...j,phase:'placing',offerId:undefined},view([active],340,0))).toThrow('baseline');
});

test('a buy that starts on the Gnome battlefield walks to the Ardougne north bank first, with auto-retaliate off for the walk',async()=>{
 expect(onBattlefield({x:2529,z:3236,level:0})).toBe(true);
 expect(onBattlefield({x:2619,z:3332,level:0})).toBe(false);expect(onBattlefield({x:2575,z:3269,level:1})).toBe(false);expect(onBattlefield({x:3185,z:3436,level:0})).toBe(false);
 const fixture=(at:{worldX:number;worldZ:number;level:number},hp=60)=>{
  const player={...at,lifeId:1,respawnCount:0},clicks:number[]=[];let retaliate=true,tick=0;
  const s={sdk:{getState:()=>({player,autoRetaliateEnabled:retaliate}),getStateAge:()=>0,getSkill:()=>({level:hp})},tick:()=>tick++,ended:new Promise(()=>{}),onTick:()=>()=>{},
   direct:async(a:{componentId:number})=>{clicks.push(a.componentId);retaliate=a.componentId===150;return{success:true};}} as unknown as Session;
  return{s,player,clicks,retaliate:()=>retaliate};
 };
 const log=spyOn(console,'log').mockImplementation(()=>{});
 try{
  const field=fixture({worldX:2529,worldZ:3236,level:0});let walks=0,during:boolean|undefined;
  expect(await leaveBattlefield(field.s,()=>false,async to=>{walks++;during=field.retaliate();expect(to).toEqual(ARDOUGNE_NORTH);Object.assign(field.player,{worldX:2619,worldZ:3332});return{ok:true};})).toBe(true);
  expect(walks).toBe(1);expect(during).toBe(false);expect(field.clicks).toEqual([151,150]);expect(field.retaliate()).toBe(true);
  const bank=fixture({worldX:2619,worldZ:3332,level:0});
  expect(await leaveBattlefield(bank.s,()=>false,async()=>{throw Error('no walk expected');})).toBe(false);expect(bank.clicks).toEqual([]);
  const stuck=fixture({worldX:2529,worldZ:3236,level:0});
  await expect(leaveBattlefield(stuck.s,()=>false,async()=>({ok:false,detail:'no route'}))).rejects.toThrow('walk from the battlefield to the Ardougne north bank failed: no route');
  expect(stuck.retaliate()).toBe(true);
  await expect(leaveBattlefield(fixture({worldX:2529,worldZ:3236,level:0},10).s,()=>false,async()=>({ok:true}))).rejects.toThrow('10 HP or less');
 }finally{log.mockRestore();}
});

test('the health preparation eats the cheapest owned meal, sharks included', () => {
 expect(HEAL_FOOD[0]).toBe(333);
 expect(HEAL_FOOD).toContain(385);
 expect(HEAL_FOOD.indexOf(329)).toBeLessThan(HEAL_FOOD.indexOf(385));
});

test('a refused round names its cause and numbers: deadline, stop, coins under escrow plus reserve, pack over 26',()=>{
 const ok={now:1000,deadline:5000,over:false,coins:161000,escrow:160000,quantity:16,limit:10000,reserve:1000,pack:10};
 expect(orderRefusal(ok)).toBeNull();
 expect(orderRefusal({...ok,now:8000})).toMatch(/^order deadline passed 3 s ago \(deadline 1970-01-01T00:00:05\.000Z\)$/);
 expect(orderRefusal({...ok,over:true})).toMatch(/^order stopped: /);
 expect(orderRefusal({...ok,coins:160940})).toBe('coins 160940 are under the escrow 160000 (16 x 10000) plus the reserve 1000: 60 short');
 expect(orderRefusal({...ok,pack:27})).toBe('pack holds 27 items, over 26: two collection slots unavailable');
 expect(orderRefusal({...ok,pack:26})).toBeNull();
 expect(orderRefusal({...ok,now:9000,coins:0})).toMatch(/^order deadline passed/);
});

const exchange=(controls:string[])=>{
 const calls:boolean[]=[];
 const collect=async(_id:number,notes:boolean):Promise<GEActionResult>=>{
  calls.push(notes);const name=notes?'collectNotes':'collect';
  if(!controls.includes(name))return{success:false,reason:'no_control',message:`GE control ${name} is unavailable on this screen.`};
  return{success:true,message:'Collected 0 items and 30000 gp. Any overflow remains in the exchange.',items:0,coins:30000};
 };
 return{calls,collect};
};

test('coins-only claim without a notes control is collected plain',async()=>{
 const ge=exchange(['collect']);
 const r=await collectClaim(ge.collect,72144,true);
 expect(r.success).toBe(true);expect(r.coins).toBe(30000);expect(ge.calls).toEqual([true,false]);
});
test('notes control present is used once',async()=>{
 const ge=exchange(['collect','collectNotes']);
 expect((await collectClaim(ge.collect,72144,true)).success).toBe(true);expect(ge.calls).toEqual([true]);
});
test('a dispatched failure is never retried',async()=>{
 const calls:boolean[]=[];
 const r=await collectClaim(async(_id,notes)=>{calls.push(notes);return{success:false,reason:'timeout',outcome:'unknown',message:'GE result was not observed.'};},72144,true);
 expect(r.success).toBe(false);expect(calls).toEqual([true]);
});

const acctReq={actor:'flfixture',server:'localhost:8888',goal:'proof',item:1331,limit:45000,reserve:5000,createdAt:1000,reviewAt:2000,deadline:3000};
const acctJournal=(phase:ItemOrder['phase']):ItemOrder=>({version:1,request:acctReq,phase,coinsBefore:50015,itemsBefore:0,previousIds:[],at:1000});
test('unknown mutation outcomes never report unproved escrow as a known asset',()=>{for(const phase of ['placing','cancelling','collecting'] as const)expect(orderAccounting(acctJournal(phase))).toMatchObject({escrow:null,maximumExposure:45000,outcomeUnresolved:true,acquired:0,spent:0});});
test('confirmed open order retains its known reserved amount',()=>{expect(orderAccounting({...acctJournal('open'),offerId:1})).toMatchObject({escrow:45000,maximumExposure:45000,outcomeUnresolved:false,spent:0});});
test('settled fill reports only reconciled spend and clears outstanding exposure',()=>{expect(orderAccounting({...acctJournal('settled'),acquired:1,refund:5000})).toEqual({acquired:1,refund:5000,spent:40000,escrow:0,maximumExposure:0,outcomeUnresolved:false});});
test('settled cancellation is a refund, not a purchase',()=>{expect(orderAccounting({...acctJournal('settled'),acquired:0,refund:45000})).toMatchObject({acquired:0,refund:45000,spent:0,escrow:0,maximumExposure:0});});
test('no order implies no outstanding exposure',()=>{expect(orderAccounting()).toMatchObject({escrow:0,maximumExposure:0,outcomeUnresolved:false});});

test('a settled label without complete conserved counters cannot fabricate an acquisition cost',()=>{
 for(const extra of [{},{acquired:0,refund:0},{acquired:1,refund:45001},{acquired:2,refund:0},{acquired:1,refund:-1}]){
  expect(orderAccounting({...acctJournal('settled'),...extra})).toMatchObject({acquired:0,spent:0,escrow:null,maximumExposure:45000,outcomeUnresolved:true});
 }
});
test('a privately observed filled open order separates execution cost from refundable cash',()=>{
 const progress={actor:acctReq.actor,server:acctReq.server,offerId:7,itemId:1331,side:'buy' as const,quantity:1,limit:45000,filled:1,gross:40000,tax:0,at:1500};
 expect(orderAccounting({...acctJournal('open'),offerId:7,progress})).toMatchObject({acquired:0,spent:40000,escrow:5000,maximumExposure:45000,outcomeUnresolved:false});
 expect(orderAccounting({...acctJournal('settled'),offerId:7,progress,acquired:1,refund:4999}).outcomeUnresolved).toBe(true);
 expect(orderAccounting({...acctJournal('open'),offerId:8,progress}).outcomeUnresolved).toBe(true);
});

const saleJournal=():SaleJournal=>({version:1,request:{actor:'seller',server:'localhost:19081',goal:'surplus',item:1511,quantity:3,price:100,floor:90,reserveItems:2,deadline:Date.now()+60000},phase:'attempted',coinsBefore:15,itemsBefore:5,previousIds:[]});
const saleOffer=()=>({id:1,slot:0,item:1511,name:'Logs',side:'sell' as const,quantity:3,price:100,remaining:1,filled:2,state:'open' as 'open'|'cancelled'|'completed',items:0,coins:190,gross:200,tax:10});
const saleView=():SaleView=>({actor:'seller',server:'localhost:19081',coins:15,items:2,offers:[saleOffer()]});

it('explicit Finish keeps only a fresh identified owned sell resting without cancel or collection',async()=>{
 const j=saleJournal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-resting-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));let cancelled=0,collected=0;const inventory=[{id:995,count:15},{id:1511,count:2}],o=saleOffer();
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:99}),getInventory:()=>inventory,getGEState:()=>({offers:[o]})},bot:{openGE:async()=>({success:true}),cancelGEOffer:async()=>{cancelled++;},collectGEOffer:async()=>{collected++;}}};
 try{const r=await runOwnedSale(s,j.request,path,()=>false,0,false,{leaveOpen:true});expect(r).toMatchObject({ok:true,resting:true,settled:false,banked:false,offer:{id:1,filled:2,remaining:1,itemsEscrow:1,unfilledItems:1,collectibleItems:0,coinsEscrow:190}});expect(cancelled+collected).toBe(0);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('open');o.price=99;const changed=await runOwnedSale(s,j.request,path,()=>false,0,false,{leaveOpen:true});expect(changed.ok).toBe(false);expect(cancelled+collected).toBe(0);}finally{unlinkSync(path);}
});
it('Finish leaveOpen never overrides a stop: explicit existing escrow cancels and collects',async()=>{
 const j=saleJournal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-resting-stop-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));let cancelled=0,collected=0,offers=[saleOffer()];const inventory=[{id:995,count:15},{id:1511,count:2}];
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:99}),getInventory:()=>inventory,getGEState:()=>({offers})},bot:{openGE:async()=>({success:true}),cancelGEOffer:async()=>{cancelled++;offers[0]!.state='cancelled';offers[0]!.remaining=0;offers[0]!.items=1;return{success:true};},collectGEOffer:async()=>{collected++;inventory[0]!.count+=190;inventory[1]!.count++;offers=[];return{success:true};}}};
 try{const r=await runOwnedSale(s,j.request,path,()=>true,0,false,{leaveOpen:true});expect(r.ok).toBe(true);expect(r.resting).not.toBe(true);expect(cancelled).toBe(1);expect(collected).toBe(1);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('settled');}finally{unlinkSync(path);}
});
it('Finish cleanup cannot bypass original-life, HP or caller-fatal change during exchange await',async()=>{
 for(const change of ['life','hp','fatal']as const){const j=saleJournal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-finish-fatal-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));const player={worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false};let hp=99,fatal=false,mutations=0;
  const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:hp}),getInventory:()=>[{id:995,count:15},{id:1511,count:2}],getGEState:()=>({offers:[saleOffer()]})},bot:{openGE:async()=>{if(change==='life')player.lifeId=2;if(change==='hp')hp=98;if(change==='fatal')fatal=true;return{success:true};},cancelGEOffer:async()=>{mutations++;},collectGEOffer:async()=>{mutations++;}}};
  try{const r=await runOwnedSale(s,j.request,path,()=>true,0,false,{leaveOpen:true,fatal:()=>fatal});expect(r.ok).toBe(false);expect(r.error).toContain('original life/HP');expect(mutations).toBe(0);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('open');}finally{unlinkSync(path);}
 }
});
describe('owned finite sell journal',()=>{
 it('checks floor and finite lot',()=>{validateSale(saleJournal().request);expect(()=>validateSale({...saleJournal().request,price:89})).toThrow();expect(()=>validateSale({...saleJournal().request,quantity:Infinity})).toThrow();});
 it('recovers lost placement by exact escrow and private ID',()=>{expect(salePlacement(saleJournal(),saleView())?.id).toBe(1);expect(()=>salePlacement(saleJournal(),{...saleView(),items:3})).toThrow();expect(()=>salePlacement(saleJournal(),{...saleView(),offers:[saleOffer(),{...saleOffer(),id:2}]})).toThrow();});
 it('waits for offer-first pack-later but rejects wrong terminal escrow',()=>{const first={...saleView(),items:5};expect(salePlacementReady(saleJournal(),first)).toBe(false);expect(salePlacementReady(saleJournal(),saleView())).toBe(true);expect(()=>salePlacement(saleJournal(),first)).toThrow('sale escrow debit mismatch');expect(()=>salePlacementReady(saleJournal(),{...saleView(),offers:[saleOffer(),{...saleOffer(),id:2}]})).toThrow('ambiguous');});
 it('requires cumulative fee and monotonic fill',()=>{const j={...saleJournal(),offerId:1};j.progress=saleProgress(j,saleOffer());expect(()=>saleProgress(j,{...saleOffer(),filled:1,gross:100,tax:5})).toThrow();expect(()=>saleProgress(j,{...saleOffer(),tax:9})).toThrow();});
 it('keeps cumulative rounding across separate fills',()=>{const j={...saleJournal(),offerId:1};j.progress=saleProgress(j,{...saleOffer(),filled:1,gross:119,tax:5,coins:114});const next=saleProgress(j,{...saleOffer(),filled:2,gross:228,tax:11,coins:217});expect(next.tax-j.progress.tax).toBe(6);});
 it('closes partial cancel with unsold stock plus net proceeds',()=>{const j={...saleJournal(),offerId:1};const o={...saleOffer(),state:'cancelled' as const,remaining:0,items:1};j.progress=saleProgress(j,o);j.claim=saleClaim(j,o);expect(j.claim).toEqual({items:1,coins:190});expect(saleCollected(j,{...saleView(),offers:[],items:3,coins:205})).toBe(true);expect(saleCollected(j,{...saleView(),offers:[],items:4,coins:205})).toBe(false);expect(()=>saleClaim(j,{...o,items:2})).toThrow();});
});

it('CLI global stop callback prevents exchange entry and owned escrow dispatch',async()=>{
 let opens=0,placements=0;const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:50})},bot:{openGE:async()=>{opens++;return{success:true};},placeGEOffer:async()=>{placements++;return{success:true};}}};
 const stop=()=>saleStopRequested('seller',path=>path===resolve('.practice','stop-all'));
 const result=await runOwnedSale(s,saleJournal().request,resolve(tmpdir(),'ge-stop-'+randomUUID()+'.json'),stop,40);
 expect(result.ok).toBe(false);expect(result.error).toContain('sale stopped before exchange');expect(opens).toBe(0);expect(placements).toBe(0);expect(result.journal).toBeUndefined();
});

it('runBankBidSale withdraws noted bank stock, collects filled coins, and banks proceeds + unsold remainder while keeping reserves',async()=>{
 const catalogue=[{id:861,name:'Magic shortbow'}];
 const path=resolve(tmpdir(),'ge-bank-sale-'+randomUUID()+'.json');
 const bank:any[]=[{id:861,name:'Magic shortbow',count:25,slot:0},{id:995,name:'Coins',count:500,slot:1}];
 const inv:any[]=[{id:995,name:'Coins',count:40,slot:0}];
 let gen=0,bankOpen=false,geOpen=false;const player={worldX:2619,worldZ:3332,level:0,lifeId:1,respawnCount:0,isDead:false};
 const offers:any[]=[];const walked:string[]=[];
 const s:any={name:'yewfirst',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),bankObservation:()=>bankOpen?{generation:gen,items:bank}:null,sdk:{
  getState:()=>({player,bank:{isOpen:bankOpen,items:bank}}),getStateAge:()=>0,getSkill:()=>({level:50}),getInventory:()=>inv,getGEState:()=>({offers}),
 },bot:{
  openBank:async()=>{bankOpen=true;geOpen=false;gen++;return{success:true};},
  closeBank:async()=>{bankOpen=false;return{success:true};},
  withdrawItem:async(target:any,n:number,opts?:{asNote?:boolean})=>{
   const row=bank.find((i:any)=>i.id===target.id||i.id===target)!;row.count-=n;
   const noteId=opts?.asNote?862:row.id;inv.push({id:noteId,name:row.name,count:n,slot:inv.length});gen++;return{success:true};
  },
  openGE:async()=>{geOpen=true;bankOpen=false;return{success:true};},
  placeGEOffer:async(req:{item:number;quantity:number;price:number})=>{
   const idx=inv.findIndex((i:any)=>i.id===862||i.id===req.item);inv.splice(idx,1);
   offers.push({id:77,slot:0,item:req.item,name:'Magic shortbow',side:'sell',quantity:req.quantity,price:req.price,remaining:0,filled:req.quantity,state:'completed',items:0,coins:req.quantity*req.price-Math.floor(req.quantity*req.price/20),gross:req.quantity*req.price,tax:Math.floor(req.quantity*req.price/20)});
   return{success:true};
  },
  collectGEOffer:async()=>{
   const o=offers.pop()!;inv.find((i:any)=>i.id===995)!.count+=o.coins;return{success:true};
  },
 }};
 const walk=async(to:{x:number;z:number})=>{walked.push(`${to.x},${to.z}`);player.worldX=to.x;player.worldZ=to.z;return true;};
 const deposit=async(item:{id:number;count:number},amount=-1)=>{
  const row=inv.find((i:any)=>i.id===item.id)!;const take=amount===-1?row.count:Math.min(amount,row.count);
  row.count-=take;if(row.count<=0)inv.splice(inv.indexOf(row),1);
  const b=bank.find((i:any)=>i.id===item.id);if(b)b.count+=take;else bank.push({id:item.id,name:'Magic shortbow',count:take,slot:bank.length});
  return take;
 };
 const req={actor:'YewFirst',server:'localhost:19081',goal:'bid-861',item:861,quantity:17,price:95000,floor:95000,reserveItems:8,deadline:Date.now()+60000};
 try{
  const blocked=await runBankBidSale(s,{...req,quantity:18},path,()=>false,0,false,{walk,deposit,catalogue});
  expect(blocked.ok).toBe(false);expect(blocked.error).toContain('surplus short');
  const res=await runBankBidSale(s,req,path,()=>false,0,false,{walk,deposit,catalogue});
  expect(res.ok).toBe(true);expect(res.banked).toBe(true);
  expect(bank.find((i:any)=>i.id===861).count).toBe(8);
  expect(bank.find((i:any)=>i.id===995).count).toBe(500+1534250);
  expect(inv.find((i:any)=>i.id===995).count).toBe(40);
  const walkedBefore=walked.length;
  const replay=await runBankBidSale(s,req,path,()=>false,0,false,{walk,deposit,catalogue});
  expect(replay.ok).toBe(true);expect(replay.replay).toBe(true);expect(walked.length).toBe(walkedBefore);
 }finally{try{unlinkSync(path);}catch{}}
});

it('runBankBidSale recovers in-flight exchange escrow directly at GE without visiting bank first',async()=>{
 const catalogue=[{id:1779,name:'Flax'}];
 const path=resolve(tmpdir(),'ge-bank-recover-'+randomUUID()+'.json');
 const req={actor:'Ballspinner',server:'localhost:19081',goal:'bid-1779',item:1779,quantity:10,price:80,floor:80,reserveItems:0,deadline:Date.now()+60000};
 const active:SaleJournal={version:1,request:req,phase:'open',coinsBefore:0,itemsBefore:10,previousIds:[],offerId:99};
 writeFileSync(path,JSON.stringify(active));
 const bank:any[]=[{id:995,name:'Coins',count:0,slot:0}],inv:any[]=[{id:995,name:'Coins',count:0,slot:0}];
 const offers:any[]=[{id:99,slot:0,item:1779,name:'Flax',side:'sell',quantity:10,price:80,remaining:4,filled:6,state:'open',items:0,coins:456,gross:480,tax:24}];
 const player={worldX:2619,worldZ:3332,level:0,lifeId:1,respawnCount:0,isDead:false};const walked:string[]=[];
 let gen=0,bankOpen=false;
 const s:any={name:'ballspinner',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),bankObservation:()=>bankOpen?{generation:gen,items:bank}:null,sdk:{
  getState:()=>({player,bank:{isOpen:bankOpen,items:bank}}),getStateAge:()=>0,getSkill:()=>({level:50}),getInventory:()=>inv,getGEState:()=>({offers}),
 },bot:{
  openBank:async()=>{bankOpen=true;gen++;return{success:true};},closeBank:async()=>{bankOpen=false;return{success:true};},openGE:async()=>{if(player.worldX<3180)throw Error('not at GE');return{success:true};},
  cancelGEOffer:async()=>{offers[0].state='cancelled';offers[0].remaining=0;offers[0].items=4;return{success:true};},
  collectGEOffer:async()=>{const o=offers.pop()!;inv[0].count+=o.coins;inv.push({id:1780,name:'Flax',count:o.items,slot:1});return{success:true};},
 }};
 const walk=async(to:{x:number;z:number})=>{walked.push(`${to.x},${to.z}`);player.worldX=to.x;player.worldZ=to.z;return true;};
 const deposit=async(item:{id:number;count:number},amount=-1)=>{
  const row=inv.find((i:any)=>i.id===item.id)!;const take=amount===-1?row.count:Math.min(amount,row.count);
  row.count-=take;if(row.count<=0)inv.splice(inv.indexOf(row),1);
  const b=bank.find((i:any)=>i.id===item.id);if(b)b.count+=take;else bank.push({id:item.id,name:'Flax',count:take,slot:bank.length});
  return take;
 };
 try{
  const res=await runBankBidSale(s,req,path,()=>false,0,true,{walk,deposit,catalogue});
  expect(res.ok).toBe(true);expect(res.banked).toBe(true);
  expect(walked).toEqual(['3184,3440','3185,3436']);
  expect(bank.find((i:any)=>i.id===995).count).toBe(456);
  expect(bank.find((i:any)=>i.id===1780).count).toBe(4);
 }finally{try{unlinkSync(path);}catch{}}
});
