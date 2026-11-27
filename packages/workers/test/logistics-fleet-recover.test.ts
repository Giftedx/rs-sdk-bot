import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { botWork } from '../../core/src/bot';
import { labelAreas, writeLabels, type Labels } from '../../core/src/components';
import type { Session } from '../../core/src/inprocess';
import { logout as logoutAction } from '../../core/src/logout';
import { pathfindingDataKey } from '../../core/src/pathcache';
import { beginSessionAttempt, readLogoutProof } from '../../core/src/session-lifecycle';
import { dueTrades, swarmBusy } from '../../../scripts/fleet-agent';
import { makeOrder } from '../../../scripts/fleet-order';
import {
    DROPPED_CLAIM_MS,
    UNANSWERED_GRACE_MS,
    confirmedTradeLogout,
    droppedTradeClaims,
    releasePublishedTradeClaims,
    snapshot,
} from '../../../scripts/fleet-sync';
import { terminalTradeReceipt, windowClosures, writeTradeReceipt, type TradeReceipt } from '../../../scripts/fleet-trade-settlement';
import { ITEMS } from '../../../scripts/pk';
import { BotSDK } from '../../../vendor/rs-sdk/sdk';
import { executionContext, executionWait } from '../../../vendor/rs-sdk/sdk/execution-context';
import {
    FALADOR_WEST_BANK,
    FLUFFS_FENCE,
    FOUNTAIN_ID,
    GLORY_4,
    GLORY_UNCHARGED,
    HEROES_FOUNTAIN_STAND,
    HEROES_FOUNTAIN_TILE,
    PRAYER_ALTARS,
    SAFE_ALTARS,
    altarText,
    assertTradeAdmission,
    canEnterHeroesBasement,
    chooseAntipoison,
    classifyLocation,
    absentTakerWatch,
    clearPreloginFailure,
    dosesOf,
    exitLumberYard,
    fleetTradeOutcome,
    fleetTradeRecord,
    giverReadyFile,
    inWilderness,
    inspectFleetState,
    loadRecoveryLocationContext,
    markGiverReady,
    nearestAltar,
    nearestBank,
    parseAltar,
    partnerFailed,
    performFleetTransfer,
    pickOrder,
    prepareFleetSender,
    readPreloginFailure,
    recoverSessionToHub,
    releaseWatch,
    runChargeGlory,
    runOrderWork,
    validOrder,
    waitForGiver,
    watchTradeScreen,
    writePreloginFailure,
    type Order,
    type Receipt,
} from '../src/logistics';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

// --- Fleet Trade ---

const order = (o: Partial<Order>): Order => ({ id: 'o1', server: 's', from: 'Giver', to: 'Taker', item: 'Lobster', count: 500, start: 1000, end: 5000, ...o });
const attemptId = '0000000002300-1-1';
const sha256 = 'a'.repeat(64);
const nonce = '12345678-1234-1234-1234-123456789012';
const claimedReceipt = (role: 'from' | 'to' = 'to'): TradeReceipt => ({
    version: 2,
    state: 'prepared',
    id: 'o1',
    account: role === 'from' ? 'Giver' : 'Taker',
    partner: role === 'from' ? 'Taker' : 'Giver',
    role,
    side: 'local',
    server: 's',
    item: 'Lobster',
    requested: 500,
    claim: nonce,
    ok: false,
    count: 0,
    at: 2000,
    detail: '',
});
const logout = { state: 'confirmed', account: 'Taker', server: 's', domain: 'live', attemptId, loggedOutAt: 2400, ownerRun: null, receiptSha256: sha256 } as const;

test('an order needs two different accounts, an item, a positive count and a window', () => {
    expect(validOrder(order({}))).toBe(true);
    expect(validOrder(order({ to: 'giver' }))).toBe(false);
    expect(validOrder(order({ count: 0 }))).toBe(false);
    expect(validOrder(order({ end: 1000 }))).toBe(false);
});

test('an expired or unsupported order window starts no post-login work', async () => {
    expect(typeof runOrderWork).toBe('function');
    let actions = 0;
    for (const end of [2199, 2200, NaN, Infinity, -Infinity, 2200 + 2147483648]) {
        await expect(runOrderWork(order({ end }), async () => { actions++; }, () => 2200))
            .rejects.toThrow('order window');
    }
    expect(actions).toBe(0);
    expect(await runOrderWork(order({ end: 2200 + 2147483647 }), async () => 'supported', () => 2200)).toBe('supported');
});

test('order expiry cancels a pending SDK action and blocks a late continuation while cleanup can dispatch', async () => {
    expect(typeof runOrderWork).toBe('function');
    const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
    const internal = sdk as any, packets: unknown[] = [];
    internal.connectionState = 'connected';
    internal.ws = { readyState: WebSocket.OPEN };
    internal.send = (message: unknown) => { packets.push(message); };
    let resume!: () => void, late!: Promise<unknown>;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    try {
        await expect(runOrderWork(order({ end: 2230 }), async () => {
            late = (async () => { await paused; return sdk.sendWalk(3202, 3200); })();
            await sdk.sendWalk(3201, 3200);
            await sdk.sendWalk(3203, 3200);
        }, () => 2200)).rejects.toThrow('order window ended');
        expect(packets).toHaveLength(1);
        expect(internal.pendingActions.size).toBe(0);
        resume();
        await expect(late).rejects.toThrow('Deadline exceeded');
        expect(packets).toHaveLength(1);
        expect(executionContext.getStore()).toBeUndefined();
        let end!: (event: { reason: string }) => void;
        const ended = new Promise<{ reason: string }>(resolve => { end = resolve; });
        internal.send = (message: any) => {
            packets.push(message);
            queueMicrotask(() => {
                internal.pendingActions.get(message.actionId)?.resolve({ success: true });
                end({ reason: 'logged-out' });
            });
        };
        expect(await logoutAction({ sdk, ended }, 1000)).toBe('logged-out');
        expect(packets).toHaveLength(2);
    } finally {
        resume?.();
    }
});

test('expiry keeps uncertain and partial trade progress for reconciliation outside the cancelled scope', async () => {
    for (const progress of [{ uncertain: false, count: 0 }, { uncertain: true, count: 0 },
        { uncertain: false, count: 250, inventory: { before: 0, after: 250 } }]) {
        let disposed = false;
        await expect(runOrderWork(order({ end: 2220 }), () =>
            executionWait(() => () => { disposed = true; }), () => 2200)).rejects.toThrow('order window ended');
        expect(disposed).toBe(true);
        expect(executionContext.getStore()).toBeUndefined();
        const receipt = fleetTradeOutcome(claimedReceipt(), progress, false, logout, attemptId, 2500, 'deadline');
        expect(receipt.state).toBe(progress.uncertain || progress.count ? 'reconcile' : 'failed');
        expect(receipt.count).toBe(progress.count);
        expect(receipt.inventory).toEqual(progress.inventory);
        expect(receipt.logout?.attemptId).toBe(attemptId);
        expect(receipt.ok).toBe(false);
    }
});

test('transfer needs a matching partner, observed exact item delta, bank credit, and this session logout', async () => {
    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    for (const mode of ['ok', 'wrong peer', 'bank failure', 'ambiguous timeout'] as const) {
        let pack = [{ ...item, count: 5 }], calls = 0;
        const fake = {
            sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
            bot: {
                trade: async () => {
                    calls++;
                    pack = [{ ...item, count: 505 }];
                    return mode === 'ambiguous timeout' ? { success: false, partner: 'Giver', reason: 'timeout', received: [], gave: [] }
                        : { success: true, partner: mode === 'wrong peer' ? 'Other' : 'Giver', received: [item], gave: [] };
                },
                openBank: async () => ({ success: true }), closeBank: async () => ({ success: true }),
            },
            ended: new Promise(() => {}), bankObservation: () => ({ at: 2300 }),
        } as unknown as Session;
        const progress = { uncertain: false, count: 0 };
        const run = runOrderWork(order({}), () => performFleetTransfer(fake, order({}), 'to', progress, {
            now: () => 2200, wait: async (_s, predicate) => predicate(null),
            deposit: async () => { if (mode === 'bank failure') throw Error('bank unavailable'); pack = []; return 505; },
        }), () => 2200);
        if (mode === 'ok') await run;
        else await expect(run).rejects.toThrow(mode === 'bank failure' ? 'bank unavailable' : 'requires reconciliation');
        expect(calls).toBe(1);
        const final = fleetTradeOutcome(claimedReceipt(), progress, mode === 'ok', logout, attemptId, 2500, mode);
        expect(final.state).toBe(mode === 'ok' ? 'settled' : 'reconcile');
        expect(final.inventory).toEqual({ before: 5, after: 505 });
        if (mode === 'ok') expect(final).toEqual({
            ...claimedReceipt(), state: 'settled', ok: true, count: 500, inventory: { before: 5, after: 505 },
            bank: { count: 500, at: 2300 }, logout: { attemptId, at: 2400, sha256 }, at: 2500, detail: 'ok',
        });
        expect(terminalTradeReceipt(order({}), 'to', final, 2500)).toBe(mode === 'ok');
        expect(fleetTradeOutcome(claimedReceipt(), progress, true, logout, 'wrong attempt', 2500, 'bad logout').state).toBe('reconcile');
    }
});

test('the sender ends its serving window after the first observed trade outcome', async () => {
    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    for (const ambiguous of [false, true]) {
        let pack = [item];
        const fake = {
            sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
            bot: {
                serveTrades: async (opts: Parameters<Session['bot']['serveTrades']>[0]) => {
                    pack = [];
                    const result = { success: !ambiguous, partner: 'Taker', message: '', gave: ambiguous ? [] : [item], received: [] };
                    opts!.onTrade!(result);
                    expect(opts!.until!()).toBe(true);
                    return { trades: [result] };
                },
            },
        } as unknown as Session;
        const progress = { uncertain: false, count: 0 };
        const run = performFleetTransfer(fake, order({}), 'from', progress, {
            now: () => 2200, wait: async (_s, predicate) => predicate(null),
        });
        if (ambiguous) await expect(run).rejects.toThrow('requires reconciliation');
        else await run;
        const final = fleetTradeOutcome(claimedReceipt('from'), progress, !ambiguous,
            { ...logout, account: 'Giver' }, attemptId, 2500, 'observed');
        expect(final.state).toBe(ambiguous ? 'reconcile' : 'settled');
        expect(final.inventory).toEqual({ before: 500, after: 0 });
    }
});

test('a full receiver banks the jug before accepting fire runes and preserves its cakes, coins and kit', async () => {
    const fire = { id: 554, name: 'Fire rune', count: 250, slot: 0 };
    let pack = [
        ...Array.from({ length: 23 }, (_, slot) => ({ id: 1895, name: 'Slice of cake', count: 1, slot })),
        ...Array.from({ length: 3 }, (_, slot) => ({ id: 1891, name: 'Cake', count: 1, slot: slot + 23 })),
        { id: 1935, name: 'Jug', count: 1, slot: 26 }, { id: 995, name: 'Coins', count: 800, slot: 27 },
    ];
    const held = structuredClone(pack), equipment = [{ id: 1387, name: 'Staff of fire', count: 1, slot: 3 }];
    let generation = 1, opened = false, trades = 0;
    const bank: { id: number; name: string; count: number }[] = [];
    const actions: string[] = [];
    const fake = {
        name: 'Taker', tick: () => 10, ended: new Promise(() => {}),
        client: { objType: (id: number) => ({ stackable: [554, 995].includes(id) }) },
        sdk: { getState: () => ({ inventory: pack, equipment }), getInventory: () => pack },
        bankObservation: () => opened ? { generation, at: 2300, items: bank } : undefined,
        bot: {
            openBank: async () => { opened = true; actions.push('open bank'); return { success: true }; },
            closeBank: async () => { opened = false; actions.push('close bank'); return { success: true }; },
            depositItem: async (item: { id: number; name: string }) => {
                const count = pack.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0);
                bank.push({ id: item.id, name: item.name, count });
                pack = pack.filter(i => i.id !== item.id); generation++; actions.push(`deposit ${item.id}`);
                return { success: true };
            },
            trade: async (_peer: RegExp, opts: Parameters<Session['bot']['trade']>[1]) => {
                trades++; actions.push('trade'); expect(opened).toBe(false);
                const accepted = opts!.accept!([fire]);
                if (!accepted || pack.length === 28) {
                    return { success: false, partner: 'Giver', reason: 'no_space',
                        message: "You don't have enough inventory space for this trade.", gave: [], received: [] };
                }
                pack.push(fire);
                return { success: true, partner: 'Giver', gave: [], received: [fire] };
            },
        },
    } as unknown as Session;
    const progress = { uncertain: false, count: 0 };
    await performFleetTransfer(fake, order({ item: 'Fire rune', count: 250 }), 'to', progress,
        { now: () => 2200, wait: async (_s, predicate) => predicate(null) });
    expect(trades).toBe(1);
    expect(actions).toEqual(['open bank', 'deposit 1935', 'close bank', 'trade', 'open bank', 'deposit 554', 'close bank']);
    expect(pack).toEqual(held.filter(i => i.id !== 1935));
    expect(bank).toEqual([{ id: 1935, name: 'Jug', count: 1 }, { id: 554, name: 'Fire rune', count: 250 }]);
    expect(equipment).toEqual([{ id: 1387, name: 'Staff of fire', count: 1, slot: 3 }]);
    expect(progress).toMatchObject({ count: 250, inventory: { before: 0, after: 250 }, bank: { count: 250, at: 2300 } });
});

