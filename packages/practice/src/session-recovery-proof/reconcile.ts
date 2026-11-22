import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {EventEmitter} from 'node:events';
import {NATIVE_RECOVERY_CHECKS} from '../../../core/src/session-recovery-permit';
import {accountDir,domainOf,readLogoutProof,listAttempts} from '../../../core/src/session-lifecycle';
import {readPracticeSave} from '../fleet-player-save';
import {sha} from './boundary';

export type Save=ReturnType<typeof readPracticeSave>;

// The stalled relay accepts only after beginSessionAttempt returns with both files published.
// Subscribe before starting the owner so a fast handshake cannot be missed.
export async function afterStalledConnection<T>(events:EventEmitter,start:()=>Promise<T>,budgetMs=30000):Promise<T>{
 let accept!:()=>void;
 const accepted=new Promise<void>(resolve=>{accept=resolve;});
 events.once('stalled',accept);
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('stalled connection acceptance timeout')),budgetMs);});
 try{
  const [owner]=await Promise.race([Promise.all([Promise.resolve().then(start),accepted]),deadline]);
  return owner;
 }finally{clearTimeout(timer);events.off('stalled',accept);}
}

// Keep the FIRST reader result. Later file bytes cannot replace invalid evidence.
// The receipt-before-latest publication interval is invalid for admission, never logout.
export function observePartialOwner(account:string,server:string,lifecycleRoot:string,ownerPid:number){
 const order:{step:string;at:number}[]=[];
 const mark=(step:string)=>{order.push({step,at:Date.now()});};
 mark('listAttempts:start');
 const attempts=listAttempts(account,server,{root:lifecycleRoot});
 mark('listAttempts:end');
 // No extra file read between the original readiness query and its classification.
 mark('readLogoutProof:start');const proof=readLogoutProof(account,server,{root:lifecycleRoot});mark('readLogoutProof:end');
 const selected=attempts.filter(a=>a.receipt?.owner.pid===ownerPid);
 const dir=accountDir(account,server,lifecycleRoot);
 const inspect=(path:string)=>{
  let bytes:Buffer;
  try{bytes=readFileSync(path);}catch(e:any){return {state:e?.code==='ENOENT'?'missing':'unreadable',sha256:null,identity:null};}
  const sha256=sha(bytes);let v:any;
  try{v=JSON.parse(bytes.toString('utf8'));}catch{return {state:'malformed',sha256,identity:null};}
  // Allowlist fields. Never retain raw connection errors, owner labels or secret fields.
  const identity=v&&typeof v==='object'?Object.fromEntries(['schema','account','server','domain','attemptId','at'].filter(k=>typeof v[k]==='string'||typeof v[k]==='number').map(k=>[k,v[k]])):null;
  return {state:'read',sha256,identity};
 };
 mark('latestAfter:start');const latestAfter=inspect(join(dir,'latest.json'));mark('latestAfter:end');
 const receiptsAfter=selected.map(a=>{mark('receiptAfter:start');const value=inspect(join(dir,'attempts',a.attemptId+'.json'));mark('receiptAfter:end');return {attemptId:a.attemptId,...value};});
 mark('ownerAlive:start');let ownerAlive:boolean|null=null;
 try{process.kill(ownerPid,0);ownerAlive=true;}catch(e:any){if(e?.code==='ESRCH')ownerAlive=false;}
 mark('ownerAlive:end');
 const safeAttempts=attempts.map(a=>({attemptId:a.attemptId,sha256:a.sha256,receipt:a.receipt?{
  account:a.receipt.account,server:a.receipt.server,domain:a.receipt.domain,attemptId:a.receipt.attemptId,
  ownerPid:a.receipt.owner.pid,createdAt:a.receipt.createdAt,updatedAt:a.receipt.updatedAt,eventKinds:a.receipt.events.map(e=>e.kind),
 }:null}));
 const checks={ownerIntentVisible:selected.length===1,ownerAlive:ownerAlive===true,
  held:proof.state==='held',beforeStart:proof.state==='held'&&/before START/.test(proof.reason),
  matchingAttempt:proof.state==='held'&&selected.length===1&&proof.attemptId===selected[0]!.attemptId,
  matchingIdentity:selected.length===1&&selected[0]!.receipt!.account.toLowerCase()===account.toLowerCase()&&selected[0]!.receipt!.server===server&&selected[0]!.receipt!.domain===domainOf(server)};
 return {account,server,domain:domainOf(server),ownerPid,ownerAlive,order,attempts:safeAttempts,proof,latestAfter,receiptsAfter,checks,
  // This remains diagnostic: post-read files are explicitly not an atomic snapshot of the proof.
  ownerIntentVisible:selected.length>0};
}

// An absent empty container and a present empty container hold the same stock. Every nonempty slot counts.
export const stockOf=(s:Pick<Save,'inventories'>)=>Object.fromEntries(Object.entries(s.inventories).filter(([,items])=>items.length));
export function reconcileSaves(before:Save,after:Save,position=before.position){
 return {inventories:isDeepStrictEqual(stockOf(before),stockOf(after)),skills:isDeepStrictEqual(before.skills,after.skills),position:isDeepStrictEqual(position,after.position)};
}
// Negative controls: a reconciler that cannot see one lost coin, one gained coin, a skill change or a moved tile is broken.
export function reconcileNegativeControls(before:Save,after:Save){
 const lost=structuredClone(after),gained=structuredClone(after),skill=structuredClone(after),moved=structuredClone(after);
 const slot=Object.values(lost.inventories).find(items=>items.length)?.[0];if(slot)slot.count--;
 gained.inventories[94]=[...(gained.inventories[94]??[]),{slot:99,id:995,count:1}];
 if(skill.skills[0])(skill.skills[0] as any).level=((skill.skills[0] as any).level??0)+1;
 moved.position={...moved.position,x:moved.position.x+1};
 const fails=(v:Save)=>Object.values(reconcileSaves(before,v)).some(ok=>!ok);
 return {lostItem:!!slot&&fails(lost),gainedItem:fails(gained),skillChange:fails(skill),moved:fails(moved)};
}
export const CHECK_CASES:Record<(typeof NATIVE_RECOVERY_CHECKS)[number],string[]>={
 offline:['offline'],orphan:['orphan'],modal:['modal'],authFailure:['auth-failure'],cooldown:['cooldown'],partial:['partial'],timeout:['timeout'],
 lateCallback:['restart-late-callback'],ownership:['ownership','partial-owner-alive'],stop:['stop'],singleUse:['single-use','restart-late-callback'],
 stock:['offline','orphan','modal','partial','stock-negative-controls'],
 completed:['completed','completed-held-producer','completed-refusals'],
};
// Each check is derived from observed cases. A check passes only when every named case was observed and passed.
export function deriveChecks(cases:{id:string;ok:boolean;level:string;evidence:{path:string;sha256:string}[]}[]){
 const byId=new Map(cases.map(c=>[c.id,c]));
 return Object.fromEntries(NATIVE_RECOVERY_CHECKS.map(key=>{
  const rows=CHECK_CASES[key].map(id=>byId.get(id));
  const ok=rows.every(r=>r?.ok===true&&/^native-/.test(r.level)&&r.evidence.length>0);
  return [key,{ok,level:ok?[...new Set(rows.map(r=>r!.level))].join('+'):'missing',cases:CHECK_CASES[key],evidence:rows.flatMap(r=>r?.evidence.slice(0,1)??[])}];
 }));
}
