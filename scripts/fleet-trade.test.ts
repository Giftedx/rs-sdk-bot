import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTradeAdmission, fleetTradeOutcome, performFleetTransfer, pickOrder, validOrder, type Order, type Receipt } from './fleet-trade';
import { beginSessionAttempt } from '../packages/core/src/session-lifecycle';
import type { Session } from '../packages/core/src/inprocess';
import { terminalTradeReceipt, writeTradeReceipt, type TradeReceipt } from './fleet-trade-settlement';
import { makeOrder } from './fleet-order';
import { DROPPED_CLAIM_MS, droppedTradeClaims, releasePublishedTradeClaims, snapshot } from './fleet-sync';

const order = (o: Partial<Order>): Order => ({ id: 'o1', server: 's', from: 'Giver', to: 'Taker', item: 'Lobster', count: 500, start: 1000, end: 5000, ...o });

test('an order needs two different accounts, an item, a positive count and a window', () => {
    expect(validOrder(order({}))).toBe(true);
    expect(validOrder(order({ to: 'giver' }))).toBe(false);
    expect(validOrder(order({ count: 0 }))).toBe(false);
    expect(validOrder(order({ end: 1000 }))).toBe(false);
});

const attemptId = '0000000002300-1-1', sha256 = 'a'.repeat(64), nonce = '12345678-1234-1234-1234-123456789012';
const claimedReceipt = (role: 'from' | 'to' = 'to'): TradeReceipt => ({
    version: 2, state: 'prepared', id: 'o1', account: role === 'from' ? 'Giver' : 'Taker', partner: role === 'from' ? 'Taker' : 'Giver',
    role, side: 'local', server: 's', item: 'Lobster', requested: 500, claim: nonce, ok: false, count: 0, at: 2000, detail: '',
});
const logout = { state: 'confirmed', account: 'Taker', server: 's', domain: 'live', attemptId, loggedOutAt: 2400, ownerRun: null, receiptSha256: sha256 } as const;

test('transfer needs a matching partner, observed exact item delta, bank credit, and this session logout', async () => {
    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    for (const mode of ['ok', 'wrong peer', 'bank failure', 'ambiguous timeout'] as const) {
        let pack = [{ ...item, count: 5 }], calls = 0;
        const fake = {
            sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
            bot: {
                trade: async () => {
                    calls++;
                    pack = [{ ...item, count: 505 }];
                    return mode === 'ambiguous timeout' ? { success: false, partner: 'Giver', reason: 'timeout', received: [], gave: [] }
                        : { success: true, partner: mode === 'wrong peer' ? 'Other' : 'Giver', received: [item], gave: [] };
                },
                openBank: async () => ({ success: true }), closeBank: async () => ({ success: true }),
            },
            ended: new Promise(() => {}), bankObservation: () => ({ at: 2300 }),
        } as unknown as Session;
        const progress = { uncertain: false, count: 0 };
        const run = performFleetTransfer(fake, order({}), 'to', progress, {
            now: () => 2200, wait: async (_s, predicate) => predicate(null),
            deposit: async () => { if (mode === 'bank failure') throw Error('bank unavailable'); pack = []; return 505; },
        });
        if (mode === 'ok') await run;
        else await expect(run).rejects.toThrow(mode === 'bank failure' ? 'bank unavailable' : 'requires reconciliation');
        expect(calls).toBe(1);
        const final = fleetTradeOutcome(claimedReceipt(), progress, mode === 'ok', logout, attemptId, 2500, mode);
        expect(final.state).toBe(mode === 'ok' ? 'settled' : 'reconcile');
        expect(final.inventory).toEqual({ before: 5, after: 505 });
        expect(terminalTradeReceipt(order({}), 'to', final, 2500)).toBe(mode === 'ok');
        expect(fleetTradeOutcome(claimedReceipt(), progress, true, logout, 'wrong attempt', 2500, 'bad logout').state).toBe('reconcile');
    }
});

