// Magic 7 -> 99 floor: enchant jewellery at Draynor bank (preset floor_magic). enchant.rs2: XP on the cast tick,
// then p_delay(1), so the next cast is accepted 3 ticks later. Magic 1-7 has no supply-only spell (ESTIMATE).
// Usage: bun scripts/measure/floor-magic.ts <bot> [mode=every|three] [maxCasts=0]
//   every: one cast input per tick (inputs in the delay are dropped); three: one cast every 3 ticks;
//   burst: 3 cast inputs per tick on 3 different items (only the first is taken; the rest are dropped by the delay).
// Runes stay in the pack as stacks; jewellery comes from the bank (withdraw-All fills the free slots).
import { openBot, finish } from '../../packages/core/src/bot';
import { MAGIC, ladder, objId } from './floor-bands';
import { componentId } from '../../packages/core/src/logout';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, openBank, bankOpen, bankItems, withdrawN, dialogOpen } from './floor-lib';

const [bot, modeArg, maxArg] = process.argv.slice(2);
const mode = modeArg ?? 'every';
const maxCasts = Number(maxArg ?? 0);
const SPELL: Record<string, string> = {
    'enchant 1 sapphire ring': 'magic:enchant_lvl1', 'enchant 2 emerald ring': 'magic:enchant_lvl2', 'enchant 3 ruby ring': 'magic:enchant_lvl3',
    'enchant 4 diamond ring': 'magic:enchant_lvl4', 'enchant 5 dragonstone amulet': 'magic:enchant_lvl5',
};
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Magic');
    const jobs: { item: number; spell: number; band: string; xp: number }[] = [];
    for (const st of ladder(MAGIC, Math.max(7, level(s, 'Magic')))) {
        const item = objId(Object.keys(st.band.inputs)[0]!);
        for (let i = 0; i < st.actions; i++) jobs.push({ item, spell: componentId(SPELL[st.band.name]!), band: st.band.name, xp: st.band.xp });
    }
    if (maxCasts) jobs.length = Math.min(jobs.length, maxCasts);
    const runeIds = new Set(['cosmicrune', 'waterrune', 'airrune', 'firerune', 'earthrune'].map(objId));
    let i = 0, cycle = 0, ok = true, castTicks = 0, dropped = 0;
    while (i < jobs.length && ok) {
        const tc = s.tick();
        await clearDialogs(s, m, 'close');
        const tb = s.tick();
        if (await openBank(s, m) < 0) { console.log('WARN bank did not open'); ok = false; break; }
        const seen = new Set<number>();
        for (const it of inv(s)) if (!runeIds.has(it.id) && !seen.has(it.id)) { seen.add(it.id); await send(s, m, { type: 'bankDeposit', slot: it.slot, amount: -1 }); }
        const free = 28 - inv(s).filter(x => runeIds.has(x.id)).length;
        const n = Math.min(free, jobs.length - i);
        const need = new Map<number, number>();
        for (const j of jobs.slice(i, i + n)) need.set(j.item, (need.get(j.item) ?? 0) + 1);
        for (const [id, c] of need) {
            let b = bankItems(s).find(x => x.id === id);
            // The bank list can lag the interface by a tick: look again before giving up.
            for (let r = 0; r < 3 && (!b || b.count < c); r++) { await tick(s); b = bankItems(s).find(x => x.id === id); }
            if (!b || b.count < c) { console.log(`WARN bank short of ${id}: have ${b?.count ?? 0} need ${c}; bank=${bankItems(s).map(x => x.id + ':' + x.count).join(',')}`); ok = false; break; }
            if (need.size === 1 && c === free && b.count > c) await send(s, m, { type: 'bankWithdraw', slot: b.slot, amount: -1 });
            else await withdrawN(s, m, b.slot, c);
        }
        await send(s, m, { type: 'closeModal' });
        while ((bankOpen(s) || [...need].some(([id, c]) => inv(s).filter(x => x.id === id).length < c)) && s.tick() - tb < 30) await tick(s);
        m.bankTicks += s.tick() - tb; m.bankCycles++;
        // Cast.
        const tp = s.tick();
        let k = i, w = 0, stall = 0;
        while (k < i + n && stall < 12) {
            const j = jobs[k]!;
            const target = inv(s).find(x => x.id === j.item);
            if (!target) break;
            const x0 = xp(s, 'Magic');
            if (mode === 'every' || w % 3 === 0) {
                if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                // burst: also cast on the next 2 items in the same tick; the first cast delays the player, so the server drops
                // the rest, but a cast that the server takes one tick early is not lost.
                const targets = mode === 'burst' ? inv(s).filter(x => x.id === j.item).slice(0, 3) : [target];
                for (const tg of targets) await send(s, m, { type: 'spellOnItem', slot: tg.slot, spellComponent: j.spell });
            }
            w++;
            await tick(s);
            const g = xp(s, 'Magic') - x0;
            if (g > 0) {
                const landed = Math.max(1, Math.round(g / (j.xp * 25)));
                for (let q = 0; q < landed && k < i + n; q++, k++) band(m, jobs[k]!.band, jobs[k]!.xp * 25, 0, 1);
                m.actions += landed; stall = 0;
            } else { stall++; if (mode === 'every') dropped++; }
        }
        castTicks += s.tick() - tp;
        const cycT = s.tick() - tc;
        const bands = new Map<string, number>();
        for (const j of jobs.slice(i, k)) bands.set(j.band, (bands.get(j.band) ?? 0) + 1);
        for (const [b, c] of bands) band(m, b, 0, cycT * c / Math.max(1, k - i), 0);
        cycle++;
        console.log(`CYCLE ${cycle} casts=${k - i} level=${level(s, 'Magic')} clear=${tb - tc} bank=${tp - tb} cast=${s.tick() - tp} total=${cycT}`);
        if (k === i) { console.log('WARN no cast landed'); ok = false; }
        i = k;
    }
    const line = report(s, m, `mode=${mode} castTicks=${castTicks} ticksPerCast=${(castTicks / Math.max(1, m.actions)).toFixed(2)} droppedInputs=${dropped}`);
    await finish([s], ok && (maxCasts > 0 || level(s, 'Magic') >= 99), line);
} catch (e) { await finish([s], false, String(e)); }
