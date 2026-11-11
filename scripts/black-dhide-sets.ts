// Black dragonhide armour from banked hides: tanned at the Al Kharid tanner, crafted into sets at the Al Kharid bank.
// bun scripts/black-dhide-sets.ts <account>      SETS=0 (how many sets; 0: as many as the hides and leather make)
// Server facts:
// - The Tanner (npc 804, spawn 3276,3193) makes black dragon leather (2509) of a black dragonhide (1747) for 20 coins
//   (areas/area_alkharid tanner.rs2; scripts/microbot-c-tanner.ts).
// - A set is a body (3 leather, Crafting 84), chaps (2, Crafting 82) and vambraces (1, Crafting 79), made with a needle
//   (1733) and thread (1734, five makes a reel) (skill_crafting/configs/leather/leather.dbrow). To wear a piece asks
//   Ranged 70, and the body Defence 40; no quest (levelrequire/scripts/tier70.rs2).
// - Dommik's crafting store (npc 545, spawn 3322,3194) sells needles (3 in stock) and thread (100, one back every 5
//   ticks) (alkharid.inv craftingshop2).
// The run banks its pack at Al Kharid, tans what the sets still need in leather (27 hides a trip), buys a needle and
// thread at Dommik's when the bank has none, and crafts the sets at the bank one piece at a time
// (scripts/microbot-production.ts runInventoryBank). Hides short of a whole set stay hides.
import { openQuest } from './generated/quest-lib';
import { walkTargetPersist } from './walk-to';
import { tanInventory, tanningRecipes } from './microbot-c-tanner';
import { inventoryRecipes, runInventoryBank } from './microbot-production';

export const BLACK_HIDE = tanningRecipes.black.input, BLACK_LEATHER = tanningRecipes.black.output, TAN_COST = tanningRecipes.black.cost;
export const NEEDLE = 1733, THREAD = 1734, COINS = 995, THREAD_MAKES = 5;
// A set's pieces, the hardest first: an account that cannot make the body makes nothing.
export const SET_PIECES = [
    { recipe: 'leather:black_dragonhide_body', product: 2503, leather: 3, level: 84 },
    { recipe: 'leather:black_dragonhide_chaps', product: 2497, leather: 2, level: 82 },
    { recipe: 'leather:black_dragon_vambraces', product: 2491, leather: 1, level: 79 },
] as const;
export const SET_LEATHER = SET_PIECES.reduce((n, p) => n + p.leather, 0), SET_LEVEL = Math.max(...SET_PIECES.map(p => p.level));
export const TAN_TRIP = 27, SHOP_COINS = 100;
const AL_KHARID_BANK = { x: 3269, z: 3167, level: 0 }, TANNER = { x: 3274, z: 3191, level: 0 }, DOMMIK = { x: 3320, z: 3194, level: 0 };

// What a run does with the account's stock: the sets it makes, the hides it tans for them and the thread it buys (a
// reel more than the makes use: a reel the account began earlier ends early).
export function setPlan(want: number, hides: number, leather: number, thread: number, coins: number): { sets: number; tan: number; thread: number; coins: number } {
    if (![want, hides, leather, thread, coins].every(n => Number.isSafeInteger(n) && n >= 0)) return { sets: 0, tan: 0, thread: 0, coins: 0 };
    let sets = Math.floor((hides + leather) / SET_LEATHER);
    if (want > 0) sets = Math.min(sets, want);
    const cost = (n: number) => { const tan = Math.max(0, n * SET_LEATHER - leather), buy = Math.max(0, Math.ceil(n * SET_PIECES.length / THREAD_MAKES) + 1 - thread); return { sets: n, tan, thread: buy, coins: tan * TAN_COST + (buy > 0 ? SHOP_COINS : 0) }; };
    while (sets > 0 && cost(sets).coins > coins) sets--;
    return cost(sets);
}

