// Builds the compact 2-tile-per-pixel dashboard minimap bitmap from collision-data.json into a binary cache file.
// Run as a short-lived child process so the 27 MB collision JSON parse never inflates the long-lived dashboard server heap.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAP_CACHE_MAGIC = 0x314d5352; // 'RSM1'
export const MAP_CACHE_HEADER_BYTES = 40;

export interface MapSpec {
    readonly x0: number;
    readonly z0: number;
    readonly w: number;
    readonly h: number;
    readonly scale: number;
}

export function buildMapBytesFromCollision(collisionFile: string, map: MapSpec): Uint8Array {
    const data = JSON.parse(readFileSync(collisionFile, 'utf8'));
    const counts = new Uint16Array(map.w * map.h * 4);
    const zoneLand = new Uint8Array(map.w * map.h);
    const cell = (x: number, z: number) => {
        const px = Math.floor((x - map.x0) / map.scale), pz = Math.floor((z - map.z0) / map.scale);
        return px < 0 || pz < 0 || px >= map.w || pz >= map.h ? -1 : pz * map.w + px;
    };
    for (const [level, zx, zz] of data.zones) {
        if (level !== 0) continue;
        for (let dx = 0; dx < 8; dx += map.scale) for (let dz = 0; dz < 8; dz += map.scale) {
            const c = cell(zx + dx, zz + dz);
            if (c >= 0) zoneLand[c] = 1;
        }
    }
    for (const [level, x, z, flags] of data.tiles) {
        if (level !== 0) continue;
        const c = cell(x, z); if (c < 0) continue;
        counts[c * 4 + ((flags & 2097152) ? 2 : 3)]++;
    }
    const bytes = new Uint8Array(map.w * map.h);
    for (let i = 0; i < bytes.length; i++) {
        const water = counts[i * 4 + 2]!, obj = counts[i * 4 + 3]!;
        bytes[i] = water >= 2 ? 2 : obj >= 2 ? 3 : zoneLand[i] ? 1 : water ? 2 : 0;
    }
    return bytes;
}

export function encodeMapCache(bytes: Uint8Array, collisionSize: number, collisionMtimeMs: number, map: MapSpec): Uint8Array {
    const out = new Uint8Array(MAP_CACHE_HEADER_BYTES + bytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAP_CACHE_MAGIC, true);
    view.setFloat64(4, collisionSize, true);
    view.setFloat64(12, collisionMtimeMs, true);
    view.setInt32(20, map.x0, true);
    view.setInt32(24, map.z0, true);
    view.setUint32(28, map.w, true);
    view.setUint32(32, map.h, true);
    view.setUint32(36, map.scale, true);
    out.set(bytes, MAP_CACHE_HEADER_BYTES);
    return out;
}

export function readCachedMapBytes(cacheFile: string, collisionFile: string, map: MapSpec): Uint8Array | null {
    try {
        const st = statSync(collisionFile);
        const raw = readFileSync(cacheFile);
        const expectedLen = MAP_CACHE_HEADER_BYTES + map.w * map.h;
        if (raw.byteLength !== expectedLen) return null;
        const view = new DataView(raw.buffer, raw.byteOffset, MAP_CACHE_HEADER_BYTES);
        if (view.getUint32(0, true) !== MAP_CACHE_MAGIC) return null;
        if (view.getFloat64(4, true) !== st.size || view.getFloat64(12, true) !== st.mtimeMs) return null;
        if (
            view.getInt32(20, true) !== map.x0
            || view.getInt32(24, true) !== map.z0
            || view.getUint32(28, true) !== map.w
            || view.getUint32(32, true) !== map.h
            || view.getUint32(36, true) !== map.scale
        ) return null;
        return new Uint8Array(raw.buffer.slice(raw.byteOffset + MAP_CACHE_HEADER_BYTES, raw.byteOffset + expectedLen));
    } catch {
        return null;
    }
}

export function writeMapCacheFile(collisionFile: string, cacheFile: string, map: MapSpec): Uint8Array {
    const st = statSync(collisionFile);
    const bytes = buildMapBytesFromCollision(collisionFile, map);
    const encoded = encodeMapCache(bytes, st.size, st.mtimeMs, map);
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    writeFileSync(tmp, encoded);
    renameSync(tmp, cacheFile);
    return bytes;
}

if (import.meta.main) {
    const [collisionFile, cacheFile, x0, z0, w, h, scale] = process.argv.slice(2);
    if (!collisionFile || !cacheFile) process.exit(2);
    const map: MapSpec = {
        x0: Number(x0 ?? 2368),
        z0: Number(z0 ?? 2880),
        w: Number(w ?? 560),
        h: Number(h ?? 416),
        scale: Number(scale ?? 2),
    };
    writeMapCacheFile(collisionFile, cacheFile, map);
}
