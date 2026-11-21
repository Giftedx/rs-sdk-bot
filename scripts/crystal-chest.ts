// Opens Taverley Crystal chests from Falador West Bank and combines banked tooth/loop key halves into Crystal keys.
// Usage: bun scripts/crystal-chest.ts <account> [CAP ticks, default 2000]
// Env: MAX_KEYS (default 0: open all banked Crystal keys and combinable keyhalf1+keyhalf2 pairs).
import { existsSync } from 'node:fs';
import { openBot, finish, sessionDied } from '../packages/core/src/bot';
import { depositObserved } from '../packages/core/src/deposit';
import type { Session } from '../packages/core/src/inprocess';
import { waitUntil } from '../packages/core/src/ticks';
import type { Tile } from '../packages/core/src/world';
import { walkTargetPersist } from './walk-to';

export const KEY_TOOTH = 985, KEY_LOOP = 987, CRYSTAL_KEY = 989, UNCUT_DRAGONSTONE = 1631;
export const CHEST_CLOSED = 172, CHEST_OPEN = 173, MIN_FREE_SLOTS = 12;
export const FALADOR_WEST_BANK: Tile = { x: 2946, z: 3368, level: 0 };
export const TAVERLEY_CHEST_STAND: Tile = { x: 2914, z: 3451, level: 0 };
export const TAVERLEY_CHEST_TILE: Tile = { x: 2914, z: 3452, level: 0 };

export function planCrystalChest(
    heldKeys: number, heldTooth: number, heldLoop: number,
    bankKeys: number, bankTooth: number, bankLoop: number,
    maxKeys = 0,
): { combinePairs: number; keysToOpen: number } {
    const clean = [heldKeys, heldTooth, heldLoop, bankKeys, bankTooth, bankLoop, maxKeys];
    if (clean.some(n => !Number.isSafeInteger(n) || n < 0)) return { combinePairs: 0, keysToOpen: 0 };
    const totalPairs = Math.min(heldTooth + bankTooth, heldLoop + bankLoop);
    const totalKeys = heldKeys + bankKeys + totalPairs;
    const keysToOpen = maxKeys > 0 ? Math.min(totalKeys, maxKeys) : totalKeys;
    const combinePairs = maxKeys > 0 ? Math.min(totalPairs, Math.max(0, keysToOpen - heldKeys - bankKeys)) : totalPairs;
    return { combinePairs, keysToOpen };
}

