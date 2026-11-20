// Fresh-account 1-to-99 Magic specialist via Enchant ladder, East Ardougne lever, Kolodion, and 5-per-tick Charge.
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import { sessionWalker, walkPath } from '../packages/core/src/walk';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 fastTradeExternalReceive,
 findLocBy,
 findNpcBy,
 goalXp,
 ITEM_IDS,
 logPhase,
 navigateWorld,
 nearTile,
 parseExternalSuppliers,
 parseSpecialistArgs,
 playerPos,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
 withSingleSpecialist,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

export const LUMBRIDGE_SAFE_SPOT = { x: 3222, z: 3222, level: 0 } as const;
export const CAMELOT_SPOT = { x: 2757, z: 3478, level: 0 } as const;
export const ARDOUGNE_LEVER = { x: 2561, z: 3311, level: 0 } as const;
export const MAGE_ARENA_DOOR_AREA = { x: 3096, z: 3957, level: 0 } as const;
export const MAGE_ARENA_LADDER = { x: 3092, z: 3957, level: 0 } as const;
export const PROTECT_FROM_MAGIC_INDEX = 12;

export interface EnchantTier {
 spell: string;
 component: number;
 level: number;
 ringId: number;
 xp: number;
}

export const ENCHANT_TIERS: readonly EnchantTier[] = [
 { spell: 'magic:enchant_lvl1', component: componentId('magic:enchant_lvl1'), level: 7, ringId: ITEM_IDS.sapphire_ring, xp: 437.5 },
 { spell: 'magic:enchant_lvl2', component: componentId('magic:enchant_lvl2'), level: 27, ringId: ITEM_IDS.emerald_ring, xp: 925 },
 { spell: 'magic:enchant_lvl3', component: componentId('magic:enchant_lvl3'), level: 49, ringId: ITEM_IDS.ruby_ring, xp: 1475 },
 { spell: 'magic:enchant_lvl4', component: componentId('magic:enchant_lvl4'), level: 57, ringId: ITEM_IDS.diamond_ring, xp: 1675 },
];

export interface MagicBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const MAGIC_BATCHES: readonly MagicBatchPlan[] = [
 // Batch 0 (28 slots total): staff(1) + 5 runes + 12 sapphire + 9 emerald rings + 1 shark
 {
  give: [
   { id: ITEM_IDS.staff_of_fire, count: 1 },
   { id: ITEM_IDS.mindrune, count: 25 },
   { id: ITEM_IDS.cosmicrune, count: 150 },
   { id: ITEM_IDS.waterrune, count: 20 },
   { id: ITEM_IDS.airrune, count: 1500 },
   { id: ITEM_IDS.earthrune, count: 400 },
   { id: ITEM_IDS.sapphire_ring, count: 12 },
   { id: ITEM_IDS.emerald_ring, count: 9 },
   { id: ITEM_IDS.shark, count: 1 },
  ],
  returnIds: [],
 },
 // Batch 1 (18 emerald -> 27 total Lv 49 + 5 ruby; returns recoil/dueling)
 {
  give: [
   { id: ITEM_IDS.emerald_ring, count: 18 },
   { id: ITEM_IDS.ruby_ring, count: 5 },
  ],
  returnIds: [ITEM_IDS.ring_of_recoil, ITEM_IDS.ring_of_dueling_8],
 },
 // Batch 2 (13 ruby -> 18 total Lv 57 + 10 diamond; returns dueling/forging)
 {
  give: [
   { id: ITEM_IDS.ruby_ring, count: 13 },
   { id: ITEM_IDS.diamond_ring, count: 10 },
  ],
  returnIds: [ITEM_IDS.ring_of_dueling_8, ITEM_IDS.ring_of_forging],
 },
 // Batch 3 (23 diamond -> 33 total; returns forging/life)
 {
  give: [{ id: ITEM_IDS.diamond_ring, count: 23 }],
  returnIds: [ITEM_IDS.ring_of_forging, ITEM_IDS.ring_of_life],
 },
 // Batch 4 (3 diamond -> 36 total Lv 68 + 21 ruby; returns life)
 {
  give: [
   { id: ITEM_IDS.diamond_ring, count: 3 },
   { id: ITEM_IDS.ruby_ring, count: 21 },
  ],
  returnIds: [ITEM_IDS.ring_of_life],
 },
 // Batch 5 (after dropping earth + life: 25 ruby; returns forging)
 {
  give: [{ id: ITEM_IDS.ruby_ring, count: 25 }],
  returnIds: [ITEM_IDS.ring_of_forging],
 },
 // Batch 6 (8 ruby -> 72 total ~197.3k XP Lv 75+ + Mage Arena combat & 38 Prayer kit = 25 slots; returns forging)
 {
  give: [
   { id: ITEM_IDS.ruby_ring, count: 8 },
   { id: ITEM_IDS.lawrune, count: 12 },
   { id: ITEM_IDS.bloodrune, count: 850 },
   { id: ITEM_IDS.knife, count: 1 },
   { id: ITEM_IDS.dragon_bones, count: 8 },
   { id: ITEM_IDS.prayer_potion_4, count: 2 },
   { id: ITEM_IDS.amulet_of_magic, count: 1 },
   { id: ITEM_IDS.super_energy_4, count: 1 },
   { id: ITEM_IDS.shark, count: 2 },
  ],
  returnIds: [ITEM_IDS.ring_of_forging],
 },
];

