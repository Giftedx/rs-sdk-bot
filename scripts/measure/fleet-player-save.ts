// Focused local proof reader. Layout: engine/entity/PlayerLoading.ts; CRC: presets-mm.ts.
import {readFileSync,writeFileSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
function checked(b:Buffer){if(b.length<140||b.readUInt16BE(0)!==0x2004)throw new Error('invalid local player save');if((Bun.hash.crc32(b.subarray(0,-4))>>>0)!==b.readUInt32BE(b.length-4))throw new Error('local player save CRC mismatch');return b;}
function bytes(path:string){return checked(readFileSync(path));}
export function readPracticeSave(path:string){return parsePracticeSave(readFileSync(path));}
export function parsePracticeSave(raw:Uint8Array){
 const b=checked(Buffer.from(raw)),version=b.readUInt16BE(2);if(version<5||version>9)throw new Error(`unsupported local save version${version}`);
 const skills=Array.from({length:21},(_,i)=>({index:i,rawExperience:b.readInt32BE(28+i*5),xp:Math.trunc(b.readInt32BE(28+i*5)/10),level:b.readUInt8(32+i*5)}));
 let at=133;const u1=()=>b.readUInt8(at++),u2=()=>{const n=b.readUInt16BE(at);at+=2;return n;},i4=()=>{const n=b.readInt32BE(at);at+=4;return n;};
 const varInt=()=>{let byte=u1(),n=0;while(byte&128){n=(n|(byte&127))<<7;byte=u1();}return(n|byte)>>>0;};
 const vars:Record<number,number>={},varCount=u2();if(varCount>10000)throw new Error('invalid saved varp count');
 for(let i=0;i<varCount;i++){if(version>=7){const id=u2();vars[id]=varInt();}else vars[i]=i4();}
 const inventories:Record<number,{slot:number;id:number;count:number}[]>={};
 for(let i=0,n=u1();i<n;i++){const type=u2(),size=u2();if(size>2000)throw new Error('invalid saved inventory size');const items=[];for(let slot=0;slot<size;slot++){const id=u2()-1;if(id<0)continue;const short=u1(),count=short===255?i4():short;items.push({slot,id,count});}inventories[type]=items;}
 return {version,position:{x:b.readUInt16BE(4),z:b.readUInt16BE(6),level:b.readUInt8(8)},skills,vars,inventories};
}
// Only a just-generated practice fixture may receive exact source XP. Never reads live credentials.
export function setPracticeSkills(path:string,skills:{level:number;xp:number}[]){
 if(dirname(resolve(path))!==resolve(import.meta.dir,'../../vendor/rs-sdk/server/engine/data/players/main')||!/^fl[a-z0-9]+\.sav$/i.test(basename(path))||skills.length!==21)throw new Error('requires generated fleet practice save and21skills');
 // The saved byte is the current level. Prayer can be drained to zero while
 // its XP still gives a base level of 43. Living fixtures still need positive HP.
 const b=bytes(path);for(const [i,s] of skills.entries()){if(!Number.isSafeInteger(s.xp)||s.xp<0||!Number.isSafeInteger(s.level)||(i===3?s.level<1:s.level<0)||s.level>99)throw new Error('invalid exact practice skill');b.writeInt32BE(s.xp*10,28+i*5);b.writeUInt8(s.level,32+i*5);}b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,b.length-4);writeFileSync(path,b);
}

// Logout acknowledgement can precede the engine's final .sav publication.
// Wait for the actual required state; a timeout retains the unmatched data.
export async function waitPracticeSave(path:string,ready:(save:ReturnType<typeof readPracticeSave>)=>boolean,options:{timeoutMs?:number;intervalMs?:number;read?:()=>ReturnType<typeof readPracticeSave>}={}){
 const deadline=Date.now()+(options.timeoutMs??6000),read=options.read??(()=>readPracticeSave(path));
 let first:ReturnType<typeof readPracticeSave>|undefined,last:ReturnType<typeof readPracticeSave>|undefined,reads=0,lastError='';
 do{
  try{last=read();reads++;first??=last;if(ready(last))return {matched:true,save:last,first,reads,lastError};}catch(e){lastError=String(e);}
  if(Date.now()>=deadline)break;await Bun.sleep(options.intervalMs??250);
 }while(Date.now()<=deadline);
 if(!last)throw new Error(`native save never became readable: ${lastError}`);
 return {matched:false,save:last,first,reads,lastError};
}
