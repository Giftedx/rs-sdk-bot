// Finite recovery target validation and active cloud inspection assignment checks.
export type RecoveryTarget = { account: string; attemptId: string; endedAt: number };
export type BoundedRecovery = { targets: RecoveryTarget[]; taskIds?: string[] };
export function validateBoundedRecovery(value: unknown): BoundedRecovery {
    const v = value as BoundedRecovery;
    if (!v || !Array.isArray(v.targets) || !v.targets.length || v.targets.length > 11
        || (v.taskIds !== undefined && (!Array.isArray(v.taskIds)
            || v.taskIds.length !== v.targets.length + 1 || new Set(v.taskIds).size !== v.taskIds.length
            || v.taskIds.some(id => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))))
        || v.targets.some(t => !t || !/^[A-Za-z0-9]{1,12}$/.test(t.account) || !/^\d{13}-\d{10}-\d{10}$/.test(t.attemptId)
            || !Number.isSafeInteger(t.endedAt) || t.endedAt < Number(t.attemptId.slice(0, 13)))
        || new Set(v.targets.map(t => t.account.toLowerCase())).size !== v.targets.length) throw Error('invalid bounded recovery scope');
    return v;
}
export function assertBoundedInspectionAssignments(accounts: string[], ownerJobs: any[]) {
    if (!Array.isArray(accounts) || !accounts.length || accounts.length > 11 || accounts.some(a => typeof a !== 'string' || !/^[A-Za-z0-9]{1,12}$/.test(a))
        || new Set(accounts.map(a => a.toLowerCase())).size !== accounts.length) throw Error('bounded inspection ownership unresolved');
    const selected = new Set(accounts.map(a => a.toLowerCase())), seen = new Set<string>();
    for (const j of ownerJobs) {
        const key = typeof j.account === 'string' ? j.account.toLowerCase() : '';
        if (!key || seen.has(key) || j.accounts || j.host || j.orchestrate || j.autopilot || j.standing || j.repeat !== false) throw Error('bounded inspection assignment changed');
        seen.add(key);
        if (selected.has(key)) {
            if (j.script !== 'scripts/aio-logistics.ts' || (j.args?.length && (j.args.length !== 1 || j.args[0] !== 'inspect')) || j.maxRestarts !== 0 || j.standingRetry !== false || j.env?.LOOT_WATCH !== '0' || j.env?.RANDOM_EVENTS !== '0' || j.env?.REQUIRE_BANK !== '1') throw Error('bounded inspection inspector changed');
        } else if (j.enabled !== false || j.script || j.role !== 'reserved') throw Error('bounded inspection reservation changed');
    }
    if (accounts.some(a => !seen.has(a.toLowerCase()))) throw Error('bounded inspection actor missing');
}
export function assertBoundedRecoveryAssignments(scope: BoundedRecovery, ownerJobs: any[]) {
    validateBoundedRecovery(scope);
    const allowed = new Set(scope.targets.map(t => t.account.toLowerCase()));
    for (const j of ownerJobs) {
        const accounts = j.accounts ?? [j.account];
        if (!Array.isArray(accounts) || accounts.length !== 1 || typeof accounts[0] !== 'string') throw Error('assignment outside bounded recovery scope');
        if (j.enabled !== false) {
            if (!allowed.has(accounts[0].toLowerCase()) || j.script !== 'scripts/session-check.ts' || j.repeat !== false) throw Error('assignment outside bounded recovery scope');
        }
    }
}
