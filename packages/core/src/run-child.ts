// Runs one bot script as a child process and returns its last RESULT line. Child lines are indented, so a
// supervisor reading the parent's output sees only the parent's own RESULT line. Shared by scripts/quest-chain.ts
// (a quest outside a host) and scripts/chain.ts (several jobs in a row on one account).
import { resolve } from 'node:path';

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

export async function streamChildOutput(chunks: AsyncIterable<Uint8Array>, write: (text: string) => unknown, indent = false): Promise<string | undefined> {
    const decoder = new TextDecoder(), reader = resultReader();
    let lineStart = true;
    const emit = (text: string) => {
        if (!text) return;
        reader.push(text);
        if (!indent) { write(text); return; }
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
    for await (const chunk of chunks) emit(decoder.decode(chunk, { stream: true }));
    emit(decoder.decode());
    return reader.finish();
}

export async function runChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env });
    const reported = await streamChildOutput(p.stdout, text => process.stdout.write(text), true);
    const code = await p.exited, result = reported ?? NO_RESULT;
    return code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
}

// Streams child output at column 0 so START, LEDGER, MILESTONE, RATE, LOGOUT and RESULT lines
// satisfy proveInProcess and supervise.ts directly when an AIO dispatcher delegates to a single worker.
export async function runDirectChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env });
    let lineStart = true;
    const reported = await streamChildOutput(p.stdout, text => { process.stdout.write(text); lineStart = text.endsWith('\n'); });
    const code = await p.exited, result = reported ?? NO_RESULT;
    const finalResult = code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
    if (reported !== finalResult) { if (!lineStart) process.stdout.write('\n'); console.log(finalResult); }
    return finalResult;
}
export const lastResult = (out: string) => { const reader = resultReader(); reader.push(out); return reader.finish() ?? NO_RESULT; };
