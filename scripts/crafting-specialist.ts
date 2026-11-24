// Fresh-account 1-to-99 Crafting specialist using unnoted companion gem exchanges and 5-per-tick cutting.
import type { Session } from '../packages/core/src/inprocess';
import {
 assertCatalogItems,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 goalXp,
 ITEM_IDS,
 levelForXp,
 logPhase,
 parseExternalSuppliers,
 parseSpecialistArgs,
 playerPos,
 skillLevel,
 skillXp,
 TRADE_CONFIRM_ACCEPT,
 TRADE_MAIN_ACCEPT,
 TRADE_OFFER_INV,
 waitTicks,
 waitUntil,
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

const GEM_XP_BY_ID = new Map<number, number>(CRAFTING_GEMS.map(g => [g.id, g.xp]));
const GEM_LEVEL_BY_ID = new Map<number, number>(CRAFTING_GEMS.map(g => [g.id, g.level]));
const ON_STARTER_ISLAND = (p: { worldX: number; worldZ: number } | null | undefined): boolean =>
 !!p && p.worldX >= 3050 && p.worldX <= 3160 && p.worldZ >= 3050 && p.worldZ <= 3140;

/** Skip Tutorial Island in 2 ticks by chaining character design + guide talk and continue + "Yes please." */
async function skipTutorial2Ticks(spec: Session, deadlineTick: number): Promise<void> {
 const ready = await waitUntil(spec, () => !!playerPos(spec), { timeoutTicks: 20 });
 if (!ready) throw Error('tutorial start player state unobserved');
 let designSent = false;
 let guideClicked = false;
 while (spec.tick() < deadlineTick) {
  const st = spec.sdk.getState();
  const p = st?.player;
  if (p && !ON_STARTER_ISLAND(p) && !st?.dialog?.isOpen && !st?.modalOpen) return;
  if (st?.modalOpen && st.modalInterface === 3559 && !designSent) {
   designSent = true;
   await spec.direct({ type: 'acceptCharacterDesign', reason: 'SDK' });
   const guide = st.nearbyNpcs.find(n => /^runescape guide$/i.test(n.name));
   const op = guide?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text));
   if (guide && op) {
    guideClicked = true;
    await spec.direct({ type: 'interactNpc', npcIndex: guide.index, optionIndex: op.opIndex, reason: 'SDK' });
   }
  } else if (p && ON_STARTER_ISLAND(p)) {
   const dlg = spec.sdk.getDialog();
   if (dlg?.isOpen && !dlg.isWaiting) {
    const yes = dlg.options.find((o: any) => /^yes please[.]?$/i.test(o.text));
    if (yes && dlg.options.every((o: any) => /^(yes please|no, thank you)[.]?$/i.test(o.text))) {
     await spec.direct({ type: 'clickDialogOption', optionIndex: yes.index, reason: 'SDK' });
    } else if (dlg.options.length === 0 || (dlg.options.length === 1 && dlg.options[0]!.buttonType === 6)) {
     await spec.direct({ type: 'clickDialogOption', optionIndex: 0, reason: 'SDK' });
     await spec.direct({ type: 'clickComponent', componentId: 2461, reason: 'SDK' });
    }
   } else if (!guideClicked && designSent) {
    const guide = st?.nearbyNpcs.find(n => /^runescape guide$/i.test(n.name));
    const op = guide?.optionsWithIndex.find(o => /^talk-to$/i.test(o.text));
    if (guide && op) {
     guideClicked = true;
     await spec.direct({ type: 'interactNpc', npcIndex: guide.index, optionIndex: op.opIndex, reason: 'SDK' });
    }
   }
  }
  await waitTicks(spec, 1);
 }
 throw Error('tutorial skip exceeded cap');
}

function keepSetFor(preserveCutDragonstones: boolean): Set<number> {
 const keep = new Set<number>([ITEM_IDS.chisel]);
 for (const tier of CRAFTING_GEMS) keep.add(tier.id);
 if (preserveCutDragonstones) keep.add(ITEM_IDS.dragonstone);
 return keep;
}

