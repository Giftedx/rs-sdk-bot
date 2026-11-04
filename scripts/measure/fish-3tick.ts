// 3-tick fishing benchmark. Usage: bun scripts/measure/fish-3tick.ts <bot> <normal|3tick> [ticks=300]
// Preset shrimp_3tick: Draynor net spot, small fishing net, knife, one log.
// Mechanism (code-read, skill_fishing/scripts/fishing_spots/saltfish.rs2 and freshfish.rs2:37-50): a
// click with an expired %action_delay sets it to clock + 4 and rolls 4 ticks later (a 5-tick cycle). Knife on a log
// + "Make 1" sets it to clock + 2 first (skill_fletching/scripts/cut_logs.rs2:83), so the spot rolls 2 ticks later;
// repeating every 3 ticks gives a 3-tick cycle. The fletch is queued and cleared by the spot click: no log used.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks, waitUntil } from '../../packages/core/src/ticks';
import { componentId } from '../../packages/core/src/logout';

const [bot, mode, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 300);
// Option to fish with: "Lure" for fly fishing (default), "Net" for net spots (NET=1).
const OPT = process.env.NET === '1' ? /^net$/i : /^lure$/i;
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    const make1 = componentId('skill_multi3:make1_a');
    const spot = () => (s.sdk.getState()?.nearbyNpcs ?? []).filter((n: any) => /fishing spot/i.test(n.name) && n.optionsWithIndex?.some((o: any) => OPT.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    let cycles = 0, drops = 0;
    while (s.tick() - t0 < CAP) {
        if ((s.sdk.getInventory()?.length ?? 0) >= 26) { await s.bot.dropItem(/^raw (shrimps|anchovies|trout|salmon)$/i, 'all'); drops++; continue; }
        const sp = spot();
        if (!sp) { await waitTicks(s, 1); continue; }
        const net = sp.optionsWithIndex.find((o: any) => OPT.test(o.text))!.opIndex;
        // Normal: click once; the net script queues its own next step every tick (p_opnpc(4) at the end of
        // fish_shrimp). Clicking again breaks that chain, so re-click only after 20 ticks with no catch.
        if (mode === 'normal') {
            const x0 = xp();
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: net, reason: 'SDK' });
            await waitUntil(s, () => xp() > x0, { timeoutTicks: 20 });
            continue;
        }
        const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
        if (knife === undefined || log === undefined) { console.log('WARN missing knife or log'); break; }
        if (sp.distance > 1) { await s.bot.walkTo(sp.x, sp.z, 1); continue; }
        // Three messages in one tick (s.direct skips the shim's one-at-a-time queue): knife on log, Make 1, net the spot.
        await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
        await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
        // Net spots: the visible Net op (attempt_fish_shrimp) ends the chain when the delay is clock + 2; the hidden
        // op 4 (fish_shrimp) keeps it and rolls when the delay equals the clock (saltfish.rs2).
        await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: process.env.NET === '1' ? 4 : net, reason: 'SDK' });
        cycles++;
        await waitTicks(s, 3);
    }
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE fishing ${gained} ${ticks}`);
    await finish([s], gained > 0, `mode=${mode} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} cycles=${cycles} drops=${drops} logs=${countItems(s, /^logs$/i)} lvl=${s.sdk.getSkill('Fishing')?.baseLevel}`);
} catch (e) { await finish([s], false, String(e)); }
