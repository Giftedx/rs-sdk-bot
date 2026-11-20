// Unit tests covering supply catalog compatibility, observedSupplies checks, XP headroom, and bench cases for all 6 specialists.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { xpForLevel, levelForXp } from '../packages/planner/src/curve';
import { intentForEntry } from '../packages/planner/src/progression-catalog';
import { observedSupplies } from '../packages/practice/src/specialist-rehearsal';
import { resolveSkillerStep } from './aio-skiller';
import { CRAFTING_BATCHES, CRAFTING_SUPPLY_BILL } from './crafting-specialist';
import { assertCatalogItems, loadItemCatalog, parseSpecialistArgs } from './fast-skills-lib';
import { HERB_POTION_TIERS, HERBLORE_ALL_BATCHES, HERBLORE_BATCHES, HERBLORE_SUPPLY_BILL } from './herblore-specialist';
import { ENCHANT_TIERS, MAGIC_BATCHES, MAGIC_SUPPLY_BILL } from './magic-specialist';
import { benchCases } from './measure/aio-bench-cases';
import { SPECIALIST_FAST_SKILLS_CASES, expandInventory } from './measure/specialist-fast-skills-cases';
import { PRAYER_BONES_NEEDED, PRAYER_SUPPLY_BILL } from './prayer-specialist';
import { RUNECRAFT_SUPPLY_BILL } from './runecraft-specialist';
import { SMITHING_RUNNER_QUEUE, SMITHING_SUPPLY_BILL } from './smithing-specialist';

const ALL_BILLS = [
 ['crafting', CRAFTING_SUPPLY_BILL],
 ['herblore', HERBLORE_SUPPLY_BILL],
 ['prayer', PRAYER_SUPPLY_BILL],
 ['smithing', SMITHING_SUPPLY_BILL],
 ['runecraft', RUNECRAFT_SUPPLY_BILL],
 ['magic', MAGIC_SUPPLY_BILL],
] as const;

describe('fast-skills specialist supply bills and observedSupplies compatibility', () => {
 test('all 6 supply bills reference only cataloged tradeable base item IDs in knowledge/items.json', () => {
  const catalog = loadItemCatalog();
  for (const [skill, bill] of ALL_BILLS) {
   expect(() => assertCatalogItems(bill)).not.toThrow();
   for (const entry of bill) {
    const row = catalog.get(entry.itemId);
    expect(row, `${skill}:${entry.item}`).toBeDefined();
    expect(row!.tradeable).toBe(true);
    expect(entry.count).toBeGreaterThan(0);
   }
  }
 });

 test('observedSupplies accepts simulated unnoted trades for every specialist bill', () => {
  const rawCatalog = JSON.parse(readFileSync(resolve(import.meta.dir, '../knowledge/items.json'), 'utf8')) as { id: number; name: string }[];
  for (const [skill, bill] of ALL_BILLS) {
   const logText =
    bill
     .map((entry, idx) =>
      JSON.stringify({
       tick: idx + 1,
       from: `${skill}b`,
       to: skill,
       fromItems: [{ id: entry.itemId, name: entry.item, count: entry.count }],
       toItems: [],
      }),
     )
     .join('\n') + '\n';
   const observed = observedSupplies(logText, skill, rawCatalog);
   expect(observed.length).toBe(bill.length);
   for (const entry of bill) {
    expect(observed.find(o => o.itemId === entry.itemId)?.count).toBe(entry.count);
   }
  }
 });
});

