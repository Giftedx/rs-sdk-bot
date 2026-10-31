import {expect,test,spyOn} from 'bun:test';
import * as owner from '../packages/core/src/bot';
import * as items from './quest-items-order';
import * as cook from './generated/quest-cook';
import * as walking from '../packages/core/src/walk';
import {setEquipmentObserved} from '../packages/core/src/container-observation';
import * as hetty from './generated/quest-hetty';
import * as runeSupply from './rune-supply';
import {hettyJobChecks,cookJobChecks,parseCookJobArgs,runQuestCookJob,runQuestHettyJob,type CookJobSnapshot} from './quest-cook-job';

const snapshot=(overrides:Partial<CookJobSnapshot>={}):CookJobSnapshot=>({
 account:'helper1',position:{x:3092,z:3242,level:0},hp:49,lifeId:0,respawns:0,
 quest:'not started',qp:0,cookingXp:0,equipment:[],bankGeneration:1,
 pack:[{id:1925,count:1},{id:1931,count:1},{id:379,count:3}],bank:[{id:995,count:123}],...overrides,
});
const before=snapshot(),after=snapshot({quest:'complete',qp:1,cookingXp:300,
 pack:[],bank:[{id:995,count:123},{id:379,count:3}],bankGeneration:5});

test('live CLI takes an account and a bounded CAP, with no privileged save argument',()=>{
 expect(parseCookJobArgs(['helper1'],'2400')).toEqual({name:'helper1',cap:2400});
 for(const args of [[],['helper1','--save=private.sav'],['bad-name']])expect(()=>parseCookJobArgs(args,'2400')).toThrow();
 for(const cap of ['0','NaN','1.5'])expect(()=>parseCookJobArgs(['helper1'],cap)).toThrow();
});
test('Hetty is an optional bounded quest argument; Cook retains its one-account shape',()=>{
 expect(parseCookJobArgs(['helper1','hetty'],'6000')).toEqual({name:'helper1',cap:6000,quest:'hetty'});
 expect(()=>parseCookJobArgs(['helper1','hetty'],'6001')).toThrow();
 expect(()=>parseCookJobArgs(['helper1','goblin'],'6000')).toThrow();
});
test('observed completion needs credit, reward, health, exact kit costs and retained food/assets',()=>{
 expect(Object.values(cookJobChecks(before,after)).every(Boolean)).toBe(true);
 for(const change of [
  {quest:'started' as const},{qp:0},{cookingXp:0},{hp:0},{lifeId:1},
  {bankGeneration:1},{account:'other1'},{equipment:[{id:1351,count:1,slot:0}]},
  {bank:[{id:995,count:123},{id:379,count:2}]},
  {bank:[{id:995,count:124},{id:379,count:3}]},
  {pack:[{id:1925,count:1}]},
 ])expect(Object.values(cookJobChecks(before,snapshot({...after,...change}))).every(Boolean)).toBe(false);
 expect(cookJobChecks(snapshot({quest:'complete'}),after).entry).toBe(false);
});
test('owned ingredients and surplus are used once; no new acquisition is claimed',()=>{
 const stocked=snapshot({pack:[{id:1944,count:2},{id:1927,count:1},{id:1933,count:1}],bank:[]});
 expect(Object.values(cookJobChecks(stocked,snapshot({...after,bank:[{id:1944,count:1}]}))).every(Boolean)).toBe(true);
 expect(cookJobChecks(stocked,snapshot({...after,bank:[]})).ingredients).toBe(false);
});

