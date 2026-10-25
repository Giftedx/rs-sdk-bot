// Catherby Fisher: catches Lobsters (Cage) or Swordfish/Tuna (Harpoon) at Catherby beach (2838,3431)
// and banks at Catherby Bank (2809,3441).
// Usage: bun scripts/gather-fish.ts <botName> [method: cage | harpoon, default cage] [CAP ticks, default 15000]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

const CATHERBY_BANK = { x: 2809, z: 3441 };
const BEACH_SPOT = { x: 2838, z: 3432 };

const botName = process.argv[2] ?? 'Mightyrod';
const method = (process.argv[3] ?? process.env.METHOD ?? 'cage').toLowerCase();
const CAP = Number(process.argv[4] ?? process.env.CAP ?? 15000);
const BANK_AT = Number(process.argv[5] ?? process.env.BANK_AT ?? 27);

const isCage = method === 'cage';
const requiredTool = isCage ? /lobster pot/i : /harpoon/i;
const targetOp = isCage ? 'Cage' : 'Harpoon';

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitUntil(s, st => (st?.inGame ?? false) && (st?.player !== null) && (st?.inventory?.length ?? 0) > 0, { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const fishCount = () => inv().filter(i => /raw (lobster|swordfish|tuna)/i.test(i.name)).reduce((n, i) => n + i.count, 0);
    const freeSpace = () => 28 - inv().length;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let caughtTotal = 0;
    let bankTrips = 0;
    let walkTicks = 0;

    const walk = async (x: number, z: number, tol = 2): Promise<boolean> => {
        const a = s.tick();
        for (let i = 0; i < 3 && !over(); i++) {
            const p = pos();
            if (p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol) break;
            const r = await walkPath(await sessionWalker(s), [{ x, z, tol }], { stop: over });
            if (!r.ok) {
                console.log(`WALK fail ${r.detail} ticks=${r.ticks}`);
                await waitTicks(s, 1);
            }
        }
        walkTicks += s.tick() - a;
        const p = pos();
        return !!p && Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) <= tol;
    };

    const bank = async () => {
        await walk(CATHERBY_BANK.x, CATHERBY_BANK.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }

        const currentFish = fishCount();
        if (currentFish > 0) {
            caughtTotal += currentFish;
            // Deposit all fish
            for (const item of inv()) {
                if (/raw (lobster|swordfish|tuna)/i.test(item.name)) {
                    await s.bot.depositItem(item.name, -1);
                }
            }
        }

        // Ensure we have the required tool
        if (!inv().some(i => requiredTool.test(i.name))) {
            const toolName = isCage ? 'Lobster pot' : 'Harpoon';
            console.log(`Withdrawing ${toolName}...`);
            await s.bot.withdrawItem(requiredTool, 1);
        }

        await waitTicks(s, 1);
        await s.bot.closeInterface();
        bankTrips++;
        console.log(`MILESTONE bank t=${used()} caughtTotal=${caughtTotal} bankTrips=${bankTrips}`);
    };

    console.log(`START gather-fish ${botName} method=${method} at=${pos()?.worldX},${pos()?.worldZ}`);

    while (!over()) {
        if (fishCount() >= BANK_AT || freeSpace() === 0 || !inv().some(i => requiredTool.test(i.name))) {
            await bank();
            continue;
        }

        // Walk to fishing beach
        const p = pos();
        if (!p || Math.max(Math.abs(p.worldX - BEACH_SPOT.x), Math.abs(p.worldZ - BEACH_SPOT.z)) > 12) {
            await walk(BEACH_SPOT.x, BEACH_SPOT.z, 3);
            continue;
        }

        // Find fishing spot NPC
        const npcs = s.sdk.getState()?.nearbyNpcs ?? [];
        const spot = npcs.find(n => /fishing spot/i.test(n.name) && n.options.includes(targetOp));

        if (!spot) {
            await waitTicks(s, 3);
            continue;
        }

        const invBefore = inv().length;
        const opt = spot.optionsWithIndex.find(o => new RegExp(`^${targetOp}$`, 'i').test(o.text));
        if (!opt) {
            await waitTicks(s, 2);
            continue;
        }

        await s.sdk.sendInteractNpc(spot.index, opt.opIndex);

        // Wait for catch or spot relocation
        for (let t = 0; t < 15 && !over(); t++) {
            await waitTicks(s, 1);
            if (inv().length > invBefore || freeSpace() === 0) break;
            // If spot moved
            if (!s.sdk.getState()?.nearbyNpcs.some(n => n.index === spot.index)) break;
        }
    }

    const total = caughtTotal + fishCount();
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], total > 0, `ticks=${used()} totalCaught=${total} banked=${caughtTotal} held=${fishCount()} bankTrips=${bankTrips} fishPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
