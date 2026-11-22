// Squad supply gathering templates: runecraft altars, fishing/cooking, combat drops, ground spawns, and blood chest.
import type { Needs, Template } from '../world';
import { AXES, BLOOD_FOOD, BLOOD_MEALS, PICKAXES } from './constants';

const SQUAD_CRAFT_ESSENCE = 28, SQUAD_SHARK_RUN = 25;

export const bankJobArg = (job: Record<string, unknown>) => ['bank-job', `--job=${encodeURIComponent(JSON.stringify(job))}`];
export const tiadecheDangerGate: readonly Needs[] = [{ skills: { Hitpoints: 22 } }, { combat: 32 }, { skills: { Prayer: 43 } }];

export function squadRunecraftSupplies(): Template[] {
    // Water runes crafted from banked rune essence at the water altar (scripts/rune-bank-craft.ts RUNE_ALTAR=water, bench case
    // extra:water-supply): one rune for each essence under Runecraft 19. The talisman is held for good; the essence comes from
    // the fleet's stock through the planner's item orders. The bench case makes 10 runes in 399 to 403 ticks from the Draynor
    // bank (hosted run 44464164017, seeds 1 to 3); the rate below is an estimate for a 28-essence run.
    const waterCraft: Template = { id: 'squad-water-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into water runes at the water altar for the gang squad', resources: ['aio:water-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 5 }, items: { 'water talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'water rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=water', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'water rune', perTick: 0.08 }] };
    const earthCraft: Template = { id: 'squad-earth-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into earth runes at the earth altar for the gang squad', resources: ['squad:varrock-earth-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 9 }, items: { 'earth talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'earth rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=earth', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'earth rune', perTick: 0.08 }] };
    const cosmicCraft: Template = { id: 'squad-cosmic-craft', family: 'aio:skiller:runecraft:bank-craft', script: 'scripts/aio.ts', aio: 'skiller:runecraft:bank-craft',
        worker: 'scripts/rune-bank-craft.ts', args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=cosmic', `ESSENCE_TARGET=${SQUAD_CRAFT_ESSENCE}`, 'CAP=4000'],
        role: 'magic', goal: 'craft banked rune essence into cosmic runes in Zanaris for ring of recoil enchanting', resources: ['squad:cosmic-altar'], squadOnly: true,
        needs: { skills: { Runecraft: 27 }, quests: ['Lost City'], items: { 'dramen staff': 1, 'cosmic talisman': 1, 'rune essence': SQUAD_CRAFT_ESSENCE } }, repeats: false,
        production: { output: 'cosmic rune', outputPerUnit: 1, maximum: SQUAD_CRAFT_ESSENCE, inputs: { 'rune essence': 1 },
            resize: n => ({ args: ['skiller', 'runecraft', 'bank-craft', '99', 'RUNE_ALTAR=cosmic', `ESSENCE_TARGET=${n}`, 'CAP=4000'] }) },
        yields: () => [{ item: 'cosmic rune', perTick: 0.08 }] };
    // The water talisman that squad-water-craft needs: wizards at the Wizards' Tower until one drops (3 in 128; scripts/
    // gather-combat.ts TARGET=wizard UNTIL_ITEM, bench case fighter:wizard). No shop sells one and the Grand Exchange holds none.
    const waterTalisman: Template = { id: 'squad-water-talisman', family: 'aio:fighter:wizard', script: 'scripts/aio.ts', aio: 'fighter:wizard',
        worker: 'scripts/gather-combat.ts', args: ['fighter', 'wizard', '10000', 'wizard', 'MAX_KILLS=200', 'UNTIL_ITEM=water talisman'],
        role: 'combat', goal: "kill wizards at the Wizards' Tower until a water talisman drops, for the gang squad's water runes", resources: ['fighter:wizards-tower'], squadOnly: true,
        needs: { combat: 40, holdsUnder: { 'water talisman': 1 } }, repeats: false, yields: () => [], provides: { item: 'water talisman', unlocks: ['squad-water-craft'] } };
    return [waterCraft, earthCraft, cosmicCraft, waterTalisman];
}

