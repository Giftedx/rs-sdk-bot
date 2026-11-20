// Fresh-account 1-to-99 Herblore specialist via Games necklace Druidic Ritual and 5-per-tick Kaqemeex brewing.
import type { Session } from '../packages/core/src/inprocess';
import { levelForXp } from '../packages/planner/src/curve';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 findLocBy,
 goalXp,
 ITEM_IDS,
 navigateWorld,
 nearTile,
 parseSpecialistArgs,
 playerPos,
 rubJewelryTeleport,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const KAQEMEEX_SPOT = { x: 2925, z: 3486, level: 0 } as const;
export const SANFEW_HOUSE = { x: 2899, z: 3428, level: 0 } as const;
export const TAVERLEY_DUNGEON_ENTRY = { x: 2884, z: 3397, level: 0 } as const;
export const TAVERLEY_LADDER_UP = { x: 2884, z: 9797, level: 0 } as const;
export const CAULDRON_OUTSIDE = { x: 2888, z: 9831, level: 0 } as const;
export const CAULDRON_LOC_ID = 2142;

export interface HerbPotionRecipe {
 name: string;
 level: number;
 xp: number;
 unf: number;
 sec: number;
}

export const HERB_POTION_TIERS: readonly HerbPotionRecipe[] = [
 { name: 'Energy', level: 26, xp: 1687.5, unf: ITEM_IDS.harralandervial, sec: ITEM_IDS.chocolate_dust },
 { name: 'Super attack', level: 45, xp: 2500, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.eye_of_newt },
 { name: 'Super antipoison', level: 48, xp: 2657.5, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.unicorn_horn_dust },
 { name: 'Fishing', level: 50, xp: 2812.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.snape_grass },
 { name: 'Super energy', level: 52, xp: 2937.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.mortmyremushroom },
 { name: 'Super strength', level: 55, xp: 3125, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.limpwurt_root },
 { name: 'Weapon poison', level: 60, xp: 3437.5, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.dragon_scale_dust },
 { name: 'Super restore', level: 63, xp: 3562.5, unf: ITEM_IDS.snapdragonvial, sec: ITEM_IDS.red_spiders_eggs },
 { name: 'Super defence', level: 66, xp: 3750, unf: ITEM_IDS.cadantinevial, sec: ITEM_IDS.white_berries },
 { name: 'Antifire', level: 69, xp: 3937.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.dragon_scale_dust },
 { name: 'Ranging', level: 72, xp: 4062.5, unf: ITEM_IDS.dwarfweedvial, sec: ITEM_IDS.wine_of_zamorak },
 { name: 'Magic', level: 76, xp: 4312.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.cactus_potato },
 { name: 'Zamorak', level: 78, xp: 4375, unf: ITEM_IDS.torstolvial, sec: ITEM_IDS.jangerberries },
];

export interface HerbloreBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const HERBLORE_STARTER_BATCH: HerbloreBatchPlan = {
 give: [
  { id: ITEM_IDS.necklace_of_minigames_8, count: 1 },
  { id: ITEM_IDS.raw_beef, count: 1 },
  { id: ITEM_IDS.raw_rat_meat, count: 1 },
  { id: ITEM_IDS.raw_bear_meat, count: 1 },
  { id: ITEM_IDS.raw_chicken, count: 1 },
  { id: ITEM_IDS.shark, count: 2 },
  { id: ITEM_IDS.harralandervial, count: 10 },
  { id: ITEM_IDS.chocolate_dust, count: 10 },
 ],
 returnIds: [],
};

