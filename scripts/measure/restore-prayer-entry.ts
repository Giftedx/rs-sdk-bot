// Practice-only entry fixture for the AIO altar route: spend native Prayer points with the existing finite hold,
// confirm logout, then run the logistics dispatcher on the drained account. No live endpoint is admitted.
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {openBot,releasePrayerGuard,serverFromEnv,settle} from '../../packages/core/src/bot';
import {isLocalServer} from '../../packages/core/src/localserver';
import {holdPrayer} from '../microbot-c-qol';
import {runAioLogistics} from '../aio-logistics';

const root=resolve(import.meta.dir,'../..'),name=process.argv[2]??'';
if(!/^[A-Za-z0-9]{1,12}$/.test(name))throw Error('practice prayer fixture requires an account');
const server=serverFromEnv(readFileSync(resolve(root,'vendor/rs-sdk/bots',name,'bot.env'),'utf8'));
if(!isLocalServer(server))throw Error('prayer entry fixture refuses a live endpoint');
let cancelled=false;
const cancel=()=>{cancelled=true;};
process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
const stopped=()=>cancelled||existsSync(resolve(root,'.practice','stop-all'))||existsSync(resolve(root,'.practice',`stop-${name}`));
const s=await openBot(name,{onStop:async()=>cancel(),onSessionEnd:async()=>cancel()});
let drained=false;
try{
 await releasePrayerGuard(s);
 const before=s.sdk.getSkill('Prayer')?.level??0;
 const r=await holdPrayer(s,10,35,stopped);
 const after=s.sdk.getSkill('Prayer')?.level??0;
 drained=r.ok&&!stopped()&&after>0&&after<before;
 console.log('PRAYER_RESTORE_ENTRY '+JSON.stringify({before,after,drained}));
}finally{drained=await settle([s],drained,'practice Prayer entry drain');}
if(!drained||stopped()){console.log('RESULT fail practice Prayer drain or cancellation');process.exit(1);}
const result=await runAioLogistics(name,['restore-prayer','ALTAR=3243,3205'],{...process.env,PRAYER_GUARD:'0'});
process.exit(/^RESULT ok(?: |$)/.test(result)&&!stopped()?0:1);
