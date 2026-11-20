// Fresh-account 1-to-99 Herblore specialist via Games necklace Druidic Ritual (+6,250 XP) and Kaqemeex 5-per-tick brewing.
import type { Session } from '../packages/core/src/inprocess';
import { levelForXp } from '../packages/planner/src/curve';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 findLocBy,
 findNpcBy,
 GAMES_NECKLACE_IDS,
 goalXp,
 ITEM_IDS,
 logPhase,
 navigateWorld,
 nearTile,
 parseSpecialistArgs,
 playerPos,
 rubJewelryTeleport,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const KAQEMEEX_SPOT = { x: 2925, z: 3486, level: 0 } as const;

export interface HerbPotionRecipe {
 name: string;
 level: number;
 xp: number;
 unf: number;
 sec: number;
}

export const HERB_POTION_TIERS: readonly HerbPotionRecipe[] = [
 { name: 'Attack', level: 3, xp: 625, unf: ITEM_IDS.guamvial, sec: ITEM_IDS.eye_of_newt },
 { name: 'Antipoison', level: 5, xp: 937.5, unf: ITEM_IDS.marrentillvial, sec: ITEM_IDS.unicorn_horn_dust },
 { name: 'Strength', level: 12, xp: 1250, unf: ITEM_IDS.tarrominvial, sec: ITEM_IDS.limpwurt_root },
 { name: 'Energy', level: 26, xp: 1687.5, unf: ITEM_IDS.harralandervial, sec: ITEM_IDS.chocolate_dust },
 { name: 'Prayer', level: 38, xp: 2187.5, unf: ITEM_IDS.ranarrvial, sec: ITEM_IDS.snape_grass },
 { name: 'Super attack', level: 45, xp: 2500, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.eye_of_newt },
 { name: 'Super antipoison', level: 48, xp: 2657.5, unf: ITEM_IDS.iritvial, sec: ITEM_IDS.unicorn_horn_dust },
 { name: 'Fishing', level: 50, xp: 2812.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.snape_grass },
 { name: 'Super energy', level: 52, xp: 2937.5, unf: ITEM_IDS.avantoevial, sec: ITEM_IDS.mortmyremushroom },
 { name: 'Super strength', level: 55, xp: 3125, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.limpwurt_root },
 { name: 'Weapon poison', level: 60, xp: 3437.5, unf: ITEM_IDS.kwuarmvial, sec: ITEM_IDS.dragon_scale_dust },
 { name: 'Super restore', level: 63, xp: 3562.5, unf: ITEM_IDS.snapdragonvial, sec: ITEM_IDS.red_spiders_eggs },
 { name: 'Super defence', level: 66, xp: 3750, unf: ITEM_IDS.cadantinevial, sec: ITEM_IDS.white_berries },
 { name: 'Antifire', level: 69, xp: 3937.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.dragon_scale_dust },
 { name: 'Ranging', level: 72, xp: 4062.5, unf: ITEM_IDS.dwarfweedvial, sec: ITEM_IDS.wine_of_zamorak },
 { name: 'Magic', level: 76, xp: 4312.5, unf: ITEM_IDS.lantadymevial, sec: ITEM_IDS.cactus_potato },
 { name: 'Zamorak', level: 78, xp: 4375, unf: ITEM_IDS.torstolvial, sec: ITEM_IDS.jangerberries },
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

export interface HerbloreBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const HERBLORE_STARTER_BATCH: HerbloreBatchPlan = {
 // Starter kit traded at Lumbridge for Games necklace -> Burthorpe -> Druidic Ritual (+6,250 XP = Lv 26).
 give: [
  { id: ITEM_IDS.necklace_of_minigames_8, count: 1 },
  { id: ITEM_IDS.raw_beef, count: 1 },
  { id: ITEM_IDS.raw_rat_meat, count: 1 },
  { id: ITEM_IDS.raw_bear_meat, count: 1 },
  { id: ITEM_IDS.raw_chicken, count: 1 },
  { id: ITEM_IDS.shark, count: 4 },
 ],
 returnIds: [],
};

export const HERBLORE_BATCHES: readonly HerbloreBatchPlan[] = [
 // Batch 1 (14 pairs from Lv 26 / 6,250 XP): Energy(5), Prayer(4), SupAtk(2), SupAnti(2), Fishing(1) -> 36,565 XP (Lv 51)
 {
  give: [
   { id: ITEM_IDS.harralandervial, count: 5 },
   { id: ITEM_IDS.chocolate_dust, count: 5 },
   { id: ITEM_IDS.ranarrvial, count: 4 },
   { id: ITEM_IDS.snape_grass, count: 5 },
   { id: ITEM_IDS.iritvial, count: 4 },
   { id: ITEM_IDS.eye_of_newt, count: 2 },
   { id: ITEM_IDS.unicorn_horn_dust, count: 2 },
   { id: ITEM_IDS.avantoevial, count: 1 },
  ],
  returnIds: [],
 },
 // Batch 2 (14 pairs): Fishing(1), SupEng(3), SupStr(6), WepPoi(4) -> 80,690 XP (Lv 62)
 {
  give: [
   { id: ITEM_IDS.avantoevial, count: 4 },
   { id: ITEM_IDS.snape_grass, count: 1 },
   { id: ITEM_IDS.mortmyremushroom, count: 3 },
   { id: ITEM_IDS.kwuarmvial, count: 10 },
   { id: ITEM_IDS.limpwurt_root, count: 6 },
   { id: ITEM_IDS.dragon_scale_dust, count: 4 },
  ],
  returnIds: [
   POTION_OUTPUT_IDS.energy_3,
   POTION_OUTPUT_IDS.prayer_3,
   POTION_OUTPUT_IDS.super_attack_3,
   POTION_OUTPUT_IDS.super_antipoison_3,
   POTION_OUTPUT_IDS.fishing_3,
  ],
 },
 // Batch 3 (14 pairs): WepPoi(1), SupRes(5), SupDef(6), Antifire(2) -> 132,315 XP (Lv 69)
 {
  give: [
   { id: ITEM_IDS.kwuarmvial, count: 1 },
   { id: ITEM_IDS.dragon_scale_dust, count: 3 },
   { id: ITEM_IDS.snapdragonvial, count: 5 },
   { id: ITEM_IDS.red_spiders_eggs, count: 5 },
   { id: ITEM_IDS.cadantinevial, count: 6 },
   { id: ITEM_IDS.white_berries, count: 6 },
   { id: ITEM_IDS.lantadymevial, count: 2 },
  ],
  returnIds: [
   POTION_OUTPUT_IDS.fishing_3,
   POTION_OUTPUT_IDS.super_energy_3,
   POTION_OUTPUT_IDS.super_strength_3,
   POTION_OUTPUT_IDS.weapon_poison,
  ],
 },
 // Batch 4 (14 pairs): Antifire(6), Ranging(8) -> 188,440 XP (Lv 74)
 {
  give: [
   { id: ITEM_IDS.lantadymevial, count: 6 },
   { id: ITEM_IDS.dragon_scale_dust, count: 6 },
   { id: ITEM_IDS.dwarfweedvial, count: 8 },
   { id: ITEM_IDS.wine_of_zamorak, count: 8 },
  ],
  returnIds: [
   POTION_OUTPUT_IDS.weapon_poison,
   POTION_OUTPUT_IDS.super_restore_3,
   POTION_OUTPUT_IDS.super_defence_3,
   POTION_OUTPUT_IDS.antifire_3,
  ],
 },
 // Batch 5 (14 pairs): Ranging(4), Magic(7), Zamorak(3) -> 248,002.5 XP (Lv 78)
 {
  give: [
   { id: ITEM_IDS.dwarfweedvial, count: 4 },
   { id: ITEM_IDS.wine_of_zamorak, count: 4 },
   { id: ITEM_IDS.lantadymevial, count: 7 },
   { id: ITEM_IDS.cactus_potato, count: 7 },
   { id: ITEM_IDS.torstolvial, count: 3 },
   { id: ITEM_IDS.jangerberries, count: 3 },
  ],
  returnIds: [POTION_OUTPUT_IDS.antifire_3, POTION_OUTPUT_IDS.ranging_3],
 },
 // Batches 6..17 (12x14 Zamorak brews -> 983,002.5 XP) + Batch 18 (5 Zamorak brews -> 1,004,877.5 XP)
 ...Array.from({ length: 12 }, (_, idx): HerbloreBatchPlan => ({
  give: [
   { id: ITEM_IDS.torstolvial, count: 14 },
   { id: ITEM_IDS.jangerberries, count: 14 },
  ],
  returnIds:
   idx === 0
    ? [POTION_OUTPUT_IDS.ranging_3, POTION_OUTPUT_IDS.magic_3, POTION_OUTPUT_IDS.zamorak_3]
    : [POTION_OUTPUT_IDS.zamorak_3],
 })),
 {
  give: [
   { id: ITEM_IDS.torstolvial, count: 5 },
   { id: ITEM_IDS.jangerberries, count: 5 },
  ],
  returnIds: [POTION_OUTPUT_IDS.zamorak_3],
 },
];

export const HERBLORE_ALL_BATCHES: readonly HerbloreBatchPlan[] = [HERBLORE_STARTER_BATCH, ...HERBLORE_BATCHES];

export const HERBLORE_SUPPLY_BILL: readonly SupplyEntry[] = aggregateHerbloreSupply();

function aggregateHerbloreSupply(): SupplyEntry[] {
 const counts = new Map<number, number>();
 for (const batch of HERBLORE_ALL_BATCHES) {
  for (const item of batch.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 }
 const names = new Map<number, string>([
  [ITEM_IDS.necklace_of_minigames_8, 'Games necklace(8)'],
  [ITEM_IDS.raw_beef, 'Raw beef'],
  [ITEM_IDS.raw_rat_meat, 'Raw rat meat'],
  [ITEM_IDS.raw_bear_meat, 'Raw bear meat'],
  [ITEM_IDS.raw_chicken, 'Raw chicken'],
  [ITEM_IDS.shark, 'Shark'],
  [ITEM_IDS.harralandervial, 'Harralander potion (unf)'],
  [ITEM_IDS.ranarrvial, 'Ranarr potion (unf)'],
  [ITEM_IDS.iritvial, 'Irit potion (unf)'],
  [ITEM_IDS.avantoevial, 'Avantoe potion (unf)'],
  [ITEM_IDS.kwuarmvial, 'Kwuarm potion (unf)'],
  [ITEM_IDS.snapdragonvial, 'Snapdragon potion (unf)'],
  [ITEM_IDS.cadantinevial, 'Cadantine potion (unf)'],
  [ITEM_IDS.lantadymevial, 'Lantadyme potion (unf)'],
  [ITEM_IDS.dwarfweedvial, 'Dwarf weed potion (unf)'],
  [ITEM_IDS.torstolvial, 'Torstol potion (unf)'],
  [ITEM_IDS.eye_of_newt, 'Eye of newt'],
  [ITEM_IDS.unicorn_horn_dust, 'Unicorn horn dust'],
  [ITEM_IDS.limpwurt_root, 'Limpwurt root'],
  [ITEM_IDS.chocolate_dust, 'Chocolate dust'],
  [ITEM_IDS.snape_grass, 'Snape grass'],
  [ITEM_IDS.mortmyremushroom, 'Mort myre fungi'],
  [ITEM_IDS.dragon_scale_dust, 'Dragon scale dust'],
  [ITEM_IDS.red_spiders_eggs, "Red spiders' eggs"],
  [ITEM_IDS.white_berries, 'White berries'],
  [ITEM_IDS.wine_of_zamorak, 'Wine of zamorak'],
  [ITEM_IDS.cactus_potato, 'Potato cactus'],
  [ITEM_IDS.jangerberries, 'Jangerberries'],
 ]);
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: names.get(itemId) ?? `Item ${itemId}`,
  count,
 }));
}

