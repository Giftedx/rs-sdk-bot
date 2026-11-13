// Bench worker for the loot job (packages/core/src/loot.ts, randomevents.ts). In Draynor bank the partner account drops a
// rune platebody 3 tiles from the bot. The bot, with LOOT_WATCH=1, must pick it up while the gate holds the walk that
// this script sends, then finish that walk, then put the platebody in the bank when this script opens the bank.
// The case sets NODE_OBJ_REVEAL_TICKS=1 on the engine: the drop of another player shows to the bot one tick later.
// Usage: bun scripts/measure/loot-probe.ts <bot> <partner>
import { finish, openBot } from '../../packages/core/src/bot';
import { waitUntil } from '../../packages/core/src/ticks';

export const LOOT_ITEM = 1127; // Rune platebody: cost 65,000, not a members item.
export const LOOT_WALK = { x: 3094, z: 3245 };

if (import.meta.main) {
    const [bot, partner] = process.argv.slice(2);
    if (!bot || !partner) throw new Error('usage: loot-probe.ts <bot> <partner>');
    // The partner gets no loot job: it would leave its own drop alone, but it must not take part.
    process.env.LOOT_WATCH = '0';
    const q = await openBot(partner);
    process.env.LOOT_WATCH = '1';
    const s = await openBot(bot);
    const held = (x: typeof s) => (x.sdk.getState()?.inventory ?? []).some((i: any) => i.id === LOOT_ITEM);
    try {
        const slot = (q.sdk.getState()?.inventory ?? []).find((i: any) => i.id === LOOT_ITEM)?.slot;
        if (slot === undefined) throw new Error('partner has no rune platebody');
        await q.direct({ type: 'dropItem', slot, reason: 'loot-probe' });
        const seen = await waitUntil(s, st => (st?.groundItems ?? []).some((g: any) => g.id === LOOT_ITEM), { timeoutTicks: 10 });
        // The script's own work: a walk. The pickup holds it; it goes after the pickup and the walk back.
        const walk = s.direct({ type: 'walkTo', x: LOOT_WALK.x, z: LOOT_WALK.z, running: true, reason: 'loot-probe' });
        const picked = await waitUntil(s, () => held(s), { timeoutTicks: 40 });
        await walk;
        const walked = await waitUntil(s, st => st?.player?.worldX === LOOT_WALK.x && st?.player?.worldZ === LOOT_WALK.z, { timeoutTicks: 40 });
        const opened = (await s.bot.openBank()).success;
        const banked = await waitUntil(s, st => !held(s) && (st?.bank?.items ?? []).some((i: any) => i.id === LOOT_ITEM), { timeoutTicks: 30 });
        const detail = `loot-probe seen=${seen} picked=${picked} walked=${walked} opened=${opened} banked=${banked}`;
        await finish([s, q], seen && picked && walked && opened && banked, detail);
    } catch (e) { await finish([s, q], false, String(e)); }
}
