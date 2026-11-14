import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankCargo, validCargoRequest, exactItem, courierWaiting } from '../src/cargo';
import type { Session } from '../src/inprocess';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { BotActions } from '../../../vendor/rs-sdk/sdk/actions';
import '../../../vendor/rs-sdk/server/webclient/src/lite/dom-shim';
import { createShim } from '../src/inprocess';
import { executionContext, executionWait } from '../../../vendor/rs-sdk/sdk/execution-context';

const executorModule = new URL('../../../vendor/rs-sdk/server/webclient/src/bot/ActionExecutor.ts', import.meta.url).href;
const { ActionExecutor } = await import(executorModule);
const owned = new Set(['courier']);
test('requests reject wrong worker, stranger, future, missing and expired timestamps', () => {
    const req = { worker: 'worker', courier: 'Courier', at: 1000, ready: true };
    expect(validCargoRequest(req, 'Worker', owned, 1100)).toBe(true);
    for (const changed of [{ worker: 'other' }, { courier: 'stranger' }, { at: 1200 }, { at: null }, { at: 1000 - 180000 }]) {
        expect(validCargoRequest({ ...req, ...changed }, 'worker', owned, 1100)).toBe(false);
    }
    expect(exactItem('Tool (noted)+').test('Tool (noted)+')).toBe(true);
    expect(exactItem('Tool (noted)+').test('Tool noted')).toBe(false);
});

