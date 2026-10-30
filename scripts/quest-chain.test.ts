import { expect, test } from 'bun:test';
import { questsLeft } from './quest-chain';

test('a quest the status shows complete is skipped; unknown names pass through', () => {
    const status = [{ name: "Cook's Assistant", state: 'complete' }, { name: 'Sheep Shearer', state: 'started' }];
    expect(questsLeft(['cook', 'sheep', 'rj'], status)).toEqual(['sheep', 'rj']);
    expect(questsLeft(['cook'], undefined)).toEqual(['cook']);
});
