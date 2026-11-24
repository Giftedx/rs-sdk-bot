import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type TS from 'typescript';
import { spawnSyncTimed } from '../../../core/src/proc';
import { runtimeImports } from '../../../core/src/release-digest';

// `mergedDelivery`: the local bytes are the snapshot of a coordinator delivery whose pull request merged (or had nothing
// to commit). The build published the file here before the merge; master holds its change, so the copy is
// obsolete and the update takes master's version (mergedDeliveryCopies).
// `rebase`: the merged text that the update writes after the move (rebasableDeliveryEdits).
export type Dirty = { path: string; sameAsTarget: boolean; untracked: boolean; mergedDelivery?: boolean; rebase?: string };
// `unknown`: the entry of the run gives no file here, so the files that the run loads are not known.
export type LiveRun = { name: string; files: readonly string[]; unknown?: true };
// `vendorRelease`: the worker release files that the update changes through the SDK patch (vendorReleaseFiles).
// `qualifications`: the running qualifications (`qualification <id> runs`); they hold only an update that changes a
// file they can check (qualificationSource).
// `bunfigPreloadOnly`: the incoming bunfig.toml changes only its `preload` lines, and each preload file that it adds is in the
// target (see bunfigPreloadOnly below). That change installs nothing.
export type UpdateInput = {
    branch: string;
    ahead: number;
    behind: number;
    incoming: readonly string[];
    dirty: readonly Dirty[];
    holds: readonly string[];
    heldFiles: readonly string[];
    qualifications?: readonly string[];
    liveRuns?: readonly LiveRun[];
    vendorRelease?: readonly string[];
    bunfigPreloadOnly?: boolean;
};
// The merged text that an update wrote over a delivery's file, by path: the hash of that text and the delivery task.
export type RebasedFiles = Record<string, { hash: string; taskId: string }>;
export type Git = (...args: string[]) => { ok: boolean; out: string };

const lf = (s: string) => s.replaceAll('\r\n', '\n');

export const few = (files: readonly string[]) => files.slice(0, 3).join(', ') + (files.length > 3 ? ` and ${files.length - 3} more` : '');

export const LIVE_UPDATE_GIT_TIMEOUT_MS = 30_000;
const nonInteractiveGitEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
});

export const gitIn = (root: string, timeoutMs = LIVE_UPDATE_GIT_TIMEOUT_MS): Git => (...args) => {
    const p = spawnSyncTimed(['git', '-c', 'core.quotepath=off', ...args], {
        cwd: root,
        env: nonInteractiveGitEnv(),
        windowsHide: true,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
    });
    const out = (p.stdout.toString() + (p.exitCode === 0 ? '' : p.stderr.toString())).trimEnd();
    return {
        ok: p.exitCode === 0,
        out: out || (p.exitCode === null ? `git timed out after ${timeoutMs}ms` : ''),
    };
};

