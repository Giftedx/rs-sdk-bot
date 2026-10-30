import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { parseJm2 } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';
import { cleanLines } from './text';
import { parseCoord } from './transports';

// Every teleport the rev 289 content implements: Standard spellbook spells, enchanted jewellery,
// item teleports, levers, NPC teleports, spirit trees, runecraft ruins and portals, magic doors.
// Each value is read from a content line and carries `src` (content-relative path:1-based line).
// The content has no Ancient spellbook, no teleport tablets, no home teleport, no house teleport,
// no Ape Atoll teleport and no teleblock. Random-event teleports are not listed: random events are off.

export type Kind = 'spell' | 'jewellery' | 'item' | 'lever' | 'npc' | 'spirit_tree' | 'runecraft_ruins' | 'runecraft_portal' | 'loc';
export interface Tile { x: number; z: number; level: number; src: string; wilderness: number }
export interface Box { minX: number; maxX: number; minZ: number; maxZ: number; level: number }
export interface Destination {
    option: string | null;       // dialogue option text that selects this destination
    candidates: Tile[];          // the script picks one at random when there are several
    minRadius: number;           // map_findsquare ring around the candidate (0/0 = exact tile)
    maxRadius: number;
    findsquare: 'lineofwalk' | 'lineofsight' | 'none' | null; // null: exact tile, no map_findsquare
    box: Box | null;             // bounding box of possible arrival tiles for one candidate
    when?: string;               // condition that selects this destination
    moveSrc: string;             // the line that moves the player
}
export type Requirement =
    | { type: 'skill'; skill: string; level: number; src: string }
    | { type: 'members'; src: string }
    | { type: 'varp'; varp: string; op: '>=' | '<' | '='; value: number; quest: string | null; message: string | null; src: string[] }
    | { type: 'worn'; item: string; id: number | null; src: string }
    | { type: 'held'; item: string; id: number | null; src: string }
    | { type: 'note'; text: string; src: string };
export interface Rune { item: string; id: number | null; count: number; src: string }
export interface Charge { item: string; id: number | null; charges: number; next: string | null; src: string }
export interface Teleport {
    id: string;
    kind: Kind;
    name: string;
    trigger: string;
    triggerSrc: string;
    from: Tile[] | null;          // null: usable anywhere the limits allow
    requires: Requirement[];
    wildernessMax: { level: number; src: string } | null; // blocked when wilderness level > level
    runes: Rune[];
    charges: Charge[];
    xp: { skill: string; xp: number; tenths: number; src: string } | null;
    to: Destination[];
    gaps: string[];
}
export interface TeleportsOut {
    rev: number;
    teleports: Teleport[];
    staffs: { rune: string; staffs: string[]; src: string }[];
    rules: { text: string; src: string }[];
    wildernessZones: { from: { x: number; z: number; level: number }; to: { x: number; z: number; level: number }; src: string }[];
    counts: Record<string, number>;
    unplaced: string[];          // teleport loc configs with no map spawn
    gaps: string[];
}

const root = contentRoot();
const fileCache = new Map<string, string[]>();
function lines(rel: string): string[] {
    let l = fileCache.get(rel);
    if (!l) { l = readFileSync(join(root, rel), 'utf8').split('\n').map(s => s.replace(/\r$/, '')); fileCache.set(rel, l); }
    return l;
}
const at = (rel: string, i: number) => `${rel}:${i + 1}`;

// First line index >= start whose code (comments removed) matches re. Throws: a missing anchor is a content change.
function find(rel: string, re: RegExp, start = 0, end?: number): { i: number; m: RegExpMatchArray } {
    const clean = cleanLines(lines(rel).join('\n'));
    for (let i = start; i < (end ?? clean.length); i++) {
        const m = clean[i]!.match(re);
        if (m) return { i, m };
    }
    throw new Error(`${rel}: no line matches ${re}`);
}
function findAll(rel: string, re: RegExp, start = 0, end?: number): { i: number; m: RegExpMatchArray }[] {
    const clean = cleanLines(lines(rel).join('\n'));
    const out: { i: number; m: RegExpMatchArray }[] = [];
    for (let i = start; i < (end ?? clean.length); i++) { const m = clean[i]!.match(re); if (m) out.push({ i, m }); }
    return out;
}
// The [header] block that starts at line index h: [h, next header).
function blockEnd(rel: string, h: number): number {
    const l = lines(rel);
    for (let i = h + 1; i < l.length; i++) if (l[i]!.startsWith('[')) return i;
    return l.length;
}
function block(rel: string, header: RegExp): { start: number; end: number; head: string } {
    const { i } = find(rel, header);
    return { start: i, end: blockEnd(rel, i), head: lines(rel)[i]!.replace(/\s*\/\/.*$/, '') };
}

// Constants: ^name = value from every .constant file.
const constants = new Map<string, { value: string; src: string }>();
for (const f of listConfigFiles('.constant')) {
    cleanLines(readFileSync(join(root, f), 'utf8')).forEach((l, i) => {
        const m = l.match(/^\^(\w+)\s*=\s*(.+?);?$/);
        if (m) constants.set(m[1]!, { value: m[2]!.trim(), src: `${f}:${i + 1}` });
    });
}
function constant(name: string): { value: string; src: string } {
    const c = constants.get(name);
    if (!c) throw new Error(`constant ^${name} not found`);
    return c;
}

const objIds = new Map([...parsePack(readFileSync(join(root, 'pack', 'obj.pack'), 'utf8'))].map(([id, n]) => [n, id]));
const itemId = (n: string) => objIds.get(n) ?? null;

