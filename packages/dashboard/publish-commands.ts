// Commands the hosted control page sends to this PC. Each one is accepted only from the owner's identity, applied once,
// and goes through stop files (.practice/stop-<account>, .practice/stop-swarm), swarm.json under .practice/live's
// plan-write lock, or Brain operator commands (.practice/live/operator-commands/). The main account is never a target.
import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdirSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {withPlanWrite,atomicJson} from '../core/src/plan-lock';
import {findStopFile,listStopEntries,liveRoot,operatorCommandsDir,practiceRoot,stopFilePaths} from '../core/src/practice-paths';
import {mySide} from '../core/src/fleet';
import {defaultActivityCatalog} from '../brain/src/catalog';
import {validateOperatorCommand,type OperatorCommand} from '../brain/src/contracts';
import {MAIN_ACCOUNT} from './publish-relay';
export const NAME_RE=/^[A-Za-z0-9]{1,12}$/;

export const ACTIONS=['account-pause','account-resume','swarm-pause','swarm-resume','side-pause','side-resume','override-account','clear-defect','job-disable','job-enable','request'] as const;
export type Action=typeof ACTIONS[number];
const ACTION_SET=new Set<string>(ACTIONS);
export const ACCOUNT_ACTIONS=new Set<Action>(['account-pause','account-resume','override-account','job-disable','job-enable']);
export type Command={id:string;action:Action;account?:string;at:number;note?:string;text?:string;activityId?:string|null;role?:string;durationMin?:number;defectId?:string;faultSignature?:string};
// Who committed the command: the GitHub login the API reports for the commit, or 'local' for the loopback console.
export type Identity={via:'github-commit'|'local';login:string|null};
export type Gate={owner:string;now:number;owned:readonly string[];main?:string;applied:(id:string)=>boolean;maxAgeMs?:number};
export const ID_RE=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const MAX_AGE_MS=15*60_000;
export const HOLD_PREFIX='dashboard-stop:';
export const REQUEST_FILE='research/owner-requests.md';
export const REQUEST_MAX=500;

export function validateCommand(raw:unknown):Command{
 const c=raw as any;
 if(!c||typeof c!=='object')throw Error('command must be an object');
 if(typeof c.id!=='string'||!ID_RE.test(c.id))throw Error('command id must be a UUID');
 if(!ACTION_SET.has(c.action))throw Error(`unknown action ${String(c.action).slice(0,40)}`);
 if(typeof c.at!=='number'||!Number.isFinite(c.at))throw Error('command at must be a time in ms');
 if(ACCOUNT_ACTIONS.has(c.action)){if(typeof c.account!=='string'||!NAME_RE.test(c.account))throw Error(`${c.action} needs an account name`);}
 else if(c.account!=null)throw Error(`${c.action} takes no account`);
 if(c.note!=null&&(typeof c.note!=='string'||c.note.length>200))throw Error('note must be a short string');
 if(c.action==='request'){if(typeof c.text!=='string'||!c.text.trim()||c.text.length>REQUEST_MAX)throw Error(`request needs text of up to ${REQUEST_MAX} characters`);}
 else if(c.text!=null)throw Error(`${c.action} takes no text`);
 const extra:Partial<Command>={};
 if(c.action==='override-account'){
  if(c.activityId!==undefined&&c.activityId!==null&&(typeof c.activityId!=='string'||!c.activityId.trim()))throw Error('override-account activityId must be non-empty or null');
  if(c.activityId!==undefined)extra.activityId=c.activityId;
  if(c.role!==undefined){if(typeof c.role!=='string'||!['auto','army','helper','specialist'].includes(c.role))throw Error('override-account role invalid');extra.role=c.role;}
  if(c.durationMin!==undefined){if(typeof c.durationMin!=='number'||!Number.isFinite(c.durationMin)||c.durationMin<=0||c.durationMin>1440)throw Error('override-account durationMin must be 1..1440');extra.durationMin=c.durationMin;}
 }
 if(c.action==='clear-defect'){
  if(typeof c.activityId!=='string'||!c.activityId.trim())throw Error('clear-defect needs activityId');
  extra.activityId=c.activityId.trim();
  if(c.defectId!==undefined){if(typeof c.defectId!=='string'||!c.defectId.trim())throw Error('clear-defect defectId invalid');extra.defectId=c.defectId.trim();}
  if(c.faultSignature!==undefined){if(typeof c.faultSignature!=='string'||!c.faultSignature.trim())throw Error('clear-defect faultSignature invalid');extra.faultSignature=c.faultSignature.trim();}
 }
 return {id:c.id,action:c.action,at:c.at,...(c.account?{account:c.account}:{}),...(c.note?{note:c.note}:{}),...(c.action==='request'?{text:c.text.trim()}:{}),...extra};
}
export function authorizeCommand(cmd:Command,identity:Identity,gate:Gate):{ok:true}|{ok:false;reason:string}{
 const main=(gate.main??MAIN_ACCOUNT).toLowerCase();
 if(identity.via==='github-commit'&&(identity.login==null||identity.login.toLowerCase()!==gate.owner.toLowerCase()))return {ok:false,reason:`committer ${identity.login??'unknown'} is not the owner`};
 if(gate.applied(cmd.id))return {ok:false,reason:'already applied'};
 const age=gate.now-cmd.at;
 if(age>(gate.maxAgeMs??MAX_AGE_MS))return {ok:false,reason:`command is ${Math.round(age/60_000)} min old`};
 if(age<-60_000)return {ok:false,reason:'command time is in the future'};
 if(cmd.account){
  if(cmd.account.toLowerCase()===main)return {ok:false,reason:'the main account is not controlled from the dashboard'};
  if(!gate.owned.some(n=>n.toLowerCase()===cmd.account!.toLowerCase()))return {ok:false,reason:`${cmd.account} is not an account of this side`};
 }
 return {ok:true};
}

