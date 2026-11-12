import { expect, test } from 'bun:test';
import { supervise } from '../packages/practice/src/supervise';
import { planShopPurchases, maximumUnitCost, buyWithBudget, PROFILES, shopTargetsMet, stockWaitStatus, shopFinishOk, dialogClick, blindBuyNow, blindBuyObserved, BLIND_SETTLE_TICKS, selectItems, profileRefusal, approachLegs } from './shop-buyer';

const target = (name: string, buyPerTick: number) => ({ re: new RegExp(`^${name}$`, 'i'), buyPerTick });
const item = (name: string, count = 100, buyPrice = 1) => ({ name, count, buyPrice });
test('full tools do not divide the remaining vial slots', () => {
    const plan = planShopPurchases([target('Vial of water', 25), target('Iron axe', 1), target('Tinderbox', 1)],
        [item('Vial of water'), item('Iron axe'), item('Tinderbox')], [{ name: 'Coins', count: 1000 }],
        new Map([['iron axe', 2], ['tinderbox', 2]]), 1000);
    expect(plan).toEqual([{ name: 'Vial of water', amount: 25 }]);
});
test('first load covers all useful types then fills the actual remaining slots', () => {
    const names = ['Vial of water', 'Ball of wool', 'Rope', 'Papyrus', 'Bronze arrow', 'Iron axe', 'Bronze pickaxe', 'Tinderbox'];
    const plan = planShopPurchases(names.map(n => target(n, /axe|tinderbox/i.test(n) ? 1 : 100)), names.map(n => item(n)),
        [{ name: 'Coins', count: 10000 }], new Map(), 10000);
    expect(plan).toHaveLength(8);
    expect(plan.reduce((n, i) => n + (/arrow/i.test(i.name) ? 1 : i.amount), 0)).toBe(27);
    expect(plan.find(i => i.name === 'Bronze arrow')?.amount).toBe(100);
});
test('purchase counts respect bank gaps, price, stock and exact coin budget', () => {
    expect(planShopPurchases([target('Vial of water', 25)], [item('Vial of water', 50, 5)], [], new Map([['vial of water', 497]]), 15))
        .toEqual([{ name: 'Vial of water', amount: 3 }]);
    expect(planShopPurchases([target('Vial of water', 25)], [item('Vial of water', 1, 5)], [], new Map(), 5))
        .toEqual([{ name: 'Vial of water', amount: 1 }]);
});


test('production cap limits the entire mixed purchase plan', () => {
    const plan = planShopPurchases([target('Feather', 50), target('Fishing bait', 50)], [item('Feather'), item('Fishing bait')], [], new Map(), 1000, 500, 7);
    expect(plan.reduce((n, i) => n + i.amount, 0)).toBe(7);
});

test('guarded purchase uses worst-stock cost and actual partial-fill debit, protecting reserve and spend cap', async () => {
    let coins = 6000, received = 0, dispatched = 0;
    const sdk = {
        getInventory: () => [{ name: 'Coins', count: coins }, { name: 'Chaos rune', count: received }],
        getState: () => ({ shop: { shopConfig: { sellMultiplier: 1000 }, shopItems: [{ name: 'Chaos rune', count: 100, baseCost: 100 }] } }),
    };
    expect(maximumUnitCost({ baseCost: 100 }, { sellMultiplier: 1000 })).toBe(600);
    const bot = { buyFromShop: async (_name: RegExp, amount: number) => {
        dispatched = amount;
        // Vendor maximum is600. A partial fill arrives despite a false SDK success result.
        received += 1; coins -= 550;
        return { success: false, amountBought: 1 };
    } };
    const result = await buyWithBudget(bot, sdk, 'Chaos rune', 10, 5000, 900);
    expect(dispatched).toBe(1);
    expect(result).toEqual({ bought: 1, spent: 550 });
    expect(coins).toBe(5450);
    expect(await buyWithBudget(bot, sdk, 'Chaos rune', 10, 5000, 350)).toEqual({ bought: 0, spent: 0 });
    expect(dispatched).toBe(1);
});

