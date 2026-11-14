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
import { smeltRecipe } from './smelt-batch';
import { GEM_RINGS, MAKE_BATCH, RING_BATCH, RUNE_ARROW_COST, RUNE_ARROW_SPEND, UNF_POTIONS, makerChains, priceTable } from '../packages/planner/src/autopilot';
import { supplyBill } from '../packages/planner/src/supply-bill';
import { inventoryRecipes } from './microbot-production';
import { jewelleryOrderFromEnv, planJewelleryOrder, validateJewelleryOrder } from './microbot-jewellery-trip';
import { smithRecipe } from './smith-batch';
import { parseStep } from '../packages/core/src/chain-step';
import { PROFILES, maximumUnitCost, selectItems } from './shop-buyer';

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
    // mission starts although the account's last end is done. The account has 20 Hitpoints here: the frail rule keeps
    // a thief under that off the knights until it holds food (GOLDFARM_FRAIL, packages/planner/src/autopilot.ts).
    const [next] = plan(inputs({ ...fresh, skills: { ...fresh.skills, Thieving: 55, Hitpoints: 20 } }));
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

test('the steel bar template has the value of a short line only while the bill is short of cannonballs', () => {
    const items: { name?: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const prices: Record<string, number> = {};
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    const line = (item: string, short: number) => ({ item, need: 1700, owned: 1700 - short, short, ids: [], holders: [] });
    const id = 'aio-steel-bars', t = aioTemplates().find(t => t.id === id)!;
    const smith = (level: number, ore: number, coal: number): Acct => ({ name: 'A', side, skills: { Smithing: level }, items: { 'iron ore': ore, coal } });
    const run = (a: Acct, bill: Inputs['bill']) => plan({ ...inputs(a), templates: aioTemplates(), bill, prices, pilots: new Set([id]), coinValue: 0 })[0]!;
    // The worker's own table: the level and the two ingredients of the bar, and one pack load of them in `needs`.
    const recipe = smeltRecipe('steel'), units = (item: number) => recipe.ingredients.find(i => i.id === item)!.units;
    const load = Math.floor(28 / (units(440) + units(453)));
    expect(t.needs).toEqual({ skills: { Smithing: recipe.level }, items: { 'iron ore': load * units(440), coal: load * units(453) } });
    const [made] = t.yields(smith(30, 9, 18));
    expect(made!.item).toBe('steel bar');
    const price = prices['steel bar']!;
    expect(price > 0).toBe(true);
    // No bill line names the bar. Short of cannonballs: twice the shop value of the bar.
    expect(run(smith(30, 9, 18), [line('cannonball', 1700)]).template?.id).toBe(id);
    expect(run(smith(30, 9, 18), [line('cannonball', 1700)]).value).toBeCloseTo(made!.perTick * price * 2);
    // The cannonball line met, another line short, or no bill: half the shop value, as for an item nobody needs.
    for (const bill of [[line('cannonball', 0)], [line('cannonball', 0), line('iron bar', 2), line('mithril bar', 280)], []])
        expect(run(smith(30, 9, 18), bill).value).toBeCloseTo(made!.perTick * price * 0.5);
    // A level under the bar, or a load short of one ore or one coal: no job.
    for (const a of [smith(29, 9, 18), smith(30, 8, 18), smith(30, 9, 17)]) {
        expect(run(a, [line('cannonball', 1700)])).toMatchObject({ value: 0 });
        expect(run(a, [line('cannonball', 1700)]).template).toBeUndefined();
    }
});

test('the makers of the unfinished potion, dust, ring and axe lines ask what their worker recipes ask, and get the price of their bill line', () => {
    const items: { id: number; name: string; debugname?: string; cost?: number }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const all = new Map(aioTemplates().map(t => [t.id, t])), recipes = inventoryRecipes();
    const recipeOf = (id: string) => { const env = resolveAioStep('skiller', all.get(id)!.args!.slice(1)); return { step: env, recipe: recipes.find(r => r.name === env.args[0])! }; };
    // The bill as scripts/autopilot.ts builds it: one line for each potion, with the item ids idsFor matches.
    const lines = [...UNF_POTIONS.map(([herb]) => `${herb} potion (unf)`), 'unicorn horn dust', 'dragon scale dust', 'mort myre fungus'];
    const bill = supplyBill(lines.map(item => ({ item, count: 5 })), items, []), prices = priceTable(items, bill);
    expect(bill.every(r => r.short === 5 && r.ids.length === 1)).toBe(true);
    for (const [herb, item, level] of UNF_POTIONS) {
        const id = `aio-unf-${herb.replace(' ', '-')}`, t = all.get(id)!, line = `${herb} potion (unf)`, { step, recipe } = recipeOf(id);
        expect(`${id} ${step.script} ${recipe?.name}`).toBe(`${id} scripts/microbot-production.ts brew:unf_${herb.replace(' ', '_')}_potion`);
        expect(step.env).toEqual({ MAX_MAKE: String(MAKE_BATCH), CAP: '1500', MEMBERS: '1', ORDER_MODE: 'best-effort' });
        expect(`${id} ${recipe.level}`).toBe(`${id} ${level}`);
        expect(t.needs).toEqual({ skills: { Herblore: recipe.level }, items: { [item]: 1, 'vial of water': 1 } });
        expect(recipe.inputs.map(i => name(i.id)).sort()).toEqual(Object.keys(t.needs!.items!).map(norm).sort());
        // The product is the item of the bill line, and the line has its price.
        expect(bill.find(r => r.item === line)!.ids).toEqual([recipe.product]);
        expect(t.yields({ name: 'A', side, skills: {}, items: {} })).toEqual([{ item: line, perTick: 0.1 }]);
        const price = items.find(i => i.id === recipe.product)!.cost!;
        expect(`${id} ${price > 0} ${prices[norm(line)]}`).toBe(`${id} true ${price}`);
        const brewer: Acct = { name: 'A', side, skills: { Herblore: level }, items: { [norm(item)]: 1, 'vial of water': 1 } };
        expect(plan({ ...inputs(brewer), templates: aioTemplates(), bill, prices, pilots: new Set([id]), coinValue: 0 })[0]!.value).toBeCloseTo(0.1 * price * 2);
    }
    expect(prices[norm('mort myre fungus')]).toBe(items.find(i => i.name === 'Mort myre fungi')!.cost!);
    for (const [id, raw, dust] of [['aio-unicorn-horn-dust', 'unicorn horn', 'unicorn horn dust'], ['aio-dragon-scale-dust', 'blue dragon scale', 'dragon scale dust']] as const) {
        const { recipe } = recipeOf(id), t = all.get(id)!;
        expect(`${id} ${recipe?.name}`).toBe(`${id} grind:${raw.replace(/ /g, '_')}`);
        expect([...recipe.inputs.map(i => name(i.id)), ...recipe.tools.map(name)].sort()).toEqual(Object.keys(t.needs!.items!).map(norm).sort());
        expect(name(recipe.product)).toBe(norm(dust));
        expect(recipe.level).toBe(1);
        expect(t.needs!.skills).toBeUndefined();
    }
    // The ring order of each template is one the trip worker accepts, and `needs` holds its whole batch.
    for (const [gem, level] of GEM_RINGS) {
        const id = `aio-${gem}-rings`, t = all.get(id)!, step = resolveAioStep('skiller', t.args!.slice(1));
        expect(`${id} ${step.script} ${step.args.length}`).toBe(`${id} scripts/microbot-jewellery-trip.ts 0`);
        const order = jewelleryOrderFromEnv(step.env), recipe = validateJewelleryOrder(order);
        expect(order).toMatchObject({ recipe: `${gem}_ring`, target: RING_BATCH, batch: RING_BATCH, members: false, stringAmulet: false });
        expect(`${id} ${recipe.level}`).toBe(`${id} ${level}`);
        expect(t.needs).toEqual({ skills: { Crafting: level }, items: { ...Object.fromEntries(recipe.tools.map(tool => [name(tool), 1])), ...Object.fromEntries(recipe.inputs.map(i => [name(i.id), RING_BATCH])) } });
        expect(name(recipe.product)).toBe(`${gem} ring`);
        // One trip: the mould and the batch of bars and gems fit in the pack.
        expect(1 + recipe.inputs.length * RING_BATCH <= 28).toBe(true);
        const stock = Object.fromEntries([...recipe.tools.map(tool => [tool, 1]), ...recipe.inputs.map(i => [i.id, RING_BATCH])]);
        expect(planJewelleryOrder(order, stock, level).stages.map(s => `${s.family} ${s.recipe} ${s.target}`)).toEqual([`jewellery ${gem}_ring ${RING_BATCH}`]);
    }
    const axe = all.get('aio-rune-axe')!, smith = smithRecipe(Number(resolveAioStep('skiller', axe.args!.slice(1)).env.PRODUCT_ID));
    expect(name(smith.product)).toBe('rune axe');
    expect(axe.needs).toEqual({ skills: { Smithing: smith.level }, items: { hammer: 1, [name(smith.bar)]: smith.bars, coins: 10 }, holdsUnder: { 'rune axe': 1 } });
    expect(axe.repeats).toBe(false);
});

test('each step of a two-recipe maker dispatches to the bank-standing worker with a recipe it knows, at the level the template asks', () => {
    const items: { id: number; name: string; debugname?: string }[] = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8'));
    const name = (id: number) => norm(items.find(i => i.id === id && !/^cert_/.test(i.debugname ?? ''))!.name);
    const cases = new Map(benchCases().map(c => [c.key, c])), recipes = inventoryRecipes();
    expect(cases.get('skiller:crafting:inventory')?.known).toBeUndefined();
    for (const t of makerChains()) {
        const steps = t.args!.map(parseStep).map(s => { expect(s.script).toBe('scripts/aio.ts'); return { env: s.env, step: resolveAioStep(s.args[0]!, s.args.slice(1)) }; });
        const used = steps.map(({ step, env }) => {
            expect(`${t.id} ${step.script}`).toBe(`${t.id} ${t.worker}`);
            expect(env).toMatchObject({ MEMBERS: '1', ORDER_MODE: 'best-effort' });
            const recipe = recipes.find(r => r.name === step.args[0]);
            expect(`${t.id} ${step.args[0]} ${!!recipe}`).toBe(`${t.id} ${step.args[0]} true`);
            return recipe!;
        });
        // The second recipe takes the product of the first, and the template asks the level of both and every other input.
        expect(used[1]!.inputs.some(i => i.id === used[0]!.product)).toBe(true);
        expect(Object.values(t.needs!.skills!)).toEqual([Math.max(...used.map(r => r.level))]);
        expect(Object.keys(t.needs!.skills!)).toEqual([...new Set(used.map(r => r.skill))]);
        const asked = used.flatMap(r => [...r.inputs.map(i => i.id), ...r.tools]).filter(id => id !== used[0]!.product).map(name).sort();
        expect(Object.keys(t.needs!.items!).map(norm).sort()).toEqual(asked);
        expect(name(used[1]!.product)).toBe(norm(t.yields({ name: 'A', side, skills: {}, items: {} })[0]!.item));
    }
});

test('the rune arrow run names a line of the Ranging Guild profile, and its spend covers a top-up off a full shelf', () => {
    const t = catalogue().find(t => t.id === 'shop-rune-arrows')!;
    expect(t.pilot).toBe(true);
    expect(selectItems(PROFILES[t.args![0]!]!.items, t.env!.ITEMS).map(i => i.re.source)).toEqual(['^rune arrow$']);
    // ranging.inv: 400 in stock at a base cost of 400; ranging.npc: sell multiplier 1000 and shop_delta 10.
    const content = resolve(import.meta.dir, '../vendor/rs-sdk/server/content/scripts/minigames/game_ranging/configs');
    expect(readFileSync(resolve(content, 'ranging.inv'), 'utf8')).toMatch(/^stock13=rune_arrow,400,130\r?$/m);
    expect(readFileSync(resolve(content, 'ranging.npc'), 'utf8')).toMatch(/param=owned_shop,ranging_guild_bowshop\r?\nparam=shop_sell_multiplier,1000\r?\nparam=shop_buy_multiplier,500\r?\nparam=shop_delta,10\r?\n/);
    const base = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8')).find((i: { id: number }) => i.id === 892).cost;
    expect(base).toBe(400);
    expect(RUNE_ARROW_SPEND).toBe(RUNE_ARROW_COST + maximumUnitCost({ baseCost: base }, { sellMultiplier: 1000 }));
    expect(Number(t.env!.MAX_SPEND)).toBe(RUNE_ARROW_SPEND);
    expect(t.needs!.items!.coins! >= Number(t.env!.FLOAT)).toBe(true);
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

import { mountainWalk, offlinePlace, MOUNTAIN } from './autopilot';
import { accountFrom, FERRY_FARE, KNIGHT_BANK, PLACES, TOLL, placeOf, wayCost } from '../packages/planner/src/autopilot';
import { walkWithFerryFallback } from './walk-to';
import { loadHunters } from '../packages/core/src/danger';
import { loadTravel } from '../packages/core/src/travel';

// Status files as the live accounts wrote them: a thief east of the mountain with 1 coin, a rich thief with 10
// Hitpoints at Draynor, and a thief at the Ardougne south bank with no coins.
const levels = (skills: Record<string, number>) => Object.entries({ Attack: 1, Strength: 1, Defence: 1, Ranged: 1, Magic: 1, Prayer: 1, Hitpoints: 10, ...skills }).map(([name, level]) => ({ name, level }));
const statusAt = (name: string, pos: { x: number; z: number; level: number }, skills: Record<string, number>, coins: number, bank = 0) => ({
    name, server: 'rs-sdk-demo.fly.dev', at: 1_000, result: 'RESULT ok', pos, skills: levels(skills),
    inventory: coins ? [{ id: 995, name: 'Coins', count: coins }] : [], bank: bank ? [{ id: 995, name: 'Coins', count: bank }] : [], equipment: [],
});
const fromStatus = (s: ReturnType<typeof statusAt>) => offlinePlace(accountFrom(s.name, side, s, () => undefined), s, 60_000_000);
const reach = (a: Acct, templates: string[], extra: Partial<Inputs> = {}) => plan({ ...inputs(a), templates: catalogue().filter(t => templates.includes(t.id)), prices: { flax: 5, feather: 2 },
    bill: [{ item: 'feathers', need: 800, owned: 0, short: 800, ids: [314], holders: [] }], mountain: mountainWalk(), pilots: new Set(['aio-flax']), ...extra })[0]!;
const strongThief = { Thieving: 89, Hitpoints: 54, Attack: 40, Strength: 40, Defence: 30 };

test('a status file gives the account its place, and a live session gives none', () => {
    const s = statusAt('Abracadickra', { x: 2877, z: 3501, level: 0 }, strongThief, 1);
    expect(accountFrom('Abracadickra', side, s, () => undefined).pos).toEqual({ x: 2877, z: 3501, level: 0 });
    expect(accountFrom('Abracadickra', side, { ...s, pos: null }, () => undefined).pos).toBeUndefined();
    expect(accountFrom('Abracadickra', side, null, () => undefined).pos).toBeUndefined();
    // A session that is live now (a fresh row with no result) is on its way: its place does not count.
    const live = { ...s, result: undefined, at: 60_000_000 - 5_000 };
    expect(offlinePlace(accountFrom('Abracadickra', side, live, () => undefined), live, 60_000_000).pos).toBeUndefined();
    expect(fromStatus(s).pos).toEqual({ x: 2877, z: 3501, level: 0 });
});

test('the walker lets a strong account over White Wolf Mountain and refuses an account with 10 Hitpoints', () => {
    const walks = mountainWalk();
    const acct = (skills: Record<string, number>): Acct => ({ name: 'A', side, skills: { Hitpoints: 10, ...skills }, items: {} });
    expect(walks(acct({ Thieving: 99 }))).toBe(false);
    expect(walks(acct(strongThief))).toBe(true);
    // The rule is the walker's own: the wolves of the mountain are among the hunters it closes ground for.
    const onPass = loadHunters().filter(h => h.spawns.some(s => s.level === 0 && s.x >= MOUNTAIN.minX && s.x <= MOUNTAIN.maxX && s.z >= MOUNTAIN.minZ && s.z <= MOUNTAIN.maxZ)).map(h => h.name);
    expect(onPass).toContain('White wolf');
    // With no hunter on the pass every account walks it.
    expect(mountainWalk([])(acct({}))).toBe(true);
});

test('an account at Taverley with 1 coin gets a coin order for the ferry fare, then the knight spot', () => {
    const thief = fromStatus(statusAt('Abracadickra', { x: 2877, z: 3501, level: 0 }, strongThief, 1));
    const donors = [{ name: 'Billionaire', coins: 2_000_000 }];
    const out = reach(thief, ['goldfarm@2652,3318'], { donors });
    expect(out.fund).toEqual({ from: 'Billionaire', to: 'Abracadickra', coins: 59, template: 'goldfarm@2652,3318' });
    // The order is for 59 coins and names no meeting place: scripts/fleet-trade.ts then meets at Varrock West.
    const placed = fundOrders([out], new Set(), (from, to, coins, meet) => coinOrder(from, to, coins, 'rs-sdk-demo.fly.dev', 1_000, meet === 'ardougne' ? ARMY_MEET : undefined));
    expect(placed.orders).toEqual([{ id: '901000-billionaire-abracadickra', server: 'rs-sdk-demo.fly.dev', from: 'Billionaire', to: 'Abracadickra', item: 'coins', count: 59, start: 901_000, end: 901_000 + 40 * 60_000 }]);
    expect(placed.assignments[0]!.reason).toBe('vacant: awaits 59 coins from Billionaire for goldfarm@2652,3318');
    // The coins arrived: the next pass gives the spot with no order.
    const paid = fromStatus(statusAt('Abracadickra', { x: 3182, z: 3440, level: 0 }, strongThief, 60));
    expect(reach(paid, ['goldfarm@2652,3318'], { donors })).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    // With no donor it takes a job on its own side.
    expect(reach(thief, ['goldfarm@2652,3318', 'feathers@3017,3288']).template?.id).toBe('feathers@3017,3288');
});

test('an account with 10 Hitpoints east of the mountain is not offered the flax field at Seers', () => {
    const weak = fromStatus(statusAt('Billionaire', { x: 3087, z: 3250, level: 0 }, { Thieving: 99 }, 1_508, 2_195_386));
    expect(reach(weak, ['aio-flax']).template).toBeUndefined();
    expect(reach(weak, ['aio-flax', 'feathers@3017,3288']).template?.id).toBe('feathers@3017,3288');
    // The strong thief is offered it: the walk over the mountain costs no fare.
    expect(reach(fromStatus(statusAt('Abracadickra', { x: 3092, z: 3242, level: 0 }, strongThief, 1)), ['aio-flax']).template?.id).toBe('aio-flax');
});

test('an account at Ardougne with no coins needs no fare for a knight spot', () => {
    const there = fromStatus(statusAt('Hocuspokeus', { x: 2654, z: 3283, level: 0 }, strongThief, 0));
    const out = reach(there, ['goldfarm@2652,3318'], { donors: [{ name: 'Billionaire', coins: 2_000_000 }] });
    expect(out).toMatchObject({ template: { id: 'goldfarm@2652,3318' }, reason: 'coins' });
    expect(out.fund).toBeUndefined();
});

test('a coin order for an account in Kandarin meets at the Ardougne north bank', () => {
    const west = fromStatus(statusAt('Hocuspokeus', { x: 2727, z: 3493, level: 0 }, {}, 0));
    const out = reach(west, ['feathers@3017,3288'], { donors: [{ name: 'Billionaire', coins: 2_000_000 }] });
    expect(out.fund).toEqual({ from: 'Billionaire', to: 'Hocuspokeus', coins: 60, template: 'feathers@3017,3288', meet: 'ardougne' });
    const placed = fundOrders([out], new Set(), (from, to, coins, meet) => coinOrder(from, to, coins, 'rs-sdk-demo.fly.dev', 1_000, meet === 'ardougne' ? ARMY_MEET : undefined));
    expect(placed.orders[0]).toMatchObject({ count: 60, meet: ARMY_MEET });
    expect(validOrder(placed.orders[0]!)).toBe(true);
});

test('the fare of the reach rule is the fare the shared walker asks for', async () => {
    // The walker asks `stageFare` for its need before the first plan. Each walk arrives, so no ferry sails here.
    const asked = async (from: { x: number; z: number; level: number }, to: { x: number; z: number; level: number }) => {
        let need = 0;
        await walkWithFerryFallback(from, to, async () => ({ ok: true, ticks: 1 }), async () => ({ ok: true, ticks: 1 }), () => 0, async n => { need = n; return { ok: true, ticks: 1 }; });
        return need;
    };
    const T = (x: number, z: number) => ({ x, z, level: 0 });
    const trips: [ReturnType<typeof T>, ReturnType<typeof T>][] = [
        [T(2877, 3501), T(2652, 3318)], [T(3092, 3242), T(2615, 3332)], [T(3269, 3164), T(2615, 3332)], [T(3222, 3218), T(2654, 3283)],
        [T(2727, 3493), T(3017, 3288)], [T(2654, 3283), T(3185, 3436)], [T(2525, 3242), T(3092, 3243)], [T(2809, 3441), T(3253, 3420)],
        [T(2877, 3501), T(3185, 3436)], [T(2809, 3441), T(2615, 3332)], [T(3092, 3242), T(2744, 3445)], [T(3092, 3242), T(2582, 3297)], [T(3092, 3242), T(2809, 3441)],
    ];
    for (const [from, to] of trips) expect([from, to, wayCost(from, to, true)]).toEqual([from, to, await asked(from, to)]);
    expect(wayCost(T(2877, 3501), T(2652, 3318), true)).toBe(60);
    expect(wayCost(T(3269, 3164), T(2615, 3332), true)).toBe(70);
    // The planner's constants are the fares of the two ferries and the toll in the travel table.
    const fare = (id: string) => loadTravel().find(t => t.id === id)!.coins;
    expect([fare('npc:captain_tobias:karamja-musa-point@3028,3216'), fare('npc:customs_officer:ardougne@2772,3225'), fare('npc:captain_barnaby:brimhaven@2679,3275'), fare('npc:customs_officer:port-sarim@2953,3147')])
        .toEqual([FERRY_FARE, FERRY_FARE, FERRY_FARE, FERRY_FARE]);
    expect(fare('npc:borderguard2:lumbridge-side-west-of-the-toll-gate@3268,3226')).toBe(TOLL);
});

test('the place of each shop job is the bank of its shop profile, and the reach rule covers 54 of the 112 templates', () => {
    for (const [resource, spot] of Object.entries(PLACES)) if (resource.startsWith('shop:')) expect([resource, spot]).toEqual([resource, PROFILES[resource.slice(5)]!.bankSpot]);
    // The templates the reach rule covers, of the whole catalogue.
    expect([catalogue().filter(t => placeOf(t)).length, catalogue().length]).toEqual([54, 112]);
    // The knight job's first walk from far away is to the bank that the planner names for each knight spot.
    const goldfarm = readFileSync(resolve(import.meta.dir, 'goldfarm.ts'), 'utf8');
    expect(goldfarm).toContain(`walkTargetPersist(s, { x: ${KNIGHT_BANK.x}, z: ${KNIGHT_BANK.z}, level: 0 })`);
});

test('an account whose logout is not confirmed is stranded and gives nothing', async () => {
    const { strandedAccounts } = await import('./autopilot');
    const proofs: Record<string, string> = { mmtha0205: 'held', Masterbaiter: 'confirmed', Fresh: 'none' };
    const out = strandedAccounts(['mmtha0205', 'Masterbaiter', 'Fresh', 'Broken'], n => { if (n === 'Broken') throw Error('unreadable'); return proofs[n]!; });
    expect([...out]).toEqual(['mmtha0205']);
});
