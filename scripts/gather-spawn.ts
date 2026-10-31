// Route supplies that lie on the ground (maps OBJ spawns): jangerberries, fire and earth runes, snape grass, a
// chisel. Trips of packages/core/src/gather.ts spawn gathering (nearest reachable spawns, waiting for respawns),
// each banked at the nearest bank, until TARGET items are banked or TICKS pass.
// Usage: bun scripts/gather-spawn.ts <account> <item id> [target=27]   Env: TICKS (default 6000)
import { openBot, finish, getWorld, accountOf, countItems } from '../packages/core/src/bot';
import { gatherItems } from '../packages/core/src/gather';
import { goTo } from '../packages/core/src/walk';
import { waitUntil } from '../packages/core/src/ticks';
import { depositObserved } from '../packages/core/src/deposit';
import { nearestBanks } from './quest-sweep';

// Items per trip: a stack goes in one slot; anything else fills the free slots.
export function tripSize(left: number, stackable: boolean, freeSlots: number): number {
    return Math.max(0, Math.min(left, stackable ? left : freeSlots));
}

if (import.meta.main) {
    const [name, idText, targetText] = process.argv.slice(2);
    const id = Number(idText), target = Number(targetText ?? 27), TICKS = Number(process.env.TICKS ?? 6000);
    if (!name || !Number.isSafeInteger(id) || !Number.isSafeInteger(target) || target < 1) { console.log('RESULT fail usage: gather-spawn.ts <account> <item id> [target]'); process.exit(2); }
    const s = await openBot(name).catch(e => finish([], false, `login: ${String(e)}`));
    const world = await getWorld(), start = s.tick(), inv = () => s.sdk.getInventory();
    const held = () => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const here = () => { const p = s.sdk.getState()!.player!; return { x: p.worldX, z: p.worldZ, level: p.level }; };
    let banked = 0, trips = 0, last = '';
    try {
        while (banked < target && s.tick() - start < TICKS) {
            const stack = inv().find(i => i.id === id), stackable = (stack?.count ?? 0) > 1 || /rune$/i.test(stack?.name ?? '') || [554, 555, 556, 557, 558, 559, 560, 561, 562, 563, 564, 565, 566].includes(id);
            const n = tripSize(target - banked - held(), stackable, 28 - inv().length);
            if (n > 0) last = (await gatherItems(s, world, [{ id, count: n, how: 'spawn' }])) ?? '';
            const got = held();
            if (!got) break;
            let deposited = false;
            for (const bank of nearestBanks(here()).slice(0, 4)) {
                if (!(await goTo(s, world, bank, accountOf(s), { legTimeoutTicks: 100 })).ok) continue;
                if (!(await s.bot.openBank()).success || !await waitUntil(s, () => !!s.bankObservation?.(), { timeoutTicks: 20 })) continue;
                const item = inv().find(i => i.id === id);
                if (item) await depositObserved(s, item);
                await s.bot.closeBank();
                deposited = held() === 0;
                break;
            }
            if (!deposited) { last = 'no bank in reach'; break; }
            banked += got; trips++;
            console.log(`GATHER_SPAWN trip=${trips} banked=${banked}/${target} t=${s.tick() - start} ${last}`);
        }
        await finish([s], banked > 0, `item=${id} banked=${banked} target=${target} trips=${trips} ticks=${s.tick() - start} ${last}`);
    } catch (e) { await finish([s], banked > 0, `item=${id} banked=${banked} ${String(e)}`); }
}
