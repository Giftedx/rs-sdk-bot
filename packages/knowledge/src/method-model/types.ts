import type { ConfigBlock } from '../config';

/** Single roll branch within a timing model. */
export interface Roll {
    tool: string | null; toolLevel: number; rollTicks: number; failTicks: number;
    low: number | null; high: number | null; fixedChance: number | null; src: string;
}

/** Per-attempt timing and roll model for a skill method. */
export interface Timing {
    basis: 'instant' | 'p_delay' | 'queue-loop' | 'roll' | 'timer';
    ticksPerTry: number; // ticks per attempt; for a roll, the roll period with the best tool at the unlock level
    rolls: Roll[];
    note: string;
    src: string[];
}

/** Content-derived per-action facts and timing for one ladder rung. */
export interface Facts {
    xpPerAction: number | null; xpSrc: string | null; xpNote: string | null;
    inputs: { debugname: string; count: number }[] | null;
    outputs: { debugname: string; count: number }[] | null;
    tools: string[];
    level: number | null; levelSrc: string | null;
    timing: Timing | null;
    gaps: string[];
}

/** Indexed reader over pinned content lines and `.obj`/`.struct`/`.npc` configs. */
export interface Content {
    lines(file: string): string[] | null;
    obj(name: string): ConfigBlock | undefined;
    struct(name: string): ConfigBlock | undefined;
    structs(): ConfigBlock[];
    npc(name: string): ConfigBlock | undefined;
}

/** Regex match in a content script with its `file:line` citation. */
export interface Hit { m: RegExpExecArray; src: string; line: number }

/** Level range summary of derived XP per tick and best tool. */
export interface Band { from: number; to: number; tool: string | null; xpPerTickFrom: number | null; xpPerTickTo: number | null }

/** Rows of the dbtables the generator reads, as data columns with `file:line`. */
export interface Row { name: string; data: Record<string, string[][]>; src: Record<string, string[]> }

/** Minimal rung descriptor consumed by `modelRung`. */
export interface ModelInput {
    id: string; skill: string; kind: string; level: number; row: Row | null;
    label: string; outputs: string[]; inputs: string[]; npc?: string;
}
