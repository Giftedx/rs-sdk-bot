// Fresh-account 1-to-99 Herblore specialist via Games necklace Druidic Ritual (+6,250 XP) and Edgeville 4-tick 10-potion bank cycles.
import type { Session } from '../packages/core/src/inprocess';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 findLocBy,
 findNpcBy,
 GAMES_NECKLACE_IDS,
 GLORY_IDS,
 goalXp,
 ITEM_IDS,
 loadItemCatalog,
 logPhase,
 navigateWorld,
 nearTile,
 parseExternalSuppliers,
 parseSpecialistArgs,
 playerPos,
 rubJewelryTeleport,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 withSingleSpecialist,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const KAQEMEEX_SPOT = { x: 2925, z: 3486, level: 0 } as const;
export const HERBLORE_BANK_SPOT = { x: 3094, z: 3491, level: 0 } as const;
export const HERBLORE_BANK_HELPER_SPOT = { x: 3094, z: 3492, level: 0 } as const;

const GLORY_SET = new Set<number>(GLORY_IDS);

export interface HerbPotionRecipe {
 name: string;
 level: number;
 xp: number;
 unf: number;
 sec: number;
 out: number;
}

export const HERB_POTION_TIERS: readonly HerbPotionRecipe[] = [
 { name: 'Attack', level: 3, xp: 625, unf: ITEM_IDS.guamvial, sec: ITEM_IDS.eye_of_newt, out: 121 },
 { name: 'Antipoison', level: 5, xp: 937.5, unf: ITEM_IDS.marrentillvial, sec: ITEM_IDS.unicorn_horn_dust, out: 175 },
 { name: 'Strength', level: 12, xp: 1250, unf: ITEM_IDS.tarrominvial, sec: ITEM_IDS.limpwurt_root, out: 115 },
 { name: 'Energy', level: 26, xp: 1687.5, unf: ITEM_IDS.harralandervial, sec: ITEM_IDS.chocolate_dust, out: 3010 },
 { name: 'Prayer', level: 38, xp: 2187.5, unf: ITEM_IDS.ranarrvial, sec: ITEM_IDS.snape_grass, out: 139 },
 { name: 'Super attack', level: 45, xp: 2500, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.eye_of_newt, out: 145 },
 { name: 'Super antipoison', level: 48, xp: 2657.5, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.unicorn_horn_dust, out: 181 },
 { name: 'Fishing', level: 50, xp: 2812.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.snape_grass, out: 151 },
 { name: 'Super energy', level: 52, xp: 2937.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.mortmyremushroom, out: 3018 },
 { name: 'Super strength', level: 55, xp: 3125, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.limpwurt_root, out: 157 },
 { name: 'Weapon poison', level: 60, xp: 3437.5, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.dragon_scale_dust, out: 187 },
 { name: 'Super restore', level: 63, xp: 3562.5, unf: ITEM_IDS.snapdragonvial, sec: ITEM_IDS.red_spiders_eggs, out: 3026 },
 { name: 'Super defence', level: 66, xp: 3750, unf: ITEM_IDS.cadantinevial, sec: ITEM_IDS.white_berries, out: 163 },
 { name: 'Antifire', level: 69, xp: 3937.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.dragon_scale_dust, out: 2454 },
 { name: 'Ranging', level: 72, xp: 4062.5, unf: ITEM_IDS.dwarfweedvial, sec: ITEM_IDS.wine_of_zamorak, out: 169 },
 { name: 'Magic', level: 76, xp: 4312.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.cactus_potato, out: 3042 },
 { name: 'Zamorak', level: 78, xp: 4375, unf: ITEM_IDS.torstolvial, sec: ITEM_IDS.jangerberries, out: ITEM_IDS.zamorak_brew_3 },
];

export const POTION_OUTPUT_IDS = {
 energy_3: 3010,
 prayer_3: 139,
 super_attack_3: 145,
 super_antipoison_3: 181,
 fishing_3: 151,
 super_energy_3: 3018,
 super_strength_3: 157,
 weapon_poison: 187,
 super_restore_3: 3026,
 super_defence_3: 163,
 antifire_3: 2454,
 ranging_3: 169,
 magic_3: 3042,
 zamorak_3: ITEM_IDS.zamorak_brew_3,
} as const;

