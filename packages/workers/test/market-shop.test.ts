import { describe, expect, test } from 'bun:test';
import { supervise } from '../../practice/src/supervise';
import type { Session } from '../../core/src/inprocess';
import { expandPath } from '../../core/src/walk';
import {
    BLIND_SETTLE_TICKS,
    PROFILES,
    approachLegs,
    approachShop,
    blindBuyNow,
    blindBuyObserved,
    buyEarthObserved,
    buyWithBudget,
    contentUnitBound,
    dialogClick,
    earthRefillAmount,
    earthRefillStop,
    earthSeedNeeded,
    handleDialogShopOpen,
    lastUnitPrice,
    maximumUnitCost,
    nativeMerchant,
    observeMerchantQuote,
    openEarthBankObserved,
    planShopPurchases,
    profileRefusal,
    retainedEarthBank,
    runDialogBuyStep,
    runOwnedSword,
    runOwnedSwordFromEast,
    runShopSale,
    selectItems,
    sellEarthSeedObserved,
    shopFinishOk,
    shopRules,
    shopSaleEffect,
    shopTargetsMet,
    shopTripProfile,
    shopTripStop,
    shopUnitPrice,
    stockWaitStatus,
    swordQuote,
    swordTileSafe,
    unitBound,
    validateShopSale,
    validateShopTrip,
    type ShopSaleOptions,
    type ShopTripJob,
} from '../src/market';

const target = (name: string, buyPerTick: number) => ({ re: new RegExp(`^${name}$`, 'i'), buyPerTick });
const item = (name: string, count = 100, buyPrice = 1) => ({ name, count, buyPrice });

test('finite artisan tool targets retain one owned tool and buy only the missing other tool', () => {
    const targets=selectItems(PROFILES.dommik!.items,'ring mould|chisel'),bank=new Map([['chisel',1]]),shop=[item('Ring mould',4),item('Chisel',2)];
    expect(planShopPurchases(targets,shop,[],bank,20,1,2)).toEqual([{name:'Ring mould',amount:1}]);
    expect(shopTargetsMet(targets,[{name:'Ring mould',count:1}],bank,1)).toBe(true);
    expect(shopTargetsMet(targets,[],bank,1)).toBe(false);
    expect(planShopPurchases(targets,shop,[],new Map([['ring mould',1],['chisel',1]]),20,1,2)).toEqual([]);
    expect(shopTargetsMet(targets,[],new Map([['ring mould',1],['chisel',1]]),500)).toBe(false);
});
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
        // Vendor maximum is 600. A partial fill arrives despite a false SDK success result.
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

