// Loop watch: finds accounts that repeat work with no result, from files every run already writes. No game login.
// It reads .practice/swarm-logs/<account>.log (RESULT lines), the controller log (.practice/coordinator/swarm.out.log,
// `SWARM standing retry` lines), .practice/status/<account>.json (the tick timeline and position), .practice/swarm-deaths.json
// (the controller's end records) and the shared fleet orders and receipts (FLEET_DIR, every side).
// Findings, one LOOP line each:
//   fail-loop      the last FAIL_REPEATS RESULT lines of an account are the same failure
//   empty-loop     the last EMPTY_REPEATS runs of a job each ended ok with under EMPTY_TICKS ticks of work: a repeating
//                  job whose target is already met logs in, finds nothing to do and logs out, again and again
//   retry-loop     the controller restarted a standing job RETRY_REPEATS times or more in its newest RETRY_WINDOW lines
//   pacing         PACING_TICKS ticks of only walking and idling, inside a PACING_BOX-tile box over PACING_SAMPLES samples
//   trade-stuck    a party waits in a fleet order whose partner did not come (a `prepared` receipt TRADE_WAIT_MS old
//                  with no partner receipt, or a `reconcile` receipt)
//   needs-recovery an end record or a login failure that only an authenticated session recovery clears
// Usage: bun scripts/loop-watch.ts [--watch] [--stop]
// --watch: a pass every 30 s; new findings also go to .practice/alerts.jsonl (scripts/learn.ts reads it). Pacing needs
//          --watch, because one pass has one position sample.
// --stop:  for a fail-loop, an empty-loop or a retry-loop of this side, write the account's stop file with the finding as its text.
//          The file is an owner pause: the planner and the controller leave the account alone until a person removes it.
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FLEET_DIR, loadOwners, mySide } from '../packages/core/src/fleet';

export const EMPTY_REPEATS = 3, EMPTY_TICKS = 20;
export const FAIL_REPEATS = 3, RETRY_REPEATS = 5, RETRY_WINDOW = 400, PACING_TICKS = 100, PACING_BOX = 3, PACING_SAMPLES = 4, TRADE_WAIT_MS = 5 * 60_000;
export type Finding = { kind: 'fail-loop' | 'empty-loop' | 'retry-loop' | 'pacing' | 'trade-stuck' | 'needs-recovery'; account: string; text: string };

