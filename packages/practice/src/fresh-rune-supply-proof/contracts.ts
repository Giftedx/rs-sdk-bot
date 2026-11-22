import {createHash} from 'node:crypto';
import {existsSync,readdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {workerSourceRevision} from '../../../core/src/worker-release';
import type {readPracticeSave} from '../fleet-player-save';
import type {startStack} from '../stack';

export const repoRoot=resolve(import.meta.dir,'../../../..');

export type Save=ReturnType<typeof readPracticeSave>;
export type Run={code:number;log:string};
export type ProofBudget={deadline:number;check():void};
export interface FreshRuneStackDeps{practice:string;free:()=>number;portsFree:()=>boolean;start:typeof startStack;sleep?:(ms:number)=>Promise<void>}
export type RecoverySession={mode:'refused'|'exit';clockBefore:number;clockAfter:number};

// Native check is 900s. Stop work at 810s, leaving 90s for owned cleanup.
export const workMs=810000;
export const PORT_WAIT_MS=30000,PORT_STEP_MS=250;
// Recovery fixtures never contribute to genuine-registration predicates.
export const airRecoveryPositions=[{x:2843,z:4832,level:0},{x:2842,z:4831,level:0},{x:2841,z:4830,level:0}];
// Ordinary seeded recovery evidence stays separate from genuine registration.
// The post-craft fixture starts below the target: Runecraft 19 at 3000 XP (level 20 is 3105 XP). The essence in hand is
// the work that reaches level 20, so the craft is not work after a finished goal (a finished goal refuses crafts).
export const POSTCRAFT_XP=3000;

export const freshRuneStages=['start','first-bank','target','higher'] as const;
export type FreshRuneStage=typeof freshRuneStages[number];
export const checkpoints=['interrupted.sav','first-bank.sav','after.sav','higher.sav'] as const;
export type Binding={name:string;source:string;files:Record<string,string>;identity:string;configuration:{server:string;tickMs:number;xpRate:number;content:string}};
export type StageRecord={stage:FreshRuneStage;binding:Binding;previous:string|null;inputHash:string|null;output:string;outputHash:string;
 evidence:Record<string,string>;codes:Record<string,number>;checks:Record<string,boolean>;at:number};

export function freshRuneChildTimeout(label:string,deadline:number,now=Date.now()){
 const timeoutMs=Math.min(label==='registration'||label==='cooking'?45000:label==='essence-diagnostic'?480000:label==='interrupted'?180000:workMs,deadline-now-60000);
 if(timeoutMs<=0)throw Error('no child budget remains at '+label);
 return timeoutMs;
}

export function freshRuneStageWorker(stage:Exclude<FreshRuneStage,'start'>,name:string,deadline:number,now=Date.now()){
 const label=stage==='target'?'resume':stage==='first-bank'?'first-bank':'higher';
 const timeoutMs=freshRuneChildTimeout(label,deadline,now);
 // Leave 30s inside the child wall envelope for opening and the owner's logout.
 const cap=Math.floor((timeoutMs-30000)/150);
 if(cap<1)throw Error('no finite tick budget with logout reserve');
 return {label,args:['scripts/rune-supply.ts',name,String(stage==='first-bank'?2:stage==='target'?20:21)],env:{CAP:String(cap)},timeoutMs};
}

export const sum=(s:Save,id:number,container?:number)=>Object.entries(s.inventories).filter(([key])=>container===undefined||Number(key)===container)
 .reduce((n,[,items])=>n+items.filter(i=>i.id===id).reduce((n,i)=>n+i.count,0),0);
export const assets=(s:Save)=>{const a:Record<number,number>={};for(const i of Object.values(s.inventories).flat())a[i.id]=(a[i.id]??0)+i.count;return a;};
export const summary=(r:Run)=>{try{return JSON.parse(r.log.split(/\r?\n/).filter(l=>l.startsWith('RUNE_SUPPLY_RESULT ')).at(-1)?.slice(19)??'null');}catch{return null;}};
export const logout=(r:Run)=>(r.log.match(/^LOGOUT logged-out$/gm)??[]).length===1&&!/^WARN .*logout/m.test(r.log);
export const retainedProgress=(before:Save,interrupted:Save)=>interrupted.skills.some((s,i)=>s.xp>(before.skills[i]?.xp??0))||(interrupted.vars[63]??0)>(before.vars[63]??0);

export const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const files=['scripts/rune-supply.ts','scripts/rune-supply.test.ts','scripts/train-chickens.ts','scripts/train-chickens.test.ts',
 'scripts/generated/quest-runemysteries.ts','scripts/generated/quest-lib.ts','scripts/rune-mysteries-route.ts','scripts/rune-mysteries-route.test.ts',
 'scripts/gather-essence.ts','scripts/gather-essence.test.ts','scripts/generated/rcair.ts','scripts/fishcook.ts','scripts/fishcook.test.ts',
 'packages/practice/src/fresh-rune-supply-proof.ts',
 'packages/practice/src/fresh-rune-supply-proof/contracts.ts',
 'packages/practice/src/fresh-rune-supply-proof/stack.ts',
 'packages/practice/src/fresh-rune-supply-proof/checks.ts',
 'packages/practice/src/fresh-rune-supply-proof/verify.ts',
 'packages/practice/src/fresh-rune-supply-proof/diagnostics.ts',
 'packages/practice/src/fresh-rune-supply-proof/runner.ts',
 'packages/practice/test/fresh-rune-supply-proof.test.ts'];
export const sources=()=>Object.fromEntries(files.map(p=>[p,hash(join(repoRoot,p))]));

export const stageFile=(stage:FreshRuneStage)=>`stage-${stage}.json`;
export const json=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
export const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const readRun=(directory:string,label:string,code:number):Run=>({code,log:readFileSync(join(directory,label+'.log'),'utf8')+readFileSync(join(directory,label+'.err'),'utf8')});
export const engineSave=(name:string)=>join(repoRoot,'vendor/rs-sdk/server/engine/data/players/main',name.toLowerCase()+'.sav');

// Hash the installed engine, packed collision/content and pinned script inputs.
// Mutable saves, databases, logs and credentials are excluded from this stamp.
function freshRuneServerHash(tickMs=150){
 const digest=createHash('sha256');
 const walk=(path:string)=>{for(const entry of readdirSync(join(repoRoot,path),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(['node_modules','.git'].includes(entry.name))continue;
  const file=path+'/'+entry.name;
  if(entry.isSymbolicLink())throw Error('linked server input unsupported: '+file);
  if(entry.isDirectory())walk(file);else digest.update(file+'\0').update(readFileSync(join(repoRoot,file))).update('\0');
 }};
 for(const path of ['vendor/rs-sdk/server/engine/src','vendor/rs-sdk/server/engine/data/pack/server','vendor/rs-sdk/server/content/scripts','vendor/rs-sdk/server/content/maps','vendor/rs-sdk/server/gateway'])walk(path);
 for(const path of ['vendor/rs-sdk/server/engine/package.json','vendor/rs-sdk/server/engine/bun.lock'])digest.update(path+'\0').update(readFileSync(join(repoRoot,path)));
 for(const path of ['vendor/rs-sdk/server/engine/data/config/world.json','vendor/rs-sdk/server/engine/.env'])
  digest.update(path+'\0').update(existsSync(join(repoRoot,path))?hash(join(repoRoot,path)):'absent');
 const environment={...process.env,NODE_TICKRATE:String(tickMs),NODE_XPRATE:'25',WEB_PORT:'8888',GATEWAY_HOSTNAME:'127.0.0.1',AGENT_PORT:'7780'};
 // Only a digest is published. Configuration secrets must never enter evidence.
 for(const key of Object.keys(environment).filter(k=>/^(NODE_|WEB_|ENGINE_|LOGIN_|FRIEND_|LOGGER_|CACHE_|GE_|GATEWAY_|AGENT_PORT$|EASY_STARTUP$|WEBSITE_REGISTRATION$)/.test(k)).sort())
  digest.update(key+'\0').update(environment[key as keyof typeof environment]??'').update('\0');
 return digest.digest('hex');
}

export function freshRuneBinding(name:string,tickMs=150):Binding{
 const env=join(repoRoot,'vendor/rs-sdk/bots',name,'bot.env');
 if(!/^[a-z0-9]{1,12}$/i.test(name)||!existsSync(env)||!/^SERVER=localhost:8888\r?$/m.test(readFileSync(env,'utf8')))
  throw Error('stage requires the same retained local account; no registration on restart');
 if(existsSync(join(repoRoot,'.practice',`stop-${name}`)))throw Error('preserve account stop file');
 return {name,source:workerSourceRevision(),files:sources(),identity:hash(env),
  configuration:{server:'localhost:8888',tickMs,xpRate:25,content:freshRuneServerHash(tickMs)}};
}
