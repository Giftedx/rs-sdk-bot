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

export const CRAFTING_CW_BANK_CHEST = { id: 4483, x: 2444, z: 3083, optionIndex: 1 } as const;
const RING_OF_DUELING_SET = new Set<number>([ITEM_IDS.ring_of_dueling_8, 2554, 2556, 2558, 2560, 2562, 2564, 2566]);

export const CRAFTING_CW_NOTED_SUPPLIES: readonly { id: number; certId: number; count: number }[] = [
 { id: ITEM_IDS.uncut_opal, certId: 1626, count: 18 },
 { id: ITEM_IDS.uncut_sapphire, certId: 1624, count: 3 },
 { id: ITEM_IDS.uncut_emerald, certId: 1622, count: 6 },
 { id: ITEM_IDS.uncut_ruby, certId: 1620, count: 3 },
 { id: ITEM_IDS.uncut_diamond, certId: 1618, count: 9 },
 { id: ITEM_IDS.uncut_dragonstone, certId: 1632, count: 277 },
];

export const CRAFTING_CW_BATCH: CraftingBatchPlan = {
 give: [
  { id: ITEM_IDS.ring_of_dueling_8, count: 1 },
  { id: ITEM_IDS.chisel, count: 1 },
  ...CRAFTING_CW_NOTED_SUPPLIES.map(s => ({ id: s.certId, count: s.count })),
 ],
 returnIds: [],
};

export const CRAFTING_CW_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.ring_of_dueling_8, item: 'Ring of dueling(8)', count: 1 },
 { itemId: ITEM_IDS.chisel, item: 'Chisel', count: 1 },
 { itemId: ITEM_IDS.uncut_opal, item: 'Uncut opal', count: 18 },
 { itemId: ITEM_IDS.uncut_sapphire, item: 'Uncut sapphire', count: 3 },
 { itemId: ITEM_IDS.uncut_emerald, item: 'Uncut emerald', count: 6 },
 { itemId: ITEM_IDS.uncut_ruby, item: 'Uncut ruby', count: 3 },
 { itemId: ITEM_IDS.uncut_diamond, item: 'Uncut diamond', count: 9 },
 { itemId: ITEM_IDS.uncut_dragonstone, item: 'Uncut dragonstone', count: 277 },
];

