// Army tribrid, snare, dragon, and Wave B/C BiS matrix kit definitions.
import { SPELLS } from '../pk-types';
import { BOOSTS, FREEZE, PRAYER_POTS, RUNE, WAVE, type KitSpec } from './model';

const FULL_BOOSTS = [...BOOSTS, '4dose2defense', '4dose2antipoison'];
const KARAM5 = Array.from({ length: 5 }, () => 'tbwt_cooked_karambwan');
const KARAM4 = KARAM5.slice(0, 4);
const ACC = { hat: 'viking_helmet_crush', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', hands: 'black_dragon_vambraces', feet: 'death_climbingboots', ring: 'ring_of_recoil', weapon: 'dragon_dagger_p', ammo: ['rune_arrow_p', 300] as [string, number] } as const;
const TANK = { ...ACC, torso: 'dragon_chainbody', legs: 'dragon_platelegs', shield: 'dragon_sq_shield' } as const;
const COMBO_PACK = ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...FULL_BOOSTS, ...KARAM5];
const SHARK_PACK = ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...FULL_BOOSTS];
const SW_DRG = { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield'] };
const BIS_VARPS = { 314: 80 };
const BIS_HYBRID: KitSpec = { worn: { ...TANK, legs: 'black_dragonhide_chaps' }, carried: COMBO_PACK, food: 11, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS };
const godKit = (god: 'saradomin' | 'guthix', spell: number, varp: number): KitSpec => ({
    worn: { ...ACC, torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', cape: `${god}_cape`, shield: 'dragon_sq_shield' },
    carried: ['magic_shortbow', `${god}_staff`, ...FREEZE, ...WAVE, ['firerune', 500], ...PRAYER_POTS, ...FULL_BOOSTS, ...KARAM4],
    food: 8,
    switches: { magic: [`${god}_staff`], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield'] },
    options: { rotation: ['magic', 'ranged', 'melee'], damageSpell: spell, charge: true, castArmour: 'strip', comboFood: true },
    varps: { ...BIS_VARPS, 267: 8, [varp]: 99 },
});

export const TRIBRID_KITS: Readonly<Record<string, KitSpec>> = {
    // The army's kit: rune armour, dragon dagger, magic shortbow, Fire Wave.
    tribrid: { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    'tribrid-pots': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 15,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    // More prayer restore for less food: the first side with no prayer points takes full hits.
    'tribrid-pray': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, '4doseprayerrestore'], food: 17,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    'tribrid-pray4': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...PRAYER_POTS], food: 16,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    // The tribrid with no helm, body or legs: the bow special rolls against its own ranged defence (scripts/pk.ts
    // bowBurst), and this build has almost none.
    'tribrid-bare': { worn: { cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'dragon_dagger_p', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] } },
    // The tribrid with cooked karambwans for food.
    'tribrid-kara': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 18, foodItem: 'tbwt_cooked_karambwan',
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    // Shark + karambwan same-tick combo-eating kit for high-burst survivability.
    'tribrid-combo': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...Array.from({ length: 6 }, () => 'tbwt_cooked_karambwan')], food: 12,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] },
        options: { comboFood: true } },
    // Zero-drain 5-tick prayer cycling + 1-tick offensive flicking + fakie switches + freeze step-under + KO combo-eating.
    'tribrid-combo-flick': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...Array.from({ length: 6 }, () => 'tbwt_cooked_karambwan')], food: 12,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] },
        options: { comboFood: true, zeroDrainFlick: true, offensiveFlick: true, fakieSwitch: true, stepUnderFrozen: true } },
    // Multi-way tribrid carrying both Dragon spear (4-tick stun-lock) and Dragon dagger(p) (burst finisher).
    'tribrid-spear-dds': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['dragon_spear', 'mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 17,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield', 'dragon_spear'] },
        options: { burstOnStun: true } },
    // The tribrid with another special weapon: the mace special is one hit of 150% damage at 125% accuracy against
    // crush defence, the longsword special one hit of 125% damage (pvp/specs/scripts).
    'tribrid-mace': { worn: { ...RUNE, weapon: 'dragon_mace', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_mace', 'rune_kiteshield'] } },
    'tribrid-dlong': { worn: { ...RUNE, weapon: 'dragon_longsword', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_longsword', 'rune_kiteshield'] } },
    'tribrid-mace-pots': { worn: { ...RUNE, weapon: 'dragon_mace', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 15,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_mace', 'rune_kiteshield'] } },
    'tribrid-bare-pots': { worn: { cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'dragon_dagger_p', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 15,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p'] } },
    // Food against tools. A stand-up fight is a food race, and the freeze runes take three pack slots that the base loop
    // does not use: `tribrid-food` carries sharks in their place, `tribrid-lean` the three boost potions, and `hybrid`
    // drops the staff and its runes too.
    'tribrid-food': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...PRAYER_POTS], food: 21,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    // Bow and dagger for the fight and the freeze runes for a target that runs: no staff and no wave runes, so three
    // more sharks than the potion kit.
    'tribrid-snare': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The snare kit with a Saradomin cape (Mage Arena) in place of the Legends cape: magic attack +10 for each freeze,
    // magic defence +10, the other defences 6 lower. The magic roll of a freeze is (Magic + 9) x (bonus + 64)
    // (player_combat_stat.rs2), and the snare kit casts with the glory's +10 alone once its plate is off.
    'tribrid-snare-sara': { worn: { ...RUNE, cape: 'saradomin_cape', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The snare kit in black dragonhide (body, chaps, vambraces) in place of the rune platebody and platelegs: ranged
    // attack +47 against -17, magic attack -25 against -51 (the freeze roll), magic defence +78 against -10, stab
    // defence 86 against 133 and ranged defence 86 against 129 (all.obj params). Defence 40 and Ranged 70 to wear.
    'tribrid-snare-dhide': { worn: { ...RUNE, torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', hands: 'black_dragon_vambraces', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The snare kit that changes body and legs with the turn: rune for a melee turn, black dragonhide for a bow turn
    // (ranged attack +64, magic defence +88 against rune), the other pair in the pack, so 2 sharks fewer.
    'tribrid-snare-swap': { worn: { ...RUNE, hands: 'black_dragon_vambraces', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', 'black_dragonhide_body', 'black_dragonhide_chaps', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 16,
        switches: { ranged: ['magic_shortbow', 'black_dragonhide_body', 'black_dragonhide_chaps'], melee: ['dragon_dagger_p', 'rune_kiteshield', 'rune_platebody', 'rune_platelegs'] }, options: { rotation: ['ranged', 'melee'] } },
    // The snare kit in the best armour for each slot of a maxed tribrid (bun scripts/gear.ts best): dragon med helm,
    // dragon chainbody (magic attack -15 against the rune platebody's -30, slash and crush defence higher), dragon
    // platelegs (stab defence 68 against 51), dragon square shield (Legends' Quest) and black dragonhide vambraces
    // (ranged attack +11). Defence 60 and Ranged 70 to wear; no Dragon Slayer.
    'tribrid-dragon': { worn: { ...RUNE, hat: 'dragon_med_helm', torso: 'dragon_chainbody', legs: 'dragon_platelegs', hands: 'black_dragon_vambraces', weapon: 'dragon_dagger_p', shield: 'dragon_sq_shield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The Saradomin-cape kit with a magic longbow for the bow special (pvp_magic_longbow.rs2: no hit roll, +10 Ranged
    // levels, 10 tiles against the shortbow's 7; both 35% energy); the shortbow still shoots each bow turn. One shark fewer.
    'tribrid-snare-sara-mlb': { worn: { ...RUNE, cape: 'saradomin_cape', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', 'magic_longbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 17,
        switches: { ranged: ['magic_shortbow', 'magic_longbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The dragon kit with the Saradomin cape (magic attack +10) and no vambraces (-10): the strip takes off one piece
    // a cast with 18 sharks in the pack, so what stays on decides the freeze roll (finding 72).
    'tribrid-dragon-sara': { worn: { ...RUNE, hat: 'dragon_med_helm', torso: 'dragon_chainbody', legs: 'dragon_platelegs', cape: 'saradomin_cape', weapon: 'dragon_dagger_p', shield: 'dragon_sq_shield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The Saradomin-cape and dragon kits with 14 sharks: 5 free slots, so the strip before a freeze takes off up to
    // five penalising pieces in place of one (finding 72).
    'tribrid-snare-sara-f14': { worn: { ...RUNE, cape: 'saradomin_cape', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 14,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    'tribrid-dragon-f14': { worn: { ...RUNE, hat: 'dragon_med_helm', torso: 'dragon_chainbody', legs: 'dragon_platelegs', hands: 'black_dragon_vambraces', weapon: 'dragon_dagger_p', shield: 'dragon_sq_shield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 14,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield'] }, options: { rotation: ['ranged', 'melee'] } },
    // The dragon kit that wears the Saradomin cape (magic attack +10) for each freeze and the Legends cape (+7 to every
    // defence) for the other turns; the god cape in the pack, so 17 sharks (finding 72).
    'tribrid-dragon-capeswap': { worn: { ...RUNE, hat: 'dragon_med_helm', torso: 'dragon_chainbody', legs: 'dragon_platelegs', hands: 'black_dragon_vambraces', weapon: 'dragon_dagger_p', shield: 'dragon_sq_shield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', 'saradomin_cape', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 17,
        switches: { ranged: ['magic_shortbow', 'cape_of_legends'], melee: ['dragon_dagger_p', 'dragon_sq_shield', 'cape_of_legends'] }, options: { rotation: ['ranged', 'melee'], freezeWear: ['saradomin_cape'] } },
    // The Saradomin-cape kit with another special weapon in place of the dragon dagger (pvp_dragon_mace.rs2: one hit,
    // damage x1.5, accuracy x1.25, 5 ticks; pvp_dragon_longsword.rs2: one hit, damage x1.25, 5 ticks; both 25%).
    'tribrid-sara-mace': { worn: { ...RUNE, cape: 'saradomin_cape', weapon: 'dragon_mace', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_mace', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    'tribrid-sara-dls': { worn: { ...RUNE, cape: 'saradomin_cape', weapon: 'dragon_longsword', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_longsword', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // Rev-289 Achievable BiS matrix kits for Wave B/C optimization sweeps.
    'tribrid-bis-rune': { worn: { ...ACC, torso: 'rune_platebody', legs: 'rune_platelegs', shield: 'rune_kiteshield' }, carried: SHARK_PACK, food: 16, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-dhide': { worn: { ...ACC, torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', shield: 'dragon_sq_shield' }, carried: COMBO_PACK, food: 11, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-dragon': { worn: { ...TANK, hat: 'dragon_med_helm' }, carried: COMBO_PACK, food: 11, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-dragon-med-sharks': { worn: { ...TANK, hat: 'dragon_med_helm' }, carried: SHARK_PACK, food: 16, switches: SW_DRG, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-dragon-zerk': { worn: TANK, carried: COMBO_PACK, food: 11, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-dragon-zerk-sharks': { worn: TANK, carried: SHARK_PACK, food: 16, switches: SW_DRG, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-zerk-power-sharks': { worn: { ...TANK, amulet: 'amulet_of_power' }, carried: ['amulet_of_glory_4', ...SHARK_PACK], food: 15, switches: SW_DRG, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-zerk-karam2': { worn: { ...TANK, amulet: 'amulet_of_power' }, carried: ['amulet_of_glory_4', ...SHARK_PACK, ...KARAM5.slice(0, 2)], food: 13, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-zerk-tele': { worn: { ...TANK, amulet: 'amulet_of_power' }, carried: [...SHARK_PACK, ['lawrune', 3], ['airrune', 15]], food: 14, switches: SW_DRG, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-zerk-glory-tele': { worn: TANK, carried: [...SHARK_PACK, ['lawrune', 3], ['airrune', 15]], food: 14, switches: SW_DRG, options: { rotation: ['ranged', 'melee'] }, varps: BIS_VARPS },
    'tribrid-bis-zerk-tele-karam2': { worn: TANK, carried: [...SHARK_PACK, ...KARAM5.slice(0, 2), ['lawrune', 3], ['airrune', 15]], food: 12, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-hybrid': BIS_HYBRID,
    'tribrid-bis-hybrid-sharks': { ...BIS_HYBRID, carried: SHARK_PACK, food: 16, options: { rotation: ['ranged', 'melee'] } },
    'tribrid-bis-swap': { worn: TANK, carried: ['magic_shortbow', 'black_dragonhide_body', 'black_dragonhide_chaps', ...FREEZE, ...PRAYER_POTS, ...FULL_BOOSTS, ...KARAM4], food: 10, switches: { ranged: ['magic_shortbow', 'black_dragonhide_body', 'black_dragonhide_chaps'], melee: ['dragon_dagger_p', 'dragon_sq_shield', 'dragon_chainbody', 'dragon_platelegs'] }, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-entangle': { worn: { ...ACC, torso: 'black_dragonhide_body', legs: 'black_dragonhide_chaps', cape: 'saradomin_cape', shield: 'dragon_sq_shield' }, carried: ['magic_shortbow', 'mystic_fire_staff', ...FREEZE, ...PRAYER_POTS, ...FULL_BOOSTS, ...KARAM4], food: 11, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], freezeWear: ['mystic_fire_staff'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-spear': { worn: { ...TANK, legs: 'black_dragonhide_chaps' }, carried: ['dragon_spear_p', 'magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...FULL_BOOSTS, ...KARAM4], food: 11, switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'dragon_sq_shield', 'dragon_spear_p'] }, options: { rotation: ['ranged', 'melee'], comboFood: true, burstOnStun: true }, varps: BIS_VARPS },
    'tribrid-bis-amulet-str': { ...BIS_HYBRID, worn: { ...BIS_HYBRID.worn, amulet: 'amulet_of_strength' } },
    'tribrid-bis-amulet-power': { ...BIS_HYBRID, worn: { ...BIS_HYBRID.worn, amulet: 'amulet_of_power' } },
    'tribrid-bis-power-glory': { ...BIS_HYBRID, worn: { ...BIS_HYBRID.worn, amulet: 'amulet_of_power' }, carried: ['amulet_of_glory_4', ...COMBO_PACK], food: 10 },
    'tribrid-bis-dragon-power': { worn: { ...TANK, amulet: 'amulet_of_power' }, carried: ['amulet_of_glory_4', ...COMBO_PACK], food: 10, switches: SW_DRG, options: { rotation: ['ranged', 'melee'], comboFood: true }, varps: BIS_VARPS },
    'tribrid-bis-hybrid-tele': { ...BIS_HYBRID, carried: [...COMBO_PACK, ['lawrune', 3], ['airrune', 15]], food: 9 },
    'tribrid-bis-sara-cape': { ...BIS_HYBRID, worn: { ...BIS_HYBRID.worn, cape: 'saradomin_cape' } },
    'tribrid-bis-god-sara': godKit('saradomin', SPELLS.saradominStrike, 268),
    'tribrid-bis-god-guthix': godKit('guthix', SPELLS.clawsOfGuthix, 269),
    // The army's stunner: the snare kit with a dragon spear (two-handed) in place of the dagger and shield. Its special
    // holds the target 5 ticks with no input, so in multi-way combat the others hit a target that cannot eat.
    'tribrid-snare-spear': { worn: { ...RUNE, weapon: 'dragon_spear', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_spear'] }, options: { rotation: ['ranged', 'melee'] } },
    // The snare kit with adamant arrows: 300 rune arrows are 120,000 of the kit's 392,715 coins, 300 adamant arrows 24,000.
    'tribrid-snare-addy': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['adamant_arrow', 300] },
        carried: ['magic_shortbow', ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
    // A target that runs: the tribrid with three sharks and its glory to leave with.
    runner: { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...PRAYER_POTS, 'amulet_of_glory_4'], food: 3,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    'tribrid-lean': { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...PRAYER_POTS, ...BOOSTS], food: 18,
        switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } },
    hybrid: { worn: { ...RUNE, weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
        carried: ['magic_shortbow', ...PRAYER_POTS, ...BOOSTS], food: 21,
        switches: { ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['ranged', 'melee'] } },
};
