import {expect, test} from 'bun:test';
import {mkdtempSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {missionSignature} from '../../core/src/session-admission';
import {xpForLevel} from '../../planner/src/curve';
import {checkExpect, checkSpecialistSegment, ISOLATED_ENGINE_ENV, isolatedStackOptions, rehearsalChildEnv, rehearseLockstep, resolveSegmentSuppliers, stopHelperProcs, SUPPLIER_ONLINE_TIMEOUT_MS, TickWindow, waitForSuppliersOnline, type HelperProcHandle, type Segment} from '../src/rehearse';
import {confirmLivingSession, observedSupplies, scoredClock, SPECIALIST_TICK_MS, successfulWorkerLog} from '../src/specialist-rehearsal';

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

test('observedSupplies normalizes noted trade item IDs to base catalog IDs', () => {
    const log = [
        {tick: 40, from: 'helper', to: 'FullBlooded', fromItems: [{id: 2435, count: 6}, {id: 386, count: 16}], toItems: []},
        {tick: 41, from: 'FullBlooded', to: 'helper', fromItems: [], toItems: [{id: 2434, count: 1}]},
    ].map(row => JSON.stringify(row)).join('\n');
    const catalog = [
        {id: 385, name: 'Shark'},
        {id: 2434, name: 'Prayer potion(4)'},
    ];
    expect(observedSupplies(log, 'fullblooded', catalog)).toEqual([
        {item: 'Shark', count: 16, itemId: 385},
        {item: 'Prayer potion(4)', count: 7, itemId: 2434},
    ]);
});

test('specialist start refuses fixtures and partial qualification targets', () => {
    const spec: Segment = {id: 'ranged-full', start: {fresh: true}, script: 'scripts/aio-fighter.ts', args: ['ranged-starter'],
        plan: {ticks: 300, source: 'route model'}, expect: {skills: {Ranged: 99}}};
    expect(checkSpecialistSegment(spec, 'Shaftshooter')).toBe('Ranged');
    expect(() => checkSpecialistSegment({...spec, start: {preset: 'starter'}}, 'shaftshooter')).toThrow(/fresh/);
    expect(() => checkSpecialistSegment({...spec, expect: {skills: {Ranged: 5}}}, 'shaftshooter')).toThrow(/99/);
    expect(() => checkSpecialistSegment({...spec, env: {DEMO_OK: '1'}}, 'shaftshooter')).toThrow(/environment/);
    expect(() => checkSpecialistSegment({...spec, env: {PRACTICE_SUPPLIER: 'spoof'}}, 'shaftshooter')).toThrow(/environment/);
    const supplier = {save: {position: {x: 3222, z: 3222, level: 0}, inventory: [{id: 1387, count: 1}]}, script: 'scripts/aio-logistics.ts', args: ['specialist-supplier', '{ACTOR}']};
    const atkSpec: Segment = {...spec, expect: {skills: {Attack: 99}}, supplier};
    expect(checkSpecialistSegment(atkSpec, 'Hiltsdeep')).toBe('Attack');
    expect(() => checkSpecialistSegment({...atkSpec, supplier: {...supplier, script: '../bad.ts'}}, 'Hiltsdeep')).toThrow(/supplier configuration/);
    expect(() => checkSpecialistSegment({...atkSpec, supplier: {...supplier, env: {TOKEN: 'x'}}}, 'Hiltsdeep')).toThrow(/supplier environment/);
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

test('isolated rehearsal defaults to no-gateway lockstep with 400ms scored playtime and preserves seg.env', () => {
    expect(rehearseLockstep({})).toBe(true);
    expect(rehearseLockstep({REHEARSE_REALTIME: '1'})).toBe(false);

    const unscored = isolatedStackOptions(undefined, {});
    expect(unscored.gateway).toBe(false);
    expect(unscored.lockstep).toEqual({ackMs: 30_000});
    expect(unscored.tickMs).toBe(150);

    const scored = isolatedStackOptions({ledger: 'trades.jsonl', market: 'market.sqlite'}, {});
    expect(scored.gateway).toBe(false);
    expect(scored.lockstep).toEqual({ackMs: 30_000});
    expect(scored.tickMs).toBe(SPECIALIST_TICK_MS);
    expect(scored.enginePreload?.env.TRADE_LEDGER_FILE).toBe('trades.jsonl');

    const realtime = isolatedStackOptions({ledger: 'trades.jsonl', market: 'market.sqlite'}, {REHEARSE_REALTIME: '1'});
    expect(realtime.gateway).toBe(false);
    expect(realtime.lockstep).toBeUndefined();
    expect(realtime.tickMs).toBe(SPECIALIST_TICK_MS);

    const segEnv = {CAP: '4500', SUPPLIER: 'Moneyshot'};
    const missionBefore = missionSignature({account: 'hiltsdeep', script: 'scripts/attack-specialist.ts', env: {...segEnv, COORDINATOR_RUN_ID: ''}});
    const workerEnv = rehearsalChildEnv({}, segEnv, {scored: true, role: 'worker', supplier: 'spatk1'});
    const supplierEnv = rehearsalChildEnv({}, undefined, {scored: true, role: 'supplier'});
    expect(workerEnv.SIM_LOCKSTEP).toBe('1');
    expect(workerEnv.PRACTICE_SUPPLIER).toBe('spatk1');
    expect(supplierEnv.SIM_LOCKSTEP).toBe('1');
    expect(segEnv).toEqual({CAP: '4500', SUPPLIER: 'Moneyshot'});
    expect(missionSignature({account: 'hiltsdeep', script: 'scripts/attack-specialist.ts', env: {...segEnv, COORDINATOR_RUN_ID: ''}})).toBe(missionBefore);

    const realtimeWorkerEnv = rehearsalChildEnv({REHEARSE_REALTIME: '1', SIM_LOCKSTEP: '1'}, segEnv, {scored: true, role: 'worker'});
    expect(realtimeWorkerEnv.SIM_LOCKSTEP).toBeUndefined();
});

test('TickWindow tracks final logout after relog interruptions and successfulWorkerLog accepts multi-session starts', () => {
    const window = new TickWindow(true);
    window.observe(2, true);
    window.observe(248, false);
    expect(window.ticks).toBe(246);
    window.observe(249, true);
    expect(window.leave).toBeNull();
    expect(window.ticks).toBeNull();
    window.observe(2120, false);
    expect(window.enter).toBe(2);
    expect(window.leave).toBe(2120);
    expect(window.ticks).toBe(2118);

    const relogLog = 'START 3094 3106 0\nSTART 2623 3293 0\nSTART 2674 3305 0\nLOGOUT logged-out\nRESULT ok level=99\n';
    expect(successfulWorkerLog(relogLog)).toBe(true);
    expect(successfulWorkerLog('START bad\nLOGOUT logged-out\nRESULT ok\n')).toBe(false);
    expect(successfulWorkerLog('START 3094 3106 0\nLOGOUT logged-out\nSTART 2674 3305 0\nRESULT ok\n')).toBe(false);
});

test('confirmLivingSession verifies multi-segment relog files and concatenated multi-member gzip streams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rsbot-relog-ticks-'));
    const seg1 = join(dir, 'actor-10.ticks.ndjson.gz');
    const seg2 = join(dir, 'actor-20.ticks.ndjson.gz');
    const combined = join(dir, 'actor.combined.ticks.ndjson.gz');
    const meta = {k: 'meta', account: 'actor', server: 'localhost:8910'};
    const alive1 = {k: 's', d: {player: {lifeId: 7, isDead: false, respawnCount: 0}}};
    const alive2 = {k: 'p', d: {player: {lifeId: 7, isDead: false, respawnCount: 0}}};
    const end = {k: 'end'};
    const gz = (rows: unknown[]) => gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    try {
        writeFileSync(seg1, gz([meta, alive1, end]));
        writeFileSync(seg2, gz([meta, alive2, end]));
        await expect(confirmLivingSession([seg1, seg2], 'actor', 'localhost:8910')).resolves.toBeUndefined();

        writeFileSync(combined, Buffer.concat([gz([meta, alive1, end]), gz([meta, alive2, end])]));
        await expect(confirmLivingSession(combined, 'actor', 'localhost:8910')).resolves.toBeUndefined();

        writeFileSync(seg2, gz([meta, {k: 's', d: {player: {lifeId: 8, isDead: false, respawnCount: 0}}}, end]));
        await expect(confirmLivingSession([seg1, seg2], 'actor', 'localhost:8910')).rejects.toThrow(/life changed/);

        writeFileSync(seg2, gz([{...meta, account: 'other'}, alive2, end]));
        await expect(confirmLivingSession([seg1, seg2], 'actor', 'localhost:8910')).rejects.toThrow(/identity/);

        writeFileSync(seg2, gz([meta, alive2, end, alive2]));
        await expect(confirmLivingSession([seg1, seg2], 'actor', 'localhost:8910')).rejects.toThrow(/incomplete/);

        writeFileSync(seg1, gz([meta, alive1]));
        writeFileSync(seg2, gz([meta, alive2, end]));
        await expect(confirmLivingSession([seg1, seg2], 'actor', 'localhost:8910')).rejects.toThrow(/complete/);
    } finally {
        for (const f of [seg1, seg2, combined]) try { unlinkSync(f); } catch {}
        rmdirSync(dir);
    }
});

