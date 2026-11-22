import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {CoordinatorState} from '../coordinator';
import {runModel,type ModelWorker,type ModelRunOptions} from '../model-worker';
import {projectRoot,coordinationDir,atomicJson,capabilitySource} from '../coordinator-store';
import {deliveryConflictRoots} from '../delivery-pr';
import {heldRuns} from '../coordinator-decisions';
import {parseModelObject} from './brief';
import {readWorld} from './world';
import {plannerPrompt} from './prompt';

export interface SubscriptionModelDeps{run?:typeof runModel;now?:()=>number}

export async function runSubscriptionModel(agent:ModelWorker,prompt:string,timeoutMs:number,{run=runModel,now=Date.now,purpose}:SubscriptionModelDeps&ModelRunOptions={}){
 // Only planning reserves time for a stalled primary; reviews keep their full primary deadline and effort.
 const start=now(),options:ModelRunOptions=purpose?{purpose}:{},primaryMs=purpose==='planner'?Math.max(1,Math.floor(timeoutMs/2)):timeoutMs;
 const first=await run(agent,prompt,primaryMs,true,options),attempts=[{agent,...first}];
 const limited=/\b(?:you['’]ve hit your (?:weekly|daily|monthly|usage) limit|usage limit reached)\b/i.test(first.text);
 if(!first.ok&&(limited||purpose==='planner'&&/\bmodel deadline exceeded\b/i.test(first.text))){
  const remaining=timeoutMs-(now()-start);
  if(remaining>0){
   const fallback:ModelWorker=agent==='claude'?'codex':'claude';let result:Awaited<ReturnType<typeof runModel>>;
   try{result=await run(fallback,prompt,remaining,true,options);}catch(error){result={ok:false,text:'planner startup failed: '+String(error),costUsd:0};}
   attempts.push({agent:fallback,...result});return{...result,attempts};
  }
 }
 return{...first,attempts};
}

export async function runPlannerModel(agent:ModelWorker,prompt:string,timeoutMs:number,run:typeof runModel=runModel,now:()=>number=Date.now){
 return runSubscriptionModel(agent,prompt,timeoutMs,{run,now,purpose:'planner'});
}

export async function planWork(state:CoordinatorState,directory:string,timeoutMs:number,agent:ModelWorker='codex'){
 const world=readWorld(state.tasks);atomicJson(join(directory,'world.json'),world);
 const held=heldRuns(state,capability=>capabilitySource(JSON.parse(readFileSync(join(projectRoot,'packages/router/tasks',capability+'.json'),'utf8')).files));
 const prompt=plannerPrompt(state,world,join(directory,'world.json'),held,deliveryConflictRoots(coordinationDir));
 writeFileSync(join(directory,'prompt.txt'),prompt);
 const result=await runPlannerModel(agent,prompt,timeoutMs);atomicJson(join(directory,'model.json'),result);
 if(!result.ok)throw Error('subscription planner unavailable: '+result.text.slice(-400));
 return parseModelObject(result.text);
}
