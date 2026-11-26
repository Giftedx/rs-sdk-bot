// Fleet data sync: pulls other sides' orders, receipts, and snapshots; writes this side's
// snapshot, resource claim, active plan view (swarm.json + Brain FleetState), controller lease heartbeat,
// side card, and runs optional cross-side adoption cleanly via git fleet-data worktree.
// Usage: bun packages/fleet/src/fleet-sync.ts [--no-push] [--adopt-dry [--capacity N]]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { fleetStateFile, lifecycleReadRoots, lifecycleRootForRead, liveRoot, practiceRoot, readStopFile, repoRoot, statusReadDirs, stopFilePaths } from '../../core/src/practice-paths';
import { listAttempts, readLogoutProof } from '../../core/src/session-lifecycle';
import { savedProcessAlive } from '../../core/src/session-takeover';
import { loadEnded, selectBrainDispatchStep, swarmWroteStop } from './swarm';
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
    const isMine = (s: any, lower: string): boolean => {
        const own = owners.get(lower);
        return !!own && own.side === side && own.server === String(s.server).toLowerCase();
    };
    const by = new Map<string, any>();
    for (let i = 0; i < prior.length; i++) {
        const r = prior[i];
        if (typeof r?.name !== 'string') continue;
        const lower = r.name.toLowerCase();
        if (isMine(r, lower)) by.set(lower, r);
    }
    for (let i = 0; i < statuses.length; i++) {
        const s = statuses[i];
        if (typeof s?.name !== 'string') continue;
        const lower = s.name.toLowerCase();
        if (!isMine(s, lower)) continue;
        const kept = by.get(lower);
        if (kept && Number.isFinite(kept.at) && !(Number(s.at) >= kept.at)) continue;
        const incomingBank = rows(s.bank), bank = incomingBank ?? rows(kept?.bank), equipment = rows(s.equipment, 'equipment'), inventory = rows(s.inventory, 'inventory'), p = s.pos;
        const incomingJournal = journalRows(s.quests), journal = incomingJournal ?? journalRows(kept?.questJournal);
        const incomingLegacyQuests = kept?.questJournal == null ? legacyJournalNames(s.quests) : undefined;
        const legacyQuests = incomingLegacyQuests ?? (kept?.questJournal == null && Array.isArray(kept?.quests)
            && kept.quests.every((q: unknown) => typeof q === 'string' && q.trim()) ? [...new Set(kept.quests)] : undefined);
        let completed: unknown[] | undefined;
        if (journal) {
            completed = [];
            for (let ji = 0; ji < journal.length; ji++) {
                const q = journal[ji]!;
                if (q.state === 'complete') completed.push(q.name);
            }
        } else {
            completed = legacyQuests;
        }
        const guildFacts = durableGuildFacts(s.guildFacts);
        const skills: Record<string, unknown>[] = [];
        if (Array.isArray(s.skills)) {
            for (let ki = 0; ki < s.skills.length; ki++) {
                const k = s.skills[ki];
                if (!k || typeof k.name !== 'string' || !Number.isSafeInteger(k.level) || k.level <= 0) continue;
                const entry: Record<string, unknown> = { name: k.name, level: k.level };
                if (nonnegativeInteger(k.currentLevel)) entry.currentLevel = k.currentLevel;
                if (typeof k.xp === 'number' && Number.isFinite(k.xp) && k.xp >= 0) entry.xp = k.xp;
                skills.push(entry);
            }
        }
        by.set(lower, {
            name: s.name, server: s.server, at: s.at, bank, inventory, ...(inventory !== null ? { inventoryIds: 'raw' as const } : {}), equipment,
            bankAt: bank ? incomingBank !== null ? observationAt(s.bankAt, s.at) : observationAt(kept?.bankAt, kept?.at) : null,
            ...(typeof s.equipmentObserved === 'boolean' ? { equipmentObserved: equipment !== null && s.equipmentObserved } : {}),
            skills,
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
    const outJobs: Record<string, unknown>[] = new Array(own.length);
    for (let i = 0; i < own.length; i++) {
        const j = own[i]!;
        const copy: Record<string, unknown> = {};
        for (const k of PLAN_FIELDS) {
            if (j[k] !== undefined) copy[k] = j[k];
        }
        outJobs[i] = copy;
    }
    return { side, at: now, jobs: outJobs, ...(army ? { army } : {}), ...(builds ? { builds } : {}) };
}

export function brainPlannedJobs(base: string, existingJobs: readonly any[], now = Date.now()): any[] {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(fleetStateFile(base), 'utf8')); } catch { return []; }
    if (!isFleetState(raw) || now - (raw as FleetState).emittedAt >= CLAIM_MAX_AGE_MS) return [];
    const state = raw as FleetState;
    const existing = new Set(existingJobs.flatMap(jobAccounts).map(n => n.toLowerCase()));
    const knowledgeRoot = existsSync(join(base, 'knowledge', 'items.json')) ? base : root;
    const catalog = defaultActivityCatalog(knowledgeRoot);
    const out: any[] = [];
    for (const [acctName, plan] of Object.entries(state.activeChains)) {
        if (existing.has(acctName.toLowerCase()) || !plan.steps.length) continue;
        const acctState = state.accounts[acctName.toLowerCase()] ?? state.accounts[acctName];
        if (
            acctState
            && (acctState.protectedClock
                || acctState.lifecycle === 'paused_owner'
                || acctState.lifecycle === 'reserved'
                || acctState.lifecycle === 'dead')
        ) continue;
        const dispatched = dispatchAccountPlan(plan, { catalog });
        const selected = selectBrainDispatchStep(dispatched, plan.steps);
        if (selected.mode !== 'worker') continue;
        const step = selected.step;
        const workStep = plan.steps.find(s => s.stepKind === 'work');
        const claimsWorkSpot = workStep?.stepKind === 'work'
            && !selected.isMultiStepChain
            && selected.attributedActivityId === workStep.activityId;
        const spotId = claimsWorkSpot ? catalog.get(workStep.activityId)?.spotId : undefined;
        const goalId = workStep?.stepKind === 'work' ? workStep.demandId : undefined;
        out.push({
            account: acctName,
            script: step.script,
            args: [...step.args],
            env: { ...step.env },
            enabled: true,
            repeat: false,
            ...(acctState?.role ? { role: acctState.role } : {}),
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

export function readSyncStatuses(base: string): any[] {
    const out: any[] = [];
    for (const dir of statusReadDirs(base)) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const row = JSON.parse(readFileSync(join(dir, file), 'utf8'));
                if (row && row.practice !== true) out.push(row);
            } catch { /* incomplete record */ }
        }
    }
    return out;
}

export function readSyncStopText(base: string, name: string): string | undefined {
    let fallback: string | undefined;
    for (const candidate of stopFilePaths(name, base)) {
        if (!existsSync(candidate)) continue;
        try {
            const text = readFileSync(candidate, 'utf8');
            if (!swarmWroteStop(text)) return text;
            if (fallback === undefined) fallback = text;
        } catch { /* unreadable stop file */ }
    }
    return fallback ?? readStopFile(name, base);
}

function readAllSyncStopTexts(base: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const dir of [liveRoot(base), practiceRoot(base)]) {
        if (!existsSync(dir)) continue;
        let files: string[];
        try { files = readdirSync(dir); } catch { continue; }
        for (const file of files) {
            if (!file.startsWith('stop-') && !file.toLowerCase().startsWith('stop-')) continue;
            const flagLower = file.slice(5).toLowerCase();
            if (!flagLower) continue;
            const existing = out.get(flagLower);
            if (existing !== undefined && !swarmWroteStop(existing)) continue;
            try {
                const text = readFileSync(join(dir, file), 'utf8');
                if (existing === undefined || !swarmWroteStop(text)) out.set(flagLower, text);
            } catch { /* unreadable stop file */ }
        }
    }
    return out;
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
        let resolvedRoot = lifecycleRootForRead(claim.server, base);
        for (const candidate of lifecycleReadRoots(base)) {
            if (readLogoutProof(claim.account, claim.server, { root: candidate }).state !== 'none') {
                resolvedRoot = candidate;
                break;
            }
        }
        const options = { root: resolvedRoot }, proof = readLogoutProof(claim.account, claim.server, options);
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
    const byOrder = new Map<string, FleetTradeClaim[]>();
    const candidateOrderIds = new Set<string>();
    for (let i = 0; i < claims.length; i++) {
        const claim = claims[i]!;
        let list = byOrder.get(claim.orderId);
        if (!list) {
            list = [];
            byOrder.set(claim.orderId, list);
        }
        list.push(claim);
        if (claim.phase === 'held' && claim.side === side) {
            candidateOrderIds.add(claim.orderId);
        }
    }
    const pairs: FleetTradeClaim[][] = [];
    for (const orderId of candidateOrderIds) {
        const order = read(`orders/${orderId}.json`);
        if (!validOrder(order) || order.id !== orderId || now < order.end) continue;
        const pair = byOrder.get(orderId)!;
        if (pair.length !== 2 || pair[0]!.phase !== 'held' || pair[0]!.side !== side || pair[1]!.phase !== 'held' || pair[1]!.side !== side) continue;
        const from = pair[0]!.role === 'from' ? pair[0]! : pair[1]!.role === 'from' ? pair[1]! : null;
        const to = pair[0]!.role === 'to' ? pair[0]! : pair[1]!.role === 'to' ? pair[1]! : null;
        if (!from || !to || from.nonce === to.nonce) continue;
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
            || receipt.claim !== claim.nonce || receipt.side !== claim.side || receipt.account.toLowerCase() !== claim.account.toLowerCase()
            || receipt.server.toLowerCase() !== claim.server.toLowerCase() || (receipt.logout?.at ?? -Infinity) < claim.at
        ) continue;
        release(claim);
        released++;
    }
    return released;
}

