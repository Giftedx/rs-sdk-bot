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
// Accounts that stay out of the rule beside `exempt`: the accounts that the swarm and the cloud recovery never recover
// (PROTECTED_ACCOUNTS in scripts/swarm.ts, NEVER_RECOVERED in scripts/cloud-recover.ts) that `exempt` does not name.
export const RULE_PROTECTED: ReadonlySet<string> = new Set(['afknight']);
export const admittedByLevels = (name: string, skills: Readonly<Record<string, number>>): boolean =>
    !exempt(name) && !RULE_PROTECTED.has(name.toLowerCase()) && ARMY_MELEE.every(s => (skills[s] ?? 1) >= ARMY_MELEE_MIN);

// The `armyBatch` count of a swarm plan: 0 unless the plan names a positive whole number.
export const armyBatchOf = (plan: unknown): number => {
    const n = (plan as { armyBatch?: unknown } | null | undefined)?.armyBatch;
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// The accounts of `rows` (statuses or snapshot rows with a `skills` array) that the rule admits: owned by the side that
// asks (`owned`), not held by a hand job (`held`, lower case), and Attack, Strength and Defence at ARMY_MELEE_MIN or more.
// A side publishes these with its plan (scripts/fleet-sync.ts planView), and the scoreboard counts its own side's the same way.
export function ruleRoster(rows: readonly any[], owned: (name: string) => boolean, held: ReadonlySet<string> = new Set()): string[] {
    const out = new Set<string>();
    for (const r of rows) {
        const name = typeof r?.name === 'string' ? r.name : '';
        if (!name || !owned(name) || held.has(name.toLowerCase())) continue;
        const levels = Object.fromEntries((Array.isArray(r.skills) ? r.skills : []).filter((k: any) => typeof k?.name === 'string' && Number.isFinite(k.level)).map((k: any) => [k.name, k.level]));
        if (admittedByLevels(name, levels)) out.add(name.toLowerCase());
    }
    return [...out].sort();
}
// The accounts that a hand job holds: a job of the plan that is no planner job of `side` and is enabled, or has no script (a
// reservation: `enabled: false` and no script, as the squad accounts and the main and specialist accounts are held). Such an
// account is not plannable (plannableAccounts), so it is not on the roster by rule.
export function handNamed(jobs: readonly any[], side: string): Set<string> {
    return new Set(jobs.filter(j => (j?.enabled !== false || !j?.script) && j?.autopilot !== side).flatMap(j => [j?.account, ...(j?.accounts ?? [])]).filter((n): n is string => typeof n === 'string').map(n => n.toLowerCase()));
}
