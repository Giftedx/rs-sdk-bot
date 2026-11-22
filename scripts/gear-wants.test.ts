import { expect, test } from 'bun:test';
import { GEAR_GAIN_FLOOR, GEAR_GE_ID, bonusGain, gearJobFor, type GearWantRow } from '../packages/planner/src/gear-want-jobs';
import { shopProfileFor } from './gear-wants';
import { DATA_PROFILE, PROFILES, dataProfile, derivedProfile } from '../packages/workers/src/market';

const IRON_SCIMITAR = 1323, RUNE_SCIMITAR = 1333, LEATHER_GLOVES = 1059, LEATHER_COWL = 1167;
const geWant = (id: number, name: string, current: number | null, ask: number): GearWantRow => ({ style: 'melee', slot: 'weapon', id, name, current, source: { kind: 'ge', ask, sell: 5 } });

test('a gain is in points of the style bonuses, and a want under the floor is no job', () => {
    expect(bonusGain('melee', RUNE_SCIMITAR, IRON_SCIMITAR)).toBeGreaterThan(GEAR_GAIN_FLOOR);
    expect(bonusGain('melee', LEATHER_GLOVES, null)).toBeLessThan(GEAR_GAIN_FLOOR);
    expect(gearJobFor([geWant(LEATHER_GLOVES, 'Leather gloves', null, 50)], { coins: 1_000_000, room: 0 })).toBeNull();
});

test('a held job, an ammunition want and a running session each give no cheap job', () => {
    const want = geWant(RUNE_SCIMITAR, 'Rune scimitar', IRON_SCIMITAR, 15_000);
    expect(gearJobFor([want], { coins: 300_000, room: 0, held: id => id === GEAR_GE_ID })).toBeNull();
    expect(gearJobFor([{ ...want, slot: 'ammo' }], { coins: 300_000, room: 0 })).toBeNull();
    expect(gearJobFor([geWant(LEATHER_COWL, 'Leather cowl', null, 100)], { coins: 300_000, room: 0, running: true })).toBeNull();
    expect(gearJobFor([want], { coins: 300_000, room: 0, running: true })?.kind).toBe('ge');
});

test('a shop that has no hand profile gets one from the content', () => {
    for (const shop of ['armourshop', 'helmetshop', 'legsshop', 'topshop', 'swordshop', 'chainmailshop', 'runeplateshop']) {
        const p = derivedProfile(shop)!;
        expect(p).toBeDefined();
        expect(p.items.length).toBeGreaterThan(0);
    }
    const armour = derivedProfile('armourshop')!;
    expect(armour.npc.test('Horvik')).toBe(true);
    expect(armour.npcSpot).toEqual({ x: 3229, z: 3438 });
    expect(armour.items.some(i => i.re.test('Steel platebody'))).toBe(true);
    expect(shopProfileFor('armourshop', 'Steel platebody')).toBe(DATA_PROFILE + 'armourshop');
    expect(dataProfile('data:armourshop')).toEqual(armour);
    expect(derivedProfile('dragonswordshop')).toBeUndefined();
    expect(PROFILES.jukat?.realm).toBeDefined();
});
