// Fletching 1 -> 99 floor with stackable supplies (preset floor_fletching): no bank, no walking.
// Bands from floor-bands.ts FLETCHING: arrowheads on headless arrows (15 per action, arrows.rs2) and dart tips on
// feathers (10 per action, darts.rs2). Neither has a delay, so up to 5 actions run per tick.
// Usage: bun scripts/measure/floor-fletching.ts <bot> [perTick=5] [close=1] [open=0]
//   open=1: send the planned actions in order, perTick per tick, without waiting to see the level (the server runs
//   them in order inside one tick, so a level reached by action 3 already counts for action 4).
// Prints BAND lines (XP/tick per method) and the FLOOR line (ticks from the first input to level 99).
import { openBot, finish } from '../../packages/core/src/bot';
import { FLETCHING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, dialogOpen, clearDialogs } from './floor-lib';

const [bot, perTickArg, closeArg] = process.argv.slice(2);
const perTick = Number(perTickArg ?? 5);
const closeWhile = (closeArg ?? '0') === '1';
// FLOOR_BLIND=1: send 5 per tick without waiting to see the last tick's result (the stock check catches misses).
const blind = process.env.FLOOR_BLIND !== '0';
const open = process.argv[5] === '1';
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Fletching');
    const steps = ladder(FLETCHING);
    let ok = true;
    if (open) {
        const plan: { tip: number; base: number; band: string }[] = [];
        for (const st of steps) { const [a, b] = Object.keys(st.band.inputs) as [string, string]; for (let i = 0; i < st.actions; i++) plan.push({ tip: objId(a), base: objId(b), band: st.band.name }); }
        const slot = (id: number) => inv(s).find(i => i.id === id)!.slot;
        const slots = new Map<number, number>();
        for (const p of plan) for (const id of [p.tip, p.base]) if (!slots.has(id)) slots.set(id, slot(id));
        let q = 0;
        while (q < plan.length) {
            for (let k = 0; k < perTick && q < plan.length; k++, q++) await send(s, m, { type: 'useItemOnItem', sourceSlot: slots.get(plan[q]!.tip)!, targetSlot: slots.get(plan[q]!.base)! });
            await tick(s);
        }
        let w = 0;
        while (level(s, 'Fletching') < 99 && w++ < 10) await tick(s);
        m.actions += plan.length;
        band(m, 'open loop (all bands)', xp(s, 'Fletching'), s.tick() - m.t0, plan.length);
        steps.length = 0;
    }
    for (const st of steps) {
        const [tipName, baseName] = Object.keys(st.band.inputs) as [string, string];
        const tipId = objId(tipName), baseId = objId(baseName);
        const per = st.band.inputs[tipName]!;
        const tb = s.tick(), xb = xp(s, 'Fletching');
        const tip0 = inv(s).find(i => i.id === tipId)?.count ?? 0;
        let done = 0, stall = 0, sentActs = 0;
        while (done < st.actions && stall < 10) {
            if (level(s, 'Fletching') < st.band.from) { await tick(s); stall++; continue; }
            const tip = inv(s).find(i => i.id === tipId), base = inv(s).find(i => i.id === baseId);
            if (!tip || !base) { console.log(`WARN out of ${tipName} or ${baseName}`); ok = false; break; }
            let n = 0;
            if (closeWhile && dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); n++; }
            const want = Math.min(perTick - n, st.actions - (blind ? sentActs : done));
            if (want <= 0) { await tick(s); stall++; const a = inv(s).find(i => i.id === tipId)?.count ?? 0; done = Math.round((tip0 - a) / per); if (stall > 3) sentActs = done; continue; }
            sentActs += want;
            const before = tip.count;
            for (let k = 0; k < want; k++) await send(s, m, { type: 'useItemOnItem', sourceSlot: tip.slot, targetSlot: base.slot });
            await tick(s);
            const after = inv(s).find(i => i.id === tipId)?.count ?? 0;
            const landed = Math.round((before - after) / per);
            done = Math.round((tip0 - after) / per);
            stall = landed > 0 ? 0 : stall + 1;
        }
        band(m, st.band.name, xp(s, 'Fletching') - xb, s.tick() - tb, done);
        m.actions += done;
        if (!ok) break;
    }
    const tEnd = s.tick();
    const cleared = await clearDialogs(s, m, 'close');
    const line = report(s, m, `ticksTo99=${tEnd - m.t0} trailingClear=${cleared} perTick=${perTick} closeWhile=${closeWhile}`);
    await finish([s], ok && level(s, 'Fletching') >= 99, line);
} catch (e) { await finish([s], false, String(e)); }
