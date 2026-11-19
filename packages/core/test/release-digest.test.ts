import { expect, test } from 'bun:test';
import ts from 'typescript';
import { normalizedCode, releaseFileDigest, runtimeImports } from '../src/release-digest';

const bytes = (text: string) => new TextEncoder().encode(text);
const digest = (path: string, text: string) => releaseFileDigest(path, bytes(text), ts);
const source = [
    '// header', "import type { A } from './a';", "import { b } from './b';",
    '/** Adds one. */', 'export function f(x: number): number { /* inline */ return b(x) + 1; } // tail',
    "if (process.env.NODE_ENV === 'production') { b(2); }",
    'const s = `l1', 'l2 // text, not a comment`;', 'export const re = /\\/\\/x/g, u = "// text";', '',
].join('\n');

test('a comment, blank line, indentation or line ending edit keeps the digest of a code file', () => {
    const edited = source.replace('// header\n', '').replace('/** Adds one. */\n', '/* Adds 1 */\n\n\n').replace(' /* inline */', '').replace(' // tail', '')
        .replace('{ b(2); }', '{\n        b(2); // why\n}');
    expect(edited).not.toBe(source);
    expect(digest('x.ts', edited)).toBe(digest('x.ts', source));
    expect(digest('x.ts', source.replaceAll('\n', '\r\n'))).toBe(digest('x.ts', source));
});

test('a code edit changes the digest: a value, a dead branch, text inside a string, template or regex, a type', () => {
    const base = digest('x.ts', source);
    for (const [from, to] of [['+ 1', '+ 2'], ['b(2)', 'b(3)'], ['// text"', '// texts"'], ['l2 // text', 'l2 // texts'], ['/\\/\\/x/g', '/\\/\\/y/g'], ['x: number', 'x: bigint'], ["'./b'", "'./c'"]] as const) {
        expect(source.includes(from)).toBe(true);
        expect(digest('x.ts', source.replace(from, to))).not.toBe(base);
    }
});

test('a line break that changes the statements changes the digest', () => {
    expect(digest('x.ts', 'function f(x){ return\nx }')).not.toBe(digest('x.ts', 'function f(x){ return x }'));
    expect(normalizedCode('x.ts', 'a\n(b)', ts)).toBe(normalizedCode('x.ts', 'a(b)', ts));
});

test('JSON and other files: CRLF equals LF in JSON, every other byte counts', () => {
    expect(digest('k.json', '{"a":1,\r\n"b":2}\r\n')).toBe(digest('k.json', '{"a":1,\n"b":2}\n'));
    expect(digest('k.json', '{"a":1,\n"b":3}\n')).not.toBe(digest('k.json', '{"a":1,\n"b":2}\n'));
    expect(digest('k.json', '{"a": 1}')).not.toBe(digest('k.json', '{"a":1}'));
    expect(releaseFileDigest('m.wasm', new Uint8Array([0, 13, 10, 1]), ts)).not.toBe(releaseFileDigest('m.wasm', new Uint8Array([0, 10, 1]), ts));
    // One text under two kinds of file is two digests.
    expect(digest('k.json', '1')).not.toBe(digest('k.ts', '1'));
});

test('runtime imports leave out type imports and keep value, side-effect, dynamic and dead-branch imports', () => {
    const text = ["import type { A } from './a';", "import { type B } from './b-types';", "export type { C } from './c';", "import { d } from './d';", "import './side';",
        "export { e } from './e';", "let t: typeof import('./t');", "if (process.env.NODE_ENV === 'production') await import('./lazy');", "const r = require('./req');", 'd();'].join('\n');
    expect(runtimeImports('x.ts', text)!.sort()).toEqual(['./d', './e', './lazy', './req', './side']);
    expect(runtimeImports('x.json', '{}')).toBeNull();
});
