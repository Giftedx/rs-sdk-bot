import {expect,test} from 'bun:test';
import {chooseProgression,type ObservedAccount} from '../src/progression';
import {rangedProgressionMethods,rangedKit,rangedModelRate} from '../src/progression-ranged';
import {xpForLevel} from '../src/curve';

const now=2_000_000;
const account=(bank:Record<number,number>={841:1,882:500,2142:43,995:382923}):ObservedAccount=>({
 account:'ordinary',at:now,skills:{Attack:{level:99,xp:999500},Strength:{level:99,xp:998800},Defence:{level:99,xp:1000200},
  Hitpoints:{level:99,xp:1080130},Ranged:{level:80,xp:279100},Prayer:{level:73,xp:164250},Magic:{level:99,xp:999187}},
 inventory:{at:now,value:{}},equipment:{at:now,value:{284:1,285:1}},bank:{at:now,value:bank},
 quests:{at:now,value:{'Dwarf Cannon':false}},position:{at:now,value:{x:3253,z:3421,level:0}},
});

test('Ranged policy compares the full remaining target and uses the existing trooper adapter',()=>{
 const a=account(),methods=rangedProgressionMethods(a,85);
 const d=chooseProgression({kind:'train',skill:'Ranged',targetLevel:85},a,methods,{now});
 expect(d.selected).toBe('ranged/troopers');
 expect(d.state).toBe('execute');
 expect(d.alternatives.some(m=>m.method==='ranged/chickens')).toBe(true);
 expect(methods.find(m=>m.id===d.selected)?.step.script).toBe('scripts/ranged-train.ts');
});

test('known unreserved better bows and compatible arrows change the chosen kit',()=>{
 const a=account({841:1,882:500,861:1,892:500,2142:43,995:382923});
 expect(rangedKit(a)).toMatchObject({bow:861,arrow:892});
 a.reservations={861:1,892:500};
 expect(rangedKit(a)).toMatchObject({bow:841,arrow:882});
});
test('equal modeled Ranged throughput prefers actual arrow strength without overriding bow speed',()=>{
 const a=account({841:1,882:25,884:82,2142:43,995:382923});a.skills.Ranged={level:70,xp:xpForLevel(70)};
 const bronze=rangedKit({...a,bank:{at:now,value:{841:1,882:25}}})!,iron=rangedKit({...a,bank:{at:now,value:{841:1,884:82}}})!;
 expect(iron.strength).toBeGreaterThan(bronze.strength);
 expect(rangedModelRate(70,bronze,22,12)).toBe(rangedModelRate(70,iron,22,12));
 expect(rangedKit(a)).toMatchObject({bow:841,arrow:884});
 expect(rangedKit({...a,bank:{at:now,value:{861:1,859:1,892:82}}})).toMatchObject({bow:861,arrow:892});
});

test('status catalog and live SDK skill-name casing select the same eligible Ranged kit',()=>{
 const a=account();a.skills=Object.fromEntries(Object.entries(a.skills).map(([name,state])=>[name.toLowerCase(),state]));
 expect(rangedKit(a)).toMatchObject({bow:841,arrow:882});
 expect(chooseProgression({kind:'train',skill:'Ranged',targetLevel:85},a,rangedProgressionMethods(a,85),{now}).selected).toBe('ranged/troopers');
});

test('the policy retains acquisition alternatives rather than making missing upgrades a route ban',()=>{
 const methods=rangedProgressionMethods(account(),99);
 const upgrade=methods.find(m=>m.id==='ranged/guild-willow-mithril');
 expect(upgrade?.requirements?.items).toMatchObject({849:1,888:500});
 expect(methods.find(m=>m.id==='ranged/guild-buy-mithril')?.effects.items).toEqual({888:500});
 expect(upgrade?.rate.basis).toBe('model');
 expect(methods.find(m=>m.id==='ranged/cannon')?.rate.basis).toBe('unknown');
});
test('the unknown cannon rival names its real finite worker rather than an unsupported adaptive branch',()=>{
 const cannon=rangedProgressionMethods(account(),85).find(m=>m.id==='ranged/cannon')!;
 expect(cannon.step.script).toBe('scripts/cannon-fight.ts');expect(cannon.step.env.STOP_SKILL).toBe('Ranged');expect(cannon.step.env.STOP_LEVEL).toBe('85');
 expect(cannon.rate.basis).toBe('unknown');
});