export const HERBLORE_KAQEMEEX_BATCHES: readonly HerbloreBatchPlan[] = [
 {
  give: [
   { id: ITEM_IDS.iritvial, count: 4 },
   { id: ITEM_IDS.eye_of_newt, count: 3 },
   { id: ITEM_IDS.unicorn_horn_dust, count: 1 },
   { id: ITEM_IDS.avantoevial, count: 5 },
   { id: ITEM_IDS.snape_grass, count: 2 },
   { id: ITEM_IDS.mortmyremushroom, count: 3 },
   { id: ITEM_IDS.kwuarmvial, count: 5 },
   { id: ITEM_IDS.limpwurt_root, count: 5 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.kwuarmvial, count: 6 },
   { id: ITEM_IDS.limpwurt_root, count: 1 },
   { id: ITEM_IDS.dragon_scale_dust, count: 5 },
   { id: ITEM_IDS.snapdragonvial, count: 5 },
   { id: ITEM_IDS.red_spiders_eggs, count: 5 },
   { id: ITEM_IDS.cadantinevial, count: 3 },
   { id: ITEM_IDS.white_berries, count: 3 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.cadantinevial, count: 4 },
   { id: ITEM_IDS.white_berries, count: 4 },
   { id: ITEM_IDS.lantadymevial, count: 7 },
   { id: ITEM_IDS.dragon_scale_dust, count: 7 },
   { id: ITEM_IDS.dwarfweedvial, count: 3 },
   { id: ITEM_IDS.wine_of_zamorak, count: 3 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.dwarfweedvial, count: 9 },
   { id: ITEM_IDS.wine_of_zamorak, count: 9 },
   { id: ITEM_IDS.lantadymevial, count: 5 },
   { id: ITEM_IDS.cactus_potato, count: 5 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.lantadymevial, count: 2 },
   { id: ITEM_IDS.cactus_potato, count: 2 },
   { id: ITEM_IDS.torstolvial, count: 12 },
   { id: ITEM_IDS.jangerberries, count: 12 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.torstolvial, count: 14 },
   { id: ITEM_IDS.jangerberries, count: 14 },
  ],
  returnIds: [],
 },
 ...Array.from({ length: 10 }, (): HerbloreBatchPlan => ({
  give: [
   { id: ITEM_IDS.torstolvial, count: 14 },
   { id: ITEM_IDS.jangerberries, count: 14 },
  ],
  returnIds: [ITEM_IDS.zamorak_brew_3],
 })),
 {
  give: [
   { id: ITEM_IDS.torstolvial, count: 12 },
   { id: ITEM_IDS.jangerberries, count: 12 },
  ],
  returnIds: [ITEM_IDS.zamorak_brew_3],
 },
];

export const HERBLORE_SUPPLY_BILL: readonly SupplyEntry[] = aggregateHerbloreSupply();

function aggregateHerbloreSupply(): SupplyEntry[] {
 const counts = new Map<number, number>();
 for (const batch of [HERBLORE_STARTER_BATCH, ...HERBLORE_KAQEMEEX_BATCHES]) {
  for (const item of batch.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 }
 const names = new Map<number, string>([
  [ITEM_IDS.necklace_of_minigames_8, 'Games necklace(8)'],
  [ITEM_IDS.raw_beef, 'Raw beef'],
  [ITEM_IDS.raw_rat_meat, 'Raw rat meat'],
  [ITEM_IDS.raw_bear_meat, 'Raw bear meat'],
  [ITEM_IDS.raw_chicken, 'Raw chicken'],
  [ITEM_IDS.shark, 'Shark'],
  [ITEM_IDS.harralandervial, 'Harralander potion (unf)'],
  [ITEM_IDS.chocolate_dust, 'Chocolate dust'],
  [ITEM_IDS.iritvial, 'Irit potion (unf)'],
  [ITEM_IDS.eye_of_newt, 'Eye of newt'],
  [ITEM_IDS.unicorn_horn_dust, 'Unicorn horn dust'],
  [ITEM_IDS.avantoevial, 'Avantoe potion (unf)'],
  [ITEM_IDS.snape_grass, 'Snape grass'],
  [ITEM_IDS.mortmyremushroom, 'Mort myre fungi'],
  [ITEM_IDS.kwuarmvial, 'Kwuarm potion (unf)'],
  [ITEM_IDS.limpwurt_root, 'Limpwurt root'],
  [ITEM_IDS.dragon_scale_dust, 'Dragon scale dust'],
  [ITEM_IDS.snapdragonvial, 'Snapdragon potion (unf)'],
  [ITEM_IDS.red_spiders_eggs, "Red spiders' eggs"],
  [ITEM_IDS.cadantinevial, 'Cadantine potion (unf)'],
  [ITEM_IDS.white_berries, 'White berries'],
  [ITEM_IDS.lantadymevial, 'Lantadyme potion (unf)'],
  [ITEM_IDS.dwarfweedvial, 'Dwarf weed potion (unf)'],
  [ITEM_IDS.wine_of_zamorak, 'Wine of zamorak'],
  [ITEM_IDS.cactus_potato, 'Potato cactus'],
  [ITEM_IDS.torstolvial, 'Torstol potion (unf)'],
  [ITEM_IDS.jangerberries, 'Jangerberries'],
 ]);
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: names.get(itemId) ?? `Item ${itemId}`,
  count,
 }));
}