export interface HerbloreNotedSupply {
 readonly id: number;
 readonly certId: number;
 readonly count: number;
}

export const HERBLORE_NOTED_SUPPLIES: readonly HerbloreNotedSupply[] = [
 { id: ITEM_IDS.harralandervial, certId: 98, count: 10 },
 { id: ITEM_IDS.chocolate_dust, certId: 1976, count: 10 },
 { id: ITEM_IDS.iritvial, certId: 102, count: 10 },
 { id: ITEM_IDS.eye_of_newt, certId: 222, count: 10 },
 { id: ITEM_IDS.kwuarmvial, certId: 106, count: 30 },
 { id: ITEM_IDS.limpwurt_root, certId: 226, count: 10 },
 { id: ITEM_IDS.dragon_scale_dust, certId: 242, count: 50 },
 { id: ITEM_IDS.lantadymevial, certId: 2484, count: 30 },
 { id: ITEM_IDS.torstolvial, certId: 112, count: 170 },
 { id: ITEM_IDS.jangerberries, certId: 248, count: 170 },
];

export const HERBLORE_BANK_CYCLES: readonly { unf: number; sec: number; out: number }[] = [
 // C1: Energy x10 (6,250 -> 23,125, Lv 45)
 { unf: ITEM_IDS.harralandervial, sec: ITEM_IDS.chocolate_dust, out: POTION_OUTPUT_IDS.energy_3 },
 // C2: Super attack x10 (23,125 -> 48,125, Lv 55)
 { unf: ITEM_IDS.iritvial, sec: ITEM_IDS.eye_of_newt, out: POTION_OUTPUT_IDS.super_attack_3 },
 // C3: Super strength x10 (48,125 -> 79,375, Lv 62)
 { unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.limpwurt_root, out: POTION_OUTPUT_IDS.super_strength_3 },
 // C4..C5: Weapon poison 2x10 (79,375 -> 148,125, Lv 71)
 ...Array.from({ length: 2 }, () => ({
  unf: ITEM_IDS.kwuarmvial,
  sec: ITEM_IDS.dragon_scale_dust,
  out: POTION_OUTPUT_IDS.weapon_poison,
 })),
 // C6..C8: Antifire 3x10 (148,125 -> 266,250, Lv 79)
 ...Array.from({ length: 3 }, () => ({
  unf: ITEM_IDS.lantadymevial,
  sec: ITEM_IDS.dragon_scale_dust,
  out: POTION_OUTPUT_IDS.antifire_3,
 })),
 // C9..C25: 17x10 Zamorak (266,250 -> 1,010,000, Lv 99 on 8th of C25)
 ...Array.from({ length: 17 }, () => ({
  unf: ITEM_IDS.torstolvial,
  sec: ITEM_IDS.jangerberries,
  out: POTION_OUTPUT_IDS.zamorak_3,
 })),
];

export interface HerbloreBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const HERBLORE_STARTER_BATCH: HerbloreBatchPlan = {
 // Starter kit traded at Lumbridge for Games necklace -> Druidic Ritual (+6,250 XP) and Glory -> Edgeville Bank.
 give: [
  { id: ITEM_IDS.necklace_of_minigames_8, count: 1 },
  { id: ITEM_IDS.raw_beef, count: 1 },
  { id: ITEM_IDS.raw_rat_meat, count: 1 },
  { id: ITEM_IDS.raw_bear_meat, count: 1 },
  { id: ITEM_IDS.raw_chicken, count: 1 },
  { id: ITEM_IDS.amulet_of_glory_4, count: 1 },
 ],
 returnIds: [],
};

export const HERBLORE_NOTED_BATCH: HerbloreBatchPlan = {
 give: HERBLORE_NOTED_SUPPLIES.map(s => ({ id: s.certId, count: s.count })),
 returnIds: [],
};

export const HERBLORE_BATCHES: readonly HerbloreBatchPlan[] = [HERBLORE_NOTED_BATCH];

