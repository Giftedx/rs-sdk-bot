import { afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { botWork } from '../../core/src/bot';
import type { Session } from '../../core/src/inprocess';
import { loadPathfinding } from '../../core/src/pathcache';
import { intentForEntry } from '../../planner/src/progression-catalog';
import {
    assertCoinReserveRefusal,
    coinChildConfiguration,
    coinProofAccountEnv,
    coinProofEndpoints,
    coinProofSource,
    coinRegistrationArgs,
    prepareCoinProofRoot,
    removeCoinProofRoot,
    selectCoinProofEndpoints,
    startCoinProofStack,
} from '../../practice/src/coin-courier-proof';
import { isNoProgressFailure, supervise } from '../../practice/src/supervise';
import {
    BANK_MEETS,
    LUMBRIDGE_TO_DRAYNOR,
    awaitCollectionOffer,
    checkTransferAccounts,
    coinTradeObservation,
    collectHandoff,
    courierCargo,
    courierDeliveryWaiting,
    courierFoodAllocation,
    courierIslandProblem,
    courierRecord,
    createHandoff,
    deliveryRecipientAtBank,
    deliveryResume,
    draynorApproach,
    exactCoinDelta,
    featherBatchAmount,
    featherPurchaseAmount,
    featherPurchaseEffect,
    foodDeficit,
    foodRestockAmount,
    fundingRequestValid,
    handoffCreditMatches,
    heldItems,
    meetingTiles,
    noteCourierOwned,
    noteCourierPreflight,
    onKaramja,
    outboundStart,
    parseCoins,
    parseFanin,
    parseFanout,
    prepareCoinSlot,
    receiveHandoff,
    requestCourierFunding,
    retainedTrout,
    selectFoodSource,
    sendHandoff,
    separateTroutNotes,
    serviceCourierFunding,
    type SeparationDeps,
} from '../src/logistics';

const ROOT = resolve(import.meta.dir, '../../..');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

beforeAll(async () => { await loadPathfinding(); }, 120_000);

// --- Coin Courier & Proof Integration ---

test('the session record of each courier account maps to the finite transfer intent', () => {
    const argv = ['Donor', 'Receiver', '45000', '--reserve=5001'], record = courierRecord({ donor: 'Donor', receiver: 'Receiver' }, argv, {});
    for (const name of ['Donor', 'Receiver']) {
        const work = botWork(name, record);
        expect(intentForEntry(work.script, work.args, work.env)).toEqual({
            kind: 'service',
            objective: 'finite owned coin transfer Donor -> Receiver: 45000 coins; donor bank reserve 5001',
        });
    }
});

test('full donor banks an unrelated item before exact 45000-coin withdrawal', async () => {
    let pack = [{ id: 1446, name: 'Body talisman', count: 1, slot: 0 },
        ...Array.from({ length: 27 }, (_, slot) => ({ id: 1436, name: 'Rune essence', count: 1, slot: slot + 1 }))];
    const bank = [{ id: 995, name: 'Coins', count: 50000 }];
    let generation = 1, deposits = 0;
    const session = {
        name: 'Giver', tick: () => generation, sdk: { getInventory: () => pack, getState: () => ({ inventory: pack }) },
        bankObservation: () => ({ generation, items: bank }),
        bot: {
            depositItem: async (item: typeof pack[number], amount: number) => {
                expect(item.id).toBe(1446); expect(amount).toBe(-1); deposits++;
                pack = pack.filter(i => i.id !== item.id); bank.push({ id: item.id, name: item.name, count: 1 }); generation++;
                return { success: true };
            },
            withdrawItem: async (_item: RegExp, amount: number) => {
                if (pack.length >= 28 && !pack.some(i => i.id === 995)) throw Error('no inventory space');
                bank[0]!.count -= amount; pack.push({ id: 995, name: 'Coins', count: amount, slot: 0 }); generation++;
            },
        },
    } as unknown as Session;
    await prepareCoinSlot(session, () => {});
    expect(pack.length).toBe(27);
    expect(bank.find(i => i.id === 1446)?.count).toBe(1);
    const before = { bank: bank[0]!.count, pack: 0 };
    await session.bot.withdrawItem(/^Coins$/, 45000);
    expect(bank[0]!.count).toBe(before.bank - 45000);
    expect(pack.find(i => i.id === 995)?.count).toBe(45000);
    expect(pack.filter(i => i.id === 1436).length).toBe(27);
    await prepareCoinSlot(session, () => {});
    expect(deposits).toBe(1);
});

test('trade diagnostics retain unreachable counter geometry and missing entry evidence', () => {
    const trade = { isOpen: false, screen: null, partner: null, myAccepted: false, partnerAccepted: false, myOffer: [], theirOffer: [] };
    const session = {
        name: 'Giver', tick: () => 30,
        bankObservation: () => ({ generation: 3, items: [{ id: 995, count: 37655 }] }),
        sdk: {
            getState: () => ({ player: { worldX: 3186, worldZ: 3437, level: 0 }, bank: { isOpen: false }, secret: 'do not log' }),
            getInventory: () => [{ id: 995, count: 12354 }, { id: 1265, count: 1 }],
            getTradeState: () => trade,
            findNearbyPlayer: (pattern: RegExp) => {
                expect(pattern.test('Taker')).toBe(true); expect(pattern.test('Taker2')).toBe(false);
                return { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false };
            },
        },
    } as unknown as Session;
    expect(coinTradeObservation(session, 'Taker')).toEqual({
        account: 'Giver', tick: 30, position: { x: 3186, z: 3437, level: 0 },
        partner: { name: 'Taker', index: 1, x: 3185, z: 3436, distance: 1, reachable: false },
        bankOpen: false, bank: { generation: 3, coins: 37655 }, pack: 12354, trade,
    });
    const missing = { name: 'Giver', tick: () => 0, sdk: { getState: () => null, getInventory: () => [], findNearbyPlayer: () => null, getTradeState: () => ({ isOpen: false }) } } as unknown as Session;
    expect(coinTradeObservation(missing, 'Taker')).toMatchObject({ position: null, partner: null, bankOpen: null, bank: null, pack: 0 });
});

test('parseCoins validates CLI, shared bank, reserve bounds, and rejections before login', () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    expect(c.amount).toBe(2000000); expect(c.reserve).toBe(0); expect([c.x, c.z]).toEqual([3185, 3436]);
    for (const reserve of [0, 5000, 2147483647]) expect(parseCoins(['Giver', 'Taker', '1', `--reserve=${reserve}`]).reserve).toBe(reserve);
    for (const reserve of ['-1', '1.5', 'NaN', 'Infinity', '2147483648', '', '1e3', '1=2']) expect(() => parseCoins(['Giver', 'Taker', '1', `--reserve=${reserve}`])).toThrow();
    expect(() => parseCoins(['Giver', 'Taker', '1', '--reserve'])).toThrow();
    expect(() => parseCoins(['Giver', 'Taker', '1', '--reserve=0', '--reserve=5000'])).toThrow();
    for (const amount of ['0', '-1', '1.5', 'NaN', '2147483648']) expect(() => parseCoins(['Giver', 'Taker', amount])).toThrow();
    expect(() => parseCoins(['Giver', 'giver', '1'])).toThrow();
    expect(() => parseCoins(['Haggis', 'Taker', '1'])).toThrow();
    expect(() => parseCoins(['Giver', 'Taker', '1', '--notes'])).toThrow();
});

test('meeting tiles are adjacent public floor joined to the bank tile, off the booth counter', async () => {
    const c = parseCoins(['Pocketpython', 'Abracadickra', '2000000']);
    const [a, b] = meetingTiles(c)!;
    expect(Math.abs(a.x - b.x) + Math.abs(a.z - b.z)).toBe(1);
    expect([a, b].every(t => t.level === 0 && t.x <= 3184)).toBe(true);
    expect(meetingTiles({ x: 3253, z: 3420 })).toBeNull();
    const pf: any = await import('../../../vendor/rs-sdk/sdk/pathfinding');
    pf.initPathfinding();
    const joined = (from: { x: number; z: number }, to: { x: number; z: number }) => pf.findLongPath(0, from.x, from.z, to.x, to.z, 500)?.at(-1);
    for (const t of [a, b]) {
        expect(pf.isTileWalkable(0, t.x, t.z)).toBe(true);
        expect(joined({ x: c.x, z: c.z }, t)).toMatchObject({ x: t.x, z: t.z });
    }
    expect(joined(a, b)).toMatchObject({ x: b.x, z: b.z });
    expect(joined({ x: 3186, z: 3437 }, a)).not.toMatchObject({ x: a.x, z: a.z });
    const travel = JSON.parse(readFileSync(join(ROOT, 'packages', 'planner', 'src', 'haggis-travel.json'), 'utf8')).banks;
    for (const { x, z } of Object.values<{ x: number; z: number }>(travel)) expect(meetingTiles({ x, z })).not.toBeNull();
    for (const row of BANK_MEETS) {
        const [p, q] = row.meet;
        expect(Math.abs(p.x - q.x) + Math.abs(p.z - q.z)).toBe(1);
        for (const t of row.meet) {
            expect(pf.isTileWalkable(0, t.x, t.z)).toBe(true);
            for (const [bx, bz] of row.tiles) expect(joined({ x: bx, z: bz }, t)).toMatchObject({ x: t.x, z: t.z });
        }
        expect(joined(p, q)).toMatchObject({ x: q.x, z: q.z });
    }
    expect(meetingTiles({ x: 3185, z: 3440 })).toEqual(meetingTiles({ x: 3185, z: 3436 }));
    expect(meetingTiles({ x: 2618, z: 3332 })).toEqual([{ x: 2618, z: 3333, level: 0 }, { x: 2617, z: 3333, level: 0 }]);
    expect(meetingTiles({ x: 3092, z: 3243 })).toEqual([{ x: 3093, z: 3243, level: 0 }, { x: 3093, z: 3244, level: 0 }]);
    expect(new Set(BANK_MEETS.map(r => r.bank)).size).toBe(BANK_MEETS.length);
}, 60000);

