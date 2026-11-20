// Fresh-account 1-to-99 Magic specialist via Enchant ladder, East Ardougne lever, Kolodion, and 5-per-tick Charge.
import type { Session } from '../packages/core/src/inprocess';
import { componentId } from '../packages/core/src/logout';
import {
 assertCatalogItems,
 burstTradeHost,
 countItem,
 dropItemsFast,
 findLocBy,
 findNpcBy,
 goalXp,
 ITEM_IDS,
 logPhase,
 navigateWorld,
 parseSpecialistArgs,
 playerPos,
 skipTutorialFast,
 skillLevel,
 skillXp,
 waitTicks,
 waitUntil,
 withSpecialistFleet,
 type SupplyEntry,
} from './fast-skills-lib';

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
 // Batch 0 (28 slots total): staff + 8 rune stacks + 12 sapphire + 6 emerald rings + 1 shark
 {
  give: [
   { id: ITEM_IDS.staff_of_fire, count: 1 },
   { id: ITEM_IDS.mindrune, count: 25 },
   { id: ITEM_IDS.cosmicrune, count: 240 },
   { id: ITEM_IDS.waterrune, count: 1600 },
   { id: ITEM_IDS.airrune, count: 2000 },
   { id: ITEM_IDS.earthrune, count: 1800 },
   { id: ITEM_IDS.firerune, count: 1600 },
   { id: ITEM_IDS.lawrune, count: 10 },
   { id: ITEM_IDS.bloodrune, count: 850 },
   { id: ITEM_IDS.sapphire_ring, count: 12 },
   { id: ITEM_IDS.emerald_ring, count: 6 },
   { id: ITEM_IDS.shark, count: 1 },
  ],
  returnIds: [],
 },
 // Batch 1 (21 emerald -> 27 emerald total, Lv 49)
 {
  give: [{ id: ITEM_IDS.emerald_ring, count: 21 }],
  returnIds: [ITEM_IDS.ring_of_recoil, ITEM_IDS.ring_of_dueling_8],
 },
 // Batch 2 (16 ruby + 4 diamond)
 {
  give: [
   { id: ITEM_IDS.ruby_ring, count: 16 },
   { id: ITEM_IDS.diamond_ring, count: 4 },
  ],
  returnIds: [ITEM_IDS.ring_of_dueling_8],
 },
 // Batch 3 (20 diamond)
 {
  give: [{ id: ITEM_IDS.diamond_ring, count: 20 }],
  returnIds: [ITEM_IDS.ring_of_forging, ITEM_IDS.ring_of_life],
 },
 // Batch 4 (13 diamond = 37 diamond total -> Lv 68 + 7 dragonstone)
 {
  give: [
   { id: ITEM_IDS.diamond_ring, count: 13 },
   { id: ITEM_IDS.dragonstone_ring, count: 7 },
  ],
  returnIds: [ITEM_IDS.ring_of_life],
 },
 // Batch 5 (20 dragonstone)
 {
  give: [{ id: ITEM_IDS.dragonstone_ring, count: 20 }],
  returnIds: [ITEM_IDS.ring_of_life, ITEM_IDS.ring_of_wealth],
 },
 // Batch 6 (20 dragonstone)
 {
  give: [{ id: ITEM_IDS.dragonstone_ring, count: 20 }],
  returnIds: [ITEM_IDS.ring_of_wealth],
 },
 // Batch 7 (20 dragonstone)
 {
  give: [{ id: ITEM_IDS.dragonstone_ring, count: 20 }],
  returnIds: [ITEM_IDS.ring_of_wealth],
 },
 // Batch 8 (13 dragonstone = 80 dragonstones total -> >=272,450 XP, Lv 80 ready for Charge)
 {
  give: [{ id: ITEM_IDS.dragonstone_ring, count: 13 }],
  returnIds: [ITEM_IDS.ring_of_wealth],
 },
 // Batch 9 (Mage Arena combat + prayer kit)
 {
  give: [
   { id: ITEM_IDS.knife, count: 1 },
   { id: ITEM_IDS.dragon_bones, count: 8 },
   { id: ITEM_IDS.prayer_potion_4, count: 2 },
   { id: ITEM_IDS.shark, count: 4 },
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
  [ITEM_IDS.shark, 'Shark'],
 ]);
 return [...counts.entries()].map(([itemId, count]) => ({
  itemId,
  item: names.get(itemId) ?? `Item ${itemId}`,
  count,
 }));
}

