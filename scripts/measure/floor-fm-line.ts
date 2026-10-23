// Firemaking 1 -> 99 on one line from scripts/measure/fm-line-search.ts, with no banking. The firemaker starts on the
// first tile with a tinderbox and the first 27 logs in the pack (logs, oak, willow, maple, 1 yew); helpers <bot>b..
// each hold one 28-log chunk of the rest and drop it one log per tile ahead on the line. The firemaker lights each
// ground log where it lies ([opobj4,_category_22] -> light_logs_ground). The push after a fire (firemaking.rs2
// push_player) moves it one tile west; at a row end it walks to the next row start (the next roll comes 4 ticks after
// the last success, so a short walk should cost nothing).
// A player drop shows to others after 100 ticks (WorldConfig.ts:115 objRevealTicks) and lasts 300
// (drop.rs2: lootdrop_duration * 3 / 2), so helper k starts its chunk when the firemaker is LEAD logs before it.
// Usage (through scripts/measure/fm-line-run.ts): bun scripts/measure/floor-fm-line.ts <bot> <rows> <helpers>
//   rows = "z,sx,ex;z,sx,ex;..." (each row runs west from sx to ex).
// The clock starts at the first input; the helpers' ticks are not on the firemaker's board.
import { openBot, finish } from '../../packages/core/src/bot';
import type { Session } from '../../packages/core/src/inprocess';
import { FIREMAKING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, dialogOpen } from './floor-lib';

export const PACK = 27, CHUNK = 28;
export function planOf(rows: string) {
    const tiles: { x: number; z: number; row: number }[] = [];
    rows.split(';').forEach((r, ri) => { const [z, sx, ex] = r.split(',').map(Number); for (let x = sx!; x >= ex!; x--) tiles.push({ x, z: z!, row: ri }); });
    const logs: { id: number; band: string }[] = [];
    for (const st of ladder(FIREMAKING)) for (let i = 0; i < st.actions; i++) logs.push({ id: objId(Object.keys(st.band.inputs)[0]!), band: st.band.name });
    if (tiles.length < logs.length) throw new Error(`line has ${tiles.length} tiles, need ${logs.length}`);
    return logs.map((l, i) => ({ ...l, ...tiles[i]! }));
}

