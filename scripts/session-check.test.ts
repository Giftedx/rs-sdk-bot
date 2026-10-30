import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCheckDetail, verifyDelivery, CAPABILITY } from './session-check';
import { resultCounters } from '../packages/core/src/status';

test('an in-game account reports one session check counter', () => {
    const detail = sessionCheckDetail({ inGame: true, player: { hp: 10, worldX: 3222, worldZ: 3218, level: 0 } });
    expect(resultCounters('ok ' + detail).sessionChecked).toBe(1);
});

test('an account that is not in game, dead or missing refuses', () => {
    for (const state of [undefined, { inGame: false, player: { hp: 10 } }, { inGame: true }, { inGame: true, player: { hp: 0 } }])
        expect(() => sessionCheckDetail(state)).toThrow('not in game');
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
