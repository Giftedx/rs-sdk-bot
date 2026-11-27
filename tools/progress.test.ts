import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    campaignGates, failClass, goalKey, progressLine, progressLines, readAttempts, readProgress, readResultsSince, runStats, sessionStats, sharedIdleBlocks, snapshotDiff, workStats,
    HOUR_MS, SHARED_IDLE_MAX, type Attempt, type ProgressReport, type Snapshot,
} from './progress';

const NOW = 1_800_000_000_000, MIN = 60_000;
const SINCE = NOW - 24 * HOUR_MS;
const W = { since: SINCE, now: NOW };
const dirs: string[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const attempt = (account: string, createdAt: number, events: [string, number][], over: Partial<Attempt> = {}): Attempt =>
    ({ attemptId: `${createdAt}-1-1`, account, createdAt, script: 'scripts/aio-logistics.ts', events: events.map(([kind, at]) => ({ kind, at })), ...over });

test('sessionStats counts online time inside the window, logins, short logins, failed logins and open sessions', () => {
    const s = sessionStats([
        // Online before the window starts: only the 30 minutes inside count, and it is no login of this window.
        attempt('Xa', SINCE - HOUR_MS, [['connecting', SINCE - HOUR_MS], ['ready', SINCE - 30 * MIN], ['ended', SINCE + 30 * MIN], ['closed', SINCE + 30 * MIN + 5]]),
        // A 2-minute session: a short login.
        attempt('xa', SINCE + HOUR_MS, [['ready', SINCE + HOUR_MS], ['ended', SINCE + HOUR_MS + 2 * MIN]], { script: 'scripts/aio-market.ts' }),
        // No end event, and the account has a newer attempt: it ended at its last record.
        attempt('Yb', SINCE + 2 * HOUR_MS, [['ready', SINCE + 2 * HOUR_MS], ['logout', SINCE + 2 * HOUR_MS + 10 * MIN]]),
        // No ready event: a failed login.
        attempt('Yb', SINCE + 3 * HOUR_MS, [['connecting', SINCE + 3 * HOUR_MS], ['ended', SINCE + 3 * HOUR_MS + 5]]),
        // The newest attempt of its account with no end event: online until now.
        attempt('Zc', NOW - HOUR_MS, [['ready', NOW - HOUR_MS]]),
        // Ended before the window.
        attempt('Q', SINCE - 3 * HOUR_MS, [['ready', SINCE - 3 * HOUR_MS], ['ended', SINCE - 2 * HOUR_MS]]),
    ], W);
    expect(s.botMs).toBe(30 * MIN + 2 * MIN + 10 * MIN + 60 * MIN);
    expect([s.logins, s.shortLogins, s.failedLogins, s.open]).toEqual([3, 1, 1, 1]);
    expect(s.byScript).toEqual([['scripts/aio-logistics.ts', 100 * MIN], ['scripts/aio-market.ts', 2 * MIN]]);
});

test('runStats clips run time to the window, merges goals by digits and classes the failures', () => {
    const r = runStats([
        { started: SINCE - HOUR_MS, at: SINCE + HOUR_MS, name: 'A', goal: 'aio-logistics', ok: true, text: 'ok' },
        { started: NOW - 10 * MIN, at: NOW - 5 * MIN, name: 'A', goal: 'campaign:haggis:item:1975', ok: false, text: 'fleet-trade xfer-1-2 failed 1/2: Error: order window ended during work' },
        { started: NOW - 4 * MIN, at: NOW - 3 * MIN, name: 'B', goal: 'campaign:haggis:item:233', ok: false, text: 'fleet-trade xfer-3-4 failed 3/4: stop file' },
        { started: NOW - 2 * MIN, at: NOW - MIN, name: 'B', goal: 'aio-logistics', ok: false, text: 'something new 42' },
        { started: SINCE - 2 * HOUR_MS, at: SINCE - HOUR_MS, name: 'C', goal: 'aio-logistics', ok: true, text: 'ok' },
    ], W);
    expect([r.ok, r.failed, r.runMs]).toEqual([1, 3, HOUR_MS + 7 * MIN]);
    expect(r.byGoal).toEqual([
        { goal: 'aio-logistics', ms: HOUR_MS + MIN, ok: 1, failed: 1 },
        { goal: 'campaign:haggis:item:#', ms: 6 * MIN, ok: 0, failed: 2 },
    ]);
    expect(r.failClasses.map(c => [c.name, c.n])).toEqual([['other', 1], ['stop file', 1], ['trade', 1]]);
    expect(r.topErrors[0]).toEqual(['fleet-trade xfer-#-# failed #/#: Error: order window ended during work', 1]);
});

test('failClass and goalKey', () => {
    expect(failClass('fleet-trade xfer-1 failed: stop file')).toBe('stop file');
    expect(failClass('Error: cargo stopped')).toBe('trade');
    expect(failClass('walk-to {"ok":false,"reason":"precondition","detail":"no route"}')).toBe('route');
    expect(failClass('no_payout: delta=-5 (10 -> 5)')).toBe('no progress');
    expect(failClass('squad startup K: Error: fleet swarm claim authority timed out')).toBe('claim or lease');
    expect(failClass('{"ok":false,"stop":"supplies","casts":3}')).toBe('supply');
    expect(failClass('retreat during bolren: hp 3 of 40, no food')).toBe('supply');
    expect(failClass('weird')).toBe('other');
    expect(goalKey('goal:quest_board:12')).toBe('goal:quest_board:#');
    expect(goalKey(undefined)).toBe('no goal');
});

const acct = (name: string, xp: Record<string, [number, number]>, quests: string[], bankCoins: number, invCoins = 0) => ({
    name, quests,
    skills: Object.entries(xp).map(([skill, [level, x]]) => ({ name: skill, level, xp: x })),
    bank: [{ id: 995, count: bankCoins }, { id: 554, count: 300 }],
    inventory: invCoins ? [{ id: 995, count: invCoins }] : [],
});

test('snapshotDiff sums XP, levels, quests and coins of the accounts in both snapshots', () => {
    const from: Snapshot = { at: SINCE, accounts: [
        acct('Alpha', { Attack: [10, 1000], Magic: [5, 400] }, ["Cook's Assistant"], 5000),
        acct('Beta', { Fishing: [20, 4000] }, ['Sheep Shearer'], 100, 50),
        acct('Gone', { Attack: [1, 0] }, [], 9999),
    ] };
    const to: Snapshot = { at: NOW, accounts: [
        // Magic is missing from the newer snapshot: no gain and no loss.
        acct('alpha', { Attack: [12, 1500], Ranged: [3, 200] }, ["Cook's Assistant", 'Rune Mysteries Quest'], 4000),
        acct('Beta', { Fishing: [22, 4800] }, ['Sheep Shearer', "Cook's Assistant"], 1000),
        acct('Fresh', { Attack: [50, 100_000] }, ['Dragon Slayer'], 1_000_000),
    ] };
    const g = snapshotDiff(from, to);
    expect(g).toEqual({
        fromAt: SINCE, toAt: NOW, compared: 2, added: 1, removed: 1,
        xp: 500 + 800, levels: 2 + 2, questCompletions: 2,
        // Cook's Assistant was known fleet-wide before; Rune Mysteries and Dragon Slayer were not.
        newQuests: ['Dragon Slayer', 'Rune Mysteries Quest'],
        coins: (4000 - 5000) + (1000 - 150),
        xpBySkill: [['Fishing', 800], ['Attack', 500]],
        xpByAccount: [['Beta', 800], ['alpha', 500]],
    });
});

test('workStats counts the accounts with an active chain and tallies the idle reasons', () => {
    expect(workStats({ emittedAt: NOW, activeChains: { A: {}, B: {} }, idleReasons: { C: 'paused_owner', D: 'in_trade', E: 'paused_owner', F: 7 } }))
        .toEqual({ at: NOW, withWork: 2, idle: [['paused_owner', 2], ['in_trade', 1], ['unknown', 1]] });
    expect(workStats({})).toEqual({ at: null, withWork: 0, idle: [] });
});

test('campaignGates names the staging campaigns that only an old hiscore snapshot holds', () => {
    const old = NOW - 31 * HOUR_MS;
    const margin = (meetsMargin: boolean, checkedAt: number) => ({ board: 'Mining', rivalTicks: 100, ourTicks: 90, marginTicks: 10, marginRatio: 0.1, checkedAt, meetsMargin });
    const g = campaignGates([
        { id: 'campaign:rocksolid', account: 'rocksolid', state: 'staging', rehearsalProof: { verified: true }, hiscoreMargin: margin(true, old) },
        { id: 'campaign:bigswinger', account: 'bigswinger', state: 'staging', rehearsalProof: { verified: true }, hiscoreMargin: margin(true, old) },
        { id: 'campaign:haggis', account: 'haggis', state: 'staging', rehearsalProof: { verified: false }, hiscoreMargin: margin(true, old) },
        { id: 'campaign:hiltsdeep', account: 'hiltsdeep', state: 'staging', rehearsalProof: null, hiscoreMargin: margin(false, NOW - MIN) },
        { id: 'campaign:steelrod', account: 'steelrod', state: 'staging', rehearsalProof: null, hiscoreMargin: null },
        { id: 'campaign:done', account: 'done', state: 'ready', rehearsalProof: { verified: true }, hiscoreMargin: margin(true, NOW - MIN) },
    ], NOW);
    expect(g).toEqual({ staging: 5, noProof: 3, marginShort: 2, hiscoreStale: 3, onlyStale: ['bigswinger', 'rocksolid'], oldestHiscoreMs: 31 * HOUR_MS });
    expect(campaignGates(undefined, NOW)).toEqual({ staging: 0, noProof: 0, marginShort: 0, hiscoreStale: 0, onlyStale: [], oldestHiscoreMs: null });
    const r = report({ campaigns: g });
    expect(progressLine(r)).toContain('; 2 campaigns held only by an old hiscore snapshot (bun tools/progress.ts)');
    const lines = progressLines(r);
    expect(lines).toContain('staging 5 campaigns: 3 no verified rehearsal, 2 margin short or not known, 3 hiscore older than 60 min, oldest 31.0 h');
    expect(lines.some(l => l.includes('only the old hiscore holds bigswinger, rocksolid'))).toBe(true);
});

const writeAttempt = (root: string, account: string, createdAt: number, events: [string, number][], script = 'scripts/aio-logistics.ts') => {
    const dir = join(root, 'live', 'rs-sdk-demo.fly.dev', account.toLowerCase(), 'attempts');
    mkdirSync(dir, { recursive: true });
    const id = `${createdAt}-0000000001-0000000001`;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ schema: 'session-lifecycle/1', attemptId: id, account, createdAt, updatedAt: events.at(-1)?.[1] ?? createdAt,
        owner: { script }, events: events.map(([kind, at]) => ({ kind, at })) }));
    return dir;
};