/** Cut gems at 5/tick across deterministic tier boundaries; optionally fire a pre-request on the final <5 tick. */
async function cutUnlockedGems(
 spec: Session,
 target: number,
 deadlineTick: number,
 nextHelper?: Session,
): Promise<{ preRequested: boolean; pendingDialogs: number }> {
 const tierIds = new Set(CRAFTING_GEMS.map(t => t.id));
 let preRequested = false;
 let pendingDialogs = 0;
 let prevBaseLevel = skillLevel(spec, 'Crafting');

 while (spec.tick() < deadlineTick) {
  const curBase = skillLevel(spec, 'Crafting');
  if (curBase > prevBaseLevel) {
   pendingDialogs += curBase - prevBaseLevel;
   prevBaseLevel = curBase;
  }
  if (curBase >= target) return { preRequested, pendingDialogs };

  const inv = spec.sdk.getInventory();
  const chisel = inv.find(i => i.id === ITEM_IDS.chisel);
  if (!chisel) throw Error('crafting chisel missing');

  const realXp = skillXp(spec, 'Crafting');
  const unlockedNow = new Set(CRAFTING_GEMS.filter(t => curBase >= t.level).map(t => t.id));
  const deterministicIds = new Set(
   CRAFTING_GEMS.filter(t => t.id !== ITEM_IDS.uncut_opal && t.id !== ITEM_IDS.uncut_jade && t.id !== ITEM_IDS.uncut_red_topaz).map(t => t.id),
  );
  // Pick up to 5 gems in ascending level order, predicting level-ups across deterministic gems (sapphire+).
  const gems = inv
   .filter(i => tierIds.has(i.id))
   .sort((a, b) => (GEM_LEVEL_BY_ID.get(a.id) ?? 99) - (GEM_LEVEL_BY_ID.get(b.id) ?? 99));
  let simXp = realXp;
  const batch: typeof inv = [];
  for (const gem of gems) {
   if (batch.length >= 5) break;
   const reqLvl = GEM_LEVEL_BY_ID.get(gem.id) ?? 99;
   const canPredict = unlockedNow.has(gem.id) || (deterministicIds.has(gem.id) && levelForXp(simXp) >= reqLvl);
   if (!canPredict) continue;
   batch.push(gem);
   if (deterministicIds.has(gem.id)) simXp += GEM_XP_BY_ID.get(gem.id) ?? 0;
  }
  if (!batch.length) return { preRequested, pendingDialogs };

  const allDeterministic = batch.every(g => deterministicIds.has(g.id));
  const totalRemaining = gems.length;
  const willLevel = allDeterministic ? levelForXp(simXp) > curBase : true;
  const dialogOpen = !!spec.sdk.getState()?.dialog?.isOpen;
  // Note: 1 OpHeldU closes an open dialog, so engineQueue drains 1 per tick whenever dialogOpen or pendingDialogs > 0.
  const canPreRequest =
   !!nextHelper &&
   totalRemaining <= 4 &&
   batch.length === totalRemaining &&
   !willLevel &&
   pendingDialogs <= (dialogOpen ? 1 : 0);

  const actions: Promise<unknown>[] = [];
  for (const gem of batch) {
   actions.push(spec.direct({ type: 'useItemOnItem', sourceSlot: chisel.slot, targetSlot: gem.slot, reason: 'SDK' }));
  }
  const helperActs: Promise<unknown>[] = [];
  if (canPreRequest) {
   const hTarget = spec.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === nextHelper.name.toLowerCase());
   const sTarget = nextHelper.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === spec.name.toLowerCase());
   if (hTarget && sTarget) {
    preRequested = true;
    helperActs.push(nextHelper.direct({ type: 'interactPlayer', playerIndex: sTarget.index, optionIndex: 4, reason: 'SDK' }));
    actions.push(spec.direct({ type: 'interactPlayer', playerIndex: hTarget.index, optionIndex: 4, reason: 'SDK' }));
   }
  }
  await Promise.all([...helperActs, ...actions]);
  // One dialog popped/cleared during this tick if one was open or queued.
  if (dialogOpen && pendingDialogs > 0) pendingDialogs--;
  await Promise.all(nextHelper ? [waitTicks(spec, 1), waitTicks(nextHelper, 1)] : [waitTicks(spec, 1)]);
 }
 throw Error('crafting gem cut exceeded cap');
}

/**
 * Drop unwanted tutorial/cut items at 5/tick (or 4/tick + interactPlayer when draining level-ups)
 * and execute a zero-cooldown in-process trade with `helper`.
 */
