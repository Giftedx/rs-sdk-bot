import { describe, expect, test } from 'bun:test';
import { contentUnitBound, lastUnitPrice, shopRules, shopUnitPrice } from './shop-price';
import { blindBuyObserved, maximumUnitCost, PROFILES, unitBound } from './shop-buyer';

describe('the content price of one shop unit', () => {
    test('Jiminua charges 483 coins for the last antipoison, the price a live buy paid', () => {
        // karamja.npc [jiminua]: shop_sell_multiplier 1500, shop_delta 20; karamja.inv stock14=3doseantipoison,10,150; cost 288.
        expect(shopUnitPrice(288, 1500, 20, 10, 10)).toBe(432);
        expect(shopUnitPrice(288, 1500, 20, 1, 10)).toBe(483);
        expect(lastUnitPrice(288, { sell: 1500, delta: 20 }, 10)).toBe(483);
    });
    test('the price rises by the step for each unit under the normal stock and stops at 5,000 over the multiplier', () => {
        expect([10, 9, 5, 2, 1].map(stock => shopUnitPrice(1000, 1000, 20, stock, 10))).toEqual([1000, 1020, 1100, 1160, 1180]);
        expect(shopUnitPrice(1000, 1000, 20, 1, 2000)).toBe(6000);
        // Over the normal stock the price falls, by 1,000 at most, and never under a tenth of the cost.
        expect(shopUnitPrice(1000, 1000, 20, 30, 10)).toBe(600);
        expect(shopUnitPrice(1000, 1000, 20, 500, 10)).toBe(100);
        // An item that the shop does not stock: the count itself moves the price.
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
        // champions_guild.inv holds one of each, so the last unit is the shelf price: rune platelegs cost 64,000.
        expect(contentUnitBound(scavvo, 'Rune platelegs')).toBe(64000);
        expect(contentUnitBound(scavvo, 'no such item')).toBeNull();
        expect(contentUnitBound([], 'Rune platelegs')).toBeNull();
    });
    test('Aubury and Lowe keep the default step 10 and the full shelf sets the last price', () => {
        const aubury = shopRules(PROFILES.aubury!.npc, PROFILES.aubury!.npcSpot), lowe = shopRules(PROFILES.lowe!.npc, PROFILES.lowe!.npcSpot);
        expect(aubury.map(r => [r.inv, r.sell, r.delta])).toEqual([['runeshop', 1000, 10]]);
        expect(lowe.map(r => [r.inv, r.sell, r.delta, r.stock.get('iron_arrow')])).toEqual([['archeryshop', 1000, 10, 1500]]);
        // 1,499 units under the normal stock would add 14,990: the price stops at 5,000 over the multiplier.
        expect(contentUnitBound(lowe, 'Iron arrow')).toBe(18);
    });
    test('a name that two items have takes the item that the shop stocks', () => {
        // "Willow shortbow" is unstrung_willow_shortbow (cost 100) and willow_shortbow (cost 200); Dargaud stocks the strung one.
        const dargaud = shopRules(PROFILES.dargaud!.npc, PROFILES.dargaud!.npcSpot), lowe = shopRules(PROFILES.lowe!.npc, PROFILES.lowe!.npcSpot);
        expect(dargaud.map(r => [r.inv, r.sell, r.delta, r.stock.get('willow_shortbow'), r.stock.has('unstrung_willow_shortbow')])).toEqual([['ranging_guild_bowshop', 1000, 10, WILLOW_STOCK, false]]);
        expect(contentUnitBound(dargaud, 'Willow shortbow')).toBe(shopUnitPrice(200, 1000, 10, 1, WILLOW_STOCK));
        expect(contentUnitBound(dargaud, 'Willow shortbow')!).toBeGreaterThanOrEqual(238);
        // "Shortbow" is unstrung_shortbow (cost 23) and shortbow (cost 50); Lowe stocks 4 strung ones.
        expect(lowe[0]!.stock.get('shortbow')).toBe(4);
        expect(contentUnitBound(lowe, 'Shortbow')).toBe(51);
        // A name of two items that the shop stocks neither of: the highest bound of the two.
        expect(contentUnitBound(lowe, 'Magic shortbow')).toBe(shopUnitPrice(1600, 1000, 10, 1, -1));
        // Jiminua stocks the unlit torch of the two torches.
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
        // The Port Sarim general store keeper is not at the profile's tile in the content's spawn list.
        expect(without).toEqual(['general_sarim']);
    });
});

describe('the bound of a buy', () => {
    const client = { sellMultiplier: 1500, haggle: 10 }, antipoison = { name: 'Antipoison(3)', baseCost: 288 };
    test('the client state under-states the last antipoison and the content rule gives its price', () => {
        const rules = shopRules(PROFILES.jiminua!.npc, PROFILES.jiminua!.npcSpot);
        expect(maximumUnitCost(antipoison, client, 10)).toBe(458);
        expect(unitBound(antipoison, client, 10, rules)).toBe(483);
        // A shop with no rule in the content keeps the bound from the client state.
        expect(unitBound(antipoison, client, 10, [])).toBe(458);
        expect(unitBound(antipoison, client, 10, null)).toBe(458);
    });
    test('a blind buy of the last antipoison at 483 coins passes the content bound and breaks the client bound', () => {
        const before = { coins: 10970, held: 0 }, after = { coins: 10487, held: 1 };
        expect(blindBuyObserved({ ...before, unit: 483 }, after, 1000, 10000)).toEqual({ bought: 1, spent: 483 });
        expect(() => blindBuyObserved({ ...before, unit: 458 }, after, 1000, 10000)).toThrow('shop budget violated: blind buy took 483 coins for 1 units, bound 458 each');
        // The bound is not loose: one coin more for the unit is a broken bound.
        expect(() => blindBuyObserved({ ...before, unit: 483 }, { coins: 10486, held: 1 }, 1000, 10000)).toThrow('bound 483 each');
    });
});
