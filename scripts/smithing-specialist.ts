// Fresh-account 1-to-99 Smithing specialist via Glory-to-Edgeville, Varrock West bank runners, and platebody burst smithing.
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import { smithRecipe } from '../packages/workers/src/bank-artisan';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 goalXp,
 GLORY_IDS,
 ITEM_IDS,
 logPhase,
 navigateWorld,
 nearTile,
 parseExternalSuppliers,
 parseSpecialistArgs,
 playerPos,
 restockAtBank,
 rubJewelryTeleport,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
 withSingleSpecialist,
 withSpecialistFleet,
 xpForLevel,
 type SupplyEntry,
} from './fast-skills-lib';

export const VARROCK_WEST_BANK = { x: 3185, z: 3436, level: 0 } as const;
export const VARROCK_WEST_ANVIL = { x: 3188, z: 3426, level: 0 } as const;
export const SMITHING_INTERFACE = 994;

export const SMITH_PRODUCTS = {
 bronze_dagger: 1205,
 bronze_warhammer: 1337,
 iron_dagger: 1203,
 iron_warhammer: 1335,
 iron_platebody: 1115,
 steel_platebody: 1119,
 mithril_platebody: 1121,
 adamant_platebody: 1123,
} as const;

export interface SmithRunnerDelivery {
 barId: number;
 count: number;
}

export const SMITHING_RUNNER_QUEUE: readonly SmithRunnerDelivery[] = [
 { barId: ITEM_IDS.iron_bar, count: 25 },
 ...Array.from({ length: 4 }, () => ({ barId: ITEM_IDS.steel_bar, count: 25 })),
 ...Array.from({ length: 11 }, () => ({ barId: ITEM_IDS.mithril_bar, count: 25 })),
 ...Array.from({ length: 15 }, () => ({ barId: ITEM_IDS.adamantite_bar, count: 25 })),
];

export const SMITHING_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.hammer, item: 'Hammer', count: 1 },
 { itemId: ITEM_IDS.amulet_of_glory_4, item: 'Amulet of glory(4)', count: 1 },
 { itemId: ITEM_IDS.bronze_bar, item: 'Bronze bar', count: 9 },
 { itemId: ITEM_IDS.iron_bar, item: 'Iron bar', count: 42 },
 { itemId: ITEM_IDS.steel_bar, item: 'Steel bar', count: 100 },
 { itemId: ITEM_IDS.mithril_bar, item: 'Mithril bar', count: 275 },
 { itemId: ITEM_IDS.adamantite_bar, item: 'Adamantite bar', count: 375 },
];

type SmithRunnerState = {
 session: Session;
 task: SmithRunnerDelivery | null;
 claimed: boolean;
 ready: boolean;
};

function selectProductForInventory(lvl: number, inv: readonly { id: number; count: number }[]): number | null {
 const bronze = countItem(inv, ITEM_IDS.bronze_bar);
 if (bronze >= 3 && lvl >= 9) return SMITH_PRODUCTS.bronze_warhammer;
 if (bronze >= 1) return SMITH_PRODUCTS.bronze_dagger;
 const iron = countItem(inv, ITEM_IDS.iron_bar);
 if (iron >= 5 && lvl >= 33) return SMITH_PRODUCTS.iron_platebody;
 if (iron >= 3 && lvl >= 24 && lvl < 33) return SMITH_PRODUCTS.iron_warhammer;
 if (iron >= 1 && (lvl < 33 || lvl >= 48 || iron < 5)) return SMITH_PRODUCTS.iron_dagger;
 if (countItem(inv, ITEM_IDS.steel_bar) >= 5 && lvl >= 48) return SMITH_PRODUCTS.steel_platebody;
 if (countItem(inv, ITEM_IDS.mithril_bar) >= 5 && lvl >= 68) return SMITH_PRODUCTS.mithril_platebody;
 if (countItem(inv, ITEM_IDS.adamantite_bar) >= 5 && lvl >= 88) return SMITH_PRODUCTS.adamant_platebody;
 return null;
}

function nextWantedBarId(lvl: number): number {
 if (lvl < 48) return ITEM_IDS.iron_bar;
 if (lvl < 68) return ITEM_IDS.steel_bar;
 if (lvl < 88) return ITEM_IDS.mithril_bar;
 return ITEM_IDS.adamantite_bar;
}

const SMITH_BAR_XP: Record<number, number> = {
 [ITEM_IDS.iron_bar]: 625,
 [ITEM_IDS.steel_bar]: 937.5,
 [ITEM_IDS.mithril_bar]: 1250,
 [ITEM_IDS.adamantite_bar]: 1562.5,
};

