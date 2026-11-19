// Whether an account began a login attempt after a time, from the session lifecycle (packages/core/src/session-lifecycle.ts).
// `latest.json` of each account holds the creation time of its newest attempt. The goal value (goal-work.ts) keeps the
// last bank read of an account whose session ended until a newer attempt begins: nothing else changes a closed bank.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {accountDir} from '../../core/src/session-lifecycle';

export const LIVE_SERVER='rs-sdk-demo.fly.dev';
type Hook=(account:string,at:number)=>boolean;
/** True when a login attempt began after `at`, or when that cannot be excluded (no record, an unreadable record). */
export function loginAfterOf(root:string,server=LIVE_SERVER,ttlMs=30_000,now:()=>number=Date.now):Hook{
 const cache=new Map<string,{read:number;at:number|null}>();
 const latest=(account:string):number|null=>{
  const key=account.toLowerCase(),hit=cache.get(key);
  if(hit&&now()-hit.read<ttlMs)return hit.at;
  let at:number|null=null;
  try{
   const pointer=JSON.parse(readFileSync(join(accountDir(account,server,join(root,'.practice','session-lifecycle')),'latest.json'),'utf8'));
   if(Number.isFinite(pointer?.at)&&pointer.at>0)at=pointer.at;
  }catch{/* no record or an invalid identity: a newer attempt cannot be excluded */}
  cache.set(key,{read:now(),at});return at;
 };
 return (account,at)=>{const newest=latest(account);return newest===null||newest>at;};
}
const hooks=new Map<string,Hook>();
/** One hook for each checkout root, so the 30 s cache lives as long as the process. */
export const loginAfter=(root:string):Hook=>{let hook=hooks.get(root);if(!hook){hook=loginAfterOf(root);hooks.set(root,hook);}return hook;};
