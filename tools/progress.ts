// Reports the game progress of the fleet over a window (default 24 h). Merged pull requests and green checks are not
// progress. Bot time online, finished runs, XP, levels, quests and coins are.
// It reads these records of the main checkout and changes nothing:
// - online time and logins: the session attempts in .practice/live/session-lifecycle (and the legacy
//   .practice/session-lifecycle), from the `ready` event to the first `ended` or `closed` event;
// - use: average bots online divided by `maxBots` in swarm.json;
// - runs: .practice/results.jsonl;
// - gains: fleet/snapshots/<side>.json in the fleet-data worktree, the file now against its git version at the window start;
// - work: `activeChains` and `idleReasons` in .practice/live/fleet-state.json;
// - campaigns: the launch gates that hold each `staging` campaign in .practice/live/fleet-state.json.
// Usage: bun tools/progress.ts [hours]
// tools/now.ts prints the one-line form (progressLine).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorKey, readRecentResults, type ResultRow } from '../packages/core/src/fail-loops';
import { mySide } from '../packages/core/src/fleet';
import { fleetStateFile, lifecycleReadRoots, resolveFleetDataDir } from '../packages/core/src/practice-paths';
import { isHiscoreMarginFresh, MAX_CAMPAIGN_HISCORE_AGE_MS } from '../packages/brain/src/contracts';

export const HOUR_MS = 3600_000;
export const SHORT_LOGIN_MS = 5 * 60_000;
export const COINS_ID = 995;
const ATTEMPT_FILE = /^(\d{13})-\d{1,10}-\d{1,10}\.json$/;

export type AttemptEvent = { at?: number; kind?: string; detail?: string };
export type Attempt = { attemptId: string; account: string; createdAt: number; updatedAt?: number; script: string; events: AttemptEvent[] };
export type Window = { since: number; now: number };

export type Sessions = {
    botMs: number;
    // Attempts with a `ready` event in the window, those that ended less than 5 minutes after `ready`, and those with no
    // `ready` event at all (the login did not finish).
    logins: number;
    shortLogins: number;
    failedLogins: number;
    // Sessions with no end event that are the newest attempt of their account: counted as online until now.
    open: number;
    byScript: [string, number][];
};

export type Runs = {
    ok: number;
    failed: number;
    runMs: number;
    byGoal: { goal: string; ms: number; ok: number; failed: number }[];
    failClasses: { name: string; n: number; ms: number }[];
    topErrors: [string, number][];
};

export type SnapSkill = { name?: string; level?: number; xp?: number };
export type SnapItem = { id?: number; count?: number };
export type SnapAccount = { name?: string; skills?: SnapSkill[]; quests?: unknown; bank?: SnapItem[]; inventory?: SnapItem[] };
export type Snapshot = { at?: number; accounts?: SnapAccount[] };

export type Gains = {
    fromAt: number | null;
    toAt: number | null;
    compared: number;
    added: number;
    removed: number;
    xp: number;
    levels: number;
    questCompletions: number;
    newQuests: string[];
    coins: number;
    xpBySkill: [string, number][];
    xpByAccount: [string, number][];
};

export type Work = { at: number | null; withWork: number; idle: [string, number][] };

// The `staging` campaigns and the launch gates that hold them (packages/brain/src/campaigns.ts: `ready` needs a verified
// rehearsal, a met margin and a hiscore margin under MAX_CAMPAIGN_HISCORE_AGE_MS old). `onlyStale` names the campaigns
// that only an old hiscore snapshot holds: a hiscore refresh moves them to `ready`.
export type CampaignGates = {
    staging: number;
    noProof: number;
    marginShort: number;
    hiscoreStale: number;
    onlyStale: string[];
    oldestHiscoreMs: number | null;
};

