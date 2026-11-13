import { expect, test } from 'bun:test';
import { questRewards } from './gen-quest-rewards';

test('quest rewards: by journal name, quest points and the XP times the rate; a quest with no journal name is left out', () => {
    const names = new Map([['quest_doric', "Doric's Quest"], ['quest_runemysteries', 'Rune Mysteries Quest']]);
    expect(questRewards([
        { folder: 'quest_doric', questPoints: 1, xp: [{ skill: 'mining', xp: 1300 }] },
        { folder: 'quest_runemysteries', questPoints: 1, xp: [] },
        { folder: 'quest_barcrawl', questPoints: 0, xp: [] },
    ], names, 25)).toEqual({ "Doric's Quest": [1, [['Mining', 32500]]], 'Rune Mysteries Quest': [1, []] });
});
