import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connectInProcess, type Session } from './inprocess';
import { logout } from './logout';
import { waitUntil } from './ticks';
import { createWorld, rsPathLength, type Account, type World } from './world';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

// Opens an in-process session for a bot created by packages/practice (reads its bot.env),
// waits until it is in game, and prints `START x z level` for the proving harness.
export async function openBot(name: string): Promise<Session> {
    const env = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'bots', name, 'bot.env'), 'utf8');
    const password = env.match(/^PASSWORD=(.*)$/m)?.[1]?.trim();
    if (!password) throw new Error(`no PASSWORD in bots/${name}/bot.env`);
    const s = await connectInProcess({ name, password });
    const ready = await waitUntil(s, st => st?.inGame && (st.skills?.length ?? 0) > 0 && !!st.player, { timeoutTicks: 100 });
    if (!ready) {
        // Logged in but not usable: log out before failing, or the account lingers and adds playtime.
        console.log(`LOGOUT ${await logoutSession(s)}`);
        await closeWithin([s], 5000);
        throw new Error(`${name} not in game after 100 ticks`);
    }
    const p = s.sdk.getState()!.player!;
    console.log(`START ${p.worldX} ${p.worldZ} ${p.level}`);
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
export async function finish(sessions: Session[], ok: boolean, detail: string): Promise<never> {
    console.log(`RESULT ${ok ? 'ok' : 'fail'} ${detail}`);
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
