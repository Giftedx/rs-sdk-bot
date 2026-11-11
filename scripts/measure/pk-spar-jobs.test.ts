import { expect, test } from 'bun:test';
import { firstKitTally, parseJob } from './pk-spar-jobs';

test('parseJob reads the case, the profiles, the swap, the seed and the options of each side', () => {
    expect(parseJob('extra:spar-x16|champion|base|1|3')).toEqual({ key: 'extra:spar-x16', a: 'champion', b: 'base', swap: true, seed: '3' });
    expect(parseJob('c|a|b|0|1|{"eatAt":40}|{"specBelow":0.5}')).toEqual({ key: 'c', a: 'a', b: 'b', swap: false, seed: '1', optsA: '{"eatAt":40}', optsB: '{"specBelow":0.5}' });
    expect(parseJob('c|a|b|0|1||{"x":1}')).toEqual({ key: 'c', a: 'a', b: 'b', swap: false, seed: '1', optsB: '{"x":1}' });
    expect(() => parseJob('c|a')).toThrow();
});

test('firstKitTally counts the first kit of a duel case, which is on side B in pairs 2, 3, 6, 7', () => {
    // Pairs 0 and 1: side A is the first kit. Pairs 2 and 3: side B is.
    expect(firstKitTally([299, -299, 299, -299])).toEqual({ kills: 2, deaths: 2 });
    expect(firstKitTally([299, 299, -299, -299])).toEqual({ kills: 4, deaths: 0 });
    expect(firstKitTally([50, -100, 0, 250])).toEqual({ kills: 0, deaths: 1 });
});
