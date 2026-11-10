import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export interface OrderJournalEntry<TOrder=unknown,TResult=unknown>{
 state:'started'|'completed'|'failed';
 at:number;
 pid:number;
 account:string;
 key:string;
 order:TOrder;
 settledAt?:number;
 result?:TResult;
}

export function validateOrderIdentity(account:string,key:string,label='order'){
 if(!/^[A-Za-z0-9_-]{1,12}$/.test(account)||!/^[A-Za-z0-9_-]{1,64}$/.test(key))throw Error(`invalid ${label} identity`);
}

export function claimOrderJournal<TOrder>(dir:string,account:string,key:string,order:TOrder,now=Date.now(),label='order'):string{
 validateOrderIdentity(account,key,label);
 const folder=join(dir,account.toLowerCase()),path=join(folder,key+'.json');
 mkdirSync(folder,{recursive:true});
 const entry:OrderJournalEntry<TOrder>={state:'started',at:now,pid:process.pid,account,key,order};
 try{
  writeFileSync(path,JSON.stringify(entry),{flag:'wx'});
 }catch(e){
  if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
  let state='unreadable';
  try{state=JSON.parse(readFileSync(path,'utf8')).state;}catch{/* unreadable entry remains uncertain */}
  throw Error(state==='completed'?`${label} ${key} already completed; duplicate refused`:`${label} ${key} has uncertain output (${state}); no retry`);
 }
 return path;
}

export function settleOrderJournal<TResult extends {ok:boolean}>(path:string,result:TResult,project?:(r:TResult)=>unknown,now=Date.now(),label='order'):void{
 const entry=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
 if(entry?.state!=='started'||entry.pid!==process.pid)throw Error(`${label} journal ownership changed`);
 writeFileSync(path,JSON.stringify({...entry,state:result.ok?'completed':'failed',settledAt:now,result:project?project(result):result}));
}