test('receiver acceptance uses the current exact IDs, stackability and all incoming lines', async () => {
    const fire = { id: 554, name: 'Fire rune', count: 250, slot: 0 };
    const bones = { id: 536, name: 'Dragon bones', count: 2, slot: 1 };
    const note = { ...bones, id: 537 };
    const initial = [...Array.from({ length: 26 }, (_, slot) => ({ id: 1895, name: 'Slice of cake', count: 1, slot })),
        { ...fire, count: 5, slot: 26 }];
    let pack = [...initial.slice(0, 25), initial.at(-1)!];
    const fake = {
        client: { objType: (id: number) => id === 999999 ? undefined : ({ stackable: [554, 537].includes(id) }) },
        sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack }, ended: new Promise(() => {}),
        bot: {
            trade: async (_peer: RegExp, opts: Parameters<Session['bot']['trade']>[1]) => {
                pack = initial;
                expect(opts!.accept!([fire, bones])).toBe(false);
                expect(opts!.accept!([fire, note])).toBe(true);
                expect(opts!.accept!([fire, { ...note, id: 999999 }])).toBe(false);
                expect(opts!.accept!([fire, { ...note, count: 1 }])).toBe(false);
                pack = [...pack, { ...note, count: 7, slot: 27 }];
                expect(opts!.accept!([fire, note])).toBe(true);
                expect(opts!.accept!([fire, bones])).toBe(false);
                pack = pack.map(i => i.id === 554 ? { ...i, count: 2147483600 } : i);
                expect(opts!.accept!([fire, note])).toBe(false);
                pack = initial;
                return { success: false, partner: 'Giver', reason: 'no_space', message: 'inventory space rejected', gave: [], received: [] };
            },
        },
    } as unknown as Session;
    const progress = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(fake, order({ item: 'Fire rune', count: 250, extra: [{ item: 'Dragon bones', count: 2 }] }),
        'to', progress, { now: () => 2200 })).rejects.toThrow('requires reconciliation');
});

test('a fresh capacity loss and the SDK no_space reason remain reconciled without another trade', async () => {
    const fire = { id: 554, name: 'Fire rune', count: 250, slot: 0 };
    let pack = Array.from({ length: 27 }, (_, slot) => ({ id: 1895, name: 'Slice of cake', count: 1, slot }));
    let trades = 0;
    const fake = {
        client: { objType: (id: number) => ({ stackable: id === 554 }) },
        sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack }, ended: new Promise(() => {}),
        bot: {
            trade: async (_peer: RegExp, opts: Parameters<Session['bot']['trade']>[1]) => {
                trades++; pack = [...pack, { id: 1935, name: 'Jug', count: 1, slot: 27 }];
                expect(opts!.accept!([fire])).toBe(false);
                return { success: false, partner: 'Giver', reason: 'no_space',
                    message: "You don't have enough inventory space for this trade.", gave: [], received: [] };
            },
        },
    } as unknown as Session;
    const progress = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(fake, order({ item: 'Fire rune', count: 250 }), 'to', progress, { now: () => 2200 }))
        .rejects.toThrow("no_space: You don't have enough inventory space for this trade.");
    expect(trades).toBe(1);
    expect(progress).toMatchObject({ uncertain: true, count: 0, inventory: { before: 0, after: 0 } });
    expect(fleetTradeOutcome(claimedReceipt(), progress, false, logout, attemptId, 2500, 'no_space').state).toBe('reconcile');
});

test('a receiver with an unobserved capacity deposit cannot open a trade', async () => {
    let trades = 0;
    const pack = Array.from({ length: 28 }, (_, slot) => ({ id: 1895, name: 'Slice of cake', count: 1, slot }));
    const fake = {
        client: { objType: (id: number) => ({ stackable: id === 554 }) },
        sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack }, bankObservation: () => ({ at: 2300 }),
        ended: new Promise(() => {}),
        bot: { openBank: async () => ({ success: true }), trade: async () => { trades++; throw Error('trade opened before capacity'); } },
    } as unknown as Session;
    const progress = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(fake, order({ item: 'Fire rune', count: 250 }), 'to', progress, {
        now: () => 2200, wait: async (_s, predicate) => predicate(null),
        deposit: async () => { throw Error('pack debit/bank credit unobserved'); },
    })).rejects.toThrow('pack debit/bank credit unobserved');
    expect(trades).toBe(0);
    expect(progress.uncertain).toBe(true);
});

test('a prepared receipt is exclusive, and only a published matched terminal receipt releases a claim', () => {
    const dir = makeTempDir('fleet-trade-settlement-');
    const prepared = claimedReceipt(), trade = order({}), file = join(dir, 'o1.to.json');
    writeTradeReceipt(dir, prepared);
    expect(() => writeTradeReceipt(dir, { ...prepared, at: 2100 })).toThrow();
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('prepared');
    const progress = { uncertain: true, count: 500, inventory: { before: 0, after: 500 }, bank: { count: 500, at: 2300 } };
    const final = fleetTradeOutcome(prepared, progress, true, logout, attemptId, 2500, 'observed');
    writeTradeReceipt(dir, final);
    expect(JSON.parse(readFileSync(file, 'utf8')).state).toBe('settled');
    const claim = { account: 'taker', server: 's', side: 'local', orderId: 'o1', role: 'to', nonce, phase: 'held', at: 2000 } as const;
    let published: TradeReceipt | null = prepared;
    const releases: string[] = [], sync = () => releasePublishedTradeClaims([claim], 'local',
        path => path.startsWith('orders/') ? trade : published, r => releases.push(r.nonce), 2600);
    expect(sync()).toBe(0);
    published = { ...final, claim: 'a'.repeat(36) };
    expect(sync()).toBe(0);
    published = final;
    expect(sync()).toBe(1);
    expect(releases).toEqual([nonce]);
});

async function receiptRenameCase(code: string, failures: number) {
    const dir = makeTempDir('fleet-receipt-replace-');
    const prepared = claimedReceipt();
    const progress = { uncertain: true, count: 500, inventory: { before: 0, after: 500 }, bank: { count: 500, at: 2300 } };
    const final = fleetTradeOutcome(prepared, progress, true, logout, attemptId, 2500, 'observed');
    const source = new URL('../../../scripts/fleet-trade-settlement.ts', import.meta.url).href;
    const child = Bun.spawn([process.execPath, '--eval', `
        import {mock} from 'bun:test';
        import {join} from 'node:path';
        const fs = await import('node:fs'), dir = ${JSON.stringify(dir)}, file = join(dir, 'o1.to.json');
        const prepared = ${JSON.stringify(prepared)}, final = ${JSON.stringify(final)};
        const rename = fs.renameSync, observed = [], nativeErrors = [];
        let attempts = 0, injected = 0;
        mock.module('node:fs', () => ({...fs, renameSync: (from, to) => {
            attempts++;
            observed.push(JSON.parse(fs.readFileSync(file, 'utf8')));
            if (injected < ${failures}) { injected++; throw Object.assign(Error('fixture receipt replacement refused'), {code: ${JSON.stringify(code)}}); }
            try { rename(from, to); } catch (failure) { nativeErrors.push(failure.code); throw failure; }
        }}));
        const {writeTradeReceipt} = await import(${JSON.stringify(source)});
        writeTradeReceipt(dir, prepared);
        let error = null;
        try { writeTradeReceipt(dir, final); }
        catch (failure) { error = {code: failure.code, message: failure.message}; }
        process.stdout.write(JSON.stringify({attempts, injected, nativeErrors, observed, error,
            receipt: JSON.parse(fs.readFileSync(file, 'utf8')), files: fs.readdirSync(dir)}));
    `], { stdout: 'pipe', stderr: 'pipe', windowsHide: true, timeout: 5000 });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw Error(stderr || `receipt fixture exited ${exitCode}`);
    return { result: JSON.parse(stdout), prepared, final };
}

test('terminal receipt publication preserves the prepared receipt while retrying transient EPERM', async () => {
    const { result, prepared, final } = await receiptRenameCase('EPERM', 2);
    expect(result.error).toBeNull();
    expect(result.injected).toBe(2);
    expect(result.attempts).toBe(result.injected + result.nativeErrors.length + 1);
    expect(result.attempts).toBeLessThanOrEqual(21);
    for (const code of result.nativeErrors) expect(['EPERM', 'EBUSY', 'EACCES']).toContain(code);
    expect(result.observed).toEqual(Array.from({ length: result.attempts }, () => prepared));
    expect(result.receipt).toEqual(final);
    expect(result.files).toEqual(['o1.to.json']);
});

test('terminal receipt publication bounds persistent EPERM and preserves its prepared receipt', async () => {
    const { result, prepared } = await receiptRenameCase('EPERM', 100);
    expect(result.error).toEqual({ code: 'EPERM', message: 'fixture receipt replacement refused' });
    expect(result.attempts).toBeGreaterThan(1);
    expect(result.attempts).toBeLessThanOrEqual(21);
    expect(result.observed).toEqual(Array.from({ length: result.attempts }, () => prepared));
    expect(result.receipt).toEqual(prepared);
    expect(result.files).toEqual(['o1.to.json']);
});

test('terminal receipt publication propagates ENOENT once and cleans its temporary file', async () => {
    const { result, prepared } = await receiptRenameCase('ENOENT', 2);
    expect(result.error).toEqual({ code: 'ENOENT', message: 'fixture receipt replacement refused' });
    expect(result.attempts).toBe(1);
    expect(result.observed).toEqual([prepared]);
    expect(result.receipt).toEqual(prepared);
    expect(result.files).toEqual(['o1.to.json']);
});

function pairedZeroTrade() {
    const base = makeTempDir('fleet-paired-zero-'), lifecycle = join(base, '.practice/session-lifecycle');
    const trade = order({ id: '1794643307780-nabtheknob-mmsmk1232-bones', server: 'rs-sdk-demo.fly.dev', from: 'NabTheKnob', to: 'mmsmk1232',
        item: 'Bones', count: 94, start: 1794643307780, end: 1794645707780 });
    let clock = trade.start + 1000;
    const claims = (['from', 'to'] as const).map((role, i) => ({ account: trade[role].toLowerCase(), server: trade.server, side: 'local', orderId: trade.id, role,
        nonce: i ? '99c89831-be5a-4746-a986-03c5c0caff82' : 'e78145d2-f894-4888-ab6d-f62aa172ce83', phase: 'held' as const, at: trade.start + 1,
        pid: process.pid, host: 'PC', checkout: 'd75eb459-50b7-40ef-9883-f7c92f3a1c80' }));
    const receipts = claims.map(claim => {
        const producer = beginSessionAttempt({ account: trade[claim.role], server: trade.server }, { root: lifecycle, now: () => ++clock,
            owner: { pid: process.pid, coordinatorRunId: null, workerRelease: 'a'.repeat(64), script: 'scripts/aio-logistics.ts', role: 'fleet-trade', participants: null, sharedClaimNonce: claim.nonce } });
        clock = Math.max(clock, Number(producer.attemptId.slice(0, 13)));
        producer.record('connected'); producer.record('ready'); producer.record('ended', 'logged-out'); producer.record('logout', 'logged-out'); producer.record('closed');
        const proof = readLogoutProof(trade[claim.role], trade.server, { root: lifecycle });
        if (proof.state !== 'confirmed') throw Error('fixture logout not confirmed');
        const held = claim.role === 'from' ? 94 : 0;
        return { version: 2, state: 'reconcile', id: trade.id, account: trade[claim.role], partner: trade[claim.role === 'from' ? 'to' : 'from'], role: claim.role,
            side: 'local', server: trade.server, item: 'Bones', requested: 94, claim: claim.nonce, count: 0, ok: false, at: ++clock,
            detail: 'Error: transfer requires reconciliation', inventory: { before: held, after: held }, screen: true,
            ...(claim.role === 'from' ? { bank: { count: 94, at: clock - 10 } } : {}),
            logout: { attemptId: proof.attemptId, at: proof.loggedOutAt, sha256: proof.receiptSha256 } } as TradeReceipt;
    });
    const files = new Map<string, any>([['orders/' + trade.id + '.json', trade], ...receipts.map(r => ['receipts/' + trade.id + '.' + r.role + '.json', r] as [string, any])]);
    const released: string[] = [];
    const now = Math.max(trade.end + 1, clock + 1);
    const release = (at = now, alive = false) => releasePublishedTradeClaims(claims, 'local', path => files.get(path), claim => released.push(claim.nonce), at,
        (claim, receipt) => confirmedTradeLogout(base, claim, receipt, () => alive), pair => { released.push(...pair.map(claim => claim.nonce)); });
    return { base, lifecycle, trade, claims, receipts, files, released, release, now };
}

