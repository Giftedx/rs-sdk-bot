// RateStore combines ActivityCatalog baseline rates with persisted live/practice RateSample observations.
// Overrides modeled rates automatically once sample count and tick thresholds accumulate.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { liveRoot, repoRoot } from '../../core/src/practice-paths';
import {
    validateRateEstimate,
    type RateEstimate,
    type RateEstimateConfidence,
    type WorkerAccountView,
    type WorkerWorldView,
} from '../../workers/src/contracts';
import type { ActivityCatalog } from './catalog';
import {
    validateRateSample,
    type AccountState,
    type RateSample,
    type RateSummary,
    type WorldSnapshot,
} from './contracts';

export const DEFAULT_MIN_SAMPLES_TO_OVERRIDE = 3;
export const DEFAULT_MIN_TICKS_TO_OVERRIDE = 300;
export const DEFAULT_MAX_SAMPLES_PER_ACTIVITY = 50;
export const RATE_STORE_SCHEMA_VERSION = 1 as const;

export interface RateStoreOptions {
    readonly catalog: ActivityCatalog;
    readonly root?: string;
    readonly filePath?: string;
    readonly minSamplesToOverride?: number;
    readonly minTicksToOverride?: number;
    readonly maxSamplesPerActivity?: number;
    readonly persist?: boolean;
}

interface PersistedRateStore {
    readonly schemaVersion: typeof RATE_STORE_SCHEMA_VERSION;
    readonly updatedAt: number;
    readonly samples: Record<string, RateSample[]>;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
}

export class RateStore {
    readonly catalog: ActivityCatalog;
    readonly filePath: string;
    private readonly minSamplesToOverride: number;
    private readonly minTicksToOverride: number;
    private readonly maxSamplesPerActivity: number;
    private readonly persist: boolean;
    private readonly store = new Map<string, RateSample[]>();

    constructor(opts: RateStoreOptions) {
        this.catalog = opts.catalog;
        const root = opts.root ?? repoRoot;
        this.filePath = opts.filePath ?? join(liveRoot(root), 'rate-store.json');
        this.minSamplesToOverride = Math.max(1, opts.minSamplesToOverride ?? DEFAULT_MIN_SAMPLES_TO_OVERRIDE);
        this.minTicksToOverride = Math.max(1, opts.minTicksToOverride ?? DEFAULT_MIN_TICKS_TO_OVERRIDE);
        this.maxSamplesPerActivity = Math.max(1, opts.maxSamplesPerActivity ?? DEFAULT_MAX_SAMPLES_PER_ACTIVITY);
        this.persist = opts.persist ?? (opts.filePath !== undefined || opts.root !== undefined);
        if (this.persist && existsSync(this.filePath)) {
            this.load();
        }
    }

