import {expect,test} from 'bun:test';
import {atNorthBank,cowStageDeposits,cowStagePlan} from './cow-stage';

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

test('cow stage banks the arriving pack: everything but one kit set and the fewest food pieces that heal 14 HP', () => {
    // TrouserSnake's pack: 28 cake pieces and coins from knight farming.
    const pack=[{id:995,count:20750},...Array.from({length:10},()=>({id:1891,count:1})),...Array.from({length:6},()=>({id:1893,count:1})),...Array.from({length:11},()=>({id:1895,count:1}))];
    expect(cowStageDeposits(pack)).toEqual([{id:995,count:20750},{id:1891,count:8},{id:1893,count:6},{id:1895,count:11}]);
    // Kit held twice keeps one; trout held tops up to 14 HP (7 each) and the rest goes.
    expect(cowStageDeposits([{id:1277,count:1},{id:1277,count:1},{id:1171,count:1},{id:333,count:1},{id:333,count:1},{id:333,count:1}]))
        .toEqual([{id:1277,count:1},{id:333,count:1}]);
    expect(cowStageDeposits([{id:1277,count:1},{id:1171,count:1},{id:1891,count:1}])).toEqual([]);
});
