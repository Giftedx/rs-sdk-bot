// Fleet health scanner and automated recovery controller.
// Audits owned fleet accounts for location stranding, fast-fail loops, repeated walk rejections/oscillation and stale
// health holds; safely pauses failing jobs and dispatches one-shot extraction while respecting owner stop files,
// RESERVED_ACCOUNTS, swarm pauses, active runs and memory floors.
// Usage: bun scripts/fleet-health.ts [--check] [--fix] [--json] [--clear-resolved]
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { FLEET_DIR, loadOwners, mySide, type Owner } from '../packages/core/src/fleet';
import { fleetStatusRows, readSnapshotFiles } from '../packages/core/src/fleet-snapshots';
import { readLabels, type Labels } from '../packages/core/src/components';
import { RESERVED_ACCOUNTS } from '../packages/core/src/specialist-boards';
import { jobAccounts, mergedPlan, readCoordinatorJobs } from '../packages/core/src/coordinator-jobs';
import { readLogoutProof } from '../packages/core/src/session-lifecycle';
import { pathfindingDataKey } from '../packages/core/src/pathcache';
import { FREE_FLOOR_GB } from '../packages/core/src/memory';
import { cachedReleaseFor } from '../packages/core/src/worker-release';
import { SWARM_STOP, swarmWroteStop } from './swarm';
import { failLoops, readRecentResults, type FailLoop, type ResultRow } from './fail-loops';
import { inPaterdomusTemple } from './generated/quest-priestperil';

const require = createRequire(import.meta.url);

export const HEALTH_STOP_PREFIX = 'fleet-health auto-paused:';
export const RECOVER_SCRIPT = 'scripts/aio-logistics.ts';
export const RESCUE_COOLDOWN_MS = 30 * 60_000;
export const LOOP_WINDOW_MS = 2 * 3600_000;
export const DEFAULT_MAX_RECOVERIES = 2;

export function recoverEnvironment(
    rootDir: string,
    env: Record<string, string | undefined> = process.env,
    release = cachedReleaseFor([RECOVER_SCRIPT], rootDir),
): Record<string, string | undefined> {
    return {
        ...env,
        DEMO_OK: env.DEMO_OK ?? '1',
        WORKER_ENTRY: RECOVER_SCRIPT,
        WORKER_RELEASE: release,
    };
}

export type TilePos = { worldX: number; worldZ: number; level: number };
export type LocationKind =
    | 'ok'
    | 'wilderness'
    | 'tutorial_island'
    | 'paterdomus_trapped'
    | 'ship_deck'
    | 'ship_hold'
    | 'upstairs_stranded'
    | 'edgeville_dungeon'
    | 'dwarven_mine'
    | 'entrana_dungeon'
    | 'zanaris'
    | 'off_hub_area';

export const isWildernessTile = (p: TilePos): boolean =>
    p.worldX >= 2944 && p.worldX <= 3391 && ((p.worldZ >= 3520 && p.worldZ < 6400) || p.worldZ >= 9920);

export interface LocationClassification {
    kind: LocationKind;
    stranded: boolean;
    autoFixable: boolean;
    targetHub?: { x: number; z: number; level: number };
    summary: string;
}

export interface FleetHealthIssue {
    code: 'location_stranded' | 'fast_fail_loop' | 'status_error' | 'ended_error' | 'stale_health_stop';
    detail: string;
}

export interface AccountHealthReport {
    account: string;
    server: string;
    reserved: boolean;
    active: boolean;
    confirmedOffline: boolean;
    ownerStop: boolean;
    healthStop: boolean;
    swarmStop: boolean;
    stopText?: string;
    pos?: TilePos;
    area?: number;
    location: LocationClassification;
    job?: { name: string; script?: string; enabled: boolean; template?: string };
    endedReason?: string;
    failLoop?: FailLoop;
    statusError?: string;
    issues: FleetHealthIssue[];
    fixAction: 'none' | 'pause_looping' | 'recover_location' | 'clear_stale_health_stop' | 'wait_logout' | 'manual_hold';
    blockedBy?: string;
}

export interface FleetHealthAudit {
    side: string;
    at: number;
    root: string;
    hubAreas: number[];
    totalAccounts: number;
    healthyAccounts: number;
    flaggedAccounts: AccountHealthReport[];
    accounts: AccountHealthReport[];
}

