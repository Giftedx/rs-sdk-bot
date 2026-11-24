import type { ConfigBlock } from '../config';
import type { DbRow } from '../dbtables';
import { astOf, exprText, parseCoord, show } from './parser';
import {
    DAMAGE_PROCS, LOC_SHAPES, MAX_RUNS, MAX_STEPS, MOVE_CMDS, MOVE_PROCS, OP_NEG, QUEUE_CMDS,
    SKIP_VALUE_FILE, skipCall,
} from './tables';
import {
    Unsupported,
    type Assumption, type Coord, type Ctx, type Expr, type Placement, type RunResult,
    type RunState, type Script, type Stmt, type Sym, type V,
} from './types';

const LOC_PARAM_CACHE = new WeakMap<ConfigBlock, Map<string, string>>();
function locParamMap(cfg: ConfigBlock): Map<string, string> {
    let map = LOC_PARAM_CACHE.get(cfg);
    if (!map) {
        map = new Map();
        for (const r of cfg.props.param ?? []) {
            const comma = r.indexOf(',');
            const key = (comma >= 0 ? r.slice(0, comma) : r).trim();
            if (!map.has(key)) map.set(key, comma >= 0 ? r.slice(comma + 1).trim() : '');
        }
        LOC_PARAM_CACHE.set(cfg, map);
    }
    return map;
}

const DB_ROW_INDEX = new WeakMap<Ctx, Map<string, Map<string, DbRow>>>();
function dbRowLookup(ctx: Ctx, table: string, rowName: string): DbRow | undefined {
    let byTable = DB_ROW_INDEX.get(ctx);
    if (!byTable) {
        byTable = new Map();
        DB_ROW_INDEX.set(ctx, byTable);
    }
    let rows = byTable.get(table);
    if (!rows) {
        rows = new Map();
        for (const row of ctx.db.get(table) ?? []) {
            if (!rows.has(row.name)) rows.set(row.name, row);
        }
        byTable.set(table, rows);
    }
    return rows.get(rowName);
}

const CONST_CACHE = new WeakMap<Ctx, Map<string, V>>();
function constCacheFor(ctx: Ctx): Map<string, V> {
    let map = CONST_CACHE.get(ctx);
    if (!map) {
        map = new Map();
        CONST_CACHE.set(ctx, map);
    }
    return map;
}

// An int derived from the approximate player tile stays approximate.
const approxOf = (...vs: V[]): { approx?: true } => vs.some(v => v.t === 'int' && v.approx) ? { approx: true } : {};

// A proc whose value the interpreter computes: it returns a value and calls no proc, label, dialogue or player command.
const straight = new Map<Script, boolean>();
const valueProc = (s: Script) => {
    let v = straight.get(s);
    if (v === undefined) {
        const t = s.body.map(b => b.text).join('\n');
        v = !SKIP_VALUE_FILE.test(s.file) && /\breturn\s*\(/.test(t) && !/\bwhile\s*\(|~\w+|@\w+|\b(p_\w+|mes|if_\w+)\s*\(/.test(t);
        straight.set(s, v);
    }
    return v;
};

// Internal control-flow signals: plain objects avoid capturing JS stack traces on every branch fork/return.
class Fork { constructor(public key: string, public options: string[], public sym: Sym, public details: string[], public line: number, public file: string) {} }
class EndPath {}
const END_PATH = new EndPath();
class ProcReturn { constructor(public value?: V) {} }

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
        const cache = depth === 0 ? constCacheFor(this.ctx) : undefined;
        if (cache) {
            const cached = cache.get(n);
            if (cached) return cached;
        }
        const c = this.ctx.constants.get(n);
        if (!c || depth > 5) return { t: 'unk', why: `^${n} undefined` };
        const s = c.value;
        let out: V;
        if (/^-?\d+$/.test(s)) out = { t: 'int', v: Number(s) };
        else if (/^\d+_\d+_\d+_\d+_\d+$/.test(s)) out = { t: 'coord', c: parseCoord(s), exact: true };
        else if (s === 'true' || s === 'false') out = { t: 'bool', v: s === 'true' };
        else if (s.startsWith('"')) out = { t: 'str' };
        else if (s.startsWith('^')) out = this.constant(s.slice(1), depth + 1);
        else out = { t: 'name', v: s };
        cache?.set(n, out);
        return out;
    }
    locParam(name: string): V {
        const cfg = this.ctx.locConfigs.get(this.p.locName);
        const val = cfg ? locParamMap(cfg).get(name) : undefined;
        if (val === undefined) return { t: 'unk', why: `loc_param(${name}) not set on ${this.p.locName}` };
        if (/^-?\d+$/.test(val)) return { t: 'int', v: Number(val) };
        if (/^\d+_\d+_\d+_\d+_\d+$/.test(val)) return { t: 'coord', c: parseCoord(val), exact: true };
        if (val.startsWith('^')) return this.constant(val.slice(1));
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
                const row = r.t === 'name' && r.v.startsWith('dbrow:') ? dbRowLookup(this.ctx, table!, r.v.slice(6)) : undefined;
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
                if (skipCall(label)) throw END_PATH;
                this.enter(label, s.args.map(a => this.eval(a)), true);
                throw END_PATH;
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
                    if (ls.some(l => l !== 'default' && this.compare('=', v, l, '').t === 'bool' && (this.compare('=', v, l, '') as { v: boolean }).v)) { this.execList(c.body); return; }
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
            if (idx !== undefined) { if (!e.args[idx]) throw new Unsupported(`${e.n} without destination at ${this.src(line)}`); this.moveTo(this.eval(e.args[idx]!), line, e.n === 'p_walk'); return; }
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
            if (err instanceof ProcReturn) throw END_PATH;
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

export function runAll(ctx: Ctx, s: Script, p: Placement): { results: RunResult[]; gap?: string } {
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
            if (err instanceof Fork) {
                for (const o of err.options) {
                    const next = new Map(assume);
                    next.set(err.key, o);
                    work.push(next);
                }
                continue;
            }
            if (err instanceof Unsupported) return { results, gap: err.message };
            return { results, gap: `interpreter error: ${(err as Error).message}` };
        }
    }
    return { results };
}