export const MAGIC_SUPPLY_BILL: readonly SupplyEntry[] = aggregateMagicSupply();

function aggregateMagicSupply(): SupplyEntry[] {
 const counts = new Map<number, number>();
 for (const batch of MAGIC_BATCHES) {
  for (const item of batch.give) counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
 }
 const names = new Map<number, string>([
  [ITEM_IDS.staff_of_fire, 'Staff of fire'],
  [ITEM_IDS.mindrune, 'Mind rune'],
  [ITEM_IDS.cosmicrune, 'Cosmic rune'],
  [ITEM_IDS.waterrune, 'Water rune'],
  [ITEM_IDS.airrune, 'Air rune'],
  [ITEM_IDS.earthrune, 'Earth rune'],
  [ITEM_IDS.firerune, 'Fire rune'],
  [ITEM_IDS.lawrune, 'Law rune'],
  [ITEM_IDS.bloodrune, 'Blood rune'],
  [ITEM_IDS.sapphire_ring, 'Sapphire ring'],
  [ITEM_IDS.emerald_ring, 'Emerald ring'],
  [ITEM_IDS.ruby_ring, 'Ruby ring'],
  [ITEM_IDS.diamond_ring, 'Diamond ring'],
  [ITEM_IDS.knife, 'Knife'],
  [ITEM_IDS.dragon_bones, 'Dragon bones'],
  [ITEM_IDS.prayer_potion_4, 'Prayer potion(4)'],
  [ITEM_IDS.amulet_of_magic, 'Amulet of magic'],
  [ITEM_IDS.super_energy_4, 'Super energy(4)'],
  [ITEM_IDS.shark, 'Shark'],
 ]);
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: names.get(itemId) ?? `Item ${itemId}`,
  count,
 }));
}

async function eatSharkIfLow(spec: Session): Promise<boolean> {
 const hp = spec.sdk.getSkill('Hitpoints')?.level ?? 10;
 if (hp > 7) return false;
 const shark = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.shark);
 if (!shark) return false;
 await spec.direct({ type: 'useInventoryItem', slot: shark.slot, optionIndex: 1, reason: 'SDK' });
 return true;
}

