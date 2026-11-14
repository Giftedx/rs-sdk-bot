import { expect, test } from 'bun:test';
import { groupOrders, heldBack, heldCount, orderInWay, parseLine, planStage, stageJobs, stageObservations } from './route-stage';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swarmBusy } from './fleet-trade';

test('route donor availability follows current enabled jobs and coordinator overlays instead of older published jobs', () => {
    const base = mkdtempSync(join(tmpdir(), 'route-stage-jobs-')), fleetDir = join(base, 'fleet'), side = 'cloud';
    mkdirSync(join(fleetDir, 'plans'), { recursive: true }); mkdirSync(join(base, '.practice/coordinator'), { recursive: true });
    const published = [{ account: 'Disabled', script: 'scripts/goldfarm.ts', enabled: true },
        { account: 'Enabled', script: 'scripts/goldfarm.ts', enabled: false, autopilot: side }];
    try {
        writeFileSync(join(fleetDir, 'plans/cloud.json'), JSON.stringify({ side, jobs: published }));
        writeFileSync(join(base, 'swarm.json'), JSON.stringify({ maxBots: 3, jobs: [
            { account: 'Disabled', script: 'scripts/goldfarm.ts', enabled: false, autopilot: side },
            { account: 'Enabled', script: 'scripts/goldfarm.ts', enabled: true },
            { account: 'Overlay', script: 'scripts/goldfarm.ts', enabled: true, autopilot: side },
        ] }));
        writeFileSync(join(base, '.practice/coordinator/jobs.json'), JSON.stringify({ jobs: [
            { account: 'Overlay', script: 'scripts/quest-chain.ts', enabled: true, coordinatorOwner: 'coordinator' },
        ] }));
        const options = { base, fleetDir, localSide: side }, jobs = stageJobs(side, options);
        const busy = swarmBusy(jobs), owned = swarmBusy(jobs.filter(j => typeof j.autopilot === 'string'));
        expect([...busy].sort()).toEqual(['enabled', 'overlay']); expect([...owned]).toEqual([]);
        expect(heldBack('Disabled', jobs, undefined)).toBeUndefined();
        expect(jobs.find(j => j.account === 'Overlay').script).toBe('scripts/quest-chain.ts');
        const staged = planStage([{ item: 'oak logs', count: 10 }], () => 0, () => ['Disabled', 'Enabled', 'Overlay']
            .map(name => ({ name, count: 10, busy: busy.has(name.toLowerCase()), blocked: busy.has(name.toLowerCase()) && !owned.has(name.toLowerCase()) })), true);
        expect(staged.orders).toEqual([{ from: 'Disabled', item: 'oak logs', count: 10, busy: false }]);
        expect(staged.short).toEqual([]);
        expect(stageJobs(side, { ...options, localSide: 'local' })).toEqual(published);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('route availability retains published holds when the local plan or overlay cannot be read, and refuses unknown availability', () => {
    const base = mkdtempSync(join(tmpdir(), 'route-stage-job-fallback-')), fleetDir = join(base, 'fleet'), side = 'cloud';
    mkdirSync(join(fleetDir, 'plans'), { recursive: true }); mkdirSync(join(base, '.practice/coordinator'), { recursive: true });
    const published = [{ account: 'Held', script: '', enabled: false }], options = { base, fleetDir, localSide: side };
    try {
        writeFileSync(join(fleetDir, 'plans/cloud.json'), JSON.stringify({ side, jobs: published }));
        expect(stageJobs(side, options)).toEqual(published);
        for (const source of ['{', JSON.stringify({ jobs: 'unreadable' })]) {
            writeFileSync(join(base, 'swarm.json'), source);
            expect(heldBack('Held', stageJobs(side, options), undefined)).toBe('reserved (a job with no script)');
        }
        writeFileSync(join(base, 'swarm.json'), JSON.stringify({ maxBots: 3, jobs: [] }));
        writeFileSync(join(base, '.practice/coordinator/jobs.json'), '{');
        expect(stageJobs(side, options)).toEqual(published);
        writeFileSync(join(fleetDir, 'plans/cloud.json'), '{');
        expect(() => stageJobs(side, options)).toThrow('no readable job plan');
        rmSync(join(base, '.practice/coordinator/jobs.json'));
        expect(stageJobs(side, options)).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('route staging orders only the remaining stock from current local observations before the next sync', () => {
    const base = mkdtempSync(join(tmpdir(), 'route-stage-observations-')), fleetDir = join(base, 'fleet'), side = 'cloud', server = 'rs-sdk-demo.fly.dev';
    const statusDir = join(base, '.practice/status'), snapshotDir = join(fleetDir, 'snapshots');
    mkdirSync(statusDir, { recursive: true }); mkdirSync(snapshotDir, { recursive: true });
    const owners = new Map(['haggis', 'donor'].map(name => [name, { side, server }]));
    const row = (name: string, at: number, count: number) => ({ name, server, at, bankAt: 50, inventory: [], bank: [{ name: 'Oak logs', count }] });
    try {
        writeFileSync(join(snapshotDir, 'cloud.json'), JSON.stringify({ side, at: 300, accounts: [row('Haggis', 100, 0), row('Donor', 100, 50)] }));
        writeFileSync(join(statusDir, 'Haggis.json'), JSON.stringify(row('Haggis', 200, 30)));
        writeFileSync(join(statusDir, 'Donor.json'), JSON.stringify(row('Donor', 200, 20)));
        const rows = stageObservations(side, server, { base, fleetDir, owners, localSide: side });
        const receiver = rows.find(r => r.name === 'Haggis');
        const staged = planStage([{ item: 'oak logs', count: 50 }], item => heldCount(receiver, item),
            item => rows.filter(r => r.name !== 'Haggis').map(r => ({ name: r.name, count: heldCount(r, item), busy: false })), false);
        expect(receiver).toMatchObject({ at: 200, bankAt: 50 });
        expect(staged.held).toEqual([{ item: 'oak logs', count: 30 }]);
        expect(staged.orders).toEqual([{ from: 'Donor', item: 'oak logs', count: 20, busy: false }]);
        expect(staged.short).toEqual([]);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('route staging uses canonical adoption fallback and excludes foreign, practice and mismatched local data', () => {
    const base = mkdtempSync(join(tmpdir(), 'route-stage-domain-')), fleetDir = join(base, 'fleet'), side = 'cloud', server = 'rs-sdk-demo.fly.dev';
    const statusDir = join(base, '.practice/status'), snapshotDir = join(fleetDir, 'snapshots');
    mkdirSync(statusDir, { recursive: true }); mkdirSync(snapshotDir, { recursive: true });
    const names = ['Donor', 'Practice', 'WrongServer', 'Mismatch', 'Adopted', 'Mover'];
    const owners = new Map<string, { side: string; server: string }>([...names.map(name => [name.toLowerCase(), { side, server }] as const), ['foreign', { side: 'local', server }] as const]);
    const row = (name: string, at: number, count: number) => ({ name, server, at, bankAt: 50, inventory: [], bank: [{ name: 'Oak logs', count }] });
    try {
        writeFileSync(join(snapshotDir, 'cloud.json'), JSON.stringify({ side, at: 1000, accounts: [
            row('Donor', 100, 10), row('Practice', 100, 10), row('WrongServer', 100, 20), row('Mismatch', 100, 30), row('Mover', 50, 5), row('Foreign', 100, 100),
        ] }));
        writeFileSync(join(snapshotDir, 'old-side.json'), JSON.stringify({ side: 'old-side', accounts: [row('Adopted', 200, 40), row('Mover', 900, 90)] }));
        writeFileSync(join(statusDir, 'Practice.json'), JSON.stringify({ ...row('Practice', 900, 900), practice: true }));
        writeFileSync(join(statusDir, 'WrongServer.json'), JSON.stringify({ ...row('WrongServer', 900, 900), server: 'localhost:8888' }));
        writeFileSync(join(statusDir, 'Mismatch.json'), JSON.stringify(row('Donor', 900, 900)));
        const options = { base, fleetDir, owners, localSide: side };
        const rows = stageObservations(side, server, options);
        const counts = Object.fromEntries(rows.map(r => [r.name, heldCount(r, 'oak logs')]));
        expect(counts).toEqual({ Donor: 10, Practice: 10, WrongServer: 20, Mismatch: 30, Mover: 5, Adopted: 40 });
        expect(rows.find(r => r.name === 'Adopted')).toMatchObject({ side: 'old-side', at: 200, bankAt: 50 });
        writeFileSync(join(statusDir, 'Donor.json'), JSON.stringify(row('Donor', 900, 900)));
        expect(heldCount(stageObservations(side, server, { ...options, localSide: 'local' }).find(r => r.name === 'Donor'), 'oak logs')).toBe(10);
    } finally { rmSync(base, { recursive: true, force: true }); }
});

test('free holders give first, then the largest busy stock; the held count is not ordered', () => {
    const holders = (item: string) => item === 'magic logs'
        ? [{ name: 'OreElse', count: 107, busy: true }, { name: 'Bigchopper', count: 20, busy: false }] : [];
    const plan = planStage([{ item: 'magic logs', count: 110 }], () => 3, holders, true);
    expect(plan.held).toEqual([{ item: 'magic logs', count: 3 }]);
    expect(plan.orders).toEqual([
        { from: 'Bigchopper', item: 'magic logs', count: 20, busy: false },
        { from: 'OreElse', item: 'magic logs', count: 87, busy: true },
    ]);
    expect(plan.short).toEqual([]);
});

test('without --allow-busy a busy holder gives nothing and the rest is short', () => {
    const plan = planStage([{ item: 'magic logs', count: 107 }], () => 0, () => [{ name: 'OreElse', count: 107, busy: true }], false);
    expect(plan.orders).toEqual([]);
    expect(plan.short).toEqual([{ item: 'magic logs', count: 107, blocked: [] }]);
});

test('a holder in a job that the autopilot does not own never gives, and the short line names it', () => {
    const holders = () => [{ name: 'Woodpecker', count: 50, busy: true, blocked: true }, { name: 'OreElse', count: 20, busy: true }];
    const plan = planStage([{ item: 'logs', count: 30 }], () => 0, holders, true);
    expect(plan.orders).toEqual([{ from: 'OreElse', item: 'logs', count: 20, busy: true }]);
    expect(plan.short).toEqual([{ item: 'logs', count: 10, blocked: ['Woodpecker'] }]);
});

test('item lines and snapshot counts', () => {
    expect(parseLine('130 oak logs')).toEqual({ count: 130, item: 'oak logs' });
    expect(() => parseLine('oak logs')).toThrow('<count> <item>');
    expect(() => parseLine('0 knife')).toThrow();
    expect(heldCount({ bank: [{ name: 'Oak logs', count: 5 }], inventory: [{ name: 'Oak logs', count: 2 }, { name: 'Logs', count: 9 }] }, 'oak logs')).toBe(7);
    expect(heldCount(undefined, 'knife')).toBe(0);
});

test('an account in a trade or with an order its agent would pick is held; a reconcile order days old is not', () => {
    const order = (id: string, from: string, to: string, start: number, end: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from, to, item: 'logs', count: 1, start, end });
    const now = 10_000_000;
    const orders = [order('old', 'Bigchopper', 'UnderMyKilt', 1, 2), order('open', 'OreElse', 'Balls', now - 1000, now + 600_000), order('soon', 'Shaftmaker', 'Balls', now + 60_000, now + 900_000)];
    expect(orderInWay(orders, [], 'Bigchopper', now)).toBeUndefined();
    expect(orderInWay(orders, [], 'Balls', now)).toBe('open');
    // Balls is in the open trade: pickOrder skips the order that has its receipt, so the prepared receipt holds it.
    const trading = [{ id: 'open', role: 'to', account: 'Balls', state: 'prepared' }];
    expect(orderInWay(orders, trading, 'Balls', now)).toBe('open');
    // Inside the agent's 10-minute lead an order that starts later still holds its giver.
    expect(orderInWay(orders, [], 'Shaftmaker', now)).toBe('soon');
    const settled = [{ id: 'open', role: 'to', account: 'Balls', state: 'settled' }, { id: 'soon', role: 'to', account: 'Balls', state: 'settled' }];
    expect(orderInWay(orders, settled, 'Balls', now)).toBeUndefined();
});

test('a held trade claim of another order holds the account', () => {
    const claims = [{ account: 'mmsmk1232', orderId: '1794503734080-nabtheknob-mmsmk1232-bones' }];
    expect(orderInWay([], [], 'mmsmk1232', 1, claims)).toBe('1794503734080-nabtheknob-mmsmk1232-bones');
    expect(orderInWay([], [], 'MMSMK1232', 1, claims)).toBe('1794503734080-nabtheknob-mmsmk1232-bones');
    expect(orderInWay([], [], 'Shaftmaker', 1, claims)).toBeUndefined();
});

test('an owner stop file, a reservation or a hand job holds an account back from giving', () => {
    const jobs = [
        { account: 'Mightyrod', script: '', enabled: false },
        { account: 'WeeQuickie', script: 'scripts/firemaking-order.ts', enabled: false },
        { account: 'OreElse', script: 'scripts/goldfarm.ts', enabled: true, autopilot: 'local' },
        { account: 'Shaftmaker', script: 'scripts/shop-buyer.ts', enabled: false, autopilot: 'local' },
    ];
    expect(heldBack('Mightyrod', jobs, undefined)).toBe('reserved (a job with no script)');
    expect(heldBack('WeeQuickie', jobs, undefined)).toBe('hand job (disabled, not an autopilot job)');
    expect(heldBack('OreElse', jobs, undefined)).toBeUndefined();
    expect(heldBack('Shaftmaker', jobs, undefined)).toBeUndefined();
    expect(heldBack('Bigchopper', jobs, 'session: owner pause for a dagger gang pilot\n')).toBe('owner stop file');
    expect(heldBack('Bigchopper', jobs, 'swarm')).toBeUndefined();
    expect(heldBack('Bigchopper', jobs, undefined)).toBeUndefined();
});

test('each giver gets one order with all its lines, split at one trade window', () => {
    const groups = groupOrders([
        { from: 'Abracadickra', item: 'Sapphire ring', count: 40, busy: false },
        { from: 'Balls', item: 'Fire rune', count: 80, busy: true },
        { from: 'abracadickra', item: 'Cosmic rune', count: 74, busy: false },
    ]);
    expect(groups).toEqual([
        { from: 'Abracadickra', lines: [{ item: 'Sapphire ring', count: 40 }, { item: 'Cosmic rune', count: 74 }], busy: false },
        { from: 'Balls', lines: [{ item: 'Fire rune', count: 80 }], busy: true },
    ]);
    const many = groupOrders(Array.from({ length: 30 }, (_, i) => ({ from: 'Balls', item: `Item ${i}`, count: 1, busy: false })));
    expect(many.map(g => g.lines.length)).toEqual([28, 2]);
});