// The owner's request ledger (research/owner-requests.md): one numbered row appended to its first table, the next
// free number, status NOT STARTED, so the dashboard's request views and the agents see it.
export function appendOwnerRequest(root:string,text:string):{id:number}{
 const file=join(root,REQUEST_FILE),lines=readFileSync(file,'utf8').split(/\r?\n/);
 const row=(l:string)=>/^\|\s*\d+\s*\|/.test(l);
 let max=0,last=-1,header=-1;
 for(let i=0;i<lines.length;i++){const l=lines[i]!;if(header<0&&/^\|\s*#\s*\|/.test(l))header=i;if(header>=0&&row(l)){max=Math.max(max,Number(l.match(/^\|\s*(\d+)/)![1]));last=i;}if(header>=0&&last>=0&&!l.startsWith('|')&&l.trim())break;}
 if(header<0)throw Error('owner request ledger has no table');
 const id=max+1,clean=text.replace(/\s+/g,' ').replace(/\|/g,'/').trim();
 lines.splice((last>=0?last:header+1)+1,0,`| ${id} | "${clean}" | NOT STARTED | Sent from the hosted dashboard | Triage: name the goal, the useful output and its consumer |`);
 writeFileSync(file,lines.join('\n'));
 return {id};
}
function canonicalJson(value:unknown):string{
 if(Array.isArray(value)){
  let out='[';
  for(let i=0;i<value.length;i++){
   if(i>0)out+=',';
   out+=canonicalJson(value[i]);
  }
  return out+']';
 }
 if(value&&typeof value==='object'){
  const obj=value as Record<string,unknown>;
  const keys=Object.keys(obj).sort();
  let out='{',first=true;
  for(let i=0;i<keys.length;i++){
   const k=keys[i]!,v=obj[k];
   if(v===undefined)continue;
   if(!first)out+=',';
   first=false;
   out+=`${JSON.stringify(k)}:${canonicalJson(v)}`;
  }
  return out+'}';
 }
 return JSON.stringify(value);
}
function stripReceiptMeta(value:unknown):unknown{
 if(!value||typeof value!=='object'||Array.isArray(value))return value;
 const {appliedAt:_appliedAt,applied:_applied,...rest}=value as Record<string,unknown>;
 return rest;
}
export function enqueueBrainCommand(root:string,cmd:OperatorCommand):string|null{
 const errs=validateOperatorCommand(cmd);
 if(errs.length)return errs.join('; ');
 const dir=operatorCommandsDir(root);
 const pendingFile=join(dir,`${cmd.id}.json`),appliedFile=join(dir,'applied',`${cmd.id}.json`),rejectedFile=join(dir,'rejected',`${cmd.id}.json`);
 const cmdKey=canonicalJson(cmd);
 for(const candidate of [pendingFile,appliedFile]){
  if(!existsSync(candidate))continue;
  try{
   if(canonicalJson(stripReceiptMeta(JSON.parse(readFileSync(candidate,'utf8'))))!==cmdKey){
    return 'command identity conflicts with existing operator command';
   }
  }catch{
   return 'command identity conflicts with existing operator command';
  }
 }
 if(!existsSync(pendingFile)&&!existsSync(appliedFile)&&!existsSync(rejectedFile)){
  mkdirSync(dir,{recursive:true});
  atomicJson(pendingFile,cmd);
 }
 return null;
}
export function existingStopFiles(root:string,flag:string):string[]{
 const seen=new Set<string>(),out:string[]=[];
 const push=(p:string)=>{
  const key=process.platform==='win32'?p.toLowerCase():p;
  if(!seen.has(key)&&existsSync(p)){seen.add(key);out.push(p);}
 };
 for(const p of stopFilePaths(flag,root))push(p);
 for(const e of listStopEntries(root))if(e.location!=='sim'&&e.flag.toLowerCase()===flag.toLowerCase())push(e.path);
 return out;
}
export type ApplyContext={root:string;now?:number;planWrite?:<T>(action:()=>T|Promise<T>)=>Promise<T>};
export type Outcome={status:string;note:string|null};
// A reviewed outcome, never a thrown error, so the receipt tells the owner what happened.
export async function applyCommand(cmd:Command,ctx:ApplyContext):Promise<Outcome>{
 const prac=practiceRoot(ctx.root),now=ctx.now??Date.now(),iso=new Date(now).toISOString(),planWrite=ctx.planWrite??(a=>withPlanWrite(a,liveRoot(ctx.root)));
 const read=(f:string)=>existsSync(f)?readFileSync(f,'utf8'):null;
 switch(cmd.action){
  case 'account-pause':{
   if(findStopFile(cmd.account!,ctx.root))return {status:'already-held',note:'a stop file already holds this account'};
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'pause_account',account:cmd.account!,reason:cmd.note??HOLD_PREFIX+cmd.id});
   if(err)return {status:'refused',note:err};
   const f=join(prac,'stop-'+cmd.account);mkdirSync(prac,{recursive:true});writeFileSync(f,HOLD_PREFIX+cmd.id,{flag:'wx'});
   return {status:'stop-requested',note:'the bot finishes its step and logs out'};
  }
  case 'account-resume':{
   const files=existingStopFiles(ctx.root,cmd.account!);
   if(!files.length)return {status:'not-held',note:'no stop file'};
   if(files.some(f=>!(read(f)??'').startsWith(HOLD_PREFIX)))return {status:'refused',note:'this hold belongs elsewhere; inspect it before changing it'};
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'resume_account',account:cmd.account!,reason:cmd.note});
   if(err)return {status:'refused',note:err};
   for(const f of files)unlinkSync(f);
   return {status:'hold-released',note:'the swarm starts the job again on its next tick'};
  }
  case 'swarm-pause':case 'side-pause':{
   const existing=findStopFile('swarm',ctx.root);
   if(existing)return {status:'already-stopped',note:(read(existing)??'').slice(0,80)};
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'pause_side',side:mySide(),reason:cmd.note});
   if(err)return {status:'refused',note:err};
   const f=join(prac,'stop-swarm');mkdirSync(prac,{recursive:true});writeFileSync(f,`${HOLD_PREFIX}${cmd.id} ${iso}`,{flag:'wx'});
   return {status:'stop-requested',note:'every bot logs out at its next step; the controller exits when all are down'};
  }
  case 'swarm-resume':case 'side-resume':{
   const files=existingStopFiles(ctx.root,'swarm');
   if(!files.length)return {status:'not-stopped',note:null};
   if(files.some(f=>!(read(f)??'').startsWith(HOLD_PREFIX)))return {status:'refused',note:'the fleet stop was set by hand or by a controller; clear it there'};
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'resume_side',side:mySide(),reason:cmd.note});
   if(err)return {status:'refused',note:err};
   for(const f of files)unlinkSync(f);
   return {status:'stop-cleared',note:'start the controller again on the PC: bun scripts/swarm.ts swarm.json'};
  }
  case 'request':{const {id}=appendOwnerRequest(ctx.root,cmd.text??'');return {status:'request-recorded',note:`row ${id} in ${REQUEST_FILE}`};}
  case 'override-account':{
   if(cmd.activityId!==undefined&&cmd.activityId!==null&&!defaultActivityCatalog(ctx.root).has(cmd.activityId)){
    return {status:'refused',note:`unknown activity "${cmd.activityId}"`};
   }
   const mins=cmd.durationMin??30;
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'override_account',account:cmd.account!,...(cmd.activityId!==undefined?{activityId:cmd.activityId}:{}),...(cmd.role?{role:cmd.role as any}:{}),expiresAt:now+mins*60_000,reason:cmd.note});
   if(err)return {status:'refused',note:err};
   return {status:'override-submitted',note:`${cmd.account}${cmd.activityId?' -> '+cmd.activityId:''}`};
  }
  case 'clear-defect':{
   const err=enqueueBrainCommand(ctx.root,{schemaVersion:1,id:cmd.id,issuedAt:now,issuedBy:'dashboard',kind:'clear_defect',activityId:cmd.activityId!,...(cmd.defectId?{defectId:cmd.defectId}:{}),...(cmd.faultSignature?{faultSignature:cmd.faultSignature}:{}),reason:cmd.note});
   if(err)return {status:'refused',note:err};
   return {status:'defect-clear-submitted',note:cmd.activityId!};
  }
  case 'job-disable':case 'job-enable':{
   const enable=cmd.action==='job-enable';
   return planWrite(()=>{
    const file=join(ctx.root,'swarm.json'),text=readFileSync(file,'utf8'),plan=JSON.parse(text);
    const jobs=(plan.jobs??[]).filter((j:any)=>typeof j?.account==='string'&&j.account.toLowerCase()===cmd.account!.toLowerCase()&&j.script);
    if(!jobs.length)return {status:'no-job',note:'swarm.json has no job for this account'};
    if(jobs.every((j:any)=>(j.enabled===true)===enable))return {status:'unchanged',note:`already ${enable?'enabled':'disabled'}`};
    for(const j of jobs)j.enabled=enable;
    atomicJson(file,plan);
    return {status:enable?'job-enabled':'job-disabled',note:`${jobs.length} job(s) in swarm.json`};
   });
  }
 }
}
// The ledger the local console also writes: one receipt per command id, so a replay returns the first outcome.
export function receiptPath(root:string,id:string){return join(root,'.practice','dashboard-controls',id+'.json');}
const receiptReadCache=new Map<string,{mtimeMs:number;size:number;doc:any}>();
export function readReceipts(root:string):any[]{
 const dir=join(root,'.practice','dashboard-controls');
 let names:string[];
 try{names=readdirSync(dir);}catch{return [];}
 const nowWall=Date.now(),out:any[]=[];
 for(let i=0;i<names.length;i++){
  const n=names[i]!;
  if(!/^[a-f0-9-]+\.json$/.test(n))continue;
  const file=join(dir,n);
  try{
   const st=statSync(file);
   const hit=receiptReadCache.get(file);
   if(hit&&nowWall-st.mtimeMs>1000&&hit.mtimeMs===st.mtimeMs&&hit.size===st.size){
    out.push(hit.doc);
    continue;
   }
   const doc=JSON.parse(readFileSync(file,'utf8'));
   if(receiptReadCache.size>=1000)receiptReadCache.clear();
   receiptReadCache.set(file,{mtimeMs:st.mtimeMs,size:st.size,doc});
   out.push(doc);
  }catch{}
 }
 return out;
}
export function writeReceipt(root:string,receipt:{id:string}&Record<string,unknown>){mkdirSync(join(root,'.practice','dashboard-controls'),{recursive:true});atomicJson(receiptPath(root,receipt.id),receipt);}
