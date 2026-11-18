// Qualify bank observation before the enclosing recovery proof acquires its private-world turn.
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deliveryTask,runDeliveryTask} from './delivery-cli';
import {HOST_DEFERRED_EXIT} from '../../core/src/memory';
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
 try{process.env.FLEET_SIDE='local';result=await runDeliveryTask(deliveryTask('owned-bank-observation'));}
 finally{if(side===undefined)delete process.env.FLEET_SIDE;else process.env.FLEET_SIDE=side;}
 const deferred=qualificationExit(result);
 if(deferred){console.error(deferred.message);process.exit(deferred.exit);}
 if(!result.ok)throw Error('bank observer qualification failed; retain inner delivery');
 const path=join(result.directory,'report.json'),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
 writeFileSync(join(process.env.DELIVERY_DIR,'bank-observer-qualification.json'),JSON.stringify({path,sha256}));
}
