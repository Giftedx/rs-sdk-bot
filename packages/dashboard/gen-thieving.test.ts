import { expect, test } from 'bun:test';
import { parsePickpocket, pickChance } from './gen-thieving';

test('the pickpocket table: level, XP times the rate, the roll and the stun, by each display name of the row', () => {
    const dbrow = '[pickpocket_man]\ntable=pickpocket\ndata=npc,man\ndata=npc,man2\ndata=level,1\ndata=experience,80\ndata=stun_ticks,8\ndata=stun_damage,1\ndata=success_chance,180,240\n\n[pickpocket_hero]\ntable=pickpocket\ndata=npc,hero\ndata=level,80\ndata=experience,2733\ndata=stun_ticks,10\ndata=stun_damage,4\ndata=success_chance,6,100\n';
    expect(parsePickpocket(dbrow, new Map([['man', 'Man'], ['man2', 'Man'], ['hero', 'Hero']]), 25)).toEqual({ Man: [1, 200, 180, 240, 8, 1], Hero: [80, 6832.5, 6, 100, 10, 4] });
});

test('the pickpocket chance is the engine roll of 256', () => {
    // Man at Thieving 1: floor(180*98/98) + 0 + 1 = 181 of 256.
    expect(pickChance(180, 240, 1)).toBe(181 / 256);
    // Hero at 80: floor(6*19/98) + floor(100*79/98) + 1 = 1 + 80 + 1 = 82 of 256.
    expect(pickChance(6, 100, 80)).toBe(82 / 256);
    expect(pickChance(180, 240, 99)).toBe(241 / 256);
});
