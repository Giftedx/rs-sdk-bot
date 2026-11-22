// Fleet data sync: pulls other sides' orders, receipts, and snapshots; writes this side's
// snapshot, resource claim, active plan view (swarm.json + Brain FleetState), controller lease heartbeat,
// side card, and runs optional cross-side adoption cleanly via git fleet-data worktree.
// Usage: bun packages/fleet/src/fleet-sync.ts [--no-push] [--adopt-dry [--capacity N]]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultActivityCatalog, isFleetState, type FleetState } from '../../brain/src/index';
import { handNamed, ruleRoster } from '../../core/src/army-roster';
import { FLEET_WORKTREE, loadOwners, mySide, nextLease, readLease, leaseHeldElsewhere, thisHost, type Lease } from '../../core/src/fleet';
import { describeMoves, planTransfers, type OwnerRow, type SideView } from '../../core/src/fleet-assign';
import { allLeaseLastSeen, fleetGitWindow } from '../../core/src/fleet-lease';
import { transferFleetOwnersLocked, withFleetDataWrite } from '../../core/src/fleet-owner-claim';
import { canonicalRows, readSnapshotFiles, type SnapshotFile } from '../../core/src/fleet-snapshots';
import { readAllFleetAccountClaims, readHeldFleetTradeClaims, releaseFleetTradeClaim, releaseFleetTradeClaims, type FleetTradeClaim } from '../../core/src/fleet-trade-claim';
import { terminalTradeReceipt, validOrder, type TradeReceipt } from '../../core/src/fleet-trade-settlement';
import { hasCredential } from '../../core/src/fleet-vault';
import { fleetStateFile, repoRoot } from '../../core/src/practice-paths';
import { listAttempts, readLogoutProof } from '../../core/src/session-lifecycle';
import { savedProcessAlive } from '../../core/src/session-takeover';
import { loadEnded, swarmWroteStop } from './swarm';
import { CLAIM_MAX_AGE_MS, claimFor, jobAccounts } from './trade-plan';
import { dispatchAccountPlan } from './worker-dispatch';

