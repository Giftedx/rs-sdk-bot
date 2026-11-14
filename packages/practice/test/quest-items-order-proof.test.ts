import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {HETTY_MATCHED_ENTRY,hettyCarriedEntry,hettyLiveJobSavedChecks,hettyMainlandReady,hettyRegisteredEntry,hettyTutorialJobSavedChecks,tutorialGrantedSave,HETTY_TUTORIAL_GRANT,questItemsConsumerChecks,parseItemResult,cookLiveJobSavedChecks,cookLiveRepeatSavedChecks,COOK_JOB_NATIVE_NULL_VARPS,bindHettyFixtureIpv4,savedProofTimestampValid} from '../src/quest-items-order-proof';
import {practiceProfile} from '../src/register-proof-account';
import {runBotName} from '../src/prove';
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

test('Hetty proof rejects injected entry and reconciles saved effects independently',()=>{
 const b={...save([{id:1277,count:1}],[{id:995,count:25}]),position:{x:3222,z:3218,level:0},skills:Array.from({length:21},(_,index)=>({index,level:index===3?10:1,rawExperience:index===3?9800:0,xp:index===3?980:0}))};
 const a={...b,vars:{67:3,101:1},inventories:{...b.inventories,95:[{slot:0,id:995,count:21}]},skills:b.skills.map(k=>k.index===6?{...k,level:31,rawExperience:81250,xp:8125}:k)};
 const r={code:0,log:'LOGOUT logged-out\nQUEST_COOK_JOB_RESULT '+JSON.stringify({ok:true,questKey:'hetty',ticks:100,logout:true,gather:{ok:true,purchases:[{id:221,coins:3},{id:2132,coins:1}],transitions:[{from:2132,to:2142},{from:2142,to:2146}]},quest:{ok:true},checks:{alive:true},before:{lifeId:0,respawns:0},after:{lifeId:0,respawns:0}})};
 expect(hettyMainlandReady(b)).toBe(true);
 expect(hettyMainlandReady({...b,skills:a.skills})).toBe(false);
 expect(Object.values(hettyLiveJobSavedChecks(b,a,r)).every(Boolean)).toBe(true);
 expect(hettyLiveJobSavedChecks(b,{...a,vars:{67:3}},r).questPoints).toBe(false);
 expect(hettyLiveJobSavedChecks(b,{...a,skills:b.skills},r).reward).toBe(false);
 expect(hettyLiveJobSavedChecks(b,{...a,inventories:b.inventories},r).coins).toBe(false);
 const travel=[{id:'npc:captain_barnaby:brimhaven@2679,3275',coins:30,packBefore:80,packAfter:50},
  {id:'npc:customs_officer:port-sarim@2953,3147',coins:30,packBefore:50,packAfter:20}];
 const report=JSON.parse(r.log.split('QUEST_COOK_JOB_RESULT ')[1]!);report.gather.travel=travel;
 const paid={...a,inventories:{...a.inventories,95:[{slot:0,id:995,count:41}]}};
 const funded={...b,inventories:{...b.inventories,95:[{slot:0,id:995,count:105}]}};
 const worker={...r,log:'LOGOUT logged-out\nQUEST_COOK_JOB_RESULT '+JSON.stringify(report)};
 expect(Object.values(hettyLiveJobSavedChecks(funded,paid,worker)).every(Boolean)).toBe(true);
 expect(hettyLiveJobSavedChecks(funded,paid,r).coins).toBe(false);

 expect(hettyLiveJobSavedChecks(b,{...a,inventories:{93:[],95:a.inventories[95]}},r).assets).toBe(false);
 expect(hettyLiveJobSavedChecks(b,a,{...r,log:r.log.replace('LOGOUT logged-out','LOGOUT timeout')}).worker).toBe(false);
});

