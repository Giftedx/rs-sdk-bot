// Firemaking 1 -> 99 floor: burn logs in lines next to a bank (preset floor_firemaking, Draynor bank).
// firemaking.rs2:98-116: the first attempt rolls 3 ticks later, every later roll 4 ticks after the last success or
// failure, success = stat_random(64, 512). The push after a success (p_delay(0)) moves the player west, east, south
// or north. Cycle: clear level-up pages, booth, withdraw logs, close, walk to a line start, then per log: tinderbox
// on log, wait for the XP. Usage: bun scripts/measure/floor-firemaking.ts <bot> [x=3099] [z=3249] [maxLogs=0]
import { openBot, finish } from '../../packages/core/src/bot';
import { FIREMAKING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, openBank, bankOpen, bankItems, withdrawN, dialogOpen, nearestLoc } from './floor-lib';

const [bot, xArg, zArg, maxArg] = process.argv.slice(2);
const X = Number(xArg ?? 3099), Z = Number(zArg ?? 3249);
const maxLogs = Number(maxArg ?? 0);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Firemaking');
    const jobs: { log: number; band: string; xp: number }[] = [];
    // A failed roll keeps the log and rolls again 4 ticks later, so every log gives its full XP: fails cost ticks only.
    for (const st of ladder(FIREMAKING, Math.max(1, level(s, 'Firemaking')))) {
        const log = objId(Object.keys(st.band.inputs)[0]!);
        for (let i = 0; i < st.actions; i++) jobs.push({ log, band: st.band.name, xp: st.band.xp });
    }
    if (maxLogs) jobs.length = Math.min(jobs.length, maxLogs);
    const tinder = objId('tinderbox');
    let i = 0, cycle = 0, ok = true, burnTicks = 0, walkTicks = 0, fails = 0;
    while (i < jobs.length && ok && level(s, 'Firemaking') < 99) {
        const tc = s.tick();
        await clearDialogs(s, m, 'close');
        const tb = s.tick();
        // The line ends about 27 tiles west of the start, out of sight of the booth: run back first.
        if (!nearestLoc(s, /bank booth/i, /use-quickly/i)) {
            await send(s, m, { type: 'walkTo', x: 3092, z: 3246 });
            while (!nearestLoc(s, /bank booth/i, /use-quickly/i) && s.tick() - tb < 40) await tick(s);
        }
        if (await openBank(s, m) < 0) { console.log('WARN bank did not open'); ok = false; break; }
        const n = Math.min(27, jobs.length - i);
        const need = new Map<number, number>();
        for (const j of jobs.slice(i, i + n)) need.set(j.log, (need.get(j.log) ?? 0) + 1);
        for (const [id, c] of need) {
            let b = bankItems(s).find(x => x.id === id);
            // The bank list can lag the interface by a tick: look again before giving up.
            for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(s); b = bankItems(s).find(x => x.id === id); }
            if (!b || b.count < c) { console.log(`WARN bank short of ${id}: have ${b?.count ?? 0} need ${c}`); ok = false; break; }
            if (need.size === 1 && c === 27 && b.count > c) await send(s, m, { type: 'bankWithdraw', slot: b.slot, amount: -1 });
            else await withdrawN(s, m, b.slot, c);
        }
        await send(s, m, { type: 'closeModal' });
        while ((bankOpen(s) || [...need].some(([id, c]) => inv(s).filter(x => x.id === id).length < c)) && s.tick() - tb < 30) await tick(s);
        m.bankTicks += s.tick() - tb; m.bankCycles++;
        // Walk to the line start; lines rotate over 3 rows so old fires do not block the next line.
        const tw = s.tick();
        let lastPos = -1;
        const lz = Z + (cycle % 3);
        await send(s, m, { type: 'walkTo', x: X, z: lz });
        while (s.tick() - tw < 40) {
            const p = s.sdk.getState()!.player!;
            if (Math.max(Math.abs(p.worldX - X), Math.abs(p.worldZ - lz)) <= 1 || (s.tick() - tw > 3 && !(p as any).isMoving && lastPos === p.worldX * 1e5 + p.worldZ)) break;
            lastPos = p.worldX * 1e5 + p.worldZ;
            await tick(s);
        }
        walkTicks += s.tick() - tw;
        const tp = s.tick();
        let k = i;
        while (k < i + n && ok) {
            const j = jobs[k]!;
            const logIt = inv(s).find(x => x.id === j.log);
            const tbx = inv(s).find(x => x.id === tinder);
            if (!logIt || !tbx) break;
            const x0 = xp(s, 'Firemaking');
            if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
            await send(s, m, { type: 'useItemOnItem', sourceSlot: tbx.slot, targetSlot: logIt.slot });
            const t1 = s.tick();
            let lit = false;
            // A failed roll retries on its own (p_opobj(4)); only resend if the log is still in the pack.
            while (s.tick() - t1 < 120) {
                await tick(s);
                if (xp(s, 'Firemaking') > x0) { lit = true; break; }
                const msgs = ((s.sdk.getState() as any)?.gameMessages ?? []).slice(-1).map((g: any) => g.text).join('');
                if (/can't light a fire here/i.test(msgs) && inv(s).some(x => x.slot === logIt.slot && x.id === j.log)) {
                    const p = s.sdk.getState()!.player!;
                    await send(s, m, { type: 'walkTo', x: p.worldX - 1, z: p.worldZ }); await tick(s, 2);
                    await send(s, m, { type: 'useItemOnItem', sourceSlot: tbx.slot, targetSlot: logIt.slot });
                }
                if (s.tick() - t1 === 6 && inv(s).some(x => x.slot === logIt.slot && x.id === j.log)) await send(s, m, { type: 'useItemOnItem', sourceSlot: tbx.slot, targetSlot: logIt.slot });
            }
            if (!lit) { console.log(`WARN log not lit at job ${k}`); ok = false; break; }
            const dt = s.tick() - t1;
            if (dt > 4) fails += Math.floor((dt - 1) / 4);
            band(m, j.band, xp(s, 'Firemaking') - x0, dt, 1);
            m.actions++; k++;
        }
        burnTicks += s.tick() - tp;
        cycle++;
        console.log(`CYCLE ${cycle} logs=${k - i} level=${level(s, 'Firemaking')} clear=${tb - tc} bank=${tw - tb} walk=${tp - tw} burn=${s.tick() - tp} perLog=${((s.tick() - tp) / Math.max(1, k - i)).toFixed(2)} total=${s.tick() - tc}`);
        i = k;
    }
    const line = report(s, m, `burnTicks=${burnTicks} walkTicks=${walkTicks} ticksPerLog=${(burnTicks / Math.max(1, m.actions)).toFixed(2)} failRetriesEst=${fails}`);
    await finish([s], ok && (maxLogs > 0 || level(s, 'Firemaking') >= 99), line);
} catch (e) { await finish([s], false, String(e)); }
