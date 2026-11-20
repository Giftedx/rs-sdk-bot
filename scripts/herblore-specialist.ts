// Fresh-account 1-to-99 Herblore specialist at Lumbridge Courtyard via 5-per-tick potion finishing (no Druidic Ritual gate).
import type { Session } from '../packages/core/src/inprocess';
import { levelForXp } from '../packages/planner/src/curve';
import {
 assertCatalogItems,
 burstTradeHost,
 dropItemsFast,
 goalXp,
 ITEM_IDS,
 logPhase,
 parseSpecialistArgs,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export interface HerbPotionRecipe {
 name: string;
 level: number;
 xp: number;
 unf: number;
 sec: number;
}

export const HERB_POTION_TIERS: readonly HerbPotionRecipe[] = [
 { name: 'Attack', level: 1, xp: 625, unf: ITEM_IDS.guamvial, sec: ITEM_IDS.eye_of_newt },
 { name: 'Antipoison', level: 5, xp: 937.5, unf: ITEM_IDS.marrentillvial, sec: ITEM_IDS.unicorn_horn_dust },
 { name: 'Strength', level: 12, xp: 1250, unf: ITEM_IDS.tarrominvial, sec: ITEM_IDS.limpwurt_root },
 { name: 'Energy', level: 26, xp: 1687.5, unf: ITEM_IDS.harralandervial, sec: ITEM_IDS.chocolate_dust },
 { name: 'Prayer', level: 38, xp: 2187.5, unf: ITEM_IDS.ranarrvial, sec: ITEM_IDS.snape_grass },
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

export const HERBLORE_BATCHES: readonly HerbloreBatchPlan[] = [
 // Batch 0 (14 pairs): Attack(1), Antipoison(1), Strength(3), Energy(5), Prayer(4) -> 22,500 XP (Lv 44)
 {
  give: [
   { id: ITEM_IDS.guamvial, count: 1 },
   { id: ITEM_IDS.eye_of_newt, count: 1 },
   { id: ITEM_IDS.marrentillvial, count: 1 },
   { id: ITEM_IDS.unicorn_horn_dust, count: 1 },
   { id: ITEM_IDS.tarrominvial, count: 3 },
   { id: ITEM_IDS.limpwurt_root, count: 3 },
   { id: ITEM_IDS.harralandervial, count: 5 },
   { id: ITEM_IDS.chocolate_dust, count: 5 },
   { id: ITEM_IDS.ranarrvial, count: 4 },
   { id: ITEM_IDS.snape_grass, count: 4 },
  ],
  returnIds: [],
 },
 // Batch 1 (14 pairs): Prayer(1), SupAtk(2), SupAnti(2), Fishing(1), SupEng(3), SupStr(5) -> 62,250 XP (Lv 59)
 {
  give: [
   { id: ITEM_IDS.ranarrvial, count: 1 },
   { id: ITEM_IDS.snape_grass, count: 2 },
   { id: ITEM_IDS.iritvial, count: 4 },
   { id: ITEM_IDS.eye_of_newt, count: 2 },
   { id: ITEM_IDS.unicorn_horn_dust, count: 2 },
   { id: ITEM_IDS.avantoevial, count: 4 },
   { id: ITEM_IDS.mortmyremushroom, count: 3 },
   { id: ITEM_IDS.kwuarmvial, count: 5 },
   { id: ITEM_IDS.limpwurt_root, count: 5 },
  ],
  returnIds: [],
 },
 // Batch 2 (14 pairs): SupStr(2), WeaponPoison(4), SupRestore(6), SupDef(2) -> 111,125 XP (Lv 67)
 {
  give: [
   { id: ITEM_IDS.kwuarmvial, count: 6 },
   { id: ITEM_IDS.limpwurt_root, count: 2 },
   { id: ITEM_IDS.dragon_scale_dust, count: 4 },
   { id: ITEM_IDS.snapdragonvial, count: 6 },
   { id: ITEM_IDS.red_spiders_eggs, count: 6 },
   { id: ITEM_IDS.cadantinevial, count: 2 },
   { id: ITEM_IDS.white_berries, count: 2 },
  ],
  returnIds: [],
 },
 // Batch 3 (14 pairs): SupDef(4), Antifire(7), Ranging(3) -> 165,875 XP (Lv 73)
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
 // Batch 4 (14 pairs): Ranging(9), Magic(5) -> 224,000 XP (Lv 77)
 {
  give: [
   { id: ITEM_IDS.dwarfweedvial, count: 9 },
   { id: ITEM_IDS.wine_of_zamorak, count: 9 },
   { id: ITEM_IDS.lantadymevial, count: 5 },
   { id: ITEM_IDS.cactus_potato, count: 5 },
  ],
  returnIds: [],
 },
 // Batch 5 (14 pairs): Magic(2), Zamorak(12) -> 285,125 XP (Lv 81)
 {
  give: [
   { id: ITEM_IDS.lantadymevial, count: 2 },
   { id: ITEM_IDS.cactus_potato, count: 2 },
   { id: ITEM_IDS.torstolvial, count: 12 },
   { id: ITEM_IDS.jangerberries, count: 12 },
  ],
  returnIds: [],
 },
 // Batches 6..17 (12x14 Zamorak brews, returning finished Zamorak(3) on trades 7..17 -> >1,020,000 XP)
 ...Array.from({ length: 12 }, (_, idx): HerbloreBatchPlan => ({
  give: [
   { id: ITEM_IDS.torstolvial, count: 14 },
   { id: ITEM_IDS.jangerberries, count: 14 },
  ],
  returnIds: idx > 0 ? [ITEM_IDS.zamorak_brew_3] : [],
 })),
];

export const HERBLORE_SUPPLY_BILL: readonly SupplyEntry[] = aggregateHerbloreSupply();

function aggregateHerbloreSupply(): SupplyEntry[] {
 const counts = new Map<number, number>();
 for (const batch of HERBLORE_BATCHES) {
  for (const item of batch.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 }
 const names = new Map<number, string>([
  [ITEM_IDS.guamvial, 'Guam potion (unf)'],
  [ITEM_IDS.marrentillvial, 'Marrentill potion (unf)'],
  [ITEM_IDS.tarrominvial, 'Tarromin potion (unf)'],
  [ITEM_IDS.harralandervial, 'Harralander potion (unf)'],
  [ITEM_IDS.ranarrvial, 'Ranarr potion (unf)'],
  [ITEM_IDS.iritvial, 'Irit potion (unf)'],
  [ITEM_IDS.avantoevial, 'Avantoe potion (unf)'],
  [ITEM_IDS.kwuarmvial, 'Kwuarm potion (unf)'],
  [ITEM_IDS.snapdragonvial, 'Snapdragon potion (unf)'],
  [ITEM_IDS.cadantinevial, 'Cadantine potion (unf)'],
  [ITEM_IDS.lantadymevial, 'Lantadyme potion (unf)'],
  [ITEM_IDS.dwarfweedvial, 'Dwarf weed potion (unf)'],
  [ITEM_IDS.torstolvial, 'Torstol potion (unf)'],
  [ITEM_IDS.eye_of_newt, 'Eye of newt'],
  [ITEM_IDS.unicorn_horn_dust, 'Unicorn horn dust'],
  [ITEM_IDS.limpwurt_root, 'Limpwurt root'],
  [ITEM_IDS.chocolate_dust, 'Chocolate dust'],
  [ITEM_IDS.snape_grass, 'Snape grass'],
  [ITEM_IDS.mortmyremushroom, 'Mort myre fungi'],
  [ITEM_IDS.dragon_scale_dust, 'Dragon scale dust'],
  [ITEM_IDS.red_spiders_eggs, "Red spiders' eggs"],
  [ITEM_IDS.white_berries, 'White berries'],
  [ITEM_IDS.wine_of_zamorak, 'Wine of zamorak'],
  [ITEM_IDS.cactus_potato, 'Potato cactus'],
  [ITEM_IDS.jangerberries, 'Jangerberries'],
 ]);
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: names.get(itemId) ?? `Item ${itemId}`,
  count,
 }));
}

