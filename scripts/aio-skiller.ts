// AIO Skiller ("Vortex All In One"): unified entry for all 15 non-combat skills, bank-profile jobs, and progressive training.
// Usage:
//   bun scripts/aio-skiller.ts <account> <skill> [method] [arg ...] [KEY=value ...]
//   bun scripts/aio-skiller.ts <account> bank-job <job.json> [job.json ...]   (several jobs: one login, in order)
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Step} from '../packages/core/src/chain-step';
import {isStopFilePresent} from '../packages/workers/src/stop';
import {DEFAULT_METHOD,resolveRouteStep,resolveSkillerMethod} from './aio-route-step';
import {levelForXp,xpForLevel} from '../packages/planner/src/curve';
import {planBankTripSchedule} from '../packages/core/src/bank-trip';
import {runBankJob,runBankProfile,validateBankJob,type BankJob} from './microbot-bank-jobs';
import {
 gatherWorker,
 VALID_GATHER_SKILLS,
 type GatherSkill,
 type GatherExternalDeps,
 FISH_PROFILES,runStagedFishing,pickFishSpot,fishSpotIds,searchNativeCatherbyFishing,type FishMethod,
 sharkSpot,catchSharks,SHARK_HARPOON_ANIM,SHARK_IDLE_TICKS,SHARK_PROGRESS_TICKS,
 supplySharks,sharkOrderConfig,SHARK_BANK,WEST_BANK,
 cookStarterChicken,starterCookingStock,
 miningProfiles,runAtSiteMining,incidentalMiningGems,
 stallRecipes,stealStall,
 supplyPlan as woodSupplyPlan,takeOwnedSupplyKnife,runWoodSupply,
 incomingCookedFood,courierFoodReady,receiveFoodAtBank,
} from '../packages/workers/src/gather';
import {
 bankArtisanWorker,
 VALID_ARTISAN_SKILLS,
 type ArtisanSkill,
 type ArtisanExternalDeps,
 cookSharks,cookingRecipes,runCookingBatch,nativeHeatSources,
 jewelleryRecipes,runJewellery,
 runSoftenClay,
 runShafts,
 inventoryRecipes,runInventoryBank,
 tanningRecipes,tanInventory,type TanKind,
 furnaceGlassRecipe,runFurnaceGlass,
 itemMagicRecipe,itemSpellCosts,runItemMagic,
 runMixedWine,runBonesBank,
 smeltRecipe,planSmeltLoad,smeltEffect,validateSmeltOrder,validateSmeltRoute,nativeSmeltFurnace,nativeSmeltStands,runSmeltBatch,type SmeltOrder,type SmeltRecipe,
 smithRecipe,planSmithLoad,smithEffect,runSmithBatch,HAMMER,SMITHING_INTERFACE,type SmithRecipe,
 planHeadless,runHeadless,type HeadlessOptions,
 validateWoodProcessingJob,runWoodProcessingCycle,runWoodProductDrop,runFletchingCycle,type WoodProcessingJob,
 LOGS,BURN_ROWS,DRAYNOR_SITE,CATHERBY_SITE,firemakingSite,progressiveFiremakingLog,firemakingOptions,firemakingPreflight,lineTiles,nextFreeTile,packWant,type LogKind,type FiremakingOptions,
 BONE_XP,prayerOptions,planPrayer,prayerBank,runPrayer,type PrayerOptions,
 boundedHerbloreMove,tracedWalker,observeHerbloreStep,reachSeller,
 kittenCare,weedMiscellania,fillDruidPouch,druidPouchFillDelta,
} from '../packages/workers/src/bank-artisan';
import {agilityWorker,runAgilityCli,COURSES,agilityOptions,agilityPreflight,onCourse,resumeStep,type Course,type AgilityOptions} from '../packages/workers/src/agility';
import {runecraftWorker,runRunecraftCli,RUNE_ALTARS,chooseRuneAltar,ruinTarget,dispatchRuneEntry,settleRuneEntryModal,NATURE,natureProfile,runNatureTrips,createShiloTransit,type NatureJob,runRuneSupply,runeSupplyTarget,type RunecraftMode,type RunecraftExternalDeps} from '../packages/workers/src/runecraft';

async function runMagicOrderCli(account: string, env: Record<string, string | undefined> = process.env) {
 return (await import('./magic-order')).runMagicOrderCli(account, env);
}

export {
 gatherWorker,
 bankArtisanWorker,
 // Bank-profile engine & recipes
 runBankJob,runBankProfile,validateBankJob,type BankJob,
 FISH_PROFILES,runStagedFishing,pickFishSpot,fishSpotIds,searchNativeCatherbyFishing,type FishMethod,
 sharkSpot,catchSharks,SHARK_HARPOON_ANIM,SHARK_IDLE_TICKS,SHARK_PROGRESS_TICKS,
 supplySharks,sharkOrderConfig,SHARK_BANK,WEST_BANK,
 cookStarterChicken,starterCookingStock,
 cookingRecipes,runCookingBatch,nativeHeatSources,
 jewelleryRecipes,runJewellery,
 miningProfiles,runAtSiteMining,incidentalMiningGems,
 stallRecipes,stealStall,
 inventoryRecipes,runInventoryBank,
 tanningRecipes,tanInventory,type TanKind,
 furnaceGlassRecipe,runFurnaceGlass,
 itemMagicRecipe,itemSpellCosts,runItemMagic,
 runMixedWine,runBonesBank,
 // Smithing & Smelting
 smeltRecipe,planSmeltLoad,smeltEffect,validateSmeltOrder,validateSmeltRoute,nativeSmeltFurnace,nativeSmeltStands,runSmeltBatch,type SmeltOrder,type SmeltRecipe,
 smithRecipe,planSmithLoad,smithEffect,runSmithBatch,HAMMER,SMITHING_INTERFACE,type SmithRecipe,
 // Fletching, Woodcutting & Firemaking
 planHeadless,runHeadless,type HeadlessOptions,
 validateWoodProcessingJob,runWoodProcessingCycle,runWoodProductDrop,runFletchingCycle,type WoodProcessingJob,
 woodSupplyPlan,takeOwnedSupplyKnife,runWoodSupply,
 LOGS,BURN_ROWS,DRAYNOR_SITE,CATHERBY_SITE,firemakingSite,progressiveFiremakingLog,firemakingOptions,firemakingPreflight,lineTiles,nextFreeTile,packWant,type LogKind,type FiremakingOptions,
 // Agility, Runecraft, Prayer, Herblore, Thieving & Care
 agilityWorker,runAgilityCli,COURSES,agilityOptions,agilityPreflight,onCourse,resumeStep,type Course,type AgilityOptions,
 runecraftWorker,runRunecraftCli,RUNE_ALTARS,chooseRuneAltar,ruinTarget,dispatchRuneEntry,settleRuneEntryModal,
 NATURE,natureProfile,runNatureTrips,createShiloTransit,type NatureJob,
 runRuneSupply,runeSupplyTarget,
 BONE_XP,prayerOptions,planPrayer,prayerBank,runPrayer,type PrayerOptions,
 boundedHerbloreMove,tracedWalker,observeHerbloreStep,reachSeller,
 incomingCookedFood,courierFoodReady,receiveFoodAtBank,
 kittenCare,weedMiscellania,fillDruidPouch,druidPouchFillDelta,
 runMagicOrderCli,
};

export interface SkillerRouteSpec {
 skill: string;
 method: string;
 script: string;
 defaultArgs?: readonly string[];
 defaultEnv?: Readonly<Record<string, string>>;
 description: string;
}

