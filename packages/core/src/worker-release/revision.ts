// Release digest hashing, stamp-checked memory/disk caches, and entry revision computation.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { RELEASE_DIGEST_VERSION, releaseFileDigest } from '../release-digest';
import { releaseFiles } from './closure';
import { codeFile, kind, launchEntries, posix, root, ts, workerLaunchers, type ReleaseMemo } from './paths';

// The digest of each file is the digest of its program, not of its bytes (release-digest.ts): a comment, layout or
// line-ending edit keeps a release, and a Windows and a Linux checkout of one commit give one release.
// The digests are kept on disk under the hash of the file's bytes, so only a changed file is parsed again.
const digestStore = (base: string) => join(base, '.practice', 'cache', 'release', 'digests.json');
const digestStoreVersion = () => RELEASE_DIGEST_VERSION + ':typescript-' + ts.version;
function revisionOf(base: string, files: readonly string[], memo: ReleaseMemo): string {
    const hash = createHash('sha256');
    let kept = memo.get('digests') as Record<string, string> | undefined, added = false;
    if (!kept) {
        kept = {};
        try { const disk = JSON.parse(readFileSync(digestStore(base), 'utf8')); if (disk?.version === digestStoreVersion() && disk.digests && typeof disk.digests === 'object') kept = disk.digests as Record<string, string>; } catch { /* no store yet */ }
        memo.set('digests', kept);
    }
    for (const p of files) {
        const key = 'd:' + p; let digest = memo.get(key) as string | undefined;
        if (!digest) {
            const bytes = readFileSync(join(base, p)), raw = createHash('sha256').update(bytes).digest('hex') + extname(p);
            digest = kept[raw];
            if (!digest) { digest = kept[raw] = releaseFileDigest(p, bytes, ts); added = true; }
            memo.set(key, digest);
        }
        hash.update(p + '\0' + digest + '\0');
    }
    if (added) try { const file = digestStore(base); mkdirSync(dirname(file), { recursive: true }); const tmp = file + '.' + process.pid + '.tmp'; writeFileSync(tmp, JSON.stringify({ version: digestStoreVersion(), digests: kept })); renameSync(tmp, file); } catch { /* the store is optional */ }
    return hash.digest('hex');
}
export function releaseRevision(entries: readonly string[], base = root, memo: ReleaseMemo = new Map()): string {
    return revisionOf(base, releaseFiles(entries, base, memo), memo);
}
// The job script and every job argument that names a repository code file (a chain job's step scripts).
export function workerEntries(script: string, args: readonly unknown[] = [], base = root): string[] {
    const named = args.flatMap(a => String(a).split(/\s+/)).filter(t => codeFile.test(t) && !t.includes(',') && kind(base, posix(t)) === 'file');
    return [...new Set([script, ...named].map(posix))];
}
export function capabilityRevision(entries: readonly string[], base = root, memo: ReleaseMemo = new Map()): string {
    if (!entries.length) throw Error('no worker progress: capability release needs an entry');
    return releaseRevision([...entries, ...workerLaunchers], base, memo);
}
export function launchRevision(base = root, memo: ReleaseMemo = new Map()): string { return releaseRevision(launchEntries, base, memo); }
// WORKER_ENTRY holds a worker's entries, comma-separated; none means the launch release.
export function releaseEntries(value: unknown): string[] { return typeof value === 'string' ? value.split(',').filter(Boolean) : []; }

// Each release file's size and modification time and each of their folders' modification time (an added file
// changes it), with no file read: a coordinator loop checks this and hashes the files only when it changes.
function releaseStamp(base: string, files: readonly string[]): string {
    const hash = createHash('sha256');
    for (const p of [...files, ...new Set(files.map(f => dirname(f)))]) { const s = statSync(join(base, p)); hash.update(p + '\0' + s.size + '\0' + s.mtimeMs + '\0' + s.ctimeMs + '\0'); }
    return hash.digest('hex');
}
const releaseByEntries = new Map<string, { files: string[]; stamp: string; value: string }>();
// Group login must keep reading packets while it checks each actor. Reuse parsed release closures only while
// their files and folders retain their stamps; every network admission still checks the current stamps and peers.
// The same record is kept on disk (.practice/cache/release/), so a new process answers from the stamps alone, with no
// parse, while no release file or folder changed. The stamp check is the in-memory one.
export const forgetReleaseMemory = () => releaseByEntries.clear();
const releaseCacheFile = (base: string, key: string) => join(base, '.practice', 'cache', 'release', createHash('sha256').update(key).digest('hex').slice(0, 32) + '.json');
export function cachedReleaseFor(entries: readonly string[], base = root): string {
    const fullEntries = entries.length ? [...entries, ...workerLaunchers] : launchEntries, key = JSON.stringify([resolve(base), fullEntries, RELEASE_DIGEST_VERSION]);
    const hit = releaseByEntries.get(key);
    if (hit) try { if (releaseStamp(base, hit.files) === hit.stamp) return hit.value; } catch { /* a missing file recomputes */ }
    const file = releaseCacheFile(base, key);
    try {
        const disk = JSON.parse(readFileSync(file, 'utf8'));
        if (disk?.key === key && Array.isArray(disk.files) && typeof disk.stamp === 'string' && typeof disk.value === 'string' && releaseStamp(base, disk.files) === disk.stamp) {
            releaseByEntries.set(key, { files: disk.files, stamp: disk.stamp, value: disk.value }); return disk.value;
        }
    } catch { /* no record, or a changed or missing file: recompute */ }
    const memo: ReleaseMemo = new Map(), sourceFiles = releaseFiles(fullEntries, base, memo);
    const files = [...new Set([...sourceFiles, ...[...memo].filter(([k]) => k.startsWith('dirs:')).flatMap(([, v]) => v as string[])])], stamp = releaseStamp(base, files);
    const value = revisionOf(base, sourceFiles, memo); releaseByEntries.set(key, { files, stamp, value });
    try { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ key, files, stamp, value })); renameSync(tmp, file); } catch { /* the cache is optional */ }
    return value;
}
export function cachedLaunchRevision(base = root): string { return cachedReleaseFor([], base); }
