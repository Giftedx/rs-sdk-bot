import type {PathOptions,PathPoint,PathResult} from '../packages/core/src/walk';

// Keep the donor route/task distinction (Scotho/idlescape tutorial enter-mine;
// rs2b2t/rs2b0t quest-pitfalls-32): finishing a prerequisite/partial leg is not
// finishing its route. Our PathResult.next supplies the existing resume cursor.
// A retry retains every unfinished corridor point and the original deadline.
export async function walkQuestCorridor(io:{tick:()=>number;stop:()=>boolean;near:(point:PathPoint,tolerance:number)=>boolean;walk:(points:PathPoint[],options:PathOptions)=>Promise<PathResult>;onAttempt?:(attempt:number,result:PathResult)=>void},points:PathPoint[],deadline:number):Promise<{ok:boolean;detail?:string}>{
 if(!points.length)return{ok:false,detail:'empty quest corridor'};
 const goal=points[points.length-1]!,tolerance=goal.tol??2;
 let cursor=0;
 for(let attempt=0;attempt<3;attempt++){
  if(io.stop()||io.tick()>=deadline)return{ok:false,detail:'quest corridor stopped/deadline'};
  if(io.near(goal,tolerance))return{ok:true};
  const remaining=points.slice(cursor),budget=deadline-io.tick();
  const r=await io.walk(remaining,{maxTicks:budget,stop:()=>io.stop()||io.tick()>=deadline});
  io.onAttempt?.(attempt,r);
  if(r.detail?.startsWith('tick stream stalled:'))return{ok:false,detail:r.detail};
  if(io.stop())return{ok:false,detail:'quest corridor stopped/deadline'};
  if(!Number.isSafeInteger(r.next)||r.next<0||r.next>remaining.length)return{ok:false,detail:'invalid quest corridor cursor'};
  if(r.ok)return io.tick()<=deadline&&io.near(goal,tolerance+1)?{ok:true}:{ok:false,detail:'quest corridor arrival unobserved'};
  if(io.tick()>=deadline||r.detail==='stopped')return{ok:false,detail:'quest corridor stopped/deadline'};
  cursor+=r.next;
  if(cursor===points.length)return{ok:false,detail:'quest corridor arrival unobserved'};
 }
 return{ok:false,detail:'quest corridor exhausted bounded retries'};
}
