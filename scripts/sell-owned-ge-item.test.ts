import{resolve}from'node:path';import{tmpdir}from'node:os';import{randomUUID}from'node:crypto';
import{writeFileSync,readFileSync,unlinkSync}from'node:fs';
import {describe,it,expect} from 'bun:test';
import {saleStopRequested,runOwnedSale,runBankBidSale,validateSale,salePlacement,salePlacementReady,saleProgress,saleClaim,saleCollected,type SaleJournal,type SaleView} from './sell-owned-ge-item';
const journal=():SaleJournal=>({version:1,request:{actor:'seller',server:'localhost:19081',goal:'surplus',item:1511,quantity:3,price:100,floor:90,reserveItems:2,deadline:Date.now()+60000},phase:'attempted',coinsBefore:15,itemsBefore:5,previousIds:[]});
const offer=()=>({id:1,slot:0,item:1511,name:'Logs',side:'sell' as const,quantity:3,price:100,remaining:1,filled:2,state:'open' as 'open'|'cancelled'|'completed',items:0,coins:190,gross:200,tax:10});
const view=():SaleView=>({actor:'seller',server:'localhost:19081',coins:15,items:2,offers:[offer()]});

it('explicit Finish keeps only a fresh identified owned sell resting without cancel or collection',async()=>{
 const j=journal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-resting-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));let cancelled=0,collected=0;const inventory=[{id:995,count:15},{id:1511,count:2}],o=offer();
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:99}),getInventory:()=>inventory,getGEState:()=>({offers:[o]})},bot:{openGE:async()=>({success:true}),cancelGEOffer:async()=>{cancelled++;},collectGEOffer:async()=>{collected++;}}};
 try{const r=await runOwnedSale(s,j.request,path,()=>false,0,false,{leaveOpen:true});expect(r).toMatchObject({ok:true,resting:true,settled:false,banked:false,offer:{id:1,filled:2,remaining:1,itemsEscrow:1,unfilledItems:1,collectibleItems:0,coinsEscrow:190}});expect(cancelled+collected).toBe(0);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('open');o.price=99;const changed=await runOwnedSale(s,j.request,path,()=>false,0,false,{leaveOpen:true});expect(changed.ok).toBe(false);expect(cancelled+collected).toBe(0);}finally{unlinkSync(path);}
});
it('Finish leaveOpen never overrides a stop: explicit existing escrow cancels and collects',async()=>{
 const j=journal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-resting-stop-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));let cancelled=0,collected=0,offers=[offer()];const inventory=[{id:995,count:15},{id:1511,count:2}];
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:99}),getInventory:()=>inventory,getGEState:()=>({offers})},bot:{openGE:async()=>({success:true}),cancelGEOffer:async()=>{cancelled++;offers[0]!.state='cancelled';offers[0]!.remaining=0;offers[0]!.items=1;return{success:true};},collectGEOffer:async()=>{collected++;inventory[0]!.count+=190;inventory[1]!.count++;offers=[];return{success:true};}}};
 try{const r=await runOwnedSale(s,j.request,path,()=>true,0,false,{leaveOpen:true});expect(r.ok).toBe(true);expect(r.resting).not.toBe(true);expect(cancelled).toBe(1);expect(collected).toBe(1);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('settled');}finally{unlinkSync(path);}
});
it('Finish cleanup cannot bypass original-life, HP or caller-fatal change during exchange await',async()=>{
 for(const change of ['life','hp','fatal']as const){const j=journal();j.phase='open';j.offerId=1;const path=resolve(tmpdir(),'ge-finish-fatal-'+randomUUID()+'.json');writeFileSync(path,JSON.stringify(j));const player={worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false};let hp=99,fatal=false,mutations=0;
  const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getStateAge:()=>0,getSkill:()=>({level:hp}),getInventory:()=>[{id:995,count:15},{id:1511,count:2}],getGEState:()=>({offers:[offer()]})},bot:{openGE:async()=>{if(change==='life')player.lifeId=2;if(change==='hp')hp=98;if(change==='fatal')fatal=true;return{success:true};},cancelGEOffer:async()=>{mutations++;},collectGEOffer:async()=>{mutations++;}}};
  try{const r=await runOwnedSale(s,j.request,path,()=>true,0,false,{leaveOpen:true,fatal:()=>fatal});expect(r.ok).toBe(false);expect(r.error).toContain('original life/HP');expect(mutations).toBe(0);expect(JSON.parse(readFileSync(path,'utf8')).phase).toBe('open');}finally{unlinkSync(path);}
 }
});
describe('owned finite sell journal',()=>{
 it('checks floor and finite lot',()=>{validateSale(journal().request);expect(()=>validateSale({...journal().request,price:89})).toThrow();expect(()=>validateSale({...journal().request,quantity:Infinity})).toThrow();});
 it('recovers lost placement by exact escrow and private ID',()=>{expect(salePlacement(journal(),view())?.id).toBe(1);expect(()=>salePlacement(journal(),{...view(),items:3})).toThrow();expect(()=>salePlacement(journal(),{...view(),offers:[offer(),{...offer(),id:2}]})).toThrow();});
 it('waits for offer-first pack-later but rejects wrong terminal escrow',()=>{const first={...view(),items:5};expect(salePlacementReady(journal(),first)).toBe(false);expect(salePlacementReady(journal(),view())).toBe(true);expect(()=>salePlacement(journal(),first)).toThrow('sale escrow debit mismatch');expect(()=>salePlacementReady(journal(),{...view(),offers:[offer(),{...offer(),id:2}]})).toThrow('ambiguous');});
 it('requires cumulative fee and monotonic fill',()=>{const j={...journal(),offerId:1};j.progress=saleProgress(j,offer());expect(()=>saleProgress(j,{...offer(),filled:1,gross:100,tax:5})).toThrow();expect(()=>saleProgress(j,{...offer(),tax:9})).toThrow();});
 it('keeps cumulative rounding across separate fills',()=>{const j={...journal(),offerId:1};j.progress=saleProgress(j,{...offer(),filled:1,gross:119,tax:5,coins:114});const next=saleProgress(j,{...offer(),filled:2,gross:228,tax:11,coins:217});expect(next.tax-j.progress.tax).toBe(6);});
 it('closes partial cancel with unsold stock plus net proceeds',()=>{const j={...journal(),offerId:1};const o={...offer(),state:'cancelled' as const,remaining:0,items:1};j.progress=saleProgress(j,o);j.claim=saleClaim(j,o);expect(j.claim).toEqual({items:1,coins:190});expect(saleCollected(j,{...view(),offers:[],items:3,coins:205})).toBe(true);expect(saleCollected(j,{...view(),offers:[],items:4,coins:205})).toBe(false);expect(()=>saleClaim(j,{...o,items:2})).toThrow();});
});

