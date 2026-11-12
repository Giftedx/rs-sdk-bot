import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { jobLogStart } from '../packages/core/src/job-log';
import { aioTemplates, BLOOD_FOOD, BLOOD_MEALS, BOUGHT_BONE_XP, CANNON_BARS, SWEEP_MEALS, catalogue, finishedTrainers, FOOD_HEAL, jobFor, mergeJobs, norm, plan, plannableAccounts, reservedResources, type Acct, type Inputs } from '../packages/planner/src/autopilot';
import { COW_FOOD_BITES, COW_FOOD_HP, cowFoodHeal } from './gather-combat';
import { BONE_XP } from './train-prayer';
import { missionSignature, startable } from './swarm';
import { aioPilots, armyRoster, liveRetirements, coinOrder, fundOrders, heldResources, inOpenOrder, newestClaims, pass, planningOwnership, readJobResultLines, tradeStockReady } from './autopilot';
import type { TradeReceipt } from './fleet-trade-settlement';
import { existsSync } from 'node:fs';
import { resolveAioStep } from './aio';
import { benchCases } from './measure/aio-bench-cases';
import { MEALS, presetFor } from './quest-sweep';
import { BANK_FOOD } from './blood-chest';

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

test('after its window an order holds no one when one party failed and the other never started, or when a retry completed it', () => {
    const receipt = (o: ReturnType<typeof order>, role: 'from' | 'to', state: 'settled' | 'failed'): TradeReceipt => ({
        version: 2, state, id: o.id, role, account: o[role], partner: role === 'from' ? o.to : o.from, side: 'local',
        server: o.server, item: o.item, requested: o.count, claim: '12345678-1234-1234-1234-123456789012', at: 2700,
        ok: state === 'settled', detail: '', count: state === 'settled' ? o.count : 0,
        inventory: state === 'failed' ? { before: 7, after: 7 } : role === 'from' ? { before: o.count, after: 0 } : { before: 0, after: o.count },
        ...(role === 'to' && state === 'settled' ? { bank: { count: o.count, at: 2300 } } : {}),
        logout: { attemptId: '0000000002400-1-1', at: 2600, sha256: 'a'.repeat(64) },
    });
    const first = order('a', 'Big', 'Poor', 3000), retry = order('b', 'Big', 'Poor', 4000), now = 5000;
    const held = (orders: ReturnType<typeof order>[], r: TradeReceipt[], at = now) => [...inOpenOrder(orders, r, at)].sort();
    // The taker failed and the giver never ran: closed once the window is over, held while it is open.
    expect(held([first], [receipt(first, 'to', 'failed')])).toEqual([]);
    expect(held([first], [receipt(first, 'to', 'failed')], 2900)).toEqual(['big', 'poor']);
    // A party that is still uncertain keeps the hold.
    expect(held([first], [{ ...receipt(first, 'to', 'failed'), state: 'reconcile' }])).toEqual(['big', 'poor']);
    // One order alone with a settled giver and a failed taker is a real mismatch.
    const gaveFirst = [receipt(first, 'from', 'settled'), receipt(first, 'to', 'failed')];
    expect(held([first], gaveFirst)).toEqual(['big', 'poor']);
    // The retry holds the other half: the taker's settled receipt and the giver's failure. Together, one transfer.
    const tookRetry = [receipt(retry, 'from', 'failed'), receipt(retry, 'to', 'settled')];
    expect(held([first, retry], [...gaveFirst, ...tookRetry])).toEqual([]);
    // A retry for another count does not complete it.
    const other = { ...retry, count: 9 };
    expect(held([first, other], [...gaveFirst, receipt(other, 'from', 'failed'), receipt(other, 'to', 'settled')])).toEqual(['big', 'poor']);
    // The settled halves still wait for a status that shows the stock.
    expect([...inOpenOrder([first, retry], [...gaveFirst, ...tookRetry], now, r => r.role !== 'to')]).toEqual(['poor']);
    // A giver that claimed and died leaves a prepared receipt. While its trade claim is held the order holds both;
    // once the claim is released by hand the receipt counts as none, unless the taker shows a transfer.
    const died: TradeReceipt = { ...receipt(first, 'from', 'failed'), state: 'prepared', inventory: undefined, logout: undefined, claim: '99999999-1234-1234-1234-123456789012' };
    const released = (r: TradeReceipt[]) => [...inOpenOrder([first], r, now, () => true, () => false)].sort();
    expect(held([first], [died])).toEqual(['big', 'poor']);
    expect(released([died])).toEqual([]);
    expect(released([died, receipt(first, 'to', 'failed')])).toEqual([]);
    expect(released([died, receipt(first, 'to', 'settled')])).toEqual(['big', 'poor']);
    expect([...inOpenOrder([first], [died], 2900, () => true, () => false)].sort()).toEqual(['big', 'poor']);
    // The same for a giver whose session ended in reconcile with nothing given (live: its partner never came).
    const unsure: TradeReceipt = { ...receipt(first, 'from', 'failed'), state: 'reconcile', inventory: undefined, claim: '99999999-1234-1234-1234-123456789012' };
    expect(held([first], [unsure])).toEqual(['big', 'poor']);
    expect(released([unsure])).toEqual([]);
    expect(released([unsure, receipt(first, 'to', 'settled')])).toEqual(['big', 'poor']);
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
    const { paused, swarmStopped } = pauses(new Map([['TrouserSnake', SWARM_STOP.removed], ['UnderMyKilt', 'hold for the trade'], ['Quickhandjob', `${SWARM_STOP.all}\n`],
        ['Kiltlifter', SWARM_STOP.lease]]));
    expect([...paused]).toEqual(['undermykilt']);
    expect([...swarmStopped].sort()).toEqual(['kiltlifter', 'quickhandjob', 'trousersnake']);
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


test('a paused autopilot pass holds before reading the plan', () => {
    expect(pass('missing-owner-plan.json', false, () => true)).toEqual(['AUTOPILOT hold: swarm is paused']);
});


test('a pause arriving during planning leaves the owner plan bytes intact', () => {
    const parent = resolve(tmpdir()), base = mkdtempSync(join(parent, 'rsbot-autopilot-pause-'));
    const previous = process.env.FLEET_DIR;
    try {
        const planFile = join(base, 'swarm.json'), before = '{"jobs":[],"maxBots":4}';
        writeFileSync(planFile, before);
        process.env.FLEET_DIR = base;
        let checks = 0;
        expect(pass(planFile, false, () => ++checks > 1)).toEqual(['AUTOPILOT hold: swarm is paused']);
        expect(readFileSync(planFile, 'utf8')).toBe(before);
        expect(pass(planFile, true, () => true).at(-1)).toBe('AUTOPILOT dry run: nothing written');
        expect(readFileSync(planFile, 'utf8')).toBe(before);
    } finally {
        if (previous === undefined) delete process.env.FLEET_DIR;
        else process.env.FLEET_DIR = previous;
        if (/^rsbot-autopilot-pause-[^\\/]+$/.test(relative(parent, base))) rmSync(base, { recursive: true });
    }
});

test('each side counts at its newest claim, synced or on origin', () => {
    const synced = [{ side: 'claude-cloud', at: 100, resources: ['knight:2652,3318'] }, { side: 'claude-cloud-2', at: 300, resources: ['knight:2582,3297'] }, null, { side: 'bad' }];
    const origin = [{ side: 'claude-cloud', at: 200, resources: [] }, { side: 'claude-cloud-2', at: 250, resources: [] }, { side: 'claude-cloud-3', at: 150, resources: ['knight:2652,3318'] }];
    const out = Object.fromEntries(newestClaims(synced, origin).map(c => [c.side, c.resources]));
    expect(out).toEqual({ 'claude-cloud': [], 'claude-cloud-2': ['knight:2582,3297'], 'claude-cloud-3': ['knight:2652,3318'] });
    expect(newestClaims(synced, [])).toHaveLength(2);
});

test('a plan whose enabled jobs hold different resources has a changed claim; an unchanged one does not', () => {
    const farm = (account: string, spot: string, enabled = true) => ({ account, script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot }, enabled, resources: [`knight:${spot}`] });
    const before = [farm('A', '2652,3318'), farm('B', '2669,3298')];
    expect(heldResources(before)).toBe(heldResources([farm('B', '2669,3298'), farm('A', '2652,3318')]));
    expect(heldResources(before)).not.toBe(heldResources([farm('A', '2653,3300'), farm('B', '2669,3298')]));
    expect(heldResources(before)).not.toBe(heldResources([farm('A', '2652,3318'), farm('B', '2669,3298', false)]));
    expect(heldResources([...before, farm('C', '2671,3313', false)])).toBe(heldResources(before));
});

test('the army roster is the plan\'s explicit list, lower-cased, never Haggis', () => {
    expect([...armyRoster({ army: ['Kiltlifter', 'PocketPool', 'Haggis', 7] })]).toEqual(['kiltlifter', 'pocketpool']);
    expect(armyRoster({ jobs: [] }).size).toBe(0);
    expect(armyRoster(null).size).toBe(0);
});

test('the planner heals food by the same table as cow mode, and the cow bands need its HP', () => {
    const names = new Map((JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8')) as { id: number; name: string }[]).map(i => [i.id, i.name]));
    const ids = Object.keys(COW_FOOD_BITES).map(Number);
    expect(Object.fromEntries(ids.map(id => [norm(names.get(id)!), cowFoodHeal([{ id, count: 1 }])]))).toEqual({ ...FOOD_HEAL });
    for (const t of catalogue().filter(t => t.id.startsWith('army-cow-'))) expect(t.needs?.food).toBe(COW_FOOD_HP);
});

test('the planner sizes a bone buy by the XP the Prayer trainer checks on each bury', () => {
    for (const [id, xp] of Object.entries(BOUGHT_BONE_XP)) expect(BONE_XP[Number(id)]).toBe(xp);
});

test('a retirement lapses when its script changes, except a death or a gone template', () => {
    const scriptOf = (t: string) => ({ 'army-cow-strength-45': 'new', goldfarm: 'same' } as Record<string, string>)[t];
    expect(liveRetirements({
        'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs', script: 'old' },
        'fatstack:goldfarm': { reason: 'tick waste 95%', script: 'same' },
        'dipstick:army-cow-strength-45': { reason: 'death: died', script: 'old' },
        'kiltlifter:gone-template': { reason: '2 fail RESULTs', script: 'old' },
        'thefullmonty:army-cow-strength-45': '2 fail RESULTs',
    }, scriptOf)).toEqual({
        retired: {
            'fatstack:goldfarm': { reason: 'tick waste 95%', script: 'same' },
            'dipstick:army-cow-strength-45': { reason: 'death: died', script: 'old' },
            'kiltlifter:gone-template': { reason: '2 fail RESULTs', script: 'old' },
            // A bare reason from before scripts were recorded takes the current script and stays.
            'thefullmonty:army-cow-strength-45': { reason: '2 fail RESULTs', script: 'new' },
        },
        lapsed: ['trousersnake:army-cow-strength-45'],
    });
});

test('a retirement whose last fail is now a drain lapses, whatever its script', () => {
    const scriptOf = () => 'same';
    const noRoute = '2 fail RESULTs: RESULT fail travel to Ardougne from 3185,3436 failed: precondition no route to 2654,3283,0';
    expect(liveRetirements({
        'thefullmonty:army-cow-strength-70': { reason: noRoute, script: 'same' },
        'quickhandjob:army-cow-defence-45': noRoute,
        'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs: RESULT fail no cow progress: insufficient slots', script: 'same' },
    }, scriptOf)).toEqual({
        retired: { 'trousersnake:army-cow-strength-45': { reason: '2 fail RESULTs: RESULT fail no cow progress: insufficient slots', script: 'same' } },
        lapsed: ['thefullmonty:army-cow-strength-70', 'quickhandjob:army-cow-defence-45'],
    });
});

import { ARMY_MEET, itemOrder, sideStock } from './autopilot';
import { meetingTiles } from './coin-courier';
import { validOrder } from './fleet-trade-settlement';
test('a kit item order fits the fleet order format and meets at the army bank', () => {
    const o = itemOrder('TheFullMonty', 'Masterbaiter', 'Mind rune', 20, 'rs-sdk-demo.fly.dev', 1_000_000);
    expect(validOrder(o)).toBe(true);
    expect(o).toMatchObject({ id: '1900000-thefullmonty-masterbaiter-mindrune', item: 'Mind rune', count: 20, start: 1_900_000, end: 1_900_000 + 40 * 60_000, meet: ARMY_MEET });
    expect(itemOrder('TheFullMonty', 'Masterbaiter', 'Air rune', 10, 'rs-sdk-demo.fly.dev', 1_000_000).id).not.toBe(o.id);
    expect(meetingTiles({ x: 2619, z: 3332 })).toEqual(ARMY_MEET);
});

test('a kit send becomes an item order and a vacant account; a party to an open order waits', () => {
    const band = catalogue().find(t => t.id === 'army-strike-magic-21')!;
    const out = [{ account: 'Needy', template: band, value: 0, reason: 'army band', resources: [], send: { from: 'Near', to: 'Needy', item: 'mind rune', count: 20, template: band.id } }];
    const order = (s: { from: string; to: string; item: string; count: number }) => itemOrder(s.from, s.to, 'Mind rune', s.count, 'rs-sdk-demo.fly.dev', 0);
    const placed = fundOrders(out, new Set(), () => { throw Error('no coin order'); }, order);
    expect(placed.orders.map(o => [o.from, o.to, o.item, o.count])).toEqual([['Near', 'Needy', 'Mind rune', 20]]);
    expect(placed.assignments).toEqual([{ account: 'Needy', value: 0, resources: [], reason: 'vacant: awaits 20 mind rune from Near for army-strike-magic-21' }]);
    expect(placed.log).toEqual(['AUTOPILOT send Needy 20 mind rune from Near for army-strike-magic-21']);
    const waiting = fundOrders(out, new Set(['near']), () => { throw Error('no coin order'); }, order);
    expect(waiting.orders).toEqual([]);
    expect(waiting.log).toEqual(['AUTOPILOT send Needy 20 mind rune from Near for army-strike-magic-21: waits for an open order']);
});

test('another side gives only from accounts its fresh plan leaves free and no open order holds', () => {
    const snapshot = { accounts: [
        { name: 'Free', inventory: [{ name: 'Mind rune', count: 374 }], bank: [{ name: 'Coins', count: 4_000_000 }] },
        { name: 'Working', bank: [{ name: 'Mind rune', count: 335 }] }, { name: 'Trading', bank: [{ name: 'Mind rune', count: 50 }] }, { name: 'Haggis', bank: [] }] };
    const plan = { at: 1_000_000, jobs: [{ account: 'Working', enabled: true }, { account: 'Free', enabled: false }] };
    const stock = (at: number) => sideStock('claude-cloud', snapshot, { ...plan, at }, new Set(['trading']), 1_000_000 + 60_000, 30 * 60_000, () => undefined);
    expect(stock(1_000_000)).toEqual([{ name: 'Free', side: 'claude-cloud', items: { 'mind rune': 374, coin: 4_000_000 } }]);
    // A side with no fresh plan has no running fleet agent to trade.
    expect(stock(1_000_000 - 31 * 60_000)).toEqual([]);
    expect(sideStock('claude-cloud', snapshot, null, new Set(), 0, 1, () => undefined)).toEqual([]);
});

import { failedSends, kitBuyRunning, SEND_RETRY_MS } from './autopilot';
test('a failed item order stops new orders for that pair for a day; coin orders and old orders do not', () => {
    const order = (id: string, item: string, start: number) => ({ id, server: 'rs-sdk-demo.fly.dev', from: 'Near', to: 'Needy', item, count: 20, start, end: start + 40 * 60_000 });
    const now = 10 * 3600_000;
    // Past its window with one receipt that is not terminal, an order needs reconciliation.
    const receipt = (id: string) => ({ id, account: 'Needy', role: 'to', side: 'local', ok: false, count: 0, at: now - 3000_000, detail: 'Error: no route', version: 2, state: 'failed', server: 'rs-sdk-demo.fly.dev', partner: 'Near', item: 'Mind rune', requested: 20, claim: 'x' });
    expect([...failedSends([order('a', 'Mind rune', now - 3600_000)], [receipt('a')] as any, now)]).toEqual(['near>needy']);
    expect(failedSends([order('a', 'coins', now - 3600_000)], [receipt('a')] as any, now).size).toBe(0);
    expect(failedSends([order('a', 'Mind rune', now - SEND_RETRY_MS - 1)], [receipt('a')] as any, now).size).toBe(0);
    // An order still inside its window with no receipt is pending, not failed.
    expect(failedSends([order('b', 'Mind rune', now - 60_000)], [], now).size).toBe(0);
});

import { silentSides } from './autopilot';
test('a side whose latest closed order its giver never answered gives no kit until it answers one', () => {
    const now = 10 * 3600_000, sideOf = (n: string) => ({ far: 'local', far2: 'local', near: 'cloud' } as Record<string, string>)[n.toLowerCase()];
    const order = (id: string, from: string, end: number) => ({ id, server: 's', from, to: 'Needy', item: 'Bones', count: 37, start: end - 40 * 60_000, end });
    const gave = (id: string) => ({ id, role: 'from', account: 'Far', side: 'local', ok: false, count: 0, at: now, detail: '' });
    const took = (id: string) => ({ ...gave(id), role: 'to', account: 'Needy', side: 'cloud' });
    // The taker's receipt alone does not answer for the giver.
    expect([...silentSides([order('a', 'Far', now - 1000)], [took('a')] as any, sideOf, now)]).toEqual(['local']);
    expect(silentSides([order('a', 'Far', now - 1000)], [gave('a')] as any, sideOf, now).size).toBe(0);
    // The latest closed order decides: an answered one after a silent one brings the side back, and the reverse.
    expect(silentSides([order('a', 'Far', now - 5000), order('b', 'Far2', now - 1000)], [gave('b')] as any, sideOf, now).size).toBe(0);
    expect([...silentSides([order('a', 'Far', now - 5000), order('b', 'Far2', now - 1000)], [gave('a')] as any, sideOf, now)]).toEqual(['local']);
    // An order still in its window, one older than the retry window and an account of no listed side say nothing.
    expect(silentSides([order('a', 'Far', now + 1000)], [], sideOf, now).size).toBe(0);
    expect(silentSides([order('a', 'Far', now - SEND_RETRY_MS - 1)], [], sideOf, now).size).toBe(0);
    expect(silentSides([order('a', 'Stranger', now - 1000)], [], sideOf, now).size).toBe(0);
    // Each side by its own orders.
    expect([...silentSides([order('a', 'Far', now - 1000), order('b', 'Near', now - 1000)], [gave('b')] as any, sideOf, now)]).toEqual(['local']);
});

test('a kit buy with no RESULT yet is running and stays as it is', () => {
    const job = { enabled: true, template: 'kit-buy:army-strike-magic-21' }, assigned = { template: job.template, offset: 0 };
    expect(kitBuyRunning(job, assigned, () => ['SUPERVISE start', 'LEDGER ticks=40 xp=0 move=30 idle=10'])).toBe(true);
    expect(kitBuyRunning(job, assigned, () => ['  | RESULT ok {"ok":true,"died":false}'])).toBe(false);
    expect(kitBuyRunning(job, assigned, () => ['RESULT fail login: Error: fleet account claim held by swarm'])).toBe(false);
    expect(kitBuyRunning({ ...job, enabled: false }, assigned, () => [])).toBe(false);
    expect(kitBuyRunning({ enabled: true, template: 'goldfarm@2652,3318' }, { template: 'goldfarm@2652,3318', offset: 0 }, () => [])).toBe(false);
    expect(kitBuyRunning(job, { template: 'army-strike-magic-21', offset: 0 }, () => [])).toBe(false);
});

import { unfilledItems } from './autopilot';
test('a kit buy that got none of an item names that item; a filled or broken buy names none', () => {
    const none = '  | RESULT fail {"ok":false,"phase":"settled","quantity":20,"targetMet":false,"acquired":0,"refund":2400,"spent":0,"offerId":157266,"progress":{"actor":"Wandwaver","offerId":157266,"itemId":558,"side":"buy","quantity":20,"limit":120,"filled":0},"failure":"exact order short: acquired 0/20"}';
    const filled = '  | RESULT ok {"ok":true,"phase":"settled","quantity":50,"targetMet":true,"acquired":50,"progress":{"actor":"Mightyrod","itemId":561,"side":"buy","quantity":50,"limit":800,"filled":50,"gross":12500}}';
    expect(unfilledItems([filled, none, none.replace('"itemId":558', '"itemId":314')])).toEqual([558, 314]);
    expect(unfilledItems([filled])).toEqual([]);
    // A part fill and a failure with no offer are not an empty market.
    expect(unfilledItems([none.replace('"acquired":0', '"acquired":7')])).toEqual([]);
    expect(unfilledItems(['RESULT fail walk-to {"ok":false,"reason":"timeout"}', 'RESULT fail chain rounds=1 ok=1 failed=1'])).toEqual([]);
});

test('each AIO template dispatches to the worker it names, and its route has a bench case that can pass', () => {
    const cases = new Map(benchCases().map(c => [c.key, c]));
    for (const t of aioTemplates()) {
        const step = resolveAioStep(t.args![0]!, t.args!.slice(1));
        expect(`${t.id} ${step.script}`).toBe(`${t.id} ${t.worker}`);
        expect(existsSync(resolve(import.meta.dir, '..', t.worker!))).toBe(true);
        expect(`${t.id} ${cases.has(t.aio!)}`).toBe(`${t.id} true`);
        expect(cases.get(t.aio!)!.known).toBeUndefined();
    }
    // The quest the sweep template names has its own bench case.
    expect(cases.has('quester:quest:runemysteries')).toBe(true);
    expect(resolveAioStep('quester', ['sweep', 'runemysteries'])).toEqual({ script: 'scripts/quest-sweep.ts', args: ['runemysteries'], env: {} });
    expect(resolveAioStep('skiller', ['fletching', 'shafts', '600', 'MAX_MAKE=25', 'LOG_RESERVE=0']).env).toEqual({ MODE: 'shafts', MAX_MAKE: '25', LOG_RESERVE: '0' });
});

test('the Rune Mysteries template needs the pack the sweep takes: the preset runes and its meals', () => {
    const items: { id: number; name: string; debugname?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const t = aioTemplates().find(t => t.id === 'aio-quest-runemysteries')!, pack: Record<string, number> = {};
    let meals = 0;
    for (const i of presetFor('runemysteries').inventory ?? []) { if (MEALS.includes(i.id)) meals += i.count; else pack[name(i.id)] = (pack[name(i.id)] ?? 0) + i.count; }
    expect(Object.fromEntries(Object.entries(t.needs!.items!).map(([i, n]) => [norm(i), n]))).toEqual(pack);
    expect(t.needs!.pieces!.count).toBe(meals);
    expect([...SWEEP_MEALS].map(norm).sort()).toEqual(MEALS.map(name).sort());
});

test('a maker of a short bill line has the value of that line for an account that meets its needs, and none for another', () => {
    // Prices as scripts/autopilot.ts builds them: the shop value of each item, by norm() name.
    const items: { name?: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    // The line names of the saved Overall bill.
    const line = (item: string, short: number) => ({ item, need: short, owned: 0, short, ids: [], holders: [] });
    const bill = [line('cannonball', 1700), line('blood rune', 624), line('adamantite bar', 345), line('mithril bar', 280), line('iron bar', 2)];
    const makers: Record<string, { item: string; perTick: number; meets: Acct; lacks: Acct }> = {
        'aio-cannonballs': { item: 'cannonball', perTick: 0.2, meets: { name: 'A', side, skills: { Smithing: 35 }, items: { 'ammo mould': 1, 'steel bar': CANNON_BARS } },
            lacks: { name: 'A', side, skills: { Smithing: 35 }, items: { 'steel bar': CANNON_BARS } } },
        'aio-blood-chest': { item: 'blood rune', perTick: 0.01, meets: { name: 'A', side, skills: { Thieving: 59 }, items: { lobster: BLOOD_MEALS } },
            lacks: { name: 'A', side, skills: { Thieving: 58 }, items: { lobster: BLOOD_MEALS } } },
        'aio-adamantite-bars': { item: 'adamantite bar', perTick: 0.07, meets: { name: 'A', side, skills: { Smithing: 70 }, items: { 'adamantite ore': 4, coal: 24 } },
            lacks: { name: 'A', side, skills: { Smithing: 70 }, items: { 'adamantite ore': 4, coal: 23 } } },
        'aio-mithril-bars': { item: 'mithril bar', perTick: 0.08, meets: { name: 'A', side, skills: { Smithing: 50 }, items: { 'mithril ore': 5, coal: 20 } },
            lacks: { name: 'A', side, skills: { Smithing: 49 }, items: { 'mithril ore': 5, coal: 20 } } },
        'aio-iron-bars': { item: 'iron bar', perTick: 0.074, meets: { name: 'A', side, skills: { Smithing: 15 }, items: { 'iron ore': 28 } },
            lacks: { name: 'A', side, skills: { Smithing: 15 }, items: { 'iron ore': 27 } } },
    };
    for (const [id, m] of Object.entries(makers)) {
        const run = (a: Acct, rows = bill) => plan({ ...inputs(a), templates: aioTemplates(), bill: rows, prices, pilots: new Set([id]), coinValue: 0 })[0]!;
        const price = prices[norm(m.item)]!;
        expect(`${id} ${price > 0}`).toBe(`${id} true`);
        expect(`${id} ${run(m.meets).template?.id}`).toBe(`${id} ${id}`);
        // Twice the shop value while the line is short, half of it once the line is met.
        expect(run(m.meets).value).toBeCloseTo(m.perTick * price * 2);
        expect(run(m.meets, bill.map(r => ({ ...r, short: 0 }))).value).toBeCloseTo(m.perTick * price * 0.5);
        expect(run(m.lacks)).toMatchObject({ value: 0 });
        expect(run(m.lacks).template).toBeUndefined();
    }
    expect([...BLOOD_FOOD].map(norm).sort()).toEqual(BANK_FOOD.map(norm).sort());
});

test('the aio list of the plan admits pilot templates by id; anything else admits none', () => {
    expect([...aioPilots({ aio: ['aio-flax', 7, 'aio-ore'] })]).toEqual(['aio-flax', 'aio-ore']);
    expect(aioPilots({}).size).toBe(0);
    expect(aioPilots({ aio: 'aio-flax' }).size).toBe(0);
});

import { handedAccounts } from './autopilot';
test('a kept job is handed work too, so the controller\'s stale stop file is cleared on a later pass', () => {
    // Live: the pass that assigned the job found the last run still ending and held the file; every later pass kept
    // the job, and the account stood 40 minutes with its job enabled and never started.
    const out = [{ account: 'Fresh', template: { id: 'a' } }, { account: 'Kept', template: { id: 'b' } }, { account: 'Vacant' }];
    expect([...handedAccounts(out, [{ from: 'Giver', to: 'Taker' }])].sort()).toEqual(['fresh', 'giver', 'kept', 'taker']);
    expect(handedAccounts(out, []).has('vacant')).toBe(false);
});


test('the plan names a PK build for an army account; an unknown kit trains nothing', async () => {
    const { buildCaps } = await import('./autopilot');
    const caps = buildCaps({ builds: { Tosser: 'dragon', Wrong: 'no-such-kit' } });
    expect(caps.get('tosser')).toMatchObject({ Attack: 60, Defence: 60, Prayer: 43, Strength: 99 });
    expect(caps.get('wrong')).toEqual({ Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1 });
    expect(buildCaps({}).size).toBe(0);
    expect(buildCaps({ builds: ['dragon'] }).size).toBe(0);
});

test('the plan gives a build account the levels it may have before its quest route', async () => {
    const { buildBefore } = await import('./autopilot');
    const before = buildBefore({ builds: { Tosser: 'tank-range', Caber: 'pure-pray', Wrong: 'no-such-kit' } });
    expect(before.get('tosser')).toMatchObject({ Attack: 68, Strength: 60, Defence: 99 });
    expect(before.get('caber')).toMatchObject({ Attack: 60, Defence: 1, Prayer: 43 });
    expect(before.has('wrong')).toBe(false);
    expect(buildBefore({}).size).toBe(0);
});

test('the plan gives a build account the quest route of its kit; a kit with no route gets none', async () => {
    const { buildQuests } = await import('./autopilot');
    const routes = buildQuests({ builds: { Tosser: 'pure-pray', Caber: 'baby-pure', Wrong: 'no-such-kit' } });
    expect(routes.get('tosser')).toEqual(['Lost City']);
    expect(routes.get('caber')).toEqual([]);
    expect(routes.get('wrong')).toEqual([]);
    expect(buildQuests({ builds: ['pure-pray'] }).size).toBe(0);
});
