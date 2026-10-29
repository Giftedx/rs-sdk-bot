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
    let sdkSuccess = false;
    try { sdkSuccess = (await s.bot.depositItem(target, -1)).success; } catch { /* Observe a possibly completed action before deciding. */ }
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
}
