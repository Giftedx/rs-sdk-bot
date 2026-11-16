import type {Step} from '../packages/core/src/chain-step';
import type {ProgressionCatalog,CatalogAccept} from '../packages/planner/src/progression-catalog';
import type {ProgressionDecision} from '../packages/planner/src/progression';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {evaluateProgressionWork,parentProgressionAccept} from '../packages/core/src/progression-session';
import {intentForEntry} from '../packages/planner/src/progression-catalog';
export interface AioProgressionContext{status?:any;catalog?:ProgressionCatalog;accept?:CatalogAccept;now?:number;intentTarget?:number}
export interface AioProgressionChoice{step:Step|null;decision:ProgressionDecision|null;reason:string;changed:boolean;blocked?:boolean}
export function selectAioProgression(account:string,step:Step,env:Record<string,string|undefined>,context:AioProgressionContext={},readStatus=true):AioProgressionChoice{
 let status=context.status;
 if(status===undefined&&readStatus)try{status=JSON.parse(readFileSync(resolve(import.meta.dir,'../.practice/status',account+'.json'),'utf8'));}catch{/* No observation remains unknown. */}
 if(!status)return{step,decision:null,reason:'Route speed is unverified: fresh account, stock and source-bound method observations are required.',changed:false};
 if(typeof status.name!=='string'||status.name.toLowerCase()!==account.toLowerCase())return{step:null,decision:null,reason:'Account observation identity mismatch.',changed:false,blocked:true};
 const work={script:step.script,args:[...step.args],env:{...env,...step.env}};
 let accept=context.accept??parentProgressionAccept(work,account);
 if(context.intentTarget!==undefined){const intent=intentForEntry(step.script,step.args,work.env,accept,context.catalog);
  if(intent?.kind==='train')accept={skills:{[intent.skill]:context.intentTarget}};
 }
 const evaluation=evaluateProgressionWork(work,status,{now:context.now,catalog:context.catalog,accept,requireQualification:true,continuing:false});
 const decision=evaluation.decision;
 if(decision?.state==='complete')return{step:null,decision,reason:decision.reason,changed:true};
 const blocked=decision?.state==='blocked'&&(/Protected account clock/.test(decision.reason)||decision.followUps.length>0&&decision.followUps.every(f=>f.state==='blocked'));
 if(blocked)return{step:null,decision,reason:decision!.reason,changed:false,blocked:true};
 if(decision?.state==='execute'&&decision.step)return{step:decision.step,decision,reason:`Shared qualified progression choice ${decision.selected}: ${decision.reason}`,changed:JSON.stringify(decision.step)!==JSON.stringify(step)};
 return{step,decision,reason:'Route speed is unverified; retaining the finite authored consumer. '+(decision?.reason??evaluation.reason??'Observe or qualify a comparable method.'),changed:false};
}