test('pinned tutorial_complete grant is the reconciled tutorial kit',()=>{
 const root=new URL('../../../vendor/rs-sdk/server/content/',import.meta.url);
 const ids=Object.fromEntries(readFileSync(new URL('pack/obj.pack',root),'utf8').split(/\r?\n/).map(l=>l.split('=')).map(([id,name])=>[name,Number(id)]));
 const label=readFileSync(new URL('scripts/tutorial/scripts/tutorial.rs2',root),'utf8').split('[label,tutorial_complete]')[1]!.split('\n[')[0]!;
 const added=(inv:string)=>[...label.matchAll(new RegExp(`inv_add\\(${inv}, (\\w+), (\\d+)\\)`,'g'))].map(m=>[ids[m[1]!],Number(m[2])]);
 for(const inv of ['inv','worn','bank'])expect(label).toContain(`inv_clear(${inv});`);
 expect(added('inv')).toEqual(HETTY_TUTORIAL_GRANT.pack.map(x=>[...x]));
 expect(added('bank')).toEqual(HETTY_TUTORIAL_GRANT.bank.map(x=>[...x]));
 expect(label).toContain('%tutorial = ^tutorial_complete;');
});

test('native fixture matches the retained populated quest entry before travel and coin deposit',()=>{
 const skills=Array.from({length:21},(_,index)=>({index,level:index===3?10:index===7?30:1,rawExperience:index===3?9800:index===7?75000:0,xp:index===3?980:index===7?7500:0}));
 const slots=(rows:{id:number;count:number}[])=>rows.map((i,slot)=>({slot,...i}));
 const entry={version:6,position:{x:2863,z:3428,level:0},skills,vars:{281:1000,29:2,63:6,179:22,192:2,67:0,101:6},inventories:{
  93:slots(HETTY_MATCHED_ENTRY.inventory!),94:HETTY_MATCHED_ENTRY.equipment!,95:slots(HETTY_MATCHED_ENTRY.bank!)}};
 expect(hettyCarriedEntry(entry)).toBe(true);
 expect(entry.inventories[93]).toHaveLength(4);expect(entry.inventories[95]).toHaveLength(29);
 expect(entry.inventories[93][0]).toEqual({slot:0,id:995,count:80});
 expect(entry.inventories[95][0]).toEqual({slot:0,id:995,count:19895});
 expect(entry.inventories[93].slice(1)).toEqual([1,2,3].map(slot=>({slot,id:1933,count:1})));
 expect(entry.inventories[94]).toEqual([]);
 for(const position of [{x:3092,z:3243,level:0},{x:3209,z:3215,level:0}])expect(hettyCarriedEntry({...entry,position})).toBe(false);
 for(const [container,count] of [[93,5],[95,20]] as const){
  expect(hettyCarriedEntry({...entry,inventories:{...entry.inventories,[container]:entry.inventories[container].map(i=>i.id===995?{...i,count}:i)}})).toBe(false);
 }
 expect(hettyCarriedEntry({...entry,inventories:{...entry.inventories,93:entry.inventories[93].filter(i=>i.id!==1933)}})).toBe(false);
 expect(hettyCarriedEntry({...entry,inventories:{...entry.inventories,94:[{slot:0,id:284,count:1}]}})).toBe(false);
 expect(hettyCarriedEntry({...entry,inventories:{...entry.inventories,93:[...entry.inventories[93]].reverse()}})).toBe(false);
 expect(hettyCarriedEntry({...entry,vars:{...entry.vars,67:3}})).toBe(false);
 expect(hettyCarriedEntry({...entry,vars:{...entry.vars,101:0}})).toBe(false);
 expect(hettyCarriedEntry({...entry,skills:skills.map(k=>k.index===6?{...k,xp:8125,level:31}:k)})).toBe(false);
});

