import { expect, test } from 'bun:test';
import { itemCategory, itemList } from './gen-item-list';

test('the collection log categories come from the content folder of each item', () => {
    expect(itemCategory('scripts/skill_smithing/configs/bars.obj:4')).toBe('Smithing');
    expect(itemCategory('scripts/quests/quest_mcannon/configs/quest_mcannon.obj:1')).toBe('Quests');
    expect(itemCategory('scripts/macro events/configs/x.obj:1')).toBe('Random events');
    expect(itemCategory('scripts/_unpack/all.obj:9')).toBe('Other');
    expect(itemList([
        { id: 2, name: 'Bronze bar', tradeable: true, src: 'scripts/skill_smithing/a.obj:1' },
        { id: 1, name: 'Dwarf remains', tradeable: false, src: 'scripts/quests/a.obj:1' },
        { id: 3, name: 'Anchovies', tradeable: true, src: 'scripts/skill_cooking/a.obj:1' },
    ])).toEqual([[3, 'Anchovies', 'Cooking'], [2, 'Bronze bar', 'Smithing']]);
});
