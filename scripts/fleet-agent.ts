// This machine's fleet agent. Every CYCLE minutes (1 when one of its orders opens within LEAD minutes) it syncs fleet
// data through git (scripts/fleet-sync.ts, run as a child process: the agent runs for days, so a sync uses the code on
// disk, never the module this process loaded at start) and starts scripts/fleet-trade.ts for each open order that names
// one of this side's accounts, then syncs again so the receipt reaches the other machine. An account with an
// enabled swarm job is skipped: the swarm and the agent must never both log one account in. One instance per
// machine (.practice/fleet-agent.lock holds its process id).
// Usage: bun scripts/fleet-agent.ts [--daemon] [--once]   Env: CYCLE (default 10), LEAD (default 15), FLEET_SIDE
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FLEET_DIR, mySide, sideOf, loadOwners } from '../packages/core/src/fleet';
import { pickOrder, readAgentJobs, swarmBusy, validOrder, type Order, type Receipt } from './fleet-trade';
import { lastResult } from '../packages/core/src/run-child';
import { mergeJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import {capabilityRevision} from '../packages/core/src/worker-release';
import { clearSwarmStop, swarmWroteStop } from './swarm';
import { stopClearable } from './autopilot';
import { reloadDue, respawnDaemon } from '../packages/core/src/live-reload';
import { controllerNamed, leaseHolder, releaseLease, renewLease, saveLaunch, takeLease } from '../packages/core/src/controllers';

const root = resolve(import.meta.dir, '..'), lock = join(root, '.practice', 'fleet-agent.lock');
const CYCLE = Number(process.env.CYCLE ?? 10) * 60_000, LEAD = Number(process.env.LEAD ?? 15) * 60_000;
const readJson = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];

export { readAgentJobs, swarmBusy } from './fleet-trade';

// The orders this side must act on now: each of its accounts with a pickable order, minus busy or already running ones.
export function dueTrades(orders: readonly Order[], receipts: readonly Receipt[], side: string, owners: ReturnType<typeof loadOwners>, busy: ReadonlySet<string>, running: ReadonlySet<string>, now: number, lead = LEAD) {
    const names = new Set(orders.flatMap(o => [o.from, o.to]).filter(n => sideOf(n, owners) === side).map(n => n.toLowerCase()));
    const due: { account: string; order: Order; busy: boolean }[] = [];
    for (const n of names) {
        if (running.has(n)) continue;
        const p = pickOrder(orders, receipts, n, now, lead);
        if (!p) continue;
        const account = p.role === 'from' ? p.order.from : p.order.to;
        due.push({ account, order: p.order, busy: busy.has(n) });
    }
    return due;
}

const TRADE_SCRIPT=resolve(import.meta.dir,'../scripts/fleet-trade.ts');
// The trade worker's capability release (packages/core/src/worker-release.ts). STALL_TICKS=0 turns off the session's
// idle guard (packages/core/src/bot.ts): a trade waits for its partner, and its own order window bounds it. With the
// guard on, a side that waited 900 ticks was ended, a giver's receipt read `reconcile` with nothing given, and its
// trade claim then stayed held (live: TheFullMonty waited for a PC account that could not log in).
export function tradeEnvironment(dir:string,env:Record<string,string|undefined>=process.env,release=capabilityRevision([TRADE_SCRIPT],root)){
    return {...env,FLEET_DIR:dir,WORKER_RELEASE:release,WORKER_ENTRY:TRADE_SCRIPT,STALL_TICKS:'0'};
}

// The swarm leaves its own stop file when an account's job leaves the plan, as when the planner takes the account off
// its job for a fleet order (scripts/swarm.ts SWARM_STOP). A live login refuses while any stop file exists
// (packages/core/src/inprocess.ts "live admission paused by stop file"), so the trade for that order could not log in:
// live, 86 refused trade logins and none of nine same-side orders settled. Before a trade the agent removes that file
// once the account is offline (scripts/autopilot.ts stopClearable). An owner's stop file holds the trade, and so does
// the swarm's while a run of the account is still live: `held` names why.
export function tradeStop(base: string, account: string, now = Date.now()): { held?: string; cleared: boolean } {
    let cleared = false;
    for (const name of new Set([account, account.toLowerCase()])) {
        const file = join(base, '.practice', `stop-${name}`);
        if (!existsSync(file)) continue;
        let text: string;
        try { text = readFileSync(file, 'utf8'); } catch { return { held: 'stop file unreadable', cleared }; }
        if (!swarmWroteStop(text)) return { held: 'owner stop file', cleared };
        let status: any = null;
        try { status = JSON.parse(readFileSync(join(base, '.practice', 'status', `${account}.json`), 'utf8')); } catch { /* No status row: the account is offline. */ }
        if (!stopClearable(status, now)) return { held: 'its last run is still ending', cleared };
        if (clearSwarmStop(file)) cleared = true;
    }
    return { cleared };
}

// The sync child's own RESULT line; a child that printed none reports its exit code.
export function syncResult(out: string, exitCode: number | null): string {
    const line = lastResult(out);
    return line === 'RESULT fail no result' ? `RESULT fail fleet-sync exit ${exitCode}` : line;
}

// A lock left by a previous boot or container can name a PID that another process now holds, so on Linux the PID must
// still run a fleet agent; where /proc is absent (Windows) a live PID is taken as the agent.
const procCmdline = (pid: number): string | undefined => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return undefined; } };
export function agentAlive(pid: number, cmdline: (pid: number) => string | undefined = procCmdline): boolean {
    try { process.kill(pid, 0); } catch { return false; }
    const c = cmdline(pid);
    return c === undefined || c.includes('fleet-agent');
}

