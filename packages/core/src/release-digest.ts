// The digest of one release file (worker-release.ts), and the imports of a code file that stay at run time.
// A release names the code a worker can run. Two files that give the same program get the same digest:
// - Code (TypeScript, JavaScript): the digest covers the syntax tree, node kinds and token text. Comments, blank
//   lines, indentation and line endings are not in it. Type annotations are in it, so the digest needs no judgement
//   about which syntax the runtime erases.
// - JSON: the bytes with each CRLF as LF.
// - Other files (wasm): the bytes.
// A checkout with CRLF line endings (the SDK submodule on Windows) and one with LF (a hosted Linux runner) therefore
// give the same release for the same commit, and a comment edit does not change a release. ECMAScript reads CRLF in a
// template literal as LF, so the line ending changes no value of the program.
import {createHash} from 'node:crypto';
import type TS from 'typescript';

// Give this a new value with every change to what a digest covers (normalizedCode, releaseFileDigest, the file kinds):
// the digest store and the release cache keep a digest under the bytes of its file and this value, so a change of the
// rule with the old value would serve digests of the old rule. The store also holds the TypeScript version, because
// the node kinds in a digest are numbers of that version.
export const RELEASE_DIGEST_VERSION = 'release-digest-2';
const code = /\.(?:ts|tsx|js|mjs|cjs)$/, json = /\.json$/;
const sha = (domain: string, data: string | Uint8Array) => createHash('sha256').update(domain + '\0').update(data).digest('hex');

// The syntax tree as text: one line for each node with its kind, one line for each token with its kind and text.
// JSDoc nodes are comments and are left out. The tree keeps what the token list alone loses: `return` and `x` on two
// lines are two statements, on one line they are one.
export function normalizedCode(path: string, text: string, ts: typeof TS): string {
    const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.ts$/.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const file = ts.createSourceFile(path, text.replace(/\r\n?/g, '\n'), ts.ScriptTarget.ESNext, false, kind);
    const out: string[] = [];
    const visit = (node: TS.Node) => {
        if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
        const children = node.getChildren(file);
        if (!children.length) { out.push(node.kind + ':' + node.getText(file)); return; }
        out.push('(' + node.kind);
        for (const child of children) visit(child);
        out.push(')');
    };
    visit(file);
    return out.join('\n');
}

export function releaseFileDigest(path: string, bytes: Uint8Array, ts: typeof TS): string {
    if (code.test(path)) return sha('code', normalizedCode(path, Buffer.from(bytes).toString('utf8'), ts));
    if (!json.test(path) || !bytes.includes(13)) return sha(json.test(path) ? 'text' : 'raw', bytes);
    const out = Buffer.allocUnsafe(bytes.length);
    let n = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 13 || bytes[i + 1] !== 10) out[n++] = bytes[i]!;
    return sha('text', out.subarray(0, n));
}

// The relative and package imports of a code file that the runtime can load: `import type`, `export type ... from`
// and type positions are erased before the file runs, so the file they name is not loaded through them. Bun's own
// import scan gives the list (dead code is kept, so the list does not depend on the environment). null when the scan
// cannot read the file: the caller then takes every import statement.
const scanners = new Map<string, InstanceType<typeof Bun.Transpiler>>();
export function runtimeImports(path: string, text: string): string[] | null {
    const loader = /\.tsx$/.test(path) ? 'tsx' : /\.ts$/.test(path) ? 'ts' : /\.(?:mjs|cjs|js)$/.test(path) ? 'js' : null;
    if (!loader) return null;
    let scanner = scanners.get(loader);
    if (!scanner) scanners.set(loader, scanner = new Bun.Transpiler({ loader, deadCodeElimination: false, trimUnusedImports: false }));
    try { return scanner.scanImports(text).map(i => i.path); } catch { return null; }
}