test('exactCoinDelta matches deltas, retains pocket coins, and enforces donor bank reserve', () => {
    const before = [{ bank: 3000, pack: 9 }, { bank: 50, pack: 7 }], after = [{ bank: 2000, pack: 9 }, { bank: 1050, pack: 7 }];
    expect(exactCoinDelta(before, after, 1000)).toBe(true);
    expect(exactCoinDelta(before, [{ bank: 2000, pack: 9 }, { bank: 50, pack: 1007 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [{ bank: 1999, pack: 10 }, after[1]!], 1000)).toBe(false);
    expect(exactCoinDelta(before, [after[0]!, { bank: 1051, pack: 6 }], 1000)).toBe(false);
    expect(exactCoinDelta(before, [], 1000)).toBe(false);
    expect(exactCoinDelta(before, after, 1000, 2000)).toBe(true);
    expect(exactCoinDelta(before, after, 1000, 2001)).toBe(false);
    for (const reserve of [-1, NaN, Infinity, 1.5, 2147483648]) expect(exactCoinDelta(before, after, 1000, reserve)).toBe(false);
    expect(exactCoinDelta(before, [{ bank: 2000, pack: 10 }, after[1]!], 1000, 2000)).toBe(false);
});

test('owned coin endpoints reach the stack, new profiles, registration and every worker child', async () => {
    const checked: number[] = [], samples = [0, 0.01];
    const p = selectCoinProofEndpoints(port => { checked.push(port); return port !== 20003; }, () => samples.shift()!);
    expect(checked).toEqual([20000, 20001, 20002, 20003, 20200, 20201, 20202, 20203]);
    expect(p.ports).toEqual({ engine: 20200, gateway: 20201, management: 20202, tcp: 20203 });
    expect(p.instance).toMatch(/^coin-[a-z0-9-]{1,25}$/);
    const original = 'SERVER=localhost:8888\r\nGATEWAY_URL=ws://localhost:7780\r\nPASSWORD=fixture\r\n';
    const configured = coinProofAccountEnv(original, p);
    expect(configured).toContain(`SERVER=${p.server}\r\n`);
    expect(configured).toContain(`GATEWAY_URL=${p.gateway}\r\n`);
    expect(configured).toContain('PASSWORD=fixture\r\n');
    expect(() => coinProofAccountEnv(original.replace('localhost:8888', 'rs-sdk-demo.fly.dev'), p)).toThrow('new practice account required');
    const previous = Object.fromEntries(Object.keys(p.env).map(k => [k, process.env[k]]));
    let stops = 0;
    const owned = { logs: { engine: '', gateway: '' }, stop: async () => { stops++; } };
    const stack = await startCoinProofStack(p, async opts => {
        expect(opts).toEqual({ ports: p.ports, instance: p.instance, tickMs: 150, xpRate: 25, readyTimeoutMs: 60000 });
        for (const [k, v] of Object.entries(p.env)) expect(process.env[k]).toBe(v);
        return owned;
    });
    expect(stack).toBe(owned); await stack.stop(); expect(stops).toBe(1);
    expect(Object.fromEntries(Object.keys(p.env).map(k => [k, process.env[k]]))).toEqual(previous);
    await expect(startCoinProofStack(p, async () => { throw Error('startup refused'); })).rejects.toThrow('startup refused');
    expect(Object.fromEntries(Object.keys(p.env).map(k => [k, process.env[k]]))).toEqual(previous);
    const registration = coinRegistrationArgs('fixture', p);
    expect(registration[0]).toBe('--eval');
    expect(registration[1]).toContain(JSON.stringify(p.server));
    expect(registration[1]).toContain(JSON.stringify(p.gateway));
    expect(registration[1]).toContain('registerCoinProofAccount(');
    expect(registration[1]).not.toContain('openBot(');
    for (const args of [registration, ['scripts/aio-logistics.ts', 'donor', 'coin-courier', 'receiver', '12345']]) {
        const child = coinChildConfiguration(args, { CAP: '1600' }, p, { GATEWAY_URL: 'ws://localhost:7780', WEB_MANAGEMENT_PORT: '8898', ENGINE_MANAGEMENT_URL: 'http://localhost:8898', NODE_PORT: '43594', GE_DATABASE: 'data/market.sqlite' });
        expect(child.cmd).toEqual(['bun', ...args]);
        expect(child.env).toMatchObject({ ...p.env, GATEWAY_URL: p.gateway, DEMO_OK: '', RANDOM_EVENTS: '0', CAP: '1600' });
        expect(child.env.GE_DATABASE).toBe(`data/market-${p.instance}.sqlite`);
        expect(child.env.ENGINE_MANAGEMENT_URL).toBe(`http://127.0.0.1:${p.ports.management}`);
        expect(child.windowsHide).toBe(true);
    }
    expect(() => selectCoinProofEndpoints(() => false, () => 0)).toThrow('owned practice ports unavailable');
});

test('coin proof isolates real ownership files and profiles while keeping the worker guards', () => {
    const base = makeTempDir('coin-proof-root-'), source = join(base, 'source');
    let scratch = '';
    const put = (path: string, text: string) => { const target = join(source, path); mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, text); };
    try {
        for (const path of [
            'scripts/aio-logistics.ts',
            'packages/workers/src/logistics/trade.ts',
            'packages/workers/src/logistics/trade-helpers.ts',
            'packages/workers/src/logistics/admission.ts',
            'packages/workers/src/logistics/module.ts',
            'packages/workers/test/logistics.test.ts',
            'packages/practice/src/coin-courier-proof.ts',
            'packages/practice/src/replay-root.ts',
        ]) put(path, 'fixture ' + path);
        put('swarm.json', JSON.stringify({ maxBots: 2, jobs: [{ account: 'Donor', enabled: true }] }));
        put('.practice/coordinator/state.json', JSON.stringify({ version: 1, tasks: [{ status: 'running', runId: 'other', spec: { account: 'Donor' } }] }));
        put('vendor/rs-sdk/bots/LiveActor/marker', 'private live profile'); put('vendor/rs-sdk/bots/create-bot.ts', 'creator');
        put('vendor/rs-sdk/bots/_template/marker', 'template'); put('vendor/rs-sdk/bots/_template/bot.env', 'PASSWORD={{PASSWORD}}\n'); put('vendor/rs-sdk/sdk/marker', 'sdk');
        put('fleet/owners.json', JSON.stringify({ accounts: { Donor: { side: 'cloud' } } }));
        scratch = prepareCoinProofRoot(source, base);
        expect(coinProofSource(scratch)).toBe(coinProofSource(source));
        for (const path of ['scripts/aio-logistics.ts', 'packages/practice/src/replay-root.ts']) {
            const copied = join(scratch, path), workerText = readFileSync(copied, 'utf8'); writeFileSync(copied, workerText + ' changed');
            expect(coinProofSource(scratch)).not.toBe(coinProofSource(source)); writeFileSync(copied, workerText);
        }
        expect(lstatSync(join(scratch, '.practice')).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(scratch, 'vendor/rs-sdk/bots')).isSymbolicLink()).toBe(false);
        expect(existsSync(join(scratch, 'vendor/rs-sdk/bots/LiveActor'))).toBe(false);
        expect(JSON.parse(readFileSync(join(scratch, 'swarm.json'), 'utf8')).jobs).toEqual([]);
        expect(JSON.parse(readFileSync(join(scratch, '.practice/coordinator/state.json'), 'utf8'))).toEqual({ version: 1, tasks: [] });
        const io = { owned: () => new Set(['donor']), logoutState: () => 'confirmed' };
        expect(() => checkTransferAccounts(scratch, ['Donor'], '127.0.0.1:21000', [], '', io)).not.toThrow();
        expect(() => checkTransferAccounts(source, ['Donor'], 'rs-sdk-demo.fly.dev', [], '', io)).toThrow('account lease conflict');
        rmSync(join(scratch, '.practice/coordinator/state.json'));
        for (const server of ['127.0.0.1:21000', 'rs-sdk-demo.fly.dev']) expect(() => checkTransferAccounts(scratch, ['Donor'], server, [], '', io)).toThrow('ownership unavailable');
        const p = coinProofEndpoints({ engine: 21000, gateway: 21001, management: 21002, tcp: 21003 }, 'coin-fixture');
        const child = coinChildConfiguration(['scripts/aio-logistics.ts', 'Donor', 'coin-courier', 'Receiver', '45000'], {}, p, { SWARM_PLAN: join(source, 'swarm.json'), FLEET_VAULT_KEY: 'inherited-fixture', FLEET_DIR: source, COORDINATOR_RUN_ID: 'live-run' }, scratch);
        expect(child.cwd).toBe(scratch); expect(child.env.FLEET_DIR).toBe(join(scratch, 'fleet'));
        expect(child.env.SWARM_PLAN).toBe(join(scratch, 'swarm.json'));
        expect(child.env.FLEET_VAULT_KEY).toBe(''); expect(child.env.COORDINATOR_RUN_ID).toBe('');
        expect(removeCoinProofRoot(scratch)).toBe(true); scratch = '';
        expect(readFileSync(join(source, 'vendor/rs-sdk/bots/LiveActor/marker'), 'utf8')).toBe('private live profile');
        expect(JSON.parse(readFileSync(join(source, '.practice/coordinator/state.json'), 'utf8')).tasks).toHaveLength(1);
        put('vendor/rs-sdk/bots/_template/bot.env', 'PASSWORD=fixture-not-a-placeholder\n');
        expect(() => prepareCoinProofRoot(source, base)).toThrow('placeholder credentials');
    } finally { if (scratch) removeCoinProofRoot(scratch); }
});

