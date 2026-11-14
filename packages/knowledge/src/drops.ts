import { cleanLines } from './text';

// NPC drop tables from [ai_queue3,<npc or _category>] scripts. Each table rolls `def_int $x = random(N)` once
// and branches on cumulative `if ($x < T)` thresholds, so a slot's chance is (T - previous T) / N.
// Drops nested in a further `if` inside a slot (members world, quest stage) are marked conditional.
export interface Roll { chance: number; item?: string; table?: string; count?: number; countMax?: number; conditional: boolean; src: string; items?: ProcItem[] }
// An item that a roll on a shared drop proc (`table`) can give. chance: per kill, the roll's chance times each proc step's
// chance. path: each proc step as "<proc>: random(N) < T then <result> k/N". src: the line that names the item.
export interface ProcItem { item: string; count: number; chance: number; conditional: boolean; path: string; src: string }
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

// Shared drop procs, `[proc,<name>]()(namedobj, int)` (drop tables/scripts/shared_droptables.rs2), that a table calls
// as obj_add(npc_coord, ~<name>, ...). Each rolls `$x = random(N)` and branches on cumulative `$x < T` thresholds, like a
// table. A slot gives `return (item, n)`, `return (~proc)`, or sets `$drop = item` for a `return ($drop, n)` after the
// chain (megararetable). A further `if ($x < T2 ...)` in a slot narrows that path to T2; any other nested if makes it
// conditional. A return before the roll (randomherb's free-world coins) has chance 1 within the proc. When the die is
// set more than once (randomjewel: random(65) with a ring of wealth on a members world, else random(128)), the last
// assignment before the chain is used, so chances are for a player without the ring.
export interface ProcRow { chance: number; item?: string; table?: string; count: number; conditional: boolean; step: string; src: string }

