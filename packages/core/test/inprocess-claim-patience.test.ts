import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { botsInThisProcess, startInProcessSession, type Session } from '../src/inprocess';

// A fake lite session and a fake login claim. The claim records the options of each call.
const SECRET = 'fixture-pass-7Q';
class FakeActions { constructor(public sdk: unknown) {} }
function fakeStart(fail = false) {
    return async (o: any) => {
        if (fail) throw Error('login refused');
        let resolveStopped!: (v: unknown) => void, done = false;
        const stopped = new Promise(r => { resolveStopped = r; });
        const end = (reason: string) => { if (done) return; done = true; o.onEnd({ reason }); resolveStopped({ reason }); };
        const client: any = { collectBotState: () => ({}), executeBotAction: () => ({ success: true }), setOnGameTickCallback: () => {}, end };
        o.onClient(client);
        return { client, stop: () => end('stopped'), stopped };
    };
}

test('a login claim waits for a slow Git authority only when the process holds one bot and no plan lock', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claim-patience-')), asked: { account: string; patient: boolean | undefined }[] = [];
    const claimSwarm = ((_root: string, input: { account: string }, options: { patient?: boolean } = {}) => {
        asked.push({ account: input.account, patient: options.patient });
        return { nonce: '00000000-0000-4000-8000-000000000000', armNetwork() {}, abortBeforeNetwork() {}, releaseAfterLogout() {} };
    }) as any;
    const open = (name: string, extra: Record<string, unknown> = {}, fail = false): Promise<Session> => startInProcessSession({ name, password: SECRET, server: 'localhost:8888' }, {
        startSession: fakeStart(fail), sdk: new BotSDK({ botUsername: name, password: SECRET, autoLaunchBrowser: false, autoReconnect: false } as any), Actions: FakeActions as any,
        cacheDir: base, lifecycle: { root: join(base, 'lifecycle') }, recordOwned: () => {}, sharedAccount: { root: base, side: 'local' }, claimSwarm, ...extra });
    const end = async (s: Session) => { (s.client as any).end('logged-out'); await Bun.sleep(1); };
    try {
        const before = botsInThisProcess();
        // The one bot of a process: its claim waits.
        const first = await open('Ana');
        expect(asked.at(-1)).toEqual({ account: 'Ana', patient: true });
        expect(botsInThisProcess()).toBe(before + 1);
        // A second bot in the process (a host job, a squad): its claim keeps the short window, so the first bot does not stall.
        const second = await open('Bob');
        expect(asked.at(-1)).toEqual({ account: 'Bob', patient: false });
        expect(botsInThisProcess()).toBe(before + 2);
        // A bot that logs in again beside a running bot keeps the short window too.
        await end(first);
        expect(botsInThisProcess()).toBe(before + 1);
        const again = await open('Ana');
        expect(asked.at(-1)).toEqual({ account: 'Ana', patient: false });
        // A login that fails leaves the count.
        await expect(open('Cid', {}, true)).rejects.toThrow('login refused');
        expect(botsInThisProcess()).toBe(before + 2);
        await end(second); await end(again);
        expect(botsInThisProcess()).toBe(before);
        // One bot under the plan lock: the short window, so the lock is not held for a long wait.
        const locked = await open('Dan', { planLock: join(base, 'plan') });
        expect(asked.at(-1)).toEqual({ account: 'Dan', patient: false });
        await end(locked);
        expect(botsInThisProcess()).toBe(before);
    } finally { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); }
}, 30_000);
