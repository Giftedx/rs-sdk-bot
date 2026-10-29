import {expect,test,spyOn} from 'bun:test';
import * as owner from '../packages/core/src/bot';
import * as items from './quest-items-order';
import * as cook from './generated/quest-cook';
import * as walking from '../packages/core/src/walk';
import {setEquipmentObserved} from '../packages/core/src/container-observation';
import {cookJobChecks,parseCookJobArgs,runQuestCookJob,type CookJobSnapshot} from './quest-cook-job';

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
