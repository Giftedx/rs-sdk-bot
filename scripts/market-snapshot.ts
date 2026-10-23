// Live supply costs per hiscore board.
//
// Fetch mode (read-only HTTP GETs, at most 2 requests per second):
//   bun scripts/market-snapshot.ts [--out research/market-YYYY-MM-DD.json]
// It reads item ids from the rev 289 content (pack/obj.pack), the fixed shops (*.inv) and the ground spawns
// (maps/*.jm2) for every candidate supply item, then GETs /api/market/items/<id> and its 30-day history, the
// active-item lists, and the Bank and Equipment hiscore leaders. It writes one JSON file.
//
// Cost mode (offline, reads the JSON):
//   bun scripts/market-snapshot.ts --costs [research/market-YYYY-MM-DD.json]
// It prints, per board and method, the items needed from level 1 to 99 (packages/planner/src/curve.ts) and the
// coins at the GE ask, as Markdown.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { xpForLevel } from '../packages/planner/src/curve';

const ROOT = join(import.meta.dir, '..');
const CONTENT = join(ROOT, 'vendor/rs-sdk/server/content');
const BASE = 'https://rs-sdk-demo.fly.dev';
const RATE = 25; // XP multiplier on the demo server
const TICKS_PER_HOUR = 9000; // 400 ms live tick

// One slot of a recipe: alternatives, each a bundle of {debugname: count}. Pricing takes the cheapest bundle.
type Slot = Record<string, number>[];
type Tier = { level: number; label: string; xp: number; slots: Slot[] }; // xp is base XP per action
type Method = { board: string; name: string; needs?: string; evidence: string; tiers: Tier[] };

const one = (name: string, n = 1): Slot => [{ [name]: n }];
const t = (level: number, label: string, xp: number, ...slots: Slot[]): Tier => ({ level, label, xp, slots });

// Herblore: herb + vial of water, or the unfinished potion, or the grimy herb + vial (cleaning XP not counted).
const HERB: Record<string, [string, string]> = {
    guam: ['guam_leaf', 'unidentified_guam'], marrentill: ['marentill', 'unidentified_marentill'],
    tarromin: ['tarromin', 'unidentified_tarromin'], harralander: ['harralander', 'unidentified_harralander'],
    ranarr: ['ranarr_weed', 'unidentified_ranarr'], toadflax: ['toadflax', 'unidentified_toadflax'],
    irit: ['irit_leaf', 'unidentified_irit'], avantoe: ['avantoe', 'unidentified_avantoe'],
    kwuarm: ['kwuarm', 'unidentified_kwuarm'], snapdragon: ['snapdragon', 'unidentified_snapdragon'],
    cadantine: ['cadantine', 'unidentified_cadantine'], lantadyme: ['lantadyme', 'unidentified_lantadyme'],
    dwarfweed: ['dwarf_weed', 'unidentified_dwarf_weed'], torstol: ['torstol', 'unidentified_torstol']
};
const unf = (h: string): Slot => [{ [`${h}vial`]: 1 }, { [HERB[h]![0]]: 1, vial_water: 1 }, { [HERB[h]![1]]: 1, vial_water: 1 }];
const pot = (level: number, label: string, xp: number, h: string, secondary: string) => t(level, label, xp, unf(h), one(secondary));

