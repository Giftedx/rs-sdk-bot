import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Owner } from '../../core/src/fleet';
import type { Order, Receipt } from '../../core/src/fleet-trade-settlement';
import { heldTradeClaims, planTradePass, tradeStop } from '../src/fleet-agent';
import { SWARM_STOP } from '../src/swarm';

// Five orders that share accounts, with order ids and start times from .practice/fleet-agent.log. Each window is
// 90 minutes. The earliest start comes first: Moneyshot and Knightstick take the Moneyshot-Knightstick order first,
// PocketPool takes its Knightstick order first, and Deeppockets takes its PocketPool order first.
const WINDOW = 5_400_000;
const order = (id: string, from: string, to: string, start: number): Order => ({ id, server: 's', from, to, item: 'Air rune', count: 10, start, end: start + WINDOW });
const MK = order('1795638493244-moneyshot-knightstick-f4deffc660752722', 'Moneyshot', 'Knightstick', 1795638493244);
const MB = order('1795638493506-moneyshot-bigchopper-b9d82071603e0918', 'Moneyshot', 'Bigchopper', 1795638493506);
const PK = order('1795638494387-pocketpool-knightstick-5c2e656a5a906146', 'PocketPool', 'Knightstick', 1795638494387);
const PD = order('1795638494939-pocketpool-deeppockets-b20a3d1b997f4b4a', 'PocketPool', 'Deeppockets', 1795638494939);
const MD = order('1795638495236-masterbaiter-deeppockets-c25f3d91bbf2976d', 'Masterbaiter', 'Deeppockets', 1795638495236);
const ORDERS = [MK, MB, PK, PD, MD];
const NAMES = ['Moneyshot', 'Knightstick', 'Bigchopper', 'PocketPool', 'Deeppockets', 'Masterbaiter'];
const owners = new Map<string, Owner>(NAMES.map(n => [n.toLowerCase(), { side: 'local', server: 's' }]));
const knightstickOnCloud = () => new Map([...owners, ['knightstick', { side: 'cloud', server: 's' }]]);
const NOW = MK.start + 25 * 60_000;
const DRAIN = { drained: ['packages/core/src/bot/rules.ts', 'packages/core/src/ledger.ts', 'a.ts', 'b.ts', 'c.ts', 'd.ts'], target: '930d0278a9a4c1' };
const DRAIN_TEXT = 'live update to 930d0278a9 drains packages/core/src/bot/rules.ts, packages/core/src/ledger.ts and 4 more';

const runs = (rows: [string, Order][]) => ({
    running: new Map(rows.map(([a]) => [a.toLowerCase(), a])),
    runningOrders: new Map(rows.map(([a, o]) => [a.toLowerCase(), o.id])),
});
const pass = (o: Partial<Parameters<typeof planTradePass>[0]> = {}) => planTradePass({
    orders: ORDERS, receipts: [], side: 'local', owners, busy: new Set(), running: new Map(), runningOrders: new Map(), now: NOW, ...o,
});
const starts = (p: ReturnType<typeof planTradePass>) => p.starts.map(s => `${s.account} ${s.order.id}`);
const waits = (p: ReturnType<typeof planTradePass>) => Object.fromEntries(p.waits.map(w => [w.account, `${w.kind}: ${w.why}`]));

