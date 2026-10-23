// Firemaking 1 -> 99 floor with no banking: a helper drops the logs on a planned path north of Draynor bank, and the
// firemaker (tinderbox only) lights each log where it lies ([opobj4,_category_22] -> light_logs_ground).
// Path (walk map from the rsmod pathfinder, 2026-10-23): row z=3248 west 3098 -> 3072, row 3249 east 3077 -> 3097,
// row 3250 west 3098 -> 3078, then again from 3098,3248. A fire lasts 100-199 ticks (firemaking.rs2:121), so a row
// is free again two rows later. Player drops show to others after 100 ticks (WorldConfig.ts:115) and last 300
// (drop.rs2:22), so the helper stays 20-55 logs ahead of the firemaker.
// Presets: firemaker floor_fmr (tinderbox, Draynor bank), helper <bot>b floor_fmr_helper (Draynor bank, logs banked).
// Usage: FLOOR_HELPER=floor_fmr_helper bun scripts/measure/floor-run.ts scripts/measure/floor-fm-rows.ts floor_fmr 3
// The firemaker's clock starts at its first light (in a real run it logs in when the first logs show).
import { openBot, finish } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { FIREMAKING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, openBank, bankOpen, bankItems, withdrawN, dialogOpen, countId } from './floor-lib';

