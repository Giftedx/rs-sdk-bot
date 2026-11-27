// Out of the desert mining camp jail (Tourist Trap) by the cell window and the cliff rocks. The camp guards and
// Captain Siad teleport a caught player to ^desertrescue_prison_coord 0_51_47_21_26 (3285,3034; desertrescue.constant:45),
// and no walkable tile or listed passage leaves the cell: the window is a quest loc and the rocks are aploc2 handlers.
// quest_desertrescue.rs2:188-274: op2 on the window, bend a bar (a Strength roll, retried), land at x-1; then
// ttcellclimbrock1..3 (Climb-to) and ttcellclimbrock4 (Climb down) lead west, each Agility slip deals 7 damage.
import type { Tile } from '../world';
import { waitTicks } from '../ticks';
import type { Walker } from '../walk-leg';

type Pos = { worldX: number; worldZ: number; level: number };
// ana.rs2:105 inzone(0_51_47_20_23, 0_51_47_23_29): the cell.
export const inMineJail = (p: Pos) => p.level === 0 && p.worldX >= 3284 && p.worldX <= 3287 && p.worldZ >= 3031 && p.worldZ <= 3037;
// West of the window, on the window landing or between the rocks: the walker has no route to the open desert from
// these tiles either (a route search from each tile of 3268-3289 by 3029-3044 reaches 3270,3039 only from x <= 3272).
export const onMineJailCliff = (p: Pos) => p.level === 0 && p.worldX >= 3273 && p.worldX <= 3283 && p.worldZ >= 3031 && p.worldZ <= 3041;
// maps/m51_47.jm2: cell_escape_window 2683 at 0 20 24 (inside face), rocks 2694 at 0 16 30, 2695 at 0 14 31,
// 2696 at 0 12 32, 2697 at 0 10 31. The last rock lands the player 4 tiles west of it, on the open desert.
export const MINE_JAIL_WINDOW = { id: 2683, x: 3284, z: 3032 } as const;
export const MINE_JAIL_ROCKS = [
    { id: 2694, x: 3280, z: 3038 },
    { id: 2695, x: 3278, z: 3039 },
    { id: 2696, x: 3276, z: 3040 },
    { id: 2697, x: 3274, z: 3039 },
] as const;
export const MINE_JAIL_OUT_X = 3272;
const SLIP_DAMAGE = 7;

type JailSession = Walker & {
    sdk: Walker['sdk'] & {
        getDialog(): { isOpen: boolean; isWaiting?: boolean; options: { index: number; text: string }[] } | null | undefined;
        sendClickDialog(index: number): Promise<unknown>;
    };
    direct(a: unknown): Promise<unknown>;
};

// The rock to climb from this tile: each climb lands one tile west of its rock (desertrescue_climb_to_rocks forcemove).
export function mineJailRock(p: Pos): (typeof MINE_JAIL_ROCKS)[number] {
    const x = p.worldX, z = p.worldZ;
    if (x >= 3281) return MINE_JAIL_ROCKS[0];
    if (x === 3279 || (x === 3280 && z >= 3039)) return MINE_JAIL_ROCKS[1];
    if (x === 3277 || (x === 3278 && z >= 3040)) return MINE_JAIL_ROCKS[2];
    return MINE_JAIL_ROCKS[3];
}

const inside = (t: Tile) => inMineJail({ worldX: t.x, worldZ: t.z, level: t.level }) || onMineJailCliff({ worldX: t.x, worldZ: t.z, level: t.level });