export const HERBLORE_ALL_BATCHES: readonly HerbloreBatchPlan[] = [HERBLORE_STARTER_BATCH, HERBLORE_NOTED_BATCH];

export const HERBLORE_SUPPLY_BILL: readonly SupplyEntry[] = aggregateHerbloreSupply();

function aggregateHerbloreSupply(): SupplyEntry[] {
 const counts = new Map<number, number>();
 for (const item of HERBLORE_STARTER_BATCH.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 for (const item of HERBLORE_NOTED_SUPPLIES) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 const catalog = loadItemCatalog();
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: catalog.get(itemId)?.name ?? `Item ${itemId}`,
  count,
 }));
}

async function eatIfHurt(spec: Session, guard?: { lastTick: number }): Promise<void> {
 if ((spec.sdk.getSkill('Hitpoints')?.level ?? 10) > 6) return;
 if (guard) {
  const now = spec.tick();
  if (guard.lastTick === now) return;
  guard.lastTick = now;
 }
 const food = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.shark || i.id === 2309 || i.id === 315);
 if (food) await spec.direct({ type: 'useInventoryItem', slot: food.slot, optionIndex: 1, reason: 'SDK' });
}

function dialogSawText(spec: Session, re: RegExp): boolean {
 const st = spec.sdk.getState();
 const d = spec.sdk.getDialog();
 if (d?.isOpen) {
  const txt = [d.text ?? '', ...(d.allComponents ?? []).map((c: any) => c.text ?? '')].filter(Boolean).join(' ');
  if (re.test(txt)) return true;
 }
 return (st?.recentDialogs ?? []).some((e: any) => re.test((e.text ?? []).join(' ')));
}

async function walkLocal(spec: Session, x: number, z: number, tol: number, deadline: number, stop?: () => boolean): Promise<void> {
 if (stop?.() || nearTile(spec, x, z, tol, playerPos(spec)?.level ?? 0)) return;
 const walker = await sessionWalker(spec);
 const res = await walkPath(walker, [{ x, z, tol }], { maxTicks: Math.max(10, Math.min(100, deadline - spec.tick())), stop });
 if (!stop?.() && !res.ok && !nearTile(spec, x, z, tol, playerPos(spec)?.level ?? 0)) {
  if ((playerPos(spec)?.worldZ ?? 0) > 9000) {
   while (spec.tick() < deadline && !nearTile(spec, x, z, Math.max(1, tol), playerPos(spec)?.level ?? 0)) {
    await spec.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
    await waitTicks(spec, 1);
   }
  } else {
   await navigateWorld(spec, x, z, playerPos(spec)?.level ?? 0, Math.max(10, deadline - spec.tick()));
  }
 }
}

async function climbLoc(spec: Session, locId: number, x: number, z: number, opRe: RegExp, done: () => boolean, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (done()) return;
  await eatIfHurt(spec);
  const loc = findLocBy(spec, l => l.id === locId || (l.x === x && l.z === z));
  if (loc && (loc.reachable !== false || [1738, 1740, 1755, 1759].includes(loc.id))) {
   const op = loc.optionsWithIndex?.find(o => opRe.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: op, reason: 'SDK' });
  } else {
   const door = findLocBy(
    spec,
    l => /door/i.test(l.name) && l.distance <= 6 && !!l.optionsWithIndex?.some(o => /^open$/i.test(o.text)),
   );
   if (door) {
    const op = door.optionsWithIndex?.find(o => /^open$/i.test(o.text))?.opIndex ?? 1;
    await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
   } else {
    await spec.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
   }
  }
  await waitTicks(spec, 1);
 }
 throw Error(`climbLoc(${locId} at ${x},${z}) exceeded cap`);
}

