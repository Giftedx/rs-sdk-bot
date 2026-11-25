// Fresh-account 1-to-99 Magic specialist via Enchant ladder, East Ardougne lever, Kolodion, and 5-per-tick Charge.
import type { Session } from '../packages/core/src/inprocess';
import { prayerGuards } from '../packages/core/src/bot/monitors';
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
 { spell: 'magic:enchant_lvl5', component: componentId('magic:enchant_lvl5'), level: 68, ringId: ITEM_IDS.dragonstone_ring, xp: 1950 },
];

export interface MagicBatchPlan {
 give: readonly { id: number; count: number }[];
 returnIds: readonly number[];
}

export const MAGIC_BATCHES: readonly MagicBatchPlan[] = [
 // Batch 0 (28 slots): staff(1) + 5 runes + 8 dragon bones (buried during Wind Strike) + 12 sapphire + 1 emerald + 1 shark
 {
  give: [
   { id: ITEM_IDS.staff_of_fire, count: 1 },
   { id: ITEM_IDS.mindrune, count: 25 },
   { id: ITEM_IDS.cosmicrune, count: 150 },
   { id: ITEM_IDS.waterrune, count: 650 },
   { id: ITEM_IDS.airrune, count: 850 },
   { id: ITEM_IDS.earthrune, count: 1050 },
   { id: ITEM_IDS.dragon_bones, count: 8 },
   { id: ITEM_IDS.sapphire_ring, count: 12 },
   { id: ITEM_IDS.emerald_ring, count: 1 },
   { id: ITEM_IDS.shark, count: 1 },
  ],
  returnIds: [],
 },
 // Batch 1 (24 emerald -> 25 emerald total)
 {
  give: [
   { id: ITEM_IDS.emerald_ring, count: 24 },
  ],
  returnIds: [],
 },
 // Batch 2 (2 emerald -> 27 total Lv 49 + 16 ruby -> Lv 57 + 6 diamond)
 {
  give: [
   { id: ITEM_IDS.emerald_ring, count: 2 },
   { id: ITEM_IDS.ruby_ring, count: 16 },
   { id: ITEM_IDS.diamond_ring, count: 6 },
  ],
  returnIds: [],
 },
 // Batch 3 (24 diamond -> 30 total)
 {
  give: [
   { id: ITEM_IDS.diamond_ring, count: 24 },
  ],
  returnIds: [],
 },
 // Batch 4 (7 diamond -> 37 total + 14 dragonstone -> exact Lv 71 for Magic pot Fire Wave)
 {
  give: [
   { id: ITEM_IDS.diamond_ring, count: 7 },
   { id: ITEM_IDS.dragonstone_ring, count: 14 },
  ],
  returnIds: [],
 },
 // Batch 5 (18 slots -> 24 on spec with 4 runes: 12 dragonstone enchanted during Kolodion cooldown + Mage Arena gear)
 {
  give: [
   { id: ITEM_IDS.dragonstone_ring, count: 12 },
   { id: ITEM_IDS.lawrune, count: 10 },
   { id: ITEM_IDS.bloodrune, count: 750 },
   { id: ITEM_IDS.knife, count: 1 },
   { id: ITEM_IDS.prayer_potion_4, count: 1 },
   { id: ITEM_IDS.magic_potion_4, count: 1 },
   { id: ITEM_IDS.amulet_of_magic, count: 1 },
  ],
  returnIds: [],
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
  [ITEM_IDS.dragonstone_ring, 'Dragonstone ring'],
  [ITEM_IDS.knife, 'Knife'],
  [ITEM_IDS.dragon_bones, 'Dragon bones'],
  [ITEM_IDS.prayer_potion_4, 'Prayer potion(4)'],
  [ITEM_IDS.magic_potion_4, 'Magic potion(4)'],
  [ITEM_IDS.amulet_of_magic, 'Amulet of magic'],
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
 let prevCastXp = skillXp(spec, 'Magic');
 let lastCastTick = -99;
 while (spec.tick() < deadline) {
  if (skillLevel(spec, 'Magic') >= 7) break;
  const nowXp = skillXp(spec, 'Magic');
  if (nowXp > prevCastXp) {
   prevCastXp = nowXp;
   lastCastTick = spec.tick() - 1;
  }
  const npcs = spec.sdk.getNearbyNpcs();
  await eatSharkIfLow(spec);
  const st = spec.sdk.getState();
  if (st?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  const bone = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.dragon_bones);
  const sinceCast = spec.tick() - lastCastTick;
  // Bury up to 2 dragon bones inside each 5-tick Wind Strike combat cooldown for zero extra Prayer 37 ticks.
  if (bone && sinceCast >= 1 && sinceCast <= 3) {
   await spec.direct({ type: 'useInventoryItem', slot: bone.slot, optionIndex: 1, reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  const candidates = npcs.filter(
   n =>
    /^(chicken|rat|giant rat|spider|giant spider|goblin|imp)$/i.test(n.name) &&
    n.optionsWithIndex.some(o => /^attack$/i.test(o.text)),
  );
  const reachable = candidates.filter(n => n.reachable !== false);
  const npc = (reachable.length ? reachable : candidates).sort(
   (a, b) => a.distance - b.distance || (isPassiveTarget(a.name) ? 0 : 1) - (isPassiveTarget(b.name) ? 0 : 1),
  )[0];
  if (npc) {
   await spec.direct({ type: 'spellOnNpc', npcIndex: npc.index, spellComponent: windStrike, reason: 'SDK' });
  } else {
   await spec.direct({ type: 'walkTo', x: LUMBRIDGE_SAFE_SPOT.x, z: LUMBRIDGE_SAFE_SPOT.z, running: true, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 // Finish any remaining Batch 0 dragon bones before Batch 1 drops junk so Prayer reaches 37 for Protect from Magic.
 while (spec.tick() < deadline) {
  const bone = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.dragon_bones);
  if (!bone) break;
  const acts: Promise<unknown>[] = [];
  if (spec.sdk.getState()?.dialog?.isOpen) acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  acts.push(spec.direct({ type: 'useInventoryItem', slot: bone.slot, optionIndex: 1, reason: 'SDK' }));
  await Promise.all(acts);
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
 if ((spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')) < 75) {
  const mPot = inv.find(i => [ITEM_IDS.magic_potion_4, 3042, 3044, 3046].includes(i.id));
  if (mPot) await spec.direct({ type: 'useInventoryItem', slot: mPot.slot, optionIndex: 1, reason: 'SDK' });
 }
}

async function completeMageArena(spec: Session, start: number, deadline: number): Promise<void> {
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
 logPhase(spec, start, 'magic_cam_tele');
 const ardyWalk = await walkPath(
  camelotWalker,
  [
   { x: 2749, z: 3458, tol: 2 },
   { x: 2712, z: 3451, tol: 2 },
   { x: 2690, z: 3430, tol: 2 },
   { x: 2664, z: 3406, tol: 2 },
   { x: 2612, z: 3393, tol: 2 },
   { x: 2582, z: 3351, tol: 2 },
   { x: 2580, z: 3321, tol: 2 },
   { x: ARDOUGNE_LEVER.x, z: ARDOUGNE_LEVER.z, tol: 1 },
  ],
  { maxTicks: Math.max(10, Math.min(125, deadline - spec.tick())) },
 );
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
 const arenaWalk = await walkPath(
  keepWalker,
  [
   { x: 3129, z: 3957, tol: 2 },
   { x: 3111, z: 3955, tol: 2 },
   { x: MAGE_ARENA_DOOR_AREA.x, z: MAGE_ARENA_DOOR_AREA.z, tol: 1 },
  ],
  { maxTicks: Math.max(10, Math.min(40, deadline - spec.tick())) },
 );
 if (!arenaWalk.ok && !nearTile(spec, MAGE_ARENA_DOOR_AREA.x, MAGE_ARENA_DOOR_AREA.z, 2)) {
  await navigateWorld(spec, MAGE_ARENA_DOOR_AREA.x, MAGE_ARENA_DOOR_AREA.z, 0, Math.max(10, deadline - spec.tick()));
 }
 await slashWebAt(spec, 3095, 3957, 3094, 3957, () => (playerPos(spec)?.worldX ?? 9999) <= 3094, deadline);
 await slashWebAt(spec, 3093, 3957, 3092, 3957, () => (playerPos(spec)?.worldX ?? 9999) <= 3092, deadline);
 const knifeDropSlot = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.knife)?.slot;
 if (knifeDropSlot !== undefined) {
  void spec.direct({ type: 'dropItem', slot: knifeDropSlot, reason: 'SDK' });
 }

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

 // Fight all 5 Kolodion forms with Fire Blast/Wave + Protect from Magic, enchanting rings inside the 5-tick cooldown.
 const fireWave = componentId('magic:fire_wave');
 const fireBlast = componentId('magic:fire_blast');
 const enchantLvl5 = ENCHANT_TIERS[4]!;
 let prevCastXp = skillXp(spec, 'Magic');
 let lastCastXpTick = -99;
 let lastEnchantSentTick = -99;
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) < 4500) {
  await keepProtectedInArena(spec);
  const nowXp = skillXp(spec, 'Magic');
  if (nowXp > prevCastXp) {
   prevCastXp = nowXp;
   lastCastXpTick = spec.tick() - 1;
  }
  const acts: Promise<unknown>[] = [];
  if (spec.sdk.getState()?.dialog?.isOpen) {
   acts.push(spec.direct({ type: 'closeModal', reason: 'SDK' }));
  }
  const boss = spec.sdk.getNearbyNpcs().find(n => [907, 908, 909, 910, 911].includes(n.id) || (/kolodion/i.test(n.name) && n.optionsWithIndex.some(o => /attack/i.test(o.text))));
  const sinceCast = spec.tick() - lastCastXpTick;
  if (boss && sinceCast >= 4) {
   const spell = (spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')) >= 75 ? fireWave : fireBlast;
   acts.push(spec.direct({ type: 'spellOnNpc', npcIndex: boss.index, spellComponent: spell, reason: 'SDK' }));
  } else if (sinceCast === 1 && spec.tick() - lastEnchantSentTick >= 4 && skillLevel(spec, 'Magic') >= enchantLvl5.level) {
   const dRing = spec.sdk.getInventory().find(i => i.id === ITEM_IDS.dragonstone_ring);
   if (dRing) {
    lastEnchantSentTick = spec.tick();
    acts.push(spec.direct({ type: 'spellOnItem', slot: dRing.slot, spellComponent: enchantLvl5.component, reason: 'SDK' }));
   }
  }
  if (acts.length) await Promise.all(acts);
  await waitTicks(spec, 1);
 }
 logPhase(spec, start, 'magic_kolodion_done');

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
 logPhase(spec, start, 'magic_pool_done');

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
 logPhase(spec, start, 'magic_guardian_start');
 while (spec.tick() < deadline && countItem(spec.sdk.getInventory(), 2417) === 0) {
  const st = spec.sdk.getState();
  const d = spec.sdk.getDialog();
  if (st?.interface?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  if (d?.isOpen) {
   if (!d.isWaiting) {
    const safeOpt = d.options.find((o: any) => /no thanks|charge/i.test(o.text));
    if (d.options.some((o: any) => /what do you have to offer/i.test(o.text))) {
     if (safeOpt) await spec.direct({ type: 'clickDialogOption', optionIndex: safeOpt.index, reason: 'SDK' });
     else await spec.direct({ type: 'closeModal', reason: 'SDK' });
    } else {
     await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
    }
   }
  } else {
   await spec.sdk.scanGroundItems(5);
   const groundStaff = spec.sdk.getState()?.groundItems?.find((g: any) => g.id === 2417);
   if (groundStaff) {
    await spec.direct({ type: 'pickupItem', x: groundStaff.x, z: groundStaff.z, itemId: 2417, reason: 'SDK' });
   } else {
    const guardian = findNpcBy(spec, n => n.id === 904 || /guardian/i.test(n.name));
    if (guardian) await spec.direct({ type: 'interactNpc', npcIndex: guardian.index, optionIndex: 1, reason: 'SDK' });
    else await spec.direct({ type: 'walkTo', x: 2508, z: 4695, running: true, reason: 'SDK' });
   }
  }
  await waitTicks(spec, 1);
 }
 if (spec.sdk.getState()?.dialog?.isOpen) {
  await spec.direct({ type: 'closeModal', reason: 'SDK' });
 }
 logPhase(spec, start, 'magic_charge_unlocked');
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
 useSafeFoyer = false,
): Promise<{ ok: boolean; detail: string; ticks: number; level: number; xp: number }> {
 // Mage Arena fight sends spellOnNpc/spellOnItem every tick under explicit Protect from Magic; stop auto-PrayerGuard holds.
 prayerGuards.get(spec)?.stop();
 await skipTutorialFast(spec, deadline);
 await dropItemsFast(spec, new Set(), deadline);
 if (((spec.client as { var?: number[] } | undefined)?.var?.[173] ?? 0) !== 1) {
  await spec.direct({ type: 'clickComponent', componentId: 153, reason: 'SDK' });
 }

 let windTicks = 0;
 let tradeTicks = 0;
 let enchantTicks = 0;
 for (let i = 0; i < MAGIC_BATCHES.length; i++) {
  const batch = MAGIC_BATCHES[i]!;
  if (i >= 1) {
   // Drop finished jewellery and Batch 0 leftovers (mindrune/shark) at 5/tick so Batch 1..4 (24 rings + 4 runes) fit in 28 slots.
   await dropItemsFast(
    spec,
    new Set([ITEM_IDS.cosmicrune, ITEM_IDS.airrune, ITEM_IDS.waterrune, ITEM_IDS.earthrune]),
    deadline,
   );
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
   const courtyardWalker = await sessionWalker(spec);
   if (useSafeFoyer) {
    // Move inside Lumbridge Castle foyer (3210,3218) so wandering Giant spiders cannot interrupt Batch 1..5 trades.
    await walkPath(
     courtyardWalker,
     [
      { x: 3215, z: 3219, tol: 1 },
      { x: 3210, z: 3218, tol: 0 },
     ],
     { maxTicks: Math.max(10, Math.min(25, deadline - spec.tick())) },
    );
   } else if (!nearTile(spec, LUMBRIDGE_SAFE_SPOT.x, LUMBRIDGE_SAFE_SPOT.z, 2, LUMBRIDGE_SAFE_SPOT.level)) {
    await walkPath(courtyardWalker, [{ x: LUMBRIDGE_SAFE_SPOT.x, z: LUMBRIDGE_SAFE_SPOT.z, tol: 1 }], {
     maxTicks: Math.max(10, Math.min(25, deadline - spec.tick())),
    });
   }
  }
  if (i < MAGIC_BATCHES.length - 1) {
   const e0 = spec.tick();
   await enchantHeldRings(spec, target, deadline, `batch${i}`);
   enchantTicks += spec.tick() - e0;
  }
 }

 const amulet = spec.sdk.getInventory().find(x => x.id === ITEM_IDS.amulet_of_magic);
 if (amulet) await spec.bot.equipItem(amulet);
 await buryBones(spec, deadline);
 const preArenaTicks = spec.tick() - start;
 logPhase(spec, start, `magic_pre_arena lvl=${skillLevel(spec, 'Magic')} pray=${skillLevel(spec, 'Prayer')}`);

 if (skillLevel(spec, 'Magic') < 60) throw Error(`magic < 60 (${skillLevel(spec, 'Magic')}) before Mage Arena`);
 await completeMageArena(spec, start, deadline);
 const arenaDoneTicks = spec.tick() - start;
 // Finish any remaining dragonstone rings if Kolodion ended before Lv 76, then drink Magic potion(+4) for Charge at 80.
 if (skillLevel(spec, 'Magic') < 76) {
  const ePost0 = spec.tick();
  await enchantHeldRings(spec, 76, deadline, 'postArena');
  enchantTicks += spec.tick() - ePost0;
 }
 if (skillLevel(spec, 'Magic') >= 76 && (spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')) < 80) {
  const magicPot = spec.sdk.getInventory().find(i => [ITEM_IDS.magic_potion_4, 3042, 3044, 3046].includes(i.id));
  if (magicPot) {
   await spec.direct({ type: 'useInventoryItem', slot: magicPot.slot, optionIndex: 1, reason: 'SDK' });
   await waitTicks(spec, 1);
  }
 }
 // Fallback if still below boosted 80 Magic.
 const camelotFallback = componentId('magic:camelot_teleport');
 while (spec.tick() < deadline && (spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')) < 80) {
  await spec.direct({ type: 'clickComponent', componentId: camelotFallback, reason: 'SDK' });
  await waitTicks(spec, 4);
 }
 if ((spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')) < 80) {
  throw Error(`magic < 80 (${spec.sdk.getSkill('Magic')?.level ?? skillLevel(spec, 'Magic')}) before Charge`);
 }
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
 const keepers = helpers.map((h, idx) =>
  (async () => {
   if (idx >= 1) {
    const hw = await sessionWalker(h);
    await walkPath(hw, [{ x: 3215, z: 3219, tol: 1 }, { x: 3211, z: 3218, tol: 1 }], { maxTicks: 25 }).catch(() => {});
   }
   while (!done && h.tick() < deadline) await waitTicks(h, 1);
  })(),
 );

 try {
  return await executeMagicLoop(
   spec,
   target,
   start,
   deadline,
   (batch, i) =>
    burstTradeHost(spec, helpers[i]!, {
     giveIds: batch.give.map(g => g.id),
     returnIds: batch.returnIds,
     deadlineTick: deadline,
     allowHelperOnSingleModal: true,
    }),
   true,
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
 process.env.PRAYER_GUARD ??= '0';
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
