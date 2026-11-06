// Delivery to master (docs/script-contract.md "Deliver a capability"). publishWorkspace writes a build's files into the
// main checkout as uncommitted edits; this step commits the build's change to those files to `coordinator/<task id>`
// from current master and opens a pull request. The worker only stages the request; the coordinator opens it apart
// from the dispatch loop and retries a failure later, so a git or gh failure never holds live delivery. Nothing here
// pushes master, force-pushes or merges.
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,copyFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {atomicJson,capabilityDefinitionTransition} from './coordinator-store';
import {BASE_DIR,fileHash,mergeText,type WorkspaceBase} from './build-workspace';
import {deliveryFingerprint,importClosure} from './delivery-cli';
import {releaseFiles,workerLaunchers} from '../../core/src/worker-release';

export interface DeliveryPr{
 taskId:string;capability:string;branch:string;files:string[];snapshot:string;base:string;title:string;body:string;
 // Earlier deliveries that this build's source already held when it started; the PR opens after they merge.
 prerequisites:string[];
 createdAt:number;attempts:number;nextAt:number;state:'pending'|'opened'|'empty'|'conflict';url?:string;lastError?:string;
 definitionBase?:string|null;
 mergeVersion?:number;
}
export type Run=(cmd:string[],cwd:string)=>Promise<{code:number;stdout:string;stderr:string}>;

export const deliveryPrDir=(coordinationDir:string)=>join(coordinationDir,'delivery-prs');
export const deliveryBranch=(taskId:string)=>{if(!/^[-a-z0-9]+$/.test(taskId))throw Error('delivery: invalid task id');return 'coordinator/'+taskId;};
// Live state and run output never go to master.
export const committable=(file:string)=>!!file&&file!=='swarm.json'&&!file.startsWith('.practice/')&&!isAbsolute(file)&&!file.includes('\\')&&!file.split('/').includes('..');
// Retry after 2, 4, 8 ... minutes, at most one hour apart. A wait for a prerequisite checks again every 5 minutes.
export const retryDelayMs=(attempts:number)=>Math.min(60,2**attempts)*60000;
export const PREREQUISITE_WAIT_MS=5*60000;
class DeliveryWait extends Error{}
class DeliveryConflict extends Error{}
const MERGE_VERSION=1;

const COMMAND_MS=120000;
export const spawnRun:Run=async(cmd,cwd)=>{
 const child=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>child.kill(),COMMAND_MS);
 try{
  const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return{code:await child.exited,stdout,stderr};
 }finally{clearTimeout(timer);}
};

export function prBody(input:{taskId:string;capability:string;files:string[];prerequisites:string[];runDir:string;result:any}):string{
 const r=input.result??{},d=r.delivery??{};
 const qualification={stage:d.stage,ok:d.ok,source:d.source,runtimeRevision:d.runtimeRevision,directory:d.directory,at:d.at};
 const review=r.review?.deferred?{deferred:true,reason:r.review.reason,followUp:input.taskId+'-review'}:r.review?{approved:r.review.approved,reason:r.review.reason,gate:r.gate}:null;
 return [
  `Coordinator delivery of \`${input.capability}\`, build task \`${input.taskId}\`.`,'',
  'The coordinator published these files into the main checkout after qualification and review. This PR applies the build\'s change to them onto current master.','',
  '## Files',...input.files.map(f=>'- `'+f+'`'),'',
  ...(input.prerequisites.length?['Opened after these earlier deliveries merged: '+input.prerequisites.map(id=>'`'+deliveryBranch(id)+'`').join(', '),'']:[]),
  '## Qualification receipt','```json',JSON.stringify(qualification,null,1),'```','',
  '## Review receipt','```json',JSON.stringify(review,null,1),'```','',
  'Run folder: `'+input.runDir+'`',
 ].join('\n');
}

// Every file the build's source can run: the capability release of its entry, which follows literal worker paths a
// worker starts as a subprocess, plus the import closure of its owned files and tests.
export function deliverySourceSet(entry:string,files:readonly string[],root:string):string[]{
 let release:string[]=[];try{release=releaseFiles([entry,...workerLaunchers],root);}catch{/* an unreleasable entry keeps the import closure */}
 return [...new Set([...release,...importClosure([entry,...files],root)])].sort();
}

const readRecords=(dir:string):DeliveryPr[]=>existsSync(dir)?readdirSync(dir).filter(n=>n.endsWith('.json')).flatMap(n=>{try{return[JSON.parse(readFileSync(join(dir,n),'utf8'))];}catch{return[];}}):[];

