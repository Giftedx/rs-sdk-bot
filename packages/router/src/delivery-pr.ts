// Delivery to master (docs/script-contract.md "Deliver a capability"). publishWorkspace writes a build's files into the
// main checkout as uncommitted edits; this step commits exactly those files to `coordinator/<task id>` from current
// master and opens a pull request. The worker only stages the request; the coordinator opens it apart from the
// dispatch loop and retries a failure later, so a git or gh failure never holds live delivery. Nothing here pushes
// master, force-pushes or merges.
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,copyFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {atomicJson} from './coordinator-store';

export interface DeliveryPr{
 taskId:string;capability:string;branch:string;files:string[];snapshot:string;title:string;body:string;
 createdAt:number;attempts:number;nextAt:number;state:'pending'|'opened'|'empty';url?:string;lastError?:string;
}
export type Run=(cmd:string[],cwd:string)=>Promise<{code:number;stdout:string;stderr:string}>;

export const deliveryPrDir=(coordinationDir:string)=>join(coordinationDir,'delivery-prs');
export const deliveryBranch=(taskId:string)=>{if(!/^[-a-z0-9]+$/.test(taskId))throw Error('delivery: invalid task id');return 'coordinator/'+taskId;};
// Live state and run output never go to master.
export const committable=(file:string)=>!!file&&file!=='swarm.json'&&!file.startsWith('.practice/')&&!isAbsolute(file)&&!file.includes('\\')&&!file.split('/').includes('..');
// Retry after 2, 4, 8 ... minutes, at most one hour apart.
export const retryDelayMs=(attempts:number)=>Math.min(60,2**attempts)*60000;

const COMMAND_MS=120000;
export const spawnRun:Run=async(cmd,cwd)=>{
 const child=Bun.spawn(cmd,{cwd,stdout:'pipe',stderr:'pipe',windowsHide:true});
 const timer=setTimeout(()=>child.kill(),COMMAND_MS);
 try{
  const [stdout,stderr]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text()]);
  return{code:await child.exited,stdout,stderr};
 }finally{clearTimeout(timer);}
};

export function prBody(input:{taskId:string;capability:string;files:string[];runDir:string;result:any}):string{
 const r=input.result??{},d=r.delivery??{};
 const qualification={stage:d.stage,ok:d.ok,source:d.source,runtimeRevision:d.runtimeRevision,directory:d.directory,at:d.at};
 const review=r.review?.deferred?{deferred:true,reason:r.review.reason,followUp:input.taskId+'-review'}:r.review?{approved:r.review.approved,reason:r.review.reason,gate:r.gate}:null;
 return [
  `Coordinator delivery of \`${input.capability}\`, build task \`${input.taskId}\`.`,'',
  'The coordinator published these files into the main checkout after qualification and review. This PR carries exactly those files from current master.','',
  '## Files',...input.files.map(f=>'- `'+f+'`'),...(r.published?.merged?.length?['','Merged onto an earlier delivery: '+r.published.merged.map((f:string)=>'`'+f+'`').join(', ')]:[]),'',
  '## Qualification receipt','```json',JSON.stringify(qualification,null,1),'```','',
  '## Review receipt','```json',JSON.stringify(review,null,1),'```','',
  'Run folder: `'+input.runDir+'`',
 ].join('\n');
}

// Copies the delivered files from the main checkout into the run folder and records the pull request to open. The copy
// is what the PR commits, so a later publish of the same file does not change this delivery's content.
export function stageDeliveryPr(input:{mainRoot:string;runDir:string;coordinationDir:string;taskId:string;capability:string;files:string[];result:any;now?:number}):DeliveryPr|null{
 const files=input.files.filter(committable);
 if(!files.length)return null;
 const snapshot=join(input.runDir,'delivered');
 for(const f of files){const to=join(snapshot,f);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(input.mainRoot,f),to);}
 const now=input.now??Date.now();
 const pr:DeliveryPr={taskId:input.taskId,capability:input.capability,branch:deliveryBranch(input.taskId),files,snapshot,
  title:`coordinator: deliver ${input.capability} (${input.taskId})`,body:prBody({...input,files}),createdAt:now,attempts:0,nextAt:now,state:'pending'};
 const dir=deliveryPrDir(input.coordinationDir);mkdirSync(dir,{recursive:true});atomicJson(join(dir,input.taskId+'.json'),pr);
 return pr;
}