const CRAFTING_CW_CYCLES: readonly (readonly { id: number; count: number }[])[] = [
 [
  { id: ITEM_IDS.uncut_opal, count: 18 },
  { id: ITEM_IDS.uncut_sapphire, count: 3 },
  { id: ITEM_IDS.uncut_emerald, count: 6 },
 ],
 [
  { id: ITEM_IDS.uncut_ruby, count: 3 },
  { id: ITEM_IDS.uncut_diamond, count: 9 },
  { id: ITEM_IDS.uncut_dragonstone, count: 15 },
 ],
 ...Array.from({ length: 9 }, () => [{ id: ITEM_IDS.uncut_dragonstone, count: 27 }] as const),
 [{ id: ITEM_IDS.uncut_dragonstone, count: 19 }],
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

/** Cut gems at 5/tick across deterministic tier boundaries; optionally pre-request next helper or open bank on final <5 tick. */
async function cutUnlockedGems(
 spec: Session,
 target: number,
 deadlineTick: number,
 nextHelper?: Session,
 openBankOnFinal = false,
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
  if (openBankOnFinal && totalRemaining <= 4 && batch.length === totalRemaining) {
   actions.push(
    spec.direct({
     type: 'interactLoc',
     x: CRAFTING_CW_BANK_CHEST.x,
     z: CRAFTING_CW_BANK_CHEST.z,
     locId: CRAFTING_CW_BANK_CHEST.id,
     optionIndex: CRAFTING_CW_BANK_CHEST.optionIndex,
     reason: 'SDK',
    }),
   );
  } else if (canPreRequest) {
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
 let lastReqTick = -10;

 while (spec.tick() < opts.deadlineTick) {
  const st = spec.sdk.getTradeState();
  const ht = helper.sdk.getTradeState();

  if (!st.isOpen && !ht.isOpen) {
   if (sawConfirm || opts.giveIds.every(id => countItem(helper.sdk.getInventory(), id) === 0)) {
    console.log(`TRADE_TICKS helper=${helper.name} at=${begin} ticks=${spec.tick() - begin}`);
    return;
   }
   const dropSlots = keepSet ? spec.sdk.getInventory().filter(i => !keepSet.has(i.id)).map(i => i.slot) : [];
   const dlgOpen = !!spec.sdk.getState()?.dialog?.isOpen;
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
    if (hTarget && sTarget && spec.tick() - lastReqTick >= 2) {
     lastReqTick = spec.tick();
     hActs.push(helper.direct({ type: 'interactPlayer', playerIndex: sTarget.index, optionIndex: 4, reason: 'SDK' }));
     sActs.push(spec.direct({ type: 'interactPlayer', playerIndex: hTarget.index, optionIndex: 4, reason: 'SDK' }));
    } else if (dlgOpen) {
     sActs.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
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
    console.log(`TRADE_TICKS helper=${helper.name} at=${begin} ticks=${spec.tick() - begin}`);
    return;
   }
   continue;
  }

  const hActs: Promise<unknown>[] = [];
  const sActs: Promise<unknown>[] = [];
  const hOffered = new Set(ht.myOffer.map(o => o.id));
  const sOffered = new Set(st.myOffer.map(o => o.id));
  const hSlots = new Map<number, number>();
  const sSlots = new Map<number, number>();
  if (ht.isOpen) {
   for (const item of helper.sdk.getInventory()) {
    if (giveSet.has(item.id) && !hOffered.has(item.id) && !hSlots.has(item.id)) hSlots.set(item.id, item.slot);
   }
  }
  if (st.isOpen && returnSet.size > 0) {
   for (const item of spec.sdk.getInventory()) {
    if (returnSet.has(item.id) && !sOffered.has(item.id) && !sSlots.has(item.id)) sSlots.set(item.id, item.slot);
   }
  }

  const hAllOffered = hSlots.size === 0 || [...hSlots.keys()].length <= 4;
  const sAllOffered = sSlots.size === 0 || [...sSlots.keys()].length <= 4;
  const hToOffer = [...hSlots.values()].slice(0, hSlots.size > 4 ? 5 : 4);
  const sToOffer = [...sSlots.values()].slice(0, sSlots.size > 4 ? 5 : 4);

  for (const slot of hToOffer) {
   hActs.push(helper.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }
  for (const slot of sToOffer) {
   sActs.push(spec.direct({ type: 'clickComponentWithOption', componentId: TRADE_OFFER_INV, optionIndex: 4, slot, reason: 'SDK' }));
  }

  // Since spec has lower PID than helper, let helper accept main on tick 1 and spec accept+confirm on tick 2.
  if (hAllOffered && !ht.myAccepted && ht.isOpen) {
   hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
  }
  if (hAllOffered && sAllOffered && ht.myAccepted && st.myAccepted && hToOffer.length === 0 && sToOffer.length === 0) {
   hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  } else if (hAllOffered && sAllOffered && sToOffer.length === 0 && !st.myAccepted && ht.myAccepted) {
   // Spec transitions main->confirm and accepts confirm together, so helper confirms right after in the same tick.
   hActs.push(helper.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
  }

  if (sAllOffered && sToOffer.length === 0 && !st.myAccepted && st.isOpen && hAllOffered && (ht.myAccepted || hToOffer.length === 0)) {
   sActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_MAIN_ACCEPT, reason: 'SDK' }));
   if (ht.myAccepted || hToOffer.length > 0) {
    sActs.push(spec.direct({ type: 'clickComponent', componentId: TRADE_CONFIRM_ACCEPT, reason: 'SDK' }));
   }
  }

  if (hActs.length) await Promise.all(hActs);
  if (sActs.length) await Promise.all(sActs);
  await Promise.all([waitTicks(spec, 1), waitTicks(helper, 1)]);
 }
 throw Error(`fastInProcessBatchTrade with ${helper.name} exceeded cap`);
}

function pushCwWithdraw(acts: Promise<unknown>[], spec: Session, slot: number, need: number, bankCount: number): void {
 if (need <= 0) return;
 if (need >= bankCount) {
  acts.push(spec.direct({ type: 'bankWithdraw', slot, amount: -1, reason: 'SDK' }));
  return;
 }
 let rem = need;
 while (rem >= 10) {
  acts.push(spec.direct({ type: 'bankWithdraw', slot, amount: 10, reason: 'SDK' }));
  rem -= 10;
 }
 while (rem >= 5) {
  acts.push(spec.direct({ type: 'bankWithdraw', slot, amount: 5, reason: 'SDK' }));
  rem -= 5;
 }
 while (rem >= 1) {
  acts.push(spec.direct({ type: 'bankWithdraw', slot, amount: 1, reason: 'SDK' }));
  rem -= 1;
 }
}

const inCastleWars = (p: { level: number; worldX: number; worldZ: number } | null | undefined): boolean =>
 !!p && p.level === 0 && p.worldX >= 2420 && p.worldX <= 2465 && p.worldZ >= 3070 && p.worldZ <= 3110;

async function openCwChest(spec: Session, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  const st = spec.sdk.getState();
  if (st?.bank?.isOpen) return;
  await spec.direct({
   type: 'interactLoc',
   x: CRAFTING_CW_BANK_CHEST.x,
   z: CRAFTING_CW_BANK_CHEST.z,
   locId: CRAFTING_CW_BANK_CHEST.id,
   optionIndex: CRAFTING_CW_BANK_CHEST.optionIndex,
   reason: 'SDK',
  });
  await waitTicks(spec, 1);
 }
 throw Error('openCwChest exceeded cap');
}

