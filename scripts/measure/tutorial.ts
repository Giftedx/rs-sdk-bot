// Ticks a brand-new account spends in the tutorial before it can play (all of it is scored playtime).
import { openBot, finish } from "../../packages/core/src/bot";
import { waitUntil } from "../../packages/core/src/ticks";

const s = await openBot(process.argv[2]!);
try {
    const t0 = s.tick();
    // NPCs arrive a tick or more after login; those ticks are scored too, so they are counted.
    await waitUntil(s, st => (st?.nearbyNpcs?.length ?? 0) > 0, { timeoutTicks: 20 });
    const r = await s.bot.skipTutorial();
    const p = s.sdk.getState()?.player;
    console.log(`TUTORIAL ${s.tick() - t0} ticks, ended at ${p?.worldX},${p?.worldZ},${p?.level}`);
    await finish([s], r.success, `skipTutorial ${r.success} ${r.message ?? ''} in ${s.tick() - t0} ticks`);
} catch (e) { await finish([s], false, String(e)); }
