// Conserved trade receipts, order reconciliation, and offer gating for owned handoffs.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Session } from '../../../core/src/inprocess';
import { waitUntil } from '../../../core/src/ticks';
import { REPO_ROOT } from './types';

type Items = { id: number; count: number }[];
export type OrderHoldings = { bank: Items; pack: Items };
export type OrderSnapshot = { donor: OrderHoldings; receiver: OrderHoldings };

// Recovery is based on conserved holdings, never on a trade reply or a log line.
export function reconcileOrder(receipt: any, current: OrderSnapshot): 'resume' | 'bank' | 'settle' {
    if (!receipt?.baseline || !Array.isArray(receipt.expected) || !receipt.expected.length) {
        throw Error('order unresolved: bank/pack baseline missing; ' + JSON.stringify({ receipt, current }));
    }
    const expected: Items = receipt.expected;
    const expectedIds = expected.length > 1 ? new Set<number>() : null;
    for (let i = 0; i < expected.length; i++) {
        const row = expected[i]!;
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || !Number.isSafeInteger(row.count) || row.count <= 0) {
            throw Error('order unresolved: invalid expected items');
        }
        if (expectedIds) {
            if (expectedIds.has(row.id)) throw Error('order unresolved: invalid expected items');
            expectedIds.add(row.id);
        }
    }
    const validateAndSum = (items: Items, id: number): number => {
        if (!Array.isArray(items)) throw Error('order unresolved: invalid saved holdings');
        let sum = 0;
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.count) || item.count < 0) {
                throw Error('order unresolved: invalid saved holdings');
            }
            if (item.id === id) sum += item.count;
        }
        if (!Number.isSafeInteger(sum)) throw Error('order unresolved: holdings overflow');
        return sum;
    };
    const validateAndSumMap = (items: Items): Map<number, number> => {
        if (!Array.isArray(items)) throw Error('order unresolved: invalid saved holdings');
        const map = new Map<number, number>();
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (!Number.isSafeInteger(item.id) || !Number.isSafeInteger(item.count) || item.count < 0) {
                throw Error('order unresolved: invalid saved holdings');
            }
            const next = (map.get(item.id) ?? 0) + item.count;
            if (!Number.isSafeInteger(next)) throw Error('order unresolved: holdings overflow');
            map.set(item.id, next);
        }
        return map;
    };
    if (expected.length === 1) {
        const item = expected[0]!;
        const id = item.id;
        const baseDonor = validateAndSum(receipt.baseline.donor.bank, id) + validateAndSum(receipt.baseline.donor.pack, id);
        const curDonor = validateAndSum(current.donor.bank, id) + validateAndSum(current.donor.pack, id);
        const baseRecBank = validateAndSum(receipt.baseline.receiver.bank, id);
        const initialPack = validateAndSum(receipt.baseline.receiver.pack, id);
        const curRecBank = validateAndSum(current.receiver.bank, id);
        const receiverPack = validateAndSum(current.receiver.pack, id);
        if (!Number.isSafeInteger(baseDonor) || !Number.isSafeInteger(curDonor)
            || !Number.isSafeInteger(baseRecBank + initialPack) || !Number.isSafeInteger(curRecBank + receiverPack)) {
            throw Error('order unresolved: total overflow');
        }
        const donorDebit = baseDonor - curDonor;
        const receiverCredit = (curRecBank + receiverPack) - (baseRecBank + initialPack);
        const bankCredit = curRecBank - baseRecBank;
        if (donorDebit === 0 && receiverCredit === 0) return 'resume';
        if (donorDebit === item.count && receiverCredit === item.count) {
            return receiverPack === 0 && bankCredit === item.count + initialPack ? 'settle' : 'bank';
        }
        throw Error('order unresolved: uncertain bank/pack facts ' + JSON.stringify({
            facts: [{ id, expected: item.count, donorDebit, receiverCredit, bankCredit, receiverPack, initialPack }],
            baseline: receipt.baseline,
            current,
        }));
    }
    const bDonorBank = validateAndSumMap(receipt.baseline.donor.bank);
    const bDonorPack = validateAndSumMap(receipt.baseline.donor.pack);
    const cDonorBank = validateAndSumMap(current.donor.bank);
    const cDonorPack = validateAndSumMap(current.donor.pack);
    const bRecBank = validateAndSumMap(receipt.baseline.receiver.bank);
    const bRecPack = validateAndSumMap(receipt.baseline.receiver.pack);
    const cRecBank = validateAndSumMap(current.receiver.bank);
    const cRecPack = validateAndSumMap(current.receiver.pack);
    const facts = [];
    let allResume = true;
    let allTransferred = true;
    let allSettled = true;
    for (let i = 0; i < expected.length; i++) {
        const exp = expected[i]!;
        const id = exp.id;
        const baseDonor = (bDonorBank.get(id) ?? 0) + (bDonorPack.get(id) ?? 0);
        const curDonor = (cDonorBank.get(id) ?? 0) + (cDonorPack.get(id) ?? 0);
        const baseRecBank = bRecBank.get(id) ?? 0;
        const initialPack = bRecPack.get(id) ?? 0;
        const curRecBank = cRecBank.get(id) ?? 0;
        const receiverPack = cRecPack.get(id) ?? 0;
        if (!Number.isSafeInteger(baseDonor) || !Number.isSafeInteger(curDonor)
            || !Number.isSafeInteger(baseRecBank + initialPack) || !Number.isSafeInteger(curRecBank + receiverPack)) {
            throw Error('order unresolved: total overflow');
        }
        const donorDebit = baseDonor - curDonor;
        const receiverCredit = (curRecBank + receiverPack) - (baseRecBank + initialPack);
        const bankCredit = curRecBank - baseRecBank;
        facts.push({ id, expected: exp.count, donorDebit, receiverCredit, bankCredit, receiverPack, initialPack });
        if (donorDebit !== 0 || receiverCredit !== 0) allResume = false;
        if (donorDebit !== exp.count || receiverCredit !== exp.count) allTransferred = false;
        if (receiverPack !== 0 || bankCredit !== exp.count + initialPack) allSettled = false;
    }
    if (allResume) return 'resume';
    if (allTransferred) return allSettled ? 'settle' : 'bank';
    throw Error('order unresolved: uncertain bank/pack facts ' + JSON.stringify({ facts, baseline: receipt.baseline, current }));
}

