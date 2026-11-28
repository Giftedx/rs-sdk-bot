import type { Session } from './inprocess';
import { BANK_BATCH_MAX } from './bank-trip';
import { waitUntil } from './ticks';

function countInventoryId(inventory: readonly { id: number; count: number }[] | undefined, id: number): number {
    if (!Array.isArray(inventory)) return NaN;
    let total = 0;
    for (let i = 0; i < inventory.length; i++) {
        const item = inventory[i]!;
        if (item.id === id) total += item.count;
    }
    return total;
}

function countBankByName(items: readonly { name: string; count: number }[], nameLower: string): number {
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        if (item.name.toLowerCase() === nameLower) total += item.count;
    }
    return total;
}

// The caller owns the session and keeps other inventory actions out of this window.
// Bank names join noted/unnoted forms; pack debits use the exact dispatched ID.
export async function depositObserved(s: Session, item: { id: number; name: string }): Promise<number> {
    const nameLower = item.name.toLowerCase();
    const held = () => countInventoryId(s.sdk.getState()?.inventory, item.id);
    const stored = (items: { name: string; count: number }[]) => countBankByName(items, nameLower);
    if (!await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 10 }))
        throw Error(`no deposit progress: bank observation unavailable ${item.id}`);
    const before = s.bankObservation?.(), amount = held();
    const target = s.sdk.getState()?.inventory.find(i => i.id === item.id && i.name === item.name);
    if (!before || !target || !Number.isSafeInteger(amount) || amount <= 0)
        throw Error(`no deposit progress: inputs unknown ${item.id}`);
    const bankBefore = stored(before.items);
    if (!Number.isSafeInteger(bankBefore) || bankBefore < 0)
        throw Error(`no deposit progress: bank count invalid ${item.id}`);
    // Copy scalars before dispatch: cached observations may change in place.
    const generation = before.generation;
    // Coin diagnostics compare the dispatched slot with both transmitted pack views.
    // These observations never substitute for the paired debit/credit predicate.
    // The observations print when the deposit fails, or at once with DEPOSIT_TRACE=1. An accepted deposit prints its
    // receipt only: the observations of each coin deposit were 4,298 log lines of full containers.
    let samples = 0, dispatchResult: unknown, accepted = false;
    const lines: string[] = [], live = process.env.DEPOSIT_TRACE === '1';
    const trace = (phase: string) => {
        if (item.id !== 995) return;
        if (phase === 'tick' && samples++ >= 40) return;
        const client = s.client as { ifType?(id: number): { linkObjType?: ArrayLike<number>; linkObjNumber?: ArrayLike<number> } | undefined };
        const containers = [3214, 2006, 5382].map(id => {
            const c = client?.ifType?.(id);
            return { componentId: id, items: c?.linkObjType && c.linkObjNumber ? Array.from(c.linkObjType, (raw, slot) =>
                ({ slot, id: raw - 1, count: c.linkObjNumber![slot] })).filter(i => i.id >= 0) : null };
        });
        const line = 'DEPOSIT_OBSERVATION ' + JSON.stringify({ account: s.name, phase, tick: s.tick(),
            target: { id: target.id, name: target.name, slot: target.slot }, amount, bankBefore, generationBefore: generation,
            dispatchResult, pack: s.sdk.getState()?.inventory, sdkBank: s.sdk.getState()?.bank, bank: s.bankObservation?.(), containers });
        if (live) console.log(line); else lines.push(line);
    };
    trace('dispatch');
    const off = item.id === 995 ? s.onTick(() => trace('tick')) : () => {};
    let sdkSuccess = false;
    try {
    try { const result = await s.bot.depositItem(target, -1); dispatchResult = result; sdkSuccess = result.success; }
    catch (error) { dispatchResult = { error: String(error) }; /* Observe a possibly completed action before deciding. */ }
    trace('reply');
    const matched = () => {
        const after = s.bankObservation?.();
        return !!after && after.generation > generation && held() === 0 && stored(after.items) === bankBefore + amount;
    };
    if (!await waitUntil(s, matched, { timeoutTicks: 10 }) || !matched())
        throw Error(`no deposit progress: pack debit/bank credit unobserved ${item.id}`);
    const after = s.bankObservation!()!;
    console.log('DEPOSIT_RECEIPT ' + JSON.stringify({ account: s.name, itemId: item.id, name: item.name,
        amount, packBefore: amount, packAfter: 0, bankBefore, bankAfter: stored(after.items),
        generationBefore: generation, generationAfter: after.generation, at: after.at, tick: s.tick(), sdkSuccess }));
    accepted = true;
    return amount;
    } finally { off(); trace('exit'); if (!accepted) for (const line of lines) console.log(line); }
}

