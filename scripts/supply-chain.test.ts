import {expect,test} from 'bun:test';
import {supplyAdmission,supplyCount,supplyRestock} from './supply-chain';
test('capital shortage earns before payout, real surplus waits for consumer demand',()=>{
    expect(supplyAdmission(20,14999,62)).toBe('earn-reserve');
    expect(supplyAdmission(20,15000,62)).toBe('cycle');
    expect(supplyAdmission(80,25000,1000)).toBe('drain-food');
    expect(supplyAdmission(79,10000,1500)).toBe('cycle');
    expect(()=>supplyAdmission(20,NaN,62)).toThrow();
});
test('unknown bank is not an empty food reserve; restock counts owned feathers once',()=>{
    expect(()=>supplyCount({inventory:[],bank:null},[329])).toThrow();
    expect(supplyCount({inventory:[{id:330,count:2}],bank:[{id:329,count:4}]},[329,330])).toBe(6);
    expect(supplyRestock(29)).toBe(971);expect(supplyRestock(1050)).toBe(0);
    expect(()=>supplyRestock(-1)).toThrow();
});
