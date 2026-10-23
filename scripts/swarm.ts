// Swarm controller: one place that decides which live account runs what. Reads swarm.json every 15 s (edits apply
// live), starts each enabled job under packages/practice/src/supervise.ts, and writes .practice/swarm-state.json for
// the dashboard. Limits: at most maxBots jobs at once, and no new job while free RAM is under minFreeGB (one bot
// process uses about 550-600 MB, measured 2026-10-23). It never starts an account whose status file changed in the
// last 30 s and that it did not start itself: a second login kicks the first session.
// A job that ends (done, died, gave-up) is not started again unless it has "repeat": true. Disabling a job, or the
// file .practice/stop-swarm, writes the account's stop file; the bot finishes its current step and logs out.
// Usage: DEMO_OK=1 bun scripts/swarm.ts [swarm.json]
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';

type Job = { account: string; script: string; role?: string; goal?: string; env?: Record<string, string>; enabled: boolean; repeat?: boolean; note?: string };
type Plan = { maxBots: number; minFreeGB: number; jobs: Job[] };
type Run = { proc: ReturnType<typeof Bun.spawn>; started: number };

const root = resolve(import.meta.dir, '..');
const planFile = resolve(process.argv[2] ?? join(root, 'swarm.json'));
const prac = join(root, '.practice');
const logDir = join(prac, 'swarm-logs');
mkdirSync(logDir, { recursive: true });
if (process.env.DEMO_OK !== '1') { console.log('swarm: set DEMO_OK=1 (live server)'); process.exit(2); }

const runs = new Map<string, Run>();
const ended = new Map<string, { at: number; reason: string }>();
const stopFile = (a: string) => join(prac, `stop-${a}`);
const statusAge = (a: string) => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs; } catch { return Infinity; } };

function start(job: Job) {
    rmSync(stopFile(job.account), { force: true });
    const log = createWriteStream(join(logDir, `${job.account}.log`), { flags: 'a' });
    const proc = Bun.spawn(['bun', 'packages/practice/src/supervise.ts', job.account, job.script, '20'], {
        cwd: root, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, ...job.env, DEMO_OK: '1', BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '' },
    });
    for (const stream of [proc.stdout, proc.stderr]) void (async () => { for await (const c of stream as ReadableStream<Uint8Array>) log.write(c); })();
    runs.set(job.account, { proc, started: Date.now() });
    console.log(`SWARM start ${job.account} ${job.script} ${JSON.stringify(job.env ?? {})}`);
    void proc.exited.then(code => {
        runs.delete(job.account);
        // supervise.ts ends with "SUPERVISE end <reason> after <n> runs".
        let reason = `exit ${code}`;
        try { reason = readFileSync(join(logDir, `${job.account}.log`), 'utf8').match(/SUPERVISE end [\w-]+ after \d+ runs/g)?.pop()?.slice(14) ?? reason; } catch { /* no log */ }
        ended.set(job.account, { at: Date.now(), reason });
        console.log(`SWARM end ${job.account} ${reason}`);
        log.end();
    });
}

function tick() {
    let plan: Plan;
    try { plan = JSON.parse(readFileSync(planFile, 'utf8')); } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
    const stopAll = existsSync(join(prac, 'stop-swarm'));
    const state: Record<string, unknown>[] = [];
    for (const job of plan.jobs) {
        const r = runs.get(job.account);
        const age = statusAge(job.account);
        let st: string;
        if (r) {
            st = 'running';
            if (!job.enabled || stopAll) { writeFileSync(stopFile(job.account), 'swarm'); st = 'stopping'; }
        } else if (!job.enabled || stopAll) st = 'disabled';
        else if (ended.has(job.account) && !job.repeat) st = `ended: ${ended.get(job.account)!.reason}`;
        else if (age < 30_000) st = 'external (status fresh, not started by swarm)';
        else if (runs.size >= plan.maxBots) st = 'waiting: maxBots';
        else if (freemem() / 2 ** 30 < plan.minFreeGB) st = `waiting: ${(freemem() / 2 ** 30).toFixed(1)} GB free < ${plan.minFreeGB}`;
        else { start(job); st = 'starting'; }
        state.push({ account: job.account, script: job.script, role: job.role, goal: job.goal, enabled: job.enabled, repeat: !!job.repeat, note: job.note, state: st, since: runs.get(job.account)?.started ?? ended.get(job.account)?.at ?? null });
    }
    writeFileSync(join(prac, 'swarm-state.json'), JSON.stringify({ at: Date.now(), freeGB: freemem() / 2 ** 30, running: runs.size, maxBots: plan.maxBots, jobs: state }));
    if (stopAll && runs.size === 0) { console.log('SWARM stopped (stop-swarm)'); process.exit(0); }
}

console.log(`SWARM plan ${planFile}`);
tick();
setInterval(tick, 15_000);
