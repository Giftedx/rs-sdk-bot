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

// "995,333,1205:1" -> Map{995: Infinity, 333: Infinity, 1205: 1}: the pack items that a stage deposit keeps
// (STAGE_KEEP), every copy or the named count.
export function parseStageKeep(text: string | undefined): Map<number, number> {
    const keep = new Map<number, number>();
    if (!text?.trim()) return keep;
    for (const part of text.split(',')) {
        const m = /^\s*(\d+)(?::(\d+))?\s*$/.exec(part);
        const id = Number(m?.[1]), n = m?.[2] === undefined ? Infinity : Number(m[2]);
        if (!m || !Number.isSafeInteger(id) || !(n === Infinity || (Number.isSafeInteger(n) && n >= 1))) throw Error(`invalid STAGE_KEEP entry: ${part}`);
        keep.set(id, n);
    }
    return keep;
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
export async function withdrawStageKit(s: Session, kit: readonly StageKitItem[], keep: ReadonlyMap<number, number> = new Map()): Promise<void> {
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
            await depositPack(s, item => keep.get(item.id) === Infinity || kit.some(k => k.itemId === item.id));
            // An item kept in part (a reserved count) went to the bank whole; the reserved count comes back.
            for (const [id, n] of keep) {
                if (n === Infinity || kit.some(k => k.itemId === id)) continue;
                const row = s.sdk.getState()?.bank?.items.find(i => i.id === id);
                if (!row) continue;
                const back = Math.min(n, row.count);
                const before = s.sdk.getInventory().filter(i => i.id === id).reduce((c, i) => c + i.count, 0);
                const w = await s.bot.withdrawItem(row, back, { asNote: false });
                if (!w.success || !await waitUntil(s, () => s.sdk.getInventory().filter(i => i.id === id).reduce((c, i) => c + i.count, 0) >= before + back, { timeoutTicks: 10 })) {
                    throw Error(`stage kit: kept itemId=${id} count=${back} did not return to the pack`);
                }
            }
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

export const PVP_COMBAT_STAGE_KIT: readonly StageKitItem[] = [
    { itemId: 1333, count: 1 }, // Rune scimitar
    { itemId: 1231, count: 1 }, // Dragon dagger(p)
    { itemId: 861, count: 1 },  // Magic shortbow
    { itemId: 2503, count: 1 }, // Black d'hide body
    { itemId: 2497, count: 1 }, // Black d'hide chaps
    { itemId: 2491, count: 1 }, // Black d'hide vambraces
    { itemId: 1712, count: 1 }, // Amulet of glory(4)
    { itemId: 2550, count: 1 }, // Ring of recoil
    { itemId: 2434, count: 2 }, // Prayer potion(4)
    { itemId: 2436, count: 1 }, // Super attack(4)
    { itemId: 2440, count: 1 }, // Super strength(4)
    { itemId: 2442, count: 1 }, // Super defence(4)
    { itemId: 2448, count: 1 }, // Superantipoison(4)
    { itemId: 892, count: 100 }, // Rune arrows (stackable: 1 slot)
    { itemId: 385, count: 9 },   // Sharks (9 slots -> total 28 pack slots)
    { itemId: 3144, count: 4 },  // Cooked karambwans (4 slots)
];

export interface PvpStageReadiness {
    readonly ready: boolean;
    readonly missingItems: readonly StageKitItem[];
    readonly needsPrayerRestore: boolean;
    readonly prayerCurrent: number;
    readonly prayerBase: number;
}

export function pvpStageReadiness(
    ownedCounts: Readonly<Record<number, number>>,
    prayerCurrent: number,
    prayerBase: number,
    kit: readonly StageKitItem[] = PVP_COMBAT_STAGE_KIT,
): PvpStageReadiness {
    const missingItems: StageKitItem[] = [];
    for (const item of kit) {
        const have = ownedCounts[item.itemId] ?? 0;
        if (have < item.count) missingItems.push({ itemId: item.itemId, count: item.count - have });
    }
    const needsPrayerRestore = prayerBase > 1 && prayerCurrent < prayerBase;
    return {
        ready: missingItems.length === 0 && !needsPrayerRestore,
        missingItems,
        needsPrayerRestore,
        prayerCurrent,
        prayerBase,
    };
}

// Withdraws a staged PvP kit from the nearest bank and restores drained prayer at the nearest safe altar.
export async function stagePvpKitAndRestorePrayer(
    s: Session,
    kit: readonly StageKitItem[] = PVP_COMBAT_STAGE_KIT,
    keep: ReadonlyMap<number, number> = new Map(),
): Promise<{ ok: boolean; prayerRestored: boolean; detail: string }> {
    await withdrawStageKit(s, kit, keep);
    const prayer = s.sdk.getSkill('Prayer');
    const current = prayer?.level ?? 0;
    const base = prayer?.baseLevel ?? 1;
    if (base > 1 && current < base) {
        const { nearestAltar, prayAtAltar } = await import('./recover');
        const pos = s.sdk.getState()?.player;
        const altar = nearestAltar({ x: pos?.worldX ?? 3094, z: pos?.worldZ ?? 3491, level: pos?.level ?? 0 });
        const prayed = await prayAtAltar(s, altar);
        if (!prayed.ok) return { ok: false, prayerRestored: false, detail: `stage prayer restore failed: ${prayed.detail}` };
        return { ok: true, prayerRestored: true, detail: `staged kit and ${prayed.detail}` };
    }
    return { ok: true, prayerRestored: false, detail: `staged kit (prayer full ${current}/${base})` };
}
