// Supply pricing, feed conversion graph, market price caps, job valuation, equipment/tool facts, and specialist staging demand.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BillRow } from '../supply-bill';
import { ammoTier, objId, spellFact, toolLevel, wearLevel } from '../../../core/src/content-facts';
import { cowFoodIds, foodTotalHeal } from '../../../core/src/sustain';
import { ORDER_COIN_MARGIN } from '../../../core/src/order-refusal';
import { SQUAD_POTION_ALIASES } from '../squad';
import { xpForLevel } from '../curve';
import { QUEST_DEMAND_ROWS, norm, type Acct, type GoalNeed, type Inputs, type Needs, type SpecialistStageLine, type Template } from './world';

export const FUND_RESERVE = 50_000;
// An account's stock is offered to another account's kit only from an observation younger than this
// (scripts/autopilot.ts SIDE_STOCK_MAX_AGE_MS equals it; scripts/autopilot.test.ts checks).
export const OBSERVATION_FRESH_MS = 30 * 60_000;
// The template id of a kit buy for a goal band: `kit-buy:<band id>`. A retired pair (two fail RESULTs with no
// progress: no stock under the cap) sends the account to the donors instead.
export const KIT_BUY = 'kit-buy:', KIT_BUY_SCRIPT = 'scripts/buy-owned-ge-item.ts';

// The army's melee weapon. Most army accounts fight with the bronze sword they started with: at Strength 99 it hits 12
// at most, an adamant scimitar 15 or 16 by style (combat.rs2 combat_maxhit: (effective * (64 + strength bonus) + 320) /
// 640, effective 107 to 110, bonus 5 and 28). The trainer wields the best blade the account owns (scripts/gather-combat.ts selectGiantWeapon), so the
// planner only has to put one in the bank: an army account with Attack 30 and no blade of WEAPON_HELD buys one adamant
// scimitar on the Grand Exchange, as a kit buy, at WEAPON_BAND: before its Ranged band, so every account gets one now
// (owner: all of them, until rune blades arrive), WEAPON_BUYERS accounts away for it at a time.
// Progressive weapon, armour, and skilling-tool tiers (rev-289 equipment requirements and shop/GE sources).
export const WEAPON = { id: 'army-weapon', item: 'adamant scimitar', attack: wearLevel('adamant scimitar', 'attack'), goal: 'fight with an adamant scimitar' } as const;
export const WEAPON_HELD = ['adamant scimitar', 'adamant sword', 'adamant longsword', 'rune scimitar', 'rune sword', 'rune longsword', 'dragon longsword', 'dragon dagger'] as const;
export type WeaponStage = { id: string; item: string; fallbacks?: readonly string[]; attack: number; quest?: string; goal: string; held: readonly string[] };
const RUNE_WEAPONS = ['rune scimitar', 'rune longsword', 'rune sword', 'dragon longsword', 'dragon dagger'] as const;
const DRAGON_WEAPONS = ['dragon longsword', 'dragon dagger'] as const;
export const WEAPON_STAGES: readonly WeaponStage[] = [
    { id: 'army-weapon-dragon', item: 'dragon dagger', attack: wearLevel('dragon dagger', 'attack'), quest: 'Lost City', goal: 'fight with a dragon dagger', held: DRAGON_WEAPONS },
    { id: 'army-weapon-rune', item: 'rune scimitar', fallbacks: ['rune longsword'], attack: wearLevel('rune scimitar', 'attack'), goal: 'fight with a rune blade', held: RUNE_WEAPONS },
    { id: WEAPON.id, item: WEAPON.item, attack: WEAPON.attack, goal: WEAPON.goal, held: WEAPON_HELD },
];
export const RUNE_ARMOUR_BAND = 'army-armour-rune';
export const DHIDE_ARMOUR_BAND = 'army-armour-dhide';
// The ids start with `army-weapon-`, so a buy holds the weapon market place (acquire) and may replace a running band.
export const BOW_STAGE = 'army-weapon-bow', AMMO_STAGE = 'army-weapon-ammo';
// The cheap weapons that fill a missing melee weapon line, by the Attack level that wears each (the Varrock sword shop and
// Zeke's scimitars), cheapest first.
export const COW_WEAPONS: readonly (readonly [item: string, attack: number])[] = [['bronze sword', 1], ['iron scimitar', 1], ['steel scimitar', 5], ['mithril scimitar', 20]];

// The levels come from the content (toolLevel); the coins are the price cap of a purchase, which is policy.
const toolLadder = (rows: readonly (readonly [item: string, coins: number])[]): readonly (readonly [level: number, item: string, coins: number])[] =>
    rows.map(([item, coins]) => [toolLevel(item), item, coins] as const);
export const PICKAXE_LADDER = toolLadder([['rune pickaxe', 40_000], ['adamant pickaxe', 5_000], ['mithril pickaxe', 2_500], ['steel pickaxe', 1_000], ['iron pickaxe', 300]]);
export const AXE_LADDER = toolLadder([['rune axe', 25_000], ['adamant axe', 10_000], ['mithril axe', 4_000], ['steel axe', 1_500], ['iron axe', 200]]);
// A pickaxe or an axe over the account's level is no kit: the account cannot use it. The cheapest pickaxe with a
// price cap is adamant (Mining 31), and a kit buy took it for an account with Mining 1.
export const usableTool = (a: Pick<Acct, 'skills'>, item: string): boolean => {
    const pick = PICKAXE_LADDER.find(([, name]) => name === item), axe = AXE_LADDER.find(([, name]) => name === item);
    return (!pick || (a.skills.Mining ?? 1) >= pick[0]) && (!axe || (a.skills.Woodcutting ?? 1) >= axe[0]);
};

// The level of a bow and of an arrow comes from the content (a bow fires arrows of its tier or lower); the order is the planner's.
export const BOWS: readonly (readonly [string, number])[] = ['shortbow', 'longbow', 'oak shortbow', 'oak longbow', 'willow shortbow', 'willow longbow',
    'maple shortbow', 'maple longbow', 'yew shortbow', 'yew longbow', 'magic shortbow', 'magic longbow'].map(bow => [bow, wearLevel(bow, 'ranged')] as const);
