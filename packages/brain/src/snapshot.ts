// Pure WorldSnapshot loader: reads .practice/live/ (and legacy .practice/ fallback paths via practice-paths.ts),
// computes deterministic AccountLifecycle & AccountState per owned account, and enforces offline bank trust + TTL holds.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { admittedByLevels, handNamed } from '../../core/src/army-roster';
import { readLease } from '../../core/src/controllers';
import { loadOwners, mySide, SIDE_NAME, type Owner } from '../../core/src/fleet';
import { publishedSideHold } from '../../core/src/fleet-side-card';
import { canonicalRows, ownerOfIn, readSnapshotFiles } from '../../core/src/fleet-snapshots';
import { orderLines, tradeSettlement, validOrder, type Order, type Receipt } from '../../core/src/fleet-trade-settlement';
import { isLocalServer } from '../../core/src/localserver';
import { NAMES } from '../../core/src/names';
import {
    findStopFile,
    lifecycleReadRoots,
    liveFleetDataDir,
    liveRoot,
    practiceRoot,
    readStopFile,
    repoRoot,
    resolveFleetDataDir,
    simLifecycleRoot,
    simStatusDir,
    statusReadDirs,
} from '../../core/src/practice-paths';
import { PVP_DEATH_SCHEMA, type PvpDeath } from '../../core/src/pvp-deaths';
import { readLatestAttemptReceipt, readLogoutProof, type AttemptReceipt, type LogoutProof } from '../../core/src/session-lifecycle';
import { RESERVED_ACCOUNTS } from '../../core/src/specialist-boards';
import type { World } from '../../core/src/world';
import { isWorkerQuestState, isWorkerTile, type WorkerQuestState, type WorkerTile } from '../../workers/src/contracts';
import {
    HUB_BANKER_LOCATIONS,
    isProtectedAccountName,
    isTransferOrder,
    pruneExpiredCooldowns,
    pruneExpiredHolds,
    reconcileOfflineBankTrust,
    validateAccountState,
    validateWorldSnapshot,
    type AccountActiveJob,
    type AccountBankState,
    type AccountLifecycle,
    type AccountRole,
    type AccountState,
    type FleetSideStatus,
    type HubBankId,
    type SystemHold,
    type TransferOrder,
    type WorldSnapshot,
} from './contracts';

export const DEFAULT_LIVE_SERVER = 'rs-sdk-demo.fly.dev';
export const LIVE_STATUS_ACTIVE_MS = 30_000;
export const BOOTSTRAP_STATUS_OFFLINE_MS = 15 * 60_000;

export interface SafeHubRegion {
    readonly id: string;
    readonly name: string;
    readonly xMin: number;
    readonly xMax: number;
    readonly zMin: number;
    readonly zMax: number;
    readonly level: number;
}

// Mainland hubs/cities and elevated safe bank enclosures on rev-289.
// Accounts offline outside these regions (Wilderness, dungeons, islands, non-bank upper floors) trigger location recovery.
export const SAFE_HUB_REGIONS: readonly SafeHubRegion[] = [
    { id: 'misthalin-asgarnia-mainland', name: 'Lumbridge / Draynor / Al Kharid / Varrock / Falador / Edgeville', xMin: 2925, xMax: 3340, zMin: 3145, zMax: 3519, level: 0 },
    { id: 'kandarin-mainland', name: 'Catherby / Seers / Ardougne / Yanille / Gnome Stronghold', xMin: 2425, xMax: 2875, zMin: 3065, zMax: 3525, level: 0 },
    { id: 'lumbridge-bank-top', name: 'Lumbridge Castle Bank (top floor)', xMin: 3205, xMax: 3212, zMin: 3214, zMax: 3224, level: 2 },
    { id: 'gnome-bank-upper', name: 'Gnome Stronghold Tree Bank', xMin: 2442, xMax: 2452, zMin: 3478, zMax: 3488, level: 1 },
];

const STALE_AUTO_STOP_TEXT =
    /^(?:fleet-health auto-paused:|swarm stopped\b|swarm plan removed or stopped\b|swarm recovery stopped\b|inherited recovery stopped\b|fleet controller lease unavailable\b|swarm:\s)/i;
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_ -]{1,12}$/;
const SKILL_PLACEHOLDER_RE = /^Stat\d+$/i;

export interface LoadWorldSnapshotOptions {
    readonly root?: string;
    readonly now?: number;
    readonly server?: string;
    readonly side?: string;
    readonly fleetDir?: string;
    readonly activeAccounts?: ReadonlySet<string> | ReadonlyMap<string, AccountActiveJob>;
    readonly holdsByAccount?: ReadonlyMap<string, readonly SystemHold[]>;
    readonly cooldownsByAccount?: ReadonlyMap<string, Readonly<Record<string, number>>>;
    readonly marketCooldowns?: Readonly<Record<string, number>>;
    readonly reserves?: Readonly<Record<string, Readonly<Record<number, number>>>>;
    readonly globalReserves?: Readonly<Record<number, number>>;
    readonly spotOccupancy?: Readonly<Record<string, number>>;
    readonly activitySpotById?: ReadonlyMap<string, string>;
    readonly geEscrowCoins?: Readonly<Record<string, number>>;
    readonly activeTransfers?: readonly TransferOrder[];
    readonly world?: World;
    readonly maxStatusAgeMs?: number;
}

export interface SnapshotAccountDiagnostic {
    readonly account: string;
    readonly lifecycle: AccountLifecycle;
    readonly reason: string;
    readonly logoutState: LogoutProof['state'] | 'not_applicable';
    readonly bankTrusted: boolean;
    readonly ownerStopPath?: string;
}