async function executeCraftingCastleWars(
 spec: Session,
 target: number,
 start: number,
 deadline: number,
 receiveCwKit: () => Promise<void>,
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 await skipTutorial2Ticks(spec, deadline);
 // Fresh tutorial inventory leaves >= 10 free slots, fitting all 8 stackable CW kit items without dropping.
 if (spec.sdk.getInventory().length > 20) {
  await dropItemsFast(spec, new Set(), deadline);
 }
 await receiveCwKit();
 logPhase(spec, start, 'crafting_cw_traded');

 // Rub Ring of dueling(8) and pick option 2 (2462 = Castle Wars) in a single tick.
 let rubChained = false;
 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (inCastleWars(p)) break;
  const dlg = spec.sdk.getDialog();
  const cwOpt = dlg?.isOpen && !dlg.isWaiting ? dlg.options.find((o: any) => /castle wars/i.test(o.text)) : undefined;
  if (cwOpt) {
   await spec.direct({ type: 'clickDialogOption', optionIndex: cwOpt.index, reason: 'SDK' });
  } else {
   const ring = spec.sdk.getInventory().find(i => RING_OF_DUELING_SET.has(i.id));
   if (!ring) throw Error('ring of dueling missing after CW trade');
   if (!rubChained) {
    rubChained = true;
    await spec.direct({ type: 'useInventoryItem', slot: ring.slot, optionIndex: 4, reason: 'SDK' });
    await spec.direct({ type: 'clickComponent', componentId: 2462, reason: 'SDK' });
   } else {
    await spec.direct({ type: 'useInventoryItem', slot: ring.slot, optionIndex: 4, reason: 'SDK' });
   }
  }
  await waitTicks(spec, 1);
 }

 await openCwChest(spec, deadline);
 // Deposit all non-chisel items (noted gems + Ring of dueling) at 5/tick.
 while (spec.tick() < deadline) {
  const toDep = spec.sdk.getInventory().filter(i => i.id !== ITEM_IDS.chisel);
  if (!toDep.length) break;
  const acts: Promise<unknown>[] = [];
  const seenDep = new Set<number>();
  for (const item of toDep) {
   if (seenDep.has(item.id)) continue;
   seenDep.add(item.id);
   acts.push(spec.direct({ type: 'bankDeposit', slot: item.slot, amount: -1, reason: 'SDK' }));
   if (acts.length >= 5) break;
  }
  if (acts.length) await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 logPhase(spec, start, 'crafting_cw_banked');

 for (let idx = 0; idx < CRAFTING_CW_CYCLES.length && skillLevel(spec, 'Crafting') < target; idx++) {
  const cycle = CRAFTING_CW_CYCLES[idx]!;
  while (spec.tick() < deadline) {
   const st = spec.sdk.getState();
   const inv = spec.sdk.getInventory();
   if (!st?.bank?.isOpen && cycle.every(g => countItem(inv, g.id) >= g.count)) break;
   if (!st?.bank?.isOpen) {
    await openCwChest(spec, deadline);
    continue;
   }
   const bankItems = st.bank.items ?? [];
   if (!cycle.every(g => {
    const have = countItem(inv, g.id);
    const row = bankItems.find((b: any) => b.id === g.id);
    return have >= g.count || (!!row && row.count >= g.count - have);
   })) {
    await waitTicks(spec, 1);
    continue;
   }
   const acts: Promise<unknown>[] = [];
   const seenDep = new Set<number>();
   const wantSet = new Set(cycle.map(g => g.id));
   for (const item of inv) {
    if (item.id === ITEM_IDS.chisel || wantSet.has(item.id) || seenDep.has(item.id)) continue;
    seenDep.add(item.id);
    acts.push(spec.direct({ type: 'bankDeposit', slot: item.slot, amount: -1, reason: 'SDK' }));
   }
   const depCount = acts.length;
   if (depCount < 5) {
    for (const g of cycle) {
     const have = countItem(inv, g.id);
     const need = g.count - have;
     const row = bankItems.find((b: any) => b.id === g.id);
     if (need > 0 && row) pushCwWithdraw(acts, spec, row.slot, need, row.count);
    }
   }
   const tickActs = acts.slice(0, 5);
   if (tickActs.length <= 4) {
    tickActs.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
   }
   if (tickActs.length) await Promise.all(tickActs);
   await waitTicks(spec, 1);
  }
  await cutUnlockedGems(spec, target, deadline, undefined, idx < CRAFTING_CW_CYCLES.length - 1);
 }

 const level = skillLevel(spec, 'Crafting');
 const xp = skillXp(spec, 'Crafting');
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=crafting mode=cw level=${level} xp=${xp} ticks=${ticks}`,
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
 const cwMode = helpers.length === 1;
 assertCatalogItems(cwMode ? CRAFTING_CW_SUPPLY_BILL : CRAFTING_SUPPLY_BILL);
 if (!cwMode && helpers.length < CRAFTING_BATCHES.length) {
  throw Error(`crafting specialist requires ${CRAFTING_BATCHES.length} helpers (or 1 CW noted helper), got ${helpers.length}`);
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
  if (cwMode) {
   return await executeCraftingCastleWars(spec, target, start, deadline, () =>
    fastInProcessBatchTrade(spec, helpers[0]!, {
     giveIds: CRAFTING_CW_BATCH.give.map(g => g.id),
     returnIds: [],
     deadlineTick: deadline,
    }),
   );
  }
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
 opts: { cap: number; target?: number; cw?: boolean },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 const cwForced = !!opts.cw || process.env.CRAFTING_MODE === 'cw';
 assertCatalogItems(cwForced ? CRAFTING_CW_SUPPLY_BILL : CRAFTING_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('crafting external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 if (cwForced) {
  return executeCraftingCastleWars(spec, target, start, deadline, async () => {
   await fastTradeExternalReceive(spec, supplierNames, {
    acceptOffer: offer => CRAFTING_CW_BATCH.give.every(g => countItem(offer, g.id) >= g.count),
    deadlineTick: deadline,
   });
  });
 }
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
   acceptOffer: offer =>
    (i === 0 && CRAFTING_CW_BATCH.give.every(g => countItem(offer, g.id) >= g.count)) ||
    batch.give.every(g => countItem(offer, g.id) >= g.count),
   deadlineTick: deadline,
  });
  if (i === 0 && countItem(spec.sdk.getInventory(), ITEM_IDS.ring_of_dueling_8) > 0) {
   assertCatalogItems(CRAFTING_CW_SUPPLY_BILL);
   return executeCraftingCastleWars(spec, target, start, deadline, async () => {});
  }
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