// Copies the build's version of each published file and the bytes it started from into the run folder, and records
// the pull request to open. The PR applies base -> build onto master, so a later publish of the same file or a newer
// master never changes what this delivery claims. `sourceSet` is the import closure the build ran; an earlier delivery
// of one of those files that the build's source already held becomes a prerequisite.
export function stageDeliveryPr(input:{workspace:string;runDir:string;coordinationDir:string;taskId:string;capability:string;files:string[];sourceSet:readonly string[];result:any;now?:number}):DeliveryPr|null{
 const files=input.files.filter(committable);
 const snapshot=join(input.runDir,'delivered'),base=join(input.runDir,'delivered-base');
 const definitionFile='packages/router/tasks/'+input.capability+'.json',definitionPath=join(input.workspace,definitionFile);
 const definitionBytes=/^[-a-z0-9]+$/.test(input.capability)&&existsSync(definitionPath)?readFileSync(definitionPath):null;
 const transition=definitionBytes?capabilityDefinitionTransition(input.coordinationDir,input.capability,definitionBytes):undefined;
 if(!files.length&&!transition)return null;
 const meta:WorkspaceBase=JSON.parse(readFileSync(join(input.workspace,'.workspace.json'),'utf8'));
 if(transition){
  const definition=JSON.parse(definitionBytes!.toString('utf8')),proof=input.result?.delivery;
  if(definition.id!==input.capability||proof?.ok!==true||proof.id!==input.capability||proof.source!==deliveryFingerprint(definition,input.workspace))throw Error('capability definition differs from qualified delivery');
 }
 for(const f of files){
  const to=join(snapshot,f);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(input.workspace,f),to);
  const from=join(input.workspace,BASE_DIR,f);
  if(meta.base[f]!==null&&existsSync(from)&&fileHash(from)===meta.base[f]){const out=join(base,f);mkdirSync(dirname(out),{recursive:true});copyFileSync(from,out);}
 }
 const dir=deliveryPrDir(input.coordinationDir),source=new Set(input.sourceSet);
 if(transition){
  const to=join(snapshot,definitionFile);mkdirSync(dirname(to),{recursive:true});writeFileSync(to,definitionBytes!);
  if(transition.prior){const from=join(base,definitionFile);mkdirSync(dirname(from),{recursive:true});writeFileSync(from,transition.prior);}
  files.push(definitionFile);source.add(definitionFile);
 }
 const prerequisites=readRecords(dir).filter(p=>p.taskId!==input.taskId&&p.createdAt<meta.created&&p.state!=='empty'&&p.files.some(f=>source.has(f))).sort((a,b)=>a.createdAt-b.createdAt).map(p=>p.taskId);
 const now=input.now??Date.now();
 const pr:DeliveryPr={taskId:input.taskId,capability:input.capability,branch:deliveryBranch(input.taskId),files,snapshot,base,prerequisites,
  title:`coordinator: deliver ${input.capability} (${input.taskId})`,body:prBody({...input,files,prerequisites}),createdAt:now,attempts:0,nextAt:now,state:'pending',
  ...(transition?{definitionBase:transition.priorHash}:{})};
 mkdirSync(dir,{recursive:true});atomicJson(join(dir,input.taskId+'.json'),pr);
 return pr;
}

