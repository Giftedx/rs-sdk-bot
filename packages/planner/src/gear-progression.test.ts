import { expect, test } from 'bun:test';
import { ownedBestLoadout } from './owned-loadout';
import {
    bestGearForSlot,
    bestMiningPickaxe,
    bestWoodcuttingAxe,
    canWearGear,
    crossedTierBoundary,
    gearById,
    normalizeCompletedQuests,
    selectProgressiveLoadout,
    shopCatalog,
    weaponSupportsTrainSkill,
} from './gear-progression';

test('normalizes rev-289 quest aliases across questlist UI and gear.json names', () => {
    const done = normalizeCompletedQuests(["Hero's Quest", 'Legends Quest', 'zanaris', 'dragon slayer', 'viking', 'regicide']);
    expect([...done].sort()).toEqual([
        'Dragon Slayer',
        "Heroes' Quest",
        "Legends' Quest",
        'Lost City',
        'Regicide',
        'The Fremennik Trials',
    ]);
    expect(normalizeCompletedQuests(null).size).toBe(0);
    expect(normalizeCompletedQuests({ 'Dragon Slayer': true, 'Lost City': false, Regicide: null })).toEqual(new Set(['Dragon Slayer']));
});

test('enforces rev-289 skill and quest gates including multi-line Fremennik and Granite requirements', () => {
    const berserker = gearById(3751)!;
    const fremBlade = gearById(3757)!;
    const granite = gearById(3122)!;
    const runePlate = gearById(1127)!;
    const dLong = gearById(1305)!;
    const dMace = gearById(1434)!;
    const dHalberd = gearById(3204)!;
    const dSq = gearById(1187)!;
    const legendsCape = gearById(1052)!;

    expect(canWearGear(berserker, { defence: 44 }, ['The Fremennik Trials'])).toBe(false);
    expect(canWearGear(berserker, { defence: 45 }, [])).toBe(false);
    expect(canWearGear(berserker, { defence: 45 }, ['The Fremennik Trials'])).toBe(true);

    expect(canWearGear(fremBlade, { attack: 29 }, ['The Fremennik Trials'])).toBe(false);
    expect(canWearGear(fremBlade, { attack: 30 }, [])).toBe(false);
    expect(canWearGear(fremBlade, { attack: 30 }, ['The Fremennik Trials'])).toBe(true);

    expect(canWearGear(granite, { defence: 50, strength: 49 })).toBe(false);
    expect(canWearGear(granite, { defence: 49, strength: 50 })).toBe(false);
    expect(canWearGear(granite, { defence: 50, strength: 50 })).toBe(true);

    expect(canWearGear(runePlate, { defence: 40 }, null)).toBe(false);
    expect(canWearGear(runePlate, { defence: 40 }, ['Dragon Slayer'])).toBe(true);
    expect(canWearGear(dLong, { attack: 60 }, ['Lost City'])).toBe(true);
    expect(canWearGear(dMace, { attack: 60 }, ["Hero's Quest"])).toBe(true);
    expect(canWearGear(dHalberd, { attack: 60, strength: 29 }, ['Regicide'])).toBe(false);
    expect(canWearGear(dHalberd, { attack: 60, strength: 30 }, ['Regicide'])).toBe(true);
    expect(canWearGear(dSq, { defence: 60 }, ['Legends Quest'])).toBe(true);
    expect(canWearGear(legendsCape, { defence: 1 }, ['Legends Quest'])).toBe(true);
    expect(canWearGear(legendsCape, { defence: 1 }, [])).toBe(false);
});