test('reserve proof reports admission failure before waiting for a fresh save', () => {
    const denied = 'LOGOUT \nRESULT fail Error: coordinator account ownership unavailable\nCOIN_RESULT {"ok":false,"detail":"Error: coordinator account ownership unavailable"}';
    expect(() => assertCoinReserveRefusal(1, denied)).toThrow('coordinator account ownership unavailable');
    const expected = 'LOGOUT logged-out logged-out\nCOIN_RESULT {"ok":false,"detail":"Error: coin donor bank reserve short"}';
    expect(() => assertCoinReserveRefusal(1, expected)).not.toThrow();
    expect(() => assertCoinReserveRefusal(0, expected)).toThrow();
    expect(() => assertCoinReserveRefusal(1, expected.replace('logged-out logged-out', ''))).toThrow();
});

// --- Fan-out / Fan-in / Note Courier / Food Allocation / Purchase / Cargo / Funding / Handoff / Route ---

test('coin fanout and item fanin argument parsing', () => {
    const f = parseFanout(['Pocketpython', 'Shaftmaker', 'YewFirst', '20000']);
    expect(f.receivers).toEqual(['Shaftmaker', 'YewFirst']);
    expect(f.pairs.map(p => [p.donor, p.receiver, p.amount])).toEqual([['Pocketpython', 'Shaftmaker', 20000], ['Pocketpython', 'YewFirst', 20000]]);
    expect(() => parseFanout(['A', 'A', '10'])).toThrow();
    expect(() => parseFanout(['A', '10'])).toThrow();

    expect(parseFanin(['BowBeforeMe', 'Wandwaver', 'Bigchopper', 'Feather'])).toEqual({ receiver: 'BowBeforeMe', donors: ['Wandwaver', 'Bigchopper'], item: 'Feather' });
    expect(() => parseFanin(['BowBeforeMe', 'Feather'])).toThrow();
    expect(() => parseFanin(['BowBeforeMe', 'bowbeforeme', 'Feather'])).toThrow();
    expect(() => parseFanin(['BowBeforeMe', 'Wandwaver', '500'])).toThrow();
    expect(heldItems([{ id: 314, count: 120 }, { id: 52, count: 5 }, { id: 314, count: 3 }], 314)).toBe(123);
});

test('courierFoodAllocation honors per-type and total caps', () => {
    expect(courierFoodAllocation([34, 62], 159, 24)).toEqual([24, 24]);
    const stock = [34, 62], lots: number[][] = [];
    for (let i = 0; i < 4; i++) { const lot = courierFoodAllocation(stock, 159, 0, 24); lots.push(lot); lot.forEach((n, j) => { stock[j] -= n; }); }
    expect(lots).toEqual([[24, 0], [10, 14], [0, 24], [0, 24]]);
    expect(stock).toEqual([0, 0]);
    expect(courierFoodAllocation([10, 20], 4, 0, 24)).toEqual([4, 0]);
    expect(courierFoodAllocation([10, 20], 159, 12, 24)).toEqual([10, 12]);
    expect(courierFoodAllocation([10, 20], 0, 0, 24)).toEqual([0, 0]);
    expect(courierFoodAllocation([1, 2], 159, 0, 24)).toEqual([1, 2]);
    for (const bad of [-1, NaN, Infinity, 1.5]) { expect(() => courierFoodAllocation([10], 159, 0, bad)).toThrow(); expect(() => courierFoodAllocation([bad], 159, 0, 24)).toThrow(); }
});

const trout = (count: number) => ({ id: 333, name: 'Trout', count });
function separationFixture(options: { food?: number; failDeposit?: boolean; failTrade?: boolean; failRestore?: boolean; bankReady?: boolean } = {}) {
    let food = options.food ?? 2, notes = 100, bank = 7, traded = 0;
    const calls: string[] = [];
    const deps: SeparationDeps = {
        inventory: () => [{ id: 333, name: 'Trout', count: food, slot: 0 }, { id: 334, name: 'Trout', count: notes, slot: 2 }].filter(i => i.count > 0),
        bank: () => options.bankReady === false ? null : [{ id: 333, name: 'Trout', count: bank, slot: 5 }],
        openBank: async () => { calls.push('open'); return options.bankReady !== false; },
        closeBank: async () => { calls.push('close'); return true; },
        deposit: async item => { calls.push(`deposit:${item.id}`); if (options.failDeposit) { food--; bank++; return false; } bank += food; food = 0; return true; },
        withdraw: async (item, n) => { calls.push(`withdraw:${item.id}:${n}`); if (options.failRestore) return false; food += n; bank -= n; return true; },
        tradeNotes: async n => { calls.push(`trade:${n}`); if (options.failTrade) return { success: false, given: 0 }; notes -= n; traded += n; return { success: true, given: n }; },
        observed: async pred => pred(),
    };
    return { deps, calls, state: () => ({ food, notes, bank, traded }) };
}

