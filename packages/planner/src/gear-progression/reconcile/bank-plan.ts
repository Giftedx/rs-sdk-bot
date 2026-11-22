// Pure bank tool swap planning plus shared stop, item counting, and bank open/close primitives.
import type { GearCount } from '../../owned-loadout';
import type { BankToolSwapPlan, ReconcileBankToolHooks } from './model';

/** Sum item counts matching `id` across inventory, bank, or equipment rows. */
export function countIn(rows: readonly { id: number; count?: number }[], id: number): number {
    return rows.filter(r => r.id === id).reduce((n, r) => n + (r.count ?? 1), 0);
}

/** Throw `why` if the hook stop signal is asserted. */
export function checkStop(hooks: Pick<ReconcileBankToolHooks, 'stop'>, why: string): void {
    if (hooks.stop?.()) throw new Error(why);
}

/** Open the bank and wait for open state (optionally advancing past `minGen`). */
export async function tryOpenBank(
    hooks: ReconcileBankToolHooks,
    stopWhy: string,
    timeoutTicks: number,
    minGen?: number,
): Promise<boolean> {
    await hooks.openBank();
    const opened = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        const st = hooks.getBankState();
        const gen = hooks.getBankGeneration?.();
        return !!st?.isOpen && (minGen === undefined || (gen ?? -1) > minGen);
    }, timeoutTicks);
    checkStop(hooks, stopWhy);
    return opened && !!hooks.getBankState()?.isOpen;
}

/** Close the bank and wait for the closed state. */
export async function tryCloseBank(
    hooks: ReconcileBankToolHooks,
    stopWhy: string,
    timeoutTicks: number,
): Promise<boolean> {
    await hooks.closeBank();
    const closed = await hooks.waitUntil(() => !!hooks.stop?.() || !hooks.getBankState()?.isOpen, timeoutTicks);
    checkStop(hooks, stopWhy);
    return closed && !hooks.getBankState()?.isOpen;
}

/** Pure plan for activating `targetId` at an open bank without losing any item in `toolGroupIds`. */
export function planBankToolSwap(params: {
    targetId: number;
    canWield: boolean;
    allowReplaceWeapon?: boolean;
    inventory: readonly GearCount[];
    equipment: readonly { id: number; slot: number }[];
    bank: readonly GearCount[];
    toolGroupIds: readonly number[];
    refusedWields?: ReadonlySet<number>;
}): BankToolSwapPlan {
    const group = new Set(params.toolGroupIds);
    const weapon = params.equipment.find(i => i.slot === 3);
    const wearingTarget = weapon?.id === params.targetId;
    const heldTarget = countIn(params.inventory, params.targetId) > 0;
    const withdrawFromBank = !wearingTarget && !heldTarget && countIn(params.bank, params.targetId) > 0;
    const canOccupyWeaponSlot = !weapon || group.has(weapon.id) || params.allowReplaceWeapon === true;
    const equipInWeaponSlot = params.canWield
        && !wearingTarget
        && canOccupyWeaponSlot
        && !params.refusedWields?.has(params.targetId)
        && (heldTarget || withdrawFromBank);

    const willWearTarget = wearingTarget || equipInWeaponSlot;
    const depositSet = new Set<number>();
    for (const row of params.inventory) {
        if (!group.has(row.id) || row.count <= 0) continue;
        if (!willWearTarget && row.id === params.targetId) continue;
        depositSet.add(row.id);
    }

    const alreadyActive = !withdrawFromBank
        && !equipInWeaponSlot
        && depositSet.size === 0
        && (wearingTarget || heldTarget);

    return {
        targetId: params.targetId,
        withdrawFromBank,
        equipInWeaponSlot,
        depositInventoryIds: [...depositSet],
        alreadyActive,
    };
}
