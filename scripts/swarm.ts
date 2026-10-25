// Swarm controller: one place that decides which live account runs what. Reads swarm.json every 2 s (edits apply
// live), starts each enabled job under packages/practice/src/supervise.ts, and writes .practice/swarm-state.json for
// the dashboard. Admission counts managed and fresh external live accounts against maxBots. Each new account
// reserves 1 GiB for 30 s; projected free RAM must retain max(8 GiB, minFreeGB). It never starts an account whose status file changed in the
// last 30 s and that it did not start itself: a second login kicks the first session.
// Successful jobs restart with "repeat": true or a changed work revision. Death, no-progress and exhausted retries stay blocked. Disabling a job, or the
// file .practice/stop-swarm, writes the account's stop file; the bot finishes its current step and logs out.
// Host jobs: {"accounts": [...], "script": ..., "host": true} run all accounts in one process
// (packages/core/src/host.ts, about 140 MB per bot instead of about 550 MB, research/bot-host.md) under
// packages/practice/src/supervise-host.ts. The rules apply per account: the external guard and stop files per
// account, and an account whose RESULT says died is never started again. A host counts as its N bots for maxBots.
// Usage: DEMO_OK=1 bun scripts/swarm.ts [swarm.json]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { payoutWaiting, type DemandNear } from '../packages/core/src/bank-demand';
import { ownedAccounts } from '../packages/core/src/tradeguard';
import { courierDeliveryWaiting } from './courier-cargo';

export type Job = { account?: string; accounts?: string[]; host?: boolean; script: string; role?: string; goal?: string; env?: Record<string, string>; enabled: boolean; repeat?: boolean; note?: string; whenCargoFrom?: string[]; demandNear?: {x:number;z:number;radius:number};whenFoodLowFrom?:string[];foodLowBelow?:number;foodSourceAccount?:string;sourceFoodMinimum?:number };
type Plan = { maxBots: number; minFreeGB: number; jobs: Job[] };
type Run = { proc: ReturnType<typeof Bun.spawn>; started: number; accounts: string[]; revision: string; host?: boolean };
export type ParsedJob = { key: string; accounts: string[]; host: boolean; job: Job };

const ACCOUNT = /^[A-Za-z0-9_ -]{1,12}$/;
const START_BUDGET_GB = 1;
const START_RESERVE_MS = 30_000;
const FREE_FLOOR_GB = 8;

// Count evidence of active live sessions across the whole status directory, not
// only accounts already listed in the plan. Managed sessions are counted elsewhere.
export function activeExternalLive(statuses: readonly any[], managed: readonly string[], now: number): string[] {
    const ours = new Set(managed.map(a => a.toLowerCase()));
    const active = new Map<string, string>();
    for (const s of statuses) {
        if (!s || typeof s.name !== 'string' || !ACCOUNT.test(s.name) || s.server !== 'rs-sdk-demo.fly.dev'
            || !Number.isFinite(s.at) || now - s.at < 0 || now - s.at >= 30_000 || s.result) continue;
        const key = s.name.toLowerCase();
        if (!ours.has(key) && !active.has(key)) active.set(key, s.name);
    }
    return [...active.values()];
}

// Incoming cargo keeps its explicit whitelist. Payout recipients are any live,
// authenticated locally owned accounts; hasPayout still checks the exact fresh
// request, identity, server and bank radius before this can wake a banker.
export function ownedPayoutWaiting(statuses: readonly any[], near?: DemandNear,
    owned: ReadonlySet<string> = ownedAccounts('rs-sdk-demo.fly.dev'),
    check: typeof payoutWaiting = payoutWaiting, now = Date.now()): boolean {
    const names = activeExternalLive(statuses, [], now).filter(name => owned.has(name.toLowerCase()));
    return names.length > 0 && check(names, near);
}