test('readAttempts reads, for each account, the attempts of the window and the newest one before it, from every root', () => {
    const base = temp('progress-attempts-');
    const live = join(base, 'live-root'), legacy = join(base, 'legacy-root');
    writeAttempt(live, 'Balls', SINCE - 5 * HOUR_MS, [['ready', SINCE - 5 * HOUR_MS], ['ended', SINCE - 4 * HOUR_MS]]);
    const dir = writeAttempt(live, 'Balls', SINCE - HOUR_MS, [['ready', SINCE - HOUR_MS], ['ended', SINCE + HOUR_MS]]);
    writeAttempt(live, 'Balls', SINCE + 2 * HOUR_MS, [['ready', SINCE + 2 * HOUR_MS], ['ended', SINCE + 3 * HOUR_MS]]);
    writeFileSync(join(dir, `${SINCE + 4 * HOUR_MS}-0000000002-0000000001.json`), '{"half');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeAttempt(legacy, 'Other', SINCE - 90 * HOUR_MS, [['ready', SINCE - 90 * HOUR_MS], ['ended', SINCE - 89 * HOUR_MS]]);
    const rows = readAttempts([live, legacy, join(base, 'missing')], SINCE);
    expect(rows.map(r => [r.account, r.createdAt]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
        ['Other', SINCE - 90 * HOUR_MS], ['Balls', SINCE - HOUR_MS], ['Balls', SINCE + 2 * HOUR_MS]]);
    expect(sessionStats(rows, W).botMs).toBe(2 * HOUR_MS);
});

