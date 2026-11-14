// AIO Logistics ("RC Runners, Loadouts & Fleet Mule Suite"): unified entry for multi-account couriers, essence runners, bank muling, loadouts, and relocation.
// Usage:
//   bun scripts/aio-logistics.ts <account> <role> [arg ...] [KEY=value ...]
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {resolveRouteStep} from './aio-route-step';
import {readFileSync} from 'node:fs';
import {compileInventorySetup} from './microbot-loadout-import';
import {sendHandoff,receiveHandoff} from './courier-handoff';
import {
 selectFoodSource,featherPurchaseAmount,foodDeficit,foodRestockAmount,
 deliveryRecipientAtBank,deliveryResume,ARDY_BANK,NORTH_BANK,SARIM,NORTH_TO_SOUTH,LUMBRIDGE_TO_DRAYNOR,DRAYNOR_BANK,
} from './courier-route';
import {runOwnedLoadout,validateOwnedKit,type OwnedKit} from './microbot-owned-loadout';

export {
 sendHandoff,receiveHandoff,
 selectFoodSource,featherPurchaseAmount,foodDeficit,foodRestockAmount,
 deliveryRecipientAtBank,deliveryResume,ARDY_BANK,NORTH_BANK,SARIM,NORTH_TO_SOUTH,LUMBRIDGE_TO_DRAYNOR,DRAYNOR_BANK,
 runOwnedLoadout,validateOwnedKit,type OwnedKit,
};

export interface LogisticsRoleSpec {
 role: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const LOGISTICS_ROLES: readonly LogisticsRoleSpec[] = [
 // Couriers & Mules
 {role:'coin-courier',script:'scripts/coin-courier.ts',description:'Deliver coins between owned accounts with paired debit/credit receipts'},
 {role:'coin-fanout',script:'scripts/coin-fanout.ts',description:'Distribute coin floats from a treasury account to multiple worker accounts'},
 {role:'item-fanin',script:'scripts/item-fanin.ts',description:'Consolidate produced items from worker accounts into a holder/consumer account'},
 {role:'note-courier',script:'scripts/note-courier.ts',description:'Deliver noted supplies between owned accounts at bank'},
 {role:'food-courier',script:'scripts/foodcourier.ts',description:'Deliver cooked food to thieving/combat workers'},
 {role:'food-chain',script:'scripts/foodchain.ts',description:'Coordinate fish-cook-deliver food supply chain'},
 {role:'banker',script:'scripts/banker.ts',description:'Standing banker/mule account that receives and holds fleet supplies'},
 {role:'give-to-banker',script:'scripts/give-to-banker.ts',description:'Trade produced items to a standing banker account'},
 {role:'take-from-banker',script:'scripts/take-from-banker.ts',description:'Receive staged items from a standing banker account'},
 {role:'supply-chain',script:'scripts/supply-chain.ts',description:'Run multi-actor supply-chain transfer'},
 {role:'supply-holder',script:'scripts/supply-holder.ts',description:'Hold and serve staged route supplies'},
 {role:'supply-bootstrap',script:'scripts/supply-bootstrap.ts',description:'Bootstrap initial starter supplies for a fresh worker'},
 // Runecraft Essence Runners ("RC Runners")
 // Cross-side Fleet Trade
 {role:'fleet-trade',script:'scripts/fleet-trade.ts',description:'Execute cross-machine fleet order trade settlement'},
 // Loadouts & Bank Management ("Vortex Loadouts")
 {role:'loadout',script:'scripts/microbot-owned-loadout.ts',description:'Equip wear kit and withdraw exact inventory setup from bank'},
 {role:'loadout-import',script:'scripts/microbot-loadout-import.ts',description:'Import and validate inventory/equipment setup'},
 {role:'bank-sort',script:'scripts/microbot-bank-sort.ts',description:'Sort and audit bank tabs/slots'},
 // Travel & Relocation ("Auto Walker")
 {role:'walk-to',script:'scripts/walk-to.ts',description:'Walk account to any world coordinate (x, z, level) using doors/transports'},
 {role:'walk-edge',script:'scripts/pk-live/walk-edge.ts',description:'Walk to Edgeville bank through measured waypoints with a longer route planning budget'},
 {role:'restore-prayer',script:'scripts/pray-at-altar.ts',description:'Restore drained Prayer points at a nearby altar or an explicit ALTAR=x,z'},
 {role:'relocate-bank',script:'scripts/relocate-bank.ts',description:'Relocate account to target bank safely'},
 {role:'relocate-knight',script:'scripts/relocate-knight.ts',description:'Relocate thieving account to Ardougne knight spot'},
 {role:'arrive-draynor',script:'scripts/arrive-draynor.ts',description:'Walk fresh account safely from Lumbridge to Draynor bank'},
];

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
 const role = roleInput.toLowerCase().replace(/^--role=/, '');
 const spec = LOGISTICS_ROLES.find(r => r.role === role);
 if (!spec) {
  throw Error(`aio-logistics: unknown role "${role}"; known: ${LOGISTICS_ROLES.map(r => r.role).join(', ')}`);
 }
 const step = resolveRouteStep(spec, rest);
 // The offline importer has no account argument. Keep the AIO adapter as the chain entry so a pipeline or swarm
 // can inject its account without shifting the converter's two file arguments.
 if (role === 'loadout-import') {
  if (step.args.length !== 2) throw Error('aio-logistics loadout-import requires <donor-setup.json> <native-bindings.json>');
  return {script: 'scripts/aio-logistics.ts', args: ['loadout-import', ...step.args], env: step.env};
 }
 return { script: step.script, args: step.args, env: { ...(spec.defaultEnv ?? {}), ...step.env } };
}

export function importAioLoadout(args: readonly string[]) {
 if (args.length !== 2) throw Error('aio-logistics loadout-import requires <donor-setup.json> <native-bindings.json>');
 const read = (path: string) => {
  const bytes = readFileSync(path);
  if (bytes.length > 131072) throw Error('setup input exceeds128KiB');
  return JSON.parse(bytes.toString('utf8')) as unknown;
 };
 return compileInventorySetup(read(args[0]!), read(args[1]!));
}

export async function runAioLogistics(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-logistics requires account');
 const [role, ...rest] = args;
 if (!role) throw Error('aio-logistics requires <role>');
 const step = resolveLogisticsStep(role, rest);
 if (role.toLowerCase().replace(/^--role=/, '') === 'loadout-import') {
  console.log(JSON.stringify(importAioLoadout(step.args.slice(1)), null, 2));
  const result = 'RESULT ok loadout-import compiled owned kit';
  console.log(result);
  return result;
 }
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
}

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify(LOGISTICS_ROLES, null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-logistics.ts <account> <role> [args...] [KEY=value...]');
  process.exit(2);
 }
 const result = await runAioLogistics(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
