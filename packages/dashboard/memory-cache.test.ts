import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactExpiredOrderSummary, fleetSidesView } from './fleet-view';
import { scanJsonlTail, tailJsonlFile, tailLines } from './jsonl-tail';
import { pushDue, withoutClocksHashValue } from './publish-relay';
import { encodeMapCache, readCachedMapBytes, type MapSpec } from './server/build-map';

const dirs: string[] = [];
const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'dash-mem-cache-test-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('dashboard memory caches', () => {
    test('scanJsonlTail streams multi-chunk JSONL files with exact parity against tailLines', () => {
        const dir = scratch();
        const file = join(dir, 'results.jsonl');
        const lines: string[] = [];
        // Exceed the 256 KiB chunk boundary so multi-chunk tail seeking and carry handling execute.
        for (let i = 0; i < 4500; i++) {
            lines.push(JSON.stringify({ i, name: `Bot${i % 10}`, pad: 'x'.repeat(64) }));
        }
        lines.push('not-json');
        lines.push(JSON.stringify({ i: 4500, name: 'Last', pad: 'z' }));
        writeFileSync(file, lines.join('\r\n') + '\r\n');

        const tailed = tailLines(file, 250);
        expect(tailed).toHaveLength(250);
        expect(JSON.parse(tailed[0]!).i).toBe(4252);
        expect(JSON.parse(tailed[249]!).i).toBe(4500);

        const scanned: { i: number; name: string }[] = [];
        scanJsonlTail<{ i: number; name: string }>(file, 250, row => scanned.push(row));
        expect(scanned).toHaveLength(249);
        expect(scanned[0]!.i).toBe(4252);
        expect(scanned[scanned.length - 1]!.i).toBe(4500);
        expect(tailJsonlFile<{ i: number }>(file, 10).map(r => r.i)).toEqual([4492, 4493, 4494, 4495, 4496, 4497, 4498, 4499, 4500]);
    });

    test('readCachedMapBytes validates collision stat and MAP dimensions', () => {
        const dir = scratch();
        const collisionFile = join(dir, 'collision-data.json');
        const cacheFile = join(dir, 'dashboard-map.bin');
        writeFileSync(collisionFile, '{"zones":[],"tiles":[]}');
        const st = statSync(collisionFile);
        const map: MapSpec = { x0: 100, z0: 200, w: 8, h: 4, scale: 2 };
        const bytes = new Uint8Array(map.w * map.h);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 4;
        writeFileSync(cacheFile, encodeMapCache(bytes, st.size, st.mtimeMs, map));

        expect(readCachedMapBytes(cacheFile, collisionFile, map)).toEqual(bytes);
        expect(readCachedMapBytes(cacheFile, collisionFile, { ...map, w: 9 })).toBeNull();

        // Touch mtime to simulate a collision-data.json update.
        const nextSec = (st.mtimeMs + 5000) / 1000;
        utimesSync(collisionFile, nextSec, nextSec);
        expect(readCachedMapBytes(cacheFile, collisionFile, map)).toBeNull();
    });

    test('withoutClocksHashValue produces compact 64-hex digest invariant to epoch timestamps', () => {
        const a = { now: 1_780_000_000_000, bots: [{ name: 'Alpha', at: 1_780_000_001_000, hp: 50 }] };
        const b = { now: 1_780_000_060_000, bots: [{ name: 'Alpha', at: 1_780_000_061_000, hp: 50 }] };
        const c = { now: 1_780_000_060_000, bots: [{ name: 'Alpha', at: 1_780_000_061_000, hp: 49 }] };
        const ha = withoutClocksHashValue(a);
        const hb = withoutClocksHashValue(b);
        const hc = withoutClocksHashValue(c);
        expect(ha).toMatch(/^[a-f0-9]{64}$/);
        expect(ha).toBe(hb);
        expect(ha).not.toBe(hc);
        expect(pushDue(JSON.stringify(b), { stable: ha, at: 1_780_000_000_000 }, 1_780_000_060_000, hb)).toBe(false);
        expect(pushDue(JSON.stringify(c), { stable: ha, at: 1_780_000_000_000 }, 1_780_000_060_000, hc)).toBe(true);
    });

    test('compactExpiredOrderSummary preserves fleetSidesView state parity for v2 pending (open/half), failed, reconcile, and legacy orders', () => {
        const start = 1_780_000_000_000;
        const end = start + 600_000;
        const order = {
            id: 'ord-v2-parity',
            server: 'rs-sdk-demo.fly.dev',
            from: 'Giver',
            to: 'Taker',
            item: 'Coins',
            count: 1000,
            start,
            end,
        };
        const claim = '12345678-1234-1234-1234-123456789abc';
        const sha = 'a'.repeat(64);
        const mkV2 = (role: 'from' | 'to', state: 'prepared' | 'settled' | 'failed', at: number) => ({
            version: 2 as const,
            id: order.id,
            role,
            account: role === 'from' ? order.from : order.to,
            partner: role === 'from' ? order.to : order.from,
            side: 'local',
            server: order.server,
            item: order.item,
            requested: order.count,
            count: state === 'settled' ? order.count : 0,
            ok: state === 'settled',
            state,
            claim,
            at,
            detail: state,
            inventory: role === 'from'
                ? { before: 1000, after: state === 'settled' ? 0 : 1000 }
                : { before: 0, after: state === 'settled' ? 1000 : 0 },
            ...(role === 'to' && state === 'settled' ? { bank: { count: 1000, at: at - 500 } } : {}),
            logout: { attemptId: `${start}-1-1`, at: at - 100, sha256: sha },
        });

        const cases: Array<{ label: string; ord: any; recs: any[]; now: number; want: string }> = [
            // v2 pending -> open (prepared receipt while window open)
            { label: 'v2-pending-open', ord: order, recs: [mkV2('from', 'prepared', start + 10_000)], now: start + 20_000, want: 'open' },
            // v2 pending -> half (one terminal settled receipt while window open)
            { label: 'v2-pending-half', ord: order, recs: [mkV2('from', 'settled', start + 10_000)], now: start + 20_000, want: 'half' },
            // v2 expired -> failed (both terminal failed)
            { label: 'v2-expired-failed', ord: order, recs: [mkV2('from', 'failed', start + 10_000), mkV2('to', 'failed', start + 11_000)], now: end + 60_000, want: 'failed' },
            // v2 expired -> reconcile (one prepared or one settled past end)
            { label: 'v2-expired-reconcile', ord: order, recs: [mkV2('from', 'settled', start + 10_000)], now: end + 60_000, want: 'reconcile' },
            // v2 invalid order -> reconcile
            { label: 'v2-invalid-order', ord: { ...order, server: undefined }, recs: [mkV2('from', 'prepared', start + 10_000)], now: end + 60_000, want: 'reconcile' },
            // legacy expired -> failed, half, open
            { label: 'legacy-failed', ord: order, recs: [{ id: order.id, role: 'from', ok: false }], now: end + 60_000, want: 'failed' },
            { label: 'legacy-half', ord: order, recs: [{ id: order.id, role: 'from', ok: true }], now: end + 60_000, want: 'half' },
            { label: 'legacy-open', ord: order, recs: [], now: end + 60_000, want: 'open' },
        ];

        for (const c of cases) {
            const full = fleetSidesView([], [c.ord], c.now, c.recs).orders;
            const slim = compactExpiredOrderSummary(c.ord, c.recs, c.now);
            const compact = fleetSidesView([], [slim.order], c.now, slim.receipts).orders;
            expect(full, c.label).toHaveLength(1);
            expect(full[0]!.state, c.label).toBe(c.want);
            expect(compact, c.label).toEqual(full);
        }
    });
});
