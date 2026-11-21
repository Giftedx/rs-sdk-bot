import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { VIEWER_FEATURES, VIEWER_MANIFEST_SHA256, checkViewerBundle, viewerEntry } from '../viewer';
import { earlyCacheScript, hostedIndex, hostedScript, hostedStyle, nameHash } from './export-viewer';

test('the hosted viewer index loads relative files, the bridge first, and no service worker', () => {
    const html = hostedIndex('<!doctype html><html><head><script src="/coi-serviceworker.js"></script><link rel="icon" href="/favicon.ico"/><script defer="defer" src="/static/js/main.0123abcd.js"></script><link href="/static/css/main.4567cdef.css" rel="stylesheet"></head></html>');
    expect(html).not.toContain('coi-serviceworker');
    expect(html).toContain('<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css">');
    expect(html).toContain('src="static/js/main.0123abcd.js"');expect(html).toContain('href="favicon.ico"');
    expect(() => hostedIndex('<head><script src="/other.js"></script>')).toThrow();
});
test('the early cache script follows the bridge, fetches only files the browser store lacks, and refuses unsafe names', async () => {
    const script = earlyCacheScript('rs-sdk-289', ['main_file_cache.dat', 'main_file_cache.idx0']);
    const html = hostedIndex('<!doctype html><html><head><script src="/coi-serviceworker.js"></script><script defer="defer" src="/static/js/main.0123abcd.js"></script></head></html>', script);
    expect(html).toContain('<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css"><script>(async()=>');
    expect(() => earlyCacheScript('a"b', [])).toThrow('unsafe');
    expect(() => earlyCacheScript('ok', ['../x'])).toThrow('unsafe');
    // Run the script body with a store that already holds the .dat file: only the index file is fetched.
    const prevPrefetch = (globalThis as any).__atlasCachePrefetch;
    try {
        delete (globalThis as any).__atlasCachePrefetch;
        const fetched: string[] = [], opened: string[] = [], stored: string[] = [];
        const body = script.slice('<script>'.length, -'</script>'.length);
        const run = new Function('document', 'caches', 'fetch', `return ${body}`);
        await run(
            { baseURI: 'https://example.test/site/viewer/' },
            { open: async (n: string) => { opened.push(n); return { match: async (u: string) => u.endsWith('.dat') ? {} : undefined, put: async (u: string) => { stored.push(u); } }; } },
            (u: string) => { fetched.push(u); return Promise.resolve({ ok: true, status: 200, headers: new Headers() }); }
        );
        expect(opened).toEqual(['rs-sdk-289']);
        expect(fetched).toEqual(['/site/viewer/caches/rs-sdk-289/main_file_cache.idx0']);
        await Promise.all([...(globalThis as any).__atlasCachePrefetch.files.values()]);
        expect(stored).toEqual(['/site/viewer/caches/rs-sdk-289/main_file_cache.idx0']);

        // Shared __atlasCachePrefetch suppresses duplicate fetches across reloads or parent shim prefetch.
        fetched.length = 0; stored.length = 0;
        await run(
            { baseURI: 'https://example.test/site/viewer/' },
            { open: async () => ({ match: async (u: string) => u.endsWith('.dat') ? {} : undefined, put: async (u: string) => { stored.push(u); } }) },
            (u: string) => { fetched.push(u); return Promise.resolve({ ok: true, status: 200, headers: new Headers() }); }
        );
        expect(fetched).toEqual([]);
        expect(stored).toEqual([]);

        // A sibling in-flight entry already registered in __atlasCachePrefetch.files is skipped even on a cold cache.
        (globalThis as any).__atlasCachePrefetch.files.set('/site/viewer/caches/rs-sdk-289/main_file_cache.dat', Promise.resolve(true));
        fetched.length = 0; stored.length = 0;
        await run(
            { baseURI: 'https://example.test/site/viewer/' },
            { open: async () => ({ match: async () => undefined, put: async (u: string) => { stored.push(u); } }) },
            (u: string) => { fetched.push(u); return Promise.resolve({ ok: true, status: 200, headers: new Headers() }); }
        );
        expect(fetched).toEqual([]);
        expect(stored).toEqual([]);

        // Partial (206 / Content-Range) responses are neither stored nor retained in files so CacheFiles.ts can resume them.
        (globalThis as any).__atlasCachePrefetch.files.clear();
        fetched.length = 0; stored.length = 0;
        let finishFetch!: (r: unknown) => void;
        const pendingFetch = new Promise(resolve => { finishFetch = resolve; });
        await run(
            { baseURI: 'https://example.test/site/viewer/' },
            { open: async () => ({ match: async () => undefined, put: async (u: string) => { stored.push(u); } }) },
            (u: string) => { fetched.push(u); return pendingFetch; }
        );
        expect((globalThis as any).__atlasCachePrefetch.files.size).toBe(2);
        finishFetch({ ok: true, status: 206, headers: new Headers({ 'Content-Range': 'bytes 0-10/20' }) });
        const partialResults = await Promise.all([...(globalThis as any).__atlasCachePrefetch.files.values()]);
        expect(partialResults).toEqual([false, false]);
        expect(fetched).toEqual(['/site/viewer/caches/rs-sdk-289/main_file_cache.dat', '/site/viewer/caches/rs-sdk-289/main_file_cache.idx0']);
        expect(stored).toEqual([]);
        expect((globalThis as any).__atlasCachePrefetch.files.size).toBe(0);

        // Cross-realm parent Map (as when shim.js runs in window.parent) is recognized by duck-typing and reused cleanly.
        const ParentMap = vm.runInNewContext('Map') as typeof Map;
        const crossFiles = new ParentMap<string, Promise<boolean>>([
            ['/site/viewer/caches/rs-sdk-289/main_file_cache.dat', Promise.resolve(true)],
            ['/site/viewer/caches/rs-sdk-289/main_file_cache.idx0', Promise.resolve(true)],
        ]);
        expect(crossFiles instanceof Map).toBe(false);
        fetched.length = 0; stored.length = 0;
        const iframeGlobal: any = {
            parent: { __atlasCachePrefetch: { ready: Promise.resolve(), files: crossFiles } },
            document: { baseURI: 'https://example.test/site/viewer/' },
            caches: { open: async () => ({ match: async () => undefined, put: async (u: string) => { stored.push(u); } }) },
            fetch: (u: string) => { fetched.push(u); return Promise.resolve({ ok: true, status: 200, headers: new Headers() }); },
            URL, Promise, Map,
        };
        await vm.runInNewContext(body, iframeGlobal);
        expect(iframeGlobal.__atlasCachePrefetch.files).toBe(crossFiles);
        expect(fetched).toEqual([]);
        expect(stored).toEqual([]);
    } finally {
        if (prevPrefetch === undefined) delete (globalThis as any).__atlasCachePrefetch;
        else (globalThis as any).__atlasCachePrefetch = prevPrefetch;
    }
});
// A main bundle in one short text: its two root paths and every feature the page drives.
const BUNDLE = 'x,n.p="/",y;const de="/caches/";' + VIEWER_FEATURES.map(f => f[1]).join(';');
test('a build without a feature the page drives stops the export, and the check names the feature', () => {
    expect(checkViewerBundle(BUNDLE)).toBe(BUNDLE);
    for (const [what, text] of VIEWER_FEATURES) expect(() => checkViewerBundle(BUNDLE.replace(text, ''))).toThrow(what);
    expect(() => hostedScript(true, BUNDLE.replace('u_maxPlane', 'u_other'))).toThrow('floor limit in the shader');
    expect(() => hostedScript(true, BUNDLE.replace('setWarmTiles(', ''))).toThrow('prewarm message');
});
test('the entry names come from the build manifest', () => {
    expect(viewerEntry('{"files":{"main.js":"/static/js/main.0123abcd.js","main.css":"/static/css/main.4567cdef.css"}}')).toEqual({ main: '/static/js/main.0123abcd.js', css: '/static/css/main.4567cdef.css' });
    for (const bad of ['{}', '{"files":{"main.js":"/static/js/../x.js","main.css":"/static/css/a.css"}}', '{"files":{"main.js":"/other/main.js","main.css":"/static/css/a.css"}}'])
        expect(() => viewerEntry(bad)).toThrow();
});
// RS_WORLD_DIR names another rs-world checkout; the default is the one the dashboard serves.
test('the reviewed build holds every feature, takes the hosted paths and still parses', () => {
    const build = join(process.env.RS_WORLD_DIR ?? join(import.meta.dir, '..', '..', '..', 'vendor', 'rs-world'), 'build');
    if (!existsSync(join(build, 'asset-manifest.json'))) return; // the build is only on the PC
    const manifest = readFileSync(join(build, 'asset-manifest.json'), 'utf8');
    if (createHash('sha256').update(manifest).digest('hex').toUpperCase() !== VIEWER_MANIFEST_SHA256) return; // another build: the server refuses it
    const main = hostedScript(true, readFileSync(join(build, viewerEntry(manifest).main.slice(1)), 'utf8'));
    expect(() => new Function(main)).not.toThrow();
    expect(main).not.toMatch(/="\/caches\/"|\.p="\/"/);
});
test('script public paths follow where the page and the worker are served; fonts stay beside the styles', () => {
    const main = hostedScript(true, BUNDLE);
    expect(main).toStartWith('x,n.p=new URL(".",document.baseURI).pathname,y;const de=new URL("caches/",document.baseURI).pathname;');
    expect(hostedScript(true, BUNDLE.replace('n.p=', 'r.p=').replace('de=', 'ue='))).toStartWith('x,r.p=new URL(".",document.baseURI).pathname,y;const ue=new URL("caches/",document.baseURI).pathname;');
    expect(() => hostedScript(true, 'n.p="/"')).toThrow('cache path');
    expect(() => hostedScript(true, BUNDLE + ';n.p="/"')).toThrow('main public path');
    expect(hostedScript(false, '},i.p="/",')).toBe('},i.p=new URL("../../",self.location.href).pathname,');
    expect(hostedStyle('src:url(/static/media/RuneScape-Bold-12.ttf)')).toBe('src:url(../media/RuneScape-Bold-12.ttf)');
});
test('the name hash matches the bridge and ignores case', () => {
    expect(nameHash('HiddenActor')).toBe('afac05c6');expect(nameHash('hiddenactor')).toBe('afac05c6');
});