test('opt-in stock wait checks twice over 25 ticks without repeated opens, then cleanly goes offline with target unmet', async () => {
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

test('Jakut pays one toll before the first shop walk and skips payment after the observed crossing',async()=>{
    const from={worldX:3154,worldZ:9577},events:unknown[]=[];
    const pay=async()=>{events.push('toll');from.worldX=3238;from.worldZ=9558;return true;};
    const walk=async(x:number,z:number,tol:number,level:number)=>{events.push(['walk',x,z,tol,level]);return true;};
    expect(await approachShop(PROFILES.jukat!,from,walk,pay)).toBe(true);
    expect(await approachShop(PROFILES.jukat!,from,walk,pay)).toBe(true);
    expect(events).toEqual(['toll',['walk',3252,9572,2,0],['walk',3252,9572,2,0]]);
});

test.each(['jukat','catherby'])('a reached cap before the %s approach pays no toll and starts no walk',async profile=>{
    const events:string[]=[];
    expect(await approachShop(PROFILES[profile]!,{worldX:3154,worldZ:9577},async()=>{events.push('walk');return true;},async()=>{events.push('toll');return true;},()=>true)).toBe(false);
    expect(events).toEqual([]);
});

test('a cap reached during the paid crossing starts no NPC walk',async()=>{
    const events:string[]=[];let stopped=false;
    const paid=await approachShop(PROFILES.jukat!,{worldX:3154,worldZ:9577},async()=>{events.push('walk');return true;},async()=>{events.push('toll');stopped=true;return true;},()=>stopped);
    expect(paid).toBe(false);expect(events).toEqual(['toll']);
});

test.each([3238,3252])('a Jakut shop-side entry at x=%i needs no second diamond',async worldX=>{
    let walks=0;
    expect(await approachShop(PROFILES.jukat!,{worldX,worldZ:9572},async()=>{walks++;return true;},async()=>{throw Error('unexpected second toll');})).toBe(true);
    expect(walks).toBe(1);
});

test('an unobserved toll crossing cannot start the NPC walk',async()=>{
    let walks=0;
    await expect(approachShop(PROFILES.jukat!,{worldX:3154,worldZ:9577},async()=>{walks++;return true;},async()=>false)).rejects.toThrow('realm toll: crossing unobserved');
    expect(walks).toBe(0);
});

test('a missing toll diamond keeps the prerequisite failure before any NPC walk',async()=>{
    let walks=0;
    await expect(approachShop(PROFILES.jukat!,{worldX:3154,worldZ:9577},async()=>{walks++;return true;},async()=>{throw Error('realm toll: no diamond in the pack or in the bank');})).rejects.toThrow('realm toll: no diamond');
    expect(walks).toBe(0);
});

test.each(['catherby','sarim','betty'])('ordinary %s shop approaches retain their single walk without a toll',async name=>{
    const profile=PROFILES[name]!,walks:unknown[]=[];
    expect(await approachShop(profile,{worldX:3154,worldZ:9577},async(...args)=>{walks.push(args);return false;},async()=>{throw Error('unexpected realm toll');})).toBe(false);
    expect(walks).toEqual([[profile.npcSpot.x,profile.npcSpot.z,2,profile.npcSpot.level??0]]);
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

test('Jakut realms exclude non-Zanaris dungeons such as Dwarven Mine', () => {
    for (const profile of [PROFILES.jukat!, PROFILES.jukat_dagger!]) {
        expect(profile.realm!.inside({ worldX: 3152, worldZ: 9578 })).toBe(true);
        expect(profile.realm!.inside({ worldX: 3252, worldZ: 9572 })).toBe(true);
        expect(profile.realm!.inside({ worldX: 3077, worldZ: 9774 })).toBe(false);
        expect(profile.realm!.inside({ worldX: 3115, worldZ: 9928 })).toBe(false);
        expect(profile.realm!.inside({ worldX: 3201, worldZ: 3169 })).toBe(false);
    }
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
    expect(p.items.map(i => [i.re.test('Ring mould'), i.re.test('Chisel'), i.re.test('Sickle mould')]))
        .toEqual([[true, false, false], [false, true, false], [false, false, true]]);
    expect(p.items.map(i => i.shelf)).toEqual([4, 2, 6]);
    expect(p.bankSpot).toEqual({ x: 3269, z: 3167 });
    expect(selectItems(p.items, 'sickle mould').map(i => i.re.source)).toEqual(['^sickle mould$']);
    expect(selectItems(p.items, 'ring mould|chisel').map(i => i.re.source)).toEqual(['^ring mould$', '^chisel$']);
});

test('the silver_merchant profile buys one silver bar at the Ardougne Silver Stall', () => {
    const p = PROFILES.silver_merchant!;
    expect(p.npc.test('Silver merchant')).toBe(true);
    expect(p.npc.test('Gem merchant')).toBe(false);
    expect(p.npcSpot).toEqual({ x: 2659, z: 3316 });
    expect(p.bankSpot).toEqual({ x: 2654, z: 3283 });
    expect(p.items.map(i => [i.re.test('Silver bar'), i.re.test('Silver ore')])).toEqual([[true, false], [false, true]]);
    for (const line of p.items) expect(line).toMatchObject({ buyPerTick: 1, shelf: 1 });
    const bar = selectItems(p.items, 'silver bar');
    expect(bar.map(i => i.re.source)).toEqual(['^silver bar$']);
    expect(planShopPurchases(bar, [item('Silver ore', 1), item('Silver bar', 1, 150)], [], new Map(), 500, 1, 1)).toEqual([{ name: 'Silver bar', amount: 1 }]);
});

test('PK supply profiles cover Jakut dragon daggers, Magic Guild water/earth runes, Brimhaven/TBWT karambwans, Oziach, gem shops, and Tenzing climbing boots', () => {
    expect(selectItems(PROFILES.jukat_dagger!.items, 'dragon dagger').map(i => i.re.source)).toEqual(['^dragon dagger$']);
    expect(PROFILES.jukat_dagger!.items.find(i => i.re.test('Dragon dagger'))?.shelf).toBe(2);
    expect(selectItems(PROFILES.magic_guild_elemental!.items, 'water rune|earth rune')).toHaveLength(2);
    expect(selectItems(PROFILES.magic_guild!.items, 'blood rune|law rune|nature rune')).toHaveLength(3);
    expect(PROFILES.alfonse!.npc.test('Alfonse the waiter')).toBe(true);
    expect(selectItems(PROFILES.alfonse!.items, 'cooked karambwan').map(i => i.shelf)).toEqual([3]);
    expect(PROFILES.tiadeche!.npc.test('Tiadeche')).toBe(true);
    expect(PROFILES.tiadeche!.npcSpot).toEqual({ x: 2781, z: 3057 });
    expect(PROFILES.tiadeche!.door).toMatchObject({ id: 779, x: 2782, z: 3057, outside: { x: 2783, z: 3057 }, insideStand: { x: 2782, z: 3057 } });
    expect(PROFILES.tiadeche!.door!.inside({ worldX: 2782, worldZ: 3057 })).toBe(true);
    expect(PROFILES.tiadeche!.door!.inside({ worldX: 2781, worldZ: 3056 })).toBe(true);
    expect(PROFILES.tiadeche!.door!.inside({ worldX: 2783, worldZ: 3057 })).toBe(false);
    expect(PROFILES.tiadeche!.door!.inside({ worldX: 2782, worldZ: 3055 })).toBe(false);
    expect(selectItems(PROFILES.tiadeche!.items, 'raw karambwan').map(i => i.shelf)).toEqual([10]);
    expect(selectItems(PROFILES.tiadeche!.items, 'karambwan vessel').map(i => i.shelf)).toEqual([2]);
    expect(PROFILES.oziach!.npc.test('Oziach')).toBe(true);
    expect(PROFILES.oziach!.npcSpot.z).toBeLessThan(3520);
    expect(PROFILES.tenzing!.npcSpot.x).toBeLessThan(2944);
    expect(selectItems(PROFILES.gem_trader!.items, 'uncut sapphire|sapphire')).toHaveLength(2);
    expect(selectItems(PROFILES.herquin!.items, 'uncut sapphire|sapphire')).toHaveLength(2);
});

test('handleDialogShopOpen steps through Oziach quest completion dialogue until shop opens', async () => {
    let step = 0, shopOpen = false;
    const steps = [
        { isOpen: true, isWaiting: false, options: [{ index: 0, text: 'Click here to continue' }] },
        { isOpen: true, isWaiting: false, options: [{ index: 0, text: 'Can I buy a rune plate mail body now please?' }, { index: 1, text: 'Thank you.' }] },
    ];
    const sdk = {
        getState: () => ({ shop: { isOpen: shopOpen } }),
        getDialog: () => shopOpen || step >= steps.length ? null : steps[step]!,
        sendClickDialog: async (index: number) => {
            if (step === 1) expect(index).toBe(0);
            step++;
            if (step >= steps.length) shopOpen = true;
        },
    };
    expect(await handleDialogShopOpen(sdk, PROFILES.oziach!.dialogOpen!, async () => {})).toBe(true);
    expect(step).toBe(2);
});

test('runDialogBuyStep purchases Tenzing climbing boots and enforces coin reserve and spend limit', async () => {
    let coins = 100, boots = 0, step = -1;
    const inv = () => [{ name: 'Coins', count: coins }, ...(boots > 0 ? Array.from({ length: boots }, () => ({ name: 'Climbing boots', count: 1 })) : [])];
    const dialogs = [
        { isOpen: true, isWaiting: false, options: [{ index: 0, text: 'Can I buy some Climbing boots?' }, { index: 1, text: 'Nothing, thanks!' }] },
        { isOpen: true, isWaiting: false, options: [{ index: 0, text: 'OK, sounds good.' }, { index: 1, text: 'No, thanks.' }] },
    ];
    const sdk = {
        getInventory: inv,
        getDialog: () => step >= 0 && step < dialogs.length ? dialogs[step]! : null,
        sendClickDialog: async (idx: number) => {
            if (step === 0) expect(idx).toBe(0);
            if (step === 1) { expect(idx).toBe(0); coins -= 12; boots += 1; }
            step++;
        },
    };
    const bot = { talkTo: async () => { step = 0; return { success: true }; } };
    expect(await runDialogBuyStep(sdk, bot, PROFILES.tenzing!.npc, PROFILES.tenzing!.dialogBuy!, 50, 24, 5, async () => {})).toEqual({ bought: 1, spent: 12 });
    expect(coins).toBe(88);
    expect(boots).toBe(1);
    // Reserve + remaining spend guard stops when remaining budget cannot afford another pair.
    expect(await runDialogBuyStep(sdk, bot, PROFILES.tenzing!.npc, PROFILES.tenzing!.dialogBuy!, 80, 12, 5, async () => {})).toEqual({ bought: 0, spent: 0 });
});

test('mainland Skulgrimen, Shantay, black armour, Wydin chocolate, and Jiminua quest profiles resolve cleanly without Wilderness', () => {
    expect(PROFILES.skulgrimen!.npc.test('Skulgrimen')).toBe(true);
    expect(PROFILES.skulgrimen!.npcSpot).toEqual({ x: 2663, z: 3694 });
    expect(PROFILES.skulgrimen!.npcSpot.x).toBeLessThan(2944);
    expect(selectItems(PROFILES.skulgrimen!.items, 'berserker helm|warrior helm|archer helm|farseer helm')).toHaveLength(4);
    expect(PROFILES.shantay!.npc.test('Shantay')).toBe(true);
    expect(selectItems(PROFILES.shantay!.items, 'waterskin|bronze bar')).toHaveLength(2);
    expect(PROFILES.horvik!.npc.test('Horvik')).toBe(true);
    expect(selectItems(PROFILES.horvik!.items, 'black platebody')).toHaveLength(1);
    expect(selectItems(PROFILES.horvik!.items, 'steel platebody')).toHaveLength(0);
    expect(PROFILES.louie!.npc.test('Louie legs')).toBe(true);
    expect(selectItems(PROFILES.louie!.items, 'black platelegs')).toHaveLength(1);
    expect(PROFILES.valaine!.npc.test('Valaine')).toBe(true);
    expect(PROFILES.valaine!.npcSpot.level).toBe(1);
    expect(selectItems(PROFILES.valaine!.items, 'black full helm|black platelegs')).toHaveLength(2);
    expect(selectItems(PROFILES.wydin_choc!.items, 'cheese|chocolate bar')).toHaveLength(2);
    expect(selectItems(PROFILES.gem_trader!.items, 'uncut emerald|emerald')).toHaveLength(2);
    expect(selectItems(PROFILES.jiminua!.items, 'antipoison|papyrus|charcoal')).toHaveLength(3);
    expect(PROFILES.dommik_moulds!.npc.test('Dommik')).toBe(true);
    expect(selectItems(PROFILES.dommik_moulds!.items, 'necklace mould|amulet mould')).toHaveLength(2);
    expect(PROFILES.siegfried!.npc.test('Siegfried Erkle')).toBe(true);
    expect(PROFILES.siegfried!.npcSpot).toEqual({ x: 2725, z: 3381, level: 2 });
    expect(PROFILES.siegfried!.door).toMatchObject({ id: 2391, x: 2728, z: 3349, outside: { x: 2728, z: 3348 }, insideStand: { x: 2728, z: 3350 } });
    expect(PROFILES.siegfried!.door!.inside({ worldX: 2728, worldZ: 3350, level: 0 })).toBe(true);
    expect(PROFILES.siegfried!.door!.inside({ worldX: 2728, worldZ: 3349, level: 0 })).toBe(false);
    expect(selectItems(PROFILES.siegfried!.items, 'cape of legends|shield right half')).toHaveLength(2);
    expect(PROFILES.helemos!.npc.test('Helemos')).toBe(true);
    expect(PROFILES.helemos!.npcSpot).toEqual({ x: 2894, z: 3510, level: 1 });
    expect(PROFILES.helemos!.door).toMatchObject({ id: 2624, x: 2902, z: 3510, outside: { x: 2903, z: 3510 }, insideStand: { x: 2901, z: 3510 } });
    expect(PROFILES.helemos!.door!.inside({ worldX: 2901, worldZ: 3510, level: 0 })).toBe(true);
    expect(PROFILES.helemos!.door!.inside({ worldX: 2902, worldZ: 3510, level: 0 })).toBe(false);
    expect(selectItems(PROFILES.helemos!.items, 'dragon battleaxe|dragon mace')).toHaveLength(2);
    expect(PROFILES.bob!.npc.test('Bob')).toBe(true);
    expect(PROFILES.bob!.npcSpot).toEqual({ x: 3231, z: 3203 });
    expect(PROFILES.bob!.bankSpot).toEqual({ x: 3092, z: 3243 });
    expect(selectItems(PROFILES.bob!.items, 'steel axe|iron axe')).toHaveLength(2);
});

describe('the content price of one shop unit', () => {
    test('Jiminua charges 483 coins for the last antipoison, the price a live buy paid', () => {
        expect(shopUnitPrice(288, 1500, 20, 10, 10)).toBe(432);
        expect(shopUnitPrice(288, 1500, 20, 1, 10)).toBe(483);
        expect(lastUnitPrice(288, { sell: 1500, delta: 20 }, 10)).toBe(483);
    });
    test('the price rises by the step for each unit under the normal stock and stops at 5,000 over the multiplier', () => {
        expect([10, 9, 5, 2, 1].map(stock => shopUnitPrice(1000, 1000, 20, stock, 10))).toEqual([1000, 1020, 1100, 1160, 1180]);
        expect(shopUnitPrice(1000, 1000, 20, 1, 2000)).toBe(6000);
        expect(shopUnitPrice(1000, 1000, 20, 30, 10)).toBe(600);
        expect(shopUnitPrice(1000, 1000, 20, 500, 10)).toBe(100);
        expect(shopUnitPrice(1000, 1000, 20, 1, -1)).toBe(980);
        expect(shopUnitPrice(1, 1000, 10, 1, 10)).toBe(1);
    });
});

const WILLOW_STOCK = 20;
describe('the rule of each shop profile', () => {
    test('Jiminua and Scavvo have the step 20 that the client state does not show', () => {
        const jiminua = shopRules(PROFILES.jiminua!.npc, PROFILES.jiminua!.npcSpot), scavvo = shopRules(PROFILES.scavvo!.npc, PROFILES.scavvo!.npcSpot);
        expect(jiminua.map(r => [r.inv, r.sell, r.delta, r.stock.get('3doseantipoison')])).toEqual([['junglestore', 1500, 20, 10]]);
        expect(scavvo.map(r => [r.inv, r.sell, r.delta, r.stock.get('rune_platelegs'), r.stock.get('rune_chainbody')])).toEqual([['runiteshop', 1000, 20, 1, 1]]);
        expect(contentUnitBound(jiminua, 'Antipoison(3)')).toBe(483);
        expect(contentUnitBound(scavvo, 'Rune platelegs')).toBe(64000);
        expect(contentUnitBound(scavvo, 'no such item')).toBeNull();
        expect(contentUnitBound([], 'Rune platelegs')).toBeNull();
    });
    test('Aubury and Lowe keep the default step 10 and the full shelf sets the last price', () => {
        const aubury = shopRules(PROFILES.aubury!.npc, PROFILES.aubury!.npcSpot), lowe = shopRules(PROFILES.lowe!.npc, PROFILES.lowe!.npcSpot);
        expect(aubury.map(r => [r.inv, r.sell, r.delta])).toEqual([['runeshop', 1000, 10]]);
        expect(lowe.map(r => [r.inv, r.sell, r.delta, r.stock.get('iron_arrow')])).toEqual([['archeryshop', 1000, 10, 1500]]);
        expect(contentUnitBound(lowe, 'Iron arrow')).toBe(18);
    });
    test('a name that two items have takes the item that the shop stocks', () => {
        const dargaud = shopRules(PROFILES.dargaud!.npc, PROFILES.dargaud!.npcSpot), lowe = shopRules(PROFILES.lowe!.npc, PROFILES.lowe!.npcSpot);
        expect(dargaud.map(r => [r.inv, r.sell, r.delta, r.stock.get('willow_shortbow'), r.stock.has('unstrung_willow_shortbow')])).toEqual([['ranging_guild_bowshop', 1000, 10, WILLOW_STOCK, false]]);
        expect(contentUnitBound(dargaud, 'Willow shortbow')).toBe(shopUnitPrice(200, 1000, 10, 1, WILLOW_STOCK));
        expect(contentUnitBound(dargaud, 'Willow shortbow')!).toBeGreaterThanOrEqual(238);
        expect(lowe[0]!.stock.get('shortbow')).toBe(4);
        expect(contentUnitBound(lowe, 'Shortbow')).toBe(51);
        expect(contentUnitBound(lowe, 'Magic shortbow')).toBe(shopUnitPrice(1600, 1000, 10, 1, -1));
        const jiminua = shopRules(PROFILES.jiminua!.npc, PROFILES.jiminua!.npcSpot);
        expect(contentUnitBound(jiminua, 'Torch')).toBe(shopUnitPrice(4, 1500, 20, 1, jiminua[0]!.stock.get('torch_unlit')!));
    });
    test('Zaff opens his shops from a dialogue: both shops give a rule', () => {
        const zaff = shopRules(PROFILES.zaff!.npc, PROFILES.zaff!.npcSpot);
        expect(zaff.map(r => [r.inv, r.sell, r.delta]).sort()).toEqual([['memberstaffshop', 1000, 20], ['staffshop', 1000, 20]]);
    });
    test('every profile whose keeper the content gives a shop has a rule for each of its lines that the shop stocks', () => {
        const without: string[] = [];
        for (const [key, profile] of Object.entries(PROFILES)) {
            if ('dialogBuy' in profile && profile.dialogBuy) continue;
            const rules = shopRules(profile.npc, profile.npcSpot);
            if (!rules.length) { without.push(key); continue; }
            for (const rule of rules) { expect(rule.sell).toBeGreaterThanOrEqual(100); expect(rule.delta).toBeGreaterThanOrEqual(1); }
        }
        expect(without).toEqual(['general_sarim']);
    });
});

describe('the bound of a buy', () => {
    const client = { sellMultiplier: 1500, haggle: 10 }, antipoison = { name: 'Antipoison(3)', baseCost: 288 };
    test('the client state under-states the last antipoison and the content rule gives its price', () => {
        const rules = shopRules(PROFILES.jiminua!.npc, PROFILES.jiminua!.npcSpot);
        expect(maximumUnitCost(antipoison, client, 10)).toBe(458);
        expect(unitBound(antipoison, client, 10, rules)).toBe(483);
        expect(unitBound(antipoison, client, 10, [])).toBe(458);
        expect(unitBound(antipoison, client, 10, null)).toBe(458);
    });
    test('a blind buy of the last antipoison at 483 coins passes the content bound and breaks the client bound', () => {
        const before = { coins: 10970, held: 0 }, after = { coins: 10487, held: 1 };
        expect(blindBuyObserved({ ...before, unit: 483 }, after, 1000, 10000)).toEqual({ bought: 1, spent: 483 });
        expect(() => blindBuyObserved({ ...before, unit: 458 }, after, 1000, 10000)).toThrow('shop budget violated: blind buy took 483 coins for 1 units, bound 458 each');
        expect(() => blindBuyObserved({ ...before, unit: 483 }, { coins: 10486, held: 1 }, 1000, 10000)).toThrow('bound 483 each');
    });
});

test('a confirmed already-open bank needs no new open packet or generation',async()=>{
 let opens=0;const s:any={sdk:{getState:()=>({bank:{isOpen:true}})},bankObservation:()=>({generation:7,items:[{id:557,count:53}]}),bot:{openBank:async()=>{opens++;return{success:true};}}};
 await openEarthBankObserved(s);expect(opens).toBe(0);
});
test('a closed bank still requires its newly observed opening',async()=>{
 let opened=false,opens=0;const s:any={sdk:{getState:()=>({bank:{isOpen:opened}})},bankObservation:()=>opened?{generation:8,items:[]}:null,bot:{openBank:async()=>{opens++;opened=true;return{success:true};}}};
 await openEarthBankObserved(s);expect(opens).toBe(1);
});

test('closing the bank retains its confirmed assets and exact outstanding order quantity',()=>{
 let live:any={items:[{id:557,count:2},{id:995,count:320288}]};
 const bank=retainedEarthBank(()=>live);
 expect(bank()).toEqual(live.items);const old=live.items;live=null;
 expect(bank().find(i=>i.id===557)?.count).toBe(2);
 old[0].count=9000;expect(bank()[0]?.count).toBe(2);
 live={items:[{id:557,count:53},{id:995,count:352047}]};bank();live=null;
 expect(bank()).toEqual([{id:557,count:53},{id:995,count:352047}]);
});

test('competing buyers must not make a single available refill unbuyable',()=>{
 expect(earthRefillAmount(0,1136)).toBe(1);
 expect(earthRefillAmount(0,0)).toBe(0);
 expect(earthRefillAmount(1,1136)).toBe(1);
 expect(earthRefillAmount(3,1136)).toBe(1);
 expect(earthRefillAmount(1000,7)).toBe(1);
 expect(earthRefillAmount(1000,1136)).toBe(1);
 expect(()=>earthRefillAmount(NaN,1)).toThrow();
});
test('seed sale credit must arrive before a purchase can use its wallet baseline',async()=>{
 let coins=1000,earth=1,tick=0;const listeners=new Set<()=>void>();
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,getState:()=>({tick,inventory:inventory()})},bot:{sellToShop:async()=>{earth--;return{success:true};}}};
 const clock=setInterval(()=>{tick++;if(tick===3)coins+=2;for(const cb of [...listeners])cb();},2);
 try{expect(await sellEarthSeedObserved(s,()=>false)).toBe(2);expect(tick).toBeGreaterThanOrEqual(3);}finally{clearInterval(clock);}
});
test('an item packet before its coin debit cannot settle a purchase at zero cost',async()=>{
 let coins=1000,earth=0,tick=0;const listeners=new Set<()=>void>();
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,sendShopBuy:async()=>{earth++;return{success:true};},getState:()=>({tick,inventory:inventory(),gameMessages:[],shop:{isOpen:true,shopItems:[{slot:3,id:557,name:'Earth rune',count:10,baseCost:4}],shopConfig:{sellMultiplier:1000}}})},
  bot:{buyFromShop:async()=>{earth++;return{success:true};}}};
 const clock=setInterval(()=>{tick++;if(tick===3)coins-=6;for(const cb of [...listeners])cb();},2);
 try{expect(await buyEarthObserved(s,1,900,24,()=>false)).toEqual({bought:1,spent:6});expect(tick).toBeGreaterThanOrEqual(3);}finally{clearInterval(clock);}
});