test('actual owner retains both children, checks observed effects and settles once on each exit',async()=>{
 for(const failure of ['', 'gather','quest','close','logout','complete','missing']){
  let colour=failure==='complete'?0x00f800:0xf80000,generation=1,xp=0,settlements=0;
  const client={ingame:true,varServ:{101:0},ifType:()=>({colour})};setEquipmentObserved(client,true);
  const state:any={player:{name:'helper1',hp:49,lifeId:0,respawnCount:0,level:0,worldX:3092,worldZ:3242},
   inventory:[{id:1925,count:1},{id:1931,count:1},{id:379,count:3}],equipment:[]};
  let bank: any[]=[{id:995,count:123}];if(failure==='missing')state.inventory=state.inventory.filter((i:any)=>i.id!==1925);
  const s:any={name:'helper1',client,tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),
   sdk:{getState:()=>state,getSkillXp:()=>xp,getDialog:()=>({isOpen:false})},
   bankObservation:()=>({generation,items:bank,at:1}),
   bot:{openBank:async()=>{generation++;return{success:true};},closeBank:async()=>({success:failure!=='close'})}};
  const open=spyOn(owner,'openBot').mockResolvedValue(s);
  const gather=spyOn(items,'gatherQuestItems').mockImplementation(async(_s,_key,start,_cap,options)=>{
   expect(start).toBeNull();options?.onBank?.(s.bankObservation());
   if(failure==='gather')throw Error('interrupted gather');
   state.inventory=[{id:1944,count:1},{id:1927,count:1},{id:1933,count:1}];bank=[{id:995,count:123},{id:379,count:3}];generation++;
   return {ok:true,ticks:1,pack:state.inventory};
  });
  const complete=spyOn(cook,'completeCook').mockImplementation(async()=>{
   if(failure==='quest')throw Error('hand-in failed');
   colour=0x00f800;client.varServ[101]=1;xp=7500;state.inventory=[];
   return {ok:true,detail:'observed'};
  });
  const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
  const walk=spyOn(walking,'walkPath').mockResolvedValue({ok:true,ticks:1,detail:'arrived'} as any);
  const settle=spyOn(owner,'settle').mockImplementation(async(_sessions,ok,_detail,options)=>{
   settlements++;if(failure!=='logout')options?.log?.('LOGOUT logged-out');
   expect(ok).toBe(!failure||failure==='logout');return true;
  });
  try{
   const result=await runQuestCookJob('helper1',2400);
   expect(result.ok).toBe(failure==='');expect(settlements).toBe(1);
   if(!failure)expect(result).toMatchObject({gather:{ok:true},quest:{ok:true},logout:true});
   if(['gather','missing','complete'].includes(failure))expect(complete).not.toHaveBeenCalled();
  }finally{for(const spy of [open,gather,complete,walker,walk,settle])spy.mockRestore();}
 }
});

test('Hetty checks exact price-limited purchases, reward, inputs, assets and life',()=>{
 const b=snapshot({magicXp:0,pack:[{id:1277,count:1}],bank:[{id:995,count:25}]});
 const a=snapshot({...b,quest:'complete',qp:1,magicXp:8125,bank:[{id:995,count:21}],bankGeneration:2});
 const prices=[{id:221,coins:3},{id:2132,coins:1}];
 expect(Object.values(hettyJobChecks(b,a,prices)).every(Boolean)).toBe(true);
 for(const change of [{magicXp:8124},{qp:0},{quest:'started' as const},{lifeId:1},{hp:0},{pack:[]},{bank:[{id:995,count:20}]}]){
  expect(Object.values(hettyJobChecks(b,{...a,...change},prices)).every(Boolean)).toBe(false);
 }
 expect(hettyJobChecks(b,a,[...prices,prices[0]!]).purchases).toBe(false);
 const stocked=snapshot({...b,pack:[{id:1277,count:1},{id:300,count:2},{id:2142,count:2},{id:221,count:2},{id:1957,count:2}]});
 const retained=snapshot({...a,pack:[{id:1277,count:1},{id:300,count:1},{id:2142,count:1},{id:221,count:1},{id:1957,count:1}],bank:b.bank});
 expect(Object.values(hettyJobChecks(stocked,retained,[])).every(Boolean)).toBe(true);
});

