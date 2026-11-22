import {writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startStack,type StackOptions} from '../stack';
import {canBind} from '../ports';
import {rsSdkRoot} from '../paths';
import {runBotName} from '../prove';
import {killTree} from '../../../core/src/proc';
import {readPracticeSave} from '../fleet-player-save';
import {questSweepExpectedExit,type CaseRecord,type Save} from './fixtures';

const root=resolve(import.meta.dir,'../../../..');

export function questSweepProofEndpoints(ports:{engine:number;gateway:number;management:number;tcp:number},instance:string){
 const values=[ports?.engine,ports?.gateway,ports?.management,ports?.tcp];
 if(!values.every(p=>Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![8888,7780,8898,43594].includes(p))
  ||new Set(values).size!==4||!/^quest-sweep-[a-z0-9]{20}$/.test(instance))throw Error('owned practice endpoints required');
 const server=`127.0.0.1:${ports.engine}`,gateway=`ws://127.0.0.1:${ports.gateway}`;
 return{ports:{...ports},instance,server,gateway,env:{AGENT_PORT:String(ports.gateway),GATEWAY_URL:`http://127.0.0.1:${ports.gateway}`,
  WEB_MANAGEMENT_PORT:String(ports.management),NODE_PORT:String(ports.tcp),GE_DATABASE:`data/market-${instance}.sqlite`}};
}
export type ProofEndpoints=ReturnType<typeof questSweepProofEndpoints>;
export function selectQuestSweepProofEndpoints(bind:typeof canBind=canBind,random:()=>number=Math.random){
 for(let i=0;i<100;i++){
  const engine=20000+Math.floor(random()*20000),ports={engine,gateway:engine+1,management:engine+2,tcp:engine+3};
  if(Object.values(ports).every(bind))return questSweepProofEndpoints(ports,'quest-sweep-'+randomUUID().replaceAll('-','').slice(0,20));
 }
 throw Error('owned practice ports unavailable');
}
export function selectFreshQuestSweepProofName(caseIndex:number,occupied:(name:string)=>boolean=name=>existsSync(join(rsSdkRoot(),'bots',name)),
 candidate:(attempt:number)=>string=()=>runBotName('qsw',caseIndex),maxCandidates=8){
 for(let attempt=0;attempt<maxCandidates;attempt++){
  const name=candidate(attempt);
  if(!occupied(name))return name;
 }
 throw Error(`fresh quest-sweep practice account unavailable after ${maxCandidates} candidates`);
}
export function questSweepProofAccountEnv(text:string,p:ProofEndpoints){
 const servers=text.match(/^SERVER=.*$/gm)??[],gateways=text.match(/^GATEWAY_URL=.*$/gm)??[];
 if(servers.length!==1||!/^SERVER=localhost(?::8888)?\r?$/.test(servers[0]!)
  ||gateways.length>1||gateways.some(line=>!/^GATEWAY_URL=ws:\/\/localhost:7780\r?$/.test(line)))throw Error('new practice account required');
 const local=text.replace(/^SERVER=.*$/gm,`SERVER=${p.server}`);
 return gateways.length?local.replace(/^GATEWAY_URL=.*$/gm,`GATEWAY_URL=${p.gateway}`):`${local.trimEnd()}\nGATEWAY_URL=${p.gateway}\n`;
}
export async function startQuestSweepProofStack(p:ProofEndpoints,start:(opts:StackOptions)=>ReturnType<typeof startStack>=startStack,tickMs=150){
 const previous=Object.fromEntries(Object.keys(p.env).map(k=>[k,process.env[k]]));
 try{Object.assign(process.env,p.env);return await start({ports:p.ports,instance:p.instance,tickMs,readyTimeoutMs:60000});}
 finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
export function questSweepChildConfiguration(name:string,quest:string,p:ProofEndpoints,inherited:NodeJS.ProcessEnv=process.env){
 return{cmd:['bun','scripts/quest-sweep.ts',name,quest],cwd:root,windowsHide:true,
  env:{...inherited,...p.env,GATEWAY_URL:p.gateway,QUEST_SWEEP_OBSERVE_BANK:'',RANDOM_EVENTS:'0',LOOT_WATCH:'0'}};
}

type ProofChild={pid:number;stdout:ReadableStream<Uint8Array>;stderr:ReadableStream<Uint8Array>;exited:Promise<number>};
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
function collect(stream:ReadableStream<Uint8Array>){
 const reader=stream.getReader(),decoder=new TextDecoder(),parts:string[]=[];
 const done=(async()=>{try{for(;;){const {value,done}=await reader.read();if(done)break;parts.push(decoder.decode(value,{stream:true}));}}catch{}})();
 return{done,text:()=>parts.join(''),cancel:()=>{reader.cancel().catch(()=>{});}};
}
// One case child: bounded exit and pipe drain, then the log, the saved match, the after snapshot and the retained record.
// A child that times out or ends with an unexpected exit rejects here, so the caller's turn cleanup runs before any later case.
export async function runQuestSweepProofCase(o:{dir:string;record:CaseRecord;save:string;timeoutMs:number;spawn:()=>ProofChild;
 matched:()=>Promise<boolean>;retain:()=>void;kill?:(pid:number)=>Promise<void>;drainMs?:number}){
 const {record}=o,t=Date.now(),drainMs=o.drainMs??10000,kill=o.kill??killTree;
 let out:ReturnType<typeof collect>|undefined,err:ReturnType<typeof collect>|undefined,failure='';
 try{
  const p=o.spawn();out=collect(p.stdout);err=collect(p.stderr);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<number>(resolve=>{timer=setTimeout(async()=>{
   record.timedOut=true;await kill(p.pid).catch(()=>{});
   resolve(await Promise.race([p.exited,delay(drainMs).then(()=>-1)]));
  },o.timeoutMs);});
  try{record.exit=await Promise.race([p.exited,expired]);}finally{clearTimeout(timer);}
  await Promise.race([Promise.all([out.done,err.done]),delay(drainMs)]);
 }catch(error){failure=String(error);}
 finally{
  out?.cancel();err?.cancel();
  writeFileSync(join(o.dir,record.id+'.log'),(out?.text()??'')+'\n--stderr--\n'+(err?.text()??'')+(failure?'\n--proof--\n'+failure:''));
  try{record.saveMatched=await o.matched();}catch(error){failure||=String(error);}
  try{
   copyFileSync(o.save,join(o.dir,record.id+'-after.sav'));
   if(record.id==='elena-heckel-dust'){
    const observed=(s:Save)=>({position:s.position,magic:s.skills[6],pack:s.inventories[93],bank:s.inventories[95]});
    console.log('QUEST_SWEEP_ELENA_OBSERVED '+JSON.stringify({before:observed(readPracticeSave(join(o.dir,record.id+'-before.sav'))),after:observed(readPracticeSave(o.save))}));
   }
  }catch(error){failure||=String(error);}
  record.seconds=Math.round((Date.now()-t)/1000);o.retain();
 }
 const expected=questSweepExpectedExit(record.id);
 if(failure||record.timedOut||record.exit!==expected)
  throw Error(`quest-sweep proof case ${record.id} failed: exit=${record.exit} expected=${expected} timedOut=${record.timedOut} saveMatched=${record.saveMatched}${failure?' '+failure:''}; later cases skipped`);
 return record;
}
