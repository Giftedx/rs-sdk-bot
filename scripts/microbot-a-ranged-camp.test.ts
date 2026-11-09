import {test,expect} from 'bun:test';
import {campCombatRefusal,campOwnershipConflict,BLUE_DRAGON,selectCampTarget,campDeathCredit,runRangedCamp} from './microbot-a-ranged-camp';
test('camp selects fresh full-health unclaimed target in native range only',()=>{
 const n:any={id:55,index:1,x:2897,z:9798,distance:5,hp:105,maxHp:105,inCombat:false,reachable:true,optionsWithIndex:[{text:'Attack',opIndex:2}]};
 expect(selectCampTarget([n],BLUE_DRAGON)?.index).toBe(1);expect(selectCampTarget([{...n,hp:null,maxHp:null}],BLUE_DRAGON)?.index).toBe(1);expect(selectCampTarget([{...n,inCombat:true,targetIndex:32769}],BLUE_DRAGON,1)?.index).toBe(1);for(const change of [{hp:100},{inCombat:true},{reachable:false},{x:2950},{id:941}])expect(selectCampTarget([{...n,...change}],BLUE_DRAGON)).toBeUndefined();
});
test('camp credit needs own witnessed death and one of each exact native drop',()=>{
 const o={witness:true,foreign:false,xp:420,loot:[1,1]};expect(campDeathCredit(o,BLUE_DRAGON)).toBe(true);for(const change of [{witness:false},{foreign:true},{xp:0},{xp:419},{loot:[1,0]},{loot:[2,1]}])expect(campDeathCredit({...o,...change},BLUE_DRAGON)).toBe(false);
});
test('camp cap must be finite before session access',async()=>{await expect(runRangedCamp({} as any,BLUE_DRAGON,{cap:Infinity})).rejects.toThrow('invalid');});

test('a dead native target clearing its claim is not a foreign live attacker',()=>{
 expect(campOwnershipConflict({hp:0,inCombat:true,targetIndex:-1},1)).toBe(false);
 expect(campOwnershipConflict({hp:1,inCombat:true,targetIndex:-1},1)).toBe(true);
 expect(campOwnershipConflict({hp:null,inCombat:true,targetIndex:32770},1)).toBe(true);
 expect(campOwnershipConflict({hp:1,inCombat:true,targetIndex:32769},1)).toBe(false);
});

test('single-combat retry accepts only a fresh native refusal, never old text or player chat',()=>{
 const m:any={type:0,sender:'',fromSelf:false,text:"I'm already under attack!",tick:12,observationId:7};
 expect(campCombatRefusal([m],6,11)).toBe(true);expect(campCombatRefusal([m],7,11)).toBe(false);
 expect(campCombatRefusal([{...m,type:2,sender:'Player'}],6,11)).toBe(false);
 expect(campCombatRefusal([{...m,fromSelf:true}],6,11)).toBe(false);
});
