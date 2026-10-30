// Tools and held items each skill method needs, read from the content scripts.
// Usage: bun packages/knowledge/src/skill-tools.ts   writes knowledge/skill-tools.json.
// Every fact carries `src` = content-relative path and 1-based line. A fact the scripts do not state is a `gaps` entry.
// A name that starts with `_` is a content category (loc or obj), as the trigger writes it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contentRoot, knowledgeDir } from './paths';

export type Hold = 'held' | 'worn' | 'either';
export interface Cite { src: string; text: string }
export interface ItemNeed { anyOf: string[]; ids: (number | null)[]; hold: Hold; role: 'tool' | 'bait' | 'access' | 'bonus'; src: string; note?: string }
export interface Consume { item: string; id: number | null; perAction: number | null; src: string; note?: string }
export interface LocNeed { anyOf: string[]; src: string }
export interface Condition { text: string; src: string }
export interface AppliesTo { kinds: string[]; idPattern: string | null; rungs: string[] }
export interface ToolRecord {
    id: string; skill: string; appliesTo: AppliesTo;
    minLevel: number | null; levelSrc: string | null;
    items: ItemNeed[]; consumed: Consume[]; locs: LocNeed[]; conditions: Condition[];
    catches?: { item: string; id: number | null; level: number; levelSrc: string | null; src: string }[];
    option?: { name: string; trigger: string; spot: string; npcs: number; src: string };
    gaps: string[]; src: string; note?: string;
}
export interface AxeRow {
    item: string; id: number | null; rank: number; hold: Hold; holdSrc: string;
    woodcuttingLevel: number | null; woodcuttingLevelSrc: string; paramLevelrequire: number | null; paramSrc: string | null;
    wieldAttack: number | null; wieldSrc: string | null; successChance: Record<string, { low: number; high: number; src: string }>;
}
export interface PickaxeRow {
    item: string; id: number | null; rank: number; hold: Hold; holdSrc: string;
    miningLevel: number | null; miningLevelSrc: string | null; wieldAttack: number | null; wieldSrc: string | null;
    miningRate: number | null; miningRateSrc: string | null;
}

interface Rung { id: string; skill: string; kind: string; level: number; outputs: { debugname: string | null }[]; inputs: { debugname: string | null }[] }

// ---------- content readers ----------

const fileCache = new Map<string, string[]>();
export function lines(rel: string): string[] {
    let l = fileCache.get(rel);
    if (!l) {
        const p = join(contentRoot(), rel);
        l = existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/) : [];
        fileCache.set(rel, l);
    }
    return l;
}

// First line matching `re` (after the first line matching `after`, when given).
export function cite(rel: string, re: RegExp, after?: RegExp): Cite | null {
    const l = lines(rel);
    let i = 0;
    if (after) {
        i = l.findIndex(x => after.test(x));
        if (i < 0) return null;
    }
    for (; i < l.length; i++) if (re.test(l[i])) return { src: `${rel}:${i + 1}`, text: l[i].trim() };
    return null;
}

interface ObjBlock { name: string; line: number; params: Record<string, { value: string; line: number }> }
function configBlocks(rel: string): Map<string, ObjBlock> {
    const out = new Map<string, ObjBlock>();
    let cur: ObjBlock | null = null;
    lines(rel).forEach((t, i) => {
        const h = /^\[([^\]]+)\]\s*$/.exec(t);
        if (h) { cur = { name: h[1], line: i + 1, params: {} }; out.set(h[1], cur); return; }
        if (!cur) return;
        const p = /^param=([a-z_0-9]+),(.*)$/.exec(t);
        if (p) cur.params[p[1]] = { value: p[2].trim(), line: i + 1 };
        const kv = /^([a-z_0-9]+)=(.*)$/.exec(t);
        if (kv && kv[1] !== 'param' && !(kv[1] in cur.params)) cur.params[kv[1]] = { value: kv[2].trim(), line: i + 1 };
    });
    return out;
}

function walk(rel: string, ext: string): string[] {
    const abs = join(contentRoot(), rel);
    if (!existsSync(abs)) return [];
    const out: string[] = [];
    for (const n of readdirSync(abs)) {
        const r = `${rel}/${n}`;
        if (statSync(join(abs, n)).isDirectory()) out.push(...walk(r, ext));
        else if (n.endsWith(ext)) out.push(r);
    }
    return out.sort();
}

// ---------- knowledge readers ----------

let itemIds: Map<string, number> | null = null;
function itemId(debugname: string): number | null {
    if (!itemIds) {
        itemIds = new Map();
        const p = join(knowledgeDir(), 'items.json');
        if (existsSync(p)) for (const it of JSON.parse(readFileSync(p, 'utf8')) as { id: number; debugname: string }[]) itemIds.set(it.debugname, it.id);
    }
    return itemIds.get(debugname) ?? null;
}

function loadRungs(): Rung[] {
    const p = join(knowledgeDir(), 'ladders.json');
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8')) as { ladders: Record<string, Rung[]> };
    return Object.values(j.ladders).flat();
}

function applies(rungs: Rung[], skill: string, kinds: string[], idPattern?: RegExp): AppliesTo {
    const hit = rungs.filter(r => r.skill === skill && (kinds.length === 0 || kinds.includes(r.kind)) && (!idPattern || idPattern.test(r.id)));
    return { kinds, idPattern: idPattern ? idPattern.source : null, rungs: (kinds.length || idPattern) ? hit.map(r => r.id) : [] };
}

function emptyRecord(id: string, skill: string, appliesTo: AppliesTo, src: string): ToolRecord {
    return { id, skill, appliesTo, minLevel: null, levelSrc: null, items: [], consumed: [], locs: [], conditions: [], gaps: [], src };
}

// ---------- woodcutting axes ----------

