import { expect, test } from 'bun:test';
import { ownedBestLoadout } from './owned-loadout';
import {
    ELEMENTAL_RUNES,
    SHOP_RESTOCK_COOLDOWN_TICKS,
    WOODCUTTING_AXES_DESC,
    bestElementalStaffForRunes,
    bestGearForSlot,
    bestMiningPickaxe,
    bestWoodcuttingAxe,
    canWearGear,
    crossedTierBoundary,
    executeShopToolPurchase,
    gearById,
    gearUnlockLevels,
    normalizeCompletedQuests,
    ownsWearableMeleeWeapon,
    planBankToolSwap,
    planToolShopUpgrade,
    reconcileBankTool,
    recordShopAttempt,
    selectProgressiveLoadout,
    sessionToolHooks,
    shopCatalog,
    shouldAttemptShopUpgrade,
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

test('bestElementalStaffForRunes recognizes battlestaves, gates members/stats, and prioritizes highest rune savings', () => {
    // Battlestaves (1391..1399, 3053) are magic weapons, never melee weapons.
    expect(bestGearForSlot('melee', 'weapon', { attack: 40 }, []).some(g => g.id === 1399 || g.id === 3053)).toBe(false);
    expect(bestGearForSlot('magic', 'weapon', { magic: 30, attack: 30 }, []).some(g => g.id === 1399)).toBe(true);

    // Curse (3 Earth + 2 Water) prefers Staff of earth (1385) over Staff of water (1383) and Staff of air (1381).
    const curseRunes = [
        ELEMENTAL_RUNES.earth,
        ELEMENTAL_RUNES.earth,
        ELEMENTAL_RUNES.earth,
        ELEMENTAL_RUNES.water,
        ELEMENTAL_RUNES.water,
    ];
    const staffMix = [
        { id: 1381, count: 1 }, // Air
        { id: 1383, count: 1 }, // Water
        { id: 1385, count: 1 }, // Earth
        { id: 1399, count: 1 }, // Earth battlestaff (Magic 30 / Attack 30)
        { id: 1407, count: 1 }, // Mystic earth staff (Magic 40 / Attack 40)
    ];

    const low = bestElementalStaffForRunes(staffMix, { magic: 19, attack: 1 }, [], { runeIds: curseRunes });
    expect(low.current?.item.id).toBe(1385);
    expect(low.current?.providedRunes).toEqual([557]);
    expect(low.nextUnlock?.id).toBe(1399);

    const mid = bestElementalStaffForRunes(staffMix, { magic: 35, attack: 30 }, [], { runeIds: curseRunes });
    expect(mid.current?.item.id).toBe(1399);
    expect(mid.nextUnlock?.id).toBe(1407);

    const high = bestElementalStaffForRunes(staffMix, { magic: 40, attack: 40 }, [], { runeIds: curseRunes });
    expect(high.current?.item.id).toBe(1407);

    // F2P restriction skips Mystic/Battlestaves cleanly.
    const f2p = bestElementalStaffForRunes(staffMix, { magic: 40, attack: 40 }, [], { runeIds: curseRunes, members: false });
    expect(f2p.current?.item.id).toBe(1385);

    // Dual Fire + Earth runes select Mystic lava staff (3054) over single-element staves.
    const lava = bestElementalStaffForRunes(
        [{ id: 1385, count: 1 }, { id: 1387, count: 1 }, { id: 3054, count: 1 }],
        { magic: 40, attack: 40 },
        [],
        { runeIds: [ELEMENTAL_RUNES.fire, ELEMENTAL_RUNES.earth] },
    );
    expect(lava.current?.item.id).toBe(3054);
    expect(lava.current?.providedRunes).toEqual([554, 557]);
});

test('planToolShopUpgrade recommends Bob axes, Nurmof pickaxes, and Zaff elemental staffs within coin budget', () => {
    // Bob's Axes (axeshop): Steel axe costs 200 (250 buffered), Iron axe costs 56 (70 buffered).
    const axeSteel = planToolShopUpgrade('woodcutting-axe', [{ id: 1351, count: 1 }], 300, { woodcutting: 1, attack: 1 }, { allowedShops: ['axeshop'] });
    expect(axeSteel?.target.id).toBe(1353);
    expect(axeSteel?.shop.shop).toBe('axeshop');

    const axeIron = planToolShopUpgrade('woodcutting-axe', [{ id: 1351, count: 1 }], 100, { woodcutting: 1, attack: 1 }, { allowedShops: ['axeshop'] });
    expect(axeIron?.target.id).toBe(1349);

    expect(planToolShopUpgrade('woodcutting-axe', [{ id: 1353, count: 1 }], 10000, { woodcutting: 20, attack: 20 }, { allowedShops: ['axeshop'] })).toBeNull();

    // Nurmof's Pickaxe Shop (pickaxeshop): recommends best usable within Mining requirement and coins.
    const pick21 = planToolShopUpgrade('mining-pickaxe', [{ id: 1265, count: 1 }], 2000, { mining: 21, attack: 1 }, { allowedShops: ['pickaxeshop'] });
    expect(pick21?.target.id).toBe(1273); // Mithril pickaxe (cost 1300 -> budget 1625 <= 2000)

    const pick41 = planToolShopUpgrade('mining-pickaxe', [{ id: 1271, count: 1 }], 50000, { mining: 41, attack: 40 }, { allowedShops: ['pickaxeshop'] });
    expect(pick41?.target.id).toBe(1275); // Rune pickaxe (cost 32000 -> budget 40000 <= 50000)
    expect(planToolShopUpgrade('mining-pickaxe', [{ id: 1271, count: 1 }], 50000, { mining: 41, attack: 40 }, { allowedShops: ['pickaxeshop'], onlyWhenStarterOrMissing: true })).toBeNull();

    // Zaff's Staff Shop (staffshop): recommends Staff of earth for Curse when missing covering staff and funded.
    const zaffEarth = planToolShopUpgrade('magic-staff', [], 2500, { magic: 19, attack: 1 }, {
        allowedShops: ['staffshop'],
        runeIds: [ELEMENTAL_RUNES.earth, ELEMENTAL_RUNES.earth, ELEMENTAL_RUNES.water],
    });
    expect(zaffEarth?.target.id).toBe(1385);
    expect(zaffEarth?.shop.shop).toBe('staffshop');
    expect(planToolShopUpgrade('magic-staff', [{ id: 1385, count: 1 }], 5000, { magic: 19, attack: 1 }, {
        allowedShops: ['staffshop'],
        runeIds: [ELEMENTAL_RUNES.earth],
        onlyWhenStarterOrMissing: true,
    })).toBeNull();
});

test('planBankToolSwap and reconcileBankTool withdraw, equip when Attack allows, and deposit inferior tools cleanly', async () => {
    let bankOpen = true;
    let gen = 1;
    const bank: { id: number; name: string; count: number; slot?: number }[] = [
        { id: 1359, name: 'Rune axe', count: 1, slot: 0 },
    ];
    const inv: { id: number; name: string; count: number; slot?: number }[] = [
        { id: 1351, name: 'Bronze axe', count: 1, slot: 0 },
    ];
    const eq: { id: number; name: string; count: number; slot: number }[] = [];

    const hooks = {
        openBank: async () => { bankOpen = true; gen++; },
        closeBank: async () => { bankOpen = false; },
        withdrawItem: async (item: { id: number; name: string; count: number }, count: number) => {
            const b = bank.find(r => r.id === item.id)!;
            b.count -= count;
            if (b.count <= 0) bank.splice(bank.indexOf(b), 1);
            inv.push({ id: item.id, name: item.name, count });
            gen++;
        },
        depositItem: async (item: { id: number; name: string; count: number }) => {
            const idx = inv.findIndex(r => r.id === item.id);
            const [removed] = inv.splice(idx, 1);
            const existing = bank.find(r => r.id === removed!.id);
            if (existing) existing.count += removed!.count;
            else bank.push({ id: removed!.id, name: removed!.name, count: removed!.count });
            gen++;
        },
        equipItem: async (item: { id: number; name: string; count: number }) => {
            const idx = inv.findIndex(r => r.id === item.id);
            const [removed] = inv.splice(idx, 1);
            eq.push({ ...removed!, slot: 3 });
        },
        getInventory: () => inv,
        getEquipment: () => eq,
        getBankState: () => ({ isOpen: bankOpen, items: bank }),
        getBankGeneration: () => bankOpen ? gen : undefined,
        waitUntil: async (pred: () => boolean) => pred(),
    };

    // Attack 1 carries Rune axe in inventory and banks Bronze axe.
    const lowSwap = planBankToolSwap({
        targetId: 1359,
        canWield: false,
        inventory: inv,
        equipment: eq,
        bank,
        toolGroupIds: WOODCUTTING_AXES_DESC,
    });
    expect(lowSwap).toEqual({
        targetId: 1359,
        withdrawFromBank: true,
        equipInWeaponSlot: false,
        depositInventoryIds: [1351],
        alreadyActive: false,
    });

    const lowRes = await reconcileBankTool(hooks, { targetId: 1359, canWield: false, toolGroupIds: WOODCUTTING_AXES_DESC });
    expect(lowRes).toEqual({ activeId: 1359, worn: false, changed: true });
    expect(inv.map(i => i.id)).toEqual([1359]);
    expect(bank.map(i => i.id)).toEqual([1351]);

    // Attack 40 equips the carried Rune axe into slot 3 without needing another withdrawal.
    const highRes = await reconcileBankTool(hooks, { targetId: 1359, canWield: true, toolGroupIds: WOODCUTTING_AXES_DESC });
    expect(highRes).toEqual({ activeId: 1359, worn: true, changed: true });
    expect(eq[0]?.id).toBe(1359);
    expect(inv).toHaveLength(0);
    expect(bank.map(i => i.id)).toEqual([1351]);
});

test('executeShopToolPurchase withdraws coins, buys upgraded tool cleanly, and reconciles spent coins', async () => {
    let bankOpen = true;
    let shopOpen = false;
    let gen = 1;
    const bank: { id: number; name: string; count: number; slot?: number }[] = [
        { id: 995, name: 'Coins', count: 2000, slot: 0 },
    ];
    const inv: { id: number; name: string; count: number; slot?: number }[] = [];
    const shopItems = [{ id: 1385, name: 'Staff of earth', count: 2, buyPrice: 1500, slot: 0 }];
    const walks: string[] = [];

    const hooks = {
        openBank: async () => { bankOpen = true; gen++; },
        closeBank: async () => { bankOpen = false; },
        withdrawItem: async (item: { id: number; name: string; count: number }, count: number) => {
            const b = bank.find(r => r.id === item.id)!;
            b.count -= count;
            inv.push({ id: item.id, name: item.name, count });
            gen++;
        },
        depositItem: async () => undefined,
        getInventory: () => inv,
        getEquipment: () => [],
        getBankState: () => ({ isOpen: bankOpen, items: bank }),
        getBankGeneration: () => bankOpen ? gen : undefined,
        walkTo: async (spot: { x: number; z: number }) => { walks.push(`${spot.x},${spot.z}`); return true; },
        openShop: async () => { shopOpen = true; return { success: true }; },
        buyFromShop: async (row: any, n: number) => {
            row.count -= n;
            const c = inv.find(i => i.id === 995)!;
            c.count -= row.buyPrice! * n;
            inv.push({ id: row.id, name: row.name, count: n });
            return { success: true };
        },
        closeShop: async () => { shopOpen = false; },
        getShopState: () => ({ isOpen: shopOpen, shopItems }),
        waitUntil: async (pred: () => boolean) => pred(),
    };

    const res = await executeShopToolPurchase(hooks, {
        targetId: 1385,
        shop: 'staffshop',
        maxBudget: 1875,
        returnBankSpot: { x: 3185, z: 3436 },
    });
    expect(res).toEqual({ bought: true, id: 1385, coinsSpent: 1500 });
    expect(walks).toEqual(['3203,3433', '3185,3436']);
    expect(bank.find(i => i.id === 995)?.count).toBe(125);
    expect(inv.find(i => i.id === 995)?.count).toBe(375);
    expect(inv.find(i => i.id === 1385)?.count).toBe(1);
});

test('executeShopToolPurchase closes shop, walks back to bank, and re-deposits withdrawn coins when stock absent or shop fails', async () => {
    for (const mode of ['empty-stock', 'shop-refused', 'walk-failed'] as const) {
        let bankOpen = true;
        let shopOpen = false;
        let gen = 1;
        const bank: { id: number; name: string; count: number; slot?: number }[] = [
            { id: 995, name: 'Coins', count: 2000, slot: 0 },
        ];
        const inv: { id: number; name: string; count: number; slot?: number }[] = [];
        const walks: string[] = [];

        const hooks = {
            openBank: async () => { bankOpen = true; gen++; },
            closeBank: async () => { bankOpen = false; },
            withdrawItem: async (item: { id: number; name: string; count: number }, count: number) => {
                const b = bank.find(r => r.id === item.id)!;
                b.count -= count;
                inv.push({ id: item.id, name: item.name, count, slot: 0 });
                gen++;
            },
            depositItem: async (item: { id: number; name: string; count: number }, count: number) => {
                const amt = count === -1 ? item.count : count;
                const idx = inv.findIndex(r => r.id === item.id);
                if (idx >= 0) {
                    inv[idx]!.count -= amt;
                    if (inv[idx]!.count <= 0) inv.splice(idx, 1);
                }
                const b = bank.find(r => r.id === item.id);
                if (b) b.count += amt;
                else bank.push({ id: item.id, name: item.name, count: amt, slot: 0 });
                gen++;
            },
            getInventory: () => inv,
            getEquipment: () => [],
            getBankState: () => ({ isOpen: bankOpen, items: bank }),
            getBankGeneration: () => bankOpen ? gen : undefined,
            walkTo: async (spot: { x: number; z: number }) => {
                walks.push(`${spot.x},${spot.z}`);
                if (mode === 'walk-failed' && spot.x === 2998) return false;
                return true;
            },
            openShop: async () => {
                if (mode === 'shop-refused') return { success: false, message: 'busy' };
                shopOpen = true;
                return { success: true };
            },
            buyFromShop: async () => ({ success: false }),
            closeShop: async () => { shopOpen = false; },
            getShopState: () => ({ isOpen: shopOpen, shopItems: [{ id: 1275, name: 'Rune pickaxe', count: 0, buyPrice: 32000, slot: 0 }] }),
            waitUntil: async (pred: () => boolean) => pred(),
        };

        const res = await executeShopToolPurchase(hooks, {
            targetId: 1275,
            shop: 'pickaxeshop',
            maxBudget: 1500,
            returnBankSpot: { x: 3013, z: 3355 },
        });
        expect(res.bought).toBe(false);
        expect(res.coinsSpent).toBe(0);
        expect(shopOpen).toBe(false);
        expect(walks).toEqual(['2998,9844', '3013,3355']);
        expect(bank.find(i => i.id === 995)?.count).toBe(2000);
        expect(inv.filter(i => i.id === 995)).toHaveLength(0);
    }
});

test('shouldAttemptShopUpgrade gates repeat checks per tier and cools down failed shelf walks for 700 ticks', () => {
    const gate: { checkedTier?: number; failedAt?: { tier: number; tick: number } } = {};
    expect(shouldAttemptShopUpgrade(gate, 21, 100)).toBe(true);

    recordShopAttempt(gate, 21, 100, false);
    expect(shouldAttemptShopUpgrade(gate, 21, 101)).toBe(false);
    expect(shouldAttemptShopUpgrade(gate, 21, 100 + SHOP_RESTOCK_COOLDOWN_TICKS - 1)).toBe(false);
    expect(shouldAttemptShopUpgrade(gate, 31, 150)).toBe(true);
    expect(shouldAttemptShopUpgrade(gate, 21, 100 + SHOP_RESTOCK_COOLDOWN_TICKS)).toBe(true);

    recordShopAttempt(gate, 31, 820, true);
    expect(shouldAttemptShopUpgrade(gate, 31, 2000)).toBe(false);
    expect(shouldAttemptShopUpgrade(gate, 41, 2000)).toBe(true);
});

test('a thrown stack is counted and compared with the bow by damage per rapid tick', () => {
    // Shortbow and iron arrows, with black knives (Ranged 10): five knives are not a run's worth of ammunition, 300 are.
    const bow = [{ id: 841, count: 1 }, { id: 884, count: 300 }];
    const few = selectProgressiveLoadout('ranged', [...bow, { id: 869, count: 5 }], { ranged: 10 });
    expect(few.worn.weapon?.debugname).toBe('shortbow');
    expect(few.ammo?.debugname).toBe('iron_arrow');
    expect(few.thrown).toBe(false);
    const many = selectProgressiveLoadout('ranged', [...bow, { id: 869, count: 300 }], { ranged: 10 });
    expect(many.worn.weapon?.debugname).toBe('black_knife');
    expect(many.thrown).toBe(true);
    expect(many.ammo).toBeNull();
    expect(many.ammoCount).toBe(300);
    // A worker that counts its shots by arrows keeps thrown weapons out.
    expect(selectProgressiveLoadout('ranged', [...bow, { id: 869, count: 300 }], { ranged: 10 }, null, { thrown: false }).worn.weapon?.debugname).toBe('shortbow');
});

test('arrows need a run of ammunition: three rune arrows never displace 300 mithril arrows', () => {
    const stock = [{ id: 857, count: 1 }, { id: 892, count: 3 }, { id: 888, count: 300 }];
    const loadout = selectProgressiveLoadout('ranged', stock, { ranged: 45 });
    expect(loadout.ammo?.debugname).toBe('mithril_arrow');
    expect(loadout.ammoCount).toBe(300);
    // With no kind that reaches a run's worth, the largest stack is worn.
    expect(selectProgressiveLoadout('ranged', [{ id: 857, count: 1 }, { id: 892, count: 3 }, { id: 888, count: 20 }], { ranged: 45 }).ammo?.debugname).toBe('mithril_arrow');
    // A run's worth of the better kind wins.
    expect(selectProgressiveLoadout('ranged', [{ id: 857, count: 1 }, { id: 892, count: 60 }, { id: 888, count: 300 }], { ranged: 45 }).ammo?.debugname).toBe('rune_arrow');
});

test('unlock levels come from the item data: Defence 45, Attack 50, Strength 15 and 50, Ranged 50 and 70', () => {
    const none = { attack: 1, strength: 1, defence: 1, ranged: 1 };
    expect(crossedTierBoundary({ defence: 44 }, { defence: 45 })).toBe(true);
    expect(crossedTierBoundary({ attack: 49 }, { attack: 50 })).toBe(true);
    expect(crossedTierBoundary({ strength: 14 }, { strength: 15 })).toBe(true);
    expect(crossedTierBoundary({ strength: 49 }, { strength: 50 })).toBe(true);
    expect(crossedTierBoundary({ ranged: 49 }, { ranged: 50 }, ['ranged'])).toBe(true);
    expect(crossedTierBoundary({ ranged: 69 }, { ranged: 70 }, ['ranged'])).toBe(true);
    expect(crossedTierBoundary({ ranged: 69 }, { ranged: 70 }, ['ranged'], 'melee')).toBe(true);
    // A level that unlocks nothing is not a boundary.
    expect(crossedTierBoundary({ defence: 46 }, { defence: 47 })).toBe(false);
    expect(crossedTierBoundary({ ranged: 51 }, { ranged: 52 }, ['ranged'])).toBe(false);
    expect(crossedTierBoundary(none, none)).toBe(false);
    expect(gearUnlockLevels('ranged').ranged).toEqual(expect.arrayContaining([5, 20, 30, 40, 50, 70]));
    expect(gearUnlockLevels('melee').defence).toEqual(expect.arrayContaining([5, 10, 20, 30, 40, 45, 50, 60]));
    // Tools: the Attack level to wield and the use level of each pickaxe.
    expect(gearUnlockLevels('mining-pickaxe')).toMatchObject({ attack: [5, 20, 30, 40], mining: [6, 21, 31, 41] });
});

test('a quest-point shop opens at its quest points, not never', () => {
    const levels = { attack: 40, strength: 40, defence: 40, hitpoints: 40 };
    const shops = (questPoints: number) => selectProgressiveLoadout('melee', [], levels, [], { questPoints }).upgrades.body?.acquirableUpgrade?.shops.map(s => s.shop) ?? [];
    expect(shops(31)).not.toContain('runiteshop');
    expect(shops(32)).toContain('runiteshop');
    expect(shops(0)).not.toContain('runiteshop');
});

test('acquirableUpgrade names only an item with an open shop or a trade', () => {
    for (const [style, levels] of [['melee', { attack: 99, strength: 99, defence: 99 }], ['ranged', { ranged: 99, defence: 99 }], ['magic', { magic: 99, defence: 99 }]] as const) {
        const loadout = selectProgressiveLoadout(style, [], levels, ['Dragon Slayer', "Legends' Quest", "Heroes' Quest", 'The Fremennik Trials', 'Regicide', 'Lost City']);
        for (const upgrade of Object.values(loadout.upgrades)) {
            const wanted = upgrade?.acquirableUpgrade;
            if (wanted) expect(wanted.tradeable || wanted.shops.length > 0).toBe(true);
        }
    }
});

test('ownsWearableMeleeWeapon answers by item name or id and honours the wield level', () => {
    expect(ownsWearableMeleeWeapon({ 'bronze sword': 1 })).toBe(true);
    expect(ownsWearableMeleeWeapon({ 1277: 1 })).toBe(true);
    expect(ownsWearableMeleeWeapon({ 'Rune scimitar': 1 }, { attack: 30 })).toBe(false);
    expect(ownsWearableMeleeWeapon({ 'Rune scimitar': 1 }, { attack: 40 })).toBe(true);
    expect(ownsWearableMeleeWeapon({ 'wooden shield': 1, trout: 9 })).toBe(false);
    expect(ownsWearableMeleeWeapon({ 'bronze sword': 0 })).toBe(false);
    expect(ownsWearableMeleeWeapon([{ id: 1277, count: 1 }])).toBe(true);
});

test('sessionToolHooks withdraws a bank-observation row through the open bank row that has a slot', async () => {
    const calls: unknown[] = [];
    const bankRow = { id: 1275, name: 'Rune pickaxe', count: 1, slot: 7 };
    const hooks = sessionToolHooks({
        sdk: { getState: () => ({ bank: { isOpen: true, items: [bankRow] } }), getInventory: () => [] },
        bot: {
            openBank: async () => ({}), closeBank: async () => ({}), depositItem: async () => ({}),
            withdrawItem: async (item: unknown) => { calls.push(item); return {}; },
            openShop: async () => ({ success: true }), buyFromShop: async () => ({ success: true }), closeShop: async () => ({}),
        },
    }, { waitUntil: async () => true });
    await hooks.withdrawItem({ id: 1275, name: 'Rune pickaxe', count: 1 }, 1);
    expect(calls).toEqual([bankRow]);
});
