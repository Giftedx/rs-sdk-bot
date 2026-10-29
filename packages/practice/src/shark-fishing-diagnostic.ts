// Practice-only engine observer for the shark fishing stall. Loaded with `bun --preload` into a local
// practice engine only when stack.ts receives enginePreload. It never changes pinned sources, mechanics or RNG:
// every wrapped original runs exactly once with its own receiver, arguments, result and exception.
// Hooks only peek at the script int stack and read player fields. A hook failure is counted and reported,
// never thrown into the engine. Diagnostic coverage is not product acceptance.
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isMainThread} from 'node:worker_threads';

export const DIAGNOSTIC_OUT = 'SHARK_FISHING_DIAGNOSTIC_OUT', DIAGNOSTIC_PLAYER = 'SHARK_FISHING_DIAGNOSTIC_PLAYER';
export type Emit = (row: Record<string, unknown>) => void;
type Outcome = {threw: false; result: unknown} | {threw: true; error: unknown};
export interface Hooks<C> {
    before?(self: any, args: any[]): C | undefined;
    after?(ctx: C | undefined, self: any, args: any[], outcome: Outcome): void;
}

// Replaces owner[key] with a wrapper that calls the original once. Returns the restore function.
export function wrapTransparent<C>(owner: any, key: PropertyKey, hooks: Hooks<C>, fail: (error: unknown) => void): () => void {
    const original = owner[key];
    if (typeof original !== 'function') throw Error(`diagnostic target missing: ${String(key)}`);
    const wrapped = function (this: any, ...args: any[]) {
        let ctx: C | undefined;
        try { ctx = hooks.before?.(this, args); } catch (error) { fail(error); }
        let result: unknown;
        try { result = original.apply(this, args); } catch (error) {
            try { hooks.after?.(ctx, this, args, {threw: true, error}); } catch (e) { fail(e); }
            throw error;
        }
        try { hooks.after?.(ctx, this, args, {threw: false, result}); } catch (e) { fail(e); }
        return result;
    };
    owner[key] = wrapped;
    return () => { if (owner[key] === wrapped) owner[key] = original; };
}

export interface SharkEngine {
    world: {currentTick: number};
    handlers: Record<number, (state: any) => void>;
    opcodes: {pOpnpc: number; statRandom: number};
    player: object; // Player.prototype
    opNpc: object; // OpNpcHandler.prototype
    npc(slot: number): any;
    actionDelayVarp(): number; // resolved lazily: configs load after the preload
    fishingStat: number;
}