export interface WorldSnapshotDiagnostics {
    readonly snapshot: WorldSnapshot;
    readonly accounts: Readonly<Record<string, SnapshotAccountDiagnostic>>;
    readonly readRoots: {
        readonly statusDirs: readonly string[];
        readonly lifecycleRoots: readonly string[];
        readonly fleetDir: string;
    };
}

export interface AccountLifecycleInput {
    readonly name: string;
    readonly protectedClock: boolean;
    readonly ownerPaused?: boolean;
    readonly dead?: boolean;
    readonly running?: boolean;
    readonly inTrade?: boolean;
    readonly logoutProofState?: LogoutProof['state'];
    readonly statusSettledOffline?: boolean;
    readonly pos?: WorkerTile | null;
    readonly strandedHold?: boolean;
    readonly activeLaunchAuthorized?: boolean;
}

function safeReadJson<T = unknown>(file: string): T | null {
    if (!existsSync(file)) return null;
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

function resolveFleetDir(root: string, explicit?: string): string {
    if (explicit) return resolve(explicit);
    const liveData = liveFleetDataDir(root);
    if (existsSync(join(liveData, 'fleet', 'owners.json'))) return join(liveData, 'fleet');
    const resolvedWorktree = resolveFleetDataDir(root);
    if (existsSync(join(resolvedWorktree, 'fleet', 'owners.json'))) return join(resolvedWorktree, 'fleet');
    if (existsSync(join(resolvedWorktree, 'owners.json'))) return resolvedWorktree;
    return join(root, 'fleet');
}

function resolveStatusDirs(root: string, server: string): string[] {
    return isLocalServer(server) ? [simStatusDir(root)] : statusReadDirs(root);
}

function resolveLifecycleRoots(root: string, server: string): string[] {
    return isLocalServer(server) ? [simLifecycleRoot(root)] : lifecycleReadRoots(root);
}

function isInsideSafeHub(pos: WorkerTile): boolean {
    for (const r of SAFE_HUB_REGIONS) {
        if (pos.level === r.level && pos.x >= r.xMin && pos.x <= r.xMax && pos.z >= r.zMin && pos.z <= r.zMax) {
            return true;
        }
    }
    return false;
}

function nearestHubDistance(pos: WorkerTile): number {
    let best = Number.POSITIVE_INFINITY;
    for (const hub of Object.values(HUB_BANKER_LOCATIONS)) {
        const d = Math.max(Math.abs(pos.x - hub.bankTile.x), Math.abs(pos.z - hub.bankTile.z));
        if (d < best) best = d;
    }
    return best;
}

export function isStrandedPosition(
    pos: WorkerTile | null,
    opts: { readonly maxHubRadius?: number } = {},
): boolean {
    if (!pos) return false;
    if (pos.z >= 6400) return true; // dungeons / underground / instances
    if (pos.x >= 2944 && pos.x <= 3391 && pos.z >= 3520 && pos.z <= 3967) return true; // Wilderness
    if (isInsideSafeHub(pos)) return false;
    if (pos.level !== 0) return true; // non-ground plane outside known elevated banks
    if (opts.maxHubRadius !== undefined && Number.isFinite(opts.maxHubRadius)) {
        return nearestHubDistance(pos) > opts.maxHubRadius;
    }
    return true; // outside safe mainland regions (islands, tutorial island, remote traps)
}

export function classifyAccountLifecycle(input: AccountLifecycleInput): AccountLifecycle {
    if (input.ownerPaused) return 'paused_owner';
    if (input.dead) return 'dead';
    if (input.protectedClock && !input.activeLaunchAuthorized) return 'reserved';
    if (input.inTrade) return 'in_trade';
    if (input.running) return 'running';
    if (
        input.logoutProofState === 'held'
        || input.logoutProofState === 'invalid'
        || input.statusSettledOffline === false
    ) {
        return 'needs_logout_recovery';
    }
    if (input.strandedHold || isStrandedPosition(input.pos ?? null)) {
        return 'needs_location_recovery';
    }
    return 'idle';
}

function loadStatusMap(dirs: readonly string[], server: string, now: number): Map<string, any> {
    const out = new Map<string, any>();
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const raw = safeReadJson<any>(join(dir, f));
            if (!raw || typeof raw !== 'object' || raw.practice === true) continue;
            if (typeof raw.name !== 'string' || !ACCOUNT_NAME_RE.test(raw.name)) continue;
            if (typeof raw.server !== 'string' || raw.server.toLowerCase() !== server) continue;
            if (raw.at !== undefined && (!Number.isFinite(raw.at) || raw.at < 0 || raw.at > now + 60_000)) continue;
            const key = raw.name.toLowerCase();
            const prev = out.get(key);
            const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0;
            const prevAt = typeof prev?.at === 'number' && Number.isFinite(prev.at) ? prev.at : -1;
            if (!prev || at > prevAt) out.set(key, raw);
        }
    }
    return out;
}

function loadOwnedAccountSet(root: string, server: string): Set<string> {
    const out = new Set<string>();
    for (const file of [join(liveRoot(root), 'owned-accounts.json'), join(practiceRoot(root), 'owned-accounts.json')]) {
        const parsed = safeReadJson<Record<string, { server?: string }>>(file);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        for (const [name, entry] of Object.entries(parsed)) {
            if (!ACCOUNT_NAME_RE.test(name)) continue;
            if (typeof entry?.server === 'string' && entry.server.toLowerCase() === server) {
                out.add(name.toLowerCase());
            }
        }
    }
    return out;
}

