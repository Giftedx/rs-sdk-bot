import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { levelForXp, xpForLevel } from './curve';
import { planSkill, type Method } from './plan';
import { ANYWHERE, bankTrips, leg, loadTravel, resolve, type Place, type TravelModel } from './travel';

// Haggis 24-board schedule model.
//
// Every skill board ranks by level, then by the account's total playtime at the tick the level was reached
// (Player.ts:1904-1905 levelPlaytime, LoginServer.ts:155-181). Overall ranks by total level, then by the playtime
// of the last level-up (LoginServer.ts:120-125). So each clock board is a deadline on ONE shared playtime clock:
// Haggis must reach 99 before its total playtime reaches the #1's time. Quest Points ranks by points, then by the
// playtime the total was reached (hiscores.ts:313). Equipment, Bank and Lava Maze Runite have no playtime clock
// (hiscores.ts:620, 799-801, 981).
//
// The scheduler is earliest-deadline-first over activities on one foreground clock. Background activities (timers)
// occupy no foreground ticks after they start. XP from one activity can feed several boards (quests, superheat,
// combat Hitpoints). A board whose deadline cannot be met can be moved to the end (Moore-Hodgson style) to find the
// largest set of boards that can all be won.

// Quest points in rev 289 content: the sum of the quest.constant QP values (the #1 has 141 of 145).
export const MAX_QP = 145;

export const SKILLS = [
    'attack', 'defence', 'strength', 'hitpoints', 'ranged', 'prayer', 'magic', 'cooking', 'woodcutting', 'fletching',
    'fishing', 'firemaking', 'crafting', 'smithing', 'mining', 'herblore', 'agility', 'thieving', 'runecraft',
] as const;
export type Skill = (typeof SKILLS)[number];
export type BoardId = Skill | 'overall' | 'questpoints' | 'equipment' | 'bank' | 'runite';
export type Evidence = 'MEASURED' | 'CODE-READ' | 'ESTIMATE';
export type Trick = 'loginWine' | 'stunRelog' | 'sacredOil';
export type Mode = 'floor' | 'realistic';
export interface Range { floor: number; realistic: number; evidence?: Evidence; source?: string }
// `from`: the activity id that makes the item during the run (Haggis keeps the output). When that row is in the
// route, the item is not staged by a helper (suppliesFor leaves it out).
export interface Supply { item: string; count: number; note?: string; from?: string }

export const XP99 = xpForLevel(99);

export interface Activity {
    id: string;
    label: string;
    serves: BoardId[];
    // Fixed foreground ticks. For a `train` activity the ticks are computed from the XP still needed.
    ticks?: Range;
    // Train one skill to a level at a flat rate. `side` = XP given to other skills per XP of the main skill.
    // For a rate, `floor` is the best case (the higher rate).
    train?: { skill: Skill; toLevel: number; xpPerTick: Range; side?: Partial<Record<Skill, number>> };
    // XP lands this many ticks after the foreground part ends. The foreground clock does not wait.
    background?: Range;
    // XP to give. 'to99' = whatever the skill still needs for 99 when the activity starts.
    xp?: Partial<Record<Skill, number | 'to99'>>;
    lump?: boolean; // XP lands at the end (quests); otherwise it accrues linearly over the foreground ticks
    qp?: number;
    requires?: string[];
    minLevel?: Partial<Record<Skill, number>>;
    minLevelSource?: string; // why the gate exists (file:line evidence), for example a quest boss fight
    minQp?: number;
    // Alternatives: within one group the scheduler uses the eligible option with the fewest total ticks.
    variant?: { group: string; option: string; trick?: Trick };
    // Multiplies the foreground ticks when the trick is on (for example stun relog on thieving).
    trickSpeedup?: { trick: Trick; factor: number };
    // Host: foreground ticks inside this activity that leave the player free for a different action (for example
    // the 8-tick pickpocket stun, which blocks only pickpocketing and walking). Guests use them.
    deadTicks?: Range;
    // Guest: this activity runs inside the dead ticks of the host activity with this id. The ticks that do not fit
    // run in the foreground right after the host. Without the host in the scenario, the guest runs alone.
    inside?: string;
    // Gap-closer lever (research/gap-closers.md). 'add' rows exist only when the lever is on; 'drop' rows only when it
    // is off. A lever is on unless ScheduleOptions.disable names it. An `owner` lever (OWNER DECISION) is off unless
    // ScheduleOptions.owner names it.
    lever?: { id: string; role: 'add' | 'drop'; owner?: boolean };
    // Field patches that apply when a lever is on (in table order). `set` replaces fields; `addRequires` and
    // `addSide` extend the requirement list and the side XP of a `train` activity.
    patches?: LeverPatch[];
    evidence: Evidence;
    source: string;
    supplies?: Supply[];
    leadTime?: string; // helper staging work for the supplies (research/supply-logistics.md)
    pending?: string; // an input file that will replace these numbers
    // Travel (travel.ts). `at`: a place id, 'anywhere' (no move) or 'bank' (nearest bank). Without `at` the activity
    // does not move the player. `endAt`: where it ends when its own ticks already hold the walk inside it (quests).
    // `via`: places it walks to in order after `at`; those legs are added to its ticks. `bankTrips`: round trips
    // from its place to the nearest bank, added to its ticks.
    at?: string;
    endAt?: string;
    via?: string[];
    bankTrips?: number;
    // Historical metadata only. Neither policy labels nor missing supplies exclude a route.
    out?: { reason: string; rule?: string; replacement: string };
}