export async function runCrystalChest(
    s: Session,
    opts: { cap?: number; maxKeys?: number; stop?: () => boolean; walk?: (to: Tile) => Promise<{ ok: boolean; reason?: string; detail?: string }> } = {},
) {
    const cap = opts.cap ?? 2000, maxKeys = opts.maxKeys ?? 0;
    if (!Number.isSafeInteger(cap) || cap < 1) throw Error('invalid crystal chest tick cap');
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 0) throw Error('invalid crystal chest MAX_KEYS');
    const start = s.tick(), st = () => s.sdk.getState(), pos = () => st()?.player, initialLife = pos();
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const stopped = () => ended || !!opts.stop?.() || sessionDied(initialLife, pos()) || existsSync(`.practice/stop-${s.name}`) || s.tick() - start >= cap;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);

    const openBank = async () => {
        const gen = s.bankObservation?.()?.generation ?? 0;
        if (!(await s.bot.openBank()).success || !await waitUntil(s, () => stopped() || (!!st()?.bank.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 15 }))
            throw Error('crystal chest bank observation unavailable');
    };
    const closeBank = async () => {
        await s.bot.closeBank();
        await waitUntil(s, () => stopped() || !st()?.bank.isOpen, { timeoutTicks: 10 });
    };
    const depositAll = async () => {
        for (const id of new Set(inv().map(i => i.id))) {
            const item = inv().find(i => i.id === id);
            if (item) await depositObserved(s, item);
        }
    };
    const withdraw = async (id: number, n: number) => {
        if (n < 1) return;
        const row = st()?.bank.items.find(i => i.id === id), before = count(id), stored = bankCount(id), gen = s.bankObservation?.()?.generation ?? 0;
        if (!row || stored < n) throw Error(`crystal chest withdraw short: item ${id} needs ${n}, bank holds ${stored}`);
        await s.bot.withdrawItem(row, n, { asNote: false });
        if (!await waitUntil(s, () => stopped() || (count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? 0) > gen), { timeoutTicks: 10 }))
            throw Error(`crystal chest withdraw unobserved for item ${id}`);
    };
    const walkTo = async (to: Tile, label: string) => {
        const res = await walkTargetPersist(s, to, 4, opts.walk);
        if (!res.ok) throw Error(`crystal chest walk to ${label} failed: ${res.reason ?? ''} ${res.detail ?? ''}`);
    };

    if (!await waitUntil(s, () => stopped() || (!!pos() && Array.isArray(st()?.inventory)), { timeoutTicks: 20 }))
        throw Error('crystal chest startup state unavailable');
    await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
    await openBank();
    await depositAll();

    const plan = planCrystalChest(0, 0, 0, bankCount(CRYSTAL_KEY), bankCount(KEY_TOOTH), bankCount(KEY_LOOP), maxKeys);
    if (plan.keysToOpen < 1) {
        await closeBank();
        throw Error('next acquisition: no crystal_key (989) or keyhalf1+keyhalf2 (985+987) in bank');
    }

    let combined = 0, opened = 0, dragonstones = 0;
    while (combined < plan.combinePairs && !stopped()) {
        const batch = Math.min(14, plan.combinePairs - combined);
        await withdraw(KEY_TOOTH, batch);
        await withdraw(KEY_LOOP, batch);
        await closeBank();
        while (count(KEY_TOOTH) > 0 && count(KEY_LOOP) > 0 && !stopped()) {
            const tooth = inv().find(i => i.id === KEY_TOOTH), loop = inv().find(i => i.id === KEY_LOOP);
            if (!tooth || !loop) break;
            const beforeKeys = count(CRYSTAL_KEY);
            await s.sdk.sendUseItemOnItem(tooth.slot, loop.slot);
            if (!await waitUntil(s, () => stopped() || count(CRYSTAL_KEY) > beforeKeys, { timeoutTicks: 8 }))
                throw Error('crystal key half combination unobserved');
            combined++;
        }
        await openBank();
        await depositAll();
    }

    const totalGoal = Math.min(plan.keysToOpen, bankCount(CRYSTAL_KEY));
    while (opened < totalGoal && !stopped()) {
        const carry = Math.min(2, totalGoal - opened, bankCount(CRYSTAL_KEY));
        if (carry < 1) break;
        await withdraw(CRYSTAL_KEY, carry);
        await closeBank();
        await walkTo(TAVERLEY_CHEST_STAND, 'Taverley Crystal Chest');
        while (count(CRYSTAL_KEY) > 0 && opened < totalGoal && !stopped()) {
            // Keep >= 12 inventory slots available once one key is deleted so the 11-rune + dragonstone drop cannot spill.
            if (28 - inv().length + 1 < MIN_FREE_SLOTS) break;
            const findClosedChest = () => (st()?.nearbyLocs ?? []).find(l => l.id === CHEST_CLOSED)
                ?? (st()?.nearbyLocs ?? []).find(l => /crystal chest/i.test(l.name) && l.id !== CHEST_OPEN);
            if (!await waitUntil(s, () => stopped() || !!findClosedChest(), { timeoutTicks: 15 }))
                throw Error('crystal chest closed loc unobserved');
            const chest = findClosedChest(), keyItem = inv().find(i => i.id === CRYSTAL_KEY);
            if (!chest || !keyItem) break;
            const keysBefore = count(CRYSTAL_KEY), stoneBefore = count(UNCUT_DRAGONSTONE);
            await s.bot.useItemOnLoc(keyItem.name, chest);
            if (!await waitUntil(s, () => stopped() || (count(CRYSTAL_KEY) < keysBefore && count(UNCUT_DRAGONSTONE) > stoneBefore), { timeoutTicks: 15 }))
                throw Error('crystal chest unlock/dragonstone unobserved');
            opened++;
            dragonstones += count(UNCUT_DRAGONSTONE) - stoneBefore;
        }
        await walkTo(FALADOR_WEST_BANK, 'Falador West Bank');
        await openBank();
        await depositAll();
    }
    const bankDragonstones = bankCount(UNCUT_DRAGONSTONE);
    await closeBank();
    return { ok: opened > 0 && !stopped(), opened, combined, dragonstones, bankDragonstones, ticks: s.tick() - start };
}

if (import.meta.main) {
    const argEnv = Object.fromEntries(process.argv.slice(2).flatMap(a => { const m = a.match(/^([A-Z_]+)=(.*)$/); return m ? [[m[1]!, m[2]!]] : []; }));
    const posArgs = process.argv.slice(2).filter(a => !/^[A-Z_]+=/.test(a));
    const account = posArgs[0];
    const cap = Number(posArgs[1] ?? 2000);
    const maxKeys = Number(argEnv.MAX_KEYS ?? process.env.MAX_KEYS ?? 0);
    if (!account) throw Error('account argument required');
    let stopped = false;
    const s = await openBot(account, { onStop: async () => { stopped = true; } });
    try {
        const r = await runCrystalChest(s, { cap, maxKeys, stop: () => stopped });
        await finish([s], r.ok, `opened=${r.opened} combined=${r.combined} dragonstones=${r.dragonstones} bankDragonstones=${r.bankDragonstones} ticks=${r.ticks}`);
    } catch (error) {
        await finish([s], false, String(error));
    }
}
