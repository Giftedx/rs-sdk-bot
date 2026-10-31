import { expect, test } from 'bun:test';

test('with FLEET_SEED an account password is the same in every session and differs per account', async () => {
    const { accountPassword } = await import('./fleet');
    const a = accountPassword('CloudOne', 'rs-sdk-demo.fly.dev', 'seed-1');
    expect(a).toBe(accountPassword('cloudone', 'RS-SDK-DEMO.FLY.DEV', 'seed-1'));
    expect(a).toHaveLength(20);
    expect(a).not.toBe(accountPassword('CloudTwo', 'rs-sdk-demo.fly.dev', 'seed-1'));
    expect(a).not.toBe(accountPassword('CloudOne', 'rs-sdk-demo.fly.dev', 'seed-2'));
    expect(accountPassword('X', 's', '')).not.toBe(accountPassword('X', 's', ''));
});
