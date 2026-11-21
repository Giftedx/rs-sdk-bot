import { expect, test } from 'bun:test';
import { tripSize, safeSpawnWalk, nonWildernessBanks } from './gather-spawn';
import { wildernessLevel } from '../packages/core/src/prayer-guard';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

test('a stack trip takes all that is left; other items fill the free slots', () => {
    expect(tripSize(176, false, 20)).toBe(20);
    expect(tripSize(5, false, 20)).toBe(5);
    expect(tripSize(2000, true, 2)).toBe(2000);
    expect(tripSize(-3, true, 9)).toBe(0);
});

async function runCli(mode:'complete'|'partial'|'error'|'missing-credit'|'world-error'|'close-error'){
 const root=resolve(import.meta.dir,'..'),directory=resolve(root,'.practice/catalog-useful-gaps/unit-fixtures');
 mkdirSync(directory,{recursive:true});
 const preload=resolve(directory,`gather-${process.pid}-${mode}.ts`);
 writeFileSync(preload,`import {mock} from 'bun:test';
const mode=${JSON.stringify(mode)};let tick=0,pack=[],bank=0,generation=0,opened=false,calls=0;
const state=()=>({player:{worldX:3185,worldZ:3436,level:0},inventory:pack,bank:{isOpen:opened,items:[]}});
const session={name:'fixture',tick:()=>tick,onTick:()=>()=>{},ended:new Promise(()=>{}),client:{objType:()=>({stackable:false})},
 sdk:{getState:state,getInventory:()=>pack},bankObservation:()=>generation?{generation,items:bank?[{id:1573,name:'Doogle leaves',count:bank}]:[]}:null,
 bot:{openBank:async()=>{opened=true;generation++;return{success:true};},closeBank:async()=>{opened=false;if(mode==='close-error')throw Error('bank close after credit failed');if(mode==='partial')tick=1000;},
 depositItem:async()=>{const n=pack.reduce((total,item)=>total+item.count,0);pack=[];if(mode!=='missing-credit')bank+=n;generation++;return{success:true};}}};
mock.module(${JSON.stringify(resolve(root,'packages/core/src/bot.ts'))},()=>({openBot:async()=>session,getWorld:async()=>{if(mode==='world-error')throw Error('world unavailable');return{};},accountOf:()=>({}),countItems:()=>0,
 finish:async(_sessions,ok,detail)=>{console.log('TEST_FINAL '+JSON.stringify({ok,detail,bank,calls}));process.exitCode=ok?0:1;}}));
mock.module(${JSON.stringify(resolve(root,'packages/core/src/gather.ts'))},()=>({gatherItems:async()=>{calls++;tick++;if(calls>1&&mode==='error')throw Error('collector fault after bank');pack=[{id:1573,name:'Doogle leaves',count:mode==='complete'||mode==='close-error'?2:1,slot:0}];return null;}}));
mock.module(${JSON.stringify(resolve(root,'packages/core/src/walk.ts'))},()=>({goTo:async()=>({ok:true})}));
mock.module(${JSON.stringify(resolve(root,'packages/core/src/ticks.ts'))},()=>({waitUntil:async(_s,test,options)=>{for(let i=0;i<(options?.timeoutTicks??20);i++){if(test(state()))return true;tick++;}return test(state());}}));
mock.module(${JSON.stringify(resolve(root,'scripts/quest-sweep.ts'))},()=>({nearestBanks:()=>[{x:3185,z:3436,level:0}]}));
`);
 const child=Bun.spawn([process.execPath,'--preload',preload,resolve(root,'scripts/gather-spawn.ts'),'fixture','1573','2'],
  {cwd:root,env:{...process.env,TICKS:'100'},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),10000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const line=stdout.split(/\r?\n/).find(line=>line.startsWith('TEST_FINAL '));
  if(!line)throw Error(`CLI result missing: code=${code} ${stdout} ${stderr}`);
  return{code,...JSON.parse(line.slice('TEST_FINAL '.length))};
 }finally{clearTimeout(timer);}
}

