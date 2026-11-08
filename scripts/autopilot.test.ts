import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobLogStart } from '../packages/core/src/job-log';
import { catalogue, finishedTrainers, jobFor, mergeJobs, plan, plannableAccounts, reservedResources, type Acct, type Inputs } from '../packages/planner/src/autopilot';
import { missionSignature, startable } from './swarm';
import { coinOrder, fundOrders, inOpenOrder, planningOwnership, readJobResultLines, tradeStockReady } from './autopilot';
import type { TradeReceipt } from './fleet-trade-settlement';

const side = 'claude-cloud';
const inputs = (a: Acct): Inputs => ({ side, accounts: [a], owners: new Map([[a.name.toLowerCase(), { side }]]), bill: [], templates: catalogue(), prices: {} });
const settled = () => 60_000;

test('a trainer at its target stays ended for the swarm, and the next pass starts the account on its next template', () => {
    const fresh: Acct = { name: 'TrouserSnake', side, skills: { Hitpoints: 10 }, items: {} };
    const [first] = plan(inputs(fresh));
    const trainer = jobFor(first!, side);
    expect(trainer).toMatchObject({ template: 'thieving55', enabled: true, repeat: false, standing: true });

    // The trainer's ok RESULT: the supervisor ends done, and a job that does not repeat is blocked on that end.
    const ended = new Map([['TrouserSnake', { reason: 'done after 1 runs', at: 1000, revision: missionSignature(trainer) }]]);
    expect(startable(['TrouserSnake'], trainer.repeat, ended, settled, undefined, missionSignature(trainer)))
        .toEqual({ start: [], blocked: { TrouserSnake: 'ended: done after 1 runs' } });
    // The daemon sees the finish in the job's log since its assignment and passes without waiting for the timer.
    const assigned = { TrouserSnake: { template: 'thieving55', offset: 0 } };
    expect(finishedTrainers([trainer], side, assigned, catalogue(), () => ['RESULT ok thieving=55 xp=16000 ticks=1736 died=false'])).toEqual(['TrouserSnake']);

    // That pass reads the status at the target level: the trainer is skipped, a knight spot replaces it, and the new
    // mission starts although the account's last end is done.
    const [next] = plan(inputs({ ...fresh, skills: { ...fresh.skills, Thieving: 55 } }));
    expect(next!.template!.id).toMatch(/^goldfarm@/);
    const merged = mergeJobs([trainer], side, [next!]);
    expect(merged.fresh).toEqual(['TrouserSnake']);
    expect(merged.jobs).toEqual([jobFor(next!, side)]);
    expect(merged.jobs[0].repeat).toBe(true);
    expect(startable(['TrouserSnake'], merged.jobs[0].repeat, ended, settled, undefined, missionSignature(merged.jobs[0])).start).toEqual(['TrouserSnake']);
});


const order = (id: string, from: string, to: string, end: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from, to, item: 'coins', count: 1500, start: 0, end });
const make = (from: string, to: string, coins: number) => ({ ...order(`o-${from}-${to}`, from, to, 9_999), count: coins });

test('legacy order receipts do not close a live window or supply proven stock', () => {
    const orders = [order('a', 'Big', 'Poor', 100), order('b', 'Rich', 'Low', 100), order('c', 'Old', 'Gone', 10)];
    const receipts = [{ id: 'b', role: 'from' }, { id: 'b', role: 'to' }] as any;
    expect([...inOpenOrder(orders, receipts, 50)].sort()).toEqual(['big', 'low', 'poor', 'rich']);
    expect([...inOpenOrder(orders, receipts, 101)]).toEqual([]);
});

