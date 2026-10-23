// Woodcutting ladder by delayed-click 3-tick (planner row woodcut). Rune axe, knife, one normal log.
// Usage: RANDOM_EVENTS=0 bun scripts/measure/floor-woodcut.ts <bot> [capTicks=3000] [stopLevel=99]
// Env: WILLOW_AT = level to move from oaks to willows (default 72), TREE = force one tree (tree|oak|willow).
// Presets: floor_wc1, floor_wc45, floor_wc72, floor_wc85 (packages/practice/src/presets.ts).
// Mechanism (code-read, vendor/rs-sdk/server/content/scripts/):
// - Any axe works at any level: woodcutting_axe_checker returns the best axe held with no level check
//   (skill_woodcutting/scripts/woodcut.rs2:193-235, the 2004 rule), so a rune axe is legal from Woodcutting 1.
// - The visible Chop op (attempt_cut_tree) rolls at once when %action_delay = map_clock (woodcut.rs2:97-99).
// - Knife on a log + "Make 1" sets %action_delay = clock + 2 (skill_fletching/scripts/cut_logs.rs2:83-86).
// - Cycle: tick T knife + Make 1; T+1 drop one log (OpHeld clears the pending action and the fletch queue,
//   engine OpHeldHandler.ts:54-56); T+2 Chop (rolls); T+3 next knife. One roll per 3 ticks, one drop per cycle,
//   so the pack never fills. A used normal log marks a cycle that missed its timing.
// - Trees: oak and willow fall on 1 in 8 logs (woodcut.rs2:168, 184-189) and respawn in 30 ticks (trees.dbrow);
//   the script moves to the nearest standing tree. Normal trees fall on every log.
import { openBot, finish } from '../../packages/core/src/bot';
import { componentId } from '../../packages/core/src/logout';
import { meter, send, tick, xp, level, inv, report, band } from './floor-lib';

const [bot, capArg, stopArg] = process.argv.slice(2);
const CAP = Number(capArg ?? 3000);
const STOP = Number(stopArg ?? 99);
const WILLOW_AT = Number(process.env.WILLOW_AT ?? 72);
const TREES: Record<string, { name: RegExp; site: { x: number; z: number } }> = {
    tree: { name: /^tree$/i, site: { x: 3112, z: 3226 } },
    oak: { name: /^oak$/i, site: { x: 3115, z: 3236 } },
    willow: { name: /^willow$/i, site: { x: 3086, z: 3233 } },
};
const pick = (L: number) => process.env.TREE ?? (L < 15 ? 'tree' : L < WILLOW_AT ? 'oak' : 'willow');
const make1 = componentId('skill_multi3:make1_a');
const s = await openBot(bot!);
try {
    await tick(s, 3);
    const m = meter(s, 'Woodcutting');
    const t0 = s.tick();
    const lvl0 = level(s, 'Woodcutting');
    console.log(`START Woodcutting ${lvl0} xp=${xp(s, 'Woodcutting')}`);
    const pos = () => { const p = s.sdk.getState()?.player; return p ? { x: p.worldX, z: p.worldZ } : { x: 0, z: 0 }; };
    const standing = (re: RegExp) => ((s.sdk.getState()?.nearbyLocs ?? []) as any[]).filter(l => re.test(l.name) && l.optionsWithIndex.some((o: any) => /^chop/i.test(o.text)));
    const chopOp = (l: any) => l.optionsWithIndex.find((o: any) => /^chop/i.test(o.text)).opIndex;
    const logsLeft = () => inv(s).filter(i => i.id === 1511).length;
    let last = xp(s, 'Woodcutting'), lastT = s.tick(), curLvl = lvl0, cycles = 0, moves = 0, moveTicks = 0, idleNoTree = 0;
    let tree: any = null, kind = '';
    const logs0 = logsLeft();
    const xp0 = xp(s, "Woodcutting");
    const account = (name: string) => {
        const x = xp(s, 'Woodcutting');
        if (x > last) { band(m, name, x - last, s.tick() - lastT, 1); m.actions++; last = x; lastT = s.tick(); }
        const nl = level(s, 'Woodcutting');
        if (nl > curLvl) { curLvl = nl; console.log(`LEVELUP Woodcutting ${nl} at ${s.tick() - t0} xp=${x}`); }
    };
    while (s.tick() - t0 < CAP && level(s, 'Woodcutting') < STOP) {
        const want = pick(level(s, 'Woodcutting'));
        const T = TREES[want]!;
        // Keep the current tree while it stands; else walk to the nearest standing one of the wanted kind.
        const here = tree && kind === want ? standing(T.name).find(l => l.x === tree.x && l.z === tree.z) : null;
        if (!here) {
            const tm = s.tick();
            const p = pos();
            const cands = standing(T.name).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
            if (!cands.length) {
                // None in view (or all fallen): walk to the site and wait for a respawn.
                if (Math.hypot(T.site.x - p.x, T.site.z - p.z) > 8) await send(s, m, { type: 'walkTo', x: T.site.x, z: T.site.z, running: true });
                await tick(s); idleNoTree++; account(`${want} (move)`); moveTicks += s.tick() - tm; continue;
            }
            tree = cands[0]; kind = want; moves++;
            // Plain Chop to walk into reach; stop when the position holds for 2 ticks.
            await send(s, m, { type: 'interactLoc', x: tree.x, z: tree.z, locId: tree.id, optionIndex: chopOp(tree) });
            let prev = pos(), still = 0;
            for (let k = 0; k < 40 && still < 2; k++) { await tick(s); const q = pos(); still = q.x === prev.x && q.z === prev.z ? still + 1 : 0; prev = q; }
            account(`${want} (move)`);
            moveTicks += s.tick() - tm;
            continue;
        }
        const knife = inv(s).find(i => i.id === 946), log = inv(s).find(i => i.id === 1511);
        if (!knife || !log) { console.log('WARN missing knife or log'); break; }
        // T: knife on log + Make 1.
        await send(s, m, { type: 'useItemOnItem', sourceSlot: knife.slot, targetSlot: log.slot });
        await send(s, m, { type: 'clickComponent', componentId: make1 });
        await tick(s); account(want);
        // T+1: drop one product log (never the knife log), else close the Make-X modal.
        const prod = inv(s).find(i => i.id === 1521 || i.id === 1519) ?? (logsLeft() > 1 ? inv(s).filter(i => i.id === 1511)[1] : undefined);
        if (prod) await send(s, m, { type: 'dropItem', slot: prod.slot }); else await send(s, m, { type: 'closeModal' });
        await tick(s); account(want);
        // T+2: Chop rolls at once.
        await send(s, m, { type: 'interactLoc', x: here.x, z: here.z, locId: here.id, optionIndex: chopOp(here) });
        cycles++;
        await tick(s); account(want);
        if (s.tick() - lastT > 60) { console.log(`WARN no XP for 60 ticks at Woodcutting ${level(s, 'Woodcutting')}`); break; }
    }
    const ticks = s.tick() - t0;
    const line = report(s, m, `start=${lvl0} cap=${CAP} willowAt=${WILLOW_AT} cycles=${cycles} moves=${moves} moveTicks=${moveTicks} noTreeTicks=${idleNoTree} logsUsed=${logs0 - logsLeft()} xpPerTick=${((xp(s, "Woodcutting") - xp0) / ticks).toFixed(1)}`);
    await finish([s], m.actions > 0, line);
} catch (e) { await finish([s], false, String(e)); }