test('ground gather CLI succeeds only after the complete target has paired bank credits',async()=>{
 const result=await runCli('complete');expect(result.code).toBe(0);expect(result.ok).toBe(true);expect(result.bank).toBe(2);
 expect(result.detail).toContain('banked=2');
});
test('ground gather CLI retains partial banked progress but fails an unmet target',async()=>{
 const result=await runCli('partial');expect(result.ok).toBe(false);expect(result.code).toBe(1);expect(result.bank).toBe(1);
 expect(result.detail).toContain('targetMet=false');expect(result.detail).toContain('remaining=1');
});
test('ground gather CLI preserves a collector error after an earlier useful bank trip',async()=>{
 const result=await runCli('error');expect(result.ok).toBe(false);expect(result.code).toBe(1);expect(result.bank).toBe(1);
 expect(result.detail).toContain('collector fault after bank');expect(result.detail).toContain('remaining=1');
});
test('ground gather CLI cannot count a pack debit without its bank credit',async()=>{
 const result=await runCli('missing-credit');expect(result.ok).toBe(false);expect(result.bank).toBe(0);
 expect(result.detail).toContain('pack debit/bank credit unobserved');
});
test('ground gather CLI settles its owned session when world loading fails',async()=>{
 const result=await runCli('world-error');expect(result.ok).toBe(false);expect(result.code).toBe(1);expect(result.calls).toBe(0);
 expect(result.detail).toContain('world unavailable');expect(result.detail).toContain('remaining=2');
});
test('ground gather CLI retains a confirmed credit when bank closing fails',async()=>{
 const result=await runCli('close-error');expect(result.ok).toBe(false);expect(result.code).toBe(1);expect(result.bank).toBe(2);
 expect(result.detail).toContain('banked=2');expect(result.detail).toContain('remaining=0');expect(result.detail).toContain('bank close after credit failed');
});

test('safeSpawnWalk and nonWildernessBanks block Wilderness coordinates by default',async()=>{
 const visited:{x:number;z:number;level:number}[]=[];
 const fakeSession={sdk:{getState:()=>({player:{worldX:2552,worldZ:3574,level:0},skills:[],inventory:[],equipment:[]}),getInventory:()=>[]},bankObservation:()=>null} as unknown as Parameters<typeof safeSpawnWalk>[0];
 const fakeWorld={} as Parameters<typeof safeSpawnWalk>[1];
 const fakeMove=async(_s:unknown,_w:unknown,to:{x:number;z:number;level:number})=>{visited.push(to);return{ok:true};};
 const guarded=safeSpawnWalk(fakeSession,fakeWorld,false,fakeMove);
 expect(await guarded({x:3214,z:3809,level:0})).toEqual({ok:false,reason:'wilderness',detail:'refused Wilderness spawn 3214,3809,0'});
 expect(await guarded({x:3148,z:3671,level:0})).toEqual({ok:false,reason:'wilderness',detail:'refused Wilderness spawn 3148,3671,0'});
 expect(await guarded({x:3090,z:9930,level:0})).toEqual({ok:false,reason:'wilderness',detail:'refused Wilderness spawn 3090,9930,0'});
 expect(visited).toEqual([]);
 expect(await guarded({x:2262,z:3168,level:0})).toEqual({ok:true});
 expect(await guarded({x:2552,z:3574,level:0})).toEqual({ok:true});
 expect(visited).toEqual([{x:2262,z:3168,level:0},{x:2552,z:3574,level:0}]);
 const allowed=safeSpawnWalk(fakeSession,fakeWorld,true,fakeMove);
 expect(await allowed({x:3214,z:3809,level:0})).toEqual({ok:true});
 expect(nonWildernessBanks([{x:2618,z:3332},{x:3092,z:3957},{x:2727,z:3493}],false)).toEqual([{x:2618,z:3332},{x:2727,z:3493}]);
});

