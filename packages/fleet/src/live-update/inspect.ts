import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
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

const importParses = new Map<string, { source: string; relative: string[] }>();
const IMPORT_PARSE_LIMIT = 2048;

function relativeImports(path: string, bytes: Buffer): readonly string[] {
    const content = bytes.toString('utf8'), source = createHash('sha256').update(content).digest('hex');
    const prior = importParses.get(path);
    if (prior?.source === source) return prior.relative;
    const loaded = runtimeImports(path, content);
    const rels = ts.preProcessFile(content, true, true).importedFiles.map(s => s.fileName).filter(s => s.startsWith('.') && (!loaded || loaded.includes(s)));
    if (!prior && importParses.size >= IMPORT_PARSE_LIMIT) importParses.clear();
    importParses.set(path, { source, relative: rels });
    return rels;
}

// Relative import closure for a list of repository entry files, without depending on packages/router/.
export function importClosure(starts: readonly string[], base = resolve(import.meta.dir, '../../../..')): string[] {
    const seen = new Set<string>(), queue = [...starts];
    const resolved = new Map<string, string | undefined>();
    const resolveFile = (file: string, spec: string): string | undefined => {
        const target = relative(resolve(base), resolve(base, dirname(file), spec)).replaceAll('\\', '/');
        if (resolved.has(target)) return resolved.get(target);
        const next = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(c => existsSync(join(base, c)) && !statSync(join(base, c)).isDirectory());
        resolved.set(target, next);
        return next;
    };
    while (queue.length) {
        const file = queue.pop()!;
        if (seen.has(file) || !existsSync(join(base, file))) continue;
        seen.add(file);
        if (!/\.(?:ts|tsx|js|mjs)$/.test(file)) continue;
        const bytes = readFileSync(join(base, file));
        for (const spec of relativeImports(join(base, file), bytes)) {
            const next = resolveFile(file, spec);
            if (next && !seen.has(next)) queue.push(next);
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

export function readCheckout(git: Git, root: string, target: string): Omit<UpdateInput, 'holds' | 'heldFiles'> {
    const need = (r: { ok: boolean; out: string }, what: string) => { if (!r.ok) throw Error(`${what}: ${r.out.slice(0, 200)}`); return r.out; };
    const branch = need(git('rev-parse', '--abbrev-ref', 'HEAD'), 'branch');
    const ahead = Number(need(git('rev-list', '--count', `${target}..HEAD`), 'ahead')), behind = Number(need(git('rev-list', '--count', `HEAD..${target}`), 'behind'));
    const incoming = behind ? need(git('diff', '--name-only', '-z', 'HEAD', target), 'diff').split('\0').filter(Boolean) : [];
    const changed = new Set(incoming);
    const dirty = !behind ? [] : parseStatus(need(git('status', '--porcelain', '-z', '--untracked-files=all'), 'status')).filter(r => changed.has(r.path)).map(r => {
        const want = git('rev-parse', '--verify', '--quiet', `${target}:${r.path}`), here = existsSync(join(root, r.path));
        const sameAsTarget = here ? want.ok && git('hash-object', '--', r.path).out === want.out : !want.ok;
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