function loadDeathSet(root: string, server: string): Set<string> {
    const dead = new Set<string>();
    for (const file of [join(liveRoot(root), 'swarm-deaths.json'), join(practiceRoot(root), 'swarm-deaths.json')]) {
        const parsed = safeReadJson<Record<string, { reason?: unknown }>>(file);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        for (const [name, entry] of Object.entries(parsed)) {
            if (typeof entry?.reason === 'string' && /^died\b/i.test(entry.reason.trim())) {
                dead.add(name.toLowerCase());
            }
        }
    }
    for (const file of [join(liveRoot(root), 'pvp-deaths.json'), join(practiceRoot(root), 'pvp-deaths.json')]) {
        const parsed = safeReadJson<PvpDeath[]>(file);
        if (!Array.isArray(parsed)) continue;
        for (const entry of parsed) {
            if (entry?.schema === PVP_DEATH_SCHEMA && typeof entry.account === 'string'
                && typeof entry.server === 'string' && entry.server.toLowerCase() === server) {
                dead.add(entry.account.toLowerCase());
            }
        }
    }
    return dead;
}

function isStatusDeathResult(result: unknown): boolean {
    if (typeof result !== 'string') return false;
    const trimmed = result.trim();
    return /^(?:RESULT\s+)?fail\s+died(?:\b|$)/i.test(trimmed) || /\bdied=true\b/i.test(trimmed);
}

function loadPersistedOutcomeOverlay(root: string, now: number): {
    marketCooldowns: Record<string, number>;
    accountCooldowns: Record<string, Record<string, number>>;
    accountHolds: Record<string, SystemHold[]>;
    lifecycleOverrides: Record<string, AccountLifecycle>;
} {
    const empty = {
        marketCooldowns: {},
        accountCooldowns: {},
        accountHolds: {},
        lifecycleOverrides: {},
    };
    const raw = safeReadJson<any>(join(liveRoot(root), 'outcome-state.json'));
    if (!raw || typeof raw !== 'object') return empty;
    const marketCooldowns: Record<string, number> =
        raw.marketCooldowns && typeof raw.marketCooldowns === 'object' ? { ...raw.marketCooldowns } : {};
    const accountCooldowns: Record<string, Record<string, number>> = {};
    const accountHolds: Record<string, SystemHold[]> = {};
    const lifecycleOverrides: Record<string, AccountLifecycle> = {};

    if (raw.accountCooldowns && typeof raw.accountCooldowns === 'object') {
        for (const [acct, cd] of Object.entries(raw.accountCooldowns)) {
            if (cd && typeof cd === 'object') accountCooldowns[acct.toLowerCase()] = { ...(cd as Record<string, number>) };
        }
    }
    if (raw.accountHolds && typeof raw.accountHolds === 'object') {
        for (const [acct, holds] of Object.entries(raw.accountHolds)) {
            if (Array.isArray(holds)) accountHolds[acct.toLowerCase()] = [...(holds as SystemHold[])];
        }
    }
    if (raw.accountLifecycleOverrides && typeof raw.accountLifecycleOverrides === 'object') {
        for (const [acct, lc] of Object.entries(raw.accountLifecycleOverrides)) {
            if (typeof lc === 'string') lifecycleOverrides[acct.toLowerCase()] = lc as AccountLifecycle;
        }
    }
    if (raw.accountOverlays && typeof raw.accountOverlays === 'object') {
        for (const [acct, entry] of Object.entries(raw.accountOverlays as Record<string, any>)) {
            if (!entry || typeof entry !== 'object') continue;
            const lower = acct.toLowerCase();
            if (entry.cooldowns && typeof entry.cooldowns === 'object') {
                accountCooldowns[lower] = { ...(accountCooldowns[lower] ?? {}), ...entry.cooldowns };
            }
            if (Array.isArray(entry.holds)) {
                accountHolds[lower] = [...(accountHolds[lower] ?? []), ...(entry.holds as SystemHold[])];
            }
            if (typeof entry.lifecycleOverride === 'string') {
                const lc = entry.lifecycleOverride as AccountLifecycle;
                const exp = typeof entry.lifecycleExpiresAt === 'number' ? entry.lifecycleExpiresAt : undefined;
                if (lc === 'dead' || lc === 'paused_owner' || exp === undefined || now < exp) {
                    lifecycleOverrides[lower] = lc;
                }
            }
        }
    }
    return {
        marketCooldowns,
        accountCooldowns,
        accountHolds,
        lifecycleOverrides,
    };
}

function readRemoteSpotOccupancy(
    fleetDir: string,
    localSide: string,
    now: number,
): { occupancy: Record<string, number>; coveredSides: Set<string> } {
    const occupancy: Record<string, number> = {};
    const coveredSides = new Set<string>();
    const claimsDir = join(fleetDir, 'claims');
    if (!existsSync(claimsDir)) return { occupancy, coveredSides };
    let files: string[] = [];
    try { files = readdirSync(claimsDir); } catch { return { occupancy, coveredSides }; }
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const claim = safeReadJson<{ side?: unknown; at?: unknown; resources?: unknown }>(join(claimsDir, f));
        if (!claim || typeof claim.side !== 'string' || !SIDE_NAME.test(claim.side) || claim.side === localSide) continue;
        if (typeof claim.at !== 'number' || !Number.isFinite(claim.at) || now - claim.at >= 2 * 3_600_000 || claim.at - now > 60_000) {
            continue;
        }
        coveredSides.add(claim.side);
        if (!Array.isArray(claim.resources)) continue;
        for (const res of claim.resources) {
            if (typeof res === 'string' && res.trim().length > 0) {
                const key = res.trim();
                occupancy[key] = (occupancy[key] ?? 0) + 1;
            }
        }
    }
    return { occupancy, coveredSides };
}

function readSideCards(fleetDir: string): Map<string, any> {
    const out = new Map<string, any>();
    const dir = join(fleetDir, 'sides');
    if (!existsSync(dir)) return out;
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { return out; }
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const card = safeReadJson<any>(join(dir, f));
        if (card && typeof card.side === 'string' && SIDE_NAME.test(card.side)) {
            out.set(card.side, card);
        }
    }
    return out;
}

