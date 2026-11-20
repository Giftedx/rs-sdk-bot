// Fresh-clock Strength 99 specialist: Waterfall Quest (83 Attack and Strength) plus 2-Tank Wilderness PvP.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, openBot } from '../packages/core/src/bot';
import { isLocalServer } from '../packages/core/src/localserver';
import { configureSpecialistGuardEnv, readServerHost, runMeleePvpSpecialist, type StopFn } from './combat-quest-specialists';
import { runWaterfall } from './generated/waterfall';

async function main(): Promise<void> {
    const bot = process.argv[2] ?? '';
    const capArg = process.argv.slice(3).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? 6000);
    if (!bot) throw Error('usage: strength-specialist.ts <bot> [cap]');
    if (!Number.isSafeInteger(CAP) || CAP < 500 || CAP > 20000) throw Error(`invalid CAP: ${CAP}`);
    const supplierName = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
    if (!supplierName) throw Error('missing SUPPLIER (or PRACTICE_SUPPLIER) environment variable');
    const tanksRaw = (process.env.PRACTICE_TANKS ?? process.env.TANKS ?? supplierName).trim();
    const tankNames = tanksRaw.split(',').map(x => x.trim()).filter(Boolean);

    const root = resolve(import.meta.dir, '..');
    configureSpecialistGuardEnv();
    const s = await openBot(bot);
    const serverHost = readServerHost(root, bot);
    if (!serverHost) {
        await finish([s], false, `missing SERVER in bot.env for ${bot}`);
        return;
    }

    let ended = false;
    void s.ended?.then(() => { ended = true; });
    const t0 = s.tick();
    const stop: StopFn = () =>
        ended ||
        s.tick() - t0 >= CAP ||
        existsSync(join(root, '.practice', `stop-${bot}`)) ||
        (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));

    try {
        const msg = await runMeleePvpSpecialist(s, {
            board: 'strength',
            supplierName,
            tankNames,
            cap: CAP,
            t0,
            stop,
            runWaterfallFn: runWaterfall,
        });
        await finish([s], true, msg);
    } catch (e) {
        await finish([s], false, String(e));
    }
}

if (import.meta.main) await main();