test('exact-ID separation and courierDeliveryWaiting rules', async () => {
    {
        const f = separationFixture(); expect(await separateTroutNotes(f.deps)).toBe(100);
        expect(f.state()).toEqual({ food: 2, notes: 0, bank: 7, traded: 100 });
        expect(f.calls).toEqual(['open', 'deposit:333', 'close', 'trade:100', 'open', 'withdraw:333:2', 'close']);
    }
    {
        const f = separationFixture({ food: 5 }); expect(await separateTroutNotes(f.deps)).toBe(100);
        expect(f.state()).toEqual({ food: 5, notes: 0, bank: 7, traded: 100 });
        expect(courierCargo(f.deps.inventory(), 2)).toEqual({ items: [{ name: 'Trout', count: 3 }], blocked: [] });
    }
    for (const options of [{ failDeposit: true }, { failTrade: true }]) {
        const f = separationFixture(options);
        await expect(separateTroutNotes(f.deps)).rejects.toThrow('no delivery progress');
        expect(f.state()).toEqual({ food: 2, notes: 100, bank: 7, traded: 0 });
        if (options.failDeposit) expect(f.calls.some(c => c.startsWith('trade:'))).toBe(false);
    }
    const unknown = separationFixture({ bankReady: false });
    await expect(separateTroutNotes(unknown.deps)).rejects.toThrow('no delivery progress');
    const failed = separationFixture({ failRestore: true });
    await expect(separateTroutNotes(failed.deps)).rejects.toThrow('restore');
    expect(failed.state()).toEqual({ food: 0, notes: 0, bank: 9, traded: 100 });

    const inv = [trout(1), trout(1), { id: 995, name: 'Coins', count: 100 }];
    expect(courierCargo(inv, 2)).toEqual({ items: [], blocked: [] });
    const now = 1000, job = { account: 'Bigpackage', script: 'scripts/aio-logistics.ts', args: ['note-courier'], env: {} };
    const status = { at: now, result: '', goal: 'note-courier.ts', pos: { x: 2654, z: 3283, level: 0 }, inventory: inv };
    expect(courierDeliveryWaiting(['Bigpackage'], { x: 2654, z: 3283, radius: 50 }, [{ account: 'Bigpackage', script: 'scripts/note-courier.ts', env: {} }], () => status, now)).toBe(false);

    const flaxInv = [trout(5), { id: 1779, name: 'Flax', count: 81 }];
    expect(courierCargo(flaxInv, 2)).toEqual({ items: [{ name: 'Trout', count: 3 }, { name: 'Flax', count: 81 }], blocked: [] });
    expect(courierDeliveryWaiting(['Bigpackage'], undefined, [{ account: 'Bigpackage', script: 'scripts/note-courier.ts' }], () => ({ at: 1000, result: '', goal: 'note-courier.ts', inventory: flaxInv }), 1000)).toBe(true);

    const mixedInv = [trout(2), { id: 334, name: 'Trout', count: 100 }];
    expect(courierCargo(mixedInv, 2)).toEqual({ items: [], blocked: ['Trout: need-bank-separation'] });
    expect(courierCargo([{ id: 334, name: 'Trout', count: 100 }], 2)).toEqual({ items: [{ name: 'Trout', count: 100 }], blocked: [] });
    expect(courierDeliveryWaiting(['Bigpackage'], undefined, [{ account: 'Bigpackage', script: 'scripts/note-courier.ts' }], () => ({ at: 1000, result: '', goal: 'note-courier.ts', inventory: mixedInv }), 1000)).toBe(false);

    const cargo = courierCargo(mixedInv, 2); let runs = 0;
    const end = await supervise({
        run: async () => { runs++; return { stdout: `RESULT fail Error: no delivery progress: ${cargo.blocked.join(', ')}`, exitCode: 1 }; },
        stopped: () => false, pause: async () => { throw new Error('must not retry unsafe trade'); }, maxRestarts: 20,
    });
    expect(end).toEqual({ reason: 'blocked', runs: 1 }); expect(runs).toBe(1);

    const plainStatus = { at: 1000, result: '', inventory: [trout(2)] };
    for (const jobs of [[], [{ account: 'Food', script: 'scripts/aio-logistics.ts', args: ['food-courier'] }]]) {
        expect(courierDeliveryWaiting(['Food'], undefined, jobs, () => plainStatus, 1000)).toBe(true);
    }
    expect(retainedTrout({ RETAIN_TROUT: '0' })).toBe(0);
    for (const value of ['-1', '2.5', 'bad', '']) expect(() => retainedTrout({ RETAIN_TROUT: value })).toThrow('RETAIN_TROUT');
    expect(courierDeliveryWaiting(['Food'], undefined, [{ account: 'Food', script: 'scripts/note-courier.ts', env: { RETAIN_TROUT: 'bad' } }], () => ({ ...plainStatus, goal: 'note-courier.ts' }), 1000)).toBe(false);
    expect(courierDeliveryWaiting(['Food'], undefined, [], () => ({ ...plainStatus, result: 'ok done' }), 1000)).toBe(false);

    expect(courierDeliveryWaiting(['Bigpackage'], { x: 2654, z: 3283, radius: 50 }, [{ account: 'Bigpackage', script: 'scripts/aio-logistics.ts', args: ['food-courier'], env: { OUTBOUND_ONLY: '1' } }], () => ({ at: now, result: '', goal: 'foodcourier.ts', pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ id: 1778, name: 'Bow string', count: 500 }, trout(2)] }), now)).toBe(false);
    const matchingStatus = { at: now, result: '', goal: 'note-courier.ts', pos: { x: 2655, z: 3283, level: 0 }, inventory: [trout(2), { id: 1779, name: 'Flax', count: 81 }] };
    for (const goal of ['note-courier.ts', 'scripts/note-courier.ts', 'scripts\\note-courier.ts', 'aio-logistics.ts']) {
        expect(courierDeliveryWaiting(['Bigpackage'], { x: 2654, z: 3283, radius: 50 }, [{ ...job, goal }], () => ({ ...matchingStatus, goal }), now)).toBe(true);
    }
    for (const patch of [{ goal: '' }, { goal: undefined }, { goal: 'fleet-seers-entry.ts' }, { at: now - 30_001 }, { result: 'ok done' }, { pos: { x: 2727, z: 3492, level: 0 } }]) {
        expect(courierDeliveryWaiting(['Bigpackage'], { x: 2654, z: 3283, radius: 50 }, [{ account: 'Bigpackage', script: 'scripts/note-courier.ts', goal: 'Collect advertised cargo', enabled: false, env: {} }], () => ({ ...matchingStatus, ...patch }), now)).toBe(false);
    }
});

const fundNow = 100000, fundToken = '00000000-0000-4000-8000-000000000001';
const fundOwned = new Set(['payer', 'courier']);
const fundStatus = { name: 'Courier', server: 'rs-sdk-demo.fly.dev', at: fundNow, result: '', pos: { x: 2654, z: 3283, level: 0 }, inventory: [{ id: 995, count: 976 }] };
const fundReq = { token: fundToken, funder: 'Payer', items: [{ name: 'Coins', count: 5000 }] };

test('courier funding validates endpoint/token, reserves, single-claim replay, and cancels safely', async () => {
    expect(fundingRequestValid('Payer', 'Courier', fundStatus, fundReq, fundNow, 'rs-sdk-demo.fly.dev', fundOwned, fundNow)).toBe(true);
    for (const patch of [{ result: 'ok offline' }, { at: fundNow - 30000 }, { server: 'localhost:8888' }, { name: 'Foreign' }, { pos: { x: 2654, z: 3302, level: 0 } }, { inventory: [{ id: 995, count: 1500 }] }]) {
        expect(fundingRequestValid('Payer', 'Courier', { ...fundStatus, ...patch }, fundReq, fundNow, 'rs-sdk-demo.fly.dev', fundOwned, fundNow)).toBe(false);
    }
    for (const patch of [{ funder: 'Other' }, { token: '' }, { items: [{ name: 'Coins', count: 5001 }] }, { items: [{ name: 'Trout', count: 5000 }] }]) {
        expect(fundingRequestValid('Payer', 'Courier', fundStatus, { ...fundReq, ...patch }, fundNow, 'rs-sdk-demo.fly.dev', fundOwned, fundNow)).toBe(false);
    }
    expect(fundingRequestValid('Payer', 'Courier', fundStatus, fundReq, fundNow, 'rs-sdk-demo.fly.dev', new Set(['payer']), fundNow)).toBe(false);
    expect(fundingRequestValid('Payer', 'Courier', fundStatus, fundReq, fundNow - 180001, 'rs-sdk-demo.fly.dev', fundOwned, fundNow)).toBe(false);

    function payoutFixture(bank = 100000, outcome: 'paid' | 'failed' | 'partial' = 'paid') {
        const dir = makeTempDir('courier-funding-'), reqFile = join(dir, 'Courier.json');
        const req = { ...fundReq };
        writeFileSync(reqFile, JSON.stringify(req));
        const at = new Date(Date.now() - 1000);
        utimesSync(reqFile, at, at);
        let cash = 200, tick = 0, calls = 0, withdraws = 0, open = false;
        const listeners = new Set<() => void>();
        const timer = setInterval(() => { tick++; for (const cb of listeners) cb(); }, 1);
        const inv = () => cash ? [{ id: 995, name: 'Coins', count: cash, slot: 0 }] : [];
        const s: any = {
            name: 'Payer', tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
            sdk: { getInventory: inv, getState: () => ({ bank: { items: open && bank ? [{ id: 995, name: 'Coins', count: bank, slot: 0 }] : [] } }) },
            bot: {
                openBank: async () => { open = true; return { success: true }; }, closeBank: async () => { open = false; return { success: true }; },
                withdrawItem: async (_r: any, n: number) => { withdraws++; const v = Math.min(n, bank); cash += v; bank -= v; return { success: v === n }; },
                depositItem: async (_r: any, n: number) => { const v = Math.min(n, cash); cash -= v; bank += v; return { success: v === n }; },
                serveTrades: async () => { calls++; const paid = outcome === 'paid' ? 5000 : outcome === 'partial' ? 3000 : 0; cash -= paid; return { message: outcome, trades: outcome === 'failed' ? [] : [{ success: true, gave: [{ name: 'Coins', count: 5000 }] }] }; },
            },
        };
        const options = { dir, owned: fundOwned, readStatus: () => ({ ...fundStatus, at: Date.now() }) };
        return { s, options, dir, reqFile, req, cash: () => cash, bank: () => bank, calls: () => calls, withdraws: () => withdraws, close: () => clearInterval(timer) };
    }

    const paid = payoutFixture();
    try {
        const r = await serviceCourierFunding(paid.s, 'Courier', 'rs-sdk-demo.fly.dev', paid.options);
        expect(r?.state).toBe('paid'); expect(paid.bank()).toBe(95000); expect(paid.cash()).toBe(200); expect(paid.calls()).toBe(1);
        expect(existsSync(join(paid.dir, 'Courier.claimed.json'))).toBe(false);
        writeFileSync(paid.reqFile, JSON.stringify(paid.req));
        expect(await serviceCourierFunding(paid.s, 'Courier', 'rs-sdk-demo.fly.dev', paid.options)).toBeNull();
        expect(paid.calls()).toBe(1);
    } finally { paid.close(); }

    for (const [bank, outcome, state] of [[14999, 'paid', 'declined'], [100000, 'failed', 'failed']] as const) {
        const f = payoutFixture(bank, outcome);
        try {
            const r = await serviceCourierFunding(f.s, 'Courier', 'rs-sdk-demo.fly.dev', f.options);
            expect(r?.state).toBe(state); expect(f.bank()).toBe(bank); expect(f.cash()).toBe(200); expect(f.withdraws()).toBe(outcome === 'paid' ? 0 : 1);
        } finally { f.close(); }
    }

    const partial = payoutFixture(100000, 'partial');
    try {
        const r = await serviceCourierFunding(partial.s, 'Courier', 'rs-sdk-demo.fly.dev', partial.options);
        expect(r?.state).toBe('unknown'); expect(existsSync(join(partial.dir, 'Courier.claimed.json'))).toBe(true);
        expect(JSON.parse(readFileSync(join(partial.dir, `${partial.req.token}.result.json`), 'utf8')).state).toBe('unknown');
        await expect(serviceCourierFunding(partial.s, 'Courier', 'rs-sdk-demo.fly.dev', partial.options)).rejects.toThrow('unresolved funding claim');
        expect(partial.calls()).toBe(1);
    } finally { partial.close(); }

    const dir = makeTempDir('funding-invalid-status-');
    const s: any = { name: 'Courier', sdk: { getInventory: () => [{ id: 995, count: 976 }], getState: () => ({ player: { worldX: 2654, worldZ: 3283, level: 0 } }) } };
    const r = await requestCourierFunding(s, 'Payer', 'rs-sdk-demo.fly.dev', { dir, owned: fundOwned, readStatus: () => ({ name: 17 }) });
    expect(r.reason).toBe('funder unavailable'); expect(r.received).toBe(0); expect(existsSync(join(dir, 'Courier.json'))).toBe(false);

    const cancelled = payoutFixture();
    try {
        rmSync(cancelled.reqFile);
        expect(await serviceCourierFunding(cancelled.s, 'Courier', 'rs-sdk-demo.fly.dev', cancelled.options)).toBeNull();
        expect(cancelled.withdraws()).toBe(0); expect(cancelled.calls()).toBe(0); expect(cancelled.bank()).toBe(100000);
    } finally { cancelled.close(); }
});

