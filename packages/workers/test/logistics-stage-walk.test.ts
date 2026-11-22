import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Outcome } from '../../core/src/act';
import * as owner from '../../core/src/bot';
import { setEquipmentObserved } from '../../core/src/container-observation';
import type { Session } from '../../core/src/inprocess';
import { componentId } from '../../core/src/logout';
import { resultCounters } from '../../core/src/status';
import { loadTravel } from '../../core/src/travel';
import { isNoProgressFailure, isPrerequisiteFailure } from '../../practice/src/supervise';
import items from '../../../knowledge/items.json';
import { guardCowWalker } from '../src/logistics';
import { ClientProt } from '../../../vendor/rs-sdk/server/webclient/src/io/ClientProt';
import {
    approach,
    awayFrom,
    bankDonorKey,
    bankMove,
    bankNameSimilarity,
    bankRelocationProfile,
    bootstrapAccountServer,
    bootstrapPracticeServer,
    bootstrapSupplyActor,
    compileInventorySetup,
    completeBankPlan,
    dispatchBankDrag,
    fareFault,
    fareSpare,
    inZanaris,
    knightRelocationProfile,
    leaveTutorial,
    loadoutStopRequested,
    nativeKitItem,
    onTutorialIsland,
    ourAccounts,
    parseTarget,
    payoutItems,
    preparePayout,
    relocateKnight,
    relocationAssets,
    relocationPreserved,
    relocationStart,
    resolveLogisticsStep,
    runFlatBankSort,
    runOwnedLoadout,
    runPreservedWine,
    sortBankRows,
    stagedBoat,
    supplyAdmission,
    supplyCount,
    supplyRestock,
    validateOwnedKit,
    walkTarget,
    walkTargetPersist,
    walkWithFerryFallback,
    wineStockChecks,
    type BankSortDriver,
    type OwnedKit,
    type SetupBindings,
    type WineStock,
} from '../src/logistics';
import * as walkHelpers from '../src/logistics/walk-helpers';

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

// --- Banker Payout ---

test('banker roster uses authenticated ownership on its exact server, including local pairs', () => {
    const calls: string[] = [];
    const lookup = (server: string) => {
        calls.push(server);
        return new Set(server === 'localhost:8888' ? ['flpayoutlocal', 'flreceiverlocal'] : server === 'rs-sdk-demo.fly.dev' ? ['moneyshot', 'pocketrocket'] : []);
    };
    expect(ourAccounts('localhost:8888', lookup)).toEqual(['flpayoutlocal', 'flreceiverlocal']);
    expect(ourAccounts('rs-sdk-demo.fly.dev', lookup)).toEqual(['moneyshot', 'pocketrocket']);
    expect(ourAccounts('rs-sdk-demo.fly.dev', lookup)).not.toContain('flreceiverlocal');
    expect(ourAccounts('localhost:8888', lookup)).not.toContain('moneyshot');
    expect(ourAccounts('different.example', lookup)).toEqual([]);
    expect(ourAccounts(undefined, lookup)).toEqual(['moneyshot', 'pocketrocket']);
    expect(calls).toEqual(['localhost:8888', 'rs-sdk-demo.fly.dev', 'rs-sdk-demo.fly.dev', 'localhost:8888', 'different.example', 'rs-sdk-demo.fly.dev']);
});

function bankerFixture(partial = false, failSecond = false) {
    const inventory = [
        { id: 1735, name: 'Shears', count: 1, slot: 0 },
        { id: 315, name: 'Shrimps', count: 1, slot: 1 },
        { id: 315, name: 'Shrimps', count: 1, slot: 2 },
    ];
    const bank = new Map([[1779, 750], [1737, 50]]);
    const calls: unknown[][] = [], deposits: { id: number; count: number }[] = [];
    let closed = 0;
    const s = {
        sdk: { getInventory: () => inventory },
        bot: {
            openBank: async () => ({ success: true }),
            closeBank: async () => { closed++; },
            withdrawItem: async (...args: [RegExp, number, { asNote: boolean }?]) => {
                calls.push(args);
                const name = args[0].test('Flax') ? 'Flax' : 'Wool';
                const raw = name === 'Flax' ? 1779 : 1737;
                const amount = failSecond && calls.length === 2 ? 0 : partial || !args[2]?.asNote ? Math.min(25, args[1]) : args[1];
                bank.set(raw, bank.get(raw)! - amount);
                if (amount) inventory.push({ id: args[2]?.asNote ? raw + 1 : raw, name, count: amount, slot: inventory.length });
                return { success: true };
            },
            depositItem: async (item: { id: number }, count: number) => {
                deposits.push({ id: item.id, count });
                const i = inventory.findIndex(v => v.id === item.id);
                const raw = item.id === 1780 ? 1779 : item.id === 1738 ? 1737 : item.id;
                bank.set(raw, bank.get(raw)! + count);
                inventory[i]!.count -= count;
                if (!inventory[i]!.count) inventory.splice(i, 1);
            },
        },
    } as unknown as Session;
    return { s, bank, calls, deposits, inventory, closed: () => closed };
}

test('existing request format validates and merges duplicate names without lost quantities', () => {
    expect(payoutItems([{ name: 'Flax', count: 100 }, { name: 'flax', count: 6 }])).toEqual([{ name: 'Flax', count: 106 }]);
    for (const raw of [[], null, [{ name: 'Flax', count: -1 }], [{ name: 'Flax', count: 1.5 }]]) expect(() => payoutItems(raw)).toThrow('no payout progress');
});

test('opt-in notes prepares all 106 Flax in one stack and retains kit', async () => {
    const f = bankerFixture();
    expect(await preparePayout(f.s, [{ name: 'Flax', count: 106 }], true, /shears|shrimps/i)).toEqual({ want: [{ name: 'Flax', count: 106 }], notes: true, withdrawn: 106 });
    expect(f.calls[0]![2]).toEqual({ asNote: true });
    expect(f.inventory.at(-1)).toMatchObject({ id: 1780, count: 106 });
    expect(f.inventory.slice(0, 3).map(i => i.count)).toEqual([1, 1, 1]);
    expect(f.bank.get(1779)).toBe(644);
    expect(f.closed()).toBe(1);
});

test('default passes no options and keeps the existing small unnoted payout behavior', async () => {
    const f = bankerFixture();
    expect(await preparePayout(f.s, [{ name: 'Flax', count: 20 }])).toMatchObject({ notes: false, withdrawn: 20 });
    expect(f.calls[0]!.length).toBe(2);
    expect(f.inventory.at(-1)).toMatchObject({ id: 1779, count: 20 });
});

test('unnoted 106 partial is banked and blocks before caller can serve an impossible trade', async () => {
    const f = bankerFixture();
    let served = false, error = '';
    try { await preparePayout(f.s, [{ name: 'Flax', count: 106 }]); served = true; } catch (e) { error = String(e); }
    expect(served).toBe(false);
    expect(error).toContain('requested=106 actual=25');
    expect(isNoProgressFailure(`RESULT fail ${error}`)).toBe(true);
    expect(f.bank.get(1779)).toBe(750);
    expect(f.inventory.length).toBe(3);
    expect(f.closed()).toBe(1);
});

test('partial noted withdrawal also cleans up despite API success=true', async () => {
    const f = bankerFixture(true);
    await expect(preparePayout(f.s, [{ name: 'Flax', count: 106 }], true)).rejects.toThrow('actual=25');
    expect(f.deposits).toEqual([{ id: 1780, count: 25 }]);
    expect(f.bank.get(1779)).toBe(750);
    expect(f.inventory.length).toBe(3);
});

test('second item shortfall banks the first complete withdrawal too', async () => {
    const f = bankerFixture(false, true);
    await expect(preparePayout(f.s, [{ name: 'Flax', count: 106 }, { name: 'Wool', count: 30 }], true)).rejects.toThrow('Wool requested=30 actual=0');
    expect(f.bank.get(1779)).toBe(750);
    expect(f.bank.get(1737)).toBe(50);
    expect(f.inventory.length).toBe(3);
});

test('protected KEEP item cannot be requested even when a bank copy exists', async () => {
    const f = bankerFixture();
    await expect(preparePayout(f.s, [{ name: 'Shears', count: 1 }], true, /^shears$/i)).rejects.toThrow('protected KEEP');
    expect(f.calls.length).toBe(0);
    expect(f.inventory[0]!.count).toBe(1);
});

// --- Preserved Wine Order ---

