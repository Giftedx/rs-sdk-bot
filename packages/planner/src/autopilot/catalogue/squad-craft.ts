// Squad crafting, smithing, fletching, d'hide armour, jewellery/glory, and crystal chest templates.
import { DRAYNOR_BANK, SEERS_BANK, type Template } from '../world';
import { SQUAD_UNIT_COST } from '../pricing';
import { LEATHER_LEVEL, MAKE_BATCH, RING_BATCH, SET_HIDES, SET_SHOP, TAN_COIN } from './constants';
import { bankJobArg } from './squad-gather';
import { invMake } from './squad-herblore';

const SQUAD_RUNE_SETS = 20;

export function squadFletchAndSmithSupplies(): { arrows: Template[]; smiths: Template[] } {
    const runeSteps = (sets: number) => {
        const tips = sets * 15, spend = tips * SQUAD_UNIT_COST['rune arrowtips']! * 2;
        return [`scripts/shop-buyer.ts catherby 1200 ITEMS=rune.arrowtips STOCK_TARGET=${tips} STOP_AT_TARGET=1 BANK_PACK=1 NO_BUY_TICKS=25 FLOAT=${spend + 200} COIN_RESERVE=200 MAX_SPEND=${spend}`,
            `scripts/fletch-arrows.ts 3000 native-arrows rune MAX_MAKE=${tips} HEADLESS_RESERVE=0 TIP_RESERVE=0`];
    };
    const runeArrows: Template = { id: 'squad-rune-arrows', family: 'fletch', script: 'scripts/chain.ts', args: runeSteps(SQUAD_RUNE_SETS), env: { ROUNDS: '1' },
        role: 'fletching', goal: 'buy rune arrowtips at Catherby and fletch them with banked headless arrows into rune arrows for the gang squad',
        resources: ['shop:catherby'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { coins: SQUAD_RUNE_SETS * 15 * SQUAD_UNIT_COST['rune arrowtips']! * 2 + 200, 'headless arrow': SQUAD_RUNE_SETS * 15 } },
        production: { output: 'rune arrow', outputPerUnit: 15, maximum: SQUAD_RUNE_SETS, inputs: { 'headless arrow': 15 }, resize: n => ({ args: runeSteps(n) }) },
        yields: () => [{ item: 'rune arrow', perTick: 1 }], spends: () => [{ item: 'coins', perTick: SQUAD_UNIT_COST['rune arrowtips']! }] };
    const bankedRuneArrowSets = SQUAD_RUNE_SETS * 2;
    const fletchBankedRuneArrows: Template = {
        id: 'squad-fletch-rune-arrows-bank', family: 'fletch', script: 'scripts/fletch-arrows.ts',
        args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(bankedRuneArrowSets * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' },
        role: 'fletching', goal: 'fletch banked rune arrowtips and headless arrows into rune arrows for the gang squad',
        resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 75 }, items: { 'headless arrow': 15, 'rune arrowtips': 15 } },
        production: {
            output: 'rune arrow', outputPerUnit: 15, maximum: bankedRuneArrowSets, inputs: { 'headless arrow': 15, 'rune arrowtips': 15 },
            resize: n => ({ args: ['3000', 'native-arrows', 'rune'], env: { MAX_MAKE: String(n * 15), HEADLESS_RESERVE: '0', TIP_RESERVE: '0' } }),
        },
        yields: () => [{ item: 'rune arrow', perTick: 2 }],
    };
    const smithAnvil = (id: string, productId: number, item: string, level: number, bars: number, outputPerUnit = 1, max = Math.max(1, Math.floor(27 / bars)), barName = 'runite bar'): Template => {
        const argsFor = (n: number) => ['skiller', 'smithing', 'anvil', '1500', 'ORDER_ACTION=smith', `PRODUCT_ID=${productId}`, `MAX_MAKE=${n}`, 'BAR_RESERVE=0'];
        return {
            id, family: 'aio:skiller:smithing:anvil', script: 'scripts/aio.ts', args: argsFor(max), role: 'smithing',
            goal: `smith ${item} from banked ${barName}s at Varrock West for supply demand`, resources: ['squad:varrock-smithing'], squadOnly: true, repeats: false,
            needs: { skills: { Smithing: level }, items: { hammer: 1, [barName]: bars, coins: 10 } },
            production: { output: item, outputPerUnit, maximum: max, inputs: { [barName]: bars }, resize: n => ({ args: argsFor(n) }) },
            yields: () => [{ item, perTick: 0.005 * outputPerUnit }],
        };
    };
    return {
        arrows: [runeArrows, fletchBankedRuneArrows],
        smiths: [
            smithAnvil('squad-smith-rune-tips', 44, 'rune arrowtips', 90, 1, 15, 27),
            smithAnvil('squad-smith-rune-full-helm', 1163, 'rune full helm', 92, 2, 1, 10),
            smithAnvil('squad-smith-rune-kiteshield', 1201, 'rune kiteshield', 97, 3, 1, 8),
            smithAnvil('squad-smith-rune-platelegs', 1079, 'rune plateleg', 99, 3, 1, 8),
            smithAnvil('squad-smith-rune-platebody', 1127, 'rune platebody', 99, 5, 1, 5),
            smithAnvil('squad-smith-steel-nails', 1539, 'nail', 34, 1, 2, 27, 'steel bar'),
        ],
    };
}