// Wilderness level: wilderness_levels.rs2 returns (z - z1)/8 + 1 inside a coord_pair zone, else 0.
const WILD_DB = 'scripts/areas/area_wilderness/configs/wilderness_zones.dbrow';
const WILD_PROC = 'scripts/areas/area_wilderness/scripts/wilderness_levels.rs2';
const wildernessZones = findAll(WILD_DB, /^data=coord_pair,(\S+),(\S+)$/).map(({ i, m }) => {
    const a = parseCoord(m[1]!), b = parseCoord(m[2]!);
    return { from: a, to: b, src: at(WILD_DB, i) };
});
function wildernessLevel(c: { x: number; z: number; level: number }): number {
    for (const zn of wildernessZones) {
        const { from: a, to: b } = zn;
        if (c.x >= a.x && c.x <= b.x && c.z >= a.z && c.z <= b.z && c.level >= a.level && c.level <= b.level) return Math.trunc((c.z - a.z) / 8) + 1;
    }
    return 0;
}
// inzone bounds: the upper coord's local 63_63 is the inclusive corner, so parseCoord(to) is already inclusive.

function tile(coord: string, src: string): Tile {
    const c = parseCoord(coord);
    return { ...c, src, wilderness: wildernessLevel(c) };
}
// Resolve a coord literal (0_50_53_13_32) or a ^constant to a tile; src is the line that holds the literal.
function coordTile(token: string, src: string): Tile {
    if (token.startsWith('^')) { const c = constant(token.slice(1)); return tile(c.value, c.src); }
    return tile(token, src);
}
const FS_TYPES: Record<string, 'lineofwalk' | 'lineofsight' | 'none'> = { map_findsquare_lineofwalk: 'lineofwalk', map_findsquare_lineofsight: 'lineofsight', map_findsquare_none: 'none' };
const FS_BY_NUM: Record<string, 'lineofwalk' | 'lineofsight' | 'none'> = {};
for (const [k, v] of Object.entries(FS_TYPES)) FS_BY_NUM[constant(k).value] = v;

function dest(option: string | null, candidates: Tile[], fs: { min: number; max: number; type: Destination['findsquare'] } | null, moveSrc: string, when?: string): Destination {
    const min = fs?.min ?? 0, max = fs?.max ?? 0;
    const one = candidates.length === 1 ? candidates[0]! : null;
    return {
        option, candidates, minRadius: min, maxRadius: max, findsquare: fs?.type ?? null,
        box: one ? { minX: one.x - max, maxX: one.x + max, minZ: one.z - max, maxZ: one.z + max, level: one.level } : null,
        ...(when ? { when } : {}), moveSrc,
    };
}
// map_findsquare(<coord>, min, max, ^map_findsquare_x) on one line.
function findsquareArgs(text: string): { coord: string; min: number; max: number; type: Destination['findsquare'] } | null {
    const m = text.match(/map_findsquare\((.+), (\d+), (\d+), \^(\w+)\)/);
    if (!m) return null;
    return { coord: m[1]!, min: Number(m[2]), max: Number(m[3]), type: FS_TYPES[m[4]!] ?? null };
}
// "label", n pairs of a ~p_choiceN call.
function choiceLabels(text: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const m of text.matchAll(/"([^"]+)", (\d+)/g)) out.set(Number(m[2]), m[1]!.replace(/\.$/, ''));
    return out;
}
function wildLimit(rel: string, start: number, end: number): Teleport['wildernessMax'] {
    const r = findAll(rel, /~wilderness_level\(coord\) > (\d+)/, start, end)[0];
    return r ? { level: Number(r.m[1]), src: at(rel, r.i) } : null;
}

// Quest folder per varp from knowledge/quests.json (generated by build.ts) when present.
const questByVarp = new Map<string, string>();
try {
    for (const q of JSON.parse(readFileSync(join(knowledgeDir(), 'quests.json'), 'utf8')) as { varp: string; folder: string }[]) questByVarp.set(q.varp, q.folder);
} catch { /* quests.json absent: quest stays null */ }
function varpReq(varp: string, op: '>=' | '<' | '=', constName: string, src: string[], message: string | null): Requirement {
    const c = constant(constName);
    return { type: 'varp', varp, op, value: Number(c.value), quest: questByVarp.get(varp) ?? null, message, src: [...src, c.src] };
}
function mesText(rel: string, i: number): string | null {
    const m = lines(rel)[i]?.match(/mes(?:box)?\("([^"]*)"/);
    return m ? m[1]! : null;
}

// Map spawns of named locs and npcs.
const locPack = parsePack(readFileSync(join(root, 'pack', 'loc.pack'), 'utf8'));
const npcPack = parsePack(readFileSync(join(root, 'pack', 'npc.pack'), 'utf8'));
const locSpawns = new Map<string, Tile[]>();
const npcSpawns = new Map<string, Tile[]>();
for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) {
    const r = parseJm2(f, readFileSync(join(root, 'maps', f), 'utf8'));
    for (const l of r.locs) { const n = locPack.get(l.id); if (n) (locSpawns.get(n) ?? locSpawns.set(n, []).get(n)!).push({ x: l.x, z: l.z, level: l.level, src: l.src, wilderness: wildernessLevel(l) }); }
    for (const n of r.npcs) { const nm = npcPack.get(n.id); if (nm) (npcSpawns.get(nm) ?? npcSpawns.set(nm, []).get(nm)!).push({ x: n.x, z: n.z, level: n.level, src: n.src, wilderness: wildernessLevel(n) }); }
}
function spawnsOf(map: Map<string, Tile[]>, name: string, gaps: string[], what: string): Tile[] {
    const s = map.get(name) ?? [];
    if (s.length === 0) gaps.push(`${what} ${name} has no map spawn`);
    return s;
}

function base(id: string, kind: Kind, name: string, trigger: string, triggerSrc: string): Teleport {
    return { id, kind, name, trigger, triggerSrc, from: null, requires: [], wildernessMax: null, runes: [], charges: [], xp: null, to: [], gaps: [] };
}

