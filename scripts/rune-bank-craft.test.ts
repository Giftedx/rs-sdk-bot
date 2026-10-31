import {test,expect} from 'bun:test';
import {runeBankTarget,runeBankBalanced,runeBankDone,runeBankOk,type RuneBankLedger} from './rune-bank-craft';

const ledger=(o:Partial<RuneBankLedger>={}):RuneBankLedger=>({essence0:30,essence:0,air0:30,air:60,consumed:30,crafted:30,...o});
const base={level0:1,level:2,target:99,bankEssence:0,held:{essence:0,air:0},stopped:false};

test('target is a bounded Runecraft level',()=>{
 expect(runeBankTarget()).toBe(99);expect(runeBankTarget(20)).toBe(20);
 for(const v of [1,100,NaN,2.5])expect(()=>runeBankTarget(v)).toThrow('Runecraft target');
});
test('essence spent equals the essence debit; banked runes equal the crafted output',()=>{
 expect(runeBankBalanced(ledger())).toBe(true);
 // Level 11+ makes two runes per essence.
 expect(runeBankBalanced(ledger({air:90,crafted:60}))).toBe(true);
 expect(runeBankBalanced(ledger({essence:1}))).toBe(false);
 expect(runeBankBalanced(ledger({air:59}))).toBe(false);
 expect(runeBankBalanced(ledger({crafted:29,air:59}))).toBe(false);
});
test('the order ends at the target level or when the bank has no essence',()=>{
 expect(runeBankDone(20,20,500)).toBe(true);expect(runeBankDone(5,20,0)).toBe(true);expect(runeBankDone(5,20,1)).toBe(false);
});
test('pass needs observed progress, an empty pack, no stop and a finished order',()=>{
 expect(runeBankOk({...base,ledger:ledger()})).toBe(true);
 expect(runeBankOk({...base,ledger:undefined})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),stopped:true})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),held:{essence:0,air:3}})).toBe(false);
 expect(runeBankOk({...base,ledger:ledger(),bankEssence:5})).toBe(false);
 // No essence at entry is acquisition work, not a pass.
 expect(runeBankOk({...base,ledger:ledger({essence0:0,consumed:0,crafted:0,air:30})})).toBe(false);
 expect(runeBankOk({...base,level0:99,level:99,bankEssence:7,ledger:ledger({essence0:7,essence:7,consumed:0,crafted:0,air:30})})).toBe(true);
});
