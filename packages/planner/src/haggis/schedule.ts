// Earliest-deadline-first scheduler with dead-tick guest absorption, route selection, and Moore-Hodgson optimization.
import { levelForXp, xpForLevel } from '../curve';
import { ANYWHERE, bankTrips, resolve, type TravelModel } from '../travel';
import { qpSpecialistActivities } from './boards';
import {
    MAX_QP, SKILLS, XP99, applyLevers, chooseVariants, pick, rawRoute, roughTicks, speed, variantGroups,
    type Activity, type Board, type BoardId, type BoardResult, type Placed, type ScheduleOptions,
    type ScheduleResult, type Skill,
} from './model';
import { bestHaggisLeg } from './travel';

// At most this many combinations are searched exhaustively; above it, coordinate descent per group.
const ROUTE_EXHAUSTIVE_MAX = 64;

interface XpEvent { start: number; end: number; lump: boolean; xp: Partial<Record<Skill, number>> }

// Route score, smaller is better: when Overall is sacrificed (specialist schedules or bestSet without Overall),
// minimize the active unsacrificed clock boards first; otherwise Overall finish first, then minus slack sum, then raw ticks.
function routeScore(r: ScheduleResult, boards: Board[], raw: number, sacrificed?: ReadonlySet<BoardId>): number[] {
    const overall = r.overallFinish ?? Infinity;
    const isClock = (id: BoardId) => boards.find(x => x.id === id)?.rule.kind === 'clock';
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
    const slack = r.boards.filter(b => isClock(b.id) && b.slack !== null).reduce((s, b) => s + b.slack!, 0);
    return [overall, -slack, raw];
}
const better = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!; return false; };

// The variant combination with the earliest Overall finish for opts.mode (see routeScore). Deterministic: groups and
// options in table order, a candidate replaces the best only when strictly better.
export function chooseRoute(boards: Board[], activities: Activity[], opts: ScheduleOptions, prerequisiteFirst = false): { route: Record<string, string>; evaluated: number } {
    const groups = variantGroups(applyLevers(activities, opts), opts);
    const start = rawRoute(groups, opts);
    const multi = [...groups].filter(([, o]) => o.size > 1).map(([g, o]) => ({ group: g, options: [...o.keys()] }));
    if (multi.length === 0) return { route: start, evaluated: 0 };
    let evaluated = 0;
    const raw = (route: Record<string, string>) => [...groups].reduce((s, [g, o]) => s + o.get(route[g]!)!.reduce((t, a) => t + roughTicks(a, opts), 0), 0);
    const score = (route: Record<string, string>) => { evaluated++; return routeScore(scheduleRoute(boards, activities, { ...opts, force: { ...opts.force, ...route } }, prerequisiteFirst), boards, raw(route), opts.sacrificed); };
    let best = start;
    let bestScore = score(start);
    const combos = multi.reduce((n, g) => n * g.options.length, 1);
    if (combos <= ROUTE_EXHAUSTIVE_MAX) {
        for (let i = 0; i < combos; i++) {
            const route = { ...start };
            let k = i;
            for (const g of multi) { route[g.group] = g.options[k % g.options.length]!; k = Math.floor(k / g.options.length); }
            if (multi.every(g => route[g.group] === best[g.group])) continue;
            const s = score(route);
            if (better(s, bestScore)) { best = route; bestScore = s; }
        }
        return { route: best, evaluated };
    }
    // Greedy: change one group at a time while that improves the score; repeat the pass until nothing changes.
    for (let pass = 0, changed = true; changed && pass < 10; pass++) {
        changed = false;
        for (const g of multi) for (const option of g.options) {
            if (best[g.group] === option) continue;
            const route = { ...best, [g.group]: option };
            const s = score(route);
            if (better(s, bestScore)) { best = route; bestScore = s; changed = true; }
        }
    }
    return { route: best, evaluated };
}

