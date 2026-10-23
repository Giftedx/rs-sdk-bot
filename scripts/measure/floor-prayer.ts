// Prayer 1 -> 99 floor: bury dragon bones at Draynor bank (preset floor_prayer). bury_bone.rs2: p_delay(0) per
// bone, so the next input is accepted 2 ticks later (tick-tricks-web.md rule 2); bones have no level check.
// Usage: bun scripts/measure/floor-prayer.ts <bot> [mode=every|burst|two] [maxTicks=0]
//   every: one bury input per tick (half are dropped by the delay); burst: 5 per tick; two: one every 2 ticks.
// Cycle: clear level-up pages, booth, withdraw-All bones (fills the pack in 1 input), close, bury 28.
import { openBot, finish } from '../../packages/core/src/bot';
import { objId } from './floor-bands';
import { meter, send, tick, xp, level, inv, report, band, clearDialogs, openBank, bankOpen, bankItems, dialogOpen } from './floor-lib';

const [bot, modeArg, maxArg] = process.argv.slice(2);
const mode = modeArg ?? 'every';
const maxTicks = Number(maxArg ?? 0);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Prayer');
    const bone = objId('dragon_bones');
    let ok = true, cycle = 0, buryTicks = 0;
    while (level(s, 'Prayer') < 99 && ok && (!maxTicks || s.tick() - m.t0 < maxTicks)) {
        const tc = s.tick();
        if (inv(s).filter(i => i.id === bone).length === 0) {
            await clearDialogs(s, m, 'close');
            const tb = s.tick();
            if (await openBank(s, m) < 0) { console.log('WARN bank did not open'); ok = false; break; }
            const b = bankItems(s).find(i => i.id === bone);
            if (!b) { console.log('WARN out of bones'); ok = false; break; }
            await send(s, m, { type: 'bankWithdraw', slot: b.slot, amount: -1 });
            await send(s, m, { type: 'closeModal' });
            while ((bankOpen(s) || !inv(s).some(i => i.id === bone)) && s.tick() - tb < 30) await tick(s);
            m.bankTicks += s.tick() - tb; m.bankCycles++;
        }
        const tp = s.tick(), x0 = xp(s, 'Prayer');
        const n0 = inv(s).filter(i => i.id === bone).length;
        let k = 0, stall = 0;
        while (inv(s).some(i => i.id === bone) && stall < 20 && level(s, 'Prayer') < 99) {
            const bones = inv(s).filter(i => i.id === bone);
            const before = bones.length;
            const per = mode === 'burst' ? 5 : 1;
            if (mode !== 'two' || k % 2 === 0) {
                if (dialogOpen(s) && process.env.FLOOR_CLOSE_WHILE !== '0') await send(s, m, { type: 'closeModal' });
                for (const b of bones.slice(0, per)) await send(s, m, { type: 'useInventoryItem', slot: b.slot, optionIndex: 1 });
            }
            k++;
            await tick(s);
            stall = inv(s).filter(i => i.id === bone).length < before ? 0 : stall + 1;
        }
        const buried = n0 - inv(s).filter(i => i.id === bone).length;
        buryTicks += s.tick() - tp;
        band(m, 'dragon bones', xp(s, 'Prayer') - x0, s.tick() - tc, buried);
        m.actions += buried;
        cycle++;
        console.log(`CYCLE ${cycle} buried=${buried} level=${level(s, 'Prayer')} bury=${s.tick() - tp} total=${s.tick() - tc}`);
        if (buried === 0) { console.log('WARN no bone buried'); ok = false; }
    }
    const line = report(s, m, `mode=${mode} buryTicks=${buryTicks}`);
    await finish([s], ok && (maxTicks > 0 || level(s, 'Prayer') >= 99), line);
} catch (e) { await finish([s], false, String(e)); }