type Request = { token: string; from: string; to: string; server: string; at: number; state: 'prepared' | 'settled'; expected: Items };

const legacyRoot = resolve(REPO_ROOT, '.practice/courier-handoffs');
const canonical = (p: string) => resolve(p).replaceAll('\\', '/').toLowerCase();
const inFoodRoot = (p: string) => canonical(p) === canonical(legacyRoot) || canonical(p).startsWith(canonical(legacyRoot) + '/');

export function createHandoff(allowedIds: readonly number[], root: string) {
    if (!allowedIds.length || new Set(allowedIds).size !== allowedIds.length || allowedIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        throw Error('invalid handoff item policy');
    }
    const food = new Set(allowedIds);
    const dir = resolve(root);
    const isFood = [330, 334, 380].every(id => food.has(id)) && food.size === 3;
    if (!isFood && inFoodRoot(dir)) throw Error('item policy cannot use food receipts');

    const file = (from: string, to: string, targetRoot = dir) => {
        if (![from, to].every(n => /^[A-Za-z0-9_ -]{1,12}$/.test(n))) throw Error('no courier progress: invalid handoff identity');
        if (!isFood && inFoodRoot(targetRoot)) throw Error('item policy cannot use food receipts');
        return join(targetRoot, `${from.toLowerCase()}-${to.toLowerCase()}.json`);
    };

    const read = (p: string): any => {
        try {
            return JSON.parse(readFileSync(p, 'utf8'));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw Error('no courier progress: unreadable handoff receipt');
        }
    };

    const save = (p: string, value: unknown) => {
        mkdirSync(dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, p);
    };

    function handoffCounts(items: Items): Items {
        if (!Array.isArray(items)) throw Error('no courier progress: invalid handoff inventory');
        const out: Items = [];
        for (let idx = 0; idx < items.length; idx++) {
            const i = items[idx]!;
            if (!Number.isSafeInteger(i.id) || !Number.isSafeInteger(i.count) || i.count < 0) {
                throw Error('no courier progress: invalid handoff inventory');
            }
            if (i.count === 0 || !food.has(i.id)) continue;
            let found = false;
            for (let k = 0; k < out.length; k++) {
                if (out[k]!.id === i.id) {
                    out[k]!.count += i.count;
                    found = true;
                    break;
                }
            }
            if (!found) out.push({ id: i.id, count: i.count });
        }
        if (out.length > 1) out.sort((a, b) => a.id - b.id);
        return out;
    }

    const delta = (before: Items, after: Items) => {
        const a = handoffCounts(before), b = handoffCounts(after);
        const out: Items = [];
        let i = 0;
        let j = 0;
        while (i < a.length && j < b.length) {
            const ai = a[i]!, bj = b[j]!;
            if (ai.id === bj.id) {
                const diff = bj.count - ai.count;
                if (diff !== 0) out.push({ id: ai.id, count: diff });
                i++;
                j++;
            } else if (ai.id < bj.id) {
                out.push({ id: ai.id, count: -ai.count });
                i++;
            } else {
                out.push({ id: bj.id, count: bj.count });
                j++;
            }
        }
        while (i < a.length) {
            const ai = a[i++]!;
            out.push({ id: ai.id, count: -ai.count });
        }
        while (j < b.length) {
            const bj = b[j++]!;
            out.push({ id: bj.id, count: bj.count });
        }
        return out;
    };

    const same = (a: Items, b: Items) => {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i]!.id !== b[i]!.id || a[i]!.count !== b[i]!.count) return false;
        }
        return true;
    };

    async function awaitCollectionOffer(s: Session, from: string, server: string, timeoutTicks: number, targetRoot = dir): Promise<void> {
        const p = file(from, s.name, targetRoot);
        const started = Date.now();
        const offered = () => {
            const r = read(p), now = Date.now();
            return r?.state === 'prepared' && typeof r.token === 'string' && r.token.length > 0
                && r.from?.toLowerCase() === from.toLowerCase() && r.to?.toLowerCase() === s.name.toLowerCase()
                && r.server === server && Number.isFinite(r.at) && r.at >= started && r.at <= now
                && now - r.at <= 120000 && Array.isArray(r.expected) && r.expected.length > 0
                && r.expected.every((i: any) => food.has(i?.id) && Number.isSafeInteger(i.count) && i.count > 0);
        };
        if (!Number.isSafeInteger(timeoutTicks) || timeoutTicks < 1 || !await waitUntil(s, offered, { timeoutTicks }) || !offered()) {
            throw Error('no courier progress: fresh cook receipt offer missing; no trade accepted');
        }
    }

    function handoffCreditMatches(r: Request, credit: any, before: Items, after: Items, now: number): boolean {
        try {
            const debit = delta(after, before), expected = handoffCounts(r.expected);
            return r.state === 'prepared'
                && r.expected.every(i => food.has(i.id) && Number.isSafeInteger(i.count) && i.count > 0)
                && expected.length > 0 && expected.every(i => i.count > 0)
                && Number.isFinite(r.at) && r.at <= now && now - r.at <= 120000
                && credit?.token === r.token && credit.from === r.from && credit.to === r.to && credit.server === r.server
                && Number.isFinite(credit.at) && credit.at >= r.at && credit.at <= now
                && same(debit, expected) && same(delta(credit.before, credit.after), expected);
        } catch {
            return false;
        }
    }

    async function receiveHandoff<T>(s: Session, from: string, server: string, serve: () => Promise<T>, targetRoot = dir): Promise<T> {
        const p = file(from, s.name, targetRoot), before = handoffCounts(s.sdk.getInventory());
        const result = await serve();
        const request = read(p);
        const valid = () => request?.state === 'prepared' && typeof request.token === 'string' && request.token.length > 0
            && request.from?.toLowerCase() === from.toLowerCase() && request.to?.toLowerCase() === s.name.toLowerCase() && request.server === server
            && Number.isFinite(request.at) && request.at <= Date.now() && Date.now() - request.at <= 120000
            && Array.isArray(request.expected) && request.expected.length > 0
            && request.expected.every((i: any) => food.has(i?.id) && Number.isSafeInteger(i.count) && i.count > 0);
        if (valid()) {
            const matched = () => valid() && same(delta(before, handoffCounts(s.sdk.getInventory())), handoffCounts(request.expected));
            if (!matched()) await waitUntil(s, matched, { timeoutTicks: 8 });
            if (matched()) {
                const current = read(p);
                if (JSON.stringify(current) !== JSON.stringify(request)) throw Error('no courier progress: handoff changed during settlement');
                save(`${p}.credit`, { token: request.token, from: request.from, to: request.to, server, at: Date.now(), before, after: handoffCounts(s.sdk.getInventory()) });
            }
        }
        return result;
    }

    async function collectHandoff<T>(s: Session, from: string, server: string, serve: () => Promise<T>, targetRoot = dir): Promise<{ result: T; received: number }> {
        const p = file(from, s.name, targetRoot), initial = read(p);
        const before = handoffCounts(s.sdk.getInventory()), started = Date.now();
        const result = await receiveHandoff(s, from, server, serve, targetRoot);
        const after = handoffCounts(s.sdk.getInventory());
        if (same(before, after)) return { result, received: 0 };
        const credit = read(`${p}.credit`);
        if (!credit || credit.at < started || (initial?.state === 'settled' && initial.token === credit.token)
            || !same(credit.before, before) || !same(credit.after, after)) {
            throw Error('no courier progress: collection credit unbound; reconcile before retry');
        }
        let received = 0;
        const settled = () => {
            const r = read(p);
            if (r?.state !== 'settled' || r.token !== credit.token || r.from?.toLowerCase() !== from.toLowerCase()
                || r.to?.toLowerCase() !== s.name.toLowerCase() || r.server !== server
                || !handoffCreditMatches({ ...r, state: 'prepared' }, credit, r.before, r.after, Date.now())) return false;
            received = handoffCounts(r.expected).reduce((n, i) => n + i.count, 0);
            return true;
        };
        if (!await waitUntil(s, settled, { timeoutTicks: 25 }) || !settled()) {
            throw Error('no courier progress: collection cook debit unobserved; reconcile before retry');
        }
        return { result, received };
    }

    async function sendHandoff(s: Session, to: string, server: string, expected: Items, trade: () => Promise<unknown>, targetRoot = dir): Promise<number> {
        const p = file(s.name, to, targetRoot), prior = read(p);
        if (prior && prior.state !== 'settled') throw Error('no courier progress: unresolved handoff; reconcile before retry');
        const request: Request = { token: randomUUID(), from: s.name, to, server, at: Date.now(), state: 'prepared', expected: handoffCounts(expected) };
        if (!server || !request.expected.length || expected.some(i => !food.has(i.id) || i.count <= 0)) throw Error('no courier progress: handoff inputs unknown');
        const before = handoffCounts(s.sdk.getInventory());
        if (request.expected.some(i => (before.find(b => b.id === i.id)?.count ?? 0) < i.count)) throw Error('no courier progress: handoff stock missing');
        save(p, { ...request, before });
        try { await trade(); } catch { /* A lost reply can still have transferred the items. */ }
        const matched = () => handoffCreditMatches(request, read(`${p}.credit`), before, handoffCounts(s.sdk.getInventory()), Date.now());
        if (!await waitUntil(s, matched, { timeoutTicks: 25 }) || !matched()) {
            throw Error('no courier progress: handoff debit/credit unobserved; reconcile before retry');
        }
        const credit = read(`${p}.credit`);
        const after = handoffCounts(s.sdk.getInventory());
        save(p, { ...request, state: 'settled', before, after, credit });
        const amount = request.expected.reduce((n, i) => n + i.count, 0);
        console.log('HANDOFF_RECEIPT ' + JSON.stringify({ ...request, state: 'settled', before, after, credit, amount }));
        return amount;
    }

    return { handoffCounts, awaitCollectionOffer, handoffCreditMatches, receiveHandoff, collectHandoff, sendHandoff };
}

export const { handoffCounts, awaitCollectionOffer, handoffCreditMatches, receiveHandoff, collectHandoff, sendHandoff } = createHandoff([330, 334, 380], legacyRoot);
