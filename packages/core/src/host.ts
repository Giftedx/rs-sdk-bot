// Bot host: runs N bot scripts in ONE bun process, so the bots share one pathfinder (rsmod wasm memory and the
// collision data), one world graph, one webclient config cache and one loc index. A bot in its own process pays
// all of that again (research/bot-host.md).
//
// Usage (local practice server, same as a script run):
//   bun packages/core/src/host.ts <script> <bot1> [bot2 ...] [--stagger-ms N] [--mem-every-s N]
//       [--arg <value>]... [--args a,b] [--env <bot> KEY=value]...
// Each bot runs <script> as if started with `bun <script> <bot> <args>`. `--env` adds one variable to one bot's
// environment (repeat it per variable); every bot also sees the host's own environment. Output lines go to stdout
// as `[bot] line` and, without the prefix, to .practice/logs/host-<bot>.log. The host exits when every script has
// finished, with 0 when every script finished ok.
// When <script> is scripts/chain.ts, each `--arg` is a chain step ("scripts/x.ts arg KEY=value", see chain.ts) and
// every bot runs the steps in order inside this process: each step logs in and out like a chain child, ROUNDS in
// the bot's environment repeats the list, and the bot's last RESULT line is the chain's (`RESULT ok chain ...`).
//
// Scripts run unchanged. When the host loads a script it rewrites the source of that one file:
//   import.meta.main                         -> true (parser define on this entry only, never its helpers)
//   process.argv / process.env / process.exit  -> per-bot values (argv[2] is the bot name; env is a copy)
//   console.log / error / warn / info          -> per-bot log
//   the import of packages/core/src/bot        -> a per-bot copy of the module that re-exports bot.ts unchanged,
//                                                  except openBot (per-bot START log) and finish (no process.exit)
// Limits: only the script file itself is rewritten. A helper module that calls finish() or reads process.argv[2]
// for the bot name sees the host values, not the bot's. Scripts that call process.exit() directly stop there (the
// rest of that script does not run), as in a real exit.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { bindHostedScope, currentHostedScope, openBot, settle } from './bot';
import { parseStep, runChainSteps, type Step } from './chain-step';
import type { Session } from './inprocess';
import { hasStopFile } from './practice-paths';
import { noteStatusLine } from './status';
import { shareLocIndex } from './loc-index-share';
import { workerExecution } from './worker-execution';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const BOT_MODULE = resolve(import.meta.dir, 'bot.ts').replace(/\\/g, '/');
const SCRIPT_Q = 'hostscript';
const SCRIPT_FN_Q = 'hostfn';
const BOT_Q = 'hostbot';
const BOT_CURRENT = '__current__';
const BASE_ENV: Record<string, string | undefined> = process.env;

export interface HostedBot {
    name: string;
    script: string;
    args?: string[];
    env?: Record<string, string>;
    // Scripts in a row, as scripts/chain.ts runs them: each step logs in and out; env.ROUNDS repeats the list
    // (0: until a stop file or a round with no ok step). With steps, `script` and `args` are not run.
    steps?: Step[];
}

// The chain script path names the host's chain mode: its arguments are step texts, not script arguments.
export const isChainScript = (script: string): boolean => /(^|[\\/])scripts[\\/]chain\.ts$/.test(script);

export interface HostedResult {
    name: string;
    ok: boolean;
    code: number;
    result: string;
}

class HostExit extends Error {
    constructor(readonly code: number) { super(`host exit ${code}`); }
}

const escapeSingleQuoted = (value: string): string =>
    value
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');

type JsTokenKind = 'id' | 'str' | 'num' | 'punct' | 'tpl_head' | 'tpl_mid' | 'tpl_tail' | 'tpl_full' | 'regex';
interface JsToken {
    kind: JsTokenKind;
    start: number;
    end: number;
    text: string;
    depth: number;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'case', 'throw', 'delete', 'void', 'typeof', 'in', 'instanceof', 'of',
    'new', 'yield', 'await', 'else', 'do', 'export', 'default',
]);
const COND_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const PROCESS_HOST_PROPS = new Set(['argv', 'env', 'exit']);
const CONSOLE_HOST_PROPS = new Set(['log', 'error', 'warn', 'info']);

const isIdStart = (c: number) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c >= 128;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

function decodeStringLiteral(raw: string): string {
    const quote = raw[0];
    if (quote === '"' && !raw.includes('\n') && !raw.includes('\r')) {
        try { return JSON.parse(raw) as string; } catch { /* fall through */ }
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
        const ch = raw[i]!;
        if (ch !== '\\') { out += ch; continue; }
        const next = raw[++i];
        if (next === undefined) break;
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next === 'b') out += '\b';
        else if (next === 'f') out += '\f';
        else if (next === 'v') out += '\v';
        else if (next === '0') out += '\0';
        else if (next === '\r') { if (raw[i + 1] === '\n') i++; }
        else if (next === '\n' || next === '\u2028' || next === '\u2029') { /* line continuation */ }
        else if (next === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1, i + 3))) {
            out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
            i += 2;
        } else if (next === 'u') {
            if (raw[i + 1] === '{') {
                const close = raw.indexOf('}', i + 2);
                if (close > i + 2) {
                    const cp = parseInt(raw.slice(i + 2, close), 16);
                    if (Number.isFinite(cp)) out += String.fromCodePoint(cp);
                    i = close;
                }
            } else if (/^[0-9a-fA-F]{4}/.test(raw.slice(i + 1, i + 5))) {
                out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
                i += 4;
            }
        } else {
            out += next;
        }
    }
    return out;
}

