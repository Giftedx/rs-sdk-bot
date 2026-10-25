import { expect, test } from 'bun:test';
import { supervise } from '../packages/practice/src/supervise';
import { planShopPurchases, maximumUnitCost, buyWithBudget, PROFILES, shopTargetsMet, stockWaitStatus, shopFinishOk } from './shop-buyer';

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
test('existing shop profiles retain their NPC, route endpoints and commodity counts',()=>{
    const cases=[['ardy','Aemad',2613,3294,2654,3283,8],['catherby','Hickton',2821,3444,2809,3441,4],['sarim','Gerrant',3013,3225,3092,3243,4],['betty','Betty',3012,3259,3092,3243,9],['taverley','Jatix',2908,3443,2934,3376,4],['general_sarim','Shopkeeper',3014,3205,3092,3243,5],['aubury','Aubury',3253,3402,3253,3420,8],['zeke','Zeke',3288,3190,3269,3167,4],['nurmof','Nurmof',2998,9844,3013,3355,6]] as const;
    for(const [key,npc,x,z,bx,bz,n]of cases){const p=PROFILES[key]!;expect(p.npc.test(npc)).toBe(true);expect(p.npcSpot).toEqual({x,z});expect(p.bankSpot).toEqual({x:bx,z:bz});expect(p.items).toHaveLength(n);}
});