// Food-courier admission only. Unknown bank snapshots are not an empty food buffer.
export function foodSupplyDemand(job:Job,statuses:readonly any[],owned:ReadonlySet<string>=ownedAccounts('rs-sdk-demo.fly.dev'),now=Date.now()):boolean{
    if(job.script.replace(/\\/g,'/').replace(/^\.\//,'')!=='scripts/foodcourier.ts'||!Array.isArray(job.whenFoodLowFrom)||job.whenFoodLowFrom.length===0)return false;
    const below=job.foodLowBelow??80,minimum=job.sourceFoodMinimum??100,sourceName=job.foodSourceAccount;
    if(!Number.isSafeInteger(below)||below<1||!Number.isSafeInteger(minimum)||minimum<1||typeof sourceName!=='string'||!ACCOUNT.test(sourceName)||!owned.has(sourceName.toLowerCase()))return false;
    const validRows=(rows:any)=>Array.isArray(rows)&&rows.every(i=>Number.isSafeInteger(i?.id)&&i.id>=0&&Number.isSafeInteger(i.count)&&i.count>0);
    const knownBank=(s:any)=>Array.isArray(s?.bank)&&validRows(s.bank)&&Number.isFinite(s.bankAt)&&s.bankAt>0&&s.bankAt<=now;
    const cooked=(rows:readonly any[],notes:boolean)=>rows.reduce((n,i)=>n+([329,333,379,...(notes?[330,334,380]:[])].includes(i.id)?i.count:0),0);
    const source=statuses.find(s=>typeof s?.name==='string'&&s.name.toLowerCase()===sourceName.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev');
    if(!knownBank(source)||cooked(source.bank,false)<minimum)return false;
    return job.whenFoodLowFrom.some(name=>{
        if(typeof name!=='string'||!ACCOUNT.test(name)||!owned.has(name.toLowerCase()))return false;
        const farm=statuses.find(s=>typeof s?.name==='string'&&s.name.toLowerCase()===name.toLowerCase()&&s.server==='rs-sdk-demo.fly.dev');
        return !!farm&&!farm.result&&Number.isFinite(farm.at)&&now-farm.at>=0&&now-farm.at<30000&&knownBank(farm)&&validRows(farm.inventory)
            &&cooked(farm.bank,false)+cooked(farm.inventory,true)<below;
    });
}

export function pendingStartupCount(runs: readonly { started: number; accounts: readonly string[]; host?: boolean }[], now: number): number {
    let pending = 0;
    const seen = new Set<string>();
    for (const r of runs) {
        if (now - r.started >= 0 && now - r.started < START_RESERVE_MS) {
            if (r.host) pending += 1;
            else for (const a of r.accounts) if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); pending += 1; }
        }
    }
    return pending;
}

export function admissionDecision(v: { running: number; external: number; starting: number; startingReserve?: number; pending: number; freeGB: number; minFreeGB: number; maxBots: number }) {
    const floorGB = Math.max(FREE_FLOOR_GB, v.minFreeGB);
    const reserveGB = START_BUDGET_GB * (v.pending + (v.startingReserve ?? v.starting));
    const projectedFreeGB = v.freeGB - reserveGB;
    const reason = Object.values(v).some(n => !Number.isFinite(n) || n < 0) ? 'invalid'
        : v.running + v.external + v.starting > v.maxBots ? 'maxBots'
        : projectedFreeGB < floorGB ? 'memory' : null;
    return { allowed: reason === null, reason, floorGB, reserveGB, projectedFreeGB };
}

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

// Host account order is part of the invocation (the first account may lead).
// Display edits, enabling and repeat policy do not turn completed work into new work.
export function missionSignature(job: Job): string {
    return JSON.stringify([job.script, !!job.host,
        (job.host ? job.accounts ?? [] : [job.account ?? '']).map(a => a.toLowerCase()),
        Object.entries(job.env ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
}

export function overlappingRun<T extends { accounts: readonly string[] }>(runs: Iterable<T>, accounts: readonly string[]): T | undefined {
    const names = new Set(accounts.map(a => a.toLowerCase()));
    return [...runs].find(r => r.accounts.some(a => names.has(a.toLowerCase())));
}

export type EndRecord = { at: number; reason: string; revision?: string };
function successfulEnd(reason: string): boolean { return /^done(?: after \d+ runs)?$/.test(reason); }
// These failures need a fix before another login. "repeat" does not clear them.
export function persistentEnd(reason: string): boolean {
    return /^(?:died|blocked|gave-up)(?:\b|$)/.test(reason);
}
export function endedForGood(end: { reason: string } | undefined, repeat: boolean | undefined): boolean {
    return !!end && (!repeat || !successfulEnd(end.reason));
}
export function loadEnded(file: string): Map<string, EndRecord> {
    try { return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')))); }
    catch { return new Map(); }
}
export function persistEnded(file: string, ended: ReadonlyMap<string, EndRecord>): void {
    // Keep success and its launched revision too: a bounded job must not run
    // again merely because the controller restarted. Admission still permits
    // explicit repeat or genuinely changed work, with the usual session guard.
    writeFileSync(file, JSON.stringify(Object.fromEntries(ended), null, 1));
}

export function observeEnabled(accounts: readonly string[], enabled: boolean, previous: Map<string, boolean>, pending: Set<string>): void {
    for (const a of accounts) {
        const key=a.toLowerCase();
        if (enabled && previous.get(key) === false) pending.add(key);
        if (!enabled) pending.delete(key);
        previous.set(key, enabled);
    }
}

// Consume a deliberate resume only after the old process and its output settle.
// A persistent failure needs a separate repair, and done is not a pause to clear.
export function applyResume(accounts: readonly string[], active: boolean, ended: Map<string, EndRecord>, pending: Set<string>, clearStop: (a: string) => void): boolean {
    if (active) return false;
    let changed=false;
    for (const a of accounts) {
        const key=a.toLowerCase();
        if (!pending.delete(key)) continue;
        const entry=[...ended].find(([name])=>name.toLowerCase()===key);
        if (entry && (persistentEnd(entry[1].reason) || successfulEnd(entry[1].reason))) continue;
        clearStop(a);
        if (entry) ended.delete(entry[0]);
        changed=true;
    }
    return changed;
}
export function supervisorEndLine(line: string): string | undefined {
    return line.match(/^SUPERVISE end ([\w-]+ after \d+ runs)\s*$/)?.[1];
}

// Which accounts of a job may start now, and the state of each one that may not.
export function startable(accounts: string[], repeat: boolean | undefined, ended: Map<string, { reason: string; at?: number; revision?: string }>, statusAge: (a: string) => number, statusStarted?: (a: string) => number | undefined, revision?: string, stopped?: (a: string) => boolean): { start: string[]; blocked: Record<string, string> } {
    const start: string[] = [];
    const blocked: Record<string, string> = {};
    for (const a of accounts) {
        const end = ended.get(a) ?? [...ended].find(([name]) => name.toLowerCase() === a.toLowerCase())?.[1];
        // Release only a known success from different actual work. Retain the
        // end epoch so a newer external/manual session still wins admission.
        const newMission = !!end?.revision && !!revision && end.revision !== revision
            && /^done(?: after \d+ runs)?$/.test(end.reason);
        if (stopped?.(a)) blocked[a] = 'paused: stop file';
        else if (endedForGood(end, repeat) && !newMission) blocked[a] = `ended: ${end!.reason}`;
        else if (statusAge(a) < 30_000) {
            // The controller records done only after its supervisor has exited.
            // Its old status need not impose a second 30 s wait, but a newer
            // manual session (or an unknown epoch) still owns the account.
            let started: number | undefined;
            try { started = statusStarted?.(a); } catch { /* unknown remains external */ }
            if (end && /^done(?: after \d+ runs)?$/.test(end.reason) && Number.isFinite(end.at)
                && Number.isFinite(started) && started! > 0 && started! <= end.at!) start.push(a);
            else blocked[a] = 'external (status fresh, not started by swarm)';
        }
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
    const previousEnabled = new Map<string, boolean>();
    const pendingResume = new Set<string>();
    // Legacy filename retains success/revision, paused/unknown and hard ends.
    // A plan disable-enable resumes only pauses; hard failures need repair.
    const deathsFile = join(prac, 'swarm-deaths.json');
    const ended = loadEnded(deathsFile);
    const setEnded = ended.set.bind(ended);
    ended.set = (a, r) => {
        setEnded(a, r);
        persistEnded(deathsFile, ended);
        return ended;
    };
    const stopFile = (a: string) => join(prac, `stop-${a}`);
    const statusAge = (a: string) => { try { return Date.now() - statSync(join(prac, 'status', `${a}.json`)).mtimeMs; } catch { return Infinity; } };
    const statusStarted = (a: string): number | undefined => {
        try {
            const s = JSON.parse(readFileSync(join(prac, 'status', `${a}.json`), 'utf8'));
            return typeof s.name === 'string' && s.name.toLowerCase() === a.toLowerCase()
                && s.server === 'rs-sdk-demo.fly.dev' && Number.isFinite(s.started) ? s.started : undefined;
        } catch { return undefined; }
    };
    const botsRunning = () => [...runs.values()].reduce((n, r) => n + r.accounts.length, 0);

    const start = (p: ParsedJob, accounts: string[]) => {
        const job = p.job;
        const revision = missionSignature(job);
        const logName = p.host ? `host-${accounts[0]}.log` : `${accounts[0]}.log`;
        const log = createWriteStream(join(logDir, logName), { flags: 'a' });
        const cmd = p.host
            ? ['bun', 'packages/practice/src/supervise-host.ts', job.script, '20', ...accounts]
            : ['bun', 'packages/practice/src/supervise.ts', accounts[0]!, job.script, '20'];
        const proc = Bun.spawn(cmd, {
            cwd: root, stdout: 'pipe', stderr: 'pipe',
            env: { ...process.env, ...job.env, DEMO_OK: '1', BOT_ROLE: job.role ?? '', BOT_GOAL: job.goal ?? '' },
        });
        let currentEnd: string | undefined;
        const consume = (line: string) => {
            if (!p.host) { currentEnd = supervisorEndLine(line) ?? currentEnd; return; }
            const m = line.match(/^SUPERVISE-HOST account (.+?) ([\w-]+) after \d+ runs/);
            if (m) { ended.set(m[1]!, { at: Date.now(), reason: m[2]!, revision }); console.log(`SWARM end ${m[1]} ${m[2]} (host)`); }
        };
        const pumps = [proc.stdout, proc.stderr].map(async stream => {
            let tail = '';
            const decoder = new TextDecoder();
            for await (const c of stream as ReadableStream<Uint8Array>) {
                log.write(c);
                tail += decoder.decode(c, { stream: true });
                const lines = tail.split(/\r?\n/);
                tail = lines.pop() ?? '';
                for (const line of lines) consume(line);
            }
            consume(tail + decoder.decode());
        });
        const startedAt = Date.now();
        runs.set(p.key, { proc, started: startedAt, accounts, revision, host: p.host });
        console.log(`SWARM start ${p.host ? `host ${accounts.join(',')}` : accounts[0]} ${job.script} ${JSON.stringify(job.env ?? {})}`);
        void proc.exited.then(async code => {
            // Wait for the current process's final end line. An append log may still hold an older run's end.
            await Promise.all(pumps);
            runs.delete(p.key);
            if (!p.host) {
                const reason = currentEnd ?? `exit ${code}`;
                ended.set(accounts[0]!, { at: Date.now(), reason, revision });
                console.log(`SWARM end ${accounts[0]} ${reason}`);
            } else {
                // An account with no end line (the supervisor itself crashed) ends with the exit code.
                for (const a of accounts) {
                    if ((ended.get(a)?.at ?? 0) >= startedAt) continue;
                    ended.set(a, { at: Date.now(), reason: `exit ${code}`, revision });
                    console.log(`SWARM end ${a} exit ${code} (host)`);
                }
            }
            log.end();
        });
    };

    const tick = () => {
        let plan: Plan;
        try { plan = JSON.parse(readFileSync(planFile, 'utf8')); } catch (e) { console.log(`SWARM bad plan: ${String(e)}`); return; }
        if(!Array.isArray(plan.jobs)||!Number.isFinite(plan.maxBots)||plan.maxBots<1||!Number.isFinite(plan.minFreeGB)) { console.log('SWARM bad plan shape'); return; }
        const stopAll = existsSync(join(prac, 'stop-swarm'));
        const planned=plan.jobs.flatMap(j=>{ const p=parseJob(j); return 'error' in p?[]:[p]; });
        // A replacement host/account configuration waits for its current owner;
        // changing the run key must neither stop it nor permit a second login.
        for(const r of runs.values()) if(!overlappingRun(planned,r.accounts)||stopAll)
            for(const a of r.accounts) writeFileSync(stopFile(a),'swarm plan removed or stopped');
        const statuses: unknown[] = [];
        try {
            for (const file of readdirSync(join(prac, 'status'))) if (file.endsWith('.json')) {
                try { statuses.push(JSON.parse(readFileSync(join(prac, 'status', file), 'utf8'))); } catch { /* incomplete record */ }
            }
        } catch { /* no status directory yet */ }
        const externalCount = () => activeExternalLive(statuses, [...runs.values()].flatMap(r => r.accounts), Date.now()).length;
        const pendingCount = () => pendingStartupCount([...runs.values()], Date.now());
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
            observeEnabled(p.accounts, job.enabled, previousEnabled, pendingResume);
            if(stopAll) for(const a of p.accounts) writeFileSync(stopFile(a),'swarm stopped');
            const r = overlappingRun(runs.values(), p.accounts);
            if (!stopAll && applyResume(p.accounts, !!r, ended, pendingResume, a => rmSync(stopFile(a), {force:true})))
                persistEnded(deathsFile, ended);
            const st: Record<string, string> = {};
            if (r) {
                const stop = !job.enabled || stopAll;
                for (const a of p.accounts) {
                    if (!r.accounts.some(name => name.toLowerCase() === a.toLowerCase())) st[a] = 'waiting: current mission still running';
                    else if (ended.has(a) && ended.get(a)!.at >= r.started) st[a] = `ended: ${ended.get(a)!.reason}`;
                    else if (stop) { writeFileSync(stopFile(a), 'swarm'); st[a] = 'stopping'; }
                    else st[a] = pendingResume.has(a.toLowerCase()) ? 'stopping; resume queued'
                        : r.revision !== missionSignature(job) ? 'running; updated mission queued' : 'running';
                }
            } else if (!job.enabled || stopAll) for (const a of p.accounts) st[a] = 'disabled';
            else if(job.whenFoodLowFrom!==undefined&&!foodSupplyDemand(job,statuses))for(const a of p.accounts)st[a]='waiting offline: no fresh low-food farm or dated source food stock';
            else if(job.whenCargoFrom&&!courierDeliveryWaiting(job.whenCargoFrom,job.demandNear,plan.jobs)&&!ownedPayoutWaiting(statuses,job.demandNear)) for(const a of p.accounts) st[a]='waiting offline: no nearby owned cargo or payout';
            else {
                const { start: go, blocked } = startable(p.accounts, job.repeat, ended, statusAge, statusStarted, missionSignature(job), a => existsSync(stopFile(a)));
                Object.assign(st, blocked);
                if (go.length > 0) {
                    const admission = admissionDecision({ running: botsRunning(), external: externalCount(), starting: go.length, startingReserve: p.host ? 1 : go.length,
                        pending: pendingCount(), freeGB: freemem() / 2 ** 30, minFreeGB: plan.minFreeGB, maxBots: plan.maxBots });
                    if (!admission.allowed) for (const a of go) st[a] = admission.reason === 'maxBots' ? 'waiting: maxBots'
                        : `waiting: projected ${admission.projectedFreeGB.toFixed(1)} GB free after ${admission.reserveGB} GB startup reserve < ${admission.floorGB} GB floor`;
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
        const pendingStartup = pendingCount();
        writeFileSync(join(prac, 'swarm-state.json'), JSON.stringify({ at: Date.now(), freeGB: freemem() / 2 ** 30,
            running: botsRunning(), externalRunning: externalCount(), pendingStartup, pendingReserveGB: pendingStartup * START_BUDGET_GB,
            minFreeGB: Math.max(FREE_FLOOR_GB, plan.minFreeGB), maxBots: plan.maxBots, jobs: state }));
        if (stopAll && runs.size === 0) { console.log('SWARM stopped (stop-swarm)'); process.exit(0); }
    };

    console.log(`SWARM plan ${planFile}`);
    tick();
    setInterval(tick, 2000);
}
