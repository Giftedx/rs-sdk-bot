// Renders the dashboard's map region as the game's own minimap art, from the pinned rs-world viewer and its rev 289
// cache: packages/dashboard/worldmap.png (2 px a tile, the whole region) and packages/dashboard/map-squares/<mx>_<mz>.png
// (one map square each, 256 by 256 at 4 px a tile). The region is server.ts MAP: x 2368..3487, z 2880..3711.
// Usage, from vendor/rs-world (its cache list is read from ./caches): bun ../../packages/dashboard/tools/export-world-map.ts
// With --underground it writes only the squares north of that region (dungeons sit 6400 tiles north of the surface), one
// file for each square that has map data, and no stitched image.
// The page draws these when present; the 4-colour collision map stays the fallback. Tooling only: nothing here reaches a bot.
import { CacheSystem } from '../../../vendor/rs-world/src/rs/cache/CacheSystem';
import { getCacheLoaderFactory } from '../../../vendor/rs-world/src/rs/cache/loader/CacheLoaderFactory';
import { LocModelLoader } from '../../../vendor/rs-world/src/rs/config/loctype/LocModelLoader';
import { LocLoadType, SceneBuilder } from '../../../vendor/rs-world/src/rs/scene/SceneBuilder';
import { Scene } from '../../../vendor/rs-world/src/rs/scene/Scene';
import { MapImageRenderer } from '../../../vendor/rs-world/src/rs/map/MapImageRenderer';
import { loadCache, loadCacheInfos, loadCacheList } from '../../../vendor/rs-world/scripts/cache/load-util';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const MAP = { x0: 2368, z0: 2880, w: 560, h: 416, scale: 2 }; // tiles: w*scale by h*scale
const TILES_X = MAP.w * MAP.scale, TILES_Z = MAP.h * MAP.scale;
const PX = 4; // renderMinimapHd draws 4 px a tile
const OUT_PX = 2; // the stitched image: 2 px a tile
const BORDER = 6;
const UNDERGROUND = process.argv.includes('--underground');
const out = resolve(import.meta.dir, '..', 'worldmap.png');
const squaresDir = resolve(import.meta.dir, '..', 'map-squares');
mkdirSync(squaresDir, { recursive: true });

