import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankCargo, courierWaiting } from '../src/cargo';
import type { Session } from '../src/inprocess';

test('a saved cargo attempt blocks replay after process memory has been lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-restart-'));
    try {
        const at = Date.now() - 1000;
        const request = { worker: 'restartworker', courier: 'courier', at, ready: true };
        writeFileSync(join(dir, 'request-restartworker.json'), JSON.stringify(request));
        writeFileSync(join(dir, 'attempt-restartworker.json'), JSON.stringify({ version: 1, worker: 'restartworker', courier: 'courier', at, phase: 'attempted' }));
        let withdrawals = 0;
        const state = { player: { worldX: 1, worldZ: 2, level: 0 }, nearbyPlayers: [{ name: 'courier', distance: 1 }], bank: { isOpen: true, items: [{ id: 1779, name: 'Flax', count: 10 }] } };
        const s = { name: 'restartworker', sdk: { getState: () => state, getInventory: () => [] }, bot: {
            withdrawItem: async () => { withdrawals++; throw Error('duplicate withdrawal dispatched'); },
            openBank: async () => ({ success: true }),
        } } as unknown as Session;
        expect(courierWaiting(s.name, { dir, owned: new Set(['courier']) })).toBe(false);
        await bankCargo(s, [/^Flax$/], 0, { dir, owned: new Set(['courier']) });
        expect(withdrawals).toBe(0);
        writeFileSync(join(dir, 'request-restartworker.json'), JSON.stringify({ ...request, at: at - 1 }));
        expect(courierWaiting(s.name, { dir, owned: new Set(['courier']) })).toBe(false);
        writeFileSync(join(dir, 'request-restartworker.json'), JSON.stringify({ ...request, at: at + 1 }));
        expect(courierWaiting(s.name, { dir, owned: new Set(['courier']) })).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown or corrupt cargo history cannot authorize another transfer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-history-'));
    try {
        writeFileSync(join(dir, 'request-worker.json'), JSON.stringify({ worker: 'worker', courier: 'courier', at: Date.now(), ready: true }));
        for (const value of ['{bad', JSON.stringify({ version: 9, worker: 'worker', at: Date.now() }), JSON.stringify({ version: 1, worker: 'other', courier: 'courier', at: Date.now(), phase: 'attempted' })]) {
            writeFileSync(join(dir, 'attempt-worker.json'), value);
            expect(courierWaiting('worker', { dir, owned: new Set(['courier']) })).toBe(false);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
