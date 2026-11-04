import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { startInProcessSession, connectInProcess, type Session } from '../src/inprocess';
import { watchUnexpectedEnd, logoutSession, awaitBotReady, settle } from '../src/bot';
import { beginSessionAttempt, readLogoutProof, listAttempts, accountDir, DEFAULT_LIFECYCLE_ROOT,lifecycleOwner } from '../src/session-lifecycle';

test('producer script identity comes from the actual CLI entry, never a descriptive goal',()=>{
 const repo=resolve(import.meta.dir,'../../..'),env={BOT_GOAL:'scripts/gather-fire-combat.ts',WORKER_RELEASE:'a'.repeat(64)};
 expect(lifecycleOwner(env,['bun',join(repo,'scripts/shark-supply.ts'),'Rod']).script).toBe('scripts/shark-supply.ts');
 expect(lifecycleOwner(env,['bun',join(repo,'packages/core/src/host.ts'),'--stagger-ms','0',join(repo,'scripts/shark-supply.ts'),'Rod']).script).toBe('scripts/shark-supply.ts');
 expect(lifecycleOwner(env,['bun',join(repo,'packages/core/src/host.ts'),join(repo,'scripts/shark-supply.ts'),'Rod','--stagger-ms','2000']).script).toBe('scripts/shark-supply.ts');
 expect(lifecycleOwner(env,['bun',join(repo,'packages/core/src/host.ts'),'--stagger-ms']).script).toBe('');
 expect(lifecycleOwner(env,['bun',join(repo,'packages/core/src/host.ts'),'--unknown','scripts/shark-supply.ts','Rod']).script).toBe('');
 expect(lifecycleOwner(env,['bun',join(tmpdir(),'foreign-worker.ts')]).script).toBe('');
 expect(lifecycleOwner(env,['bun','-e','anything']).script).toBe('');
});

// Bounded local multi-session component scenario. A fake lite session stands in for the network; the lifecycle
// producer, readiness, logout and settle code are the real core modules. Receipts go to a test-owned root.
const SECRET = 'fixture-pass-7Q';
const owner = { pid: 1, coordinatorRunId: 'run-test', workerRelease: 'rel', script: 'shark-supply.ts', role: null, participants: ['Ana', 'Bob'] };
type Behaviour = { fail?: boolean; endDuringStart?: string; logoutEnds?: string };
function fakeStart(b: Behaviour, calls: string[]) {
    return async (o: any) => {
        calls.push(o.username);
        if (b.fail) throw new Error(`login refused for ${o.username} with ${o.password}`);
        let tick: (() => void) | null = null, resolveStopped!: (v: unknown) => void, done = false;
        const stopped = new Promise(r => { resolveStopped = r; });
        const end = (reason: string) => { if (done) return; done = true; o.onEnd({ reason }); resolveStopped({ reason }); };
        const client: any = {
            collectBotState: (t: number) => ({ tick: t, inGame: true, player: { worldX: 2809, worldZ: 3441, level: 0 }, skills: [{ name: 'Hitpoints', level: 43, baseLevel: 43 }], inventory: [] }),
            executeBotAction: (a: any) => { if (a?.type === 'clickComponent') queueMicrotask(() => end(b.logoutEnds ?? 'logged-out')); return { success: true }; },
            setOnGameTickCallback: (cb: (() => void) | null) => { tick = cb; },
            fire: () => tick?.(),
            end,
        };
        o.onClient(client);
        if (b.endDuringStart) end(b.endDuringStart);
        return { client, stop: () => end('stopped'), stopped };
    };
}
class FakeActions { constructor(public sdk: unknown) {} }
async function open(root: string, name: string, b: Behaviour = {}, calls: string[] = [], server = 'localhost:8888'): Promise<Session> {
    const sdk = new BotSDK({ botUsername: name, password: SECRET, autoLaunchBrowser: false, autoReconnect: false } as any);
    return startInProcessSession({ name, password: SECRET, server }, { startSession: fakeStart(b, calls), sdk, Actions: FakeActions as any, cacheDir: root,
        lifecycle: { root, owner }, recordOwned: () => {} });
}
async function ready(s: Session) { (s.client as any).fire(); await awaitBotReady(s, () => {}); s.lifecycle!.record('ready', 'fixture'); }
const kinds = (root: string, name: string, server = 'localhost:8888') => listAttempts(name, server, { root }).map(a => a.receipt?.events.map(e => e.kind + (e.detail ? `:${e.detail}` : '')));
function noSecret(root: string) {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [readFileSync(join(d, e.name), 'utf8')]);
    expect(walk(root).some(t => t.includes(SECRET))).toBe(false);
}

