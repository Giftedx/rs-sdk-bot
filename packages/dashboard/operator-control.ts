// Operator requests use the coordinator's durable inbox, never its mutable state.
import {existsSync,readFileSync,readdirSync,mkdirSync,statSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {GOALS,addTasks,type CoordTask} from '../router/src/coordinator';
import {atomicJson,spawnDetached} from '../router/src/coordinator-store';
import {NAMES} from '../core/src/names';
import {controllerStates} from '../core/src/controllers';
import {validateDelivery} from '../router/src/delivery';
import {appendOwnerRequest,applyCommand,validateCommand,REQUEST_MAX} from './publish-commands';

export function createOperatorControl(options:{root:string;readOnly?:boolean;nonce?:string;alive?:(pid:number)=>boolean;spawn?:typeof spawnDetached}){
 const {root}=options,nonce=options.nonce??randomUUID(),directory=join(root,'.practice/coordinator'),audit=join(root,'.practice/dashboard-controls');
 const alive=options.alive??((pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}}),spawn=options.spawn??spawnDetached;
 const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
 const owned=()=>{const path=join(root,'vendor/rs-sdk/bots');return existsSync(path)?readdirSync(path,{withFileTypes:true}).filter(n=>n.isDirectory()&&/^[A-Za-z0-9]{1,12}$/.test(n.name)).map(n=>n.name):[];};
 // The stop files of owned accounts, from one listing of .practice: the fleet has thousands of account folders and few holds.
 const held=()=>{let names:string[]=[];try{names=readdirSync(join(root,'.practice'));}catch{/* no folder yet */}return names.filter(n=>/^stop-[A-Za-z0-9]{1,12}$/.test(n)).map(n=>n.slice(5)).filter(name=>{try{return statSync(join(root,'vendor/rs-sdk/bots',name)).isDirectory();}catch{return false;}});};
 function catalog(){return readdirSync(join(root,'packages/router/tasks')).filter(n=>/^[-a-z0-9]+\.json$/.test(n)).map(n=>{
  // A task file that another process is writing is not readable yet: the list leaves it out.
  try{const d=read(join(root,'packages/router/tasks',n));return{id:d.id,goal:d.goal,entry:d.entry,consumer:d.consumer,files:d.files,checks:(d.checks??[]).map((c:any)=>({id:c.id,phase:c.phase,timeoutMs:c.timeoutMs}))};}catch{return null;}
 }).filter(c=>c!==null);}
 function metadata(){
  const inbox=join(directory,'requests');
  let coordinatorRunning=false;
  try{const owner=read(join(directory,'owner.json'));coordinatorRunning=Number.isSafeInteger(owner.pid)&&owner.pid>0&&alive(owner.pid);}catch{}
  // The fleet agent and the autopilot (packages/core/src/controllers.ts): `down` means that nothing runs it and no owner stop explains that.
  const controllers=controllerStates(root,{alive}).map(c=>({name:c.name,label:c.label,state:c.state,seenAt:c.seenAt}));
  return{nonce,readOnly:!!options.readOnly,coordinatorRunning,controllers,goals:GOALS,roles:Object.keys(NAMES).filter(n=>n!=='main'),paused:existsSync(join(root,'.practice/stop-coordinator')),fleetPaused:existsSync(join(root,'.practice/stop-swarm')),capabilities:catalog(),
   accountHolds:held().map(name=>{let text='';try{text=readFileSync(join(root,'.practice','stop-'+name),'utf8');}catch{}return{name,owner:text.startsWith('dashboard-stop:')?'dashboard':'other'};}),
   requests:existsSync(audit)?readdirSync(audit).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>{
    try{const r=read(join(audit,n)),file=join(inbox,r.id+'.request.json');return{id:r.id,action:r.action,at:r.at,taskId:r.taskId??null,status:r.action==='queue'?(existsSync(file+'.accepted')?'accepted':existsSync(file+'.rejected')?'rejected':'submitted'):r.status};}catch{return null;}
   }).filter(r=>r!==null).sort((a,b)=>b.at-a.at).slice(0,30):[]};
 }
 return async(req:Request,remote:string)=>{
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return Response.json({error:'Local operator access only'},{status:403});
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(req.url).hostname))return Response.json({error:'Use the local dashboard address'},{status:403});
  if(req.method==='GET')return Response.json(metadata(),{headers:{'cache-control':'no-store'}});
  if(req.method!=='POST')return new Response('Method not allowed',{status:405});
  if(options.readOnly)return Response.json({error:'This dashboard is read-only; commands are disabled'},{status:403});
  const url=new URL(req.url);
  if(req.headers.get('origin')!==url.origin||req.headers.get('x-atlas-control')!==nonce)return Response.json({error:'Reload the local dashboard before sending a command'},{status:403});
  if(!req.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON command required'},{status:415});
  try{
   const bytes=await req.text();if(bytes.length>32768)throw Error('Command exceeds 32 KiB');
   const input=JSON.parse(bytes),id=input.id;
   if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9-]{27}$/.test(id))throw Error('Command identity required');
   const action=input.action;if(!['plan','pause','resume','queue','account-pause','account-release','request','swarm-pause','swarm-resume','job-disable','job-enable'].includes(action))throw Error('Unknown operator command');
   mkdirSync(audit,{recursive:true});const receipt=join(audit,id+'.json');
   if(existsSync(receipt)){const prior=read(receipt);if(prior.input!==bytes)throw Error('Command identity was already used for different input');return Response.json(prior);}
   let taskId:string|undefined,fleetStatus:string|undefined;
   if(action==='queue'){
    const task=input.task as CoordTask;if(!task||!['build','qualify','provision','review','run'].includes(task.kind))throw Error('Supported task kind required');
    if(task.kind==='provision'&&!Object.hasOwn(NAMES,task.role??''))throw Error('Choose a registered account role');
    if(task.id!=='operator-'+id)throw Error('Task must use its command identity');
    const capabilities=catalog(),definition=input.definition;
    const inbox=join(directory,'requests'),file=join(inbox,id+'.request.json'),proposal={reason:'Local operator: '+task.why,capabilities:definition?[definition]:[],tasks:[task]};
    const priorFile=[file,file+'.accepted',file+'.rejected'].find(existsSync);
    if(definition){validateDelivery(definition);if(task.kind!=='build'||definition.id!==task.capability||(capabilities.some(c=>c.id===definition.id)&&!priorFile))throw Error('A new definition needs a new build capability');if(definition.files.some((f:string)=>! /^(scripts|packages\/(core|practice|planner))\//.test(f)))throw Error('Capability files must belong to gameplay modules');}
    if(task.kind!=='provision'&&!definition&&!capabilities.some(c=>c.id===task.capability))throw Error('Choose a registered capability');
    const state=read(join(directory,'state.json'));
    if(priorFile){if(JSON.stringify(read(priorFile))!==JSON.stringify(proposal))throw Error('Command identity conflicts with the existing inbox entry');}
    else addTasks(structuredClone(state),[task]);
    if(task.kind==='run'){
     if(task.launch!=='ordinary')throw Error('Use an ordinary account; protected launches remain with their route owner');
     if(!task.dependsOn.some(dep=>state.tasks.some((r:any)=>r.spec.id===dep&&r.spec.capability===task.capability&&r.status==='succeeded'&&r.receipt?.output?.delivery?.ok)))throw Error('A successful same-capability qualification must be a dependency');
    }
    mkdirSync(inbox,{recursive:true});
    // A disconnected browser may replay the same command after this atomic write.
    for(const candidate of [file,file+'.accepted',file+'.rejected'])if(existsSync(candidate)&&JSON.stringify(read(candidate))!==JSON.stringify(proposal))throw Error('Command identity conflicts with the existing inbox entry');
    if(![file,file+'.accepted',file+'.rejected'].some(existsSync))atomicJson(file,proposal);taskId=task.id;
   }else if(action==='account-pause'||action==='account-release'){
    if(typeof input.account!=='string'||!/^[A-Za-z0-9]{1,12}$/.test(input.account)||!owned().includes(input.account))throw Error('Choose an owned account');
    const file=join(root,'.practice','stop-'+input.account);
    if(action==='account-pause'){if(!existsSync(file))writeFileSync(file,'dashboard-stop:'+id,{flag:'wx'});}
    else{if(!existsSync(file)||!readFileSync(file,'utf8').startsWith('dashboard-stop:'))throw Error('This hold belongs elsewhere; inspect it before changing it');unlinkSync(file);}
   }else if(['swarm-pause','swarm-resume','job-disable','job-enable'].includes(action)){
    // The fleet actions the hosted dashboard also sends: stop files and swarm.json under the plan-write lock.
    const cmd=validateCommand({id,action,at:Date.now(),account:input.account});
    if(cmd.account&&!owned().includes(cmd.account))throw Error('Choose an owned account');
    const out=await applyCommand(cmd,{root});
    if(out.status==='refused')throw Error(out.note??'Refused');
    fleetStatus=out.status;
   }else if(action==='request'){
    if(typeof input.text!=='string'||!input.text.trim()||input.text.length>REQUEST_MAX)throw Error(`A request needs text of up to ${REQUEST_MAX} characters`);
    appendOwnerRequest(root,input.text);
   }else if(action==='plan'){
    if(existsSync(join(root,'.practice/stop-coordinator'))||existsSync(join(root,'.practice/stop-swarm')))throw Error('Coordinator is paused; resume it before requesting a plan');
    mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'plan-request'),'local operator requested a fresh plan');
   }else if(action==='pause')writeFileSync(join(root,'.practice/stop-coordinator'),'owner pause from dashboard '+new Date().toISOString());
   else{
    if(existsSync(join(root,'.practice/stop-swarm')))throw Error('Fleet stop is still set; this command only resumes the coordinator');
    const owner=existsSync(join(directory,'owner.json'))?read(join(directory,'owner.json')):null;
    if(owner?.pid&&alive(owner.pid))throw Error('Coordinator is still running or draining; wait for it to stop');
    if(!existsSync(join(root,'.practice/stop-coordinator')))throw Error('Coordinator is not paused');
    if(!read(join(root,'swarm.json')).coordination?.enabled)throw Error('Coordination is disabled in the fleet plan');
    unlinkSync(join(root,'.practice/stop-coordinator'));
    try{spawn([process.execPath,'packages/router/src/coordinator-cli.ts','--run','operator-'+id],root,join(directory,'operator.out.log'),join(directory,'operator.err.log'));}
    catch(error){writeFileSync(join(root,'.practice/stop-coordinator'),'resume failed; owner pause retained');throw error;}
   }
   const result={id,action,taskId,at:Date.now(),status:fleetStatus??(action==='queue'?'submitted':action==='pause'||action==='account-pause'?'stop-requested':action==='account-release'?'dashboard-hold-released':action==='resume'?'start-requested':action==='request'?'request-recorded':'plan-requested'),input:bytes};
   atomicJson(receipt,result);return Response.json(result);
  }catch(error){return Response.json({error:error instanceof Error?error.message:String(error)},{status:400});}
 };
}
