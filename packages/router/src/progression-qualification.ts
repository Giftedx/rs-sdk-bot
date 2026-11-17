import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,lstatSync,openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
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
const within=(root:string,path:string)=>{const p=relative(root,path);return p!==''&&!p.startsWith('..')&&!isAbsolute(p);};
const MiB=1024*1024;
const artifactLimit=(name:string)=>name.endsWith('.log')?16*MiB:name.endsWith('.sav')?4*MiB:name==='ranged-adaptive-proof.json'?4096:MiB;
/** Read only a bounded regular file reached within its declared folder and selected physical artifact root. */
function artifactBytes(folder:string,name:string,root:string,limit=artifactLimit(name)){
 const physicalFolder=realpathSync(folder);requireProof(within(root,physicalFolder),'artifact folder leaves its selected practice root');
 const file=realpathSync(join(physicalFolder,name));requireProof(within(physicalFolder,file)&&within(root,file),'artifact file leaves its declared folder or practice root');
 const flags=constants.O_RDONLY|(process.platform==='win32'?0:(constants.O_NONBLOCK??0)|(constants.O_NOFOLLOW??0));
 const fd=openSync(file,flags);
 try{
  const stat=fstatSync(fd);requireProof(stat.isFile(),'artifact is not a regular file');
  requireProof(Number.isSafeInteger(stat.size)&&stat.size>=0&&stat.size<=limit,'artifact exceeds its bounded size limit');
  const bytes=Buffer.alloc(stat.size);let offset=0;
  while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,null);requireProof(n>0,'artifact changed during bounded read');offset+=n;}
  requireProof(readSync(fd,Buffer.alloc(1),0,1,null)===0,'artifact changed during bounded read');return bytes;
 }finally{closeSync(fd);}
}
/** Check existing ancestors before mkdir/atomicJson can follow a junction, including missing destination files. */
function outputPath(root:string,path:string){
 const target=resolve(path);requireProof(target===root||within(root,target),'output leaves its physical practice root');
 let probe=target;
 for(;;){
  try{lstatSync(probe);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(probe);requireProof(parent!==probe,'output has no physical practice root');probe=parent;continue;}
  const physical=realpathSync(probe);requireProof(physical===root||within(root,physical),'output symlink leaves its physical practice root');return target;
 }
}