function anvilRoomOk(pos: { worldX: number; worldZ: number; level: number } | null): boolean {
 return !!pos && pos.level === 0 && pos.worldZ >= 3424 && pos.worldX >= 3182 && pos.worldX <= 3190;
}

function nextDeliveryForCommittedXp(committedXp: number): SmithRunnerDelivery {
 if (committedXp < xpForLevel(48)) return { barId: ITEM_IDS.iron_bar, count: 25 };
 if (committedXp < xpForLevel(68)) return { barId: ITEM_IDS.steel_bar, count: 25 };
 if (committedXp < xpForLevel(88)) return { barId: ITEM_IDS.mithril_bar, count: 25 };
 return { barId: ITEM_IDS.adamantite_bar, count: 25 };
}

function isBarObsoleteForLevel(barId: number, specLvl: number): boolean {
 if (barId === ITEM_IDS.iron_bar) return specLvl >= 48;
 if (barId === ITEM_IDS.steel_bar) return specLvl >= 68;
 if (barId === ITEM_IDS.mithril_bar) return specLvl >= 88;
 return false;
}

async function runVarrockSmithRunner(
 runner: SmithRunnerState,
 spec: Session,
 claimNextDelivery: (exclude: SmithRunnerState) => SmithRunnerDelivery,
 done: () => boolean,
 deadline: number,
 signal: AbortSignal,
): Promise<void> {
 const s = runner.session;
 const keep = new Set<number>();
 while (!done() && !signal.aborted && s.tick() < deadline) {
  if (runner.claimed) {
   await waitTicks(s, 1);
   continue;
  }
  if (runner.task) {
   if (isBarObsoleteForLevel(runner.task.barId, skillLevel(spec, 'Smithing'))) {
    runner.ready = false;
    runner.task = null;
    continue;
   }
   const held = countItem(s.sdk.getInventory(), runner.task.barId);
   if (held >= runner.task.count) {
    const pos = playerPos(s);
    if (!nearTile(s, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 2) || !anvilRoomOk(pos)) {
     await navigateWorld(s, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 0, Math.max(10, deadline - s.tick()), signal);
    }
    if (done() || signal.aborted) break;
    runner.ready = nearTile(s, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 2) && anvilRoomOk(playerPos(s)) && held >= runner.task.count;
    await waitTicks(s, 1);
    continue;
   }
   runner.task = null;
   runner.ready = false;
  }

  runner.task = claimNextDelivery(runner);
  runner.ready = false;

  if (countItem(s.sdk.getInventory(), runner.task.barId) < runner.task.count) {
   await restockAtBank(s, VARROCK_WEST_BANK, runner.task.barId, runner.task.count, keep, done, deadline, signal);
  }
 }
}

async function smithHeldBars(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Smithing') >= target) return;
  const inv = spec.sdk.getInventory();
  const product = selectProductForInventory(skillLevel(spec, 'Smithing'), inv);
  if (product === null) return;
  const r = smithRecipe(product);
  const st = () => spec.sdk.getState();
  const ifaceOpen = () => !!st()?.interface?.isOpen && st()?.interface?.interfaceId === SMITHING_INTERFACE;

  if (!ifaceOpen()) {
   const anvil = spec.sdk.findNearbyLoc(/^anvil$/i);
   const bar = spec.sdk.getInventory().find(i => i.id === r.bar);
   if (!anvil || !bar) throw Error(`smithing anvil or bar ${r.bar} missing`);
   const sentTick = spec.tick();
   if (st()?.dialog?.isOpen && !st()?.trade?.isOpen) {
    await spec.direct({ type: 'closeModal', reason: 'SDK' });
   }
   await spec.direct({ type: 'useItemOnLoc', itemSlot: bar.slot, x: anvil.x, z: anvil.z, locId: anvil.id, reason: 'SDK' });
   await waitUntil(spec, () => spec.tick() > sentTick && (ifaceOpen() || !!st()?.dialog?.isOpen), { timeoutTicks: 8 });
   if (!ifaceOpen()) continue;
  }

  const beforeBars = countItem(spec.sdk.getInventory(), r.bar);
  const lvl = skillLevel(spec, 'Smithing');
  const useMake10 = product === SMITH_PRODUCTS.bronze_dagger && beforeBars >= 9;
  const useMake5 = !useMake10 && (r.bars === 5 || product === SMITH_PRODUCTS.bronze_warhammer || (product === SMITH_PRODUCTS.iron_dagger && beforeBars >= 17 && lvl < 24));
  const optionIndex = useMake10 ? 3 : useMake5 ? 2 : 1;
  const sentTick = spec.tick();
  await spec.direct({
   type: 'clickComponentWithOption',
   componentId: r.component,
   optionIndex,
   slot: r.slot,
   reason: 'SDK',
  });
  await waitUntil(
   spec,
   () => {
    if (spec.tick() <= sentTick) return false;
    if (skillLevel(spec, 'Smithing') >= target) return true;
    const nowBars = countItem(spec.sdk.getInventory(), r.bar);
    if (useMake10) return nowBars === 0;
    if (useMake5) return product === SMITH_PRODUCTS.iron_dagger ? beforeBars - nowBars >= 5 || nowBars === 0 : nowBars < r.bars;
    return nowBars < beforeBars;
   },
   { timeoutTicks: useMake10 ? 50 : useMake5 ? 30 : 8 },
  );
 }
 throw Error('smithing loop exceeded cap');
}

