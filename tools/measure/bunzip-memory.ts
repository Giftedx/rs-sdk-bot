// RSS, peak RSS and time of unpacking one bzip2 archive of the size of the client's interface.jag (about 110 KB packed)
// with the web client's bunzip2 (vendor webclient io/BZip2.js): `raw` runs the vendor function, `cold` runs the
// project's cached function with an empty cache (bunzip-cache.ts), `warm` runs it with the entry present. The archive is
// made from the content's .if files with the system bzip2 and the 4-byte "BZh9" header removed, as JagFile passes it.
// Each mode runs in its own bun process, `runs` times (default 3).
// Usage: bun scripts/measure/bunzip-memory.ts [runs=3]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..', '..');
const mb = (n: number) => Math.round(n / 2 ** 20);
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.if') ? [join(dir, e.name)] : []);

function archive(): Buffer {
    const file = join(tmpdir(), 'bunzip-memory-input.bz2');
    if (!existsSync(file)) {
        const text = Buffer.concat(walk(join(root, 'vendor', 'rs-sdk', 'server', 'content', 'scripts')).sort().map(f => readFileSync(f)));
        const raw = join(tmpdir(), 'bunzip-memory-input.raw');
        writeFileSync(raw, text);
        const r = Bun.spawnSync(['bzip2', '-9', '-c', raw], { stdout: 'pipe', stderr: 'inherit', windowsHide: true });
        writeFileSync(file, r.stdout);
    }
    return readFileSync(file).subarray(4);
}

const mode = process.argv[2];
if (mode === 'raw' || mode === 'cold' || mode === 'warm') {
    const bytes = new Uint8Array(archive());
    const mod: any = await import(String('../../vendor/rs-sdk/server/webclient/src/io/BZip2.js'));
    const fn = mode === 'raw' ? (mod.bunzip2Raw ?? mod.bunzip2) : mod.bunzip2;
    Bun.gc(true);
    const before = process.memoryUsage().rss;
    const t0 = performance.now();
    const out = fn(bytes);
    const ms = Math.round(performance.now() - t0);
    const peak = process.resourceUsage().maxRSS * 1024;
    const steady = (Bun.gc(true), process.memoryUsage().rss);
    console.log(`${mode.padEnd(4)} packed ${Math.round(bytes.length / 1024)} KB, unpacked ${Math.round(out.length / 1024)} KB, ${ms} ms, rss before ${mb(before)} MB, peak ${mb(peak)} MB (+${mb(peak - before)}), after gc ${mb(steady)} MB (+${mb(steady - before)})`);
    process.exit(0);
}
const run = (m: string, env: Record<string, string> = {}) => Bun.spawnSync(['bun', import.meta.path, m], { stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: { ...process.env, ...env } }).stdout.toString();
const cache = join(tmpdir(), 'bunzip-memory-cache');
for (let i = 0; i < Number(process.argv[2] ?? 3); i++) {
    process.stdout.write(run('raw'));
    rmSync(cache, { recursive: true, force: true }); mkdirSync(cache, { recursive: true });
    process.stdout.write(run('cold', { BUNZIP_CACHE_DIR: cache }));
    process.stdout.write(run('warm', { BUNZIP_CACHE_DIR: cache }));
}
