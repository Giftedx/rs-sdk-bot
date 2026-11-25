// Fresh-account 1-to-99 Prayer specialist using Draynor Bank dragon-bone runners and 2t-per-bone Lumbridge burying.
import type { Session } from '../packages/core/src/inprocess';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 goalXp,
 ITEM_IDS,
 logPhase,
 LUMBRIDGE_COURTYARD,
 navigateWorld,
 nearTile,
 parseExternalSuppliers,
 parseSpecialistArgs,
 playerPos,
 restockAtBank,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSingleSpecialist,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const DRAYNOR_BANK = { x: 3092, z: 3243, level: 0 } as const;
export const PRAYER_BONES_NEEDED = 555;
export const PRAYER_RUNNER_COUNT = 8;

export const PRAYER_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.dragon_bones, item: 'Dragon bones', count: PRAYER_BONES_NEEDED },
];

type RunnerState = {
 session: Session;
 claimed: boolean;
 ready: boolean;
};

async function restockBonesAtDraynor(
 runner: RunnerState,
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
  const held = countItem(s.sdk.getInventory(), ITEM_IDS.dragon_bones);
  if (held >= 28 && nearTile(s, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 2)) {
   runner.ready = true;
   await waitTicks(s, 1);
   continue;
  }
  runner.ready = false;
  if (held < 28) {
   const got = await restockAtBank(s, DRAYNOR_BANK, ITEM_IDS.dragon_bones, 28, keep, done, deadline, signal);
   if (!got) {
    if (done() || signal.aborted) break;
    await waitTicks(s, 1);
    continue;
   }
  }
  if (!done() && !signal.aborted && countItem(s.sdk.getInventory(), ITEM_IDS.dragon_bones) > 0) {
   await navigateWorld(s, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 0, Math.max(10, deadline - s.tick()), signal);
   runner.ready = nearTile(s, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 2);
  }
  if (done() || signal.aborted) break;
  await waitTicks(s, 1);
 }
}

async function buryAllBones(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Prayer') >= target) return;
  const bone = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.dragon_bones);
  if (!bone) return;
  const st = spec.sdk.getState();
  const acts: Promise<unknown>[] = [];
  if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
   acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  }
  acts.push(spec.direct({ type: 'useInventoryItem', slot: bone.slot, optionIndex: 1, reason: 'SDK' }));
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 throw Error('prayer burying exceeded cap');
}

export async function runPrayerSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(PRAYER_SUPPLY_BILL);
 if (helpers.length < 1) throw Error('prayer specialist requires at least 1 helper');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 let done = false;
 const ac = new AbortController();

 const runners: RunnerState[] = helpers.map(session => ({
  session,
  claimed: false,
  ready: countItem(session.sdk.getInventory(), ITEM_IDS.dragon_bones) >= 28 && nearTile(session, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 3),
 }));
 const tasks = runners.map(r => restockBonesAtDraynor(r, () => done, deadline, ac.signal));

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);
  logPhase(spec, start, 'prayer_ready');

  while (skillLevel(spec, 'Prayer') < target && spec.tick() < deadline) {
   if (countItem(spec.sdk.getInventory(), ITEM_IDS.dragon_bones) === 0) {
    let next = runners.find(r => r.ready && !r.claimed && countItem(r.session.sdk.getInventory(), ITEM_IDS.dragon_bones) > 0);
    while (!next && spec.tick() < deadline) {
     await waitTicks(spec, 1);
     next = runners.find(r => r.ready && !r.claimed && countItem(r.session.sdk.getInventory(), ITEM_IDS.dragon_bones) > 0);
    }
    if (!next) throw Error('prayer runners exhausted before target');
    next.claimed = true;
    next.ready = false;
    try {
     await burstTradeHost(spec, next.session, {
      giveIds: [ITEM_IDS.dragon_bones],
      deadlineTick: deadline,
      allowHelperOnSingleModal: true,
      onConfirmSend: () => spec.direct({ type: 'useInventoryItem', slot: 0, optionIndex: 1, reason: 'SDK' }),
     });
    } finally {
     next.claimed = false;
    }
   }
   await buryAllBones(spec, target, deadline);
  }

  const level = skillLevel(spec, 'Prayer');
  const xp = skillXp(spec, 'Prayer');
  const pos = playerPos(spec);
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=prayer level=${level} xp=${xp} ticks=${ticks} at=${pos?.worldX},${pos?.worldZ}`,
   ticks,
   level,
   xp,
  };
 } finally {
  done = true;
  ac.abort();
  await Promise.allSettled(tasks);
 }
}

export async function runPrayerExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(PRAYER_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('prayer external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);
 if (!nearTile(spec, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 2)) {
  await navigateWorld(spec, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 0, Math.max(10, deadline - spec.tick()));
 }
 logPhase(spec, start, 'prayer_ready');

 const cooldowns = new Map<string, number>();
 const lastTradedTick = new Map<string, number>();
 while (skillLevel(spec, 'Prayer') < target && spec.tick() < deadline) {
  if (countItem(spec.sdk.getInventory(), ITEM_IDS.dragon_bones) === 0) {
   await fastTradeExternalReceive(spec, supplierNames, {
    acceptOffer: offer =>
     offer.some(o => o.id === ITEM_IDS.dragon_bones) &&
     offer.every(o => o.id === ITEM_IDS.dragon_bones),
    deadlineTick: deadline,
    maxDistance: 4,
    cooldownTicks: 40,
    cooldowns,
    lastTradedTick,
    canStand: p =>
     Math.max(Math.abs((p.worldX ?? p.x) - LUMBRIDGE_COURTYARD.x), Math.abs((p.worldZ ?? p.z) - LUMBRIDGE_COURTYARD.z)) <= 3,
   });
  }
  await buryAllBones(spec, target, deadline);
 }

 const level = skillLevel(spec, 'Prayer');
 const xp = skillXp(spec, 'Prayer');
 const pos = playerPos(spec);
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=prayer level=${level} xp=${xp} ticks=${ticks} at=${pos?.worldX},${pos?.worldZ}`,
  ticks,
  level,
  xp,
 };
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 1350,
  target: 99,
  defaultHelpers: PRAYER_RUNNER_COUNT,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runPrayerExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runPrayerSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