export type BoardKind =
    | { kind: 'clock'; deadline: number } // skill or overall: finish tick must be < deadline
    // Quest Points ranks by points desc, then playtime asc (RankedHiscoresWorker.ts:19); the playtime is stamped when
    // the total changes (LoginServer.ts:209-213). The leader can still gain points up to maxPoints, so only reaching
    // maxPoints before leaderTicks is a secure win (the leader's own maxPoints stamp is later than leaderTicks).
    | { kind: 'qp'; leaderPoints: number; leaderTicks: number; maxPoints?: number }
    | { kind: 'value'; note: string }; // no clock: value target from a board not in the snapshot

export interface Board { id: BoardId; label: string; rule: BoardKind }

export interface ScheduleOptions {
    mode: Mode;
    tricks: ReadonlySet<Trick>;
    sacrificed?: ReadonlySet<BoardId>;
    startXp?: Partial<Record<Skill, number>>;
    force?: Record<string, string>; // variant group -> option, to compare routes
    disable?: ReadonlySet<string>; // safe levers to switch off (to measure each lever alone)
    owner?: ReadonlySet<string>; // legacy name: explicitly enable retired variants for comparison; no approval gate
    travel?: TravelModel; // price the walks between activities; without it travel is 0
    includeOut?: boolean; // legacy compatibility, ignored: all rows are eligible
    // How schedule() picks one option per variant group: 'overall' (default) = the combination with the earliest
    // Overall finish in this mode (chooseRoute); 'ticks' = each group's option with the fewest raw ticks.
    route?: 'overall' | 'ticks';
}

export interface LeverPatch {
    lever: string;
    owner?: boolean;
    set?: Partial<Omit<Activity, 'id' | 'patches' | 'lever'>>;
    addRequires?: string[];
    addSide?: Partial<Record<Skill, number>>;
}

// A retired lever was measured and loses ticks; it stays off unless named in opts.owner (to show its size).
const isOn = (id: string, _owner: boolean | undefined, opts: Pick<ScheduleOptions, 'disable' | 'owner'>) =>
    LEVERS.some(l => l.id === id && l.retired) ? (opts.owner?.has(id) ?? false) : !(opts.disable?.has(id) ?? false);

// The activity table with the levers of `opts` applied: rows filtered, patches merged.
// Missing supplies create procurement work. Historical OUT metadata cannot disable rows or their patches.
export function applyLevers(activities: Activity[], opts: Pick<ScheduleOptions, 'disable' | 'owner' | 'includeOut'>): Activity[] {
    return activities.filter(a => leverOn(a, opts)).map(a => {
        let out = a;
        for (const p of a.patches ?? []) {
            if (!isOn(p.lever, p.owner, opts)) continue;
            out = { ...out, ...(p.set ?? {}) };
            if (p.addRequires) out = { ...out, requires: [...(out.requires ?? []), ...p.addRequires] };
            if (p.addSide && out.train) out = { ...out, train: { ...out.train, side: { ...(out.train.side ?? {}), ...p.addSide } } };
        }
        return out;
    });
}

export function leverOn(a: Activity, opts: Pick<ScheduleOptions, 'disable' | 'owner'>): boolean {
    if (!a.lever) return true;
    const id = a.lever.id;
    const on = isOn(id, a.lever.owner, opts);
    return a.lever.role === 'add' ? on : !on;
}

// `start` is the start of the activity itself; the walk to it (`travel` ticks from `from` to `to`) ends at `start`.
// `ticks` includes `inner`: the via legs and bank trips inside the activity.
export interface Placed { id: string; label: string; start: number; end: number; landsAt: number; ticks: number; deadline: number; travel?: number; from?: string; to?: string; method?: string; inner?: number }
export interface BoardResult {
    id: BoardId;
    label: string;
    deadline: number | null;
    finish: number | null; // tick the board's condition was met; null = never
    slack: number | null; // deadline - finish; > 0 beats #1
    // HOLD: rank 1 on points now, but lost if the leader gains points first (Quest Points only).
    status: 'WIN' | 'HOLD' | 'LATE' | 'TIE' | 'NEVER' | 'NO-CLOCK';
    sacrificed: boolean;
}
// `route`: the option used in each variant group (group -> option). `overallFinish`: the tick of the last 99 (null =
// some skill never reaches 99), whether or not `boards` has an Overall board; `lastSkill`: the skill of that 99.
export interface ScheduleResult { order: Placed[]; boards: BoardResult[]; blocked: string[]; idle: number; endTick: number; qp: number; chosen: string[]; travel: number; route: Record<string, string>; overallFinish: number | null; lastSkill: Skill | null }

interface XpEvent { start: number; end: number; lump: boolean; xp: Partial<Record<Skill, number>> }

