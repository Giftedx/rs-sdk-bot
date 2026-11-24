// Declarative Campaign manifests for Haggis (Overall) and all 19 reserved Specialists.
// Reads launch manifests, rehearsal proofs, hiscore margins, staging holders, and owner stops,
// and emits finite item shortfall GoalDemands for unfulfilled campaign supplies.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { liveRoot, practiceRoot, repoRoot } from '../../core/src/practice-paths';
import { SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import {
    TRICKS,
    boardsFromSnapshot,
    haggisActivities,
    haggisTravel,
    overallRequirementsFor,
    scheduleOverall,
} from '../../planner/src/haggis';
import { accountOwnedItemCount } from '../../workers/src/contracts';
import { fileStatStamp, readJsonStatCached } from './json-cache';
import { loadItemsMap } from './preflight';
import {
    RETIRED_SPECIALIST_CAMPAIGN_SPECS,
    getSpecialistCampaignSpec,
} from './campaigns/specialists';
export * from './campaigns/specialists';
import {
    isCampaignLaunchReady,
    isHiscoreMarginFresh,
    validateCampaign,
    validateGoalDemand,
    type Campaign,
    type CampaignState,
    type CampaignSupplyRequirement,
    type GoalDemand,
    type HiscoreMarginSummary,
    type RehearsalProofSummary,
    type WorldSnapshot,
} from './contracts';

export interface LoadCampaignsOptions {
    readonly root?: string;
    readonly now?: number;
    readonly includeHaggis?: boolean;
    readonly includeSpecialists?: boolean;
    readonly includeRetiredSpecialists?: boolean;
    readonly overridePath?: string;
}

export type CampaignMissingGate =
    | 'rehearsalProof'
    | 'hiscoreMargin'
    | 'staleHiscore'
    | 'supplies'
    | 'paused'
    | 'completed';

export interface CampaignEvaluation {
    readonly campaign: Campaign;
    readonly launchReady: boolean;
    readonly missingGates: readonly CampaignMissingGate[];
    readonly shortfalls: readonly GoalDemand[];
    readonly totalRequiredUnits: number;
    readonly totalFulfilledUnits: number;
}

export interface CampaignShortfallsOptions {
    readonly includeCompletedOrPaused?: boolean;
    readonly itemValuesGp?: Readonly<Record<number, number>>;
}

interface KnowledgeItemRow {
    readonly id: number;
    readonly name: string;
    readonly debugname?: string;
    readonly cost?: number;
    readonly tradeable?: boolean;
}

interface ItemLookup {
    readonly items: readonly KnowledgeItemRow[];
    readonly byId: ReadonlyMap<number, KnowledgeItemRow>;
    readonly resolve: (rawId: unknown, rawName: unknown) => { readonly itemId: number; readonly itemName: string } | undefined;
}

interface HiscoreRow {
    readonly rank?: number;
    readonly name?: string;
    readonly level?: number;
    readonly ticks?: number;
}

interface HiscoreBoard {
    readonly board?: string;
    readonly category?: number;
    readonly rows?: readonly HiscoreRow[];
}

interface HiscoreSnapshot {
    readonly takenAt?: string;
    readonly boards?: readonly HiscoreBoard[];
}

const DEFAULT_MARGIN_RATIO = 0.02;

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJsonSafe(filePath: string): unknown {
    if (!existsSync(filePath)) return undefined;
    try {
        return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return undefined;
    }
}

function normalizeItemKey(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/\s*\(noted\)$/i, '')
        .replace(/^feathers$/i, 'feather')
        .replace(/^headless arrows$/i, 'headless arrow')
        .replace(/^coins$/i, 'coins');
}

let cachedItemLookup: { key: string; lookup: ItemLookup } | undefined;