async function eatIfLow(s: Session): Promise<void> {
 const hp = s.sdk.getSkill('Hitpoints')?.level ?? 10;
 if (hp <= 6) {
  const food = s.sdk.getInventory().find(i => i.id === ITEM_IDS.shark);
  if (food) await s.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
 }
}

async function talkScripted(
 s: Session,
 npcName: RegExp,
 choices: readonly RegExp[],
 done: () => boolean,
 deadline: number,
): Promise<void> {
 while (s.tick() < deadline) {
  if (done()) return;
  await eatIfLow(s);
  const d = s.sdk.getDialog();
  if (d?.isOpen) {
   if (d.isWaiting) {
    await waitTicks(s, 1);
    continue;
   }
   const match = d.options.find((o: any) => choices.some(re => re.test(o.text)));
   const opt = match ?? d.options[0];
   await s.direct({ type: 'clickDialogOption', optionIndex: opt?.index ?? 0, reason: 'SDK' });
   await waitTicks(s, 1);
   continue;
  }
  const npc = s.sdk.findNearbyNpc(npcName);
  if (npc) {
   await s.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(s, 1);
 }
 throw Error(`dialog with ${npcName.source} exceeded cap`);
}

async function climbStairOption(s: Session, locRe: RegExp, optRe: RegExp, targetLevel: number, deadline: number): Promise<void> {
 while (s.tick() < deadline) {
  if (playerPos(s)?.level === targetLevel) return;
  const loc = s.sdk.findNearbyLoc(locRe);
  if (loc) {
   const op = loc.optionsWithIndex?.find((o: any) => optRe.test(o.text))?.opIndex ?? 1;
   await s.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: op, reason: 'SDK' });
  }
  await waitTicks(s, 1);
 }
 throw Error(`climbStairOption ${locRe.source} exceeded cap`);
}

