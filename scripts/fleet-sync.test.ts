import { test, expect } from 'bun:test';
import { mergeSnapshot, planView, snapshot } from './fleet-sync';
import { mergeJobs } from '../packages/core/src/coordinator-jobs';

test('a sync replaces a snapshot row only with a newer status of that account and keeps the rows it has no status for', () => {
    const server = 'rs-sdk-demo.fly.dev';
    const owners = new Map([['quickhandjob', { side: 'claude-cloud', server }], ['trousersnake', { side: 'claude-cloud', server }], ['gone', { side: 'local', server }]]) as any;
    const row = (name: string, at: number, coins: number) => ({ name, server, at, bank: [{ id: 995, name: 'Coins', count: coins }], inventory: [], equipment: [], skills: [{ name: 'Thieving', level: 99 }] });
    const stored = [row('Quickhandjob', 200, 220_357), row('TrouserSnake', 200, 88_276), row('Gone', 200, 1)];
    // A fresh container with no status files: every stored row of this side stays; the account handed to another side goes.
    const empty = mergeSnapshot(snapshot([], 'claude-cloud', owners, 300), stored, owners);
    expect(empty).toEqual({ side: 'claude-cloud', at: 300, accounts: [stored[0], stored[1]] });
    // A newer status replaces its row; an older one (a stale file) does not; the other row stays.
    const status = (name: string, at: number, coins: number) => ({ ...row(name, at, coins), bank: [{ baseId: 995, name: 'Coins', count: coins }], skills: [{ name: 'Thieving', level: 99, xp: 1 }] });
    const merged = mergeSnapshot(snapshot([status('Quickhandjob', 500, 230_000), status('TrouserSnake', 100, 1)], 'claude-cloud', owners, 600), stored, owners);
    expect(merged.accounts).toEqual([row('Quickhandjob', 500, 230_000), stored[1]]);
});

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