export type ProgressReport = {
    hours: number;
    since: number;
    now: number;
    maxBots: number | null;
    sessions: Sessions | null;
    runs: Runs | null;
    gains: Gains | null;
    work: Work | null;
    campaigns?: CampaignGates | null;
    // One entry for each source that could not be read: "<part>: <reason>".
    errors: string[];
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const sortDesc = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

// Bot time online in the window. An account runs one session at a time, so an attempt with no end event that has a
// newer attempt of the same account ended at its last record, and the newest attempt with no end event is still online.
export function sessionStats(attempts: readonly Attempt[], w: Window): Sessions {
    const newest = new Map<string, number>();
    for (const a of attempts) {
        const k = a.account.toLowerCase();
        newest.set(k, Math.max(newest.get(k) ?? -Infinity, a.createdAt));
    }
    let botMs = 0, logins = 0, shortLogins = 0, failedLogins = 0, open = 0;
    const byScript = new Map<string, number>();
    for (const a of attempts) {
        const ready = a.events.find(e => e.kind === 'ready' && finite(e.at))?.at;
        const ends = a.events.filter(e => (e.kind === 'ended' || e.kind === 'closed') && finite(e.at)).map(e => e.at!);
        const isNewest = a.createdAt === newest.get(a.account.toLowerCase());
        if (ready === undefined) {
            // A login with no `ready` that ended, or that a newer attempt replaced, did not finish. The newest one with
            // no end event can still be connecting.
            if (a.createdAt >= w.since && a.createdAt <= w.now && (ends.length || !isNewest)) failedLogins++;
            continue;
        }
        let end: number;
        if (ends.length) end = Math.min(...ends);
        else if (isNewest) { end = w.now; open++; }
        else end = Math.max(ready, a.updatedAt ?? ready, ...a.events.map(e => (finite(e.at) ? e.at : ready)));
        if (ready >= w.since && ready <= w.now) {
            logins++;
            if (ends.length && end - ready < SHORT_LOGIN_MS) shortLogins++;
        }
        const ms = Math.max(0, Math.min(end, w.now) - Math.max(ready, w.since));
        botMs += ms;
        if (ms > 0) add(byScript, a.script, ms);
    }
    return { botMs, logins, shortLogins, failedLogins, open, byScript: sortDesc(byScript) };
}

// The failure classes, first match wins. A stop file names the cause, so it comes before the work that it stopped.
export const FAIL_CLASSES: [string, RegExp][] = [
    ['stop file', /stop file|admission paused|stopped by owner/i],
    ['claim or lease', /claim authority|lease authority|claim held|lease conflict|lease renewal|ETIMEDOUT|remote rejected/i],
    ['login or session', /too many login|disconnected|TickStall|session ended|login refused/i],
    ['trade', /fleet-trade|cargo stopped|order window|reconcile|partner failed|stock short|trade co/i],
    ['route', /no route|walk rejected|route to|quest corridor|walk-to|far walk/i],
    ['supply', /holds no|no supplies|"stop":"supplies"|stop=supplies|needs \d+ coins|requires staged|not enough|no food|missing/i],
    ['combat', /fled|died|retreat|threat|death/i],
    ['no progress', /no progress|no_payout|stop=cap|no result|targetMet=(?:false|0)/i],
];
export const failClass = (text: string): string => FAIL_CLASSES.find(([, re]) => re.test(text))?.[0] ?? 'other';

// Digits as #, so that the runs of one campaign item or one quest step are one goal.
export const goalKey = (goal: unknown): string => (typeof goal === 'string' && goal ? goal.replace(/\d+/g, '#').slice(0, 60) : 'no goal');

// The runs that finished in the window. Run time counts only the part inside the window.
export function runStats(rows: readonly ResultRow[], w: Window): Runs {
    let ok = 0, failed = 0, runMs = 0;
    const goals = new Map<string, { goal: string; ms: number; ok: number; failed: number }>();
    const classes = new Map<string, { name: string; n: number; ms: number }>();
    const errors = new Map<string, number>();
    for (const r of rows) {
        if (!finite(r.at) || r.at < w.since || r.at > w.now) continue;
        const ms = Math.max(0, r.at - Math.max(finite(r.started) ? r.started : r.at, w.since));
        runMs += ms;
        const key = goalKey(r.goal);
        const g = goals.get(key) ?? { goal: key, ms: 0, ok: 0, failed: 0 };
        g.ms += ms;
        goals.set(key, g);
        if (r.ok === true) { ok++; g.ok++; continue; }
        failed++; g.failed++;
        const text = String(r.text ?? '');
        const name = failClass(text);
        const c = classes.get(name) ?? { name, n: 0, ms: 0 };
        c.n++; c.ms += ms;
        classes.set(name, c);
        add(errors, errorKey(text), 1);
    }
    return {
        ok, failed, runMs,
        byGoal: [...goals.values()].sort((a, b) => b.ms - a.ms || a.goal.localeCompare(b.goal)),
        failClasses: [...classes.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)),
        topErrors: sortDesc(errors),
    };
}

