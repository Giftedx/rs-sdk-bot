import {expect,test} from 'bun:test';
import {planBronze,bronzeProgress} from './smelt-bars';
test('bronze plans equal pairs within free slots and both reserves',()=>{
 expect(planBronze(10,9,25,8,1)).toBe(8);
 expect(planBronze(10,9,5,8,1)).toBe(2);
 expect(planBronze(10,1,25,8,1)).toBe(0);
});
test('bronze progress needs actual output, both debits, and XP',()=>{
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:7,tin:7,bars:1,xp:155})).toBe(1);
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:8,tin:8,bars:1,xp:155})).toBe(0);
 expect(bronzeProgress({copper:8,tin:8,bars:0,xp:0},{copper:7,tin:7,bars:1,xp:0})).toBe(0);
});
test('bronze rejects invalid planning bounds',()=>{
 expect(()=>planBronze(10,9,25,8,-1)).toThrow();
 expect(()=>planBronze(10,9,25,1.5,1)).toThrow();
});
