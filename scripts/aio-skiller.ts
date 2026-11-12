// AIO Skiller ("Vortex All In One"): unified entry for all 15 non-combat skills, bank-profile jobs, and progressive training.
// Usage:
//   bun scripts/aio-skiller.ts <account> <skill> [method] [arg ...] [KEY=value ...]
//   bun scripts/aio-skiller.ts <account> bank-job <job.json>
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {openBot,finish} from '../packages/core/src/bot';
import {runDirectChild} from '../packages/core/src/run-child';
import {parseStep,type Step} from '../packages/core/src/chain-step';
import {xpForLevel} from '../packages/planner/src/curve';
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
 {skill:'fishing',method:'cage',script:'scripts/gather-fish.ts',defaultArgs:['cage','3000'],description:'Catherby lobster cage + bank'},
 {skill:'fishing',method:'harpoon',script:'scripts/gather-fish.ts',defaultArgs:['harpoon','3000'],description:'Catherby tuna/swordfish harpoon + bank'},
 {skill:'fishing',method:'fishcook',script:'scripts/fishcook.ts',description:'Lumbridge 3-tick fly fishing + general store fireplace cooking + Draynor bank'},
 {skill:'fishing',method:'village',script:'scripts/microbot-village-fishing.ts',description:'Barbarian Village fly/bait fishing with drop/cook/bank modes'},
 {skill:'fishing',method:'staged',script:'scripts/microbot-b-fishing.ts',description:'Staged native fishing across all 10 FISH_PROFILES methods'},
 {skill:'fishing',method:'fly30',script:'scripts/generated/fishing30.ts',description:'Fresh-account fly fishing to level 30'},
 // Cooking
 {skill:'cooking',method:'food',script:'scripts/cook-food.ts',description:'Cook banked raw fish (lobster/shark/trout/salmon) at Catherby range'},
 {skill:'cooking',method:'stock',script:'scripts/cook-stock.ts',description:'Batch cook banked raw stock with burn/XP reconciliation'},
 {skill:'cooking',method:'wine',script:'scripts/cook-wine.ts',description:'Ferment jugs of wine from grapes and water jugs'},
 {skill:'cooking',method:'mixed-wine',script:'scripts/microbot-wine.ts',description:'Bank-staged wine fermentation with exact ferm/bad-wine reconciliation'},
 {skill:'cooking',method:'batch',script:'scripts/microbot-b-cooking.ts',description:'Staged range/fire cooking batch for any native recipe'},
 {skill:'cooking',method:'ge-cook',script:'scripts/microbot-ge-cooking.ts',description:'GE-restocked cooking batch'},
 // Woodcutting
 {skill:'woodcutting',method:'edgeville',script:'scripts/edgeville-woodcut-order.ts',description:'Edgeville tree/oak/yew woodcutting order'},
 {skill:'woodcutting',method:'yews',script:'scripts/gather-yews.ts',description:'Chop and bank yew logs'},
 {skill:'woodcutting',method:'fresh45',script:'scripts/generated/woodcutting.ts',description:'Fresh account to Woodcutting 45 with the knife reset (axe from Bob, trees then willows)'},
 {skill:'woodcutting',method:'loop',script:'scripts/wc-loop.ts',description:'Continuous woodcutting loop'},
 // Firemaking
 {skill:'firemaking',method:'order',script:'scripts/firemaking-order.ts',description:'Line firemaking order from banked logs (normal/oak/willow/maple/yew/magic)'},
 {skill:'firemaking',method:'ge',script:'scripts/microbot-ge-firemaking.ts',description:'GE-supplied firemaking batch'},
 // Fletching
 {skill:'fletching',method:'arrows',script:'scripts/fletch-arrows.ts',description:'Fletch shafts, headless arrows, and tipped arrows (bronze..rune)'},
 {skill:'fletching',method:'shafts',script:'scripts/fletch-arrows.ts',defaultEnv:{MODE:'shafts'},description:'Fletch arrow shafts from banked logs'},
 {skill:'fletching',method:'worker',script:'scripts/fletch-worker.ts',description:'Fletch unstrung/strung shortbows and longbows from banked logs'},
 // Mining
 {skill:'mining',method:'ore',script:'scripts/gather-ore.ts',description:'Mine and bank copper/tin/iron/coal/gold/mithril/adamant'},
 {skill:'mining',method:'essence',script:'scripts/gather-essence.ts',description:'Mine and bank Rune essence at Varrock/Aubury'},
 {skill:'mining',method:'at-site',script:'scripts/microbot-b-mining.ts',description:'Staged at-site rock mining across all native rock profiles'},
 {skill:'mining',method:'drop',script:'scripts/microbot-mining-drop.ts',description:'Power-mine and drop ore'},
 {skill:'mining',method:'progressive',script:'scripts/microbot-mining-progressive.ts',description:'Progressive level-unlocked mining'},
 {skill:'mining',method:'loot',script:'scripts/microbot-b-mining-loot.ts',description:'Mine and bank with gem/loot retention'},
 {skill:'mining',method:'lava-maze',script:'scripts/lava-maze-escorted-ore.ts',description:'Wilderness Lava Maze runite ore mining'},
 // Smithing
 {skill:'smithing',method:'smelt',script:'scripts/smelt-bars.ts',description:'Smelt bronze/iron/steel/gold/mithril/adamant/runite bars at furnace'},
 {skill:'smithing',method:'anvil',script:'scripts/smelt-bars.ts',defaultEnv:{ORDER_ACTION:'smith'},description:'Smith bars on the anvil: PRODUCT_ID, MAX_MAKE and BAR_RESERVE name the order'},
 {skill:'smithing',method:'cannonballs',script:'scripts/microbot-a-cannonballs.ts',description:'Smelt steel bars into cannonballs'},
 // Crafting
 {skill:'crafting',method:'bowstrings',script:'scripts/spin-bowstrings.ts',description:'Spin flax into bowstrings at Seers/Lumbridge wheel'},
 {skill:'crafting',method:'jewellery',script:'scripts/microbot-b-jewellery.ts',description:'Craft rings, necklaces, and amulets at furnace'},
 {skill:'crafting',method:'jewellery-trip',script:'scripts/microbot-jewellery-trip.ts',description:'Full bank-to-furnace jewellery crafting trip'},
 {skill:'crafting',method:'legacy-jewelry',script:'scripts/craft-jewelry.ts',description:'Legacy furnace jewelry crafting'},
 {skill:'crafting',method:'glass',script:'scripts/microbot-glass.ts',description:'Smelt soda ash + sand into molten glass and blow glass items'},
 {skill:'crafting',method:'tanning',script:'scripts/microbot-c-tanner.ts',description:'Tan cowhide and dragonhides at Al Kharid tanner'},
 {skill:'crafting',method:'black-dhide-sets',script:'scripts/black-dhide-sets.ts',description:'Tan banked black dragonhide at Al Kharid and craft body, chaps and vambraces sets at the bank'},
 {skill:'crafting',method:'soften-clay',script:'scripts/soften-clay.ts',description:'Soften clay with water sources'},
 {skill:'crafting',method:'inventory',script:'scripts/microbot-production.ts',description:'Bank-staged inventory crafting (leather, gems, battle staves, pottery)'},
 {skill:'crafting',method:'progressive',script:'scripts/microbot-production-progressive.ts',description:'Progressive level-unlocked inventory crafting'},
 // Herblore
 {skill:'herblore',method:'potions',script:'scripts/brew-potions.ts',description:'Clean herbs, make unfinished potions, and brew finished potions'},
 {skill:'herblore',method:'meats',script:'scripts/druid-meats.ts',description:'Gather/prepare meats for Druidic Ritual Herblore unlock'},
 // Runecraft
 {skill:'runecraft',method:'bank-craft',script:'scripts/rune-bank-craft.ts',description:'Craft banked essence at best unlocked F2P altar (air/mind/water/earth/fire/body)'},
 {skill:'runecraft',method:'nature',script:'scripts/microbot-rune-trip.ts',description:'Shilo Village Nature altar runecrafting trips'},
 {skill:'runecraft',method:'supply',script:'scripts/rune-supply.ts',description:'Full fresh-account Rune Mysteries + essence + air runecraft chain'},
 {skill:'runecraft',method:'air',script:'scripts/generated/rcair.ts',description:'Direct Air altar runecrafting'},
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
 // Prayer
 {skill:'prayer',method:'bury',script:'scripts/train-prayer.ts',description:'Bury bones / big bones / dragon bones to target Prayer level'},
 {skill:'prayer',method:'flick',script:'scripts/microbot-prayer-flick.ts',description:'1-tick prayer flicking upkeep'},
 // Agility
 {skill:'agility',method:'order',script:'scripts/agility-order.ts',description:'Gnome Stronghold / Barbarian / Wilderness agility course order'},
 // Thieving
 {skill:'thieving',method:'knights',script:'scripts/goldfarm.ts',description:'Pickpocket Knights of Ardougne with bank food refill and Baker stall fallback'},
 {skill:'thieving',method:'knights-stable',script:'scripts/goldfarm-stable.ts',description:'Bounded Ardougne knight pickpocketing batch'},
 {skill:'thieving',method:'stun-base',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with no action inside a stun (MODE=base)'},
 {skill:'thieving',method:'stun-bury',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with a bone buried inside each stun (MODE=bury)'},
 {skill:'thieving',method:'stun-enchant',script:'scripts/measure/stun-guest.ts',description:'Ardougne knights with an enchant cast inside each stun (MODE=enchant)'},
 {skill:'thieving',method:'bootstrap55',script:'scripts/generated/thieving60.ts',description:'Fresh-account Men -> Cake stall -> Guards -> Knights to 55/60 Thieving'},
 {skill:'thieving',method:'pickpocket',script:'scripts/microbot-pickpocket-trip.ts',description:'Bank-staged pickpocket trip for any native NPC profile'},
 {skill:'thieving',method:'pickpocket-at-site',script:'scripts/microbot-a-pickpocket.ts',description:'At-site NPC pickpocketing'},
 {skill:'thieving',method:'stalls',script:'scripts/microbot-c-stalls.ts',description:'Steal from Baker/Silk/Fur/Silver/Spice/Gem stalls'},
 {skill:'thieving',method:'blood-chest',script:'scripts/blood-chest.ts',description:'Chaos Druid Tower blood rune chest thieving'},
 {skill:'thieving',method:'nature-chest',script:'scripts/microbot-b-nature-chest.ts',description:'East Ardougne nature rune chest thieving'},
 // Foraging / Gathering / Care
 {skill:'foraging',method:'flax',script:'scripts/gather-flax.ts',description:'Pick and bank flax at Seers Village'},
 {skill:'foraging',method:'wool',script:'scripts/collect-wool.ts',description:'Shear sheep and spin wool at Lumbridge'},
 {skill:'foraging',method:'feathers',script:'scripts/gather-feathers.ts',description:'Collect feathers at chicken pens'},
 {skill:'foraging',method:'spawn',script:'scripts/gather-spawn.ts',description:'Collect ground spawns and bank'},
 {skill:'foraging',method:'grapes',script:'scripts/grapes.ts',description:'Collect grapes for wine making'},
 {skill:'foraging',method:'care',script:'scripts/microbot-c-care.ts',description:'Kitten care (feed/wool/stroke), Miscellania weeding, and Druid pouch filling'},
 {skill:'foraging',method:'miscellania-coffer',script:'scripts/microbot-misc-coffer.ts',description:'Manage Kingdom of Miscellania coffer and approval'},
 {skill:'foraging',method:'qol',script:'scripts/microbot-c-qol.ts',description:'Auto Cannon refill, prayer hold, special bar enable, and inventory drop patterns'},
];

const DEFAULT_METHOD: Readonly<Record<string, string>> = {
 fishing: 'shark',
 cooking: 'food',
 woodcutting: 'yews',
 firemaking: 'order',
 fletching: 'arrows',
 mining: 'ore',
 smithing: 'smelt',
 crafting: 'inventory',
 herblore: 'potions',
 runecraft: 'bank-craft',
 magic: 'order',
 prayer: 'bury',
 agility: 'order',
 thieving: 'knights',
 foraging: 'flax',
};

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
}