function rawEarthFixture(response:'fill'|'refuse'|'silent'|'chat'){
 let coins=1000,earth=0,tick=0,calls=0;const listeners=new Set<()=>void>();
 const messages=[{observationId:10,tick:0,type:0,sender:'',text:'The shop has run out of stock.'}];
 const inventory=()=>[{id:995,name:'Coins',count:coins},{id:557,name:'Earth rune',count:earth}];
 const s:any={tick:()=>tick,onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},ended:new Promise(()=>{}),
  sdk:{getInventory:inventory,sendShopBuy:async(slot:number,n:number)=>{expect([slot,n]).toEqual([3,1]);calls++;return{success:true};},
   getState:()=>({tick,inventory:inventory(),gameMessages:messages,shop:{isOpen:true,shopItems:[{slot:3,id:557,name:'Earth rune',count:0,baseCost:4}],shopConfig:{sellMultiplier:1000}}})}};
 const clock=setInterval(()=>{tick++;if(calls&&tick===3){if(response==='fill'){earth++;coins-=6;}else if(response==='refuse'||response==='chat')messages.push({observationId:11,tick,type:response==='chat'?2:0,sender:response==='chat'?'Nearby player':'',text:'The shop has run out of stock.'});}for(const cb of [...listeners])cb();},2);
 return{s,calls:()=>calls,close:()=>clearInterval(clock)};
}
test('a stale zero shelf may receive exactly one funded server-current purchase',async()=>{
 const f=rawEarthFixture('fill');try{expect(await buyEarthObserved(f.s,1,900,24,()=>false)).toEqual({bought:1,spent:6});expect(f.calls()).toBe(1);}finally{f.close();}
});
test('only a fresh server refusal can settle a dispatched zero-effect purchase',async()=>{
 const f=rawEarthFixture('refuse');try{expect(await buyEarthObserved(f.s,1,900,24,()=>false)).toEqual({bought:0,spent:0});expect(f.calls()).toBe(1);}finally{f.close();}
});
test('a stale refusal and missing acknowledgement retain an unresolved request',async()=>{
 const f=rawEarthFixture('silent');try{await expect(buyEarthObserved(f.s,1,900,24,()=>false)).rejects.toThrow('unacknowledged');expect(f.calls()).toBe(1);}finally{f.close();}
});
test('nearby public chat cannot acknowledge an unresolved shop request',async()=>{
 const f=rawEarthFixture('chat');try{await expect(buyEarthObserved(f.s,1,900,24,()=>false)).rejects.toThrow('unacknowledged');expect(f.calls()).toBe(1);}finally{f.close();}
});
test('a worst-price funding shortfall cannot submit even one low-level packet',async()=>{
 const f=rawEarthFixture('fill');try{await expect(buyEarthObserved(f.s,1,999,24,()=>false)).rejects.toThrow('funding');expect(f.calls()).toBe(0);}finally{f.close();}
});
test('a funded purchase race keeps its no-progress clock; lack of funds never retries',()=>{
 expect(earthRefillStop(24,true)).toBeUndefined();
 expect(earthRefillStop(25,true)).toBe('stock-wait');
 expect(earthRefillStop(0,false)).toBe('budget');
 expect(earthRefillStop(25,false)).toBe('budget');
});
test('one owned seed may precede refill; missing stock observation or prior seed refuses it',()=>{
 expect(earthSeedNeeded(0,1,false)).toBe(true);
 expect(earthSeedNeeded(1,1,false)).toBe(true);
 expect(earthSeedNeeded(NaN,1,false)).toBe(false);
 expect(earthSeedNeeded(0,0,false)).toBe(false);
 expect(earthSeedNeeded(0,1,true)).toBe(false);
});

