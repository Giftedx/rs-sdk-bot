// Level-up dialog cost (INDEX C5). Preset gems_dragonstone: Crafting 55, chisel, 27 uncut dragonstones.
// Cuts all 27 (5 per tick, s.direct), then clears the queued level-up pages and reports the ticks.
// Usage: bun scripts/measure/floor-levelup.ts <bot> <mode>
//   close  : CLOSE_MODAL every tick until the dialog stayed shut for 3 ticks (Player.closeModal drops the paused page)
//   click  : one continue click per tick while a page shows (the client allows one resume per page)
//   during : 4 cuts + 1 CLOSE_MODAL per tick while cutting, then 'close'
//   booth  : 'close' at Draynor bank, then click the booth: ticks until the bank opens (needs preset bank_gems)
// Prints LEVELUP mode=<m> levels=<n> cutTicks=<t> clearTicks=<t> perLevel=<x> and one T line per clearing tick.
import { openBot, finish } from '../../packages/core/src/bot';
import { meter, send, tick, level, inv, dialogOpen, openBank, bankOpen } from './floor-lib';

const [bot, mode] = process.argv.slice(2);
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Crafting');
    const chisel = inv(s).find(i => /^chisel$/i.test(i.name))!;
    const l0 = level(s, 'Crafting');
    const t0 = s.tick();
    let sent = new Set<number>();
    const left = () => inv(s).filter(i => /^uncut /i.test(i.name));
    if (mode === 'booth') {
        // bank_gems has no gems in the pack: take 27 first.
        await openBank(s, m);
        const b = (s.sdk.getState() as any).bank.items.find((i: any) => /uncut dragonstone/i.test(i.name));
        for (let k = 0; k < 2; k++) await send(s, m, { type: 'bankWithdraw', slot: b.slot, amount: 10 });
        for (let k = 0; k < 7; k++) await send(s, m, { type: 'bankWithdraw', slot: b.slot, amount: 1 });
        await send(s, m, { type: 'closeModal' });
        while (left().length < 27 || bankOpen(s)) await tick(s);
    }
    const tc = s.tick();
    while (left().length > 0 && s.tick() - tc < 60) {
        let n = 0;
        if (mode === 'during' && dialogOpen(s)) { await send(s, m, { type: 'closeModal' }); n++; }
        for (const g of left()) {
            if (n >= 5) break;
            if (sent.has(g.slot)) continue;
            await send(s, m, { type: 'useItemOnItem', sourceSlot: chisel.slot, targetSlot: g.slot });
            sent.add(g.slot); n++;
        }
        await tick(s);
        if (n === 0) sent = new Set();
    }
    const cutTicks = s.tick() - tc;
    const levels = level(s, 'Crafting') - l0;
    const tl = s.tick();
    let shut = dialogOpen(s) ? 0 : 3;
    while (shut < 3 && s.tick() - tl < 120) {
        if (mode === 'click') { if (dialogOpen(s)) await send(s, m, { type: 'clickDialogOption', optionIndex: 0 }); }
        else await send(s, m, { type: 'closeModal' });
        await tick(s);
        console.log(`T ${s.tick() - tl} dialog=${dialogOpen(s)}`);
        shut = dialogOpen(s) ? 0 : shut + 1;
    }
    const clearTicks = s.tick() - tl - (shut >= 3 ? 3 : 0);
    let boothTicks = -1;
    if (mode === 'booth') boothTicks = await openBank(s, m);
    const line = `LEVELUP mode=${mode} levels=${levels} cutTicks=${cutTicks} clearTicks=${clearTicks} perLevel=${(clearTicks / Math.max(1, levels)).toFixed(2)} boothTicks=${boothTicks} sent=${m.sent}`;
    console.log(line);
    await finish([s], levels > 0, line);
} catch (e) { await finish([s], false, String(e)); }
