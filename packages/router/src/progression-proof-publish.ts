import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {writeProgressionEvidence} from '../../core/src/progression-evidence';
import {cachedReleaseFor} from '../../core/src/worker-release';
import {rangedComparisonChecks,rangedEntryProofChecks} from '../../practice/src/ranged-progression-case';
import {parsePracticeSave} from '../../../scripts/measure/fleet-player-save';
import {deliveryFingerprint} from './delivery-cli';
import {validateDelivery,type DeliveryResult,type DeliveryTask} from './delivery';

export type ProgressionProofDelivery=DeliveryResult&{id?:string;goal?:string;at?:number;directory?:string;runtimeRevision?:string|null;files?:readonly {path:string;sha256:string|null}[]};
export interface ProgressionProofPublishOptions{root?:string;currentRevision?:()=>string;currentFingerprint?:()=>string;write?:(file:string,value:unknown)=>boolean}
export interface ProgressionProofPublication{changed:boolean;status:'published'|'unchanged'|'held'|'retry';reason:string;references?:{path:string;sha256:string}[]}
const projectRoot=resolve(import.meta.dir,'../../..'),producer='packages/practice/src/ranged-progression-case.ts';
export const PROGRESSION_PROOF_CAPABILITY='ranged-train';
/** Only immediate known-protocol directories are listed; at most64 bounded report files are opened. */
export function readProgressionDeliveries(base=projectRoot):ProgressionProofDelivery[]{
 const receipts:ProgressionProofDelivery[]=[];
 try{
  const root=realpathSync(base),deliveries=confined(root,join(root,'.practice/deliveries'));
  const candidates=readdirSync(deliveries,{withFileTypes:true}).flatMap(dir=>{
   const match=new RegExp('^'+PROGRESSION_PROOF_CAPABILITY+'-([0-9]{10,16})-([a-zA-Z0-9_-]{1,64})$').exec(dir.name),at=Number(match?.[1]);
   return dir.isDirectory()&&!dir.isSymbolicLink()&&match&&Number.isSafeInteger(at)?[{name:dir.name,at}]:[];
  }).sort((a,b)=>b.at-a.at||b.name.localeCompare(a.name)).slice(0,64);
  for(const candidate of candidates){
   try{
    const directory=under(root,deliveries,join(deliveries,candidate.name)),file=join(directory,'report.json');
    if(lstatSync(file).isSymbolicLink())continue;
    const receipt=parse(bytes(root,directory,file)) as ProgressionProofDelivery;nativeReceipt(receipt);
    requireValue(typeof receipt.directory==='string'&&relative(directory,under(root,deliveries,receipt.directory))==='','delivery directory differs from scanned receipt');
    requireValue(Array.isArray(receipt.files)&&receipt.files.length<=512&&receipt.files.some(f=>f?.path===producer&&isHash(f.sha256)),'unsupported native proof producer');
    receipts.push(receipt);
   }catch{/* Partial, unsupported and oversized reports stay outside the publisher. */}
  }
 }catch{/* Missing or escaped delivery storage provides no accepted receipts. */}
 return receipts;
}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function requireValue(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(reason);}
function within(parent:string,path:string){const r=relative(parent,path);return r===''||!r.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&r!=='..'&&!isAbsolute(r);}
/** Check existing ancestors too, so a missing output file cannot hide an escaped junction. */
function confined(root:string,target:string){
 requireValue(typeof target==='string'&&target.length>0&&target.length<=2048,'invalid evidence path');
 const file=resolve(root,target);requireValue(within(root,file),'evidence path escapes project root');
 let probe=file;
 for(;;){
  try{lstatSync(probe);requireValue(within(root,realpathSync(probe)),'evidence symlink escapes project root');return file;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(probe);requireValue(parent!==probe,'evidence ancestor missing');probe=parent;}
 }
}
function under(root:string,base:string,target:string){
 const directory=confined(root,base),file=confined(root,target);
 requireValue(within(directory,file)&&file!==directory,'evidence path outside supported directory');
 if(existsSync(file))requireValue(within(realpathSync(directory),realpathSync(file)),'evidence symlink escapes supported directory');
 return file;
}
function bytes(root:string,base:string,path:string,limit=1024*1024){
 const file=under(root,base,path),stat=statSync(file);requireValue(stat.isFile()&&stat.size<=limit,'evidence file is not bounded regular data');return readFileSync(file);
}
const parse=(value:Uint8Array)=>JSON.parse(Buffer.from(value).toString('utf8'));
function stable(value:unknown):string{
 if(Array.isArray(value))return'['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(value)??'undefined';
}
function receiptKey(delivery:ProgressionProofDelivery){
 return stable(Object.fromEntries(['id','goal','ok','stage','evidence','consumer','source','reason','checks','at','runtimeRevision','directory','files'].map(key=>[key,delivery[key as keyof ProgressionProofDelivery]])));
}
function nativeReceipt(receipt:ProgressionProofDelivery){
 requireValue(receipt.id===PROGRESSION_PROOF_CAPABILITY,'unsupported native proof capability');
 requireValue(typeof receipt.goal==='string'&&receipt.goal.trim().length>0,'delivery goal missing');
 requireValue(receipt.ok===true&&receipt.stage==='delivered'&&receipt.evidence==='native','delivery has no successful native acceptance');
 requireValue(!receipt.diagnostic&&!receipt.failedCheck&&isHash(receipt.source)&&isHash(receipt.runtimeRevision),'delivery is incomplete or lacks source pins');
 requireValue(Number.isSafeInteger(receipt.at)&&receipt.at!>0,'delivery timestamp missing');
 requireValue(Array.isArray(receipt.checks)&&receipt.checks.length<=128&&['regression','practice','consumer'].every(phase=>receipt.checks.some(c=>c.phase===phase))
  &&receipt.checks.every(c=>c.exitCode===0&&!c.timedOut),'delivery checks have not all passed');
}
/** Promote only the audited Ranged native artifact protocol. This does not enable workers or alter receipts. */
export function publishProgressionProof(delivery:ProgressionProofDelivery,options:ProgressionProofPublishOptions={}):ProgressionProofPublication{
 let references:{path:string;sha256:string}[]|undefined;
 try{
  nativeReceipt(delivery);
  const root=realpathSync(options.root??projectRoot),deliveries=join(root,'.practice/deliveries');
  requireValue(typeof delivery.directory==='string','delivery directory missing');
  const directory=under(root,deliveries,delivery.directory),receipt=parse(bytes(root,directory,join(directory,'report.json'))) as ProgressionProofDelivery;
  nativeReceipt(receipt);requireValue(receiptKey(receipt)===receiptKey(delivery),'delivery differs from canonical receipt');
  requireValue(receipt.runtimeRevision===(options.currentRevision?.()??cachedReleaseFor(['scripts/ranged-train.ts'],root)),'runtime source is no longer current');
  const currentFingerprint=options.currentFingerprint??(()=>{
   const task=parse(bytes(root,join(root,'packages/router/tasks'),join(root,'packages/router/tasks/ranged-train.json'))) as DeliveryTask;
   validateDelivery(task);requireValue(task.id===PROGRESSION_PROOF_CAPABILITY&&task.entry==='scripts/ranged-train.ts','unsupported delivery worker');return deliveryFingerprint(task,root);
  });
  requireValue(receipt.source===currentFingerprint(),'delivery qualification source is no longer current');
  requireValue(Array.isArray(receipt.files)&&receipt.files.length<=512,'delivery source files missing');
  const producers=receipt.files.filter(f=>f.path===producer);requireValue(producers.length===1&&isHash(producers[0]!.sha256),'unsupported native proof producer');
  const producerHash=hash(bytes(root,join(root,'packages/practice/src'),join(root,producer)));
  requireValue(producers[0]!.sha256===producerHash,'native proof producer source changed');
  const pointer=parse(bytes(root,directory,join(directory,'ranged-adaptive-proof.json'),4096));
  requireValue(pointer&&typeof pointer.folder==='string','supported native proof pointer missing');
  const proofs=join(root,'.practice/progression-ranged'),folder=under(root,proofs,pointer.folder),file=under(root,folder,join(folder,'proof.json'));
  const raw=bytes(root,folder,file),proof=parse(raw);
  requireValue(proof?.ok===true&&proof.code===0&&proof.source===receipt.runtimeRevision&&proof.proofSource===producerHash,'native proof source or result differs from delivery');
  requireValue(Number.isSafeInteger(proof.at)&&proof.at>0&&proof.at<=receipt.at!&&receipt.at!-proof.at<900000,'native proof was not fresh at delivery');
  requireValue([83,85].includes(proof.target)&&Array.isArray(proof.supportedMethods)&&proof.supportedMethods.length===1
   &&['ranged/chickens','ranged/troopers'].includes(proof.supportedMethods[0]?.id),'unsupported native method or target');
  const required=['exit','result','exactEntry','xp','bank','assets','arrows','coins','accounting','health','logout','persisted','timeout','source'];
  requireValue(proof.checks&&typeof proof.checks==='object'&&!Array.isArray(proof.checks)&&required.every(k=>proof.checks[k]===true)
   &&Object.values(proof.checks).every(v=>v===true),'native proof checks have not all passed');
  const log=bytes(root,folder,join(folder,'worker.log'),16*1024*1024).toString('utf8'),lines=log.split(/\r?\n/).filter(l=>l.startsWith('RANGED_TRAIN_RESULT '));
  requireValue(lines.length===1,'native result line is missing or ambiguous');
  const result=JSON.parse(lines[0]!.slice('RANGED_TRAIN_RESULT '.length));requireValue(stable(result)===stable(proof.result),'native result differs from proof');
  const frozen=rangedEntryProofChecks(bytes(root,folder,join(folder,'entry.json')),proof,result);
  requireValue(frozen.supportedMethods,'native supported bands differ from frozen entry');
  const before=parsePracticeSave(bytes(root,folder,join(folder,'before.sav'),4*1024*1024)),after=parsePracticeSave(bytes(root,folder,join(folder,'after.sav'),4*1024*1024));
  const checks=rangedComparisonChecks(before,after,result,log,proof.code,proof.target,frozen.entry);
  requireValue(Object.values(checks).every(v=>v===true),'retained native saves or accounting fail acceptance');
  const output=confined(root,join(root,'.practice/progression-system/qualifications.json'));
  const index=existsSync(output)?parse(bytes(root,dirname(output),output,4*1024*1024)):{proofs:[]};
  requireValue(index&&typeof index==='object'&&!Array.isArray(index)&&Array.isArray(index.proofs)&&index.proofs.length<4096,'qualification index is malformed or full');
  requireValue(index.proofs.every((p:any)=>p&&typeof p.path==='string'&&isHash(p.sha256)),'qualification index references are malformed');
  const reference={path:file,sha256:hash(raw)};references=[reference];
  if(index.proofs.some((p:any)=>p.path===reference.path&&p.sha256===reference.sha256))return{changed:false,status:'unchanged',reason:'native proof already published',references};
  const next={...index,proofs:[...index.proofs,reference]};
  try{
   if(!(options.write??writeProgressionEvidence)(output,next))return{changed:false,status:'retry',reason:'optional qualification index write failed; retry publication',references};
  }catch{return{changed:false,status:'retry',reason:'optional qualification index write failed; retry publication',references};}
  return{changed:true,status:'published',reason:'verified native method bands published',references};
 }catch(error){return{changed:false,status:'held',reason:(error instanceof Error?error.message:String(error)).replace(/[\r\n]+/g,' ').slice(0,240),references};}
}
