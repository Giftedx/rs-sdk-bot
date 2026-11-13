import { expect, test } from 'bun:test';
import { kitList } from './gen-kits';

test('a kit becomes slot ids, display names, and the food counted with the carried items', () => {
    const names = new Map([['rune_full_helm', 'Rune full helm'], ['rune_arrow', 'Rune arrow'], ['shark', 'Shark'], ['bloodrune', 'Blood rune']]);
    expect(kitList({ k: { worn: { hat: 'rune_full_helm', ammo: ['rune_arrow', 300], tail: 'x' }, carried: [['bloodrune', 100], 'bloodrune'], food: 18 } }, names))
        .toEqual([{ name: 'k', worn: { 0: ['Rune full helm', 1], 13: ['Rune arrow', 300] }, carried: [['Blood rune', 101], ['Shark', 18]] }]);
});