test('paired zero-transfer reconciliation releases exact claims after both source-bound logouts without rewriting receipts', () => {
    const f = pairedZeroTrade();
    const raw = JSON.stringify(f.receipts);
    expect(windowClosures([f.trade], f.receipts, f.trade.end + 1).has(f.trade.id)).toBe(false);
    expect(f.release()).toBe(2);
    expect(f.released).toEqual(f.claims.map(c => c.nonce));
    expect(windowClosures([f.trade], f.receipts, f.trade.end + 1, claim => !f.released.includes(claim)).get(f.trade.id)?.state).toBe('failed');
    expect(JSON.stringify(f.receipts)).toBe(raw);
});

test('paired zero-transfer reconciliation keeps uncertain movement, identity and logout evidence held', () => {
    const faults: Record<string, (f: ReturnType<typeof pairedZeroTrade>) => void> = {
        'partner missing': f => { f.files.delete('receipts/' + f.trade.id + '.to.json'); },
        'wrong account': f => { f.receipts[1]!.account = 'Other'; },
        'wrong partner': f => { f.receipts[1]!.partner = 'Other'; },
        'wrong server': f => { f.receipts[1]!.server = 'other'; },
        'wrong nonce': f => { f.receipts[1]!.claim = nonce; },
        'crossed producer claim': f => { f.receipts[1]!.claim = nonce; f.claims[1]!.nonce = nonce; },
        'other side': f => { f.claims[1]!.side = 'cloud'; f.receipts[1]!.side = 'cloud'; },
        'missing claimed partner': f => { f.claims.splice(1, 1); },
        'missing inventory': f => { delete f.receipts[1]!.inventory; },
        'changed stack': f => { f.receipts[1]!.inventory!.after = 94; },
        'counted item': f => { f.receipts[1]!.count = 1; },
        'wrong item': f => { f.receipts[1]!.item = 'Dragon bones'; },
        'wrong request': f => { f.receipts[1]!.requested = 93; },
        'unobserved extra line': f => { f.trade.extra = [{ item: 'Coins', count: 10 }]; f.receipts.forEach(r => { r.lines = [{ item: 'Coins', requested: 10, count: 0 }]; }); },
        'changed extra stack': f => { f.trade.extra = [{ item: 'Coins', count: 10 }]; f.receipts.forEach(r => { r.lines = [{ item: 'Coins', requested: 10, count: 0, inventory: { before: 10, after: 0 } }]; }); },
        'missing logout': f => { delete f.receipts[1]!.logout; },
        'wrong producer hash': f => { f.receipts[1]!.logout!.sha256 = 'b'.repeat(64); },
        'wrong producer owner': f => { f.claims[1]!.pid++; },
        'newer unresolved producer': f => { beginSessionAttempt({ account: f.trade.to, server: f.trade.server }, { root: f.lifecycle }); },
    };
    for (const [fault, change] of Object.entries(faults)) {
        const f = pairedZeroTrade();
        change(f);
        expect(f.release(), fault).toBe(0);
        expect(f.released, fault).toEqual([]);
    }
    const f = pairedZeroTrade();
    expect(f.release(f.trade.end - 1)).toBe(0);
    expect(f.release(f.now, true)).toBe(0);
    expect(f.released).toEqual([]);
});

test('paired zero-transfer reconciliation uses one atomic callback and retries a failed batch without a partial release', () => {
    const f = pairedZeroTrade();
    const read = (path: string) => f.files.get(path), now = f.now;
    const confirmed: NonNullable<Parameters<typeof releasePublishedTradeClaims>[5]> = (claim, receipt) => confirmedTradeLogout(f.base, claim, receipt, () => false);
    let single = 0, batches = 0;
    expect(() => releasePublishedTradeClaims(f.claims, 'local', read, () => { single++; }, now, confirmed, pair => {
        expect(pair).toEqual(f.claims); batches++; throw Error('atomic push failed');
    })).toThrow('atomic push failed');
    expect(single).toBe(0); expect(batches).toBe(1); expect(f.released).toEqual([]);
    expect(releasePublishedTradeClaims(f.claims, 'local', read, () => { single++; }, now + 1, confirmed, pair => {
        batches++; f.released.push(...pair.map(claim => claim.nonce));
    })).toBe(2);
    expect(single).toBe(0); expect(batches).toBe(2);
    expect(f.released).toEqual(f.claims.map(claim => claim.nonce));
    expect(windowClosures([f.trade], f.receipts, now + 1, claim => !f.released.includes(claim)).get(f.trade.id)?.state).toBe('failed');
});

test('a dropped trade session frees its claim only when the records prove nothing moved', () => {
    const trade = order({}), late = trade.end + DROPPED_CLAIM_MS;
    const claim = { account: 'giver', server: 's', side: 'cloud', orderId: 'o1', role: 'from', nonce, phase: 'held', at: 2000 } as const;
    const own = { ...claimedReceipt('from'), side: 'cloud', state: 'reconcile', at: 2500, inventory: { before: 500, after: 500 } } as TradeReceipt;
    const partner = { ...claimedReceipt('to'), claim: '87654321-1234-1234-1234-123456789012', state: 'failed', at: 2500,
        inventory: { before: 0, after: 0 }, logout: { attemptId, at: 2400, sha256 } } as TradeReceipt;
    expect(terminalTradeReceipt(trade, 'to', partner, late)).toBe(true);
    const files = (o: Record<string, unknown>) => (path: string) => path.startsWith('orders/') ? trade : o[path] ?? null;
    const both = { 'receipts/o1.from.json': own, 'receipts/o1.to.json': partner };
    const freed = (o: Record<string, unknown>, now = late, c: any = claim, side = 'cloud') => droppedTradeClaims([c], side, files(o), now).length;
    expect(freed(both)).toBe(1);
    const died = { ...both, 'receipts/o1.from.json': { ...own, state: 'prepared', inventory: undefined } };
    expect(freed(died)).toBe(1);
    expect(freed(both, 3000, { ...claim, at: 2900 })).toBe(1);
    expect(freed(died, trade.end + DROPPED_CLAIM_MS - 1)).toBe(0);
    expect(freed(died, late, { ...claim, at: late - DROPPED_CLAIM_MS + 1 })).toBe(0);
    expect(freed({ 'receipts/o1.from.json': own })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, state: 'reconcile' } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, logout: undefined } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.to.json': { ...partner, state: 'settled', ok: true, count: 500, inventory: { before: 0, after: 500 }, bank: { count: 500, at: 2300 } } })).toBe(0);
    expect(freed({ 'receipts/o1.to.json': partner })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, claim: 'a'.repeat(36) } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, count: 500 } })).toBe(0);
    expect(freed({ ...both, 'receipts/o1.from.json': { ...own, inventory: { before: 500, after: 0 } } })).toBe(0);
    expect(freed(both, late, claim, 'local')).toBe(0);
    expect(freed(both, late, { ...claim, phase: 'released' })).toBe(0);
    const owners = { accounts: { Giver: { side: 'cloud', server: 's' }, Taker: { side: 'local', server: 's' } } };
    const soon = trade.end + UNANSWERED_GRACE_MS, fresh = { ...claim, at: soon - 1000 };
    const alone = (partnerFiles: Record<string, unknown>, ownReceipt: unknown = own, now = soon) =>
        freed({ 'receipts/o1.from.json': ownReceipt, 'owners.json': owners, ...partnerFiles }, now, fresh);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } })).toBe(1);
    expect(alone({ 'leases/local.json': { side: 'local', at: soon } })).toBe(1);
    expect(alone({ 'snapshots/local.json': { side: 'local', at: soon, accounts: [] } })).toBe(1);
    expect(alone({ 'claims/local.json': { side: 'local', at: trade.end - 1 } })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon - 1 } })).toBe(0);
    expect(alone({})).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, own, trade.end - 1)).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, state: 'prepared', inventory: undefined })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, count: 3 })).toBe(0);
    expect(alone({ 'claims/local.json': { side: 'local', at: soon } }, { ...own, inventory: { before: 500, after: 497 } })).toBe(0);
});

test('a worker that saw no trade screen frees its claim after the window, whatever the partner\'s receipt reads', () => {
    const trade = order({}), over = trade.end;
    const claim = { account: 'giver', server: 's', side: 'cloud', orderId: 'o1', role: 'from', nonce, phase: 'held', at: 2000 } as const;
    const own = { ...claimedReceipt('from'), side: 'cloud', state: 'reconcile', at: 2500, screen: false } as TradeReceipt;
    const partner = { ...claimedReceipt('to'), side: 'cloud', claim: '87654321-1234-1234-1234-123456789012', state: 'reconcile', at: 2500, screen: false } as TradeReceipt;
    const files = (o: Record<string, unknown>) => (path: string) => path.startsWith('orders/') ? trade : o[path] ?? null;
    const freed = (ownReceipt: unknown, partnerReceipt: unknown = partner, now = over) =>
        droppedTradeClaims([claim], 'cloud', files({ 'receipts/o1.from.json': ownReceipt, ...(partnerReceipt ? { 'receipts/o1.to.json': partnerReceipt } : {}) }), now).length;
    expect(freed(own)).toBe(1);
    expect(freed(own, { ...partner, state: 'prepared', screen: undefined })).toBe(1);
    expect(freed(own, { ...partner, screen: true })).toBe(1);
    expect(freed(own, null)).toBe(1);
    expect(freed(own, partner, over - 1)).toBe(0);
    expect(freed({ ...own, screen: true })).toBe(0);
    expect(freed({ ...own, screen: undefined })).toBe(0);
    expect(freed({ ...own, state: 'prepared' })).toBe(0);
    expect(freed({ ...own, count: 1 })).toBe(0);
    expect(freed({ ...own, inventory: { before: 500, after: 499 } })).toBe(0);
    expect(freed({ ...own, claim: 'a'.repeat(36) })).toBe(0);
});

