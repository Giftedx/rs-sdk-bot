import {mkdirSync,writeFileSync,renameSync,rmSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';

export interface ProgressionEvidenceWriter{
 mkdir(path:string):void;write(path:string,data:string):void;rename(from:string,to:string):void;remove(path:string):void;
 nonce():string;pid:number;
}
const native:ProgressionEvidenceWriter={mkdir:path=>{mkdirSync(path,{recursive:true});},write:(path,data)=>writeFileSync(path,data),rename:renameSync,remove:path=>rmSync(path,{force:true}),nonce:randomUUID,pid:process.pid};
/** Each account owns its output. Unique temporary files keep optional telemetry failures out of gameplay. */
export function writeProgressionEvidence(file:string,value:unknown,log?:(line:string)=>void,writer:ProgressionEvidenceWriter=native):boolean{
 let temporary:string|undefined;
 try{
  temporary=file+'.tmp.'+writer.pid+'.'+writer.nonce();
  writer.mkdir(dirname(file));writer.write(temporary,JSON.stringify(value));writer.rename(temporary,file);return true;
 }catch(error){
  const detail=error instanceof Error?error.message:String(error);
  try{log?.(('PROGRESSION_EVIDENCE_WRITE_FAIL '+basename(file)+': '+detail).replace(/[\r\n]+/g,' ').slice(0,240));}catch{/* A logger cannot take ownership of a live tick. */}
  return false;
 }finally{if(temporary)try{writer.remove(temporary);}catch{/* Best effort: retain an unremovable diagnostic temporary file. */}}
}
const conditionKey=(value:unknown)=>typeof value==='string'?value:JSON.stringify(value);
/** Read a bounded set of independent account records for exactly one method, source and condition context. */
export function readProgressionMeasurements(dir:string,method:string,source:string,conditions:unknown):{windows:any[];evidence:string[]}{
 const result:{windows:any[];evidence:string[]}={windows:[],evidence:[]};
 let names:string[],expected:string|undefined;
 try{expected=conditionKey(conditions);names=readdirSync(dir,{withFileTypes:true}).filter(f=>f.isFile()&&/^[a-z0-9]{1,12}\.json$/i.test(f.name)).map(f=>f.name).sort().slice(0,64);}catch{return result;}
 for(const name of names){
  const file=join(dir,name);
  try{
   if(statSync(file).size>1024*1024)continue;
   const row=JSON.parse(readFileSync(file,'utf8'));
   if(row?.method!==method||row.source!==source||conditionKey(row.conditions)!==expected||!Array.isArray(row.windows))continue;
   const windows=row.windows.slice(-256).filter((w:any)=>w&&w.source===source&&conditionKey(w.conditions)===expected&&(w.method===undefined||w.method===method));
   if(!windows.length)continue;result.windows.push(...windows);result.evidence.push(file);
  }catch{/* Partial, old-source or malformed evidence remains unknown. */}
 }
 return result;
}