test('readResultsSince keeps the rows that finished in the window', () => {
    const file = join(temp('progress-results-'), 'results.jsonl');
    writeFileSync(file, [
        JSON.stringify({ started: SINCE - 2 * HOUR_MS, at: SINCE - HOUR_MS, name: 'Old', ok: true }),
        'not json',
        JSON.stringify({ started: SINCE, at: SINCE + MIN, name: 'New', ok: true }),
        '',
    ].join('\n'));
    expect(readResultsSince(file, SINCE).map(r => r.name)).toEqual(['New']);
    expect(readResultsSince(join(file, '..', 'none.jsonl'), SINCE)).toEqual([]);
});

const report = (over: Partial<ProgressReport> = {}): ProgressReport => ({
    hours: 24, since: SINCE, now: NOW, maxBots: 25,
    sessions: { botMs: 36 * HOUR_MS, logins: 1105, shortLogins: 974, failedLogins: 3, open: 0, byScript: [['scripts/aio-logistics.ts', 20 * HOUR_MS]] },
    runs: { ok: 522, failed: 308, runMs: 28.1 * HOUR_MS, byGoal: [{ goal: 'aio-logistics', ms: 19 * HOUR_MS, ok: 400, failed: 100 }], failClasses: [{ name: 'trade', n: 130, ms: HOUR_MS }], topErrors: [['Error: cargo stopped', 21]] },
    gains: { fromAt: SINCE, toAt: NOW, compared: 73, added: 0, removed: 0, xp: 1_085_460, levels: 123, questCompletions: 1, newQuests: [], coins: -272_623, xpBySkill: [['Magic', 449_213]], xpByAccount: [['Woodenstaff', 407_638]] },
    work: { at: NOW - 2000, withWork: 0, idle: [['infra_circuit_breaker_open', 64], ['campaign_state_staging', 20], ['paused_owner', 10]] },
    errors: [], ...over,
});

