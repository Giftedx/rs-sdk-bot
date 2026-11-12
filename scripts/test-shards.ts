// Runs the test files of the given folders in several `bun test` processes at once and prints each shard's output.
// Usage: bun scripts/test-shards.ts [--shards n] [--changed <git ref>] <folder>...   (12 shards when not given)
// The number of shards is n at most. It is less when the memory above the floor is less (scripts/heavy-admission.ts).
// --changed runs only the test files that a change since <git ref> can reach (affectedTests below).
// TEST_SHARDS_JUNIT=<path prefix> also writes a JUnit file for each shard, to measure the time of each file.
// A file that fails in a shard runs once more alone: a test that fails only beside other processes then passes,
// and a real failure fails twice and is reported.
import { Glob } from 'bun';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { TEST_SHARD_GB, floorGB, freeGB, sizedNote, unitsThatFit } from './heavy-admission';

const root = resolve(import.meta.dir, '..');
let runs = 0;

// Longest file first, each into the shard with the least time so far: the slow files spread out and the shards end
// near the same time. `seconds` holds the files that take 3 s or more (test-shards.times.json); the rest count as 1 s.
export function shard(items: readonly string[], count: number, seconds: Readonly<Record<string, number>> = {}): string[][] {
    const out = Array.from({ length: Math.max(1, Math.min(count, items.length || 1)) }, () => ({ files: [] as string[], total: 0 }));
    const cost = (f: string) => seconds[f] ?? 1;
    for (const file of [...items].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b))) {
        const least = out.reduce((best, s) => (s.total < best.total ? s : best));
        least.files.push(file);
        least.total += cost(file);
    }
    return out.map(s => s.files);
}

