import { expect, test } from 'bun:test';
import { slowWalks } from './route-prewarm';

test('slow walks are the planned and unplanned walks over the bound, one row for each start and goal, slowest first', () => {
    const log = [
        'START shop-buyer Abracadickra profile=archeryshop2 coins=3',
        'WALK_NO_ROUTE {"from":{"x":3221,"z":3220,"level":0},"to":{"x":2809,"z":3441,"level":0},"ms":45866,"budgetMs":45000,"bank":true,"coins":3}',
        'WALK_NO_ROUTE {"from":{"x":3221,"z":3220,"level":0},"to":{"x":2809,"z":3441,"level":0},"ms":45463,"budgetMs":45000,"bank":true,"coins":3}',
        '  | WALK_PLAN_SLOW {"from":{"x":3185,"z":3436,"level":0},"to":{"x":2655,"z":3283,"level":0},"ms":12000,"budgetMs":45000,"cost":700,"bank":false}',
        'WALK_NO_ROUTE {"from":{"x":3222,"z":3218,"level":0},"to":{"x":3225,"z":3218,"level":0},"ms":51,"budgetMs":45000,"bank":true,"coins":3}',
        'WALK_NO_ROUTE {"from":{"x":1,"z":2},"to":{"x":3,"z":4,"level":0},"ms":60000}',
        'WALK_NO_ROUTE not json',
    ].join('\n');
    expect(slowWalks(log, 'Abracadickra', 5000)).toEqual([
        { bot: 'Abracadickra', from: { x: 3221, z: 3220, level: 0 }, to: { x: 2809, z: 3441, level: 0 }, ms: 45866 },
        { bot: 'Abracadickra', from: { x: 3185, z: 3436, level: 0 }, to: { x: 2655, z: 3283, level: 0 }, ms: 12000 },
    ]);
});