const PROGRESSIVE_TIERS: Readonly<Record<string, readonly { level: number; method: string; xp: number; args?: readonly string[]; env?: Readonly<Record<string, string>> }[]>> = {
 firemaking: [
  { level: 1, method: 'order', xp: 40, env: { LOG: 'normal' } },
  { level: 15, method: 'order', xp: 60, env: { LOG: 'oak' } },
  { level: 30, method: 'order', xp: 90, env: { LOG: 'willow' } },
  { level: 45, method: 'order', xp: 135, env: { LOG: 'maple' } },
  { level: 60, method: 'order', xp: 202.5, env: { LOG: 'yew' } },
  { level: 75, method: 'order', xp: 303.8, env: { LOG: 'magic' } },
 ],
 woodcutting: [
  { level: 1, method: 'edgeville', xp: 25, env: { LOG: 'normal' } },
  { level: 15, method: 'edgeville', xp: 37.5, env: { LOG: 'oak' } },
  { level: 60, method: 'yews', xp: 175, env: { TREE: 'yew' } },
 ],
 fishing: [
  { level: 1, method: 'fishcook', xp: 10 },
  { level: 20, method: 'fishcook', xp: 60 },
  { level: 40, method: 'cage', xp: 90, args: ['cage', '3000'] },
  { level: 76, method: 'shark', xp: 110 },
 ],
 cooking: [
  { level: 1, method: 'stock', xp: 30, env: { RAW: 'chicken' } },
  { level: 15, method: 'stock', xp: 70, env: { RAW: 'trout' } },
  { level: 35, method: 'wine', xp: 200 },
  { level: 40, method: 'food', xp: 120, args: ['1500', 'lobster'] },
  { level: 80, method: 'food', xp: 210, args: ['1500', 'shark'] },
 ],
 fletching: [
  { level: 1, method: 'arrows', xp: 5, args: ['3000', 'shafts'] },
  { level: 10, method: 'worker', xp: 10 },
  { level: 55, method: 'arrows', xp: 112.5, args: ['3000', 'arrows', 'mithril'] },
  { level: 75, method: 'arrows', xp: 187.5, args: ['3000', 'arrows', 'rune'] },
 ],
 mining: [
  { level: 1, method: 'ore', xp: 17.5, env: { ORE: 'copper' } },
  { level: 15, method: 'ore', xp: 35, env: { ORE: 'iron' } },
  { level: 85, method: 'lava-maze', xp: 125 },
 ],
 smithing: [
  { level: 1, method: 'smelt', xp: 6.2, args: ['3000', 'bronze'] },
  { level: 15, method: 'smelt', xp: 12.5, args: ['3000', 'iron'] },
  { level: 30, method: 'smelt', xp: 17.5, args: ['3000', 'steel'] },
  { level: 40, method: 'smelt', xp: 22.5, args: ['3000', 'gold'] },
 ],
 crafting: [
  { level: 1, method: 'soften-clay', xp: 15 },
  { level: 5, method: 'jewellery', xp: 15 },
  { level: 10, method: 'bowstrings', xp: 15 },
  { level: 46, method: 'glass', xp: 52.5 },
 ],
 herblore: [
  { level: 3, method: 'potions', xp: 25, env: { RECIPE: 'attack' } },
  { level: 38, method: 'potions', xp: 87.5, env: { RECIPE: 'prayer' } },
  { level: 45, method: 'potions', xp: 100, env: { RECIPE: 'super_attack' } },
 ],
 magic: [
  { level: 1, method: 'order', xp: 11.5 },
  { level: 21, method: 'items', xp: 31, env: { SPELL: 'low_alchemy' } },
  { level: 43, method: 'items', xp: 53, env: { SPELL: 'superheat' } },
  { level: 55, method: 'items', xp: 65, env: { SPELL: 'high_alchemy' } },
 ],
 agility: [
  { level: 1, method: 'order', xp: 86.5, args: ['gnome'] },
  { level: 35, method: 'order', xp: 153.2, args: ['barbarian'] },
  { level: 52, method: 'order', xp: 571.4, args: ['wilderness'] },
 ],
 thieving: [
  { level: 1, method: 'bootstrap55', xp: 8 },
  { level: 55, method: 'knights', xp: 84.3 },
 ],
 runecraft: [
  { level: 1, method: 'bank-craft', xp: 5 },
  { level: 44, method: 'nature', xp: 9 },
 ],
 prayer: [
  { level: 1, method: 'bury', xp: 4.5, env: { BONE_ID: '526' } },
  { level: 15, method: 'bury', xp: 15, env: { BONE_ID: '532' } },
 ],
 foraging: [
  { level: 1, method: 'flax', xp: 1 },
 ],
};

