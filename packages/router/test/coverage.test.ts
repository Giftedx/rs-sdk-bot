import { test, expect } from 'bun:test';
import { domainOf } from '../../knowledge/src/actions';
import { named, questScript, itemsHeld, skillBands, domainStages } from '../src/coverage';

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

test('items and skill bands come from owned live statuses', () => {
    const statuses = [{ skills: [{ name: 'Magic', level: 55 }], bank: [{ baseId: 554, count: 30 }], inventory: [{ id: 1351 }] }];
    expect(itemsHeld(statuses, [{ id: 554, tradeable: true }, { id: 1351 }, { id: 9 }])).toEqual({ items: 3, held: 2, tradeable: 1, tradeableHeld: 1 });
    const magic = skillBands(statuses).find(s => s.skill === 'Magic')!;
    expect(magic.bands.map(b => b.stage)).toEqual(['live', 'live-partial', 'none']);
});
