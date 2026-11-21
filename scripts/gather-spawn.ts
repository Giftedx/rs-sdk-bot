// Route supplies that lie on the ground (maps OBJ spawns): jangerberries, fire and earth runes, snape grass, a
// chisel. Trips of packages/core/src/gather.ts spawn gathering (nearest reachable spawns, waiting for respawns),
// each banked at the nearest bank, until TARGET items are banked or TICKS pass.
// Usage: bun scripts/gather-spawn.ts <account> <item id> [target=27]   Env: TICKS (default 6000)
import { openBot, finish, getWorld, accountOf, countItems } from '../packages/core/src/bot';
import { gatherItems } from '../packages/core/src/gather';
import { wildernessLevel } from '../packages/core/src/prayer-guard';
import { goTo } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { nearestBanks } from './quest-sweep';

// Items per trip: a stack goes in one slot; anything else fills the free slots.
export function tripSize(left: number, stackable: boolean, freeSlots: number): number {
    return Math.max(0, Math.min(left, stackable ? left : freeSlots));
}

type Tile = { x: number; z: number; level: number };
type WalkOutcome = { ok: boolean; reason?: string; detail?: string };

/** Keep ground-spawn walks out of the Wilderness unless explicitly allowed. */
export function safeSpawnWalk(
    s: Parameters<typeof accountOf>[0] & Parameters<typeof goTo>[0],
    world: Parameters<typeof goTo>[1],
    allowWilderness = process.env.ALLOW_WILDERNESS === '1',
    move: (session: Parameters<typeof goTo>[0], w: Parameters<typeof goTo>[1], to: Tile, acct: ReturnType<typeof accountOf>, opts: { legTimeoutTicks: number }) => Promise<WalkOutcome> = goTo,
): (to: Tile) => Promise<WalkOutcome> {
    return async (to: Tile) => {
        if (!allowWilderness && wildernessLevel(to.x, to.z) > 0) {
            return { ok: false, reason: 'wilderness', detail: `refused Wilderness spawn ${to.x},${to.z},${to.level}` };
        }
        return move(s, world, to, accountOf(s), { legTimeoutTicks: 100 });
    };
}

/** Drop Wilderness banks when gathering non-Wilderness ground spawns. */
export function nonWildernessBanks<T extends { x: number; z: number }>(banks: readonly T[], allowWilderness = process.env.ALLOW_WILDERNESS === '1'): T[] {
    return banks.filter(b => allowWilderness || wildernessLevel(b.x, b.z) === 0);
}

if (import.meta.main) {
    const [name, idText, targetText] = process.argv.slice(2);
    const id = Number(idText), target = Number(targetText ?? 27), TICKS = Number(process.env.TICKS ?? 6000);
    const allowWilderness = process.env.ALLOW_WILDERNESS === '1';
    if (!name || !Number.isSafeInteger(id) || !Number.isSafeInteger(target) || target < 1) { console.log('RESULT fail usage: gather-spawn.ts <account> <item id> [target]'); process.exit(2); }
    const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
    let start = s.tick();
    const inv = () => s.sdk.getInventory();
    const held = () => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const here = () => { const p = s.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ, level: p.level }; };
    let banked = 0, trips = 0, last = '';
    try {
        const world = await getWorld();
        start = s.tick();
        const walkSpawn = safeSpawnWalk(s, world, allowWilderness);
        while (banked < target && s.tick() - start < TICKS) {
            if (!allowWilderness && wildernessLevel(here().x, here().z) > 0) { last = `refused Wilderness position ${here().x},${here().z}`; break; }
            const stack = inv().find(i => i.id === id), stackable = (stack?.count ?? 0) > 1 || /rune$/i.test(stack?.name ?? '') || [554, 555, 556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566].includes(id);
            const n = tripSize(target - banked - held(), stackable, 28 - inv().length);
            if (n > 0) last = (await gatherItems(s, world, [{ id, count: n, how: 'spawn' }], walkSpawn)) ?? '';
            const got = held();
            if (!got) break;
            let deposited = false;
            for (const bank of nonWildernessBanks(nearestBanks(here()), allowWilderness).slice(0, 4)) {
                if (!(await goTo(s, world, bank, accountOf(s), { legTimeoutTicks: 100 })).ok) continue;
                if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) continue;
                const item = inv().find(i => i.id === id);
                const credited = item ? await depositObserved(s, item) : 0;
                if(credited>0){banked+=credited;trips++;}
                await s.bot.closeBank();
                deposited = held() === 0 && credited === got;
                break;
            }
            if (!deposited) { last = 'no bank in reach'; break; }
            console.log(`GATHER_SPAWN trip=${trips} banked=${banked}/${target} t=${s.tick() - start} ${last}`);
        }
        const targetMet = banked >= target;
        await finish([s], targetMet, `item=${id} banked=${banked} target=${target} targetMet=${targetMet} remaining=${Math.max(0,target-banked)} trips=${trips} ticks=${s.tick() - start} ${last}`);
    } catch (e) { await finish([s], false, `item=${id} banked=${banked} target=${target} targetMet=${banked>=target} remaining=${Math.max(0,target-banked)} trips=${trips} ticks=${s.tick()-start} ${String(e)}`); }
}