export interface RemediationAction {
    account: string;
    action: 'paused' | 'recovered' | 'recovery_failed' | 'cleared_health_stop' | 'skipped';
    detail: string;
}

export interface RemediationState {
    version: 1;
    attempts: Record<string, { at: number; ok: boolean; kind: LocationKind; detail: string }>;
}

const HUB_BANKS = {
    ardougneNorth: { x: 2619, z: 3332, level: 0 },
    faladorEast: { x: 3013, z: 3355, level: 0 },
    varrockWest: { x: 3185, z: 3436, level: 0 },
} as const;

type Box = readonly [minX: number, maxX: number, minZ: number, maxZ: number];
const inBox = (p: TilePos, minX: number, maxX: number, minZ: number, maxZ: number) =>
    p.worldX >= minX && p.worldX <= maxX && p.worldZ >= minZ && p.worldZ <= maxZ;
const inBoxes = (p: TilePos, boxes: readonly Box[]) => boxes.some(([x0, x1, z0, z1]) => inBox(p, x0, x1, z0, z1));

const SHIP_DECK_BOXES: readonly Box[] = [
    [2675, 2688, 3264, 3274], // Ardougne charter dock ship
    [2768, 2782, 3228, 3240], // Brimhaven charter dock ship
    [2950, 2962, 3138, 3150], // Musa Point ship
    [3028, 3042, 3212, 3224], // Port Sarim Karamja dock ship
    [3042, 3054, 3226, 3238], // Port Sarim Entrana ship
    [2830, 2840, 3328, 3340], // Entrana dock ship
    [2845, 2860, 3328, 3342], // Crandor ship
];

const SHIP_HOLD_BOXES: readonly Box[] = [
    [2679, 2686, 3264, 3271], // Ardougne ship hold
    [2770, 2778, 3231, 3237], // Brimhaven ship hold
    [2952, 2958, 3140, 3146], // Musa Point ship hold
    [3032, 3038, 3214, 3220], // Port Sarim ship hold
];

const STATUS_ERROR_RE = /(walk rejected \d+ times|walk oscillating|level !== 0|combat travel (?:blocked|original|aborted)|combat bank return unavailable|travel to Ardougne.*failed|no progress: 900 ticks|surface entry requires level 0|stranded on deck)/i;

export const isHealthStopText = (text: string | undefined): boolean =>
    typeof text === 'string' && text.trim().startsWith(HEALTH_STOP_PREFIX);

export function hubTargetFor(p: TilePos): { x: number; z: number; level: number } {
    if (p.worldZ < 6400 && p.worldX < 2870) return { ...HUB_BANKS.ardougneNorth };
    if (p.worldX >= 2870 && p.worldX <= 3070) return { ...HUB_BANKS.faladorEast };
    return { ...HUB_BANKS.varrockWest };
}

