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

const [bot, targetList, mode, ...rest] = process.argv.slice(2);
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
const idle = targets.map(t => (async () => { while (!done && await nextTick(t)) { /* stands on its tile */ } })());
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
