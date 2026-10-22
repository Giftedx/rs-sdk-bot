import { test, expect } from 'bun:test';
import { componentId, logout } from '../src/logout';

test('componentId reads the id from the interface pack by name', () => {
    expect(componentId('logout:try_logout')).toBe(2458);
});

test('logout clicks the logout button and waits for the server to end the session', async () => {
    let clicked = -1;
    let end!: (v: { reason: string }) => void;
    const s = { sdk: { sendClickComponent: async (id: number) => { clicked = id; setTimeout(() => end({ reason: 'logged-out' }), 5); return { success: true }; } }, ended: new Promise<{ reason: string }>(r => { end = r; }) };
    expect(await logout(s as any, 2000)).toBe('logged-out');
    expect(clicked).toBe(2458);
});

test('logout reports a timeout when the server never ends the session (e.g. in combat)', async () => {
    const s = { sdk: { sendClickComponent: async () => ({ success: true }) }, ended: new Promise<{ reason: string }>(() => {}) };
    expect(await logout(s as any, 50)).toBe('timeout');
});

test('logout keeps clicking until the server accepts it (the first clicks fall in the combat window)', async () => {
    let clicks = 0;
    let end!: (v: { reason: string }) => void;
    const s = { sdk: { sendClickComponent: async () => { clicks++; if (clicks === 3) setTimeout(() => end({ reason: 'logged-out' }), 1); return { success: true }; } }, ended: new Promise<{ reason: string }>(r => { end = r; }) };
    expect(await logout(s as any, 2000, { retryMs: 10 })).toBe('logged-out');
    expect(clicks).toBe(3);
});

test('logout clicks again within one tick by default (a skilling delay drops clicks that land in it)', async () => {
    let clicks = 0;
    const s = { sdk: { sendClickComponent: async () => { clicks++; return { success: true }; } }, ended: new Promise<{ reason: string }>(() => {}) };
    expect(await logout(s as any, 1300)).toBe('timeout');
    // 300 ms ticks: 1300 ms must give at least 4 clicks, not the 1 a 1500 ms retry gives.
    expect(clicks).toBeGreaterThanOrEqual(4);
});

test('a click that never resolves cannot hang logout past its deadline', async () => {
    const s = { sdk: { sendClickComponent: () => new Promise(() => {}) }, ended: new Promise<{ reason: string }>(() => {}) };
    const t0 = Date.now();
    expect(await logout(s as any, 100, { retryMs: 20 })).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
});