// 'none' when the account is not in the cell or below the rocks (or the walk ends there), 'out' when it now stands
// west of the rocks, 'stuck' when it is still inside.
export async function leaveMineJail(s: Walker, to: Tile, stop: () => boolean = () => false): Promise<'none' | 'out' | 'stuck'> {
    const j = s as JailSession, here = (): Pos | undefined => j.sdk.getState()?.player;
    const seen = here(), start = seen && { worldX: seen.worldX, worldZ: seen.worldZ, level: seen.level };
    if (!start || !(inMineJail(start) || onMineJailCliff(start)) || inside(to)) return 'none';
    if (typeof j.direct !== 'function' || typeof j.sdk.getDialog !== 'function') return 'stuck';
    const hp = (): number | undefined => j.sdk.getState()?.skills?.find((k: { name?: string }) => k.name === 'Hitpoints')?.level;
    const locAt = (l: { id: number; x: number; z: number }) => (j.sdk.getState()?.nearbyLocs ?? []).find((n: any) => n.id === l.id && n.x === l.x && n.z === l.z) ?? l;
    const answer = (yes: RegExp): boolean => {
        const d = j.sdk.getDialog();
        if (!d?.isOpen) return false;
        if (!d.isWaiting) {
            const opt = d.options.find(o => yes.test(o.text.toLowerCase()));
            void j.sdk.sendClickDialog(opt ? opt.index : d.options.length === 1 ? d.options[0]!.index : 0);
        }
        return true;
    };
    const done = (r: 'out' | 'stuck', why: string) => {
        const p = here();
        console.log(`WALK_MINE_JAIL from=${start.worldX},${start.worldZ},${start.level} ${r} at=${p?.worldX},${p?.worldZ} ${why}`);
        return r;
    };
    // The window: op2, then "Yes, I'll bend the bar." until a Strength roll passes (stat_random(strength, 100, 250)).
    if (inMineJail(start)) {
        await s.bot.walkTo(MINE_JAIL_WINDOW.x, MINE_JAIL_WINDOW.z, 0);
        let idle = 0;
        for (let t = 0; t < 180 && !stop() && inMineJail(here() ?? start); t++) {
            if (answer(/^yes, i'll bend the bar/)) idle = 1;
            else if (idle === 0 || idle >= 10) {
                const w = locAt(MINE_JAIL_WINDOW);
                await j.direct({ type: 'interactLoc', x: w.x, z: w.z, locId: w.id, optionIndex: 2, reason: 'SDK' });
                idle = 1;
            } else idle++;
            await waitTicks(s, 1);
        }
        if (inMineJail(here() ?? start)) return done('stuck', 'window bar not bent');
    }
    // The rocks: from the window's landing to the first rock's approach, then each rock west in turn.
    for (let attempt = 0; attempt < 40 && !stop(); attempt++) {
        const p = here();
        if (!p || p.worldX <= MINE_JAIL_OUT_X || inMineJail(p)) break;
        const life = hp();
        if (typeof life === 'number' && life <= SLIP_DAMAGE) return done('stuck', `hitpoints ${life}: a slip deals ${SLIP_DAMAGE}`);
        if (p.worldX >= 3281 && p.worldZ <= 3036) await s.bot.walkTo(3282, 3037, 0);
        const from = here() ?? p, rock = locAt(mineJailRock(from));
        await j.direct({ type: 'interactLoc', x: rock.x, z: rock.z, locId: rock.id, optionIndex: 2, reason: 'SDK' });
        let lastX = from.worldX, lastZ = from.worldZ, moved = false, settled = 0, idle = 0;
        for (let t = 0; t < 26 && !stop(); t++) {
            await waitTicks(s, 1);
            const q = here();
            if (!q || q.worldX <= MINE_JAIL_OUT_X) break;
            if (answer(/^yes, i'll give it a try/)) { idle = 0; continue; }
            if (q.worldX !== lastX || q.worldZ !== lastZ) { moved = true; settled = 0; lastX = q.worldX; lastZ = q.worldZ; }
            else if (moved) { if (++settled >= 2) break; }
            else if (++idle >= 12) break;
        }
    }
    const end = here();
    return end && end.worldX <= MINE_JAIL_OUT_X && !inMineJail(end) ? done('out', 'window and rocks') : done('stuck', 'rocks not climbed');
}
