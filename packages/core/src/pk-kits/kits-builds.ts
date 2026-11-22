// Pure, trained account build, low-combat, rival gang, and skiller target kit definitions.
import { SPELLS } from '../pk-types';
import { BOOSTS, DEF_TRIBRID, FREEZE, PRAYER_POTS, PURE, PURE_RANGE, WAVE, trained, type KitSpec } from './model';

export const BUILD_KITS: Readonly<Record<string, KitSpec>> = {
    // Pures. Each level is the lowest that wields the weapon or casts the spell, and a second style stays under the
    // combat level of the first (research/pvp-fight-loop.md, "Pure builds").
    // Combat 27: Iban Blast (Magic 50 and Attack 50 for the staff, max hit 25; 1 death and 5 fire runes and 2 staff
    // charges a cast, varp 288) with a magic shortbow (Ranged 50). Underground Pass gives Attack 61. A kit for the
    // comparison only (`noRoute`).
    'pure-iban': { worn: { weapon: 'ibanstaff', amulet: 'amulet_of_magic', feet: 'leather_boots', ammo: ['rune_arrow', 100] },
        carried: ['magic_shortbow', ['deathrune', 100], ['firerune', 500]], food: 20, foodItem: 'lobster',
        switches: { magic: ['ibanstaff'], ranged: ['magic_shortbow'] }, options: { rotation: ['magic', 'ranged'], damageSpell: SPELLS.ibanBlast },
        skills: { ...PURE, Attack: 61, Ranged: 50, Magic: 50 }, varps: { 288: 120 },
        noRoute: 'the fights of Underground Pass give 53,400 XP and 17,690 Hitpoints XP: the kit has no skill at 99 for them, and Hitpoints 10 end at 42' },
    // Combat 46, the highest that can attack combat 3 at the rune rocks (Wilderness level 46): dragon dagger special
    // (Attack 61, Strength 73) with Flames of Zamorak under Charge (Magic 80, max hit 30) and Entangle (79). A kit for
    // the comparison only (`noRoute`): with the Prayer 37 that the Mage Arena needs it is combat 50.
    'pure-rock': { worn: { weapon: 'dragon_dagger_p', cape: 'zamorak_cape', amulet: 'amulet_of_strength', feet: 'leather_boots' },
        carried: ['zamorak_staff', ['firerune', 400], ['airrune', 500], ['bloodrune', 100], ...FREEZE, '4dose2strength'], food: 16, foodItem: 'lobster',
        switches: { magic: ['zamorak_staff'], melee: ['dragon_dagger_p'] }, options: { rotation: ['magic', 'melee'], damageSpell: SPELLS.flamesOfZamorak, charge: true },
        skills: { ...PURE, Attack: 61, Strength: 73, Magic: 80 }, varps: { 267: 8, 270: 99 },
        noRoute: 'the Mage Arena needs Prayer 37: with Prayer 1 and Hitpoints 10 a practice run died to Kolodion, whose spells hit up to 20' },
    // Combat 19: Fire Bolt (Magic 35, max hit 12) and nothing else.
    'pure-bolt': { worn: { weapon: 'staff_of_fire', amulet: 'amulet_of_magic', feet: 'leather_boots' },
        carried: [['airrune', 500], ['chaosrune', 200]], food: 20, foodItem: 'lobster',
        switches: { magic: ['staff_of_fire'] }, options: { rotation: ['magic'] }, skills: { ...PURE, Magic: 35 } },
    // Trained builds (research/pvp-fight-loop.md, "Account builds"). Each has the levels that name the build and the
    // Hitpoints that the training gives (`trained`). Ranged 99 and Magic 99 add no combat level to a build with
    // Attack 60 and Strength 99, so the melee builds carry them.
    // Defence 1. The dagger alone, with the two melee potions.
    'pure-dds': { worn: { weapon: 'dragon_dagger_p', amulet: 'amulet_of_strength', cape: 'black_cape', feet: 'death_climbingboots' },
        carried: ['4dose2attack', '4dose2strength'], food: 25, switches: { melee: ['dragon_dagger_p'] }, options: { rotation: ['melee'] },
        skills: trained({ Attack: 60, Strength: 99 }) },
    // The bow for damage and a melee weapon for the kill: the dagger special, a rune two-handed sword (Attack 40,
    // strength bonus 70, one hit each 7 ticks) or a dragon halberd (strength bonus 89, Regicide done). Regicide needs
    // Underground Pass, which gives Attack 61, so the halberd build has Attack 61. It has Prayer 43 and Magic 54 too: a
    // Defence 1 account with no protect prayer dies in both quests, and Regicide casts the Falador and Ardougne
    // teleports (Magic 51). Magic 54 adds no combat level under Attack 61 and Strength 99.
    'pure-dds-msb': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_dagger_p', ...BOOSTS], food: 23, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 60, Strength: 99, Ranged: 99 }) },
    'pure-r2h': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['rune_2h_sword', ...BOOSTS], food: 23, switches: { ranged: ['magic_shortbow'], melee: ['rune_2h_sword'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 40, Strength: 99, Ranged: 99 }) },
    'pure-hally': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_halberd', ...BOOSTS, ...PRAYER_POTS], food: 21, switches: { ranged: ['magic_shortbow'], melee: ['dragon_halberd'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 61, Strength: 99, Ranged: 99, Magic: 54, Prayer: 43 }), varps: { 328: 15 } },
    // One style from range.
    'pure-ranger': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 500] },
        carried: ['4doserangerspotion'], food: 26, switches: { ranged: ['magic_shortbow'] }, options: { rotation: ['ranged'] }, skills: trained({ Ranged: 99 }) },
    'pure-mage': { worn: { weapon: 'staff_of_fire', amulet: 'amulet_of_magic', cape: 'black_cape', feet: 'leather_boots' },
        carried: [...WAVE, ...FREEZE], food: 22, switches: { magic: ['staff_of_fire'] }, options: { rotation: ['magic'] }, skills: trained({ Magic: 99 }) },
    // All three styles at Defence 1.
    'pure-tribrid': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_dagger_p', 'staff_of_fire', ...WAVE, ...FREEZE, ...BOOSTS], food: 17,
        switches: { magic: ['staff_of_fire'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, skills: trained({ Attack: 60, Strength: 99, Ranged: 99, Magic: 99 }) },
    // The bow and dagger pure with Prayer 43: the three protect prayers and the 15% prayers, for 5 combat levels.
    'pure-pray': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_dagger_p', ...BOOSTS, ...PRAYER_POTS], food: 21, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 60, Strength: 99, Ranged: 99, Prayer: 43 }) },
    // The tribrid's kit at a lower Defence: 40 for rune armour, 60 for the dragon helm, chainbody and legs, 60 for the
    // Berserker helm. Each build wears only what its quest route allows (`kitRoute`): Dragon Slayer gives Defence 88,
    // so no build under that wears the rune platebody (the body is black dragonhide, or the dragon chainbody), and
    // none carries the dragon square shield, because Legends' Quest needs Heroes' Quest and Dragon Slayer. The
    // Fremennik Trials give Attack, Strength and Defence 60 from level 1, so the Berserker helm build has Defence 60:
    // `zerker` is `dragon` with that helm.
    'rune-pure': { ...DEF_TRIBRID, worn: { ...DEF_TRIBRID.worn, torso: 'black_dragonhide_body' },
        skills: trained({ Attack: 60, Strength: 99, Defence: 40, Ranged: 99, Magic: 99, Prayer: 43 }) },
    zerker: { ...DEF_TRIBRID, worn: { ...DEF_TRIBRID.worn, hat: 'viking_helmet_crush', torso: 'dragon_chainbody', legs: 'dragon_platelegs' },
        skills: trained({ Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }), varps: { 347: 10 } },
    dragon: { ...DEF_TRIBRID, worn: { ...DEF_TRIBRID.worn, hat: 'dragon_med_helm', torso: 'dragon_chainbody', legs: 'dragon_platelegs' },
        skills: trained({ Attack: 60, Strength: 99, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43 }) },
    // Defence 60 with no melee weapon: black dragonhide and the Archer helm with a bow and Fire Wave, or splitbark
    // with Fire Wave alone. The Archer helm needs The Fremennik Trials, which give Attack 60 and Strength 60; the two
    // levels add no combat level under Ranged 99.
    // with Fire Wave alone.
    'range-tank': { worn: { hat: 'viking_helmet_range', torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', hands: 'black_dragon_vambraces', cape: 'black_cape', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'magic_shortbow', ammo: ['rune_arrow', 400] },
        carried: ['staff_of_fire', ...WAVE, ...FREEZE, ...PRAYER_POTS, '4doserangerspotion'], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['magic_shortbow'] }, options: { rotation: ['ranged', 'magic'] },
        skills: trained({ Attack: 74, Strength: 73, Defence: 60, Ranged: 99, Magic: 99, Prayer: 43, Hitpoints: 94 }), varps: { 347: 10 } },
    'mage-tank': { worn: { hat: 'splitbark_helm', torso: 'splitbark_body', legs: 'splitbark_legs', hands: 'splitbark_gauntlets', cape: 'black_cape', amulet: 'amulet_of_glory_4', weapon: 'staff_of_fire' },
        carried: [...WAVE, ...FREEZE, ...PRAYER_POTS], food: 20, switches: { magic: ['staff_of_fire'] }, options: { rotation: ['magic'] },
        skills: trained({ Defence: 60, Magic: 99, Prayer: 43 }) },
    // More builds of the same lists (research/pvp-fight-loop.md, "Account builds", second set).
    // Defence 1 with another melee weapon beside the bow: the rune scimitar (Attack 40, one hit each 4 ticks) and the
    // dragon longsword (Attack 60 and Lost City; special 125% damage). The dragon mace needs Heroes' Quest, which
    // gives Defence XP, so no pure wields it.
    'pure-scim': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['rune_scimitar', ...BOOSTS], food: 23, switches: { ranged: ['magic_shortbow'], melee: ['rune_scimitar'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 40, Strength: 99, Ranged: 99 }) },
    'pure-dlong': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_longsword', ...BOOSTS], food: 23, switches: { ranged: ['magic_shortbow'], melee: ['dragon_longsword'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 60, Strength: 99, Ranged: 99 }) },
    // Rune knives (Ranged 40) in place of the bow: a thrown weapon with a short attack time.
    'pure-knives': { worn: { ...PURE_RANGE, weapon: 'rune_knife', weaponCount: 500 },
        carried: ['dragon_dagger_p', ...BOOSTS], food: 23, switches: { ranged: ['rune_knife'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 60, Strength: 99, Ranged: 99 }) },
    // Prayer 31 for Ultimate Strength and no protect prayer: 3 combat levels over the bow and dagger pure.
    'pure-pray31': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_dagger_p', ...BOOSTS, '4doseprayerrestore'], food: 22, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 60, Strength: 99, Ranged: 99, Prayer: 31 }) },
    // The magic pure with a god spell: Flames of Zamorak under Charge (max hit 30) with the Mage Arena done. Prayer 37
    // for Protect from Magic: with Prayer 1 the arena passed at 1 seed of 4 (research/pvp-fight-loop.md, "Quest
    // routes of the builds").
    'pure-god': { worn: { weapon: 'zamorak_staff', cape: 'zamorak_cape', amulet: 'amulet_of_magic', feet: 'leather_boots' },
        carried: [['firerune', 600], ['airrune', 500], ['bloodrune', 300], ...FREEZE], food: 21,
        switches: { magic: ['zamorak_staff'] }, options: { rotation: ['magic'], damageSpell: SPELLS.flamesOfZamorak, charge: true },
        skills: trained({ Magic: 99, Prayer: 37 }), varps: { 267: 8, 270: 99 } },
    // Defence 1 with Attack 99: the bow and dagger pure with Prayer 43 at the combat level of the Defence 45 builds.
    'pure-max': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['dragon_dagger_p', ...BOOSTS, ...PRAYER_POTS], food: 21, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 99, Strength: 99, Ranged: 99, Prayer: 43 }) },
    // The tribrid's kit at Defence 30 in adamant armour, and at Defence 50 with the granite shield (Strength 50;
    // ranged defence 65). The Fremennik helms need a quest that gives Defence 60, so Defence 50 keeps the rune helm.
    'addy-pure': { ...DEF_TRIBRID, worn: { ...DEF_TRIBRID.worn, hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', shield: 'adamant_kiteshield' },
        switches: { ...DEF_TRIBRID.switches, melee: ['dragon_dagger_p', 'adamant_kiteshield'] },
        skills: trained({ Attack: 60, Strength: 99, Defence: 30, Ranged: 99, Magic: 99, Prayer: 43 }) },
    def50: { ...DEF_TRIBRID, worn: { ...DEF_TRIBRID.worn, torso: 'black_dragonhide_body', shield: 'granite_shield' },
        switches: { ...DEF_TRIBRID.switches, melee: ['dragon_dagger_p', 'granite_shield'] },
        skills: trained({ Attack: 60, Strength: 99, Defence: 50, Ranged: 99, Magic: 99, Prayer: 43 }) },
    // The range tank with Defence 99.
    'tank-range': { worn: { hat: 'viking_helmet_range', torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', hands: 'black_dragon_vambraces', cape: 'black_cape', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'magic_shortbow', ammo: ['rune_arrow', 400] },
        carried: ['staff_of_fire', ...WAVE, ...FREEZE, ...PRAYER_POTS, '4doserangerspotion'], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['magic_shortbow'] }, options: { rotation: ['ranged', 'magic'] },
        skills: trained({ Attack: 74, Strength: 73, Defence: 99, Ranged: 99, Magic: 99, Prayer: 43 }), varps: { 347: 10 } },
    // Low combat levels: the levels of the free-to-play lists at Strength, Ranged and Magic 70.
    'baby-pure': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 300] },
        carried: ['rune_scimitar', ...BOOSTS], food: 23, foodItem: 'lobster', switches: { ranged: ['magic_shortbow'], melee: ['rune_scimitar'] }, options: { rotation: ['ranged', 'melee'] },
        skills: trained({ Attack: 40, Strength: 70, Ranged: 70 }) },
    'low-ranger': { worn: { ...PURE_RANGE, weapon: 'magic_shortbow', ammo: ['rune_arrow', 500] },
        carried: ['4doserangerspotion'], food: 26, foodItem: 'lobster', switches: { ranged: ['magic_shortbow'] }, options: { rotation: ['ranged'] }, skills: trained({ Ranged: 70 }) },
    // Fire Blast (Magic 59, max hit 16).
    'low-mage': { worn: { weapon: 'staff_of_fire', amulet: 'amulet_of_magic', cape: 'black_cape', feet: 'leather_boots' },
        carried: [['airrune', 600], ['deathrune', 200], ...FREEZE], food: 22, foodItem: 'lobster',
        switches: { magic: ['staff_of_fire'] }, options: { rotation: ['magic'], damageSpell: SPELLS.fireBlast }, skills: trained({ Magic: 59 }) },
    'low-addy': { worn: { hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', feet: 'leather_boots', weapon: 'rune_scimitar', shield: 'adamant_kiteshield', ammo: ['adamant_arrow', 300] },
        carried: ['staff_of_fire', 'maple_shortbow', ['airrune', 600], ['deathrune', 200], ...FREEZE], food: 19, foodItem: 'lobster',
        switches: { magic: ['staff_of_fire'], ranged: ['maple_shortbow'], melee: ['rune_scimitar', 'adamant_kiteshield'] }, options: { damageSpell: SPELLS.fireBlast },
        skills: trained({ Attack: 40, Strength: 70, Defence: 30, Ranged: 70, Magic: 70 }) },
    // The dagger gang of the Wilderness (research/pvp-fight-loop.md, "Rivals: the dagger gang"): what the world feed
    // shows the three accounts wear, at the hiscore levels of the strongest of them. One of them ate a shark in a
    // fight; the count of 12 is an estimate.
    'ganker-dds': { worn: { hat: 'blackwizhat', torso: 'monkrobetop', legs: 'monkrobebottom', weapon: 'dragon_dagger_p' },
        carried: [], food: 12, switches: { melee: ['dragon_dagger_p'] }, options: { rotation: ['melee'] },
        skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Magic: 37, Ranged: 1 }, rival: 'Goondelf, Ligma, Sugma' },
    // ganker-dds skulled, as the live gang is: varp 78 (%pk_skull) holds the ticks left, and login puts the skull back
    // on (pk_skull.rs2 set_pk_skull_login, at most ^pk_skull_duration 2000). A skulled account keeps no item at death,
    // one with Protect Item (death.rs2 pvp_death_lose_items); an account with no skull keeps its 3 dearest.
    'ganker-dds-skull': { worn: { hat: 'blackwizhat', torso: 'monkrobetop', legs: 'monkrobebottom', weapon: 'dragon_dagger_p' },
        carried: [], food: 12, switches: { melee: ['dragon_dagger_p'] }, options: { rotation: ['melee'] }, varps: { 78: 2000 },
        skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Magic: 37, Ranged: 1 }, rival: 'Goondelf, Ligma, Sugma' },
    // The most that the dagger gang can be with the items the feed shows: the same worn items, the two melee potions,
    // two prayer potions and a full pack of sharks. A method that clears this gang clears the real one whatever its
    // pack holds.
    'ganker-max': { worn: { hat: 'blackwizhat', torso: 'monkrobetop', legs: 'monkrobebottom', weapon: 'dragon_dagger_p' },
        carried: ['4dose2attack', '4dose2strength', ...PRAYER_POTS], food: 23, switches: { melee: ['dragon_dagger_p'] }, options: { rotation: ['melee'] },
        skills: { Attack: 99, Strength: 99, Defence: 99, Hitpoints: 99, Prayer: 99, Magic: 37, Ranged: 1 }, rival: 'Goondelf, Ligma, Sugma' },
    // The target of a pure: combat 3 with a pickaxe and a few lobsters.
    skiller: { worn: { weapon: 'bronze_pickaxe', feet: 'leather_boots' }, carried: [], food: 5, foodItem: 'lobster',
        switches: { melee: ['bronze_pickaxe'] }, options: { rotation: ['melee'] }, skills: { ...PURE } },
};
