import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetTradeClaim } from '../../core/src/fleet-trade-claim';
import { claimedOrderDeletions, droppedTradeClaims, fleetDataReader, keepClaimedOrders, strandedTradePairs } from '../src/fleet-sync';

const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'core.autocrlf=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, windowsHide: true }).trim();

const nonce = '031e494c-b42e-4ce8-908c-36b32c7e0ac8';
const claim = (orderId: string, phase: 'held' | 'released' = 'held'): FleetTradeClaim =>
    ({ account: 'woodenstaff', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId, role: 'from', nonce, phase, at: 1795587739966 });
// An order and the receipt of its giver: reconcile, count 0, no trade screen, and a logout after the claim.
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
        // Both order files are gone from the worktree, and a similar new order makes git show a rename.
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
        // The claim refs cannot be read: every deleted order stays until a later sync can tell. The commit holds no
        // deletion, and the worktree keeps the withdrawal for that later sync.
        expect(keepClaimedOrders(dir, () => { throw Error('ls-remote timed out'); })).toEqual([`fleet/orders/${withdrawn.id}.json`]);
        expect(stagedDeletions(dir)).toEqual([]);
        expect(existsSync(join(dir, 'fleet', 'orders', `${withdrawn.id}.json`))).toBe(false);
        // No staged order deletion: the claim refs are not read.
        expect(keepClaimedOrders(dir, () => { reads++; return []; })).toEqual([]);
        expect(reads).toBe(1);
        // The next sync stages the withdrawal again and reads the claims: no held claim names it, so it is published.
        g(dir, 'add', '--', 'fleet');
        expect(keepClaimedOrders(dir, () => { reads++; return []; })).toEqual([]);
        expect(reads).toBe(2);
        expect(stagedDeletions(dir)).toEqual([`fleet/orders/${withdrawn.id}.json`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test('a giver whose worker died while prepared, with a partner that never came, is freed an hour after the window', () => {
    // The order and receipt of a giver whose worker died in a PC restart before it could write `reconcile`.
    const dead = {
        id: '1795585630736-abracadickra-yewfirst-5d60afd40f4184f9', server: 'rs-sdk-demo.fly.dev', from: 'Abracadickra', to: 'YewFirst',
        item: 'Rune arrowtips', count: 64, start: 1795585630736, end: 1795589230736,
        meet: [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }],
    };
    const own = {
        version: 2, state: 'prepared', id: dead.id, account: 'Abracadickra', partner: 'YewFirst', role: 'from', side: 'local',
        server: 'rs-sdk-demo.fly.dev', item: 'Rune arrowtips', requested: 64, claim: nonce, count: 0, ok: false, at: 1795585966940, detail: 'trade claimed',
    };
    const held: FleetTradeClaim = { account: 'abracadickra', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId: dead.id, role: 'from', nonce, phase: 'held', at: 1795585963756 };
    const HOUR = 60 * 60_000;
    const files = (extra: Record<string, unknown> = {}) => (p: string) => ({
        'owners.json': { accounts: { Abracadickra: { side: 'local' }, YewFirst: { side: 'local' } } },
        [`orders/${dead.id}.json`]: dead,
        [`receipts/${dead.id}.from.json`]: own,
        ...extra,
    } as Record<string, unknown>)[p] ?? null;
    expect(droppedTradeClaims([held], 'local', files(), dead.end + HOUR)).toEqual([held]);
    // The worker can still be alive: the window ended less than an hour ago.
    expect(droppedTradeClaims([held], 'local', files(), dead.end + HOUR - 1)).toEqual([]);
    // The partner came: it wrote its own receipt when it took its claim.
    expect(droppedTradeClaims([held], 'local', files({ [`receipts/${dead.id}.to.json`]: { ...own, role: 'to', account: 'YewFirst', partner: 'Abracadickra' } }), dead.end + HOUR)).toEqual([]);
    // A partner of another side whose fleet data is not published after the window can still have a receipt on its way.
    const crossSide = files({ 'owners.json': { accounts: { Abracadickra: { side: 'local' }, YewFirst: { side: 'cloud' } } }, 'snapshots/cloud.json': { at: dead.end } });
    expect(droppedTradeClaims([held], 'local', crossSide, dead.end + HOUR)).toEqual([]);
    // The receipt shows a count or a changed stack: something can have moved.
    expect(droppedTradeClaims([held], 'local', files({ [`receipts/${dead.id}.from.json`]: { ...own, count: 1 } }), dead.end + HOUR)).toEqual([]);
    expect(droppedTradeClaims([held], 'local', files({ [`receipts/${dead.id}.from.json`]: { ...own, inventory: { before: 64, after: 0 } } }), dead.end + HOUR)).toEqual([]);
});

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

test('both parties of an order whose workers died while prepared are freed together an hour after the window', () => {
    // Order xfer-1795644882874-1: both workers died in a PC restart after they took their claims.
    const stuck = {
        id: 'xfer-1795644882874-1', server: 'rs-sdk-demo.fly.dev', from: 'Shaftmaker', to: 'Swordswallow', item: 'Coins', count: 60, itemId: 995,
        start: 1795644882874, end: 1795645782874, meet: [{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }], takerWaits: true,
    };
    const giverNonce = '476a58f5-ce3e-4017-9edd-46bbbfcca812', takerNonce = '5a4538f1-9c06-4cf5-bb6b-54d6b1063cbd';
    const prepared = (role: 'from' | 'to', account: string, partner: string, claimNonce: string, at: number) => ({
        version: 2, state: 'prepared', id: stuck.id, account, partner, role, side: 'local', server: 'rs-sdk-demo.fly.dev',
        item: 'Coins', requested: 60, claim: claimNonce, count: 0, ok: false, at, detail: 'trade claimed',
    });
    const giver: FleetTradeClaim = { account: 'shaftmaker', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId: stuck.id, role: 'from', nonce: giverNonce, phase: 'held', at: 1795645246775, host: 'PC', pid: 32508, checkout: 'main' };
    const taker: FleetTradeClaim = { account: 'swordswallow', server: 'rs-sdk-demo.fly.dev', side: 'local', orderId: stuck.id, role: 'to', nonce: takerNonce, phase: 'held', at: 1795645259612, host: 'PC', pid: 17852, checkout: 'main' };
    const takerReceipt = prepared('to', 'Swordswallow', 'Shaftmaker', takerNonce, 1795645263537);
    const files = (extra: Record<string, unknown> = {}) => (p: string) => (({
        [`orders/${stuck.id}.json`]: stuck,
        [`receipts/${stuck.id}.from.json`]: prepared('from', 'Shaftmaker', 'Swordswallow', giverNonce, 1795645249863),
        [`receipts/${stuck.id}.to.json`]: takerReceipt,
        ...extra,
    } as Record<string, unknown>)[p] ?? null);
    const HOUR = 60 * 60_000, after = stuck.end + HOUR, dead = () => false;
    const pairs = (claims: FleetTradeClaim[], read = files(), now = after, alive: (pid: number, at: number) => boolean = dead, host = 'PC') =>
        strandedTradePairs(claims, 'local', read, now, host, alive);

    expect(pairs([giver, taker])).toEqual([[giver, taker]]);
    expect(pairs([taker, giver])).toEqual([[giver, taker]]);
    // The existing rule keeps each claim: the partner's receipt is not a failed one.
    expect(droppedTradeClaims([giver, taker], 'local', files(), after)).toEqual([]);

    // The window ended less than an hour ago.
    expect(pairs([giver, taker], files(), after - 1)).toEqual([]);
    // A worker still runs, or the claim was taken on another host, where its process cannot be checked.
    expect(pairs([giver, taker], files(), after, pid => pid === 17852)).toEqual([]);
    expect(pairs([giver, taker], files(), after, dead, 'OTHER')).toEqual([]);
    expect(pairs([giver, { ...taker, pid: undefined }])).toEqual([]);
    // Only one party holds a claim, or a claim is of another side.
    expect(pairs([giver])).toEqual([]);
    expect(pairs([giver, { ...taker, side: 'cloud' }])).toEqual([]);
    // A receipt that is not the claim's own `prepared` record: a newer claim, or a worker that wrote its end.
    expect(pairs([giver, { ...taker, nonce: 'aaaaaaaa-0000-4000-8000-000000000000' }])).toEqual([]);
    for (const changed of [{ state: 'reconcile' }, { count: 60 }, { inventory: { before: 0, after: 60 } }, { logout: { attemptId: '1', at: 1, sha256: 'c'.repeat(64) } }]) {
        expect(pairs([giver, taker], files({ [`receipts/${stuck.id}.to.json`]: { ...takerReceipt, ...changed } }))).toEqual([]);
    }
    expect(pairs([giver, taker], files({ [`receipts/${stuck.id}.to.json`]: null }))).toEqual([]);
    // The order is gone from fleet data.
    expect(pairs([giver, taker], files({ [`orders/${stuck.id}.json`]: null }))).toEqual([]);
});
