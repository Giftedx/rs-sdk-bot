// AIO Skiller ("Vortex All In One"): unified entry for all 15 non-combat skills, bank-profile jobs, and progressive training.
// Usage:
//   bun scripts/aio-skiller.ts <account> <skill> [method] [arg ...] [KEY=value ...]
//   bun scripts/aio-skiller.ts <account> bank-job <job.json> [job.json ...]   (several jobs: one login, in order)
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {runDirectChild} from '../packages/core/src/run-child';
import type {Step} from '../packages/core/src/chain-step';
import {DEFAULT_METHOD,resolveRouteStep,resolveSkillerMethod} from './aio-route-step';
import {levelForXp,xpForLevel} from '../packages/planner/src/curve';
import {planBankTripSchedule} from '../packages/core/src/bank-trip';
import {runBankJob,runBankProfile,validateBankJob,type BankJob} from './microbot-bank-jobs';
import {FISH_PROFILES,runStagedFishing,pickFishSpot,fishSpotIds,searchNativeCatherbyFishing,type FishMethod} from './microbot-b-fishing';
import {sharkSpot,catchSharks,SHARK_HARPOON_ANIM,SHARK_IDLE_TICKS,SHARK_PROGRESS_TICKS} from './gather-fish';
import {supplySharks,sharkOrderConfig,SHARK_BANK,WEST_BANK} from './shark-supply';
import {cookStarterChicken,starterCookingStock} from './fishcook';
import {cookingRecipes,runCookingBatch,nativeHeatSources} from './microbot-b-cooking';
import {jewelleryRecipes,runJewellery} from './microbot-b-jewellery';
import {miningProfiles,runAtSiteMining,incidentalMiningGems} from './microbot-b-mining';
import {stallRecipes,stealStall} from './microbot-c-stalls';
import {inventoryRecipes,runInventoryBank} from './microbot-production';
import {tanningRecipes,tanInventory,type TanKind} from './microbot-c-tanner';
import {furnaceGlassRecipe,runFurnaceGlass} from './microbot-glass';
import {itemMagicRecipe,itemSpellCosts,runItemMagic} from './microbot-magic-items';
import {runMixedWine} from './microbot-wine';
import {runBonesBank} from './microbot-bones';
import {smeltRecipe,planSmeltLoad,smeltEffect,validateSmeltOrder,validateSmeltRoute,nativeSmeltFurnace,nativeSmeltStands,runSmeltBatch,type SmeltOrder,type SmeltRecipe} from './smelt-batch';
import {smithRecipe,planSmithLoad,smithEffect,runSmithBatch,HAMMER,SMITHING_INTERFACE,type SmithRecipe} from './smith-batch';
import {planHeadless,runHeadless,type HeadlessOptions} from './fletch-arrows';
import {validateWoodProcessingJob,runWoodProcessingCycle,runWoodProductDrop,runFletchingCycle,type WoodProcessingJob} from './fletch-worker';
import {supplyPlan as woodSupplyPlan,takeOwnedSupplyKnife,runWoodSupply} from './woodcut-supply';
import {LOGS,BURN_ROWS,DRAYNOR_SITE,CATHERBY_SITE,firemakingSite,progressiveFiremakingLog,firemakingOptions,firemakingPreflight,lineTiles,nextFreeTile,packWant,type LogKind,type FiremakingOptions} from './firemaking-order';
import {COURSES,agilityOptions,agilityPreflight,onCourse,resumeStep,type Course,type AgilityOptions} from './agility-order';
import {RUNE_ALTARS,chooseRuneAltar,ruinTarget,dispatchRuneEntry,settleRuneEntryModal} from './rune-bank-craft';
import {NATURE,natureProfile,runNatureTrips,createShiloTransit,type NatureJob} from './microbot-rune-trip';
import {runRuneSupply,runeSupplyTarget} from './rune-supply';
import {BONE_XP,prayerOptions,planPrayer,prayerBank,runPrayer,type PrayerOptions} from './train-prayer';
import {boundedHerbloreMove,tracedWalker,observeHerbloreStep,reachSeller} from './brew-potions';
import {incomingCookedFood,courierFoodReady,receiveFoodAtBank} from './goldfarm';
import {kittenCare,weedMiscellania,fillDruidPouch,druidPouchFillDelta} from './microbot-c-care';