test('funding holds past expiry on incomplete proof and releases each party only against current settled stock', () => {
    const o = order('a', 'Big', 'Poor', 3000);
    const receipt = (role: 'from' | 'to'): TradeReceipt => ({
        version: 2, state: 'settled', id: o.id, role, account: o[role], partner: role === 'from' ? o.to : o.from, side: 'local',
        server: o.server, item: o.item, requested: o.count, claim: '12345678-1234-1234-1234-123456789012', at: 2700,
        ok: true, detail: '', count: o.count, inventory: role === 'from' ? { before: o.count, after: 0 } : { before: 0, after: o.count },
        ...(role === 'to' ? { bank: { count: o.count, at: 2300 } } : {}),
        logout: { attemptId: '0000000002400-1-1', at: 2600, sha256: 'a'.repeat(64) },
    });
    const giver = receipt('from'), receiver = receipt('to'), now = 5000;
    const expected = ['big', 'poor'];
    const held = (r: TradeReceipt[]) => [...inOpenOrder([o], r, now)].sort();
    expect(held([{ ...giver, state: 'prepared', ok: false }])).toEqual(expected);
    expect(held([giver, { ...receiver, state: 'reconcile', ok: false }])).toEqual(expected);
    expect(held([giver, { ...receiver, bank: undefined }])).toEqual(expected);
    expect(held([giver, { ...receiver, partner: 'Wrong' }])).toEqual(expected);
    expect(held([giver, { ...receiver, state: 'failed', ok: false, count: 0 }])).toEqual(expected);
    expect(held([giver, receiver])).toEqual([]);
    const statuses = {
        Big: { name: 'Big', server: o.server, at: 2700, inventory: [] },
        Poor: { name: 'Poor', server: o.server, at: 2700, bankAt: 2299, bank: [], inventory: [] },
    };
    const observed = (r: TradeReceipt) => tradeStockReady(r, statuses[r.account as keyof typeof statuses]);
    expect([...inOpenOrder([o], [giver, receiver], now, observed)]).toEqual(['poor']);
    statuses.Poor.bankAt = 2300;
    expect([...inOpenOrder([o], [giver, receiver], now, observed)]).toEqual([]);
});