test('multi-supplier segments validate 1..32 helpers, reject mixing supplier/suppliers, and expose PRACTICE_SUPPLIER', () => {
    const sup = {save: {position: {x: 3222, z: 3222, level: 0}, inventory: [{id: 1446, count: 1}]}, script: 'scripts/aio-logistics.ts', args: ['specialist-supplier', '{ACTOR}']};
    const base: Segment = {
        id: 'pouch-rc',
        start: {fresh: true},
        script: 'scripts/runecraft-specialist.ts',
        plan: {ticks: 2155, source: 'hosted-bench'},
        expect: {skills: {Runecraft: 99}},
    };

    expect(checkSpecialistSegment({...base, suppliers: [sup, sup]}, 'PouchStuffed')).toBe('Runecraft');
    expect(resolveSegmentSuppliers({...base, suppliers: [sup, sup]})).toHaveLength(2);
    expect(() => checkSpecialistSegment({...base, supplier: sup, suppliers: [sup]}, 'PouchStuffed')).toThrow(/both supplier and suppliers/);
    expect(() => checkSpecialistSegment({...base, suppliers: []}, 'PouchStuffed')).toThrow(/1 to 32/);
    expect(() => checkSpecialistSegment({...base, suppliers: Array.from({length: 33}, () => sup)}, 'PouchStuffed')).toThrow(/1 to 32/);
    expect(() => checkSpecialistSegment({...base, suppliers: [sup, {...sup, script: '../bad.ts'}]}, 'PouchStuffed')).toThrow(/supplier configuration/);
    expect(() => checkSpecialistSegment({...base, suppliers: [sup, {...sup, env: {SECRET: 'x'}}]}, 'PouchStuffed')).toThrow(/supplier environment/);

    const workerEnv = rehearsalChildEnv({}, {CAP: '2300'}, {scored: true, role: 'worker', supplier: 'sp1,sp2,sp3'});
    expect(workerEnv.PRACTICE_SUPPLIER).toBe('sp1,sp2,sp3');
    expect(workerEnv.PRACTICE_TANKS).toBe('sp1,sp2,sp3');
    const overrideEnv = rehearsalChildEnv({}, {CAP: '6000', SUPPLIER: 'Woodenstaff', TANKS: 'Shaftsinker,Spitroaster,Unsheathed'}, {scored: true, role: 'worker', supplier: 'sp1,sp2,sp3'});
    expect(overrideEnv.PRACTICE_SUPPLIER).toBe('sp1,sp2,sp3');
    expect(overrideEnv.PRACTICE_TANKS).toBe('sp1,sp2,sp3');
    expect(SUPPLIER_ONLINE_TIMEOUT_MS).toBe(45_000);
});

