// Army quest bands (Lost City, Holy Grail, Fremennik, Underground Pass, Regicide) and black-dragon hunt / d'hide crafting bands.
import { spellFact } from '../../../../core/src/content-facts';
import {
    AIO_PLACES, ARMY_BANK, BLACK_CAVE, FREMENNIK, FREMENNIK_BAND, FREMENNIK_MEALS, GRAIL_BAND,
    GRAIL_MEALS, GRAIL_PLACE, LOST_CITY, LOST_CITY_MEALS, QUEST_BAND, QUEST_DEMAND_BAND,
    REGICIDE_BAND, UPASS, UPASS_BAND, type Template,
} from '../world';
import {
    ARMOUR_SETS, FLAX_SPIN, FLETCH_KEEP, FLETCH_MAKE, FLETCH_TO, GRAIL_RUNES, HIDE_TARGET,
    HUNT_ARROWS, HUNT_ARROW_STOCK, HUNT_BAND, HUNT_FOOD, HUNT_KILLS, HUNT_RUNE_ARROWS,
    HUNT_RUNE_SPEND, HUNT_RUNE_STOCK, JAKUT_CAP, JAKUT_COINS, JAKUT_RESERVE, JAKUT_SWORDS,
    JAKUT_WAIT, LEATHER_LEVEL, LOST_CITY_BUILD, LOST_CITY_MEAL_ITEMS, QUEST_BOW_ARROWS,
    REGICIDE_MEALS, REGICIDE_PACK, REGICIDE_RUNES, SET_HIDES, SET_SHOP, TAN_COIN,
    UPASS_AGILITY, UPASS_MEALS, UPASS_THIEVING, shopRun,
} from './constants';
import { questDemand } from './aio';