for (const mode of ['new', 'legacy', 'stale', 'foreign', 'settled']) {
    test(`collection preflight ${mode}`, async () => {
        const root = makeTempDir('offer-test-'); let tick = 0, trades = 0;
        const callbacks = new Set<() => void>();
        const s: any = { name: 'Courier', tick: () => tick, sdk: { getState: () => ({}) }, onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); } };
        const timer = setInterval(() => { tick++; if (tick === 2 && mode !== 'legacy') writeFileSync(join(root, 'cook-courier.json'), JSON.stringify({ token: 'new', from: 'Cook', to: 'Courier', server: mode === 'foreign' ? 'other' : 'practice', at: Date.now() - (mode === 'stale' ? 130000 : 0), state: mode === 'settled' ? 'settled' : 'prepared', expected: [{ id: 334, count: 10 }] })); for (const cb of [...callbacks]) cb(); }, 1);
        try {
            const run = awaitCollectionOffer(s, 'Cook', 'practice', 10, root).then(() => { trades++; });
            if (mode === 'new') await run; else await expect(run).rejects.toThrow('no trade accepted');
            expect(trades).toBe(mode === 'new' ? 1 : 0); expect(tick).toBeLessThanOrEqual(11);
        } finally { clearInterval(timer); }
    }, 2000);
}

test('handoff matching, collection orchestration, custom item policies, and race conditions', async () => {
    const req = { token: 'one', from: 'Courier', to: 'Farmer', server: 'practice', at: 100, state: 'prepared' as const, expected: [{ id: 334, count: 10 }] };
    const credit = { ...req, at: 120, before: [{ id: 334, count: 5 }], after: [{ id: 334, count: 15 }] };
    const before = [{ id: 334, count: 30 }], after = [{ id: 334, count: 20 }];
    expect(handoffCreditMatches(req, credit, before, after, 130)).toBe(true);
    for (const bad of [null, { ...credit, token: 'old' }, { ...credit, to: 'Other' }, { ...credit, from: 'Other' }, { ...credit, server: 'live' }, { ...credit, at: 99 }, { ...credit, at: 131 }, { ...credit, after: credit.before }, { ...credit, after: [{ id: 330, count: 15 }] }, { ...credit, after: [{ id: 334, count: 16 }] }, { ...credit, before: undefined }]) {
        expect(handoffCreditMatches(req, bad, before, after, 130)).toBe(false);
    }
    expect(handoffCreditMatches(req, credit, before, before, 130)).toBe(false);
    expect(handoffCreditMatches(req, credit, before, [{ id: 334, count: 21 }], 130)).toBe(false);
    expect(handoffCreditMatches(req, credit, before, after, 120101)).toBe(false);

    for (const mode of ['match', 'no-cook-debit', 'short-credit', 'lost-reply', 'no-transfer']) {
        const root = makeTempDir('collection-test-'); let cook = 20, courier = 7, feathers = 100, tick = 0;
        const listeners = new Set<() => void>();
        const session = (name: string, inventory: () => any[]) => ({ name, tick: () => tick, sdk: { getInventory: inventory, getState: () => ({}) }, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); } } as any);
        const c = session('Cook', () => [{ id: 334, count: cook }, { id: 330, count: 4 }]);
        const r = session('Courier', () => [{ id: 334, count: courier }, { id: 330, count: 2 }, { id: 314, count: feathers }]);
        let release!: () => void; const signal = new Promise<void>(res => { release = res; });
        const capture = <T>(p: Promise<T>) => p.then(value => ({ value }), error => ({ error: String(error) }));
        const collected = capture(collectHandoff(r, 'Cook', 'practice', async () => { await signal; return { success: true }; }, root));
        if (mode === 'no-transfer') {
            release(); expect(await collected).toEqual({ value: { result: { success: true }, received: 0 } });
            continue;
        }
        const sent = capture(sendHandoff(c, 'Courier', 'practice', [{ id: 334, count: 10 }], async () => {
            if (mode !== 'no-cook-debit') cook -= 10;
            courier += mode === 'short-credit' ? 9 : 10; feathers = 0; release();
            if (mode === 'lost-reply') throw Error('lost reply');
        }, root));
        for (let i = 0; i < 70; i++) { await Promise.resolve(); tick++; for (const cb of [...listeners]) cb(); }
        const [sendResult, collectResult] = await Promise.all([sent, collected]);
        if (mode === 'match' || mode === 'lost-reply') {
            expect(sendResult).toEqual({ value: 10 }); expect(collectResult).toEqual({ value: { result: { success: true }, received: 10 } });
        } else {
            expect('error' in sendResult).toBe(true); expect('error' in collectResult).toBe(true);
            expect(JSON.parse(readFileSync(join(root, 'cook-courier.json'), 'utf8')).state).toBe('prepared');
        }
    }

    {
        const root = makeTempDir('collection-legacy-test-'); let held = 7;
        const s: any = { name: 'Courier', sdk: { getInventory: () => [{ id: 334, count: held }] } };
        await expect(collectHandoff(s, 'Cook', 'practice', async () => { held += 10; return { success: true }; }, root)).rejects.toThrow('credit unbound');
    }

    for (const mode of ['match', 'missing', 'mismatch', 'lost-reply']) {
        const root = makeTempDir('handoff-test-'); let sender = 30, recipient = 5, calls = 0, tick = 0;
        const listeners = new Set<() => void>();
        const s: any = { name: 'Courier', tick: () => tick, sdk: { getInventory: () => [{ id: 334, count: sender }], getState: () => ({}) }, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); } };
        const r: any = { name: 'Farmer', sdk: { getInventory: () => [{ id: 334, count: recipient }] } };
        const run = sendHandoff(s, 'Farmer', 'practice', [{ id: 334, count: 10 }], async () => {
            calls++; if (mode === 'missing') { sender -= 10; return; }
            await receiveHandoff(r, 'Courier', 'practice', async () => { sender -= 10; recipient += mode === 'mismatch' ? 9 : 10; return { success: true }; }, root);
            recipient = 0; if (mode === 'lost-reply') throw Error('lost reply');
        }, root).then(value => ({ value }), error => ({ error: String(error) }));
        for (let i = 0; i < 40; i++) { await Promise.resolve(); tick++; for (const cb of [...listeners]) cb(); }
        const result = await run, record = JSON.parse(readFileSync(join(root, 'courier-farmer.json'), 'utf8'));
        if (mode === 'match' || mode === 'lost-reply') { expect(result).toEqual({ value: 10 }); expect(record.state).toBe('settled'); }
        else { expect('error' in result).toBe(true); expect(record.state).toBe('prepared'); await expect(sendHandoff(s, 'Farmer', 'practice', [{ id: 334, count: 10 }], async () => { calls++; }, root)).rejects.toThrow('unresolved'); }
        expect(calls).toBe(1);
    }

    const iron = createHandoff([40], join(tmpdir(), 'iron-policy-test'));
    const ir = { ...req, expected: [{ id: 40, count: 10 }] }, ic = { ...credit, before: [], after: [{ id: 40, count: 10 }] };
    expect(iron.handoffCreditMatches(ir, ic, [{ id: 40, count: 10 }], [], 130)).toBe(true);
    expect(handoffCreditMatches(ir, ic, [{ id: 40, count: 10 }], [], 130)).toBe(false);
    expect(iron.handoffCreditMatches({ ...ir, expected: [...ir.expected, { id: 334, count: 1 }] }, ic, [{ id: 40, count: 10 }], [], 130)).toBe(false);
    expect(handoffCreditMatches({ ...req, expected: [...req.expected, { id: 40, count: 1 }] }, credit, before, after, 130)).toBe(false);
    const ids = [40]; const frozen = createHandoff(ids, join(tmpdir(), 'iron-policy-copy')); ids.push(334);
    expect(frozen.handoffCounts([{ id: 334, count: 10 }])).toEqual([]);
    expect(() => createHandoff([40], process.cwd() + '/.practice/courier-handoffs')).toThrow();
    for (const badIds of [[], [40, 40], [0], [-1], [1.5]]) expect(() => createHandoff(badIds, join(tmpdir(), 'invalid-policy'))).toThrow();
});

