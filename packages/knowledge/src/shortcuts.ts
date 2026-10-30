// Loc-operated movement that transports.json (ladders and stairs) and doors.json (Open doors and gates) do not hold:
// agility shortcuts, course obstacles, trapdoors, manholes, caves, portals, gangplanks, carts and quest passages.
// Run: bun packages/knowledge/src/shortcuts.ts -> knowledge/shortcuts.json.
//
// Method: a small RuneScript interpreter runs each movement trigger once per placed loc. The loc tile, angle,
// shape, config params and constants are known; the player tile is the loc tile (approximate) until a script
// line moves the player to an absolute or loc-relative coord. Every condition the interpreter cannot decide
// (player side, skill level, item, quest varp, dialogue choice, success roll, world state) forks the run.
// A run that ends after a movement gives one edge; its forks become requirements, sides and conditions.
// Runs that the interpreter does not understand become `gaps` records, never guessed edges.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listConfigFiles, parseConfigs, type ConfigBlock } from './config';
import { parseJm2, type LocSpawn } from './jm2';
import { parsePack } from './pack';
import { contentRoot, knowledgeDir } from './paths';
import { buildDbTables, type DbRow, type DbTable } from './dbtables';

export type Coord = { x: number; z: number; level: number };
export type ShortcutKind = 'shortcut' | 'course' | 'passage' | 'quest' | 'minigame' | 'tutorial';
export interface SkillNeed { name: string; level: number; src: string }
export interface VarpNeed { varp: string; op: string; value: number | string; quest: boolean; src: string }
export interface ItemNeed { item: string; op: string; count: number | string; src: string }
export interface Requirements {
    skill?: { name: string; level: number }; // highest skill need, in the TransportRequirements shape
    skills?: SkillNeed[];
    varps?: VarpNeed[];
    items?: ItemNeed[]; // inv_total(inv, item)
    worn?: ItemNeed[]; // inv_total(worn, item)
    useItem?: { item: string; src: string }; // oplocu: item used on the loc
    coins?: number; // coins that must be held
}
export interface Failure { stat: string; low: number; high: number; src: string; to: Coord | null; exact: boolean; damage: string[] }
export interface ShortcutEdge {
    kind: ShortcutKind;
    locName: string;
    id: number;
    option: string; // op1..op5 or opu
    optionText: string | null;
    from: Coord; // placed loc tile
    to: Coord;
    exact: boolean; // false: `to` uses the approximate player start (loc tile) plus a player-relative offset
    requires?: Requirements;
    fee?: number; // coins removed by inv_del
    consumes?: string[];
    side?: string[]; // player-position conditions this edge assumes, e.g. `coordx(coord) > coordx(loc_coord) = false`
    choices?: string[]; // dialogue choices taken
    conditions?: string[]; // world or state conditions this edge assumes (npc_find, timers, non-quest varps)
    failure?: Failure;
    via?: { locName: string; option: string; src: string }; // closed loc whose option changes it into this loc
    twoWay: boolean; // another edge leaves within 3 tiles of `to` and lands within 3 tiles of `from`
    src: string; // placement line in maps/
    toSrc: string; // script line of the last movement
    handler: string; // trigger header line
    requireSrc?: string[];
}
export interface ShortcutGap { locName: string; option: string; handler: string; src: string; gap: string }

const MOVE_PROCS: Record<string, { dest?: number; rel?: [number, number]; damage?: number }> = {
    forcemove: { dest: 0 }, forcewalk: { dest: 0 }, forcewalk2: { dest: 0 }, agility_force_move: { dest: 2 },
    agility_walk: { rel: [0, 1] }, clipped_telewalk: { rel: [0, 1] },
    agility_exactmove: { dest: 4 }, agility_climb_up: { dest: 1 }, climb_ladder: { dest: 0 },
    agility_instant_fail: { dest: 0, damage: 1 }, agility_delay_fail: { dest: 1, damage: 2 },
};
const MOVE_CMDS: Record<string, number> = { p_telejump: 0, p_teleport: 0, p_walk: 0, p_exactmove: 1 };
const DAMAGE_PROCS = new Set(['damage_self']);
const QUEUE_CMDS = /^(queue|weakqueue|strongqueue|longqueue)$/;
const OP_NEG: Record<string, string> = { '=': '!', '!': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
const MAX_RUNS = 256;
const MAX_CAPPED = 3; // placements of one handler that may hit MAX_RUNS before the rest of its placements are skipped
const MAX_STEPS = 20000;

// ---------- source ----------
export interface Line { text: string; line: number }
export interface Script { type: string; name: string; params: { type: string; name: string }[]; body: Line[]; file: string; line: number }

// Removes `//` and `/* */` comments outside string literals; keeps one entry per source line.
export function stripComments(text: string): string[] {
    const out: string[] = [];
    let cur = '', inStr = false, inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!, nx = text[i + 1];
        if (ch === '\n') { out.push(cur.replace(/\r$/, '').trim()); cur = ''; inStr = false; continue; }
        if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i++; } continue; }
        if (inStr) { cur += ch; if (ch === '\\') { cur += nx ?? ''; i++; } else if (ch === '"') inStr = false; continue; }
        if (ch === '"') { inStr = true; cur += ch; continue; }
        if (ch === '/' && nx === '/') { while (i + 1 < text.length && text[i + 1] !== '\n') i++; continue; }
        if (ch === '/' && nx === '*') { inBlock = true; i++; continue; }
        cur += ch;
    }
    out.push(cur.replace(/\r$/, '').trim());
    return out;
}

export function parseScripts(files: { text: string; file: string }[]): Map<string, Script> {
    const out = new Map<string, Script>();
    for (const { text, file } of files) {
        const lines = stripComments(text);
        let cur: Script | null = null;
        lines.forEach((l, i) => {
            const m = l.match(/^\[(\w+),([^\]]+)\]((?:\([^)]*\))*)(.*)$/);
            if (m) {
                const params = (m[3]!.match(/^\(([^)]*)\)/)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
                    .map(s => { const [type, name] = s.split(/\s+/); return { type: type!, name: (name ?? '').replace(/^\$/, '') }; });
                cur = { type: m[1]!, name: m[2]!, params, body: [], file, line: i + 1 };
                if (!out.has(`${m[1]},${m[2]}`)) out.set(`${m[1]},${m[2]}`, cur);
                if (m[4]!.trim()) cur.body.push({ text: m[4]!.trim(), line: i + 1 });
                return;
            }
            if (cur && l) cur.body.push({ text: l, line: i + 1 });
        });
    }
    return out;
}

export function parseCoord(s: string): Coord {
    const [lv, mx, mz, lx, lz] = s.split('_').map(Number) as [number, number, number, number, number];
    return { x: mx * 64 + lx, z: mz * 64 + lz, level: lv };
}

// ---------- tokens and AST ----------
type Tok = { k: 'num' | 'coord' | 'str' | 'id' | 'var' | 'varp' | 'const' | 'proc' | 'label' | 'sym'; v: string; line: number };
class Unsupported extends Error {}

