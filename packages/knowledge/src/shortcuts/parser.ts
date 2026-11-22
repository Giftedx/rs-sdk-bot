import { EXPR_PREC } from './tables';
import { Unsupported, type Coord, type Ctx, type Expr, type Line, type Script, type Stmt, type Tok, type V } from './types';

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
    bin(min: number): Expr {
        let a = this.unary();
        for (;;) {
            const p = this.peek(); if (!p || p.k !== 'sym') return a;
            const prec = EXPR_PREC[p.v]; if (prec === undefined || prec < min) return a;
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

export const show = (v: V): string => v.t === 'int' ? String(v.v) : v.t === 'bool' ? String(v.v) : v.t === 'name' ? v.v : v.t === 'coord' ? `${v.c.level}_${v.c.x >> 6}_${v.c.z >> 6}_${v.c.x & 63}_${v.c.z & 63}${v.exact ? '' : '~'}` : v.t === 'sym' ? v.text : v.t === 'cond' ? v.text : v.t === 'str' ? '"..."' : v.t === 'tuple' ? `(${v.vs.map(show).join(', ')})` : `?(${v.why})`;

export const exprText = (e: Expr): string => {
    switch (e.k) {
        case 'num': return String(e.v); case 'coord': return e.v; case 'str': return '"..."';
        case 'var': return '$' + e.n; case 'varp': return '%' + e.n; case 'const': return '^' + e.n; case 'id': return e.n;
        case 'call': return `${e.proc ? '~' : ''}${e.n}(${e.args.map(exprText).join(', ')})`;
        case 'bin': return `${exprText(e.a)} ${e.op} ${exprText(e.b)}`;
        case 'neg': return '-' + exprText(e.a);
    }
};

export function astOf(ctx: Ctx, s: Script): Stmt[] {
    const k = `${s.type},${s.name}`;
    let a = ctx.ast.get(k);
    if (!a) { a = new Parser(tokenize(s.body)).program(); ctx.ast.set(k, a); }
    return a;
}