// Native bows and their unstrung inputs share display names. Only the strung base ID supplies a combat kit.
const BOW_IDENTITIES: Readonly<Record<string, readonly [strung: number, unstrung: number]>> = Object.fromEntries(BOWS.map(([bow]) => [bow, [objId(bow), objId(`unstrung ${bow}`)] as const]));
export const BOW_IDS: Readonly<Record<string, number>> = Object.fromEntries(Object.entries(BOW_IDENTITIES).map(([name, [id]]) => [name, id]));
export const ARMOUR_IDS: Readonly<Record<string, number>> = { 'dragonhide body': objId('dragonhide body'), 'dragonhide chap': objId('dragonhide chaps'), 'dragon vambrace': objId('dragon vambraces') };
export const bowStockNames = new Map(Object.entries(BOW_IDENTITIES).flatMap(([name, [strung, unstrung]]) => [[strung, name], [unstrung, `unstrung ${name}`]] as [number, string][]));
export const ARROWS: readonly (readonly [string, number])[] = ['bronze arrow', 'iron arrow', 'steel arrow', 'mithril arrow', 'adamant arrow', 'rune arrow'].map(arrow => [arrow, ammoTier(arrow)] as const);
// A staff that stands for the fire runes of a cast.
export const FIRE_STAFFS = ['staff of fire', 'fire battlestaff', 'mystic fire staff'] as const;
// Kit items a goal-tier shop job brings (the alchemy supply jobs and the army-arrows jobs). A kit line of these that no market sells
// does not hold back the market buy of the band's other lines: the shop job follows once those are held.
export const SHOP_SUPPLIED: ReadonlySet<string> = new Set(['fire rune', ...FIRE_STAFFS, 'feather', 'water rune', 'body rune', 'dusty key', 'bronze arrow', 'iron arrow', 'steel arrow', 'mithril arrow']);
// ARROW_LOW: the arrows of one kind the Ranged band needs to start. ARROW_STOCK: what a shop run brings the account up to.
export const ARROW_LOW = 100, ARROW_STOCK = 500, LOWE_STOCK = 1000;
// ARROW_LOW rune arrows off the full shelf of the Ranging Guild shop: the base cost of 400 coins, and 1% of it more
// for each arrow bought before (59,800 coins). The buy script reserves six times the base cost for each unit it
// asks for (scripts/shop-buyer.ts maximumUnitCost), so the spend limit adds that for the last arrow.
export const RUNE_ARROW_COST = 59_800, RUNE_ARROW_SPEND = RUNE_ARROW_COST + 2_400;
// A bow the account's Ranged level wields, with ARROW_LOW arrows of one kind that bow fires.
export const RANGED_KIT: readonly Needs[] = BOWS.flatMap(([bow, level]) =>
    ARROWS.filter(([, arrowLevel]) => arrowLevel <= level).map(([arrow]) => ({ skills: { Ranged: level }, items: { [bow]: 1, [arrow]: ARROW_LOW } })));

// Thieving success at a knight of Ardougne (pickpocket.dbrow: 50..240 of 256 from level 1 to 99), scaled from the
// goldfarm model of 18.8 coins per tick at 99 (scripts/goldfarm.ts header). Estimate.
export const knightCoinsPerTick = (thieving: number) => thieving < 55 ? 0 : 18.8 * (50 + 190 * (Math.min(99, thieving) - 1) / 98) / 240;

export const SPLASH_TO = 66;
export const SPLASH_KIT = { 'body rune': 150, 'earth rune': 425, 'water rune': 300 } as const;
export const SPLASH_START = { 'body rune': 10, 'earth rune': 30, 'water rune': 30 } as const, CURSE_LEVEL = spellFact('curse').level, CURSE_XP = spellFact('curse').xp;
export function splashKit(magic: number): Record<string, number> {
    const casts = Math.max(SPLASH_START['body rune'], Math.ceil((xpForLevel(SPLASH_TO) - xpForLevel(magic)) / CURSE_XP));
    return magic < CURSE_LEVEL ? { ...SPLASH_KIT } : { 'body rune': casts, 'earth rune': 3 * casts, 'water rune': Math.max(SPLASH_START['water rune'], 2 * casts) };
}

