// AIO Boss ("PvM Helper"): unified CLI dispatcher & compatibility shim over packages/workers/src/combat/.
// Usage:
//   bun scripts/aio-boss.ts <account> <boss> [arg ...] [KEY=value ...]
import type { Step } from '../packages/core/src/chain-step';
import { resolveRouteStep } from '../packages/core/src/route-step';
import { runDirectChild } from '../packages/core/src/run-child';
import {
    BLACK_KIT,
    BLUE_KIT,
    KBD_KIT,
    assessBossReadiness,
    blueDungeonEntry,
    combatAssetIssues,
    combatKitTotals,
    combatTeleportAllowed,
    combatTrip,
    inKbdEntrancePit,
    inNativeKbdLair,
    leaveKbdEntrancePit,
    runCombatModeCli,
    validateCombatKit,
    type BossEncounterSpec,
    type CombatKit,
} from '../packages/workers/src/combat';

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

export {
    BLACK_KIT,
    BLUE_KIT,
    KBD_KIT,
    assessBossReadiness,
    blueDungeonEntry,
    combatAssetIssues,
    combatKitTotals,
    combatTeleportAllowed,
    combatTrip,
    inKbdEntrancePit,
    inNativeKbdLair,
    leaveKbdEntrancePit,
    validateCombatKit,
    type BossEncounterSpec,
    type CombatKit,
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
    await runCombatModeCli(account, step.args[0] ?? boss!, step.args.slice(1), mergeBossEnv(step.env, process.env, args));
    process.exit(process.exitCode && process.exitCode !== 0 ? Number(process.exitCode) : 0);
}
