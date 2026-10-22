// Measures item-on-item throughput: chisel on every uncut gem in the pack, sent as fast as the client allows.
// The engine runs up to 5 USER_EVENT packets per tick (ClientGameProtCategory.ts:5-8) and uncut_gem.rs2 has no
// p_delay, so the expected best is ~5 gems per tick. Prints RATE crafting <xp> <ticks> and GEMS <cut> <ticks>.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitUntil } from '../../packages/core/src/ticks';

const s = await openBot(process.argv[2]!);
try {
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 20 });
    const inv = () => s.sdk.getState()?.inventory ?? [];
    const chisel = inv().find(i => /^chisel$/i.test(i.name));
    const uncut = () => inv().filter(i => /^uncut /i.test(i.name));
    if (!chisel) await finish([s], false, 'no chisel');
    const n0 = uncut().length;
    const xp0 = s.sdk.getSkillXp('Crafting') ?? 0;
    const t0 = s.tick();
    // Send every cut without waiting for the previous one; the server caps how many run per tick.
    for (const g of uncut()) void s.sdk.sendUseItemOnItem(chisel!.slot, g.slot);
    await waitUntil(s, () => uncut().length === 0, { timeoutTicks: 60 });
    const ticks = s.tick() - t0;
    const cut = n0 - uncut().length;
    const gained = (s.sdk.getSkillXp('Crafting') ?? 0) - xp0;
    console.log(`GEMS ${cut} ${ticks}`);
    console.log(`RATE crafting ${gained} ${ticks}`);
    await finish([s], cut === n0 && gained > 0, `cut ${cut}/${n0} gems in ${ticks} ticks, xp +${gained}`);
} catch (e) { await finish([s], false, String(e)); }
