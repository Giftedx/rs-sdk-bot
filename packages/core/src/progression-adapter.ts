import type {Step} from './chain-step';

export type Truth=true|false|null;
export type Requirement={fact:string}|{ref:string}|{all:Requirement[]}|{any:Requirement[]};

export type WorkIntent =
 | {kind:'train';skill:string;targetLevel:number}
 | {kind:'train-all';targets:Record<string,number>}
 | {kind:'produce';items:Record<number,number>;consumer:string}
 | {kind:'acquire';items:Record<number,number>;consumer:string}
 | {kind:'quest';quest:string}
 | {kind:'pvp'|'observe'|'service';objective:string;units?:number};

export interface Observation<T>{at:number;value:T;source?:string;generation?:number}

export interface ObservedAccount{
 account:string;at:number;server?:string;role?:string;source?:string;
 skills:Record<string,{level:number;xp:number}>;
 inventory:Observation<Record<number,number>>|null;equipment:Observation<Record<number,number>>|null;bank:Observation<Record<number,number>>|null;
 quests:Observation<Record<string,Truth>>|null;position?:Observation<{x:number;z:number;level:number}>|null;currentHP?:number;
 reservations?:Record<number,number>;facts?:Record<string,Truth>;
 build?:{maxLevels?:Record<string,number>};clock?:{protected:boolean;fresh:boolean;authorized:boolean};
}

export interface StateBand{levels?:Record<string,{min?:number;max?:number}>;gainXp?:Record<string,number>;kit?:number[];items?:Record<number,number>;quests?:string[];server?:string;loadout?:number[];maxCrowding?:number}
export interface ConditionalMeasuredSample{xp?:Record<string,number>;units:number;ticks:number;elapsedMs?:number;evidence:string;source:string;conditions:StateBand;setupTicks?:number}

export interface ProgressionMethod{
 id:string;step:Step;source:string;
 effects:{xp?:Record<string,number>;items?:Record<number,number>;quests?:string[];outcome?:string};
 inputs?:Record<number,number>;requirements?:{levels?:Record<string,number>;quests?:string[];items?:Record<number,number>;facts?:Requirement};
 rate:{unitsPerTick:number|null;basis:'measured'|'model'|'unknown';evidence:string;conditions?:StateBand;samples?:ConditionalMeasuredSample[]};
 costs:{setupTicks:number|null;travelTicks:number|null;acquisitionTicks:number|null;unlockTicks:number|null;resupply?:{everyUnits:number;ticks:number|null};measured?:{source:string;evidence:string;conditions?:StateBand}};
 repeatable?:boolean;maxUnits?:number;qualification?:{source:string;bands:StateBand[]};
}

export interface ProgressionAdmission{method:string;source:string;intent:WorkIntent;account:ObservedAccount}
export interface SelectionContext{now:number;maxAgeMs?:number;currentMethod?:string;continuing?:boolean;admitted?:ProgressionAdmission;maxSearchNodes?:number;maxDepth?:number;requireQualification?:boolean;crowding?:number;requirementGraph?:Record<string,Requirement>}
export interface ProgressionPathStep{method:string;step:Step;units:number;ticks:number;inputs:Record<number,number>}
export interface ProgressionAlternative{method:string;state:'ready'|'observe'|'acquire'|'qualify'|'measure'|'blocked';ticks:number|null;reason:string[]}

export interface ProgressionDecision{
 state:'execute'|'observe'|'acquire'|'qualify'|'measure'|'complete'|'blocked';selected:string|null;step:Step|null;
 path:ProgressionPathStep[];expectedTicks:number|null;basis:'measured'|'model'|'unknown';
 alternatives:ProgressionAlternative[];followUps:{method:string;state:ProgressionAlternative['state'];reason:string[]}[];
 stateFingerprint:string;reason:string;gaps:string[];search:{nodes:number;bound:number;depth:number;exhausted:boolean};
}

