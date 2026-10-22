// Proven script 3: Lumbridge castle courtyard (3222,3218,0) to the top floor and back, through the world graph.
// Top-floor arrival (3205,3209,2) is spiralstairsmiddle op2's destination in knowledge/transports.json.
import { openBot, finish, getWorld, accountOf } from '../../packages/core/src/bot';
import { goTo } from '../../packages/core/src/walk';

const s = await openBot(process.argv[2]!);
try {
    const world = await getWorld();
    const up = await goTo(s as any, world, { x: 3205, z: 3209, level: 2 }, accountOf(s));
    const lvlTop = s.sdk.getState()?.player?.level;
    if (!up.ok || lvlTop !== 2) await finish([s], false, `up: ${JSON.stringify(up)} level=${lvlTop}`);
    const down = await goTo(s as any, world, { x: 3222, z: 3218, level: 0 }, accountOf(s));
    const lvl = s.sdk.getState()?.player?.level;
    await finish([s], down.ok && lvl === 0, `up ${up.ticks}t, down ${JSON.stringify(down)} level=${lvl}`);
} catch (e) { await finish([s], false, String(e)); }
