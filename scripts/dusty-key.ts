// The dusty key: Taverley dungeon's inner gate (deepdungeondoor 2623 at 2924,9803) asks for it, and behind the gate
// are the blue dragons, the black dragons and the Water Obelisk ladder. It cannot be traded: each account gets its own.
// bun scripts/dusty-key.ts <account>
// From anywhere it walks to the Taverley dungeon ladder (2884,3397) and down, kills the Jailer (npc 201, level 47,
// spawn 2933,9693), who always drops the jail key (1591, `drop tables/scripts/jailer.rs2:10`), opens Velrak's cell
// (dungeonjail 2631, south wall of 2931,9690) with it, and asks Velrak (npc 798): "So... do you know anywhere good to
// explore?", "Yes please!" (`velrak_the_explorer.rs2:2-16`). Then back up the ladder. An account that holds the key
// ends at once.
// The steps are those of Scorpion Catcher's dusty key chain (scripts/generated/quest-scorpion.ts, 3 of 3 on practice,
// research/quest-plan.md 1o). The fight uses whatever the account wields.
import { openQuest } from './generated/quest-lib';
import { walkTargetPersist } from './walk-to';

const TAV_LADDER = { x: 2884, z: 3397 };                     // ladder_cellar_inside_down (1759), maps/m45_53.jm2
const LADDER_FOOT = { x: 2884, z: 9797 };                    // ladder_from_cellar (1755)
const JAILER = { id: 201, x: 2933, z: 9693 };
const JAIL_DOOR = { id: 2631, x: 2931, z: 9690 };
const VELRAK = { x: 2931, z: 9685 };
const GATE = { x: 2924, z: 9803 };
export const DUSTY_KEY = 1590, JAIL_KEY = 1591;

if (import.meta.main) {
    const q = await openQuest({ cap: 3000, eatAt: 50, lumbridgeOk: false });
    try {
        const z = () => q.pos()?.worldZ ?? 0;
        // Taverley dungeon's map squares. Another cave (Zanaris, where Lost City ends) is not this dungeon.
        const inDungeon = () => { const p = q.pos(); return !!p && p.worldX >= 2816 && p.worldX < 2970 && p.worldZ >= 9664 && p.worldZ < 9920; };
        const ladderAt = (at: { x: number; z: number }, re: RegExp) => () => q.findLoc(l => /ladder/i.test(l.name) && Math.max(Math.abs(l.x - at.x), Math.abs(l.z - at.z)) <= 1 && (l.optionsWithIndex ?? []).some((o: any) => re.test(o.text)));
        const npc = (id: number): any => (q.st()?.nearbyNpcs ?? []).filter((n: any) => n.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
        const ground = (id: number): any => (q.st()?.groundItems ?? []).filter((g: any) => g.id === id).sort((a: any, b: any) => a.distance - b.distance)[0];
        if (q.has(DUSTY_KEY)) await q.end(true, 'dusty key held');
        if (!inDungeon()) {
            const there = await walkTargetPersist(q.s, { x: TAV_LADDER.x, z: TAV_LADDER.z + 1, level: 0 });
            if (!there.ok) await q.fail(`route to the Taverley ladder: ${there.reason ?? ''} ${there.detail ?? ''}`);
            await q.climb('taverley ladder', ladderAt(TAV_LADDER, /climb-down/i), /climb-down/i, inDungeon);
        }
        q.milestone('dungeon');
        // The gate is locked from this side without the key: keep the router off it.
        q.blockDoor(0, GATE.x, GATE.z);
        await q.walk('to jailer', [{ x: JAILER.x - 3, z: JAILER.z - 1, tol: 3 }]);
        for (let t = 0; t < 200 && !q.has(JAIL_KEY); t++) {
            await q.guard('jailer');
            const g = ground(JAIL_KEY), n = npc(JAILER.id);
            if (g) { if (t % 3 === 0) await q.s.direct({ type: 'pickupItem', x: g.x, z: g.z, itemId: g.id, reason: 'SDK' }); }
            else if (n && (t % 5 === 0 || q.pos()?.targetIndex !== n.index)) await q.attackNpc(n);
            await q.waitTicks(1);
        }
        if (!q.has(JAIL_KEY)) await q.fail('jail key');
        q.milestone('jail key');
        const inCell = () => z() < JAIL_DOOR.z;
        await q.step('cell door', () => q.useOnLoc(JAIL_KEY, JAIL_DOOR), inCell, 15, 4);
        await q.talk('velrak', /^velrak/i, [/know anywhere good to explore/i, /yes please/i], () => q.has(DUSTY_KEY), VELRAK, 40);
        q.milestone('dusty key');
        await q.step('leave cell', () => q.opLoc(JAIL_DOOR, 1), () => !inCell(), 15, 4);
        await q.walk('to ladder', [{ x: LADDER_FOOT.x, z: LADDER_FOOT.z + 1, tol: 1 }]);
        await q.climb('ladder up', ladderAt(LADDER_FOOT, /climb-up/i), /climb-up/i, () => z() < 9000);
        q.milestone('surface');
        await q.end(q.has(DUSTY_KEY), `dustyKey=${q.has(DUSTY_KEY) ? 1 : 0}`);
    } catch (e) { await q.fail(String(e)); }
}