if (import.meta.main) {
    const want = Number(process.env.SETS ?? 0);
    const q = await openQuest({ cap: 4000, eatAt: 50, lumbridgeOk: true });
    try {
        if (!Number.isSafeInteger(want) || want < 0 || want > 50) await q.fail('SETS 0-50');
        const s = q.s, start = s.tick();
        const held = (id: number) => s.sdk.getInventory().filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const banked = (id: number) => (s.bankObservation?.()?.items ?? []).filter(i => i.id === id).reduce((n, i) => n + i.count, 0);
        const level = s.sdk.getSkill('Crafting')?.level ?? 1;
        if (level < SET_LEVEL) await q.fail(`Crafting ${level}, a set asks ${SET_LEVEL}`);
        const openBank = async (label: string) => {
            const generation = s.bankObservation?.()?.generation ?? 0;
            if (!(await s.bot.openBank()).success || !await q.waitUntil(() => !!q.st()?.bank?.isOpen && (s.bankObservation?.()?.generation ?? 0) > generation, 20)) await q.fail(`${label}: bank did not open`);
        };
        const closeBank = async () => { await s.bot.closeBank(); await q.waitUntil(() => !q.st()?.bank?.isOpen, 10); await q.waitTicks(2); };
        const bankPack = async (label: string) => {
            for (const id of new Set(s.sdk.getInventory().map(i => i.id))) {
                const row = s.sdk.getInventory().find(i => i.id === id);
                if (row && (!(await s.bot.depositItem(row, held(id))).success || !await q.waitUntil(() => held(id) === 0, 10))) await q.fail(`${label}: deposit of item ${id}`);
            }
        };
        const take = async (id: number, n: number) => {
            if (n < 1) return;
            const row = (q.st()?.bank?.items ?? []).find((i: { id: number }) => i.id === id), before = held(id);
            if (!row || banked(id) < n) await q.fail(`withdraw: ${n} of item ${id} short in the bank (${banked(id)} banked)`);
            if (!(await s.bot.withdrawItem(row!, n, { asNote: false })).success || !await q.waitUntil(() => held(id) >= before + n, 10)) await q.fail(`withdraw ${n} of item ${id}`);
        };
        const go = async (to: { x: number; z: number; level: number }, label: string) => {
            const out = await walkTargetPersist(s, to);
            if (!out.ok) await q.fail(`route to ${label}: ${out.reason ?? ''} ${out.detail ?? ''}`);
        };
        // 1. The bank: the pack in, and the plan from what the bank holds.
        await go(AL_KHARID_BANK, 'the Al Kharid bank');
        await openBank('stage');
        await bankPack('stage');
        const plan = setPlan(want, banked(BLACK_HIDE), banked(BLACK_LEATHER), banked(THREAD), banked(COINS));
        const needle = banked(NEEDLE) < 1;
        if (plan.sets < 1) { await closeBank(); await q.fail(`no set: ${banked(BLACK_HIDE)} hides, ${banked(BLACK_LEATHER)} leather, ${banked(COINS)} coins, a set is ${SET_LEATHER} leather`); }
        q.milestone(`plan sets=${plan.sets} tan=${plan.tan} thread=${plan.thread}`);
        // 2. The tanner, TAN_TRIP hides a trip.
        let tanned = 0, spent = 0;
        while (tanned < plan.tan) {
            const n = Math.min(TAN_TRIP, plan.tan - tanned);
            await take(BLACK_HIDE, n); await take(COINS, n * TAN_COST);
            await closeBank();
            await go(TANNER, 'the tanner');
            const r = await tanInventory(s, 'black', n, 60 + n * 12);
            tanned += r.made; spent += r.coinsSpent;
            if (!r.ok) await q.fail(`tanning: ${r.detail} made=${r.made} of ${n}`);
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('tanned'); await bankPack('tanned');
        }
        if (plan.tan) q.milestone(`tanned ${tanned}`);
        // 3. A needle and thread from Dommik when the bank has none.
        if (needle || plan.thread > 0) {
            await take(COINS, Math.min(SHOP_COINS, banked(COINS)));
            await closeBank();
            await go(DOMMIK, "Dommik's store");
            const shop = await s.bot.openShop(/^dommik$/i);
            if (!shop.success) await q.fail(`dommik shop: ${shop.message}`);
            const coins = held(COINS);
            if (needle) { await s.bot.buyFromShop(/^needle$/i, 1); await q.waitUntil(() => held(NEEDLE) > 0, 6); }
            if (plan.thread > 0) { await s.bot.buyFromShop(/^thread$/i, plan.thread); await q.waitUntil(() => held(THREAD) >= plan.thread, 6); }
            await s.bot.closeShop(); await q.waitTicks(2);
            spent += coins - held(COINS);
            if (needle && held(NEEDLE) < 1 || held(THREAD) < plan.thread) await q.fail(`dommik: needle=${held(NEEDLE)} thread=${held(THREAD)} of ${plan.thread}`);
            q.milestone('needle and thread');
            await go(AL_KHARID_BANK, 'the Al Kharid bank');
            await openBank('shop'); await bankPack('shop');
        }
        await closeBank();
        // 4. The sets, one piece a bank visit.
        const made: number[] = [];
        for (const piece of SET_PIECES) {
            const recipe = inventoryRecipes().find(r => r.name === piece.recipe);
            if (!recipe) await q.fail(`no recipe ${piece.recipe}`);
            const r = await runInventoryBank(s, recipe!, { maximum: plan.sets, cap: 100 + plan.sets * 40, maxAttempts: plan.sets, members: true });
            made.push(r.made);
            if (!r.ok) await q.fail(`craft ${piece.recipe}: ${r.failure} made=${r.made} of ${plan.sets}`);
        }
        await openBank('end'); await bankPack('end');
        const sets = Math.min(...SET_PIECES.map(p => banked(p.product))), hidesLeft = banked(BLACK_HIDE), leatherLeft = banked(BLACK_LEATHER);
        await closeBank();
        await q.end(made.every(n => n === plan.sets), `sets=${plan.sets} banked=${sets} bodies=${made[0]} chaps=${made[1]} vambraces=${made[2]} tanned=${tanned} spent=${spent} hidesLeft=${hidesLeft} leatherLeft=${leatherLeft} crafting=${s.sdk.getSkill('Crafting')?.level ?? 0} ticks=${s.tick() - start}`);
    } catch (e) { await q.fail(String(e)); }
}
