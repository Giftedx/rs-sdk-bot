// Relog cost benchmark: how many logged-in ticks (board playtime) one logout + login costs.
// Usage: bun scripts/measure/relog-bench.ts <bot> [cycles=5]. Practice server only (reads the engine save file).
// Playtime is the 4-byte big-endian int at offset 24 of data/players/main/<bot>.sav
// (vendor/rs-sdk/server/engine/src/engine/entity/Player.ts:208-225). The engine writes the save on logout.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openBot, logoutSession, closeWithin } from '../../packages/core/src/bot';

const [bot, cArg] = process.argv.slice(2);
const cycles = Number(cArg ?? 5);
const sav = join(resolve(import.meta.dir, '..', '..'), 'vendor/rs-sdk/server/engine/data/players/main', `${bot!.toLowerCase()}.sav`);
const playtime = () => readFileSync(sav).readInt32BE(24);

const rows: string[] = [];
for (let i = 0; i < cycles; i++) {
    const before = (() => { try { return playtime(); } catch { return NaN; } })();
    const t0 = Date.now();
    const s = await openBot(bot!);
    const ready = Date.now();
    const out = await logoutSession(s);
    await closeWithin([s], 5000);
    const t1 = Date.now();
    await Bun.sleep(500); // let the engine write the save
    const after = playtime();
    rows.push(`cycle ${i + 1}: playtime ${before} -> ${after} (+${after - before} ticks), login ${ready - t0} ms, logout ${t1 - ready} ms, ${out}`);
}
for (const r of rows) console.log(`RELOG ${r}`);
console.log('RESULT ok');
