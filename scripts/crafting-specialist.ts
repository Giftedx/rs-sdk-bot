// Fresh-account 1-to-99 Crafting specialist using unnoted companion gem exchanges and 5-per-tick cutting.
import type { Session } from '../packages/core/src/inprocess';
import {
 assertCatalogItems,
 buildTradeGiveForIds,
 burstTradeHost,
 countItem,
 dropItemsFast,
 goalXp,
 ITEM_IDS,
 logPhase,
 parseExternalSuppliers,
 parseSpecialistArgs,
 skipTutorialFast,
 skillLevel,
 skillXp,
 tradeExternalSupplier,
 waitTicks,
 withSingleSpecialist,
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
   { id: ITEM_IDS.uncut_opal, count: 18 },
   { id: ITEM_IDS.uncut_sapphire, count: 3 },
   { id: ITEM_IDS.uncut_emerald, count: 6 },
  ],
  returnIds: [],
 },
 {
  give: [
   { id: ITEM_IDS.uncut_ruby, count: 3 },
   { id: ITEM_IDS.uncut_diamond, count: 9 },
   { id: ITEM_IDS.uncut_dragonstone, count: 15 },
  ],
  returnIds: [
   ITEM_IDS.opal,
   1633,
   ITEM_IDS.sapphire,
   ITEM_IDS.emerald,
  ],
 },
 ...Array.from({ length: 9 }, (_, idx): CraftingBatchPlan => ({
  give: [{ id: ITEM_IDS.uncut_dragonstone, count: 27 }],
  returnIds:
   idx === 0
    ? [ITEM_IDS.ruby, ITEM_IDS.diamond, ITEM_IDS.dragonstone]
    : [ITEM_IDS.dragonstone],
 })),
 {
  give: [{ id: ITEM_IDS.uncut_dragonstone, count: 19 }],
  returnIds: [ITEM_IDS.dragonstone],
 },
];

export const CRAFTING_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.chisel, item: 'Chisel', count: 1 },
 { itemId: ITEM_IDS.uncut_opal, item: 'Uncut opal', count: 18 },
 { itemId: ITEM_IDS.uncut_sapphire, item: 'Uncut sapphire', count: 3 },
 { itemId: ITEM_IDS.uncut_emerald, item: 'Uncut emerald', count: 6 },
 { itemId: ITEM_IDS.uncut_ruby, item: 'Uncut ruby', count: 3 },
 { itemId: ITEM_IDS.uncut_diamond, item: 'Uncut diamond', count: 9 },
 { itemId: ITEM_IDS.uncut_dragonstone, item: 'Uncut dragonstone', count: 277 },
];

function keepSetFor(preserveCutDragonstones: boolean): Set<number> {
 const keep = new Set<number>([ITEM_IDS.chisel]);
 for (const tier of CRAFTING_GEMS) keep.add(tier.id);
 if (preserveCutDragonstones) keep.add(ITEM_IDS.dragonstone);
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
  const batch = gems.slice(0, 5);
  const actions: Promise<unknown>[] = [];
  if (modalOpen && gems.length <= 4) actions.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  for (const gem of batch) {
   actions.push(spec.direct({ type: 'useItemOnItem', sourceSlot: chisel.slot, targetSlot: gem.slot, reason: 'SDK' }));
  }
  await Promise.all(actions);
  await waitTicks(spec, 1);
 }
 throw Error('crafting gem cut exceeded cap');
}

async function executeCraftingLoop(
 spec: Session,
 target: number,
 start: number,
 deadline: number,
 receiveBatch: (batch: CraftingBatchPlan, index: number) => Promise<void>,
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);
 logPhase(spec, start, 'crafting_ready');

 for (let i = 0; i < CRAFTING_BATCHES.length && skillLevel(spec, 'Crafting') < target; i++) {
  const batch = CRAFTING_BATCHES[i]!;
  if (i > 0 && batch.returnIds.length === 0) {
   await dropItemsFast(spec, keepSetFor(false), deadline);
  }
  await receiveBatch(batch, i);
  await cutUnlockedGems(spec, target, deadline);
  if (i === 1) logPhase(spec, start, `crafting_55_lvl=${skillLevel(spec, 'Crafting')}`);
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
  return await executeCraftingLoop(spec, target, start, deadline, (batch, i) =>
   burstTradeHost(spec, helpers[i]!, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   }),
  );
 } finally {
  done = true;
  await Promise.allSettled(keepers);
 }
}

export async function runCraftingExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(CRAFTING_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('crafting external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 return executeCraftingLoop(spec, target, start, deadline, async batch => {
  const give = buildTradeGiveForIds(spec, batch.returnIds);
  await tradeExternalSupplier(spec, supplierNames, {
   ...(give.length ? { give } : {}),
   acceptOffer: offer => batch.give.every(g => countItem(offer, g.id) >= g.count),
   deadlineTick: deadline,
  });
 });
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 230,
  target: 99,
  defaultHelpers: CRAFTING_BATCHES.length,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runCraftingExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runCraftingSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
