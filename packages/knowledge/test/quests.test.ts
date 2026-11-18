import { test, expect } from 'bun:test';
import { buildQuests, parseConstants } from '../src/quests';

const CONST = '^cook_complete = 2\n^dragon_complete = 10\n^cook_questpoints = 1\n^dragon_questpoints = 2\n';
const PROC = `[proc,count_questpoints]()(int)
def_int $questpoints = 0;
if (%cookquest = ^cook_complete) {
    $questpoints = add($questpoints, ^cook_questpoints);
}
if (%dragonquest = ^dragon_complete) {
    $questpoints = add($questpoints, ^dragon_questpoints);
}
if (testbit(%weird_bits, ^weird_complete) = true) {
    $questpoints = add($questpoints, ^weird_questpoints);
}
`;

test('parseConstants reads ^name = value lines with their source line', () => {
    const c = parseConstants(CONST, 'scripts/general/configs/quest.constant');
    expect(c.get('cook_complete')).toEqual({ value: 2, src: 'scripts/general/configs/quest.constant:1' });
});

test('quests join the questpoint proc, the constants and the XP rewards in each quest folder', () => {
    const q = buildQuests({
        constants: parseConstants(CONST, 'c.constant'),
        proc: { text: PROC, file: 'q.rs2' },
        varpFolders: new Map([['cookquest', 'quest_cook'], ['dragonquest', 'quest_dragon']]),
        folderScripts: new Map([
            ['quest_cook', [{ text: '[queue,cook_done]\n%cookquest = ^cook_complete;\nstat_advance(cooking, 3000);\n', file: 'quests/quest_cook/scripts/quest_cook.rs2' }]],
            ['quest_dragon', [{ text: '[queue,dragon_done]\n%dragonquest = ^dragon_complete;\nstat_advance(strength, 186500);\nstat_advance(defence, 186500);\n', file: 'quests/quest_dragon/scripts/quest_dragon.rs2' }]],
        ]),
    });
    expect(q.quests.find(x => x.varp === 'cookquest')).toMatchObject({ folder: 'quest_cook', complete: 2, questPoints: 1, xp: [{ skill: 'cooking', xp: 300, src: 'quests/quest_cook/scripts/quest_cook.rs2:3' }] });
    expect(q.quests.find(x => x.varp === 'dragonquest')!.xp.map(r => [r.skill, r.xp])).toEqual([['strength', 18650], ['defence', 18650]]);
    expect(q.skipped).toEqual([{ line: 'q.rs2:9', text: 'if (testbit(%weird_bits, ^weird_complete) = true) {' }]);
});

test('only XP inside the block that sets the quest complete counts as reward', () => {
    const q = buildQuests({
        constants: parseConstants('^chompy_complete = 65\n^chompy_questpoints = 2\n', 'c'),
        proc: { text: 'if (%chompybird = ^chompy_complete) {\n    $questpoints = add($questpoints, ^chompy_questpoints);\n}\n', file: 'q' },
        varpFolders: new Map([['chompybird', 'quest_chompybird']]),
        folderScripts: new Map([['quest_chompybird', [{ text: '[opheld1,ogre_arrow]\nstat_advance(fletching, 60);\n\n[queue,chompy_done]\n%chompybird = ^chompy_complete;\nstat_advance(ranged, 7350);\n', file: 'f.rs2' }]]]),
    });
    expect(q.quests[0]!.xp).toEqual([{ skill: 'ranged', xp: 735, src: 'f.rs2:6' }]);
});

test('>= and either-of conditions are read, the either-of as alternative varps', () => {
    const proc = `if (%blackarmgang = ^blackarmgang_complete | %phoenixgang = ^phoenixgang_complete) {
    $questpoints = add($questpoints, ^shield_questpoints);
}
if (%elenaquest >= ^elena_complete) {
    $questpoints = add($questpoints, ^elena_questpoints);
}
`;
    const c = parseConstants('^blackarmgang_complete = 4\n^phoenixgang_complete = 4\n^shield_questpoints = 1\n^elena_complete = 21\n^elena_questpoints = 1\n', 'c');
    const q = buildQuests({ constants: c, proc: { text: proc, file: 'q' }, varpFolders: new Map(), folderScripts: new Map() });
    expect(q.quests.map(x => [x.varp, x.complete, x.questPoints, x.alternatives ?? []])).toEqual([
        ['blackarmgang', 4, 1, ['phoenixgang']],
        ['elenaquest', 21, 1, []],
    ]);
    expect(q.skipped).toEqual([]);
});

