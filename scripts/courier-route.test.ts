import { expect, test } from 'bun:test';
import { LUMBRIDGE_TO_DRAYNOR, draynorApproach, onKaramja, outboundStart } from './courier-route';

test('a home trip that ended between the boats resumes on Karamja only', () => {
    expect(onKaramja({ worldX: 2829, worldZ: 3190, level: 0 })).toBe(true); // Pocketpython, disconnected
    expect(onKaramja({ worldX: 2956, worldZ: 3146, level: 0 })).toBe(true); // Musa Point
    expect(onKaramja({ worldX: 2774, worldZ: 3228, level: 0 })).toBe(true); // Brimhaven dock
    expect(onKaramja({ worldX: 2956, worldZ: 3143, level: 1 })).toBe(false); // on the deck
    expect(onKaramja({ worldX: 3222, worldZ: 3218, level: 0 })).toBe(false);
    expect(onKaramja({ worldX: 2654, worldZ: 3283, level: 0 })).toBe(false);
    expect(onKaramja(undefined)).toBe(false);
});
import { isNoProgressFailure } from '../packages/practice/src/supervise';

test('every courier refusal blocks in the supervisor instead of logging in again', () => {
    for (const why of ['no courier progress: start is not an Ardougne bank or east of White Wolf Mountain',
        'no courier progress: needs 120 coins for the boat fares; refusing the White Wolf Mountain land route',
        'no courier progress: needs 60 coins for the boats home; refusing the White Wolf Mountain land route'])
        expect(isNoProgressFailure(`RESULT fail ${why} at=1,2,0 ticks=3`)).toBe(true);
});

const at = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });

test('from either Ardougne bank the courier sails, whatever its pack coins', () => {
    expect(outboundStart(at(2654, 3283))).toBe('boat-south');
    expect(outboundStart(at(2650, 3290))).toBe('boat-south');
    // this start took the land route over White Wolf Mountain and the courier died.
    expect(outboundStart(at(2619, 3332))).toBe('boat-north');
});

test('the land route to Port Sarim is only for starts east of White Wolf Mountain', () => {
    expect(outboundStart(at(3185, 3436))).toBe('land'); // Varrock West bank, survived live
    expect(outboundStart(at(3222, 3218))).toBe('land'); // Lumbridge respawn
    expect(outboundStart(at(3092, 3243))).toBe('land'); // Draynor bank
});

test('a Lumbridge respawn reaches Draynor north of the jail guards; Draynor itself walks straight in', () => {
    expect(draynorApproach(at(3222, 3218))).toBe(LUMBRIDGE_TO_DRAYNOR);
    expect(LUMBRIDGE_TO_DRAYNOR.every(([x, z]) => !(Math.abs(x - 3124) <= 10 && Math.abs(z - 3248) <= 10))).toBe(true);
    expect(draynorApproach(at(3093, 3244))).toEqual([[3092, 3243, 2]]);
    expect(draynorApproach(undefined)).toEqual([[3092, 3243, 2]]);
});

test('anywhere else is refused instead of walked', () => {
    expect(outboundStart(at(2700, 3400))).toBe('refuse'); // Ardougne outskirts, not a bank
    expect(outboundStart(at(2850, 3480))).toBe('refuse'); // on the mountain itself
    expect(outboundStart(at(2900, 3200))).toBe('refuse'); // west of x 2950
    expect(outboundStart(at(2654, 3283, 1))).toBe('refuse'); // upstairs
    expect(outboundStart(undefined)).toBe('refuse');
});