async function talkQuestNpc(
 spec: Session,
 nameRe: RegExp,
 optRes: RegExp[],
 done: () => boolean,
 anchor: { x: number; z: number },
 deadline: number,
): Promise<void> {
 while (spec.tick() < deadline) {
  if (done()) return;
  await eatIfHurt(spec);
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) {
    const pick = d.options.find((o: any) => optRes.some(r => r.test(o.text)));
    await spec.direct({ type: 'clickDialogOption', optionIndex: pick?.index ?? d.options[0]?.index ?? 0, reason: 'SDK' });
   }
  } else {
   const npc = findNpcBy(spec, n => nameRe.test(n.name));
   if (npc) {
    await spec.direct({ type: 'interactNpc', npcIndex: npc.index, optionIndex: 1, reason: 'SDK' });
   } else {
    await spec.direct({ type: 'walkTo', x: anchor.x, z: anchor.z, running: true, reason: 'SDK' });
   }
  }
  await waitTicks(spec, 1);
 }
 throw Error(`talkQuestNpc(${nameRe.source}) exceeded cap`);
}

async function walkDirect(
 spec: Session,
 x: number,
 z: number,
 tol: number,
 deadline: number,
 stop?: () => boolean,
): Promise<void> {
 while (spec.tick() < deadline && !stop?.() && !nearTile(spec, x, z, tol, playerPos(spec)?.level ?? 0)) {
  const p = playerPos(spec);
  if (p) {
   const dx = x - p.worldX;
   const dz = z - p.worldZ;
   const stepX = p.worldX + Math.max(-12, Math.min(12, dx));
   const stepZ = p.worldZ + Math.max(-12, Math.min(12, dz));
   await spec.direct({ type: 'walkTo', x: stepX, z: stepZ, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
}

async function completeDruidicRitual(spec: Session, start: number, deadline: number): Promise<string> {
 const eatGuard = { lastTick: -1 };
 const offEat = spec.onTick(() => {
  void eatIfHurt(spec, eatGuard);
 });
 try {
 // Games necklace -> Burthorpe Games Room (2207,4940,0) -> west stairs 4622 -> stairs 4627 -> Burthorpe (2899,3564,0)
 await rubJewelryTeleport(
  spec,
  GAMES_NECKLACE_IDS,
  /burthorpe/i,
  () => {
   const p = playerPos(spec);
   return !!p && p.worldZ > 4500;
  },
  deadline,
 );

 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (p && p.worldZ < 4000) break;
  if (p?.level === 0) {
   const st0 = findLocBy(spec, l => l.id === 4622 && l.x <= 2208);
   if (st0) await spec.direct({ type: 'interactLoc', x: st0.x, z: st0.z, locId: st0.id, optionIndex: 1, reason: 'SDK' });
   else await spec.direct({ type: 'walkTo', x: 2207, z: 4936, running: true, reason: 'SDK' });
  } else {
   const st1 = findLocBy(spec, l => l.id === 4627);
   if (st1) await spec.direct({ type: 'interactLoc', x: st1.x, z: st1.z, locId: st1.id, optionIndex: 1, reason: 'SDK' });
   else await spec.direct({ type: 'walkTo', x: 2206, z: 4934, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 const walker = await sessionWalker(spec);
 // Block Witch's House locked front door so pathing stays on the open street.
 walker.blockDoor?.(0, { x: 2901, z: 3473 });

 await walkLocal(spec, KAQEMEEX_SPOT.x, KAQEMEEX_SPOT.z, 2, deadline, () => !!findNpcBy(spec, n => /^kaqemeex$/i.test(n.name) && n.distance <= 15));
 logPhase(spec, start, 'herb_at_kaqemeex');

 await talkQuestNpc(
  spec,
  /^kaqemeex$/i,
  [/search of a quest/i, /will try and help/i],
  () => dialogSawText(spec, /excellent\. go to the village south|fellow.*sanfew|village south/i),
  { x: 2924, z: 3486 },
  deadline,
 );
 const tKaq1 = spec.tick() - start;

 await walkLocal(spec, 2898, 3427, 2, deadline, () => !!findLocBy(spec, l => l.id === 1738 && l.reachable !== false && l.distance <= 3));
 logPhase(spec, start, 'herb_at_sanfew1_stairs');
 await climbLoc(spec, 1738, 2898, 3428, /climb-up/i, () => (playerPos(spec)?.level ?? 0) === 1, deadline);
 logPhase(spec, start, 'herb_up_sanfew1');

 await talkQuestNpc(
  spec,
  /^sanfew$/i,
  [/sent to help purify/i, /i'll do that then/i],
  () =>
   (spec.sdk.getDialog()?.options?.some((o: any) => /where can i find/i.test(o.text)) ?? false) ||
   dialogSawText(spec, /well thank you very much|ok, i'll do that then|where can i find/i),
  { x: 2897, z: 3426 },
  deadline,
 );
 const tSan1 = spec.tick() - start;

 await climbLoc(spec, 1740, 2898, 3428, /climb-down/i, () => (playerPos(spec)?.level ?? 1) === 0, deadline);
 logPhase(spec, start, 'herb_down_sanfew1');
 await walkLocal(spec, 2884, 3398, 2, deadline, () => !!findLocBy(spec, l => l.id === 1759 && l.distance <= 12));
 await climbLoc(spec, 1759, 2884, 3397, /climb-down/i, () => (playerPos(spec)?.worldZ ?? 0) > 9000, deadline);
 const tDung = spec.tick() - start;
 logPhase(spec, start, 'herb_in_dungeon');

 const insideRoom = () => {
  const p = playerPos(spec);
  return !!p && p.worldZ > 9000 && p.worldX >= 2889;
 };
 const doorClosed = () => !!findLocBy(spec, l => (l.id === 2143 || l.id === 2144) && l.x === 2889)?.optionsWithIndex?.some(o => /open/i.test(o.text));
 await walkDirect(spec, 2888, 9831, 1, deadline, () => (playerPos(spec)?.worldZ ?? 0) >= 9830);
 logPhase(spec, start, 'herb_at_caul_door');

 while (spec.tick() < deadline && !insideRoom() && doorClosed()) {
  await eatIfHurt(spec, eatGuard);
  const door = findLocBy(spec, l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
  if (door) {
   const op = door.optionsWithIndex?.find(o => /open/i.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x: 2889, z: 9831, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 logPhase(spec, start, 'herb_inside_caul');

 const meatPairs = [
  { raw: ITEM_IDS.raw_beef, ench: 522 },
  { raw: ITEM_IDS.raw_rat_meat, ench: 523 },
  { raw: ITEM_IDS.raw_bear_meat, ench: 524 },
  { raw: ITEM_IDS.raw_chicken, ench: 525 },
 ] as const;
 while (spec.tick() < deadline) {
  await eatIfHurt(spec, eatGuard);
  const inv = spec.sdk.getInventory();
  const pending = meatPairs.filter(m => countItem(inv, m.ench) === 0);
  if (!pending.length) break;
  const p = playerPos(spec);
  const adjacent = !!p && Math.max(Math.abs(p.worldX - 2893), Math.abs(p.worldZ - 9831)) <= 2;
  if (!adjacent) {
   await spec.direct({ type: 'walkTo', x: 2892, z: 9831, running: true, reason: 'SDK' });
  } else {
   const acts: Promise<unknown>[] = [];
   for (const m of pending) {
    const slotItem = inv.find(i => i.id === m.raw);
    if (slotItem) acts.push(spec.direct({ type: 'useItemOnLoc', itemSlot: slotItem.slot, x: 2893, z: 9831, locId: 2142, reason: 'SDK' }));
   }
   if (acts.length) await Promise.all(acts);
  }
  await waitTicks(spec, 1);
 }

 logPhase(spec, start, 'herb_meats_dipped');
 while (spec.tick() < deadline && insideRoom() && doorClosed()) {
  await eatIfHurt(spec, eatGuard);
  const door = findLocBy(spec, l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
  if (door && door.optionsWithIndex?.some(o => /open/i.test(o.text))) {
   const op = door.optionsWithIndex.find(o => /open/i.test(o.text))!.opIndex;
   await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x: 2888, z: 9831, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 const tCaul = spec.tick() - start;

 logPhase(spec, start, 'herb_out_of_room');
 await walkDirect(spec, 2884, 9798, 1, deadline, () => (playerPos(spec)?.worldZ ?? 9999) <= 9808);
 await climbLoc(spec, 1755, 2884, 9797, /climb-up/i, () => (playerPos(spec)?.worldZ ?? 9999) < 9000, deadline);
 logPhase(spec, start, 'herb_out_of_dungeon');
 await walkLocal(spec, 2898, 3427, 2, deadline, () => !!findLocBy(spec, l => l.id === 1738 && l.reachable !== false && l.distance <= 14));
 await climbLoc(spec, 1738, 2898, 3428, /climb-up/i, () => (playerPos(spec)?.level ?? 0) === 1, deadline);

 await talkQuestNpc(
  spec,
  /^sanfew$/i,
  [],
  () => [522, 523, 524, 525].every(id => countItem(spec.sdk.getInventory(), id) === 0),
  { x: 2897, z: 3426 },
  deadline,
 );
 const tSan2 = spec.tick() - start;

 await climbLoc(spec, 1740, 2898, 3428, /climb-down/i, () => (playerPos(spec)?.level ?? 1) === 0, deadline);
 // Drop tutorial junk, sharks, and spent necklace (keeping Glory) while running back to Kaqemeex.
 const offDrop = spec.onTick(() => {
  if (spec.sdk.getState()?.dialog?.isOpen) return;
  const slots = spec.sdk.getInventory().filter(i => !GLORY_SET.has(i.id)).slice(0, 4).map(i => i.slot);
  for (const slot of slots) void spec.direct({ type: 'dropItem', slot, reason: 'SDK' });
 });
 try {
  await walkLocal(
   spec,
   KAQEMEEX_SPOT.x,
   KAQEMEEX_SPOT.z - 1,
   1,
   deadline,
   () =>
    spec.sdk.getInventory().every(i => GLORY_SET.has(i.id)) &&
    !!findNpcBy(spec, n => /^kaqemeex$/i.test(n.name) && n.distance <= 15),
  );
 } finally {
  offDrop();
 }

 await talkQuestNpc(
  spec,
  /^kaqemeex$/i,
  [],
  () => skillXp(spec, 'Herblore') >= 6250,
  { x: 2924, z: 3486 },
  deadline,
 );
 logPhase(spec, start, `herb_druid_done lvl=${skillLevel(spec, 'Herblore')}`);
 return `k1=${tKaq1},s1=${tSan1},dg=${tDung},cl=${tCaul},s2=${tSan2}`;
 } finally {
  offEat();
 }
}

async function teleportEdgevilleAndDropGlory(spec: Session, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (p && p.worldX > 3060 && p.worldZ > 3460 && p.worldZ < 4000) break;
  const st = spec.sdk.getState();
  const d = spec.sdk.getDialog();
  const edgeOpt = d?.isOpen && !d.isWaiting ? d.options.find((o: any) => /edgeville/i.test(o.text)) : undefined;
  if (edgeOpt) {
   await spec.direct({ type: 'clickDialogOption', optionIndex: edgeOpt.index, reason: 'SDK' });
  } else {
   const glory = spec.sdk.getInventory().find(i => GLORY_SET.has(i.id));
   // OpHeldHandler calls clearPendingAction() -> closeModal(); avoid sending closeModal alongside rub so requestModalClose does not close the teleport menu.
   if (glory) await spec.direct({ type: 'useInventoryItem', slot: glory.slot, optionIndex: 4, reason: 'SDK' });
   else if (d?.isOpen || st?.interface?.isOpen) await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 // Walk to Edgeville bank while dropping the spent Glory in parallel on the first tick.
 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  const glories = spec.sdk.getInventory().filter(i => GLORY_SET.has(i.id));
  if (p && nearTile(spec, HERBLORE_BANK_SPOT.x, HERBLORE_BANK_SPOT.z, 0, 0) && glories.length === 0) break;
  const acts: Promise<unknown>[] = [];
  for (const g of glories) acts.push(spec.direct({ type: 'dropItem', slot: g.slot, reason: 'SDK' }));
  if (!p || !nearTile(spec, HERBLORE_BANK_SPOT.x, HERBLORE_BANK_SPOT.z, 0, 0)) {
   acts.push(spec.direct({ type: 'walkTo', x: HERBLORE_BANK_SPOT.x, z: HERBLORE_BANK_SPOT.z, running: true, reason: 'SDK' }));
  }
  if (acts.length) await Promise.all(acts);
  await waitTicks(spec, 1);
 }
}

async function openEdgevilleBank(spec: Session, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  const st = spec.sdk.getState();
  if (st?.bank?.isOpen) return;
  const booth = findLocBy(spec, l => /bank booth/i.test(l.name) && !!l.optionsWithIndex?.some(o => /use-quickly/i.test(o.text)));
  const op = booth?.optionsWithIndex?.find(o => /use-quickly/i.test(o.text))?.opIndex ?? 2;
  if (booth) {
   // OpLocHandler calls player.clearPendingAction() -> closeModal(); sending closeModal sets requestModalClose=true and closes the opened bank.
   await spec.direct({ type: 'interactLoc', x: booth.x, z: booth.z, locId: booth.id, optionIndex: op, reason: 'SDK' });
  } else if (st?.dialog?.isOpen || st?.interface?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 throw Error('openEdgevilleBank exceeded cap');
}

async function brewCyclePotions(spec: Session, unfId: number, secId: number, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Herblore') >= target) return;
  const inv = spec.sdk.getInventory();
  const unfs = inv.filter(i => i.id === unfId);
  const secs = inv.filter(i => i.id === secId);
  const pairCount = Math.min(5, unfs.length, secs.length);
  if (pairCount <= 0) return;
  const acts: Promise<unknown>[] = [];
  for (let k = 0; k < pairCount; k++) {
   acts.push(spec.direct({ type: 'useItemOnItem', sourceSlot: unfs[k]!.slot, targetSlot: secs[k]!.slot, reason: 'SDK' }));
  }
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 throw Error('herblore brewing exceeded cap');
}

async function executeHerbloreLoop(
 spec: Session,
 target: number,
 start: number,
 deadline: number,
 receiveStarter: () => Promise<void>,
 receiveNoted: () => Promise<void>,
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 await skipTutorialFast(spec, deadline);
 if (spec.sdk.getInventory().length > 19) {
  await dropItemsFast(spec, new Set(), deadline);
 }
 await receiveStarter();

 const druidTrace = await completeDruidicRitual(spec, start, deadline);
 const druidTicks = spec.tick() - start;

 await teleportEdgevilleAndDropGlory(spec, deadline);
 const tTrade0 = spec.tick();
 await receiveNoted();
 const tradeTicks = spec.tick() - tTrade0;

 let bankTicks = 0;
 let brewTicks = 0;
 let bankRefused = 0;
 let bankOpenTicks = 0;
 let depositedNotes = false;
 for (let c = 0; c < HERBLORE_BANK_CYCLES.length && skillLevel(spec, 'Herblore') < target; c++) {
  const cyc = HERBLORE_BANK_CYCLES[c]!;
  const b0 = spec.tick();
  const o0 = spec.tick();
  await openEdgevilleBank(spec, deadline);
  bankOpenTicks += spec.tick() - o0;
  if (!depositedNotes) {
   while (spec.tick() < deadline) {
    const inv = spec.sdk.getInventory();
    if (!inv.length) break;
    const acts: Promise<unknown>[] = [];
    for (const item of inv.slice(0, 5)) {
     acts.push(spec.direct({ type: 'bankDeposit', slot: item.slot, amount: -1, reason: 'SDK' }));
    }
    const res = (await Promise.all(acts)) as Array<{ success?: boolean } | undefined>;
    if (res.some(r => r?.success === false)) bankRefused++;
    await waitTicks(spec, 1);
   }
   depositedNotes = true;
  }
  while (spec.tick() < deadline) {
   const st = spec.sdk.getState();
   const inv = spec.sdk.getInventory();
   if (!st?.bank?.isOpen && countItem(inv, cyc.unf) >= 10 && countItem(inv, cyc.sec) >= 10) break;
   if (!st?.bank?.isOpen) {
    const o1 = spec.tick();
    await openEdgevilleBank(spec, deadline);
    bankOpenTicks += spec.tick() - o1;
    continue;
   }
   const bankItems = st.bank.items ?? [];
   const unfBank = bankItems.find((i: any) => i.id === cyc.unf && i.count >= 10);
   const secBank = bankItems.find((i: any) => i.id === cyc.sec && i.count >= 10);
   if (!unfBank || !secBank) {
    await waitTicks(spec, 1);
    continue;
   }
   const acts: Promise<unknown>[] = [];
   const seenOut = new Set<number>();
   for (const item of inv) {
    if (item.id === cyc.unf || item.id === cyc.sec || seenOut.has(item.id)) continue;
    seenOut.add(item.id);
    acts.push(spec.direct({ type: 'bankDeposit', slot: item.slot, amount: -1, reason: 'SDK' }));
   }
   if (countItem(inv, cyc.unf) < 10) acts.push(spec.direct({ type: 'bankWithdraw', slot: unfBank.slot, amount: 10, reason: 'SDK' }));
   if (countItem(inv, cyc.sec) < 10) acts.push(spec.direct({ type: 'bankWithdraw', slot: secBank.slot, amount: 10, reason: 'SDK' }));
   const results = acts.length ? ((await Promise.all(acts)) as Array<{ success?: boolean } | undefined>) : [];
   const okActs = results.every(r => r?.success !== false);
   if (!okActs) bankRefused++;
   if (okActs && acts.length <= 4) {
    await spec.direct({ type: 'closeModal', reason: 'SDK' });
   }
   await waitTicks(spec, 1);
  }
  bankTicks += spec.tick() - b0;
  const p0 = spec.tick();
  await brewCyclePotions(spec, cyc.unf, cyc.sec, target, deadline);
  brewTicks += spec.tick() - p0;
 }

 const level = skillLevel(spec, 'Herblore');
 const xp = skillXp(spec, 'Herblore');
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=herblore level=${level} xp=${xp} ticks=${ticks} druid=${druidTicks} tr=${tradeTicks} bank=${bankTicks}(open=${bankOpenTicks},ref=${bankRefused}) brew=${brewTicks} (${druidTrace})`,
  ticks,
  level,
  xp,
 };
}

export async function runHerbloreSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(HERBLORE_SUPPLY_BILL);
 if (helpers.length < HERBLORE_ALL_BATCHES.length) {
  throw Error(`herblore specialist requires ${HERBLORE_ALL_BATCHES.length} helpers, got ${helpers.length}`);
 }
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 return executeHerbloreLoop(
  spec,
  target,
  start,
  deadline,
  () =>
   burstTradeHost(spec, helpers[0]!, {
    giveIds: HERBLORE_STARTER_BATCH.give.map(g => g.id),
    deadlineTick: deadline,
   }),
  () =>
   burstTradeHost(spec, helpers[1]!, {
    giveIds: HERBLORE_NOTED_BATCH.give.map(g => g.id),
    deadlineTick: deadline,
   }),
 );
}

export async function runHerbloreExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(HERBLORE_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('herblore external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 const starterSuppliers = supplierNames.length >= 2 ? [supplierNames[0]!] : supplierNames;
 const notedSuppliers = supplierNames.length >= 2 ? [supplierNames[1]!] : supplierNames;
 return executeHerbloreLoop(
  spec,
  target,
  start,
  deadline,
  () =>
   fastTradeExternalReceive(spec, starterSuppliers, {
    acceptOffer: offer => HERBLORE_STARTER_BATCH.give.every(g => countItem(offer, g.id) >= g.count),
    deadlineTick: deadline,
   }).then(() => {}),
  () =>
   fastTradeExternalReceive(spec, notedSuppliers, {
    acceptOffer: offer => HERBLORE_NOTED_BATCH.give.every(g => countItem(offer, g.id) >= g.count),
    deadlineTick: deadline,
   }).then(() => {}),
 );
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 600,
  target: 99,
  defaultHelpers: HERBLORE_ALL_BATCHES.length,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runHerbloreExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runHerbloreSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
