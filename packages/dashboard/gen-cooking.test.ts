import { expect, test } from 'bun:test';
import { cookChance, parseCooking } from './gen-cooking';

const DBROW = `[cooking_generic_shark]
table=cooking_generic
data=uncooked,raw_shark
data=cooked,shark
data=burnt,burnt_shark
data=levelrequired,80
data=successchance,1,202
data=successchance_range,1,232
data=successchance_gauntlets,15,270

[cooking_generic_burnmeat]
table=cooking_generic
data=uncooked,cooked_meat
data=cooked,burnt_meat
data=successchance,1,1

[cooking_generic_seaweed]
table=cooking_generic
data=uncooked,seaweed
data=cooked,soda_ash
data=successchance,1,1
`;

test('the cooking table keeps each raw food that can burn, by name, with its fire, range and gauntlet rolls', () => {
    const names = new Map([['raw_shark', 'Raw shark'], ['shark', 'Shark'], ['cooked_meat', 'Cooked meat'], ['burnt_meat', 'Burnt meat'], ['seaweed', 'Seaweed'], ['soda_ash', 'Soda ash']]);
    expect(parseCooking(DBROW, names)).toEqual({ 'Raw shark': { c: 'Shark', lv: 80, f: [1, 202], r: [1, 232], g: [15, 270] } });
});

test('the cook chance is the engine roll: floor(low*(99-L)/98) + floor(high*(L-1)/98) + 1 of 256', () => {
    expect(cookChance([1, 202], 85)).toBe(174 / 256);
    expect(cookChance([38, 332], 74)).toBe(1);
    expect(cookChance([38, 332], 73)).toBe(254 / 256);
    expect(cookChance([0, 0], 99)).toBe(0);
    expect(cookChance([1, 1], 1)).toBe(1);
});
