import { expect, test } from 'bun:test';
import { questsLeft } from './quest-chain';

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