test('the trade worker records whether a trade screen was ever open', () => {
    let state: { trade?: { isOpen: boolean } } | null = null, tick = () => {};
    const s = { onTick: (cb: () => void) => { tick = cb; return () => {}; }, sdk: { getState: () => state } };
    const progress: Parameters<typeof watchTradeScreen>[1] = { uncertain: false, count: 0 };
    watchTradeScreen(s, progress);
    expect(progress.screen).toBeUndefined();
    state = {}; tick();
    expect(progress.screen).toBeUndefined();
    expect('screen' in fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut')).toBe(false);
    state = { trade: { isOpen: false } }; tick();
    expect(progress.screen).toBe(false);
    expect(fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut')).toMatchObject({ state: 'reconcile', count: 0, screen: false });
    state = { trade: { isOpen: true } }; tick();
    state = { trade: { isOpen: false } }; tick();
    expect(progress.screen).toBe(true);
    expect(fleetTradeOutcome(claimedReceipt(), progress, false, { state: 'none' } as any, attemptId, 2500, 'cut').screen).toBe(true);
});

test('each side picks its own open order once, in or near its window', () => {
    const o = order({}), r: Receipt = { id: 'o1', account: 'Giver', role: 'from', side: 'local', ok: true, count: 500, at: 2000, detail: '' };
    expect(pickOrder([o], [], 'giver', 2000)).toEqual({ order: o, role: 'from' });
    expect(pickOrder([o], [], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [r], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [r], 'Taker', 2000)?.role).toBe('to');
    expect(pickOrder([o], [], 'Giver', 6000)).toBeNull();
    expect(pickOrder([order({ start: 10 * 60_000 + 3000, end: 10 * 60_000 + 9000 })], [], 'Giver', 2000)).toBeNull();
    expect(pickOrder([o], [], 'Stranger', 2000)).toBeNull();
});

test('trade admission rereads pauses, assignments and producer ownership after the order wait', () => {
    const base = makeTempDir('fleet-trade-admission-');
    const practice = join(base, '.practice'), liveDir = join(practice, 'live');
    const planFile = join(practice, 'cloud.json'), stateFile = join(liveDir, 'fleet-state.json'), receipts = join(base, 'receipts'), orders = join(base, 'orders');
    const live = 'rs-sdk-demo.fly.dev', trade = order({ server: live });
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(orders);
    writeFileSync(planFile, '{"jobs":[]}');
    const admit = (now = 2000, server = live) => assertTradeAdmission(trade, 'Giver', server, { base, planFile, receipts, orders, now, starts: () => null });
    expect(() => admit(999)).toThrow('order window');
    // The order file is gone: scripts/fleet-order.ts --withdraw deleted it.
    expect(() => admit()).toThrow('order withdrawn');
    writeFileSync(join(orders, 'o1.json'), JSON.stringify(trade));
    expect(() => admit()).not.toThrow();
    const stop = join(practice, 'stop-giver');
    writeFileSync(stop, 'owner pause');
    expect(admit).toThrow('owner stop file');
    unlinkSync(stop);
    const stopAll = join(practice, 'stop-swarm');
    writeFileSync(stopAll, 'owner pause');
    expect(admit).toThrow('swarm is paused');
    unlinkSync(stopAll);
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"worker.ts","enabled":true}]}');
    expect(admit).toThrow('enabled swarm job');
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"worker.ts","enabled":false}]}');
    expect(admit).not.toThrow();
    writeFileSync(planFile, '{"jobs":[{"accounts":["Other","Giver"],"script":"worker.ts","enabled":true}]}');
    expect(admit).toThrow('enabled swarm job');
    writeFileSync(planFile, '{"jobs":[]}');
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, accounts: { giver: { paused: true } } }));
    expect(admit).toThrow('paused for controller rollout');
    writeFileSync(stateFile, JSON.stringify({ schemaVersion: 1, accounts: {} }));
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","goal":"Fresh-clock specialist","enabled":false}]}');
    expect(admit).toThrow('reserved account');
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","role":"pvp","goal":"reserved: gang squad (Goondelf, Ligma, Sugma), staged at Edgeville","enabled":false,"trades":true}]}');
    expect(admit).not.toThrow();
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","role":"pvp","goal":"reserved: gang squad","enabled":false}]}');
    expect(admit).toThrow('reserved account');
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","goal":"reserved","enabled":false,"trades":"yes"}]}');
    expect(admit).toThrow('reserved account');
    writeFileSync(planFile, '{"jobs":[{"account":"Giver","script":"","goal":"Fresh-clock specialist","enabled":false,"trades":true}]}');
    expect(admit).toThrow('reserved account');
    writeFileSync(planFile, '{"jobs":[]}');
    expect(() => admit(5000)).toThrow('order window');
    expect(() => admit(2000, 'localhost:8888')).toThrow('order server');
    const swarmRuns = join(practice, 'swarm-runs.json');
    writeFileSync(swarmRuns, JSON.stringify([{ accounts: ['Giver'], pid: process.pid }]));
    expect(admit).toThrow('unsettled swarm worker');
    unlinkSync(swarmRuns);
    const attempt = beginSessionAttempt({ account: 'Giver', server: live }, { root: join(practice, 'session-lifecycle'), now: () => 1500 });
    expect(admit).toThrow('account logout is not confirmed');
    attempt.record('ended', 'logged-out');
    expect(admit).not.toThrow();
    mkdirSync(receipts);
    writeFileSync(join(receipts, 'o1.from.json'), '{"id":"o1","role":"from"}');
    expect(admit).toThrow('order receipt');
    writeFileSync(planFile, '{}');
    expect(admit).toThrow('invalid swarm plan');
});

test('trade admission passes a swarm run whose pid a later process holds', () => {
    const base = makeTempDir('fleet-trade-pid-');
    const practice = join(base, '.practice'), planFile = join(practice, 'cloud.json'), receipts = join(base, 'receipts'), orders = join(base, 'orders');
    const live = 'rs-sdk-demo.fly.dev', trade = order({ server: live }), started = 1_000_000;
    mkdirSync(practice, { recursive: true });
    mkdirSync(orders);
    writeFileSync(join(orders, 'o1.json'), JSON.stringify(trade));
    writeFileSync(planFile, '{"jobs":[]}');
    writeFileSync(join(practice, 'swarm-runs.json'), JSON.stringify([{ accounts: ['Other'], pid: process.pid, started: 5 }, { accounts: ['Giver'], pid: process.pid, started }]));
    const reads: number[][] = [];
    const admit = (table: Map<number, number> | null) => assertTradeAdmission(trade, 'Giver', live, { base, planFile, receipts, orders, now: 2000, starts: pids => { reads.push([...pids]); return table; } });
    expect(() => admit(new Map([[process.pid, started - 40]]))).toThrow('unsettled swarm worker');
    expect(() => admit(null)).toThrow('unsettled swarm worker');
    expect(() => admit(new Map())).toThrow('unsettled swarm worker');
    expect(() => admit(new Map([[process.pid, started + 60_000]]))).not.toThrow();
    expect(reads).toEqual([[process.pid], [process.pid], [process.pid], [process.pid]]);
});

test('an order is only made between listed accounts on one server', () => {
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['far', { side: 'cloud' as const, server: 't' }]]);
    const o = makeOrder('Giver', 'Taker', 500, 'Lobster', 0, 15, 40, owners);
    expect(o).toMatchObject({ from: 'Giver', to: 'Taker', count: 500, item: 'Lobster', start: 900_000, end: 3_300_000, server: 's' });
    expect(() => makeOrder('Giver', 'Nobody', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
    expect(() => makeOrder('Giver', 'Far', 1, 'Lobster', 0, 15, 40, owners)).toThrow();
});

test('an order of an untradeable item is refused before any account walks: the ammo mould, alone or as a --with line', () => {
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'local' as const, server: 's' }]]);
    expect(() => makeOrder('Giver', 'Taker', 1, 'Ammo mould', 0, 15, 40, owners)).toThrow('not tradeable: Ammo mould');
    expect(() => makeOrder('Giver', 'Taker', 150, 'Cannonball', 0, 15, 40, owners, undefined, [{ item: 'ammo mould', count: 1 }])).toThrow('not tradeable: ammo mould');
    expect(makeOrder('Giver', 'Taker', 150, 'Cannonball', 0, 15, 40, owners).item).toBe('Cannonball');
});

test('a snapshot holds only this side’s accounts and no credentials', () => {
    const owners = new Map([['taker', { side: 'cloud' as const, server: 's' }], ['giver', { side: 'local' as const, server: 's' }]]);
    const snap = snapshot([{ name: 'Practicebot', server: 'localhost:8888' }, { name: 'Giver', server: 's', bank: [{ id: 379, name: 'Lobster', count: 9 }], password: 'x', skills: [{ name: 'Fishing', level: 99, xp: 1 }] }, { name: 'Taker', server: 's' }], 'local', owners, 7);
    expect(snap.accounts.map(a => a.name)).toEqual(['Giver']);
    expect(JSON.stringify(snap)).not.toContain('password');
    expect(snap.accounts[0]!.skills).toEqual([{ name: 'Fishing', level: 99, xp: 1 }]);
});

test('a snapshot lists completed quests and leaves an unread journal unknown', () => {
    const owners = new Map(['read', 'none', 'unread', 'blank'].map(n => [n, { side: 'local' as const, server: 's' }]));
    const accounts = snapshot([
        { name: 'Read', server: 's', quests: [{ name: 'Cook', state: 'complete' }, { name: 'Imp', state: 'started' }] },
        { name: 'None', server: 's', quests: [{ name: 'Imp', state: 'not started' }] },
        { name: 'Unread', server: 's', quests: null },
        { name: 'Blank', server: 's', quests: [{ name: 'Imp', state: 'unknown' }] },
    ], 'local', owners, 7).accounts;
    expect(accounts.map(a => (a as { quests?: string[] }).quests)).toEqual([['Cook'], [], undefined, undefined]);
    expect(accounts.filter(a => 'quests' in a).map(a => a.name)).toEqual(['Read', 'None']);
    expect(accounts.every(a => a.questJournal === null && a.questsAt === null)).toBe(true);
});

test('the agent acts only for its own side, skips busy and running accounts, and frees the rest', () => {
    const owners = new Map([['giver', { side: 'local' as const, server: 's' }], ['taker', { side: 'cloud' as const, server: 's' }], ['busyone', { side: 'local' as const, server: 's' }]]);
    const orders = [order({}), order({ id: 'o2', from: 'BusyOne', to: 'Taker' })];
    const busy = swarmBusy([{ account: 'BusyOne', enabled: true }, { accounts: ['Other'], enabled: true }, { account: 'Giver', enabled: false }]);
    expect([...busy].sort()).toEqual(['busyone', 'other']);
    const due = dueTrades(orders, [], 'local', owners, busy, new Set(), 2000);
    expect(due.map(d => [d.account, d.order.id, d.busy])).toEqual([['Giver', 'o1', false], ['BusyOne', 'o2', true]]);
    expect(dueTrades(orders, [], 'local', owners, busy, new Set(['giver']), 2000).map(d => d.account)).toEqual(['BusyOne']);
    expect(dueTrades(orders, [], 'cloud', owners, busy, new Set(), 2000).map(d => d.account)).toEqual(['Taker']);
});

test('a side leaves the meet when its partner\'s receipt says failed, with nothing uncertain and nothing traded', async () => {
    const dir = makeTempDir('fleet-trade-partner-');
    const trade = order({});
    expect(partnerFailed(dir, trade, 'from')).toBe(false);
    writeTradeReceipt(dir, claimedReceipt('to'));
    expect(partnerFailed(dir, trade, 'from')).toBe(false);
    writeTradeReceipt(dir, { ...claimedReceipt('from'), state: 'failed', detail: 'own side' });
    expect(partnerFailed(dir, trade, 'from')).toBe(false);
    writeTradeReceipt(dir, { ...claimedReceipt('to'), state: 'failed', detail: 'route to 3182, 3440: precondition ferry needs 60 coins' });
    expect(partnerFailed(dir, trade, 'from')).toBe(true);
    expect(partnerFailed(dir, { ...trade, id: 'other' }, 'from')).toBe(false);

    const item = { id: 379, name: 'Lobster', count: 500, slot: 0 };
    let asked = 0;
    const giver = {
        sdk: { getState: () => ({ inventory: [item] }), getInventory: () => [item] },
        bot: { serveTrades: async (opts: Parameters<Session['bot']['serveTrades']>[0]) => { asked++; expect(opts!.until!()).toBe(true); return { trades: [], reason: 'until' }; } },
    } as unknown as Session;
    const giving = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(giver, order({}), 'from', giving, { now: () => 2200, gone: () => true })).rejects.toThrow('partner failed: no trade');
    expect(asked).toBe(1);
    expect(giving.uncertain).toBe(false);
    expect(fleetTradeOutcome(claimedReceipt('from'), giving, true, { ...logout, account: 'Giver' }, attemptId, 2500, 'partner failed').state).toBe('failed');

    let requests = 0;
    const taker = {
        sdk: { getState: () => ({ inventory: [] }), getInventory: () => [] },
        bot: { trade: async () => { requests++; return { success: false, reason: 'timeout', received: [], gave: [] }; } },
        ended: new Promise(() => {}),
    } as unknown as Session;
    const taking = { uncertain: false, count: 0 };
    await expect(performFleetTransfer(taker, order({}), 'to', taking, { now: () => 2200, gone: () => true })).rejects.toThrow('partner failed: no trade');
    expect(requests).toBe(0);
    expect(taking.uncertain).toBe(false);
});

const ringOrder = (o: Partial<Order> = {}) => order({ item: 'Sapphire ring', count: 40, extra: [{ item: 'Cosmic rune', count: 74 }, { item: 'Water rune', count: 40 }], ...o });
const ringReceipt = (role: 'from' | 'to'): TradeReceipt => ({
    ...claimedReceipt(role), item: 'Sapphire ring', requested: 40,
    lines: [{ item: 'Cosmic rune', requested: 74, count: 0 }, { item: 'Water rune', requested: 40, count: 0 }],
});

test('a multi-item order needs distinct lines with positive counts, at most one trade window of them', () => {
    expect(validOrder(ringOrder())).toBe(true);
    expect(validOrder(ringOrder({ extra: [] }))).toBe(false);
    expect(validOrder(ringOrder({ extra: [{ item: 'sapphire RING', count: 1 }] }))).toBe(false);
    expect(validOrder(ringOrder({ extra: [{ item: 'Cosmic rune', count: 0 }] }))).toBe(false);
    expect(validOrder(ringOrder({ extra: [{ item: ' ', count: 1 }] }))).toBe(false);
    expect(validOrder(ringOrder({ extra: Array.from({ length: 28 }, (_, i) => ({ item: `Item ${i}`, count: 1 })) }))).toBe(false);
});

