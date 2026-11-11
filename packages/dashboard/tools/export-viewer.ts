// Writes the reviewed rs-world 3D viewer build as static files for the hosted dashboard (rs-fleet-command site/), which
// GitHub Pages serves under a sub-path with no server: <out>/viewer/ (the build with every absolute path made relative
// to where it is served, the coi service worker left out, the private-name bridge and the client style added),
// <out>/viewer/caches/ (the rev 289 cache), <out>/api/hidden-names (the main account as a hash, never its name) and
// <out>/api/our-names (the fleet's accounts on every side, for gold nameplates).
// The viewer streams players from the public world feed itself and falls back to plain buffers without
// cross-origin isolation, so it needs no headers Pages cannot set.
// Usage: bun packages/dashboard/tools/export-viewer.ts <out dir> [rs-world dir] [fleet owners.json]
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { VIEWER_MANIFEST_SHA256, checkViewerBundle, once, viewerBridgeSource, viewerEntry } from '../viewer';
import { MAIN_ACCOUNT } from '../publish-relay';

// The same hash as the bridge (viewer.ts): FNV-1a over the lower-case name.
export function nameHash(name: string) {
    let h = 0x811c9dc5;
    for (const c of name.toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
}
// The viewer keeps its cache files in the browser (Cache API, one store per cache name), so only a first visit
// downloads them, and that download starts after the main script has loaded and run. This script starts it with
// the page. The viewer's own request for a file then takes the copy from the HTTP cache (Pages keeps a file for
// 10 minutes). A later visit finds the files in the store and this script fetches nothing.
export function earlyCacheScript(cacheName: string, files: string[]) {
    for (const name of [cacheName, ...files]) if (!/^[\w.-]+$/.test(name) || name.includes('..')) throw Error(`cache name or file has an unsafe character: ${name}`);
    return `<script>(async()=>{try{const b=new URL(${JSON.stringify(`caches/${cacheName}/`)},document.baseURI).pathname,c=await caches.open(${JSON.stringify(cacheName)});for(const f of ${JSON.stringify(files)})if(!await c.match(b+f))fetch(b+f).catch(()=>{})}catch{}})()</script>`;
}
export function hostedIndex(html: string, early = '') {
    html = once(html, /<script src="\/coi-serviceworker\.js"><\/script>/, '', 'coi service worker');
    html = html.replaceAll('href="/favicon.ico"', 'href="favicon.ico"').replaceAll('src="/static/', 'src="static/').replaceAll('href="/static/', 'href="static/');
    if (/(?:src|href)="\//.test(html)) throw Error('viewer index.html still has an absolute path');
    return once(html, '<head>', '<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css">' + early, 'head');
}
// The main bundle runs in the page (document), the worker chunk in a worker under static/js/. The build is made for
// the site root, so its public path and its cache path become relative to where each script runs. main is true for
// the entry script that asset-manifest.json names; that script must hold every feature the page drives.
export function hostedScript(main: boolean, text: string) {
    if (main) {
        text = once(text, /\b([A-Za-z_$][\w$]*)\.p="\/"/, '$1.p=new URL(".",document.baseURI).pathname', 'main public path');
        text = once(text, /\b([A-Za-z_$][\w$]*)="\/caches\/"/, '$1=new URL("caches/",document.baseURI).pathname', 'cache path');
        return checkViewerBundle(text);
    }
    return text.replace(/\b([a-zA-Z_$][\w$]*)\.p="\/"/g, '$1.p=new URL("../../",self.location.href).pathname');
}
export const hostedStyle = (text: string) => text.replaceAll('url(/static/media/', 'url(../media/');

export function exportViewer(out: string, world: string, ownersFile: string | null) {
    const build = join(world, 'build'), caches = join(world, 'caches');
    const manifest = readFileSync(join(build, 'asset-manifest.json'), 'utf8');
    if (createHash('sha256').update(manifest).digest('hex').toUpperCase() !== VIEWER_MANIFEST_SHA256) throw Error('the rs-world build is not the reviewed version (asset-manifest.json hash differs)');
    const mainName = viewerEntry(manifest).main.split('/').pop()!;
    const viewer = join(out, 'viewer');
    rmSync(viewer, { recursive: true, force: true });
    mkdirSync(viewer, { recursive: true });
    // With one cache in the list, that cache is the one the viewer loads; with more, the viewer chooses, so no early download.
    const cacheList: { name: string }[] = JSON.parse(readFileSync(join(caches, 'caches.json'), 'utf8'));
    const early = cacheList.length === 1 ? earlyCacheScript(cacheList[0]!.name, readdirSync(join(caches, cacheList[0]!.name)).filter(f => /^main_file_cache\.(?:dat|idx[0-4])$/.test(f)).sort()) : '';
    writeFileSync(join(viewer, 'index.html'), hostedIndex(readFileSync(join(build, 'index.html'), 'utf8'), early));
    for (const f of ['favicon.ico', 'favicon.png', 'robots.txt']) if (existsSync(join(build, f))) cpSync(join(build, f), join(viewer, f));
    cpSync(join(build, 'static'), join(viewer, 'static'), { recursive: true });
    for (const f of readdirSync(join(viewer, 'static', 'js')).filter(f => f.endsWith('.js'))) writeFileSync(join(viewer, 'static', 'js', f), hostedScript(f === mainName, readFileSync(join(viewer, 'static', 'js', f), 'utf8')));
    for (const f of readdirSync(join(viewer, 'static', 'css')).filter(f => f.endsWith('.css'))) writeFileSync(join(viewer, 'static', 'css', f), hostedStyle(readFileSync(join(viewer, 'static', 'css', f), 'utf8')));
    for (const f of readdirSync(join(viewer, 'static', 'js')).filter(f => f.endsWith('.map'))) rmSync(join(viewer, 'static', 'js', f));
    cpSync(caches, join(viewer, 'caches'), { recursive: true });
    writeFileSync(join(viewer, 'bridge.js'), viewerBridgeSource());
    cpSync(join(import.meta.dir, '..', 'client-viewer.css'), join(viewer, 'client-viewer.css'));
    mkdirSync(join(out, 'api'), { recursive: true });
    writeFileSync(join(out, 'api', 'hidden-names'), JSON.stringify([`h:${nameHash(MAIN_ACCOUNT)}`]));
    const owners = ownersFile && existsSync(ownersFile) ? Object.keys(JSON.parse(readFileSync(ownersFile, 'utf8')).accounts ?? {}) : [];
    writeFileSync(join(out, 'api', 'our-names'), JSON.stringify(owners.filter(n => n.toLowerCase() !== MAIN_ACCOUNT.toLowerCase()).sort()));
    return { viewer, names: owners.length };
}

if (import.meta.main) {
    const [outArg, worldArg, ownersArg] = process.argv.slice(2);
    if (!outArg) { console.error('usage: bun packages/dashboard/tools/export-viewer.ts <out dir> [rs-world dir] [fleet owners.json]'); process.exit(2); }
    const root = resolve(import.meta.dir, '..', '..', '..');
    const r = exportViewer(resolve(outArg), resolve(worldArg ?? join(root, 'vendor', 'rs-world')), ownersArg ? resolve(ownersArg) : join(root, 'fleet', 'owners.json'));
    console.log(`viewer written to ${r.viewer}; our-names lists ${r.names} accounts`);
}
