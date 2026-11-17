import {readFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';import {isDeepStrictEqual as same} from 'node:util';
import {capabilityRevision} from '../../core/src/worker-release';
import {rangedComparisonChecks,rangedEntryProofChecks} from '../../practice/src/ranged-progression-case';
import {readPracticeSave} from '../../../scripts/measure/fleet-player-save';
import {deliveryFingerprint} from './delivery-cli';import type {DeliveryTask} from './delivery';
import {registerProgressionQualification} from './progression-qualification';

/** Reuse the native producer's saved-entry, state-band and asset checks without running gameplay. */
export function verifyRegisteredRangedProof(folder:string,proof:any,base:string){
 const log=readFileSync(join(folder,'worker.log'),'utf8'),lines=log.split(/\r?\n/).filter(l=>l.startsWith('RANGED_TRAIN_RESULT '));
 if(lines.length!==1)throw Error('method artifact needs exactly one raw worker result');
 const result=JSON.parse(lines[0]!.slice('RANGED_TRAIN_RESULT '.length)),frozen=rangedEntryProofChecks(readFileSync(join(folder,'entry.json')),proof,result);
 return{checks:{...rangedComparisonChecks(readPracticeSave(join(folder,'before.sav')),readPracticeSave(join(folder,'after.sav')),result,log,proof.code,proof.target,frozen.entry),
  supportedMethods:frozen.supportedMethods,rawResult:same(proof.result,result),proofSource:proof.proofSource===createHash('sha256').update(readFileSync(join(base,'packages/practice/src/ranged-progression-case.ts'))).digest('hex')}};
}
export async function registerAcceptedProgressionDelivery(task:DeliveryTask,delivery:{ok:boolean;directory?:string},base:string,practiceRoot?:string,additionalProof?:{directory:string;practiceRoot?:string}){
 if(task.id!=='ranged-train'||!delivery.ok)return{registered:0,index:''};
 if(!delivery.directory)throw Error('accepted progression delivery has no evidence directory');
 return registerProgressionQualification(delivery.directory,{base,practiceRoot,additionalProof,task,fingerprint:t=>deliveryFingerprint(t,base),runtimeRevision:t=>capabilityRevision([t.entry],base),verifyProof:(folder,proof)=>verifyRegisteredRangedProof(folder,proof,base)});
}