test('XP is found when completion is set through a setter proc that takes the complete constant', () => {
    const q = buildQuests({
        constants: parseConstants('^vampire_complete = 3\n^vampire_questpoints = 3\n', 'c'),
        proc: { text: 'if (%vampire = ^vampire_complete) {\n    $questpoints = add($questpoints, ^vampire_questpoints);\n}\n', file: 'q' },
        varpFolders: new Map([['vampire', 'quest_vampire']]),
        folderScripts: new Map([['quest_vampire', [{ text: '[queue,quest_vampire_complete]\nstat_advance(attack, 48250);\n~quest_vampire_set_progress(^vampire_complete);\n', file: 'v.rs2' }]]]),
    });
    expect(q.quests[0]!.xp).toEqual([{ skill: 'attack', xp: 4825, src: 'v.rs2:2' }]);
});

test('testbit(^true), ~get_cog_progress, folder fallback, and completion-queue XP are parsed cleanly', () => {
    const q = buildQuests({
        constants: parseConstants([
            '^elemental_workshop_complete = 20',
            '^elemental_workshop_questpoints = 1',
            '^quest_cog_complete = 8',
            '^cog_questpoints = 1',
            '^priestperil_complete = 60',
            '^priestperil_questpoints = 1',
            '^horror_complete = 10',
            '^horror_questpoints = 2',
        ].join('\n'), 'c'),
        proc: {
            text: [
                'if (testbit(%elemental_workshop_bits, ^elemental_workshop_complete) = ^true) {',
                '    $questpoints = add($questpoints, ^elemental_workshop_questpoints);',
                '}',
                'if (~get_cog_progress = ^quest_cog_complete) {',
                '    $questpoints = add($questpoints, ^cog_questpoints);',
                '}',
                'if (%priestperil = ^priestperil_complete) {',
                '    $questpoints = add($questpoints, ^priestperil_questpoints);',
                '}',
                'if (%horrorquest = ^horror_complete) {',
                '    $questpoints = add($questpoints, ^horror_questpoints);',
                '}',
            ].join('\n'),
            file: 'q',
        },
        varpFolders: new Map([['priestperil', 'quest_priestperil']]),
        folderScripts: new Map([
            ['quest_elemental_workshop', [{ text: 'setbit(%elemental_workshop_bits, ^elemental_workshop_complete);\nstat_advance(crafting, 50000);\n', file: 'ew.rs2' }]],
            ['quest_priestperil', [{ text: '[queue,priestperil_complete]\nstat_advance(prayer, 14060);\n~send_quest_complete(questlist:priestperil, x, 250, ^priestperil_questpoints, "done");\n', file: 'pp.rs2' }]],
            ['quest_horror', [{ text: '[queue,horror_complete]\nstat_advance(magic, 46620);\n%horrorquest = ^horror_complete;\n~send_quest_complete(questlist:horror, x, 225, ^horror_questpoints, "done");\n', file: 'hh.rs2' }]],
        ]),
    });
    expect(q.skipped).toEqual([]);
    expect(q.quests.map(x => [x.varp, x.folder, x.complete, x.xp.map(r => [r.skill, r.xp])])).toEqual([
        ['elemental_workshop_bits', 'quest_elemental_workshop', 1 << 20, [['crafting', 5000]]],
        ['cogquest', null, 8, []],
        ['priestperil', 'quest_priestperil', 60, [['prayer', 1406]]],
        ['horrorquest', 'quest_horror', 10, [['magic', 4662]]],
    ]);
});
