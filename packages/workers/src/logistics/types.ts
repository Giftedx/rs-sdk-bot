// Core types, role catalog, and route resolution for the unified logistics worker.
import { resolve } from 'node:path';
import type { Step } from '../../../core/src/chain-step';
import { resolveRouteStep } from '../../../core/src/route-step';
import type { WorkerTile } from '../contracts';

export const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export const LOGISTICS_OPERATIONS = [
    'trade',
    'hub_bank',
    'stage',
    'walk',
    'recover',
    'inspect',
] as const;
export type LogisticsOperation = (typeof LOGISTICS_OPERATIONS)[number];

export type LogisticsRole =
    | 'coin-courier'
    | 'coin-fanout'
    | 'item-fanin'
    | 'note-courier'
    | 'food-courier'
    | 'food-chain'
    | 'specialist-supplier'
    | 'gathering-supplier'
    | 'fleet-trade'
    | 'banker'
    | 'give-to-banker'
    | 'take-from-banker'
    | 'supply-holder'
    | 'wine-stock'
    | 'supply-chain'
    | 'supply-bootstrap'
    | 'loadout'
    | 'loadout-import'
    | 'bank-sort'
    | 'walk-to'
    | 'walk-edge'
    | 'relocate-bank'
    | 'relocate-knight'
    | 'arrive-draynor'
    | 'restore-prayer'
    | 'cure-poison'
    | 'charge-glory'
    | 'recover-trapped'
    | 'inspect';

export interface LogisticsRoleSpec {
    readonly role: LogisticsRole;
    readonly operation: LogisticsOperation;
    readonly script: string;
    readonly defaultArgs?: readonly string[];
    readonly defaultEnv?: Readonly<Record<string, string>>;
    readonly description: string;
}

export interface LogisticsConfigBase {
    readonly role?: LogisticsRole;
    readonly account?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly capTicks?: number;
    readonly rootDir?: string;
    readonly reserve?: number;
    readonly bank?: WorkerTile;
    readonly itemId?: number;
    readonly itemName?: string;
    readonly count?: number;
}

export interface LogisticsTradeConfig extends LogisticsConfigBase {
    readonly operation: 'trade';
    readonly partner?: string;
    readonly partners?: readonly string[];
    readonly orderFile?: string;
    readonly coins?: number;
    readonly kit?: string;
}

export interface LogisticsHubBankConfig extends LogisticsConfigBase {
    readonly operation: 'hub_bank';
    readonly targetBatches?: number;
    readonly minGrams?: number;
    readonly bankTarget?: number;
    readonly reserveBatches?: number;
    readonly partner?: string;
    readonly items?: ReadonlyArray<{ readonly id?: number; readonly name: string; readonly count: number }>;
    readonly notes?: boolean;
}

export interface LogisticsStageConfig extends LogisticsConfigBase {
    readonly operation: 'stage';
    readonly setupFile?: string;
    readonly bindingsFile?: string;
    readonly policyFile?: string;
}

export interface LogisticsWalkConfig extends LogisticsConfigBase {
    readonly operation: 'walk';
    readonly target?: WorkerTile;
    readonly tolerance?: number;
    readonly bankName?: string;
    readonly destination?: string;
}

export interface LogisticsRecoverConfig extends LogisticsConfigBase {
    readonly operation: 'recover';
    readonly target?: WorkerTile;
    readonly altar?: { readonly x: number; readonly z: number; readonly name?: string };
    readonly minimumPrayer?: number;
    readonly charges?: number;
}

export interface LogisticsInspectConfig extends LogisticsConfigBase {
    readonly operation: 'inspect';
}

export type LogisticsConfig =
    | LogisticsTradeConfig
    | LogisticsHubBankConfig
    | LogisticsStageConfig
    | LogisticsWalkConfig
    | LogisticsRecoverConfig
    | LogisticsInspectConfig;

const AIO_LOGISTICS_SCRIPT = 'scripts/aio-logistics.ts';

