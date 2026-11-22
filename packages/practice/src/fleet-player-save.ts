// Focused local proof reader. Layout: engine/entity/PlayerLoading.ts; CRC: presets-mm.ts. Version 10 appends
// millisecond playtimes after the parts read here, so versions 5-10 share this layout.
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
export { readPracticeSave, parsePracticeSave, waitPracticeSave, type PracticeSave } from '../../core/src/player-save';

function checked(b:Buffer){if(b.length<140||b.readUInt16BE(0)!==0x2004)throw new Error('invalid local player save');if((Bun.hash.crc32(b.subarray(0,-4))>>>0)!==b.readUInt32BE(b.length-4))throw new Error('local player save CRC mismatch');return b;}
function bytes(path:string){return checked(readFileSync(path));}
// Only a just-generated practice fixture may receive exact source XP. Never reads live credentials.
export function setPracticeSkills(path:string,skills:{level:number;xp:number}[]){
 const canonical=realpathSync(path),practice=realpathSync(resolve(import.meta.dir,'../../../vendor/rs-sdk/server/engine/data/players/main'));
 const generated=/^(?:fl[a-z0-9]+|aiobfl[a-z0-9]+)\.sav$/i;
 if(dirname(canonical)!==practice||!generated.test(basename(path))||!generated.test(basename(canonical))||skills.length!==21)throw new Error('requires generated fleet practice save and21skills');
 // The saved byte is the current level. Prayer can be drained to zero while
 // its XP still gives a base level of 43. Living fixtures still need positive HP.
 const b=bytes(canonical);for(const [i,s] of skills.entries()){if(!Number.isSafeInteger(s.xp)||s.xp<0||!Number.isSafeInteger(s.level)||(i===3?s.level<1:s.level<0)||s.level>99)throw new Error('invalid exact practice skill');b.writeInt32BE(s.xp*10,28+i*5);b.writeUInt8(s.level,32+i*5);}b.writeUInt32BE(Bun.hash.crc32(b.subarray(0,-4))>>>0,b.length-4);writeFileSync(canonical,b);
}