test('selectProgressiveLoadout picks best owned rev-289 melee kit across all 9 slots and respects 2h vs shield', () => {
    const stock = [
        { id: 1277, count: 1 }, // Bronze sword
        { id: 1325, count: 1 }, // Steel scimitar
        { id: 1331, count: 1 }, // Adamant scimitar
        { id: 1333, count: 1 }, // Rune scimitar
        { id: 1305, count: 1 }, // Dragon longsword (Lost City)
        { id: 1171, count: 1 }, // Wooden shield
        { id: 1201, count: 1 }, // Rune kiteshield
        { id: 1187, count: 1 }, // Dragon sq shield (Legends' Quest)
        { id: 1163, count: 1 }, // Rune full helm
        { id: 3751, count: 1 }, // Berserker helm (Fremennik + Def 45)
        { id: 1113, count: 1 }, // Rune chainbody
        { id: 1127, count: 1 }, // Rune platebody (Dragon Slayer)
        { id: 1079, count: 1 }, // Rune platelegs
        { id: 4087, count: 1 }, // Dragon platelegs (Def 60)
        { id: 1725, count: 1 }, // Amulet of strength
        { id: 1712, count: 1 }, // Amulet of glory(4)
        { id: 1007, count: 1 }, // Red cape
        { id: 1052, count: 1 }, // Cape of legends
        { id: 1059, count: 1 }, // Leather gloves
        { id: 1495, count: 1 }, // Klank's gauntlets
        { id: 1061, count: 1 }, // Leather boots
        { id: 3105, count: 1 }, // Climbing boots
    ];

    const low = selectProgressiveLoadout('melee', stock, { attack: 1, strength: 1, defence: 1 }, []);
    expect(low.worn.weapon?.id).toBe(1277);
    expect(low.worn.shield?.id).toBe(1171);
    expect(low.worn.amulet?.id).toBe(1712);
    expect(low.worn.cape?.id).toBe(1007);
    expect(low.worn.hands?.id).toBe(1495);
    expect(low.worn.feet?.id).toBe(3105);
    expect(low.worn.helm).toBeNull();
    expect(low.worn.body).toBeNull();
    expect(low.worn.legs).toBeNull();
    expect(low.upgrades.weapon?.nextUnlock?.item.id).toBe(1325); // Steel scimitar at Attack 5

    const mid = selectProgressiveLoadout('melee', stock, { attack: 40, strength: 40, defence: 45 }, []);
    expect(mid.worn.weapon?.id).toBe(1333); // Rune scimitar
    expect(mid.worn.shield?.id).toBe(1201); // Rune kiteshield
    expect(mid.worn.helm?.id).toBe(1163); // Rune full helm without Fremennik Trials
    expect(mid.worn.body?.id).toBe(1113); // Rune chainbody without Dragon Slayer
    expect(mid.worn.legs?.id).toBe(1079); // Rune platelegs
    expect(mid.upgrades.body?.nextUnlock?.item.id).toBe(1127);
    expect(mid.upgrades.body?.nextUnlock?.missingQuests).toEqual(['Dragon Slayer']);

    const high = selectProgressiveLoadout(
        'melee',
        stock,
        { attack: 60, strength: 60, defence: 60 },
        ['Dragon Slayer', 'Lost City', 'The Fremennik Trials', 'Legends Quest'],
    );
    expect(high.worn.weapon?.id).toBe(1305);
    expect(high.worn.shield?.id).toBe(1187);
    expect(high.worn.helm?.id).toBe(3751);
    expect(high.worn.body?.id).toBe(1127);
    expect(high.worn.legs?.id).toBe(4087);
    expect(high.worn.cape?.id).toBe(1052);

    // Two-handed weapon is picked when strictly stronger than owned 1h weapon, and omits shield.
    const twoHandedOnly = selectProgressiveLoadout(
        'melee',
        [{ id: 1277, count: 1 }, { id: 1319, count: 1 }, { id: 1171, count: 1 }],
        { attack: 40, defence: 1 },
        [],
    );
    expect(twoHandedOnly.worn.weapon?.id).toBe(1319);
    expect(twoHandedOnly.worn.shield).toBeNull();
});

