import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {BotSDK} from '../../../vendor/rs-sdk/sdk/index';
import {BotActions} from '../../../vendor/rs-sdk/sdk/actions';
import {startInProcessSession} from '../src/inprocess';
import {getProgressionAdapter,requireProgressionAdapter,withProgressionAdapter,type ProgressionAdapter,type ProgressionCatalog,type ProgressionDecision,type ProgressionMethod} from '../src/progression-adapter';
import {methodSupportsWork} from '../src/progression-policy';
import {attachProgressionSession,evaluateProgressionWork,preflightProgressionWork} from '../src/progression-session';

function stubAdapter(calls:string[]):ProgressionAdapter{
 const step={script:'scripts/gather-combat.ts',args:['100','cow'],env:{TRAIN_SKILL:'Ranged',TARGET:'cow'}};
 const method:ProgressionMethod={id:'stub/cows',step,source:'stub-source',effects:{xp:{ranged:40}},rate:{unitsPerTick:1,basis:'model',evidence:'stub'},costs:{setupTicks:0,travelTicks:0,acquisitionTicks:0,unlockTicks:0}};
 const catalog:ProgressionCatalog={version:1,generatedBy:'stub',skills:['ranged'],routes:[],methods:[],quests:[],entries:[{script:'scripts/gather-combat.ts',intents:['train'],skills:['ranged'],routeIds:[]}]};
 const decision=(supportedMethod=true):ProgressionDecision=>({state:'execute',selected:supportedMethod?method.id:'other/method',step:supportedMethod?step:{script:'scripts/ranged-train.ts',args:['85'],env:{}},path:[],expectedTicks:10,basis:'model',alternatives:[],followUps:[],stateFingerprint:'stub',reason:'stub selection',gaps:[],search:{nodes:1,bound:10,depth:1,exhausted:false}});
 return {
  trainingTargets(intent){calls.push('trainingTargets');return intent.kind==='train'?{[intent.skill.toLowerCase()]:intent.targetLevel}:null;},
  intentForEntry(script){calls.push('intentForEntry:'+script);return {kind:'train',skill:'ranged',targetLevel:20};},
  loadProgressionCatalog(){calls.push('loadProgressionCatalog');return catalog;},
  accountFromStatus(account){calls.push('accountFromStatus:'+account);return {account,at:Date.now(),skills:{ranged:{level:1,xp:0}},inventory:null,equipment:null,bank:null,quests:null};},
  progressionMethods(){calls.push('progressionMethods');return {methods:[method],gaps:[]};},
  progressionStep(m){calls.push('progressionStep:'+m.id);return m.step;},
  chooseProgression(){calls.push('chooseProgression');return decision();},
  assessProgressionPerformance(){calls.push('assessProgressionPerformance');return {state:'within-range',observedRate:1,expectedRate:1,consecutiveSlow:0,reason:'stub'};},
  levelForXp(){calls.push('levelForXp');return 1;},
 };
}

test('requireProgressionAdapter fails without a registered adapter and withProgressionAdapter restores prior state',async()=>{
 const prior=getProgressionAdapter();
 expect(prior).toBeDefined();
 withProgressionAdapter(undefined,()=>{
  expect(getProgressionAdapter()).toBeUndefined();
  expect(()=>requireProgressionAdapter()).toThrow('progression adapter not registered');
  expect(()=>methodSupportsWork({script:'scripts/cannon-fight.ts',args:[],env:{STOP:'ranged=45'}},{script:'scripts/cannon-fight.ts',args:[],env:{STOP:'ranged=45'}})).toThrow('progression adapter not registered');
  expect(()=>preflightProgressionWork({script:'scripts/ranged-train.ts',args:['85'],env:{}},'rs-sdk-demo.fly.dev')).toThrow('progression adapter not registered');
  expect(()=>evaluateProgressionWork({script:'scripts/ranged-train.ts',args:['85'],env:{}},{name:'Fixture',at:Date.now()})).toThrow('progression adapter not registered');
 });
 expect(getProgressionAdapter()).toBe(prior);
 expect(()=>withProgressionAdapter(undefined,()=>{throw Error('boom');})).toThrow('boom');
 expect(getProgressionAdapter()).toBe(prior);
 await expect(withProgressionAdapter(undefined,async()=>{throw Error('async-boom');})).rejects.toThrow('async-boom');
 expect(getProgressionAdapter()).toBe(prior);
});

