// Army combat, magic/splash, prayer/bone, ranged/arrow, and melee weapon/armour shop band templates.
import { xpForLevel } from '../../curve';
import { alchSupplies } from '../../alch-plan';
import {
    ARMOUR_BAND, COW_FIELD, PEN_QUEST_POINTS, SPLASH_FENCE, STRIKE_TILE, TROOPER_FIELD, WEAPON_BAND, norm,
    type Acct, type Needs, type Template,
} from '../world';
import {
    ARROW_LOW, ARROW_STOCK, ARROWS, BOWS, FIRE_STAFFS, LOWE_STOCK, RANGED_KIT,
    SPLASH_KIT, SPLASH_START, SPLASH_TO, WEAPON_HELD, splashKit,
} from '../pricing';
import {
    AIR_STOCK, BONE_KEEP, BONE_PURSE, BONE_SKILL, BONE_START, BOUGHT_BONE_XP, COW_BANDS,
    FEATHER_STOCK, FIRE_STOCK, GUILD_BAND, MAGIC_BAND, NATURE_STOCK, PRAYER_BAND, PRAYER_FIELD_BAND,
    RANGED_BAND, RANGED_TROOPER_DEFENCE, TROOPER_BANDS, TROOPER_FED, ZAFF_WAIT, holdsUnderKeys, shopRun,
} from './constants';