test('two identities in one worker log keep separate receipts; a failed non-first participant never borrows the first logout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-two-')), log: string[] = [];
    try {
        const a = await open(root, 'Ana');
        await ready(a);
        // The second composed participant fails before START, inside the same process and log.
        await expect(open(root, 'Bob', { fail: true })).rejects.toThrow('login refused');
        expect(await settle([a], true, 'work ok', { log: l => log.push(l) })).toBe(true);
        expect(log).toContain('LOGOUT logged-out');
        const ana = readLogoutProof('Ana', 'localhost:8888', { root }), bob = readLogoutProof('Bob', 'localhost:8888', { root });
        expect(ana).toMatchObject({ state: 'confirmed', domain: 'practice', attemptId: a.lifecycle!.attemptId, ownerRun: 'run-test' });
        expect(bob).toMatchObject({ state: 'held', reason: 'connect failed without an observed end' });
        expect(kinds(root, 'Ana')).toEqual([['connecting', 'connected', 'ready:fixture', 'ended:logged-out', 'logout:logged-out', 'closed']]);
        expect(listAttempts('Ana', 'localhost:8888', { root })[0]!.receipt!.owner).toEqual(owner);
        // The connect error contained the password; the receipt holds a redaction.
        expect(kinds(root, 'Bob')[0]![1]).toBe('connect-failed:Error: login refused for Bob with [redacted]');
        noSecret(root);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('first and non-first partial connections before START supersede older proof with stale or absent status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-partial-'));
    try {
        for (const name of ['Ana', 'Bob']) { const s = await open(root, name); await ready(s); await settle([s], true, 'ok', { log: () => {} }); }
        expect(readLogoutProof('Bob', 'localhost:8888', { root }).state).toBe('confirmed');
        // First participant: connected, no START, no end yet. No status file exists anywhere in this root.
        const first = await open(root, 'Ana');
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'held', attemptId: first.lifecycle!.attemptId, reason: 'connection attempt before START, outcome unknown' });
        // Non-first participant: the server drops it during startup, before START.
        await open(root, 'Bob', { endDuringStart: 'disconnected' });
        expect(readLogoutProof('Bob', 'localhost:8888', { root })).toMatchObject({ state: 'held', reason: 'ended disconnected' });
        expect(listAttempts('Bob', 'localhost:8888', { root }).length).toBe(2);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('logout after failed work is confirmed; disconnected cleanup stays held and fails settle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-cleanup-')), lines: string[] = [];
    try {
        const failed = await open(root, 'Ana');
        await ready(failed);
        expect(await settle([failed], false, 'work failed', { log: l => lines.push(l) })).toBe(false);
        expect(lines.at(-1)).toBe('RESULT fail work failed');
        expect(readLogoutProof('Ana', 'localhost:8888', { root }).state).toBe('confirmed');
        const unknown = await open(root, 'Bob', { logoutEnds: 'disconnected' });
        await ready(unknown);
        expect(await settle([unknown], true, 'work ok', { log: l => lines.push(l) })).toBe(false);
        expect(readLogoutProof('Bob', 'localhost:8888', { root })).toMatchObject({ state: 'held', reason: 'ended disconnected' });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a late callback from an older attempt updates only its own file and never the latest pointer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-late-'));
    try {
        const old = await open(root, 'Ana');
        await ready(old);
        const fresh = await open(root, 'Ana');
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'held', attemptId: fresh.lifecycle!.attemptId });
        // The old session's server logout lands late: still not proof for the current attempt.
        (old.client as any).end('logged-out');
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'held', attemptId: fresh.lifecycle!.attemptId });
        await ready(fresh);
        await settle([fresh], true, 'ok', { log: () => {} });
        const latest = readLogoutProof('Ana', 'localhost:8888', { root });
        expect(latest).toMatchObject({ state: 'confirmed', attemptId: fresh.lifecycle!.attemptId });
        // A second end callback cannot replace the first recorded end.
        expect(old.lifecycle!.record('ended', 'disconnected')).toBe(false);
        await old.close();
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toEqual(latest);
        expect(kinds(root, 'Ana')[0]).toEqual(['connecting', 'connected', 'ready:fixture', 'ended:logged-out', 'closed']);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pre-connect refusal and unrecordable intent create no network attempt and keep older proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-refuse-')), calls: string[] = [];
    try {
        const s = await open(root, 'Ana', {}, calls);
        await ready(s);
        await settle([s], true, 'ok', { log: () => {} });
        const before = readLogoutProof('Ana', 'localhost:8888', { root });
        // The latest pointer cannot be replaced: no connection starts and the attempt file is removed.
        const latest = join(accountDir('Ana', 'localhost:8888', root), 'latest.json'), saved = readFileSync(latest);
        rmSync(latest); mkdirSync(latest);
        await expect(open(root, 'Ana', {}, calls)).rejects.toThrow();
        expect(calls).toEqual(['Ana']);
        rmSync(latest, { recursive: true }); writeFileSync(latest, saved);
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toEqual(before);
        // An unwritable root refuses before the network as well.
        const blocked = join(root, 'file-root'); writeFileSync(blocked, 'x');
        const sdk = new BotSDK({ botUsername: 'Bob', password: SECRET, autoLaunchBrowser: false, autoReconnect: false } as any);
        await expect(startInProcessSession({ name: 'Bob', password: SECRET }, { startSession: fakeStart({}, calls), sdk, Actions: FakeActions as any, cacheDir: root, lifecycle: { root: blocked, owner }, recordOwned: () => {} })).rejects.toThrow();
        expect(calls).toEqual(['Ana']);
        // The main-account login gate refuses before any receipt is written in the default root.
        const mainDir = accountDir('haggis', 'localhost:8888', DEFAULT_LIFECYCLE_ROOT), existed = existsSync(mainDir);
        await expect(connectInProcess({ name: 'haggis', password: SECRET })).rejects.toThrow('Haggis login refused');
        expect(existsSync(mainDir)).toBe(existed);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('practice and live identities stay in separate trees; crossed or malformed receipts are invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-cross-'));
    try {
        const s = await open(root, 'Ana');
        await ready(s);
        await settle([s], true, 'ok', { log: () => {} });
        expect(readLogoutProof('Ana', 'localhost:8888', { root }).state).toBe('confirmed');
        expect(readLogoutProof('Ana', 'rs-sdk-demo.fly.dev', { root })).toEqual({ state: 'none', account: 'Ana', server: 'rs-sdk-demo.fly.dev', domain: 'live' });
        expect(readLogoutProof('Bob', 'localhost:8888', { root }).state).toBe('none');
        const live = beginSessionAttempt({ account: 'Ana', server: 'rs-sdk-demo.fly.dev' }, { root, owner });
        expect(live.domain).toBe('live');
        expect(readLogoutProof('Ana', 'localhost:8888', { root }).state).toBe('confirmed');
        const dir = accountDir('Ana', 'localhost:8888', root), file = join(dir, 'attempts', `${s.lifecycle!.attemptId}.json`), raw = readFileSync(file, 'utf8');
        writeFileSync(file, raw.replace('"server":"localhost:8888"', '"server":"rs-sdk-demo.fly.dev"'));
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'invalid', reason: 'latest attempt identity mismatch' });
        writeFileSync(file, '');
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'invalid', reason: 'latest attempt missing or malformed' });
        rmSync(file);
        expect(readLogoutProof('Ana', 'localhost:8888', { root })).toMatchObject({ state: 'invalid', reason: 'latest attempt missing or malformed' });
        expect(readLogoutProof('../x', 'localhost:8888', { root })).toMatchObject({ state: 'invalid', reason: 'invalid identity' });
        // An attempt newer than the pointer (an owner that failed to move it) is never older proof.
        const b = await open(root, 'Bob'); await ready(b); await settle([b], true, 'ok', { log: () => {} });
        const bobDir = accountDir('Bob', 'localhost:8888', root), pointer = readFileSync(join(bobDir, 'latest.json'));
        beginSessionAttempt({ account: 'Bob', server: 'localhost:8888' }, { root, owner, now: () => Date.now() + 1000 });
        writeFileSync(join(bobDir, 'latest.json'), pointer);
        expect(readLogoutProof('Bob', 'localhost:8888', { root })).toMatchObject({ state: 'held', reason: expect.stringMatching(/^newer attempt .* is not the latest pointer$/) });
    } finally { rmSync(root, { recursive: true, force: true }); }
});


