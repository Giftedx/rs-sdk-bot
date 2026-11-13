import { expect, test } from 'bun:test';
import { questRewards } from './gen-quest-rewards';

test('quest rewards: every journal quest folder, by journal name, with the XP times the rate', () => {
    const names = new Map([['quest_doric', "Doric's Quest"], ['quest_gobdip', 'Goblin Diplomacy'], ['quest_cog', 'Clock Tower']]);
    expect(questRewards(['quest_doric', 'quest_gobdip', 'quest_cog', 'quest_barcrawl'], [
        { folder: 'quest_doric', questPoints: 1, xp: [{ skill: 'mining', xp: 1300 }] },
        // A row with no folder takes its folder from its varp.
        { folder: null, varp: 'goblinquest', questPoints: 5, xp: [{ skill: 'crafting', xp: 200 }] },
    ], names, 25, { goblinquest: 'quest_gobdip' }, { quest_cog: 1 })).toEqual({
        "Doric's Quest": [1, [['Mining', 32500]]],
        'Goblin Diplomacy': [5, [['Crafting', 5000]]],
        // A folder with no row takes the fallback quest points; the barcrawl miniquest has no journal name.
        'Clock Tower': [1, []],
    });
});