// Lightweight JS/TS tokenizer for host rewriting and ESM entry splitting: avoids loading the ~80 MB TypeScript compiler.
function scanJs(src: string): JsToken[] {
    const tokens: JsToken[] = [];
    const len = src.length;
    let i = 0;
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    const tplStack: number[] = [];
    const parenCondStack: boolean[] = [];
    let lastClosedWasCondParen = false;

    const depth = () => braceDepth + parenDepth + bracketDepth;

    const scanTemplate = (isContinuation: boolean) => {
        const start = i;
        i++; // skip opening ` or closing }
        while (i < len) {
            const ch = src[i]!;
            if (ch === '\\') { i += 2; continue; }
            if (ch === '`') {
                i++;
                tokens.push({ kind: isContinuation ? 'tpl_tail' : 'tpl_full', start, end: i, text: src.slice(start, i), depth: depth() });
                return;
            }
            if (ch === '$' && src[i + 1] === '{') {
                i += 2;
                tokens.push({ kind: isContinuation ? 'tpl_mid' : 'tpl_head', start, end: i, text: src.slice(start, i), depth: depth() });
                tplStack.push(braceDepth);
                braceDepth++;
                return;
            }
            i++;
        }
        tokens.push({ kind: isContinuation ? 'tpl_tail' : 'tpl_full', start, end: i, text: src.slice(start, i), depth: depth() });
    };

    const prevCanEndExpr = (): boolean => {
        const prev = tokens[tokens.length - 1];
        if (!prev) return false;
        if (prev.kind === 'num' || prev.kind === 'str' || prev.kind === 'tpl_full' || prev.kind === 'tpl_tail' || prev.kind === 'regex') return true;
        if (prev.kind === 'id') {
            const prev2 = tokens[tokens.length - 2];
            if (prev2 && (prev2.text === '.' || prev2.text === '?.')) return true;
            return !REGEX_PRECEDING_KEYWORDS.has(prev.text);
        }
        if (prev.text === ']' || prev.text === '++' || prev.text === '--') return true;
        if (prev.text === ')') return !lastClosedWasCondParen;
        return false;
    };

    if (src.startsWith('#!')) {
        const nl = src.indexOf('\n');
        i = nl < 0 ? len : nl + 1;
    }

    while (i < len) {
        const c = src.charCodeAt(i);
        // Whitespace
        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 || c === 0xfeff) { i++; continue; }
        // Line comment
        if (c === 47 && src.charCodeAt(i + 1) === 47) {
            i += 2;
            while (i < len && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i++;
            continue;
        }
        // Block comment
        if (c === 47 && src.charCodeAt(i + 1) === 42) {
            i += 2;
            while (i + 1 < len && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
            i = Math.min(len, i + 2);
            continue;
        }
        // String literal
        if (c === 39 || c === 34) {
            const start = i;
            i++;
            while (i < len) {
                const sc = src.charCodeAt(i);
                if (sc === 92) { i += 2; continue; }
                if (sc === c) { i++; break; }
                i++;
            }
            tokens.push({ kind: 'str', start, end: i, text: src.slice(start, i), depth: depth() });
            continue;
        }
        // Template literal
        if (c === 96) {
            scanTemplate(false);
            continue;
        }
        // Regex literal vs / operator
        if (c === 47) {
            const start = i;
            if (!prevCanEndExpr()) {
                i++;
                let inClass = false;
                while (i < len) {
                    const rc = src.charCodeAt(i);
                    if (rc === 92) { i += 2; continue; }
                    if (rc === 10 || rc === 13) break;
                    if (rc === 91) { inClass = true; i++; continue; }
                    if (rc === 93) { inClass = false; i++; continue; }
                    if (rc === 47 && !inClass) { i++; break; }
                    i++;
                }
                while (i < len && isIdPart(src.charCodeAt(i))) i++;
                tokens.push({ kind: 'regex', start, end: i, text: src.slice(start, i), depth: depth() });
                continue;
            }
            i += src.charCodeAt(i + 1) === 61 ? 2 : 1;
            tokens.push({ kind: 'punct', start, end: i, text: src.slice(start, i), depth: depth() });
            continue;
        }
        // Number literal
        if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
            const start = i;
            if (c === 48 && (src[i + 1] === 'x' || src[i + 1] === 'X' || src[i + 1] === 'b' || src[i + 1] === 'B' || src[i + 1] === 'o' || src[i + 1] === 'O')) {
                i += 2;
                while (i < len && /[0-9a-fA-F_]/.test(src[i]!)) i++;
            } else {
                while (i < len && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) i++;
                if (src.charCodeAt(i) === 46 && src.charCodeAt(i + 1) !== 46) {
                    i++;
                    while (i < len && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) i++;
                }
                if (src[i] === 'e' || src[i] === 'E') {
                    i++;
                    if (src[i] === '+' || src[i] === '-') i++;
                    while (i < len && (isDigit(src.charCodeAt(i)) || src.charCodeAt(i) === 95)) i++;
                }
            }
            if (src[i] === 'n') i++;
            tokens.push({ kind: 'num', start, end: i, text: src.slice(start, i), depth: depth() });
            continue;
        }
        // Identifier / keyword
        if (isIdStart(c)) {
            const start = i;
            i++;
            while (i < len && isIdPart(src.charCodeAt(i))) i++;
            tokens.push({ kind: 'id', start, end: i, text: src.slice(start, i), depth: depth() });
            continue;
        }
        // Braces / template continuation
        if (c === 123) { // {
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: '{', depth: depth() });
            braceDepth++;
            i++;
            continue;
        }
        if (c === 125) { // }
            braceDepth = Math.max(0, braceDepth - 1);
            if (tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth) {
                tplStack.pop();
                scanTemplate(true);
                continue;
            }
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: '}', depth: depth() });
            i++;
            continue;
        }
        if (c === 40) { // (
            const prev = tokens[tokens.length - 1];
            const prev2 = tokens[tokens.length - 2];
            const isCond = !!prev && prev.kind === 'id' && COND_KEYWORDS.has(prev.text) && prev2?.text !== '.' && prev2?.text !== '?.';
            parenCondStack.push(isCond);
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: '(', depth: depth() });
            parenDepth++;
            i++;
            continue;
        }
        if (c === 41) { // )
            parenDepth = Math.max(0, parenDepth - 1);
            lastClosedWasCondParen = parenCondStack.pop() ?? false;
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: ')', depth: depth() });
            i++;
            continue;
        }
        if (c === 91) { // [
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: '[', depth: depth() });
            bracketDepth++;
            i++;
            continue;
        }
        if (c === 93) { // ]
            bracketDepth = Math.max(0, bracketDepth - 1);
            tokens.push({ kind: 'punct', start: i, end: i + 1, text: ']', depth: depth() });
            i++;
            continue;
        }
        // Multi-char punctuators relevant to rewriting/regex disambiguation
        const start = i;
        const two = src.slice(i, i + 2);
        if (two === '?.' && !isDigit(src.charCodeAt(i + 2))) {
            i += 2;
            tokens.push({ kind: 'punct', start, end: i, text: '?.', depth: depth() });
            continue;
        }
        if (two === '++' || two === '--' || two === '=>') {
            i += 2;
            tokens.push({ kind: 'punct', start, end: i, text: two, depth: depth() });
            continue;
        }
        if (src.slice(i, i + 3) === '...') {
            i += 3;
            tokens.push({ kind: 'punct', start, end: i, text: '...', depth: depth() });
            continue;
        }
        i++;
        tokens.push({ kind: 'punct', start, end: i, text: src.slice(start, i), depth: depth() });
    }
    return tokens;
}

