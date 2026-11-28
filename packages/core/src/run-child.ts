// Runs one bot script as a child process and returns its last RESULT line. Child lines are indented, so a
// supervisor reading the parent's output sees only the parent's own RESULT line. Shared by scripts/quest-chain.ts
// (a quest outside a host) and scripts/chain.ts (several jobs in a row on one account).
import { resolve } from 'node:path';
import { maskSecrets } from './url-mask';

const root = resolve(import.meta.dir, '..', '..', '..');
const NO_RESULT = 'RESULT fail no result';

// Keep only the current candidate and the last protocol line. A worker's diagnostic output can span many hours.
function resultReader() {
    const marker = 'RESULT ';
    let current: string | null = '', result: string | undefined;
    const part = (text: string) => {
        if (current === null) return;
        if (current.length < marker.length && !marker.startsWith(current + text.slice(0, marker.length - current.length))) {
            current = null;
            return;
        }
        current += text;
    };
    const end = () => {
        if (current?.startsWith(marker)) result = current.endsWith('\r') ? current.slice(0, -1) : current;
        current = '';
    };
    return {
        push(text: string) {
            let start = 0, newline: number;
            while ((newline = text.indexOf('\n', start)) >= 0) { part(text.slice(start, newline)); end(); start = newline + 1; }
            part(text.slice(start));
        },
        finish() { end(); return result; },
    };
}

// The output of one child with `  | ` before each line, so the parent's own RESULT line stays the only one at column 0.
export function indentWriter(write: (text: string) => unknown): (text: string) => void {
    let lineStart = true;
    return (text: string) => {
        if (!text) return;
        let formatted = '', start = 0;
        while (start < text.length) {
            const newline = text.indexOf('\n', start), end = newline < 0 ? text.length : newline + 1;
            const segment = text.slice(start, end);
            if (lineStart && segment[0] !== '\n' && segment[0] !== '\r') formatted += '  | ';
            formatted += segment;
            lineStart = newline >= 0;
            start = end;
        }
        write(formatted);
    };
}

export async function streamChildOutput(chunks: AsyncIterable<Uint8Array>, write: (text: string) => unknown, indent = false): Promise<string | undefined> {
    const decoder = new TextDecoder(), reader = resultReader(), out = indent ? indentWriter(write) : write;
    const emit = (text: string) => {
        if (!text) return;
        reader.push(text);
        out(text);
    };
    for await (const chunk of chunks) emit(decoder.decode(chunk, { stream: true }));
    emit(decoder.decode());
    return reader.finish();
}

// A child that ends on an uncaught error prints `error: <message>` on stderr and no RESULT line. That message is the
// cause, so it becomes the result: the planner and the supervisor then tell an infrastructure fault (a claim authority
// that timed out) from a worker with no result. The result holds no URL credential, token or secret value (maskSecrets). The supervisor reads this text as it
// reads the text of an error that a worker caught (packages/practice/src/supervise.ts). Stderr still goes to the
// parent's stderr.
async function lastErrorLine(chunks: AsyncIterable<Uint8Array>): Promise<string | undefined> {
    const decoder = new TextDecoder();
    let line = '', found: string | undefined;
    const end = () => { const m = line.match(/^error: (\S.*?)\r?$/); if (m) found = m[1]; line = ''; };
    const push = (text: string) => {
        let start = 0, newline: number;
        while ((newline = text.indexOf('\n', start)) >= 0) { if (line.length < 4096) line += text.slice(start, newline); end(); start = newline + 1; }
        if (line.length < 4096) line += text.slice(start);
    };
    for await (const chunk of chunks) { process.stderr.write(chunk); push(decoder.decode(chunk, { stream: true })); }
    push(decoder.decode()); end();
    return found;
}
const crashResult = (code: number, reported: string | undefined, error: string | undefined) =>
    reported ?? (code !== 0 && error ? `RESULT fail ${maskSecrets(error).slice(0, 300)}` : NO_RESULT);
// The result of a child as runChild gives it: its last RESULT line, else its uncaught error, and never ok with a
// nonzero exit. `error` is the text after `error: ` of the child's last such stderr line.
export function childResult(code: number, reported: string | undefined, error: string | undefined): string {
    const result = crashResult(code, reported, error);
    return code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
}

export async function runChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env });
    const [reported, error] = await Promise.all([streamChildOutput(p.stdout, text => process.stdout.write(text), true), lastErrorLine(p.stderr)]);
    return childResult(await p.exited, reported, error);
}

// Streams child output at column 0 so START, LEDGER, MILESTONE, RATE, LOGOUT and RESULT lines
// satisfy proveInProcess and supervise.ts directly when an AIO dispatcher delegates to a single worker.
export async function runDirectChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', windowsHide: true, env });
    let lineStart = true;
    const [reported, error] = await Promise.all([streamChildOutput(p.stdout, text => { process.stdout.write(text); lineStart = text.endsWith('\n'); }), lastErrorLine(p.stderr)]);
    const code = await p.exited, result = crashResult(code, reported, error);
    const finalResult = code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
    if (reported !== finalResult) { if (!lineStart) process.stdout.write('\n'); console.log(finalResult); }
    return finalResult;
}
export const lastResult = (out: string) => { const reader = resultReader(); reader.push(out); return reader.finish() ?? NO_RESULT; };
