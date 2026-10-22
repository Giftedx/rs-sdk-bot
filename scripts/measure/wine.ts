// Batch XP test: use grapes on a jug of water once (starts the 20-tick fermenting_wine timer), then wait.
// When the timer fires, every unfermented wine in the bank ferments (wine.rs2). Prints RATE cooking <xp> <ticks>.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from "../../packages/core/src/ticks";

const s = await openBot(process.argv[2]!);
try {
    const xp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    const lvl = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 0;
    // The inventory can arrive a tick after login; wait for it rather than read an empty pack.
    await waitUntil(s, st => (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 20 });
    const inv = s.sdk.getState()?.inventory ?? [];
    const grapes = inv.find(i => /^grapes$/i.test(i.name));
    const jug = inv.find(i => /^jug of water$/i.test(i.name));
    if (!grapes || !jug) await finish([s], false, `missing grapes or jug: ${inv.map(i => i.name).join(',')}`);
    const xp0 = xp();
    const lvl0 = lvl();
    const t0 = s.tick();
    await s.sdk.sendUseItemOnItem(grapes!.slot, jug!.slot);
    await waitTicks(s, 25);
    const gained = xp() - xp0;
    console.log(`RATE cooking ${gained} ${s.tick() - t0}`);
    await finish([s], gained > 0, `cooking ${lvl0} -> ${lvl()}, xp +${gained} in ${s.tick() - t0} ticks`);
} catch (e) { await finish([s], false, String(e)); }
