import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const html = readFileSync(import.meta.dir + '/index.html', 'utf8');
const code = html.slice(html.indexOf('const VIEWER_RETRY_MS='), html.indexOf('async function request3D(){'));
function page(bots: any[] = []) {
    const timers: { fn: () => void; ms: number }[] = [], listeners: (() => void)[] = [], document: any = { hidden: false, addEventListener: (_: string, fn: () => void) => listeners.push(fn) };
    const box = { removeAttribute() {} };
    const api = new Function('document', 'setTimeout', 'clearTimeout', '$', 'S', 'sel', `let VIEWER={state:'loading',detail:''},VIEWER_TIMER,VIEWER_REQUEST=1,rswFor=null,mode='3d',requests=0;
        const setMode=m=>{mode=m},request3D=()=>{requests++;VIEWER={...VIEWER,state:'loading'};mode='3d'};${code};
        return {unavailable:viewerUnavailable,arm:armViewerTimer,state:()=>VIEWER,requests:()=>requests};`)(document, (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; }, () => {}, () => box, { bots }, 'Bob');
    return { ...api, timers, document, show() { document.hidden = false; for (const fn of listeners) fn(); } };
}

test('a hidden page keeps waiting for the scene instead of giving up on 3D', () => {
    const p = page();
    p.arm(1);
    p.document.hidden = true;
    p.timers.at(-1)!.fn();
    expect(p.state().state).toBe('loading');
    expect(p.timers).toHaveLength(2);
    p.document.hidden = false;
    p.timers.at(-1)!.fn();
    expect(p.state().detail).toContain('scene readiness timed out');
});
test('a failed 3D view tries three times, and a hidden page waits to come back first', () => {
    const p = page();
    p.unavailable('lost');
    expect(p.state().detail).toBe('lost · trying again');
    p.document.hidden = true;
    p.timers.at(-1)!.fn();
    expect(p.requests()).toBe(0);
    p.show();
    expect(p.requests()).toBe(1);
    for (const ms of [30000, 120000]) {
        p.unavailable('lost');
        expect(p.timers.at(-1)!.ms).toBe(ms);
        p.timers.at(-1)!.fn();
    }
    expect(p.requests()).toBe(3);
    p.unavailable('lost');
    expect(p.state().detail).toBe('lost');
});
test('a practice account does not retry the live-only 3D view', () => {
    const p = page([{ name: 'Bob', practice: true }]);
    p.unavailable('Practice observations use the 2D map.');
    expect(p.timers).toHaveLength(0);
});
