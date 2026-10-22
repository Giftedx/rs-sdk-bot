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
