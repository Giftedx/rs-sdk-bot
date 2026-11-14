import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAccounts, carriedPrior, ensureWorktree, keepPublished, planView, reattach, sideCapacity, sideCard, snapshot, worktreeProblem } from './fleet-sync';
import { SWARM_STOP } from './swarm';
import { CLAIM_MAX_AGE_MS } from '../packages/planner/src/autopilot';
import { mergeJobs } from '../packages/core/src/coordinator-jobs';

test('a coordinator job takes its account in the view, as the swarm runs it', () => {
    const owners = new Map([['oreelse', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const owner = [{ account: 'OreElse', script: 'scripts/goldfarm.ts', enabled: true }];
    const coordinator = [{ account: 'OreElse', script: 'scripts/magic-order.ts', enabled: true, goal: 'run-magic' }];
    expect(planView(mergeJobs(owner, coordinator), 'local', owners, 1).jobs.filter(j => j.enabled)).toEqual([{ account: 'OreElse', script: 'scripts/magic-order.ts', enabled: true, goal: 'run-magic' }]);
});

test('the plan view holds only this side\'s jobs, never the main account or job notes', () => {
    const owners = new Map([['oreelse', { side: 'local', server: 'rs-sdk-demo.fly.dev' }], ['haggis', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['quickhandjob', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['shaftsinker', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const jobs = [
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, standing: true, note: 'old story' },
        { account: 'Haggis', role: 'main', script: '', enabled: false },
        { account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true },
        { accounts: ['OreElse', 'Quickhandjob'], script: 'scripts/fleet-trade.ts', enabled: true },
        { accounts: ['OreElse', 'Shaftsinker'], script: 'scripts/quest-chain.ts', enabled: false },
    ];
    expect(planView(jobs, 'local', owners, 7)).toEqual({ side: 'local', at: 7, jobs: [
        { account: 'OreElse', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: '2671,3313' }, enabled: true, standing: true },
        { accounts: ['OreElse', 'Shaftsinker'], script: 'scripts/quest-chain.ts', enabled: false },
    ] });
});

test('the snapshot keeps a published row for an account with no local status or a staler one, never another side\'s row', () => {
    const owners = new Map([['quickhandjob', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['trousersnake', { side: 'claude-cloud', server: 'rs-sdk-demo.fly.dev' }], ['bigchopper', { side: 'local', server: 'rs-sdk-demo.fly.dev' }]]) as any;
    const row = (name: string, at: number, level: number) => ({ name, server: 'rs-sdk-demo.fly.dev', at, bank: [], inventory: [], equipment: [], skills: [{ name: 'Thieving', level }] });
    const prior = [row('TrouserSnake', 100, 99), row('Quickhandjob', 100, 99), row('Bigchopper', 100, 50)];
    // A fresh container: no status files. Both rows of this side stay; the local side's row is not this side's to publish.
    expect(snapshot([], 'claude-cloud', owners, 5, prior).accounts.map(a => [a.name, a.skills[0]!.level])).toEqual([['TrouserSnake', 99], ['Quickhandjob', 99]]);
    // A newer status replaces its row; an older one (a stale file copied in) does not.
    const status = (name: string, at: number, level: number) => ({ name, server: 'rs-sdk-demo.fly.dev', at, skills: [{ name: 'Thieving', level }], bank: [{ id: 995, name: 'Coins', count: 7 }] });
    const next = snapshot([status('Quickhandjob', 200, 99), status('TrouserSnake', 50, 1)], 'claude-cloud', owners, 5, prior).accounts;
    expect(next.map(a => [a.name, a.at, a.skills[0]!.level])).toEqual([['TrouserSnake', 100, 99], ['Quickhandjob', 200, 99]]);
    expect(next[1]!.bank).toEqual([{ id: 995, name: 'Coins', count: 7 }]);
});

test('an account is active for the claim when its snapshot row was written within CLAIM_MAX_AGE_MS', () => {
    const now = 10 * CLAIM_MAX_AGE_MS;
    const active = activeAccounts([{ name: 'Pocketpython', at: now - 60_000 }, { name: 'Billionaire', at: now - CLAIM_MAX_AGE_MS }, { name: 'Broken', at: 'x' }], now);
    expect(['Pocketpython', 'pocketpython', 'Billionaire', 'Broken', 'PickpockDick'].map(active)).toEqual([true, true, false, false, false]);
    expect(activeAccounts([], now)('Pocketpython')).toBe(false);
});

test('an empty plan keeps a fresh published claim that holds resources or a fresh published plan that holds jobs; a planned job, or a stale or empty one, does not', () => {
    const fresh = { side: 'claude-cloud', at: 1_000_000, resources: ['knight:2669,3298'] };
    expect(keepPublished([], fresh, 1_000_000 + 60_000)).toBe(true);
    expect(keepPublished([{ account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true }], fresh, 1_000_000 + 60_000)).toBe(false);
    expect(keepPublished([], { ...fresh, resources: [] }, 1_000_000 + 60_000)).toBe(false);
    expect(keepPublished([], fresh, 1_000_000 + CLAIM_MAX_AGE_MS)).toBe(false);
    expect(keepPublished([], null)).toBe(false);
    // A Ranged or quest job holds no exclusive resource: its claim is empty, so the fresh published plan that holds it is
    // what keeps an empty-plan session from erasing it; a stale or empty plan does not.
    const plan = { side: 'claude-cloud', at: 1_000_000, jobs: [{ account: 'TrouserSnake', script: 'scripts/ranged-train.ts', enabled: true }] };
    expect(keepPublished([], { ...fresh, resources: [] }, 1_000_000 + 60_000, plan)).toBe(true);
    expect(keepPublished([], null, 1_000_000 + 60_000, plan)).toBe(true);
    expect(keepPublished([], null, 1_000_000 + CLAIM_MAX_AGE_MS, plan)).toBe(false);
    expect(keepPublished([], null, 1_000_000 + 60_000, { ...plan, jobs: [] })).toBe(false);
    expect(keepPublished([{ account: 'Quickhandjob', script: 'scripts/goldfarm.ts', enabled: true }], null, 1_000_000 + 60_000, plan)).toBe(false);
});

test('a detached worktree goes back on its branch with its commits, and a diverged branch refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-sync-reattach-'));
    const run = (...args: string[]) => { const p = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, windowsHide: true }); if (p.exitCode !== 0) throw Error(p.stderr.toString()); return p.stdout.toString().trim(); };
    const commit = (text: string) => { writeFileSync(join(dir, 'f'), text); run('add', 'f'); run('commit', '-q', '-m', text); return run('rev-parse', 'HEAD'); };
    try {
        run('init', '-q', '-b', 'fleet-data');
        const first = commit('one');
        expect(reattach(dir, 'fleet-data')).toBe(false);
        run('checkout', '-q', '--detach');
        const second = commit('two');
        expect(run('rev-parse', 'fleet-data')).toBe(first);
        expect(reattach(dir, 'fleet-data')).toBe(true);
        expect(run('symbolic-ref', 'HEAD')).toBe('refs/heads/fleet-data');
        expect(run('rev-parse', 'fleet-data')).toBe(second);
        run('checkout', '-q', '--detach', first);
        expect(() => reattach(dir, 'fleet-data')).toThrow('holds commits that HEAD lacks');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a side card carries the plan\'s capacity and only the owner\'s pauses of its own accounts', () => {
    expect(sideCapacity({ maxBots: 4 })).toBe(4);
    expect(sideCapacity({ maxBots: 4, fleetCapacity: 9 })).toBe(9);
    expect(sideCapacity(null)).toBeNull();
    // The stop files carry the registry spelling (stop-Fatstack), as the swarm writes them; the card names them in lower case.
    const owned = ['Fatstack', 'Bravo', 'Charlie'];
    const stops: Record<string, string> = { Fatstack: 'owner: hold for the quest', Bravo: SWARM_STOP.job, charlie: 'owner hold', Kilo: 'owner hold' };
    expect(sideCard('claude-cloud', 4, owned, n => stops[n])).toEqual({ side: 'claude-cloud', capacity: 4, paused: ['charlie', 'fatstack'], died: [], stopped: false });
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? 'owner stopped the side' : undefined).stopped).toBe(true);
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? SWARM_STOP.all : undefined).stopped).toBe(false);
});

