import {expect,test} from 'bun:test';
import {atNorthBank,cowStagePlan} from './cow-stage';

test('cow stage takes missing kit and tops held food up to 14 HP from the bank', () => {
    expect(cowStagePlan([{id:1895,count:1}],[{id:1277,count:1},{id:1171,count:1},{id:333,count:5}]))
        .toEqual({take:[{id:1277,count:1},{id:1171,count:1},{id:333,count:2}]});
    expect(cowStagePlan([{id:1277,count:1},{id:1171,count:1}],[{id:1893,count:1},{id:1895,count:3}]))
        .toEqual({take:[{id:1893,count:1},{id:1895,count:2}]});
});

test('cow stage needs nothing when kit and food are held, and names the missing part', () => {
    expect(cowStagePlan([{id:1277,count:1},{id:1171,count:1},{id:1891,count:2}],[])).toEqual({take:[]});
    expect(cowStagePlan([],[{id:1171,count:1},{id:333,count:2}])).toEqual({missing:'kit1277'});
    expect(cowStagePlan([{id:1277,count:1},{id:1171,count:1}],[{id:333,count:1}])).toEqual({missing:'food 7 HP'});
});

test('north bank means ground floor within 3 tiles of 2619,3332', () => {
    expect(atNorthBank({worldX:2621,worldZ:3330,level:0})).toBe(true);
    expect(atNorthBank({worldX:2619,worldZ:3332,level:1})).toBe(false);
    expect(atNorthBank({worldX:2662,worldZ:3305,level:0})).toBe(false);
});