function wineFixture(mode = 'ok') {
    let tick = 0, generation = 0, open = false, stopped = false, unsafeCloses = 0;
    const inventory = [{ id: 995, count: 777, slot: 0, name: 'Coins' }];
    const bank = [{ id: 1987, count: 4, slot: 0, name: 'Grapes' }, { id: 1937, count: 4, slot: 1, name: 'Jug of water' }, { id: 2347, count: 1, slot: 2, name: 'Hammer' }];
    const names: Record<number, string> = { 1987: 'Grapes', 1937: 'Jug of water', 1995: 'Unfermented wine', 1996: 'Unfermented wine' };
    const add = (rows: typeof inventory, id: number, n: number) => {
        const old = rows.find(i => i.id === id);
        if (old) old.count += n;
        else rows.push({ id, count: n, slot: rows.length, name: names[id] ?? String(id) });
    };
    const remove = (rows: typeof inventory, id: number, n: number) => {
        const i = rows.findIndex(r => r.id === id);
        if (i < 0 || rows[i]!.count < n) throw Error('test stock missing');
        rows[i]!.count -= n;
        if (!rows[i]!.count) rows.splice(i, 1);
    };
    const listeners = new Set<() => void>(), timer = setInterval(() => { tick++; for (const cb of listeners) cb(); }, 1);
    const session = {
        name: 'fixture', tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, ended: new Promise(() => {}),
        bankObservation: () => generation && (mode !== 'reading-ends-on-close' || open) ? { generation, at: tick, items: bank } : undefined,
        sdk: {
            getState: () => ({ player: { lifeId: 1, isDead: false }, bank: { isOpen: open, items: bank }, inventory, interface: { isOpen: false }, dialog: { isOpen: false } }),
            getInventory: () => inventory, getEquipment: () => [], getSkill: (skill: string) => ({ baseLevel: skill === 'Cooking' ? 82 : 99, level: 99 }), getSkillXp: () => 0,
            sendUseItemOnItem: async () => { remove(inventory, 1987, 1); remove(inventory, 1937, 1); add(inventory, 1995, 1); tick++; return { success: true }; },
        },
        bot: {
            openBank: async () => { open = true; generation++; return { success: true }; },
            closeBank: async () => { if (inventory.some(i => i.id === 1995) || bank.some(i => i.id === 1995)) unsafeCloses++; open = false; tick++; return { success: true }; },
            withdrawItem: async (item: { id: number }, n: number, o: { asNote: boolean }) => {
                if (o.asNote && mode === 'note-refused') return { success: false };
                remove(bank, item.id, n); add(inventory, o.asNote ? 1996 : item.id, n);
                if (mode !== 'stale-withdraw') generation++;
                if (mode === 'stop-after-withdraw') stopped = true;
                return { success: true };
            },
            depositItem: async (item: { id: number }) => {
                const n = inventory.filter(i => i.id === item.id).reduce((a, i) => a + i.count, 0);
                remove(inventory, item.id, n); add(bank, item.id, n); generation++;
                if (mode === 'asset-loss') remove(inventory, 995, 1);
                return { success: true };
            },
        },
        direct: async () => ({ success: true }),
    } as unknown as Session;
    return { session, stop: () => stopped, close: () => clearInterval(timer), inventory, bank, unsafeCloses: () => unsafeCloses };
}

test('each real pair is deposited and noted before the next bank close; reserves and assets remain', async () => {
    const f = wineFixture();
    try {
        const result = await runPreservedWine(f.session, { maximum: 2, cap: 100, reserve: 2 });
        expect(result).toMatchObject({ ok: true, made: 2, noted: 2, inputs: { grapes: 2, water: 2 }, assets: true });
        expect(f.inventory.filter(i => i.id === 1996).reduce((n, i) => n + i.count, 0)).toBe(2);
        expect(f.bank.filter(i => i.id === 1987 || i.id === 1937).map(i => i.count)).toEqual([2, 2]);
        expect(f.unsafeCloses()).toBe(0);
    } finally { f.close(); }
});

test('the used inputs come from the stock read with the bank open, when the session holds no bank reading after the close', async () => {
    const f = wineFixture('reading-ends-on-close');
    try {
        const result = await runPreservedWine(f.session, { maximum: 2, cap: 100, reserve: 2 });
        expect(result).toMatchObject({ ok: true, made: 2, noted: 2, inputs: { grapes: 2, water: 2 }, assets: true });
        expect(f.session.bankObservation?.()).toBeUndefined();
    } finally { f.close(); }
});

test('a refused note withdrawal leaves the raw bank modal open and cannot claim preserved stock', async () => {
    const f = wineFixture('note-refused');
    try {
        expect((await runPreservedWine(f.session, { maximum: 2, cap: 100 })).ok).toBe(false);
        expect(f.bank.find(i => i.id === 1995)?.count).toBe(1);
        expect(f.unsafeCloses()).toBe(0);
    } finally { f.close(); }
});

test('an unpaired bank debit, a stop, and unrelated lost coins each reject the order', async () => {
    for (const mode of ['stale-withdraw', 'stop-after-withdraw', 'asset-loss']) {
        const f = wineFixture(mode);
        try { expect((await runPreservedWine(f.session, { maximum: 2, cap: 100 }, f.stop)).ok).toBe(false); } finally { f.close(); }
    }
});

test('existing raw wine and short staged inputs refuse production without spending grapes', async () => {
    for (const raw of [false, true]) {
        const f = wineFixture();
        if (raw) f.bank.push({ id: 1995, count: 1, slot: 3, name: 'Unfermented wine' });
        try { expect((await runPreservedWine(f.session, { maximum: raw ? 2 : 5, cap: 100 })).ok).toBe(false); expect(f.bank.find(i => i.id === 1987)?.count).toBe(4); } finally { f.close(); }
    }
});

test('exact reconciliation rejects fermented substitution, a missing input debit and equipment loss', () => {
    const before: WineStock = { items: { 1987: 4, 1937: 4, 995: 777 }, equipment: [{ id: 1277, count: 1, slot: 3 }], xp: 0 };
    const after: WineStock = { items: { 1987: 2, 1937: 2, 1996: 2, 995: 777 }, equipment: before.equipment, xp: 0 };
    expect(Object.values(wineStockChecks(before, after, 2)).every(Boolean)).toBe(true);
    expect(wineStockChecks(before, { ...after, items: { 1987: 2, 1937: 2, 1993: 2, 995: 777 } }, 2).output).toBe(false);
    expect(wineStockChecks(before, { ...after, items: { ...after.items, 1987: 3 } }, 2).inputs).toBe(false);
    expect(wineStockChecks(before, { ...after, equipment: [] }, 2).equipment).toBe(false);
});

test('invalid wine limits cannot dispatch any production action', async () => {
    const f = wineFixture();
    try { for (const maximum of [0, 1.5, NaN]) await expect(runPreservedWine(f.session, { maximum, cap: 100 })).rejects.toThrow('invalid preserved wine order'); } finally { f.close(); }
});

test('the AIO wine-stock route resolves finite arguments and parses counters', () => {
    const step = resolveLogisticsStep('wine-stock', ['12', '1000', '2']);
    expect(step).toEqual({ script: 'scripts/aio-logistics.ts', args: ['wine-stock', '12', '1000', '2'], env: {} });
    expect(resultCounters('ok preservedWine=12 grapesUsed=12 waterUsed=12 assets=1')).toMatchObject({ preservedWine: 12, grapesUsed: 12, waterUsed: 12, assets: 1 });
});

// --- Bank Sort ---

const sortRows = [{ slot: 0, id: 10, name: 'Zinc', count: 8 }, { slot: 3, id: 20, name: 'Apple', count: 2 }, { slot: 7, id: 30, name: 'Apple', count: 9 }];
function sortFixture(mode: 0 | 1 = 0, effect = 'ok') {
    let tick = 0, generation = 1, current = structuredClone(sortRows), calls = 0, halt = false;
    const d: BankSortDriver = {
        tick: () => tick,
        unsafe: () => halt ? 'stop' : '',
        observe: () => ({ generation, mode, rows: structuredClone(current) }),
        drag: async (from, to, before) => {
            calls++;
            if (effect === 'none') return false;
            current = bankMove(before, from, to, mode);
            if (effect === 'foreign') current[0]!.count++;
            if (effect !== 'stale') generation++;
            if (effect === 'stop') halt = true;
            if (effect === 'throw') throw Error('lost reply');
            return true;
        },
        wait: async predicate => { tick++; return predicate(); },
    };
    return { d, stats: () => ({ current, calls }), stop: () => { halt = true; } };
}

test('native name ordering is stable for equal names and compacts sparse slots', async () => {
    expect(sortBankRows(sortRows).map(i => i.id)).toEqual([20, 30, 10]);
    for (const mode of [0, 1] as const) {
        const f = sortFixture(mode), r = await runFlatBankSort(f.d, { cap: 50, maxMoves: 10 });
        expect(r.moves).toBeGreaterThan(0);
        expect(f.stats().current.map(i => [i.slot, i.id, i.count])).toEqual([[0, 20, 2], [1, 30, 9], [2, 10, 8]]);
    }
});

test('unknown, stale, foreign and lost bank sort replies never repeat a drag', async () => {
    for (const effect of ['none', 'stale', 'foreign', 'throw', 'stop']) {
        const f = sortFixture(0, effect);
        await expect(runFlatBankSort(f.d, { cap: 50, maxMoves: 10 })).rejects.toThrow();
        expect(f.stats().calls).toBe(1);
    }
    const f = sortFixture(); f.stop();
    await expect(runFlatBankSort(f.d, { cap: 50, maxMoves: 10 })).rejects.toThrow('stop');
    expect(f.stats().calls).toBe(0);
});

test('bounded budget and invalid duplicate slots refuse before input', async () => {
    const f = sortFixture();
    await expect(runFlatBankSort(f.d, { cap: 50, maxMoves: 1 })).rejects.toThrow('budget');
    expect(f.stats().calls).toBe(1);
    expect(() => sortBankRows([...sortRows, sortRows[0]!])).toThrow();
});

test('bridge uses native INV_BUTTOND field order and never changes client bank optimistically', () => {
    const packet: number[] = [], com = { linkObjType: [11, 21], linkObjNumber: [8, 2] }, c: any = { mainModalId: 5292, var: { 304: 0 }, ifType: () => com, writeOpcode: (n: number) => packet.push(n), out: { p2: (n: number) => packet.push(n), p1: (n: number) => packet.push(n) } };
    const before = [sortRows[0]!, { ...sortRows[1]!, slot: 1 }];
    expect(dispatchBankDrag(c, 0, 1, 0, before).success).toBe(true);
    expect(packet).toEqual([ClientProt.INV_BUTTOND, 5382, 0, 1, 0]);
    expect(ClientProt.INV_BUTTOND).toBe(253);
    expect(com.linkObjType).toEqual([11, 21]);
    expect(() => dispatchBankDrag(c, 0, 1, 1, before)).toThrow();
    expect(packet).toHaveLength(5);
});

