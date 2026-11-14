// Bench worker for the flee guard (randomevents.ts `flee`, packages/core/src/death-recovery.ts FLEE_HP). Unarmed, with
// no food, the bot attacks a Guard (combat 21) in Varrock square. At FLEE_HP of its Hitpoints the guard must run it out
// of the Guard's reach and end the session there, alive.
// Usage: bun scripts/measure/flee-probe.ts <bot>
import { finish, openBot } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

if (import.meta.main) {
    const bot = process.argv[2];
    if (!bot) throw new Error('usage: flee-probe.ts <bot>');
    process.env.FLEE_GUARD = '1';
    // openBot calls onStop when the flee guard reports the player safe: the run passes on that reason, alive.
    const s = await openBot(bot, {
        onStop: (x, reason) => {
            const p = x.sdk.getState()?.player;
            const alive = !!p && !p.isDead && (p.hp ?? 0) > 0;
            return finish([x], reason.startsWith('fled at low hitpoints') && alive, `flee-probe reason=${reason} hp=${p?.hp}/${p?.maxHp}`);
        },
    });
    for (let i = 0; i < 40; i++) {
        const st = s.sdk.getState();
        if (st?.player?.isDead) break;
        const guard = (st?.nearbyNpcs ?? []).filter((n: any) => n.name === 'Guard').sort((a: any, b: any) => a.distance - b.distance)[0];
        const op = guard?.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text ?? ''));
        if (op && guard && !st?.player?.combat?.inCombat) await s.direct({ type: 'interactNpc', npcIndex: guard.index, optionIndex: op.opIndex, reason: 'flee-probe' });
        await waitTicks(s, 5);
    }
    // The flee guard ends the session; this line runs only when it did not.
    await waitTicks(s, 400);
    await finish([s], false, 'flee-probe: no flight');
}