// A change to one of these can reach any test, so every test runs.
const WIDE = /^(package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|\.gitmodules|\.github\/|patches\/|vendor\/|scripts\/test-shards|scripts\/ci-gate)/;
// A test with one of these reads a set of files it does not name, so it runs for every change.
const SCANS = /readdirSync\(|new Glob\(|ls-files|aioCatalog|benchCoverage/;

// The repo files one file can reach in one step: a relative import, or a quoted repo path (a worker that a test
// starts as a subprocess, a JSON file it reads).
export function references(file: string, base = root): string[] {
    const text = readFileSync(resolve(base, file), 'utf8'), out = new Set<string>();
    const add = (path: string) => {
        for (const candidate of [path, `${path}.ts`, `${path}.tsx`, join(path, 'index.ts')]) {
            if (/\.(tsx?|js|json|md)$/.test(candidate) && existsSync(resolve(base, candidate))) { out.add(candidate.replaceAll('\\', '/')); return; }
        }
    };
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) add(join(dirname(file), m[1]!).replaceAll('\\', '/'));
    for (const m of text.matchAll(/['"`]((?:\.\/)?(?:scripts|packages|docs|research|fleet|patches)\/[\w\-./]+\.(?:tsx?|json|md))['"`]/g)) add(m[1]!.replace(/^\.\//, ''));
    return [...out];
}

// The test files that a change to `changed` can reach: the test changed, it reaches a changed file through
// `references`, or it scans files it does not name. `null` means every test, because a wide file changed.
export function affectedTests(tests: readonly string[], changed: readonly string[], base = root): string[] | null {
    if (changed.some(f => WIDE.test(f))) return null;
    const hit = new Set(changed), steps = new Map<string, string[]>(), reaches = new Map<string, boolean>();
    const step = (f: string) => { let r = steps.get(f); if (!r) { try { r = references(f, base); } catch { r = []; } steps.set(f, r); } return r; };
    const reach = (f: string, path: Set<string>): boolean => {
        if (hit.has(f)) return true;
        const known = reaches.get(f);
        if (known !== undefined) return known;
        if (path.has(f)) return false;
        path.add(f);
        const yes = step(f).some(next => reach(next, path));
        path.delete(f);
        reaches.set(f, yes);
        return yes;
    };
    return tests.filter(t => reach(t, new Set()) || SCANS.test(readFileSync(resolve(base, t), 'utf8')));
}

// The files `bun test` names in its output, each followed by its failed tests.
export function failedFiles(output: string): string[] {
    const failed = new Set<string>();
    let file: string | null = null;
    for (const line of output.split(/\r?\n/)) {
        const named = /^(\S.*\.test\.tsx?):$/.exec(line.trim());
        if (named) file = named[1]!.replaceAll('\\', '/');
        else if (line.startsWith('(fail)') && file) failed.add(file);
    }
    return [...failed];
}

// A test with no limit of its own gets 20 s, not the default 5 s: beside other shards a test that takes 3 s alone
// can take 6 s, and that is load, not a hang.
async function run(files: string[]): Promise<{ code: number; output: string }> {
    const child = Bun.spawn(['bun', 'test', '--timeout', '20000', ...(process.env.TEST_SHARDS_JUNIT ? ['--reporter=junit', `--reporter-outfile=${process.env.TEST_SHARDS_JUNIT}-${++runs}.xml`] : []), ...files.map(f => `./${f}`)], { cwd: root, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: out + err };
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const at = argv.indexOf('--shards');
    const count = at >= 0 ? Number(argv.splice(at, 2)[1]) : 12;
    const refAt = argv.indexOf('--changed');
    const changedRef = refAt >= 0 ? argv.splice(refAt, 2)[1] : undefined;
    if (!Number.isSafeInteger(count) || count < 1 || !argv.length) throw new Error('usage: bun scripts/test-shards.ts [--shards n] <folder>...');
    const files: string[] = [];
    for (const folder of argv) {
        for await (const f of new Glob('**/*.test.{ts,tsx}').scan({ cwd: resolve(root, folder) })) {
            const path = `${folder.replace(/^\.\//, '').replace(/\/$/, '')}/${f.replaceAll('\\', '/')}`;
            if (!path.includes('node_modules/')) files.push(path);
        }
    }
    files.sort();
    const total = files.length;
    const from = argv.indexOf('--changed');
    if (from >= 0) throw new Error('--changed must come before the folders');
    if (changedRef) {
        const git = (...args: string[]) => Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true }).stdout.toString().trim();
        const mergeBase = git('merge-base', changedRef, 'HEAD');
        if (!mergeBase) throw new Error(`--changed: no merge base with ${changedRef}`);
        const changed = [...new Set([...git('diff', '--name-only', mergeBase, 'HEAD').split(/\r?\n/), ...git('status', '--porcelain', '--untracked-files=all').split(/\r?\n/).map(l => l.slice(3))])].filter(Boolean).map(f => f.replaceAll('\\', '/'));
        const selected = affectedTests(files, changed);
        console.log(selected ? `test-shards: ${changed.length} changed files reach ${selected.length} of ${total} test files` : `test-shards: a wide file changed, so all ${total} test files run`);
        if (selected) files.splice(0, files.length, ...selected);
    }
    const start = Date.now();
    const timesFile = resolve(import.meta.dir, 'test-shards.times.json');
    const seconds: Record<string, number> = existsSync(timesFile) ? JSON.parse(readFileSync(timesFile, 'utf8')) : {};
    // The shards take the memory above the floor and no more (scripts/heavy-admission.ts). With little memory free
    // the same files run in fewer processes, one at least.
    const free = freeGB(), floor = floorGB(root), shards = unitsThatFit(count, TEST_SHARD_GB, free, floor);
    if (shards < count) console.log(sizedNote('test-shards', `${shards} shards`, String(count), free, floor));
    const results = files.length ? await Promise.all(shard(files, shards, seconds).map(run)) : [];
    for (const r of results) process.stdout.write(r.output);
    const again = [...new Set(results.filter(r => r.code !== 0).flatMap(r => failedFiles(r.output)))];
    const unknown = results.some(r => r.code !== 0 && !failedFiles(r.output).length);
    let failed = unknown ? ['a shard exited with an error and named no failed test'] : [];
    for (const file of again) {
        const r = await run([file]);
        process.stdout.write(`\n--- alone: ${file}\n${r.output}`);
        if (r.code !== 0) failed.push(file);
    }
    console.log(`\ntest-shards: ${files.length} files in ${shards} shards, ${again.length} run again alone, ${failed.length} failed, ${Math.round((Date.now() - start) / 1000)} s`);
    if (failed.length) { console.log(`failed: ${failed.join(', ')}`); process.exit(1); }
}
