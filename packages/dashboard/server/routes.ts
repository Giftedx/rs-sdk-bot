import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { isLoopback } from '../collection';
import { deathRecap } from '../death-recap';
import { createOperatorControl } from '../operator-control';
import { VIEWER_MANIFEST_SHA256, viewerAssetRoute, viewerBridgeSource, viewerEntry } from '../viewer';
import { lookupView } from '../world-view';
import { isLocalServer } from '../../core/src/localserver';
import { gameDialAddress } from '../../core/src/websocket-proxy';
import { dashboardDir, DEMO, getMapBytes, liveAccounts, MAIN, PAGE_FILE, remoteNames, root, SECRET_MARK, SECRET_RE } from './config';
import { gearCatalogResponse } from './market';
import { clients, current, FIRST_STATE_MAX_AGE_MS, getLatest, maybeScanProcs, scanProcs, viewerTimings } from './state';
import { lookupPlayer, recapCache, roster, world } from './world';

const operatorControl=createOperatorControl({root,readOnly:process.env.DASH_READ_ONLY==='1'});

// The page embeds the rs-world viewer (COEP require-corp); credentialless keeps Google Fonts loadable.
const ISO = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
// DASH_VIEWER_ROOT names another rs-world folder (build/ and caches/), for a server whose pin differs from the build in root.
const viewerRoot=resolve(process.env.DASH_VIEWER_ROOT??join(root,'vendor','rs-world')),viewerBuild=join(viewerRoot,'build'),viewerCaches=join(viewerRoot,'caches');
const VIEWER_ISO={...ISO,'Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin'};
const SHELL_ASSETS = new Set(['/map-shell.css', '/map-shell.js', '/client-shell.css', '/client-shell.js', '/client-viewer.css', '/operations.css', '/operations.js', '/xp-tracker.js']);
const LOOPBACK_ONLY_ROUTES = new Set(['/api/reveal', '/api/hidden-names', '/api/death-recap']);

let manifestCache: { mtimeMs: number; size: number; valid: boolean; entry: { main: string; css: string } | null } | null = null;
function viewerAvailable() {
    try {
        const manifestPath = join(viewerBuild, 'asset-manifest.json');
        const st = statSync(manifestPath);
        let parsed = manifestCache;
        if (!parsed || parsed.mtimeMs !== st.mtimeMs || parsed.size !== st.size) {
            const text = readFileSync(manifestPath, 'utf8');
            const valid = createHash('sha256').update(text).digest('hex').toUpperCase() === VIEWER_MANIFEST_SHA256;
            const entry = valid ? viewerEntry(text) : null;
            parsed = { mtimeMs: st.mtimeMs, size: st.size, valid, entry };
            manifestCache = parsed;
        }
        if (!parsed.valid || !parsed.entry) return false;
        return existsSync(join(viewerBuild, 'index.html')) && existsSync(join(viewerCaches, 'caches.json'))
            && existsSync(join(viewerBuild, parsed.entry.main.slice(1))) && existsSync(join(viewerBuild, parsed.entry.css.slice(1)));
    } catch { return false; }
}
let viewerIndexCache: { mtimeMs: number; size: number; standard: string; client: string } | null = null;
function viewerIndexHtml(clientMode: boolean): string {
    const indexPath = join(viewerBuild, 'index.html');
    const st = statSync(indexPath);
    if (!viewerIndexCache || viewerIndexCache.mtimeMs !== st.mtimeMs || viewerIndexCache.size !== st.size) {
        const base = readFileSync(indexPath, 'utf8').replace(/<script\s+src="\/coi-serviceworker\.js"><\/script>/, '');
        viewerIndexCache = {
            mtimeMs: st.mtimeMs,
            size: st.size,
            standard: base.replace('<head>', '<head><script src="/api/viewer-bridge.js"></script>'),
            client: base.replace('<head>', '<head><script src="/api/viewer-bridge.js"></script><link rel="stylesheet" href="/client-viewer.css">'),
        };
    }
    return clientMode ? viewerIndexCache.client : viewerIndexCache.standard;
}
function viewerAsset(pathname:string):Response|null {
    const route=viewerAssetRoute(pathname);
    if(route===null)return null;
    if(route==='bad')return new Response('bad viewer path',{status:400});
    const base=route.root==='static'?join(viewerBuild,'static'):viewerCaches;
    try {
        const realBase=realpathSync(base),file=realpathSync(resolve(base,route.relative));
        if(!file.startsWith(realBase+sep)||!statSync(file).isFile())return new Response('not found',{status:404});
        return new Response(Bun.file(file),{headers:{...VIEWER_ISO,'cache-control':route.root==='static'?'public,max-age=3600':'no-cache'}});
    }catch{return new Response('not found',{status:404});}
}