interface OrdersReceiptsCacheEntry {
    readonly ordersCount: number;
    readonly ordersDirMtime: number;
    readonly receiptsCount: number;
    readonly receiptsDirMtime: number;
    readonly earliestPendingEnd: number;
    readonly activeOrders: readonly TransferOrder[];
    readonly settledTransferByAccount: ReadonlyMap<string, number>;
}

const ordersReceiptsCache = new Map<string, OrdersReceiptsCacheEntry>();

function dirStatSignature(dir: string): { count: number; mtimeMs: number; files: string[] } {
    if (!existsSync(dir)) return { count: 0, mtimeMs: 0, files: [] };
    try {
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        const mtimeMs = statSync(dir).mtimeMs;
        return { count: files.length, mtimeMs, files };
    } catch {
        return { count: 0, mtimeMs: 0, files: [] };
    }
}

function readOrdersAndReceipts(
    fleetDir: string,
    server: string,
    now: number,
): {
    activeOrders: TransferOrder[];
    inTradeAccounts: Set<string>;
    settledTransferByAccount: Map<string, number>;
} {
    const ordersDir = join(fleetDir, 'orders');
    const receiptsDir = join(fleetDir, 'receipts');
    const ordSig = dirStatSignature(ordersDir);
    const recSig = dirStatSignature(receiptsDir);
    const cacheKey = `${resolve(fleetDir)}|${server}`;
    const totalFiles = ordSig.count + recSig.count;

    if (totalFiles > 100) {
        const cached = ordersReceiptsCache.get(cacheKey);
        if (
            cached
            && cached.ordersCount === ordSig.count
            && cached.ordersDirMtime === ordSig.mtimeMs
            && cached.receiptsCount === recSig.count
            && cached.receiptsDirMtime === recSig.mtimeMs
            && (cached.earliestPendingEnd === Number.POSITIVE_INFINITY || now < cached.earliestPendingEnd)
            && cached.activeOrders.length === 0
        ) {
            return {
                activeOrders: [],
                inTradeAccounts: new Set<string>(),
                settledTransferByAccount: new Map(cached.settledTransferByAccount),
            };
        }
    }

    const receiptsByOrderId = new Map<string, Receipt[]>();
    const settledTransferByAccount = new Map<string, number>();

    for (const f of recSig.files) {
        const r = safeReadJson<Receipt>(join(receiptsDir, f));
        if (!r || typeof r.id !== 'string') continue;
        const list = receiptsByOrderId.get(r.id);
        if (list) list.push(r);
        else receiptsByOrderId.set(r.id, [r]);

        const isSettled = ('version' in r && r.version === 2) ? r.state === 'settled' : r.ok === true;
        if (!isSettled || typeof r.account !== 'string' || !Number.isFinite(r.at)) continue;
        if ('server' in r && typeof r.server === 'string' && r.server.toLowerCase() !== server) continue;
        const key = r.account.toLowerCase();
        const prev = settledTransferByAccount.get(key) ?? 0;
        if (r.at > prev) settledTransferByAccount.set(key, r.at);
    }

    const activeOrders: TransferOrder[] = [];
    const inTradeAccounts = new Set<string>();
    let earliestPendingEnd = Number.POSITIVE_INFINITY;

    for (const f of ordSig.files) {
        const order = safeReadJson<Order>(join(ordersDir, f));
        if (!validOrder(order) || order.server.toLowerCase() !== server || now >= order.end) continue;
        const orderReceipts = receiptsByOrderId.get(order.id) ?? [];
        const settlement = tradeSettlement(order, orderReceipts, now);
        if (settlement.state === 'pending') {
            if (order.end < earliestPendingEnd) earliestPendingEnd = order.end;
            inTradeAccounts.add(order.from.toLowerCase());
            inTradeAccounts.add(order.to.toLowerCase());
            const hub = inferHubFromOrder(order);
            const lines = orderLines(order)
                .filter((l) => typeof l.itemId === 'number' && Number.isSafeInteger(l.itemId) && l.itemId >= 0)
                .map((l) => ({ itemId: l.itemId!, itemName: l.item, count: l.count }));
            if (lines.length > 0) {
                const transfer: TransferOrder = {
                    id: order.id,
                    server: order.server,
                    from: order.from,
                    to: order.to,
                    hub,
                    items: lines,
                    demandId: `fleet-order:${order.id}`,
                    reason: `fleet order ${order.item}`,
                    createdAt: order.start,
                    expiresAt: order.end,
                    state: 'in_progress',
                    bothIdleVerified: true,
                    donorLogoutConfirmedAt: order.start,
                    recipientLogoutConfirmedAt: order.start,
                    antiPingPong: { donorHoldsDemandForItems: false, cooldownWindowMs: 600_000 },
                };
                if (isTransferOrder(transfer)) activeOrders.push(transfer);
            }
        }
    }

    if (totalFiles > 100) {
        ordersReceiptsCache.set(cacheKey, {
            ordersCount: ordSig.count,
            ordersDirMtime: ordSig.mtimeMs,
            receiptsCount: recSig.count,
            receiptsDirMtime: recSig.mtimeMs,
            earliestPendingEnd,
            activeOrders,
            settledTransferByAccount,
        });
    }

    return { activeOrders, inTradeAccounts, settledTransferByAccount };
}

function inferHubFromOrder(order: Order): HubBankId {
    const meet = order.meet?.[0];
    if (meet) {
        const dArdy = Math.hypot(meet.x - HUB_BANKER_LOCATIONS.ardougne.bankTile.x, meet.z - HUB_BANKER_LOCATIONS.ardougne.bankTile.z);
        const dVarrock = Math.hypot(meet.x - HUB_BANKER_LOCATIONS.varrock_west.bankTile.x, meet.z - HUB_BANKER_LOCATIONS.varrock_west.bankTile.z);
        if (dArdy < dVarrock) return 'ardougne';
    }
    return 'varrock_west';
}