if (import.meta.main) {
    const [bot, rowsArg, nArg] = process.argv.slice(2);
    const plan = planOf(rowsArg!);
    const nHelpers = Number(nArg ?? Math.ceil((plan.length - PACK) / CHUNK));
    const LEAD = Number(process.env.FM_LEAD ?? 36);
    const FM_EARLY = process.env.FM_EARLY !== '0';
    const s = await openBot(bot!);
    const helpers: Session[] = [];
    const suffix = 'bcdefgh';
    for (let k = 0; k < nHelpers; k++) helpers.push(await openBot(`${bot}${suffix[k]}`).catch(async e => finish([s, ...helpers], false, `helper ${k} login: ${String(e)}`)));
    let stop = false;
    void s.ended.then(() => { stop = true; });
    const pos = (a: Session) => { const p = a.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ }; };
    const ground = (a: Session) => ((a.sdk.getState() as any)?.groundItems ?? []) as any[];
    const msgs = (a: Session) => ((a.sdk.getState() as any)?.gameMessages ?? []).slice(-2).map((g: any) => g.text).join(' | ');
    try {
        await tick(s, 3);
        const m = meter(s, 'Firemaking');
        let lit = 0;
        const dropAt: number[] = [];
        // ---- Helpers: one chunk each, no banking.
        const runHelper = async (h: Session, k: number) => {
            const first = PACK + k * CHUNK;
            const chunk = plan.slice(first, first + CHUNK);
            while (k > 0 && lit < first - LEAD && !stop) await tick(h);
            for (let j = 0; j < chunk.length && !stop; j++) {
                const p = chunk[j]!;
                const t1 = h.tick();
                while ((pos(h).x !== p.x || pos(h).z !== p.z) && h.tick() - t1 < 40 && !stop) {
                    if ((h.tick() - t1) % 4 === 0) await h.direct({ type: 'walkTo', x: p.x, z: p.z, running: true, reason: 'SDK' });
                    await tick(h);
                }
                const it = inv(h).find(i => i.id === p.id);
                if (!it) { console.log(`WARN helper ${k} lacks log ${p.id}`); return; }
                const n0 = inv(h).length;
                await h.direct({ type: 'dropItem', slot: it.slot, reason: 'SDK' });
                const td = h.tick();
                while (inv(h).length >= n0 && h.tick() - td < 6 && !stop) await tick(h);
                dropAt[first + j] = s.tick();
            }
            // Step off the line (north, then south) so the helper never stands on a later tile.
            const e = pos(h);
            await h.direct({ type: 'walkTo', x: e.x, z: e.z + 2, running: true, reason: 'SDK' });
        };
        const hloops = helpers.map((h, k) => runHelper(h, k).catch(e => { if (!stop) console.log(`WARN helper ${k}: ${String(e)}`); }));

        // ---- Firemaker.
        await tick(s, 10); // off the clock: in a real run the firemaker logs in when the first chunk is down
        const tinder = inv(s).find(i => i.id === objId('tinderbox'));
        if (!tinder) await finish([s, ...helpers], false, 'no tinderbox');
        let ok = true, waitTicks = 0, walkTicks = 0, fails = 0;
        const rowTicks: number[] = [];
        const tRow: number[] = [];
        let worst = 0, extra45 = 0;
        const turnDt: number[] = [];
        for (let i = 0; i < plan.length && level(s, 'Firemaking') < 99 && ok; i++) {
            const p = plan[i]!;
            if (i === 0 || plan[i - 1]!.row !== p.row) tRow[p.row] = s.tick();
            const before = xp(s, 'Firemaking'), lvl0 = level(s, 'Firemaking');
            let early = false;
            const tl = s.tick();
            if (i < PACK) {
                // Pack log: the fire is lit on the player's tile, so walk there first at a row change.
                const me = pos(s);
                if (me.x !== p.x || me.z !== p.z) {
                    const tw = s.tick();
                    await send(s, m, { type: 'walkTo', x: p.x, z: p.z, running: true });
                    while ((pos(s).x !== p.x || pos(s).z !== p.z) && s.tick() - tw < 20) await tick(s);
                    walkTicks += s.tick() - tw;
                }
                const logIt = inv(s).find(x => x.id === p.id);
                if (!logIt) { console.log(`WARN no pack log ${p.id} at job ${i}`); ok = false; break; }
                if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                await send(s, m, { type: 'useItemOnItem', sourceSlot: tinder!.slot, targetSlot: logIt.slot });
                if (i === 0) m.t0 = tl;
                while (xp(s, 'Firemaking') === before && s.tick() - tl < 120) {
                    await tick(s);
                    if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                    if (/can't light a fire here/i.test(msgs(s))) { console.log(`WARN can't light at ${p.x},${p.z} job ${i}`); ok = false; break; }
                    // A modal can swallow the op: resend if the log is still in the pack after 6 ticks.
                    if ((s.tick() - tl) % 6 === 0 && inv(s).some(x => x.slot === logIt.slot && x.id === p.id)) await send(s, m, { type: 'useItemOnItem', sourceSlot: tinder!.slot, targetSlot: logIt.slot });
                }
            } else {
                const visible = () => ground(s).some(g => g.id === p.id && g.x === p.x && g.z === p.z);
                const tw = s.tick();
                while (!visible() && s.tick() - tw < 300) await tick(s);
                if (!visible()) { console.log(`WARN log ${i} at ${p.x},${p.z} never showed (dropped ${dropAt[i] !== undefined}) me=${JSON.stringify(pos(s))}`); ok = false; break; }
                waitTicks += s.tick() - tw;
                if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
                // Success = the log leaves the ground (obj_del in firemaking_success). The push (a teleport) shows one
                // tick before that, so at a row end the next op goes out as soon as the player leaves the tile.
                const turnNext = plan[i + 1] && plan[i + 1]!.row !== p.row;
                let onTile = false;
                while (visible() && s.tick() - tl < 120) {
                    await tick(s);
                    const me = pos(s);
                    if (me.x === p.x && me.z === p.z) onTile = true;
                    else if (onTile && turnNext && FM_EARLY) { early = true; break; }
                    if (process.env.FM_TRACE === '1' && (plan[i - 1]!.row !== p.row || (i >= 30 && i <= 31))) console.log(`NOTE trace job ${i} dt=${s.tick() - tl} me=${JSON.stringify(pos(s))} run=${(s.sdk.getState() as any)?.player?.runEnergy ?? '?'} msgs=${msgs(s)}`);
                    if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                    if (/can't light a fire here/i.test(msgs(s))) { console.log(`WARN can't light at ${p.x},${p.z} job ${i}`); ok = false; break; }
                    if ((s.tick() - tl) % 6 === 0 && visible()) await send(s, m, { type: 'interactGroundItem', x: p.x, z: p.z, itemId: p.id, optionIndex: 4 });
                }
            }
            if (!ok) break;
            if (i < PACK ? xp(s, 'Firemaking') === before : (!early && ground(s).some(g => g.id === p.id && g.x === p.x && g.z === p.z))) { console.log(`WARN log ${i} at ${p.x},${p.z} not lit me=${JSON.stringify(pos(s))} msgs=${msgs(s)}`); ok = false; break; }
            const dt = s.tick() - tl;
            worst = Math.max(worst, dt);
            // At level 45+ every roll succeeds (stat_random(64, 512)), so a log over 4 ticks is overhead, not a fail.
            if (lvl0 >= 45) extra45 += dt - 4;
            if (i > 0 && plan[i - 1]!.row !== p.row) turnDt.push(dt);
            if (dt > 5) fails += Math.floor((dt - 1) / 4);
            lit++;
            band(m, p.band, xp(s, 'Firemaking') - before, dt, 1);
            m.actions++;
            const next = plan[i + 1];
            if (!next || next.row !== p.row) {
                rowTicks[p.row] = s.tick() - tRow[p.row]!;
                console.log(`CYCLE row ${p.row} z=${p.z} logs=${plan.filter(q => q.row === p.row).length} lit=${lit} level=${level(s, 'Firemaking')} rowTicks=${rowTicks[p.row]} t=${s.tick() - m.t0} me=${JSON.stringify(pos(s))}${dropAt[i] !== undefined ? ` dropAge=${s.tick() - dropAt[i]!}` : ''}`);
            }
            if (i > 0 && i < plan.length - 1 && plan[i + 1]!.row !== p.row) console.log(`NOTE turn after job ${i}: next log at ${next!.x},${next!.z}`);
        }
        stop = true;
        const line = report(s, m, `lit=${lit} waitTicks=${waitTicks} walkTicks=${walkTicks} failRetriesEst=${fails} worstLogTicks=${worst} extraAt45=${extra45} turnLogTicks=${turnDt.join('/') || '-'} ticksPerLog=${((s.tick() - m.t0) / Math.max(1, lit)).toFixed(2)} rows=${rowTicks.join('/')}`);
        await Promise.race([Promise.all(hloops), tick(s, 3).catch(() => {})]);
        await finish([s, ...helpers], ok && level(s, 'Firemaking') >= 99, line);
    } catch (e) { stop = true; await finish([s, ...helpers], false, String(e)); }
}
