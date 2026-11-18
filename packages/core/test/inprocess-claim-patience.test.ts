import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';
import { botsInThisProcess, soloProcess, startInProcessSession, type Session } from '../src/inprocess';

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

test('a login claim waits for a slow Git authority only in a process that is declared to hold one bot, with no plan lock', async () => {
    const base = mkdtempSync(join(tmpdir(), 'claim-patience-')), asked: { account: string; patient: boolean | undefined }[] = [];
    const claimSwarm = ((_root: string, input: { account: string }, options: { patient?: boolean } = {}) => {
        asked.push({ account: input.account, patient: options.patient });
        return { nonce: '00000000-0000-4000-8000-000000000000', armNetwork() {}, abortBeforeNetwork() {}, releaseAfterLogout() {} };
    }) as any;
    const open = (name: string, extra: Record<string, unknown> = {}, fail = false): Promise<Session> => startInProcessSession({ name, password: SECRET, server: 'localhost:8888' }, {
        startSession: fakeStart(fail), sdk: new BotSDK({ botUsername: name, password: SECRET, autoLaunchBrowser: false, autoReconnect: false } as any), Actions: FakeActions as any,
        cacheDir: base, lifecycle: { root: join(base, 'lifecycle') }, recordOwned: () => {}, sharedAccount: { root: base, side: 'local' }, claimSwarm, ...extra });
    const end = async (s: Session) => { (s.client as any).end('logged-out'); await Bun.sleep(1); };
    const last = () => asked.at(-1);
    try {
        const before = botsInThisProcess();
        // The declaration of the swarm: SWARM_BOTS is the count of bots of the job.
        expect([soloProcess({ SWARM_BOTS: '1' }), soloProcess({ SWARM_BOTS: '3' }), soloProcess({ SWARM_BOTS: '' }), soloProcess({})]).toEqual([true, false, false, false]);
        // A host job of three bots: its first bot logs in before the second has started. No bot of it waits.
        const host = { soloProcess: false };
        const first = await open('Ana', host);
        expect(last()).toEqual({ account: 'Ana', patient: false });
        expect(botsInThisProcess()).toBe(before + 1);
        // Two bots that start at the same time, as a host with no stagger: no bot waits.
        const [second, third] = await Promise.all([open('Bob', host), open('Cat', host)]);
        expect(asked.slice(-2)).toEqual([{ account: 'Bob', patient: false }, { account: 'Cat', patient: false }]);
        expect(botsInThisProcess()).toBe(before + 3);
        await end(first); await end(second); await end(third);
        expect(botsInThisProcess()).toBe(before);
        // A process with no declaration (a manual run, a fleet trade): no wait.
        const manual = await open('Dan');
        expect(last()).toEqual({ account: 'Dan', patient: false });
        await end(manual);
        // The one bot of a process that the swarm declared: its claim waits.
        const solo = { soloProcess: true };
        const one = await open('Eve', solo);
        expect(last()).toEqual({ account: 'Eve', patient: true });
        // A second bot beside it, against the declaration, keeps the short window.
        const beside = await open('Fay', solo);
        expect(last()).toEqual({ account: 'Fay', patient: false });
        // A login that fails leaves the count.
        await expect(open('Gus', solo, true)).rejects.toThrow('login refused');
        expect(botsInThisProcess()).toBe(before + 2);
        await end(one); await end(beside);
        expect(botsInThisProcess()).toBe(before);
        // One declared bot under the plan lock: the short window, so the lock is not held for a long wait.
        const locked = await open('Hal', { ...solo, planLock: join(base, 'plan') });
        expect(last()).toEqual({ account: 'Hal', patient: false });
        await end(locked);
        expect(botsInThisProcess()).toBe(before);
    } finally { rmSync(base, { recursive: true, force: true, maxRetries: 5 }); }
}, 30_000);
