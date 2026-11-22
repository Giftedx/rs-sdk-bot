// Whole-tree worker source revision and cached runtime-only import boundary scanning.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { importedPath, root, toolingRoots, ts, workerSourceRoots } from './paths';

// The import check of a file depends only on its path and its bytes. It is 60% of workerSourceRevision (900 files
// through the TypeScript scanner), and a proof calls that function for each check it makes. So the check runs once
// for the bytes of a file: this record holds the SHA-256 of the bytes that passed, in memory and, for the next
// process, in .practice/cache/release/source-scan.json. Each call still reads and hashes every file.
const sourceScanRecords = new Map<string, Map<string, string>>();
/** Files that the import check scanned in this process. */
export const sourceScans = { count: 0 };
export const forgetSourceScans = () => sourceScanRecords.clear();
const sourceScanFile = (base: string) => join(base, '.practice', 'cache', 'release', 'source-scan.json');
function sourceScanRecord(base: string): Map<string, string> {
    const key = resolve(base); let record = sourceScanRecords.get(key);
    if (!record) {
        record = new Map();
        try { for (const [path, digest] of Object.entries(JSON.parse(readFileSync(sourceScanFile(base), 'utf8')))) if (typeof digest === 'string') record.set(path, digest); }
        catch { /* no record, or a damaged one: scan again */ }
        sourceScanRecords.set(key, record);
    }
    return record;
}
export function workerSourceRevision(base = root): string {
    const hash = createHash('sha256'), checked = sourceScanRecord(base);
    let added = false;
    const walk = (relative: string) => {
        for (const e of readdirSync(join(base, relative), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (['node_modules', '.git', '.practice'].includes(e.name)) continue;
            const p = `${relative}/${e.name}`;
            if (toolingRoots.includes(p)) continue;
            if (e.isSymbolicLink()) throw Error('no worker progress: linked release source unsupported');
            if (e.isDirectory()) walk(p);
            else if (/\.(?:ts|tsx|js|mjs|cjs|json|wasm)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
                const bytes = readFileSync(join(base, p));
                if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(p)) {
                    const digest = createHash('sha256').update(bytes).digest('hex');
                    if (checked.get(p) !== digest) {
                        sourceScans.count++;
                        for (const spec of ts.preProcessFile(bytes.toString(), true, true).importedFiles) {
                            if (!spec.fileName.startsWith('.')) continue;
                            const target = importedPath(base, p, spec.fileName);
                            if (toolingRoots.some(r => target === r || target.startsWith(r + '/')))
                                throw Error('no worker progress: runtime imports non-runtime package: ' + p);
                        }
                        checked.set(p, digest); added = true;
                    }
                }
                hash.update(p + '\0').update(bytes).update('\0');
            }
        }
    };
    workerSourceRoots.forEach(walk);
    for (const p of ['package.json', 'bun.lock', 'tsconfig.json']) hash.update(p + '\0').update(readFileSync(join(base, p))).update('\0');
    if (added) try { const file = sourceScanFile(base), tmp = `${file}.${process.pid}.tmp`; mkdirSync(dirname(file), { recursive: true }); writeFileSync(tmp, JSON.stringify(Object.fromEntries(checked))); renameSync(tmp, file); } catch { /* the record is optional */ }
    return hash.digest('hex');
}
