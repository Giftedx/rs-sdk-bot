import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const ownerAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e: any) {
        return e.code !== 'ESRCH';
    }
};

// wx elects one owner. A permanent, token-specific wx tombstone elects only one
// reaper of a dead generation. Never unlink a lock based on a PID check alone:
// a delayed second reaper could otherwise delete the replacement owner's lock.
export function acquireExclusiveLease(file: string, runId: string): () => void {
    mkdirSync(dirname(file), { recursive: true });
    const value = JSON.stringify({ pid: process.pid, runId, token: crypto.randomUUID() });
    try {
        writeFileSync(file, value, { flag: 'wx' });
    } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;
        const raw = readFileSync(file, 'utf8');
        const old = JSON.parse(raw);
        if (
            !Number.isSafeInteger(old.pid) ||
            old.pid <= 0 ||
            !/^[a-f0-9-]{36}$/.test(old.token) ||
            ownerAlive(old.pid)
        ) {
            throw Error('account/order lease conflict: ' + file);
        }
        // Retain this tiny tombstone, including after a crash. Its token is never reused.
        writeFileSync(file + '.reaped-' + old.token, value, { flag: 'wx' });
        if (readFileSync(file, 'utf8') !== raw) throw Error('lease changed during takeover: ' + file);
        unlinkSync(file);
        // A fresh claimant may win this gap. wx still permits exactly one winner.
        writeFileSync(file, value, { flag: 'wx' });
    }
    return () => {
        if (existsSync(file) && readFileSync(file, 'utf8') === value) unlinkSync(file);
    };
}
