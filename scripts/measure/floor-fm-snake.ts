// Firemaking 1 -> 99 with no banking and no walking: the "snake" field at x 3041-3068, z 3290-3295 (north of
// Draynor; fenced on the west and east, found with the rsmod pathfinder walk map). Two helpers drop one log per tile
// along the snake; the firemaker (tinderbox only) lights each log where it lies ([opobj4,_category_22] ->
// light_logs_ground). The push after each fire (firemaking.rs2:145-174: west, then east, south, north) moves the
// player onto the next tile: west along a row, south at the fence, east along the next row, and so on.
// Player drops show to others after 100 ticks (WorldConfig.ts:115) and last 300 (drop.rs2:22).
// Presets: firemaker floor_fms (tinderbox, at the snake start), helpers <bot>b and <bot>c floor_fmr_helper (Draynor
// bank, logs banked). Usage: FLOOR_HELPER=floor_fmr_helper FLOOR_HELPER2=floor_fmr_helper bun scripts/measure/floor-run.ts
// scripts/measure/floor-fm-snake.ts floor_fms 3
// The firemaker's clock starts at its first light (in a real run it logs in when the first logs show).
import { openBot, finish } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { FIREMAKING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, openBank, bankOpen, bankItems, withdrawN, dialogOpen, countId, type Meter } from './floor-lib';

