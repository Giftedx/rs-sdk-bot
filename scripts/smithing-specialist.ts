// Fresh-account 1-to-99 Smithing specialist via Glory-to-Edgeville, Varrock West bank runners, and platebody burst smithing.
import type { Session } from '../packages/core/src/inprocess';
import { smithRecipe } from './smith-batch';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 goalXp,
 GLORY_IDS,
 ITEM_IDS,
 logPhase,
 navigateWorld,
 nearTile,
 parseSpecialistArgs,
 playerPos,
 restockAtBank,
 rubJewelryTeleport,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
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

  const useMake5 = r.bars === 5 || product === SMITH_PRODUCTS.bronze_warhammer;
  const beforeBars = countItem(spec.sdk.getInventory(), r.bar);
  const sentTick = spec.tick();
  await spec.direct({
   type: 'clickComponentWithOption',
   componentId: r.component,
   optionIndex: useMake5 ? 2 : 1,
   slot: r.slot,
   reason: 'SDK',
  });
  await waitUntil(
   spec,
   () => {
    if (spec.tick() <= sentTick) return false;
    if (skillLevel(spec, 'Smithing') >= target || st()?.dialog?.isOpen) return true;
    const nowBars = countItem(spec.sdk.getInventory(), r.bar);
    return useMake5 ? nowBars < r.bars : nowBars < beforeBars;
   },
   { timeoutTicks: useMake5 ? 30 : 8 },
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

 const [starterHelper, runnerC, runnerD] = helpers as [Session, Session, Session, ...Session[]];
 const runners: SmithRunnerState[] = [
  { session: runnerC, task: { barId: ITEM_IDS.iron_bar, count: 25 }, claimed: false, ready: false },
  { session: runnerD, task: { barId: ITEM_IDS.steel_bar, count: 25 }, claimed: false, ready: false },
 ];

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
  ...GLORY_IDS,
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

  await navigateWorld(spec, VARROCK_WEST_ANVIL.x, VARROCK_WEST_ANVIL.z, 0, Math.max(10, deadline - spec.tick()));
  logPhase(spec, start, 'smithing_at_anvil');
  await smithHeldBars(spec, target, deadline);
  await dropItemsFast(spec, keepSet, deadline);

  let lastRunnerIdx = 1;
  while (skillLevel(spec, 'Smithing') < target && spec.tick() < deadline) {
   const wantBar = nextWantedBarId(skillLevel(spec, 'Smithing'));
   const pickRunner = () => {
    const order = [1 - lastRunnerIdx, lastRunnerIdx];
    for (const idx of order) {
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
   try {
    await burstTradeHost(spec, next.session, {
     giveIds: [wantBar],
     deadlineTick: deadline,
     canStand: anvilRoomOk,
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

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 1350,
  target: 99,
  defaultHelpers: 3,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runSmithingSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