// A failure with its numbers removed, so two runs of one fault compare equal (ticks, tiles and ids differ per run).
export const faultKey = (result: string) => result.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, '').replace(/\d+/g, '#').trim().slice(0, 160);
// The same failure FAIL_REPEATS times at the end of a job log, with no ok RESULT between them.
export function failLoop(lines: readonly string[], repeats = FAIL_REPEATS): { fault: string; count: number } | null {
    const results = lines.map(l => l.replace(/^\s*(\|\s*)?(\[[^\]]+\]\s*)?/, '')).filter(l => /^RESULT (ok|fail)\b/.test(l));
    const last = results.at(-1);
    if (!last?.startsWith('RESULT fail')) return null;
    let count = 0;
    for (let i = results.length - 1; i >= 0 && faultKey(results[i]!) === faultKey(last); i--) count++;
    return count >= repeats ? { fault: last.slice(0, 160), count } : null;
}
// The supervisor writes one `SUPERVISE run <n> exit <code>: <result>` line per run. A run is empty when it exits 0 and
// no line of it reports EMPTY_TICKS ticks or more (a `ticks=` or `"ticks":` field of a RESULT, CHAIN or LEDGER line).
export function emptyLoop(lines: readonly string[], repeats = EMPTY_REPEATS, ticks = EMPTY_TICKS): number {
    const runs: { ok: boolean; ticks: number }[] = [];
    let most = 0;
    for (const l of lines) {
        for (const m of l.matchAll(/\bticks"?[=:]\s*(\d+)/g)) most = Math.max(most, Number(m[1]));
        const end = l.match(/^SUPERVISE run \d+ exit (\d+):/);
        if (end) { runs.push({ ok: end[1] === '0', ticks: most }); most = 0; }
    }
    let count = 0;
    for (let i = runs.length - 1; i >= 0 && runs[i]!.ok && runs[i]!.ticks < ticks; i--) count++;
    return count >= repeats ? count : 0;
}
// Accounts the controller restarted `repeats` times or more in its newest `window` lines, with their last end reason.
export function retryLoops(controllerLines: readonly string[], repeats = RETRY_REPEATS, window = RETRY_WINDOW): { account: string; count: number; reason: string }[] {
    const seen = new Map<string, { count: number; reason: string }>();
    for (const l of controllerLines.slice(-window)) {
        const m = l.match(/^SWARM standing retry (\S+) after (.*)$/);
        if (m) seen.set(m[1]!, { count: (seen.get(m[1]!)?.count ?? 0) + 1, reason: m[2]!.slice(0, 100) });
    }
    return [...seen].filter(([, v]) => v.count >= repeats).map(([account, v]) => ({ account, ...v }));
}
// The status timeline holds one letter per tick: m move, i idle, and a letter for each kind of progress (x XP,
// v inventory, d dialog, a animation, s stun). An account paces when its newest PACING_TICKS ticks are only moves
// and idles with at least a quarter moves, and every sampled position lies in one small box.
export type Sample = { x: number; z: number; level: number };
export function pacing(timeline: string, samples: readonly Sample[], ticks = PACING_TICKS, box = PACING_BOX, need = PACING_SAMPLES): boolean {
    const tail = timeline.slice(-ticks);
    if (tail.length < ticks || /[^mi]/.test(tail) || (tail.match(/m/g) ?? []).length < ticks / 4) return false;
    const recent = samples.slice(-need);
    if (recent.length < need || new Set(recent.map(s => s.level)).size > 1) return false;
    const span = (pick: (s: Sample) => number) => Math.max(...recent.map(pick)) - Math.min(...recent.map(pick));
    return span(s => s.x) <= box && span(s => s.z) <= box;
}
// Fleet orders with a party that waits for nothing. `prepared` is the receipt a party writes when it claims the trade.
export function tradeStuck(orders: readonly any[], receipts: readonly any[], now: number, wait = TRADE_WAIT_MS): { account: string; text: string }[] {
    const out: { account: string; text: string }[] = [];
    for (const o of orders) {
        if (typeof o?.id !== 'string') continue;
        const mine = receipts.filter(r => r?.id === o.id);
        for (const r of mine) {
            const partner = mine.some(p => p.role !== r.role);
            if (r.state === 'reconcile') out.push({ account: r.account, text: `order ${o.id} (${o.count} ${o.item}, ${o.from} to ${o.to}) needs reconciliation: ${String(r.detail).slice(0, 100)}` });
            else if (r.state === 'prepared' && !partner && now - r.at >= wait && now < o.end + wait)
                out.push({ account: r.account, text: `waits ${Math.round((now - r.at) / 60_000)} min in order ${o.id} (${o.count} ${o.item}); ${r.role === 'to' ? o.from : o.to} has not come` });
        }
    }
    return out;
}
// Ends and login failures that a restart never clears (scripts/swarm.ts standingRetryable; DRAIN_RESULT in the planner).
export const needsRecovery = (text: string) => /^exit orphaned: attempt |fleet account claim held\b/.test(text.replace(/^RESULT fail (?:login: )?(?:Error: )?/, ''));

const root = resolve(import.meta.dir, '..'), prac = join(root, '.practice');
const readJson = (f: string, fallback: any) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return fallback; } };
const lines = (f: string, bytes = 400_000) => { try { return readFileSync(f, 'utf8').slice(-bytes).split(/\r?\n/); } catch { return []; } };
const jsonDir = (d: string) => existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).map(f => readJson(join(d, f), null)).filter(Boolean) : [];