test('weaponSupportsTrainSkill filters spears and halberds when single-skill training needs Attack/Strength', () => {
    const dSpear = gearById(1249)!;
    const rHally = gearById(3202)!;
    const rScim = gearById(1333)!;
    expect(weaponSupportsTrainSkill(dSpear, 'Attack')).toBe(false);
    expect(weaponSupportsTrainSkill(dSpear, 'Strength')).toBe(false);
    expect(weaponSupportsTrainSkill(dSpear, 'Defence')).toBe(true);
    expect(weaponSupportsTrainSkill(rHally, 'Attack')).toBe(false);
    expect(weaponSupportsTrainSkill(rHally, 'Strength')).toBe(true);
    expect(weaponSupportsTrainSkill(rScim, 'Attack')).toBe(true);

    const picked = selectProgressiveLoadout(
        'melee',
        [{ id: 3202, count: 1 }, { id: 1331, count: 1 }],
        { attack: 40, strength: 40 },
        [],
        { trainSkill: 'Attack' },
    );
    expect(picked.worn.weapon?.id).toBe(1331);
});

test('ranged loadout pairs best fast shortbow, compatible arrows, and dhide tiers with shop upgrades', () => {
    const stock = [
        { id: 841, count: 1 }, // Shortbow (tier 1)
        { id: 855, count: 1 }, // Yew longbow (tier 40, rate 6)
        { id: 857, count: 1 }, // Yew shortbow (tier 40, rate 4)
        { id: 882, count: 200 }, // Bronze arrow (tier 1)
        { id: 892, count: 200 }, // Rune arrow (tier 40)
        { id: 1169, count: 1 }, // Coif
        { id: 1135, count: 1 }, // Green d'hide body (Dragon Slayer + Ranged 40 + Def 40)
        { id: 1099, count: 1 }, // Green d'hide chaps (Ranged 40)
        { id: 1065, count: 1 }, // Green d'hide vambraces (Ranged 40)
        { id: 2577, count: 1 }, // Ranger boots (Ranged 40)
        { id: 1127, count: 1 }, // Rune platebody (-10 rangeAttack, should not wear for Ranged)
    ];

    const lv1 = selectProgressiveLoadout('ranged', stock, { ranged: 1, defence: 1 }, []);
    expect(lv1.worn.weapon?.id).toBe(841);
    expect(lv1.ammo?.id).toBe(882); // Cannot fire Rune arrows from Shortbow at Ranged 1
    expect(lv1.worn.shield).toBeNull();
    expect(lv1.worn.body).toBeNull();
    expect(lv1.upgrades.weapon?.nextUnlock?.item.id).toBe(843); // Oak shortbow at Ranged 5
    expect(lv1.upgrades.weapon?.nextUnlock?.shops.some(s => s.shop === 'archeryshop')).toBe(true);

    const lv40 = selectProgressiveLoadout('ranged', stock, { ranged: 40, defence: 40 }, ['Dragon Slayer']);
    expect(lv40.worn.weapon?.id).toBe(857); // Yew shortbow beats Yew longbow
    expect(lv40.ammo?.id).toBe(892);
    expect(lv40.worn.helm?.id).toBe(1169);
    expect(lv40.worn.body?.id).toBe(1135);
    expect(lv40.worn.legs?.id).toBe(1099);
    expect(lv40.worn.hands?.id).toBe(1065);
    expect(lv40.worn.feet?.id).toBe(2577);
    expect(lv40.upgrades.weapon?.acquirableUpgrade).toBeNull();
    expect(lv40.upgrades.weapon?.nextUnlock?.item.id).toBe(861); // Magic shortbow at Ranged 50
});

