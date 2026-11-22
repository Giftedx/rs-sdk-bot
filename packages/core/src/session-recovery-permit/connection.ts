// Child binding readiness wait, single-use permit consumption, and opaque connection admission tokens.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isLocalServer } from '../localserver';
import { listAttempts, readLogoutProof } from '../session-lifecycle';
import { current } from './authority';
import {
    RECOVERY_BINDING_MS, json, recoveryPermitPaths, same, sha,
    type ControlledRecoveryRequest, type RecoveryPermitChecks, type RecoveryRequest,
} from './request';

// The controller sends readiness on its private pipe after current validation and child publication.
// Readiness is not admission: consumeRecoveryConnection still checks all authority and single-use guards.
export async function waitForRecoveryChildBinding(r: ControlledRecoveryRequest, base: string, ready: ReadableStream<Uint8Array>) {
    const paths = recoveryPermitPaths(r, base), permit = json(paths.permit);
    // A recovery child is a fresh bun process that loads the SDK and the collision data before it binds: on this PC with
    // builds running that takes longer than 10 s. The window stays well inside the 150 s permit lifetime.
    const deadline = permit.issuedAt + RECOVERY_BINDING_MS;
    if (!Number.isFinite(permit.issuedAt) || Date.now() < permit.issuedAt || Date.now() >= deadline) throw Error('recovery connection admission expired');
    const reader = ready.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const raw = await Promise.race([
            (async () => {
                let text = ''; const decoder = new TextDecoder(); let bytes = 0;
                for (;;) {
                    const { value, done } = await reader.read(); if (done) break;
                    bytes += value.byteLength; if (bytes > 1024) throw Error('recovery child identity changed'); text += decoder.decode(value, { stream: true });
                }
                return text + decoder.decode();
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('recovery child not bound')), Math.max(0, deadline - Date.now())); }),
        ]);
        if (Date.now() >= deadline) throw Error('recovery connection admission expired');
        if (!raw || !existsSync(paths.child)) throw Error('recovery child not bound');
        let message, child; try { message = JSON.parse(raw); child = json(paths.child); } catch { throw Error('recovery child identity changed'); }
        if (message?.pid !== process.pid || message.nonce !== r.nonce || message.runId !== r.runId || message.source !== r.source
            || child?.pid !== process.pid || child.nonce !== r.nonce || child.runId !== r.runId) throw Error('recovery child identity changed');
    } finally {
        clearTimeout(timer);
        await reader.cancel().catch(() => {});
    }
}

// Called exactly once before connect. The returned guard may run again before cleanup.
export function consumeRecoveryPermit(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks = {}) {
    return consumeRecoveryConnection(r, base, options).guard;
}

// An opaque in-process token. Only consumeRecoveryConnection creates one, for this exact request and child PID.
// recoverSession spends it once for its connection; the guard stays reusable for cleanup checks.
export type RecoveryConnectionAdmission = { readonly nonce: string };
const admissions = new WeakMap<object, { request: ControlledRecoveryRequest; pid: number; nativeFixture: boolean; guard: () => void; spent: boolean; base: string; previous: { attemptId: string; sha256: string } | null }>();

export function consumeRecoveryConnection(r: ControlledRecoveryRequest, base: string, options: RecoveryPermitChecks = {}) {
    const paths = recoveryPermitPaths(r, base);
    const check = (ownedChild = false) => {
        current(r, base, options, false, ownedChild); if (!existsSync(paths.child)) throw Error('recovery child not bound');
        const child = json(paths.child); if (child.pid !== process.pid || child.nonce !== r.nonce || child.runId !== r.runId) throw Error('recovery child identity changed');
    };
    check(); const permit = json(paths.permit); if ((options.now ?? Date.now)() > permit.issuedAt + RECOVERY_BINDING_MS) throw Error('recovery connection admission expired');
    if (existsSync(paths.used)) throw Error('recovery nonce already consumed');
    writeFileSync(paths.used, JSON.stringify({ pid: process.pid, nonce: r.nonce, permitSha256: sha(readFileSync(paths.permit)) }), { flag: 'wx' });
    const used = readFileSync(paths.used, 'utf8');
    const guard = () => { check(true); if (readFileSync(paths.used, 'utf8') !== used) throw Error('recovery consumption marker changed'); };
    const admission: RecoveryConnectionAdmission = Object.freeze({ nonce: r.nonce });
    const latest = readLogoutProof(r.account, r.server, { root: join(base, '.practice/session-lifecycle') }), producer = latest.state === 'held' ? listAttempts(r.account, r.server, { root: join(base, '.practice/session-lifecycle') }).find(a => a.attemptId === latest.attemptId) : undefined;
    admissions.set(admission, { request: structuredClone(r), pid: process.pid, nativeFixture: permit.nativeFixture === true, guard, spent: false, base: realpathSync(base), previous: producer?.sha256 ? { attemptId: producer.attemptId, sha256: producer.sha256 } : null });
    return { guard, admission };
}

// Spends the admission for one connection. A copied, forged, reused or crossed token refuses before any intent.
export function spendRecoveryConnection(admission: unknown, r: RecoveryRequest) {
    const entry = admission && typeof admission === 'object' ? admissions.get(admission) : undefined;
    if (!entry || entry.spent || entry.pid !== process.pid || !isDeepStrictEqual(entry.request, r) || entry.nativeFixture && !isLocalServer(r.server))
        throw Error('recovery connection admission invalid; no connection attempted');
    entry.spent = true; entry.guard();
}

export function assertSpentRecoveryConnection(admission: RecoveryConnectionAdmission, account: string, server: string, base?: string) {
    const entry = admissions.get(admission);
    if (!entry?.spent || entry.pid !== process.pid || !same(entry.request.account, account) || entry.request.server !== server || entry.nativeFixture || base && realpathSync(base) !== entry.base)
        throw Error('recovery connection admission invalid; no connection attempted');
    entry.guard();
    return { previous: entry.previous ? { ...entry.previous } : null };
}