export function squadCraftAndGearSupplies(): { bow: Template; dhideAndChest: Template[]; ringsAndGold: Template[]; dragonstone: Template[] } {
    const bowStep = (recipe: string, n: number) => `scripts/aio.ts skiller crafting inventory ${recipe} MAX_MAKE=${n} CAP=1500 MEMBERS=1 ORDER_MODE=best-effort`;
    const bowBankWalk = `scripts/walk-to.ts ${SEERS_BANK.x} ${SEERS_BANK.z}`;
    const magicShortbow: Template = {
        id: 'squad-magic-shortbow', family: 'fletch', script: 'scripts/chain.ts',
        args: [bowBankWalk, bowStep('cut-bow:unstrung_magic_shortbow', 4), bowStep('bow-string:magic_shortbow', 4)], env: { ROUNDS: '1' },
        role: 'fletching', goal: 'cut banked magic logs into magic shortbows and string them for the gang squad', resources: ['squad:seers-fletch'], squadOnly: true, repeats: false,
        needs: { skills: { Fletching: 80 }, items: { knife: 1, 'magic log': 1, 'bow string': 1 } },
        production: { output: 'magic shortbow', outputPerUnit: 1, maximum: 4, inputs: { 'magic log': 1, 'bow string': 1 },
            resize: n => ({ args: [bowBankWalk, bowStep('cut-bow:unstrung_magic_shortbow', n), bowStep('bow-string:magic_shortbow', n)] }) },
        yields: () => [{ item: 'magic shortbow', perTick: 0.02 }],
    };
    const blackDhideSets: Template = {
        id: 'squad-black-dhide-sets', family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/black-dhide-sets.ts',
        args: [], role: 'crafting', goal: 'tan banked black dragonhide at Al Kharid and craft full black dragonhide sets for the gang squad',
        resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: LEATHER_LEVEL }, items: { coins: SET_HIDES * TAN_COIN + SET_SHOP, dragonhide_black: SET_HIDES } },
        yields: () => [{ item: 'black_dragonhide_body', perTick: 0.02 }, { item: 'black_dragonhide_chaps', perTick: 0.02 }, { item: 'black_dragon_vambraces', perTick: 0.02 }],
    };
    const blackDhideVambraces: Template = {
        id: 'squad-black-dhide-vambraces', family: 'aio:skiller:crafting:black-dhide-sets', script: 'scripts/black-dhide-sets.ts',
        args: [], env: { PIECE: 'vambraces', SETS: '0' }, role: 'crafting',
        goal: 'tan banked black dragonhide or craft black dragon leather into black dragonhide vambraces at Al Kharid',
        resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 79 }, items: { coins: TAN_COIN + SET_SHOP }, anyOf: [{ items: { dragonhide_black: 1 } }, { items: { dragon_leather_black: 1 } }] },
        yields: () => [{ item: 'black_dragon_vambraces', perTick: 0.02 }],
    };
    const crystalChest: Template = {
        id: 'squad-crystal-chest', family: 'crystal-chest', script: 'scripts/crystal-chest.ts',
        args: ['2000'], env: { MAX_KEYS: '4' }, role: 'crafting',
        goal: 'open Taverley crystal chests with banked crystal keys or key halves for uncut dragonstones and cosmic runes',
        resources: ['squad:crystal-chest'], squadOnly: true, repeats: false,
        needs: { anyOf: [{ items: { 'crystal key': 1 } }, { items: { keyhalf1: 1, keyhalf2: 1 } }] },
        yields: () => [{ item: 'uncut dragonstone', perTick: 0.05 }, { item: 'cosmic rune', perTick: 0.03 }],
    };
    const chargeGlory: Template = {
        id: 'squad-charge-glory', family: 'charge-glory', script: 'scripts/charge-glory.ts',
        args: ['2000'], env: { MAX_GLORIES: '28' }, role: 'magic',
        goal: 'recharge uncharged or partial amulets of glory at the Fountain of Heroes for the gang squad',
        resources: ['squad:heroes-fountain'], squadOnly: true, repeats: false,
        needs: {
            quests: ["Hero's Quest"], skills: { Hitpoints: 75 },
            anyOf: [{ items: { 'amulet of glory': 1 } }, { items: { 'amulet of glory(1)': 1 } }, { items: { 'amulet of glory(2)': 1 } }, { items: { 'amulet of glory(3)': 1 } }],
        },
        yields: () => [{ item: 'amulet of glory(4)', perTick: 0.08 }],
    };
    const goldBars: Template = {
        id: 'squad-gold-bars', family: 'aio:skiller:smithing:smelt', script: 'scripts/aio.ts',
        args: ['skiller', 'smithing', 'smelt', '1500', 'gold', 'MAX_MAKE=28', 'ORE_RESERVE=0'], role: 'smithing',
        goal: 'smelt banked gold ore into gold bars at Al Kharid for sapphire rings', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Smithing: 40 }, items: { 'gold ore': 28 } },
        production: { output: 'gold bar', outputPerUnit: 1, maximum: 28, inputs: { 'gold ore': 1 },
            resize: n => ({ args: ['skiller', 'smithing', 'smelt', '1500', 'gold', `MAX_MAKE=${n}`, 'ORE_RESERVE=0'] }) },
        yields: () => [{ item: 'gold bar', perTick: 0.08 }],
    };
    const cutSapphire: Template = {
        id: 'squad-cut-sapphire', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-sapphire', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut sapphires for sapphire rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { chisel: 1, 'uncut sapphire': 1 } },
        production: { output: 'sapphire', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut sapphire': 1 },
            resize: n => ({ args: ['cut-sapphire', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'sapphire', perTick: 0.15 }],
    };
    const cutEmerald: Template = {
        id: 'squad-cut-emerald', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-emerald', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut emeralds for emerald rings', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { chisel: 1, 'uncut emerald': 1 } },
        production: { output: 'emerald', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut emerald': 1 },
            resize: n => ({ args: ['cut-emerald', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=0', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'emerald', perTick: 0.15 }],
    };
    const sapphireRings: Template = {
        id: 'squad-sapphire-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut sapphires into sapphire rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 20 }, items: { 'ring mould': 1, 'gold bar': 1, sapphire: 1 } },
        production: { output: 'sapphire ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, sapphire: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=sapphire_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'sapphire ring', perTick: 0.05 }],
    };
    const emeraldRings: Template = {
        id: 'squad-emerald-ring', family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500'], role: 'crafting',
        goal: 'smith banked gold bars and cut emeralds into emerald rings at Al Kharid', resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 27 }, items: { 'ring mould': 1, 'gold bar': 1, emerald: 1 } },
        production: { output: 'emerald ring', outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, emerald: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', 'RECIPE=emerald_ring', `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500'] }) },
        yields: () => [{ item: 'emerald ring', perTick: 0.05 }],
    };
    const enchantRecoil: Template = {
        id: 'squad-ring-of-recoil', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked sapphire rings into rings of recoil at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 7 }, items: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 } },
        production: { output: 'ring of recoil', outputPerUnit: 1, maximum: 27, inputs: { 'sapphire ring': 1, 'cosmic rune': 1, 'water rune': 1 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:sapphire_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of recoil', perTick: 0.25 }],
    };
    const enchantDueling: Template = {
        id: 'squad-ring-of-dueling', family: 'aio:skiller:magic:items', script: 'scripts/aio.ts',
        args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', '27', '1500'], role: 'magic',
        goal: 'enchant banked emerald rings into rings of dueling(8) at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 27 }, items: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 } },
        production: { output: 'ring of dueling(8)', outputPerUnit: 1, maximum: 27, inputs: { 'emerald ring': 1, 'cosmic rune': 1, 'air rune': 3 },
            resize: n => ({ args: ['skiller', 'magic', 'items', 'enchant:emerald_ring', '-', String(n), '1500'] }) },
        yields: () => [{ item: 'ring of dueling(8)', perTick: 0.25 }],
    };
    const cutDragonstone: Template = {
        id: 'squad-cut-dragonstone', family: 'skiller:crafting:inventory', script: 'scripts/microbot-production.ts',
        args: ['cut-dragonstone', `MAX_MAKE=${MAKE_BATCH}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'], role: 'crafting',
        goal: 'cut banked uncut dragonstones into dragonstones for dragonstone jewellery', resources: ['squad:herblore-bank'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: 55 }, items: { chisel: 1, 'uncut dragonstone': 1 } },
        production: { output: 'dragonstone', outputPerUnit: 1, maximum: MAKE_BATCH, inputs: { 'uncut dragonstone': 1 },
            resize: n => ({ args: ['cut-dragonstone', `MAX_MAKE=${n}`, 'CAP=1500', 'MEMBERS=1', 'ORDER_MODE=best-effort'] }) },
        yields: () => [{ item: 'dragonstone', perTick: 0.15 }],
    };
    const dragonstoneJewellery = (id: string, recipe: string, output: string, level: number, mould: string): Template => ({
        id, family: 'aio:skiller:crafting:jewellery-trip', script: 'scripts/aio.ts',
        args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${RING_BATCH}`, `BATCH=${RING_BATCH}`, 'CAP=1500', 'MEMBERS=1'], role: 'crafting',
        goal: `smith banked gold bars and cut dragonstones into ${output}s at Al Kharid`, resources: ['squad:al-kharid-craft'], squadOnly: true, repeats: false,
        needs: { skills: { Crafting: level }, items: { [mould]: 1, 'gold bar': 1, dragonstone: 1 } },
        production: { output, outputPerUnit: 1, maximum: RING_BATCH, inputs: { 'gold bar': 1, dragonstone: 1 },
            resize: n => ({ args: ['skiller', 'crafting', 'jewellery-trip', `RECIPE=${recipe}`, `TARGET=${n}`, `BATCH=${n}`, 'CAP=1500', 'MEMBERS=1'] }) },
        yields: () => [{ item: output, perTick: 0.05 }],
    });
    const DRAYNOR_TILE = { ...DRAYNOR_BANK, level: 0 };
    const enchantGloryArgs = (n: number) => bankJobArg({ family: 'magic', recipe: 'enchant:strung_dragonstone_amulet', target: n, batch: Math.min(24, n), cap: 1500, returnTicks: 300, members: true, reserve: 0, bank: DRAYNOR_TILE, site: DRAYNOR_TILE });
    const enchantGlory: Template = {
        id: 'squad-enchant-glory', family: 'aio-skiller:bank-job', script: 'scripts/aio-skiller.ts',
        args: enchantGloryArgs(24), role: 'magic',
        goal: 'enchant banked strung dragonstone amulets into amulets of glory at the Draynor bank', resources: ['squad:magic-enchant'], squadOnly: true, repeats: false,
        needs: { skills: { Magic: 68 }, items: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 } },
        production: { output: 'amulet of glory', outputPerUnit: 1, maximum: 24, inputs: { 'strung dragonstone amulet': 1, 'cosmic rune': 1, 'earth rune': 15, 'water rune': 15 },
            resize: n => ({ args: enchantGloryArgs(n) }) },
        yields: () => [{ item: 'amulet of glory', perTick: 0.25 }],
    };
    return {
        bow: magicShortbow,
        dhideAndChest: [blackDhideSets, blackDhideVambraces, crystalChest, chargeGlory],
        ringsAndGold: [goldBars, cutSapphire, cutEmerald, sapphireRings, emeraldRings, enchantRecoil, enchantDueling],
        dragonstone: [
            cutDragonstone,
            dragonstoneJewellery('squad-dragonstone-ring', 'dragonstone_ring', 'dragonstone ring', 55, 'ring mould'),
            dragonstoneJewellery('squad-dragon-necklace', 'dragonstone_necklace', 'dragon necklace', 72, 'necklace mould'),
            dragonstoneJewellery('squad-dragonstone-amulet', 'unstrung_dragonstone_amulet', 'unstrung dragonstone amulet', 80, 'amulet mould'),
            invMake('squad-string-dragonstone-amulet', 'string-dragonstone-amulet', 'strung dragonstone amulet', 1, { 'unstrung dragonstone amulet': 1, 'ball of wool': 1 }, {}, 0.15,
                'string banked unstrung dragonstone amulets with balls of wool', MAKE_BATCH, { skill: 'Crafting', role: 'crafting' }),
            enchantGlory,
        ],
    };
}
