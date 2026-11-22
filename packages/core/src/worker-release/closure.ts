// Release closure discovery: relative runtime imports, data path literals, and top-level bunfig preloads.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type TS from 'typescript';
import { runtimeImports } from '../release-digest';
import {
    codeFile, hashOnly, kind, posix, progressionEntryMetadata, releaseDataRoots, releaseFile,
    releaseRootFiles, repoPath, root, runtimeTrees, skipped, ts, type ReleaseMemo,
} from './paths';

function treeFiles(base: string, dir: string, memo: ReleaseMemo): string[] {
    const key = 't:' + dir; if (memo.has(key)) return memo.get(key) as string[];
    const out: string[] = [], dirs: string[] = [];
    const walk = (d: string) => {
        dirs.push(d); for (const e of readdirSync(join(base, d), { withFileTypes: true })) {
            if (skipped.has(e.name)) continue; const p = d + '/' + e.name;
            if (e.isSymbolicLink()) throw Error('no worker progress: linked release source unsupported: ' + p);
            if (e.isDirectory()) walk(p); else if (releaseFile.test(e.name) && !e.name.endsWith('.test.ts')) out.push(p);
        }
    };
    walk(dir); memo.set('dirs:' + dir, dirs); memo.set(key, out); return out;
}
// Bun's relative resolution for the forms this repository uses, with the package.json a folder import reads.
function resolveImport(base: string, file: string, spec: string): string[] {
    const target = repoPath(base, resolve(base, dirname(file), spec));
    if (!target) throw Error('no worker progress: release import outside the repository: ' + file + ' -> ' + spec);
    const candidates = (t: string) => {
        const stem = t.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
        return [t, ...(stem !== t ? [stem + '.ts', stem + '.tsx'] : []), ...['.ts', '.tsx', '.d.ts', '.js', '.mjs', '.cjs', '.json'].map(x => t + x)];
    };
    const found = candidates(target).find(c => kind(base, c) === 'file');
    if (found) return [found];
    if (kind(base, target) === 'dir') {
        const manifest = target + '/package.json'; let main = 'index';
        if (kind(base, manifest) === 'file') { const m = JSON.parse(readFileSync(join(base, manifest), 'utf8'))?.main; if (typeof m === 'string' && m) main = m; }
        const entry = repoPath(base, resolve(base, target, main)), inside = entry && candidates(entry).concat(entry + '/index.ts', entry + '/index.js').find(c => kind(base, c) === 'file');
        if (inside) return kind(base, manifest) === 'file' ? [inside, manifest] : [inside];
    }
    throw Error('no worker progress: release import unresolved: ' + file + ' -> ' + spec);
}
// Consecutive literal arguments of one call are one path: join(root,'knowledge','npcs.json') names the file, and
// join(root,'knowledge',name) names the folder.
function stringLiterals(file: string, text: string): string[] {
    const out: string[] = [], joined = new Set<TS.Node>();
    const visit = (n: TS.Node): void => {
        if (ts.isCallExpression(n)) {
            let run: TS.StringLiteralLike[] = [];
            const flush = () => { if (run.length > 1) { out.push(run.map(r => r.text).join('/')); run.forEach(r => joined.add(r)); } run = []; };
            for (const a of n.arguments) { if (ts.isStringLiteralLike(a)) run.push(a); else flush(); }
            flush();
        }
        if (ts.isStringLiteralLike(n)) { if (!joined.has(n)) out.push(n.text); }
        else if (ts.isTemplateExpression(n)) { out.push(n.head.text); for (const s of n.templateSpans) out.push(s.literal.text); }
        ts.forEachChild(n, visit);
    };
    const scriptKind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind));
    return out;
}
// A literal names a release path when, read from the file's folder or from the repository root, it is an existing
// file under releaseDataRoots or vendor (a wasm a vendored module loads), or a folder under releaseDataRoots.
// Folders count from knowledge, scripts/<dir> and packages/<pkg>/<dir>.
function literalPaths(base: string, file: string, literal: string, memo: ReleaseMemo): { path: string; dir: boolean }[] {
    if (literal.length > 300 || !/^[\w@.\/\\-]+$/.test(literal) || /^[./\\]*$/.test(literal)) return [];
    const s = posix(literal); let fromRoot = s;
    for (let next = fromRoot.replace(/^(?:\.\.?\/|\/)/, ''); next !== fromRoot; next = fromRoot.replace(/^(?:\.\.?\/|\/)/, '')) fromRoot = next;
    const out: { path: string; dir: boolean }[] = [];
    for (const p of new Set([repoPath(base, resolve(base, dirname(file), s)), repoPath(base, resolve(base, fromRoot))])) {
        if (!p) continue; const parts = p.split('/'), top = parts[0]!;
        if (!releaseDataRoots.includes(top) && top !== 'vendor') continue;
        // A literal that does not exist can become release input when created. Watch its nearest existing
        // parent too, including an empty folder that contributes no current source file.
        let parent = dirname(p);
        while (kind(base, parent) !== 'dir' && parent !== '.') parent = dirname(parent);
        memo.set('dirs:literal:' + p, [parent]);
        const k = kind(base, p);
        if (k === 'file' && releaseFile.test(p) && !p.endsWith('.test.ts')) out.push({ path: p, dir: false });
        else if (k === 'dir' && releaseDataRoots.includes(top) && (top === 'knowledge' || top === 'scripts' && parts.length >= 2 || top === 'packages' && parts.length >= 3)) out.push({ path: p, dir: true });
    }
    return out;
}
function fileLinks(base: string, file: string, memo: ReleaseMemo): { files: string[]; dirs: string[] } {
    const key = 'l:' + file; if (memo.has(key)) return memo.get(key) as { files: string[]; dirs: string[] };
    const text = readFileSync(join(base, file), 'utf8'), files: string[] = [], dirs: string[] = [];
    // An import that the runtime erases (import type, export type, a type position) loads no file: the file it
    // names is in the release only when some other file can load it (release-digest.ts runtimeImports).
    const loaded = runtimeImports(file, text);
    for (const { fileName: spec } of ts.preProcessFile(text, true, true).importedFiles) {
        if (loaded && !loaded.includes(spec)) continue;
        if (spec.startsWith('.')) files.push(...resolveImport(base, file, spec));
        else if (spec.startsWith('@rsbot/')) throw Error('no worker progress: release workspace import unsupported: ' + file + ' -> ' + spec);
    }
    if (!hashOnly.has(file)) for (const literal of stringLiterals(file, text)) for (const p of literalPaths(base, file, literal, memo)) {
        if (progressionEntryMetadata.has(file) && !p.dir && p.path.startsWith('scripts/') && codeFile.test(p.path)) continue;
        (p.dir ? dirs : files).push(p.path);
    }
    const links = { files, dirs }; memo.set(key, links); return links;
}
const inRuntimeTree = (p: string) => runtimeTrees.some(t => p === t || p.startsWith(t + '/'));
function bunfigPreloads(base: string, memo: ReleaseMemo): string[] {
    if (kind(base, 'bunfig.toml') !== 'file') return [];
    memo.set('dirs:bunfig.toml', ['bunfig.toml']);
    const lines = readFileSync(join(base, 'bunfig.toml'), 'utf8').replaceAll('\r\n', '\n').split('\n'), out: string[] = [];
    let inPreload = false;
    for (const raw of lines) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        if (!inPreload && line.startsWith('[')) break;
        const rhs = inPreload ? line : /^preload\s*=\s*(.*)$/.exec(line)?.[1];
        if (rhs === undefined) continue;
        for (const m of rhs.matchAll(/["']([^"']+)["']/g)) {
            const spec = m[1]!, p = repoPath(base, resolve(base, spec));
            if (p && kind(base, p) === 'file') out.push(p);
            else if (spec.startsWith('.')) throw Error('no worker progress: release preload unresolved: ' + spec);
        }
        if (!inPreload && rhs.includes('[') && !rhs.includes(']')) inPreload = true;
        else if (inPreload && rhs.includes(']')) inPreload = false;
    }
    return out;
}
export function releaseFiles(entries: readonly string[], base = root, memo: ReleaseMemo = new Map()): string[] {
    const files = new Set<string>(releaseRootFiles), queue: string[] = [];
    const add = (p: string) => { if (!files.has(p)) { files.add(p); queue.push(p); } };
    for (const t of runtimeTrees) for (const p of treeFiles(base, t, memo)) files.add(p);
    for (const p of bunfigPreloads(base, memo)) add(p);
    for (const entry of entries) {
        const p = repoPath(base, resolve(base, entry));
        if (!p || kind(base, p) !== 'file') throw Error('no worker progress: release entry missing: ' + entry);
        add(p);
    }
    while (queue.length) {
        const file = queue.pop()!;
        if (!codeFile.test(file) || inRuntimeTree(file)) continue;
        const links = fileLinks(base, file, memo);
        links.files.forEach(add);
        for (const dir of links.dirs) treeFiles(base, dir, memo).forEach(add);
    }
    return [...files].sort();
}
