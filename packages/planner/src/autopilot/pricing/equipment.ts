// Weapon, armour, tool, bow/arrow, and splash equipment definitions, kit buy constants, and knight yield curve.
import { ammoTier, objId, spellFact, toolLevel, wearLevel } from '../../../../core/src/content-facts';
import { ORDER_COIN_MARGIN } from '../../../../core/src/order-refusal';
import { xpForLevel } from '../../curve';
import type { Acct, Needs } from '../world';

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
type WeaponStage = { id: string; item: string; fallbacks?: readonly string[]; attack: number; quest?: string; goal: string; held: readonly string[] };
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