const nativeRows = (ids: number[]) => ids.map((id, slot) => ({ slot, id, count: slot + 1, name: items.find(i => i.id === id)!.name }));

test('native potion recipe IDs keep generic names and quest mixtures distinct', () => {
    for (const [id, level, stage] of [[91, 3, 2], [3002, 34, 2], [3004, 63, 2], [3406, 15, 2], [3408, 15, 4], [3414, 15, 4], [2428, 3, 4]]) {
        expect(bankDonorKey(nativeRows([id!])[0]!)).toMatchObject({ category: 'Potions', level, stage });
    }
    expect(sortBankRows(nativeRows([3004, 3406, 91]), 'donor').map(i => i.id)).toEqual([91, 3406, 3004]);
    expect(bankDonorKey(nativeRows([2511])[0]!).level).toBe(bankDonorKey(nativeRows([1511])[0]!).level);
    expect(() => bankDonorKey({ id: 92, name: 'Unfinished potion', slot: 0, count: 1 })).toThrow('native item metadata');
});

test('donor workflow uses native unidentified herb IDs and production levels/stages', () => {
    const sorted = sortBankRows(nativeRows([2351, 249, 995, 438, 440, 199, 2349]), 'donor');
    expect(sorted.map(i => i.id)).toEqual([995, 438, 2349, 199, 249, 440, 2351]);
    expect(bankDonorKey(nativeRows([199])[0]!)).toMatchObject({ category: 'Skilling-Resource-Herb', level: 3, stage: 0 });
    expect(bankDonorKey(nativeRows([249])[0]!)).toMatchObject({ category: 'Skilling-Resource-Herb', level: 3, stage: 1 });
});

test('donor categories, rune order, descending tools/gear tiers and doses differ from name order', () => {
    const r = nativeRows([1155, 1265, 560, 1163, 1275, 556, 141, 139, 379, 995]);
    expect(sortBankRows(r, 'donor').map(i => i.id)).toEqual([995, 139, 141, 379, 556, 560, 1163, 1155, 1275, 1265]);
    expect(sortBankRows(nativeRows([121, 2428]), 'donor').map(i => i.id)).toEqual([2428, 121]);
    expect(sortBankRows(r).map(i => i.id)).not.toEqual(sortBankRows(r, 'donor').map(i => i.id));
});

test('donor fuzzy grouping is deterministic and equal native names retain original order', () => {
    expect(bankNameSimilarity('crystal key', 'crystal keys')).toBeGreaterThan(.95);
    expect(bankNameSimilarity('logs', 'potion')).toBeLessThan(.7);
    const r = nativeRows([2511, 1511, 590, 2347]);
    expect(sortBankRows(r, 'donor').filter(i => i.name === 'Logs').map(i => i.id)).toEqual([2511, 1511]);
    expect(sortBankRows(r, 'donor')).toEqual(sortBankRows(r, 'donor'));
    const notes = nativeRows([757, 715, 624, 1509, 714]);
    expect(sortBankRows(notes, 'donor').map(i => i.id)).toEqual([624, 715, 714, 757, 1509]);
    expect(sortBankRows(notes).map(i => i.id)).toEqual([624, 757, 1509, 715, 714]);
    expect(sortBankRows(nativeRows([24, 273, 1931]), 'donor').map(i => i.id)).toEqual([273, 1931, 24]);
});

test('finite actual sorting loop executes donor-selected order with exact native receipts', async () => {
    let tick = 0, generation = 1, current = nativeRows([440, 249, 995, 438, 199]), moves = 0;
    const d: BankSortDriver = {
        tick: () => tick,
        unsafe: () => '',
        observe: () => ({ generation, mode: 1, rows: current }),
        drag: async (from, to, before) => { current = bankMove(before, from, to, 1); generation++; moves++; return true; },
        wait: async p => { tick++; return p(); },
    };
    const r = await runFlatBankSort(d, { cap: 100, maxMoves: 20, policy: 'donor' });
    expect(r.policy).toBe('donor');
    expect(current.map(i => i.id)).toEqual([995, 438, 199, 249, 440]);
    expect(r.moves).toBe(moves);
});

test('native weapon, armour, tools, clue and cosmetic categories remain distinct', () => {
    const expected: Record<number, string> = { 1289: 'Weapon-Melee', 861: 'Weapon-Ranged', 1381: 'Weapon-Magic', 1127: 'Armour-Body', 1079: 'Armour-Legs', 1201: 'Armour-Shield', 1725: 'Armour-Amulet', 1704: 'Armour-Amulet', 1712: 'Teleportation', 2552: 'Teleportation', 3853: 'Teleportation', 3690: 'Teleportation', 2: 'Ammunition', 2714: 'Clue-Scrolls', 1061: 'Armour-Boots', 1059: 'Armour-Gloves', 1635: 'Armour-Ring', 1007: 'Armour-Cape', 1038: 'Cosmetic/Holiday', 2677: 'Clue-Scrolls', 983: 'Quest-Items', 52: 'Ammunition', 313: 'Tool-Fishing', 3438: 'Skilling-Resource-Log', 735: 'Skilling-Resource-Seed' };
    for (const [id, category] of Object.entries(expected)) expect(bankDonorKey(nativeRows([Number(id)])[0]!).category).toBe(category);
});

// --- Loadout Import & Owned Loadout ---

const bindings = (): SetupBindings => ({ items: { '10001': 1277, '10002': 1171, '10003': 385, '10004': 563, '10005': 1778 }, bank: { x: 2655, z: 3283, level: 0 }, cap: 600, maximumMoves: 128, packPolicy: 'exact-counts' });
const donorSetup = () => ({ name: 'Mapped native kit', inv: [{ id: 10003, s: 0 }, null, { id: 10004, q: 50, s: 2 }, { id: 10003, s: 3 }], eq: [null, null, null, { id: 10001, s: 3 }, null, { id: 10002, s: 5 }], sb: 0, rp: null, bp: null, qv: null, afi: {} });

test('compact and portable donor setups compile directly into existing finite owned-kit inputs', () => {
    for (const source of [donorSetup(), { setup: donorSetup(), layout: [10003, -1, 10004] }]) {
        const kit = compileInventorySetup(source, bindings());
        expect(kit.pack).toEqual([{ id: 385, count: 2 }, { id: 563, count: 50 }]);
        expect(kit.wear).toEqual([{ id: 1277, count: 1, slot: 3 }, { id: 1171, count: 1, slot: 5 }]);
        expect(validateOwnedKit(kit)).toEqual(kit);
    }
});

test('multi-setup portable exports require an exact unambiguous setup name', () => {
    const first = { setup: donorSetup(), layout: [] }, second = { setup: { ...donorSetup(), name: 'Second', inv: [{ id: 10004, q: 7 }] }, layout: [] };
    expect(compileInventorySetup([first, second], { ...bindings(), setupName: 'Second' }).pack).toEqual([{ id: 563, count: 7 }]);
    for (const b of [bindings(), { ...bindings(), setupName: 'Missing' }]) expect(() => compileInventorySetup([first, second], b)).toThrow('setup name');
    expect(() => compileInventorySetup([second, second], { ...bindings(), setupName: 'Second' })).toThrow('setup name');
});

test('native IDs are never inferred from matching donor IDs or display names', () => {
    expect(() => compileInventorySetup({ ...donorSetup(), inv: [{ id: 385, name: 'Shark' }] }, bindings())).toThrow('explicit native binding');
    const b = bindings(); b.items['10003'] = 99999999;
    expect(() => compileInventorySetup(donorSetup(), b)).toThrow();
});

test('defaults and null items follow donor serialization, notes retain native identity', () => {
    const source = { inv: [null, { id: -1, q: 0 }, { id: 10005, q: 100, s: -1 }], eq: [], sb: 4 };
    expect(compileInventorySetup(source, bindings()).pack).toEqual([{ id: 1778, count: 100 }]);
});

test('fuzzy/inequality/locked and unsupported containers or spellbooks fail explicitly', () => {
    for (const row of [{ id: 10003, f: true }, { id: 10003, sc: 'Less_Than' }, { id: 10003, sc: 'Greater_Than' }, { id: 10003, l: true }]) {
        expect(() => compileInventorySetup({ ...donorSetup(), inv: [row] }, bindings())).toThrow();
    }
    for (const extra of [{ rp: [{ id: 10004, q: 10 }] }, { bp: [{ id: 10004 }] }, { qv: [{ id: 10004 }] }, { afi: { 10003: { id: 10003 } } }, { sb: 1 }, { sb: 2 }, { sb: 3 }]) {
        expect(() => compileInventorySetup({ ...donorSetup(), ...extra }, bindings())).toThrow();
    }
});

test('empty special containers and exact comparator do not invent extra pack items', () => {
    expect(compileInventorySetup({ ...donorSetup(), rp: [null, { id: -1, q: 0 }], inv: [{ id: 10003, sc: 'Standard', f: false, l: false }] }, bindings()).pack).toEqual([{ id: 385, count: 1 }]);
});

test('malformed rows, duplicate source slots, oversized pack and illegal native gear fail before output', () => {
    for (const inv of [[{ id: 10003, q: 0 }], [{ id: 10003, q: 1.1 }], [{ id: 10003, s: 28 }], [{ id: 10003, s: 0 }, { id: 10004, s: 0 }], [{ id: 10003, q: 29 }], Array(29).fill(null)]) {
        expect(() => compileInventorySetup({ ...donorSetup(), inv }, bindings())).toThrow();
    }
    expect(() => compileInventorySetup({ ...donorSetup(), eq: [{ id: 10003 }] }, bindings())).toThrow();
    expect(() => compileInventorySetup({ ...donorSetup(), eq: [{ id: 10001 }, { id: 10001 }] }, bindings())).toThrow();
    expect(() => compileInventorySetup({ ...donorSetup(), eq: [{ id: 10001, q: 2 }] }, bindings())).toThrow();
});

