import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCheckDetail, verifyDelivery, openSessionCheck, CAPABILITY } from './session-check';
import { supervise } from '../packages/practice/src/supervise';
import { resultCounters } from '../packages/core/src/status';

test('an in-game account reports one session check counter', () => {
    const detail = sessionCheckDetail({ inGame: true, player: { hp: 10, worldX: 3222, worldZ: 3218, level: 0 } });
    expect(resultCounters('ok ' + detail).sessionChecked).toBe(1);
});

test('an account that is not in game, dead or missing refuses', () => {
    for (const state of [undefined, { inGame: false, player: { hp: 10 } }, { inGame: true }, { inGame: true, player: { hp: 0 } }])
        expect(() => sessionCheckDetail(state)).toThrow('not in game');
});

test('an opener that refuses before it connects prints RESULT fail that the supervisor reads as release-paused', async () => {
    const refusal = new Error('no worker progress: release pin missing; live starts paused');
    const lines: string[] = [];
    const s = await openSessionCheck('Sausagefest', async () => { throw refusal; }, l => lines.push(l));
    expect(s).toBeNull();
    expect(lines).toEqual([`RESULT fail ${String(refusal)}`]);
    const r = await supervise({ run: async () => ({ stdout: lines.join('\n') + '\n', exitCode: 1 }),
        stopped: () => false, pause: async () => {}, maxRestarts: 20 });
    expect(r).toEqual({ reason: 'release-paused', runs: 1 });
});

test('verification refuses a proof for another capability or a proof that fails native checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'session-check-'));
    try {
        writeFileSync(join(dir, 'proof.json'), JSON.stringify({ capability: 'cow-progress-order', ok: true }));
        expect(() => verifyDelivery(dir)).toThrow('another capability');
        writeFileSync(join(dir, 'proof.json'), JSON.stringify({ capability: CAPABILITY, ok: true, level: 'native-controller-recovery' }));
        expect(() => verifyDelivery(dir)).toThrow('controller-native qualification');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