const swordConfig={sellMultiplier:1000,buyMultiplier:600,haggle:10};
const swordShelf=(count=2,id=1287)=>({id,name:'Adamant sword',count,slot:5,baseCost:id===1301?3200:2080,buyPrice:id===1301?3200:2080,sellPrice:1248});
test('actual shop formula prices one sword at 2080 full or 2100 one left, rather than generic six-unit budget',()=>{
    expect(swordQuote(swordShelf(),swordConfig).price).toBe(2080);expect(swordQuote(swordShelf(1),swordConfig)).toEqual({price:2100,reportedBuyPrice:2080});
    expect(()=>swordQuote(swordShelf(0),swordConfig)).toThrow();expect(()=>swordQuote(swordShelf(),undefined)).toThrow();
});
test('corridor permits known bank/shop and excludes southern thief/dark-wizard shortcuts and other floors',()=>{
    expect(swordTileSafe({x:3185,z:3436})).toBe(true);expect(swordTileSafe({x:3203,z:3397})).toBe(true);
    expect(swordTileSafe({x:3185,z:3395})).toBe(false);expect(swordTileSafe({x:3220,z:3380})).toBe(false);expect(swordTileSafe({x:3203,z:3397,level:1})).toBe(false);
});
test('reviewed actual SDK eastern shop approach and return are permitted, adjacent unreviewed cells stay refused',()=>{
    const forward=[{x:3197,z:3418},{x:3202,z:3413},{x:3202,z:3412},{x:3210,z:3404},{x:3210,z:3400},{x:3209,z:3399},{x:3206,z:3399},{x:3205,z:3398},{x:3203,z:3398},{x:3203,z:3400}];
    const backward=[{x:3203,z:3399},{x:3203,z:3398},{x:3207,z:3398},{x:3208,z:3399},{x:3209,z:3399},{x:3210,z:3400},{x:3210,z:3405},{x:3198,z:3417},{x:3196,z:3417},{x:3195,z:3418}];
    expect(expandPath({x:3195,z:3418},forward).every(swordTileSafe)).toBe(true);
    expect(expandPath({x:3203,z:3399},backward).every(swordTileSafe)).toBe(true);
    expect(swordTileSafe({x:3211,z:3404})).toBe(false);expect(swordTileSafe({x:3210,z:3398})).toBe(false);expect(swordTileSafe({x:3209,z:3407})).toBe(false);
});
function swordFixture(o:{itemId?:number;stock?:number;fakeBuy?:boolean;distance?:number}={}){
    let tick=0,open=false,shop=false,generation=0,buyCalls=0;const listeners=new Set<()=>void>();
    const inv:any[]=[{id:333,name:'Trout',count:1,slot:0},{id:333,name:'Trout',count:1,slot:1}];
    const bank:any[]=[{id:995,name:'Coins',count:2600,slot:7},{id:329,name:'Salmon',count:30,slot:8},{id:1277,name:'Bronze sword',count:1,slot:9}];
    const position={worldX:3185,worldZ:3436,level:0,lifeId:1,respawnCount:0};const state=()=>({player:position,equipment:[],bank:{isOpen:open,items:bank},shop:{isOpen:shop,shopItems:[swordShelf(o.stock??1,o.itemId)],shopConfig:swordConfig},nearbyNpcs:[{id:551,index:10,x:o.distance===5?3209:3203,z:o.distance===5?3399:3397,distance:o.distance??1,optionsWithIndex:[{text:'Trade',opIndex:3}]}]});
    const timer=setInterval(()=>{tick++;for(const f of [...listeners])f();},1),walks:number[][]=[];
    const s:any={name:'fixture',tick:()=>tick,onTick:(f:()=>void)=>{listeners.add(f);return()=>listeners.delete(f);},ended:new Promise(()=>{}),bankObservation:()=>open?{generation,at:tick+1,items:bank}:null,
        sdk:{getState:state,getInventory:()=>inv,getSkill:()=>({level:10})},
        bot:{dismissBlockingUI:async()=>{},openBank:async()=>{open=true;generation++;return{success:true};},closeBank:async()=>{open=false;return{success:true};},
            withdrawItem:async(item:any,n:number,options:any)=>{expect(typeof item).toBe('object');expect(item).toBe(bank[0]);expect(item.slot).toBe(7);expect(options.asNote).toBe(false);item.count-=n;inv.push({id:995,name:'Coins',count:n,slot:2});generation++;return{success:true};},
            depositItem:async(item:any)=>{let row=bank.find(i=>i.id===item.id);if(!row){row={...item,count:0};bank.push(row);}row.count+=item.count;inv.splice(inv.indexOf(item),1);generation++;return{success:true};},
            openShop:async(npc:any)=>{expect(npc.id).toBe(551);shop=true;return{success:true};},closeShop:async()=>{shop=false;return{success:true};},
            buyFromShop:async(item:any,n:number)=>{buyCalls++;expect(item.id).toBe(o.itemId??1287);expect(n).toBe(1);if(!o.fakeBuy){inv.find(i=>i.id===995).count-=swordQuote(item,swordConfig).price;inv.push({id:o.itemId??1287,name:'Adamant sword',count:1,slot:3});}return{success:true,amountBought:1};}}};
    return{s:s as Session,bank,inv,walks,walk:async(x:number,z:number,tol:number)=>{walks.push([x,z,tol]);position.worldX=x;position.worldZ=z;return true;},buyCalls:()=>buyCalls,dispose:()=>clearInterval(timer)};
}
test('one observed sword at 2100 is banked, 500 coins remain, and original food/kit are preserved',async()=>{
    const f=swordFixture();try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});
        expect(r).toMatchObject({ok:true,targetMet:true,bought:1,banked:1,spent:2100,price:2100,coinsRemaining:500,preserved:true,hpMin:10});
        expect(f.buyCalls()).toBe(1);expect(f.bank.find(i=>i.id===329).count).toBe(30);expect(f.bank.find(i=>i.id===1277).count).toBe(1);
        expect(f.inv.filter(i=>i.id===333).length).toBe(2);expect(f.inv.some(i=>i.id===995||i.id===1287)).toBe(false);
        expect(f.walks[0]).toEqual([3185,3420,1]);expect(f.walks.at(-1)).toEqual([3185,3436,2]);
    }finally{f.dispose();}
});
test('over-budget shelf or empty shelf makes no purchase and returns all owned cash',async()=>{
    for(const stock of [0,1]){const f=swordFixture({stock});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2000,walk:f.walk});expect(r.ok).toBe(false);expect(f.buyCalls()).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);}finally{f.dispose();}}
});
test('a success-shaped shop reply without actual sword and coin deltas cannot pass',async()=>{
    const f=swordFixture({fakeBuy:true});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(false);expect(r.banked).toBe(0);expect(r.coinsRemaining).toBe(2600);expect(r.preserved).toBe(true);expect(f.buyCalls()).toBe(1);}finally{f.dispose();}
});

