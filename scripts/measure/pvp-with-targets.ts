// A PvP route of scripts/aio-pvp.ts with its targets in the world: logs in the target accounts of the run, holds them
// on their tiles (each waits on every tick, so a lockstep engine does not hold the tick for them; they hit back by
// auto-retaliate), and runs the route's own command as a child. The child's RESULT lines come out as ROUTE_RESULT, and
// this script prints one RESULT with the child's verdict and detail, so a bench case passes only when the route does.
// Usage: bun scripts/measure/pvp-with-targets.ts <bot> <target,target,...> <mode> [arg ...] [KEY=value ...]
// The mode and its arguments are those of scripts/aio-pvp.ts; `{targets}` in an argument becomes the first target.
import { resolve } from 'node:path';
import { finish, openBot } from '../../packages/core/src/bot';
import { tickWaits } from '../../packages/core/src/tick-stream';
import { nextTick } from '../pk';

const [bot, targetList, mode, ...given] = process.argv.slice(2);
// TARGET_*=value arguments are this harness's settings (TARGET_PROFILE, TARGET_OPTS, TARGET_PRAYER_GUARD, TARGET_SIGHT), not the route's.
const rest = given.filter(a => { const m = a.match(/^(TARGET_[A-Z_]+)=(.*)$/); if (m) process.env[m[1]!] = m[2]!; return !m; });
if (!bot || !targetList || !mode) { console.log('RESULT fail usage: bun scripts/measure/pvp-with-targets.ts <bot> <target,...> <mode> [arg ...]'); process.exit(2); }
const names = targetList.split(',').filter(Boolean);
// The wait for the logins counts as a tick wait: a lockstep engine holds each tick for an account with no waiter.
// The targets stand with no prayer guard (TARGET_PRAYER_GUARD=1 keeps it): a maxed target whose guard switches its
// protection prayer is a duel that a route's short fight cap turns into a coin toss, and the case tests the route.
// The route's child keeps the environment of this process.
const childEnv = { ...process.env };
if (process.env.TARGET_PRAYER_GUARD !== '1') process.env.PRAYER_GUARD = '0';
tickWaits.active++;
const targets = await Promise.all(names.map(n => openBot(n, { onStop: async () => {} })));
tickWaits.active--;
let done = false;
// TARGET_PROFILE=<profile of scripts/pk-spar.ts>: a target that takes a hit from a player fights that player with the
// fight loop on that profile (its kit read from what it wears and carries), as a real target does: it eats, prays,
// hits back and leaves by its glory when the profile says so. With no TARGET_PROFILE a target stands and hits back by
// auto-retaliate. Each target prints `TARGET <name> <outcome>` when its fight ends.
const targetProfile = process.env.TARGET_PROFILE;
const defend = targetProfile ? await (async () => {
    const { fightPlayer } = await import('../pk');
    const { kitFrom } = await import('../pk-roam');
    const { sparOptions } = await import('../pk-spar');
    const sawAt = new Map<typeof targets[number], number>();
    return async (t: typeof targets[number]) => {
        const st = t.sdk.getState();
        const hit = (st?.combatEvents ?? []).find(e => e.type === 'damage_taken' && e.sourceType === 'other_player');
        // TARGET_SIGHT=<tiles>: a target also takes the nearest other player within that many tiles for its attacker
        // before any hit (a wary target that leaves on sight, with TARGET_OPTS={"flee":true}).
        const sight = Number(process.env.TARGET_SIGHT ?? 0), mates = new Set(names.map(n => n.toLowerCase()));
        const near = sight > 0 ? (st?.nearbyPlayers ?? []).filter(p => !mates.has(p.name.toLowerCase()) && p.distance <= sight).sort((a, b) => a.distance - b.distance)[0] : undefined;
        // TARGET_SIGHT_DELAY=<ticks>: it leaves that many ticks after it first sees one (a human's reaction).
        if (near && !sawAt.has(t)) sawAt.set(t, t.tick());
        const seen = near && t.tick() - sawAt.get(t)! >= Number(process.env.TARGET_SIGHT_DELAY ?? 0) ? near : undefined;
        const by = (hit && st?.nearbyPlayers.find(p => p.index === hit.sourceIndex)) || seen;
        if (!by) return false;
        const o = sparOptions(targetProfile, process.env.TARGET_OPTS, kitFrom(t.sdk.getEquipment(), t.sdk.getInventory()), 900);
        const r = await fightPlayer(t, by.name, { ...o, stop: () => done, log: l => console.log(`[${t.name}] ${l}`) });
        console.log(`TARGET ${t.name} ${r.outcome}`);
        return r.outcome === 'died' || r.outcome === 'escaped';
    };
})() : null;
const idle = targets.map(t => (async () => {
    while (!done && await nextTick(t)) { if (defend && await defend(t)) break; }
})());
const root = resolve(import.meta.dir, '..', '..');
const child = Bun.spawn(['bun', resolve(root, 'scripts/aio-pvp.ts'), bot, mode, ...rest.map(a => a.replaceAll('{targets}', names[0]!))],
    { cwd: root, env: childEnv, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
let last: string | null = null;
const relay = async (stream: ReadableStream<Uint8Array>, write: (s: string) => void) => {
    let carry = '';
    for await (const chunk of stream) {
        const lines = (carry + new TextDecoder().decode(chunk)).split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) { if (/^RESULT /.test(l)) last = l; write(l.replace(/^RESULT /, 'ROUTE_RESULT ') + '\n'); }
    }
    if (carry) { if (/^RESULT /.test(carry)) last = carry; write(carry.replace(/^RESULT /, 'ROUTE_RESULT ') + '\n'); }
};
await Promise.all([relay(child.stdout, s => process.stdout.write(s)), relay(child.stderr, s => process.stderr.write(s)), child.exited]);
done = true;
await Promise.race([Promise.all(idle), new Promise(r => setTimeout(r, 2000))]);
const verdict = last as string | null;
const routeOk = child.exitCode === 0 && !!verdict && /^RESULT ok\b/.test(verdict);
await finish(targets, routeOk, `pvp ${mode} exit=${child.exitCode} ${verdict ? verdict.replace(/^RESULT (ok|fail) ?/, '') : 'no RESULT from the route'}`);
