// Fresh-account 1-to-99 Runecraft specialist via Glory Air altar 1-to-20 and 22 Body altar runners.
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 findLocBy,
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
 runTo,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
 withSingleSpecialist,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

// Walkable exit_coord tiles adjacent to Air (2452) and Body (2457) Mysterious Ruins.
export const AIR_RUINS = { x: 2983, z: 3288, level: 0 } as const;
export const BODY_RUINS = { x: 3050, z: 3442, level: 0 } as const;
export const EDGEVILLE_BANK = { x: 3094, z: 3491, level: 0 } as const;
export const BODY_ALTAR_CRAFTER = { x: 2523, z: 4832, level: 0 } as const;
export const BODY_ALTAR_STAND = { x: 2523, z: 4833, level: 0 } as const;
export const BODY_RUNNER_COUNT = 22;

export const RUNECRAFT_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.amulet_of_glory_4, item: 'Amulet of glory(4)', count: 1 },
 { itemId: ITEM_IDS.air_talisman, item: 'Air talisman', count: 1 },
 { itemId: ITEM_IDS.body_talisman, item: 'Body talisman', count: 1 },
 { itemId: ITEM_IDS.blankrune, item: 'Rune essence', count: 25 + 22 * 26 + 177 * 27 },
];

type RcRunnerState = {
 session: Session;
 claimed: boolean;
 ready: boolean;
 lastUsedTick: number;
};

async function enterAltarWithTalisman(
 s: Session,
 talismanId: number,
 ruinsLocId: number,
 insideCheck: () => boolean,
 deadline: number,
 signal?: AbortSignal,
): Promise<void> {
 while (!signal?.aborted && s.tick() < deadline) {
  if (insideCheck()) return;
  const ruins = findLocBy(s, l => l.id === ruinsLocId || /mysterious ruins/i.test(l.name));
  const talisman = s.sdk.getInventory().find(i => i.id === talismanId);
  if (ruins && talisman) {
   await s.direct({
    type: 'useItemOnLoc',
    itemSlot: talisman.slot,
    x: ruins.x,
    z: ruins.z,
    locId: ruins.id,
    reason: 'SDK',
   });
  }
  await waitTicks(s, 1);
 }
 throw Error(`enterAltarWithTalisman(${talismanId}) exceeded cap`);
}

async function runBodyEssenceRunner(
 runner: RcRunnerState,
 done: () => boolean,
 deadline: number,
 signal: AbortSignal,
): Promise<void> {
 const s = runner.session;
 const keep = new Set<number>([ITEM_IDS.body_talisman]);
 const insideBody = () => {
  const p = playerPos(s);
  return !!p && p.worldZ > 4500 && p.worldX < 2600;
 };

 while (!done() && !signal.aborted && s.tick() < deadline) {
  if (runner.claimed) {
   await waitTicks(s, 1);
   continue;
  }
  const heldEss = countItem(s.sdk.getInventory(), ITEM_IDS.blankrune);
  if (insideBody()) {
   if (heldEss >= 26) {
    if (!nearTile(s, BODY_ALTAR_STAND.x, BODY_ALTAR_STAND.z, 0)) {
     await s.direct({ type: 'walkTo', x: BODY_ALTAR_STAND.x, z: BODY_ALTAR_STAND.z, running: true, reason: 'SDK' });
     await waitTicks(s, 1);
     continue;
    }
    runner.ready = true;
    await waitTicks(s, 1);
    continue;
   }
   runner.ready = false;
   const portal = findLocBy(s, l => l.id === 2470 || /portal/i.test(l.name));
   if (portal) {
    await s.direct({ type: 'interactLoc', x: portal.x, z: portal.z, locId: portal.id, optionIndex: 1, reason: 'SDK' });
   }
   await waitTicks(s, 1);
   continue;
  }

  runner.ready = false;
  if (heldEss < 26) {
   await restockAtBank(s, EDGEVILLE_BANK, ITEM_IDS.blankrune, 27, keep, done, deadline, signal);
  }
  if (done() || signal.aborted || s.tick() >= deadline) break;

  if (countItem(s.sdk.getInventory(), ITEM_IDS.blankrune) >= 26) {
   await navigateWorld(s, BODY_RUINS.x, BODY_RUINS.z, 0, Math.max(10, deadline - s.tick()), signal);
   if (done() || signal.aborted) break;
   await enterAltarWithTalisman(s, ITEM_IDS.body_talisman, 2457, insideBody, deadline, signal);
  } else {
   await waitTicks(s, 1);
  }
 }
}