export function armyCombatTemplates(): {
    cows: Template[]; troopers: Template[]; magic: Template[]; prayer: Template[]; ranged: Template[]; gear: Template[]; prayerField: Template;
} {
    const cows = COW_BANDS.map(({ skill, band, to }): Template => ({
        id: `army-cow-${skill.toLowerCase()}-${to}`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['3000', 'cow'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: String(to), COW_BANK_PROFILE: 'north', MAX_KILLS: '8', COW_STAGE: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to ${to} on the Ardougne cows`,
        tier: 'goal', band, repeats: true, trains: { skill, to, unlocks: [] }, resources: [COW_FIELD], yields: () => [],
        needs: { food: 14, meleeWeapon: true },
        // One trip to the Grand Exchange brings food for many runs, not the two trout one start needs.
        batch: { trout: 30 },
    }));
    const troopers = TROOPER_BANDS.map(({ skill, band }): Template => ({
        id: `army-trooper-${skill.toLowerCase()}-99`, family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: skill, TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: `train ${skill} to 99 on the Khazard troopers`,
        tier: 'goal', band, repeats: true, trains: { skill, to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    }));
    // The alchemy band's consumables for the casts an account's Magic level still has to Magic 99 (the batch of a kit buy and what a donor keeps).
    const alchBatch = (a: Acct, item: string): Record<string, number> => {
        const need = alchSupplies(a.skills.Magic ?? 1);
        return { 'nature rune': need.nature, [item]: need.item, 'fire rune': need.fire };
    };
    const magic: Template = {
        id: 'army-alch-magic-99', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['99', '5000'], role: 'combat', goal: 'train Magic to 99 with alchemy at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [] }, resources: [], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { 'nature rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] },
        // One buy brings every consumable of the casts left to Magic 99 (alchSupplies: one nature rune and one item a cast, and fire
        // runes for the casts), as far as the account's coins reach (`partBatch`). Magic 21 to 99 is 642 casts: 642 nature runes, 642
        // feathers and 3,098 fire runes. A start's 250 fire runes cover 50 casts, so a band bought by starts returns to the shop many times.
        // With no coins for the whole batch the buy takes the share they pay for, down to the cash reserve and margin (`keepCoins` is not set).
        batchFor: a => alchBatch(a, 'feather'), partBatch: true,
    };
    // Magic 1 to 21 for Low Alchemy: Wind Strike on the fenced Guard dog (scripts/alch-train.ts strikeStart). Practice,
    // fresh accounts started at the goldfarm knights: Magic 1 to 21-23 in 17-22 casts, no damage taken, about 180 ticks alone.
    const strike: Template = {
        id: 'army-strike-magic-21', family: 'combat-train', script: 'scripts/alch-train.ts', args: ['21', '1500'], role: 'combat', goal: 'train Magic to 21 with Wind Strike from the safe tile at the Ardougne north bank',
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 21, unlocks: [magic.id] }, resources: [STRIKE_TILE], yields: () => [],
        needs: { items: { 'mind rune': 35, 'air rune': 35 } },
    };
    // The alchemy band's fire, band 2. The market lists no fire rune under the kit caps (live claude-cloud: "unsold"),
    // and a cast takes 3 or 5 of them; a staff of fire stands for all of them (scripts/alch-train.ts). An account that
    // holds the band's nature runes and feathers but no fire buys one staff at Zaff's shop in Varrock (staffshop: 2 in
    // stock, one back every 1,000 ticks) and banks it at Varrock West. A kit buy on the Grand Exchange leaves the
    // account next to the shop; from Ardougne scripts/shop-buyer.ts takes the ferries. A pilot (off unless a plan's
    // `aio` list names it): live, the shelf stood at 0 through five visits, one of 1,100 ticks, so another player takes
    // each staff as it comes back. On an empty shelf the run waits
    // ZAFF_WAIT ticks, a little over the 1,000 a staff takes to come back, so one visit brings a staff: a run that
    // waits less ends ok with nothing bought, and a long one of those reads as tick waste (live claude-cloud:
    // UnderMyKilt, 799 ticks, boughtTotal=0 after a 200-tick wait). STALL_TICKS=0: the session's idle guard would end
    // the wait at 900 ticks (packages/core/src/bot.ts); the run's own cap bounds it.
    const staff: Template = {
        id: 'army-staff-zaff', pilot: true, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zaff', '3000'],
        env: { ITEMS: 'staff of fire', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: String(ZAFF_WAIT), STALL_TICKS: '0', FLOAT: '13000', COIN_RESERVE: '500', MAX_SPEND: '12000' },
        role: 'supply', goal: "buy a staff of fire at Zaff's shop in Varrock for the alchemy band",
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: ['shop:zaff'], yields: () => [],
        needs: { skills: { Magic: 21 }, items: { coins: 15000, 'nature rune': 50, feather: 50 }, holdsUnder: { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 } },
    };
    const noFire = { ...Object.fromEntries(FIRE_STAFFS.map(item => [item, 1])), 'fire rune': 250 };
    const supply = (id: string, goal: string, shop: string, steps: string[], needs: Needs): Template => ({
        id, family: 'shop-buyer', script: 'scripts/chain.ts', args: steps, env: { ROUNDS: '1' }, role: 'supply', goal,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: 99, unlocks: [magic.id] }, resources: [`shop:${shop}`], yields: () => [], needs });
    const feathers = supply('army-feathers-sarim', "buy feathers at Gerrant's in Port Sarim for the alchemy band", 'sarim',
        [shopRun('sarim', 3000, 'feather', FEATHER_STOCK, 10000)], { under: { Magic: 66 }, items: { coins: 12000, 'nature rune': 50 }, holdsUnder: { feather: 50 } });
    const fireRunes = supply('army-fire-aubury', "buy fire runes at Aubury's in Varrock for the alchemy band", 'aubury',
        [shopRun('aubury', 3000, 'fire.rune', FIRE_STOCK, 9000)], { skills: { Magic: 21 }, under: { Magic: 66 }, items: { coins: 11000, 'nature rune': 50, feather: 50 }, holdsUnder: noFire });
    const guildRunes = [shopRun('magic_guild', 900, 'nature.rune', NATURE_STOCK, 45000), shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)];
    const staffGuild = supply('army-staff-guild', 'buy a staff of fire, fire, nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 1500, 'staff.of.fire', 1, 12000), shopRun('magic_guild', 600, 'fire.rune', FIRE_STOCK, 9000), ...guildRunes],
        { skills: { Magic: 66 }, items: { coins: 80000 }, holdsUnder: noFire });
    const natureGuild = supply('army-nature-guild', 'buy nature and air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild', guildRunes,
        { skills: { Magic: 66 }, items: { coins: 60000 }, holdsUnder: { 'nature rune': 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    const airGuild = supply('army-air-guild', 'buy air runes at the Magic Guild in Yanille for the alchemy band', 'magic_guild',
        [shopRun('magic_guild', 600, 'air.rune', AIR_STOCK, 10000)],
        { skills: { Magic: 66 }, items: { coins: 15000, 'nature rune': 50 }, holdsUnder: { 'air rune': 50, feather: 50 }, anyOf: [{ items: { 'fire rune': 250 } }, ...FIRE_STAFFS.map(item => ({ items: { [item]: 1 } }))] });
    const magicAir: Template = { ...magic, id: 'army-alch-air-magic-99', env: { ALCH_ITEM: 'airrune' }, goal: 'train Magic to 99 with alchemy on air runes at the Ardougne north bank',
        needs: { skills: { Magic: 66 }, items: { 'nature rune': 50, 'air rune': 50 }, anyOf: magic.needs!.anyOf }, batchFor: a => alchBatch(a, 'air rune'), shopKit: true };
    const splash: Template = {
        id: 'army-splash-magic-66', pilot: true, family: 'combat-train', script: 'scripts/splash-train.ts', args: [String(SPLASH_TO), '6000'], role: 'combat',
        goal: `train Magic to ${SPLASH_TO} with a curse cast over the fence of the Ardougne cow field`,
        tier: 'goal', band: MAGIC_BAND, repeats: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [magic.id] }, resources: [SPLASH_FENCE], yields: () => [],
        needs: { items: { ...SPLASH_START, 'mind rune': 2, 'air rune': 2 } }, batchFor: a => splashKit(a.skills.Magic ?? 1), kitFirst: true,
    };
    const waterJob = (id: string, where: string, shop: string): Template => ({
        ...supply(id, `buy water runes at ${where} for the curse band`, shop, [shopRun(shop, 3000, 'water.rune', SPLASH_KIT['water rune'], 12000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 14000, 'body rune': SPLASH_START['body rune'], 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'water rune': SPLASH_START['water rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    });
    const water = waterJob('army-water-aubury', "Aubury's in Varrock", 'aubury'), waterBetty = waterJob('army-water-betty', "Betty's in Port Sarim", 'betty');
    const body: Template = {
        ...supply('army-body-aubury', "buy body runes at Aubury's in Varrock for the curse band", 'aubury', [shopRun('aubury', 3000, 'body.rune', SPLASH_KIT['body rune'], 8000)],
            { under: { Magic: SPLASH_TO }, items: { coins: 10000, 'earth rune': SPLASH_START['earth rune'] }, holdsUnder: { 'body rune': SPLASH_START['body rune'] } }),
        pilot: true, trains: { skill: 'Magic', to: SPLASH_TO, unlocks: [splash.id] },
    };
    const prayer: Template = {
        id: 'army-bury-prayer-99', family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_RESERVE: '6', CAP: '4000' }, role: 'combat',
        goal: 'train Prayer to 99 burying the held bones', tier: 'goal', band: PRAYER_BAND, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { items: { bones: 100 } },
    };
    const boneBand = (id: string, bone: string, boneId: number, band: number): Template => ({
        id, family: 'combat-train', script: 'scripts/train-prayer.ts', args: ['99'], env: { BURY_HELD: '1', BONE_ID: String(boneId), BONE_RESERVE: String(BONE_KEEP), CAP: '4000' }, role: 'combat',
        goal: `train Prayer to 99 burying bought ${bone}`, tier: 'goal', band, repeats: false, trains: { skill: 'Prayer', to: 99, unlocks: [] }, yields: () => [],
        needs: { skills: { Ranged: BONE_SKILL, Magic: BONE_SKILL }, items: { [bone]: BONE_START } }, partBatch: true,
        // An account with Ranged or Magic still to finish keeps BONE_PURSE for arrows, a staff and a blade.
        keepCoins: a => (a.skills.Ranged ?? 1) < 99 || (a.skills.Magic ?? 1) < 99 ? BONE_PURSE : 0,
        batchFor: a => ({ [norm(bone)]: BONE_KEEP + Math.ceil((xpForLevel(99) - xpForLevel(a.skills.Prayer ?? 1)) / BOUGHT_BONE_XP[boneId]!) }),
    });
    const dragonBones = boneBand('army-bury-dragon-99', 'dragon bones', 536, PRAYER_BAND + 0.1), bigBones = boneBand('army-bury-big-99', 'big bones', 532, PRAYER_BAND + 0.2);
    const prayerField: Template = {
        id: 'army-trooper-prayer-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Hitpoints', GIANT_KILLS: '500', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Prayer to 99 burying trooper bones on the field',
        tier: 'goal', band: PRAYER_FIELD_BAND, filler: true, repeats: true, trains: { skill: 'Prayer', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        needs: { skills: { Attack: 60, Strength: 60, Defence: 60, Hitpoints: 40 }, anyOf: TROOPER_FED },
        batch: { trout: 100 },
    };
    const ranged: Template = {
        id: 'army-trooper-ranged-99', family: 'combat-train', script: 'scripts/gather-combat.ts', args: ['1500', 'trooper'],
        env: { TRAIN_SKILL: 'Ranged', TARGET_LEVEL: '99', GIANT_FOOD: '20', GIANT_BURY: '1', TROOPER_COOK: '1', LOOT_WATCH: '0' }, role: 'combat', goal: 'train Ranged to 99 on the Khazard troopers',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: [TROOPER_FIELD], yields: () => [],
        // RANGED_TROOPER_DEFENCE: the troopers reach an archer and hit it. Live, accounts with Defence 99 trained Ranged
        // 1 to 45-55 in a run with 0 to 1 food eaten and lowest HP 49 to 92; accounts with Defence 9, 10 and 43 ate 26 to
        // 36 food a run and fell to 16, 8 and 14 HP. An account under the floor takes its Defence bands first.
        needs: { skills: { Hitpoints: 40, Defence: RANGED_TROOPER_DEFENCE }, anyOf: RANGED_KIT.flatMap(kit => TROOPER_FED.map(fed => ({ ...kit, ...fed, skills: { ...kit.skills, ...fed.skills } }))) },
        batch: { trout: 100, ...Object.fromEntries(ARROWS.map(([arrow]) => [arrow, 1000])) },
    };
    const NO_ARROWS: Readonly<Record<string, number>> = Object.fromEntries(ARROWS.map(([arrow]) => [arrow, ARROW_LOW]));
    const arrows: Template = {
        id: 'army-arrows-ardy', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['ardy', '400'],
        env: { ITEMS: 'bronze arrow', STOCK_TARGET: String(ARROW_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '5000', COIN_RESERVE: '500', MAX_SPEND: '4000' },
        role: 'supply', goal: 'buy bronze arrows at Aemad in East Ardougne for the Ranged band',
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:ardy'], yields: () => [],
        needs: { items: { coins: 5000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const arrowsCatherby: Template = {
        id: 'army-arrows-catherby', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['catherby_arrows', '600'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Hickton's in Catherby for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:catherby_arrows'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const guildRun = (items: string, target: number, spend: number) => ['scripts/shop-buyer.ts', 'dargaud', '800', `ITEMS=${items}`, `STOCK_TARGET=${target}`,
        'STOP_AT_TARGET=1', 'BANK_PACK=1', 'BANK_AT=0', 'NO_BUY_TICKS=25', `FLOAT=${spend + 1000}`, 'COIN_RESERVE=500', `MAX_SPEND=${spend}`].join(' ');
    const arrowsGuild: Template = {
        id: 'army-arrows-guild', family: 'shop-buyer', script: 'scripts/chain.ts',
        args: [guildRun('willow.shortbow', 1, 3000), guildRun('mithril.arrow|steel.arrow|iron.arrow|bronze.arrow', ARROW_STOCK, 50000)],
        env: { ROUNDS: '1' }, role: 'supply', goal: 'buy a willow shortbow and arrows up to mithril at the Ranging Guild for the Ranged band',
        tier: 'goal', band: GUILD_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:dargaud'], yields: () => [],
        needs: { skills: { Ranged: 40 }, items: { coins: 60000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const arrowsLowe: Template = {
        id: 'army-arrows-lowe', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['lowe', '2500'],
        env: { ITEMS: 'iron arrow|bronze arrow', STOCK_TARGET: String(LOWE_STOCK), STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '21000', COIN_RESERVE: '500', MAX_SPEND: '20000' },
        role: 'supply', goal: "buy iron and bronze arrows at Lowe's in Varrock for the Ranged band",
        tier: 'goal', band: RANGED_BAND, repeats: true, trains: { skill: 'Ranged', to: 99, unlocks: [] }, resources: ['shop:lowe'], yields: () => [],
        needs: { items: { coins: 25000 }, pieces: { of: BOWS.map(([bow]) => bow), count: 1 }, holdsUnder: NO_ARROWS },
    };
    const zekeShop = (tier: string, item: string, minAtt: number, maxAtt: number, coins: number, better: readonly string[]): Template => ({
        id: `army-weapon-zeke-${tier}`, family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['zeke', '1200'],
        env: { ITEMS: `^${item}$`, STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: String(coins), COIN_RESERVE: '200', MAX_SPEND: String(Math.max(200, coins - 200)) },
        role: 'supply', goal: `buy ${item} from Zeke in Al Kharid`, tier: 'goal', band: WEAPON_BAND, stock: { item, to: 1 }, repeats: false,
        resources: ['shop:zeke'], yields: () => [],
        needs: { ...(minAtt > 1 ? { skills: { Attack: minAtt } } : {}), under: { Attack: maxAtt }, items: { coins }, holdsUnder: holdsUnderKeys([item, ...better]) },
    });
    const zekeIron = zekeShop('iron', 'iron scimitar', 1, 5, 400, ['steel scimitar', 'mithril scimitar', ...WEAPON_HELD]);
    const zekeSteel = zekeShop('steel', 'steel scimitar', 5, 20, 800, ['mithril scimitar', ...WEAPON_HELD]);
    const zekeMithril = zekeShop('mithril', 'mithril scimitar', 20, 30, 2000, [...WEAPON_HELD]);
    const scavvoArmour: Template = {
        id: 'army-armour-scavvo', family: 'shop-buyer', script: 'scripts/shop-buyer.ts', args: ['scavvo', '1500'],
        env: { ITEMS: 'rune platelegs|rune chainbody', STOCK_TARGET: '1', STOP_AT_TARGET: '1', BANK_PACK: '1', BANK_AT: '0', NO_BUY_TICKS: '25', FLOAT: '120000', COIN_RESERVE: '5000', MAX_SPEND: '115000' },
        role: 'supply', goal: "buy rune platelegs and rune chainbody from Scavvo in the Champions' Guild",
        tier: 'goal', band: ARMOUR_BAND, stock: { item: 'rune platelegs', to: 1 }, repeats: false, resources: ['shop:scavvo'], yields: () => [],
        needs: { skills: { Defence: 40 }, questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 120_000 }, shortOf: { 'rune platelegs': 1, 'rune chainbody': 1 }, holdsUnder: { 'rune platebody': 1 } },
    };
    return {
        cows, troopers,
        magic: [strike, magic, splash, water, waterBetty, body, staff, feathers, fireRunes, staffGuild, natureGuild, airGuild, magicAir],
        prayer: [prayer, dragonBones, bigBones],
        ranged: [arrows, arrowsCatherby, arrowsGuild, arrowsLowe, ranged],
        gear: [zekeIron, zekeSteel, zekeMithril, scavvoArmour],
        prayerField,
    };
}