const questsOf = (a: SnapAccount): Set<string> => new Set(Array.isArray(a.quests) ? a.quests.filter((q): q is string => typeof q === 'string') : []);
const coinsOf = (a: SnapAccount): number =>
    [...(a.bank ?? []), ...(a.inventory ?? [])].reduce((n, i) => n + (i?.id === COINS_ID && finite(i.count) ? i.count : 0), 0);
const skillsOf = (a: SnapAccount): Map<string, { xp: number; level: number }> => new Map((a.skills ?? [])
    .filter(s => typeof s?.name === 'string' && finite(s.xp) && finite(s.level)).map(s => [s.name!, { xp: s.xp!, level: s.level! }]));

// The gains of the accounts in both snapshots. A skill that one snapshot does not hold counts no gain. An account that
// only one snapshot holds is counted as added or removed, and its XP and coins are left out.
export function snapshotDiff(from: Snapshot, to: Snapshot): Gains {
    const index = (s: Snapshot) => new Map((s.accounts ?? []).filter(a => typeof a?.name === 'string').map(a => [a.name!.toLowerCase(), a]));
    const A = index(from), B = index(to);
    let xp = 0, levels = 0, questCompletions = 0, coins = 0, compared = 0;
    const xpBySkill = new Map<string, number>(), xpByAccount = new Map<string, number>();
    for (const [key, b] of B) {
        const a = A.get(key);
        if (!a) continue;
        compared++;
        const sa = skillsOf(a);
        let accountXp = 0;
        for (const [skill, now] of skillsOf(b)) {
            const before = sa.get(skill);
            if (!before) continue;
            const dx = Math.max(0, now.xp - before.xp);
            if (dx) { accountXp += dx; add(xpBySkill, skill, dx); }
            levels += Math.max(0, now.level - before.level);
        }
        xp += accountXp;
        if (accountXp) add(xpByAccount, b.name!, accountXp);
        const qa = questsOf(a);
        for (const q of questsOf(b)) if (!qa.has(q)) questCompletions++;
        coins += coinsOf(b) - coinsOf(a);
    }
    const known = new Set([...A.values()].flatMap(a => [...questsOf(a)]));
    const newQuests = [...new Set([...B.values()].flatMap(b => [...questsOf(b)]))].filter(q => !known.has(q)).sort();
    return {
        fromAt: finite(from.at) ? from.at : null, toAt: finite(to.at) ? to.at : null,
        compared, added: [...B.keys()].filter(k => !A.has(k)).length, removed: [...A.keys()].filter(k => !B.has(k)).length,
        xp, levels, questCompletions, newQuests, coins, xpBySkill: sortDesc(xpBySkill), xpByAccount: sortDesc(xpByAccount),
    };
}

export function workStats(state: { emittedAt?: unknown; activeChains?: unknown; idleReasons?: unknown }): Work {
    const chains = state.activeChains && typeof state.activeChains === 'object' ? Object.keys(state.activeChains).length : 0;
    const idle = new Map<string, number>();
    if (state.idleReasons && typeof state.idleReasons === 'object') {
        for (const reason of Object.values(state.idleReasons)) add(idle, typeof reason === 'string' ? reason : 'unknown', 1);
    }
    return { at: finite(state.emittedAt) ? state.emittedAt : null, withWork: chains, idle: sortDesc(idle) };
}