export const SKILLER_ROUTES: readonly SkillerRouteSpec[] = [
 // Fishing
 {skill:'fishing',method:'shark',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','shark'],description:'Catherby shark harpoon + cook + bank order'},
 {skill:'fishing',method:'cage',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','cage','cage'],defaultEnv:{CAP:'3000'},description:'Catherby lobster cage + bank'},
 {skill:'fishing',method:'harpoon',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','harpoon','harpoon'],defaultEnv:{CAP:'3000'},description:'Catherby tuna/swordfish harpoon + bank'},
 {skill:'fishing',method:'fishcook',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','fishcook'],description:'Lumbridge 3-tick fly fishing + general store fireplace cooking + Draynor bank'},
 {skill:'fishing',method:'village',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','village'],description:'Barbarian Village fly/bait fishing with drop/cook/bank modes'},
 {skill:'fishing',method:'staged',script:'scripts/aio-skiller.ts',defaultArgs:['gather','fishing','staged'],description:'Staged native fishing across all 10 FISH_PROFILES methods'},
 {skill:'fishing',method:'fly30',script:'scripts/generated/fishing30.ts',description:'Fresh-account fly fishing to level 30'},
 {skill:'fishing',method:'specialist',script:'scripts/fishing-specialist.ts',description:'Fresh-clock specialist Fishing 1 to 99 with tutorial skip, helper trade, and 3-tick net/bait/fly fishing'},
 // Cooking
 {skill:'cooking',method:'food',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','food'],description:'Cook banked raw fish (lobster/shark/trout/salmon) at Catherby range'},
 {skill:'cooking',method:'stock',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','stock'],description:'Batch cook banked raw stock with burn/XP reconciliation'},
 {skill:'cooking',method:'wine',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','wine'],description:'Ferment jugs of wine from grapes and water jugs'},
 {skill:'cooking',method:'mixed-wine',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','mixed-wine'],description:'Bank-staged wine fermentation with exact ferm/bad-wine reconciliation'},
 {skill:'cooking',method:'batch',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','batch'],description:'Staged range/fire cooking batch for any native recipe'},
 {skill:'cooking',method:'ge-cook',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','cooking','ge-cook'],description:'GE-restocked cooking batch'},
 {skill:'cooking',method:'specialist',script:'scripts/cooking-specialist.ts',description:'Fresh-clock specialist Cooking 1 to 99 via noted wine fermentation and 4 Fruit Blasts'},
 // Woodcutting
 {skill:'woodcutting',method:'edgeville',script:'scripts/aio-skiller.ts',defaultArgs:['gather','woodcutting','edgeville'],description:'Edgeville tree/oak/yew woodcutting order'},
 {skill:'woodcutting',method:'yews',script:'scripts/aio-skiller.ts',defaultArgs:['gather','woodcutting','yews'],description:'Chop and bank yew logs'},
 {skill:'woodcutting',method:'fresh45',script:'scripts/generated/woodcutting.ts',description:'Fresh account to Woodcutting 45 with the knife reset (axe from Bob, trees then willows)'},
 {skill:'woodcutting',method:'loop',script:'scripts/aio-skiller.ts',defaultArgs:['gather','woodcutting','loop'],description:'Continuous woodcutting loop'},
 {skill:'woodcutting',method:'specialist',script:'scripts/woodcutting-specialist.ts',description:'Fresh-clock specialist Woodcutting 1 to 99 with 2-tick goblin flinch / 3-tick knife-reset Oaks'},
 // Firemaking
 {skill:'firemaking',method:'order',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','firemaking','order'],description:'Line firemaking order from banked logs (normal/oak/willow/maple/yew/magic)'},
 {skill:'firemaking',method:'line',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','firemaking','line'],description:'Train a runner on a firemaking line supplied by named owned helper accounts'},
 {skill:'firemaking',method:'ge',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','firemaking','ge'],description:'GE-supplied firemaking batch'},
 {skill:'firemaking',method:'specialist',script:'scripts/firemaking-specialist.ts',description:'Fresh-clock specialist Firemaking 1 to 99 lighting pre-dropped Lumbridge ground log lines'},
 // Fletching
 {skill:'fletching',method:'arrows',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','fletching','arrows'],description:'Fletch shafts, headless arrows, and tipped arrows (bronze..rune)'},
 {skill:'fletching',method:'shafts',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','fletching','shafts'],defaultEnv:{MODE:'shafts'},description:'Fletch arrow shafts from banked logs'},
 {skill:'fletching',method:'worker',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','fletching','worker'],description:'Fletch unstrung/strung shortbows and longbows from banked logs'},
 {skill:'fletching',method:'specialist',script:'scripts/fletching-specialist.ts',description:'Fresh-clock specialist Fletching 1 to 99 with tutorial skip, helper trade, and 5-action/tick arrow fletching'},
 // Mining
 {skill:'mining',method:'ore',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','ore'],description:'Mine and bank copper/tin/iron/coal/gold/mithril/adamant'},
 {skill:'mining',method:'essence',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','essence'],description:'Mine and bank Rune essence at Varrock/Aubury'},
 {skill:'mining',method:'at-site',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','at-site'],description:'Staged at-site rock mining across all native rock profiles'},
 {skill:'mining',method:'drop',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','drop'],description:'Power-mine and drop ore'},
 {skill:'mining',method:'progressive',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','progressive'],description:'Progressive level-unlocked mining'},
 {skill:'mining',method:'loot',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','loot'],description:'Mine and bank with gem/loot retention'},
 {skill:'mining',method:'lava-maze',script:'scripts/aio-skiller.ts',defaultArgs:['gather','mining','lava-maze'],description:'Wilderness Lava Maze runite ore mining'},
 {skill:'mining',method:'specialist',script:'scripts/mining-specialist.ts',description:'Fresh-clock specialist Mining 1 to 99 via Doric Quest and 3-tick Ardougne Zoo iron rotation'},
 // Smithing
 {skill:'smithing',method:'smelt',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','smithing','smelt'],description:'Smelt bronze/iron/steel/gold/mithril/adamant/runite bars at furnace'},
 {skill:'smithing',method:'anvil',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','smithing','anvil'],defaultEnv:{ORDER_ACTION:'smith'},description:'Smith bars on the anvil: PRODUCT_ID, MAX_MAKE and BAR_RESERVE name the order'},
 {skill:'smithing',method:'cannonballs',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','smithing','cannonballs'],description:'Smelt steel bars into cannonballs'},
 {skill:'smithing',method:'specialist',script:'scripts/smithing-specialist.ts',description:'Fresh-clock 1-to-99 Smithing via Glory Edgeville and Varrock West anvil runners'},
 // Crafting
 {skill:'crafting',method:'bowstrings',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','bowstrings'],description:'Spin flax into bowstrings at Seers/Lumbridge wheel'},
 {skill:'crafting',method:'jewellery',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','jewellery'],description:'Craft rings, necklaces, and amulets at furnace'},
 {skill:'crafting',method:'jewellery-trip',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','jewellery-trip'],description:'Full bank-to-furnace jewellery crafting trip'},
 {skill:'crafting',method:'legacy-jewelry',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','legacy-jewelry'],description:'Gem cutting and furnace jewellery smelting at Al Kharid (use jewellery-trip for bounded orders)'},
 {skill:'crafting',method:'glass',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','glass'],description:'Smelt soda ash + sand into molten glass and blow glass items'},
 {skill:'crafting',method:'tanning',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','tanning'],description:'Tan cowhide and dragonhides at Al Kharid tanner'},
 {skill:'crafting',method:'black-dhide-sets',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','black-dhide-sets'],description:'Tan banked black dragonhide at Al Kharid and craft body, chaps and vambraces sets at the bank'},
 {skill:'crafting',method:'soften-clay',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','soften-clay'],description:'Soften clay with water sources'},
 {skill:'crafting',method:'inventory',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','inventory'],description:'Bank-staged inventory crafting (leather, gems, battle staves, pottery)'},
 {skill:'crafting',method:'progressive',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','crafting','progressive'],description:'Progressive level-unlocked inventory crafting'},
 {skill:'crafting',method:'specialist',script:'scripts/crafting-specialist.ts',description:'Fresh-clock 1-to-99 Crafting via 5-per-tick unnoted gem cutting'},
 // Herblore
 {skill:'herblore',method:'potions',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','herblore','potions'],description:'Clean herbs, make unfinished potions, and brew finished potions'},
 {skill:'herblore',method:'meats',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','herblore','meats'],description:'Gather/prepare meats for Druidic Ritual Herblore unlock'},
 {skill:'herblore',method:'specialist',script:'scripts/herblore-specialist.ts',description:'Fresh-clock 1-to-99 Herblore via Games necklace Druidic Ritual and Edgeville 10-potion bank cycles'},
 // Runecraft
 {skill:'runecraft',method:'bank-craft',script:'scripts/aio-skiller.ts',defaultArgs:['runecraft','bank-craft'],description:'Craft banked essence at best unlocked altar (air/mind/water/earth/fire/body/cosmic)'},
 {skill:'runecraft',method:'nature',script:'scripts/aio-skiller.ts',defaultArgs:['runecraft','nature'],description:'Shilo Village Nature altar runecrafting trips'},
 {skill:'runecraft',method:'supply',script:'scripts/aio-skiller.ts',defaultArgs:['runecraft','supply'],description:'Full fresh-account Rune Mysteries + essence + air runecraft chain'},
 {skill:'runecraft',method:'air',script:'scripts/aio-skiller.ts',defaultArgs:['runecraft','air'],description:'Direct Air altar runecrafting'},
 {skill:'runecraft',method:'specialist',script:'scripts/runecraft-specialist.ts',description:'Fresh-clock 1-to-99 Runecraft via Air altar unlock and Body altar essence runners'},
 // Magic
 {skill:'magic',method:'order',script:'scripts/aio-skiller.ts',defaultArgs:['combat','magic-order'],description:'Combat/curse/bolt magic training order'},
 {skill:'magic',method:'items',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','items'],description:'High/Low Alchemy, Superheat Item, and Jewellery Enchanting'},
 {skill:'magic',method:'npc',script:'scripts/aio-skiller.ts',defaultArgs:['combat','magic-npc'],description:'Curse/Weakening/Strike/Bolt/Blast spell casting on NPCs'},
 {skill:'magic',method:'teleport',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','teleport'],description:'Repeated teleport spell training'},
 {skill:'magic',method:'trip',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','trip'],description:'Bank-staged magic training trip'},
 {skill:'magic',method:'orbs',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','orbs'],defaultEnv:{ORB_TRIP:'1'},description:'Bank trip to an obelisk to charge air/earth/water/fire orbs'},
 {skill:'magic',method:'orbs-at-site',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','orbs-at-site'],description:'At-obelisk orb charging batch'},
 {skill:'magic',method:'bones',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','bones'],description:'Bones to Bananas conversion'},
 {skill:'magic',method:'earth-production',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','earth-production'],description:'Earth rune production for magic/superheat'},
 {skill:'magic',method:'alch-train',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','magic','alch-train'],description:'Alchemy on a cheap stackable item at the Ardougne north bank: Low Alchemy to Magic 55, then High Alchemy to the target level'},
 {skill:'magic',method:'splash',script:'scripts/aio-skiller.ts',defaultArgs:['combat','magic-splash'],description:'Curse casts over the fence of the Ardougne cow field to the target Magic level'},
 {skill:'magic',method:'splash-coop',script:'scripts/aio-skiller.ts',defaultArgs:['combat','magic-splash-coop'],defaultEnv:{SPLASH_SITE:'coop'},description:'The record route opening: Wind Strike and Confuse from the starter pack at the Lumbridge coop, no bank'},
 {skill:'magic',method:'specialist',script:'scripts/magic-specialist.ts',description:'Fresh-clock 1-to-99 Magic via enchant ladder, Mage Arena, and 5-per-tick Charge'},
 // Prayer
 {skill:'prayer',method:'bury',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','prayer','bury'],description:'Bury bones / big bones / dragon bones to target Prayer level'},
 {skill:'prayer',method:'flick',script:'scripts/aio-skiller.ts',defaultArgs:['combat','prayer-flick'],description:'1-tick prayer flicking upkeep'},
 {skill:'prayer',method:'specialist',script:'scripts/prayer-specialist.ts',description:'Fresh-clock 1-to-99 Prayer via Draynor Bank dragon-bone runners and Lumbridge burying'},
 // Agility
 {skill:'agility',method:'order',script:'scripts/aio-skiller.ts',defaultArgs:['agility','order'],description:'Gnome Stronghold / Barbarian / Wilderness / Brimhaven agility course order'},
 {skill:'agility',method:'specialist',script:'scripts/agility-specialist.ts',description:'Fresh-clock 1 to 99 Agility specialist route (Tourist Trap + boosted Wilderness course)'},
 // Thieving
 {skill:'thieving',method:'knights',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','knights'],description:'Pickpocket Knights of Ardougne with bank food refill and Baker stall fallback'},
 {skill:'thieving',method:'knights-stable',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','knights-stable'],description:'Bounded Ardougne knight pickpocketing batch'},
 {skill:'thieving',method:'stun-base',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with no action inside a stun (MODE=base)'},
 {skill:'thieving',method:'stun-bury',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with a bone buried inside each stun (MODE=bury)'},
 {skill:'thieving',method:'stun-enchant',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with an enchant cast inside each stun (MODE=enchant)'},
 // Superheat Smithing 1-41 during Ardougne knight stuns: Magic 43+ casts superheat:bronze (1-15, 12 casts) and
 // superheat:iron (15-41, 45 casts) via packages/workers/src/bank-artisan (artisan magic:items) + fire staff during 8-tick stuns.
 {skill:'thieving',method:'bootstrap55',script:'scripts/generated/thieving60.ts',description:'Fresh-account Men -> Cake stall -> Guards -> Knights to 55/60 Thieving'},
 {skill:'thieving',method:'pickpocket',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','pickpocket'],description:'Bank-staged pickpocket trip for any native NPC profile'},
 {skill:'thieving',method:'pickpocket-at-site',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','pickpocket-at-site'],description:'At-site NPC pickpocketing'},
 {skill:'thieving',method:'stalls',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','stalls'],description:'Steal from Baker/Silk/Fur/Silver/Spice/Gem stalls'},
 {skill:'thieving',method:'blood-chest',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','blood-chest'],description:'Chaos Druid Tower blood rune chest thieving'},
 {skill:'thieving',method:'nature-chest',script:'scripts/aio-skiller.ts',defaultArgs:['gather','thieving','nature-chest'],description:'East Ardougne nature rune chest thieving'},
 {skill:'thieving',method:'specialist',script:'scripts/thieving-specialist.ts',description:'Fresh-clock specialist Thieving 1 to 99 prototype using relog-on-stun at East Ardougne'},
 // Foraging / Gathering / Care
 {skill:'foraging',method:'flax',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','flax'],description:'Pick and bank flax at Seers Village'},
 {skill:'foraging',method:'wool',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','wool'],description:'Shear sheep and spin wool at Lumbridge'},
 {skill:'foraging',method:'feathers',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','feathers'],description:'Collect feathers at chicken pens'},
 {skill:'foraging',method:'spawn',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','spawn'],description:'Collect ground spawns and bank'},
 {skill:'foraging',method:'grapes',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','grapes'],description:'Collect grapes for wine making'},
 {skill:'foraging',method:'care',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','foraging','care'],description:'Kitten care (feed/wool/stroke), Miscellania weeding, and Druid pouch filling'},
 {skill:'foraging',method:'miscellania-coffer',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','foraging','miscellania-coffer'],description:'Manage Kingdom of Miscellania coffer and approval'},
 {skill:'foraging',method:'qol',script:'scripts/aio-skiller.ts',defaultArgs:['artisan','foraging','qol'],description:'Auto Cannon refill, prayer hold, special bar enable, and inventory drop patterns'},
 {skill:'foraging',method:'crystal-chest',script:'scripts/aio-skiller.ts',defaultArgs:['gather','foraging','crystal-chest'],description:'Combine key halves and open Taverley crystal chests from Falador West Bank for uncut dragonstones'},
];

export {DEFAULT_METHOD};

export function skillerCatalogSummary() {
 return {
  skills: [...new Set(SKILLER_ROUTES.map(r => r.skill))],
  routes: SKILLER_ROUTES.length,
  bankJobProfiles: {
   fishing: Object.keys(FISH_PROFILES),
   cooking: cookingRecipes().recipes.map(r => r.name),
   jewellery: jewelleryRecipes().map(r => r.name),
   mining: miningProfiles().map(r => r.name),
   stalls: stallRecipes().map(r => r.name),
   inventory: inventoryRecipes().map(r => r.name),
   tanning: Object.keys(tanningRecipes),
  },
 };
}

export interface ProgressiveBand {
 skill: string;
 method: string;
 fromLevel: number;
 toLevel: number;
 unlockLevel: number;
 xpPerUnit: number;
 unitsNeeded: number;
 step: Step;
 // Only on a band with unitsNeeded 0: no unlocked tier has its inputs, and this names what each tier lacks.
 shortfall?: string;
}

export function progressiveSkillerAlternatives(skillInput:string,currentLevel:number,targetLevel:number,xpRate=25):ProgressiveBand[]{
 const skill=skillInput.toLowerCase();
 if(!Number.isSafeInteger(currentLevel)||currentLevel<1||!Number.isSafeInteger(targetLevel)||targetLevel<=currentLevel||targetLevel>99||!Number.isFinite(xpRate)||xpRate<=0)throw Error('aio-skiller: invalid progressive level bounds');
 const tiers=PROGRESSIVE_TIERS[skill];if(!tiers)throw Error(`aio-skiller: no XP progression for ${skill}`);
 const to=skill==='prayer'?Math.max(43,targetLevel):targetLevel;
 return tiers.filter(t=>t.level<=currentLevel).map(t=>progressiveTierBand(skill,t,currentLevel,to,xpRate));
}

export type ProgressiveTier = { level: number; method: string; xp: number; args?: readonly string[]; env?: Readonly<Record<string, string>>; job?: {family: BankJob['family'];recipe: string;members?: boolean;bank?: BankJob['bank'];site?: BankJob['site']} };
export const PROGRESSIVE_TIERS: Readonly<Record<string, readonly ProgressiveTier[]>> = {
 firemaking: [
  { level: 1, method: 'order', xp: 40, env: { LOG: 'normal' } },
  { level: 15, method: 'order', xp: 60, env: { LOG: 'oak' } },
  { level: 30, method: 'order', xp: 90, env: { LOG: 'willow' } },
  { level: 45, method: 'order', xp: 135, env: { LOG: 'maple' } },
  { level: 60, method: 'order', xp: 202.5, env: { LOG: 'yew' } },
  { level: 75, method: 'order', xp: 303.8, env: { LOG: 'magic' } },
 ],
 woodcutting: [
  { level: 1, method: 'fresh45', xp: 25 },
  { level: 15, method: 'fresh45', xp: 37.5 },
  { level: 30, method: 'fresh45', xp: 67.5 },
 ],
 fishing: [
  { level: 1, method: 'fly30', xp: 10 },
  { level: 20, method: 'fly30', xp: 50 },
 ],
 cooking: [
  { level: 1, method: 'batch', xp: 30, job: {family:'cooking',recipe:'cooking_generic_chicken'} },
  { level: 15, method: 'batch', xp: 70, job: {family:'cooking',recipe:'cooking_generic_trout'} },
  { level: 35, method: 'mixed-wine', xp: 200, job: {family:'wine',recipe:'wine'} },
 ],
 fletching: [
  { level: 1, method: 'arrows', xp: 5, args: ['3000', 'shafts'] },
  { level: 5, method: 'worker', xp: 5, job: {family:'inventory',recipe:'cut-bow:unstrung_shortbow',members:true} },
  { level: 10, method: 'worker', xp: 10, job: {family:'inventory',recipe:'cut-bow:unstrung_longbow',members:true} },
  { level: 25, method: 'worker', xp: 25, job: {family:'inventory',recipe:'cut-bow:unstrung_oak_longbow',members:true} },
  { level: 40, method: 'worker', xp: 41.5, job: {family:'inventory',recipe:'cut-bow:unstrung_willow_longbow',members:true} },
  { level: 55, method: 'worker', xp: 58.3, job: {family:'inventory',recipe:'cut-bow:unstrung_maple_longbow',members:true} },
  { level: 70, method: 'worker', xp: 75, job: {family:'inventory',recipe:'cut-bow:unstrung_yew_longbow',members:true} },
  { level: 85, method: 'worker', xp: 91.5, job: {family:'inventory',recipe:'cut-bow:unstrung_magic_longbow',members:true} },
 ],
 mining: [
  { level: 1, method: 'ore', xp: 17.5, job: {family:'mining',recipe:'copper_rock_table',bank:{x:3253,z:3420,level:0},site:{x:3286,z:3368,level:0}} },
  { level: 15, method: 'ore', xp: 35, job: {family:'mining',recipe:'iron_rock_table',bank:{x:3253,z:3420,level:0},site:{x:3286,z:3368,level:0}} },
 ],
 smithing: [
  { level: 1, method: 'smelt', xp: 6.2, args: ['20000', 'bronze'] },
  { level: 15, method: 'smelt', xp: 12.5, args: ['20000', 'iron'] },
  { level: 30, method: 'smelt', xp: 17.5, args: ['20000', 'steel'] },
  { level: 33, method: 'anvil', xp: 125, args: ['20000'], env: { ORDER_ACTION: 'smith', PRODUCT_ID: '1115', BAR_RESERVE: '0' } },
  { level: 40, method: 'smelt', xp: 22.5, args: ['20000', 'gold'] },
  { level: 48, method: 'anvil', xp: 187.5, args: ['20000'], env: { ORDER_ACTION: 'smith', PRODUCT_ID: '1119', BAR_RESERVE: '0' } },
  { level: 50, method: 'smelt', xp: 30, args: ['20000', 'mithril'] },
  { level: 68, method: 'anvil', xp: 250, args: ['20000'], env: { ORDER_ACTION: 'smith', PRODUCT_ID: '1121', BAR_RESERVE: '0' } },
  { level: 70, method: 'smelt', xp: 37.5, args: ['20000', 'adamantite'] },
  { level: 85, method: 'smelt', xp: 50, args: ['20000', 'runite'] },
  { level: 88, method: 'anvil', xp: 312.5, args: ['20000'], env: { ORDER_ACTION: 'smith', PRODUCT_ID: '1123', BAR_RESERVE: '0' } },
 ],
 crafting: [
  { level: 1, method: 'inventory', xp: 13.8, job: {family:'inventory',recipe:'leather:leather_gloves'} },
  { level: 5, method: 'jewellery', xp: 15, job: {family:'jewellery',recipe:'gold_ring'} },
  { level: 10, method: 'bowstrings', xp: 15 },
  { level: 46, method: 'inventory', xp: 52.5, job: {family:'inventory',recipe:'glass:stafforb',members:true} },
 ],
 herblore: [
  { level: 3, method: 'potions', xp: 25, env: { RECIPE: 'attack' } },
  { level: 38, method: 'potions', xp: 87.5, env: { RECIPE: 'prayer' } },
  { level: 45, method: 'potions', xp: 100, env: { RECIPE: 'super_attack' } },
 ],
 magic: [
  { level: 1, method: 'order', xp: 5.5 },
  { level: 3, method: 'splash', xp: 13 },
  { level: 11, method: 'splash', xp: 21 },
  { level: 19, method: 'splash', xp: 29 },
  { level: 21, method: 'alch-train', xp: 31 },
  { level: 55, method: 'alch-train', xp: 65 },
 ],
 agility: [
  { level: 1, method: 'order', xp: 86.5, args: ['gnome'] },
  { level: 35, method: 'order', xp: 114.5, args: ['barbarian'] },
  { level: 52, method: 'order', xp: 571.4, args: ['wilderness'] },
 ],
 thieving: [
  { level: 1, method: 'bootstrap55', xp: 8 },
  { level: 5, method: 'bootstrap55', xp: 16 },
  { level: 40, method: 'bootstrap55', xp: 46.8 },
  { level: 55, method: 'bootstrap55', xp: 84.3 },
 ],
 runecraft: [
  { level: 1, method: 'bank-craft', xp: 5 },
  { level: 2, method: 'bank-craft', xp: 5.5, env: { RUNE_ALTAR: 'mind' } },
  { level: 5, method: 'bank-craft', xp: 6, env: { RUNE_ALTAR: 'water' } },
  { level: 9, method: 'bank-craft', xp: 6.5, env: { RUNE_ALTAR: 'earth' } },
  { level: 14, method: 'bank-craft', xp: 7, env: { RUNE_ALTAR: 'fire' } },
  { level: 20, method: 'bank-craft', xp: 7.5, env: { RUNE_ALTAR: 'body' } },
 ],
 prayer: [
  { level: 1, method: 'bury', xp: 4.5, env: { BONE_ID: '526' } },
  { level: 43, method: 'bury', xp: 15, env: { BONE_ID: '532' } },
  { level: 44, method: 'bury', xp: 72, env: { BONE_ID: '536' } },
 ],
};

// Inline profiles keep a generated progression self-contained when a chain or swarm executes it.
export function bankJobStep(job: BankJob): Step {
 validateBankJob(job);
 return {script:'scripts/aio-skiller.ts',args:['bank-job',`--job=${encodeURIComponent(JSON.stringify(job))}`],env:{}};
}

export function readBankJobArgument(argument: string): BankJob {
 const job = JSON.parse(argument.startsWith('--job=') ? decodeURIComponent(argument.slice(6)) : readFileSync(resolve(argument),'utf8')) as BankJob;
 validateBankJob(job);
 return job;
}

function progressiveTierBand(skill:string,active:ProgressiveTier,fromLevel:number,toLevel:number,xpRate:number,units?:number):ProgressiveBand{
 const effectiveXp=active.xp*xpRate,unitsNeeded=units??Math.max(1,Math.ceil(Math.max(0,xpForLevel(toLevel)-xpForLevel(fromLevel))/effectiveXp));
 const extra=[...(active.args??[]),...(['agility','runecraft','cooking','magic'].includes(skill)&&(skill!=='magic'||active.method==='alch-train'||active.method==='splash')?[String(toLevel)]:[]),
  `TARGET_LEVEL=${toLevel}`,'CAP=20000',...(['woodcutting','fishing','thieving'].includes(skill)?[`TARGET=${toLevel}`]:[]),
  ...(skill==='fletching'?[`MAX_MAKE=${Math.min(25,unitsNeeded)}`,'LOG_RESERVE=0','BANK_KNIFE=1']:[]),
  ...(skill==='crafting'&&active.method==='bowstrings'?[`MAX_MAKE=${unitsNeeded}`,'RAW_RESERVE=0']:[]),
  ...(skill==='smithing'?[`MAX_MAKE=${unitsNeeded}`,active.method==='anvil'?'BAR_RESERVE=0':'ORE_RESERVE=0']:[]),...(skill==='prayer'?[`MAX_BURY=${unitsNeeded}`]:[]),
  ...Object.entries(active.env??{}).map(([k,v])=>`${k}=${v}`)];
 return{skill,method:active.method,fromLevel,toLevel,unlockLevel:active.level,xpPerUnit:effectiveXp,unitsNeeded,
  step:active.job?bankJobStep({family:active.job.family,recipe:active.job.recipe,target:unitsNeeded,batch:13,cap:20000,returnTicks:300,members:active.job.members??false,reserve:0,
   ...skill==='cooking'?{targetLevel:toLevel}:{},...active.job.bank?{bank:active.job.bank}:{},...active.job.site?{site:active.job.site}:{}}):resolveSkillerStep(skill,active.method,extra)};
}

// What one unit of a tier uses, holds and makes. Only smithing names them (content recipes: smelt-batch.ts,
// smith-batch.ts): an anvil order smiths bars that the account owns (smelt-bars.ts ORDER_ACTION=smith).
type TierStock={inputs:Readonly<Record<number,number>>;tools:readonly number[];makes?:number};
function tierStock(skill:string,tier:ProgressiveTier):TierStock|null{
 if(skill!=='smithing')return null;
 if(tier.method==='anvil'){const r=smithRecipe(Number(tier.env!.PRODUCT_ID));return{inputs:{[r.bar]:r.bars},tools:[HAMMER]};}
 if(tier.method==='smelt'){const r=smeltRecipe(tier.args![1]!);return{inputs:Object.fromEntries(r.ingredients.map(i=>[i.id,i.units])),tools:[],makes:r.product};}
 return null;
}

// Compute an automatic level-band progression from currentLevel -> targetLevel (accounting for server xpRate, default 25x).
// `owned` is the stock of the account (item id to count, pack and bank). A tier is planned only with inputs that the
// stock holds or that an earlier band of the plan makes, and a band never plans more units than its inputs allow.
// With no `owned` the plan knows no stock: it assumes each raw input (ore, coal, a tool) and counts only the bars
// that its own bands make. If no unlocked tier has its inputs, the plan ends with a band of 0 units and a `shortfall`.
export function planProgressiveSkiller(skillInput: string, currentLevel: number, targetLevel: number, xpRate = 25, owned?: Readonly<Record<number, number>>): ProgressiveBand[] {
 const skill = skillInput.toLowerCase();
 if (!Number.isSafeInteger(currentLevel) || currentLevel < 1 || !Number.isSafeInteger(targetLevel) || targetLevel <= currentLevel || targetLevel > 99 || !Number.isFinite(xpRate) || xpRate <= 0) {
  throw Error('aio-skiller: invalid progressive level bounds');
 }
 const tiers = PROGRESSIVE_TIERS[skill];
 if (!tiers) {
  throw Error(`aio-skiller: no XP progression for ${skill}`);
 }
 if (currentLevel < tiers[0]!.level) throw Error(`aio-skiller: ${skill} requires its level ${tiers[0]!.level} quest unlock`);
 // The owned prayer worker also verifies Protect from Melee; its first accepted milestone is 43.
 if(skill==='prayer')targetLevel=Math.max(43,targetLevel);
 const stockOf=new Map(tiers.map(t=>[t,tierStock(skill,t)])),made=new Set([...stockOf.values()].flatMap(k=>k?.makes===undefined?[]:[k.makes]));
 const stock=new Map<number,number>(Object.entries(owned??{}).map(([id,n])=>[Number(id),n]));
 const have=(id:number)=>owned===undefined&&!made.has(id)?Infinity:stock.get(id)??0;
 // Whole units of a tier that the stock pays for.
 const affordable=(t:ProgressiveTier)=>{const k=stockOf.get(t);return !k?Infinity:k.tools.some(id=>have(id)<1)?0:Math.min(...Object.entries(k.inputs).map(([id,n])=>Math.floor(have(Number(id))/n)));};
 // What a tier needs and the stock does not hold, as counts of item ids.
 const lacks=(t:ProgressiveTier)=>{const k=stockOf.get(t)!;return `${t.method} ${t.env?.PRODUCT_ID??t.args?.[1]??''} needs ${[...Object.entries(k.inputs).filter(([id,n])=>have(Number(id))<n).map(([id,n])=>`${n}x${id}`),...k.tools.filter(id=>have(id)<1).map(id=>`1x${id}`)].join(' ')}`;};
 const bands: ProgressiveBand[] = [];
 const goal=xpForLevel(targetLevel);
 let xp=xpForLevel(currentLevel);
 while (xp < goal) {
  const level=levelForXp(xp);
  // The unlocked tiers, most XP for each unit first, the later tier on a tie. A later tier is not always the better
  // one: a smelt and an anvil action both take 5 ticks (knowledge/ladders.json), and a platebody gives more XP than
  // each bar that the levels above it smelt.
  const unlocked=tiers.filter(t=>t.level<=level).reverse().sort((a,b)=>b.xp-a.xp);
  // The first tier whose inputs the stock holds. For a tier with no bars, the smelt tier that makes its bar: the plan
  // smelts the bars and then smiths them.
  let active:ProgressiveTier|undefined,feeds:ProgressiveTier|undefined;
  for(const t of unlocked){
   if(affordable(t)>=1){active=t;break;}
   const k=stockOf.get(t)!,bar=Object.keys(k.inputs).map(Number).find(id=>made.has(id));
   const feeder=bar===undefined||k.tools.some(id=>have(id)<1)?undefined:unlocked.find(f=>stockOf.get(f)?.makes===bar&&affordable(f)>=1);
   if(feeder){active=feeder;feeds=t;break;}
  }
  if(!active){
   bands.push({...progressiveTierBand(skill,unlocked[0]!,level,targetLevel,xpRate,0),shortfall:unlocked.map(lacks).join('; ')});
   break;
  }
  // A band ends at the next tier that gives more than the tier it smiths or smelts for.
  const leader=feeds??active;
  const end=tiers.find(t=>t.level>level&&t.level<targetLevel&&t.xp>=leader.xp)?.level??targetLevel;
  const need=xpForLevel(end)-xp,each=active.xp*xpRate;
  let units=Math.max(1,Math.ceil(need/each));
  if(feeds){
   // The fewest bars to smelt so that the bars and the platebodies from them reach the end of the band.
   const bar=stockOf.get(active)!.makes!,held=have(bar),perUnit=stockOf.get(feeds)!.inputs[bar]!,smith=feeds.xp*xpRate;
   for(units=1;units*each+Math.floor((held+units)/perUnit)*smith<need;)units++;
  }
  units=Math.min(units,affordable(active));
  bands.push(progressiveTierBand(skill,active,level,end,xpRate,units));
  const k=stockOf.get(active);
  if(k){
   for(const [id,n] of Object.entries(k.inputs))if(have(Number(id))!==Infinity)stock.set(Number(id),have(Number(id))-n*units);
   if(k.makes!==undefined)stock.set(k.makes,(stock.get(k.makes)??0)+units);
  }
  xp=units*each>=need?xpForLevel(end):xp+units*each;
 }
 return bands;
}

export interface BankedProductionCandidate {
 family: BankJob['family'] | 'smelting';
 recipe: string;
 skill: string;
 levelRequired: number;
 product: number;
 feasibleUnits: number;
 bankJob?: BankJob;
}

// Scan an account's owned items (bank + pack) and skill levels against all 230+ native artisan recipes
// (cooking, jewellery, inventory crafting/fletching/herblore, tanning, glass, smelting) and return all feasible batches.
export function discoverBankedProduction(
 skills: Readonly<Record<string, number>>,
 ownedItems: Readonly<Record<number, number>>,
 options: { reserve?: number; members?: boolean; cap?: number; returnTicks?: number } = {},
): BankedProductionCandidate[] {
 const reserve = options.reserve ?? 0, members = options.members ?? true, cap = options.cap ?? 6000, returnTicks = options.returnTicks ?? 300;
 const out: BankedProductionCandidate[] = [];
 const hasTools = (tools: readonly number[]) => tools.every(id => (ownedItems[id] ?? 0) >= 1);
 const maxUnits = (inputs: readonly { id: number; units: number }[]) => {
  if (!inputs.length) return 0;
  return Math.min(...inputs.map(i => Math.max(0, Math.floor(((ownedItems[i.id] ?? 0) - reserve) / i.units))));
 };

 // 1. Cooking recipes
 const cookLvl = skills.Cooking ?? 1;
 for (const r of cookingRecipes().recipes) {
  if (cookLvl < r.level) continue;
  const units = Math.max(0, (ownedItems[r.raw] ?? 0) - reserve);
  if (units < 1) continue;
  out.push({
   family: 'cooking',
   recipe: r.name,
   skill: 'Cooking',
   levelRequired: r.level,
   product: r.products[0]!,
   feasibleUnits: units,
   bankJob: { family: 'cooking', recipe: r.name, target: units, batch: Math.min(28, units), cap, returnTicks, members, reserve },
  });
 }

 // 2. Jewellery recipes
 const craftLvl = skills.Crafting ?? 1;
 for (const r of jewelleryRecipes()) {
  if (craftLvl < r.level || (r.members && !members) || !hasTools(r.tools)) continue;
  const units = maxUnits(r.inputs);
  if (units < 1) continue;
  out.push({
   family: 'jewellery',
   recipe: r.name,
   skill: 'Crafting',
   levelRequired: r.level,
   product: r.product,
   feasibleUnits: units,
   bankJob: { family: 'jewellery', recipe: r.name, target: units, batch: Math.min(13, units), cap, returnTicks, members, reserve },
  });
 }

 // 3. Inventory production (Crafting, Fletching, Herblore, Cooking prep)
 for (const r of inventoryRecipes()) {
  const lvl = skills[r.skill] ?? 1;
  if (lvl < r.level || (r.members && !members) || !hasTools([...r.tools, ...(r.optionalInputs ?? [])])) continue;
  const units = maxUnits(r.inputs) * (r.productUnits ?? 1);
  if (units < 1) continue;
  out.push({
   family: 'inventory',
   recipe: r.name,
   skill: r.skill,
   levelRequired: r.level,
   product: r.product,
   feasibleUnits: units,
   bankJob: { family: 'inventory', recipe: r.name, target: units, batch: Math.min(27, units), cap, returnTicks, members, reserve },
  });
 }

 // 4. Furnace smelting
 const smithLvl = skills.Smithing ?? 1;
 for (const bar of ['bronze', 'iron', 'silver', 'steel', 'gold', 'mithril', 'adamantite', 'runite', 'cannonballs'] as const) {
  const r = smeltRecipe(bar);
  if (smithLvl < r.level || !hasTools(r.tools ?? [])) continue;
  const units = maxUnits(r.ingredients) * (r.productUnits ?? 1);
  if (units < 1) continue;
  out.push({
   family: 'smelting',
   recipe: bar,
   skill: 'Smithing',
   levelRequired: r.level,
   product: r.product,
   feasibleUnits: units,
  });
 }

 return out.sort((a, b) => b.levelRequired - a.levelRequired || b.feasibleUnits - a.feasibleUnits);
}

export type StunSuperheatBand = {
 fromSmithing: number;
 toSmithing: number;
 metal: 'bronze' | 'iron';
 casts: number;
 step: Step;
};

// Staged Superheat Item steps executed inside Ardougne knight 8-tick stuns (Magic 43+, fire staff + nature runes).
export function planStunSuperheatSmithing(currentSmithing: number, currentMagic: number, cap = 200): StunSuperheatBand[] {
 if (currentMagic < 43) throw Error(`aio-skiller: superheat in stun requires Magic 43 (got ${currentMagic})`);
 const bands: StunSuperheatBand[] = [];
 if (currentSmithing < 15) {
  bands.push({
   fromSmithing: currentSmithing, toSmithing: 15, metal: 'bronze', casts: 12,
   step: { script: 'scripts/aio-skiller.ts', args: ['artisan', 'magic', 'items', 'superheat:bronze', '-', '12', String(cap)], env: {} },
  });
 }
 if (currentSmithing < 41) {
  bands.push({
   fromSmithing: Math.max(currentSmithing, 15), toSmithing: 41, metal: 'iron', casts: 45,
   step: { script: 'scripts/aio-skiller.ts', args: ['artisan', 'magic', 'items', 'superheat:iron', '-', '45', String(cap)], env: {} },
  });
 }
 return bands;
}

export { planBankTripSchedule };

function parseGatherTokens(tokens: readonly string[]): { args: string[]; env: Record<string, string> } {
 const args: string[] = [], env: Record<string, string> = {};
 for (const token of tokens) {
  const setting = token.match(/^([A-Z][A-Z0-9_]*)=([\s\S]*)$/);
  if (setting) env[setting[1]!] = setting[2]!;
  else args.push(token);
 }
 return { args, env };
}

async function buildGatherDeps(): Promise<GatherExternalDeps> {
 const [
  {approach,awayFrom,walkTargetPersist,leaveTutorial,sendHandoff,receiveHandoff,pendingCourierFunding,serviceCourierFunding},
  {leaveRuneStarter},
  {walkFar,nearestBanks},
  {attackable,defaultSpec,fightPlayer},
  {escapeStep,hasVarrockTeleport,kitFrom},
 ] = await Promise.all([
  import('../packages/workers/src/logistics'),
  import('./rune-starter'),
  import('../packages/workers/src/quest/sweep'),
  import('./pk'),
  import('../packages/workers/src/pvp/wild-rules'),
 ]);
 return {
  workScript: 'scripts/aio-skiller.ts',
  approach,
  awayFrom,
  walkTargetPersist,
  leaveTutorial,
  leaveRuneStarter,
  walkFar: async (s, world, to, legTimeoutTicks, opts) =>
   (await walkFar(s, world as Parameters<typeof walkFar>[1], to, legTimeoutTicks, opts)) as Awaited<
    ReturnType<NonNullable<GatherExternalDeps['walkFar']>>
   >,
  nearestBanks: from => nearestBanks({ x: from.x, z: from.z, level: from.level ?? 0 }),
  sendHandoff,
  receiveHandoff,
  pendingCourierFunding,
  serviceCourierFunding,
  cookSharks,
  cookingRecipes,
  nativeHeatSources,
  runCookingBatch: (d, r, o) => runCookingBatch(d as Parameters<typeof runCookingBatch>[0], r, o),
  runSoftenClay,
  runShafts: (s, opts) => runShafts(s, { ...opts, reserve: opts.reserve ?? 0 }),
  runHeadless: (s, opts) => runHeadless(s, { ...opts, shaftReserve: opts.shaftReserve ?? 0, featherReserve: opts.featherReserve ?? 0 }),
  runBankProfile,
  runBankJob: (s, job, stop) => runBankJob(s, job as BankJob, stop),
  attackable,
  defaultSpec,
  fightPlayer: (s, targetName, opts) => fightPlayer(s, targetName, (opts ?? {}) as Parameters<typeof fightPlayer>[2]),
  escapeStep,
  hasVarrockTeleport,
  kitFrom,
 };
}

const LEGACY_GATHER_METHOD_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
 fishing: { 'shark-supply': 'shark', 'gather-fish': 'cage', fishcook: 'fishcook', 'microbot-village-fishing': 'village', 'microbot-b-fishing': 'staged' },
 woodcutting: { 'edgeville-woodcut-order': 'edgeville', 'gather-yews': 'yews', 'wc-loop': 'loop', 'woodcut-supply': 'woodcut-supply' },
 mining: { 'gather-ore': 'ore', 'gather-essence': 'essence', 'microbot-b-mining': 'at-site', 'microbot-mining-drop': 'drop', 'microbot-mining-progressive': 'progressive', 'microbot-b-mining-loot': 'loot', 'lava-maze-escorted-ore': 'lava-maze' },
 thieving: { goldfarm: 'knights', 'goldfarm-stable': 'knights-stable', 'microbot-pickpocket-trip': 'pickpocket', 'microbot-a-pickpocket': 'pickpocket-at-site', 'microbot-c-stalls': 'stalls', 'blood-chest': 'blood-chest', 'microbot-b-nature-chest': 'nature-chest' },
 foraging: { 'gather-flax': 'flax', 'collect-wool': 'wool', 'gather-feathers': 'feathers', 'gather-spawn': 'spawn', grapes: 'grapes', 'crystal-chest': 'crystal-chest' },
 agility: { 'agility-order': 'order' },
 runecraft: { 'rune-bank-craft': 'bank-craft', 'microbot-rune-trip': 'nature', 'rune-supply': 'supply', rcair: 'air' },
 magic: { 'magic-order': 'order', 'microbot-magic-npc': 'npc', 'splash-train': 'splash' },
 prayer: { 'microbot-prayer-flick': 'flick' },
};

const RUNECRAFT_DIRECT_METHODS: Readonly<Record<string, RunecraftMode>> = {
 'bank-craft': 'bank-craft',
 'rune-bank-craft': 'bank-craft',
 nature: 'nature',
 'microbot-rune-trip': 'nature',
 supply: 'supply',
 'rune-supply': 'supply',
 air: 'air',
 rcair: 'air',
 carriers: 'carriers',
 staged: 'staged',
 'body-continuation': 'body-continuation',
 'body-measure': 'body-measure',
 'stage-carriers': 'stage-carriers',
 'stage-opening': 'stage-opening',
};

async function buildRunecraftDeps(): Promise<RunecraftExternalDeps> {
 const [{runRuneMysteries},{trainChickens}] = await Promise.all([
  import('./generated/quest-runemysteries'),
  import('../packages/workers/src/combat/chickens'),
 ]);
 return {
  runBankProfile,
  runRuneMysteries,
  trainChickens,
 };
}

const LEGACY_ARTISAN_METHOD_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
 cooking: { 'cook-food': 'food', 'cook-stock': 'stock', 'cook-wine': 'wine', 'microbot-wine': 'mixed-wine', 'microbot-b-cooking': 'batch', 'microbot-ge-cooking': 'ge-cook' },
 firemaking: { 'firemaking-order': 'order', 'firemaking-line': 'line', 'microbot-ge-firemaking': 'ge' },
 fletching: { 'fletch-arrows': 'arrows', 'fletch-shafts': 'shafts', 'fletch-worker': 'worker' },
 smithing: { 'smelt-bars': 'smelt', 'smelt-batch': 'smelt', 'smith-batch': 'anvil', 'microbot-a-cannonballs': 'cannonballs' },
 crafting: {
  'spin-bowstrings': 'bowstrings', 'microbot-b-jewellery': 'jewellery', 'microbot-jewellery-trip': 'jewellery-trip',
  'craft-jewelry': 'legacy-jewelry', 'microbot-glass': 'glass', 'microbot-c-tanner': 'tanning',
  'black-dhide-sets': 'black-dhide-sets', 'soften-clay': 'soften-clay', 'microbot-production': 'inventory',
  'microbot-production-progressive': 'progressive',
 },
 herblore: { 'brew-potions': 'potions', 'druid-meats': 'meats' },
 prayer: { 'train-prayer': 'bury' },
 magic: {
  'microbot-magic-items': 'items', 'microbot-magic-teleport': 'teleport', 'microbot-magic-trip': 'trip',
  'microbot-c-orbs': 'orbs', 'microbot-orb-trip': 'orbs', 'microbot-bones': 'bones',
  'earth-production': 'earth-production', 'alch-train': 'alch-train',
 },
 foraging: { 'microbot-c-care': 'care', 'microbot-misc-coffer': 'miscellania-coffer', 'microbot-c-qol': 'qol' },
};

async function buildArtisanDeps(): Promise<ArtisanExternalDeps> {
 const [
  {nativeNpcSpell,runNpcMagic},
  {combatTeleportAllowed},
  {withdrawFireOwned},
  {reconcileLoadout},
  {installOrbFloorBridge},
  {monitorWildernessLevel},
  {walkTargetPersist},
 ] = await Promise.all([
  import('../packages/workers/src/combat/magic'),
  import('../packages/workers/src/combat/survivability'),
  import('../packages/workers/src/combat/trip-kit'),
  import('./gear-reconcile'),
  import('./microbot-edgeville-travel'),
  import('../packages/workers/src/pvp/monitor'),
  import('../packages/workers/src/logistics'),
 ]);
 return {
  workScript: 'scripts/aio-skiller.ts',
  runBankJob: (s, job, stop) => runBankJob(s as Parameters<typeof runBankJob>[0], job as BankJob, stop),
  validateBankJob: j => validateBankJob(j as BankJob),
  runBankProfile: (s, j, p, stop) => runBankProfile(s as Parameters<typeof runBankProfile>[0], j as Parameters<typeof runBankProfile>[1], p as Parameters<typeof runBankProfile>[2], stop),
  nativeNpcSpell,
  runNpcMagic: (s, spell, opts) => runNpcMagic(s as Parameters<typeof runNpcMagic>[0], spell as Parameters<typeof runNpcMagic>[1], opts as unknown as Parameters<typeof runNpcMagic>[2]),
  combatTeleportAllowed,
  reconcileLoadout: (s, opts) => reconcileLoadout(s as Parameters<typeof reconcileLoadout>[0], opts as unknown as Parameters<typeof reconcileLoadout>[1]),
  withdrawFireOwned: (s, id, amount) => withdrawFireOwned(s as Parameters<typeof withdrawFireOwned>[0], id, amount),
  installOrbFloorBridge,
  monitorWildernessLevel,
  openQuest: async opts => (await import('./generated/quest-lib')).openQuest(opts),
  walkTargetPersist,
 };
}

export function resolveSkillerStep(skillInput: string, methodInput?: string, rest: readonly string[] = []): Step {
 const skill = skillInput.toLowerCase().replace(/^--skill=/, '');
 if(skill==='bank-job'){
  const jobs=[...methodInput?[methodInput]:[],...rest];
  if(!jobs.length)throw Error('aio-skiller bank-job requires <job.json>');
  return{script:'scripts/aio-skiller.ts',args:['bank-job',...jobs],env:{}};
 }
 if(skill==='gather'){
  const parsed = parseGatherTokens([methodInput ?? '', ...rest].filter(Boolean));
  return { script: 'scripts/aio-skiller.ts', args: ['gather', ...parsed.args], env: parsed.env };
 }
 if(skill==='artisan'){
  const parsed = parseGatherTokens([methodInput ?? '', ...rest].filter(Boolean));
  return { script: 'scripts/aio-skiller.ts', args: ['artisan', ...parsed.args], env: parsed.env };
 }
 const {method,args:extra} = resolveSkillerMethod(skill, methodInput, rest);
 const aliased = LEGACY_GATHER_METHOD_ALIASES[skill]?.[method] ?? LEGACY_ARTISAN_METHOD_ALIASES[skill]?.[method] ?? method;
 const route = SKILLER_ROUTES.find(r => r.skill === skill && r.method === aliased)
  ?? SKILLER_ROUTES.find(r => r.skill === skill && r.script.endsWith(`${method}.ts`));
 if (!route) {
  const known = SKILLER_ROUTES.filter(r => r.skill === skill).map(r => r.method);
  throw Error(known.length ? `aio-skiller: unknown ${skill} method "${method}"; known: ${known.join(', ')}` : `aio-skiller: unknown skill "${skill}"; known: ${Object.keys(DEFAULT_METHOD).join(', ')}`);
 }
 if (route.script === 'scripts/aio-skiller.ts' && route.defaultArgs?.[0] === 'gather') {
  const resolved = resolveRouteStep({ script: route.script, defaultEnv: route.defaultEnv }, extra);
  const tail = resolved.args.length ? resolved.args : route.defaultArgs.slice(3);
  return { script: route.script, args: ['gather', route.skill, route.method, ...tail], env: resolved.env };
 }
 if (route.script === 'scripts/aio-skiller.ts' && (route.defaultArgs?.[0] === 'agility' || route.defaultArgs?.[0] === 'runecraft')) {
  const resolved = resolveRouteStep({ script: route.script, defaultEnv: route.defaultEnv }, extra);
  return { script: route.script, args: [route.skill, route.method, ...resolved.args], env: resolved.env };
 }
 if (route.script === 'scripts/aio-skiller.ts' && route.defaultArgs?.[0] === 'combat') {
  const resolved = resolveRouteStep({ script: route.script, defaultEnv: route.defaultEnv }, extra);
  return { script: route.script, args: ['combat', route.defaultArgs[1]!, ...resolved.args], env: resolved.env };
 }
 if (route.script === 'scripts/aio-skiller.ts' && route.defaultArgs?.[0] === 'artisan') {
  const resolved = resolveRouteStep({ script: route.script, defaultEnv: route.defaultEnv }, extra);
  const tail = resolved.args.length ? resolved.args : route.defaultArgs.slice(3);
  return { script: route.script, args: ['artisan', route.skill, route.method, ...tail], env: resolved.env };
 }
 return resolveRouteStep(route, extra);
}

export function mergeSkillerEnv(
 stepEnv: Record<string, string>,
 baseEnv: Record<string, string | undefined>,
 rawTokens: readonly string[],
): Record<string, string | undefined> {
 const cliOverrides: Record<string, string> = {};
 for (const token of rawTokens) {
  const eq = token.indexOf('=');
  if (eq > 0 && /^[A-Z_][A-Z0-9_]*$/.test(token.slice(0, eq))) {
   cliOverrides[token.slice(0, eq)] = token.slice(eq + 1);
  }
 }
 const definedBase: Record<string, string | undefined> = {};
 for (const [k, v] of Object.entries(baseEnv)) {
  if (v !== undefined) definedBase[k] = v;
 }
 return { ...stepEnv, ...definedBase, ...cliOverrides };
}

 export async function runAioSkiller(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
  if (!account) throw Error('aio-skiller requires account');
  const [first, second, ...rest] = args;
  if (!first) throw Error('aio-skiller requires <skill|bank-job>');
  if (first === 'gather') {
   if (!second || !VALID_GATHER_SKILLS.includes(second as GatherSkill)) {
    throw Error(`aio-skiller gather requires <skill> (${VALID_GATHER_SKILLS.join('|')})`);
   }
   const [method = DEFAULT_METHOD[second] ?? '', ...tail] = rest;
   const parsed = parseGatherTokens(tail);
   const [{ runGatherCli }, deps] = await Promise.all([import('../packages/workers/src/gather/dispatch'), buildGatherDeps()]);
   const code = await runGatherCli(account, {
    skill: second as GatherSkill,
    method,
    args: parsed.args,
    env: { ...env, ...parsed.env },
    deps,
   });
   return code === 0 ? 'RESULT ok' : 'RESULT fail';
  }
  const normalizedSkill = first.toLowerCase().replace(/^--skill=/, '');
  if (normalizedSkill === 'agility' && second?.toLowerCase() !== 'specialist') {
   const explicitOrder = ['order', 'agility-order', '--method=order'].includes((second ?? '').toLowerCase());
   const rawTokens = explicitOrder ? rest : [second ?? '', ...rest].filter(Boolean);
   const parsed = parseGatherTokens(rawTokens);
   const { readPracticeSave } = await import('./measure/fleet-player-save');
   const code = await runAgilityCli([account, ...parsed.args], { ...env, ...parsed.env }, { readSave: readPracticeSave });
   return code === 0 ? 'RESULT ok' : 'RESULT fail';
  }
  if (normalizedSkill === 'runecraft' && second?.toLowerCase() !== 'specialist') {
   const normalizedMethod = (second ?? '').toLowerCase().replace(/^--method=/, '');
   const matchedMode = RUNECRAFT_DIRECT_METHODS[normalizedMethod];
   const rcMode: RunecraftMode = matchedMode ?? 'bank-craft';
   const rawTokens = matchedMode ? rest : [second ?? '', ...rest].filter(Boolean);
   const parsed = parseGatherTokens(rawTokens);
   const code = await runRunecraftCli(rcMode, account, parsed.args, { ...env, ...parsed.env }, await buildRunecraftDeps());
   return code === 0 ? 'RESULT ok' : 'RESULT fail';
  }
  if (first === 'combat') {
   if (!second) throw Error('aio-skiller combat requires <mode>');
   const prevExitCode = process.exitCode;
   process.exitCode = 0;
   try {
    const [{ runCombatModeCli }, { leaveRuneStarter }] = await Promise.all([
     import('../packages/workers/src/combat/module'),
     import('./rune-starter'),
    ]);
    await runCombatModeCli(account, second, rest, env, {
     leaveStarter: leaveRuneStarter,
     comboRecipe: itemMagicRecipe,
     runComboItem: runItemMagic,
    });
    return !process.exitCode || Number(process.exitCode) === 0 ? 'RESULT ok' : 'RESULT fail';
   } finally {
    process.exitCode = prevExitCode;
   }
  }
  if (first === 'artisan') {
   if (!second || !VALID_ARTISAN_SKILLS.includes(second as ArtisanSkill)) {
    throw Error(`aio-skiller artisan requires <skill> (${VALID_ARTISAN_SKILLS.join('|')})`);
   }
   if (second === 'bank-job') {
    return runAioSkiller(account, ['bank-job', ...rest], env);
   }
   const [method = DEFAULT_METHOD[second] ?? '', ...tail] = rest;
   const parsed = parseGatherTokens(tail);
   const [{ runArtisanCli }, deps] = await Promise.all([import('../packages/workers/src/bank-artisan/dispatch'), buildArtisanDeps()]);
   const code = await runArtisanCli(account, {
    skill: second as ArtisanSkill,
    method,
    args: parsed.args,
    env: { ...env, ...parsed.env },
    deps,
   });
   return code === 0 ? 'RESULT ok' : 'RESULT fail';
  }
  if (first === 'bank-job') {
   if (!second) throw Error('aio-skiller bank-job requires <job.json>');
   // Several job files run in one login, in order, and stop at the first failed job: each login costs board ticks.
   const jobs = [second, ...rest].map(readBankJobArgument);
   const { openBot, finish } = await import('../packages/core/src/bot');
   let stopped = false;
   let s: Awaited<ReturnType<typeof openBot>> | undefined;
   let ok = false, summary = '';
   try {
    s = await openBot(account, {
     onStop: async () => { stopped = true; },
     onSessionEnd: async () => { stopped = true; },
    });
    const results: Awaited<ReturnType<typeof runBankJob>>[] = [];
    for (const job of jobs) {
     const res = await runBankJob(
      s,
      job,
      () => stopped || isStopFilePresent(account),
     );
     results.push(res);
     if (!res.ok) break;
    }
    ok = results.length === jobs.length && results.every(r => r.ok);
    summary = jobs.length === 1 ? JSON.stringify(results[0]) : JSON.stringify({ ok, jobs: results });
   } catch (error) {
    summary = String(error);
   } finally {
    await finish(s ? [s] : [], ok, summary || 'aio-skiller bank-job');
   }
   const result = `RESULT ${ok ? 'ok' : 'fail'} ${summary}`;
   console.log(result);
   return result;
  }
  const step = resolveSkillerStep(first, second, rest);
  const mergedEnv = mergeSkillerEnv(step.env, env, [second ?? '', ...rest].filter(Boolean));
  if (step.script === 'scripts/aio-skiller.ts' && (step.args[0] === 'gather' || step.args[0] === 'combat' || step.args[0] === 'artisan')) {
   return runAioSkiller(account, step.args, mergedEnv);
  }
  const { runDirectChild } = await import('../packages/core/src/run-child');
  return runDirectChild([step.script, account, ...step.args], mergedEnv);
 }

if (import.meta.main) {
 const [account, ...rest] = process.argv.slice(2);
 if (account === '--list') {
  console.log(JSON.stringify(skillerCatalogSummary(), null, 2));
  process.exit(0);
 }
 if (!account || !rest.length) {
  console.log('RESULT fail usage: bun scripts/aio-skiller.ts <account> <skill|bank-job> [method] [args...] [KEY=value...]');
  process.exit(2);
 }
 const result = await runAioSkiller(account, rest);
 process.exit(/^RESULT ok(?: |$)/.test(result) ? 0 : 1);
}