async function runRealGatherCli(id:number,start:{x:number;z:number;level:number}){
 const root=resolve(import.meta.dir,'..'),directory=resolve(root,'.practice/catalog-useful-gaps/unit-fixtures');
 mkdirSync(directory,{recursive:true});
 const preload=resolve(directory,`gather-nowild-${process.pid}-${id}-${start.x}.ts`);
 writeFileSync(preload,`import {mock} from 'bun:test';
const walked=[];
const state=()=>({player:{worldX:${start.x},worldZ:${start.z},level:${start.level}},inventory:[],groundItems:[],nearbyLocs:[]});
const session={name:'fixture',tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),client:{objType:()=>({stackable:false})},
 sdk:{getState:state,getInventory:()=>[]},bankObservation:()=>null,
 bot:{openBank:async()=>({success:true}),closeBank:async()=>({success:true})}};
mock.module(${JSON.stringify(resolve(root,'packages/core/src/bot.ts'))},()=>({openBot:async()=>session,getWorld:async()=>({}),accountOf:()=>({skills:{},varps:{},items:[]}),countItems:()=>0,
 finish:async(_sessions,ok,detail)=>{console.log('TEST_WILD_GUARD '+JSON.stringify({ok,detail,walked}));process.exitCode=ok?0:1;}}));
mock.module(${JSON.stringify(resolve(root,'packages/core/src/walk.ts'))},()=>({goTo:async(_s,_w,to)=>{walked.push(to);return{ok:true};}}));
mock.module(${JSON.stringify(resolve(root,'packages/core/src/ticks.ts'))},()=>({waitUntil:async()=>false,waitTicks:async()=>{}}));
mock.module(${JSON.stringify(resolve(root,'scripts/quest-sweep.ts'))},()=>({nearestBanks:()=>[{x:2618,z:3332,level:0},{x:2727,z:3493,level:0}]}));
`);
 const child=Bun.spawn([process.execPath,'--preload',preload,resolve(root,'scripts/gather-spawn.ts'),'fixture',String(id),'27'],
  {cwd:root,env:{...process.env,TICKS:'100'},windowsHide:true,stdout:'pipe',stderr:'pipe'});
 const timer=setTimeout(()=>child.kill(),15000);
 try{
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  const line=stdout.split(/\r?\n/).find(l=>l.startsWith('TEST_WILD_GUARD '));
  if(!line)throw Error(`CLI guard result missing: code=${code} ${stdout} ${stderr}`);
  return{code,...JSON.parse(line.slice('TEST_WILD_GUARD '.length)) as {ok:boolean;detail:string;walked:{x:number;z:number;level:number}[]}};
 }finally{clearTimeout(timer);}
}

test('ground gather CLI never walks to Wilderness white-berry (239) or plank (960) spawns when mainland spawns stall',async()=>{
 const berries=await runRealGatherCli(239,{x:2262,z:3168,level:0});
 expect(berries.ok).toBe(false);
 expect(berries.walked.length).toBeGreaterThan(0);
 expect(berries.walked.every(t=>wildernessLevel(t.x,t.z)===0)).toBe(true);
 expect(berries.walked.some(t=>t.x===3214||t.x===3218)).toBe(false);

 const planks=await runRealGatherCli(960,{x:2552,z:3574,level:0});
 expect(planks.ok).toBe(false);
 expect(planks.walked.length).toBeGreaterThan(0);
 expect(planks.walked.every(t=>wildernessLevel(t.x,t.z)===0)).toBe(true);
 expect(planks.walked.some(t=>t.x===3148||t.x===3154)).toBe(false);

 const badStart=await runRealGatherCli(239,{x:3214,z:3809,level:0});
 expect(badStart.ok).toBe(false);
 expect(badStart.walked).toEqual([]);
 expect(badStart.detail).toContain('refused Wilderness position');
});
