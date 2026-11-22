// Start check of the AIO bench (aio-practice-bench.ts): is it safe to start practice engines on this machine now?
// The bench stops before its first engine when one of these is true:
//   1. another heavy job runs: a bun process outside this job that runs the bench, the gate or the test shards;
//   2. an engine port of this run has a listener;
//   3. the free memory is under the floor plus the engines that this run starts.
// The floor is the floor of scripts/heavy-admission.ts: the fleet's floor beside a swarm, the tool floor with none.
// `--wait <minutes>` on the bench waits for the three with a deadline, and `--force` skips the check.
// Beside a live fleet (a swarm that writes its state) the memory rule is stricter and no flag turns it off:
//   - each engine counts as a whole case (BENCH_CASE_GB: the engine, the worker and its tools);
//   - the run also leaves the swarm's reserve for the bots that it starts now;
//   - the run has LIVE_MAX_ENGINES engines at most;
//   - during the run the bench reads the free memory again (fleetStop): under the floor plus the reserve it stops its
//     engines and ends with FLEET_STOP_EXIT. A stalled tick disconnects real accounts; a stopped bench loses a run.
// This file is tooling. No worker imports it, so a change here does not change a worker release.
import { canBind } from '../../packages/practice/src/ports';
import { BENCH_CASE_GB, BENCH_ENGINE_GB, BENCH_FLEET_STOP_EXIT, BENCH_START_REFUSED_EXIT, benchStartGB } from '../../packages/core/src/memory';
import { fleet, floorGB, freeGB, type Fleet } from '../../packages/core/src/heavy-admission';
import { FREE_FLOOR_GB } from '../../packages/core/src/memory';

// The jobs that must not run two at a time on one machine (AGENTS.md, "Keep the loop fast").
export const HEAVY_SCRIPTS = ['aio-practice-bench.ts', 'ci-gate.ts', 'test-shards.ts'] as const;
export const BENCH_SCRIPT = 'aio-practice-bench.ts';
// The memory of one practice engine of the bench and the memory that it leaves for one case beside a fleet, and the
// rule for a start (packages/core/src/memory.ts: the delivery checks that run the bench read the same rule).
export { BENCH_CASE_GB, BENCH_ENGINE_GB };
// The exit code of a refused start. The bench exits with 0 when every case passes and with 1 when a case fails.
export const START_REFUSED_EXIT = BENCH_START_REFUSED_EXIT;
// The engines of one bench beside a live fleet, and the exit code of a bench that stopped to give the fleet its memory.
export const LIVE_MAX_ENGINES = 4;
export const FLEET_STOP_EXIT = BENCH_FLEET_STOP_EXIT;
export const WAIT_STEP_MS = 10_000;

export type Proc = { pid: number; ppid: number; name: string; startedAt: number; commandLine: string };
export type StartFacts = {
    // Every process of the machine, or null when the list was not read (the check for another heavy job then says nothing).
    procs: readonly Proc[] | null;
    selfPid: number;
    // The engine ports of this run that have a listener.
    busyPorts: readonly number[];
    freeGB: number;
    floorGB: number;
    // The engines that this run starts at one time.
    engines: number;
    // The live fleet of this machine, when a swarm runs.
    fleet?: Fleet | null;
};