function normalizeSkills(raw: unknown): Record<string, { level: number; xp: number }> {
    const out: Record<string, { level: number; xp: number }> = {};
    if (!Array.isArray(raw)) return out;
    for (const k of raw) {
        if (!k || typeof k.name !== 'string' || !k.name.trim() || SKILL_PLACEHOLDER_RE.test(k.name)) continue;
        const level = Number.isSafeInteger(k.level) && k.level >= 1 && k.level <= 99 ? k.level : null;
        const xp = typeof k.xp === 'number' && Number.isFinite(k.xp) && k.xp >= 0 ? k.xp : 0;
        if (level !== null) out[k.name] = { level, xp };
    }
    return out;
}

function normalizeQuests(rawRow: any): Record<string, WorkerQuestState> {
    const out: Record<string, WorkerQuestState> = {};
    const list = Array.isArray(rawRow?.questJournal)
        ? rawRow.questJournal
        : Array.isArray(rawRow?.quests)
            ? rawRow.quests
            : [];
    for (const q of list) {
        if (typeof q === 'string') {
            if (q.trim()) out[q.trim()] = 'complete';
            continue;
        }
        if (!q || typeof q.name !== 'string' || !q.name.trim()) continue;
        const stateRaw = q.state === 'not started' ? 'not_started' : q.state;
        if (isWorkerQuestState(stateRaw)) out[q.name.trim()] = stateRaw;
    }
    return out;
}

function normalizeItemContainer(raw: unknown): Record<number, number> {
    const out: Record<number, number> = {};
    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const id = Number(item.id);
        const count = Number(item.count);
        if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(count) || count <= 0) continue;
        out[id] = (out[id] ?? 0) + count;
    }
    return out;
}

function normalizeTile(raw: unknown): WorkerTile | null {
    if (!isWorkerTile(raw)) return null;
    return { x: raw.x, z: raw.z, level: raw.level };
}

function resolveAccountRole(
    name: string,
    skills: Readonly<Record<string, { level: number; xp: number }>>,
    swarmPlan: any,
): AccountRole {
    const lower = name.toLowerCase();
    if (lower === 'haggis') return 'main';
    if (isProtectedAccountName(name)) return 'specialist';

    const armyList = Array.isArray(swarmPlan?.army) ? swarmPlan.army : [];
    const inArmyList = armyList.some((e: any) =>
        (typeof e === 'string' ? e : e?.account)?.toLowerCase?.() === lower,
    );
    const skillLevels = Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, v.level]));
    if (inArmyList || admittedByLevels(name, skillLevels)) return 'army';

    const jobs = Array.isArray(swarmPlan?.jobs) ? swarmPlan.jobs : [];
    const matchingJob = jobs.find((j: any) =>
        j?.account?.toLowerCase?.() === lower
        || (Array.isArray(j?.accounts) && j.accounts.some((a: any) => a?.toLowerCase?.() === lower)),
    );
    const jobRole = typeof matchingJob?.role === 'string' ? matchingJob.role.toLowerCase() : '';
    if (['pvp', 'pk', 'army', 'pk-trainee'].includes(jobRole)) return 'army';
    if (['supply', 'supplier', 'helper', 'bank', 'banker'].includes(jobRole)) return 'helper';

    for (const [category, list] of Object.entries(NAMES)) {
        if ((list as readonly string[]).some((n) => n.toLowerCase() === lower)) {
            if (category === 'bank' || category === 'helper') return 'helper';
            if (category === 'combat' && (skills.Attack?.level ?? 1) >= 60) return 'army';
        }
    }
    return 'auto';
}

function readGeEscrowByAccount(root: string, server: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const dir of [join(liveRoot(root), 'ge-orders'), join(practiceRoot(root), 'ge-orders')]) {
        if (!existsSync(dir)) continue;
        let files: string[] = [];
        try { files = readdirSync(dir); } catch { continue; }
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const order = safeReadJson<any>(join(dir, f));
            if (!order || typeof order.actor !== 'string' || !ACCOUNT_NAME_RE.test(order.actor)) continue;
            if (typeof order.server === 'string' && order.server.toLowerCase() !== server) continue;
            if (order.settled === true || order.cancelled === true) continue;
            const escrow = Number(order.escrow);
            if (Number.isSafeInteger(escrow) && escrow > 0) {
                const key = order.actor.toLowerCase();
                out[key] = (out[key] ?? 0) + escrow;
            }
        }
    }
    return out;
}

function inferLogoutProofAndLatestAttempt(
    name: string,
    server: string,
    lifecycleRoots: readonly string[],
): { proof: LogoutProof; latestAttempt?: AttemptReceipt } {
    for (const lcRoot of lifecycleRoots) {
        const proof = readLogoutProof(name, server, { root: lcRoot });
        if (proof.state !== 'none') {
            const latest = readLatestAttemptReceipt(name, server, { root: lcRoot });
            return { proof, latestAttempt: latest?.receipt };
        }
    }
    return { proof: { state: 'none', account: name, server, domain: isLocalServer(server) ? 'practice' : 'live' } };
}

function latestReceiptMatchesSession(attempt: AttemptReceipt | undefined, status: any): boolean {
    if (!attempt || !status) return false;
    return status.sessionAttemptId === attempt.attemptId;
}

