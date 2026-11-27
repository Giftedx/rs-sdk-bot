// OutcomeClassifier and raw worker-exit classifier covering all 8 OutcomeKinds:
// updates RateStore, market (item, venue) TTL cooldowns, location/logout recovery holds,
// global infra circuit breaker (without account penalties), defect quarantine, and non-expiring death.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { liveRoot, repoRoot } from '../../core/src/practice-paths';
import { isWorkerReleaseHold } from '../../core/src/worker-release';
import {
    validateRunOutcome,
    type DeathOutcome,
    type InfraFaultOutcome,
    type InfraFaultSource,
    type LocationStrandedOutcome,
    type MarketUnavailableOutcome,
    type MissingSupplyOutcome,
    type RunOutcome,
    type RunOutcomeMissingItem,
    type SessionUnsettledOutcome,
    type TargetMetOutcome,
    type WorkerDefectOutcome,
    type WorkerTile,
} from '../../workers/src/contracts';
import {
    createExpiringHold,
    HUB_BANKER_LOCATIONS,
    isHoldActive,
    marketCooldownKey,
    pruneExpiredCooldowns,
    pruneExpiredHolds,
    setCooldown,
    validateAccountState,
    validateDefectRecord,
    validateRateSample,
    validateWorldSnapshot,
    type AccountLifecycle,
    type AccountState,
    type DeathLevels,
    type DefectRecord,
    type InfraCircuitBreakerState,
    type NoRouteFact,
    type OperatorCommand,
    type RateSample,
    type SystemHold,
    type WorldSnapshot,
} from './contracts';
import { shopRestockTicks } from './acquire';
import { addNoRoute, atTarget, enclosedAt, isNoRouteFact, NO_ROUTE_TTL_MS, noRouteHolds, noRouteMessage, noRouteState, parseNoRoute, standsAt } from './no-route';
import type { RateStore } from './rate-store';

export const DEFAULT_MARKET_COOLDOWN_MS = 10 * 60_000;
// The live server tick (demand.ts TICK_MS).
const SERVER_TICK_MS = 400;

// An empty shelf stays empty until the shop restocks the item: the Ardougne gem stall restocks its sapphires each
// 15000 ticks (100 min), so a shorter cooldown sends the next buyer to the same empty stall.
export function shopRestockCooldownMs(itemId: number, venue: string): number {
    const shop = /^shop:(.+)$/.exec(venue)?.[1];
    if (!shop || !(itemId > 0)) return 0;
    const ticks = shopRestockTicks(itemId, shop);
    return ticks !== undefined && Number.isFinite(ticks) && ticks > 0 ? ticks * SERVER_TICK_MS : 0;
}
export const DEFAULT_RECOVERY_HOLD_TTL_MS = 30 * 60_000;
export const DEFAULT_DEFECT_TTL_MS = 24 * 3_600_000;
// A death defect with the levels of the dead account holds the activity this long for accounts of that class or
// weaker (planner.ts deathClassBlocks). The fleet-wide hold stays DEFAULT_DEFECT_TTL_MS.
export const DEATH_CLASS_TTL_MS = 14 * 24 * 3_600_000;
// Repeat faults: an outcome kind that holds nothing by itself (missing_supply, location_stranded) can end the same
// activity with the same text again and again, each a login that does no work. Live: "quest-sweep tree missing
// 2434:2 (unsold; others in shops)" ended 17 runs of 10 accounts in 24 h, each under 25 s. A run shorter than
// REPEAT_FAST_MS counts. The same account twice holds the activity for that account; REPEAT_FLEET_ACCOUNTS accounts
// hold it for every account (planner.ts isFleetWideDefect). Such a hold lasts REPEAT_DEFECT_TTL_MS, and a run of the
// activity that meets its target ends the count.
export const REPEAT_FAST_MS = 120_000;
export const REPEAT_WINDOW_MS = 24 * 3_600_000;
export const REPEAT_ACCOUNT_RUNS = 2;
export const REPEAT_FLEET_ACCOUNTS = 3;
export const REPEAT_DEFECT_TTL_MS = 6 * 3_600_000;
export type RepeatFault = { readonly account: string; readonly at: number };
const REPEAT_KINDS: ReadonlySet<RunOutcome['kind']> = new Set(['missing_supply', 'location_stranded']);
export const DEFAULT_INFRA_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_INFRA_MAX_BACKOFF_MS = 15 * 60_000;
export const DEFAULT_INFRA_BACKOFF_FACTOR = 2;
export const OUTCOME_STATE_SCHEMA_VERSION = 1 as const;

export interface RawWorkerExitInput {
    readonly activityId: string;
    readonly account: string;
    readonly exitCode?: number | null;
    readonly status?: string;
    readonly reason?: string;
    readonly summary?: string;
    readonly detail?: string;
    readonly error?: string;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly ticksElapsed?: number;
    readonly durationMs?: number;
    readonly unitsCompleted?: number;
    readonly xpGained?: Readonly<Record<string, number>>;
    readonly itemsDelta?: Readonly<Record<number, number>>;
    readonly coinsDelta?: number;
    readonly pos?: WorkerTile | null;
    readonly missing?: readonly RunOutcomeMissingItem[];
    readonly marketItemId?: number;
    readonly marketVenue?: string;
    readonly cooldownMs?: number;
    readonly infraSource?: InfraFaultSource;
    readonly retryAfterMs?: number;
    readonly faultSignature?: string;
    readonly logPath?: string;
    readonly tickRecordPath?: string;
    readonly died?: boolean;
    // The base levels of an account that died (DefectRecord.deathLevels).
    readonly deathLevels?: DeathLevels;
    readonly outcome?: RunOutcome;
    readonly skipRateSample?: boolean;
}

export interface OutcomeClassifierOptions {
    readonly rateStore?: RateStore;
    readonly root?: string;
    readonly filePath?: string;
    readonly persist?: boolean;
    readonly defaultMarketCooldownMs?: number;
    readonly defaultRecoveryHoldTtlMs?: number;
    readonly defaultDefectTtlMs?: number;
    readonly infraBaseBackoffMs?: number;
    readonly infraMaxBackoffMs?: number;
    readonly infraBackoffFactor?: number;
}

export interface AccountOutcomeOverlay {
    readonly lifecycleOverride?: AccountLifecycle;
    readonly lifecycleExpiresAt?: number;
    readonly holds: readonly SystemHold[];
    readonly cooldowns: Readonly<Record<string, number>>;
}

export interface OutcomeClassifierState {
    readonly schemaVersion: typeof OUTCOME_STATE_SCHEMA_VERSION;
    readonly updatedAt: number;
    readonly infraBreaker: InfraCircuitBreakerState;
    readonly marketCooldowns: Readonly<Record<string, number>>;
    readonly defects: readonly DefectRecord[];
    readonly accountOverlays: Readonly<Record<string, AccountOutcomeOverlay>>;
    // Per account (lower case): the targets its own route search found no route to (no-route.ts).
    readonly noRoutes?: Readonly<Record<string, readonly NoRouteFact[]>>;
    // Per activity and fault signature: the fast runs that ended with it in REPEAT_WINDOW_MS (REPEAT_KINDS).
    readonly repeatFaults?: Readonly<Record<string, readonly RepeatFault[]>>;
}

export interface OutcomeClassificationResult {
    readonly outcome: RunOutcome;
    readonly account: string;
    readonly activityId: string;
    readonly recordedRateSample?: RateSample;
    readonly accountLifecycle?: AccountLifecycle;
    readonly addedHold?: SystemHold;
    readonly addedCooldownKey?: string;
    readonly cooldownExpiresAt?: number;
    readonly missingSupplies?: readonly RunOutcomeMissingItem[];
    readonly defect?: DefectRecord;
    readonly noRoute?: NoRouteFact;
    readonly infraBreaker?: InfraCircuitBreakerState;
    readonly accountPenalized: boolean;
    readonly unlockFollowUp: boolean;
    readonly clearedTransientRecovery: boolean;
    readonly summary: string;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
}

