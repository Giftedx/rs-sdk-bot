// Focused local proof reader. Layout: engine/entity/PlayerLoading.ts; CRC: presets-mm.ts. Version 10 appends
// millisecond playtimes after the parts read here, so versions 5-10 share this layout.
import { readFileSync } from 'node:fs';

function checked(b: Buffer): Buffer {
    if (b.length < 140 || b.readUInt16BE(0) !== 0x2004) throw new Error('invalid local player save');
    if ((Bun.hash.crc32(b.subarray(0, -4)) >>> 0) !== b.readUInt32BE(b.length - 4)) {
        throw new Error('local player save CRC mismatch');
    }
    return b;
}

export interface PracticeSave {
    version: number;
    position: { x: number; z: number; level: number };
    skills: { index: number; rawExperience: number; xp: number; level: number }[];
    vars: Record<number, number>;
    inventories: Record<number, { slot: number; id: number; count: number }[]>;
}

export function readPracticeSave(path: string): PracticeSave {
    return parsePracticeSave(readFileSync(path));
}

export function parsePracticeSave(raw: Uint8Array): PracticeSave {
    const b = checked(Buffer.from(raw));
    const version = b.readUInt16BE(2);
    if (version < 5 || version > 10) throw new Error(`unsupported local save version${version}`);
    const skills = Array.from({ length: 21 }, (_, i) => ({
        index: i,
        rawExperience: b.readInt32BE(28 + i * 5),
        xp: Math.trunc(b.readInt32BE(28 + i * 5) / 10),
        level: b.readUInt8(32 + i * 5),
    }));
    let at = 133;
    const u1 = () => b.readUInt8(at++);
    const u2 = () => {
        const n = b.readUInt16BE(at);
        at += 2;
        return n;
    };
    const i4 = () => {
        const n = b.readInt32BE(at);
        at += 4;
        return n;
    };
    const varInt = () => {
        let byte = u1();
        let n = 0;
        while (byte & 128) {
            n = (n | (byte & 127)) << 7;
            byte = u1();
        }
        return (n | byte) >>> 0;
    };
    const vars: Record<number, number> = {};
    const varCount = u2();
    if (varCount > 10000) throw new Error('invalid saved varp count');
    for (let i = 0; i < varCount; i++) {
        if (version >= 7) {
            const id = u2();
            vars[id] = varInt();
        } else {
            vars[i] = i4();
        }
    }
    const inventories: Record<number, { slot: number; id: number; count: number }[]> = {};
    for (let i = 0, n = u1(); i < n; i++) {
        const type = u2();
        const size = u2();
        if (size > 2000) throw new Error('invalid saved inventory size');
        const items: { slot: number; id: number; count: number }[] = [];
        for (let slot = 0; slot < size; slot++) {
            const id = u2() - 1;
            if (id < 0) continue;
            const short = u1();
            const count = short === 255 ? i4() : short;
            items.push({ slot, id, count });
        }
        inventories[type] = items;
    }
    return {
        version,
        position: { x: b.readUInt16BE(4), z: b.readUInt16BE(6), level: b.readUInt8(8) },
        skills,
        vars,
        inventories,
    };
}

// Logout acknowledgement can precede the engine's final .sav publication.
// Wait for the actual required state; a timeout retains the unmatched data.
export async function waitPracticeSave(
    path: string,
    ready: (save: PracticeSave) => boolean,
    options: { timeoutMs?: number; intervalMs?: number; read?: () => PracticeSave } = {},
) {
    const deadline = Date.now() + (options.timeoutMs ?? 6000);
    const read = options.read ?? (() => readPracticeSave(path));
    let first: PracticeSave | undefined;
    let last: PracticeSave | undefined;
    let reads = 0;
    let lastError = '';
    do {
        try {
            last = read();
            reads++;
            first ??= last;
            if (ready(last)) return { matched: true, save: last, first, reads, lastError };
        } catch (e) {
            lastError = String(e);
        }
        if (Date.now() >= deadline) break;
        await Bun.sleep(options.intervalMs ?? 250);
    } while (Date.now() <= deadline);
    if (!last) throw new Error(`native save never became readable: ${lastError}`);
    return { matched: false, save: last, first, reads, lastError };
}
