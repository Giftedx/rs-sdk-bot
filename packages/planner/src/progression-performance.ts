import type {ConditionalMeasuredSample,PerformanceAssessment,PerformanceExpectation,PerformanceWindow,StateBand} from '../../core/src/progression-adapter';
export type {PerformanceAssessment,PerformanceExpectation,PerformanceWindow};
export function assessProgressionPerformance(expected:PerformanceExpectation,windows:readonly PerformanceWindow[]):PerformanceAssessment{
 const result:PerformanceAssessment={state:'needs-observation',observedRate:null,expectedRate:typeof expected.unitsPerTick==='number'&&Number.isFinite(expected.unitsPerTick)&&expected.unitsPerTick>0?expected.unitsPerTick:null,consecutiveSlow:0,reason:'A matched useful-work window is required.'};
 if(!Number.isFinite(expected.unitsPerTick)||expected.unitsPerTick===null||expected.unitsPerTick<=0||!Number.isSafeInteger(expected.minimumTicks)||expected.minimumTicks<1||!Number.isSafeInteger(expected.sustainedWindows)||expected.sustainedWindows<1||!(expected.minimumFraction>0&&expected.minimumFraction<=1))return {...result,reason:'Expected rate or comparison bounds are unknown or invalid.'};
 for(const window of windows){
  const productive=window.ticks-window.setupTicks-(window.serverDrainTicks??0);
  const matched=window.source===expected.source&&window.conditions===expected.conditions&&[window.units,window.ticks,window.setupTicks,window.serverDrainTicks??0].every(n=>Number.isFinite(n)&&n>=0)&&productive>=expected.minimumTicks;
  if(!matched){result.consecutiveSlow=0;result.observedRate=null;result.state='needs-observation';continue;}
  result.observedRate=window.units/productive;
  if(result.observedRate>=expected.unitsPerTick*expected.minimumFraction){result.consecutiveSlow=0;result.state='within-range';result.reason='Matched useful-work rate is within the expected range.';}
  else{result.consecutiveSlow++;result.state=result.consecutiveSlow>=expected.sustainedWindows?'replan':'needs-observation';result.reason=result.state==='replan'?'Sustained matched useful-work slowdown needs a new route comparison.':'One slow window needs confirmation.';}
 }
 return result;
}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
/** One condition group only. Omit conditions to summarize the first valid group's retained samples. */
export function summarizeMeasuredSamples(samples:readonly ConditionalMeasuredSample[],source:string,conditions?:StateBand):{unitsPerTick:number|null;runs:number;evidence:string[]}{
 const matched=samples.filter(s=>s.source===source&&s.evidence.trim()&&Number.isFinite(s.units)&&s.units>0&&Number.isFinite(s.ticks)&&s.ticks>0&&Number.isFinite(s.setupTicks??0)&&(s.setupTicks??0)>=0&&s.ticks>(s.setupTicks??0));
 const group=JSON.stringify(canonical(conditions??matched[0]?.conditions));
 const valid=matched.filter(s=>JSON.stringify(canonical(s.conditions))===group);
 if(!valid.length)return {unitsPerTick:null,runs:0,evidence:[]};
 const rates=valid.map(s=>s.units/(s.ticks-(s.setupTicks??0))).sort((a,b)=>a-b),mid=Math.floor(rates.length/2);
 return {unitsPerTick:rates.length%2?rates[mid]!:(rates[mid-1]!+rates[mid]!)/2,runs:valid.length,evidence:valid.map(s=>s.evidence)};
}
