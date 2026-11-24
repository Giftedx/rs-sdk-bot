// Earliest-deadline-first scheduler with dead-tick guest absorption, route selection, and Moore-Hodgson optimization.
import { levelForXp, xpForLevel } from '../curve';
import { ANYWHERE, BANK, bankTrips, resolve, type TravelModel } from '../travel';
import { qpSpecialistActivities } from './boards';
import {
    MAX_QP, SKILLS, XP99, applyLevers, chooseVariants, pick, rawRoute, roughTicks, speed, variantGroups,
    type Activity, type Board, type BoardId, type BoardResult, type Placed, type ScheduleOptions,
    type ScheduleResult, type Skill,
} from './model';
import { bestHaggisLeg, legCacheFor, type HaggisLegCache } from './travel';

// At most this many combinations are searched exhaustively; above it, coordinate descent per group.
const ROUTE_EXHAUSTIVE_MAX = 64;
const SKILL_INDEX = new Map<Skill, number>(SKILLS.map((s, i) => [s, i]));
const XP_CURVE = Array.from({ length: 100 }, (_, i) => xpForLevel(i));

interface SkillXpEvent { start: number; end: number; lump: boolean; amount: number }

// Route score, smaller is better: when Overall is sacrificed (specialist schedules or bestSet without Overall),
// minimize the active unsacrificed clock boards first; otherwise Overall finish first, then minus slack sum, then raw ticks.
function routeScore(r: ScheduleResult, boardById: ReadonlyMap<BoardId, Board>, raw: number, sacrificed?: ReadonlySet<BoardId>): number[] {
    const overall = r.overallFinish ?? Infinity;
    const isClock = (id: BoardId) => boardById.get(id)?.rule.kind === 'clock';
    if (sacrificed?.has('overall')) {
        const active = r.boards.filter(b => !sacrificed.has(b.id) && b.id !== 'overall' && isClock(b.id));
        if (active.length === 0 && !sacrificed.has('questpoints')) {
            const qpFinish = r.boards.find(b => b.id === 'questpoints')?.finish ?? Infinity;
            return [qpFinish, r.blocked.length, overall, raw];
        }
        const activeFinish = active.reduce((m, b) => Math.max(m, b.finish ?? Infinity), 0);
        const activeSlack = active.reduce((s, b) => s + (b.slack ?? -1_000_000), 0);
        return [activeFinish, -activeSlack, overall, raw];
    }
    let slack = 0;
    for (const b of r.boards) {
        if (isClock(b.id) && b.slack !== null) slack += b.slack;
    }
    return [overall, -slack, raw];
}
const better = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!; return false; };

function chooseRouteCore(
    boards: Board[],
    activities: Activity[],
    opts: ScheduleOptions,
    prerequisiteFirst = false,
    legCache?: HaggisLegCache,
): { route: Record<string, string>; evaluated: number; result?: ScheduleResult } {
    const leverApplied = applyLevers(activities, opts);
    const groups = variantGroups(leverApplied, opts);
    const start = rawRoute(groups, opts);
    const multi = [...groups].filter(([, o]) => o.size > 1).map(([g, o]) => ({ group: g, options: [...o.keys()] }));
    if (multi.length === 0) return { route: start, evaluated: 0 };
    const boardById = new Map(boards.map(b => [b.id, b]));
    const cache = legCache ?? legCacheFor(opts.travel);
    let fixedRawCost = 0;
    const groupOptionCosts = new Map<string, Map<string, number>>();
    for (const [g, o] of groups) {
        if (o.size <= 1) {
            const only = o.values().next().value as Activity[] | undefined;
            if (only) {
                for (const a of only) fixedRawCost += roughTicks(a, opts);
            }
        } else {
            const m = new Map<string, number>();
            for (const [optName, acts] of o) {
                let c = 0;
                for (const a of acts) c += roughTicks(a, opts);
                m.set(optName, c);
            }
            groupOptionCosts.set(g, m);
        }
    }
    let evaluated = 0;
    const raw = (route: Record<string, string>) => {
        let sum = fixedRawCost;
        for (const g of multi) {
            sum += groupOptionCosts.get(g.group)!.get(route[g.group]!)!;
        }
        return sum;
    };
    const seen = new Map<string, { score: number[]; result: ScheduleResult }>();
    const routeKey = (route: Record<string, string>) => {
        let k = '';
        for (let i = 0; i < multi.length; i++) {
            if (i > 0) k += '\0';
            k += route[multi[i]!.group]!;
        }
        return k;
    };
    const score = (route: Record<string, string>): { score: number[]; result: ScheduleResult } => {
        const key = routeKey(route);
        const cached = seen.get(key);
        if (cached) return cached;
        evaluated++;
        const nextOpts: ScheduleOptions = { ...opts, force: { ...opts.force, ...route } };
        const result = scheduleRoute(boards, leverApplied, nextOpts, prerequisiteFirst, cache, true);
        const entry = { score: routeScore(result, boardById, raw(route), opts.sacrificed), result };
        seen.set(key, entry);
        return entry;
    };
    let best = start;
    const first = score(start);
    let bestScore = first.score;
    let bestResult = first.result;
    const combos = multi.reduce((n, g) => n * g.options.length, 1);
    if (combos <= ROUTE_EXHAUSTIVE_MAX) {
        for (let i = 0; i < combos; i++) {
            const route = { ...start };
            let k = i;
            for (const g of multi) { route[g.group] = g.options[k % g.options.length]!; k = Math.floor(k / g.options.length); }
            if (multi.every(g => route[g.group] === best[g.group])) continue;
            const entry = score(route);
            if (better(entry.score, bestScore)) { best = route; bestScore = entry.score; bestResult = entry.result; }
        }
        return { route: best, evaluated, result: bestResult };
    }
    // Greedy: change one group at a time while that improves the score; repeat the pass until nothing changes.
    for (let pass = 0, changed = true; changed && pass < 10; pass++) {
        changed = false;
        for (const g of multi) for (const option of g.options) {
            if (best[g.group] === option) continue;
            const route = { ...best, [g.group]: option };
            const entry = score(route);
            if (better(entry.score, bestScore)) { best = route; bestScore = entry.score; bestResult = entry.result; changed = true; }
        }
    }
    return { route: best, evaluated, result: bestResult };
}

