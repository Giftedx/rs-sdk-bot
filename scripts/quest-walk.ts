import type {PathOptions,PathPoint,PathResult} from '../packages/core/src/walk';
import type {openQuest} from './generated/quest-lib';

// quest_fishingcompo.rs2:22-35 moves a winner from the west gate tile to its east neighbour.
// A walk planner cannot perform this controlled crossing. The return stays east of McGrubor's gate.
export async function returnFishingContestTrophy(q:Pick<Awaited<ReturnType<typeof openQuest>>,'pos'|'dash'|'locAt'|'opLoc'|'step'|'walk'>):Promise<void>{
 const gate={id:47,x:2642,z:3442};
 await q.dash('contest exit approach',gate.x,gate.z,0);
 await q.step('contest gate exit',()=>q.opLoc(q.locAt(gate.x,gate.z)??gate,1),()=>{
  const p=q.pos();return p?.level===0&&p.worldX===gate.x+1&&p.worldZ===gate.z;
 },8,4);
 await q.walk('trophy to west dwarf',[
  {x:2645,z:3459,tol:2},{x:2666,z:3462,tol:2},{x:2679,z:3472,tol:2},
  {x:2731,z:3484,tol:3},{x:2820,z:3487,tol:2},
 ]);
}

// knowledge/doors.json gives the rat cage gate (loc 37 at 2595,9657) kind unknown, so the door policy keeps it shut
// after the lever opens it for 500 ticks (quest_cog_gates_and_levers.rs2:28-42). The policy plan then ends at the
// cage bars (2588,9661), and walkPath crosses them in a straight line. One client-routed click goes through the gate.
export const CLOCK_TROUGH={x:2588,z:9656};
export async function walkClockTowerTrough(q:Pick<Awaited<ReturnType<typeof openQuest>>,'dash'>):Promise<void>{
 await q.dash('to trough',CLOCK_TROUGH.x,CLOCK_TROUGH.z,1);
}

// Brother Kojo wanders between his room (z >= 3246) and the middle room through door loc 1530 at 2567,3245 (north
// wall, maps/m40_50.jm2). When it is shut and he is across it, the SDK finds no local route: interactNpc returns
// cant_reach and sends nothing, so talk() sees no "can't reach" message and opens no door (Wandwaver at 2570,3248,0,
// Kojo at 2568,3245). Open it from the bot's side before the talk; an open door is left alone.
export const KOJO_DOOR={x:2567,z:3245};
export async function openKojoDoor(q:Pick<Awaited<ReturnType<typeof openQuest>>,'pos'|'near'|'walk'|'shutAt'|'openDoor'|'npc'>):Promise<void>{
 const side={x:KOJO_DOOR.x,z:(q.pos()?.worldZ??0)>KOJO_DOOR.z?KOJO_DOOR.z+1:KOJO_DOOR.z};
 if(!q.near(side.x,side.z,0))await q.walk('kojo door side',[{...side,tol:0}]);
 const shut=!!q.shutAt(KOJO_DOOR.x,KOJO_DOOR.z);
 await q.openDoor('kojo middle door',KOJO_DOOR.x,KOJO_DOOR.z);
 const k=q.npc(/^brother kojo$/i),p=q.pos();
 console.log(`CLOCK_KOJO_DOOR ${JSON.stringify({shut,open:!q.shutAt(KOJO_DOOR.x,KOJO_DOOR.z),kojo:k&&{x:k.x,z:k.z},at:p&&{x:p.worldX,z:p.worldZ,level:p.level}})}`);
}

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