const WC_SCRIPT = 'scripts/skill_woodcutting/scripts/woodcut.rs2';
const AXE_OBJ = 'scripts/skill_woodcutting/configs/axes/axes.obj';
const TREES = 'scripts/skill_woodcutting/configs/trees.dbrow';
const PICK_CHECK = 'scripts/skill_mining/scripts/pickaxe_checker.rs2';
const PICK_OBJ = 'scripts/skill_mining/configs/pickaxes.obj';

// Attack level to wield, from levelrequire/scripts/*.rs2 `[opheld2,<obj>]`.
function wieldAttack(obj: string): { level: number | null; src: string | null; gap?: string } {
    for (const f of walk('scripts/levelrequire/scripts', '.rs2')) {
        const c = cite(f, new RegExp(`^\\[opheld2,${obj}\\]`));
        if (!c) continue;
        const m = /@levelrequire_attack\((\d+),/.exec(c.text);
        if (m) return { level: Number(m[1]), src: c.src };
        if (/@tutorial_island_equip/.test(c.text)) {
            const t = cite('scripts/tutorial/scripts/tutorial.rs2', /^@levelrequire_attack\((\d+), \$slot\)/, /^\[label,tutorial_island_equip\]/);
            if (t) return { level: Number(/\((\d+),/.exec(t.text)![1]), src: t.src };
        }
        return { level: null, src: c.src, gap: `${obj}: wield trigger ${c.src} does not call levelrequire_attack` };
    }
    return { level: null, src: null, gap: `${obj}: no [opheld2,${obj}] trigger in levelrequire/scripts` };
}

export function buildAxes(gaps: string[]): AxeRow[] {
    const l = lines(WC_SCRIPT);
    const start = l.findIndex(x => /^\[proc,woodcutting_axe_checker\]/.test(x));
    const objs = configBlocks(AXE_OBJ);
    // Success chance per tree row and axe.
    const chance = new Map<string, Record<string, { low: number; high: number; src: string }>>();
    let row = '';
    lines(TREES).forEach((t, i) => {
        const h = /^\[([^\]]+)\]/.exec(t);
        if (h) { row = h[1]; return; }
        const m = /^data=successchance,([a-z_]+),(\d+),(\d+)/.exec(t);
        if (!m) return;
        const rec = chance.get(m[1]) ?? {};
        rec[row] = { low: Number(m[2]), high: Number(m[3]), src: `${TREES}:${i + 1}` };
        chance.set(m[1], rec);
    });
    const noLevel = cite(WC_SCRIPT, /no wc req in 2004/, /^\[proc,woodcutting_axe_checker\]/);
    const out: AxeRow[] = [];
    if (start < 0) { gaps.push(`woodcutting: [proc,woodcutting_axe_checker] not found in ${WC_SCRIPT}`); return out; }
    for (let i = start + 1; i < l.length && !/^\[/.test(l[i]); i++) {
        if (/^\s*\/\//.test(l[i])) continue;
        const m = /^if \(\(\$obj1 = ([a-z_]+) \| inv_total\(inv, \1\) > 0\)\)/.exec(l[i]);
        if (!m) continue;
        const item = m[1];
        const ob = objs.get(item);
        const w = wieldAttack(item);
        if (w.gap) gaps.push(`woodcutting: ${w.gap}`);
        const pl = ob?.params.levelrequire;
        out.push({
            item, id: itemId(item), rank: out.length + 1, hold: 'either', holdSrc: `${WC_SCRIPT}:${i + 1}`,
            woodcuttingLevel: null, woodcuttingLevelSrc: noLevel ? noLevel.src : `${WC_SCRIPT}:${i + 1}`,
            paramLevelrequire: pl ? Number(pl.value) : null, paramSrc: pl ? `${AXE_OBJ}:${pl.line}` : null,
            wieldAttack: w.level, wieldSrc: w.src, successChance: chance.get(item) ?? {},
        });
        if (!pl) gaps.push(`woodcutting: ${item} has no levelrequire param in ${AXE_OBJ}`);
        if (out.at(-1)!.id === null) gaps.push(`woodcutting: ${item} not in knowledge/items.json`);
    }
    return out;
}

export function buildPickaxes(gaps: string[]): PickaxeRow[] {
    const objs = configBlocks(PICK_OBJ);
    const out: PickaxeRow[] = [];
    lines(PICK_CHECK).forEach((t, i) => {
        const m = /^if \(\$lvl0 >= oc_param\(([a-z_]+), levelrequire\) & \(\$obj1 = \1 \| inv_total\(inv, \1\) > 0\)\)/.exec(t);
        if (!m) return;
        const item = m[1];
        const ob = objs.get(item);
        const lv = ob?.params.levelrequire;
        const rate = ob?.params.mining_rate;
        const w = wieldAttack(item);
        if (w.gap) gaps.push(`mining: ${w.gap}`);
        if (!lv) gaps.push(`mining: ${item} has no levelrequire param in ${PICK_OBJ}`);
        if (!rate) gaps.push(`mining: ${item} has no mining_rate param in ${PICK_OBJ}`);
        out.push({
            item, id: itemId(item), rank: out.length + 1, hold: 'either', holdSrc: `${PICK_CHECK}:${i + 1}`,
            miningLevel: lv ? Number(lv.value) : null, miningLevelSrc: lv ? `${PICK_OBJ}:${lv.line}` : null,
            wieldAttack: w.level, wieldSrc: w.src,
            miningRate: rate ? Number(rate.value) : null, miningRateSrc: rate ? `${PICK_OBJ}:${rate.line}` : null,
        });
    });
    if (!out.length) gaps.push(`mining: no pickaxe lines parsed from ${PICK_CHECK}`);
    return out;
}

// ---------- fishing spots ----------

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
            cur = { file: rel, key: `${h[1]},${h[2]}`, start: i + 1, body: [{ f: rel, n: i + 1, t: h[3] }] };
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
    while (queue.length) {
        const b = queue.shift()!;
        if (seen.has(b.key)) continue;
        seen.add(b.key);
        for (const ln of b.body) {
            const code = ln.t.replace(/\/\/.*$/, '');
            out.push({ f: ln.f, n: ln.n, t: code });
            for (const m of code.matchAll(/@([a-z0-9_]+)/g)) {
                const nb = blocks.get(`label,${m[1]}`);
                if (nb && !m[1].startsWith('macro_')) queue.push(nb);
            }
            for (const m of code.matchAll(/~([a-z0-9_]+)/g)) {
                const nb = blocks.get(`proc,${m[1]}`);
                if (nb) queue.push(nb);
            }
            for (const m of code.matchAll(/p_op(npc|loc)\((\d)\)/g)) {
                const nb = blocks.get(`op${m[1]}${m[2]},${target}`);
                if (nb && nb.key.startsWith(opType)) queue.push(nb);
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
        if (eq && !tools.some(t => t.item === eq[1])) tools.push({ item: eq[1], l: b });
        const fr = /~fish_roll\(([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+)\)/.exec(b.t);
        const frl = /~fish_roll_loc\(([a-z0-9_]+), ([a-z0-9_]+), ([a-z0-9_]+)\)/.exec(b.t);
        const roll = fr ? { f1: fr[1], f2: fr[2], bait: fr[4] } : frl ? { f1: frl[1], f2: frl[2], bait: frl[3] } : null;
        if (roll) {
            if (roll.bait !== 'null' && !baits.has(roll.bait)) baits.set(roll.bait, b);
            addCatch(roll.f1, rec.minLevel!, rec.levelSrc, at(b));
            if (roll.f2 !== 'null') {
                const prev = body.slice(0, i).reverse().find(x => x.t.trim() !== '');
                const g = prev && /if \(stat\(fishing\) >= (\d+)\)/.exec(prev.t);
                if (g) addCatch(roll.f2, Number(g[1]), at(prev!), at(b));
                else rec.gaps.push(`${roll.f2}: no "stat(fishing) >=" gate right before ${at(b)}`);
            }
        }
        const lg = /if \(\$level < (\d+)\)/.exec(b.t);
        if (lg) gate = { level: Number(lg[1]), src: at(b) };
        const del = /inv_del\(inv, ([a-z0-9_]+), 1\)/.exec(b.t);
        if (del) {
            lastDel = del[1];
            if (!baits.has(del[1]) && !rec.consumed.some(c => c.item === del[1])) rec.consumed.push({ item: del[1], id: itemId(del[1]), perAction: 1, src: at(b), note: 'inv_del on this option path' });
        }
        const add = /inv_add\(inv, ([a-z0-9_]+), 1\)/.exec(b.t);
        if (add) {
            if (lastDel && tools.some(t => t.item === lastDel)) { returns.add(add[1]); lastDel = null; }
            else addCatch(add[1], gate ? Math.max(gate.level, rec.minLevel!) : rec.minLevel!, gate ? gate.src : rec.levelSrc, at(b));
        }
        const it = /inv_total\(inv, ([a-z0-9_]+)\) < 1/.exec(b.t);
        if (it && !tools.some(t => t.item === it[1])) tools.push({ item: it[1], l: b });
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
    for (const [target, g] of groups) {
        for (const [n, op] of g.ops) {
            const t = findTrigger(`opnpc${n},${target}`);
            if (!t) {
                const elsewhere = walk('scripts', '.rs2').map(f => cite(f, new RegExp(`^\\[opnpc${n},[a-z0-9_]*fishspot\\]`))).find(Boolean);
                gaps.push(`fishing: ${target} op${n} "${op.name}" (${op.src}) has no [opnpc${n},${target}] handler under ${FISH_DIR}${elsewhere ? `; its npcs are handled by name at ${elsewhere.src} (not a skill method)` : ''}`);
                continue;
            }
            const r = fishOption(all, t, 'opnpc', target, rungs, baitOf);
            out.push({ ...r, id: `fishing/spot/${target.replace(/^_/, '')}/op${n}`, option: { name: op.name, trigger: `[opnpc${n},${target}]`, spot: target, npcs: g.npcs, src: op.src } });
        }
    }
    // Loc spots: names from the unpacked loc dump.
    const locKeys = new Set<string>();
    for (const k of all.keys()) { const m = /^oploc\d,(.+)$/.exec(k); if (m) locKeys.add(m[1]); }
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

// ---------- anchored production records ----------

// `block`: the names may be anywhere in the block that starts at the cited line.
interface Anchor { file: string; re: RegExp; after?: RegExp; block?: boolean }
interface Spec {
    id: string; skill: string; kinds: string[]; idPattern?: RegExp; note?: string;
    level?: Anchor & { value: number };
    items?: { anyOf: string[]; hold: Hold; role: ItemNeed['role']; at: Anchor; note?: string }[];
    consumed?: { items: string[]; perAction: number | null; at: Anchor; note?: string }[];
    locs?: { anyOf: string[]; at: Anchor }[];
    conditions?: Anchor[];
    // The line that sends the item used on the loc to this method.
    dispatch?: Anchor;
    gaps?: string[];
}

const S = 'scripts/';
const SMITH = `${S}skill_smithing/scripts/smithing/smithing.rs2`;
const SMELT = `${S}skill_smithing/scripts/smelting/smelting.rs2`;
const CANNON = `${S}skill_smithing/scripts/smelting/cannonballs.rs2`;
const GEM = `${S}skill_crafting/scripts/gem/uncut_gem.rs2`;
const LEATHER = `${S}skill_crafting/scripts/leather/leather.rs2`;
const GLASS = `${S}skill_crafting/scripts/glass/glass.rs2`;
const JEWEL = `${S}skill_crafting/scripts/jewellery/jewellery.rs2`;
const JEWEL_STRUCT = `${S}skill_crafting/configs/jewellery/jewellery.struct`;
const POTTERY = `${S}skill_crafting/scripts/pottery/pottery.rs2`;
const SPIN = `${S}skill_crafting/scripts/spinning/spinning.rs2`;
const STAFF = `${S}skill_crafting/scripts/battlestaves/battlestaves.rs2`;
const CUTLOG = `${S}skill_fletching/scripts/cut_logs.rs2`;
const BOLTS = `${S}skill_fletching/scripts/bolts.rs2`;
const ARROWS = `${S}skill_fletching/scripts/arrows.rs2`;
const DARTS = `${S}skill_fletching/scripts/darts.rs2`;
const BOWS = `${S}skill_fletching/scripts/bows.rs2`;
const FM = `${S}skill_firemaking/scripts/firemaking.rs2`;
const BREW = `${S}skill_herblore/scripts/brewing/brew_potion.rs2`;
const GRIND = `${S}skill_herblore/scripts/grinding/grind_ingredient.rs2`;
const GRINDABLES = `${S}skill_herblore/configs/grinding/grindables.obj`;
const IDENT = `${S}skill_herblore/scripts/identifying/identify.rs2`;
const COOK = `${S}skill_cooking/scripts/cooking.rs2`;
const WINE = `${S}skill_cooking/scripts/cooking_inv/scripts/wine/wine.rs2`;
const RC = `${S}skill_runecraft/scripts/runecraft.rs2`;
const CHEST = `${S}skill_thieving/scripts/chest/trapped_chest.rs2`;
const GUILD = `${S}skill_fishing/scripts/fishing_guild.rs2`;
const MINING = `${S}skill_mining/scripts/mining.rs2`;
const MEMBERS = /map_members = \^false/;

const SPECS: Spec[] = [
    {
        id: 'woodcutting/axe', skill: 'woodcutting', kinds: ['woodcutting_trees'],
        note: 'any axe in the axes table; the best one held or worn is used; no Woodcutting level gates the axe',
        items: [{ anyOf: ['bronze_axe', 'iron_axe', 'steel_axe', 'black_axe', 'mithril_axe', 'adamant_axe', 'rune_axe'], hold: 'either', role: 'tool', at: { file: WC_SCRIPT, re: /case bronze_axe, iron_axe, steel_axe, black_axe, mithril_axe, adamant_axe, rune_axe :/ } }],
    },
    {
        id: 'mining/pickaxe', skill: 'mining', kinds: ['mining_table'],
        note: 'any pickaxe in the pickaxes table whose levelrequire is at or below Mining; the best one held or worn is used',
        items: [{ anyOf: ['bronze_pickaxe', 'iron_pickaxe', 'steel_pickaxe', 'mithril_pickaxe', 'adamant_pickaxe', 'rune_pickaxe'], hold: 'either', role: 'tool', at: { file: PICK_CHECK, re: /^\[proc,pickaxe_checker\]/, block: true } }],
        conditions: [{ file: MINING, re: /def_obj \$pickaxe = ~pickaxe_checker;/ }],
    },
    {
        id: 'smithing/anvil', skill: 'smithing', kinds: ['smithing'],
        items: [{ anyOf: ['hammer'], hold: 'held', role: 'tool', at: { file: SMITH, re: /if \(inv_total\(inv, hammer\) < 1\)/, after: /^\[label,smithing_anvil_interface\]/ } }],
        consumed: [{ items: [], perAction: null, at: { file: SMITH, re: /%smithbars = inv_total\(inv, struct_param\(\$struct, namedobj\)\);/ }, note: 'bars per the ladder rung inputs' }],
        locs: [{ anyOf: ['_anvil'], at: { file: SMITH, re: /^\[oplocu,_anvil\]/ } }],
        conditions: [{ file: SMITH, re: /if\(loc_type = doric_anvil\)/ }, { file: SMITH, re: /if\(%viking < \^viking_complete\)/ }],
    },
    {
        id: 'smithing/furnace', skill: 'smithing', kinds: ['smelt'],
        items: [
            { anyOf: ['ring_of_forging'], hold: 'worn', role: 'bonus', at: { file: SMELT, re: /inv_total\(worn, ring_of_forging\) > 0 & map_members = \^true/ }, note: 'iron bar: no 50% impure fail while worn (members world)' },
            { anyOf: ['gauntlets_of_goldsmithing'], hold: 'worn', role: 'bonus', at: { file: SMELT, re: /\$product = gold_bar & inv_total\(worn, gauntlets_of_goldsmithing\) > 0/ }, note: 'gold bar XP x2.5 while worn' },
        ],
        consumed: [{ items: [], perAction: null, at: { file: SMELT, re: /inv_del\(inv, struct_param\(\$struct, ingredient\), struct_param\(\$struct, bar_count\)\);/ }, note: 'ores per the ladder rung inputs' }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        conditions: [{ file: SMELT, re: /if\(loc_type = viking_furnace \| loc_type = viking_furnace2\)/ }, { file: SMELT, re: /if \(\$product = iron_bar\)/ }],
    },
    {
        id: 'smithing/cannonball', skill: 'smithing', kinds: [], idPattern: /cannonball/,
        level: { file: CANNON, re: /if \(stat\(smithing\) < 35\)/, value: 35 },
        items: [{ anyOf: ['ammo_mould'], hold: 'held', role: 'tool', at: { file: CANNON, re: /if \(inv_total\(inv, ammo_mould\) < 1\)/ } }],
        consumed: [{ items: ['steel_bar'], perAction: 1, at: { file: CANNON, re: /if \(inv_total\(inv, steel_bar\) < 1\)/ } }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case steel_bar : @smelt_cannonballs;/ },
        conditions: [{ file: CANNON, re: MEMBERS }],
    },
    {
        id: 'crafting/gem-cutting', skill: 'crafting', kinds: ['gem_cutting_table'],
        items: [{ anyOf: ['chisel'], hold: 'held', role: 'tool', at: { file: GEM, re: /^\[opheldu,chisel\]/, block: true } }],
        consumed: [{ items: [], perAction: 1, at: { file: GEM, re: /db_find\(gem_cutting_table:uncut_gem, \$uncut_gem\);/ }, note: 'one uncut gem per the ladder rung inputs' }],
        conditions: [{ file: GEM, re: /if \(oc_members\(\$uncut_gem\) = true\)/ }],
    },
    {
        id: 'crafting/leather', skill: 'crafting', kinds: ['craft_leather_table'],
        items: [
            { anyOf: ['needle'], hold: 'held', role: 'tool', at: { file: LEATHER, re: /^\[opheldu,needle\]/ } },
            { anyOf: ['thread'], hold: 'held', role: 'bait', at: { file: LEATHER, re: /if \(inv_total\(inv, thread\) < 1\)/ } },
        ],
        consumed: [{ items: ['thread'], perAction: 0.2, at: { file: LEATHER, re: /if \(%thread_used > 4\)/, block: true }, note: 'one thread per 5 items made' }],
    },
    {
        id: 'crafting/glassblowing', skill: 'crafting', kinds: ['glass'],
        items: [{ anyOf: ['glassblowingpipe'], hold: 'held', role: 'tool', at: { file: GLASS, re: /^\[opheldu,glassblowingpipe\]/ } }],
        consumed: [{ items: ['molten_glass'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, molten_glass, 1\);/ } }],
    },
    {
        id: 'crafting/molten-glass', skill: 'crafting', kinds: [], note: 'supply step for glassblowing; no ladder rung',
        consumed: [
            { items: ['bucket_sand'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, bucket_sand, 1\);/ } },
            { items: ['soda_ash'], perAction: 1, at: { file: GLASS, re: /inv_del\(inv, soda_ash, 1\);/ } },
        ],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case bucket_sand, soda_ash : @smelt_glass;/ },
    },
    ...(['ring', 'necklace', 'amulet'] as const).map((k): Spec => ({
        id: `crafting/jewellery-gold-${k}`, skill: 'crafting', kinds: ['jewellery'], idPattern: new RegExp(`^crafting/jewellery-[a-z]+-${k}$`),
        items: [{ anyOf: [`${k}_mould`], hold: 'held', role: 'tool', at: { file: JEWEL, re: new RegExp(`if \\(inv_total\\(inv, ${k}_mould\\) > 0\\)`) } }],
        consumed: [
            { items: ['gold_bar'], perAction: 1, at: { file: SMELT, re: /case gold_bar, perfect_gold_bar : @craft_gold_interface;/ }, note: `one bar per item (${JEWEL} "inv_del(inv, $bar, 1)"); perfect_gold_bar is used first when held` },
            { items: [], perAction: 1, at: { file: JEWEL, re: /inv_del\(inv, \$gem, 1\);/ }, note: 'the gem named by the rung, if any' },
        ],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case gold_bar, perfect_gold_bar : @craft_gold_interface;/ },
    })),
    ...([['holy-symbol', 'holy_symbol_mould'], ['unholy-symbol', 'unholy_symbol_mould']] as const).map(([k, mould]): Spec => ({
        id: `crafting/jewellery-${k}`, skill: 'crafting', kinds: ['jewellery'], idPattern: new RegExp(`^crafting/jewellery-${k}$`),
        items: [{ anyOf: [mould], hold: 'held', role: 'tool', at: { file: JEWEL_STRUCT, re: new RegExp(`^param=mould,${mould}$`) }, note: `checked at ${JEWEL} "inv_total(inv, $mould) = 0"` }],
        consumed: [{ items: ['silver_bar'], perAction: 1, at: { file: JEWEL, re: /inv_del\(inv, silver_bar, 1\);/ } }],
        locs: [{ anyOf: ['_smithing_furnace'], at: { file: SMELT, re: /^\[oplocu,_smithing_furnace\]/ } }],
        dispatch: { file: SMELT, re: /case silver_bar : @craft_silver;/ },
    })),
    {
        id: 'crafting/pottery', skill: 'crafting', kinds: ['pottery'],
        consumed: [{ items: ['softclay'], perAction: 1, at: { file: POTTERY, re: /case softclay : @craft_pottery_interface;/ }, note: 'softclay = clay + a water container' }],
        locs: [
            { anyOf: ['_potters_wheel'], at: { file: POTTERY, re: /^\[oplocu,_potters_wheel\]/ } },
            { anyOf: ['_pottery_oven'], at: { file: POTTERY, re: /^\[oplocu,_pottery_oven\]/ } },
        ],
        conditions: [{ file: POTTERY, re: /case bowl_water, bucket_water, jug_water : @make_softclay/ }],
    },
    {
        id: 'crafting/spinning', skill: 'crafting', kinds: ['spin'],
        consumed: [{ items: ['wool'], perAction: 1, at: { file: SPIN, re: /case wool : @craft_spinning/ }, note: 'or flax, per the rung' }],
        locs: [{ anyOf: ['_spinning_wheel'], at: { file: SPIN, re: /^\[oplocu,_spinning_wheel\]/ } }],
        conditions: [{ file: SPIN, re: MEMBERS, after: /case flax :/ }],
    },
    {
        id: 'crafting/battlestaff', skill: 'crafting', kinds: ['staff'], note: 'no tool',
        consumed: [
            { items: ['battlestaff'], perAction: 1, at: { file: STAFF, re: /^\[opheldu,battlestaff\]/ } },
            { items: [], perAction: 1, at: { file: STAFF, re: /case air_orb, fire_orb, water_orb, earth_orb : @craft_staff/ }, note: 'the rung orb: air_orb, fire_orb, water_orb or earth_orb' },
        ],
        conditions: [{ file: STAFF, re: MEMBERS }],
    },
    {
        id: 'fletching/cut-logs', skill: 'fletching', kinds: [], note: 'knife on logs; knowledge/ladders.json holds no log-cutting rung',
        items: [{ anyOf: ['knife'], hold: 'held', role: 'tool', at: { file: CUTLOG, re: /case knife : @fletch_log\(last_item\);/ } }],
        conditions: [{ file: CUTLOG, re: MEMBERS, after: /^\[label,fletch_log\]/ }],
    },
    {
        id: 'fletching/bolt-tips', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_tips$/,
        items: [{ anyOf: ['chisel'], hold: 'held', role: 'tool', at: { file: GEM, re: /^\[opheldu,chisel\]/, block: true }, note: 'chisel on opal or oyster pearls calls make_bolt_tips' }],
        consumed: [{ items: [], perAction: 1, at: { file: BOLTS, re: /inv_del\(inv, \$item, 1\);/, after: /^\[label,make_bolt_tips\]/ }, note: 'one gem or pearl per the rung input' }],
        conditions: [{ file: BOLTS, re: MEMBERS, after: /^\[label,make_bolt_tips\]/ }],
    },
    {
        id: 'fletching/arrows', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_arrow$/, note: 'no tool',
        consumed: [
            { items: ['headless_arrow'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, headless_arrow, \$arrows_count\);/ }, note: 'plus one arrowtip per the rung' },
            { items: ['feather'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, feather, \$arrow_count\);/ }, note: 'headless arrow step' },
            { items: ['arrow_shaft'], perAction: 1, at: { file: ARROWS, re: /inv_del\(inv, arrow_shaft, \$arrow_count\);/ }, note: 'headless arrow step' },
        ],
        conditions: [{ file: ARROWS, re: MEMBERS }],
    },
    {
        id: 'fletching/darts', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_dart$/, note: 'no tool',
        consumed: [{ items: ['feather'], perAction: 1, at: { file: DARTS, re: /inv_del\(inv, feather, \$darts_count\);/ }, note: 'plus one dart tip per the rung' }],
        conditions: [{ file: DARTS, re: MEMBERS }],
    },
    {
        id: 'fletching/bolts', skill: 'fletching', kinds: ['fletching_table'], idPattern: /_bolts$/, note: 'no tool',
        consumed: [{ items: ['bolt'], perAction: 1, at: { file: BOLTS, re: /inv_del\(inv, bolt, \$bolts_count\);/ }, note: 'plus one bolt tip per the rung' }],
        conditions: [{ file: BOLTS, re: MEMBERS, after: /^\[label,make_bolts\]/ }],
    },
    {
        id: 'fletching/stringing', skill: 'fletching', kinds: ['fletching_table'], idPattern: /^fletching\/stringing_/, note: 'no tool',
        consumed: [{ items: ['bow_string'], perAction: 1, at: { file: BOWS, re: /inv_del\(inv, bow_string, 1\);/ }, note: 'plus the unstrung bow' }],
        conditions: [{ file: BOWS, re: MEMBERS }],
    },
    {
        id: 'firemaking/burn', skill: 'firemaking', kinds: ['burn'],
        items: [{ anyOf: ['tinderbox'], hold: 'held', role: 'tool', at: { file: FM, re: /if\(inv_total\(inv, tinderbox\) < 1\)/ } }],
        consumed: [{ items: [], perAction: 1, at: { file: FM, re: /def_int \$level = oc_param\(\$log, levelrequire\);/ }, note: 'one log per the rung; the log levelrequire param is the Firemaking level' }],
    },
    {
        id: 'herblore/potion', skill: 'herblore', kinds: ['potion'], note: 'no tool; herb + vial_water makes the unfinished potion, then the secondary',
        consumed: [{ items: ['vial_water'], perAction: 1, at: { file: BREW, re: /^\[opheldu,vial_water\]/ }, note: 'plus the herb and secondary per the rung' }],
        conditions: [{ file: BREW, re: MEMBERS }],
    },
    {
        id: 'herblore/identify', skill: 'herblore', kinds: ['identify'], note: 'no tool',
        conditions: [{ file: IDENT, re: MEMBERS }],
    },
    {
        id: 'cooking/heat-source', skill: 'cooking', kinds: ['cooking_generic'],
        items: [{ anyOf: ['gauntlets_of_cooking'], hold: 'worn', role: 'bonus', at: { file: COOK, re: /inv_total\(worn, gauntlets_of_cooking\) > 0/ }, note: 'uses the row successchance_gauntlets while worn' }],
        locs: [
            { anyOf: ['_cooking_oven'], at: { file: COOK, re: /^\[oplocu,_cooking_oven\]/ } },
            { anyOf: ['_cooking_fire'], at: { file: COOK, re: /^\[oplocu,_cooking_fire\]/ } },
        ],
        conditions: [{ file: COOK, re: /loc_type = cooksquestrange/ }],
        note: 'a range (_cooking_oven) or a fire (_cooking_fire); range rows may use successchance_range',
    },
    {
        id: 'cooking/wine', skill: 'cooking', kinds: ['wine'], note: 'no tool',
        level: { file: WINE, re: /if \(stat\(cooking\) < 35\)/, value: 35 },
        consumed: [
            { items: ['grapes'], perAction: 1, at: { file: WINE, re: /inv_del\(inv, grapes, 1\);/ } },
            { items: ['jug_water'], perAction: 1, at: { file: WINE, re: /inv_del\(inv, jug_water, 1\);/ } },
        ],
    },
    {
        id: 'runecraft/altar', skill: 'runecraft', kinds: ['runecraft_table'],
        items: [{ anyOf: ['_talismans'], hold: 'held', role: 'access', at: { file: RC, re: /if \(oc_category\(last_useitem\) = talismans\)/ }, note: 'the rung talisman (ladder requires) is used on the ruins; it is not consumed' }],
        consumed: [{ items: ['blankrune'], perAction: null, at: { file: RC, re: /inv_del\(inv, blankrune, \$total_ess\);/ }, note: 'all essence held is used in one action' }],
        locs: [
            { anyOf: ['_rc_ruins'], at: { file: RC, re: /^\[oplocu,_rc_ruins\]/ } },
            { anyOf: ['_rc_altar'], at: { file: RC, re: /^\[oploc1,_rc_altar\]/ } },
        ],
        gaps: ['no .rs2 or .obj file under content/scripts names a tiara; only a talisman used on the ruins enters the altar'],
    },
    {
        id: 'thieving/locked-chest', skill: 'thieving', kinds: ['trapped_chest'], idPattern: /chest_steel_arrowtips$/,
        items: [{ anyOf: ['lockpick'], hold: 'held', role: 'tool', at: { file: CHEST, re: /if \(inv_total\(inv, lockpick\) < 1\)/ } }],
    },
    {
        id: 'fishing/guild-entry', skill: 'fishing', kinds: [], note: 'entry gate for the Fishing Guild spots',
        level: { file: GUILD, re: /if \(stat\(fishing\) < 68\)/, value: 68 },
    },
];

function fromSpec(sp: Spec, rungs: Rung[]): ToolRecord {
    const rec = emptyRecord(sp.id, sp.skill, applies(rungs, sp.skill, sp.kinds, sp.idPattern), '');
    if (sp.note) rec.note = sp.note;
    const miss = (a: Anchor) => rec.gaps.push(`anchor not found: ${a.file} /${a.re.source}/`);
    const check = (names: string[], c: Cite, a: Anchor) => {
        let text = c.text;
        if (a.block) {
            const l = lines(a.file);
            const start = Number(c.src.split(':').pop()) - 1;
            const end = l.findIndex((x, i) => i > start && /^\[/.test(x));
            text = l.slice(start, end < 0 ? l.length : end).join('\n');
        }
        // A category name may appear with its `_` (trigger) or without it (oc_category test).
        for (const n of names) if (!new RegExp(`(^|[^a-z0-9_])${n.startsWith('_') ? '_?' : ''}${n.replace(/^_/, '')}\\b`).test(text)) rec.gaps.push(`${n} is not on ${c.src}${a.block ? ' or its block' : ''}: ${c.text}`);
    };
    if (sp.level) {
        const c = cite(sp.level.file, sp.level.re, sp.level.after);
        if (c && c.text.includes(String(sp.level.value))) { rec.minLevel = sp.level.value; rec.levelSrc = c.src; } else miss(sp.level);
    }
    for (const it of sp.items ?? []) {
        const c = cite(it.at.file, it.at.re, it.at.after);
        if (!c) { miss(it.at); continue; }
        check(it.anyOf, c, it.at);
        rec.items.push({ anyOf: it.anyOf, ids: it.anyOf.map(n => n.startsWith('_') ? null : itemId(n)), hold: it.hold, role: it.role, src: c.src, ...(it.note ? { note: it.note } : {}) });
        for (const n of it.anyOf) if (!n.startsWith('_') && itemId(n) === null) rec.gaps.push(`${n} not in knowledge/items.json`);
    }
    for (const cs of sp.consumed ?? []) {
        const c = cite(cs.at.file, cs.at.re, cs.at.after);
        if (!c) { miss(cs.at); continue; }
        check(cs.items, c, cs.at);
        if (!cs.items.length) rec.consumed.push({ item: '(rung input)', id: null, perAction: cs.perAction, src: c.src, ...(cs.note ? { note: cs.note } : {}) });
        for (const n of cs.items) rec.consumed.push({ item: n, id: itemId(n), perAction: cs.perAction, src: c.src, ...(cs.note ? { note: cs.note } : {}) });
    }
    for (const l of sp.locs ?? []) {
        const c = cite(l.at.file, l.at.re, l.at.after);
        if (!c) { miss(l.at); continue; }
        check(l.anyOf, c, l.at);
        rec.locs.push({ anyOf: l.anyOf, src: c.src });
    }
    for (const a of [...(sp.dispatch ? [sp.dispatch] : []), ...(sp.conditions ?? [])]) {
        const c = cite(a.file, a.re, a.after);
        if (c) rec.conditions.push({ text: c.text, src: c.src }); else miss(a);
    }
    rec.gaps.push(...(sp.gaps ?? []));
    rec.src = rec.items[0]?.src ?? rec.locs[0]?.src ?? rec.consumed[0]?.src ?? rec.levelSrc ?? rec.conditions[0]?.src ?? '';
    if (sp.kinds.length && !rec.appliesTo.rungs.length) rec.gaps.push(`no ladder rung matches kinds ${sp.kinds.join(',')}${sp.idPattern ? ` and /${sp.idPattern.source}/` : ''}`);
    return rec;
}

// Grindable secondaries: pestle_and_mortar held, applies to potion rungs whose inputs include the ground product.
function grindRecords(rungs: Rung[], gaps: string[]): ToolRecord[] {
    const tool = cite(GRIND, /if \(\$used_with ! pestle_and_mortar\)/);
    const members = cite(GRIND, MEMBERS);
    if (!tool) { gaps.push(`herblore: pestle_and_mortar check not found in ${GRIND}`); return []; }
    const out: ToolRecord[] = [];
    for (const [raw, ob] of configBlocks(GRINDABLES)) {
        const p = ob.params.grindable_ingredient_refined;
        if (!p) continue;
        const hits = rungs.filter(r => r.skill === 'herblore' && r.inputs.some(i => i.debugname === p.value)).map(r => r.id);
        const rec = emptyRecord(`herblore/grind-${raw}`, 'herblore', { kinds: ['potion'], idPattern: null, rungs: hits }, tool.src);
        rec.items.push({ anyOf: ['pestle_and_mortar'], ids: [itemId('pestle_and_mortar')], hold: 'held', role: 'tool', src: tool.src });
        rec.consumed.push({ item: raw, id: itemId(raw), perAction: 1, src: `${GRINDABLES}:${p.line}`, note: `ground into ${p.value}` });
        if (members) rec.conditions.push({ text: members.text, src: members.src });
        rec.note = `makes ${p.value}, a potion secondary`;
        out.push(rec);
    }
    // A *_dust secondary with no grind recipe has no known tool.
    const made = new Set(out.map(r => r.note!.split(' ')[1].replace(/,$/, '')));
    const dusts = new Set(rungs.filter(r => r.skill === 'herblore').flatMap(r => r.inputs.map(i => i.debugname ?? '')).filter(n => n.endsWith('_dust') && !made.has(n)));
    for (const d of dusts) gaps.push(`herblore: ${d} is a potion input but ${GRINDABLES} has no grind recipe that makes it`);
    return out;
}

// Methods with no item check: scan the trigger scripts and list every inv/worn check found, so an empty list is evidence.
function scanRecord(id: string, skill: string, kinds: string[], dir: string, rungs: Rung[], idPattern?: RegExp, exclude?: RegExp): ToolRecord {
    const files = (dir.endsWith('.rs2') ? [dir] : walk(dir, '.rs2')).filter(f => !exclude || !exclude.test(f));
    const rec = emptyRecord(id, skill, applies(rungs, skill, kinds, idPattern), dir);
    for (const f of files) lines(f).forEach((t, i) => {
        const m = /inv_total\((inv|worn), *([a-z0-9_]+)\)|inv_getobj\(worn/.exec(t);
        if (m) rec.conditions.push({ text: t.trim(), src: `${f}:${i + 1}` });
    });
    rec.note = rec.conditions.length
        ? `scan of ${files.length} script file(s) found the item checks in conditions; none is a tool gate for this method`
        : `scan of ${files.length} script file(s) found no inv or worn item check`;
    return rec;
}

export function buildSkillTools() {
    const gaps: string[] = [];
    const rungs = loadRungs();
    if (!rungs.length) gaps.push('knowledge/ladders.json missing or empty; appliesTo.rungs are empty');
    const axes = buildAxes(gaps);
    const pickaxes = buildPickaxes(gaps);
    const fishing = buildFishing(rungs, gaps);
    const records: ToolRecord[] = [];
    for (const sp of SPECS) records.push(fromSpec(sp, rungs));
    // Per-tier woodcutting and mining records feed the axe and pickaxe tables into the record list.
    const wc = records.find(r => r.id === 'woodcutting/axe')!;
    const mn = records.find(r => r.id === 'mining/pickaxe')!;
    const pickRec = (p: PickaxeRow): ToolRecord => ({
        ...emptyRecord(`mining/pickaxe/${p.item}`, 'mining', mn.appliesTo, p.holdSrc),
        minLevel: p.miningLevel, levelSrc: p.miningLevelSrc,
        items: [{ anyOf: [p.item], ids: [p.id], hold: p.hold, role: 'tool', src: p.holdSrc, note: `wield Attack ${p.wieldAttack ?? '?'} (${p.wieldSrc}); mining_rate ${p.miningRate} (${p.miningRateSrc})` }],
    });
    const axeRec = (a: AxeRow): ToolRecord => ({
        ...emptyRecord(`woodcutting/axe/${a.item}`, 'woodcutting', wc.appliesTo, a.holdSrc),
        minLevel: null, levelSrc: a.woodcuttingLevelSrc,
        items: [{ anyOf: [a.item], ids: [a.id], hold: a.hold, role: 'tool', src: a.holdSrc, note: `wield Attack ${a.wieldAttack ?? '?'} (${a.wieldSrc}); levelrequire param ${a.paramLevelrequire} (${a.paramSrc}) is not read by woodcut.rs2` }],
        note: 'woodcutting_axe_checker has no Woodcutting level check',
    });
    records.push(...axes.map(axeRec), ...pickaxes.map(pickRec), ...fishing, ...grindRecords(rungs, gaps));
    records.push(
        scanRecord('thieving/pickpocket', 'thieving', ['pickpocket'], `${S}skill_thieving/scripts/pickpocketing`, rungs),
        scanRecord('thieving/stall', 'thieving', ['stealing'], `${S}skill_thieving/scripts/stalls`, rungs),
        scanRecord('thieving/trapped-chest', 'thieving', ['trapped_chest'], CHEST, rungs, /^(?!.*chest_steel_arrowtips$)/),
        scanRecord('agility/course', 'agility', ['course'], `${S}skill_agility/scripts`, rungs),
        scanRecord('prayer/bury', 'prayer', ['bury'], `${S}skill_prayer/scripts/bury_bone.rs2`, rungs),
    );
    // The trapped-chest scan covers the whole file; mark the lockpick line as belonging to the locked-chest record.
    const tc = records.find(r => r.id === 'thieving/trapped-chest')!;
    tc.note = `${tc.note}. Only chest_steel_arrowtips calls attempt_locked_chest (lockpick); see thieving/locked-chest`;
    for (const r of records) if (!r.id.startsWith('fishing/spot/')) for (const g of r.gaps) gaps.push(`${r.id}: ${g}`);
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.skill] = (counts[r.skill] ?? 0) + 1;
    return {
        generatedBy: 'bun packages/knowledge/src/skill-tools.ts',
        notes: [
            'src is a content-relative path and 1-based line under vendor/rs-sdk/server/content.',
            'hold: held = in the inventory; worn = equipped; either = equipped right hand or inventory.',
            'A name that starts with _ is a content category (loc or obj) as the trigger writes it.',
            'role: tool = needed and kept; bait = needed and consumed per success; access = needed to reach the method; bonus = optional, changes the result.',
            'consumed.perAction null means the amount depends on the stack held (see note).',
            'appliesTo.rungs lists the knowledge/ladders.json rung ids the record covers.',
        ],
        counts, axes, pickaxes, records, gaps,
    };
}

if (import.meta.main) {
    const out = buildSkillTools();
    writeFileSync(join(knowledgeDir(), 'skill-tools.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`skill-tools: ${out.records.length} records, ${out.axes.length} axes, ${out.pickaxes.length} pickaxes, ${out.gaps.length} gaps`);
    console.log(JSON.stringify(out.counts));
}