describe('fleet agent: both parties of an order start in the same pass', () => {
    test('PocketPool does not start its Knightstick order while Knightstick takes the Moneyshot order first', () => {
        const p = pass();
        // Moneyshot and Knightstick both take the Moneyshot order first: they start together in this pass, so each later
        // check in the pass sees them run it.
        expect(starts(p)).toEqual([`Moneyshot ${MK.id}`, `Knightstick ${MK.id}`]);
        expect(waits(p)).toEqual({
            Bigchopper: `held: partner Moneyshot runs order ${MK.id}`,
            PocketPool: `held: partner Knightstick runs order ${MK.id}`,
            Deeppockets: `held: partner PocketPool takes order ${PK.id} first`,
            Masterbaiter: `held: partner Deeppockets takes order ${PD.id} first`,
        });
        expect(p.ends).toEqual([]);
    });

    test('a partner that runs another order keeps this side waiting; a partner that runs this order lets it start', () => {
        // Knightstick runs the Moneyshot order without Moneyshot.
        const p = pass(runs([['Knightstick', MK]]));
        expect(starts(p)).toEqual([`Moneyshot ${MK.id}`]);
        expect(waits(p).PocketPool).toBe(`held: partner Knightstick runs order ${MK.id}`);
        // PocketPool runs its Knightstick order without Knightstick: Deeppockets does not join PocketPool.
        const q = pass(runs([['PocketPool', PK]]));
        expect(waits(q).Deeppockets).toBe(`held: partner PocketPool runs order ${PK.id}`);
        expect(starts(q)).toContain(`Knightstick ${MK.id}`);
        expect(starts(q)).not.toContain(`Knightstick ${PK.id}`);
    });

    test('a partner that wrote its side of the order does not hold this side', () => {
        const receipts = [{ id: PK.id, role: 'to' } as Receipt];
        // Knightstick has its receipt for the PocketPool order, so its first due order stays the Moneyshot order.
        const p = pass({ receipts });
        expect(starts(p)).toContain(`PocketPool ${PK.id}`);
        // The same through the receipt file the agent reads at the time of the check.
        const q = pass({ wrote: (id, role) => id === PK.id && role === 'to' });
        expect(starts(q)).toContain(`PocketPool ${PK.id}`);
    });

    test('a partner busy with a swarm job, or held by a stop file, keeps this side waiting', () => {
        const busy = pass({ busy: new Set(['knightstick']) });
        expect(waits(busy).Knightstick).toBe('busy: enabled swarm job');
        expect(waits(busy).Moneyshot).toBe('held: partner Knightstick waits: enabled swarm job');
        expect(starts(busy)).not.toContain(`Moneyshot ${MK.id}`);
        const stopped = pass({ stopHeld: a => a === 'Moneyshot' ? 'owner stop file' : undefined });
        expect(waits(stopped).Knightstick).toBe('held: partner Moneyshot waits: owner stop file');
        expect(starts(stopped)).toEqual([]);
    });

    test('a partner on another side starts there: this side starts as before', () => {
        const p = pass({ owners: knightstickOnCloud() });
        expect(starts(p)).toEqual([`Moneyshot ${MK.id}`, `PocketPool ${PK.id}`]);
    });

    test('a chain of orders that share accounts still moves: each finished pair frees the next', () => {
        expect(starts(pass())).toEqual([`Moneyshot ${MK.id}`, `Knightstick ${MK.id}`]);
        const mk = [{ id: MK.id, role: 'from' }, { id: MK.id, role: 'to' }] as Receipt[];
        expect(starts(pass({ receipts: mk }))).toEqual([`Moneyshot ${MB.id}`, `Knightstick ${PK.id}`, `Bigchopper ${MB.id}`, `PocketPool ${PK.id}`]);
        const pk = [...mk, { id: MB.id, role: 'from' }, { id: MB.id, role: 'to' }, { id: PK.id, role: 'from' }, { id: PK.id, role: 'to' }] as Receipt[];
        expect(starts(pass({ receipts: pk }))).toEqual([`PocketPool ${PD.id}`, `Deeppockets ${PD.id}`]);
    });
});

describe('fleet agent: a trade claim held for another order holds both parties', () => {
    // Order xfer-1795731762768-1 settled, but the trade claims of Moneyshot stayed held: the agent started Moneyshot and
    // its partner on the next order, the login of Moneyshot refused the held claim, and the partner waited out the window.
    const OLD = 'xfer-1795731762768-1';
    test('neither party starts while one of them holds a claim for another order', () => {
        let asked: readonly string[] = [];
        const p = pass({ claimHeld: accounts => { asked = accounts; return new Map([['moneyshot', OLD]]); } });
        expect(asked).toContain('Moneyshot');
        expect(asked).toContain('Knightstick');
        expect(starts(p)).not.toContain(`Moneyshot ${MK.id}`);
        expect(starts(p)).not.toContain(`Knightstick ${MK.id}`);
        expect(waits(p).Moneyshot).toBe(`held: trade claim held for order ${OLD}`);
        expect(waits(p).Knightstick).toBe(`held: partner Moneyshot trade claim held for order ${OLD}`);
    });

    test('a claim held for the same order does not hold it', () => {
        const p = pass({ claimHeld: () => new Map([['moneyshot', MK.id]]) });
        expect(starts(p)).toEqual([`Moneyshot ${MK.id}`, `Knightstick ${MK.id}`]);
    });

    test('a partner on another side that holds a claim for another order holds this side', () => {
        const p = pass({ owners: knightstickOnCloud(), claimHeld: () => new Map([['knightstick', OLD]]) });
        expect(starts(p)).not.toContain(`Moneyshot ${MK.id}`);
        expect(waits(p).Moneyshot).toBe(`held: partner Knightstick trade claim held for order ${OLD}`);
    });

    test('a partner that wrote its receipt of this order does not hold it with a claim for a later order', () => {
        const p = pass({ owners: knightstickOnCloud(), receipts: [{ id: MK.id, role: 'to' } as Receipt], claimHeld: () => new Map([['knightstick', OLD]]) });
        expect(starts(p)).toContain(`Moneyshot ${MK.id}`);
    });

    test('a claim with a pre-network marker of this checkout holds nothing: the login takes it over', () => {
        const base = mkdtempSync(join(tmpdir(), 'fleet-claim-pending-'));
        try {
            const claim = (account: string, nonce: string) => ({ account, server: 's', side: 'local', orderId: OLD, role: 'from' as const, nonce, phase: 'held' as const, at: 1 });
            const abandoned = '11111111-1111-4111-8111-111111111111', live = '22222222-2222-4222-8222-222222222222';
            mkdirSync(join(base, '.practice', 'fleet-account-pending'), { recursive: true });
            writeFileSync(join(base, '.practice', 'fleet-account-pending', `${abandoned}.json`), '{}');
            const held = heldTradeClaims(base, ['Moneyshot', 'Knightstick'], () => [claim('Moneyshot', abandoned), claim('Knightstick', live)]);
            expect([...held]).toEqual([['knightstick', OLD]]);
            expect([...heldTradeClaims(base, ['Moneyshot'], () => { throw Error('unreadable'); })]).toEqual([]);
        } finally { rmSync(base, { recursive: true, force: true }); }
    });

    test('an owner halt reads no claims', () => {
        let read = false;
        pass({ halt: 'owner stop', claimHeld: () => { read = true; return new Map(); } });
        expect(read).toBe(false);
    });
});