const root = repoRoot;
const BRANCH = 'fleet-data', HEARTBEAT_MAX_AGE_MS = 60_000;
const nonnegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const observationAt = (value: unknown, at: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0
    && typeof at === 'number' && Number.isFinite(at) && value <= at ? value : null;

const rows = (raw: unknown, kind: 'bank' | 'equipment' | 'inventory' = 'bank') => !Array.isArray(raw) || !raw.every(i => i && nonnegativeInteger(i.baseId ?? i.id)
    && (kind !== 'inventory' || nonnegativeInteger(i.id)) && Number.isSafeInteger(i.count) && i.count > 0) ? null : raw.map(i => ({
        id: kind === 'inventory' ? i.id : i.baseId ?? i.id,
        ...(kind === 'inventory' ? { baseId: i.baseId ?? i.id } : {}),
        ...(typeof i.name === 'string' ? { name: i.name } : {}), count: i.count,
        ...(nonnegativeInteger(i.slot) && (kind === 'equipment' || kind === 'inventory' && i.slot < 28) ? { slot: i.slot } : {}),
    }));

const journalRows = (raw: unknown) => Array.isArray(raw) && raw.length > 0
    && raw.every(q => q && nonnegativeInteger(q.id) && typeof q.name === 'string' && q.name.trim()
        && ['not started', 'started', 'complete', 'unknown'].includes(q.state))
    && new Set(raw.map(q => q.id)).size === raw.length && raw.some(q => q.state !== 'unknown')
    ? raw.map(q => ({ id: q.id, name: q.name, state: q.state })) : null;

const legacyJournalNames = (raw: unknown): string[] | undefined => Array.isArray(raw) && raw.length > 0
    && raw.every(q => q && typeof q === 'object' && !Array.isArray(q) && !('id' in q)
        && typeof q.name === 'string' && q.name.trim() && ['not started', 'started', 'complete', 'unknown'].includes(q.state))
    && new Set(raw.map(q => q.name.trim().toLowerCase())).size === raw.length && raw.some(q => q.state !== 'unknown')
    ? raw.filter(q => q.state === 'complete').map(q => q.name) : undefined;

function durableGuildFacts(raw: any) {
    const qp = raw?.varps?.qp;
    const questStages = Object.fromEntries(Object.entries({ heroquest: 15, legendsquest: 75, mcannon: 11 }).flatMap(([key, final]) => {
        const value = raw?.questStages?.[key];
        return nonnegativeInteger(value) && value > 0 && value <= final ? [[key, value]] : [];
    }));
    const unlocks = Array.isArray(raw?.unlocks) ? [...new Set(raw.unlocks.filter((key: unknown) =>
        typeof key === 'string' && ['prayer-guild', 'dwarf-tower', 'grandtree-glider'].includes(key)))] : [];
    return nonnegativeInteger(qp) || Object.keys(questStages).length || unlocks.length ? {
        ...(nonnegativeInteger(qp) ? { varps: { qp } } : {}),
        ...(Object.keys(questStages).length ? { questStages } : {}),
        ...(unlocks.length ? { unlocks } : {}),
    } : undefined;
}

export function snapshot(statuses: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now(), prior: readonly any[] = []) {
    const mine = (s: any) => typeof s?.name === 'string' && owners.get(s.name.toLowerCase())?.side === side && owners.get(s.name.toLowerCase())?.server === String(s.server).toLowerCase();
    const by = new Map<string, any>(prior.filter(mine).map(r => [r.name.toLowerCase(), r]));
    for (const s of statuses.filter(mine)) {
        const kept = by.get(s.name.toLowerCase());
        if (kept && Number.isFinite(kept.at) && !(Number(s.at) >= kept.at)) continue;
        const incomingBank = rows(s.bank), bank = incomingBank ?? rows(kept?.bank), equipment = rows(s.equipment, 'equipment'), inventory = rows(s.inventory, 'inventory'), p = s.pos;
        const incomingJournal = journalRows(s.quests), journal = incomingJournal ?? journalRows(kept?.questJournal);
        const incomingLegacyQuests = kept?.questJournal == null ? legacyJournalNames(s.quests) : undefined;
        const legacyQuests = incomingLegacyQuests ?? (kept?.questJournal == null && Array.isArray(kept?.quests)
            && kept.quests.every((q: unknown) => typeof q === 'string' && q.trim()) ? [...new Set(kept.quests)] : undefined);
        const completed = journal ? journal.filter(q => q.state === 'complete').map(q => q.name) : legacyQuests;
        const guildFacts = durableGuildFacts(s.guildFacts);
        by.set(s.name.toLowerCase(), {
            name: s.name, server: s.server, at: s.at, bank, inventory, ...(inventory !== null ? { inventoryIds: 'raw' as const } : {}), equipment,
            bankAt: bank ? incomingBank !== null ? observationAt(s.bankAt, s.at) : observationAt(kept?.bankAt, kept?.at) : null,
            ...(typeof s.equipmentObserved === 'boolean' ? { equipmentObserved: equipment !== null && s.equipmentObserved } : {}),
            skills: (Array.isArray(s.skills) ? s.skills : []).filter((k: any) => k && typeof k.name === 'string'
                && Number.isSafeInteger(k.level) && k.level > 0).map((k: any) => ({
                name: k.name, level: k.level,
                ...(nonnegativeInteger(k.currentLevel) ? { currentLevel: k.currentLevel } : {}),
                ...(typeof k.xp === 'number' && Number.isFinite(k.xp) && k.xp >= 0 ? { xp: k.xp } : {}),
            })),
            ...(Number.isSafeInteger(s.combat) && s.combat > 0 ? { combat: s.combat } : {}),
            ...(p && nonnegativeInteger(p.x) && nonnegativeInteger(p.z) && nonnegativeInteger(p.level) && p.level <= 3
                ? { pos: { x: p.x, z: p.z, level: p.level } } : {}),
            ...(guildFacts ? { guildFacts } : {}),
            questJournal: journal,
            questsAt: incomingJournal || incomingLegacyQuests !== undefined ? observationAt(s.questsAt, s.at)
                : journal || completed ? observationAt(kept?.questsAt, kept?.at) : null,
            ...(completed ? { quests: completed } : {}),
        });
    }
    return { side, at: now, accounts: [...by.values()] };
}

export function carriedPrior(prior: readonly any[], files: readonly SnapshotFile[], side: string, owners: ReturnType<typeof loadOwners>): any[] {
    const have = new Set(prior.filter(r => typeof r?.name === 'string').map(r => r.name.toLowerCase()));
    const rows = canonicalRows(files.filter(f => f.side !== side), n => owners.get(n.toLowerCase())?.side);
    const carried = [...rows.values()].filter(r => owners.get(r.name.toLowerCase())?.side === side && !have.has(r.name.toLowerCase()))
        .map(({ side: _from, ...r }) => r);
    return [...prior, ...carried];
}

export function keepPublished(jobs: readonly any[], claim: { at?: number; resources?: unknown[] } | null | undefined, now = Date.now(), plan?: { at?: number; jobs?: unknown[] } | null): boolean {
    const fresh = (p: { at?: number } | null | undefined, held: unknown) => !!p && Number.isFinite(p.at) && now - p.at! < CLAIM_MAX_AGE_MS && Array.isArray(held) && held.length > 0;
    return jobs.length === 0 && (fresh(claim, claim?.resources) || fresh(plan, plan?.jobs));
}

export function activeAccounts(rows: readonly any[], now = Date.now()): (account: string) => boolean {
    const seen = new Map(rows.filter(r => typeof r?.name === 'string' && Number.isFinite(r.at)).map(r => [r.name.toLowerCase(), r.at as number]));
    return a => now - (seen.get(a.toLowerCase()) ?? -Infinity) < CLAIM_MAX_AGE_MS;
}

const PLAN_FIELDS = ['account', 'accounts', 'script', 'args', 'env', 'enabled', 'standing', 'repeat', 'goal', 'role', 'template', 'autopilot', 'resources'] as const;

export function planView(jobs: readonly any[], side = mySide(), owners = loadOwners(), now = Date.now(), goals?: { army?: unknown; builds?: unknown; observed?: readonly unknown[] }) {
    const names = (j: any) => [j?.account, ...(j?.accounts ?? [])].filter((n: unknown): n is string => typeof n === 'string');
    const own = jobs.filter(j => j?.role !== 'main' && names(j).length > 0 && names(j).every(n => owners.get(n.toLowerCase())?.side === side));
    const listed = Array.isArray(goals?.army) ? goals.army.filter(entry => {
        const account = typeof entry === 'string' ? entry : entry?.account;
        return typeof account === 'string' && account.toLowerCase() !== 'haggis' && owners.get(account.toLowerCase())?.side === side;
    }) : undefined;
    const have = new Set((listed ?? []).map(entry => String(typeof entry === 'string' ? entry : entry.account).toLowerCase()));
    const byRule = ruleRoster(goals?.observed ?? [], n => owners.get(n.toLowerCase())?.side === side, handNamed(jobs, side)).filter(n => !have.has(n));
    const army = listed || byRule.length ? [...(listed ?? []), ...byRule] : undefined;
    const roster = new Set((army ?? []).map(entry => String(typeof entry === 'string' ? entry : entry.account).toLowerCase()));
    const builds = goals?.builds && typeof goals.builds === 'object' && !Array.isArray(goals.builds)
        ? Object.fromEntries(Object.entries(goals.builds).filter(([account, build]) => roster.has(account.toLowerCase()) && typeof build === 'string')) : undefined;
    return { side, at: now, jobs: own.map(j => Object.fromEntries(PLAN_FIELDS.filter(k => j[k] !== undefined).map(k => [k, j[k]]))), ...(army ? { army } : {}), ...(builds ? { builds } : {}) };
}

export function brainPlannedJobs(base: string, existingJobs: readonly any[], now = Date.now()): any[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(fleetStateFile(base), 'utf8')); } catch { return []; }
    if (!isFleetState(raw) || now - (raw as FleetState).emittedAt >= CLAIM_MAX_AGE_MS) return [];
    const state = raw as FleetState;
    const existing = new Set(existingJobs.flatMap(jobAccounts).map(n => n.toLowerCase()));
    const knowledgeRoot = existsSync(join(base, 'knowledge', 'items.json')) ? base : root;
    const catalog = defaultActivityCatalog(knowledgeRoot);
    const activities = catalog.list();
    const out: any[] = [];
    for (const [acctName, plan] of Object.entries(state.activeChains)) {
        if (existing.has(acctName.toLowerCase()) || !plan.steps.length) continue;
        const dispatched = dispatchAccountPlan(plan, { activities });
        const step = dispatched.combinedStep;
        if (!step) continue;
        const workStep = plan.steps.find(s => s.stepKind === 'work');
        const spotId = workStep?.stepKind === 'work' ? catalog.get(workStep.activityId)?.spotId : undefined;
        const goalId = workStep?.stepKind === 'work' ? workStep.demandId : undefined;
        out.push({
            account: acctName,
            script: step.script,
            args: [...step.args],
            env: { ...step.env },
            enabled: true,
            repeat: false,
            ...(state.accounts[acctName.toLowerCase()]?.role ? { role: state.accounts[acctName.toLowerCase()]!.role } : {}),
            ...(goalId ? { goal: goalId } : {}),
            ...(spotId ? { resources: [spotId] } : {}),
        });
    }
    return out;
}

