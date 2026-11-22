import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadOwners, mySide, sideOf } from '../../../core/src/fleet';
import { readPreloginFailure, validOrder, type Order, type TradeRole } from '../../../core/src/fleet-trade-settlement';
import { hasStopFile, lifecycleRootForRead, resolveFleetDataDir, statusReadDirs } from '../../../core/src/practice-paths';
import { liveLogoutRef } from '../../../core/src/session-admission';
import { readLogoutProof } from '../../../core/src/session-lifecycle';
import { releaseEntries, releaseFiles, standingAccounts, standingPeer, workerLaunchers, workerSourceRoots } from '../../../core/src/worker-release';
import { few, type Dirty, type LiveRun, type UpdateInput } from './inspect';
import { SDK_PATCH } from './vendor';

export type UpdatePlan = { action: 'none' | 'wait'; reason: string } | { action: 'update'; adopt: Dirty[] };
export type LiveRunsOptions = {
    fleetDir?: string;
    side?: string;
    checkLogout?: (account: string) => void;
};

const MANIFEST = /(?:^|\/)(?:package\.json|bun\.lock|bunfig\.toml|tsconfig\.json)$/;
const QUALIFICATION_ROOTS = [...workerSourceRoots, 'knowledge'];

export function qualificationSource(path: string): boolean {
    if (path.endsWith('.test.ts')) return false;
    if (path === SDK_PATCH || ['package.json', 'bun.lock', 'tsconfig.json', 'bunfig.toml'].includes(path)) return true;
    if (path.startsWith('packages/dashboard/')) return false;
    return QUALIFICATION_ROOTS.some(r => path.startsWith(r + '/'));
}

export function planUpdate(i: UpdateInput): UpdatePlan {
    if (i.branch !== 'master') return { action: 'none', reason: `checkout is on ${i.branch}` };
    if (!i.behind) return { action: 'none', reason: 'current' };
    if (i.ahead) return { action: 'wait', reason: `${i.ahead} local commits are not on origin/master` };
    if (i.holds.length) return { action: 'wait', reason: i.holds[0]! };
    const checked = i.qualifications?.length ? i.incoming.filter(qualificationSource) : [];
    if (checked.length) return { action: 'wait', reason: `${i.qualifications![0]} and checks ${few(checked)}` };
    const incoming = new Set(i.incoming);
    const manifests = i.incoming.filter(f => MANIFEST.test(f) && !(f === 'bunfig.toml' && i.bunfigPreloadOnly));
    if (manifests.length) return { action: 'wait', reason: `dependency change needs bun install: ${few(manifests)}` };
    const owned = i.heldFiles.filter(f => incoming.has(f));
    if (owned.length) return { action: 'wait', reason: `a running build owns ${few(owned)}` };
    for (const run of i.liveRuns ?? []) {
        if (run.unknown) return { action: 'wait', reason: `the live run of ${run.name} has an entry that this checkout cannot read: its files are not known` };
        const loaded = run.files.filter(f => incoming.has(f));
        if (loaded.length) return { action: 'wait', reason: `the live run of ${run.name} loads ${few(loaded)}` };
    }
    if (i.vendorRelease?.length && i.liveRuns?.length) return { action: 'wait', reason: `the live run of ${i.liveRuns[0]!.name} loads ${few(i.vendorRelease)} (changed by the SDK patch)` };
    const touched = i.dirty.filter(d => incoming.has(d.path));
    const differs = touched.filter(d => !d.sameAsTarget && !d.mergedDelivery && d.rebase === undefined).map(d => d.path);
    if (differs.length) return { action: 'wait', reason: `local edit differs from master: ${few(differs)}` };
    return { action: 'update', adopt: touched };
}

const ownedFiles = (workspace: string): string[] => {
    try { return Object.keys(JSON.parse(readFileSync(join(workspace, '.workspace.json'), 'utf8')).base ?? {}); } catch { return []; }
};

export function coordinatorHolds(root: string, workspace: (capability: string) => string): { holds: string[]; heldFiles: string[]; qualifications: string[] } {
    const dir = join(root, '.practice', 'coordinator'), holds: string[] = [], heldFiles: string[] = [], qualifications: string[] = [];
    if (existsSync(join(dir, 'build-lock.json'))) holds.push('the runtime build lock is held');
    if (existsSync(join(dir, 'publish-request.json'))) holds.push('a build waits to publish');
    const file = join(dir, 'state.json');
    if (existsSync(file)) {
        let tasks: any[];
        try { tasks = JSON.parse(readFileSync(file, 'utf8')).tasks ?? []; } catch { return { holds: [...holds, 'coordinator state is not readable'], heldFiles, qualifications }; }
        for (const t of tasks) {
            if (t?.status !== 'running') continue;
            if (t.spec?.kind === 'qualify') qualifications.push(`qualification ${t.spec.id} runs`);
            if (t.spec?.kind === 'build' && typeof t.spec.capability === 'string') heldFiles.push(...ownedFiles(workspace(t.spec.capability)));
            if (t.spec?.launch === 'specialist' || t.spec?.launch === 'main') {
                const who = typeof t.spec.account === 'string' && t.spec.account ? t.spec.account : typeof t.spec.id === 'string' && t.spec.id ? t.spec.id : 'launch';
                holds.push(`${t.spec.launch} launch ${who} runs`);
            }
        }
    }
    return { holds, heldFiles, qualifications };
}