function normalizeFaultSignature(raw: string): string {
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
    const scrubbed = firstLine
        .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
        .replace(/\b(?:x|z|level|tick|id|pid|port)[=:\s]*-?\d+\b/gi, (m) => m.replace(/-?\d+/, '<n>'))
        .replace(/\b-?\d+\b/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return scrubbed.length > 0 ? scrubbed : 'worker_defect';
}

function defectKey(activityId: string, faultSignature: string): string {
    return `${activityId}::${faultSignature}`;
}

function sanitizeXpGained(raw?: Readonly<Record<string, number>>): Record<string, number> | undefined {
    if (!raw) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (nonEmpty(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) {
            out[k.trim()] = v;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeItemsDelta(raw?: Readonly<Record<number, number>>): Record<number, number> | undefined {
    if (!raw) return undefined;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (/^(0|[1-9]\d*)$/.test(k) && typeof v === 'number' && Number.isFinite(v)) {
            out[Number(k)] = Math.trunc(v);
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

// An HTTP status counts only with a word that names it as one: result lines carry plain numbers such as ticks=503.
const INFRA_PROXY_RE = /(?:proxy|socks|econnrefused|ehostunreach|enetunreach|gateway.*502|\b(?:http|status|code|error:?|failed with)"?\s*:?\s*(?:502|503|429)\b|\b(?:502|503)\s+(?:bad gateway|service unavailable)\b|\b429\s+too many requests\b|tunnel)/i;
const INFRA_DRAIN_RE = /(?:server.?drain|world.?update|restarting|maintenance|engine.?shutdown|eaddrinuse|localserver)/i;
const INFRA_CLAIM_RE = /(?:remote.?git|push.*rejected|non-fast-forward|git.*lock|fleet-data.*sync|claim.?authority)/i;
const INFRA_NETWORK_RE = /(?:websocket|gateway|connect|network|socket).*(?:timeout|timed out|etimedout)/i;
const INFRA_GENERIC_RE = /(?:\binfra.?fault\b|circuit.?breaker|rate.?limit)/i;
// A death in words ("stop=died", "RESULT fail died") or a true flag. A field name with its value (died=false,
// "died":false, death=0) is a report, not a death: worker RESULT lines carry died=false on every run.
const DEATH_TEXT_RE = /\b(?:died|death)\b(?!\s*(?:=|"?\s*:))|\bdied(?:=|"\s*:\s*)true\b|you are dead|oh dear/i;
// Death Plateau's quest slug is "death": "quest-sweep death missing 2064:1", "quest:death", "quest-death.ts" and the
// quest name name a quest, not a death.
const DEATH_QUEST_NAME_RE = /\bquest(?:-sweep\s+|_board:|[-_:])death\b|\bdeath plateau\b/gi;
// The session HP floor (packages/core/src/hp-floor.ts) ended the run after an escape at low Hitpoints: the activity's
// food plan or target let the account fall to two hits of death. It is a defect of the activity, held like one.
const HP_FLOOR_RE = /\bstop=hp-floor\b|^\s*(?:\|\s*)?HP_FLOOR escape /m;
export const HP_FLOOR_SIGNATURE = 'hp-floor';
export const hpFloorText = (text: string) => HP_FLOOR_RE.test(text);
export const deathText = (text: string) => DEATH_TEXT_RE.test(text.replace(DEATH_QUEST_NAME_RE, 'quest plateau'));
const SESSION_UNSETTLED_RE = /session.?unsettled|logout.?proof|still.?logged.?in|already logged in|session.?held|world.?switch.?failed|not logged out/i;
const LOCATION_STRANDED_RE = /location.?stranded|stranded|no path to|cannot reach|unreachable bank|stuck.*(?:upstairs|basement|dungeon|island)/i;
const MARKET_UNAVAILABLE_RE = /market.?unavailable|out of stock|no ge offers|ge.*unavailable|shop.*empty|buy limit|no sellers|not sold here/i;
const SHOP_STOCK_WAIT_RE = /\bboughtTotal=0\b[\s\S]*\bstop=stock-wait\b|\bstop=stock-wait\b[\s\S]*\bboughtTotal=0\b/i;
// The quest sweep names what it could not stage as <id>:<count> pairs: "missing 2325:1" (no bank row, shop or gather
// plan) and "withdraw short 2351:2" (packages/workers/src/quest/sweep.ts).
const MISSING_PAIRS_RE = /\b(?:missing|withdraw short) (\d+:\d+(?:,\d+:\d+)*)\b/;
const MISSING_SUPPLY_RE = /missing.?supply|insufficient.*(?:coins|gp|supply|supplies|food|runes|logs|ore|bars|arrows|tools|item)|out of supplies|no .* in bank|\b(?:missing|withdraw short) \d+:\d+\b/i;
const FAILURE_MARKER_RE = /\b(?:fail|failed|error|exception|crash|abort|defect|timeout|timed out)\b/i;
const SUCCESS_MARKER_RE = /\b(?:target.?met|completed?|done)\b/i;

// A login that a fleet claim refused ("fleet account claim held by swarm", "fleet trade claim held for order ...",
// packages/core/src/fleet-trade-claim.ts). The claim holds the account. It says nothing about the activity.
const CLAIM_HELD_RE = /^RESULT fail (?:login: )?(?:Error: )?fleet (?:account|trade) claim held\b/;
export const isClaimHeldResult = (result: string) => CLAIM_HELD_RE.test(result);
// A worker that a stop ends in the middle of its work names the stop in its own words: "stop file", "cargo stopped",
// "production session stopped", "stop=stopped", "magic-order stop requested", "far walk to ...: stopped", and the
// smelt send guard "owner/life/stop unavailable". A route that the stop cancels prints the abort of its signal:
// "AbortError: The operation was aborted." (a magic earth production run that crafted 1053 runes).
const STOP_RESULT_RE = /\bstop file\b|\bstopped\b|\bstop requested\b|\/stop unavailable\b|\bAbortError\b|\boperation was aborted\b/;
export const isStopResult = (result: string) => STOP_RESULT_RE.test(result);
// A saved defect has no end reason of its supervisor, so only a text that a stop request alone writes counts there.
// "production session stopped", "herblore stopped" and the smelt send guard also name an ended session or a changed
// life: such a record keeps its quarantine. An abort can also come from a tick budget, so it counts only in
// STOP_RESULT_RE, which needs a supervisor end that a stop wrote.
const STOP_FAILURE_RE = /\bstop file\b|\bstop requested\b/;
// A result line that a gate wrote: a release hold, a held claim or a stop. Such a line is no worker defect.
export const isGateHeldResult = (result: string) => isWorkerReleaseHold(result) || isClaimHeldResult(result) || STOP_FAILURE_RE.test(result);

function detectInfraSource(text: string): InfraFaultSource | undefined {
    if (INFRA_PROXY_RE.test(text)) {
        return 'proxy';
    }
    if (INFRA_DRAIN_RE.test(text)) {
        return 'server_drain';
    }
    if (INFRA_CLAIM_RE.test(text)) {
        return 'claim_authority';
    }
    if (INFRA_NETWORK_RE.test(text)) {
        return 'network';
    }
    if (INFRA_GENERIC_RE.test(text)) {
        return 'unknown';
    }
    return undefined;
}

function inferMissingItems(text: string): RunOutcomeMissingItem[] {
    const pairs = MISSING_PAIRS_RE.exec(text);
    if (pairs) {
        return pairs[1]!.split(',').map((p) => {
            const [id, count] = p.split(':').map(Number);
            return { itemId: id!, required: Math.max(1, count!), available: 0 };
        });
    }
    const idMatch = /\bitem(?:id)?[=: #]*(\d+)\b/i.exec(text);
    const qtyMatch = /\b(?:need|required|missing)[=: ]*(\d+)\b/i.exec(text);
    const required = qtyMatch ? Math.max(1, Number(qtyMatch[1])) : 1;
    if (idMatch) {
        return [{ itemId: Number(idMatch[1]), required, available: 0 }];
    }
    if (/\b(?:coins|gp|gold)\b/i.test(text)) {
        return [{ itemId: 995, required, available: 0, itemName: 'Coins' }];
    }
    return [{ itemId: 995, required, available: 0 }];
}

function inferMarketDetails(input: RawWorkerExitInput, text: string): { itemId: number; venue: string } {
    if (input.marketItemId !== undefined || input.marketVenue !== undefined) {
        return {
            itemId: Math.max(0, Math.trunc(input.marketItemId ?? 0)),
            venue: nonEmpty(input.marketVenue) ?? (/shop/i.test(text) ? 'npc_shop' : 'ge'),
        };
    }
    const idMatch = /\bitem(?:id)?[=: #]*(\d+)\b/i.exec(text);
    const venue = /\bshop\b/i.test(text) ? 'npc_shop' : 'ge';
    return {
        itemId: idMatch ? Math.max(0, Math.trunc(Number(idMatch[1]))) : 0,
        venue,
    };
}

export function classifyRawWorkerExit(input: RawWorkerExitInput): RunOutcome {
    if (input.outcome && validateRunOutcome(input.outcome).length === 0) {
        return input.outcome;
    }

    const ticksElapsed = Math.max(0, Math.round(input.ticksElapsed ?? 0));
    const xpGained = sanitizeXpGained(input.xpGained);
    const itemsDelta = sanitizeItemsDelta(input.itemsDelta);
    const coinsDelta =
        typeof input.coinsDelta === 'number' && Number.isFinite(input.coinsDelta)
            ? Math.trunc(input.coinsDelta)
            : undefined;
    const summary = nonEmpty(input.summary) ?? nonEmpty(input.reason) ?? nonEmpty(input.status);
    const detail = nonEmpty(input.detail) ?? nonEmpty(input.error) ?? nonEmpty(input.reason);
    const text = [input.status, input.reason, input.summary, input.detail, input.error, input.stderr, input.stdout]
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .join('\n');

    const base = {
        activityId: input.activityId.trim(),
        account: input.account.trim(),
        ticksElapsed,
        ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) && input.durationMs >= 0
            ? { durationMs: input.durationMs }
            : {}),
        ...(typeof input.unitsCompleted === 'number' && Number.isFinite(input.unitsCompleted) && input.unitsCompleted >= 0
            ? { unitsCompleted: input.unitsCompleted }
            : {}),
        ...(xpGained ? { xpGained } : {}),
        ...(itemsDelta ? { itemsDelta } : {}),
        ...(coinsDelta !== undefined ? { coinsDelta } : {}),
        ...(summary ? { summary } : {}),
    };

    if (input.died === true || deathText(text)) {
        const out: DeathOutcome = {
            kind: 'death',
            ...base,
            ...(nonEmpty(input.faultSignature) ? { faultSignature: nonEmpty(input.faultSignature) } : {}),
            ...(input.pos !== undefined ? { pos: input.pos } : {}),
            ...(nonEmpty(input.logPath) ? { logPath: nonEmpty(input.logPath) } : {}),
            ...(nonEmpty(input.tickRecordPath) ? { tickRecordPath: nonEmpty(input.tickRecordPath) } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (hpFloorText(text)) {
        const out: WorkerDefectOutcome = {
            kind: 'worker_defect',
            ...base,
            faultSignature: HP_FLOOR_SIGNATURE,
            ...(nonEmpty(input.logPath) ? { logPath: nonEmpty(input.logPath) } : {}),
            ...(nonEmpty(input.tickRecordPath) ? { tickRecordPath: nonEmpty(input.tickRecordPath) } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    const infraSource = input.infraSource ?? detectInfraSource(text);
    if (infraSource) {
        const out: InfraFaultOutcome = {
            kind: 'infra_fault',
            ...base,
            source: infraSource,
            ...(typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs) && input.retryAfterMs > 0
                ? { retryAfterMs: input.retryAfterMs }
                : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (SESSION_UNSETTLED_RE.test(text)) {
        const out: SessionUnsettledOutcome = {
            kind: 'session_unsettled',
            ...base,
            ...(nonEmpty(input.reason) ? { reason: nonEmpty(input.reason) } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (LOCATION_STRANDED_RE.test(text)) {
        const out: LocationStrandedOutcome = {
            kind: 'location_stranded',
            ...base,
            ...(input.pos !== undefined ? { pos: input.pos } : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (
        input.marketItemId !== undefined ||
        input.marketVenue !== undefined ||
        MARKET_UNAVAILABLE_RE.test(text) ||
        SHOP_STOCK_WAIT_RE.test(text)
    ) {
        const market = inferMarketDetails(input, text);
        const out: MarketUnavailableOutcome = {
            kind: 'market_unavailable',
            ...base,
            itemId: market.itemId,
            venue: market.venue,
            ...(typeof input.cooldownMs === 'number' && Number.isFinite(input.cooldownMs) && input.cooldownMs > 0
                ? { cooldownMs: input.cooldownMs }
                : {}),
            ...(detail ? { detail } : {}),
        };
        return out;
    }

    if (
        (input.missing && input.missing.length > 0) ||
        MISSING_SUPPLY_RE.test(text)
    ) {
        const missing = input.missing && input.missing.length > 0 ? input.missing : inferMissingItems(text);
        const out: MissingSupplyOutcome = {
            kind: 'missing_supply',
            ...base,
            missing,
        };
        return out;
    }

    const headText = [input.status, input.reason, input.error].filter(Boolean).join(' ');
    const hasFailureMarker = FAILURE_MARKER_RE.test(headText);
    const hasSuccessStatus =
        input.exitCode === 0 ||
        input.status === 'done' ||
        input.status === 'ok' ||
        input.status === 'target_met' ||
        SUCCESS_MARKER_RE.test(headText);

    if (hasSuccessStatus && !hasFailureMarker && (input.exitCode === undefined || input.exitCode === 0)) {
        const out: TargetMetOutcome = {
            kind: 'target_met',
            ...base,
        };
        return out;
    }

    const faultSignature =
        nonEmpty(input.faultSignature) ??
        normalizeFaultSignature(detail ?? summary ?? `exit_${input.exitCode ?? 'unknown'}`);
    const out: WorkerDefectOutcome = {
        kind: 'worker_defect',
        ...base,
        faultSignature,
        ...(nonEmpty(input.logPath) ? { logPath: nonEmpty(input.logPath) } : {}),
        ...(nonEmpty(input.tickRecordPath) ? { tickRecordPath: nonEmpty(input.tickRecordPath) } : {}),
        ...(detail ? { detail } : {}),
    };
    return out;
}

// Two deaths on one activity: the defect keeps the stronger levels, so it holds every account that either death would.
function weakerDeathLevels(next: DeathLevels, prev: DeathLevels | undefined): DeathLevels {
    return prev ? { hitpoints: Math.max(next.hitpoints, prev.hitpoints), defence: Math.max(next.defence, prev.defence) } : next;
}

export class OutcomeClassifier {
    readonly filePath: string;
    private readonly rateStore?: RateStore;
    private readonly persist: boolean;
    private readonly defaultMarketCooldownMs: number;
    private readonly defaultRecoveryHoldTtlMs: number;
    private readonly defaultDefectTtlMs: number;
    private readonly infraBaseBackoffMs: number;
    private readonly infraMaxBackoffMs: number;
    private readonly infraBackoffFactor: number;

    private infraBreaker: InfraCircuitBreakerState = { open: false, consecutiveFaults: 0 };
    private marketCooldowns: Record<string, number> = {};
    private readonly defects = new Map<string, DefectRecord>();
    private readonly accountOverlays = new Map<string, AccountOutcomeOverlay>();
    private readonly noRoutes = new Map<string, NoRouteFact[]>();
    private readonly repeatFaults = new Map<string, RepeatFault[]>();

    constructor(opts: OutcomeClassifierOptions = {}) {
        this.rateStore = opts.rateStore;
        const root = opts.root ?? repoRoot;
        this.filePath = opts.filePath ?? join(liveRoot(root), 'outcome-state.json');
        this.persist = opts.persist ?? (opts.filePath !== undefined || opts.root !== undefined);
        this.defaultMarketCooldownMs = opts.defaultMarketCooldownMs ?? DEFAULT_MARKET_COOLDOWN_MS;
        this.defaultRecoveryHoldTtlMs = opts.defaultRecoveryHoldTtlMs ?? DEFAULT_RECOVERY_HOLD_TTL_MS;
        this.defaultDefectTtlMs = opts.defaultDefectTtlMs ?? DEFAULT_DEFECT_TTL_MS;
        this.infraBaseBackoffMs = opts.infraBaseBackoffMs ?? DEFAULT_INFRA_BASE_BACKOFF_MS;
        this.infraMaxBackoffMs = opts.infraMaxBackoffMs ?? DEFAULT_INFRA_MAX_BACKOFF_MS;
        this.infraBackoffFactor = Math.max(1, opts.infraBackoffFactor ?? DEFAULT_INFRA_BACKOFF_FACTOR);
        if (this.persist && existsSync(this.filePath)) {
            this.load();
        }
    }

    load(): void {
        this.infraBreaker = { open: false, consecutiveFaults: 0 };
        this.marketCooldowns = {};
        this.defects.clear();
        this.accountOverlays.clear();
        this.noRoutes.clear();
        this.repeatFaults.clear();
        if (!existsSync(this.filePath)) return;

        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        } catch {
            return;
        }
        if (!isPlainRecord(parsed)) return;

        if (isPlainRecord(parsed.infraBreaker) && typeof parsed.infraBreaker.open === 'boolean') {
            this.infraBreaker = {
                open: parsed.infraBreaker.open,
                consecutiveFaults:
                    typeof parsed.infraBreaker.consecutiveFaults === 'number' && parsed.infraBreaker.consecutiveFaults >= 0
                        ? Math.trunc(parsed.infraBreaker.consecutiveFaults)
                        : 0,
                ...(typeof parsed.infraBreaker.trippedAt === 'number' ? { trippedAt: parsed.infraBreaker.trippedAt } : {}),
                ...(typeof parsed.infraBreaker.retryAt === 'number' ? { retryAt: parsed.infraBreaker.retryAt } : {}),
                ...(nonEmpty(parsed.infraBreaker.reason) ? { reason: nonEmpty(parsed.infraBreaker.reason) } : {}),
            };
        }

        if (isPlainRecord(parsed.marketCooldowns)) {
            for (const [k, exp] of Object.entries(parsed.marketCooldowns)) {
                if (nonEmpty(k) && typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
                    this.marketCooldowns[k] = exp;
                }
            }
        }

        if (Array.isArray(parsed.defects)) {
            for (const item of parsed.defects) {
                if (validateDefectRecord(item).length === 0) {
                    // A saved state can hold a gate's line as a worker defect. Such a record does not quarantine.
                    const gateHeld = item.quarantined && item.outcomeKind === 'worker_defect' && isGateHeldResult(item.detail);
                    this.defects.set(defectKey(item.activityId, item.faultSignature), gateHeld ? { ...item, quarantined: false } : item);
                }
            }
        }

        if (isPlainRecord(parsed.accountOverlays)) {
            for (const [account, overlay] of Object.entries(parsed.accountOverlays)) {
                if (!nonEmpty(account) || !isPlainRecord(overlay)) continue;
                const holds = Array.isArray(overlay.holds) ? (overlay.holds as SystemHold[]) : [];
                const cooldowns: Record<string, number> = {};
                if (isPlainRecord(overlay.cooldowns)) {
                    for (const [k, exp] of Object.entries(overlay.cooldowns)) {
                        if (nonEmpty(k) && typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
                            cooldowns[k] = exp;
                        }
                    }
                }
                this.accountOverlays.set(account.toLowerCase(), {
                    ...(typeof overlay.lifecycleOverride === 'string'
                        ? { lifecycleOverride: overlay.lifecycleOverride as AccountLifecycle }
                        : {}),
                    ...(typeof overlay.lifecycleExpiresAt === 'number'
                        ? { lifecycleExpiresAt: overlay.lifecycleExpiresAt }
                        : {}),
                    holds,
                    cooldowns,
                });
            }
        }

        if (isPlainRecord(parsed.repeatFaults)) {
            for (const [key, faults] of Object.entries(parsed.repeatFaults)) {
                const kept = Array.isArray(faults)
                    ? faults.filter((f): f is RepeatFault => isPlainRecord(f) && nonEmpty(f.account) !== undefined && typeof f.at === 'number' && Number.isFinite(f.at))
                    : [];
                if (nonEmpty(key) && kept.length > 0) this.repeatFaults.set(key, kept.map(f => ({ account: f.account, at: f.at })));
            }
        }

        if (isPlainRecord(parsed.noRoutes)) {
            for (const [account, facts] of Object.entries(parsed.noRoutes)) {
                const kept = Array.isArray(facts) ? facts.filter(isNoRouteFact) : [];
                if (nonEmpty(account) && kept.length > 0) this.noRoutes.set(account.toLowerCase(), kept);
            }
        } else {
            // A state saved before no-route facts holds them only as defects. A defect text that names the start of
            // its search is the same evidence as a new failure, so the first load makes it a fact. Each later save
            // writes `noRoutes`, so this runs once and an operator resume stays cleared.
            for (const d of this.defects.values()) {
                const searched = d.outcomeKind === 'worker_defect' && d.detail ? parseNoRoute(d.detail) : null;
                if (!searched) continue;
                const key = d.account.toLowerCase();
                const fact: NoRouteFact = { ...searched, activityId: d.activityId, observedAt: d.observedAt, expiresAt: d.observedAt + NO_ROUTE_TTL_MS };
                this.noRoutes.set(key, addNoRoute(this.noRoutes.get(key) ?? [], fact));
            }
        }
    }

    save(now = Date.now()): void {
        writeJsonAtomic(this.filePath, this.snapshotState(now));
    }

    private saveIfEnabled(now: number): void {
        if (this.persist) this.save(now);
    }

    private pruneAccountOverlay(account: string, now: number): AccountOutcomeOverlay {
        const key = account.toLowerCase();
        const current = this.accountOverlays.get(key) ?? { holds: [], cooldowns: {} };
        const holds = pruneExpiredHolds(current.holds, now);
        const cooldowns = pruneExpiredCooldowns(current.cooldowns, now);
        let lifecycleOverride = current.lifecycleOverride;
        let lifecycleExpiresAt = current.lifecycleExpiresAt;
        if (lifecycleOverride && lifecycleOverride !== 'dead' && lifecycleOverride !== 'paused_owner') {
            if (lifecycleExpiresAt !== undefined && now >= lifecycleExpiresAt) {
                lifecycleOverride = undefined;
                lifecycleExpiresAt = undefined;
            }
        }
        const cleaned: AccountOutcomeOverlay = {
            ...(lifecycleOverride ? { lifecycleOverride } : {}),
            ...(lifecycleExpiresAt !== undefined ? { lifecycleExpiresAt } : {}),
            holds,
            cooldowns,
        };
        if (!cleaned.lifecycleOverride && cleaned.holds.length === 0 && Object.keys(cleaned.cooldowns).length === 0) {
            this.accountOverlays.delete(key);
        } else {
            this.accountOverlays.set(key, cleaned);
        }
        return cleaned;
    }

    private upsertDefect(params: {
        readonly activityId: string;
        readonly faultSignature: string;
        readonly outcomeKind: 'worker_defect' | 'death';
        readonly account: string;
        readonly now: number;
        readonly workerRelease?: string;
        readonly logPath?: string;
        readonly tickRecordPath?: string;
        readonly detail?: string;
        readonly deathLevels?: DeathLevels;
        // A repeat fault sets its count from its distinct accounts, not from the worker-defect escalation.
        readonly count?: number;
        readonly ttlMs?: number;
        readonly workerEntries?: readonly string[];
    }): DefectRecord {
        const key = defectKey(params.activityId, params.faultSignature);
        const existing = this.defects.get(key);
        // The count says how often the signature failed during one hold. A hold that expired or was cleared ends that
        // count: a later failure is a first defect again, and it holds only its own account (planner.ts isFleetWideDefect).
        const holding = existing?.quarantined === true && (existing.expiresAt === undefined || params.now < existing.expiresAt);
        const logPath =
            nonEmpty(params.logPath) ??
            existing?.logPath ??
            `.practice/live/defects/${params.account}/${params.activityId}.log`;
        const detail = nonEmpty(params.detail) ?? existing?.detail ?? params.faultSignature;
        const tickRecordPath = nonEmpty(params.tickRecordPath) ?? existing?.tickRecordPath;
        const workerRelease = nonEmpty(params.workerRelease) ?? existing?.workerRelease;
        const workerEntries = params.workerEntries?.length ? [...params.workerEntries] : existing?.workerEntries;
        const idSlug = params.faultSignature.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'defect';

        const next: DefectRecord = {
            id: existing?.id ?? `defect:${params.activityId}:${idSlug}`,
            activityId: params.activityId,
            faultSignature: params.faultSignature,
            outcomeKind: params.outcomeKind,
            account: params.account,
            observedAt: params.now,
            quarantinedAt: params.now,
            expiresAt: params.now + (params.ttlMs ?? (params.deathLevels ? Math.max(this.defaultDefectTtlMs, DEATH_CLASS_TTL_MS) : this.defaultDefectTtlMs)),
            quarantined: true,
            ...(workerRelease ? { workerRelease } : {}),
            ...(workerEntries ? { workerEntries } : {}),
            logPath,
            ...(tickRecordPath ? { tickRecordPath } : {}),
            detail,
            count: params.count ?? (holding ? existing?.count ?? 0 : 0) + 1,
            ...(params.deathLevels ? { deathLevels: weakerDeathLevels(params.deathLevels, holding ? existing?.deathLevels : undefined) } : {}),
        };

        const errors = validateDefectRecord(next);
        if (errors.length > 0) {
            throw new Error(`Invalid DefectRecord: ${errors.join('; ')}`);
        }
        this.defects.set(key, next);
        return next;
    }

    // Counts a fast run that ended with a REPEAT_KINDS outcome, and returns the defect that the count reaches: the
    // activity for this account at REPEAT_ACCOUNT_RUNS runs, for every account at REPEAT_FLEET_ACCOUNTS accounts.
    private noteRepeatFault(outcome: RunOutcome, now: number, workerRelease?: string, workerEntries?: readonly string[]): DefectRecord | undefined {
        if (!REPEAT_KINDS.has(outcome.kind) || outcome.durationMs === undefined || outcome.durationMs >= REPEAT_FAST_MS) return undefined;
        // A missing_supply outcome keeps no detail: its summary is the supervisor end ("gave-up after 1 runs"), which
        // names no cause. Its missing item ids name the fault. The inferred coins row with no name says nothing.
        let fault: string | undefined;
        if (outcome.kind === 'missing_supply') {
            const ids = [...new Set(outcome.missing.filter(m => !(m.itemId === 995 && m.itemName === undefined)).map(m => m.itemId))].sort((a, b) => a - b);
            fault = ids.length ? `missing ${ids.join(',')}` : undefined;
        } else if (outcome.kind === 'location_stranded' && nonEmpty(outcome.detail) && !isGateHeldResult(outcome.detail!)) {
            fault = normalizeFaultSignature(outcome.detail!);
        }
        if (!fault) return undefined;
        const faultSignature = `repeat ${outcome.kind}: ${fault}`;
        const key = defectKey(outcome.activityId, faultSignature);
        const faults = [...(this.repeatFaults.get(key) ?? []).filter(f => now - f.at < REPEAT_WINDOW_MS), { account: outcome.account, at: now }];
        this.repeatFaults.set(key, faults);
        const lower = outcome.account.toLowerCase();
        const own = faults.filter(f => f.account.toLowerCase() === lower).length;
        const accounts = new Set(faults.map(f => f.account.toLowerCase())).size;
        const fleet = accounts >= REPEAT_FLEET_ACCOUNTS;
        if (own < REPEAT_ACCOUNT_RUNS && !fleet) return undefined;
        // The distinct accounts set the scope. An account hold is its own record (its account in the signature), so a
        // second account's hold neither raises the count of the first to fleet-wide nor replaces its account.
        return this.upsertDefect({
            activityId: outcome.activityId,
            faultSignature: fleet ? faultSignature : `${faultSignature} [${lower}]`,
            outcomeKind: 'worker_defect',
            account: outcome.account,
            now,
            workerRelease,
            detail: `${outcome.summary ?? outcome.kind}: ${fault} (${faults.length} fast runs, ${accounts} accounts in ${REPEAT_WINDOW_MS / 3_600_000} h)`,
            // planner.ts FLEET_QUARANTINE_MIN_COUNT (2) holds the activity for every account; 1 holds only its account.
            count: fleet ? 2 : 1,
            ttlMs: REPEAT_DEFECT_TTL_MS,
            ...(workerEntries?.length ? { workerEntries } : {}),
        });
    }

    // Lifts each repeat-fault hold whose worker code changed: the release of its entry files (releaseOf, swarm.ts
    // cachedReleaseFor) is not the release of the runs that failed. A merged fix then runs at the next plan cycle, not
    // after the 6 h hold. A hold without a release or entries, or entries that do not resolve, keeps its time limit.
    // The release includes shared runtime files, so a change can be unrelated to the fault. The lift is one probe, as
    // a held swarm end runs once more after its release changes (#1567): the fault count stays, so the first fast run
    // that fails the same way on the new release holds the activity again at once, bound to that release. Only a run
    // that meets its target clears the count.
    liftChangedReleaseHolds(releaseOf: (entries: readonly string[]) => string | undefined, now = Date.now()): DefectRecord[] {
        const lifted: DefectRecord[] = [];
        for (const [key, d] of this.defects) {
            if (!d.quarantined || !d.faultSignature.startsWith('repeat ') || !d.workerRelease || !d.workerEntries?.length) continue;
            if (d.expiresAt !== undefined && now >= d.expiresAt) continue;
            let release: string | undefined;
            try { release = releaseOf(d.workerEntries); } catch { release = undefined; }
            if (!release || release === d.workerRelease) continue;
            const next = { ...d, quarantined: false };
            this.defects.set(key, next);
            lifted.push(next);
        }
        if (lifted.length) this.saveIfEnabled(now);
        return lifted;
    }

    private buildRateSample(
        outcome: RunOutcome,
        now: number,
        domain: 'practice' | 'live',
        died: boolean,
    ): RateSample | undefined {
        if (outcome.ticksElapsed <= 0) return undefined;
        let totalXp = 0;
        if (outcome.xpGained) {
            for (const xp of Object.values(outcome.xpGained)) {
                if (typeof xp === 'number' && Number.isFinite(xp) && xp >= 0) totalXp += xp;
            }
        }
        const unitsCompleted =
            typeof outcome.unitsCompleted === 'number' && Number.isFinite(outcome.unitsCompleted) && outcome.unitsCompleted >= 0
                ? outcome.unitsCompleted
                : 0;
        const gp = typeof outcome.coinsDelta === 'number' && Number.isFinite(outcome.coinsDelta) ? outcome.coinsDelta : 0;

        const sample: RateSample = {
            activityId: outcome.activityId,
            account: outcome.account,
            domain,
            observedAt: now,
            ticksElapsed: outcome.ticksElapsed,
            unitsCompleted,
            xpPerTick: totalXp / outcome.ticksElapsed,
            unitsPerTick: unitsCompleted / outcome.ticksElapsed,
            gpPerTick: gp / outcome.ticksElapsed,
            ...(died ? { died: true } : {}),
        };
        if (validateRateSample(sample).length > 0) return undefined;
        return sample;
    }

    classifyAndApplyRaw(
        input: RawWorkerExitInput,
        ctx?: {
            readonly now?: number;
            readonly domain?: 'practice' | 'live';
            readonly accountState?: AccountState;
            readonly workerRelease?: string;
            readonly workerEntries?: readonly string[];
            readonly skipRateSample?: boolean;
        },
    ): OutcomeClassificationResult {
        const outcome = classifyRawWorkerExit(input);
        const text = [input.detail, input.error, input.reason, input.summary, input.stdout]
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .join('\n');
        // The fact refuses work only while the account stands where the search started (no-route.ts), so it takes
        // the place of a defect only when the run ended there. Otherwise the defect holds the activity as before.
        const searched = parseNoRoute(text, input.pos);
        const noRoute = searched && input.pos && standsAt(input.pos, searched.from) ? searched : undefined;
        return this.applyOutcome(outcome, {
            ...ctx,
            ...(input.skipRateSample || ctx?.skipRateSample ? { skipRateSample: true } : {}),
            ...(noRoute ? { noRoute } : {}),
            ...(input.deathLevels ? { deathLevels: input.deathLevels } : {}),
        });
    }

    applyOutcome(
        outcome: RunOutcome,
        ctx?: {
            readonly now?: number;
            readonly domain?: 'practice' | 'live';
            readonly accountState?: AccountState;
            readonly workerRelease?: string;
            readonly workerEntries?: readonly string[];
            readonly skipRateSample?: boolean;
            // The "no route" in the run's failure text and where that search started (no-route.ts parseNoRoute).
            readonly noRoute?: { readonly from: WorkerTile; readonly to: WorkerTile };
            readonly deathLevels?: DeathLevels;
        },
    ): OutcomeClassificationResult {
        const errors = validateRunOutcome(outcome);
        if (errors.length > 0) {
            throw new Error(`Invalid RunOutcome: ${errors.join('; ')}`);
        }

        const now = ctx?.now ?? Date.now();
        const domain = ctx?.domain ?? 'live';
        this.marketCooldowns = pruneExpiredCooldowns(this.marketCooldowns, now);
        // A run that started after the breaker opened and ended for a reason other than infrastructure got past the
        // claim and the server again, so the fault run is over. A run that started before the fault proves nothing:
        // it can end after the retry time without a new claim. An outcome without its duration does not reset.
        const runStart = outcome.durationMs !== undefined ? now - outcome.durationMs : undefined;
        if (
            outcome.kind !== 'infra_fault'
            && this.infraBreaker.consecutiveFaults > 0
            && (!this.infraBreaker.open || now >= (this.infraBreaker.retryAt ?? now))
            && runStart !== undefined && runStart >= (this.infraBreaker.trippedAt ?? 0)
        ) {
            this.recordInfraSuccess(now);
        }

        switch (outcome.kind) {
            case 'target_met': {
                // A run that met its target shows the repeat faults of the activity are gone.
                const prefix = `${outcome.activityId}::`;
                for (const key of [...this.repeatFaults.keys()]) if (key.startsWith(prefix)) this.repeatFaults.delete(key);
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const isDead = overlay.lifecycleOverride === 'dead';
                const remainingHolds = overlay.holds.filter(
                    (h) => h.key !== 'location_stranded' && h.key !== 'session_unsettled',
                );
                const nextOverlay: AccountOutcomeOverlay = {
                    ...(isDead ? { lifecycleOverride: 'dead' } : {}),
                    holds: remainingHolds,
                    cooldowns: overlay.cooldowns,
                };
                if (!nextOverlay.lifecycleOverride && remainingHolds.length === 0 && Object.keys(overlay.cooldowns).length === 0) {
                    this.accountOverlays.delete(outcome.account.toLowerCase());
                } else {
                    this.accountOverlays.set(outcome.account.toLowerCase(), nextOverlay);
                }

                let recordedRateSample: RateSample | undefined;
                if (this.rateStore && ctx?.skipRateSample !== true) {
                    const candidate = this.buildRateSample(outcome, now, domain, false);
                    if (candidate) {
                        recordedRateSample = this.rateStore.recordSample(candidate);
                    }
                }
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    ...(recordedRateSample ? { recordedRateSample } : {}),
                    accountLifecycle: isDead ? 'dead' : 'idle',
                    accountPenalized: false,
                    unlockFollowUp: true,
                    clearedTransientRecovery: true,
                    summary: outcome.summary ?? `${outcome.activityId} target_met`,
                };
            }

            case 'missing_supply': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const repeat = this.noteRepeatFault(outcome, now, ctx?.workerRelease, ctx?.workerEntries);
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    missingSupplies: outcome.missing,
                    ...(repeat ? { defect: repeat } : {}),
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: repeat
                        ? `quarantined ${outcome.activityId} (${repeat.faultSignature})`
                        : outcome.summary ?? `${outcome.activityId} missing_supply (${outcome.missing.length} item(s))`,
                };
            }

            case 'location_stranded': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const hold = createExpiringHold({
                    kind: 'maintenance',
                    key: 'location_stranded',
                    reason: nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? 'account stranded outside safe hub',
                    now,
                    ttlMs: this.defaultRecoveryHoldTtlMs,
                });
                const isDead = overlay.lifecycleOverride === 'dead';
                const lifecycle: AccountLifecycle = isDead ? 'dead' : 'needs_location_recovery';
                const nextOverlay: AccountOutcomeOverlay = {
                    lifecycleOverride: lifecycle,
                    ...(isDead ? {} : { lifecycleExpiresAt: hold.expiresAt }),
                    holds: [...overlay.holds.filter((h) => h.key !== 'location_stranded'), hold],
                    cooldowns: overlay.cooldowns,
                };
                this.accountOverlays.set(outcome.account.toLowerCase(), nextOverlay);
                const repeat = this.noteRepeatFault(outcome, now, ctx?.workerRelease, ctx?.workerEntries);
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: lifecycle,
                    addedHold: hold,
                    ...(repeat ? { defect: repeat } : {}),
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'market_unavailable': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const ttlMs = outcome.cooldownMs ?? Math.max(this.defaultMarketCooldownMs, shopRestockCooldownMs(outcome.itemId, outcome.venue));
                const key = marketCooldownKey(outcome.itemId, outcome.venue);
                this.marketCooldowns = setCooldown(this.marketCooldowns, key, now, ttlMs);
                const accountCooldowns = setCooldown(overlay.cooldowns, key, now, ttlMs);
                const hold = createExpiringHold({
                    kind: 'market_unavailable',
                    key,
                    reason: nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? `market unavailable for ${key}`,
                    now,
                    ttlMs,
                });
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    ...(overlay.lifecycleOverride ? { lifecycleOverride: overlay.lifecycleOverride } : {}),
                    ...(overlay.lifecycleExpiresAt !== undefined ? { lifecycleExpiresAt: overlay.lifecycleExpiresAt } : {}),
                    holds: [...overlay.holds.filter((h) => h.key !== key), hold],
                    cooldowns: accountCooldowns,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    addedHold: hold,
                    addedCooldownKey: key,
                    cooldownExpiresAt: now + ttlMs,
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'session_unsettled': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                const hold = createExpiringHold({
                    kind: 'retry_backoff',
                    key: 'session_unsettled',
                    reason: nonEmpty(outcome.reason) ?? nonEmpty(outcome.detail) ?? 'session unsettled / missing logout proof',
                    now,
                    ttlMs: this.defaultRecoveryHoldTtlMs,
                });
                const isDead = overlay.lifecycleOverride === 'dead';
                const lifecycle: AccountLifecycle = isDead ? 'dead' : 'needs_logout_recovery';
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    lifecycleOverride: lifecycle,
                    ...(isDead ? {} : { lifecycleExpiresAt: hold.expiresAt }),
                    holds: [...overlay.holds.filter((h) => h.key !== 'session_unsettled'), hold],
                    cooldowns: overlay.cooldowns,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: lifecycle,
                    addedHold: hold,
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: hold.reason,
                };
            }

            case 'infra_fault': {
                // Runs that fail while the breaker waits are the same fault, not a failed retry: they keep the
                // wait and do not make it longer.
                const prior = this.infraBreaker;
                const sameFault = prior.open && prior.retryAt !== undefined && now < prior.retryAt;
                const nextFaults = sameFault ? Math.max(1, prior.consecutiveFaults) : prior.consecutiveFaults + 1;
                const expMs = Math.min(
                    this.infraMaxBackoffMs,
                    Math.round(this.infraBaseBackoffMs * Math.pow(this.infraBackoffFactor, nextFaults - 1)),
                );
                const waitMs = Math.max(expMs, outcome.retryAfterMs ?? 0);
                const reason = nonEmpty(outcome.detail) ?? nonEmpty(outcome.summary) ?? `infra fault (${outcome.source})`;
                this.infraBreaker = {
                    open: true,
                    trippedAt: sameFault && prior.trippedAt !== undefined ? prior.trippedAt : now,
                    retryAt: sameFault ? Math.max(prior.retryAt!, now + (outcome.retryAfterMs ?? 0)) : now + waitMs,
                    consecutiveFaults: nextFaults,
                    reason: `${outcome.source}: ${reason}`,
                };
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    infraBreaker: { ...this.infraBreaker },
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: this.infraBreaker.reason ?? reason,
                };
            }

            case 'worker_defect': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                // A route search that found no route for this account is a fact about where the account stands, not a
                // fault of the worker. As a defect it would hold the activity for every account at its second count.
                const searched = ctx?.noRoute;
                if (searched) {
                    const key = outcome.account.toLowerCase();
                    const noRoute: NoRouteFact = { ...searched, activityId: outcome.activityId, observedAt: now, expiresAt: now + NO_ROUTE_TTL_MS };
                    this.noRoutes.set(key, addNoRoute((this.noRoutes.get(key) ?? []).filter(f => now < f.expiresAt), noRoute));
                    this.saveIfEnabled(now);
                    return {
                        outcome,
                        account: outcome.account,
                        activityId: outcome.activityId,
                        accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                        noRoute,
                        accountPenalized: false,
                        unlockFollowUp: false,
                        clearedTransientRecovery: false,
                        summary: noRouteMessage(outcome.account, noRoute),
                    };
                }
                const defect = this.upsertDefect({
                    activityId: outcome.activityId,
                    faultSignature: outcome.faultSignature,
                    outcomeKind: 'worker_defect',
                    account: outcome.account,
                    now,
                    workerRelease: ctx?.workerRelease,
                    logPath: outcome.logPath,
                    tickRecordPath: outcome.tickRecordPath,
                    detail: outcome.detail ?? outcome.summary,
                });
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    accountLifecycle: overlay.lifecycleOverride === 'dead' ? 'dead' : 'idle',
                    defect,
                    accountPenalized: false,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: `quarantined ${outcome.activityId} (${outcome.faultSignature})`,
                };
            }

            case 'death': {
                const overlay = this.pruneAccountOverlay(outcome.account, now);
                this.accountOverlays.set(outcome.account.toLowerCase(), {
                    lifecycleOverride: 'dead',
                    holds: overlay.holds,
                    cooldowns: overlay.cooldowns,
                });
                const faultSignature = nonEmpty(outcome.faultSignature) ?? 'death';
                const defect = this.upsertDefect({
                    activityId: outcome.activityId,
                    faultSignature,
                    outcomeKind: 'death',
                    account: outcome.account,
                    now,
                    workerRelease: ctx?.workerRelease,
                    logPath: outcome.logPath,
                    tickRecordPath: outcome.tickRecordPath,
                    detail: outcome.detail ?? outcome.summary ?? `${outcome.account} died in ${outcome.activityId}`,
                    ...(ctx?.deathLevels ? { deathLevels: ctx.deathLevels } : {}),
                });

                let recordedRateSample: RateSample | undefined;
                if (this.rateStore && ctx?.skipRateSample !== true) {
                    const candidate = this.buildRateSample(outcome, now, domain, true);
                    if (candidate) {
                        recordedRateSample = this.rateStore.recordSample(candidate);
                    }
                }
                this.saveIfEnabled(now);
                return {
                    outcome,
                    account: outcome.account,
                    activityId: outcome.activityId,
                    ...(recordedRateSample ? { recordedRateSample } : {}),
                    accountLifecycle: 'dead',
                    defect,
                    accountPenalized: true,
                    unlockFollowUp: false,
                    clearedTransientRecovery: false,
                    summary: defect.detail,
                };
            }
        }
    }

    isQuarantined(activityId: string, now = Date.now()): boolean {
        for (const [key, d] of this.defects.entries()) {
            if (!d.quarantined || d.activityId !== activityId) continue;
            if (d.expiresAt !== undefined && now >= d.expiresAt) {
                this.defects.set(key, { ...d, quarantined: false });
                continue;
            }
            return true;
        }
        return false;
    }

    quarantinedDefects(now = Date.now()): DefectRecord[] {
        const out: DefectRecord[] = [];
        for (const [key, d] of this.defects.entries()) {
            if (!d.quarantined) continue;
            if (d.expiresAt !== undefined && now >= d.expiresAt) {
                this.defects.set(key, { ...d, quarantined: false });
                continue;
            }
            out.push(d);
        }
        out.sort((a, b) => b.observedAt - a.observedAt);
        return out;
    }

    clearDefect(params: {
        readonly defectId?: string;
        readonly activityId: string;
        readonly faultSignature?: string;
    }): number {
        let cleared = 0;
        for (const [key, d] of this.defects.entries()) {
            if (!d.quarantined) continue;
            if (d.activityId !== params.activityId) continue;
            if (params.defectId !== undefined && d.id !== params.defectId) continue;
            if (params.faultSignature !== undefined && d.faultSignature !== params.faultSignature) continue;
            this.defects.set(key, { ...d, quarantined: false });
            cleared += 1;
        }
        if (cleared > 0) this.saveIfEnabled(Date.now());
        return cleared;
    }

    canProceedInfra(now = Date.now()): {
        readonly allowed: boolean;
        readonly waitMs: number;
        readonly state: InfraCircuitBreakerState;
    } {
        if (!this.infraBreaker.open) {
            return { allowed: true, waitMs: 0, state: { ...this.infraBreaker } };
        }
        const retryAt = this.infraBreaker.retryAt ?? now;
        if (now >= retryAt) {
            return { allowed: true, waitMs: 0, state: { ...this.infraBreaker } };
        }
        return {
            allowed: false,
            waitMs: retryAt - now,
            state: { ...this.infraBreaker },
        };
    }

    recordInfraSuccess(now = Date.now()): void {
        this.infraBreaker = { open: false, consecutiveFaults: 0 };
        this.saveIfEnabled(now);
    }

    activeMarketCooldowns(now = Date.now()): Record<string, number> {
        this.marketCooldowns = pruneExpiredCooldowns(this.marketCooldowns, now);
        return { ...this.marketCooldowns };
    }

    // The facts that still hold for the account. A fact ends when it expires, when the account leaves the start of
    // its search (unless the search started at its target, no-route.ts atTarget), or when the account's levels, quests
    // or items change (noRouteState): then a new search decides.
    // A fact without a state takes the account's state of its first snapshot, which is still the state of the run.
    private holdingNoRoutes(acct: AccountState, now: number): readonly NoRouteFact[] | undefined {
        const key = acct.name.toLowerCase();
        const facts = this.noRoutes.get(key);
        if (!facts) return acct.noRoutes;
        const state = noRouteState(acct);
        const kept = facts
            .filter(f => (acct.pos === null || atTarget(f) ? now < f.expiresAt : noRouteHolds(f, acct.pos, now)) && (f.state === undefined || f.state === state))
            .map(f => (f.state === undefined ? { ...f, state } : f));
        const changed = kept.length < facts.length || kept.some((f, i) => f !== facts[i]);
        if (kept.length === 0) this.noRoutes.delete(key);
        else this.noRoutes.set(key, kept);
        if (changed) this.saveIfEnabled(now);
        return kept.length > 0 ? kept : undefined;
    }

    private applyToAccountInternal(acct: AccountState, now: number, validate: boolean): AccountState {
        const key = acct.name.toLowerCase();
        const noRoutes = this.holdingNoRoutes(acct, now);
        if (noRoutes !== acct.noRoutes) {
            const { noRoutes: _old, ...without } = acct;
            acct = noRoutes ? { ...without, noRoutes } : without;
        }
        // An account that cannot leave where it stands takes no job elsewhere: it needs location recovery. At a hub
        // bank the recovery walk (to the nearest hub) ends where it starts, so the facts would hold and the recovery
        // would repeat; there the account stays idle and noRouteTo refuses the places it cannot reach.
        if (acct.lifecycle === 'idle' && enclosedAt(noRoutes, acct.pos, now)
            && !Object.values(HUB_BANKER_LOCATIONS).some(h => standsAt(acct.pos, h.bankTile))) {
            acct = { ...acct, lifecycle: 'needs_location_recovery' };
        }
        const hasOverlay = this.accountOverlays.has(key);
        if (!hasOverlay) {
            const hasActiveJobMismatch = acct.activeJob !== undefined && acct.lifecycle !== 'running';
            let hasExpiredCooldown = false;
            if (acct.cooldowns) {
                for (const exp of Object.values(acct.cooldowns)) {
                    if (now >= exp) {
                        hasExpiredCooldown = true;
                        break;
                    }
                }
            }
            let hasExpiredHold = false;
            if (acct.systemHolds && acct.systemHolds.length > 0) {
                for (const h of acct.systemHolds) {
                    if (!isHoldActive(h, now)) {
                        hasExpiredHold = true;
                        break;
                    }
                }
            }
            if (!hasActiveJobMismatch && !hasExpiredCooldown && !hasExpiredHold) {
                if (validate) {
                    const errors = validateAccountState(acct);
                    if (errors.length > 0) {
                        throw new Error(`OutcomeClassifier.applyToAccount produced invalid AccountState for ${acct.name}: ${errors.join('; ')}`);
                    }
                }
                return acct;
            }
        }
        const overlay = this.pruneAccountOverlay(acct.name, now);
        const mergedCooldowns = {
            ...pruneExpiredCooldowns(acct.cooldowns, now),
            ...overlay.cooldowns,
        };
        const baseHolds = pruneExpiredHolds(acct.systemHolds ?? [], now);
        const holdMap = new Map<string, SystemHold>();
        for (const h of baseHolds) {
            if (isHoldActive(h, now)) holdMap.set(`${h.kind}:${h.key}`, h);
        }
        for (const h of overlay.holds) {
            if (isHoldActive(h, now)) holdMap.set(`${h.kind}:${h.key}`, h);
        }
        const mergedHolds = [...holdMap.values()];

        let nextLifecycle: AccountLifecycle = acct.lifecycle;
        if (acct.lifecycle !== 'paused_owner' && acct.lifecycle !== 'reserved') {
            if (overlay.lifecycleOverride === 'dead') {
                nextLifecycle = 'dead';
            } else if (acct.lifecycle !== 'dead' && overlay.lifecycleOverride) {
                if (overlay.lifecycleOverride === 'needs_logout_recovery') {
                    nextLifecycle = 'needs_logout_recovery';
                } else if (
                    overlay.lifecycleOverride === 'needs_location_recovery' &&
                    acct.lifecycle !== 'needs_logout_recovery'
                ) {
                    nextLifecycle = 'needs_location_recovery';
                }
            }
        }

        const { activeJob, ...rest } = acct;
        const updated: AccountState = {
            ...rest,
            lifecycle: nextLifecycle,
            ...(nextLifecycle === 'running' && activeJob ? { activeJob } : {}),
            ...(Object.keys(mergedCooldowns).length > 0 ? { cooldowns: mergedCooldowns } : { cooldowns: undefined }),
            ...(mergedHolds.length > 0 ? { systemHolds: mergedHolds } : { systemHolds: undefined }),
        };
        if (validate) {
            const errors = validateAccountState(updated);
            if (errors.length > 0) {
                throw new Error(`OutcomeClassifier.applyToAccount produced invalid AccountState for ${acct.name}: ${errors.join('; ')}`);
            }
        }
        return updated;
    }

    applyToAccount(acct: AccountState, now = Date.now()): AccountState {
        return this.applyToAccountInternal(acct, now, true);
    }

    applyToSnapshot(snapshot: WorldSnapshot, now = Date.now()): WorldSnapshot {
        const nextAccounts: Record<string, AccountState> = {};
        for (const [name, acct] of Object.entries(snapshot.accounts)) {
            nextAccounts[name] = this.applyToAccountInternal(acct, now, false);
        }
        const mergedMarketCooldowns = {
            ...pruneExpiredCooldowns(snapshot.marketCooldowns, now),
            ...this.activeMarketCooldowns(now),
        };
        const nextSnapshot: WorldSnapshot = {
            ...snapshot,
            accounts: nextAccounts,
            ...(Object.keys(mergedMarketCooldowns).length > 0 ? { marketCooldowns: mergedMarketCooldowns } : {}),
        };
        const errors = validateWorldSnapshot(nextSnapshot);
        if (errors.length > 0) {
            throw new Error(`OutcomeClassifier.applyToSnapshot produced invalid WorldSnapshot: ${errors.join('; ')}`);
        }
        return nextSnapshot;
    }

    applyOperatorCommand(cmd: OperatorCommand, now = Date.now()): boolean {
        switch (cmd.kind) {
            case 'clear_defect': {
                const count = this.clearDefect({
                    defectId: cmd.defectId,
                    activityId: cmd.activityId,
                    faultSignature: cmd.faultSignature,
                });
                return count > 0;
            }
            case 'resume_account': {
                const acctKey = cmd.account.toLowerCase();
                const overlay = this.accountOverlays.get(acctKey);
                if (overlay?.lifecycleOverride === 'dead' && cmd.clearDead !== true) {
                    return false;
                }
                const hadNoRoutes = this.noRoutes.delete(acctKey);
                if (!overlay) {
                    if (hadNoRoutes) this.saveIfEnabled(now);
                    return hadNoRoutes;
                }
                const nextHolds = overlay.holds.filter(
                    (h) => h.key !== 'location_stranded' && h.key !== 'session_unsettled',
                );
                if (nextHolds.length === 0 && Object.keys(overlay.cooldowns).length === 0) {
                    this.accountOverlays.delete(acctKey);
                } else {
                    this.accountOverlays.set(acctKey, {
                        holds: nextHolds,
                        cooldowns: overlay.cooldowns,
                    });
                }
                this.saveIfEnabled(now);
                return true;
            }
            default:
                return false;
        }
    }

    snapshotState(now = Date.now()): OutcomeClassifierState {
        const marketCooldowns = this.activeMarketCooldowns(now);
        const overlays: Record<string, AccountOutcomeOverlay> = {};
        for (const account of [...this.accountOverlays.keys()]) {
            const cleaned = this.pruneAccountOverlay(account, now);
            if (
                cleaned.lifecycleOverride ||
                cleaned.holds.length > 0 ||
                Object.keys(cleaned.cooldowns).length > 0
            ) {
                overlays[account] = cleaned;
            }
        }
        const noRoutes: Record<string, NoRouteFact[]> = {};
        for (const [account, facts] of this.noRoutes) {
            const kept = facts.filter(f => now < f.expiresAt);
            if (kept.length > 0) noRoutes[account] = kept;
        }
        const repeatFaults: Record<string, RepeatFault[]> = {};
        for (const [key, faults] of this.repeatFaults) {
            const kept = faults.filter(f => now - f.at < REPEAT_WINDOW_MS);
            if (kept.length > 0) repeatFaults[key] = kept;
        }
        return {
            schemaVersion: OUTCOME_STATE_SCHEMA_VERSION,
            updatedAt: now,
            infraBreaker: { ...this.infraBreaker },
            marketCooldowns,
            defects: [...this.defects.values()],
            accountOverlays: overlays,
            noRoutes,
            repeatFaults,
        };
    }
}