const git = (cwd: string, ...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
        cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: p.exitCode === 0, out: `${p.stdout.toString()}${p.stderr.toString()}`.trim() };
};

export const FETCH_FLEET_DATA = ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`] as const;

export function ensureWorktree(dir = FLEET_WORKTREE, base = root): string {
    if (process.platform === 'win32') {
        const config = git(base, 'config', '--local', 'core.longpaths', 'true');
        if (!config.ok) throw Error(`fleet worktree: cannot enable core.longpaths for Windows: ${config.out}`);
    }
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

export const STRAY_COMMITS = 200;

export function worktreeProblem(dir: string, stray = STRAY_COMMITS): string | null {
    if (existsSync(join(dir, '.git', 'rebase-merge')) || existsSync(join(dir, '.git', 'rebase-apply'))) return 'it has a stopped rebase';
    if (existsSync(join(dir, '.git', 'MERGE_HEAD'))) return 'it has an unfinished merge';
    const r = git(dir, 'rev-parse', '--git-dir');
    if (r.ok && ['rebase-merge', 'rebase-apply', 'MERGE_HEAD'].some(m => existsSync(join(resolve(dir, r.out), m)))) return 'it has an unfinished rebase or merge';
    if (git(dir, 'diff', '--name-only', '--diff-filter=U').out) return 'it has unmerged files';
    const count = (...not: string[]) => { const r = git(dir, 'rev-list', '--count', 'HEAD', '--not', ...not); return r.ok ? Number(r.out) : NaN; };
    const fromCode = git(dir, 'rev-parse', '--verify', '-q', 'origin/master').ok ? count(`origin/${BRANCH}`) - count(`origin/${BRANCH}`, 'origin/master') : NaN;
    if (Number.isFinite(fromCode) && fromCode > stray) return `HEAD holds ${fromCode} commits of origin/master that origin/${BRANCH} lacks: it is not the fleet-data branch`;
    return null;
}

export function reattach(dir: string, branch = BRANCH): boolean {
    if (git(dir, 'symbolic-ref', '-q', 'HEAD').ok) return false;
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir').out;
    if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return false;
    if (git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).ok && !git(dir, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, 'HEAD').ok) {
        throw Error(`reattach: HEAD is detached and ${branch} holds commits that HEAD lacks`);
    }
    const moved = git(dir, 'checkout', '-B', branch);
    if (!moved.ok) throw Error(`reattach: ${moved.out}`);
    return true;
}

export function confirmedTradeLogout(
    base: string,
    claim: FleetTradeClaim,
    receipt: TradeReceipt,
    alive: (pid: number, at: number) => boolean = savedProcessAlive,
): boolean {
    try {
        const pid = claim.pid;
        if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || !receipt.logout) return false;
        const options = { root: join(base, '.practice/session-lifecycle') }, proof = readLogoutProof(claim.account, claim.server, options);
        if (
            proof.state !== 'confirmed' || proof.attemptId !== receipt.logout.attemptId || proof.loggedOutAt !== receipt.logout.at
            || proof.receiptSha256 !== receipt.logout.sha256 || proof.loggedOutAt < claim.at
        ) return false;
        const attempt = listAttempts(claim.account, claim.server, options).find(row => row.attemptId === proof.attemptId);
        if (!attempt?.receipt || attempt.sha256 !== proof.receiptSha256) return false;
        return attempt.receipt.owner.pid === pid && attempt.receipt.owner.sharedClaimNonce === claim.nonce
            && (attempt.receipt.owner.script === 'scripts/fleet-trade.ts' || attempt.receipt.owner.script === 'scripts/aio-logistics.ts') && !alive(pid, claim.at);
    } catch { return false; }
}

function pairedZeroTransferClaims(
    claims: readonly FleetTradeClaim[],
    side: string,
    read: (path: string) => any,
    confirmed: (claim: FleetTradeClaim, receipt: TradeReceipt) => boolean,
    now: number,
): FleetTradeClaim[][] {
    const pairs: FleetTradeClaim[][] = [];
    for (const orderId of new Set(claims.filter(claim => claim.phase === 'held' && claim.side === side).map(claim => claim.orderId))) {
        const order = read(`orders/${orderId}.json`);
        if (!validOrder(order) || order.id !== orderId || now < order.end) continue;
        const pair = claims.filter(claim => claim.orderId === orderId);
        if (pair.length !== 2 || pair.some(claim => claim.phase !== 'held' || claim.side !== side)) continue;
        const from = pair.filter(claim => claim.role === 'from'), to = pair.filter(claim => claim.role === 'to');
        if (from.length !== 1 || to.length !== 1 || from[0]!.nonce === to[0]!.nonce) continue;
        let matched = true;
        for (const claim of pair) {
            const receipt = read(`receipts/${orderId}.${claim.role}.json`);
            if (
                !receipt || receipt.state !== 'reconcile' || receipt.ok !== false || receipt.screen !== true
                || claim.account.toLowerCase() !== order[claim.role].toLowerCase() || claim.server.toLowerCase() !== order.server.toLowerCase()
                || receipt.claim !== claim.nonce || receipt.side !== claim.side || receipt.logout?.at < claim.at
                || !terminalTradeReceipt(order, claim.role, { ...receipt, state: 'failed' }, now)
                || ![receipt, ...(receipt.lines ?? [])].every((line: { inventory?: unknown }) => !!line.inventory)
            ) { matched = false; break; }
            try { if (!confirmed(claim, receipt)) { matched = false; break; } }
            catch { matched = false; break; }
        }
        if (matched) pairs.push(pair);
    }
    return pairs;
}

export function releasePublishedTradeClaims(
    claims: readonly FleetTradeClaim[],
    side: string,
    read: (path: string) => any,
    release: (claim: FleetTradeClaim) => void,
    now = Date.now(),
    confirmed: (claim: FleetTradeClaim, receipt: TradeReceipt) => boolean = () => false,
    releasePair?: (claims: readonly FleetTradeClaim[]) => void,
): number {
    let released = 0;
    const paired = new Set<FleetTradeClaim>();
    if (releasePair) {
        for (const pair of pairedZeroTransferClaims(claims, side, read, confirmed, now)) {
            releasePair(pair); released += pair.length; pair.forEach(claim => paired.add(claim));
        }
    }
    for (const claim of claims) {
        if (claim.phase !== 'held' || claim.side !== side || paired.has(claim)) continue;
        const order = read(`orders/${claim.orderId}.json`), receipt = read(`receipts/${claim.orderId}.${claim.role}.json`);
        if (
            !validOrder(order) || order.id !== claim.orderId || !receipt || !terminalTradeReceipt(order, claim.role, receipt, now)
            || receipt.claim !== claim.nonce || receipt.side !== claim.side || receipt.account.toLowerCase() !== claim.account
            || receipt.server.toLowerCase() !== claim.server || receipt.logout!.at < claim.at
        ) continue;
        release(claim);
        released++;
    }
    return released;
}

export const DROPPED_CLAIM_MS = 60 * 60_000, UNANSWERED_GRACE_MS = 2 * 60_000;

export function droppedTradeClaims(claims: readonly FleetTradeClaim[], side: string, read: (path: string) => any, now = Date.now()): FleetTradeClaim[] {
    const publishedAt = (s: string) => Math.max(...['claims', 'leases', 'snapshots'].map(d => {
        const at = read(`${d}/${s}.json`)?.at;
        return Number.isSafeInteger(at) ? at as number : 0;
    }));
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
    releasePublishedTradeClaims(held, side, read, claim => releaseFleetTradeClaim(root, claim), Date.now(),
        (claim, receipt) => confirmedTradeLogout(root, claim, receipt), pair => { releaseFleetTradeClaims(root, pair); });
    for (const claim of droppedTradeClaims(held, side, read)) {
        releaseFleetTradeClaim(root, claim);
        console.log(`FLEET_SYNC released the dropped trade claim of ${claim.account} for order ${claim.orderId}: the partner moved nothing (a failed receipt, or no claim by the end of the window)`);
    }
}

export function pullFleetData(dir: string): void {
    const pull = git(dir, 'pull', '--rebase', '--autostash', 'origin', BRANCH);
    if (!pull.ok) throw Error(`pull: ${pull.out}`);
    const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U');
    if (!unmerged.ok || unmerged.out) throw Error(`pull: local changes conflict with the fetched fleet data in ${unmerged.out || 'an unknown path'}; git keeps them in the stash`);
}

export function runSync(push = true, base = root): string {
    const dir = ensureWorktree(FLEET_WORKTREE, base);
    git(base, ...FETCH_FLEET_DATA);
    const problem = worktreeProblem(dir);
    if (problem) throw Error(`fleet worktree ${dir}: ${problem}; scripts/cloud-side.ts replaces it, or remove it with git worktree remove --force`);
    reattach(dir);
    const hasRemote = git(dir, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok;
    if (hasRemote) pullFleetData(dir);
    const statusDir = join(base, '.practice', 'status');
    const statuses = existsSync(statusDir) ? readdirSync(statusDir).filter(f => f.endsWith('.json')).flatMap(f => { try { return [JSON.parse(readFileSync(join(statusDir, f), 'utf8'))]; } catch { return []; } }) : [];
    const owners = loadOwners(join(dir, 'fleet', 'owners.json'));
    mkdirSync(join(dir, 'fleet', 'snapshots'), { recursive: true });
    const file = join(dir, 'fleet', 'snapshots', `${mySide()}.json`);
    const prior: any[] = (() => { try { const a = JSON.parse(readFileSync(file, 'utf8')).accounts; return Array.isArray(a) ? a : []; } catch { return []; } })();
    const snap = snapshot(statuses, mySide(), owners, Date.now(), carriedPrior(prior, readSnapshotFiles(join(dir, 'fleet', 'snapshots')), mySide(), owners));
    if (JSON.stringify(prior) !== JSON.stringify(snap.accounts)) writeFileSync(file, JSON.stringify(snap) + '\n');

    const planFile = resolve(process.env.SWARM_PLAN ?? join(base, 'swarm.json'));
    const sourcePlan = (() => { try { return JSON.parse(readFileSync(planFile, 'utf8')); } catch { return null; } })();
    const jobs: any[] | null = Array.isArray(sourcePlan?.jobs) ? sourcePlan.jobs : null;
    let claim: ReturnType<typeof claimFor> | null = null;
    const claimFile = join(dir, 'fleet', 'claims', `${snap.side}.json`), out = join(dir, 'fleet', 'plans', `${snap.side}.json`);
    const published = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
    const brainJobs = jobs ? brainPlannedJobs(base, jobs) : [];
    const combinedJobs = jobs ? [...jobs, ...brainJobs] : null;
    if (combinedJobs && !keepPublished(combinedJobs, published(claimFile), Date.now(), published(out))) {
        claim = claimFor(combinedJobs, snap.side, a => owners.get(a.toLowerCase())?.side ?? 'local', Date.now(), activeAccounts(snap.accounts));
        mkdirSync(join(dir, 'fleet', 'claims'), { recursive: true }); writeFileSync(claimFile, JSON.stringify(claim) + '\n');
        const view = planView(combinedJobs, snap.side, owners, Date.now(), { ...sourcePlan, observed: snap.accounts });
        mkdirSync(join(dir, 'fleet', 'plans'), { recursive: true });
        const priorView = published(out), was = JSON.stringify([priorView?.jobs, priorView?.army, priorView?.builds]);
        if (was !== JSON.stringify([view.jobs, view.army, view.builds])) writeFileSync(out, JSON.stringify(view, null, 1) + '\n');
    }

    const state = published(join(base, '.practice', 'swarm-state.json'));
    const mine: Lease | null = state && Number.isFinite(state.at) && Date.now() - state.at < HEARTBEAT_MAX_AGE_MS && Number.isSafeInteger(state.controllerPid)
        ? { side: snap.side, host: thisHost(), pid: state.controllerPid, at: state.at } : null;
    const current = readLease(snap.side, join(dir, 'fleet')), lease = nextLease(current, mine);
    if (lease) { mkdirSync(join(dir, 'fleet', 'leases'), { recursive: true }); writeFileSync(join(dir, 'fleet', 'leases', `${snap.side}.json`), JSON.stringify(lease) + '\n'); }
    const leaseNote = lease ? 'ours' : leaseHeldElsewhere(current, thisHost()) ? `held by ${current!.host}` : 'none';

    const plan = (() => { try { return JSON.parse(readFileSync(planFile, 'utf8')); } catch { return null; } })();
    const capacity = sideCapacity(plan);
    if (mine && capacity !== null) {
        const raw = (() => { try { return JSON.parse(readFileSync(join(dir, 'fleet', 'owners.json'), 'utf8')).accounts ?? {}; } catch { return {}; } })() as Record<string, { side?: string }>;
        const owned = Object.keys(raw).filter(n => owners.get(n.toLowerCase())?.side === snap.side);
        const died = (() => { try { return [...loadEnded(join(base, '.practice', 'swarm-deaths.json'))].filter(([, e]) => /^died\b/.test(e.reason)).map(([n]) => n); } catch { return []; } })();
        const card = sideCard(snap.side, capacity, owned, (n: string) => { try { return readFileSync(join(base, '.practice', `stop-${n}`), 'utf8'); } catch { return undefined; } }, died);
        const cardFile = join(dir, 'fleet', 'sides', `${snap.side}.json`);
        if (JSON.stringify(published(cardFile)) !== JSON.stringify(card)) { mkdirSync(join(dir, 'fleet', 'sides'), { recursive: true }); writeFileSync(cardFile, JSON.stringify(card) + '\n'); }
    }

    git(dir, 'add', '--', 'fleet');
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

export function sideCapacity(plan: any): number | null {
    const n = plan?.fleetCapacity ?? plan?.maxBots;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function sideCard(side: string, capacity: number, owned: readonly string[], stopText: (name: string) => string | undefined, died: readonly string[] = []) {
    const ownerStop = (n: string) => [n, n.toLowerCase()].some(s => { const t = stopText(s); return t !== undefined && !swarmWroteStop(t); });
    const paused = [...new Set(owned.filter(ownerStop).map(n => n.toLowerCase()))].sort();
    const mine = new Set(owned.map(n => n.toLowerCase()));
    const dead = [...new Set(died.map(n => n.toLowerCase()).filter(n => mine.has(n)))].sort();
    const swarm = stopText('swarm');
    return { side, capacity, paused, died: dead, stopped: swarm !== undefined && !swarmWroteStop(swarm) };
}

function adoptionPass(dir: string, side: string, capacity: number): string {
    const moves = planAdoption(dir, side, capacity);
    if (!moves.length) return '';
    const landed = transferFleetOwnersLocked(root, moves, dir);
    return landed.length ? describeMoves(landed) : 'lost to another side';
}

export function planAdoption(dir: string, side: string, capacity: number) {
    const gitWindow = fleetGitWindow(root, 'fleet adoption', 60_000);
    const seen = allLeaseLastSeen(gitWindow, join(dir, 'fleet', 'leases'));
    const raw = JSON.parse(readFileSync(join(dir, 'fleet', 'owners.json'), 'utf8')).accounts as Record<string, OwnerRow>;
    const names = new Set([...Object.values(raw).map(o => o.side), ...seen.keys()]);
    const sides: Record<string, SideView> = {};
    for (const s of names) {
        let card: any = null;
        try { card = JSON.parse(readFileSync(join(dir, 'fleet', 'sides', `${s}.json`), 'utf8')); } catch { /* no card */ }
        sides[s] = {
            seen: seen.get(s) ?? null,
            capacity: Number.isSafeInteger(card?.capacity) ? card.capacity : undefined,
            paused: Array.isArray(card?.paused) ? card.paused : undefined,
            died: Array.isArray(card?.died) ? card.died : undefined,
            stopped: card?.stopped === true,
        };
    }
    return planTransfers({ side, capacity, owners: raw, sides, claims: readAllFleetAccountClaims(gitWindow), canLogin: n => hasCredential(n), now: Date.now() });
}

export async function runFleetSyncCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    if (argv.includes('--adopt-dry')) {
        const at = argv.indexOf('--capacity'), plan = (() => { try { return JSON.parse(readFileSync(resolve(process.env.SWARM_PLAN ?? join(root, 'swarm.json')), 'utf8')); } catch { return null; } })();
        const capacity = at >= 0 ? Number(argv[at + 1]) : sideCapacity(plan) ?? 0;
        const moves = planAdoption(ensureWorktree(), mySide(), capacity);
        console.log(`ADOPT-DRY side=${mySide()} capacity=${capacity} moves=${moves.length}${moves.length ? ' ' + describeMoves(moves) : ''}`);
    } else {
        try { console.log(`RESULT ok fleet-sync ${await withFleetDataWrite(root, () => runSync(!argv.includes('--no-push')))}`); }
        catch (e) { console.log(`RESULT fail fleet-sync ${String(e)}`); process.exit(1); }
    }
}

if (import.meta.main) {
    await runFleetSyncCli(process.argv.slice(2));
}