test('a guild top-up credits only new arrows after current unreserved holdings',()=>{
 const methods=rangedProgressionMethods(account({841:1,882:500,888:100,849:1,2142:43,995:382923}),99);
 expect(methods.find(m=>m.id==='ranged/guild-buy-willow')).toBeUndefined();
 expect(methods.find(m=>m.id==='ranged/guild-buy-mithril')?.effects.items).toEqual({888:400});
 expect(methods.find(m=>m.id==='ranged/guild-buy-mithril')?.step.env.MAX_ITEMS).toBe('400');
 const a=account({841:1,882:500,888:500,2142:43,995:382923});a.reservations={888:400};
 const reserved=rangedProgressionMethods(a,99).find(m=>m.id==='ranged/guild-buy-mithril')!;
 expect(reserved.effects.items).toEqual({888:400});expect(reserved.step.env.STOCK_TARGET).toBe('900');
});

test('a finite guild acquisition uses its requested quantity instead of a default army stockpile',()=>{
 const methods=rangedProgressionMethods(account(),99,{888:20}),buy=methods.find(m=>m.id==='ranged/guild-buy-mithril')!;
 expect(buy.effects.items).toEqual({888:20});expect(buy.step.env.STOCK_TARGET).toBe('20');expect(buy.step.env.MAX_ITEMS).toBe('20');
 expect(buy.step.env.MAX_SPEND).toBe('3840');expect(methods.find(m=>m.id==='ranged/guild-buy-willow')).toBeUndefined();
});

test('an incomplete or stale stock observation cannot select a borrowed or absent kit',()=>{
 const a=account();a.bank=null;
 expect(rangedKit(a)).toBeNull();
 const d=chooseProgression({kind:'train',skill:'Ranged',targetLevel:85},a,rangedProgressionMethods(a,85),{now});
 expect(d.state).not.toBe('execute');
});

import {rangedBandTarget} from '../src/progression-ranged';

test('rangedProgressionMethods provides rev-289 Lowe 1-19 and GE 20-39 acquisition so level-1 accounts prepare starter gear',()=>{
    const now=Date.now();
    const obs=(value:any)=>({at:now,value,source:'test'});
    const starter:ObservedAccount={
        account:'starter',at:now,
        skills:{Ranged:{level:1,xp:0},Hitpoints:{level:10,xp:xpForLevel(10)},Defence:{level:1,xp:0}},
        inventory:obs({995:20_000}),equipment:obs({}),bank:obs({}),quests:obs({}),position:obs({x:3253,z:3421,level:0}),
    };
    const d1=chooseProgression({kind:'train',skill:'Ranged',targetLevel:40},starter,rangedProgressionMethods(starter,40),{now});
    expect(d1.state).toBe('execute');
    expect(d1.path[0]?.method).toBe('ranged/lowe-buy-bronze');
    expect(d1.path.some(p=>p.method==='ranged/lowe-buy-shortbow')).toBe(true);
    expect(d1.path.some(p=>p.method==='ranged/chickens')).toBe(true);

    const methods=rangedProgressionMethods({...starter,skills:{...starter.skills,Ranged:{level:25,xp:xpForLevel(25)}}},40);
    expect(methods.find(m=>m.id==='ranged/lowe-buy-oak')?.effects.items).toEqual({843:1});
    expect(methods.find(m=>m.id==='ranged/lowe-buy-steel')?.effects.items).toEqual({886:250});
    expect(methods.find(m=>m.id==='ranged/ge-buy-willow')?.requirements?.levels?.Ranged).toBe(20);
    expect(methods.find(m=>m.id==='ranged/ge-buy-mithril')?.requirements?.levels?.Ranged).toBe(20);
    expect(methods.find(m=>m.id==='ranged/ge-buy-maple')?.requirements?.levels?.Ranged).toBe(30);
    expect(methods.find(m=>m.id==='ranged/guild-willow-mithril')?.requirements?.levels?.Ranged).toBe(40);
});

test('rangedBandTarget splits at acquirable bow and arrow tier unlocks before 40',()=>{
    const now=Date.now();
    const obs=(value:any)=>({at:now,value,source:'test'});
    const mk=(level:number,items:Record<number,number>):ObservedAccount=>({
        account:'tier',at:now,
        skills:{Ranged:{level,xp:xpForLevel(level)},Hitpoints:{level:20,xp:xpForLevel(20)},Defence:{level:10,xp:xpForLevel(10)}},
        inventory:obs({995:50_000}),equipment:obs({}),bank:obs(items),quests:obs({}),
    });
    expect(rangedBandTarget(mk(1,{841:1,882:100}),40)).toBe(5);
    expect(rangedBandTarget(mk(5,{843:1,886:200}),40)).toBe(20);
    expect(rangedBandTarget(mk(20,{849:1,888:200}),40)).toBe(30);
    expect(rangedBandTarget(mk(30,{853:1,888:200}),40)).toBe(40);
});