export function scan(history: Map<string, Sample[]>, now = Date.now()): Finding[] {
    const out: Finding[] = [], side = mySide(), owners = loadOwners();
    const mine = [...owners].filter(([, o]) => o.side === side).map(([n]) => n);
    const logs = existsSync(join(prac, 'swarm-logs')) ? readdirSync(join(prac, 'swarm-logs')).filter(f => f.endsWith('.log')) : [];
    for (const f of logs) {
        const account = f.slice(0, -'.log'.length);
        if (!mine.includes(account.toLowerCase())) continue;
        const log = lines(join(prac, 'swarm-logs', f)), empty = emptyLoop(log);
        if (empty) out.push({ kind: 'empty-loop', account, text: `${empty} runs in a row ended ok with under ${EMPTY_TICKS} ticks of work` });
        const loop = failLoop(log);
        if (!loop) continue;
        if (needsRecovery(loop.fault)) out.push({ kind: 'needs-recovery', account, text: `${loop.count} logins refused: ${loop.fault}` });
        else out.push({ kind: 'fail-loop', account, text: `the same failure ${loop.count} times: ${loop.fault}` });
    }
    for (const r of retryLoops(lines(join(prac, 'coordinator', 'swarm.out.log'))))
        out.push({ kind: 'retry-loop', account: r.account, text: `the controller restarted its job ${r.count} times; last end: ${r.reason}` });
    // The controller's end records: one object keyed by account name, each { at, reason }.
    for (const [account, end] of Object.entries(readJson(join(prac, 'swarm-deaths.json'), {}) as Record<string, { reason?: unknown }>)) {
        const reason = String(end?.reason ?? '');
        if (needsRecovery(reason) && !out.some(f => f.kind === 'needs-recovery' && f.account.toLowerCase() === account.toLowerCase()))
            out.push({ kind: 'needs-recovery', account, text: reason.slice(0, 120) });
    }
    for (const s of jsonDir(join(prac, 'status'))) {
        if (typeof s?.name !== 'string' || /^localhost/.test(s.server ?? '') || s.result || !(now - s.at < 60_000) || !s.pos) continue;
        const samples = [...(history.get(s.name) ?? []), { x: s.pos.x, z: s.pos.z, level: s.pos.level ?? 0 }].slice(-PACING_SAMPLES);
        history.set(s.name, samples);
        if (pacing(String(s.timeline ?? ''), samples)) out.push({ kind: 'pacing', account: s.name, text: `${PACING_TICKS} ticks of walking with no XP, item or dialog near ${s.pos.x},${s.pos.z} (${s.phase ?? ''})` });
    }
    const fleet = FLEET_DIR();
    for (const t of tradeStuck(jsonDir(join(fleet, 'orders')), jsonDir(join(fleet, 'receipts')), now)) out.push({ kind: 'trade-stuck', ...t });
    return out;
}

if (import.meta.main) {
    const args = process.argv.slice(2), watch = args.includes('--watch'), stop = args.includes('--stop');
    const history = new Map<string, Sample[]>(), raised = new Set<string>(), side = mySide(), owners = loadOwners();
    const pass = () => {
        const found = scan(history), now = Date.now();
        for (const f of found) {
            const key = `loop-${f.kind}-${f.account}-${faultKey(f.text)}`;
            if (watch && raised.has(key)) continue;
            raised.add(key);
            console.log(`LOOP ${f.kind} ${f.account}: ${f.text}`);
            if (watch) appendFileSync(join(prac, 'alerts.jsonl'), JSON.stringify({ at: now, level: 'warn', key, bot: f.account, text: `${f.account} ${f.kind}: ${f.text}` }) + '\n');
            const file = join(prac, `stop-${f.account}`);
            if (stop && (f.kind === 'fail-loop' || f.kind === 'empty-loop' || f.kind === 'retry-loop') && owners.get(f.account.toLowerCase())?.side === side && !existsSync(file)) {
                writeFileSync(file, `loop-watch ${f.kind}: ${f.text}\n`);
                console.log(`LOOP stopped ${f.account}: wrote ${file}`);
            }
        }
        if (!watch) console.log(`RESULT ok loop-watch findings=${found.length}`);
    };
    pass();
    if (watch) setInterval(pass, 30_000);
}
