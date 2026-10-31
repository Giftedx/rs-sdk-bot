// This machine's fleet agent. Every CYCLE minutes (1 when one of its orders opens within LEAD minutes) it syncs fleet
// data through git (scripts/fleet-sync.ts runSync) and starts scripts/fleet-trade.ts for each open order that names
// one of this side's accounts, then syncs again so the receipt reaches the other machine. An account with an
// enabled swarm job is skipped: the swarm and the agent must never both log one account in. One instance per
// machine (.practice/fleet-agent.lock holds its process id).
// Usage: bun scripts/fleet-agent.ts [--daemon] [--once]   Env: CYCLE (default 10), LEAD (default 15), FLEET_SIDE
import { closeSync, existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FLEET_DIR, mySide, sideOf, loadOwners } from '../packages/core/src/fleet';
import { pickOrder, validOrder, type Order, type Receipt } from './fleet-trade';
import { runSync } from './fleet-sync';
import {workerSourceRevision} from '../packages/core/src/worker-release';

const root = resolve(import.meta.dir, '..'), lock = join(root, '.practice', 'fleet-agent.lock');
const CYCLE = Number(process.env.CYCLE ?? 10) * 60_000, LEAD = Number(process.env.LEAD ?? 15) * 60_000;
const readJson = (dir: string) => existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(dir, f), 'utf8'))]; } catch { return []; } }) : [];

// Accounts with an enabled swarm job belong to the swarm while it runs them.
export function swarmBusy(jobs: readonly any[]): Set<string> {
    return new Set(jobs.filter(j => j?.enabled).flatMap(j => [j.account, ...(j.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}
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

export function readAgentJobs(file=resolve(process.env.SWARM_PLAN??join(root,'swarm.json'))): readonly any[]{
    // An unreadable plan cannot grant a trade worker ownership of its accounts.
    const plan=JSON.parse(readFileSync(file,'utf8'));
    if(!Array.isArray(plan.jobs))throw Error('fleet agent: invalid swarm plan');
    return plan.jobs;
}
export function tradeEnvironment(dir:string,env:Record<string,string|undefined>=process.env,release=workerSourceRevision(root)){
    return {...env,FLEET_DIR:dir,WORKER_RELEASE:release};
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (import.meta.main) {
    if (process.argv.includes('--daemon')) {
        const out = openSync(join(root, '.practice', 'fleet-agent.log'), 'a');
        const child = spawn(process.execPath, [join(root, 'scripts', 'fleet-agent.ts')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
        closeSync(out); child.unref();
        console.log(`FLEET_AGENT started pid ${child.pid} (log .practice/fleet-agent.log)`);
        process.exit(0);
    }
    if (existsSync(lock)) { const pid = Number(readFileSync(lock, 'utf8')); if (pid !== process.pid && alive(pid)) { console.log(`FLEET_AGENT already running pid ${pid}`); process.exit(0); } }
    writeFileSync(lock, String(process.pid));
    const release = () => { try { if (readFileSync(lock, 'utf8') === String(process.pid)) rmSync(lock); } catch { /* gone */ } };
    process.on('exit', release); process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));
    const running = new Set<string>(), once = process.argv.includes('--once');
    const sync = () => { try { console.log(`FLEET_AGENT sync ${runSync()} at ${new Date().toISOString()}`); } catch (e) { console.log(`FLEET_AGENT sync failed: ${String(e)}`); } };
    for (;;) {
        sync();
        const dir = FLEET_DIR(), now = Date.now();
        const orders = readJson(join(dir, 'orders')).filter(validOrder), receipts = readJson(join(dir, 'receipts'));
        const busy = swarmBusy(readAgentJobs());
        for (const t of dueTrades(orders, receipts, mySide(), loadOwners(), busy, running, now)) {
            if (t.busy) { console.log(`FLEET_AGENT busy ${t.account}: order ${t.order.id} waits (enabled swarm job)`); continue; }
            running.add(t.account.toLowerCase());
            console.log(`FLEET_AGENT start ${t.account} order ${t.order.id}`);
            const p = Bun.spawn(['bun', 'scripts/fleet-trade.ts', t.account, t.order.id], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env: tradeEnvironment(dir) });
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
