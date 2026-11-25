import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha, validateSupplies } from '../packages/core/src/launch-evidence';
import { haggisActivities, haggisTravel, loadSnapshot, overallRequirementsFor, scheduleOverall, TRICKS } from '../packages/planner/src/haggis';
import { gateRequirements, overallWins, ownedFleetAccounts } from './haggis-gate';

const act = (id: string, evidence: string) => ({ id, evidence, source: 'test' }) as any;
const plan = (slack: number, order: { id: string; start: number; end: number; landsAt?: number; ticks?: number }[]) => ({
    order,
    boards: [
        { id: 'overall', deadline: 35_000, finish: 35_000 - slack, slack, status: slack > 0 ? 'WIN' : 'LATE' },
        { id: 'agility', deadline: 6_000, finish: 30_000, slack: -24_000, status: 'LATE' },
    ],
}) as any;

test('Overall alone gates the main launch; late skill boards do not', () => {
    expect(overallWins(plan(800, [{ id: 'a', start: 0, end: 10_000 }]), [act('a', 'MEASURED')])).toContain('Overall wins by 800');
});

test('Overall needs a 2% margin', () => {
    expect(() => overallWins(plan(500, []), [])).toThrow('700-tick margin');
    expect(() => overallWins(plan(-5_000, []), [])).toThrow('margin');
});

test('activities that start before the Overall finish need MEASURED inputs, also one still running then', () => {
    const order = [{ id: 'a', start: 0, end: 10_000 }, { id: 'b', start: 10_000, end: 20_000 }, { id: 'late', start: 34_300, end: 90_000 }];
    const acts = [act('a', 'MEASURED'), act('b', 'ESTIMATE'), act('late', 'CODE-READ')];
    expect(() => overallWins(plan(800, order), acts)).toThrow('1 activities before Overall lack MEASURED inputs: b');
    expect(overallWins(plan(800, order.filter(p => p.id !== 'b')), acts)).toContain('with measured inputs');
    // Overall finishes at 34,200, inside this activity: its rate sets the finish, so it gates the launch.
    expect(() => overallWins(plan(800, [{ id: 'last', start: 30_000, end: 90_000 }]), [act('last', 'ESTIMATE')])).toThrow('lack MEASURED inputs: last');
});

test('overallWins ignores unmeasured inactive patches and 0-tick no-ops, while still gating background and absorbed activities', () => {
    const withInactivePatch = {
        ...act('a', 'MEASURED'),
        patches: [{ lever: 'unused', set: { ticks: { floor: 1, realistic: 1, evidence: 'ESTIMATE' } } }],
    };
    const noopAct = act('noop', 'CODE-READ');
    const bgAct = act('bg', 'ESTIMATE');
    const guestAct = act('guest', 'CODE-READ');
    const acts = [withInactivePatch, noopAct, bgAct, guestAct];
    expect(overallWins(plan(800, [
        { id: 'a', start: 0, end: 10_000, landsAt: 10_000, ticks: 10_000 },
        { id: 'noop', start: 10_000, end: 10_000, landsAt: 10_000, ticks: 0 },
    ]), acts)).toContain('with measured inputs');
    expect(() => overallWins(plan(800, [
        { id: 'a', start: 0, end: 10_000, landsAt: 10_000, ticks: 10_000 },
        { id: 'bg', start: 10_000, end: 10_000, landsAt: 10_022, ticks: 0 },
    ]), acts)).toThrow('lack MEASURED inputs: bg');
    expect(() => overallWins(plan(800, [
        { id: 'a', start: 0, end: 10_000, landsAt: 10_000, ticks: 10_000 },
        { id: 'guest', start: 0, end: 10_000, landsAt: 10_000, ticks: 0 },
    ]), acts)).toThrow('lack MEASURED inputs: guest');
});