export function parseDropProcs(text: string, file: string): Map<string, ProcRow[]> {
    const procs = new Map<string, ProcRow[]>();
    const lines = cleanLines(text);
    let name = '';
    let rows: ProcRow[] | null = null;
    let depth = 0, rollVar: string | null = null, die = 0, inChain = false, done = false, chainDepth = 0, prev = 0;
    let slot: { lo: number; hi: number; depth: number } | null = null;
    let sub: { hi: number; depth: number } | null = null;
    let pending: { v: string; item: string; chance: number; conditional: boolean; step: string; src: string }[] = [];
    let swDie = 0, swCovered = 0, lastIf = '';
    const reset = () => { depth = 0; rollVar = null; die = 0; inChain = false; done = false; prev = 0; slot = null; sub = null; pending = []; swDie = 0; swCovered = 0; lastIf = ''; };

    lines.forEach((line, i) => {
        const src = `${file}:${i + 1}`;
        const head = line.match(/^\[(\w+),(\w+)\](.*)$/);
        if (head) {
            reset();
            rows = head[1] === 'proc' && /\(\s*namedobj\s*,\s*int\s*\)\s*$/.test(head[3]!) ? [] : null;
            name = head[2]!;
            if (rows) procs.set(name, rows);
            return;
        }
        if (!rows || !line) return;
        const out: ProcRow[] = rows;
        const startDepth = depth;
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        depth += opens - closes;

        const cond = line.match(/^(?:\}\s*)?(?:else\s+)?if\s*\((.*)\)\s*\{?/);
        if (cond) lastIf = cond[1]!.trim();
        const def = line.match(/^(?:def_int )?\$(\w+) = random\((\d+)\);$/);
        if (def && !inChain && !done) { rollVar = def[1]!; die = Number(def[2]); return; }
        // `switch_int (random(N)) { case k : return(item, n); ... }`: each listed case is 1/N; default takes what is left.
        const sw = line.match(/^switch_int\s*\(\s*random\((\d+)\)\s*\)/);
        if (sw) { swDie = Number(sw[1]); swCovered = 0; return; }
        if (swDie) {
            const c = line.match(/^case\s+([^:]+?)\s*:\s*return\s*\(\s*(\w+)\s*,\s*(\d+)\s*\)/);
            if (c) {
                const ks = c[1] === 'default' ? swDie - swCovered : c[1]!.split(',').length;
                if (c[1] !== 'default') swCovered += ks;
                if (ks > 0) out.push({ item: c[2]!, count: Number(c[3]), chance: ks / swDie, conditional: false, step: `${name}: random(${swDie}) case ${c[1]} then ${c[2]} ${ks}/${swDie}`, src });
            }
            if (depth === 0) swDie = 0;
            return;
        }

        // A chain branch: `if`, `else if` or `} else if` on the roll variable at the chain's own depth.
        const branch = rollVar ? line.match(/^(\}\s*)?(?:else\s+)?if \(\$(\w+) < (\d+)\)/) : null;
        const nested = rollVar ? line.match(/^if \(\$(\w+) < (\d+)\b/) : null;
        let onBranch = false;
        if (branch && branch[2] === rollVar && !done && (!inChain || startDepth - (branch[1] ? 1 : 0) === chainDepth)) {
            if (!inChain) { inChain = true; chainDepth = startDepth; prev = 0; }
            const t = Number(branch[3]);
            slot = { lo: prev, hi: t, depth: chainDepth + 1 }; sub = null; prev = t; onBranch = true;
        } else if (inChain && /^\}\s*else\s*\{$/.test(line) && startDepth === chainDepth + 1) {
            slot = { lo: prev, hi: die, depth: chainDepth + 1 }; sub = null; prev = die; onBranch = true;
        } else if (inChain && slot && nested && nested[1] === rollVar) {
            // e.g. `if ($random < 62 & %legendsquest = ^legends_complete)` inside the slot 61-64
            sub = { hi: Math.min(Number(nested[2]), slot.hi), depth: startDepth + 1 };
        }
        // A statement on a branch line (`if ($x < 8) { $drop = rune_spear; }`) sits at the slot's depth.
        const at = onBranch ? chainDepth + 1 : startDepth;
        if (sub && at < sub.depth && !nested) sub = null;

        const path = (what: string): { chance: number; conditional: boolean; step: string } => {
            if (inChain && slot) {
                const hi = sub ? sub.hi : slot.hi;
                return { chance: (hi - slot.lo) / die, conditional: at > slot.depth || !!sub, step: `${name}: random(${die}) < ${hi} then ${what} ${hi - slot.lo}/${die}` };
            }
            if (done) return { chance: (die - prev) / die, conditional: at > 0, step: `${name}: random(${die}) >= ${prev} then ${what} ${die - prev}/${die}` };
            return { chance: 1, conditional: at > 0, step: `${name}: ${at > 0 && lastIf ? `if ${lastIf}` : 'always'} then ${what} 1/1` };
        };

        const assign = line.match(/\$(\w+) = (\w+);/);
        if (assign && assign[1] !== rollVar && assign[2] !== 'null' && inChain && slot) {
            pending.push({ v: assign[1]!, item: assign[2]!, ...path(assign[2]!), src });
        }
        const call = line.match(/return\s*\(\s*~(\w+)\s*\)/);
        if (call) out.push({ table: call[1]!, count: 1, ...path(call[1]!), src });
        const ret = line.match(/return\s*\(\s*(\$?\w+)\s*,\s*(\d+)\s*\)/);
        if (ret) {
            const count = Number(ret[2]);
            if (ret[1]!.startsWith('$')) {
                for (const p of pending.filter(p => p.v === ret[1]!.slice(1))) out.push({ item: p.item, count, chance: p.chance, conditional: p.conditional, step: p.step, src: p.src });
            } else out.push({ item: ret[1]!, count, ...path(ret[1]!), src });
        }
        // The chain ends when its last `}` closes, or, for one-line `if (...) { ... }` branches, at the next other statement.
        if (inChain && depth === chainDepth && (closes > opens || (!onBranch && !/^else\b/.test(line)))) { inChain = false; done = true; slot = null; sub = null; }
    });
    // A proc that names no item (a helper that only returns a namedobj it was given) is not a drop proc.
    for (const [k, v] of procs) if (v.length === 0) procs.delete(k);
    return procs;
}

// Each roll on a shared proc gets the items reachable through it, with the path's chance. Rolls on other tables are left.
export function expandProcItems(drops: DropTable[], procs: Map<string, ProcRow[]>): void {
    const walk = (proc: string, chance: number, conditional: boolean, steps: string[], seen: string[]): ProcItem[] =>
        (procs.get(proc) ?? []).flatMap(r => {
            const c = chance * r.chance, cond = conditional || r.conditional, path = [...steps, r.step];
            if (r.table) return seen.includes(r.table) ? [] : walk(r.table, c, cond, path, [...seen, r.table]);
            return [{ item: r.item!, count: r.count, chance: c, conditional: cond, path: path.join('; '), src: r.src }];
        });
    for (const d of drops) for (const r of d.rolls) {
        if (r.table && procs.has(r.table)) r.items = walk(r.table, r.chance, r.conditional, [], [r.table]);
    }
}
