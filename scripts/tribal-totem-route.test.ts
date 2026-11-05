import {test,expect} from 'bun:test';
import {totemStartsAtKangai,totemTravel,onKaramja,TOTEM_FARE,surplusForSlots} from './tribal-totem-route';

test('Kangai Mau is skipped once the quest is started; an unread journal still tries him',()=>{
    expect(totemStartsAtKangai('not started')).toBe(true);
    expect(totemStartsAtKangai('unknown')).toBe(true);
    expect(totemStartsAtKangai('started')).toBe(false);
    expect(totemStartsAtKangai('complete')).toBe(false);
});
test('Brimhaven and Musa Point are Karamja; the Ardougne docks, Draynor and Lumbridge are the mainland',()=>{
    expect(onKaramja({x:2791,z:3182})).toBe(true);
    expect(onKaramja({x:2772,z:3225})).toBe(true);
    expect(onKaramja({x:2956,z:3146})).toBe(true);
    expect(onKaramja({x:2683,z:3271})).toBe(false);
    expect(onKaramja({x:3092,z:3242})).toBe(false);
    expect(onKaramja({x:3222,z:3218})).toBe(false);
});
test('from Karamja: teleport only with Plague City, Magic 51 and two of each rune, else the boat with two fares',()=>{
    const base={karamja:true,started:true,plagueCity:'complete' as const,magic:99,law:2,water:2,coins:30};
    expect(totemTravel(base)).toEqual({how:'teleport'});
    expect(totemTravel({...base,magic:51,coins:30})).toEqual({how:'teleport'});
    expect(totemTravel({...base,plagueCity:'not started',coins:60})).toEqual({how:'boat'});
    expect(totemTravel({...base,magic:50,coins:60})).toEqual({how:'boat'});
    // One rune of either type cannot cast the spell (magic_spells.dbrow:103 runesrequired waterrune 2, lawrune 2).
    expect(totemTravel({...base,law:1,coins:60})).toEqual({how:'boat'});
    expect(totemTravel({...base,water:1,coins:60})).toEqual({how:'boat'});
    expect(totemTravel({...base,law:0,coins:2*TOTEM_FARE-1})).toMatchObject({how:'missing'});
    expect(totemTravel({...base,coins:TOTEM_FARE-1})).toMatchObject({how:'missing'});
});
test('from the mainland: a started quest walks to the depot with one fare; a fresh one sails to Kangai first with three',()=>{
    const base={karamja:false,started:true,plagueCity:'not started' as const,magic:99,law:0,water:0,coins:30};
    expect(totemTravel(base)).toEqual({how:'walk'});
    expect(totemTravel({...base,coins:29})).toMatchObject({how:'missing'});
    expect(totemTravel({...base,started:false,coins:90})).toEqual({how:'sail-to-kangai'});
    expect(totemTravel({...base,started:false,coins:89})).toMatchObject({how:'missing'});
});

test('a full pack banks other items first, then food beyond eight, never coins or quest items; a pack with room banks nothing',()=>{
    const keep=new Set([1858,1857]);
    const full=[{id:995,count:30},...Array.from({length:20},()=>({id:385,count:1})),{id:1858,count:1},{id:1351,count:1},{id:590,count:1},...Array.from({length:4},()=>({id:379,count:1}))];
    expect(full.length).toBe(28);
    const plan=surplusForSlots(full,2,keep);
    expect(plan).toEqual([{id:1351,count:1},{id:590,count:1}]);
    const sharks=[{id:995,count:30},...Array.from({length:27},()=>({id:385,count:1}))];
    const p2=surplusForSlots(sharks,2,keep);
    expect(p2).toEqual([{id:385,count:1},{id:385,count:1}]);
    expect(surplusForSlots(sharks.slice(0,26),2,keep)).toEqual([]);
    // Food is kept down to eight: a pack of coins and 27 food frees at most 19 slots.
    expect(surplusForSlots(sharks,25,keep).length).toBe(19);
});
