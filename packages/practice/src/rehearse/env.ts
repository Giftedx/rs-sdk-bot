import { readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
import { isLocalServer } from '../../../core/src/localserver';
import { PRACTICE_STARTUP_GB } from '../../../core/src/memory';
import { killTree } from '../../../core/src/proc';
import { SPECIALIST_TICK_MS } from '../specialist-rehearsal';
import { startStack, type Stack, type StackOptions } from '../stack';
import { ISOLATED, ISOLATED_ENGINE_ENV, SUPPLIER_ONLINE_TIMEOUT_MS, type HelperProcHandle } from './types';

export function pointBotAt(envPath: string, engine: number, gateway: number, host = 'localhost') {
    const server = `${host}:${engine}`;
    if (!isLocalServer(server)) throw new Error('rehearsal bots must use the local engine');
    let env = readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n');
    for (const [k, v] of [['SERVER', server], ['GATEWAY_URL', `ws://${host}:${gateway}`]] as const)
        env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'gm'), `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
    writeFileSync(envPath, env);
    if (!new RegExp(`^SERVER=${server}$`, 'm').test(readFileSync(envPath, 'utf8'))) throw new Error('bot.env SERVER rewrite failed');
}

export function rehearseLockstep(envVars: Record<string, string | undefined> = process.env): boolean {
    return envVars.REHEARSE_REALTIME !== '1';
}

export function rehearsalChildEnv(
    baseEnv: Record<string, string | undefined>,
    segEnv: Record<string, string> | undefined,
    opts: {scored: boolean; role: 'worker' | 'supplier'; supplier?: string},
): Record<string, string | undefined> {
    const lockstep = rehearseLockstep(baseEnv);
    const out: Record<string, string | undefined> = opts.role === 'supplier'
        ? (opts.scored
            ? {...baseEnv, ...segEnv, DEMO_OK: '', TICK_RECORD: '0', COORDINATOR_RUN_ID: ''}
            : {...baseEnv, RANDOM_EVENTS: '0', ...segEnv, DEMO_OK: ''})
        : (opts.scored
            ? {...baseEnv, ...segEnv, ...(opts.supplier ? {PRACTICE_SUPPLIER: opts.supplier} : {}), DEMO_OK: '', TICK_RECORD: '1', COORDINATOR_RUN_ID: ''}
            : {...baseEnv, RANDOM_EVENTS: '0', ...segEnv, ...(opts.supplier ? {PRACTICE_SUPPLIER: opts.supplier} : {}), DEMO_OK: ''});
    if (lockstep) out.SIM_LOCKSTEP = '1';
    else delete out.SIM_LOCKSTEP;
    return out;
}

export function isolatedStackOptions(
    scored?: {ledger: string; market: string},
    envVars: Record<string, string | undefined> = process.env,
): StackOptions {
    const env = scored ? {...ISOLATED_ENGINE_ENV, TRADE_LEDGER_FILE: scored.ledger, GE_ENABLED: 'false', GE_DATABASE: scored.market} : ISOLATED_ENGINE_ENV;
    return {
        tickMs: scored ? SPECIALIST_TICK_MS : Number(envVars.REHEARSE_TICK_MS ?? 150),
        xpRate: 25,
        gateway: false,
        ...(rehearseLockstep(envVars) ? {lockstep: {ackMs: 30_000}} : {}),
        ports: {engine: ISOLATED.engine, gateway: ISOLATED.gateway},
        readyTimeoutMs: 300_000,
        enginePreload: {module: resolve(import.meta.dir, '..', 'save-endpoint.ts'), env},
        instance: 'rehearse',
    };
}

export async function waitForSuppliersOnline(
    helpers: readonly string[],
    helperProcs: readonly HelperProcHandle[],
    isOnline: (helper: string) => Promise<boolean>,
    timeoutMs = SUPPLIER_ONLINE_TIMEOUT_MS,
    pollMs = 50,
): Promise<void> {
    const readyDeadline = Date.now() + timeoutMs;
    const pendingOnline = new Set(helpers);
    while (Date.now() < readyDeadline && pendingOnline.size > 0) {
        for (let i = 0; i < helperProcs.length; i++) {
            const hp = helperProcs[i]!;
            if (hp.exitCode !== null) throw new Error(`practice supplier ${helpers[i]} exited early (${hp.exitCode})`);
        }
        const checked = await Promise.all([...pendingOnline].map(async h => ({h, ok: await isOnline(h).catch(() => false)})));
        for (const {h, ok} of checked) {
            if (ok) pendingOnline.delete(h);
        }
        if (pendingOnline.size === 0) break;
        let readyTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
            ...helperProcs.map(p => p.exited),
            new Promise<void>(r => { readyTimer = setTimeout(r, pollMs); }),
        ]).finally(() => clearTimeout(readyTimer));
    }
    if (pendingOnline.size > 0) {
        throw new Error(`practice supplier(s) did not reach world within ${Math.round(timeoutMs / 1000)} s: ${[...pendingOnline].join(', ')}`);
    }
}

export async function stopHelperProcs(
    helperProcs: readonly HelperProcHandle[],
    terminate: (pid: number) => Promise<void> = killTree,
    graceMs = 5_000,
): Promise<void> {
    await Promise.all(helperProcs.map(async helperProc => {
        if (helperProc.exitCode !== null) return;
        let helperTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([helperProc.exited, new Promise<void>(r => { helperTimer = setTimeout(r, graceMs); })]).finally(() => clearTimeout(helperTimer));
        if (helperProc.exitCode === null) await terminate(helperProc.pid);
    }));
}

export async function startIsolatedStack(scored?: {ledger: string; market: string}): Promise<Stack> {
    if (freemem() / 2 ** 30 < PRACTICE_STARTUP_GB) throw new Error(`practice startup needs ${PRACTICE_STARTUP_GB} GiB free`);
    return startStack(isolatedStackOptions(scored));
}
