// Start check of the AIO bench (aio-practice-bench.ts): is it safe to start practice engines on this machine now?
// The bench stops before its first engine when one of these is true:
//   1. another heavy job runs: a bun process outside this job that runs the bench, the gate or the test shards;
//   2. an engine port of this run has a listener;
//   3. the free memory is under the floor plus the engines that this run starts.
// The floor is the floor of scripts/heavy-admission.ts: the fleet's floor beside a swarm, the tool floor with none.
// `--wait <minutes>` on the bench waits for the three with a deadline, and `--force` skips the check.
// This file is tooling. No worker imports it, so a change here does not change a worker release.
import { canBind } from '../../packages/practice/src/ports';
import { floorGB, freeGB } from '../heavy-admission';

// The jobs that must not run two at a time on one machine (AGENTS.md, "Keep the loop fast").
export const HEAVY_SCRIPTS = ['aio-practice-bench.ts', 'ci-gate.ts', 'test-shards.ts'] as const;
export const BENCH_SCRIPT = 'aio-practice-bench.ts';
// The memory of one practice engine of the bench. The start is refused under the floor plus this much for each engine.
export const BENCH_ENGINE_GB = 0.9;
// The memory that the bench leaves for one case (the engine, the worker and its account tools) when it sizes the
// number of engines of a run.
export const BENCH_CASE_GB = 1.5;
// The exit code of a refused start. The bench exits with 0 when every case passes and with 1 when a case fails.
export const START_REFUSED_EXIT = 2;
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
    const need = f.floorGB + f.engines * BENCH_ENGINE_GB;
    if (f.freeGB < need) out.push(`${f.freeGB.toFixed(1)} GiB is free and the run needs ${need.toFixed(1)} GiB (the floor of ${f.floorGB} GiB and ${f.engines} ${f.engines === 1 ? 'engine' : 'engines'} of ${BENCH_ENGINE_GB} GiB)`);
    return out;
}
export const refusalLine = (problems: readonly string[]): string =>
    `bench: not started: ${problems.join('; ')}. Use --wait <minutes> to wait for a safe start, or --force to skip this check.`;

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
    return { busyPorts: plan.ports.filter(p => !canBind(p)), freeGB: freeGB(), floorGB: floorGB(plan.root), engines: plan.engines, selfPid: process.pid, procs: await procs };
}

// null when the start is safe, or the refusal line. With `waitMs` above 0 it reads the facts again each WAIT_STEP_MS
// until the start is safe or the time is over.
export async function admitStart(plan: StartPlan, waitMs = 0, deps: { read?: (plan: StartPlan) => Promise<StartFacts>; sleep?: (ms: number) => Promise<unknown>; now?: () => number; log?: (line: string) => void } = {}): Promise<string | null> {
    const read = deps.read ?? readStartFacts, sleep = deps.sleep ?? Bun.sleep, now = deps.now ?? Date.now, log = deps.log ?? console.error;
    const deadline = now() + waitMs;
    let said = '';
    for (;;) {
        const facts = await read(plan), problems = startProblems(facts);
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
