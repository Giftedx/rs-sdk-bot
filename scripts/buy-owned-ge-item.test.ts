import {test,expect} from 'bun:test';import {reconcilePlacement,collectionApplied,collectionRetrySafe,validateRequest,marketTileSafe,observeOrderProgress,terminalOrderClaim,orderAccounting,orderItemMatcher,orderEscrow,placementRetrySafe,type ItemOrder,type OrderView} from './buy-owned-ge-item';
import type {GEOffer} from '../vendor/rs-sdk/sdk/ge-types';
import {mock} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const request={actor:'Abracadickra',server:'rs-sdk-demo.fly.dev',goal:'combat-sword',item:1331,limit:45000,reserve:5000,createdAt:1000,reviewAt:2000,deadline:3000};
const offer=(extra:Partial<GEOffer>={}):GEOffer=>({id:9,slot:0,item:1331,name:'Adamant scimitar',side:'buy',quantity:1,price:45000,remaining:1,filled:0,state:'open',items:0,coins:0,gross:0,tax:0,...extra});
const journal=():ItemOrder=>({version:1,request,phase:'placing',coinsBefore:50000,itemsBefore:0,previousIds:[2],at:1000});
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
 for(const extra of [{item:0},{limit:-1},{limit:2147483648},{reserve:-1},{deadline:1500},{reviewAt:999}])expect(()=>validateRequest({...request,...extra})).toThrow();
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