export function installSharkFishingObserver(engine: SharkEngine, playerName: string, emit: Emit) {
    const name = playerName.toLowerCase(), context: string[] = [], open: number[] = [], restores: (() => void)[] = [];
    let errors = 0, varp = -1, seq = 0;
    const fail = (error: unknown) => { errors++; try { emit({kind: 'observer-error', at: Date.now(), error: String(error)}); } catch {} };
    const send = (row: Record<string, unknown>) => { try { emit({at: Date.now(), ...row}); } catch (e) { errors++; } };
    const mine = (p: any) => !!p && typeof p.username === 'string' && p.username.toLowerCase() === name;
    const delay = (p: any) => { if (varp < 0) varp = engine.actionDelayVarp(); return varp >= 0 ? (p.vars?.[varp] ?? null) : null; };
    const ent = (t: any) => t ? {nid: t.nid ?? null, type: t.type ?? null, x: t.x, z: t.z, level: t.level} : null;
    const snap = (p: any) => ({player: p.username.toLowerCase(), clock: engine.world.currentTick, actionDelay: delay(p), delayed: !!p.delayed, target: ent(p.target),
        targetOp: p.targetOp ?? null, nextTarget: ent(p.nextTarget), x: p.x, z: p.z, level: p.level,
        fishingXp: p.stats?.[engine.fishingStat] ?? null, fishingLevel: p.levels?.[engine.fishingStat] ?? null});
    const res = (o: Outcome) => o.threw ? {threw: true, error: String(o.error)} : {threw: false};
    const peek = (state: any, n: number) => state.intStack.slice(state.isp - n, state.isp);
    // Scoped hook: filter to the fixture, push a context label for map-flag attribution, emit before/after.
    // id is assigned at call entry; parent is the enclosing observed call, so rows emitted at exit still name their nesting.
    const scoped = (label: string, who: (self: any, args: any[]) => any, extra: (self: any, args: any[], p: any) => object = () => ({}),
        late: (self: any, args: any[], p: any, o: Outcome) => object = () => ({})): Hooks<{p: any; id: number; parent: number | null; before: object; extra: object}> => ({
        before(self, args) {
            const p = who(self, args);
            if (!mine(p)) return undefined;
            const id = ++seq, parent = open.at(-1) ?? null;
            context.push(label); open.push(id);
            return {p, id, parent, before: snap(p), extra: extra(self, args, p)};
        },
        after(ctx, self, args, o) {
            if (!ctx) return;
            context.pop(); open.pop();
            send({kind: label, id: ctx.id, parent: ctx.parent, ...ctx.extra, ...late(self, args, ctx.p, o), ...res(o), before: ctx.before, after: snap(ctx.p)});
        },
    });
    const wrap = (owner: any, key: PropertyKey, hooks: Hooks<any>) => restores.push(wrapTransparent(owner, key, hooks, fail));

    wrap(engine.opNpc, 'handle', scoped('opnpc-in', (_s, a) => a[1], (_s, a) => {
        const npc = engine.npc(a[0]?.npcSlot);
        return {op: a[0]?.op ?? null, npcSlot: a[0]?.npcSlot ?? null, npc: npc ? {...ent(npc), delayed: !!npc.delayed} : null};
    }, (_s, _a, _p, o) => ({accepted: o.threw ? null : o.result})));
    wrap(engine.handlers, engine.opcodes.pOpnpc, scoped('p_opnpc', (_s, a) => a[0]?._activePlayer,
        (_s, a) => ({op: peek(a[0], 1)[0] ?? null, script: a[0]?.script?.name ?? null, npc: ent(a[0]?._activeNpc)})));
    wrap(engine.handlers, engine.opcodes.statRandom, scoped('stat-random', (_s, a) => {
        const state = a[0];
        return state && peek(state, 3)[0] === engine.fishingStat ? state._activePlayer : undefined;
    }, (_s, a, p) => ({args: peek(a[0], 3), level: p.levels?.[engine.fishingStat] ?? null, script: a[0]?.script?.name ?? null}),
    (_s, a, _p, o) => ({result: o.threw ? null : a[0].intStack[a[0].isp - 1]})));
    wrap(engine.player, 'processInteraction', scoped('interaction', self => self));
    wrap(engine.player, 'executeScript', scoped('script', self => self, (_s, a) => ({script: a[0]?.script?.name ?? null})));
    wrap(engine.player, 'stopAction', scoped('stop-action', self => self, () => ({context: [...context]})));
    wrap(engine.player, 'write', {
        before(self, args) {
            if (args[0]?.constructor?.name !== 'UnsetMapFlag' || !mine(self)) return;
            const frames = (Error().stack ?? '').split('\n').slice(2, 9).map(l => l.trim());
            send({kind: 'unset-map-flag', clock: engine.world.currentTick, parent: open.at(-1) ?? null, origin: [...context], frames});
        },
    });
    send({kind: 'installed', player: name, executionIds: true, targets: ['OpNpcHandler.handle', 'P_OPNPC', 'STAT_RANDOM', 'Player.processInteraction', 'Player.executeScript', 'Player.stopAction', 'Player.write(UnsetMapFlag)']});
    return {errors: () => errors, uninstall() { while (restores.length) restores.pop()!(); }};
}

// Engine binding. Loads modules in app.ts order (PackAll, then World) so cycles resolve exactly as in the real launch.
export async function installFromEngine(engineRoot: string, out: string, player: string) {
    const load = (p: string) => import(pathToFileURL(join(engineRoot, p)).href);
    await load('tools/pack/PackAll.ts');
    const World = (await load('src/engine/World.ts')).default;
    const ScriptRunner = (await load('src/engine/script/ScriptRunner.ts')).default;
    const {ScriptOpcodeMap} = await load('src/engine/script/ScriptOpcode.ts');
    const Player = (await load('src/engine/entity/Player.ts')).default;
    const OpNpcHandler = (await load('src/network/game/client/handler/OpNpcHandler.ts')).default;
    const VarPlayerType = (await load('src/cache/config/VarPlayerType.ts')).default;
    const {PlayerStatMap} = await load('src/engine/entity/PlayerStat.ts');
    const pOpnpc = ScriptOpcodeMap.get('P_OPNPC'), statRandom = ScriptOpcodeMap.get('STAT_RANDOM'), fishingStat = PlayerStatMap.get('FISHING');
    if (![pOpnpc, statRandom, fishingStat].every(Number.isInteger)) throw Error('diagnostic engine identifiers missing');
    return installSharkFishingObserver({world: World, handlers: ScriptRunner.HANDLERS, opcodes: {pOpnpc, statRandom}, player: Player.prototype,
        opNpc: OpNpcHandler.prototype, npc: slot => World.getNpc(slot), actionDelayVarp: () => VarPlayerType.getId('action_delay'), fishingStat},
        player, row => appendFileSync(out, JSON.stringify(row) + '\n'));
}

