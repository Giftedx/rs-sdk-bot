import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTradeAdmission, fleetTradeOutcome, partnerFailed, performFleetTransfer, pickOrder, validOrder, watchTradeScreen, type Order, type Receipt } from './fleet-trade';
import { beginSessionAttempt } from '../packages/core/src/session-lifecycle';
import type { Session } from '../packages/core/src/inprocess';
import { terminalTradeReceipt, writeTradeReceipt, type TradeReceipt } from './fleet-trade-settlement';
import { makeOrder } from './fleet-order';
import { DROPPED_CLAIM_MS, UNANSWERED_GRACE_MS, droppedTradeClaims, releasePublishedTradeClaims, snapshot } from './fleet-sync';

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

test('a dropped trade session frees its claim only when the records prove nothing moved: the partner\'s failed receipt, or no claim by the partner at the window\'s end', () => {
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
    const died = { ...both, 'receipts/o1.from.json': { ...own, state: 'prepared', inventory: undefined } };
    expect(freed(died)).toBe(1);
    // A worker that ended (`reconcile`) frees its claim as soon as the partner's failed receipt is in, inside the
    // window too. One that died (`prepared`) waits: the window, then the hour after it, and the claim that old.
    expect(freed(both, 3000, { ...claim, at: 2900 })).toBe(1);
    expect(freed(died, trade.end + DROPPED_CLAIM_MS - 1)).toBe(0);
    expect(freed(died, late, { ...claim, at: late - DROPPED_CLAIM_MS + 1 })).toBe(0);
    // No partner receipt and no word from the partner's side since the window: a person decides. The same for a
    // partner that settled or still needs reconciling, or one with no logout proof.
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
    // The partner never came: no receipt of it, and its side published after the window. This account's worker has
    // ended (`reconcile`), so the claim goes at once, with no hour's wait and a fresh claim.
    const owners = { accounts: { Giver: { side: 'cloud', server: 's' }, Taker: { side: 'local', server: 's' } } };
    const soon = trade.end + UNANSWERED_GRACE_MS, fresh = { ...claim, at: soon - 1000 };
    const alone = (partnerFiles: Record<string, unknown>, ownReceipt: unknown = own, now = soon) =>
        freed({ 'receipts/o1.from.json': ownReceipt, 'owners.json': owners, ...partnerFiles }, now, fresh);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } })).toBe(1);
    expect(alone({ 'leases/local.json': { side: 'local', at: soon } })).toBe(1);
    expect(alone({ 'snapshots/local.json': { side: 'local', at: soon, accounts: [] } })).toBe(1);
    // The partner's side last published inside the window, or before the grace: its claim may not be published yet.
    expect(alone({ 'claims/local.json': { side: 'local', at: trade.end - 1 } })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon - 1 } })).toBe(0);
    expect(alone({})).toBe(0);
    // Inside the window the partner may still come.
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, own, trade.end - 1)).toBe(0);
    // A worker that has not ended (`prepared`), a receipt that counted items, or a changed stack: a person decides.
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, state: 'prepared', inventory: undefined })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, count: 3 })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, inventory: { before: 500, after: 497 } })).toBe(0);
});

test('a worker that saw no trade screen frees its claim after the window, whatever the partner\'s receipt reads', () => {
    const trade = order({}), over = trade.end;
    const claim = { account: 'giver', server: 's', side: 'cloud', orderId: 'o1', role: 'from', nonce, phase: 'held', at: 2000 } as const;
    // Both sessions were cut while they waited: no logout proof, so both receipts read reconcile with nothing counted.
    const own = { ...claimedReceipt('from'), side: 'cloud', state: 'reconcile', at: 2500, screen: false } as TradeReceipt;
    const partner = { ...claimedReceipt('to'), side: 'cloud', claim: '87654321-1234-1234-1234-123456789012', state: 'reconcile', at: 2500, screen: false } as TradeReceipt;
    const files = (o: Record<string, unknown>) => (path: string) => path.startsWith('orders/') ? trade : o[path] ?? null;
    const freed = (ownReceipt: unknown, partnerReceipt: unknown = partner, now = over) =>
        droppedTradeClaims([claim], 'cloud', files({ 'receipts/o1.from.json': ownReceipt, ...(partnerReceipt ? { 'receipts/o1.to.json': partnerReceipt } : {}) }), now).length;
    expect(freed(own)).toBe(1);
    // The partner's receipt does not matter: still `prepared`, one that saw a screen, or none and no word from its side.
    expect(freed(own, { ...partner, state: 'prepared', screen: undefined })).toBe(1);
    expect(freed(own, { ...partner, screen: true })).toBe(1);
    expect(freed(own, null)).toBe(1);
    // Inside the window the order may still be tried: the claim stays.
    expect(freed(own, partner, over - 1)).toBe(0);
    // A screen seen, or a session whose trade state was never observed: a person decides, as before.
    expect(freed({ ...own, screen: true })).toBe(0);
    expect(freed({ ...own, screen: undefined })).toBe(0);
    // A worker that has not ended, a counted item or a changed stack: never by this rule.
    expect(freed({ ...own, state: 'prepared' })).toBe(0);
    expect(freed({ ...own, count: 1 })).toBe(0);
    expect(freed({ ...own, inventory: { before: 500, after: 499 } })).toBe(0);
    expect(freed({ ...own, claim: 'a'.repeat(36) })).toBe(0);
});

