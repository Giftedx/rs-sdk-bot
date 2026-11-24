import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot } from '../paths';
import { cite, configBlocks, emptyRecord, itemId, lines, walk } from './readers';
import type { Rung, ToolRecord } from './types';

const FISH_DIR = 'scripts/skill_fishing/scripts/fishing_spots';
const FISH_NPC = 'scripts/skill_fishing/configs/fishing.npc';
const FISH_OBJ = 'scripts/skill_fishing/configs/fishing.obj';
const FISH_EQUIP = 'scripts/skill_fishing/configs/fishing_equipment.struct';
const LOC_DUMP = 'scripts/_unpack/225/all.loc';

interface Line { f: string; n: number; t: string }
interface Block { file: string; key: string; start: number; body: Line[] }

function scriptBlocks(rel: string): Map<string, Block> {
    const out = new Map<string, Block>();
    let cur: Block | null = null;
    lines(rel).forEach((t, i) => {
        const h = /^\[([a-z0-9_]+),([^\]]+)\](.*)$/.exec(t);
        if (h) {
            cur = { file: rel, key: `${h[1]},${h[2]}`, start: i + 1, body: [{ f: rel, n: i + 1, t: h[3]! }] };
            out.set(cur.key, cur);
            return;
        }
        if (cur) cur.body.push({ f: rel, n: i + 1, t });
    });
    return out;
}

// Collects the attempt block and every block it reaches in the fishing spot files: @label jumps, ~proc calls and p_opnpc/p_oploc re-triggers.
function reach(blocks: Map<string, Block>, start: Block, opType: string, target: string): Line[] {
    const seen = new Set<string>();
    const out: Line[] = [];
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
        const b = queue[head]!;
        if (seen.has(b.key)) continue;
        seen.add(b.key);
        for (const ln of b.body) {
            const commentAt = ln.t.indexOf('//');
            const code = commentAt >= 0 ? ln.t.slice(0, commentAt) : ln.t;
            out.push({ f: ln.f, n: ln.n, t: code });
            if (code.includes('@')) {
                for (const m of code.matchAll(/@([a-z0-9_]+)/g)) {
                    const nb = blocks.get(`label,${m[1]}`);
                    if (nb && !m[1]!.startsWith('macro_')) queue.push(nb);
                }
            }
            if (code.includes('~')) {
                for (const m of code.matchAll(/~([a-z0-9_]+)/g)) {
                    const nb = blocks.get(`proc,${m[1]}`);
                    if (nb) queue.push(nb);
                }
            }
            if (code.includes('p_op')) {
                for (const m of code.matchAll(/p_op(npc|loc)\((\d)\)/g)) {
                    const nb = blocks.get(`op${m[1]}${m[2]},${target}`);
                    if (nb && nb.key.startsWith(opType)) queue.push(nb);
                }
            }
        }
    }
    return out;
}

function equipmentBait(): Map<string, { bait: string; src: string }> {
    const objs = configBlocks(FISH_OBJ);
    const structs = configBlocks(FISH_EQUIP);
    const out = new Map<string, { bait: string; src: string }>();
    for (const [name, ob] of objs) {
        const s = ob.params.fish_equipment_struct;
        if (!s) continue;
        const st = structs.get(s.value);
        const b = st?.params.baitrequired;
        if (b) out.set(name, { bait: b.value, src: `${FISH_EQUIP}:${b.line}` });
    }
    return out;
}