async function fastInProcessBatchTrade(
 spec: Session,
 helper: Session,
 opts: {
  giveIds: readonly number[];
  returnIds: readonly number[];
  dropUnwanted?: ReadonlySet<number>;
  deadlineTick: number;
  alreadyRequested?: boolean;
 },
): Promise<void> {
 const begin = spec.tick();
 const helperLower = helper.name.toLowerCase();
 const specLower = spec.name.toLowerCase();
 const giveSet = new Set(opts.giveIds);
 const returnSet = new Set(opts.returnIds);
 const keepSet = opts.dropUnwanted;
 let sawConfirm = false;
 let offered = false;
 let tradeDone = false;

 while (spec.tick() < opts.deadlineTick) {
  const st = spec.sdk.getTradeState();
  const ht = helper.sdk.getTradeState();

  if (!st.isOpen && !ht.isOpen) {
   if (sawConfirm || tradeDone || opts.giveIds.every(id => countItem(helper.sdk.getInventory(), id) === 0)) {
    console.log(`TRADE_TICKS helper=${helper.name} at=${begin} ticks=${spec.tick() - begin}`);
    return;
   }
   offered = false;
   const dropSlots = keepSet ? spec.sdk.getInventory().filter(i => !keepSet.has(i.id)).map(i => i.slot) : [];
   const hTarget = spec.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === helperLower);
   const sTarget = helper.sdk.getNearbyPlayers().find(p => p.name.toLowerCase() === specLower);
   const sActs: Promise<unknown>[] = [];
   const hActs: Promise<unknown>[] = [];

   if (dropSlots.length > 4) {
    for (const slot of dropSlots.slice(0, 5)) {
     sActs.push(spec.direct({ type: 'dropItem', slot, reason: 'SDK' }));
    }
   } else {
    for (const slot of dropSlots) {
     sActs.push(spec.direct({ type: 'dropItem', slot, reason: 'SDK' }));
    }
    if (hTarget && sTarget && !(opts.alreadyRequested && spec.tick() === begin)) {
     hActs.push(helper.direct({ type: 'interactPlayer', playerIndex: sTarget.index, optionIndex: 4, reason: 'SDK' }));
     sActs.push(spec.direct({ type: 'interactPlayer', playerIndex: hTarget.index, optionIndex: 4, reason: 'SDK' }));
    }
   }
   if (hActs.length) await Promise.all(hActs);
   if (sActs.length) await Promise.all(sActs);
   await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
   continue;
  }

  if (st.screen === 'confirm' || ht.screen === 'confirm') {
   sawConfirm = true;
   const hActs: Promise<unknown>[] = [];
   const sActs: Promise<unknown>[] = [];
   if (ht.isOpen && ht.screen === 'confirm' && !ht.myAccepted) {
    hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
   }
   if (st.isOpen && st.screen === 'confirm' && !st.myAccepted) {
    sActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
   }
   if (hActs.length) await Promise.all(hActs);
   if (sActs.length) await Promise.all(sActs);
   await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
   if (!spec.sdk.getTradeState().isOpen && !helper.sdk.getTradeState().isOpen && opts.giveIds.every(id => countItem(helper.sdk.getInventory(), id) === 0)) {
    tradeDone = true;
    console.log(`TRADE_TICKS helper=${helper.name} at=${begin} ticks=${spec.tick() - begin}`);
    return;
   }
   continue;
  }

  const hActs: Promise<unknown>[] = [];
  const sActs: Promise<unknown>[] = [];
  const hSlots = new Map<number, number>();
  if (!offered) {
   for (const item of helper.sdk.getInventory()) {
    if (giveSet.has(item.id) && !hSlots.has(item.id)) hSlots.set(item.id, item.slot);
   }
  }
  const sSlots = new Map<number, number>();
  if (!offered && returnSet.size > 0) {
   for (const item of spec.sdk.getInventory()) {
    if (returnSet.has(item.id) && !sSlots.has(item.id)) sSlots.set(item.id, item.slot);
   }
  }

  offered = true;
  for (const slot of hSlots.values()) {
   hActs.push(helper.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }
  if (hSlots.size <= 4 && !ht.myAccepted) {
   hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
  }
  if (hSlots.size <= 3 && sSlots.size <= 3) {
   hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  }

  for (const slot of sSlots.values()) {
   sActs.push(spec.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }
  if (sSlots.size <= 4 && !st.myAccepted) {
   sActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
  }
  if (sSlots.size <= 3 && hSlots.size <= 3) {
   sActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  }

  if (hActs.length) await Promise.all(hActs);
  if (sActs.length) await Promise.all(sActs);
  await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
 }
 throw Error(`fastInProcessBatchTrade with ${helper.name} exceeded cap`);
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
  await skipTutorial2Ticks(spec, deadline);
  let preReq = false;

  for (let i = 0; i < CRAFTING_BATCHES.length && skillLevel(spec, 'Crafting') < target; i++) {
   const batch = CRAFTING_BATCHES[i]!;
   // Batch 0 drops all 18 tutorial items (4t + pre-request on 4th tick); Batches 1 & 2 drop Batch 0/1 cut gems while draining level-up modals for free.
   const dropKeep = i === 0 ? new Set<number>() : i <= 2 ? keepSetFor(false) : undefined;
   await fastInProcessBatchTrade(spec, helpers[i]!, {
    giveIds: batch.give.map(g => g.id),
    returnIds: i <= 2 ? [] : batch.returnIds,
    dropUnwanted: dropKeep,
    deadlineTick: deadline,
    alreadyRequested: preReq,
   });
   if (i === 0) logPhase(spec, start, 'crafting_ready');
   const nextHelper = i + 1 < CRAFTING_BATCHES.length && i >= 2 ? helpers[i + 1]! : undefined;
   const cutRes = await cutUnlockedGems(spec, target, deadline, nextHelper);
   preReq = cutRes.preRequested;
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
 await skipTutorial2Ticks(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);
 logPhase(spec, start, 'crafting_ready');

 for (let i = 0; i < CRAFTING_BATCHES.length && skillLevel(spec, 'Crafting') < target; i++) {
  const batch = CRAFTING_BATCHES[i]!;
  if (i > 0 && i <= 2) {
   await dropItemsFast(spec, keepSetFor(false), deadline);
  }
  const targets = supplierNames.length >= CRAFTING_BATCHES.length ? [supplierNames[i]!] : supplierNames;
  await fastTradeExternalReceive(spec, targets, {
   returnIds: i <= 2 ? [] : batch.returnIds,
   allowSingleModal: true,
   acceptOffer: offer => batch.give.every(g => countItem(offer, g.id) >= g.count),
   deadlineTick: deadline,
  });
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
