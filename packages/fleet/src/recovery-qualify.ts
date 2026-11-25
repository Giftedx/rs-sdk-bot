// Hosted native recovery qualification for live session recovery.
// Live recovery needs a qualification for the current launch source (session-recovery.ts
// findCurrentNativeRecoveryQualification), and a merge that changes a launch file makes it stale. The PC runs no
// multi-minute practice proof beside the live fleet (AGENTS.md), so when the recovery pass defers an account for that
// reason, the watchdog dispatches scripts/measure/session-recovery-qualify.ts to the CI `measure` job on master. A later
// pass imports the delivery folders that the job keeps (its artifact holds .practice/hosted-rehearse/session-recovery)
// into .practice/deliveries, where the qualification check reads them. The check itself decides if they match the
// source. One run at a time, and at most one dispatch for one source in QUALIFY_RETRY_MS.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { atomicJson } from '../../core/src/plan-lock';
import { liveRoot } from '../../core/src/practice-paths';
import { cachedLaunchRevision } from '../../core/src/worker-release';
import { findCurrentNativeRecoveryQualification } from './session-recovery';

export const QUALIFY_SCRIPT = 'scripts/measure/session-recovery-qualify.ts';
export const QUALIFY_RETRY_MS = 30 * 60_000;
export type QualifyRun = { run: string; sha: string; source: string; at: number; state: 'dispatched' | 'imported' | 'failed' };
export const qualifyStateFile = (base: string): string => join(liveRoot(base), 'session-recovery', 'qualify.json');
export type Exec = (cmd: readonly string[], cwd: string) => { ok: boolean; out: string };
export type QualifyDeps = { exec?: Exec; source?: () => string; qualified?: (base: string, source: string) => boolean; scratch?: () => string };
// The folders that session-recovery-qualify.ts writes and copies for retention.
const DELIVERY = /^(?:session-recovery-only|owned-bank-observation)-\d{13}$/;

const defaultExec: Exec = (cmd, cwd) => {
    const r = Bun.spawnSync([...cmd], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 120_000, windowsHide: true });
    return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
};

function readQualifyRun(file: string): QualifyRun | null {
    try {
        const v = JSON.parse(readFileSync(file, 'utf8'));
        return /^\d{1,20}$/.test(v?.run) && typeof v.sha === 'string' && typeof v.source === 'string' && Number.isSafeInteger(v.at)
            && ['dispatched', 'imported', 'failed'].includes(v.state) ? v : null;
    } catch { return null; }
}

// Why no qualification run is dispatched now, or null to dispatch one.
export function qualifyDispatchWait(last: QualifyRun | null, source: string, now: number): string | null {
    if (last?.state === 'dispatched') return `run ${last.run} has not finished`;
    if (last && last.source === source && now - last.at < QUALIFY_RETRY_MS) {
        return `run ${last.run} for source ${source.slice(0, 12)} was dispatched ${Math.floor((now - last.at) / 60_000)} min ago (${last.state}); next dispatch after ${QUALIFY_RETRY_MS / 60_000} min`;
    }
    return null;
}

// The qualify script's delivery folders below `dir`, at any depth, in name order.
export function findDeliveries(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (DELIVERY.test(entry.name)) out.push(path);
        else out.push(...findDeliveries(path));
    }
    return out;
}

// Copies the delivery folders of a finished run into .practice/deliveries. A folder that is there already stays.
export function importQualifyRun(base: string, run: string, exec: Exec, scratch: () => string): string[] {
    const dir = mkdtempSync(join(scratch(), 'recovery-qualify-'));
    try {
        const download = exec(['gh', 'run', 'download', run, '-p', 'measure-*', '-D', dir], base);
        if (!download.ok) throw Error(`download: ${download.out.trim().slice(-160)}`);
        const deliveries = join(base, '.practice', 'deliveries');
        mkdirSync(deliveries, { recursive: true });
        const copied: string[] = [];
        for (const src of findDeliveries(dir)) {
            const to = join(deliveries, basename(src));
            if (existsSync(to)) continue;
            cpSync(src, to, { recursive: true });
            copied.push(basename(src));
        }
        return copied;
    } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function ensureHostedQualification(base: string, clock: () => number, log: (line: string) => void, deps: QualifyDeps = {}): void {
    const exec = deps.exec ?? defaultExec, say = (line: string) => log(`recovery qualification: ${line}`);
    const file = qualifyStateFile(base);
    let source: string;
    try { source = (deps.source ?? (() => cachedLaunchRevision(base)))(); }
    catch (e) { say(`source unreadable: ${String(e).slice(0, 160)}`); return; }
    let last = readQualifyRun(file);
    if (last?.state === 'dispatched') {
        const view = exec(['gh', 'run', 'view', last.run, '--json', 'status,conclusion'], base);
        let v: { status?: string; conclusion?: string | null } = {};
        try { v = JSON.parse(view.out); } catch { /* reported below */ }
        if (!view.ok || typeof v.status !== 'string') { say(`run ${last.run} unreadable: ${view.out.trim().slice(-160)}`); return; }
        if (v.status !== 'completed') { say(`run ${last.run} ${v.status}`); return; }
        if (v.conclusion === 'success') {
            let copied: string[];
            try { copied = importQualifyRun(base, last.run, exec, deps.scratch ?? tmpdir); }
            catch (e) { say(`run ${last.run} not imported: ${String(e).slice(0, 200)}`); return; }
            atomicJson(file, { ...last, state: 'imported' } satisfies QualifyRun);
            const ok = (deps.qualified ?? ((b, s) => findCurrentNativeRecoveryQualification(b, s) !== null))(base, source);
            say(`run ${last.run} imported ${copied.length ? copied.join(', ') : 'nothing new'}; ${ok ? 'it qualifies' : 'it does not qualify'} for source ${source.slice(0, 12)}`);
            return;
        }
        last = { ...last, state: 'failed' };
        atomicJson(file, last);
        say(`run ${last.run} ended ${v.conclusion ?? 'with no conclusion'}`);
    }
    const wait = qualifyDispatchWait(last, source, clock());
    if (wait) { say(`not dispatched: ${wait}`); return; }
    // The run checks out master: a main checkout behind it would get a qualification for a source it does not run.
    exec(['git', 'fetch', '-q', 'origin', 'master'], base);
    const head = exec(['git', 'rev-parse', 'HEAD'], base), remote = exec(['git', 'rev-parse', 'origin/master'], base);
    if (!head.ok || !remote.ok || head.out.trim() !== remote.out.trim()) { say('not dispatched: the main checkout is not at origin/master; a live update is due'); return; }
    const started = exec(['gh', 'workflow', 'run', 'CI', '--ref', 'master', '-f', `measure_script=${QUALIFY_SCRIPT}`], base);
    const run = /actions\/runs\/(\d+)/.exec(started.out)?.[1];
    if (!started.ok || !run) { say(`not dispatched: ${started.out.trim().slice(-160)}`); return; }
    const sha = head.out.trim();
    atomicJson(file, { run, sha, source, at: clock(), state: 'dispatched' } satisfies QualifyRun);
    say(`dispatched run ${run} at ${sha.slice(0, 10)} for source ${source.slice(0, 12)}`);
}
