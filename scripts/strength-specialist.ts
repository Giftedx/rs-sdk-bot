// Fresh-clock Strength 99 specialist: Waterfall Quest (83 Attack and Strength) plus 1-tick Rune 2h relog Keep PvP.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finish, openBot } from '../packages/core/src/bot';
import type { Session } from '../packages/core/src/inprocess';
import { isLocalServer } from '../packages/core/src/localserver';
import { configureSpecialistGuardEnv, parsePvpLocationMode, readServerHost, runMeleePvpSpecialist, type StopFn } from './combat-quest-specialists';

async function main(): Promise<void> {
    const mode = parsePvpLocationMode();
    const positional = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const bot = positional[0] ?? '';
    const capArg = positional.slice(1).find(a => /^\d+$/.test(a));
    const CAP = Number(capArg ?? process.env.CAP ?? 6000);
    if (!bot) throw Error('usage: strength-specialist.ts <bot> [cap]');
    if (!Number.isSafeInteger(CAP) || CAP < 500 || CAP > 20000) throw Error(`invalid CAP: ${CAP}`);
    const suppliersRaw = (process.env.PRACTICE_SUPPLIER ?? process.env.SUPPLIER ?? '').trim();
    const suppliers = suppliersRaw.split(',').map(x => x.trim()).filter(Boolean);
    const supplierName = suppliers[0] ?? '';
    if (!supplierName) throw Error('missing SUPPLIER (or PRACTICE_SUPPLIER) environment variable');
    const tanksRaw = (process.env.PRACTICE_TANKS ?? process.env.TANKS ?? suppliersRaw).trim();
    const tankNames = [...new Set(tanksRaw.split(',').map(x => x.trim()).filter(Boolean))];

    const root = resolve(import.meta.dir, '..');
    configureSpecialistGuardEnv();
    const retired = new WeakSet<Session>();
    let ended = false;
    let stopRequested = false;
    const s = await openBot(bot, {
        onStop: async (sess, detail) => {
            if (retired.has(sess)) return;
            stopRequested = true;
            await finish([sess], false, detail);
        },
        onSessionEnd: async (sess, detail) => {
            if (retired.has(sess)) return;
            ended = true;
            await finish([sess], false, detail);
        },
    });
    const serverHost = readServerHost(root, bot);
    if (!serverHost) {
        await finish([s], false, `missing SERVER in bot.env for ${bot}`);
        return;
    }

    const t0 = s.tick();
    const stop: StopFn = () =>
        stopRequested ||
        ended ||
        (!retired.has(s) && s.tick() - t0 >= CAP) ||
        existsSync(join(root, '.practice', `stop-${bot}`)) ||
        (!isLocalServer(serverHost) && existsSync(join(root, '.practice', 'stop-swarm')));

    try {
        const res = await runMeleePvpSpecialist(s, {
            botName: bot,
            board: 'strength',
            supplierName,
            tankNames,
            cap: CAP,
            t0,
            stop,
            mode,
            onRetireSession: sess => retired.add(sess),
        });
        await finish([res.session], true, res.message);
    } catch (e) {
        if (!retired.has(s)) {
            await finish([s], false, String(e));
        } else {
            const errSess = await openBot(bot, { log: () => {} }).catch(() => null);
            await finish(errSess ? [errSess] : [], false, String(e));
        }
    }
}

if (import.meta.main) await main();