const must=async(run:Run,cmd:string[],cwd:string)=>{
 const out=await run(cmd,cwd);
 if(out.code!==0)throw Error(cmd.slice(0,3).join(' ')+' failed ('+out.code+'): '+(out.stderr||out.stdout).trim().slice(-400));
 return out.stdout;
};
// Opens one staged delivery. If the branch already exists on the remote, it opens the PR from it without a push.
export async function openDeliveryPr(pr:DeliveryPr,mainRoot:string,run:Run=spawnRun,parent=tmpdir()):Promise<{state:'opened'|'empty';url?:string}>{
 const listed=await run(['gh','pr','list','--head',pr.branch,'--state','all','--json','url','--jq','.[0].url'],mainRoot);
 if(listed.code===0&&listed.stdout.trim())return{state:'opened',url:listed.stdout.trim()};
 const remote=await must(run,['git','ls-remote','--heads','origin','refs/heads/'+pr.branch],mainRoot);
 const work=mkdtempSync(join(parent,'delivery-')),tree=join(work,'tree');
 try{
  if(!remote.trim()){
   await must(run,['git','fetch','origin','master'],mainRoot);
   await must(run,['git','worktree','add','--detach',tree,'origin/master'],mainRoot);
   try{
    for(const f of pr.files){const to=join(tree,f);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(pr.snapshot,f),to);}
    await must(run,['git','add','--',...pr.files],tree);
    if((await run(['git','diff','--cached','--quiet'],tree)).code===0)return{state:'empty'};
    await must(run,['git','commit','-m',pr.title,'-m','Delivered files of build task '+pr.taskId+' as published into the main checkout.'],tree);
    await must(run,['git','push','origin','HEAD:refs/heads/'+pr.branch],tree);
   }finally{await run(['git','worktree','remove','--force',tree],mainRoot);}
  }
  const body=join(work,'body.md');writeFileSync(body,pr.body);
  const url=(await must(run,['gh','pr','create','--base','master','--head',pr.branch,'--title',pr.title,'--body-file',body],mainRoot)).trim().split(/\r?\n/).at(-1);
  return{state:'opened',url};
 }finally{rmSync(work,{recursive:true,force:true});}
}

// Opens every staged delivery that is due. A failure stays pending with a later retry time.
export async function processDeliveryPrs(coordinationDir:string,mainRoot:string,run:Run=spawnRun,now=Date.now(),parent=tmpdir()){
 const dir=deliveryPrDir(coordinationDir),opened:DeliveryPr[]=[],failed:DeliveryPr[]=[];
 if(!existsSync(dir))return{opened,failed};
 for(const name of readdirSync(dir).filter(n=>n.endsWith('.json')).sort()){
  const file=join(dir,name);let pr:DeliveryPr;
  try{pr=JSON.parse(readFileSync(file,'utf8'));}catch{continue;}
  if(pr.state!=='pending'||pr.nextAt>now)continue;
  try{const out=await openDeliveryPr(pr,mainRoot,run,parent);pr={...pr,state:out.state,url:out.url,attempts:pr.attempts+1};delete pr.lastError;opened.push(pr);}
  catch(error){pr={...pr,attempts:pr.attempts+1,lastError:String(error),nextAt:now+retryDelayMs(pr.attempts+1)};failed.push(pr);}
  atomicJson(file,pr);
 }
 return{opened,failed};
}
