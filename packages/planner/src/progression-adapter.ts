import {registerProgressionAdapter,type ProgressionAdapter} from '../../core/src/progression-adapter';

let loaded:ProgressionAdapter|undefined;
function load():ProgressionAdapter{
 if(!loaded){
  const progression=require('./progression') as typeof import('./progression');
  const catalog=require('./progression-catalog') as typeof import('./progression-catalog');
  const performance=require('./progression-performance') as typeof import('./progression-performance');
  const curve=require('./curve') as typeof import('./curve');
  loaded={
   trainingTargets:progression.trainingTargets,
   intentForEntry:catalog.intentForEntry,
   loadProgressionCatalog:catalog.loadProgressionCatalog,
   accountFromStatus:catalog.accountFromStatus,
   progressionMethods:catalog.progressionMethods,
   progressionStep:catalog.progressionStep,
   chooseProgression:progression.chooseProgression,
   assessProgressionPerformance:performance.assessProgressionPerformance,
   levelForXp:curve.levelForXp,
  };
 }
 return loaded;
}

/** Lazy planner-backed progression adapter registered at preload without eager catalog or gear I/O. */
export const plannerProgressionAdapter:ProgressionAdapter={
 trainingTargets:(...args)=>load().trainingTargets(...args),
 intentForEntry:(...args)=>load().intentForEntry(...args),
 loadProgressionCatalog:(...args)=>load().loadProgressionCatalog(...args),
 accountFromStatus:(...args)=>load().accountFromStatus(...args),
 progressionMethods:(...args)=>load().progressionMethods(...args),
 progressionStep:(...args)=>load().progressionStep(...args),
 chooseProgression:(...args)=>load().chooseProgression(...args),
 assessProgressionPerformance:(...args)=>load().assessProgressionPerformance(...args),
 levelForXp:(...args)=>load().levelForXp(...args),
};

/** Registers the lazy planner adapter on the core progression seam. */
export function registerPlannerProgressionAdapter():ProgressionAdapter{
 registerProgressionAdapter(plannerProgressionAdapter);
 return plannerProgressionAdapter;
}

registerPlannerProgressionAdapter();
