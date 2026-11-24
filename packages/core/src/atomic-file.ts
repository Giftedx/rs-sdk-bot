import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Retries file rename across transient Windows antivirus/indexer locks (EPERM/EBUSY/EACCES). */
export function renameRetry(
    from: string,
    to: string,
    rename: (a: string, b: string) => void = renameSync,
    maxRetries = 20,
): void {
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) {
        throw Error('rename retry limit must be an integer from 0 to 100');
    }
    for (let attempt = 0; ; attempt++) {
        try {
            rename(from, to);
            return;
        } catch (e) {
            if (attempt >= maxRetries || !RENAME_RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
            Atomics.wait(RETRY_PAUSE, 0, 0, 50);
        }
    }
}

export interface AtomicWriteOptions {
    mode?: number;
    ensureDir?: boolean;
    rename?: (a: string, b: string) => void;
    maxRetries?: number;
}

/** Writes `content` to a unique temporary file, atomically replaces `file` via `renameRetry`, and unlinks temp files on error. */
export function writeAtomicFile(file: string, content: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
    if (opts.ensureDir) mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, content, opts.mode !== undefined ? { mode: opts.mode } : undefined);
    try {
        renameRetry(tmp, file, opts.rename, opts.maxRetries);
    } catch (error) {
        try { unlinkSync(tmp); } catch { /* retain original error */ }
        throw error;
    }
}

/** Publishes `content` only when `file` does not exist, linking from a complete temporary file so readers never see partial bytes. */
export function createExclusiveAtomic(
    file: string,
    content: string | Uint8Array,
    opts: { mode?: number; ensureDir?: boolean } = {},
): boolean {
    if (opts.ensureDir) mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, content, { flag: 'wx', ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });
    try {
        linkSync(tmp, file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
    } finally {
        try { unlinkSync(tmp); } catch { /* temporary already removed */ }
    }
}
