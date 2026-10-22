// Bank-loop throughput at Draynor bank: open bank, deposit cut gems, withdraw 27 uncut, close, cut all.
// Inventory packets are refused under an open bank modal (vendor/rs-sdk/CLAUDE.md), so the bank is closed
// before cutting. Prints CYCLE <n> <ticks> per cycle and RATE crafting <xp> <ticks> for the whole run.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitUntil } from '../../packages/core/src/ticks';

const CYCLES = Number(process.argv[3] ?? 3);
const s = await openBot(process.argv[2]!);
try {
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 20 });
    const inv = () => s.sdk.getState()?.inventory ?? [];
    const uncut = () => inv().filter(i => /^uncut /i.test(i.name));
    const xp0 = s.sdk.getSkillXp('Crafting') ?? 0;
    const tAll = s.tick();
    for (let c = 1; c <= CYCLES; c++) {
        const t0 = s.tick();
        const step: string[] = [];
        let k = s.tick();
        const mark = (n: string) => { step.push(`${n}=${s.tick() - k}`); k = s.tick(); };
        // A level-up dialog after a big XP drop blocks the bank click; close it in one packet first.
        if (s.sdk.getState()?.dialog?.isOpen) { await s.sdk.sendCloseModal(); await waitUntil(s, st => !st?.dialog?.isOpen, { timeoutTicks: 5 }); }
        mark("dismiss");
        const open = await s.bot.openBank();
        mark("open");
        if (!open.success) await finish([s], false, `openBank: ${open.message}`);
        if (inv().some(i => /^dragonstone$/i.test(i.name))) await s.bot.depositItem(/^dragonstone$/i, -1);
        mark("deposit");
        await s.bot.withdrawItem(/^uncut dragonstone$/i, 27);
        mark("withdraw");
        await s.bot.closeBank();
        mark("close");
        const chisel = inv().find(i => /^chisel$/i.test(i.name))!;
        for (const g of uncut()) void s.sdk.sendUseItemOnItem(chisel.slot, g.slot);
        await waitUntil(s, () => uncut().length === 0, { timeoutTicks: 60 });
        mark("cut");
        console.log(`CYCLE ${c} ${s.tick() - t0} ${step.join(" ")}`);
    }
    const gained = (s.sdk.getSkillXp('Crafting') ?? 0) - xp0;
    console.log(`RATE crafting ${gained} ${s.tick() - tAll}`);
    await finish([s], gained > 0, `${CYCLES} cycles in ${s.tick() - tAll} ticks, xp +${gained}`);
} catch (e) { await finish([s], false, String(e)); }
