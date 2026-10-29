import { expect, test } from 'bun:test';
import { awaitBotReady } from '../src/bot';
import { fakeSession } from './fake';
import { executionContext } from '../../../vendor/rs-sdk/sdk/execution-context';
import type { Session } from '../src/inprocess';

for (const alreadyCancelled of [false, true]) {
    test(`an ${alreadyCancelled ? 'already' : 'in-flight'} cancelled login readiness check logs out and closes its session`, async () => {
        const source = fakeSession([{}]), controller = new AbortController(), reason = new Error('owner cancelled during boot');
        let end!: (value: { reason: string }) => void;
        const calls: string[] = [];
        const session = { ...source, name: 'inert-ready', ended: new Promise<{ reason: string }>(r => { end = r; }),
            direct: async () => {
                expect(executionContext.getStore()).toBeUndefined();
                calls.push('logout'); end({ reason: 'logged-out' }); return { success: true };
            }, close: async () => { calls.push('close'); },
        } as unknown as Session;
        if (alreadyCancelled) controller.abort(reason);
        let failure: unknown;
        const pending = executionContext.run({ signal: controller.signal }, () => awaitBotReady(session, () => {})).catch(error => { failure = error; });
        if (!alreadyCancelled) controller.abort(reason);
        for (let n = 0; n < 20; n++) await Promise.resolve();
        expect(calls).toEqual(['logout', 'close']);
        await pending;
        expect(failure).toBe(reason);
    });
}

test('cancellation after an already-ready snapshot still reclaims the newly opened session', async () => {
    const source = fakeSession([{ player: { worldX: 1, worldZ: 1, level: 0 }, skills: [{ name: 'Hitpoints', baseLevel: 10 }] } as any]);
    const oldState = source.sdk.getState;
    source.sdk.getState = () => ({ ...oldState(), inGame: true });
    const controller = new AbortController(), reason = new Error('cancelled between ready and resume');
    let end!: (value: { reason: string }) => void, closed = false;
    const session = { ...source, name: 'ready-race', ended: new Promise<{ reason: string }>(r => { end = r; }), direct: async () => { end({ reason: 'logged-out' }); return {}; }, close: async () => { closed = true; } } as unknown as Session;
    const pending = executionContext.run({ signal: controller.signal }, () => awaitBotReady(session, () => {})).then(() => 'ready', e => e);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    expect(closed).toBe(true);
});
