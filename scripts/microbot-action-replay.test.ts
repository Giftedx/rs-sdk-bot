import {test,expect} from 'bun:test';
import {importMicrobotRecording,type NativeReplayBinding} from './microbot-action-replay';
import {runActionGraph} from './microbot-a-actions';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const recording=()=>({name:'Owned rune pickup',actions:[{targetType:'GROUND_ITEM',targetName:'Nature rune',menuOption:'Take',identifier:99999,itemId:99999,targetX:999,targetY:999,targetPlane:3,delayTicksBefore:2,condition:{type:'INVENTORY',name:'Coins',present:true,minCount:1}}]});
const bindings=():NativeReplayBinding[]=>[{sourceType:'GROUND_ITEM',sourceName:'Nature rune',sourceOption:'Take',action:{kind:'ground-item',id:561,x:3001,z:3500,level:0,count:3},effect:{kind:'inventory',id:561,delta:3},timeout:5,conditionTarget:{sourceName:'Coins',id:995}}];

test('recording import uses explicit native bindings, finite repeats and donor delays/conditions',()=>{
 const graph=importMicrobotRecording(recording(),bindings(),{repetitions:2,cap:50});
 expect(graph).toMatchObject({start:'replay_0',maximum:2,cap:50});expect(graph.nodes).toHaveLength(2);
 expect(graph.nodes[0]).toMatchObject({next:'replay_1',delayTicksBefore:2,condition:{kind:'inventory',id:995,present:true,minimum:1},action:{kind:'ground-item',id:561,x:3001,z:3500,level:0,count:3}});
 expect(graph.nodes[1]!.next).toBeUndefined();expect(JSON.stringify(graph)).not.toContain('99999');
});

test('mapped recording runs through the real graph engine with tick delay and exact credit',async()=>{
 const graph=importMicrobotRecording(recording(),bindings(),{repetitions:2,cap:50});
 let tick=0,runes=0;const inputs:number[]=[];
 const result=await runActionGraph({tick:()=>tick,stopped:()=>false,read:()=>({inventory:{995:37,561:runes},skills:{},position:null}),dispatch:async()=>{inputs.push(tick);runes+=3;return true;},wait:async(predicate,budget)=>{for(let i=0;i<budget&&!predicate();i++)tick++;return predicate();}},graph);
 expect(result).toMatchObject({ok:true,steps:2,confirmed:2,skipped:0});expect(inputs).toEqual([2,4]);expect(runes).toBe(6);
});

test('recording import maps all supported target types without copying OSRS IDs',()=>{
 const kinds=[['NPC','Cow','Attack',{kind:'npc',id:81,option:'Attack'}],['GAME_OBJECT','Gate','Open',{kind:'loc',id:1558,option:'Open'}],['WALK',undefined,'Walk here',{kind:'walk',x:3200,z:3201}]] as const;
 for(const [type,name,option,action] of kinds){
  const graph=importMicrobotRecording({name:'mapped',actions:[{targetType:type,targetName:name,menuOption:option}]},[{sourceType:type,sourceName:name,sourceOption:option,action:{...action},effect:{kind:'position',x:3200,z:3201,level:0,tolerance:1},timeout:5}],{repetitions:1,cap:50});
  expect(graph.nodes[0]!.action).toEqual(action);
 }
});

test('recording conditions map native HP/Prayer, inventory and exact nearby IDs',()=>{
 for(const [condition,expected] of [
  [{type:'STAT',stat:'HEALTH',comparator:'BELOW',threshold:30},{kind:'stat',skill:'Hitpoints',comparator:'below',threshold:30}],
  [{type:'STAT',stat:'PRAYER',comparator:'ABOVE',threshold:10},{kind:'stat',skill:'Prayer',comparator:'above',threshold:10}],
  [{type:'NPC_NEARBY',name:'Cow',present:false},{kind:'npc',id:81,present:false,radius:20}],
  [{type:'OBJECT_NEARBY',name:'Gate',present:true},{kind:'loc',id:81,present:true,radius:20}],
  [{type:'INVENTORY',name:'Coins',present:false,minCount:0},{kind:'inventory',id:81,present:false,minimum:1}],
 ] as const){
  const r=recording();r.actions[0]!.condition=condition as any;const b=bindings();b[0]!.conditionTarget={sourceName:'name'in condition?condition.name:'unused',id:81};
  expect(importMicrobotRecording(r,b,{repetitions:1,cap:50}).nodes[0]!.condition).toEqual(expected);
 }
});

