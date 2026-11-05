// Shares fleet state between the two machines through git, on the fleet-data branch in its own worktree
// (.practice/fleet-data), never in the code checkout: pulls the other side's orders, receipts and snapshot, writes
// this side's bank snapshot (fleet/snapshots/<side>.json: name, server, bank, pack, worn, skill levels and completed quests of
// this side's listed accounts from .practice/status, never practice bots or credentials; an account with no local status,
// or an older one, keeps its published row, so a fresh cloud container does not erase what the side last saw), this side's claim
// (fleet/claims/<side>.json: the knight spots, pens and shops the enabled jobs of this side's plan hold, SWARM_PLAN or
// swarm.json merged with the coordinator's jobs, so other sides' planners stay off them) and this side's live
// assignments (fleet/plans/<side>.json: the same merged plan, as scripts/swarm.ts runs it, so other machines and audits
// see what runs), commits fleet/ and pushes.
// The side's lease (fleet/leases/<side>.json) is this machine's live controller heartbeat (.practice/swarm-state.json,
// written every swarm tick) while no other machine holds a fresh one; scripts/swarm.ts refuses to start against it.
// Usage: bun scripts/fleet-sync.ts [--no-push]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_WORKTREE, loadOwners, mySide, nextLease, readLease, leaseHeldElsewhere, thisHost, type Lease } from '../packages/core/src/fleet';
import { CLAIM_MAX_AGE_MS, claimFor } from '../packages/planner/src/autopilot';
import { mergeJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';

const root = resolve(import.meta.dir, '..');
const BRANCH = 'fleet-data', HEARTBEAT_MAX_AGE_MS = 60_000;
const rows = (r: any[] | undefined) => (r ?? []).map((i: any) => ({ id: i.baseId ?? i.id, name: i.name, count: i.count }));
// `prior` is the side's published snapshot rows: a row stays when its account has no local status or a staler one.
export function snapshot(statuses: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now(), prior: readonly any[] = []) {
    const mine = (s: any) => typeof s?.name === 'string' && owners.get(s.name.toLowerCase())?.side === side && owners.get(s.name.toLowerCase())?.server === String(s.server).toLowerCase();
    const by = new Map<string, any>(prior.filter(mine).map(r => [r.name.toLowerCase(), r]));
    for (const s of statuses.filter(mine)) {
        const kept = by.get(s.name.toLowerCase());
        if (kept && Number.isFinite(kept.at) && !(Number(s.at) >= kept.at)) continue;
        by.set(s.name.toLowerCase(), {
            name: s.name, server: s.server, at: s.at, bank: rows(s.bank), inventory: rows(s.inventory), equipment: rows(s.equipment),
            skills: (s.skills ?? []).map((k: any) => ({ name: k.name, level: k.level })),
            // No field when the journal was never read, so readers see unknown and not zero completed.
            ...(Array.isArray(s.quests) && s.quests.some((q: any) => q.state !== 'unknown') ? { quests: s.quests.filter((q: any) => q.state === 'complete').map((q: any) => q.name) } : {}),
        });
    }
    // Published rows keep their order and a replaced row its place; new accounts follow in status order.
    return { side, at: now, accounts: [...by.values()] };
}
// A session whose plan has no jobs has nothing to publish: it keeps this side's claim and plan while the published claim
// is fresh and holds resources, or the published plan is fresh and holds jobs (a Ranged or quest job holds no exclusive
// resource, so its claim is empty while its plan is not), since another session of the same side (a fresh cloud container
// beside the one that runs the swarm) wrote them from the jobs it runs. Older than CLAIM_MAX_AGE_MS, both have aged out anyway.
export function keepPublished(jobs: readonly any[], claim: { at?: number; resources?: unknown[] } | null | undefined, now = Date.now(), plan?: { at?: number; jobs?: unknown[] } | null): boolean {
    const fresh = (p: { at?: number } | null | undefined, held: unknown) => !!p && Number.isFinite(p.at) && now - p.at! < CLAIM_MAX_AGE_MS && Array.isArray(held) && held.length > 0;
    return jobs.length === 0 && (fresh(claim, claim?.resources) || fresh(plan, plan?.jobs));
}
// The jobs of this side's own accounts, without the main account and without job notes. The swarm plan file stays
// uncommitted while it runs; this copy is what other sides read.
const PLAN_FIELDS = ['account', 'accounts', 'script', 'args', 'env', 'enabled', 'standing', 'repeat', 'goal', 'role', 'template', 'autopilot', 'resources'] as const;
export function planView(jobs: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now()) {
    const names = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter((n: unknown): n is string => typeof n === 'string');
    const own = jobs.filter(j => j?.role !== 'main' && names(j).length > 0 && names(j).every(n => owners.get(n.toLowerCase())?.side === side));
    return { side, at: now, jobs: own.map(j => Object.fromEntries(PLAN_FIELDS.filter(k => j[k] !== undefined).map(k => [k, j[k]]))) };
}
const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

// The fleet-data worktree: the remote branch when it exists, else a new branch from the current commit (fleet/ seed).
export function ensureWorktree(dir = FLEET_WORKTREE): string {
    if (existsSync(join(dir, '.git'))) return dir;
    git(root, 'fetch', 'origin', BRANCH);
    const remote = git(root, 'rev-parse', '--verify', `origin/${BRANCH}`).ok;
    const local = git(root, 'rev-parse', '--verify', BRANCH).ok;
    const add = local ? git(root, 'worktree', 'add', dir, BRANCH) : remote ? git(root, 'worktree', 'add', '-b', BRANCH, dir, `origin/${BRANCH}`) : git(root, 'worktree', 'add', '-b', BRANCH, dir, 'HEAD');
    if (!add.ok) throw Error(`fleet worktree: ${add.out}`);
    git(dir, 'branch', '--set-upstream-to', `origin/${BRANCH}`);
    return dir;
}

export function runSync(push = true): string {
    const dir = ensureWorktree();
    const hasRemote = git(dir, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok;
    if (hasRemote) { const pull = git(dir, 'pull', '--rebase', 'origin', BRANCH); if (!pull.ok) throw Error(`pull: ${pull.out}`); }
    const statusDir = join(root, '.practice', 'status');
    const statuses = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } }) : [];
    const owners = loadOwners(join(dir, 'fleet', 'owners.json'));
    mkdirSync(join(dir, 'fleet', 'snapshots'), { recursive: true });
    const file = join(dir, 'fleet', 'snapshots', `${mySide()}.json`);
    const prior: any[] = (() => { try { const a = JSON.parse(readFileSync(file, 'utf8')).accounts; return Array.isArray(a) ? a : []; } catch { return []; } })();
    const snap = snapshot(statuses, mySide(), owners, Date.now(), prior);
    // Write only when an account changed: the time stamp alone makes no commit.
    if (JSON.stringify(prior) !== JSON.stringify(snap.accounts)) writeFileSync(file, JSON.stringify(snap) + '\n');
    // The claim's time stamp is its freshness, so every sync rewrites it. An unreadable plan writes nothing: the old
    // claim ages out instead of releasing spots the plan may still hold.
    const planFile = resolve(process.env.SWARM_PLAN ?? join(root, 'swarm.json'));
    const jobs = (() => { try { const p = JSON.parse(readFileSync(planFile, 'utf8')); return Array.isArray(p.jobs) ? p.jobs as any[] : null; } catch { return null; } })();
    let claim: ReturnType<typeof claimFor> | null = null;
    const claimFile = join(dir, 'fleet', 'claims', `${snap.side}.json`), out = join(dir, 'fleet', 'plans', `${snap.side}.json`);
    const published = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
    if (jobs && !keepPublished(mergeJobs(jobs, readCoordinatorJobs(root).jobs), published(claimFile), Date.now(), published(out))) {
        const merged = mergeJobs(jobs, readCoordinatorJobs(root).jobs);
        claim = claimFor(merged, snap.side, a => owners.get(a.toLowerCase())?.side ?? 'local');
        mkdirSync(join(dir, 'fleet', 'claims'), { recursive: true }); writeFileSync(claimFile, JSON.stringify(claim) + '\n');
        const view = planView(merged, snap.side, owners);
        mkdirSync(join(dir, 'fleet', 'plans'), { recursive: true });
        const was = JSON.stringify(published(out)?.jobs ?? '');
        if (was !== JSON.stringify(view.jobs)) writeFileSync(out, JSON.stringify(view, null, 1) + '\n');
    }
    // A controller heartbeat older than HEARTBEAT_MAX_AGE_MS is a dead controller's last write, not a running one.
    const state = published(join(root, '.practice', 'swarm-state.json'));
    const mine: Lease | null = state && Number.isFinite(state.at) && Date.now() - state.at < HEARTBEAT_MAX_AGE_MS && Number.isSafeInteger(state.controllerPid)
        ? { side: snap.side, host: thisHost(), pid: state.controllerPid, at: state.at } : null;
    const current = readLease(snap.side, join(dir, 'fleet')), lease = nextLease(current, mine);
    if (lease) { mkdirSync(join(dir, 'fleet', 'leases'), { recursive: true }); writeFileSync(join(dir, 'fleet', 'leases', `${snap.side}.json`), JSON.stringify(lease) + '\n'); }
    const leaseNote = lease ? 'ours' : leaseHeldElsewhere(current, thisHost()) ? `held by ${current!.host}` : 'none';
    git(dir, 'add', '--', 'fleet');
    const staged = !git(dir, 'diff', '--cached', '--quiet').ok;
    if (staged) { const c = git(dir, 'commit', '-m', `fleet: ${snap.side} sync (${snap.accounts.length} accounts)`); if (!c.ok) throw Error(`commit: ${c.out}`); }
    const ahead = !hasRemote || git(dir, 'rev-list', '--count', `origin/${BRANCH}..HEAD`).out !== '0';
    if (push && ahead) { const p = git(dir, 'push', '-u', 'origin', BRANCH); if (!p.ok) throw Error(`push: ${p.out}`); }
    return `side=${snap.side} accounts=${snap.accounts.length} claims=${claim ? claim.resources.length : jobs ? 'kept: published by the session running this side' : 'unreadable plan'} lease=${leaseNote} committed=${staged} pushed=${push && ahead}`;
}

if (import.meta.main) {
    try { console.log(`RESULT ok fleet-sync ${runSync(!process.argv.includes('--no-push'))}`); }
    catch (e) { console.log(`RESULT fail fleet-sync ${String(e)}`); process.exit(1); }
}