// The coins a kit buy leaves in the bank (the buy script's CASH_RESERVE). A kit costs far less than FUND_RESERVE, which
// guards a coin donor, so a buyer keeps only this.
export const KIT_CASH_RESERVE = 1_000;
// Coins the plan leaves above the reserve when it sizes a kit buy (see acquire): the observed coins are minutes old when the buy runs.
export const KIT_COIN_MARGIN = ORDER_COIN_MARGIN;
// Unit price caps for kit buys, in coins. Estimates: the owner's hand jobs cap a law rune at 1,600 (shop value 40) and
// a shark at 810 to 1,200 (shop value 300), so a rune caps at about 40 times and food at about 4 times its shop value.
// An offer fills at or under its cap, and scripts/buy-owned-ge-item.ts refunds what does not fill. Gap: no measured
// Grand Exchange price for these items.
export const KIT_PRICE_CAPS: Readonly<Record<string, number>> = {
    'mind rune': 120, 'air rune': 160, 'fire rune': 160, 'nature rune': 800, feather: 20,
    // Live claude-cloud read: body runes 1,460 listed from 184 (bids at 38), earth runes 27,408 from 92 (bids at 39).
    'body rune': 200, 'earth rune': 110,
    // Water runes: 310 listed from 78 in the same read, and Aubury's shelf read 0 on three visits, so the kit buy
    // takes what the market lists and the shop job (army-water-aubury) is the way when a buy gets none.
    'water rune': 110,
    'bronze arrow': 20, 'iron arrow': 40, 'steel arrow': 100, 'mithril arrow': 200, 'adamant arrow': 400, 'rune arrow': 1200,
    trout: 100, lobster: 500, swordfish: 700, shark: 1200,
    // Live claude-cloud read: 42 listed at 72,000, bids at 33,068, volume-weighted price 38,089.
    'adamant scimitar': 80_000,
    'rune scimitar': 50_000, 'rune longsword': 45_000, 'dragon dagger': 50_000, 'dragon longsword': 120_000,
    shortbow: 500, 'oak shortbow': 800, 'willow shortbow': 2_500, 'maple shortbow': 5_000, 'yew shortbow': 15_000,
    coif: 1_000, 'studded body': 2_500, 'studded chap': 2_000,
    'dragonhide body': 15_000, 'dragonhide chap': 8_000, 'dragon vambrace': 6_000,
    'adamant full helm': 8_000, 'adamant plateleg': 15_000, 'adamant platebody': 25_000,
    'rune full helm': 45_000, 'rune kiteshield': 65_000, 'rune plateleg': 75_000, 'rune plateskirt': 75_000, 'rune chainbody': 60_000, 'rune platebody': 80_000,
    // Lumber & mining skilling tools (Bob's Axes in Lumbridge lacks mithril+ axes and has no shop profile).
    'steel axe': 1_500, 'mithril axe': 4_000, 'adamant axe': 10_000, 'rune axe': 25_000,
    'adamant pickaxe': 6_000, 'rune pickaxe': 40_000,
    // The hunters' kit (army-hunt-black-dragons). Live claude-cloud: 5 law runes for 5,260 coins and 7 sharks for 7,189;
    // magic shortbows 108 listed from 51,000.
    'law rune': 1_600, 'magic shortbow': 60_000,
    // The Zanaris market door's tax (army-jakut-swords). Live claude-cloud read: 1,219 listed from 145,000.
    diamond: 150_000,
    // Live claude-cloud read: dragon bones 1,009 listed from 9,000 (mean 9,687); big bones 1,686 from 2,399 (mean 2,526).
    'dragon bone': 10_000, 'big bone': 2_600,
    // The two prayer potions of Lost City for a Defence 1 build (LOST_CITY_BUILD). No shop sells them and the bank
    // snapshots of the sides hold none. Live read: 38 listed from 250,000, bids at 25,000.
    'prayer potion(4)': 260_000,
    // The coal of Regicide's still (REGICIDE_PACK). Live read: 17,157 listed from 499, bids at 104, volume-weighted
    // price 586.
    coal: 600,
};

// Only a finite consumer gives an output value. Shop prices compare needed supplies; an unpriced needed item keeps
// a value of one so missing price data cannot turn a route requirement into surplus.
export const BILL_PREMIUM = 2, TRAIN_SHARE = 0.25;
// scripts/autopilot.ts plans every ten minutes: 1,000 game ticks at 600 ms per tick. This is an output estimate,
// not a claim that a worker stops at this bound; the next pass reads its actual holdings.
export const VALUE_TICKS = 1000;
// A production pilot that the `aio` list does not name ranks at this share of its worth (Inputs.pilotFallback).
export const PILOT_FALLBACK_SHARE = 0.05;
// A pilot that makes or gathers a bill item for the route or the army kit and needs no quest, band or combat: the AIO skiller
// routes (mining, woodcutting, smelting, smithing, fletching, crafting, runecraft, cooking, fishing) and the maker chains.
export const selfServePilot = (t: Template): boolean => !!t.pilot && !t.tier && !t.quest && !t.once && !t.buildOnly && !t.trains && !t.provides
    && (!!t.production || !!t.aio?.startsWith('skiller:'));
