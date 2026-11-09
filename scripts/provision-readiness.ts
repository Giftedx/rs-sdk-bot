import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {serverFromEnv} from '../packages/core/src/bot';
import {assertSideOwns,loadOwners,mySide} from '../packages/core/src/fleet';
import {jobAccounts,mergedPlan,readCoordinatorJobs} from '../packages/core/src/coordinator-jobs';
import {liveLogoutRef} from '../packages/core/src/session-admission';
import {readLogoutProof} from '../packages/core/src/session-lifecycle';
import {SPECIALIST_BOARDS} from '../packages/core/src/specialist-launch';
import {LIVE_SERVER,loadEnded,loadHolds,openHold,persistentEnd} from './swarm';

const root=resolve(import.meta.dir,'..');
export type ProvisionCrew={accounts:string[];slots:number;script:string};

export function assertProvisionCrew(crew:ProvisionCrew,base=root){
 const {accounts,slots,script}=crew;
 if(!Array.isArray(accounts)||accounts.some(n=>typeof n!=='string'||! /^[A-Za-z0-9_ -]{1,12}$/.test(n))
  ||!Number.isSafeInteger(slots)||slots<=accounts.length||typeof script!=='string'||!script)
  throw Error('invalid first job crew');
 const overlay=readCoordinatorJobs(base);
 const owner=JSON.parse(readFileSync(join(base,'swarm.json'),'utf8')) as {jobs:any[];maxBots:number;coordination?:{maxLive?:number}};
 if(!Array.isArray(owner.jobs)||!Number.isSafeInteger(owner.maxBots))throw Error('owner assignment plan unavailable');
 const plan=mergedPlan(owner,overlay),limit=Math.min(plan.maxBots,plan.coordination?.maxLive??plan.maxBots);
 if(!Number.isSafeInteger(limit)||slots>limit)throw Error('first job exceeds the live account limit');
 if(!accounts.length)return;
 const selected=new Set(accounts.map(n=>n.toLowerCase()));
 if(selected.size!==accounts.length)throw Error('first job participants alias one account');
 const stops=new Set(readdirSync(join(base,'.practice')).map(n=>n.toLowerCase()));
 const ends=loadEnded(join(base,'.practice/swarm-deaths.json')),holds=loadHolds(join(base,'.practice/swarm-script-holds.json'));
 const owners=base===root?loadOwners():loadOwners(join(base,'fleet/owners.json'));
 for(const account of accounts){
  const name=account.toLowerCase(),matches=(job:any)=>jobAccounts(job).some(n=>n.toLowerCase()===name);
  if(stops.has('stop-'+name)||overlay.paused?.some(n=>n.toLowerCase()===name))throw Error('participant has an owner or rollout pause: '+account);
  if(name==='haggis'||Object.hasOwn(SPECIALIST_BOARDS,name)
   ||owner.jobs.some(job=>matches(job)&&(!job.script||/fresh.clock|24 boards|main simultaneous/i.test(job.goal??''))))
   throw Error('participant has a protected reservation: '+account);
  if(plan.jobs.some(job=>matches(job)&&job.enabled!==false))throw Error('participant already has an enabled assignment: '+account);
  if(owner.jobs.some(job=>job.orchestrate&&matches(job)&&jobAccounts(job).some(n=>!selected.has(n.toLowerCase()))))
   throw Error('participant belongs to a different composed assignment: '+account);
  const status=join(base,'.practice/status',account+'.json');
  const row=existsSync(status)?JSON.parse(readFileSync(status,'utf8')):null;
  const ended=[...ends].find(([n])=>n.toLowerCase()===name)?.[1];
  if(row?.server===LIVE_SERVER&&!row.result)throw Error('participant session not settled: '+account);
  if(ended&&persistentEnd(ended.reason)||openHold(holds,account,script))throw Error('participant needs verified recovery: '+account);
  assertSideOwns(account,mySide(),owners);
  const credentials=join(base,'vendor/rs-sdk/bots',account,'bot.env');
  if(!existsSync(credentials)||serverFromEnv(readFileSync(credentials,'utf8'))!==LIVE_SERVER)
   throw Error('participant live credentials unavailable: '+account);
  liveLogoutRef(account,base);
  const handJob=plan.jobs.some(job=>matches(job)&&job.coordinatorOwner!=='coordinator');
  if(handJob&&!(row?.server===LIVE_SERVER&&/^ok(?:\s|$)/.test(row.result??''))
   &&readLogoutProof(account,LIVE_SERVER,{root:join(base,'.practice/session-lifecycle')}).state!=='confirmed')
   throw Error('participant assignment is not confirmed complete: '+account);
 }
}
