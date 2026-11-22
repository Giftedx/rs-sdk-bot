// Superheat gold to Smithing 99 at Draynor bank (preset floor_superheat): planner rows superheat and magic-top.
// superheat.rs2: 53 Magic XP per cast, gold bar 22.5 Smithing XP x 2.5 with goldsmith gauntlets worn, then
// p_delay(1), so the next cast is accepted 3 ticks later. Gold needs Smithing 40 (smelting.struct:63), so the
// preset starts at Smithing 40 and Magic 43.
// Usage: bun scripts/measure/floor-superheat.ts <bot> [mode=burst|every|three] [maxCasts=0]
//   burst: 3 cast inputs per tick on 3 different ores (the first is taken; the delay drops the rest).
// Runes (nature, fire) stay in the pack as stacks; 26 gold ores per bank trip.
import { openBot, finish } from '../../packages/core/src/bot';
import { objId } from './floor-bands';
import { componentId } from '../../packages/core/src/logout';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, openBank, bankOpen, bankItems, withdrawN, dialogOpen } from './floor-lib';

const [bot, modeArg, maxArg] = process.argv.slice(2);
const mode = modeArg ?? 'burst';
const maxCasts = Number(maxArg ?? 0);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Smithing');
    const ore = objId('gold_ore'), bar = objId('gold_bar');
    const spell = componentId('magic:superheat_item');
    const runeIds = new Set(['naturerune', 'firerune'].map(objId));
    const mx0 = xp(s, 'Magic');
    let casts = 0, cycle = 0, ok = true, castTicks = 0;
    const more = () => level(s, 'Smithing') < 99 && (!maxCasts || casts < maxCasts);
    while (more() && ok) {
        const tc = s.tick();
        await clearDialogs(s, m, 'close');
        const tb = s.tick();
        if (await openBank(s, m) < 0) { console.log('WARN bank did not open'); ok = false; break; }
        if (inv(s).some(x => x.id === bar)) {
            const b = inv(s).find(x => x.id === bar)!;
            await send(s, m, { type: 'bankDeposit', slot: b.slot, amount: -1 });
        }
        let bo = bankItems(s).find(x => x.id === ore);
        for (let r = 0; r < 3 && !bo; r++) { await tick(s); bo = bankItems(s).find(x => x.id === ore); }
        if (!bo) { console.log('WARN out of gold ore'); ok = false; break; }
        const free = 28 - inv(s).filter(x => runeIds.has(x.id)).length;
        if (bo.count > free) await send(s, m, { type: 'bankWithdraw', slot: bo.slot, amount: -1 });
        else await withdrawN(s, m, bo.slot, bo.count);
        await send(s, m, { type: 'closeModal' });
        while ((bankOpen(s) || !inv(s).some(x => x.id === ore) || inv(s).some(x => x.id === bar)) && s.tick() - tb < 30) await tick(s);
        m.bankTicks += s.tick() - tb; m.bankCycles++;
        const tp = s.tick();
        let w = 0, stall = 0, n = 0;
        while (inv(s).some(x => x.id === ore) && stall < 12 && more()) {
            const x0 = xp(s, 'Smithing');
            if (mode !== 'three' || w % 3 === 0) {
                if (dialogOpen(s)) await send(s, m, { type: 'closeModal' });
                const ores = inv(s).filter(x => x.id === ore).slice(0, mode === 'burst' ? 3 : 1);
                for (const o of ores) await send(s, m, { type: 'spellOnItem', slot: o.slot, spellComponent: spell });
            }
            w++;
            await tick(s);
            const g = xp(s, 'Smithing') - x0;
            if (g > 0) { const k = Math.max(1, Math.round(g / 1406.25)); casts += k; n += k; m.actions += k; stall = 0; } else stall++;
        }
        castTicks += s.tick() - tp;
        band(m, 'superheat gold', 0, s.tick() - tc, 0);
        cycle++;
        console.log(`CYCLE ${cycle} casts=${n} smithing=${level(s, 'Smithing')} magic=${level(s, 'Magic')} clear=${tb - tc} bank=${tp - tb} cast=${s.tick() - tp} total=${s.tick() - tc}`);
        if (n === 0) { console.log('WARN no cast landed'); ok = false; }
    }
    const ticks = s.tick() - m.t0;
    const mxp = xp(s, 'Magic') - mx0;
    const line = report(s, m, `mode=${mode} casts=${casts} castTicks=${castTicks} ticksPerCast=${(ticks / Math.max(1, casts)).toFixed(3)} magicXp=${mxp} magicLevel=${level(s, 'Magic')} magicPerTick=${(mxp / Math.max(1, ticks)).toFixed(1)}`);
    await finish([s], ok && (maxCasts > 0 || level(s, 'Smithing') >= 99), line);
} catch (e) { await finish([s], false, String(e)); }
