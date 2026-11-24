import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bankTravelTolerance, fittingBankBatch, planBankTripSchedule, validateBankRouteJob, type BankProfile, type BankRouteJob, type Tile } from '../../../core/src/bank-trip';
import { accountOf, getWorld } from '../../../core/src/bot';
import { depositObserved } from '../../../core/src/deposit';
import type { Session } from '../../../core/src/inprocess';
import { waitTicks, waitUntil } from '../../../core/src/ticks';
import { goTo, sessionWalker, walkPath } from '../../../core/src/walk';

export type BankBatchPreparation =
    | { status: 'unknown' }
    | { status: 'ready' | 'short' | 'no-capacity'; generation: number; amount: number; shortfalls: Record<number, number>; missingTools: number[]; orderShortfalls?: Record<number, number> };

let nativeItemIds: Set<number> | undefined;
function loadNativeItemIds(): Set<number> {
    if (nativeItemIds) return nativeItemIds;
    const text = readFileSync(resolve(import.meta.dir, '../../../../vendor/rs-sdk/server/content/pack/obj.pack'), 'utf8');
    nativeItemIds = new Set<number>();
    let pos = 0;
    while (pos < text.length) {
        let end = text.indexOf('\n', pos);
        if (end < 0) end = text.length;
        const eq = text.indexOf('=', pos);
        if (eq > pos && eq < end) {
            const id = Number(text.slice(pos, eq));
            if (Number.isInteger(id) && id >= 0) nativeItemIds.add(id);
        }
        pos = end + 1;
    }
    return nativeItemIds;
}