test('wandering shopkeeper is approached inside the checked route before trade',async()=>{const f=swordFixture({distance:5});try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(true);expect(f.walks).toContainEqual([3209,3399,1]);expect(f.buyCalls()).toBe(1);}finally{f.dispose();}});
test('unrecognised shop pricing remains refused',()=>{expect(()=>swordQuote(swordShelf(),{...swordConfig,haggle:20})).toThrow('unknown sword shop');});

test('a shopkeeper already within reach needs no redundant path dispatch',async()=>{
 const f=swordFixture();try{const r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});expect(r.ok).toBe(true);expect(f.walks).not.toContainEqual([3203,3397,1]);expect(f.walks.at(-1)).toEqual([3185,3436,2]);}finally{f.dispose();}
});
test('unrelated owned food is conserved; purchasing does not require the old courier fixture',async()=>{
 const f=swordFixture();try{f.inv.splice(0,f.inv.length,{id:315,name:'Shrimps',count:1,slot:0},{id:2309,name:'Bread',count:1,slot:1});
 const before=JSON.stringify(f.inv),r=await runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk});
 expect(r.ok).toBe(true);expect(r.preserved).toBe(true);expect(JSON.stringify(f.inv)).toBe(before);
 }finally{f.dispose();}
});
test('reserve slots for withdrawn cash and purchased sword before any purchase',async()=>{
 const f=swordFixture();try{f.inv.splice(0,f.inv.length,...Array.from({length:27},(_,slot)=>({id:333,name:'Trout',count:1,slot})));
 await expect(runOwnedSword(f.s,{cap:100,maximumSpend:2500,walk:f.walk})).rejects.toThrow('2free pack slots');expect(f.buyCalls()).toBe(0);expect(f.bank[0].count).toBe(2600);
 }finally{f.dispose();}
});

