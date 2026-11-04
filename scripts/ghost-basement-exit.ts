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

// The ghost skull room is underground on level0. It cannot use a same-floor surface walk.
export async function leaveGhostBasement(io:GhostBasementExit){
 const p=io.pos();if(!p)throw Error('ghost exit: position unknown');
 if(p.level===0&&p.worldZ<4000)return;
 if(p.level!==0||p.worldX<3100||p.worldX>3125||p.worldZ<9550||p.worldZ>9580)throw Error('ghost exit: unknown basement');
 await io.openDoor('skull exit door',3111,9559);
 await io.dash('skull exit corridor',3109,9560,1);
 await io.dash('skull exit ladder approach',3104,9576,1);
 if(!await io.waitForLadder())throw Error('ghost exit: basement ladder unobserved');
 await io.climbLadder();
 const landing=io.pos();if(!landing||landing.level!==0||landing.worldZ>=4000)throw Error('ghost exit: surface transition unobserved');
 await exitRuneTower(io,'skull exit');
}
