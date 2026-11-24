// Combat item classification, ranged bow/arrow tier ladders, style scoring, slot ranking, and unlock tier boundaries.
import type { Bonus, Gear, Skill } from '../../../knowledge/src/gear';
import { canWearGear, gearCatalog, skillTools, weaponSupportsTrainSkill } from './catalog';
import {
    GEAR_KEY_BY_SLOT,
    GEAR_UNLOCK_KINDS,
    GOD_ALIGN_BY_ID,
    normalizeSkills,
    type CombatFocus,
    type GearSkillLevels,
    type GearSkillName,
    type GearUnlockKind,
    type GearUnlockLevels,
    type QuestInput,
    type RangedLoadoutSlotName,
} from './model';

const STANDARD_ARROW_RE = /^(bronze|iron|steel|mithril|adamant|rune)_arrow(_p)?$/;
const STANDARD_BOW_RE = /^(shortbow|longbow|oak_shortbow|oak_longbow|willow_shortbow|willow_longbow|maple_shortbow|maple_longbow|yew_shortbow|yew_longbow|magic_shortbow|magic_longbow)$/;
const ELEMENTAL_STAFF_RE = /^staff_of_(air|water|earth|fire)$|^(air|water|earth|fire|lava)_battlestaff$|^mystic_(air|water|earth|fire|lava)_staff$/;

export function isRangedWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && (
        (g.attackRange !== undefined && g.attackRange >= 3)
        || g.bonuses.rangeAttack > 0
        || g.bonuses.rangeStrength > 0
        || /bow|dart|knife|javelin|thrown/i.test(g.name)
    );
}

export function isMagicWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && /\b(?:staff|battlestaff)\b/i.test(g.name);
}

export function isMeleeWeapon(g: Gear): boolean {
    return g.slot === 'righthand'
        && !isRangedWeapon(g)
        && !isMagicWeapon(g)
        && g.bonuses.strength >= 0
        && Math.max(g.bonuses.stabAttack, g.bonuses.slashAttack, g.bonuses.crushAttack) >= 0;
}

export function isStandardRangedBow(g: Gear): boolean {
    return g.slot === 'righthand' && STANDARD_BOW_RE.test(g.debugname);
}

export function isStandardArrow(g: Gear): boolean {
    return g.slot === 'quiver' && STANDARD_ARROW_RE.test(g.debugname);
}

/** The standard bows by Ranged wear level, the highest first. In a level the faster bow (the shortbow) is first. */
export function standardBowTiers(): { level: number; ids: number[] }[] {
    const byLevel = new Map<number, Gear[]>();
    for (const g of gearCatalog()) {
        if (!isStandardRangedBow(g)) continue;
        const level = g.requires.skills.ranged ?? 1;
        let list = byLevel.get(level);
        if (!list) { list = []; byLevel.set(level, list); }
        list.push(g);
    }
    return [...byLevel].sort((a, b) => b[0] - a[0])
        .map(([level, bows]) => ({ level, ids: bows.sort((a, b) => (a.attackRate ?? 4) - (b.attackRate ?? 4) || a.id - b.id).map(g => g.id) }));
}

/** The standard unpoisoned arrows, the strongest first, each with the Ranged level its levelrequire needs. */
export function standardArrowTiers(): { level: number; id: number; strength: number }[] {
    return gearCatalog()
        .filter(g => isStandardArrow(g) && !g.debugname.endsWith('_p'))
        .sort((a, b) => b.bonuses.rangeStrength - a.bonuses.rangeStrength || a.id - b.id)
        .map(g => ({ level: g.tier ?? 1, id: g.id, strength: g.bonuses.rangeStrength }));
}

// A thrown weapon (knife, dart, javelin, throwing axe) is its own ammunition: the worn stack is spent by the shots.
export function isThrownWeapon(g: Gear): boolean {
    return g.slot === 'righthand' && g.bonuses.rangeStrength > 0 && !/bow/.test(g.debugname);
}

// The rapid style fires one tick sooner than the weapon's attackrate (player_ranged.rs2 ^style_ranged_rapid).
export function rapidRate(g: Gear): number {
    return Math.max(1, (g.attackRate ?? 4) - 1);
}

export function meleeDefenceMean(b: Record<Bonus, number>): number {
    return (b.stabDefence + b.slashDefence + b.crushDefence) / 3;
}