function buildItemLookup(root: string): ItemLookup {
    const localItemsPath = join(root, 'knowledge', 'items.json');
    const itemsPath = existsSync(localItemsPath) ? localItemsPath : join(repoRoot, 'knowledge', 'items.json');
    const cacheKey = `${resolve(itemsPath)}|${fileStatStamp(itemsPath)}`;
    if (cachedItemLookup && cachedItemLookup.key === cacheKey) return cachedItemLookup.lookup;
    const raw = readJsonStatCached<unknown>(itemsPath);
    const items: KnowledgeItemRow[] = [];
    const byId = new Map<number, KnowledgeItemRow>();
    const byName = new Map<string, KnowledgeItemRow>();
    const idsByExactLower = new Map<string, number[]>();
    const idsByDebug = new Map<string, number[]>();

    if (Array.isArray(raw)) {
        for (const entry of raw) {
            if (!isPlainRecord(entry)) continue;
            const id = typeof entry.id === 'number' && Number.isSafeInteger(entry.id) && entry.id >= 0 ? entry.id : -1;
            const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : undefined;
            if (id < 0 || !name) continue;
            const row: KnowledgeItemRow = {
                id,
                name,
                ...(typeof entry.debugname === 'string' ? { debugname: entry.debugname } : {}),
                ...(typeof entry.cost === 'number' ? { cost: entry.cost } : {}),
                ...(typeof entry.tradeable === 'boolean' ? { tradeable: entry.tradeable } : {}),
            };
            items.push(row);
            byId.set(id, row);
            const key = name.toLowerCase();
            const idList = idsByExactLower.get(key);
            if (idList) idList.push(id);
            else idsByExactLower.set(key, [id]);
            if (row.debugname) {
                const dbgList = idsByDebug.get(row.debugname);
                if (dbgList) dbgList.push(id);
                else idsByDebug.set(row.debugname, [id]);
            }
            const prev = byName.get(key);
            const prevPenalty =
                prev && (prev.debugname?.startsWith('unstrung_') || prev.debugname?.startsWith('cert_')) ? 1 : 0;
            const curPenalty =
                row.debugname?.startsWith('unstrung_') || row.debugname?.startsWith('cert_') ? 1 : 0;
            if (!prev || curPenalty < prevPenalty || (curPenalty === prevPenalty && row.tradeable && !prev.tradeable)) {
                byName.set(key, row);
            }
        }
    }

    const resolvedByNameCache = new Map<string, { readonly itemId: number; readonly itemName: string } | null>();
    const idsForFast = (trimmed: string): number[] => {
        const want = trimmed.toLowerCase().replace(/\s*\((?:noted|quest)\)$/, '').trim();
        const unf = want.match(/^(.+) potion \(unf\)$/);
        if (unf) return idsByDebug.get(unf[1]!.replace(/\s+/g, '') + 'vial') ?? [];
        const matched: number[] = [];
        const seenForms = new Set<string>();
        for (const form of [want, want.replace(/s$/, ''), want.replace(/ies$/, 'y'), want.replace(/us$/, 'i')]) {
            if (seenForms.has(form)) continue;
            seenForms.add(form);
            const list = idsByExactLower.get(form);
            if (list) {
                for (const id of list) matched.push(id);
            }
        }
        return matched;
    };

    const resolveItem = (rawId: unknown, rawName: unknown) => {
        if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0) {
            const known = byId.get(rawId);
            const fallbackName =
                typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : known?.name ?? `item:${rawId}`;
            return { itemId: rawId, itemName: known?.name ?? fallbackName };
        }
        if (typeof rawName === 'string' && rawName.trim().length > 0) {
            const trimmed = rawName.trim();
            const cached = resolvedByNameCache.get(trimmed);
            if (cached !== undefined) return cached ?? undefined;
            const matchedIds = idsForFast(trimmed);
            if (matchedIds.length > 0) {
                let best: KnowledgeItemRow | undefined;
                for (const id of matchedIds) {
                    const candidate = byId.get(id);
                    if (!candidate) continue;
                    const bestPenalty =
                        best && (best.debugname?.startsWith('unstrung_') || best.debugname?.startsWith('cert_')) ? 1 : 0;
                    const curPenalty =
                        candidate.debugname?.startsWith('unstrung_') || candidate.debugname?.startsWith('cert_') ? 1 : 0;
                    if (
                        !best ||
                        curPenalty < bestPenalty ||
                        (curPenalty === bestPenalty && candidate.tradeable && !best.tradeable)
                    ) {
                        best = candidate;
                    }
                }
                if (best) {
                    const res = { itemId: best.id, itemName: best.name };
                    resolvedByNameCache.set(trimmed, res);
                    return res;
                }
            }
            const norm = normalizeItemKey(trimmed);
            const known = byName.get(trimmed.toLowerCase()) ?? byName.get(norm);
            if (known) {
                const res = { itemId: known.id, itemName: known.name };
                resolvedByNameCache.set(trimmed, res);
                return res;
            }
            resolvedByNameCache.set(trimmed, null);
        }
        return undefined;
    };

    const lookup = { items, byId, resolve: resolveItem };
    cachedItemLookup = { key: cacheKey, lookup };
    return lookup;
}

interface IndexedHiscoreSnapshot {
    readonly snapshot: HiscoreSnapshot;
    readonly byBoardAndCat: ReadonlyMap<string, HiscoreBoard>;
    readonly byBoard: ReadonlyMap<string, HiscoreBoard>;
}

function indexHiscoreSnapshot(snapshot: HiscoreSnapshot): IndexedHiscoreSnapshot {
    const byBoardAndCat = new Map<string, HiscoreBoard>();
    const byBoard = new Map<string, HiscoreBoard>();
    for (const b of snapshot.boards ?? []) {
        if (!b.board) continue;
        if (!byBoard.has(b.board)) byBoard.set(b.board, b);
        if (b.category !== undefined) {
            const key = `${b.board}:${b.category}`;
            if (!byBoardAndCat.has(key)) byBoardAndCat.set(key, b);
        }
    }
    return { snapshot, byBoardAndCat, byBoard };
}

function loadHiscoreSnapshots(root: string): IndexedHiscoreSnapshot[] {
    const candidates = [
        join(practiceRoot(root), 'specialist-launch', 'hiscores.json'),
        join(liveRoot(root), 'specialist-launch', 'hiscores.json'),
        join(root, 'research', 'hiscores-live.json'),
    ];
    const entries: { snapshot: HiscoreSnapshot; takenAtMs: number; priority: number }[] = [];
    candidates.forEach((file, priority) => {
        const parsed = readJsonStatCached<unknown>(file);
        if (isPlainRecord(parsed) && Array.isArray(parsed.boards)) {
            const snap = parsed as HiscoreSnapshot;
            const parsedAt = typeof snap.takenAt === 'string' ? Date.parse(snap.takenAt) : NaN;
            entries.push({
                snapshot: snap,
                takenAtMs: Number.isFinite(parsedAt) ? parsedAt : 0,
                priority,
            });
        }
    });
    entries.sort((a, b) => b.takenAtMs - a.takenAtMs || a.priority - b.priority);
    return entries.map((e) => indexHiscoreSnapshot(e.snapshot));
}

