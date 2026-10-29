import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {questItemsConsumerChecks,parseItemResult,cookLiveJobSavedChecks,cookLiveRepeatSavedChecks,COOK_JOB_NATIVE_NULL_VARPS} from '../src/quest-items-order-proof';
const save=(pack:{id:number;count:number}[],bank:{id:number;count:number}[],vars:Record<number,number>={})=>({version:9,position:{x:3092,z:3243,level:0},skills:[{index:3,level:10,rawExperience:11540,xp:1154}],vars,inventories:{93:pack.map((i,slot)=>({...i,slot})),95:bank.map((i,slot)=>({...i,slot}))}});
const products=[{id:1944,count:1},{id:1927,count:1},{id:1933,count:1}],asset={id:1351,count:1};
const before=save([asset],[{id:1925,count:1},{id:1931,count:1}]),gathered=save(products,[asset]),after=save([],[asset],{29:2,101:1});
const worker={code:0,log:'LOGOUT logged-out\nQUEST_ITEMS_ORDER_RESULT '+JSON.stringify({ok:true,logout:true,child:{ok:true}})};
const consumer={code:0,log:'LOGOUT logged-out\nLOGOUT logged-out\nQUEST_ORDER_RESULT '+JSON.stringify({ok:true,stages:{quest:{ok:true},bank:{ok:true}}})};
const repeat={code:1,log:'LOGOUT logged-out\nQUEST_COOK_JOB_RESULT '+JSON.stringify({ok:false,logout:true,detail:'Error: quest already complete',ticks:0})};
test('native null seeds match the pinned permanent non-integer varp definitions',()=>{
 const root=new URL('../../../vendor/rs-sdk/server/content/',import.meta.url);
 const pack=readFileSync(new URL('pack/varp.pack',root),'utf8').split(/\r?\n/);
 const definitions=[
  [4,'ownedmcannon','quests/quest_mcannon/configs/quest_mcannon.varp','coord'],
  [9,'beehive_free','areas/area_seers/configs/bees.varp','boolean'],
  [13,'hemenster_pipe_stashed','quests/quest_fishingcompo/configs/quest_fishingcompo.varp','boolean'],
  [16,'arhein_crate_coord','quests/quest_arthur/configs/quest_arthur.varp','coord'],
  [28,'ikov_icearrowchest_coord','quests/quest_ikov/configs/quest_ikov.varp','coord'],
  [64,'exit_essence_mine_coord','skill_runecraft/configs/essence_mine.varp','coord'],
  [181,'fluffs_crate','quests/quest_fluffs/configs/quest_fluffs.varp','coord'],
  [209,'macro_event_target_coord','macro events/configs/antimacro.varp','coord'],
 ] as const;
 expect(Object.keys(COOK_JOB_NATIVE_NULL_VARPS).map(Number)).toEqual(definitions.map(([id])=>id));
 for(const [id,name,path,type] of definitions){
  expect(pack).toContain(`${id}=${name}`);
  const section=readFileSync(new URL('scripts/'+path,root),'utf8').split(`[${name}]`)[1]!.split('[')[0]!;
  expect(section).toContain('scope=perm');expect(section).toContain('type='+type);
  expect(COOK_JOB_NATIVE_NULL_VARPS[id]).toBe(-1);
 }
});
test('completed repeat permits only the server logout clock to change',()=>{
 const nulls=Object.fromEntries(Object.entries(COOK_JOB_NATIVE_NULL_VARPS).map(([id,value])=>[id,value>>>0]));
 const b=save([asset],[{id:995,count:123}],{...nulls,29:2,101:1,134:2556});
 const a:typeof b={...b,vars:{...b.vars,134:2610}};
 expect(Object.values(cookLiveRepeatSavedChecks(b,a,repeat)).every(Boolean)).toBe(true);
 for(const id of [29,101,4,9,13,16,28,64,181,209,202,203,281]){
  expect(cookLiveRepeatSavedChecks(b,{...a,vars:{...a.vars,[id]:(a.vars[id]??0)+1}},repeat).vars).toBe(false);
 }
 for(const id of [93,94,95]){
  const changed={...a,inventories:{...a.inventories,[id]:[{slot:0,id:995,count:124}]}};
  expect(cookLiveRepeatSavedChecks(b,changed,repeat).assets).toBe(false);
 }
 expect(cookLiveRepeatSavedChecks(b,{...a,inventories:{...a.inventories,93:[{...a.inventories[93]![0]!,slot:1}]}},repeat).assets).toBe(false);
 const omitted={...a,vars:{...a.vars}};delete omitted.vars[4];
 expect(cookLiveRepeatSavedChecks(b,omitted,repeat).vars).toBe(false);
 for(const field of ['level','xp','rawExperience'] as const){
  const changed={...a,skills:a.skills.map(s=>({...s,[field]:s[field]+1}))};
  expect(cookLiveRepeatSavedChecks(b,changed,repeat).skills).toBe(false);
 }
 expect(cookLiveRepeatSavedChecks(b,a,{...repeat,code:0}).refusal).toBe(false);
 expect(cookLiveRepeatSavedChecks(b,a,{...repeat,log:repeat.log.replace('quest already complete','missing container 1925')}).refusal).toBe(false);
 expect(cookLiveRepeatSavedChecks(b,a,{...repeat,log:repeat.log.replace('LOGOUT logged-out','LOGOUT timeout')}).refusal).toBe(false);
});
test('consumer needs acquired items, saved quest credit, consumed items and both logout owners',()=>{
 expect(parseItemResult(worker.log)?.ok).toBe(true);
 expect(Object.values(questItemsConsumerChecks(before,gathered,after,worker,consumer)).every(Boolean)).toBe(true);
 expect(questItemsConsumerChecks(before,gathered,save(products,[asset],{29:2,101:1}),worker,consumer).quest).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,save([],[asset],{29:2}),worker,consumer).quest).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,after,worker,{...consumer,log:consumer.log.replace('LOGOUT logged-out\n','')}).consumer).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,save([],[],{29:2,101:1}),worker,consumer).assets).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,save([],[asset,{id:995,count:1}],{29:2,101:1}),worker,consumer).assets).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,{...after,inventories:{...after.inventories,94:[{slot:0,id:1351,count:1}]}},worker,consumer).equipment).toBe(false);
 expect(questItemsConsumerChecks(save(products,[]),gathered,after,worker,consumer).acquired).toBe(false);
 expect(questItemsConsumerChecks(before,gathered,after,{...worker,code:1},consumer).worker).toBe(false);
 expect(questItemsConsumerChecks(before,save(products,[]),after,worker,consumer).gathered).toBe(false);
 expect(parseItemResult('QUEST_ITEMS_ORDER_RESULT broken')).toBeNull();
});
test('successful logout cannot substitute for a successful gather child',()=>{
 const failed={code:0,log:'LOGOUT logged-out\nQUEST_ITEMS_ORDER_RESULT '+JSON.stringify({ok:true,logout:true})};
 expect(questItemsConsumerChecks(before,gathered,after,failed,consumer).worker).toBe(false);
});

test('ordinary CLI proof checks saved reward and all assets independently of a claimed success',()=>{
 const b={...before,skills:[...before.skills,{index:7,level:1,rawExperience:0,xp:0}]};
 const a={...after,skills:[...after.skills,{index:7,level:20,rawExperience:75000,xp:7500}]};
 const r={code:0,log:'LOGOUT logged-out\nQUEST_COOK_JOB_RESULT '+JSON.stringify({ok:true,logout:true,gather:{ok:true},quest:{ok:true},checks:{quest:true},before:{},after:{}})};
 expect(Object.values(cookLiveJobSavedChecks(b,a,r)).every(Boolean)).toBe(true);
 expect(cookLiveJobSavedChecks(b,{...a,skills:b.skills},r).reward).toBe(false);
 expect(cookLiveJobSavedChecks(b,{...a,vars:{29:2}},r).questPoints).toBe(false);
 expect(cookLiveJobSavedChecks(b,{...a,inventories:{93:[],95:[]}},r).assets).toBe(false);
 expect(cookLiveJobSavedChecks(b,a,{...r,log:r.log.replace('LOGOUT logged-out','LOGOUT timeout')}).worker).toBe(false);
});
