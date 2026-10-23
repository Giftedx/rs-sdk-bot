// Swarm controller: one place that decides which live account runs what. Reads swarm.json every 15 s (edits apply
// live), starts each enabled job under packages/practice/src/supervise.ts, and writes .practice/swarm-state.json for
// the dashboard. Limits: at most maxBots bots at once, and no new job while free RAM is under minFreeGB (one bot
// process uses about 550-600 MB, measured 2026-10-23). It never starts an account whose status file changed in the
// last 30 s and that it did not start itself: a second login kicks the first session.
// A job that ends (done, died, gave-up) is not started again unless it has "repeat": true. Disabling a job, or the
// file .practice/stop-swarm, writes the account's stop file; the bot finishes its current step and logs out.
// Host jobs: {"accounts": [...], "script": ..., "host": true} run all accounts in one process
// (packages/core/src/host.ts, about 140 MB per bot instead of about 550 MB, research/bot-host.md) under
// packages/practice/src/supervise-host.ts. The rules apply per account: the external guard and stop files per
// account, and an account whose RESULT says died is never started again. A host counts as its N bots for maxBots.
// Usage: DEMO_OK=1 bun scripts/swarm.ts [swarm.json]
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';

export type Job = { account?: string; accounts?: string[]; host?: boolean; script: string; role?: string; goal?: string; env?: Record<string, string>; enabled: boolean; repeat?: boolean; note?: string };
type Plan = { maxBots: number; minFreeGB: number; jobs: Job[] };
type Run = { proc: ReturnType<typeof Bun.spawn>; started: number; accounts: string[] };
export type ParsedJob = { key: string; accounts: string[]; host: boolean; job: Job };

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;

// An entry with an account and no script is a reservation (the main account waits for its own run): the swarm never
// starts it and reports it as "reserved", not as a bad job.
export function isReservation(job: Job): boolean {
    return !!job && typeof job.account === 'string' && !job.accounts && !job.script;
}

// A host job lists its accounts; a single job names one. Returns an error string for a job the swarm must skip.
export function parseJob(job: Job): ParsedJob | { error: string } {
    if (!job || typeof job.script !== 'string' || !job.script) return { error: 'no script' };
    if (job.host) {
        const list = job.accounts;
        if (!Array.isArray(list) || list.length === 0) return { error: 'host job needs a non-empty "accounts" list' };
        if (job.account) return { error: 'host job has both "account" and "accounts"' };
        if (list.some(a => typeof a !== 'string' || !ACCOUNT.test(a))) return { error: 'bad account name in "accounts"' };
        if (new Set(list.map(a => a.toLowerCase())).size !== list.length) return { error: 'account listed twice' };
        return { key: `host:${list.join('+')}`, accounts: [...list], host: true, job };
    }
    if (job.accounts) return { error: '"accounts" needs "host": true' };
    if (typeof job.account !== 'string' || !ACCOUNT.test(job.account)) return { error: 'no account' };
    return { key: job.account, accounts: [job.account], host: false, job };
}

// The rule for an account that has ended: a death ends it for good, even with repeat on (2026-10-23: mmtha0205
// respawned in Lumbridge and died twice more walking back to Ardougne). Other ends restart only with repeat.
export function endedForGood(end: { reason: string } | undefined, repeat: boolean | undefined): boolean {
    if (!end) return false;
    return !repeat || /^died/.test(end.reason);
}

// Which accounts of a job may start now, and the state of each one that may not.
export function startable(accounts: string[], repeat: boolean | undefined, ended: Map<string, { reason: string }>, statusAge: (a: string) => number): { start: string[]; blocked: Record<string, string> } {
    const start: string[] = [];
    const blocked: Record<string, string> = {};
    for (const a of accounts) {
        if (endedForGood(ended.get(a), repeat)) blocked[a] = `ended: ${ended.get(a)!.reason}`;
        else if (statusAge(a) < 30_000) blocked[a] = 'external (status fresh, not started by swarm)';
        else start.push(a);
    }
    return { start, blocked };
}