const must=async(run:Run,cmd:string[],cwd:string)=>{
 const out=await run(cmd,cwd);
 if(out.code!==0)throw Error(cmd.slice(0,3).join(' ')+' failed ('+out.code+'): '+(out.stderr||out.stdout).trim().slice(-400));
 return out.stdout;
};
// A prerequisite is satisfied when its PR merged or it had nothing to commit.
async function checkPrerequisites(pr:DeliveryPr,dir:string,mainRoot:string,run:Run){
 for(const id of pr.prerequisites??[]){
  const file=join(dir,id+'.json');if(!existsSync(file))continue;
  const before:DeliveryPr=JSON.parse(readFileSync(file,'utf8'));
  if(before.state==='empty')continue;
  if(before.state!=='opened')throw new DeliveryWait('waiting for earlier delivery '+before.branch+' ('+before.state+(before.state==='conflict'?': resolve it by hand':'')+')');
  const state=(await must(run,['gh','pr','view',before.branch,'--json','state','--jq','.state'],mainRoot)).trim();
  if(state!=='MERGED')throw new DeliveryWait('waiting for earlier delivery '+before.branch+' to merge ('+state+')');
 }
}
// The build's change to each file, merged onto master's version in `tree`. Overlapping master edits refuse the PR.
function applyChange(pr:DeliveryPr,tree:string){
 // A request staged before base snapshots existed holds whole files only; copying them could revert master.
 if(typeof pr.base!=='string')throw new DeliveryConflict('delivery was staged without base snapshots; commit '+pr.snapshot+' by hand against origin/master');
 const conflicts:string[]=[];
 // Match the repository's LF checkout policy before git compares lines in Windows snapshots.
 const readText=(path:string)=>readFileSync(path,'utf8').replaceAll('\r\n','\n');
 const merged=pr.files.map(f=>{
  const target=join(tree,f),master=existsSync(target)?readText(target):'';
  const basePath=join(pr.base,f),base=existsSync(basePath)?readText(basePath):'',build=readText(join(pr.snapshot,f));
  if(pr.definitionBase!==undefined&&f==='packages/router/tasks/'+pr.capability+'.json'){
   if(master===build)return[f,build] as const;
   if(fileHash(basePath)!==pr.definitionBase||master!==base){conflicts.push(f+' (qualified definition base differs)');return[f,''] as const;}
   return[f,build] as const;
  }
  if(master===base)return[f,build] as const;
  const out=mergeText(base,master,build);
  if(!out.ok){conflicts.push(f+' ('+out.conflicts.join('; ').replaceAll('main lines','master lines')+')');return[f,''] as const;}
  return[f,out.text] as const;
 });
 if(conflicts.length)throw new DeliveryConflict('delivery conflicts with origin/master: '+conflicts.join(', '));
 for(const [f,text] of merged){mkdirSync(dirname(join(tree,f)),{recursive:true});writeFileSync(join(tree,f),text);}
}
// Opens one staged delivery. If the branch already exists on the remote, it opens the PR from it without a push.
export async function openDeliveryPr(pr:DeliveryPr,mainRoot:string,run:Run=spawnRun,parent=tmpdir(),dir?:string):Promise<{state:'opened'|'empty';url?:string}>{
 const listed=await run(['gh','pr','list','--head',pr.branch,'--state','all','--json','url','--jq','.[0].url'],mainRoot);
 if(listed.code===0&&listed.stdout.trim())return{state:'opened',url:listed.stdout.trim()};
 const remote=await must(run,['git','ls-remote','--heads','origin','refs/heads/'+pr.branch],mainRoot);
 const work=mkdtempSync(join(parent,'delivery-')),tree=join(work,'tree');
 try{
  if(!remote.trim()){
   if(dir)await checkPrerequisites(pr,dir,mainRoot,run);
   await must(run,['git','fetch','origin','master'],mainRoot);
   await must(run,['git','worktree','add','--detach',tree,'origin/master'],mainRoot);
   try{
    applyChange(pr,tree);
    await must(run,['git','add','--',...pr.files],tree);
    if((await run(['git','diff','--cached','--quiet'],tree)).code===0)return{state:'empty'};
    await must(run,['git','commit','-m',pr.title,'-m','Build task '+pr.taskId+': its change to the delivered files, applied onto current master.'],tree);
    await must(run,['git','push','origin','HEAD:refs/heads/'+pr.branch],tree);
   }finally{await run(['git','worktree','remove','--force',tree],mainRoot);}
  }
  const body=join(work,'body.md');writeFileSync(body,pr.body);
  const url=(await must(run,['gh','pr','create','--base','master','--head',pr.branch,'--title',pr.title,'--body-file',body],mainRoot)).trim().split(/\r?\n/).at(-1);
  return{state:'opened',url};
 }finally{rmSync(work,{recursive:true,force:true});}
}

// Only retry conflicts from before LF normalization with complete snapshots and CRLF evidence.
function legacyLineEndingConflict(pr:DeliveryPr):boolean{
 if(typeof pr.base!=='string'||typeof pr.snapshot!=='string'||!Array.isArray(pr.files)||!pr.files.length||!pr.files.every(committable))return false;
 const inputs=pr.files.flatMap(f=>[join(pr.base,f),join(pr.snapshot,f)]);
 try{return inputs.every(f=>existsSync(f))&&inputs.some(f=>readFileSync(f,'utf8').includes('\r\n'));}
 catch{return false;}
}

// Opens every staged delivery that is due, oldest first. A failure stays pending with a later retry time; a wait for a
// prerequisite checks again later without counting as a failure; a conflict with master stops for the owner.
export async function processDeliveryPrs(coordinationDir:string,mainRoot:string,run:Run=spawnRun,now=Date.now(),parent=tmpdir()){
 const dir=deliveryPrDir(coordinationDir),opened:DeliveryPr[]=[],failed:DeliveryPr[]=[],waiting:DeliveryPr[]=[],conflicts:DeliveryPr[]=[];
 for(let pr of readRecords(dir).sort((a,b)=>a.createdAt-b.createdAt||a.taskId.localeCompare(b.taskId))){
  if(pr.nextAt>now)continue;
  if(pr.state==='conflict'&&pr.mergeVersion===undefined&&pr.lastError?.startsWith('delivery conflicts with origin/master: ')){
   pr={...pr,mergeVersion:MERGE_VERSION};
   if(!legacyLineEndingConflict(pr)){atomicJson(join(dir,pr.taskId+'.json'),pr);continue;}
   pr.state='pending';
  }
  if(pr.state!=='pending')continue;
  try{const out=await openDeliveryPr(pr,mainRoot,run,parent,dir);pr={...pr,state:out.state,url:out.url,attempts:pr.attempts+1};delete pr.lastError;opened.push(pr);}
  catch(error){
   if(error instanceof DeliveryWait){pr={...pr,lastError:error.message,nextAt:now+PREREQUISITE_WAIT_MS};waiting.push(pr);}
   else if(error instanceof DeliveryConflict){pr={...pr,state:'conflict',mergeVersion:MERGE_VERSION,attempts:pr.attempts+1,lastError:error.message};conflicts.push(pr);}
   else{pr={...pr,attempts:pr.attempts+1,lastError:String(error),nextAt:now+retryDelayMs(pr.attempts+1)};failed.push(pr);}
  }
  atomicJson(join(dir,pr.taskId+'.json'),pr);
 }
 return{opened,failed,waiting,conflicts};
}