test('missing shop config cannot guess a guarded unit cost', () => {
    expect(() => maximumUnitCost({ baseCost: 100 }, undefined)).toThrow('missing validated');
});

test('Betty profile maps only actual NPC magicshop commodities, including body runes', () => {
    const names = ['Fire rune', 'Water rune', 'Air rune', 'Earth rune', 'Mind rune', 'Body rune', 'Chaos rune', 'Death rune', 'Eye of newt'];
    expect(PROFILES.betty!.items).toHaveLength(names.length);
    for (const name of names) expect(PROFILES.betty!.items.some(i => i.re.test(name))).toBe(true);
    expect(PROFILES.betty!.npc.test('Betty')).toBe(true);
});


test('already met Betty goals with zero new purchases finish successfully once, not twenty relogins', async () => {
    const names = ['Fire rune', 'Water rune', 'Air rune', 'Earth rune', 'Mind rune', 'Body rune', 'Chaos rune', 'Death rune', 'Eye of newt'];
    const stock = new Map(names.map(n => [n.toLowerCase(), 20]));
    const met = shopTargetsMet(PROFILES.betty!.items, [{ name: 'Coins', count: 20000 }], stock, 20);
    expect(met).toBe(true);
    const ok = shopFinishOk(0, met, 'stock-target');
    expect(ok).toBe(true);
    let logins = 0;
    const result = await supervise({ run: async () => { logins++; return { stdout: `RESULT ${ok ? 'ok' : 'fail'} boughtTotal=0 stop=stock-target targetMet=${met ? 1 : 0}`, exitCode: ok ? 0 : 1 }; }, stopped: () => false, pause: async () => { throw new Error('unexpected relogin'); }, maxRestarts: 20 });
    expect(result).toEqual({ reason: 'done', runs: 1 });
    expect(logins).toBe(1);
    stock.delete('death rune');
    expect(shopTargetsMet(PROFILES.betty!.items, [], stock, 20)).toBe(false);
    expect(shopFinishOk(0, false, 'stock-target')).toBe(false);
});

test('opt-in stock wait checks twice over25ticks without repeated opens, then cleanly goes offline with target unmet', async () => {
    let tick = 100, since: number | undefined;
    const waits: number[] = [];
    let checks = 0;
    for (;;) {
        const state = stockWaitStatus(tick, since, 25);
        if (state.done) break;
        since = state.since;
        checks++;
        waits.push(state.waitTicks);
        tick += state.waitTicks;
    }
    expect(waits).toEqual([15, 10]);
    expect(checks).toBe(2);
    expect(tick).toBe(125);
    expect(shopFinishOk(0, false, 'stock-wait')).toBe(true);
    expect(shopTargetsMet(PROFILES.betty!.items, [], new Map(), 20)).toBe(false);
    const r = await supervise({ run: async () => ({ stdout: 'RESULT ok boughtTotal=0 stop=stock-wait targetMet=0 noBuyTicks=25', exitCode: 0 }), stopped: () => false, pause: async () => { throw new Error('unexpected stock retry'); }, maxRestarts: 20 });
    expect(r.runs).toBe(1);
});

test('default stock wait remains unbounded and a new purchase resets its interval', () => {
    expect(stockWaitStatus(10000, 0, 0)).toMatchObject({ done: false, waitTicks: 15 });
    expect(stockWaitStatus(125, undefined, 25)).toEqual({ since: 125, done: false, waitTicks: 15 });
    expect(shopFinishOk(0, false, 'cap')).toBe(false);
});

