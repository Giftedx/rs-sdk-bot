// Fresh-account 1-to-99 Crafting specialist using unnoted companion gem exchanges and 5-per-tick cutting.
import type { Session } from '../packages/core/src/inprocess';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 goalXp,
 ITEM_IDS,
 parseSpecialistArgs,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export interface CraftingGemTier {
 id: number;
 cutId: number;
 level: number;
 xp: number;
 name: string;
}

export const CRAFTING_GEMS: readonly CraftingGemTier[] = [
 { id: ITEM_IDS.uncut_opal, cutId: ITEM_IDS.opal, level: 1, xp: 375, name: 'opal' },
 { id: ITEM_IDS.uncut_jade, cutId: ITEM_IDS.jade, level: 13, xp: 500, name: 'jade' },
 { id: ITEM_IDS.uncut_red_topaz, cutId: ITEM_IDS.red_topaz, level: 16, xp: 625, name: 'red_topaz' },
 { id: ITEM_IDS.uncut_sapphire, cutId: ITEM_IDS.sapphire, level: 20, xp: 1250, name: 'sapphire' },
 { id: ITEM_IDS.uncut_emerald, cutId: ITEM_IDS.emerald, level: 27, xp: 1687.5, name: 'emerald' },
 { id: ITEM_IDS.uncut_ruby, cutId: ITEM_IDS.ruby, level: 34, xp: 2125, name: 'ruby' },
 { id: ITEM_IDS.uncut_diamond, cutId: ITEM_IDS.diamond, level: 43, xp: 2687.5, name: 'diamond' },
 { id: ITEM_IDS.uncut_dragonstone, cutId: ITEM_IDS.dragonstone, level: 55, xp: 3437.5, name: 'dragonstone' },
];

export interface CraftingBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const CRAFTING_BATCHES: readonly CraftingBatchPlan[] = [
 {
  give: [
   { id: ITEM_IDS.chisel, count: 1 },
   { id: ITEM_IDS.uncut_opal, count: 15 },
   { id: ITEM_IDS.uncut_jade, count: 6 },
   { id: ITEM_IDS.uncut_red_topaz, count: 6 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.uncut_opal, count: 4 },
   { id: ITEM_IDS.uncut_jade, count: 4 },
   { id: ITEM_IDS.uncut_red_topaz, count: 4 },
   { id: ITEM_IDS.uncut_sapphire, count: 3 },
   { id: ITEM_IDS.uncut_emerald, count: 3 },
   { id: ITEM_IDS.uncut_ruby, count: 5 },
   { id: ITEM_IDS.uncut_diamond, count: 4 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.uncut_diamond, count: 6 },
   { id: ITEM_IDS.uncut_dragonstone, count: 21 },
  ],
  returnIds: [],
 },
 ...Array.from({ length: 10 }, (): CraftingBatchPlan => ({
  give: [{ id: ITEM_IDS.uncut_dragonstone, count: 27 }],
  returnIds: [ITEM_IDS.dragonstone],
 })),
];

export const CRAFTING_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.chisel, item: 'Chisel', count: 1 },
 { itemId: ITEM_IDS.uncut_opal, item: 'Uncut opal', count: 19 },
 { itemId: ITEM_IDS.uncut_jade, item: 'Uncut jade', count: 10 },
 { itemId: ITEM_IDS.uncut_red_topaz, item: 'Uncut red topaz', count: 10 },
 { itemId: ITEM_IDS.uncut_sapphire, item: 'Uncut sapphire', count: 3 },
 { itemId: ITEM_IDS.uncut_emerald, item: 'Uncut emerald', count: 3 },
 { itemId: ITEM_IDS.uncut_ruby, item: 'Uncut ruby', count: 5 },
 { itemId: ITEM_IDS.uncut_diamond, item: 'Uncut diamond', count: 10 },
 { itemId: ITEM_IDS.uncut_dragonstone, item: 'Uncut dragonstone', count: 291 },
];

function keepSetFor(spec: Session, preserveCutDragonstones: boolean): Set<number> {
 const keep = new Set<number>([ITEM_IDS.chisel]);
 for (const tier of CRAFTING_GEMS) keep.add(tier.id);
 if (preserveCutDragonstones) keep.add(ITEM_IDS.dragonstone);
 void spec;
 return keep;
}

async function cutUnlockedGems(spec: Session, target: number, deadlineTick: number): Promise<void> {
 const tierIds = new Set(CRAFTING_GEMS.map(t => t.id));
 while (spec.tick() < deadlineTick) {
  if (skillLevel(spec, 'Crafting') >= target) return;
  const inv = spec.sdk.getInventory();
  const chisel = inv.find(i => i.id === ITEM_IDS.chisel);
  if (!chisel) throw Error('crafting chisel missing');
  const lvl = skillLevel(spec, 'Crafting');
  const unlocked = new Set(CRAFTING_GEMS.filter(t => lvl >= t.level).map(t => t.id));
  const gems = inv.filter(i => tierIds.has(i.id) && unlocked.has(i.id));
  if (!gems.length) return;
  const st = spec.sdk.getState();
  const modalOpen = !!st?.dialog?.isOpen && !st?.trade?.isOpen;
  const batch = gems.slice(0, modalOpen ? 4 : 5);
  const actions: Promise<unknown>[] = [];
  if (modalOpen) actions.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  for (const gem of batch) {
   actions.push(spec.direct({ type: 'useItemOnItem', sourceSlot: chisel.slot, targetSlot: gem.slot, reason: 'SDK' }));
  }
  await Promise.all(actions);
  await waitTicks(spec, 1);
 }
 throw Error('crafting gem cut exceeded cap');
}

export async function runCraftingSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(CRAFTING_SUPPLY_BILL);
 if (helpers.length < CRAFTING_BATCHES.length) {
  throw Error(`crafting specialist requires ${CRAFTING_BATCHES.length} helpers, got ${helpers.length}`);
 }
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 let done = false;
 const keepers = helpers.map(h =>
  (async () => {
   while (!done && h.tick() < deadline) {
    await waitTicks(h, 1);
   }
  })(),
 );

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  for (let i = 0; i < CRAFTING_BATCHES.length && skillLevel(spec, 'Crafting') < target; i++) {
   const batch = CRAFTING_BATCHES[i]!;
   const helper = helpers[i]!;
   if (i > 0 && batch.returnIds.length === 0) {
    await dropItemsFast(spec, keepSetFor(spec, false), deadline);
   } else if (i === 3) {
    // Clear diamond/early remnants once before pure dragonstone return-trade loop.
    await dropItemsFast(spec, keepSetFor(spec, true), deadline);
   }
   await burstTradeHost(spec, helper, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   });
   await cutUnlockedGems(spec, target, deadline);
  }

  const level = skillLevel(spec, 'Crafting');
  const xp = skillXp(spec, 'Crafting');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=crafting level=${level} xp=${xp} ticks=${ticks} gemCount=${countItem(spec.sdk.getInventory(), ITEM_IDS.dragonstone)}`,
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
  cap: 250,
  target: 99,
  defaultHelpers: CRAFTING_BATCHES.length,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runCraftingSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