// Rewrites one script's source for the host. Pure, so the unit test checks it without a server.
// scriptDir resolves relative specifiers: one that names botModule (with or without .ts) is redirected.
export function rewriteScript(src: string, id: string, scriptDir: string, botModule: string = BOT_MODULE): string {
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\.ts$/, '').toLowerCase();
    const target = norm(botModule);
    const tokens = scanJs(src);
    const edits: { start: number; end: number; value: string }[] = [];

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        const prev = tokens[i - 1];
        if (tok.kind === 'id' && (tok.text === 'process' || tok.text === 'console') && prev?.text !== '.' && prev?.text !== '?.') {
            const next = tokens[i + 1];
            let prop: string | null = null;
            let end = -1;
            if (next?.text === '.' && tokens[i + 2]?.kind === 'id') {
                prop = tokens[i + 2]!.text;
                end = tokens[i + 2]!.end;
            } else if (next?.text === '[' && tokens[i + 2]?.kind === 'str' && tokens[i + 3]?.text === ']') {
                prop = decodeStringLiteral(tokens[i + 2]!.text);
                end = tokens[i + 3]!.end;
            }
            if (prop !== null) {
                const replacement = tok.text === 'process' && PROCESS_HOST_PROPS.has(prop) ? `__host.${prop}`
                    : tok.text === 'console' && CONSOLE_HOST_PROPS.has(prop) ? `__host.console.${prop}` : null;
                if (replacement) edits.push({ start: tok.start, end, value: replacement });
            }
        } else if (tok.kind === 'str') {
            const prev2 = tokens[i - 2];
            const prev3 = tokens[i - 3];
            const isStaticMod = prev?.kind === 'id' && (prev.text === 'from' || prev.text === 'import') && prev2?.text !== '.' && prev2?.text !== '?.';
            const isDynamicMod = prev?.text === '(' && prev2?.kind === 'id' && prev2.text === 'import' && prev3?.text !== '.' && prev3?.text !== '?.';
            if (isStaticMod || isDynamicMod) {
                const spec = decodeStringLiteral(tok.text);
                if (/^\.{1,2}\//.test(spec) && norm(resolve(scriptDir, spec)) === target) {
                    const path = escapeSingleQuoted(`${botModule}?${BOT_Q}=${id}`);
                    edits.push({ start: tok.start, end: tok.end, value: `'${path}'` });
                }
            }
        }
    }

    let out = src;
    for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
    // Import declarations are hoisted, so this line runs before the script body wherever it stands.
    return `const __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});\n${out}`;
}

const entryTranspiler = new Bun.Transpiler({ loader: 'ts', target: 'bun', define: { 'import.meta.main': 'true' } });
const hostedEntryCache = new Map<string, (id: string) => string>();
const SCRIPT_LOAD_FILTER = new RegExp(`[?&]${SCRIPT_Q}=`);
const SCRIPT_FN_LOAD_FILTER = new RegExp(`[?&]${SCRIPT_FN_Q}=1(?:&|$)`);
const BOT_LOAD_FILTER = new RegExp(`[?&]${BOT_Q}=`);

function skipImportAttributes(tokens: JsToken[], idx: number): number {
    if ((tokens[idx]?.text === 'with' || tokens[idx]?.text === 'assert') && tokens[idx + 1]?.text === '{') {
        let j = idx + 2;
        while (j < tokens.length && !(tokens[j]!.text === '}' && tokens[j]!.depth === 0)) j++;
        return j < tokens.length ? j + 1 : j;
    }
    return idx;
}

function findMatchingBrace(tokens: JsToken[], openIdx: number): number {
    const targetDepth = tokens[openIdx]!.depth;
    for (let j = openIdx + 1; j < tokens.length; j++) {
        if (tokens[j]!.text === '}' && tokens[j]!.depth === targetDepth) return j;
    }
    return tokens.length - 1;
}