function findHiscoreBoard(
    snapshots: readonly IndexedHiscoreSnapshot[],
    boardName: string,
    category?: number,
): { readonly snapshot: HiscoreSnapshot; readonly board: HiscoreBoard } | undefined {
    const catKey = category !== undefined ? `${boardName}:${category}` : undefined;
    for (const entry of snapshots) {
        const b = catKey !== undefined ? entry.byBoardAndCat.get(catKey) : entry.byBoard.get(boardName);
        if (b) return { snapshot: entry.snapshot, board: b };
    }
    return undefined;
}

function computeHiscoreMargin(
    boardName: string,
    category: number | undefined,
    ourTicks: number | undefined,
    snapshots: readonly IndexedHiscoreSnapshot[],
    now: number,
    requireMaxLevel99 = true,
): HiscoreMarginSummary | null {
    if (!ourTicks || !Number.isFinite(ourTicks) || ourTicks <= 0) return null;
    const hit = findHiscoreBoard(snapshots, boardName, category);
    const leader = hit?.board.rows?.[0];
    if (!hit || !leader || typeof leader.ticks !== 'number' || !Number.isSafeInteger(leader.ticks) || leader.ticks <= 0) {
        return null;
    }
    const rivalTicks = leader.ticks;
    const roundedOur = Math.max(1, Math.round(ourTicks));
    const marginTicks = rivalTicks - roundedOur;
    const marginRatio = rivalTicks > 0 ? marginTicks / rivalTicks : 0;
    const requiredMargin = Math.ceil(rivalTicks * DEFAULT_MARGIN_RATIO);
    const levelNeedsMargin = !requireMaxLevel99 || (typeof leader.level === 'number' && leader.level >= 99);
    const meetsMargin = marginTicks >= (levelNeedsMargin ? requiredMargin : 1);
    const parsedAt = typeof hit.snapshot.takenAt === 'string' ? Date.parse(hit.snapshot.takenAt) : NaN;
    // Never synthesize freshness when takenAt is missing or unparseable; force stale failure until refreshed.
    const checkedAt = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : 1;

    return {
        board: boardName,
        rivalTicks,
        ourTicks: roundedOur,
        marginTicks,
        marginRatio,
        checkedAt,
        meetsMargin,
    };
}

interface CampaignFsIndex {
    readonly liveLaunchDir: string;
    readonly pracLaunchDir: string;
    readonly liveLaunchFiles: ReadonlySet<string>;
    readonly pracLaunchFiles: ReadonlySet<string>;
    readonly liveRootFiles: ReadonlySet<string>;
    readonly pracRootFiles: ReadonlySet<string>;
    readonly isOwnerStopped: (account: string) => boolean;
}

function listDirSet(dir: string): Set<string> {
    try {
        return new Set(readdirSync(dir));
    } catch {
        return new Set();
    }
}

function buildCampaignFsIndex(root: string): CampaignFsIndex {
    const lRoot = liveRoot(root);
    const pRoot = practiceRoot(root);
    const liveRootFiles = listDirSet(lRoot);
    const pracRootFiles = listDirSet(pRoot);
    const liveLaunchDir = join(lRoot, 'specialist-launch');
    const pracLaunchDir = join(pRoot, 'specialist-launch');
    const liveLaunchFiles = liveRootFiles.has('specialist-launch') ? listDirSet(liveLaunchDir) : new Set<string>();
    const pracLaunchFiles = pracRootFiles.has('specialist-launch') ? listDirSet(pracLaunchDir) : new Set<string>();

    const stopDirs: { dir: string; exact: Set<string>; byLower: Map<string, string> }[] = [];
    for (const [dir, entries] of [
        [lRoot, liveRootFiles],
        [pRoot, pracRootFiles],
    ] as const) {
        const exact = new Set<string>();
        const byLower = new Map<string, string>();
        for (const name of entries) {
            const lower = name.toLowerCase();
            if (!lower.startsWith('stop-')) continue;
            exact.add(name);
            if (!byLower.has(lower)) byLower.set(lower, name);
        }
        if (exact.size > 0) stopDirs.push({ dir, exact, byLower });
    }
    const isWin = process.platform === 'win32';
    const findStop = (flag: string): string | null => {
        if (stopDirs.length === 0) return null;
        const lowerName = `stop-${flag.toLowerCase()}`;
        if (isWin) {
            for (const d of stopDirs) {
                const hit = d.byLower.get(lowerName);
                if (hit) return join(d.dir, hit);
            }
            return null;
        }
        const exactName = `stop-${flag}`;
        for (const d of stopDirs) {
            if (d.exact.has(exactName)) return join(d.dir, exactName);
            if (lowerName !== exactName && d.exact.has(lowerName)) return join(d.dir, lowerName);
        }
        for (const d of stopDirs) {
            const hit = d.byLower.get(lowerName);
            if (hit) return join(d.dir, hit);
        }
        return null;
    };
    const STALE_AUTO_STOP_RE =
        /^(?:fleet-health auto-paused:|swarm stopped\b|swarm plan removed or stopped\b|swarm recovery stopped\b|inherited recovery stopped\b|fleet controller lease unavailable\b|swarm:(?:\s|$))/i;
    const isOwnerStopped = (account: string): boolean => {
        const file = findStop(account) ?? findStop(account.toLowerCase());
        if (!file) return false;
        try {
            const text = readFileSync(file, 'utf8').trim();
            return !STALE_AUTO_STOP_RE.test(text);
        } catch {
            return true;
        }
    };
    return {
        liveLaunchDir,
        pracLaunchDir,
        liveLaunchFiles,
        pracLaunchFiles,
        liveRootFiles,
        pracRootFiles,
        isOwnerStopped,
    };
}

