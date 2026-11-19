// Preloaded for every bun process in this repo (bunfig.toml), as collision-lazy.ts is. The web client unpacks its
// archives (interface.jag and others) with bunzip2 in vendor webclient io/BZip2.js, whose block reversal uses boxed
// arrays and a sort: one 80 KB archive costs about 100 MB of RSS that stays (scripts/measure/bunzip-memory.ts).
// This serves the same module with the vendor function renamed bunzip2Raw and a bunzip2 that keeps the unpacked bytes
// of each archive of 16 KiB or more in .practice/cache/bunzip, under the SHA-256 of the packed bytes and the flags.
// A later process reads the file (checked against its own SHA-256) and never runs the vendor function. Any cache
// fault runs the vendor function. The vendor file is unchanged.
import { plugin } from 'bun';
import { resolve } from 'node:path';

export const BUNZIP_MIN_BYTES = 16 * 1024;
export const BUNZIP_KEEP_FILES = 8;

export function cachedBunzipSource(original: string, dir: string): string {
    const raw = original.replace('export function bunzip2(', 'export function bunzip2Raw(');
    if (raw === original) throw Error('BZip2.js has no exported bunzip2');
    return `${raw}
import { createHash as __bzHash } from 'node:crypto';
import { existsSync as __bzExists, mkdirSync as __bzMkdir, readdirSync as __bzList, readFileSync as __bzRead, renameSync as __bzRename, statSync as __bzStat, unlinkSync as __bzUnlink, writeFileSync as __bzWrite } from 'node:fs';
const __bzSha = (...parts) => { const h = __bzHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
export function bunzip2(bytes, checkMagic = false, checkCRC = false) {
    if (bytes.length < ${BUNZIP_MIN_BYTES}) return bunzip2Raw(bytes, checkMagic, checkCRC);
    const dir = process.env.BUNZIP_CACHE_DIR || ${JSON.stringify(dir)};
    let file;
    try {
        file = dir + '/' + __bzSha(bytes, Buffer.from(checkMagic + ',' + checkCRC)).toString('hex') + '.bin';
        if (__bzExists(file)) {
            const stored = __bzRead(file);
            const body = stored.subarray(32);
            if (stored.length > 32 && __bzSha(body).equals(stored.subarray(0, 32))) return new Uint8Array(body);
        }
    } catch { /* an optional cache: unpack */ }
    const out = bunzip2Raw(bytes, checkMagic, checkCRC);
    try {
        if (file) {
            __bzMkdir(dir, { recursive: true });
            const temporary = file + '.' + process.pid + '.tmp';
            __bzWrite(temporary, Buffer.concat([__bzSha(out), out]));
            __bzRename(temporary, file);
            const files = __bzList(dir).filter(f => f.endsWith('.bin')).map(f => ({ f, at: __bzStat(dir + '/' + f).mtimeMs })).sort((a, b) => b.at - a.at);
            for (const old of files.slice(${BUNZIP_KEEP_FILES})) __bzUnlink(dir + '/' + old.f);
        }
    } catch { /* an optional cache */ }
    return out;
}
`;
}

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const CACHE_DIR = resolve(repoRoot, '.practice', 'cache', 'bunzip').replace(/\\/g, '/');

plugin({
    name: 'bunzip-cache',
    setup(build) {
        build.onLoad({ filter: /[\\/]webclient[\\/]src[\\/]io[\\/]BZip2\.js$/ }, async args => ({
            contents: cachedBunzipSource(await Bun.file(args.path).text(), CACHE_DIR), loader: 'js',
        }));
    },
});