test('waitForSuppliersOnline waits for all helpers, fails on early exit or timeout, and stopHelperProcs terminates live helpers', async () => {
    const alive = (pid: number): HelperProcHandle => ({pid, exitCode: null, exited: new Promise(() => {})});
    const seen = new Set<string>();
    await waitForSuppliersOnline(['sp1', 'sp2'], [alive(10), alive(11)], async h => {
        if (h === 'sp1' || seen.has('sp1')) {
            seen.add(h);
            return seen.size === 2 || h === 'sp1';
        }
        return false;
    }, 1000, 1);

    await expect(waitForSuppliersOnline(['sp1', 'sp2'], [alive(10), {pid: 11, exitCode: 1, exited: Promise.resolve(1)}], async () => false, 1000, 1))
        .rejects.toThrow(/sp2 exited early \(1\)/);

    await expect(waitForSuppliersOnline(['sp1', 'sp2'], [alive(10), alive(11)], async h => h === 'sp1', 25, 2))
        .rejects.toThrow(/did not reach world.*: sp2/);

    const killed: number[] = [];
    let markExited!: () => void;
    const graceProc: HelperProcHandle & {exitCode: number | null} = {
        pid: 102,
        exitCode: null,
        exited: new Promise<void>(r => { markExited = () => { graceProc.exitCode = 0; r(); }; }),
    };
    setTimeout(markExited, 1);
    await stopHelperProcs(
        [alive(101), graceProc, {pid: 103, exitCode: 0, exited: Promise.resolve(0)}],
        async pid => { killed.push(pid); },
        20,
    );
    expect(killed).toEqual([101]);
});