export function inspectWorldSnapshot(opts: LoadWorldSnapshotOptions = {}): WorldSnapshotDiagnostics {
    const root = resolve(opts.root ?? repoRoot);
    const now = opts.now ?? Date.now();
    const server = (opts.server ?? DEFAULT_LIVE_SERVER).toLowerCase();
    const side = opts.side ?? mySide();
    const maxStatusAgeMs = opts.maxStatusAgeMs ?? LIVE_STATUS_ACTIVE_MS;
    const fleetDir = resolveFleetDir(root, opts.fleetDir);
    const statusDirs = resolveStatusDirs(root, server);
    const lcRoots = resolveLifecycleRoots(root, server);

    let owners = new Map<string, Owner>();
    try { owners = loadOwners(join(fleetDir, 'owners.json')); } catch { /* absent or empty */ }

    const statusMap = loadStatusMap(statusDirs, server, now);
    const ownedLocal = loadOwnedAccountSet(root, server);
    const deathSet = loadDeathSet(root, server);
    const overlay = loadPersistedOutcomeOverlay(root, now);
    const sideCards = readSideCards(fleetDir);
    const snapshotFiles = readSnapshotFiles(join(fleetDir, 'snapshots'));
    const ownerOf = ownerOfIn(fleetDir);
    const canonicalRemote = canonicalRows(
        snapshotFiles.map((sf) => ({
            ...sf,
            accounts: (sf.accounts ?? []).filter((a) => !a?.practice && String(a?.server ?? '').toLowerCase() === server),
        })),
        ownerOf,
    );
    const { activeOrders, inTradeAccounts, settledTransferByAccount } = readOrdersAndReceipts(fleetDir, server, now);

    const swarmPlan = safeReadJson<any>(join(root, 'swarm.json')) ?? {};
    const swarmState = safeReadJson<any>(join(liveRoot(root), 'swarm-state.json'))
        ?? safeReadJson<any>(join(practiceRoot(root), 'swarm-state.json'));
    const heldByHandJob = handNamed(Array.isArray(swarmPlan?.jobs) ? swarmPlan.jobs : [], side);

    // Gather canonical display names across all owned sources.
    const displayNames = new Map<string, string>();
    const registerName = (n: unknown) => {
        if (typeof n !== 'string' || !ACCOUNT_NAME_RE.test(n)) return;
        const lower = n.toLowerCase();
        if (!displayNames.has(lower)) displayNames.set(lower, n);
    };

    if (existsSync(join(fleetDir, 'owners.json'))) {
        const rawOwners = safeReadJson<{ accounts?: Record<string, Owner> }>(join(fleetDir, 'owners.json'));
        for (const [name, o] of Object.entries(rawOwners?.accounts ?? {})) {
            if (o?.server?.toLowerCase() === server) registerName(name);
        }
    }
    for (const lower of ownedLocal) registerName(lower);
    for (const [, st] of statusMap) registerName(st.name);
    for (const [, row] of canonicalRemote) registerName(row.name);
    if (!isLocalServer(server)) {
        for (const reserved of RESERVED_ACCOUNTS) registerName(reserved);
    }

    const activeTransfers: TransferOrder[] = [...activeOrders];
    if (opts.activeTransfers) {
        for (const t of opts.activeTransfers) {
            if (t.state === 'in_progress' && now < t.expiresAt) {
                inTradeAccounts.add(t.from.toLowerCase());
                inTradeAccounts.add(t.to.toLowerCase());
            }
            activeTransfers.push(t);
        }
    }

    const accounts: Record<string, AccountState> = {};
    const diagnostics: Record<string, SnapshotAccountDiagnostic> = {};
    const remoteClaims = readRemoteSpotOccupancy(fleetDir, side, now);
    const spotOccupancy: Record<string, number> = {
        ...remoteClaims.occupancy,
        ...(opts.spotOccupancy ?? {}),
    };

    for (const lower of [...displayNames.keys()].sort()) {
        const rawName = displayNames.get(lower)!;
        const ownerRow = owners.get(lower);
        const acctSide = ownerRow?.side ?? canonicalRemote.get(lower)?.side ?? side;
        const isLocalSide = acctSide === side;
        const localStatus = statusMap.get(lower);
        const remoteRow = canonicalRemote.get(lower);
        const status = isLocalSide
            ? (localStatus ?? remoteRow)
            : (remoteRow && (!localStatus || (remoteRow.at ?? 0) >= (localStatus.at ?? 0)) ? remoteRow : localStatus);
        const name = typeof status?.name === 'string' && ACCOUNT_NAME_RE.test(status.name) ? status.name : rawName;

        const protectedClock = isProtectedAccountName(name);
        const skills = normalizeSkills(status?.skills);
        const role = resolveAccountRole(name, skills, swarmPlan);
        const quests = normalizeQuests(status);
        const pos = normalizeTile(status?.pos);
        const inventory = normalizeItemContainer(status?.inventory);
        const equipment = normalizeItemContainer(status?.equipment);

        // Stop file / side card owner pause check (ignore controller auto-stops).
        let ownerPaused = false;
        let ownerStopPath: string | undefined;
        if (isLocalSide) {
            const stopPath = findStopFile(name, root);
            if (stopPath) {
                const stopText = readStopFile(name, root) ?? '';
                if (!STALE_AUTO_STOP_TEXT.test(stopText.trim())) {
                    ownerPaused = true;
                    ownerStopPath = stopPath;
                }
            }
        } else {
            const card = sideCards.get(acctSide);
            if (publishedSideHold(card, acctSide, name) === 'owner pause') {
                ownerPaused = true;
            }
        }
        if (overlay.lifecycleOverrides[lower] === 'paused_owner') ownerPaused = true;

        // Death check.
        const sideCardDead = !isLocalSide && publishedSideHold(sideCards.get(acctSide), acctSide, name) === 'death hold';
        const dead = deathSet.has(lower)
            || sideCardDead
            || isStatusDeathResult(status?.result)
            || overlay.lifecycleOverrides[lower] === 'dead';

        // Running session detection.
        let activeJob: AccountActiveJob | undefined;
        let isRunning = false;
        if (opts.activeAccounts instanceof Map && opts.activeAccounts.has(lower)) {
            isRunning = true;
            activeJob = opts.activeAccounts.get(lower);
        } else if (opts.activeAccounts instanceof Set && opts.activeAccounts.has(lower)) {
            isRunning = true;
        } else if (
            status
            && !status.result
            && Number.isFinite(status.at)
            && now - status.at >= 0
            && now - status.at < maxStatusAgeMs
        ) {
            isRunning = true;
        }
        if (!isRunning && swarmState && Array.isArray(swarmState.runs)) {
            const runningEntry = swarmState.runs.find((r: any) =>
                Array.isArray(r?.accounts) && r.accounts.some((a: string) => a.toLowerCase() === lower),
            );
            if (runningEntry) {
                isRunning = true;
                activeJob = {
                    activityId: typeof runningEntry.script === 'string' && runningEntry.script ? runningEntry.script : 'legacy:swarm',
                    demandId: typeof runningEntry.goal === 'string' && runningEntry.goal ? runningEntry.goal : 'legacy:active',
                    startedAt: Number.isFinite(runningEntry.started) && runningEntry.started > 0 ? runningEntry.started : now,
                };
            }
        }
        if (isRunning && !activeJob) {
            activeJob = {
                activityId: typeof status?.workEntry === 'string' && status.workEntry.trim()
                    ? status.workEntry.trim()
                    : 'legacy:session',
                demandId: typeof status?.goal === 'string' && status.goal.trim()
                    ? status.goal.trim()
                    : 'legacy:active',
                startedAt: Number.isFinite(status?.started) && status.started > 0
                    ? status.started
                    : (Number.isFinite(status?.at) && status.at > 0 ? status.at : now),
            };
        }

        // Session logout proof & attempt timestamps.
        const { proof, latestAttempt } = isLocalSide
            ? inferLogoutProofAndLatestAttempt(name, server, lcRoots)
            : { proof: { state: 'none' as const, account: name, server, domain: 'live' as const }, latestAttempt: undefined };
        const lastLoginAttemptAt = latestAttempt?.createdAt
            ?? (Number.isFinite(status?.started) && status.started > 0 ? Number(status.started) : undefined);

        // Determine if an unsettled session without a producer proof exists.
        let statusSettledOffline: boolean | undefined;
        if (isLocalSide && !isRunning) {
            if (proof.state === 'confirmed') {
                const statusAfterLogout = Number.isFinite(status?.started) && status.started > proof.loggedOutAt;
                const mismatchedAttempt = typeof status?.sessionAttemptId === 'string'
                    && status.sessionAttemptId !== proof.attemptId
                    && (!Number.isFinite(status.started) || status.started >= (latestAttempt?.createdAt ?? 0));
                statusSettledOffline = !(statusAfterLogout || mismatchedAttempt);
            } else if (proof.state === 'none' && status && status.server?.toLowerCase() === server) {
                const statusAt = Number.isFinite(status.at) ? Number(status.at) : 0;
                const oldEnough = statusAt > 0 && now - statusAt >= BOOTSTRAP_STATUS_OFFLINE_MS;
                statusSettledOffline = Boolean(status.result) && oldEnough;
            }
        }

        const inTrade = inTradeAccounts.has(lower);
        const confirmedOffline = !isRunning
            && !inTrade
            && (isLocalSide
                ? proof.state === 'confirmed' && statusSettledOffline !== false
                : Boolean(status?.bankAt) && Number.isFinite(status?.at) && now - status.at >= BOOTSTRAP_STATUS_OFFLINE_MS);

        // Offline bank trust reconciliation.
        const rawBankItems = normalizeItemContainer(status?.bank);
        const rawBankAt = Number.isFinite(status?.bankAt) && status.bankAt > 0 && status.bankAt <= now
            ? Number(status.bankAt)
            : 0;
        const settledAtRaw = settledTransferByAccount.get(lower);
        // If bank was observed during the same confirmed attempt as the settled transfer, keep trust if observedAt >= attemptStart.
        const lastSettledTransferAt = settledAtRaw !== undefined
            && !(latestReceiptMatchesSession(latestAttempt, status) && rawBankAt >= (latestAttempt?.createdAt ?? Infinity))
            ? settledAtRaw
            : undefined;
        // If the latest confirmed attempt never opened the bank (rawBankAt < latestAttempt.createdAt),
        // lastLoginAttemptAt > rawBankAt causes reconcileOfflineBankTrust to mark bank trusted=false automatically.
        const bank: AccountBankState = reconcileOfflineBankTrust(
            { items: rawBankItems, observedAt: rawBankAt, trusted: rawBankAt > 0 },
            {
                confirmedOffline,
                ...(lastLoginAttemptAt !== undefined ? { lastLoginAttemptAt } : {}),
                ...(lastSettledTransferAt !== undefined ? { lastSettledTransferAt } : {}),
            },
        );

        // Merge & prune expiring holds + cooldowns (never auto-expiring paused_owner or dead).
        const mergedHolds = [
            ...(overlay.accountHolds[lower] ?? []),
            ...(opts.holdsByAccount?.get(lower) ?? []),
        ];
        const activeHolds = pruneExpiredHolds(mergedHolds, now);
        const strandedHold = activeHolds.some((h) => h.kind === 'maintenance' && h.key === 'location_stranded')
            || overlay.lifecycleOverrides[lower] === 'needs_location_recovery';
        const logoutHoldOverride = overlay.lifecycleOverrides[lower] === 'needs_logout_recovery';

        const mergedCooldowns = pruneExpiredCooldowns(
            {
                ...(overlay.accountCooldowns[lower] ?? {}),
                ...(opts.cooldownsByAccount?.get(lower) ?? {}),
            },
            now,
        );

        const activeLaunchAuthorized = protectedClock && (isRunning || Boolean(heldByHandJob.has(lower) && isRunning));

        const lifecycle = classifyAccountLifecycle({
            name,
            protectedClock,
            ownerPaused,
            dead,
            running: isRunning,
            inTrade,
            logoutProofState: logoutHoldOverride ? 'held' : proof.state,
            statusSettledOffline,
            pos,
            strandedHold,
            activeLaunchAuthorized,
        });

        const accountReserves = opts.reserves?.[lower] ?? opts.reserves?.[name];

        const state: AccountState = {
            name,
            side: acctSide,
            role,
            protectedClock,
            lifecycle,
            skills,
            quests,
            pos,
            inventory,
            equipment,
            bank,
            ...(accountReserves ? { reserves: accountReserves } : {}),
            ...(Object.keys(mergedCooldowns).length > 0 ? { cooldowns: mergedCooldowns } : {}),
            ...(activeHolds.length > 0 ? { systemHolds: activeHolds } : {}),
            ...(lastLoginAttemptAt !== undefined ? { lastLoginAttemptAt } : {}),
            ...(lastSettledTransferAt !== undefined ? { lastSettledTransferAt } : {}),
            ...(lifecycle === 'running' && activeJob ? { activeJob } : {}),
        };

        const errs = validateAccountState(state);
        if (errs.length > 0) {
            throw new Error(`Invalid AccountState built for "${name}": ${errs.join('; ')}`);
        }

        accounts[lower] = state;
        // Local running accounts are accounted for in FleetScheduler.spotAllocations; only record
        // un-claimed remote-side running accounts mapped to canonical spotIds to prevent double-counting.
        if (!isLocalSide && !remoteClaims.coveredSides.has(acctSide) && lifecycle === 'running' && activeJob) {
            const spotKey = opts.activitySpotById?.get(activeJob.activityId);
            if (spotKey) {
                spotOccupancy[spotKey] = (spotOccupancy[spotKey] ?? 0) + 1;
            }
        }
        diagnostics[lower] = {
            account: name,
            lifecycle,
            reason: ownerPaused
                ? 'explicit owner stop'
                : dead
                    ? 'live death record'
                    : lifecycle === 'reserved'
                        ? 'protected clock reserved'
                        : lifecycle === 'needs_logout_recovery'
                            ? `logout proof ${proof.state}`
                            : lifecycle === 'needs_location_recovery'
                                ? 'stranded position or location hold'
                                : lifecycle,
            logoutState: isLocalSide ? proof.state : 'not_applicable',
            bankTrusted: bank.trusted,
            ...(ownerStopPath ? { ownerStopPath } : {}),
        };
    }

    // Build fleetSides summary.
    const fleetSides: Record<string, FleetSideStatus> = {};
    let localStopped = false;
    for (const scope of ['swarm', 'all'] as const) {
        if (!findStopFile(scope, root)) continue;
        const text = (readStopFile(scope, root) ?? '').trim();
        if (!STALE_AUTO_STOP_TEXT.test(text)) {
            localStopped = true;
            break;
        }
    }
    const maxBots = Number.isSafeInteger(swarmPlan?.maxBots) && swarmPlan.maxBots >= 0 ? swarmPlan.maxBots : 25;
    const localLease = readLease(join(practiceRoot(root), 'fleet-agent.lock'))
        ?? readLease(join(liveRoot(root), 'fleet-agent.lock'));
    fleetSides[side] = {
        side,
        seenAt: localLease?.at && Number.isFinite(localLease.at) && localLease.at > 0 ? localLease.at : now,
        capacity: maxBots,
        stopped: localStopped,
    };
    for (const [sName, card] of sideCards) {
        if (sName === side) continue;
        const leaseFile = join(fleetDir, 'leases', `${sName}.json`);
        const leaseData = safeReadJson<{ at?: number }>(leaseFile);
        const seenAt = typeof leaseData?.at === 'number' && Number.isFinite(leaseData.at) && leaseData.at > 0
            ? leaseData.at
            : null;
        fleetSides[sName] = {
            side: sName,
            seenAt,
            capacity: Number.isSafeInteger(card.capacity) && card.capacity >= 0 ? card.capacity : 0,
            stopped: Boolean(card.stopped),
        };
    }

    const marketCooldowns = pruneExpiredCooldowns(
        { ...overlay.marketCooldowns, ...(opts.marketCooldowns ?? {}) },
        now,
    );
    const geEscrowCoins = { ...readGeEscrowByAccount(root, server), ...(opts.geEscrowCoins ?? {}) };

    const snapshot: WorldSnapshot = {
        schemaVersion: 1,
        at: now > 0 ? now : 1,
        side,
        server,
        accounts,
        fleetSides,
        ...(opts.reserves ? { reserves: opts.reserves } : {}),
        ...(opts.globalReserves ? { globalReserves: opts.globalReserves } : {}),
        ...(Object.keys(marketCooldowns).length > 0 ? { marketCooldowns } : {}),
        ...(Object.keys(spotOccupancy).length > 0 ? { spotOccupancy } : {}),
        ...(Object.keys(geEscrowCoins).length > 0 ? { geEscrowCoins } : {}),
        ...(activeTransfers.length > 0 ? { activeTransfers } : {}),
        ...(opts.world ? { world: opts.world } : {}),
    };

    const snapErrs = validateWorldSnapshot(snapshot);
    if (snapErrs.length > 0) {
        throw new Error(`Invalid WorldSnapshot: ${snapErrs.join('; ')}`);
    }

    return {
        snapshot,
        accounts: diagnostics,
        readRoots: { statusDirs, lifecycleRoots: lcRoots, fleetDir },
    };
}

export function loadWorldSnapshot(opts: LoadWorldSnapshotOptions = {}): WorldSnapshot {
    return inspectWorldSnapshot(opts).snapshot;
}
