import { randomUUID } from 'node:crypto';
import { freemem } from 'node:os';
import { serverFromEnv } from '../../core/src/bot';
import { canBind } from './ports';
import { startStack, type StackOptions } from './stack';

export type ProofEndpoints = ReturnType<typeof geProofEndpoints>;

/** Validates and constructs isolated localhost ports and environment variables for an owned practice GE/shop stack. */
export function geProofEndpoints(
    ports: { engine: number; gateway: number; management: number; tcp: number },
    instance: string,
) {
    if (
        !ports ||
        ![ports.engine, ports.gateway, ports.management, ports.tcp].every(
            p => Number.isSafeInteger(p) && p >= 1024 && p <= 65535 && p !== 8888 && p !== 7780 && p !== 8898 && p !== 43594,
        ) ||
        new Set([ports.engine, ports.gateway, ports.management, ports.tcp]).size !== 4 ||
        !/^ge-[a-z0-9-]{1,29}$/.test(instance)
    ) {
        throw Error('owned practice endpoints required');
    }
    const server = `127.0.0.1:${ports.engine}`;
    const gateway = `ws://127.0.0.1:${ports.gateway}`;
    const env = {
        GE_PROOF_ENGINE: String(ports.engine),
        GE_PROOF_GATEWAY: String(ports.gateway),
        GE_PROOF_INSTANCE: instance,
        AGENT_PORT: String(ports.gateway),
        GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
        WEB_MANAGEMENT_PORT: String(ports.management),
        NODE_PORT: String(ports.tcp),
        GE_DATABASE: `data/market-${instance}.sqlite`,
    };
    return { ports: { ...ports }, instance, server, gateway, env };
}

/** Finds four consecutive free loopback ports and builds isolated endpoints for a practice proof instance. */
export function selectGeProofEndpoints(bind: typeof canBind = canBind, random: () => number = Math.random) {
    for (let i = 0; i < 100; i++) {
        const engine = 20000 + Math.floor(random() * 20000);
        const gateway = engine + 1;
        const management = engine + 2;
        const tcp = engine + 3;
        if ([engine, gateway, management, tcp].every(bind)) {
            return geProofEndpoints(
                { engine, gateway, management, tcp },
                'ge-' + randomUUID().replaceAll('-', '').slice(0, 20),
            );
        }
    }
    throw Error('owned practice ports unavailable');
}

/** Asserts that a bot.env file targets the isolated proof stack specified by the proof environment variables. */
export function assertGeProofAccount(text: string, env: Record<string, string | undefined> = process.env) {
    const p = geProofEndpoints(
        {
            engine: Number(env.GE_PROOF_ENGINE),
            gateway: Number(env.GE_PROOF_GATEWAY),
            management: Number(env.WEB_MANAGEMENT_PORT),
            tcp: Number(env.NODE_PORT),
        },
        env.GE_PROOF_INSTANCE ?? '',
    );
    if (serverFromEnv(text) !== p.server || text.match(/^GATEWAY_URL=(.*)$/m)?.[1]?.trim() !== p.gateway) {
        throw Error('owned practice account required');
    }
    return p.server;
}

/** Rewrites a fresh localhost:8888 practice bot.env to point at the isolated proof endpoints. */
export function geProofAccountEnv(text: string, p: ProofEndpoints) {
    if (!/^SERVER=localhost:8888\r?$/m.test(text)) throw Error('new practice account required');
    return text.replace(/^SERVER=.*$/gm, `SERVER=${p.server}`).replace(/^GATEWAY_URL=.*$/gm, `GATEWAY_URL=${p.gateway}`);
}

/** Starts an isolated practice stack with the proof endpoint environment variables, restoring process.env afterward. */
export async function startGeProofStack(
    p: ProofEndpoints,
    start: (opts: StackOptions) => ReturnType<typeof startStack> = startStack,
) {
    const previous = Object.fromEntries(Object.keys(p.env).map(k => [k, process.env[k]]));
    try {
        Object.assign(process.env, p.env);
        return await start({ ports: p.ports, instance: p.instance, tickMs: 150, readyTimeoutMs: 60000 });
    } finally {
        for (const [k, v] of Object.entries(previous)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

// One low free-memory sample between two child runs must not stop a proof that has headroom at the next check.
// Only a floor breach that lasts the whole bounded wait stops the proof.
export const HEADROOM_WAIT_MS = 60000;

/** Polls free system memory until it meets floorGb or the bounded wait window expires. */
export async function waitFreeMemory(
    floorGb: number,
    read: () => number = () => freemem() / 2 ** 30,
    pause: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms),
    waitMs = HEADROOM_WAIT_MS,
) {
    let free = read();
    for (let waited = 0; free < floorGb && waited < waitMs; waited += 250) {
        await pause(250);
        free = read();
    }
    return free;
}
