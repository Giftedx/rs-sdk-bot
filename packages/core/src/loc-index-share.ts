import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

// The web client builds a world loc index (about 14 to 31 MB, read only; LocIndex.ts says it is meant to be shared) for
// each session start and each reconnect (lite/session.ts calls LocIndex.load at both). This keeps one index for each
// cache path and versionlist CRC in the process: the sessions of a host process share it, and a reconnect of one bot
// does not build a second copy. Only the newest key stays, so a game update does not keep the old index. The SDK
// file is unchanged; this wraps its static `load` once for the process.
export async function shareLocIndex(): Promise<void> {
    const mod: any = await import(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const L = mod.LocIndex;
    if (L.__hostShared) return;
    const orig = L.load.bind(L);
    const memo = new Map<string, Promise<unknown>>();
    L.load = (opts: { cacheDir: string; versionlistCrc: number }) => {
        const k = `${opts.cacheDir}|${opts.versionlistCrc >>> 0}`;
        const hit = memo.get(k);
        if (hit) return hit;
        const p: Promise<unknown> = orig(opts);
        for (const other of [...memo.keys()]) memo.delete(other);
        memo.set(k, p);
        p.catch(() => { if (memo.get(k) === p) memo.delete(k); });
        return p;
    };
    L.__hostShared = true;
}