describe('fleet agent: a started side ends early when its partner is held by a live-update drain', () => {
    test('PocketPool and Deeppockets end early while Knightstick waits on the drain', () => {
        // PocketPool runs its Knightstick order and Deeppockets its PocketPool order, each without its partner.
        const p = pass({ ...runs([['PocketPool', PK], ['Deeppockets', PD]]), drain: { ...DRAIN, others: [] } });
        expect(waits(p).Knightstick).toBe(`held: ${DRAIN_TEXT}`);
        expect(starts(p)).toEqual([]);
        expect(p.ends).toEqual([
            { account: 'PocketPool', order: PK.id, why: `partner Knightstick takes order ${MK.id} first; ${DRAIN_TEXT}` },
            { account: 'Deeppockets', order: PD.id, why: `partner PocketPool runs order ${PK.id}; ${DRAIN_TEXT}` },
        ]);
    });

    test('a drain does not end a trade whose partner runs the same order, wrote its side, or starts it now', () => {
        const drain = { ...DRAIN, others: [] };
        expect(pass({ ...runs([['Moneyshot', MK], ['Knightstick', MK]]), drain }).ends).toEqual([]);
        expect(pass({ ...runs([['PocketPool', PK]]), drain, wrote: (id, role) => id === PK.id && role === 'to' }).ends).toEqual([]);
        // Moneyshot runs the order without Knightstick. The drain does not hold Knightstick, whose partner runs the order: it joins.
        const rejoin = pass({ ...runs([['Moneyshot', MK]]), drain });
        expect(starts(rejoin)).toEqual([`Knightstick ${MK.id}`]);
        expect(rejoin.ends).toEqual([]);
    });

    test('no early end without a drain, while a run that is not a trade holds the update, or for a partner on another side', () => {
        const lone = runs([['PocketPool', PK]]);
        expect(pass(lone).ends).toEqual([]);
        expect(pass({ ...lone, drain: { ...DRAIN, others: ['Ballspinner'] } }).ends).toEqual([]);
        expect(pass({ ...lone, drain: { ...DRAIN, drained: [], others: [] } }).ends).toEqual([]);
        expect(pass({ ...lone, owners: knightstickOnCloud(), drain: { ...DRAIN, others: [] } }).ends).toEqual([]);
    });
});

test('the partner check reads a stop file without removing it', () => {
    const base = mkdtempSync(join(tmpdir(), 'fleet-agent-partner-')), prac = join(base, '.practice'), file = join(prac, 'stop-Knightstick');
    try {
        mkdirSync(join(prac, 'status'), { recursive: true });
        writeFileSync(file, SWARM_STOP.removed);
        writeFileSync(join(prac, 'status', 'Knightstick.json'), JSON.stringify({ at: 1, result: 'RESULT ok' }));
        expect(tradeStop(base, 'Knightstick', 1_000_000, false)).toEqual({ cleared: false });
        expect(tradeStop(base, 'Knightstick', 1_000_000)).toEqual({ cleared: true });
    } finally { rmSync(base, { recursive: true, force: true }); }
});