for (const mode of ['delayed-inventory', 'publication-race', 'no-transfer', 'wrong-amount', 'expired', 'foreign']) {
    test(`handoff race ${mode}`, async () => {
        const root = makeTempDir('handoff-race-'), file = join(root, 'courier-farmer.json');
        let held = 0, tick = 0; const callbacks = new Set<() => void>();
        const request = { token: 'new', from: 'Courier', to: 'Farmer', server: mode === 'foreign' ? 'other' : 'practice', state: 'prepared', at: Date.now() - (mode === 'expired' ? 130000 : 10), expected: [{ id: 330, count: 81 }] };
        const s: any = { name: 'Farmer', tick: () => tick, sdk: { getState: () => ({}), getInventory: () => held ? [{ id: 330, count: held }] : [] }, onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); } };
        if (mode !== 'publication-race') writeFileSync(file, JSON.stringify(request));
        const timer = setInterval(() => { tick++; if (tick === 2 && mode === 'delayed-inventory') held = 81; for (const cb of [...callbacks]) cb(); }, 2);
        try {
            await receiveHandoff(s, 'Courier', 'practice', async () => {
                if (mode === 'publication-race') writeFileSync(file, JSON.stringify(request));
                if (mode !== 'delayed-inventory' && mode !== 'no-transfer') held = mode === 'wrong-amount' ? 80 : 81;
                return { success: true };
            }, root);
            const expected = mode === 'delayed-inventory' || mode === 'publication-race';
            expect(existsSync(file + '.credit')).toBe(expected);
            if (expected) { const c = JSON.parse(readFileSync(file + '.credit', 'utf8')); expect(c.token).toBe('new'); expect(c.after).toEqual([{ id: 330, count: 81 }]); }
        } finally { clearInterval(timer); }
    }, 2000);
}

test('sender inventory can settle after the trade reply', async () => {
    const root = makeTempDir('sender-race-'); let held = 100, tick = 0;
    const callbacks = new Set<() => void>();
    const s: any = { name: 'Courier', tick: () => tick, sdk: { getState: () => ({}), getInventory: () => [{ id: 330, count: held }] }, onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); } };
    const timer = setInterval(() => { tick++; if (tick === 2) held = 19; for (const cb of [...callbacks]) cb(); }, 2);
    try {
        const amount = await sendHandoff(s, 'Farmer', 'practice', [{ id: 330, count: 81 }], async () => {
            const p = join(root, 'courier-farmer.json'), r = JSON.parse(readFileSync(p, 'utf8'));
            writeFileSync(p + '.credit', JSON.stringify({ token: r.token, from: r.from, to: r.to, server: r.server, at: Date.now(), before: [], after: [{ id: 330, count: 81 }] }));
        }, root);
        expect(amount).toBe(81);
        expect(JSON.parse(readFileSync(join(root, 'courier-farmer.json'), 'utf8')).after).toEqual([{ id: 330, count: 19 }]);
    } finally { clearInterval(timer); }
}, 2000);