export const DROPPED_CLAIM_MS = 60 * 60_000, UNANSWERED_GRACE_MS = 2 * 60_000;

export function droppedTradeClaims(claims: readonly FleetTradeClaim[], side: string, read: (path: string) => any, now = Date.now()): FleetTradeClaim[] {
    const publishedAtCache = new Map<string, number>();
    const publishedAt = (s: string) => {
        const hit = publishedAtCache.get(s);
        if (hit !== undefined) return hit;
        const val = Math.max(...['claims', 'leases', 'snapshots'].map(d => {
            const at = read(`${d}/${s}.json`)?.at;
            return Number.isSafeInteger(at) ? at as number : 0;
        }));
        publishedAtCache.set(s, val);
        return val;
    };
    let ownersByLower: Map<string, string> | null = null;
    const sideOf = (account: string): string => {
        if (!ownersByLower) {
            ownersByLower = new Map<string, string>();
            const owners: Record<string, { side?: unknown }> = read('owners.json')?.accounts ?? {};
            for (const [n, entry] of Object.entries(owners)) {
                if (typeof entry?.side === 'string') ownersByLower.set(n.toLowerCase(), entry.side);
            }
        }
        return ownersByLower.get(account.toLowerCase()) ?? 'local';
    };
    return claims.filter(claim => {
        if (claim.phase !== 'held' || claim.side !== side) return false;
        const order = read(`orders/${claim.orderId}.json`), other = claim.role === 'from' ? 'to' : 'from';
        if (!validOrder(order) || order.id !== claim.orderId) return false;
        const own = read(`receipts/${claim.orderId}.${claim.role}.json`), partner = read(`receipts/${claim.orderId}.${other}.json`);
        const ownIdle = !!own && own.version === 2 && (own.state === 'prepared' || own.state === 'reconcile') && own.claim === claim.nonce && own.side === claim.side
            && typeof own.account === 'string' && own.account.toLowerCase() === claim.account.toLowerCase() && own.count === 0
            && (!own.inventory || own.inventory.before === own.inventory.after);
        if (!ownIdle) return false;
        if (own.state === 'reconcile' && own.screen === false && now >= order.end) return true;
        // The account's own worker is gone: it wrote `reconcile`, or it died while `prepared` (a PC restart) and the
        // claim and the window both ended an hour ago.
        const ownGone = own.state === 'reconcile' || now - claim.at >= DROPPED_CLAIM_MS && now - order.end >= DROPPED_CLAIM_MS;
        if (!partner) {
            const partnerSide = sideOf(order[other]);
            return now >= order.end && ownGone && (partnerSide === side ? now : publishedAt(partnerSide)) >= order.end + UNANSWERED_GRACE_MS;
        }
        return ownGone && terminalTradeReceipt(order, other, partner, now) && partner.state === 'failed';
    });
}

