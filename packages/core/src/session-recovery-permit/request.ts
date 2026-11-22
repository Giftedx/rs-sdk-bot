// Recovery permit schema constants, boundary guards, request validation, and permit directory layout.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownerPlanPath } from '../coordinator-jobs';
import { isLocalServer } from '../localserver';
import type { ProcessStarts } from '../session-takeover';
import { RESERVED_ACCOUNTS } from '../specialist-boards';

export const RECOVERY_SCHEMA = 'session-recovery/1';
export const RECOVERY_BINDING_MS = 45000;
// The controller heartbeat (.practice/swarm-state.json, written every 2 s) counts as current for this long. A heartbeat
// older than this means the controller stalled or died, so the window stays short; the checks between a fleet read and
// its use must stay fast. The controller's own heartbeat cannot advance while it issues and binds synchronously, so
// the launch reuses the issue-time process observations at binding (launchObservations) and the source check is cached.
export const FLEET_HEARTBEAT_MAX_MS = 10000;
export const RECOVERY_SCRIPT = 'packages/core/src/session-recovery.ts';

export type RecoveryRequest = {
    schema: typeof RECOVERY_SCHEMA;
    account: string;
    server: string;
    runId: string;
    nonce: string;
    endedAt: number;
    source: string;
};
export type EvidenceRef = { path: string; sha256: string };
export type ControlledRecoveryRequest = RecoveryRequest & {
    kind: 'session-recovery';
    qualification: { delivery: EvidenceRef; proof: EvidenceRef };
};
export type RecoveryPermitChecks = {
    now?: () => number;
    matches?: (pid: number, marker: string) => boolean;
    source?: () => string;
    capability?: (capability: unknown) => string | undefined;
    nativeFixture?: boolean;
    processStarts?: ProcessStarts;
    pidAlive?: (pid: number) => boolean;
};
export type ProducerRef = { attemptId: string; sha256: string | null };
export type Permit = {
    schema: 'session-recovery-permit/1';
    request: ControlledRecoveryRequest;
    controller: { pid: number; nonce: string; source: string };
    issuedAt: number;
    expiresAt: number;
    runnerSha256: string;
    nativeFixture: boolean;
    completedEnd?: unknown;
    missionRevision?: string;
    producerHistory?: ProducerRef[];
};

export const repoRoot = resolve(import.meta.dir, '../../../..');
export const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
export const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function assertNativeFixtureRoot(base: string, server: string) {
    try {
        if (!isLocalServer(server)) throw Error('not local');
        const key = (p: string) => { const v = p.replaceAll('\\', '/').replace(/\/+$/, ''); return process.platform === 'win32' ? v.toLowerCase() : v; };
        const repo = key(realpathSync(repoRoot)), actual = key(realpathSync(base));
        const controlPath = resolve(repoRoot, '.practice/coordinator'), control = key(existsSync(controlPath) ? realpathSync(controlPath) : controlPath);
        const inside = (p: string, parent: string) => p === parent || p.startsWith(parent + '/');
        if (actual === repo || inside(actual, control)) throw Error('production root');
        const privatePath = (path: string) => {
            try {
                const info = lstatSync(path);
                if (info.isSymbolicLink()) throw Error('control links are not private fixtures');
                if (info.isDirectory()) for (const child of readdirSync(path)) privatePath(join(path, child));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        };
        privatePath(join(base, '.practice')); privatePath(join(base, 'swarm.json')); privatePath(ownerPlanPath(base));
        const candidate = join(base, '.practice/coordinator');
        if (existsSync(candidate) && inside(key(realpathSync(candidate)), control)) throw Error('production control alias');
    } catch {
        throw Error('native fixture boundary invalid');
    }
}

export function assertRecoveryNotStopped(account: string, base: string, present: (path: string) => boolean = existsSync) {
    for (const root of new Set([resolve(base), repoRoot]))
        for (const flag of ['stop-coordinator', 'stop-swarm', 'stop-' + account]) if (present(join(root, '.practice', flag))) throw Error('recovery owner stopped');
}

export function validateRecoveryRequest(r: any): asserts r is RecoveryRequest {
    if (!r || r.schema !== RECOVERY_SCHEMA || !/^[A-Za-z0-9_ -]{1,12}$/.test(r.account ?? '')
        || RESERVED_ACCOUNTS.includes(r.account.toLowerCase())
        || typeof r.server !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(r.server)
        || !/^[a-zA-Z0-9-]{1,100}$/.test(r.runId ?? '') || !/^[a-zA-Z0-9-]{1,100}$/.test(r.nonce ?? '')
        || !Number.isFinite(r.endedAt) || r.endedAt < 0 || !/^[a-f0-9]{64}$/.test(r.source ?? '')) throw Error('invalid or protected session recovery request');
}

export function recoveryPermitPaths(r: RecoveryRequest, base: string) {
    validateRecoveryRequest(r);
    const account = join(base, '.practice/coordinator/session-recovery/accounts', r.account.toLowerCase()), attempt = join(account, r.nonce);
    return {
        lease: join(account, 'lease.json'),
        permit: join(attempt, 'permit.json'),
        child: join(attempt, 'child.json'),
        used: join(attempt, 'used.json'),
        input: join(attempt, 'input.json'),
        output: join(attempt, 'output'),
        completed: join(attempt, 'completed.json'),
    };
}

export function assertNoRecoveryLease(account: string, base: string) {
    if (!/^[A-Za-z0-9_ -]{1,12}$/.test(account)) throw Error('invalid recovery lease identity');
    if (existsSync(join(base, '.practice/coordinator/session-recovery/accounts', account.toLowerCase(), 'lease.json'))) throw Error('account has an unresolved recovery lease: ' + account);
}