test('an adopted account keeps its last row from the side that ran it; a row this side has stays', () => {
    const owners = new Map([['fatstack', { side: 'local', server: 'rs-sdk-demo.fly.dev' }], ['kilo', { side: 'local', server: 'rs-sdk-demo.fly.dev' }],
        ['other', { side: 'cloud', server: 'rs-sdk-demo.fly.dev' }]]);
    const files = [{ side: 'claude-cloud', at: 9, accounts: [{ name: 'Fatstack', server: 'rs-sdk-demo.fly.dev', at: 9, skills: [{ name: 'Thieving', level: 99 }] }, { name: 'Kilo', at: 9 }] },
        { side: 'cloud', at: 9, accounts: [{ name: 'Other', at: 9 }] }];
    const prior = [{ name: 'Kilo', at: 5 }];
    const out = carriedPrior(prior, files, 'local', owners);
    expect(out.map(r => [r.name, r.at])).toEqual([['Kilo', 5], ['Fatstack', 9]]);
    expect(out[1]).not.toHaveProperty('side');
    // The snapshot this side publishes then holds it, so every reader sees Thieving 99 before its first login here.
    expect(snapshot([], 'local', owners, 10, out).accounts.find(a => a.name === 'Fatstack')?.skills).toEqual([{ name: 'Thieving', level: 99 }]);
});

