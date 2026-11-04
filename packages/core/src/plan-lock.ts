// The account-plan write lock: one writer of swarm.json at a time across the coordinator, its live children and the
// autopilot (scripts/autopilot.ts). Runtime code may import this file; packages/router is a tooling root that runtime
// code may not import (packages/core/src/worker-release.ts), so the lock lives here and the coordinator store re-exports it.
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const planLockDir = join(resolve(import.meta.dir, '../../..'), '.practice/coordinator');

/** Serialize account-plan writes across independently running live jobs. */
export async function withPlanWrite<T>(action: () => T | Promise<T>, directory = planLockDir, timeoutMs = 15000): Promise<T> {
    mkdirSync(directory, { recursive: true }); const file = join(directory, 'plan-write-lock.json'), nonce = randomUUID(), deadline = Date.now() + timeoutMs;
    const intent = join(directory, `plan-write-${nonce}.intent.json`); let acquired = false;
    // Publish complete ownership atomically: a killed writer cannot leave an empty
    // lock whose owner the dispatcher cannot identify.
    writeFileSync(intent, JSON.stringify({ pid: process.pid, nonce, at: Date.now() }), { flag: 'wx' });
    try {
        for (;;) {
            try { linkSync(intent, file); acquired = true; break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw Error('account plan writer waits for its existing owner'); await Bun.sleep(25); }
        }
        return await action();
    } finally {
        try { if (acquired) { const owner = JSON.parse(readFileSync(file, 'utf8')); if (owner.pid !== process.pid || owner.nonce !== nonce) throw Error('account plan write ownership changed'); unlinkSync(file); } }
        finally { unlinkSync(intent); }
    }
}
/** Only the single dispatcher recovers abandoned write leases; workers wait. */
export function recoverPlanWrite(directory = planLockDir, alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; } }) {
    const file = join(directory, 'plan-write-lock.json'); if (!existsSync(file)) return false;
    let owner: any; try { owner = JSON.parse(readFileSync(file, 'utf8')); } catch { return false; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) return false;
    const archive = join(directory, 'plan-lock-recovery'); mkdirSync(archive, { recursive: true }); renameSync(file, join(archive, `${Date.now()}-${randomUUID()}.json`));
    if (typeof owner.nonce === 'string' && /^[a-f0-9-]{36}$/.test(owner.nonce)) { const intent = join(directory, `plan-write-${owner.nonce}.intent.json`); if (existsSync(intent)) unlinkSync(intent); }
    return true;
}
