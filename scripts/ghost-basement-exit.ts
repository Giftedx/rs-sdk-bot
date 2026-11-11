import {exitRuneTower} from './rune-mysteries-route';

export function retainedGhostSkull(state:string,pack:readonly {id:number;count:number}[],worn:readonly {id:number;count:number}[]){
 return state==='started'&&pack.filter(i=>i.id===553).reduce((n,i)=>n+i.count,0)===1&&worn.some(i=>i.id===552&&i.count===1);
}
export function retainedGhostBankSkull(state:string,pack:readonly {id:number;count:number}[],worn:readonly {id:number;count:number}[],bank:readonly {id:number;count:number}[]){
 return state==='started'&&!pack.some(i=>i.id===553&&i.count>0)&&worn.some(i=>i.id===552&&i.count===1)&&bank.some(i=>i.id===553&&i.count>0);
}

type Position={worldX:number;worldZ:number;level:number};
export interface GhostBasementExit {
 pos:()=>Position|null|undefined;
 openDoor:(label:string,x:number,z:number)=>Promise<void>;
 dash:(label:string,x:number,z:number,tol:number)=>Promise<void>;
 waitForLadder:()=>Promise<boolean>;
 climbLadder:()=>Promise<void>;
 waitForLanding:()=>Promise<boolean>;
}

type Door={x:number;z:number};
export interface DoorDash {
 pos:()=>Position|null|undefined;
 walk:(x:number,z:number)=>Promise<void>;
 arrived:(x:number,z:number,tol:number)=>Promise<boolean>;
 closedDoor:(within:number)=>Door|undefined;
 open:(door:Door)=>Promise<void>;
}
// A try that ends where it started re-opens the nearest closed door within 2 tiles (closed again, loaded late or on the
// next tile) before the next try. A stall with no door to open fails at once instead of idling into the ladder wait.
export async function dashThroughDoor(io:DoorDash,label:string,x:number,z:number,tol:number,tries=3){
 const near=()=>{const p=io.pos();return!!p&&Math.max(Math.abs(p.worldX-x),Math.abs(p.worldZ-z))<=tol;};
 for(let i=0;i<tries&&!near();i++){
  const before=io.pos();
  await io.walk(x,z);
  if(await io.arrived(x,z,tol))return;
  const after=io.pos();
  if(before&&after&&(before.worldX!==after.worldX||before.worldZ!==after.worldZ||before.level!==after.level))continue;
  const door=io.closedDoor(2);
  if(!door)throw Error(`ghost exit: ${label} blocked at ${after?.worldX},${after?.worldZ} with no closed door within 2 tiles`);
  await io.open(door);
 }
}

// The Wizards' Tower basement with the skull room (quest_priest.rs2): underground on level 0, x 3100-3125, z 9550-9580.
export const inGhostBasement=(p:Position|null|undefined):boolean=>!!p&&p.level===0&&p.worldX>=3100&&p.worldX<=3125&&p.worldZ>=9550&&p.worldZ<=9580;
// The ghost skull room is underground on level0. It cannot use a same-floor surface walk.
export async function leaveGhostBasement(io:GhostBasementExit){
 const p=io.pos();if(!p)throw Error('ghost exit: position unknown');
 if(p.level===0&&p.worldZ<4000)return;
 if(!inGhostBasement(p))throw Error('ghost exit: unknown basement');
 await io.openDoor('skull exit door',3111,9559);
 await io.dash('skull exit corridor',3109,9560,1);
 await io.dash('skull exit ladder approach',3104,9576,1);
 if(!await io.waitForLadder())throw Error('ghost exit: basement ladder unobserved');
 await io.climbLadder();
 const landing=io.pos();if(!landing||landing.level!==0||landing.worldZ>=4000)throw Error('ghost exit: surface transition unobserved');
 await exitRuneTower(io,'skull exit');
}
