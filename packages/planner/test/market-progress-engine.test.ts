import {expect,test} from 'bun:test';
import {marketProgress,type MarketProgress} from '../src/market-progress';
// The engine package owns its private #/ imports. Load its real implementation
// at runtime rather than applying the root project's TypeScript paths to it.
const enginePath='../../../vendor/rs-sdk/server/engine/src/engine/market/MarketStore';
const {MarketStore}=await import(enginePath);
type MarketAccount={owner:string;take(id:number,n:number):void;give(id:number,n:number):number;save():Uint8Array;rollback():void};
type Offer={id:number;item:number;side:'buy'|'sell';quantity:number;price:number;filled:number;gross:number;tax:number};
function account(owner:string,initial:Record<number,number>):MarketAccount&{items:Map<number,number>}{
 const items=new Map(Object.entries(initial).map(([id,count])=>[Number(id),count]));let saved=new Map(items);
 return{owner,items,take(id,n){if((items.get(id)??0)<n)throw Error('stock short');items.set(id,(items.get(id)??0)-n);},give(id,n){items.set(id,(items.get(id)??0)+n);return n;},save(){saved=new Map(items);return new Uint8Array([1]);},rollback(){items.clear();for(const [id,n] of saved)items.set(id,n);}};
}
test('actual engine partial fills and partial collection remain one cumulative execution ledger',()=>{
 const store=new MarketStore(':memory:');
 try{
  const buyer=account('buyer',{995:1000}),seller=account('seller',{1331:10});
  store.place(seller,1331,'sell',4,90,995);const order=store.place(buyer,1331,'buy',10,100,995);
  const observation=(at:number):MarketProgress=>{const o=store.db.query('SELECT * FROM offers WHERE id=?').get(order.id) as Offer;return{actor:buyer.owner,server:'engine-fixture',offerId:o.id,itemId:o.item,side:o.side,quantity:o.quantity,limit:o.price,filled:o.filled,gross:o.gross,tax:o.tax,at};};
  const first=observation(1);expect(first).toMatchObject({filled:4,gross:360});
  const baseline={...first,filled:0,gross:0,tax:0};expect(marketProgress(baseline,first).delta).toEqual({filled:4,gross:360,tax:0});
  expect(store.collect(buyer,order.id,995)).toEqual({items:4,coins:40});
  expect(marketProgress(first,observation(2)).delta).toEqual({filled:0,gross:0,tax:0});
  store.place(seller,1331,'sell',6,80,995);const last=observation(3);
  expect(marketProgress(first,last).delta).toEqual({filled:6,gross:600,tax:0});
  expect(store.collect(buyer,order.id,995)).toEqual({items:6,coins:0});
  expect(buyer.items.get(1331)).toBe(10);expect(buyer.items.get(995)).toBe(40);
  expect(last.gross).toBe(1000-buyer.items.get(995)!);
 }finally{store.db.close();}
});
test('actual engine fragmented sell fills preserve cumulative tax rounding and net proceeds',()=>{
 const store=new MarketStore(':memory:');
 try{
  const seller=account('seller',{1331:3}),order=store.place(seller,1331,'sell',3,19,995);
  const observation=(at:number):MarketProgress=>{const o=store.db.query('SELECT * FROM offers WHERE id=?').get(order.id) as Offer;return{actor:seller.owner,server:'engine-fixture',offerId:o.id,itemId:o.item,side:o.side,quantity:o.quantity,limit:o.price,filled:o.filled,gross:o.gross,tax:o.tax,at};};
  let previous=observation(1),units=0,gross=0,tax=0;
  for(let n=0;n<3;n++){
   store.place(account('buyer'+n,{995:19}),1331,'buy',1,19,995);
   const next=observation(n+2),delta=marketProgress(previous,next).delta;units+=delta.filled;gross+=delta.gross;tax+=delta.tax;previous=next;
  }
  expect({units,gross,tax}).toEqual({units:3,gross:57,tax:2});
  expect(store.collect(seller,order.id,995)).toEqual({items:0,coins:55});
  expect(seller.items.get(995)).toBe(gross-tax);
 }finally{store.db.close();}
});