for (const outcome of ['success', 'declined', 'throw', 'partial'] as const) {
    test(`bank-to-courier fake integration: ${outcome} preserves stock, coins and held tool`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cargo-test-'));
        const bank = [{ id: 1, name: 'Flax', count: 50 }, { id: 2, name: 'Iron axe', count: 2 }];
        const inventory = [{ id: 3, name: 'Coins', count: 1234 }, { id: 2, name: 'Iron axe', count: 1 }];
        let bankOpen = true, trades = 0, tick = 0;
        const state = () => ({ tick, bank: { isOpen: bankOpen, items: bank }, player: { worldX: 2654, worldZ: 3283, level: 0 }, nearbyPlayers: [{ name: 'Courier', distance: 2 }], trade: { isOpen: false } });
        const s = {
            name: 'worker', sdk: { getState: state, getInventory: () => inventory, waitForCondition: async (test: (state: unknown) => boolean) => { tick += 2; if (!test(state())) throw Error('fixture closure unconfirmed'); return state(); } },
            bot: {
                withdrawItem: async (re: RegExp, amount: number) => {
                    const item = bank.find(i => re.test(i.name))!;
                    const n = outcome === 'partial' ? 7 : amount === -1 ? item.count : amount;
                    item.count -= n;
                    inventory.push({ id: 100 + item.id, name: item.name, count: n });
                    return { success: n === amount, amountWithdrawn: n };
                },
                closeBank: async () => { bankOpen = false; },
                openBank: async () => { bankOpen = true; return { success: true }; },
                serveTrades: async ({ give }: any) => {
                    trades++;
                    expect(give).toHaveLength(1);
                    const flax = inventory.find(i => i.name === 'Flax')!;
                    expect(give[0].amount).toBe(-1);
                    if (outcome === 'throw') throw new Error('simulated trade failure');
                    if (outcome === 'declined') return { trades: [] };
                    const gave = [{ ...flax }];
                    inventory.splice(inventory.indexOf(flax), 1);
                    return { trades: [{ success: true, gave }] };
                },
                depositItem: async (re: RegExp, amount: number) => {
                    const i = inventory.findIndex(i => re.test(i.name));
                    if (amount === -1) amount = inventory[i]!.count;
                    bank.find(i => re.test(i.name))!.count += amount;
                    inventory[i]!.count -= amount;
                    if (!inventory[i]!.count) inventory.splice(i, 1);
                    return { success: true };
                },
            },
        } as unknown as Session;
        try {
            writeFileSync(join(dir, 'request-worker.json'), JSON.stringify({ worker: 'worker', courier: 'Courier', at: Date.now(), ready: true }));
            expect(courierWaiting('worker', { dir, owned })).toBe(true);
            const run = bankCargo(s, [/flax|axe|coins/i], 0, { dir, owned });
            if (outcome === 'throw') await expect(run).rejects.toThrow('simulated trade failure');
            else await run;
            expect(trades).toBe(1);
            expect(courierWaiting('worker', { dir, owned })).toBe(false);
            await bankCargo(s, [/flax|axe|coins/i], 0, { dir, owned });
            expect(trades).toBe(1); // No repeat attempt for the same ready request.
            expect(inventory).toEqual([{ id: 3, name: 'Coins', count: 1234 }, { id: 2, name: 'Iron axe', count: 1 },
                ...outcome === 'throw' ? [{ id: 101, name: 'Flax', count: 50 }] : []]);
            const manifest = JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8'));
            expect(manifest.items.find((i: any) => i.name === 'Flax')?.count ?? 0).toBe(outcome === 'partial' ? 43 : outcome === 'declined' ? 50 : 0);
            expect(manifest.items.find((i: any) => i.name === 'Coins')).toBeUndefined();
            expect(bankOpen).toBe(outcome !== 'throw');
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
}

type StopAt = 'none' | 'note' | 'withdraw' | 'close' | 'request' | 'offer-wait' | 'confirm-wait' | 'accepted-confirm-wait' | 'request-change' | 'owner-change';
function nativeCargo(stopAt: StopAt, reserve = 0, proxy = false) {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-native-'));
    const requestFile = join(dir, 'request-worker.json'), request = { worker: 'worker', courier: 'Courier', at: Date.now(), ready: true };
    writeFileSync(requestFile, JSON.stringify(request));
    let stopped = false, bankOpen = true, noteMode = false, bankCount = 27 + reserve, bankId = 1779, generation = 1, tick = 0, countInputs = 0, tickCallback: (() => void) | null = null;
    let afterAction = (_action: any) => {}, end!: () => void;
    const ended = new Promise<void>(resolve => { end = resolve; }), fire = () => tickCallback?.();
    const inventory: any[] = [{ id: 995, name: 'Coins', count: 37, slot: 0 }], wires: any[] = [], nativeWithdrawals: number[] = [], nativeDeposits: number[] = [];
    let trade: any = { isOpen: false, screen: 'none', partner: null, myOffer: [], theirOffer: [], myAccepted: false, theirAccepted: false };
    const player = { worldX: 2654, worldZ: 3283, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
    const state = (at: number) => ({ tick: at, inGame: true, player, skills: [{ name: 'Hitpoints', level: 10, baseLevel: 10, experience: 100 }],
        inventory: inventory.filter(i => i.count > 0), bank: { isOpen: bankOpen, noteMode, items: [{ id: bankId, name: 'Flax', count: bankCount, slot: 0 }] },
        interface: { isOpen: bankOpen || trade.isOpen, interfaceId: trade.isOpen ? trade.screen === 'confirm' ? 3443 : 3323 : bankOpen ? 5292 : -1 }, dialog: { isOpen: false }, nearbyPlayers: [{ index: 7, name: 'Courier', distance: 2 }], nearbyNpcs: [], nearbyLocs: [],
        trade, gameMessages: [], opFeedback: { opRejectedCount: 0 } });
    const client: any = {
        selfSlot: 1, collectBotState: state, setOnGameTickCallback: (fn: (() => void) | null) => { tickCallback = fn; },
        bankWithdraw: (_slot: number, amount: number) => {
            nativeWithdrawals.push(amount); const n = amount === -1 ? bankCount : amount; bankCount -= n;
            const note = inventory.find(i => i.id === 1780); if (note) note.count += n; else inventory.push({ id: 1780, name: 'Flax', count: n, slot: 1 });
            generation++; return true;
        },
        bankDeposit: (slot: number, amount: number) => {
            nativeDeposits.push(amount); const item = inventory.find(i => i.slot === slot)!;
            const n = amount === -1 ? item.count : amount; item.count -= n; bankCount += n; generation++; return true;
        },
        isChatBackInputOpen: () => true, submitCountDialog: () => { countInputs++; return true; },
    };
    const executor = new ActionExecutor(client);
    client.executeBotAction = async (action: any) => {
        wires.push(action);
        if (action.type === 'bankWithdraw' || action.type === 'bankDeposit') {
            const response = await executor.execute(action);
            if (action.type === 'bankWithdraw' && stopAt === 'withdraw') stopped = true;
            afterAction(action);
            return response;
        }
        if (action.type === 'clickComponent' && action.componentId === 5386) {
            noteMode = true; await Promise.resolve();
            if (stopAt === 'note') stopped = true;
            if (stopAt === 'request-change') writeFileSync(requestFile, JSON.stringify({ ...request, ready: false }));
            if (stopAt === 'owner-change') client.executeBotAction = () => ({ success: true });
        } else if (action.type === 'closeModal') {
            bankOpen = false; await Promise.resolve(); if (stopAt === 'close') stopped = true;
        } else if (action.type === 'interactLoc') bankOpen = true;
        else if (action.type === 'interactPlayer') trade = { ...trade, isOpen: true, screen: 'offer', partner: 'Courier' };
        else if (action.type === 'clickComponentWithOption' && action.componentId === 3322) {
            expect(action.optionIndex).toBe(4); const item = inventory.find(i => i.slot === action.slot)!;
            trade.myOffer = [{ id: item.id, name: item.name, count: item.count }]; item.count = 0;
        } else if (action.type === 'clickComponent' && action.componentId === 3420) {
            trade = { ...trade, screen: 'confirm', myAccepted: false };
            if (stopAt === 'offer-wait') stopped = true;
        } else if (action.type === 'clickComponent' && action.componentId === 3546) {
            trade.myAccepted = true;
            if (!['confirm-wait', 'accepted-confirm-wait'].includes(stopAt)) trade = { ...trade, isOpen: false };
        }
        afterAction(action); return { success: true };
    };
    const sdk = new BotSDK({ botUsername: 'worker', password: 'local-fixture', autoLaunchBrowser: false, autoReconnect: false } as any);
    sdk.waitForTradeRequest = async () => { await Promise.resolve(); if (stopAt === 'request') stopped = true; return 'Courier'; };
    const shim = createShim(client, sdk); shim.start(); fire();
    const bot = new BotActions(sdk);
    bot.openBank = async () => { const { success, message } = await sdk.sendInteractLoc(2654, 3283, 2213, 1); return { success, message }; };
    const view = proxy ? new Proxy(sdk, { get(target, key) { const value = Reflect.get(target, key, target); return typeof value === 'function' ? (...args: unknown[]) => value.apply(target, args) : value; } }) : sdk;
    const session = { name: 'worker', sdk: view, bot, client, ended, tick: () => tick,
        bankObservation: () => ({ generation, at: Date.now(), items: state(tick).bank.items }), direct: shim.direct, onTick: shim.onTick } as unknown as Session;
    const timer = setInterval(() => {
        tick++;
        if (trade.screen === 'confirm' && trade.myAccepted && ['confirm-wait', 'accepted-confirm-wait'].includes(stopAt)) {
            stopped = true; if (stopAt === 'confirm-wait') trade.myAccepted = false;
        }
        fire();
    }, 1);
    return { session, dir, sdk, client, requestFile, wires, nativeWithdrawals, nativeDeposits,
        stop: () => stopped, stopNow: () => { stopped = true; },
        after: (hook: (action: any) => void) => { afterAction = hook; }, end,
        changeStock: (id: number, count: number) => { bankId = id; bankCount = count; fire(); },
        counts: () => ({ bank: bankCount, notes: inventory.filter(i => i.id === 1780).reduce((n, i) => n + i.count, 0), countInputs }),
        manifest: () => JSON.parse(readFileSync(join(dir, 'worker.json'), 'utf8')),
        dispose: () => { clearInterval(timer); shim.stop('stopped'); rmSync(dir, { recursive: true, force: true }); } };
}

for (const stopAt of ['note', 'withdraw', 'close', 'request', 'offer-wait', 'confirm-wait', 'accepted-confirm-wait', 'request-change', 'owner-change'] as const)
test('actual SDK cargo fences cancellation at ' + stopAt, async () => {
    const f = nativeCargo(stopAt), beforeSend = Object.getOwnPropertyDescriptor(f.sdk, 'send'), beforeTrade = Object.getOwnPropertyDescriptor(f.sdk, 'getTradeState');
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow(/cargo/);
        expect(f.wires.filter(a => a.type === 'bankWithdraw').length).toBe(['note', 'request-change', 'owner-change'].includes(stopAt) ? 0 : 1);
        expect(f.wires.filter(a => a.type === 'interactPlayer').length).toBe(['offer-wait', 'confirm-wait', 'accepted-confirm-wait'].includes(stopAt) ? 1 : 0);
        expect(f.wires.filter(a => a.type === 'clickComponent' && a.componentId === 3546).length).toBe(['confirm-wait', 'accepted-confirm-wait'].includes(stopAt) ? 1 : 0);
        expect(f.counts().bank + f.counts().notes + (f.session.sdk.getState()?.trade?.myOffer ?? []).reduce((n, i) => n + i.count, 0)).toBe(27);
        expect(f.counts().countInputs).toBe(0);
        expect(f.manifest().items).toEqual([]);
        expect(courierWaiting('worker', { dir: f.dir, owned })).toBe(false);
        expect(Object.getOwnPropertyDescriptor(f.sdk, 'send')).toEqual(beforeSend);
        expect(Object.getOwnPropertyDescriptor(f.sdk, 'getTradeState')).toEqual(beforeTrade);
        if (['withdraw', 'close'].includes(stopAt)) expect(f.counts()).toMatchObject({ bank: 27, notes: 0 });
        if (stopAt === 'request') expect(f.counts()).toMatchObject({ bank: 0, notes: 27 });
    } finally { f.dispose(); }
});

test('native quantities preserve reserved stock without any bank or offer count dialog, including a caller SDK proxy', async () => {
    for (const reserve of [0, 7]) {
        const f = nativeCargo('none', reserve, true);
        try {
            await bankCargo(f.session, [/^Flax$/i], reserve, { dir: f.dir, owned, stopped: f.stop });
            expect(f.counts()).toEqual({ bank: reserve, notes: 0, countInputs: 0 });
            expect(f.nativeWithdrawals).toEqual(reserve === 0 ? [-1] : [10, 10, 5, 1, 1]);
            expect(f.wires.filter(a => a.type === 'clickComponentWithOption' && a.componentId === 3322).map(a => a.optionIndex)).toEqual([4]);
        } finally { f.dispose(); }
    }
});

test('an already-stopped request does not spend its token or dispatch any input', async () => {
    const f = nativeCargo('none'); f.stopNow();
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow('cargo stopped');
        expect(f.wires).toEqual([]); expect(courierWaiting('worker', { dir: f.dir, owned })).toBe(true);
    } finally { f.dispose(); }
});

test('parent cancellation and ended sessions refuse cleanup as well as new cargo inputs', async () => {
    for (const ended of [false, true]) {
        const f = nativeCargo('none'), parent = new AbortController();
        f.after(action => { if (action.type === 'bankWithdraw') { if (ended) f.end(); else parent.abort(Error('parent cancelled')); } });
        try {
            await expect(executionContext.run({ signal: parent.signal }, () => bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop }))).rejects.toThrow(/cargo/);
            expect(f.wires.map(a => a.type)).toEqual(['clickComponent', 'bankWithdraw']);
            expect(f.counts()).toEqual({ bank: 0, notes: 27, countInputs: 0 }); expect(f.manifest().items).toEqual([]);
        } finally { f.dispose(); }
    }
});