test('a funded assignment becomes a coin order and a vacant account; an account in an open order waits', () => {
    const shop = { id: 'shop-feathers' } as any;
    const out = [
        { account: 'Poor', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Poor', coins: 1500, template: 'shop-feathers' } },
        { account: 'Low', template: shop, value: 9, resources: ['shop:sarim'], reason: 'feather', fund: { from: 'Big', to: 'Low', coins: 1500, template: 'shop-feathers' } },
        { account: 'Farmer', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['low']), make);
    expect(r.orders.map(o => [o.from, o.to, o.count])).toEqual([['Big', 'Poor', 1500]]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual([
        'vacant: awaits 1500 coins from Big for shop-feathers', 'vacant: awaits 1500 coins from Big for shop-feathers', 'goldfarm@2652,3318']);
    expect(r.log[1]).toContain('waits for an open order');
});

test('a party to an open order takes no normal job until the order closes', () => {
    const out = [
        { account: 'Big', template: { id: 'shop-runes' } as any, value: 9, resources: ['shop:aubury'], reason: 'rune' },
        { account: 'Poor', template: { id: 'goldfarm@2652,3318' } as any, value: 5, resources: [], reason: 'coins' },
        { account: 'Farmer', template: { id: 'goldfarm@2653,3300' } as any, value: 5, resources: [], reason: 'coins' },
    ];
    const r = fundOrders(out, new Set(['big', 'poor']), make);
    expect(r.orders).toEqual([]);
    expect(r.assignments.map(x => x.template?.id ?? x.reason)).toEqual(['vacant: in an open fleet order', 'vacant: in an open fleet order', 'goldfarm@2653,3300']);
});

test('a coin order opens in 15 minutes for 40 and fits the fleet order format', () => {
    const o = coinOrder('Pocketpython', 'YewFirst', 18_000, 'rs-sdk-demo.fly.dev', 1_000);
    expect(o).toEqual({ id: '901000-pocketpython-yewfirst', server: 'rs-sdk-demo.fly.dev', from: 'Pocketpython', to: 'YewFirst', item: 'coins', count: 18_000, start: 901_000, end: 3_301_000 });
    // The same checks as scripts/fleet-trade.ts validOrder.
    expect(/^[A-Za-z0-9_-]{1,64}$/.test(o.id) && [o.from, o.to].every(n => /^[A-Za-z0-9]{1,12}$/.test(n)) && o.end > o.start).toBe(true);
});

import { pauses, stopClearable, OFFLINE_STATUS_MS } from './autopilot';
import { SWARM_STOP } from './swarm';
test('a stop file pauses an account only when the owner wrote it; the controller\'s own marks an account to plan again', () => {
    const { paused, swarmStopped } = pauses(new Map([['TrouserSnake', SWARM_STOP.removed], ['UnderMyKilt', 'hold for the trade'], ['Quickhandjob', `${SWARM_STOP.all}\n`]]));
    expect([...paused]).toEqual(['undermykilt']);
    expect([...swarmStopped].sort()).toEqual(['quickhandjob', 'trousersnake']);
});

test('the controller\'s stop file goes only once the account is offline: no status, a RESULT, or a row older than the live refresh', () => {
    const now = 1_000_000;
    expect(stopClearable(null, now)).toBe(true);
    expect(stopClearable({ at: now - 5_000, result: 'fail stop file ticks=55' }, now)).toBe(true);
    expect(stopClearable({ at: now - OFFLINE_STATUS_MS - 1 }, now)).toBe(true);
    expect(stopClearable({ at: now - 5_000 }, now)).toBe(false);
});

test('trainer polling supplies the actual standing job to the result reader', () => {
    const template = catalogue().find(t => t.id === 'thieving55')!;
    const trainer = jobFor({account:'Trainer',template,value:1,resources:[],reason:'train'},side);
    const assigned = {Trainer:{template:template.id,offset:0}};
    const results = finishedTrainers([trainer],side,assigned,catalogue(),
        (...args: unknown[]) => args[2] === trainer ? ['RESULT ok'] : []);
    expect(results).toEqual(['Trainer']);
});

test('Autopilot only reads complete results written by the matching standing job', () => {
    const template = catalogue().find(t => t.id === 'thieving55')!;
    const trainer = jobFor({account:'Trainer',template,value:1,resources:[],reason:'train'},side);
    const coordinator = {...trainer, autopilot:undefined, template:undefined};
    const otherStanding = {...trainer, env:{...trainer.env, CAP:'different'}};
    const log = join(mkdtempSync(join(tmpdir(),'autopilot-job-log-')),'account.log');
    const past = 'RESULT ok legacy\n';
    writeFileSync(log, past + jobLogStart(coordinator) + 'RESULT fail coordinator\nRESULT ok coordinator\n'
        + jobLogStart(otherStanding) + 'RESULT fail different arguments\n'
        + jobLogStart(trainer) + 'RESULT fail own attempt\nRESULT ok own attempt');
    const assigned = {Trainer:{template:template.id,offset:Buffer.byteLength(past)}};
    const poll = () => finishedTrainers([trainer],side,assigned,catalogue(),(_a,offset,job)=>readJobResultLines(log,offset,job));
    expect(readJobResultLines(log,0,trainer).filter(l=>l.startsWith('RESULT'))).toEqual(['RESULT fail own attempt']);
    expect(poll()).toEqual([]);
    appendFileSync(log,'\n');
    expect(poll()).toEqual(['Trainer']);
});

test('coordinator ownership preserves a standing job and excludes held funding parties until release', () => {
    const standing = {account:'Held',autopilot:side,enabled:true,repeat:true,script:'scripts/goldfarm.ts',
        template:'test',resources:['knight:2671,3313']};
    const ownerJobs = [standing];
    const overlays = [{accounts:['HELD','Donor'],enabled:false,script:'scripts/chain.ts',coordinatorOwner:'coordinator'}];
    const paused = new Set(['paused']);
    const ownership = planningOwnership(ownerJobs, overlays, paused);
    expect(ownership.held).toEqual(new Set(['held','donor']));
    expect(ownership.busy.has('donor')).toBe(true);
    expect(plannableAccounts(ownerJobs,side,['Held','Donor','Paused','Free'],ownership.keep)).toEqual(['Free']);
    expect(mergeJobs(ownerJobs,side,[],ownership.keep).jobs).toEqual([standing]);
    expect(reservedResources(ownerJobs,side,ownership.keep)).toEqual({'knight:2671,3313':1});
    const released=planningOwnership(ownerJobs,[],paused);
    expect(plannableAccounts(ownerJobs,side,['Held','Donor'],released.keep)).toEqual(['Held','Donor']);
    expect(released.busy.has('donor')).toBe(false);
});
