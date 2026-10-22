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

// Clicks logout and waits up to `ms` for the server to end the session. Returns the end reason or 'timeout'.
export async function logout(s: { sdk: { sendClickComponent(id: number): Promise<unknown> }; ended: Promise<{ reason: string }> }, ms: number): Promise<string> {
    await s.sdk.sendClickComponent(componentId('logout:try_logout'));
    const r = await Promise.race([s.ended, Bun.sleep(ms).then(() => ({ reason: 'timeout' }))]);
    return r.reason;
}