// Plain RGB PNG with a built-in writer (no native image library on this platform): rows carry a zero filter byte.
const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (buf: Buffer) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
function png(rows: Buffer, w: number, h: number): Buffer {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const caches = loadCacheInfos(), cacheList = loadCacheList(caches), loadedCache = loadCache(cacheList.latest);
const cacheSystem = CacheSystem.fromFiles(loadedCache.type, loadedCache.files);
const factory = getCacheLoaderFactory(cacheList.latest, cacheSystem);
const locTypeLoader = factory.getLocTypeLoader(), modelLoader = factory.getModelLoader(), textureLoader = factory.getTextureLoader();
const locModelLoader = new LocModelLoader(locTypeLoader, modelLoader, textureLoader, factory.getSeqTypeLoader(), factory.getSeqFrameLoader(), factory.getSkeletalSeqLoader());
const sceneBuilder = new SceneBuilder(loadedCache.info, factory.getMapFileLoader(), factory.getUnderlayTypeLoader(), factory.getOverlayTypeLoader(), locTypeLoader, locModelLoader, loadedCache.xteas);
const renderer = new MapImageRenderer(textureLoader, locTypeLoader, factory.getMapScenes(), factory.getMapFunctions());

const width = TILES_X * PX, height = TILES_Z * PX;
const rgba = new Uint8Array(width * height * 4);
const squares = UNDERGROUND ? { x0: 28, x1: 60, z0: 58, z1: 170 } : { x0: Math.floor(MAP.x0 / 64), x1: Math.floor((MAP.x0 + TILES_X - 1) / 64), z0: Math.floor(MAP.z0 / 64), z1: Math.floor((MAP.z0 + TILES_Z - 1) / 64) };
let done = 0, empty = 0;
// A square with no map data renders as one colour; its border may hold a neighbour's tiles, so only the inside counts.
function isBlank(pixels: Int32Array) {
    const stride = size * PX, first = pixels[BORDER * PX * stride + BORDER * PX]! & 0xffffff;
    for (let y = 0; y < 64 * PX; y++) for (let x = 0; x < 64 * PX; x++) if ((pixels[(y + BORDER * PX) * stride + x + BORDER * PX]! & 0xffffff) !== first) return false;
    return true;
}
const started = Date.now();
const size = Scene.MAP_SQUARE_SIZE + BORDER * 2, sq = Buffer.alloc((64 * PX * 3 + 1) * 64 * PX);
for (let mz = squares.z0; mz <= squares.z1; mz++) for (let mx = squares.x0; mx <= squares.x1; mx++) {
    let pixels: Int32Array | null = null;
    try {
        const scene = sceneBuilder.buildScene(mx * 64 - BORDER, mz * 64 - BORDER, size, size, false, LocLoadType.NO_MODELS);
        pixels = renderer.renderMinimapHd(scene, 0, true);
    } catch (e) { empty++; console.log(`square ${mx},${mz}: ${String(e).slice(0, 80)}`); }
    if (pixels && UNDERGROUND && isBlank(pixels)) { pixels = null; empty++; }
    if (pixels) {
        // The square alone, north at the top (the renderer's rows run north to south).
        for (let y = 0; y < 64 * PX; y++) { sq[y * (64 * PX * 3 + 1)] = 0; for (let x = 0; x < 64 * PX; x++) { const rgb = pixels[(y + BORDER * PX) * size * PX + x + BORDER * PX]!; const p = y * (64 * PX * 3 + 1) + 1 + x * 3; sq[p] = (rgb >> 16) & 0xff; sq[p + 1] = (rgb >> 8) & 0xff; sq[p + 2] = rgb & 0xff; } }
        writeFileSync(resolve(squaresDir, `${mx}_${mz}.png`), png(sq, 64 * PX, 64 * PX));
        // Into the big image: row 0 is the north edge of the region.
        for (let ty = 0; ty < 64; ty++) for (let tx = 0; tx < 64; tx++) {
            const worldX = mx * 64 + tx, worldZ = mz * 64 + ty;
            if (worldX < MAP.x0 || worldX >= MAP.x0 + TILES_X || worldZ < MAP.z0 || worldZ >= MAP.z0 + TILES_Z) continue;
            for (let py = 0; py < PX; py++) for (let px = 0; px < PX; px++) {
                const sx = (tx + BORDER) * PX + px, sy = (size - 1 - (ty + BORDER)) * PX + py;
                const rgb = pixels[sy * size * PX + sx]!;
                const dx = (worldX - MAP.x0) * PX + px, dy = (MAP.z0 + TILES_Z - 1 - worldZ) * PX + py;
                const o = (dy * width + dx) * 4;
                rgba[o] = (rgb >> 16) & 0xff; rgba[o + 1] = (rgb >> 8) & 0xff; rgba[o + 2] = rgb & 0xff; rgba[o + 3] = 0xff;
            }
        }
    }
    done++;
    if (done % 50 === 0) console.log(`${done} squares, ${Math.round((Date.now() - started) / 1000)} s`);
}
if (UNDERGROUND) { console.log(`RESULT ok ${done - empty} underground squares of ${done} scanned in ${Math.round((Date.now() - started) / 1000)} s`); process.exit(0); }
// 2x2 box filter to OUT_PX a tile for the stitched image.
const ow = TILES_X * OUT_PX, oh = TILES_Z * OUT_PX, f = PX / OUT_PX;
const rows = Buffer.alloc((ow * 3 + 1) * oh);
for (let y = 0; y < oh; y++) {
    rows[y * (ow * 3 + 1)] = 0;
    for (let x = 0; x < ow; x++) {
        let r = 0, g = 0, b = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) { const o = ((y * f + dy) * width + x * f + dx) * 4; r += rgba[o]!; g += rgba[o + 1]!; b += rgba[o + 2]!; }
        const p = y * (ow * 3 + 1) + 1 + x * 3; rows[p] = r / (f * f); rows[p + 1] = g / (f * f); rows[p + 2] = b / (f * f);
    }
}
const stitched = png(rows, ow, oh);
writeFileSync(out, stitched);
console.log(`RESULT ok world map ${ow}x${oh} (${Math.round(stitched.length / 1024)} KB) and ${done - empty} squares in map-squares/ in ${Math.round((Date.now() - started) / 1000)} s -> ${out}`);
