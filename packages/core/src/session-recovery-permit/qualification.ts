// Native controller qualification evidence verification and fleet heartbeat ownership resolution.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { FLEET_HEARTBEAT_MAX_MS, same, sha, type EvidenceRef } from './request';

export function evidence(ref: EvidenceRef, base: string) {
    if (!ref || typeof ref.path !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw Error('recovery qualification missing');
    const path = realpathSync(resolve(base, ref.path)), allowed = realpathSync(resolve(base, '.practice/deliveries')) + sep;
    if (!path.startsWith(allowed)) throw Error('recovery qualification outside delivery');
    const bytes = readFileSync(path); if (sha(bytes) !== ref.sha256) throw Error('recovery qualification changed'); return JSON.parse(bytes.toString('utf8'));
}

export const NATIVE_RECOVERY_CHECKS = ['offline', 'orphan', 'modal', 'authFailure', 'cooldown', 'partial', 'timeout', 'lateCallback', 'ownership', 'stop', 'singleUse', 'stock', 'completed'] as const;

// A native proof names, for every check, the observed cases, their proof level and the raw saved files behind them.
// Boolean flags alone are refused. Every evidence file must stay inside the proof directory at its recorded hash.
export function verifyNativeRecoveryProof(proof: any, proofDirectory: string, expected: { runtimeRevision: string; runnerSha256: string }) {
    const fail = (why: string) => { throw Error('recovery lacks current controller-native qualification: ' + why); };
    if (proof?.ok !== true || proof.level !== 'native-controller-recovery' || proof.runtimeRevision !== expected.runtimeRevision || proof.runnerSha256 !== expected.runnerSha256) fail('report');
    if (!Array.isArray(proof.cases)) fail('cases');
    const root = realpathSync(proofDirectory) + sep, cases = new Map<string, any>();
    for (const c of proof.cases) { if (typeof c?.id !== 'string' || cases.has(c.id)) fail('case identity'); cases.set(c.id, c); }
    const file = (e: any) => {
        if (typeof e?.path !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256 ?? '') || /^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)/.test(e.path)) fail('evidence reference');
        let path = ''; try { path = realpathSync(resolve(proofDirectory, e.path)); } catch { fail('evidence missing'); }
        if (!path.startsWith(root)) fail('evidence outside proof'); if (sha(readFileSync(path)) !== e.sha256) fail('evidence changed');
    };
    for (const key of NATIVE_RECOVERY_CHECKS) {
        const check = proof.checks?.[key];
        if (!check || check.ok !== true || typeof check.level !== 'string' || !/^native-/.test(check.level) || !Array.isArray(check.cases) || !check.cases.length || !Array.isArray(check.evidence) || !check.evidence.length) fail(key);
        for (const id of check.cases) { const c = cases.get(id); if (!c || c.ok !== true || typeof c.level !== 'string' || !/^native-/.test(c.level) || !Array.isArray(c.evidence) || !c.evidence.length) fail(key + ' case ' + id); c.evidence.forEach(file); }
        check.evidence.forEach(file);
    }
    return true;
}

export const FLEET_REFUSALS = ['missing', 'malformed', 'controller', 'future', 'stale', 'account-active'] as const;

// The controller publishes fleet state from its own process. The age is measured from a clock read taken after the
// fleet read, never from an earlier one, and FLEET_HEARTBEAT_MAX_MS bounds it.
export function assertFleetResolved(path: string, account: string, controllerPid: number, clock: () => number = Date.now) {
    const refuse = (field: (typeof FLEET_REFUSALS)[number]) => { throw Error('recovery fleet ownership unresolved: ' + field); };
    let raw: string; try { raw = readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('missing'); throw error; }
    let fleet: any; try { fleet = JSON.parse(raw); } catch { refuse('malformed'); }
    const observedAt = clock();
    if (!fleet || typeof fleet !== 'object' || Array.isArray(fleet)) refuse('malformed');
    if (fleet.schemaVersion === 1 && Number.isFinite(fleet.emittedAt) && fleet.accounts && typeof fleet.accounts === 'object' && !Array.isArray(fleet.accounts)) {
        if (fleet.controllerPid !== undefined && fleet.controllerPid !== controllerPid) refuse('controller');
        if (observedAt - fleet.emittedAt < 0) refuse('future');
        if (observedAt - fleet.emittedAt > FLEET_HEARTBEAT_MAX_MS) refuse('stale');
        for (const [k, row] of Object.entries(fleet.accounts as Record<string, any>)) {
            if (!same(k, account) && !same(row?.account, account)) continue;
            if (row?.activeJob != null || /^(?:running|starting|stopping)/.test(typeof row?.status === 'string' ? row.status : '')) refuse('account-active');
        }
        return;
    }
    if (!Number.isFinite(fleet.at) || !Array.isArray(fleet.jobs) || fleet.jobs.some((j: any) => !j || typeof j !== 'object')) refuse('malformed');
    if (fleet.controllerPid !== controllerPid) refuse('controller');
    if (observedAt - fleet.at < 0) refuse('future');
    if (observedAt - fleet.at > FLEET_HEARTBEAT_MAX_MS) refuse('stale');
    if (fleet.jobs.some((j: any) => (same(j.account, account) || Array.isArray(j.accounts) && j.accounts.some((a: unknown) => same(a, account)))
        && /^(?:running|starting|stopping)/.test(typeof j.state === 'string' ? j.state : ''))) refuse('account-active');
}