test('courier island crossing, feather purchase settlement, resume, and food deficit checks', () => {
    for (const n of [undefined, NaN, 3, 13, 28, 28.5]) expect(courierIslandProblem(n)).toMatch(/combat29/);
    expect(courierIslandProblem(29)).toBeNull(); expect(courierIslandProblem(74)).toBeNull();

    expect(featherPurchaseEffect(500, 20, 380, 30, 10)).toEqual({ bought: 10, cost: 120 });
    expect(featherPurchaseEffect(500, 20, 490, 25, 10)).toEqual({ bought: 5, cost: 10 });
    expect(featherPurchaseEffect(500, 20, 500, 20, 10)).toEqual({ bought: 0, cost: 0 });
    for (const row of [[500, 20, 490, 20, 10], [500, 20, 500, 21, 10], [500, 20, 487, 21, 10], [500, 20, 501, 21, 10], [500, 20, 480, 31, 10], [72, 20, 59, 21, 1], [500, 20, 480, 19, 10], [500, 20, 480, 21, NaN]]) {
        expect(() => featherPurchaseEffect(...row as [number, number, number, number, number])).toThrow();
    }
    for (const stock of [1000, 750, 500, 50, 0]) for (const initial of [4, 59, 60, 61, 71, 72, 120, 3014]) {
        let coins = initial, bought = 0;
        for (let batch = 0; batch < 20 && bought < 500; batch++) {
            const n = featherBatchAmount(coins, 500 - bought); if (n === 0) break;
            for (let i = 0; i < n; i++) { const diff = Math.max(-5000, Math.min(1000, (stock - bought - i - 1000) * 10)); coins -= Math.max(1, Math.floor(2 * Math.max(100, 1000 - diff) / 1000)); }
            bought += n; expect(coins).toBeGreaterThanOrEqual(60);
        }
        expect(bought).toBeLessThanOrEqual(500);
        if (initial < 72) expect(bought).toBe(0);
    }
    expect(featherBatchAmount(1000, 3)).toBe(3); expect(featherBatchAmount(1000, 500)).toBe(50);
    for (const value of [NaN, Infinity, -1, 1.5]) { expect(featherBatchAmount(value, 500)).toBe(0); expect(featherBatchAmount(1000, value)).toBe(0); }

    const at = (worldX: number, worldZ: number, level = 0) => ({ worldX, worldZ, level });
    expect(deliveryResume(at(2653, 3284), 1035, 4)).toBe('bank');
    expect(deliveryResume(at(2888, 3164), 1035, 4)).toBe('karamja');
    expect(deliveryResume(at(2619, 3332), 50, 1)).toBe('bank');
    expect(deliveryResume(at(2662, 3294), 75, 4)).toBe('bank');
    expect(deliveryResume(at(2653, 3284), 0, 4)).toBeNull();
    expect(deliveryResume(at(2653, 3284), 1035, 0)).toBeNull();
    expect(deliveryResume(at(3222, 3218), 1035, 4)).toBeNull();
    expect(deliveryResume(at(2888, 3164, 1), 1035, 4)).toBeNull();
    expect(deliveryResume(undefined, 1035, 4)).toBeNull();

    const now = 100000, base = { name: 'Farmer', server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now - 1000, bank: [], inventory: [], result: '' };
    expect(foodDeficit('Farmer', base, now)).toBe(80);
    expect(foodDeficit('Farmer', { ...base, bank: [{ id: 333, count: 238 }], inventory: [{ id: 329, count: 26 }] }, now)).toBe(0);
    expect(foodDeficit('Farmer', { ...base, bank: [{ id: 333, count: 50 }], inventory: [{ id: 330, count: 10 }] }, now)).toBe(20);
    for (const patch of [{ name: 'Stranger' }, { server: 'localhost:8888' }, { at: now - 30000 }, { at: now + 1 }, { result: 'fail died' }, { bankAt: undefined }, { bank: null }, { inventory: [{ id: 333, count: -1 }] }]) {
        expect(foodDeficit('Farmer', { ...base, ...patch }, now)).toBeUndefined();
    }

    const cookStatus = { name: 'Cook', server: 'rs-sdk-demo.fly.dev', at: now, result: '', inventory: [{ id: 314, count: 2490 }] };
    expect(featherPurchaseAmount(500, 'Cook', cookStatus, now)).toBe(0);
    expect(featherPurchaseAmount(500, 'Cook', { ...cookStatus, inventory: [{ id: 314, count: 800 }] }, now)).toBe(200);
    expect(featherPurchaseAmount(500, 'Cook', { ...cookStatus, inventory: [] }, now)).toBe(500);
    for (const patch of [{ name: 'Stranger' }, { server: 'localhost:8888' }, { at: now - 30000 }, { at: now + 1 }, { result: 'ok stopped' }, { inventory: null }]) {
        expect(featherPurchaseAmount(500, 'Cook', { ...cookStatus, ...patch }, now)).toBe(500);
    }

    const owned = new Set(['first', 'second']);
    const cook = (name: string, n: number) => ({ name, server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now - 1000, result: '', bank: [{ id: 333, count: n }] });
    const first = cook('First', 10), second = cook('Second', 170);
    expect(selectFoodSource(['First', 'Second'], [first, second], owned, now)).toBe('Second');
    expect(selectFoodSource(['First', 'Second'], [first, { ...second, result: 'fail stopped' }], owned, now)).toBe('First');
    expect(selectFoodSource(['First', 'Second'], [first, { ...second, at: now - 30000 }], owned, now, 20)).toBeUndefined();
    expect(selectFoodSource(['First', 'Second'], [first, second], new Set(['first']), now)).toBeUndefined();
    expect(selectFoodSource(['First', 'Second'], [{ ...first, bankAt: now + 1 }, { ...second, server: 'localhost:8888' }], owned, now)).toBeUndefined();

    const bank = { x: 2654, z: 3283 }, p = { worldX: 2654, worldZ: 3283, level: 0 };
    expect(deliveryRecipientAtBank(p, [{ name: 'Farm', distance: 2 }], 'Farm', bank)).toBe(true);
    expect(deliveryRecipientAtBank(p, [{ name: 'Farm', distance: 17 }], 'Farm', bank)).toBe(false);
    expect(deliveryRecipientAtBank({ ...p, worldZ: 3302 }, [{ name: 'Farm', distance: 1 }], 'Farm', bank)).toBe(false);
    expect(deliveryRecipientAtBank({ ...p, level: 1 }, [{ name: 'Farm', distance: 1 }], 'Farm', bank)).toBe(false);
    expect(deliveryRecipientAtBank(p, [{ name: 'Foreign', distance: 1 }], 'Farm', bank)).toBe(false);
    expect(deliveryRecipientAtBank(p, [{ name: 'Farm', distance: -1 }], 'Farm', bank)).toBe(false);

    const restockS = { name: 'Farm', server: 'rs-sdk-demo.fly.dev', at: now, bankAt: now - 1, result: '', bank: [], inventory: [{ id: 333, count: 79 }] };
    expect(foodRestockAmount('Farm', restockS, now)).toBe(81);
    expect(foodRestockAmount('Farm', { ...restockS, inventory: [{ id: 333, count: 80 }] }, now)).toBe(0);
    expect(foodRestockAmount('Farm', { ...restockS, inventory: [{ id: 333, count: 160 }] }, now)).toBe(0);
    expect(foodRestockAmount('Farm', { ...restockS, at: now - 30000 }, now)).toBeUndefined();

    const localS = { name: 'Farm', server: 'localhost:8888', at: now, bankAt: now - 1, result: '', bank: [], inventory: [] };
    expect(foodRestockAmount('Farm', localS, now)).toBeUndefined();
    expect(foodRestockAmount('Farm', localS, now, 'localhost:8888')).toBe(160);
    expect(foodRestockAmount('Farm', { ...localS, server: 'rs-sdk-demo.fly.dev' }, now, 'localhost:8888')).toBeUndefined();

    expect(onKaramja({ worldX: 2829, worldZ: 3190, level: 0 })).toBe(true);
    expect(onKaramja({ worldX: 2956, worldZ: 3146, level: 0 })).toBe(true);
    expect(onKaramja({ worldX: 2774, worldZ: 3228, level: 0 })).toBe(true);
    expect(onKaramja({ worldX: 2956, worldZ: 3143, level: 1 })).toBe(false);
    expect(onKaramja({ worldX: 3222, worldZ: 3218, level: 0 })).toBe(false);
    expect(onKaramja({ worldX: 2654, worldZ: 3283, level: 0 })).toBe(false);
    expect(onKaramja(undefined)).toBe(false);

    for (const why of ['no courier progress: start is not an Ardougne bank or east of White Wolf Mountain', 'no courier progress: needs 120 coins for the boat fares; refusing the White Wolf Mountain land route', 'no courier progress: needs 60 coins for the boats home; refusing the White Wolf Mountain land route']) {
        expect(isNoProgressFailure(`RESULT fail ${why} at=1,2,0 ticks=3`)).toBe(true);
    }

    expect(outboundStart(at(2654, 3283))).toBe('boat-south');
    expect(outboundStart(at(2650, 3290))).toBe('boat-south');
    expect(outboundStart(at(2619, 3332))).toBe('boat-north');
    expect(outboundStart(at(3185, 3436))).toBe('land');
    expect(outboundStart(at(3222, 3218))).toBe('land');
    expect(outboundStart(at(3092, 3243))).toBe('land');
    expect(draynorApproach(at(3222, 3218))).toBe(LUMBRIDGE_TO_DRAYNOR);
    expect(LUMBRIDGE_TO_DRAYNOR.every(([x, z]) => !(Math.abs(x - 3124) <= 10 && Math.abs(z - 3248) <= 10))).toBe(true);
    expect(draynorApproach(at(3093, 3244))).toEqual([[3092, 3243, 2]]);
    expect(draynorApproach(undefined)).toEqual([[3092, 3243, 2]]);
    expect(outboundStart(at(2700, 3400))).toBe('refuse');
    expect(outboundStart(at(2850, 3480))).toBe('refuse');
    expect(outboundStart(at(2900, 3200))).toBe('refuse');
    expect(outboundStart(at(2654, 3283, 1))).toBe('refuse');
    expect(outboundStart(undefined)).toBe('refuse');
});

