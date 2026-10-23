import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectInProcess, type Session } from './inprocess';
import { logout } from './logout';
import { waitUntil } from './ticks';
import { startLedger, formatLedger } from './ledger';
import { startStatus } from './status';
import { watchRandomEvents, type RandomEventWatch } from './randomevents';
import { createWorld, rsPathLength, type Account, type World } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

// Opens an in-process session for a bot created by packages/practice (reads its bot.env),
// waits until it is in game, and prints `START x z level` for the proving harness.
// The bot's server from its bot.env SERVER line; empty or missing means our local practice server.
export function serverFromEnv(env: string): string {
    const v = env.match(/^SERVER=(.*)$/m)?.[1]?.trim();
    return v ? v : 'localhost:8888';
}

// rs-sdk's bot.env template defaults to the public demo server, so a practice bot whose --local rewrite failed
// would silently log in there. Anything but our local server needs DEMO_OK=1, set on purpose by the caller.
export function assertServerAllowed(server: string, env: Record<string, string | undefined> = process.env): void {
    if (/^(localhost|127\.)/.test(server)) return;
    if (env.DEMO_OK === '1') return;
    throw new Error(`refusing to connect to ${server}: not the local practice server; set DEMO_OK=1 to allow it on purpose`);
}

export async function openBot(name: string): Promise<Session> {
    const env = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8');
    const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();
    if (!password) throw new Error(`no PASSWORD in bots/${name}/bot.env`);
    const server = serverFromEnv(env);
    assertServerAllowed(server);
    const s = await connectInProcess({ name, password, server });
    const ready = await waitUntil(s, st => st?.inGame && (st.skills?.length ?? 0) > 0 && !!st.player, { timeoutTicks: 100 });
    if (!ready) {
        // Logged in but not usable: log out before failing, or the account lingers and adds playtime.
        console.log(`LOGOUT ${await logoutSession(s)}`);
        await closeWithin([s], 5000);
        throw new Error(`${name} not in game after 100 ticks`);
    }
    const p = s.sdk.getState()!.player!;
    console.log(`START ${p.worldX} ${p.worldZ} ${p.level}`);
    // Every session keeps a tick ledger (packages/core/src/ledger.ts); finish() prints it.
    const led = startLedger(s as any);
    ledgers.set(s, led);
    // Random events (dryad, genie, lost axe...): handled on every tick unless RANDOM_EVENTS=0 (packages/core/src/randomevents.ts).
    if (process.env.RANDOM_EVENTS !== '0') randomEvents.set(s, watchRandomEvents(s));
    // Any bot stops cleanly when .practice/stop-<name> appears (checked every 25 ticks): a script that never checks
    // it (seen: fishing30 under the supervisor, 2026-10-23) still logs out in game.
    let stopTicks = 0;
    s.onTick(() => { if (++stopTicks % 25 === 0 && existsSync(join(repoRoot, '.practice', `stop-${name}`))) void finish([s], false, 'stop file'); });
    // Live status for the dashboard (packages/dashboard).
    statuses.set(s, startStatus(s as any, server, () => { const c: Record<string, number> = {}; for (const r of led.rows) c[r.kind] = (c[r.kind] ?? 0) + 1; return c; }, () => led.rows.slice(-300).map(r => r.kind[0]).join('')));
    return s;
}

let world: World | null = null;
export async function getWorld(): Promise<World> {
    world ??= createWorld({ pathLength: await rsPathLength() });
    return world;
}

export function accountOf(s: Session): Account {
    const st = s.sdk.getState();
    const skills: Record<string, number> = {};
    for (const k of st?.skills ?? []) skills[k.name.toLowerCase()] = k.baseLevel;
    return { skills, varps: {}, items: (st?.inventory ?? []).map((i: { name: string }) => i.name.toLowerCase().replace(/ /g, '_')) };
}

// Logs one session out in game. The click skips the action queue, and is retried through the combat window.
export function logoutSession(s: Session): Promise<string> {
    const adapter = { sdk: { sendClickComponent: (id: number) => s.direct({ type: 'clickComponent', componentId: id, reason: 'SDK' }) }, ended: s.ended };
    return logout(adapter, 15_000).catch(e => `error ${String(e)}`);
}

// A session close can hang (seen 2026-10-22: one proving run printed RESULT ok, then sat until the 300 s
// kill). Each close gets `ms`; the caller exits either way, and the engine saves on socket close.
export async function closeWithin(sessions: Pick<Session, 'close'>[], ms: number): Promise<{ closed: number; timedOut: number }> {
    let closed = 0;
    let timedOut = 0;
    await Promise.all(sessions.map(async s => {
        const done = await Promise.race([s.close().then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
        if (done) closed++; else timedOut++;
    }));
    return { closed, timedOut };
}

// Prints exactly one RESULT line, logs every account out in game (so playtime stops at once), closes every
// session (5 s limit each), and exits with 0 on ok.
const ledgers = new Map<Session, ReturnType<typeof startLedger>>();
const statuses = new Map<Session, ReturnType<typeof startStatus>>();
const randomEvents = new Map<Session, RandomEventWatch>();
// The session's random event watcher, so a script can pause its loop while busy() is true.
export const randomEventsOf = (s: Session): RandomEventWatch | undefined => randomEvents.get(s);

export async function finish(sessions: Session[], ok: boolean, detail: string): Promise<never> {
    console.log(`RESULT ${ok ? 'ok' : 'fail'} ${detail}`);
    for (const s of sessions) {
        const l = ledgers.get(s); if (l) console.log(`${formatLedger(l.stop())} bot=${s.name}`); statuses.get(s)?.stop();
        const e = randomEvents.get(s); if (e) { e.stop(); console.log(`EVENTS ${JSON.stringify(e.counts())} bot=${s.name}`); }
    }
    // Backstop: two proving runs printed RESULT ok and then sat until the 300 s kill (cause not found).
    // Logout runs first, so the account leaves the world either way; this only bounds the process.
    setTimeout(() => { console.log('WARN finish backstop exit'); process.exit(ok ? 0 : 1); }, 30_000).unref?.();
    const outs = await Promise.all(sessions.map(s => logoutSession(s)));
    console.log(`LOGOUT ${outs.join(' ')}`);
    // A session the server did not end keeps adding scored playtime until its 500-tick timeout, so it fails the run.
    if (outs.some(o => o !== 'logged-out')) { console.log(`WARN logout did not complete: ${outs.join(' ')}`); ok = false; }
    const c = await closeWithin(sessions, 5000);
    if (c.timedOut > 0) console.log(`WARN ${c.timedOut} session close(s) timed out`);
    process.exit(ok ? 0 : 1);
}

export const countItems = (s: Session, re: RegExp): number =>
    (s.sdk.getState()?.inventory ?? []).filter((i: { name: string }) => re.test(i.name)).reduce((n: number, i: { count: number }) => n + i.count, 0);