test('Hetty session leaves Tutorial Island with the bounded starter helper before quest observation and acquisition',async()=>{
 const grant=[[1351,1],[590,1],[303,1],[315,1],[1925,1],[1931,1],[2309,1],[1265,1],[1205,1],[1277,1],[1171,1],[841,1],[882,25],[556,25],[558,15],[555,6],[557,4],[559,2]].map(([id,count])=>({id:id!,count:count!}));
 for(const failure of ['','starter','identity']){
  // Registration state: Tutorial Island start, empty pack and bank, no quest list.
  let colour:number|undefined,generation=1,magic=0,settlements=0;const calls:string[]=[];
  const client={ingame:true,varServ:{101:0},ifType:()=>colour===undefined?undefined:{colour}};setEquipmentObserved(client,true);
  const state:any={player:{name:failure==='identity'?'other1':'helper1',hp:10,lifeId:0,respawnCount:0,level:0,worldX:3094,worldZ:3106},inventory:[],equipment:[]};
  let bank:any[]=[];
  const s:any={name:'helper1',client,tick:()=>0,onTick:()=>()=>{},ended:new Promise(()=>{}),
   sdk:{getState:()=>state,getSkillXp:(skill:string)=>skill==='Magic'?magic:0,getDialog:()=>({isOpen:false})},
   bankObservation:()=>({generation,items:bank,at:1}),
   bot:{openBank:async()=>{generation++;return{success:true};},closeBank:async()=>({success:true})}};
  const open=spyOn(owner,'openBot').mockResolvedValue(s);
  const starter=spyOn(runeSupply,'leaveRuneStarter').mockImplementation(async(_s,stop)=>{
   calls.push('starter');expect(stop()).toBe(false);
   if(failure==='starter')throw Error('starter entry deadline: mainland, tutorial grant or dialogue unobserved');
   Object.assign(state.player,{worldX:3222,worldZ:3218});state.inventory=grant.map(i=>({...i}));bank=[{id:995,count:25}];colour=0xf80000;
  });
  const gather=spyOn(items,'gatherQuestItems').mockImplementation(async(_s,key,start,_cap,options)=>{
   calls.push('gather');expect(key).toBe('hetty');expect(start).toBeNull();options?.onBank?.(s.bankObservation());
   state.inventory=[...state.inventory,{id:1957,count:1},{id:221,count:1},{id:2146,count:1}];bank=[{id:995,count:21}];generation++;
   return {ok:true,ticks:1,pack:state.inventory,purchases:[{id:221,coins:3},{id:2132,coins:1}]} as any;
  });
  const complete=spyOn(hetty,'completeHetty').mockImplementation(async()=>{
   calls.push('quest');colour=0x00f800;client.varServ[101]=1;magic=8125;
   state.inventory=state.inventory.filter((i:any)=>![1957,221,2146].includes(i.id));
   return {ok:true,detail:'observed'} as any;
  });
  const walker=spyOn(walking,'sessionWalker').mockResolvedValue({} as any);
  const walk=spyOn(walking,'walkPath').mockResolvedValue({ok:true,ticks:1,detail:'arrived'} as any);
  const settle=spyOn(owner,'settle').mockImplementation(async(_sessions,ok,_detail,options)=>{
   settlements++;options?.log?.('LOGOUT logged-out');expect(ok).toBe(!failure);return true;
  });
  try{
   const result=await runQuestHettyJob('helper1',6000);
   expect(settlements).toBe(1);expect(result.logout).toBe(true);
   if(!failure){
    expect(result.ok).toBe(true);expect(calls).toEqual(['starter','gather','quest']);
    // The quest entry and costs start from the observed post-tutorial grant.
    expect(result.before?.position).toEqual({x:3222,z:3218,level:0});
    expect(result.before?.bank).toEqual([{id:995,count:25}]);
    expect(Object.values(result.checks!).every(Boolean)).toBe(true);
   }else{
    expect(result.ok).toBe(false);expect(gather).not.toHaveBeenCalled();expect(complete).not.toHaveBeenCalled();
    expect(calls).toEqual(failure==='starter'?['starter']:[]);
    expect(result.detail).toMatch(failure==='starter'?/starter entry deadline/:/identity mismatch/);
   }
  }finally{for(const spy of [open,starter,gather,complete,walker,walk,settle])spy.mockRestore();}
 }
});