export function campaignGates(campaigns: unknown, now: number): CampaignGates {
    let staging = 0, noProof = 0, marginShort = 0, hiscoreStale = 0, oldest: number | null = null;
    const onlyStale: string[] = [];
    for (const c of Array.isArray(campaigns) ? campaigns : []) {
        if (!c || typeof c !== 'object' || c.state !== 'staging') continue;
        staging++;
        const proof = c.rehearsalProof?.verified === true;
        const margin = c.hiscoreMargin && typeof c.hiscoreMargin === 'object' ? c.hiscoreMargin : null;
        const meets = margin?.meetsMargin === true;
        const fresh = isHiscoreMarginFresh(margin, now);
        if (!proof) noProof++;
        if (!meets) marginShort++;
        if (margin && !fresh) hiscoreStale++;
        if (margin && finite(margin.checkedAt)) oldest = Math.max(oldest ?? -Infinity, now - margin.checkedAt);
        if (proof && meets && !fresh) onlyStale.push(typeof c.account === 'string' ? c.account : String(c.id));
    }
    return { staging, noProof, marginShort, hiscoreStale, onlyStale: onlyStale.sort(), oldestHiscoreMs: oldest };
}

const safeList = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

// The live-domain attempts that can overlap the window: for each account, the attempts created in it and the newest one
// created before it (an account runs one session at a time, so no older one can still be online).
export function readAttempts(roots: readonly string[], since: number): Attempt[] {
    const out = new Map<string, Attempt>();
    for (const root of roots) {
        const live = join(root, 'live');
        for (const server of safeList(live)) for (const account of safeList(join(live, server))) {
            const dir = join(live, server, account, 'attempts');
            const names = safeList(dir).filter(n => ATTEMPT_FILE.test(n)).sort();
            let first = names.findIndex(n => Number(n.slice(0, 13)) >= since);
            if (first < 0) first = names.length;
            for (const name of names.slice(Math.max(0, first - 1))) {
                const id = name.slice(0, -5);
                if (out.has(id)) continue;
                try {
                    const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
                    out.set(id, {
                        attemptId: id,
                        account: typeof rec.account === 'string' ? rec.account : account,
                        createdAt: finite(rec.createdAt) ? rec.createdAt : Number(name.slice(0, 13)),
                        updatedAt: finite(rec.updatedAt) ? rec.updatedAt : undefined,
                        script: typeof rec.owner?.script === 'string' ? rec.owner.script : 'no script',
                        events: Array.isArray(rec.events) ? rec.events : [],
                    });
                } catch { /* a file that is being written or is damaged counts no time */ }
            }
        }
    }
    return [...out.values()];
}

// The result rows that finished at or after `since`. The file grows for good, so read its end in larger parts until the
// first row is older than the window or the whole file is read.
export function readResultsSince(file: string, since: number): ResultRow[] {
    if (!existsSync(file)) return [];
    const size = statSync(file).size;
    for (let bytes = 4_000_000; ; bytes *= 4) {
        const rows = readRecentResults(file, bytes);
        const first = rows.find(r => finite(r.at));
        if (bytes >= size || (first && first.at! < since)) return rows.filter(r => finite(r.at) && r.at >= since);
    }
}

