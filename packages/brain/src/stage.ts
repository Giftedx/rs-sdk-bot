// The stage step of a route that runs only in place (catalog config startArea, startTile and pack-only requiredItems):
// the imp hunt starts at the Ardougne south bank with trout in the pack, the Fishing Trawler at the Port Khazard dock
// with its kit in the pack. Without the step the preflight refuses the route anywhere else, so it never runs.
// The step withdraws the pack kit at the nearest bank and walks to startTile (worker-routing.ts recover 'stage',
// workers/src/logistics/stage-kit.ts). The planner evaluates the route's preflight for the account as the step
// leaves it: at startTile, with the kit moved from the bank to the pack.
import type { AccountState, RecoverPlannedStep } from './contracts';
import { inStartArea, parseStartArea } from './preflight';
import { isItemStackable } from '../../workers/src/bank-artisan/catalog';

export const PACK_SLOTS = 28;

// The pack slots that a count of an item takes: one for a stack, one each otherwise.
const slotsFor = (itemId: number, count: number) => (count <= 0 ? 0 : isItemStackable(itemId) ? 1 : count);

export type StageResult = { readonly step: RecoverPlannedStep; readonly staged: AccountState };

const tileOf = (raw: unknown): { x: number; z: number; level: number } | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const t = raw as Record<string, unknown>;
    return [t.x, t.z, t.level].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
        ? { x: t.x as number, z: t.z as number, level: t.level as number }
        : undefined;
};

// The pack-only items of the route: requiredItems with includeBank false.
export function packKit(config: Readonly<Record<string, unknown>> | undefined): { itemId: number; count: number }[] {
    const raw = Array.isArray(config?.requiredItems) ? (config!.requiredItems as unknown[]) : [];
    const out: { itemId: number; count: number }[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const { itemId, count, includeBank } = r as { itemId?: unknown; count?: unknown; includeBank?: unknown };
        if (includeBank === false && Number.isSafeInteger(itemId) && Number.isSafeInteger(count) && (count as number) >= 1) {
            out.push({ itemId: itemId as number, count: count as number });
        }
    }
    return out;
}

// The stage step for the account, or undefined when the route needs none (it names no startTile, or the account
// stands in its start area with the pack kit) or when the trusted bank or the free pack slots cannot hold the pack kit.
export function stageForStart(acct: AccountState, activity: { readonly id: string; readonly config?: Readonly<Record<string, unknown>> }): StageResult | undefined {
    const area = parseStartArea(activity.config?.startArea);
    const tile = tileOf(activity.config?.startTile);
    if (!area || !tile || !inStartArea(tile, area)) return undefined;
    const kit = packKit(activity.config);
    const short = kit
        .map((k) => ({ itemId: k.itemId, count: k.count - (acct.inventory[k.itemId] ?? 0) }))
        .filter((k) => k.count > 0);
    if (inStartArea(acct.pos, area) && short.length === 0) return undefined;
    if (short.length > 0 && !acct.bank.trusted) return undefined;
    if (short.some((k) => (acct.bank.items[k.itemId] ?? 0) < k.count)) return undefined;
    // The withdrawal needs free pack slots (stage-kit.ts withdraws and deposits nothing).
    const used = Object.entries(acct.inventory).reduce((n, [id, c]) => n + slotsFor(Number(id), c), 0);
    const added = short.reduce((n, k) => n + (isItemStackable(k.itemId) && (acct.inventory[k.itemId] ?? 0) > 0 ? 0 : slotsFor(k.itemId, k.count)), 0);
    if (used + added > PACK_SLOTS) return undefined;
    const inventory: Record<number, number> = { ...acct.inventory };
    const bankItems: Record<number, number> = { ...acct.bank.items };
    for (const k of short) {
        inventory[k.itemId] = (inventory[k.itemId] ?? 0) + k.count;
        bankItems[k.itemId] = (bankItems[k.itemId] ?? 0) - k.count;
    }
    const from = acct.pos;
    const distance = from && from.level === tile.level ? Math.max(Math.abs(from.x - tile.x), Math.abs(from.z - tile.z)) : 100;
    return {
        step: {
            stepKind: 'recover',
            recoveryKind: 'stage',
            targetTile: tile,
            ...(kit.length > 0 ? { kit } : {}),
            estimatedTicks: Math.max(20, distance + (short.length > 0 ? 20 : 0)),
            reason: `stage ${activity.id} at ${tile.x},${tile.z},${tile.level}`,
        },
        staged: { ...acct, pos: tile, inventory, bank: { ...acct.bank, items: bankItems } },
    };
}
