import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// A closed socket does not log an account out: the engine keeps the player in the world until
// TIMEOUT_NO_CONNECTION (500 ticks, ~150 s at 300 ms), and playtime keeps counting every tick it is in the
// world. A specialist must press the logout button, which runs [if_button,logout:try_logout] -> p_logout
// (content/scripts/login_logout/logout.rs2:11). The server refuses it in a duel, on a gnomeball pitch, and
// for 10 s after combat (combat_preventlogout), so callers must not be fighting.

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
let pack: Map<string, number> | null = null;

export function componentId(name: string): number {
    if (!pack) {
        pack = new Map();
        const text = readFileSync(join(repoRoot, 'vendor', 'rs-sdk', 'server', 'content', 'pack', 'interface.pack'), 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq > 0) pack.set(line.slice(eq + 1), Number(line.slice(0, eq)));
        }
    }
    const id = pack.get(name);
    if (id === undefined) throw new Error(`no interface component ${name}`);
    return id;
}

// Clicks logout, and keeps clicking every `retryMs` until the server ends the session or `ms` runs out.
// One click is not enough: World.ts:844-853 drops a logout request made inside the combat window
// (preventLogoutUntil, 16 ticks after combat per logout.rs2:27) instead of keeping it. No click is ever
// awaited past the deadline, so a stuck action queue cannot hang this. Returns the end reason or 'timeout'.
export async function logout(
    s: { sdk: { sendClickComponent(id: number): Promise<unknown> }; ended: Promise<{ reason: string }> },
    ms: number,
    opts: { retryMs?: number } = {},
): Promise<string> {
    const id = componentId('logout:try_logout');
    // One tick at 300 ms. try_logout ends silently while the player is delayed (p_finduid -> canAccess), and a
    // skilling loop is delayed most ticks, so a 5-tick retry could keep landing in the delay (gather 9/10).
    const retry = opts.retryMs ?? 300;
    const deadline = Date.now() + ms;
    let ended: string | null = null;
    let clicked = false;
    void s.ended.then(e => { ended = e.reason; });
    await Promise.resolve(); // let an already-ended session show before the first click
    while (ended === null && Date.now() < deadline) {
        clicked = true;
        void s.sdk.sendClickComponent(id).catch(() => {});
        const wait = Math.min(retry, Math.max(0, deadline - Date.now()));
        await Promise.race([s.ended, Bun.sleep(wait)]);
    }
    // The engine sends LOGOUT and closes the socket; under load the lite session can see the closed socket before
    // it reads the packet and end as 'disconnected' (seen: bankx8v0r3, engine log showed a full P_LOGOUT).
    if (ended === 'disconnected' && clicked) return 'logged-out';
    return ended ?? 'timeout';
}
