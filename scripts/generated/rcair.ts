// Craft air runes from all rune essence at the air altar. Preset rc_air_inside (2841,4830,0 inside the altar,
// air talisman 1438 and 27 rune essence 1436 in the pack).
// One craft turns the whole pack of essence into runes, so the loop retries only if essence is left.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';

const s = await openBot(process.argv[2]!);
try {
    const xp = () => s.sdk.getSkillXp('Runecraft') ?? 0;
    const ess = () => countItems(s, /^rune essence$/i);
    // The inventory can arrive a few ticks after the skills, so an early read sees an empty pack.
    const loaded = await waitUntil(s, st => (st?.inventory ?? []).length > 0, { timeoutTicks: 30 });
    const xp0 = xp();
    const ess0 = ess();
    const t0 = s.tick();
    let lastFail = loaded ? '' : 'inventory never loaded';
    for (let i = 0; i < 8 && s.tick() - t0 < 200 && ess() > 0; i++) {
        const altar = s.sdk.findNearbyLoc(/altar/i, { withOption: /craft/i });
        if (!altar) { lastFail = 'no altar with a craft option'; await waitTicks(s, 2); continue; }
        const r = await s.bot.interactLoc(altar, /craft/i);
        if (!r.success) lastFail = `${r.reason}:${r.message}`;
        await waitUntil(s, () => ess() === 0, { timeoutTicks: 10 });
    }
    const runes = countItems(s, /^air rune$/i);
    const left = ess();
    const gained = xp() - xp0;
    const ticks = s.tick() - t0;
    console.log(`RATE runecraft ${gained} ${ticks}`);
    const detail = `airRunes=${runes} essence=${left} startEssence=${ess0} runecraftXp=${gained} ticks=${ticks}`;
    const ok = runes > 0 && left === 0 && gained > 0;
    await finish([s], ok, ok ? detail : `${detail} last=${lastFail}`);
} catch (e) { await finish([s], false, String(e)); }