describe('fast-skills specialist plans reach level 99 with valid inventory fits', () => {
 test('Crafting batches fit 28 slots and clear 99 Crafting XP cleanly', () => {
  for (const batch of CRAFTING_BATCHES) {
   expect(expandInventory(batch.give).length).toBeLessThanOrEqual(28);
  }
  const xp99 = xpForLevel(99);
  const worstOpals = 3 * 375 + 24 * 93.75;
  expect(levelForXp(worstOpals)).toBeGreaterThanOrEqual(20);
  const xpFromGems = worstOpals + 6 * 1250 + 5 * 1687.5 + 6 * 2125 + 10 * 2687.5;
  expect(levelForXp(xpFromGems)).toBeGreaterThanOrEqual(55);
  expect(xpFromGems + 290 * 3437.5).toBeGreaterThan(xp99);
 });

 test('Herblore starter + 18 Kaqemeex batches unlock sequentially from Druidic Ritual (6,250 XP) to 99', () => {
  for (const b of HERBLORE_ALL_BATCHES) expect(expandInventory(b.give).length).toBeLessThanOrEqual(28);

  let xp = 6250; // Druidic Ritual reward (Lv 26)
  for (const b of HERBLORE_BATCHES) {
   const counts = new Map<number, number>();
   for (const g of b.give) counts.set(g.id, (counts.get(g.id) ?? 0) + g.count);
   while (true) {
    const lvl = levelForXp(xp);
    const tier = [...HERB_POTION_TIERS].reverse().find(t => lvl >= t.level && (counts.get(t.unf) ?? 0) > 0 && (counts.get(t.sec) ?? 0) > 0);
    if (!tier) break;
    counts.set(tier.unf, counts.get(tier.unf)! - 1);
    counts.set(tier.sec, counts.get(tier.sec)! - 1);
    xp += tier.xp;
   }
   for (const left of counts.values()) expect(left).toBe(0);
  }
  expect(xp).toBeGreaterThanOrEqual(xpForLevel(99));
  expect(levelForXp(xp)).toBe(99);
 });

 test('Prayer dragon bones cover 99 Prayer', () => {
  expect(PRAYER_BONES_NEEDED * 1800).toBeGreaterThanOrEqual(xpForLevel(99));
 });

 test('Smithing starter + 31 Varrock runner bar deliveries exceed 99 Smithing', () => {
  const xpAfterStarter = 9 * 312.5 + 17 * 625;
  expect(levelForXp(xpAfterStarter)).toBeGreaterThanOrEqual(33);
  const xpPerBar: Record<number, number> = { 2351: 625, 2353: 937.5, 2359: 1250, 2361: 1562.5 };
  let xp = xpAfterStarter;
  for (const delivery of SMITHING_RUNNER_QUEUE) {
   expect(delivery.count).toBeLessThanOrEqual(25);
   xp += delivery.count * xpPerBar[delivery.barId]!;
  }
  expect(xp).toBeGreaterThanOrEqual(xpForLevel(99));
 });

 test('Runecraft Air starter + 205 Body altar trips exceed 99 Runecraft', () => {
  const xpAfterAir = 25 * 125;
  expect(levelForXp(xpAfterAir)).toBeGreaterThanOrEqual(20);
  expect(xpAfterAir + 205 * 26 * 187.5).toBeGreaterThanOrEqual(xpForLevel(99));
 });

 test('Magic batches fit 28 slots and enchant ladder reaches >= 80 before Mage Arena + Charge', () => {
  for (const b of MAGIC_BATCHES) expect(expandInventory(b.give).length).toBeLessThanOrEqual(28);
  let xp = 600; // Wind Strike to level 7
  for (let i = 0; i < MAGIC_BATCHES.length - 1; i++) {
   for (const g of MAGIC_BATCHES[i]!.give) {
    const tier = ENCHANT_TIERS.find(t => t.ringId === g.id);
    if (!tier) continue;
    expect(levelForXp(xp)).toBeGreaterThanOrEqual(tier.level);
    xp += g.count * tier.xp;
   }
  }
  expect(levelForXp(xp)).toBeGreaterThanOrEqual(80);
  expect(xp).toBeGreaterThanOrEqual(xpForLevel(80));
 });
});

describe('fast-skills bench cases, catalog routes, and CLI parsing', () => {
 test('all 6 bench cases are registered with fresh Tutorial Island config and strict predicates', () => {
  const all = benchCases();
  const keys = [
   'extra:specialist-crafting',
   'extra:specialist-herblore',
   'extra:specialist-prayer',
   'extra:specialist-smithing',
   'extra:specialist-runecraft',
   'extra:specialist-magic',
  ];
  expect(SPECIALIST_FAST_SKILLS_CASES.map(c => c.key)).toEqual(keys);
  for (const key of keys) {
   const found = all.find(c => c.key === key);
   expect(found).toBeDefined();
   expect(found!.presetConfig?.position).toEqual({ x: 3094, z: 3106, level: 0 });
   expect(found!.presetConfig?.varps).toEqual({ 281: 0 });
   const helpersArg = found!.scriptArgs.find(a => a.startsWith('HELPERS='))!;
   expect(helpersArg.slice(8).split(',').length).toBe(found!.companions!.length);
   expect(found!.pass('skill=test level=99 ticks=100\nRESULT ok done')).toBe(true);
   expect(found!.pass('skill=test level=98 ticks=100\nRESULT ok done')).toBe(false);
   expect(found!.pass('skill=test level=99 ticks=100\nRESULT fail nope')).toBe(false);
  }
 });

 test('skiller routes, progression intents, and specialist arg parsing resolve cleanly', () => {
  for (const skill of ['crafting', 'herblore', 'prayer', 'smithing', 'runecraft', 'magic']) {
   const step = resolveSkillerStep(skill, 'specialist', ['CAP=1500']);
   expect(step.script).toBe(`scripts/${skill}-specialist.ts`);
   expect(intentForEntry(step.script, [], { CAP: '500' })).toEqual({
    kind: 'service',
    objective: `specialist:${skill}:99`,
    units: 1,
   });
   expect(intentForEntry(step.script, [], { CAP: '0' })).toBeNull();
  }
  const parsed = parseSpecialistArgs(['TestBot', 'CAP=300', 'HELPERS=TestBotb,TestBotc']);
  expect(parsed).toMatchObject({ account: 'TestBot', cap: 300, target: 99, helpers: ['TestBotb', 'TestBotc'] });
 });
});