async function castWindStrikeToLevel7(spec: Session, deadline: number): Promise<void> {
 const windStrike = componentId('magic:wind_strike');
 const isPassiveTarget = (name: string) => /^(chicken|rat|giant rat)$/i.test(name);
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Magic') >= 7) break;
  const npcs = spec.sdk.getNearbyNpcs();
  await eatSharkIfLow(spec);
  const st = spec.sdk.getState();
  if (st?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  const candidates = npcs.filter(
   n =>
    /^(chicken|rat|giant rat|spider|giant spider|goblin|imp)$/i.test(n.name) &&
    n.optionsWithIndex.some(o => /^attack$/i.test(o.text)),
  );
  const reachable = candidates.filter(n => n.reachable !== false);
  const npc = (reachable.length ? reachable : candidates).sort(
   (a, b) => (isPassiveTarget(a.name) ? 0 : 1) - (isPassiveTarget(b.name) ? 0 : 1) || a.distance - b.distance,
  )[0];
  if (npc) {
   await spec.direct({ type: 'spellOnNpc', npcIndex: npc.index, spellComponent: windStrike, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x: 3236, z: 3233, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
}

async function enchantHeldRings(spec: Session, target: number, deadline: number, label = 'enchant'): Promise<void> {
 const begin = spec.tick();
 let casts = 0;
 let misses = 0;
 let lastMiss = '';
 try {
 while (spec.tick() < deadline && skillLevel(spec, 'Magic') < target) {
  await eatSharkIfLow(spec);
  const lvl = skillLevel(spec, 'Magic');
  const inv = spec.sdk.getInventory();
  const tier = ENCHANT_TIERS.find(t => lvl >= t.level && inv.some(i => i.id === t.ringId));
  if (!tier) return;
  const ring = inv.find(i => i.id === tier.ringId)!;
  const st = spec.sdk.getState();
  const beforeCount = countItem(inv, tier.ringId);
  if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  await spec.direct({ type: 'spellOnItem', slot: ring.slot, spellComponent: tier.component, reason: 'SDK' });
  // Packet executes on next engine tick (T+1), setting p_delay(1) -> delayedUntil = T+3.
  await waitTicks(spec, 1);
  if (countItem(spec.sdk.getInventory(), tier.ringId) < beforeCount) {
   casts++;
   // p_delay(1) keeps delayedUntil active across 2 ticks; sleep 2 ticks so next cast executes immediately on T+3.
   await waitTicks(spec, 2);
  } else {
   misses++;
   lastMiss = (spec.sdk.getState()?.gameMessages ?? []).slice(-2).map(m => m.text).join(' | ');
  }
 }
 } finally {
  console.log(`ENCHANT_STATS ${label} ticks=${spec.tick() - begin} casts=${casts} misses=${misses} lastMiss=${lastMiss}`);
 }
}

async function buryBones(spec: Session, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  const bone = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.dragon_bones);
  if (!bone) return;
  const acts: Promise<unknown>[] = [];
  if (spec.sdk.getState()?.dialog?.isOpen) acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  acts.push(spec.direct({ type: 'useInventoryItem', slot: bone.slot, optionIndex: 1, reason: 'SDK' }));
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
}

async function slashWebAt(spec: Session, webX: number, webZ: number, walkX: number, walkZ: number, arrived: () => boolean, deadline: number): Promise<void> {
 while (spec.tick() < deadline) {
  if (arrived()) return;
  const web = findLocBy(spec, l => l.id === 733 && l.x === webX && l.z === webZ)
   ?? findLocBy(spec, l => l.id === 733 && Math.max(Math.abs(l.x - webX), Math.abs(l.z - webZ)) <= 1);
  const knife = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.knife);
  const p = playerPos(spec);
  if (web && knife) {
   await spec.direct({ type: 'useItemOnLoc', itemSlot: knife.slot, x: web.x, z: web.z, locId: web.id, reason: 'SDK' });
  } else if (p && Math.max(Math.abs(p.worldX - webX), Math.abs(p.worldZ - webZ)) > 8) {
   const stepX = p.worldX + Math.max(-10, Math.min(10, webX - p.worldX));
   const stepZ = p.worldZ + Math.max(-10, Math.min(10, (webZ - 1) - p.worldZ));
   await spec.direct({ type: 'walkTo', x: stepX, z: stepZ, running: true, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x: walkX, z: walkZ, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 throw Error(`slashWebAt(${webX},${webZ}) exceeded cap`);
}

async function keepProtectedInArena(spec: Session): Promise<void> {
 const st = spec.sdk.getState();
 const prayerPts = st?.prayers?.prayerPoints ?? 0;
 const magicPrayOn = !!st?.prayers?.activePrayers?.[PROTECT_FROM_MAGIC_INDEX];
 const inv = spec.sdk.getInventory();
 if (prayerPts <= 14) {
  const pot = inv.find(i => [2434, 139, 141, 143].includes(i.id));
  if (pot) await spec.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' });
 }
 if (!magicPrayOn && (spec.sdk.getState()?.prayers?.prayerPoints ?? 0) > 0) {
  await spec.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MAGIC_INDEX, reason: 'SDK' });
 }
 const hp = spec.sdk.getSkill('Hitpoints')?.level ?? 10;
 if (hp <= 7) {
  const shark = inv.find(i => i.id === ITEM_IDS.shark);
  if (shark) await spec.direct({ type: 'useInventoryItem', slot: shark.slot, optionIndex: 1, reason: 'SDK' });
 }
}

async function completeMageArena(spec: Session, start: number, deadline: number): Promise<void> {
 let lastEnergyTick = -10;
 const superEnergyIds = [ITEM_IDS.super_energy_4, 3018, 3020, 3022];
 const offEnergy = spec.onTick(() => {
  if (spec.tick() - lastEnergyTick < 3) return;
  const st = spec.sdk.getState();
  if ((st?.player?.runEnergy ?? 100) >= 45 || st?.dialog?.isOpen) return;
  const pot = spec.sdk.getInventory().find(i => superEnergyIds.includes(i.id));
  if (!pot) return;
  lastEnergyTick = spec.tick();
  void spec.direct({ type: 'useInventoryItem', slot: pot.slot, optionIndex: 1, reason: 'SDK' }).catch(() => {});
 });
 try {
 const camelot = componentId('magic:camelot_teleport');
 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (p && p.worldX < 2820 && p.worldZ > 3420 && p.worldZ < 4000) break;
  if (spec.sdk.getState()?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  await spec.direct({ type: 'clickComponent', componentId: camelot, reason: 'SDK' });
  await waitTicks(spec, 1);
 }

 // East Ardougne Wilderness lever -> Deserted Keep
 const camelotWalker = await sessionWalker(spec);
 const ardyWalk = await walkPath(camelotWalker, [{ x: ARDOUGNE_LEVER.x, z: ARDOUGNE_LEVER.z, tol: 2 }], {
  maxTicks: Math.max(10, Math.min(130, deadline - spec.tick())),
 });
 if (!ardyWalk.ok && !nearTile(spec, ARDOUGNE_LEVER.x, ARDOUGNE_LEVER.z, 2)) {
  await navigateWorld(spec, ARDOUGNE_LEVER.x, ARDOUGNE_LEVER.z, 0, Math.max(10, deadline - spec.tick()));
 }
 while (spec.tick() < deadline) {
  const p = playerPos(spec);
  if (p && p.worldX > 3120 && p.worldZ > 3900) break;
  const d = spec.sdk.getDialog();
  if (d?.isOpen && !d.isWaiting) {
   const yes = d.options.find((o: any) => /yes|brave|pull/i.test(o.text));
   await spec.direct({ type: 'clickDialogOption', optionIndex: yes?.index ?? d.options[0]?.index ?? 0, reason: 'SDK' });
  } else if (!d?.isOpen) {
   const lever = findLocBy(spec, l => l.id === 1814);
   if (lever) await spec.direct({ type: 'interactLoc', x: lever.x, z: lever.z, locId: lever.id, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 logPhase(spec, start, 'magic_wildy_keep');

 // Exit Deserted Keep inner walls before slashing north Keep web (3158,3951) -> run to Mage Arena cellar.
 const keepWalker = await sessionWalker(spec);
 await walkPath(keepWalker, [{ x: 3158, z: 3950, tol: 1 }], { maxTicks: Math.max(10, Math.min(40, deadline - spec.tick())) });
 await slashWebAt(spec, 3158, 3951, 3158, 3952, () => (playerPos(spec)?.worldZ ?? 0) >= 3952, deadline);
 const arenaWalk = await walkPath(keepWalker, [{ x: MAGE_ARENA_DOOR_AREA.x, z: MAGE_ARENA_DOOR_AREA.z, tol: 1 }], {
  maxTicks: Math.max(10, Math.min(55, deadline - spec.tick())),
 });
 if (!arenaWalk.ok && !nearTile(spec, MAGE_ARENA_DOOR_AREA.x, MAGE_ARENA_DOOR_AREA.z, 2)) {
  await navigateWorld(spec, MAGE_ARENA_DOOR_AREA.x, MAGE_ARENA_DOOR_AREA.z, 0, Math.max(10, deadline - spec.tick()));
 }
 await slashWebAt(spec, 3095, 3957, 3094, 3957, () => (playerPos(spec)?.worldX ?? 9999) <= 3094, deadline);
 await slashWebAt(spec, 3093, 3957, 3092, 3957, () => (playerPos(spec)?.worldX ?? 9999) <= 3092, deadline);

 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) < 4500) {
  const ladder = findLocBy(spec, l => l.id === 2871 || /ladder/i.test(l.name));
  if (ladder) await spec.direct({ type: 'interactLoc', x: ladder.x, z: ladder.z, locId: ladder.id, optionIndex: 1, reason: 'SDK' });
  await waitTicks(spec, 1);
 }

 // Talk Kolodion (905) -> teleported into Arena
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) > 4500) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) {
    const opt = d.options.find((o: any) => /can i fight|enter|yes|sure|ready|try|fight/i.test(o.text));
    await spec.direct({ type: 'clickDialogOption', optionIndex: opt?.index ?? d.options[0]?.index ?? 0, reason: 'SDK' });
   }
  } else {
   const kolo = findNpcBy(spec, n => n.id === 905 || /^kolodion$/i.test(n.name));
   if (kolo) await spec.direct({ type: 'interactNpc', npcIndex: kolo.index, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 logPhase(spec, start, 'magic_kolodion_arena');

 // Fight all 5 Kolodion forms with Fire Wave + Protect from Magic
 const fireWave = componentId('magic:fire_wave');
 const fireBlast = componentId('magic:fire_blast');
 let prevCastXp = skillXp(spec, 'Magic');
 let lastCastXpTick = -99;
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) < 4500) {
  await keepProtectedInArena(spec);
  const nowXp = skillXp(spec, 'Magic');
  if (nowXp > prevCastXp) {
   prevCastXp = nowXp;
   // Observation XP updates 1 tick after cast execution, so subtract 1 tick to sustain exact 5-tick cadence.
   lastCastXpTick = spec.tick() - 1;
  }
  const acts: Promise<unknown>[] = [];
  if (spec.sdk.getState()?.dialog?.isOpen) {
   acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  }
  const boss = spec.sdk.getNearbyNpcs().find(n => [907, 908, 909, 910, 911].includes(n.id) || (/kolodion/i.test(n.name) && n.optionsWithIndex.some(o => /attack/i.test(o.text))));
  if (boss && spec.tick() - lastCastXpTick >= 4) {
   const spell = skillLevel(spec, 'Magic') >= 75 ? fireWave : fireBlast;
   acts.push(spec.direct({ type: 'spellOnNpc', npcIndex: boss.index, spellComponent: spell, reason: 'SDK' }));
  }
  if (acts.length) await Promise.all(acts);
  await waitTicks(spec, 1);
 }

 // Disable Protect from Magic once returned to cellar
 if (spec.sdk.getState()?.prayers?.activePrayers?.[PROTECT_FROM_MAGIC_INDEX]) {
  await spec.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MAGIC_INDEX, reason: 'SDK' });
 }

 // Finish Kolodion dialog -> jump Sparkling Pool (2878) -> Chamber (2509,4689)
 while (spec.tick() < deadline) {
  const pool = findLocBy(spec, l => l.id === 2878);
  const p = playerPos(spec);
  if (p && p.worldZ > 4600 && p.worldX < 2525 && !pool) break;
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
  } else if (pool) {
   await spec.direct({ type: 'interactLoc', x: pool.x, z: pool.z, locId: pool.id, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // Path inside Chamber from Sparkling Pool (2509,4689) to Zamorak statue (2516,4720), then pray & pick up cape (2414).
 const chamberWalker = await sessionWalker(spec);
 await walkPath(chamberWalker, [{ x: 2516, z: 4718, tol: 2 }], { maxTicks: Math.max(10, Math.min(30, deadline - spec.tick())) });

 // Pray at Zamorak statue (2874 at 2516,4721) -> click mesbox continues -> pick up cape (2414) off ground
 while (spec.tick() < deadline && countItem(spec.sdk.getInventory(), 2414) === 0) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  await spec.sdk.scanGroundItems(5);
  const groundCape = spec.sdk.getState()?.groundItems?.find((g: any) => g.id === 2414);
  if (groundCape) {
   await spec.direct({ type: 'pickupItem', x: groundCape.x, z: groundCape.z, itemId: 2414, reason: 'SDK' });
  } else {
   const statue = findLocBy(spec, l => l.id === 2874);
   if (statue) await spec.direct({ type: 'interactLoc', x: statue.x, z: statue.z, locId: statue.id, optionIndex: 1, reason: 'SDK' });
   else await spec.direct({ type: 'walkTo', x: 2516, z: 4718, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // Path back to Chamber Guardian (904 at 2508,4696) -> receive staff (2417, sets %magearena = 8)
 await walkPath(chamberWalker, [{ x: 2508, z: 4695, tol: 2 }], { maxTicks: Math.max(10, Math.min(30, deadline - spec.tick())) });
 while (spec.tick() < deadline && countItem(spec.sdk.getInventory(), 2417) === 0) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
  } else {
   const guardian = findNpcBy(spec, n => n.id === 904 || /guardian/i.test(n.name));
   if (guardian) await spec.direct({ type: 'interactNpc', npcIndex: guardian.index, optionIndex: 1, reason: 'SDK' });
   else await spec.direct({ type: 'walkTo', x: 2508, z: 4695, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 if (spec.sdk.getState()?.dialog?.isOpen) {
  await spec.direct({ type: 'closeModal', reason: 'SDK' });
 }
 logPhase(spec, start, 'magic_charge_unlocked');
 } finally {
  offEnergy();
 }
}

async function spamChargeTo99(spec: Session, target: number, deadline: number): Promise<void> {
 const charge = componentId('magic:charge');
 while (spec.tick() < deadline && skillLevel(spec, 'Magic') < target) {
  // charge.rs2 calls if_close on click and has zero p_delay: all 5 casts/tick resolve even over levelup modals.
  const acts: Promise<unknown>[] = [];
  for (let i = 0; i < 5; i++) {
   acts.push(spec.direct({ type: 'clickComponent', componentId: charge, reason: 'SDK' }));
  }
  await Promise.all(acts);
  await waitTicks(spec, 1);
 }
}

async function executeMagicLoop(
 spec: Session,
 target: number,
 start: number,
 deadline: number,
 receiveBatch: (batch: MagicBatchPlan, index: number) => Promise<void>,
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);

 let windTicks = 0;
 let tradeTicks = 0;
 let enchantTicks = 0;
 for (let i = 0; i < MAGIC_BATCHES.length; i++) {
  const batch = MAGIC_BATCHES[i]!;
  if (i === 1) {
   // Drop leftover mind/water runes and Batch 0 shark; retain ring_of_recoil and ring_of_dueling_8 to return in Batch 1.
   await dropItemsFast(
    spec,
    new Set([ITEM_IDS.cosmicrune, ITEM_IDS.airrune, ITEM_IDS.earthrune, ITEM_IDS.ring_of_recoil, ITEM_IDS.ring_of_dueling_8]),
    deadline,
   );
  } else if (i === 5) {
   // Drop Earth runes and Ring of life once all 36 Diamond rings finish so Batch 5 fits 25 Ruby rings.
   await dropItemsFast(spec, new Set([ITEM_IDS.cosmicrune, ITEM_IDS.airrune, ITEM_IDS.ring_of_forging]), deadline);
  }
  const tr0 = spec.tick();
  await receiveBatch(batch, i);
  tradeTicks += spec.tick() - tr0;
  if (i === 0) {
   const staff = spec.sdk.getInventory().find(x => x.id === ITEM_IDS.staff_of_fire);
   if (staff) await spec.bot.equipItem(staff);
   const w0 = spec.tick();
   await castWindStrikeToLevel7(spec, deadline);
   windTicks = spec.tick() - w0;
   if (!nearTile(spec, LUMBRIDGE_SAFE_SPOT.x, LUMBRIDGE_SAFE_SPOT.z, 2, LUMBRIDGE_SAFE_SPOT.level)) {
    const courtyardWalker = await sessionWalker(spec);
    await walkPath(courtyardWalker, [{ x: LUMBRIDGE_SAFE_SPOT.x, z: LUMBRIDGE_SAFE_SPOT.z, tol: 1 }], {
     maxTicks: Math.max(10, Math.min(25, deadline - spec.tick())),
    });
   }
  }
  const e0 = spec.tick();
  await enchantHeldRings(spec, target, deadline, `batch${i}`);
  enchantTicks += spec.tick() - e0;
 }

 const amulet = spec.sdk.getInventory().find(x => x.id === ITEM_IDS.amulet_of_magic);
 if (amulet) await spec.bot.equipItem(amulet);
 await buryBones(spec, deadline);
 const preArenaTicks = spec.tick() - start;
 logPhase(spec, start, `magic_pre_arena lvl=${skillLevel(spec, 'Magic')} pray=${skillLevel(spec, 'Prayer')}`);

 if (skillLevel(spec, 'Magic') < 75) throw Error(`magic < 75 (${skillLevel(spec, 'Magic')}) before Mage Arena`);
 await completeMageArena(spec, start, deadline);
 const arenaDoneTicks = spec.tick() - start;
 // If fast Kolodion damage rolls leave Magic slightly under 80, Camelot Teleports bridge the final XP cleanly.
 const camelotFallback = componentId('magic:camelot_teleport');
 while (spec.tick() < deadline && skillLevel(spec, 'Magic') < 80) {
  await spec.direct({ type: 'clickComponent', componentId: camelotFallback, reason: 'SDK' });
  await waitTicks(spec, 4);
 }
 if (skillLevel(spec, 'Magic') < 80) throw Error(`magic < 80 (${skillLevel(spec, 'Magic')}) before Charge`);
 await spamChargeTo99(spec, target, deadline);

 const level = skillLevel(spec, 'Magic');
 const xp = skillXp(spec, 'Magic');
 const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
 const ticks = spec.tick() - start;
 return {
  ok,
  detail: `skill=magic level=${level} xp=${xp} ticks=${ticks} pre=${preArenaTicks} arena=${arenaDoneTicks} wind=${windTicks} ench=${enchantTicks} tr=${tradeTicks} at=${playerPos(spec)?.worldX},${playerPos(spec)?.worldZ}`,
  ticks,
  level,
  xp,
 };
}

export async function runMagicSpecialist(
 spec: Session,
 helpers: readonly Session[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(MAGIC_SUPPLY_BILL);
 if (helpers.length < MAGIC_BATCHES.length) {
  throw Error(`magic specialist requires ${MAGIC_BATCHES.length} helpers, got ${helpers.length}`);
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
  return await executeMagicLoop(spec, target, start, deadline, (batch, i) =>
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

export async function runMagicExternal(
 spec: Session,
 supplierNames: readonly string[],
 opts: { cap: number; target?: number },
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 assertCatalogItems(MAGIC_SUPPLY_BILL);
 if (!supplierNames.length) throw Error('magic external mode requires at least 1 supplier');
 const target = opts.target ?? 99;
 const start = spec.tick();
 const deadline = start + opts.cap;
 return executeMagicLoop(spec, target, start, deadline, async (batch, index) => {
  const targets = supplierNames.length >= MAGIC_BATCHES.length ? [supplierNames[index]!] : supplierNames;
  await fastTradeExternalReceive(spec, targets, {
   returnIds: batch.returnIds,
   acceptOffer: offer => batch.give.every(g => countItem(offer, g.id) >= g.count),
   deadlineTick: deadline,
  });
 });
}

if (import.meta.main) {
 const cfg = parseSpecialistArgs(process.argv.slice(2), process.env, {
  cap: 1300,
  target: 99,
  defaultHelpers: MAGIC_BATCHES.length,
 });
 const externalSuppliers = parseExternalSuppliers(cfg.env);
 if (externalSuppliers.length > 0) {
  await withSingleSpecialist(cfg.account, spec =>
   runMagicExternal(spec, externalSuppliers, { cap: cfg.cap, target: cfg.target }),
  );
 } else {
  await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
   runMagicSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
  );
 }
}