test('quest-input profiles target only exact primary-source gloves and cheese, one unit each',()=>{
    const cases=[['thessalia','Thessalia','Leather gloves',3204,3417,3253,3420,6],['wydin','Wydin','Cheese',3014,3204,3092,3243,4]] as const;
    for(const [key,npc,name,x,z,bx,bz,cost]of cases){
        const p=PROFILES[key]!;expect(p.npc.test(npc)).toBe(true);expect(p.npc.test('Other '+npc)).toBe(false);
        expect(p.npcSpot).toEqual({x,z});expect(p.bankSpot).toEqual({x:bx,z:bz});expect(p.items).toHaveLength(1);
        expect(p.items[0]!.buyPerTick).toBe(1);expect(p.items[0]!.re.test(name)).toBe(true);expect(p.items[0]!.re.test('Extra '+name)).toBe(false);
        const shop=[item(name,10,cost),item('Silk'),item('Chocolate bar')],inventory=[{name:'Coins',count:5050},{name:'Trout',count:2}];
        expect(planShopPurchases(p.items,shop,inventory,new Map(),50,1,1)).toEqual([{name,amount:1}]);
        expect(maximumUnitCost({baseCost:cost},{sellMultiplier:1000})).toBeLessThanOrEqual(50);
        expect(shopTargetsMet(p.items,inventory,new Map(),1)).toBe(false);
        const bank=new Map([[name.toLowerCase(),1]]);expect(shopTargetsMet(p.items,inventory,bank,1)).toBe(true);
        expect(planShopPurchases(p.items,shop,inventory,bank,50,1,1)).toEqual([]);
    }
});
test("ITEMS='blood rune' selects exactly the magic guild blood line", () => {
    const guild = PROFILES.magic_guild!;
    const picked = selectItems(guild.items, 'blood rune');
    expect(picked).toHaveLength(1);
    expect(picked[0]!.re.test('Blood rune')).toBe(true);
    expect(picked[0]!.buyPerTick).toBe(100);
    for (const other of ['Death rune', 'Law rune', 'Fire rune', 'Nature rune', 'Staff of fire']) expect(picked[0]!.re.test(other)).toBe(false);
    expect(selectItems(guild.items, 'death rune').map(i => i.re.source)).toEqual(['^death rune$']);
    expect(selectItems(guild.items, undefined)).toBe(guild.items);
    // 100 runes from 0 owned at the worst-stock price of 300 (blood rune cost 50, shop sell multiplier 1000) fit 30000.
    expect(maximumUnitCost({ baseCost: 50 }, { sellMultiplier: 1000 })).toBe(300);
    expect(planShopPurchases(picked, [item('Blood rune', 1000, 50), item('Death rune', 1000, 30)], [{ name: 'Coins', count: 20000 }], new Map(), 18000, 100, 100))
        .toEqual([{ name: 'Blood rune', amount: 100 }]);
});

test('magic guild keeps its fire, nature, air, law and staff lines, endpoints and NPC', () => {
    const guild = PROFILES.magic_guild!;
    expect(guild.npc.test('Magic Store owner')).toBe(true);
    expect(guild.npcSpot).toEqual({ x: 2595, z: 3087, level: 1 });
    expect(guild.bankSpot).toEqual({ x: 2612, z: 3093 });
    expect(guild.items.map(i => [i.re.source, i.buyPerTick])).toEqual([
        ['^staff of fire$', 1], ['^fire rune$', 100], ['^nature rune$', 100], ['^air rune$', 100], ['^law rune$', 50], ['^blood rune$', 100], ['^death rune$', 100]]);
    expect(selectItems(guild.items, 'air rune').map(i => i.re.source)).toEqual(['^air rune$']);
    expect(selectItems(guild.items, 'fire rune|nature rune|law rune').map(i => i.re.source)).toEqual(['^fire rune$', '^nature rune$', '^law rune$']);
});

test('magic guild refuses below Magic 66 and when the level is unobserved; other profiles never refuse', () => {
    const guild = PROFILES.magic_guild!;
    expect(profileRefusal('magic_guild', guild, 60)).toBe('magic guild needs Magic 66');
    expect(profileRefusal('magic_guild', guild, 65)).toBe('magic guild needs Magic 66');
    expect(profileRefusal('magic_guild', guild, undefined)).toBe('magic guild needs Magic 66');
    expect(profileRefusal('magic_guild', guild, 66)).toBeNull();
    expect(profileRefusal('magic_guild', guild, 74)).toBeNull();
    for (const key of ['catherby', 'sarim', 'ardy', 'zaff', 'khazard_paste', 'aubury', 'betty']) expect(profileRefusal(key, PROFILES[key]!, 1)).toBeNull();
});

