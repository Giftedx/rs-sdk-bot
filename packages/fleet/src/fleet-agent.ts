// Fleet agent daemon: syncs fleet-data, invokes live-update, refreshes market caches,
// clears stale swarm stops when accounts are offline, and launches due cross-side trades.
// Usage: bun packages/fleet/src/fleet-agent.ts [--daemon] [--once]
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { controllerNamed, leaseHolder, releaseLease, renewLease, saveLaunch, takeLease } from '../../core/src/controllers';
import { FLEET_DIR, loadOwners, mySide, sideOf } from '../../core/src/fleet';
import { validOrder, type Order, type Receipt } from '../../core/src/fleet-trade-settlement';
import { reloadDue, respawnDaemon } from '../../core/src/live-reload';
import { BIDS_FILE, MARKET_CACHE_MS, MARKET_FILE } from '../../core/src/market-cache';
import { findStopFile, liveRoot, repoRoot, statusReadDirs } from '../../core/src/practice-paths';
import { spawnSyncTimed } from '../../core/src/proc';
import { lastResult } from '../../core/src/run-child';
import { capabilityRevision } from '../../core/src/worker-release';
import { brainPlannedJobs } from './fleet-sync';
import { InfraCircuitBreaker, classifyInfraFault } from './infra-circuit-breaker';
import { clearSwarmStop, swarmWroteStop } from './swarm';
import { buildOrderPicker, readAgentJobs, swarmBusy } from './trade-plan';

const root = repoRoot;
export const AGENT_SUBPROCESS_TIMEOUT_MS = 180_000;
const CYCLE = Number(process.env.CYCLE ?? 10) * 60_000, LEAD = Number(process.env.LEAD ?? 15) * 60_000;
const jsonFileCache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();
const readJson = (dir: string) => {
    if (!existsSync(dir)) return [];
    const now = Date.now();
    const out: any[] = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const full = join(dir, f);
        try {
            const st = statSync(full);
            const hit = jsonFileCache.get(full);
            if (hit && now - st.mtimeMs > 1000 && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
                out.push(hit.value);
                continue;
            }
            const value = JSON.parse(readFileSync(full, 'utf8'));
            jsonFileCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, value });
            out.push(value);
        } catch {
            jsonFileCache.delete(full);
        }
    }
    return out;
};

export { readAgentJobs, swarmBusy } from './trade-plan';

export const marketStale = (base: string, now = Date.now()): boolean => [MARKET_FILE, BIDS_FILE].some(file => {
    try { return now - statSync(join(base, file)).mtimeMs > MARKET_CACHE_MS; } catch { return true; }
});

export function stopClearable(status: { result?: string; at?: number } | null | undefined, now = Date.now()): boolean {
    return !status || !!status.result || !(Number.isFinite(status.at) && now - status.at! < 30_000);
}

export function dueTrades(
    orders: readonly Order[],
    receipts: readonly Receipt[],
    side: string,
    owners: ReturnType<typeof loadOwners>,
    busy: ReadonlySet<string>,
    running: ReadonlySet<string>,
    now: number,
    lead = LEAD,
) {
    const names = new Set<string>();
    for (let i = 0; i < orders.length; i++) {
        const o = orders[i]!;
        if (sideOf(o.from, owners) === side) names.add(o.from.toLowerCase());
        if (sideOf(o.to, owners) === side) names.add(o.to.toLowerCase());
    }
    const pick = buildOrderPicker(orders, receipts);
    const due: { account: string; order: Order; busy: boolean }[] = [];
    for (const n of names) {
        if (running.has(n)) continue;
        const p = pick(n, now, lead);
        if (!p) continue;
        const account = p.role === 'from' ? p.order.from : p.order.to;
        due.push({ account, order: p.order, busy: busy.has(n) });
    }
    return due;
}

const TRADE_SCRIPT = resolve(root, 'scripts', 'aio-logistics.ts');

export function tradeEnvironment(
    dir: string,
    env: Record<string, string | undefined> = process.env,
    release = capabilityRevision([TRADE_SCRIPT], root),
) {
    return { ...env, FLEET_DIR: dir, WORKER_RELEASE: release, WORKER_ENTRY: TRADE_SCRIPT, STALL_TICKS: '0', LOOT_WATCH: '0', RANDOM_EVENTS: '0' };
}

