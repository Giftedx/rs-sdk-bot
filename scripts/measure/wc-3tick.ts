// 3-tick woodcutting benchmark. Usage: bun scripts/measure/wc-3tick.ts <bot> <normal|3tick> [ticks=300]
// Preset oaks_3tick: Woodcutting 15 at the Varrock oaks, bronze axe, knife, one log.
// Mechanism (code-read): woodcutting rolls when %action_delay = map_clock (skill_woodcutting woodcut.rs2).
// Knife on a log, then "Make 1", sets %action_delay = clock + 2 (skill_fletching/scripts/cut_logs.rs2:83) and only
// queues the cut. Clicking the tree in the same tick clears that queue (no log used) and keeps the delay, so the
// tree rolls 2 ticks later. Repeating every 3 ticks gives a 3-tick cycle instead of 4.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';
import { componentId } from '../../packages/core/src/logout';

const [bot, mode, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 300);
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Woodcutting') ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    const make1 = componentId('skill_multi3:make1_a');
    const tree = () => (s.sdk.getState()?.nearbyLocs ?? []).filter((l: any) => /^oak$/i.test(l.name) && l.optionsWithIndex.some((o: any) => /chop/i.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    let cycles = 0, drops = 0;
    while (s.tick() - t0 < CAP) {
        if ((s.sdk.getInventory()?.length ?? 0) >= 26) { await s.bot.dropItem(/^oak logs$/i, 'all'); drops++; continue; }
        const t = tree();
        if (!t) { await waitTicks(s, 1); continue; }
        const chop = t.optionsWithIndex.find((o: any) => /chop/i.test(o.text))!.opIndex;
        if (mode === 'normal') { await s.bot.chopTree(/^oak$/i); continue; }
        const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
        if (knife === undefined || log === undefined) { console.log('WARN missing knife or log'); break; }
        if (t.distance > 1) { await s.bot.walkTo(t.x, t.z, 1); continue; }
        // Three messages in one tick, in this order: knife on log, Make 1, chop the tree. s.direct skips the shim's
        // one-at-a-time action queue (packages/core/src/inprocess.ts pump), which spread them over several ticks.
        await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
        await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
        await s.direct({ type: 'interactLoc', x: t.x, z: t.z, locId: t.id, optionIndex: chop, reason: 'SDK' });
        cycles++;
        const sentAt = s.tick();
        await waitTicks(s, 3);
        if (cycles <= 3) console.log(`WARN cycle ${cycles} sent at tick ${sentAt - t0}`);
    }
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE woodcutting ${gained} ${ticks}`);
    await finish([s], gained > 0, `mode=${mode} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} cycles=${cycles} drops=${drops} logs=${countItems(s, /^logs$/i)} oaks=${countItems(s, /^oak logs$/i)} lvl=${s.sdk.getSkill('Woodcutting')?.baseLevel}`);
} catch (e) { await finish([s], false, String(e)); }
