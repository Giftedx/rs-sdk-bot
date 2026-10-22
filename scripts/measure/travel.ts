// Measures one long trip through the world graph: ticks, lowest HP, run energy, and deaths.
// Usage: bun scripts/measure/travel.ts <bot> <x> <z> [level=0]. A death shows as a jump back to Lumbridge.
// Prints TRAVEL <json>.
import { openBot, finish, getWorld, accountOf } from '../../packages/core/src/bot';
import { goTo } from '../../packages/core/src/walk';

const [bot, xs, zs, ls] = process.argv.slice(2);
const to = { x: Number(xs), z: Number(zs), level: Number(ls ?? 0) };
const s = await openBot(bot!);
try {
    const world = await getWorld();
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    let minHp = hp();
    let deaths = 0;
    const deathsAt: number[][] = [];
    const hits: string[] = [];
    let hpLast = hp();
    let last = s.sdk.getState()?.player;
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        minHp = Math.min(minHp, hp());
        if (p && hp() < hpLast && hits.length < 40) hits.push(`${s.tick()}:${p.worldX},${p.worldZ}:${hp()}`);
        hpLast = hp();
        if (p && last && Math.max(Math.abs(p.worldX - last.worldX), Math.abs(p.worldZ - last.worldZ)) > 20) { deaths++; deathsAt.push([last.worldX, last.worldZ]); }
        last = p;
    });
    const t0 = s.tick();
    let r = await goTo(s as any, world, to, accountOf(s));
    // One more try from wherever the bot is, so a stuck leg shows as extra ticks instead of a stop.
    if (!r.ok && deaths === 0) r = await goTo(s as any, world, to, accountOf(s));
    off();
    const p = s.sdk.getState()?.player;
    const out = { ok: r.ok, ticks: s.tick() - t0, minHp, hpNow: hp(), deaths, deathsAt, hits, energy: s.sdk.getState()?.player?.runEnergy, at: p && [p.worldX, p.worldZ, p.level], detail: r.ok ? '' : r.detail };
    console.log(`TRAVEL ${JSON.stringify(out)}`);
    await finish([s], r.ok && deaths === 0, JSON.stringify(out));
} catch (e) { await finish([s], false, String(e)); }
