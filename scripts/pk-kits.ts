// PvP builds for the spar bench: one table gives both the start state of an account (what it wears and carries) and
// how the fight loop uses it (its switch weapons and style turns). Items are named as in the content pack
// (vendor/rs-sdk/server/content/pack/obj.pack), so a wrong name fails at load and not in a fight.
// `cost` is the shop value of a kit (knowledge/items.json), the measure for "the same kills with a cheaper kit".
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPELLS, type FightOptions, type Kit, type Style } from './pk';
import { levelForXp, xpForLevel } from '../packages/planner/src/curve';

const root = resolve(import.meta.dir, '..');
let byName: Map<string, number> | undefined;
// The id of a content item name.
export function itemId(name: string): number {
    byName ??= new Map(readFileSync(join(root, 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8').split(/\r?\n/)
        .flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[m[2]!, Number(m[1])] as const] : []; }));
    const id = byName.get(name);
    if (id === undefined) throw Error(`pk-kits: no item named ${name}`);
    return id;
}
let costs: Map<number, number> | undefined;
const costOf = (id: number) => (costs ??= new Map((JSON.parse(readFileSync(join(root, 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[]).map(i => [i.id, i.cost ?? 0]))).get(id) ?? 0;

// Worn slots (vendor wearpos): 0 hat, 1 cape, 2 amulet, 3 weapon, 4 torso, 5 shield, 7 legs, 9 hands, 10 feet, 13 ammo.
type Worn = Partial<Record<'hat' | 'cape' | 'amulet' | 'weapon' | 'torso' | 'shield' | 'legs' | 'hands' | 'feet', string>> & { ammo?: [string, number]; weaponCount?: number };
const SLOT = { hat: 0, cape: 1, amulet: 2, weapon: 3, torso: 4, shield: 5, legs: 7, hands: 9, feet: 10 } as const;
export type KitSpec = {
    worn: Worn;
    // Carried besides food: a name, or a name and a count.
    carried: (string | [string, number])[];
    food: number;
    // The food item (default shark, heals 20). A cooked karambwan heals 18 and costs no attack time.
    foodItem?: string;
    // Switch weapons for each style the build fights with, by name.
    switches: Partial<Record<Style, string[]>>;
    options?: Pick<FightOptions, 'rotation' | 'damageSpell' | 'charge'>;
    // Base levels of the build (default: 99 in the seven combat skills) and the varps it needs besides Lost City,
    // Dragon Slayer and full special energy.
    skills?: Record<string, number>;
    varps?: Record<number, number>;
    // Why no account can reach the kit: it stays for a bench comparison, and the planner gives it no quest.
    noRoute?: string;
    // The accounts of another owner that the kit copies: an opponent for the bench, and the planner gives it no quest.
    rival?: string;
};
// Defence 1 and Hitpoints 10 with Prayer 1: the base of every pure, 2.75 combat levels (Player.ts getCombatLevel).
const PURE = { Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1, Hitpoints: 10 } as const;
const RUNE = { hat: 'rune_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger' } as const;
const WAVE: [string, number][] = [['airrune', 500], ['bloodrune', 100]], FREEZE: [string, number][] = [['earthrune', 200], ['waterrune', 200], ['naturerune', 100]];
const PRAYER_POTS = ['4doseprayerrestore', '4doseprayerrestore'], BOOSTS = ['4dose2attack', '4dose2strength', '4doserangerspotion'];
// The levels of a trained build. Hitpoints come from its combat XP: a point of damage gives 4 XP to the style and 1.33
// to Hitpoints, so Hitpoints hold a third of the XP of the five combat skills. Gap: quest XP gives no Hitpoints, so
// an account that takes its levels from quests has fewer.
export function trained(levels: Record<string, number>): Record<string, number> {
    const xp = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic'].reduce((n, k) => n + xpForLevel(levels[k] ?? 1), 0);
    return { ...PURE, ...levels, Hitpoints: levels.Hitpoints ?? Math.max(10, levelForXp(Math.floor(xp / 3))) };
}
// What a build with Ranged 70 and Defence 1 wears: no body, because a dragonhide body needs Defence 40.
const PURE_RANGE = { hat: 'coif', legs: 'black_dragonhide_chaps', hands: 'black_dragon_vambraces', cape: 'black_cape', amulet: 'amulet_of_glory_4', feet: 'boots_ranger' } as const;
// The tribrid's kit with the three boost potions, for a build with its own Defence level.
const DEF_TRIBRID: KitSpec = { worn: { ...RUNE, cape: 'black_cape', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
    carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...BOOSTS], food: 15,
    switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] } };
export const KITS: Readonly<Record<string, KitSpec>> = {
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
    // One style each, in the armour of that style.
    melee: { worn: { ...RUNE, amulet: 'amulet_of_strength', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield' },
        carried: [...PRAYER_POTS, '4dose2attack', '4dose2strength'], food: 22, switches: { melee: ['dragon_dagger_p', 'rune_kiteshield'] }, options: { rotation: ['melee'] } },
    ranger: { worn: { hat: 'coif', torso: 'dragonhide_body', legs: 'dragonhide_chaps', hands: 'dragon_vambraces', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger', weapon: 'magic_shortbow', ammo: ['rune_arrow', 500] },
        carried: [...PRAYER_POTS, '4doserangerspotion'], food: 23, switches: { ranged: ['magic_shortbow'] }, options: { rotation: ['ranged'] } },
    mage: { worn: { hat: 'splitbark_helm', torso: 'splitbark_body', legs: 'splitbark_legs', hands: 'splitbark_gauntlets', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', weapon: 'mystic_fire_staff' },
        carried: [...WAVE, ...FREEZE, ...PRAYER_POTS], food: 20, switches: { magic: ['mystic_fire_staff'] }, options: { rotation: ['magic'] } },
    // Cheaper tribrids: each tier drops the metal, the bow, the arrows and the spell one step.
    'tribrid-adamant': { worn: { hat: 'adamant_full_helm', torso: 'adamant_platebody', legs: 'adamant_platelegs', amulet: 'amulet_of_power', feet: 'leather_boots', weapon: 'rune_scimitar', shield: 'adamant_kiteshield', ammo: ['adamant_arrow', 300] },
        carried: ['staff_of_fire', 'maple_shortbow', ['airrune', 500], ['deathrune', 150], ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['maple_shortbow'], melee: ['rune_scimitar', 'adamant_kiteshield'] } },
    'tribrid-mithril': { worn: { hat: 'mithril_full_helm', torso: 'mithril_platebody', legs: 'mithril_platelegs', amulet: 'amulet_of_power', feet: 'leather_boots', weapon: 'mithril_scimitar', shield: 'mithril_kiteshield', ammo: ['steel_arrow', 300] },
        carried: ['staff_of_fire', 'willow_shortbow', ['airrune', 500], ['chaosrune', 200], ...FREEZE, ...PRAYER_POTS], food: 18,
        switches: { magic: ['staff_of_fire'], ranged: ['willow_shortbow'], melee: ['mithril_scimitar', 'mithril_kiteshield'] } },
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
    // The target of a pure: combat 3 with a pickaxe and a few lobsters.
    skiller: { worn: { weapon: 'bronze_pickaxe', feet: 'leather_boots' }, carried: [], food: 5, foodItem: 'lobster',
        switches: { melee: ['bronze_pickaxe'] }, options: { rotation: ['melee'] }, skills: { ...PURE } },
};
// The combat level the server gives a set of base levels (Player.ts getCombatLevel).
export function combatLevel(s: Record<string, number>): number {
    const lv = (k: string) => s[k] ?? 1;
    return Math.floor(0.25 * (lv('Defence') + lv('Hitpoints') + Math.floor(lv('Prayer') / 2))
        + 0.325 * Math.max(lv('Attack') + lv('Strength'), Math.floor(lv('Ranged') * 1.5), Math.floor(lv('Magic') * 1.5)));
}
const MAXED = { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99, Prayer: 99, Hitpoints: 99 };
export const kitSkills = (name: string): Record<string, number> => ({ ...(kitOf(name).skills ?? MAXED) });
// Full special energy, Lost City and Dragon Slayer done when the route of the kit has them, then the varps of the
// build. A kit gets no quest that its route does not have.
export const kitVarps = (name: string): Record<number, number> => {
    const quests = kitRoute(name).quests, varps: Record<number, number> = { 300: 1000 };
    if (quests.includes('Lost City')) varps[147] = 6;
    if (quests.includes('Dragon Slayer')) varps[176] = 10;
    return { ...varps, ...kitOf(name).varps };
};

const kitOf = (name: string): KitSpec => { const k = KITS[name]; if (!k) throw Error(`pk-kits: unknown kit "${name}"; known: ${Object.keys(KITS).join(', ')}`); return k; };
const carried = (k: KitSpec) => k.carried.map(c => (typeof c === 'string' ? { id: itemId(c), count: 1 } : { id: itemId(c[0]), count: c[1] }));
// The quest that an item of a kit needs to be worn (levelrequire/scripts/tier*.rs2) and the quest that a varp of a
// kit stands for.
const ITEM_QUEST: Readonly<Record<string, string>> = {
    dragon_dagger: 'Lost City', dragon_dagger_p: 'Lost City', dragon_longsword: 'Lost City', dragon_mace: "Heroes' Quest", dragon_battleaxe: "Heroes' Quest",
    dragon_halberd: 'Regicide', dragon_sq_shield: "Legends' Quest", rune_platebody: 'Dragon Slayer', dragonhide_body: 'Dragon Slayer',
    viking_helmet_crush: 'The Fremennik Trials', viking_helmet_range: 'The Fremennik Trials', viking_helmet_slash: 'The Fremennik Trials', viking_helmet_magic: 'The Fremennik Trials',
    ibanstaff: 'Underground Pass', zamorak_staff: 'Mage Arena', zamorak_cape: 'Mage Arena',
};
const VARP_QUEST: Readonly<Record<number, string>> = { 139: "Legends' Quest", 267: 'Mage Arena', 288: 'Underground Pass', 328: 'Regicide', 347: 'The Fremennik Trials' };
// Each quest with the quests that it needs, as content folders (vendor/rs-sdk/server/content/scripts/quests). Lost
// City stands with the two quests of the planner's chain, which give its Woodcutting and Crafting. The Mage Arena is
// a minigame with no XP reward: its folder is under areas. Sources: quest_hero.rs2:2-4, legends_guard.rs2:50-53.
const LOST_CITY = ['quest_drunkmonk', 'quest_murder', 'quest_zanaris'], UPASS = ['quest_elena', 'quest_biohazard', 'quest_upass'];
const HEROES = [...LOST_CITY, 'quest_dragon', 'quest_arthur', 'quest_blackarmgang', 'quest_hero'];
export const QUEST_CHAIN: Readonly<Record<string, readonly string[]>> = {
    'Lost City': LOST_CITY, 'Dragon Slayer': ['quest_dragon'], 'The Fremennik Trials': ['quest_viking'], 'Mage Arena': ['area_mage_arena'], 'Underground Pass': UPASS,
    Regicide: [...UPASS, 'quest_regicide'], "Heroes' Quest": HEROES,
    "Legends' Quest": [...HEROES, 'quest_crest', 'quest_junglepotion', 'quest_zombiequeen', ...UPASS, 'quest_waterfall', 'quest_legends'],
};
// The server's XP rate (WorldConfig.ts xpRate), and the rewards that knowledge/quests.json does not hold, in whole XP
// (quest_waterfall.rs2:491-492).
const XP_RATE = 25, MORE_REWARDS: Readonly<Record<string, { skill: string; xp: number }[]>> = { quest_waterfall: [{ skill: 'attack', xp: 13750 }, { skill: 'strength', xp: 13750 }] };
// The most XP that the fights of a quest give to one skill, at the server's rate, where the quest script sets the
// style: a route counts it with the rewards. The Fremennik Trials: the bot fights Koschei unarmed with Kick, which
// trains only Strength, and the Draugen the same way; practice runs of the whole quest gave 23,100 to 29,400 XP (research/pvp-fight-loop.md, "Quest routes of the
// builds"). Lost City gives its fight XP to Strength too, and every kit with a dragon weapon has Strength 99.
// Regicide: the quest script casts the Falador and Ardougne teleports; a practice run gave 4,250 Magic XP.
// The Mage Arena: the casts at Kolodion and the 99 casts of Flames of Zamorak; practice runs gave 184,300 to 200,062
// Magic XP.
const FIGHT_XP: Readonly<Record<string, { skill: string; xp: number }[]>> = { quest_viking: [{ skill: 'strength', xp: 35_000 }], quest_regicide: [{ skill: 'magic', xp: 5_000 }], area_mage_arena: [{ skill: 'magic', xp: 205_000 }] };
// The Prayer level of Protect from Magic, which the Mage Arena needs: each spell of Kolodion and of the battle mages
// hits up to 20, and an account with no such prayer did not pass in practice.
const ARENA_PRAYER = 37;
let rewards: Map<string, { skill: string; xp: number }[]> | undefined;
const rewardsOf = (folder: string) => {
    rewards ??= (JSON.parse(readFileSync(join(root, 'knowledge/quests.json'), 'utf8')) as { folder: string; xp: { skill: string; xp: number }[] }[])
        .reduce((m, q) => m.set(q.folder, [...(m.get(q.folder) ?? []), ...q.xp]), new Map<string, { skill: string; xp: number }[]>());
    return [...(rewards.get(folder) ?? []), ...(MORE_REWARDS[folder] ?? [])];
};
// The XP that a list of quests, with the quests they need, gives in a combat skill at the server's rate: the
// rewards and the fights with a set style.
const routeXp = (quests: readonly string[], skill: string) => [...new Set(quests.flatMap(q => QUEST_CHAIN[q]!))]
    .reduce((n, folder) => n + rewardsOf(folder).filter(x => x.skill === skill.toLowerCase()).reduce((m, x) => m + x.xp * XP_RATE, 0)
        + (FIGHT_XP[folder] ?? []).filter(x => x.skill === skill.toLowerCase()).reduce((m, x) => m + x.xp, 0), 0);
// The fight XP of a quest that goes to the style of the account, measured on the maxed presets: a kit with the quest
// on its route needs one of Strength, Ranged and Magic at 99 to take it (research/pvp-fight-loop.md, "Quest routes of
// the builds").
const SINK_XP: Readonly<Record<string, number>> = { quest_upass: 53_400, quest_regicide: 11_100 };
// The quest route of a kit: the quests that its items and varps need, and each combat skill that the rewards of
// those quests and of the quests they need take over the level of the kit, counted from level 1. A kit with an
// empty `breaks` has a route.
export function kitRoute(name: string): { quests: string[]; breaks: string[] } {
    const k = kitOf(name), levels = kitSkills(name);
    const items = [...Object.values(k.worn).flatMap(w => (typeof w === 'string' ? [w] : Array.isArray(w) ? [w[0]] : [])), ...k.carried.map(c => (typeof c === 'string' ? c : c[0]))];
    const quests = [...new Set([...items.map(i => ITEM_QUEST[i]), ...Object.keys(k.varps ?? {}).map(v => VARP_QUEST[Number(v)])].filter((q): q is string => !!q))].sort();
    const breaks = Object.keys(MAXED).flatMap(skill => {
        const level = levelForXp(routeXp(quests, skill));
        return level > 1 && level > (levels[skill] ?? 1) ? [`${skill} ${level}`] : [];
    });
    const sink = [...new Set(quests.flatMap(q => QUEST_CHAIN[q]!))].find(folder => SINK_XP[folder] && !['Strength', 'Ranged', 'Magic'].some(skill => (levels[skill] ?? 1) >= 99));
    if (quests.includes('Mage Arena') && (levels.Prayer ?? 1) < ARENA_PRAYER) breaks.push(`Prayer ${levels.Prayer ?? 1} under the ${ARENA_PRAYER} of the Mage Arena`);
    if (sink) breaks.push(`no skill at 99 for the ${SINK_XP[sink]!.toLocaleString('en-US')} fight XP of ${sink}`);
    return { quests, breaks };
}
// The levels an account of a kit may have before the quests of its route: in each combat skill the highest level
// from which the rewards of the route end at or under the level of the kit. Hitpoints stay as the kit has them.
export function levelsBeforeRoute(name: string): Record<string, number> {
    const levels = kitSkills(name), quests = kitRoute(name).quests;
    return Object.fromEntries(Object.keys(MAXED).map(skill => {
        let level = levels[skill] ?? 1;
        if (skill !== 'Hitpoints') for (const xp = routeXp(quests, skill); level > 1 && levelForXp(xpForLevel(level) + xp) > (levels[skill] ?? 1);) level--;
        return [skill, level];
    }));
}
// Whether a run that gave `gains` XP (whole XP for each skill, lower-case names) to an account at `before` levels
// leaves every combat skill at or under the level of the kit. The first skill over its level, or null.
export function overBuild(name: string, before: Readonly<Record<string, number>>, gains: Readonly<Record<string, number>>): string | null {
    const levels = kitSkills(name);
    for (const skill of Object.keys(MAXED)) {
        const after = levelForXp(xpForLevel(before[skill] ?? 1) + (gains[skill.toLowerCase()] ?? 0));
        if (skill !== 'Hitpoints' && after > (levels[skill] ?? 1)) return `${skill} ${after}`;
    }
    return null;
}
// The fight loop's switch weapons for a kit.
export const kitSwitches = (name: string): Kit => Object.fromEntries(Object.entries(kitOf(name).switches).map(([style, names]) => [style, names!.map(itemId)]));
export const kitOptions = (name: string) => kitOf(name).options ?? {};
// What an account of the kit wears and carries at the start, in the save generator's form.
export function kitItems(name: string) {
    const k = kitOf(name);
    const equipment = Object.entries(k.worn).flatMap(([slot, item]) => (slot === 'ammo'
        ? [{ id: itemId((item as [string, number])[0]), count: (item as [string, number])[1], slot: 13 }]
        // A thrown weapon is a stack in the weapon slot (weaponCount).
        : slot === 'weaponCount' ? [] : [{ id: itemId(item as string), count: slot === 'weapon' ? k.worn.weaponCount ?? 1 : 1, slot: SLOT[slot as keyof typeof SLOT] }]));
    const inventory = [...carried(k), ...Array.from({ length: k.food }, () => ({ id: itemId(k.foodItem ?? 'shark'), count: 1 }))];
    if (inventory.length > 27) throw Error(`pk-kits: kit ${name} carries ${inventory.length} items; 27 leave the free slot that a bow switch needs`);
    return { equipment, inventory };
}
// Shop value of everything the kit wears and carries.
export function kitCost(name: string): number {
    const { equipment, inventory } = kitItems(name);
    return [...equipment, ...inventory].reduce((n, i) => n + costOf(i.id) * i.count, 0);
}