test('the sender ends its serving window after the first observed trade outcome', async () => {
    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    for (const ambiguous of [false, true]) {
        let pack = [item];
        const fake = {
            sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
            bot: { serveTrades: async (opts: Parameters<Session['bot']['serveTrades']>[0]) => {
                pack = [];
                const result = { success: !ambiguous, partner: 'Taker', message: '', gave: ambiguous ? [] : [item], received: [] };
                opts!.onTrade!(result);
                expect(opts!.until!()).toBe(true);
                return { trades: [result] };
            } },
        } as unknown as Session;
        const progress = { uncertain: false, count: 0 };
        const run = performFleetTransfer(fake, order({}), 'from', progress, {
            now: () => 2200, wait: async (_s, predicate) => predicate(null),
        });
        if (ambiguous) await expect(run).rejects.toThrow('requires reconciliation');
        else await run;
        const final = fleetTradeOutcome(claimedReceipt('from'), progress, !ambiguous,
            { ...logout, account: 'Giver' }, attemptId, 2500, 'observed');
        expect(final.state).toBe(ambiguous ? 'reconcile' : 'settled');
        expect(final.inventory).toEqual({ before: 500, after: 0 });
    }
});

test('a prepared receipt is exclusive, and only a published matched terminal receipt releases a claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-trade-settlement-'));
    try {
        const prepared = claimedReceipt(), trade = order({}), file = join(dir, 'o1.to.json');
        writeTradeReceipt(dir, prepared);
        expect(() => writeTradeReceipt(dir, { ...prepared, at: 2100 })).toThrow();
        expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('prepared');
        const progress = { uncertain: true, count: 500, inventory: { before: 0, after: 500 }, bank: { count: 500, at: 2300 } };
        const final = fleetTradeOutcome(prepared, progress, true, logout, attemptId, 2500, 'observed');
        writeTradeReceipt(dir, final);
        expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('settled');
        const claim = { account: 'taker', server: 's', side: 'local', orderId: 'o1', role: 'to', nonce, phase: 'held', at: 2000 } as const;
        let published: TradeReceipt | null = prepared;
        const releases: string[] = [], sync = () => releasePublishedTradeClaims([claim], 'local',
            path => path.startsWith('orders/') ? trade : published, r => releases.push(r.nonce), 2600);
        expect(sync()).toBe(0);
        published = { ...final, claim: 'a'.repeat(36) };
        expect(sync()).toBe(0);
        published = final;
        expect(sync()).toBe(1);
        expect(releases).toEqual([nonce]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a dropped trade session frees its claim only when the partner\'s failed receipt proves nothing moved, an hour after the window', () => {
    const trade = order({}), late = trade.end + DROPPED_CLAIM_MS;
    const claim = { account: 'giver', server: 's', side: 'cloud', orderId: 'o1', role: 'from', nonce, phase: 'held', at: 2000 } as const;
    // The giver's session dropped: no logout proof, so its receipt reads reconcile with nothing given.
    const own = { ...claimedReceipt('from'), side: 'cloud', state: 'reconcile', at: 2500, inventory: { before: 500, after: 500 } } as TradeReceipt;
    // The taker logged out with nothing received.
    const partner = { ...claimedReceipt('to'), claim: '87654321-1234-1234-1234-123456789012', state: 'failed', at: 2500,
        inventory: { before: 0, after: 0 }, logout: { attemptId, at: 2400, sha256 } } as TradeReceipt;
    expect(terminalTradeReceipt(trade, 'to', partner, late)).toBe(true);
    const files = (o: Record<string, unknown>) => (path: string) => path.startsWith('orders/') ? trade : o[path] ?? null;
    const both = { 'receipts/o1.from.json': own, 'receipts/o1.to.json': partner };
    const freed = (o: Record<string, unknown>, now = late, c: any = claim, side = 'cloud') => droppedTradeClaims([c], side, files(o), now).length;
    expect(freed(both)).toBe(1);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, state: 'prepared', inventory: undefined } })).toBe(1);
    // Too early: the window, then the hour after it, must have passed, and the claim must be that old.
    expect(freed(both, trade.end + DROPPED_CLAIM_MS - 1)).toBe(0);
    expect(freed(both, late, { ...claim, at: late - DROPPED_CLAIM_MS + 1 })).toBe(0);
    // No partner receipt, a partner that settled or still needs reconciling, or one with no logout proof: a person decides.
    expect(freed({ 'receipts/o1.from.json': own })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, state: 'reconcile' } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, logout: undefined } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, state: 'settled', ok: true, count: 500, inventory: { before: 0, after: 500 }, bank: { count: 500, at: 2300 } } })).toBe(0);
    // The account's own receipt must be this claim's, count nothing and show no change of its stack.
    expect(freed({ 'receipts/o1.to.json': partner })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, claim: 'a'.repeat(36) } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, count: 500 } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, inventory: { before: 500, after: 0 } } })).toBe(0);
    // Another side's claim, and a released one, are not this side's to free.
    expect(freed(both, late, claim, 'local')).toBe(0);
    expect(freed(both, late, { ...claim, phase: 'released' })).toBe(0);
});

