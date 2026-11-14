// The knife reset, shared by the gathering workers (fishing: scripts/microbot-b-fishing.ts).
// Server facts (C = vendor/rs-sdk/server/content/scripts, E = vendor/rs-sdk/server/engine/src):
// - C/skill_fletching/scripts/cut_logs.rs2:83-86: knife on a log, then "Make 1", sets %action_delay = clock + 2 when
//   it is older than clock, and puts the cut in the weak queue for 2 ticks (it runs in tick clock + 2,
//   E/engine/entity/Player.ts:1032-1041).
// - E/network/game/client/handler/OpNpcHandler.ts:47 and OpLocHandler.ts:53 call clearPendingAction, which closes the
//   modal and clears the weak queue (Player.ts:876-879, 1086-1089): a spot or rock click after the cut cuts no log and
//   keeps %action_delay. A close-modal request clears it at the next queue pass (Player.ts:998-1000), before the cut
//   runs. A drop clears it too (E/network/game/client/handler/OpHeldHandler.ts:54-55).
// - The knife on the log ends the running gather interaction (OpHeldUHandler.ts:86), so each cut needs a new click.
// - The client messages of one tick run before the queues and the interactions of that tick (E/engine/World.ts:502,
//   525; processPlayers 897-913), so the knife, "Make 1" and a click sent together act in one tick.
export const KNIFE = 946, NORMAL_LOGS = 1511;

export type KnifeAction =
  | {type: 'useItemOnItem'; sourceSlot: number; targetSlot: number}
  | {type: 'clickComponent'; componentId: number}
  | {type: 'closeModal'};

// %action_delay after a cut in tick `tick` (cut_logs.rs2:83-84).
export function knifeDelay(delay: number, tick: number) { return delay < tick ? tick + 2 : delay; }

// The two inputs of the cut, or undefined when the pack has no knife or no log. `make1` is the component id of
// skill_multi3:make1_a (packages/core/src/logout.ts componentId).
export function knifeCut(inventory: readonly {id: number; slot: number}[], make1: number): KnifeAction[] | undefined {
  const knife = inventory.find(i => i.id === KNIFE)?.slot, log = inventory.find(i => i.id === NORMAL_LOGS)?.slot;
  if (knife === undefined || log === undefined) return undefined;
  return [{type: 'useItemOnItem', sourceSlot: knife, targetSlot: log}, {type: 'clickComponent', componentId: make1}];
}
