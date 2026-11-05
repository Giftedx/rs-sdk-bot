import {test,expect} from 'bun:test';
import {totemStartsAtKangai,totemTravel,ROUND_TRIP_FARE} from './tribal-totem-route';

test('Kangai Mau is skipped once the quest is started; an unread journal still tries him',()=>{
    expect(totemStartsAtKangai('not started')).toBe(true);
    expect(totemStartsAtKangai('unknown')).toBe(true);
    expect(totemStartsAtKangai('started')).toBe(false);
    expect(totemStartsAtKangai('complete')).toBe(false);
});
test('Ardougne by teleport only with Plague City, Magic 51 and the runes; else the boats, which need both fares',()=>{
    expect(totemTravel({plagueCity:'complete',magic:99,law:2,water:2,coins:30})).toEqual({how:'teleport'});
    expect(totemTravel({plagueCity:'not started',magic:99,law:2,water:2,coins:60})).toEqual({how:'boat'});
    expect(totemTravel({plagueCity:'complete',magic:29,law:2,water:2,coins:60})).toEqual({how:'boat'});
    expect(totemTravel({plagueCity:'complete',magic:99,law:0,water:2,coins:60})).toEqual({how:'boat'});
    expect(totemTravel({plagueCity:'not started',magic:29,law:0,water:0,coins:ROUND_TRIP_FARE-1})).toMatchObject({how:'missing'});
});
