// The last n lines of a JSON-lines file, read from its end in chunks: a 10 MB log costs the bytes of its tail, not its size.
// tailLines is the pure part; scanJsonlTail streams lines without holding a full-file buffer or N-element array.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 256 * 1024;

function tailStartOffset(fd: number, size: number, n: number): number {
    if (size <= 0 || n <= 0) return size;
    let pos = size;
    let newlines = 0;
    const buf = Buffer.allocUnsafe(Math.min(CHUNK, size));
    while (pos > 0) {
        const len = Math.min(buf.length, pos);
        pos -= len;
        readSync(fd, buf, 0, len, pos);
        for (let i = len - 1; i >= 0; i--) {
            if (buf[i] === 10) {
                // Ignore a trailing newline at EOF so n lines are kept.
                if (pos + i === size - 1) continue;
                if (++newlines >= n) return pos + i + 1;
            }
        }
    }
    return 0;
}

export function scanTailLines(file: string, n: number, visit: (line: string) => void): void {
    if (n <= 0) return;
    let fd: number;
    try { fd = openSync(file, 'r'); } catch { return; }
    try {
        const size = fstatSync(fd).size;
        if (size <= 0) return;
        let pos = tailStartOffset(fd, size, n);
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
        const decoder = new StringDecoder('utf8');
        let carry = '';
        while (pos < size) {
            const len = Math.min(buf.length, size - pos);
            const got = readSync(fd, buf, 0, len, pos);
            if (got <= 0) break;
            pos += got;
            const text = carry + decoder.write(got === buf.length ? buf : buf.subarray(0, got));
            let start = 0;
            for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
                if (nl > start) {
                    const line = text.charCodeAt(nl - 1) === 13 ? text.slice(start, nl - 1) : text.slice(start, nl);
                    if (line) visit(line);
                }
                start = nl + 1;
            }
            carry = text.slice(start);
        }
        carry += decoder.end();
        const last = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
        if (last) visit(last);
    } catch { /* unreadable */ }
    finally { closeSync(fd); }
}

export function tailLines(file: string, n: number): string[] {
    const out: string[] = [];
    scanTailLines(file, n, line => out.push(line));
    return out.length > n ? out.slice(-n) : out;
}

export function scanJsonlTail<T>(file: string, n: number, visit: (row: T) => void): void {
    scanTailLines(file, n, line => {
        try { visit(JSON.parse(line) as T); } catch { /* malformed line */ }
    });
}

export function tailJsonlFile<T>(file: string, n: number): T[] {
    const out: T[] = [];
    scanJsonlTail<T>(file, n, row => out.push(row));
    return out;
}

const tails = new Map<string, { key: string; n: number; rows: unknown[] }>();
export function cachedTail<T>(file: string, n: number): T[] {
    let key: string;
    try { const s = statSync(file); key = s.size + ':' + s.mtimeMs; } catch { return []; }
    const hit = tails.get(file);
    if (hit && hit.key === key && hit.n === n) return hit.rows as T[];
    const rows = tailJsonlFile<T>(file, n); tails.set(file, { key, n, rows }); return rows;
}
