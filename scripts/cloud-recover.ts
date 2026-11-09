// Recovers this side's held live sessions through the side's running coordinator, one account per call, so the
// swarm and the other farmers keep running. A cloud watchdog calls it; it never guesses: an account whose end record is
// gone, or a side whose coordinator is not running, is refused with a logged reason.
// Usage: FLEET_SIDE=<side> bun scripts/cloud-recover.ts [--dry] [--root=<checkout>]   (root defaults to this checkout)
// The coordinator it restarts inherits this process's environment without SWARM_PLAN, so the caller's PATH must carry
// the model stub (README "Claude Code cloud fleet side").
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { loadOwners, mySide } from '../packages/core/src/fleet';
import { readFleetAccountClaim } from '../packages/core/src/fleet-trade-claim';
import { readLogoutProof, type LogoutProof } from '../packages/core/src/session-lifecycle';
import { loadEnded, swarmWroteStop, type EndRecord } from './swarm';

export const LIVE_SERVER = 'rs-sdk-demo.fly.dev';
// The end reasons the recovery permit accepts (packages/core/src/session-recovery-permit.ts), less a death: a death
// waits for a person, as the swarm's standing retry does.
const RECOVERABLE_END = /^(?:blocked|gave-up|exit|no-progress|stopped)(?:\b| )/;

export type ClaimView = { phase: 'held' | 'released'; kind?: string; pid?: number; host?: string } | null;
export type Eligibility = { eligible: true; endedAt: number } | { eligible: false; reason: string; log: boolean };

// Whether one account needs, and may get, an authenticated recovery now. `log` marks a held session that is refused,
// as opposed to an account with nothing to recover.
export function eligibility(v: { proof: LogoutProof; claim: ClaimView; end: EndRecord | undefined; stopText: string | undefined; pidAlive: (pid: number) => boolean; host: string }): Eligibility {
    if (v.proof.state !== 'held') return { eligible: false, reason: `logout proof ${v.proof.state}`, log: false };
    if (!v.claim || v.claim.phase !== 'held') return { eligible: false, reason: 'no held fleet account claim', log: false };
    if (v.claim.kind !== 'swarm') return { eligible: false, reason: 'claim is held by a trade order', log: true };
    if (v.claim.host === v.host && typeof v.claim.pid === 'number' && v.pidAlive(v.claim.pid)) return { eligible: false, reason: 'worker still alive', log: false };
    if (v.stopText !== undefined && !swarmWroteStop(v.stopText)) return { eligible: false, reason: 'owner stop file holds the account', log: true };
    if (!v.end) return { eligible: false, reason: 'end record gone (standing retry window passed); recover by hand', log: true };
    if (/^died\b/.test(v.end.reason)) return { eligible: false, reason: 'death needs a person', log: true };
    if (!RECOVERABLE_END.test(v.end.reason)) return { eligible: false, reason: `end reason not recoverable: ${v.end.reason}`, log: true };
    return { eligible: true, endedAt: v.end.at };
}

const stamp = (now: number) => new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'z').toLowerCase();

// One qualify task and one recovery run task with fresh ids: finished task ids never run again.
export function recoveryProposal(side: string, account: string, endedAt: number, now: number) {
    const s = stamp(now), qualify = `${side}-recovery-qualified-${s}`;
    return {
        reason: `Authenticated recovery of ${account} inside the running coordinator`, capabilities: [],
        tasks: [
            { id: qualify, goal: 'wealth', kind: 'qualify', capability: 'session-recovery-only', dependsOn: [], priority: 90, estimatedMs: 600000, why: 'Qualify authenticated session recovery' },
            { id: `${side}-recover-${account.toLowerCase()}-${s}`, goal: 'wealth', kind: 'run', capability: 'session-recovery-only', account, dependsOn: [qualify],
                repairs: [{ account, endedAt }], sessionRecovery: { account, endedAt }, accept: { counters: { sessionChecked: 1 } },
                priority: 90, estimatedMs: 120000, why: `Authenticated recovery of ${account}'s orphaned session` },
        ],
    };
}

// The folder that receives the coordinator's parked jobs and stop file after a release.
export function archiveDir(root: string, account: string, now: number): string {
    return join(root, '.practice', 'coordinator', 'release-archive', `${stamp(now)}-${account.toLowerCase()}`);
}

// Parked coordinator jobs that still shadow an account's owner job (packages/core/src/coordinator-jobs.ts).
export function parkedAccounts(jobs: readonly any[]): string[] {
    return jobs.filter(j => j?.coordinatorOwner === 'coordinator' && j.enabled === false && typeof j.account === 'string').map(j => j.account);
}

const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const readJson = (file: string, fallback: any) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const log = (line: string) => console.log(`CLOUD_RECOVER ${line}`);

