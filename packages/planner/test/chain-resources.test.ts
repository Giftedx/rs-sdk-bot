import {expect,test} from 'bun:test';
import {jobResources} from '../src/autopilot';
import {formatStep} from '../../core/src/chain-step';

test('generated literal argument chains reserve the same shops, pens and fishing spots as their workers',()=>{
 const args=[
  formatStep({script:'scripts/shop-buyer.ts',args:['harry','300'],env:{CAP:'300'}}),
  formatStep({script:'scripts/gather-fish.ts',args:['cage'],env:{CAP:'500'}}),
  formatStep({script:'scripts/gather-feathers.ts',args:[],env:{PEN:'3017,3288'}}),
 ];
 expect(jobResources({script:'scripts/chain.ts',args})).toEqual(['shop:harry','catherby:lobster','pen:3017,3288']);
 expect(jobResources({script:'scripts/chain.ts',args:[formatStep({script:'scripts/gather-fish.ts',args:['harpoon'],env:{}})]})).toEqual([]);
});

test('a literal argv assignment cannot override the chain environment in resource admission',()=>{
 const step=formatStep({script:'scripts/goldfarm.ts',args:['KNIGHT_SPOT=2582,3297'],env:{KNIGHT_SPOT:'2671,3313'}});
 expect(jobResources({script:'scripts/chain.ts',args:[step],env:{KNIGHT_SPOT:'2652,3318'}})).toEqual(['knight:2671,3313']);
 expect(jobResources({script:'scripts/chain.ts',args:['scripts/goldfarm.ts KNIGHT_SPOT=2582,3297']})).toEqual(['knight:2582,3297']);
});

test('quoted legacy chain arguments are decoded before resource selection',()=>{
 expect(jobResources({script:'scripts/chain.ts',args:['scripts/shop-buyer.ts "harry" 300']})).toEqual(['shop:harry']);
 expect(jobResources({script:'scripts/chain.ts',args:['scripts/gather-fish.ts "cage" 3000']})).toEqual(['catherby:lobster']);
 expect(jobResources({script:'scripts/gather-fish.ts',args:['cage','3000']})).toEqual(['catherby:lobster']);
});