async function craftAtAltar(spec: Session, altarId: number, deadline: number, preSentCraft = false): Promise<void> {
 const drainDelayAndDialogs = async (minTicks: number) => {
  for (let i = 0; i < minTicks && spec.tick() < deadline; i++) {
   if (spec.sdk.getState()?.dialog?.isOpen) {
    await spec.direct({ type: 'closeModal', reason: 'SDK' });
   }
   await waitTicks(spec, 1);
  }
  while (spec.tick() < deadline && spec.sdk.getState()?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
   await waitTicks(spec, 1);
  }
 };

 if (preSentCraft && countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0) {
  // Trade-confirm tick T already executed runecraft.rs2 (p_delay(3) -> delayedUntil = T+4); burstTradeHost returns at T+1, so drain 3 ticks.
  await drainDelayAndDialogs(3);
  return;
 }
 while (spec.tick() < deadline) {
  if (countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0) {
   await drainDelayAndDialogs(0);
   return;
  }
  const st = spec.sdk.getState();
  if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  const altar = findLocBy(spec, l => l.id === altarId || /altar/i.test(l.name));
  if (altar) {
   const sentTick = spec.tick();
   await spec.direct({ type: 'interactLoc', x: altar.x, z: altar.z, locId: altar.id, optionIndex: 1, reason: 'SDK' });
   const crafted = await waitUntil(
    spec,
    () => spec.tick() > sentTick && (countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0 || !!spec.sdk.getState()?.dialog?.isOpen),
    { timeoutTicks: 6 },
   );
   if (crafted && countItem(spec.sdk.getInventory(), ITEM_IDS.blankrune) === 0) {
    // runecraft.rs2 finishes with p_delay(3) after inv_del; finish the remaining delay ticks and all queued level-up modals.
    await drainDelayAndDialogs(4);
    return;
   }
  } else {
   await waitTicks(spec, 1);
  }
 }
 throw Error(`craftAtAltar(${altarId}) exceeded cap`);
}