function cliCaseFoodCourier(mode: 'sources' | 'foreign' | 'feathers') {
    const code = `
    import {mock} from 'bun:test';import {join,resolve} from 'node:path';
    const mode=${JSON.stringify(mode)},server='127.0.0.1:21000',now=100000,ownedRequests=[],selections=[],results=[];
    Date.now=()=>now;
    const realFs=await import('node:fs'),demand=await import('./packages/core/src/bank-demand'),realBot=await import('./packages/core/src/bot'),realTicks=await import('./packages/core/src/ticks'),realTradeguard=await import('./packages/core/src/tradeguard'),realWalk=await import('./packages/core/src/walk'),realBoat=await import('./packages/core/src/boat'),realDeposit=await import('./packages/core/src/deposit'),realTradeHelpers=await import('./packages/workers/src/logistics/trade-helpers'),realHandoff=await import('./packages/workers/src/logistics/handoff');
    const readFile=realFs.readFileSync,selectSource=demand.selectCookedFoodSource;
    const player={worldX:mode==='feathers'?2654:3092,worldZ:mode==='feathers'?3283:3243,level:0,combatLevel:99};
    let tick=0,shopOpens=0,moves=0;
    const statuses={CookA:{name:'CookA',server,at:now,bankAt:now-1,bank:[{id:333,count:10}],inventory:[{id:314,count:1500}]},
     CookB:{name:'CookB',server,at:now,bankAt:now-1,bank:[{id:385,count:100}],inventory:[]}};
    if(mode==='foreign')for(const status of Object.values(statuses))status.server='rs-sdk-demo.fly.dev';
    const fixtureRoot=process.cwd();
    mock.module('node:fs',()=>({...realFs,readFileSync:(path,...args)=>{
     const name=String(path);
     if(name===join(fixtureRoot,'vendor/rs-sdk/bots','Fixture','bot.env'))return 'SERVER=rs-sdk-demo.fly.dev\\n';
     for(const [cook,status]of Object.entries(statuses))if(name===join(fixtureRoot,'.practice','status',cook+'.json'))return JSON.stringify(status);
     return readFile(path,...args);
    }}));
    const s={name:'Fixture',lifecycle:{server},tick:()=>tick,onTick:()=>()=>{},sdk:{getState:()=>({player,inventory:[]}),getSkill:()=>({level:99})},
     bot:{openShop:async()=>{shopOpens++;throw Error('unexpected shop purchase');}}};
    const modules={
     './packages/core/src/bot':{...realBot,openBot:async()=>s,finish:async(_sessions,ok,message)=>{results.push({ok,message});throw Error('fixture-finish');},
      countItems:()=>500,serverFromEnv:env=>env.match(/^SERVER=(.*)/m)[1],sessionDied:()=>false},
     './packages/core/src/ticks':{...realTicks,waitTicks:async(_s,n)=>{tick+=n;},waitUntil:async(_s,p)=>p()},
     './packages/core/src/tradeguard':{...realTradeguard,ownedAccounts:endpoint=>{ownedRequests.push(endpoint);return new Set(endpoint===server?['cooka','cookb']:[]);}},
     './packages/core/src/bank-demand':{...demand,selectCookedFoodSource:(...args)=>{const selected=selectSource(...args);selections.push({server:args[5],selected});return selected;}},
     './packages/core/src/walk':{...realWalk,sessionWalker:async()=>({}),walkPath:async(_deps,points)=>{moves++;const p=points.at(-1);player.worldX=p.x;player.worldZ=p.z;return{ok:true,next:points.length};}},
     './packages/core/src/boat':{...realBoat,sail:async(_s,{deck})=>{player.worldX=deck.x;player.worldZ=deck.z;player.level=1;return{ok:true};},
      disembark:async()=>{player.level=0;return{ok:true};}},
     './packages/core/src/deposit':{...realDeposit,depositObserved:async()=>{throw Error('unexpected deposit');}},
     './packages/workers/src/logistics/trade-helpers':{...realTradeHelpers,requestCourierFunding:async()=>{throw Error('unexpected funding');}},
     './packages/workers/src/logistics/handoff':{...realHandoff,createHandoff:()=>({awaitCollectionOffer:async()=>{throw Error('unexpected collection');},collectHandoff:async()=>{},sendHandoff:async()=>{}})},
    };
    for(const [path,module]of Object.entries(modules))mock.module(resolve(path),()=>module);
    console.log=()=>{};
    const {runFoodCourier}=await import('./packages/workers/src/logistics/trade');
    try{await runFoodCourier('Fixture',process.env);}catch(error){if(!String(error).includes('fixture-finish'))throw error;}
    process.stdout.write(JSON.stringify({ownedRequests,selections,result:results[0],shopOpens,moves,player}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], {
        cwd: ROOT, windowsHide: true, stdout: 'pipe', stderr: 'pipe', timeout: 10000,
        env: { ...process.env, FROM: mode === 'feathers' ? 'CookA' : 'CookA,CookB', OUTBOUND_ONLY: '1', HOME_ONLY: '', START: '', FUND_FROM: '', FUND_ONLY: '', RESERVE_OPENING_CASH: '',
            FARMERS: '', PER: '', TOTAL_PER: '0', FEATHERS: mode === 'feathers' ? '500' : '0', CAP: '1200' },
    });
    if (child.exitCode !== 0) throw Error(child.stdout.toString() + child.stderr.toString());
    return JSON.parse(child.stdout.toString());
}

test('actual food-courier selects owned cooks and retains feather surplus on local outbound trips', () => {
    const selected = cliCaseFoodCourier('sources');
    expect(selected.ownedRequests).toEqual(['127.0.0.1:21000']);
    expect(selected.selections).toEqual([{ server: '127.0.0.1:21000', selected: 'CookB' }]);
    expect(selected.result.message).toContain('outbound supply trip requires Ardougne bank start');
    expect(selected.moves).toBe(0);
    const foreign = cliCaseFoodCourier('foreign');
    expect(foreign.result.message).toContain('no active owned cook with banked food');
    expect(foreign.moves).toBe(0);
    const feathers = cliCaseFoodCourier('feathers');
    expect(feathers.result).toMatchObject({ ok: true });
    expect(feathers.result.message).toContain('outboundOnly=true');
    expect(feathers.shopOpens).toBe(0);
    expect(feathers.moves).toBeGreaterThan(0);
    expect(feathers.player).toMatchObject({ worldX: 3092, worldZ: 3243, level: 0 });
});

test('note-courier preflight, ownership checks, and finite delivery execution', () => {
    const server = '127.0.0.1:21000', owned = new Set(['banker']), seen: string[] = [];
    const lookup = (endpoint: string) => { seen.push(endpoint); return owned; };
    const config = noteCourierPreflight(['FreshCourier', 'Banker', '300'], { MAX_DELIVERIES: '1' }, { serverOf: () => server, owned: lookup });
    expect(config).toMatchObject({ courierName: 'FreshCourier', bankerName: 'Banker', cap: 300, maxDeliveries: 1, server });
    expect(seen).toEqual([server]);
    expect(() => noteCourierOwned(config.courierName, config.bankerName, server, server, lookup)).toThrow('authenticated owned');
    owned.add('freshcourier');
    expect(noteCourierOwned(config.courierName, config.bankerName, server, server, lookup)).toBe(owned);
    expect(() => noteCourierOwned(config.courierName, config.bankerName, server, '127.0.0.1:21010', lookup)).toThrow('endpoint mismatch');

    const deps = { serverOf: () => '127.0.0.1:21000', owned: () => new Set(['banker']) };
    for (const cap of ['0', '-1', 'NaN', 'Infinity', '1.5']) expect(() => noteCourierPreflight(['Courier', 'Banker', cap], {}, deps)).toThrow('positive safe integers');
    for (const max of ['0', '-1', 'NaN', 'Infinity', '1.5']) expect(() => noteCourierPreflight(['Courier', 'Banker'], { MAX_DELIVERIES: max }, deps)).toThrow('positive safe integers');
    expect(() => noteCourierPreflight(['Courier', 'Courier'], {}, deps)).toThrow('distinct valid');
    expect(() => noteCourierPreflight(['../Courier', 'Banker'], {}, deps)).toThrow('distinct valid');
    expect(() => noteCourierPreflight(['Courier', 'Banker'], {}, { ...deps, owned: () => new Set() })).toThrow('banker must be an authenticated');
    expect(() => noteCourierPreflight(['Courier', 'Banker'], {}, { ...deps, serverOf: name => name === 'Banker' ? '127.0.0.1:21010' : '127.0.0.1:21000' })).toThrow('same server');

    const code = `
    import {mock} from 'bun:test';import {resolve} from 'node:path';
    const server='127.0.0.1:21000',owned=new Set(['banker']),events=[];let inventory=[{id:1780,name:'Flax',count:28}],finished;
    const realBot=await import('./packages/core/src/bot'),realTradeguard=await import('./packages/core/src/tradeguard'),realCargo=await import('./packages/core/src/cargo'),realTicks=await import('./packages/core/src/ticks'),realWalk=await import('./packages/core/src/walk');
    const session={name:'FreshCourier',lifecycle:{server},tick:()=>0,ended:new Promise(()=>{}),onTick:()=>()=>{},
     sdk:{getState:()=>({player:{worldX:2654,worldZ:3283,level:0,lifeId:1,respawnCount:0}}),getInventory:()=>inventory,
      findNearbyPlayer:()=>({name:'Banker'})},bot:{trade:async()=>{events.push('trade');const gave=inventory;inventory=[];return{success:true,gave,received:[]};}}};
    mock.module(resolve('packages/core/src/bot.ts'),()=>({...realBot,openBot:async()=>{events.push('login');owned.add('freshcourier');return session;},
     finish:async(_sessions,ok,detail)=>{events.push('finish');finished={ok,detail};},countItems:()=>0}));
    mock.module(resolve('packages/core/src/tradeguard.ts'),()=>({...realTradeguard,ownedAccounts:endpoint=>{if(endpoint!==server)throw Error('foreign lookup');events.push('owned:'+owned.has('freshcourier'));return new Set(owned);}}));
    mock.module(resolve('packages/core/src/cargo.ts'),()=>({...realCargo,cargoDir:'.practice/not-read-after-finite-delivery',cargoAccountServer:()=>server,
     exactItem:name=>new RegExp('^'+name+'$','i')}));
    mock.module(resolve('packages/core/src/ticks.ts'),()=>({...realTicks,waitTicks:async()=>{},waitUntil:async(_s,p)=>p()}));
    mock.module(resolve('packages/core/src/walk.ts'),()=>({...realWalk,walkPath:async()=>{throw Error('unexpected walking');},sessionWalker:async()=>{throw Error('unexpected walking');}}));
    process.env.MAX_DELIVERIES='1';console.log=()=>{};
    const {noteCourierMain}=await import('./packages/workers/src/logistics/trade');await noteCourierMain(['FreshCourier','Banker','300']);
    process.stdout.write(JSON.stringify({events,finished,inventory}));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', code], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 10000 });
    if (child.exitCode !== 0) throw Error(child.stderr.toString());
    const result = JSON.parse(child.stdout.toString());
    expect(result.events[0]).toBe('owned:false');
    expect(result.events.indexOf('login')).toBeLessThan(result.events.indexOf('owned:true'));
    expect(result.events.filter((event: string) => event === 'trade')).toHaveLength(1);
    expect(result.finished).toMatchObject({ ok: true });
    expect(result.finished.detail).toContain('deliveries=1');
    expect(result.inventory).toEqual([]);
});