test('a multi-item receiver accepts only the exact offer of every line, then banks and credits each line', async () => {
    const ring = { id: 1638, name: 'Sapphire ring', count: 40, slot: 0 }, cosmic = { id: 564, name: 'Cosmic rune', count: 74, slot: 1 };
    const water = { id: 555, name: 'Water rune', count: 40, slot: 2 };
    for (const mode of ['ok', 'one line short'] as const) {
        let pack: typeof ring[] = [{ ...water, count: 2 }], accept: NonNullable<Parameters<Session['bot']['trade']>[1]>['accept'];
        const got = mode === 'ok' ? [ring, cosmic, water] : [ring, cosmic, { ...water, count: 39 }];
        const fake = {
            client: { objType: (id: number) => ({ stackable: [1638, 564, 555].includes(id) }) },
            sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
            bot: {
                trade: async (_peer: RegExp, opts: { accept: typeof accept }) => {
                    accept = opts.accept;
                    pack = [{ ...ring }, { ...cosmic }, { ...water, count: 2 + got[2]!.count }];
                    return { success: true, partner: 'Giver', received: got, gave: [] };
                },
                openBank: async () => ({ success: true }), closeBank: async () => ({ success: true }),
            },
            ended: new Promise(() => {}), bankObservation: () => ({ at: 2300 }),
        } as unknown as Session;
        const progress: Parameters<typeof performFleetTransfer>[3] = { uncertain: false, count: 0 };
        const deposits: number[] = [];
        const run = performFleetTransfer(fake, ringOrder(), 'to', progress, {
            now: () => 2200, wait: async (_s, predicate) => predicate(null),
            deposit: async (_s, stack) => { deposits.push(stack.id); const n = pack.filter(i => i.id === stack.id).reduce((a, i) => a + i.count, 0); pack = pack.filter(i => i.id !== stack.id); return n; },
        });
        if (mode === 'ok') await run;
        else await expect(run).rejects.toThrow('requires reconciliation');
        expect(accept!([ring, cosmic, water])).toBe(true);
        expect(accept!([water, ring, cosmic])).toBe(true);
        expect(accept!([ring, cosmic])).toBe(false);
        expect(accept!([ring, { ...cosmic, count: 73 }, water])).toBe(false);
        expect(accept!([ring, cosmic, water, { id: 995, slot: 3, name: 'Coins', count: 1 }])).toBe(false);
        const final = fleetTradeOutcome(ringReceipt('to'), progress, mode === 'ok', logout, attemptId, 2500, mode);
        expect(final.state).toBe(mode === 'ok' ? 'settled' : 'reconcile');
        expect(terminalTradeReceipt(ringOrder(), 'to', final, 2500)).toBe(mode === 'ok');
        if (mode === 'ok') {
            expect(deposits).toEqual([1638, 564, 555]);
            expect(final.lines).toEqual([
                { item: 'Cosmic rune', requested: 74, count: 74, inventory: { before: 0, after: 74 }, bank: { count: 74, at: 2300 } },
                { item: 'Water rune', requested: 40, count: 40, inventory: { before: 2, after: 42 }, bank: { count: 40, at: 2300 } },
            ]);
            expect(terminalTradeReceipt(ringOrder(), 'to', { ...final, lines: final.lines!.slice(0, 1) }, 2500)).toBe(false);
            expect(terminalTradeReceipt(ringOrder(), 'to', { ...final, lines: undefined }, 2500)).toBe(false);
            expect(terminalTradeReceipt(order({ item: 'Sapphire ring', count: 40 }), 'to', final, 2500)).toBe(false);
            expect(terminalTradeReceipt(ringOrder(), 'to', { ...final, lines: [final.lines![0]!, { ...final.lines![1]!, bank: { count: 39, at: 2300 } }] }, 2500)).toBe(false);
        }
    }
});

test('a multi-item giver offers every line in one trade, and a failed line count is not settled', async () => {
    const ring = { id: 1637, name: 'Sapphire ring', count: 40, slot: 0 }, cosmic = { id: 564, name: 'Cosmic rune', count: 74, slot: 1 };
    const water = { id: 555, name: 'Water rune', count: 40, slot: 2 };
    let pack = [ring, cosmic, water], give: { item: RegExp; amount: number }[] = [];
    const fake = {
        sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
        bot: {
            serveTrades: async (opts: Parameters<Session['bot']['serveTrades']>[0]) => {
                give = opts!.give as typeof give;
                pack = [];
                const result = { success: true, partner: 'Taker', message: '', gave: [ring, cosmic, water], received: [] };
                opts!.onTrade!(result);
                return { trades: [result] };
            },
        },
    } as unknown as Session;
    const progress: Parameters<typeof performFleetTransfer>[3] = { uncertain: false, count: 0, lines: [{ count: 0, bank: { count: 74, at: 2100 } }] };
    await performFleetTransfer(fake, ringOrder(), 'from', progress, { now: () => 2200, wait: async (_s, predicate) => predicate(null) });
    expect(give.map(g => [g.item.source, g.amount])).toEqual([['^Sapphire ring$', 40], ['^Cosmic rune$', 74], ['^Water rune$', 40]]);
    const giverLogout = { ...logout, account: 'Giver' };
    const final = fleetTradeOutcome(ringReceipt('from'), progress, true, giverLogout, attemptId, 2500, 'observed');
    expect(final.state).toBe('settled');
    expect(final.lines![0]).toEqual({ item: 'Cosmic rune', requested: 74, count: 74, inventory: { before: 74, after: 0 }, bank: { count: 74, at: 2100 } });
    expect(terminalTradeReceipt(ringOrder(), 'from', final, 2500)).toBe(true);
    const short = { ...progress, lines: [progress.lines![0]!, { ...progress.lines![1]!, count: 0 }] };
    expect(fleetTradeOutcome(ringReceipt('from'), short, true, giverLogout, attemptId, 2500, 'short').state).toBe('reconcile');
});

test('a waiting taker logs in when the giver is ready, when the giver failed, or at its deadline', async () => {
    let t = 0, readyAt = 6000, failedAt = Infinity;
    const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
    const o = order({ start: 0, end: 60 * 60_000, takerWaits: true });
    expect(await waitForGiver(o, { ...clock, ready: () => t >= readyAt, failed: () => t >= failedAt })).toBe('ready');
    expect(t).toBe(6000);
    t = 0; readyAt = Infinity; failedAt = 4000;
    expect(await waitForGiver(o, { ...clock, ready: () => t >= readyAt, failed: () => t >= failedAt })).toBe('failed');
    t = 0; failedAt = Infinity;
    expect(await waitForGiver(o, { ...clock, ready: () => false, failed: () => false, maxMs: 10_000 })).toBe('deadline');
    expect(t).toBe(10_000);
    t = 0;
    expect(await waitForGiver({ ...o, end: 6 * 60_000 }, { ...clock, ready: () => false, failed: () => false })).toBe('deadline');
    expect(t).toBe(60_000);
    expect(validOrder(o)).toBe(true);
    expect(validOrder({ ...o, takerWaits: false as unknown as true })).toBe(false);
    const dir = makeTempDir('fleet-ready-');
    markGiverReady(dir, 'o1');
    expect(readFileSync(giverReadyFile(dir, 'o1'), 'utf8')).toMatch(/^\d+$/);
});

test('a trade session ends its wait once its own release moves, checking at most every interval', () => {
    let t = 0, current = 'a', reads = 0;
    const read = () => { reads++; return current; };
    const moved = releaseWatch(read, 'a', { now: () => t, everyMs: 20_000 });
    expect(moved()).toBe(false);
    current = 'b'; t = 5_000;
    expect(moved()).toBe(false);
    expect(reads).toBe(1);
    t = 20_000;
    expect(moved()).toBe(true);
    current = 'a'; t = 60_000;
    expect(moved()).toBe(true);
    expect(releaseWatch(read, undefined)()).toBe(false);
    expect(releaseWatch(() => { throw Error('missing'); }, 'a')()).toBe(false);
});

test('the live trade record maps each participant to the finite order', () => {
    const dir = makeTempDir('fleet-trade-record-');
    const o = order({ id: '1794000000000-giver-taker' });
    mkdirSync(join(dir, 'orders'), { recursive: true });
    writeFileSync(join(dir, 'orders', o.id + '.json'), JSON.stringify(o));
    for (const account of ['Giver', 'taker']) {
        const argv = [account, o.id], record = fleetTradeRecord(dir, o, account, argv, {});
        const work = botWork(account, record);
        expect(record.argv).toEqual(['fleet-trade', account, o.id]);
        expect(work.args).toEqual(['fleet-trade', join(dir, 'orders', o.id + '.json')]);
    }
    expect(() => fleetTradeRecord(dir, o, 'Stranger', ['Stranger', o.id], {})).toThrow('is not in order');
    expect(() => fleetTradeRecord(dir, order({ id: 'no-such-order' }), 'Giver', ['Giver', 'no-such-order'], {})).toThrow('no order file');
});

test('a pre-login admission failure signals the partner without writing a failed receipt, and a failed partner closes pickOrder', () => {
    const base = makeTempDir('fleet-trade-prelogin-');
    const receipts = join(base, 'receipts'), prelogin = join(base, 'prelogin-failed');
    mkdirSync(receipts, { recursive: true });
    const trade = order({ id: 'o-prelogin' });
    expect(partnerFailed(receipts, trade, 'from', prelogin)).toBe(false);
    writePreloginFailure(prelogin, {
        version: 1, id: trade.id, role: 'to', account: 'Taker', partner: 'Giver',
        server: trade.server, at: 2000, detail: 'account logout is not confirmed: Taker ended stopped',
    });
    expect(readPreloginFailure(prelogin, trade, 'to')?.account).toBe('Taker');
    expect(readPreloginFailure(prelogin, trade, 'from')).toBeNull();
    expect(partnerFailed(receipts, trade, 'from', prelogin)).toBe(true);
    expect(partnerFailed(receipts, trade, 'to', prelogin)).toBe(false);
    expect(partnerFailed(receipts, trade, 'from')).toBe(true);
    // A refusal from before this run is an earlier attempt of a partner that the agent starts again with this run.
    expect(partnerFailed(receipts, trade, 'from', prelogin, 2001)).toBe(false);
    expect(partnerFailed(receipts, trade, 'from', prelogin, 2000)).toBe(true);
    clearPreloginFailure(prelogin, trade.id, 'to');
    expect(partnerFailed(receipts, trade, 'from', prelogin)).toBe(false);
    const giverFailed = { ...claimedReceipt('from'), id: trade.id, state: 'failed' as const, detail: 'partner failed' };
    expect(pickOrder([trade], [giverFailed], 'Taker', 2000)).toBeNull();
    expect(pickOrder([trade], [claimedReceipt('from')], 'Taker', 2000)?.order.id).toBe(trade.id);
});

test('an order with exact itemId accepts its noted/unnoted itemId and rejects colliding-name wrong itemIds', async () => {
    const blackVambs = { id: 2491, name: 'Dragon vambraces', count: 1, slot: 0 };
    const notedBlackVambs = { id: 2492, name: 'Dragon vambraces', count: 2, slot: 0 };
    const greenVambs = { id: 1065, name: 'Dragon vambraces', count: 1, slot: 0 };
    expect(validOrder(order({ item: 'Dragon vambraces', count: 2, itemId: 2491 }))).toBe(true);
    expect(validOrder(order({ item: 'Dragon vambraces', count: 2, itemId: -1 }))).toBe(false);

    let pack: { id: number; name: string; count: number; slot: number }[] = [];
    const bank: { id: number; name: string; count: number }[] = [];
    const acceptedFlags: boolean[] = [];
    const receiver = {
        sdk: { getState: () => ({ inventory: pack }), getInventory: () => pack },
        client: {
            objType: (id: number) => id === 2492
                ? { stackable: true, certtemplate: 799, certlink: 2491 }
                : { stackable: false, certtemplate: -1, certlink: -1 },
        },
        bankObservation: () => ({ at: 2300 }),
        bot: {
            openBank: async () => ({ success: true }), closeBank: async () => ({ success: true }),
            trade: async (_peer: RegExp, opts: Parameters<Session['bot']['trade']>[1]) => {
                acceptedFlags.push(opts!.accept!([greenVambs, greenVambs]));
                const ok = opts!.accept!([notedBlackVambs]);
                acceptedFlags.push(ok);
                pack = [notedBlackVambs];
                return { success: true, partner: 'Giver', received: [notedBlackVambs], gave: [] };
            },
        },
        ended: new Promise(() => {}),
    } as unknown as Session;
    const blackOrder = order({ item: 'Dragon vambraces', count: 2, itemId: 2491 });
    const progress: { uncertain: boolean; count: number; bank?: { count: number; at: number } } = { uncertain: false, count: 0 };
    await performFleetTransfer(receiver, blackOrder, 'to', progress, {
        now: () => 2200, wait: async (_s, p) => p(null),
        deposit: async (_s, item) => { bank.push({ id: item.id, name: item.name, count: 2 }); pack = []; return 2; },
    });
    expect(acceptedFlags).toEqual([false, true]);
    expect(bank).toEqual([{ id: 2492, name: 'Dragon vambraces', count: 2 }]);
    expect(progress.bank).toEqual({ count: 2, at: 2300 });
    expect(blackVambs.id).toBe(2491);
});

// --- Fleet Inspect ---

