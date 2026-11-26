import {test,expect} from 'bun:test';
import {railingCut,railingRefusal} from './dwarfcannon';

test('a failed railing roll cuts a tenth of the base hitpoints, 1 to 3', () => {
 expect(railingCut(10)).toBe(1);
 expect(railingCut(5)).toBe(1);
 expect(railingCut(29)).toBe(2);
 expect(railingCut(97)).toBe(3);
});
test('the railing loop stops before a cut can kill an account with no meal', () => {
 // Packhorse: 10 hitpoints, one lobster, cut to death in 12 failed rolls.
 expect(railingRefusal(2,10,false)).toBe('low hp 2 of 10, no food');
 expect(railingRefusal(2,10,true)).toBeUndefined();
 expect(railingRefusal(3,10,false)).toBeUndefined();
 expect(railingRefusal(4,97,false)).toBe('low hp 4 of 97, no food');
});