function defaultTradeFleetDir(root: string): string | null {
    for (const candidate of [join(resolveFleetDataDir(root), 'fleet'), join(root, '.practice', 'fleet-data', 'fleet'), join(root, 'fleet')]) {
        if (existsSync(join(candidate, 'orders'))) return candidate;
    }
    return null;
}

function readJsonFile(file: string): any {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function tradePartnerBlocked(root: string, server: string, account: string, activeAccounts: ReadonlySet<string>, now: number, options?: LiveRunsOptions): boolean {
    const fleetDir = options?.fleetDir ?? defaultTradeFleetDir(root);
    const ordersDir = fleetDir ? join(fleetDir, 'orders') : null;
    if (!fleetDir || !ordersDir || !existsSync(ordersDir)) return false;
    const me = account.toLowerCase(), receiptsDir = join(fleetDir, 'receipts'), preloginDir = join(fleetDir, 'prelogin-failed');
    const candidates: { order: Order; role: TradeRole; prepared: boolean }[] = [];
    for (const file of readdirSync(ordersDir)) {
        if (!file.endsWith('.json')) continue;
        const order = readJsonFile(join(ordersDir, file));
        if (!validOrder(order) || order.server.toLowerCase() !== server.toLowerCase() || now < order.start || now >= order.end) continue;
        const role: TradeRole | null = order.from.toLowerCase() === me ? 'from' : order.to.toLowerCase() === me ? 'to' : null;
        if (!role) continue;
        const own = readJsonFile(join(receiptsDir, `${order.id}.${role}.json`));
        if (own?.version === 2 && own.id === order.id && (own.state === 'settled' || own.state === 'failed')) continue;
        candidates.push({ order, role, prepared: own?.version === 2 && own.id === order.id && own.state === 'prepared' });
    }
    candidates.sort((a, b) => Number(b.prepared) - Number(a.prepared) || a.order.start - b.order.start);
    const active = candidates[0];
    if (!active) return false;
    const otherRole: TradeRole = active.role === 'from' ? 'to' : 'from', partner = active.order[otherRole];
    const partnerReceipt = readJsonFile(join(receiptsDir, `${active.order.id}.${otherRole}.json`));
    if (partnerReceipt?.version === 2 && partnerReceipt.id === active.order.id && partnerReceipt.state === 'failed') return true;
    if (readPreloginFailure(preloginDir, active.order, otherRole) !== null) return true;
    if (partnerReceipt || activeAccounts.has(partner.toLowerCase())) return false;
    const owners = loadOwners(join(fleetDir, 'owners.json')), side = options?.side ?? mySide();
    if (sideOf(partner, owners) !== side) return false;
    if (hasStopFile('swarm', root) || hasStopFile(partner, root)) return true;
    const checkLogout = options?.checkLogout ?? ((name: string) => {
        if (server === LIVE_SERVER) { liveLogoutRef(name, root, false, now); return; }
        const proof = readLogoutProof(name, server, { root: lifecycleRootForRead(server, root) });
        if (proof.state !== 'none' && proof.state !== 'confirmed') throw Error('account logout is not confirmed');
    });
    try { checkLogout(partner); return false; } catch { return true; }
}

export const TRADE_ENTRY = 'scripts/fleet-trade.ts', TRADE_HOLD_MS = 45 * 60_000;
export const LIVE_ROW_MS = 200_000, LIVE_SERVER = 'rs-sdk-demo.fly.dev';

export function liveRuns(root: string, server: string, closure: (entries: string[]) => string[], now = Date.now(), options?: LiveRunsOptions): LiveRun[] {
    const owners = standingAccounts(root), runs: LiveRun[] = [];
    const rows: any[] = [];
    const seen = new Set<string>();
    for (const dir of statusReadDirs(root)) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.json') || seen.has(file.toLowerCase())) continue;
            seen.add(file.toLowerCase());
            let row: any; try { row = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
            if (row?.server !== server || row.result || !Number.isFinite(row.at) || now - row.at >= LIVE_ROW_MS) continue;
            rows.push(row);
        }
    }
    const activeAccounts = new Set(rows.map(row => String(row.name).toLowerCase()));
    for (const row of rows) {
        if (standingPeer(row, owners)) continue;
        const entries = releaseEntries(row.workEntry).map(entry => relative(resolve(root), resolve(root, entry)).replaceAll('\\', '/'));
        if (entries.includes(TRADE_ENTRY) && (
            Number.isFinite(row.started) && now - row.started >= TRADE_HOLD_MS
            || tradePartnerBlocked(root, server, String(row.name), activeAccounts, now, options)
        )) continue;
        const files = closure(entries);
        runs.push({ name: String(row.name), files, ...(entries.length && !files.length ? { unknown: true as const } : {}) });
    }
    return runs;
}

export function releaseClosure(root: string): (entries: string[]) => string[] {
    const memo: NonNullable<Parameters<typeof releaseFiles>[2]> = new Map();
    return entries => entries.length ? releaseFiles([...entries, ...workerLaunchers], root, memo) : [];
}
