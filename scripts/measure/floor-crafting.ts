// Crafting 1 -> 99 floor at a bank booth (preset floor_crafting, Draynor bank): chisel on uncut gems (uncut_gem.rs2,
// no delay), up to 5 per tick, bands from floor-bands.ts CRAFTING. Opal, jade and red topaz can smash
// (gem.dbrow success_rate), so the preset banks 2 extra of each.
// Usage: bun scripts/measure/floor-crafting.ts <bot> [perLoad=27] [clear=close|click]
import { openBot, finish } from '../../packages/core/src/bot';
import { CRAFTING, ladder, objId, odds } from './floor-bands';
import { meter, tick, level, report, bankProduction, type Job } from './floor-lib';

const [bot, perLoadArg, clearArg] = process.argv.slice(2);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Crafting');
    const extra: Record<string, number> = { opal: 2, jade: 2, 'red topaz': 2 };
    const jobs: Job[] = [];
    for (const st of ladder(CRAFTING, 1, 99, odds)) {
        const gem = objId(Object.keys(st.band.inputs)[0]!);
        for (let i = 0; i < st.actions + (extra[st.band.name] ?? 0); i++) jobs.push({ use: gem, on: objId('chisel'), level: st.band.from, band: st.band.name, xp: st.band.xp });
    }
    const ok = await bankProduction(s, m, jobs, { keep: /^chisel$/i, pairSlots: 1, perLoad: Number(perLoadArg ?? 27), clear: (clearArg as any) ?? 'close', closeWhileProducing: process.env.FLOOR_CLOSE_WHILE !== '0' });
    const line = report(s, m, `perLoad=${perLoadArg ?? 27}`);
    await finish([s], ok && level(s, 'Crafting') >= 99, line);
} catch (e) { await finish([s], false, String(e)); }