// Eligible options per variant group after the levers, the tricks and opts.force, in table order.
function variantGroups(activities: Activity[], opts: ScheduleOptions): Map<string, Map<string, Activity[]>> {
    const groups = new Map<string, Map<string, Activity[]>>();
    for (const a of activities) {
        if (!a.variant) continue;
        if (a.variant.trick && !opts.tricks.has(a.variant.trick)) continue;
        const forced = opts.force?.[a.variant.group];
        if (forced !== undefined && forced !== a.variant.option) continue;
        const g = groups.get(a.variant.group) ?? new Map<string, Activity[]>();
        g.set(a.variant.option, [...(g.get(a.variant.option) ?? []), a]);
        groups.set(a.variant.group, g);
    }
    return groups;
}

// Raw-tick choice: per group the eligible option with the fewest total ticks (train activities count by their full
// 1->target cost at the given rate). This ignores side XP and order, so it can pick a route with a later Overall.
function rawRoute(groups: Map<string, Map<string, Activity[]>>, opts: ScheduleOptions): Record<string, string> {
    const route: Record<string, string> = {};
    for (const [group, options] of groups) {
        let bestCost = Infinity;
        for (const [option, acts] of options) {
            const cost = acts.reduce((s, a) => s + roughTicks(a, opts), 0);
            if (cost < bestCost) { bestCost = cost; route[group] = option; }
        }
    }
    return route;
}

// Pick one option per variant group: opts.force where given, else the raw-tick choice.
export function chooseVariants(activities: Activity[], opts: ScheduleOptions): Activity[] {
    activities = applyLevers(activities, opts);
    const groups = variantGroups(activities, opts);
    const route = rawRoute(groups, opts);
    return activities.filter(a => !a.variant || route[a.variant.group] === a.variant.option);
}

// At most this many combinations are searched exhaustively; above it, coordinate descent per group.
export const ROUTE_EXHAUSTIVE_MAX = 64;

// Route score, smaller is better: Overall finish (never = Infinity), then minus the slack sum over the clock boards,
// then the raw ticks of the chosen options (so a tie keeps the raw-tick choice).
function routeScore(r: ScheduleResult, boards: Board[], raw: number): number[] {
    const overall = r.overallFinish ?? Infinity;
    const slack = r.boards.filter(b => boards.find(x => x.id === b.id)?.rule.kind === 'clock' && b.slack !== null).reduce((s, b) => s + b.slack!, 0);
    return [overall, -slack, raw];
}
const better = (x: number[], y: number[]) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! < y[i]!; return false; };

