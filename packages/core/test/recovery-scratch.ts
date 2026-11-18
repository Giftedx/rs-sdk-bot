// Scratch folders of the recovery tests. They sit under the repository (the native fixture check refuses a folder
// outside it) but in one subfolder, and each test file removes its own folders when it ends. A killed test leaves its
// folders: delete .practice/recovery-tmp by hand when no test runs (scripts/practice-hygiene.ts does not sweep it).
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {afterAll} from 'bun:test';

export const SCRATCH_ROOT=resolve(import.meta.dir,'../../../.practice/recovery-tmp');

export function useScratch(){
 mkdirSync(SCRATCH_ROOT,{recursive:true});
 const made:string[]=[];
 afterAll(()=>{for(const dir of made)try{rmSync(dir,{recursive:true,force:true});}catch{/* the next hygiene sweep takes it */}});
 return (prefix:string)=>{const dir=mkdtempSync(join(SCRATCH_ROOT,prefix));made.push(dir);return dir;};
}
