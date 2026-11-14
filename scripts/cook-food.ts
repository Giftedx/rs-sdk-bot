// Catherby Range Cooker: cooks raw lobsters, swordfish, trout, salmon, sharks at Catherby range.
// Catherby Range: 2816, 3443 (house next to bank). Catherby Bank: 2809, 3441 (7 tiles away).
// Usage: bun scripts/cook-food.ts <bot> [CAP ticks, default 15000] [FOOD_TYPE: lobster | swordfish | trout | salmon | shark]
// Environment: DEMO_OK=1 for live server.
import { openBot, finish, countItems } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import type { Session } from '../packages/core/src/inprocess';

export function sharkCookDelta(before: {raw:number;cooked:number;burnt:number}, after: typeof before) {
    const raw = before.raw-after.raw, cooked = after.cooked-before.cooked, burnt = after.burnt-before.burnt;
    if (raw < 1 || cooked < 0 || burnt < 0 || raw !== cooked+burnt) throw Error('shark cook deltas do not reconcile');
    return {raw,cooked,burnt};
}
// Cook only held raw383. Caller retains its session and bank/cleanup ownership.
export async function cookSharks(s: Session, stop: () => boolean) {
    if ((s.sdk.getSkill('Cooking')?.level ?? 0) < 80) throw Error('sharks require Cooking80');
    const counts = () => { const n=(id:number)=>s.sdk.getInventory().filter(i=>i.id===id).reduce((v,i)=>v+i.count,0);return {raw:n(383),cooked:n(385),burnt:n(387)}; };
    const before=counts(); let progress=s.tick(), last=before.raw;
    while(counts().raw>0) {
        if(stop())throw Error('shark cooking budget/health stop');
        if(s.tick()-progress>=40)throw Error('shark cooking no progress');
        const range=s.sdk.getState()?.nearbyLocs.find(l=>/^(range|cooking range)$/i.test(l.name)&&l.x===2817&&l.z===3443)
            ??s.sdk.getState()?.nearbyLocs.find(l=>/^(range|cooking range)$/i.test(l.name)&&Math.max(Math.abs(l.x-2816),Math.abs(l.z-3443))<=2);
        if(!range)throw Error('Catherby range unobserved');
        const raw=s.sdk.getInventory().find(i=>i.id===383)!;
        await s.sdk.sendUseItemOnLoc(raw.slot,range.x,range.z,range.id);
        await waitUntil(s,()=>stop()||counts().raw<last,{timeoutTicks:10});
        if(counts().raw<last){last=counts().raw;progress=s.tick();}
    }
    return before.raw ? sharkCookDelta(before,counts()) : {raw:0,cooked:0,burnt:0};
}

const RANGE_SPOT = { x: 2816, z: 3443 }; // Catherby range
const BANK_SPOT = { x: 2809, z: 3441 };  // Catherby bank

if (import.meta.main) {
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

    // 'empty' when the open bank, once its list has loaded, holds no raw food of this kind: the supply is used up.
    const bank = async (): Promise<'ok' | 'empty' | 'failed'> => {
        await walk(BANK_SPOT.x, BANK_SPOT.z, 2);
        const b = await s.bot.openBank();
        if (!b.success) {
            console.log(`WARN openBank failed: ${b.message}`);
            await waitTicks(s, 2);
            return 'failed';
        }

        // Deposit all cooked and burnt items
        await s.bot.depositItem(new RegExp(`(${FOOD_TYPE}|burnt)`, 'i'), -1);
        await waitTicks(s, 1);

        const loaded = await waitUntil(s, () => (s.sdk.getState()?.bank?.items?.length ?? 0) > 0, { timeoutTicks: 5 });
        const empty = loaded && !(s.sdk.getState()?.bank?.items ?? []).some((i: { name: string; count: number }) => rawRe.test(i.name) && i.count > 0);
        // Withdraw 28 raw food
        if (!empty) await s.bot.withdrawItem(rawRe, 28);
        bankTrips++;
        await s.bot.closeInterface();
        await waitTicks(s, 1);
        return empty ? 'empty' : 'ok';
    };

    console.log(`START food cooker ${botName} at=${pos()?.worldX},${pos()?.worldZ} food=${FOOD_TYPE}`);

    while (!over()) {
        if (rawCount() === 0) {
            const banked = await bank();
            // No raw food in the pack or the bank: the batch is done. Waiting here only ran the no-progress watchdog
            // out (900 idle ticks) and failed the chain that feeds this cook.
            if (banked === 'empty' && rawCount() === 0) { console.log(`STOP no raw ${FOOD_TYPE} left in the pack or the bank`); break; }
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
}
