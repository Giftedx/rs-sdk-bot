import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { shareLocIndex } from '../src/loc-index-share';

test('LocIndex.load builds one index for each cache path and versionlist CRC, keeps only the newest key, and retries after a failure', async () => {
    const mod: any = await import(join(resolve(import.meta.dir, '..', '..', '..'), 'vendor', 'rs-sdk', 'server', 'webclient', 'src', 'lite', 'world', 'LocIndex.ts'));
    const L = mod.LocIndex, realLoad = L.load, realFlag = L.__hostShared;
    let builds = 0, failNext = false;
    L.load = async () => { builds++; if (failNext) { failNext = false; throw Error('fixture failure'); } return { built: builds }; };
    L.__hostShared = false;
    try {
        await shareLocIndex();
        const o = { cacheDir: '/cache', versionlistCrc: 7 };
        const a = await L.load(o), b = await L.load({ ...o });
        expect(b).toBe(a); // a reconnect gets the same index
        expect(builds).toBe(1);
        expect(await L.load({ cacheDir: '/cache', versionlistCrc: 8 })).not.toBe(a); // a game update builds a new one
        expect(builds).toBe(2);
        await L.load(o); // the old key was dropped, so it builds again
        expect(builds).toBe(3);
        failNext = true;
        await expect(L.load({ cacheDir: '/cache', versionlistCrc: 9 })).rejects.toThrow('fixture failure');
        await L.load({ cacheDir: '/cache', versionlistCrc: 9 }); // a failure is not kept
        expect(builds).toBe(5);
        await shareLocIndex(); // a second call does not wrap again
        await L.load({ cacheDir: '/cache', versionlistCrc: 9 });
        expect(builds).toBe(5);
    } finally { L.load = realLoad; L.__hostShared = realFlag; }
});