async function completeDruidicRitualFast(spec: Session, deadline: number): Promise<void> {
 // Rub Games necklace(8) -> Burthorpe Games Rooms -> climb upstairs to Burthorpe.
 await rubJewelryTeleport(
  spec,
  ITEM_IDS.necklace_of_minigames_8,
  /burthorpe/i,
  () => (playerPos(spec)?.worldZ ?? 0) > 4500,
  deadline,
 );

 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (p && p.level === 0 && p.worldZ < 4000) break;
  const stair = spec.sdk.findNearbyLoc(/stair/i);
  if (stair) {
   const op = stair.optionsWithIndex?.find((o: any) => /climb/i.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: stair.x, z: stair.z, locId: stair.id, optionIndex: op, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // 1. Kaqemeex
 await navigateWorld(spec, KAQEMEEX_SPOT.x, KAQEMEEX_SPOT.z, 0, Math.max(10, deadline - spec.tick()));
 let sawKaqemeex = false;
 await talkScripted(
  spec,
  /^kaqemeex$/i,
  [/search of a quest/i, /try and help/i],
  () => {
   if (spec.sdk.getDialog()?.isOpen) sawKaqemeex = true;
   return sawKaqemeex && !spec.sdk.getDialog()?.isOpen;
  },
  deadline,
 );

 // 2. Sanfew upstairs
 await navigateWorld(spec, SANFEW_HOUSE.x, SANFEW_HOUSE.z, 0, Math.max(10, deadline - spec.tick()));
 await climbStairOption(spec, /stair/i, /climb-up/i, 1, deadline);
 let sawSanfew = false;
 await talkScripted(
  spec,
  /^sanfew$/i,
  [/purify.*stone circle/i, /do that then/i],
  () => {
   if (spec.sdk.getDialog()?.isOpen) sawSanfew = true;
   return sawSanfew && !spec.sdk.getDialog()?.isOpen;
  },
  deadline,
 );
 await climbStairOption(spec, /stair/i, /climb-down/i, 0, deadline);

 // 3. Taverley Dungeon -> Cauldron of Thunder (dip all 4 meats in 1 tick)
 await navigateWorld(spec, TAVERLEY_DUNGEON_ENTRY.x, TAVERLEY_DUNGEON_ENTRY.z, 0, Math.max(10, deadline - spec.tick()));
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) < 6000) {
  const ladder = findLocBy(spec, l => l.id === 1759 || /ladder/i.test(l.name));
  if (ladder) await spec.direct({ type: 'interactLoc', x: ladder.x, z: ladder.z, locId: ladder.id, optionIndex: 1, reason: 'SDK' });
  await waitTicks(spec, 1);
 }

 await navigateWorld(spec, CAULDRON_OUTSIDE.x, CAULDRON_OUTSIDE.z, 0, Math.max(10, deadline - spec.tick()));
 while (spec.tick() < deadline && (playerPos(spec)?.worldX ?? 0) < 2890) {
  await eatIfLow(spec);
  const door = findLocBy(spec, l => l.id === 2143 || l.id === 2144);
  if (door) await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: 1, reason: 'SDK' });
  await spec.direct({ type: 'walkTo', x: 2892, z: 9831, running: true, reason: 'SDK' });
  await waitTicks(spec, 1);
 }

 const rawIds: number[] = [ITEM_IDS.raw_beef, ITEM_IDS.raw_rat_meat, ITEM_IDS.raw_bear_meat, ITEM_IDS.raw_chicken];
 while (spec.tick() < deadline) {
  await eatIfLow(spec);
  const remaining = spec.sdk.getInventory().filter(i => rawIds.includes(i.id));
  if (!remaining.length) break;
  const cauldron = findLocBy(spec, l => l.id === CAULDRON_LOC_ID);
  if (cauldron) {
   await Promise.all(
    remaining.slice(0, 4).map(item =>
     spec.direct({ type: 'useItemOnLoc', itemSlot: item.slot, x: cauldron.x, z: cauldron.z, locId: cauldron.id, reason: 'SDK' }),
    ),
   );
  }
  await waitTicks(spec, 1);
 }

 // Exit cauldron room & dungeon
 while (spec.tick() < deadline && (playerPos(spec)?.worldX ?? 9999) >= 2889) {
  await eatIfLow(spec);
  const door = findLocBy(spec, l => l.id === 2143 || l.id === 2144);
  if (door) await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: 1, reason: 'SDK' });
  await spec.direct({ type: 'walkTo', x: 2887, z: 9831, running: true, reason: 'SDK' });
  await waitTicks(spec, 1);
 }
 await navigateWorld(spec, TAVERLEY_LADDER_UP.x, TAVERLEY_LADDER_UP.z, 0, Math.max(10, deadline - spec.tick()));
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) > 6000) {
  const ladder = spec.sdk.findNearbyLoc(/ladder/i);
  if (ladder) await spec.direct({ type: 'interactLoc', x: ladder.x, z: ladder.z, locId: ladder.id, optionIndex: 1, reason: 'SDK' });
  await waitTicks(spec, 1);
 }

 // 4. Sanfew turn-in -> Kaqemeex completion
 await navigateWorld(spec, SANFEW_HOUSE.x, SANFEW_HOUSE.z, 0, Math.max(10, deadline - spec.tick()));
 await climbStairOption(spec, /stair/i, /climb-up/i, 1, deadline);
 await talkScripted(
  spec,
  /^sanfew$/i,
  [/continue/i],
  () => {
   const inv = spec.sdk.getInventory();
   return ![522, 523, 524, 525].some(id => countItem(inv, id) > 0) && !spec.sdk.getDialog()?.isOpen;
  },
  deadline,
 );
 await climbStairOption(spec, /stair/i, /climb-down/i, 0, deadline);

 await navigateWorld(spec, KAQEMEEX_SPOT.x, KAQEMEEX_SPOT.z, 0, Math.max(10, deadline - spec.tick()));
 while (spec.tick() < deadline && skillXp(spec, 'Herblore') < 6250) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
  } else {
   const kaq = spec.sdk.findNearbyNpc(/^kaqemeex$/i);
   if (kaq) await spec.direct({ type: 'interactNpc', npcIndex: kaq.index, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 // Close fundamentals dialog if open.
 if (spec.sdk.getState()?.dialog?.isOpen) await spec.direct({ type: 'closeModal', reason: 'SDK' });
}

async function mixUnlockedPotions(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Herblore') >= target) return;
  const inv = spec.sdk.getInventory();
  let simXp = skillXp(spec, 'Herblore');
  const usedSlots = new Set<number>();
  const pairs: { unfSlot: number; secSlot: number }[] = [];
  const modalOpen = !!spec.sdk.getState()?.dialog?.isOpen && !spec.sdk.getState()?.trade?.isOpen;
  const maxActions = modalOpen ? 4 : 5;

  for (let i = 0; i < maxActions; i++) {
   const simLvl = levelForXp(simXp);
   let chosen: { recipe: HerbPotionRecipe; unfSlot: number; secSlot: number } | undefined;
   for (let r = HERB_POTION_TIERS.length - 1; r >= 0; r--) {
    const recipe = HERB_POTION_TIERS[r]!;
    if (simLvl < recipe.level) continue;
    const u = inv.find(x => x.id === recipe.unf && !usedSlots.has(x.slot));
    const s = inv.find(x => x.id === recipe.sec && !usedSlots.has(x.slot));
    if (u && s) {
     chosen = { recipe, unfSlot: u.slot, secSlot: s.slot };
     break;
    }
   }
   if (!chosen) break;
   usedSlots.add(chosen.unfSlot);
   usedSlots.add(chosen.secSlot);
   pairs.push({ unfSlot: chosen.unfSlot, secSlot: chosen.secSlot });
   simXp += chosen.recipe.xp;
  }

  if (!pairs.length) return;
  const acts: Promise<unknown>[] = [];
  if (modalOpen) acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  for (const p of pairs) {
   acts.push(spec.direct({ type: 'useItemOnItem', sourceSlot: p.unfSlot, targetSlot: p.secSlot, reason: 'SDK' }));
  }
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 throw Error('herblore brewing exceeded cap');
}

export async function runHerbloreSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(HERBLORE_SUPPLY_BILL);
 const neededHelpers = 1 + HERBLORE_KAQEMEEX_BATCHES.length;
 if (helpers.length < neededHelpers) {
  throw Error(`herblore specialist requires ${neededHelpers} helpers, got ${helpers.length}`);
 }
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 let done = false;
 const keepers = helpers.map(h =>
  (async () => {
   while (!done && h.tick() < deadline) await waitTicks(h, 1);
  })(),
 );

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  await burstTradeHost(spec, helpers[0]!, {
   giveIds: HERBLORE_STARTER_BATCH.give.map(g => g.id),
   deadlineTick: deadline,
  });

  await completeDruidicRitualFast(spec, deadline);

  // Mix 10 Energy potions (Lv 28 -> 45), then drop starter remnants before Kaqemeex batch 1.
  await mixUnlockedPotions(spec, target, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  for (let i = 0; i < HERBLORE_KAQEMEEX_BATCHES.length && skillLevel(spec, 'Herblore') < target; i++) {
   const batch = HERBLORE_KAQEMEEX_BATCHES[i]!;
   const helper = helpers[1 + i]!;
   if (batch.returnIds.length === 0 && i > 0) {
    await dropItemsFast(spec, new Set(), deadline);
   }
   await burstTradeHost(spec, helper, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   });
   await mixUnlockedPotions(spec, target, deadline);
  }

  const level = skillLevel(spec, 'Herblore');
  const xp = skillXp(spec, 'Herblore');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=herblore level=${level} xp=${xp} ticks=${ticks}`,
   ticks,
   level,
   xp,
  };
 } finally {
  done = true;
  await Promise.allSettled(keepers);
 }
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 460,
  target: 99,
  defaultHelpers: 1 + HERBLORE_KAQEMEEX_BATCHES.length,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runHerbloreSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