test('a binding to a native two-handed sword cannot coexist with a shield', () => {
    const b = bindings(); b.items['10001'] = 1307;
    expect(() => compileInventorySetup(donorSetup(), b)).toThrow('conflicting');
});

test('invalid finite bindings and unknown executable row fields cannot silently produce a kit', () => {
    for (const patch of [{ cap: 0 }, { maximumMoves: 1000 }, { packPolicy: 'slots' }, { bank: { x: -1, z: 1, level: 0 } }]) {
        expect(() => compileInventorySetup(donorSetup(), { ...bindings(), ...patch })).toThrow();
    }
    expect(() => compileInventorySetup({ ...donorSetup(), inv: [{ id: 10003, charges: { left: 3 } }] }, bindings())).toThrow('unsupported donor item field');
});

test('actual offline CLI emits loadout-consumable JSON and rejects an unmapped donor item', () => {
    const folder = mkdtempSync(join(tmpdir(), 'native-setup-')), source = join(folder, 'source.json'), map = join(folder, 'bindings.json');
    try {
        writeFileSync(source, JSON.stringify({ setup: donorSetup(), layout: [] }));
        writeFileSync(map, JSON.stringify(bindings()));
        const run = () => spawnSync(process.execPath, [join(ROOT, 'scripts/aio-logistics.ts'), 'Fixture', 'loadout-import', source, map], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 10000 });
        const ok = run();
        expect(ok.status, ok.stderr).toBe(0);
        expect(ok.stdout.trimEnd()).toEndWith('RESULT ok loadout-import');
        const jsonPart = ok.stdout.replace(/\r?\nRESULT ok loadout-import\r?\n?$/, '');
        expect(validateOwnedKit(JSON.parse(jsonPart))).toEqual(compileInventorySetup(donorSetup(), bindings()));
        writeFileSync(source, JSON.stringify({ ...donorSetup(), inv: [{ id: 385 }] }));
        const refused = run();
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('explicit native binding');
    } finally {
        unlinkSync(source); unlinkSync(map); rmdirSync(folder);
    }
});

const kitJob: OwnedKit = { bank: { x: 3185, z: 3436, level: 0 }, pack: [{ id: 995, count: 50 }, { id: 556, count: 25 }], wear: [{ id: 1307, count: 1, slot: 3 }], cap: 600, maximumMoves: 192 };
function loadoutModel(mode = 'normal') {
    let tick = 0, generation = 1, open = false, withdrawals = 0, deposits = 0, equips = 0, noteMode = false;
    const control = { stop: false, mode, level: 99, xp: 100, style: 0 }, name = (id: number) => nativeKitItem(id).name;
    const row = (id: number, count: number, slot: number) => ({ id, count, slot, name: name(id) }), inv: any[] = Array.from({ length: 28 }, (_, i) => row(526, 1, i)), wear: any[] = [row(1277, 1, 3), row(1171, 1, 5)], bank: any[] = [row(995, 99, 0), row(556, 100, 1), row(1307, 1, 2)];
    const player = { worldX: 3185, worldZ: 3436, level: 0, lifeId: 1, respawnCount: 0, isDead: false }, client: any = { membersAccount: 1, executeBotAction: () => ({ success: true }), objType: (id: number) => ({ stackable: [995, 556, 1512, 806].includes(id), certtemplate: id === 1512 ? 799 : -1, certlink: id === 1512 ? 1511 : -1 }) };
    setEquipmentObserved(client, true);
    const add = (a: any[], id: number, n: number) => { const found = a.find(i => i.id === id); if (found) found.count += n; else a.push(row(id, n, a.length)); };
    const s: any = {
        name: 'Owned', client, tick: () => tick, ended: new Promise(() => {}), onTick: (cb: () => void) => { let active = true; const next = () => queueMicrotask(() => { if (active) { tick++; cb(); next(); } }); next(); return () => { active = false; }; },
        bankObservation: () => open ? { generation, items: bank.map(i => ({ ...i })), at: tick } : null,
        sdk: {
            getStateAge: () => 0, getInventory: () => inv, getEquipment: () => wear, getSkill: () => ({ level: 99 }),
            getState: () => ({
                player, inventory: inv, equipment: wear, skills: [{ name: 'Attack', level: control.level, experience: control.xp, baseLevel: 99 }],
                autoRetaliateEnabled: false, prayers: { activePrayers: Array(15).fill(false) },
                combatStyle: { known: true, currentStyle: control.style, tabInterfaceId: wear.some(i => i.slot === 3) ? nativeKitItem(wear.find(i => i.slot === 3).id).styleTab : componentId('combat_unarmed'), styles: [0, 1, 2, ...wear.some(i => i.slot === 3 && nativeKitItem(i.id).styleIndices.includes(3)) ? [3] : []].map(index => ({ index })) },
                bank: { isOpen: open, items: bank, noteMode },
            }),
            sendCloseModal: async () => { open = false; return { success: true }; },
            sendClickComponent: async (id: number) => { noteMode = id === 5386; return { success: true }; },
            sendSetCombatStyle: async (index: number) => { control.style = index; return { success: true }; },
        },
        bot: {
            openBank: async () => { open = true; if (control.mode !== 'stale') generation++; return { success: true }; },
            depositItem: async (item: any) => { deposits++; const n = inv.filter(i => i.id === item.id).reduce((a, i) => a + i.count, 0); for (let at = inv.length - 1; at >= 0; at--) if (inv[at].id === item.id) inv.splice(at, 1); add(bank, item.id === 1512 ? 1511 : item.id, n); generation++; return { success: true }; },
            withdrawItem: async (item: any, n: number, options: any) => { withdrawals++; if (control.mode === 'lost') throw Error('lost unknown input'); item.count -= n; noteMode = !!options?.asNote; add(inv, noteMode && item.id === 1511 ? 1512 : item.id, n); if (control.mode !== 'withdraw-stale') generation++; if (control.mode === 'stop-after-withdraw') control.stop = true; return { success: true }; },
            unequipItem: async (item: any) => { open = false; wear.splice(wear.indexOf(item), 1); add(inv, item.id, item.count); if (item.slot === 3 && control.style === 3) control.style = 2; return { success: true }; },
            equipItem: async (item: any) => { equips++; open = false; if (control.mode === 'equip-refused') return { success: false }; const def = nativeKitItem(item.id); inv.splice(inv.indexOf(item), 1); wear.push({ ...item, slot: def.slot }); return { success: true }; },
        },
    };
    return { s, inv, wear, bank, player, control, withdrawals: () => withdrawals, deposits: () => deposits, equips: () => equips, tick: () => tick };
}

test('native kit rejects malformed, unknown, duplicate, nonwearable and twohand/shield conflicts', () => {
    expect(nativeKitItem(1307)).toMatchObject({ slot: 3, occupies: [3, 5] });
    for (const bad of [null, { ...kitJob, cap: 0 }, { ...kitJob, pack: [{ id: 999999, count: 1 }] }, { ...kitJob, pack: [{ id: 995, count: 1 }, { id: 995, count: 1 }] }, { ...kitJob, wear: [{ id: 995, count: 1, slot: 3 }] }, { ...kitJob, wear: [...kitJob.wear, { id: 1171, count: 1, slot: 5 }] }]) {
        expect(() => validateOwnedKit(bad)).toThrow();
    }
});

test('actual loadout consumer clears fullpack, banks displaced gear and equips twohand with exact pack and whole assets', async () => {
    const f = loadoutModel();
    const r = await runOwnedLoadout(f.s, kitJob);
    expect(r).toMatchObject({ ok: true, balanced: true, exactPack: true, exactWear: true, controlsPreserved: true, recoveryDeferred: false });
    expect(f.inv.map(i => [i.id, i.count]).sort()).toEqual([[556, 25], [995, 50]].sort());
    expect(f.wear.map(i => [i.id, i.slot])).toEqual([[1307, 3]]);
    expect(f.bank.find(i => i.id === 526).count).toBe(28);
    expect(f.bank.some(i => i.id === 1277)).toBe(true);
    expect(f.bank.some(i => i.id === 1171)).toBe(true);
    expect(f.s.bankObservation()).toBeNull();
});

test('missing any declared stock refuses before withdrawals or deposits and preserves original pack and gear', async () => {
    const f = loadoutModel(); f.bank.find(i => i.id === 1307).count = 0;
    const before = JSON.stringify([f.inv, f.wear, f.bank]);
    const r = await runOwnedLoadout(f.s, kitJob);
    expect(r.ok).toBe(false); expect(r.failure).toContain('stock missing');
    expect(f.withdrawals()).toBe(0); expect(f.deposits()).toBe(0);
    expect(JSON.stringify([f.inv, f.wear, f.bank])).toBe(before);
});

test('oversized nonstackable pack and unknown bank generation cannot spend owned stock', async () => {
    const f = loadoutModel(); f.bank.push({ id: 526, count: 1, slot: 3, name: 'Bones' });
    const r = await runOwnedLoadout(f.s, { ...kitJob, pack: [{ id: 526, count: 29 }] });
    expect(r.ok).toBe(false); expect(r.failure).toContain('exceeds28'); expect(f.withdrawals()).toBe(0);
    const g = loadoutModel('stale'); await g.s.bot.openBank(); const before = g.s.bankObservation().generation;
    g.s.sdk.sendCloseModal = async () => ({ success: true });
    const x = await runOwnedLoadout(g.s, kitJob);
    expect(x.ok).toBe(false); expect(g.withdrawals()).toBe(0); expect(g.s.bankObservation().generation).toBe(before);
});

