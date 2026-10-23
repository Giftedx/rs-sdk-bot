// Walk benchmark: Lumbridge (3222,3218) to the Port Sarim seamen (3029,3217) on the danger-checked route.
// Usage: bun scripts/measure/walk-bench.ts <bot> <sdk|glide>
//   sdk:   bot.walkTo per waypoint (what thieving60.ts does): it waits to arrive at every path corner.
//   glide: one path for the whole route; each click goes to the path tile LOOKAHEAD steps ahead, and the next
//          click is sent before the bot gets there, so it never stands still between clicks.
// Prints WALK <mode> <ticks> <tiles> <stops> energy=<start>-><end>. "stops" counts ticks the bot did not move.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';
import { loadPathfinding } from '../../packages/core/src/pathcache';

const [bot, mode] = process.argv.slice(2);
const ROUTE: [number, number][] = [[3225, 3240], [3180, 3258], [3100, 3285], [3060, 3265], [3047, 3237], [3029, 3217]];
const LOOKAHEAD = 14;
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    const pos = () => s.sdk.getState()?.player;
    const e0 = pos()?.runEnergy;
    let stops = 0, tiles = 0;
    let last = pos();
    const off = s.onTick(() => {
        const p = pos();
        if (p && last) { const d = Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)); if (d === 0) stops++; tiles += d; }
        last = p;
    });
    const t0 = s.tick();
    if (mode === 'sdk') {
        for (const [x, z] of ROUTE) await s.bot.walkTo(x, z, 3);
    } else {
        await loadPathfinding();
        const pf: any = await import('../../vendor/rs-sdk/sdk/pathfinding');
        // Expand the route into single tiles along findLongPath's corners.
        const full: { x: number; z: number }[] = [];
        let from = pos()!;
        let cur = { x: from.worldX, z: from.worldZ };
        for (const [x, z] of ROUTE) {
            for (const w of pf.findLongPath(0, cur.x, cur.z, x, z)) {
                const steps = Math.max(Math.abs(w.x - cur.x), Math.abs(w.z - cur.z));
                for (let k = 1; k <= steps; k++) full.push({ x: Math.round(cur.x + ((w.x - cur.x) * k) / steps), z: Math.round(cur.z + ((w.z - cur.z) * k) / steps) });
                cur = { x: w.x, z: w.z };
            }
        }
        const goal = full[full.length - 1]!;
        for (let guard = 0; guard < 2000; guard++) {
            const p = pos()!;
            if (Math.max(Math.abs(p.worldX - goal.x), Math.abs(p.worldZ - goal.z)) <= 2) break;
            // Index of the path tile nearest the bot, then click LOOKAHEAD tiles past it.
            let best = 0, bd = 1e9;
            for (let i = 0; i < full.length; i++) { const d = Math.max(Math.abs(full[i]!.x - p.worldX), Math.abs(full[i]!.z - p.worldZ)); if (d < bd) { bd = d; best = i; } }
            const tgt = full[Math.min(full.length - 1, best + LOOKAHEAD)]!;
            await s.sdk.sendWalk(tgt.x, tgt.z, true);
            // Re-click when about half the lookahead is used (running moves 2 tiles per tick).
            await waitTicks(s, Math.max(1, Math.floor(LOOKAHEAD / 4)));
        }
    }
    off();
    const p = pos();
    const ticks = s.tick() - t0;
    console.log(`WALK ${mode} ${ticks} ${tiles} ${stops} energy=${e0}->${p?.runEnergy}`);
    await finish([s], !!p && Math.max(Math.abs(p.worldX - 3029), Math.abs(p.worldZ - 3217)) <= 4, `${mode} ticks=${ticks} tiles=${tiles} stops=${stops} at=${p?.worldX},${p?.worldZ}`);
} catch (e) { await finish([s], false, String(e)); }
