// Fresh-account 1-to-99 Prayer specialist using Draynor Bank dragon-bone runners and 2t-per-bone Lumbridge burying.
import type { Session } from '../packages/core/src/inprocess';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 goalXp,
 ITEM_IDS,
 LUMBRIDGE_COURTYARD,
 navigateWorld,
 nearTile,
 parseSpecialistArgs,
 playerPos,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const DRAYNOR_BANK = { x: 3092, z: 3245, level: 0 } as const;
export const PRAYER_BONES_NEEDED = 555;
export const PRAYER_RUNNER_COUNT = 5;

export const PRAYER_SUPPLY_BILL: readonly SupplyEntry[] = [
 { itemId: ITEM_IDS.dragon_bones, item: 'Dragon bones', count: PRAYER_BONES_NEEDED },
];

type RunnerState = {
 session: Session;
 claimed: boolean;
 ready: boolean;
};

async function restockBonesAtDraynor(runner: RunnerState, done: () => boolean, deadline: number): Promise<void> {
 const s = runner.session;
 while (!done() && s.tick() < deadline) {
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
   await navigateWorld(s, DRAYNOR_BANK.x, DRAYNOR_BANK.z, 0, Math.max(10, deadline - s.tick()));
   while (!done() && s.tick() < deadline && !s.sdk.getState()?.bank?.isOpen) {
    await s.bot.openBank();
    if (!s.sdk.getState()?.bank?.isOpen) await waitTicks(s, 1);
   }
   if (done() || s.tick() >= deadline) break;
   const bankItem = s.sdk.getState()?.bank?.items?.find((i: any) => i.id === ITEM_IDS.dragon_bones);
   if (bankItem && bankItem.count > 0) {
    const need = Math.min(28 - countItem(s.sdk.getInventory(), ITEM_IDS.dragon_bones), bankItem.count);
    if (need > 0) await s.bot.withdrawItem(bankItem, need, { asNote: false });
   }
   if (s.sdk.getState()?.bank?.isOpen) await s.bot.closeBank();
  }
  if (countItem(s.sdk.getInventory(), ITEM_IDS.dragon_bones) > 0) {
   await navigateWorld(s, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 0, Math.max(10, deadline - s.tick()));
   runner.ready = true;
  }
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

 const runners: RunnerState[] = helpers.map(session => ({
  session,
  claimed: false,
  ready: countItem(session.sdk.getInventory(), ITEM_IDS.dragon_bones) >= 28 && nearTile(session, LUMBRIDGE_COURTYARD.x, LUMBRIDGE_COURTYARD.z, 3),
 }));
 const tasks = runners.map(r => restockBonesAtDraynor(r, () => done, deadline));

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

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
  await Promise.allSettled(tasks);
 }
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 1350,
  target: 99,
  defaultHelpers: PRAYER_RUNNER_COUNT,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runPrayerSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
