import type {CoordinatorState} from './coordinator';
import type {DeliveryTask} from './delivery';
import type {DiscoveredProgressionDelivery} from './progression-proof-discovery';
import {readProgressionDeliveries} from './progression-proof-discovery';
import {registerAcceptedProgressionDelivery} from './progression-qualification-native';
import {deliveryTask,deliveryFingerprint} from './delivery-cli';
import {cachedReleaseFor} from '../../core/src/worker-release';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

export interface ProgressionProofReference{path:string;sha256:string}
export interface ProgressionProofReconcileResult{directory?:string;taskId?:string;runId?:string;status:'registered'|'unchanged'|'held'|'retry';reason:string;proof?:ProgressionProofReference}
export interface ProgressionProofReconcileDeps{
 discover?:(base:string)=>DiscoveredProgressionDelivery[];
 task?:(id:string)=>DeliveryTask;
 binding?:(task:DeliveryTask)=>{fingerprint:string;runtime:string};
 register?:(task:DeliveryTask,delivery:{ok:boolean;directory?:string},base:string)=>Promise<{registered:number;index:string;proof?:ProgressionProofReference}>;
 indexed?:(proof:ProgressionProofReference,index:string)=>boolean;
}
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const inside=(root:string,path:string)=>{const p=relative(root,path);return p!==''&&p!=='..'&&!p.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(p);};
function indexedProof(base:string,proof:ProgressionProofReference,index:string){
 try{
  const root=realpathSync(join(base,'.practice')),indexPath=realpathSync(index),proofPath=realpathSync(proof.path);
  if(!inside(root,indexPath)||!inside(root,proofPath))return false;
  const read=(path:string,limit:number)=>{const stat=statSync(path);if(!stat.isFile()||stat.size>limit)throw Error('registration cache file is not bounded regular data');const bytes=readFileSync(path);if(bytes.length>limit)throw Error('registration cache file grew');return bytes;};
  const saved=JSON.parse(read(indexPath,4*1024*1024).toString('utf8'));
  return Array.isArray(saved?.proofs)&&saved.proofs.some((p:any)=>p?.path===proof.path&&p.sha256===proof.sha256)&&hash(read(proofPath,1024*1024))===proof.sha256;
 }catch{return false;}
}
/** Reuse the locked registrar; reconciliation never writes the qualification index itself. */
export function createProgressionProofReconciler(base:string,deps:ProgressionProofReconcileDeps={}){
 const completed=new Map<string,{proof:ProgressionProofReference;index:string}>();
 return async(state:Pick<CoordinatorState,'tasks'>):Promise<ProgressionProofReconcileResult[]>=>{
  const results:ProgressionProofReconcileResult[]=[],candidates=new Map<string,DiscoveredProgressionDelivery&{taskId?:string;runId?:string}>();
  const key=(path:string)=>{try{return realpathSync(path);}catch{return resolve(base,path);}};
  try{for(const row of (deps.discover??readProgressionDeliveries)(base))candidates.set(key(row.directory),row);}
  catch(error){results.push({status:'retry',reason:'native proof discovery: '+String(error)});}
  for(const record of state.tasks.filter(r=>r.status==='succeeded'&&['qualify','build'].includes(r.spec.kind)&&r.receipt?.ok)){
   const report=record.receipt?.output?.delivery;
   if(!record.runId||!report?.ok||report.id!=='ranged-train'||report.id!==record.spec.capability||report.stage!=='delivered'||report.evidence!=='native'||typeof report.directory!=='string')continue;
   const directory=key(report.directory),prior=candidates.get(directory);
   candidates.set(directory,{...(prior??{directory:report.directory,report,reportSha256:hash(JSON.stringify(report))}),taskId:record.spec.id,runId:record.runId});
  }
  const bindings=new Map<string,{task:DeliveryTask;fingerprint:string;runtime:string}>();
  let imports=0;const deadline=Date.now()+5000;
  for(const row of candidates.values()){
   const identity={directory:row.directory,taskId:row.taskId,runId:row.runId};
   try{
    let binding=bindings.get(row.report.id);
    if(!binding){
     const task=(deps.task??(id=>deliveryTask(join(base,'packages/router/tasks',id+'.json'))))(row.report.id);
     const current=(deps.binding??(task=>({fingerprint:deliveryFingerprint(task,base),runtime:cachedReleaseFor([task.entry],base)})))(task);
     binding={task,...current};bindings.set(row.report.id,binding);
    }
    if(binding.task.id!==row.report.id||binding.fingerprint!==row.report.source||binding.runtime!==row.report.runtimeRevision){results.push({...identity,status:'held',reason:'retained native task, qualification or worker source is not current'});continue;}
    const receiptKey=key(row.directory)+'|'+row.reportSha256+'|'+binding.fingerprint+'|'+binding.runtime,cached=completed.get(receiptKey);
    if(cached&&(deps.indexed??((proof,index)=>indexedProof(base,proof,index)))(cached.proof,cached.index)){
     results.push({...identity,status:'unchanged',reason:'immutable native method proof remains indexed',proof:cached.proof});continue;
    }
    if(imports>=4||Date.now()>deadline){results.push({...identity,status:'retry',reason:'bounded native proof backfill continues on the next pass'});continue;}
    imports++;
    const register:NonNullable<ProgressionProofReconcileDeps['register']>=deps.register??registerAcceptedProgressionDelivery;
    const registered=await register(binding.task,{...row.report,directory:row.directory},base);
    if(registered.proof){if(completed.size>=256&&!completed.has(receiptKey))completed.delete(completed.keys().next().value!);completed.set(receiptKey,{proof:registered.proof,index:registered.index});}
    results.push({...identity,status:registered.registered>0?'registered':'unchanged',reason:'native evidence checked through the shared locked registrar',...(registered.proof?{proof:registered.proof}:{})});
   }catch(error){results.push({...identity,status:'retry',reason:('native method registration: '+String(error)).replace(/[\r\n]+/g,' ').slice(0,300)});}
  }
  return results;
 };
}