// Pinned memberfish.rs2 attempt_fish_shark: phase = %action_delay - map_clock when op3 runs.
export function op3Phase(phase: number): 'restart' | 'start' | 'roll-no-requeue' | 'dropped' {
    return phase < 0 ? 'restart' : phase === 4 ? 'start' : phase === 0 ? 'roll-no-requeue' : 'dropped';
}
// PlayerOps.ts STAT_RANDOM success chance out of256.
export function statChance(low: number, high: number, level: number) {
    const l = Math.min(level, 99);
    return (Math.floor((low * (99 - l)) / 98) + Math.floor((high * (l - 1)) / 98) + 1) / 256;
}

// Source decision: fishing.rs2 fish_roll + memberfish.rs2 op3/op5 -> installed diagnostic.
// Adapt the correlation, not the handler: STAT_RANDOM ends BEFORE inv_add/stat_advance.
// World.processClientsOut writes PLAYER_INFO before inventory/stats; Client's PLAYER_INFO
// handler publishes immediately, and inprocess increments its tick before collecting state.
// Thus the adjacent client effect belongs to the next publication, even when catch-up engine
// cycles finish before that publication is observed (retained wXS08P clocks352 and370).
// Bind the FIRST state change in the unchanged engine-XP epoch, not an elapsed-time window.
// One PLAYER_INFO per engine cycle also requires a single client-tick/map-clock offset for
// all credited effects. Never sort observations, skip a conflicting change or reuse credit.
// Attribution: the observer emits at call exit, so rows are post-order. With executionIds each row names its
// enclosing observed call (roll -> shark script -> interaction). Rows retained before executionIds use the
// post-order rule instead: the next execution row after the leaf STAT_RANDOM must be the enclosing script and
// the next after that its interaction; any other execution row in between is ambiguous, never skipped.
// Unrelated same-clock scripts (timers, changestat) are outside that chain and neither block nor supply effects.
export const SHARK_ACTION = /^\[opnpc[35],_memberfish\]$/;
const EXECUTION = new Set(['script', 'interaction', 'stat-random', 'opnpc-in']);
function sharkEffects(events: any[], trace: any[], xpRate: number) {
    const installed = events.filter(e => e?.kind === 'installed');
    const account = installed.length === 1 ? installed[0].player : undefined;
    const identity = typeof account === 'string' && account.length > 0;
    const byId = installed.length === 1 && installed[0].executionIds === true;
    const mine = (e: any) => [e.before, e.after].every(s => s && (s.player === undefined || s.player === account));
    const ticks = events.filter(e => e?.kind === 'interaction');
    const ids = new Map<number, any[]>();
    for (const e of events) if (EXECUTION.has(e?.kind) && Number.isSafeInteger(e.id)) ids.set(e.id, [...(ids.get(e.id) ?? []), e]);
    const parentOf = (e: any) => {
        const found = Number.isSafeInteger(e?.parent) ? ids.get(e.parent) ?? [] : [];
        return found.length === 1 && found[0].id < e.id ? found[0] : undefined;
    };
    const nextExecution = (e: any) => { const i = events.indexOf(e); return i < 0 ? undefined : events.slice(i + 1).find(x => EXECUTION.has(x?.kind)); };
    const usedScripts = new Set<any>(), usedTicks = new Set<any>(), usedClients = new Set<any>();
    const bindings: {clock: number; offset: number}[] = [];
    const rows = events.flatMap((roll, index) => {
        if (roll?.kind !== 'stat-random') return [];
        const clock = roll.before?.clock, errors: string[] = [];
        const bad = (condition: boolean, reason: string) => { if (!condition) errors.push(reason); };
        const unique = (e: any) => !byId || (Number.isSafeInteger(e?.id) && ids.get(e.id)?.length === 1);
        const action = byId ? parentOf(roll) : nextExecution(roll);
        const interaction = action && (byId ? parentOf(action) : nextExecution(action));
        bad(identity && mine(roll), 'missing or substituted account');
        bad(roll.threw === false && [0, 1].includes(roll.result) && roll.script === '[proc,fish_roll]'
            && JSON.stringify(roll.args) === '[10,3,40]', 'not a completed shark roll');
        bad(unique(roll) && events.filter(e => e?.kind === 'stat-random' && e.before?.clock === clock).length === 1, 'ambiguous roll attribution');
        bad(!!action && action.kind === 'script' && unique(action) && SHARK_ACTION.test(action.script) && action.threw === false && mine(action)
            && action.before?.clock === clock && events.indexOf(action) > index && !usedScripts.has(action), 'missing or ambiguous enclosing shark action');
        bad(!!interaction && interaction.kind === 'interaction' && unique(interaction) && interaction.threw === false && mine(interaction)
            && interaction.before?.clock === clock && (!byId || interaction.parent === null)
            && events.indexOf(interaction) > events.indexOf(action) && !usedTicks.has(interaction), 'missing enclosing interaction');
        if (action) usedScripts.add(action);
        if (interaction) usedTicks.add(interaction);
        const before = roll.before?.fishingXp, expected = roll.result === 1 ? 1100 * xpRate : 0;
        bad(Number.isSafeInteger(before) && Number.isFinite(xpRate) && xpRate > 0 && roll.after?.fishingXp === before
            && roll.before?.actionDelay === clock && roll.after?.clock === clock, 'contradictory opcode boundary');
        bad(!!action && action.before?.fishingXp === before && action.after?.fishingXp === before + expected
            && action.after?.clock === clock && action.before?.actionDelay === clock, 'missing or contradictory action XP');
        bad(!!interaction && interaction.before?.fishingXp === before && interaction.after?.fishingXp === before + expected
            && interaction.after?.clock === clock, 'contradictory interaction XP');
        let clientTick: number | null = null;
        if (roll.result === 1) {
            const next = ticks.filter(e => e.before?.clock === clock + 1), following = ticks.filter(e => e.before?.clock === clock + 2);
            const n = next.length === 1 ? next[0] : undefined, f = following.length === 1 ? following[0] : undefined;
            bad(!!n && !!f && n.threw === false && f.threw === false && mine(n) && mine(f)
                && events.indexOf(n) > events.indexOf(interaction) && events.indexOf(f) > events.indexOf(n)
                && n.before?.fishingXp === before + expected && n.after?.fishingXp === before + expected,
                'missing next-cycle XP observation');
            // The epoch ends at the first later interaction with different XP (including a
            // substituted non-shark gain), or the end of this fishing trace, whichever is first.
            // The last observed interaction bounds incomplete tails. No arbitrary extra cycles.
            const later = ticks.slice(ticks.indexOf(interaction) + 1);
            const mutation = later.find(e => e.before?.fishingXp !== before + expected || e.after?.fishingXp !== before + expected);
            const start = trace.findIndex(t => t.event === 'tick' && t.at >= roll.at);
            const tail = trace.slice(Math.max(0, start));
            const end = tail.findIndex(t => t.event === 'complete' || t.event === 'failure');
            const limit = Math.min(mutation?.at ?? Infinity, ticks.at(-1)?.at ?? -Infinity);
            const clients = tail.slice(0, end < 0 ? undefined : end).filter(t => t.event === 'tick' && t.at >= roll.at && t.at < limit);
            // Sequence is log order plus inprocess onGameTick: tick++ (one per row), collectBotState
            // (revision advances), then the onTick trace row. Date.now() has millisecond resolution, so
            // catch-up cycles can share it (GU1maC ticks404/405, 823/824, 1368/1369). Time may not go
            // back, but equal time alone neither orders nor separates two publications.
            const ordered = end >= 0 && clients.every((t, j) => Number.isSafeInteger(t.tick) && t.stateTick === t.tick
                && Number.isSafeInteger(t.revision) && Number.isFinite(t.at) && t.account === account && t.player?.name?.toLowerCase() === account
                && (j === 0 || t.tick === clients[j - 1].tick + 1
                    && t.revision > clients[j - 1].revision && t.at >= clients[j - 1].at));
            const changed = clients.filter((t, j) => j > 0 && (t.rawSharks !== clients[j - 1].rawSharks || t.fishing?.xp !== clients[j - 1].fishing?.xp));
            const c = changed.length === 1 ? changed[0] : undefined, p = c ? clients[clients.indexOf(c) - 1] : undefined;
            // Retain every engine observation through publication; gaps or a contradictory
            // intermediate cycle cannot be hidden by an otherwise matching client transition.
            const through = later.filter(e => e.at <= c?.at);
            const stable = through.length > 0 && through.every((e, j) => e.threw === false && mine(e)
                && e.before?.clock === clock + j + 1 && e.after?.clock === e.before.clock
                && e.before?.fishingXp === before + expected && e.after?.fishingXp === before + expected
                && e.at >= (j ? through[j - 1].at : interaction?.at));
            const spot = interaction?.before?.target;
            const selected = (t: any) => spot && t?.currentSelected?.index === spot.nid && t.currentSelected.id === spot.type
                && t.currentSelected.x === spot.x && t.currentSelected.z === spot.z;
            bad(ordered && stable && !!c && !!p && c.account === account && p.account === account
                && c.player?.name?.toLowerCase() === account && p.player?.name?.toLowerCase() === account
                && selected(c) && selected(p) && Number.isSafeInteger(p.rawSharks) && p.rawSharks >= 0
                && c.rawSharks === p.rawSharks + 1 && p.fishing?.xp === Math.floor(before / 10)
                && c.fishing?.xp === Math.floor((before + expected) / 10)
                && c.tick === p.tick + 1 && c.stateTick === c.tick && p.stateTick === p.tick
                && c.revision > p.revision && c.at >= p.at && p.at >= interaction?.at && c.at >= n?.at
                && !usedClients.has(c), 'missing, substituted or ambiguous client raw-shark/XP effect');
            if (c) { usedClients.add(c); clientTick = c.tick; bindings.push({clock, offset: c.tick - clock}); }
        }
        return [{clock, result: roll.result, script: action?.script ?? null, xpBefore: before, xpAfter: action?.after?.fishingXp,
            expectedXp: expected, clientTick, ok: errors.length === 0, errors}];
    });
    // A later, numerically similar catch cannot shift one binding to another output cycle.
    if (new Set(bindings.map(b => b.offset)).size > 1) for (const r of rows.filter(r => r.clientTick !== null)) {
        r.errors.push('inconsistent engine/client publication order'); r.ok = false;
    }
    return {ok: rows.length > 0 && rows.every(r => r.ok), rows};
}

