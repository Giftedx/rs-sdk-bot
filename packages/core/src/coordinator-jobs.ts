// The coordinator's own live jobs and settings. swarm.json holds only what the owner edits; the coordinator keeps
// the run jobs it installs, the delivery focus it adopts and the fleet expansion it grants in this untracked file.
// scripts/swarm.ts, scripts/fleet-agent.ts and the recovery permit read both files as one plan through mergedPlan.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const COORDINATOR_JOBS_FILE = '.practice/coordinator/jobs.json';
export type CoordinatorJobs = {
    // Jobs in install order. A job here takes its accounts away from the owner job that names them (mergeJobs).
    jobs: any[];
    coordination: { focusCapability?: string; focusSince?: number; lastExpansionAt?: number };
    // A granted expansion raises maxBots and coordination.maxLive while the owner's maxBots still equals `over`:
    // an owner edit of maxBots wins and discards the grant.
    expansion?: { maxBots: number; over: number };
    // Accounts whose standing jobs a controller rollout holds off until the current controller runs.
    paused?: string[];
};
export const coordinatorJobsPath = (base: string) => join(base, COORDINATOR_JOBS_FILE);
export function emptyCoordinatorJobs(): CoordinatorJobs { return { jobs: [], coordination: {} }; }
export function parseCoordinatorJobs(raw: string): CoordinatorJobs {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !Array.isArray(value.jobs)) throw Error('coordinator jobs file needs a jobs array');
    return { ...value, jobs: value.jobs, coordination: value.coordination && typeof value.coordination === 'object' ? value.coordination : {} };
}
export function readCoordinatorJobs(base: string): CoordinatorJobs {
    const file = coordinatorJobsPath(base);
    return existsSync(file) ? parseCoordinatorJobs(readFileSync(file, 'utf8')) : emptyCoordinatorJobs();
}
// On Windows a reader that holds the target open makes the rename fail for a moment.
export function writeCoordinatorJobs(base: string, value: CoordinatorJobs) {
    const file = coordinatorJobsPath(base), temporary = file + `.tmp-${process.pid}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value, null, 2));
    for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, file); return; } catch (e) {
            if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}
export const jobAccounts = (job: any): string[] => (job?.accounts ?? [job?.account]).filter((n: unknown): n is string => typeof n === 'string');
// The owner jobs minus the named accounts. A composed job that loses part of its participants is kept off: it cannot
// run without all of them, and installJob refuses that split before it happens.
export function shadowAssignments(jobs: readonly any[], accounts: readonly string[]): any[] {
    const taken = new Set(accounts.map(n => n.toLowerCase()));
    return jobs.flatMap(job => {
        const names = jobAccounts(job), remaining = names.filter(n => !taken.has(n.toLowerCase()));
        if (remaining.length === names.length) return [job];
        if (!remaining.length) return [];
        if (job.orchestrate) return [{ ...job, enabled: false }];
        return [{ ...job, accounts: remaining }];
    });
}
// One job list: the owner's jobs, then each coordinator job in install order, each taking its accounts first.
export function mergeJobs(ownerJobs: readonly any[], coordinatorJobs: readonly any[]): any[] {
    let merged = [...ownerJobs];
    for (const job of coordinatorJobs) merged = [...shadowAssignments(merged, jobAccounts(job)), job];
    return merged;
}
export function mergedPlan<P extends { maxBots: number; jobs: any[]; coordination?: any }>(plan: P, overlay: CoordinatorJobs): P {
    const granted = overlay.expansion && overlay.expansion.over === plan.maxBots ? overlay.expansion.maxBots : undefined;
    const coordination = plan.coordination === undefined && !Object.keys(overlay.coordination).length && granted === undefined ? undefined
        : { ...plan.coordination, ...Object.fromEntries(Object.entries(overlay.coordination).filter(([, v]) => v !== undefined)), ...(granted !== undefined ? { maxLive: granted } : {}) };
    const paused = new Set((overlay.paused ?? []).map(n => n.toLowerCase()));
    const jobs = mergeJobs(plan.jobs ?? [], overlay.jobs).map(j => paused.size && j.standing === true && j.enabled && jobAccounts(j).some(n => paused.has(n.toLowerCase())) ? { ...j, enabled: false } : j);
    return { ...plan, ...(granted !== undefined ? { maxBots: granted } : {}), ...(coordination !== undefined ? { coordination } : {}), jobs };
}
export function readMergedPlan(base: string) {
    return mergedPlan(JSON.parse(readFileSync(join(base, 'swarm.json'), 'utf8')), readCoordinatorJobs(base));
}
