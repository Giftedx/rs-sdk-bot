// Shared owned-transfer admission: merged assignments, endpoint ownership, newest logout proof and journal keys.
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ownedAccounts} from '../packages/core/src/tradeguard';
import {readLogoutProof} from '../packages/core/src/session-lifecycle';
import {fleetStateFile} from '../packages/core/src/practice-paths';
import {assertAccountOwnership,assertRecoverableStatus} from './handoff-inputs';

export function transferOrderKey(value:string,label='transfer order'){
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(value))throw Error('invalid '+label);
 return value;
}

// An authenticated transfer keeps fleet state, swarm assignments, and latest logout proof
// authoritative, including for hosted workers whose status has no RESULT line.
export function checkTransferAccounts(root:string,names:readonly string[],server:string,open:readonly {name:string}[],runId:string,
 io:{owned?:(server:string)=>ReadonlySet<string>;logoutState?:(name:string,server:string)=>string}={}){
 const dir=join(root,'.practice'),read=(file:string)=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
 const state=read(fleetStateFile(root));
 if(!state)throw Error('fleet account ownership unavailable');
 const jobs=existsSync(join(root,'swarm.json'))?JSON.parse(readFileSync(join(root,'swarm.json'),'utf8')).jobs:undefined;
 assertAccountOwnership([...names],state,jobs,n=>existsSync(join(dir,'stop-'+n)),runId);
 const owned=(io.owned??ownedAccounts)(server),logoutState=io.logoutState??((name,host)=>readLogoutProof(name,host).state);
 for(const name of names){
  if(!owned.has(name.toLowerCase()))throw Error('not authenticated owned: '+name);
  if(!open.some(s=>s.name.toLowerCase()===name.toLowerCase())){
   const state=logoutState(name,server);
   if(state==='confirmed')continue;
   if(state!=='none')throw Error('account session ownership unsettled: '+name+' ('+state+')');
   assertRecoverableStatus(read(join(dir,'status',name+'.json')),null,()=>true);
  }
 }
}