test('custom settlement owns original raw bookkeeping before logout ends the session', async () => {
 const root=mkdtempSync(join(tmpdir(),'lifecycle-owned-settle-')),lines:string[]=[];
 try{const s=await open(root,'Ana');await ready(s);let settling=false,unexpected=0,paid=0;
 watchUnexpectedEnd(s,()=>settling,()=>false,async()=>{unexpected++;});
 const ok=await settle([s],true,'owned work',{log:l=>lines.push(l),onReported:()=>{settling=true;},logout:async raw=>{expect(raw).toBe(s);expect(settling).toBe(true);paid++;return logoutSession(raw);}});
 expect(ok).toBe(true);expect(unexpected).toBe(0);expect(paid).toBe(1);expect(lines.filter(l=>l.startsWith('RESULT '))).toEqual(['RESULT ok owned work']);expect(readLogoutProof('Ana','localhost:8888',{root}).state).toBe('confirmed');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('rejected guarded logout never falls back to raw logout or close',async()=>{
 let closes=0,inputs=0;const s={name:'guard-reject',close:async()=>{closes++;},direct:async()=>{inputs++;return{success:true};},tick:()=>0}as unknown as Session;
 await expect(settle([s],true,'foreign',{log:()=>{},logout:async()=>{throw Error('owner replaced');}})).rejects.toThrow('owner replaced');expect(inputs).toBe(0);expect(closes).toBe(0);
});
