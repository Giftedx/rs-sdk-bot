import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slowWalks, statusAccount } from './route-prewarm';

test('the account of a status row keeps its levels, pack, quest stages, varps and unlocks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-prewarm-'));
    try {
        writeFileSync(join(dir, 'Fixture.json'), JSON.stringify({
            skills: [{ name: 'Attack', level: 70, currentLevel: 68, xp: 1 }, { name: 'Hitpoints', level: 54, currentLevel: 54, xp: 1 }],
            inventory: [{ id: 995, name: 'Coins', count: 3 }],
            guildFacts: { questStages: { legendsquest: 2 }, varps: { 101: 5 }, unlocks: ['fairy_rings'] },
        }));
        const acct = await statusAccount('Fixture', [join(dir, 'missing'), dir]);
        expect(acct).toMatchObject({ skills: { attack: 68, hitpoints: 54 }, coins: 3, questStages: { legendsquest: 2 }, varps: { 101: 5 }, unlocks: ['fairy_rings'] });
        expect(await statusAccount('Nobody', [dir])).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
