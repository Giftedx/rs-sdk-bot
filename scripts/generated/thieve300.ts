// Pickpocket men and women for 300 ticks, eating shrimps when Hitpoints is low.
// Preset thieve_varrock (3235,3403,0 south Varrock, 5 shrimps 315 in the pack).
// A fail stuns and hits for 1-3, so eat at 5 HP or below. Death shows as HP 0 or a jump far from the start.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const SPOT = { x: 3230, z: 3402 };
const TARGET = /^(man|woman)$/i;
const s = await openBot(process.argv[2]!);
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
        if (hp() <= 5 && countItems(s, /shrimps/i) > 0) {
            const e = await s.bot.eatFood(/shrimps/i);
            if (e.success) eaten++;
            continue;
        }
        const npc = s.sdk.findNearbyNpc(TARGET, { reachable: true });
        if (!npc) {
            const p = s.sdk.getState()?.player;
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
    const detail = `thievingXp=${gained} ticks=${ticks} tries=${tries} stuns=${stuns} eaten=${eaten} hp=${hp()} died=${died}`;
    const ok = gained > 0 && !died;
    await finish([s], ok, ok ? detail : `${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