test('progressLine puts the window, online use, runs, gains and work on one line', () => {
    expect(progressLine(report())).toBe('progress 24 h: 36.0 bot-hours online (average 1.5 bots, 6% of 25 maxBots), 1,105 logins (974 under 5 min); '
        + 'runs 522 ok, 308 failed, most run time aio-logistics 19.0 of 28.1 h; XP +1,085,460, levels +123, quests +1, coins -272,623; '
        + '0 accounts with work (idle: infra_circuit_breaker_open 64, campaign_state_staging 20); '
        + 'IDLE BLOCK 64 accounts at infra_circuit_breaker_open, 20 accounts at campaign_state_staging (more than 10 at one reason) (bun tools/progress.ts)');
});

test('progressLine names an open session, a start snapshot older than the window and the parts it could not read', () => {
    const r = report();
    const line = progressLine({ ...r, maxBots: null, sessions: { ...r.sessions!, open: 2 }, gains: { ...r.gains!, fromAt: NOW - 86.6 * HOUR_MS }, runs: null, work: null });
    expect(line).toContain('(average 1.5 bots), 1,105 logins (974 under 5 min, 2 with no end event)');
    expect(line).toContain('coins -272,623 (snapshots 86.6 h apart)');
    expect(line).toContain('runs not known');
    expect(line).toContain('work not known');
});

test('progressLines prints each part and each source that could not be read', () => {
    const lines = progressLines(report({ errors: ['gains: no git version of fleet/snapshots/local.json'] }));
    expect(lines[0]).toBe(`progress over 24 h, ${new Date(SINCE).toISOString()} to ${new Date(NOW).toISOString()}`);
    expect(lines).toContain('logins  1,105 logins, 974 under 5 min, 3 with no ready, 0 with no end event (counted online until now)');
    expect(lines).toContain('runs    830 runs, 522 ok, 308 failed; 28.1 run-hours');
    expect(lines).toContain('  error   21  Error: cargo stopped');
    expect(lines).toContain('gains   XP +1,085,460, levels +123, quest completions +1, new quests fleet-wide 0, coins -272,623');
    expect(lines).toContain('work    0 accounts with work; idle: infra_circuit_breaker_open 64, campaign_state_staging 20, paused_owner 10; fleet state 2 s old');
    expect(lines.at(-1)).toBe('missing gains: no git version of fleet/snapshots/local.json');
});

