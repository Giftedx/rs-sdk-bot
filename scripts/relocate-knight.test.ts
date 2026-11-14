import {expect,test} from 'bun:test';
import {knightRelocationProfile,relocationStart,relocationAssets,relocationPreserved,relocateKnight} from './relocate-knight';
import {guardCowWalker} from './gather-combat';

test('legacy account aliases remain available without granting an unknown starting tile',()=>{
    for(const name of ['Haggis','main','stranger','Bigpackage',''])expect(()=>knightRelocationProfile(name)).toThrow('bank start required');
    expect(knightRelocationProfile('POCKETROCKET').name).toBe('Pocketrocket');
    for(const name of ['Pocketrocket','mmtha0205','Mightyrod','Freshworker']){
        expect(()=>knightRelocationProfile(name,{worldX:3222,worldZ:3218,level:0})).toThrow('bank start required');
        expect(()=>knightRelocationProfile(name,{worldX:2727,worldZ:3492,level:1})).toThrow('bank start required');
    }
});
test('any ordinary account selects a known route from its observed bank rather than its name',()=>{
    for(const name of ['Freshworker','Pocketrocket','mmtha0205','Mightyrod']){
        expect(knightRelocationProfile(name,{worldX:2721,worldZ:3493,level:0}).name).toBe('seers');
        expect(knightRelocationProfile(name,{worldX:2809,worldZ:3441,level:0}).name).toBe('catherby');
        expect(knightRelocationProfile(name,{worldX:2619,worldZ:3332,level:0}).name).toBe('ardougne-north');
        expect(knightRelocationProfile(name,{worldX:2655,worldZ:3283,level:0}).points).toEqual([[2655,3283]]);
    }
    expect(()=>knightRelocationProfile('Pocketrocket',{worldX:2720,worldZ:3493,level:0})).toThrow('bank start required');
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
test('reused relocation guard forwards live-hunter avoidance to its existing route validator',()=>{
    const avoid=[{x:2661,z:3320}],from={x:2655,z:3283},to={x:2657,z:3283};let received:unknown;
    const base:any={pos:()=>({...from,level:0}),plan:(_level:number,_from:unknown,_to:unknown,closed:unknown)=>{received=closed;return[to];},walk:()=>{},interactLoc:()=>{}};
    const guard=guardCowWalker(base,()=>null);
    expect(guard.deps.plan(0,from,to,avoid)).toEqual([to]);expect(received).toBe(avoid);expect(guard.reason()).toBeNull();
});
test('relocation captures initial life primitives before a reused player object mutates',async()=>{
    for(const field of ['lifeId','respawnCount']as const){
        const player={worldX:2619,worldZ:3332,level:0,lifeId:1,respawnCount:0,isDead:false};let generation=0,opens=0;
        const state={player,equipment:[],skills:Array.from({length:21},(_,i)=>({name:'Skill'+i,experience:0})),nearbyNpcs:[]};
        const s:any={tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},bankObservation:()=>generation?{generation,items:[]}:null,
            sdk:{getState:()=>state,getSkill:()=>({level:60}),getInventory:()=>[],getEquipment:()=>[]},
            bot:{openBank:async()=>{opens++;generation++;player[field]++;return{success:true};}}};
        const result=await relocateKnight(s,'Freshworker');
        expect(result.ok).toBe(false);expect(result.died).toBe(true);expect(result.failure).toContain('ended/dead');expect(opens).toBe(1);
    }
});
