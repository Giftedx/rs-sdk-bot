import { expect, test } from 'bun:test';
import { itemBonuses, league, series, simulate } from './pk-sim';
import { styleOfName } from './pk';

test('reads the combat bonuses of an item from the content configs', () => {
    const dagger = itemBonuses().get('dragon_dagger');
    expect(itemBonuses().get('dragon_longsword')?.rate).toBe(5);
    expect(dagger!.stab).toBeGreaterThan(0);
    expect(itemBonuses().get('rune_platebody')!.dSlash).toBeGreaterThan(0);
});

test('one seed gives one fight', () => {
    expect(simulate('tribrid', 'melee', {}, {}, 7)).toEqual(simulate('tribrid', 'melee', {}, {}, 7));
});

test('the mirror is fair: neither side wins by its place', () => {
    const s = series('tribrid', 'tribrid', {}, {}, 600);
    expect(Math.abs(s.winsA - s.winsB) / s.fights).toBeLessThan(0.08);
});

test('the builds rank as on the bench: potions and the lean kit win, the mage and cheaper armour lose', () => {
    for (const kit of ['tribrid-pots', 'tribrid-lean']) { const s = series(kit, 'tribrid', {}, {}, 400); expect(s.winsA).toBeGreaterThan(s.winsB); }
    expect(series('mage', 'tribrid', {}, {}, 400).winRateA).toBeLessThan(0.1);
    expect(series('tribrid-mithril', 'tribrid', {}, {}, 400).winRateA).toBeLessThan(0.1);
});

test('prayer points run out: with no restore potion a mirror ends sooner', () => {
    expect(series('tribrid', 'tribrid', { restorePrayerAt: -1 }, { restorePrayerAt: -1 }, 300).ticks).toBeLessThan(series('tribrid', 'tribrid', {}, {}, 300).ticks);
});

test('damage lands: a fight ends in a kill before the cap', () => {
    const f = simulate('tribrid-bare', 'tribrid', {}, {}, 3, 2000);
    expect(f.winner).not.toBe('draw');
    expect(f.takenA + f.takenB).toBeGreaterThan(99);
});

test('a build fights at its own levels: Defence 45 loses to Defence 99 in the same kit, and Prayer 43 beats Prayer 1', () => {
    expect(series('zerker', 'tribrid-pots', {}, {}, 300).winRateA).toBeLessThan(0.1);
    expect(series('pure-pray', 'pure-dds-msb', {}, {}, 300).winRateA).toBeGreaterThan(0.6);
    // A thrown weapon is ranged, as in the fight loop: the knife build throws and the other side sees a ranged weapon.
    const knives = simulate('pure-knives', 'pure-dds', {}, {}, 5, 600);
    expect(knives.attacksA.ranged).toBeGreaterThan(0);
    expect(styleOfName('rune_knife')).toBe('ranged');
    expect(styleOfName('rune_dart_p')).toBe('ranged');
    expect(styleOfName('magic_shortbow')).toBe('ranged');
    expect(styleOfName('zamorak_staff')).toBe('magic');
    expect(styleOfName('dragon_longsword')).toBe('melee');
    const table = league(['pure-pray', 'pure-mage'], 100);
    expect(table[0]!.kit).toBe('pure-pray');
});