// Joins engine rows with the worker's SHARK_FISH_TRACE rows. Reports observations, never a repair.
export function analyzeSharkDiagnostic(events: any[], workerLog: string, xpRate = 25) {
    const trace = workerLog.split(/\r?\n/).filter(l => l.startsWith('SHARK_FISH_TRACE ')).map(l => { try { return JSON.parse(l.slice(17)); } catch { return null; } }).filter(Boolean);
    const of = (k: string) => events.filter(e => e?.kind === k);
    const snapshots = (e: any) => !!e.before && !!e.after;
    const ticks = of('interaction').filter(snapshots), scripts = of('script').filter(snapshots), pOps = of('p_opnpc'), flags = of('unset-map-flag');
    const rolls = of('stat-random').filter(e => !e.threw && snapshots(e)).map(e => ({clock: e.before.clock, result: e.result, low: e.args?.[1], high: e.args?.[2], level: e.level, script: e.script}));
    const catches = rolls.filter(r => r.result === 1).map(r => r.clock);
    // Fishing-policy summaries use only memberfish actions and packets for their spot types. Shop or other NPC
    // operations stay in the raw trace and never mark fishing start, idle time or requeue failure.
    const fishScripts = scripts.filter(e => SHARK_ACTION.test(String(e.script)));
    const spotTypes = new Set(fishScripts.flatMap(e => [e.before.target?.type, e.after.target?.type]).filter(Number.isInteger));
    const opIn = of('opnpc-in').filter(e => snapshots(e) && spotTypes.has(e.npc?.type));
    const op3 = fishScripts.filter(e => String(e.script) === '[opnpc3,_memberfish]').map(e => {
        const phase = e.before.actionDelay - e.before.clock;
        return {clock: e.before.clock, phase, outcome: op3Phase(phase), requeued: e.after.target !== null, script: e.script};
    });
    const count = <T>(xs: T[], k: (x: T) => string) => xs.reduce((m, x) => (m[k(x)] = (m[k(x)] ?? 0) + 1, m), {} as Record<string, number>);
    const same = (a: any, b: any) => !!a && !!b && a.nid === b.nid && a.x === b.x && a.z === b.z;
    const start = fishScripts[0]?.before.clock, end = ticks.at(-1)?.before.clock;
    const bounds = start === undefined || end === undefined ? [] : [start, ...catches, end];
    const segments = bounds.slice(1).map((to, i) => {
        const from = bounds[i]!, inside = (c: number) => c > from && c <= to;
        const segTicks = ticks.filter(e => inside(e.before.clock));
        let spotChanges = 0;
        for (let j = 1; j < segTicks.length; j++) { const a = segTicks[j - 1].after.target, b = segTicks[j].after.target; if (a && b && !same(a, b)) spotChanges++; }
        const rs = rolls.filter(r => inside(r.clock)).map(r => r.clock);
        return {from, to, final: i === bounds.length - 2, ticks: to - from, rolls: rs.length, catches: rolls.filter(r => inside(r.clock) && r.result === 1).length,
            maxRollGap: rs.reduce((m, c, j) => Math.max(m, c - (j ? rs[j - 1]! : from)), 0),
            idleTicks: segTicks.filter(e => e.after.target === null).length,
            opInWhileActive: opIn.filter(e => inside(e.before.clock) && e.before.target !== null).length,
            refusedOpIn: opIn.filter(e => inside(e.before.clock) && e.accepted === false).length,
            op3: count(op3.filter(o => inside(o.clock)), o => o.outcome), spotChanges,
            missingSpot: segTicks.filter(e => e.before.target === null && e.after.target === null).length};
    });
    const dispatches = trace.filter((r: any) => r.event === 'dispatch');
    const matched = dispatches.map((d: any) => {
        const near = opIn.filter(e => e.op === 3 && Number.isFinite(d.at) && Math.abs(e.at - d.at) <= 3000).sort((a, b) => Math.abs(a.at - d.at) - Math.abs(b.at - d.at))[0];
        return {tick: d.tick, at: d.at, clock: near?.before.clock ?? null, accepted: near?.accepted ?? null, phase: near ? near.before.actionDelay - near.before.clock : null, activeBefore: near ? near.before.target !== null : null};
    });
    const expected = rolls.reduce((v, r) => v + statChance(r.low, r.high, r.level), 0);
    const effects = sharkEffects(events, trace, xpRate);
    const observed = {
        installed: of('installed').length === 1, observerErrors: of('observer-error').length, interactionTicks: ticks.length,
        fishingRolls: rolls.length, opIn: opIn.length, scripts: scripts.length, fishScripts: fishScripts.length,
        clientBegin: trace.some((r: any) => r.event === 'begin'), clientEnd: trace.some((r: any) => r.event === 'complete' || r.event === 'failure'),
        // Retain the published predicate name; now require the full source-ordered effect boundary.
        catchesWithXp: effects.ok,
    };
    const complete = observed.installed && observed.observerErrors === 0 && observed.interactionTicks > 0 && observed.fishingRolls > 0
        && observed.opIn > 0 && observed.scripts > 0 && observed.clientBegin && observed.clientEnd && observed.catchesWithXp;
    return {complete, observed, effects, rolls: {count: rolls.length, successes: catches.length, expectedSuccesses: expected, catchClocks: catches},
        op3: {outcomes: count(op3, o => o.outcome), mismatchedRequeue: op3.filter(o => o.requeued !== (o.outcome === 'restart' || o.outcome === 'start')).length, rows: op3},
        opIn: {count: opIn.length, refused: opIn.filter(e => e.accepted === false).length, whileActive: opIn.filter(e => e.before.target !== null).length},
        pOpnpc: count(pOps, e => `${e.script}->op${e.op}`), unsetMapFlag: count(flags, e => e.origin.join('>') || 'other'),
        segments, dispatches: {count: dispatches.length, unmatched: matched.filter((m: any) => m.clock === null).length, rows: matched}};
}

// Main engine thread only: the login/friend/logger worker threads must never load a second World.
if (!import.meta.main && isMainThread && process.env[DIAGNOSTIC_OUT] && process.env[DIAGNOSTIC_PLAYER])
    await installFromEngine(process.cwd(), process.env[DIAGNOSTIC_OUT]!, process.env[DIAGNOSTIC_PLAYER]!);