export function scoreGearForStyle(item: Gear, style: CombatFocus, arrowStrength = 0): number {
    const b = item.bonuses;
    if (item.slot === 'righthand') {
        if (style === 'melee') {
            if (!isMeleeWeapon(item)) return -1e9;
            const maxAtk = Math.max(b.stabAttack, b.slashAttack, b.crushAttack);
            const rate = Math.max(1, item.attackRate ?? 4);
            return ((64 + b.strength) * (64 + maxAtk)) / rate;
        }
        if (style === 'ranged') {
            if (!isRangedWeapon(item)) return -1e9;
            const rate = Math.max(1, item.attackRate ?? 4);
            const str = b.rangeStrength + arrowStrength;
            const base = ((64 + str) * (64 + b.rangeAttack)) / rate;
            return isStandardRangedBow(item) ? base + 1 : base;
        }
        if (!isMagicWeapon(item)) return -1e9;
        const elemental = ELEMENTAL_STAFF_RE.test(item.debugname) ? 5 : 0;
        const god = GOD_ALIGN_BY_ID[item.id] ? 2 : 0;
        return b.magicAttack * 20 + b.magicDefence * 4 + elemental + god + b.strength * 0.1;
    }
    if (item.slot === 'quiver') {
        if (style !== 'ranged') return -1e9;
        return b.rangeStrength * 20 + (isStandardArrow(item) ? 5 : 0);
    }
    if (style === 'melee') {
        const atk = Math.max(b.stabAttack, b.slashAttack, b.crushAttack);
        const def = (meleeDefenceMean(b) * 1.5 + b.rangeDefence * 0.25);
        return b.strength * 20 + atk * 10 + b.prayer * 4 + def;
    }
    if (style === 'ranged') {
        const avgDef = (meleeDefenceMean(b) * 3 + b.magicDefence + b.rangeDefence) / 5;
        return b.rangeAttack * 20 + b.rangeStrength * 15 + b.prayer * 4 + avgDef;
    }
    const avgDef = (meleeDefenceMean(b) * 3 + b.rangeDefence) / 10;
    return b.magicAttack * 20 + b.magicDefence * 4 + b.prayer * 4 + avgDef;
}

export function tieOrder(a: Gear, b: Gear, style: CombatFocus): number {
    if (style === 'melee' && a.slot === 'righthand') {
        const oneHandDiff = Number(a.covers.includes('lefthand')) - Number(b.covers.includes('lefthand'));
        if (oneHandDiff !== 0) return oneHandDiff;
        const strDiff = b.bonuses.strength - a.bonuses.strength;
        if (strDiff !== 0) return strDiff;
    }
    // Prefer un-trimmed / standard over trimmed cosmetics when stats tie, and higher glory charge first.
    if (/^Amulet of glory/i.test(a.name) && /^Amulet of glory/i.test(b.name)) {
        return b.id - a.id;
    }
    return a.id - b.id;
}

export function bestGearForSlot(
    style: CombatFocus,
    slot: RangedLoadoutSlotName,
    levels?: GearSkillLevels,
    quests?: QuestInput,
    options?: { trainSkill?: string; arrowStrength?: number; includeNonPositive?: boolean },
): Gear[] {
    const wearSlot = GEAR_KEY_BY_SLOT[slot];
    const arrowStrength = options?.arrowStrength ?? 0;
    const candidates = gearCatalog().filter(g => {
        if (g.slot !== wearSlot) return false;
        if (!canWearGear(g, levels, quests)) return false;
        if (slot === 'weapon' && !weaponSupportsTrainSkill(g, options?.trainSkill)) return false;
        const s = scoreGearForStyle(g, style, arrowStrength);
        if (s <= -1e8) return false;
        if (!options?.includeNonPositive && slot !== 'weapon' && s <= 0) return false;
        return true;
    });
    return candidates.sort((a, b) =>
        scoreGearForStyle(b, style, arrowStrength) - scoreGearForStyle(a, style, arrowStrength)
        || tieOrder(a, b, style));
}

export function missingRequirements(item: Gear, levels: Partial<Record<GearSkillName, number>>, done: Set<string>) {
    const missingSkills: Partial<Record<Skill, number>> = {};
    for (const [skill, req] of Object.entries(item.requires.skills)) {
        if ((levels[skill as GearSkillName] ?? 1) < req!) missingSkills[skill as Skill] = req!;
    }
    const missingQuests = item.requires.quest && !done.has(item.requires.quest) ? [item.requires.quest] : [];
    return { missingSkills, missingQuests };
}

export function unlockRank(item: Gear, missingSkills: Partial<Record<Skill, number>>, missingQuests: string[], isAmmo = false): number {
    const reqLevel = isAmmo
        ? (item.tier ?? 1)
        : Math.max(1, ...Object.values(item.requires.skills).map(v => v ?? 1));
    const missingSkillMax = Math.max(0, ...Object.values(missingSkills).map(v => v ?? 0));
    return Math.max(reqLevel, missingSkillMax) * 100 + missingQuests.length * 10;
}

