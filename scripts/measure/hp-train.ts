// Measures how fast a new account raises Hitpoints by killing cows in the Lumbridge field.
// Usage: bun scripts/measure/hp-train.ts <bot> [targetHp=25] [capTicks=1500]. Preset fight_lumbridge (sword, shrimps).
// Combat gives Hitpoints XP for every point of damage dealt, so this times HP 10 -> target.
import { openBot, finish } from '../../packages/core/src/bot';
import { startReflexes } from '../../packages/core/src/reflex';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const [bot, tArg, cArg] = process.argv.slice(2);
const TARGET = Number(tArg ?? 25);
const CAP = Number(cArg ?? 1500);
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    await s.bot.equipItem(/bronze sword/i);
    const reflex = startReflexes(s as any, { eatBelowHp: 4, fleeBelowHp: 2, foods: /shrimps/i, safeTile: { x: 3253, z: 3266, level: 0 } });
    const hpLvl = () => s.sdk.getSkill('Hitpoints')?.baseLevel ?? 0;
    const hpXp = () => s.sdk.getSkillXp('Hitpoints') ?? 0;
    const xp0 = hpXp();
    const t0 = s.tick();
    let kills = 0, last = hpLvl();
    while (hpLvl() < TARGET && s.tick() - t0 < CAP && !reflex.aborted.aborted) {
        if (hpLvl() !== last) { last = hpLvl(); if (last % 5 === 0) console.log(`MILESTONE hp${last} ${s.tick() - t0}`); }
        const target = s.sdk.findNearbyNpc(/^cow$/i);
        if (!target) { await s.bot.walkTo(3253, 3290, 3); continue; }
        const a = await s.bot.attack(target);
        if (!a.success) { await waitTicks(s, 1); continue; }
        const dead = await waitUntil(s, st => !(st?.nearbyNpcs ?? []).some((n: { index: number }) => n.index === target.index), { timeoutTicks: 120 });
        if (dead) kills++;
    }
    reflex.stop();
    const ticks = s.tick() - t0;
    console.log(`RATE hitpoints ${hpXp() - xp0} ${ticks}`);
    await finish([s], hpLvl() >= TARGET, `hp=${hpLvl()} hpXp=${hpXp() - xp0} ticks=${ticks} kills=${kills} aborted=${reflex.aborted.aborted}`);
} catch (e) { await finish([s], false, String(e)); }