export function tradeStop(base: string, account: string, now = Date.now()): { held?: string; cleared: boolean } {
    let cleared = false;
    const seen = new Set<string>();
    for (const name of new Set([account, account.toLowerCase()])) {
        const file = findStopFile(name, base);
        if (!file || seen.has(file)) continue;
        seen.add(file);
        let text: string;
        try { text = readFileSync(file, 'utf8'); } catch { return { held: 'stop file unreadable', cleared }; }
        if (!swarmWroteStop(text)) return { held: 'owner stop file', cleared };
        let status: any = null;
        for (const dir of statusReadDirs(base)) {
            let found = false;
            for (const fileName of new Set([`${account}.json`, `${account.toLowerCase()}.json`])) {
                try { status = JSON.parse(readFileSync(join(dir, fileName), 'utf8')); found = true; break; } catch { /* check fallback */ }
            }
            if (found) break;
        }
        if (!stopClearable(status, now)) return { held: 'its last run is still ending', cleared };
        if (clearSwarmStop(file)) cleared = true;
    }
    return { cleared };
}

export function recordAgentInfraResult(breaker: InfraCircuitBreaker, output: string, exitCode: number | null): boolean {
    const kind = classifyInfraFault(output);
    if (kind) {
        breaker.recordFailure(output, kind);
        return true;
    }
    if (exitCode === 0) breaker.recordSuccess('remote_git_claim');
    return false;
}

export function syncResult(out: string, exitCode: number | null): string {
    const line = lastResult(out);
    return line === 'RESULT fail no result' ? `RESULT fail fleet-sync exit ${exitCode}` : line;
}

const procCmdline = (pid: number): string | undefined => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return undefined; } };
export function agentAlive(pid: number, cmdline: (pid: number) => string | undefined = procCmdline): boolean {
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
    const c = cmdline(pid);
    return c === undefined || c.includes('fleet-agent');
}

