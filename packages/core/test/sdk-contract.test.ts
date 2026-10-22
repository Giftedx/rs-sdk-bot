import { test, expect } from 'bun:test';
import { BotSDK } from '../../../vendor/rs-sdk/sdk/index';

// The in-process shim (src/inprocess.ts) sets BotSDK private fields and calls private methods. These are not a
// public API, so an upstream refactor would break the shim silently. This test makes that break loud.
test('BotSDK still has the private members the in-process shim relies on', () => {
    const sdk: any = new BotSDK({ botUsername: 'contract', password: 'x', autoLaunchBrowser: false, autoReconnect: false } as any);
    for (const field of ['ws', 'connectionState', 'authenticated', 'pendingActions']) expect(field in sdk).toBe(true);
    expect(sdk.pendingActions instanceof Map).toBe(true);
    for (const method of ['handleMessage', 'send', 'sendAction']) expect(typeof sdk[method]).toBe('function');
    expect(sdk.connectionState).toBe('disconnected');
});
