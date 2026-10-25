// Supply Holder (Zero-Waste Buffer & Staging Mule):
// Stands at a designated production spot or bank booth (e.g. Ardougne 2654,3283, Seers 2727,3492, Catherby 2809,3441).
// Receives bulk banknotes & supplies from couriers (Bigpackage) without making the specialist wait.
// Pre-unnotes and stages materials in its pack so when the training specialist (Haggis or skill specialist)
// logs in, 27 materials are handed over in 2-3 ticks flat. Zero ticks wasted on travel or bank interfaces!
//
// Usage: bun scripts/supply-holder.ts <botName> [specialist=Haggis] [courier=Bigpackage] [CAP ticks, default 15000]
// Environment:
//   SPOT=x,z (default 2654,3283)
//   SUPPLY_ITEM=<regex> (default /./)
//   BATCH_SIZE=<number> (default 27)
//   DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';

const holderName = process.argv[2] ?? 'Supplyholder';
const specialistName = process.argv[3] ?? process.env.SPEC ?? 'Haggis';
const courierName = process.argv[4] ?? process.env.COURIER ?? 'Bigpackage';
const CAP = Number(process.argv[5] ?? process.env.CAP ?? 15000);

const spotStr = process.env.SPOT ?? '2654,3283';
const [spotX, spotZ] = spotStr.split(',').map(Number);
const HOLD_SPOT = { x: spotX ?? 2654, z: spotZ ?? 3283 };

const supplyPattern = new RegExp(process.env.SUPPLY_ITEM ?? '.', 'i');
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 27);

const s = await openBot(holderName).catch(e => finish([], false, `login: ${String(e)}`));
try {
    await waitUntil(s, st => (st?.inGame ?? false) && (st?.player !== null), { timeoutTicks: 10 });

    const pos = () => s.sdk.getState()?.player;
    const inv = () => s.sdk.getInventory();
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    const over = () => used() >= CAP;

    let courierTrades = 0;
    let specialistTrades = 0;
    let itemsSupplied = 0;
    let itemsStored = 0;

    const walkToSpot = async () => {
        const p = pos();
        if (p && Math.max(Math.abs(p.worldX - HOLD_SPOT.x), Math.abs(p.worldZ - HOLD_SPOT.z)) <= 2) return true;
        const w = await sessionWalker(s);
        const r = await walkPath(w, [{ x: HOLD_SPOT.x, z: HOLD_SPOT.z, tol: 1 }], { stop: over });
        return r.ok;
    };

    const isNearBank = () => {
        const booths = s.sdk.getState()?.nearbyLocs?.filter(l => /bank/i.test(l.name)) ?? [];
        return booths.length > 0;
    };

    // Prepares unnoted materials in inventory for instant trade handoff
    const prepareStagedInventory = async () => {
        if (!isNearBank()) return;
        const unnotedCount = inv().filter(i => supplyPattern.test(i.name) && !i.name.includes('(noted)')).length;
        if (unnotedCount >= BATCH_SIZE) return;

        const b = await s.bot.openBank();
        if (!b.success) return;

        // Deposit any processed items or junk
        for (const item of inv()) {
            if (!supplyPattern.test(item.name)) {
                await s.bot.depositItem(item.name, -1);
            }
        }

        // Withdraw unnoted batch for the specialist
        const withdrawCount = BATCH_SIZE - unnotedCount;
        if (withdrawCount > 0) {
            await s.bot.withdrawItem(supplyPattern, withdrawCount);
        }

        await waitTicks(s, 1);
        await s.bot.closeInterface();
    };

    console.log(`START supply-holder ${holderName} staging at=${HOLD_SPOT.x},${HOLD_SPOT.z} for specialist=${specialistName} courier=${courierName}`);

    await walkToSpot();

    while (!over()) {
        const nearbyPlayers = s.sdk.getState()?.nearbyPlayers ?? [];
        const specialistNearby = nearbyPlayers.find(p => new RegExp(`^${specialistName}$`, 'i').test(p.name));
        const courierNearby = nearbyPlayers.find(p => new RegExp(`^${courierName}$`, 'i').test(p.name));

        // Priority 1: Training Specialist is here! Hand over prepared batch with 0 wasted ticks!
        if (specialistNearby) {
            console.log(`SPECIALIST ${specialistName} spotted! Serving trade immediately...`);
            const stageItems = inv().filter(i => supplyPattern.test(i.name));
            const giveList = stageItems.slice(0, BATCH_SIZE).map(i => ({ item: new RegExp(`^${i.name}$`, 'i'), amount: i.count }));

            const tradeRes = await s.bot.trade(new RegExp(`^${specialistName}$`, 'i'), {
                give: giveList,
                timeout: 30000,
            });

            if (tradeRes.success) {
                specialistTrades++;
                const countGave = tradeRes.gave.reduce((acc, g) => acc + g.count, 0);
                itemsSupplied += countGave;
                console.log(`MILESTONE supplied ${countGave} items to ${specialistName} in 1 trade! totalSupplied=${itemsSupplied}`);
                await waitTicks(s, 1);
                await prepareStagedInventory();
                continue;
            }
        }

        // Priority 2: Courier is here with bulk supplies from the gathering fields
        if (courierNearby) {
            console.log(`COURIER ${courierName} spotted! Receiving cargo...`);
            const serveRes = await s.bot.serveTrades({
                from: new RegExp(`^${courierName}$`, 'i'),
                maxTrades: 1,
                timeout: 30000,
            });

            if (serveRes.success && serveRes.trades.some(t => t.success)) {
                courierTrades++;
                const receivedTrade = serveRes.trades.find(t => t.success)!;
                const countGot = receivedTrade.received.reduce((acc, r) => acc + r.count, 0);
                itemsStored += countGot;
                console.log(`MILESTONE received ${countGot} items from ${courierName}! totalStored=${itemsStored}`);

                // If near bank, deposit received cargo
                if (isNearBank()) {
                    const b = await s.bot.openBank();
                    if (b.success) {
                        for (const item of inv()) {
                            if (!supplyPattern.test(item.name)) {
                                await s.bot.depositItem(item.name, -1);
                            }
                        }
                        await s.bot.closeInterface();
                    }
                }
                await prepareStagedInventory();
                continue;
            }
        }

        // Passive serving loop: accept trade requests from specialist or courier
        const acceptFilter = new RegExp(`^(${specialistName}|${courierName})$`, 'i');
        await s.bot.serveTrades({
            from: acceptFilter,
            maxTrades: 1,
            timeout: 5000,
        });

        await waitTicks(s, 2);
    }

    await finish([s], specialistTrades > 0 || courierTrades > 0 || itemsSupplied > 0,
        `ticks=${used()} specialistTrades=${specialistTrades} courierTrades=${courierTrades} itemsSupplied=${itemsSupplied} itemsStored=${itemsStored}`);
} catch (e) {
    await finish([s], false, String(e));
}
