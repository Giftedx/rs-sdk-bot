import {createHash} from 'node:crypto';
import {test,expect} from 'bun:test';
import {netCosts} from './net-costs';
const workers=['mmtha0205','mmthv2350','Pocketpython','mmsmk1232'];
const owned=new Set(['bigpackage','moneyshot','pocketrocket',...workers.map(s=>s.toLowerCase())]);
function snapshot(name:string,at:number,coins:number,food:number):any{return {name,server:'rs-sdk-demo.fly.dev',at,bankAt:at,inventory:coins?[{id:995,count:coins}]:[],bank:food?[{id:333,count:food}]:[],result:'ok'};}
function fixture(){
 const opening=[snapshot('Moneyshot',80,10000,0),snapshot('Bigpackage',80,4,2150)],funded=[snapshot('Moneyshot',100,5000,0),snapshot('Bigpackage',100,5004,2150)];
 const firstCourier={...snapshot('Bigpackage',130,4944,1991),started:120,counters:{feathersBought:0}},lastCourier={...snapshot('Bigpackage',150,4944,1355),started:140,counters:{feathersBought:0}};
 const start=snapshot('Pocketrocket',130,100,160),batch=workers.map(w=>snapshot(w,150,100,160));
 const production=(before:any,gain:number,started:number,at:number,hosted=false)=>{
  const end={...snapshot(before.name,at,before.inventory[0].count+gain,before.bank[0].count-2),started,counters:{coinsGained:gain,eaten:2,ticks:10}};
  const prefix=hosted?`[${end.name}] `:'';
  return {at:at+1,status:end,logTail:[prefix+'LOGOUT logged-out',prefix+`RESULT ok coinsGained=${gain} eaten=2 ticks=10 died=false`]};
 };
 const first=production(start,10,200,210),second=production(first.status,20,220,230),host=batch.map((b,i)=>production(b,(i+3)*10,200,210,true));
 const upstream={...snapshot('Bigpackage',60,4,2150),started:50,result:'fail no fare',counters:{received:2150,coins:4,feathersBought:340}};
 const lines=['FUNDING_RECEIPT received=0 reason=sufficient coins=3014','FOODCOURIER from=Masterbaiter coins=3014 fishNotes=0','RESULT fail received=2150 handed=0 fishNotes=2150 coins=4 feathersBought=340'];
 return {upstreamSource:{source:{Bigpackage:upstream}},upstreamLog:{name:upstream.name,server:upstream.server,at:60,started:50,lines,source:{sha256:createHash('sha256').update(lines.join('\n')).digest('hex')}},fundingSource:opening,funding:{ok:true,result:{ok:true},at:101,after:funded},foodSource:[funded[1],snapshot('Pocketrocket',110,100,1)],foodDelivery:{ok:true,at:131,result:{ok:true,result:{incoming:159}},after:[firstCourier,start]},batchSource:[firstCourier,...workers.map(w=>snapshot(w,130,100,1))],delivery:{ok:true,at:151,result:{ok:true,results:workers.map(name=>({name,result:{incoming:159}}))},after:[lastCourier,...batch]},firstProduction:first,production:second,hostProduction:{at:211,states:host.map(p=>p.status),logTail:host.flatMap(p=>p.logTail)}};
}
test('matched cash excludes internal funding and opening coins; consumes each completed session once',()=>{
 const result=netCosts(fixture(),owned,1000);expect(result.valid).toBe(true);expect(result.net).toBe(-2860);expect(result.earned).toBe(210);expect(result.courierSpend).toBe(3070);expect(result.eaten).toBe(12);expect(result.fishUsed).toBe(12);expect(result.rows.find(r=>r.label==='Full net profit')?.value).toContain('Unknown');
});
test('unreconciled cash, overlapping sessions, duplicate actors and missing receipts cannot produce net earnings',()=>{
 for(const mutate of [(r:any)=>r.production.status.inventory[0].count++,(r:any)=>r.production.status.started=205,(r:any)=>r.hostProduction.states[1]=r.hostProduction.states[0],(r:any)=>delete r.foodSource,(r:any)=>r.upstreamLog.lines[0]='forged',(r:any)=>r.production.logTail[1]+=' coinsGained=20',(r:any)=>r.foodDelivery.ok=false,(r:any)=>r.funding.after[0].server='localhost:8888',(r:any)=>r.production.at=1001,(r:any)=>r.delivery.after[0].bank=[null]]){
  const r=fixture();mutate(r);const result=netCosts(r,owned,1000);expect(result.valid).toBe(false);expect(result.net).toBeNull();
 }
});
test('eat-event mismatch remains visible without changing reconciled cash',()=>{
 const r=fixture();r.production.status.counters.eaten=3;r.production.logTail[1]=r.production.logTail[1]!.replace('eaten=2','eaten=3');
 const result=netCosts(r,owned,1000);expect(result.valid).toBe(true);expect(result.net).toBe(-2860);expect(result.rows.find(r=>r.label==='Food reconciliation')?.value).toContain('1 unexplained');
});

