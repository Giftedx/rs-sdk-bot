// Stateful bank tool/staff swap execution with strict count conservation across toolGroupIds.
import type { ReconcileBankToolHooks } from './model';
import { checkStop, countIn, planBankToolSwap, tryCloseBank, tryOpenBank } from './bank-plan';

function groupTotals(hooks: ReconcileBankToolHooks, toolGroupIds: readonly number[]): Map<number, number> {
    const st = hooks.getBankState();
    if (!st?.isOpen) throw new Error('tool reconcile requires open bank');
    const out = new Map<number, number>();
    for (const id of toolGroupIds) {
        out.set(
            id,
            countIn(hooks.getInventory(), id) + countIn(hooks.getEquipment(), id) + countIn(st.items, id),
        );
    }
    return out;
}

async function depositOneId(hooks: ReconcileBankToolHooks, id: number): Promise<void> {
    const item = hooks.getInventory().find(i => i.id === id);
    if (!item) return;
    const inv0 = countIn(hooks.getInventory(), id);
    const gen0 = hooks.getBankGeneration?.();
    await hooks.depositItem(item, -1);
    const ok = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        const gen = hooks.getBankGeneration?.();
        return countIn(hooks.getInventory(), id) < inv0 && (gen0 === undefined || (gen ?? -1) > gen0);
    }, 10);
    checkStop(hooks, 'tool reconcile stopped during deposit');
    if (!ok || countIn(hooks.getInventory(), id) > 0) throw new Error(`tool deposit unconfirmed for ${id}`);
}

async function withdrawTargetTool(hooks: ReconcileBankToolHooks, targetId: number): Promise<void> {
    checkStop(hooks, 'tool reconcile stopped before withdraw');
    if (hooks.getInventory().length >= 28) throw new Error(`tool upgrade ${targetId} needs one free slot`);
    const bankSt = hooks.getBankState()!;
    const bankRow = bankSt.items.find(i => i.id === targetId && i.count > 0);
    if (!bankRow) throw new Error(`owned tool ${targetId} missing from open bank`);
    const held0 = countIn(hooks.getInventory(), targetId);
    const stored0 = countIn(bankSt.items, targetId);
    const gen0 = hooks.getBankGeneration?.();
    await hooks.withdrawItem(bankRow, 1);
    const matched = await hooks.waitUntil(() => {
        if (hooks.stop?.()) return true;
        const st = hooks.getBankState();
        const gen = hooks.getBankGeneration?.();
        return !!st?.isOpen
            && countIn(hooks.getInventory(), targetId) === held0 + 1
            && countIn(st.items, targetId) === stored0 - 1
            && (gen0 === undefined || (gen ?? -1) > gen0);
    }, 10);
    checkStop(hooks, 'tool reconcile stopped after withdraw');
    if (!matched) throw new Error(`tool withdrawal unconfirmed for ${targetId}`);
}

async function equipTargetTool(
    hooks: ReconcileBankToolHooks,
    targetId: number,
    refusedWields?: Set<number>,
): Promise<void> {
    if (!hooks.equipItem) return;
    checkStop(hooks, 'tool reconcile stopped before equip');
    const invItem = hooks.getInventory().find(i => i.id === targetId);
    if (!invItem) throw new Error(`tool ${targetId} missing from inventory before equip`);
    const gen0 = hooks.getBankGeneration?.();
    if (!(await tryCloseBank(hooks, 'tool reconcile stopped closing bank', 8))) {
        throw new Error('tool reconcile bank close unobserved');
    }
    try {
        await hooks.equipItem(invItem);
    } catch {
        // Observe actual worn slot rather than retrying an uncertain wield.
    }
    await hooks.waitUntil(() => !!hooks.stop?.() || hooks.getEquipment().some(e => e.slot === 3 && e.id === targetId), 3);
    if (!hooks.getEquipment().some(e => e.slot === 3 && e.id === targetId)) {
        refusedWields?.add(targetId);
    }
    checkStop(hooks, 'tool reconcile stopped after equip');
    if (!(await tryOpenBank(hooks, 'tool reconcile stopped reopening bank', 12, gen0))) {
        throw new Error('tool reconcile bank reopen unobserved');
    }
}

/**
 * Reconcile a chosen tool/staff against an already-open (or openable) bank:
 * deposits redundant tools first when space is tight, withdraws `targetId` if needed,
 * wields when eligible and allowed, and preserves exact item counts across `toolGroupIds`.
 */
export async function reconcileBankTool(
    hooks: ReconcileBankToolHooks,
    params: {
        targetId: number;
        canWield: boolean;
        allowReplaceWeapon?: boolean;
        toolGroupIds: readonly number[];
        refusedWields?: Set<number>;
    },
): Promise<{ activeId: number; worn: boolean; changed: boolean }> {
    checkStop(hooks, 'tool reconcile stopped');
    if (!hooks.getBankState()?.isOpen) {
        if (!(await tryOpenBank(hooks, 'tool reconcile stopped opening bank', 10))) {
            throw new Error('tool reconcile bank open unobserved');
        }
    }

    const before = groupTotals(hooks, params.toolGroupIds);
    let plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: params.canWield,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: hooks.getBankState()!.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });

    if (plan.alreadyActive) {
        const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
        return { activeId: params.targetId, worn, changed: false };
    }

    // Free space first if withdrawing into a full pack and carrying inferior tools.
    if (plan.withdrawFromBank && hooks.getInventory().length >= 28) {
        for (const depId of plan.depositInventoryIds) {
            checkStop(hooks, 'tool reconcile stopped freeing slot');
            await depositOneId(hooks, depId);
            if (hooks.getInventory().length < 28) break;
        }
    }

    if (plan.withdrawFromBank) {
        await withdrawTargetTool(hooks, params.targetId);
    }

    if (plan.equipInWeaponSlot && hooks.equipItem) {
        await equipTargetTool(hooks, params.targetId, params.refusedWields);
    }

    // Recompute deposits after equip (wielded tool may have swapped old weapon into inventory).
    // Keep target tool in inventory if wield did not take place.
    const wornAfterEquip = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    plan = planBankToolSwap({
        targetId: params.targetId,
        canWield: wornAfterEquip,
        allowReplaceWeapon: params.allowReplaceWeapon,
        inventory: hooks.getInventory(),
        equipment: hooks.getEquipment(),
        bank: hooks.getBankState()!.items,
        toolGroupIds: params.toolGroupIds,
        refusedWields: params.refusedWields,
    });
    for (const depId of plan.depositInventoryIds) {
        checkStop(hooks, 'tool reconcile stopped before inferior deposit');
        await depositOneId(hooks, depId);
    }

    const after = groupTotals(hooks, params.toolGroupIds);
    for (const id of params.toolGroupIds) {
        if ((before.get(id) ?? 0) !== (after.get(id) ?? 0)) {
            throw new Error(`tool reconcile asset mismatch for ${id}`);
        }
    }
    const worn = hooks.getEquipment().some(e => e.slot === 3 && e.id === params.targetId);
    const held = hooks.getInventory().some(i => i.id === params.targetId);
    if (!worn && !held) throw new Error(`target tool ${params.targetId} not active after reconcile`);
    return { activeId: params.targetId, worn, changed: true };
}
