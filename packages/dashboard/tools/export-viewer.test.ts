import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VIEWER_FEATURES, VIEWER_MANIFEST_SHA256, checkViewerBundle, viewerEntry } from '../viewer';
import { hostedIndex, hostedScript, hostedStyle, nameHash } from './export-viewer';

test('the hosted viewer index loads relative files, the bridge first, and no service worker', () => {
    const html = hostedIndex('<!doctype html><html><head><script src="/coi-serviceworker.js"></script><link rel="icon" href="/favicon.ico"/><script defer="defer" src="/static/js/main.0123abcd.js"></script><link href="/static/css/main.4567cdef.css" rel="stylesheet"></head></html>');
    expect(html).not.toContain('coi-serviceworker');
    expect(html).toContain('<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css">');
    expect(html).toContain('src="static/js/main.0123abcd.js"');expect(html).toContain('href="favicon.ico"');
    expect(() => hostedIndex('<head><script src="/other.js"></script>')).toThrow();
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