test('checkExpect counts attained XP level 99 when current Hitpoints or Prayer is drained below 99', () => {
    const injured = {
        position: {x: 3222, z: 3222, level: 0},
        skills: {
            Hitpoints: {level: 74, xp: xpForLevel(99)},
            Prayer: {level: 0, xp: xpForLevel(99)},
            Agility: {level: 98, xp: xpForLevel(98)},
        },
        inventory: {},
        worn: {},
        bank: {},
        varps: 0,
    };
    expect(checkExpect(injured, {skills: {Hitpoints: 99, Prayer: 99, Agility: 99}})).toEqual({
        'skill.Hitpoints>=99': true,
        'skill.Prayer>=99': true,
        'skill.Agility>=99': false,
    });
});

test('ISOLATED_ENGINE_ENV keeps all worker ports below Linux ip_local_port_range (32768+)', () => {
    for (const [key, value] of Object.entries(ISOLATED_ENGINE_ENV)) {
        if (!key.endsWith('_PORT')) continue;
        const port = Number(value);
        expect(Number.isInteger(port)).toBe(true);
        expect(port).toBeGreaterThan(1024);
        expect(port).toBeLessThan(32_768);
    }
});

test('checkExpect validates item container locations and min/max bounds upfront', () => {
    const empty = {position: {x: 0, z: 0, level: 0}, skills: {}, inventory: {}, worn: {}, bank: {}, varps: 0};
    expect(() => checkExpect(empty, {items: {'556': {in: 'pouch' as never, min: 1}}})).toThrow(/location/);
    expect(() => checkExpect(empty, {items: {'556': {min: -1}}})).toThrow(/min/);
    expect(() => checkExpect(empty, {items: {'556': {max: -1}}})).toThrow(/max/);
    expect(() => checkExpect(empty, {items: {'556': {min: 10, max: 5}}})).toThrow(/min > max/);
});
