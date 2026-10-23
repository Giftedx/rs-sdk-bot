// Fishing 3-tick ladder for the planner row fish (Sea Slug to 74, then this). Per-level timing, one drop per cycle.
// Usage: RANDOM_EVENTS=0 bun scripts/measure/floor-fish.ts <bot> <fly|cage|harpoon> [capTicks=3000] [stopLevel=99]
// Presets: floor_fish_fly74 / floor_fish_fly85 (Lumbridge river, fly rod, feathers, knife, logs),
//   floor_fish_cage74 / floor_fish_harpoon74 (Musa Point, knife, logs).
// Mechanism (code-read, vendor/rs-sdk/server/content/scripts/skill_fishing/scripts/fishing_spots/):
// - fly: the Lure op (attempt_fish_trout_salmon, freshfish.rs2:25-57) with %action_delay = clock + 2 re-ops the
//   hidden op 4, which rolls when %action_delay = map_clock (freshfish.rs2:59-87). Knife on a log + Make 1 sets
//   clock + 2 (skill_fletching/scripts/cut_logs.rs2:83-86). Tick T: drop one fish, knife, Make 1, Lure (4 events,
//   the engine takes 5 per tick). The drop must come first: OpHeld clears the pending action
//   (engine OpHeldHandler.ts:54-56), so a drop at T+1 would cut the op-4 chain before its roll at T+2.
//   The hidden op cannot be clicked: OpNpcHandler.ts:40 refuses an op named "hidden".
// - cage / harpoon: the visible op rolls at once when %action_delay = map_clock (rarefish.rs2:70-73, 173-179).
//   Tick T knife + Make 1; T+1 drop one fish (or close the modal); T+2 click the spot (rolls). 3 ticks per roll.
import { openBot, finish } from '../../packages/core/src/bot';
import { componentId } from '../../packages/core/src/logout';
import { meter, send, tick, xp, level, inv, report, band } from './floor-lib';

const [bot, mode, capArg, stopArg] = process.argv.slice(2);
const CAP = Number(capArg ?? 3000);
const STOP = Number(stopArg ?? 99);
const OPT = mode === 'fly' ? /^lure$/i : mode === 'harpoon' ? /^harpoon$/i : /^cage$/i;
const FISH = /^raw (trout|salmon|lobster|tuna|swordfish|shark)$/i;
const make1 = componentId('skill_multi3:make1_a');
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Fishing');
    const t0 = s.tick();
    const lvl0 = level(s, 'Fishing');
    const xp0 = xp(s, 'Fishing');
    console.log(`START Fishing ${lvl0} xp=${xp0} mode=${mode}`);
    const spots = () => ((s.sdk.getState()?.nearbyNpcs ?? []) as any[]).filter(n => /fishing spot/i.test(n.name) && n.optionsWithIndex?.some((o: any) => OPT.test(o.text))).sort((a, b) => a.distance - b.distance);
    const opOf = (n: any) => n.optionsWithIndex.find((o: any) => OPT.test(o.text)).opIndex;
    const logsLeft = () => inv(s).filter(i => i.id === 1511).length;
    const logs0 = logsLeft();
    let last = xp0, lastT = s.tick(), curLvl = lvl0, cycles = 0, moves = 0, moveTicks = 0;
    const account = (name: string) => {
        const x = xp(s, 'Fishing');
        if (x > last) { band(m, name, x - last, s.tick() - lastT, 1); m.actions++; last = x; lastT = s.tick(); }
        const nl = level(s, 'Fishing');
        if (nl > curLvl) { curLvl = nl; console.log(`LEVELUP Fishing ${nl} at ${s.tick() - t0} xp=${x}`); }
    };
    let spotIdx = -1;
    while (s.tick() - t0 < CAP && level(s, 'Fishing') < STOP) {
        const sp = spots()[0];
        if (!sp) { await tick(s); account(`${mode} (move)`); moveTicks++; continue; }
        if (sp.distance > 1 || sp.index !== spotIdx) {
            // Walk into reach with a plain click; stop when the position holds for 2 ticks.
            const tm = s.tick(); moves++; spotIdx = sp.index;
            await send(s, m, { type: 'interactNpc', npcIndex: sp.index, optionIndex: opOf(sp) });
            const pos = () => { const p = s.sdk.getState()?.player; return p ? p.worldX * 100000 + p.worldZ : 0; };
            let prev = pos(), still = 0;
            for (let k = 0; k < 40 && still < 2; k++) { await tick(s); const q = pos(); still = q === prev ? still + 1 : 0; prev = q; }
            account(`${mode} (move)`); moveTicks += s.tick() - tm;
            if ((spots()[0]?.distance ?? 9) > 1) spotIdx = -1;
            continue;
        }
        const knife = inv(s).find(i => i.id === 946), log = inv(s).find(i => i.id === 1511);
        if (!knife || !log) { console.log('WARN missing knife or log'); break; }
        const fish = inv(s).find(i => FISH.test(i.name));
        if (mode === 'fly') {
            if (fish) await send(s, m, { type: 'dropItem', slot: fish.slot });
            await send(s, m, { type: 'useItemOnItem', sourceSlot: knife.slot, targetSlot: log.slot });
            await send(s, m, { type: 'clickComponent', componentId: make1 });
            await send(s, m, { type: 'interactNpc', npcIndex: sp.index, optionIndex: opOf(sp) });
            cycles++;
            for (let k = 0; k < 3; k++) { await tick(s); account(mode); }
        } else {
            await send(s, m, { type: 'useItemOnItem', sourceSlot: knife.slot, targetSlot: log.slot });
            await send(s, m, { type: 'clickComponent', componentId: make1 });
            await tick(s); account(mode);
            const f = inv(s).find(i => FISH.test(i.name));
            if (f) await send(s, m, { type: 'dropItem', slot: f.slot }); else await send(s, m, { type: 'closeModal' });
            await tick(s); account(mode);
            const sp2 = spots()[0] ?? sp;
            await send(s, m, { type: 'interactNpc', npcIndex: sp2.index, optionIndex: opOf(sp2) });
            cycles++;
            await tick(s); account(mode);
        }
        if (s.tick() - lastT > 60) { console.log(`WARN no XP for 60 ticks at Fishing ${level(s, 'Fishing')}`); break; }
    }
    const ticks = s.tick() - t0;
    const line = report(s, m, `mode=${mode} start=${lvl0} cap=${CAP} cycles=${cycles} moves=${moves} moveTicks=${moveTicks} logsUsed=${logs0 - logsLeft()} feathers=${inv(s).filter(i => i.id === 314).reduce((n, i) => n + i.count, 0)} xpPerTick=${((xp(s, 'Fishing') - xp0) / ticks).toFixed(1)}`);
    await finish([s], m.actions > 0, line);
} catch (e) { await finish([s], false, String(e)); }