const METHODS: Method[] = [
    // Fletching: skill_fletching/configs/{darts/darts.dbrow,arrows/arrows.dbrow,stringing/bows.dbrow,cut_logs/cut_logs.dbrow}
    { board: 'Fletching', name: 'darts (tip + feather)', evidence: 'darts.dbrow, darts.rs2:41-62', tiers: [
        t(1, 'bronze dart', 1.8, one('bronze_dart_tip'), one('feather')), t(22, 'iron dart', 3.8, one('iron_dart_tip'), one('feather')),
        t(37, 'steel dart', 7.5, one('steel_dart_tip'), one('feather')), t(52, 'mithril dart', 11.2, one('mithril_dart_tip'), one('feather')),
        t(67, 'adamant dart', 15, one('adamant_dart_tip'), one('feather')), t(81, 'rune dart', 18.8, one('rune_dart_tip'), one('feather'))] },
    { board: 'Fletching', name: 'arrows (arrowheads + headless arrow)', evidence: 'arrows.dbrow, arrows.rs2:46,70-86', tiers: [
        t(1, 'bronze arrow', 1.3, one('bronze_arrowheads'), one('headless_arrow')), t(15, 'iron arrow', 2.5, one('iron_arrowheads'), one('headless_arrow')),
        t(30, 'steel arrow', 5, one('steel_arrowheads'), one('headless_arrow')), t(45, 'mithril arrow', 7.5, one('mithril_arrowheads'), one('headless_arrow')),
        t(60, 'adamant arrow', 10, one('adamant_arrowheads'), one('headless_arrow')), t(75, 'rune arrow', 12.5, one('rune_arrowheads'), one('headless_arrow'))] },
    { board: 'Fletching', name: 'string longbows (unstrung + bow string)', evidence: 'stringing/bows.dbrow', tiers: [
        t(1, 'headless arrow (shaft + feather)', 1, one('arrow_shaft'), one('feather')),
        t(10, 'longbow', 10, one('unstrung_longbow'), one('bow_string')), t(25, 'oak longbow', 25, one('unstrung_oak_longbow'), one('bow_string')),
        t(40, 'willow longbow', 41.5, one('unstrung_willow_longbow'), one('bow_string')), t(55, 'maple longbow', 58.2, one('unstrung_maple_longbow'), one('bow_string')),
        t(70, 'yew longbow', 75, one('unstrung_yew_longbow'), one('bow_string')), t(85, 'magic longbow', 91.5, one('unstrung_magic_longbow'), one('bow_string'))] },
    { board: 'Fletching', name: 'cut and string longbows (log + bow string)', evidence: 'cut_logs.dbrow + bows.dbrow; cutting has an animation delay (time not checked)', tiers: [
        t(1, 'headless arrow (shaft + feather)', 1, one('arrow_shaft'), one('feather')),
        t(10, 'longbow', 20, one('logs'), one('bow_string')), t(25, 'oak longbow', 50, one('oak_logs'), one('bow_string')),
        t(40, 'willow longbow', 83, one('willow_logs'), one('bow_string')), t(55, 'maple longbow', 116.5, one('maple_logs'), one('bow_string')),
        t(70, 'yew longbow', 150, one('yew_logs'), one('bow_string')), t(85, 'magic longbow', 183, one('magic_logs'), one('bow_string'))] },
    { board: 'Fletching', name: 'cut and string longbows, yew from 70 (no magic)', evidence: 'cut_logs.dbrow + bows.dbrow', tiers: [
        t(1, 'headless arrow (shaft + feather)', 1, one('arrow_shaft'), one('feather')),
        t(10, 'longbow', 20, one('logs'), one('bow_string')), t(25, 'oak longbow', 50, one('oak_logs'), one('bow_string')),
        t(40, 'willow longbow', 83, one('willow_logs'), one('bow_string')), t(55, 'maple longbow', 116.5, one('maple_logs'), one('bow_string')),
        t(70, 'yew longbow', 150, one('yew_logs'), one('bow_string'))] },
    { board: 'Fletching', name: 'string longbows, yew from 70 (no magic)', evidence: 'stringing/bows.dbrow', tiers: [
        t(1, 'headless arrow (shaft + feather)', 1, one('arrow_shaft'), one('feather')),
        t(10, 'longbow', 10, one('unstrung_longbow'), one('bow_string')), t(25, 'oak longbow', 25, one('unstrung_oak_longbow'), one('bow_string')),
        t(40, 'willow longbow', 41.5, one('unstrung_willow_longbow'), one('bow_string')), t(55, 'maple longbow', 58.2, one('unstrung_maple_longbow'), one('bow_string')),
        t(70, 'yew longbow', 75, one('unstrung_yew_longbow'), one('bow_string'))] },
    // Crafting: skill_crafting/configs/{gem/gem.dbrow,battlestaves/battlestaves.struct,leather/leather.dbrow,glass/glass.struct}
    { board: 'Crafting', name: 'cut gems', evidence: 'gem.dbrow, uncut_gem.rs2:15-63 (opal, jade, red topaz can smash)', tiers: [
        t(1, 'opal', 15, one('uncut_opal')), t(13, 'jade', 20, one('uncut_jade')), t(16, 'red topaz', 25, one('uncut_red_topaz')),
        t(20, 'sapphire', 50, one('uncut_sapphire')), t(27, 'emerald', 67.5, one('uncut_emerald')), t(34, 'ruby', 85, one('uncut_ruby')),
        t(43, 'diamond', 107.5, one('uncut_diamond')), t(55, 'dragonstone', 137.5, one('uncut_dragonstone'))] },
    { board: 'Crafting', name: 'gems to 54, then battlestaves (staff + orb)', evidence: 'battlestaves.struct', tiers: [
        t(1, 'opal', 15, one('uncut_opal')), t(13, 'jade', 20, one('uncut_jade')), t(16, 'red topaz', 25, one('uncut_red_topaz')),
        t(20, 'sapphire', 50, one('uncut_sapphire')), t(27, 'emerald', 67.5, one('uncut_emerald')), t(34, 'ruby', 85, one('uncut_ruby')),
        t(43, 'diamond', 107.5, one('uncut_diamond')),
        t(54, 'water battlestaff', 100, one('battlestaff'), one('water_orb')), t(58, 'earth battlestaff', 112.5, one('battlestaff'), one('earth_orb')),
        t(62, 'fire battlestaff', 125, one('battlestaff'), one('fire_orb')), t(66, 'air battlestaff', 137.5, one('battlestaff'), one('air_orb'))] },
    { board: 'Crafting', name: 'glass to 57, then dragonhide (per leather)', evidence: 'glass.struct, leather.dbrow (vambraces 1 leather; bodies 3 leather, same XP per leather)', tiers: [
        t(1, 'beer glass', 17.5, one('molten_glass')), t(33, 'vial', 35, one('molten_glass')), t(46, 'orb', 52.5, one('molten_glass')),
        t(57, 'green d-hide vamb', 62, one('dragon_leather')), t(66, 'blue d-hide vamb', 70, one('dragon_leather_blue')),
        t(73, 'red d-hide vamb', 78, one('dragon_leather_red')), t(79, 'black d-hide vamb', 86, one('dragon_leather_black'))] },
    { board: 'Crafting', name: 'leather gloves to 10, then spin flax into bow strings', evidence: 'leather.dbrow, spinning.struct (15 XP, level 10); spinning.rs2:87-98 weakqueue 2-3 ticks', tiers: [
        t(1, 'leather gloves', 13.8, one('leather')), t(10, 'bow string (spin flax)', 15, one('flax'))] },
    { board: 'Crafting', name: 'glassblowing only', evidence: 'glass.struct', tiers: [
        t(1, 'beer glass', 17.5, one('molten_glass')), t(33, 'vial', 35, one('molten_glass')), t(46, 'orb', 52.5, one('molten_glass'))] },
    // Herblore: skill_herblore/configs/brewing/brew_potion.struct (unfinished potions give 0 XP)
    { board: 'Herblore', name: 'finish potions (unf or herb + vial, plus secondary)', evidence: 'brew_potion.struct', tiers: [
        pot(1, 'attack potion', 25, 'guam', 'eye_of_newt'), pot(5, 'antipoison', 37.5, 'marrentill', 'unicorn_horn_dust'),
        pot(12, 'strength potion', 50, 'tarromin', 'limpwurt_root'), pot(22, 'restore potion', 62.5, 'harralander', 'red_spiders_eggs'),
        pot(26, 'energy potion', 67.5, 'harralander', 'chocolate_dust'), pot(30, 'defence potion', 75, 'ranarr', 'white_berries'),
        pot(34, 'agility potion', 80, 'toadflax', 'toads_legs'), pot(38, 'prayer potion', 87.5, 'ranarr', 'snape_grass'),
        pot(45, 'super attack', 100, 'irit', 'eye_of_newt'), pot(48, 'superantipoison', 106.3, 'irit', 'unicorn_horn_dust'),
        pot(50, 'fishing potion', 112.5, 'avantoe', 'snape_grass'), pot(52, 'super energy', 117.5, 'avantoe', 'mortmyremushroom'),
        pot(55, 'super strength', 125, 'kwuarm', 'limpwurt_root'), pot(60, 'weapon poison', 137.5, 'kwuarm', 'dragon_scale_dust'),
        pot(63, 'super restore', 142.5, 'snapdragon', 'red_spiders_eggs'), pot(66, 'super defence', 150, 'cadantine', 'white_berries'),
        pot(69, 'antifire', 157.5, 'lantadyme', 'dragon_scale_dust'), pot(72, 'ranging potion', 162.5, 'dwarfweed', 'wine_of_zamorak'),
        pot(76, 'magic potion', 172.5, 'lantadyme', 'cactus_potato'), pot(78, 'zamorak brew', 175, 'torstol', 'jangerberries')] },
    // Firemaking: skill_firemaking/configs/firemaking.obj (productexp in tenths)
    { board: 'Firemaking', name: 'burn logs', evidence: 'firemaking.obj, firemaking.rs2:79-131 (roll every 4 ticks)', tiers: [
        t(1, 'logs', 40, one('logs')), t(15, 'oak', 60, one('oak_logs')), t(30, 'willow', 90, one('willow_logs')),
        t(45, 'maple', 135, one('maple_logs')), t(60, 'yew', 202.5, one('yew_logs')), t(75, 'magic', 303.8, one('magic_logs'))] },
    { board: 'Firemaking', name: 'burn logs, yew from 60 (no magic)', evidence: 'firemaking.obj', tiers: [
        t(1, 'logs', 40, one('logs')), t(15, 'oak', 60, one('oak_logs')), t(30, 'willow', 90, one('willow_logs')),
        t(45, 'maple', 135, one('maple_logs')), t(60, 'yew', 202.5, one('yew_logs'))] },
    // Prayer: skill_prayer/configs/bones.obj (bone_exp in tenths); bury only, no altar or ectofuntus in rev 289
    { board: 'Prayer', name: 'bury big bones (no dragon bones)', evidence: 'bones.obj', tiers: [t(1, 'big bones', 15, one('big_bones'))] },
    { board: 'Prayer', name: 'bury bones', evidence: 'bones.obj, bury_bone.rs2:1-15 (2 ticks per bone)', tiers: [
        t(1, 'bones', 4.5, one('bones')), t(1, 'wolf bones', 4.5, one('wolf_bones')), t(1, 'big bones', 15, one('big_bones')),
        t(1, 'jogre bones', 15, one('tbwt_jogre_bones')), t(1, 'baby dragon bones', 30, one('babydragon_bones')), t(1, 'dragon bones', 72, one('dragon_bones'))] },
    // Smithing: smithing.struct xpperbar, smithing.dbrow levels (dagger = 1 bar), smelting.struct + smelting.rs2:216
    { board: 'Smithing', name: 'smith bars at an anvil (XP per bar)', evidence: 'smithing.struct xpperbar, smithing.rs2:271-301 (5 ticks per item)', tiers: [
        t(1, 'bronze', 12.5, one('bronze_bar')), t(15, 'iron', 25, one('iron_bar')), t(30, 'steel', 37.5, one('steel_bar')),
        t(50, 'mithril', 50, one('mithril_bar')), t(70, 'adamant', 62.5, one('adamantite_bar')), t(85, 'rune', 75, one('runite_bar'))] },
    { board: 'Smithing', name: 'steel bars from 30 to 99', evidence: 'smithing.struct xpperbar', tiers: [
        t(1, 'bronze', 12.5, one('bronze_bar')), t(15, 'iron', 25, one('iron_bar')), t(30, 'steel', 37.5, one('steel_bar'))] },
    { board: 'Smithing', name: 'bronze bars to 40, then gold ore with goldsmith gauntlets', needs: 'Family Crest (gauntlets_of_goldsmithing)', evidence: 'smelting.struct (gold 22.5), smelting.rs2:216 (x2.5), superheat.rs2:57 (also x2.5)', tiers: [
        t(1, 'bronze', 12.5, one('bronze_bar')), t(15, 'iron', 25, one('iron_bar')), t(30, 'steel', 37.5, one('steel_bar')),
        t(40, 'gold ore smelt (gauntlets)', 56.25, one('gold_ore'))] },
    // Magic: skill_magic/configs/magic_spells.dbrow, skill_combat/configs/magic/magic_combat_spells.dbrow
    { board: 'Magic', name: 'teleports with a staff of air', needs: 'staff of air (elemental runes free)', evidence: 'magic_spells.dbrow; wind strike XP excludes damage XP', tiers: [
        t(1, 'wind strike', 5.5, one('mindrune')), t(25, 'Varrock teleport', 35, one('lawrune'), one('firerune')),
        t(31, 'Lumbridge teleport', 41, one('lawrune'), one('earthrune')), t(37, 'Falador teleport', 48, one('lawrune'), one('waterrune')),
        t(45, 'Camelot teleport', 55.5, one('lawrune'))] },
    { board: 'Magic', name: 'teleports to 80, then Charge', needs: 'staff of air; Mage Arena for Charge', evidence: 'charge.rs2:1-26 (no p_delay)', tiers: [
        t(1, 'wind strike', 5.5, one('mindrune')), t(25, 'Varrock teleport', 35, one('lawrune'), one('firerune')),
        t(31, 'Lumbridge teleport', 41, one('lawrune'), one('earthrune')), t(37, 'Falador teleport', 48, one('lawrune'), one('waterrune')),
        t(45, 'Camelot teleport', 55.5, one('lawrune')), t(80, 'Charge', 180, one('bloodrune', 3), one('firerune', 3))] },
    // Cooking: skill_cooking/configs/cooking_source/cooking_generic.dbrow; wine: cooking_inv/scripts/wine/wine.rs2
    { board: 'Cooking', name: 'cook food (no burns counted)', evidence: 'cooking_generic.dbrow', tiers: [
        t(1, 'shrimp', 30, one('raw_shrimp')), t(1, 'chicken', 30, one('raw_chicken')), t(1, 'beef', 30, one('raw_beef')),
        t(1, 'sardine', 40, one('raw_sardine')), t(5, 'herring', 50, one('raw_herring')), t(15, 'trout', 70, one('raw_trout')),
        t(25, 'salmon', 90, one('raw_salmon')), t(30, 'tuna', 100, one('raw_tuna')), t(35, 'pizza', 143, one('uncooked_pizza')),
        t(40, 'lobster', 120, one('raw_lobster')), t(40, 'cake', 180, one('uncooked_cake')), t(43, 'bass', 130, one('raw_bass')),
        t(45, 'swordfish', 140, one('raw_swordfish')), t(60, 'curry', 280, one('uncooked_curry')), t(80, 'shark', 210, one('raw_shark'))] },
    { board: 'Cooking', name: 'fish only (helpers can fish all of it)', evidence: 'cooking_generic.dbrow', tiers: [
        t(1, 'sardine', 40, one('raw_sardine')), t(15, 'trout', 70, one('raw_trout')), t(25, 'salmon', 90, one('raw_salmon')),
        t(30, 'tuna', 100, one('raw_tuna')), t(40, 'lobster', 120, one('raw_lobster')), t(45, 'swordfish', 140, one('raw_swordfish')),
        t(80, 'shark', 210, one('raw_shark'))] },
    { board: 'Cooking', name: 'food to 35, then hand-made wine (bank ferment)', evidence: 'wine.rs2:8-70; research/cooking-board.md', tiers: [
        t(1, 'shrimp', 30, one('raw_shrimp')), t(1, 'sardine', 40, one('raw_sardine')), t(15, 'trout', 70, one('raw_trout')),
        t(25, 'salmon', 90, one('raw_salmon')), t(30, 'tuna', 100, one('raw_tuna')),
        t(35, 'wine', 110, [{ jug_unfermented_wine: 1 }, { grapes: 1, jug_water: 1 }])] },
    // Runecraft: skill_runecraft/configs/runecraft.dbrow (XP per essence)
    { board: 'Runecraft', name: 'free altars only (air to body)', evidence: 'runecraft.dbrow', tiers: [
        t(1, 'air', 5, one('blankrune')), t(2, 'mind', 5.5, one('blankrune')), t(5, 'water', 6, one('blankrune')),
        t(9, 'earth', 6.5, one('blankrune')), t(14, 'fire', 7, one('blankrune')), t(20, 'body', 7.5, one('blankrune'))] },
    { board: 'Runecraft', name: 'craft essence at the highest altar', needs: 'talismans; cosmic needs Lost City; nature, law members', evidence: 'runecraft.dbrow, runecraft.rs2:68-99', tiers: [
        t(1, 'air', 5, one('blankrune')), t(2, 'mind', 5.5, one('blankrune')), t(5, 'water', 6, one('blankrune')),
        t(9, 'earth', 6.5, one('blankrune')), t(14, 'fire', 7, one('blankrune')), t(20, 'body', 7.5, one('blankrune')),
        t(27, 'cosmic', 8, one('blankrune')), t(35, 'chaos', 8.5, one('blankrune')), t(44, 'nature', 9, one('blankrune')),
        t(54, 'law', 9.5, one('blankrune'))] },
    // Ranged: quest_mcannon/scripts/cannon_fire.rs2:117-119, 2 XP per damage; 8 damage per ball is an ESTIMATE
    { board: 'Ranged', name: 'dwarf multicannon (ESTIMATE 8 damage per ball)', needs: 'Dwarf Cannon quest; cannon set', evidence: 'cannon_fire.rs2:117-119', tiers: [
        t(1, 'cannonball', 16, one('mcannonball'))] }
];