export async function runFleetAgentCli(argv: readonly string[] = process.argv.slice(2), base = root): Promise<void> {
    const lock = join(base, '.practice', 'fleet-agent.lock');
    if (argv.includes('--daemon')) {
        const out = openSync(join(base, '.practice', 'fleet-agent.log'), 'a');
        const child = spawn(process.execPath, [join(base, 'scripts', 'fleet-agent.ts')], { cwd: base, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
        closeSync(out); child.unref();
        console.log(`FLEET_AGENT started pid ${child.pid} (log .practice/fleet-agent.log)`);
        process.exit(0);
    }
    const held = { alive: (pid: number) => agentAlive(pid), ...(procCmdline(process.pid) === undefined ? {} : { staleMs: Infinity }) };
    if (!takeLease(lock, process.pid, held)) { console.log(`FLEET_AGENT already running pid ${leaseHolder(lock, held)}`); process.exit(0); }
    const release = () => releaseLease(lock);
    process.on('exit', release); process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
    setInterval(() => { renewLease(lock); }, 60_000).unref();
    const running = new Set<string>(), once = argv.includes('--once');
    if (!once) saveLaunch(join(base, controllerNamed('fleet-agent').launch), []);
    const infraBreaker = new InfraCircuitBreaker({ stateFile: join(liveRoot(base), 'infra-circuit-breaker.json') });
    const sync = () => {
        const p = spawnSyncTimed([process.execPath, 'scripts/fleet-sync.ts'], {
            cwd: base,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: AGENT_SUBPROCESS_TIMEOUT_MS,
        });
        const combined = `${p.stdout.toString()}${p.stderr.toString()}`;
        recordAgentInfraResult(infraBreaker, combined, p.exitCode);
        console.log(`FLEET_AGENT sync ${syncResult(combined, p.exitCode)} at ${new Date().toISOString()}`);
    };
    const startedAt = Date.now();
    let marketRefresh: ReturnType<typeof spawn> | null = null;
    for (;;) {
        if (!renewLease(lock)) {
            console.log(`FLEET_AGENT lost its lease to another agent${running.size ? ': it ends when its trade ends' : ''} at ${new Date().toISOString()}`);
            if (!running.size) process.exit(0);
            await Bun.sleep(60_000);
            continue;
        }
        const infraGate = infraBreaker.canProceed();
        if (!infraGate.allowed) {
            console.log(`FLEET_AGENT infra circuit open (${infraGate.reason}); backing off at ${new Date().toISOString()}`);
            if (once && !running.size) break;
            await Bun.sleep(Math.min(CYCLE, Math.max(5_000, infraGate.waitMs)));
            continue;
        }
        const update = spawnSyncTimed([process.execPath, 'packages/fleet/src/live-update.ts'], {
            cwd: base,
            windowsHide: true,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: AGENT_SUBPROCESS_TIMEOUT_MS,
        });
        const updateOut = `${update.stdout.toString()}${update.stderr.toString()}`;
        const updateLine = lastResult(updateOut);
        if (update.exitCode !== 0) recordAgentInfraResult(infraBreaker, updateOut, update.exitCode);
        if (!/ live-update (?:none|off|paused)/.test(updateLine)) console.log(`FLEET_AGENT ${updateLine} at ${new Date().toISOString()}`);
        if (!renewLease(lock)) continue;
        if (!once && !marketRefresh && marketStale(base)) {
            marketRefresh = spawn(process.execPath, [join(base, 'scripts', 'market-cache.ts')], { cwd: base, windowsHide: true, stdio: 'ignore' });
            marketRefresh.on('exit', () => { marketRefresh = null; });
            marketRefresh.on('error', () => { marketRefresh = null; });
        }
        if (!once && !running.size && reloadDue(base, 'fleet-agent', startedAt)) {
            release();
            const pid = respawnDaemon(base, [join(base, 'scripts', 'fleet-agent.ts')], join(base, '.practice', 'fleet-agent.log'));
            console.log(`FLEET_AGENT reload after a live update: successor pid ${pid}`);
            process.exit(0);
        }
        sync();
        if (!renewLease(lock)) continue;
        const dir = FLEET_DIR(), now = Date.now(), side = mySide(), owners = loadOwners();
        const orders = readJson(join(dir, 'orders')).filter(validOrder), receipts = readJson(join(dir, 'receipts'));
        const handJobs = readAgentJobs();
        const busy = swarmBusy([...handJobs, ...brainPlannedJobs(base, handJobs, now)]);
        for (const t of dueTrades(orders, receipts, side, owners, busy, running, now)) {
            if (t.busy) { console.log(`FLEET_AGENT busy ${t.account}: order ${t.order.id} waits (enabled swarm job)`); continue; }
            const stop = tradeStop(base, t.account, now);
            if (stop.cleared) console.log(`FLEET_AGENT removed the swarm's own stop file for ${t.account}`);
            if (stop.held) { console.log(`FLEET_AGENT held ${t.account}: order ${t.order.id} waits (${stop.held})`); continue; }
            const accountKey = t.account.toLowerCase();
            running.add(accountKey);
            console.log(`FLEET_AGENT start ${t.account} order ${t.order.id}`);
            try {
                const p = Bun.spawn([process.execPath, TRADE_SCRIPT, t.account, 'fleet-trade', t.order.id], {
                    cwd: base, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env: tradeEnvironment(dir),
                });
                void (async () => {
                    try {
                        const [out, errOut, exitCode] = await Promise.all([
                            new Response(p.stdout).text(),
                            new Response(p.stderr).text(),
                            p.exited,
                        ]);
                        if (errOut) process.stderr.write(errOut);
                        const combined = `${out}\n${errOut}`;
                        if (exitCode !== 0) recordAgentInfraResult(infraBreaker, combined, exitCode);
                        console.log(`FLEET_AGENT done ${t.account} ${out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1) ?? 'no result'}`);
                    } catch (err) {
                        console.log(`FLEET_AGENT error ${t.account} ${String(err).slice(0, 160)}`);
                    } finally {
                        running.delete(accountKey);
                        if (renewLease(lock)) sync();
                    }
                })();
            } catch (err) {
                running.delete(accountKey);
                console.log(`FLEET_AGENT spawn failed ${t.account}: ${String(err).slice(0, 160)}`);
            }
        }
        if (once && !running.size) break;
        const soon = orders.some(o => o.end > now && o.start - now < LEAD && (sideOf(o.from, owners) === side || sideOf(o.to, owners) === side));
        await Bun.sleep(soon || running.size ? 60_000 : CYCLE);
    }
}

if (import.meta.main) {
    await runFleetAgentCli(process.argv.slice(2));
}
