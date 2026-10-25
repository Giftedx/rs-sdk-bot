import {expect,test} from 'bun:test';
import {knightRelocationProfile,relocationStart,relocationAssets,relocationPreserved} from './relocate-knight';
import {guardCowWalker} from './gather-combat';

test('only explicit owned role names have routes; no reserved or arbitrary actor CLI profile',()=>{
    for(const name of ['Haggis','main','stranger','Bigpackage',''])expect(()=>knightRelocationProfile(name)).toThrow('only Pocketrocket');
    expect(knightRelocationProfile('POCKETROCKET').name).toBe('Pocketrocket');
});
test('Seers actual booth at2721,3493 is admitted at radius6, and Catherby skips irrelevant Seers legs',()=>{
    const p=knightRelocationProfile('Pocketrocket');
    expect(relocationStart({worldX:2721,worldZ:3493,level:0},p)).toBe(true);
    expect(relocationStart({worldX:2720,worldZ:3493,level:0},p)).toBe(false);
    expect(relocationStart({worldX:2721,worldZ:3493,level:1},p)).toBe(false);
    expect(p.points).toEqual([[2763,3472],[2800,3457],[2809,3441],[2677,3358],[2648,3358],[2654,3283]]);
    const c=knightRelocationProfile('mmtha0205');expect(c.points).toEqual(p.points.slice(2));
    expect(relocationStart({worldX:2807,worldZ:3441,level:0},c)).toBe(true);
});
test('Mighty only uses the explicit inverse guarded bank corridor',()=>{
    const p=knightRelocationProfile('Mightyrod');expect(p.points).toEqual([[2644,3293],[2655,3283]]);
    expect(relocationStart({worldX:2618,worldZ:3332,level:0},p)).toBe(true);
    expect(relocationStart({worldX:2655,worldZ:3283,level:0},p)).toBe(false);
});
test('all food/tools/notes/cash count exactly across held,worn and bank; securing cash is not loss',()=>{
    const initial=relocationAssets([{id:995,count:13000},{id:995,count:10},{id:329,count:2},{id:946,count:1},{id:1778,count:500}]);
    const final=relocationAssets([{id:995,count:13010},{id:329,count:1},{id:329,count:1},{id:946,count:1},{id:1778,count:500}]);
    expect(relocationPreserved(initial,final)).toBe(true);final.set(329,1);expect(relocationPreserved(initial,final)).toBe(false);
    final.set(329,2);final.set(995,13009);expect(relocationPreserved(initial,final)).toBe(false);
});
test('latched damage stops the reused guard before another move or door operation',()=>{
    let damaged=false,inputs=0;const base:any={pos:()=>({x:2721,z:3493,level:0}),plan:()=>[{x:2722,z:3493}],walk:()=>{inputs++;},interactLoc:()=>{inputs++;}};
    const guard=guardCowWalker(base,()=>damaged?'relocation first HP drop':null);
    guard.deps.walk(2722,3493);expect(inputs).toBe(1);damaged=true;guard.deps.walk(2722,3493);guard.deps.interactLoc({x:2722,z:3493,id:1530},1);
    expect(inputs).toBe(1);expect(guard.reason()).toBe('relocation first HP drop');
});