export {
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
 COURSES,agilityOptions,agilityPreflight,onCourse,resumeStep,type Course,type AgilityOptions,
 RUNE_ALTARS,chooseRuneAltar,ruinTarget,dispatchRuneEntry,settleRuneEntryModal,
 NATURE,natureProfile,runNatureTrips,createShiloTransit,type NatureJob,
 runRuneSupply,runeSupplyTarget,
 BONE_XP,prayerOptions,planPrayer,prayerBank,runPrayer,type PrayerOptions,
 boundedHerbloreMove,tracedWalker,observeHerbloreStep,reachSeller,
 incomingCookedFood,courierFoodReady,receiveFoodAtBank,
 kittenCare,weedMiscellania,fillDruidPouch,druidPouchFillDelta,
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
 {skill:'fishing',method:'shark',script:'scripts/shark-supply.ts',description:'Catherby shark harpoon + cook + bank order'},
 {skill:'fishing',method:'cage',script:'scripts/gather-fish.ts',defaultArgs:['cage'],defaultEnv:{CAP:'3000'},description:'Catherby lobster cage + bank'},
 {skill:'fishing',method:'harpoon',script:'scripts/gather-fish.ts',defaultArgs:['harpoon'],defaultEnv:{CAP:'3000'},description:'Catherby tuna/swordfish harpoon + bank'},
 {skill:'fishing',method:'fishcook',script:'scripts/fishcook.ts',description:'Lumbridge 3-tick fly fishing + general store fireplace cooking + Draynor bank'},
 {skill:'fishing',method:'village',script:'scripts/microbot-village-fishing.ts',description:'Barbarian Village fly/bait fishing with drop/cook/bank modes'},
 {skill:'fishing',method:'staged',script:'scripts/microbot-b-fishing.ts',description:'Staged native fishing across all 10 FISH_PROFILES methods'},
 {skill:'fishing',method:'fly30',script:'scripts/generated/fishing30.ts',description:'Fresh-account fly fishing to level 30'},
 {skill:'fishing',method:'specialist',script:'scripts/fishing-specialist.ts',description:'Fresh-clock specialist Fishing 1 to 99 with tutorial skip, helper trade, and 3-tick net/bait/fly fishing'},
 // Cooking
 {skill:'cooking',method:'food',script:'scripts/cook-food.ts',description:'Cook banked raw fish (lobster/shark/trout/salmon) at Catherby range'},
 {skill:'cooking',method:'stock',script:'scripts/cook-stock.ts',description:'Batch cook banked raw stock with burn/XP reconciliation'},
 {skill:'cooking',method:'wine',script:'scripts/cook-wine.ts',description:'Ferment jugs of wine from grapes and water jugs'},
 {skill:'cooking',method:'mixed-wine',script:'scripts/microbot-wine.ts',description:'Bank-staged wine fermentation with exact ferm/bad-wine reconciliation'},
 {skill:'cooking',method:'batch',script:'scripts/microbot-b-cooking.ts',description:'Staged range/fire cooking batch for any native recipe'},
 {skill:'cooking',method:'ge-cook',script:'scripts/microbot-ge-cooking.ts',description:'GE-restocked cooking batch'},
 {skill:'cooking',method:'specialist',script:'scripts/cooking-specialist.ts',description:'Fresh-clock specialist Cooking 1 to 99 via noted wine fermentation and 4 Fruit Blasts'},
 // Woodcutting
 {skill:'woodcutting',method:'edgeville',script:'scripts/edgeville-woodcut-order.ts',description:'Edgeville tree/oak/yew woodcutting order'},
 {skill:'woodcutting',method:'yews',script:'scripts/gather-yews.ts',description:'Chop and bank yew logs'},
 {skill:'woodcutting',method:'fresh45',script:'scripts/generated/woodcutting.ts',description:'Fresh account to Woodcutting 45 with the knife reset (axe from Bob, trees then willows)'},
 {skill:'woodcutting',method:'loop',script:'scripts/wc-loop.ts',description:'Continuous woodcutting loop'},
 {skill:'woodcutting',method:'specialist',script:'scripts/woodcutting-specialist.ts',description:'Fresh-clock specialist Woodcutting 1 to 99 with 2-tick goblin flinch / 3-tick knife-reset Oaks'},
 // Firemaking
 {skill:'firemaking',method:'order',script:'scripts/firemaking-order.ts',description:'Line firemaking order from banked logs (normal/oak/willow/maple/yew/magic)'},
 {skill:'firemaking',method:'line',script:'scripts/firemaking-line.ts',description:'Train a runner on a firemaking line supplied by named owned helper accounts'},
 {skill:'firemaking',method:'ge',script:'scripts/microbot-ge-firemaking.ts',description:'GE-supplied firemaking batch'},
 {skill:'firemaking',method:'specialist',script:'scripts/firemaking-specialist.ts',description:'Fresh-clock specialist Firemaking 1 to 99 lighting pre-dropped Lumbridge ground log lines'},
 // Fletching
 {skill:'fletching',method:'arrows',script:'scripts/fletch-arrows.ts',description:'Fletch shafts, headless arrows, and tipped arrows (bronze..rune)'},
 {skill:'fletching',method:'shafts',script:'scripts/fletch-arrows.ts',defaultEnv:{MODE:'shafts'},description:'Fletch arrow shafts from banked logs'},
 {skill:'fletching',method:'worker',script:'scripts/fletch-worker.ts',description:'Fletch unstrung/strung shortbows and longbows from banked logs'},
 {skill:'fletching',method:'specialist',script:'scripts/fletching-specialist.ts',description:'Fresh-clock specialist Fletching 1 to 99 with tutorial skip, helper trade, and 5-action/tick arrow fletching'},
 // Mining
 {skill:'mining',method:'ore',script:'scripts/gather-ore.ts',description:'Mine and bank copper/tin/iron/coal/gold/mithril/adamant'},
 {skill:'mining',method:'essence',script:'scripts/gather-essence.ts',description:'Mine and bank Rune essence at Varrock/Aubury'},
 {skill:'mining',method:'at-site',script:'scripts/microbot-b-mining.ts',description:'Staged at-site rock mining across all native rock profiles'},
 {skill:'mining',method:'drop',script:'scripts/microbot-mining-drop.ts',description:'Power-mine and drop ore'},
 {skill:'mining',method:'progressive',script:'scripts/microbot-mining-progressive.ts',description:'Progressive level-unlocked mining'},
 {skill:'mining',method:'loot',script:'scripts/microbot-b-mining-loot.ts',description:'Mine and bank with gem/loot retention'},
 {skill:'mining',method:'lava-maze',script:'scripts/lava-maze-escorted-ore.ts',description:'Wilderness Lava Maze runite ore mining'},
 {skill:'mining',method:'specialist',script:'scripts/mining-specialist.ts',description:'Fresh-clock specialist Mining 1 to 99 via Doric Quest and 3-tick Ardougne Zoo iron rotation'},
 // Smithing
 {skill:'smithing',method:'smelt',script:'scripts/smelt-bars.ts',description:'Smelt bronze/iron/steel/gold/mithril/adamant/runite bars at furnace'},
 {skill:'smithing',method:'anvil',script:'scripts/smelt-bars.ts',defaultEnv:{ORDER_ACTION:'smith'},description:'Smith bars on the anvil: PRODUCT_ID, MAX_MAKE and BAR_RESERVE name the order'},
 {skill:'smithing',method:'cannonballs',script:'scripts/microbot-a-cannonballs.ts',description:'Smelt steel bars into cannonballs'},
 {skill:'smithing',method:'specialist',script:'scripts/smithing-specialist.ts',description:'Fresh-clock 1-to-99 Smithing via Glory Edgeville and Varrock West anvil runners'},
 // Crafting
 {skill:'crafting',method:'bowstrings',script:'scripts/spin-bowstrings.ts',description:'Spin flax into bowstrings at Seers/Lumbridge wheel'},
 {skill:'crafting',method:'jewellery',script:'scripts/microbot-b-jewellery.ts',description:'Craft rings, necklaces, and amulets at furnace'},
 {skill:'crafting',method:'jewellery-trip',script:'scripts/microbot-jewellery-trip.ts',description:'Full bank-to-furnace jewellery crafting trip'},
 {skill:'crafting',method:'legacy-jewelry',script:'scripts/craft-jewelry.ts',description:'Gem cutting at the Al Kharid bank (action cut). The smelt action does not end (bench case extra:same-jewel-legacy): use jewellery-trip for furnace jewellery'},
 {skill:'crafting',method:'glass',script:'scripts/microbot-glass.ts',description:'Smelt soda ash + sand into molten glass and blow glass items'},
 {skill:'crafting',method:'tanning',script:'scripts/microbot-c-tanner.ts',description:'Tan cowhide and dragonhides at Al Kharid tanner'},
 {skill:'crafting',method:'black-dhide-sets',script:'scripts/black-dhide-sets.ts',description:'Tan banked black dragonhide at Al Kharid and craft body, chaps and vambraces sets at the bank'},
 {skill:'crafting',method:'soften-clay',script:'scripts/soften-clay.ts',description:'Soften clay with water sources'},
 {skill:'crafting',method:'inventory',script:'scripts/microbot-production.ts',description:'Bank-staged inventory crafting (leather, gems, battle staves, pottery)'},
 {skill:'crafting',method:'progressive',script:'scripts/microbot-production-progressive.ts',description:'Progressive level-unlocked inventory crafting'},
 {skill:'crafting',method:'specialist',script:'scripts/crafting-specialist.ts',description:'Fresh-clock 1-to-99 Crafting via 5-per-tick unnoted gem cutting'},
 // Herblore
 {skill:'herblore',method:'potions',script:'scripts/brew-potions.ts',description:'Clean herbs, make unfinished potions, and brew finished potions'},
 {skill:'herblore',method:'meats',script:'scripts/druid-meats.ts',description:'Gather/prepare meats for Druidic Ritual Herblore unlock'},
 {skill:'herblore',method:'specialist',script:'scripts/herblore-specialist.ts',description:'Fresh-clock 1-to-99 Herblore via Games necklace Druidic Ritual and Edgeville 10-potion bank cycles'},
 // Runecraft
 {skill:'runecraft',method:'bank-craft',script:'scripts/rune-bank-craft.ts',description:'Craft banked essence at best unlocked altar (air/mind/water/earth/fire/body/cosmic)'},
 {skill:'runecraft',method:'nature',script:'scripts/microbot-rune-trip.ts',description:'Shilo Village Nature altar runecrafting trips'},
 {skill:'runecraft',method:'supply',script:'scripts/rune-supply.ts',description:'Full fresh-account Rune Mysteries + essence + air runecraft chain'},
 {skill:'runecraft',method:'air',script:'scripts/generated/rcair.ts',description:'Direct Air altar runecrafting'},
 {skill:'runecraft',method:'specialist',script:'scripts/runecraft-specialist.ts',description:'Fresh-clock 1-to-99 Runecraft via Air altar unlock and Body altar essence runners'},
 // Magic
 {skill:'magic',method:'order',script:'scripts/magic-order.ts',description:'Combat/curse/bolt magic training order'},
 {skill:'magic',method:'items',script:'scripts/microbot-magic-items.ts',description:'High/Low Alchemy, Superheat Item, and Jewellery Enchanting'},
 {skill:'magic',method:'npc',script:'scripts/microbot-magic-npc.ts',description:'Curse/Weakening/Strike/Bolt/Blast spell casting on NPCs'},
 {skill:'magic',method:'teleport',script:'scripts/microbot-magic-teleport.ts',description:'Repeated teleport spell training'},
 {skill:'magic',method:'trip',script:'scripts/microbot-magic-trip.ts',description:'Bank-staged magic training trip'},
 {skill:'magic',method:'orbs',script:'scripts/microbot-c-orbs.ts',defaultEnv:{ORB_TRIP:'1'},description:'Bank trip to an obelisk to charge air/earth/water/fire orbs'},
 {skill:'magic',method:'orbs-at-site',script:'scripts/microbot-c-orbs.ts',description:'At-obelisk orb charging batch'},
 {skill:'magic',method:'bones',script:'scripts/microbot-bones.ts',description:'Bones to Bananas conversion'},
 {skill:'magic',method:'earth-production',script:'scripts/earth-production.ts',description:'Earth rune production for magic/superheat'},
 {skill:'magic',method:'alch-train',script:'scripts/alch-train.ts',description:'Alchemy on a cheap stackable item at the Ardougne north bank: Low Alchemy to Magic 55, then High Alchemy to the target level'},
 {skill:'magic',method:'splash',script:'scripts/splash-train.ts',description:'Curse casts over the fence of the Ardougne cow field to the target Magic level'},
 {skill:'magic',method:'splash-coop',script:'scripts/splash-train.ts',defaultEnv:{SPLASH_SITE:'coop'},description:'The record route opening: Wind Strike and Confuse from the starter pack at the Lumbridge coop, no bank'},
 {skill:'magic',method:'specialist',script:'scripts/magic-specialist.ts',description:'Fresh-clock 1-to-99 Magic via enchant ladder, Mage Arena, and 5-per-tick Charge'},
 // Prayer
 {skill:'prayer',method:'bury',script:'scripts/train-prayer.ts',description:'Bury bones / big bones / dragon bones to target Prayer level'},
 {skill:'prayer',method:'flick',script:'scripts/microbot-prayer-flick.ts',description:'1-tick prayer flicking upkeep'},
 {skill:'prayer',method:'specialist',script:'scripts/prayer-specialist.ts',description:'Fresh-clock 1-to-99 Prayer via Draynor Bank dragon-bone runners and Lumbridge burying'},
 // Agility
 {skill:'agility',method:'order',script:'scripts/agility-order.ts',description:'Gnome Stronghold / Barbarian / Wilderness agility course order'},
 {skill:'agility',method:'specialist',script:'scripts/agility-specialist.ts',description:'Fresh-clock 1 to 99 Agility specialist route (Tourist Trap + boosted Wilderness course)'},
 // Thieving
 {skill:'thieving',method:'knights',script:'scripts/goldfarm.ts',description:'Pickpocket Knights of Ardougne with bank food refill and Baker stall fallback'},
 {skill:'thieving',method:'knights-stable',script:'scripts/goldfarm-stable.ts',description:'Bounded Ardougne knight pickpocketing batch'},
 {skill:'thieving',method:'stun-base',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with no action inside a stun (MODE=base)'},
 {skill:'thieving',method:'stun-bury',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with a bone buried inside each stun (MODE=bury)'},
 {skill:'thieving',method:'stun-enchant',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with an enchant cast inside each stun (MODE=enchant)'},
 // Superheat Smithing 1-41 during Ardougne knight stuns: Magic 43+ casts superheat:bronze (1-15, 12 casts) and
 // superheat:iron (15-41, 45 casts) via scripts/microbot-magic-items.ts + fire staff during 8-tick stuns.
 {skill:'thieving',method:'bootstrap55',script:'scripts/generated/thieving60.ts',description:'Fresh-account Men -> Cake stall -> Guards -> Knights to 55/60 Thieving'},
 {skill:'thieving',method:'pickpocket',script:'scripts/microbot-pickpocket-trip.ts',description:'Bank-staged pickpocket trip for any native NPC profile'},
 {skill:'thieving',method:'pickpocket-at-site',script:'scripts/microbot-a-pickpocket.ts',description:'At-site NPC pickpocketing'},
 {skill:'thieving',method:'stalls',script:'scripts/microbot-c-stalls.ts',description:'Steal from Baker/Silk/Fur/Silver/Spice/Gem stalls'},
 {skill:'thieving',method:'blood-chest',script:'scripts/blood-chest.ts',description:'Chaos Druid Tower blood rune chest thieving'},
 {skill:'thieving',method:'nature-chest',script:'scripts/microbot-b-nature-chest.ts',description:'East Ardougne nature rune chest thieving'},
 {skill:'thieving',method:'specialist',script:'scripts/thieving-specialist.ts',description:'Fresh-clock specialist Thieving 1 to 99 prototype using relog-on-stun at East Ardougne'},
 // Foraging / Gathering / Care
 {skill:'foraging',method:'flax',script:'scripts/gather-flax.ts',description:'Pick and bank flax at Seers Village'},
 {skill:'foraging',method:'wool',script:'scripts/collect-wool.ts',description:'Shear sheep and spin wool at Lumbridge'},
 {skill:'foraging',method:'feathers',script:'scripts/gather-feathers.ts',description:'Collect feathers at chicken pens'},
 {skill:'foraging',method:'spawn',script:'scripts/gather-spawn.ts',description:'Collect ground spawns and bank'},
 {skill:'foraging',method:'grapes',script:'scripts/grapes.ts',description:'Collect grapes for wine making'},
 {skill:'foraging',method:'care',script:'scripts/microbot-c-care.ts',description:'Kitten care (feed/wool/stroke), Miscellania weeding, and Druid pouch filling'},
 {skill:'foraging',method:'miscellania-coffer',script:'scripts/microbot-misc-coffer.ts',description:'Manage Kingdom of Miscellania coffer and approval'},
 {skill:'foraging',method:'qol',script:'scripts/microbot-c-qol.ts',description:'Auto Cannon refill, prayer hold, special bar enable, and inventory drop patterns'},
 {skill:'foraging',method:'crystal-chest',script:'scripts/crystal-chest.ts',description:'Combine key halves and open Taverley crystal chests from Falador West Bank for uncut dragonstones'},
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
   step: { script: 'scripts/microbot-magic-items.ts', args: ['superheat:bronze', '-', '12', String(cap)], env: {} },
  });
 }
 if (currentSmithing < 41) {
  bands.push({
   fromSmithing: Math.max(currentSmithing, 15), toSmithing: 41, metal: 'iron', casts: 45,
   step: { script: 'scripts/microbot-magic-items.ts', args: ['superheat:iron', '-', '45', String(cap)], env: {} },
  });
 }
 return bands;
}