function hasActiveGoToken(goPath: string | null, now: number): boolean {
    if (!goPath) return false;
    const parsed = readJsonSafe(goPath);
    if (!isPlainRecord(parsed)) return false;
    if (typeof parsed.runUntil === 'number' && Number.isFinite(parsed.runUntil)) {
        return now < parsed.runUntil;
    }
    if (typeof parsed.expiresAt === 'number' && Number.isFinite(parsed.expiresAt)) {
        return now < parsed.expiresAt;
    }
    return true;
}

function aggregateSupplyRequirements(
    items: readonly CampaignSupplyRequirement[],
): CampaignSupplyRequirement[] {
    const byId = new Map<number, { count: number; itemName?: string; stage?: string }>();
    for (const item of items) {
        if (!Number.isSafeInteger(item.itemId) || item.itemId < 0 || !Number.isSafeInteger(item.count) || item.count <= 0) {
            continue;
        }
        const prev = byId.get(item.itemId);
        if (!prev) {
            byId.set(item.itemId, {
                count: item.count,
                ...(item.itemName ? { itemName: item.itemName } : {}),
                ...(item.stage ? { stage: item.stage } : {}),
            });
        } else {
            byId.set(item.itemId, {
                count: prev.count + item.count,
                ...(prev.itemName ?? item.itemName ? { itemName: prev.itemName ?? item.itemName } : {}),
                ...(prev.stage ?? item.stage ? { stage: prev.stage ?? item.stage } : {}),
            });
        }
    }
    return [...byId.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([itemId, info]) => ({
            itemId,
            count: info.count,
            ...(info.itemName ? { itemName: info.itemName } : {}),
            ...(info.stage ? { stage: info.stage } : {}),
        }));
}

let cachedHaggisSchedule:
    | { key: string; plannedTicks: number; rawSupplies: CampaignSupplyRequirement[] }
    | undefined;