test('magic guild far trip goes by the Port Sarim and Ardougne docks only from far away', () => {
    const guild = PROFILES.magic_guild!;
    expect(guild.fare).toBe(60);
    expect(approachLegs(guild.via, { x: 3185, z: 3436 }, guild.bankSpot)).toEqual([{ x: 3028, z: 3221 }, { x: 2683, z: 3271 }]);
    expect(approachLegs(guild.via, { x: 2654, z: 3283 }, guild.bankSpot)).toEqual([{ x: 2683, z: 3271 }]);
    expect(approachLegs(guild.via, guild.bankSpot, guild.npcSpot)).toEqual([]);
    expect(approachLegs(guild.via, { x: 2595, z: 3087 }, guild.bankSpot)).toEqual([]);
    for (const key of ['catherby', 'sarim', 'ardy', 'zaff', 'khazard_paste']) expect(approachLegs(PROFILES[key]!.via, { x: 3185, z: 3436 }, PROFILES[key]!.bankSpot)).toEqual([]);
});

test('existing shop profiles retain their NPC, route endpoints and commodity counts',()=>{
    const cases=[['ardy','Aemad',2613,3294,2654,3283,8],['catherby','Hickton',2821,3444,2809,3441,4],['sarim','Gerrant',3013,3225,3092,3243,4],['betty','Betty',3012,3259,3092,3243,9],['taverley','Jatix',2908,3443,2934,3376,4],['general_sarim','Shopkeeper',3014,3205,3092,3243,5],['aubury','Aubury',3253,3402,3253,3420,8],['zeke','Zeke',3288,3190,3269,3167,4],['nurmof','Nurmof',2998,9844,3013,3355,6]] as const;
    for(const [key,npc,x,z,bx,bz,n]of cases){const p=PROFILES[key]!;expect(p.npc.test(npc)).toBe(true);expect(p.npcSpot).toEqual({x,z});expect(p.bankSpot).toEqual({x:bx,z:bz});expect(p.items).toHaveLength(n);}
});

test("Jakut's shelf of 2 dragon longswords bounds the unit price, so a reserve allows the tenth sword of 1,019,000 coins", async () => {
    const p = PROFILES.jukat!;
    expect(p.npc.test('Jakut')).toBe(true);
    expect(p.items).toEqual([{ re: /^dragon longsword$/i, buyPerTick: 2, shelf: 2 }]);
    expect(p.realm!.inside({ worldX: 3220, worldZ: 9592 })).toBe(true);
    expect(p.realm!.inside({ worldX: 3201, worldZ: 3169 })).toBe(false);
    expect(p.realm!.wear.test('Dramen staff')).toBe(true);
    const config = { sellMultiplier: 1000, haggle: 10 };
    expect(maximumUnitCost({ baseCost: 100000 }, config)).toBe(600000);
    expect(maximumUnitCost({ baseCost: 100000 }, config, 2)).toBe(101000);
    expect(maximumUnitCost({ baseCost: 100000 }, { sellMultiplier: 1000 }, 2)).toBe(600000);
    // Server prices (shop.rs2 calc_shop_value): 100,000 from a stock of 2, 101,000 from a stock of 1.
    let coins = 1_019_000, held = 0, shelf = 2;
    const sdk = {
        getInventory: () => [{ name: 'Coins', count: coins }, ...Array.from({ length: held }, () => ({ name: 'Dragon longsword', count: 1 }))],
        getState: () => ({ shop: { shopConfig: config, shopItems: [{ name: 'Dragon longsword', count: shelf, baseCost: 100000 }] } }),
    };
    const bot = { buyFromShop: async (_: RegExp, amount: number) => { for (let i = 0; i < amount && shelf > 0; i++) { coins -= shelf === 2 ? 100000 : 101000; shelf--; held++; } } };
    for (let round = 0; round < 20; round++) {
        await buyWithBudget(bot, sdk, 'Dragon longsword', 2, 5000, Infinity, 2);
        shelf = Math.min(2, shelf + 1);
    }
    expect(held).toBe(10);
    expect(coins).toBe(10000);
    expect(shopTargetsMet(p.items, sdk.getInventory(), new Map([['dragon longsword', 4]]), 14)).toBe(true);
    expect(shopTargetsMet(p.items, sdk.getInventory(), new Map(), 14)).toBe(false);
});