    load(): void {
        this.store.clear();
        if (!existsSync(this.filePath)) return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
        } catch {
            return;
        }
        if (!isPlainRecord(parsed) || !isPlainRecord(parsed.samples)) return;
        for (const [activityId, list] of Object.entries(parsed.samples)) {
            if (!Array.isArray(list)) continue;
            const valid: RateSample[] = [];
            for (const item of list) {
                if (validateRateSample(item).length === 0 && item.activityId === activityId) {
                    valid.push(item);
                }
            }
            if (valid.length > 0) {
                const trimmed = valid.slice(-this.maxSamplesPerActivity);
                this.store.set(activityId, trimmed);
            }
        }
    }

    save(): void {
        const serialized: Record<string, RateSample[]> = {};
        for (const [activityId, list] of this.store.entries()) {
            if (list.length > 0) {
                serialized[activityId] = list.slice(-this.maxSamplesPerActivity);
            }
        }
        const payload: PersistedRateStore = {
            schemaVersion: RATE_STORE_SCHEMA_VERSION,
            updatedAt: Date.now(),
            samples: serialized,
        };
        writeJsonAtomic(this.filePath, payload);
    }

    recordSample(sample: RateSample, opts?: { readonly save?: boolean }): RateSample {
        const errors = validateRateSample(sample);
        if (errors.length > 0) {
            throw new Error(`Invalid RateSample: ${errors.join('; ')}`);
        }
        const existing = this.store.get(sample.activityId) ?? [];
        const next = [...existing, sample];
        if (next.length > this.maxSamplesPerActivity) {
            next.splice(0, next.length - this.maxSamplesPerActivity);
        }
        this.store.set(sample.activityId, next);
        if (opts?.save ?? this.persist) {
            this.save();
        }
        return sample;
    }

    samples(activityId?: string): readonly RateSample[] {
        if (activityId !== undefined) {
            return [...(this.store.get(activityId) ?? [])];
        }
        const all: RateSample[] = [];
        for (const list of this.store.values()) {
            all.push(...list);
        }
        all.sort((a, b) => a.observedAt - b.observedAt);
        return all;
    }

    private effectiveSamples(activityId: string): readonly RateSample[] {
        const list = this.store.get(activityId) ?? [];
        const alive = list.filter((s) => s.died !== true);
        return alive.length > 0 ? alive : list;
    }

    hasOverride(activityId: string): boolean {
        const list = this.effectiveSamples(activityId);
        if (list.length < this.minSamplesToOverride) return false;
        let totalTicks = 0;
        for (const s of list) totalTicks += s.ticksElapsed;
        return totalTicks >= this.minTicksToOverride;
    }

    estimate(
        activityId: string,
        acct?: WorkerAccountView | AccountState,
        _world?: WorkerWorldView | WorldSnapshot,
    ): RateEstimate {
        const def = this.catalog.require(activityId);
        const base = def.baselineRate;
        const allSamples = this.store.get(activityId) ?? [];
        const list = this.effectiveSamples(activityId);

        let xpPerTick = base.xpPerTick;
        let unitsPerTick = base.unitsPerTick;
        let gpPerTick = base.gpPerTick;
        let setupTicks = base.setupTicks;
        let confidence: RateEstimateConfidence = base.confidence;
        let riskPerHour = base.riskPerHour;
        let skillXpPerTick = base.skillXpPerTick ? { ...base.skillXpPerTick } : undefined;

        if (this.hasOverride(activityId)) {
            let totalTicks = 0;
            let liveTicks = 0;
            let xpSum = 0;
            let unitsSum = 0;
            let gpSum = 0;
            let setupWeighted = 0;
            let setupTicksWeight = 0;

            for (const s of list) {
                totalTicks += s.ticksElapsed;
                if (s.domain === 'live') liveTicks += s.ticksElapsed;
                xpSum += s.xpPerTick * s.ticksElapsed;
                unitsSum += s.unitsPerTick * s.ticksElapsed;
                gpSum += s.gpPerTick * s.ticksElapsed;
                if (typeof s.setupTicks === 'number' && Number.isFinite(s.setupTicks) && s.setupTicks >= 0) {
                    setupWeighted += s.setupTicks * s.ticksElapsed;
                    setupTicksWeight += s.ticksElapsed;
                }
            }

            if (totalTicks > 0) {
                xpPerTick = xpSum / totalTicks;
                unitsPerTick = unitsSum / totalTicks;
                gpPerTick = gpSum / totalTicks;
                if (setupTicksWeight > 0) {
                    setupTicks = Math.max(0, Math.round(setupWeighted / setupTicksWeight));
                }
                confidence = liveTicks > 0 ? 'live' : 'practice';
            }

            if (skillXpPerTick && base.xpPerTick > 0) {
                const ratio = xpPerTick / base.xpPerTick;
                const scaled: Record<string, number> = {};
                for (const [k, v] of Object.entries(skillXpPerTick)) {
                    scaled[k] = v * ratio;
                }
                skillXpPerTick = scaled;
            } else if (def.skill && xpPerTick > 0) {
                skillXpPerTick = { [def.skill]: xpPerTick };
            }
        }

        if (allSamples.length > 0) {
            const deaths = allSamples.filter((s) => s.died === true).length;
            const totalTicksAll = allSamples.reduce((acc, s) => acc + s.ticksElapsed, 0);
            if (deaths > 0 && totalTicksAll > 0) {
                const hours = (totalTicksAll * 0.4) / 3600;
                riskPerHour = Math.min(1, 1 - Math.exp(-deaths / Math.max(hours, 1 / 60)));
            }
        }

        const est: RateEstimate = {
            xpPerTick,
            ...(skillXpPerTick ? { skillXpPerTick } : {}),
            unitsPerTick,
            gpPerTick,
            setupTicks,
            minBatchUnits: base.minBatchUnits,
            ...(riskPerHour !== undefined ? { riskPerHour } : {}),
            confidence,
            ...(base.outputsPerUnit ? { outputsPerUnit: base.outputsPerUnit } : {}),
            ...(base.inputsPerUnit ? { inputsPerUnit: base.inputsPerUnit } : {}),
        };
        const errors = validateRateEstimate(est);
        if (errors.length > 0) {
            throw new Error(`Invalid computed RateEstimate for ${activityId}: ${errors.join('; ')}`);
        }
        return est;
    }

    summaryFor(activityId: string): RateSummary | undefined {
        const list = this.store.get(activityId);
        if (!list || list.length === 0) return undefined;
        const effective = this.effectiveSamples(activityId);
        let totalTicks = 0;
        let xpSum = 0;
        let unitsSum = 0;
        let gpSum = 0;
        for (const s of effective) {
            totalTicks += s.ticksElapsed;
            xpSum += s.xpPerTick * s.ticksElapsed;
            unitsSum += s.unitsPerTick * s.ticksElapsed;
            gpSum += s.gpPerTick * s.ticksElapsed;
        }
        return {
            samples: list.length,
            xpPerTick: totalTicks > 0 ? xpSum / totalTicks : 0,
            unitsPerTick: totalTicks > 0 ? unitsSum / totalTicks : 0,
            gpPerTick: totalTicks > 0 ? gpSum / totalTicks : 0,
        };
    }

    summary(): Record<string, RateSummary> {
        const out: Record<string, RateSummary> = {};
        for (const activityId of this.store.keys()) {
            const item = this.summaryFor(activityId);
            if (item) out[activityId] = item;
        }
        return out;
    }
}

export function createRateStore(opts: RateStoreOptions): RateStore {
    return new RateStore(opts);
}