test('each side picks its own open order once, in or near its window', () => {
    const o = order({}), r: Receipt = { id: 'o1', account: 'Giver', role: 'from', side: 'local', ok: true, count: 500, at: 2000, detail: '' };
    expect(pickOrder([o], [], 'giver', 2000)).toEqual({ order: o, role: 'from' });
    expect(pickOrder([o], [], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [r], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [r], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [], 'Giver', 6000)).toBeNull();
    expect(pickOrder([order({ start: 10 * 60_000 + 3000, end: 10 * 60_000 + 9000 })], [], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [], 'Stranger', 2000)).toBeNull();
});

test('trade admission rereads pauses, assignments and producer ownership after the order wait', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-trade-admission-'));
    try {
        const practice = join(base, '.practice'), coordinator = join(practice, 'coordinator');
        const planFile = join(practice, 'cloud.json'), overlay = join(coordinator, 'jobs.json'), receipts = join(base, 'receipts');
        const live = 'rs-sdk-demo.fly.dev', trade = order({ server: live });
        mkdirSync(coordinator, { recursive: true });
        writeFileSync(planFile, '{"jobs":[]}');
        const admit = (now = 2000, server = live) => assertTradeAdmission(trade, 'Giver', server, { base, planFile, receipts, now });
        expect(() => admit(999)).toThrow('order window');
        expect(() => admit()).not.toThrow();
        const stop = join(practice, 'stop-giver');
        writeFileSync(stop, 'owner pause');
        expect(admit).toThrow('owner stop file');
        unlinkSync(stop);
        const stopAll = join(practice, 'stop-swarm');
        writeFileSync(stopAll, 'owner pause');
        expect(admit).toThrow('swarm is paused');
        unlinkSync(stopAll);
        writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"worker.ts","enabled":true}]}');
        expect(admit).toThrow('enabled swarm job');
        writeFileSync(overlay, '{"jobs":[{"account":"Giver","script":"worker.ts","enabled":false}]}');
        expect(admit).not.toThrow();
        writeFileSync(overlay, '{"jobs":[{"accounts":["Other","Giver"],"script":"worker.ts","enabled":true}]}');
        expect(admit).toThrow('enabled swarm job');
        writeFileSync(overlay, '{"jobs":[],"paused":["Giver"]}');
        expect(admit).toThrow('paused for controller rollout');
        writeFileSync(overlay, '{"jobs":[]}');
        writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","goal":"Fresh-clock specialist","enabled":false}]}');
        expect(admit).toThrow('reserved account');
        writeFileSync(planFile, '{"jobs":[]}');
        expect(() => admit(5000)).toThrow('order window');
        expect(() => admit(2000, 'localhost:8888')).toThrow('order server');
        const swarmRuns = join(practice, 'swarm-runs.json');
        writeFileSync(swarmRuns, JSON.stringify([{ accounts: ['Giver'], pid: process.pid }]));
        expect(admit).toThrow('unsettled swarm worker');
        unlinkSync(swarmRuns);
        const attempt = beginSessionAttempt({ account: 'Giver', server: live }, { root: join(practice, 'session-lifecycle'), now: () => 1500 });
        expect(admit).toThrow('account logout is not confirmed');
        attempt.record('ended', 'logged-out');
        expect(admit).not.toThrow();
        mkdirSync(receipts);
        writeFileSync(join(receipts, 'o1.from.json'), '{"id":"o1","role":"from"}');
        expect(admit).toThrow('order receipt');
        writeFileSync(planFile, '{}');
        expect(admit).toThrow('invalid swarm plan');
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('an order is only made between listed accounts on one server', () => {
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['far', { side: 'cloud' as const, server: 't' }]]);
    const o = makeOrder('Giver', 'Taker', 500, 'Lobster', 0, 15, 40, owners);
    expect(o).toMatchObject({ from: 'Giver', to: 'Taker', count: 500, item: 'Lobster', start: 900_000, end: 3_300_000, server: 's' });
    expect(() => makeOrder('Giver', 'Nobody', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
    expect(() => makeOrder('Giver', 'Far', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
});

test('a snapshot holds only this side’s accounts and no credentials', () => {
    const owners = new Map([['taker', { side: 'cloud' as const, server: 's' }], ['giver', { side: 'local' as const, server: 's' }]]);
    const snap = snapshot([{ name: 'Practicebot', server: 'localhost:8888' }, { name: 'Giver', server: 's', bank: [{ id: 379, name: 'Lobster', count: 9 }], password: 'x', skills: [{ name: 'Fishing', level: 99, xp: 1 }] }, { name: 'Taker', server: 's' }], 'local', owners, 7);
    expect(snap.accounts.map(a => a.name)).toEqual(['Giver']);
    expect(JSON.stringify(snap)).not.toContain('password');
    expect(snap.accounts[0]!.skills).toEqual([{ name: 'Fishing', level: 99 }]);
});

test('a snapshot lists completed quests and leaves an unread journal unknown', () => {
    const owners = new Map(['read', 'none', 'unread', 'blank'].map(n => [n, { side: 'local' as const, server: 's' }]));
    const accounts = snapshot([
        { name: 'Read', server: 's', quests: [{ name: 'Cook', state: 'complete' }, { name: 'Imp', state: 'started' }] },
        { name: 'None', server: 's', quests: [{ name: 'Imp', state: 'not started' }] },
        { name: 'Unread', server: 's', quests: null },
        { name: 'Blank', server: 's', quests: [{ name: 'Imp', state: 'unknown' }] },
    ], 'local', owners, 7).accounts;
    expect(accounts.map(a => (a as { quests?: string[] }).quests)).toEqual([['Cook'], [], undefined, undefined]);
    expect(accounts.filter(a => 'quests' in a).map(a => a.name)).toEqual(['Read', 'None']);
});

test('the agent acts only for its own side, skips busy and running accounts, and frees the rest', async () => {
    const { dueTrades, swarmBusy } = await import('./fleet-agent');
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['busyone', { side: 'local' as const, server: 's' }]]);
    const orders = [order({}), order({ id: 'o2', from: 'BusyOne', to: 'Taker' })];
    const busy = swarmBusy([{ account: 'BusyOne', enabled: true }, { accounts: ['Other'], enabled: true }, { account: 'Giver', enabled: false }]);
    expect([...busy].sort()).toEqual(['busyone', 'other']);
    const due = dueTrades(orders, [], 'local', owners, busy, new Set(), 2000);
    expect(due.map(d => [d.account, d.order.id, d.busy])).toEqual([['Giver', 'o1', false], ['BusyOne', 'o2', true]]);
    expect(dueTrades(orders, [], 'local', owners, busy, new Set(['giver']), 2000).map(d => d.account)).toEqual(['BusyOne']);
    expect(dueTrades(orders, [], 'cloud', owners, busy, new Set(), 2000).map(d => d.account)).toEqual(['Taker']);
});