if (import.meta.main) {
    const root = resolve(import.meta.dir, '..');
    const planFile = resolve(process.argv[2] ?? join(root, 'swarm.json'));
    const prac = join(root, '.practice');
    const logDir = join(prac, 'swarm-logs');
    mkdirSync(logDir, { recursive: true });
    if (process.env.DEMO_OK !== '1') { console.log('swarm: set DEMO_OK=1 (live server)'); process.exit(2); }

    const runs = new Map<string, Run>();
    // Per account: why its last run ended.
    const ended = new Map<string, { at: number; reason: string }>();
    // Deaths outlive a swarm restart: .practice/swarm-deaths.json keeps them, and an account in it is never started
    // (2026-10-23: a restart forgot Mightyrod's death and sent it back to the spot that killed it). To clear an
    // account after its route is fixed, delete its key from that file before (re)starting the swarm.
    const deathsFile = join(prac, 'swarm-deaths.json');
    try { for (const [a, r] of Object.entries(JSON.parse(readFileSync(deathsFile, 'utf8')))) ended.set(a, r as { at: number; reason: string }); } catch { /* no deaths yet */ }
    const setEnded = ended.set.bind(ended);
    ended.set = (a, r) => {
        setEnded(a, r);
        if (/^died/.test(r.reason)) {
            const dead = Object.fromEntries([...ended].filter(([, v]) => /^died/.test(v.reason)));
            writeFileSync(deathsFile, JSON.stringify(dead, null, 1));
        }
        return ended;
    };
    const stopFile = (a: string) => join(prac, `stop-${a}`);
    const statusAge = (a: string) => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs; } catch { return Infinity; } };
    const botsRunning = () => [...runs.values()].reduce((n, r) => n + r.accounts.length, 0);

    const start = (p: ParsedJob, accounts: string[]) => {
        const job = p.job;
        for (const a of accounts) rmSync(stopFile(a), { force: true });
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`;
        const log = createWriteStream(join(logDir, logName), { flags: 'a' });
        const cmd = p.host
            ? ['bun', 'packages/practice/src/supervise-host.ts', job.script, '20', ...accounts]
            : ['bun', 'packages/practice/src/supervise.ts', accounts[0]!, job.script, '20'];
        const proc = Bun.spawn(cmd, {
            cwd: root, stdout: 'pipe', stderr: 'pipe',
            env: { ...process.env, ...job.env, DEMO_OK: '1', BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '' },
        });
        let tail = '';
        for (const stream of [proc.stdout, proc.stderr]) void (async () => {
            for await (const c of stream as ReadableStream<Uint8Array>) {
                log.write(c);
                if (!p.host) continue;
                // supervise-host.ts prints one end line per account as soon as that account is finished.
                tail += new TextDecoder().decode(c);
                const lines = tail.split(/\r?\n/);
                tail = lines.pop() ?? '';
                for (const l of lines) {
                    const m = l.match(/^SUPERVISE-HOST account (\S+) ([\w-]+) after \d+ runs/);
                    if (m) { ended.set(m[1]!, { at: Date.now(), reason: m[2]! }); console.log(`SWARM end ${m[1]} ${m[2]} (host)`); }
                }
            }
        })();
        const startedAt = Date.now();
        runs.set(p.key, { proc, started: startedAt, accounts });
        console.log(`SWARM start ${p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        void proc.exited.then(code => {
            runs.delete(p.key);
            if (!p.host) {
                // supervise.ts ends with "SUPERVISE end <reason> after <n> runs".
                let reason = `exit ${code}`;
                try { reason = readFileSync(join(logDir, logName), 'utf8').match(/SUPERVISE end [\w-]+ after \d+ runs/g)?.pop()?.slice(14) ?? reason; } catch { /* no log */ }
                ended.set(accounts[0]!, { at: Date.now(), reason });
                console.log(`SWARM end ${accounts[0]} ${reason}`);
            } else {
                // An account with no end line (the supervisor itself crashed) ends with the exit code.
                for (const a of accounts) {
                    if ((ended.get(a)?.at ?? 0) >= startedAt) continue;
                    ended.set(a, { at: Date.now(), reason: `exit ${code}` });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
            log.end();
        });
    };

    const tick = () => {
        let plan: Plan;
        try { plan = JSON.parse(readFileSync(planFile, 'utf8')); } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
        const stopAll = existsSync(join(prac, 'stop-swarm'));
        const state: Record<string, unknown>[] = [];
        for (const raw of plan.jobs) {
            if (isReservation(raw)) {
                state.push({ account: raw.account, script: '', role: raw.role, goal: raw.goal, enabled: false, repeat: false, note: raw.note, state: 'reserved', since: null });
                continue;
            }
            const p = parseJob(raw);
            if ('error' in p) {
                state.push({ account: raw.account ?? (raw.accounts ?? []).join('+'), script: raw.script, enabled: raw.enabled, state: `bad job: ${p.error}` });
                continue;
            }
            const job = p.job;
            const r = runs.get(p.key);
            const st: Record<string, string> = {};
            if (r) {
                const stop = !job.enabled || stopAll;
                for (const a of p.accounts) {
                    if (!r.accounts.includes(a)) st[a] = 'not in this host run';
                    else if (ended.has(a) && ended.get(a)!.at >= r.started) st[a] = `ended: ${ended.get(a)!.reason}`;
                    else if (stop) { writeFileSync(stopFile(a), 'swarm'); st[a] = 'stopping'; }
                    else st[a] = 'running';
                }
            } else if (!job.enabled || stopAll) for (const a of p.accounts) st[a] = 'disabled';
            else {
                const { start: go, blocked } = startable(p.accounts, job.repeat, ended, statusAge);
                Object.assign(st, blocked);
                if (go.length > 0) {
                    // Single jobs keep the old order: external, then maxBots, then free RAM.
                    if (botsRunning() + go.length > plan.maxBots) for (const a of go) st[a] = 'waiting: maxBots';
                    else if (freemem() / 2 ** 30 < plan.minFreeGB) for (const a of go) st[a] = `waiting: ${(freemem() / 2 ** 30).toFixed(1)} GB free < ${plan.minFreeGB}`;
                    else { start(p, go); for (const a of go) st[a] = 'starting'; }
                }
            }
            const run = runs.get(p.key);
            for (const a of p.accounts) {
                state.push({
                    account: a, script: job.script, role: job.role, goal: job.goal, enabled: job.enabled, repeat: !!job.repeat, note: job.note,
                    ...(p.host ? { host: p.key } : {}), state: st[a],
                    since: (run && run.accounts.includes(a) ? run.started : undefined) ?? ended.get(a)?.at ?? null,
                });
            }
        }
        writeFileSync(join(prac, 'swarm-state.json'), JSON.stringify({ at: Date.now(), freeGB: freemem() / 2 ** 30, running: botsRunning(), maxBots: plan.maxBots, jobs: state }));
        if (stopAll && runs.size === 0) { console.log('SWARM stopped (stop-swarm)'); process.exit(0); }
    };

    console.log(`SWARM plan ${planFile}`);
    tick();
    setInterval(tick, 15_000);
}