// The heavy script that a bun process runs, or null: the first argument that is not an option, after `run`.
// A script name later in the command line is an argument (a type check of ci-gate.ts is not a gate).
export function heavyScript(proc: Pick<Proc, 'name' | 'commandLine'>): string | null {
    if (!/^bun(\.exe)?$/i.test(proc.name)) return null;
    const tokens = (proc.commandLine.match(/"[^"]*"|\S+/g) ?? []).map(t => t.replace(/^"|"$/g, ''));
    // The program is the first token that ends in `bun` or `bun.exe`: a path with a space and no quotes is two tokens.
    const program = tokens.findIndex(t => /(^|[\\/])bun(\.exe)?$/i.test(t));
    const entry = tokens.slice(program + 1).find(t => !t.startsWith('-') && t !== 'run');
    const file = entry?.split(/[\\/]/).pop();
    return HEAVY_SCRIPTS.find(s => s === file) ?? null;
}

// The system gives the id of an ended process to a later process, so a parent is real only when it started before
// its child.
function parentOf(byPid: ReadonlyMap<number, Proc>, proc: Proc): Proc | null {
    const parent = byPid.get(proc.ppid);
    return parent && parent.pid !== proc.pid && parent.startedAt <= proc.startedAt ? parent : null;
}
// The process and each process above it, nearest first.
function lineage(byPid: ReadonlyMap<number, Proc>, pid: number): Proc[] {
    const out: Proc[] = [], seen = new Set<number>();
    for (let p = byPid.get(pid) ?? null; p && !seen.has(p.pid); p = parentOf(byPid, p)) { out.push(p); seen.add(p.pid); }
    return out;
}
// The processes of one job: the process, each process above it and each process under it. A bench that `--seeds`,
// `--watch` or a test started is a part of the job that started it.
export function ownJob(procs: readonly Proc[], selfPid: number): Set<number> {
    const byPid = new Map(procs.map(p => [p.pid, p]));
    const line = lineage(byPid, selfPid);
    const own = new Set([selfPid, ...line.map(p => p.pid)]);
    // Everything under the nearest bench above this one is the job: the seed children of one --seed-jobs run are
    // siblings, and each saw the other as a second heavy job and refused to start (exit 2). Only a bench parent
    // joins its children: two benches that two test shards of one gate start stay two jobs.
    const parentBench = line.slice(1).find(p => heavyScript(p) === BENCH_SCRIPT)?.pid;
    const under = new Set([selfPid, ...(parentBench !== undefined ? [parentBench] : [])]);
    for (let grew = true; grew;) {
        grew = false;
        for (const p of procs) if (!under.has(p.pid) && under.has(parentOf(byPid, p)?.pid ?? -1)) { under.add(p.pid); grew = true; }
    }
    for (const pid of under) own.add(pid);
    return own;
}
// When the job of a process started: the start of the oldest heavy process in its lineage, or its own start.
function jobStart(byPid: ReadonlyMap<number, Proc>, pid: number): number {
    const line = lineage(byPid, pid), heavy = line.filter(p => heavyScript(p));
    return Math.min(...(heavy.length ? heavy : line.slice(0, 1)).map(p => p.startedAt), Infinity);
}

// The heavy jobs of other owners that count against this start. A bench that started after this job does not
// count: it runs this check, finds this job and stops or waits. So of two benches that start at one time the first
// runs, and a bench that waits does not stop the job that it waits for.
export function otherHeavyJobs(procs: readonly Proc[], selfPid: number): { pid: number; script: string }[] {
    const byPid = new Map(procs.map(p => [p.pid, p])), own = ownJob(procs, selfPid), mine = jobStart(byPid, selfPid);
    const out: { pid: number; script: string }[] = [];
    for (const p of procs) {
        const script = heavyScript(p);
        if (!script || own.has(p.pid)) continue;
        const theirs = jobStart(byPid, p.pid);
        if (script === BENCH_SCRIPT && (theirs > mine || (theirs === mine && p.pid > selfPid))) continue;
        out.push({ pid: p.pid, script });
    }
    return out.sort((a, b) => a.pid - b.pid);
}

// Why the bench must not start now: one text for each cause, and an empty list when the start is safe.
export function startProblems(f: StartFacts): string[] {
    const out: string[] = [];
    const others = f.procs ? otherHeavyJobs(f.procs, f.selfPid) : [];
    if (others.length) out.push(`another heavy job runs (${others.map(o => `pid ${o.pid} ${o.script}`).join(', ')})`);
    if (f.busyPorts.length) out.push(`port ${f.busyPorts.join(', ')} has a listener`);
    out.push(...memoryProblems(f));
    return out;
}
// The memory part of the check. Beside a live fleet it also holds with --force.
export function memoryProblems(f: StartFacts): string[] {
    const out: string[] = [], each = f.fleet ? BENCH_CASE_GB : BENCH_ENGINE_GB, reserve = f.fleet?.reserveGB ?? 0;
    const need = benchStartGB({ floorGB: f.floorGB, reserveGB: reserve, engines: f.engines, fleet: !!f.fleet });
    const beside = f.fleet ? `, beside ${f.fleet.bots} live ${f.fleet.bots === 1 ? 'bot' : 'bots'}${reserve ? ` with ${reserve.toFixed(1)} GiB held for bot starts` : ''}` : '';
    if (f.freeGB < need) out.push(`${f.freeGB.toFixed(1)} GiB is free and the run needs ${need.toFixed(1)} GiB (the floor of ${f.floorGB} GiB and ${f.engines} ${f.engines === 1 ? 'engine' : 'engines'} of ${each} GiB${beside})`);
    if (f.fleet && f.engines > LIVE_MAX_ENGINES) out.push(`${f.engines} engines beside the live fleet, ${LIVE_MAX_ENGINES} at most (--parallel ${LIVE_MAX_ENGINES})`);
    return out;
}
// During a run beside a live fleet: the reason to stop now, or null. The engines of the run are in the free memory
// already, so the rule is the floor and the swarm's reserve alone.
export function fleetStop(f: Pick<StartFacts, 'freeGB' | 'floorGB' | 'fleet'>): string | null {
    if (!f.fleet) return null;
    const need = f.floorGB + f.fleet.reserveGB;
    return f.freeGB < need ? `bench: stopped: ${f.freeGB.toFixed(1)} GiB is free beside ${f.fleet.bots} live ${f.fleet.bots === 1 ? 'bot' : 'bots'} and the fleet needs ${need.toFixed(1)} GiB (the floor of ${f.floorGB} GiB${f.fleet.reserveGB ? ` and ${f.fleet.reserveGB.toFixed(1)} GiB for bot starts` : ''}). Run the cases on a hosted runner: bun tools/hosted-bench.ts '<pattern>'.` : null;
}
// The second signal for a live fleet: the supervisor of each live bot in the process list (packages/practice/src/
// supervise.ts and supervise-host.ts start a swarm worker). A swarm that hangs or dies can stop writing its state for
// longer than SWARM_FRESH_MS while its bots still run; the state file alone would then read as "no fleet" and the floor
// would fall to the tool floor.
export function liveBotProcs(procs: readonly Proc[] | null): number {
    return (procs ?? []).filter(p => /bun/i.test(p.name) && /[\\/]practice[\\/]src[\\/]supervise(?:-host)?\.ts/.test(p.commandLine)).length;
}
// The fleet of the swarm state, or of the process list when the state is stale, with the fleet's floor.
export function fleetFacts(root: string, bots: number, free = freeGB()): Pick<StartFacts, 'freeGB' | 'floorGB' | 'fleet'> {
    const state = fleet(root);
    if (state) return { freeGB: free, floorGB: FREE_FLOOR_GB, fleet: state };
    return bots > 0 ? { freeGB: free, floorGB: FREE_FLOOR_GB, fleet: { bots, reserveGB: 0 } } : { freeGB: free, floorGB: floorGB(root), fleet: null };
}
// `bots`: the live bot supervisors seen at the start check of this run (the watch does not read the process list again).
export const readFleetFacts = (root: string, bots = 0): Pick<StartFacts, 'freeGB' | 'floorGB' | 'fleet'> => fleetFacts(root, bots);
export const refusalLine = (problems: readonly string[]): string =>
    `bench: not started: ${problems.join('; ')}. Use --wait <minutes> to wait for a safe start, or --force to skip this check. Beside live bots run the cases on hosted runners: bun tools/hosted-bench.ts '<pattern>'.`;

// The lines `pid|parent pid|name|start in Unix ms|command line` and a last line `read`, which proves that the
// query ran to its end. null when that line is missing.
export function parseProcs(text: string): Proc[] | null {
    const lines = text.trim().split(/\r?\n/);
    if (lines.pop()?.trim() !== 'read') return null;
    const out: Proc[] = [];
    for (const line of lines) {
        const [pid, ppid, name, at, ...cmd] = line.split('|');
        if (!Number.isSafeInteger(Number(pid)) || name === undefined) continue;
        out.push({ pid: Number(pid), ppid: Number(ppid), name, startedAt: Number(at) || 0, commandLine: cmd.join('|').trim() });
    }
    return out;
}
const PROC_QUERY = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,CommandLine | ForEach-Object { $at = 0; if ($_.CreationDate) { $at = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }; '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $at, $_.CommandLine }; 'read'";
// One read of the process table of Windows (about 1 s: one PowerShell start). null on another system, or when the
// read fails or takes more than 10 s.
export async function readProcs(): Promise<Proc[] | null> {
    if (process.platform !== 'win32') return null;
    try {
        const child = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', PROC_QUERY], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
        const hung = setTimeout(() => child.kill(), 10_000);
        const text = await new Response(child.stdout).text().finally(() => clearTimeout(hung));
        return (await child.exited) === 0 ? parseProcs(text) : null;
    } catch { return null; }
}

export type StartPlan = { root: string; ports: readonly number[]; engines: number };
export async function readStartFacts(plan: StartPlan): Promise<StartFacts> {
    const procs = readProcs(); // starts first: the port and memory reads take its time
    const list = await procs;
    return { busyPorts: plan.ports.filter(p => !canBind(p)), engines: plan.engines, selfPid: process.pid, procs: list, ...fleetFacts(plan.root, liveBotProcs(list)) };
}

// null when the start is safe, or the refusal line. With `waitMs` above 0 it reads the facts again each WAIT_STEP_MS
// until the start is safe or the time is over.
export async function admitStart(plan: StartPlan, waitMs = 0, deps: { read?: (plan: StartPlan) => Promise<StartFacts>; sleep?: (ms: number) => Promise<unknown>; now?: () => number; log?: (line: string) => void; memoryOnly?: boolean; seen?: (facts: StartFacts) => void } = {}): Promise<string | null> {
    const read = deps.read ?? readStartFacts, sleep = deps.sleep ?? Bun.sleep, now = deps.now ?? Date.now, log = deps.log ?? console.error;
    const deadline = now() + waitMs;
    let said = '';
    for (;;) {
        // memoryOnly (--force): the check for another job and for the ports is off; the memory rule beside a live fleet stays.
        const facts = await read(plan), problems = deps.memoryOnly ? (facts.fleet ? memoryProblems(facts) : []) : startProblems(facts);
        deps.seen?.(facts);
        if (!facts.procs && !said && process.platform === 'win32') log('bench: the process list was not read, so the check for another heavy job did not run');
        if (!problems.length) return null;
        const left = deadline - now();
        if (left <= 0) return refusalLine(problems);
        // One line for each new set of causes. A change of the free memory alone is not a new cause.
        const text = problems.join('; '), causes = text.replace(/[\d.]+ GiB is free/, '');
        if (causes !== said) log(`bench: waiting, ${Math.ceil(left / 60_000)} min at most: ${text}`);
        said = causes;
        await sleep(Math.min(WAIT_STEP_MS, left));
    }
}
