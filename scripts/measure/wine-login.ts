// Login wine test: the account only logs in. ~ferment_wines_login (login.rs2:70) sets the 20-tick
// fermenting_wine timer with no level check; when it fires, banked unfermented wines ferment (wine.rs2).
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const s = await openBot(process.argv[2]!);
try {
    const xp = () => s.sdk.getSkillXp('Cooking') ?? 0;
    const lvl = () => s.sdk.getSkill('Cooking')?.baseLevel ?? 0;
    const xp0 = xp(); const lvl0 = lvl(); const t0 = s.tick();
    let reached99 = -1;
    const off = s.onTick(() => { if (reached99 < 0 && lvl() >= 99) reached99 = s.tick(); });
    await waitTicks(s, 30);
    off();
    console.log(`RATE cooking ${xp() - xp0} ${s.tick() - t0}`);
    await finish([s], xp() > xp0, `cooking ${lvl0} -> ${lvl()}, xp +${xp() - xp0}, 99 at session tick ${reached99}`);
} catch (e) { await finish([s], false, String(e)); }