test('sharedIdleBlocks fails on more than SHARED_IDLE_MAX accounts at one blocker, not at a pause, a death or a slot cap', () => {
    const idle: [string, number][] = [
        ['unresolvable_supply:1289', 32], ['missing_skill_unlock:Hitpoints', 20], ['dead', 13], ['paused_owner', 12],
        ['max_bots_limit', 31], ['owned_by_other_side:cloud', 14], ['protected_clock_no_campaign', 11], ['missing_coins:500', SHARED_IDLE_MAX],
    ];
    expect(sharedIdleBlocks({ idle })).toEqual([['unresolvable_supply:1289', 32], ['missing_skill_unlock:Hitpoints', 20]]);
    expect(sharedIdleBlocks({ idle: [['missing_coins:500', SHARED_IDLE_MAX]] })).toEqual([]);
    const lines = progressLines(report({ work: { at: NOW - 2000, withWork: 0, idle } }));
    expect(lines).toContain('block   32 accounts at unresolvable_supply:1289, 20 accounts at missing_skill_unlock:Hitpoints (more than 10 at one reason)');
    expect(progressLine(report({ work: { at: NOW, withWork: 3, idle: [['paused_owner', 40]] } }))).not.toContain('IDLE BLOCK');
});

const git = (dir: string, args: string[], date?: number) => {
    const stamp = date ? `@${Math.floor(date / 1000)} +0000` : undefined;
    const env = stamp ? { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : process.env;
    const r = Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    if (r.exitCode !== 0) throw Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
};

test('readProgress reads every source of a main checkout, and names the ones that are missing', async () => {
    const main = temp('progress-main-');
    writeFileSync(join(main, 'swarm.json'), JSON.stringify({ maxBots: 4 }));
    mkdirSync(join(main, '.practice', 'live'), { recursive: true });
    writeFileSync(join(main, '.practice', 'results.jsonl'), JSON.stringify({ started: NOW - 2 * HOUR_MS, at: NOW - HOUR_MS, name: 'A', goal: 'aio-logistics', ok: true, text: 'ok' }) + '\n');
    writeFileSync(join(main, '.practice', 'live', 'fleet-state.json'), JSON.stringify({ emittedAt: NOW, activeChains: { A: {} }, idleReasons: { B: 'paused_owner' } }));
    writeAttempt(join(main, '.practice', 'live', 'session-lifecycle'), 'A', NOW - 3 * HOUR_MS, [['ready', NOW - 3 * HOUR_MS], ['ended', NOW - HOUR_MS]]);
    const fleet = join(main, '.practice', 'fleet-data'), snaps = join(fleet, 'fleet', 'snapshots');
    mkdirSync(snaps, { recursive: true });
    git(fleet, ['init', '-q']);
    const snap = (at: number, xp: number, coins: number) => JSON.stringify({ side: 'local', at, accounts: [acct('A', { Attack: [10, xp] }, [], coins)] });
    writeFileSync(join(snaps, 'local.json'), snap(SINCE - 2 * HOUR_MS, 100, 50));
    git(fleet, ['add', '.'], SINCE - 2 * HOUR_MS);
    git(fleet, ['commit', '-q', '-m', 'old'], SINCE - 2 * HOUR_MS);
    writeFileSync(join(snaps, 'local.json'), snap(SINCE + HOUR_MS, 300, 70));
    git(fleet, ['commit', '-q', '-am', 'in window'], SINCE + HOUR_MS);
    // The working file is the newest snapshot, and need not be committed yet.
    writeFileSync(join(snaps, 'local.json'), snap(NOW, 1100, 20));
    const prev = process.env.FLEET_SIDE;
    delete process.env.FLEET_SIDE;
    try {
        const r = await readProgress(main, 24, NOW);
        expect(r.errors).toEqual([]);
        expect(r.maxBots).toBe(4);
        expect(r.sessions!.botMs).toBe(2 * HOUR_MS);
        expect([r.runs!.ok, r.runs!.failed]).toEqual([1, 0]);
        expect([r.gains!.fromAt, r.gains!.xp, r.gains!.coins]).toEqual([SINCE - 2 * HOUR_MS, 1000, -30]);
        expect(r.work).toEqual({ at: NOW, withWork: 1, idle: [['paused_owner', 1]] });
        expect(progressLine(r)).toContain('2.0 bot-hours online (average 0.1 bots, 2% of 4 maxBots), 1 logins (0 under 5 min)');

        const empty = await readProgress(temp('progress-empty-'), 24, NOW);
        expect(empty.errors.map(e => e.split(':')[0]).sort()).toEqual(['gains', 'maxBots', 'work']);
        expect(empty.sessions!.botMs).toBe(0);
        expect(empty.runs!.ok).toBe(0);
    } finally {
        if (prev === undefined) delete process.env.FLEET_SIDE; else process.env.FLEET_SIDE = prev;
    }
});
