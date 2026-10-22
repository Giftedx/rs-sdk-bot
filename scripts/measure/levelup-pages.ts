// Counts the level-up dialog pages one pack of 27 dragonstone cuts leaves, and the ticks to clear them,
// clicking continue once per tick. Prints PAGES <clicks> <ticks> <levels gained>.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitUntil, waitTicks } from '../../packages/core/src/ticks';

const s = await openBot(process.argv[2]!);
try {
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 20 });
    const inv = () => s.sdk.getState()?.inventory ?? [];
    const uncut = () => inv().filter(i => /^uncut /i.test(i.name));
    const lvl0 = s.sdk.getSkill('Crafting')?.baseLevel ?? 0;
    const chisel = inv().find(i => /^chisel$/i.test(i.name))!;
    for (const g of uncut()) void s.sdk.sendUseItemOnItem(chisel.slot, g.slot);
    await waitUntil(s, () => uncut().length === 0, { timeoutTicks: 60 });
    const t0 = s.tick();
    if (process.argv[3] === "walk") {
        // Try clearing the queued pages by walking one tile, then count what is left.
        const p = s.sdk.getState()!.player!;
        await s.bot.walkTo(p.worldX + 1, p.worldZ, 0);
        console.log(`AFTERWALK dialogOpen=${!!s.sdk.getState()?.dialog?.isOpen} ticks=${s.tick() - t0}`);
    }
    let clicks = 0;
    while (s.sdk.getState()?.dialog?.isOpen && clicks < 120) {
        const d = s.sdk.getState()!.dialog!;
        await s.sdk.sendClickDialog((d as any).options?.[0]?.index ?? 0);
        clicks++;
        await waitTicks(s, 1);
    }
    const lvl1 = s.sdk.getSkill('Crafting')?.baseLevel ?? 0;
    console.log(`PAGES ${clicks} ${s.tick() - t0} ${lvl1 - lvl0}`);
    await finish([s], !s.sdk.getState()?.dialog?.isOpen, `levels ${lvl0} -> ${lvl1}, ${clicks} continue clicks in ${s.tick() - t0} ticks`);
} catch (e) { await finish([s], false, String(e)); }