export function squadFishingSupplies(): Template[] {
    // Sharks fished and cooked at Catherby (scripts/shark-supply.ts: Fishing 76, Cooking 80; it buys a harpoon when it has none,
    // and it carries two banked trout, salmon or lobsters for the way back). Bench case extra:shark-supply: 3 sharks in 182, 250 and
    // 348 ticks (hosted run 44470543603, seeds 1 to 3); the rate is from those runs.
    const sharkSteps = (n: number) => ({ args: ['gather', 'fishing', 'shark', String(n), '9000'], env: { SHARK_CONSUMER: 'gang squad' } });
    const sharks: Template = { id: 'squad-sharks', family: 'shark-supply', script: 'scripts/aio-skiller.ts', ...sharkSteps(SQUAD_SHARK_RUN),
        role: 'fishing', goal: 'fish and cook sharks at Catherby for the gang squad', resources: ['squad:catherby-sharks'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 76, Cooking: 80 }, items: { lobster: 2 } },
        production: { output: 'shark', outputPerUnit: 1, maximum: SQUAD_SHARK_RUN, inputs: {}, resize: n => sharkSteps(n) },
        yields: () => [{ item: 'shark', perTick: 0.01 }] };
    // Karambwanji and karambwan fishing (Shilo Village + Tai Bwo Wannai Trio), vessel buy fallback, and Catherby cooking.
    const karambwanjiFish: Template = {
        id: 'squad-karambwanji-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwanji', target: 100, batch: 25, cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2806, z: 3009, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwanji near Tai Bwo Wannai for karambwan bait', resources: ['squad:shilo-karambwanji'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 5, Prayer: 43 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'small fishing net': 1 } },
        production: { output: 'raw karambwanji', outputPerUnit: 1, maximum: 100, inputs: {},
            resize: n => ({ args: bankJobArg({ family: 'fishing', recipe: 'karambwanji', target: n, batch: Math.min(25, n), cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2806, z: 3009, level: 0 } }) }) },
        yields: () => [{ item: 'raw karambwanji', perTick: 0.05 }],
    };
    const karambwanFish: Template = {
        id: 'squad-karambwan-fish', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: 27, batch: 9, cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3118, level: 0 } }),
        role: 'fishing', goal: 'fish raw karambwan north of Tai Bwo Wannai and bank at Shilo Village', resources: ['squad:shilo-karambwan'], squadOnly: true, repeats: false,
        needs: { skills: { Fishing: 65, Prayer: 43 }, quests: ['Shilo Village', 'Tai Bwo Wannai Trio'], items: { 'karambwan vessel': 1, 'raw karambwanji': 27 } },
        production: { output: 'raw karambwan', outputPerUnit: 1, maximum: 27, inputs: { 'raw karambwanji': 3 },
            resize: n => ({ args: bankJobArg({ family: 'fishing', recipe: 'karambwan', target: n, batch: Math.min(9, n), cap: 3000, returnTicks: 600, members: true, reserve: 0, bank: { x: 2852, z: 2955, level: 0 }, site: { x: 2899, z: 3118, level: 0 } }) }) },
        yields: () => [{ item: 'raw karambwan', perTick: 0.02 }],
    };
    const karambwanVessel: Template = {
        id: 'squad-karambwan-vessel', family: 'shop-buyer', script: 'scripts/aio-market.ts',
        args: ['shop-buy', 'tiadeche', '1200'], env: { ITEMS: 'karambwan vessel', STOCK_TARGET: '2', STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '25', FLOAT: '500', COIN_RESERVE: '200', MAX_SPEND: '200' },
        role: 'bank', goal: 'buy karambwan vessels from Tiadeche for squad karambwan fishing', resources: ['shop:tiadeche'], squadOnly: true, repeats: false,
        needs: { quests: ['Tai Bwo Wannai Trio'], items: { coins: 500 }, holdsUnder: { 'karambwan vessel': 1 }, anyOf: tiadecheDangerGate },
        yields: () => [], provides: { item: 'karambwan vessel', unlocks: ['squad-karambwan-fish'] },
    };
    const karambwanCook: Template = {
        id: 'squad-karambwan-cook', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: 112, batch: 28, cap: 1500, returnTicks: 300, members: true, reserve: 0 }),
        role: 'cooking', goal: 'cook banked raw karambwan at Catherby range for the gang squad', resources: ['squad:catherby-cooking'], squadOnly: true, repeats: false,
        needs: { skills: { Cooking: 30 }, quests: ['Tai Bwo Wannai Trio'], items: { 'raw karambwan': 1 } },
        production: { output: 'cooked karambwan', outputPerUnit: 1, maximum: 112, inputs: { 'raw karambwan': 1 },
            resize: n => ({ args: bankJobArg({ family: 'cooking', recipe: 'cooking_generic_karambwan', target: n, batch: Math.min(28, n), cap: 1500, returnTicks: 300, members: true, reserve: 0 }) }) },
        yields: () => [{ item: 'cooked karambwan', perTick: 0.15 }],
    };
    return [sharks, karambwanjiFish, karambwanFish, karambwanVessel, karambwanCook];
}

