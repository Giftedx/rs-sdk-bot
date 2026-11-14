import { describe, expect, test } from 'bun:test';
import { canonicalRows, canonicalSnapshots, fleetStatusRows, type SnapshotFile } from './fleet-snapshots';

const row = (name: string, at: number, coins = 0) => ({ name, server: 'rs-sdk-demo.fly.dev', at, bank: [{ id: 995, name: 'Coins', count: coins }] });

describe('fleet snapshots: one row for each account', () => {
    // Fatstack moved from claude-cloud (stopped, file never rewritten) to local; Kilo never moved.
    const files: SnapshotFile[] = [
        { side: 'claude-cloud', at: 100, accounts: [row('Fatstack', 100, 7_000_000), row('Kilo', 90, 5)] },
        { side: 'local', at: 50, accounts: [row('fatstack', 50, 7_100_000)] },
    ];
    const owners: Record<string, string> = { fatstack: 'local', kilo: 'claude-cloud' };
    const ownerOf = (n: string) => owners[n.toLowerCase()];

    test('the owner side\'s row wins even when an older side\'s stale row is newer', () => {
        const rows = canonicalRows(files, ownerOf);
        expect(rows.get('fatstack')).toMatchObject({ side: 'local', at: 50 });
        expect(rows.get('kilo')).toMatchObject({ side: 'claude-cloud' });
        expect(rows.size).toBe(2);
    });

    test('with no row in its owner\'s file, the freshest row anywhere stands', () => {
        const moved: Record<string, string> = { ...owners, kilo: 'cloud' };
        expect(canonicalRows(files, n => moved[n.toLowerCase()]).get('kilo')).toMatchObject({ side: 'claude-cloud', at: 90 });
        const two: SnapshotFile[] = [{ side: 'a', accounts: [row('Zed', 10)] }, { side: 'b', accounts: [row('Zed', 20)] }];
        expect(canonicalRows(two, () => 'c').get('zed')).toMatchObject({ side: 'b', at: 20 });
    });

    test('files keep each account once, in its canonical file', () => {
        const clean = canonicalSnapshots(files, ownerOf);
        expect(clean.map(f => [f.side, (f.accounts ?? []).map(a => a.name)])).toEqual([['claude-cloud', ['Kilo']], ['local', ['fatstack']]]);
        const coins = clean.flatMap(f => f.accounts ?? []).flatMap(a => a.bank).reduce((s, i) => s + i.count, 0);
        expect(coins).toBe(7_100_005);
    });
});

test('live consumers use owner observations, same-side fallback and valid local ties once', () => {
    const local = [row('Mover', 300, 1), row('Local', 100, 2), { ...row('Practice', 400), practice: true },
        { ...row('Wrong', 400), server: 'localhost:8888' }];
    const files = [{ side: 'cloud', accounts: [row('Mover', 200, 10), row('Practice', 200, 20), row('Wrong', 200, 30)] },
        { side: 'local', accounts: [row('Local', 100, 99), row('Carried', 90, 40)] }];
    const rows = fleetStatusRows(local, files, name => name.toLowerCase() === 'mover' ? 'cloud' : undefined, 'local');
    expect(rows.map(r => [r.name, r.side, r.bank[0].count])).toEqual([
        ['Mover', 'cloud', 10], ['Local', 'local', 2], ['Practice', 'cloud', 20], ['Wrong', 'cloud', 30], ['Carried', 'local', 40],
    ]);
});

test('publishing an undated snapshot does not replace a dated local observation', () => {
    const rows = fleetStatusRows([row('Local', 100, 2)], [{ side: 'local', at: 200, accounts: [
        { ...row('Local', 0, 99), at: undefined },
    ] }], () => 'local', 'local');
    expect(rows[0]).toMatchObject({ at: 100, bank: [{ count: 2 }] });
});