// Extra items to snapshot (cannon parts, talismans, raw hides, tools, jugs, related products).
const EXTRA = ['twpart1', 'twpart2', 'twpart3', 'twpart4', 'air_talisman', 'mind_talisman', 'water_talisman',
    'earth_talisman', 'fire_talisman', 'body_talisman', 'cosmic_talisman', 'chaos_talisman', 'nature_talisman', 'law_talisman',
    'dragonhide_green', 'dragonhide_blue', 'dragonhide_red', 'dragonhide_black', 'flax', 'bucket_sand', 'soda_ash', 'staff_of_air',
    'staff_of_fire', 'gauntlets_of_goldsmithing', 'thread', 'coal', 'iron_ore', 'mithril_ore', 'adamantite_ore', 'runite_ore',
    'naturerune', 'cosmicrune', 'chaosrune', 'deathrune', 'airrune', 'bodyrune', 'grapes', 'jug_water', 'tbwt_raw_karambwan',
    'copper_ore', 'tin_ore', 'cow_hide', 'leather'];

// What a helper can make an input from (per one input). Pricing also tries these bundles.
// Sources: smithing.dbrow (15 arrowheads or 10 dart tips per bar; dart tips need Tourist Trap), cannonballs.rs2:38
// (4 per steel bar), arrows.rs2:25-47, smelting.struct and smelting.rs2:200-209 (iron 50% fail without a ring of
// forging), tanner.rs2 + tanner.constant (soft leather 1, dragonhide 20 coins), cut_logs.dbrow, spinning.struct.
const MADE_FROM: Record<string, Record<string, number>[]> = {
    headless_arrow: [{ arrow_shaft: 1, feather: 1 }],
    arrow_shaft: [{ logs: 1 / 15 }],
    leather: [{ cow_hide: 1, coins: 1 }],
    mcannonball: [{ steel_bar: 0.25 }],
    bow_string: [{ flax: 1 }],
    molten_glass: [{ bucket_sand: 1, soda_ash: 1 }],
    dragon_leather: [{ dragonhide_green: 1, coins: 20 }], dragon_leather_blue: [{ dragonhide_blue: 1, coins: 20 }],
    dragon_leather_red: [{ dragonhide_red: 1, coins: 20 }], dragon_leather_black: [{ dragonhide_black: 1, coins: 20 }],
    bronze_bar: [{ copper_ore: 1, tin_ore: 1 }], iron_bar: [{ iron_ore: 2 }], steel_bar: [{ iron_ore: 1, coal: 2 }],
    mithril_bar: [{ mithril_ore: 1, coal: 4 }], adamantite_bar: [{ adamantite_ore: 1, coal: 6 }], runite_bar: [{ runite_ore: 1, coal: 8 }],
    unstrung_longbow: [{ logs: 1 }], unstrung_oak_longbow: [{ oak_logs: 1 }], unstrung_willow_longbow: [{ willow_logs: 1 }],
    unstrung_maple_longbow: [{ maple_logs: 1 }], unstrung_yew_longbow: [{ yew_logs: 1 }], unstrung_magic_longbow: [{ magic_logs: 1 }]
};
for (const m of ['bronze', 'iron', 'steel', 'mithril', 'adamant', 'rune']) {
    const bar = m === 'adamant' ? 'adamantite_bar' : m === 'rune' ? 'runite_bar' : `${m}_bar`;
    MADE_FROM[`${m}_arrowheads`] = [{ [bar]: 1 / 15 }];
    MADE_FROM[`${m}_dart_tip`] = [{ [bar]: 0.1 }];
}
// Expand each single-item bundle with its MADE_FROM recipes, two levels deep (arrowheads -> bar -> ore).
function expand(s: Slot, depth = 2): Slot {
    const out: Slot = [...s];
    for (const b of s) {
        const keys = Object.keys(b);
        if (keys.length !== 1 || !MADE_FROM[keys[0]!]) continue;
        const q = b[keys[0]!]!;
        const made = MADE_FROM[keys[0]!]!.map(r => Object.fromEntries(Object.entries(r).map(([n, c]) => [n, c * q])));
        out.push(...(depth > 1 ? expand(made, depth - 1) : made));
    }
    return out;
}