if (import.meta.main) {
    if (process.argv.includes('--daemon')) {
        const out = openSync(join(root, '.practice', 'fleet-agent.log'), 'a');
        const child = spawn(process.execPath, [join(root, 'scripts', 'fleet-agent.ts')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
        closeSync(out); child.unref();
        console.log(`FLEET_AGENT started pid ${child.pid} (log .practice/fleet-agent.log)`);
        process.exit(0);
    }
    // The lock is a lease (packages/core/src/controllers.ts): its holder writes it again on each pass and each minute
    // of a wait. The watchdog starts an agent when no live process holds it.
    // Where /proc names the process (Linux), agentAlive proves that the holder is a fleet agent, so an old lease
    // file of a live agent is still held. Windows has no such proof, and there the file time decides.
    const held = { alive: (pid: number) => agentAlive(pid), ...(procCmdline(process.pid) === undefined ? {} : { staleMs: Infinity }) };
    if (!takeLease(lock, process.pid, held)) { console.log(`FLEET_AGENT already running pid ${leaseHolder(lock, held)}`); process.exit(0); }
    const release = () => releaseLease(lock);
    process.on('exit', release); process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
    setInterval(() => { renewLease(lock); }, 60_000).unref();
    const running = new Set<string>(), once = process.argv.includes('--once');
    // The record of a daemon start: the watchdog starts an agent again only from it, with these settings. A --once
    // pass writes none.
    if (!once) saveLaunch(join(root, controllerNamed('fleet-agent').launch), []);
    const sync = () => {
        const p = Bun.spawnSync(['bun', 'scripts/fleet-sync.ts'], { cwd: root, windowsHide: true, env: process.env, stdout: 'pipe', stderr: 'pipe' });
        console.log(`FLEET_AGENT sync ${syncResult(`${p.stdout.toString()}${p.stderr.toString()}`, p.exitCode)} at ${new Date().toISOString()}`);
    };
    const startedAt = Date.now();
    for (;;) {
        // A sync that waited longer than the lease time lets a second agent take the lease. This agent then starts
        // no more work, and ends when its last trade ends.
        if (!renewLease(lock)) {
            console.log(`FLEET_AGENT lost its lease to another agent${running.size ? ': it ends when its trade ends' : ''} at ${new Date().toISOString()}`);
            if (!running.size) process.exit(0);
            await Bun.sleep(60_000);
            continue;
        }
        // Bring this checkout to current master first (packages/router/src/live-update.ts), so the sync and the trades run merged fixes.
        const update = Bun.spawnSync(['bun', 'packages/router/src/live-update.ts'], { cwd: root, windowsHide: true, env: process.env, stdout: 'pipe', stderr: 'pipe' });
        const updateLine = lastResult(update.stdout.toString());
        if (!/ live-update (?:none|off|paused)/.test(updateLine)) console.log(`FLEET_AGENT ${updateLine} at ${new Date().toISOString()}`);
        // The update and the sync are child processes that can wait on the network for longer than the lease time.
        // After each one, this agent goes on only while it still holds the lease. The top of the loop handles a loss.
        if (!renewLease(lock)) continue;
        // The update changed this agent's code: a copy on the current code takes over once no trade runs.
        if (!once && !running.size && reloadDue(root, 'fleet-agent', startedAt)) {
            release();
            const pid = respawnDaemon(root, [join(root, 'scripts', 'fleet-agent.ts')], join(root, '.practice', 'fleet-agent.log'));
            console.log(`FLEET_AGENT reload after a live update: successor pid ${pid}`);
            process.exit(0);
        }
        sync();
        if (!renewLease(lock)) continue;
        const dir = FLEET_DIR(), now = Date.now();
        const orders = readJson(join(dir, 'orders')).filter(validOrder), receipts = readJson(join(dir, 'receipts'));
        // The owner's jobs plus the coordinator's (.practice/coordinator/jobs.json), as the swarm merges them.
        const busy = swarmBusy(mergeJobs(readAgentJobs(), readCoordinatorJobs(root).jobs));
        for (const t of dueTrades(orders, receipts, mySide(), loadOwners(), busy, running, now)) {
            if (t.busy) { console.log(`FLEET_AGENT busy ${t.account}: order ${t.order.id} waits (enabled swarm job)`); continue; }
            const stop = tradeStop(root, t.account, now);
            if (stop.cleared) console.log(`FLEET_AGENT removed the swarm's own stop file for ${t.account}`);
            if (stop.held) { console.log(`FLEET_AGENT held ${t.account}: order ${t.order.id} waits (${stop.held})`); continue; }
            running.add(t.account.toLowerCase());
            console.log(`FLEET_AGENT start ${t.account} order ${t.order.id}`);
            const p = Bun.spawn(['bun', TRADE_SCRIPT, t.account, t.order.id], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: tradeEnvironment(dir) });
            void (async () => {
                const out = await new Response(p.stdout).text();
                console.log(`FLEET_AGENT done ${t.account} ${out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1) ?? 'no result'}`);
                running.delete(t.account.toLowerCase()); sync();
            })();
        }
        if (once && !running.size) break;
        const soon = orders.some(o => o.end > now && o.start - now < LEAD && [o.from, o.to].some(n => sideOf(n) === mySide()));
        await Bun.sleep(soon || running.size ? 60_000 : CYCLE);
    }
}
