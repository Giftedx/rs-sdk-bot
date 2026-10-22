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
