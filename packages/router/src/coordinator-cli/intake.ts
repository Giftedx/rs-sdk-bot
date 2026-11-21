import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync} from 'node:fs';
import {basename,join} from 'node:path';
import {assertBoundedRecoveryQueue,validateBoundedRecovery} from '../../../core/src/bounded-recovery';
import {ownerPlanPath,readMergedPlan} from '../../../core/src/coordinator-jobs';
import type {CoordinatorState} from '../coordinator';
import {finishPlan} from '../coordinator-decisions';
import {prepareProposal} from '../coordinator-planner';
import {atomicText,event,projectRoot,publishCapabilityChanges,runDirectory,saveState} from '../coordinator-store';
import {plannerHolds,readJson} from './holds';

const submissionDigest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

function acknowledgeSubmission(state:CoordinatorState,base:string,publish:typeof publishCapabilityChanges,move=renameSync){
 const pending=state.pendingSubmission;
 if(!pending)return;
 const directory=join(base,'.practice/coordinator'),{sha256,capabilities}=pending;
 if('file' in pending){
  const {file}=pending;
  if(typeof file!=='string'||basename(file)!==file||!file.endsWith('.request.json'))throw Error('invalid pending submission name');
  const path=join(directory,'requests',file),accepted=path+'.accepted';
  const alreadyAccepted=existsSync(accepted);
  if(alreadyAccepted&&existsSync(path))throw Error('duplicate pending and accepted submission: '+file);
  if(submissionDigest(readFileSync(alreadyAccepted?accepted:path))!==sha256)throw Error('pending submission bytes changed: '+file);
  if(!alreadyAccepted){
   publish(base,capabilities);
   move(path,accepted);
   event('queue-submitted',{file},directory);
  }
 }else{
  const {runId,count}=pending,dir=runDirectory(runId,directory),accepted=join(dir,'plan-accepted.json');
  if(submissionDigest(readFileSync(join(dir,'proposal.json')))!==sha256)throw Error('pending model proposal bytes changed: '+runId);
  const receipt=JSON.stringify({runId,sha256,count},null,2);
  if(existsSync(accepted)){
   if(readFileSync(accepted,'utf8')!==receipt)throw Error('model acknowledgement bytes changed: '+runId);
  }else{
   publish(base,capabilities);
   atomicText(accepted,receipt);
   event('plan-accepted',{runId,count,reason:state.lastPlanReason},directory);
  }
 }
 delete state.pendingSubmission;
}

export function intakeRequests(state:CoordinatorState,base=projectRoot,{save=saveState,move=renameSync,publish=publishCapabilityChanges}={}){
 const directory=join(base,'.practice/coordinator'),requests=join(directory,'requests');mkdirSync(requests,{recursive:true});
 // Recover before reading another request or dispatching from the committed queue.
 acknowledgeSubmission(state,base,publish,move);
 for(const file of readdirSync(requests).filter(f=>f.endsWith('.request.json'))){
  const path=join(requests,file),bytes=readFileSync(path);
  let prepared:ReturnType<typeof prepareProposal>;
  try{
   prepared=prepareProposal(state,JSON.parse(bytes.toString('utf8')),base);
   const scope=existsSync(ownerPlanPath(base))?readMergedPlan(base).coordination?.boundedRecovery:undefined;
   if(scope){if(prepared.capabilities.length)throw Error('bounded recovery refuses capability publication');assertBoundedRecoveryQueue(validateBoundedRecovery(scope),prepared.candidate);}
  }
  catch(error){
   if(typeof (error as NodeJS.ErrnoException)?.code==='string')throw error;
   move(path,path+'.rejected');
   event('queue-submit-failed',{file,error:String(error)},directory);
   continue;
  }
  const {candidate,capabilities}=prepared;
  candidate.pendingSubmission={file,sha256:submissionDigest(bytes),capabilities};
  save(candidate,directory);
  Object.assign(state,candidate);
  acknowledgeSubmission(state,base,publish,move);
 }
}

export function settlePlanner(state:CoordinatorState,base=projectRoot,{save=saveState,publish=publishCapabilityChanges,holds=plannerHolds}={}){
 acknowledgeSubmission(state,base,publish);
 if(!state.planner)return;
 const directory=join(base,'.practice/coordinator');
 const {runId,pid}=state.planner,dir=runDirectory(runId,directory),proposal=join(dir,'proposal.json'),error=join(dir,'planner-error.json');
 const hasProposal=existsSync(proposal),hasError=existsSync(error);
 if(!hasProposal&&!hasError&&pid&&holds(pid,runId))return;
 let bytes:Buffer,prepared:ReturnType<typeof prepareProposal>;
 try{
  if(!hasProposal)throw Error(hasError?readJson(error).error:'planner ended without proposal');
  bytes=readFileSync(proposal);
  prepared=prepareProposal(state,JSON.parse(bytes.toString('utf8')),base,'model');
 }catch(error){
  if(typeof (error as NodeJS.ErrnoException)?.code==='string')throw error;
  // A refused proposal stays on disk. A planner that ended with no proposal leaves nothing to correct.
  const failed={...state,lastPlanReason:'planner failed: '+String(error),...(hasProposal?{rejectedPlan:{runId,error:String(error)}}:{})};
  finishPlan(failed,Date.now(),false);
  save(failed,directory);
  Object.assign(state,failed);
  delete state.planner;
  event('plan-failed',String(error),directory);
  return;
 }
 const {candidate,capabilities,count}=prepared;
 finishPlan(candidate,Date.now(),true);
 candidate.pendingSubmission={runId,count,sha256:submissionDigest(bytes),capabilities};
 save(candidate,directory);
 Object.assign(state,candidate);
 // Object.assign copies keys. It does not remove the keys that finishPlan deleted from the candidate.
 delete state.planner;
 delete state.planFailures;
 delete state.rejectedPlan;
 acknowledgeSubmission(state,base,publish);
}
