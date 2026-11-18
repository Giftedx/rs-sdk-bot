// The army roster rule: which accounts take the planner's army goal bands (the PK army of maxed tribrids).
// An account is on the roster when the plan's `army` array names it, or when its Attack, Strength and Defence are all
// ARMY_MELEE_MIN or more. The rule reads only the account's own observed levels, so the side that owns an account
// and a side that adopted it (packages/core/src/fleet-assign.ts) reach the same answer with no carried list.
// Never on the roster by rule: the main account and the specialist accounts (`exempt`, which names them by the
// SPECIALIST_BOARDS mark of packages/core/src/specialist-launch.ts). The plan's `armyBatch` count admits that many
// more accounts under the rule's level, best first (AGENTS.md: batches of 4 after two fresh useful live results). It
// defaults to 0.
import { exempt } from './fleet-assign';

export const ARMY_MELEE_MIN = 90;
export const ARMY_MELEE = ['Attack', 'Strength', 'Defence'] as const;

export const meleeTotal = (skills: Readonly<Record<string, number>>): number => ARMY_MELEE.reduce((n, s) => n + (skills[s] ?? 1), 0);

// Whether the rule admits an account from its levels alone.
export const admittedByLevels = (name: string, skills: Readonly<Record<string, number>>): boolean =>
    !exempt(name) && ARMY_MELEE.every(s => (skills[s] ?? 1) >= ARMY_MELEE_MIN);

// The `armyBatch` count of a swarm plan: 0 unless the plan names a positive whole number.
export const armyBatchOf = (plan: unknown): number => {
    const n = (plan as { armyBatch?: unknown } | null | undefined)?.armyBatch;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
};
