// Smithing 1 -> 99 floor at Varrock west bank + the smithy anvils (preset floor_smithing).
// Usage: bun scripts/measure/floor-smithing.ts <bot>
// Bands from floor-bands.ts SMITHING (5-bar platebodies from 18). Cycle: clear level-up pages, booth (Use-quickly),
// deposit products, withdraw up to 27 bars, close; use a bar on the anvil (the client walks there), Make 5/10 on the
// smithing interface (smithing.rs2:1-18, smithing_anvil p_delay(1) + p_delay(2) per item), repeat per product.
// Prints CYCLE lines (bank / walk / smith ticks) and the FLOOR line.
import { openBot, finish } from '../../packages/core/src/bot';
import { SMITHING, ladder, objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, clearDialogs, openBank, bankOpen, bankItems, withdrawN, band, nearestLoc, countId, debug, dialogOpen } from './floor-lib';

// smithing interface components (sdk/actions.ts:3780-3822): column, slot.
const PRODUCT: Record<string, [number, number]> = {
    'bronze dagger': [1119, 0], 'bronze sq shield': [1122, 2], 'bronze warhammer': [1120, 2], 'bronze platebody': [1121, 3],
    'iron warhammer': [1120, 2], 'iron platebody': [1121, 3], 'steel platebody': [1121, 3], 'mithril platebody': [1121, 3],
    'adamant platebody': [1121, 3],
};
interface Job { bar: number; bars: number; band: string; xp: number; level: number }

const [bot] = process.argv.slice(2);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Smithing');
    const jobs: Job[] = [];
    for (const st of ladder(SMITHING)) {
        const [bar, bars] = Object.entries(st.band.inputs)[0]!;
        for (let i = 0; i < st.actions; i++) jobs.push({ bar: objId(bar), bars, band: st.band.name, xp: st.band.xp, level: st.band.from });
    }
    const hammer = objId('hammer');
    let i = 0, cycle = 0, walkTicks = 0, smithTicks = 0;
    let ok = true;
    while (i < jobs.length && ok) {
        const tc = s.tick();
        await clearDialogs(s, m, 'close');
        const tb = s.tick();
        if (await openBank(s, m) < 0) { console.log(`WARN bank did not open at job ${i}`); ok = false; break; }
        const seen = new Set<number>();
        for (const it of inv(s)) if (it.id !== hammer && !seen.has(it.id)) { seen.add(it.id); await send(s, m, { type: 'bankDeposit', slot: it.slot, amount: -1 }); }
        // Fill 27 slots with whole jobs of one band.
        let slots = 27, n = 0;
        // One product per trip: Make 5/10 keeps going while any bar of that metal is left (smithing.rs2:287-301).
        while (i + n < jobs.length && jobs[i + n]!.band === jobs[i]!.band && jobs[i + n]!.bars <= slots) { slots -= jobs[i + n]!.bars; n++; }
        const need = new Map<number, number>();
        for (const j of jobs.slice(i, i + n)) need.set(j.bar, (need.get(j.bar) ?? 0) + j.bars);
        for (const [id, c] of need) {
            let b = bankItems(s).find(x => x.id === id);
            // The bank list can lag the interface by a tick: look again before giving up.
            for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(s); b = bankItems(s).find(x => x.id === id); }
            if (!b || b.count < c) { console.log(`WARN bank short of ${id}: have ${b?.count ?? 0} need ${c}; open=${bankOpen(s)} bank=${bankItems(s).map(x => x.id + ':' + x.count).join(',')} inv=${inv(s).map(x => x.id).join(',')}`); ok = false; break; }
            await withdrawN(s, m, b.slot, c);
        }
        await send(s, m, { type: 'closeModal' });
        while (bankOpen(s) || [...need].some(([id, c]) => countId(s, id) < c)) { await tick(s); if (s.tick() - tb > 30) break; }
        const bankT = s.tick() - tb;
        m.bankTicks += bankT; m.bankCycles++;
        // Smith: one interface session per run of equal jobs.
        let k = i;
        let walkT = 0, smithT = 0;
        while (k < i + n) {
            let r = 1;
            while (k + r < i + n && jobs[k + r]!.band === jobs[k]!.band) r++;
            const j = jobs[k]!;
            if (level(s, 'Smithing') < j.level) { console.log(`WARN level ${level(s, 'Smithing')} < ${j.level}`); ok = false; break; }
            const anvil = nearestLoc(s, /^anvil$/i, /.*/) ?? { loc: (s.sdk.getState()?.nearbyLocs ?? []).find((l: any) => /^anvil$/i.test(l.name)) };
            const bar = inv(s).find(x => x.id === j.bar)!;
            if (process.env.FLOOR_DEBUG === '1') console.log(`NOTE use bar slot=${bar.slot} id=${bar.id} anvil=${JSON.stringify(anvil.loc)} inv=${inv(s).map(x => x.slot + ':' + x.id).join(',')}`);
            const tw = s.tick();
            await clearDialogs(s, m, 'close');
            await send(s, m, { type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.loc.x, z: anvil.loc.z, locId: anvil.loc.id });
            const use = { type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.loc.x, z: anvil.loc.z, locId: anvil.loc.id };
            while (!(s.sdk.getState() as any)?.interface?.isOpen && s.tick() - tw < 40) {
                await tick(s); debug(s, 'walk');
                // A queued level-up page cancels the anvil op: close it and use the bar again (counted as level ticks).
                if (dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); await send(s, m, use); m.levelTicks++; }
            }
            walkT += s.tick() - tw;
            const ts = s.tick();
            const [com, slot] = PRODUCT[j.band]!;
            const op = r === 1 ? 1 : r <= 5 ? 2 : 3; // 1, 5 or 10; the loop stops when the bars run out
            const x0 = xp(s, 'Smithing');
            const before = countId(s, j.bar);
            await send(s, m, { type: 'clickComponentWithOption', componentId: com, optionIndex: op, slot });
            const target = before - r * j.bars;
            while (countId(s, j.bar) > target && s.tick() - ts < 80) { await tick(s); debug(s, 'smith'); }
            const made = (before - countId(s, j.bar)) / j.bars;
            smithT += s.tick() - ts;
            band(m, j.band, xp(s, 'Smithing') - x0, s.tick() - ts, made);
            m.actions += made;
            if (made <= 0) { console.log(`WARN nothing smithed for ${j.band}`); ok = false; break; }
            k += made;
        }
        walkTicks += walkT; smithTicks += smithT;
        cycle++;
        console.log(`CYCLE ${cycle} items=${n} level=${level(s, 'Smithing')} clear=${tb - tc} bank=${bankT} walk=${walkT} smith=${smithT} total=${s.tick() - tc}`);
        i += n;
    }
    const line = report(s, m, `walkTicks=${walkTicks} smithTicks=${smithTicks}`);
    await finish([s], ok && level(s, 'Smithing') >= 99, line);
} catch (e) { await finish([s], false, String(e)); }
