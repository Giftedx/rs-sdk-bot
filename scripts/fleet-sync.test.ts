import { test, expect } from 'bun:test';
import { blankCheckout, planView } from './fleet-sync';
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

test('a blank checkout keeps the branch\'s plan: no accounts known, no jobs of its own, jobs still recorded', () => {
    expect(blankCheckout([], [], [{ account: 'Quickhandjob' }])).toBe(true);
    expect(blankCheckout([], null, [{ account: 'Quickhandjob' }])).toBe(true);
    expect(blankCheckout([{ name: 'Quickhandjob' }], [], [{ account: 'Quickhandjob' }])).toBe(false);
    expect(blankCheckout([], [{ account: 'Quickhandjob', enabled: false }], [{ account: 'Quickhandjob' }])).toBe(false);
    expect(blankCheckout([], [], [])).toBe(false);
    expect(blankCheckout([], [], null)).toBe(false);
});