// ---------- Standard spellbook ----------
const SPELL_RS = 'scripts/skill_magic/scripts/spells/teleport.rs2';
const MAGIC_RS = 'scripts/skill_magic/scripts/magic.rs2';
const SPELL_DB = 'scripts/skill_magic/configs/magic_spells.dbrow';
const STAFF_DB = 'scripts/skill_magic/configs/magic_staff.dbrow';
const PRE_TELE = block(SPELL_RS, /^\[proc,pre_tele_checks\]/);

function spells(): Teleport[] {
    const out: Teleport[] = [];
    const rows = parseConfigs(readFileSync(join(root, SPELL_DB), 'utf8'), SPELL_DB);
    const label = block(SPELL_RS, /^\[label,magic_teleport\]/);
    const move = find(SPELL_RS, /~player_teleport_normal\((.+)\);$/, label.start, label.end);
    const fs = findsquareArgs(move.m[1]!);
    if (!fs || !/tele_coord/.test(move.m[1]!)) throw new Error('magic_teleport move line shape changed');
    const wild = wildLimit(SPELL_RS, label.start, label.end);
    const membersLine = find(MAGIC_RS, /magic_spell_table:members, 0\) = true & map_members = \^false/);
    const levelLine = find(MAGIC_RS, /stat\(magic\) < db_getfield\(\$spell_data, magic_spell_table:levelrequired/);
    // One line can hold several spell gates joined by |, so take every match on each line.
    const questLines = findAll(SPELL_RS, /\$spell = \^\w+ & %\w+ < \^\w+/, label.start, label.end)
        .flatMap(({ i }) => [...cleanLines(lines(SPELL_RS).join('\n'))[i]!.matchAll(/\$spell = \^(\w+) & %(\w+) < \^(\w+)/g)].map(m => ({ i, m })));
    for (const { i, m } of findAll(SPELL_RS, /^\[if_button,magic:(\w+)\] @magic_teleport\(\^(\w+)\);$/)) {
        const com = m[1]!, spellConst = m[2]!;
        const row = rows.find(r => r.props.data?.some(d => d === `spell,^${spellConst}`));
        const t = base(`spell:${com}`, 'spell', com.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), `[if_button,magic:${com}]`, at(SPELL_RS, i));
        if (!row) { t.gaps.push(`no magic_spell_table row has spell,^${spellConst}`); out.push(t); continue; }
        const field = (k: string) => {
            const idx = row.props.data!.findIndex(d => d.startsWith(`${k},`));
            return idx < 0 ? null : { value: row.props.data![idx]!.slice(k.length + 1), src: `${SPELL_DB}:${row.propLines.data![idx]}` };
        };
        const lvl = field('levelrequired'), mem = field('members'), runes = field('runesrequired'), xp = field('experience'), coord = field('tele_coord');
        if (lvl) t.requires.push({ type: 'skill', skill: 'magic', level: Number(lvl.value), src: lvl.src });
        else t.gaps.push('levelrequired missing');
        if (mem?.value === 'true') t.requires.push({ type: 'members', src: mem.src });
        // Quest gates: a spell can have several lines on one varp; the highest threshold applies.
        const byVarp = new Map<string, { value: number; constName: string; src: string[]; message: string | null }>();
        for (const q of questLines.filter(q => q.m[1] === spellConst)) {
            const v = Number(constant(q.m[3]!).value);
            const cur = byVarp.get(q.m[2]!);
            const srcs = [...(cur?.src ?? []), at(SPELL_RS, q.i)];
            if (!cur || v > cur.value) byVarp.set(q.m[2]!, { value: v, constName: q.m[3]!, src: srcs, message: cur?.message ?? mesText(SPELL_RS, q.i + 1) });
            else cur.src = srcs;
        }
        for (const [varp, q] of byVarp) t.requires.push(varpReq(varp, '>=', q.constName, q.src, q.message));
        if (runes) {
            const p = runes.value.split(',');
            for (let k = 0; k + 1 < p.length; k += 2) if (p[k] !== 'null') t.runes.push({ item: p[k]!, id: itemId(p[k]!), count: Number(p[k + 1]), src: runes.src });
        } else t.gaps.push('runesrequired missing');
        if (xp) t.xp = { skill: 'magic', xp: Number(xp.value) / 10, tenths: Number(xp.value), src: xp.src };
        t.wildernessMax = wild;
        if (coord) t.to.push(dest(null, [tile(coord.value, coord.src)], fs, at(SPELL_RS, move.i)));
        else t.gaps.push('tele_coord missing');
        if (mem?.value === 'true') t.requires.push({ type: 'note', text: 'members spell needs a members world', src: at(MAGIC_RS, membersLine.i) });
        t.requires.push({ type: 'note', text: 'stat(magic) is the current level, so boosts count', src: at(MAGIC_RS, levelLine.i) });
        out.push(t);
    }
    return out;
}

function staffs(): TeleportsOut['staffs'] {
    const out: TeleportsOut['staffs'] = [];
    for (const b of parseConfigs(readFileSync(join(root, STAFF_DB), 'utf8'), STAFF_DB)) {
        const rune = b.props.data?.find(d => d.startsWith('rune,'))?.slice(5);
        const list = (b.props.data ?? []).filter(d => d.startsWith('staff,')).map(d => d.slice(6));
        if (rune) out.push({ rune, staffs: list, src: `${STAFF_DB}:${b.line}` });
    }
    return out;
}

