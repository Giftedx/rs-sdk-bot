import { cleanLines } from './text';

// NPC drop tables from [ai_queue3,<npc or _category>] scripts. Each table rolls `def_int $x = random(N)` once
// and branches on cumulative `if ($x < T)` thresholds, so a slot's chance is (T - previous T) / N.
// Drops nested in a further `if` inside a slot (members world, quest stage) are marked conditional.
export interface Roll { chance: number; item?: string; table?: string; count?: number; countMax?: number; conditional: boolean; src: string }
export interface DropTable {
    trigger: string; // npc debugname, or _category
    always: { item: string; count: number; conditional: boolean; src: string }[]; // conditional: nested in an if
    rolls: Roll[];
    uses?: string; // label of a shared table, e.g. goblin_drop_table
    src: string;
}

const OBJ_ADD = /obj_add\(npc_coord,\s*([^,]+?),\s*([^,)]+?)(?:,\s*[^)]+)?\)/;

function parseObj(line: string): { item?: string; table?: string; count?: number; countMax?: number } | null {
    const m = line.match(OBJ_ADD);
    if (!m) return null;
    const what = m[1]!.trim();
    if (what.startsWith('~')) return { table: what.slice(1) };
    const item = what === 'npc_param(death_drop)' ? 'death_drop' : what;
    // DropParser.parse_quantity in jaidenw/2004scape-drop-search recognizes
    // this form. Re-derive its upper bound from pinned NumberOps.RANDOM:
    // random(n) is 0..n-1 (RANDOMINC is the separate inclusive operation).
    const random = line.match(/obj_add\(npc_coord,\s*[^,]+?,\s*calc\(\s*random\(\s*(\d+)\s*\)\s*\+\s*(\d+)\s*\)\s*,/);
    if (random) {
        const n = Number(random[1]), offset = Number(random[2]);
        const max = offset + Math.max(0, n - 1);
        if ([n, offset, max].every(Number.isSafeInteger) && max <= 0x7fffffff) return { item, count: offset, countMax: max };
    }
    // A ranged amount, e.g. obj_add(npc_coord, coins, ~random_range(100, 500), ...): keep both ends.
    const range = line.match(/~random_range\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (range) return { item, count: Number(range[1]), countMax: Number(range[2]) };
    const count = Number(m[2]!.trim());
    return { item, count: Number.isFinite(count) ? count : 1 };
}

export function parseDrops(text: string, file: string): DropTable[] {
    const out: DropTable[] = [];
    const lines = cleanLines(text);
    let cur: DropTable | null = null;
    let depth = 0;
    let rollVar: string | null = null;
    let die = 128;
    let inChain = false;
    let chainDepth = 0;
    let prev = 0;
    let slot: { chance: number; depth: number } | null = null;

    lines.forEach((line, i) => {
        const src = `${file}:${i + 1}`;
        const head = line.match(/^\[(\w+),([^\]]+)\](.*)$/);
        if (head) {
            cur = null;
            // Shared tables are labels (`[label,goblin_drop_table]`) that ai_queue3 triggers jump to with @label.
            if (head[1] === 'ai_queue3' || head[1] === 'label') {
                cur = { trigger: head[1] === 'label' ? `label:${head[2]}` : head[2]!, always: [], rolls: [], src };
                const label = head[3]!.match(/@(\w+)/);
                if (label) cur.uses = label[1];
                out.push(cur);
            }
            depth = 0; rollVar = null; inChain = false; slot = null; prev = 0;
            return;
        }
        if (!cur || !line) return;
        const c: DropTable = cur;
        const def = line.match(/^def_int \$(\w+) = random\((\d+)\);$/);
        if (def) { rollVar = def[1]!; die = Number(def[2]); prev = 0; return; }

        // `{` may sit on the same line or the next. Tables written as separate `if ($x < T) { ...; return(); }`
        // blocks keep counting from the previous threshold, because each earlier block returns.
        const branch = line.match(/^(?:\}\s*else\s+)?if \(\$(\w+) < (\d+)\)\s*\{?$/);
        if (branch && branch[1] === rollVar) {
            if (!inChain) { inChain = true; chainDepth = depth; }
            const t = Number(branch[2]);
            slot = { chance: (t - prev) / die, depth: chainDepth + 1 };
            prev = t;
        } else if (inChain && /^\}\s*else\s*\{$/.test(line) && depth === chainDepth + 1) {
            slot = { chance: (die - prev) / die, depth: chainDepth + 1 };
            prev = die;
        }

        const obj = parseObj(line);
        if (obj) {
            if (inChain && slot) {
                c.rolls.push({ chance: slot.chance, ...obj, conditional: depth > slot.depth, src });
            } else if (!inChain && obj.item) {
                c.always.push({ item: obj.item, count: obj.count ?? 1, conditional: depth > 0, src });
            }
        }
        if (!c.uses) {
            const label = line.match(/^@(\w+)/);
            if (label) c.uses = label[1];
        }

        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        depth += opens - closes;
        if (inChain && depth === chainDepth && closes > opens) { inChain = false; slot = null; }
    });
    // Labels are used everywhere in content; keep only those that actually drop something.
    return out.filter(d => !d.trigger.startsWith('label:') || d.rolls.length > 0 || d.always.length > 0);
}
