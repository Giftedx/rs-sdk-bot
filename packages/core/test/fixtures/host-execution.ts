// Inert hosted worker fixture. No client, account login or game action.
import { finish } from '../../src/bot';
import { BotSDK } from '../../../../vendor/rs-sdk/sdk/index';
import { executionContext } from '../../../../vendor/rs-sdk/sdk/execution-context';

const name = process.argv[2]!;
const sdk = new BotSDK({ botUsername: 'scope-fixture', password: 'test', autoLaunchBrowser: false });
const evidence = (globalThis as any).__hostExecutionEvidence;
const row: any = evidence[name] = { signal: executionContext.getStore()?.signal, sdk, activeBeforeFinish: false, error: '' };
void sdk.waitForStateChange(150).catch(error => { row.error = String(error); });
if (name === 'scope-survivor') {
    await Bun.sleep(25);
    row.otherFinished = evidence['scope-finisher'].signal?.aborted;
}
row.activeBeforeFinish = row.signal !== undefined && !row.signal.aborted;
if (name === 'scope-exiter') {
    const host = [...((globalThis as any).__rsBotHost as Map<string, any>).values()].find(x => x.name === name);
    host.sessions.push({ ended: Promise.resolve({ reason: 'logged-out' }), direct: async () => {}, close: async () => { row.closed = true; } });
    process.exit(3);
}
await finish([], true, 'inert worker ended');
