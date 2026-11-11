import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// A table that is read from thousands of content files takes about a second to build. Each worker process needs it
// at login, so the built table is kept in `.practice/cache/knowledge/` under a key of the content version: the
// commit of the vendor checkout and the local vendor patch. KNOWLEDGE_CACHE=0 builds the table each time.
//
// The key does not see a content file that is edited by hand and is in neither the commit nor the patch.
const repoRoot = resolve(import.meta.dir, '..', '..', '..');

let version: string | null | undefined;
function contentVersion(): string | null {
    if (version !== undefined) return version;
    try {
        const vendor = join(repoRoot, 'vendor', 'rs-sdk');
        const dotGit = join(vendor, '.git');
        // A submodule has a `.git` file that names its git directory.
        const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir: (.+)$/m)?.[1]?.trim();
        const gitDir = pointer ? (isAbsolute(pointer) ? pointer : resolve(vendor, pointer)) : dotGit;
        const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
        const commit = head.startsWith('ref: ') ? readFileSync(join(gitDir, head.slice(5)), 'utf8').trim() : head;
        const patch = join(repoRoot, 'patches', 'rs-sdk-working.patch');
        version = createHash('sha1').update(commit).update(existsSync(patch) ? readFileSync(patch) : '').digest('hex').slice(0, 16);
    } catch { version = null; }
    return version;
}

// `build` makes the table; `rows` are its JSON rows. `schema` changes when the row format changes.
export function cachedRows<Row>(name: string, schema: number, build: () => Row[]): Row[] {
    const key = process.env.KNOWLEDGE_CACHE === '0' ? null : contentVersion();
    if (key === null) return build();
    const dir = join(repoRoot, '.practice', 'cache', 'knowledge'), file = join(dir, `${name}-${schema}-${key}.json`);
    try { if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Row[]; } catch { /* a damaged file: build again */ }
    const rows = build();
    try {
        mkdirSync(dir, { recursive: true });
        // Written under another name first: two workers can start at the same time.
        const part = `${file}.${process.pid}.part`;
        writeFileSync(part, JSON.stringify(rows));
        renameSync(part, file);
    } catch { /* the cache is an optimization */ }
    return rows;
}
