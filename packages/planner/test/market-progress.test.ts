import {expect,test} from 'bun:test';
import {marketProgress,type MarketProgress} from '../src/market-progress';
const row=(change:Partial<MarketProgress>={}):MarketProgress=>({actor:'Buyer',server:'local',offerId:7,itemId:1331,side:'buy',quantity:10,limit:100,filled:0,gross:0,tax:0,at:1,...change});
test('first observation is a baseline, not new earnings or an inferred placement',()=>{
 const result=marketProgress(null,row({filled:4,gross:300}));
 expect(result.baseline).toBe(true);expect(result.delta).toEqual({filled:0,gross:0,tax:0});
});
test('cumulative updates count each unit once across duplicates and persisted restart state',()=>{
 const first=row({filled:4,gross:300});const second=row({filled:7,gross:530,at:2});
 const update=marketProgress(first,second);expect(update.delta).toEqual({filled:3,gross:230,tax:0});
 const restart=JSON.parse(JSON.stringify(update.current));expect(marketProgress(restart,{...second,at:3}).delta).toEqual({filled:0,gross:0,tax:0});
});
test('foreign order/account/server or regressed cumulative evidence never merges',()=>{
 const prior=row({filled:4,gross:300,at:2});
 for(const change of [{actor:'Other'},{server:'elsewhere'},{offerId:8},{itemId:1287},{quantity:11},{limit:101},{filled:3},{gross:299},{at:1}]){
  expect(()=>marketProgress(prior,{...prior,...change})).toThrow();
 }
 expect(()=>marketProgress(prior,{...prior,gross:301,at:3})).toThrow('without new fills');
});
test('provided tax is cumulative and fragmentation does not double debit it',()=>{
 const prior=row({side:'sell',filled:1,gross:101,tax:5});
 expect(marketProgress(prior,{...prior,filled:2,gross:202,tax:10,at:2}).delta).toEqual({filled:1,gross:101,tax:5});
 expect(()=>marketProgress(null,row({filled:1,gross:100,tax:1}))).toThrow('buy tax');
});
test('unsafe products, impossible gross and fractional quantities are rejected',()=>{
 for(const change of [{quantity:1.5},{quantity:Number.MAX_SAFE_INTEGER,limit:2},{filled:11},{filled:1,gross:101},{filled:0,gross:1},{tax:-1}])expect(()=>marketProgress(null,row(change))).toThrow();
});
test('new-fill execution prices must respect the limit even when cumulative totals look plausible',()=>{
 const prior=row({filled:1,gross:1});
 expect(()=>marketProgress(prior,{...prior,filled:2,gross:200,at:2})).toThrow('delta');
});