test('explicit ProgressionAdapter injection drives policy, session evaluation and session attachment cleanly',()=>{
 const calls:string[]=[];
 const custom=stubAdapter(calls);
 const work={script:'scripts/gather-combat.ts',args:['100','cow'],env:{TRAIN_SKILL:'Ranged',TARGET:'cow'}};
 expect(()=>preflightProgressionWork(work,'rs-sdk-demo.fly.dev',undefined,'Fixture',custom)).not.toThrow();
 const evaluated=evaluateProgressionWork(work,{name:'Fixture',at:Date.now(),skills:[{name:'Ranged',level:1,xp:0}]},{now:Date.now(),adapter:custom});
 expect(evaluated.supported).toBe(true);
 expect(evaluated.decision?.selected).toBe('stub/cows');
 const base=mkdtempSync(join(tmpdir(),'seam-attach-'));
 const state:any={inGame:true,player:{worldX:3253,worldZ:3421,level:0,combat:{inCombat:false}},skills:[{name:'Ranged',baseLevel:1,level:1,experience:0},{name:'Hitpoints',baseLevel:10,level:10,experience:1154}],inventory:[],equipment:[]};
 const s:any={name:'Fixture',sdk:{getState:()=>state},tick:()=>1,onTick:()=>()=>{},bankObservation:()=>null,ended:new Promise(()=>{})};
 try{
  const session=attachProgressionSession(s,work,'localhost:8888',{base,log:()=>{},adapter:custom});
  const current=session.refresh();
  expect(current?.decision?.selected).toBe('stub/cows');
  session.executing('stub/cows');
  expect(session.method()).toBe('stub/cows');
  expect(calls.some(c=>c==='loadProgressionCatalog')).toBe(true);
  expect(calls.some(c=>c==='chooseProgression')).toBe(true);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('startInProcessSession uses the preloaded default adapter and respects an injected progression adapter',async()=>{
 const repo=resolve(import.meta.dir,'../../..');
 const runWith=async(account:string,progression?:ProgressionAdapter)=>{
  const root=mkdtempSync(join(tmpdir(),'seam-inproc-'));
  const decisionFile=join(repo,'.practice/progression-system/decisions',account+'.json');
  const startSession:any=async(cfg:any)=>{
   let cb:(()=>void)|null=null;
   const client:any={
    ingame:true,
    collectBotState:(tick:number)=>({tick,inGame:true,player:{worldX:3222,worldZ:3218,level:0,combat:{inCombat:false}},skills:[{name:'Ranged',baseLevel:1,level:1,experience:0},{name:'Hitpoints',baseLevel:10,level:10,experience:1154}],inventory:[],equipment:[],gameMessages:[],opFeedback:{opRejectedCount:0}}),
    executeBotAction:()=>({success:true}),
    setOnGameTickCallback:(next:()=>void)=>{cb=next;},
    getMaxMessageLength:()=>400,
   };
   cfg.onClient(client);
   (cb as (()=>void)|null)?.();
   return {client,stop(){},stopped:Promise.resolve()};
  };
  const sdk=new BotSDK({botUsername:account,password:'x',autoLaunchBrowser:false,autoReconnect:false} as any);
  const session=await startInProcessSession(
   {name:account,password:'x',server:'localhost:8888',work:{script:'scripts/ranged-train.ts',args:['85'],env:{}}},
   {startSession,sdk,Actions:BotActions,cacheDir:root,lifecycle:{root},recordOwned:()=>{},progression},
  );
  try{
   const p=(session as typeof session&{progression?:ReturnType<typeof attachProgressionSession>}).progression;
   const current=p?.refresh();
   const blocked=await session.direct({type:'interactNpc',npcIndex:1,optionIndex:1});
   return {intent:current?.intent??null,decision:current?.decision??null,supported:current?.supported??null,blocked};
  }finally{
   await session.close();
   rmSync(root,{recursive:true,force:true});
   rmSync(decisionFile,{force:true});
  }
 };
 const defaultRun=await runWith('SeamDefault');
 expect(defaultRun.intent).toEqual({kind:'train',skill:'ranged',targetLevel:85});
 expect(defaultRun.decision?.state).toBe('observe');
 expect(defaultRun.decision?.followUps.length).toBeGreaterThan(0);
 expect(defaultRun.supported).toBe(true);

 const calls:string[]=[];
 const custom:ProgressionAdapter={...stubAdapter(calls),chooseProgression(){calls.push('chooseProgression');return {state:'execute',selected:'other/method',step:{script:'scripts/cannon-fight.ts',args:[],env:{STOP:'ranged=20'}},path:[],expectedTicks:10,basis:'model',alternatives:[],followUps:[],stateFingerprint:'stub',reason:'handoff to better route',gaps:[],search:{nodes:1,bound:10,depth:1,exhausted:false}};}};
 const customRun=await runWith('SeamCustom',custom);
 expect(customRun.intent).toEqual({kind:'train',skill:'ranged',targetLevel:20});
 expect(customRun.decision?.selected).toBe('other/method');
 expect(customRun.supported).toBe(false);
 expect(customRun.blocked).toMatchObject({success:false,reason:'progression_replan'});
 expect(calls).toContain('loadProgressionCatalog');
 expect(calls).toContain('chooseProgression');
});