test('the trade worker records whether a trade screen was ever open', () => {
    let state: { trade?: { isOpen: boolean } } | null = null, tick = () => {};
    const s = { onTick: (cb: () => void) => { tick = cb; return () => {}; }, sdk: { getState: () => state } };
    const progress: Parameters<typeof watchTradeScreen>[1] = { uncertain: false, count: 0 };
    watchTradeScreen(s, progress);
    // No state yet, or a client with no trade state: unknown, and the receipt carries no `screen`.
    expect(progress.screen).toBeUndefined();
    state = {}; tick();
    expect(progress.screen).toBeUndefined();
    expect('screen' in fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut')).toBe(false);
    // Observed closed: false. Open on one tick: true from then on, also after it closes.
    state = { trade: { isOpen: false } }; tick();
    expect(progress.screen).toBe(false);
    expect(fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut')).toMatchObject({ state: 'reconcile', count: 0, screen: false });
    state = { trade: { isOpen: true } }; tick();
    state = { trade: { isOpen: false } }; tick();
    expect(progress.screen).toBe(true);
    expect(fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut').screen).toBe(true);
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
        const admit = (now = 2000, server = live) => assertTradeAdmission(trade, 'Giver', server, { base, planFile, receipts, now, starts: () => null });
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

test('trade admission passes a swarm run whose pid a later process holds', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-trade-pid-'));
    try {
        const practice = join(base, '.practice'), planFile = join(practice, 'cloud.json'), receipts = join(base, 'receipts');
        const live = 'rs-sdk-demo.fly.dev', trade = order({ server: live }), started = 1_000_000;
        mkdirSync(join(practice, 'coordinator'), { recursive: true });
        writeFileSync(planFile, '{"jobs":[]}');
        // This test process answers a signal for the id of each run.
        writeFileSync(join(practice, 'swarm-runs.json'), JSON.stringify([{ accounts: ['Other'], pid: process.pid, started: 5 }, { accounts: ['Giver'], pid: process.pid, started }]));
        const reads: number[][] = [];
        const admit = (table: Map<number, number> | null) => assertTradeAdmission(trade, 'Giver', live, { base, planFile, receipts, now: 2000, starts: pids => { reads.push([...pids]); return table; } });
        // The process started before the run record: the run's supervisor. A failed read proves nothing.
        expect(() => admit(new Map([[process.pid, started - 40]]))).toThrow('unsettled swarm worker');
        expect(() => admit(null)).toThrow('unsettled swarm worker');
        expect(() => admit(new Map())).toThrow('unsettled swarm worker');
        // The process started after the run record: a different process holds the id.
        expect(() => admit(new Map([[process.pid, started + 60_000]]))).not.toThrow();
        // One read for each check, with the id of this account's run only.
        expect(reads).toEqual([[process.pid], [process.pid], [process.pid], [process.pid]]);
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

test('a side leaves the meet when its partner\'s receipt says failed, with nothing uncertain and nothing traded', async () => {
    // Live: a taker that could not pay its ferry fare failed at once; its giver waited out a 50-minute window.
    const dir = mkdtempSync(join(tmpdir(), 'fleet-trade-partner-'));
    try {
        const trade = order({});
        expect(partnerFailed(dir, trade, 'from')).toBe(false);
        // The partner's claim alone, or its settled receipt, is not a failure; neither is this side's own receipt.
        writeTradeReceipt(dir, claimedReceipt('to'));
        expect(partnerFailed(dir, trade, 'from')).toBe(false);
        writeTradeReceipt(dir, { ...claimedReceipt('from'), state: 'failed', detail: 'own side' });
        expect(partnerFailed(dir, trade, 'from')).toBe(false);
        writeTradeReceipt(dir, { ...claimedReceipt('to'), state: 'failed', detail: 'route to 3182, 3440: precondition ferry needs 60 coins' });
        expect(partnerFailed(dir, trade, 'from')).toBe(true);
        expect(partnerFailed(dir, { ...trade, id: 'other' }, 'from')).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    // The giver: the serving window ends on the partner's failure, no trade was served, and the side fails cleanly.
    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    let asked = 0;
    const giver = {
        sdk: { getState: () => ({ inventory: [item] }), getInventory: () => [item] },
        bot: { serveTrades: async (opts: Parameters<Session['bot']['serveTrades']>[0]) => { asked++; expect(opts!.until!()).toBe(true); return { trades: [], reason: 'until' }; } },
    } as unknown as Session;
    const giving = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(giver, order({}), 'from', giving, { now: () => 2200, gone: () => true })).rejects.toThrow('partner failed: no trade');
    expect(asked).toBe(1);
    expect(giving.uncertain).toBe(false);
    expect(fleetTradeOutcome(claimedReceipt('from'), giving, true, { ...logout, account: 'Giver' }, attemptId, 2500, 'partner failed').state).toBe('failed');
    // The taker: no trade request is sent once the partner has failed.
    let requests = 0;
    const taker = {
        sdk: { getState: () => ({ inventory: [] }), getInventory: () => [] },
        bot: { trade: async () => { requests++; return { success: false, reason: 'timeout', received: [], gave: [] }; } },
        ended: new Promise(() => {}),
    } as unknown as Session;
    const taking = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(taker, order({}), 'to', taking, { now: () => 2200, gone: () => true })).rejects.toThrow('partner failed: no trade');
    expect(requests).toBe(0);
    expect(taking.uncertain).toBe(false);
});