export { planBankTripSchedule };

export function resolveSkillerStep(skillInput: string, methodInput?: string, rest: readonly string[] = []): Step {
 const skill = skillInput.toLowerCase().replace(/^--skill=/, '');
 if(skill==='bank-job'){
  const jobs=[...methodInput?[methodInput]:[],...rest];
  if(!jobs.length)throw Error('aio-skiller bank-job requires <job.json>');
  return{script:'scripts/aio-skiller.ts',args:['bank-job',...jobs],env:{}};
 }
 const {method,args:extra} = resolveSkillerMethod(skill, methodInput, rest);
 const route = SKILLER_ROUTES.find(r => r.skill === skill && r.method === method)
  ?? SKILLER_ROUTES.find(r => r.skill === skill && r.script.endsWith(`${method}.ts`));
 if (!route) {
  const known = SKILLER_ROUTES.filter(r => r.skill === skill).map(r => r.method);
  throw Error(known.length ? `aio-skiller: unknown ${skill} method "${method}"; known: ${known.join(', ')}` : `aio-skiller: unknown skill "${skill}"; known: ${Object.keys(DEFAULT_METHOD).join(', ')}`);
 }
 return resolveRouteStep(route, extra);
}

export async function runAioSkiller(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-skiller requires account');
 const [first, second, ...rest] = args;
 if (!first) throw Error('aio-skiller requires <skill|bank-job>');
 if (first === 'bank-job') {
  if (!second) throw Error('aio-skiller bank-job requires <job.json>');
  // Several job files run in one login, in order, and stop at the first failed job: each login costs board ticks.
  const jobs = [second, ...rest].map(readBankJobArgument);
  let stopped = false;
  const s = await openBot(account, { onStop: async () => { stopped = true; } });
  let ok = false, summary = '';
  try {
   const results: Awaited<ReturnType<typeof runBankJob>>[] = [];
   for (const job of jobs) {
    const res = await runBankJob(s, job, () => stopped || existsSync(join('.practice', `stop-${account}`)));
    results.push(res);
    if (!res.ok) break;
   }
   ok = results.length === jobs.length && results.every(r => r.ok);
   summary = jobs.length === 1 ? JSON.stringify(results[0]) : JSON.stringify({ ok, jobs: results });
  } finally {
   await finish([s], ok, summary || 'aio-skiller bank-job');
  }
  const result = `RESULT ${ok ? 'ok' : 'fail'} ${summary}`;
  console.log(result);
  return result;
 }
 const step = resolveSkillerStep(first, second, rest);
 return runDirectChild([step.script, account, ...step.args], { ...env, ...step.env });
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
