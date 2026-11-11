import {test,expect} from 'bun:test';
import {leaveGhostBasement,retainedGhostSkull,retainedGhostBankSkull,dashThroughDoor} from './ghost-basement-exit';
function fixture(){
 let position={worldX:3120,worldZ:9567,level:0},observed=false;
 const calls:string[]=[];
 const io={pos:()=>position,openDoor:async(_label:string,x:number,z:number)=>{calls.push(`door:${x},${z}`);},dash:async(_label:string,x:number,z:number)=>{calls.push(`walk:${x},${z}`);},
 waitForLadder:async()=>{observed=true;calls.push('ladder observed');return true;},climbLadder:async()=>{expect(observed).toBe(true);calls.push('climb');position={worldX:3104,worldZ:3162,level:0};},waitForLanding:async()=>{calls.push('surface observed');return true;}};
 return{io,calls,setPosition:(p:typeof position)=>{position=p;}};
}
test('retained skull return needs a started journal, exactly one held skull and the worn amulet',()=>{
 const pack=[{id:553,count:1}],worn=[{id:552,count:1}];
 expect(retainedGhostSkull('started',pack,worn)).toBe(true);
 for(const state of ['unknown','not started','complete'])expect(retainedGhostSkull(state,pack,worn)).toBe(false);
 expect(retainedGhostSkull('started',[],worn)).toBe(false);
 expect(retainedGhostSkull('started',[{id:553,count:2}],worn)).toBe(false);
 expect(retainedGhostSkull('started',pack,[])).toBe(false);
});
test('the banked skull route withdraws only from observed owned stock for the same started quest',()=>{
 const worn=[{id:552,count:1}],bank=[{id:553,count:1}];
 expect(retainedGhostBankSkull('started',[],worn,bank)).toBe(true);
 expect(retainedGhostBankSkull('started',[],worn,[])).toBe(false);
 expect(retainedGhostBankSkull('not started',[],worn,bank)).toBe(false);
 expect(retainedGhostBankSkull('started',bank,worn,bank)).toBe(false);
 expect(retainedGhostBankSkull('started',[],[],bank)).toBe(false);
});
test('the skull basement exits its room and observed ladder before the surface tower doors',async()=>{
 const f=fixture();await leaveGhostBasement(f.io);expect(f.calls).toEqual(['door:3111,9559','walk:3109,9560','walk:3104,9576','ladder observed','climb','surface observed','door:3107,3162','walk:3108,3164','door:3109,3166','walk:3109,3167']);
});
function doorDash(doorOpen:boolean){
 let position={worldX:3111,worldZ:9559,level:0},open=doorOpen,first=true;
 const calls:string[]=[];
 const io={pos:()=>position,
  walk:async(x:number,z:number)=>{calls.push(`walk:${x},${z}`);if(first){first=false;open=false;}if(open)position={worldX:x,worldZ:z,level:0};},
  arrived:async(x:number,z:number,tol:number)=>Math.max(Math.abs(position.worldX-x),Math.abs(position.worldZ-z))<=tol,
  closedDoor:(within:number)=>!open&&within>=1?{x:3110,z:9559}:undefined,
  open:async(d:{x:number;z:number})=>{calls.push(`open:${d.x},${d.z}`);open=true;}};
 return{io,calls,pos:()=>position,noDoor:()=>{io.closedDoor=()=>undefined;}};
}
test('a skull door that closes again on the first dash is re-opened before the next try',async()=>{
 const f=doorDash(true);await dashThroughDoor(f.io,'skull exit corridor',3109,9560,1);
 expect(f.calls).toEqual(['walk:3109,9560','open:3110,9559','walk:3109,9560']);expect(f.pos()).toEqual({worldX:3109,worldZ:9560,level:0});
});
test('a stalled dash with no closed door near fails at once instead of idling into the ladder wait',async()=>{
 const f=doorDash(true);f.noDoor();
 await expect(dashThroughDoor(f.io,'skull exit corridor',3109,9560,1)).rejects.toThrow('ghost exit: skull exit corridor blocked at 3111,9559 with no closed door within 2 tiles');
 expect(f.calls).toEqual(['walk:3109,9560']);
});
test('an already surface account does not use the basement ladder',async()=>{
 const f=fixture();f.setPosition({worldX:3109,worldZ:3167,level:0});await leaveGhostBasement(f.io);expect(f.calls).toEqual([]);
});
test('unknown or unobserved transitions refuse before blind ladder or surface actions',async()=>{
 const unknown=fixture();unknown.setPosition({worldX:3000,worldZ:9567,level:0});await expect(leaveGhostBasement(unknown.io)).rejects.toThrow('unknown basement');expect(unknown.calls).toEqual([]);
 const missing=fixture();missing.io.waitForLadder=async()=>false;await expect(leaveGhostBasement(missing.io)).rejects.toThrow('ladder unobserved');expect(missing.calls).not.toContain('climb');
 const stuck=fixture();stuck.io.climbLadder=async()=>{};await expect(leaveGhostBasement(stuck.io)).rejects.toThrow('surface transition unobserved');expect(stuck.calls).not.toContain('surface observed');
 const absent=fixture();absent.io.waitForLanding=async()=>false;await expect(leaveGhostBasement(absent.io)).rejects.toThrow('landing objects unobserved');expect(absent.calls).not.toContain('door:3107,3162');
});