const unlockCache = new Map<GearUnlockKind | 'all', GearUnlockLevels>();

/**
 * The levels above 1 at which a skill unlocks an item of the kind, ascending, by skill. A combat style reads the
 * wear levels of every item the style scores (knowledge/gear.json, with an arrow's levelrequire as a Ranged level).
 * A tool kind reads knowledge/skill-tools.json: the Attack level to wield, and the skill level to use.
 */
export function gearUnlockLevels(kind: GearUnlockKind): GearUnlockLevels {
    const cached = unlockCache.get(kind);
    if (cached) return cached;
    const sets = new Map<GearSkillName, Set<number>>();
    const add = (skill: GearSkillName, level: number | null | undefined) => {
        if (typeof level !== 'number' || !Number.isSafeInteger(level) || level <= 1 || level > 99) return;
        const set = sets.get(skill) ?? new Set<number>();
        set.add(level);
        sets.set(skill, set);
    };
    if (kind === 'woodcutting-axe' || kind === 'mining-pickaxe') {
        const rows = kind === 'woodcutting-axe' ? skillTools().axes : skillTools().pickaxes;
        const skill: GearSkillName = kind === 'woodcutting-axe' ? 'woodcutting' : 'mining';
        for (const row of rows) {
            add('attack', row.wieldAttack);
            // An axe has no Woodcutting gate in rev 289 (woodcuttingLevel null); its levelrequire param serves a caller
            // that enforces the axe level (bestWoodcuttingAxe enforceAxeLevel).
            add(skill, kind === 'woodcutting-axe' ? row.woodcuttingLevel ?? row.paramLevelrequire : row.miningLevel);
        }
    } else {
        for (const g of gearCatalog()) {
            if (g.slot === 'quiver') {
                if (kind === 'ranged' && isStandardArrow(g)) add('ranged', g.tier);
                continue;
            }
            const score = scoreGearForStyle(g, kind);
            if (g.slot === 'righthand' ? score <= -1e8 : score <= 0) continue;
            for (const [skill, level] of Object.entries(g.requires.skills)) add(skill as GearSkillName, level);
        }
    }
    const out: Partial<Record<GearSkillName, readonly number[]>> = {};
    for (const [skill, set] of sets) out[skill] = [...set].sort((a, b) => a - b);
    unlockCache.set(kind, out);
    return out;
}

function allGearUnlockLevels(): GearUnlockLevels {
    const cached = unlockCache.get('all');
    if (cached) return cached;
    const sets = new Map<GearSkillName, Set<number>>();
    for (const kind of GEAR_UNLOCK_KINDS) {
        for (const [skill, levels] of Object.entries(gearUnlockLevels(kind))) {
            const set = sets.get(skill as GearSkillName) ?? new Set<number>();
            for (const level of levels ?? []) set.add(level);
            sets.set(skill as GearSkillName, set);
        }
    }
    const out: Partial<Record<GearSkillName, readonly number[]>> = {};
    for (const [skill, set] of sets) out[skill] = [...set].sort((a, b) => a - b);
    unlockCache.set('all', out);
    return out;
}

/** The highest boundary of `tiers` at or under the level, or 1. */
export function tierBoundaryOf(level: number, tiers: readonly number[]): number {
    let highest = 1;
    for (const t of tiers) if (level >= t) highest = t;
    return highest;
}

/**
 * True when one of the skills passed an unlock level between the two observations. `tiers` names the item kind whose
 * unlock levels count (gearUnlockLevels), or gives a level list for every skill. Without it, every kind counts.
 */
export function crossedTierBoundary(
    previous: GearSkillLevels,
    current: GearSkillLevels,
    skills: readonly string[] = ['attack', 'strength', 'defence'],
    tiers?: GearUnlockKind | GearUnlockLevels | readonly number[],
): boolean {
    const prev = normalizeSkills(previous);
    const curr = normalizeSkills(current);
    const isList = (t: typeof tiers): t is readonly number[] => Array.isArray(t);
    const bySkill = isList(tiers) ? undefined : tiers === undefined ? allGearUnlockLevels() : typeof tiers === 'string' ? gearUnlockLevels(tiers) : tiers;
    return skills.some(s => {
        const key = s.toLowerCase() as GearSkillName;
        const levels = isList(tiers) ? tiers : bySkill?.[key] ?? [];
        return tierBoundaryOf(curr[key] ?? 1, levels) > tierBoundaryOf(prev[key] ?? 1, levels);
    });
}