// Isolate the walking substitute from every other test file. No client, account or server is opened.
if(process.env.GE_BUYER_WORKER_TEST!=='1')test('worker paths run in an isolated simulated session',()=>{
 const child=Bun.spawnSync([process.execPath,'test',import.meta.path,'--test-name-pattern','^worker:','--timeout','15000'],
  {env:{...process.env,GE_BUYER_WORKER_TEST:'1'},timeout:30000,stdout:'pipe',stderr:'pipe'});
 expect(child.stderr.toString()).toContain('0 fail');expect(child.exitCode).toBe(0);
});
else{
 mock.module('../packages/core/src/walk',()=>({
  sessionWalker:async(s:any)=>({s,plan:()=>[]}),expandPath:()=>[],
  walkPath:async(d:any,points:any[])=>{const p=points[0];Object.assign(d.s.sdk.getState().player,{worldX:p.x,worldZ:p.z});return{ok:true};},
 }));
 const {runOwnedItem}=await import('./buy-owned-ge-item');
 type Row={id:number;name:string;count:number;slot:number};
 async function fixture(filled:number,phase?:ItemOrder['phase'],applied=false,options:{fillWait?:number;noCollection?:boolean;noDeposit?:boolean;exactBudget?:boolean;lowHp?:boolean;noFood?:boolean;noHeal?:boolean;prepared?:boolean;partialThenFull?:boolean;expireAfterCollect?:boolean;uncertain?:boolean;throwPlacementBefore?:boolean;throwPlacementAfter?:boolean;throwCollectionBefore?:boolean;throwCollectionAfter?:boolean;shortCash?:boolean;ownedStock?:boolean}={}){
  const dir=mkdtempSync(join(tmpdir(),'ge-worker-')),path=join(dir,'journal.json');
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  const req={...bulkRequest,createdAt:Date.now(),reviewAt:Date.now()+10000,deadline:Date.now()+20000};
  if(options.exactBudget){req.limit=3;req.reserve=0;}
  const escrow=orderEscrow(req);
  let generation=1,tick=0,placements=0,collections=0,cancels=0,hp=options.lowHp?3:10;
  const callbacks=new Set<()=>void>(),row=(id:number,count:number):Row=>({id,count,name:id===995?'Coins':'Grapes',slot:0});
  const state={player:{worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0},inventory:[] as Row[],bank:{isOpen:false,items:[row(995,escrow+req.reserve)]}};
  let offers:GEOffer[]=[];
  if(options.shortCash)state.bank.items[0]!.count--;
  if(options.ownedStock)state.bank.items.push(row(1987,1));
  if(options.lowHp&&!options.noFood)state.bank.items.push({...row(329,2),name:'Salmon'});
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
  const bot={dismissBlockingUI:async()=>{},openBank:async()=>{state.bank.isOpen=true;generation++;return{success:true};},
   closeBank:async()=>{state.bank.isOpen=false;return{success:true};},openGE:async()=>({success:true}),
   withdrawItem:async(item:Row,n:number)=>{state.bank.items.find(i=>i.id===item.id)!.count-=n;state.bank.items=state.bank.items.filter(i=>i.count>0);state.inventory.push({...item,count:n,slot:0});generation++;return{success:true};},
   eatFood:async(item:Row)=>{if(!options.noHeal){state.inventory=state.inventory.filter(i=>i.id!==item.id);hp=10;}return{success:true};},
   depositItem:async(i:Row)=>{if(options.noDeposit)return{success:true};const n=state.inventory.filter(r=>r.id===i.id).reduce((a,r)=>a+r.count,0),id=i.id===1988?1987:i.id;
    state.inventory=state.inventory.filter(r=>r.id!==i.id);const bank=state.bank.items.find(r=>r.id===id);if(bank)bank.count+=n;else state.bank.items.push(row(id,n));generation++;return{success:true};},
   placeGEOffer:async(r:{quantity:number;price:number})=>{placements++;if(options.throwPlacementBefore&&placements===1)throw Error('placement interrupted before mutation');state.inventory=state.inventory.filter(i=>i.id!==995);const n=options.partialThenFull&&placements>1?r.quantity:Math.min(filled,r.quantity);offers=[bulkOffer({id:9+placements,quantity:r.quantity,price:r.price,filled:n,remaining:r.quantity-n,state:n===r.quantity?'completed':'open',items:n,gross:n*3,coins:n===r.quantity?r.quantity*r.price-n*3:0})];if(options.throwPlacementAfter&&placements===1)throw Error('placement interrupted after mutation');return{success:true};},
   cancelGEOffer:async()=>{cancels++;const o=offers[0]!;offers=[{...o,state:'cancelled',remaining:0,coins:o.quantity*o.price-o.gross}];return{success:true};},
   collectGEOffer:async()=>{collections++;if(options.throwCollectionBefore&&collections===1)throw Error('collection interrupted before mutation');if(options.noCollection)return{success:true};const o=offers[0]!;state.inventory=[...(o.coins?[row(995,o.coins)]:[]),...(o.items?[row(1988,o.items)]:[])];offers=[];if(options.expireAfterCollect)now=req.deadline;if(options.throwCollectionAfter&&collections===1)throw Error('collection interrupted after mutation');return{success:true};}};
  const session={name:req.actor,sdk,bot,tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{callbacks.add(cb);return()=>callbacks.delete(cb);},
   bankObservation:()=>({generation,items:state.bank.items.map(i=>({...i})),at:Date.now()})};
  const timer=setInterval(()=>{tick++;for(const cb of [...callbacks])cb();},1);
  try{
   const run=()=>runOwnedItem(session as any,req,path,()=>false,false,options.fillWait??0);
   const first=await run(),before=JSON.stringify(state.bank.items),second=await run();
   return{first,second,placements,collections,cancels,unchanged:before===JSON.stringify(state.bank.items),journal:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null};
  }finally{Date.now=originalNow;clearInterval(timer);rmSync(dir,{recursive:true,force:true});}
 }
 test('worker: full fill banks the exact stock and a settled rerun does not buy',async()=>{
  const r=await fixture(300);expect(r.first).toMatchObject({ok:true,targetMet:true,banked:true,reserveKept:true,spent:900,finalCoins:700,finalItems:300});
  expect(r.second).toMatchObject({ok:true,newItemsThisSession:0,cashDeltaThisSession:0});expect(r.placements).toBe(1);expect(r.collections).toBe(1);expect(r.unchanged).toBe(true);
 });
 test('worker: low HP at the supported bank uses one owned salmon before funding',async()=>{
  const r=await fixture(300,undefined,false,{lowHp:true});
  expect(r.first).toMatchObject({ok:true,unrelated:true,foodUsed:[{id:329,count:1}],finalItems:300,finalCoins:700});
  expect(r.second.ok).toBe(true);expect(r.placements).toBe(1);
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