test('magic loadout avoids negative-magic melee armour and god cape/staff conflicts', () => {
    const stock = [
        { id: 1387, count: 1 }, // Staff of fire
        { id: 2417, count: 1 }, // Staff of zamorak
        { id: 2412, count: 1 }, // Cape of saradomin (conflicts with zamorak staff!)
        { id: 1007, count: 1 }, // Red cape
        { id: 579, count: 1 }, // Wizards hat
        { id: 577, count: 1 }, // Wizards robe
        { id: 3387, count: 1 }, // Splitbark body (Magic 40, Defence 40)
        { id: 3389, count: 1 }, // Splitbark legs (Magic 40, Defence 40)
        { id: 2579, count: 1 }, // Wizard's boots (Magic 20)
        { id: 1727, count: 1 }, // Amulet of magic
        { id: 1127, count: 1 }, // Rune platebody (-30 magic attack, never equip for magic)
        { id: 1201, count: 1 }, // Rune kiteshield (-8 magic attack, never equip for magic)
    ];

    const lv1 = selectProgressiveLoadout('magic', [{ id: 1387, count: 1 }, { id: 579, count: 1 }, { id: 577, count: 1 }, { id: 1127, count: 1 }, { id: 1201, count: 1 }, { id: 1727, count: 1 }], { magic: 1, defence: 40 }, ['Dragon Slayer']);
    expect(lv1.worn.weapon?.id).toBe(1387);
    expect(lv1.worn.helm?.id).toBe(579);
    expect(lv1.worn.body?.id).toBe(577);
    expect(lv1.worn.shield).toBeNull();
    expect(lv1.worn.amulet?.id).toBe(1727);

    const lv40 = selectProgressiveLoadout('magic', stock, { magic: 40, attack: 40, defence: 40 }, []);
    expect(lv40.worn.body?.id).toBe(3387);
    expect(lv40.worn.legs?.id).toBe(3389);
    expect(lv40.worn.feet?.id).toBe(2579);
    if (lv40.worn.weapon?.id === 2417) {
        expect(lv40.worn.cape?.id).not.toBe(2412);
    }
});

test('Woodcutting axes and Mining pickaxes distinguish use level, Attack wield level, and inventory carry mode', () => {
    // Rev-289 woodcutting uses Rune axe at Woodcutting 1, carried in inventory when Attack < 40, wielded at Attack >= 40.
    const wcLowAtt = bestWoodcuttingAxe([{ id: 1359, count: 1 }, { id: 1351, count: 1 }], { woodcutting: 1, attack: 1 });
    expect(wcLowAtt.current?.item.id).toBe(1359);
    expect(wcLowAtt.current?.canUse).toBe(true);
    expect(wcLowAtt.current?.canWield).toBe(false);
    expect(wcLowAtt.current?.wieldAttackLevel).toBe(40);
    expect(wcLowAtt.current?.carryMode).toBe('inventory');

    const wcHighAtt = bestWoodcuttingAxe([{ id: 1359, count: 1 }], { woodcutting: 1, attack: 40 });
    expect(wcHighAtt.current?.canWield).toBe(true);
    expect(wcHighAtt.current?.carryMode).toBe('wield');

    const wcEnforced = bestWoodcuttingAxe([{ id: 1359, count: 1 }, { id: 1353, count: 1 }], { woodcutting: 15, attack: 15 }, { enforceAxeLevel: true });
    expect(wcEnforced.current?.item.id).toBe(1353); // Black axe 1361 not owned, Steel 1353 usable at 6
    expect(wcEnforced.bestUsable?.item.id).toBe(1361); // Black axe usable at 11
    expect(wcEnforced.nextUnlock?.item.id).toBe(1355); // Mithril axe at 21

    // Mining pickaxes require Mining >= 41 for Rune pickaxe, even if Attack = 1 (inventory), or Attack >= 40 (wield).
    const mineSkiller = bestMiningPickaxe([{ id: 1275, count: 1 }, { id: 1265, count: 1 }], { mining: 41, attack: 1 });
    expect(mineSkiller.current?.item.id).toBe(1275);
    expect(mineSkiller.current?.useLevel).toBe(41);
    expect(mineSkiller.current?.wieldAttackLevel).toBe(40);
    expect(mineSkiller.current?.canUse).toBe(true);
    expect(mineSkiller.current?.canWield).toBe(false);
    expect(mineSkiller.current?.carryMode).toBe('inventory');

    const mine40 = bestMiningPickaxe([{ id: 1275, count: 1 }, { id: 1271, count: 1 }], { mining: 40, attack: 40 });
    expect(mine40.current?.item.id).toBe(1271); // Adamant usable at Mining 31
    expect(mine40.current?.canWield).toBe(true);
    expect(mine40.current?.carryMode).toBe('wield');
    expect(mine40.nextUnlock?.item.id).toBe(1275); // Rune unlocks at Mining 41
    expect(mine40.nextUnlock?.shops.some(s => s.shop === 'pickaxeshop')).toBe(true);
});

