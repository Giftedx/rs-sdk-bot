import { test, expect } from 'bun:test';
import { closeWithin, settle, sessionDied, watchUnexpectedEnd } from '../src/bot';

test('an unexpected ended session settles a worker even when its script is waiting for ticks',async()=>{
    let end!:(v:{reason:string})=>void;const ended=new Promise<{reason:string}>(r=>{end=r;});
    const calls:string[]=[];
    watchUnexpectedEnd({ended},()=>false,()=>false,async detail=>{calls.push(detail);});
    end({reason:'logged-out'});await Promise.resolve();await Promise.resolve();
    expect(calls).toEqual(['session ended: logged-out']);
});
test('normal settlement and an explicit stop do not become transient disconnect failures',async()=>{
    for(const [settling,stopping]of [[true,false],[false,true]]){
        let calls=0;watchUnexpectedEnd({ended:Promise.resolve({reason:'logged-out'})},()=>settling!,()=>stopping!,async()=>{calls++;});
        await Promise.resolve();await Promise.resolve();expect(calls).toBe(0);
    }
});

test('death detection uses actual death/life state, not legal travel or missing HP',()=>{
    const initial={lifeId:4,respawnCount:0};
    expect(sessionDied(initial,{lifeId:4,respawnCount:0,worldX:9999})).toBe(false);
    expect(sessionDied(initial,{lifeId:4,respawnCount:0,isDead:true})).toBe(true);
    expect(sessionDied(initial,{lifeId:5,respawnCount:1})).toBe(true);
    expect(sessionDied(initial,undefined)).toBe(false);
});

test('concurrent stop and script cleanup share one logout and final result', async () => {
    let clicks = 0, closes = 0;
    let end!: (v: { reason: string }) => void;
    const lines: string[] = [];
    const session: any = {
        name: 'test', ended: new Promise(r => { end = r; }),
        direct: async () => { clicks++; end({ reason: 'logged-out' }); return { success: true }; },
        close: async () => { closes++; },
    };
    const a = settle([session], false, 'stop file', { log: l => lines.push(l) });
    const b = settle([session], true, 'script returned', { log: l => lines.push(l) });
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(clicks).toBe(1);
    expect(closes).toBe(1);
    expect(lines.filter(l => l.startsWith('RESULT'))).toEqual(['RESULT fail stop file']);
});

test('closeWithin returns after its limit even if a session close never finishes', async () => {
    const stuck = { close: () => new Promise<void>(() => {}) };
    const fine = { close: async () => {} };
    const t0 = Date.now();
    const r = await closeWithin([stuck as any, fine as any], 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ closed: 1, timedOut: 1 });
});

test('serverFromEnv uses SERVER from bot.env, and the local practice server when it is empty or local', async () => {
    const { serverFromEnv } = await import('../src/bot');
    expect(serverFromEnv('BOT_USERNAME=a\nSERVER=rs-sdk-demo.fly.dev\n')).toBe('rs-sdk-demo.fly.dev');
    expect(serverFromEnv('SERVER=localhost:8888\n')).toBe('localhost:8888');
    expect(serverFromEnv('SERVER=\n')).toBe('localhost:8888');
    expect(serverFromEnv('BOT_USERNAME=a\n')).toBe('localhost:8888');
});

test('a non-local server is refused unless DEMO_OK=1 is set on purpose', async () => {
    const { assertServerAllowed } = await import('../src/bot');
    expect(() => assertServerAllowed('localhost:8888', {})).not.toThrow();
    expect(() => assertServerAllowed('rs-sdk-demo.fly.dev', {})).toThrow(/DEMO_OK/);
    // A prefix match once let these through: they look local but resolve anywhere.
    expect(() => assertServerAllowed('localhost.example.com:443', {})).toThrow(/DEMO_OK/);
    expect(() => assertServerAllowed('127.evil.io', {})).toThrow(/DEMO_OK/);
    expect(() => assertServerAllowed('rs-sdk-demo.fly.dev', { DEMO_OK: '1' })).not.toThrow();
});

test('a death is judged on life fields copied while connected, not on the state after a disconnect', () => {
    const born = { isDead: false, respawnCount: 0, lifeId: 7 };
    expect(sessionDied(born, { ...born })).toBe(false);
    expect(sessionDied(born, { ...born, lifeId: 8 })).toBe(true);
});