async function main(root: string, dry: boolean): Promise<number> {
    const side = mySide(), coord = join(root, '.practice', 'coordinator'), stopCoordinator = join(root, '.practice', 'stop-coordinator');
    const coordinatorRunning = () => { const o = readJson(join(coord, 'owner.json'), null); return !!o && Number.isSafeInteger(o.pid) && pidAlive(o.pid) && !existsSync(stopCoordinator); };
    if (!coordinatorRunning()) { log('refused: coordinator is not running'); return 1; }
    const state = readJson(join(coord, 'state.json'), { tasks: [] });
    const queued = (account: string) => (state.tasks ?? []).some((t: any) => t.spec?.sessionRecovery?.account?.toLowerCase() === account.toLowerCase() && (t.status === 'pending' || t.status === 'running'));
    const ended = loadEnded(join(root, '.practice', 'swarm-deaths.json'));
    const accounts = [...loadOwners()].filter(([, o]) => o.side === side && o.server === LIVE_SERVER).map(([n]) => n);
    let target: { account: string; endedAt: number } | undefined;
    for (const lower of accounts) {
        const name = [...ended.keys()].find(n => n.toLowerCase() === lower) ?? lower;
        if (queued(name)) { log(`${name}: recovery already queued`); return 0; }
        const proof = readLogoutProof(name, LIVE_SERVER, { root });
        if (proof.state !== 'held') continue;
        // A live worker refreshes its status every few seconds; skip it before reading the claim ref from origin.
        const status = readJson(join(root, '.practice', 'status', `${name}.json`), null);
        if (status && !status.result && Date.now() - status.at < 60_000) continue;
        let claim: ClaimView = null;
        try { claim = readFleetAccountClaim(root, { account: name, server: LIVE_SERVER }) as ClaimView; } catch (e) { log(`${name}: refused: claim unreadable: ${String(e).slice(0, 120)}`); continue; }
        const stopFile = join(root, '.practice', `stop-${name}`), stopText = existsSync(stopFile) ? readFileSync(stopFile, 'utf8') : undefined;
        const e = eligibility({ proof, claim, end: ended.get(name), stopText, pidAlive, host: hostname() });
        if (!e.eligible) { if (e.log) log(`${name}: refused: ${e.reason}`); continue; }
        target = { account: name, endedAt: e.endedAt }; break;
    }
    if (target) {
        const proposal = recoveryProposal(side, target.account, target.endedAt, Date.now());
        log(`${target.account}: submitting ${proposal.tasks.map(t => t.id).join(', ')} (endedAt ${target.endedAt})`);
        if (dry) return 0;
        const file = join(root, '.practice', 'cloud-recover', `${proposal.tasks[1]!.id}.json`);
        mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, JSON.stringify(proposal, null, 1) + '\n');
        if (!(await run(root, ['--submit', file]))) { log(`${target.account}: submit failed`); return 1; }
        const runId = proposal.tasks[1]!.id, deadline = Date.now() + 15 * 60_000;
        for (;;) {
            const task = (readJson(join(coord, 'state.json'), { tasks: [] }).tasks ?? []).find((t: any) => t.spec?.id === runId);
            if (task?.status === 'succeeded') break;
            if (task?.status === 'failed' || Date.now() > deadline) { log(`${target.account}: recovery ${task?.status ?? 'timed out'} (${runId}); no retry`); return 1; }
            await Bun.sleep(5000);
        }
        const proof = readLogoutProof(target.account, LIVE_SERVER, { root });
        log(`${target.account}: recovery succeeded (${runId}); logout proof ${proof.state}`);
        if (proof.state !== 'confirmed') return 1;
    }
    // A finished recovery leaves a parked coordinator job that keeps the account from its owner job; release it.
    const parked = parkedAccounts(readJson(join(coord, 'jobs.json'), { jobs: [] }).jobs ?? []);
    if (!parked.length || (state.tasks ?? []).some((t: any) => t.status === 'running')) return 0;
    if (dry) { log(`would release parked jobs for ${parked.join(', ')}`); return 0; }
    return (await release(root, parked)) ? 0 : 1;
}

async function run(root: string, args: string[]): Promise<boolean> {
    const p = Bun.spawn(['bun', 'packages/router/src/coordinator-cli.ts', ...args], { cwd: root, stdout: 'inherit', stderr: 'inherit', windowsHide: true });
    return (await p.exited) === 0;
}

// Stop the coordinator (its swarm and workers are detached and keep running), move its parked jobs and stop file into
// an archive folder, then start it again; it adopts the running swarm.
async function release(root: string, parked: string[]): Promise<boolean> {
    const coord = join(root, '.practice', 'coordinator'), owner = readJson(join(coord, 'owner.json'), null);
    if (!(await run(root, ['--stop']))) { log('release: coordinator stop failed'); return false; }
    const deadline = Date.now() + 120_000;
    while (owner && pidAlive(owner.pid)) { if (Date.now() > deadline) { log('release: coordinator did not exit; jobs.json left in place'); return false; } await Bun.sleep(2000); }
    const dir = archiveDir(root, parked[0]!, Date.now()); mkdirSync(dir, { recursive: true });
    for (const f of [join(coord, 'jobs.json'), join(root, '.practice', 'stop-coordinator')]) if (existsSync(f)) renameSync(f, join(dir, f.split('/').pop()!));
    const env = { ...process.env }; delete env.SWARM_PLAN;
    mkdirSync(join(root, '.practice', 'swarm-logs'), { recursive: true });
    const out = openSync(join(root, '.practice', 'swarm-logs', 'coordinator.log'), 'a');
    spawn('bun', ['packages/router/src/coordinator-cli.ts', '--run'], { cwd: root, env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    log(`released ${parked.join(', ')}; parked jobs archived in ${dir}; coordinator restarted`);
    return true;
}

if (import.meta.main) {
    const rootArg = process.argv.find(a => a.startsWith('--root='))?.slice(7);
    process.exit(await main(resolve(rootArg ?? join(import.meta.dir, '..')), process.argv.includes('--dry')));
}
