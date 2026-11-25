// Bench worker for the ends of a generic combat job (packages/workers/src/combat/melee-gather.ts runMeleeGatherCli)
// that are a RESULT fail by design: a death, a flee-guard stop, a tick cap on the bank walk. It runs
// scripts/aio-fighter.ts as a child and passes when the child's RESULT line is a fail that names the expected end.
// The KEY=value arguments also go into the child's environment, so FLEE_GUARD and DEATH_RECOVERY reach openBot.
// Usage: bun scripts/measure/combat-end-probe.ts <bot> <end> <target> [arg ...] [KEY=value ...]
//   <end>  a word of the child's RESULT line, such as died=true, fled=true or capped=true; `-` for any fail.
import { runDirectChild } from '../../packages/core/src/run-child';
// The bench keeps a result under a hash of the worker and the files it imports (aio-practice-bench.ts importClosure).
// This import puts the fighter and the combat worker into that hash.
import type {} from '../aio-fighter';

export const combatEndMet = (end: string, result: string) => /^RESULT fail /.test(result) && (end === '-' || result.split(' ').includes(end));

export function childEnv(args: readonly string[], base: Record<string, string | undefined> = process.env) {
    const env = { ...base };
    for (const arg of args) {
        const eq = arg.indexOf('=');
        if (eq > 0 && /^[A-Z0-9_]+$/.test(arg.slice(0, eq))) env[arg.slice(0, eq)] = arg.slice(eq + 1);
    }
    return env;
}

if (import.meta.main) {
    const [bot, end, ...args] = process.argv.slice(2);
    if (!bot || !end || !args.length) {
        console.log('RESULT fail usage: bun scripts/measure/combat-end-probe.ts <bot> <end> <target> [arg ...] [KEY=value ...]');
        process.exit(2);
    }
    const result = await runDirectChild(['scripts/aio-fighter.ts', bot, ...args], childEnv(args));
    const met = combatEndMet(end, result);
    console.log(`RESULT ${met ? 'ok' : 'fail'} combat-end end=${end} child=${JSON.stringify(result.slice(0, 300))}`);
    process.exit(met ? 0 : 1);
}