function buildHaggisCampaign(
    root: string,
    lookup: ItemLookup,
    snapshots: readonly IndexedHiscoreSnapshot[],
    fsIdx: CampaignFsIndex,
    now: number,
): Campaign {
    const boardsFile = join(root, 'packages', 'planner', 'src', 'haggis-boards.json');
    const readinessFile = fsIdx.liveRootFiles.has('haggis-readiness.json')
        ? join(liveRoot(root), 'haggis-readiness.json')
        : fsIdx.pracRootFiles.has('haggis-readiness.json')
          ? join(practiceRoot(root), 'haggis-readiness.json')
          : null;

    const readinessData = readinessFile ? readJsonSafe(readinessFile) : undefined;

    const rawSupplies: CampaignSupplyRequirement[] = [];
    let plannedTicks = 0;

    const overallHit = findHiscoreBoard(snapshots, 'Overall', 0);
    const boardsStamp = overallHit ? fileStatStamp(boardsFile) : 'missing';
    const travelStamp = overallHit ? fileStatStamp(join(root, 'packages', 'planner', 'src', 'haggis-travel.json')) : 'missing';
    if (overallHit && boardsStamp !== 'missing') {
        const snapshotBoardsSig = (overallHit.snapshot.boards ?? [])
            .map((b) => {
                const r0 = b.rows?.[0];
                return `${b.board ?? ''}:${b.category ?? ''}:${r0?.ticks ?? ''}:${r0?.level ?? ''}`;
            })
            .join(';');
        const itemsStamp = cachedItemLookup?.key ?? '';
        const haggisKey = `${boardsFile}|${boardsStamp}|${travelStamp}|${itemsStamp}|${overallHit.snapshot.takenAt ?? ''}|${snapshotBoardsSig}`;
        if (cachedHaggisSchedule && cachedHaggisSchedule.key === haggisKey) {
            plannedTicks = cachedHaggisSchedule.plannedTicks;
            rawSupplies.push(...cachedHaggisSchedule.rawSupplies);
        } else {
            try {
                const activities = haggisActivities();
                const boards = boardsFromSnapshot(overallHit.snapshot as Parameters<typeof boardsFromSnapshot>[0]);
                const options = { mode: 'realistic' as const, tricks: new Set(TRICKS), travel: haggisTravel() };
                const plan = scheduleOverall(boards, activities, options);
                if (typeof plan.overallFinish === 'number' && Number.isFinite(plan.overallFinish) && plan.overallFinish > 0) {
                    const { supplies } = overallRequirementsFor(activities, options, plan);
                    plannedTicks = Math.round(plan.overallFinish);
                    for (const s of supplies) {
                        const count = Math.round(Number(s.count));
                        if (!Number.isSafeInteger(count) || count <= 0) continue;
                        const resolved = lookup.resolve(s.itemId, s.item);
                        if (!resolved) continue;
                        rawSupplies.push({
                            itemId: resolved.itemId,
                            itemName: resolved.itemName,
                            count,
                            stage: 'Overall',
                        });
                    }
                    cachedHaggisSchedule = { key: haggisKey, plannedTicks, rawSupplies: [...rawSupplies] };
                }
            } catch {
                // Fall back to static boardsFile aggregation below if snapshot scheduling fails.
            }
        }
    }

    const boardsData = plannedTicks === 0 ? readJsonStatCached<unknown>(boardsFile) : undefined;
    if (plannedTicks === 0 && isPlainRecord(boardsData) && Array.isArray(boardsData.activities)) {
        for (const act of boardsData.activities) {
            if (!isPlainRecord(act)) continue;
            const ticksObj = isPlainRecord(act.ticks) ? act.ticks : undefined;
            const realistic = typeof ticksObj?.realistic === 'number' && ticksObj.realistic > 0 ? ticksObj.realistic : 0;
            const floor = typeof ticksObj?.floor === 'number' && ticksObj.floor > 0 ? ticksObj.floor : 0;
            plannedTicks += realistic || floor;

            const stage =
                Array.isArray(act.serves) && typeof act.serves[0] === 'string' && act.serves[0].trim().length > 0
                    ? act.serves[0].trim()
                    : typeof act.id === 'string'
                      ? act.id
                      : undefined;

            if (Array.isArray(act.supplies)) {
                for (const s of act.supplies) {
                    if (!isPlainRecord(s)) continue;
                    const count = typeof s.count === 'number' && Number.isSafeInteger(s.count) ? s.count : Math.round(Number(s.count));
                    if (!Number.isSafeInteger(count) || count <= 0) continue;
                    const resolved = lookup.resolve(s.itemId, s.itemName ?? s.item);
                    if (!resolved) continue;
                    rawSupplies.push({
                        itemId: resolved.itemId,
                        itemName: resolved.itemName,
                        count,
                        ...(stage ? { stage } : {}),
                    });
                }
            }
        }
    }

    let rehearsalProof: RehearsalProofSummary | null = null;
    if (isPlainRecord(readinessData)) {
        const verified = readinessData.ready === true && readinessData.go === true;
        rehearsalProof = {
            verified,
            ...(typeof readinessData.at === 'number' && Number.isFinite(readinessData.at)
                ? { verifiedAt: readinessData.at }
                : {}),
            ...(typeof readinessData.context === 'string' ? { contextSha256: readinessData.context } : {}),
            reportPath: '.practice/haggis-readiness.json',
        };
    }

    const alreadyRank1 = Boolean(
        overallHit?.board.rows?.some((r) => r.rank === 1 && typeof r.name === 'string' && r.name.toLowerCase() === 'haggis'),
    );
    const hiscoreMargin = computeHiscoreMargin(
        'Overall',
        0,
        plannedTicks > 0 ? plannedTicks : undefined,
        snapshots,
        now,
        false,
    );

    const stopped = fsIdx.isOwnerStopped('haggis');
    let state: CampaignState = 'staging';
    if (alreadyRank1) state = 'completed';
    else if (stopped) state = 'paused';
    else if (
        rehearsalProof?.verified === true &&
        hiscoreMargin?.meetsMargin === true &&
        isHiscoreMarginFresh(hiscoreMargin, now)
    ) {
        state = 'ready';
    }

    return {
        id: 'campaign:haggis',
        account: 'haggis',
        protectedClock: true,
        board: 'Overall',
        requiredSupplies: aggregateSupplyRequirements(rawSupplies),
        stagingHolder: null,
        rehearsalProof,
        hiscoreMargin,
        state,
        weight: 2.0,
    };
}

