// Shows the eat guard (packages/core/src/eat-guard.ts) in a fight: the script attacks hill giants and sends no eat input.
// Usage: bun scripts/measure/eat-guard-fight.ts <bot> [capTicks=600]. The account starts in the hill giant room with a
// weapon and food: the bench case `extra:giant-eat-guard` has the start state. EAT_GUARD=0 runs the comparison
// without the guard.
import { openBot, finish } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const HILL_GIANT = 117;
const [bot, cArg] = process.argv.slice(2);
const CAP = Number(cArg ?? 600);
const s = await openBot(bot!);
try {
    await waitTicks(s, 3);
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const food = () => (s.sdk.getState()?.inventory ?? []).filter(i => i.optionsWithIndex.some(o => /^eat$/i.test(o.text))).reduce((n, i) => n + i.count, 0);
    const life = s.sdk.getState()!.player!.lifeId, food0 = food(), t0 = s.tick();
    const alive = () => { const p = s.sdk.getState()?.player; return !!p && !p.isDead && p.lifeId === life; };
    let kills = 0, hpMin = hp();
    const off = s.onTick(() => { const h = hp(); if (h > 0) hpMin = Math.min(hpMin, h); });
    while (alive() && s.tick() - t0 < CAP) {
        const target = (s.sdk.getState()?.nearbyNpcs ?? []).filter(n => n.id === HILL_GIANT && n.hp !== 0).sort((a, b) => a.distance - b.distance)[0];
        if (!target) { await waitTicks(s, 2); continue; }
        const a = await s.bot.attack(target);
        if (!a.success) { await waitTicks(s, 1); continue; }
        const gone = await waitUntil(s, st => !alive() || !(st?.nearbyNpcs ?? []).some((n: { index: number }) => n.index === target.index), { timeoutTicks: 150 });
        if (gone && alive()) kills++;
    }
    off();
    await finish([s], alive(), `kills=${kills} eaten=${food0 - food()} hpMin=${hpMin} hp=${hp()} ticks=${s.tick() - t0}`);
} catch (e) { await finish([s], false, String(e)); }
