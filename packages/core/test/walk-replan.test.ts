import { test, expect } from 'bun:test';
import { withoutSpells } from '../src/walk';
import { travelAllowed, type Travel } from '../src/travel';

test('an account without its law runes casts no teleport, so a replanned route keeps to the ground', () => {
    const camelot: Travel = { id: 'spell:camelot_teleport:to', kind: 'spell', name: 'Camelot teleport', from: null, to: { x: 2757, z: 3478, level: 0 }, coins: 0,
        needs: [{ skill: 'magic', level: 45 }], runes: [{ item: 'airrune', count: 5 }, { item: 'lawrune', count: 1 }], run: { how: 'spell', component: 'magic:camelot_teleport' }, cost: 1 } as Travel;
    const acct = { skills: { magic: 46 }, varps: {}, items: ['airrune', 'lawrune', 'coins'], counts: { airrune: 6, lawrune: 1, coins: 500 }, coins: 500 } as any;
    expect(travelAllowed(camelot, acct)).toBe(true);
    const grounded = withoutSpells(acct);
    expect(travelAllowed(camelot, grounded)).toBe(false);
    expect(grounded.items).toEqual(['airrune', 'coins']);
    expect(grounded.counts).toEqual({ airrune: 6, lawrune: 0, coins: 500 });
    // A short cast is refused by the count, not the kind: four air runes do not cast Camelot.
    expect(travelAllowed(camelot, { ...acct, counts: { ...acct.counts, airrune: 4 } })).toBe(false);
    expect(travelAllowed(camelot, { ...acct, skills: { magic: 44 } })).toBe(false);
});
