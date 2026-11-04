import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { QUEST_NAMES, questsLeft, questShortfall } from './quest-chain';
import { questJournalNames, questScript } from '../packages/router/src/coverage';

test('every quest script has its journal name, so a finished quest is skipped', () => {
    const root = resolve(import.meta.dir, '..'), journal = questJournalNames(root);
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
    const { questDied } = require('./quest-chain');
    expect(questDied('RESULT ok qp=1 xp=attack=2600 died=false milestones=')).toBe(false);
    expect(questDied('RESULT fail talk halgrive 1 died=false')).toBe(false);
    expect(questDied('RESULT fail died')).toBe(true);
    expect(questDied('RESULT fail step x died=true')).toBe(true);
});

test('a quest whose skill check the account fails is named with the shortfall', () => {
    expect(questShortfall('seaslug', [{ name: 'Firemaking', level: 12 }])).toEqual(['firemaking 12/30']);
    expect(questShortfall('seaslug', [{ name: 'Firemaking', level: 30 }])).toEqual([]);
    expect(questShortfall('fishingcompo', undefined)).toEqual(['fishing 1/10']);
    expect(questShortfall('sheep', [])).toEqual([]);
});
