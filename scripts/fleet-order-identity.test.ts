import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeOrder, writeFleetOrder } from './fleet-order';
import { validOrder } from './fleet-trade-settlement';

const server = 'rs-sdk-demo.fly.dev';
const owners = new Map([['abcdefghijkl', { side: 'local', server }], ['mnopqrstuvwx', { side: 'cloud', server }]]);
const order = (count = 1, now = 1_000_000) => makeOrder('Abcdefghijkl', 'Mnopqrstuvwx', count, 'Coins', now, 0, 1, owners);

test('orders for the same parties and start retain independent claim and receipt identities', () => {
    const first = order(1), second = order(2);
    expect(first.start).toBe(second.start);
    expect(first.id).not.toBe(second.id);
    for (const made of [first, second, order(1, Number.MAX_SAFE_INTEGER - 60_000), order(1, -Number.MAX_SAFE_INTEGER)]) {
        expect(validOrder(made)).toBe(true);
        expect(made.id.length).toBeLessThanOrEqual(64);
        expect(made.id).toMatch(/^[a-z0-9_-]+$/);
    }
});

test('order publication preserves both same-window orders and refuses to replace an existing identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-order-identity-'));
    try {
        const first = order(1), second = order(2), file = writeFleetOrder(directory, first);
        writeFleetOrder(directory, second);
        const original = readFileSync(file, 'utf8');
        expect(JSON.parse(original)).toEqual(first);
        expect(() => writeFleetOrder(directory, { ...second, id: first.id })).toThrow();
        expect(readFileSync(file, 'utf8')).toBe(original);
        expect(readdirSync(directory).sort()).toEqual([`${first.id}.json`, `${second.id}.json`].sort());
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('independent publishers cannot overwrite one another under the same order identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fleet-order-publish-'));
    try {
        const orders = join(directory, 'orders'), worker = join(directory, 'publish.ts'), first = order(1), second = { ...order(2), id: first.id };
        const module = resolve(import.meta.dir, 'fleet-order.ts');
        writeFileSync(worker, `import {writeFleetOrder} from ${JSON.stringify(module)};
const [directory, raw] = process.argv.slice(2);
try { writeFleetOrder(directory!, JSON.parse(raw!)); }
catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') process.exit(3); throw error; }
`);
        const publishers = [first, second].map(made => Bun.spawn([process.execPath, worker, orders, JSON.stringify(made)], {
            windowsHide: true, stdout: 'ignore', stderr: 'pipe', timeout: 10_000,
        }));
        const results = await Promise.all(publishers.map(async child => ({ exit: await child.exited, error: await new Response(child.stderr).text() })));
        expect(results.map(result => result.exit).sort()).toEqual([0, 3]);
        expect(results.map(result => result.error)).toEqual(['', '']);
        const saved = JSON.parse(readFileSync(join(orders, `${first.id}.json`), 'utf8'));
        expect(saved).toEqual(results[0]!.exit === 0 ? first : second);
        expect(readdirSync(orders)).toEqual([`${first.id}.json`]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
}, 15_000);
