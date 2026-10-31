import { test, expect } from 'bun:test';
import { domainOf } from '../../knowledge/src/actions';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { named, questScript, questJournalNames, questStages, itemsHeld, skillBands, domainStages } from '../src/coverage';
import { questDefinitions } from '../../core/src/quest-status';
import { scoreboardSummary } from '../src/coordinator-planner';

test('content paths map to one domain each', () => {
    expect(domainOf('skill_combat/scripts/x.rs2')).toBe('skill/combat');
    expect(domainOf('quests/quest_tree/scripts/x.rs2')).toBe('quest/tree');
    expect(domainOf('areas/area_varrock/scripts/x.rs2')).toBe('area/varrock');
    expect(domainOf('minigames/game_trawler/scripts/x.rs2')).toBe('minigame/trawler');
    expect(domainOf('macro events/scripts/x.rs2')).toBe('system/macro_events');
});

test('named needs a debug name or a 5+ letter display name in our source', () => {
    const text = 'await q.talk(/^father aereck$/i); oploc khazzacklowwall';
    expect(named({ domain: 'x', trigger: 'opnpc1', subject: 'father_aereck_2', name: 'Father Aereck', src: '' }, text)).toBe(true);
    expect(named({ domain: 'x', trigger: 'oploc1', subject: 'khazzacklowwall', src: '' }, text)).toBe(true);
    expect(named({ domain: 'x', trigger: 'oploc1', subject: 'door1', name: 'Door', src: '' }, 'door')).toBe(false);
    expect(domainStages([{ domain: 'a', trigger: 'oploc1', subject: 'khazzacklowwall', src: '' }, { domain: 'a', trigger: 'oploc1', subject: 'zzzz', src: '' }], text)).toEqual([{ domain: 'a', actions: 2, named: 1, share: 50 }]);
});

test('quest folders map to our script names', () => {
    expect(questScript('quest_tree')).toBe('quest-tree.ts');
    expect(questScript('quest_troll_love')).toBe('quest-trolllove.ts');
    expect(questScript('quest_mcannon')).toBe('dwarfcannon.ts');
    expect(questScript('quest_elemental_workshop')).toBe('quest-elemental.ts');
});

test('pinned journal names cover all journal quests, excluding the barcrawl miniquest', () => {
    const names = questJournalNames();
    const folders = readdirSync(resolve(import.meta.dir, '../../../vendor/rs-sdk/server/content/scripts/quests')).filter(f => f.startsWith('quest_'));
    expect(folders.filter(folder => !names.has(folder))).toEqual(['quest_barcrawl']);
    expect([...names.keys()].sort()).toEqual(folders.filter(folder => folder !== 'quest_barcrawl').sort());
    expect([...names.values()].sort()).toEqual(questDefinitions().map(q => q.name).sort());
    expect(names.get('quest_blackknight')).toBe("Black Knight's Fortress");
    expect(names.get('quest_runemysteries')).toBe('Rune Mysteries Quest');
});

test('live completion outranks practice and scripts without promoting incomplete or unknown quests', () => {
    const names = questJournalNames();
    const folders = ['quest_cook', 'quest_runemysteries', 'quest_blackknight', 'quest_doric', 'quest_imp', 'quest_tree'];
    const quests = folders.map(folder => ({ folder, varp: folder, name: names.get(folder), questPoints: 1 }));
    const statuses = [{ quests: [
        { name: "Cook's Assistant", state: 'complete' },
        { name: 'Rune Mysteries Quest', state: 'complete' },
        { name: "Black Knight's Fortress", state: 'complete' },
        { name: "Doric's Quest", state: 'started' },
        { name: 'Imp Catcher', state: 'unknown' },
    ] }];
    const result = questStages(statuses, new Set(['quest_cook', 'quest_doric']), new Set(['quest_runemysteries', 'quest_imp']), quests);
    expect(result.folders.map(q => q.stage)).toEqual(['live', 'live', 'live', 'practice', 'named', 'none']);
    const summary = scoreboardSummary({ quests: result, skills: [], domains: [] });
    expect(summary.quests.practice).toEqual(['doric']);
    expect(summary.quests.named).toEqual(['imp']);
    expect(summary.quests.none).toEqual(['tree']);
    expect(summary.quests.liveComplete).toHaveLength(3);
});

test('an unmapped journal label cannot imply a folder completion', () => {
    const result = questStages([{ quests: [{ name: 'quest_cook', state: 'complete' }] }], new Set(), new Set(),
        [{ folder: 'quest_cook', varp: 'cookquest', name: "Cook's Assistant", questPoints: 1 }]);
    expect(result.folders[0]!.stage).toBe('none');
});

test('items and skill bands come from owned live statuses', () => {
    const statuses = [{ skills: [{ name: 'Magic', level: 55 }], bank: [{ baseId: 554, count: 30 }], inventory: [{ id: 1351 }] }];
    expect(itemsHeld(statuses, [{ id: 554, tradeable: true }, { id: 1351 }, { id: 9 }])).toEqual({ items: 3, held: 2, tradeable: 1, tradeableHeld: 1 });
    const magic = skillBands(statuses).find(s => s.skill === 'Magic')!;
    expect(magic.bands.map(b => b.stage)).toEqual(['live', 'live-partial', 'none']);
});
