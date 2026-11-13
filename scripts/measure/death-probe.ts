// Bench worker for death recovery (packages/core/src/death-recovery.ts). The bot, unarmed at Hitpoints 2, attacks a Man east of
// the Lumbridge respawn and dies. openBot's death path then runs back, picks up the dropped items, wears the gear again
// and ends the session as a death. This script only starts the fight.
// Usage: bun scripts/measure/death-probe.ts <bot>
import { finish, openBot } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';

if (import.meta.main) {
    const bot = process.argv[2];
    if (!bot) throw new Error('usage: death-probe.ts <bot>');
    process.env.DEATH_RECOVERY = '1';
    // openBot calls onStop after the recovery: the run passes when the recovery line says ok.
    let recovered = '';
    const s = await openBot(bot, {
        log: line => { console.log(line); if (/^DEATH_RECOVERY ok /.test(line)) recovered = line; },
        onStop: (x, reason) => finish([x], reason === 'died' && !!recovered, `death-probe reason=${reason} ${recovered || 'no recovery'}`),
    });
    for (let i = 0; i < 40; i++) {
        const st = s.sdk.getState();
        if (st?.player?.isDead) break;
        const man = (st?.nearbyNpcs ?? []).filter((n: any) => n.name === 'Man').sort((a: any, b: any) => a.distance - b.distance)[0];
        const op = man?.optionsWithIndex?.find((o: any) => /^attack$/i.test(o.text ?? ''));
        if (op && man && !st?.player?.combat?.inCombat) await s.direct({ type: 'interactNpc', npcIndex: man.index, optionIndex: op.opIndex, reason: 'death-probe' });
        await waitTicks(s, 5);
    }
    // The death path ends the session; this line runs only when the bot did not die.
    await waitTicks(s, 400);
    await finish([s], false, 'death-probe: no death');
}
