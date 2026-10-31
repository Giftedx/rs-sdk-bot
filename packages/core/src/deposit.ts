import type { Session } from './inprocess';
import { waitUntil } from './ticks';

// The caller owns the session and keeps other inventory actions out of this window.
// Bank names join noted/unnoted forms; pack debits use the exact dispatched ID.
export async function depositObserved(s: Session, item: { id: number; name: string }): Promise<number> {
    const held = () => {
        const inventory = s.sdk.getState()?.inventory;
        return Array.isArray(inventory) ? inventory.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0) : NaN;
    };
    const stored = (items: { name: string; count: number }[]) => items.filter(i => i.name.toLowerCase() === item.name.toLowerCase()).reduce((n, i) => n + i.count, 0);
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
    let samples = 0, dispatchResult: unknown;
    const trace = (phase: string) => {
        if (item.id !== 995) return;
        if (phase === 'tick' && samples++ >= 40) return;
        const client = s.client as { ifType?(id: number): { linkObjType?: ArrayLike<number>; linkObjNumber?: ArrayLike<number> } | undefined };
        const containers = [3214, 2006, 5382].map(id => {
            const c = client?.ifType?.(id);
            return { componentId: id, items: c?.linkObjType && c.linkObjNumber ? Array.from(c.linkObjType, (raw, slot) =>
                ({ slot, id: raw - 1, count: c.linkObjNumber![slot] })).filter(i => i.id >= 0) : null };
        });
        console.log('DEPOSIT_OBSERVATION ' + JSON.stringify({ account: s.name, phase, tick: s.tick(),
            target: { id: target.id, name: target.name, slot: target.slot }, amount, bankBefore, generationBefore: generation,
            dispatchResult, pack: s.sdk.getState()?.inventory, sdkBank: s.sdk.getState()?.bank, bank: s.bankObservation?.(), containers }));
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
    return amount;
    } finally { off(); trace('exit'); }
}

// Banks the whole pack except what `keep` names, one deposit per item id, with the bank already open. A pack left
// full by an earlier job (quest leftovers, a farmer's feathers) otherwise blocks a production or shop job that
// needs free slots. Returns the number of item ids deposited.
export async function depositPack(s: Session, keep: (item: { id: number; name: string }) => boolean = () => false): Promise<number> {
    let n = 0;
    for (const id of new Set(s.sdk.getInventory().filter(i => !keep(i)).map(i => i.id))) {
        const item = s.sdk.getInventory().find(i => i.id === id);
        if (!item) continue;
        await s.bot.depositItem(item, -1);
        await waitUntil(s, () => !s.sdk.getInventory().some(i => i.id === id), { timeoutTicks: 5 });
        n++;
    }
    return n;
}
