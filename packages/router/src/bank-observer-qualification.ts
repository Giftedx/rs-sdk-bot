// Qualify bank observation before the enclosing recovery proof acquires its private-world turn.
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ADMISSION_WAIT_ENV,deliveryTask,runDeliveryTask} from './delivery-cli';
import {HOST_DEFERRED_EXIT} from '../../core/src/memory';
// The longest wait of the native admission of the inner delivery. The timeout of this check in
// packages/router/tasks/session-recovery-only.json is 10 minutes: the wait is under half of it, so the wait ends as a
// host deferral (exit 75 below) with time left, and not as a killed check.
export const INNER_ADMISSION_WAIT_MS=300000;
// The exit of this check for an inner delivery that ended for the host (no memory, a busy practice turn): the host
// deferral exit, which the outer delivery reads as a deferral. Any other failure of the inner delivery throws.
export function qualificationExit(result:{ok:boolean;hostDeferred?:boolean;reason:string}):{exit:number;message:string}|null{
 if(result.ok)return null;
 const text=result.reason.replace(/^Error: /,''),prefix='HOST_DEFERRED_NATIVE_HEADROOM:';
 return result.hostDeferred===true?{exit:HOST_DEFERRED_EXIT,message:text.startsWith(prefix)?text:prefix+' '+text}:null;
}
if(import.meta.main){
 if(!process.env.DELIVERY_DIR)throw Error('outer delivery required');
 const side=process.env.FLEET_SIDE;
 let result:Awaited<ReturnType<typeof runDeliveryTask>>;
 try{
  process.env.FLEET_SIDE='local';
  process.env[ADMISSION_WAIT_ENV]=String(Math.min(INNER_ADMISSION_WAIT_MS,Number(process.env[ADMISSION_WAIT_ENV])||INNER_ADMISSION_WAIT_MS));
  result=await runDeliveryTask(deliveryTask('owned-bank-observation'));
 }
 finally{if(side===undefined)delete process.env.FLEET_SIDE;else process.env.FLEET_SIDE=side;}
 const deferred=qualificationExit(result);
 if(deferred){console.error(deferred.message);process.exit(deferred.exit);}
 if(!result.ok)throw Error('bank observer qualification failed; retain inner delivery');
 const path=join(result.directory,'report.json'),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
 writeFileSync(join(process.env.DELIVERY_DIR,'bank-observer-qualification.json'),JSON.stringify({path,sha256}));
}