test('stop after a settled withdrawal banks owned carried stock instead of reporting partial kit success', async () => {
    const f = loadoutModel('stop-after-withdraw');
    const r = await runOwnedLoadout(f.s, kitJob, () => f.control.stop);
    expect(r).toMatchObject({ ok: false, recovered: true, balanced: true, recoveryDeferred: false });
    expect(f.inv).toHaveLength(0); expect(f.wear).toHaveLength(0); expect(f.withdrawals()).toBe(1);
});

test('uncertain input or stale paired bank debit prevents any recovery mutation or repeat withdrawal', async () => {
    for (const mode of ['lost', 'withdraw-stale']) {
        const f = loadoutModel(mode);
        const r = await runOwnedLoadout(f.s, kitJob);
        expect(r.ok).toBe(false); expect(r.recoveryDeferred).toBe(true); expect(f.withdrawals()).toBe(1); expect(f.equips()).toBe(0);
    }
});

test('new life or ordinary initial stop sends no asset input', async () => {
    for (const mode of ['stop', 'life']) {
        const f = loadoutModel();
        if (mode === 'life') { const open = f.s.bot.openBank; f.s.bot.openBank = async () => { await open(); f.player.lifeId++; return { success: true }; }; }
        const r = await runOwnedLoadout(f.s, kitJob, () => mode === 'stop');
        expect(r.ok).toBe(false); expect(f.withdrawals()).toBe(0); expect(f.deposits()).toBe(0);
    }
});

test('global/account/role stop predicate needs no shared stopfiles', () => {
    expect(loadoutStopRequested('Owned', () => false, p => p === '.practice/stop-all')).toBe(true);
    expect(loadoutStopRequested('Owned', () => false, p => p === '.practice/stop-Owned')).toBe(true);
    expect(loadoutStopRequested('Owned', () => true, () => false)).toBe(true);
});

test('native stackable righthand darts equip the exact owned count instead of being restricted to quiver slot', async () => {
    const f = loadoutModel(); f.bank.push({ id: 806, count: 20, slot: 3, name: 'Bronze dart' });
    const r = await runOwnedLoadout(f.s, { ...kitJob, wear: [{ id: 806, count: 20, slot: 3 }] });
    expect(r).toMatchObject({ ok: true, exactWear: true, balanced: true });
    expect(f.wear).toContainEqual({ id: 806, count: 20, slot: 3, name: 'Bronze dart' });
});

test('noted and unnoted declared stock share one owned ledger and restore the original bank note mode', async () => {
    const f = loadoutModel(); f.bank.push({ id: 1511, count: 8, slot: 3, name: 'Logs' });
    const r = await runOwnedLoadout(f.s, { ...kitJob, pack: [{ id: 1511, count: 2 }, { id: 1512, count: 6 }] });
    expect(nativeKitItem(1512)).toMatchObject({ id: 1512, baseId: 1511, noted: true, stackable: true });
    expect(r).toMatchObject({ ok: true, balanced: true, exactPack: true, bankModeRestored: true });
    expect(f.inv.map(i => [i.id, i.count])).toEqual([[1511, 2], [1512, 6]]);
});

test('an exact existing kit is a zero-asset-move no-op with fresh bank conservation audit', async () => {
    const f = loadoutModel();
    const before = JSON.stringify([f.inv, f.wear, f.bank]);
    const r = await runOwnedLoadout(f.s, { ...kitJob, pack: [{ id: 526, count: 28 }], wear: [{ id: 1277, count: 1, slot: 3 }, { id: 1171, count: 1, slot: 5 }] });
    expect(r).toMatchObject({ ok: true, noOp: true, moves: 0, balanced: true });
    expect(f.withdrawals()).toBe(0); expect(f.deposits()).toBe(0); expect(f.equips()).toBe(0);
    expect(JSON.stringify([f.inv, f.wear, f.bank])).toBe(before);
});

test('current stat regeneration is allowed while actual XP change refuses all asset mutation', async () => {
    for (const mode of ['level', 'xp']) {
        const f = loadoutModel(), open = f.s.bot.openBank;
        f.s.bot.openBank = async () => { await open(); if (mode === 'level') f.control.level = 98; else f.control.xp++; return { success: true }; };
        const r = await runOwnedLoadout(f.s, kitJob);
        expect(r.ok).toBe(mode === 'level');
        if (mode === 'xp') { expect(f.withdrawals()).toBe(0); expect(f.deposits()).toBe(0); }
    }
});

test('native unarmed style3 clamp is restored only after the final compatible weapon is observed', async () => {
    const f = loadoutModel(); f.control.style = 3;
    const r = await runOwnedLoadout(f.s, kitJob);
    expect(r).toMatchObject({ ok: true, controlsPreserved: true });
    expect(f.control.style).toBe(3); expect(f.wear[0].id).toBe(1307);
});

test('incompatible target style refuses before deposits or withdrawals rather than leaving the actor naked', async () => {
    const f = loadoutModel(); f.control.style = 3; f.bank.push({ id: 837, count: 1, slot: 3, name: 'Crossbow' });
    const r = await runOwnedLoadout(f.s, { ...kitJob, wear: [{ id: 837, count: 1, slot: 3 }] });
    expect(r.ok).toBe(false); expect(r.failure).toContain('incompatible');
    expect(f.withdrawals()).toBe(0); expect(f.deposits()).toBe(0); expect(f.control.style).toBe(3);
    expect(f.wear.map(i => i.id)).toEqual([1277, 1171]);
});

test('known stopped partial loadout restores an original weapon when it is required to preserve style3', async () => {
    const f = loadoutModel('stop-after-withdraw'); f.control.style = 3;
    const r = await runOwnedLoadout(f.s, kitJob, () => f.control.stop);
    expect(r).toMatchObject({ ok: false, recovered: true, balanced: true, controlsPreserved: true });
    expect(f.control.style).toBe(3); expect(f.wear.map(i => i.id)).toEqual([1277]); expect(f.inv).toHaveLength(0);
});

test('missing native note-template observation refuses before any owned asset movement', async () => {
    const f = loadoutModel(), objType = f.s.client.objType;
    f.s.client.objType = (id: number) => id === 1512 ? { ...objType(id), certtemplate: undefined } : objType(id);
    f.bank.push({ id: 1511, count: 8, slot: 3, name: 'Logs' });
    const r = await runOwnedLoadout(f.s, { ...kitJob, pack: [{ id: 1512, count: 6 }] });
    expect(r.ok).toBe(false); expect(r.failure).toContain('noted identity');
    expect(f.deposits()).toBe(0); expect(f.withdrawals()).toBe(0);
});

// --- Supply Bootstrap & Supply Chain ---

test('destructive bootstrap accepts isolated loopback engines on their own ports', () => {
    for (const server of ['localhost:8888', '127.0.0.1:21000', '127.1.2.3:21010', '[::1]:21100', '::1', 'LOCALHOST:8888']) {
        expect(bootstrapPracticeServer(`SERVER=${server}\r\nPASSWORD=fixture\r\n`)).toBe(server);
    }
    expect(bootstrapPracticeServer('PASSWORD=fixture\n')).toBe('localhost:8888');
});

test('public endpoints and loopback-looking domain names never admit destructive bootstrap', () => {
    for (const server of ['rs-sdk-demo.fly.dev', 'example.com:8888', 'localhost.evil.test:8888', '127.0.0.1.evil.test:8888', '0.0.0.0:8888']) {
        expect(() => bootstrapPracticeServer(`SERVER=${server}\nDEMO_OK=1\n`)).toThrow('isolated loopback');
    }
    for (const name of ['', '../Haggis', 'worker.env', 'toolongaccountname']) expect(() => bootstrapAccountServer(name)).toThrow('valid practice account');
});