function splitHostedEsmBody(body: string): { imports: string[]; statements: string } {
    const tokens = scanJs(body);
    const imports: string[] = [];
    const edits: { start: number; end: number; value: string }[] = [];

    const isStatementStart = (i: number): boolean => {
        if (i === 0) return true;
        const prev = tokens[i - 1]!;
        if (prev.depth !== 0) return false;
        if (prev.text === ';' || prev.text === '}') return true;
        return body.slice(prev.end, tokens[i]!.start).includes('\n');
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i]!;
        if (tok.depth !== 0 || tok.kind !== 'id' || !isStatementStart(i)) continue;

        if (tok.text === 'import') {
            const next = tokens[i + 1];
            if (!next || next.text === '(' || next.text === '.') continue;
            let j = i + 1;
            while (j < tokens.length && !(tokens[j]!.kind === 'str' && tokens[j]!.depth === 0)) j++;
            if (j >= tokens.length) continue;
            j = skipImportAttributes(tokens, j + 1);
            if (tokens[j]?.text === ';') j++;
            const end = tokens[j - 1]!.end;
            imports.push(body.slice(tok.start, end));
            edits.push({ start: tok.start, end, value: '' });
            i = j - 1;
            continue;
        }

        if (tok.text === 'export') {
            const next = tokens[i + 1];
            if (!next) continue;
            if (next.text === '*') {
                let j = i + 2;
                while (j < tokens.length && !(tokens[j]!.kind === 'str' && tokens[j]!.depth === 0)) j++;
                if (j >= tokens.length) continue;
                j = skipImportAttributes(tokens, j + 1);
                if (tokens[j]?.text === ';') j++;
                const end = tokens[j - 1]!.end;
                imports.push(body.slice(tok.start, end));
                edits.push({ start: tok.start, end, value: '' });
                i = j - 1;
                continue;
            }
            if (next.text === '{') {
                const closeIdx = findMatchingBrace(tokens, i + 1);
                let j = closeIdx + 1;
                if (tokens[j]?.kind === 'id' && tokens[j]!.text === 'from' && tokens[j + 1]?.kind === 'str') {
                    j = skipImportAttributes(tokens, j + 2);
                    if (tokens[j]?.text === ';') j++;
                    const end = tokens[j - 1]!.end;
                    imports.push(body.slice(tok.start, end));
                    edits.push({ start: tok.start, end, value: '' });
                } else {
                    if (tokens[j]?.text === ';') j++;
                    const end = tokens[j - 1]!.end;
                    edits.push({ start: tok.start, end, value: '' });
                }
                i = j - 1;
                continue;
            }
            if (next.text === 'default') {
                const d = i + 2;
                const dTok = tokens[d];
                if (!dTok) continue;
                const isAsyncFn = dTok.text === 'async' && tokens[d + 1]?.text === 'function';
                const isFn = dTok.text === 'function' || isAsyncFn;
                const isClass = dTok.text === 'class';
                if (isFn || isClass) {
                    let nameIdx = isAsyncFn ? d + 2 : d + 1;
                    if (isFn && tokens[nameIdx]?.text === '*') nameIdx++;
                    const named = tokens[nameIdx]?.kind === 'id' && !(isClass && tokens[nameIdx]!.text === 'extends');
                    if (named) {
                        edits.push({ start: tok.start, end: dTok.start, value: '' });
                        i = d - 1;
                    } else {
                        let openIdx = nameIdx;
                        while (openIdx < tokens.length && !(tokens[openIdx]!.text === '{' && tokens[openIdx]!.depth === 0)) openIdx++;
                        if (openIdx < tokens.length) {
                            const closeIdx = findMatchingBrace(tokens, openIdx);
                            const endPos = tokens[closeIdx]!.end;
                            edits.push({ start: tok.start, end: dTok.start, value: 'void (' });
                            edits.push({ start: endPos, end: endPos, value: ');' });
                            i = closeIdx;
                        }
                    }
                    continue;
                }
                // export default <expression>;
                let j = d;
                while (j < tokens.length) {
                    const t = tokens[j]!;
                    if (t.depth === 0 && t.text === ';') break;
                    if (j > d && t.depth === 0 && tokens[j - 1]!.depth === 0 && body.slice(tokens[j - 1]!.end, t.start).includes('\n')) {
                        if (t.kind === 'id' && (t.text === 'import' || t.text === 'export' || t.text === 'const' || t.text === 'let' || t.text === 'var' || t.text === 'function' || t.text === 'class' || t.text === 'if' || t.text === 'for' || t.text === 'while')) break;
                    }
                    j++;
                }
                edits.push({ start: tok.start, end: dTok.start, value: 'void (' });
                if (j < tokens.length && tokens[j]!.text === ';') {
                    edits.push({ start: tokens[j]!.start, end: tokens[j]!.end, value: ');' });
                    i = j;
                } else {
                    const endPos = tokens[Math.max(d, j - 1)]!.end;
                    edits.push({ start: endPos, end: endPos, value: ');' });
                    i = j - 1;
                }
                continue;
            }
            // export const/let/var/function/async/class
            edits.push({ start: tok.start, end: next.start, value: '' });
        }
    }

    let statements = body;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        statements = statements.slice(0, edit.start) + edit.value + statements.slice(edit.end);
    }
    return { imports, statements };
}

function compileHostedTemplate(src: string, scriptDir: string): (id: string) => string {
    const entry = entryTranspiler.transformSync(src);
    let marker = '__RS_HOST_BOT_ID__';
    while (entry.includes(marker) || scriptDir.includes(marker) || BOT_MODULE.includes(marker)) marker += '_X';
    const rewritten = rewriteScript(entry, marker, scriptDir);
    const split = rewritten.indexOf('\n');
    const body = rewritten.slice(split + 1);
    // Bun module evaluation does not inherit the import caller's async scope.
    // Keep static imports at module level and start the worker body in its own
    // scope. Entry exports are private to this hosted query, never helper imports.
    const { imports, statements } = splitHostedEsmBody(body);
    const importParts = imports.join('\n').split(marker);
    const stmtParts = statements.split(marker);
    return (id: string) => {
        const escapedId = escapeSingleQuoted(id);
        const imps = importParts.length === 1 ? importParts[0]! : importParts.join(escapedId);
        const stmts = stmtParts.length === 1 ? stmtParts[0]! : stmtParts.join(escapedId);
        return `${imps}\nconst __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});\nawait __host.execution.run(async () => {\n${stmts}\n});`;
    };
}