test('shopCatalog indexes rev-289 shops excluding skill guides and reports acquirable upgrades', () => {
    const shops = shopCatalog();
    expect(shops.get(1329)?.some(s => s.shop === 'scimitarshop')).toBe(true); // Mithril scimitar at Zeke
    expect(shops.get(1305)?.some(s => s.shop === 'dragonswordshop' && s.requiresQuest === 'Lost City')).toBe(true);
    expect(shops.get(1127)?.some(s => s.shop === 'runeplateshop' && s.requiresQuest === 'Dragon Slayer')).toBe(true);
    expect(shops.get(1359)?.some(s => s.shop === 'axeshop')).toBeUndefined(); // Bob sells up to steel axe; rune axe is smithed/dropped
    expect(shops.get(1353)?.some(s => s.shop === 'axeshop')).toBe(true);
    expect(shops.get(1275)?.some(s => s.shop === 'pickaxeshop')).toBe(true);

    const meleePlan = selectProgressiveLoadout('melee', [{ id: 1277, count: 1 }], { attack: 20, defence: 20 }, []);
    expect(meleePlan.upgrades.weapon?.acquirableUpgrade?.item.id).toBe(1329); // Mithril scimitar
    expect(meleePlan.upgrades.weapon?.acquirableUpgrade?.shops.some(s => s.shop === 'scimitarshop')).toBe(true);
    expect(meleePlan.upgrades.weapon?.nextUnlock?.item.id).toBe(1331); // Adamant scimitar at Attack 30
});

test('crossedTierBoundary detects melee tier thresholds 5, 10, 20, 30, 40, 60', () => {
    expect(crossedTierBoundary({ attack: 4, defence: 4 }, { attack: 4, defence: 4 })).toBe(false);
    expect(crossedTierBoundary({ attack: 4, defence: 1 }, { attack: 5, defence: 1 })).toBe(true);
    expect(crossedTierBoundary({ attack: 5, defence: 9 }, { attack: 5, defence: 10 })).toBe(true);
    expect(crossedTierBoundary({ attack: 19, defence: 10 }, { attack: 20, defence: 10 })).toBe(true);
    expect(crossedTierBoundary({ attack: 29, defence: 10 }, { attack: 30, defence: 10 })).toBe(true);
    expect(crossedTierBoundary({ attack: 39, defence: 10 }, { attack: 40, defence: 10 })).toBe(true);
    expect(crossedTierBoundary({ attack: 59, defence: 10 }, { attack: 60, defence: 10 })).toBe(true);
    expect(crossedTierBoundary({ attack: 41, defence: 41 }, { attack: 42, defence: 41 })).toBe(false);
});

test('ownedBestLoadout resolves optional slots and 2h vs 1h+shield tradeoffs cleanly', () => {
    const res = ownedBestLoadout([
        { key: 'weapon', optional: false, options: [{ id: 1319, count: 1, preference: 0, equippable: true, occupies: ['shield'] }, { id: 1277, count: 1, preference: 1000, equippable: true }] },
        { key: 'shield', optional: true, missPreference: 50, options: [{ id: 1171, count: 1, preference: 0, equippable: true }] },
    ], [{ id: 1319, count: 1 }, { id: 1277, count: 1 }, { id: 1171, count: 1 }]);
    expect(res.state).toBe('ready');
    expect(res.selected.map(s => s.id)).toEqual([1319]);
    expect(bestGearForSlot('melee', 'weapon', { attack: 40 }, [])[0]?.id).toBe(1333);
});