function magicKeepSet(): Set<number> {
 return new Set<number>([
  ITEM_IDS.staff_of_fire,
  ITEM_IDS.mindrune,
  ITEM_IDS.cosmicrune,
  ITEM_IDS.waterrune,
  ITEM_IDS.airrune,
  ITEM_IDS.earthrune,
  ITEM_IDS.firerune,
  ITEM_IDS.lawrune,
  ITEM_IDS.bloodrune,
  ITEM_IDS.sapphire_ring,
  ITEM_IDS.emerald_ring,
  ITEM_IDS.ruby_ring,
  ITEM_IDS.diamond_ring,
  ITEM_IDS.dragonstone_ring,
  ITEM_IDS.knife,
  ITEM_IDS.dragon_bones,
  ITEM_IDS.prayer_potion_4,
  ITEM_IDS.shark,
 ]);
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
 const isSafeTarget = (name: string) => /^(chicken|rat|giant rat|spider|giant spider|goblin|imp)$/i.test(name);
 while (spec.tick() < deadline) {
  const npcs = spec.sdk.getNearbyNpcs();
  const attacker = npcs.find(
   n => n.inCombat && n.distance <= 3 && /^(man|woman|goblin|spider|giant spider|rat|giant rat|imp)$/i.test(n.name),
  );
  if (skillLevel(spec, 'Magic') >= 7 && !attacker) break;
  await eatSharkIfLow(spec);
  const st = spec.sdk.getState();
  if (st?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  const npc =
   attacker ??
   npcs
    .filter(
     n =>
      /^(chicken|rat|giant rat|spider|giant spider|goblin|imp|man|woman)$/i.test(n.name) &&
      n.optionsWithIndex.some(o => /^attack$/i.test(o.text)),
    )
    .sort((a, b) => (isSafeTarget(a.name) ? 0 : 1) - (isSafeTarget(b.name) ? 0 : 1) || a.distance - b.distance)[0];
  if (npc) {
   await spec.direct({ type: 'spellOnNpc', npcIndex: npc.index, spellComponent: windStrike, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
}

async function enchantHeldRings(spec: Session, target: number, deadline: number): Promise<void> {
 while (spec.tick() < deadline && skillLevel(spec, 'Magic') < target) {
  await eatSharkIfLow(spec);
  const lvl = skillLevel(spec, 'Magic');
  const inv = spec.sdk.getInventory();
  const tier = ENCHANT_TIERS.find(t => lvl >= t.level && inv.some(i => i.id === t.ringId));
  if (!tier) return;
  const ring = inv.find(i => i.id === tier.ringId)!;
  const st = spec.sdk.getState();
  const beforeCount = countItem(inv, tier.ringId);
  const sentTick = spec.tick();
  if (st?.dialog?.isOpen && !st?.trade?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
  }
  await spec.direct({ type: 'spellOnItem', slot: ring.slot, spellComponent: tier.component, reason: 'SDK' });
  const done = await waitUntil(
   spec,
   () => spec.tick() > sentTick && (countItem(spec.sdk.getInventory(), tier.ringId) < beforeCount || !!spec.sdk.getState()?.dialog?.isOpen),
   { timeoutTicks: 5 },
  );
  if (done && countItem(spec.sdk.getInventory(), tier.ringId) < beforeCount) {
   // enchant.rs2 sets p_delay(1): server clears delayed on T+2, so sleeping 1 tick aligns next cast on T+3.
   await waitTicks(spec, 1);
  }
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
  if (web && knife) {
   await spec.direct({ type: 'useItemOnLoc', itemSlot: knife.slot, x: web.x, z: web.z, locId: web.id, reason: 'SDK' });
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
  await waitTicks(spec, 2);
 }

 // East Ardougne Wilderness lever -> Deserted Keep
 await navigateWorld(spec, ARDOUGNE_LEVER.x, ARDOUGNE_LEVER.z, 0, Math.max(10, deadline - spec.tick()));
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

 // Slash Keep web (3158,3951) -> run to Mage Arena cellar
 await navigateWorld(spec, 3158, 3950, 0, Math.max(10, deadline - spec.tick()));
 await slashWebAt(spec, 3158, 3951, 3158, 3952, () => (playerPos(spec)?.worldZ ?? 0) >= 3952, deadline);
 await navigateWorld(spec, MAGE_ARENA_DOOR_AREA.x, MAGE_ARENA_DOOR_AREA.z, 0, Math.max(10, deadline - spec.tick()));
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
 while (spec.tick() < deadline && (playerPos(spec)?.worldZ ?? 0) < 4500) {
  await keepProtectedInArena(spec);
  if (spec.sdk.getState()?.dialog?.isOpen) {
   await spec.direct({ type: 'closeModal', reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  const boss = spec.sdk.getNearbyNpcs().find(n => [907, 908, 909, 910, 911].includes(n.id) || (/kolodion/i.test(n.name) && n.optionsWithIndex.some(o => /attack/i.test(o.text))));
  if (boss) {
   const spell = skillLevel(spec, 'Magic') >= 75 ? fireWave : fireBlast;
   await spec.direct({ type: 'spellOnNpc', npcIndex: boss.index, spellComponent: spell, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // Disable Protect from Magic once returned to cellar
 if (spec.sdk.getState()?.prayers?.activePrayers?.[PROTECT_FROM_MAGIC_INDEX]) {
  await spec.direct({ type: 'togglePrayer', prayerIndex: PROTECT_FROM_MAGIC_INDEX, reason: 'SDK' });
 }

 // Finish Kolodion dialog -> jump Sparkling Pool (2878) -> Chamber
 while (spec.tick() < deadline) {
  const pool = findLocBy(spec, l => l.id === 2878);
  const statue = findLocBy(spec, l => l.id === 2874 || l.id === 2873 || l.id === 2875);
  if (statue && !pool) break;
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
  } else if (pool) {
   await spec.direct({ type: 'interactLoc', x: pool.x, z: pool.z, locId: pool.id, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // Pray at Zamorak statue (2874) -> click mesbox continues -> pick up cape (2414) off ground
 while (spec.tick() < deadline && countItem(spec.sdk.getInventory(), 2414) === 0) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
   await waitTicks(spec, 1);
   continue;
  }
  await spec.sdk.scanGroundItems(0);
  const groundCape = spec.sdk.getState()?.groundItems?.find((g: any) => g.id === 2414);
  if (groundCape) {
   await spec.direct({ type: 'pickupItem', x: groundCape.x, z: groundCape.z, itemId: 2414, reason: 'SDK' });
  } else {
   const statue = findLocBy(spec, l => l.id === 2874);
   if (statue) await spec.direct({ type: 'interactLoc', x: statue.x, z: statue.z, locId: statue.id, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }

 // Talk Chamber guardian (904) -> receive staff (2417, sets %magearena = 8)
 while (spec.tick() < deadline && countItem(spec.sdk.getInventory(), 2417) === 0) {
  const d = spec.sdk.getDialog();
  if (d?.isOpen) {
   if (!d.isWaiting) await spec.direct({ type: 'clickDialogOption', optionIndex: d.options[0]?.index ?? 0, reason: 'SDK' });
  } else {
   const guardian = findNpcBy(spec, n => n.id === 904 || /guardian/i.test(n.name));
   if (guardian) await spec.direct({ type: 'interactNpc', npcIndex: guardian.index, optionIndex: 1, reason: 'SDK' });
  }
  await waitTicks(spec, 1);
 }
 if (spec.sdk.getState()?.dialog?.isOpen) {
  await spec.direct({ type: 'closeModal', reason: 'SDK' });
  await waitTicks(spec, 1);
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
  await skipTutorialFast(spec, deadline);
  await dropItemsFast(spec, new Set(), deadline);

  const keep = magicKeepSet();
  for (let i = 0; i < MAGIC_BATCHES.length; i++) {
   const batch = MAGIC_BATCHES[i]!;
   const helper = helpers[i]!;
   if (i === MAGIC_BATCHES.length - 1) {
    // Shed mind/cosmic/water/earth/finished rings before Mage Arena combat kit; preserve any spare sharks.
    await dropItemsFast(spec, new Set([ITEM_IDS.airrune, ITEM_IDS.firerune, ITEM_IDS.lawrune, ITEM_IDS.bloodrune, ITEM_IDS.shark]), deadline);
   } else if (i === 1) {
    // Shed leftover mind runes and Batch 0 shark so 7 rune stacks + 21 emerald rings fit cleanly inside 28 slots.
    await dropItemsFast(
     spec,
     new Set([
      ITEM_IDS.cosmicrune,
      ITEM_IDS.waterrune,
      ITEM_IDS.airrune,
      ITEM_IDS.earthrune,
      ITEM_IDS.firerune,
      ITEM_IDS.lawrune,
      ITEM_IDS.bloodrune,
      ITEM_IDS.ring_of_recoil,
      ITEM_IDS.ring_of_dueling_8,
     ]),
     deadline,
    );
   } else if (i > 0 && batch.returnIds.length === 0) {
    await dropItemsFast(spec, keep, deadline);
   }
   await burstTradeHost(spec, helper, {
    giveIds: batch.give.map(g => g.id),
    returnIds: batch.returnIds,
    deadlineTick: deadline,
   });
   if (i === 0) {
    const staff = spec.sdk.getInventory().find(x => x.id === ITEM_IDS.staff_of_fire);
    if (staff) await spec.bot.equipItem(staff);
    await castWindStrikeToLevel7(spec, deadline);
   }
   if (i < MAGIC_BATCHES.length - 1) {
    await enchantHeldRings(spec, target, deadline);
   }
  }

  await dropItemsFast(
   spec,
   new Set([ITEM_IDS.airrune, ITEM_IDS.firerune, ITEM_IDS.lawrune, ITEM_IDS.bloodrune, ITEM_IDS.knife, ITEM_IDS.dragon_bones, ITEM_IDS.prayer_potion_4, ITEM_IDS.shark]),
   deadline,
  );
  await buryBones(spec, deadline);
  logPhase(spec, start, `magic_pre_arena lvl=${skillLevel(spec, 'Magic')} pray=${skillLevel(spec, 'Prayer')}`);

  if (skillLevel(spec, 'Magic') < 80) throw Error(`magic < 80 (${skillLevel(spec, 'Magic')}) before Mage Arena`);
  await completeMageArena(spec, start, deadline);
  await spamChargeTo99(spec, target, deadline);

  const level = skillLevel(spec, 'Magic');
  const xp = skillXp(spec, 'Magic');
  const ok = level >= target && xp >= (target === 99 ? goalXp() : 0);
  const ticks = spec.tick() - start;
  return {
   ok,
   detail: `skill=magic level=${level} xp=${xp} ticks=${ticks} at=${playerPos(spec)?.worldX},${playerPos(spec)?.worldZ}`,
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
  cap: 1300,
  target: 99,
  defaultHelpers: MAGIC_BATCHES.length,
 });
 await withSpecialistFleet(cfg.account, cfg.helpers, (spec, helpers) =>
  runMagicSpecialist(spec, helpers, { cap: cfg.cap, target: cfg.target }),
 );
}