// ---------- Enchanted jewellery ----------
const JEWEL_OBJ = 'scripts/skill_magic/configs/enchanted_jewelry.obj';
const objBlocks: ConfigBlock[] = listConfigFiles('.obj').flatMap(f => parseConfigs(readFileSync(join(root, f), 'utf8'), f));
const objByName = new Map(objBlocks.map(b => [b.name, b]));
function param(b: ConfigBlock, key: string): { value: string; src: string } | null {
    const idx = (b.props.param ?? []).findIndex(p => p.startsWith(`${key},`));
    return idx < 0 ? null : { value: b.props.param![idx]!.slice(key.length + 1), src: `${b.file}:${b.propLines.param![idx]}` };
}
// Charge chain: each rubbable item and the item it becomes. `charges` is the charges param when present,
// else the count of next_obj_stage steps until an item outside the rubbable set.
function chargeChain(items: string[]): Charge[] {
    const set = new Set(items);
    return items.map(n => {
        const b = objByName.get(n)!;
        const next = param(b, 'next_obj_stage');
        const ch = param(b, 'charges');
        let steps = 0, cur: string | null = n;
        while (cur && set.has(cur)) { steps++; cur = param(objByName.get(cur)!, 'next_obj_stage')?.value ?? null; }
        return { item: n, id: itemId(n), charges: ch ? Number(ch.value) : steps, next: next?.value ?? null, src: ch?.src ?? next?.src ?? `${b.file}:${b.line}` };
    }).sort((a, b) => b.charges - a.charges);
}