test('opposite food discrepancies do not cancel between sessions',()=>{
 const r=fixture();
 r.firstProduction.status.counters.eaten=1;r.firstProduction.logTail[1]=r.firstProduction.logTail[1]!.replace('eaten=2','eaten=1');
 r.production.status.counters.eaten=3;r.production.logTail[1]=r.production.logTail[1]!.replace('eaten=2','eaten=3');
 const result=netCosts(r,owned,1000);
 expect(result.valid).toBe(true);expect(result.fishUsed).toBe(result.eaten);expect(result.foodGaps).toHaveLength(2);
 expect(result.rows.find(r=>r.label==='Food reconciliation')?.value).toContain('2 unexplained across 2 runs');
});

test('food chain closes pooled balances without inventing producer cost or lot attribution',()=>{
 const r=netCosts(fixture(),owned,1000),chain=r.foodChain!;
 expect(r.valid).toBe(true);
 expect(chain.delivery).toEqual({quantity:795,courierOpening:2150,courierRemaining:1355,recipientOpening:5,recipientRemaining:788,matched:true});
 expect(chain.consumption.stockDepleted).toBe(12);
 expect(chain.collection.matched).toBe(false);expect(chain.collection.cookDebit).toBeNull();
 expect(chain.production.quantity).toBeNull();expect(chain.costs.foodAcquisition).toBeNull();
 expect(chain.costs.fullNetProfit).toBeNull();expect(chain.consumption.lotAttributed).toBe(false);
 expect(chain.costs.earned-chain.costs.courierCash).toBe(r.net!);
});

test('equal fish totals cannot hide a different item crossing a handoff',()=>{
 const r=fixture();r.foodDelivery.after[1]!.bank[0].id=329;
 const result=netCosts(r,owned,1000);
 expect(result.valid).toBe(false);expect(result.net).toBeNull();
 expect(result.rows[0]!.value).toContain('item mismatch');
});

test('saved pack can locate other stock without proving its origin or price',()=>{
 const r=fixture();
 // Keep all courier snapshots continuous while adding untouched bank stock.
 const snapshots=[r.upstreamSource.source.Bigpackage,r.fundingSource[1],r.funding.after[1],r.foodDelivery.after[0],r.delivery.after[0]];
 for(const s of new Set(snapshots)){s.bank.push({id:329,count:30},{id:333,count:2});}
 const upstream=r.upstreamSource.source.Bigpackage;
 upstream.inventory.push({id:334,baseId:333,count:2150});upstream.bank.shift();
 const result=netCosts(r,owned,1000);
 expect(result.valid).toBe(true);expect(result.net).toBe(-2860);
 expect(result.foodChain!.collection.otherStockLocation).toEqual({location:'bank',items:[{id:329,quantity:30},{id:333,quantity:2}]});
 expect(result.foodChain!.collection.unattributedCourierStock).toBe(32);
 expect(result.foodChain!.collection.matched).toBe(false);
 expect(result.foodChain!.costs.collectionTrip).toEqual({total:3010,supplies:null,travel:null});
 expect(result.foodChain!.costs.fullNetProfit).toBeNull();
});

test('a reported receipt alone cannot locate the unlinked stock',()=>{
 const result=netCosts(fixture(),owned,1000);
 expect(result.valid).toBe(true);expect(result.foodChain!.collection.otherStockLocation).toBeNull();
});
