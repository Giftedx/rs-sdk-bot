import {test,expect} from 'bun:test';
import {plan,needs,nearestBank,presetFor} from './quest-sweep';

test('the plan withdraws what the pack lacks and names what the bank cannot cover',()=>{
 const need=needs({inventory:[{id:434,count:1},{id:434,count:5},{id:436,count:4},{id:440,count:2}]});
 expect(need.get(434)).toBe(6);
 const p=plan(need,[{id:434,count:2}],[{id:434,count:10},{id:436,count:1}]);
 expect(p.withdraw).toEqual([{id:434,count:4},{id:436,count:1}]);
 expect(p.missing).toEqual([{id:436,count:3},{id:440,count:2}]);
 expect(plan(need,[{id:434,count:6},{id:436,count:4},{id:440,count:2}],[])).toEqual({withdraw:[],missing:[]});
});

test('preset food is split from the quest items',()=>{
 const preset={inventory:[{id:434,count:6},{id:379,count:4}]};
 expect([...needs(preset)]).toEqual([[434,6]]);
 expect([...needs(preset,true)]).toEqual([[379,4]]);
});

test('the nearest bank is on the same floor and closest by tiles',()=>{
 expect(nearestBank({x:3222,z:3218,level:0})).toMatchObject({x:3269,z:3167});
 expect(nearestBank({x:2930,z:3450,level:0})).toMatchObject({x:2947,z:3368});
});

test('every swept quest has a start tile, and an unknown quest refuses',()=>{
 expect(presetFor('doric').position).toMatchObject({level:0});
 expect(()=>presetFor('nosuchquest')).toThrow('no preset');
});
