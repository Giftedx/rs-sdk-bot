import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {withPlanWrite,recoverConcurrentPlanWrite} from '../../core/src/plan-lock';
import {atomicJson} from './coordinator-store';
import {validateDelivery,type DeliveryTask} from './delivery';
export interface ProgressionRegistrationOptions {
 base:string;
 practiceRoot?:string;
 additionalProof?:{directory:string;practiceRoot?:string};
 task:DeliveryTask;
 fingerprint:(task:DeliveryTask)=>string;
 runtimeRevision:(task:DeliveryTask)=>string;
 verifyProof:(folder:string,proof:any)=>{checks:Record<string,boolean>};
}
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const record=(v:any)=>v&&typeof v==='object'&&!Array.isArray(v);
const allPassed=(v:any)=>record(v)&&Object.keys(v).length>0&&Object.values(v).every(b=>b===true);
const requireProof=(value:unknown,reason:string)=>{if(!value)throw Error('progression qualification: '+reason);};
const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const within=(root:string,path:string)=>{const p=relative(root,path);return p!==''&&!p.startsWith('..')&&!isAbsolute(p);};

/** Register only the saved method proof accepted by this complete native delivery. Never enables a worker. */
export async function registerProgressionQualification(directory:string,o:ProgressionRegistrationOptions){
 if(o.task.id!=='ranged-train')return{registered:0,index:''};
 validateDelivery(o.task);
 const practice=realpathSync(o.practiceRoot??join(o.base,'.practice'));
 // Artifacts may retain a different machine's absolute paths. Rebind only the
 // recorded .practice suffix into this explicitly selected artifact root.
 const evidencePath=(value:unknown,selectedRoot=practice)=>{
  requireProof(typeof value==='string'&&value.length>0,'missing artifact path');const text=(value as string).replaceAll('\\','/'),anchor=text.lastIndexOf('/.practice/');
  let tail:string;
  if(anchor>=0)tail=text.slice(anchor+'/.practice/'.length);
  else if(text.startsWith('.practice/'))tail=text.slice('.practice/'.length);
  else {const physical=realpathSync(value as string);requireProof(within(selectedRoot,physical),'artifact path is outside its practice root');tail=relative(selectedRoot,physical).replaceAll('\\','/');}
  requireProof(!tail.split('/').some(p=>!p||p==='..'||p==='.')&&!tail.includes(':'),'invalid artifact path');
  const physical=realpathSync(resolve(selectedRoot,tail));requireProof(within(selectedRoot,physical),'artifact symlink leaves its practice root');return physical;
 };
 const reportBytes=readFileSync(join(directory,'report.json')),report=JSON.parse(reportBytes.toString('utf8')),taskBytes=readFileSync(join(directory,'task.json')),task=JSON.parse(taskBytes.toString('utf8'));
 requireProof(same(task,o.task),'native task differs from the current contract');
 requireProof(report.ok===true&&report.stage==='delivered'&&report.evidence==='native'&&report.id===task.id&&!report.diagnostic&&!report.hostDeferred&&!report.failedCheck,'native delivery is not complete and accepted');
 requireProof(realpathSync(directory)===evidencePath(report.directory),'native directory differs');
 requireProof(digest(report.source)&&report.source===o.fingerprint(task),'native delivery source differs');
 requireProof(digest(report.runtimeRevision)&&report.runtimeRevision===o.runtimeRevision(task),'native worker runtime differs');
 requireProof(Number.isSafeInteger(report.at)&&report.at>0&&report.at<=Date.now(),'invalid native completion time');
 requireProof(Array.isArray(report.checks)&&report.checks.length===task.checks.length&&report.checks.every((r:any,i:number)=>r.id===task.checks[i].id&&r.phase===task.checks[i].phase&&r.exitCode===0&&(r.timedOut===undefined||r.timedOut===false)),'native checks are incomplete or failed');
 requireProof(Array.isArray(report.files)&&report.files.length===task.files.length&&report.files.every((f:any,i:number)=>f.path===task.files[i]&&digest(f.sha256)&&f.sha256===hash(readFileSync(join(o.base,f.path)))),'declared native source files differ');
 const checkArtifacts:{file:string;name:string;bytes:Buffer}[]=[];
 for(const [i,row]of report.checks.entries()){
  const detail=JSON.parse(row.detail);requireProof(evidencePath(detail.stdout)===realpathSync(join(directory,i+'.out.log'))&&evidencePath(detail.stderr)===realpathSync(join(directory,i+'.err.log')),'native check log is detached');
  for(const kind of ['out','err']){const file=join(directory,i+'.'+kind+'.log');checkArtifacts.push({file,name:'checks/'+i+'.'+kind+'.log',bytes:readFileSync(file)});}
 }
 const readMethod=(folder:string,original:boolean)=>{
  const artifacts=Object.fromEntries(['proof.json','entry.json','worker.log','before.sav','after.sav'].map(name=>[name,readFileSync(join(folder,name))]));
  const proofBytes=artifacts['proof.json']!,proof=JSON.parse(proofBytes.toString('utf8'));
  const required=['exit','result','exactEntry','xp','bank','assets','arrows','coins','accounting','health','logout','persisted','timeout','source'];
  requireProof(proof.ok===true&&proof.code===0&&proof.mode==='adaptive'&&Number.isSafeInteger(proof.target)&&proof.target>=1&&proof.target<=99&&allPassed(proof.checks)&&required.every(k=>proof.checks[k]===true)&&proof.result?.ok===true&&proof.result.targetMet===true&&Number.isSafeInteger(proof.result.finalLevel)&&proof.result.finalLevel>=proof.target&&proof.result.xpGain>0,'method proof is incomplete');
  requireProof(proof.source===report.runtimeRevision&&digest(proof.proofSource)&&digest(proof.entrySha256)&&Number.isSafeInteger(proof.at)&&proof.at>0&&proof.at<=Date.now()&&(!original||proof.at<=report.at&&report.at-proof.at<900000),'method proof source or completion time differs');
  requireProof(hash(readFileSync(join(folder,'entry.json')))===proof.entrySha256,'frozen entry hash differs');
  requireProof(Array.isArray(proof.supportedMethods)&&proof.supportedMethods.length>0&&proof.supportedMethods.every((m:any)=>['ranged/chickens','ranged/troopers'].includes(m.id)&&m.source===proof.source&&Array.isArray(m.bands)&&m.bands.length>0),'method proof has no supported source/state band');
  return{folder,proofBytes,proof,artifacts};
 };
 const pointerBytes=readFileSync(join(directory,'ranged-adaptive-proof.json'));
 const original=readMethod(evidencePath(JSON.parse(pointerBytes.toString('utf8')).folder),true);
 const saved=task.checks.findIndex((c:any)=>c.id==='adaptive-ranged-saved'&&c.phase==='consumer');requireProof(saved>=0,'saved method verifier is not declared');
 const lines=checkArtifacts.find(a=>a.name==='checks/'+saved+'.out.log')!.bytes.toString('utf8').split(/\r?\n/).filter(l=>l.startsWith('RANGED_SAVED_PROOF '));requireProof(lines.length===1,'saved method verifier result is missing or ambiguous');
 const accepted=JSON.parse(lines[0]!.slice('RANGED_SAVED_PROOF '.length));requireProof(accepted.ok===true&&allPassed(accepted.checks)&&accepted.checks.fresh===true&&accepted.checks.source===true&&accepted.checks.proofSource===true&&accepted.checks.entryHash===true&&evidencePath(accepted.evidence)===original.folder,'saved verifier did not accept this exact method artifact');
 requireProof(allPassed(o.verifyProof(original.folder,original.proof).checks),'current raw method proof verification failed');
 const candidate=o.additionalProof?readMethod(evidencePath(o.additionalProof.directory,realpathSync(o.additionalProof.practiceRoot??practice)),false):original;
 if(o.additionalProof){
  requireProof(candidate.proof.proofSource===original.proof.proofSource,'additional method verifier source differs');
  requireProof(allPassed(o.verifyProof(candidate.folder,candidate.proof).checks),'additional raw method proof verification failed');
 }
 const{folder,proofBytes,proof}=candidate;
 // The existing runtime reader still enforces source equality and live state
 // bands. Only immutable copies reached by a fully checked native delivery enter it.
 const system=join(o.base,'.practice/progression-system'),index=join(system,'qualifications.json'),proofHash=hash(proofBytes),destination=join(system,'proofs',proofHash,'proof.json');
 return withPlanWrite(()=>{
  requireProof(report.source===o.fingerprint(task)&&report.runtimeRevision===o.runtimeRevision(task),'source changed before proof publication');
  requireProof(hash(readFileSync(join(directory,'report.json')))===hash(reportBytes)&&hash(readFileSync(join(directory,'task.json')))===hash(taskBytes),'native acceptance changed before proof publication');
  requireProof(hash(readFileSync(join(directory,'ranged-adaptive-proof.json')))===hash(pointerBytes),'accepted native pointer changed before proof publication');
  for(const artifact of checkArtifacts)requireProof(hash(readFileSync(artifact.file))===hash(artifact.bytes),'native check log changed before proof publication');
  for(const artifact of original===candidate?[candidate]:[original,candidate])for(const[name,bytes]of Object.entries(artifact.artifacts))requireProof(hash(readFileSync(join(artifact.folder,name)))===hash(bytes),'native artifact changed before proof publication: '+name);
  let previous:any={proofs:[]};if(existsSync(index))previous=json(index);
  requireProof(record(previous)&&Array.isArray(previous.proofs)&&previous.proofs.every((r:any)=>record(r)&&typeof r.path==='string'&&digest(r.sha256)),'existing qualification index is invalid; retained');
  const ref={path:resolve(destination),sha256:proofHash},found=previous.proofs.some((r:any)=>r.path===ref.path&&r.sha256===ref.sha256);
  mkdirSync(join(system,'proofs',proofHash),{recursive:true});
  const immutable=(name:string,data:Buffer)=>{const path=join(system,'proofs',proofHash,name);mkdirSync(dirname(path),{recursive:true});if(existsSync(path))requireProof(hash(readFileSync(path))===hash(data),'immutable accepted artifact differs: '+name);else writeFileSync(path,data,{flag:'wx'});};
  immutable('proof.json',proofBytes);immutable('delivery.json',reportBytes);immutable('task.json',taskBytes);immutable('entry.json',readFileSync(join(folder,'entry.json')));
  for(const[name,bytes]of Object.entries(candidate.artifacts))immutable(name,bytes);
  if(o.additionalProof){for(const[name,bytes]of Object.entries(original.artifacts))immutable('native-'+name,bytes);}
  immutable('ranged-adaptive-proof.json',pointerBytes);
  for(const artifact of checkArtifacts)immutable(artifact.name,artifact.bytes);
  immutable('binding.json',Buffer.from(JSON.stringify({nativeProofSha256:hash(original.proofBytes),additionalBand:!!o.additionalProof,nativeReportSha256:hash(reportBytes),checks:Object.fromEntries(checkArtifacts.map(a=>[a.name,hash(a.bytes)]))})));
  if(!found)atomicJson(index,{...previous,proofs:[...previous.proofs,ref]});
  return{registered:found?0:1,index,proof:ref,methods:proof.supportedMethods.map((m:any)=>m.id),source:proof.source,nativeSource:report.source};
 },system,15000,dir=>recoverConcurrentPlanWrite(dir));
}
