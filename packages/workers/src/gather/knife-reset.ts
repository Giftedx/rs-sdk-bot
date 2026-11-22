// 3-tick knife reset shared by gathering loops.
// Cut logs sets %action_delay = clock + 2 when older than clock and queues a 2-tick weak action
// (cut_logs.rs2). OpLoc/OpNpc/OpHeld clear that pending cut before execution while keeping %action_delay.
export const KNIFE = 946;
export const NORMAL_LOGS = 1511;

export type KnifeAction =
    | { type: 'useItemOnItem'; sourceSlot: number; targetSlot: number }
    | { type: 'clickComponent'; componentId: number }
    | { type: 'closeModal' };

/** Compute updated `%action_delay` after queuing a knife cut in `tick`. */
export function knifeDelay(delay: number, tick: number): number {
    return delay < tick ? tick + 2 : delay;
}

/** Build the knife-on-logs + Make 1 action pair, or undefined when knife or normal logs are missing. */
export function knifeCut(
    inventory: readonly { id: number; slot: number }[],
    make1: number,
): KnifeAction[] | undefined {
    const knife = inventory.find(i => i.id === KNIFE)?.slot;
    const log = inventory.find(i => i.id === NORMAL_LOGS)?.slot;
    if (knife === undefined || log === undefined) return undefined;
    return [
        { type: 'useItemOnItem', sourceSlot: knife, targetSlot: log },
        { type: 'clickComponent', componentId: make1 },
    ];
}
