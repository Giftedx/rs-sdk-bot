// Squad shop buyer templates and full `squadSupplies` assembly.
import { PEN_QUEST_POINTS, type Needs, type Template } from '../world';
import { SQUAD_RUN_MAX, SQUAD_UNIT_COST } from '../pricing';
import { squadFishingSupplies, squadGoldOre, squadKaramjaEggs, squadMagicLogs, squadRunecraftSupplies, squadTaverleyBlackDragons, squadWorldGatherers, tiadecheDangerGate } from './squad-gather';
import { squadHerbloreSupplies } from './squad-herblore';
import { squadCraftAndGearSupplies, squadFletchAndSmithSupplies } from './squad-craft';

export function squadSupplies(): Template[] {
    const shop = (id: string, profile: string, item: string, items: string, perTick: number, goal: string, needs: Needs): Template => {
        const cost = SQUAD_UNIT_COST[item]!, max = SQUAD_RUN_MAX[item]!;
        const sized = (units: number, held = 0) => {
            const spend = Math.ceil(units * cost * 2);
            return { args: ['shop-buy', profile, '1200'], env: { ITEMS: items, STOCK_TARGET: String(held + units), STOP_AT_TARGET: '1', BANK_PACK: '1', NO_BUY_TICKS: '25', FLOAT: String(spend + 200), COIN_RESERVE: '200', MAX_SPEND: String(spend) } };
        };
        return { id, family: 'shop-buyer', script: 'scripts/aio-market.ts', ...sized(max), role: 'bank', goal, resources: [`shop:${profile}`], needs, squadOnly: true,
            yields: () => [{ item, perTick }], spends: () => [{ item: 'coins', perTick: perTick * cost }], repeats: false,
            production: { output: item, outputPerUnit: 1, maximum: max, inputs: {}, resize: sized } };
    };
    const { arrows, smiths } = squadFletchAndSmithSupplies();
    const { bow, dhideAndChest, ringsAndGold, dragonstone } = squadCraftAndGearSupplies();
    return [
        ...squadRunecraftSupplies(),
        ...arrows,
        ...squadFishingSupplies(),
        ...smiths,
        squadMagicLogs(),
        bow,
        squadTaverleyBlackDragons(),
        ...dhideAndChest,
        squadGoldOre(),
        ...ringsAndGold,
        ...squadWorldGatherers(),
        ...squadHerbloreSupplies(),
        squadKaramjaEggs(),
        ...dragonstone,
        shop('squad-arrows-dargaud', 'dargaud', 'rune arrow', 'rune arrow', 0.4, 'buy rune arrows in the Ranging Guild for the gang squad', { skills: { Ranged: 40 }, items: { coins: 30_000 } }),
        shop('squad-karambwan-shop', 'alfonse', 'cooked karambwan', 'cooked karambwan', 0.05, 'buy cooked karambwan at Brimhaven Fish Restaurant for the gang squad', { items: { coins: 32_000 } }),
        shop('squad-raw-karambwan-shop', 'tiadeche', 'raw karambwan', 'raw karambwan', 0.05, 'buy raw karambwan from Tiadeche for the gang squad', { quests: ['Tai Bwo Wannai Trio'], items: { coins: 52_000 }, anyOf: tiadecheDangerGate }),
        shop('squad-water-betty', 'betty', 'water rune', 'water rune', 0.7, "buy water runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-aubury', 'aubury', 'water rune', 'water rune', 0.7, "buy water runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-water-guild', 'magic_guild_elemental', 'water rune', 'water rune', 0.7, 'buy water runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-earth-betty', 'betty', 'earth rune', 'earth rune', 0.7, "buy earth runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-earth-guild', 'magic_guild_elemental', 'earth rune', 'earth rune', 0.7, 'buy earth runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-air-betty', 'betty', 'air rune', 'air rune', 0.7, "buy air runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-air-aubury', 'aubury', 'air rune', 'air rune', 0.7, "buy air runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-betty', 'betty', 'fire rune', 'fire rune', 0.7, "buy fire runes at Betty's in Port Sarim for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-aubury', 'aubury', 'fire rune', 'fire rune', 0.7, "buy fire runes at Aubury's in Varrock for the gang squad", { items: { coins: 6000 } }),
        shop('squad-fire-guild', 'magic_guild', 'fire rune', 'fire rune', 0.7, 'buy fire runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 12_000 } }),
        shop('squad-blood-guild', 'magic_guild', 'blood rune', 'blood rune', 0.2, 'buy blood runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 110_000 } }),
        shop('squad-death-betty', 'betty', 'death rune', 'death rune', 0.3, "buy death runes at Betty's in Port Sarim", { items: { coins: 40_000 } }),
        shop('squad-death-aubury', 'aubury', 'death rune', 'death rune', 0.3, "buy death runes at Aubury's in Varrock", { items: { coins: 40_000 } }),
        shop('squad-death-guild', 'magic_guild', 'death rune', 'death rune', 0.4, 'buy death runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 80_000 } }),
        shop('squad-chaos-betty', 'betty', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Betty's in Port Sarim", { items: { coins: 30_000 } }),
        shop('squad-chaos-aubury', 'aubury', 'chaos rune', 'chaos rune', 0.4, "buy chaos runes at Aubury's in Varrock", { items: { coins: 30_000 } }),
        shop('squad-chaos-guild', 'magic_guild_elemental', 'chaos rune', 'chaos rune', 0.5, 'buy chaos runes at the Magic Guild', { skills: { Magic: 66 }, items: { coins: 60_000 } }),
        shop('squad-mind-betty', 'betty', 'mind rune', 'mind rune', 0.7, "buy mind runes at Betty's in Port Sarim", { items: { coins: 4000 } }),
        shop('squad-mind-aubury', 'aubury', 'mind rune', 'mind rune', 0.7, "buy mind runes at Aubury's in Varrock", { items: { coins: 4000 } }),
        shop('squad-nature-guild', 'magic_guild', 'nature rune', 'nature rune', 0.4, 'buy nature runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 40_000 } }),
        shop('squad-law-guild', 'magic_guild', 'law rune', 'law rune', 0.4, 'buy law runes at the Magic Guild for the gang squad', { skills: { Magic: 66 }, items: { coins: 17_000 } }),
        shop('squad-antipoison-jiminua', 'jiminua', 'antipoison(3)', 'antipoison', 0.02, "buy antipoison(3) at Jiminua's in Karamja for the gang squad", { items: { coins: 8000 } }),
        shop('squad-dragon-dagger', 'jukat_dagger', 'dragon dagger', 'dragon dagger', 0.01, 'buy dragon daggers from Jakut in Zanaris for weapon poisoning', { quests: ['Lost City'], items: { coins: 130_000, diamond: 1 } }),
        shop('squad-berserker-helm', 'skulgrimen', 'berserker helm', 'berserker helm', 0.01, 'buy berserker helms from Skulgrimen after The Fremennik Trials for the gang squad', { quests: ['The Fremennik Trials'], skills: { Hitpoints: 45 }, items: { coins: 160_000 } }),
        shop('squad-oziach-platebody', 'oziach', 'rune platebody', 'rune platebody', 0.01, 'buy rune platebodies from Oziach after Dragon Slayer for the gang squad', { quests: ['Dragon Slayer'], items: { coins: 170_000 } }),
        shop('squad-scavvo-platelegs', 'scavvo', 'rune plateleg', 'rune platelegs', 0.01, "buy rune platelegs from Scavvo at the Champions' Guild for the gang squad", { quests: ['Dragon Slayer'], items: { coins: 130_000 } }),
        shop('squad-tenzing-boots', 'tenzing', 'climbing boot', 'climbing boots', 0.05, 'buy climbing boots from Tenzing after Death Plateau for the gang squad', { quests: ['Death Plateau'], items: { coins: 300 } }),
        shop('squad-sapphire-herquin', 'herquin', 'uncut sapphire', 'uncut sapphire', 0.02, "buy uncut sapphires at Herquin's in Falador for rings of recoil", { items: { coins: 15_000 } }),
        shop('squad-sapphire-gem-trader', 'gem_trader', 'uncut sapphire', 'uncut sapphire', 0.02, 'buy uncut sapphires in Al Kharid for rings of recoil', { items: { coins: 15_000 } }),
        shop('squad-emerald-gem-trader', 'gem_trader', 'uncut emerald', 'uncut emerald', 0.02, 'buy uncut emeralds in Al Kharid for rings of dueling(8)', { items: { coins: 20_000 } }),
        shop('squad-eye-of-newt', 'taverley', 'eye of newt', 'eye of newt', 0.3, "buy eye of newt at Jatix's Herblore shop in Taverley", { items: { coins: 1000 } }),
        shop('squad-vial-of-water', 'ardy', 'vial of water', 'vial of water', 0.3, "buy vials of water from Aemad's store in East Ardougne", { items: { coins: 1500 } }),
        shop('squad-shantay-waterskin', 'shantay', 'waterskin(4)', 'waterskin', 0.05, 'buy waterskins(4) at Shantay Pass for quest supply demand', { items: { coins: 1000 } }),
        shop('squad-shantay-bronze-bar', 'shantay', 'bronze bar', 'bronze bar', 0.02, 'buy bronze bars at Shantay Pass for quest and smithing demand', { items: { coins: 1000 } }),
        shop('squad-horvik-black-body', 'horvik', 'black platebody', 'black platebody', 0.005, "buy black platebodies at Horvik's Armoury in Varrock", { items: { coins: 8000 } }),
        shop('squad-louie-black-legs', 'louie', 'black plateleg', 'black platelegs', 0.005, 'buy black platelegs from Louie Legs in Al Kharid', { items: { coins: 4000 } }),
        shop('squad-valaine-black-helm', 'valaine', 'black full helm', 'black full helm', 0.005, "buy black full helms at Valaine's shop in the Champions' Guild", { questPoints: PEN_QUEST_POINTS['3197,3353'], items: { coins: 2500 } }),
        shop('squad-chocolate-bar', 'wydin_choc', 'chocolate bar', 'chocolate bar', 0.05, "buy chocolate bars at Wydin's Food Store in Port Sarim", { items: { coins: 600 } }),
        shop('squad-cake-baker', 'baker', 'cake', 'cake', 0.03, 'buy cakes at the East Ardougne bakery for chocolate cakes', { items: { coins: 800 } }),
        shop('squad-priest-gown', 'thessalia_gown', 'priest gown', 'priest gown', 0.02, "buy priest gowns at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-leather-gloves', 'thessalia', 'leather glove', 'leather gloves', 0.03, "buy leather gloves at Thessalia's Clothes Shop in Varrock", { items: { coins: 500 } }),
        shop('squad-fishing-bait', 'sarim', 'fishing bait', 'fishing bait', 0.3, "buy fishing bait at Gerrant's in Port Sarim", { items: { coins: 1500 } }),
        shop('squad-papyrus', 'ardy', 'papyrus', 'papyrus', 0.05, "buy papyrus from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-ball-of-wool', 'ardy', 'ball of wool', 'ball of wool', 0.05, "buy balls of wool from Aemad's store in East Ardougne", { items: { coins: 500 } }),
        shop('squad-charcoal', 'jiminua', 'charcoal', 'charcoal', 0.02, "buy charcoal at Jiminua's Jungle Store on Karamja", { items: { coins: 1500 } }),
        shop('squad-cape-of-legends', 'siegfried', 'cape of legend', 'cape of legends', 0.01, "buy capes of legends from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 2000 } }),
        shop('squad-shield-right-half', 'siegfried', 'shield right half', 'shield right half', 0.005, "buy shield right halves from Siegfried Erkle in the Legends' Guild", { quests: ['Legends Quest'], items: { coins: 1_500_000 } }),
        shop('squad-dragon-battleaxe', 'helemos', 'dragon battleaxe', 'dragon battleaxe', 0.005, "buy dragon battleaxes from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 400_000 } }),
        shop('squad-dragon-mace', 'helemos', 'dragon mace', 'dragon mace', 0.005, "buy dragon maces from Helemos in the Heroes' Guild", { quests: ["Hero's Quest"], items: { coins: 100_000 } }),
    ];
}