test('an uncertain withdrawal reply retains the notes and cannot authorize a bank cleanup', async () => {
    const f = nativeCargo('none'), withdraw = f.session.bot.withdrawItem.bind(f.session.bot);
    f.session.bot.withdrawItem = async (...args) => { await withdraw(...args); throw Error('withdrawal reply lost'); };
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow('withdrawal reply lost');
        expect(f.wires.map(a => a.type)).toEqual(['clickComponent', 'bankWithdraw']);
        expect(f.counts()).toEqual({ bank: 0, notes: 27, countInputs: 0 }); expect(f.manifest().items).toEqual([]);
    } finally { f.dispose(); }
});

test('failed attempt persistence restores cargo hooks and admits a later valid request', async () => {
    const f = nativeCargo('none'), before = Object.getOwnPropertyDescriptor(f.sdk, 'send'), blocker = join(f.dir, `attempt-worker.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow();
        expect(f.wires).toEqual([]); expect(Object.getOwnPropertyDescriptor(f.sdk, 'send')).toEqual(before);
        rmSync(blocker, { recursive: true });
        await bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop });
        expect(f.counts()).toEqual({ bank: 0, notes: 0, countInputs: 0 });
    } finally { f.dispose(); }
});

test('the complete cleanup is bounded while its hooks remain installed until its helper settles', async () => {
    const f = nativeCargo('close'), before = Object.getOwnPropertyDescriptor(f.sdk, 'send'), began = Date.now();
    f.session.bot.openBank = () => executionWait(() => () => {});
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow('cargo cleanup deadline exceeded');
        expect(Date.now() - began).toBeLessThan(7000);
        expect(f.counts()).toEqual({ bank: 0, notes: 27, countInputs: 0 }); expect(f.manifest().items).toEqual([]);
        expect(Object.getOwnPropertyDescriptor(f.sdk, 'send')).toEqual(before);
    } finally { f.dispose(); }
}, 8000);

for (const id of [1779, 999]) test('a deferred Withdraw-All rechecks its exact stock at native dispatch: id=' + id, async () => {
    const f = nativeCargo('none'), raw = f.sdk as any, send = raw.send;
    let held: any, ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    raw.send = function (message: any) { if (message.action?.type === 'bankWithdraw') { held = message; ready(); return; } return send.call(this, message); };
    try {
        const run = bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop });
        await waiting; f.changeStock(id, 28); send.call(raw, held);
        await expect(run).rejects.toThrow('cargo withdrawal stock changed');
        expect(f.nativeWithdrawals).toEqual([]); expect(f.manifest().items).toEqual([]);
    } finally { f.dispose(); }
});

test('a failed trade session cannot authorize cleanup from a single closed snapshot', async () => {
    const f = nativeCargo('none');
    f.session.bot.serveTrades = async () => ({ success: true, message: 'fixture window ended', reason: 'timeout', trades: [{ success: false, message: 'uncertain close', reason: 'timeout', gave: [], received: [] }] });
    try {
        await expect(bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop })).rejects.toThrow('cargo trade outcome unconfirmed');
        expect(f.nativeDeposits).toEqual([]); expect(f.counts()).toEqual({ bank: 0, notes: 27, countInputs: 0 });
        expect(f.manifest().items).toEqual([]);
    } finally { f.dispose(); }
});

test('the request deadline cancels a held SDK wait and its later gate flush has no native effect', async () => {
    const f = nativeCargo('none'), raw = f.sdk as any, send = raw.send;
    const request = JSON.parse(readFileSync(f.requestFile, 'utf8')); request.at = Date.now() - 180_000 + 250;
    writeFileSync(f.requestFile, JSON.stringify(request));
    let held: any, ready!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    raw.send = function (message: any) { if (message.action?.type === 'bankWithdraw') { held = message; ready(); return; } return send.call(this, message); };
    const began = Date.now();
    try {
        const run = bankCargo(f.session, [/^Flax$/i], 0, { dir: f.dir, owned, stopped: f.stop });
        await Promise.race([waiting, run.then(() => { throw Error('cargo ended before the fixture held its action'); })]);
        await expect(run).rejects.toThrow('cargo deadline exceeded');
        expect(Date.now() - began).toBeLessThan(1500);
        send.call(raw, held);
        await Promise.resolve(); await Promise.resolve();
        expect(f.nativeWithdrawals).toEqual([]); expect(f.counts()).toEqual({ bank: 27, notes: 0, countInputs: 0 });
        expect(f.manifest().items).toEqual([]);
    } finally { f.dispose(); }
});
