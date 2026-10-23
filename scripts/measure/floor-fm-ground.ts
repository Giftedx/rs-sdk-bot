// Firemaking from logs on the ground: a helper drops one log per tile along a row, and the firemaker lights each one
// where it lies ([opobj4,_category_22] -> light_logs_ground, firemaking.rs2:1-60). The firemaker carries only a
// tinderbox, so it never banks. A dropped obj shows to other players only after objRevealTicks (100,
// engine/util/WorldConfig.ts:115) and is gone after ^lootdrop_duration (200, lootdrop.constant:1).
// Presets: firemaker floor_fmg (tinderbox at the row start), helper <bot>b floor_fmg_helper (logs in the pack).
// Usage: FLOOR_HELPER=floor_fmg_helper bun scripts/measure/floor-run.ts scripts/measure/floor-fm-ground.ts floor_fmg 1 [x=3099] [z=3249]
// The firemaker's clock starts at its first light; the helper's drop walk and the reveal wait are offline time in a
// real run (the firemaker logs in after the reveal).
import { openBot, finish } from '../../packages/core/src/bot';
import { meter, send, tick, xp, level, inv, report, band, dialogOpen } from './floor-lib';

const [bot, xArg, zArg] = process.argv.slice(2);
const X = Number(xArg ?? 3098), Z = Number(zArg ?? 3248);
const s = await openBot(bot!);
const h = await openBot(`${bot}b`).catch(async e => finish([s], false, `helper login: ${String(e)}`));
try {
    await tick(s, 3);
    const m = meter(s, 'Firemaking');
    const hm = meter(h, 'Firemaking');
    const pos = (a: typeof s) => { const p = a.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
    // Helper: drop a log, step one tile west, repeat.
    const logIds = new Set(inv(h).filter(i => /logs$/i.test(i.name)).map(i => i.id));
    let dropped = 0;
    const td = h.tick();
    while (inv(h).some(i => logIds.has(i.id)) && h.tick() - td < 200) {
        const it = inv(h).find(i => logIds.has(i.id))!;
        const p = pos(h);
        await send(h, hm, { type: 'dropItem', slot: it.slot });
        await tick(h);
        dropped++;
        const wr: any = await h.direct({ type: 'walkTo', x: p.x - 1, z: p.z, running: false, reason: 'SDK' });
        if (dropped <= 2) console.log(`NOTE helper walk ${JSON.stringify(wr)}`);
        for (let k = 0; k < 4 && pos(h).x === p.x; k++) await tick(h);
    }
    // The helper steps off the row so it does not block the pushes.
    await send(h, hm, { type: 'walkTo', x: X, z: Z + 3 });
    console.log(`NOTE helper dropped ${dropped} logs in ${h.tick() - td} ticks, ends at ${JSON.stringify(pos(h))}`);
    // Wait for the reveal (not on the firemaker's board in a real run).
    const tr = s.tick();
    const groundLogs = () => ((s.sdk.getState() as any)?.groundItems ?? []).filter((g: any) => logIds.has(g.id));
    while (groundLogs().length < dropped && s.tick() - tr < 160) await tick(s);
    console.log(`NOTE ${groundLogs().length} logs visible to the firemaker after ${s.tick() - tr} more ticks`);
    // Firemaker: walk to the first log, then light the log under or next to the player, west first.
    const first = groundLogs().sort((a: any, b: any) => b.x - a.x)[0];
    if (!first) await finish([s, h], false, 'no logs visible');
    await send(s, m, { type: 'walkTo', x: first.x, z: first.z });
    for (let k = 0; k < 30 && (pos(s).x !== first.x || pos(s).z !== first.z); k++) await tick(s);
    const t0 = s.tick(), x0 = xp(s, 'Firemaking');
    let lit = 0, stall = 0;
    while (stall < 40) {
        const p = pos(s);
        const g = groundLogs().filter((o: any) => o.z === p.z && o.x <= p.x).sort((a: any, b: any) => b.x - a.x)[0];
        if (!g) break;
        const before = xp(s, 'Firemaking');
        if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
        await send(s, m, { type: 'interactGroundItem', x: g.x, z: g.z, itemId: g.id, optionIndex: 4 });
        const t1 = s.tick();
        while (xp(s, 'Firemaking') === before && s.tick() - t1 < 60) {
            await tick(s);
            if ((s.tick() - t1) % 8 === 0 && groundLogs().some((o: any) => o.x === g.x && o.z === g.z)) await send(s, m, { type: 'interactGroundItem', x: g.x, z: g.z, itemId: g.id, optionIndex: 4 });
        }
        if (xp(s, 'Firemaking') === before) { stall = 99; console.log(`WARN log at ${g.x},${g.z} not lit`); break; }
        lit++;
        band(m, 'ground logs', xp(s, 'Firemaking') - before, s.tick() - t1, 1);
        m.actions++;
    }
    const ticks = s.tick() - t0;
    const line = report(s, m, `lit=${lit} dropped=${dropped} burnTicks=${ticks} ticksPerLog=${(ticks / Math.max(1, lit)).toFixed(2)} xpGain=${xp(s, 'Firemaking') - x0}`);
    await finish([s, h], lit === dropped && lit > 0, line);
} catch (e) { await finish([s, h], false, String(e)); }