function buildSpecialistCampaign(
    root: string,
    account: string,
    board: { readonly name: string; readonly category: number },
    lookup: ItemLookup,
    snapshots: readonly IndexedHiscoreSnapshot[],
    fsIdx: CampaignFsIndex,
    now: number,
): Campaign {
    const lower = account.toLowerCase();
    const declarative = getSpecialistCampaignSpec(lower);
    const manifestName = `${lower}.json`;
    const goName = `${lower}.go.json`;
    const manifestPath = fsIdx.liveLaunchFiles.has(manifestName)
        ? join(fsIdx.liveLaunchDir, manifestName)
        : fsIdx.pracLaunchFiles.has(manifestName)
          ? join(fsIdx.pracLaunchDir, manifestName)
          : null;
    const goPath = fsIdx.liveLaunchFiles.has(goName)
        ? join(fsIdx.liveLaunchDir, goName)
        : fsIdx.pracLaunchFiles.has(goName)
          ? join(fsIdx.pracLaunchDir, goName)
          : null;

    const manifest = manifestPath ? readJsonSafe(manifestPath) : undefined;
    const rawSupplies: CampaignSupplyRequirement[] = [];
    let planTicks: number | undefined = declarative?.planTicks;
    let rehearsalProof: RehearsalProofSummary | null = null;
    let stagingHolder: string | null = declarative?.defaultStagingHolder ?? null;

    if (isPlainRecord(manifest)) {
        if (typeof manifest.planTicks === 'number' && Number.isSafeInteger(manifest.planTicks) && manifest.planTicks > 0) {
            planTicks = manifest.planTicks;
        }
        if (Array.isArray(manifest.requirements)) {
            for (const req of manifest.requirements) {
                if (!isPlainRecord(req)) continue;
                const count = typeof req.count === 'number' ? Math.round(req.count) : 0;
                if (!Number.isSafeInteger(count) || count <= 0) continue;
                const resolved = lookup.resolve(req.itemId, req.item ?? req.itemName);
                if (!resolved) continue;
                rawSupplies.push({
                    itemId: resolved.itemId,
                    itemName: resolved.itemName,
                    count,
                    stage: board.name,
                });
            }
        }

        if (isPlainRecord(manifest.rehearsal) && typeof manifest.rehearsal.path === 'string') {
            const rPath = resolve(root, manifest.rehearsal.path);
            const rJson = readJsonSafe(rPath);
            if (isPlainRecord(rJson)) {
                const ok = rJson.ok === true && rJson.died === false && rJson.logout === 'logged-out';
                const boardTicks =
                    isPlainRecord(rJson.boardTicks) && typeof rJson.boardTicks[board.name] === 'number'
                        ? (rJson.boardTicks[board.name] as number)
                        : undefined;
                rehearsalProof = {
                    verified: ok,
                    ...(typeof boardTicks === 'number' ? { ticks: boardTicks } : {}),
                    ...(typeof rJson.context === 'string' ? { contextSha256: rJson.context } : {}),
                    ...(typeof rJson.at === 'number' ? { verifiedAt: rJson.at } : {}),
                    reportPath: manifest.rehearsal.path,
                };
            }
        }

        if (isPlainRecord(manifest.staging) && typeof manifest.staging.path === 'string') {
            const sJson = readJsonSafe(resolve(root, manifest.staging.path));
            if (isPlainRecord(sJson) && Array.isArray(sJson.allocations)) {
                for (const alloc of sJson.allocations) {
                    if (!isPlainRecord(alloc)) continue;
                    const recipient = typeof alloc.recipient === 'string' ? alloc.recipient.toLowerCase() : undefined;
                    const holder = typeof alloc.holder === 'string' ? alloc.holder : undefined;
                    if (recipient === lower && holder && holder.toLowerCase() !== lower) {
                        stagingHolder = holder;
                        break;
                    }
                }
            }
        }
    } else if (
        declarative?.defaultRehearsalReportPath
        && (fsIdx.pracLaunchFiles.size > 0 || fsIdx.liveLaunchFiles.size > 0 || !declarative.defaultRehearsalReportPath.startsWith('.practice/specialist-launch/'))
    ) {
        const rPath = resolve(root, declarative.defaultRehearsalReportPath);
        const rJson = readJsonSafe(rPath);
        if (isPlainRecord(rJson)) {
            const ok = rJson.ok === true && rJson.died === false && rJson.logout === 'logged-out';
            const boardTicks =
                isPlainRecord(rJson.boardTicks) && typeof rJson.boardTicks[board.name] === 'number'
                    ? (rJson.boardTicks[board.name] as number)
                    : undefined;
            rehearsalProof = {
                verified: ok,
                ...(typeof boardTicks === 'number' ? { ticks: boardTicks } : {}),
                ...(typeof rJson.context === 'string' ? { contextSha256: rJson.context } : {}),
                ...(typeof rJson.at === 'number' ? { verifiedAt: rJson.at } : {}),
                reportPath: declarative.defaultRehearsalReportPath,
            };
        }
    }

    if (rawSupplies.length === 0 && declarative) {
        for (const req of declarative.requiredSupplies) {
            const resolved = lookup.resolve(req.itemId, req.itemName);
            rawSupplies.push({
                itemId: resolved?.itemId ?? req.itemId,
                ...(resolved?.itemName ?? req.itemName ? { itemName: resolved?.itemName ?? req.itemName } : {}),
                count: req.count,
                stage: req.stage ?? board.name,
            });
        }
    }

    const hiscoreHit = findHiscoreBoard(snapshots, board.name, board.category);
    const alreadyRank1 = Boolean(
        hiscoreHit?.board.rows?.some((r) => r.rank === 1 && typeof r.name === 'string' && r.name.toLowerCase() === lower),
    );
    const marginTicks =
        rehearsalProof?.verified === true && typeof rehearsalProof.ticks === 'number' && rehearsalProof.ticks > 0
            ? Math.max(planTicks ?? 0, rehearsalProof.ticks)
            : planTicks;
    const hiscoreMargin = computeHiscoreMargin(board.name, board.category, marginTicks, snapshots, now, true);
    const stopped = fsIdx.isOwnerStopped(lower);
    const hasGoToken = hasActiveGoToken(goPath, now);

    let state: CampaignState = 'staging';
    if (alreadyRank1) state = 'completed';
    else if (stopped) state = 'paused';
    else if (
        rehearsalProof?.verified === true &&
        hiscoreMargin?.meetsMargin === true &&
        isHiscoreMarginFresh(hiscoreMargin, now)
    ) {
        state = hasGoToken ? 'running' : 'ready';
    }

    return {
        id: `campaign:${lower}`,
        account: lower,
        protectedClock: true,
        board: board.name,
        requiredSupplies: aggregateSupplyRequirements(rawSupplies),
        stagingHolder,
        rehearsalProof,
        hiscoreMargin,
        state,
        weight: declarative?.weight ?? 1.0,
    };
}

function readCampaignOverrides(root: string, fsIdx: CampaignFsIndex, overridePath?: string): Map<string, Campaign> {
    const out = new Map<string, Campaign>();
    const paths = overridePath
        ? [overridePath]
        : [
              ...(fsIdx.pracRootFiles.has('campaigns.json') ? [join(practiceRoot(root), 'campaigns.json')] : []),
              ...(fsIdx.liveRootFiles.has('campaigns.json') ? [join(liveRoot(root), 'campaigns.json')] : []),
          ];
    for (const filePath of paths) {
        const parsed = readJsonSafe(filePath);
        const list = Array.isArray(parsed)
            ? parsed
            : isPlainRecord(parsed) && Array.isArray(parsed.campaigns)
              ? parsed.campaigns
              : [];
        for (const item of list) {
            if (validateCampaign(item).length === 0) {
                out.set(item.id, item);
            }
        }
    }
    return out;
}