// Only the ?hostscript entry is passed here. A parser define avoids changing the
// same text inside a string/comment or making an imported helper a main module.
export function hostedEntrySource(src: string, id: string, scriptDir: string): string {
    const key = `${scriptDir}\0${src}`;
    let render = hostedEntryCache.get(key);
    if (!render) {
        if (hostedEntryCache.size >= 128) hostedEntryCache.clear();
        render = compileHostedTemplate(src, scriptDir);
        hostedEntryCache.set(key, render);
    }
    return render(id);
}

// Reusable hosted module entry: compiled and cached once per script file, avoiding per-launch ESM module retention.
export function hostedCallableSource(src: string, scriptDir: string): string {
    const entry = entryTranspiler.transformSync(src);
    const rewritten = rewriteScript(entry, BOT_CURRENT, scriptDir);
    const split = rewritten.indexOf('\n');
    const body = rewritten.slice(split + 1);
    const { imports, statements } = splitHostedEsmBody(body);
    return `${imports.join('\n')}\nexport async function __runHost(__host) {\nreturn await __host.execution.run(async () => {\n${statements}\n});\n}`;
}

type OpenOptions = NonNullable<Parameters<typeof openBot>[1]>;
export function hostedOpenOptions(log: (line: string) => void, defaultStop: NonNullable<OpenOptions['onStop']>, opts: OpenOptions = {}): OpenOptions {
    // A custom callback cancels work/banks products before the worker calls its
    // own finish. Only scripts without that policy use the host's final stop.
    // The log is never undefined here: openBot (bot/open.ts) sends a call without a log back to the hosted bot.
    return { ...opts, log: opts.log ?? log, onStop: opts.onStop ?? defaultStop, onSessionEnd: opts.onSessionEnd ?? defaultStop };
}

// The per-bot copy of bot.ts: everything from the shared module, with openBot and finish bound to one bot.
// When id is BOT_CURRENT, resolves the active hosted bot via executionContext so one wrapper serves all pooled runs.
export function botWrapper(id: string, botModule: string = BOT_MODULE): string {
    if (id === BOT_CURRENT) {
        return `export * from '${botModule}';
import { openBot as __baseOpenBot, finish as __baseFinish } from '${botModule}';
export const openBot = (name, opts) => { const h = globalThis.__rsBotHostCurrent?.(); return h ? h.openBot(name, opts) : __baseOpenBot(name, opts); };
export const finish = (sessions, ok, detail) => { const h = globalThis.__rsBotHostCurrent?.(); return h ? h.finish(sessions, ok, detail) : __baseFinish(sessions, ok, detail); };
`;
    }
    return `export * from '${botModule}';
const __host = globalThis.__rsBotHost.get(${JSON.stringify(id)});
export const openBot = (name, opts) => __host.openBot(name, opts);
export const finish = (sessions, ok, detail) => __host.finish(sessions, ok, detail);
`;
}

const fmt = (args: unknown[]) => args.map(a => (typeof a === 'string' ? a : inspect(a, { depth: 4 }))).join(' ');

interface Instance {
    id: string;
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    console: Record<'log' | 'error' | 'warn' | 'info', (...a: unknown[]) => void>;
    log(line: string): void;
    exit(code?: number): never;
    openBot(name: string, opts?: OpenOptions): Promise<Session>;
    finish(sessions: Session[], ok: boolean, detail: Parameters<typeof settle>[2]): Promise<never>;
    sessions: Session[];
    result: string;
    done: Promise<number>;
    execution: ReturnType<typeof workerExecution>;
    openings: Set<Promise<Session>>;
}

let installed = false;
let envProxyInstalled = false;
const registry = new Map<string, Instance>();
const instByLog = new WeakMap<(...args: any[]) => unknown, Instance>();

function currentHostInstance(): Instance | undefined {
    const log = executionContext.getStore()?.log;
    return log ? instByLog.get(log) : undefined;
}

export function baseProcessEnv(): Record<string, string | undefined> {
    return BASE_ENV;
}