function fishOption(blocks: Map<string, Block>, trigger: Block, opType: string, target: string, rungs: Rung[], baitOf: Map<string, { bait: string; src: string }>): Omit<ToolRecord, 'id' | 'option'> {
    const body = reach(blocks, trigger, opType, target);
    const at = (l: Line) => `${l.f}:${l.n}`;
    const rec = emptyRecord('', 'fishing', { kinds: ['catch'], idPattern: null, rungs: [] }, `${trigger.file}:${trigger.start}`);
    const lvl = body.find(b => /stat\(fishing\) < \d+/.test(b.t));
    if (lvl) { rec.minLevel = Number(/stat\(fishing\) < (\d+)/.exec(lvl.t)![1]); rec.levelSrc = at(lvl); }
    else { rec.minLevel = 1; rec.levelSrc = null; rec.note = 'no Fishing level check on this option; level 1 is the stat floor'; }

    const baits = new Map<string, Line>();
    const catches = new Map<string, { level: number; levelSrc: string | null; src: string }>();
    const addCatch = (item: string, level: number, levelSrc: string | null, src: string) => {
        const c = catches.get(item);
        if (!c || level < c.level) catches.set(item, { level, levelSrc, src });
    };
    let gate: { level: number; src: string } | null = null;
    let lastDel: string | null = null;
    const tools: { item: string; l: Line }[] = [];
    const returns = new Set<string>();
    body.forEach((b, i) => {
        const eq = /check_fish_equipment\(([a-z0-9_]+)\)/.exec(b.t);
        if (eq && !tools.some(t => t.item === eq[1])) tools.push({ item: eq[1]!, l: b });
        const fr = /~fish_roll\(([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+)\)/.exec(b.t);
        const frl = /~fish_roll_loc\(([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+)\)/.exec(b.t);
        const roll = fr ? { f1: fr[1]!, f2: fr[2]!, bait: fr[4]! } : frl ? { f1: frl[1]!, f2: frl[2]!, bait: frl[3]! } : null;
        if (roll) {
            if (roll.bait !== 'null' && !baits.has(roll.bait)) baits.set(roll.bait, b);
            addCatch(roll.f1, rec.minLevel!, rec.levelSrc, at(b));
            if (roll.f2 !== 'null') {
                let prev: Line | undefined;
                for (let p = i - 1; p >= 0; p--) {
                    if (body[p]!.t.trim() !== '') { prev = body[p]; break; }
                }
                const g = prev && /if \(stat\(fishing\) >= (\d+)\)/.exec(prev.t);
                if (g) addCatch(roll.f2, Number(g[1]), at(prev!), at(b));
                else rec.gaps.push(`${roll.f2}: no "stat(fishing) >=" gate right before ${at(b)}`);
            }
        }
        const lg = /if \(\$level < (\d+)\)/.exec(b.t);
        if (lg) gate = { level: Number(lg[1]), src: at(b) };
        const del = /inv_del\(inv, ([a-z0-9_]+), 1\)/.exec(b.t);
        if (del) {
            lastDel = del[1]!;
            if (!baits.has(del[1]!) && !rec.consumed.some(c => c.item === del[1])) rec.consumed.push({ item: del[1]!, id: itemId(del[1]!), perAction: 1, src: at(b), note: 'inv_del on this option path' });
        }
        const add = /inv_add\(inv, ([a-z0-9_]+), 1\)/.exec(b.t);
        if (add) {
            if (lastDel && tools.some(t => t.item === lastDel)) { returns.add(add[1]!); lastDel = null; }
            else addCatch(add[1]!, gate ? Math.max(gate.level, rec.minLevel!) : rec.minLevel!, gate ? gate.src : rec.levelSrc, at(b));
        }
        const it = /inv_total\(inv, ([a-z0-9_]+)\) < 1/.exec(b.t);
        if (it && !tools.some(t => t.item === it[1])) tools.push({ item: it[1]!, l: b });
        if (/%(?!action_delay)[a-z0-9_]+\s*[<>=!]|~mm_wearing_greegree|inzone\(|map_members/.test(b.t)) rec.conditions.push({ text: b.t.trim(), src: at(b) });
    });
    // A bait checked with inv_total is bait, not a tool.
    for (const t of tools) {
        if (baits.has(t.item)) continue;
        rec.items.push({ anyOf: [t.item], ids: [itemId(t.item)], hold: 'held', role: 'tool', src: at(t.l) });
        const sb = baitOf.get(t.item);
        if (sb && !baits.has(sb.bait)) rec.gaps.push(`${t.item}: struct bait ${sb.bait} (${sb.src}) is checked but this option does not consume it`);
    }
    for (const [bait, l] of baits) {
        const sb = [...baitOf.values()].find(x => x.bait === bait);
        rec.items.push({ anyOf: [bait], ids: [itemId(bait)], hold: 'held', role: 'bait', src: sb ? sb.src : at(l), note: 'one is removed per catch' });
        rec.consumed.push({ item: bait, id: itemId(bait), perAction: 1, src: at(l), note: 'per fish caught, not per attempt' });
    }
    for (const r of returns) {
        const c = rec.consumed.find(x => tools.some(t => t.item === x.item));
        if (c) c.note = `${c.note}; ${r} is given back`;
    }
    if (!rec.items.some(i => i.role === 'tool')) rec.gaps.push('no tool check found on this option');
    rec.catches = [...catches].map(([item, c]) => ({ item, id: itemId(item), ...c }));
    const hits = rungs.filter(r => r.skill === 'fishing' && r.outputs.some(o => o.debugname && catches.has(o.debugname)));
    rec.appliesTo.rungs = hits.map(r => r.id);
    return rec;
}

/** Build fishing spot tool records across NPC and loc spots. */
export function buildFishing(rungs: Rung[], gaps: string[]): ToolRecord[] {
    const files = walk(FISH_DIR, '.rs2');
    // Trigger, label and proc names are unique across the spot files, so one map holds them all.
    const all = new Map<string, Block>();
    for (const f of files) for (const [k, b] of scriptBlocks(f)) all.set(k, b);
    const findTrigger = (key: string) => all.get(key) ?? null;
    const baitOf = equipmentBait();
    const out: ToolRecord[] = [];
    // NPC spots: one record per (category or npc, visible op).
    const npcs = configBlocks(FISH_NPC);
    const groups = new Map<string, { ops: Map<number, { name: string; src: string }>; npcs: number; src: string }>();
    for (const [name, nb] of npcs) {
        const cat = nb.params.category?.value;
        const ops = new Map<number, { name: string; src: string }>();
        for (let n = 1; n <= 5; n++) {
            const o = nb.params[`op${n}`];
            if (o && o.value !== 'hidden') ops.set(n, { name: o.value, src: `${FISH_NPC}:${o.line}` });
        }
        // A trigger on the npc name wins over its category.
        const target = [...ops.keys()].some(n => findTrigger(`opnpc${n},${name}`)) ? name : cat ? `_${cat}` : name;
        const g = groups.get(target);
        if (g) g.npcs++;
        else groups.set(target, { ops, npcs: 1, src: `${FISH_NPC}:${nb.line}` });
    }
    let fishspotFiles: string[] | undefined;
    const findElsewhereFishspot = (op: number) => {
        if (!fishspotFiles) {
            const root = contentRoot();
            fishspotFiles = [];
            for (const f of walk('scripts', '.rs2')) {
                if (readFileSync(join(root, f), 'utf8').includes('fishspot]')) fishspotFiles.push(f);
            }
        }
        const re = new RegExp(`^\\[opnpc${op},[a-z0-9_]*fishspot\\]`);
        for (const f of fishspotFiles) {
            const hit = cite(f, re);
            if (hit) return hit;
        }
        return undefined;
    };
    for (const [target, g] of groups) {
        for (const [n, op] of g.ops) {
            const t = findTrigger(`opnpc${n},${target}`);
            if (!t) {
                const elsewhere = findElsewhereFishspot(n);
                gaps.push(`fishing: ${target} op${n} "${op.name}" (${op.src}) has no [opnpc${n},${target}] handler under ${FISH_DIR}${elsewhere ? `; its npcs are handled by name at ${elsewhere.src} (not a skill method)` : ''}`);
                continue;
            }
            const r = fishOption(all, t, 'opnpc', target, rungs, baitOf);
            out.push({ ...r, id: `fishing/spot/${target.replace(/^_/, '')}/op${n}`, option: { name: op.name, trigger: `[opnpc${n},${target}]`, spot: target, npcs: g.npcs, src: op.src } });
        }
    }
    // Loc spots: names from the unpacked loc dump.
    const locKeys = new Set<string>();
    for (const k of all.keys()) { const m = /^oploc\d,(.+)$/.exec(k); if (m) locKeys.add(m[1]!); }
    const locs = configBlocks(LOC_DUMP);
    for (const loc of locKeys) {
        const lb = locs.get(loc);
        if (!lb) { gaps.push(`fishing: loc ${loc} has no config in ${LOC_DUMP}`); continue; }
        for (let n = 1; n <= 5; n++) {
            const o = lb.params[`op${n}`];
            if (!o || o.value === 'hidden') continue;
            const t = findTrigger(`oploc${n},${loc}`);
            if (!t) { gaps.push(`fishing: loc ${loc} op${n} "${o.value}" (${LOC_DUMP}:${o.line}) has no [oploc${n},${loc}] handler`); continue; }
            const r = fishOption(all, t, 'oploc', loc, rungs, baitOf);
            out.push({ ...r, id: `fishing/spot/${loc}/op${n}`, option: { name: o.value, trigger: `[oploc${n},${loc}]`, spot: loc, npcs: 0, src: `${LOC_DUMP}:${o.line}` } });
        }
    }
    for (const r of out) for (const g of r.gaps) gaps.push(`${r.id}: ${g}`);
    return out;
}
