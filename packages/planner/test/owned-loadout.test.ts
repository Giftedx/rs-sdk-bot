import {expect,test} from 'bun:test';
import {ownedLoadout,type GearSlot} from '../src/owned-loadout';
const option=(id:number,preference=0,count=1)=>({id,count,preference,equippable:true as const});

test('alternative assignment backtracks instead of spending the only later required item',()=>{
 const slots:GearSlot[]=[{key:'weapon',options:[option(1),option(2,1)]},{key:'quest-input',options:[option(1)]}];
 const result=ownedLoadout(slots,[{id:1,count:1},{id:2,count:1}]);
 expect(result.state).toBe('ready');expect(result.selected.map(x=>x.id)).toEqual([2,1]);
});
test('reservations and stack quantities cannot be reused across slots',()=>{
 const slots=[{key:'ammo',options:[option(884,0,15)]},{key:'reserve',options:[option(884,0,5)]}];
 expect(ownedLoadout(slots,[{id:884,count:20}],[{id:884,count:1}]).state).toBe('missing');
 expect(ownedLoadout(slots,[{id:884,count:21}],[{id:884,count:1}]).state).toBe('ready');
});
test('unknown eligibility is never equippable and known lower-ranked alternative is usable',()=>{
 const slots=[{key:'weapon',options:[{...option(1),equippable:null},option(2,1)]}];
 expect(ownedLoadout(slots,[{id:1,count:1}]).state).toBe('unknown');
 expect(ownedLoadout(slots,[{id:1,count:1},{id:2,count:1}]).selected[0]?.id).toBe(2);
 expect(ownedLoadout([{key:'weapon',options:[{...option(1),equippable:false}]}],[{id:1,count:1}]).state).toBe('missing');
});
test('two-handed candidates cannot also satisfy a shield requirement',()=>{
 const slots=[{key:'weapon',options:[{...option(1),occupies:['shield']},option(2,1)]},{key:'shield',options:[option(3)]}];
 expect(ownedLoadout(slots,[{id:1,count:1},{id:2,count:1},{id:3,count:1}]).selected.map(x=>x.id)).toEqual([2,3]);
});
test('unknown stock remains unknown; invalid quantities and duplicate slots fail',()=>{
 expect(ownedLoadout([{key:'weapon',options:[option(1)]}],[],[],false).state).toBe('unknown');
 expect(()=>ownedLoadout([{key:'x',options:[option(1)]}],[{id:1,count:NaN}])).toThrow();
 expect(()=>ownedLoadout([{key:'x',options:[option(1)]},{key:'x',options:[option(2)]}],[])).toThrow();
 expect(()=>ownedLoadout([{key:'x',options:[option(1)]}],[{id:1,count:Number.MAX_SAFE_INTEGER},{id:1,count:1}])).toThrow();
});
