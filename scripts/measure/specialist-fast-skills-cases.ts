// BenchCase definitions for the 6 fresh-clock fast-skill specialists (Crafting, Herblore, Prayer, Smithing, Runecraft, Magic).
import type { SaveConfig } from '../../vendor/rs-sdk/sdk/test/utils/save-generator';
import { ITEM_IDS } from '../fast-skills-lib';
import { CRAFTING_BATCHES } from '../crafting-specialist';
import { HERBLORE_ALL_BATCHES, HERBLORE_BATCHES, HERBLORE_STARTER_BATCH, KAQEMEEX_SPOT } from '../herblore-specialist';
import { MAGIC_BATCHES } from '../magic-specialist';
import { PRAYER_RUNNER_COUNT } from '../prayer-specialist';
import { BODY_RUNNER_COUNT } from '../runecraft-specialist';
import type { BenchCase } from './aio-bench-cases';

const SUFFIXES = 'bcdefghijklmnopqrstuvwxyz0123456789';

const STACKABLE_IDS = new Set<number>([
 ITEM_IDS.airrune,
 ITEM_IDS.waterrune,
 ITEM_IDS.earthrune,
 ITEM_IDS.firerune,
 ITEM_IDS.mindrune,
 ITEM_IDS.cosmicrune,
 ITEM_IDS.lawrune,
 ITEM_IDS.bloodrune,
 ITEM_IDS.bodyrune,
 995,
]);

export function expandInventory(items: readonly { id: number; count: number }[]): { id: number; count: number }[] {
 const out: { id: number; count: number }[] = [];
 for (const row of items) {
  if (STACKABLE_IDS.has(row.id)) {
   out.push({ id: row.id, count: row.count });
  } else {
   for (let i = 0; i < row.count; i++) out.push({ id: row.id, count: 1 });
  }
 }
 if (out.length > 28) throw Error(`companion inventory exceeds 28 slots (${out.length})`);
 return out;
}

export function freshTutorialStart(): SaveConfig {
 return { position: { x: 3094, z: 3106, level: 0 }, varps: { 281: 0 } };
}

function helperArg(count: number): string {
 return 'HELPERS=' + Array.from({ length: count }, (_, i) => `{bot:${SUFFIXES[i]!}}`).join(',');
}

const okSpecialist = (stdout: string) =>
 /\bRESULT ok\b/.test(stdout) && /\blevel=99\b/.test(stdout) && !/\bRESULT fail\b/.test(stdout);

function staticCompanion(
 index: number,
 pos: { x: number; z: number; level: number },
 items: readonly { id: number; count: number }[],
): { suffix: string; preset: string; presetConfig: SaveConfig } {
 return {
  suffix: SUFFIXES[index]!,
  preset: 'fresh_lumbridge',
  presetConfig: {
   position: pos,
   inventory: expandInventory(items),
  },
 }
}

export const SPECIALIST_FAST_SKILLS_CASES: readonly BenchCase[] = [
 {
  key: 'extra:specialist-crafting',
  script: 'scripts/crafting-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=250', helperArg(CRAFTING_BATCHES.length)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: CRAFTING_BATCHES.map((b, i) => staticCompanion(i, { x: 3222, z: 3223, level: 0 }, b.give)),
 },
 {
  key: 'extra:specialist-herblore',
  script: 'scripts/herblore-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=460', helperArg(HERBLORE_ALL_BATCHES.length)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: [
   staticCompanion(0, { x: 3222, z: 3223, level: 0 }, HERBLORE_STARTER_BATCH.give),
   ...HERBLORE_BATCHES.map((b, i) => staticCompanion(1 + i, KAQEMEEX_SPOT, b.give)),
  ],
 },
 {
  key: 'extra:specialist-prayer',
  script: 'scripts/prayer-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=1350', helperArg(PRAYER_RUNNER_COUNT)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: Array.from({ length: PRAYER_RUNNER_COUNT }, (_, i) => ({
   suffix: SUFFIXES[i]!,
   preset: 'fresh_lumbridge',
   presetConfig: {
    position: { x: 3222, z: 3223, level: 0 },
    inventory: expandInventory([{ id: ITEM_IDS.dragon_bones, count: 28 }]),
    bank: [{ id: ITEM_IDS.dragon_bones, count: 250 }],
   },
  })),
 },
 {
  key: 'extra:specialist-smithing',
  script: 'scripts/smithing-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=1350', helperArg(3)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: [
   staticCompanion(0, { x: 3222, z: 3223, level: 0 }, [
    { id: ITEM_IDS.hammer, count: 1 },
    { id: ITEM_IDS.amulet_of_glory_4, count: 1 },
    { id: ITEM_IDS.bronze_bar, count: 9 },
    { id: ITEM_IDS.iron_bar, count: 17 },
   ]),
   {
    suffix: 'c',
    preset: 'fresh_lumbridge',
    presetConfig: {
     position: { x: 3185, z: 3436, level: 0 },
     inventory: expandInventory([{ id: ITEM_IDS.iron_bar, count: 25 }]),
     bank: [
      { id: ITEM_IDS.iron_bar, count: 25 },
      { id: ITEM_IDS.steel_bar, count: 100 },
      { id: ITEM_IDS.mithril_bar, count: 275 },
      { id: ITEM_IDS.adamantite_bar, count: 400 },
     ],
    },
   },
   {
    suffix: 'd',
    preset: 'fresh_lumbridge',
    presetConfig: {
     position: { x: 3185, z: 3436, level: 0 },
     inventory: expandInventory([{ id: ITEM_IDS.steel_bar, count: 25 }]),
     bank: [
      { id: ITEM_IDS.iron_bar, count: 25 },
      { id: ITEM_IDS.steel_bar, count: 100 },
      { id: ITEM_IDS.mithril_bar, count: 275 },
      { id: ITEM_IDS.adamantite_bar, count: 400 },
     ],
    },
   },
  ],
 },
 {
  key: 'extra:specialist-runecraft',
  script: 'scripts/runecraft-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=2300', helperArg(1 + BODY_RUNNER_COUNT)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: [
   staticCompanion(0, { x: 3222, z: 3223, level: 0 }, [
    { id: ITEM_IDS.amulet_of_glory_4, count: 1 },
    { id: ITEM_IDS.air_talisman, count: 1 },
    { id: ITEM_IDS.body_talisman, count: 1 },
    { id: ITEM_IDS.blankrune, count: 25 },
   ]),
   ...Array.from({ length: BODY_RUNNER_COUNT }, (_, i) => ({
    suffix: SUFFIXES[1 + i]!,
    preset: 'fresh_lumbridge',
    presetConfig: {
     position: { x: 3050, z: 3442, level: 0 },
     inventory: expandInventory([
      { id: ITEM_IDS.body_talisman, count: 1 },
      { id: ITEM_IDS.blankrune, count: 26 },
     ]),
     bank: [{ id: ITEM_IDS.blankrune, count: 500 }],
    },
   })),
  ],
 },
 {
  key: 'extra:specialist-magic',
  script: 'scripts/magic-specialist.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['CAP=1300', helperArg(MAGIC_BATCHES.length)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: MAGIC_BATCHES.map((b, i) => staticCompanion(i, { x: 3222, z: 3223, level: 0 }, b.give)),
 },
];
