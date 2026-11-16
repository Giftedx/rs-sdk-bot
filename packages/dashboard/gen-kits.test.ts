import { expect, test } from 'bun:test';
import { kitList } from './gen-kits';

test('a kit becomes slot ids, display names, and the food counted with the carried items', () => {
    const names = new Map([['rune_full_helm', 'Rune full helm'], ['rune_arrow', 'Rune arrow'], ['shark', 'Shark'], ['bloodrune', 'Blood rune']]);
    const ids = new Map([['rune_full_helm', 1163], ['rune_arrow', 892], ['shark', 385], ['bloodrune', 565]]);
    expect(kitList({ k: { worn: { hat: 'rune_full_helm', ammo: ['rune_arrow', 300], tail: 'x' }, carried: [['bloodrune', 100], 'bloodrune'], food: 18 } }, names, ids))
        .toEqual([{ name: 'k', worn: { 0: ['Rune full helm', 1, 1163], 13: ['Rune arrow', 300, 892] }, carried: [['Blood rune', 101, 565], ['Shark', 18, 385]] }]);
});

test('a thrown weapon keeps its stack: worn.weaponCount', () => {
    expect(kitList({ k: { worn: { weapon: 'rune_knife', weaponCount: 500 } } }, new Map([['rune_knife', 'Rune knife']]), new Map([['rune_knife', 868]]))[0]!.worn)
        .toEqual({ 3: ['Rune knife', 500, 868] });
});

test('same-name variants remain separate and food combines only with its exact carried item', () => {
    const names = new Map([['green', 'Dragonhide body'], ['black', 'Dragonhide body']]), ids = new Map([['green', 1135], ['black', 2503]]);
    const [kit] = kitList({ k: { worn: { torso: 'black' }, carried: ['green', 'black', ['green', 2]], food: 2, foodItem: 'green' } }, names, ids);
    expect(kit!.worn[4]).toEqual(['Dragonhide body', 1, 2503]);
    expect(kit!.carried).toEqual([['Dragonhide body', 5, 1135], ['Dragonhide body', 1, 2503]]);
});

test('an unresolved content item retains an explicit unknown ID', () => {
    expect(kitList({ k: { carried: ['missing'] } }, new Map(), new Map())[0]!.carried).toEqual([['missing', 1, null]]);
});