function xpAt(events: XpEvent[], start: number, skill: Skill, t: number): number {
    let xp = start;
    for (const e of events) {
        const v = e.xp[skill];
        if (!v) continue;
        if (e.lump || e.end <= e.start) { if (t >= e.end) xp += v; }
        else if (t >= e.end) xp += v;
        else if (t > e.start) xp += (v * (t - e.start)) / (e.end - e.start);
    }
    return xp;
}

// First integer tick at which `skill` has at least `target` XP, or null.
function crossing(events: XpEvent[], start: number, skill: Skill, target: number, horizon: number): number | null {
    if (start >= target) return 0;
    if (xpAt(events, start, skill, horizon) < target - 1e-6) return null;
    let lo = 0, hi = horizon;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (xpAt(events, start, skill, mid) >= target - 1e-6) hi = mid; else lo = mid + 1;
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
export function schedule(boards: Board[], allActivities: Activity[], opts: ScheduleOptions): ScheduleResult {
    if (opts.route === 'ticks') return scheduleRoute(boards, allActivities, opts);
    const { route } = chooseRoute(boards, allActivities, opts);
    return scheduleRoute(boards, allActivities, { ...opts, force: { ...opts.force, ...route } });
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
    const baseline = schedule(boards, activities, opts);
    if (opts.sacrificed !== undefined) return baseline;
    const relaxed = schedule(boards, activities, { ...opts, sacrificed: OVERALL_RELAXED_DEADLINES });
    const finish = (plan: ScheduleResult) => plan.overallFinish ?? Infinity;
    const useRelaxed = finish(relaxed) < finish(baseline);
    let best = useRelaxed ? relaxed : baseline;
    if (!opts.travel) return best;
    const candidates: ScheduleResult[] = [best];
    const travelOpts = { ...opts, sacrificed: OVERALL_TRAVEL_DEADLINES };
    const travelChosen = chooseRoute(boards, activities, travelOpts, true).route;
    for (const [routeMap, dlSet] of [
        [best.route, useRelaxed ? OVERALL_RELAXED_DEADLINES : undefined] as const,
        [travelChosen, OVERALL_TRAVEL_DEADLINES] as const,
    ]) {
        const fixed = { ...opts, force: { ...opts.force, ...routeMap } };
        candidates.push(scheduleRoute(boards, activities, { ...fixed, sacrificed: dlSet }, true));
        candidates.push(scheduleRoute(boards, activities, { ...fixed, sacrificed: OVERALL_TRAVEL_DEADLINES }, true));
    }
    for (const c of candidates) if (finish(c) < finish(best)) best = c;
    return best;
}

/** Schedules a dedicated 145-QP specialist (sacrificing skill 99s and Overall to beat #1 stunquestv3). */
export function scheduleQpSpecialist(boards: Board[], activities: Activity[], opts: ScheduleOptions): ScheduleResult {
    const sacrificed = new Set<BoardId>(boards.filter(b => b.id !== 'questpoints').map(b => b.id));
    return schedule(boards, qpSpecialistActivities(activities), { ...opts, sacrificed });
}

// Schedule with opts.force where given and the raw-tick choice for the other variant groups.
function scheduleRoute(boards: Board[], allActivities: Activity[], opts: ScheduleOptions, prerequisiteFirst = false): ScheduleResult {
    const sacrificed = opts.sacrificed ?? new Set<BoardId>();
    const chosen = chooseVariants(allActivities, opts);
    const hasTouristTrapAgility = chosen.some(a => a.id === 'tourist-trap-agility');
    const activities = chosen.map(a => {
        let next = a;
        if (sacrificed.has('defence') && next.id === 'agility-52' && next.requires?.includes('def-top')) {
            next = { ...next, requires: next.requires.filter(r => r !== 'def-top') };
        }
        if (sacrificed.has('fletching') && !opts.disable?.has('stun-guests') && next.id === 'fletch' && !next.inside) {
            next = { ...next, inside: 'thieve' };
        }
        if (hasTouristTrapAgility && (next.id === 'agility-25' || next.id === 'grandtree')) {
            next = { ...next, serves: next.serves.filter(s => s !== 'agility') };
        }
        return next;
    });
    const ids = new Set(activities.map(a => a.id));
    const dependants = new Map<string, number>();
    if (prerequisiteFirst) {
        for (const a of activities) for (const id of new Set(a.requires)) {
            dependants.set(id, (dependants.get(id) ?? 0) + 1);
        }
    }
    const overall = boards.find(b => b.id === 'overall');
    const overallDeadline = overall && overall.rule.kind === 'clock' ? overall.rule.deadline : Infinity;
    const dl = new Map<BoardId, number>(boards.map(b => [b.id, boardDeadline(b, sacrificed, overallDeadline)]));

    // Effective deadline: own (earliest served board) propagated back through prerequisites and required skill trainers.
    const eff = new Map<string, number>();
    for (const a of activities) eff.set(a.id, Math.min(...a.serves.map(s => dl.get(s) ?? Infinity), Infinity));
    for (let changed = true; changed;) {
        changed = false;
        for (const a of activities) {
            for (const r of a.requires ?? []) {
                if (!ids.has(r)) continue;
                const v = Math.min(eff.get(r)!, eff.get(a.id)!);
                if (v < eff.get(r)!) { eff.set(r, v); changed = true; }
            }
            for (const [s, lvl] of Object.entries(a.minLevel ?? {})) {
                for (const p of activities) {
                    if (p.inside !== undefined || p.train?.skill !== s || p.train.toLevel > lvl!) continue;
                    const v = Math.min(eff.get(p.id)!, eff.get(a.id)!);
                    if (v < eff.get(p.id)!) { eff.set(p.id, v); changed = true; }
                }
            }
        }
    }

    const startXp: Record<Skill, number> = Object.fromEntries(SKILLS.map(s => [s, opts.startXp?.[s] ?? (s === 'hitpoints' ? xpForLevel(10) : 0)])) as Record<Skill, number>;
    const events: XpEvent[] = [];
    const doneAt = new Map<string, number>();
    const order: Placed[] = [];
    const qpEvents: { at: number; qp: number }[] = [];
    const pending = activities.slice();
    let clock = 0;
    let idle = 0;
    const blocked: string[] = [];
    const xpNow = (s: Skill, t: number) => xpAt(events, startXp[s], s, t);
    const qpAt = (t: number) => qpEvents.filter(e => e.at <= t).reduce((s, e) => s + e.qp, 0);

    const placed = new Set<string>();
    let here: string | undefined;
    let travelTotal = 0;
    const disableTeleports = !!opts.disable?.has('magic-teleports');
    const bestLeg = (m: TravelModel, from: string, to: string) =>
        bestHaggisLeg(m, from, to, levelForXp(xpNow('magic', clock)), doneAt, disableTeleports);
    // Walk to the activity's place; returns the walk ticks and moves `here`. The via legs and bank trips are inner ticks.
    const move = (a: Activity): { walk: number; inner: number; from?: string; to?: string; method?: string } => {
        const m = opts.travel;
        if (!m || a.at === undefined || a.at === ANYWHERE) return { walk: 0, inner: 0 };
        if (here === undefined) here = m.start ?? a.at;
        if (here === 'bank') return { walk: 0, inner: 0 };
        const from = here;
        const to = resolve(m, here, a.at);
        const l = bestLeg(m, from, to);
        let inner = 0;
        let cur = to;
        for (const v of a.via ?? []) { inner += bestLeg(m, cur, v).ticks; cur = v; }
        if (a.bankTrips) inner += bankTrips(m, to, a.bankTrips).ticks;
        here = a.endAt ?? cur;
        return { walk: l.ticks, inner, from, to, method: l.method };
    };
    // A guest waits for its host while the host is in the scenario and not placed yet.
    const waitsForHost = (a: Activity) => a.inside !== undefined && ids.has(a.inside) && !placed.has(a.inside);
    const canStart = (a: Activity, t: number, extra: Partial<Record<Skill, number>> = {}, absorbed?: readonly Activity[]) =>
        (a.requires ?? []).every(r => !ids.has(r) || (doneAt.has(r) && doneAt.get(r)! <= t) || !!absorbed?.some(prev => prev.id === r)) &&
        Object.entries(a.minLevel ?? {}).every(([s, l]) => levelForXp(xpNow(s as Skill, t) + (extra[s as Skill] ?? 0)) >= l!) &&
        (a.minQp === undefined || qpAt(t) >= a.minQp);
    // Foreground ticks and XP of an activity that starts at `start` (speedup not applied).
    const cost = (a: Activity, start: number, extra: Partial<Record<Skill, number>> = {}) => {
        const xp: Partial<Record<Skill, number>> = {};
        let fg = a.ticks ? pick(a.ticks, opts.mode) : 0;
        const baseXp = (s: Skill) => xpNow(s, start) + (extra[s] ?? 0);
        if (a.train) {
            const need = Math.max(0, xpForLevel(a.train.toLevel) - baseXp(a.train.skill));
            fg += need > 0 ? Math.ceil(need / pick(a.train.xpPerTick, opts.mode)) : 0;
            if (need > 0) {
                xp[a.train.skill] = need;
                for (const [s, k] of Object.entries(a.train.side ?? {})) xp[s as Skill] = (xp[s as Skill] ?? 0) + need * k!;
            }
        }
        for (const [s, v] of Object.entries(a.xp ?? {})) {
            const amount = v === 'to99' ? Math.max(0, XP99 - baseXp(s as Skill)) : v!;
            xp[s as Skill] = (xp[s as Skill] ?? 0) + amount;
        }
        return { fg, xp };
    };
    const scale = (xp: Partial<Record<Skill, number>>, k: number) =>
        Object.fromEntries(Object.entries(xp).map(([s, v]) => [s, v! * k])) as Partial<Record<Skill, number>>;

    while (pending.length > 0) {
        // Requirements naming an activity that is not in this scenario are ignored (the other variant was chosen).
        const ready = pending.filter(a => !waitsForHost(a) && canStart(a, clock));
        if (ready.length === 0) {
            // Wait for a background activity whose result something needs, or stop: the rest is blocked.
            const future = [...doneAt.values()].filter(t => t > clock);
            if (future.length > 0) { const t = Math.min(...future); idle += t - clock; clock = t; continue; }
            for (const a of pending) blocked.push(a.id);
            break;
        }
        const walkCost = (act: Activity) => {
            if (!opts.travel || !here || act.at === undefined || act.at === ANYWHERE) return 0;
            const to = resolve(opts.travel, here, act.at);
            return bestLeg(opts.travel, here, to).ticks;
        };
        ready.sort((x, y) => eff.get(x.id)! - eff.get(y.id)!
            || (prerequisiteFirst ? (dependants.get(y.id) ?? 0) - (dependants.get(x.id) ?? 0) : 0)
            || ((prerequisiteFirst || eff.get(x.id)! > overallDeadline) && opts.travel ? walkCost(x) - walkCost(y) : 0)
            || activities.indexOf(x) - activities.indexOf(y));
        const a = ready[0]!;
        pending.splice(pending.indexOf(a), 1);

        // A train row with nothing left to do (an earlier lump reached its level) does not walk.
        const mv = a.train && cost(a, clock).fg === 0 ? { walk: 0, inner: 0 } as ReturnType<typeof move> : move(a);
        clock += mv.walk;
        travelTotal += mv.walk + mv.inner;
        const start = clock;
        const c = cost(a, start);
        const xp = c.xp;
        let fg = c.fg + mv.inner;
        // Guests that can start with the host (including chained guests unlocked by earlier fully-absorbed guests).
        let cap = a.deadTicks ? pick(a.deadTicks, opts.mode) : 0;
        const guests: Activity[] = [];
        const guestCost: ReturnType<typeof cost>[] = [];
        const extraXp: Partial<Record<Skill, number>> = {};
        let usedCap = 0;
        for (let added = true; added;) {
            added = false;
            for (const g of pending) {
                if (g.inside !== a.id || guests.includes(g) || !canStart(g, start, extraXp, guests)) continue;
                const gc = cost(g, start, extraXp);
                guests.push(g);
                guestCost.push(gc);
                if (usedCap + gc.fg <= cap) {
                    usedCap += gc.fg;
                    for (const [s, v] of Object.entries(gc.xp)) extraXp[s as Skill] = (extraXp[s as Skill] ?? 0) + v!;
                }
                added = true;
            }
        }
        const absorbable = guestCost.reduce((s, g) => s + g.fg, 0);
        // A speedup trick (stun relog) removes the dead ticks. Use it only if it saves more than the guests absorb.
        const sp = speed(a, opts);
        if (sp < 1 && guests.length > 0 && Math.min(cap, absorbable) > fg * (1 - sp)) { /* keep the stuns for guests */ }
        else { fg = Math.ceil(fg * sp); if (sp < 1) cap = 0; }
        const end = start + fg;
        const landsAt = end + (a.background ? pick(a.background, opts.mode) : 0);
        if (a.background) events.push({ start: landsAt, end: landsAt, lump: true, xp });
        else events.push({ start, end, lump: a.lump ?? false, xp });
        if (a.qp) qpEvents.push({ at: landsAt, qp: a.qp });
        doneAt.set(a.id, landsAt);
        placed.add(a.id);
        order.push({ id: a.id, label: a.label, start, end, landsAt, ticks: fg, deadline: eff.get(a.id)!, ...(mv.walk || mv.inner ? { travel: mv.walk, from: mv.from, to: mv.to, method: mv.method, inner: mv.inner } : {}) });
        clock = end;
        guests.forEach((g, i) => {
            const gc = guestCost[i]!;
            const absorbed = Math.min(gc.fg, cap);
            cap -= absorbed;
            const rest = gc.fg - absorbed;
            const share = gc.fg > 0 ? absorbed / gc.fg : 1;
            if (share > 0) events.push({ start, end, lump: g.lump ?? false, xp: scale(gc.xp, share) });
            if (rest > 0) events.push({ start: clock, end: clock + rest, lump: g.lump ?? false, xp: scale(gc.xp, 1 - share) });
            const gEnd = rest > 0 ? clock + rest : end;
            if (g.qp) qpEvents.push({ at: gEnd, qp: g.qp });
            doneAt.set(g.id, gEnd);
            placed.add(g.id);
            pending.splice(pending.indexOf(g), 1);
            order.push({ id: g.id, label: `${g.label} (inside ${a.id}: ${absorbed} ticks absorbed)`, start, end: gEnd, landsAt: gEnd, ticks: rest, deadline: eff.get(g.id)! });
            clock += rest;
        });
    }

    const endTick = Math.max(clock, ...[...doneAt.values()]);
    const horizon = endTick + 1;
    const skillFinish = new Map<Skill, number | null>(SKILLS.map(s => [s, crossing(events, startXp[s], s, XP99, horizon)]));
    const qp = qpAt(horizon);

    const results: BoardResult[] = boards.map(b => {
        const sac = sacrificed.has(b.id);
        if (b.rule.kind === 'clock') {
            let finish: number | null;
            if (b.id === 'overall') {
                const f = SKILLS.map(s => skillFinish.get(s)!);
                finish = f.some(x => x === null) ? null : Math.max(...(f as number[]));
            } else finish = skillFinish.get(b.id as Skill) ?? null;
            const deadline = b.rule.deadline;
            const slack = finish === null ? null : deadline - finish;
            const status = finish === null ? 'NEVER' : slack! > 0 ? 'WIN' : slack === 0 ? 'TIE' : 'LATE';
            return { id: b.id, label: b.label, deadline, finish, slack, status, sacrificed: sac };
        }
        if (b.rule.kind === 'qp') {
            const { leaderPoints, leaderTicks } = b.rule;
            const maxPoints = b.rule.maxPoints ?? MAX_QP;
            const reach = (n: number) => { const e = [...qpEvents].sort((x, y) => x.at - y.at); let s = 0; for (const x of e) { s += x.qp; if (s >= n) return x.at; } return null; };
            // Secure: every point the content has, before the leader's playtime. A tie at maxPoints goes to the earlier stamp.
            const full = reach(maxPoints);
            if (full !== null && full < leaderTicks) return { id: b.id, label: b.label, deadline: leaderTicks, finish: full, slack: leaderTicks - full, status: 'WIN', sacrificed: sac };
            const beat = leaderPoints < maxPoints ? reach(leaderPoints + 1) : null;
            if (beat !== null) return { id: b.id, label: b.label, deadline: leaderTicks, finish: beat, slack: full === null ? null : leaderTicks - full, status: 'HOLD', sacrificed: sac };
            const tie = reach(leaderPoints);
            if (tie !== null && tie < leaderTicks) return { id: b.id, label: b.label, deadline: leaderTicks, finish: tie, slack: leaderTicks - tie, status: 'WIN', sacrificed: sac };
            return { id: b.id, label: b.label, deadline: leaderTicks, finish: tie, slack: tie === null ? null : leaderTicks - tie, status: tie === null ? 'NEVER' : 'LATE', sacrificed: sac };
        }
        const served = order.filter(p => activities.find(a => a.id === p.id)!.serves.includes(b.id));
        const finish = served.length ? Math.max(...served.map(p => p.landsAt)) : null;
        return { id: b.id, label: b.label, deadline: null, finish, slack: null, status: finish === null ? 'NEVER' : 'NO-CLOCK', sacrificed: sac };
    });
    const route = Object.fromEntries(activities.filter(a => a.variant).map(a => [a.variant!.group, a.variant!.option]));
    const f = SKILLS.map(s => skillFinish.get(s)!);
    const overallFinish = f.some(x => x === null) ? null : Math.max(...(f as number[]));
    const lastSkill = overallFinish === null ? null : SKILLS[f.lastIndexOf(overallFinish)]!;
    return { order, boards: results, blocked, idle, endTick, qp, chosen: activities.map(a => a.id), travel: travelTotal, route, overallFinish, lastSkill };
}

// Largest set of clock boards that can all be won (generalised Moore-Hodgson): schedule EDF; at the first late
// board, move the board with the most own foreground ticks among it and the earlier boards to the end; repeat.
// Moved boards still get done (Overall needs every 99), but after the boards that can still win.
export function bestSet(boards: Board[], activities: Activity[], opts: ScheduleOptions): { result: ScheduleResult; sacrificed: BoardId[] } {
    const sacrificed = new Set<BoardId>(opts.sacrificed ?? []);
    for (let i = 0; i <= boards.length; i++) {
        const result = schedule(boards, activities, { ...opts, sacrificed });
        const chosen = chooseVariants(activities, { ...opts, force: { ...opts.force, ...result.route } });
        const late = result.boards
            .filter(r => r.id !== 'overall' && r.deadline !== null && boards.find(b => b.id === r.id)!.rule.kind === 'clock' && !sacrificed.has(r.id) && r.status !== 'WIN')
            .sort((x, y) => x.deadline! - y.deadline!);
        if (late.length === 0) return { result, sacrificed: [...sacrificed] };
        const first = late[0]!;
        const own = (id: BoardId) => result.order
            .filter(p => primary(chosen.find(a => a.id === p.id)!, boards) === id)
            .reduce((s, p) => s + p.ticks + (p.travel ?? 0), 0);
        const candidates = result.boards
            .filter(r => r.id !== 'overall' && r.deadline !== null && boards.find(b => b.id === r.id)!.rule.kind === 'clock' && !sacrificed.has(r.id) && r.deadline <= first.deadline!)
            .sort((x, y) => own(y.id) - own(x.id) || y.deadline! - x.deadline!);
        sacrificed.add(candidates[0]!.id);
    }
    return { result: schedule(boards, activities, { ...opts, sacrificed }), sacrificed: [...sacrificed] };
}

function primary(a: Activity, boards: Board[]): BoardId {
    let best: BoardId = a.serves[0]!;
    let bestDl = Infinity;
    for (const s of a.serves) {
        const b = boards.find(x => x.id === s);
        const d = b && b.rule.kind === 'clock' ? b.rule.deadline : Infinity;
        if (d < bestDl) { bestDl = d; best = s; }
    }
    return best;
}
