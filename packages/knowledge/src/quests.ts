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
const BIT_COND = /^testbit\(%(\w+),\s*\^(\w+)\)\s*=\s*\^true$/;
const COG_COND = /^~get_cog_progress\s*=\s*\^(\w+)$/;

function parseClause(clause: string): { varp: string; completeName: string; bit: boolean } | null {
    const c = clause.match(COND);
    if (c) return { varp: c[1]!, completeName: c[2]!, bit: false };
    const b = clause.match(BIT_COND);
    if (b) return { varp: b[1]!, completeName: b[2]!, bit: true };
    const g = clause.match(COG_COND);
    if (g) return { varp: 'cogquest', completeName: g[1]!, bit: false };
    return null;
}

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
        const conds = inner?.split('|').map(c => parseClause(c.trim()));
        const points = input.constants.get(qp[1]!);
        if (!conds || conds.some(c => !c) || !points) { skipped.push({ line: `${input.proc.file}:${i + 1}`, text: l }); return; }
        const [first, ...rest] = conds as { varp: string; completeName: string; bit: boolean }[];
        const complete = input.constants.get(first.completeName);
        if (!complete) { skipped.push({ line: `${input.proc.file}:${i + 1}`, text: l }); return; }
        const varp = first.varp;
        const c = first.completeName;
        const stem = varp.replace(/(?:_quest|quest)$/, '');
        const setsComplete = new RegExp(
            `%${varp}\\s*=\\s*\\^${c}\\b|~\\w+\\(\\s*\\^${c}\\s*\\)|~cog_update_main_quest_step\\(\\s*\\^${c}\\s*\\)|setbit\\(\\s*%${varp}\\s*,\\s*\\^${c}\\s*\\)`,
        );
        const queueComplete = new RegExp(`~send_quest_complete2?\\(\\s*questlist:(?:${varp}|${stem})\\b`);
        let folder = input.varpFolders.get(varp) ?? null;
        if (!folder) {
            for (const [candidate, files] of input.folderScripts) {
                if (files.some(f => setsComplete.test(f.text))) { folder = candidate; break; }
            }
        }
        if (!folder) {
            for (const [candidate, files] of input.folderScripts) {
                if (files.some(f => queueComplete.test(f.text))) { folder = candidate; break; }
            }
        }
        // Completion is set directly (`%varp = ^x_complete`), via bitfield (`setbit`), or via a setter/complete queue.
        const xp: Quest['xp'] = [];
        const folderFiles = folder ? input.folderScripts.get(folder) ?? [] : [];
        const addBlockXp = (b: { line: number; text: string }[], file: string) => {
            for (const x of b) for (const a of x.text.matchAll(/stat_advance\((\w+),\s*(\d+)\)/g)) {
                xp.push({ skill: a[1]!, xp: Number(a[2]) / 10, src: `${file}:${x.line}` });
            }
        };
        for (const f of folderFiles) {
            for (const b of blocks(f.text)) {
                if (b.some(x => setsComplete.test(x.text))) addBlockXp(b, f.file);
            }
        }
        if (xp.length === 0) {
            for (const f of folderFiles) {
                for (const b of blocks(f.text)) {
                    if (/^\[queue,[^\]]+\]/.test(b[0]?.text ?? '') && b.some(x => queueComplete.test(x.text))) {
                        addBlockXp(b, f.file);
                    }
                }
            }
        }
        quests.push({
            varp,
            ...(rest.length ? { alternatives: rest.map(x => x.varp) } : {}),
            folder,
            complete: first.bit ? (1 << complete.value) : complete.value,
            questPoints: points.value,
            xp,
            src: `${input.proc.file}:${i + 1}`,
        });
    });
    return { quests, skipped };
}
