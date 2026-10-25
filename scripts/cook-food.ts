// Catherby Range Cooker: cooks raw lobsters, swordfish, trout, salmon, sharks at Catherby range.
// Catherby Range: 2816, 3443 (house next to bank). Catherby Bank: 2809, 3441 (7 tiles away).
// Usage: bun scripts/cook-food.ts <bot> [CAP ticks, default 15000] [FOOD_TYPE: lobster | swordfish | trout | salmon | shark]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

const RANGE_SPOT = { x: 2816, z: 3443 }; // Catherby range
const BANK_SPOT = { x: 2809, z: 3441 };  // Catherby bank

const botName = process.argv[2];
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const FOOD_TYPE = (process.argv[4] ?? process.env.FOOD_TYPE ?? 'lobster').toLowerCase();

if (!botName) {
    console.error('Usage: bun scripts/cook-food.ts <botName> [CAP] [FOOD_TYPE]');
    process.exit(1);
}

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const pos = () => s.sdk.getState()?.player;
    const rawRe = new RegExp(`^raw ${FOOD_TYPE}`, 'i');
    const cookedRe = new RegExp(`^${FOOD_TYPE}`, 'i');
    const rawCount = () => countItems(s, rawRe);
    const cookedCount = () => countItems(s, cookedRe);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let cookedTotal = 0, bankTrips = 0, walkTicks = 0;

    const counters = () => `cookedTotal=${cookedTotal} heldCooked=${cookedCount()} heldRaw=${rawCount()} bankTrips=${bankTrips} walkTicks=${walkTicks}`;

    const walk = async (x: number, z: number, tol = 1): Promise<boolean> => {
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
        await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return;
        }

        // Deposit all cooked and burnt items
        await s.bot.depositItem(new RegExp(`(${FOOD_TYPE}|burnt)`, 'i'), -1);
        await waitTicks(s, 1);

        // Withdraw 28 raw food
        await s.bot.withdrawItem(rawRe, 28);
        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
    };

    console.log(`START food cooker ${botName} at=${pos()?.worldX},${pos()?.worldZ} food=${FOOD_TYPE}`);

    while (!over()) {
        if (rawCount() === 0) {
            await bank();
            if (rawCount() === 0) {
                await waitTicks(s, 5);
                continue;
            }
        }

        const p = pos();
        if (!p) { await waitTicks(s, 1); continue; }

        if (Math.max(Math.abs(p.worldX - RANGE_SPOT.x), Math.abs(p.worldZ - RANGE_SPOT.z)) > 2) {
            await walk(RANGE_SPOT.x, RANGE_SPOT.z, 1);
            continue;
        }

        const range = s.sdk.findNearbyLoc(/range|oven/i);
        if (!range) {
            await waitTicks(s, 2);
            continue;
        }

        const rawItem = s.sdk.getInventory().find(i => rawRe.test(i.name));
        if (!rawItem) continue;

        const before = cookedCount();
        await s.sdk.sendUseItemOnLoc(rawItem.slot, range.x, range.z, range.id);
        await waitUntil(s, () => cookedCount() > before || rawCount() === 0, { timeoutTicks: 10 });

        const gained = cookedCount() - before;
        if (gained > 0) {
            cookedTotal += gained;
        }
    }

    const total = cookedTotal + cookedCount();
    const perK = (total * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], total > 0, `ticks=${used()} ${counters()} cookedPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
