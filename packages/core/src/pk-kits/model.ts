// Core PK kit types, content item/cost memoization, base skill presets, and shared gear/supply blocks.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { levelForXp, xpForLevel } from '../xp-curve';
import type { FightOptions, Style } from '../pk-types';

export const pkKitsRoot = resolve(import.meta.dir, '../../../..');

let byName: Map<string, number> | undefined;
/** Content item id for an obj.pack debugname. */
export function itemId(name: string): number {
    byName ??= new Map(readFileSync(join(pkKitsRoot, 'vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8').split(/\r?\n/)
        .flatMap(l => { const m = l.match(/^(\d+)=(.+)$/); return m ? [[m[2]!, Number(m[1])] as const] : []; }));
    const id = byName.get(name);
    if (id === undefined) throw Error(`pk-kits: no item named ${name}`);
    return id;
}

let costs: Map<number, number> | undefined;
export function costOf(id: number): number {
    costs ??= new Map((JSON.parse(readFileSync(join(pkKitsRoot, 'knowledge/items.json'), 'utf8')) as { id: number; cost?: number }[]).map(i => [i.id, i.cost ?? 0]));
    return costs.get(id) ?? 0;
}

// Worn slots (vendor wearpos): 0 hat, 1 cape, 2 amulet, 3 weapon, 4 torso, 5 shield, 7 legs, 9 hands, 10 feet, 12 ring, 13 ammo.
// A ring of life (ring_of_life.rs2) teleports the account to Lumbridge at 10 percent of its Hitpoints or less, up to Wilderness
// level 30, and is used up. A ring of recoil (pvp_combat.rs2) hits a player attacker back for 10 percent of each hit plus 1 and
// breaks after 40 damage. Both work only on a members world (map_members).
export type Worn = Partial<Record<'hat' | 'cape' | 'amulet' | 'weapon' | 'torso' | 'shield' | 'legs' | 'hands' | 'feet' | 'ring', string>> & { ammo?: [string, number]; weaponCount?: number };
export const SLOT = { hat: 0, cape: 1, amulet: 2, weapon: 3, torso: 4, shield: 5, legs: 7, hands: 9, feet: 10, ring: 12 } as const;

export type KitSpec = {
    worn: Worn;
    // Carried besides food: a name, or a name and a count.
    carried: (string | [string, number])[];
    food: number;
    // The food item (default shark, heals 20). A cooked karambwan heals 18 and costs no attack time.
    foodItem?: string;
    // Switch weapons for each style the build fights with, by name.
    switches: Partial<Record<Style, string[]>>;
    options?: Pick<FightOptions, 'rotation' | 'damageSpell' | 'charge' | 'castArmour' | 'freezeWear' | 'comboFood' | 'comboAt' | 'zeroDrainFlick' | 'offensiveFlick' | 'fakieSwitch' | 'stepUnderFrozen' | 'burstOnStun'>;
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
export const PURE = { Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1, Hitpoints: 10 } as const;
export const MAXED = { Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: 99, Prayer: 99, Hitpoints: 99 } as const;
export const RUNE = { hat: 'rune_full_helm', torso: 'rune_platebody', legs: 'rune_platelegs', cape: 'cape_of_legends', amulet: 'amulet_of_glory_4', feet: 'boots_ranger' } as const;
export const WAVE: [string, number][] = [['airrune', 500], ['bloodrune', 100]];
export const FREEZE: [string, number][] = [['earthrune', 200], ['waterrune', 200], ['naturerune', 100]];
export const PRAYER_POTS = ['4doseprayerrestore', '4doseprayerrestore'];
export const BOOSTS = ['4dose2attack', '4dose2strength', '4doserangerspotion'];

// The levels of a trained build. Hitpoints come from its combat XP: a point of damage gives 4 XP to the style and 1.33
// to Hitpoints, so Hitpoints hold a third of the XP of the five combat skills. Gap: quest XP gives no Hitpoints, so
// an account that takes its levels from quests has fewer.
export function trained(levels: Record<string, number>): Record<string, number> {
    const xp = ['Attack', 'Strength', 'Defence', 'Ranged', 'Magic'].reduce((n, k) => n + xpForLevel(levels[k] ?? 1), 0);
    return { ...PURE, ...levels, Hitpoints: levels.Hitpoints ?? Math.max(10, levelForXp(Math.floor(xp / 3))) };
}

// What a build with Ranged 70 and Defence 1 wears: no body, because a dragonhide body needs Defence 40.
export const PURE_RANGE = { hat: 'coif', legs: 'black_dragonhide_chaps', hands: 'black_dragon_vambraces', cape: 'black_cape', amulet: 'amulet_of_glory_4', feet: 'boots_ranger' } as const;

// The tribrid's kit with the three boost potions, for a build with its own Defence level.
export const DEF_TRIBRID: KitSpec = {
    worn: { ...RUNE, cape: 'black_cape', weapon: 'dragon_dagger_p', shield: 'rune_kiteshield', ammo: ['rune_arrow', 300] },
    carried: ['mystic_fire_staff', 'magic_shortbow', ...WAVE, ...FREEZE, ...PRAYER_POTS, ...BOOSTS],
    food: 15,
    switches: { magic: ['mystic_fire_staff'], ranged: ['magic_shortbow'], melee: ['dragon_dagger_p', 'rune_kiteshield'] },
};

// The combat level the server gives a set of base levels (Player.ts getCombatLevel).
export function combatLevel(s: Record<string, number>): number {
    const lv = (k: string) => s[k] ?? 1;
    return Math.floor(0.25 * (lv('Defence') + lv('Hitpoints') + Math.floor(lv('Prayer') / 2))
        + 0.325 * Math.max(lv('Attack') + lv('Strength'), Math.floor(lv('Ranged') * 1.5), Math.floor(lv('Magic') * 1.5)));
}
