// Shares fleet state between the two machines through git, on the fleet-data branch in its own worktree
// (.practice/fleet-data), never in the code checkout: pulls the other side's orders, receipts and snapshot, writes
// this side's bank snapshot (fleet/snapshots/<side>.json: name, server, bank, pack, worn, skill levels and completed quests of
// this side's listed accounts from .practice/status, never practice bots or credentials; an account with no local status,
// or an older one, keeps its published row, so a fresh cloud container does not erase what the side last saw), this side's claim
// (fleet/claims/<side>.json: the knight spots, pens and shops the enabled jobs of this side's plan hold, SWARM_PLAN or
// swarm.json merged with the coordinator's jobs, for accounts seen in the world within CLAIM_MAX_AGE_MS, so other sides'
// planners stay off them while a job the swarm has not admitted for hours holds nothing) and this side's live
// assignments (fleet/plans/<side>.json: the same merged plan, as scripts/swarm.ts runs it, so other machines and audits
// see what runs), commits fleet/ and pushes.
// fleet/leases/<side>.json mirrors the controller heartbeat for fleet-data readers and old controllers.
// New controllers acquire their admission lease on a separate per-side ref before writing a heartbeat.
// Usage: bun scripts/fleet-sync.ts [--no-push]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_WORKTREE, loadOwners, mySide, nextLease, readLease, leaseHeldElsewhere, thisHost, type Lease } from '../packages/core/src/fleet';
import { CLAIM_MAX_AGE_MS, claimFor, recoveringOwnerJobs } from '../packages/planner/src/autopilot';
import { mergeJobs, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { transferFleetOwnersLocked, withFleetDataWrite } from './fleet-owner-claim';
import { readAllFleetAccountClaims, readHeldFleetTradeClaims, releaseFleetTradeClaim, type FleetTradeClaim } from '../packages/core/src/fleet-trade-claim';
import { allLeaseLastSeen, fleetGitWindow } from '../packages/core/src/fleet-lease';
import { describeMoves, planTransfers, type OwnerRow, type SideView } from '../packages/core/src/fleet-assign';
import { hasCredential } from '../packages/core/src/fleet-vault';
import { canonicalRows, readSnapshotFiles, type SnapshotFile } from '../packages/core/src/fleet-snapshots';
import { loadEnded, swarmWroteStop } from './swarm';
import { terminalTradeReceipt, validOrder } from './fleet-trade-settlement';

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
            ...(Array.isArray(s.bank) && Number.isFinite(s.bankAt) && s.bankAt > 0 && s.bankAt <= s.at ? { bankAt: s.bankAt } : {}),
            skills: (s.skills ?? []).map((k: any) => ({ name: k.name, level: k.level })),
            // No field when the journal was never read, so readers see unknown and not zero completed.
            ...(Array.isArray(s.quests) && s.quests.some((q: any) => q.state !== 'unknown') ? { quests: s.quests.filter((q: any) => q.state === 'complete').map((q: any) => q.name) } : {}),
        });
    }
    // Published rows keep their order and a replaced row its place; new accounts follow in status order.
    return { side, at: now, accounts: [...by.values()] };
}
// This side's published rows, plus the canonical row (packages/core/src/fleet-snapshots.ts) of each account it owns and
// has no row for: an account it adopted keeps its last observation from the side that ran it, so no reader sees it
// start from nothing before its first login here.
export function carriedPrior(prior: readonly any[], files: readonly SnapshotFile[], side: string, owners: ReturnType<typeof loadOwners>): any[] {
    const have = new Set(prior.filter(r => typeof r?.name === 'string').map(r => r.name.toLowerCase()));
    const rows = canonicalRows(files.filter(f => f.side !== side), n => owners.get(n.toLowerCase())?.side);
    const carried = [...rows.values()].filter(r => owners.get(r.name.toLowerCase())?.side === side && !have.has(r.name.toLowerCase()))
        .map(({ side: _from, ...r }) => r);
    return [...prior, ...carried];
}
// A session whose plan has no jobs has nothing to publish: it keeps this side's claim and plan while the published claim
// is fresh and holds resources, or the published plan is fresh and holds jobs (a Ranged or quest job holds no exclusive
// resource, so its claim is empty while its plan is not), since another session of the same side (a fresh cloud container
// beside the one that runs the swarm) wrote them from the jobs it runs. Older than CLAIM_MAX_AGE_MS, both have aged out anyway.
export function keepPublished(jobs: readonly any[], claim: { at?: number; resources?: unknown[] } | null | undefined, now = Date.now(), plan?: { at?: number; jobs?: unknown[] } | null): boolean {
    const fresh = (p: { at?: number } | null | undefined, held: unknown) => !!p && Number.isFinite(p.at) && now - p.at! < CLAIM_MAX_AGE_MS && Array.isArray(held) && held.length > 0;
    return jobs.length === 0 && (fresh(claim, claim?.resources) || fresh(plan, plan?.jobs));
}
// The accounts of the side's snapshot rows seen within CLAIM_MAX_AGE_MS: a bot writes its status every few ticks, and
// the snapshot keeps the newest `at` of the status file and the published row, so a job of an account older than that
// is one the swarm has not run for hours and its spot, pen or shop is free for the other sides' planners.
export function activeAccounts(rows: readonly any[], now = Date.now()): (account: string) => boolean {
    const seen = new Map(rows.filter(r => typeof r?.name === 'string' && Number.isFinite(r.at)).map(r => [r.name.toLowerCase(), r.at as number]));
    return a => now - (seen.get(a.toLowerCase()) ?? -Infinity) < CLAIM_MAX_AGE_MS;
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
    const p = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true,
        timeout: 15_000, env: {...process.env, GIT_TERMINAL_PROMPT: '0'} });
    return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

