import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUEST_NAMES, questsLeft, questShortfall, runQuestChain } from '../src/quest/chain';
import { questJournalNames, questScript } from '../../core/src/quest-status';

test('every quest script has its journal name, so a finished quest is skipped', () => {
    const root = resolve(import.meta.dir, '../../..'), journal = questJournalNames(root);
    const folders = new Map(readdirSync(resolve(root, 'vendor/rs-sdk/server/content/scripts/quests')).filter(f => f.startsWith('quest_')).map(f => [questScript(f), f]));
    const scripts = readdirSync(resolve(root, 'scripts/generated')).filter(f => /^quest-.+\.ts$/.test(f) && f !== 'quest-lib.ts' && !f.endsWith('.test.ts'));
    // Alcohol Barcrawl is a miniquest with no journal row.
    const rows = scripts.filter(f => f !== 'quest-barcrawl.ts').map(f => [QUEST_NAMES[f.slice(6, -3)], journal.get(folders.get(f)!)]);
    expect(rows.length).toBeGreaterThan(60);
    for (const [table, game] of rows) expect(table).toBe(game!);
});

test('a quest the status shows complete is skipped; unknown names pass through', () => {
    const status = [{ name: "Cook's Assistant", state: 'complete' }, { name: 'Sheep Shearer', state: 'started' }];
    expect(questsLeft(['cook', 'sheep', 'rj'], status)).toEqual(['sheep', 'rj']);
    expect(questsLeft(['cook'], undefined)).toEqual(['cook']);
});

test('only a real death stops the chain', () => {
    const { questDied } = require('../src/quest/chain');
    expect(questDied('RESULT ok qp=1 xp=attack=2600 died=false milestones=')).toBe(false);
    expect(questDied('RESULT fail talk halgrive 1 died=false')).toBe(false);
    expect(questDied('RESULT fail died')).toBe(true);
    expect(questDied('RESULT fail step x died=true')).toBe(true);
});

test('a quest whose skill check the account fails is named with the shortfall', () => {
    expect(questShortfall('seaslug', [{ name: 'Firemaking', level: 12 }])).toEqual(['firemaking 12/30']);
    expect(questShortfall('seaslug', [{ name: 'Firemaking', level: 30 }])).toEqual([]);
    expect(questShortfall('fishingcompo', undefined)).toEqual([]);   // the sweep trains Fishing to 10
    // Lost City after Monk's Friend (Woodcutting 56) and Murder Mystery (Crafting 51) has both levels.
    expect(questShortfall('zanaris', [{ name: 'Woodcutting', level: 1 }, { name: 'Crafting', level: 51 }])).toEqual(['woodcutting 1/36']);
    expect(questShortfall('zanaris', [{ name: 'Woodcutting', level: 56 }, { name: 'Crafting', level: 51 }])).toEqual([]);
    // TheFullMonty: Thieving 99 and Crafting 52, every other skill 1.
    const monty = [{ name: 'Thieving', level: 99 }, { name: 'Crafting', level: 52 }, { name: 'Magic', level: 99 }];
    expect(questShortfall('dig', monty)).toEqual(['herblore 1/10', 'agility 1/10']);
    expect(questShortfall('elemental', monty)).toEqual(['mining 1/20', 'smithing 1/20']);
    expect(questShortfall('elemental', [{ name: 'Mining', level: 20 }, { name: 'Smithing', level: 20 }, { name: 'Crafting', level: 20 }])).toEqual([]);
    expect(questShortfall('sheep', [])).toEqual([]);
    expect(questShortfall('upass', [{ name: 'Thieving', level: 49 }])).toEqual(['thieving 49/50']);
    expect(questShortfall('regicide', [{ name: 'Agility', level: 69 }, { name: 'Crafting', level: 1 }, { name: 'Magic', level: 53 }])).toEqual(['crafting 1/10']);
    expect(questShortfall('regicide', [{ name: 'Agility', level: 56 }, { name: 'Crafting', level: 51 }, { name: 'Magic', level: 51 }])).toEqual([]);
    expect(questShortfall('ikov', [{ name: 'Ranged', level: 40 }, { name: 'Thieving', level: 42 }, { name: 'Prayer', level: 17 }])).toEqual(['prayer 17/37']);
    expect(questShortfall('desertrescue', [{ name: 'Fletching', level: 9 }, { name: 'Smithing', level: 20 }])).toEqual(['fletching 9/10']);
    expect(questShortfall('horror', [{ name: 'Agility', level: 34 }, { name: 'Prayer', level: 40 }])).toEqual(['agility 34/35']);
    expect(questShortfall('zombiequeen', [{ name: 'Crafting', level: 19 }, { name: 'Agility', level: 31 }])).toEqual(['crafting 19/20', 'agility 31/32']);
    expect(questShortfall('itwatchtower', [{ name: 'Magic', level: 14 }, { name: 'Thieving', level: 15 }, { name: 'Agility', level: 25 }, { name: 'Herblore', level: 14 }, { name: 'Mining', level: 39 }])).toEqual(['mining 39/40']);
    expect(questShortfall('hero', [{ name: 'Cooking', level: 53 }, { name: 'Fishing', level: 52 }, { name: 'Herblore', level: 25 }, { name: 'Mining', level: 50 }])).toEqual(['fishing 52/53']);
    expect(questShortfall('hero', [{ name: 'Cooking', level: 53 }, { name: 'Fishing', level: 53 }, { name: 'Herblore', level: 25 }, { name: 'Mining', level: 50 }])).toEqual([]);
    expect(questShortfall('magearena', [{ name: 'Magic', level: 59 }, { name: 'Prayer', level: 36 }])).toEqual(['magic 59/60', 'prayer 36/37']);
    expect(questShortfall('magearena', [{ name: 'Magic', level: 60 }, { name: 'Prayer', level: 37 }])).toEqual([]);
});

test('a stop before the first quest prevents the worker from opening', async () => {
    const result = await runQuestChain(['cook'], {
        stopped: () => true, status: () => ({}), log: () => {},
        run: async () => { throw Error('the stopped quest should never start'); },
    });
    expect(result).toBe('RESULT fail stop file quest-chain done=- failed=-');
});

test('terminal child results preserve their reason and prevent the next quest', async () => {
    for (const [result, prefix] of [
        ['RESULT fail stop file', 'RESULT fail stop file'],
        ['RESULT fail quest-sweep rj Error: worker finished: stop file', 'RESULT fail stop file'],
        ['RESULT fail died', 'RESULT fail died'],
        ['RESULT fail session ended: disconnected', 'RESULT fail session ended: disconnected'],
    ] as const) {
        const attempts: string[] = [];
        const out = await runQuestChain(['cook', 'rj', 'sheep'], {
            stopped: () => false, status: () => ({}), log: () => {},
            run: async quest => { attempts.push(quest); return quest === 'cook' ? 'RESULT ok qp=1' : result; },
        });
        expect(attempts).toEqual(['cook', 'rj']);
        expect(out).toStartWith(prefix);
        expect(out).toEndWith('done=cook failed=rj');
    }
});

test('quest-specific failure still allows an independent quest to finish', async () => {
    const out = await runQuestChain(['cook', 'rj'], {
        stopped: () => false, status: () => ({}), log: () => {},
        run: async quest => quest === 'cook' ? 'RESULT fail missing item' : 'RESULT ok qp=1',
    });
    expect(out).toBe('RESULT ok quest-chain done=rj failed=cook');
});