function inspectFixture(mode: string) {
    let tick = 0, opened = ['stale-open', 'same-generation', 'refreshed-open'].includes(mode), generation = 7, at = mode === 'same-generation' ? 2001 : 1000, stopped = mode === 'stop-before', opens = 0, closes = 0;
    const callbacks = new Set<() => void>(), lines: string[] = [];
    const items = mode === 'empty' ? [] : [{ id: 995, name: 'Coins', count: 100470 }, { id: 1623, name: 'Uncut sapphire', count: 4 }];
    const s = {
        name: 'Fixture', tick: () => tick, onTick: (cb: () => void) => { callbacks.add(cb); return () => callbacks.delete(cb); },
        sdk: { getState: () => ({ player: { x: 3085, z: 3250, level: 0 }, skills: [], inventory: [], nearbyNpcs: mode === 'far' ? [] : [{ name: 'Banker', x: 3089, z: 3245 }], nearbyLocs: [], bank: { isOpen: opened, items } }) },
        bankObservation: () => opened && mode !== 'missing' ? { generation, at, items } : null,
        bot: {
            openBank: async () => {
                opens++;
                if (mode === 'open-fail') return { success: false };
                opened = true;
                if (['fresh', 'stop', 'stop-close', 'refreshed-open', 'empty'].includes(mode)) { generation++; at = 2001; }
                if (mode === 'old-time') generation++;
                if (mode === 'stop') stopped = true;
                return { success: true };
            },
            closeBank: async () => { closes++; opened = false; if (mode === 'stop-close') stopped = true; return { success: true }; },
        },
    } as unknown as Session;
    return { s, lines, stopped: () => stopped, counts: () => ({ opens, closes }), advance: () => { tick++; if (mode === 'delayed' && tick === 9) { generation++; at = 2001; } for (const cb of [...callbacks]) cb(); }, listeners: () => callbacks.size };
}

async function runInspect(mode: string, requireBank = true) {
    const f = inspectFixture(mode);
    const work = inspectFleetState(f.s, { requireBank, afterLoginAt: 2000, stopped: f.stopped, log: line => f.lines.push(line) })
        .then(value => ({ value }), error => ({ error: String(error) }));
    for (let i = 0; i < 40; i++) { await Promise.resolve(); f.advance(); }
    return { f, result: await work };
}

for (const mode of ['fresh', 'delayed', 'refreshed-open']) {
    test(`strict bank observation accepts a fresh generation: ${mode}`, async () => {
        const { f, result } = await runInspect(mode);
        expect(result).toEqual({ value: { generation: 8, at: 2001, items: [{ id: 995, name: 'Coins', count: 100470 }, { id: 1623, name: 'Uncut sapphire', count: 4 }] } });
        expect(f.lines).toContain('BANK_OBSERVED {"generation":8,"at":2001,"items":2}');
        expect(f.counts().closes).toBe(mode === 'refreshed-open' ? 2 : 1);
        expect(f.listeners()).toBe(0);
    });
}

for (const mode of ['far', 'open-fail', 'missing', 'stale', 'stale-open', 'same-generation', 'old-time', 'stop', 'stop-before', 'stop-close']) {
    test(`strict bank observation rejects an unproved inspection: ${mode}`, async () => {
        const { f, result } = await runInspect(mode);
        expect(result).toEqual({ error: expect.stringContaining('bank observation') });
        expect(f.lines.some(line => line.startsWith('BANK_OBSERVED '))).toBe(false);
        expect(f.listeners()).toBe(0);
        if (mode === 'far') expect(f.counts().opens).toBe(0);
    });
}

test('a freshly observed empty bank is a valid zero-item observation', async () => {
    const { f, result } = await runInspect('empty');
    expect(result).toEqual({ value: { generation: 8, at: 2001, items: [] } });
    expect(f.lines).toContain('BANK []');
    expect(f.lines).toContain('BANK_OBSERVED {"generation":8,"at":2001,"items":0}');
});

test('ordinary inspection retains success when no bank is nearby', async () => {
    const { f, result } = await runInspect('far', false);
    expect(result).toEqual({ value: null });
    expect(f.counts()).toEqual({ opens: 0, closes: 0 });
    expect(f.lines[0]).toStartWith('INSPECT ');
});

// --- Charge Glory / Cure Poison / Pray at Altar / Recover Trapped ---

