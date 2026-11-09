import {expect, test} from 'bun:test';
import {mkdtempSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {xpForLevel} from '../../planner/src/curve';
import {checkSpecialistSegment, type Segment} from '../src/rehearse';
import {confirmLivingSession, observedSupplies, scoredClock, successfulWorkerLog} from '../src/specialist-rehearsal';

function engineSave(playtime = 305, levelTick = 300, tickMs = 400, level = 99) {
    // Version 10 fixed footer after the empty varps, inventories and ancillary fields.
    const start = 150, bytes = Buffer.alloc(start + 21 * 4 + 22 * 8 + 4);
    bytes.writeUInt16BE(0x2004, 0);
    bytes.writeUInt16BE(10, 2);
    bytes.writeInt32BE(playtime, 24);
    bytes.writeInt32BE(xpForLevel(level) * 10, 28 + 4 * 5);
    bytes.writeUInt8(level, 32 + 4 * 5);
    bytes.writeInt32BE(levelTick, start + 4 * 4);
    bytes.writeBigUInt64BE(BigInt(playtime * tickMs), start + 21 * 4);
    bytes.writeBigUInt64BE(BigInt(levelTick * tickMs), start + 21 * 4 + (1 + 4) * 8);
    bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(0, -4)) >>> 0, bytes.length - 4);
    return bytes;
}

test('takes the final board and whole clocks from a current-rate level 99 engine save', () => {
    expect(scoredClock(engineSave(), 'Ranged')).toEqual({endPlaytime: 305, boardTick: 300});
    expect(() => scoredClock(engineSave(305, 300, 150), 'Ranged')).toThrow(/400 ms/);
    expect(() => scoredClock(engineSave(305, 300, 400, 98), 'Ranged')).toThrow(/99/);
    expect(() => scoredClock(engineSave(305, 306), 'Ranged')).toThrow(/clock/);
    const corrupt = engineSave(); corrupt[24] ^= 1;
    expect(() => scoredClock(corrupt, 'Ranged')).toThrow(/CRC/);
});

test('reads gross incoming trade stock by exact item ID from both orientations', () => {
    const log = [
        {tick: 50, from: 'helper', to: 'Fresh', fromItems: [{id: 882, count: 20}], toItems: [{id: 995, count: 8}]},
        {tick: 51, from: 'fresh', to: 'helper', fromItems: [], toItems: [{id: 882, count: 4}]},
        {tick: 53, from: 'helper', to: 'other', fromItems: [{id: 882, count: 55}], toItems: []},
    ].map(row => JSON.stringify(row)).join('\n');
    const catalog = [{id: 882, name: 'Bronze arrow'}];
    expect(observedSupplies(log, 'fresh', catalog)).toEqual([{item: 'Bronze arrow', count: 24, itemId: 882}]);
    expect(observedSupplies('', 'fresh', catalog)).toEqual([]);
    expect(() => observedSupplies(log, 'fresh', [])).toThrow(/item/);
    expect(() => observedSupplies(log + '\n{', 'fresh', catalog)).toThrow();
});

test('specialist start refuses fixtures and partial qualification targets', () => {
    const spec: Segment = {id: 'ranged-full', start: {fresh: true}, script: 'scripts/ranged-starter.ts',
        plan: {ticks: 300, source: 'route model'}, expect: {skills: {Ranged: 99}}};
    expect(checkSpecialistSegment(spec, 'Shaftshooter')).toBe('Ranged');
    expect(() => checkSpecialistSegment({...spec, start: {preset: 'starter'}}, 'shaftshooter')).toThrow(/fresh/);
    expect(() => checkSpecialistSegment({...spec, expect: {skills: {Ranged: 5}}}, 'shaftshooter')).toThrow(/99/);
    expect(() => checkSpecialistSegment({...spec, env: {DEMO_OK: '1'}}, 'shaftshooter')).toThrow(/environment/);
});

test('requires the one real successful worker settlement', () => {
    const log = 'START 3090 3100 0\nLOGOUT logged-out\nRESULT ok full route\n';
    expect(successfulWorkerLog(log)).toBe(true);
    expect(successfulWorkerLog(log.replace('logged-out', 'timeout'))).toBe(false);
    expect(successfulWorkerLog(log + 'RESULT fail late error\n')).toBe(false);
    expect(successfulWorkerLog(log + 'REHEARSAL prewritten\n')).toBe(false);
});

test('refuses a missing, cut, mismatched or dead actor tick record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsbot-scored-ticks-'));
    const file = join(dir, 'actor.ticks.ndjson.gz');
    const meta = {k: 'meta', account: 'actor', server: 'localhost:8910'};
    const alive = {k: 's', d: {player: {lifeId: 1, isDead: false, respawnCount: 0}}};
    const end = {k: 'end'};
    const record = (rows: unknown[]) => writeFileSync(file, gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n'));
    const check = () => confirmLivingSession(file, 'actor', 'localhost:8910');
    try {
        record([meta, alive, end]);
        await expect(check()).resolves.toBeUndefined();
        record([meta, alive]);
        await expect(check()).rejects.toThrow(/complete/);
        record([meta, alive, {k: 'cut'}, end]);
        await expect(check()).rejects.toThrow(/incomplete/);
        record([{...meta, account: 'other'}, alive, end]);
        await expect(check()).rejects.toThrow(/identity/);
        record([meta, alive, {k: 'p', d: {player: {lifeId: 1, isDead: true, respawnCount: 0}}}, end]);
        await expect(check()).rejects.toThrow(/life changed/);
    } finally {
        unlinkSync(file);
        rmdirSync(dir);
    }
});
