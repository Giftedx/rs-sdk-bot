import { expect, test } from 'bun:test';
import { supervise } from '../packages/practice/src/supervise';
import { planShopPurchases, maximumUnitCost, buyWithBudget, PROFILES, shopTargetsMet, stockWaitStatus, shopFinishOk, dialogClick, blindBuyNow, blindBuyObserved, BLIND_SETTLE_TICKS, selectItems, profileRefusal, approachLegs, approachShop, handleDialogShopOpen, runDialogBuyStep } from './shop-buyer';

const target = (name: string, buyPerTick: number) => ({ re: new RegExp(`^${name}$`, 'i'), buyPerTick });
const item = (name: string, count = 100, buyPrice = 1) => ({ name, count, buyPrice });

test('finite artisan tool targets retain one owned tool and buy only the missing other tool', () => {
    const targets=PROFILES.dommik!.items,bank=new Map([['chisel',1]]),shop=[item('Ring mould',4),item('Chisel',2)];
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
    expect(p.items.map(i => [i.re.test('Ring mould'), i.re.test('Chisel')])).toEqual([[true, false], [false, true]]);
    expect(p.items.map(i => i.shelf)).toEqual([4, 2]);
    expect(p.bankSpot).toEqual({ x: 3269, z: 3167 });
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