test('Eastbank preparation rejects unsupported start, stop and invalid budget before bank input',async()=>{
 let actions=0;
 const s:any={tick:()=>0,sdk:{getState:()=>({player:{worldX:3252,worldZ:3420,level:0}}),getSkill:()=>({level:10})},bot:{openBank:async()=>{actions++;return{success:true};}}};
 await expect(runOwnedSwordFromEast(s,{cap:900,maximumSpend:2500,stop:()=>true})).rejects.toThrow('healthy active');
 await expect(runOwnedSwordFromEast(s,{cap:0,maximumSpend:2500})).rejects.toThrow('positive CAP');
 s.sdk.getState=()=>({player:{worldX:3185,worldZ:3436,level:0}});
 await expect(runOwnedSwordFromEast(s,{cap:900,maximumSpend:2500})).rejects.toThrow('checked start');expect(actions).toBe(0);
});

test('longsword exact profile is 3200 at default 1, unknown IDs and mismatched prices stay refused',()=>{
 expect(swordQuote(swordShelf(1,1301),swordConfig).price).toBe(3200);
 expect(()=>swordQuote(swordShelf(0,1301),swordConfig)).toThrow();
 expect(()=>swordQuote({...swordShelf(1,1301),baseCost:2080},swordConfig)).toThrow();
 expect(()=>swordQuote(swordShelf(1,1303),swordConfig)).toThrow();
});
test('longsword purchase banks only the selected item and reconciles actual cost',async()=>{
 const f=swordFixture({itemId:1301});f.bank[0].count=6000;
 try{const r=await runOwnedSword(f.s,{itemId:1301,cap:100,maximumSpend:4000,walk:f.walk});
 expect(r).toMatchObject({ok:true,itemId:1301,bought:1,banked:1,spent:3200,coinsRemaining:2800,preserved:true});
 expect(f.bank.find(i=>i.id===1301)?.count).toBe(1);expect(f.bank.some(i=>i.id===1287)).toBe(false);
 }finally{f.dispose();}
});
test('unsupported target and raised short-sword cap fail before withdrawal',async()=>{
 for(const itemId of [1287,1303]){const f=swordFixture();try{await expect(runOwnedSword(f.s,{itemId,cap:100,maximumSpend:4000,walk:f.walk})).rejects.toThrow('item-specific');expect(f.bank[0].count).toBe(2600);expect(f.buyCalls()).toBe(0);}finally{f.dispose();}}
});

