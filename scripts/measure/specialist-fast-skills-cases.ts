// BenchCase definitions for the 6 fresh-clock fast-skill specialist Rank #1 winners.
import type { SaveConfig } from '../../vendor/rs-sdk/sdk/test/utils/save-generator';
import { CRAFTING_BATCHES } from '../crafting-specialist';
import { ITEM_IDS } from '../fast-skills-lib';
import {
 HERBLORE_BANK_HELPER_SPOT,
 HERBLORE_NOTED_BATCH,
 HERBLORE_NOTED_SUPPLIES,
 HERBLORE_STARTER_BATCH,
} from '../herblore-specialist';
import { LUMBRIDGE_SAFE_SPOT, MAGIC_BATCHES } from '../magic-specialist';
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
 ...HERBLORE_NOTED_SUPPLIES.map(s => s.certId),
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
 };
}

export const SPECIALIST_FAST_SKILLS_CASES: readonly BenchCase[] = [
 {
  key: 'skiller:prayer:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['prayer', 'specialist', 'CAP=1350', helperArg(PRAYER_RUNNER_COUNT)],
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
  key: 'skiller:smithing:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['smithing', 'specialist', 'CAP=1350', helperArg(4)],
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
   {
    suffix: 'e',
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
  key: 'skiller:runecraft:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['runecraft', 'specialist', 'CAP=2300', helperArg(1 + BODY_RUNNER_COUNT)],
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
  key: 'skiller:crafting:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['crafting', 'specialist', 'CAP=250', helperArg(CRAFTING_BATCHES.length)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: CRAFTING_BATCHES.map((batch, i) =>
   staticCompanion(i, { x: 3222, z: 3223, level: 0 }, batch.give),
  ),
 },
 {
  key: 'skiller:herblore:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['herblore', 'specialist', 'CAP=600', helperArg(2)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: [
   staticCompanion(0, { x: 3222, z: 3223, level: 0 }, HERBLORE_STARTER_BATCH.give),
   staticCompanion(1, HERBLORE_BANK_HELPER_SPOT, HERBLORE_NOTED_BATCH.give),
  ],
 },
 {
  key: 'skiller:magic:specialist',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: ['magic', 'specialist', 'CAP=1300', helperArg(MAGIC_BATCHES.length)],
  pass: okSpecialist,
  output: /ticks=(\d+)/,
  timeoutMs: 600_000,
  companions: MAGIC_BATCHES.map((batch, i) =>
   staticCompanion(i, i === 0 ? { x: 3222, z: 3223, level: 0 } : LUMBRIDGE_SAFE_SPOT, batch.give),
  ),
 },
];

export const SPECIALIST_FAST_SKILLS_EXTERNAL_CASES: readonly BenchCase[] = [
 {
  key: 'extra:specialist-runecraft',
  script: 'scripts/measure/specialist-bench.ts',
  preset: 'fresh_lumbridge',
  presetConfig: freshTutorialStart(),
  scriptArgs: [
   Array.from({ length: 1 + BODY_RUNNER_COUNT }, (_, i) => `{bot:${SUFFIXES[i]!}}`).join(','),
   'scripts/runecraft-specialist.ts',
   'SUPPLIER_KIT=runecraft',
   'CAP=2300',
  ],
  pass: stdout => {
   const result = stdout.match(/^RESULT ok\b.*$/m)?.[0] ?? '';
   const ticks = Number(/\bticks=(\d+)/.exec(result)?.[1] ?? NaN);
   return !!result && /\blevel=99\b/.test(result) && !/\bRESULT fail\b/.test(stdout) && ticks <= 2207;
  },
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
];

export const RUNECRAFT_RUNNER_SWEEP_CASES: readonly BenchCase[] = [6, 8, 10, 12].map(runners => ({
 key: `extra:runecraft-r${runners}`,
 script: 'scripts/measure/specialist-bench.ts',
 preset: 'fresh_lumbridge',
 presetConfig: freshTutorialStart(),
 scriptArgs: [
  Array.from({ length: 1 + runners }, (_, i) => `{bot:${SUFFIXES[i]!}}`).join(','),
  'scripts/runecraft-specialist.ts',
  'SUPPLIER_KIT=runecraft',
  'CAP=2800',
 ],
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
  ...Array.from({ length: runners }, (_, i) => ({
   suffix: SUFFIXES[1 + i]!,
   preset: 'fresh_lumbridge',
   presetConfig: {
    position: { x: 3050, z: 3442, level: 0 },
    inventory: expandInventory([
     { id: ITEM_IDS.body_talisman, count: 1 },
     { id: ITEM_IDS.blankrune, count: 26 },
    ]),
    bank: [{ id: ITEM_IDS.blankrune, count: 1100 }],
   },
  })),
 ],
}));