test('bootstrap CLI refuses a public endpoint before opening a session even with the public-server override', () => {
    const dir = mkdtempSync(join(ROOT, 'vendor/rs-sdk/bots', 'bp'));
    try {
        const name = basename(dir);
        writeFileSync(join(dir, 'bot.env'), 'SERVER=rs-sdk-demo.fly.dev\nPASSWORD=fixture-never-authenticate\n');
        const result = Bun.spawnSync([process.execPath, 'scripts/aio-logistics.ts', name, 'supply-bootstrap'], {
            cwd: ROOT, env: { ...process.env, ROLE: 'producer', PHASE: 'clean', DEMO_OK: '1' }, stdout: 'pipe', stderr: 'pipe', timeout: 15000, windowsHide: true,
        });
        const output = result.stdout.toString() + result.stderr.toString();
        expect(result.exitCode).toBe(1);
        expect(output).toMatch(/^RESULT fail (?:Error: )?supply bootstrap: isolated loopback practice actor required/m);
        expect(output).not.toMatch(/^START /m);
        expect(output).not.toContain('BOOTSTRAP_DISCARD');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('practice bootstrap requires the observed tutorial grant before discarding or earning', async () => {
    const dir = mkdtempSync(join(ROOT, 'vendor/rs-sdk/bots', 'bp')), name = basename(dir);
    writeFileSync(join(dir, 'bot.env'), 'SERVER=localhost:21000\nPASSWORD=fixture-never-authenticate\n');
    let tick = 0, discarded = 0, earned = 0;
    const listeners = new Set<() => void>(), client = {};
    setEquipmentObserved(client, true);
    const state: any = {
        player: { worldX: 3094, worldZ: 3106, level: 0, lifeId: 1, respawnCount: 0 }, inventory: [], equipment: [],
        skills: [{ name: 'Hitpoints', baseLevel: 10 }, ...Array.from({ length: 20 }, (_, i) => ({ name: 'skill' + i, baseLevel: 1 }))],
    };
    const s: any = {
        name, client, tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, ended: new Promise(() => {}),
        sdk: { getState: () => state, getInventory: () => state.inventory, getEquipment: () => state.equipment, getSkill: () => ({ level: 10, baseLevel: 10 }), sendDropItem: async () => { discarded++; return { success: true }; } },
        bot: { skipTutorial: async () => { throw Error('legacy tutorial path'); }, pickpocketNpc: async () => { earned++; return { success: true }; } },
    };
    const bounded = spyOn(walkHelpers, 'leaveRuneStarter').mockImplementation(async (session, stop) => {
        expect(session).toBe(s); expect(stop()).toBe(false); throw Error('starter entry deadline: grant unobserved');
    });
    const timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 1);
    try {
        await expect(bootstrapSupplyActor(s, 'producer', undefined, 'clean')).rejects.toThrow('starter entry deadline');
        expect(bounded).toHaveBeenCalledTimes(1); expect(discarded).toBe(0); expect(earned).toBe(0);
    } finally {
        clearInterval(timer); bounded.mockRestore(); rmSync(dir, { recursive: true, force: true });
    }
});

test('capital shortage earns before payout, real surplus waits for consumer demand', () => {
    expect(supplyAdmission(20, 14999, 62)).toBe('earn-reserve');
    expect(supplyAdmission(20, 15000, 62)).toBe('cycle');
    expect(supplyAdmission(80, 25000, 1000)).toBe('drain-food');
    expect(supplyAdmission(79, 10000, 1500)).toBe('cycle');
    expect(() => supplyAdmission(20, NaN, 62)).toThrow();
});

test('unknown bank is not an empty food reserve; restock counts owned feathers once', () => {
    expect(() => supplyCount({ inventory: [], bank: null }, [329])).toThrow();
    expect(supplyCount({ inventory: [{ id: 330, count: 2 }], bank: [{ id: 329, count: 4 }] }, [329, 330])).toBe(6);
    expect(supplyRestock(29)).toBe(971); expect(supplyRestock(1050)).toBe(0);
    expect(() => supplyRestock(-1)).toThrow();
});

// --- Relocation & Walk-To ---

test('unknown, wrong floor and old Ardougne bank starts are refused before travel', () => {
    const p = bankRelocationProfile();
    for (const q of [null, { worldX: 3092, worldZ: 3243, level: 1 }, { worldX: 2654, worldZ: 3283, level: 0 }, { worldX: 3097, worldZ: 3243, level: 0 }]) {
        expect(relocationStart(q, p)).toBe(false);
    }
    expect(relocationStart({ worldX: 3092, worldZ: 3243, level: 0 }, p)).toBe(true);
});

test('the native incomplete south-gate endpoint cannot seed the next unsafe leg', () => {
    const from = { x: 3250, z: 3360 }, goal = { x: 3243, z: 3380 };
    expect(() => completeBankPlan(() => [{ x: 3243, z: 3379 }])(0, from, goal)).toThrow('incomplete waypoint');
    expect(() => completeBankPlan(() => [])(0, from, goal)).toThrow('incomplete waypoint');
    const exact = [goal];
    expect(completeBankPlan(() => exact)(0, from, goal)).toBe(exact);
});

test('legacy knight relocation aliases remain available without granting an unknown starting tile', () => {
    for (const name of ['Haggis', 'main', 'stranger', 'Bigpackage', '']) expect(() => knightRelocationProfile(name)).toThrow('bank start required');
    expect(knightRelocationProfile('POCKETROCKET').name).toBe('Pocketrocket');
    for (const name of ['Pocketrocket', 'mmtha0205', 'Mightyrod', 'Freshworker']) {
        expect(() => knightRelocationProfile(name, { worldX: 3222, worldZ: 3218, level: 0 })).toThrow('bank start required');
        expect(() => knightRelocationProfile(name, { worldX: 2727, worldZ: 3492, level: 1 })).toThrow('bank start required');
    }
});

test('any ordinary account selects a known route from its observed bank rather than its name', () => {
    for (const name of ['Freshworker', 'Pocketrocket', 'mmtha0205', 'Mightyrod']) {
        expect(knightRelocationProfile(name, { worldX: 2721, worldZ: 3493, level: 0 }).name).toBe('seers');
        expect(knightRelocationProfile(name, { worldX: 2809, worldZ: 3441, level: 0 }).name).toBe('catherby');
        expect(knightRelocationProfile(name, { worldX: 2619, worldZ: 3332, level: 0 }).name).toBe('ardougne-north');
        expect(knightRelocationProfile(name, { worldX: 2655, worldZ: 3283, level: 0 }).points).toEqual([[2655, 3283]]);
    }
    expect(() => knightRelocationProfile('Pocketrocket', { worldX: 2720, worldZ: 3493, level: 0 })).toThrow('bank start required');
});

test('Seers actual booth at 2721,3493 is admitted at radius 6, and Catherby skips irrelevant Seers legs', () => {
    const p = knightRelocationProfile('Pocketrocket');
    expect(relocationStart({ worldX: 2721, worldZ: 3493, level: 0 }, p)).toBe(true);
    expect(relocationStart({ worldX: 2720, worldZ: 3493, level: 0 }, p)).toBe(false);
    expect(relocationStart({ worldX: 2721, worldZ: 3493, level: 1 }, p)).toBe(false);
    expect(p.points).toEqual([[2763, 3472], [2800, 3457], [2809, 3441], [2677, 3358], [2648, 3358], [2654, 3283]]);
    const c = knightRelocationProfile('mmtha0205');
    expect(c.points).toEqual(p.points.slice(2));
    expect(relocationStart({ worldX: 2807, worldZ: 3441, level: 0 }, c)).toBe(true);
});

test('Mighty only uses the explicit inverse guarded bank corridor', () => {
    const p = knightRelocationProfile('Mightyrod');
    expect(p.points).toEqual([[2644, 3293], [2655, 3283]]);
    expect(relocationStart({ worldX: 2618, worldZ: 3332, level: 0 }, p)).toBe(true);
    expect(relocationStart({ worldX: 2655, worldZ: 3283, level: 0 }, p)).toBe(false);
});

test('all food/tools/notes/cash count exactly across held, worn and bank; securing cash is not loss', () => {
    const initial = relocationAssets([{ id: 995, count: 13000 }, { id: 995, count: 10 }, { id: 329, count: 2 }, { id: 946, count: 1 }, { id: 1778, count: 500 }]);
    const final = relocationAssets([{ id: 995, count: 13010 }, { id: 329, count: 1 }, { id: 329, count: 1 }, { id: 946, count: 1 }, { id: 1778, count: 500 }]);
    expect(relocationPreserved(initial, final)).toBe(true);
    final.set(329, 1); expect(relocationPreserved(initial, final)).toBe(false);
    final.set(329, 2); final.set(995, 13009); expect(relocationPreserved(initial, final)).toBe(false);
});

test('latched damage stops the reused guard before another move or door operation', () => {
    let damaged = false, inputs = 0;
    const base: any = { pos: () => ({ x: 2721, z: 3493, level: 0 }), plan: () => [{ x: 2722, z: 3493 }], walk: () => { inputs++; }, interactLoc: () => { inputs++; } };
    const guard = guardCowWalker(base, () => damaged ? 'relocation first HP drop' : null);
    guard.deps.walk(2722, 3493); expect(inputs).toBe(1); damaged = true;
    guard.deps.walk(2722, 3493); guard.deps.interactLoc({ x: 2722, z: 3493, id: 1530 }, 1);
    expect(inputs).toBe(1); expect(guard.reason()).toBe('relocation first HP drop');
});

test('reused relocation guard forwards live-hunter avoidance to its existing route validator', () => {
    const avoid = [{ x: 2661, z: 3320 }], from = { x: 2655, z: 3283 }, to = { x: 2657, z: 3283 };
    let received: unknown;
    const base: any = { pos: () => ({ ...from, level: 0 }), plan: (_level: number, _from: unknown, _to: unknown, closed: unknown) => { received = closed; return [to]; }, walk: () => {}, interactLoc: () => {} };
    const guard = guardCowWalker(base, () => null);
    expect(guard.deps.plan(0, from, to, avoid)).toEqual([to]);
    expect(received).toBe(avoid); expect(guard.reason()).toBeNull();
});

test('relocation captures initial life primitives before a reused player object mutates', async () => {
    for (const field of ['lifeId', 'respawnCount'] as const) {
        const player = { worldX: 2619, worldZ: 3332, level: 0, lifeId: 1, respawnCount: 0, isDead: false };
        let generation = 0, opens = 0;
        const state = { player, equipment: [], skills: Array.from({ length: 21 }, (_, i) => ({ name: 'Skill' + i, experience: 0 })), nearbyNpcs: [] };
        const s: any = {
            tick: () => 0, ended: new Promise(() => {}), onTick: () => () => {}, bankObservation: () => generation ? { generation, items: [] } : null,
            sdk: { getState: () => state, getSkill: () => ({ level: 60 }), getInventory: () => [], getEquipment: () => [] },
            bot: { openBank: async () => { opens++; generation++; player[field]++; return { success: true }; } },
        };
        const result = await relocateKnight(s, 'Freshworker');
        expect(result.ok).toBe(false); expect(result.died).toBe(true); expect(result.failure).toContain('ended/dead'); expect(opens).toBe(1);
    }
});

test('a walk that starts on Tutorial Island skips the tutorial first; no other start does', async () => {
    const at = (worldX: number, worldZ: number) => ({ worldX, worldZ, level: 0 });
    for (const p of [at(3094, 3106), at(3056, 3060), at(3155, 3136)]) expect(onTutorialIsland(p)).toBe(true);
    for (const p of [at(3222, 3218), at(3109, 3162), at(2606, 3093), at(2790, 3066), null, undefined]) expect(onTutorialIsland(p)).toBe(false);
    const session = (p: ReturnType<typeof at>) => ({ sdk: { getState: () => ({ player: p }) } }) as never;
    const calls: string[] = [];
    const skip = (success: boolean) => async () => { calls.push('skip'); return { success, message: 'guide absent' }; };
    const ready = async () => { calls.push('ready'); };
    expect(await leaveTutorial(session(at(3094, 3106)), skip(true), ready)).toBeNull();
    expect(calls).toEqual(['ready', 'skip']);
    expect(await leaveTutorial(session(at(3094, 3106)), skip(false), ready)).toEqual({ ok: false, reason: 'precondition', detail: 'tutorial skip failed: guide absent', ticks: 0 });
    calls.length = 0;
    expect(await leaveTutorial(session(at(3222, 3218)), skip(true), ready)).toBeNull();
    expect(calls).toEqual([]);
});

test('approach cancellation bounds its default waiting tutorial before route dispatch', async () => {
    let tick = 0, legacy = 0;
    const listeners = new Set<() => void>(), state: any = { player: { worldX: 3094, worldZ: 3106, level: 0 }, nearbyNpcs: [{ name: 'RuneScape Guide' }], inventory: [], dialog: { isOpen: true, isWaiting: true, options: [] } };
    const s: any = {
        tick: () => tick, onTick: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); }, ended: new Promise(() => {}),
        sdk: { getState: () => state, getDialog: () => state.dialog, getInventory: () => state.inventory },
        bot: { skipTutorial: async () => { legacy++; throw Error('legacy tutorial path'); } },
    };
    const world = spyOn(owner, 'getWorld').mockResolvedValue({ route: () => { throw Error('must not route before tutorial exit'); } } as any);
    const log = spyOn(console, 'log').mockImplementation(() => {}), timer = setInterval(() => { tick++; for (const cb of [...listeners]) cb(); }, 1);
    try {
        const result = await approach(s, { x: 3092, z: 3243, level: 0 }, () => tick >= 5);
        expect(result).toMatchObject({ ok: false, reason: 'aborted' });
        expect(tick).toBeLessThanOrEqual(5); expect(legacy).toBe(0);
    } finally { clearInterval(timer); world.mockRestore(); log.mockRestore(); }
});

