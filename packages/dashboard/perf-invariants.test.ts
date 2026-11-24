import { describe, expect, test } from 'bun:test';
import { remoteBots, fleetSidesView } from './fleet-view';
import { publicView, pushDue, withoutClocks, withoutClocksValue } from './publish-relay';
import { overtakeView } from './world-view';

describe('dashboard perf invariants', () => {
    test('withoutClocksValue matches withoutClocks(JSON.stringify) and pushDue honors precomputed stable hash', () => {
        const now = 1_700_000_000_000;
        const obj = {
            at: now,
            hosted: { at: now + 500, kind: 'public' },
            bots: [{ name: 'Worker1', at: now - 1000, level: 55 }],
            count: 42,
        };
        const json = JSON.stringify(obj);
        const stable = withoutClocksValue(obj);
        expect(stable).toBe(withoutClocks(json));

        const last = { stable, at: now };
        const objNewClock = { ...obj, at: now + 2000, hosted: { at: now + 2000, kind: 'public' } };
        expect(pushDue(JSON.stringify(objNewClock), last, now + 2000, withoutClocksValue(objNewClock))).toBe(false);

        const objChanged = { ...obj, bots: [{ name: 'Worker1', at: now, level: 56 }] };
        expect(pushDue(JSON.stringify(objChanged), last, now + 2000, withoutClocksValue(objChanged))).toBe(true);
    });

    test('publicView recursive secret check catches nested leaks while ignoring undefined properties', () => {
        expect(() =>
            publicView({
                bots: [{ name: 'Worker1', goal: 'normal', equipment: [{ name: 'Helm of Haggis' }] }],
            }),
        ).toThrow('nothing published');

        expect(() =>
            publicView({
                bots: [],
                lookups: { HaggisKey: { name: 'Other' } },
            }),
        ).toThrow('nothing published');

        // Undefined property keys are omitted by JSON.stringify and must not trigger false positives.
        const clean = publicView({
            bots: [{ name: 'Worker1', goal: 'mining' }],
            roster: [['Worker1', 3200, 3200, 0, 10]],
        });
        expect(clean.bots).toHaveLength(1);
    });

    test('remoteBots selects latest fresh plan per side and fleetSidesView indexes receipts by order', () => {
        const now = 1_700_000_000_000;
        const snapshots = [
            { side: 'cloud', at: now - 1000, accounts: [{ name: 'CloudBot', server: 'rs-sdk-demo.fly.dev', at: now - 1000, skills: [] }] },
        ];
        const plans = [
            { side: 'cloud', at: now - 60_000, jobs: [{ account: 'CloudBot', script: 'old.ts', goal: 'old', enabled: true }] },
            { side: 'cloud', at: now - 5_000, jobs: [{ account: 'CloudBot', script: 'new.ts', goal: 'new', enabled: true }] },
        ];
        const rows = remoteBots(snapshots, new Set(), new Map(), new Map(), now, 'local', plans, () => 'cloud');
        expect(rows).toHaveLength(1);
        expect(rows[0].planJob?.goal).toBe('new');
        expect(rows[0].currentGoal).toBe('Planned: new');

        const sides = fleetSidesView(
            snapshots,
            [
                { id: 'o1', from: 'A', to: 'B', item: 'Shark', count: 10, start: now - 1000, end: now + 10_000 },
                { id: 'o2', from: 'A', to: 'B', item: 'Lobster', count: 5, start: now - 500, end: now + 10_000 },
            ],
            now,
            [
                { id: 'o1', role: 'from', ok: true },
                { id: 'o1', role: 'to', ok: true },
                { id: 'o2', role: 'from', ok: true },
            ],
        );
        expect(sides.orders.map((o: any) => `${o.id}:${o.state}`)).toEqual(['o2:half']);
    });

    test('overtakeView picks best fleet rank per board cleanly', () => {
        const tops = new Map([
            ['Mining', { rows: [{ rank: 1, name: 'Rival1', level: 80, ticks: 10_000 }, { rank: 2, name: 'Rival2', level: 70, ticks: 8_000 }] }],
            ['Overall', { rows: [{ rank: 1, name: 'Rival1', level: 1000, ticks: 20_000 }] }],
        ]);
        const accounts = [
            { name: 'SlowBot', skills: [{ name: 'Mining', level: 60, xp: 300_000 }], ranks: [{ board: 'Mining', rank: 10, level: 60, time: '2h 0m 0s' }] },
            { name: 'FastBot', skills: [{ name: 'Mining', level: 65, xp: 450_000 }], ranks: [{ board: 'Mining', rank: 5, level: 65, time: '1h 0m 0s' }] },
        ];
        const out = overtakeView(tops, accounts, lvl => lvl * 10_000);
        expect(out).toHaveLength(1);
        expect(out[0].board).toBe('Mining');
        expect(out[0].account).toBe('FastBot');
        expect(out[0].rank).toBe(5);
    });
});