async function eatIfHurt(spec: Session): Promise<void> {
 if ((spec.sdk.getSkill('Hitpoints')?.level ?? 10) > 6) return;
 const shark = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.shark);
 if (shark) await spec.direct({ type: 'useInventoryItem', slot: shark.slot, optionIndex: 1, reason: 'SDK' });
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

async function walkLocal(spec: Session, x: number, z: number, tol: number, deadline: number): Promise<void> {
 if (nearTile(spec, x, z, tol, playerPos(spec)?.level ?? 0)) return;
 const walker = await sessionWalker(spec);
 const res = await walkPath(walker, [{ x, z, tol }], { maxTicks: Math.max(10, Math.min(100, deadline - spec.tick())) });
 if (!res.ok && !nearTile(spec, x, z, tol, playerPos(spec)?.level ?? 0)) {
  await navigateWorld(spec, x, z, playerPos(spec)?.level ?? 0, Math.max(10, deadline - spec.tick()));
 }
}

async function climbLoc(spec: Session, locId: number, x: number, z: number, opRe: RegExp, done: () => boolean, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (done()) return;
  await eatIfHurt(spec);
  const loc = findLocBy(spec, l => l.id === locId || (l.x === x && l.z === z));
  if (loc) {
   const op = loc.optionsWithIndex?.find(o => opRe.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: loc.x, z: loc.z, locId: loc.id, optionIndex: op, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x, z, running: true, reason: 'SDK' });
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

async function completeDruidicRitual(spec: Session, start: number, deadline: number): Promise<void> {
 // Games necklace -> Burthorpe Games Room (2207,4940,0) -> stairs 4622 -> stairs 4627 -> Burthorpe (2899,3564,0)
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
   const st0 = findLocBy(spec, l => l.id === 4622);
   if (st0) await spec.direct({ type: 'interactLoc', x: st0.x, z: st0.z, locId: st0.id, optionIndex: 1, reason: 'SDK' });
  } else {
   const st1 = findLocBy(spec, l => l.id === 4627);
   if (st1) await spec.direct({ type: 'interactLoc', x: st1.x, z: st1.z, locId: st1.id, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 const walker = await sessionWalker(spec);
 // Block Witch's House locked front door so pathing stays on the open street.
 walker.blockDoor?.(0, { x: 2901, z: 3473 });

 await navigateWorld(spec, KAQEMEEX_SPOT.x, KAQEMEEX_SPOT.z, 0, Math.max(10, deadline - spec.tick()));
 logPhase(spec, start, 'herb_at_kaqemeex');

 await talkQuestNpc(
  spec,
  /^kaqemeex$/i,
  [/search of a quest/i, /will try and help/i],
  () => dialogSawText(spec, /fellow.*sanfew|village south/i),
  { x: 2924, z: 3486 },
  deadline,
 );

 await walkLocal(spec, 2898, 3427, 1, deadline);
 await climbLoc(spec, 1738, 2898, 3428, /climb-up/i, () => (playerPos(spec)?.level ?? 0) === 1, deadline);

 await talkQuestNpc(
  spec,
  /^sanfew$/i,
  [/sent to help purify/i, /i'll do that then/i],
  () => dialogSawText(spec, /well thank you very much|ok, i'll do that then|where can i find/i),
  { x: 2897, z: 3426 },
  deadline,
 );

 await climbLoc(spec, 1740, 2898, 3428, /climb-down/i, () => (playerPos(spec)?.level ?? 1) === 0, deadline);
 await walkLocal(spec, 2885, 3398, 1, deadline);
 await climbLoc(spec, 1759, 2884, 3397, /climb-down/i, () => (playerPos(spec)?.worldZ ?? 0) > 9000, deadline);
 logPhase(spec, start, 'herb_in_dungeon');

 const insideRoom = () => {
  const p = playerPos(spec);
  return !!p && p.worldZ > 9000 && p.worldX >= 2889;
 };
 await walkLocal(spec, 2888, 9831, 0, deadline);

 while (spec.tick() < deadline && !insideRoom()) {
  await eatIfHurt(spec);
  const door = findLocBy(spec, l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
  if (door) {
   const op = door.optionsWithIndex?.find(o => /open/i.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 const meatPairs = [
  { raw: ITEM_IDS.raw_beef, ench: 522 },
  { raw: ITEM_IDS.raw_rat_meat, ench: 523 },
  { raw: ITEM_IDS.raw_bear_meat, ench: 524 },
  { raw: ITEM_IDS.raw_chicken, ench: 525 },
 ] as const;
 while (spec.tick() < deadline) {
  await eatIfHurt(spec);
  const inv = spec.sdk.getInventory();
  const pending = meatPairs.filter(m => countItem(inv, m.ench) === 0);
  if (!pending.length) break;
  const acts: Promise<unknown>[] = [];
  for (const m of pending) {
   const slotItem = inv.find(i => i.id === m.raw);
   if (slotItem) {
    acts.push(spec.direct({ type: 'useItemOnLoc', itemSlot: slotItem.slot, x: 2893, z: 9831, locId: 2142, reason: 'SDK' }));
   }
  }
  if (acts.length) await Promise.all(acts);
  await waitTicks(spec, 1);
 }

 while (spec.tick() < deadline && insideRoom()) {
  await eatIfHurt(spec);
  const door = findLocBy(spec, l => (l.id === 2143 || l.id === 2144) && l.x === 2889);
  if (door) {
   const op = door.optionsWithIndex?.find(o => /open/i.test(o.text))?.opIndex ?? 1;
   await spec.direct({ type: 'interactLoc', x: door.x, z: door.z, locId: door.id, optionIndex: op, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 await walkLocal(spec, 2884, 9798, 1, deadline);
 await climbLoc(spec, 1755, 2884, 9797, /climb-up/i, () => (playerPos(spec)?.worldZ ?? 9999) < 9000, deadline);
 await walkLocal(spec, 2898, 3427, 1, deadline);
 await climbLoc(spec, 1738, 2898, 3428, /climb-up/i, () => (playerPos(spec)?.level ?? 0) === 1, deadline);

 await talkQuestNpc(
  spec,
  /^sanfew$/i,
  [],
  () => [522, 523, 524, 525].every(id => countItem(spec.sdk.getInventory(), id) === 0),
  { x: 2897, z: 3426 },
  deadline,
 );

 await climbLoc(spec, 1740, 2898, 3428, /climb-down/i, () => (playerPos(spec)?.level ?? 1) === 0, deadline);
 await walkLocal(spec, KAQEMEEX_SPOT.x, KAQEMEEX_SPOT.z, 2, deadline);

 await talkQuestNpc(
  spec,
  /^kaqemeex$/i,
  [],
  () => skillXp(spec, 'Herblore') >= 6250,
  { x: 2924, z: 3486 },
  deadline,
 );
 logPhase(spec, start, `herb_druid_done lvl=${skillLevel(spec, 'Herblore')}`);
}

async function mixUnlockedPotions(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Herblore') >= target) return;
  const inv = spec.sdk.getInventory();
  let simXp = skillXp(spec, 'Herblore');
  const usedSlots = new Set<number>();
  const pairs: { unfSlot: number; secSlot: number }[] = [];

  for (let i = 0; i < 5; i++) {
   const simLvl = levelForXp(simXp);
   let chosen: { recipe: HerbPotionRecipe; unfSlot: number; secSlot: number } | undefined;
   for (let r = HERB_POTION_TIERS.length - 1; r >= 0; r--) {
    const recipe = HERB_POTION_TIERS[r]!;
    if (simLvl < recipe.level) continue;
    const u = inv.find(x => x.id === recipe.unf && !usedSlots.has(x.slot));
    const s = inv.find(x => x.id === recipe.sec && !usedSlots.has(x.slot));
    if (u && s) {
     chosen = { recipe, unfSlot: u.slot, secSlot: s.slot };
     break;
    }
   }
   if (!chosen) break;
   usedSlots.add(chosen.unfSlot);
   usedSlots.add(chosen.secSlot);
   pairs.push({ unfSlot: chosen.unfSlot, secSlot: chosen.secSlot });
   simXp += chosen.recipe.xp;
  }

  if (!pairs.length) return;
  const st = spec.sdk.getState();
  const modalOpen = !!st?.dialog?.isOpen && !st?.trade?.isOpen;
  const acts: Promise<unknown>[] = [];
  if (modalOpen && pairs.length <= 4) acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  for (const p of pairs) {
   acts.push(spec.direct({ type: 'useItemOnItem', sourceSlot: p.unfSlot, targetSlot: p.secSlot, reason: 'SDK' }));
  }
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 throw Error('herblore brewing exceeded cap');
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
 let done = false;
 const keepers = helpers.map(h =>
  (async () => {
   while (!done && h.tick() < deadline) await waitTicks(h, 1);
  })(),
 );

 try {
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  await burstTradeHost(spec, helpers[0]!, {
   giveIds: HERBLORE_STARTER_BATCH.give.map(g => g.id),
   deadlineTick: deadline,
  });

  await completeDruidicRitual(spec, start, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  for (let i = 0; i < HERBLORE_BATCHES.length && skillLevel(spec, 'Herblore') < target; i++) {
   const batch = HERBLORE_BATCHES[i]!;
   const helper = helpers[1 + i]!;
   await burstTradeHost(spec, helper, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   });
   await mixUnlockedPotions(spec, target, deadline);
  }

  const level = skillLevel(spec, 'Herblore');
  const xp = skillXp(spec, 'Herblore');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=herblore level=${level} xp=${xp} ticks=${ticks}`,
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
  cap: 460,
  target: 99,
  defaultHelpers: HERBLORE_ALL_BATCHES.length,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runHerbloreSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