export function classifyLocation(
    pos: TilePos,
    opts: { labels?: Labels; hubAreas?: ReadonlySet<number>; area?: number } = {},
): LocationClassification {
    const area = opts.area ?? opts.labels?.area(pos.level, pos.worldX, pos.worldZ);
    const hubs = opts.hubAreas;
    const offHub = !!hubs && hubs.size > 0 && area !== undefined && area >= 0 && !hubs.has(area);
    const targetHub = hubTargetFor(pos);

    if (isWildernessTile(pos)) {
        return {
            kind: 'wilderness',
            stranded: true,
            autoFixable: false,
            summary: `Wilderness at ${pos.worldX},${pos.worldZ},${pos.level} (manual hold avoids live Wilderness login)`,
        };
    }
    if (pos.level === 0 && inBox(pos, 3055, 3155, 3055, 3136)) {
        return { kind: 'tutorial_island', stranded: true, autoFixable: true, targetHub: { x: 3222, z: 3218, level: 0 }, summary: `Tutorial Island at ${pos.worldX},${pos.worldZ}` };
    }
    if (inPaterdomusTemple(pos.worldX, pos.worldZ, pos.level)) {
        return { kind: 'paterdomus_trapped', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Paterdomus Temple trapped at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level === 1 && inBoxes(pos, SHIP_DECK_BOXES)) {
        return { kind: 'ship_deck', stranded: true, autoFixable: true, targetHub, summary: `ship deck level=1 at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level === 0 && inBoxes(pos, SHIP_HOLD_BOXES) && (!hubs || area === undefined || !hubs.has(area))) {
        return { kind: 'ship_hold', stranded: true, autoFixable: true, targetHub, summary: `ship hold level=0 at ${pos.worldX},${pos.worldZ}` };
    }
    if (pos.level !== 0) {
        return { kind: 'upstairs_stranded', stranded: true, autoFixable: true, targetHub, summary: `upper plane level=${pos.level} at ${pos.worldX},${pos.worldZ}` };
    }
    // Non-Wilderness Edgeville Dungeon stays south of the Wilderness Chaos Druid boundary (z <= 9919).
    if (inBox(pos, 3070, 3155, 9820, 9919)) {
        return { kind: 'edgeville_dungeon', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Edgeville Dungeon at ${pos.worldX},${pos.worldZ}` };
    }
    if (inBox(pos, 2985, 3070, 9730, 9855) || inBox(pos, 3070, 3085, 9730, 9819)) {
        return { kind: 'dwarven_mine', stranded: true, autoFixable: true, targetHub: HUB_BANKS.faladorEast, summary: `Dwarven Mine at ${pos.worldX},${pos.worldZ}` };
    }
    if (inBox(pos, 2816, 2880, 9720, 9790)) {
        return {
            kind: 'entrana_dungeon',
            stranded: true,
            autoFixable: false,
            summary: `Entrana Dungeon at ${pos.worldX},${pos.worldZ} (manual recovery avoids Wilderness magic door exit)`,
        };
    }
    if (inBox(pos, 3136, 3263, 9536, 9599)) {
        return { kind: 'zanaris', stranded: true, autoFixable: true, targetHub: HUB_BANKS.varrockWest, summary: `Zanaris at ${pos.worldX},${pos.worldZ}` };
    }
    if (offHub) {
        return { kind: 'off_hub_area', stranded: true, autoFixable: true, targetHub, summary: `off-hub area=${area} at ${pos.worldX},${pos.worldZ}` };
    }
    return { kind: 'ok', stranded: false, autoFixable: false, summary: 'mainland hub' };
}

// Regions where a healthy enabled job may intentionally hold or run an account offline/online.
export function jobMatchesLocation(job: { script?: string; template?: string; env?: Record<string, string>; args?: string[] } | undefined, kind: LocationKind): boolean {
    if (!job) return false;
    const text = `${job.script ?? ''} ${job.template ?? ''} ${(job.args ?? []).join(' ')} ${Object.entries(job.env ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`.toLowerCase();
    if (kind === 'edgeville_dungeon') return /\bedgeville\b|\btarget=giant\b|\bgiant\b/.test(text) && !/\btaverley_druid\b/.test(text);
    if (kind === 'dwarven_mine') return /\b(mine|mining|knightssword|thurgo|coal|iron|mithril)\b/.test(text);
    if (kind === 'zanaris') return /\b(jukat|zanaris|lostcity|cosmic)\b/.test(text);
    if (kind === 'paterdomus_trapped') return /\bpriestperil\b/.test(text);
    if (kind === 'off_hub_area') return /\b(taverley|karamja|tzhaar|brimhaven|catherby|seers|shilo|alfred|fishing|lobster|wc|woodcut)\b/.test(text);
    return false;
}

function readJson<T>(file: string, fallback: T): T {
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function resolveMainRoot(fromDir: string): string {
    try {
        const list = Bun.spawnSync(['git', '-C', fromDir, 'worktree', 'list', '--porcelain'], { stdout: 'pipe', stderr: 'ignore', windowsHide: true }).stdout.toString();
        const main = /^worktree (.+)$/m.exec(list)?.[1];
        if (main && existsSync(join(main, '.practice'))) return resolve(main);
    } catch { /* fall back to fromDir */ }
    return fromDir;
}

function readCompatibleHeaderSource(file: string, currentKey: string): string | null {
    let fd: number | undefined;
    try {
        fd = openSync(file, 'r');
        const head = Buffer.alloc(4);
        if (readSync(fd, head, 0, 4, 0) !== 4) return null;
        const hl = head.readUInt32LE(0);
        if (hl <= 0 || hl > 65_536) return null;
        const headerBytes = Buffer.alloc(hl);
        if (readSync(fd, headerBytes, 0, hl, 4) !== hl) return null;
        const hdr = JSON.parse(headerBytes.toString('utf8')) as { source?: string };
        if (typeof hdr?.source !== 'string') return null;
        const cur = JSON.parse(currentKey) as { v?: number; wasm?: string; data?: string };
        const stored = JSON.parse(hdr.source) as { v?: number; wasm?: string; data?: string };
        return cur.v === stored.v && cur.wasm === stored.wasm && cur.data === stored.data ? hdr.source : null;
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

export function loadCachedLabels(rootDir: string): Labels | undefined {
    const file = join(rootDir, '.practice', 'cache', 'route-areas.bin');
    if (!existsSync(file)) return undefined;
    const key = pathfindingDataKey();
    const direct = readLabels(file, key);
    if (direct) return direct;
    // Allow cached area labels across commits that share map data/wasm even when initializer hash shifts.
    const fallbackSource = readCompatibleHeaderSource(file, key);
    return fallbackSource ? (readLabels(file, fallbackSource) ?? undefined) : undefined;
}

function activeSetFromRuns(file: string): Set<string> {
    const runs = readJson<any[]>(file, []);
    const out = new Set<string>();
    if (!Array.isArray(runs)) return out;
    for (const r of runs) {
        if (Array.isArray(r?.accounts)) for (const a of r.accounts) if (typeof a === 'string') out.add(a.toLowerCase());
        if (typeof r?.account === 'string') out.add(r.account.toLowerCase());
    }
    return out;
}

function endedMapFromDeaths(file: string): Map<string, { at?: number; reason?: string }> {
    const raw = readJson<Record<string, { at?: number; reason?: string }>>(file, {});
    const out = new Map<string, { at?: number; reason?: string }>();
    if (!raw || typeof raw !== 'object') return out;
    for (const [name, rec] of Object.entries(raw)) out.set(name.toLowerCase(), rec ?? {});
    return out;
}

export function auditFleetHealth(opts: {
    root?: string;
    fleetDir?: string;
    side?: string;
    now?: number;
    labels?: Labels;
    owners?: Map<string, Owner>;
    statusRows?: readonly any[];
    results?: readonly ResultRow[];
    swarmPlan?: any;
    deaths?: Record<string, { at?: number; reason?: string }>;
} = {}): FleetHealthAudit {
    const root = opts.root ?? resolveMainRoot(resolve(import.meta.dir, '..'));
    const prac = join(root, '.practice');
    const side = opts.side ?? mySide();
    const now = opts.now ?? Date.now();
    const fleetDataDir = join(root, '.practice', 'fleet-data', 'fleet');
    const fleetDir = opts.fleetDir ?? (opts.root
        ? (existsSync(join(fleetDataDir, 'owners.json')) ? fleetDataDir : join(root, 'fleet'))
        : (process.env.FLEET_DIR ? FLEET_DIR() : existsSync(join(fleetDataDir, 'owners.json')) ? fleetDataDir : FLEET_DIR()));
    const owners = opts.owners ?? loadOwners(join(fleetDir, 'owners.json'));
    const reserved = new Set(RESERVED_ACCOUNTS.map(n => n.toLowerCase()));

    const labels = opts.labels ?? loadCachedLabels(root);
    const hubAreas = new Set<number>();
    if (labels) {
        for (const h of [HUB_BANKS.varrockWest, HUB_BANKS.ardougneNorth, HUB_BANKS.faladorEast]) {
            const id = labels.area(h.level, h.x, h.z);
            if (id >= 0) hubAreas.add(id);
        }
    }

    const statusDir = join(prac, 'status');
    const localStatuses = opts.statusRows ?? (existsSync(statusDir)
        ? readdirSync(statusDir).filter(f => f.endsWith('.json')).map(f => readJson<any>(join(statusDir, f), null)).filter(Boolean)
        : []);
    const published = opts.statusRows ? [] : readSnapshotFiles(join(fleetDir, 'snapshots'));
    const ownerLookup = (name: string) => owners.get(name.toLowerCase())?.side;
    const rows = opts.statusRows
        ? [...localStatuses]
        : fleetStatusRows(localStatuses, published, ownerLookup, side);
    const rowByAccount = new Map<string, any>();
    for (const r of rows) {
        if (typeof r?.name === 'string') rowByAccount.set(r.name.toLowerCase(), r);
    }

    const rawSwarm = opts.swarmPlan ?? readJson<any>(join(root, 'swarm.json'), { maxBots: 25, jobs: [] });
    const plan = opts.swarmPlan
        ? rawSwarm
        : mergedPlan(rawSwarm, readCoordinatorJobs(root));
    const jobByAccount = new Map<string, { name: string; script?: string; enabled: boolean; template?: string; env?: Record<string, string>; args?: string[] }>();
    for (const j of (plan?.jobs ?? []) as any[]) {
        for (const a of jobAccounts(j)) {
            const key = a.toLowerCase();
            if (!jobByAccount.has(key) || j.enabled !== false) {
                jobByAccount.set(key, { name: String(j.name ?? ''), script: j.script, enabled: j.enabled !== false, template: j.template, env: j.env, args: j.args });
            }
        }
    }

    const active = activeSetFromRuns(join(prac, 'swarm-runs.json'));
    const ended = opts.deaths
        ? new Map(Object.entries(opts.deaths).map(([k, v]) => [k.toLowerCase(), v]))
        : endedMapFromDeaths(join(prac, 'swarm-deaths.json'));

    const recentResults = opts.results ?? readRecentResults(join(prac, 'results.jsonl'), 20_000_000);
    const loops = failLoops(recentResults, now, { windowMs: LOOP_WINDOW_MS });
    const lastOkByAccount = new Map<string, number>();
    for (const row of recentResults) {
        if (row.ok === true && typeof row.name === 'string' && Number.isFinite(row.at)) {
            const key = row.name.toLowerCase();
            lastOkByAccount.set(key, Math.max(lastOkByAccount.get(key) ?? 0, row.at!));
        }
    }
    const loopByAccount = new Map<string, FailLoop>();
    for (const loop of loops) {
        const key = loop.name.toLowerCase();
        const okAfter = (lastOkByAccount.get(key) ?? 0) > loop.lastAt;
        if (!okAfter && !loopByAccount.has(key)) loopByAccount.set(key, loop);
    }

    const sideAccounts = new Map<string, { account: string; server: string }>();
    for (const [lower, o] of owners) {
        if (o.side === side) sideAccounts.set(lower, { account: rowByAccount.get(lower)?.name ?? lower, server: o.server });
    }
    for (const [lower, row] of rowByAccount) {
        const o = owners.get(lower);
        if ((!o || o.side === side) && !sideAccounts.has(lower)) {
            sideAccounts.set(lower, { account: row.name, server: o?.server ?? row.server ?? 'rs-sdk-demo.fly.dev' });
        }
    }

    const accounts: AccountHealthReport[] = [];
    for (const [lower, meta] of [...sideAccounts].sort((a, b) => a[0].localeCompare(b[0]))) {
        const row = rowByAccount.get(lower);
        const account = row?.name ?? meta.account;
        const stopFile = join(prac, `stop-${account}`);
        const stopExists = existsSync(stopFile);
        const stopText = stopExists ? (() => { try { return readFileSync(stopFile, 'utf8').trim(); } catch { return ''; } })() : undefined;
        const healthStop = isHealthStopText(stopText);
        const swarmStop = stopExists && swarmWroteStop(stopText);
        const ownerStop = stopExists && !healthStop && !swarmStop;
        const isReserved = reserved.has(lower);
        const isActive = active.has(lower);
        const job = jobByAccount.get(lower);
        const endedEntry = ended.get(lower);
        const endedReason = endedEntry?.reason;
        const endedAt = endedEntry?.at ?? 0;
        const endedCurrent = !!job && !isActive && (!row?.at || endedAt >= row.at) && (!lastOkByAccount.get(lower) || endedAt >= lastOkByAccount.get(lower)!);
        const loop = loopByAccount.get(lower);
        const proof = readLogoutProof(account, meta.server, { root });
        const confirmedOffline = !isActive && proof.state === 'confirmed';

        const pRaw = row?.pos;
        const pos: TilePos | undefined = pRaw && Number.isFinite(pRaw.x) && Number.isFinite(pRaw.z) && Number.isFinite(pRaw.level)
            ? { worldX: pRaw.x, worldZ: pRaw.z, level: pRaw.level }
            : undefined;
        const area = pos && labels ? labels.area(pos.level, pos.worldX, pos.worldZ) : undefined;
        const location = pos
            ? classifyLocation(pos, { labels, hubAreas, area })
            : { kind: 'ok' as const, stranded: false, autoFixable: false, summary: 'no position' };

        const statusResult = typeof row?.result === 'string' ? row.result : undefined;
        const statusErrMatch = statusResult && /^(?:RESULT\s+)?fail\b/i.test(statusResult) && STATUS_ERROR_RE.test(statusResult)
            ? statusResult
            : undefined;

        const issues: FleetHealthIssue[] = [];
        const intentionallyThere = job?.enabled === true && jobMatchesLocation(job, location.kind);
        const healthyActiveThere = isActive && !loop && !statusErrMatch && !(ended.get(lower)?.at && ended.get(lower)!.at! >= (row?.at ?? 0));
        if (location.stranded && !intentionallyThere && !(healthyActiveThere && !['ship_deck', 'ship_hold', 'upstairs_stranded', 'paterdomus_trapped'].includes(location.kind))) {
            issues.push({ code: 'location_stranded', detail: location.summary });
        }
        if (loop) {
            issues.push({ code: 'fast_fail_loop', detail: `${loop.runs}x ${loop.medianSec}s: ${loop.error}` });
        }
        if (statusErrMatch && !(lastOkByAccount.get(lower) && (row?.at ?? 0) <= lastOkByAccount.get(lower)!)) {
            issues.push({ code: 'status_error', detail: statusErrMatch.slice(0, 120) });
        }
        if (endedCurrent && endedReason && /^(?:blocked|gave-up|died|exit orphaned)\b/.test(endedReason)) {
            issues.push({ code: 'ended_error', detail: endedReason });
        }
        if (healthStop && !location.stranded && !loop && !statusErrMatch) {
            issues.push({ code: 'stale_health_stop', detail: `resolved health hold (${stopText})` });
        }

        let fixAction: AccountHealthReport['fixAction'] = 'none';
        let blockedBy: string | undefined;
        if (issues.length > 0) {
            if (isReserved) {
                fixAction = 'manual_hold';
                blockedBy = 'reserved account';
            } else if (ownerStop) {
                fixAction = 'manual_hold';
                blockedBy = `owner stop file (${stopText || 'empty'})`;
            } else if (issues.length === 1 && issues[0]!.code === 'stale_health_stop') {
                fixAction = confirmedOffline ? 'clear_stale_health_stop' : 'wait_logout';
            } else if (location.stranded && issues.some(i => i.code === 'location_stranded')) {
                if (!location.autoFixable) {
                    fixAction = 'manual_hold';
                    blockedBy = location.summary;
                } else if (isActive) {
                    fixAction = 'wait_logout';
                    blockedBy = 'session still active';
                } else {
                    fixAction = 'recover_location';
                }
            } else if (loop || statusErrMatch) {
                fixAction = healthStop ? 'manual_hold' : 'pause_looping';
                if (healthStop) blockedBy = 'already health-paused; needs fix/clear';
            } else if (issues.every(i => i.code === 'ended_error')) {
                fixAction = 'manual_hold';
                blockedBy = `ended: ${endedReason}`;
            }
        }

        accounts.push({
            account,
            server: meta.server,
            reserved: isReserved,
            active: isActive,
            confirmedOffline,
            ownerStop,
            healthStop,
            swarmStop,
            ...(stopText !== undefined ? { stopText } : {}),
            ...(pos ? { pos } : {}),
            ...(area !== undefined ? { area } : {}),
            location,
            ...(job ? { job: { name: job.name, script: job.script, enabled: job.enabled, template: job.template } } : {}),
            ...(endedReason ? { endedReason } : {}),
            ...(loop ? { failLoop: loop } : {}),
            ...(statusErrMatch ? { statusError: statusErrMatch } : {}),
            issues,
            fixAction,
            ...(blockedBy ? { blockedBy } : {}),
        });
    }

    const flaggedAccounts = accounts.filter(a => a.issues.length > 0);
    return {
        side,
        at: now,
        root,
        hubAreas: [...hubAreas],
        totalAccounts: accounts.length,
        healthyAccounts: accounts.length - flaggedAccounts.length,
        flaggedAccounts,
        accounts,
    };
}

function loadState(file: string): RemediationState {
    const raw = readJson<RemediationState>(file, { version: 1, attempts: {} });
    return raw?.version === 1 && raw.attempts && typeof raw.attempts === 'object'
        ? raw
        : { version: 1, attempts: {} };
}

function saveState(file: string, state: RemediationState): void {
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function writeHealthStop(stopFile: string, reason: string): boolean {
    if (existsSync(stopFile)) {
        try {
            const cur = readFileSync(stopFile, 'utf8').trim();
            if (!isHealthStopText(cur) && !swarmWroteStop(cur)) return false;
            if (isHealthStopText(cur)) return false;
            rmSync(stopFile, { force: true });
        } catch { return false; }
    }
    try { writeFileSync(stopFile, `${HEALTH_STOP_PREFIX} ${reason}\n`, { flag: 'wx' }); return true; } catch { return false; }
}

function clearOwnStop(stopFile: string, allowSwarmStop = false): boolean {
    if (!existsSync(stopFile)) return true;
    try {
        const text = readFileSync(stopFile, 'utf8').trim();
        if (!isHealthStopText(text) && !(allowSwarmStop && swarmWroteStop(text))) return false;
        rmSync(stopFile, { force: true });
        return true;
    } catch { return false; }
}

export async function remediateFleetHealth(
    audit: FleetHealthAudit,
    opts: {
        dry?: boolean;
        now?: number;
        maxRecoveries?: number;
        cooldownMs?: number;
        recoveryTimeoutMs?: number;
        freeMemGB?: () => number;
        runRecovery?: (account: string, target?: { x: number; z: number; level: number }) => Promise<{ ok: boolean; detail: string }>;
        clearResolved?: boolean;
    } = {},
): Promise<RemediationAction[]> {
    const prac = join(audit.root, '.practice');
    const now = opts.now ?? Date.now();
    const cooldownMs = opts.cooldownMs ?? RESCUE_COOLDOWN_MS;
    const maxRecoveries = opts.maxRecoveries ?? DEFAULT_MAX_RECOVERIES;
    const actions: RemediationAction[] = [];

    if (existsSync(join(prac, 'stop-swarm')) || existsSync(join(prac, 'stop-fleet-health'))) {
        return [{ account: '*', action: 'skipped', detail: 'global stop file active' }];
    }

    const stateFile = join(prac, 'fleet-health', 'state.json');
    const state = loadState(stateFile);
    let recoveriesDone = 0;

    const freeGB = opts.freeMemGB ?? (() => freemem() / 2 ** 30);
    const timeoutMs = opts.recoveryTimeoutMs ?? 180_000;
    const defaultRunRecovery = async (account: string, target?: { x: number; z: number; level: number }) => {
        const argv = [process.execPath, join(audit.root, RECOVER_SCRIPT), account, 'recover-trapped', '900', ...(target ? [`--target=${target.x},${target.z},${target.level}`] : [])];
        const env = recoverEnvironment(audit.root);
        const proc = Bun.spawn(argv, { cwd: audit.root, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* already exited */ } }, timeoutMs);
        try {
            const [exitCode, stdoutText, stderrText] = await Promise.all([
                proc.exited,
                proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(''),
                proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(''),
            ]);
            const out = `${stdoutText}\n${stderrText}`.trim();
            const tail = out.split(/\r?\n/).slice(-3).join(' | ');
            if (timedOut) return { ok: false, detail: `timeout after ${timeoutMs}ms${tail ? ` | ${tail}` : ''}` };
            return { ok: exitCode === 0 && /RESULT ok\b/.test(out), detail: tail || `exit=${exitCode}` };
        } finally {
            clearTimeout(timer);
        }
    };
    const runner = opts.runRecovery ?? defaultRunRecovery;

    for (const item of audit.flaggedAccounts) {
        if (item.reserved || item.ownerStop) continue;
        const stopFile = join(prac, `stop-${item.account}`);
        const key = item.account.toLowerCase();

        if (item.fixAction === 'clear_stale_health_stop' || (opts.clearResolved && item.healthStop && !item.location.stranded)) {
            if (!opts.dry && clearOwnStop(stopFile)) {
                actions.push({ account: item.account, action: 'cleared_health_stop', detail: 'account healthy and confirmed offline' });
            }
            continue;
        }

        if (item.fixAction === 'pause_looping') {
            const reason = item.failLoop ? `${item.failLoop.runs}x ${item.failLoop.error}` : (item.statusError ?? 'repeated failure');
            if (opts.dry) {
                actions.push({ account: item.account, action: 'skipped', detail: `dry: would pause (${reason})` });
            } else if (writeHealthStop(stopFile, reason)) {
                actions.push({ account: item.account, action: 'paused', detail: reason });
            }
            continue;
        }

        if (item.fixAction !== 'recover_location' || !item.location.autoFixable || (item.pos && isWildernessTile(item.pos))) continue;

        const prev = state.attempts[key];
        if (prev && now - prev.at < cooldownMs) {
            actions.push({ account: item.account, action: 'skipped', detail: `cooldown (${Math.ceil((cooldownMs - (now - prev.at)) / 60_000)}m remaining)` });
            continue;
        }
        if (recoveriesDone >= maxRecoveries) {
            actions.push({ account: item.account, action: 'skipped', detail: 'max recoveries per pass reached' });
            continue;
        }
        const availGB = freeGB();
        if (availGB < FREE_FLOOR_GB + 1.5) {
            actions.push({ account: item.account, action: 'skipped', detail: `low free RAM ${availGB.toFixed(1)} GiB` });
            continue;
        }
        if (opts.dry) {
            actions.push({ account: item.account, action: 'skipped', detail: `dry: would recover ${item.location.summary}` });
            continue;
        }

        // Remove our own stop marker (or swarm plan-removed marker) so openBot can log in to extract; re-apply if recovery fails.
        const hadStop = existsSync(stopFile);
        if (hadStop && !clearOwnStop(stopFile, true)) {
            actions.push({ account: item.account, action: 'skipped', detail: 'protected stop file present' });
            continue;
        }
        recoveriesDone++;
        const res = await runner(item.account, item.location.targetHub);
        if (!res.ok && /no worker progress: (?:release|active legacy)/i.test(res.detail)) {
            actions.push({ account: item.account, action: 'skipped', detail: res.detail });
            continue;
        }
        state.attempts[key] = { at: now, ok: res.ok, kind: item.location.kind, detail: res.detail.slice(0, 200) };
        saveState(stateFile, state);
        if (res.ok) {
            actions.push({ account: item.account, action: 'recovered', detail: `${item.location.kind}: ${res.detail}` });
        } else {
            writeHealthStop(stopFile, `recovery failed from ${item.location.kind}: ${res.detail.slice(0, 100)}`);
            actions.push({ account: item.account, action: 'recovery_failed', detail: res.detail });
        }
    }

    if (!opts.dry) saveState(stateFile, state);
    return actions;
}

if (import.meta.main) {
    const args = new Set(process.argv.slice(2));
    const fix = args.has('--fix');
    const json = args.has('--json');
    const clearResolved = args.has('--clear-resolved');
    const dry = args.has('--dry');

    const audit = auditFleetHealth();
    const actions = fix ? await remediateFleetHealth(audit, { dry, clearResolved }) : [];
    const refreshed = fix && actions.some(a => a.action === 'recovered' || a.action === 'paused' || a.action === 'cleared_health_stop')
        ? auditFleetHealth()
        : audit;

    if (json) {
        console.log(JSON.stringify({ audit: refreshed, actions }, null, 2));
    } else {
        console.log(`FLEET_HEALTH side=${refreshed.side} total=${refreshed.totalAccounts} healthy=${refreshed.healthyAccounts} flagged=${refreshed.flaggedAccounts.length}`);
        for (const r of refreshed.flaggedAccounts) {
            const at = r.pos ? `${r.pos.worldX},${r.pos.worldZ},${r.pos.level}` : 'unknown';
            const issueText = r.issues.map(i => `${i.code}:${i.detail}`).join('; ');
            console.log(`  ${r.account.padEnd(13)} at=${at.padEnd(13)} action=${r.fixAction.padEnd(17)} ${r.blockedBy ? `[${r.blockedBy}] ` : ''}${issueText}`);
        }
        for (const a of actions) {
            console.log(`  FIX ${a.account} ${a.action}: ${a.detail}`);
        }
    }
}
