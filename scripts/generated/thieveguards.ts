// Pickpocket guards for 300 ticks, eating shrimps when Hitpoints is low.
// Preset thieve_guards (3210,3459,0 outside Varrock palace, Thieving 40, Hitpoints 30, 20 shrimps 315 in the pack).
// Guards stand at (3206,3462), (3211,3463), (3212,3462), (3213,3465) (knowledge/npcs.json guard1).
// A guard stun hits harder than a man, so eat at 15 HP or below. Death shows as HP 0 or a jump far from the start.
import { openBot, finish, countItems, sessionDied } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

const SPOT = { x: 3210, z: 3463 };
const TARGET = /^guard$/i;
const EAT_AT = 15;
// A login failure must still print one RESULT line, or the proof sees no output at all.
console.log(`ERR-TRACE opening ${process.argv[2]}`);
const s = await openBot(process.argv[2]!).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const xp = () => s.sdk.getSkillXp('Thieving') ?? 0;
    const hp = () => s.sdk.getSkill('Hitpoints')?.level ?? 0;
    // Preset stats can arrive a few ticks after START; read the base XP after they settle.
    await waitTicks(s, 5);
    const xp0 = xp();
    const t0 = s.tick();
    let died = false;
    // A death is the server's (sessionDied): a blank state in a disconnect reads HP 0 and no position.
    const life0 = (({ isDead, respawnCount, lifeId }: any = {}) => ({ isDead, respawnCount, lifeId }))(s.sdk.getState()?.player);
    const off = s.onTick(() => {
        if (sessionDied(life0, s.sdk.getState()?.player)) died = true;
    });
    let tries = 0, stuns = 0, eaten = 0;
    let lastFail = '';
    for (let i = 0; i < 400 && s.tick() - t0 < 300 && !died; i++) {
        if (hp() <= EAT_AT && countItems(s, /shrimps/i) > 0) {
            const e = await s.bot.eatFood(/shrimps/i);
            if (e.success) eaten++;
            else await waitTicks(s, 1);
            continue;
        }
        const npc = s.sdk.findNearbyNpc(TARGET, { reachable: true });
        const p = s.sdk.getState()?.player;
        const far = npc && p && Math.max(Math.abs(npc.x - SPOT.x), Math.abs(npc.z - SPOT.z)) > 12;
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
    const detail = `xp0=${xp0} thievingXp=${gained} ticks=${ticks} tries=${tries} stuns=${stuns} eaten=${eaten} hp=${hp()} shrimps=${countItems(s, /shrimps/i)} died=${died}`;
    const ok = gained > 0 && !died;
    await finish([s], ok, ok ? detail : `${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