// The variant combination with the earliest Overall finish for opts.mode (see routeScore). Deterministic: groups and
// options in table order, a candidate replaces the best only when strictly better.
export function chooseRoute(boards: Board[], activities: Activity[], opts: ScheduleOptions): { route: Record<string, string>; evaluated: number } {
    const groups = variantGroups(applyLevers(activities, opts), opts);
    const start = rawRoute(groups, opts);
    const multi = [...groups].filter(([, o]) => o.size > 1).map(([g, o]) => ({ group: g, options: [...o.keys()] }));
    if (multi.length === 0) return { route: start, evaluated: 0 };
    let evaluated = 0;
    const raw = (route: Record<string, string>) => [...groups].reduce((s, [g, o]) => s + o.get(route[g]!)!.reduce((t, a) => t + roughTicks(a, opts), 0), 0);
    const score = (route: Record<string, string>) => { evaluated++; return routeScore(scheduleRoute(boards, activities, { ...opts, force: { ...opts.force, ...route } }), boards, raw(route)); };
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

function pick(r: Range, mode: Mode): number { return mode === 'floor' ? r.floor : r.realistic; }

function speed(a: Activity, opts: ScheduleOptions): number {
    return a.trickSpeedup && opts.tricks.has(a.trickSpeedup.trick) ? a.trickSpeedup.factor : 1;
}

function roughTicks(a: Activity, opts: ScheduleOptions): number {
    let t = a.ticks ? pick(a.ticks, opts.mode) : 0;
    if (a.train) t += Math.ceil(xpForLevel(a.train.toLevel) / pick(a.train.xpPerTick, opts.mode));
    return t * speed(a, opts) + (a.background ? pick(a.background, opts.mode) : 0);
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
    return Infinity; // qp (wins on points) and value boards have no clock deadline
}

// Schedule with the route of opts.route (default: the earliest Overall finish, chooseRoute).
export function schedule(boards: Board[], allActivities: Activity[], opts: ScheduleOptions): ScheduleResult {
    if (opts.route === 'ticks') return scheduleRoute(boards, allActivities, opts);
    const { route } = chooseRoute(boards, allActivities, opts);
    return scheduleRoute(boards, allActivities, { ...opts, force: { ...opts.force, ...route } });
}

// Schedule with opts.force where given and the raw-tick choice for the other variant groups.
function scheduleRoute(boards: Board[], allActivities: Activity[], opts: ScheduleOptions): ScheduleResult {
    const sacrificed = opts.sacrificed ?? new Set<BoardId>();
    const activities = chooseVariants(allActivities, opts);
    const ids = new Set(activities.map(a => a.id));
    const overall = boards.find(b => b.id === 'overall');
    const overallDeadline = overall && overall.rule.kind === 'clock' ? overall.rule.deadline : Infinity;
    const dl = new Map<BoardId, number>(boards.map(b => [b.id, boardDeadline(b, sacrificed, overallDeadline)]));

    // Effective deadline: own (earliest served board) propagated back through prerequisites.
    const eff = new Map<string, number>();
    for (const a of activities) eff.set(a.id, Math.min(...a.serves.map(s => dl.get(s) ?? Infinity), Infinity));
    for (let changed = true; changed;) {
        changed = false;
        for (const a of activities) for (const r of a.requires ?? []) {
            if (!ids.has(r)) continue;
            const v = Math.min(eff.get(r)!, eff.get(a.id)!);
            if (v < eff.get(r)!) { eff.set(r, v); changed = true; }
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
    // Walk to the activity's place; returns the walk ticks and moves `here`. The via legs and bank trips are inner ticks.
    const move = (a: Activity): { walk: number; inner: number; from?: string; to?: string; method?: string } => {
        const m = opts.travel;
        if (!m || a.at === undefined || a.at === ANYWHERE) return { walk: 0, inner: 0 };
        if (here === undefined) here = m.start ?? a.at;
        if (here === 'bank') return { walk: 0, inner: 0 };
        const from = here;
        const to = resolve(m, here, a.at);
        const l = leg(m, from, to);
        let inner = 0;
        let cur = to;
        for (const v of a.via ?? []) { inner += leg(m, cur, v).ticks; cur = v; }
        if (a.bankTrips) inner += bankTrips(m, to, a.bankTrips).ticks;
        here = a.endAt ?? cur;
        return { walk: l.ticks, inner, from, to, method: l.method };
    };
    // A guest waits for its host while the host is in the scenario and not placed yet.
    const waitsForHost = (a: Activity) => a.inside !== undefined && ids.has(a.inside) && !placed.has(a.inside);
    const canStart = (a: Activity, t: number) =>
        (a.requires ?? []).every(r => !ids.has(r) || (doneAt.has(r) && doneAt.get(r)! <= t)) &&
        Object.entries(a.minLevel ?? {}).every(([s, l]) => levelForXp(xpNow(s as Skill, t)) >= l!) &&
        (a.minQp === undefined || qpAt(t) >= a.minQp);
    // Foreground ticks and XP of an activity that starts at `start` (speedup not applied).
    const cost = (a: Activity, start: number) => {
        const xp: Partial<Record<Skill, number>> = {};
        let fg = a.ticks ? pick(a.ticks, opts.mode) : 0;
        if (a.train) {
            const need = Math.max(0, xpForLevel(a.train.toLevel) - xpNow(a.train.skill, start));
            fg += need > 0 ? Math.ceil(need / pick(a.train.xpPerTick, opts.mode)) : 0;
            if (need > 0) {
                xp[a.train.skill] = need;
                for (const [s, k] of Object.entries(a.train.side ?? {})) xp[s as Skill] = (xp[s as Skill] ?? 0) + need * k!;
            }
        }
        for (const [s, v] of Object.entries(a.xp ?? {})) {
            const amount = v === 'to99' ? Math.max(0, XP99 - xpNow(s as Skill, start)) : v!;
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
        ready.sort((x, y) => eff.get(x.id)! - eff.get(y.id)! || activities.indexOf(x) - activities.indexOf(y));
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
        // Guests that can start with the host. They fill its dead ticks in table order.
        const guests = pending.filter(g => g.inside === a.id && canStart(g, start));
        const guestCost = guests.map(g => cost(g, start));
        let cap = a.deadTicks ? pick(a.deadTicks, opts.mode) : 0;
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

// ---------- Boards from the hiscore snapshot ----------

const SNAPSHOT_NAMES: Record<string, BoardId> = {
    Overall: 'overall', Attack: 'attack', Defence: 'defence', Strength: 'strength', Hitpoints: 'hitpoints', Ranged: 'ranged',
    Prayer: 'prayer', Magic: 'magic', Cooking: 'cooking', Woodcutting: 'woodcutting', Fletching: 'fletching', Fishing: 'fishing',
    Firemaking: 'firemaking', Crafting: 'crafting', Smithing: 'smithing', Mining: 'mining', Herblore: 'herblore', Agility: 'agility',
    Thieving: 'thieving', Runecraft: 'runecraft', 'Quest Points': 'questpoints',
};

interface Snapshot { takenAt: string; boards: { board: string; rows: { name: string; level: number; ticks: number }[] }[] }

export function boardsFromSnapshot(snap: Snapshot): Board[] {
    const out: Board[] = [];
    for (const b of snap.boards) {
        const id = SNAPSHOT_NAMES[b.board];
        const top = b.rows[0];
        if (!id || !top) continue;
        if (id === 'questpoints') out.push({ id, label: `${b.board} (#1 ${top.name}, ${top.level} QP)`, rule: { kind: 'qp', leaderPoints: top.level, leaderTicks: top.ticks } });
        else out.push({ id, label: `${b.board} (#1 ${top.name})`, rule: { kind: 'clock', deadline: top.ticks } });
    }
    out.push({ id: 'equipment', label: 'Equipment (worn value)', rule: { kind: 'value', note: 'hiscore_outfit.value desc (hiscores.ts:620); #1 value not in the snapshot' } });
    out.push({ id: 'bank', label: 'Bank (bank value)', rule: { kind: 'value', note: 'hiscore_bank.value desc (hiscores.ts:981); #1 value not in the snapshot' } });
    out.push({ id: 'runite', label: 'Lava Maze Runite (ores)', rule: { kind: 'value', note: 'count of runite_mine rows desc, ties by last_mined asc (hiscores.ts:791-801); #1 count not in the snapshot' } });
    return out;
}

export function loadSnapshot(path: string): Board[] {
    return boardsFromSnapshot(JSON.parse(readFileSync(path, 'utf8')) as Snapshot);
}

// ---------- Supply ladders (reuse planSkill: same ticks per action, so XP per action decides) ----------

export interface Tier { id: string; level: number; xpPerAction: number; items: Supply[] }

export function ladderSupplies(skill: Skill, tiers: Tier[], margin = 1, toLevel = 99): Supply[] {
    const methods: Method[] = tiers.map(t => ({ id: t.id, skill, level: t.level, xpPerHour: t.xpPerAction, source: 'estimated' }));
    const plan = planSkill({ skill, fromXp: 0, toLevel, methods });
    const out = new Map<string, number>();
    for (const seg of plan.segments) {
        const tier = tiers.find(t => t.id === seg.method)!;
        const actions = Math.ceil((seg.xp / tier.xpPerAction) * margin);
        for (const it of tier.items) out.set(it.item, (out.get(it.item) ?? 0) + actions * it.count);
    }
    return [...out].map(([item, count]) => ({ item, count }));
}

const each = (item: string, count = 1): Supply => ({ item, count });
const X = 25; // server XP rate

export const FLETCHING_TIERS: Tier[] = [
    { id: 'bronze arrows x15', level: 1, xpPerAction: 19.5 * X, items: [each('bronze arrowtips', 15), each('headless arrows', 15)] },
    { id: 'iron arrows x15', level: 15, xpPerAction: 37.5 * X, items: [each('iron arrowtips', 15), each('headless arrows', 15)] },
    { id: 'iron darts x10', level: 22, xpPerAction: 38 * X, items: [each('iron dart tips', 10), each('feathers', 10)] },
    { id: 'steel arrows x15', level: 30, xpPerAction: 75 * X, items: [each('steel arrowtips', 15), each('headless arrows', 15)] },
    { id: 'mithril arrows x15', level: 45, xpPerAction: 112.5 * X, items: [each('mithril arrowtips', 15), each('headless arrows', 15)] },
    { id: 'adamant arrows x15', level: 60, xpPerAction: 150 * X, items: [each('adamant arrowtips', 15), each('headless arrows', 15)] },
    { id: 'rune arrows x15', level: 75, xpPerAction: 187.5 * X, items: [each('rune arrowtips', 15), each('headless arrows', 15)] },
    { id: 'rune darts x10', level: 81, xpPerAction: 188 * X, items: [each('rune dart tips', 10), each('feathers', 10)] },
];
export const CRAFTING_TIERS: Tier[] = [
    // gem.dbrow experience is in tenths; opal, jade, red topaz can smash (success_rate), so the CLI adds a margin
    { id: 'opal', level: 1, xpPerAction: 15 * X, items: [each('uncut opal')] },
    { id: 'jade', level: 13, xpPerAction: 20 * X, items: [each('uncut jade')] },
    { id: 'red topaz', level: 16, xpPerAction: 25 * X, items: [each('uncut red topaz')] },
    { id: 'sapphire', level: 20, xpPerAction: 50 * X, items: [each('uncut sapphire')] },
    { id: 'emerald', level: 27, xpPerAction: 67.5 * X, items: [each('uncut emerald')] },
    { id: 'ruby', level: 34, xpPerAction: 85 * X, items: [each('uncut ruby')] },
    { id: 'diamond', level: 43, xpPerAction: 107.5 * X, items: [each('uncut diamond')] },
    { id: 'dragonstone', level: 55, xpPerAction: 137.5 * X, items: [each('uncut dragonstone')] },
];
export const HERBLORE_TIERS: Tier[] = [
    // brew_potion.struct brew_potion_level / brew_potion_exp (tenths); secondaries are the OSRS recipes (ESTIMATE)
    { id: 'attack', level: 1, xpPerAction: 25 * X, items: [each('guam potion (unf)'), each("eye of newt")] },
    { id: 'antipoison', level: 5, xpPerAction: 37.5 * X, items: [each('marrentill potion (unf)'), each('unicorn horn dust')] },
    { id: 'strength', level: 12, xpPerAction: 50 * X, items: [each('tarromin potion (unf)'), each('limpwurt root')] },
    { id: 'restore', level: 22, xpPerAction: 62.5 * X, items: [each('harralander potion (unf)'), each("red spiders' eggs")] },
    { id: 'energy', level: 26, xpPerAction: 67.5 * X, items: [each('harralander potion (unf)'), each('chocolate dust')] },
    { id: 'defence', level: 30, xpPerAction: 75 * X, items: [each('ranarr potion (unf)'), each('white berries')] },
    { id: 'agility', level: 34, xpPerAction: 80 * X, items: [each('toadflax potion (unf)'), each("toad's legs")] },
    { id: 'prayer', level: 38, xpPerAction: 87.5 * X, items: [each('ranarr potion (unf)'), each('snape grass')] },
    { id: 'super attack', level: 45, xpPerAction: 100 * X, items: [each('irit potion (unf)'), each('eye of newt')] },
    { id: 'superantipoison', level: 48, xpPerAction: 106.3 * X, items: [each('irit potion (unf)'), each('unicorn horn dust')] },
    { id: 'fishing', level: 50, xpPerAction: 112.5 * X, items: [each('avantoe potion (unf)'), each('snape grass')] },
    { id: 'super energy', level: 52, xpPerAction: 117.5 * X, items: [each('avantoe potion (unf)'), each('mort myre fungus')] },
    { id: 'super strength', level: 55, xpPerAction: 125 * X, items: [each('kwuarm potion (unf)'), each('limpwurt root')] },
    { id: 'weapon poison', level: 60, xpPerAction: 137.5 * X, items: [each('kwuarm potion (unf)'), each('dragon scale dust')] },
    { id: 'super restore', level: 63, xpPerAction: 142.5 * X, items: [each('snapdragon potion (unf)'), each("red spiders' eggs")] },
    { id: 'super defence', level: 66, xpPerAction: 150 * X, items: [each('cadantine potion (unf)'), each('white berries')] },
    { id: 'antifire', level: 69, xpPerAction: 157.5 * X, items: [each('lantadyme potion (unf)'), each('dragon scale dust')] },
    { id: 'ranging', level: 72, xpPerAction: 162.5 * X, items: [each('dwarf weed potion (unf)'), each('wine of zamorak')] },
    { id: 'magic', level: 76, xpPerAction: 172.5 * X, items: [each('lantadyme potion (unf)'), each('potato cactus')] },
    { id: 'zamorak brew', level: 78, xpPerAction: 175 * X, items: [each('torstol potion (unf)'), each('jangerberries')] },
];
export const FIREMAKING_TIERS: Tier[] = [
    { id: 'logs', level: 1, xpPerAction: 40 * X, items: [each('logs')] },
    { id: 'oak', level: 15, xpPerAction: 60 * X, items: [each('oak logs')] },
    { id: 'willow', level: 30, xpPerAction: 90 * X, items: [each('willow logs')] },
    { id: 'maple', level: 45, xpPerAction: 135 * X, items: [each('maple logs')] },
    { id: 'yew', level: 60, xpPerAction: 202.5 * X, items: [each('yew logs')] },
    { id: 'magic', level: 75, xpPerAction: 303.8 * X, items: [each('magic logs')] },
];
export const SMITHING_TIERS: Tier[] = [
    { id: 'bronze dagger', level: 1, xpPerAction: 12.5 * X, items: [each('bronze bar')] },
    { id: 'bronze platebody', level: 18, xpPerAction: 62.5 * X, items: [each('bronze bar', 5)] },
    { id: 'iron platebody', level: 33, xpPerAction: 125 * X, items: [each('iron bar', 5)] },
    { id: 'steel platebody', level: 48, xpPerAction: 187.5 * X, items: [each('steel bar', 5)] },
    { id: 'mithril platebody', level: 68, xpPerAction: 250 * X, items: [each('mithril bar', 5)] },
    { id: 'adamant platebody', level: 88, xpPerAction: 312.5 * X, items: [each('adamantite bar', 5)] },
];
export const MAGIC_TIERS: Tier[] = [
    // enchant XP from magic_spells.dbrow (research/xp-per-tick.md); rune costs are the OSRS ones (ESTIMATE)
    { id: 'wind strike', level: 1, xpPerAction: 5.5 * X, items: [each('air rune'), each('mind rune')] },
    { id: 'enchant 1 (sapphire ring)', level: 7, xpPerAction: 17.5 * X, items: [each('cosmic rune'), each('water rune'), each('sapphire ring')] },
    { id: 'enchant 2 (emerald ring)', level: 27, xpPerAction: 37 * X, items: [each('cosmic rune'), each('air rune', 3), each('emerald ring')] },
    { id: 'enchant 3 (ruby ring)', level: 49, xpPerAction: 59 * X, items: [each('cosmic rune'), each('fire rune', 5), each('ruby ring')] },
    { id: 'enchant 4 (diamond ring)', level: 57, xpPerAction: 67 * X, items: [each('cosmic rune'), each('earth rune', 10), each('diamond ring')] },
    { id: 'enchant 5 (dragonstone amulet)', level: 68, xpPerAction: 78 * X, items: [each('cosmic rune'), each('water rune', 15), each('earth rune', 15), each('dragonstone amulet')] },
];

// Stageable ladders (research/supply-logistics.md, Proposed substitutions). Rune dart tips, uncut dragonstones,
// dragonstone amulets and cosmic runes have no legal source at the scale of the full ladders above.
// Arrows only: rune arrows 187.5 XP per action of 15 against rune darts 188 per action of 10, both 5 per tick.
export const FLETCHING_ARROW_TIERS: Tier[] = FLETCHING_TIERS.filter(t => !t.id.includes('darts'));
// Diamonds from 43 to 99 (gem.dbrow 107.5 base XP); the GE has sellers for uncut diamonds, not dragonstones.
export const CRAFTING_NO_DRAGONSTONE_TIERS: Tier[] = CRAFTING_TIERS.filter(t => t.id !== 'dragonstone');
// Enchants without dragonstone amulets: diamond rings carry Magic from 57 to the Charge level (anvil route).
export const MAGIC_NO_DRAGONSTONE_TIERS: Tier[] = MAGIC_TIERS.filter(t => !t.id.includes('dragonstone'));
// Teleports (magic_spells.dbrow levelrequired / experience in tenths / runesrequired). A staff of air pays the
// air runes (research/supply-costs.md, Magic), so air runes are not listed. Below 25 only combat spells exist.
export const MAGIC_TELEPORT_TIERS: Tier[] = [
    { id: 'wind strike', level: 1, xpPerAction: 5.5 * X, items: [each('mind rune')] },
    { id: 'varrock teleport', level: 25, xpPerAction: 35 * X, items: [each('law rune'), each('fire rune')] },
    { id: 'lumbridge teleport', level: 31, xpPerAction: 41 * X, items: [each('law rune'), each('earth rune')] },
    { id: 'falador teleport', level: 37, xpPerAction: 48 * X, items: [each('law rune'), each('water rune')] },
    { id: 'camelot teleport', level: 45, xpPerAction: 55.5 * X, items: [each('law rune')] },
];

// ---------- The Haggis activity table ----------

// The activity table lives in haggis-boards.json so that new measurements change the plan without a code change.
// Each tick count and rate carries `evidence` and `source`. `suppliesLadder` names a tier table above: `tiers`
// when given, else the skill's full table; `toLevel` (default 99) ends the ladder early.
const LADDERS: Record<string, Tier[]> = {
    fletching: FLETCHING_TIERS, crafting: CRAFTING_TIERS, herblore: HERBLORE_TIERS,
    firemaking: FIREMAKING_TIERS, smithing: SMITHING_TIERS, magic: MAGIC_TIERS,
    'fletching-arrows': FLETCHING_ARROW_TIERS, 'crafting-no-dragonstone': CRAFTING_NO_DRAGONSTONE_TIERS,
    'magic-teleport': MAGIC_TELEPORT_TIERS, 'magic-no-dragonstone': MAGIC_NO_DRAGONSTONE_TIERS,
};
export const BOARDS_FILE = join(import.meta.dir, 'haggis-boards.json');

type ActivityJson = Activity & { suppliesLadder?: { skill: Skill; tiers?: string; margin?: number; toLevel?: number } };

// Dated procurement leads, never quantity caps. Keep the old export for existing readers.
export interface Unsourceable { item: string; observedAvailable?: number; max?: number; reason: string; source: string }
export function haggisUnsourceable(path = BOARDS_FILE): Unsourceable[] {
    const data=JSON.parse(readFileSync(path,'utf8')) as {supplyResearch?:Unsourceable[];unsourceable?:Unsourceable[]};
    return data.supplyResearch??data.unsourceable??[];
}

export function haggisActivities(path = BOARDS_FILE): Activity[] {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { activities: ActivityJson[] };
    return data.activities.map(({ suppliesLadder, ...a }) => {
        if (!suppliesLadder) return a;
        const tiers = LADDERS[suppliesLadder.tiers ?? suppliesLadder.skill];
        if (!tiers) throw new Error(`${a.id}: no tier table for ${suppliesLadder.tiers ?? suppliesLadder.skill}`);
        return { ...a, supplies: [...ladderSupplies(suppliesLadder.skill, tiers, suppliesLadder.margin ?? 1, suppliesLadder.toLevel ?? 99), ...(a.supplies ?? [])] };
    });
}

// Places of haggis-boards.json and the leg cache haggis-travel.json. The run starts where the tutorial skip lands.
export function haggisTravel(path = BOARDS_FILE): TravelModel {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { places?: Record<string, Place> };
    return { ...loadTravel(data.places ?? {}), start: 'lumbridge-spawn' };
}

export const TRICKS: Trick[] = ['loginWine', 'stunRelog', 'sacredOil'];
// Gap-closer choices. All techniques are authorized; retired slower variants remain available for comparison.
export const LEVERS: { id: string; owner: boolean; label: string; retired?: boolean }[] = [
    { id: 'magic-enchant', owner: false, label: 'Enchant ladder rather than teleport ladder; compare by disabling this option' },
    { id: 'combat-hp-bound', owner: false, label: "Melee by combat (HP-bound); melee-only quests after Overall; Witch's House split out" },
    // Retired: measured, it slows Defence to 86.7 style XP/tick and loses ticks in every table
    // (research/combat-measure.md section 6); bow + cannon carries Ranged instead.
    { id: 'cannon-melee', owner: false, retired: true, label: 'Cannon fires for Ranged XP during every melee top-up (RETIRED: loses ticks)' },
    { id: 'stun-guests', owner: false, label: 'Prayer and Magic inside the pickpocket stuns' },
    // research/combat-measure.md section 7. Attack is 99 from Tree Gnome Village, The Grand Tree and Fight Arena before
    // Monkey Madness, so Waterfall adds only Strength; a melee top-up after Monkey Madness gives it in fewer ticks.
    { id: 'waterfall-late', owner: false, label: 'Waterfall Quest after Overall; Strength 99 from Monkey Madness + melee top-up' },
    // Defence trains at the ranged row spot right after the Ranged row, before the walk to the Wilderness course.
    { id: 'def-at-ranged-spot', owner: false, label: 'Defence top-up at the Gnome battlefield right after the Ranged row (no walk back)' },
    { id: 'flinch-gather', owner: false, label: '2-tick flinch woodcutting and fishing (tick manipulation, UNVERIFIED live)' },
    { id: 'charge-spam', owner: false, label: 'Charge spell 80 -> 99, no delay, no recast check' },
    { id: 'wild-iron', owner: false, label: '5-rock Wilderness iron spot (PvP risk)' },
    // Rival techniques, priced from bleugreen/rs-sdk@3bd2ab0a (ESTIMATE until we measure them; research/rival-gap-list.md).
    { id: 'rival-knife-mine', owner: false, label: 'Knife-starter mining, Ardougne zoo iron rotation' },
    { id: 'rival-altar-room-rc', owner: false, label: '7-tick altar-room runecraft cycle with givers' },
    { id: 'rival-dialogue-burst', owner: false, label: 'Dialogue bursts (several continue clicks in one tick)' },
    { id: 'rival-grandtree-agility', owner: false, label: 'Grand Tree first, then agility laps' },
    { id: 'rival-bury-in-knife-wc', owner: false, label: 'Bury bones inside the knife woodcutting loop' },
    // Retired: our measured laps (research/agility.md) replace the rival's estimate.
    { id: 'rival-agility-lap', owner: false, retired: true, label: '66-74 tick agility laps (RETIRED: measured rates used)' },
    { id: 'rival-stun-pack', owner: false, label: 'Stun pack: skill actions inside pickpocket stuns' },
    { id: 'rival-monkey-madness', owner: false, label: 'Monkey Madness before melee and thieving' },
    { id: 'rival-sea-slug', owner: false, label: 'Sea Slug for early Fishing' },
    // Retired: Cairn's order (research/community-and-upstream.md section 7) loses 628 ticks in our model.
    // Dragon Slayer replaces the Strength and Defence top-ups, but Hitpoints then needs Witch's House at the end.
    { id: 'rival-dragon-combat', owner: false, retired: true, label: 'Dragon Slayer before the melee top-ups, Doric for the 32 QP (RETIRED: loses ticks in the model)' },
];
export const SCENARIOS: { id: string; label: string; tricks: Trick[] }[] = [
    { id: 'a', label: 'All server mechanics (default)', tricks: TRICKS },
    { id: 'b', label: 'With login wine', tricks: ['loginWine'] },
    { id: 'c', label: 'All tricks optional (login wine, stun relog, sacred oil)', tricks: TRICKS },
];

// Supplies a helper stages for the activities the scenario uses, summed by item. With `boards`, the route is the
// one schedule() uses (chooseRoute); without, the raw-tick choice. An item made by a row of the route is left out.
export function suppliesFor(activities: Activity[], opts: ScheduleOptions, boards?: Board[]): Supply[] {
    return goalRequirementsFor(activities, opts, boards).supplies.map(({item,count})=>({item,count}));
}

// Keep shared unlocks once, but add consumables across consumers. These are requirements,
// not completion claims: activity IDs must not be treated as observed quest flags.
export function goalRequirementsFor(activities: Activity[], opts: ScheduleOptions, boards?: Board[]) {
    const route = boards && opts.route !== 'ticks' ? chooseRoute(boards, activities, opts).route : {};
    const acts = chooseVariants(activities, { ...opts, force: { ...opts.force, ...route } });
    const ids = new Set(acts.map(a => a.id));
    const out = new Map<string, {item:string;count:number;consumers:string[]}>();
    const unlocks = new Map<string, {activity:string;consumers:string[];selected:boolean}>();
    for (const a of acts) {
        for (const id of a.requires ?? []) {
            const row=unlocks.get(id)??{activity:id,consumers:[],selected:ids.has(id)};
            if(!row.consumers.includes(a.id))row.consumers.push(a.id);
            unlocks.set(id,row);
        }
        for (const s of a.supplies ?? []) if (!s.from || !ids.has(s.from)) {
            const row=out.get(s.item)??{item:s.item,count:0,consumers:[]};
            row.count+=s.count;
            if(!row.consumers.includes(a.id))row.consumers.push(a.id);
            out.set(s.item,row);
        }
    }
    return {supplies:[...out.values()],unlocks:[...unlocks.values()]};
}