export const gitHash = (path: string, timeoutMs = LIVE_UPDATE_GIT_TIMEOUT_MS): string | null => {
    const p = spawnSyncTimed(['git', 'hash-object', '--', path], {
        env: nonInteractiveGitEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
        timeout: timeoutMs,
    });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

const importParses = new Map<string, { mtimeMs: number; size: number; source: string; relative: string[] }>();
const IMPORT_PARSE_LIMIT = 2048;
let lazyTs: typeof TS | undefined;
function loadTs(): typeof TS {
    return (lazyTs ??= require('typescript') as typeof TS);
}

function relativeImports(path: string, mtimeMs: number, size: number, nowWall: number): readonly string[] {
    const prior = importParses.get(path);
    // Trust (mtimeMs, size) without reading file bytes once mtime is strictly older than 1s;
    // within 1s verify content sha256 so same-tick file writes invalidate immediately.
    if (prior && prior.mtimeMs === mtimeMs && prior.size === size && nowWall - mtimeMs > 1000) {
        return prior.relative;
    }
    const content = readFileSync(path, 'utf8');
    const source = createHash('sha256').update(content).digest('hex');
    if (prior?.source === source) {
        if (prior.mtimeMs !== mtimeMs || prior.size !== size) {
            importParses.set(path, { mtimeMs, size, source, relative: prior.relative });
        }
        return prior.relative;
    }
    const loaded = runtimeImports(path, content);
    let rels: string[];
    if (loaded !== null) {
        const uniq = new Set<string>();
        for (const s of loaded) {
            if (s.startsWith('.')) uniq.add(s);
        }
        rels = [...uniq];
    } else {
        rels = loadTs().preProcessFile(content, true, true).importedFiles.map(s => s.fileName).filter(s => s.startsWith('.'));
    }
    if (!prior && importParses.size >= IMPORT_PARSE_LIMIT) importParses.clear();
    importParses.set(path, { mtimeMs, size, source, relative: rels });
    return rels;
}

function statRegularFile(fullPath: string): { mtimeMs: number; size: number } | null {
    try {
        const st = statSync(fullPath);
        return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch {
        return null;
    }
}

// Relative import closure for a list of repository entry files, without depending on packages/router/.
export function importClosure(starts: readonly string[], base = resolve(import.meta.dir, '../../../..')): string[] {
    const resolvedBase = resolve(base);
    const nowWall = Date.now();
    const seen = new Set<string>();
    const queue: { file: string; stat?: { mtimeMs: number; size: number } }[] = starts.map(file => ({ file }));
    const resolved = new Map<string, { file: string; stat: { mtimeMs: number; size: number } } | undefined>();
    const resolveFile = (file: string, spec: string): { file: string; stat: { mtimeMs: number; size: number } } | undefined => {
        const target = relative(resolvedBase, resolve(resolvedBase, dirname(file), spec)).replaceAll('\\', '/');
        if (resolved.has(target)) return resolved.get(target);
        const candidates = /\.(?:ts|tsx|js|mjs|cjs|json)$/.test(target)
            ? [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`]
            : [`${target}.ts`, `${target}/index.ts`, target, `${target}.tsx`];
        let next: { file: string; stat: { mtimeMs: number; size: number } } | undefined;
        for (const c of candidates) {
            const st = statRegularFile(join(resolvedBase, c));
            if (st) {
                next = { file: c, stat: st };
                break;
            }
        }
        resolved.set(target, next);
        return next;
    };
    while (queue.length) {
        const item = queue.pop()!;
        const { file } = item;
        if (seen.has(file)) continue;
        const full = join(resolvedBase, file);
        let st = item.stat;
        if (!st) {
            try {
                const s = statSync(full);
                st = { mtimeMs: s.mtimeMs, size: s.size };
            } catch {
                continue;
            }
        }
        seen.add(file);
        if (!/\.(?:ts|tsx|js|mjs)$/.test(file)) continue;
        for (const spec of relativeImports(full, st.mtimeMs, st.size, nowWall)) {
            const next = resolveFile(file, spec);
            if (next && !seen.has(next.file)) queue.push(next);
        }
    }
    return [...seen].sort();
}

// A bunfig.toml change that adds or removes only `preload` entries needs no `bun install`: a preload is a source file that a
// process loads when it starts, and the target brings it. The text outside the `preload` lines must be the same.
export function preloadOnlyChange(before: string, after: string): boolean {
    const rest = (s: string) => lf(s).split('\n').filter(l => !/^\s*preload\s*=/.test(l)).join('\n');
    return lf(before) !== lf(after) && rest(before) === rest(after);
}

// The preload paths that `after` names and `before` does not, relative to the repository root.
export function addedPreloads(before: string, after: string): string[] {
    const paths = (s: string) => new Set(lf(s).split('\n').filter(l => /^\s*preload\s*=/.test(l)).flatMap(l => [...l.matchAll(/"([^"]+)"/g)].map(m => m[1]!.replace(/^\.\//, ''))));
    const old = paths(before);
    return [...paths(after)].filter(p => !old.has(p));
}

// `git status --porcelain -z`: "XY path" records split by NUL; a rename or copy record is followed by its source path.
export function parseStatus(out: string): { path: string; untracked: boolean }[] {
    const rows: { path: string; untracked: boolean }[] = [], parts = out.split('\0');
    for (let n = 0; n < parts.length; n++) {
        const part = parts[n]!;
        if (part.length < 4) continue;
        const code = part.slice(0, 2);
        rows.push({ path: part.slice(3), untracked: code === '??' });
        if (/[RC]/.test(code)) { const source = parts[++n]; if (source) rows.push({ path: source, untracked: false }); }
    }
    return rows;
}

export function touchesIncomingPath(rawPath: string, changed: ReadonlySet<string>): boolean {
    const clean = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath;
    if (changed.has(clean)) return true;
    const prefix = `${clean}/`;
    for (const incomingPath of changed) {
        if (incomingPath.startsWith(prefix) || clean.startsWith(`${incomingPath}/`)) return true;
    }
    return false;
}

function symlinkSameAsTarget(git: Git, target: string, path: string, linkTarget: string): boolean {
    const ls = git('ls-tree', '-z', target, '--', path);
    if (!ls.ok) return false;
    const entry = /^120000 blob ([a-f0-9]+)\t/.exec(ls.out.split('\0')[0] ?? '');
    if (!entry) return false;
    const bytes = Buffer.from(linkTarget);
    const digest = createHash(entry[1]!.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return digest === entry[1];
}

export function readCheckout(git: Git, root: string, target: string): Omit<UpdateInput, 'holds' | 'heldFiles'> {
    const need = (r: { ok: boolean; out: string }, what: string) => { if (!r.ok) throw Error(`${what}: ${r.out.slice(0, 200)}`); return r.out; };
    const branch = need(git('rev-parse', '--abbrev-ref', 'HEAD'), 'branch');
    const ahead = Number(need(git('rev-list', '--count', `${target}..HEAD`), 'ahead')), behind = Number(need(git('rev-list', '--count', `HEAD..${target}`), 'behind'));
    const incoming = behind ? need(git('diff', '--name-only', '-z', 'HEAD', target), 'diff').split('\0').filter(Boolean) : [];
    const changed = new Set(incoming);
    const dirty = !behind ? [] : parseStatus(need(git('status', '--porcelain', '-z', '--untracked-files=all'), 'status')).filter(r => touchesIncomingPath(r.path, changed)).map(r => {
        if (r.path.endsWith('/') || !changed.has(r.path)) return { ...r, sameAsTarget: false };
        const want = git('rev-parse', '--verify', '--quiet', `${target}:${r.path}`);
        const full = join(root, r.path);
        let st: ReturnType<typeof lstatSync> | null = null;
        try { st = lstatSync(full); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
        const sameAsTarget = !st
            ? !want.ok
            : st.isSymbolicLink()
                ? symlinkSameAsTarget(git, target, r.path, readlinkSync(full))
                : st.isFile() && want.ok && git('hash-object', `--path=${r.path}`, '--', r.path).out === want.out;
        return { ...r, sameAsTarget };
    });
    // A bunfig.toml that only adds preload files is no dependency change when each added file is in the target.
    let bunfigPreloadOnly: boolean | undefined;
    if (incoming.includes('bunfig.toml')) {
        const before = git('show', 'HEAD:bunfig.toml'), after = git('show', `${target}:bunfig.toml`);
        bunfigPreloadOnly = before.ok && after.ok && preloadOnlyChange(before.out, after.out)
            && addedPreloads(before.out, after.out).every(path => git('rev-parse', '--verify', '--quiet', `${target}:${path}`).ok);
    }
    return { branch, ahead, behind, incoming, dirty, ...(bunfigPreloadOnly === undefined ? {} : { bunfigPreloadOnly }) };
}

export const REBASED_FILE = join('.practice', 'live-update-rebased.json');

export function readRebased(root: string): RebasedFiles {
    try { const r = JSON.parse(readFileSync(join(root, REBASED_FILE), 'utf8')); return r && typeof r === 'object' ? r : {}; } catch { return {}; }
}

type DeliveryRecord = { taskId?: string; state?: string; url?: string; snapshot: string; files: string[] };

function deliveryRecords(root: string): DeliveryRecord[] {
    const dir = join(root, '.practice', 'coordinator', 'delivery-prs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(n => n.endsWith('.json')).flatMap(n => { try { return [JSON.parse(readFileSync(join(dir, n), 'utf8'))]; } catch { return []; } })
        .filter(r => typeof r?.snapshot === 'string' && Array.isArray(r.files));
}

// The local bytes are this delivery's: its snapshot of the file, or the merged text an earlier update wrote for it.
function deliveryCopy(r: DeliveryRecord, path: string, local: string, hash: (path: string) => string | null, rebased: RebasedFiles): boolean {
    if (hash(join(r.snapshot, path)) === local) return true;
    const mark = rebased[path];
    return !!mark && mark.hash === local && !!r.taskId && mark.taskId === r.taskId;
}

export function mergedDeliveryCopies(root: string, dirty: readonly Dirty[], merged: (url: string) => boolean,
    hash: (path: string) => string | null = gitHash, rebased: RebasedFiles = readRebased(root)): Set<string> {
    const out = new Set<string>();
    const candidates = dirty.filter(d => !d.untracked && !d.sameAsTarget);
    if (!candidates.length) return out;
    const records = deliveryRecords(root).filter(r => r.state === 'empty' || (r.state === 'opened' && typeof r.url === 'string'));
    for (const d of candidates) {
        const local = hash(join(root, d.path));
        if (!local) continue;
        for (const r of records) {
            if (!r.files.includes(d.path) || !deliveryCopy(r, d.path, local, hash, rebased)) continue;
            if (r.state === 'empty' || (typeof r.url === 'string' && merged(r.url))) { out.add(d.path); break; }
        }
    }
    return out;
}

export function rebasableDeliveryEdits(root: string, dirty: readonly Dirty[], incoming: readonly string[],
    read: { head: (path: string) => string | null; target: (path: string) => string | null; local: (path: string) => string | null },
    merge: (ours: string, base: string, theirs: string) => string | null,
    hash: (path: string) => string | null = gitHash, rebased: RebasedFiles = readRebased(root)): Map<string, { text: string; taskId: string }> {
    const out = new Map<string, { text: string; taskId: string }>(), changed = new Set(incoming);
    const candidates = dirty.filter(d => changed.has(d.path) && !d.untracked && !d.sameAsTarget && !d.mergedDelivery);
    if (!candidates.length) return out;
    const records = deliveryRecords(root).filter(r => (r.state === 'pending' || r.state === 'opened') && typeof r.taskId === 'string');
    for (const d of candidates) {
        const local = hash(join(root, d.path));
        const record = local ? records.find(r => r.files.includes(d.path) && deliveryCopy(r, d.path, local, hash, rebased)) : undefined;
        if (!record) continue;
        const ours = read.local(d.path), theirs = read.target(d.path), base = read.head(d.path) ?? '';
        if (ours === null || theirs === null) continue;
        const text = merge(lf(ours), lf(base), lf(theirs));
        if (text !== null) out.set(d.path, { text, taskId: record.taskId! });
    }
    return out;
}

// A three-way merge with git merge-file: the merged text, or null on a conflict or an error.
export function mergeText(ours: string, base: string, theirs: string): string | null {
    const dir = mkdtempSync(join(tmpdir(), 'live-update-merge-'));
    try {
        const [o, b, t] = ['ours', 'base', 'theirs'].map(n => join(dir, n));
        writeFileSync(o!, ours); writeFileSync(b!, base); writeFileSync(t!, theirs);
        const p = spawnSyncTimed(['git', 'merge-file', '-p', o!, b!, t!], {
            env: nonInteractiveGitEnv(),
            stdout: 'pipe',
            stderr: 'pipe',
            windowsHide: true,
            timeout: LIVE_UPDATE_GIT_TIMEOUT_MS,
        });
        return p.exitCode === 0 ? p.stdout.toString() : null;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}
