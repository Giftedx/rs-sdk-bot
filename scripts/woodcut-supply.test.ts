import {test,expect} from 'bun:test';
import {supplyPlan} from './woodcut-supply';
test('retained log supply admits only a finite accounting-compatible headless batch',()=>{
 expect(supplyPlan(25,165,3000)).toEqual({logs:25,headless:165,shafts:375});
 for(const args of [[0,0,3000],[26,0,3000],[25,180,3000],[25,164,3000],[25,165,0],[NaN,0,3000]])expect(()=>supplyPlan(...args as [number,number,number])).toThrow();
});
