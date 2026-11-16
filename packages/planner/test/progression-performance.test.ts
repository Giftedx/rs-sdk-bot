import {expect,test} from 'bun:test';
import {assessProgressionPerformance,summarizeMeasuredSamples,type PerformanceWindow} from '../src/progression-performance';
const expected={unitsPerTick:10,minimumTicks:100,minimumFraction:.7,sustainedWindows:2,source:'s',conditions:'bow-target'};
const window=(units:number,over:Partial<PerformanceWindow>={}):PerformanceWindow=>({units,ticks:100,setupTicks:0,source:'s',conditions:'bow-target',...over});
test('setup and server drain ticks do not manufacture a slowdown',()=>{
 expect(assessProgressionPerformance(expected,[window(1000,{ticks:300,setupTicks:100,serverDrainTicks:100})]).state).toBe('within-range');
});
test('short and mismatched observations remain unknown',()=>{
 for(const w of [window(1,{ticks:20}),window(1,{source:'other'}),window(1,{conditions:'other'})])expect(assessProgressionPerformance(expected,[w]).state).toBe('needs-observation');
});
test('only sustained matched slow windows request replanning',()=>{
 expect(assessProgressionPerformance(expected,[window(100)]).state).toBe('needs-observation');
 expect(assessProgressionPerformance(expected,[window(100),window(100)]).state).toBe('replan');
 expect(assessProgressionPerformance(expected,[window(100),window(1000),window(100)]).state).toBe('needs-observation');
});
test('unknown expected speed is not a passing or failing speed claim',()=>{
 expect(assessProgressionPerformance({...expected,unitsPerTick:null},[window(100)]).state).toBe('needs-observation');
});
test('measured sample summary retains matched evidence and excludes changed source',()=>{
 const samples=[{units:100,ticks:10,evidence:'raw-a',source:'s',conditions:{}},{units:300,ticks:10,evidence:'raw-b',source:'s',conditions:{}},{units:999,ticks:1,evidence:'other',source:'old',conditions:{}}];
 expect(summarizeMeasuredSamples(samples,'s')).toEqual({unitsPerTick:20,runs:2,evidence:['raw-a','raw-b']});
});
test('a measured aggregate does not mix different loadouts into one rate',()=>{
 const samples=[{units:100,ticks:10,evidence:'bronze',source:'s',conditions:{loadout:[841]}},{units:1000,ticks:10,evidence:'magic',source:'s',conditions:{loadout:[861]}}];
 expect(summarizeMeasuredSamples(samples,'s')).toEqual({unitsPerTick:10,runs:1,evidence:['bronze']});
});
test('an invalid numeric expectation remains explicitly unknown',()=>{
 expect(assessProgressionPerformance({...expected,unitsPerTick:NaN},[window(100)]).expectedRate).toBeNull();
});
