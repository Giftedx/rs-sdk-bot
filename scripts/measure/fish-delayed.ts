// Delayed-click 3-tick fishing benchmark. Usage: bun scripts/measure/fish-delayed.ts <bot> <normal|delayed|same> [ticks=300]
// Env: OPT = spot option regex (default "cage"; "harpoon" for tuna/swordfish/shark), FISH = raw fish regex to drop,
// GAP = ticks from the knife to the spot click (default 2), CLICKOP = op index to click (default: the visible option).
// Presets: lobster_delayed_40, lobster_delayed_70 (Musa Point), harpoon_delayed_55, shark_delayed_80 (Catherby).
// Mechanism (code-read):
// - The visible spot op runs the "attempt" label. With %action_delay < map_clock it sets clock + 4 (lobster,
//   rarefish.rs2:60-63) or clock + 5 (harpoon, rarefish.rs2:164-167; shark, memberfish.rs2:30-33). With
//   %action_delay = map_clock it rolls at once and does not re-op (rarefish.rs2:70-73, :173-179; memberfish.rs2:40-43).
// - Knife on a log + "Make 1" sets %action_delay = clock + 2 when it is in the past (cut_logs.rs2:83-86) and queues
//   the fletch as a weak queue; the spot click clears that queue, so no log is used.
// - delayed: tick T knife + Make 1; tick T+1 drop one fish or close the modal (both clear the fletch queue);
//   tick T+2 click the spot (rolls); repeat at T+3.
// - same: knife + Make 1 + click in one tick (the method that works for fly fishing). The spot sees clock + 2 and
//   has no branch for it, so this is expected to fail on these spots.
// - normal: best plain clicking, one spot click every PERIOD ticks (5 cage, 6 harpoon); drop a fish at 26 items.
import { openBot, finish, countItems } from '../../packages/core/src/bot';
import { waitTicks } from '../../packages/core/src/ticks';
import { componentId } from '../../packages/core/src/logout';

const [bot, mode, tArg] = process.argv.slice(2);
const CAP = Number(tArg ?? 300);
const OPT = new RegExp(`^${process.env.OPT ?? 'cage'}$`, 'i');
const FISH = new RegExp(process.env.FISH ?? '^raw (lobster|tuna|swordfish|shark)$', 'i');
const GAP = Number(process.env.GAP ?? 2);
const CLICKOP = process.env.CLICKOP ? Number(process.env.CLICKOP) : undefined;
// normal mode click period: cage 5 (set + 4, roll, click), harpoon 6 (set + 5).
const PERIOD = Number(process.env.PERIOD ?? (/harpoon/i.test(OPT.source) ? 6 : 5));
const s = await openBot(bot!);
try {
    await waitTicks(s, 5);
    const xp = () => s.sdk.getSkillXp('Fishing') ?? 0;
    const xp0 = xp();
    const t0 = s.tick();
    const make1 = componentId('skill_multi3:make1_a');
    const spot = () => (s.sdk.getState()?.nearbyNpcs ?? []).filter((n: any) => /fishing spot/i.test(n.name) && n.optionsWithIndex?.some((o: any) => OPT.test(o.text))).sort((a: any, b: any) => a.distance - b.distance)[0];
    const slotOf = (re: RegExp) => (s.sdk.getInventory() ?? []).find((i: any) => re.test(i.name))?.slot;
    let cycles = 0, drops = 0, catches = 0, lastXp = xp0;
    s.onTick(() => { const x = xp(); if (x > lastXp) { catches++; lastXp = x; } });
    while (s.tick() - t0 < CAP) {
        const sp = spot();
        if (!sp) { await waitTicks(s, 1); continue; }
        const op = CLICKOP ?? sp.optionsWithIndex.find((o: any) => OPT.test(o.text))!.opIndex;
        if (sp.distance > 1) { await s.bot.walkTo(sp.x, sp.z, 1); continue; }
        if (mode === 'normal') {
            // Best plain clicking: one click every PERIOD ticks. The click sets clock + 4 (cage) or + 5 (harpoon),
            // the hidden op rolls on the due tick, and the next click lands 1 tick later. A click also closes a
            // level-up dialog (clearPendingAction), which stops the self-queued chain. On the free tick, drop a fish.
            if ((s.sdk.getInventory()?.length ?? 0) >= 26) { const f = slotOf(FISH); if (f !== undefined) { void s.direct({ type: 'dropItem', slot: f, reason: 'SDK' }); drops++; } await waitTicks(s, 1); }
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: op, reason: 'SDK' });
            cycles++;
            await waitTicks(s, PERIOD - ((s.sdk.getInventory()?.length ?? 0) >= 26 ? 1 : 0));
            continue;
        }
        const knife = slotOf(/^knife$/i), log = slotOf(/^logs$/i);
        if (knife === undefined || log === undefined) { console.log('WARN missing knife or log'); break; }
        const sentAt = s.tick();
        await s.direct({ type: 'useItemOnItem', sourceSlot: knife, targetSlot: log, reason: 'SDK' });
        await s.direct({ type: 'clickComponent', componentId: make1, reason: 'SDK' });
        if (mode === 'same') {
            await s.direct({ type: 'interactNpc', npcIndex: sp.index, optionIndex: op, reason: 'SDK' });
            cycles++;
            await waitTicks(s, 3);
            if ((s.sdk.getInventory()?.length ?? 0) >= 26) { await s.bot.dropItem(FISH, 'all'); drops++; }
            continue;
        }
        await waitTicks(s, 1);
        // Free tick: drop one fish. A drop is instant and does not touch %action_delay.
        const fish = slotOf(FISH);
        // Either input closes the modal, which clears the weak queue (Player.ts closeModal), so the fletch never runs
        // and no log is used even when the spot click comes late. %action_delay stays at T+2.
        if (fish !== undefined) { void s.direct({ type: 'dropItem', slot: fish, reason: 'SDK' }); drops++; }
        else void s.direct({ type: 'closeModal', reason: 'SDK' });
        await waitTicks(s, GAP - 1);
        const sp2 = spot() ?? sp;
        await s.direct({ type: 'interactNpc', npcIndex: sp2.index, optionIndex: op, reason: 'SDK' });
        cycles++;
        if (cycles <= 3) console.log(`WARN cycle ${cycles} knife at ${sentAt - t0} click at ${s.tick() - t0}`);
        await waitTicks(s, 1);
    }
    const ticks = s.tick() - t0;
    const gained = xp() - xp0;
    console.log(`RATE fishing ${gained} ${ticks}`);
    await finish([s], gained > 0, `mode=${mode} opt=${OPT.source} gap=${GAP} xp0=${xp0} gained=${gained} ticks=${ticks} perTick=${(gained / ticks).toFixed(1)} cycles=${cycles} catches=${catches} drops=${drops} logs=${countItems(s, /^logs$/i)} lvl=${s.sdk.getSkill('Fishing')?.baseLevel}`);
} catch (e) { await finish([s], false, String(e)); }
