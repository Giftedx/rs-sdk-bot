// Coordinator-only native context. No live worker imports this module.
import {RESERVED_ACCOUNTS} from '../../core/src/specialist-boards';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseRangedEntry} from '../../practice/src/ranged-progression-case';
import {assertSideOwns} from '../../core/src/fleet';
import {readLogoutProof,type LogoutProof} from '../../core/src/session-lifecycle';
import type {CoordTask} from './coordinator';
import type {DeliveryTask} from './delivery';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const contextKeys=['PROGRESSION_ACCOUNT','PROGRESSION_TARGET_LEVEL','PROGRESSION_ENTRY_AT','PROGRESSION_ENTRY_SHA256','PROGRESSION_CONSUMER'] as const;
type Options={base?:string;now?:()=>number;owns?:(account:string)=>boolean;logout?:(account:string,server:string)=>LogoutProof};
export async function runQualifiedDelivery<T>(definition:Pick<DeliveryTask,'id'>,task:Pick<CoordTask,'account'|'env'|'accept'>,run:()=>Promise<T>,options:Options={}):Promise<T>{
 const env=task.env??{},requested=contextKeys.some(k=>env[k]!==undefined);
 if(definition.id!=='ranged-train'){if(requested)throw Error('native progression context needs the mapped Ranged capability');return run();}
 const oldEntry=process.env.RANGED_PROGRESSION_ENTRY,oldTarget=process.env.RANGED_PROGRESSION_TARGET;
 const base=options.base??resolve(import.meta.dir,'../../..'),now=options.now??Date.now;
 let captured:string|undefined,target:number|undefined,assertCurrent=()=>{};
 if(requested){
  if(contextKeys.some(k=>!env[k]))throw Error('native progression context is incomplete');
  const account=env.PROGRESSION_ACCOUNT!;
  if(!/^[a-zA-Z0-9]{1,12}$/.test(account)||account.toLowerCase()!==task.account?.toLowerCase()||RESERVED_ACCOUNTS.includes(account.toLowerCase()))throw Error('native progression account is not an ordinary bound account');
  if(options.owns?!options.owns(account):!owns(account))throw Error('native progression account belongs to another side');
  const path=join(base,'.practice/status',account+'.json'),raw=readFileSync(path),status=JSON.parse(raw.toString());
  const expected=env.PROGRESSION_ENTRY_SHA256;
  if(!/^[a-f0-9]{64}$/.test(expected!)||hash(raw)!==expected||String(status.at)!==env.PROGRESSION_ENTRY_AT)throw Error('native progression observation changed');
  const time=now(),fresh=(at:unknown)=>typeof at==='number'&&Number.isFinite(at)&&at>0&&at<=time&&time-at<=300000;
  if(status.name?.toLowerCase()!==account.toLowerCase()||status.server!=='rs-sdk-demo.fly.dev'||status.practice||!Number.isSafeInteger(status.started)||status.started<=0||!fresh(status.at)||!fresh(status.bankAt)||status.bankAt>status.at||status.bankAt<status.started||status.equipmentObserved!==true||!/^ok\b/.test(status.result??''))throw Error('native progression requires fresh observed skills, bank, equipment and a successful settled entry');
  const logout=options.logout??((name,server)=>readLogoutProof(name,server,{root:join(base,'.practice/session-lifecycle')}));
  const proof=logout(account,status.server);
  if(proof.state!=='confirmed'||proof.attemptId!==status.sessionAttemptId||proof.ownerRun!==(status.coordinatorRunId??null)||proof.loggedOutAt<status.started||proof.loggedOutAt>status.at||proof.loggedOutAt<status.bankAt)throw Error('native progression requires the exact confirmed observer logout');
  const rows=(items:any[])=>items.map(({id,count})=>({id,count}));
  const bytes=Buffer.from(JSON.stringify({at:status.at,bankAt:status.bankAt,sourceSha256:expected,producer:{loggedOutAt:proof.loggedOutAt,receiptSha256:proof.receiptSha256},pos:status.pos,hp:status.hp,
   skills:status.skills.map(({name,level,currentLevel,xp}:any)=>({name,level,currentLevel,xp})),inventory:rows(status.inventory),equipment:status.equipment.map(({id,count,slot}:any)=>({id,count,slot})),bank:rows(status.bank)}));
  const entry=parseRangedEntry(bytes).entry,level=entry.skills[4]!.level;
  let consumer:any;try{consumer=JSON.parse(env.PROGRESSION_CONSUMER!);}catch{throw Error('invalid original progression consumer');}
  const skills=consumer?.skills&&typeof consumer.skills==='object'&&!Array.isArray(consumer.skills)?Object.entries(consumer.skills):[];
  if(skills.length!==1||skills[0]![0].toLowerCase()!=='ranged'||Object.keys(consumer).some(k=>k!=='skills'))throw Error('native progression needs one unambiguous Ranged consumer');
  const goal=skills[0]![1] as number;target=Number(env.PROGRESSION_TARGET_LEVEL);
  if(!Number.isSafeInteger(goal)||goal<1||goal>99||!Number.isSafeInteger(target)||target<=level||target>Math.min(goal,level+5,99))throw Error('native progression target exceeds its finite observed band or original consumer');
  const directory=join(base,'.practice/progression-system/entries');mkdirSync(directory,{recursive:true});captured=join(directory,hash(bytes)+'.json');
  if(existsSync(captured)){if(!readFileSync(captured).equals(bytes))throw Error('immutable native entry differs');}else writeFileSync(captured,bytes,{flag:'wx'});
  assertCurrent=()=>{
   if(hash(readFileSync(path))!==expected)throw Error('native progression observation changed during qualification');
   const current=logout(account,status.server);if(current.state!=='confirmed'||current.attemptId!==proof.attemptId||current.receiptSha256!==proof.receiptSha256)throw Error('native progression session changed during qualification');
   if(['stop-coordinator','stop-swarm','stop-'+account,'stop-'+account.toLowerCase()].some(file=>existsSync(join(base,'.practice',file))))throw Error('native progression owner stopped');
   if(options.owns?!options.owns(account):!owns(account))throw Error('native progression owner changed');
  };
 }
 try{
  assertCurrent();
  if(captured)process.env.RANGED_PROGRESSION_ENTRY=captured;else delete process.env.RANGED_PROGRESSION_ENTRY;
  if(target!==undefined)process.env.RANGED_PROGRESSION_TARGET=String(target);else delete process.env.RANGED_PROGRESSION_TARGET;
  const result=await run();assertCurrent();return result;
 }finally{
  if(oldEntry===undefined)delete process.env.RANGED_PROGRESSION_ENTRY;else process.env.RANGED_PROGRESSION_ENTRY=oldEntry;
  if(oldTarget===undefined)delete process.env.RANGED_PROGRESSION_TARGET;else process.env.RANGED_PROGRESSION_TARGET=oldTarget;
 }
}
function owns(account:string){try{assertSideOwns(account);return true;}catch{return false;}}
