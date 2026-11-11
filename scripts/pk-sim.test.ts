import { expect, test } from 'bun:test';
import { itemBonuses, series, simulate } from './pk-sim';

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

test('the builds rank as on the bench: potions, the melee build and the ranger win, cheaper armour loses', () => {
    for (const kit of ['tribrid-pots', 'melee', 'ranger']) { const s = series(kit, 'tribrid', {}, {}, 400); expect(s.winsA).toBeGreaterThan(s.winsB); }
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
