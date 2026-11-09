import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { viewerBundle } from '../viewer';
import { hostedIndex, hostedScript, hostedStyle, nameHash } from './export-viewer';

test('the hosted viewer index loads relative files, the bridge first, and no service worker', () => {
    const html = hostedIndex('<!doctype html><html><head><script src="/coi-serviceworker.js"></script><link rel="icon" href="/favicon.ico"/><script defer="defer" src="/static/js/main.a8aba595.js"></script><link href="/static/css/main.4e43f3df.css" rel="stylesheet"></head></html>');
    expect(html).not.toContain('coi-serviceworker');
    expect(html).toContain('<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css">');
    expect(html).toContain('src="static/js/main.a8aba595.js"');expect(html).toContain('href="favicon.ico"');
    expect(() => hostedIndex('<head><script src="/other.js"></script>')).toThrow();
});
// The anchors of the pinned bundle, in one short text.
const BUNDLE = String.raw`x,n.p="/",y;de="/caches/";this.maxLevel=Tu.MAX_LEVELS-1;"number"===typeof t.scale&&t.scale>0&&(s.resolutionScale=t.scale)}setMaxLevel(e){const t=this.maxLevel!==e;this.maxLevel=e,t&&this.clearMaps()}maxLevel:this.maxLevel,e.maxLevel===this.maxLevel&&TE.FLOAT_VEC2,TE.FLOAT,TE.FLOAT,TE.FLOAT,TE.FLOAT,TE.FLOAT,TE.FLOAT]).set(10,this.mapViewer.isNewTextureAnim)float u_isNewTextureAnim;float(modelInfo.priority)) * 0.0007;\n    gl_Position = u_projectionMatrix * gl_Position;\n}II.create(ee||!J?1:te?2:4)const F=this.mapsToLoad.shift();F&&this.isValidMapData(F)&&this.loadMap(this.mainProgram,this.mainAlphaProgram,this.npcProgram,this.textureArray,this.textureMaterials,this.sceneUniformBuffer,F,a),t.maps=this.mapManager,t.canvas=this.canvas,isValidMapData(e){i&&Gc&&void 0!==this.followName&&this.followName.toLowerCase()!==e.toLowerCase()step(e,t,n){const r=Math.min(128,n)+32,old}cancel(){`;
test('the viewer patches keep squares across floors, use more workers and load only around the new account', () => {
    const main = viewerBundle(BUNDLE);
    expect(main).toContain('setMaxLevel(e){this.maxLevel=e}');expect(main).not.toContain('clearMaps');
    expect(main).toContain('II.create(ee?1:!J||te?2:4)');expect(main).toContain('float u_maxPlane;');expect(main).toContain('float(modelInfo.plane) > u_maxPlane');
    expect(main).toContain('this.warmStep(t)');expect(main).not.toContain('old}cancel');expect(main).not.toContain('prefetch(this.from');
    expect(() => viewerBundle(BUNDLE.replace('II.create', 'XX.create'))).toThrow('worker count');
});
test('the pinned bundle takes every viewer patch and still parses', () => {
    const file = join(import.meta.dir, '..', '..', '..', 'vendor', 'rs-world', 'build', 'static', 'js', 'main.a8aba595.js');
    if (!existsSync(file)) return; // the vendor build is only on the PC
    expect(() => new Function(viewerBundle(readFileSync(file, 'utf8')))).not.toThrow();
});
test('script public paths follow where the page and the worker are served; fonts stay beside the styles', () => {
    const main = hostedScript('main.a8aba595.js', BUNDLE);
    expect(main).toContain('n.p=new URL(".",document.baseURI).pathname,y;de=new URL("caches/",document.baseURI).pathname;');
    expect(main).toContain('(e=>e>=0&&e<=3?e:Tu.MAX_LEVELS-1)(parseInt(new URLSearchParams(location.search).get("ml")))');
    expect(main).toContain('s.setMaxLevel(t.maxLevel)');
    expect(() => hostedScript('main.a8aba595.js', 'n.p="/"')).toThrow();
    expect(hostedScript('956.a92c9ad3.chunk.js', '},i.p="/",')).toBe('},i.p=new URL("../../",self.location.href).pathname,');
    expect(hostedStyle('src:url(/static/media/RuneScape-Bold-12.ttf)')).toBe('src:url(../media/RuneScape-Bold-12.ttf)');
});
test('the name hash matches the bridge and ignores case', () => {
    expect(nameHash('HiddenActor')).toBe('afac05c6');expect(nameHash('hiddenactor')).toBe('afac05c6');
});
