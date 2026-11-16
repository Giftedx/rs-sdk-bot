// Qualify bank observation before the enclosing recovery proof acquires its private-world turn.
import {writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {deliveryTask,runDeliveryTask} from '../../router/src/delivery-cli';
if(import.meta.main){
 if(!process.env.DELIVERY_DIR)throw Error('outer delivery required');
 const side=process.env.FLEET_SIDE;
 let result:Awaited<ReturnType<typeof runDeliveryTask>>;
 try{process.env.FLEET_SIDE='local';result=await runDeliveryTask(deliveryTask('owned-bank-observation'));}
 finally{if(side===undefined)delete process.env.FLEET_SIDE;else process.env.FLEET_SIDE=side;}
 if(!result.ok)throw Error('bank observer qualification failed; retain inner delivery');
 const path=join(result.directory,'report.json'),sha256=createHash('sha256').update(readFileSync(path)).digest('hex');
 writeFileSync(join(process.env.DELIVERY_DIR,'bank-observer-qualification.json'),JSON.stringify({path,sha256}));
}