// The variant combination with the earliest Overall finish for opts.mode (see routeScore). Deterministic: groups and
// options in table order, a candidate replaces the best only when strictly better.
export function chooseRoute(
    boards: Board[],
    activities: Activity[],
    opts: ScheduleOptions,
    prerequisiteFirst = false,
    legCache?: HaggisLegCache,
): { route: Record<string, string>; evaluated: number } {
    const { route, evaluated } = chooseRouteCore(boards, activities, opts, prerequisiteFirst, legCache);
    return { route, evaluated };
}

function xpAtSkill(skillEvents: readonly SkillXpEvent[], start: number, t: number): number {
    let xp = start;
    for (let i = 0; i < skillEvents.length; i++) {
        const e = skillEvents[i]!;
        const v = e.amount;
        if (e.lump || e.end <= e.start) { if (t >= e.end) xp += v; }
        else if (t >= e.end) xp += v;
        else if (t > e.start) xp += (v * (t - e.start)) / (e.end - e.start);
    }
    return xp;
}

// First integer tick at which `skill` has at least `target` XP, or null.
function crossing(skillEvents: readonly SkillXpEvent[], start: number, target: number, horizon: number): number | null {
    if (start >= target) return 0;
    if (xpAtSkill(skillEvents, start, horizon) < target - 1e-6) return null;
    let lo = 0, hi = horizon;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (xpAtSkill(skillEvents, start, mid) >= target - 1e-6) hi = mid; else lo = mid + 1;
    }
    return lo;
}

function boardDeadline(b: Board, sacrificed: ReadonlySet<BoardId>, overallDeadline: number): number {
    if (b.rule.kind === 'clock') return sacrificed.has(b.id) && b.id !== 'overall' ? overallDeadline : b.rule.deadline;
    if (b.rule.kind === 'qp' && !sacrificed.has(b.id)) {
        return Number.isFinite(overallDeadline) ? Math.max(overallDeadline + 1, b.rule.leaderTicks) : b.rule.leaderTicks;
    }
    return Infinity; // value boards have no clock deadline
}

// Schedule with the route of opts.route (default: the earliest Overall finish, chooseRoute).
export function schedule(boards: Board[], allActivities: Activity[], opts: ScheduleOptions, legCache?: HaggisLegCache): ScheduleResult {
    const cache = legCache ?? legCacheFor(opts.travel);
    if (opts.route === 'ticks') return scheduleRoute(boards, allActivities, opts, false, cache);
    const choice = chooseRouteCore(boards, allActivities, opts, false, cache);
    return choice.result ?? scheduleRoute(boards, allActivities, { ...opts, force: { ...opts.force, ...choice.route } }, false, cache);
}

// Candidate from the deadline search in research/haggis-run.md. Relaxed deadlines
// affect placement only. The result still scores each board against its record.
const OVERALL_RELAXED_DEADLINES: ReadonlySet<BoardId> = new Set([
    'crafting', 'herblore', 'hitpoints', 'magic', 'runecraft', 'smithing', 'woodcutting',
]);
// Travel comparison in research/haggis-run.md, with prerequisite-first ties.
const OVERALL_TRAVEL_DEADLINES: ReadonlySet<BoardId> = new Set([
    'cooking', 'crafting', 'fishing', 'fletching', 'herblore', 'hitpoints', 'magic', 'prayer', 'smithing', 'thieving',
]);