function tokenize(body: Line[]): Tok[] {
    const out: Tok[] = [];
    for (const { text, line } of body) {
        let i = 0;
        while (i < text.length) {
            const ch = text[i]!;
            if (/\s/.test(ch)) { i++; continue; }
            if (ch === '"') {
                let j = i + 1;
                while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
                if (j >= text.length) throw new Unsupported(`unterminated string at line ${line}`);
                out.push({ k: 'str', v: text.slice(i + 1, j), line }); i = j + 1; continue;
            }
            const rest = text.slice(i);
            // `.` marks the secondary player or loc (`.%duelstatus`, `.loc_find`); `queue*(name)(args)` passes typed args.
            let m = rest.match(/^\.(?=[$%])/);
            if (m) { i += 1; continue; }
            m = rest.match(/^\.?((?:weak|strong|long)?queue)\*/);
            if (m) { out.push({ k: 'id', v: m[1]!, line }); i += m[0].length; continue; }
            m = rest.match(/^\d+_\d+_\d+_\d+_\d+/);
            if (m) { out.push({ k: 'coord', v: m[0], line }); i += m[0].length; continue; }
            m = rest.match(/^0x[0-9a-fA-F]+|^\d+/);
            if (m) { out.push({ k: 'num', v: m[0], line }); i += m[0].length; continue; }
            m = rest.match(/^([$%^~@])([A-Za-z0-9_:]+)/);
            if (m) { out.push({ k: ({ $: 'var', '%': 'varp', '^': 'const', '~': 'proc', '@': 'label' } as const)[m[1] as '$']!, v: m[2]!, line }); i += m[0].length; continue; }
            m = rest.match(/^\.?[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?/);
            if (m) { out.push({ k: 'id', v: m[0], line }); i += m[0].length; continue; }
            m = rest.match(/^(<=|>=|[(){}\[\],;:=!<>&|+\-*/])/);
            if (m) { out.push({ k: 'sym', v: m[0], line }); i += m[0].length; continue; }
            throw new Unsupported(`unexpected character '${ch}' at line ${line}`);
        }
    }
    return out;
}

type Expr =
    | { k: 'num'; v: number } | { k: 'coord'; v: string } | { k: 'str'; v: string }
    | { k: 'var'; n: string } | { k: 'varp'; n: string } | { k: 'const'; n: string } | { k: 'id'; n: string }
    | { k: 'call'; n: string; args: Expr[]; proc: boolean; line: number }
    | { k: 'bin'; op: string; a: Expr; b: Expr } | { k: 'neg'; a: Expr };
type Stmt =
    | { k: 'expr'; e: Expr; line: number }
    | { k: 'if'; c: Expr; then: Stmt[]; else?: Stmt[]; line: number }
    | { k: 'switch'; e: Expr; cases: { labels: (Expr | 'default')[]; body: Stmt[]; line: number }[]; line: number }
    | { k: 'while'; line: number }
    | { k: 'return'; es: Expr[]; line: number }
    | { k: 'def'; n: string; e?: Expr; line: number }
    | { k: 'assign'; targets: { n: string; local: boolean }[]; e: Expr; line: number }
    | { k: 'jump'; n: string; args: Expr[]; line: number };

class Parser {
    i = 0;
    constructor(private t: Tok[]) {}
    peek(o = 0) { return this.t[this.i + o]; }
    is(v: string, o = 0) { const p = this.peek(o); return !!p && (p.k === 'sym' || p.k === 'id') && p.v === v; }
    eat(v: string) { if (!this.is(v)) throw new Unsupported(`expected '${v}' at line ${this.peek()?.line ?? 'end'}, found '${this.peek()?.v ?? 'end'}'`); return this.t[this.i++]!; }
    program(): Stmt[] { const out: Stmt[] = []; while (this.i < this.t.length) out.push(this.stmt()); return out; }
    block(): Stmt[] {
        if (!this.is('{')) return [this.stmt()];
        this.eat('{'); const out: Stmt[] = [];
        while (!this.is('}')) { if (this.i >= this.t.length) throw new Unsupported('unclosed block'); out.push(this.stmt()); }
        this.eat('}'); return out;
    }
    stmt(): Stmt {
        const p = this.peek()!; const line = p.line;
        if (p.k === 'sym' && p.v === ';') { this.i++; return { k: 'expr', e: { k: 'num', v: 0 }, line }; }
        if (p.k === 'sym' && p.v === '{') { const b = this.block(); return { k: 'if', c: { k: 'id', n: 'true' }, then: b, line }; }
        if (p.k === 'id' && p.v === 'if') {
            this.i++; this.eat('('); const c = this.expr(); this.eat(')');
            const then = this.block(); let els: Stmt[] | undefined;
            if (this.is('else')) { this.i++; els = this.is('if') ? [this.stmt()] : this.block(); }
            return { k: 'if', c, then, ...(els ? { else: els } : {}), line };
        }
        if (p.k === 'id' && p.v === 'while') throw new Unsupported(`while loop at line ${line}`);
        if (p.k === 'id' && /^switch_\w+$/.test(p.v)) {
            this.i++; this.eat('('); const e = this.expr(); this.eat(')'); this.eat('{');
            const cases: { labels: (Expr | 'default')[]; body: Stmt[]; line: number }[] = [];
            while (!this.is('}')) {
                const cl = this.peek()!.line; this.eat('case');
                const labels: (Expr | 'default')[] = [];
                do { if (this.is('default')) { this.i++; labels.push('default'); } else labels.push(this.expr()); } while (this.is(',') && this.i++ >= 0);
                this.eat(':');
                const body: Stmt[] = [];
                while (!this.is('case') && !this.is('}')) body.push(this.stmt());
                cases.push({ labels, body, line: cl });
            }
            this.eat('}');
            return { k: 'switch', e, cases, line };
        }
        if (p.k === 'id' && p.v === 'return') {
            this.i++;
            const es = this.is('(') ? this.args() : [];
            this.eat(';'); return { k: 'return', es, line };
        }
        if (p.k === 'id' && /^def_\w+$/.test(p.v)) {
            this.i++; const v = this.t[this.i++]!; if (v.k !== 'var') throw new Unsupported(`bad def at line ${line}`);
            let e: Expr | undefined; if (this.is('=')) { this.i++; e = this.expr(); }
            this.eat(';'); return { k: 'def', n: v.v, ...(e ? { e } : {}), line };
        }
        if ((p.k === 'var' || p.k === 'varp') && (this.is('=', 1) || this.is(',', 1))) {
            const targets: { n: string; local: boolean }[] = [];
            for (;;) { const v = this.t[this.i++]!; targets.push({ n: v.v, local: v.k === 'var' }); if (this.is(',')) { this.i++; continue; } break; }
            this.eat('='); const e = this.expr(); this.eat(';');
            return { k: 'assign', targets, e, line };
        }
        if (p.k === 'label') {
            this.i++; const args = this.is('(') ? this.args() : [];
            if (this.is(';')) this.i++;
            return { k: 'jump', n: p.v, args, line };
        }
        const e = this.expr(); if (this.is(';')) this.i++; else if (!this.is('}') && this.i < this.t.length && !this.is('case')) throw new Unsupported(`expected ';' at line ${line}`);
        return { k: 'expr', e, line };
    }
    args(): Expr[] {
        this.eat('('); const out: Expr[] = [];
        if (this.is(')')) { this.i++; return out; }
        for (;;) { out.push(this.expr()); if (this.is(',')) { this.i++; continue; } this.eat(')'); return out; }
    }
    expr(): Expr { return this.bin(0); }
    static PREC: Record<string, number> = { '|': 1, '&': 2, '=': 3, '!': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5 };
    bin(min: number): Expr {
        let a = this.unary();
        for (;;) {
            const p = this.peek(); if (!p || p.k !== 'sym') return a;
            const prec = Parser.PREC[p.v]; if (prec === undefined || prec < min) return a;
            this.i++; const b = this.bin(prec + 1); a = { k: 'bin', op: p.v, a, b };
        }
    }
    unary(): Expr { if (this.is('-')) { this.i++; return { k: 'neg', a: this.unary() }; } return this.primary(); }
    primary(): Expr {
        const p = this.t[this.i++]; if (!p) throw new Unsupported('unexpected end');
        switch (p.k) {
            case 'num': return { k: 'num', v: Number(p.v) };
            case 'coord': return { k: 'coord', v: p.v };
            case 'str': return { k: 'str', v: p.v };
            case 'var': return { k: 'var', n: p.v };
            case 'varp': return { k: 'varp', n: p.v };
            case 'const': return { k: 'const', n: p.v };
            case 'proc': return { k: 'call', n: p.v, args: this.is('(') ? this.args() : [], proc: true, line: p.line };
            case 'id': {
                if (!this.is('(')) return { k: 'id', n: p.v.replace(/^\./, '') };
                const args = this.args();
                if (this.is('(')) args.push(...this.args()); // queue*(name, delay)(typed args)
                return { k: 'call', n: p.v.replace(/^\./, ''), args, proc: false, line: p.line };
            }
            case 'sym': if (p.v === '(') { const e = this.expr(); this.eat(')'); return e; }
        }
        throw new Unsupported(`unexpected '${p.v}' at line ${p.line}`);
    }
}

// ---------- values ----------
type Cls = 'skill' | 'item' | 'worn' | 'varp' | 'useitem' | 'side' | 'random' | 'choice' | 'dynamic';
type Sym = { t: 'sym'; cls: Cls; text: string; line: number; meta?: { stat?: string; low?: number; high?: number; item?: string; varp?: string; skill?: string } };
type V =
    | { t: 'int'; v: number; approx?: true } | { t: 'coord'; c: Coord; exact: boolean } | { t: 'bool'; v: boolean }
    | { t: 'name'; v: string } | { t: 'str' } | Sym
    | { t: 'cond'; sym: Sym; op: string; rhs: V; text: string; line: number }
    | { t: 'unk'; why: string }
    | { t: 'tuple'; vs: V[] };

const show = (v: V): string => v.t === 'int' ? String(v.v) : v.t === 'bool' ? String(v.v) : v.t === 'name' ? v.v : v.t === 'coord' ? `${v.c.level}_${v.c.x >> 6}_${v.c.z >> 6}_${v.c.x & 63}_${v.c.z & 63}${v.exact ? '' : '~'}` : v.t === 'sym' ? v.text : v.t === 'cond' ? v.text : v.t === 'str' ? '"..."' : v.t === 'tuple' ? `(${v.vs.map(show).join(', ')})` : `?(${v.why})`;
const exprText = (e: Expr): string => {
    switch (e.k) {
        case 'num': return String(e.v); case 'coord': return e.v; case 'str': return '"..."';
        case 'var': return '$' + e.n; case 'varp': return '%' + e.n; case 'const': return '^' + e.n; case 'id': return e.n;
        case 'call': return `${e.proc ? '~' : ''}${e.n}(${e.args.map(exprText).join(', ')})`;
        case 'bin': return `${exprText(e.a)} ${e.op} ${exprText(e.b)}`;
        case 'neg': return '-' + exprText(e.a);
    }
};

// ---------- interpreter ----------
// Loc shape names in index order (server/engine/tools/pack/Compiler.ts, locshapeInfo).
const LOC_SHAPES = ['wall_straight', 'wall_diagonalcorner', 'wall_l', 'wall_squarecorner', 'walldecor_straight_nooffset', 'walldecor_straight_offset',
    'walldecor_diagonal_offset', 'walldecor_diagonal_nooffset', 'walldecor_diagonal_both', 'wall_diagonal', 'centrepiece_straight', 'centrepiece_diagonal',
    'roof_straight', 'roof_diagonal_with_roofedge', 'roof_diagonal', 'roof_l_concave', 'roof_l_convex', 'roof_flat', 'roofedge_straight',
    'roofedge_diagonalcorner', 'roofedge_l', 'roofedge_squarecorner', 'grounddecor'];
// An int derived from the approximate player tile stays approximate.
const approxOf = (...vs: V[]): { approx?: true } => vs.some(v => v.t === 'int' && v.approx) ? { approx: true } : {};
// Random events are off on this server; doors.json owns door and gate opening.
const SKIP_CALL_FILE = /^scripts\/(macro events|doors)\//;
const SKIP_CALL_NAME = /^(open_and_close_\w+|open_door\w*|close_door\w*|open_gate\w*|close_gate\w*|doubledoor\w*|open_double\w*|open_outer_gate)$/;
const skipCall = (s: Script) => SKIP_CALL_FILE.test(s.file) || SKIP_CALL_NAME.test(s.name);
// A proc whose value the interpreter computes: it returns a value and calls no proc, label, dialogue or player command.
const SKIP_VALUE_FILE = /^scripts\/macro events\//;
const straight = new Map<Script, boolean>();
const valueProc = (s: Script) => {
    let v = straight.get(s);
    if (v === undefined) { const t = s.body.map(b => b.text).join('\n'); v = !SKIP_VALUE_FILE.test(s.file) && /\breturn\s*\(/.test(t) && !/\bwhile\s*\(|~\w+|@\w+|\b(p_\w+|mes|if_\w+)\s*\(/.test(t); straight.set(s, v); }
    return v;
};
interface Placement { locName: string; id: number; x: number; z: number; level: number; shape: number; angle: number; src: string; via?: { locName: string; option: string; src: string } }
interface Assumption { key: string; value: string; sym: Sym; detail: string; line: number; file: string }
class Fork extends Error { constructor(public key: string, public options: string[], public sym: Sym, public details: string[], public line: number, public file: string) { super('fork'); } }
class EndPath extends Error {}
class ProcReturn extends Error { constructor(public value?: V) { super('return'); } }

interface RunState {
    pos: { c: Coord; exact: boolean } | null; posWhy?: string;
    moved: boolean; moveSrc?: string;
    fee: number; consumes: string[]; damage: string[]; changes: { locName: string; line: string }[];
    queued: Script[]; steps: number;
}

export interface Ctx {
    scripts: Map<string, Script>;
    constants: Map<string, { value: string; src: string }>;
    locConfigs: Map<string, ConfigBlock>;
    paramTypes: Map<string, string>;
    questVarps: Set<string>;
    moving: Set<string>; // script keys whose body (transitively) moves the player
    ast: Map<string, Stmt[]>;
    db: Map<string, DbRow[]>;
}

function astOf(ctx: Ctx, s: Script): Stmt[] {
    const k = `${s.type},${s.name}`;
    let a = ctx.ast.get(k);
    if (!a) { a = new Parser(tokenize(s.body)).program(); ctx.ast.set(k, a); }
    return a;
}

class Run {
    st: RunState;
    frames: Map<string, V>[] = [];
    line = 0;
    files: string[] = [];
    constructor(private ctx: Ctx, private p: Placement, private assume: Map<string, string>, public used: Assumption[]) {
        this.st = { pos: { c: { x: p.x, z: p.z, level: p.level }, exact: false }, moved: false, fee: 0, consumes: [], damage: [], changes: [], queued: [], steps: 0 };
    }
    get file() { return this.files[this.files.length - 1]!; }
    src(line: number) { return `${this.file}:${line}`; }

    decide(sym: Sym, options: string[], details: string[]): string {
        if (!sym.line) sym = { ...sym, line: this.line };
        const key = sym.cls === 'random' || sym.cls === 'choice' || sym.cls === 'dynamic' ? `${sym.text}@${this.file}:${sym.line}` : sym.text;
        const got = this.assume.get(key);
        if (got !== undefined) {
            if (!this.used.some(u => u.key === key)) this.used.push({ key, value: got, sym, detail: details[options.indexOf(got)] ?? got, line: sym.line, file: this.file });
            return got;
        }
        throw new Fork(key, options, sym, details, sym.line, this.file);
    }
    truth(v: V, line: number): boolean {
        if (v.t === 'bool') return v.v;
        if (v.t === 'int') return v.v !== 0;
        if (v.t === 'cond') {
            const opT = v.op, opF = OP_NEG[v.op] ?? `not ${v.op}`;
            const base = `${v.sym.text}`;
            return this.decide({ ...v.sym, text: `${base} ${v.op} ${show(v.rhs)}` }, ['T', 'F'], [`${base} ${opT} ${show(v.rhs)}`, `${base} ${opF} ${show(v.rhs)}`]) === 'T';
        }
        if (v.t === 'sym') return this.decide(v, ['T', 'F'], [`${v.text} = true`, `${v.text} = false`]) === 'T';
        throw new Unsupported(`condition not understood at line ${line}: ${show(v)}`);
    }

    // ---- expressions ----
    lookupVar(n: string): V {
        for (let i = this.frames.length - 1; i >= 0; i--) { const v = this.frames[i]!.get(n); if (v) return v; break; }
        return { t: 'unk', why: `$${n} unset` };
    }
    constant(n: string, depth = 0): V {
        const c = this.ctx.constants.get(n);
        if (!c || depth > 5) return { t: 'unk', why: `^${n} undefined` };
        const s = c.value;
        if (/^-?\d+$/.test(s)) return { t: 'int', v: Number(s) };
        if (/^\d+_\d+_\d+_\d+_\d+$/.test(s)) return { t: 'coord', c: parseCoord(s), exact: true };
        if (s === 'true' || s === 'false') return { t: 'bool', v: s === 'true' };
        if (s.startsWith('"')) return { t: 'str' };
        if (s.startsWith('^')) return this.constant(s.slice(1), depth + 1);
        return { t: 'name', v: s };
    }
    locParam(name: string): V {
        const cfg = this.ctx.locConfigs.get(this.p.locName);
        const row = cfg?.props.param?.find(r => r.split(',')[0]!.trim() === name);
        if (!row) return { t: 'unk', why: `loc_param(${name}) not set on ${this.p.locName}` };
        const val = row.slice(row.indexOf(',') + 1).trim();
        if (/^-?\d+$/.test(val)) return { t: 'int', v: Number(val) };
        if (/^\d+_\d+_\d+_\d+_\d+$/.test(val)) return { t: 'coord', c: parseCoord(val), exact: true };
        if (/^\^/.test(val)) return this.constant(val.slice(1));
        return { t: 'name', v: val };
    }
    // A tuple-returning proc call as an argument fills several parameters.
    argList(args: Expr[]): V[] { return args.flatMap(a => { const v = this.eval(a); return v.t === 'tuple' ? v.vs : [v]; }); }
    dbRows: DbRow[] | null = null;
    fieldValue(raw: string): string { const v = this.literal(raw.trim()); return v.t === 'int' ? String(v.v) : v.t === 'name' ? v.v : raw.trim(); }
    literal(s: string): V {
        if (/^-?\d+$/.test(s)) return { t: 'int', v: Number(s) };
        if (/^\d+_\d+_\d+_\d+_\d+$/.test(s)) return { t: 'coord', c: parseCoord(s), exact: true };
        if (s.startsWith('^')) return this.constant(s.slice(1));
        if (s === 'true' || s === 'false') return { t: 'bool', v: s === 'true' };
        return { t: 'name', v: s };
    }
    int(v: V): number | null { return v.t === 'int' ? v.v : v.t === 'bool' ? (v.v ? 1 : 0) : null; }
    coordOf(v: V): { c: Coord; exact: boolean } | null { return v.t === 'coord' ? { c: v.c, exact: v.exact } : null; }

    eval(e: Expr | undefined): V {
        if (!e) throw new Unsupported(`missing argument at line ${this.line}`);
        if (++this.st.steps > MAX_STEPS) throw new Unsupported('step limit');
        switch (e.k) {
            case 'num': return { t: 'int', v: e.v };
            case 'coord': return { t: 'coord', c: parseCoord(e.v), exact: true };
            case 'str': return { t: 'str' };
            case 'var': return this.lookupVar(e.n);
            case 'varp': {
                const quest = this.ctx.questVarps.has(e.n);
                return { t: 'sym', cls: quest ? 'varp' : 'dynamic', text: `%${e.n}`, line: 0, meta: { varp: e.n } };
            }
            case 'const': return this.constant(e.n);
            case 'id': return this.ident(e.n);
            case 'neg': { const v = this.eval(e.a), a = this.int(v); return a === null ? { t: 'unk', why: 'negation' } : { t: 'int', v: -a, ...approxOf(v) }; }
            case 'bin': return this.binary(e);
            case 'call': return this.call(e);
        }
    }
    ident(n: string): V {
        switch (n) {
            case 'true': return { t: 'bool', v: true };
            case 'false': return { t: 'bool', v: false };
            case 'null': return { t: 'name', v: 'null' };
            case 'coord': return this.st.pos ? { t: 'coord', c: this.st.pos.c, exact: this.st.pos.exact } : { t: 'unk', why: this.st.posWhy ?? 'player position unknown' };
            case 'loc_coord': return { t: 'coord', c: { x: this.p.x, z: this.p.z, level: this.p.level }, exact: true };
            case 'loc_angle': return { t: 'int', v: this.p.angle };
            case 'loc_shape': return { t: 'int', v: this.p.shape };
            case 'loc_type': return { t: 'name', v: this.p.locName };
            case 'map_members': return { t: 'bool', v: true };
            case 'last_useitem': case 'last_slot': return { t: 'sym', cls: n === 'last_useitem' ? 'useitem' : 'dynamic', text: n, line: 0 };
            case 'last_int': return { t: 'sym', cls: 'choice', text: 'last_int', line: 0 };
            case 'map_clock': case 'uid': case 'npc_uid': return { t: 'sym', cls: 'dynamic', text: n, line: 0 };
            case 'inv': case 'worn': case 'bank': return { t: 'name', v: n };
        }
        const shape = LOC_SHAPES.indexOf(n);
        if (shape >= 0) return { t: 'int', v: shape };
        if (n === 'db_findnext') return this.call({ k: 'call', n, args: [], proc: false, line: this.line });
        return { t: 'name', v: n };
    }
    binary(e: Extract<Expr, { k: 'bin' }>): V {
        const a = this.eval(e.a), b = this.eval(e.b);
        if (e.op === '&' || e.op === '|') {
            const and = e.op === '&';
            const known = (v: V) => v.t === 'bool' ? v.v : v.t === 'int' ? v.v !== 0 : null;
            const ka = known(a), kb = known(b);
            if (and && (ka === false || kb === false)) return { t: 'bool', v: false };
            if (!and && (ka === true || kb === true)) return { t: 'bool', v: true };
            if (ka !== null && kb !== null) return { t: 'bool', v: and ? ka && kb : ka || kb };
            if (ka !== null) return b; if (kb !== null) return a;
            const ta = this.truth(a, 0);
            if (and && !ta) return { t: 'bool', v: false };
            if (!and && ta) return { t: 'bool', v: true };
            return { t: 'bool', v: this.truth(b, 0) };
        }
        if (['+', '-', '*', '/'].includes(e.op)) {
            const x = this.int(a), y = this.int(b);
            if (x === null || y === null) return { t: 'unk', why: `arithmetic on ${show(a)} ${e.op} ${show(b)}` };
            return { t: 'int', v: e.op === '+' ? x + y : e.op === '-' ? x - y : e.op === '*' ? x * y : y === 0 ? 0 : Math.trunc(x / y), ...approxOf(a, b) };
        }
        return this.compare(e.op, a, b, exprText(e));
    }
    compare(op: string, a: V, b: V, text: string): V {
        const sa = a.t === 'sym' ? a : null, sb = b.t === 'sym' ? b : null;
        if (sa && !sb && b.t !== 'unk' && b.t !== 'cond') return { t: 'cond', sym: sa, op, rhs: b, text, line: 0 };
        if (sb && !sa && a.t !== 'unk' && a.t !== 'cond') return { t: 'cond', sym: sb, op: ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=' } as Record<string, string>)[op] ?? op, rhs: a, text, line: 0 };
        if (sa && sb) return { t: 'sym', cls: sa.cls === 'side' || sb.cls === 'side' ? 'side' : 'dynamic', text, line: 0 };
        if (a.t === 'unk' || b.t === 'unk') {
            const why = a.t === 'unk' ? a.why : (b as { why: string }).why;
            if (/player position|inexact/.test(why)) return { t: 'sym', cls: 'side', text, line: 0 };
            return { t: 'sym', cls: 'dynamic', text: `${text} [${why}]`, line: 0 };
        }
        if (a.t === 'coord' && b.t === 'coord') {
            if (!a.exact || !b.exact) return { t: 'sym', cls: 'side', text, line: 0 };
            const eq = a.c.x === b.c.x && a.c.z === b.c.z && a.c.level === b.c.level;
            if (op === '=') return { t: 'bool', v: eq }; if (op === '!') return { t: 'bool', v: !eq };
            throw new Unsupported(`coord compared with ${op}`);
        }
        if ((a.t === 'int' && a.approx) || (b.t === 'int' && b.approx)) return { t: 'sym', cls: 'side', text, line: 0 };
        const x = this.int(a), y = this.int(b);
        if (x !== null && y !== null) {
            const r = op === '=' ? x === y : op === '!' ? x !== y : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
            return { t: 'bool', v: r };
        }
        if (a.t === 'name' && b.t === 'name') { if (op === '=') return { t: 'bool', v: a.v === b.v }; if (op === '!') return { t: 'bool', v: a.v !== b.v }; }
        if (a.t === 'str' || b.t === 'str') return { t: 'sym', cls: 'dynamic', text, line: 0 };
        if (a.t === 'cond' || b.t === 'cond') {
            const c = (a.t === 'cond' ? a : b) as Extract<V, { t: 'cond' }>, o = a.t === 'cond' ? b : a;
            const k = this.int(o);
            if (k !== null && (op === '=' || op === '!')) { const t = this.truth(c, 0); return { t: 'bool', v: op === '=' ? t === (k !== 0) : t !== (k !== 0) }; }
        }
        return { t: 'sym', cls: 'dynamic', text: `${text} [${show(a)} ${op} ${show(b)}]`, line: 0 };
    }
    call(e: Extract<Expr, { k: 'call' }>): V {
        const n = e.n, line = e.line;
        if (e.proc) return this.callProc(e);
        const A = () => e.args.map(a => this.eval(a));
        const posSym = (c: { c: Coord; exact: boolean } | null, axis: string): V => !c ? { t: 'unk', why: 'player position unknown' } : { t: 'int', v: axis === 'x' ? c.c.x : axis === 'z' ? c.c.z : c.c.level, ...(c.exact ? {} : { approx: true as const }) };
        if (!e.args.length && ['coord', 'loc_coord', 'loc_angle', 'loc_shape', 'loc_type', 'map_clock', 'last_useitem', 'map_members'].includes(n)) return this.ident(n);
        switch (n) {
            case 'db_find': case 'db_find_with_count': {
                const [table, col] = exprText(e.args[0]!).split(':');
                const want = this.eval(e.args[1]!);
                const wantText = want.t === 'int' ? String(want.v) : want.t === 'name' ? want.v : null;
                if (wantText === null) { this.dbRows = null; return { t: 'unk', why: 'db_find on unresolved value' }; }
                this.dbRows = (this.ctx.db.get(table!) ?? []).filter(r => r.data[col!]?.some(v => this.fieldValue(v[0]!) === wantText));
                return { t: 'int', v: this.dbRows.length };
            }
            case 'db_findnext': {
                const row = this.dbRows?.shift();
                return row ? { t: 'name', v: `dbrow:${row.name}` } : this.dbRows ? { t: 'name', v: 'null' } : { t: 'unk', why: 'db_findnext without db_find' };
            }
            case 'db_getfield': case 'db_getfieldcount': {
                const r = this.eval(e.args[0]!);
                const [table, col] = exprText(e.args[1]!).split(':');
                const row = r.t === 'name' && r.v.startsWith('dbrow:') ? (this.ctx.db.get(table!) ?? []).find(x => x.name === r.v.slice(6)) : undefined;
                if (!row) return { t: 'unk', why: `db_getfield on ${show(r)}` };
                const vals = row.data[col!] ?? [];
                if (n === 'db_getfieldcount') return { t: 'int', v: vals.length };
                const idx = this.int(this.eval(e.args[2]!));
                const raw = idx === null ? undefined : vals[idx]?.[0];
                if (raw === undefined) return { t: 'unk', why: `${table}:${col} index ${idx === null ? 'unresolved' : idx} on ${row.name}` };
                return this.literal(raw.trim());
            }
            case 'random': { const k = this.int(this.eval(e.args[0]!)); if (k === 1) return { t: 'int', v: 0 }; return { t: 'sym', cls: 'dynamic', text: exprText(e), line }; }
            case 'map_findsquare': {
                // A free tile within the max radius (arg 3) of the base coord: the landing is approximate.
                const c = this.coordOf(this.eval(e.args[0]!));
                if (!c) return { t: 'unk', why: `map_findsquare(${exprText(e.args[0]!)})` };
                return { t: 'coord', c: c.c, exact: false };
            }
            case 'calc': return this.eval(e.args[0]!);
            case 'abs': { const a = this.eval(e.args[0]!), x = this.int(a); return x === null ? { t: 'unk', why: 'abs on unknown' } : { t: 'int', v: Math.abs(x), ...approxOf(a) }; }
            case 'add': case 'sub': case 'multiply': case 'divide': case 'min': case 'max': case 'modulo': {
                const av = A(); const [x, y] = av.map(v => this.int(v)); if (x == null || y == null) return { t: 'unk', why: `${n} on unknown` };
                return { ...approxOf(...av), t: 'int', v: n === 'add' ? x + y : n === 'sub' ? x - y : n === 'multiply' ? x * y : n === 'divide' ? (y ? Math.trunc(x / y) : 0) : n === 'min' ? Math.min(x, y) : n === 'max' ? Math.max(x, y) : (y ? x % y : 0) };
            }
            case 'coordx': case 'coordz': case 'coordy': return posSym(this.coordOf(this.eval(e.args[0]!)), n.slice(5));
            case 'movecoord': {
                const [c, dx, dl, dz] = A(); const base = this.coordOf(c!);
                const ix = this.int(dx!), il = this.int(dl!), iz = this.int(dz!);
                if (!base || ix === null || il === null || iz === null) return { t: 'unk', why: c!.t === 'unk' ? c!.why : `movecoord(${e.args.map(exprText).join(', ')}) not resolved` };
                // movecoord(coord, coordx(loc_coord) - coordx(coord), ..) is exact on that axis; the whole coord stays inexact.
                return { t: 'coord', c: { x: (base.c.x + ix) & 0x3fff, z: (base.c.z + iz) & 0x3fff, level: (base.c.level + il) & 3 }, exact: base.exact && !approxOf(dx!, dl!, dz!).approx };
            }
            case 'distance': {
                const [a, b] = A().map(v => this.coordOf(v));
                if (!a || !b) return { t: 'unk', why: 'player position unknown' };
                return { t: 'int', v: Math.max(Math.abs(a.c.x - b.c.x), Math.abs(a.c.z - b.c.z)), ...(a.exact && b.exact ? {} : { approx: true as const }) };
            }
            case 'loc_param': return this.locParam(exprText(e.args[0]!));
            case 'stat': case 'stat_base': return { t: 'sym', cls: 'skill', text: `${n}(${exprText(e.args[0]!)})`, line, meta: { skill: exprText(e.args[0]!) } };
            case 'stat_random': {
                const [lo, hi] = [this.int(this.eval(e.args[1]!)), this.int(this.eval(e.args[2]!))];
                return { t: 'sym', cls: 'random', text: `stat_random(${e.args.map(exprText).join(', ')})`, line, meta: { stat: exprText(e.args[0]!), low: lo ?? undefined, high: hi ?? undefined } };
            }
            case 'inv_total': {
                const inv = exprText(e.args[0]!), obj = exprText(e.args[1]!);
                return { t: 'sym', cls: inv === 'worn' ? 'worn' : inv === 'inv' ? 'item' : 'dynamic', text: `inv_total(${inv}, ${obj})`, line, meta: { item: obj } };
            }
            case 'tostring': case 'append': return { t: 'str' };
        }
        return { t: 'sym', cls: 'dynamic', text: exprText(e), line };
    }
    callProc(e: Extract<Expr, { k: 'call' }>): V {
        const n = e.n, line = e.line;
        if (/choice|multi\d|^menu/i.test(n)) return { t: 'sym', cls: 'choice', text: `~${n}(${e.args.filter(a => a.k === 'str').length} options)`, line };
        if (/^check_axis/.test(n)) return { t: 'sym', cls: 'side', text: exprText(e), line };
        const proc = this.ctx.scripts.get(`proc,${n}`);
        // Value procs run in place (db lookups, distance helpers); dialogue, door and random-event procs stay symbolic.
        if (proc && this.depth < 24 && valueProc(proc)) {
            const v = this.enter(proc, this.argList(e.args), false);
            if (v && v.t !== 'unk') return v;
        }
        return { t: 'sym', cls: 'dynamic', text: `~${n}(${e.args.map(exprText).join(', ')})`, line };
    }

    // ---- statements ----
    // `approach` walks (p_walk, forcewalk, forcewalk2) only bring the player to the start tile; they move the player but do not make an edge.
    moveTo(v: V, line: number, approach = false) {
        const c = this.coordOf(v);
        if (!approach) { this.st.moved = true; this.st.moveSrc = this.src(line); }
        if (!c) { this.st.pos = null; this.st.posWhy = `destination not resolved at ${this.src(line)}: ${show(v)}`; return; }
        this.st.pos = { c: c.c, exact: c.exact };
    }
    execList(list: Stmt[]): void { for (const s of list) this.exec(s); }
    exec(s: Stmt): void {
        if (++this.st.steps > MAX_STEPS) throw new Unsupported('step limit');
        this.line = s.line;
        const frame = this.frames[this.frames.length - 1]!;
        switch (s.k) {
            case 'def': frame.set(s.n, s.e ? this.eval(s.e) : { t: 'unk', why: `$${s.n} default` }); return;
            case 'assign': {
                const v = s.targets.length === 1 ? this.eval(s.e) : ({ t: 'unk', why: 'multi-assign' } as V);
                for (const t of s.targets) if (t.local) frame.set(t.n, s.targets.length === 1 ? v : { t: 'sym', cls: 'dynamic', text: `$${t.n}`, line: s.line });
                return;
            }
            case 'return': { const vs = s.es.map(x => this.eval(x)); throw new ProcReturn(vs.length === 1 ? vs[0] : vs.length ? { t: 'tuple', vs } : undefined); }
            case 'jump': {
                const label = this.ctx.scripts.get(`label,${s.n}`);
                if (!label) throw new Unsupported(`label ${s.n} not found`);
                if (skipCall(label)) throw new EndPath();
                this.enter(label, s.args.map(a => this.eval(a)), true);
                throw new EndPath();
            }
            case 'if': {
                const c = this.eval(s.c);
                if (this.truth(c, s.line)) this.execList(s.then); else if (s.else) this.execList(s.else);
                return;
            }
            case 'switch': {
                const v = this.eval(s.e);
                const labelsOf = (c: { labels: (Expr | 'default')[] }) => c.labels.map(l => l === 'default' ? 'default' : this.eval(l));
                if (v.t === 'sym') {
                    const opts = s.cases.map((_, i) => `c${i}`);
                    const det = s.cases.map(c => `${v.text} = ${labelsOf(c).map(l => l === 'default' ? 'default' : show(l)).join(' | ')}`);
                    const pick = this.decide({ ...v, line: v.line || s.line }, opts, det);
                    this.execList(s.cases[Number(pick.slice(1))]!.body); return;
                }
                if (v.t === 'unk' || v.t === 'cond') throw new Unsupported(`switch on unresolved value at line ${s.line}: ${show(v)}`);
                let def: Stmt[] | undefined;
                for (const c of s.cases) {
                    const ls = labelsOf(c);
                    if (ls.includes('default')) def = c.body;
                    if (ls.some(l => l !== 'default' && this.compare('=', v, l, '') .t === 'bool' && (this.compare('=', v, l, '') as { v: boolean }).v)) { this.execList(c.body); return; }
                }
                if (def) this.execList(def);
                return;
            }
            case 'while': throw new Unsupported(`while loop at line ${s.line}`);
            case 'expr': this.stmtExpr(s.e, s.line); return;
        }
    }
    stmtExpr(e: Expr, line: number) {
        if (e.k !== 'call') return;
        const args = () => this.argList(e.args);
        if (!e.proc) {
            const idx = MOVE_CMDS[e.n];
            if (idx !== undefined) { if (!e.args[idx]) throw new Unsupported(`${e.n} without destination at ${this.src(line)}`); this.moveTo(this.eval(e.args[idx]!), line, e.n === "p_walk"); return; }
            if (QUEUE_CMDS.test(e.n)) {
                const q = this.ctx.scripts.get(`queue,${exprText(e.args[0]!)}`);
                if (q && !skipCall(q) && this.ctx.moving.has(`queue,${q.name}`)) this.st.queued.push(q);
                return;
            }
            if (/^db_find/.test(e.n)) { this.eval(e); return; }
            if (e.n === 'inv_del' && e.args.length >= 3) {
                const inv = exprText(e.args[0]!), obj = exprText(e.args[1]!), n = this.int(this.eval(e.args[2]!));
                if (inv === 'inv' && obj === 'coins') this.st.fee += n ?? 0;
                else if (inv === 'inv' || inv === 'worn') this.st.consumes.push(`${obj} x${n ?? '?'}`);
                return;
            }
            if (e.n === 'damage' && e.args.length >= 3) { this.st.damage.push(exprText(e.args[2]!)); return; }
            if (e.n === 'loc_change') { this.st.changes.push({ locName: exprText(e.args[0]!), line: this.src(line) }); return; }
            return;
        }
        const mp = MOVE_PROCS[e.n];
        if (mp) {
            const a = args();
            if (mp.damage !== undefined) this.st.damage.push(exprText(e.args[mp.damage]!));
            if (mp.dest !== undefined) { this.moveTo(a[mp.dest]!, line, /^forcewalk2?$/.test(e.n)); return; }
            const [dx, dz] = [this.int(a[mp.rel![0]]!), this.int(a[mp.rel![1]]!)];
            const pos = this.st.pos;
            if (!pos || dx === null || dz === null) { this.moveTo({ t: 'unk', why: `relative walk ${e.args.map(exprText).join(', ')}` }, line); return; }
            this.moveTo({ t: 'coord', c: { x: pos.c.x + dx, z: pos.c.z + dz, level: pos.c.level }, exact: pos.exact }, line); return;
        }
        if (DAMAGE_PROCS.has(e.n)) { this.st.damage.push(e.args.map(exprText).join(', ')); return; }
        const proc = this.ctx.scripts.get(`proc,${e.n}`);
        if (proc && !skipCall(proc) && this.ctx.moving.has(`proc,${e.n}`)) this.enter(proc, args(), false);
    }
    depth = 0;
    enter(s: Script, args: V[], isLabel: boolean): V | undefined {
        const frame = new Map<string, V>();
        s.params.forEach((p, i) => frame.set(p.name, args[i] ?? { t: 'unk', why: `missing arg ${p.name}` }));
        let ast: Stmt[];
        try { ast = astOf(this.ctx, s); } catch (err) { if (err instanceof Unsupported) throw new Unsupported(`${s.file}:${s.line}: ${err.message}`); throw err; }
        this.frames.push(frame); this.files.push(s.file); this.depth++;
        const leave = () => { this.frames.pop(); this.files.pop(); this.depth--; };
        try { this.execList(ast); }
        catch (err) {
            leave();
            if (err instanceof ProcReturn && !isLabel) return err.value;
            if (err instanceof ProcReturn) throw new EndPath();
            throw err;
        }
        leave();
        return undefined;
    }
    top(s: Script) {
        try { this.enter(s, [], true); }
        catch (err) { if (!(err instanceof EndPath)) throw err; }
        // Queued scripts run after the trigger, in order. A queue script may queue more.
        for (let i = 0; i < this.st.queued.length && i < 8; i++) {
            try { this.enter(this.st.queued[i]!, [], true); } catch (err) { if (!(err instanceof EndPath)) throw err; }
        }
    }
}

interface RunResult { assumptions: Assumption[]; st: RunState }
function runAll(ctx: Ctx, s: Script, p: Placement): { results: RunResult[]; gap?: string } {
    const work: Map<string, string>[] = [new Map()];
    const results: RunResult[] = [];
    let runs = 0;
    while (work.length) {
        if (++runs > MAX_RUNS) return { results, gap: `more than ${MAX_RUNS} condition branches` };
        const assume = work.pop()!;
        const used: Assumption[] = [];
        const r = new Run(ctx, p, assume, used);
        try { r.top(s); results.push({ assumptions: used, st: r.st }); }
        catch (err) {
            if (err instanceof Fork) { for (const o of err.options) work.push(new Map([...assume, [err.key, o]])); continue; }
            if (err instanceof Unsupported) return { results, gap: err.message };
            return { results, gap: `interpreter error: ${(err as Error).message}` };
        }
    }
    return { results };
}

// ---------- requirement mapping ----------
// True when the assumption is a stat_random roll that fails: `stat_random(..) = false` holds, or a bare or `= true` roll does not.
function rollFailed(a: Assumption): boolean {
    if (a.sym.cls !== 'random' || !a.sym.text.startsWith('stat_random')) return false;
    const m = a.sym.text.match(/ (=|!) (true|false|0|1)$/);
    if (!m) return a.value === 'F';
    const holdsMeansFalse = (m[1] === '=') === (m[2] === 'false' || m[2] === '0');
    return holdsMeansFalse ? a.value === 'T' : a.value === 'F';
}
const normOp = (op: string, value: string) => value === 'T' ? op : (OP_NEG[op] ?? op);
function minNeeded(op: string, n: number): number | null { return op === '>=' ? n : op === '>' ? n + 1 : op === '=' ? n : null; }

interface Built { requires: Requirements; side: string[]; choices: string[]; conditions: string[]; requireSrc: string[]; failure?: { a: Assumption } }
function mapAssumptions(as: Assumption[]): Built {
    const req: Requirements = {}; const side: string[] = [], choices: string[] = [], conditions: string[] = [], requireSrc: string[] = [];
    let failure: Built['failure'];
    for (const a of as) {
        const src = `${a.file}:${a.line}`;
        const m = a.key.match(/^(.*) (<=|>=|=|!|<|>) (.+)$/);
        const op = m ? normOp(m[2]!, a.value) : '', rhs = m?.[3] ?? '';
        const num = /^-?\d+$/.test(rhs) ? Number(rhs) : null;
        switch (a.sym.cls) {
            case 'skill': {
                const need = num !== null ? minNeeded(op, num) : null;
                if (need !== null) { (req.skills ??= []).push({ name: a.sym.meta!.skill!, level: need, src }); requireSrc.push(src); }
                else if (num !== null && (op === '<' || op === '<=')) conditions.push(`${a.sym.meta!.skill} ${op} ${num} (${src})`);
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'item': case 'worn': {
                const list = a.sym.cls === 'item' ? (req.items ??= []) : (req.worn ??= []);
                const obj = a.sym.meta!.item!;
                // "Holds none of X" only selects a branch (e.g. which pickaxe); it is a condition, not a need.
                if (m && num !== null && ((op === '<=' && num <= 0) || (op === '<' && num <= 1) || (op === '=' && num === 0))) { conditions.push(`without ${a.sym.cls === 'worn' ? 'worn ' : ''}${obj} (${src})`); break; }
                if (m && (num !== null)) {
                    if (obj === 'coins' && a.sym.cls === 'item') { const need = minNeeded(op, num); if (need !== null) req.coins = Math.max(req.coins ?? 0, need); else list.push({ item: obj, op, count: num, src }); }
                    else list.push({ item: obj, op, count: num, src });
                } else if (m) list.push({ item: obj, op, count: rhs, src });
                else conditions.push(`${a.detail} (${src})`);
                requireSrc.push(src); break;
            }
            case 'varp': {
                if (m) { (req.varps ??= []).push({ varp: a.sym.meta!.varp!, op, value: num ?? rhs, quest: true, src }); requireSrc.push(src); }
                else if (a.value.startsWith('c')) { (req.varps ??= []).push({ varp: a.sym.meta!.varp!, op: 'in', value: a.detail.replace(/^%\w+ = /, ''), quest: true, src }); requireSrc.push(src); }
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'useitem': {
                const item = m && op === '=' ? rhs : a.value.startsWith('c') ? a.detail.replace(/^last_useitem = /, '') : null;
                if (item && item !== 'default') { req.useItem = { item, src }; requireSrc.push(src); }
                else conditions.push(`${a.detail} (${src})`);
                break;
            }
            case 'side': side.push(`${a.detail} (${src})`); break;
            case 'choice': choices.push(`${a.detail} (${src})`); break;
            case 'random':
                if (rollFailed(a)) failure = { a };
                else if (!a.sym.text.startsWith('stat_random')) conditions.push(`${a.detail} (${src})`);
                break;
            default: conditions.push(`${a.detail} (${src})`);
        }
    }
    if (req.skills?.length) { const top = req.skills.reduce((x, y) => y.level > x.level ? y : x); req.skill = { name: top.name, level: top.level }; }
    return { requires: req, side, choices, conditions, requireSrc: [...new Set(requireSrc)], ...(failure ? { failure } : {}) };
}

// Removes an assumption that two results with the same outcome take with opposite values; it does not decide that outcome.
function minimize(rs: RunResult[], outcome: (r: RunResult) => string): RunResult[] {
    let list = rs.map(r => ({ ...r, assumptions: [...r.assumptions] }));
    for (let changed = true; changed;) {
        changed = false;
        outer: for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!, b = list[j]!;
            if (outcome(a) !== outcome(b)) continue;
            const ka = new Map(a.assumptions.map(x => [x.key, x.value])), kb = new Map(b.assumptions.map(x => [x.key, x.value]));
            const diff = [...new Set([...ka.keys(), ...kb.keys()])].filter(k => ka.get(k) !== kb.get(k));
            const same = (x: Map<string, string>, y: Map<string, string>) => [...x].every(([k, v]) => k === diff[0] || y.get(k) === v);
            if (diff.length === 1 && ka.has(diff[0]!) && kb.has(diff[0]!) && same(ka, kb) && same(kb, ka)) {
                a.assumptions = a.assumptions.filter(x => x.key !== diff[0]);
                list.splice(j, 1); changed = true; break outer;
            }
            if (diff.length === 0) { list.splice(j, 1); changed = true; break outer; }
        }
    }
    return list;
}

// ---------- classification ----------
function kindOf(file: string, requires: Requirements, randomStat?: string): ShortcutKind {
    if (/skill_agility\/scripts\/(barbarian|gnome|wilderness)_course\.rs2$/.test(file) || file.includes('minigames/game_agilityarena/')) return 'course';
    // A passage in a quest folder is 'quest' even with an Agility need; the quest varps gate it.
    if (file.startsWith('scripts/quests/')) return 'quest';
    if (file.includes('skill_agility/') || requires.skills?.some(s => s.name === 'agility') || randomStat === 'agility') return 'shortcut';
    if (file.startsWith('scripts/minigames/')) return 'minigame';
    if (file.startsWith('scripts/tutorial/')) return 'tutorial';
    return 'passage';
}

// ---------- build ----------
export interface BuildInput {
    scriptFiles: { text: string; file: string }[];
    constantFiles: { text: string; file: string }[];
    locConfigs: Map<string, ConfigBlock>;
    locPack: Map<number, string>;
    locs: LocSpawn[];
    questVarps: Set<string>;
    excludeLocNames: Set<string>; // covered by transports.json or doors.json
    dbTables: DbTable[];
}
export interface BuildOutput { edges: ShortcutEdge[]; gaps: ShortcutGap[]; handlers: number }

const MOVE_TEXT = /\b(p_telejump|p_teleport|p_exactmove|p_walk)\s*\(|~(forcemove|forcewalk2?|agility_\w+|clipped_telewalk|climb_ladder)\s*\(/;
export function movingScripts(scripts: Map<string, Script>): Set<string> {
    const moving = new Set<string>();
    const text = new Map([...scripts].map(([k, s]) => [k, s.body.map(b => b.text).join('\n')]));
    for (const [k, t] of text) if (MOVE_TEXT.test(t)) moving.add(k);
    for (let changed = true; changed;) {
        changed = false;
        for (const [k, t] of text) {
            if (moving.has(k)) continue;
            const calls = [...t.matchAll(/~(\w+)/g)].map(m => `proc,${m[1]}`).concat([...t.matchAll(/@(\w+)/g)].map(m => `label,${m[1]}`), [...t.matchAll(/\b(?:weak|strong|long)?queue\((\w+)/g)].map(m => `queue,${m[1]}`));
            if (calls.some(c => moving.has(c))) { moving.add(k); changed = true; }
        }
    }
    return moving;
}

export function buildShortcuts(inp: BuildInput): BuildOutput {
    const scripts = parseScripts(inp.scriptFiles);
    const constants = new Map<string, { value: string; src: string }>();
    for (const { text, file } of inp.constantFiles) stripComments(text).forEach((l, i) => { const m = l.match(/^\^(\w+)\s*=\s*(.+)$/); if (m && !constants.has(m[1]!)) constants.set(m[1]!, { value: m[2]!.trim(), src: `${file}:${i + 1}` }); });
    const ctx: Ctx = { scripts, constants, locConfigs: inp.locConfigs, paramTypes: new Map(), questVarps: inp.questVarps, moving: movingScripts(scripts), ast: new Map(), db: new Map(inp.dbTables.map(t => [t.table, t.rows])) };
    const byCategory = new Map<string, string[]>();
    for (const [n, b] of inp.locConfigs) { const c = b.props.category?.[0]; if (c) byCategory.set(c, [...byCategory.get(c) ?? [], n]); }
    const ids = new Map([...inp.locPack].map(([id, n]) => [n, id]));
    const placements = new Map<string, Placement[]>();
    for (const l of inp.locs) { const n = inp.locPack.get(l.id); if (n) { let a = placements.get(n); if (!a) placements.set(n, a = []); a.push({ locName: n, id: l.id, x: l.x, z: l.z, level: l.level, shape: l.shape, angle: l.angle, src: l.src }); } }

    // Trigger for one loc and option: its own [oplocN,name], else its category's [oplocN,_category].
    const triggerFor = (loc: string, op: string) => scripts.get(`${op},${loc}`) ?? (() => { const c = inp.locConfigs.get(loc)?.props.category?.[0]; return c ? scripts.get(`${op},_${c}`) : undefined; })();
    const OPS = ['oploc1', 'oploc2', 'oploc3', 'oploc4', 'oploc5', 'oplocu'];
    // Ladders and stairs are in transports.json, doors in doors.json. Gathering, processing and leaning scripts
    // step the player next to the loc; they are not transport.
    const skipFile = (f: string) => /^scripts\/(ladders\+stairs|macro events|doors)\//.test(f) || /^scripts\/skill_(?!agility|runecraft)/.test(f)
        || /general_use\/scripts\/(pickables|spade|water_sources|shear_sheep|windmills|haybales)\.rs2$/.test(f) || /game_duelarena\/scripts\/duel_arena_lean\.rs2$/.test(f);

    const targets = new Map<Script, string[]>();
    const changeTargets = (t: Script) => { let v = targets.get(t); if (!v) { v = [...t.body.map(b => b.text).join('\n').matchAll(/\bloc_change\s*\(\s*(\w+)/g)].map(m => m[1]!); targets.set(t, v); } return v; };
    const edges: ShortcutEdge[] = [], gaps: ShortcutGap[] = [];
    const handlers = new Set<string>();
    const capped = new Map<string, number>();
    const queue: Placement[] = [...[...placements.values()].flat()];
    const seen = new Set<string>();
    let qi = 0;
    while (qi < queue.length) {
        const p = queue[qi++]!;
        const pk = `${p.locName},${p.x},${p.z},${p.level}`;
        if (seen.has(pk)) continue; seen.add(pk);
        if (inp.excludeLocNames.has(p.locName)) continue;
        for (const op of OPS) {
            const trig = triggerFor(p.locName, op);
            if (!trig || skipFile(trig.file)) continue;
            const key = `${trig.type},${trig.name}`;
            const handler = `${trig.file}:${trig.line}`;
            const option = op === 'oplocu' ? 'opu' : `op${op.slice(5)}`;
            const optionText = op === 'oplocu' ? 'Use' : inp.locConfigs.get(p.locName)?.props[option]?.[0] ?? null;
            const moving = ctx.moving.has(key);
            const changes = changeTargets(trig).some(n => OPS.some(o => { const t = triggerFor(n, o); return !!t && !skipFile(t.file) && ctx.moving.has(`${t.type},${t.name}`); }));
            if (!moving && !changes) continue;
            let out: ReturnType<typeof runAll>;
            const t0 = performance.now(); if (process.env.SHORTCUTS_TRACE) console.error(`run ${handler} ${pk}`);
            if ((capped.get(handler) ?? 0) >= MAX_CAPPED) { if (moving) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: `not run: this handler passed ${MAX_RUNS} condition branches on ${MAX_CAPPED} other placements` }); continue; }
            try { out = runAll(ctx, trig, p); }
            catch (err) { if (err instanceof Unsupported) { if (moving) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: err.message }); continue; } throw err; }
            if (out.gap?.startsWith('more than')) capped.set(handler, (capped.get(handler) ?? 0) + 1);
            // A loc_change in a run that does not move adds the new loc at this tile; its own triggers run later.
            for (const r of out.results) if (!r.st.moved) for (const c of r.st.changes) {
                const id = ids.get(c.locName);
                if (id !== undefined && !inp.excludeLocNames.has(c.locName)) queue.push({ ...p, locName: c.locName, id, via: { locName: p.via?.locName ?? p.locName, option, src: c.line } });
            }
            const ms = performance.now() - t0;
            if (process.env.SHORTCUTS_DEBUG && ms > 200) console.error(`slow ${Math.round(ms)}ms ${handler} ${pk} runs=${out.results.length}`);
            if (!moving) continue;
            handlers.add(handler);
            const movedRuns = out.results.filter(r => r.st.moved);
            // One gap record per placement and handler; it lists each distinct reason once.
            const why = new Set<string>();
            if (out.gap) why.add(out.gap);
            for (const r of movedRuns) if (!r.st.pos) why.add(r.st.posWhy ?? 'destination not resolved');
            if (why.size) gaps.push({ locName: p.locName, option, handler, src: p.src, gap: [...why].slice(0, 4).join(' | ') + (why.size > 4 ? ` | +${why.size - 4} more` : '') });
            // A run that assumes an obstacle timer is still running (`%x_used >= map_clock`) is the "being used" refusal.
            const busy = (r: RunResult) => r.assumptions.some(a => a.value === "T" && /^[^@]*(>=?) map_clock/.test(a.key));
            const done = movedRuns.filter(r => !busy(r) && r.st.pos && !(r.st.pos.c.x === p.x && r.st.pos.c.z === p.z && r.st.pos.c.level === p.level));
            const merged = new Map<string, ShortcutEdge>();
            const outcome = (r: RunResult) => JSON.stringify([r.st.pos, r.st.fee, r.st.consumes]);
            const isFail = (r: RunResult) => r.assumptions.some(rollFailed);
            const success = minimize(done.filter(r => !isFail(r)), outcome);
            const fails = done.filter(isFail);
            for (const r of success) {
                const b = mapAssumptions(r.assumptions);
                // The failure run that matches this run on every other assumption.
                const keys = new Map(r.assumptions.map(a => [a.key, a.value]));
                const fail = fails.find(f => f.assumptions.every(a => rollFailed(a) || !keys.has(a.key) || keys.get(a.key) === a.value));
                const fa = fail?.assumptions.find(rollFailed);
                const req = b.requires;
                const pos = r.st.pos!;
                const e: ShortcutEdge = {
                    kind: kindOf(trig.file, req, fa?.sym.meta?.stat),
                    locName: p.locName, id: p.id, option, optionText,
                    from: { x: p.x, z: p.z, level: p.level }, to: pos.c, exact: pos.exact,
                    ...(Object.keys(req).length ? { requires: req } : {}),
                    ...(r.st.fee ? { fee: r.st.fee } : {}),
                    ...(r.st.consumes.length ? { consumes: r.st.consumes } : {}),
                    ...(b.side.length ? { side: b.side } : {}),
                    ...(b.choices.length ? { choices: b.choices } : {}),
                    ...(b.conditions.length ? { conditions: b.conditions } : {}),
                    ...(fa && fail ? { failure: { stat: fa.sym.meta!.stat!, low: fa.sym.meta!.low!, high: fa.sym.meta!.high!, src: `${fa.file}:${fa.line}`, to: fail.st.pos?.c ?? null, exact: !!fail.st.pos?.exact, damage: fail.st.damage } } : {}),
                    ...(p.via ? { via: p.via } : {}),
                    twoWay: false,
                    src: p.src, toSrc: r.st.moveSrc!, handler,
                    ...(b.requireSrc.length ? { requireSrc: b.requireSrc } : {}),
                };
                // Runs with the same arrival and needs merge; a world condition is kept only when every merged run assumes it.
                const k = JSON.stringify([e.to, e.exact, e.requires, e.side, e.choices, e.fee, e.consumes]);
                const old = merged.get(k);
                if (!old) { merged.set(k, e); continue; }
                const common = (old.conditions ?? []).filter(c => e.conditions?.includes(c));
                if (common.length) old.conditions = common; else delete old.conditions;
                if (!old.failure && e.failure) old.failure = e.failure;
            }
            edges.push(...merged.values());
        }
    }
    const near = (a: Coord, b: Coord) => a.level === b.level && Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= 3;
    for (const e of edges) e.twoWay = edges.some(o => o !== e && near(o.from, e.to) && near(o.to, e.from));
    edges.sort((a, b) => a.kind.localeCompare(b.kind) || a.locName.localeCompare(b.locName) || a.from.x - b.from.x || a.from.z - b.from.z || a.from.level - b.from.level || a.to.x - b.to.x || a.to.z - b.to.z);
    return { edges, gaps, handlers: handlers.size };
}

// ---------- CLI ----------
export function loadInput(): BuildInput {
    const root = contentRoot();
    const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
    const locs: LocSpawn[] = [];
    for (const f of readdirSync(join(root, 'maps')).filter(f => f.endsWith('.jm2'))) locs.push(...parseJm2(f, read(`maps/${f}`)).locs);
    const kd = knowledgeDir();
    const json = <T>(f: string): T => JSON.parse(readFileSync(join(kd, f), 'utf8')) as T;
    const exclude = new Set<string>([
        ...json<{ locName: string }[]>('transports.json').map(t => t.locName),
        ...json<{ loc: string }[]>('doors.json').map(d => d.loc),
    ]);
    return {
        scriptFiles: listConfigFiles('.rs2').map(f => ({ text: read(f), file: f })),
        constantFiles: listConfigFiles('.constant').map(f => ({ text: read(f), file: f })),
        locConfigs: new Map(listConfigFiles('.loc').flatMap(f => parseConfigs(read(f), f)).map(b => [b.name, b])),
        locPack: parsePack(read('pack/loc.pack')),
        locs,
        questVarps: new Set(json<{ varp: string }[]>('quests.json').map(q => q.varp)),
        excludeLocNames: exclude,
        dbTables: buildDbTables(listConfigFiles('.dbtable').flatMap(f => parseConfigs(read(f), f)), listConfigFiles('.dbrow').flatMap(f => parseConfigs(read(f), f))),
    };
}

if (import.meta.main) {
    const out = buildShortcuts(loadInput());
    const counts: Record<string, number> = {};
    for (const e of out.edges) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    const file = join(knowledgeDir(), 'shortcuts.json');
    writeFileSync(file, JSON.stringify({
        note: 'Generated by packages/knowledge/src/shortcuts.ts. Player start is the loc tile until a script line sets it; exact=false marks player-relative arrival. map_members is taken as true. requires.varps/items/worn/useItem/coins are not checked by transportAllowed.',
        counts: { edges: out.edges.length, gaps: out.gaps.length, handlers: out.handlers, byKind: counts },
        edges: out.edges, gaps: out.gaps,
    }, null, 1) + '\n');
    console.log(`wrote ${file}${existsSync(file) ? '' : ' (missing)'}`);
    console.log(`edges ${out.edges.length}, gaps ${out.gaps.length}, handlers ${out.handlers}`);
    for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
}