export async function runMarketBankProfile(
    s: Session,
    j: BankRouteJob,
    p: BankProfile,
    requestStop: () => boolean = () => false,
) {
    validateBankRouteJob(j);
    const nativeItems = loadNativeItemIds();
    for (const id of [...Object.keys(p.inputs).map(Number), ...Object.keys(p.capacityOutputs ?? {}).map(Number), ...p.tools, ...p.outputs]) {
        if (!nativeItems.has(id)) throw Error('bank profile native item unknown ' + id);
    }
    if ([...Object.values(p.inputs), ...Object.values(p.capacityOutputs ?? {})].some(n => !Number.isSafeInteger(n) || n < 1)) {
        throw Error('bank profile input count invalid');
    }
    for (const tile of [p.bank, p.site]) {
        if (![tile.x, tile.z, tile.level].every(Number.isSafeInteger) || tile.level < 0 || tile.level > 3 || tile.x < 0 || tile.x > 16383 || tile.z < 0 || tile.z > 16383) {
            throw Error('bank profile tile invalid');
        }
    }
    const start = s.tick();
    const first = s.sdk.getState()?.player;
    const hp0 = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let ended = false;
    void s.ended.then(() => { ended = true; });
    const initialLife = first?.lifeId;
    const inv = () => s.sdk.getInventory();
    const count = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const bankCount = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const related = new Set([...Object.keys(p.inputs).map(Number), ...p.tools, ...p.outputs]);
    const protectedPack = new Map(inv().filter(i => !related.has(i.id)).map(i => [i.id, count(i.id)]));
    const dead = () => {
        const st = s.sdk.getState()?.player;
        return ended || !first || !st || st.isDead || st.lifeId !== initialLife || (s.sdk.getSkill('Hitpoints')?.level ?? 0) <= 0;
    };
    const stop = () => dead() || requestStop() || existsSync(`.practice/stop-${s.name}`) || existsSync('.practice/stop-all')
        || s.tick() - start >= j.cap - j.returnTicks || (s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0;
    const returningStop = () => dead() || s.tick() - start >= j.cap;
    const observedBank = () => {
        const at = s.sdk.getState()?.player;
        return !dead() && !!at && at.level === p.bank.level && Math.max(Math.abs(at.worldX - p.bank.x), Math.abs(at.worldZ - p.bank.z)) <= 3;
    };
    const selfBanked = ['inventory', 'wine', 'bones'].includes(j.family);
    let completed = 0;
    let trips = 0;
    const banked: Record<number, number> = {};
    let failure = '';
    let atBank = observedBank();
    let recoveryDeferred = false;
    let preparation: BankBatchPreparation | undefined = selfBanked ? undefined : { status: 'unknown' };

    const targetMet = () => {
        if (j.targetLevel === undefined) return completed >= j.target;
        const base = s.sdk.getSkill('Cooking')?.baseLevel;
        if (!Number.isSafeInteger(base) || base! < 1 || base! > 99) throw Error('bank job Cooking base level unknown');
        return base! >= j.targetLevel;
    };

    const travel = async (to: Tile, returning = false) => {
        atBank = observedBank();
        const check = returning ? returningStop : stop;
        if (check()) throw Error('bank job stopped before travel');
        const atStart = s.sdk.getState()?.player;
        const tol = bankTravelTolerance(j.family, to === p.site);
        if (atStart && atStart.level === to.level && Math.max(Math.abs(atStart.worldX - to.x), Math.abs(atStart.worldZ - to.z)) <= tol) return;
        const controller = new AbortController();
        const off = s.onTick(() => { if (check()) controller.abort('bank job travel bound'); });
        try {
            const from = s.sdk.getState()?.player;
            const remaining = Math.max(1, j.cap - (s.tick() - start));
            const result = from && from.level === to.level && Math.max(Math.abs(from.worldX - to.x), Math.abs(from.worldZ - to.z)) <= 128
                ? await walkPath(await sessionWalker(s), [{ ...to, tol }], { stop: check })
                : await goTo(s, await getWorld(), to, accountOf(s), { signal: controller.signal, legTimeoutTicks: Math.min(120, remaining), maxRetriesPerLeg: 1 });
            if (!result.ok) throw Error('bank job route ' + result.detail);
            const at = s.sdk.getState()?.player;
            atBank = !!at && at.level === p.bank.level && Math.max(Math.abs(at.worldX - p.bank.x), Math.abs(at.worldZ - p.bank.z)) <= 3;
        } finally {
            off();
            atBank = observedBank();
        }
    };

    const open = async () => {
        if (returningStop()) throw Error('bank job bank budget exhausted');
        if (s.sdk.getState()?.bank.isOpen && s.bankObservation?.()) return;
        await s.sdk.sendCloseModal();
        await waitUntil(s, () => !s.sdk.getState()?.interface.isOpen && !s.sdk.getState()?.dialog.isOpen, { timeoutTicks: 8 });
        const g = s.bankObservation?.()?.generation ?? -1;
        const result = await s.bot.openBank();
        if (!result.success || !await waitUntil(s, () => !!s.sdk.getState()?.bank.isOpen && (s.bankObservation?.()?.generation ?? -1) > g, { timeoutTicks: 12 })) {
            throw Error('bank job fresh bank unavailable');
        }
    };

    const secure = async (credit: boolean) => {
        await open();
        for (const id of related) {
            const item = inv().find(i => i.id === id);
            if (item) {
                const n = await depositObserved(s, item);
                if (credit && p.outputs.includes(id)) banked[id] = (banked[id] ?? 0) + n;
            }
        }
    };

    try {
        if (!first || hp0 < 1) throw Error('bank job initial state missing');
        await travel(p.bank);
        await secure(false);
        while (!targetMet()) {
            if (stop()) throw Error('bank job stopped before refill');
            if (!selfBanked) preparation = { status: 'unknown' };
            await open();
            const remaining = j.targetLevel === undefined ? j.target - completed : Math.max(1, j.target - completed);
            if (selfBanked) {
                const amount = j.targetLevel === undefined ? remaining : Math.min(j.batch, remaining);
                const initial = Object.fromEntries(p.outputs.map(id => [id, bankCount(id)]));
                await s.bot.closeBank();
                await p.run(amount, j.cap - j.returnTicks - (s.tick() - start), stop);
                completed += amount;
                await travel(p.bank, true);
                await secure(false);
                for (const id of p.outputs) banked[id] = (banked[id] ?? 0) + bankCount(id) - initial[id]!;
                continue;
            }
            const type = s.client as { objType: (id: number) => { stackable: boolean } };
            const observation = s.bankObservation?.();
            if (!observation) throw Error('bank job fresh bank unavailable');
            const stackable = (id: number) => {
                const value = type.objType(id)?.stackable;
                if (typeof value !== 'boolean') throw Error('native item stackability unknown ' + id);
                return value;
            };
            const freeSlots = 28 - inv().length;
            const amount = fittingBankBatch(p.inputs, p.tools, Math.min(j.batch, remaining), freeSlots, stackable, p.capacityOutputs);
            if (amount < 1) {
                preparation = { status: 'no-capacity', generation: observation.generation, amount: 0, shortfalls: {}, missingTools: [] };
                throw Error('bank job pack cannot fit a batch');
            }
            const bankStock: Record<number, number> = {};
            for (const item of observation.items) bankStock[item.id] = (bankStock[item.id] ?? 0) + item.count;
            const options = { inputs: p.inputs, tools: p.tools, outputs: p.capacityOutputs, bankStock, reserve: j.reserve, freeSlots, stackable };
            const schedule = planBankTripSchedule({ ...options, target: amount });
            const order = planBankTripSchedule({ ...options, target: remaining });
            preparation = {
                status: schedule.ready ? 'ready' : 'short',
                generation: observation.generation,
                amount,
                shortfalls: schedule.shortfalls,
                missingTools: schedule.missingTools,
                orderShortfalls: order.shortfalls,
            };
            if (!schedule.ready) throw Error('bank job stock short ' + JSON.stringify({ inputs: schedule.shortfalls, tools: schedule.missingTools }));
            const withdrawals = new Map<number, number>();
            for (const id of new Set(p.tools)) withdrawals.set(id, count(id) ? 0 : 1);
            for (const [id, n] of Object.entries(p.inputs)) withdrawals.set(Number(id), (withdrawals.get(Number(id)) ?? 0) + n * amount);
            for (const [id, n] of withdrawals) {
                if (!n) continue;
                if (stop()) throw Error('bank job stopped before withdrawal');
                const row = s.sdk.getState()?.bank.items.find(i => i.id === id);
                if (!row || bankCount(id) - n < (Object.hasOwn(p.inputs, id) ? (j.reserve ?? 0) : 0)) throw Error('bank job stock short ' + id);
                const before = count(id);
                const stored = bankCount(id);
                const g = s.bankObservation!()!.generation;
                await s.bot.withdrawItem(row, n, { asNote: false });
                if (!await waitUntil(s, () => count(id) === before + n && bankCount(id) === stored - n && (s.bankObservation?.()?.generation ?? -1) > g, { timeoutTicks: 10 })) {
                    throw Error('bank job withdrawal does not reconcile ' + id);
                }
            }
            await s.bot.closeBank();
            if (!await waitUntil(s, () => !s.sdk.getState()?.bank.isOpen, { timeoutTicks: 8 })) throw Error('bank job bank remains open');
            await p.prepare?.(stop);
            await travel(p.site);
            console.log('BANK_JOB_PHASE ' + JSON.stringify({
                phase: 'produce',
                family: j.family,
                amount,
                tick: s.tick() - start,
                position: s.sdk.getState()?.player && [s.sdk.getState()!.player!.worldX, s.sdk.getState()!.player!.worldZ],
            }));
            const actual = await p.run(amount, j.cap - j.returnTicks - (s.tick() - start), stop);
            completed += actual ?? amount;
            trips++;
            await waitTicks(s, 3);
            await travel(p.bank, true);
            await secure(true);
        }
    } catch (error) {
        failure = String(error);
        try {
            recoveryDeferred = p.deferBankRecovery?.() ?? false;
        } catch (decision) {
            recoveryDeferred = true;
            failure += '; recovery decision ' + String(decision);
        }
        try {
            if (!dead() && !recoveryDeferred) {
                for (const item of inv()) if (!protectedPack.has(item.id)) related.add(item.id);
                await s.sdk.sendCloseModal();
                await travel(p.bank, true);
                await secure(true);
            }
        } catch (recovery) {
            failure += '; return ' + String(recovery);
        }
    } finally {
        if (!dead() && !recoveryDeferred) await s.bot.closeBank();
    }
    atBank = observedBank();
    if ([...protectedPack].some(([id, n]) => count(id) !== n)) failure += '; protected stock changed';
    if ((s.sdk.getSkill('Hitpoints')?.level ?? 0) < hp0) failure += '; health changed';
    const ok = !failure && targetMet() && atBank && !dead() && !requestStop() && s.tick() - start < j.cap;
    return {
        ok,
        family: j.family,
        recipe: j.recipe,
        completed,
        trips,
        banked,
        atBank,
        recoveryDeferred,
        ticks: s.tick() - start,
        failure: failure || '-',
        ...(preparation ? { preparation } : {}),
        ...(j.targetLevel === undefined ? {} : { targetLevel: j.targetLevel, level: s.sdk.getSkill('Cooking')?.baseLevel }),
    };
}