export async function runSmithingSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(SMITHING_SUPPLY_BILL);
 if (helpers.length < 3) throw Error('smithing specialist requires 1 Lumbridge starter and 2 Varrock runners');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 let done = false;
 const ac = new AbortController();

 const [starterHelper, ...varrockHelpers] = helpers as [Session, Session, Session, ...Session[]];
 const initialTaskFor = (idx: number): SmithRunnerDelivery =>
  idx === 0 ? { barId: ITEM_IDS.iron_bar, count: 25 } : { barId: ITEM_IDS.steel_bar, count: 25 };
 const runners: SmithRunnerState[] = varrockHelpers.map((session, idx) => ({
  session,
  task: initialTaskFor(idx),
  claimed: false,
  ready: false,
 }));

 const committedXp = (exclude: SmithRunnerState): number => {
  let xp = skillXp(spec, 'Smithing');
  for (const item of spec.sdk.getInventory()) {
   xp += (SMITH_BAR_XP[item.id] ?? 0) * item.count;
  }
  for (const r of runners) {
   if (r === exclude || !r.task) continue;
   xp += (SMITH_BAR_XP[r.task.barId] ?? 0) * r.task.count;
  }
  return xp;
 };
 const claimNextDelivery = (exclude: SmithRunnerState): SmithRunnerDelivery =>
  nextDeliveryForCommittedXp(committedXp(exclude));

 const starterWaiter = (async () => {
  while (!done && !ac.signal.aborted && starterHelper.tick() < deadline) await waitTicks(starterHelper, 1);
 })();
 const runnerTasks = runners.map(r => runVarrockSmithRunner(r, spec, claimNextDelivery, () => done, deadline, ac.signal));

 const keepSet = new Set<number>([
  ITEM_IDS.hammer,
  ITEM_IDS.bronze_bar,
  ITEM_IDS.iron_bar,
  ITEM_IDS.steel_bar,
  ITEM_IDS.mithril_bar,
  ITEM_IDS.adamantite_bar,
 ]);

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  await burstTradeHost(spec, starterHelper, {
   giveIds: [ITEM_IDS.hammer, ITEM_IDS.amulet_of_glory_4, ITEM_IDS.bronze_bar, ITEM_IDS.iron_bar],
   deadlineTick: deadline,
  });

  await rubJewelryTeleport(
   spec,
   GLORY_IDS,
   /edgeville/i,
   () => {
    const p = playerPos(spec);
    return !!p && p.worldX < 3120 && p.worldZ > 3460;
   },
   deadline,
  );
  logPhase(spec, start, 'smithing_glory_edgeville');

  const walkEdgeToVarrock = await sessionWalker(spec);
  if (((spec.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) !== 1) {
   await spec.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
  }
  const vWalk = await walkPath(
   walkEdgeToVarrock,
   [
    { x: 3080, z: 3467, tol: 4 },
    { x: 3090, z: 3444, tol: 4 },
    { x: 3100, z: 3421, tol: 3 },
    { x: 3158, z: 3418, tol: 4 },
    { x: 3181, z: 3426, tol: 2 },
    { x: VARROCK_WEST_ANVIL.x, z: VARROCK_WEST_ANVIL.z, tol: 0 },
   ],
   { maxTicks: Math.max(10, Math.min(95, deadline - spec.tick())) },
  );
  if (!vWalk.ok && !nearTile(spec, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 0)) {
   await navigateWorld(spec, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 0, Math.max(10, deadline - spec.tick()));
  }
  logPhase(spec, start, 'smithing_at_anvil');
  await smithHeldBars(spec, target, deadline);
  await dropItemsFast(spec, keepSet, deadline);

  const anvilLoc = spec.sdk.findNearbyLoc(/^anvil$/i) ?? { x: 3188, z: 3426, id: 2783 };
  let lastRunnerIdx = runners.length - 1;
  while (skillLevel(spec, 'Smithing') < target && spec.tick() < deadline) {
   const wantBar = nextWantedBarId(skillLevel(spec, 'Smithing'));
   const pickRunner = () => {
    for (let offset = 1; offset <= runners.length; offset++) {
     const idx = (lastRunnerIdx + offset) % runners.length;
     const r = runners[idx]!;
     if (
      r.ready &&
      !r.claimed &&
      r.task?.barId === wantBar &&
      anvilRoomOk(playerPos(r.session)) &&
      countItem(r.session.sdk.getInventory(), wantBar) >= r.task.count
     ) {
      lastRunnerIdx = idx;
      return r;
     }
    }
    return undefined;
   };
   let next = pickRunner();
   while (!next && spec.tick() < deadline) {
    await waitTicks(spec, 1);
    next = pickRunner();
   }
   if (!next) throw Error(`smithing runner missing bar ${wantBar}`);
   next.claimed = true;
   next.ready = false;
   const hammerOnly = spec.sdk.getInventory().length === 1 && spec.sdk.getInventory()[0]?.id === ITEM_IDS.hammer;
   const barSlot = hammerOnly && spec.sdk.getInventory()[0]!.slot === 0 ? 1 : hammerOnly ? 0 : -1;
   try {
    await burstTradeHost(spec, next.session, {
     giveIds: [wantBar],
     deadlineTick: deadline,
     canStand: anvilRoomOk,
     onConfirmSend: barSlot >= 0
      ? () => spec.direct({ type: 'useItemOnLoc', itemSlot: barSlot, x: anvilLoc.x, z: anvilLoc.z, locId: anvilLoc.id, reason: 'SDK' })
      : undefined,
    });
    next.task = null;
   } finally {
    next.claimed = false;
   }
   await smithHeldBars(spec, target, deadline);
   if (skillLevel(spec, 'Smithing') < target) {
    await dropItemsFast(spec, keepSet, deadline);
   }
  }

  const level = skillLevel(spec, 'Smithing');
  const xp = skillXp(spec, 'Smithing');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=smithing level=${level} xp=${xp} ticks=${ticks}`,
   ticks,
   level,
   xp,
  };
 } finally {
  done = true;
  ac.abort();
  await Promise.allSettled([starterWaiter, ...runnerTasks]);
 }
}

export async function runSmithingExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(SMITHING_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('smithing external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 const keepSet = new Set<number>([
  ITEM_IDS.hammer,
  ITEM_IDS.bronze_bar,
  ITEM_IDS.iron_bar,
  ITEM_IDS.steel_bar,
  ITEM_IDS.mithril_bar,
  ITEM_IDS.adamantite_bar,
 ]);

 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);

 const starterTargets = supplierNames.length >= 2 ? [supplierNames[0]!] : supplierNames;
 await fastTradeExternalReceive(spec, starterTargets, {
  acceptOffer: offer =>
   offer.some(o => o.id === ITEM_IDS.hammer) && offer.some(o => o.id === ITEM_IDS.amulet_of_glory_4),
  deadlineTick: deadline,
 });

 await rubJewelryTeleport(
  spec,
  GLORY_IDS,
  /edgeville/i,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldX < 3120 && p.worldZ > 3460;
  },
  deadline,
 );
 logPhase(spec, start, 'smithing_glory_edgeville');

 await navigateWorld(spec, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 0, Math.max(10, deadline - spec.tick()));
 logPhase(spec, start, 'smithing_at_anvil');
 await smithHeldBars(spec, target, deadline);
 await dropItemsFast(spec, keepSet, deadline);

 const runnerNames = supplierNames.length >= 2 ? supplierNames.slice(1) : supplierNames;
 const cooldowns = new Map<string, number>();
 const lastTradedTick = new Map<string, number>();
 while (skillLevel(spec, 'Smithing') < target && spec.tick() < deadline) {
  const wantBar = nextWantedBarId(skillLevel(spec, 'Smithing'));
  await fastTradeExternalReceive(spec, runnerNames, {
   acceptOffer: offer => offer.some(o => o.id === wantBar) && offer.every(o => o.id === wantBar),
   deadlineTick: deadline,
   maxDistance: 4,
   cooldownTicks: 15,
   cooldowns,
   lastTradedTick,
   canStand: p =>
    (p.worldZ ?? p.z) <= 3429 &&
    anvilRoomOk({ worldX: p.worldX ?? p.x, worldZ: p.worldZ ?? p.z, level: 0 }),
  });
  await smithHeldBars(spec, target, deadline);
  if (skillLevel(spec, 'Smithing') < target) {
   await dropItemsFast(spec, keepSet, deadline);
  }
 }

 const level = skillLevel(spec, 'Smithing');
 const xp = skillXp(spec, 'Smithing');
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=smithing level=${level} xp=${xp} ticks=${ticks}`,
  ticks,
  level,
  xp,
 };
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 1350,
  target: 99,
  defaultHelpers: 3,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runSmithingExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runSmithingSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