export function armyQuestAndHuntTemplates(): { quests: Template[]; hunt: Template[]; leather: Template[] } {
    const lostCity: Template = {
        id: 'army-quest-lostcity', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,zanaris'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and Lost City to wield dragon weapons", tier: 'goal', band: QUEST_BAND,
        quest: { name: 'Lost City', unlocks: [] }, resources: [LOST_CITY], yields: () => [],
        needs: { items: { coins: 5000 }, anyOf: [{ skills: { Prayer: 43, Hitpoints: 90, Defence: 90 }, pieces: { of: LOST_CITY_MEAL_ITEMS, count: LOST_CITY_MEALS } }, LOST_CITY_BUILD] }, kitFirst: true,
    };
    const holyGrail: Template = {
        id: 'army-quest-holygrail', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'merlin,grail'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, role: 'quest',
        goal: "complete Merlin's Crystal and Holy Grail for 275,000 Prayer experience", tier: 'goal', band: GRAIL_BAND,
        quest: { name: 'Holy Grail', unlocks: [] }, resources: [GRAIL_PLACE], yields: () => [],
        needs: { skills: { Prayer: 43, Magic: spellFact('camelot_teleport').level, Attack: 90, Strength: 90, Hitpoints: 90, Defence: 90 }, under: { Prayer: 99 }, items: { coins: 2000, 'rune scimitar': 1, ...GRAIL_RUNES },
            pieces: { of: LOST_CITY_MEAL_ITEMS, count: GRAIL_MEALS } }, kitFirst: true,
    };
    const fremennik: Template = {
        id: 'army-quest-fremennik', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'drunkmonk,murder,viking'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest',
        goal: "complete Monk's Friend, Murder Mystery and The Fremennik Trials to wear a Fremennik helm", tier: 'goal', band: FREMENNIK_BAND,
        quest: { name: 'The Fremennik Trials', unlocks: [] }, resources: [FREMENNIK], yields: () => [],
        needs: { skills: { Prayer: 43, Hitpoints: 90, Fletching: 25 }, items: { coins: 6000 }, pieces: { of: LOST_CITY_MEAL_ITEMS, count: FREMENNIK_MEALS },
            anyOf: [{ skills: { Attack: 60, Strength: 60 } }, { skills: { Strength: 99 } }] }, kitFirst: true,
    };
    const fletch: Template = {
        id: 'army-fletch-25', family: 'fletch', script: 'scripts/chain.ts', pilot: true, buildOnly: true, route: 'The Fremennik Trials', role: 'fletching',
        args: [`scripts/aio-logistics.ts walk-to ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to the Fletching 25 that The Fremennik Trials ask', tier: 'goal', band: FREMENNIK_BAND - 0.01, repeats: false,
        trains: { skill: 'Fletching', to: FLETCH_TO, unlocks: [fremennik.id] }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_MAKE + FLETCH_KEEP, feather: FLETCH_MAKE + FLETCH_KEEP } },
    };
    const FLETCH_30_MAKE = 540;
    const questFletch30: Template = {
        id: 'army-quest-fletch-30', family: 'fletch', script: 'scripts/chain.ts', pilot: true, noReserve: true, role: 'fletching',
        args: [`scripts/aio-logistics.ts walk-to ${ARMY_BANK.x} ${ARMY_BANK.z}`, `scripts/fletch-arrows.ts 3000 headless MAX_MAKE=${FLETCH_30_MAKE} SHAFT_RESERVE=${FLETCH_KEEP} FEATHER_RESERVE=${FLETCH_KEEP} BANK_PACK=1`],
        env: { ROUNDS: '1' }, goal: 'make headless arrows to reach Fletching 30 for quest board progression', tier: 'goal', band: QUEST_DEMAND_BAND - 0.02, repeats: false,
        trains: { skill: 'Fletching', to: 30, unlocks: questDemand().map(q => q.id) }, yields: () => [],
        needs: { items: { 'arrow shaft': FLETCH_30_MAKE + FLETCH_KEEP, feather: FLETCH_30_MAKE + FLETCH_KEEP } },
    };
    const BOW_KIT = { 'magic shortbow': 1, 'rune arrow': QUEST_BOW_ARROWS };
    const upass: Template = {
        id: 'army-quest-upass', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'elena,biohazard,upass'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Attack'],
        goal: 'complete Plague City, Biohazard and Underground Pass on the way to the dragon halberd', tier: 'goal', band: UPASS_BAND,
        quest: { name: 'Underground Pass', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { skills: { Ranged: 99, Prayer: 43, Hitpoints: 90, Thieving: UPASS_THIEVING, Agility: UPASS_AGILITY }, items: { coins: 5000, ...BOW_KIT, 'prayer potion(4)': 2 },
            pieces: { of: LOST_CITY_MEAL_ITEMS, count: UPASS_MEALS } }, kitFirst: true,
    };
    const regicide: Template = {
        id: 'army-quest-regicide', family: 'aio:quester:mode:chain', script: 'scripts/aio.ts', args: ['quester', 'chain', 'murder,regicide'],
        aio: 'quester:mode:chain', worker: 'scripts/quest-chain.ts', pilot: true, buildOnly: true, role: 'quest', gives: ['Magic'],
        goal: 'complete Murder Mystery and Regicide to wield the dragon halberd', tier: 'goal', band: REGICIDE_BAND,
        quest: { name: 'Regicide', unlocks: [] }, resources: [UPASS], yields: () => [],
        needs: { quests: ['Underground Pass'], skills: { Ranged: 99, Magic: spellFact('ardougne_teleport').level, Prayer: 43, Hitpoints: 90, Agility: UPASS_AGILITY }, items: { coins: 2000, ...BOW_KIT, ...REGICIDE_RUNES, ...REGICIDE_PACK },
            pieces: { of: LOST_CITY_MEAL_ITEMS, count: REGICIDE_MEALS } }, kitFirst: true,
    };
    const upassThieve: Template = {
        id: 'army-thieve-50', family: 'thieving60', script: 'scripts/generated/thieving60.ts', env: { TARGET: String(UPASS_THIEVING), CAP: '2500', CLEAN_FOOD: '1' },
        pilot: true, buildOnly: true, route: 'Underground Pass', role: 'thieving', goal: 'train Thieving to the 50 that the cage doors of Underground Pass ask',
        tier: 'goal', band: UPASS_BAND - 0.02, repeats: true, trains: { skill: 'Thieving', to: UPASS_THIEVING, unlocks: [upass.id] }, yields: () => [],
    };
    const upassAgility: Template = {
        id: 'army-agility-68', family: 'aio:skiller:agility:order', script: 'scripts/aio.ts', args: ['skiller', 'agility', 'order', 'gnome', String(UPASS_AGILITY)],
        aio: 'skiller:agility:order', worker: 'scripts/agility-order.ts', pilot: true, buildOnly: true, route: 'Underground Pass', role: 'agility',
        goal: 'run the Gnome Stronghold course to the Agility 68 from which no bridge of Underground Pass fails',
        tier: 'goal', band: UPASS_BAND - 0.01, repeats: true, trains: { skill: 'Agility', to: UPASS_AGILITY, unlocks: [upass.id, regicide.id] }, yields: () => [],
    };
    const dustyKey: Template = {
        id: 'army-dusty-key', pilot: true, family: 'aio:quester:mode:dusty-key', script: 'scripts/aio.ts', args: ['quester', 'dusty-key'], aio: 'quester:mode:dusty-key', worker: 'scripts/dusty-key.ts',
        role: 'quest', goal: "get the dusty key from Velrak for Taverley dungeon's inner gate", tier: 'goal', band: HUNT_BAND, filler: true, repeats: false, stock: { item: 'dusty key', to: 1 }, yields: () => [],
        needs: { skills: { Attack: 90, Strength: 90, Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 } },
    };
    const huntOn = (id: string, arrow: string, arrows = HUNT_ARROWS): Template => ({
        id, pilot: true, family: 'combat-train', script: 'scripts/black-dragon-camp.ts', args: ['9000'],
        env: { KILLS: String(HUNT_KILLS), ARROW: arrow.replace(' ', '_'), ARROWS: String(arrows) }, role: 'combat', goal: `kill Taverley's black dragons for their hides and bones, on ${arrow}s`,
        tier: 'goal', band: HUNT_BAND, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: [BLACK_CAVE], yields: () => [],
        ownSupply: ['rune arrow', 'iron arrow', 'bronze arrow', 'air rune', 'fire rune'],
        needs: { skills: { Defence: 90, Hitpoints: 90, Ranged: 90, Prayer: 60, Magic: 25 },
            items: { 'dusty key': 1, 'magic shortbow': 1, [arrow]: arrows, 'law rune': 1, 'air rune': 3, 'fire rune': 1, shark: HUNT_FOOD } },
    });
    const huntRune: Template = { ...huntOn('army-hunt-black-dragons-rune', 'rune arrow', HUNT_RUNE_ARROWS), band: HUNT_BAND - 0.01 };
    const hunt = huntOn('army-hunt-black-dragons', 'iron arrow'), huntBronze = huntOn('army-hunt-black-dragons-bronze', 'bronze arrow');
    const huntSupplyRune: Template = {
        id: 'army-hunt-supply-rune', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('dargaud', 2500, 'rune.arrow', HUNT_RUNE_ARROWS, HUNT_RUNE_SPEND, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy rune arrows at the Ranging Guild and teleport runes at Aubury's for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:dargaud', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: HUNT_RUNE_SPEND + 4000 }, shortOf: { 'rune arrow': HUNT_RUNE_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    const huntSupply: Template = {
        id: 'army-hunt-supply', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [shopRun('lowe', 2500, 'iron.arrow|bronze.arrow', HUNT_ARROW_STOCK, 28000, 8), shopRun('aubury', 800, 'air.rune|fire.rune', HUNT_RUNE_STOCK, 2000, 8)],
        env: { ROUNDS: '1' }, role: 'supply', goal: "buy iron and bronze arrows at Lowe's and teleport runes at Aubury's in Varrock for the black dragon hunt",
        tier: 'goal', band: HUNT_BAND + 0.3, filler: true, repeats: true, stock: { item: 'dragonhide', to: HIDE_TARGET }, resources: ['shop:lowe', 'shop:aubury'], yields: () => [],
        needs: { skills: hunt.needs!.skills, items: { coins: 32000 }, shortOf: { 'iron arrow': HUNT_ARROWS, 'air rune': 3, 'fire rune': 1 } },
    };
    const jakut: Template = {
        id: 'army-jakut-swords', pilot: true, family: 'shop-buyer', script: 'scripts/chain.ts', env: { ROUNDS: '1' },
        args: [['scripts/aio-market.ts', 'shop-buy', 'jukat', String(JAKUT_CAP), 'BLIND_BUY=1', `STOCK_TARGET=${JAKUT_SWORDS}`, 'STOP_AT_TARGET=1', 'BANK_AT=0', `NO_BUY_TICKS=${JAKUT_WAIT}`, 'STALL_TICKS=0',
            `COIN_RESERVE=${JAKUT_RESERVE}`, `FLOAT=${JAKUT_COINS}`].join(' ')],
        role: 'supply', goal: 'buy dragon longswords from Jakut in the Zanaris market', resources: ['shop:jukat'],
        tier: 'goal', band: HUNT_BAND + 0.05, filler: true, repeats: false, stock: { item: 'dragon longsword', to: 1 }, yields: () => [],
        needs: { quests: ['Lost City'], items: { 'dramen staff': 1, diamond: 1, coins: JAKUT_COINS } },
    };
    const leatherNeeds = { ...hunt.needs!.skills, Crafting: 10 };
    const leatherTrain = { skill: 'Crafting', to: LEATHER_LEVEL, unlocks: [] };
    const dhideSets: Template = {
        id: 'army-black-dhide-sets', pilot: true, family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/aio.ts', args: ['skiller', 'crafting', 'black-dhide-sets'],
        aio: 'skiller:crafting:black-dhide-sets', worker: 'scripts/black-dhide-sets.ts', role: 'crafting', goal: 'tan black dragonhide at Al Kharid and craft sets of body, chaps and vambraces',
        tier: 'goal', band: HUNT_BAND + 0.1, filler: true, repeats: true, stock: { item: 'dragonhide body', to: ARMOUR_SETS }, yields: () => [],
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP }, holds: { dragonhide: SET_HIDES } },
    };
    const leatherFlax: Template = {
        id: 'army-leather-flax', pilot: true, family: 'aio:skiller:foraging:flax', script: 'scripts/aio.ts', args: ['skiller', 'foraging', 'flax', '1800', '28'],
        aio: 'skiller:foraging:flax', worker: 'scripts/gather-flax.ts', role: 'crafting', goal: 'pick flax at Seers to spin for the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, resources: [AIO_PLACES.flax], yields: () => [],
        needs: { skills: leatherNeeds, holdsUnder: { flax: FLAX_SPIN } },
    };
    const leatherSpin: Template = {
        id: 'army-leather-spin', pilot: true, family: 'aio:skiller:crafting:bowstrings', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'bowstrings', '2500', `MAX_MAKE=${FLAX_SPIN}`, 'RAW_RESERVE=0', 'MAX_TRIPS=8'],
        aio: 'skiller:crafting:bowstrings', worker: 'scripts/spin-bowstrings.ts', role: 'crafting', goal: 'spin flax at Seers to the Crafting a black dragonhide body asks',
        tier: 'goal', band: HUNT_BAND + 0.2, filler: true, repeats: true, trains: leatherTrain, yields: () => [],
        needs: { skills: leatherNeeds, holds: { flax: FLAX_SPIN } },
    };
    return {
        quests: [lostCity, ...questDemand(), fletch, questFletch30, fremennik, upassThieve, upassAgility, upass, regicide, holyGrail, dustyKey],
        hunt: [huntRune, hunt, huntBronze, huntSupplyRune, huntSupply, jakut],
        leather: [dhideSets, leatherFlax, leatherSpin],
    };
}
