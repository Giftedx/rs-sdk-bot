import {expect,test} from 'bun:test';
import {chickenTrainingStyle,chickenTrainingKit,chickenTrainingProfile,chickenTrainingThreat,chickenTrainingTarget,trainChickens} from './train-chickens';
import {mixedOreCombatProblem} from './gather-ore';

test('qualification keeps combat13 by default and admits the bounded combat29 courier target',()=>{
    expect(chickenTrainingTarget()).toBe(13);
    expect(chickenTrainingTarget(29)).toBe(29);
    for(const n of [NaN,0,12,14,28,29.5,126])expect(()=>chickenTrainingTarget(n)).toThrow('13 or29');
});

test('training raises the weakest melee stat with the actual bronze sword style indices',()=>{
    expect(chickenTrainingStyle({Attack:5,Strength:1,Defence:5})).toBe(1);
    expect(chickenTrainingStyle({Attack:1,Strength:5,Defence:5})).toBe(0);
    expect(chickenTrainingStyle({Attack:5,Strength:5,Defence:1})).toBe(3);
    expect(()=>chickenTrainingStyle({Attack:0,Strength:1,Defence:1})).toThrow();
});

test('the mixed mine requires combat above twice the level6 rat, with unknown stats refused',()=>{
    for(const level of [undefined,NaN,0,3,12,12.5])expect(mixedOreCombatProblem(level)).toContain('combat13');
    expect(mixedOreCombatProblem(13)).toBeNull();
    expect(mixedOreCombatProblem(50)).toBeNull();
});

test('training uses an owned sword or bronze pickaxe, with a shield when one is owned',()=>{
    expect(chickenTrainingKit([{id:1277},{id:1171},{id:1265}])).toEqual([1277,1171]);
    expect(chickenTrainingKit([{id:1265},{id:995}])).toEqual([1265]);
    expect(chickenTrainingKit([{id:1265},{id:1171}])).toEqual([1265,1171]);
    expect(()=>chickenTrainingKit([{id:995},{id:1205}])).toThrow('missing owned training weapon');
});

test('training admits only the two audited bank routes and keeps the original Varrock default',()=>{
    expect(chickenTrainingProfile().route[0]).toMatchObject({x:3253,z:3420});
    expect(chickenTrainingProfile('draynor').route[0]).toMatchObject({x:3092,z:3243});
    expect(chickenTrainingProfile('draynor').route.at(-1)).toEqual(chickenTrainingProfile().route.at(-1));
    expect(()=>chickenTrainingProfile('unknown')).toThrow('unsupported training bank');
});

test('Draynor wizard threshold follows its hunt3 plus one tile; jail guards and other threats remain guarded',()=>{
    const wizard={name:'Dark wizard',distance:5};
    expect(chickenTrainingThreat(wizard,'varrock')).toBe(true);
    expect(chickenTrainingThreat(wizard,'draynor')).toBe(false);
    expect(chickenTrainingThreat({...wizard,distance:4},'draynor')).toBe(true);
    expect(chickenTrainingThreat({name:'Jail guard',distance:7},'draynor')).toBe(true);
    expect(chickenTrainingThreat({name:'Highwayman',distance:7},'draynor')).toBe(true);
});

test('bootstrap chicken demand is finite and invalid demand fails before game actions',async()=>{
 for(const rawChicken of [-1,13,1.5,NaN])await expect(trainChickens({} as any,1800,'draynor',13,{rawChicken})).rejects.toThrow('0..12');
});