test('registration login recount keeps the staged six quest points',()=>{
 // Retained registration save: only cookquest complete, so login ~update_questpoints wrote %qp 6->1.
 const root=new URL('../../../',import.meta.url);
 const ids=new Map(readFileSync(new URL('vendor/rs-sdk/server/content/pack/varp.pack',root),'utf8').split(/\r?\n/).map(l=>l.split('=')).map(([id,name])=>[name!,Number(id)]));
 const facts=JSON.parse(readFileSync(new URL('knowledge/quests.json',root),'utf8')) as {varp:string;complete:number;questPoints:number}[];
 const recount=(vars:Record<number,number>)=>facts.filter(q=>ids.has(q.varp)&&vars[ids.get(q.varp)!]===q.complete).reduce((n,q)=>n+q.questPoints,0);
 const vars=HETTY_MATCHED_ENTRY.varps!;
 expect(recount(vars)).toBe(vars[ids.get('qp')!]);
 expect(recount({29:2})).toBe(1);
 const skills=Array.from({length:21},(_,index)=>({index,level:index===3?10:index===7?30:1,rawExperience:index===3?9800:index===7?75000:0,xp:index===3?980:index===7?7500:0}));
 const slots=(rows:{id:number;count:number}[])=>rows.map((i,slot)=>({slot,...i}));
 const entry={version:9,position:{x:2863,z:3428,level:0},skills,vars:{...vars},inventories:{
  93:slots(HETTY_MATCHED_ENTRY.inventory!),94:HETTY_MATCHED_ENTRY.equipment!,95:slots(HETTY_MATCHED_ENTRY.bank!)}};
 expect(hettyCarriedEntry({...entry,vars:{...vars,101:recount(vars)}})).toBe(true);
 expect(hettyCarriedEntry({...entry,vars:{281:1000,29:2,101:1}})).toBe(false);
 for(const id of [63,179,192])expect(hettyCarriedEntry({...entry,vars:{...vars,[id]:0}})).toBe(false);
});