/** Register only the saved method proof accepted by this complete native delivery. Never enables a worker. */
export async function registerProgressionQualification(directory:string,o:ProgressionRegistrationOptions){
 if(o.task.id!=='ranged-train')return{registered:0,index:''};
 validateDelivery(o.task);
 const practice=realpathSync(o.practiceRoot??join(o.base,'.practice'));
 directory=realpathSync(directory);requireProof(within(practice,directory),'artifact delivery folder leaves its selected practice root');
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
 const reportBytes=artifactBytes(directory,'report.json',practice),report=JSON.parse(reportBytes.toString('utf8')),taskBytes=artifactBytes(directory,'task.json',practice),task=JSON.parse(taskBytes.toString('utf8'));
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
  for(const kind of ['out','err']){const name=i+'.'+kind+'.log',file=join(directory,name);checkArtifacts.push({file,name:'checks/'+name,bytes:artifactBytes(directory,name,practice)});}
 }
 const readMethod=(folder:string,original:boolean,selectedRoot=practice)=>{
  const artifacts=Object.fromEntries(['proof.json','entry.json','worker.log','before.sav','after.sav'].map(name=>[name,artifactBytes(folder,name,selectedRoot)]));
  const proofBytes=artifacts['proof.json']!,proof=JSON.parse(proofBytes.toString('utf8'));
  const required=['exit','result','exactEntry','xp','bank','assets','arrows','coins','accounting','health','logout','persisted','timeout','source'];
  requireProof(proof.ok===true&&proof.code===0&&proof.mode==='adaptive'&&Number.isSafeInteger(proof.target)&&proof.target>=1&&proof.target<=99&&allPassed(proof.checks)&&required.every(k=>proof.checks[k]===true)&&proof.result?.ok===true&&proof.result.targetMet===true&&Number.isSafeInteger(proof.result.finalLevel)&&proof.result.finalLevel>=proof.target&&proof.result.xpGain>0,'method proof is incomplete');
  requireProof(proof.source===report.runtimeRevision&&digest(proof.proofSource)&&digest(proof.entrySha256)&&Number.isSafeInteger(proof.at)&&proof.at>0&&proof.at<=Date.now()&&(!original||proof.at<=report.at&&report.at-proof.at<900000),'method proof source or completion time differs');
  requireProof(hash(artifacts['entry.json']!)===proof.entrySha256,'frozen entry hash differs');
  requireProof(Array.isArray(proof.supportedMethods)&&proof.supportedMethods.length>0&&proof.supportedMethods.every((m:any)=>['ranged/chickens','ranged/troopers'].includes(m.id)&&m.source===proof.source&&Array.isArray(m.bands)&&m.bands.length>0),'method proof has no supported source/state band');
  return{folder,proofBytes,proof,artifacts,selectedRoot};
 };
 const pointerBytes=artifactBytes(directory,'ranged-adaptive-proof.json',practice);
 const original=readMethod(evidencePath(JSON.parse(pointerBytes.toString('utf8')).folder),true);
 const saved=task.checks.findIndex((c:any)=>c.id==='adaptive-ranged-saved'&&c.phase==='consumer');requireProof(saved>=0,'saved method verifier is not declared');
 const lines=checkArtifacts.find(a=>a.name==='checks/'+saved+'.out.log')!.bytes.toString('utf8').split(/\r?\n/).filter(l=>l.startsWith('RANGED_SAVED_PROOF '));requireProof(lines.length===1,'saved method verifier result is missing or ambiguous');
 const accepted=JSON.parse(lines[0]!.slice('RANGED_SAVED_PROOF '.length));requireProof(accepted.ok===true&&allPassed(accepted.checks)&&accepted.checks.fresh===true&&accepted.checks.source===true&&accepted.checks.proofSource===true&&accepted.checks.entryHash===true&&evidencePath(accepted.evidence)===original.folder,'saved verifier did not accept this exact method artifact');
 requireProof(allPassed(o.verifyProof(original.folder,original.proof).checks),'current raw method proof verification failed');
 const additionalRoot=o.additionalProof?realpathSync(o.additionalProof.practiceRoot??practice):practice;
 const candidate=o.additionalProof?readMethod(evidencePath(o.additionalProof.directory,additionalRoot),false,additionalRoot):original;
 if(o.additionalProof){
  requireProof(candidate.proof.proofSource===original.proof.proofSource,'additional method verifier source differs');
  requireProof(allPassed(o.verifyProof(candidate.folder,candidate.proof).checks),'additional raw method proof verification failed');
 }
 const{folder,proofBytes,proof}=candidate;
 // The existing runtime reader still enforces source equality and live state
 // bands. Only immutable copies reached by a fully checked native delivery enter it.
 const outputRoot=realpathSync(join(o.base,'.practice'));
 const system=outputPath(outputRoot,join(outputRoot,'progression-system')),index=outputPath(outputRoot,join(system,'qualifications.json')),proofHash=hash(proofBytes),destination=outputPath(outputRoot,join(system,'proofs',proofHash,'proof.json'));
 return withPlanWrite(()=>{
  requireProof(report.source===o.fingerprint(task)&&report.runtimeRevision===o.runtimeRevision(task),'source changed before proof publication');
  outputPath(outputRoot,system);outputPath(outputRoot,index);outputPath(outputRoot,destination);outputPath(outputRoot,index+'.tmp-'+process.pid);
  requireProof(hash(artifactBytes(directory,'report.json',practice))===hash(reportBytes)&&hash(artifactBytes(directory,'task.json',practice))===hash(taskBytes),'native acceptance changed before proof publication');
  requireProof(hash(artifactBytes(directory,'ranged-adaptive-proof.json',practice))===hash(pointerBytes),'accepted native pointer changed before proof publication');
  for(const artifact of checkArtifacts)requireProof(hash(artifactBytes(directory,artifact.name.slice('checks/'.length),practice))===hash(artifact.bytes),'native check log changed before proof publication');
  for(const artifact of original===candidate?[candidate]:[original,candidate])for(const[name,bytes]of Object.entries(artifact.artifacts))requireProof(hash(artifactBytes(artifact.folder,name,artifact.selectedRoot))===hash(bytes),'native artifact changed before proof publication: '+name);
  let previous:any={proofs:[]};if(existsSync(index))previous=JSON.parse(artifactBytes(system,'qualifications.json',outputRoot,4*MiB).toString('utf8'));
  requireProof(record(previous)&&Array.isArray(previous.proofs)&&previous.proofs.every((r:any)=>record(r)&&typeof r.path==='string'&&digest(r.sha256)),'existing qualification index is invalid; retained');
  const ref={path:resolve(destination),sha256:proofHash},found=previous.proofs.some((r:any)=>r.path===ref.path&&r.sha256===ref.sha256);
  const bundle=outputPath(outputRoot,join(system,'proofs',proofHash));mkdirSync(bundle,{recursive:true});
  const immutable=(name:string,data:Buffer)=>{
   requireProof(data.length<=artifactLimit(name),'artifact exceeds its bounded output size limit');
   const path=outputPath(outputRoot,join(bundle,name));mkdirSync(dirname(path),{recursive:true});outputPath(outputRoot,path);
   if(existsSync(path))requireProof(hash(artifactBytes(bundle,name,outputRoot))===hash(data),'immutable accepted artifact differs: '+name);else writeFileSync(path,data,{flag:'wx'});
  };
  immutable('proof.json',proofBytes);immutable('delivery.json',reportBytes);immutable('task.json',taskBytes);immutable('entry.json',candidate.artifacts['entry.json']!);
  for(const[name,bytes]of Object.entries(candidate.artifacts))immutable(name,bytes);
  if(o.additionalProof){for(const[name,bytes]of Object.entries(original.artifacts))immutable('native-'+name,bytes);}
  immutable('ranged-adaptive-proof.json',pointerBytes);
  for(const artifact of checkArtifacts)immutable(artifact.name,artifact.bytes);
  immutable('binding.json',Buffer.from(JSON.stringify({nativeProofSha256:hash(original.proofBytes),additionalBand:!!o.additionalProof,nativeReportSha256:hash(reportBytes),checks:Object.fromEntries(checkArtifacts.map(a=>[a.name,hash(a.bytes)]))})));
  if(!found){outputPath(outputRoot,index);outputPath(outputRoot,index+'.tmp-'+process.pid);atomicJson(index,{...previous,proofs:[...previous.proofs,ref]});}
  return{registered:found?0:1,index,proof:ref,methods:proof.supportedMethods.map((m:any)=>m.id),source:proof.source,nativeSource:report.source};
 },system,15000,dir=>recoverConcurrentPlanWrite(dir));
}
