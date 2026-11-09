// Behaviour source: pinned Microbot-Hub actionreplay; BSD notice: research/microbot-ports-LICENSE.txt.
// bun scripts/microbot-action-replay.ts <account> <recording.json> <bindings.json> [repetitions=1] [cap=1200].
// Use --compile instead of the account to validate and print the graph without a login.
// Donor IDs/widgets are not native protocol inputs. Each recorded step needs a native action and effect.
import {existsSync,readFileSync} from 'node:fs';
import {openBot,finish} from '../packages/core/src/bot';
import type {Session} from '../packages/core/src/inprocess';
import {runActionGraph,sessionGraphIO,actionSessionOwner,finishActionSession,validateActionGraph,validateGraphCondition,type ActionGraph,type ActionNode,type GraphAction,type GraphCondition,type GraphEffect} from './microbot-a-actions';

type ReplayTarget='NPC'|'GAME_OBJECT'|'GROUND_ITEM'|'WALK';
export interface NativeReplayBinding{
 sourceType:ReplayTarget;
 sourceName?:string;
 sourceOption:string;
 action:GraphAction;
 effect:GraphEffect;
 timeout:number;
 conditionTarget?:{sourceName:string;id:number};
}
const record=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('recording object required');
 return value as Record<string,unknown>;
};
const text=(value:unknown)=>typeof value==='string'&&value.trim().length>0&&value.length<=128;
const same=(a:unknown,b:unknown)=>text(a)&&text(b)&&(a as string).trim().toLowerCase()===(b as string).trim().toLowerCase();
const nativeId=(id:unknown):id is number=>typeof id==='number'&&Number.isSafeInteger(id)&&id>=0;

function importCondition(value:unknown,target:NativeReplayBinding['conditionTarget']):GraphCondition|undefined{
 if(value===undefined||value===null)return undefined;
 const c=record(value);let condition:GraphCondition;
 if(c.type==='STAT'){
  if(!['HEALTH','PRAYER'].includes(c.stat as string)||!['ABOVE','BELOW'].includes(c.comparator as string))throw Error('unsupported recording stat condition');
  condition={kind:'stat',skill:c.stat==='HEALTH'?'Hitpoints':'Prayer',comparator:c.comparator==='ABOVE'?'above':'below',threshold:c.threshold as number};
 }else{
  if(!['INVENTORY','NPC_NEARBY','OBJECT_NEARBY'].includes(c.type as string)||!target||!same(target.sourceName,c.name)||typeof c.present!=='boolean'||!nativeId(target.id))throw Error('recording condition needs a matching name, native ID and complete presence policy');
  const id=target.id;
  if(c.type==='INVENTORY'){
   const minimum=c.minCount??1;if(typeof minimum!=='number'||!Number.isSafeInteger(minimum)||minimum>2147483647)throw Error('invalid recording inventory condition');
   condition={kind:'inventory',id,minimum:Math.max(1,minimum),present:c.present};
  }else condition={kind:c.type==='NPC_NEARBY'?'npc':'loc',id,radius:20,present:c.present};
 }
 return validateGraphCondition(condition);
}

export function importMicrobotRecording(value:unknown,bindings:NativeReplayBinding[],options:{repetitions:number;cap:number}):ActionGraph{
 const recording=record(value),actions=recording.actions;
 if(!text(recording.name)||!Array.isArray(actions)||actions.length<1||actions.length>1000||!Array.isArray(bindings)||bindings.length!==actions.length)throw Error('recording needs one native binding per step');
 if(!Number.isSafeInteger(options.repetitions)||options.repetitions<1||actions.length*options.repetitions>1000)throw Error('invalid finite recording repetitions');
 const mapped=actions.map((value,index)=>{
  const action=record(value),binding=bindings[index];if(!binding)throw Error('recording native binding missing');
  const kind={NPC:'npc',GAME_OBJECT:'loc',GROUND_ITEM:'ground-item',WALK:'walk'}[action.targetType as ReplayTarget];
  if(!kind||binding.sourceType!==action.targetType||binding.action?.kind!==kind||!same(binding.sourceOption,action.menuOption))throw Error('unsupported or mismatched recording action '+index);
  if(kind!=='walk'&&!same(binding.sourceName,action.targetName))throw Error('recording target name changed '+index);
  if((binding.action.kind==='npc'||binding.action.kind==='loc')&&!same(binding.action.option,action.menuOption))throw Error('recording native option changed '+index);
  if(kind==='ground-item'&&!same(action.menuOption,'Take'))throw Error('only native Take is a ground pickup');
  const delay=action.delayTicksBefore??0;
  if(typeof delay!=='number'||!Number.isSafeInteger(delay)||delay<0||delay>100000)throw Error('invalid recording tick delay');
  return{action:structuredClone(binding.action),effect:structuredClone(binding.effect),timeout:binding.timeout,delayTicksBefore:delay,condition:importCondition(action.condition,binding.conditionTarget)};
 });
 const length=mapped.length*options.repetitions;
 const nodes:ActionNode[]=Array.from({length},(_,index)=>({id:'replay_'+index,...structuredClone(mapped[index%mapped.length]!),...(index+1<length?{next:'replay_'+(index+1)}:{})}));
 return validateActionGraph({start:'replay_0',maximum:length,cap:options.cap,nodes});
}

if(import.meta.main){
 let session:Session|undefined,owner:ReturnType<typeof actionSessionOwner>|undefined,stopped=false;const compile=process.argv[2]==='--compile';
 try{
  const [account,recordingPath,bindingPath,repetitions,cap]=process.argv.slice(2);
  if(!account||!recordingPath||!bindingPath)throw Error('account, recording JSON and native bindings JSON required');
  const plan=importMicrobotRecording(JSON.parse(readFileSync(recordingPath,'utf8')),JSON.parse(readFileSync(bindingPath,'utf8')),{repetitions:Number(repetitions??1),cap:Number(cap??1200)});
  if(compile)console.log(JSON.stringify(plan,null,2));
  else{
   session=await openBot(account,{onStop:async()=>{stopped=true;}});owner=actionSessionOwner(session,()=>stopped);
   const result=await runActionGraph(sessionGraphIO(session,()=>stopped||existsSync('.practice/stop-microbot-actions')||existsSync('.practice/stop-microbot-replay')),plan);
   console.log('ACTION_REPLAY_RESULT '+JSON.stringify(result));await finishActionSession(owner,result.ok,JSON.stringify(result));
  }
 }catch(error){if(compile){console.error(String(error));process.exitCode=1;}else await finishActionSession(owner,false,String(error));}
}
