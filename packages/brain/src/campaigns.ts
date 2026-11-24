// Declarative Campaign manifests for Haggis (Overall) and all 19 reserved Specialists.
// Reads launch manifests, rehearsal proofs, hiscore margins, staging holders, and owner stops,
// and emits finite item shortfall GoalDemands for unfulfilled campaign supplies.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findStopFile, liveRoot, practiceRoot, repoRoot } from '../../core/src/practice-paths';
import { SPECIALIST_BOARDS } from '../../core/src/specialist-boards';
import {
    TRICKS,
    boardsFromSnapshot,
    haggisActivities,
    haggisTravel,
    overallRequirementsFor,
    scheduleOverall,
} from '../../planner/src/haggis';
import { idsFor } from '../../planner/src/supply-bill';
import { accountOwnedItemCount } from '../../workers/src/contracts';
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

function buildItemLookup(root: string): ItemLookup {
    const itemsPath = existsSync(join(root, 'knowledge', 'items.json'))
        ? join(root, 'knowledge', 'items.json')
        : join(repoRoot, 'knowledge', 'items.json');
    const raw = readJsonSafe(itemsPath);
    const items: KnowledgeItemRow[] = [];
    const byId = new Map<number, KnowledgeItemRow>();
    const byName = new Map<string, KnowledgeItemRow>();

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

    const resolveItem = (rawId: unknown, rawName: unknown) => {
        if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0) {
            const known = byId.get(rawId);
            const fallbackName =
                typeof rawName === 'string' && rawName.trim().length > 0 ? rawName.trim() : known?.name ?? `item:${rawId}`;
            return { itemId: rawId, itemName: known?.name ?? fallbackName };
        }
        if (typeof rawName === 'string' && rawName.trim().length > 0) {
            const trimmed = rawName.trim();
            const matchedIds = idsFor(trimmed, items);
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
                    return { itemId: best.id, itemName: best.name };
                }
            }
            const norm = normalizeItemKey(trimmed);
            const known = byName.get(trimmed.toLowerCase()) ?? byName.get(norm);
            if (known) {
                return { itemId: known.id, itemName: known.name };
            }
        }
        return undefined;
    };

    return { items, byId, resolve: resolveItem };
}

