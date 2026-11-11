// PvP builds for the spar bench: one table gives both the start state of an account (what it wears and carries) and
// how the fight loop uses it (its switch weapons and style turns). Items are named as in the content pack
// (vendor/rs-sdk/server/content/pack/obj.pack), so a wrong name fails at load and not in a fight.
// `cost` is the shop value of a kit (knowledge/items.json), the measure for "the same kills with a cheaper kit".
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPELLS, type FightOptions, type Kit, type Style } from './pk';

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
type Worn = Partial<Record<'hat' | 'cape' | 'amulet' | 'weapon' | 'torso' | 'shield' | 'legs' | 'hands' | 'feet', string>> & { ammo?: [string, number] };
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
};
// Defence 1 and Hitpoints 10 with Prayer 1: the base of every pure, 2.75 combat levels (Player.ts getCombatLevel).
const PURE = { Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1, Hitpoints: 10 } as const;
const RUNE = { hat: 'rune_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger' } as const;
const WAVE: [string, number][] = [['airrune', 500], ['bloodrune', 100]], FREEZE: [string, number][] = [['earthrune', 200], ['waterrune', 200], ['naturerune', 100]];
const PRAYER_POTS = ['4doseprayerrestore', '4doseprayerrestore'], BOOSTS = ['4dose2attack', '4dose2strength', '4doserangerspotion'];
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
    // charges a cast, varp 288) with a magic shortbow (Ranged 50). Underground Pass gives Attack 61.
    'pure-iban': { worn: { weapon: 'ibanstaff', amulet: 'amulet_of_magic', feet: 'leather_boots', ammo: ['rune_arrow', 100] },
        carried: ['magic_shortbow', ['deathrune', 100], ['firerune', 500]], food: 20, foodItem: 'lobster',
        switches: { magic: ['ibanstaff'], ranged: ['magic_shortbow'] }, options: { rotation: ['magic', 'ranged'], damageSpell: SPELLS.ibanBlast },
        skills: { ...PURE, Attack: 61, Ranged: 50, Magic: 50 }, varps: { 288: 120 } },
    // Combat 46, the highest that can attack combat 3 at the rune rocks (Wilderness level 46): dragon dagger special
    // (Attack 61, Strength 73) with Flames of Zamorak under Charge (Magic 80, max hit 30) and Entangle (79).
    'pure-rock': { worn: { weapon: 'dragon_dagger_p', cape: 'zamorak_cape', amulet: 'amulet_of_strength', feet: 'leather_boots' },
        carried: ['zamorak_staff', ['firerune', 400], ['airrune', 500], ['bloodrune', 100], ...FREEZE, '4dose2strength'], food: 16, foodItem: 'lobster',
        switches: { magic: ['zamorak_staff'], melee: ['dragon_dagger_p'] }, options: { rotation: ['magic', 'melee'], damageSpell: SPELLS.flamesOfZamorak, charge: true },
        skills: { ...PURE, Attack: 61, Strength: 73, Magic: 80 }, varps: { 267: 8, 270: 99 } },
    // Combat 19: Fire Bolt (Magic 35, max hit 12) and nothing else.
    'pure-bolt': { worn: { weapon: 'staff_of_fire', amulet: 'amulet_of_magic', feet: 'leather_boots' },
        carried: [['airrune', 500], ['chaosrune', 200]], food: 20, foodItem: 'lobster',
        switches: { magic: ['staff_of_fire'] }, options: { rotation: ['magic'] }, skills: { ...PURE, Magic: 35 } },
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
// Lost City done, Dragon Slayer done and full special energy, then the varps of the build.
export const kitVarps = (name: string): Record<number, number> => ({ 147: 6, 176: 10, 300: 1000, ...kitOf(name).varps });

const kitOf = (name: string): KitSpec => { const k = KITS[name]; if (!k) throw Error(`pk-kits: unknown kit "${name}"; known: ${Object.keys(KITS).join(', ')}`); return k; };
const carried = (k: KitSpec) => k.carried.map(c => (typeof c === 'string' ? { id: itemId(c), count: 1 } : { id: itemId(c[0]), count: c[1] }));
// The fight loop's switch weapons for a kit.
export const kitSwitches = (name: string): Kit => Object.fromEntries(Object.entries(kitOf(name).switches).map(([style, names]) => [style, names!.map(itemId)]));
export const kitOptions = (name: string) => kitOf(name).options ?? {};
// What an account of the kit wears and carries at the start, in the save generator's form.
export function kitItems(name: string) {
    const k = kitOf(name);
    const equipment = Object.entries(k.worn).flatMap(([slot, item]) => (slot === 'ammo'
        ? [{ id: itemId((item as [string, number])[0]), count: (item as [string, number])[1], slot: 13 }]
        : [{ id: itemId(item as string), count: 1, slot: SLOT[slot as keyof typeof SLOT] }]));
    const inventory = [...carried(k), ...Array.from({ length: k.food }, () => ({ id: itemId(k.foodItem ?? 'shark'), count: 1 }))];
    if (inventory.length > 27) throw Error(`pk-kits: kit ${name} carries ${inventory.length} items; 27 leave the free slot that a bow switch needs`);
    return { equipment, inventory };
}
// Shop value of everything the kit wears and carries.
export function kitCost(name: string): number {
    const { equipment, inventory } = kitItems(name);
    return [...equipment, ...inventory].reduce((n, i) => n + costOf(i.id) * i.count, 0);
}