const [bot] = process.argv.slice(2);
const s = await openBot(bot!);
const helpers: Session[] = [];
for (const suf of ['b', 'c']) helpers.push(await openBot(`${bot}${suf}`).catch(async e => finish([s, ...helpers], false, `helper ${suf} login: ${String(e)}`)));
let stop = false;
void s.ended.then(() => { stop = true; });
try {
    await tick(s, 3);
    const m = meter(s, 'Firemaking');
    // Snake path: z 3295 west 3068 -> 3041, z 3294 east 3041 -> 3068, ...
    const path: { x: number; z: number }[] = [];
    for (let r = 0; r < 6; r++) { const z = 3295 - r; for (let i = 0; i < 28; i++) path.push({ x: r % 2 === 0 ? 3068 - i : 3041 + i, z }); }
    const logs: { id: number; band: string }[] = [];
    for (const st of ladder(FIREMAKING)) for (let i = 0; i < st.actions; i++) logs.push({ id: objId(Object.keys(st.band.inputs)[0]!), band: st.band.name });
    const plan = logs.map((l, i) => ({ ...l, ...path[i]! }));
    const pos = (a: Session) => { const p = a.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
    const ground = (a: Session) => ((a.sdk.getState() as any)?.groundItems ?? []) as any[];

    // ---- Helpers: chunks of 28 in turn (helper 0: chunks 0, 2, 4; helper 1: 1, 3, 5).
    let dropped = 0, lit = 0;
    const dropAt: number[] = [];
    const runHelper = async (h: Session, hm: Meter, first: number) => {
        for (let c = first; c * 28 < plan.length && !stop; c += 2) {
            const chunk = plan.slice(c * 28, c * 28 + 28);
            // The field is about 50 tiles from Draynor bank: walk with the SDK path walker (a direct walkTo that far
            // does not move the player), then the booth.
            if (!(h.sdk.getState()?.nearbyLocs ?? []).some((l: any) => /bank booth/i.test(l.name))) await h.bot.walkTo(3092, 3245);
            if (await openBank(h, hm) < 0) { console.log(`WARN helper ${h.name} bank`); return; }
            const need = new Map<number, number>();
            for (const p of chunk) need.set(p.id, (need.get(p.id) ?? 0) + 1);
            for (const [id, n] of need) {
                let b = bankItems(h).find(x => x.id === id);
                for (let r = 0; r < 3 && (!b || b.count < n); r++) { await tick(h); b = bankItems(h).find(x => x.id === id); }
                if (!b || b.count < n) { console.log(`WARN helper bank short of ${id}`); return; }
                await withdrawN(h, hm, b.slot, n);
            }
            await send(h, hm, { type: 'closeModal' });
            const tw = h.tick();
            while ((bankOpen(h) || [...need].some(([id, n]) => countId(h, id) < n)) && h.tick() - tw < 30) await tick(h);
            await h.bot.walkTo(chunk[0]!.x, chunk[0]!.z);
            // Wait for the turn, and stay at most 50 logs ahead of the firemaker (a drop lasts 300 ticks).
            while ((dropped < c * 28 || c * 28 - lit > 50) && !stop) {
                await tick(h);
                if ((h.tick() - tw) % 10 === 0) await h.direct({ type: 'walkTo', x: chunk[0]!.x, z: chunk[0]!.z, reason: 'SDK' });
            }
            for (const p of chunk) {
                if (stop) return;
                while (dropped - lit > 55 && !stop) await tick(h);
                const it = inv(h).find(i => i.id === p.id);
                if (!it) { console.log(`WARN helper lacks log ${p.id}`); return; }
                const t1 = h.tick();
                while ((pos(h).x !== p.x || pos(h).z !== p.z) && h.tick() - t1 < 40 && !stop) {
                    if ((h.tick() - t1) % 4 === 0) await h.direct({ type: 'walkTo', x: p.x, z: p.z, running: false, reason: 'SDK' });
                    await tick(h);
                }
                await tick(h); // the client shows the tile before the server moved there
                const n0 = inv(h).length;
                await send(h, hm, { type: 'dropItem', slot: it.slot });
                const td = h.tick();
                while (inv(h).length >= n0 && h.tick() - td < 6 && !stop) await tick(h);
                if (dropped < 4) console.log(`NOTE drop ${dropped} at ${JSON.stringify(p)} helper=${JSON.stringify(pos(h))} walkTicks=${td - t1} seen=${inv(h).length < n0} ground=${JSON.stringify(ground(h).filter(g => Math.abs(g.x - p.x) <= 2 && Math.abs(g.z - p.z) <= 1).map(g => [g.id, g.x, g.z]))} msgs=${((h.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(" | ")}`);
                dropAt[dropped] = s.tick();
                dropped++;
            }
        }
        await h.bot.walkTo(3055, 3298);
    };
    const hloops = helpers.map((h, i) => runHelper(h, meter(h, 'Firemaking'), i).catch(e => { if (!stop) console.log(`WARN helper loop: ${String(e)}`); }));

    // ---- Firemaker: walk to the start, then light the plan in order.
    await send(s, m, { type: 'walkTo', x: plan[0]!.x, z: plan[0]!.z });
    let ok = true, waitTicks = 0, t0 = -1, firstWait = 0, offPath = 0;
    const tStart = s.tick();
    for (let i = 0; i < plan.length && level(s, 'Firemaking') < 99; i++) {
        const p = plan[i]!;
        const tw = s.tick();
        const visible = () => ground(s).some(g => g.id === p.id && g.x === p.x && g.z === p.z);
        while (!visible() && s.tick() - tw < 400) await tick(s);
        if (!visible()) { console.log(`WARN log ${i} at ${p.x},${p.z} never showed (dropped=${dropped}) me=${JSON.stringify(pos(s))}`); ok = false; break; }
        if (t0 < 0) { t0 = s.tick(); firstWait = t0 - tStart; m.t0 = t0; } else waitTicks += s.tick() - tw;
        const me = pos(s);
        if (me.x !== p.x || me.z !== p.z) offPath++;
        const before = xp(s, 'Firemaking');
        if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
        await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
        const t1 = s.tick();
        while (xp(s, 'Firemaking') === before && s.tick() - t1 < 80) {
            await tick(s);
            if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
            if ((s.tick() - t1) % 6 === 0 && visible()) await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
        }
        if (xp(s, 'Firemaking') === before) { console.log(`WARN log ${i} at ${p.x},${p.z} not lit me=${JSON.stringify(pos(s))} msgs=${((s.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(' | ')}`); ok = false; break; }
        lit++;
        band(m, p.band, xp(s, 'Firemaking') - before, s.tick() - t1, 1);
        m.actions++;
        if (i % 28 === 27) console.log(`CYCLE ${Math.floor(i / 28) + 1} lit=${lit} level=${level(s, 'Firemaking')} t=${s.tick() - t0} offPath=${offPath} wait=${waitTicks} age=${s.tick() - (dropAt[i] ?? s.tick())}`);
    }
    stop = true;
    await Promise.race([Promise.all(hloops), tick(s, 5).catch(() => {})]);
    const line = report(s, m, `lit=${lit} dropped=${dropped} waitTicks=${waitTicks} firstWait=${firstWait} offPath=${offPath} ticksPerLog=${((s.tick() - t0) / Math.max(1, lit)).toFixed(2)}`);
    await finish([s, ...helpers], ok && level(s, 'Firemaking') >= 99, line);
} catch (e) { stop = true; await finish([s, ...helpers], false, String(e)); }