function loadHiscoreSnapshots(root: string): HiscoreSnapshot[] {
    const candidates = [
        join(practiceRoot(root), 'specialist-launch', 'hiscores.json'),
        join(liveRoot(root), 'specialist-launch', 'hiscores.json'),
        join(root, 'research', 'hiscores-live.json'),
    ];
    const entries: { snapshot: HiscoreSnapshot; takenAtMs: number; priority: number }[] = [];
    candidates.forEach((file, priority) => {
        const parsed = readJsonSafe(file);
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
    return entries.map((e) => e.snapshot);
}

function findHiscoreBoard(
    snapshots: readonly HiscoreSnapshot[],
    boardName: string,
    category?: number,
): { readonly snapshot: HiscoreSnapshot; readonly board: HiscoreBoard } | undefined {
    for (const snap of snapshots) {
        for (const b of snap.boards ?? []) {
            if (b.board === boardName && (category === undefined || b.category === category)) {
                return { snapshot: snap, board: b };
            }
        }
    }
    return undefined;
}

function computeHiscoreMargin(
    boardName: string,
    category: number | undefined,
    ourTicks: number | undefined,
    snapshots: readonly HiscoreSnapshot[],
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
    const checkedAt = Number.isFinite(parsedAt) && parsedAt > 0 ? parsedAt : now;

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

function hasActiveGoToken(goPath: string, now: number): boolean {
    if (!existsSync(goPath)) return false;
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

function isOwnerStoppedAccount(account: string, root: string): boolean {
    const file = findStopFile(account, root) ?? findStopFile(account.toLowerCase(), root);
    if (!file) return false;
    try {
        const text = readFileSync(file, 'utf8').trim();
        return !/^(?:swarm stopped|fleet-health auto-paused:)/i.test(text);
    } catch {
        return true;
    }
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

function buildHaggisCampaign(root: string, lookup: ItemLookup, snapshots: readonly HiscoreSnapshot[], now: number): Campaign {
    const boardsFile = join(root, 'packages', 'planner', 'src', 'haggis-boards.json');
    const readinessFile =
        existsSync(join(liveRoot(root), 'haggis-readiness.json'))
            ? join(liveRoot(root), 'haggis-readiness.json')
            : join(practiceRoot(root), 'haggis-readiness.json');

    const boardsData = readJsonSafe(boardsFile);
    const readinessData = readJsonSafe(readinessFile);

    const rawSupplies: CampaignSupplyRequirement[] = [];
    let plannedTicks = 0;

    const overallHit = findHiscoreBoard(snapshots, 'Overall', 0);
    if (overallHit && existsSync(boardsFile)) {
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
            }
        } catch {
            // Fall back to static boardsFile aggregation below if snapshot scheduling fails.
        }
    }

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

    const stopped = isOwnerStoppedAccount('haggis', root);
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
    snapshots: readonly HiscoreSnapshot[],
    now: number,
): Campaign {
    const lower = account.toLowerCase();
    const declarative = getSpecialistCampaignSpec(lower);
    const manifestPath = existsSync(join(liveRoot(root), 'specialist-launch', `${lower}.json`))
        ? join(liveRoot(root), 'specialist-launch', `${lower}.json`)
        : join(practiceRoot(root), 'specialist-launch', `${lower}.json`);
    const goPath = existsSync(join(liveRoot(root), 'specialist-launch', `${lower}.go.json`))
        ? join(liveRoot(root), 'specialist-launch', `${lower}.go.json`)
        : join(practiceRoot(root), 'specialist-launch', `${lower}.go.json`);

    const manifest = readJsonSafe(manifestPath);
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
    } else if (declarative?.defaultRehearsalReportPath) {
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
    const hiscoreMargin = computeHiscoreMargin(board.name, board.category, planTicks, snapshots, now, true);
    const stopped = isOwnerStoppedAccount(lower, root);
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

function readCampaignOverrides(root: string, overridePath?: string): Map<string, Campaign> {
    const out = new Map<string, Campaign>();
    const paths = overridePath
        ? [overridePath]
        : [join(practiceRoot(root), 'campaigns.json'), join(liveRoot(root), 'campaigns.json')];
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
    const root = opts.root ?? repoRoot;
    const now = opts.now ?? Date.now();
    const lookup = buildItemLookup(root);
    const snapshots = loadHiscoreSnapshots(root);

    const byId = new Map<string, Campaign>();
    if (opts.includeHaggis !== false) {
        const haggis = buildHaggisCampaign(root, lookup, snapshots, now);
        const errors = validateCampaign(haggis);
        if (errors.length > 0) throw new Error(`Invalid Haggis campaign: ${errors.join('; ')}`);
        byId.set(haggis.id, haggis);
    }

    if (opts.includeSpecialists !== false) {
        for (const [account, board] of Object.entries(SPECIALIST_BOARDS)) {
            const c = buildSpecialistCampaign(root, account, board, lookup, snapshots, now);
            const errors = validateCampaign(c);
            if (errors.length > 0) throw new Error(`Invalid specialist campaign (${account}): ${errors.join('; ')}`);
            byId.set(c.id, c);
        }
    }

    if (opts.includeRetiredSpecialists === true) {
        for (const spec of RETIRED_SPECIALIST_CAMPAIGN_SPECS) {
            const c = buildSpecialistCampaign(root, spec.account, { name: spec.board, category: spec.category }, lookup, snapshots, now);
            const errors = validateCampaign(c);
            if (errors.length > 0) throw new Error(`Invalid retired specialist campaign (${spec.account}): ${errors.join('; ')}`);
            byId.set(c.id, c);
        }
    }

    const overrides = readCampaignOverrides(root, opts.overridePath);
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

function accountReserveForItem(snapshot: WorldSnapshot, acctName: string, itemId: number): number {
    if (!snapshot.reserves) return 0;
    const exact = snapshot.reserves[acctName]?.[itemId];
    if (exact !== undefined) return exact;
    const lower = acctName.toLowerCase();
    const lowerHit = snapshot.reserves[lower]?.[itemId];
    if (lowerHit !== undefined) return lowerHit;
    for (const [k, map] of Object.entries(snapshot.reserves)) {
        if (k.toLowerCase() === lower) return map?.[itemId] ?? 0;
    }
    return 0;
}

function availableCampaignSupplyStock(
    campaign: Campaign,
    itemId: number,
    snapshot: WorldSnapshot,
    canonicalId = itemId,
): number {
    const ownedForAccount = (acct: WorldSnapshot['accounts'][string]): number => {
        let owned = accountOwnedItemCount(acct, itemId);
        let reserved = accountReserveForItem(snapshot, acct.name, itemId);
        if (canonicalId !== itemId) {
            owned += accountOwnedItemCount(acct, canonicalId);
            reserved += accountReserveForItem(snapshot, acct.name, canonicalId);
        }
        return Math.max(0, owned - reserved);
    };

    if (campaign.stagingHolder) {
        const holderAcct =
            snapshot.accounts[campaign.stagingHolder] ??
            Object.values(snapshot.accounts).find(
                (a) => a.name.toLowerCase() === campaign.stagingHolder!.toLowerCase(),
            );
        if (!holderAcct) return 0;
        return ownedForAccount(holderAcct);
    }

    let total = 0;
    for (const acct of Object.values(snapshot.accounts)) {
        if (acct.protectedClock) continue;
        if (acct.lifecycle === 'paused_owner' || acct.lifecycle === 'dead') continue;
        total += ownedForAccount(acct);
    }
    return total;
}

export function campaignShortfalls(
    campaign: Campaign,
    snapshot: WorldSnapshot,
    opts: CampaignShortfallsOptions = {},
): CampaignEvaluation {
    const cErrors = validateCampaign(campaign);
    if (cErrors.length > 0) {
        throw new Error(`Invalid Campaign "${String((campaign as Campaign)?.id)}": ${cErrors.join('; ')}`);
    }

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
        const owned = availableCampaignSupplyStock(campaign, req.itemId, snapshot, canonicalId);
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
        const demand: GoalDemand = {
            id: `campaign:${campaign.id}:item:${canonicalId}`,
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
            ...(campaign.stagingHolder ? { assignedAccount: campaign.stagingHolder } : {}),
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
    return campaigns.map((campaign) => campaignShortfalls(campaign, snapshot, opts));
}
