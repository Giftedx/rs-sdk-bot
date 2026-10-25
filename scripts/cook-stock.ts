// Cook banked trout/salmon at Draynor. The far route is a matched measurement control only.
// bun scripts/cook-stock.ts <account> [CAP=3000]; RAW_RESERVE>=50, MAX_COOK, COOK_ROUTE=near|north|far.
import { openBot, finish, randomEventsOf } from '../packages/core/src/bot';
import { waitTicks, waitUntil } from '../packages/core/src/ticks';
import { walkPath, sessionWalker } from '../packages/core/src/walk';
import { bankCargo, exactItem } from '../packages/core/src/cargo';

const RAW_LEVEL: Record<string, number> = { 'raw trout': 15, 'raw salmon': 25 };
const RAW = /^raw (trout|salmon)$/i;
const PRODUCT = /^(trout|salmon|burnt fish)$/i;
const FOOD = /^(trout|salmon)$/i;
const BANK = { x: 3092, z: 3243 };
type Item = { id: number; name: string; count: number };

export function selectRawStock(bank: Item[], level: number, slots: number, reserve = 50, limit = Infinity): { id: number; name: string; amount: number }[] {
    let left = Math.max(0, Math.min(slots, limit));
    return bank.filter(i => level >= (RAW_LEVEL[i.name.toLowerCase()] ?? Infinity)).sort((a, b) => RAW_LEVEL[b.name.toLowerCase()]! - RAW_LEVEL[a.name.toLowerCase()]!).flatMap(i => {
        const amount = Math.min(left, Math.max(0, i.count - Math.max(50, reserve)));
        left -= amount;
        return amount > 0 ? [{ id: i.id, name: i.name, amount }] : [];
    });
}

export function depositPlan(inventory: Item[], protectedCounts: ReadonlyMap<number, number>): { item: Item; amount: number }[] {
    const seen = new Set<number>();
    return inventory.flatMap(item => {
        if (seen.has(item.id) || !PRODUCT.test(item.name)) return [];
        seen.add(item.id);
        const amount = inventory.filter(i => i.id === item.id).reduce((n, i) => n + i.count, 0) - (protectedCounts.get(item.id) ?? 0);
        return amount > 0 ? [{ item, amount }] : [];
    });
}

