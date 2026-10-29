// Proven script 4: equip a bronze sword and kill 2 cows with reflexes on (eat shrimps, flee to the gate).
// Preset fight_lumbridge (3253,3285,0 inside the cow field; sword 1277 and 5 shrimps in the pack).
import { openBot, finish } from '../../packages/core/src/bot';
import { startReflexes } from '../../packages/core/src/reflex';
import { waitUntil } from '../../packages/core/src/ticks';

const COMBAT = ['Attack', 'Strength', 'Defence', 'Hitpoints'];
const s = await openBot(process.argv[2]!);
try {
    await s.bot.equipItem(/bronze sword/i);
    const reflex = startReflexes(s as any, { eatBelowHp: 6, fleeBelowHp: 3, foods: /shrimps/i, safeTile: { x: 3253, z: 3266, level: 0 } });
    const xp = () => (s.sdk.getState()?.skills ?? []).filter(k => COMBAT.includes(k.name)).reduce((n, k) => n + k.experience, 0);
    const xp0 = xp();
    let kills = 0;
    for (let i = 0; i < 6 && kills < 2 && !reflex.aborted.aborted; i++) {
        const target = s.sdk.findNearbyNpc(/^cow$/i);
        if (!target) { await s.bot.walkTo(3253, 3290, 3); continue; }
        const a = await s.bot.attack(target);
        if (!a.success) continue;
        // Dead when that NPC index is gone from the nearby list.
        const dead = await waitUntil(s, st => !(st?.nearbyNpcs ?? []).some((n: { index: number }) => n.index === target.index), { timeoutTicks: 120, signal: reflex.aborted });
        if (dead && !reflex.aborted.aborted) kills++;
    }
    reflex.stop();
    const gained = xp() - xp0;
    await finish([s], kills >= 2 && gained > 0 && !reflex.aborted.aborted, `kills=${kills} combatXp=${gained} reflexAborted=${reflex.aborted.aborted}`);
} catch (e) { await finish([s], false, String(e)); }
