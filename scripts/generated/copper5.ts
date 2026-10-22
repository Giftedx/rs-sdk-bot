// Mine 5 copper ore. Preset measure_mine (3285,3365,0 SE Varrock mine, bronze pickaxe 1265 in the pack).
// Copper rocks deplete after one ore. Wait ticks for a respawn instead of spending tries on an empty mine.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const MINE = { x: 3285, z: 3365 };
const s = await openBot(process.argv[2]!);
try {
    const xp = () => s.sdk.getSkillXp('Mining') ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    let lastFail = '';
    for (let i = 0; i < 200 && s.tick() - t0 < 600 && countItems(s, /^copper ore$/i) < 5; i++) {
        const rock = s.sdk.findNearbyLoc(/copper ore/i, { withOption: /^mine$/i, reachable: true });
        if (!rock) {
            const p = s.sdk.getState()?.player;
            if (p && Math.max(Math.abs(p.worldX - MINE.x), Math.abs(p.worldZ - MINE.z)) > 6) await s.bot.walkTo(MINE.x, MINE.z, 3);
            else await waitTicks(s, 2);
            continue;
        }
        const r = await s.bot.mineRock(rock);
        if (!r.success) { lastFail = `${r.reason}:${r.message}`; await waitTicks(s, 1); }
    }
    const n = countItems(s, /^copper ore$/i);
    const gained = xp() - xp0;
    const detail = `copper=${n} miningXp=${gained} ticks=${s.tick() - t0}`;
    await finish([s], n >= 5 && gained > 0, n >= 5 ? detail : `${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