test('default tutorial exit handles the whole island and refuses an unknown guide choice', async () => {
    const state: any = { player: { worldX: 3155, worldZ: 3136, level: 0 }, inventory: [], dialog: { isOpen: true, isWaiting: false, options: [{ index: 1, text: 'Tell me about this place.', buttonType: 1 }] } };
    let legacy = 0, clicked = 0;
    const s: any = { tick: () => 0, onTick: () => () => {}, ended: new Promise(() => {}), sdk: { getState: () => state, getDialog: () => state.dialog, getInventory: () => state.inventory, sendClickDialog: async () => { clicked++; return { success: true }; } }, bot: { skipTutorial: async () => { legacy++; return { success: true }; } } };
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await leaveTutorial(s)).toMatchObject({ ok: false, reason: 'precondition', detail: expect.stringContaining('unsupported tutorial choice') }); expect(legacy).toBe(0); expect(clicked).toBe(0); }
    finally { log.mockRestore(); }
});

test('walk target parsing and declared ground/planned corridor checks', async () => {
    expect(parseTarget(['Pocketpython', '3165', '3487'])).toEqual({ account: 'Pocketpython', to: { x: 3165, z: 3487, level: 0 } });
    expect(parseTarget(['A', '1', '2', '1']).to.level).toBe(1);
    expect(() => parseTarget(['A', 'x', '2'])).toThrow();
    expect(() => parseTarget([])).toThrow();

    const calls: string[] = [];
    const s = { sdk: { getState: () => ({ player: { level: 0 } }) } } as any;
    const target = { x: 3013, z: 3355, level: 0 };
    const result = await walkTarget(s, target, true, {
        planned: async () => { throw Error('global planning must stay cold'); },
        ground: async (_s, to) => { calls.push('ground'); expect(to).toEqual(target); return { ok: true }; },
    });
    expect(result.ok).toBe(true); expect(calls).toEqual(['ground']);

    const refuse = async () => { throw Error('must not dispatch'); };
    await expect(walkTarget(s, { x: 1, z: 1, level: 1 }, true, { planned: refuse, ground: refuse })).rejects.toThrow('same plane');

    const planned = await walkTarget({} as any, { x: 1, z: 1, level: 0 }, false, {
        planned: async () => ({ ok: true }),
        ground: async () => { throw Error('ordinary travel changed'); },
    });
    expect(planned.ok).toBe(true);
});

test('an explicit boat retains fare, departure and arrival checks', () => {
    const from = { x: 2679, z: 3275, level: 0 }, to = { x: 2774, z: 3232, level: 0 };
    const boat = { id: 'test-boat', kind: 'boat', from, to, coins: 30, needs: [], runes: [], run: { how: 'npc' } } as any;
    const account = { coins: 30, items: [] } as any;
    expect(stagedBoat(boat, from, to, account).travel.id).toBe('test-boat');
    expect(() => stagedBoat(boat, from, to, { ...account, coins: 29 })).toThrow('unavailable');
    expect(() => stagedBoat(boat, { ...from, x: from.x + 9 }, to, account)).toThrow('departure');
    expect(() => stagedBoat(boat, from, { ...to, x: to.x + 1 }, account)).toThrow('arrival');
    expect(() => stagedBoat({ ...boat, kind: 'teleport' }, from, to, account)).toThrow('boat');
});

test('ferry fallbacks cover Taverley, east-to-Ardougne, Kandarin banks, Zanaris, and short plan budgets', async () => {
    const sailOk = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => ({ ok: true, ticks: 1 });
    {
        const from = { x: 2877, z: 3501, level: 0 }, to = { x: 2654, z: 3283, level: 0 };
        const calls: string[] = [];
        let coins = 60;
        const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => {
            calls.push(x + ',' + z);
            return calls.length === 1 ? { ok: false, reason: 'precondition', detail: 'no route to 2654,3283,0', ticks: 0 } : { ok: true, ticks: 1 };
        };
        const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toMatchObject({ ok: true });
        expect(calls).toEqual(['2654,3283', '3028,3216', 'npc:captain_tobias:karamja-musa-point@3028,3216', '2772,3225', 'npc:customs_officer:ardougne@2772,3225', '2654,3283']);
        expect(coins).toBe(0);
        calls.length = 0; coins = 1;
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toMatchObject({ ok: false, reason: 'precondition', detail: 'westbound ferry needs 60 coins in the pack' });
    }
    {
        const from = { x: 3269, z: 3164, level: 0 }, to = { x: 2615, z: 3332, level: 0 };
        const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 2615,3332,0', ticks: 0 };
        const calls: string[] = [];
        let coins = 70, loss = 0;
        const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => {
            calls.push(x + ',' + z);
            if (calls.length === 1) return noRoute;
            if (x === 3222) coins -= 10 + loss;
            return { ok: true, ticks: 1 };
        };
        const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toEqual({ ok: true, ticks: 7 });
        expect(calls).toEqual(['2615,3332', '3222,3218', '3092,3243', '3028,3216', 'npc:captain_tobias:karamja-musa-point@3028,3216', '2772,3225', 'npc:customs_officer:ardougne@2772,3225', '2615,3332']);
        expect(coins).toBe(0);
        calls.length = 0; coins = 70; loss = 1;
        const failed = await walkWithFerryFallback(from, to, walk, sail, () => coins);
        expect(failed).toMatchObject({ ok: false, detail: 'westbound ferry needs 60 coins in the pack' });
        expect(calls.some(c => c.startsWith('npc:'))).toBe(false);
        calls.length = 0; coins = 69;
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toMatchObject({ ok: false, detail: 'westbound ferry needs 70 coins in the pack' });
        expect(calls).toEqual(['2615,3332']);
        const aborted: Outcome = { ok: false, reason: 'aborted', detail: 'stop', ticks: 3 };
        expect(await walkWithFerryFallback(from, to, async () => aborted, sail, () => 100)).toBe(aborted);
    }
    {
        const to = { x: 3185, z: 3436, level: 0 }, home = '2619,3332';
        const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 3185,3436,0', ticks: 0 };
        for (const from of [{ x: 2809, z: 3441, level: 0 }, { x: 2727, z: 3493, level: 0 }, { x: 2612, z: 3093, level: 0 }, { x: 2529, z: 3236, level: 0 }]) {
            const calls: string[] = []; let coins = 0, plans = 0;
            const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { calls.push(x + ',' + z); return x + ',' + z === '3185,3436' && plans++ === 0 ? noRoute : { ok: true, ticks: 1 }; };
            const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
            expect(await walkWithFerryFallback(from, to, walk, sail, () => coins, async need => { calls.push('fare ' + need); coins = need; return { ok: true, ticks: 4 }; })).toEqual({ ok: true, ticks: 10 });
            expect(calls).toEqual([home, 'fare 60', '3185,3436', '2679,3275', 'npc:captain_barnaby:brimhaven@2679,3275', '2953,3147', 'npc:customs_officer:port-sarim@2953,3147', '3185,3436']);
        }
        const stuck: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 3 };
        expect(await walkWithFerryFallback({ x: 2809, z: 3441, level: 0 }, to, async () => stuck, sailOk, () => 60)).toEqual(stuck);
        const direct: string[] = [];
        const plain = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { direct.push(x + ',' + z); return { ok: true, ticks: 2 }; };
        expect(await walkWithFerryFallback({ x: 2895, z: 3440, level: 0 }, to, plain, sailOk, () => 0)).toEqual({ ok: true, ticks: 2 });
        expect(await walkWithFerryFallback({ x: 2809, z: 3441, level: 0 }, { x: 2619, z: 3332, level: 0 }, plain, sailOk, () => 0)).toEqual({ ok: true, ticks: 2 });
        expect(direct).toEqual(['3185,3436', '2619,3332']);
    }
    {
        const from = { x: 2584, z: 3293, level: 0 }, to = { x: 3185, z: 3436, level: 0 };
        const noRoute: Outcome = { ok: false, reason: 'precondition', detail: 'no route to 3185,3436,0', ticks: 0 };
        const calls: string[] = []; let coins = 60;
        const walk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { const first = !calls.some(c => /^\d+,\d+$/.test(c)); calls.push(x + ',' + z); return first ? noRoute : { ok: true, ticks: 1 }; };
        const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { calls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toEqual({ ok: true, ticks: 5 });
        expect(calls).toEqual(['3185,3436', '2679,3275', 'npc:captain_barnaby:brimhaven@2679,3275', '2953,3147', 'npc:customs_officer:port-sarim@2953,3147', '3185,3436']);
        expect(coins).toBe(0);
        calls.length = 0; coins = 59;
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins)).toMatchObject({ ok: false, detail: 'eastbound ferry needs 60 coins in the pack' });
        calls.length = 0; coins = 0;
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins, async need => { calls.push('fare ' + need); coins = need; return { ok: true, ticks: 4 }; })).toEqual({ ok: true, ticks: 9 });
        calls.length = 0; coins = 0;
        const empty: Outcome = { ok: false, reason: 'precondition', detail: 'ferry needs 60 coins and the bank holds 12', ticks: 3 };
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins, async () => empty)).toEqual(empty);
        expect(await walkWithFerryFallback(from, to, walk, sail, () => coins, async () => ({ ok: true, ticks: 2 }))).toMatchObject({ ok: false, detail: 'eastbound ferry needs 60 coins in the pack' });
        calls.length = 0; coins = 60;
        expect(await walkWithFerryFallback(from, to, async ({ x, z }) => { calls.push(x + ',' + z); return { ok: true, ticks: 7 }; }, sail, () => coins, async () => { calls.push('fare'); return { ok: true, ticks: 1 }; })).toEqual({ ok: true, ticks: 7 });
        expect(calls).toEqual(['3185,3436']);
        calls.length = 0; coins = 60;
        const bank = { x: 2618, z: 3333, level: 0 };
        const west = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { const first = !calls.length; calls.push(x + ',' + z); return first ? { ...noRoute, detail: 'no route to 2618,3333,0' } : { ok: true, ticks: 1 }; };
        expect(await walkWithFerryFallback({ x: 3020, z: 3347, level: 0 }, bank, west, sail, () => coins)).toEqual({ ok: true, ticks: 5 });
        calls.length = 0; coins = 60;
        expect(await walkWithFerryFallback({ x: 3071, z: 3347, level: 0 }, bank, west, sail, () => coins)).toEqual({ ok: true, ticks: 6 });
        expect(calls[1]).toBe('3092,3243');
        calls.length = 0; coins = 60;
        expect(await walkWithFerryFallback({ x: 2400, z: 3090, level: 0 }, to, walk, sail, () => coins)).toBe(noRoute);
        calls.length = 0;
        expect(await walkWithFerryFallback(from, { x: 2900, z: 3550, level: 0 }, walk, sail, () => coins)).toBe(noRoute);
    }
});

