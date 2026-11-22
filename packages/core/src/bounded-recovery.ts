// A finite submitted recovery queue never authorizes planning, adoption or another account's work.
export type RecoveryTarget = { account: string; attemptId: string; endedAt: number };
export type BoundedRecovery = { targets: RecoveryTarget[]; taskIds: string[] };
export function validateBoundedRecovery(value: unknown): BoundedRecovery {
    const v = value as BoundedRecovery;
    if (!v || !Array.isArray(v.targets) || !v.targets.length || v.targets.length > 11 || !Array.isArray(v.taskIds)
        || v.taskIds.length !== v.targets.length + 1 || new Set(v.taskIds).size !== v.taskIds.length
        || v.taskIds.some(id => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))
        || v.targets.some(t => !t || !/^[A-Za-z0-9]{1,12}$/.test(t.account) || !/^\d{13}-\d{10}-\d{10}$/.test(t.attemptId)
            || !Number.isSafeInteger(t.endedAt) || t.endedAt < Number(t.attemptId.slice(0, 13)))
        || new Set(v.targets.map(t => t.account.toLowerCase())).size !== v.targets.length) throw Error('invalid bounded recovery scope');
    return v;
}
export function assertBoundedRecoveryQueue(scope: BoundedRecovery, state: { tasks: any[]; planner?: unknown; pendingSubmission?: unknown }) {
    validateBoundedRecovery(scope);
    if (state.planner) throw Error('bounded recovery refuses an existing planner');
    if (state.pendingSubmission) throw Error('bounded recovery preserves an unresolved submission');
    for (const row of state.tasks.filter(r => r.status === 'pending' || r.status === 'running')) {
        const t = row.spec, target = scope.targets.find(n => n.account === t.account);
        if (!scope.taskIds.includes(t.id) || t.capability !== 'session-recovery-only'
            || !['qualify', 'run'].includes(t.kind) || t.accountFrom || t.participants || t.args?.length || t.env || t.launch || t.rule
            || t.kind === 'qualify' && (t.id!==scope.taskIds[0] || t.account || t.sessionRecovery || t.repairs?.length)
            || t.kind === 'run' && (!target || t.id!==scope.taskIds[scope.targets.indexOf(target)+1] || t.sessionRecovery?.account !== target.account || t.sessionRecovery?.endedAt !== target.endedAt
                || t.repairs?.length !== 1 || t.repairs[0].account !== target.account || t.repairs[0].endedAt !== target.endedAt))
            throw Error('task outside bounded recovery scope');
    }
}
export function assertBoundedInspectionAssignments(accounts: string[], ownerJobs: any[], overlay: any[]) {
    if(!Array.isArray(accounts)||!accounts.length||accounts.length>11||accounts.some(a=>typeof a!=='string'||!/^[A-Za-z0-9]{1,12}$/.test(a))
        ||new Set(accounts.map(a=>a.toLowerCase())).size!==accounts.length||overlay.length)throw Error('bounded inspection ownership unresolved');
    const selected=new Set(accounts.map(a=>a.toLowerCase())),seen=new Set<string>();
    for(const j of ownerJobs){
        const key=typeof j.account==='string'?j.account.toLowerCase():'';
        if(!key||seen.has(key)||j.accounts||j.host||j.orchestrate||j.autopilot||j.standing||j.repeat!==false)throw Error('bounded inspection assignment changed');
        seen.add(key);
        if(selected.has(key)){
            if(j.script!=='scripts/aio-logistics.ts'||(j.args?.length&&(j.args.length!==1||j.args[0]!=='inspect'))||j.maxRestarts!==0||j.standingRetry!==false||j.env?.LOOT_WATCH!=='0'||j.env?.RANDOM_EVENTS!=='0'||j.env?.REQUIRE_BANK!=='1')throw Error('bounded inspection inspector changed');
        }else if(j.enabled!==false||j.script||j.role!=='reserved')throw Error('bounded inspection reservation changed');
    }
    if(accounts.some(a=>!seen.has(a.toLowerCase())))throw Error('bounded inspection actor missing');
}
export function assertBoundedRecoveryAssignments(scope: BoundedRecovery, ownerJobs: any[], overlay: any[]) {
    validateBoundedRecovery(scope);
    const allowed = new Set(scope.targets.map(t => t.account.toLowerCase()));
    if(ownerJobs.some(j=>j.enabled!==false))throw Error('bounded recovery owner jobs must remain disabled');
    for(const j of overlay){
        const accounts=j.accounts??[j.account];
        if(!Array.isArray(accounts)||accounts.length!==1||typeof accounts[0]!=='string'||!allowed.has(accounts[0].toLowerCase())
            || j.enabled!==false&&(j.coordinatorOwner!=='coordinator'||j.script!=='scripts/session-check.ts'||j.repeat!==false
                ||!scope.taskIds.includes(j.coordinatorTask)))throw Error('assignment outside bounded recovery scope');
    }
}
