// AIO Boss ("PvM Helper"): unified CLI dispatcher & compatibility shim over packages/workers/src/combat/.
// Usage:
//   bun scripts/aio-boss.ts <account> <boss> [arg ...] [KEY=value ...]
import { createRequire } from 'node:module';
import type { Step } from '../packages/core/src/chain-step';
import { resolveRouteStep } from '../packages/core/src/route-step';
import { runDirectChild } from '../packages/core/src/run-child';
import type { CombatKit } from '../packages/workers/src/combat/trip-kit';
import type { BossEncounterSpec } from '../packages/workers/src/combat/types';

const require = createRequire(import.meta.url);
type CombatModule = typeof import('../packages/workers/src/combat/module');
type SurvivabilityModule = typeof import('../packages/workers/src/combat/survivability');
type TripKitModule = typeof import('../packages/workers/src/combat/trip-kit');
let combatMod: CombatModule | undefined;
let survMod: SurvivabilityModule | undefined;
let tripKitMod: TripKitModule | undefined;
const getCombatMod = () => (combatMod ??= require('../packages/workers/src/combat/module') as CombatModule);
const getSurvMod = () => (survMod ??= require('../packages/workers/src/combat/survivability') as SurvivabilityModule);
const getTripKitMod = () => (tripKitMod ??= require('../packages/workers/src/combat/trip-kit') as TripKitModule);
const lazyObj = <T extends object>(load: () => T): T => new Proxy({} as T, {
    get: (_t, p) => Reflect.get(load(), p),
    has: (_t, p) => Reflect.has(load(), p),
    ownKeys: () => Reflect.ownKeys(load()),
    getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(load(), p),
});

export const BLACK_KIT: TripKitModule['BLACK_KIT'] = lazyObj(() => getTripKitMod().BLACK_KIT);
export const BLUE_KIT: TripKitModule['BLUE_KIT'] = lazyObj(() => getTripKitMod().BLUE_KIT);
export const KBD_KIT: TripKitModule['KBD_KIT'] = lazyObj(() => getTripKitMod().KBD_KIT);
export const assessBossReadiness: CombatModule['assessBossReadiness'] = (...a) => getCombatMod().assessBossReadiness(...a);
export const blueDungeonEntry: TripKitModule['blueDungeonEntry'] = (...a) => getTripKitMod().blueDungeonEntry(...a);
export const combatAssetIssues: TripKitModule['combatAssetIssues'] = (...a) => getTripKitMod().combatAssetIssues(...a);
export const combatKitTotals: TripKitModule['combatKitTotals'] = (...a) => getTripKitMod().combatKitTotals(...a);
export const combatTeleportAllowed: SurvivabilityModule['combatTeleportAllowed'] = (...a) => getSurvMod().combatTeleportAllowed(...a);
export const combatTrip: TripKitModule['combatTrip'] = (...a) => getTripKitMod().combatTrip(...a);
export const inKbdEntrancePit: TripKitModule['inKbdEntrancePit'] = (...a) => getTripKitMod().inKbdEntrancePit(...a);
export const inNativeKbdLair: TripKitModule['inNativeKbdLair'] = (...a) => getTripKitMod().inNativeKbdLair(...a);
export const leaveKbdEntrancePit: TripKitModule['leaveKbdEntrancePit'] = (...a) => getTripKitMod().leaveKbdEntrancePit(...a);
export const validateCombatKit: TripKitModule['validateCombatKit'] = (...a) => getTripKitMod().validateCombatKit(...a);

