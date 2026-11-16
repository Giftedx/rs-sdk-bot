// Demo-server smoke test (red-team C2): one fresh account, one small task, then a clean in-game logout.
// Run only on purpose: DEMO_OK=1 bun scripts/demo/smoke.ts <bot>. The bot must be made with plain create-bot
// (SERVER=rs-sdk-demo.fly.dev in its bot.env). Hard cap: 400 game ticks for the whole session.
// Prints SMOKE <json> with the measured ticks, so we learn how the live server differs from the practice copy.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { leaveRuneStarter } from '../rune-starter';

const CAP = 400;
const t0wall = Date.now();
const s = await openBot(process.argv[2]!);
const t0 = s.tick();
const left = () => CAP - (s.tick() - t0);
try {
    await leaveRuneStarter(s,()=>left()<=0);
    const tTut = s.tick() - t0;
    let chops = 0;
    for (let i = 0; i < 6 && chops < 3 && left() > 60; i++) {
        const r = await s.bot.chopTree(/^tree$/i);
        if (r.success) chops++;
    }
    const p = s.sdk.getState()?.player;
    const ticks = s.tick() - t0;
    const msPerTick = (Date.now() - t0wall) / Math.max(1, ticks);
    console.log(`SMOKE ${JSON.stringify({ tutorialOk: true, tutorialTicks: tTut, chops, logs: countItems(s, /^logs$/i), wcXp: s.sdk.getSkillXp('Woodcutting'), sessionTicks: ticks, msPerTickIncludingLogin: Math.round(msPerTick), at: p && [p.worldX, p.worldZ, p.level] })}`);
    await finish([s], chops > 0, `tutorial true in ${tTut} ticks, ${chops} chops, ${ticks} session ticks`);
} catch (e) { await finish([s], false, String(e)); }
