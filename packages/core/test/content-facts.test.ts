import { expect, test } from 'bun:test';
import { ammoTier, boneXp, castRunes, npcId, objId, prayerLevel, specialBar, specialEnergy, spellFact, toolLevel, wearLevel, XP_RATE } from '../src/content-facts';
import { statRandomChance } from '../../knowledge/src/method-model';

test('item and NPC ids come from the packs by display name', () => {
    expect(objId('adamant scimitar')).toBe(1331);
    expect(objId('dragon bones')).toBe(536);
    expect(objId('unstrung yew longbow')).toBe(66);
    expect(npcId('giant')).toBe(117);
    expect(npcId('khazard troop spearmen')).toBe(476);
    expect(() => objId('no such item')).toThrow('content: no item');
});

test('wear, tool and ammo levels', () => {
    expect(wearLevel('dragon dagger', 'attack')).toBe(60);
    expect(wearLevel('rune scimitar', 'attack')).toBe(40);
    expect(wearLevel('magic shortbow', 'ranged')).toBe(50);
    expect(ammoTier('steel arrow')).toBe(5);
    expect(ammoTier('rune arrow')).toBe(40);
    expect(toolLevel('rune pickaxe')).toBe(41);
    expect(toolLevel('adamant axe')).toBe(31);
    expect(toolLevel('iron pickaxe')).toBe(1);
    expect(specialEnergy('dragon dagger')).toBe(250);
    expect(specialEnergy('adamant scimitar')).toBeUndefined();
});

test('spell costs and the XP of a cast at the server rate', () => {
    expect(XP_RATE).toBe(25);
    expect(spellFact('curse')).toEqual({ level: 19, runes: { 'body rune': 1, 'water rune': 2, 'earth rune': 3 }, xp: 725 });
    expect(spellFact('camelot_teleport').level).toBe(45);
    expect(spellFact('ardougne_teleport').level).toBe(51);
    expect(castRunes({ falador_teleport: 6, camelot_teleport: 5, varrock_teleport: 1 })).toEqual({ 'law rune': 12, 'air rune': 46, 'water rune': 6, 'fire rune': 1 });
    expect(castRunes({ falador_teleport: 1, ardougne_teleport: 2 })).toEqual({ 'law rune': 5, 'air rune': 3, 'water rune': 5 });
});

test('prayer levels, bone XP and the special attack bar', () => {
    expect([prayerLevel('Protect from Magic'), prayerLevel('Protect from Missiles'), prayerLevel('Protect from Melee')]).toEqual([37, 40, 43]);
    expect([prayerLevel('Thick Skin'), prayerLevel('Rock Skin'), prayerLevel('Steel Skin')]).toEqual([1, 10, 28]);
    expect([prayerLevel('Clarity of Thought'), prayerLevel('Improved Reflexes'), prayerLevel('Incredible Reflexes')]).toEqual([7, 16, 34]);
    expect([prayerLevel('Burst of Strength'), prayerLevel('Superhuman Strength'), prayerLevel('Ultimate Strength')]).toEqual([4, 13, 31]);
    expect([boneXp('bones'), boneXp('big bones'), boneXp('dragon bones')]).toEqual([112.5, 375, 1800]);
    expect(specialBar()).toEqual({ max: 1000, regenAmount: 100, regenInterval: 50 });
});

test('Underground Pass agility 68 is the first level at which a bridge roll cannot fail', () => {
    // upass_obstacles.rs2:374 rolls stat_random(agility, 160, 300); Thieving 50 is quest_upass.rs2:248.
    expect(statRandomChance(67, 160, 300)).toBeLessThan(1);
    expect(statRandomChance(68, 160, 300)).toBe(1);
});