// Banks the whole pack except what `keep` names, one deposit per item id, with the bank already open. A pack left
// full by an earlier job (quest leftovers, a farmer's feathers) otherwise blocks a production or shop job that
// needs free slots. When `s.direct` is available and multiple distinct non-coin items are deposited, batches up to
// BANK_BATCH_MAX (5) deposit-all actions in one game tick (bank_deposit.rs2 inv_button4; inventory slots never shift)
// with paired pack-debit and bank-credit verification. Returns the number of item ids deposited.
export async function depositPack(s: Session, keep: (item: { id: number; name: string }) => boolean = () => false): Promise<number> {
    const inv = s.sdk.getInventory();
    const distinct: { id: number; name: string; slot: number }[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < inv.length; i++) {
        const item = inv[i]!;
        if (seen.has(item.id) || keep(item)) continue;
        seen.add(item.id);
        distinct.push(item);
    }
    if (distinct.length === 0) return 0;
    const direct = (s as { direct?: (a: { type: string; [k: string]: unknown }) => Promise<unknown> }).direct;
    // Keep coins on depositObserved for coin-container tracing; batch multi-item non-coin packs via direct.
    if (typeof direct !== 'function' || distinct.length < 2) {
        let n = 0;
        for (const entry of distinct) {
            const item = s.sdk.getInventory().find(i => i.id === entry.id);
            if (!item) continue;
            await depositObserved(s, item);
            n++;
        }
        return n;
    }
    let deposited = 0;
    const coins = distinct.find(i => i.id === 995);
    const others = distinct.filter(i => i.id !== 995);
    if (coins) {
        const item = s.sdk.getInventory().find(i => i.id === 995);
        if (item) { await depositObserved(s, item); deposited++; }
    }
    for (let offset = 0; offset < others.length; offset += BANK_BATCH_MAX) {
        if (!await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 10 }))
            throw Error(`no deposit progress: bank observation unavailable ${others[offset]!.id}`);
        const before = s.bankObservation?.();
        const curInv = s.sdk.getState()?.inventory;
        if (!before || !Array.isArray(curInv))
            throw Error(`no deposit progress: inputs unknown ${others[offset]!.id}`);
        // Group entries sharing a bank name (e.g. noted + unnoted of the same item) so each batch has unique bank names.
        const chunk: { id: number; name: string; nameLower: string; slot: number; amount: number; bankBefore: number }[] = [];
        const usedNames = new Set<string>();
        const deferred: typeof others = [];
        for (let k = offset; k < Math.min(offset + BANK_BATCH_MAX, others.length); k++) {
            const entry = others[k]!;
            const target = curInv.find(i => i.id === entry.id && i.name === entry.name);
            const amount = countInventoryId(curInv, entry.id);
            if (!target || !Number.isSafeInteger(amount) || amount <= 0) continue;
            const nameLower = target.name.toLowerCase();
            if (usedNames.has(nameLower)) { deferred.push(entry); continue; }
            usedNames.add(nameLower);
            const bankBefore = countBankByName(before.items, nameLower);
            if (!Number.isSafeInteger(bankBefore) || bankBefore < 0)
                throw Error(`no deposit progress: bank count invalid ${target.id}`);
            chunk.push({ id: target.id, name: target.name, nameLower, slot: target.slot, amount, bankBefore });
        }
        if (chunk.length === 1) {
            await depositObserved(s, chunk[0]!);
            deposited++;
        } else if (chunk.length > 1) {
            const generation = before.generation;
            // Send up to BANK_BATCH_MAX deposit-all packets in the same tick (server reads 5 USER_EVENT inputs/tick).
            await Promise.all(chunk.map(c =>
                direct({ type: 'bankDeposit', slot: c.slot, amount: -1, reason: 'SDK' }).catch(() => undefined),
            ));
            const allMatched = () => {
                const after = s.bankObservation?.();
                const nowInv = s.sdk.getState()?.inventory;
                if (!after || after.generation <= generation || !Array.isArray(nowInv)) return false;
                for (let j = 0; j < chunk.length; j++) {
                    const c = chunk[j]!;
                    if (countInventoryId(nowInv, c.id) !== 0 || countBankByName(after.items, c.nameLower) !== c.bankBefore + c.amount) return false;
                }
                return true;
            };
            if (!await waitUntil(s, allMatched, { timeoutTicks: 10 }) || !allMatched()) {
                // Verify each already-debited item against a newer bank generation and matching credit; never silently
                // accept an uncredited pack debit. Retry only items that are still in the pack.
                const after = s.bankObservation?.();
                const nowInv = s.sdk.getState()?.inventory;
                for (const c of chunk) {
                    const remaining = Array.isArray(nowInv) ? nowInv.find(i => i.id === c.id) : undefined;
                    if (remaining) {
                        await depositObserved(s, remaining);
                        deposited++;
                        continue;
                    }
                    if (!after || after.generation <= generation || countBankByName(after.items, c.nameLower) !== c.bankBefore + c.amount)
                        throw Error(`no deposit progress: pack debit/bank credit unobserved ${c.id}`);
                    console.log('DEPOSIT_RECEIPT ' + JSON.stringify({
                        account: s.name, itemId: c.id, name: c.name, amount: c.amount,
                        packBefore: c.amount, packAfter: 0, bankBefore: c.bankBefore, bankAfter: c.bankBefore + c.amount,
                        generationBefore: generation, generationAfter: after.generation, at: after.at, tick: s.tick(), sdkSuccess: true,
                    }));
                    deposited++;
                }
            } else {
                const after = s.bankObservation!()!;
                for (const c of chunk) {
                    console.log('DEPOSIT_RECEIPT ' + JSON.stringify({
                        account: s.name, itemId: c.id, name: c.name, amount: c.amount,
                        packBefore: c.amount, packAfter: 0, bankBefore: c.bankBefore, bankAfter: c.bankBefore + c.amount,
                        generationBefore: generation, generationAfter: after.generation, at: after.at, tick: s.tick(), sdkSuccess: true,
                    }));
                }
                deposited += chunk.length;
            }
        }
        for (const entry of deferred) {
            const item = s.sdk.getInventory().find(i => i.id === entry.id);
            if (!item) continue;
            await depositObserved(s, item);
            deposited++;
        }
    }
    return deposited;
}