async function git(dir: string, args: string[]): Promise<string | null> {
    const proc = Bun.spawn(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
}

// The snapshot file now, and its newest committed version at or before `since`; the oldest committed version when the
// history starts inside the window.
export async function readSnapshots(fleetData: string, side: string, since: number): Promise<{ from: Snapshot; to: Snapshot }> {
    const path = `fleet/snapshots/${side}.json`;
    const to = JSON.parse(readFileSync(join(fleetData, path), 'utf8')) as Snapshot;
    let sha = (await git(fleetData, ['rev-list', '-1', `--before=${new Date(since).toISOString()}`, 'HEAD', '--', path]))?.trim();
    if (!sha) sha = (await git(fleetData, ['log', '--diff-filter=A', '--format=%H', '-1', '--', path]))?.trim();
    if (!sha) throw Error(`no git version of ${path}`);
    const text = await git(fleetData, ['show', `${sha}:${path}`]);
    if (text == null) throw Error(`git show ${sha.slice(0, 10)}:${path} failed`);
    return { from: JSON.parse(text) as Snapshot, to };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

export async function readProgress(main: string, hours: number, now = Date.now()): Promise<ProgressReport> {
    const w = { since: now - hours * HOUR_MS, now };
    const errors: string[] = [];
    const part = <T>(name: string, read: () => T): T | null => {
        try { return read(); } catch (e) { errors.push(`${name}: ${message(e)}`); return null; }
    };
    const gainsPromise = (async () => {
        try {
            const { from, to } = await readSnapshots(resolveFleetDataDir(main), mySide(), w.since);
            return snapshotDiff(from, to);
        } catch (e) { errors.push(`gains: ${message(e)}`); return null; }
    })();
    const maxBots = part('maxBots', () => {
        const n = JSON.parse(readFileSync(join(main, 'swarm.json'), 'utf8')).maxBots;
        if (!finite(n) || n <= 0) throw Error('swarm.json has no maxBots');
        return n;
    });
    const sessions = part('online', () => sessionStats(readAttempts(lifecycleReadRoots(main), w.since), w));
    const runs = part('runs', () => runStats(readResultsSince(join(main, '.practice', 'results.jsonl'), w.since), w));
    const state = part('work', () => JSON.parse(readFileSync(fleetStateFile(main), 'utf8')));
    const work = state == null ? null : part('work', () => workStats(state));
    const campaigns = state == null ? null : part('campaigns', () => campaignGates(state.campaigns, now));
    const gains = await gainsPromise;
    return { hours, since: w.since, now, maxBots, sessions, runs, gains, work, campaigns, errors };
}

const h1 = (ms: number) => (ms / HOUR_MS).toFixed(1);
const int = (n: number) => Math.round(n).toLocaleString('en-US');
const signed = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '') + int(Math.abs(n));
const top = (rows: [string, number][], n: number, fmt: (v: number) => string = int) => rows.slice(0, n).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');

function onlineText(r: ProgressReport): string {
    const s = r.sessions!;
    const avg = s.botMs / (r.now - r.since);
    const use = r.maxBots ? `, ${Math.round((100 * avg) / r.maxBots)}% of ${r.maxBots} maxBots` : '';
    return `${h1(s.botMs)} bot-hours online (average ${avg.toFixed(1)} bots${use})`;
}

// The one line that tools/now.ts prints.
export function progressLine(r: ProgressReport): string {
    const parts: string[] = [];
    const s = r.sessions;
    if (s) parts.push(`${onlineText(r)}, ${int(s.logins)} logins (${int(s.shortLogins)} under 5 min${s.open ? `, ${s.open} with no end event` : ''})`);
    else parts.push('online not known');
    if (r.runs) {
        const goal = r.runs.byGoal[0];
        parts.push(`runs ${int(r.runs.ok)} ok, ${int(r.runs.failed)} failed${goal ? `, most run time ${goal.goal} ${h1(goal.ms)} of ${h1(r.runs.runMs)} h` : ''}`);
    } else parts.push('runs not known');
    const g = r.gains;
    if (g) {
        // The start snapshot is the newest one at or before the window start: older when no sync ran then.
        const span = g.fromAt != null && g.toAt != null && Math.abs(g.toAt - g.fromAt - r.hours * HOUR_MS) > HOUR_MS ? ` (snapshots ${h1(g.toAt - g.fromAt)} h apart)` : '';
        parts.push(`XP +${int(g.xp)}, levels +${int(g.levels)}, quests +${int(g.questCompletions)}, coins ${signed(g.coins)}${span}`);
    } else parts.push('gains not known');
    if (r.work) parts.push(`${int(r.work.withWork)} accounts with work${r.work.idle.length ? ` (idle: ${top(r.work.idle, 2)})` : ''}`);
    else parts.push('work not known');
    if (r.campaigns?.onlyStale.length) parts.push(`${r.campaigns.onlyStale.length} campaigns held only by an old hiscore snapshot`);
    return `progress ${r.hours} h: ${parts.join('; ')} (bun tools/progress.ts)`;
}

// The full report of `bun tools/progress.ts`.
export function progressLines(r: ProgressReport): string[] {
    const out = [`progress over ${r.hours} h, ${new Date(r.since).toISOString()} to ${new Date(r.now).toISOString()}`];
    const s = r.sessions;
    if (s) {
        out.push(`online  ${onlineText(r)}`);
        out.push(`logins  ${int(s.logins)} logins, ${int(s.shortLogins)} under 5 min, ${int(s.failedLogins)} with no ready, ${int(s.open)} with no end event (counted online until now)`);
        if (s.byScript.length) out.push(`scripts ${top(s.byScript, 6, h1)} (bot-hours)`);
    }
    const u = r.runs;
    if (u) {
        out.push(`runs    ${int(u.ok + u.failed)} runs, ${int(u.ok)} ok, ${int(u.failed)} failed; ${h1(u.runMs)} run-hours`);
        if (u.byGoal.length) out.push(`goals   ${u.byGoal.slice(0, 6).map(g => `${g.goal} ${h1(g.ms)} h (${g.ok} ok, ${g.failed} failed)`).join(', ')}`);
        if (u.failClasses.length) out.push(`fails   ${u.failClasses.map(c => `${c.name} ${c.n}`).join(', ')}`);
        for (const [e, n] of u.topErrors.slice(0, 5)) out.push(`  error ${String(n).padStart(4)}  ${e}`);
    }
    const g = r.gains;
    if (g) {
        const span = g.fromAt != null && g.toAt != null ? `snapshots ${h1(g.toAt - g.fromAt)} h apart` : 'snapshot times not known';
        out.push(`gains   XP +${int(g.xp)}, levels +${int(g.levels)}, quest completions +${int(g.questCompletions)}, new quests fleet-wide ${g.newQuests.length}, coins ${signed(g.coins)}`);
        out.push(`        ${span}; ${g.compared} accounts in both, ${g.added} added, ${g.removed} removed`);
        if (g.newQuests.length) out.push(`quests  ${g.newQuests.join(', ')}`);
        if (g.xpBySkill.length) out.push(`skills  ${top(g.xpBySkill, 6)} (XP)`);
        if (g.xpByAccount.length) out.push(`top xp  ${top(g.xpByAccount, 6)}`);
    }
    const k = r.work;
    if (k) out.push(`work    ${k.withWork} accounts with work${k.idle.length ? `; idle: ${top(k.idle, 6)}` : ''}${k.at != null ? `; fleet state ${Math.round((r.now - k.at) / 1000)} s old` : ''}`);
    const c = r.campaigns;
    if (c?.staging) {
        const age = c.oldestHiscoreMs != null ? `, oldest ${h1(c.oldestHiscoreMs)} h` : '';
        out.push(`staging ${c.staging} campaigns: ${c.noProof} no verified rehearsal, ${c.marginShort} margin short or not known, `
            + `${c.hiscoreStale} hiscore older than ${Math.round(MAX_CAMPAIGN_HISCORE_AGE_MS / 60_000)} min${age}`);
        if (c.onlyStale.length) out.push(`        only the old hiscore holds ${c.onlyStale.join(', ')} (bun packages/planner/src/scout-cli.ts --out=.practice/live/specialist-launch/hiscores.json)`);
    }
    for (const e of r.errors) out.push(`missing ${e}`);
    return out;
}

// The main checkout runs the fleet and holds its records: the first worktree of `git worktree list`, as in now.ts.
export async function mainCheckout(here: string): Promise<string> {
    const list = (await git(here, ['worktree', 'list', '--porcelain'])) ?? '';
    return resolve(/^worktree (.+)$/m.exec(list)?.[1] ?? here);
}

if (import.meta.main) {
    const hours = Number(process.argv[2] ?? 24);
    if (!finite(hours) || hours <= 0) { console.error('usage: bun tools/progress.ts [hours]'); process.exit(2); }
    const main = await mainCheckout(resolve(import.meta.dir, '..'));
    for (const line of progressLines(await readProgress(main, hours))) console.log(line);
}