// Inputs that feed a bill line: a feather is needed while headless arrows are short, even with the feather line met.
// A steel bar is on no line of the bill: it is needed while cannonballs are short (one bar casts 4, cannonballs.rs2).
export const FEEDS: Record<string, string[]> = {
    feather: ['headless arrow', 'rune arrow', 'rune arrow(p)'],
    'arrow shaft': ['headless arrow', 'rune arrow', 'rune arrow(p)'],
    'raw lobster': ['lobster'],
    'raw karambwanji': ['raw karambwan', 'cooked karambwan'],
    'raw karambwan': ['cooked karambwan'],
    cake: ['chocolate cake'],
    'chocolate bar': ['chocolate cake', 'chocolate dust'],
    log: ['arrow shaft', 'headless arrow', 'rune arrow', 'rune arrow(p)'],
    logs: ['arrow shaft', 'headless arrow', 'rune arrow', 'rune arrow(p)'],
    flax: ['bow string'],
    'magic log': ['magic shortbow', 'unstrung magic shortbow'],
    'bow string': ['magic shortbow', 'yew shortbow'],
    'unstrung magic shortbow': ['magic shortbow'],
    'rune essence': ['air rune', 'water rune', 'earth rune', 'fire rune', 'cosmic rune'],
    'steel bar': ['cannonball', 'nail'],
    'gold ore': ['gold bar'],
    'gold bar': ['sapphire ring', 'ring of recoil', 'emerald ring', 'ring of dueling(8)', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'uncut sapphire': ['sapphire', 'sapphire ring', 'ring of recoil'],
    sapphire: ['sapphire ring', 'ring of recoil'],
    'sapphire ring': ['ring of recoil'],
    'uncut emerald': ['emerald', 'emerald ring', 'ring of dueling(8)'],
    emerald: ['emerald ring', 'ring of dueling(8)'],
    'emerald ring': ['ring of dueling(8)'],
    'uncut dragonstone': ['dragonstone', 'dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    dragonstone: ['dragonstone ring', 'dragon necklace', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'dragonstone ring': ['ring of wealth'],
    'unstrung dragonstone amulet': ['strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'strung dragonstone amulet': ['amulet of glory', 'amulet of glory(4)'],
    'amulet of glory': ['amulet of glory(4)'],
    'amulet of glory(1)': ['amulet of glory(4)'],
    'amulet of glory(2)': ['amulet of glory(4)'],
    'amulet of glory(3)': ['amulet of glory(4)'],
    'ball of wool': ['strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'cosmic rune': ['ring of recoil', 'ring of dueling(8)', 'amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'air rune': ['ring of dueling(8)'],
    'earth rune': ['amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'water rune': ['amulet of glory', 'amulet of glory(4)', 'ring of wealth'],
    'runite bar': ['rune arrowtips', 'rune arrow', 'rune arrow(p)', 'rune full helm', 'rune platebody', 'rune plateleg', 'rune kiteshield'],
    'runite ore': ['runite bar'],
    coal: ['runite bar'],
    'rune arrowtip': ['rune arrow', 'rune arrow(p)'],
    'rune arrowtips': ['rune arrow', 'rune arrow(p)'],
    'headless arrow': ['rune arrow', 'rune arrow(p)'],
    'rune arrow': ['rune arrow(p)'],
    dragonhide_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    dragon_leather_black: ['black_dragonhide_body', 'black_dragonhide_chaps', 'black_dragon_vambraces'],
    'dragon dagger': ['dragon dagger(p)'],
    'weapon poison': ['dragon dagger(p)', 'rune arrow(p)'],
    'crystal key': ['uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    keyhalf1: ['crystal key', 'uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    keyhalf2: ['crystal key', 'uncut dragonstone', 'dragonstone', 'unstrung dragonstone amulet', 'strung dragonstone amulet', 'amulet of glory', 'amulet of glory(4)'],
    'vial of water': [
        'guam potion (unf)', 'tarromin potion (unf)', 'harralander potion (unf)', 'ranarr potion (unf)', 'toadflax potion (unf)',
        'irit potion (unf)', 'avantoe potion (unf)', 'kwuarm potion (unf)', 'snapdragon potion (unf)', 'cadantine potion (unf)',
        'lantadyme potion (unf)', 'dwarf weed potion (unf)', 'torstol potion (unf)', 'marrentill potion (unf)',
        'prayer potion(3)', 'prayer potion(4)', 'super attack(3)', 'super attack(4)', 'super strength(3)', 'super strength(4)',
        'super defence(3)', 'super defence(4)', 'ranging potion(3)', 'ranging potion(4)',
        'super energy(3)', 'super energy(4)', 'agility potion(3)', 'agility potion(4)',
        'super restore(3)', 'super restore(4)', 'magic potion(3)', 'magic potion(4)', 'zamorak potion(3)', 'zamorak potion(4)',
        'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)', 'weapon poison',
    ],
    'harralander': ['harralander potion (unf)'],
    'unidentified harralander': ['harralander', 'harralander potion (unf)'],
    'lantadyme': ['lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'unidentified lantadyme': ['lantadyme', 'lantadyme potion (unf)', 'magic potion(3)', 'magic potion(4)'],
    'lantadyme potion (unf)': ['magic potion(3)', 'magic potion(4)'],
    'potato cactu': ['magic potion(3)', 'magic potion(4)'],
    'magic potion(3)': ['magic potion(4)'],
    'torstol': ['torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'unidentified torstol': ['torstol', 'torstol potion (unf)', 'zamorak potion(3)', 'zamorak potion(4)'],
    'torstol potion (unf)': ['zamorak potion(3)', 'zamorak potion(4)'],
    jangerberrie: ['zamorak potion(3)', 'zamorak potion(4)'],
    'zamorak potion(3)': ['zamorak potion(4)'],
    'snapdragon': ['snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'unidentified snapdragon': ['snapdragon', 'snapdragon potion (unf)', 'super restore(3)', 'super restore(4)'],
    'snapdragon potion (unf)': ['super restore(3)', 'super restore(4)'],
    "red spiders' egg": ['super restore(3)', 'super restore(4)'],
    'super restore(3)': ['super restore(4)'],
    'ranarr weed': ['ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'unidentified ranarr': ['ranarr weed', 'ranarr potion (unf)', 'prayer potion(3)', 'prayer potion(4)'],
    'ranarr potion (unf)': ['prayer potion(3)', 'prayer potion(4)'],
    'snape grass': ['prayer potion(3)', 'prayer potion(4)'],
    'prayer potion(3)': ['prayer potion(4)'],
    'toadflax': ['toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'unidentified toadflax': ['toadflax', 'toadflax potion (unf)', 'agility potion(3)', 'agility potion(4)'],
    'toadflax potion (unf)': ['agility potion(3)', 'agility potion(4)'],
    'swamp toad': ["toad's leg", 'agility potion(3)', 'agility potion(4)'],
    "toad's leg": ['agility potion(3)', 'agility potion(4)'],
    'agility potion(3)': ['agility potion(4)'],
    avantoe: ['avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'unidentified avantoe': ['avantoe', 'avantoe potion (unf)', 'super energy(3)', 'super energy(4)'],
    'avantoe potion (unf)': ['super energy(3)', 'super energy(4)'],
    'mort myre fungi': ['super energy(3)', 'super energy(4)'],
    'super energy(3)': ['super energy(4)'],
    'irit leaf': ['irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'unidentified irit': ['irit leaf', 'irit potion (unf)', 'super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'irit potion (unf)': ['super attack(3)', 'super attack(4)', 'superantipoison(3)', 'superantipoison(4)'],
    'eye of newt': ['super attack(3)', 'super attack(4)'],
    'super attack(3)': ['super attack(4)'],
    kwuarm: ['kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'unidentified kwuarm': ['kwuarm', 'kwuarm potion (unf)', 'super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'kwuarm potion (unf)': ['super strength(3)', 'super strength(4)', 'weapon poison', 'rune arrow(p)'],
    'limpwurt root': ['super strength(3)', 'super strength(4)'],
    'super strength(3)': ['super strength(4)'],
    cadantine: ['cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'unidentified cadantine': ['cadantine', 'cadantine potion (unf)', 'super defence(3)', 'super defence(4)'],
    'cadantine potion (unf)': ['super defence(3)', 'super defence(4)'],
    'white berrie': ['super defence(3)', 'super defence(4)'],
    'super defence(3)': ['super defence(4)'],
    'dwarf weed': ['dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'unidentified dwarf weed': ['dwarf weed', 'dwarf weed potion (unf)', 'ranging potion(3)', 'ranging potion(4)'],
    'dwarf weed potion (unf)': ['ranging potion(3)', 'ranging potion(4)'],
    'wine of zamorak': ['ranging potion(3)', 'ranging potion(4)'],
    'ranging potion(3)': ['ranging potion(4)'],
    marrentill: ['marrentill potion (unf)', 'antipoison(3)'],
    'unidentified marentill': ['marrentill', 'marrentill potion (unf)', 'antipoison(3)'],
    'marrentill potion (unf)': ['antipoison(3)'],
    'unicorn horn': ['unicorn horn dust', 'antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'unicorn horn dust': ['antipoison(3)', 'superantipoison(3)', 'superantipoison(4)'],
    'superantipoison(3)': ['superantipoison(4)'],
    'blue dragon scale': ['dragon scale dust', 'weapon poison', 'rune arrow(p)'],
    'dragon scale dust': ['weapon poison', 'rune arrow(p)'],
};
const POTION_FEED_FOUR = new Set([
    'prayer potion(4)', 'super attack(4)', 'super strength(4)', 'super defence(4)',
    'ranging potion(4)', 'super energy(4)', 'agility potion(4)', 'superantipoison(4)',
    'super restore(4)', 'magic potion(4)', 'zamorak potion(4)', 'restore potion(4)',
]);
export const feedUnits = (item: string, output: string) => {
    if (!(FEEDS[item] ?? []).includes(output)) return 0;
    if (item === 'log' || item === 'logs') return 1 / 15;
    if (item === 'raw karambwanji') return 3;
    if (item === 'steel bar') return output === 'nail' ? 0.5 : 1 / 4;
    if (item === 'air rune' && output === 'ring of dueling(8)') return 3;
    if ((item === 'earth rune' || item === 'water rune') && (output === 'amulet of glory' || output === 'amulet of glory(4)' || output === 'ring of wealth')) return 15;
    if ((item === 'weapon poison' || item === 'dragon scale dust' || item === 'blue dragon scale' || item === 'kwuarm' || item === 'unidentified kwuarm' || item === 'kwuarm potion (unf)') && output === 'rune arrow(p)') return 1 / 5;
    if (item === 'runite bar') return output === 'rune arrowtips' || output === 'rune arrow' || output === 'rune arrow(p)' ? 1 / 15 : output === 'rune platebody' ? 5 : output === 'rune full helm' ? 2 : output === 'rune plateleg' || output === 'rune kiteshield' ? 3 : 1;
    if (item === 'coal') return 8;
    if (item === 'dragonhide_black' || item === 'dragon_leather_black') return output === 'black_dragonhide_body' ? 3 : output === 'black_dragonhide_chaps' ? 2 : 1;
    if (POTION_FEED_FOUR.has(output)) return 4 / 3;
    return 1;
};

type KnowledgeItemRow = { id: number; name: string; debugname?: string; cost: number; tradeable?: boolean };
const itemsJson = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../../knowledge/items.json'), 'utf8')) as KnowledgeItemRow[];
// HP one held item heals over all its bites, by item name. The content gives it (consume_normal.dbrow heal of each
// bite, cooking_inv next_obj_stage for the bites), for the cow farm's food of core/sustain.ts cowFoodIds.
const itemNames = new Map(itemsJson.map(i => [i.id, i.name]));
export const FOOD_HEAL: Readonly<Record<string, number>> = Object.fromEntries(cowFoodIds().map(id => [norm(itemNames.get(id)!), foodTotalHeal(id)!]));
export const foodHeal = (a: Acct) => Object.entries(FOOD_HEAL).reduce((n, [item, hp]) => n + (a.items[item] ?? 0) * hp, 0);

// The price caps of the quest packs' items that the Grand Exchange can sell and KIT_PRICE_CAPS does not list: four times the item's base
// value (knowledge/items.json `cost`), at least QUEST_CAP_MIN coins. The cap bounds each buy; the market read (packages/planner kitMarket,
// scripts/autopilot.ts) drops an item whose lowest ask is over it. Added to KIT_PRICE_CAPS once, here, after the table that names the items.
export const QUEST_CAP_FACTOR = 4, QUEST_CAP_MIN = 25;
export function questKitCaps(rows: readonly { items: Readonly<Record<string, number>> }[] = QUEST_DEMAND_ROWS): Record<string, number> {
    const content = new Map(itemsJson.filter(i => !/^cert_/.test(i.debugname ?? '')).map(i => [norm(i.name), i] as const).reverse());
    const out: Record<string, number> = {};
    for (const row of rows) for (const item of Object.keys(row.items)) {
        const found = content.get(norm(item));
        if (found?.tradeable && found.cost > 0 && !(norm(item) in KIT_PRICE_CAPS) && coinItem(norm(item)) === false) out[norm(item)] = Math.max(QUEST_CAP_MIN, QUEST_CAP_FACTOR * found.cost);
    }
    return out;
}
const coinItem = (item: string) => item === 'coin';
for (const [item, cap] of Object.entries(questKitCaps())) (KIT_PRICE_CAPS as Record<string, number>)[item] ??= cap;

export const billUnits = (item: string, bill: readonly BillRow[]) => bill.reduce((n, r) => {
    const names = [r.item, ...(r.aliases ?? [])].map(norm);
    return n + Math.max(0, r.short) * (names.includes(item) ? 1 : Math.max(0, ...names.map(name => feedUnits(item, name))));
}, 0);
export function unitValue(item: string, bill: readonly BillRow[], prices: Readonly<Record<string, number>>, coin = 1): number {
    const k = norm(item);
    if (billUnits(k, bill) <= 0) return 0;
    return k === 'coin' ? coin : Math.max(1, prices[k] ?? 0) * BILL_PREMIUM;
}
// The shop values that unitValue reads, by norm() name: the cost of the first item with each name. A bill line whose
// name is no item's name takes the highest cost of the item ids of the line (supply-bill.ts idsFor): every unfinished
// potion is the item "Unfinished potion", and the line "mort myre fungus" is the item "Mort myre fungi". Without the
// entry a maker of such a line has no value.
const PRICE_EXACT_ALIAS_IDS: readonly (readonly [number, string])[] = [
    [1747, 'dragonhide_black'],
    [2509, 'dragon_leather_black'],
    [2503, 'black_dragonhide_body'],
    [2497, 'black_dragonhide_chaps'],
    [2491, 'black_dragon_vambraces'],
    [985, 'keyhalf1'],
    [987, 'keyhalf2'],
    [1683, 'unstrung dragonstone amulet'],
    [1702, 'strung dragonstone amulet'],
];
export function priceTable(items: readonly { id: number; name?: string; debugname?: string; cost?: number }[], bill: readonly BillRow[]): Record<string, number> {
    const prices: Record<string, number> = {}, cost = new Map(items.map(i => [i.id, i.cost ?? 0]));
    for (const i of items) if (typeof i.name === 'string' && !/^cert_/.test(i.debugname ?? '') && !(norm(i.name) in prices)) prices[norm(i.name)] = i.cost ?? 0;
    for (const [id, alias] of PRICE_EXACT_ALIAS_IDS) if (cost.has(id)) {
        const c = cost.get(id)!;
        if (!(alias in prices)) prices[alias] = c;
        if (!(norm(alias) in prices)) prices[norm(alias)] = c;
    }
    for (const r of bill) for (const name of [r.item, ...(r.aliases ?? [])])
        if (r.ids.length && !(norm(name) in prices)) prices[norm(name)] = Math.max(...r.ids.map(id => cost.get(id) ?? 0));
    if ('crystal key' in prices) prices['crystal key'] = Math.max(prices['crystal key']!, 500);
    if ('keyhalf1' in prices) prices.keyhalf1 = Math.max(prices.keyhalf1!, 250);
    if ('keyhalf2' in prices) prices.keyhalf2 = Math.max(prices.keyhalf2!, 250);
    return prices;
}

export function jobValue(t: Template, a: Acct, inp: Pick<Inputs, 'bill' | 'prices' | 'waste' | 'coinValue'>,
    needed: (item: string) => number = item => billUnits(norm(item), inp.bill)): number {
    const coin = inp.coinValue ?? 1;
    const flows = t.yields(a).filter(f => f.perTick > 0);
    const work = Math.min(VALUE_TICKS, Math.max(0, ...flows.map(f => needed(norm(f.item)) / f.perTick)));
    const gross = flows.reduce((v, f) => v + Math.min(f.perTick * work, needed(norm(f.item))) * unitValue(f.item, inp.bill, inp.prices, coin), 0) / VALUE_TICKS;
    const cost = (t.spends?.(a) ?? []).reduce((v, f) => v + f.perTick * (norm(f.item) === 'coin' ? coin : (inp.prices[norm(f.item)] ?? 0)), 0);
    return (gross - cost * work / VALUE_TICKS) * Math.max(0.1, 1 - (inp.waste?.[t.family] ?? 0));
}

export const SQUAD_RUN_MAX: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'water rune': 1500, 'earth rune': 1500, 'air rune': 1500, 'fire rune': 1500,
    'nature rune': 1000, 'law rune': 200, 'blood rune': 200, 'death rune': 500, 'chaos rune': 1000, 'mind rune': 1000,
    'antipoison(3)': 12, 'cooked karambwan': 50, 'raw karambwan': 108, 'climbing boot': 10, 'dragon dagger': 2,
    'cape of legend': 2, 'shield right half': 1, 'dragon battleaxe': 2, 'dragon mace': 2,
    'berserker helm': 2, 'rune platebody': 2, 'rune plateleg': 4, 'black full helm': 2, 'black platebody': 2, 'black plateleg': 2,
    'uncut sapphire': 28, 'uncut emerald': 28, 'eye of newt': 100, 'vial of water': 100,
    'waterskin(4)': 8, 'bronze bar': 20, 'chocolate bar': 28, cake: 28, 'priest gown': 4, 'leather glove': 4,
    'fishing bait': 500, papyrus: 20, 'ball of wool': 20, charcoal: 20,
};
// The shop cost of one unit (knowledge/items.json), the fallback of a run's spend cap: the rows are priced from the plan's
// price table (`prices`, from priceTable) when it holds the item.
export const SQUAD_UNIT_COST: Readonly<Record<string, number>> = {
    'rune arrow': 400, 'rune arrow(p)': 420, 'rune arrowtips': 200, shark: 300, 'cooked karambwan': 320, 'raw karambwan': 240, 'karambwan vessel': 5,
    'water rune': 4, 'earth rune': 4, 'air rune': 4, 'fire rune': 4, 'nature rune': 20, 'law rune': 40,
    'cosmic rune': 50, 'blood rune': 550, 'death rune': 180, 'chaos rune': 90, 'mind rune': 4,
    'antipoison(3)': 288, 'prayer potion(3)': 500, 'prayer potion(4)': 667,
    'super attack(3)': 400, 'super attack(4)': 533, 'super strength(3)': 500, 'super strength(4)': 667,
    'super defence(3)': 600, 'super defence(4)': 800, 'ranging potion(3)': 650, 'ranging potion(4)': 867,
    'super restore(3)': 240, 'super restore(4)': 320, 'magic potion(3)': 250, 'magic potion(4)': 333,
    'zamorak potion(3)': 25, 'zamorak potion(4)': 33, 'restore potion(3)': 80, 'restore potion(4)': 107,
    'superantipoison(3)': 400, 'superantipoison(4)': 533,
    'super energy(3)': 230, 'super energy(4)': 300, 'agility potion(3)': 150, 'agility potion(4)': 200,
    'ring of recoil': 300, 'emerald ring': 1275, 'ring of dueling(8)': 1275,
    'dragonstone': 10_000, 'uncut dragonstone': 10_000, 'dragonstone ring': 17_625, 'dragon necklace': 18_375,
    'unstrung dragonstone amulet': 17_625, 'strung dragonstone amulet': 17_625, 'amulet of glory': 17_625, 'amulet of glory(4)': 25_000, 'ring of wealth': 17_625,
    'climbing boot': 12, 'cape of legend': 675, 'dragon dagger': 30_000, 'dragon dagger(p)': 32_000,
    'dragon battleaxe': 200_000, 'dragon mace': 50_000, 'shield right half': 750_000, 'crystal key': 500, keyhalf1: 250, keyhalf2: 250,
    'dragon chainbody': 250_000, 'dragon sq shield': 1_250_000, 'dragon plateleg': 270_000,
    'magic shortbow': 1600, 'berserker helm': 78_000, 'rune full helm': 35_200, 'rune platebody': 84_500, 'rune plateleg': 64_000, 'rune kiteshield': 54_400,
    'black full helm': 1056, 'black platebody': 3840, 'black plateleg': 1920,
    black_dragonhide_body: 13_480, black_dragonhide_chaps: 6_500, black_dragon_vambraces: 4_200,
    'uncut sapphire': 25, 'uncut emerald': 500, emerald: 500, 'eye of newt': 3, 'vial of water': 2,
    'waterskin(4)': 30, 'bronze bar': 16, nail: 3, plank: 1, 'swamp toad': 2, "toad's leg": 2,
    'chocolate bar': 10, 'chocolate dust': 2, cake: 50, 'chocolate cake': 70,
    'priest gown': 5, 'leather glove': 6, 'fishing bait': 3, papyrus: 10, 'ball of wool': 2, charcoal: 45,
};

// Route shortages and the missing kits of eligible army bands are the consumers. Army purchase budgets retain
// their recipient, so wealth that account cannot spend or receive cannot hide its funding gap.
const specPot = (k: string): readonly string[] => SQUAD_POTION_ALIASES[k]?.map(([n]) => norm(n)) ?? [norm(k)];
const NON_WILDY_ANTIPOISON = specPot('antipoison(3)');
export const SPECIALIST_STAGE_BILLS: Readonly<Record<string, readonly SpecialistStageLine[]>> = {
    hitpoints: [
        { names: ['air rune'], count: 2500 }, { names: ['mind rune'], count: 140 }, { names: ['chaos rune'], count: 220 },
        { names: ['death rune'], count: 220 }, { names: ['law rune'], count: 60 }, { names: ['water rune'], count: 35 },
        { names: ['coin'], count: 5000 }, { names: ['staff of fire'], count: 1 }, { names: ['leather glove'], count: 1 },
        { names: ['cheese'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 }, { names: ['dragon bone'], count: 11 },
        { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 18 }, { names: ['shark'], count: 20 },
        { names: ['gold bar'], count: 1 }, { names: ['ball of wool'], count: 1 }, { names: NON_WILDY_ANTIPOISON, count: 3 },
    ],
    'thieving-live': [
        { names: ['chocolate cake'], count: 27 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    attack: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 50 }, { names: ['air rune'], count: 1300 },
        { names: ['law rune'], count: 30 }, { names: ['chaos rune'], count: 240 }, { names: ['coin'], count: 200 },
        { names: ['dragon bone'], count: 11 }, { names: ['log'], count: 6 }, { names: ['prayer potion(4)'], count: 3 },
        { names: ['lobster'], count: 2 },
    ],
    strength: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    defence: [
        { names: ['air rune'], count: 6 }, { names: ['earth rune'], count: 6 }, { names: ['water rune'], count: 6 },
        { names: ['rune scimitar'], count: 1 }, { names: ['amulet of strength'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
        { names: ['rope'], count: 1 }, { names: ['prayer potion(4)'], count: 2 }, { names: ['shark'], count: 1 },
        { names: ['super energy(4)'], count: 1 }, { names: ['super attack(4)'], count: 1 }, { names: ['super strength(4)'], count: 5 },
        { names: ['dragon bone'], count: 11 },
    ],
    'ranged-live': [
        { names: ['dragon bone'], count: 11 }, { names: ['cannon base'], count: 1 }, { names: ['cannon stand'], count: 1 },
        { names: ['cannon barrel'], count: 1 }, { names: ['cannon furnace'], count: 1 }, { names: ['cannonball'], count: 1500 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['shortbow'], count: 1 }, { names: ['iron arrow'], count: 300 },
        { names: ['leather body'], count: 1 }, { names: ['prayer potion(4)'], count: 8 }, { names: ['lobster'], count: 5 },
        { names: ['magic shortbow'], count: 1 }, { names: ['rune arrow'], count: 1000 },
        { names: ['black_dragonhide_chaps', 'black_dragonhide_chap'], count: 1 },
        { names: ['black_dragon_vambraces', 'black_dragon_vambrace'], count: 1 },
        { names: NON_WILDY_ANTIPOISON, count: 8 },
    ],
    'fletching-live': [
        { names: ['bronze arrowtip'], count: 60 }, { names: ['iron arrowtip'], count: 90 }, { names: ['steel arrowtip'], count: 135 },
        { names: ['mithril arrowtip'], count: 225 }, { names: ['adamant arrowtip'], count: 495 }, { names: ['rune arrowtip'], count: 2595 },
        { names: ['headless arrow'], count: 3600 },
    ],
    fishing: [
        { names: ['small fishing net'], count: 1 }, { names: ['fishing rod'], count: 1 }, { names: ['fly fishing rod'], count: 1 },
        { names: ['fishing bait'], count: 60 }, { names: ['feather'], count: 1500 }, { names: ['knife'], count: 1 },
        { names: ['log'], count: 5 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'mining-live': [
        { names: ['clay'], count: 6 }, { names: ['copper ore'], count: 4 }, { names: ['iron ore'], count: 2 },
        { names: ['knife'], count: 1 }, { names: ['rune pickaxe'], count: 1 }, { names: ['log'], count: 2 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    prayer: [{ names: ['dragon bone'], count: 555 }],
    smithing: [
        { names: ['hammer'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 }, { names: ['bronze bar'], count: 9 },
        { names: ['iron bar'], count: 42 }, { names: ['steel bar'], count: 100 }, { names: ['mithril bar'], count: 275 },
        { names: ['adamantite bar'], count: 375 },
    ],
    runecraft: [
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['air talisman'], count: 1 },
        { names: ['body talisman'], count: 1 }, { names: ['rune essence'], count: 5355 },
    ],
    crafting: [
        { names: ['chisel'], count: 1 }, { names: ['uncut opal'], count: 18 }, { names: ['uncut sapphire'], count: 3 },
        { names: ['uncut emerald'], count: 6 }, { names: ['uncut ruby'], count: 3 }, { names: ['uncut diamond'], count: 9 },
        { names: ['uncut dragonstone'], count: 277 },
    ],
    herblore: [
        { names: ['games necklace(8)'], count: 1 }, { names: ['raw beef'], count: 1 }, { names: ['raw rat meat'], count: 1 },
        { names: ['raw bear meat'], count: 1 }, { names: ['raw chicken'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
        { names: ['harralander potion (unf)'], count: 10 }, { names: ['chocolate dust'], count: 10 }, { names: ['irit potion (unf)'], count: 10 },
        { names: ['eye of newt'], count: 10 }, { names: ['kwuarm potion (unf)'], count: 30 }, { names: ['limpwurt root'], count: 10 },
        { names: ['dragon scale dust'], count: 50 }, { names: ['lantadyme potion (unf)'], count: 30 }, { names: ['torstol potion (unf)'], count: 170 },
        { names: ['jangerberrie'], count: 170 },
    ],
    magic: [
        { names: ['staff of fire'], count: 1 }, { names: ['mind rune'], count: 25 }, { names: ['cosmic rune'], count: 150 },
        { names: ['water rune'], count: 20 }, { names: ['air rune'], count: 1500 }, { names: ['earth rune'], count: 400 },
        { names: ['sapphire ring'], count: 12 }, { names: ['emerald ring'], count: 27 }, { names: ['shark'], count: 3 },
        { names: ['ruby ring'], count: 72 }, { names: ['diamond ring'], count: 36 }, { names: ['law rune'], count: 12 },
        { names: ['blood rune'], count: 850 }, { names: ['knife'], count: 1 }, { names: ['dragon bone'], count: 8 },
        { names: ['prayer potion(4)'], count: 2 }, { names: ['amulet of magic'], count: 1 }, { names: ['super energy(4)'], count: 1 },
    ],
    'cooking-live': [
        { names: ['raw lobster'], count: 1000 }, { names: ['raw karambwan'], count: 1000 }, { names: ['raw shark'], count: 1000 },
        { names: ['amulet of glory(4)'], count: 1 }, { names: ['ring of dueling(8)'], count: 1 },
    ],
    'woodcutting-live': [
        { names: ['bronze axe'], count: 1 }, { names: ['steel axe'], count: 1 }, { names: ['mithril axe'], count: 1 },
        { names: ['adamant axe'], count: 1 }, { names: ['rune axe'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'firemaking-live': [
        { names: ['tinderbox'], count: 1 }, { names: ['log'], count: 100 }, { names: ['oak log'], count: 200 },
        { names: ['willow log'], count: 500 }, { names: ['maple log'], count: 800 }, { names: ['yew log'], count: 800 },
        { names: ['magic log'], count: 500 },
    ],
    'agility-live': [
        { names: ['summer pie'], count: 20 }, { names: ['super energy(4)'], count: 20 }, { names: ['shark'], count: 50 },
        { names: ['ring of dueling(8)'], count: 1 }, { names: ['amulet of glory(4)'], count: 1 },
    ],
    'haggis-mainland': [
        { names: ['uncut dragonstone'], count: 277 }, { names: ['gold bar'], count: 277 }, { names: ['ball of wool'], count: 277 },
        { names: ['chisel'], count: 1 }, { names: ['ring mould'], count: 1 }, { names: ['necklace mould'], count: 1 },
        { names: ['amulet mould'], count: 1 }, { names: ['amulet of glory(4)'], count: 2 }, { names: ['ring of dueling(8)'], count: 4 },
        { names: ['games necklace(8)'], count: 2 }, { names: ['prayer potion(4)'], count: 25 }, { names: ['super restore(4)'], count: 10 },
        { names: ['super energy(4)'], count: 20 }, { names: NON_WILDY_ANTIPOISON, count: 10 },
    ],
};

export function specialistStagingNeeds(inp: Inputs, mine: readonly Acct[]): GoalNeed[] {
    const requested = [...new Set((inp.specialists ?? []).map(s => s.toLowerCase()))].filter(k => k in SPECIALIST_STAGE_BILLS);
    if (!requested.length) return [];
    const squadMembers = new Set((inp.squad?.active ? inp.squad.all ?? inp.squad.members.map(m => m.name) : []).map(n => n.toLowerCase()));
    const byHolder = new Map<string, Record<string, number>>();
    for (const a of mine) {
        const lower = a.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        byHolder.set(lower, a.items);
    }
    for (const s of inp.stock ?? []) {
        const lower = s.name.toLowerCase();
        if (inp.army?.has(lower) || squadMembers.has(lower)) continue;
        const prev = byHolder.get(lower) ?? {};
        const merged: Record<string, number> = { ...prev };
        for (const [item, n] of Object.entries(s.items)) merged[item] = Math.max(merged[item] ?? 0, n);
        byHolder.set(lower, merged);
    }
    const freePool = new Map<string, number>();
    for (const items of byHolder.values()) for (const [item, n] of Object.entries(items)) freePool.set(item, (freePool.get(item) ?? 0) + n);
    // Reserve direct route need so specialist staging only consumes uncommitted free stock.
    for (const r of inp.bill) if (r.need > 0) for (const k of [r.item, ...(r.aliases ?? [])].map(norm)) {
        const held = freePool.get(k) ?? 0;
        if (held > 0) { freePool.set(k, Math.max(0, held - r.need)); break; }
    }
    const out: GoalNeed[] = [];
    for (const key of requested) for (const line of SPECIALIST_STAGE_BILLS[key]!) {
        let left = line.count;
        for (const name of line.names) {
            const avail = freePool.get(name) ?? 0;
            const take = Math.min(left, avail);
            if (take > 0) { freePool.set(name, avail - take); left -= take; }
        }
        if (left > 0) out.push({ names: [...line.names], short: left, consumer: `specialist ${key}: ${line.names[0]}` });
    }
    return out;
}
