import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetTradeClaim } from '../../core/src/fleet-trade-claim';
import { claimedOrderDeletions, droppedTradeClaims, fleetDataReader, keepClaimedOrders } from '../src/fleet-sync';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true }).trim();

const nonce = '031e494c-b42e-4ce8-908c-36b32c7e0ac8';
const claim = (orderId: string, phase: 'held' | 'released' = 'held'): FleetTradeClaim =>
    ({ account: 'woodenstaff', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId, role: 'from', nonce, phase, at: 1795587739966 });
// The order and the receipt of the trade whose claim stayed held after a sync deleted its order file.
const order = {
    id: 'xfer-1795587227524-3', server: 'rs-sdk-demo.fly.dev', from: 'Woodenstaff', to: 'Moneyshot', item: 'Ring of dueling(8)', count: 1, itemId: 2552,
    start: 1795587227524, end: 1795588127524, meet: [{ x: 3183, z: 3440, level: 0 }, { x: 3182, z: 3440, level: 0 }], takerWaits: true,
};
const receipt = {
    version: 2, state: 'reconcile', id: order.id, account: 'Woodenstaff', partner: 'Moneyshot', role: 'from', side: 'local', server: 'rs-sdk-demo.fly.dev',
    item: 'Ring of dueling(8)', requested: 1, claim: nonce, count: 0, ok: false, at: 1795588128004, detail: 'Error: order window ended during work',
    bank: { count: 1, at: 1795587749653 }, logout: { attemptId: '1795587743317-0000026384-0000000001', at: 1795588127992, sha256: 'c'.repeat(64) }, screen: false,
};

function fleetRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-claimed-orders-'));
    g(dir, 'init', '-q', '-b', 'fleet-data');
    for (const sub of ['orders', 'receipts']) mkdirSync(join(dir, 'fleet', sub), { recursive: true });
    return dir;
}
const put = (dir: string, path: string, value: unknown) => writeFileSync(join(dir, 'fleet', path), JSON.stringify(value, null, 1) + '\n');
const stagedDeletions = (dir: string) => g(dir, 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=D').split('\n').filter(Boolean);

test('only a deleted order that a held claim names is kept; with no claim list every deleted order is kept', () => {
    const deleted = ['fleet/orders/xfer-1795587227524-3.json', 'fleet/orders/1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21.json', 'fleet/receipts/xfer-1.from.json'];
    expect(claimedOrderDeletions(deleted, [claim('xfer-1795587227524-3')])).toEqual(['fleet/orders/xfer-1795587227524-3.json']);
    expect(claimedOrderDeletions(deleted, [claim('XFER-1795587227524-3')])).toEqual(['fleet/orders/xfer-1795587227524-3.json']);
    expect(claimedOrderDeletions(deleted, [claim('xfer-1795587227524-3', 'released')])).toEqual([]);
    expect(claimedOrderDeletions(deleted, [])).toEqual([]);
    expect(claimedOrderDeletions(deleted, null)).toEqual(deleted.slice(0, 2));
});

test('a sync puts back a deleted order file that a held claim names, also when git pairs the deletion with a new order as a rename', () => {
    const dir = fleetRepo();
    try {
        const withdrawn = { ...order, id: '1795584021244-dipstick-yewfirst-2ad00dbbd11b7d21', from: 'Dipstick', to: 'YewFirst' };
        put(dir, `orders/${order.id}.json`, order); put(dir, `orders/${withdrawn.id}.json`, withdrawn);
        g(dir, 'add', '--', 'fleet'); g(dir, 'commit', '-qm', 'orders');
        // The commit that lost the order: its file is gone, and a similar new order makes git show a rename (R056).
        unlinkSync(join(dir, 'fleet', 'orders', `${order.id}.json`)); unlinkSync(join(dir, 'fleet', 'orders', `${withdrawn.id}.json`));
        put(dir, 'orders/xfer-1795587767686-2.json', { ...order, id: 'xfer-1795587767686-2', from: 'Ballspinner', item: 'Fishing bait', count: 2 });
        g(dir, 'add', '--', 'fleet');
        expect(g(dir, 'diff', '--cached', '--name-status', '-M')).toContain('R');
        let reads = 0;
        expect(keepClaimedOrders(dir, () => { reads++; return [claim(order.id), claim(withdrawn.id, 'released')]; })).toEqual([`fleet/orders/${order.id}.json`]);
        expect(reads).toBe(1);
        expect(JSON.parse(readFileSync(join(dir, 'fleet', 'orders', `${order.id}.json`), 'utf8'))).toEqual(order);
        expect(stagedDeletions(dir)).toEqual([`fleet/orders/${withdrawn.id}.json`]);
        expect(existsSync(join(dir, 'fleet', 'orders', `${withdrawn.id}.json`))).toBe(false);
        // The claim refs cannot be read: every deleted order stays until a later sync can tell.
        expect(keepClaimedOrders(dir, () => { throw Error('ls-remote timed out'); })).toEqual([`fleet/orders/${withdrawn.id}.json`]);
        expect(stagedDeletions(dir)).toEqual([]);
        // No staged order deletion: the claim refs are not read.
        expect(keepClaimedOrders(dir, () => { reads++; return []; })).toEqual([]);
        expect(reads).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('the release rules read a deleted order from the commit before its deletion, and free the claim of a trade that never opened a screen', () => {
    const dir = fleetRepo();
    try {
        put(dir, `orders/${order.id}.json`, order);
        g(dir, 'add', '--', 'fleet'); g(dir, 'commit', '-qm', 'order');
        g(dir, 'rm', '-q', `fleet/orders/${order.id}.json`); g(dir, 'commit', '-qm', 'sync deletes the open order');
        put(dir, `receipts/${order.id}.from.json`, receipt);
        g(dir, 'add', '--', 'fleet'); g(dir, 'commit', '-qm', 'receipt');
        expect(() => g(dir, 'show', `HEAD:fleet/orders/${order.id}.json`)).toThrow();
        const read = fleetDataReader(dir);
        expect(read(`orders/${order.id}.json`)).toEqual(order);
        expect(read(`receipts/${order.id}.from.json`)).toEqual(receipt);
        expect(read('orders/never-published.json')).toBeNull();
        const held = claim(order.id);
        expect(droppedTradeClaims([held], 'local', read, order.end)).toEqual([held]);
        // The existing safety rules still hold the claim: the window is open, or the receipt shows a trade screen or a count.
        expect(droppedTradeClaims([held], 'local', read, order.end - 1)).toEqual([]);
        for (const changed of [{ screen: true }, { count: 1 }, { claim: 'a'.repeat(36) }]) {
            put(dir, `receipts/${order.id}.from.json`, { ...receipt, ...changed });
            g(dir, 'add', '--', 'fleet'); g(dir, 'commit', '-qm', 'receipt changed');
            expect(droppedTradeClaims([held], 'local', fleetDataReader(dir), order.end)).toEqual([]);
        }
        // A receipt that a commit deleted is not read from history: only an order is published one time.
        g(dir, 'rm', '-q', `fleet/receipts/${order.id}.from.json`); g(dir, 'commit', '-qm', 'receipt gone');
        expect(fleetDataReader(dir)(`receipts/${order.id}.from.json`)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