export function loadCampaignManifests(opts: LoadCampaignsOptions = {}): Campaign[] {
    const root = resolve(opts.root ?? repoRoot);
    const now = opts.now ?? Date.now();
    const lookup = buildItemLookup(root);
    const snapshots = loadHiscoreSnapshots(root);
    const fsIdx = buildCampaignFsIndex(root);

    const byId = new Map<string, Campaign>();
    if (opts.includeHaggis !== false) {
        const haggis = buildHaggisCampaign(root, lookup, snapshots, fsIdx, now);
        const errors = validateCampaign(haggis);
        if (errors.length > 0) throw new Error(`Invalid Haggis campaign: ${errors.join('; ')}`);
        byId.set(haggis.id, haggis);
    }

    if (opts.includeSpecialists !== false) {
        for (const [account, board] of Object.entries(SPECIALIST_BOARDS)) {
            const c = buildSpecialistCampaign(root, account, board, lookup, snapshots, fsIdx, now);
            const errors = validateCampaign(c);
            if (errors.length > 0) throw new Error(`Invalid specialist campaign (${account}): ${errors.join('; ')}`);
            byId.set(c.id, c);
        }
    }

    if (opts.includeRetiredSpecialists === true) {
        for (const spec of RETIRED_SPECIALIST_CAMPAIGN_SPECS) {
            const c = buildSpecialistCampaign(root, spec.account, { name: spec.board, category: spec.category }, lookup, snapshots, fsIdx, now);
            const errors = validateCampaign(c);
            if (errors.length > 0) throw new Error(`Invalid retired specialist campaign (${spec.account}): ${errors.join('; ')}`);
            byId.set(c.id, c);
        }
    }

    const overrides = readCampaignOverrides(root, fsIdx, opts.overridePath);
    for (const [id, c] of overrides.entries()) {
        byId.set(id, c);
    }

    return [...byId.values()];
}

const TIGHTENED_MARGIN_PRIORITY_FACTOR = 0.15;

function canonicalUnnotedItemId(itemId: number, itemName?: string): number {
    const itemsMap = loadItemsMap();
    if (itemsMap.has(itemId)) return itemId;
    if (itemId > 0) {
        const prev = itemsMap.get(itemId - 1);
        if (prev) {
            if (!itemName || normalizeItemKey(prev.name) === normalizeItemKey(itemName)) {
                return prev.id;
            }
        }
    }
    return itemId;
}

interface SnapshotSupplyIndex {
    readonly byLower: ReadonlyMap<string, WorldSnapshot['accounts'][string]>;
    readonly activeNonProtected: readonly WorldSnapshot['accounts'][string][];
    readonly reservesByLower: ReadonlyMap<string, Readonly<Record<number, number>>> | null;
}

function buildSnapshotSupplyIndex(snapshot: WorldSnapshot): SnapshotSupplyIndex {
    const byLower = new Map<string, WorldSnapshot['accounts'][string]>();
    const activeNonProtected: WorldSnapshot['accounts'][string][] = [];
    for (const acct of Object.values(snapshot.accounts)) {
        byLower.set(acct.name.toLowerCase(), acct);
        if (!acct.protectedClock && acct.lifecycle !== 'paused_owner' && acct.lifecycle !== 'dead') {
            activeNonProtected.push(acct);
        }
    }
    let reservesByLower: Map<string, Readonly<Record<number, number>>> | null = null;
    if (snapshot.reserves) {
        reservesByLower = new Map<string, Readonly<Record<number, number>>>();
        for (const [k, map] of Object.entries(snapshot.reserves)) {
            const lower = k.toLowerCase();
            if (!reservesByLower.has(lower)) reservesByLower.set(lower, map);
        }
    }
    return { byLower, activeNonProtected, reservesByLower };
}

function accountReserveForItem(
    snapshot: WorldSnapshot,
    acctName: string,
    itemId: number,
    reservesByLower: ReadonlyMap<string, Readonly<Record<number, number>>> | null,
): number {
    if (!snapshot.reserves) return 0;
    const exact = snapshot.reserves[acctName]?.[itemId];
    if (exact !== undefined) return exact;
    const lower = acctName.toLowerCase();
    const lowerHit = snapshot.reserves[lower]?.[itemId];
    if (lowerHit !== undefined) return lowerHit;
    return reservesByLower?.get(lower)?.[itemId] ?? 0;
}

