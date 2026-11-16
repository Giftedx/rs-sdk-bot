// Define matched Ranged progression practice cases for the existing AIO bench.
import type {BenchCase} from './aio-bench-cases';
import {RANGED_COMPARISON_PRESET,rangedComparisonPass} from '../../packages/practice/src/ranged-progression-case';

export const PROGRESSION_BENCH_CASES:BenchCase[]=[...(['chickens','troopers','adaptive'] as const).map(method=>({
 key:`extra:progression-ranged-${method}`,script:'packages/practice/src/ranged-progression-case.ts',preset:'fresh_lumbridge',
 presetConfig:RANGED_COMPARISON_PRESET,scriptArgs:[method],pass:rangedComparisonPass,timeoutMs:600000,
 output:/"xpGain":(\d+)/,
})),{
 key:'extra:progression-ranged-adaptive85',script:'packages/practice/src/ranged-progression-case.ts',preset:'fresh_lumbridge',
 presetConfig:RANGED_COMPARISON_PRESET,scriptArgs:['adaptive','85'],pass:rangedComparisonPass,timeoutMs:600000,output:/"xpGain":(\d+)/,
}];
