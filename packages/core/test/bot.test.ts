import { test, expect } from 'bun:test';
import { attachTickStallWatch, botWork, closeWithin, releaseLine, settle, sessionDied, watchUnexpectedEnd } from '../src/bot';

test('explicit composed work arguments do not change complete recorded CLI arguments',()=>{
    const argv=['Donor','Receiver','90:Iron arrowtips','--notes'],env={HANDOFF_ORDER:'record-cli-order',PROGRESSION_CONSUMER:'{"bank":{"40":90}}'};
    for(const name of ['Donor','Receiver']){
        const record={script:'scripts/handoff-inputs.ts',argv:[...argv],workArgs:[...argv],env};
        const work=botWork(name,record,['bun','wrong-entry.ts','Wrong'],{});
        expect(work).toEqual({script:record.script,args:argv,env});
        expect(record.argv).toEqual(argv);
        expect(work.args).not.toBe(record.workArgs);
    }
});

test('record normalization preserves hosted and standalone single-account argument behavior',()=>{
    const argv=['Bigchopper','--headless-order','135','14'],env={CAP:'1600'};
    expect(botWork('Bigchopper',{script:'scripts/handoff-inputs.ts',argv,env})).toEqual({script:'scripts/handoff-inputs.ts',args:argv.slice(1),env});
    expect(botWork('Worker',undefined,['bun','scripts/cannon-fight.ts','worker','STOP=99','STOP_LEVEL=99'],env)).toEqual({script:'scripts/cannon-fight.ts',args:['STOP=99','STOP_LEVEL=99'],env});
    expect(botWork('Worker',{script:'scripts/fixture.ts',argv:['TARGET=5'],workArgs:[],env}).args).toEqual([]);
    expect(botWork('Worker',{script:'scripts/fixture.ts',argv:['TARGET=5'],env}).args).toEqual(['TARGET=5']);
    expect(argv).toEqual(['Bigchopper','--headless-order','135','14']);
});

test('the RELEASE line names the first 12 hex of the worker release, or unpinned', () => {
    expect(releaseLine('ABCDEF0123456789abcdef')).toBe('RELEASE abcdef012345');
    expect(releaseLine(undefined)).toBe('RELEASE unpinned');
    expect(releaseLine('not a hash')).toBe('RELEASE unpinned');
});

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

test('tick-stall watch disarms on closeWithin and ended so closed relog sessions never stop active work', async () => {
    let endA!: (v: { reason: string }) => void;
    let endB!: (v: { reason: string }) => void;
    const stalledCalls: string[] = [];
    const sessA: any = { onTick: () => () => {}, ended: new Promise(r => { endA = r; }), close: async () => {} };
    const sessB: any = { onTick: () => () => {}, ended: new Promise(r => { endB = r; }), close: async () => {} };
    attachTickStallWatch(sessA, r => stalledCalls.push(`A:${r}`), { ms: 40, every: 10 });
    attachTickStallWatch(sessB, r => stalledCalls.push(`B:${r}`), { ms: 40, every: 10 });
    await closeWithin([sessA], 200);
    endB({ reason: 'logged-out' });
    await Bun.sleep(90);
    endA({ reason: 'logged-out' });
    expect(stalledCalls).toEqual([]);
});
