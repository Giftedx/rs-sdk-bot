// The pack kit of a stage walk (brain RecoverPlannedStep recoveryKind 'stage'): the items that a route which runs only
// in place needs in the pack at its start. The walk-to step withdraws them at the nearest bank before it walks.
import type { Session } from '../../../core/src/inprocess';

export type StageKitItem = { readonly itemId: number; readonly count: number };

// "333:2,954:10" -> [{ itemId: 333, count: 2 }, { itemId: 954, count: 10 }]. Throws on a malformed entry.
export function parseStageKit(text: string | undefined): StageKitItem[] {
    if (!text?.trim()) return [];
    return text.split(',').map(part => {
        const m = /^\s*(\d+):(\d+)\s*$/.exec(part);
        const itemId = Number(m?.[1]), count = Number(m?.[2]);
        if (!m || !Number.isSafeInteger(itemId) || !Number.isSafeInteger(count) || count < 1) throw Error(`invalid STAGE_KIT entry: ${part}`);
        return { itemId, count };
    });
}

// The count of each kit item that the pack lacks.
export function stageKitShortfall(kit: readonly StageKitItem[], pack: readonly { id: number; count: number }[]): StageKitItem[] {
    return kit
        .map(k => ({ itemId: k.itemId, count: k.count - pack.filter(i => i.id === k.itemId).reduce((n, i) => n + i.count, 0) }))
        .filter(k => k.count > 0);
}

// Withdraws the kit shortfall at the nearest bank. Throws with the missing item when the bank lacks it.
export async function withdrawStageKit(s: Session, kit: readonly StageKitItem[]): Promise<void> {
    const { waitUntil } = await import('../../../core/src/ticks');
    if (!kit.length) return;
    await waitUntil(s, () => !!s.sdk.getState()?.player, { timeoutTicks: 20 });
    if (!stageKitShortfall(kit, s.sdk.getInventory()).length) return;
    const { accountOf, getWorld } = await import('../../../core/src/bot');
    const { knownBanks } = await import('../../../core/src/trip');
    const { goTo } = await import('../../../core/src/walk');
    const pos = s.sdk.getState()?.player;
    if (!pos) throw Error('stage kit: player state unavailable');
    const cheb = (b: { x: number; z: number }) => Math.max(Math.abs(b.x - pos.worldX), Math.abs(b.z - pos.worldZ));
    const bank = [...knownBanks()].filter(b => b.level === pos.level).sort((a, b) => cheb(a) - cheb(b))[0];
    if (!bank) throw Error('stage kit: no bank on this level');
    if (cheb(bank) > 4) {
        const walked = await goTo(s, await getWorld(), bank, accountOf(s), { legTimeoutTicks: 120 });
        if (!walked.ok) throw Error(`stage kit: bank walk failed: ${walked.reason}`);
    }
    const gen = s.bankObservation?.()?.generation ?? 0;
    if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.sdk.getState()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > gen, { timeoutTicks: 15 })) {
        throw Error('stage kit: bank did not open');
    }
    try {
        for (const need of stageKitShortfall(kit, s.sdk.getInventory())) {
            const row = s.sdk.getState()?.bank?.items.find(i => i.id === need.itemId);
            if (!row || row.count < need.count) throw Error(`stage kit: bank missing itemId=${need.itemId} need=${need.count} have=${row?.count ?? 0}`);
            const before = s.sdk.getInventory().filter(i => i.id === need.itemId).reduce((n, i) => n + i.count, 0);
            const w = await s.bot.withdrawItem(row, need.count, { asNote: false });
            if (!w.success || !await waitUntil(s, () => s.sdk.getInventory().filter(i => i.id === need.itemId).reduce((n, i) => n + i.count, 0) >= before + need.count, { timeoutTicks: 10 })) {
                throw Error(`stage kit: withdraw failed itemId=${need.itemId} need=${need.count}`);
            }
        }
    } finally {
        await s.bot.closeBank().catch(() => {});
    }
    const left = stageKitShortfall(kit, s.sdk.getInventory());
    if (left.length) throw Error(`stage kit: pack still short ${left.map(k => `${k.itemId}:${k.count}`).join(',')}`);
}
