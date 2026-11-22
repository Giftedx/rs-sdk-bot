import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionWalker } from '../../core/src/walk';
import {
    bankSellerPrice,
    bankSellerPrices,
    bidPlan,
    buyListStop,
    chunkTooDear,
    fetchMarket,
    fetchQuote,
    floatNeed,
    geOutcome,
    gePlanEntry,
    geSaleRequest,
    geTripAudit,
    lotValue,
    netPerUnit,
    parseBuyList,
    parseItems,
    parseProfiles,
    percentagePrice,
    reclaimGEPlanLock,
    runBankSeller,
    runBuyList,
    runGEPlan,
    runGEPlanSession,
    runGETrip,
    scanProfiles,
    selectBankSales,
    tickPackets,
    trickleOnly,
    validateBankSeller,
    validateBuyList,
    validateGEPlan,
    validateGETrip,
    type BankSellerPolicy,
    type BuyListRequest,
    type GEPricePlan,
    type GETripRequest,
} from '../src/market';

const listCatalogue=[{id:1511,name:'Logs',tradeable:true},{id:556,name:'Air rune',tradeable:true},{id:995,name:'Coins',tradeable:true},{id:99,name:'Forbidden',tradeable:false}];
function buyListFixture(){const dir=mkdtempSync(join(tmpdir(),'buy-list-')),r:BuyListRequest={actor:'buyer',server:'localhost:19081',goal:'list',entries:[{item:1511,quantity:2,basePrice:10,percent:10,unitCap:12},{item:556,quantity:3,basePrice:1,percent:5,unitCap:2}],budget:30,reserve:5,createdAt:Date.now()-100,deadline:Date.now()+60000,fillWait:1,cap:3000},paths={lock:join(dir,'actor.lock'),parent:join(dir,'parent'),children:[join(dir,'c0'),join(dir,'c1')]};
 const assets:Record<number,number>={995:100,2357:1},p={worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0,isDead:false};let calls=0,audits=0,uncertain=false,partial=false,stopped=false;const controls:any[]=[];
 const s:any={name:'buyer',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player:p}),getSkill:()=>({level:99}),getEquipment:()=>[],getInventory:()=>[]}};
 const deps:any={paths,catalogue:listCatalogue,bankAudit:async()=>{audits++;return{...assets};},buyer:async(_s:any,q:any,path:string,stop:()=>boolean,cancel:boolean)=>{calls++;controls.push({q,cancel,stop:stop()});if(existsSync(path)&&JSON.parse(readFileSync(path,'utf8')).phase==='settled')return{ok:false,banked:true,conserved:true,unrelated:true,reserveKept:true,outcomeUnresolved:false,died:false,damaged:false};const acquired=partial?1:q.quantity,spent=acquired*q.limit;const j={version:1,request:q,phase:uncertain?'placing':'settled',submission:'attempted',coinsBefore:assets[995],itemsBefore:assets[q.item]??0,previousIds:[],at:Date.now(),acquired,refund:q.quantity*q.limit-spent};writeFileSync(path,JSON.stringify(j));if(!uncertain){assets[995]!-=spent;assets[q.item]=(assets[q.item]??0)+acquired;}return{ok:!uncertain,banked:!uncertain,conserved:!uncertain,unrelated:true,reserveKept:true,outcomeUnresolved:uncertain,died:false,damaged:false};}};
 return{r,paths,assets,s,deps,controls,counts:()=>({calls,audits}),stop:()=>stopped,setStop:(x:boolean)=>{stopped=x;},setUncertain:(x:boolean)=>{uncertain=x;},setPartial:(x:boolean)=>{partial=x;}};
}
test('donor repeated five-percent uses native integer minimum and compounds, custom 99 is single increment',()=>{expect(percentagePrice(1,10)).toBe(3);expect(percentagePrice(100,10)).toBe(110);expect(percentagePrice(100,50)).toBe(158);expect(percentagePrice(100,99)).toBe(199);expect(percentagePrice(1,99)).toBe(2);expect(percentagePrice(2147483647,50)).toBe(2147483647);for(const p of[0,7,-5,100])expect(()=>percentagePrice(100,p)).toThrow();});
test('exact native names, implicit one and explicit donor last-duplicate-wins semantics',()=>{expect(parseBuyList(' Logs[2], air rune, LOGS[4] ',listCatalogue)).toEqual([{item:1511,quantity:4},{item:556,quantity:1}]);for(const x of['','Coins','Forbidden','missing','Logs[0]','Logs[-1]','Logs[2]junk','Logs,'])expect(()=>parseBuyList(x,listCatalogue)).toThrow();expect(()=>parseBuyList('Logs',[...listCatalogue,{id:33,name:'Logs',tradeable:true}])).toThrow();});
test('whole list is validated against explicit per-unit caps and total owned exposure before login',()=>{const f=buyListFixture();validateBuyList(f.r,listCatalogue);for(const change of[{budget:29},{reserve:-1},{cap:999},{entries:[{...f.r.entries[0]!,unitCap:11}]}])expect(()=>validateBuyList({...f.r,...change},listCatalogue)).toThrow();});
test('actual list consumer banks both exact requests and durable replay dispatches zero new orders',async()=>{const f=buyListFixture(),first=await runBuyList(f.s,f.r,f.stop,f.deps);expect(first).toMatchObject({ok:true,banked:true,targetMet:true,spent:30});expect(f.assets).toEqual({995:70,2357:1,1511:2,556:3});expect(f.controls.map(c=>[c.q.item,c.q.quantity,c.q.limit,c.q.expectedOwned,c.cancel])).toEqual([[1511,2,12,0,false],[556,3,2,0,false]]);expect(f.counts().calls).toBe(2);expect((await runBuyList(f.s,f.r,f.stop,f.deps)).replay).toBe(true);expect(f.counts().calls).toBe(2);f.assets[2357]=2;expect((await runBuyList(f.s,f.r,f.stop,f.deps)).failure).toContain('initial-assets');expect(f.counts().calls).toBe(2);});
test('unknown first placement prevents next item; recovery cancels same child even ordinary stop',async()=>{const f=buyListFixture();f.setUncertain(true);const first=await runBuyList(f.s,f.r,f.stop,f.deps);expect(first).toMatchObject({ok:false,pending:true});expect(f.counts().calls).toBe(1);f.setUncertain(false);f.setStop(true);const recovered=await runBuyList(f.s,f.r,f.stop,f.deps);expect(recovered).toMatchObject({ok:true,banked:true,targetMet:false});expect(f.controls[1].cancel).toBe(true);expect(f.controls[1].stop).toBe(false);expect(f.counts().calls).toBe(2);expect(f.assets[556]).toBeUndefined();expect((await runBuyList(f.s,f.r,f.stop,f.deps)).ok).toBe(true);expect(f.counts().calls).toBe(2);});
test('partial settled child never refreshes/reprices or advances the list and records targetMet false',async()=>{const f=buyListFixture();f.setPartial(true);expect(await runBuyList(f.s,f.r,f.stop,f.deps)).toMatchObject({ok:true,banked:true,targetMet:false});expect(f.counts().calls).toBe(1);expect((await runBuyList(f.s,f.r,f.stop,f.deps)).ok).toBe(true);expect(f.counts().calls).toBe(1);});
test('missing parent, changed configuration, corrupt child and audit stock drift cannot buy',async()=>{const f=buyListFixture();writeFileSync(f.paths.children[0]!,JSON.stringify({}));await expect(runBuyList(f.s,f.r,f.stop,f.deps)).rejects.toThrow('without parent');expect(f.counts()).toEqual({calls:0,audits:0});const g=buyListFixture();await runBuyList(g.s,g.r,g.stop,g.deps);await expect(runBuyList(g.s,{...g.r,budget:31},g.stop,g.deps)).rejects.toThrow('config changed');const parent=JSON.parse(readFileSync(g.paths.parent,'utf8'));parent.children[0].limit++;writeFileSync(g.paths.parent,JSON.stringify(parent));expect((await runBuyList(g.s,g.r,g.stop,g.deps)).failure).toContain('child request changed');expect(g.counts().calls).toBe(2);});
test('stop before intent creates no journal; global/account/role stop callbacks are actual consumer inputs',async()=>{const f=buyListFixture();f.setStop(true);expect((await runBuyList(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(existsSync(f.paths.parent)).toBe(false);expect(f.counts().calls).toBe(0);for(const path of['.practice/stop-all','.practice/stop-buyer','.practice/stop-microbot-ge-buy-list'])expect(buyListStop('buyer',false,p=>p===path)).toBe(true);expect(buyListStop('buyer',false,()=>false)).toBe(false);});
test('actual consumer reopens closed bank with fresh generation for every initial/between/final audit',async()=>{const f=buyListFixture();delete f.deps.bankAudit;let tick=0,open=false,generation=0,opens=0;const player=f.s.sdk.getState().player;f.s.tick=()=>tick;f.s.sdk.getState=()=>({player,bank:{isOpen:open},interface:{isOpen:open},modalOpen:open});f.s.sdk.getInventory=()=>[];f.s.sdk.getGEState=()=>undefined;f.s.sdk.sendCloseModal=async()=>{open=false;tick++;return{success:true};};f.s.bankObservation=()=>open?{generation,items:Object.entries(f.assets).map(([id,count])=>({id:Number(id),count}))}:null;f.s.bot={openBank:async()=>{open=true;generation++;opens++;return{success:true};},closeBank:async()=>{open=false;return{success:true};}};expect((await runBuyList(f.s,f.r,f.stop,f.deps)).ok).toBe(true);expect(opens).toBe(4);expect(f.s.bankObservation()).toBeNull();expect(f.counts().calls).toBe(2);});
test('crash after partial lower settlement before parent outcome cannot authorize the next item',async()=>{const f=buyListFixture();f.setPartial(true);await runBuyList(f.s,f.r,f.stop,f.deps);const parent=JSON.parse(readFileSync(f.paths.parent,'utf8'));parent.phase='running';parent.outcomes[0]=null;parent.aborted=false;writeFileSync(f.paths.parent,JSON.stringify(parent));const recovered=await runBuyList(f.s,f.r,f.stop,f.deps);expect(recovered).toMatchObject({ok:true,banked:true,targetMet:false});expect(recovered.failure).toContain('partially filled');expect(f.controls[1].cancel).toBe(true);expect(f.assets[1511]).toBe(1);expect(f.assets[556]).toBeUndefined();expect(f.counts().calls).toBe(2);});
test('settled lower market receipt with failed bank return cannot advance; cancellation-only replay finishes banking first',async()=>{const f=buyListFixture(),buyer=f.deps.buyer;let bankFails=true,carried=false;f.s.sdk.getInventory=()=>carried?[{id:1511,name:'Logs',count:2}]:[];f.deps.buyer=async(...args:any[])=>{const result=await buyer(...args);carried=bankFails;return{...result,banked:!bankFails};};const first=await runBuyList(f.s,f.r,f.stop,f.deps);expect(first).toMatchObject({ok:false,banked:false});expect(first.failure).toContain('bank return unconfirmed');expect(f.assets[556]).toBeUndefined();expect(f.counts().calls).toBe(1);expect(JSON.parse(readFileSync(f.paths.parent,'utf8')).outcomes).toEqual([null,null]);bankFails=false;const recovered=await runBuyList(f.s,f.r,f.stop,f.deps);expect(recovered).toMatchObject({ok:true,banked:true,targetMet:true});expect(f.controls[1].cancel).toBe(true);expect(f.controls[2].cancel).toBe(false);expect(f.assets).toEqual({995:70,2357:1,1511:2,556:3});});
test('sum-only asset equality cannot label carried coins/items banked even if lower claims banking',async()=>{for(const id of[995,1511]){const f=buyListFixture(),buyer=f.deps.buyer;let carried=false;f.s.sdk.getInventory=()=>carried?[{id,count:1,name:id===1511?'Logs':'Coins'}]:[];f.deps.buyer=async(...args:any[])=>{const result=await buyer(...args);carried=true;return result;};expect((await runBuyList(f.s,f.r,f.stop,f.deps)).failure).toContain('bank return unconfirmed');expect(f.counts().calls).toBe(1);expect(f.assets[556]).toBeUndefined();}const f=buyListFixture();await runBuyList(f.s,f.r,f.stop,f.deps);f.s.sdk.getInventory=()=>[{id:1511,count:1,name:'Logs'}];const replay=await runBuyList(f.s,f.r,f.stop,f.deps);expect(replay).toMatchObject({ok:false,banked:false});expect(f.counts().calls).toBe(2);});

const tripRequest=():GETripRequest=>({actor:'seller',server:'localhost:19081',goal:'surplus',item:1511,quantity:3,price:100,floor:100,reserve:2,deadline:Date.now()+60000,fillWait:0,cap:1200});
function tripFixture(){const dir=mkdtempSync(join(tmpdir(),'ge-trip-')),paths={parent:join(dir,'parent.json'),lower:join(dir,'lower.json')},r=tripRequest();let bankOpen=false,generation=0,withdrawn=0,saleCalls=0,returns=0;const bank:Record<number,number>={1511:5,995:15,2357:1},pack:Record<number,number>={},player={worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0,isDead:false},items=(m:Record<number,number>)=>Object.entries(m).filter(([,count])=>count>0).map(([id,count],slot)=>({id:Number(id),count,slot}));
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),bankObservation:()=>bankOpen?{generation,items:items(bank)}:null,sdk:{getState:()=>({player,bank:{isOpen:bankOpen}}),getSkill:()=>({level:50}),getInventory:()=>items(pack),getEquipment:()=>[],sendCloseModal:async()=>{bankOpen=false;return{success:true};}},bot:{openBank:async()=>{bankOpen=true;generation++;return{success:true};},closeBank:async()=>{bankOpen=false;return{success:true};}}};
 const seller:any=async(_s:any,_r:any,path:string,_stop:any,_wait:any,cancel:boolean)=>{saleCalls++;if(!cancel){expect(existsSync(paths.parent)).toBe(true);expect(JSON.parse(readFileSync(paths.parent,'utf8')).phase).toBe('market');writeFileSync(path,JSON.stringify({version:1,request:geSaleRequest(r),phase:'attempted',itemsBefore:3,coinsBefore:0,previousIds:[]}));pack[1511]=0;return{ok:false,error:'lost placement observation'};}expect(player.worldX).toBe(3181);const lower=JSON.parse(readFileSync(path,'utf8'));lower.phase='settled';lower.progress={filled:2,gross:202,tax:10};lower.claim={items:1,coins:192};pack[1511]=1;pack[995]=192;writeFileSync(path,JSON.stringify(lower));return{ok:true,journal:lower};};
 const bankRunner:any=async(_s:any,j:any,p:any,stop:any)=>{if(Object.keys(p.inputs).length){expect(JSON.parse(readFileSync(paths.parent,'utf8')).phase).toBe('staging');withdrawn+=r.quantity;bank[1511]!-=r.quantity;pack[1511]=r.quantity;player.worldX=3181;player.worldZ=3443;try{await p.run(r.quantity,900,stop);}catch(error){const defer=p.deferBankRecovery();expect(defer).toBe(true);bankOpen=false;return{ok:false,atBank:false,recoveryDeferred:defer,failure:String(error),banked:{},completed:0};}}else{returns++;expect(Object.keys(p.inputs)).toHaveLength(0);player.worldX=3185;player.worldZ=3436;for(const[id,count]of Object.entries(pack)){bank[Number(id)]=(bank[Number(id)]??0)+count;pack[Number(id)]=0;}}bankOpen=false;return{ok:true,atBank:true,recoveryDeferred:false,banked:{},completed:1};};
 return{s,r,paths,bank,pack,player,deps:{paths,seller,bankRunner},counts:()=>({withdrawn,saleCalls,returns})};
}
test('unknown escrow defers bank movement; in-place recovery banks a partial lot once and settled replay pays nothing',async()=>{
 const f=tripFixture();const first=await runGETrip(f.s,f.r,()=>false,f.deps);expect(first.ok).toBe(false);expect(first.recoveryDeferred).toBe(true);expect(f.player.worldX).toBe(3181);expect(f.bank[1511]).toBe(2);expect(f.counts()).toEqual({withdrawn:3,saleCalls:1,returns:0});
 const recovered=await runGETrip(f.s,f.r,()=>true,f.deps);expect(recovered.ok).toBe(true);expect(recovered.targetMet).toBe(false);expect(recovered.filled).toBe(2);expect(recovered.net).toBe(192);expect(f.bank).toEqual({1511:3,995:207,2357:1});expect(f.counts()).toEqual({withdrawn:3,saleCalls:2,returns:1});
 const before={...f.bank},replay=await runGETrip(f.s,f.r,()=>false,f.deps);expect(replay.ok).toBe(true);expect(replay.replay).toBe(true);expect(f.bank).toEqual(before);expect(f.counts().withdrawn).toBe(3);expect(f.counts().saleCalls).toBe(2);
 f.bank[2357]=2;const changed=await runGETrip(f.s,f.r,()=>false,f.deps);expect(changed.ok).toBe(false);expect(changed.failure).toContain('initial asset ledger');expect(f.counts().saleCalls).toBe(2);
});
test('prepared/no-placement intent aborts unsubmitted on stop without another withdrawal',async()=>{
 const f=tripFixture();writeFileSync(f.paths.parent,JSON.stringify({version:1,request:f.r,phase:'prepared',initial:f.bank,initialGear:[]}));const result=await runGETrip(f.s,f.r,()=>true,f.deps);expect(result.ok).toBe(true);expect(result.unsubmitted).toBe(true);expect(result.targetMet).toBe(false);expect(f.counts().withdrawn).toBe(0);expect(f.counts().saleCalls).toBe(0);
});
test('missing/corrupt parent and conflicting terminal journal reject before session/market access',async()=>{
 const f=tripFixture();writeFileSync(f.paths.lower,JSON.stringify({version:1,request:geSaleRequest(f.r),phase:'attempted',itemsBefore:3,coinsBefore:0,previousIds:[]}));await expect(runGETrip({name:'seller'}as any,f.r,()=>false,{paths:f.paths})).rejects.toThrow('without parent');writeFileSync(f.paths.parent,'{broken');await expect(runGETrip({name:'seller'}as any,f.r,()=>false,{paths:f.paths})).rejects.toThrow();
});
test('lot and terminal audit enforce floor, reserve, cumulative native tax and exact unrelated assets',()=>{
 const r=tripRequest();for(const change of [{quantity:25},{price:99},{reserve:-1},{fillWait:201},{cap:499}])expect(()=>validateGETrip({...r,...change})).toThrow();expect(geTripAudit({1511:5,995:15},{1511:3,995:207},r,{filled:2,gross:202,tax:10,net:192,unsubmitted:false})).toBe(true);expect(geTripAudit({1511:5,995:15},{1511:3,995:208},r,{filled:2,gross:202,tax:10,net:192,unsubmitted:false})).toBe(false);expect(()=>geOutcome({phase:'settled',request:geSaleRequest(r),progress:{filled:2,gross:202,tax:9},claim:{items:1,coins:193}}as any)).toThrow();
});
test('failed recovery deposit keeps settled intent until actual sale outputs are banked',async()=>{
 for(const id of[995,1511]){
  const f=tripFixture();await runGETrip(f.s,f.r,()=>false,f.deps);
  const runner=f.deps.bankRunner;let failDeposit=true;
  f.deps.bankRunner=async(...args:any[])=>{const result=await runner(...args);if(failDeposit){f.bank[id]=(f.bank[id]??0)-1;f.pack[id]=(f.pack[id]??0)+1;return{...result,ok:false,failure:'deposit refused'};}return result;};
  const failed=await runGETrip(f.s,f.r,()=>true,f.deps);
  expect(failed.ok).toBe(false);expect(failed.banked).toBe(false);expect(failed.failure).toContain('outputs not banked');
  expect(JSON.parse(readFileSync(f.paths.parent,'utf8')).phase).toBe('settled');expect(f.counts().saleCalls).toBe(2);
  failDeposit=false;const recovered=await runGETrip(f.s,f.r,()=>true,f.deps);
  expect(recovered.ok).toBe(true);expect(recovered.banked).toBe(true);expect(f.counts().saleCalls).toBe(2);expect(f.bank).toEqual({1511:3,995:207,2357:1});
 }
});

function gePlanFixture(lost=false){
 const dir=mkdtempSync(join(tmpdir(),'ge-plan-')),path=join(dir,'plan.json'),request:GEPricePlan={actor:'seller',server:'local',goal:'suggested',item:1511,quantity:3,reserve:2,floor:90,deadline:Date.now()+60000,cap:4000,prices:[{price:119,fillWait:2},{price:101,fillWait:2}]};
 let actions=0,calls=0,lostOnce=false;const assets:Record<number,number>={1511:5,995:10,2357:1},player={lifeId:1,respawnCount:0,worldX:3185,worldZ:3436,level:0,isDead:false};
 const s:any={name:'seller',tick:()=>0,ended:new Promise(()=>{}),sdk:{getState:()=>({player}),getSkill:()=>({level:99})}};
 const trip:any=async(_s:any,q:any,stop:()=>boolean,deps:any)=>{
  calls++;const parent=JSON.parse(readFileSync(path,'utf8'));expect(parent.current).toEqual(q);expect(parent.phase).toBe('running');
  if(!readFileSync(path,'utf8').includes('"current"'))throw Error('intent missing');
  if(!existsSync(deps.paths.parent)){
   expect(stop()).toBe(false);const initial={...assets};gePlanEntry(parent.rounds.at(-1),{initial,initialGear:[]});actions++;const filled=q.goal.endsWith('p0')?1:q.quantity,gross=filled*q.price,tax=Math.floor(gross/20),outcome={filled,gross,tax,net:gross-tax,unsubmitted:false};
   assets[1511]-=filled;assets[995]+=outcome.net;
   writeFileSync(deps.paths.parent,JSON.stringify({version:1,request:q,phase:'banked',initial,initialGear:[],outcome}));
   writeFileSync(deps.paths.lower,JSON.stringify({version:1,request:geSaleRequest(q),phase:'settled',progress:{filled,gross,tax},claim:{items:q.quantity-filled,coins:outcome.net}}));
  }
  if(lost&&!lostOnce){lostOnce=true;return{ok:false,banked:true,failure:'lost return observation'};}
  return{ok:true,banked:true};
 };
 return{dir,path,request,s,player,assets,deps:{path,trip},counts:()=>({actions,calls})};
}
test('explicit partial modification settles old escrow before remaining relist and sums per-offer tax',async()=>{
 const f=gePlanFixture();try{const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r).toMatchObject({ok:true,remaining:0,filled:3,gross:321,tax:15,net:306});expect(r.journal!.rounds.map(r=>r.request.quantity)).toEqual([3,2]);expect(f.assets).toEqual({1511:2,995:316,2357:1});const before=f.counts(),replay=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(replay.replay).toBe(true);expect(f.counts()).toEqual(before);}finally{rmSync(f.dir,{recursive:true});}
});
test('lost parent acknowledgement retains same pending round and resumes without a second sale',async()=>{
 const f=gePlanFixture(true);try{const first=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(first.ok).toBe(false);expect(first.pending).toBe(true);expect(f.counts().actions).toBe(1);const resumed=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(resumed.ok).toBe(true);expect(f.counts()).toEqual({actions:2,calls:3});}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish settles only the explicit pending round and never starts a new suggested price',async()=>{
 const f=gePlanFixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const r=await runGEPlan(f.s,f.request,()=>false,f.deps,true);expect(r).toMatchObject({ok:true,finished:false,filled:1,remaining:2});expect(f.counts()).toEqual({actions:1,calls:2});}finally{rmSync(f.dir,{recursive:true});}
});
test('mutated between-round stock and changed durable plan identity refuse further payment',async()=>{
 const f=gePlanFixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);f.assets[2357]=2;const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(r.failure).toContain('between-round');expect(f.counts().actions).toBe(1);await expect(runGEPlan(f.s,{...f.request,reserve:1},()=>false,f.deps)).rejects.toThrow('identity');}finally{rmSync(f.dir,{recursive:true});}
});
test('unknown lower escrow cannot be declared banked or relisted; original-life replacement blocks next round',async()=>{
 const f=gePlanFixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8')),p=f.path+'.'+j.current.goal+'.sell.json',lower=JSON.parse(readFileSync(p,'utf8'));lower.phase='open';writeFileSync(p,JSON.stringify(lower));const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('plan limits and original stop refuse a fresh market intent',async()=>{
 const f=gePlanFixture();try{expect(()=>validateGEPlan({...f.request,prices:[]})).toThrow();expect(()=>validateGEPlan({...f.request,prices:[{price:89,fillWait:1}]})).toThrow();const r=await runGEPlan(f.s,f.request,()=>true,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(0);}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish lists explicit owned stock as fresh resting escrow and replay performs no lower action',async()=>{
 const f=gePlanFixture();let calls=0;const o:any={id:9,slot:0,item:1511,side:'sell',quantity:3,price:119,remaining:2,filled:1,state:'open',items:0,coins:114,gross:119,tax:5};
 f.s.sdk.getStateAge=()=>0;f.s.sdk.getEquipment=()=>[];f.s.sdk.getInventory=()=>[];f.s.sdk.getGEState=()=>({offers:[o]});
 const trip:any=async(_s:any,q:any,_stop:any,d:any)=>{calls++;writeFileSync(d.paths.parent,JSON.stringify({version:1,request:q,phase:'market',initial:f.assets,initialGear:[]}));writeFileSync(d.paths.lower,JSON.stringify({version:1,request:geSaleRequest(q),phase:'open',coinsBefore:0,itemsBefore:3,previousIds:[],offerId:9}));return{ok:false,recoveryDeferred:true};};
 try{const r=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);if(!r.ok)throw Error(r.failure);expect(r.ok).toBe(true);expect('resting' in r&&r.resting).toMatchObject({offerId:9,remaining:2,coinsEscrow:114,settled:false,banked:false});expect(r.journal!.phase).toBe('resting');const replay=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);expect(replay.replay).toBe(true);expect(calls).toBe(1);o.price=118;const foreign=await runGEPlan(f.s,f.request,()=>false,{path:f.path,trip},true);expect(foreign.ok).toBe(false);expect(calls).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('same cached player life mutation after a round prevents the next price suggestion',async()=>{
 const f=gePlanFixture(),trip=f.deps.trip;f.deps.trip=async(...args:any[])=>{const r=await trip(...args);f.player.lifeId=2;return r;};
 try{const r=await runGEPlan(f.s,f.request,()=>false,f.deps);expect(r.ok).toBe(false);expect(f.counts().actions).toBe(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('Finish after saved-round crash window never creates the next price intent',async()=>{
 const f=gePlanFixture(true);try{await runGEPlan(f.s,f.request,()=>false,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8')),child=JSON.parse(readFileSync(f.path+'.'+j.current.goal+'.json','utf8'));j.rounds.push({request:j.current,filled:child.outcome.filled,gross:child.outcome.gross,tax:child.outcome.tax,net:child.outcome.net,unsubmitted:false,initial:child.initial,gear:child.initialGear});delete j.current;writeFileSync(f.path,JSON.stringify(j));const before=f.counts(),r=await runGEPlan(f.s,f.request,()=>false,f.deps,true);expect(r).toMatchObject({ok:true,finished:false,filled:1,remaining:2});expect(f.counts()).toEqual(before);expect(r.journal!.current).toBeUndefined();}finally{rmSync(f.dir,{recursive:true});}
});
test('CLI lock recovery requires exact known dead PID and preserves live or unknown owners',()=>{
 const f=gePlanFixture(),path=join(f.dir,'owner.lock'),seen:number[]=[];try{writeFileSync(path,JSON.stringify({pid:17}));expect(()=>reclaimGEPlanLock(path,pid=>{seen.push(pid);return true;})).toThrow('already owned');expect(existsSync(path)).toBe(true);reclaimGEPlanLock(path,pid=>{seen.push(pid);return false;});expect(seen).toEqual([17,17]);expect(existsSync(path)).toBe(false);writeFileSync(path,JSON.stringify({pid:0}));expect(()=>reclaimGEPlanLock(path,()=>false)).toThrow('unknown');expect(existsSync(path)).toBe(true);}finally{rmSync(f.dir,{recursive:true});}
});
test('CLI session settles a thrown durable identity consumer failure without any sale',async()=>{
 const f=gePlanFixture();const settled:any[]=[];
 try{
  writeFileSync(f.path,JSON.stringify({version:1,request:{...f.request,reserve:1},phase:'prepared',rounds:[]}));
  const code=await runGEPlanSession(f.s,f.request,()=>false,f.deps,false,async(sessions,ok,reason)=>{settled.push({sessions,ok,reason});return ok;});
  expect(code).toBe(1);expect(settled).toEqual([{sessions:[f.s],ok:false,reason:'finite explicit GE price plan'}]);expect(f.counts()).toEqual({actions:0,calls:0});expect(f.assets).toEqual({1511:5,995:10,2357:1});
 }finally{rmSync(f.dir,{recursive:true});}
});

const nativeBank=[{id:995,name:'Coins',tradeable:true},{id:1511,name:'Logs',tradeable:true},{id:556,name:'Air rune',tradeable:true},{id:2357,name:'Gold bar',tradeable:true},{id:1,name:'Tool kit',tradeable:false}];
function sellerPolicy():BankSellerPolicy{return{actor:'seller',server:'local',goal:'allowned',allTradeable:true,protect:[2357],reserves:{1511:2},maxItems:3,maxUnits:10,perItem:4,discount:10,floor:1,unitCap:1000,fillWait:2,deadline:Date.now()+60000,cap:5000,childCap:1000};}
function bankSellerFixture(){
 const dir=mkdtempSync(join(tmpdir(),'bank-seller-')),path=join(dir,'parent.json'),r=sellerPolicy(),player={lifeId:1,respawnCount:0,isDead:false},client={executeBotAction:()=>{}},assets:Record<number,number>={1511:7,556:3,2357:1,995:37},bank=[{id:1511,count:7},{id:556,count:3},{id:2357,count:1},{id:995,count:37}],calls:number[]=[],auditCalls:number[]=[];
 let stop=false,fail=false,drift=false;const s:any={name:'seller',client,lifecycle:{account:'seller',server:'local'},ended:new Promise(()=>{}),tick:()=>0,onTick:()=>()=>{},sdk:{config:{botUsername:'seller',browserLaunchUrl:'https://local/bot'},getState:()=>({player}),getSkill:()=>({level:99})}};
 const deps:any={path,catalogue:nativeBank,quote:async()=>100,inspect:async()=>({snapshot:{assets:{...assets},bank,gear:[]},protected:[],offers:[]}),audit:async()=>{auditCalls.push(1);return{assets:{...assets,...drift?{2357:2}:{}},bank,gear:[]};},plan:async(_s:any,q:any,_stop:any,d:any)=>{
  const parent=JSON.parse(readFileSync(path,'utf8'));expect(parent.plans).toContainEqual(q);expect(parent.request).toEqual(r);
  const child=d.path;if(existsSync(child)){const prior=JSON.parse(readFileSync(child,'utf8'));if(prior.phase==='complete')return{ok:true,replay:true};}
  calls.push(q.item);writeFileSync(child,JSON.stringify({version:1,request:q,phase:'running',rounds:[],current:{}}));if(fail)return{ok:false,pending:true};
  const filled=1,gross=q.prices[0].price,tax=Math.floor(gross/20),net=gross-tax;assets[q.item]-=filled;assets[995]+=net;
  writeFileSync(child,JSON.stringify({version:1,request:q,phase:'complete',rounds:[{filled,gross,tax,net}]}));return{ok:true,replay:false};
 }};return{dir,path,r,s,deps,assets,calls,auditCalls,player,client,setStop:(v:boolean)=>stop=v,stop:()=>stop,setFail:(v:boolean)=>fail=v,setDrift:(v:boolean)=>drift=v};
}
test('automatic bank order excludes starting/offer IDs, explicit protects, coins and native untradeables; retains exact reserves and finite bounds',()=>{
 const r=sellerPolicy();const rows=[{id:1511,count:7},{id:556,count:3},{id:2357,count:1},{id:995,count:37},{id:1,count:1}];
 expect(selectBankSales(rows,[556],r,nativeBank).selected).toEqual([{id:1511,count:4}]);
 expect(selectBankSales(rows,[],{...r,maxUnits:5},nativeBank).selected).toEqual([{id:1511,count:4},{id:556,count:1}]);
 expect(selectBankSales(rows,[1512],r,[...nativeBank,{id:1512,name:'Logs',tradeable:true,baseId:1511}]).selected).toEqual([{id:556,count:3}]);
 expect(()=>selectBankSales([{id:999999,count:1}],[],r,nativeBank)).toThrow('metadata');expect(()=>selectBankSales([rows[0]!,rows[0]!],[],r,nativeBank)).toThrow('identity');
});
test('native integer discount compounds and finite policy must explicitly authorize bank-wide sales',()=>{
 expect(bankSellerPrice(100,10)).toBe(91);expect(bankSellerPrice(2,50)).toBe(1);expect(bankSellerPrice(119,50)).toBe(59);expect(bankSellerPrice(119,5)).toBe(114);
 expect(()=>validateBankSeller({...sellerPolicy(),allTradeable:false}as any)).toThrow();expect(()=>validateBankSeller({...sellerPolicy(),perItem:25})).toThrow();
});
test('parent intent precedes child mutation; partial filled lots settle before next type and terminal replay makes zero calls',async()=>{
 const f=bankSellerFixture();try{const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(true);expect(f.calls).toEqual([1511,556]);expect(result.journal!.outcomes.map(o=>o.filled)).toEqual([1,1]);expect(f.assets).toEqual({1511:6,556:2,2357:1,995:211});const count=f.auditCalls.length;const replay=await runBankSeller(f.s,f.r,()=>true,f.deps);expect(replay.ok).toBe(true);expect(replay.replay).toBe(true);expect(f.calls).toEqual([1511,556]);expect(f.auditCalls.length).toBe(count);}finally{rmSync(f.dir,{recursive:true});}
});
test('unknown child escrow parks entire scan; resume recovers same item before later sale',async()=>{
 const f=bankSellerFixture();try{f.setFail(true);const first=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(first.ok).toBe(false);expect(f.calls).toEqual([1511]);f.setFail(false);const next=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(next.ok).toBe(true);expect(f.calls).toEqual([1511,1511,556]);}finally{rmSync(f.dir,{recursive:true});}
});
test('stop makes zero new sale calls; full asset drift refuses before first child',async()=>{
 const f=bankSellerFixture();try{f.setStop(true);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);f.setStop(false);f.setDrift(true);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('same mutable player life replacement during inspection stops before durable sales',async()=>{
 const f=bankSellerFixture();try{const inspect=f.deps.inspect;f.deps.inspect=async()=>{const result=await inspect();f.player.lifeId++;return result;};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('executor replacement during inspection stops before any child or quote',async()=>{
 const f=bankSellerFixture();try{const inspect=f.deps.inspect;f.deps.inspect=async()=>{const result=await inspect();f.client.executeBotAction=()=>{};return result;};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}
});
test('parent cannot turn a protected bank row into a resumed child',async()=>{
 const f=bankSellerFixture();try{f.setFail(true);await runBankSeller(f.s,f.r,f.stop,f.deps);const j=JSON.parse(readFileSync(f.path,'utf8'));j.plans[0].item=2357;writeFileSync(f.path,JSON.stringify(j));f.setFail(false);expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(f.calls).toEqual([1511]);}finally{rmSync(f.dir,{recursive:true});}
});
test('unrelated stock changes after a settled child prevent the next item',async()=>{
 const f=bankSellerFixture();try{const plan=f.deps.plan;f.deps.plan=async(...args:any[])=>{const result=await plan(...args);f.assets[2357]++;return result;};const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(false);expect(f.calls).toEqual([1511]);expect(result.journal!.outcomes).toHaveLength(1);}finally{rmSync(f.dir,{recursive:true});}
});
test('same gear values with different native container field order authorize the next settled bank boundary',async()=>{
 const f=bankSellerFixture();try{const inspect=f.deps.inspect,audit=f.deps.audit;f.deps.inspect=async()=>{const v=await inspect();v.snapshot.gear=[{id:1289,count:1,slot:3}];return v;};f.deps.audit=async()=>({...await audit(),gear:[{id:1289,slot:3,count:1}]});expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(true);expect(f.calls).toEqual([1511,556]);}finally{rmSync(f.dir,{recursive:true});}
});
test('unsubmitted child returns an explicit failed banked result and never proceeds to the next type',async()=>{
 const f=bankSellerFixture();try{f.deps.plan=async(_s:any,q:any,_stop:any,d:any)=>{f.calls.push(q.item);writeFileSync(d.path,JSON.stringify({version:1,request:q,phase:'stopped',rounds:[{filled:0,gross:0,tax:0,net:0,unsubmitted:true}]}));return{ok:true};};const result=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(result.ok).toBe(false);expect(result.banked).toBe(true);expect(result.journal!.outcomes[0]!.unsubmitted).toBe(true);expect(f.calls).toEqual([1511]);}finally{rmSync(f.dir,{recursive:true});}
});
test('actual sessionWalker direct continuation cannot dispatch walk, door or run through a replaced owner',async()=>{
 const f=bankSellerFixture();let direct=0;try{f.s.direct=async()=>{direct++;};f.deps.plan=async(view:any)=>{const walker=await sessionWalker(view);await Promise.resolve();f.client.executeBotAction=()=>{};for(const action of[()=>walker.walk(3185,3436),()=>walker.interactLoc!({id:1,x:3184,z:3436}as any,1),()=>walker.runOn!()])await expect(action()).rejects.toThrow('direct original');return{ok:false,pending:true};};expect((await runBankSeller(f.s,f.r,f.stop,f.deps)).ok).toBe(false);expect(direct).toBe(0);}finally{rmSync(f.dir,{recursive:true});}
});
test('exported API rejects actual account, server and HTTP-origin mismatch before inspection',async()=>{
 for(const kind of['account','server','origin']){const f=bankSellerFixture();let inspected=0;try{f.deps.inspect=async()=>{inspected++;throw Error('unexpected inspection');};if(kind==='account')f.s.lifecycle.account='other';if(kind==='server')f.s.lifecycle.server='foreign';if(kind==='origin')f.s.sdk.config.browserLaunchUrl='https://foreign/bot';await expect(runBankSeller(f.s,f.r,f.stop,f.deps)).rejects.toThrow('actual session');expect(inspected).toBe(0);expect(f.calls).toEqual([]);}finally{rmSync(f.dir,{recursive:true});}}
});
test('liquidation requires an explicit 1 GP floor and finite native wait; default price plan stays one unchanged round',()=>{
 const r=sellerPolicy();expect(bankSellerPrices(91,r)).toEqual([{price:91,fillWait:2}]);const enabled={...r,floor:1,childCap:1500,liquidation:{waitTicks:150,fillWait:10}};validateBankSeller(enabled);expect(bankSellerPrices(91,enabled)).toEqual([{price:91,fillWait:150},{price:1,fillWait:10}]);expect(bankSellerPrices(1,enabled)).toEqual([{price:1,fillWait:150}]);for(const p of[{...enabled,floor:2},{...enabled,childCap:1499},{...enabled,liquidation:{waitTicks:149,fillWait:10}}])expect(()=>validateBankSeller(p)).toThrow('liquidation');
});
test('actual durable GE plan liquidates only previously-unsold owned quantity and sums tax per offer',async()=>{
 const f=bankSellerFixture();try{f.r.maxItems=1;f.r.childCap=1500;f.r.liquidation={waitTicks:150,fillWait:10};const offered:{quantity:number;price:number;wait:number}[]=[];
  f.deps.plan=async(s:any,q:any,stop:any,d:any)=>runGEPlan(s,q,stop,{...d,trip:async(_s:any,request:any,_stop:any,paths:any)=>{
   const initial={...f.assets},first=offered.length===0,filled=first?1:request.quantity,gross=filled*request.price,tax=Math.floor(gross/20),net=gross-tax;offered.push({quantity:request.quantity,price:request.price,wait:request.fillWait});f.assets[request.item]-=filled;f.assets[995]+=net;const outcome={filled,gross,tax,net,unsubmitted:false};writeFileSync(paths.paths.parent,JSON.stringify({version:1,request,phase:'banked',initial,initialGear:[],outcome}));writeFileSync(paths.paths.lower,JSON.stringify({version:1,request:geSaleRequest(request),phase:'settled',progress:{filled,gross,tax},claim:{items:request.quantity-filled,coins:net}}));return{ok:true,banked:true}as any;
  }});
  const r=await runBankSeller(f.s,f.r,f.stop,f.deps);expect(r.ok).toBe(true);expect(offered).toEqual([{quantity:4,price:91,wait:150},{quantity:3,price:1,wait:10}]);expect(r.journal!.outcomes[0]).toEqual({filled:4,gross:94,tax:4,net:90,unsubmitted:false});expect(f.assets[1511]).toBe(3);expect(f.assets[556]).toBe(3);const count=offered.length;expect((await runBankSeller(f.s,f.r,()=>true,f.deps)).replay).toBe(true);expect(offered).toHaveLength(count);
 }finally{rmSync(f.dir,{recursive:true});}
});

const bait = { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334 };

test('a unit clears the bid less the 5% seller tax', () => {
    expect(netPerUnit(218)).toBe(207.1);
    expect(netPerUnit(20)).toBe(19);
});

test('the plan buys what the bid wants, the coins pay for and UNITS allows', () => {
    const unitCost = 21;
    expect(bidPlan({ quote: bait, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 5000 });
    expect(bidPlan({ quote: { ...bait, buyQuantity: 120 }, unitCost, coins: 1_000_000, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 120 });
    expect(bidPlan({ quote: bait, unitCost, coins: 12_100, reserve: 10_000, maxUnits: 5000, minNet: 50 })).toEqual({ units: 100 });
});

test('the plan refuses with no bid, a thin margin or no spare coins', () => {
    expect(bidPlan({ quote: { ...bait, bid: null }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    expect(bidPlan({ quote: { ...bait, buyQuantity: 0 }, unitCost: 21, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 50 }).refusal).toBe('no open bid');
    expect(bidPlan({ quote: { id: 556, name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1e6 }, unitCost: 28, coins: 1e6, reserve: 0, maxUnits: 10, minNet: 1 }).refusal)
        .toBe('margin -12 is under MIN_NET 1');
    expect(bidPlan({ quote: bait, unitCost: 21, coins: 10_000, reserve: 10_000, maxUnits: 10, minNet: 50 }).refusal).toBe('no coins above the reserve');
});

test('the float tops the pack up to the reserve plus the spend limit', () => {
    expect(floatNeed(0, 10_000, 200_000)).toBe(210_000);
    expect(floatNeed(50_000, 10_000, 200_000)).toBe(160_000);
    expect(floatNeed(300_000, 10_000, 200_000)).toBe(0);
});

test('parseItems reads a comma list of positive item ids', () => {
    expect(parseItems('313')).toEqual([313]);
    expect(parseItems('560,559,560')).toEqual([560, 559]);
    expect(parseItems('313,x')).toBeNull();
    expect(parseItems('0')).toBeNull();
    expect(parseItems('')).toBeNull();
});

test('the scan lists exact profile items whose bid clears MIN_NET, the most coins first', () => {
    const profiles = { sarim: { items: [{ re: /^fishing bait$/i }, { re: /^feather$/i }] }, betty: { items: [{ re: /death rune/i }, { re: /air rune/i }] } };
    const market = [bait,
        { id: 314, name: 'Feather', basePrice: 2, bid: null, buyQuantity: 0 },
        { id: 560, name: 'Death rune', basePrice: 30, bid: 250, buyQuantity: 100_000 },
        { id: 556, name: 'Air rune', basePrice: 4, bid: 17, buyQuantity: 1_333_958 },
        { id: 9999, name: 'Death rune pack', basePrice: 1, bid: 9000, buyQuantity: 5 }];
    expect(scanProfiles(profiles, market, 50)).toEqual([
        { profile: 'betty', id: 560, name: 'Death rune', bid: 250, want: 100_000, margin: 207 },
        { profile: 'sarim', id: 313, name: 'Fishing bait', bid: 218, want: 38_334, margin: 204 },
    ]);
});

test('a chunk is too dear when its real unit cost leaves less than MIN_NET', () => {
    expect(chunkTooDear(50 * 188, 50, 250, 50)).toBe(true);
    expect(chunkTooDear(50 * 187.5, 50, 250, 50)).toBe(false);
    expect(chunkTooDear(50 * 180, 50, 250, 50)).toBe(false);
    expect(chunkTooDear(0, 0, 250, 50)).toBe(false);
});

test('fetchQuote reads the public market row and refuses a row for another item', async () => {
    const row = { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38334, ask: 271 };
    let asked = '';
    expect(await fetchQuote(313, async url => { asked = url; return row; })).toEqual(bait);
    expect(asked).toBe('https://rs-sdk.maxbittker.com/api/market/items/313');
    expect(await fetchQuote(313, async () => ({ ...row, bid: null }))).toEqual({ ...bait, bid: null });
    await expect(fetchQuote(313, async () => ({ ...row, id: 314 }))).rejects.toThrow('invalid market quote for 313');
});

test('fetchMarket reads every page', async () => {
    const asked: string[] = [];
    const rows = await fetchMarket(async url => {
        asked.push(url);
        return url.includes('offset=0') ? { total: 101, items: [{ id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 1 }, { id: 'bad' }] } : { total: 101, items: [{ id: 560, name: 'Death rune', basePrice: 30, bid: 0, buyQuantity: 0 }] };
    }, async () => {});
    expect(asked.length).toBe(2);
    expect(rows.map(r => [r.id, r.bid])).toEqual([[313, 218], [560, null]]);
});

test('one tick of shop packets holds at most 5 buys of 10, 5 or 1', () => {
    expect(tickPackets(300)).toEqual([10, 10, 10, 10, 10]);
    expect(tickPackets(23)).toEqual([10, 10, 1, 1, 1]);
    expect(tickPackets(7)).toEqual([5, 1, 1]);
    expect(tickPackets(2)).toEqual([1, 1]);
    expect(tickPackets(0)).toEqual([]);
    expect(tickPackets(-3)).toEqual([]);
});

test('parseProfiles reads a comma list of known profiles in order', () => {
    const known = ['sarim', 'harry_bait', 'betty'];
    expect(parseProfiles('sarim', known)).toEqual(['sarim']);
    expect(parseProfiles('Sarim,HARRY_BAIT', known)).toEqual(['sarim', 'harry_bait']);
    expect(parseProfiles('sarim,nowhere', known)).toBeNull();
    expect(parseProfiles('', known)).toBeNull();
});

test('a tick of a few units after the first means only the restock trickle is left', () => {
    expect(trickleOnly(3, false, 0)).toBe(true);
    expect(trickleOnly(9, false, 0)).toBe(true);
    expect(trickleOnly(10, false, 0)).toBe(false);
    expect(trickleOnly(50, false, 0)).toBe(false);
    expect(trickleOnly(2, true, 0)).toBe(false);
    expect(trickleOnly(0, false, 0)).toBe(false);
    expect(trickleOnly(3, false, 20)).toBe(false);
});

test('lotValue counts only the quoted items the shop sells, at the base price, up to a shelf of units', () => {
    const sarim = [{ re: /^fishing bait$/i }, { re: /^feather$/i }];
    const quotes = [
        { id: 313, name: 'Fishing bait', basePrice: 3, bid: 218, buyQuantity: 38_334 },
        { id: 560, name: 'Death rune', basePrice: 30, bid: 250, buyQuantity: 100_000 },
    ];
    expect(lotValue(sarim, quotes)).toBe(1_020_500);
    expect(lotValue(sarim, quotes, 1500)).toBe(306_150);
    expect(lotValue(sarim, quotes.slice(1))).toBe(0);
    expect(lotValue(sarim, [{ ...quotes[0]!, buyQuantity: 10 }])).toBe(2041);
    expect(lotValue(sarim, [{ ...quotes[0]!, bid: null }])).toBe(0);
});