// Transparent per-bot process.env isolation via executionContext AsyncLocalStorage.
// Reads, spreads, keys and mutations inside a hosted bot touch only that bot's env overlay.
function installEnvProxy(): void {
    if (envProxyInstalled) return;
    envProxyInstalled = true;
    const proxy = new Proxy(BASE_ENV, {
        get(target, prop, receiver) {
            if (typeof prop === 'string') {
                const inst = currentHostInstance();
                if (inst) return inst.env[prop];
            }
            return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
            if (typeof prop === 'string') {
                const inst = currentHostInstance();
                if (inst) return prop in inst.env;
            }
            return Reflect.has(target, prop);
        },
        ownKeys(target) {
            const inst = currentHostInstance();
            return inst ? Reflect.ownKeys(inst.env) : Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, prop) {
            if (typeof prop === 'string') {
                const inst = currentHostInstance();
                if (inst) return Object.getOwnPropertyDescriptor(inst.env, prop);
            }
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        set(target, prop, value, receiver) {
            if (typeof prop === 'string') {
                const inst = currentHostInstance();
                if (inst) { inst.env[prop] = value === undefined ? undefined : String(value); return true; }
            }
            return Reflect.set(target, prop, value, receiver);
        },
        deleteProperty(target, prop) {
            if (typeof prop === 'string') {
                const inst = currentHostInstance();
                if (inst) { delete inst.env[prop]; return true; }
            }
            return Reflect.deleteProperty(target, prop);
        },
    });
    Object.defineProperty(process, 'env', { value: proxy, configurable: true, writable: true });
}

function install(out: (line: string) => void, guard: boolean): void {
    if (installed) return;
    installed = true;
    installEnvProxy();
    (globalThis as any).__rsBotHost = registry;
    (globalThis as any).__rsBotHostCurrent = currentHostInstance;
    Bun.plugin({
        name: 'rs-bot-host',
        setup(build) {
            build.onLoad({ filter: SCRIPT_FN_LOAD_FILTER }, args => {
                const [file] = args.path.split('?') as [string, string];
                return { contents: hostedCallableSource(readFileSync(file, 'utf8'), dirname(file)), loader: 'js' };
            });
            build.onLoad({ filter: SCRIPT_LOAD_FILTER }, args => {
                const [file, query] = args.path.split('?') as [string, string];
                const id = new URLSearchParams(query).get(SCRIPT_Q)!;
                return { contents: hostedEntrySource(readFileSync(file, 'utf8'), id, dirname(file)), loader: 'js' };
            });
            build.onLoad({ filter: BOT_LOAD_FILTER }, args => {
                const id = new URLSearchParams(args.path.split('?')[1]).get(BOT_Q)!;
                return { contents: botWrapper(id), loader: 'js' };
            });
        },
    });
    // Code the host does not rewrite (helper modules) prints and exits through the hosted bot that runs it, so its
    // RESULT and LEDGER lines carry the `[bot]` prefix and its exit ends that bot, not the host (bot/host-scope.ts).
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
        const original = console[level].bind(console);
        console[level] = (...a: unknown[]) => { const hosted = currentHostedScope(); if (hosted) hosted.log(fmt(a)); else original(...a); };
    }
    const exit = process.exit.bind(process);
    process.exit = ((code?: number) => { const hosted = currentHostedScope(); return hosted ? hosted.exit(code) : exit(code); }) as typeof process.exit;
    // One bot's stray error must not end the other bots' sessions.
    if (guard) process.on('unhandledRejection', e => { if (!(e instanceof HostExit)) out(`[host] unhandled rejection: ${fmt([e])}`); });
    if (guard) process.on('uncaughtException', e => { if (!(e instanceof HostExit)) out(`[host] uncaught exception: ${fmt([e])}`); });
}

export function memLine(tag = ''): string {
    const m = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 2 ** 20);
    return `MEM${tag ? ' ' + tag : ''} rss=${mb(m.rss)} heapUsed=${mb(m.heapUsed)} external=${mb(m.external)} arrayBuffers=${mb(m.arrayBuffers)}`;
}

type Sink = (line: string) => void;

// One bot's output sink: the dashboard status line, optional log file and host stdout line.
function botSink(name: string, logFile: string | null, out: Sink, prefix = true): Sink {
    return line => {
        for (const l of line.split(/\r?\n/)) {
            noteStatusLine(name, l);
            if (logFile) {
                try { appendFileSync(logFile, l + '\n'); } catch { /* the log file is optional */ }
            }
            out(prefix ? `[${name}] ${l}` : l);
        }
    };
}

// One script run for one bot: its own argv, env, console, exit and finish. A chain bot gets one per step.
function createInstance(name: string, id: string, script: string, args: string[], env: Record<string, string | undefined>, sink: Sink, open: typeof openBot): Instance {
    let resolveDone!: (code: number) => void;
    const done = new Promise<number>(r => { resolveDone = r; });
    let finished = false;
    const never = new Promise<never>(() => {});
    // One function per instance: it names this bot to process.env Proxy and code the host does not rewrite (bot/host-scope.ts).
    const execLog = (level: 'log' | 'warn' | 'error', a: unknown[]) => inst.console[level](...a);
    const execution = workerExecution(execLog);
    const inst: Instance = {
        id,
        name,
        argv: [process.argv[0]!, script, name, ...args],
        env,
        console: {
            log: (...a) => inst.log(fmt(a)),
            info: (...a) => inst.log(fmt(a)),
            warn: (...a) => inst.log(fmt(a)),
            error: (...a) => inst.log(fmt(a)),
        },
        log(line) {
            for (const l of line.split(/\r?\n/)) {
                if (l.startsWith('RESULT ')) inst.result = l;
                sink(l);
            }
        },
        exit(code = 0) {
            inst.execution.stop(new Error(`worker exited ${code}`));
            if (!finished) {
                finished = true;
                const pending = [...inst.openings];
                if (inst.sessions.length || pending.length) {
                    void inst.execution.cleanup(async () => {
                        await Promise.allSettled(pending);
                        return settle(inst.sessions, code === 0 && !pending.length, `script exit ${code}`, { log: l => inst.log(l) });
                    })
                        .then(ok => resolveDone(code || (ok ? 0 : 1)), e => { inst.log(`WARN exit cleanup failed: ${fmt([e])}`); resolveDone(code || 1); });
                } else resolveDone(code);
            }
            throw new HostExit(code);
        },
        async openBot(botName, o) {
            if (finished || inst.execution.signal.aborted || executionContext.getStore()?.signal.aborted) return never;
            const runOpen = async () => {
                const s = await open(botName, { record: { script, argv: inst.argv.slice(2), env: inst.env }, ...hostedOpenOptions(l => inst.log(l), (s, detail) => inst.finish([s], false, detail), o) });
                if (finished || inst.execution.signal.aborted) {
                    await inst.execution.cleanup(() => settle([s], false, 'session opened after worker stopped', { log: l => inst.log(l) }));
                    throw inst.execution.signal.reason ?? new Error('worker stopped during open');
                }
                inst.execution.bind(s);
                inst.sessions.push(s);
                return s;
            };
            const opening = executionContext.getStore()?.log === execLog ? runOpen() : inst.execution.run(runOpen);
            inst.openings.add(opening);
            try { return await opening; } finally { inst.openings.delete(opening); }
        },
        async finish(sessions, ok, detail) {
            if (finished) return never;
            finished = true;
            const pending = [...inst.openings];
            inst.execution.stop(new Error(`worker finished: ${detail}`));
            // Same steps as finish() in bot.ts, without the process exit: RESULT, ledgers, logout, close.
            const final = await inst.execution.cleanup(async () => {
                await Promise.allSettled(pending);
                return settle([...new Set([...sessions, ...inst.sessions])], ok && !pending.length, detail, { log: l => inst.log(l) });
            }).catch(e => { inst.log(`WARN settle failed: ${fmt([e])}`); return false; });
            resolveDone(final ? 0 : 1);
            // Like process.exit: nothing after finish() in the script runs.
            return never;
        },
        sessions: [],
        result: '',
        done,
        execution,
        openings: new Set(),
    };
    bindHostedScope(execLog, inst);
    instByLog.set(execLog, inst);
    return inst;
}

