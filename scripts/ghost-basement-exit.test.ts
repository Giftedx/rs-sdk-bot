import {test,expect} from 'bun:test';
import {leaveGhostBasement} from './ghost-basement-exit';
function fixture(){
 let position={worldX:3120,worldZ:9567,level:0},observed=false;
 const calls:string[]=[];
 const io={pos:()=>position,openDoor:async(_label:string,x:number,z:number)=>{calls.push(`door:${x},${z}`);},dash:async(_label:string,x:number,z:number)=>{calls.push(`walk:${x},${z}`);},
 waitForLadder:async()=>{observed=true;calls.push('ladder observed');return true;},climbLadder:async()=>{expect(observed).toBe(true);calls.push('climb');position={worldX:3104,worldZ:3162,level:0};},waitForLanding:async()=>{calls.push('surface observed');return true;}};
 return{io,calls,setPosition:(p:typeof position)=>{position=p;}};
}
test('the skull basement exits its room and observed ladder before the surface tower doors',async()=>{
 const f=fixture();await leaveGhostBasement(f.io);expect(f.calls).toEqual(['door:3111,9559','walk:3109,9560','walk:3104,9576','ladder observed','climb','surface observed','door:3107,3162','walk:3108,3164','door:3109,3166','walk:3109,3167']);
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
