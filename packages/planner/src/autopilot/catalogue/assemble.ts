// Assembles the full autopilot job template catalogue (`catalogue`) from army, skilling, shop, and squad builders.
import { CHICKEN_PENS, FEATHER_TARGET, KNIGHT_SPOTS, PEN_QUEST_POINTS, SHOP_STOCK, type Template } from '../world';
import { ARROW_LOW, PICKAXE_LADDER, RUNE_ARROW_COST, RUNE_ARROW_SPEND, knightCoinsPerTick } from '../pricing';
import { GOLDFARM_FRAIL, holdsUnderKeys } from './constants';
import { aioTemplates } from './aio';
import { makerChains, makerShopSteps } from './makers';
import { squadSupplies } from './squad-shops';
import { armyCombatTemplates } from './army-combat';
import { armyQuestAndHuntTemplates } from './army-quests';

// Proven job templates. Rates are estimates from each script's header model; tick-waste discounts them by measurement.
export function catalogue(): Template[] {
    const goldfarm = KNIGHT_SPOTS.map((spot): Template => ({
        id: `goldfarm@${spot}`, family: 'goldfarm', script: 'scripts/goldfarm.ts', env: { KNIGHT_SPOT: spot, TICKS: '9000' }, role: 'thieving',
        goal: `goldfarm knights at ${spot}`, needs: { skills: { Thieving: 55 }, frail: GOLDFARM_FRAIL }, resources: [`knight:${spot}`],
        yields: a => [{ item: 'coins', perTick: knightCoinsPerTick(a.skills.Thieving ?? 1) }],
    }));
    const nurmofPickaxes: Template[] = PICKAXE_LADDER.map(([lvl, item, coins], idx) => {
        const better = PICKAXE_LADDER.slice(0, idx + 1).map(([, p]) => p);
        const tier = item.split(' ')[0]!;
        return {
            id: `tool-pickaxe-${tier}`, family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'nurmof', '1200'],
            env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
            role: 'mining', goal: `buy ${item} from Nurmof in the Dwarven Mine`, repeats: false,
            resources: ['shop:nurmof'], yields: () => [{ item, perTick: 0.01 }],
            needs: { ...(lvl > 1 ? { skills: { Mining: lvl } } : {}), items: { coins }, holdsUnder: holdsUnderKeys(better) },
        };
    });
    const ardyIronAxe: Template = {
        id: 'tool-axe-iron', family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'ardy', '1200'],
        env: { ITEMS: 'iron axe', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '300', COIN_RESERVE: '100', MAX_SPEND: '200' },
        role: 'woodcutting', goal: 'buy iron axe from Aemad in East Ardougne', repeats: false,
        resources: ['shop:ardy'], yields: () => [{ item: 'iron axe', perTick: 0.01 }],
        needs: { items: { coins: 300 }, holdsUnder: holdsUnderKeys(['iron axe', 'steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe']) },
    };
    const bobSteelAxe: Template = {
        id: 'tool-axe-steel', family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'bob', '1200'],
        env: { ITEMS: 'steel axe', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '350', COIN_RESERVE: '100', MAX_SPEND: '220' },
        role: 'woodcutting', goal: "buy steel axe from Bob's Brilliant Axes in Lumbridge", repeats: false,
        resources: ['shop:bob'], yields: () => [{ item: 'steel axe', perTick: 0.01 }],
        provides: { item: 'steel axe', unlocks: ['squad-magic-logs'] },
        needs: { skills: { Woodcutting: 6 }, items: { coins: 350 }, holdsUnder: holdsUnderKeys(['steel axe', 'black axe', 'mithril axe', 'adamant axe', 'rune axe']) },
    };
    const combat = armyCombatTemplates();
    const { quests, hunt, leather } = armyQuestAndHuntTemplates();
    return [
        ...goldfarm,
        ...combat.cows,
        ...combat.troopers,
        ...combat.magic,
        ...combat.prayer,
        ...combat.ranged,
        ...quests,
        ...hunt,
        ...combat.gear,
        ...nurmofPickaxes,
        ardyIronAxe,
        bobSteelAxe,
        ...leather,
        combat.prayerField,
        { id: 'thieving55', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: '55', CAP: '2500', CLEAN_FOOD: '1' }, role: 'thieving',
            goal: 'train Thieving to 55 for a knight spot', trains: { skill: 'Thieving', to: 55, unlocks: goldfarm.map(g => g.id) }, yields: () => [] },
        ...CHICKEN_PENS.map((pen): Template => ({
            id: `feathers@${pen}`, family: 'gather-feathers', script: 'scripts/gather-feathers.ts', env: { PEN: pen, TICKS: '3000', TARGET: String(FEATHER_TARGET) }, role: 'helper',
            goal: `feathers at the chicken pen ${pen}`, resources: [`pen:${pen}`], needs: { holdsUnder: { feather: FEATHER_TARGET }, ...(PEN_QUEST_POINTS[pen] ? { questPoints: PEN_QUEST_POINTS[pen] } : {}) },
            // chicken.rs2: 15 feathers 1/4, 5 feathers 1/4 -> 5 a kill; about one kill and pickup per 16 ticks.
            yields: () => [{ item: 'feather', perTick: 0.3 }],
        })),
        { id: 'lobster-chain', family: 'gather-fish', script: 'scripts/chain.ts', args: ['scripts/gather-fish.ts cage 3000', 'scripts/cook-food.ts 3000 lobster'], role: 'fishing',
            goal: 'Catherby lobsters, caught and cooked', needs: { skills: { Fishing: 40, Cooking: 40 }, items: { 'lobster pot': 1 } }, resources: ['catherby:lobster'],
            yields: a => [{ item: 'lobster', perTick: 0.04 + 0.001 * Math.min(59, (a.skills.Fishing ?? 1) - 40) }] },
        { id: 'shop-runes', family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'betty'], env: { ITEMS: 'fire rune|air rune|earth rune', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy elemental runes at Betty', needs: { items: { coins: 3000 }, shortOf: { 'fire rune': SHOP_STOCK, 'air rune': SHOP_STOCK, 'earth rune': SHOP_STOCK } }, resources: ['shop:betty'],
            yields: () => [{ item: 'fire rune', perTick: 0.7 }, { item: 'air rune', perTick: 0.7 }, { item: 'earth rune', perTick: 0.7 }], spends: () => [{ item: 'coins', perTick: 2.1 * 5 }] },
        { id: 'shop-feathers', family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'sarim'], env: { ITEMS: 'feather', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy feathers at Gerrant', needs: { items: { coins: 2000 }, shortOf: { feather: SHOP_STOCK } }, resources: ['shop:sarim'],
            yields: () => [{ item: 'feather', perTick: 3 }], spends: () => [{ item: 'coins', perTick: 3 * 3 }] },
        { id: 'shop-arrowtips', family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'catherby'], env: { ITEMS: 'rune arrowtips|adamant arrowtips', STOCK_TARGET: String(SHOP_STOCK), BANK_PACK: '1', NO_BUY_TICKS: '25' }, role: 'bank',
            goal: 'buy rune and adamant arrowtips at Catherby', needs: { items: { coins: 20000 }, shortOf: { 'rune arrowtips': SHOP_STOCK, 'adamant arrowtips': SHOP_STOCK } }, resources: ['shop:catherby'],
            yields: () => [{ item: 'rune arrowtips', perTick: 0.05 }, { item: 'adamant arrowtips', perTick: 0.05 }], spends: () => [{ item: 'coins', perTick: 0.05 * 260 + 0.05 * 104 }] },
        { id: 'fletch-headless', family: 'fletch', script: 'scripts/fletch-arrows.ts', args: ['15000', 'headless'], env: { BANK_PACK: '1', MAX_MAKE: '390' }, role: 'fletching',
            goal: 'headless arrows from owned shafts and feathers', needs: { items: { 'arrow shaft': 215, feather: 215 } },
            yields: () => [{ item: 'headless arrow', perTick: 5 }] },
        { id: 'shop-rune-arrows', pilot: true, family: 'shop-buyer', script: 'scripts/aio-market.ts', args: ['shop-buy', 'dargaud', '800'],
            env: { ITEMS: 'rune arrow', STOCK_TARGET: String(ARROW_LOW), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(RUNE_ARROW_SPEND + 1000), COIN_RESERVE: '500', MAX_SPEND: String(RUNE_ARROW_SPEND) },
            role: 'bank', goal: "buy rune arrows at Dargaud's shop in the Ranging Guild", resources: ['shop:dargaud'],
            needs: { skills: { Ranged: 40 }, items: { coins: RUNE_ARROW_SPEND + 2000 }, holdsUnder: { 'rune arrow': ARROW_LOW } },
            yields: () => [{ item: 'rune arrow', perTick: ARROW_LOW / 800 }], spends: () => [{ item: 'coins', perTick: RUNE_ARROW_COST / 800 }] },
        ...aioTemplates(),
        ...makerChains(),
        ...squadSupplies(),
        ...makerShopSteps(),
    ];
}