// Imports the script once as a reusable callable module (?hostfn=1) and runs one bot instance.
async function runInstance(inst: Instance): Promise<{ code: number; result: string }> {
    registry.set(inst.id, inst);
    const url = `${inst.argv[1]!.replace(/\\/g, '/')}?${SCRIPT_FN_Q}=1`;
    import(url).then(
        mod => (mod as { __runHost: (host: Instance) => Promise<void> }).__runHost(inst),
    ).then(
        // The script body ended without finish() or exit(): like a script process with nothing left to run.
        () => { void inst.finish(inst.sessions, false, 'script ended without finish'); },
        async e => {
            if (e instanceof HostExit) return;
            inst.log(`ERROR script threw: ${fmt([e])}`);
            // A script process that crashes drops its sessions; here they are logged out first.
            await inst.finish(inst.sessions, false, `script threw: ${String(e).slice(0, 200)}`);
        },
    );
    const code = await inst.done;
    registry.delete(inst.id);
    return { code, result: inst.result };
}

export interface RunHostedBotOpts {
    out?: Sink;
    logFile?: string | null;
    logDir?: string;
    guard?: boolean;
    open?: typeof openBot;
    prefix?: boolean;
    root?: string;
    stallMs?: number;
    checkMs?: number;
    newestStatus?: (accounts: readonly string[], root?: string) => number;
    drained?: () => readonly string[];
    cancel?: AbortSignal;
    stamp?: string;
}

const STALL_PREFIX = 'no worker progress: stalled with no output and no status write';

// Runs one hosted bot (single script or in-process chain) with optional per-bot stall watch and cancel isolation.
export async function runHostedBot(bot: HostedBot, opts: RunHostedBotOpts = {}): Promise<HostedResult & { stalled: boolean }> {
    const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
    const root = opts.root ?? repoRoot;
    let logFile: string | null;
    if (opts.logFile === null) {
        logFile = null;
    } else if (opts.logFile !== undefined) {
        logFile = opts.logFile;
    } else {
        const logDir = opts.logDir ?? join(root, '.practice', 'logs');
        mkdirSync(logDir, { recursive: true });
        logFile = join(logDir, `host-${bot.name}.log`);
        writeFileSync(logFile, '');
    }
    install(out, opts.guard ?? true);
    await shareLocIndex();
    const open = opts.open ?? openBot;
    const baseSink = botSink(bot.name, logFile, out, opts.prefix ?? true);
    const started = Date.now();
    let lastOutput = started;
    let stalled = false;
    let activeInst: Instance | null = null;
    const sink: Sink = line => {
        lastOutput = Date.now();
        baseSink(line);
    };
    const abortActive = (detail: string) => {
        const inst = activeInst;
        if (inst) void inst.finish(inst.sessions, false, detail);
    };
    const onCancel = () => {
        abortActive(typeof opts.cancel?.reason === 'string' && opts.cancel.reason ? opts.cancel.reason : 'stop file');
    };
    if (opts.cancel) {
        if (opts.cancel.aborted) onCancel();
        else opts.cancel.addEventListener('abort', onCancel, { once: true });
    }
    const stallMs = opts.stallMs ?? 0;
    const watch = stallMs > 0 ? setInterval(() => {
        if (stalled) return;
        const last = Math.max(started, lastOutput, opts.newestStatus?.([bot.name], root) ?? 0);
        if (Date.now() - last < stallMs) return;
        stalled = true;
        if (watch) clearInterval(watch);
        abortActive(`${STALL_PREFIX} for ${Math.round(stallMs / 60_000)} min`);
    }, opts.checkMs ?? 30_000) : null;

    const runTracked = async (inst: Instance) => {
        activeInst = inst;
        if (opts.cancel?.aborted) {
            void inst.finish(inst.sessions, false, typeof opts.cancel.reason === 'string' && opts.cancel.reason ? opts.cancel.reason : 'stop file');
        }
        try { return await runInstance(inst); }
        finally { if (activeInst === inst) activeInst = null; }
    };

    const env = { ...BASE_ENV, ...(bot.env ?? {}) };
    const stamp = opts.stamp ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const steps = bot.steps ?? (isChainScript(bot.script) ? (bot.args ?? []).map(parseStep) : undefined);
    try {
        let end: { code: number; result: string };
        if (steps) {
            const rounds = Number(env.ROUNDS ?? 1);
            const stopped = () => !!opts.cancel?.aborted || stalled || hasStopFile(bot.name, root);
            const result = await runChainSteps(steps, rounds, {
                stopped,
                log: sink,
                ...(opts.drained ? { drained: opts.drained } : {}),
                run: async (st, round, k) => {
                    const inst = createInstance(bot.name, `${bot.name}-${stamp}-r${round}s${k}`, resolve(root, st.script), st.args, { ...env, ...st.env }, sink, open);
                    const r = await runTracked(inst);
                    const res = r.result || 'RESULT fail no result';
                    return r.code !== 0 && /^RESULT ok(?: |$)/.test(res) ? `RESULT fail child exit ${r.code}: ${res}` : res;
                },
            });
            sink(result);
            end = { code: /^RESULT ok(?: |$)/.test(result) ? 0 : 1, result };
        } else {
            const inst = createInstance(bot.name, `${bot.name}-${stamp}`, resolve(root, bot.script), bot.args ?? [], env, sink, open);
            end = await runTracked(inst);
        }
        return { name: bot.name, ok: end.code === 0 && !stalled, code: stalled ? (end.code || 1) : end.code, result: end.result, stalled };
    } finally {
        if (watch) clearInterval(watch);
        opts.cancel?.removeEventListener('abort', onCancel);
    }
}

