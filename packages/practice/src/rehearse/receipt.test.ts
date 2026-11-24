import {expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {recordRoot, scriptKey} from '../../../core/src/tick-record';
import {xpForLevel} from '../../../planner/src/curve';
import {writeSpecialistReceipt} from './receipt';
import {REHEARSE_ROOT, type Segment} from './types';

function engineSave(playtime = 305, levelTick = 300, tickMs = 400, level = 99) {
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

test('writeSpecialistReceipt rejects endPlaytime beyond planTicks drain window and missing record directories cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsbot-receipt-'));
    const outDir = join(dir, 'out');
    mkdirSync(outDir, {recursive: true});
    const log = join(outDir, 'seg.log');
    const savePath = join(dir, 'actor.sav');
    const ledger = join(dir, 'trades.jsonl');
    const engineLog = join(dir, 'engine.log');
    writeFileSync(log, 'START 3090 3100 0\nLOGOUT logged-out\nRESULT ok\n');
    writeFileSync(ledger, '');
    writeFileSync(engineLog, '');
    writeFileSync(savePath, engineSave(2130, 2030, 400, 99));
    try {
        const seg: Segment = {
            id: 'ranged-test',
            start: {fresh: true},
            script: 'scripts/missing-specialist-record-test.ts',
            plan: {ticks: 2000, source: 'model'},
            expect: {skills: {Ranged: 99}},
        };
        await expect(writeSpecialistReceipt(
            seg,
            {account: 'shaftshooter', board: 'Ranged', source: 'a'.repeat(64), mission: 'b'.repeat(64), ledger, engineLog},
            'rhabc1',
            '127.0.0.1:8910',
            outDir,
            log,
            savePath,
        )).rejects.toThrow('need one complete tick record of the fresh actor');

        const recDir = join(recordRoot(REHEARSE_ROOT), scriptKey(seg.script));
        mkdirSync(recDir, {recursive: true});
        const recFile = join(recDir, 'rhabc1-1.ticks.ndjson.gz');
        const gz = (rows: unknown[]) => gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        writeFileSync(recFile, gz([
            {k: 'meta', account: 'rhabc1', server: '127.0.0.1:8910'},
            {k: 's', d: {player: {lifeId: 1, isDead: false, respawnCount: 0}}},
            {k: 'end'},
        ]));
        try {
            // boardTick 2030 is within 2% of planTicks 2000, and 2130 is within 120 ticks of 2030,
            // yet 2130 exceeds planTicks + 120 (launch-evidence validateRehearsals limit).
            await expect(writeSpecialistReceipt(
                seg,
                {account: 'shaftshooter', board: 'Ranged', source: 'a'.repeat(64), mission: 'b'.repeat(64), ledger, engineLog},
                'rhabc1',
                '127.0.0.1:8910',
                outDir,
                log,
                savePath,
            )).rejects.toThrow(/differ from the plan/);
        } finally {
            rmSync(recDir, {recursive: true, force: true});
        }
    } finally {
        rmSync(dir, {recursive: true, force: true});
    }
});
