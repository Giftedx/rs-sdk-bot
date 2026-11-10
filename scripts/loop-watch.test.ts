import { expect, test } from 'bun:test';
import { FAIL_REPEATS, PACING_TICKS, TRADE_WAIT_MS, failLoop, faultKey, needsRecovery, pacing, retryLoops, tradeStuck } from './loop-watch';

test('a fail loop is the same failure at the end of the log, numbers aside, with no ok between', () => {
    const fail = (tick: number) => `RESULT fail Error: no escape item: bank an amulet of glory, or law runes with Magic 25+, before a PK trip tick=${tick}`;
    expect(faultKey(fail(61))).toBe(faultKey(fail(905)));
    expect(failLoop([fail(1), fail(2)])).toBeNull();
    expect(failLoop([fail(1), fail(2), fail(3)])).toMatchObject({ count: 3 });
    expect(failLoop(['RESULT ok xp=10', fail(1), fail(2), fail(3), fail(4)])).toMatchObject({ count: 4 });
    // An ok RESULT, or another fault, breaks the run of failures.
    expect(failLoop([fail(1), fail(2), 'RESULT ok xp=10', fail(3)])).toBeNull();
    expect(failLoop([fail(1), fail(2), 'RESULT fail Error: bank closed', fail(3)])).toBeNull();
    expect(failLoop([fail(1), fail(2), fail(3), 'RESULT ok xp=10'])).toBeNull();
    // Supervisor and log prefixes do not hide a RESULT line; other lines do not count.
    expect(failLoop(['SUPERVISE run 1 exit 1: x', `| [Shaftmaker] ${fail(1)}`, `[Shaftmaker] ${fail(2)}`, 'LOGOUT logged-out', fail(3)])).toMatchObject({ count: FAIL_REPEATS });
});

test('a retry loop is a standing job the controller restarted many times in its newest lines', () => {
    const cycle = (a: string, reason: string) => [`SWARM standing retry ${a} after ${reason}`, `SWARM start ${a} scripts/pk-live/live-pilot.ts {}`, `SWARM end ${a} ${reason}`];
    const log = [...Array.from({ length: 6 }, () => cycle('Shaftmaker', 'gave-up after 1 runs')).flat(), ...cycle('Woodenstaff', 'stopped after 1 runs')];
    expect(retryLoops(log)).toEqual([{ account: 'Shaftmaker', count: 6, reason: 'gave-up after 1 runs' }]);
    // Old restarts outside the window do not count.
    expect(retryLoops(log, 5, 6)).toEqual([]);
});

test('pacing is a long run of only walking in one small box; real work or real travel is not', () => {
    const walk = 'mi'.repeat(PACING_TICKS / 2), at = (x: number, z: number) => ({ x, z, level: 0 });
    const box = [at(2618, 3333), at(2617, 3333), at(2618, 3333), at(2617, 3333)];
    expect(pacing(walk, box)).toBe(true);
    // One XP drop, item change or dialog in the tail is progress.
    expect(pacing(walk.slice(0, -1) + 'x', box)).toBe(false);
    // Standing still is the idle alert of scripts/monitor.ts, not pacing.
    expect(pacing('i'.repeat(PACING_TICKS), box)).toBe(false);
    // A journey leaves the box; one pass has too few samples.
    expect(pacing(walk, [at(2618, 3333), at(2625, 3333), at(2640, 3333), at(2660, 3333)])).toBe(false);
    expect(pacing(walk, box.slice(0, 3))).toBe(false);
    expect(pacing(walk.slice(0, 50), box)).toBe(false);
});

test('a trade is stuck when a party waits and its partner has not come, or a receipt needs reconciliation', () => {
    const order = { id: '1-thefullmonty-deeppockets', from: 'TheFullMonty', to: 'Deeppockets', item: 'Air rune', count: 10, start: 0, end: 25 * 60_000 };
    const prepared = { id: order.id, account: 'Deeppockets', role: 'to', state: 'prepared', at: 60_000, detail: 'trade claimed' };
    expect(tradeStuck([order], [prepared], 60_000 + TRADE_WAIT_MS - 1)).toEqual([]);
    expect(tradeStuck([order], [prepared], 60_000 + TRADE_WAIT_MS)).toEqual([{ account: 'Deeppockets', text: 'waits 5 min in order 1-thefullmonty-deeppockets (10 Air rune); TheFullMonty has not come' }]);
    // The partner came: both wait for the trade itself.
    expect(tradeStuck([order], [prepared, { ...prepared, account: 'TheFullMonty', role: 'from' }], 60_000 + TRADE_WAIT_MS)).toEqual([]);
    // Long after the window the order is history.
    expect(tradeStuck([order], [prepared], order.end + TRADE_WAIT_MS)).toEqual([]);
    const reconcile = { id: order.id, account: 'TheFullMonty', role: 'from', state: 'reconcile', at: 9 * 60_000, detail: 'no progress: 900 ticks without xp, items, dialog or a journey' };
    expect(tradeStuck([order], [reconcile], 10 * 60_000)[0]).toMatchObject({ account: 'TheFullMonty' });
    expect(tradeStuck([order], [{ ...prepared, state: 'settled' }], 10 * 60_000)).toEqual([]);
});

test('only a session recovery clears an orphaned end or a held fleet claim', () => {
    expect(needsRecovery('exit orphaned: attempt 1794205916979-0000018796-0000000001 owner 18796 gone')).toBe(true);
    expect(needsRecovery('RESULT fail login: Error: fleet account claim held by swarm')).toBe(true);
    expect(needsRecovery('gave-up after 21 runs')).toBe(false);
    expect(needsRecovery('RESULT fail Error: bank closed')).toBe(false);
});

import { EMPTY_REPEATS, emptyLoop } from './loop-watch';
test('an empty loop is ok runs that did no work, one after the other', () => {
    const empty = ['CHAIN round=1 scripts/walk-to.ts ok RESULT ok walk-to {"ok":true,"ticks":0} at=3092,3243,0 ticks=2',
        '  | RESULT ok chicken-qualification {"ok":true,"combat":45,"ticks":0,"kills":0,"hpMin":54,"preserved":true}',
        'RESULT ok chain rounds=1 ok=2 failed=0', 'SUPERVISE run 1 exit 0: RESULT ok chain rounds=1 ok=2 failed=0', 'SUPERVISE end done after 1 runs'];
    const work = ['LEDGER ticks=9057 xp=2098 inventory=79 move=1501', 'SUPERVISE run 1 exit 0: RESULT ok ticks=9001 picks=2158 coinsGained=103150', 'SUPERVISE end done after 1 runs'];
    const failed = ['SUPERVISE run 1 exit 1: RESULT fail stop file chain rounds=1 ok=2 failed=0', 'SUPERVISE end stopped after 1 runs'];
    expect(emptyLoop([...empty, ...empty])).toBe(0);
    expect(emptyLoop([...empty, ...empty, ...empty])).toBe(EMPTY_REPEATS);
    expect(emptyLoop([...work, ...empty, ...empty, ...empty, ...empty])).toBe(4);
    // A run with real work, or a failed run, ends the count: a failure is the fail-loop rule's case.
    expect(emptyLoop([...empty, ...empty, ...work, ...empty])).toBe(0);
    expect(emptyLoop([...empty, ...empty, ...empty, ...failed])).toBe(0);
    expect(emptyLoop([...work, ...work, ...work])).toBe(0);
});
