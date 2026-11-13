import { expect, test } from 'bun:test';
import { best, canWear, loadGear, sumBonuses } from './gear';

const gear = loadGear();
const named = (n: string) => gear.find(g => g.debugname === n)!;

test('knowledge/gear.json holds the PvP items with their config numbers', () => {
    expect(named('black_dragonhide_body').bonuses).toMatchObject({ rangeAttack: 30, magicAttack: -15, magicDefence: 50, rangeDefence: 55, stabDefence: 55 });
    expect(named('rune_platebody').requires).toMatchObject({ skills: { defence: 40 }, quest: 'Dragon Slayer' });
    expect(named('dragon_dagger_p')).toMatchObject({ attackRate: 4, special: { energy: 250, pvp: true } });
    expect(named('magic_shortbow')).toMatchObject({ attackRange: 7, tier: 50, special: { energy: 350, pvp: true } });
});

test('best ranks a slot by weighted bonuses and leaves out what the account cannot wear and staff items', () => {
    expect(best(gear, 'torso', { rangeAttack: 1 })[0]!.debugname).toBe('black_dragonhide_body');
    expect(best(gear, 'torso', { rangeAttack: 1 }, { attack: 1, strength: 1, defence: 1, ranged: 65, magic: 1 }).some(g => g.debugname === 'black_dragonhide_body')).toBe(false);
    expect(best(gear, 'righthand', { stabAttack: 1 }).some(g => g.staffOnly)).toBe(false);
    expect(canWear(named('rune_platebody'), { defence: 99 }, new Set(['Lost City']))).toBe(false);
    expect(sumBonuses([named('rune_platebody'), named('rune_platelegs')]).magicAttack).toBe(-51);
});