export async function runHost(bots: HostedBot[], opts: { staggerMs?: number; out?: (line: string) => void; logDir?: string; guard?: boolean; open?: typeof openBot } = {}): Promise<HostedResult[]> {
    const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
    const logDir = opts.logDir ?? join(repoRoot, '.practice', 'logs');
    mkdirSync(logDir, { recursive: true });
    install(out, opts.guard ?? true);
    await shareLocIndex();
    const names = new Set<string>();
    for (const b of bots) {
        if (names.has(b.name)) throw new Error(`bot ${b.name} listed twice`);
        names.add(b.name);
    }
    const runs: Promise<HostedResult>[] = [];
    for (const [i, b] of bots.entries()) {
        if (i > 0 && opts.staggerMs) await Bun.sleep(opts.staggerMs);
        runs.push(runHostedBot(b, {
            out,
            logDir,
            guard: opts.guard,
            open: opts.open,
            stamp: `${Date.now().toString(36)}-${i}`,
        }).then(({ name, ok, code, result }) => ({ name, ok, code, result })));
    }
    return await Promise.all(runs);
}

// jopt-simple's required argument + typed conversion boundary, rewritten for
// the host flags. Reject bad values before opening any worker sessions.
export function parseHostArgs(argv: string[]) {
    const positional: string[] = [], values = new Map<string, number>(), args: string[] = [], env: Record<string, Record<string, string>> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        // --args a,b or --arg a: script arguments for every bot, after its name (bun <script> <bot> a b).
        if (arg === '--args') { const raw = argv[++i]; if (raw === undefined) throw new Error('--args requires a value'); args.push(...raw.split(',').filter(Boolean)); continue; }
        if (arg === '--arg') { const raw = argv[++i]; if (raw === undefined) throw new Error('--arg requires a value'); args.push(raw); continue; }
        // --env <bot> KEY=value: one variable for one bot; repeat per variable.
        if (arg === '--env') {
            const name = argv[++i], pair = argv[++i];
            const m = pair?.match(/^([A-Z_][A-Z0-9_]*)=([^]*)$/);
            if (!name || name.startsWith('--') || !m) throw new Error('--env requires <bot> KEY=value');
            (env[name] ??= {})[m[1]!] = m[2]!;
            continue;
        }
        if (!['--stagger-ms', '--mem-every-s'].includes(arg)) throw new Error(`unknown option ${arg}`);
        if (values.has(arg)) throw new Error(`duplicate option ${arg}`);
        const raw = argv[++i];
        if (!raw?.trim() || raw.startsWith('--')) throw new Error(`${arg} requires a number`);
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0 || (arg === '--stagger-ms' && value > 2_147_483_647)) throw new Error(`${arg} is out of range`);
        if (arg === '--mem-every-s' && !Number.isSafeInteger(value)) throw new Error(`${arg} requires whole seconds`);
        values.set(arg, value);
    }
    const [script, ...names] = positional;
    for (const name of Object.keys(env)) if (!names.includes(name)) throw new Error(`--env names ${name}, which is not a hosted bot`);
    return { script, names, args, env, stagger: values.get('--stagger-ms') ?? 0, memEvery: values.get('--mem-every-s') ?? 0 };
}

// The bots a parsed command line runs: a chain script turns the arguments into every bot's steps.
export function hostedBots(parsed: Pick<ReturnType<typeof parseHostArgs>, 'script' | 'names' | 'args' | 'env'>): HostedBot[] {
    const script = parsed.script!;
    const steps = isChainScript(script) ? parsed.args.map(parseStep) : undefined;
    if (steps && steps.length === 0) throw new Error('a chain host needs at least one --arg step');
    return parsed.names.map(name => ({ name, script, args: parsed.args, env: parsed.env[name], ...(steps ? { steps } : {}) }));
}

if (import.meta.main) {
    let parsed: ReturnType<typeof parseHostArgs>, bots: HostedBot[];
    try {
        parsed = parseHostArgs(process.argv.slice(2));
        if (!parsed.script || parsed.names.length === 0) {
            console.log('usage: bun packages/core/src/host.ts <script> <bot1> [bot2 ...] [--stagger-ms N] [--mem-every-s N] [--arg v]... [--env <bot> KEY=value]...');
            process.exit(2);
        }
        bots = hostedBots(parsed);
    } catch (error) { console.error(`invalid host arguments: ${String(error)}`); process.exit(2); }
    const { script, names, stagger, memEvery } = parsed;
    const t0 = Date.now();
    console.log(`HOST start bots=${names.length} script=${script} pid=${process.pid} ${memLine()}`);
    let peak = 0;
    const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
        if (memEvery > 0 && Math.round((Date.now() - t0) / 1000) % memEvery === 0) console.log(`HOST ${memLine(`t=${Math.round((Date.now() - t0) / 1000)}s`)}`);
    }, 1000);
    const results = await runHost(bots, { staggerMs: stagger });
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const ok = results.every(r => r.ok);
    console.log(`HOST done ok=${results.filter(r => r.ok).length}/${results.length} seconds=${Math.round((Date.now() - t0) / 1000)} peakRssMB=${Math.round(peak / 2 ** 20)} ${memLine()}`);
    process.exit(ok ? 0 : 1);
}