function objIds(): Map<string, number> {
    const m = new Map<string, number>();
    for (const line of readFileSync(join(CONTENT, 'pack/obj.pack'), 'utf8').split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) m.set(line.slice(i + 1).trim(), Number(line.slice(0, i)));
    }
    return m;
}

function walk(dir: string, ext: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, ext, out);
        else if (e.name.endsWith(ext)) out.push(p);
    }
    return out;
}

type Shop = { inv: string; file: string; count: number; rate: number; sell?: number | null; delta?: number };
// Shop NPC params (owned_shop, shop_sell_multiplier, shop_delta) from *.npc. shop.rs2:139-200 prices one unit at
// cost * max(100, sell - clamp(diff * delta, -5000, 1000)) / 1000, where diff = stock now - normal stock.
function shopParams(): Map<string, { sell: number | null; delta: number }> {
    const out = new Map<string, { sell: number | null; delta: number }>();
    for (const f of walk(join(CONTENT, 'scripts'), '.npc')) {
        for (const block of readFileSync(f, 'utf8').split(/\n(?=\[)/)) {
            const inv = /param=owned_shop,(\w+)/.exec(block)?.[1];
            if (!inv || out.has(inv)) continue;
            const sell = /param=shop_sell_multiplier,(\d+)/.exec(block)?.[1];
            const delta = /param=shop_delta,(\d+)/.exec(block)?.[1];
            out.set(inv, { sell: sell ? Number(sell) : null, delta: delta ? Number(delta) : 10 });
        }
    }
    return out;
}
// Marginal price of the i-th unit bought from a shop at normal stock (sell 1000 assumed when no NPC param is found).
function shopUnit(cost: number, s: Shop, i: number) {
    const v = Math.max(100, (s.sell ?? 1000) - Math.min(1000, Math.max(-5000, -i * (s.delta ?? 10))));
    return Math.max(1, Math.floor((v * cost) / 1000));
}
function shops(names: Set<string>): Record<string, Shop[]> {
    const out: Record<string, Shop[]> = {};
    const params = shopParams();
    for (const f of walk(join(CONTENT, 'scripts'), '.inv')) {
        let inv = '';
        for (const line of readFileSync(f, 'utf8').split('\n')) {
            const h = /^\[(.+)\]/.exec(line);
            if (h) inv = h[1]!;
            const s = /^stock\d+=([a-z0-9_]+),(\d+),(\d+)/.exec(line);
            // skill_guide_* and smithing_* invs are interfaces, not shops; count 0 means the shop only buys.
            if (!s || !names.has(s[1]!) || /^(skill_guide|smithing_)/.test(inv) || Number(s[2]) === 0) continue;
            (out[s[1]!] ??= []).push({ inv, file: f.slice(CONTENT.length + 1).replace(/\\/g, '/'), count: Number(s[2]), rate: Number(s[3]), ...(params.get(inv) ?? { sell: null, delta: 10 }) });
        }
    }
    return out;
}

type Spawn = { x: number; z: number; level: number; count: number };
function spawns(ids: Map<number, string>): Record<string, Spawn[]> {
    const out: Record<string, Spawn[]> = {};
    const dir = join(CONTENT, 'maps');
    for (const f of readdirSync(dir)) {
        const m = /^m(\d+)_(\d+)\.jm2$/.exec(f);
        if (!m) continue;
        const text = readFileSync(join(dir, f), 'utf8');
        const at = text.indexOf('==== OBJ ====');
        if (at < 0) continue;
        for (const line of text.slice(at + 13).split('\n')) {
            if (line.startsWith('====')) break;
            const o = /^(\d+) (\d+) (\d+): (\d+) (\d+)/.exec(line);
            if (!o || !ids.has(Number(o[4]))) continue;
            (out[ids.get(Number(o[4]))!] ??= []).push({ x: Number(m[1]) * 64 + Number(o[2]), z: Number(m[2]) * 64 + Number(o[3]), level: Number(o[1]), count: Number(o[5]) });
        }
    }
    return out;
}

let last = 0;
async function get(path: string): Promise<any> {
    const wait = last + 500 - Date.now(); // at most 2 requests per second
    if (wait > 0) await Bun.sleep(wait);
    last = Date.now();
    const res = await fetch(BASE + path, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) return { error: res.status, body: text.slice(0, 200) };
    return path.startsWith('/api/') ? JSON.parse(text) : text;
}

// Leader rows of the Bank and Equipment boards: name, value title, item titles.
function leaders(html: string, n = 10) {
    const rows: { username: string; value: string; items: string[] }[] = [];
    for (const chunk of html.split('<tr').slice(1)) {
        const u = /\/hiscores\/player\/([^?"]+)\?profile=[^"]*" class="c">/.exec(chunk);
        const titles = [...chunk.matchAll(/title="([^"]+)"/g)].map(x => x[1]!);
        if (!u || titles.length === 0) continue;
        rows.push({ username: decodeURIComponent(u[1]!), value: titles[0]!, items: titles.slice(1) });
        if (rows.length >= n) break;
    }
    return rows;
}

async function fetchMode(out: string) {
    const ids = objIds();
    const names = new Set<string>(EXTRA);
    for (const m of METHODS) for (const tier of m.tiers) for (const slot of tier.slots) for (const alt of expand(slot)) for (const k of Object.keys(alt)) names.add(k);
    names.delete('coins');
    const missing = [...names].filter(n => !ids.has(n));
    for (const n of missing) names.delete(n);
    const byId = new Map([...names].map(n => [ids.get(n)!, n] as [number, string]));
    const shopData = shops(names);
    const spawnData = spawns(byId);
    const items: Record<string, any> = {};
    for (const [id, name] of [...byId].sort((a, b) => a[0] - b[0])) {
        const market = await get(`/api/market/items/${id}`);
        const history = await get(`/api/market/items/${id}/history?interval=86400000`);
        items[name] = { id, debugname: name, market, history: history.history ?? history, shops: shopData[name] ?? [], spawns: spawnData[name] ?? [] };
        console.log(`${name} (${id}): ask ${market.ask ?? '-'} sell ${market.sellQuantity ?? '-'} vol7d ${market.volume ?? '-'}`);
    }
    const lists: Record<string, any> = {};
    for (const sort of ['volume', 'sellRecent']) {
        const rows: any[] = [];
        for (let offset = 0; ; offset += 100) {
            const page = await get(`/api/market/items?sort=${sort}&limit=100&offset=${offset}`);
            rows.push(...(page.items ?? []));
            if (!page.items || offset + 100 >= page.total) { lists[sort] = { total: page.total, summary: page.summary, items: rows }; break; }
        }
    }
    const status = await get('/api/market/status');
    const bank = leaders(await get('/hiscores/bank'));
    const equipment = leaders(await get('/hiscores/outfit'));
    const snap = { takenAt: new Date().toISOString(), source: BASE, note: 'read-only GETs, 2 req/s max; market fields over the default 7-day window', missingNames: missing, status, items, lists, hiscores: { bank, equipment } };
    writeFileSync(out, JSON.stringify(snap, null, 1));
    console.log(`wrote ${out}: ${Object.keys(items).length} items, missing names: ${missing.join(', ') || 'none'}`);
}

// ---------- cost mode ----------
type Price = { each: number | null; source: string };
function price(snap: any, name: string): Price {
    if (name === 'coins') return { each: 1, source: 'coins' };
    const it = snap.items[name];
    if (!it) return { each: null, source: 'not in snapshot' };
    const m = it.market ?? {};
    const opts: Price[] = [];
    if (m.ask !== null && m.ask !== undefined && m.sellQuantity > 0) opts.push({ each: m.ask, source: 'GE ask' });
    if (it.shops.length > 0 && m.basePrice > 0) opts.push({ each: Math.min(...it.shops.map((s: Shop) => shopUnit(m.basePrice, s, 0))), source: 'shop' });
    opts.sort((a, b) => a.each! - b.each!);
    return opts[0] ?? { each: null, source: it.spawns.length ? 'ground spawn only' : 'no seller, no shop' };
}
function bundleCost(snap: any, b: Record<string, number>) {
    let sum = 0;
    for (const [n, q] of Object.entries(b)) { const p = price(snap, n); if (p.each === null) return null; sum += p.each * q; }
    return sum;
}
function slotChoice(snap: any, s: Slot) {
    let best: { bundle: Record<string, number>; cost: number | null } = { bundle: s[0]!, cost: null };
    for (const b of expand(s)) { const c = bundleCost(snap, b); if (c !== null && (best.cost === null || c < best.cost)) best = { bundle: b, cost: c }; }
    return best;
}
function tierCost(snap: any, tier: Tier) {
    const picks = tier.slots.map(s => slotChoice(snap, s));
    const cost = picks.some(p => p.cost === null) ? null : picks.reduce((a, p) => a + p.cost!, 0);
    return { picks, cost };
}

// At each level the method uses its highest-XP tier that is unlocked. Cheaper routes are separate methods.
function plan(snap: any, m: Method) {
    const use = new Map<Tier, { actions: number; from: number; to: number }>();
    for (let L = 1; L < 99; L++) {
        const tier = m.tiers.filter(x => x.level <= L).reduce((a, b) => (b.xp > a.xp ? b : a));
        const u = use.get(tier) ?? { actions: 0, from: L, to: L };
        u.actions += (xpForLevel(L + 1) - xpForLevel(L)) / (tier.xp * RATE);
        u.to = L + 1;
        use.set(tier, u);
    }
    const rows = [...use].map(([tier, u]) => {
        const actions = Math.ceil(u.actions);
        const { picks, cost } = tierCost(snap, tier);
        const inputs = picks.map(p => Object.entries(p.bundle).map(([n, q]) => ({ n, q: q * actions })));
        return { tier, from: u.from, to: u.to, actions, cost, coins: cost === null ? null : cost * actions, inputs: inputs.flat() };
    });
    return rows;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : Math.round(n).toLocaleString('en-US'));
// Cheapest way to get q units now: shop units at their marginal prices (normal stock only, no restock) and GE units
// at the ask. The ask is a lower bound: the API gives only the lowest sell price, and the book average
// (sellValue / sellQuantity, shown in the table) can be much higher. Returns coins, units short, and the split.
function fill(snap: any, n: string, q: number) {
    if (n === 'coins') return { coins: q, short: 0, shop: 0, ge: 0 };
    const it = snap.items[n];
    const m = it?.market ?? {};
    const units: { p: number; src: 'shop' | 'ge' }[] = [];
    const need = Math.ceil(q - 1e-9);
    for (const s of (it?.shops ?? []) as Shop[]) for (let i = 0; i < Math.min(s.count, need); i++) units.push({ p: shopUnit(m.basePrice, s, i), src: 'shop' });
    if (m.sellQuantity > 0) {
        for (let i = 0; i < Math.min(m.sellQuantity, need); i++) units.push({ p: m.ask, src: 'ge' });
    }
    units.sort((a, b) => a.p - b.p);
    const take = units.slice(0, need);
    return { coins: take.reduce((a, u) => a + u.p, 0), short: need - take.length, shop: take.filter(u => u.src === 'shop').length, ge: take.filter(u => u.src === 'ge').length };
}
function itemCell(snap: any, n: string, q: number) {
    const it = snap.items[n];
    const m = it?.market ?? {};
    const f = fill(snap, n, q);
    const perDay = (m.volume ?? 0) / 7;
    const shop = (it?.shops ?? []).map((s: Shop) => `${s.inv} ${s.count} (+${fmt(TICKS_PER_HOUR / s.rate)}/h)`).join('; ');
    const wait = f.short > 0 ? (perDay > 0 ? `${fmt(f.short)}; ${(f.short / perDay).toFixed(1)} d at 7-day trade rate` : `${fmt(f.short)}; no trades in 7 days`) : '';
    return `| ${m.name ?? n} (${n}) | ${fmt(q)} | ${m.ask ?? '-'} | ${m.sellQuantity > 0 ? fmt(m.sellValue / m.sellQuantity) : '-'} | ${fmt(m.sellQuantity)} | ${fmt(m.volume)} | ${fmt(f.coins)} (shop ${fmt(f.shop)}, GE ${fmt(f.ge)}) | ${wait} | ${shop || '-'} | ${it?.spawns?.length ? `${it.spawns.length} spawns` : '-'} |`;
}

function costMode(file: string) {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    const params = shopParams();
    for (const it of Object.values(snap.items) as any[]) for (const s of it.shops) if (s.sell === undefined) Object.assign(s, params.get(s.inv) ?? { sell: null, delta: 10 });
    console.log(`Snapshot ${file} taken ${snap.takenAt}. 99 = ${fmt(xpForLevel(99))} XP, ${RATE}x.\n`);
    for (const m of METHODS) {
        const rows = plan(snap, m);
        const unpriced = rows.filter(r => r.coins === null).map(r => `${r.tier.label} (${fmt(r.actions)})`);
        const need = new Map<string, number>();
        for (const r of rows) for (const i of r.inputs) need.set(i.n, (need.get(i.n) ?? 0) + i.q);
        const fills = [...need].map(([n, q]) => ({ n, q, f: fill(snap, n, q) }));
        const total = fills.reduce((a, x) => a + x.f.coins, 0);
        const short = fills.filter(x => x.f.short > 0).map(x => `${snap.items[x.n]?.market?.name ?? x.n} ${fmt(x.f.short)}`);
        console.log(`### ${m.board}: ${m.name}${m.needs ? ` (needs ${m.needs})` : ''}`);
        console.log(`TOTAL ${fmt(total)} coins for what can be bought now; SHORT: ${short.join(', ') || 'none'}${unpriced.length ? `; NO PRICE for tiers: ${unpriced.join(', ')}` : ''}. Source: ${m.evidence}.\n`);
        console.log('| Tier | Levels | XP each (25x) | Items | Coins each (first unit) |');
        console.log('|---|---|---|---|---|');
        for (const r of rows) console.log(`| ${r.tier.label} | ${r.from}-${r.to} | ${fmt(r.tier.xp * RATE)} | ${fmt(r.actions)} | ${fmt(r.cost)} |`);
        console.log('\n| Item | Need | GE ask | GE book avg | GE sellers | GE 7-day volume | Coins to fill now | Short | Shops (stock, restock) | Ground |');
        console.log('|---|---|---|---|---|---|---|---|---|---|');
        for (const x of fills) console.log(itemCell(snap, x.n, x.q));
        console.log('');
    }
    console.log('### Bank and Equipment leaders (value = obj cost, not GE price)');
    for (const [k, rows] of Object.entries(snap.hiscores)) for (const r of (rows as any[]).slice(0, 3)) console.log(`- ${k}: ${r.username} ${r.value}; ${r.items.slice(0, 6).join('; ')}`);
}

const args = process.argv.slice(2);
if (args[0] === '--costs') costMode(args[1] ?? join(ROOT, `research/market-${new Date().toISOString().slice(0, 10)}.json`));
else {
    const i = args.indexOf('--out');
    await fetchMode(i >= 0 ? args[i + 1]! : join(ROOT, `research/market-${new Date().toISOString().slice(0, 10)}.json`));
}