test('a side card lists its accounts whose last end was a death', () => {
    expect(sideCard('local', 4, ['Fatstack', 'Kilo'], () => undefined, ['fatstack', 'Stranger']).died).toEqual(['fatstack']);
});

test('a clone of master alone gets the published fleet-data branch, never one made from the code', () => {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
    const base = mkdtempSync(join(tmpdir(), 'fleet-wt-'));
    try {
        const remote = join(base, 'remote.git'), seed = join(base, 'seed'), clone = join(base, 'clone');
        g(base, 'init', '--bare', remote); g(base, 'init', '-b', 'master', seed);
        writeFileSync(join(seed, 'code.ts'), 'code\n'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'code');
        g(seed, 'checkout', '-q', '--orphan', 'fleet-data'); g(seed, 'rm', '-rq', '--cached', '.');
        writeFileSync(join(seed, 'owners.json'), '{}\n'); g(seed, 'add', 'owners.json'); g(seed, 'commit', '-qm', 'fleet data');
        g(seed, 'remote', 'add', 'origin', remote); g(seed, 'push', '-q', 'origin', 'master', 'fleet-data');
        // A Codex checkout: master only, so `git fetch origin fleet-data` alone leaves origin/fleet-data missing.
        g(base, 'clone', '-q', '--single-branch', '--branch', 'master', remote, clone);
        const wt = ensureWorktree(join(clone, 'fleet'), clone);
        expect(g(wt, 'log', '--format=%s', '-1')).toBe('fleet data');
        expect(worktreeProblem(wt, 0)).toBeNull();
        // The worktree the old fetch made: fleet-data from the code. It holds commits the published branch lacks.
        const bogus = join(clone, 'bogus');
        g(clone, 'worktree', 'add', '-q', '-b', 'stray', bogus, 'master');
        expect(worktreeProblem(bogus, 0)).toContain('not the fleet-data branch');
    } finally { rmSync(base, { recursive: true, force: true }); }
});
