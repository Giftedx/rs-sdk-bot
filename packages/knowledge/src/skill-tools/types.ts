/** Hold requirement for a tool or access item. */
export type Hold = 'held' | 'worn' | 'either';

/** Content-relative path:line citation and trimmed line text. */
export interface Cite { src: string; text: string }

/** Item requirement for a skill method. */
export interface ItemNeed { anyOf: string[]; ids: (number | null)[]; hold: Hold; role: 'tool' | 'bait' | 'access' | 'bonus'; src: string; note?: string }

/** Item consumed per action or per catch. */
export interface Consume { item: string; id: number | null; perAction: number | null; src: string; note?: string }

/** Location category or object requirement. */
export interface LocNeed { anyOf: string[]; src: string }

/** Script-level condition guarding a skill method. */
export interface Condition { text: string; src: string }

/** Selector linking a tool record to ladder rungs. */
export interface AppliesTo { kinds: string[]; idPattern: string | null; rungs: string[] }

/** Tool, consumable, and location summary for one skill method. */
export interface ToolRecord {
    id: string; skill: string; appliesTo: AppliesTo;
    minLevel: number | null; levelSrc: string | null;
    items: ItemNeed[]; consumed: Consume[]; locs: LocNeed[]; conditions: Condition[];
    catches?: { item: string; id: number | null; level: number; levelSrc: string | null; src: string }[];
    option?: { name: string; trigger: string; spot: string; npcs: number; src: string };
    gaps: string[]; src: string; note?: string;
}

/** Woodcutting axe tier metadata parsed from content scripts and configs. */
export interface AxeRow {
    item: string; id: number | null; rank: number; hold: Hold; holdSrc: string;
    woodcuttingLevel: number | null; woodcuttingLevelSrc: string; paramLevelrequire: number | null; paramSrc: string | null;
    wieldAttack: number | null; wieldSrc: string | null; successChance: Record<string, { low: number; high: number; src: string }>;
}

/** Mining pickaxe tier metadata parsed from content scripts and configs. */
export interface PickaxeRow {
    item: string; id: number | null; rank: number; hold: Hold; holdSrc: string;
    miningLevel: number | null; miningLevelSrc: string | null; wieldAttack: number | null; wieldSrc: string | null;
    miningRate: number | null; miningRateSrc: string | null;
}

export interface Rung { id: string; skill: string; kind: string; level: number; outputs: { debugname: string | null }[]; inputs: { debugname: string | null }[] }