export function scheduleOverall(boards: Board[], activities: Activity[], opts: ScheduleOptions): ScheduleResult {
    const cache = legCacheFor(opts.travel);
    const baseline = schedule(boards, activities, opts, cache);
    if (opts.sacrificed !== undefined) return baseline;
    const relaxed = schedule(boards, activities, { ...opts, sacrificed: OVERALL_RELAXED_DEADLINES }, cache);
    const finish = (plan: ScheduleResult) => plan.overallFinish ?? Infinity;
    const useRelaxed = finish(relaxed) < finish(baseline);
    let best = useRelaxed ? relaxed : baseline;
    if (!opts.travel) return best;
    const candidates: ScheduleResult[] = [best];
    const travelOpts = { ...opts, sacrificed: OVERALL_TRAVEL_DEADLINES };
    const travelChoice = chooseRouteCore(boards, activities, travelOpts, true, cache);
    const travelChosen = travelChoice.route;
    const routeKey = (m: Record<string, string>) => Object.keys(m).sort().map(k => `${k}=${m[k]}`).join('\0');
    const seen = new Set<string>();
    const pushIfNew = (routeMap: Record<string, string>, dlSet: ReadonlySet<BoardId> | undefined, precomputed?: ScheduleResult) => {
        const key = `${dlSet === OVERALL_TRAVEL_DEADLINES ? 'T' : dlSet === OVERALL_RELAXED_DEADLINES ? 'R' : 'D'}|${routeKey(routeMap)}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (precomputed) { candidates.push(precomputed); return; }
        const fixed = { ...opts, force: { ...opts.force, ...routeMap } };
        candidates.push(scheduleRoute(boards, activities, { ...fixed, sacrificed: dlSet }, true, cache));
    };
    pushIfNew(best.route, useRelaxed ? OVERALL_RELAXED_DEADLINES : undefined);
    pushIfNew(best.route, OVERALL_TRAVEL_DEADLINES);
    pushIfNew(travelChosen, OVERALL_TRAVEL_DEADLINES, travelChoice.result);
    for (const c of candidates) if (finish(c) < finish(best)) best = c;
    return best;
}

/** Schedules a dedicated 145-QP specialist (sacrificing skill 99s and Overall to beat #1 stunquestv3). */
export function scheduleQpSpecialist(boards: Board[], activities: Activity[], opts: ScheduleOptions): ScheduleResult {
    const sacrificed = new Set<BoardId>(boards.filter(b => b.id !== 'questpoints').map(b => b.id));
    return schedule(boards, qpSpecialistActivities(activities), { ...opts, sacrificed }, legCacheFor(opts.travel));
}

// Schedule with opts.force where given and the raw-tick choice for the other variant groups.
function scheduleRoute(
    boards: Board[],
    allActivities: Activity[],
    opts: ScheduleOptions,
    prerequisiteFirst = false,
    legCache?: HaggisLegCache,
    leversAlreadyApplied = false,
): ScheduleResult {
    const sacrificed = opts.sacrificed ?? new Set<BoardId>();
    const chosen = chooseVariants(allActivities, opts, leversAlreadyApplied);
    const hasTouristTrapAgility = chosen.some(a => a.id === 'tourist-trap-agility');
    const sacDefence = sacrificed.has('defence');
    const sacFletching = sacrificed.has('fletching') && !opts.disable?.has('stun-guests');
    const activities = chosen.map(a => {
        let next = a;
        if (sacDefence && next.id === 'agility-52' && next.requires?.includes('def-top')) {
            next = { ...next, requires: next.requires.filter(r => r !== 'def-top') };
        }
        if (sacFletching && next.id === 'fletch' && !next.inside) {
            next = { ...next, inside: 'thieve' };
        }
        if (hasTouristTrapAgility && (next.id === 'agility-25' || next.id === 'grandtree')) {
            next = { ...next, serves: next.serves.filter(s => s !== 'agility') };
        }
        return next;
    });

    const n = activities.length;
    const idToIdx = new Map<string, number>();
    const activityById = new Map<string, Activity>();
    const trainersBySkill: number[][] = Array.from({ length: SKILLS.length }, () => []);
    for (let i = 0; i < n; i++) {
        const a = activities[i]!;
        idToIdx.set(a.id, i);
        activityById.set(a.id, a);
        if (a.inside === undefined && a.train) {
            const sIdx = SKILL_INDEX.get(a.train.skill);
            if (sIdx !== undefined) trainersBySkill[sIdx]!.push(i);
        }
    }

    const insideIdx = new Int32Array(n).fill(-1);
    const reqIdx: number[][] = new Array(n);
    const minLevels: { skill: number; level: number; minXp: number }[][] = new Array(n);
    const xpEntries: { skill: number; amount: number | 'to99' }[][] = new Array(n);
    const trainMeta: ({ skill: number; targetXp: number; rate: number; side: { skill: number; k: number }[] } | null)[] = new Array(n);
    const ticksArr = new Float64Array(n);
    const bgArr = new Float64Array(n);
    const deadArr = new Float64Array(n);
    const speedArr = new Float64Array(n);
    const dependants = new Int32Array(n);
    const mode = opts.mode;

    for (let i = 0; i < n; i++) {
        const a = activities[i]!;
        if (a.inside !== undefined) {
            const h = idToIdx.get(a.inside);
            if (h !== undefined) insideIdx[i] = h;
        }
        const reqs: number[] = [];
        if (a.requires) {
            const seenReq = prerequisiteFirst ? new Set<number>() : undefined;
            for (let j = 0; j < a.requires.length; j++) {
                const idx = idToIdx.get(a.requires[j]!);
                if (idx === undefined) continue;
                reqs.push(idx);
                if (seenReq && !seenReq.has(idx)) {
                    seenReq.add(idx);
                    dependants[idx]!++;
                }
            }
        }
        reqIdx[i] = reqs;

        const mls: { skill: number; level: number; minXp: number }[] = [];
        if (a.minLevel) {
            for (const s in a.minLevel) {
                const lvl = a.minLevel[s as Skill];
                const sIdx = SKILL_INDEX.get(s as Skill);
                if (lvl !== undefined && sIdx !== undefined) {
                    const minXp = lvl <= 1 ? 0 : lvl > 99 ? Infinity : XP_CURVE[lvl]!;
                    mls.push({ skill: sIdx, level: lvl, minXp });
                }
            }
        }
        minLevels[i] = mls;

        const xps: { skill: number; amount: number | 'to99' }[] = [];
        if (a.xp) {
            for (const s in a.xp) {
                const v = a.xp[s as Skill];
                const sIdx = SKILL_INDEX.get(s as Skill);
                if (v !== undefined && sIdx !== undefined) xps.push({ skill: sIdx, amount: v });
            }
        }
        xpEntries[i] = xps;

        if (a.train) {
            const side: { skill: number; k: number }[] = [];
            if (a.train.side) {
                for (const s in a.train.side) {
                    const k = a.train.side[s as Skill];
                    const sIdx = SKILL_INDEX.get(s as Skill);
                    if (k !== undefined && sIdx !== undefined) side.push({ skill: sIdx, k });
                }
            }
            trainMeta[i] = {
                skill: SKILL_INDEX.get(a.train.skill)!,
                targetXp: XP_CURVE[Math.min(a.train.toLevel, 99)] ?? xpForLevel(a.train.toLevel),
                rate: pick(a.train.xpPerTick, mode),
                side,
            };
        } else {
            trainMeta[i] = null;
        }

        ticksArr[i] = a.ticks ? pick(a.ticks, mode) : 0;
        bgArr[i] = a.background ? pick(a.background, mode) : -1;
        deadArr[i] = a.deadTicks ? pick(a.deadTicks, mode) : 0;
        speedArr[i] = speed(a, opts);
    }

    const overall = boards.find(b => b.id === 'overall');
    const overallDeadline = overall && overall.rule.kind === 'clock' ? overall.rule.deadline : Infinity;
    const dl = new Map<BoardId, number>(boards.map(b => [b.id, boardDeadline(b, sacrificed, overallDeadline)]));

    // Effective deadline: own (earliest served board) propagated back through prerequisites and required skill trainers.
    const eff = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const serves = activities[i]!.serves;
        let minDl = Infinity;
        for (let j = 0; j < serves.length; j++) {
            const d = dl.get(serves[j]!) ?? Infinity;
            if (d < minDl) minDl = d;
        }
        eff[i] = minDl;
    }
    for (let changed = true; changed;) {
        changed = false;
        for (let i = 0; i < n; i++) {
            const aEff = eff[i]!;
            const reqs = reqIdx[i]!;
            for (let j = 0; j < reqs.length; j++) {
                const r = reqs[j]!;
                if (aEff < eff[r]!) { eff[r] = aEff; changed = true; }
            }
            const mls = minLevels[i]!;
            for (let j = 0; j < mls.length; j++) {
                const ml = mls[j]!;
                const trainers = trainersBySkill[ml.skill]!;
                for (let k = 0; k < trainers.length; k++) {
                    const p = trainers[k]!;
                    if (activities[p]!.train!.toLevel > ml.level) continue;
                    if (aEff < eff[p]!) { eff[p] = aEff; changed = true; }
                }
            }
        }
    }

    const hp10 = xpForLevel(10);
    const startXpArr = new Float64Array(SKILLS.length);
    for (let s = 0; s < SKILLS.length; s++) {
        const sk = SKILLS[s]!;
        startXpArr[s] = opts.startXp?.[sk] ?? (sk === 'hitpoints' ? hp10 : 0);
    }
    const eventsBySkill: SkillXpEvent[][] = Array.from({ length: SKILLS.length }, () => []);
    const settledXp = new Float64Array(startXpArr);
    const settledIdx = new Int32Array(SKILLS.length);
    const cachedXp = new Float64Array(startXpArr);
    const cachedXpClock = new Float64Array(SKILLS.length).fill(-1);
    const cachedLevel = new Int32Array(SKILLS.length);
    const cachedLevelClock = new Float64Array(SKILLS.length).fill(-1);

    const pushSkillEvent = (sIdx: number, start: number, end: number, lump: boolean, amount: number) => {
        if (!amount) return;
        eventsBySkill[sIdx]!.push({ start, end, lump, amount });
        cachedXpClock[sIdx] = -1;
        cachedLevelClock[sIdx] = -1;
    };

    const xpAtClock = (sIdx: number, t: number): number => {
        if (cachedXpClock[sIdx] === t) return cachedXp[sIdx]!;
        const evs = eventsBySkill[sIdx]!;
        let idx = settledIdx[sIdx]!;
        let base = settledXp[sIdx]!;
        while (idx < evs.length && evs[idx]!.end <= t) {
            base += evs[idx]!.amount;
            idx++;
        }
        settledIdx[sIdx] = idx;
        settledXp[sIdx] = base;
        let xp = base;
        for (let i = idx; i < evs.length; i++) {
            const e = evs[i]!;
            const v = e.amount;
            if (e.lump || e.end <= e.start) { if (t >= e.end) xp += v; }
            else if (t >= e.end) xp += v;
            else if (t > e.start) xp += (v * (t - e.start)) / (e.end - e.start);
        }
        cachedXp[sIdx] = xp;
        cachedXpClock[sIdx] = t;
        return xp;
    };

    const levelAtClock = (sIdx: number, t: number): number => {
        if (cachedLevelClock[sIdx] === t) return cachedLevel[sIdx]!;
        const lvl = levelForXp(xpAtClock(sIdx, t));
        cachedLevel[sIdx] = lvl;
        cachedLevelClock[sIdx] = t;
        return lvl;
    };

    const doneAt = new Float64Array(n).fill(-1);
    const placed = new Uint8Array(n);
    const order: Placed[] = [];
    const qpEvents: { at: number; qp: number }[] = [];
    let settledQp = 0;
    let settledQpIdx = 0;
    let cachedQp = 0;
    let cachedQpClock = -1;
    const qpAtClock = (t: number): number => {
        if (cachedQpClock === t) return cachedQp;
        while (settledQpIdx < qpEvents.length && qpEvents[settledQpIdx]!.at <= t) {
            settledQp += qpEvents[settledQpIdx]!.qp;
            settledQpIdx++;
        }
        let sum = settledQp;
        for (let i = settledQpIdx; i < qpEvents.length; i++) {
            if (qpEvents[i]!.at <= t) sum += qpEvents[i]!.qp;
        }
        cachedQp = sum;
        cachedQpClock = t;
        return sum;
    };
    const qpAtFull = (t: number) => {
        let sum = 0;
        for (let i = 0; i < qpEvents.length; i++) {
            if (qpEvents[i]!.at <= t) sum += qpEvents[i]!.qp;
        }
        return sum;
    };

    let remaining = n;
    let clock = 0;
    let idle = 0;
    const blocked: string[] = [];

    let here: string | undefined;
    let travelTotal = 0;
    const disableTeleports = !!opts.disable?.has('magic-teleports');
    const cache = legCache ?? legCacheFor(opts.travel);
    const bestLeg = (m: TravelModel, from: string, to: string, magicLvl: number) =>
        bestHaggisLeg(m, from, to, magicLvl, doneAtMap, disableTeleports, cache);
    // Keep doneAtMap synced only for the 4 quest keys bestHaggisLeg reads ('plague-city', 'trade-start', 'tree', 'grandtree').
    const doneAtMap = new Map<string, number>();
    const markDone = (idx: number, at: number) => {
        doneAt[idx] = at;
        placed[idx] = 1;
        const id = activities[idx]!.id;
        if (id === 'plague-city' || id === 'trade-start' || id === 'tree' || id === 'grandtree') {
            doneAtMap.set(id, at);
        }
    };

    const move = (idx: number): { walk: number; inner: number; from?: string; to?: string; method?: string } => {
        const m = opts.travel;
        const a = activities[idx]!;
        if (!m || a.at === undefined || a.at === ANYWHERE) return { walk: 0, inner: 0 };
        if (here === undefined) {
            if (m.start) here = m.start;
            else if (a.at === BANK) return { walk: 0, inner: 0 };
            else here = a.at;
        }
        if (here === BANK) return { walk: 0, inner: 0 };
        const from = here;
        const to = resolve(m, here, a.at);
        const magicLvl = levelAtClock(6 /* magic */, clock);
        const l = bestLeg(m, from, to, magicLvl);
        let inner = 0;
        let cur = to;
        for (const v of a.via ?? []) { inner += bestLeg(m, cur, v, magicLvl).ticks; cur = v; }
        if (a.bankTrips) inner += bankTrips(m, to, a.bankTrips).ticks;
        here = a.endAt ?? cur;
        return { walk: l.ticks, inner, from, to, method: l.method };
    };

    const canStartClock = (idx: number, t: number): boolean => {
        const reqs = reqIdx[idx]!;
        for (let j = 0; j < reqs.length; j++) {
            const d = doneAt[reqs[j]!]!;
            if (d < 0 || d > t) return false;
        }
        const mls = minLevels[idx]!;
        for (let j = 0; j < mls.length; j++) {
            const ml = mls[j]!;
            if (levelAtClock(ml.skill, t) < ml.level) return false;
        }
        const minQp = activities[idx]!.minQp;
        if (minQp !== undefined && qpAtClock(t) < minQp) return false;
        return true;
    };

    const canStartGuest = (idx: number, t: number, extra: Float64Array, absorbed: readonly number[]): boolean => {
        const reqs = reqIdx[idx]!;
        for (let j = 0; j < reqs.length; j++) {
            const r = reqs[j]!;
            const d = doneAt[r]!;
            if (d >= 0 && d <= t) continue;
            let found = false;
            for (let k = 0; k < absorbed.length; k++) if (absorbed[k] === r) { found = true; break; }
            if (!found) return false;
        }
        const mls = minLevels[idx]!;
        for (let j = 0; j < mls.length; j++) {
            const ml = mls[j]!;
            if (levelForXp(xpAtClock(ml.skill, t) + extra[ml.skill]!) < ml.level) return false;
        }
        const minQp = activities[idx]!.minQp;
        if (minQp !== undefined && qpAtClock(t) < minQp) return false;
        return true;
    };

    const costAt = (idx: number, start: number, extra?: Float64Array) => {
        let fg = ticksArr[idx]!;
        const xps: { skill: number; v: number }[] = [];
        const addXp = (sIdx: number, amount: number) => {
            for (let k = 0; k < xps.length; k++) {
                if (xps[k]!.skill === sIdx) { xps[k]!.v += amount; return; }
            }
            xps.push({ skill: sIdx, v: amount });
        };
        const tr = trainMeta[idx];
        if (tr) {
            const base = xpAtClock(tr.skill, start) + (extra ? extra[tr.skill]! : 0);
            const need = Math.max(0, tr.targetXp - base);
            if (need > 0) {
                fg += Math.ceil(need / tr.rate);
                addXp(tr.skill, need);
                for (let k = 0; k < tr.side.length; k++) {
                    const sd = tr.side[k]!;
                    addXp(sd.skill, need * sd.k);
                }
            }
        }
        const rawXps = xpEntries[idx]!;
        for (let k = 0; k < rawXps.length; k++) {
            const entry = rawXps[k]!;
            const amount = entry.amount === 'to99'
                ? Math.max(0, XP99 - (xpAtClock(entry.skill, start) + (extra ? extra[entry.skill]! : 0)))
                : entry.amount;
            addXp(entry.skill, amount);
        }
        return { fg, xps };
    };

    const walkCostStamp = new Int32Array(n);
    const walkCostVal = new Float64Array(n);
    let stepEpoch = 0;
    const magicIdx = SKILL_INDEX.get('magic')!;

    while (remaining > 0) {
        stepEpoch++;
        let bestI = -1;
        let readyCount = 0;
        let magicLvlCache = -1;
        const travelM = opts.travel;
        const canTieWalk = !!(travelM && here);
        const getWalkCost = (idx: number): number => {
            if (walkCostStamp[idx] === stepEpoch) return walkCostVal[idx]!;
            walkCostStamp[idx] = stepEpoch;
            const at = activities[idx]!.at;
            let val = 0;
            if (at !== undefined && at !== ANYWHERE) {
                if (magicLvlCache < 0) magicLvlCache = levelAtClock(magicIdx, clock);
                const to = resolve(travelM!, here!, at);
                val = bestLeg(travelM!, here!, to, magicLvlCache).ticks;
            }
            walkCostVal[idx] = val;
            return val;
        };

        for (let i = 0; i < n; i++) {
            if (placed[i]) continue;
            const host = insideIdx[i]!;
            if (host >= 0 && !placed[host]) continue;
            if (!canStartClock(i, clock)) continue;
            readyCount++;
            if (bestI < 0) {
                bestI = i;
                continue;
            }
            const ei = eff[i]!, eb = eff[bestI]!;
            if (ei !== eb) {
                if (ei < eb) bestI = i;
                continue;
            }
            if (prerequisiteFirst) {
                const di = dependants[i]!, db = dependants[bestI]!;
                if (di !== db) {
                    if (di > db) bestI = i;
                    continue;
                }
            }
            if (canTieWalk && (prerequisiteFirst || ei > overallDeadline)) {
                const wi = getWalkCost(i), wb = getWalkCost(bestI);
                if (wi < wb) bestI = i;
            }
        }

        if (readyCount === 0) {
            let nextFuture = Infinity;
            for (let i = 0; i < n; i++) {
                const d = doneAt[i]!;
                if (d > clock && d < nextFuture) nextFuture = d;
            }
            if (nextFuture < Infinity) { idle += nextFuture - clock; clock = nextFuture; continue; }
            for (let i = 0; i < n; i++) if (!placed[i]) blocked.push(activities[i]!.id);
            break;
        }

        const idx = bestI;
        const a = activities[idx]!;
        remaining--;

        // A train row with nothing left to do (an earlier lump reached its level) does not walk.
        const mv = trainMeta[idx] && costAt(idx, clock).fg === 0 ? { walk: 0, inner: 0 } as ReturnType<typeof move> : move(idx);
        clock += mv.walk;
        travelTotal += mv.walk + mv.inner;
        const start = clock;
        const c = costAt(idx, start);
        let fg = c.fg + mv.inner;

        // Guests that can start with the host (including chained guests unlocked by earlier fully-absorbed guests).
        let cap = deadArr[idx]!;
        const guests: number[] = [];
        const guestCosts: { fg: number; xps: { skill: number; v: number }[] }[] = [];
        const extraXp = new Float64Array(SKILLS.length);
        let usedCap = 0;
        let absorbable = 0;
        for (let added = true; added;) {
            added = false;
            for (let g = 0; g < n; g++) {
                if (placed[g] || insideIdx[g] !== idx) continue;
                let already = false;
                for (let k = 0; k < guests.length; k++) if (guests[k] === g) { already = true; break; }
                if (already || !canStartGuest(g, start, extraXp, guests)) continue;
                const gc = costAt(g, start, extraXp);
                guests.push(g);
                guestCosts.push(gc);
                absorbable += gc.fg;
                if (usedCap + gc.fg <= cap) {
                    usedCap += gc.fg;
                    for (let k = 0; k < gc.xps.length; k++) {
                        const x = gc.xps[k]!;
                        extraXp[x.skill] = extraXp[x.skill]! + x.v;
                    }
                }
                added = true;
            }
        }
        // A speedup trick (stun relog) removes the dead ticks. Use it only if it saves more than the guests absorb.
        const sp = speedArr[idx]!;
        if (sp < 1 && guests.length > 0 && Math.min(cap, absorbable) > fg * (1 - sp)) { /* keep the stuns for guests */ }
        else { fg = Math.ceil(fg * sp); if (sp < 1) cap = 0; }
        const end = start + fg;
        const bg = bgArr[idx]!;
        const landsAt = end + (bg >= 0 ? bg : 0);
        if (bg >= 0) {
            for (let k = 0; k < c.xps.length; k++) pushSkillEvent(c.xps[k]!.skill, landsAt, landsAt, true, c.xps[k]!.v);
        } else {
            const lump = a.lump ?? false;
            for (let k = 0; k < c.xps.length; k++) pushSkillEvent(c.xps[k]!.skill, start, end, lump, c.xps[k]!.v);
        }
        if (a.qp) { qpEvents.push({ at: landsAt, qp: a.qp }); cachedQpClock = -1; }
        markDone(idx, landsAt);
        order.push({ id: a.id, label: a.label, start, end, landsAt, ticks: fg, deadline: eff[idx]!, ...(mv.walk || mv.inner ? { travel: mv.walk, from: mv.from, to: mv.to, method: mv.method, inner: mv.inner } : {}) });
        clock = end;

        for (let gi = 0; gi < guests.length; gi++) {
            const gIdx = guests[gi]!;
            const g = activities[gIdx]!;
            const gc = guestCosts[gi]!;
            const absorbed = Math.min(gc.fg, cap);
            cap -= absorbed;
            const rest = gc.fg - absorbed;
            const share = gc.fg > 0 ? absorbed / gc.fg : 1;
            const gLump = g.lump ?? false;
            if (share > 0) {
                for (let k = 0; k < gc.xps.length; k++) {
                    const x = gc.xps[k]!;
                    pushSkillEvent(x.skill, start, end, gLump, x.v * share);
                }
            }
            if (rest > 0) {
                for (let k = 0; k < gc.xps.length; k++) {
                    const x = gc.xps[k]!;
                    pushSkillEvent(x.skill, clock, clock + rest, gLump, x.v * (1 - share));
                }
            }
            const gStart = absorbed > 0 ? start : clock;
            const gEnd = rest > 0 ? clock + rest : end;
            if (g.qp) { qpEvents.push({ at: gEnd, qp: g.qp }); cachedQpClock = -1; }
            markDone(gIdx, gEnd);
            remaining--;
            order.push({ id: g.id, label: `${g.label} (inside ${a.id}: ${absorbed} ticks absorbed)`, start: gStart, end: gEnd, landsAt: gEnd, ticks: rest, deadline: eff[gIdx]! });
            clock += rest;
        }
    }

    let endTick = clock;
    for (let i = 0; i < n; i++) {
        const d = doneAt[i]!;
        if (d > endTick) endTick = d;
    }
    const horizon = endTick + 1;
    const skillFinishArr: (number | null)[] = new Array(SKILLS.length);
    const skillFinishMap = new Map<Skill, number | null>();
    for (let s = 0; s < SKILLS.length; s++) {
        const fin = crossing(eventsBySkill[s]!, startXpArr[s]!, XP99, horizon);
        skillFinishArr[s] = fin;
        skillFinishMap.set(SKILLS[s]!, fin);
    }
    const qp = qpAtFull(horizon);
    let overallFinish: number | null = 0;
    let lastSkill: Skill | null = null;
    for (let s = 0; s < SKILLS.length; s++) {
        const v = skillFinishArr[s]!;
        if (v === null) { overallFinish = null; break; }
        if (v >= overallFinish!) { overallFinish = v; lastSkill = SKILLS[s]!; }
    }
    if (overallFinish === null) lastSkill = null;

    let sortedQp: { at: number; qp: number }[] | undefined;
    const results: BoardResult[] = boards.map(b => {
        const sac = sacrificed.has(b.id);
        if (b.rule.kind === 'clock') {
            const finish = b.id === 'overall' ? overallFinish : (skillFinishMap.get(b.id as Skill) ?? null);
            const deadline = b.rule.deadline;
            const slack = finish === null ? null : deadline - finish;
            const status = finish === null ? 'NEVER' : slack! > 0 ? 'WIN' : slack === 0 ? 'TIE' : 'LATE';
            return { id: b.id, label: b.label, deadline, finish, slack, status, sacrificed: sac };
        }
        if (b.rule.kind === 'qp') {
            const { leaderPoints, leaderTicks } = b.rule;
            const maxPoints = b.rule.maxPoints ?? MAX_QP;
            sortedQp ??= [...qpEvents].sort((x, y) => x.at - y.at);
            const reach = (pt: number) => { let s = 0; for (const x of sortedQp!) { s += x.qp; if (s >= pt) return x.at; } return null; };
            // Secure: every point the content has, before the leader's playtime. A tie at maxPoints goes to the earlier stamp.
            const full = reach(maxPoints);
            if (full !== null && full < leaderTicks) return { id: b.id, label: b.label, deadline: leaderTicks, finish: full, slack: leaderTicks - full, status: 'WIN', sacrificed: sac };
            const beat = leaderPoints < maxPoints ? reach(leaderPoints + 1) : null;
            if (beat !== null) return { id: b.id, label: b.label, deadline: leaderTicks, finish: beat, slack: full === null ? null : leaderTicks - full, status: 'HOLD', sacrificed: sac };
            const tie = reach(leaderPoints);
            if (tie !== null && tie < leaderTicks) return { id: b.id, label: b.label, deadline: leaderTicks, finish: tie, slack: leaderTicks - tie, status: 'WIN', sacrificed: sac };
            return { id: b.id, label: b.label, deadline: leaderTicks, finish: tie, slack: tie === null ? null : leaderTicks - tie, status: tie === null ? 'NEVER' : 'LATE', sacrificed: sac };
        }
        let finish: number | null = null;
        for (let k = 0; k < order.length; k++) {
            const p = order[k]!;
            if (activityById.get(p.id)!.serves.includes(b.id)) {
                if (finish === null || p.landsAt > finish) finish = p.landsAt;
            }
        }
        return { id: b.id, label: b.label, deadline: null, finish, slack: null, status: finish === null ? 'NEVER' : 'NO-CLOCK', sacrificed: sac };
    });

    const route: Record<string, string> = {};
    const chosenIds: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = activities[i]!;
        chosenIds[i] = a.id;
        if (a.variant) route[a.variant.group] = a.variant.option;
    }
    return { order, boards: results, blocked, idle, endTick, qp, chosen: chosenIds, travel: travelTotal, route, overallFinish, lastSkill };
}

// Largest set of clock boards that can all be won (generalised Moore-Hodgson): schedule EDF; at the first late
// board, move the board with the most own foreground ticks among it and the earlier boards to the end; repeat.
// Moved boards still get done (Overall needs every 99), but after the boards that can still win.
export function bestSet(boards: Board[], activities: Activity[], opts: ScheduleOptions): { result: ScheduleResult; sacrificed: BoardId[] } {
    const sacrificed = new Set<BoardId>(opts.sacrificed ?? []);
    const cache = legCacheFor(opts.travel);
    const boardById = new Map(boards.map(b => [b.id, b]));
    const leverApplied = applyLevers(activities, opts);
    for (let i = 0; i <= boards.length; i++) {
        const result = schedule(boards, activities, { ...opts, sacrificed }, cache);
        const chosen = chooseVariants(leverApplied, { ...opts, force: { ...opts.force, ...result.route } }, true);
        const chosenById = new Map(chosen.map(a => [a.id, a]));
        const late = result.boards
            .filter(r => r.id !== 'overall' && r.deadline !== null && boardById.get(r.id)!.rule.kind === 'clock' && !sacrificed.has(r.id) && r.status !== 'WIN')
            .sort((x, y) => x.deadline! - y.deadline!);
        if (late.length === 0) return { result, sacrificed: [...sacrificed] };
        const first = late[0]!;
        const ownTicks = new Map<BoardId, number>();
        for (const p of result.order) {
            const pBoard = primary(chosenById.get(p.id)!, boardById);
            ownTicks.set(pBoard, (ownTicks.get(pBoard) ?? 0) + p.ticks + (p.travel ?? 0));
        }
        const candidates = result.boards
            .filter(r => r.id !== 'overall' && r.deadline !== null && boardById.get(r.id)!.rule.kind === 'clock' && !sacrificed.has(r.id) && r.deadline <= first.deadline!)
            .sort((x, y) => (ownTicks.get(y.id) ?? 0) - (ownTicks.get(x.id) ?? 0) || y.deadline! - x.deadline!);
        sacrificed.add(candidates[0]!.id);
    }
    return { result: schedule(boards, activities, { ...opts, sacrificed }, cache), sacrificed: [...sacrificed] };
}

function primary(a: Activity, boardById: ReadonlyMap<BoardId, Board>): BoardId {
    let best: BoardId = a.serves[0]!;
    let bestDl = Infinity;
    for (const s of a.serves) {
        const b = boardById.get(s);
        const d = b && b.rule.kind === 'clock' ? b.rule.deadline : Infinity;
        if (d < bestDl) { bestDl = d; best = s; }
    }
    return best;
}
