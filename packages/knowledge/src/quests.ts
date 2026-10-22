import { cleanLines } from './text';

// Quest facts for the planner: progress varp, its complete value, quest points, and the XP rewards.
// Sources: general/scripts/quests.rs2 [proc,count_questpoints], general/configs/quest.constant,
// quests/<folder>/configs/*.varp and quests/<folder>/scripts/*.rs2.

export interface Quest {
    varp: string;
    alternatives?: string[]; // other varps that also complete it (e.g. phoenixgang for blackarmgang)
    folder: string | null;
    complete: number;
    questPoints: number;
    // Whole XP (stat_advance values are tenths), only from blocks that set the varp to its complete value,
    // so XP from repeatable in-quest activities is not counted.
    xp: { skill: string; xp: number; src: string }[];
    src: string; // the count_questpoints line for this quest
}

export function parseConstants(text: string, file: string): Map<string, { value: number; src: string }> {
    const out = new Map<string, { value: number; src: string }>();
    cleanLines(text).forEach((l, i) => {
        const m = l.match(/^\^(\w+)\s*=\s*(-?\d+)$/);
        if (m) out.set(m[1]!, { value: Number(m[2]), src: `${file}:${i + 1}` });
    });
    return out;
}

// Splits a script into [trigger] blocks, keeping each line's 1-based number.
function blocks(text: string): { line: number; text: string }[][] {
    const out: { line: number; text: string }[][] = [];
    cleanLines(text).forEach((l, i) => {
        if (/^\[\w+,[^\]]+\]/.test(l) || out.length === 0) out.push([]);
        out[out.length - 1]!.push({ line: i + 1, text: l });
    });
    return out;
}

const COND = /^%(\w+)\s*(?:=|>=)\s*\^(\w+)$/;

export function buildQuests(input: {
    constants: Map<string, { value: number; src: string }>;
    proc: { text: string; file: string };
    varpFolders: Map<string, string>;
    folderScripts: Map<string, { text: string; file: string }[]>;
}): { quests: Quest[]; skipped: { line: string; text: string }[] } {
    const quests: Quest[] = [];
    const skipped: { line: string; text: string }[] = [];
    const lines = cleanLines(input.proc.text);
    lines.forEach((l, i) => {
        const qp = lines[i + 1]?.match(/add\(\$questpoints, \^(\w+)\)/);
        if (!qp) return; // not a quest-point line (random rolls, recount checks, ...)
        const inner = l.match(/^if \((.*)\) \{$/)?.[1];
        const conds = inner?.split('|').map(c => c.trim().match(COND));
        const points = input.constants.get(qp[1]!);
        if (!conds || conds.some(c => !c) || !points) { skipped.push({ line: `${input.proc.file}:${i + 1}`, text: l }); return; }
        const [first, ...rest] = conds as RegExpMatchArray[];
        const complete = input.constants.get(first![2]!);
        if (!complete) { skipped.push({ line: `${input.proc.file}:${i + 1}`, text: l }); return; }
        const varp = first![1]!;
        const folder = input.varpFolders.get(varp) ?? null;
        // Completion is set directly (`%varp = ^x_complete`) or through a setter proc that takes the complete
        // constant (`~quest_vampire_set_progress(^vampire_complete)`, quest_vampire.rs2:41-43).
        const c = first![2]!;
        const setsComplete = new RegExp(`%${varp}\\s*=\\s*\\^${c}\\b|~\\w+\\(\\s*\\^${c}\\s*\\)`);
        const xp: Quest['xp'] = [];
        for (const f of folder ? input.folderScripts.get(folder) ?? [] : []) {
            for (const b of blocks(f.text)) {
                if (!b.some(x => setsComplete.test(x.text))) continue;
                for (const x of b) for (const a of x.text.matchAll(/stat_advance\((\w+),\s*(\d+)\)/g)) xp.push({ skill: a[1]!, xp: Number(a[2]) / 10, src: `${f.file}:${x.line}` });
            }
        }
        quests.push({
            varp,
            ...(rest.length ? { alternatives: rest.map(c => c![1]!) } : {}),
            folder,
            complete: complete.value,
            questPoints: points.value,
            xp,
            src: `${input.proc.file}:${i + 1}`,
        });
    });
    return { quests, skipped };
}
