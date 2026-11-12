// The time budget and the profile of a bench run (scripts/measure/aio-practice-bench.ts).
// - Budget: a run is at most BUDGET_MIN minutes (default 10, owner rule: a bench over 5-10 minutes is too long). The
//   bench estimates the run from the last wall time of each case (.practice/aio-bench/elapsed.json), refuses a
//   selection over the budget before its first engine, and starts no case after the deadline.
// - Profile: the lockstep ack file of the bench bots (SIM_ACK_FILE, packages/core/src/inprocess.ts) and the engine's
//   wait lines (SIM_STAT_FILE, engine World.ts) give where the wall time of one case went.
import {existsSync, readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export const BUDGET_MIN = 10, BUDGET_EXIT = 3;
// A case with no recorded time: the median wall time of a case on this PC is under a minute.
export const UNKNOWN_CASE_MS = 60_000;
export const ELAPSED_FILE = '.practice/aio-bench/elapsed.json';

export function readElapsed(file = ELAPSED_FILE): Record<string, number> {
    try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
export function recordElapsed(key: string, ms: number, file = ELAPSED_FILE): void {
    if (!(ms > 0)) return;
    const all = readElapsed(file);
    all[key] = Math.round(ms);
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(Object.entries(all).sort()), null, 1));
    renameSync(file + '.tmp', file);
}

// The wall time of a run: the cases to run (not kept) on `engines` engines, longest first, each to the engine that is
// free first. Kept results cost nothing.
export function estimateRun(keys: readonly string[], elapsed: Readonly<Record<string, number>>, engines: number) {
    const each = keys.map(key => ({key, ms: elapsed[key] ?? UNKNOWN_CASE_MS, known: key in elapsed})).sort((a, b) => b.ms - a.ms);
    const lanes = Array<number>(Math.max(1, engines)).fill(0);
    for (const c of each) { const i = lanes.indexOf(Math.min(...lanes)); lanes[i]! += c.ms; }
    return {ms: Math.max(0, ...lanes), each, unknown: each.filter(c => !c.known).length};
}

// The refusal line of a run over its budget, or null: the heaviest cases are the ones to cut or to shorten.
export function budgetRefusal(estimate: ReturnType<typeof estimateRun>, budgetMin: number, engines: number): string | null {
    if (estimate.ms <= budgetMin * 60_000) return null;
    const heavy = estimate.each.slice(0, 8).map(c => `${c.key} ${Math.round(c.ms / 1000)} s${c.known ? '' : ' (no record)'}`).join(', ');
    return `BENCH_BUDGET refused: ${estimate.each.length} cases on ${engines} engines estimate ${(estimate.ms / 60_000).toFixed(1)} min, budget ${budgetMin} min. `
        + `Narrow the pattern, shorten a case (a later start state), or pass --over-budget. Heaviest: ${heavy}`;
}

// The client side: one ACK_STAT line per bench session (inprocess.ts), summed over the sessions of the case.
export function parseAckStats(text: string) {
    const sum = {sessions: 0, ticks: 0, held: 0, heldMs: 0, capped: 0, pumpMs: 0, stateMs: 0, scriptMs: 0};
    for (const m of text.matchAll(/^ACK_STAT (\{.*\})$/gm)) {
        try { const j = JSON.parse(m[1]!); sum.sessions++; for (const k of ['ticks', 'held', 'heldMs', 'capped', 'pumpMs', 'stateMs', 'scriptMs'] as const) sum[k] += Number(j[k]) || 0; } catch { /* a cut line */ }
    }
    return sum;
}
// The engine side: one line per 25 ticks with the mean wait and its cause. A window with a login, a logout or no
// client counts as startup and end; the rest is the game.
export function parseSimStat(text: string) {
    let startupMs = 0, gameMs = 0, gameTicks = 0, windows = 0;
    for (const m of text.matchAll(/waited ([\d.]+) ms each \((\d+) for an ack, (\d+) for login or logout, (\d+) with no client\)/g)) {
        const ms = Number(m[1]) * 25; windows++;
        if (Number(m[3]) > 0 || Number(m[4]) > 0) startupMs += ms; else { gameMs += ms; gameTicks += 25; }
    }
    return {windows, startupMs: Math.round(startupMs), gameMs: Math.round(gameMs), gameMsPerTick: gameTicks ? +(gameMs / gameTicks).toFixed(1) : 0};
}
// The text appended to a file since `from` bytes.
export function readSince(file: string, from: number): string {
    if (!existsSync(file)) return '';
    const all = readFileSync(file);
    return all.subarray(Math.min(from, all.length)).toString('utf8');
}