export function createFetchHandler() {
    return function fetch(req: Request, server: { requestIP: (req: Request) => { address: string } | null }) {
        const url = new URL(req.url);
        if(url.pathname==='/api/control')return operatorControl(req,server.requestIP(req)?.address??'').then(async response=>new Response((await response.text()).replace(SECRET_RE,SECRET_MARK),{status:response.status,headers:response.headers}));
        if(url.pathname==='/RUNELITE-LICENSE.txt')return new Response(Bun.file(join(dashboardDir,'RUNELITE-LICENSE.txt')),{headers:{'content-type':'text/plain;charset=utf-8'}});
        if(SHELL_ASSETS.has(url.pathname))return new Response(Bun.file(join(dashboardDir,url.pathname.slice(1))),{headers:{'content-type':url.pathname.endsWith('.css')?'text/css':'text/javascript','cache-control':'no-store'}});
        if(url.pathname.startsWith('/client-assets/')) {
            const name=url.pathname.slice('/client-assets/'.length);
            if(!['npc-names.json','item-stats.json','item-list.json','resources.json','multiway.json','skill-actions.json','pk-kits.json','agility.json','npc-spawns.json','npc-hunt.json','map-icons.json','item-sources.json','npc-drops.json','item-bonuses.json','spellbook.json','quest-rewards.json','item-alch.json','cooking.json','quest-reqs.json','thieving.json','gather-chance.json','runecraft.json','npc-defence.json','npc-loot.json','weapon-speed.json'].includes(name)&&!/^[a-zA-Z0-9_-]+\.(png|ttf|txt)$/.test(name))return new Response('Invalid asset',{status:400});
            const file=Bun.file(join(dashboardDir,'client-assets',name));
            // A data file changes with each page round (a new field, a new skill); the browser asks again each time and
            // gets a 304 when it is the same (a weak ETag of its size and time). Images and fonts keep the hour.
            if(!name.endsWith('.json'))return new Response(file,{headers:{'cache-control':'public,max-age=3600'}});
            const tag=`W/"${file.size.toString(36)}-${Math.floor(file.lastModified).toString(36)}"`;
            if(req.headers.get('if-none-match')===tag)return new Response(null,{status:304,headers:{etag:tag,'cache-control':'no-cache'}});
            return new Response(file,{headers:{etag:tag,'cache-control':'no-cache'}});
        }
        if (url.pathname === '/api/player') {
            const name = url.searchParams.get('name') ?? '';
            if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name)) return Response.json({ error: 'a player name is 1-12 letters, digits, spaces, - or _' }, { status: 400 });
            if (name.replace(/[ _-]/g, '').toLowerCase().includes(MAIN.toLowerCase())) return Response.json({ error: 'not available' }, { status: 404 });
            return lookupPlayer(name).then(hit => hit ? Response.json(lookupView(name, hit.rows, hit.at, roster.get(name.toLowerCase()), Date.now(), hit.worn, hit.wornAt, world.connected ? world.tickAt : null)) : Response.json({error:'Player service unavailable; try again'},{status:502}));
        }
        if (url.pathname === '/api/viewer-health') {const available=viewerAvailable();return Response.json({available,url:'/viewer/?live='+encodeURIComponent(gameDialAddress(DEMO.replace(/^http/,'ws')+'/worldfeed')),reason:available?null:'Reviewed 3D viewer assets/cache are unavailable or the build version is unsupported; 2D remains available.'},{headers:{'cache-control':'no-store'}});}
        if(url.pathname==='/api/viewer-bridge.js')return viewerAvailable()?new Response(viewerBridgeSource(),{headers:{...VIEWER_ISO,'content-type':'text/javascript;charset=utf-8','cache-control':'no-store'}}):new Response('Unsupported viewer build',{status:503});
        if(url.pathname==='/viewer'||url.pathname==='/viewer/') {
            if(!viewerAvailable())return new Response('3D viewer assets unavailable',{status:503});
            // Native isolation headers replace this root-scoped service worker;
            // the viewer must not install a worker over the dashboard itself.
            return new Response(viewerIndexHtml(url.searchParams.get('client')==='1'),{headers:{...VIEWER_ISO,'content-type':'text/html;charset=utf-8','cache-control':'no-store'}});
        }
        const asset=viewerAsset(url.pathname);if(asset)return asset;
        // The page relays the 3D viewer's follow-change timings (time until the destination is loaded).
        if (url.pathname === '/api/viewer-timing' && req.method === 'POST') {
            return req.json().then((t: any) => {
                if (t && Number.isFinite(t.ms)) { viewerTimings.unshift({ at: Date.now(), mode: String(t.mode).slice(0, 24), ms: t.ms, tiles: Number(t.tiles) || 0, frames: Number(t.frames) || 0, blankFrames: Number(t.blankFrames) || 0, holdFrames: Number(t.holdFrames) || 0 }); viewerTimings.length = Math.min(viewerTimings.length, 40); }
                return new Response('ok');
            }).catch(() => new Response('bad', { status: 400 }));
        }
        if (url.pathname === '/api/state') maybeScanProcs();
        if (url.pathname === '/api/state') return new Response(current(), { headers: { 'content-type': 'application/json' } });
        // The 3D viewer (localhost:3000) fetches the names whose nameplates it must hide, so the dashboard page
        // never holds the name: the iframe URL carries only this endpoint.
        // Our live accounts, for the viewer's gold nameplates (the main account stays hidden, not highlighted).
        if (url.pathname === '/api/our-names') return Response.json([...new Set([...liveAccounts(), ...remoteNames()])].filter(n => n.toLowerCase() !== MAIN.toLowerCase()), { headers: { 'access-control-allow-origin': 'http://localhost:3000', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' } });
        if (LOOPBACK_ONLY_ROUTES.has(url.pathname) && !isLoopback(server.requestIP(req)?.address ?? '')) return new Response('forbidden', { status: 403 });
        // Death recap: the newest death in the account's tick records, read when the page asks, kept for 30 s.
        if (url.pathname === '/api/death-recap') {
            const name = url.searchParams.get('name') ?? '';
            if (!/^[A-Za-z0-9_ -]{1,12}$/.test(name) || name.replace(/[ _-]/g, '').toLowerCase().includes(MAIN.toLowerCase())) return Response.json({ error: 'not available' }, { status: 404 });
            const key = name.toLowerCase(), hit = recapCache.get(key);
            if (hit && Date.now() - hit.at < 30_000) return Response.json({ recap: hit.recap });
            const recap = deathRecap(root, name, 8, srv => isLocalServer(srv) ? null : world.tickMs);
            recapCache.set(key, { at: Date.now(), recap });
            return Response.json({ recap });
        }
        if (url.pathname === '/api/hidden-names') return Response.json([MAIN], { headers: { 'access-control-allow-origin': 'http://localhost:3000', 'cross-origin-resource-policy': 'cross-origin', 'cache-control': 'no-store' } });
        // The server may listen on every address (DASH_HOST); only this PC may read the main account's name.

        if (url.pathname === '/api/reveal') return new Response(MAIN, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
        if (url.pathname === '/api/gear-catalog') {
            const { body, tag } = gearCatalogResponse();
            if (req.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers: { etag: tag, 'cache-control': 'no-cache' } });
            return new Response(body, { headers: { 'content-type': 'application/json', etag: tag, 'cache-control': 'no-cache' } });
        }
        const mapBytes = getMapBytes();
        if (url.pathname === '/api/map') return mapBytes ? new Response(mapBytes, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('building', { status: 503 });
        if (url.pathname === '/events') {
            let me: ReadableStreamDefaultController;
            const latest = getLatest();
            const stream = new ReadableStream({
                start(c) { me = c; clients.add(c); if (clients.size === 1) void scanProcs(); c.enqueue(`data: ${latest.json && Date.now() - latest.at < FIRST_STATE_MAX_AGE_MS ? latest.json : current()}\n\n`); },
                cancel() { clients.delete(me); },
            });
            return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
        }
        if (url.pathname === '/items.png') return new Response(Bun.file(join(dashboardDir, 'items.png')), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } });
        if (/^\/map-squares\/\d{1,3}_\d{1,3}\.png$/.test(url.pathname)) { const file = join(dashboardDir, 'map-squares', url.pathname.slice(13)); return existsSync(file) ? new Response(Bun.file(file), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }) : new Response('no square', { status: 404 }); }
        // The game's map art (packages/dashboard/tools/export-world-map.ts); absent, the page keeps the collision map.
        if (url.pathname === '/worldmap.png') { const file = join(dashboardDir, 'worldmap.png'); return existsSync(file) ? new Response(Bun.file(file), { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }) : new Response('no world map', { status: 404 }); }
        if (url.pathname === '/' || url.pathname === '/index.html') return new Response(Bun.file(PAGE_FILE), { headers: { ...ISO, 'content-type': 'text/html;charset=utf-8' } });
        return new Response('not found', { status: 404 });
    };
}