it('CLI global stop callback prevents exchange entry and owned escrow dispatch',async()=>{
 let opens=0,placements=0;const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:{worldX:3181,worldZ:3443,level:0,lifeId:1,respawnCount:0,isDead:false}}),getStateAge:()=>0,getSkill:()=>({level:50})},bot:{openGE:async()=>{opens++;return{success:true};},placeGEOffer:async()=>{placements++;return{success:true};}}};
 const stop=()=>saleStopRequested('seller',path=>path===resolve('.practice','stop-all'));
 const result=await runOwnedSale(s,journal().request,resolve(tmpdir(),'ge-stop-'+randomUUID()+'.json'),stop,40);
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
  // Rejects when bank surplus violates reserveItems (25 held, 18+8 = 26 > 25).
  const blocked=await runBankBidSale(s,{...req,quantity:18},path,()=>false,0,false,{walk,deposit,catalogue});
  expect(blocked.ok).toBe(false);expect(blocked.error).toContain('surplus short');
  // Sells 17 noted bows (1615000 gross, 80750 tax, 1534250 net), keeps 8 bows & deposits exact net coins.
  const res=await runBankBidSale(s,req,path,()=>false,0,false,{walk,deposit,catalogue});
  expect(res.ok).toBe(true);expect(res.banked).toBe(true);
  expect(bank.find((i:any)=>i.id===861).count).toBe(8);
  expect(bank.find((i:any)=>i.id===995).count).toBe(500+1534250);
  expect(inv.find((i:any)=>i.id===995).count).toBe(40);
  // Settled replay does not re-walk or double-deposit.
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
