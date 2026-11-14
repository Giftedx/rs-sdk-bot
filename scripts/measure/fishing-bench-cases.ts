// Fishing bench cases of the knife reset (scripts/microbot-b-fishing.ts FISH_KNIFE_RESET). aio-practice-bench.ts runs
// them after the cases of aio-bench-cases.ts.
import type {BenchCase} from './aio-bench-cases';

const ok = (s: string) => /^RESULT ok\b/m.test(s);

// Fly fishing at the Lumbridge river, the record route's Fishing 78-99 step (packages/planner/src/cairn-route.json
// fly-fish). C = vendor/rs-sdk/server/content. The spot 0_50_50_freshfish (npc 329, C/pack/npc.pack:330) spawns twice
// at 3238,3252 (C/maps/m50_50.jm2:9703-9704) and moves among the 8 tiles of fishing_movement_lumbridge_river_enum
// (C/scripts/skill_fishing/configs/fishing_movement.enum:279-289) every 280 to 529 ticks
// (C/scripts/skill_fishing/scripts/fishing_movement.rs2:10-12): 3239,3241-3244 and 3238,3251-3255. The account starts
// on the bank at 3240,3247, 8 tiles or less from each of them, at Fishing 78 with a fly fishing rod, feathers, a knife
// and a log. `plain` is the default staged batch (the hidden-op loop; 20 trout and salmon stay in the pack). At seed 8
// it ends "no compatible native spot": the spot moves to 3239,3242 after the walk to 3239,3252, 10 tiles off, past the
// default radius of 8. `knife` is the knife reset (radius 15) with one catch dropped in each cycle, to 60 catches.
// FISH_RATE prints the ticks for each catch and the XP for each tick from the first catch to the last.
const lumbridgeFly = (mode: 'plain' | 'knife'): BenchCase => ({
  key: `extra:fishing-lumbridge-fly-${mode}`,
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  scriptArgs: ['fishing', 'staged', 'fly', mode === 'plain' ? '20' : '60', '1500', ...(mode === 'knife' ? ['FISH_KNIFE=1', 'FISH_DROP=1'] : [])],
  pass: ok,
  output: /"caught":(\d+)/,
  presetConfig: {position: {x: 3240, z: 3247, level: 0}, skills: {Fishing: 78, Attack: 20, Strength: 20, Defence: 20, Hitpoints: 30},
    inventory: [{id: 309, count: 1}, {id: 314, count: 200}, {id: 946, count: 1}, {id: 1511, count: 1}]},
});

// Lobster cages at Catherby, the 'delayed' reset (knife in T, close or drop in T+1, click in T+2), from the start of
// the same-job fish cases (aio-bench-cases.ts SAME_FISH, Fishing 70) with a knife and a log, one lobster dropped in each
// cycle, to 30. The default staged batch has no case here: from this start it ended "no compatible native spot" at
// seeds 8 and 9 (radius 8 after a spot move).
const catherbyCageKnife: BenchCase = {
  key: 'extra:fishing-catherby-cage-knife',
  script: 'scripts/aio-skiller.ts',
  preset: 'fresh_lumbridge',
  scriptArgs: ['fishing', 'staged', 'cage', '30', '1500', 'FISH_KNIFE=1', 'FISH_DROP=1'],
  pass: ok,
  output: /"caught":(\d+)/,
  presetConfig: {position: {x: 2840, z: 3432, level: 0}, skills: {Fishing: 70}, inventory: [{id: 301, count: 1}, {id: 946, count: 1}, {id: 1511, count: 1}]},
};

export const FISHING_BENCH_CASES: BenchCase[] = [lumbridgeFly('plain'), lumbridgeFly('knife'), catherbyCageKnife];
