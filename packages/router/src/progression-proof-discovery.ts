import * as fs from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {DeliveryResult} from './delivery';

export type ProgressionProofDelivery=DeliveryResult&{id:'ranged-train';ok:true;stage:'delivered';goal:string;at:number;directory:string;source:string;runtimeRevision:string;files:readonly {path:string;sha256:string}[]};
export interface DiscoveredProgressionDelivery{directory:string;report:ProgressionProofDelivery;reportSha256:string}
const projectRoot=resolve(import.meta.dir,'../../..'),producer='packages/practice/src/ranged-progression-case.ts';
const reportLimit=1024*1024,reportCount=64;
const protocol=/^ranged-train-([0-9]{10,16})-([a-zA-Z0-9_-]{1,64})$/;
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
const samePath=(a:string,b:string)=>relative(a,b)==='';
const sameFile=(a:fs.Stats,b:fs.Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const sourcePath=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!/[\\:]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');
function realDirectory(path:string):fs.Stats{
 const stat=fs.lstatSync(path);
 if(stat.isSymbolicLink()||!stat.isDirectory()||!samePath(path,fs.realpathSync(path)))throw Error('redirected discovery directory');
 return stat;
}
function boundedReport(file:string):Buffer{
 const before=fs.lstatSync(file);
 if(before.isSymbolicLink()||!before.isFile()||before.size>reportLimit||!samePath(file,fs.realpathSync(file)))throw Error('unsupported delivery report file');
 const flags=fs.constants.O_RDONLY|(process.platform==='win32'?0:(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
 const fd=fs.openSync(file,flags);
 try{
  const opened=fs.fstatSync(fd);
  if(!opened.isFile()||opened.size>reportLimit||!sameFile(before,opened))throw Error('delivery report changed before read');
  const bytes=Buffer.alloc(opened.size);let at=0;
  while(at<bytes.length){const read=fs.readSync(fd,bytes,at,bytes.length-at,at);if(read<=0)throw Error('partial delivery report read');at+=read;}
  const after=fs.fstatSync(fd),current=fs.lstatSync(file);
  if(!sameFile(opened,after)||current.isSymbolicLink()||!current.isFile()||!sameFile(opened,current)||!samePath(file,fs.realpathSync(file)))throw Error('delivery report changed during read');
  return bytes;
 }finally{fs.closeSync(fd);}
}
function supportedReport(value:unknown,started:number):value is ProgressionProofDelivery{
 if(!record(value)||value.id!=='ranged-train'||value.ok!==true||value.stage!=='delivered'||value.evidence!=='native'
  ||!text(value.goal)||!text(value.consumer)||typeof value.reason!=='string'||!digest(value.source)||!digest(value.runtimeRevision)
  ||value.diagnostic!==undefined||value.failedCheck!==undefined||value.hostDeferred!==undefined&&value.hostDeferred!==false
  ||!Number.isSafeInteger(value.at)||typeof value.at!=='number'||value.at<started||value.at>Date.now()
  ||!Array.isArray(value.checks)||value.checks.length<3||value.checks.length>128||!Array.isArray(value.files)||!value.files.length||value.files.length>512)return false;
 const phases=['regression','practice','consumer'],seen=new Set<string>(),found=new Set<number>();let previous=-1;
 for(const check of value.checks){
  if(!record(check)||!text(check.id)||seen.has(check.id)||typeof check.phase!=='string'||check.exitCode!==0
   ||check.timedOut!==undefined&&check.timedOut!==false||typeof check.detail!=='string')return false;
  const phase=phases.indexOf(check.phase);if(phase<0||phase<previous)return false;previous=phase;found.add(phase);seen.add(check.id);
 }
 if(found.size!==3)return false;
 let producers=0;
 for(const file of value.files){if(!record(file)||!sourcePath(file.path)||!digest(file.sha256))return false;if(file.path===producer)producers++;}
 return producers===1;
}
function canonicalClaim(value:unknown,root:string,directory:string,logicalDirectory:string):boolean{
 if(!text(value)||value.length>2048||value.replaceAll('\\','/').split('/').some(p=>p==='.'||p==='..'))return false;
 const path=resolve(root,value);
 return(samePath(path,directory)||samePath(path,logicalDirectory))&&samePath(fs.realpathSync(path),directory);
}

/** Discover local native receipts only. The existing registrar verifies and publishes each accepted proof. */
export function readProgressionDeliveries(base=projectRoot):DiscoveredProgressionDelivery[]{
 const result:DiscoveredProgressionDelivery[]=[];
 try{
  const root=fs.realpathSync(base),practice=fs.realpathSync(join(root,'.practice')),deliveries=join(practice,'deliveries');
  realDirectory(practice);realDirectory(deliveries);
  const candidates=fs.readdirSync(deliveries,{withFileTypes:true}).flatMap(dir=>{
   const match=protocol.exec(dir.name),at=Number(match?.[1]);
   return dir.isDirectory()&&!dir.isSymbolicLink()&&match&&Number.isSafeInteger(at)?[{name:dir.name,at}]:[];
  }).sort((a,b)=>b.at-a.at||b.name.localeCompare(a.name)).slice(0,reportCount);
  for(const candidate of candidates){try{
   const directory=join(deliveries,candidate.name),before=realDirectory(directory),bytes=boundedReport(join(directory,'report.json'));
   const report:unknown=JSON.parse(bytes.toString('utf8'));
   if(!supportedReport(report,candidate.at)||!canonicalClaim(report.directory,root,directory,join(root,'.practice/deliveries',candidate.name)))continue;
   realDirectory(deliveries);const after=realDirectory(directory);
   if(before.dev!==after.dev||before.ino!==after.ino)continue;
   result.push({directory,report,reportSha256:createHash('sha256').update(bytes).digest('hex')});
  }catch{/* Partial or redirected receipts provide no candidate to the registrar. */}}
 }catch{/* Missing or unsupported local storage provides no native candidates. */}
 return result;
}
