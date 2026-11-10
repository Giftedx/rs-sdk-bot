// Runs one bot script as a child process and returns its last RESULT line. Child lines are indented, so a
// supervisor reading the parent's output sees only the parent's own RESULT line. Shared by scripts/quest-chain.ts
// (a quest outside a host) and scripts/chain.ts (several jobs in a row on one account).
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..', '..');
export async function runChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env });
    let out = '';
    for await (const c of p.stdout) { const t = new TextDecoder().decode(c); out += t; process.stdout.write(t.replace(/^(?=.)/gm, '  | ')); }
    const code = await p.exited, result = lastResult(out);
    return code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
}

// Streams child output at column 0 so START, LEDGER, MILESTONE, RATE, LOGOUT and RESULT lines
// satisfy proveInProcess and supervise.ts directly when an AIO dispatcher delegates to a single worker.
export async function runDirectChild(args: string[], env: Record<string, string | undefined> = process.env): Promise<string> {
    const p = Bun.spawn(['bun', ...args], { cwd: root, stdout: 'pipe', stderr: 'inherit', windowsHide: true, env });
    let out = '';
    for await (const c of p.stdout) { const t = new TextDecoder().decode(c); out += t; process.stdout.write(t); }
    const code = await p.exited, result = lastResult(out);
    const finalResult = code !== 0 && /^RESULT ok(?: |$)/.test(result) ? `RESULT fail child exit ${code}: ${result}` : result;
    if (!out.split(/\r?\n/).some(l => l === finalResult)) console.log(finalResult);
    return finalResult;
}
export const lastResult = (out: string) => out.split(/\r?\n/).filter(l => l.startsWith('RESULT')).at(-1) ?? 'RESULT fail no result';
