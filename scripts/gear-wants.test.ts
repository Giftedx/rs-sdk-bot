import { expect, test } from 'bun:test';
import { GEAR_GAIN_FLOOR, GEAR_GE_ID, bonusGain, gearJobFor, gearShopId, type GearWantRow } from '../packages/planner/src/gear-want-jobs';
import { KIT_BUY, KIT_BUY_SCRIPT, accountStyle, catalogue, plan, type Acct } from '../packages/planner/src/autopilot';
import { shopProfileFor } from './gear-wants';
import { gearWantsOf } from './autopilot';
import { PROFILES } from './shop-buyer';
import { DATA_PROFILE, dataProfile, derivedProfile } from './shop-profiles';

const side = 'claude-cloud';
const IRON_SCIMITAR = 1323, RUNE_SCIMITAR = 1333, ADAMANT_SCIMITAR = 1331, LEATHER_GLOVES = 1059, LEATHER_COWL = 1167;
const geWant = (id: number, name: string, current: number | null, ask: number): GearWantRow => ({ style: 'melee', slot: 'weapon', id, name, current, source: { kind: 'ge', ask, sell: 5 } });
const shopWant = (id: number, name: string, current: number | null, cost: number, profile = 'zeke'): GearWantRow =>
    ({ style: 'melee', slot: 'weapon', id, name, current, source: { kind: 'shop', shop: 'scimitarshop', cost, distance: 10 }, profile });
const acct = (coin: number): Acct => ({ name: 'Fighter', side, skills: { Hitpoints: 10, Attack: 40 }, items: { coin } });
const run = (a: Acct, wants: GearWantRow[]) => plan({ side, accounts: [a], owners: new Map([[a.name.toLowerCase(), { side }]]), templates: [], bill: [], prices: {},
    gearWants: new Map([[a.name.toLowerCase(), wants]]) })[0]!;

test('a gain is in points of the style bonuses, and a want under the floor is no job', () => {
    expect(bonusGain('melee', RUNE_SCIMITAR, IRON_SCIMITAR)).toBeGreaterThan(GEAR_GAIN_FLOOR);
    expect(bonusGain('melee', LEATHER_GLOVES, null)).toBeLessThan(GEAR_GAIN_FLOOR);
    expect(gearJobFor([geWant(LEATHER_GLOVES, 'Leather gloves', null, 50)], { coins: 1_000_000, room: 0 })).toBeNull();
});

test('a market want of an account that is not on the army roster plans a kit buy', () => {
    const a = run(acct(300_000), [geWant(RUNE_SCIMITAR, 'Rune scimitar', IRON_SCIMITAR, 15_000)]);
    expect(a.template?.id).toBe(KIT_BUY + GEAR_GE_ID);
    expect(a.template?.script).toBe('scripts/chain.ts');
    const step = String(a.template?.args?.[0]);
    expect(step).toContain(KIT_BUY_SCRIPT);
    expect(step).toContain(`ITEM_ID=${RUNE_SCIMITAR}`);
    expect(step).toContain(`LIMIT_PRICE=${Math.ceil(15_000 * 1.05)}`);
});

test('a shop want plans one trip to its shop with the profile of the shop-buyer', () => {
    const a = run(acct(40_000), [shopWant(ADAMANT_SCIMITAR, 'Adamant scimitar', 1329, 1_560, 'zeke'), shopWant(RUNE_SCIMITAR, 'Rune scimitar', 1329, 14_080, 'zeke')]);
    expect(a.template?.id).toBe(gearShopId('zeke'));
    expect(a.template?.script).toBe('scripts/shop-buyer.ts');
    expect(a.template?.args?.[0]).toBe('zeke');
    expect(a.template?.env?.ITEMS).toBe('Adamant scimitar|Rune scimitar');
    expect(Number(a.template?.env?.MAX_SPEND)).toBeLessThanOrEqual(40_000);
});

test('a want that the account cannot pay for plans no job', () => {
    expect(run(acct(500), [geWant(RUNE_SCIMITAR, 'Rune scimitar', IRON_SCIMITAR, 15_000)]).template).toBeUndefined();
    expect(run(acct(500), [shopWant(RUNE_SCIMITAR, 'Rune scimitar', IRON_SCIMITAR, 14_080)]).template).toBeUndefined();
});

test('a want under the gain floor plans no job in the pass', () => {
    expect(run(acct(300_000), [geWant(LEATHER_GLOVES, 'Leather gloves', null, 100)]).template).toBeUndefined();
    expect(run(acct(300_000), [geWant(LEATHER_COWL, 'Leather cowl', null, 100)]).template?.id).toBe(KIT_BUY + GEAR_GE_ID);
});

test('a held job, an ammunition want and a running session each give no cheap job', () => {
    const want = geWant(RUNE_SCIMITAR, 'Rune scimitar', IRON_SCIMITAR, 15_000);
    expect(gearJobFor([want], { coins: 300_000, room: 0, held: id => id === GEAR_GE_ID })).toBeNull();
    expect(gearJobFor([{ ...want, slot: 'ammo' }], { coins: 300_000, room: 0 })).toBeNull();
    expect(gearJobFor([geWant(LEATHER_COWL, 'Leather cowl', null, 100)], { coins: 300_000, room: 0, running: true })).toBeNull();
    expect(gearJobFor([want], { coins: 300_000, room: 0, running: true })?.kind).toBe('ge');
});

test('the style comes from the running band, else from the next army band, else none', () => {
    const templates = catalogue(), a: Acct = { name: 'Fighter', side, skills: { Hitpoints: 10, Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1 }, items: {} };
    expect(accountStyle(a, templates, 'army-cow-strength-45', false)).toBe('melee');
    expect(accountStyle(a, templates, 'army-trooper-ranged-99', false)).toBe('ranged');
    expect(accountStyle(a, templates, 'army-alch-magic-99', false)).toBe('magic');
    expect(accountStyle(a, templates, 'shop-runes', false)).toBeNull();
    expect(accountStyle(a, templates, undefined, true)).not.toBeNull();
    expect(accountStyle(a, templates, undefined, false)).toBeNull();
    const done: Acct = { ...a, skills: Object.fromEntries(Object.keys(a.skills).map(k => [k, 99])) };
    expect(accountStyle(done, templates, 'kit-buy:army-weapon', true)).toBeNull();
});

test('the wants come from the status, with the profile of each shop want', () => {
    const status = { skills: [{ name: 'Attack', level: 40 }, { name: 'Strength', level: 40 }, { name: 'Defence', level: 40 }], inventory: [{ id: 995, count: 300_000 }], equipment: [{ id: IRON_SCIMITAR, count: 1 }], bank: [], quests: [] };
    const asks = { [RUNE_SCIMITAR]: { ask: 15_000, sell: 5 } };
    const wants = gearWantsOf(['Fighter'], () => status, () => 'melee', {}, asks, Date.now());
    expect(wants.get('fighter')?.some(w => w.source.kind === 'ge' || w.source.kind === 'shop')).toBe(true);
    expect(gearWantsOf(['Fighter'], () => status, () => null, {}, asks, Date.now()).size).toBe(0);
    expect(shopProfileFor('scimitarshop', 'Mithril scimitar')).toBe('zeke');
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