test('recording import rejects missing mappings, source drift, wrong action kinds and unsupported raw inputs',()=>{
 expect(()=>importMicrobotRecording(recording(),[],{repetitions:1,cap:50})).toThrow();
 for(const change of [{sourceType:'NPC'},{sourceName:'Law rune'},{sourceOption:'Examine'},{action:{kind:'walk',x:1,z:2}}]){
  const b=bindings();Object.assign(b[0]!,change);expect(()=>importMicrobotRecording(recording(),b,{repetitions:1,cap:50})).toThrow();
 }
 for(const targetType of ['PLAYER','WIDGET','UNKNOWN',undefined]){
  const r=recording();r.actions[0]!.targetType=targetType as any;expect(()=>importMicrobotRecording(r,bindings(),{repetitions:1,cap:50})).toThrow();
 }
 const r=recording();r.actions[0]!.menuOption='Examine';const b=bindings();b[0]!.sourceOption='Examine';expect(()=>importMicrobotRecording(r,b,{repetitions:1,cap:50})).toThrow();
});

test('malformed conditions, delays and unbounded playback fail before any execution',()=>{
 for(const change of [{delayTicksBefore:-1},{delayTicksBefore:1.5},{condition:{type:'STAT',stat:'MAGIC',comparator:'BELOW',threshold:1}},{condition:{type:'STAT',stat:'PRAYER',threshold:1}},{condition:{type:'INVENTORY',name:'Coins'}},{condition:{type:'JAVASCRIPT',code:'anything'}}]){
  const r=recording();Object.assign(r.actions[0]!,change);expect(()=>importMicrobotRecording(r,bindings(),{repetitions:1,cap:50})).toThrow();
 }
 const b=bindings();delete b[0]!.conditionTarget;expect(()=>importMicrobotRecording(recording(),b,{repetitions:1,cap:50})).toThrow();
 const stale=bindings();stale[0]!.conditionTarget!.sourceName='Bones';expect(()=>importMicrobotRecording(recording(),stale,{repetitions:1,cap:50})).toThrow();
 for(const repetitions of [0,1.5,Infinity,1001])expect(()=>importMicrobotRecording(recording(),bindings(),{repetitions,cap:50})).toThrow();
 expect(()=>importMicrobotRecording({name:'empty',actions:[]},[],{repetitions:1,cap:50})).toThrow();
});

test('compile CLI validates a donor JSON file without opening an account',()=>{
 const root=mkdtempSync(join(tmpdir(),'microbot-replay-test-')),recordingPath=join(root,'recording.json'),bindingPath=join(root,'bindings.json');
 try{
  writeFileSync(recordingPath,JSON.stringify(recording()));writeFileSync(bindingPath,JSON.stringify(bindings()));
  const run=()=>spawnSync(process.execPath,[join(import.meta.dir,'microbot-action-replay.ts'),'--compile',recordingPath,bindingPath,'2','50'],{encoding:'utf8',windowsHide:true,timeout:10000});
  const good=run();expect(good.status).toBe(0);expect(JSON.parse(good.stdout).nodes).toHaveLength(2);
  writeFileSync(bindingPath,'[]');const bad=run();expect(bad.status).toBe(1);expect(bad.stdout).toBe('');expect(bad.stderr).toContain('one native binding per step');
 }finally{unlinkSync(recordingPath);unlinkSync(bindingPath);rmdirSync(root);}
});


test('imported replay uses shared scalar owner and never settles a replacement',async()=>{
 const {sessionGraphIO,actionSessionOwner,finishActionSession}=await import('./microbot-a-actions');let tick=0,inputs=0,settlements=0;const player={worldX:3000,worldZ:3500,level:0,lifeId:1,respawnCount:0,isDead:false},client={selfSlot:1,executeBotAction:()=>({success:true})};const s:any={name:'ReplayOwned',client,ended:new Promise(()=>{}),tick:()=>tick,onTick:()=>()=>{},sdk:{getState:()=>({player,inventory:[],skills:[{name:'Hitpoints',level:99,experience:100}],prayers:{prayerPoints:99},nearbyNpcs:[],nearbyLocs:[]}),getInventory:()=>[],getSkill:()=>({level:99})},direct:async()=>{inputs++;return{success:true};}};const plan=importMicrobotRecording({name:'walk',actions:[{targetType:'WALK',menuOption:'Walk here',delayTicksBefore:1}]},[{sourceType:'WALK',sourceOption:'Walk here',action:{kind:'walk',x:3001,z:3500},effect:{kind:'position',x:3001,z:3500,level:0,tolerance:0},timeout:2}],{repetitions:1,cap:10});const owner=actionSessionOwner(s),io=sessionGraphIO(s,()=>false);const result=await runActionGraph({...io,wait:async()=>{tick++;player.lifeId++;return true;}},plan);expect(result.ok).toBe(false);expect(inputs).toBe(0);const old=process.exitCode;try{expect(await finishActionSession(owner,false,'replacement',async()=>{settlements++;})).toMatchObject({recoveryDeferred:true});expect(settlements).toBe(0);}finally{process.exitCode=old??0;}
});