test('ownedFleetAccounts includes owners.json accounts while excluding main and reserved specialists', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'haggis-gate-owners-'));
    try {
        mkdirSync(join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet'), { recursive: true });
        writeFileSync(join(tempRoot, '.practice', 'live', 'fleet-data', 'fleet', 'owners.json'), JSON.stringify({
            accounts: {
                SporranDip: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                CloudCoin: { side: 'cloud', server: 'rs-sdk-demo.fly.dev' },
                LocalPract: { side: 'local', server: 'localhost:8888' },
                haggis: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
                tipmyshaft: { side: 'local', server: 'rs-sdk-demo.fly.dev' },
            },
        }));
        const owned = ownedFleetAccounts(tempRoot);
        const lower = new Set(owned.map(n => n.toLowerCase()));
        expect(lower.has('sporrandip')).toBe(true);
        expect(lower.has('cloudcoin')).toBe(true);
        expect(lower.has('localpract')).toBe(false);
        expect(lower.has('haggis')).toBe(false);
        expect(lower.has('tipmyshaft')).toBe(false);
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('gateRequirements resolves unf potions and mort myre fungus, expands varrock teleport runes, and deduplicates wine', () => {
    const root = resolve(import.meta.dir, '..');
    const catalog = JSON.parse(readFileSync(join(root, 'knowledge', 'items.json'), 'utf8')) as { id: number; name: string; debugname?: string }[];
    const snapshot = loadSnapshot(join(root, 'research', 'hiscores-live.json'));
    const activities = haggisActivities();
    const opts = { mode: 'realistic' as const, tricks: new Set(TRICKS), travel: haggisTravel() };
    const plan = scheduleOverall(snapshot, activities, opts);
    const raw = overallRequirementsFor(activities, opts, plan).supplies;
    const reqs = gateRequirements(raw, catalog);

    expect(reqs.some(r => r.item.toLowerCase().includes('varrock teleport'))).toBe(false);
    const wineRows = reqs.filter(r => r.itemId === 1995 || r.item.toLowerCase().includes('unfermented wine'));
    expect(wineRows).toHaveLength(1);
    expect(wineRows[0]!.count).toBe(600);
    expect(reqs.find(r => r.item === 'guam potion (unf)')?.itemId).toBe(91);
    expect(reqs.find(r => r.item === 'torstol potion (unf)')?.itemId).toBe(111);
    expect(reqs.find(r => r.item === 'mort myre fungus')?.itemId).toBe(2970);

    // Every normalized requirement resolves to an exact catalog match accepted by validateSupplies.
    const firstIdByName = new Map<string, number>();
    for (const i of catalog) {
        const keyName = i.name.trim().toLowerCase();
        if (!firstIdByName.has(keyName)) firstIdByName.set(keyName, i.id);
    }
    const pooled = new Map<string | number, { itemId: number; item: string; count: number }>();
    for (const r of reqs) {
        const keyName = r.item.trim().toLowerCase().replace(/\s*\(noted\)$/, '').replace(/^feathers$/, 'feather').replace(/^headless arrows$/, 'headless arrow');
        const id = r.itemId ?? firstIdByName.get(keyName);
        expect(id).toBeDefined();
        const k = r.itemId ?? keyName;
        const prev = pooled.get(k);
        pooled.set(k, { itemId: id!, item: r.item, count: (prev?.count ?? 0) + r.count });
    }
    const now = 1_700_000_000_000;
    const bankItems = [...pooled.values()].map(x => ({ id: x.itemId, count: x.count }));
    const refs = new Map<string, any>([
        ['bank.json', { name: 'SporranDip', server: 'rs-sdk-demo.fly.dev', bankAt: now - 1_000, bank: bankItems }],
        ['delivery.json', { ok: true, observed: true, server: 'rs-sdk-demo.fly.dev', from: 'CoinCock', to: 'SporranDip', at: now - 2_000, before: [], after: bankItems, items: bankItems }],
    ]);
    const manifest = {
        version: 2,
        context: 'ctx-1',
        at: now - 500,
        allocations: [...pooled.values()].map(x => ({
            item: x.item,
            itemId: x.itemId,
            count: x.count,
            holder: 'SporranDip',
            recipient: 'haggis',
            bank: { path: 'bank.json', sha256: sha(JSON.stringify(refs.get('bank.json'))) },
            delivery: { path: 'delivery.json', sha256: sha(JSON.stringify(refs.get('delivery.json'))) },
        })),
    };
    expect(() => validateSupplies(manifest, 'ctx-1', reqs, catalog, ['SporranDip', 'CoinCock'], now, ref => refs.get(ref.path))).not.toThrow();
});