const tripJob=():ShopTripJob=>({merchant:'alkharid-general',item:1205,minimumUnit:1,target:4,batch:2,cap:1000,returnTicks:200,members:false,reserve:2});
function tripFixture(title=nativeMerchant('alkharid-general').title,price=4,distance=1){
 const messages:any[]=[];let tick=0,sales=0,opened=0;const inventory=[{id:1205,count:2,slot:0},{id:995,count:0,slot:1},{id:2357,count:1,slot:2}],shop={isOpen:false,title,playerItems:[{id:1205,name:"Item",slot:0,sellPrice:price}]};
 const s:any={name:'fixture',tick:()=>tick,ended:new Promise(()=>{}),onTick:(fn:()=>void)=>{let active=true;const next=()=>queueMicrotask(()=>{if(active){tick++;fn();next();}});next();return()=>{active=false;};},sdk:{sendClickComponentWithOption:async()=>{messages.push({type:0,text:"Item: shop will buy for "+price+"gp.",tick:++tick,observationId:tick});return{success:true};},getInventory:()=>inventory,getSkill:()=>({level:50}),getState:()=>({player:{lifeId:1},gameMessages:messages,shop,nearbyNpcs:[{id:524,index:7,distance,reachable:true}]}),sendCloseModal:async()=>{shop.isOpen=false;return{success:true};}},bot:{openShop:async(n:any)=>{expect(n.id).toBe(524);opened++;shop.isOpen=true;return{success:true};},closeShop:async()=>{shop.isOpen=false;return{success:true};},sellToShop:async()=>{sales++;inventory[0]!.count--;inventory[1]!.count+=price;return{amountSold:1};}}};return{s,inventory,counts:()=>({sales,opened}),shop};
}
test('merchant profile preserves explicit bank reserve and native route, rejects unsupported inputs',()=>{
 const j=tripJob();expect(()=>validateShopTrip(j)).not.toThrow();const p=shopTripProfile({}as any,j);expect(p.inputs).toEqual({1205:1});expect(p.outputs).toEqual([995]);expect(p.bank).toEqual({x:3269,z:3167,level:0});expect(p.site).toEqual({x:3314,z:3180,level:0});expect(j.reserve).toBe(2);
 for(const change of [{merchant:'eval'},{item:1206},{item:950},{item:995},{minimumUnit:0},{batch:1001},{reserve:-1},{cap:200}])expect(()=>validateShopTrip({...j,...change}as ShopTripJob)).toThrow();
});
test('declared Dommik binds native members/f2p inventories and observed member mode',async()=>{
 for(const members of [true,false]){
  const j={...tripJob(),merchant:'dommik',item:1592,members,bank:{x:3269,z:3167,level:0},site:{x:3321,z:3194,level:0},shop:{title:'Dommiks Crafting Store.',inventory:members?'craftingshop2':'craftingshop2_free'}};
  expect(validateShopTrip(j).contractSource).toBe('native-handler');expect(()=>validateShopTrip({...j,shop:{...j.shop,inventory:members?'craftingshop2_free':'craftingshop2'}})).toThrow('member branch');
  const f=tripFixture(j.shop.title,3);f.s.client={membersAccount:members?1:0};f.inventory[0]!.id=1592;f.shop.playerItems[0]!.id=1592;const state=f.s.sdk.getState;f.s.sdk.getState=()=>({...state(),nearbyNpcs:[{id:545,index:5,distance:1,reachable:true}]});f.s.bot.openShop=async(n:any)=>{expect(n.id).toBe(545);f.shop.isOpen=true;return{success:true};};expect(await shopTripProfile(f.s,j).run(2,100,()=>false)).toBe(2);expect(f.inventory[1]!.count).toBe(6);
  f.s.client.membersAccount=members?0:1;expect(()=>shopTripProfile(f.s,j)).toThrow('member connection');
 }
});
test('Oziach native quest refusal sends one Trade attempt and no sale, without dialogue automation',async()=>{
 const j={...tripJob(),merchant:'oziach',item:1127,members:true,bank:{x:3093,z:3491,level:0},site:{x:3069,z:3516,level:0},shop:{title:'oziach',inventory:'runeplateshop'}};expect(validateShopTrip(j).contractSource).toBe('native-params');
 const f=tripFixture('oziach');f.s.client={membersAccount:1};const state=f.s.sdk.getState;f.s.sdk.getState=()=>({...state(),nearbyNpcs:[{id:747,index:9,distance:1,reachable:true}]});let trades=0;f.s.bot.openShop=async(n:any)=>{expect(n.id).toBe(747);trades++;return{success:false};};await expect(shopTripProfile(f.s,j).run(1,100,()=>false)).rejects.toThrow('shop unavailable');expect(trades).toBe(1);expect(f.counts().sales).toBe(0);
 expect(()=>validateShopTrip({...j,shop:{title:'Forged title',inventory:'runeplateshop'}})).toThrow('native NPC params');expect(()=>validateShopTrip({...j,shop:{title:'oziach',inventory:'fake_inventory'}})).toThrow('native shop');
});
test('profile opens exact merchant and uses real staged seller exact stock/coin conservation',async()=>{const f=tripFixture();expect(await shopTripProfile(f.s,tripJob()).run(2,100,()=>false)).toBe(2);expect(f.counts()).toEqual({sales:2,opened:1});expect(f.inventory.map(i=>i.count)).toEqual([0,8,1]);expect(f.shop.isOpen).toBe(false);});
test('wrong title, price floor and stop prevent surplus dispatch',async()=>{
 for(const [title,price,stop]of [['Other shop',4,false],[nativeMerchant('alkharid-general').title,0,false],[nativeMerchant('alkharid-general').title,4,true]]as const){const f=tripFixture(title,price);await expect(shopTripProfile(f.s,tripJob()).run(2,100,()=>stop)).rejects.toThrow();expect(f.counts().sales).toBe(0);expect(f.inventory[0]!.count).toBe(2);}
 expect(shopTripStop('fixture',false,p=>p==='.practice/stop-all')).toBe(true);expect(shopTripStop('fixture',false,()=>false)).toBe(false);
});
test('caller-declared native merchants bind config, inventory and exact spawn, with AK-only silk rule',()=>{
 const bank={x:3208,z:3220,level:2},site={x:3231,z:3203,level:0};
 const bob=validateShopTrip({...tripJob(),merchant:'bob',item:1351,bank,site});expect(bob.npc).toBe(519);expect(bob.title).toBe("Bob's Brilliant Axes.");expect(bob.inventory).toBe('axeshop');expect(bob.bank).toEqual(bank);
 const varrock={...tripJob(),merchant:'generalshopkeeper2',item:950,bank:{x:3185,z:3436,level:0},site:{x:3218,z:3415,level:0}};
 expect(validateShopTrip(varrock).inventory).toBe('generalshop2');
 for(const change of [{merchant:'bob'},{merchant:'hans',bank,site},{merchant:'made_up',bank,site},{merchant:'bob;eval',bank,site},{merchant:'bob',bank,site:{x:3300,z:3203,level:0}},{merchant:'bob',bank,site:{...site,level:1}},{merchant:'bob',bank,site,item:1205}])expect(()=>validateShopTrip({...tripJob(),...change})).toThrow();
});
test('valid declared site plus walking tolerance still permits its visible native merchant',async()=>{
 const j={...tripJob(),site:{x:3316,z:3176,level:0}};expect(()=>validateShopTrip(j)).not.toThrow();const f=tripFixture(undefined,4,10);expect(await shopTripProfile(f.s,j).run(2,100,()=>false)).toBe(2);expect(f.counts()).toEqual({opened:1,sales:2});
});

