import {test,expect} from 'bun:test';
import {BLUE_DRAGON,selectCampTarget,campDeathCredit,runRangedCamp} from './microbot-a-ranged-camp';
test('camp selects fresh full-health unclaimed target in native range only',()=>{
 const n:any={id:55,index:1,x:2923,z:9780,distance:5,hp:105,maxHp:105,inCombat:false,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 expect(selectCampTarget([n],BLUE_DRAGON)?.index).toBe(1);for(const change of [{hp:100},{inCombat:true},{reachable:false},{x:2950},{id:941},{hp:null}])expect(selectCampTarget([{...n,...change}],BLUE_DRAGON)).toBeUndefined();
});
test('camp credit needs own witnessed death and one of each exact native drop',()=>{
 const o={witness:true,foreign:false,xp:100,loot:[1,1]};expect(campDeathCredit(o,BLUE_DRAGON)).toBe(true);for(const change of [{witness:false},{foreign:true},{xp:0},{loot:[1,0]},{loot:[2,1]}])expect(campDeathCredit({...o,...change},BLUE_DRAGON)).toBe(false);
});
test('camp cap must be finite before session access',async()=>{await expect(runRangedCamp({} as any,BLUE_DRAGON,{cap:Infinity})).rejects.toThrow('invalid');});
