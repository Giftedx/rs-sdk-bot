import {expect,test} from 'bun:test';
import {resolveMarketStep} from './aio-market';
import {planAioPipeline,toSwarmChainJob} from './aio';
import {parseStep} from '../packages/core/src/chain-step';

test('AIO shop-sell starts the complete merchant trip rather than an unopened staged seller',()=>{
 const args=['.practice/owned surplus/job.json'];
 const sale=resolveMarketStep('shop-sell',args);
 const trip=resolveMarketStep('shop-trip',args);
 expect(sale).toEqual({script:'scripts/aio-market.ts',args:['shop-sell',...args],env:{}});
 expect(trip).toEqual({script:'scripts/aio-market.ts',args:['shop-trip',...args],env:{}});
 const steps=planAioPipeline(['market:shop-sell ".practice/owned surplus/job.json"','market:shop-trip ".practice/owned surplus/job.json"']);
 const job=toSwarmChainJob('Seller','supply','Sell spare kit for route supplies',steps);
 expect(job.args.map(parseStep)).toEqual([sale,trip]);
});