export type CatalogIntent=WorkIntent['kind'];
export interface CatalogRoute{id:string;category:string;name:string;script:string;args:string[];env:Record<string,string>;intents:CatalogIntent[];skills:string[];description:string;discriminator?:{env?:Record<string,string>;args?:Record<number,string>}}
export type CatalogMethod=ProgressionMethod&{routeId:string;ladderIds:string[];sourceEntry?:string;members?:boolean|null;execution?:{bankJob?:Record<string,unknown>;outputPerUnit?:number;targetEnv?:string[];unitEnv?:string[];stockEnv?:string[];targetArg?:number;unitArg?:number;spendPerUnit?:number};maxBatch?:number;modelRates?:{skill:string;perLevel:(number|null)[]}};
export interface CatalogQuest{id:string;name:string;script:string;xp:Record<string,number>;source:string;requirements?:ProgressionMethod['requirements']}
export interface CatalogEntry{script:string;intents:CatalogIntent[];skills:string[];routeIds:string[];practiceOnly?:boolean}
export interface CatalogGap{method:string;action:'build'|'measure'|'inspect'|'acquire';reason:string;consumer:string;source?:string;capability?:string}
export interface ProgressionCatalog{version:1;generatedBy:string;skills:string[];routes:CatalogRoute[];methods:CatalogMethod[];quests:CatalogQuest[];entries:CatalogEntry[];buildLimits?:Record<string,Record<string,number>>;unmapped?:{id:string;skill:string;source:string;workers:string[]}[]}
export interface CatalogAccept{skills?:Record<string,number>;bank?:Record<number,number>;quests?:string[];counters?:Record<string,number>}
export interface CatalogOptions{extraMethods?:readonly ProgressionMethod[];now?:number;maxAgeMs?:number;sources?:Readonly<Record<string,string>>;qualifications?:Readonly<Record<string,NonNullable<ProgressionMethod['qualification']>>>}

export interface PerformanceWindow{units:number;ticks:number;setupTicks:number;serverDrainTicks?:number;source:string;conditions:string}
export interface PerformanceExpectation{unitsPerTick:number|null;minimumTicks:number;minimumFraction:number;sustainedWindows:number;source:string;conditions:string}
export interface PerformanceAssessment{state:'within-range'|'needs-observation'|'replan';observedRate:number|null;expectedRate:number|null;consecutiveSlow:number;reason:string}

/** Core seam implemented by the planner layer so core never imports upward into planner. */
export interface ProgressionAdapter{
 trainingTargets(intent:WorkIntent):Record<string,number>|null;
 intentForEntry(script:string,args?:readonly string[],env?:Readonly<Record<string,string|undefined>>,accept?:CatalogAccept,catalog?:ProgressionCatalog):WorkIntent|null;
 loadProgressionCatalog(base?:string):ProgressionCatalog;
 accountFromStatus(account:string,status:any,now?:number):ObservedAccount;
 progressionMethods(intent:WorkIntent,account:ObservedAccount,catalog?:ProgressionCatalog,options?:CatalogOptions):{methods:ProgressionMethod[];gaps:CatalogGap[]};
 progressionStep(method:ProgressionMethod,units:number,intent:WorkIntent,account:ObservedAccount,catalog?:ProgressionCatalog):Step;
 chooseProgression(intent:WorkIntent,account:ObservedAccount,methods:readonly ProgressionMethod[],context:SelectionContext):ProgressionDecision;
 assessProgressionPerformance(expected:PerformanceExpectation,windows:readonly PerformanceWindow[]):PerformanceAssessment;
 levelForXp(xp:number):number;
}

let registered:ProgressionAdapter|undefined;

/** Registers or clears the active progression adapter for core policy and session enforcement. */
export function registerProgressionAdapter(adapter:ProgressionAdapter|undefined):void{
 registered=adapter;
}

/** Returns the active progression adapter if registered. */
export function getProgressionAdapter():ProgressionAdapter|undefined{
 return registered;
}

/** Returns the injected or registered progression adapter, throwing when none is registered. */
export function requireProgressionAdapter(adapter:ProgressionAdapter|undefined=registered):ProgressionAdapter{
 if(!adapter)throw Error('progression adapter not registered');
 return adapter;
}

/** Runs synchronous or asynchronous work under a temporary progression adapter, restoring the prior adapter. */
export function withProgressionAdapter<T>(adapter:ProgressionAdapter|undefined,fn:()=>T):T{
 const previous=registered;
 registered=adapter;
 try{
  const result=fn();
  if(result&&typeof (result as {then?:unknown}).then==='function'){
   return Promise.resolve(result).finally(()=>{registered=previous;}) as T;
  }
  registered=previous;
  return result;
 }catch(error){
  registered=previous;
  throw error;
 }
}