test('persistent walks, Zanaris bounds/exit, fare packing, awayFrom, and fareFault', async () => {
    const player = { worldX: 3185, worldZ: 3436, level: 0 };
    const s = { sdk: { getState: () => ({ player }) } } as any;
    const to = { x: 2619, z: 3332, level: 0 };
    let calls = 0;
    const closer = async () => { calls++; if (calls < 3) { player.worldX -= 200; return { ok: false, reason: 'timeout', detail: 'leg' }; } player.worldX = to.x; player.worldZ = to.z; return { ok: true }; };
    expect((await walkTargetPersist(s, to, 4, closer)).ok).toBe(true);
    expect(calls).toBe(3);
    calls = 0; player.worldX = 3185; player.worldZ = 3436;
    const stuck = async () => { calls++; return { ok: false, reason: 'blocked', detail: 'door' }; };
    expect(await walkTargetPersist(s, to, 4, stuck)).toEqual({ ok: false, reason: 'blocked', detail: 'door' });
    expect(calls).toBe(2);

    for (const [x, z] of [[3136, 9536], [3152, 9578], [3220, 9592], [3263, 9599]]) expect(inZanaris({ x: x!, z: z!, level: 0 })).toBe(true);
    for (const [x, z, level] of [[3135, 9578, 0], [3264, 9578, 0], [3152, 9535, 0], [3152, 9600, 0], [3152, 9578, 1]]) expect(inZanaris({ x: x!, z: z!, level: level! })).toBe(false);

    const zCalls: string[] = [], zWalk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { zCalls.push(x + ',' + z); return { ok: true, ticks: 1 }; };
    const noSail = async (): Promise<Outcome> => { throw Error('unexpected ferry inside Zanaris'); };
    expect(await walkWithFerryFallback({ x: 3220, z: 9592, level: 0 }, { x: 3152, z: 9578, level: 0 }, zWalk, noSail, () => 0)).toEqual({ ok: true, ticks: 1 });
    expect(await walkWithFerryFallback({ x: 3152, z: 9578, level: 0 }, { x: 3237, z: 9558, level: 0 }, zWalk, noSail, () => 0)).toEqual({ ok: true, ticks: 1 });
    expect(zCalls).toEqual(['3152,9578', '3237,9558']);

    const zanaris = { x: 3220, z: 9592, level: 0 }, shed = '3201,3169', bank = { x: 2619, z: 3332, level: 0 };
    const outCalls: string[] = []; let coins = 70;
    const outWalk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { outCalls.push(x + ',' + z); return outCalls.length === 2 ? { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 0 } : { ok: true, ticks: 1 }; };
    const sail = async (boat: ReturnType<typeof loadTravel>[number]): Promise<Outcome> => { outCalls.push(boat.id); coins -= boat.coins; return { ok: true, ticks: 1 }; };
    expect(await walkWithFerryFallback(zanaris, bank, outWalk, sail, () => coins)).toMatchObject({ ok: true });
    expect(outCalls.slice(0, 2)).toEqual([shed, '2619,3332']);
    expect(outCalls.filter(c => c.startsWith('npc:'))).toEqual(['npc:captain_tobias:karamja-musa-point@3028,3216', 'npc:customs_officer:ardougne@2772,3225']);

    const rows = (...ids: number[]) => ids.map(id => ({ id }));
    expect(fareSpare(rows(...Array(22).fill(1779), ...Array(6).fill(1897)))).toEqual({ id: 1779, all: false });
    expect(fareSpare(rows(...Array.from({ length: 28 }, (_, n) => 100 + n)))).toEqual({ id: 100, all: true });
    expect(fareSpare(rows(...Array(27).fill(1779)))).toBeNull();
    expect(fareSpare(rows(...Array(27).fill(1779), 995))).toBeNull();

    const market = { x: 2654, z: 3304, level: 0 };
    expect(awayFrom({ worldX: 2575, worldZ: 3269, level: 1 }, market, 80)).toBe(true);
    expect(awayFrom({ worldX: 2575, worldZ: 3269, level: 0 }, market, 80)).toBe(false);
    expect(awayFrom({ worldX: 2573, worldZ: 3269 }, market, 80)).toBe(true);
    expect(awayFrom(null, market, 80)).toBe(false);

    const house = { x: 2575, z: 3269, level: 1 }, pen = { x: 3017, z: 3288, level: 0 };
    const hCalls: string[] = []; let hCoins = 0;
    const hWalk = async ({ x, z }: { x: number; z: number }): Promise<Outcome> => { hCalls.push(x + ',' + z); return { ok: true, ticks: 3 }; };
    expect(await walkWithFerryFallback(house, pen, hWalk, async () => ({ ok: true, ticks: 1 }), () => hCoins, async need => { hCalls.push('fare ' + need); hCoins = need; return { ok: true, ticks: 4 }; })).toEqual({ ok: true, ticks: 10 });
    expect(hCalls).toEqual(['2619,3332', 'fare 60', '3017,3288']);

    const result = (fault: string) => `RESULT fail travel to Ardougne from 3092,3242 failed: precondition ${fault}`;
    expect(fareFault(60, 59, 0)).toBe('ferry needs 60 coins and the bank holds 0');
    expect(fareFault(60, 60, 59)).toBe('ferry needs 60 coins and the bank holds 59');
    expect(isPrerequisiteFailure(result(fareFault(60, 59, 0)))).toBe(true);
    expect(fareFault(60, 59, 11000)).toBe('ferry fare: the withdrawal of 59 coins failed, the bank holds 11000');
    expect(fareFault(60, 60, 60)).toBe('ferry fare: the withdrawal of 60 coins failed, the bank holds 60');
    expect(isPrerequisiteFailure(result(fareFault(60, 59, 11000)))).toBe(false);

    const budgets: (number | undefined)[] = [];
    const bWalk = async (_to: { x: number; z: number }, budget?: number): Promise<Outcome> => { budgets.push(budget); return budgets.length === 1 ? { ok: false, reason: 'precondition', detail: 'no route to 2619,3332,0', ticks: 0 } : { ok: true, ticks: 1 }; };
    await walkWithFerryFallback({ x: 3185, z: 3436, level: 0 }, { x: 2619, z: 3332, level: 0 }, bWalk, async () => ({ ok: true, ticks: 1 }), () => 60);
    expect(budgets[0]).toBe(15_000);
    budgets.length = 0;
    await walkWithFerryFallback({ x: 3185, z: 3436, level: 0 }, { x: 3222, z: 3218, level: 0 }, bWalk, async () => ({ ok: true, ticks: 1 }), () => 60);
    expect(budgets).toEqual([undefined]);
});
