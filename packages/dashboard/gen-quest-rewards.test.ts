import { expect, test } from 'bun:test';
import { completionXp, insideSwitch, questRewards } from './gen-quest-rewards';

test('completion XP: stat_advance in a block named complete, base XP; not elsewhere, and not a choice of more than 3', () => {
    expect(completionXp([
        '[label,obstacle]\nstat_advance(agility, 100);\n[queue,arena_quest_complete]\nstat_advance(attack, 121750);\nstat_advance(thieving, 21750);',
        '[label,choose_complete]\nstat_advance(a, 10);\nstat_advance(b, 10);\nstat_advance(c, 10);\nstat_advance(d, 10);',
    ])).toEqual([{ skill: 'attack', xp: 12175 }, { skill: 'thieving', xp: 2175 }]);
});

test('quest rewards: every journal quest folder, by journal name, with the XP times the rate', () => {
    const names = new Map([['quest_doric', "Doric's Quest"], ['quest_gobdip', 'Goblin Diplomacy'], ['quest_cog', 'Clock Tower']]);
    expect(questRewards(['quest_doric', 'quest_gobdip', 'quest_cog', 'quest_barcrawl'], [
        { folder: 'quest_doric', questPoints: 1, xp: [{ skill: 'mining', xp: 1300 }] },
        // A row with no folder takes its folder from its varp.
        { folder: null, varp: 'goblinquest', questPoints: 5, xp: [{ skill: 'crafting', xp: 200 }] },
    ], names, 25, { goblinquest: 'quest_gobdip' }, { quest_cog: 1 })).toEqual({
        "Doric's Quest": [1, [['Mining', 32500]], []],
        'Goblin Diplomacy': [5, [['Crafting', 5000]], []],
        // A folder with no row takes the fallback quest points; the barcrawl miniquest has no journal name.
        'Clock Tower': [1, [], []],
    });
});

test('quest rewards: a row with no XP takes the completion XP of its scripts', () => {
    expect(questRewards(['quest_arena'], [{ folder: 'quest_arena', questPoints: 2, xp: [] }], new Map([['quest_arena', 'Fight Arena']]), 25, {}, {},
        () => ['[queue,arena_quest_complete]\nstat_advance(attack, 121750);'])).toEqual({ 'Fight Arena': [2, [['Attack', 304375]], []] });
});

test('inside a switch: XP under a case is one of several outcomes; XP after the switch closes is not', () => {
    const script = ['[label,constellation_reward](int $n)', 'switch_int($n) {', '    case ^sign_capricorn :', '        stat_advance(strength, 8750);', '    case ^sign_virgo :', '        stat_advance(defence, 8750);', '}', 'stat_advance(crafting, 22500);'];
    expect([insideSwitch(script, 3), insideSwitch(script, 5), insideSwitch(script, 7)]).toEqual([true, true, false]);
    // A random reward: the always-given XP and the alternatives apart.
    expect(questRewards(['quest_itgronigen'], [{ folder: 'quest_itgronigen', questPoints: 2, xp: [{ skill: 'strength', xp: 875, src: 'a:4' }, { skill: 'crafting', xp: 2250, src: 'a:8' }] }],
        new Map([['quest_itgronigen', 'Observatory Quest']]), 25, {}, {}, () => [], src => src === 'a:4')).toEqual({ 'Observatory Quest': [2, [['Crafting', 56250]], [['Strength', 21875]]] });
});