export async function runRunecraftSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(RUNECRAFT_SUPPLY_BILL);
 if (helpers.length < 2) throw Error('runecraft specialist requires 1 Lumbridge starter and >=1 Body runner');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 let done = false;
 const ac = new AbortController();

 const [starterHelper, ...bodyHelpers] = helpers;
 const starterWaiter = (async () => {
  while (!done && !ac.signal.aborted && starterHelper!.tick() < deadline) await waitTicks(starterHelper!, 1);
 })();
 const runners: RcRunnerState[] = bodyHelpers.map(session => ({
  session,
  claimed: false,
  ready: false,
  lastUsedTick: -1,
 }));
 const runnerTasks = runners.map(r => runBodyEssenceRunner(r, () => done, deadline, ac.signal));

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);
  if (((spec.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) !== 1) {
   await spec.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
  }

  await burstTradeHost(spec, starterHelper!, {
   giveIds: [ITEM_IDS.amulet_of_glory_4, ITEM_IDS.air_talisman, ITEM_IDS.body_talisman, ITEM_IDS.blankrune],
   deadlineTick: deadline,
  });

  await rubJewelryTeleport(
   spec,
   GLORY_IDS,
   /draynor/i,
   () => {
    const p = playerPos(spec);
    return !!p && p.worldX < 3140 && p.worldZ < 3280;
   },
   deadline,
  );
  logPhase(spec, start, 'rc_glory_draynor');

  const draynorWalker = await sessionWalker(spec);
  const airWalk = await walkPath(
   draynorWalker,
   [
    { x: 3074, z: 3265, tol: 4 },
    { x: 3034, z: 3276, tol: 4 },
    { x: 3003, z: 3287, tol: 4 },
    { x: AIR_RUINS.x, z: AIR_RUINS.z, tol: 1 },
   ],
   { maxTicks: Math.max(10, Math.min(80, deadline - spec.tick())) },
  );
  if (!airWalk.ok && !nearTile(spec, AIR_RUINS.x, AIR_RUINS.z, 2)) {
   await navigateWorld(spec, AIR_RUINS.x, AIR_RUINS.z, 0, Math.max(10, deadline - spec.tick()));
  }
  await enterAltarWithTalisman(
   spec,
   ITEM_IDS.air_talisman,
   2452,
   () => {
    const p = playerPos(spec);
    return !!p && p.worldZ > 4500 && p.worldX > 2700;
   },
   deadline,
  );
  await craftAtAltar(spec, 2478, deadline);
  logPhase(spec, start, `rc_air_crafted lvl=${skillLevel(spec, 'Runecraft')}`);

  await rubJewelryTeleport(
   spec,
   GLORY_IDS,
   /edgeville/i,
   () => {
    const p = playerPos(spec);
    return !!p && p.worldX > 3060 && p.worldZ > 3460 && p.worldZ < 4000;
   },
   deadline,
  );

  const edgeWalker = await sessionWalker(spec);
  const bodyWalk = await walkPath(
   edgeWalker,
   [
    { x: 3080, z: 3467, tol: 4 },
    { x: 3071, z: 3420, tol: 4 },
    { x: 3061, z: 3423, tol: 3 },
    { x: BODY_RUINS.x, z: BODY_RUINS.z, tol: 1 },
   ],
   { maxTicks: Math.max(10, Math.min(60, deadline - spec.tick())) },
  );
  if (!bodyWalk.ok && !nearTile(spec, BODY_RUINS.x, BODY_RUINS.z, 2)) {
   await navigateWorld(spec, BODY_RUINS.x, BODY_RUINS.z, 0, Math.max(10, deadline - spec.tick()));
  }
  await enterAltarWithTalisman(
   spec,
   ITEM_IDS.body_talisman,
   2457,
   () => {
    const p = playerPos(spec);
    return !!p && p.worldZ > 4500 && p.worldX < 2600;
   },
   deadline,
  );

   // Drop Glory, talismans, and Air runes while walking to the Body altar stand so 27 inventory slots stay free.
   await dropItemsFast(spec, new Set([ITEM_IDS.bodyrune]), deadline);
   await runTo(spec, BODY_ALTAR_CRAFTER.x, BODY_ALTAR_CRAFTER.z, 0, 20);
   logPhase(spec, start, 'rc_at_body_altar');

   const bodyAltar = findLocBy(spec, l => l.id === 2483) ?? { x: 2524, z: 4832, id: 2483 };
   const pickReady = () =>
    runners
     .filter(
      r =>
       r.ready &&
       !r.claimed &&
       nearTile(r.session, BODY_ALTAR_STAND.x, BODY_ALTAR_STAND.z, 0) &&
       countItem(r.session.sdk.getInventory(), ITEM_IDS.blankrune) >= 26,
     )
     .sort((a, b) => a.lastUsedTick - b.lastUsedTick)[0];

   while (skillLevel(spec, 'Runecraft') < target && spec.tick() < deadline) {
    let next = pickReady();
    while (!next && spec.tick() < deadline) {
     await waitTicks(spec, 1);
     next = pickReady();
    }
    if (!next) throw Error('runecraft Body altar runners exhausted');
    next.claimed = true;
    next.ready = false;
    try {
     await burstTradeHost(spec, next.session, {
      giveIds: [ITEM_IDS.blankrune],
      deadlineTick: deadline,
      allowHelperOnSingleModal: true,
      confirmOverlapOnHelper: true,
      onConfirmSend: () =>
       spec.direct({ type: 'interactLoc', x: bodyAltar.x, z: bodyAltar.z, locId: bodyAltar.id, optionIndex: 1, reason: 'SDK' }),
     });
    } finally {
     next.lastUsedTick = spec.tick();
     next.claimed = false;
    }
    await craftAtAltar(spec, 2483, deadline, true);
   }

  const level = skillLevel(spec, 'Runecraft');
  const xp = skillXp(spec, 'Runecraft');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=runecraft level=${level} xp=${xp} ticks=${ticks}`,
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

export async function runRunecraftExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(RUNECRAFT_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('runecraft external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;

 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);

 const glorySet = new Set<number>(GLORY_IDS);
 await fastTradeExternalReceive(spec, supplierNames, {
  acceptOffer: offer =>
   offer.some(o => glorySet.has(o.id)) && offer.some(o => o.id === ITEM_IDS.body_talisman),
  deadlineTick: deadline,
 });

 await rubJewelryTeleport(
  spec,
  GLORY_IDS,
  /draynor/i,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldX < 3140 && p.worldZ < 3280;
  },
  deadline,
 );
 logPhase(spec, start, 'rc_glory_draynor');

 await navigateWorld(spec, AIR_RUINS.x, AIR_RUINS.z, 0, Math.max(10, deadline - spec.tick()));
 await enterAltarWithTalisman(
  spec,
  ITEM_IDS.air_talisman,
  2452,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldZ > 4500 && p.worldX > 2700;
  },
  deadline,
 );
 await craftAtAltar(spec, 2478, deadline);
 logPhase(spec, start, `rc_air_crafted lvl=${skillLevel(spec, 'Runecraft')}`);

 await rubJewelryTeleport(
  spec,
  GLORY_IDS,
  /edgeville/i,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldX > 3060 && p.worldZ > 3460 && p.worldZ < 4000;
  },
  deadline,
 );

 await navigateWorld(spec, BODY_RUINS.x, BODY_RUINS.z, 0, Math.max(10, deadline - spec.tick()));
 await enterAltarWithTalisman(
  spec,
  ITEM_IDS.body_talisman,
  2457,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldZ > 4500 && p.worldX < 2600;
  },
  deadline,
 );

 await dropItemsFast(spec, new Set([ITEM_IDS.bodyrune, ...GLORY_IDS]), deadline);
 await navigateWorld(spec, BODY_ALTAR_CRAFTER.x, BODY_ALTAR_CRAFTER.z, 0, Math.max(10, deadline - spec.tick()));
 if (!nearTile(spec, BODY_ALTAR_CRAFTER.x, BODY_ALTAR_CRAFTER.z, 0)) {
  await runTo(spec, BODY_ALTAR_CRAFTER.x, BODY_ALTAR_CRAFTER.z, 0, 20);
 }
 logPhase(spec, start, 'rc_at_body_altar');

 const runnerCooldowns = new Map<string, number>();
 const runnerLastTraded = new Map<string, number>();
 while (skillLevel(spec, 'Runecraft') < target && spec.tick() < deadline) {
  await fastTradeExternalReceive(spec, supplierNames, {
   acceptOffer: offer => offer.some(o => o.id === ITEM_IDS.blankrune) && offer.every(o => o.id === ITEM_IDS.blankrune),
   deadlineTick: deadline,
   maxDistance: 4,
   cooldownTicks: 45,
   cooldowns: runnerCooldowns,
   lastTradedTick: runnerLastTraded,
   canStand: p => Math.max(Math.abs((p.worldX ?? p.x) - BODY_ALTAR_STAND.x), Math.abs((p.worldZ ?? p.z) - BODY_ALTAR_STAND.z)) <= 3,
  });
  await craftAtAltar(spec, 2483, deadline);
 }

 const level = skillLevel(spec, 'Runecraft');
 const xp = skillXp(spec, 'Runecraft');
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=runecraft level=${level} xp=${xp} ticks=${ticks}`,
  ticks,
  level,
  xp,
 };
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 2300,
  target: 99,
  defaultHelpers: 1 + BODY_RUNNER_COUNT,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runRunecraftExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runRunecraftSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