test('registered Tutorial Island entry is not mainland readiness; the grant is reconciled before quest costs',()=>{
 const skills=Array.from({length:21},(_,index)=>({index,level:index===3?10:1,rawExperience:index===3?9800:0,xp:index===3?980:0}));
 // Observed registration save: START3094,3106,0, empty containers, varp281=1.
 const registered={version:9,position:{x:3094,z:3106,level:0},skills,vars:{281:1},inventories:{93:[],94:[],95:[]}};
 expect(hettyRegisteredEntry(registered)).toBe(true);
 expect(hettyMainlandReady(registered)).toBe(false);
 const granted=tutorialGrantedSave(registered);
 expect(hettyMainlandReady({...granted,position:{x:3222,z:3218,level:0}})).toBe(true);
 for(const change of [{vars:{281:1000}},{position:{x:3222,z:3218,level:0}},{inventories:{93:[{slot:0,id:1277,count:1}],94:[],95:[]}},{skills:skills.map(k=>k.index===6?{...k,level:2,rawExperience:830,xp:83}:k)}])
  expect(hettyRegisteredEntry({...registered,...change})).toBe(false);
 // Quest spending: eye 3 + beef 1 from the banked 25; every other granted item retained.
 const after={...granted,position:{x:3092,z:3243,level:0},vars:{67:3,101:1,281:1000},
  inventories:{93:granted.inventories[93],94:[],95:[{slot:0,id:995,count:21}]},
  skills:skills.map(k=>k.index===6?{...k,level:31,rawExperience:81250,xp:8125}:k)};
 const r={code:0,log:'LOGOUT logged-out\nQUEST_COOK_JOB_RESULT '+JSON.stringify({ok:true,questKey:'hetty',ticks:100,logout:true,gather:{ok:true,purchases:[{id:221,coins:3},{id:2132,coins:1}],transitions:[{from:2132,to:2142},{from:2142,to:2146}]},quest:{ok:true},checks:{alive:true},before:{lifeId:0,respawns:0},after:{lifeId:0,respawns:0}})};
 expect(Object.values(hettyTutorialJobSavedChecks(registered,after,r)).every(Boolean)).toBe(true);
 // Without grant reconciliation the granted kit reads as unexplained assets and coins.
 expect(hettyLiveJobSavedChecks(registered,after,r).assets).toBe(false);
 expect(hettyLiveJobSavedChecks(registered,after,r).coins).toBe(false);
 expect(hettyTutorialJobSavedChecks(registered,{...after,vars:{67:3,101:1,281:1}},r).tutorial).toBe(false);
 expect(hettyTutorialJobSavedChecks(registered,{...after,inventories:{...after.inventories,93:after.inventories[93].filter(i=>i.id!==1277)}},r).assets).toBe(false);
 expect(hettyTutorialJobSavedChecks(registered,{...after,inventories:{...after.inventories,95:[{slot:0,id:995,count:20}]}},r).coins).toBe(false);
 expect(hettyTutorialJobSavedChecks({...registered,vars:{281:1000}},after,r).tutorialEntry).toBe(false);
});
test('only the fresh Hetty fixture binds and registers on exact IPv4 loopback',()=>{
 const name=runBotName('flqhjob',1);
 const fresh=`USERNAME=${name}\nPASSWORD=x\nSERVER=localhost:8888\nGATEWAY_URL=ws://localhost:7780\nTELEMETRY=false\n`;
 const bound=bindHettyFixtureIpv4(fresh)!;
 expect(bound).toBe(`USERNAME=${name}\nPASSWORD=x\nSERVER=127.0.0.1:8888\nGATEWAY_URL=ws://127.0.0.1:7780\nTELEMETRY=false\n`);
 for(const env of [fresh.replace('localhost:8888','rs-sdk-demo.fly.dev'),fresh.replace('ws://localhost:7780','ws://localhost:7781'),
  fresh+'SERVER=localhost:8888\n',fresh+'GATEWAY_URL=ws://localhost:7780\n',fresh.replace('GATEWAY_URL=ws://localhost:7780\n','')])expect(bindHettyFixtureIpv4(env)).toBeNull();
 const receipt={name,saveAbsent:true,credentialsAbsent:true};
 expect(practiceProfile(name,bound,receipt)).toBe('ipv4');
 // Default localhost fixtures (fresh-rune callers) need no receipt.
 expect(practiceProfile('frshxab3c1',fresh,null)).toBe('localhost');
 const rejected:[string,string,object|null][]=[
  [name,bound,null],[name,bound,{...receipt,saveAbsent:false}],[name,bound,{...receipt,credentialsAbsent:false}],[name,bound,{...receipt,name:name+'1'}],
  ['Moneyshot',bound,{...receipt,name:'Moneyshot'}],['Magicwanda',bound,{...receipt,name:'Magicwanda'}],['flqhjoxab3c2',bound,{...receipt,name:'flqhjoxab3c2'}],
  [name,bound.replace('127.0.0.1:8888','127.0.0.1:8889'),receipt],[name,bound.replace('127.0.0.1:8888','127.0.0.10:8888'),receipt],
  [name,bound.replace('127.0.0.1:8888','127.0.0.1.evil.io:8888'),receipt],[name,bound.replace('127.0.0.1:8888','[::1]:8888'),receipt],
  [name,bound.replace('127.0.0.1:8888','rs-sdk-demo.fly.dev'),receipt],[name,bound.replace('ws://127.0.0.1:7780','ws://127.0.0.1:7781'),receipt],
  [name,bound.replace('GATEWAY_URL=ws://127.0.0.1:7780\n',''),receipt],[name,bound+'GATEWAY_URL=ws://127.0.0.1:7780\n',receipt],
  [name,bound+'SERVER=127.0.0.1:8888\n',receipt],[name,bound+'SERVER=rs-sdk-demo.fly.dev\n',receipt],
  [name,bound.replace('SERVER=127.0.0.1:8888','SERVER=http://127.0.0.1:8888'),receipt],
 ];
 for(const [n,env,r] of rejected)expect(practiceProfile(n,env,r)).toBeNull();
});

test('saved proof stays valid across the observed 1041714ms native-turn delay but rejects future or non-finite timestamps',()=>{
 const at=1794601703587;
 expect(savedProofTimestampValid(at,at+1041714)).toBe(true);
 expect(savedProofTimestampValid(at,at)).toBe(true);
 expect(savedProofTimestampValid(at+1,at)).toBe(false);
 for(const bad of [NaN,Infinity,-Infinity,undefined,null,String(at)])expect(savedProofTimestampValid(bad,at+1041714)).toBe(false);
});
