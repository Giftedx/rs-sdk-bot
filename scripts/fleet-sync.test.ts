import { test, expect } from 'bun:test';
import { planView } from './fleet-sync';

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
