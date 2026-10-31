// Commands the hosted control page sends to this PC. Each one is accepted only from the owner's identity, applied once,
// and goes through a file the controllers already honour: .practice/stop-<account> (scripts/swarm.ts), .practice/stop-swarm,
// .practice/stop-coordinator, or swarm.json under the coordinator's plan-write lock. The main account is never a target.
import {existsSync,readFileSync,writeFileSync,unlinkSync,mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {withPlanWrite,atomicJson} from '../router/src/coordinator-store';
import {MAIN_ACCOUNT} from './publish-relay';
export const NAME_RE=/^[A-Za-z0-9]{1,12}$/;

export const ACTIONS=['account-pause','account-resume','swarm-pause','swarm-resume','coordinator-pause','job-disable','job-enable','request'] as const;
export type Action=typeof ACTIONS[number];
export const ACCOUNT_ACTIONS=new Set<Action>(['account-pause','account-resume','job-disable','job-enable']);
export type Command={id:string;action:Action;account?:string;at:number;note?:string;text?:string};
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
 if(!ACTIONS.includes(c.action))throw Error(`unknown action ${String(c.action).slice(0,40)}`);
 if(typeof c.at!=='number'||!Number.isFinite(c.at))throw Error('command at must be a time in ms');
 if(ACCOUNT_ACTIONS.has(c.action)){if(typeof c.account!=='string'||!NAME_RE.test(c.account))throw Error(`${c.action} needs an account name`);}
 else if(c.account!=null)throw Error(`${c.action} takes no account`);
 if(c.note!=null&&(typeof c.note!=='string'||c.note.length>200))throw Error('note must be a short string');
 if(c.action==='request'){if(typeof c.text!=='string'||!c.text.trim()||c.text.length>REQUEST_MAX)throw Error(`request needs text of up to ${REQUEST_MAX} characters`);}
 else if(c.text!=null)throw Error(`${c.action} takes no text`);
 return {id:c.id,action:c.action,at:c.at,...(c.account?{account:c.account}:{}),...(c.note?{note:c.note}:{}),...(c.action==='request'?{text:c.text.trim()}:{})};
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
export type ApplyContext={root:string;now?:number;planWrite?:<T>(action:()=>T|Promise<T>)=>Promise<T>};
export type Outcome={status:string;note:string|null};
// A reviewed outcome, never a thrown error, so the receipt tells the owner what happened.
export async function applyCommand(cmd:Command,ctx:ApplyContext):Promise<Outcome>{
 const prac=join(ctx.root,'.practice'),iso=new Date(ctx.now??Date.now()).toISOString(),planWrite=ctx.planWrite??(a=>withPlanWrite(a,join(prac,'coordinator')));
 const read=(f:string)=>existsSync(f)?readFileSync(f,'utf8'):null;
 switch(cmd.action){
  case 'account-pause':{const f=join(prac,'stop-'+cmd.account);if(existsSync(f))return {status:'already-held',note:'a stop file already holds this account'};writeFileSync(f,HOLD_PREFIX+cmd.id,{flag:'wx'});return {status:'stop-requested',note:'the bot finishes its step and logs out'};}
  case 'account-resume':{const f=join(prac,'stop-'+cmd.account),text=read(f);if(text==null)return {status:'not-held',note:'no stop file'};if(!text.startsWith(HOLD_PREFIX))return {status:'refused',note:'this hold belongs elsewhere; inspect it before changing it'};unlinkSync(f);return {status:'hold-released',note:'the swarm starts the job again on its next tick'};}
  case 'swarm-pause':{const f=join(prac,'stop-swarm');if(existsSync(f))return {status:'already-stopped',note:read(f)!.slice(0,80)};writeFileSync(f,`${HOLD_PREFIX}${cmd.id} ${iso}`,{flag:'wx'});return {status:'stop-requested',note:'every bot logs out at its next step; the controller exits when all are down'};}
  case 'swarm-resume':{const f=join(prac,'stop-swarm'),text=read(f);if(text==null)return {status:'not-stopped',note:null};if(!text.startsWith(HOLD_PREFIX))return {status:'refused',note:'the fleet stop was set by hand or by a controller; clear it there'};unlinkSync(f);return {status:'stop-cleared',note:'start the controller again on the PC: bun scripts/swarm.ts swarm.json'};}
  case 'request':{const {id}=appendOwnerRequest(ctx.root,cmd.text??'');return {status:'request-recorded',note:`row ${id} in ${REQUEST_FILE}`};}
  case 'coordinator-pause':{const f=join(prac,'stop-coordinator');if(existsSync(f))return {status:'already-paused',note:null};writeFileSync(f,`owner pause from fleet command ${cmd.id} ${iso}`);return {status:'stop-requested',note:'running tasks finish; no new task starts'};}
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
export function readReceipts(root:string):any[]{
 const dir=join(root,'.practice','dashboard-controls');if(!existsSync(dir))return [];
 return readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).flatMap(n=>{try{return [JSON.parse(readFileSync(join(dir,n),'utf8'))];}catch{return [];}});
}
export function writeReceipt(root:string,receipt:{id:string}&Record<string,unknown>){mkdirSync(join(root,'.practice','dashboard-controls'),{recursive:true});atomicJson(receiptPath(root,receipt.id),receipt);}
