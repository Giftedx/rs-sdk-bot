// The pack kit of a stage walk (brain RecoverPlannedStep recoveryKind 'stage'): the items that a route which runs only
// in place needs in the pack at its start. The walk-to step withdraws them at the nearest bank before it walks.
import type { Session } from '../../../core/src/inprocess';

export type StageKitItem = { readonly itemId: number; readonly count: number };
export const PACK_SLOTS = 28;

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

// "995,333" -> Set{995, 333}: the pack items that a stage deposit keeps (STAGE_KEEP).
export function parseStageKeep(text: string | undefined): Set<number> {
    if (!text?.trim()) return new Set();
    return new Set(text.split(',').map(part => {
        const id = Number(part.trim());
        if (!/^\s*\d+\s*$/.test(part) || !Number.isSafeInteger(id)) throw Error(`invalid STAGE_KEEP entry: ${part}`);
        return id;
    }));
}

// The pack slots that the kit shortfall takes: none for a stack the pack holds, one for a new stack, one each for an
// unstackable item.
export function stageKitSlots(short: readonly StageKitItem[], pack: readonly { id: number }[], stackable: (id: number) => boolean): number {
    return short.reduce((n, k) => n + (stackable(k.itemId) ? (pack.some(i => i.id === k.itemId) ? 0 : 1) : k.count), 0);
}

// The count of each kit item that the pack lacks.
export function stageKitShortfall(kit: readonly StageKitItem[], pack: readonly { id: number; count: number }[]): StageKitItem[] {
    return kit
        .map(k => ({ itemId: k.itemId, count: k.count - pack.filter(i => i.id === k.itemId).reduce((n, i) => n + i.count, 0) }))
        .filter(k => k.count > 0);
}

// Withdraws the kit shortfall at the nearest bank. A pack without room for it deposits every item outside `keep`
// first (the brain plans the same deposit, brain/src/stage.ts). Throws with the missing item when the bank lacks it.
export async function withdrawStageKit(s: Session, kit: readonly StageKitItem[], keep: ReadonlySet<number> = new Set()): Promise<void> {
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
        const { isItemStackable } = await import('../bank-artisan/catalog');
        const need0 = stageKitShortfall(kit, s.sdk.getInventory());
        if (s.sdk.getInventory().length + stageKitSlots(need0, s.sdk.getInventory(), isItemStackable) > PACK_SLOTS) {
            const { depositPack } = await import('../../../core/src/deposit');
            await depositPack(s, item => keep.has(item.id) || kit.some(k => k.itemId === item.id));
            if (s.sdk.getInventory().length + stageKitSlots(stageKitShortfall(kit, s.sdk.getInventory()), s.sdk.getInventory(), isItemStackable) > PACK_SLOTS) {
                throw Error('stage kit: the kept pack items leave no room for the kit');
            }
        }
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