export const LOGISTICS_ROLES: readonly LogisticsRoleSpec[] = [
    // Couriers, Mules & Suppliers
    { role: 'coin-courier', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Deliver coins between owned accounts with paired debit/credit receipts' },
    { role: 'coin-fanout', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Distribute coin floats from a treasury account to multiple worker accounts' },
    { role: 'item-fanin', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Consolidate produced items from worker accounts into a holder/consumer account' },
    { role: 'note-courier', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Deliver noted supplies between owned accounts at bank' },
    { role: 'food-courier', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Deliver cooked food to thieving/combat workers' },
    { role: 'food-chain', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Coordinate fish-cook-deliver food supply chain' },
    { role: 'specialist-supplier', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Stage and hand off a specialist supply kit with observed bank and trade receipts' },
    { role: 'gathering-supplier', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Hand a carried gathering kit to a fresh specialist in one Offer-All trade at the Lumbridge spawn' },
    { role: 'fleet-trade', operation: 'trade', script: AIO_LOGISTICS_SCRIPT, description: 'Execute cross-machine fleet order trade settlement' },
    // Hub Bankers & Supply Holders
    { role: 'banker', operation: 'hub_bank', script: AIO_LOGISTICS_SCRIPT, description: 'Standing banker/mule account that receives and holds fleet supplies' },
    { role: 'give-to-banker', operation: 'hub_bank', script: AIO_LOGISTICS_SCRIPT, description: 'Trade produced items to a standing banker account' },
    { role: 'take-from-banker', operation: 'hub_bank', script: AIO_LOGISTICS_SCRIPT, description: 'Receive staged items from a standing banker account' },
    { role: 'supply-holder', operation: 'hub_bank', script: AIO_LOGISTICS_SCRIPT, description: 'Hold and serve staged route supplies' },
    { role: 'wine-stock', operation: 'hub_bank', script: AIO_LOGISTICS_SCRIPT, defaultArgs: ['12', '1000', '0'], description: 'Preserve an exact new wine-note order from staged grapes and jugs of water' },
    // Staging, Loadouts & Bank Sort
    { role: 'supply-chain', operation: 'stage', script: AIO_LOGISTICS_SCRIPT, description: 'Run multi-actor supply-chain transfer' },
    { role: 'supply-bootstrap', operation: 'stage', script: AIO_LOGISTICS_SCRIPT, description: 'Practice-only zero-resource qualification: discard tutorial gifts before earning initial route supplies' },
    { role: 'loadout', operation: 'stage', script: AIO_LOGISTICS_SCRIPT, description: 'Equip wear kit and withdraw exact inventory setup from bank' },
    { role: 'loadout-import', operation: 'stage', script: AIO_LOGISTICS_SCRIPT, description: 'Import and validate inventory/equipment setup' },
    { role: 'bank-sort', operation: 'stage', script: AIO_LOGISTICS_SCRIPT, description: 'Sort and audit bank tabs/slots' },
    // Travel & Relocation
    { role: 'walk-to', operation: 'walk', script: AIO_LOGISTICS_SCRIPT, description: 'Walk account to any world coordinate (x, z, level) using doors/transports' },
    { role: 'walk-edge', operation: 'walk', script: AIO_LOGISTICS_SCRIPT, description: 'Walk to Edgeville bank through measured waypoints with a longer route planning budget' },
    { role: 'relocate-bank', operation: 'walk', script: AIO_LOGISTICS_SCRIPT, description: 'Relocate account to target bank safely' },
    { role: 'relocate-knight', operation: 'walk', script: AIO_LOGISTICS_SCRIPT, description: 'Relocate thieving account to Ardougne knight spot' },
    { role: 'arrive-draynor', operation: 'walk', script: AIO_LOGISTICS_SCRIPT, description: 'Walk fresh account safely from Lumbridge to Draynor bank' },
    // Recovery & Maintenance
    { role: 'restore-prayer', operation: 'recover', script: AIO_LOGISTICS_SCRIPT, description: 'Restore drained Prayer points at a nearby altar or an explicit ALTAR=x,z' },
    { role: 'cure-poison', operation: 'recover', script: AIO_LOGISTICS_SCRIPT, description: 'Drink one antipoison from the pack or the nearest bank' },
    { role: 'charge-glory', operation: 'recover', script: AIO_LOGISTICS_SCRIPT, description: 'Recharge uncharged or partial amulets of glory at the Fountain of Heroes from Falador West Bank' },
    { role: 'recover-trapped', operation: 'recover', script: AIO_LOGISTICS_SCRIPT, description: 'Extract stranded offline account to a ground mainland hub bank' },
    // Bank & Inventory Inspection
    { role: 'inspect', operation: 'inspect', script: AIO_LOGISTICS_SCRIPT, description: 'Observe bank, pack, gear, skills, and location for fleet state inspection' },
];

export const LOGISTICS_ROLE_MAP: ReadonlyMap<string, LogisticsRoleSpec> = new Map(
    LOGISTICS_ROLES.map(spec => [spec.role, spec]),
);

const LOGISTICS_ROLE_ALIASES: Readonly<Record<string, LogisticsRole>> = {
    'pray-at-altar': 'restore-prayer',
    foodcourier: 'food-courier',
    foodchain: 'food-chain',
    'make-wine-order': 'wine-stock',
    'fleet-inspect': 'inspect',
    'microbot-owned-loadout': 'loadout',
    'microbot-loadout-import': 'loadout-import',
    'microbot-bank-sort': 'bank-sort',
    'pk-live/walk-edge': 'walk-edge',
};

export function normalizeLogisticsRole(roleInput: string): string {
    const normalized = roleInput.trim().toLowerCase().replace(/^--role=/, '').replace(/\.ts$/, '');
    return LOGISTICS_ROLE_ALIASES[normalized] ?? normalized;
}

export function findLogisticsRole(roleInput: string): LogisticsRoleSpec | undefined {
    return LOGISTICS_ROLE_MAP.get(normalizeLogisticsRole(roleInput));
}

// Pair donor accounts (holding > reserve of itemId) with receiver accounts (needing targetCount of itemId) in minimum trades.
export function planFleetDistribution(
    donors: readonly { account: string; held: number; reserve?: number }[],
    receivers: readonly { account: string; held: number; target: number }[],
): { transfers: { from: string; to: string; amount: number }[]; unmet: { account: string; shortfall: number }[] } {
    const pool = donors
        .map(d => ({ account: d.account, surplus: Math.max(0, d.held - Math.max(0, d.reserve ?? 0)) }))
        .filter(d => d.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus);
    const needs = receivers
        .map(r => ({ account: r.account, deficit: Math.max(0, r.target - r.held) }))
        .filter(r => r.deficit > 0)
        .sort((a, b) => b.deficit - a.deficit);
    const transfers: { from: string; to: string; amount: number }[] = [];
    const unmet: { account: string; shortfall: number }[] = [];
    for (const r of needs) {
        let rem = r.deficit;
        for (const d of pool) {
            if (rem <= 0) break;
            if (d.surplus <= 0 || d.account.toLowerCase() === r.account.toLowerCase()) continue;
            const move = Math.min(rem, d.surplus);
            transfers.push({ from: d.account, to: r.account, amount: move });
            d.surplus -= move;
            rem -= move;
        }
        if (rem > 0) unmet.push({ account: r.account, shortfall: rem });
    }
    return { transfers, unmet };
}

export function resolveLogisticsStep(roleInput: string, rest: readonly string[] = []): Step {
    const role = normalizeLogisticsRole(roleInput);
    const spec = LOGISTICS_ROLE_MAP.get(role);
    if (!spec) {
        throw Error(`aio-logistics: unknown role "${role}"; known: ${LOGISTICS_ROLES.map(r => r.role).join(', ')}`);
    }
    const step = resolveRouteStep(spec, rest);
    if (role === 'loadout-import' && step.args.length !== 2) {
        throw Error('aio-logistics loadout-import requires <donor-setup.json> <native-bindings.json>');
    }
    return {
        script: spec.script,
        args: [role, ...step.args],
        env: { ...(spec.defaultEnv ?? {}), ...step.env },
    };
}
