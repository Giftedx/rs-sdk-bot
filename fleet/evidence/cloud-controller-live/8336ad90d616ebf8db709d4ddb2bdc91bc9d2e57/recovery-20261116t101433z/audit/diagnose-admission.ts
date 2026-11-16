import {readFileSync,writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {fleetCheckoutId,fleetLeaseAllowsWorker} from '../../../packages/core/src/fleet-lease';
import {readLogoutProof,listAttempts} from '../../../packages/core/src/session-lifecycle';
import {LIVE_SERVER} from '../../../scripts/cloud-recover';
const root='/workspace/rs-sdk-bot',claims=JSON.parse(readFileSync(import.meta.dir+'/before-recovery/claims.json','utf8'));
const result={at:Date.now(),current:{host:hostname(),checkout:fleetCheckoutId(root),workerHolder:process.env.SWARM_LEASE_HOLDER??null,leaseAllows: fleetLeaseAllowsWorker(root)},actors:['FullLoad','Unsheathed'].map(account=>{
 const claim=claims.find((r:any)=>r.account===account.toLowerCase())?.claim,proof=readLogoutProof(account,LIVE_SERVER),producer=listAttempts(account,LIVE_SERVER).find(a=>a.attemptId===proof.attemptId)?.receipt?.owner;
 return{account,claim,proof,producer,comparison:{sameSide:claim?.side==='cloud',sameHost:claim?.host===hostname(),sameCheckout:claim?.checkout===fleetCheckoutId(root),sameNonce:producer?.sharedClaimNonce===claim?.nonce,samePid:producer?.pid===claim?.pid}};
})};writeFileSync(import.meta.dir+'/admission-diagnosis.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