test('the ladder talk continues each line and takes the leave choice', () => {
    const say = PROFILES.jukat!.realm!.ladder.say;
    expect(dialogClick(null, say)).toBe(null);
    expect(dialogClick({ isOpen: true, isWaiting: true, options: [] }, say)).toBe(null);
    expect(dialogClick({ isOpen: true, isWaiting: false, options: [{ index: 0, text: 'Click here to continue' }] }, say)).toBe(0);
    expect(dialogClick({ isOpen: true, isWaiting: false, options: [{ index: 1, text: "I think I'll stay down here a bit longer." }, { index: 2, text: "Yes, I'm ready to leave." }] }, say)).toBe(2);
});

test('a blind request needs room for one more unit than the requests still open', () => {
    const base = { unit: 101000, wallet: 400000, reserve: 5000, remainingSpend: Infinity, remainingItems: Infinity, wanted: 5, freeSlots: 20, pending: 0 };
    expect(blindBuyNow(base)).toBe(true);
    expect(blindBuyNow({ ...base, pending: 2 })).toBe(true); // coins for 3 units
    expect(blindBuyNow({ ...base, pending: 3 })).toBe(false);
    expect(blindBuyNow({ ...base, wallet: 105999 })).toBe(false); // the reserve leaves 100,999
    expect(blindBuyNow({ ...base, wallet: 106000 })).toBe(true);
    expect(blindBuyNow({ ...base, wallet: 106000, pending: 1 })).toBe(false);
    expect(blindBuyNow({ ...base, remainingSpend: 100999 })).toBe(false);
    expect(blindBuyNow({ ...base, remainingItems: 1, pending: 1 })).toBe(false);
    expect(blindBuyNow({ ...base, wanted: 0 })).toBe(false);
    expect(blindBuyNow({ ...base, freeSlots: 0 })).toBe(false);
    expect(blindBuyNow({ ...base, unit: 0 })).toBe(false);
});

test('blind purchases are counted from the pack and the coins, and a broken bound throws', () => {
    const base = { coins: 400000, held: 1, unit: 101000 };
    expect(blindBuyObserved(base, { coins: 400000, held: 1 }, 5000, Infinity)).toEqual({ bought: 0, spent: 0 });
    expect(blindBuyObserved(base, { coins: 299000, held: 2 }, 5000, Infinity)).toEqual({ bought: 1, spent: 101000 });
    expect(blindBuyObserved(base, { coins: 199000, held: 3 }, 5000, 201000)).toEqual({ bought: 2, spent: 201000 });
    expect(() => blindBuyObserved(base, { coins: 298999, held: 2 }, 5000, Infinity)).toThrow('shop budget violated');
    // A pack read that misses items for a tick, and the read after it: nothing is counted.
    expect(blindBuyObserved(base, { coins: 400000, held: 0 }, 5000, Infinity)).toEqual({ bought: 0, spent: 0 });
    expect(blindBuyObserved(base, { coins: 400000, held: 2 }, 5000, Infinity)).toEqual({ bought: 0, spent: 0 });
    expect(blindBuyObserved(base, { coins: 399000, held: 1 }, 5000, Infinity)).toEqual({ bought: 0, spent: 0 });
    expect(() => blindBuyObserved(base, { coins: 299000, held: 2 }, 300000, Infinity)).toThrow('shop budget violated');
    expect(() => blindBuyObserved(base, { coins: 299000, held: 2 }, 5000, 100000)).toThrow('shop budget violated');
});

