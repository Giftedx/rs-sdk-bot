import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createGunzip} from 'node:zlib';
import {parsePracticeSave} from '../../../scripts/measure/fleet-player-save';
import type {SupplyRequirement} from '../../core/src/launch-evidence';
import {xpForLevel} from '../../planner/src/curve';
import {SKILLS} from './save-library';

export const SPECIALIST_TICK_MS = 400;

/** Version 10 appends 21 tick stamps and 22 millisecond counters before the CRC. */
export function scoredClock(raw: Uint8Array, board: string) {
    const save = parsePracticeSave(raw), bytes = Buffer.from(raw);
    const index = SKILLS.indexOf(board as typeof SKILLS[number]);
    if (save.version !== 10 || index < 0 || bytes.length < 150 + 21 * 4 + 22 * 8 + 4)
        throw Error('need a current engine save with the board clock footer');
    if (save.skills[index]!.xp < xpForLevel(99)) throw Error('saved board must reach level 99');
    const durations = bytes.length - 4 - 22 * 8;
    const endPlaytime = bytes.readInt32BE(24), boardTick = bytes.readInt32BE(durations - 21 * 4 + index * 4);
    if (boardTick <= 0 || boardTick > endPlaytime) throw Error('invalid saved specialist clock');
    if (bytes.readBigUInt64BE(durations) !== BigInt(endPlaytime * SPECIALIST_TICK_MS)
        || bytes.readBigUInt64BE(durations + (index + 1) * 8) !== BigInt(boardTick * SPECIALIST_TICK_MS))
        throw Error('saved clocks do not use the live 400 ms tick');
    return {endPlaytime, boardTick};
}

/** The engine writes both sides of a completed exchange. Count gross inputs, never client offers. */
export function observedSupplies(log: string, account: string, catalog: {id: number; name: string}[]): SupplyRequirement[] {
    const name = account.toLowerCase(), counts = new Map<number, number>();
    for (const line of log.split(/\r?\n/).filter(Boolean)) {
        const row = JSON.parse(line);
        if (typeof row?.from !== 'string' || typeof row.to !== 'string' || !Number.isSafeInteger(row.tick)
            || !Array.isArray(row.fromItems) || !Array.isArray(row.toItems)) throw Error('invalid practice trade ledger entry');
        const from = row.from.toLowerCase(), to = row.to.toLowerCase();
        if (from !== name && to !== name) continue;
        if (from === to) throw Error('trade ledger contains a self transfer');
        for (const item of to === name ? row.fromItems : row.toItems) {
            if (!Number.isSafeInteger(item?.id) || item.id < 0 || !Number.isSafeInteger(item.count) || item.count <= 0)
                throw Error('invalid incoming trade item');
            const count = (counts.get(item.id) ?? 0) + item.count;
            if (!Number.isSafeInteger(count)) throw Error('incoming trade item quantity overflow');
            counts.set(item.id, count);
        }
    }
    return [...counts].sort(([a], [b]) => a - b).map(([itemId, count]) => {
        const item = catalog.find(i => i.id === itemId)?.name;
        if (!item) throw Error('incoming trade item lacks exact catalog ID ' + itemId);
        return {item, count, itemId};
    });
}

export function successfulWorkerLog(log: string): boolean {
    const lines = log.split(/\r?\n/), starts = lines.filter(l => l.startsWith('START '));
    const outs = lines.filter(l => l.startsWith('LOGOUT ')), results = lines.filter(l => l.startsWith('RESULT '));
    return starts.length === 1 && /^START \d+ \d+ \d+$/.test(starts[0]!) && outs.length === 1 && outs[0] === 'LOGOUT logged-out'
        && results.length === 1 && /^RESULT ok\b/.test(results[0]!) && !lines.some(l => l.startsWith('REHEARSAL '))
        && lines.indexOf(starts[0]!) < lines.indexOf(outs[0]!) && lines.indexOf(outs[0]!) < lines.indexOf(results[0]!);
}

/** Read the worker's full tick record without retaining its large state stream. */
export async function confirmLivingSession(file: string, account: string, server: string) {
    const stream = createReadStream(file), unzip = createGunzip();
    stream.on('error', error => unzip.destroy(error));
    stream.pipe(unzip);
    const lines = createInterface({input: unzip, crlfDelay: Infinity});
    let meta = false, ended = false, life: number | undefined;
    try {
        for await (const line of lines) {
            const row = JSON.parse(line);
            if (!meta) {
                meta = row.k === 'meta' && row.account === account && row.server === server;
                if (!meta) throw Error('tick record identity differs');
                continue;
            }
            if (ended || row.k === 'cut' || row.k === 'meta') throw Error('incomplete specialist tick record');
            if (row.k === 'end') { ended = true; continue; }
            const p = row.k === 's' || row.k === 'p' ? row.d?.player : null;
            if (!p) continue;
            if (!Number.isSafeInteger(p.lifeId) || p.isDead !== false || p.respawnCount !== 0 || (life !== undefined && p.lifeId !== life))
                throw Error('specialist rehearsal life changed or is unknown');
            life = p.lifeId;
        }
    } finally {
        lines.close(); stream.destroy(); unzip.destroy();
    }
    if (!ended || life === undefined) throw Error('specialist tick record has no complete observed life');
}