async function main() {
    const name = process.argv[2];
    const CAP = Number(process.argv[3] ?? process.env.CAP ?? 3000);
    const reserve = Math.max(50, Number(process.env.RAW_RESERVE ?? 50));
    const maximum = Number(process.env.MAX_COOK ?? Number.MAX_SAFE_INTEGER);
    const route = process.env.COOK_ROUTE ?? 'near';
    if (!name || !Number.isSafeInteger(CAP) || CAP <= 0 || !Number.isSafeInteger(reserve) || !Number.isSafeInteger(maximum) || maximum <= 0 || !['near', 'north', 'far'].includes(route)) throw new Error('usage: cook-stock.ts <account> [positive CAP]; RAW_RESERVE>=50 MAX_COOK>0 COOK_ROUTE=near|north|far');
    const fire = route === 'far' ? { x: 3214, z: 3249 } : route === 'north' ? { x: 3101, z: 3281 } : { x: 3100, z: 3256 };
    let requestedStop = false;
    const s = await openBot(name, { onStop: async () => { requestedStop = true; } }).catch(e => finish([], false, `login: ${String(e)}`));
    const synced = await waitUntil(s, () => (s.sdk.getSkill('Hitpoints')?.level ?? 0) > 0 && (s.sdk.getSkill('Cooking')?.baseLevel ?? 0) > 0, { timeoutTicks: 15 });
    if (!synced) await finish([s], false, 'skill sync timed out');
    const st = () => s.sdk.getState();
    const inv = () => s.sdk.getInventory();
    const countId = (id: number) => inv().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
    const rawCount = () => inv().filter(i => RAW.test(i.name)).reduce((n, i) => n + i.count, 0);
    const t0 = s.tick();
    const used = () => s.tick() - t0;
    let died = false, ended = false, returning = false;
    const life = st()?.player?.lifeId, respawns = st()?.player?.respawnCount ?? 0;
    let hpMin = s.sdk.getSkill('Hitpoints')?.level ?? 0;
    const off = s.onTick(() => {
        const p = st()?.player;
        hpMin = Math.min(hpMin, s.sdk.getSkill('Hitpoints')?.level ?? hpMin);
        if (p?.isDead || hpMin <= 0 || (p?.respawnCount ?? 0) > respawns || (life !== undefined && p?.lifeId !== life)) died = true;
    });
    void s.ended.then(() => { ended = true; });
    const over = () => died || ended || (!returning && requestedStop) || used() >= CAP + (returning ? 200 : 0);
    const protectedCounts = new Map<number, number>();
    for (const i of inv()) if (!RAW.test(i.name)) protectedCounts.set(i.id, (protectedCounts.get(i.id) ?? 0) + i.count);
    let processed = 0, banked = 0, burntBanked = 0, trips = 0, walkTicks = 0, cookTicks = 0, bankTicks = 0;
    let lastBank: Item[] = [], failure = '';
    const walk = async (points: { x: number; z: number; tol: number }[]) => {
        const t = s.tick();
        try {
            const r = await walkPath(await sessionWalker(s), points, { stop: over });
            if (!r.ok) throw new Error(`walk ${r.detail}`);
        } finally { walkTicks += s.tick() - t; }
    };
    const bankPath = route === 'far' ? [{ x: 3180, z: 3258, tol: 3 }, { x: 3100, z: 3285, tol: 3 }, { x: 3089, z: 3266, tol: 2 }, { x: 3092, z: 3250, tol: 1 }, { ...BANK, tol: 2 }]
        : [{ x: 3092, z: 3250, tol: 1 }, { ...BANK, tol: 2 }];
    const toFire = route === 'far' ? [...bankPath.slice(0, -1).reverse(), { x: fire.x + 1, z: fire.z, tol: 1 }]
        : [{ x: 3092, z: 3250, tol: 1 }, { x: fire.x - 1, z: fire.z, tol: 1 }];
    const bank = async (initial = false) => {
        const p = st()?.player;
        if (!p || p.level !== 0) throw new Error('cook-stock requires ground floor');
        // This fireplace-side tile cannot route directly through the closed house door.
        // The west exit step was verified in the live cooked-stock recovery.
        if(route==='near' && p.worldX===fire.x-1 && p.worldZ===fire.z)
            await walk([{x:fire.x-2,z:fire.z,tol:0}]);
        if (Math.max(Math.abs(p.worldX - BANK.x), Math.abs(p.worldZ - BANK.z)) > 2) await walk(bankPath);
        const t = s.tick();
        try {
            const b = await s.bot.openBank();
            if (!b.success) throw new Error(`bank: ${b.message}`);
            // Initial raw fish joins the bank before the reserve is computed. Other held assets stay held.
            const rawIds = [...new Set(inv().filter(i => RAW.test(i.name)).map(i => i.id))];
            for (const id of rawIds) {
                const item = inv().find(i => i.id === id)!;
                const result = await s.bot.depositItem(item, -1);
                if (countId(id) > 0) throw new Error(`raw deposit: ${result.message}`);
            }
            for (const { item, amount } of depositPlan(inv(), protectedCounts)) {
                const before = countId(item.id);
                await s.bot.depositItem(inv().find(i => i.id === item.id)!, amount);
                const actual = before - countId(item.id);
                if (FOOD.test(item.name)) banked += actual; else burntBanked += actual;
                if (actual !== amount) throw new Error(`partial product deposit ${item.name}: ${actual}/${amount}`);
            }
            lastBank = (st()?.bank?.items ?? []).map(i => ({ ...i }));
            trips++;
            if (!initial) console.log(`MILESTONE banked=${banked} burntBanked=${burntBanked} processed=${processed} trips=${trips} ticks=${used()}`);
            await bankCargo(s, [FOOD]);
            lastBank = (st()?.bank?.items ?? []).map(i => ({ ...i }));
        } finally { bankTicks += s.tick() - t; }
    };
    try {
        console.log(`START cook-stock route=${route} reserve=${reserve} maximum=${maximum} cooking=${s.sdk.getSkill('Cooking')?.level}`);
        await bank(true);
        while (!over() && processed < maximum) {
            const choices = selectRawStock(lastBank, s.sdk.getSkill('Cooking')?.level ?? 1, 28 - inv().length, reserve, maximum - processed);
            if (!choices.length) break;
            for (const choice of choices) await s.bot.withdrawItem(exactItem(choice.name), choice.amount, { asNote: false });
            await s.bot.closeBank();
            if (rawCount() === 0) throw new Error('withdraw made no progress');
            await walk(toFire);
            let stall = 0, previous = rawCount();
            const t = s.tick();
            while (rawCount() > 0 && !over() && stall < 12) {
                if (randomEventsOf(s)?.busy()) { await waitTicks(s, 1); continue; }
                const loc = st()?.nearbyLocs.find(l => l.id === 2724 && l.x === fire.x && l.z === fire.z);
                if (!loc) throw new Error(`missing fireplace2724 at ${fire.x},${fire.z}`);
                const raw = inv().find(i => RAW.test(i.name) && (s.sdk.getSkill('Cooking')?.level ?? 1) >= RAW_LEVEL[i.name.toLowerCase()]!);
                if (!raw) throw new Error('no eligible raw in inventory');
                if (s.sdk.getDialog()?.isOpen || st()?.interface?.isOpen) await s.direct({ type: 'closeModal', reason: 'SDK' });
                await s.direct({ type: 'useItemOnLoc', itemSlot: raw.slot, x: loc.x, z: loc.z, locId: loc.id, reason: 'SDK' });
                await waitTicks(s, 1);
                const current = rawCount();
                processed += Math.max(0, previous - current);
                stall = current < previous ? 0 : stall + 1;
                previous = current;
            }
            cookTicks += s.tick() - t;
            if (stall >= 12) throw new Error('cooking made no progress for12 ticks');
            returning = true;
            if (!died && !ended) await bank();
            returning = false;
        }
    } catch (e) { failure = String(e); }
    // A bounded return keeps partially cooked packs safe on a normal cap or stop.
    returning = true;
    if (!died && !ended && !st()?.bank?.isOpen) {
        try { await bank(); } catch (e) { failure ||= `final bank ${String(e)}`; }
    }
    off();
    const preserved = [...protectedCounts].every(([id, count]) => countId(id) >= count);
    if (!preserved) failure ||= 'held asset shortfall';
    const rawLeft = lastBank.filter(i => RAW.test(i.name)).map(i => `${i.name.replaceAll(' ', '_')}:${i.count}`).join(',') || '-';
    const cookedStock = lastBank.filter(i => FOOD.test(i.name)).map(i => `${i.name}:${i.count}`).join(',') || '-';
    await finish([s], !failure && !died && !ended && banked > 0,
        `route=${route} ticks=${used()} processed=${processed} banked=${banked} burntBanked=${burntBanked} rawLeft=${rawLeft} cookedStock=${cookedStock} trips=${trips} walkTicks=${walkTicks} cookTicks=${cookTicks} bankTicks=${bankTicks} hpMin=${hpMin} preserved=${preserved} died=${died} failure=${failure || '-'}`);
}
if (import.meta.main) await main();
