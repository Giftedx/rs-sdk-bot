import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeAccounts, keepPublished, planView, reattach, sideCapacity, sideCard, snapshot } from './fleet-sync';
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
    expect(sideCard('claude-cloud', 4, owned, n => stops[n])).toEqual({ side: 'claude-cloud', capacity: 4, paused: ['charlie', 'fatstack'], stopped: false });
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? 'owner stopped the side' : undefined).stopped).toBe(true);
    expect(sideCard('claude-cloud', 4, owned, n => n === 'swarm' ? SWARM_STOP.all : undefined).stopped).toBe(false);
});
