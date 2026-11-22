// Rev-289 Mage Arena god spell loadouts, god cape/staff conflict detection, and Dragon special weapon comparisons.
import { SPELLS } from '../pk-types';
import { FREEZE, PRAYER_POTS, RUNE, trained, type KitSpec } from './model';

export type GodName = 'saradomin' | 'guthix' | 'zamorak';

export type GodLoadoutSpec = {
    god: GodName;
    cape: string;
    capeId: number;
    staff: string;
    staffId: number;
    spell: number;
    spellName: string;
    statue: { id: number; x: number; z: number };
    castVarp: number;
    drainEffect: 'prayer' | 'defence' | 'magic';
    runes: { fire: number; blood: number; air: number };
};

// Verified rev-289 Mage Arena god spell, cape, staff, statue loc, and varp table (area_mage_arena, pvp/spells/scripts).
export const GOD_LOADOUTS: Readonly<Record<GodName, GodLoadoutSpec>> = {
    saradomin: {
        god: 'saradomin', cape: 'saradomin_cape', capeId: 2412, staff: 'saradomin_staff', staffId: 2415,
        spell: SPELLS.saradominStrike, spellName: 'saradomin_strike', statue: { id: 2873, x: 2500, z: 4721 },
        castVarp: 268, drainEffect: 'prayer', runes: { fire: 2, blood: 2, air: 4 },
    },
    guthix: {
        god: 'guthix', cape: 'guthix_cape', capeId: 2413, staff: 'guthix_staff', staffId: 2416,
        spell: SPELLS.clawsOfGuthix, spellName: 'claws_of_guthix', statue: { id: 2875, x: 2507, z: 4724 },
        castVarp: 269, drainEffect: 'defence', runes: { fire: 1, blood: 2, air: 4 },
    },
    zamorak: {
        god: 'zamorak', cape: 'zamorak_cape', capeId: 2414, staff: 'zamorak_staff', staffId: 2417,
        spell: SPELLS.flamesOfZamorak, spellName: 'flames_of_zamorak', statue: { id: 2874, x: 2516, z: 4721 },
        castVarp: 270, drainEffect: 'magic', runes: { fire: 4, blood: 2, air: 1 },
    },
};

// Detect conflicting god cape/staff pairs forbidden by god_gear.rs2:1-24.
export function godCapeStaffConflict(itemIds: readonly number[]): { capeGod: GodName; staffGod: GodName } | null {
    const set = new Set(itemIds);
    const capes = (Object.values(GOD_LOADOUTS) as GodLoadoutSpec[]).filter(g => set.has(g.capeId));
    const staves = (Object.values(GOD_LOADOUTS) as GodLoadoutSpec[]).filter(g => set.has(g.staffId));
    for (const c of capes) for (const s of staves) if (c.god !== s.god) return { capeGod: c.god, staffGod: s.god };
    return null;
}

// Build a dynamic Mage Arena god-spell + Charge combat kit (with matching cape, staff, Charge runes, and optional Dragon melee spec) without altering KITS keys.
export function buildGodSpellKit(
    god: GodName,
    opts: { charge?: boolean; dragonSpec?: 'dagger' | 'mace' | 'battleaxe' | 'longsword'; food?: number; magicLevel?: number } = {},
): KitSpec {
    const spec = GOD_LOADOUTS[god];
    const magicLevel = opts.magicLevel ?? 99;
    const charge = opts.charge ?? magicLevel >= 80;
    const specWeapon = opts.dragonSpec === 'mace' ? 'dragon_mace'
        : opts.dragonSpec === 'battleaxe' ? 'dragon_battleaxe'
        : opts.dragonSpec === 'longsword' ? 'dragon_longsword'
        : 'dragon_dagger_p';
    const meleeSwitches = opts.dragonSpec ? [specWeapon, 'rune_kiteshield'] : [];
    const carried: (string | [string, number])[] = [
        ['firerune', Math.max(300, spec.runes.fire * 100)],
        ['airrune', Math.max(300, spec.runes.air * 100)],
        ['bloodrune', Math.max(200, spec.runes.blood * 100)],
        ...FREEZE,
        ...(opts.dragonSpec ? [specWeapon, 'rune_kiteshield'] : []),
        ...PRAYER_POTS,
    ];
    return {
        worn: { ...RUNE, cape: spec.cape, weapon: spec.staff, ammo: ['rune_arrow', 300] },
        carried,
        food: opts.food ?? (opts.dragonSpec ? 14 : 16),
        switches: {
            magic: [spec.staff],
            ...(meleeSwitches.length ? { melee: meleeSwitches } : {}),
        },
        options: {
            rotation: meleeSwitches.length ? ['magic', 'melee'] : ['magic'],
            damageSpell: spec.spell,
            charge,
        },
        skills: trained({ Attack: 99, Strength: 99, Defence: 99, Ranged: 99, Magic: magicLevel, Prayer: 99 }),
        varps: (() => {
            const v: Record<number, number> = { 267: 8, [spec.castVarp]: 99 };
            if (opts.dragonSpec) { v[147] = 6; v[176] = 10; v[188] = 15; }
            return v;
        })(),
    };
}

export type DragonSpecComparison = {
    item: 'dragon_dagger_p' | 'dragon_mace' | 'dragon_longsword' | 'dragon_battleaxe';
    itemId: number;
    kind: 'attack' | 'warcry_buff';
    energyCost: number;
    speedTicks: number;
    hits: number;
    damageMultiplier: number;
    accuracyMultiplier: number;
    rollDefence: 'slash' | 'crush' | 'none';
    warcryStrengthBoost?: number;
    warcryDrains?: { attack: number; defence: number; ranged: number; magic: number };
};

// Compare rev-289 Dragon special weapons: offensive specs (pvp_special_attack.rs2) vs Dragon Battleaxe warcry self-buff (specwep.rs2:61-78).
export function compareDragonSpecs(stats: { Attack: number; Strength: number; Defence: number; Ranged: number; Magic: number }): DragonSpecComparison[] {
    const drains = {
        attack: Math.floor(stats.Attack / 10),
        defence: Math.floor(stats.Defence / 10),
        ranged: Math.floor(stats.Ranged / 10),
        magic: Math.floor(stats.Magic / 10),
    };
    const sumDrain = drains.attack + drains.defence + drains.ranged + drains.magic;
    return [
        { item: 'dragon_dagger_p', itemId: 1231, kind: 'attack', energyCost: 250, speedTicks: 4, hits: 2, damageMultiplier: 1.15, accuracyMultiplier: 1.15, rollDefence: 'slash' },
        { item: 'dragon_mace', itemId: 1434, kind: 'attack', energyCost: 250, speedTicks: 5, hits: 1, damageMultiplier: 1.5, accuracyMultiplier: 1.25, rollDefence: 'crush' },
        { item: 'dragon_longsword', itemId: 1305, kind: 'attack', energyCost: 250, speedTicks: 5, hits: 1, damageMultiplier: 1.25, accuracyMultiplier: 1.0, rollDefence: 'slash' },
        {
            item: 'dragon_battleaxe', itemId: 1377, kind: 'warcry_buff', energyCost: 1000, speedTicks: 6, hits: 0,
            damageMultiplier: 0, accuracyMultiplier: 0, rollDefence: 'none',
            warcryStrengthBoost: 10 + Math.floor(sumDrain / 4), warcryDrains: drains,
        },
    ];
}
