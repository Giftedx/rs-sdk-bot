export const PACK_SLOTS = 28;

// The pack slots that one unnoted withdrawal of `need` units takes: a stackable item
// takes one slot unless the pack holds it already, and other items take one slot each.
export function loadoutSlotsNeeded(itemId: number, need: number, pack: readonly { id: number }[], stackable: boolean): number {
    if (need < 1) return 0;
    if (stackable) return pack.some(i => i.id === itemId) ? 0 : 1;
    return need;
}

// A refusal text when the pack cannot take the withdrawal, or undefined when it can.
// Stackability comes from the client item type; when it is unknown the check does not refuse.
export function loadoutSpaceRefusal(itemId: number, need: number, pack: readonly { id: number }[], stackable: boolean | undefined): string | undefined {
    if (stackable === undefined) return undefined;
    const free = Math.max(0, PACK_SLOTS - pack.length);
    const slots = loadoutSlotsNeeded(itemId, need, pack, stackable);
    return slots > free ? `loadout pack space short itemId=${itemId} need=${need} slots=${slots} free=${free}` : undefined;
}

export function clientStackable(client: unknown, itemId: number): boolean | undefined {
    const objType = (client as { objType?: (id: number) => { stackable?: unknown } | undefined } | undefined)?.objType;
    if (typeof objType !== 'function') return undefined;
    try {
        const value = objType.call(client, itemId)?.stackable;
        return typeof value === 'boolean' ? value : undefined;
    } catch {
        return undefined;
    }
}
