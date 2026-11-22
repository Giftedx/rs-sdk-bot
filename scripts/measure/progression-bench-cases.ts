// Define matched Ranged progression practice cases for the existing AIO bench.
import type {BenchCase} from './bench-case-types';
import {loadRangedComparisonEntry,rangedComparisonPreset,rangedComparisonPass} from '../../packages/practice/src/ranged-progression-case';

export const PROGRESSION_BENCH_CASES:BenchCase[]=[...(['chickens','troopers','adaptive'] as const).map(method=>({
 key:`extra:progression-ranged-${method}`,script:'packages/practice/src/ranged-progression-case.ts',preset:'fresh_lumbridge',
 get presetConfig(){return rangedComparisonPreset(loadRangedComparisonEntry().entry);},scriptArgs:[method],pass:rangedComparisonPass,timeoutMs:600000,
 output:/"xpGain":(\d+)/,
})),{
 key:'extra:progression-ranged-adaptive85',script:'packages/practice/src/ranged-progression-case.ts',preset:'fresh_lumbridge',
 get presetConfig(){return rangedComparisonPreset(loadRangedComparisonEntry().entry);},scriptArgs:['adaptive','85'],pass:rangedComparisonPass,timeoutMs:600000,output:/"xpGain":(\d+)/,
}];