function availableCampaignSupplyStock(
    campaign: Campaign,
    itemId: number,
    snapshot: WorldSnapshot,
    supplyIdx: SnapshotSupplyIndex,
    canonicalId = itemId,
): number {
    const ownedForAccount = (acct: WorldSnapshot['accounts'][string]): number => {
        let owned = accountOwnedItemCount(acct, itemId);
        let reserved = accountReserveForItem(snapshot, acct.name, itemId, supplyIdx.reservesByLower);
        if (canonicalId !== itemId) {
            owned += accountOwnedItemCount(acct, canonicalId);
            reserved += accountReserveForItem(snapshot, acct.name, canonicalId, supplyIdx.reservesByLower);
        }
        return Math.max(0, owned - reserved);
    };

    if (campaign.stagingHolder) {
        const holderAcct =
            snapshot.accounts[campaign.stagingHolder] ??
            supplyIdx.byLower.get(campaign.stagingHolder.toLowerCase());
        if (!holderAcct) return 0;
        if (holderAcct.lifecycle === 'paused_owner' || holderAcct.lifecycle === 'dead') return 0;
        return ownedForAccount(holderAcct);
    }

    let total = 0;
    for (const acct of supplyIdx.activeNonProtected) {
        total += ownedForAccount(acct);
    }
    return total;
}

export function campaignShortfalls(
    campaign: Campaign,
    snapshot: WorldSnapshot,
    opts: CampaignShortfallsOptions = {},
    _supplyIdx?: SnapshotSupplyIndex,
): CampaignEvaluation {
    const cErrors = validateCampaign(campaign);
    if (cErrors.length > 0) {
        throw new Error(`Invalid Campaign "${String((campaign as Campaign)?.id)}": ${cErrors.join('; ')}`);
    }

    const supplyIdx = _supplyIdx ?? buildSnapshotSupplyIndex(snapshot);
    const aggregated = aggregateSupplyRequirements(campaign.requiredSupplies);
    const missingGates: CampaignMissingGate[] = [];

    if (campaign.state === 'paused') missingGates.push('paused');
    if (campaign.state === 'completed') missingGates.push('completed');
    if (campaign.protectedClock && campaign.rehearsalProof?.verified !== true) missingGates.push('rehearsalProof');
    if (
        campaign.protectedClock &&
        (campaign.hiscoreMargin?.meetsMargin !== true || campaign.hiscoreMargin.board !== campaign.board)
    ) {
        missingGates.push('hiscoreMargin');
    } else if (campaign.protectedClock && !isHiscoreMarginFresh(campaign.hiscoreMargin, snapshot.at)) {
        missingGates.push('staleHiscore');
    }

    let totalRequiredUnits = 0;
    let totalFulfilledUnits = 0;
    const shortfalls: GoalDemand[] = [];
    const inactiveState = campaign.state === 'paused' || campaign.state === 'completed';
    const itemsMap = loadItemsMap();
    const isTightenedSpecialist =
        campaign.account.toLowerCase() !== 'haggis'
        && campaign.hiscoreMargin !== null
        && campaign.hiscoreMargin.meetsMargin === false;

    for (const req of aggregated) {
        totalRequiredUnits += req.count;
        const canonicalId = canonicalUnnotedItemId(req.itemId, req.itemName);
        const owned = availableCampaignSupplyStock(campaign, req.itemId, snapshot, supplyIdx, canonicalId);
        const fulfilled = Math.min(req.count, owned);
        const remaining = req.count - fulfilled;
        totalFulfilledUnits += fulfilled;

        if (remaining > 0 && !missingGates.includes('supplies')) {
            missingGates.push('supplies');
        }

        if (inactiveState && !opts.includeCompletedOrPaused) {
            continue;
        }
        if (remaining <= 0) {
            continue;
        }

        const baseWeight = Math.max(0.1, campaign.weight ?? 1);
        const effectiveWeight = isTightenedSpecialist
            ? Math.max(0.05, baseWeight * TIGHTENED_MARGIN_PRIORITY_FACTOR)
            : baseWeight;
        const unitGp = opts.itemValuesGp?.[req.itemId] ?? opts.itemValuesGp?.[canonicalId] ?? 500;
        const valueScore = Math.max(40, Math.min(4000, Math.sqrt(Math.max(1, remaining * unitGp)) * 4)) * effectiveWeight;
        const canonicalName = itemsMap.get(canonicalId)?.name ?? req.itemName;
        const idSlug = campaign.id.replace(/^campaign:/, '');
        const demand: GoalDemand = {
            id: `campaign:${idSlug}:item:${canonicalId}`,
            goalKind: campaign.account.toLowerCase() === 'haggis' ? 'main_supply' : 'specialist_prep',
            sourceId: campaign.id,
            valueScore,
            target: {
                kind: 'item',
                itemId: canonicalId,
                ...(canonicalName ? { itemName: canonicalName } : {}),
                count: req.count,
                ...(campaign.stagingHolder ? { holder: campaign.stagingHolder } : {}),
            },
            fulfilled,
            remaining,
            priorityWeight: effectiveWeight,
            active: !inactiveState,
        };
        const dErrors = validateGoalDemand(demand);
        if (dErrors.length > 0) {
            throw new Error(`Invalid campaign GoalDemand: ${dErrors.join('; ')}`);
        }
        shortfalls.push(demand);
    }

    const launchReady = isCampaignLaunchReady(campaign, {
        now: snapshot.at,
        suppliesSatisfied: !missingGates.includes('supplies'),
    });

    return {
        campaign,
        launchReady,
        missingGates,
        shortfalls,
        totalRequiredUnits,
        totalFulfilledUnits,
    };
}

export function evaluateCampaigns(
    campaigns: readonly Campaign[],
    snapshot: WorldSnapshot,
    opts: CampaignShortfallsOptions = {},
): CampaignEvaluation[] {
    const supplyIdx = buildSnapshotSupplyIndex(snapshot);
    return campaigns.map((campaign) => campaignShortfalls(campaign, snapshot, opts, supplyIdx));
}
