import { expect, test } from 'bun:test';
import { hostedIndex, hostedScript, hostedStyle, nameHash } from './export-viewer';

test('the hosted viewer index loads relative files, the bridge first, and no service worker', () => {
    const html = hostedIndex('<!doctype html><html><head><script src="/coi-serviceworker.js"></script><link rel="icon" href="/favicon.ico"/><script defer="defer" src="/static/js/main.a8aba595.js"></script><link href="/static/css/main.4e43f3df.css" rel="stylesheet"></head></html>');
    expect(html).not.toContain('coi-serviceworker');
    expect(html).toContain('<head><script src="bridge.js"></script><link rel="stylesheet" href="client-viewer.css">');
    expect(html).toContain('src="static/js/main.a8aba595.js"');expect(html).toContain('href="favicon.ico"');
    expect(() => hostedIndex('<head><script src="/other.js"></script>')).toThrow();
});
test('script public paths follow where the page and the worker are served; fonts stay beside the styles', () => {
    const main = hostedScript('main.a8aba595.js', 'x,n.p="/",y;de="/caches/";this.maxLevel=Tu.MAX_LEVELS-1;"number"===typeof t.scale&&t.scale>0&&(s.resolutionScale=t.scale)}');
    expect(main).toContain('n.p=new URL(".",document.baseURI).pathname,y;de=new URL("caches/",document.baseURI).pathname;');
    expect(main).toContain('(e=>e>=0&&e<=3?e:Tu.MAX_LEVELS-1)(parseInt(new URLSearchParams(location.search).get("ml")))');
    expect(main).toContain('s.setMaxLevel(t.maxLevel)}');
    expect(() => hostedScript('main.a8aba595.js', 'n.p="/"')).toThrow();
    expect(hostedScript('956.a92c9ad3.chunk.js', '},i.p="/",')).toBe('},i.p=new URL("../../",self.location.href).pathname,');
    expect(hostedStyle('src:url(/static/media/RuneScape-Bold-12.ttf)')).toBe('src:url(../media/RuneScape-Bold-12.ttf)');
});
test('the name hash matches the bridge and ignores case', () => {
    expect(nameHash('HiddenActor')).toBe('afac05c6');expect(nameHash('hiddenactor')).toBe('afac05c6');
});