const [bot] = process.argv.slice(2);
const s = await openBot(bot!);
const h = await openBot(`${bot}b`).catch(async e => finish([s], false, `helper login: ${String(e)}`));
try {
    await tick(s, 3);
    const m = meter(s, 'Firemaking');
    const hm = meter(h, 'Firemaking');
    // Tile path.
    const rows: { x: number; z: number }[] = [];
    const row = (z: number, a: number, b: number) => { const d = a < b ? 1 : -1; for (let x = a; x !== b + d; x += d) rows.push({ x, z }); };
    for (let k = 0; k < 3; k++) { row(3248, 3098, 3072); row(3249, 3077, 3097); row(3250, 3098, 3078); }
    // Logs in band order.
    const logs: { id: number; band: string }[] = [];
    for (const st of ladder(FIREMAKING)) for (let i = 0; i < st.actions; i++) logs.push({ id: objId(Object.keys(st.band.inputs)[0]!), band: st.band.name });
    const plan = logs.map((l, i) => ({ ...l, ...rows[i]! }));
    const pos = (a: Session) => { const p = a.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
    const ground = (a: Session) => ((a.sdk.getState() as any)?.groundItems ?? []) as any[];

    // ---- Helper.
    let dropped = 0, lit = 0, helperStop = false;
    // After a session ends, tick() resolves at once and the tick counter stops: every loop must stop too.
    void s.ended.then(() => { helperStop = true; }); void h.ended.then(() => { helperStop = true; });
    const dropAt: number[] = [];
    const helperLoop = (async () => {
        while (dropped < plan.length && !helperStop) {
            // Load the next 28 logs.
            if (!inv(h).some(i => plan.slice(dropped).some(p => p.id === i.id))) {
                if (await openBank(h, hm) < 0) { console.log('WARN helper bank'); return; }
                const chunk = plan.slice(dropped, dropped + 28);
                const need = new Map<number, number>();
                for (const p of chunk) need.set(p.id, (need.get(p.id) ?? 0) + 1);
                for (const [id, c] of need) {
                    let b = bankItems(h).find(x => x.id === id);
                    for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(h); b = bankItems(h).find(x => x.id === id); }
                    if (!b || b.count < c) { console.log(`WARN helper bank short of ${id}`); return; }
                    await withdrawN(h, hm, b.slot, c);
                }
                await send(h, hm, { type: 'closeModal' });
                const tw = h.tick();
                while ((bankOpen(h) || [...need].some(([id, c]) => countId(h, id) < c)) && h.tick() - tw < 30) await tick(h);
            }
            // Stay at most 55 logs ahead: a drop lasts 300 ticks and a log burns in about 4.
            while (dropped - lit > 55 && !helperStop) await tick(h);
            if (helperStop) return;
            const p = plan[dropped]!;
            const it = inv(h).find(i => i.id === p.id);
            if (!it) { console.log(`WARN helper lacks log ${p.id} for step ${dropped}`); return; }
            const tw = h.tick();
            while ((pos(h).x !== p.x || pos(h).z !== p.z) && h.tick() - tw < 30 && !helperStop) {
                if ((h.tick() - tw) % 4 === 0) await h.direct({ type: 'walkTo', x: p.x, z: p.z, running: Math.abs(pos(h).x - p.x) + Math.abs(pos(h).z - p.z) > 2, reason: 'SDK' });
                await tick(h);
            }
            // The client shows the new tile before the server has moved there: wait one more tick, or the drop lands a tile short.
            await tick(h);
            // Wait until the pack shows the drop: the client keeps a dropped slot for a tick, and a second drop on that
            // slot is lost (seen: every other tile had no log).
            const n0 = inv(h).length;
            await send(h, hm, { type: 'dropItem', slot: it.slot });
            const td = h.tick();
            while (inv(h).length >= n0 && h.tick() - td < 6 && !helperStop) await tick(h);
            if (inv(h).length >= n0) { console.log(`WARN helper drop ${dropped} not seen`); continue; }
            dropAt[dropped] = s.tick();
            dropped++;
        }
        // Step off the path.
        await h.direct({ type: 'walkTo', x: 3092, z: 3246, reason: 'SDK' });
    })().catch(e => { if (!helperStop) console.log(`WARN helper loop: ${String(e)}`); });

    // ---- Firemaker.
    let ok = true, waitTicks = 0, t0 = -1, firstWait = 0;
    const tStart = s.tick();
    for (let i = 0; i < plan.length && level(s, 'Firemaking') < 99; i++) {
        const p = plan[i]!;
        const tw = s.tick();
        const visible = () => ground(s).some(g => g.id === p.id && g.x === p.x && g.z === p.z);
        while (!visible() && s.tick() - tw < 150) await tick(s);
        if (!visible()) { console.log(`WARN log ${i} at ${p.x},${p.z} never showed (dropped=${dropped}) me=${JSON.stringify(pos(s))} near=${JSON.stringify(ground(s).filter(g => Math.abs(g.x - p.x) <= 4 && Math.abs(g.z - p.z) <= 2).map(g => [g.id, g.x, g.z]))} helperSees=${JSON.stringify(ground(h).filter(g => Math.abs(g.x - p.x) <= 4 && Math.abs(g.z - p.z) <= 2).map(g => [g.id, g.x, g.z]))} locs=${JSON.stringify(((s.sdk.getState() as any)?.nearbyLocs ?? []).filter((l: any) => Math.abs(l.x - p.x) <= 2 && Math.abs(l.z - p.z) <= 1).map((l: any) => [l.name, l.x, l.z]))}`); ok = false; break; }
        if (t0 < 0) { t0 = s.tick(); firstWait = t0 - tStart; m.t0 = t0; } else waitTicks += s.tick() - tw;
        const before = xp(s, 'Firemaking');
        if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
        await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
        const t1 = s.tick();
        while (xp(s, 'Firemaking') === before && s.tick() - t1 < 80) {
            await tick(s);
            // A page or a lost click: close and click again while the log is still there.
            if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
            if ((s.tick() - t1) % 6 === 0 && visible()) await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
        }
        if (xp(s, 'Firemaking') === before) { console.log(`WARN log ${i} at ${p.x},${p.z} not lit`); ok = false; break; }
        lit++;
        band(m, p.band, xp(s, 'Firemaking') - before, s.tick() - t1, 1);
        m.actions++;
        if (i % 27 === 26) console.log(`CYCLE ${Math.floor(i / 27) + 1} lit=${lit} level=${level(s, 'Firemaking')} t=${s.tick() - t0} age=${s.tick() - (dropAt[i] ?? s.tick())}`);
    }
    helperStop = true;
    await Promise.race([helperLoop, tick(s, 5)]);
    const line = report(s, m, `lit=${lit} dropped=${dropped} waitTicks=${waitTicks} firstWait=${firstWait} ticksPerLog=${((s.tick() - t0) / Math.max(1, lit)).toFixed(2)}`);
    await finish([s, h], ok && level(s, 'Firemaking') >= 99, line);
} catch (e) { await finish([s, h], false, String(e)); }