test('canEnterHeroesBasement enforces Hero quest completion and basement Blue dragon danger clearance', () => {
    expect(canEnterHeroesBasement({ quests: new Set(), skills: { Hitpoints: 99 } }).ok).toBe(false);
    expect(canEnterHeroesBasement({ quests: new Set(["hero's quest"]), skills: { Hitpoints: 50, Defence: 50 } }).ok).toBe(false);
    expect(canEnterHeroesBasement({ quests: new Set(["hero's quest"]), skills: { Hitpoints: 75 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ varps: { heroquest: 15 }, skills: { Attack: 99, Strength: 99, Defence: 85, Hitpoints: 70, Prayer: 70 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ questStages: { heroquest: 15 }, skills: { Hitpoints: 80 } }).ok).toBe(true);
    expect(canEnterHeroesBasement({ unlocks: ['complete:heroquest'], skills: { Hitpoints: 80 } }).ok).toBe(true);
});

test('fountain constants match pinned m45_154 map and Heroes Guild script ids', () => {
    const objPack = readFileSync(new URL('../../../vendor/rs-sdk/server/content/pack/obj.pack', import.meta.url), 'utf8');
    const locPack = readFileSync(new URL('../../../vendor/rs-sdk/server/content/pack/loc.pack', import.meta.url), 'utf8');
    const jm2 = readFileSync(new URL('../../../vendor/rs-sdk/server/content/maps/m45_154.jm2', import.meta.url), 'utf8');
    expect(locPack).toContain(`${FOUNTAIN_ID}=fountain_of_heroes`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[0]}=amulet_of_glory`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[1]}=amulet_of_glory_1`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[2]}=amulet_of_glory_2`);
    expect(objPack).toContain(`${GLORY_UNCHARGED[3]}=amulet_of_glory_3`);
    expect(objPack).toContain(`${GLORY_4}=amulet_of_glory_4`);
    expect(jm2).toContain(`0 ${HEROES_FOUNTAIN_TILE.x - 45 * 64} ${HEROES_FOUNTAIN_TILE.z - 154 * 64}: ${FOUNTAIN_ID} `);
    expect(HEROES_FOUNTAIN_STAND).toEqual({ x: 2916, z: 9893, level: 0 });
});

test('runChargeGlory withdraws uncharged/partial glories, dips at fountain, clears objbox, and deposits glory(4)', async () => {
    let tick = 10, gen = 1, open = false, modal = false, px = FALADOR_WEST_BANK.x, pz = FALADOR_WEST_BANK.z;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => { tick++; for (const fn of [...listeners]) fn(); }, 1);
    const inv: { id: number; name: string; count: number; slot: number }[] = [];
    const bank: { id: number; name: string; count: number; slot: number }[] = [
        { id: 1704, name: 'Amulet of glory', count: 1, slot: 0 },
        { id: 1708, name: 'Amulet of glory(2)', count: 2, slot: 1 },
    ];
    const reindex = () => inv.forEach((r, idx) => { r.slot = idx; });
    const fake = {
        name: 'GloryTester',
        tick: () => tick,
        onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
        ended: new Promise(() => {}),
        bankObservation: () => open ? { generation: gen, at: tick, items: bank.map(i => ({ ...i })) } : null,
        sdk: {
            getInventory: () => inv,
            getSkill: (n: string) => ({ level: n === 'Hitpoints' ? 99 : 1, baseLevel: n === 'Hitpoints' ? 99 : 1 }),
            getState: () => ({
                player: { worldX: px, worldZ: pz, level: 0, lifeId: 1, respawnCount: 0, isDead: false },
                skills: [{ name: 'Hitpoints', baseLevel: 99, level: 99 }],
                quests: [{ name: "Hero's Quest", state: 'complete' }],
                inventory: inv,
                equipment: [],
                bank: { isOpen: open, items: bank },
                dialog: { isOpen: modal, options: modal ? [{ index: 0, text: 'Click here to continue' }] : [] },
                interface: { isOpen: false, interfaceId: -1 },
                nearbyLocs: px === HEROES_FOUNTAIN_STAND.x ? [{ id: FOUNTAIN_ID, name: 'Fountain of Heroes', x: 2917, z: 9893, distance: 1 }] : [],
            }),
        },
        client: { quests: [{ name: "Hero's Quest", complete: true }] },
        bot: {
            openBank: async () => { open = true; gen++; return { success: true }; },
            closeBank: async () => { open = false; return { success: true }; },
            dismissBlockingUI: async () => { modal = false; },
            walkTo: async (x: number, z: number) => { px = x; pz = z; return { success: true }; },
            useItemOnLoc: async (item: { slot: number }) => {
                const row = inv[item.slot]!;
                row.id = GLORY_4;
                row.name = 'Amulet of glory(4)';
                modal = true;
                return { success: true, message: 'Used Amulet of glory on Fountain of Heroes' };
            },
            withdrawItem: async (item: { id: number; name: string }, n: number) => {
                const row = bank.find(r => r.id === item.id)!;
                row.count -= n;
                if (row.count <= 0) bank.splice(bank.indexOf(row), 1);
                for (let k = 0; k < n; k++) inv.push({ id: item.id, name: item.name, count: 1, slot: inv.length });
                gen++;
                return { success: true };
            },
            depositItem: async (item: { id: number; name: string }) => {
                const matching = inv.filter(r => r.id === item.id);
                const total = matching.reduce((n, r) => n + r.count, 0);
                for (const m of matching) inv.splice(inv.indexOf(m), 1);
                reindex();
                const row = bank.find(r => r.id === item.id);
                if (row) row.count += total;
                else bank.push({ id: item.id, name: item.name, count: total, slot: bank.length });
                gen++;
                return { success: true };
            },
        },
    } as unknown as Session;
    try {
        const res = await runChargeGlory(fake, { cap: 200, walk: async to => { px = to.x; pz = to.z; return { ok: true }; } });
        expect(res.ok).toBe(true);
        expect(res.charged).toBe(3);
        expect(res.bankGlory4).toBe(3);
        expect(modal).toBe(false);
    } finally {
        clearInterval(timer);
    }
});

test('antipoison family doses, pack/bank ordering and nearest bank', () => {
    expect([ITEMS.antipoison.map(dosesOf)]).toEqual([[4, 3, 2, 1, 4, 3, 2, 1]]);
    expect(chooseAntipoison([{ id: 175, count: 1 }], [{ id: 179, count: 1 }])).toEqual({ where: 'pack', id: 175 });
    expect(chooseAntipoison([{ id: 175, count: 1 }, { id: 177, count: 1 }, { id: 2446, count: 1 }], [])).toEqual({ where: 'pack', id: 177 });
    expect(chooseAntipoison([], [{ id: 2446, count: 2 }, { id: 177, count: 1 }])).toEqual({ where: 'bank', id: 177 });
    expect(chooseAntipoison([{ id: 385, count: 20 }], [{ id: 175, count: 0 }])).toBeNull();
    expect(chooseAntipoison([], [])).toBeNull();
    expect(nearestBank({ x: 3197, z: 3436 }).bank).toBe('varrock-west');
    expect(nearestBank({ x: 3092, z: 3497 }).bank).toBe('edgeville');
    expect(nearestBank({ x: 2620, z: 3330 }).bank).toBe('ardougne-north');
});

test('ALTAR is read from argument else env and nearest safe altar wins', () => {
    expect(altarText(['ALTAR=3253,3486'], undefined)).toBe('3253,3486');
    expect(altarText([], '3253,3486')).toBe('3253,3486');
    expect(altarText(['ALTAR=2932,3513'], '3253,3486')).toBe('2932,3513');
    expect(altarText([], undefined)).toBeUndefined();
    expect(altarText([], '')).toBeUndefined();
    expect(parseAltar(altarText(['ALTAR=3253,3486'], undefined))?.label).toBe('Varrock east church');
    expect(nearestAltar({ x: 3094, z: 3491, level: 0 }).label).toBe('Varrock east church');
    expect(nearestAltar({ x: 3240, z: 3210, level: 0 }).label).toBe('Lumbridge church');
    expect(nearestAltar({ x: 3239, z: 3609, level: 0 }).label).toBe('Varrock east church');
    expect(SAFE_ALTARS.some(inWilderness)).toBe(false);
    expect(PRAYER_ALTARS.filter(inWilderness).map(a => a.label)).toEqual(['Wilderness chaos temple']);
    expect(parseAltar('3239,3608')?.label).toBe('Wilderness chaos temple');
    expect(parseAltar('3253,3486')?.label).toBe('Varrock east church');
    expect(parseAltar(undefined)).toBeUndefined();
    expect(() => parseAltar('1,2')).toThrow('not in PRAYER_ALTARS');
    expect(new Set(PRAYER_ALTARS.map(a => a.id))).toEqual(new Set([61, 409, 410, 411]));
});

function mockLabelsForOffHub(areaIdByTile: (x: number, z: number) => number): Labels {
    return {
        area: (_l, x, z) => areaIdByTile(x, z),
        areas: 4,
        tiles: 10,
        zones: { size: 0, keys: function* () {} },
        cells: new Uint16Array(0),
        zoneKeys: new Int32Array(0),
    };
}

function makeRecoverySession(initialPos: { worldX: number; worldZ: number; level: number }) {
    let player = { ...initialPos, lifeId: 1, respawnCount: 0, isDead: false };
    let tick = 0;
    const listeners = new Set<() => void>();
    const timer = setInterval(() => {
        tick++;
        for (const cb of [...listeners]) cb();
    }, 2);
    const fenceLoc = {
        id: FLUFFS_FENCE.id,
        name: 'Fence',
        x: FLUFFS_FENCE.x,
        z: FLUFFS_FENCE.z,
        distance: 1,
        optionsWithIndex: [{ text: 'Squeeze-through', opIndex: 1 }],
    };
    const actions: string[] = [];
    const s: any = {
        tick: () => tick,
        onTick: (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        sdk: {
            getState: () => ({
                player,
                nearbyLocs: player.level === 0 && player.worldZ >= 3493 && player.worldZ <= 3517 ? [fenceLoc] : [],
                nearbyNpcs: [],
            }),
            getDialog: () => ({ isOpen: false, options: [] }),
            sendClickDialog: async () => {},
        },
        bot: {
            skipTutorial: async () => ({ success: true }),
            walkTo: async (x: number, z: number, level = 0) => {
                actions.push(`walkTo:${x},${z},${level}`);
                player = { ...player, worldX: x, worldZ: z, level };
                return { success: true };
            },
            interactLoc: async (loc: any) => {
                actions.push(`interactLoc:${loc.id}@${loc.x},${loc.z}`);
                if (loc.id === FLUFFS_FENCE.id) {
                    player = { ...player, worldX: FLUFFS_FENCE.x, worldZ: FLUFFS_FENCE.z - 1, level: 0 };
                }
                return { success: true };
            },
        },
        setPos(x: number, z: number, level = 0) {
            player = { ...player, worldX: x, worldZ: z, level };
        },
        dispose() {
            clearInterval(timer);
        },
    };
    return { s, actions };
}

describe('recover-trapped off_hub_area and Lumber Yard handling', () => {
    test('recovers off_hub_area positions instead of misclassifying them as mainland hub ok', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => {
            if (x === 3013 && z === 3355) return 21;
            if (x === 3185 && z === 3436) return 21;
            if (x === 2930 && z === 9848) return 2497;
            if (x === 2931 && z === 9853) return 2497;
            if (x === 2933 && z === 3151) return 1610;
            return 21;
        });

        for (const [pos, expectedHub] of [
            [{ worldX: 2930, worldZ: 9848, level: 0 }, '3013,3355,0'],
            [{ worldX: 2931, worldZ: 9853, level: 0 }, '3013,3355,0'],
            [{ worldX: 2933, worldZ: 3151, level: 0 }, '3013,3355,0'],
        ] as const) {
            const { s } = makeRecoverySession(pos);
            let walks = 0;
            try {
                const res = await recoverSessionToHub(s, {
                    capTicks: 200,
                    labels,
                    hubAreas,
                    walkToHub: async (_sess, target) => {
                        walks++;
                        s.setPos(target.x, target.z, target.level);
                        return { ok: true };
                    },
                });
                expect(walks).toBe(1);
                expect(res.ok).toBe(true);
                expect(res.kind).toBe('off_hub_area');
                expect(res.to).toBe(expectedHub);
            } finally {
                s.dispose();
            }
        }
    });

    test('exits Lumber Yard via FLUFFS_FENCE (2618) before routing to Varrock West bank', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => (x === 3298 && z === 3513 ? 1463 : 21));
        const { s, actions } = makeRecoverySession({ worldX: 3298, worldZ: 3513, level: 0 });
        try {
            let walkStartZ = -1;
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                labels,
                hubAreas,
                walkToHub: async (_sess, target) => {
                    walkStartZ = s.sdk.getState().player.worldZ;
                    s.setPos(target.x, target.z, target.level);
                    return { ok: true };
                },
            });
            expect(res.ok).toBe(true);
            expect(res.kind).toBe('lumber_yard');
            expect(res.from).toBe('3298,3513,0');
            expect(res.to).toBe('3185,3436,0');
            expect(walkStartZ).toBe(FLUFFS_FENCE.z - 1);
            expect(actions).toEqual([
                `walkTo:${FLUFFS_FENCE.x},${FLUFFS_FENCE.z + 1},0`,
                `interactLoc:${FLUFFS_FENCE.id}@${FLUFFS_FENCE.x},${FLUFFS_FENCE.z}`,
            ]);
        } finally {
            s.dispose();
        }
    });

    test('a Lumber Yard tile in a hub area is stranded and recovery climbs the fence before the hub walk', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub(() => 21);
        const pos = { worldX: 3312, worldZ: 3511, level: 0 };
        const cls = classifyLocation(pos, { labels, hubAreas });
        expect(cls.kind).toBe('lumber_yard');
        expect(cls.autoFixable).toBe(true);
        expect(cls.targetHub).toEqual({ x: 3185, z: 3436, level: 0 });
        expect(classifyLocation({ worldX: FLUFFS_FENCE.x, worldZ: FLUFFS_FENCE.z - 1, level: 0 }, { labels, hubAreas }).kind).toBe('ok');
        const { s, actions } = makeRecoverySession(pos);
        try {
            let walkStartZ = -1;
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                labels,
                hubAreas,
                walkToHub: async (_sess, target) => {
                    walkStartZ = s.sdk.getState().player.worldZ;
                    s.setPos(target.x, target.z, target.level);
                    return { ok: true };
                },
            });
            expect(res.ok).toBe(true);
            expect(res.kind).toBe('lumber_yard');
            expect(walkStartZ).toBe(FLUFFS_FENCE.z - 1);
            expect(actions).toContain(`interactLoc:${FLUFFS_FENCE.id}@${FLUFFS_FENCE.x},${FLUFFS_FENCE.z}`);
        } finally {
            s.dispose();
        }
    });

    test('exitLumberYard climbs out of the yard and does nothing outside it', async () => {
        const inside = makeRecoverySession({ worldX: 3312, worldZ: 3511, level: 0 });
        try {
            await exitLumberYard(inside.s);
            expect(inside.s.sdk.getState().player.worldZ).toBe(FLUFFS_FENCE.z - 1);
            expect(inside.actions.at(-1)).toBe(`interactLoc:${FLUFFS_FENCE.id}@${FLUFFS_FENCE.x},${FLUFFS_FENCE.z}`);
        } finally {
            inside.s.dispose();
        }
        const outside = makeRecoverySession({ worldX: 3185, worldZ: 3436, level: 0 });
        try {
            await exitLumberYard(outside.s);
            expect(outside.actions).toEqual([]);
        } finally {
            outside.s.dispose();
        }
    });

    test('the fleet trade worker leaves the Lumber Yard before it walks to the meet tile', () => {
        const src = readFileSync(join(import.meta.dir, '../src/logistics/trade.ts'), 'utf8');
        const work = src.slice(src.indexOf('await leaveElementalWorkshop(s)'));
        const exit = work.indexOf('await exitLumberYard(s)');
        expect(exit).toBeGreaterThan(0);
        expect(exit).toBeLessThan(work.indexOf('await walkTarget(s, tile'));
    });

    test('leaves walled West Ardougne by the quest exit before any walk, and reports a failed exit as location stranded', async () => {
        // The Mourner HQ tile where Biohazard exits left accounts with no walker route out; a healthy hub class there.
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub(() => 21);
        const { s } = makeRecoverySession({ worldX: 2546, worldZ: 3325, level: 0 });
        try {
            let walks = 0;
            let exits = 0;
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                labels,
                hubAreas,
                leaveWestArdougne: async () => {
                    exits++;
                    s.setPos(2559, 3267, 0);
                    return { ok: true };
                },
                walkToHub: async () => {
                    walks++;
                    return { ok: false, reason: 'no route' };
                },
            });
            expect(exits).toBe(1);
            expect(walks).toBe(0);
            expect(res.ok).toBe(true);
            expect(res.from).toBe('2546,3325,0');
            expect(res.to).toBe('2559,3267,0');
        } finally {
            s.dispose();
        }
        const stuck = makeRecoverySession({ worldX: 2546, worldZ: 3325, level: 0 });
        try {
            const res = await recoverSessionToHub(stuck.s, {
                capTicks: 200,
                labels,
                hubAreas,
                leaveWestArdougne: async () => ({ ok: false, detail: 'west ardougne exit: hq door unobserved at 2546,3325,0' }),
            });
            expect(res.ok).toBe(false);
            expect(res.detail).toMatch(/^location stranded in West Ardougne: /);
        } finally {
            stuck.s.dispose();
        }
        // With no exit given, no walk starts: the account is stranded and names the quest that exits.
        const bare = makeRecoverySession({ worldX: 2546, worldZ: 3325, level: 0 });
        try {
            let walks = 0;
            const res = await recoverSessionToHub(bare.s, {
                capTicks: 200,
                labels,
                hubAreas,
                walkToHub: async () => { walks++; return { ok: false, reason: 'no route' }; },
            });
            expect(walks).toBe(0);
            expect(res.ok).toBe(false);
            expect(res.detail).toBe('location stranded in West Ardougne: exit by quest:biohazard');
        } finally {
            bare.s.dispose();
        }
    });

    test('loads cached route-areas.bin with exact or initializer-shifted compatible source hashes', async () => {
        const dir = makeTempDir('recover-trapped-');
        mkdirSync(join(dir, '.practice', 'cache'), { recursive: true });
        const zones: [number, number, number][] = [
            [0, 3184, 3432],
            [0, 3008, 3352],
            [0, 2616, 3328],
            [0, 2928, 9848],
        ];
        const built = labelAreas(
            zones,
            (_l, x, z) =>
                (x >= 3184 && x < 3192 && z >= 3432 && z < 3440)
                || (x >= 3008 && x < 3016 && z >= 3352 && z < 3360)
                || (x >= 2616 && x < 2624 && z >= 3328 && z < 3336)
                || (x === 2930 && z === 9848),
            (_l, _x, _z, _dx, _dz) => true,
        );
        const keyParsed = JSON.parse(pathfindingDataKey()) as Record<string, unknown>;
        const shiftedSource = JSON.stringify({ ...keyParsed, initializer: '0'.repeat(64) });
        const cacheFile = join(dir, '.practice', 'cache', 'route-areas.bin');
        writeLabels(cacheFile, shiftedSource, built);

        const ctx = loadRecoveryLocationContext(dir);
        expect(ctx.labels).toBeDefined();
        expect(ctx.hubAreas?.size).toBeGreaterThan(0);

        const { s } = makeRecoverySession({ worldX: 2930, worldZ: 9848, level: 0 });
        let walked = 0;
        try {
            const res = await recoverSessionToHub(s, {
                capTicks: 200,
                rootDir: dir,
                walkToHub: async (_sess, target) => {
                    walked++;
                    s.setPos(target.x, target.z, target.level);
                    return { ok: true };
                },
            });
            expect(walked).toBe(1);
            expect(res.ok).toBe(true);
            expect(res.kind).toBe('off_hub_area');
            expect(res.to).toBe('3013,3355,0');
        } finally {
            s.dispose();
        }

        const badDataSource = JSON.stringify({ ...keyParsed, data: 'f'.repeat(64) });
        writeLabels(cacheFile, badDataSource, built);
        expect(loadRecoveryLocationContext(dir)).toEqual({});
    });

    test('reports failure if route ends still inside an off_hub_area and does not walk healthy or Wilderness tiles', async () => {
        const hubAreas = new Set([21]);
        const labels = mockLabelsForOffHub((x, z) => (x === 3185 && z === 3436 ? 21 : 1610));

        const stuck = makeRecoverySession({ worldX: 2933, worldZ: 3151, level: 0 });
        try {
            const res = await recoverSessionToHub(stuck.s, {
                capTicks: 100,
                labels,
                hubAreas,
                walkToHub: async () => ({ ok: true }),
            });
            expect(res.ok).toBe(false);
            expect(res.kind).toBe('off_hub_area');
            expect(res.detail).toBe('ended still off_hub_area at 2933,3151,0');
        } finally {
            stuck.s.dispose();
        }

        const okHub = makeRecoverySession({ worldX: 3185, worldZ: 3436, level: 0 });
        let walks = 0;
        try {
            const res = await recoverSessionToHub(okHub.s, {
                capTicks: 100,
                labels,
                hubAreas,
                walkToHub: async () => {
                    walks++;
                    return { ok: true };
                },
            });
            expect(walks).toBe(0);
            expect(res.ok).toBe(false);
            expect(res.kind).toBe('ok');
        } finally {
            okHub.s.dispose();
        }
    });
});

type SenderDef = { stackable: boolean; certtemplate?: number; certlink?: number };
// `serverNote` is the note the server bank gives for a base item. It defaults to the base item's own client `certlink`.
const makeSender = (
    initialPack: Array<{ id: number; name: string; count: number; slot: number }>,
    initialBank: Array<{ id: number; name: string; count: number }>,
    defs: Record<number, SenderDef>,
    serverNote: (id: number) => number | undefined = id => {
        const link = defs[id]?.certlink;
        return typeof link === 'number' && link !== -1 ? link : undefined;
    },
) => {
    let pack = structuredClone(initialPack);
    const bank = structuredClone(initialBank);
    let generation = 1;
    let opened = false;
    const withdrawals: Array<{ id: number; amount: number; asNote: boolean }> = [];
    const session = {
        client: { objType: (id: number) => defs[id] },
        sdk: {
            getInventory: () => pack,
            getState: () => ({ inventory: pack, bank: { items: bank } }),
        },
        bankObservation: () => (opened ? { generation, at: 2300, items: bank } : undefined),
        bot: {
            openBank: async () => { opened = true; return { success: true }; },
            closeBank: async () => { opened = false; return { success: true }; },
            depositItem: async (row: { id: number; name: string }) => {
                const count = pack.filter(r => r.id === row.id).reduce((n, r) => n + r.count, 0);
                if (count > 0) {
                    const existing = bank.find(b => b.id === row.id);
                    if (existing) existing.count += count;
                    else bank.push({ id: row.id, name: row.name, count });
                    pack = pack.filter(r => r.id !== row.id);
                }
                generation++;
                return { success: true };
            },
            withdrawItem: async (target: { id: number; name: string }, amount: number, opts: { asNote?: boolean } = {}) => {
                const asNote = opts.asNote ?? false;
                withdrawals.push({ id: target.id, amount, asNote });
                const row = bank.find(b => b.id === target.id)!;
                const def = defs[target.id];
                const note = asNote && def?.stackable !== true ? serverNote(target.id) : undefined;
                const outId = note ?? target.id;
                const outStackable = def?.stackable === true || note !== undefined;
                const slotsNeeded = outStackable
                    ? (pack.some(r => r.id === outId) ? 0 : 1)
                    : amount;
                if (28 - pack.length < slotsNeeded) {
                    return { success: false, message: 'inventory full' };
                }
                row.count -= amount;
                if (outStackable) {
                    const existing = pack.find(r => r.id === outId);
                    if (existing) existing.count += amount;
                    else pack.push({ id: outId, name: target.name, count: amount, slot: pack.length });
                } else {
                    for (let k = 0; k < amount; k++) {
                        pack.push({ id: outId, name: target.name, count: 1, slot: pack.length });
                    }
                }
                generation++;
                return { success: true };
            },
        },
    } as unknown as Session;
    return { session, getPack: () => pack, getOpened: () => opened, withdrawals };
};

test('prepareFleetSender frees full 28-slot packs before withdrawing noted or unnoteable items', async () => {
    const defs: Record<number, SenderDef> = {
        1925: { stackable: false, certtemplate: -1, certlink: 1926 },
        1436: { stackable: false, certtemplate: -1, certlink: 1437 },
        556: { stackable: true, certtemplate: -1, certlink: -1 },
        175: { stackable: false, certtemplate: -1, certlink: 176 },
        176: { stackable: false, certtemplate: 799, certlink: 175 },
        772: { stackable: false, certtemplate: -1, certlink: -1 },
    };

    // Case 1: Full 28/28 pack (TheFullMonty scenario) withdraws noted Antipoison(3) after depositing Rune essence clutter.
    const fullPack = [
        { id: 1925, name: 'Bucket', count: 1, slot: 0 },
        ...Array.from({ length: 26 }, (_, k) => ({ id: 1436, name: 'Rune essence', count: 1, slot: k + 1 })),
        { id: 556, name: 'Air rune', count: 6, slot: 27 },
    ];
    const sender1 = makeSender(fullPack, [{ id: 175, name: 'Antipoison(3)', count: 3 }], defs);
    const prog1: { uncertain: boolean; count: number; bank?: { count: number; at: number } } = { uncertain: false, count: 0 };
    await prepareFleetSender(
        sender1.session,
        order({ item: 'Antipoison(3)', itemId: 175, count: 3 }),
        prog1,
        async (_s, pred) => pred(null),
    );
    expect(sender1.getOpened()).toBe(false);
    expect(prog1.uncertain).toBe(false);
    expect(prog1.bank).toEqual({ count: 3, at: 2300 });
    expect(sender1.withdrawals).toEqual([{ id: 175, amount: 3, asNote: true }]);
    expect(sender1.getPack().find(r => r.id === 176)?.count).toBe(3);

    // Case 2: Unnoteable multi-item (certlink: -1) with 26/28 pack reserves 3 slots and withdraws unnoted.
    const almostFull = [
        { id: 1925, name: 'Bucket', count: 1, slot: 0 },
        ...Array.from({ length: 25 }, (_, k) => ({ id: 1436, name: 'Rune essence', count: 1, slot: k + 1 })),
    ];
    const sender2 = makeSender(almostFull, [{ id: 772, name: 'Dramen staff', count: 3 }], defs);
    const prog2: { uncertain: boolean; count: number; bank?: { count: number; at: number } } = { uncertain: false, count: 0 };
    await prepareFleetSender(
        sender2.session,
        order({ item: 'Dramen staff', itemId: 772, count: 3 }),
        prog2,
        async (_s, pred) => pred(null),
    );
    expect(sender2.withdrawals).toEqual([{ id: 772, amount: 3, asNote: false }]);
    expect(sender2.getPack().filter(r => r.id === 772)).toHaveLength(3);

    // Case 3: Unnoteable item exceeding 28 pack slots fails cleanly before withdrawItem.
    const sender3 = makeSender([], [{ id: 772, name: 'Dramen staff', count: 30 }], defs);
    await expect(
        prepareFleetSender(
            sender3.session,
            order({ item: 'Dramen staff', itemId: 772, count: 29 }),
            { uncertain: false, count: 0 },
            async (_s, pred) => pred(null),
        ),
    ).rejects.toThrow(/sender pack full/);
    expect(sender3.withdrawals).toEqual([]);
});

test('prepareFleetSender notes a base item although the client gives the base item no certlink', async () => {
    // The client cache sets certlink only on the note. The engine packer writes the base-to-note link into the
    // server pack only. ObjType.list hands out shared objects from a ring of 10, so a held definition can change.
    class ClientObjType { static numDefinitions = 4089; id = -1; stackable = false; certtemplate = -1; certlink = -1; }
    const known: Record<number, Partial<ClientObjType>> = {
        537: { stackable: true, certtemplate: 799, certlink: 536 },
        437: { stackable: true, certtemplate: 799, certlink: 436 },
        439: { stackable: true, certtemplate: 799, certlink: 438 },
        3116: { stackable: true, certtemplate: 799, certlink: 3096 },
    };
    const ring = Array.from({ length: 10 }, () => new ClientObjType());
    let ringPos = 0;
    const objType = (id: number) => {
        if (!Number.isSafeInteger(id) || id < 0 || id >= ClientObjType.numDefinitions) throw Error(`no obj ${id}`);
        const cached = ring.find(o => o.id === id);
        if (cached) return cached;
        ringPos = (ringPos + 1) % ring.length;
        return Object.assign(ring[ringPos]!, { id, stackable: false, certtemplate: -1, certlink: -1 }, known[id]);
    };
    const defs = new Proxy({} as Record<number, SenderDef>, { get: (_t, key) => objType(Number(key)) });
    const serverNotes = new Map([[536, 537], [436, 437], [438, 439], [3096, 3116]]);
    const sender = (pack: Parameters<typeof makeSender>[0], bank: Parameters<typeof makeSender>[1]) =>
        makeSender(pack, bank, defs, id => serverNotes.get(id));
    const prepare = (s: ReturnType<typeof makeSender>, o: Partial<Order>) =>
        prepareFleetSender(s.session, order(o), { uncertain: false, count: 0 }, async (_s, pred) => pred(null));

    // CoinCock: 153 Dragon bones in one trade.
    const bones = sender([], [{ id: 536, name: 'Dragon bones', count: 200 }]);
    await prepare(bones, { item: 'Dragon bones', itemId: 536, count: 153 });
    expect(bones.withdrawals).toEqual([{ id: 536, amount: 153, asNote: true }]);
    expect(bones.getPack()).toEqual([{ id: 537, name: 'Dragon bones', count: 153, slot: 0 }]);

    // CoinCock: a second line found 7 free slots after the first line came out unnoted.
    const ores = sender([], [{ id: 436, name: 'Copper ore', count: 21 }, { id: 438, name: 'Tin ore', count: 21 }]);
    await prepare(ores, { item: 'Copper ore', itemId: 436, count: 21, extra: [{ item: 'Tin ore', itemId: 438, count: 21 }] });
    expect(ores.withdrawals).toEqual([{ id: 436, amount: 21, asNote: true }, { id: 438, amount: 21, asNote: true }]);
    expect(ores.getPack().map(r => [r.id, r.count])).toEqual([[437, 21], [439, 21]]);

    // A note that is not at base id + 1 (Iron claws 3096, note 3116).
    const claws = sender([], [{ id: 3096, name: 'Iron claws', count: 30 }]);
    await prepare(claws, { item: 'Iron claws', itemId: 3096, count: 30 });
    expect(claws.withdrawals).toEqual([{ id: 3096, amount: 30, asNote: true }]);

    // An item with no note still needs one slot per item.
    const staffs = sender([], [{ id: 772, name: 'Dramen staff', count: 30 }]);
    await expect(prepare(staffs, { item: 'Dramen staff', itemId: 772, count: 29 })).rejects.toThrow(/sender pack full: need 29 slots/);
    expect(staffs.withdrawals).toEqual([]);
});

test('partnerFailed and pickOrder treat partner reconcile receipts as terminal failures', () => {
    const dir = makeTempDir('fleet-trade-reconcile-partner-');
    const trade = order({ id: 'o-reconcile' });
    writeTradeReceipt(dir, { ...claimedReceipt('from'), id: trade.id, state: 'prepared', ok: false });
    expect(partnerFailed(dir, trade, 'to')).toBe(false);
    expect(pickOrder([trade], [JSON.parse(readFileSync(join(dir, `${trade.id}.from.json`), 'utf8'))], 'Taker', 2000)?.order.id).toBe(trade.id);

    const reconcile = { ...claimedReceipt('from'), id: trade.id, state: 'reconcile' as const, ok: false, detail: 'stock short' };
    writeTradeReceipt(dir, reconcile);
    expect(partnerFailed(dir, trade, 'to')).toBe(true);
    expect(pickOrder([trade], [reconcile], 'Taker', 2000)).toBeNull();
});

test('a giver at the meet ends when its taker on another side shows no claim or receipt after the grace', () => {
    // A giver that does not end waits at the meet until "order window ended during work" when the taker never starts.
    const receipts = makeTempDir('fleet-trade-absent-');
    let t = 1000, reads = 0, claims: { orderId: string }[] = [];
    const watch = (readClaims: () => readonly { orderId: string }[] = () => { reads++; return claims; }) =>
        absentTakerWatch({ order: { id: 'xfer-9-1' }, partner: 'Taker', partnerSide: 'cloud', receipts, readClaims, now: () => t, graceMs: 300_000, everyMs: 60_000 });
    const w = watch();
    expect(w.why()).toBeUndefined(); // not at the meet yet
    w.arrived();
    t += 299_999;
    expect(w.why()).toBeUndefined();
    expect(reads).toBe(0);
    t += 1;
    expect(w.why()).toBe('taker Taker on side cloud showed no claim or receipt for this order 5 min after the giver reached the meet');
    expect(reads).toBe(1);
    // A taker that claimed the order is present for good.
    claims = [{ orderId: 'xfer-9-1' }];
    t = 1000;
    const claimed = watch();
    claimed.arrived();
    t += 300_000;
    expect(claimed.why()).toBeUndefined();
    claims = [];
    t += 600_000;
    expect(claimed.why()).toBeUndefined();
    // Its receipt brought by fleet-sync shows it too, with no claim read.
    t = 1000; reads = 0;
    const synced = watch();
    synced.arrived();
    writeFileSync(join(receipts, 'xfer-9-1.to.json'), '{}');
    t += 300_000;
    expect(synced.why()).toBeUndefined();
    expect(reads).toBe(0);
    // An unreadable claim authority gives no reason, and the next read waits everyMs.
    rmSync(join(receipts, 'xfer-9-1.to.json'));
    t = 1000; reads = 0;
    const unread = watch(() => { reads++; throw Error('ls-remote timed out'); });
    unread.arrived();
    t += 300_000;
    expect(unread.why()).toBeUndefined();
    expect(unread.why()).toBeUndefined();
    expect(reads).toBe(1);
});