async function mixUnlockedPotions(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Herblore') >= target) return;
  const inv = spec.sdk.getInventory();
  let simXp = skillXp(spec, 'Herblore');
  const usedSlots = new Set<number>();
  const pairs: { unfSlot: number; secSlot: number }[] = [];
  const st = spec.sdk.getState();
  const modalOpen = !!st?.dialog?.isOpen && !st?.trade?.isOpen;
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

  if (!pairs.length) {
   if (spec.sdk.getState()?.dialog?.isOpen && !spec.sdk.getState()?.trade?.isOpen) {
    await spec.direct({ type: 'closeModal', reason: 'SDK' });
    await waitTicks(spec, 1);
   }
   return;
  }
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
 if (helpers.length < HERBLORE_BATCHES.length) {
  throw Error(`herblore specialist requires ${HERBLORE_BATCHES.length} helpers, got ${helpers.length}`);
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
  logPhase(spec, start, 'herblore_ready');

  for (let i = 0; i < HERBLORE_BATCHES.length && skillLevel(spec, 'Herblore') < target; i++) {
   const batch = HERBLORE_BATCHES[i]!;
   const helper = helpers[i]!;
   if (i > 0 && batch.returnIds.length === 0) {
    await dropItemsFast(spec, new Set(), deadline);
   } else if (i === 7) {
    await dropItemsFast(spec, new Set([ITEM_IDS.zamorak_brew_3]), deadline);
   }
   await burstTradeHost(spec, helper, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   });
   await mixUnlockedPotions(spec, target, deadline);
   if (i === 5) logPhase(spec, start, `herblore_zamorak_unlocked lvl=${skillLevel(spec, 'Herblore')}`);
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
  cap: 350,
  target: 99,
  defaultHelpers: HERBLORE_BATCHES.length,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runHerbloreSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
