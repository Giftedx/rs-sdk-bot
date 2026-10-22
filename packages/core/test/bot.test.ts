import { test, expect } from 'bun:test';
import { closeWithin } from '../src/bot';

test('closeWithin returns after its limit even if a session close never finishes', async () => {
    const stuck = { close: () => new Promise<void>(() => {}) };
    const fine = { close: async () => {} };
    const t0 = Date.now();
    const r = await closeWithin([stuck as any, fine as any], 200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).toEqual({ closed: 1, timedOut: 1 });
});

test('serverFromEnv uses SERVER from bot.env, and the local practice server when it is empty or local', async () => {
    const { serverFromEnv } = await import('../src/bot');
    expect(serverFromEnv('BOT_USERNAME=a\nSERVER=rs-sdk-demo.fly.dev\n')).toBe('rs-sdk-demo.fly.dev');
    expect(serverFromEnv('SERVER=localhost:8888\n')).toBe('localhost:8888');
    expect(serverFromEnv('SERVER=\n')).toBe('localhost:8888');
    expect(serverFromEnv('BOT_USERNAME=a\n')).toBe('localhost:8888');
});

test('a non-local server is refused unless DEMO_OK=1 is set on purpose', async () => {
    const { assertServerAllowed } = await import('../src/bot');
    expect(() => assertServerAllowed('localhost:8888', {})).not.toThrow();
    expect(() => assertServerAllowed('rs-sdk-demo.fly.dev', {})).toThrow(/DEMO_OK/);
    expect(() => assertServerAllowed('rs-sdk-demo.fly.dev', { DEMO_OK: '1' })).not.toThrow();
});