const saleOpts:ShopSaleOptions={item:1205,quantity:2,minimumUnit:2,reserve:3,shopTitle:'General Store',cap:40};
test('sale price, explicit quantity and reserve limits validate before login',()=>{expect(()=>validateShopSale({...saleOpts,quantity:Infinity})).toThrow();expect(()=>validateShopSale({...saleOpts,item:995})).toThrow();expect(()=>validateShopSale({...saleOpts,minimumUnit:0})).toThrow();});
test('merchant receipt preserves unrelated kit and exact coins',()=>{expect(shopSaleEffect(1205,3,{1205:5,995:7,590:1},{1205:4,995:10,590:1})).toBe(true);expect(shopSaleEffect(1205,3,{1205:5,995:7,590:1},{1205:4,995:10})).toBe(false);});
test('staged native wrapper sells unitwise at observed prices and preserves reserve',async()=>{
 const messages:any[]=[];let tick=0,held=5,coins=7,open=true,sold=0;const p={lifeId:1},inventory=()=>[{id:1205,count:held,slot:0},{id:995,count:coins,slot:1},{id:590,count:1,slot:2}];
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),sdk:{sendClickComponentWithOption:async()=>{messages.push({type:0,text:"Bronze dagger: shop will buy for 3gp.",tick:++tick,observationId:tick});return{success:true};},getInventory:inventory,getSkill:()=>({level:30}),getState:()=>({player:p,gameMessages:messages,inventory:inventory(),shop:{isOpen:open,title:'General Store',playerItems:[{id:1205,name:"Bronze dagger",slot:0,count:held,sellPrice:4}]}})},bot:{sellToShop:async(item:any,n:number)=>{expect(item.id).toBe(1205);expect(n).toBe(1);held--;coins+=3;sold++;tick++;return{success:true,amountSold:1}},closeShop:async()=>{open=false;return{success:true}}}};
 expect(await runShopSale(s,saleOpts)).toMatchObject({ok:true,sold:2,coins:6,remaining:3,conserved:true});expect(sold).toBe(2);
 held=5;coins=7;open=true;sold=0;expect(await runShopSale(s,{...saleOpts,minimumUnit:4})).toMatchObject({ok:false,sold:0,stop:'price floor'});expect(sold).toBe(0);
});
test('native Value ignores stale private quotes and fresh player chat',async()=>{
 const messages:any[]=[{type:0,text:'Bronze dagger: shop will buy for 4gp.',observationId:1}];let tick=1;const listeners=new Set<()=>void>();
 const s:any={tick:()=>tick,ended:new Promise(()=>{}),onTick:(cb:()=>void)=>{listeners.add(cb);return()=>listeners.delete(cb);},sdk:{getState:()=>({gameMessages:messages}),sendClickComponentWithOption:async(component:number,option:number,slot:number)=>{expect([component,option,slot]).toEqual([3823,1,2]);messages.push({type:2,text:'Bronze dagger: shop will buy for 999gp.',observationId:2});return{success:true};}}};
 let done=false;const pending=observeMerchantQuote(s,{id:1205,name:'Bronze dagger',slot:2},()=>false,10).then(v=>{done=true;return v;});await Promise.resolve();await Promise.resolve();expect(done).toBe(false);
 messages.push({type:0,text:'Bronze dagger: shop will buy for 3gp.',observationId:3});tick++;for(const cb of listeners)cb();expect(await pending).toBe(3);
});