function glory(): Teleport {
    const rel = 'scripts/general/scripts/enchanted_jewellry/amulet_of_glory.rs2';
    const heads = findAll(rel, /^\[opheld4,(amulet_of_glory_\d)\] @amulet_of_glory_interface/);
    const t = base('jewellery:amulet_of_glory', 'jewellery', 'Amulet of glory', '[opheld4,amulet_of_glory_N] Rub', at(rel, heads[0]!.i));
    const label = block(rel, /^\[label,amulet_of_glory_interface\]/);
    const choice = find(rel, /~p_choice5_header\((.+)\);$/, label.start, label.end);
    const labels = choiceLabels(choice.m[1]!);
    t.wildernessMax = wildLimit(rel, label.start, label.end);
    for (const { i, m } of findAll(rel, /case (\d) : ~player_teleport_normal\((\S+)\);$/, label.start, label.end)) {
        t.to.push(dest(labels.get(Number(m[1])) ?? null, [tile(m[2]!, at(rel, i))], null, at(rel, i)));
    }
    t.charges = chargeChain(heads.map(h => h.m[1]!));
    const set = find(rel, /inv_setslot\(inv, \$slot, oc_param\(\$item, next_obj_stage\), 1\)/, label.start, label.end);
    t.requires.push({ type: 'note', text: 'rub from the inventory (opheld4); no opworn trigger exists, so a worn amulet cannot teleport', src: at(rel, heads[0]!.i) });
    t.requires.push({ type: 'note', text: 'each use replaces the slot with next_obj_stage', src: at(rel, set.i) });
    const ob = objByName.get('amulet_of_glory_4')!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    const dead = find(rel, /^\[opheld4,amulet_of_glory\] mes\(/);
    t.requires.push({ type: 'note', text: 'amulet_of_glory (no charges) does not teleport', src: at(rel, dead.i) });
    return t;
}

// `options`: the dialogue option number each move line serves, in move-line order.
function stagedJewel(id: string, name: string, rel: string, header: RegExp, items: string[], options: number[]): Teleport {
    const b = block(rel, header);
    const t = base(id, 'jewellery', name, b.head, at(rel, b.start));
    const choice = find(rel, /~p_choice\d_header\((.+)\);$/, b.start, b.end);
    const labels = choiceLabels(choice.m[1]!);
    t.wildernessMax = wildLimit(rel, b.start, b.end);
    const moves = findAll(rel, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    if (moves.length !== options.length) throw new Error(`${rel}: ${moves.length} move lines, expected ${options.length}`);
    moves.forEach((mv, k) => {
        const fs = findsquareArgs(mv.m[1]!)!;
        const label = labels.get(options[k]!) ?? null;
        if (!label || label === 'Nowhere') throw new Error(`${rel}: option ${options[k]} is not a destination`);
        t.to.push(dest(label, [tile(fs.coord, at(rel, mv.i))], fs, at(rel, mv.i)));
    });
    t.charges = chargeChain(items);
    const cr = find(rel, /inv_delslot\(inv, \$slot\)/, b.start, b.end);
    t.requires.push({ type: 'note', text: 'rub from the inventory (opheld4); the last charge deletes the item', src: at(rel, cr.i) });
    const ob = objByName.get(t.charges[0]!.item)!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    return t;
}

function ringOfLife(): Teleport {
    const rel = 'scripts/general/scripts/enchanted_jewellry/ring_of_life.rs2';
    const b = block(rel, /^\[proc,ring_of_life_check\]/);
    const t = base('jewellery:ring_of_life', 'jewellery', 'Ring of life', b.head, at(rel, b.start));
    const cond = find(rel, /inv_getobj\(worn, \^wearpos_ring\) ! ring_of_life \| map_members = \^false \| ~wilderness_level\(coord\) > (\d+) \| stat\(hitpoints\) > scale\((\d+), (\d+), stat_base\(hitpoints\)\)/, b.start, b.end);
    t.requires.push({ type: 'worn', item: 'ring_of_life', id: itemId('ring_of_life'), src: at(rel, cond.i) });
    t.requires.push({ type: 'members', src: at(rel, cond.i) });
    t.requires.push({ type: 'note', text: `fires by itself when hitpoints <= ${cond.m[2]}/${cond.m[3]} of base hitpoints; not a chosen route leg`, src: at(rel, cond.i) });
    t.wildernessMax = { level: Number(cond.m[1]), src: at(rel, cond.i) };
    const del = find(rel, /inv_delslot\(worn, \^wearpos_ring\)/, b.start, b.end);
    t.charges = [{ item: 'ring_of_life', id: itemId('ring_of_life'), charges: 1, next: null, src: at(rel, del.i) }];
    const mv = find(rel, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    const fs = findsquareArgs(mv.m[1]!)!;
    t.to.push(dest(null, [tile(fs.coord, at(rel, mv.i))], fs, at(rel, mv.i)));
    return t;
}

function jewellery(): Teleport[] {
    const cat = (c: string) => objBlocks.filter(b => b.file === JEWEL_OBJ && b.props.category?.[0] === c).map(b => b.name);
    return [
        glory(),
        stagedJewel('jewellery:games_necklace', 'Games necklace', 'scripts/general/scripts/enchanted_jewellry/necklace_of_minigames.rs2', /^\[opheld4,_necklace_of_minigames\]/, cat('necklace_of_minigames'), [1]),
        stagedJewel('jewellery:ring_of_dueling', 'Ring of dueling', 'scripts/general/scripts/enchanted_jewellry/ring_of_dueling.rs2', /^\[opheld4,_category_136\]/, cat('category_136'), [1, 2]),
        ringOfLife(),
    ];
}

// ---------- Item: enchanted lyre ----------
function lyre(): Teleport {
    const rel = 'scripts/quests/quest_viking/scripts/viking_olaf.rs2';
    const b = block(rel, /^\[opheld1,magic_strung_lyre\]/);
    const t = base('item:magic_strung_lyre', 'item', 'Enchanted lyre', b.head, at(rel, b.start));
    t.requires.push({ type: 'held', item: 'magic_strung_lyre', id: itemId('magic_strung_lyre'), src: at(rel, b.start) });
    const ob = objByName.get('magic_strung_lyre')!;
    if (ob.props.members?.[0] === 'yes') t.requires.push({ type: 'members', src: `${ob.file}:${ob.propLines.members![0]}` });
    t.wildernessMax = wildLimit(rel, b.start, b.end);
    const mv = find(rel, /~player_teleport_normal\((.+)\);$/, b.start, b.end);
    const fs = findsquareArgs(mv.m[1]!)!;
    t.to.push(dest('Rellekka', [tile(fs.coord, at(rel, mv.i))], fs, at(rel, mv.i)));
    const set = find(rel, /inv_setslot\(inv, \$slot, (\w+), 1\);$/, b.start, b.end);
    t.charges = [{ item: 'magic_strung_lyre', id: itemId('magic_strung_lyre'), charges: 1, next: set.m[1]!, src: at(rel, set.i) }];
    const shrine = block(rel, /^\[oplocu,viking_lake_shrine_altar\]/);
    const done = find(rel, /if\(%viking = \^(\w+)\)/, shrine.start, shrine.end);
    const fish = find(rel, /last_useitem = (raw_shark) \| last_useitem = (raw_seaturtle) \| last_useitem = (raw_mantaray)/, shrine.start, shrine.end);
    t.requires.push(varpReq('viking', '=', done.m[1]!, [at(rel, done.i)], 'enchanting at the shrine needs the quest complete'));
    t.requires.push({ type: 'note', text: `enchant viking_strung_lyre by using ${fish.m[1]}, ${fish.m[2]} or ${fish.m[3]} on viking_lake_shrine_altar; one enchant gives one teleport`, src: at(rel, fish.i) });
    return t;
}

// ---------- Levers and magic doors ----------
function locTeleport(id: string, kind: Kind, name: string, rel: string, locName: string, opt: string, extra?: (t: Teleport, b: { start: number; end: number }) => void): Teleport {
    const b = block(rel, new RegExp(`^\\[${opt},${locName}\\]`));
    const t = base(id, kind, name, b.head, at(rel, b.start));
    t.from = spawnsOf(locSpawns, locName, t.gaps, 'loc');
    const mv = findAll(rel, /(?:~player_teleport_normal|p_telejump)\((.+)\);/, b.start, b.end)[0];
    if (!mv) { t.gaps.push('no move line in trigger'); return t; }
    const fs = findsquareArgs(mv.m[1]!);
    t.to.push(dest(null, [coordTile(fs?.coord ?? mv.m[1]!, at(rel, mv.i))], fs, at(rel, mv.i)));
    extra?.(t, b);
    return t;
}

function locTeleports(): Teleport[] {
    const lever = 'scripts/areas/area_ardougne_east/scripts/wilderness_lever.rs2';
    const kbd = 'scripts/areas/area_wilderness/scripts/king_black_dragon.rs2';
    const zan = 'scripts/quests/quest_zanaris/scripts/quest_zanaris.rs2';
    const entrana = 'scripts/areas/area_entrana/scripts/entrana_dungeon.rs2';
    return [
        locTeleport('lever:wildinlever', 'lever', 'Ardougne lever to Wilderness', lever, 'wildinlever', 'oploc1'),
        locTeleport('lever:wildoutlever', 'lever', 'Wilderness lever to Ardougne', lever, 'wildoutlever', 'oploc1'),
        locTeleport('lever:dragonkinginlever', 'lever', 'Lever into the King Black Dragon lair', kbd, 'dragonkinginlever', 'oploc1'),
        locTeleport('lever:dragonkingoutlever', 'lever', 'Lever out of the King Black Dragon lair', kbd, 'dragonkingoutlever', 'oploc1'),
        locTeleport('loc:zanarisdoor', 'loc', 'Zanaris shed door', zan, 'zanarisdoor', 'oploc1', (t, b) => {
            const c = find(zan, /if\(inv_total\(worn, (dramen_staff)\) > 0 & map_members = \^true\)/, b.start, b.end);
            const ax = find(zan, /if\(\$entering = false\)/, b.start, b.end);
            t.requires.push({ type: 'worn', item: c.m[1]!, id: itemId(c.m[1]!), src: at(zan, c.i) });
            t.requires.push({ type: 'members', src: at(zan, c.i) });
            t.requires.push({ type: 'note', text: 'fires only when ~check_axis(coord, loc_coord, loc_angle) is false (player not on the door tile axis)', src: at(zan, ax.i) });
            t.gaps.push('which side of the shed door gives check_axis false is not resolved from geometry');
        }),
        locTeleport('loc:zanarismagicdoor', 'loc', 'Entrana dungeon magic door', entrana, 'zanarismagicdoor', 'oploc1'),
    ];
}

// ---------- NPC teleports: essence mine, Cromperty ----------
const ESS_RS = 'scripts/skill_runecraft/scripts/essence_mine.rs2';
const ESS_ENUM = 'scripts/skill_runecraft/configs/essence_mine_teleports.enum';
function npcTeleports(): Teleport[] {
    const out: Teleport[] = [];
    const label = block(ESS_RS, /^\[label,teleport_to_essence_mine\]/);
    const rm = find(ESS_RS, /if\(%(\w+) < \^(\w+)\)/, label.start, label.end);
    const pick = find(ESS_RS, /map_findsquare\(\$coord, (\d+), (\d+), \^(\w+)\)/, label.start, label.end);
    const jump = find(ESS_RS, /p_telejump\(\$coord\)/, label.start, label.end);
    const mine = findAll(ESS_ENUM, /^val=\d+,(\S+)$/).map(({ i, m }) => tile(m[1]!, at(ESS_ENUM, i)));
    const wizards: [string, string, string][] = [
        ['aubury', 'scripts/areas/area_varrock/scripts/aubury.rs2', 'Aubury (Varrock)'],
        ['head_wizard', 'scripts/areas/area_wizard_tower/scripts/sedridor.rs2', 'Sedridor (Wizards\' Tower)'],
        ['guild_wizard', 'scripts/areas/area_yanille/scripts/wizard_distentor.rs2', 'Wizard Distentor (Magic Guild)'],
        ['gnome_brimstail', 'scripts/areas/area_gnome/scripts/brimstail.rs2', 'Brimstail (Gnome Stronghold)'],
        ['ardounge_wizard', 'scripts/areas/area_ardougne_east/scripts/wizard_cromperty.rs2', 'Wizard Cromperty (East Ardougne)'],
    ];
    const backByConst = new Map<string, string>();
    for (const [npc, rel, name] of wizards) {
        const op = find(rel, new RegExp(`^\\[(opnpc\\d),${npc}\\]$`));
        // The menu op that goes straight to the teleport label.
        const direct = findAll(rel, new RegExp(`^\\[(opnpc\\d),${npc}\\]`)).find(h => /@teleport_to_essence_mine/.test(lines(rel).slice(h.i, h.i + 3).join('\n'))) ?? op;
        const call = find(rel, /@teleport_to_essence_mine\(\^(\w+)\)/, direct.i);
        backByConst.set(call.m[1]!, name);
        const t = base(`npc:essence_mine:${npc}`, 'npc', `${name} to the Rune essence mine`, lines(rel)[direct.i]!.trim(), at(rel, direct.i));
        t.from = spawnsOf(npcSpawns, npc, t.gaps, 'npc');
        t.requires.push(varpReq(rm.m[1]!, '>=', rm.m[2]!, [at(ESS_RS, rm.i)], mesText(ESS_RS, rm.i + 2)));
        t.to.push(dest('Rune essence mine', mine, { min: Number(pick.m[1]), max: Number(pick.m[2]), type: FS_TYPES[pick.m[3]!] ?? null }, at(ESS_RS, jump.i)));
        t.requires.push({ type: 'note', text: `sets the essence mine exit to ^${call.m[1]}`, src: at(rel, call.i) });
        out.push(t);
    }
    // Exit portal: back to the wizard who sent the player (default Sedridor).
    const portal = block(ESS_RS, /^\[oploc1,blankrunestone_exit_portal\]/);
    const pfs = find(ESS_RS, /map_findsquare\(%exit_essence_mine_coord, (\d+), (\d+), \^(\w+)\)/, portal.start, portal.end);
    const pj = find(ESS_RS, /p_telejump\(\$coord\)/, portal.start, portal.end);
    const def = find(ESS_RS, /%exit_essence_mine_coord = \^(\w+);/, portal.start, portal.end);
    const t = base('runecraft_portal:blankrunestone_exit_portal', 'runecraft_portal', 'Rune essence mine exit portal', portal.head, at(ESS_RS, portal.start));
    t.from = spawnsOf(locSpawns, 'blankrunestone_exit_portal', t.gaps, 'loc');
    for (const [k, name] of backByConst) {
        t.to.push(dest(name, [coordTile(`^${k}`, '')], { min: Number(pfs.m[1]), max: Number(pfs.m[2]), type: FS_TYPES[pfs.m[3]!] ?? null }, at(ESS_RS, pj.i),
            k === def.m[1] ? 'the player entered through this wizard, or the exit coord is unset' : 'the player entered through this wizard'));
    }
    const f2p = find(ESS_RS, /map_members = \^false\)/, portal.start, portal.end);
    t.requires.push({ type: 'note', text: 'on a free world an exit that is not Aubury or Sedridor resets to Sedridor', src: at(ESS_RS, f2p.i) });
    out.push(t);

    // Cromperty's research teleport (Tribal Totem).
    const cr = 'scripts/areas/area_ardougne_east/scripts/wizard_cromperty.rs2';
    const tl = block(cr, /^\[label,cromperty_teleport\]/);
    const gate = find(cr, /if\(%(\w+) < \^(\w+)\)/, tl.start, tl.end);
    const rp = block(cr, /^\[label,rpdt_teleport\]/);
    const d0 = find(cr, /def_coord \$coord = (\S+);$/, rp.start, rp.end);
    const cond = find(cr, /if\(%(\w+) >= \^(\w+)\)/, rp.start, rp.end);
    const d1 = find(cr, /\$coord = (\S+);$/, cond.i + 1, rp.end);
    const rj = find(cr, /p_telejump\(\$coord\)/, rp.start, rp.end);
    const c = base('npc:cromperty_rpdt', 'npc', 'Wizard Cromperty teleport block', '[opnpc1,ardounge_wizard] dialogue: Can I be teleported please?', at(cr, tl.start));
    c.from = spawnsOf(npcSpawns, 'ardounge_wizard', c.gaps, 'npc');
    c.requires.push(varpReq(gate.m[1]!, '<', gate.m[2]!, [at(cr, gate.i)], 'the teleport works only before the quest is complete'));
    const crate = constant(cond.m[2]!);
    c.to.push(dest(null, [tile(d0.m[1]!, at(cr, d0.i))], null, at(cr, rj.i), `%${cond.m[1]} < ${crate.value} (^${cond.m[2]}, ${crate.src})`));
    c.to.push(dest(null, [tile(d1.m[1]!, at(cr, d1.i))], null, at(cr, rj.i), `%${cond.m[1]} >= ${crate.value} (^${cond.m[2]}, ${crate.src})`));
    out.push(c);
    return out;
}

// ---------- Spirit trees ----------
function spiritTrees(): Teleport[] {
    const rel = 'scripts/areas/area_gnome/scripts/spirit_tree.rs2';
    const tele = block(rel, /^\[label,spirit_tree_tele\]/);
    const mem = find(rel, /if\(map_members = \^false\)/, tele.start, tele.end);
    const jump = find(rel, /p_telejump\(\$dest\)/, tele.start, tele.end);
    const out: Teleport[] = [];
    for (const h of findAll(rel, /^\[oploc1,(\w+)\]/)) {
        const loc = h.m[1]!;
        const end = blockEnd(rel, h.i);
        const t = base(`spirit_tree:${loc}`, 'spirit_tree', `Spirit tree (${loc})`, `[oploc1,${loc}]`, at(rel, h.i));
        t.from = spawnsOf(locSpawns, loc, t.gaps, 'loc');
        const q = find(rel, /if\(%(\w+) ! \^(\w+)\)/, h.i, end);
        t.requires.push(varpReq(q.m[1]!, '=', q.m[2]!, [at(rel, q.i)], mesText(rel, q.i + 1)));
        t.requires.push({ type: 'members', src: at(rel, mem.i) });
        const cases = findAll(rel, /case (\d) : \$end_pos = \^(\w+);/, h.i, end);
        if (cases.length) {
            const ch = cases[0]!.i - 1;
            const labels = choiceLabels(lines(rel)[ch]!);
            for (const cs of cases) t.to.push(dest(labels.get(Number(cs.m[1])) ?? null, [coordTile(`^${cs.m[2]}`, '')], null, at(rel, jump.i)));
        } else {
            const d = find(rel, /@spirit_tree_tele\(\^(\w+)\)/, h.i, end);
            t.to.push(dest(null, [coordTile(`^${d.m[1]}`, '')], null, at(rel, jump.i)));
        }
        out.push(t);
    }
    return out;
}

// ---------- Runecraft ruins and altar exit portals ----------
function runecraft(): Teleport[] {
    const rs = 'scripts/skill_runecraft/scripts/runecraft.rs2';
    const db = 'scripts/skill_runecraft/configs/runecraft.dbrow';
    const rows = parseConfigs(readFileSync(join(root, db), 'utf8'), db);
    const rowOf = (type: string) => rows.find(r => r.props.data?.includes(`type,${type}`));
    const field = (r: ConfigBlock, k: string) => (r.props.data ?? []).map((d, idx) => ({ d, line: r.propLines.data![idx]! })).filter(x => x.d.startsWith(`${k},`)).map(x => ({ value: x.d.slice(k.length + 1), src: `${db}:${x.line}` }));
    const enter = block(rs, /^\[label,teleport_to_ruins\]/);
    const enterJump = find(rs, /p_telejump\(map_findsquare\(db_getfield\(\$data, runecraft_table:enter_coord/, enter.start, enter.end);
    const memLine = find(rs, /runecraft_table:members, 0\) = \^true/, enter.start, enter.end);
    const exit = block(rs, /^\[oploc1,_rc_exit_portal\]/);
    const exitJump = find(rs, /p_telejump\(map_findsquare\(db_getfield\(\$data, runecraft_table:exit_coord/, exit.start, exit.end);
    const ruinsHead = find(rs, /^\[oplocu,_rc_ruins\]/);
    const locBlocks = listConfigFiles('.loc').flatMap(f => parseConfigs(readFileSync(join(root, f), 'utf8'), f));
    const coordList = (vals: { value: string; src: string }[]) => {
        const tiles = vals.map(v => { const [c, min, max, type] = v.value.split(','); return { t: tile(c!, v.src), min: Number(min), max: Number(max), type: FS_BY_NUM[type!] ?? null }; });
        return tiles;
    };
    const out: Teleport[] = [];
    for (const lb of locBlocks) {
        const cat = lb.props.category?.[0];
        if (cat !== 'rc_ruins' && cat !== 'rc_exit_portal') continue;
        const rt = lb.props.param?.find(p => p.startsWith('rune_type,'))?.slice(10);
        const row = rt ? rowOf(rt) : undefined;
        const ruins = cat === 'rc_ruins';
        const t = base(`${ruins ? 'runecraft_ruins' : 'runecraft_portal'}:${lb.name}`, ruins ? 'runecraft_ruins' : 'runecraft_portal', `${row ? field(row, 'name')[0]?.value : lb.name} ${ruins ? 'mysterious ruins' : 'altar exit portal'}`,
            ruins ? '[oplocu,_rc_ruins] use talisman' : '[oploc1,_rc_exit_portal]', ruins ? at(rs, ruinsHead.i) : at(rs, exit.start));
        t.from = locSpawns.get(lb.name) ?? [];
        if (!row) { t.gaps.push(`no runecraft_table row for rune_type ${rt}`); }
        if (t.from.length === 0) { unplaced.push(`${lb.name} (${lb.file}:${lb.line}) has no map spawn; not listed`); continue; }
        (t as Teleport & { runeType?: string }).runeType = rt;
        if (row) {
            if (ruins) {
                const tal = field(row, 'talisman')[0];
                if (tal) t.requires.push({ type: 'held', item: tal.value, id: itemId(tal.value), src: tal.src });
                const mem = field(row, 'members')[0];
                if (mem?.value === '1') t.requires.push({ type: 'members', src: `${mem.src} (${at(rs, memLine.i)})` });
            }
            const list = coordList(field(row, ruins ? 'enter_coord' : 'exit_coord'));
            // Group candidates that share one radius (the script picks one entry at random, then map_findsquare).
            const r0 = list[0];
            if (r0 && list.every(x => x.min === r0.min && x.max === r0.max && x.type === r0.type)) {
                t.to.push(dest(null, list.map(x => x.t), { min: r0.min, max: r0.max, type: r0.type }, at(rs, ruins ? enterJump.i : exitJump.i)));
            } else for (const x of list) t.to.push(dest(null, [x.t], { min: x.min, max: x.max, type: x.type }, at(rs, ruins ? enterJump.i : exitJump.i)));
        }
        out.push(t);
    }
    // An exit portal whose rune type has no placed ruins: its exit_coord is not a ruins-side tile.
    const ruinTypes = new Set(out.filter(t => t.kind === 'runecraft_ruins').map(t => (t as Teleport & { runeType?: string }).runeType));
    for (const t of out) {
        const rt = (t as Teleport & { runeType?: string }).runeType;
        if (t.kind === 'runecraft_portal' && !ruinTypes.has(rt)) t.gaps.push(`rune_type ${rt} has no placed mysterious ruins; the exit_coord row value is used as written`);
        delete (t as Teleport & { runeType?: string }).runeType;
    }
    return out;
}
const unplaced: string[] = [];

function rules(): TeleportsOut['rules'] {
    const out: TeleportsOut['rules'] = [];
    const r = (rel: string, re: RegExp, text: string, start = 0, end?: number) => out.push({ text, src: at(rel, find(rel, re, start, end).i) });
    r(WILD_PROC, /return \(calc\(\(coordz\(\$coord\) - coordz\(\$coord1\)\)\/8 \+ 1\)\)/, 'wilderness level = (z - zone south edge z) / 8 + 1 inside wilderness_zones; 0 outside');
    r(SPELL_RS, /~in_tutorial_island\(coord\) = true/, 'no teleport from Tutorial Island', PRE_TELE.start, PRE_TELE.end);
    r(SPELL_RS, /trawler_wreck_zones/, 'no teleport in the Fishing Trawler wreck', PRE_TELE.start, PRE_TELE.end);
    r(SPELL_RS, /trawler_game_zones/, 'no teleport during Fishing Trawler', PRE_TELE.start, PRE_TELE.end);
    r(SPELL_RS, /~in_duel_arena\(\$coord\) = true/, 'no teleport during a duel', PRE_TELE.start, PRE_TELE.end);
    r(SPELL_RS, /~in_castlewars_game\(coord\) = true \| ~in_castlewars_waitingroom/, 'no teleport in Castle Wars game or waiting room', PRE_TELE.start, PRE_TELE.end);
    const post = block(SPELL_RS, /^\[proc,post_tele_checks\]/);
    r(SPELL_RS, /inv_del\(inv, karamja_rum/, 'teleport through player_teleport_normal breaks Karamja rum in the inventory', post.start, post.end);
    r(SPELL_RS, /plaguesample/, 'teleport destroys the plague sample', post.start, post.end);
    r(MAGIC_RS, /if \(map_members = \^false & \$staff ! null & oc_members\(\$staff\) = true\)/, 'a members staff gives no free runes on a free world');
    r(MAGIC_RS, /def_obj \$staff = inv_getobj\(worn, \^wearpos_rhand\)/, 'only the wielded weapon-slot staff replaces runes');
    r(MAGIC_RS, /\$rune_count1 = null;/, 'a matching staff removes the whole count of that rune');
    out.push({ text: 'map_findsquare picks a random standable tile in the square ring min..max (Chebyshev distance) that passes the line-of-walk or line-of-sight test back to the centre; it returns the centre when none passes', src: 'engine/src/engine/script/handlers/ServerOps.ts:302-330 (relative to vendor/rs-sdk/server)' });
    out.push({ text: 'stat_advance xp is in tenths and is multiplied by the node xpRate', src: 'engine/src/engine/entity/Player.ts:1889 (relative to vendor/rs-sdk/server)' });
    return out;
}

export function buildTeleports(): TeleportsOut {
    const teleports = [...spells(), ...jewellery(), lyre(), ...locTeleports(), ...npcTeleports(), ...spiritTrees(), ...runecraft()];
    const counts: Record<string, number> = {};
    for (const t of teleports) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
    const gaps = teleports.flatMap(t => t.gaps.map(g => `${t.id}: ${g}`));
    return {
        rev: 289,
        teleports,
        staffs: staffs(),
        rules: rules(),
        wildernessZones: wildernessZones.map(z => ({ from: { x: z.from.x, z: z.from.z, level: z.from.level }, to: { x: z.to.x, z: z.to.z, level: z.to.level }, src: z.src })),
        counts,
        unplaced,
        gaps,
    };
}

if (import.meta.main) {
    const out = buildTeleports();
    writeFileSync(join(knowledgeDir(), 'teleports.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`teleports ${out.teleports.length}`);
    for (const [k, v] of Object.entries(out.counts)) console.log(`${k.padEnd(18)} ${v}`);
    for (const g of out.gaps) console.log(`gap: ${g}`);
}