export const squadMagicLogs = (): Template => ({
    id: 'squad-magic-logs', family: 'aio:skiller:woodcutting:yews', script: 'scripts/aio.ts',
    args: ['skiller', 'woodcutting', 'yews', '3000', '27', 'MAX_TRIPS=4', 'TREE=magic', 'WOOD_GROVE=native-processing'],
    role: 'woodcutting', goal: "chop magic logs at Seers' Village for squad magic shortbows", resources: ['squad:seers-magic-trees'], squadOnly: true, repeats: false,
    needs: { skills: { Woodcutting: 75 }, pieces: { of: ['rune axe', 'adamant axe', 'mithril axe', 'black axe', 'steel axe'], count: 1 } },
    yields: () => [{ item: 'magic log', perTick: 0.01 }],
});

export const squadTaverleyBlackDragons = (): Template => ({
    id: 'squad-taverley-black-dragon', family: 'combat', script: 'scripts/gather-combat.ts',
    args: ['6000', 'taverley_black_dragon'], env: { MAX_KILLS: '10' }, role: 'combat',
    goal: 'slay Black dragons in Taverley Dungeon (non-Wilderness) for black dragonhide and blood/law runes',
    resources: ['squad:taverley-black-dragons'], squadOnly: true, repeats: false,
    needs: { combat: 85, items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 8 },
    yields: () => [{ item: 'dragonhide_black', perTick: 0.01 }, { item: 'blood rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.02 }],
});

export const squadGoldOre = (): Template => ({
    id: 'squad-gold-ore', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
    args: bankJobArg({ family: 'mining', recipe: 'gold_rock_table', target: 28, batch: 28, cap: 2500, returnTicks: 300, members: true, reserve: 0, bank: { x: 2946, z: 3368, level: 0 }, site: { x: 2977, z: 3233, level: 0 } }),
    role: 'mining', goal: 'mine gold ore at Rimmington and bank at Falador West for sapphire rings', resources: ['squad:rimmington-gold'], squadOnly: true, repeats: false,
    needs: { skills: { Mining: 40 }, pieces: { of: PICKAXES, count: 1 } },
    yields: () => [{ item: 'gold ore', perTick: 0.05 }],
});

export function squadWorldGatherers(): Template[] {
    // Non-Wilderness mainland gatherers for potions, secondaries and runes.
    const taverleyDruids: Template = {
        id: 'squad-taverley-druids', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_druid'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Chaos druids (non-Wilderness) for herbs, snape grass, law and nature runes',
        resources: ['squad:taverley-druids'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 4 },
        yields: () => [
            { item: 'unidentified ranarr', perTick: 0.01 }, { item: 'unidentified irit', perTick: 0.01 },
            { item: 'unidentified kwuarm', perTick: 0.008 }, { item: 'unidentified cadantine', perTick: 0.006 },
            { item: 'unidentified dwarf weed', perTick: 0.006 }, { item: 'unidentified marentill', perTick: 0.012 },
            { item: 'unidentified avantoe', perTick: 0.005 }, { item: 'unidentified toadflax', perTick: 0.004 },
            { item: 'unidentified harralander', perTick: 0.008 }, { item: 'snape grass', perTick: 0.005 },
            { item: 'nature rune', perTick: 0.02 }, { item: 'law rune', perTick: 0.015 },
        ],
    };
    const taverleyBlackKnights: Template = {
        id: 'squad-taverley-black-knights', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'taverley_black_knight'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm Taverley Dungeon Black Knights (non-Wilderness) for death, chaos, cosmic and law runes',
        resources: ['squad:taverley-black-knights'], squadOnly: true, repeats: false,
        needs: { combat: 45, food: 6 },
        yields: () => [
            { item: 'death rune', perTick: 0.015 }, { item: 'chaos rune', perTick: 0.025 },
            { item: 'cosmic rune', perTick: 0.008 }, { item: 'law rune', perTick: 0.01 },
            { item: 'unidentified ranarr', perTick: 0.004 }, { item: 'mithril bar', perTick: 0.005 },
        ],
    };
    const ardougneGiants: Template = {
        id: 'squad-ardougne-giants', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'giant'], env: { MAX_KILLS: '40' }, role: 'combat',
        goal: 'farm surface Hill Giants for limpwurt roots, cosmic, death, chaos and nature runes and herbs',
        resources: ['squad:ardougne-giants'], squadOnly: true, repeats: false,
        needs: { combat: 30, food: 4 },
        yields: () => [
            { item: 'limpwurt root', perTick: 0.02 }, { item: 'nature rune', perTick: 0.03 },
            { item: 'cosmic rune', perTick: 0.015 }, { item: 'law rune', perTick: 0.015 },
            { item: 'chaos rune', perTick: 0.01 }, { item: 'death rune', perTick: 0.004 },
            { item: 'uncut sapphire', perTick: 0.003 }, { item: 'uncut emerald', perTick: 0.003 },
            { item: 'unidentified ranarr', perTick: 0.005 },
        ],
    };
    const edgevilleUnicorns: Template = {
        id: 'squad-edgeville-unicorns', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['6000', 'unicorn'], env: { MAX_KILLS: '28' }, role: 'combat',
        goal: 'hunt Edgeville surface Unicorns (south of Wilderness border) for unicorn horns',
        resources: ['squad:edgeville-unicorns'], squadOnly: true, repeats: false,
        needs: { combat: 25, food: 2 },
        yields: () => [{ item: 'unicorn horn', perTick: 0.06 }],
    };
    const snapeGrass: Template = {
        id: 'squad-snape-grass', family: 'gather-spawn', script: 'scripts/aio-skiller.ts',
        args: ['gather', 'foraging', 'spawn', '231', '27'], env: { TICKS: '3000' }, role: 'herblore',
        goal: 'gather snape grass at Hobgoblin peninsula (non-Wilderness) for prayer potions',
        resources: ['squad:hobgoblin-snape'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'snape grass', perTick: 0.08 }],
    };
    const taverleyScales: Template = {
        id: 'squad-taverley-scales', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'taverley_scales'], env: { MAX_KILLS: '27' }, role: 'herblore',
        goal: 'gather blue dragon scales in Taverley Dungeon (Dusty key + Anti-dragon shield) for weapon poison',
        resources: ['squad:taverley-scales'], squadOnly: true, repeats: false,
        needs: { items: { 'anti-dragon shield': 1, 'dusty key': 1 }, food: 4 },
        yields: () => [{ item: 'blue dragon scale', perTick: 0.04 }],
    };
    const chaosWine: Template = {
        id: 'squad-chaos-wine', family: 'combat', script: 'scripts/gather-combat.ts',
        args: ['4000', 'chaos_wine'], env: { MAX_KILLS: '25', TELEGRAB_MAX: '25' }, role: 'magic',
        goal: 'telekinetic-grab Wine of Zamorak at the Chaos Temple south of Wilderness for ranging potions',
        resources: ['squad:chaos-temple-wine'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 33 }, items: { 'law rune': 25, 'air rune': 25 } },
        yields: () => [{ item: 'wine of zamorak', perTick: 0.03 }],
    };
    const whiteBerries: Template = {
        id: 'squad-white-berries', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/aio-logistics.ts walk-to 2262 3168', 'scripts/aio-skiller.ts gather foraging spawn 239 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather white berries in Isafdar (post-Regicide, non-Wilderness) for super defence potions',
        resources: ['squad:isafdar-berries'], squadOnly: true, repeats: false,
        needs: { quests: ['Regicide'] },
        yields: () => [{ item: 'white berrie', perTick: 0.05 }],
    };
    const barbarianPlanks: Template = {
        id: 'squad-barbarian-planks', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/aio-logistics.ts walk-to 2552 3574', 'scripts/aio-skiller.ts gather foraging spawn 960 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'supply',
        goal: 'gather planks at Barbarian Outpost (non-Wilderness) for quest demand',
        resources: ['squad:barbarian-planks'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'plank', perTick: 0.08 }],
    };
    const gnomeToads: Template = {
        id: 'squad-gnome-toads', family: 'gather-spawn', script: 'scripts/chain.ts',
        args: ['scripts/aio-logistics.ts walk-to 2417 3512', 'scripts/aio-skiller.ts gather foraging spawn 2150 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
        goal: 'gather swamp toads in Tree Gnome Stronghold for agility potions',
        resources: ['squad:gnome-toads'], squadOnly: true, repeats: false,
        yields: () => [{ item: 'swamp toad', perTick: 0.12 }],
    };
    const bloodChest: Template = {
        id: 'squad-blood-chest', family: 'aio:skiller:thieving:blood-chest', script: 'scripts/aio-skiller.ts',
        args: ['gather', 'thieving', 'blood-chest'], role: 'thieving', goal: 'loot the Ardougne Castle blood rune chests for the gang squad',
        resources: ['squad:ardougne-blood-chest'], squadOnly: true, repeats: false,
        needs: { skills: { Thieving: 59 }, pieces: { of: BLOOD_FOOD, count: BLOOD_MEALS } },
        yields: () => [{ item: 'blood rune', perTick: 0.01 }, { item: 'coins', perTick: 2.5 }],
    };
    return [taverleyDruids, taverleyBlackKnights, ardougneGiants, edgevilleUnicorns, snapeGrass, taverleyScales, chaosWine, whiteBerries, barbarianPlanks, gnomeToads, bloodChest];
}

export const squadKaramjaEggs = (): Template => ({
    id: 'squad-karamja-red-spiders-eggs', family: 'gather-spawn', script: 'scripts/chain.ts',
    args: ['scripts/aio-logistics.ts walk-to 2832 9586', 'scripts/aio-skiller.ts gather foraging spawn 223 27'], env: { TICKS: '3000', ROUNDS: '1' }, role: 'herblore',
    goal: "gather red spiders' eggs in Karamja Volcano (non-Wilderness) for super restore potions",
    resources: ['squad:karamja-red-spiders-eggs'], squadOnly: true, repeats: false,
    needs: { items: { coins: 120 }, food: 4, anyOf: [{ skills: { Hitpoints: 23 } }, { combat: 34 }, { skills: { Prayer: 43 } }] },
    yields: () => [{ item: "red spiders' egg", perTick: 0.04 }],
});
