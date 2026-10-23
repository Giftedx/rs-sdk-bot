// Cooking 1 -> 99 floor by the normal method (no login wine timer), preset floor_cooking at Draynor bank.
// Part 1, Cooking 1-35: light a fire, cook the best raw fish for the level on it (cooking.rs2:113 p_delay(1), so the
// next cook is accepted 3 ticks later; burns give 0 XP). Part 2, 35-99: hand-made wine at the booth, grapes on jugs
// of water, 5 per tick (wine.rs2:6-20, no delay); each wine restarts the 20-tick fermenting timer, which then
// ferments every unfermented wine in the pack and the bank (110 XP each, stat_random(48, 352)).
// Usage: bun scripts/measure/floor-cooking.ts <bot> [x=3099] [z=3249]
import { openBot, finish } from '../../packages/core/src/bot';
import { COOKING, ladder, objId, odds } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, bankProduction, nearestLoc, dialogOpen, type Job } from './floor-lib';

const [bot, xArg, zArg] = process.argv.slice(2);
const X = Number(xArg ?? 3099), Z = Number(zArg ?? 3249);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Cooking');
    // Part 1: fire.
    const tf = s.tick();
    await send(s, m, { type: 'walkTo', x: X, z: Z });
    while (s.tick() - tf < 40) { const p = s.sdk.getState()!.player!; if (Math.max(Math.abs(p.worldX - X), Math.abs(p.worldZ - Z)) <= 1) break; await tick(s); }
    const tl = s.tick();
    const tinder = inv(s).find(i => i.id === objId('tinderbox'))!, log = inv(s).find(i => i.id === objId('logs'))!;
    await send(s, m, { type: 'useItemOnItem', sourceSlot: tinder.slot, targetSlot: log.slot });
    let fire: any = null;
    while (s.tick() - tl < 60 && !fire) { await tick(s); fire = nearestLoc(s, /^fire$/i, /.*/)?.loc ?? (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => /^fire$/i.test(l.name) && l.distance <= 2); }
    if (!fire) await finish([s], false, 'no fire');
    console.log(`NOTE fire lit in ${s.tick() - tl} ticks (walk ${tl - tf})`);
    const fishBands = COOKING.filter(b => b.name !== 'wine');
    const t1 = s.tick();
    let cooked = 0, burnt = 0, stall = 0;
    while (level(s, 'Cooking') < 35 && stall < 15) {
        const lvl = level(s, 'Cooking');
        const b = [...fishBands].reverse().find(x => x.from <= lvl && inv(s).some(i => i.id === objId(Object.keys(x.inputs)[0]!)));
        if (!b) { console.log('WARN out of fish'); break; }
        const fish = inv(s).find(i => i.id === objId(Object.keys(b.inputs)[0]!))!;
        const x0 = xp(s, 'Cooking'), n0 = inv(s).filter(i => i.id === fish.id).length;
        if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
        await send(s, m, { type: 'useItemOnLoc', itemSlot: fish.slot, x: fire.x, z: fire.z, locId: fire.id });
        await tick(s);
        if (inv(s).filter(i => i.id === fish.id).length < n0) {
            const g = xp(s, 'Cooking') - x0;
            if (g > 0) cooked++; else burnt++;
            band(m, b.name, g, 0, 1); m.actions++; stall = 0;
        } else stall++;
    }
    const fishTicks = s.tick() - t1;
    band(m, 'fish total', 0, fishTicks, 0);
    console.log(`NOTE fish level=${level(s, 'Cooking')} cooked=${cooked} burnt=${burnt} ticks=${fishTicks} perItem=${(fishTicks / Math.max(1, cooked + burnt)).toFixed(2)}`);
    // Part 2: wine. Wine XP lands only when the timer fires, so production does not wait for XP.
    const tw = s.tick(), xw = xp(s, 'Cooking');
    const steps = ladder(COOKING.filter(b => b.name === 'wine'), level(s, 'Cooking'), 99, odds);
    const n = steps.reduce((a, st) => a + st.actions, 0) + Number(process.env.FLOOR_WINE_EXTRA ?? 10);
    const jobs: Job[] = Array.from({ length: n }, () => ({ use: objId('grapes'), on: objId('jug_water'), level: 35, band: 'wine', xp: 0 }));
    const ok = await bankProduction(s, m, jobs, { keep: /^(tinderbox)$/i, pairSlots: 2, perLoad: 14, clear: 'close' });
    const tMade = s.tick();
    console.log(`NOTE wines made=${n} in ${tMade - tw} ticks`);
    while (level(s, 'Cooking') < 99 && s.tick() - tMade < 40) await tick(s);
    const t99 = s.tick();
    band(m, 'wine (incl. timer)', xp(s, 'Cooking') - xw, t99 - tw, 0);
    await clearDialogs(s, m, 'close');
    const line = report(s, m, `fishTicks=${fishTicks} wineTicks=${t99 - tw} timerWait=${t99 - tMade} wines=${n} ticksTo99=${t99 - m.t0}`);
    await finish([s], ok && level(s, 'Cooking') >= 99, line);
} catch (e) { await finish([s], false, String(e)); }
