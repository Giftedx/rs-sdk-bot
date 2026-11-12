import { expect, test } from 'bun:test';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { createShim } from '../src/inprocess';

// Bench --profile, extra:firemaking-stock-low: 18 ticks held to SIM_BUSY_MS with sdk=waitForObservation,waitForCondition
// and state=1/1. A script whose first SDK wait is open at the first tick check set the lowest listener count to that
// wait, and the ack then never counted a single SDK wait again.
test('a lockstep tick is acknowledged at once while an SDK wait that was open at the first check is pending', async () => {
    const saved = { lockstep: process.env.SIM_LOCKSTEP, busy: process.env.SIM_BUSY_MS };
    process.env.SIM_LOCKSTEP = '1'; process.env.SIM_BUSY_MS = '400';
    try {
        let cb: (() => void) | null = null;
        const acks: number[] = [];
        const client: any = {
            collectBotState: (tick: number) => ({ tick, inGame: true, player: { worldX: 3222, worldZ: 3218, level: 0 }, skills: [], inventory: [], gameMessages: [] }),
            executeBotAction: () => ({ success: true, message: 'ok' }),
            setOnGameTickCallback(c: () => void) { cb = c; }, getMaxMessageLength: () => 400,
            flush() {}, writeOpcode() { acks.push(performance.now()); },
        };
        const sdk = new BotSDK({ botUsername: 't', password: 'x', autoLaunchBrowser: false, autoReconnect: false } as any);
        const shim = createShim(client, sdk);
        shim.start();
        // The wait opens before the first tick, so the first check already sees it.
        const wait = sdk.waitForCondition(st => st.tick >= 99, 5000).catch(() => {});
        const held: number[] = [];
        for (let t = 0; t < 3; t++) {
            const t0 = performance.now(), n0 = acks.length;
            cb!();
            while (acks.length === n0 && performance.now() - t0 < 1500) await new Promise(r => setTimeout(r, 2));
            held.push(acks[n0]! - t0);
        }
        shim.stop('done'); void wait;
        expect(held.every(ms => ms < 200)).toBe(true);
    } finally {
        if (saved.lockstep === undefined) delete process.env.SIM_LOCKSTEP; else process.env.SIM_LOCKSTEP = saved.lockstep;
        if (saved.busy === undefined) delete process.env.SIM_BUSY_MS; else process.env.SIM_BUSY_MS = saved.busy;
    }
});
