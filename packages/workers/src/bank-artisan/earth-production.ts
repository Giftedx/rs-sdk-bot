// Earth rune production entrypoint for GE fallback without loading the full AIO skiller closure.
import { openBot, settle } from '../../../core/src/bot';
import { runEarthProduction } from './magic';

export async function runEarthProductionEntryCli(
    args: readonly string[] = process.argv.slice(2),
    env: Record<string, string | undefined> = process.env,
): Promise<number> {
    const [botName, mode, capArg] = args;
    if (!botName || !mode) {
        console.log('RESULT fail usage: bun packages/workers/src/bank-artisan/earth-production.ts <account> <talismans|craft> [cap]');
        return 2;
    }
    let stopped = false;
    const s = await openBot(botName, { onStop: async () => { stopped = true; } });
    try {
        const r = await runEarthProduction(s, {
            mode: mode as 'talismans' | 'craft',
            cap: Number(capArg ?? env.CAP ?? 1600),
            target: Number(env.STOCK_TARGET),
            reserve: Number(env.COIN_RESERVE),
            killsPerTarget: Number(env.HUNT_KILLS_PER_TARGET ?? 0),
            stop: () => stopped,
        });
        console.log('EARTH_PRODUCTION ' + JSON.stringify(r));
        const ok = await settle(
            [s],
            r.ok,
            Object.entries(r)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join(' '),
        );
        return ok ? 0 : 1;
    } catch (e) {
        await settle([s], false, String(e));
        return 1;
    }
}

if (import.meta.main) {
    process.exitCode = await runEarthProductionEntryCli();
}
