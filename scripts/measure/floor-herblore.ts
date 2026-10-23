// Herblore 3 -> 99 floor at a bank booth (preset floor_herblore, Draynor bank).
// Usage: bun scripts/measure/floor-herblore.ts <bot> [perLoad=14] [clear=close|click]
// LADDER=drops: the fixed potion mix of the planner row herb-drops (HERB_DROPS, preset floor_herb_drops).
// Starts at Herblore 3: no supply method gives XP at 1-2 (identify needs 3, unfinished potions give 0 XP), so the
// account needs Druidic Ritual or another quest first. 3-99: unfinished potion + secondary (brew_potion.rs2, no delay),
// up to 5 per tick, bands from floor-bands.ts HERBLORE. Each bank trip: clear level-up pages, booth, deposit-All
// per product, withdraw with 10/5/1 buttons, close, then brew.
import { openBot, finish } from '../../packages/core/src/bot';
import { HERBLORE, HERB_DROPS, ladder, objId } from './floor-bands';
import { meter, tick, level, report, bankProduction, type Job } from './floor-lib';

const [bot, perLoadArg, clearArg] = process.argv.slice(2);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Herblore');
    const steps = ladder(HERBLORE, 3).filter(st => st.band.out);
    // The ladder from the real XP now: rebuild jobs from the current level.
    const jobs: Job[] = [];
    const src = process.env.LADDER === 'drops' ? HERB_DROPS.map(h => ({ band: h.band, actions: h.count })) : steps;
    for (const st of src) {
        const [unf, sec] = Object.keys(st.band.inputs);
        for (let i = 0; i < st.actions; i++) jobs.push({ use: objId(unf!), on: objId(sec!), level: st.band.from, band: st.band.name, xp: st.band.xp });
    }
    const ok = await bankProduction(s, m, jobs, { keep: /^$/, pairSlots: 2, perLoad: Number(perLoadArg ?? 14), clear: (clearArg as any) ?? 'close', closeWhileProducing: process.env.FLOOR_CLOSE_WHILE !== '0' });
    const line = report(s, m, `perLoad=${perLoadArg ?? 14}`);
    await finish([s], ok && level(s, 'Herblore') >= 99, line);
} catch (e) { await finish([s], false, String(e)); }

