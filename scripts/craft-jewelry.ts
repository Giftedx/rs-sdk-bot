// Universal Jewelry Crafter: cuts gems, smelts gold jewelry at furnace, and enchants with Cosmic runes.
// Usage: bun scripts/craft-jewelry.ts <bot> [CAP ticks, default 15000] [ACTION: cut | smelt | enchant] [TIER: sapphire | emerald | ruby | diamond | dragonstone]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

const FURNACE_SPOT = { x: 3274, z: 3186 }; // Al Kharid Furnace
const BANK_SPOT = { x: 3269, z: 3167 };    // Al Kharid Bank

const botName = process.argv[2];
const CAP = Number(process.argv[3] ?? process.env.CAP ?? 15000);
const ACTION = (process.argv[4] ?? process.env.ACTION ?? 'cut').toLowerCase();
const TIER = (process.argv[5] ?? process.env.TIER ?? 'sapphire').toLowerCase();

if (!botName) {
    console.error('Usage: bun scripts/craft-jewelry.ts <botName> [CAP] [ACTION: cut | smelt | enchant] [TIER]');
    process.exit(1);
}

const s = await openBot(botName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    const inv = () => s.sdk.getInventory();
    const pos = () => s.sdk.getState()?.player;
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let crafted = 0, bankTrips = 0, walkTicks = 0;

    const findItem = (re: RegExp) => inv().find(i => re.test(i.name));
    const countRe = (re: RegExp) => countItems(s, re);

    const uncutRe = new RegExp(`uncut ${TIER}`, 'i');
    const cutRe = new RegExp(`^${TIER}$`, 'i');

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
        await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            await waitTicks(s, 2);
            return;
        }

        if (ACTION === 'cut') {
            await s.bot.depositItem(cutRe, -1);
            await waitTicks(s, 1);
            if (!findItem(/^chisel$/i)) await s.bot.withdrawItem(/^chisel$/i, 1);
            await s.bot.withdrawItem(uncutRe, 27);
        } else if (ACTION === 'smelt') {
            await s.bot.depositItem(/ring|amulet|necklace/i, -1);
            await waitTicks(s, 1);
            if (!findItem(/mould/i)) await s.bot.withdrawItem(/ring mould/i, 1);
            await s.bot.withdrawItem(/gold bar/i, 13);
            await s.bot.withdrawItem(cutRe, 13);
        }

        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
    };

    console.log(`START jewelry crafter ${botName} action=${ACTION} tier=${TIER}`);

    while (!over()) {
        if (ACTION === 'cut') {
            const chisel = findItem(/^chisel$/i);
            const uncut = inv().filter(i => uncutRe.test(i.name));

            if (!chisel || uncut.length === 0) {
                await bank();
                if (inv().filter(i => uncutRe.test(i.name)).length === 0) {
                    await waitTicks(s, 5);
                    continue;
                }
            }

            const ch = findItem(/^chisel$/i)!;
            const toCut = inv().filter(i => uncutRe.test(i.name));
            const before = toCut.length;

            for (const g of toCut) void s.sdk.sendUseItemOnItem(ch.slot, g.slot);
            await waitUntil(s, () => inv().filter(i => uncutRe.test(i.name)).length === 0, { timeoutTicks: 15 });

            const after = inv().filter(i => uncutRe.test(i.name)).length;
            const diff = before - after;
            if (diff > 0) crafted += diff;
        } else if (ACTION === 'smelt') {
            const gold = findItem(/gold bar/i);
            const gem = findItem(cutRe);

            if (!gold || !gem) {
                await bank();
                if (!findItem(/gold bar/i) || !findItem(cutRe)) {
                    await waitTicks(s, 5);
                    continue;
                }
            }

            if (Math.max(Math.abs(pos()?.worldX ?? 0 - FURNACE_SPOT.x), Math.abs(pos()?.worldZ ?? 0 - FURNACE_SPOT.z)) > 3) {
                await walk(FURNACE_SPOT.x, FURNACE_SPOT.z, 2);
                continue;
            }

            const before = countRe(/ring|amulet/i);
            const r = await s.bot.craftJewelry({ product: 'ring', gem: TIER });
            if (r.success) {
                crafted += 1;
            } else {
                await waitTicks(s, 2);
            }
        }
    }

    const perK = (crafted * 1000 / Math.max(1, used())).toFixed(2);
    await finish([s], crafted > 0, `ticks=${used()} crafted=${crafted} action=${ACTION} tier=${TIER} bankTrips=${bankTrips} craftPer1kTicks=${perK}`);
} catch (e) {
    await finish([s], false, String(e));
}