// The engine's order (World.ts): a request sent after tick T's output runs in tick T+1, the pack update arrives with
// tick T+1's output, and a unit comes back at the end of each tick that `restock` divides.
function blindRun(o: { wallet: number; reserve: number; maxItems: number; wanted: number; shelf: number; restock: number; ticks: number; lag?: number }) { // lag: ticks a request is late
    let coins = o.wallet, held = 0, shelf = o.shelf, requests = 0;
    let seen = { coins, held }, sent: number[] = [];
    const inFlight: number[] = [], updates: { at: number; coins: number; held: number }[] = [], boughtAt: number[] = [];
    for (let tick = 1; tick <= o.ticks; tick++) {
        // engine tick: the requests that arrive, then the restock
        for (let i = inFlight.length - 1; i >= 0; i--) if (inFlight[i]! <= tick) {
            inFlight.splice(i, 1);
            const price = shelf >= 2 ? 100000 : 101000;
            if (shelf > 0 && coins >= price) { shelf--; coins -= price; held++; boughtAt.push(tick); }
        }
        updates.push({ at: tick, coins, held });
        if (tick % o.restock === 0 && shelf < 2) shelf++;
        // worker tick: look, then decide
        for (const u of updates.filter(u => u.at <= tick)) seen = { coins: u.coins, held: u.held };
        sent = sent.filter(t => tick - t < BLIND_SETTLE_TICKS);
        if (blindBuyNow({ unit: 101000, wallet: seen.coins, reserve: o.reserve, remainingSpend: Infinity, remainingItems: o.maxItems - seen.held,
            wanted: o.wanted - seen.held, freeSlots: 27 - seen.held, pending: sent.length })) { requests++; sent.push(tick); inFlight.push(tick + 1 + (o.lag ?? 0)); }
    }
    return { coins, held, requests, boughtAt };
}

test('a blind run takes the full shelf, then each unit on the tick after it comes back', () => {
    const run = blindRun({ wallet: 1_019_000, reserve: 5000, maxItems: Infinity, wanted: 10, shelf: 2, restock: 500, ticks: 1600 });
    expect(run.boughtAt).toEqual([2, 3, 501, 1001, 1501]);
    expect(run.requests).toBe(1600);
});

test('a blind run never passes the item cap, the stock target or the reserve, with a request one tick late too', () => {
    for (const lag of [0, 1]) {
        // room for one unit, two units on the shelf: one request open at a time
        expect(blindRun({ wallet: 1_019_000, reserve: 5000, maxItems: 1, wanted: 10, shelf: 2, restock: 500, ticks: 40, lag }).held).toBe(1);
        expect(blindRun({ wallet: 1_019_000, reserve: 5000, maxItems: Infinity, wanted: 1, shelf: 2, restock: 500, ticks: 40, lag }).held).toBe(1);
        const poor = blindRun({ wallet: 207_000, reserve: 5000, maxItems: Infinity, wanted: 10, shelf: 2, restock: 5, ticks: 60, lag });
        expect(poor.held).toBe(2);
        expect(poor.coins).toBeGreaterThanOrEqual(5000);
        const paid = blindRun({ wallet: 110_000, reserve: 5000, maxItems: Infinity, wanted: 10, shelf: 2, restock: 5, ticks: 60, lag });
        expect(paid).toMatchObject({ held: 1, coins: 10000 });
    }
});

test('the dommik profile buys a ring mould and a chisel at the Al Kharid crafting store', () => {
    const p = PROFILES.dommik!;
    expect(p.npc.test('Dommik')).toBe(true);
    expect(p.items.map(i => [i.re.test('Ring mould'), i.re.test('Chisel')])).toEqual([[true, false], [false, true]]);
    expect(p.items.map(i => i.shelf)).toEqual([4, 2]);
    expect(p.bankSpot).toEqual({ x: 3269, z: 3167 });
});
