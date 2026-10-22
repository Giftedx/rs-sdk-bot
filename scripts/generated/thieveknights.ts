// Pickpocket knights of Ardougne for 300 ticks, eating lobsters when Hitpoints is low.
// Preset thieve_knights (2654,3304,0 in Ardougne market, Thieving 55, Hitpoints 50, 20 lobsters 379 in the pack).
// Knights spawn at (2652,3318) and (2653,3300) (knowledge/npcs.json knight_of_ardougne) and wander.
// A fail stuns 8 ticks and hits for 3, so eat at 25 HP or below. Death shows as HP 0 or a jump far from the start.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const SPOT = { x: 2654, z: 3306 };
const TARGET = /^knight of ardougne$/i;
const FOOD = /lobster/i;
const EAT_AT = 25;
// A login failure must still print one RESULT line, or the proof sees no output at all.
console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    let died = false;
    const off = s.onTick(() => {
        const p = s.sdk.getState()?.player;
        if (hp() <= 0) died = true;
        if (p && Math.max(Math.abs(p.worldX - SPOT.x), Math.abs(p.worldZ - SPOT.z)) > 40) died = true;
    });
    let tries = 0, stuns = 0, eaten = 0;
    let lastFail = '';
    for (let i = 0; i < 400 && s.tick() - t0 < 300 && !died; i++) {
        if (hp() <= EAT_AT && countItems(s, FOOD) > 0) {
            const e = await s.bot.eatFood(FOOD);
            if (e.success) eaten++;
            else await waitTicks(s, 1);
            continue;
        }
        const npc = s.sdk.findNearbyNpc(TARGET, { reachable: true });
        const p = s.sdk.getState()?.player;
        const far = npc && p && Math.max(Math.abs(npc.x - SPOT.x), Math.abs(npc.z - SPOT.z)) > 16;
        if (!npc || far) {
            if (p && Math.max(Math.abs(p.worldX - SPOT.x), Math.abs(p.worldZ - SPOT.z)) > 5) await s.bot.walkTo(SPOT.x, SPOT.z, 3);
            else await waitTicks(s, 2);
            continue;
        }
        tries++;
        const r = await s.bot.pickpocketNpc(npc);
        if (!r.success) {
            lastFail = `${r.reason}:${r.message}`;
            if (r.reason === 'stunned') stuns++;
            await waitTicks(s, 1);
        }
    }
    off();
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE thieving ${gained} ${ticks}`);
    const detail = `thievingXp=${gained} ticks=${ticks} tries=${tries} stuns=${stuns} eaten=${eaten} hp=${hp()} lobsters=${countItems(s, FOOD)} died=${died}`;
    const ok = gained > 0 && !died;
    await finish([s], ok, ok ? detail : `${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