// The fleet-data worktree: the remote branch when it exists, else a new branch from the current commit (fleet/ seed).
// The fetch names the remote-tracking ref: a clone of master alone (a Codex cloud checkout) has no refspec for
// fleet-data, so a plain `git fetch origin fleet-data` leaves origin/fleet-data missing. A branch that exists on the
// remote but cannot be read here is an error, never a new fleet-data from HEAD: that branch holds the code history,
// and its first pull tries to replay master onto the published fleet data (live: a Codex container stopped on a
// conflict in packages/dashboard/goals.ts).
export const FETCH_FLEET_DATA = ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`] as const;
export function ensureWorktree(dir = FLEET_WORKTREE, base = root): string {
    if (existsSync(join(dir, '.git'))) return dir;
    git(base, ...FETCH_FLEET_DATA);
    const remote = git(base, 'rev-parse', '--verify', `origin/${BRANCH}`).ok;
    if (!remote && git(base, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok) throw Error(`fleet worktree: origin has ${BRANCH} but it could not be fetched`);
    const local = git(base, 'rev-parse', '--verify', BRANCH).ok;
    const add = local ? git(base, 'worktree', 'add', dir, BRANCH) : remote ? git(base, 'worktree', 'add', '-b', BRANCH, dir, `origin/${BRANCH}`) : git(base, 'worktree', 'add', '-b', BRANCH, dir, 'HEAD');
    if (!add.ok) throw Error(`fleet worktree: ${add.out}`);
    git(dir, 'branch', '--set-upstream-to', `origin/${BRANCH}`);
    return dir;
}

// Why the fleet-data worktree cannot sync, or null: a rebase or merge stopped in it, an unmerged file, or a HEAD that
// holds more than STRAY_COMMITS commits of the code history (origin/master) that the published branch lacks. The
// fleet-data branch never merges master, so only a branch made from the code holds those (see ensureWorktree);
// unpublished fleet data, however many commits, never counts. The caller fetched origin/fleet-data and holds the
// fleet-data write lock, so a rebase marker here is one no running sync owns.
export const STRAY_COMMITS = 200;
export function worktreeProblem(dir: string, stray = STRAY_COMMITS): string | null {
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').out;
    if (['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some(f => existsSync(join(gitDir, f)))) return 'a rebase or merge stopped in it';
    if (git(dir, 'diff', '--name-only', '--diff-filter=U').out) return 'it has unmerged files';
    // Commits HEAD has beyond the published branch, less those that are not in origin/master either: the code ones.
    const count = (...not: string[]) => { const r = git(dir, 'rev-list', '--count', 'HEAD', '--not', ...not); return r.ok ? Number(r.out) : NaN; };
    const fromCode = git(dir, 'rev-parse', '--verify', '-q', 'origin/master').ok ? count(`origin/${BRANCH}`) - count(`origin/${BRANCH}`, 'origin/master') : NaN;
    if (Number.isFinite(fromCode) && fromCode > stray) return `HEAD holds ${fromCode} commits of origin/master that origin/${BRANCH} lacks: it is not the fleet-data branch`;
    return null;
}

// A worktree on a detached HEAD commits each sync, but the push sends the branch, which does not move: the sync
// reports ok and publishes nothing. This puts the branch on HEAD again. It does not touch a rebase in progress, and
// it refuses when the branch holds a commit that HEAD lacks.
export function reattach(dir: string, branch = BRANCH): boolean {
    if (git(dir, 'symbolic-ref', '-q', 'HEAD').ok) return false;
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').out;
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return false;
    if (git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok && !git(dir, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD').ok)
        throw Error(`reattach: HEAD is detached and ${branch} holds commits that HEAD lacks`);
    const moved = git(dir, 'checkout', '-B', branch);
    if (!moved.ok) throw Error(`reattach: ${moved.out}`);
    return true;
}

export function releasePublishedTradeClaims(
    claims: readonly FleetTradeClaim[], side: string, read: (path: string) => any,
    release: (claim: FleetTradeClaim) => void, now = Date.now(),
): number {
    let released = 0;
    for (const claim of claims) {
        if (claim.phase !== 'held' || claim.side !== side) continue;
        const order = read(`orders/${claim.orderId}.json`), receipt = read(`receipts/${claim.orderId}.${claim.role}.json`);
        if (!validOrder(order) || order.id !== claim.orderId || !receipt || !terminalTradeReceipt(order, claim.role, receipt, now)
            || receipt.claim !== claim.nonce || receipt.side !== claim.side || receipt.account.toLowerCase() !== claim.account
            || receipt.server.toLowerCase() !== claim.server || receipt.logout!.at < claim.at) continue;
        release(claim);
        released++;
    }
    return released;
}

// A trade session that dropped. Its own receipt stays `prepared` or reads `reconcile` (no logout proof), so the rule
// above never frees its claim, a trade claim does not expire, and the account has no job until a person runs the hand
// procedure (README: reconcile both accounts, confirm the logout, release the matching nonce). The records prove that
// by themselves in one case, and only then is the claim released here:
// - this account's worker is gone. A worker that ended wrote `reconcile` as its session closed. One that died left
//   `prepared`: then the order's window must have been over for DROPPED_CLAIM_MS and the claim have stood that long (a
//   trade worker waits no longer than its window, and by then the game server has dropped a session with no client,
//   the premise of ORPHAN_CLAIM_MS for another side's swarm claim, packages/core/src/fleet-trade-claim.ts);
// - the partner's receipt is terminal and `failed`: its logout is proved and it moved nothing (terminalTradeReceipt).
//   A trade moves both stacks at once, so nothing left this account either;
// - this account's receipt names this claim, counts 0 and shows no change of its inventory.
// Live claude-cloud: UnderMyKilt had no job under such a claim (its receipt `reconcile` 0, the partner's `failed` 0)
// until a person released it.
// A second case needs no hour: the partner never came. A party writes its `prepared` receipt when it takes its claim,
// before any trade, and takes no claim once the window is over (scripts/fleet-trade.ts assertTradeAdmission). So when
// the partner's side has published its fleet data UNANSWERED_GRACE_MS or more after the window's end (the time stamp
// of its claims, lease or snapshot file, written by the sync that commits its receipts) and no receipt of the partner
// is there, the partner took no claim and nothing moved. This account's own worker has ended: its receipt reads
// `reconcile` (written as its session ended), counts 0 and shows no change of its inventory. Live claude-cloud:
// TrouserSnake and UnderMyKilt each waited for a local giver that never logged in, the relay cut both sessions, and
// both stood with no job under a claim the first case never frees (it wants the partner's receipt).
// A third case needs no word from the partner at all: the account's own worker saw no trade screen open in its whole
// session (`screen: false` in its receipt, scripts/fleet-trade.ts watchTradeScreen). A worker accepts an offer only on
// a screen it has seen and nothing moves without both accepts, so the trade did not connect, whatever the partner's
// receipt reads. The worker has ended (`reconcile`) and the window is over, so nobody retries under this order. Live
// claude-cloud: the relay cut both parties of a coin order of this side while they waited; both receipts read
// `reconcile` 0, neither `failed`, and both accounts stood with no job.
// Every other case keeps the claim for a person.
export const DROPPED_CLAIM_MS = 60 * 60_000, UNANSWERED_GRACE_MS = 2 * 60_000;
export function droppedTradeClaims(claims: readonly FleetTradeClaim[], side: string, read: (path: string) => any, now = Date.now()): FleetTradeClaim[] {
    const publishedAt = (s: string) => Math.max(...['claims', 'leases', 'snapshots'].map(d => { const at = read(`${d}/${s}.json`)?.at; return Number.isSafeInteger(at) ? at as number : 0; }));
    // An account with no owners entry is the local side's (packages/core/src/fleet.ts).
    const sideOf = (account: string): string => {
        const owners: Record<string, { side?: unknown }> = read('owners.json')?.accounts ?? {};
        const entry = Object.entries(owners).find(([n]) => n.toLowerCase() === account.toLowerCase())?.[1];
        return typeof entry?.side === 'string' ? entry.side : 'local';
    };
    return claims.filter(claim => {
        if (claim.phase !== 'held' || claim.side !== side) return false;
        const order = read(`orders/${claim.orderId}.json`), other = claim.role === 'from' ? 'to' : 'from';
        if (!validOrder(order) || order.id !== claim.orderId) return false;
        const own = read(`receipts/${claim.orderId}.${claim.role}.json`), partner = read(`receipts/${claim.orderId}.${other}.json`);
        const ownIdle = !!own && own.version === 2 && (own.state === 'prepared' || own.state === 'reconcile') && own.claim === claim.nonce && own.side === claim.side
            && typeof own.account === 'string' && own.account.toLowerCase() === claim.account && own.count === 0
            && (!own.inventory || own.inventory.before === own.inventory.after);
        if (!ownIdle) return false;
        if (own.state === 'reconcile' && own.screen === false && now >= order.end) return true;
        if (!partner) {
            const partnerSide = sideOf(order[other]);
            return now >= order.end && own.state === 'reconcile' && (partnerSide === side ? now : publishedAt(partnerSide)) >= order.end + UNANSWERED_GRACE_MS;
        }
        // A worker that ended wrote `reconcile`; one that died left `prepared`, and only the hour says its session is gone.
        const ended = own.state === 'reconcile' || now - claim.at >= DROPPED_CLAIM_MS && now - order.end >= DROPPED_CLAIM_MS;
        return ended && terminalTradeReceipt(order, other, partner, now) && partner.state === 'failed';
    });
}

function releaseSyncedTrades(dir: string, side: string) {
    const receiptDir = join(dir, 'fleet', 'receipts');
    if (!existsSync(receiptDir)) return;
    const accounts = readdirSync(receiptDir).filter(name => name.endsWith('.json')).flatMap(name => {
        try {
            const r = JSON.parse(readFileSync(join(receiptDir, name), 'utf8'));
            return r?.version === 2 && r.side === side && typeof r.account === 'string' && /^[A-Za-z0-9]{1,12}$/.test(r.account)
                && ['settled', 'failed', 'prepared', 'reconcile'].includes(r.state) ? [r.account] : [];
        } catch { return []; }
    });
    if (!accounts.length) return;
    const read = (path: string) => {
        const committed = git(dir, 'show', 'HEAD:fleet/' + path);
        try { return committed.ok ? JSON.parse(committed.out) : null; } catch { return null; }
    };
    const held = readHeldFleetTradeClaims(root, [...new Set(accounts)]);
    releasePublishedTradeClaims(held, side, read, claim => releaseFleetTradeClaim(root, claim));
    for (const claim of droppedTradeClaims(held, side, read)) {
        releaseFleetTradeClaim(root, claim);
        console.log(`FLEET_SYNC released the dropped trade claim of ${claim.account} for order ${claim.orderId}: the partner moved nothing (a failed receipt, or no claim by the end of the window)`);
    }
}

// The pull comes before this sync commits, so files that a trade wrote since the last sync are still uncommitted. A
// receipt that the last sync committed and a later trade step rewrote is a tracked change, and `pull --rebase` refuses
// it ("cannot pull with rebase: You have unstaged changes"); every later sync then fails the same way. --autostash
// sets those changes aside for the rebase and puts them back, so this sync commits them.
export function pullFleetData(dir: string): void {
    const pull = git(dir, 'pull', '--rebase', '--autostash', 'origin', BRANCH);
    if (!pull.ok) throw Error(`pull: ${pull.out}`);
}

export function runSync(push = true): string {
    const dir = ensureWorktree();
    git(root, ...FETCH_FLEET_DATA);
    const problem = worktreeProblem(dir);
    if (problem) throw Error(`fleet worktree ${dir}: ${problem}; scripts/cloud-side.ts replaces it, or remove it with git worktree remove --force`);
    reattach(dir);
    const hasRemote = git(dir, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok;
    if (hasRemote) pullFleetData(dir);
    const statusDir = join(root, '.practice', 'status');
    const statuses = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } }) : [];
    const owners = loadOwners(join(dir, 'fleet', 'owners.json'));
    mkdirSync(join(dir, 'fleet', 'snapshots'), { recursive: true });
    const file = join(dir, 'fleet', 'snapshots', `${mySide()}.json`);
    const prior: any[] = (() => { try { const a = JSON.parse(readFileSync(file, 'utf8')).accounts; return Array.isArray(a) ? a : []; } catch { return []; } })();
    const snap = snapshot(statuses, mySide(), owners, Date.now(), carriedPrior(prior, readSnapshotFiles(join(dir, 'fleet', 'snapshots')), mySide(), owners));
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
        const coordinatorJobs = readCoordinatorJobs(root).jobs, merged = mergeJobs(jobs, coordinatorJobs);
        claim = claimFor([...merged, ...recoveringOwnerJobs(jobs, coordinatorJobs)], snap.side, a => owners.get(a.toLowerCase())?.side ?? 'local', Date.now(), activeAccounts(snap.accounts));
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
    // The side card other sides' adoption reads: room for accounts and the owner's pauses. Only the session running
    // the side's controller writes it, and only on a change.
    const plan = (() => { try { return JSON.parse(readFileSync(planFile, 'utf8')); } catch { return null; } })();
    const capacity = sideCapacity(plan);
    if (mine && capacity !== null) {
        // The registry spelling: the swarm names a stop file after the job's account, and Linux paths are case sensitive.
        const raw = (() => { try { return JSON.parse(readFileSync(join(dir, 'fleet', 'owners.json'), 'utf8')).accounts ?? {}; } catch { return {}; } })() as Record<string, { side?: string }>;
        const owned = Object.keys(raw).filter(n => owners.get(n.toLowerCase())?.side === snap.side);
        const died = (() => { try { return [...loadEnded(join(root, '.practice', 'swarm-deaths.json'))].filter(([, e]) => /^died\b/.test(e.reason)).map(([n]) => n); } catch { return []; } })();
        const card = sideCard(snap.side, capacity, owned, (n: string) => { try { return readFileSync(join(root, '.practice', `stop-${n}`), 'utf8'); } catch { return undefined; } }, died);
        const cardFile = join(dir, 'fleet', 'sides', `${snap.side}.json`);
        if (JSON.stringify(published(cardFile)) !== JSON.stringify(card)) { mkdirSync(join(dir, 'fleet', 'sides'), { recursive: true }); writeFileSync(cardFile, JSON.stringify(card) + '\n'); }
    }
    git(dir, 'add', '--', 'fleet');
    // The sealed credentials (packages/core/src/fleet-vault.ts): master's .gitignore names the directory, so add it
    // by name; this branch is the vault's only home.
    if (existsSync(join(dir, 'fleet', 'vault'))) git(dir, 'add', '-f', '--', 'fleet/vault');
    const staged = !git(dir, 'diff', '--cached', '--quiet').ok;
    if (staged) { const c = git(dir, 'commit', '-m', `fleet: ${snap.side} sync (${snap.accounts.length} accounts)`); if (!c.ok) throw Error(`commit: ${c.out}`); }
    const ahead = !hasRemote || git(dir, 'rev-list', '--count', `origin/${BRANCH}..HEAD`).out !== '0';
    if (push && ahead) { const p = git(dir, 'push', '-u', 'origin', BRANCH); if (!p.ok) throw Error(`push: ${p.out}`); }
    if (push) releaseSyncedTrades(dir, snap.side);
    let adopted = '';
    if (push && mine && capacity !== null && process.env.FLEET_ADOPT !== '0') {
        try { adopted = ` adoption=${adoptionPass(dir, snap.side, capacity) || 'none'}`; }
        catch (e) { adopted = ` adoption=failed: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`; }
    }
    return `side=${snap.side} accounts=${snap.accounts.length} claims=${claim ? claim.resources.length : jobs ? 'kept: published by the session running this side' : 'unreadable plan'} lease=${leaseNote} committed=${staged} pushed=${push && ahead}${adopted}`;
}

// The number of accounts a side holds work for: its plan's fleetCapacity, else its maxBots. null: no readable plan.
export function sideCapacity(plan: any): number | null {
    const n = plan?.fleetCapacity ?? plan?.maxBots;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// This side's card: its capacity, the accounts it owns that an owner's stop file pauses, and whether the owner
// stopped its whole swarm (a stop file the swarm wrote itself is no owner's pause).
// `owned`: the registry spelling of each account this side owns; a stop file is looked up under that spelling and in
// lower case, and published in lower case. `died`: the accounts whose swarm end is a death (scripts/swarm.ts never
// starts one again until a person repairs it), so no other side adopts and restarts one either.
export function sideCard(side: string, capacity: number, owned: readonly string[], stopText: (name: string) => string | undefined, died: readonly string[] = []) {
    const ownerStop = (n: string) => [n, n.toLowerCase()].some(s => { const t = stopText(s); return t !== undefined && !swarmWroteStop(t); });
    const paused = [...new Set(owned.filter(ownerStop).map(n => n.toLowerCase()))].sort();
    const mine = new Set(owned.map(n => n.toLowerCase()));
    const dead = [...new Set(died.map(n => n.toLowerCase()).filter(n => mine.has(n)))].sort();
    const swarm = stopText('swarm');
    return { side, capacity, paused, died: dead, stopped: swarm !== undefined && !swarmWroteStop(swarm) };
}

// One adoption pass (packages/core/src/fleet-assign.ts) after this side's sync has pushed: reads every side's lease,
// card and every account's claim, and moves the planned owner rows with a compare-and-swap push.
function adoptionPass(dir: string, side: string, capacity: number): string {
    const moves = planAdoption(dir, side, capacity);
    if (!moves.length) return '';
    const landed = transferFleetOwnersLocked(root, moves, dir);
    return landed.length ? describeMoves(landed) : 'lost to another side';
}

export function planAdoption(dir: string, side: string, capacity: number) {
    const git = fleetGitWindow(root, 'fleet adoption', 60_000);
    const seen = allLeaseLastSeen(git, join(dir, 'fleet', 'leases'));
    const raw = JSON.parse(readFileSync(join(dir, 'fleet', 'owners.json'), 'utf8')).accounts as Record<string, OwnerRow>;
    const names = new Set([...Object.values(raw).map(o => o.side), ...seen.keys()]);
    const sides: Record<string, SideView> = {};
    for (const s of names) {
        let card: any = null;
        try { card = JSON.parse(readFileSync(join(dir, 'fleet', 'sides', `${s}.json`), 'utf8')); } catch { /* no card: no room, no pauses */ }
        sides[s] = { seen: seen.get(s) ?? null, capacity: Number.isSafeInteger(card?.capacity) ? card.capacity : undefined,
            paused: Array.isArray(card?.paused) ? card.paused : undefined, died: Array.isArray(card?.died) ? card.died : undefined, stopped: card?.stopped === true };
    }
    return planTransfers({ side, capacity, owners: raw, sides, claims: readAllFleetAccountClaims(git), canLogin: n => hasCredential(n), now: Date.now() });
}

if (import.meta.main && process.argv.includes('--adopt-dry')) {
    // What this side's next adoption pass would move, with no write: `--capacity <n>` overrides the plan's.
    const at = process.argv.indexOf('--capacity'), plan = (() => { try { return JSON.parse(readFileSync(resolve(process.env.SWARM_PLAN ?? join(root, 'swarm.json')), 'utf8')); } catch { return null; } })();
    const capacity = at > 0 ? Number(process.argv[at + 1]) : sideCapacity(plan) ?? 0;
    const moves = planAdoption(ensureWorktree(), mySide(), capacity);
    console.log(`ADOPT-DRY side=${mySide()} capacity=${capacity} moves=${moves.length}${moves.length ? ' ' + describeMoves(moves) : ''}`);
} else if (import.meta.main) {
    try { console.log(`RESULT ok fleet-sync ${await withFleetDataWrite(root, () => runSync(!process.argv.includes('--no-push')))}`); }
    catch (e) { console.log(`RESULT fail fleet-sync ${String(e)}`); process.exit(1); }
}