export const BOSS_ENCOUNTERS: readonly BossEncounterSpec[] = [
    {
        boss: 'kbd',
        script: 'scripts/aio-boss.ts',
        description: 'King Black Dragon full trip: KBD_KIT withdraw, Lava Maze lever entry, antifire/prayer/melee fight, loot, and escape',
    },
    {
        boss: 'black-dragon',
        script: 'scripts/aio-boss.ts',
        description: 'Taverley black dragons from the corridor south of their cave: BLACK_KIT withdraw, dusty key gate, ranged camp that takes no melee, hides and bones banked',
    },
    {
        boss: 'blue-dragon',
        script: 'scripts/aio-boss.ts',
        description: 'Taverley blue dragons ranged safespot trip: Anti-dragon shield, dusty key gate, bones and hides banked',
    },
    {
        boss: 'green-dragon',
        script: 'scripts/aio-boss.ts',
        description: 'Wilderness Green Dragons (rev 289): Dragonfire shield preflight, bone/dhide loot, PKer threat retreat, and Edgeville bank',
    },
    {
        boss: 'trawler',
        script: 'scripts/aio-boss.ts',
        description: 'Port Khazard Fishing Trawler minigame trip (paste/bailing/net inspection)',
    },
    {
        boss: 'trawler-at-site',
        script: 'scripts/aio-boss.ts',
        description: 'At-dock Fishing Trawler minigame loop',
    },
];

export function resolveBossStep(bossInput: string, rest: readonly string[] = []): Step {
    const boss = bossInput.toLowerCase().replace(/^--boss=/, '');
    const spec = BOSS_ENCOUNTERS.find(b => b.boss === boss);
    if (!spec) {
        throw Error(`aio-boss: unknown encounter "${boss}"; known: ${BOSS_ENCOUNTERS.map(b => b.boss).join(', ')}`);
    }
    const step = resolveRouteStep(spec, rest);
    if (boss === 'kbd' && step.args.length) {
        if (step.args.length !== 1 || !/^\d+$/.test(step.args[0]!) || Number(step.args[0]) < 1 || Number(step.args[0]) > 1000) {
            throw Error('aio-boss kbd positional CAP must be 1..1000 ticks; use TRIP_CAP for the full trip');
        }
        if (step.env.CAP === undefined) step.env.CAP = step.args[0]!;
        step.args = [];
    }
    return { script: step.script, args: [spec.boss, ...step.args], env: { ...(spec.defaultEnv ?? {}), ...step.env } };
}

export type {
    BossEncounterSpec,
    CombatKit,
};

function mergeBossEnv(stepEnv: Record<string, string>, baseEnv: Record<string, string | undefined>, rawArgs: readonly string[]) {
    const cli: Record<string, string> = {};
    for (const arg of rawArgs) {
        const eq = arg.indexOf('=');
        if (eq > 0 && /^[A-Z0-9_]+$/.test(arg.slice(0, eq))) cli[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    const definedBase: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) definedBase[k] = v;
    return { ...stepEnv, ...definedBase, ...cli };
}

export async function runAioBoss(
    account: string,
    args: readonly string[],
    env: Record<string, string | undefined> = process.env,
): Promise<string> {
    if (!account) throw Error('aio-boss requires account');
    const [boss, ...rest] = args;
    if (!boss) throw Error('aio-boss requires <boss>');
    const step = resolveBossStep(boss, rest);
    return runDirectChild([step.script, account, ...step.args], mergeBossEnv(step.env, env, rest));
}

if (import.meta.main) {
    const [account, ...rest] = process.argv.slice(2);
    if (account === '--list') {
        console.log(JSON.stringify(BOSS_ENCOUNTERS, null, 2));
        process.exit(0);
    }
    if (!account || !rest.length) {
        console.log('RESULT fail usage: bun scripts/aio-boss.ts <account> <kbd|black-dragon|blue-dragon|green-dragon|trawler|trawler-at-site> [args...]');
        process.exit(2);
    }
    const [boss, ...args] = rest;
    const step = resolveBossStep(boss!, args);
    const { runCombatModeCli } = await import('../packages/workers/src/combat/module');
    await runCombatModeCli(account, step.args[0] ?? boss!, step.args.slice(1), mergeBossEnv(step.env, process.env, args));
    process.exit(process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 0);
}