const ORDER_FILE = /^fleet\/orders\/([A-Za-z0-9_-]{1,64})\.json$/;

// The staged order deletions to undo: each one that a held trade claim names. A held claim can be released only
// against its order (releasePublishedTradeClaims, droppedTradeClaims). With no claim list (null: the claim refs
// could not be read), every deletion is undone, and a later sync decides again.
export function claimedOrderDeletions(deleted: readonly string[], held: readonly FleetTradeClaim[] | null): string[] {
    const orders = deleted.filter(path => ORDER_FILE.test(path));
    if (held === null) return orders;
    const named = new Set(held.filter(claim => claim.phase === 'held').map(claim => claim.orderId.toLowerCase()));
    return orders.filter(path => named.has(ORDER_FILE.exec(path)![1]!.toLowerCase()));
}

// Run after `git add -- fleet`. An order file that is gone from the worktree is a staged deletion, and the commit
// would publish it. The deletion of a withdrawn order stays. The deletion of an order that a held claim names is
// put back from HEAD, in the index and in the worktree. While the held claims are unreadable, no order deletion goes
// into the commit, and the worktree keeps each deletion, so the next sync that reads the claims decides it.
export function keepClaimedOrders(dir: string, readHeld: () => FleetTradeClaim[]): string[] {
    const listed = git(dir, 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D', '--', 'fleet/orders');
    if (!listed.ok) throw Error(`staged order deletions: ${listed.out}`);
    const deleted = listed.out.split(/\r?\n/).map(line => line.trim()).filter(path => ORDER_FILE.test(path));
    if (!deleted.length) return [];
    let held: FleetTradeClaim[] | null;
    try { held = readHeld(); } catch { held = null; }
    const keep = claimedOrderDeletions(deleted, held);
    if (keep.length) {
        const restored = held === null ? git(dir, 'restore', '--staged', '--', ...keep) : git(dir, 'checkout', 'HEAD', '--', ...keep);
        if (!restored.ok) throw Error(`keep claimed orders: ${restored.out}`);
    }
    return keep;
}

// Reads a committed fleet-data file (path below fleet/) at HEAD. An order is published one time and is never
// changed, so an order file that a commit deleted is read from the parent of that commit.
export function fleetDataReader(dir: string): (path: string) => any {
    const cache = new Map<string, any>();
    const parse = (shown: { ok: boolean; out: string }) => { try { return shown.ok ? JSON.parse(shown.out) : null; } catch { return null; } };
    return (path: string) => {
        if (cache.has(path)) return cache.get(path);
        let parsed = parse(git(dir, 'show', 'HEAD:fleet/' + path));
        if (parsed === null && ORDER_FILE.test('fleet/' + path)) {
            const gone = git(dir, 'log', '-1', '--format=%H', '--no-renames', '--diff-filter=D', 'HEAD', '--', 'fleet/' + path);
            if (gone.ok && /^[0-9a-f]{40}$/.test(gone.out)) parsed = parse(git(dir, 'show', `${gone.out}^:fleet/${path}`));
        }
        cache.set(path, parsed);
        return parsed;
    };
}

function releaseSyncedTrades(dir: string, side: string, base = root) {
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
    const read = fleetDataReader(dir);
    const held = readHeldFleetTradeClaims(base, [...new Set(accounts)]);
    releasePublishedTradeClaims(held, side, read, claim => releaseFleetTradeClaim(base, claim), Date.now(),
        (claim, receipt) => confirmedTradeLogout(base, claim, receipt), pair => { releaseFleetTradeClaims(base, pair); });
    for (const claim of droppedTradeClaims(held, side, read)) {
        releaseFleetTradeClaim(base, claim);
        console.log(`FLEET_SYNC released the dropped trade claim of ${claim.account} for order ${claim.orderId}: the partner moved nothing (a failed receipt, or no claim by the end of the window)`);
    }
}

const rebaseStopped = (dir: string) => {
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir');
    return !gitDir.ok || ['rebase-merge', 'rebase-apply'].some(m => existsSync(join(gitDir.out, m)));
};

// A rebase that fails, or whose autostash does not apply cleanly, keeps the local changes in a stash entry named
// "autostash" and leaves those paths at HEAD or in conflict. The local changes are this side's receipts, and a settled
// receipt kept there holds its trade claim for good: releasePublishedTradeClaims reads the committed receipt. Each
// autostash entry made on this branch puts back each of its fleet/ paths that HEAD still holds as the entry's base had
// it, and the entry is then dropped. A path with a newer commit since the base, or a newer local write, keeps the newer
// content. A path in conflict goes back to HEAD first. Returns the paths put back.
export function restoreAutostashes(dir: string): string[] {
    const list = git(dir, 'stash', 'list', '--format=%gd%x00%H%x00%P%x00%gs');
    if (!list.ok || !list.out) return [];
    const unmerged = new Set(git(dir, 'diff', '--name-only', '--diff-filter=U').out.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
    const restored: string[] = [];
    const entries = list.out.split(/\r?\n/).map(line => line.split('\0')).filter(([ref, hash, parents, subject]) =>
        /^stash@\{\d+\}$/.test(ref ?? '') && /^[0-9a-f]{40}$/.test(hash ?? '') && !!parents && subject === 'autostash');
    for (const [ref, hash, parents] of entries.reverse()) {
        const base = parents!.split(' ')[0]!;
        if (!git(dir, 'merge-base', '--is-ancestor', base, 'HEAD').ok) continue;
        const diff = git(dir, 'diff', '--name-status', '--no-renames', '-z', base, hash!);
        if (!diff.ok) continue;
        const fields = diff.out.split('\0').filter(Boolean), changes: [string, string][] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) changes.push([fields[i]!, fields[i + 1]!]);
        if (!changes.length || !changes.every(([, path]) => path.startsWith('fleet/'))) continue;
        for (const [status, path] of changes) {
            if (unmerged.has(path) && git(dir, 'checkout', 'HEAD', '--', path).ok) unmerged.delete(path);
            if (unmerged.has(path) || !git(dir, 'diff', '--quiet', base, 'HEAD', '--', path).ok) continue;
            if (!git(dir, 'diff', '--quiet', 'HEAD', '--', path).ok || (status === 'A' && existsSync(join(dir, path)))) continue;
            if (status === 'D') rmSync(join(dir, path), { force: true });
            else if (!git(dir, 'checkout', hash!, '--', path).ok) continue;
            restored.push(path);
        }
        // The stash list is shared with the code checkout: drop the entry only while its ref still names this commit.
        const now = git(dir, 'rev-parse', '--verify', '-q', ref!);
        if (now.ok && now.out === hash) git(dir, 'stash', 'drop', '-q', ref!);
    }
    return restored;
}

// The fetch fills FETCH_HEAD alone (an empty --refmap): refs/remotes/origin/fleet-data is shared with the code checkout,
// and runSync updates it with FETCH_FLEET_DATA. Returns the paths put back from autostash entries.
export function pullFleetData(dir: string): string[] {
    const fetched = git(dir, 'fetch', '--quiet', '--no-tags', '--refmap=', 'origin', BRANCH);
    if (!fetched.ok) throw Error(`pull: fetch: ${fetched.out}`);
    const rebase = git(dir, 'rebase', '--autostash', 'FETCH_HEAD');
    const restored = rebaseStopped(dir) ? [] : restoreAutostashes(dir);
    if (!rebase.ok) throw Error(`pull: ${rebase.out}`);
    const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U');
    if (!unmerged.ok || unmerged.out) throw Error(`pull: local changes conflict with the fetched fleet data in ${unmerged.out || 'an unknown path'}; git keeps them in the stash`);
    return restored;
}

export function runSync(push = true, base = root): string {
    const dir = ensureWorktree(FLEET_WORKTREE, base);
    git(base, ...FETCH_FLEET_DATA);
    const problem = worktreeProblem(dir);
    if (problem) throw Error(`fleet worktree ${dir}: ${problem}; scripts/cloud-side.ts replaces it, or remove it with git worktree remove --force`);
    reattach(dir);
    const hasRemote = git(dir, 'ls-remote', '--exit-code', '--heads', 'origin', BRANCH).ok;
    const restored = hasRemote ? pullFleetData(dir) : restoreAutostashes(dir);
    const statuses = readSyncStatuses(base);
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
    const priorView = published(out);
    if (combinedJobs && !keepPublished(combinedJobs, published(claimFile), Date.now(), priorView)) {
        claim = claimFor(combinedJobs, snap.side, a => owners.get(a.toLowerCase())?.side ?? 'local', Date.now(), activeAccounts(snap.accounts));
        mkdirSync(join(dir, 'fleet', 'claims'), { recursive: true }); writeFileSync(claimFile, JSON.stringify(claim) + '\n');
        const view = planView(combinedJobs, snap.side, owners, Date.now(), { ...sourcePlan, observed: snap.accounts });
        mkdirSync(join(dir, 'fleet', 'plans'), { recursive: true });
        const was = JSON.stringify([priorView?.jobs, priorView?.army, priorView?.builds]);
        if (was !== JSON.stringify([view.jobs, view.army, view.builds])) writeFileSync(out, JSON.stringify(view, null, 1) + '\n');
    }

    const state = published(join(base, '.practice', 'swarm-state.json'));
    const mine: Lease | null = state && Number.isFinite(state.at) && Date.now() - state.at < HEARTBEAT_MAX_AGE_MS && Number.isSafeInteger(state.controllerPid)
        ? { side: snap.side, host: thisHost(), pid: state.controllerPid, at: state.at } : null;
    const current = readLease(snap.side, join(dir, 'fleet')), lease = nextLease(current, mine);
    if (lease) { mkdirSync(join(dir, 'fleet', 'leases'), { recursive: true }); writeFileSync(join(dir, 'fleet', 'leases', `${snap.side}.json`), JSON.stringify(lease) + '\n'); }
    const leaseNote = lease ? 'ours' : leaseHeldElsewhere(current, thisHost()) ? `held by ${current!.host}` : 'none';

    const capacity = sideCapacity(sourcePlan);
    if (mine && capacity !== null) {
        const owned = [...owners].filter(([, o]) => o.side === snap.side).map(([n]) => n);
        const died = (() => { try { return [...loadEnded(join(base, '.practice', 'swarm-deaths.json'))].filter(([, e]) => /^died\b/.test(e.reason)).map(([n]) => n); } catch { return []; } })();
        const stopTexts = readAllSyncStopTexts(base);
        const card = sideCard(snap.side, capacity, owned, (n: string) => stopTexts.get(n.toLowerCase()), died);
        const cardFile = join(dir, 'fleet', 'sides', `${snap.side}.json`);
        if (JSON.stringify(published(cardFile)) !== JSON.stringify(card)) { mkdirSync(join(dir, 'fleet', 'sides'), { recursive: true }); writeFileSync(cardFile, JSON.stringify(card) + '\n'); }
    }

    git(dir, 'add', '--', 'fleet');
    if (existsSync(join(dir, 'fleet', 'vault'))) git(dir, 'add', '-f', '--', 'fleet/vault');
    const keptOrders = keepClaimedOrders(dir, () => readHeldFleetTradeClaims(base));
    const staged = !git(dir, 'diff', '--cached', '--quiet').ok;
    if (staged) { const c = git(dir, 'commit', '-m', `fleet: ${snap.side} sync (${snap.accounts.length} accounts)`); if (!c.ok) throw Error(`commit: ${c.out}`); }
    const ahead = !hasRemote || git(dir, 'rev-list', '--count', `origin/${BRANCH}..HEAD`).out !== '0';
    if (push && ahead) { const p = git(dir, 'push', '-u', 'origin', BRANCH); if (!p.ok) throw Error(`push: ${p.out}`); }
    if (push) releaseSyncedTrades(dir, snap.side, base);
    let adopted = '';
    if (push && mine && capacity !== null && process.env.FLEET_ADOPT !== '0') {
        try { adopted = ` adoption=${adoptionPass(dir, snap.side, capacity, base) || 'none'}`; }
        catch (e) { adopted = ` adoption=failed: ${String(e).replace(/\s+/g, ' ').slice(0, 160)}`; }
    }
    return `side=${snap.side} accounts=${snap.accounts.length} claims=${claim ? claim.resources.length : jobs ? 'kept: published by the session running this side' : 'unreadable plan'} lease=${leaseNote} committed=${staged} pushed=${push && ahead}${keptOrders.length ? ` kept-claimed-orders=${keptOrders.length}` : ''}${restored.length ? ` restored-autostash=${restored.length}` : ''}${adopted}`;
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

function adoptionPass(dir: string, side: string, capacity: number, base = root): string {
    const moves = planAdoption(dir, side, capacity, base);
    if (!moves.length) return '';
    const landed = transferFleetOwnersLocked(base, moves, dir);
    return landed.length ? describeMoves(landed) : 'lost to another side';
}

export function planAdoption(dir: string, side: string, capacity: number, base = root) {
    const gitWindow = fleetGitWindow(base, 'fleet adoption', 60_000);
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
        // One line: the fleet agent logs the RESULT line alone, and git puts its error after its progress lines.
        catch (e) { console.log(`RESULT fail fleet-sync ${String(e).replace(/\s+/g, ' ').slice(0, 600)}`); process.exit(1); }
    }
}

if (import.meta.main) {
    await runFleetSyncCli(process.argv.slice(2));
}
