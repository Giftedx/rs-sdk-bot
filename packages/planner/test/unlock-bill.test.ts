import { expect, test } from 'bun:test';
import { skillRow, shoppingList, type Rung } from '../src/unlock-bill';

const rung = (id: string, level: number, xp: number, extra: Partial<Rung> = {}): Rung => ({ id, skill: 'runecraft', level, label: id, kind: 'k', xpPerAction: xp, xpPerTick: null, inputs: [], requires: [], quest: null, worker: null, ...extra });
const own = new Map([['A', new Map([['air_talisman', 1]])], ['B', new Map([['mind_talisman', 2]])]]);

test('the best usable rung is chosen and its missing item names another account as a source', () => {
    const rungs = [rung('air', 1, 5, { requires: [{ id: 1, debugname: 'air_talisman', name: 'Air talisman' }] }), rung('mind', 2, 6, { requires: [{ id: 2, debugname: 'mind_talisman', name: 'Mind talisman' }] }), rung('water', 5, 7)];
    const r = skillRow('A', {}, 'runecraft', 3, rungs, [], own, () => []);
    expect(r.best?.id).toBe('mind');
    expect(r.blockers).toEqual([{ kind: 'item', name: 'Mind talisman', item: 'mind_talisman', have: 0, sources: ['B 2', 'GE'] }]);
    expect(r.next?.id).toBe('water');
    expect(shoppingList([r])[0]).toMatchObject({ item: 'mind_talisman', accounts: ['A'] });
});

test('a rung whose item cannot be obtained is not chosen; a quest gate is a blocker', () => {
    const rungs = [rung('low', 1, 1), rung('high', 1, 9, { inputs: [{ id: 3, debugname: 'rare', name: 'Rare', count: 1 }] }), rung('quest', 1, 5, { quest: { name: 'Rune Mysteries Quest' } })];
    const r = skillRow('A', { quests: [] }, 'runecraft', 1, rungs, [], own, () => [], i => i !== 'rare');
    expect(r.best?.id).toBe('quest');
    expect(r.blockers[0]).toMatchObject({ kind: 'quest', name: 'Rune Mysteries Quest' });
});

test('a shared completed quest unlocks its rung through the full journal or legacy completed names', () => {
    const quest = 'Rune Mysteries Quest', rungs = [rung('quest', 1, 5, { quest: { name: quest } })];
    for (const status of [
        { quests: [{ name: quest, state: 'complete' }] },
        { quests: [quest.toLowerCase()] },
        { quests: [], questJournal: [{ id: 7335, name: quest, state: 'complete' }] },
    ]) {
        expect(skillRow('A', status, 'runecraft', 1, rungs, [], own, () => []).blockers).toEqual([]);
    }
    for (const questJournal of [[], [{ id: 7335, name: quest, state: 'unknown' }], [{ id: 7335, name: quest, state: 'started' }]]) {
        const row = skillRow('A', { quests: [quest], questJournal }, 'runecraft', 1, rungs, [], own, () => []);
        expect(row.blockers).toEqual([{ kind: 'quest', name: quest, have: 0, sources: [] }]);
    }
});