// Compute an automatic level-band progression from currentLevel -> targetLevel (accounting for server xpRate, default 25x).
export function planProgressiveSkiller(skillInput: string, currentLevel: number, targetLevel: number, xpRate = 25): ProgressiveBand[] {
 const skill = skillInput.toLowerCase();
 if (!Number.isSafeInteger(currentLevel) || currentLevel < 1 || !Number.isSafeInteger(targetLevel) || targetLevel <= currentLevel || targetLevel > 99 || xpRate <= 0) {
  throw Error('aio-skiller: invalid progressive level bounds');
 }
 const tiers = PROGRESSIVE_TIERS[skill];
 if (!tiers) {
  const step = resolveSkillerStep(skill, undefined, [`TARGET_LEVEL=${targetLevel}`]);
  return [{ skill, method: DEFAULT_METHOD[skill] ?? 'default', fromLevel: currentLevel, toLevel: targetLevel, unlockLevel: 1, xpPerUnit: 25 * xpRate, unitsNeeded: 1, step }];
 }
 const bands: ProgressiveBand[] = [];
 let cursor = currentLevel;
 while (cursor < targetLevel) {
  const active = [...tiers].filter(t => t.level <= cursor).at(-1) ?? tiers[0]!;
  const nextUnlock = tiers.find(t => t.level > cursor && t.level < targetLevel)?.level ?? targetLevel;
  const xpNeeded = Math.max(0, xpForLevel(nextUnlock) - xpForLevel(cursor));
  const effectiveXp = active.xp * xpRate;
  const unitsNeeded = Math.max(1, Math.ceil(xpNeeded / effectiveXp));
  const extra = [
   ...(active.args ?? []),
   ...(skill === 'agility' ? [String(nextUnlock)] : []),
   `TARGET_LEVEL=${nextUnlock}`,
   ...Object.entries(active.env ?? {}).map(([k, v]) => `${k}=${v}`),
  ];
  bands.push({
   skill,
   method: active.method,
   fromLevel: cursor,
   toLevel: nextUnlock,
   unlockLevel: active.level,
   xpPerUnit: effectiveXp,
   unitsNeeded,
   step: resolveSkillerStep(skill, active.method, extra),
  });
  cursor = nextUnlock;
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

export { planBankTripSchedule };

export function resolveSkillerStep(skillInput: string, methodInput?: string, rest: readonly string[] = []): Step {
 const skill = skillInput.toLowerCase().replace(/^--skill=/, '');
 const hasExplicitMethod = methodInput && !methodInput.includes('=') && !/^\d+$/.test(methodInput);
 const method = (hasExplicitMethod ? methodInput.toLowerCase().replace(/^--method=/, '') : DEFAULT_METHOD[skill]) ?? '';
 const extra = hasExplicitMethod ? rest : methodInput ? [methodInput, ...rest] : rest;
 const route = SKILLER_ROUTES.find(r => r.skill === skill && r.method === method)
  ?? SKILLER_ROUTES.find(r => r.skill === skill && r.script.endsWith(`${method}.ts`));
 if (!route) {
  const known = SKILLER_ROUTES.filter(r => r.skill === skill).map(r => r.method);
  throw Error(known.length ? `aio-skiller: unknown ${skill} method "${method}"; known: ${known.join(', ')}` : `aio-skiller: unknown skill "${skill}"; known: ${Object.keys(DEFAULT_METHOD).join(', ')}`);
 }
 const argsTokens = extra.length ? extra : [...(route.defaultArgs ?? [])];
 const step = parseStep([route.script, ...argsTokens].join(' '));
 return { script: step.script, args: step.args, env: { ...(route.defaultEnv ?? {}), ...step.env } };
}

export async function runAioSkiller(account: string, args: readonly string[], env: Record<string, string | undefined> = process.env): Promise<string> {
 if (!account) throw Error('aio-skiller requires account');
 const [first, second, ...rest] = args;
 if (!first) throw Error('aio-skiller requires <skill|bank-job>');
 if (first === 'bank-job') {
  if (!second) throw Error('aio-skiller bank-job requires <job.json>');
  const job = JSON.parse(readFileSync(resolve(second), 'utf8')) as BankJob;
  validateBankJob(job);
  let stopped = false;
  const s = await openBot(account, { onStop: async () => { stopped = true; } });
  let ok = false, summary = '';
  try {
   const res = await runBankJob(s, job, () => stopped || existsSync(join('.practice', `stop-${account}`)));
   ok = res.ok;
   summary = JSON.stringify(res);
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
