import {test,expect} from 'bun:test';
import {reconcilePreparation,preparationRoute} from './preparation-report';
import type {TravelModel} from '../packages/planner/src/travel';
import {observedRouteResources} from './preparation-route-state';
const now=1000000;
const model:TravelModel={places:{start:{x:0,z:0},target:{x:10,z:0}},cache:{directed:true,banks:{pickup:{x:4,z:0}},nearestBank:{},legs:{'start>pickup':{runTicks:2,tiles:4,gates:[{id:'out',source:'pinned',requires:[['consume:rope:1']]}]},'pickup>target':{runTicks:3,tiles:6,gates:[{id:'back',source:'pinned',requires:[['consume:rope:1','skill:agility:56']]}]}}}};
const courier=(count=2)=>({name:'Courier',server:'rs-sdk-demo.fly.dev',at:now-1,bankAt:now-1,bank:[],inventory:count?[{id:954,count}]:[],equipment:[],equipmentObserved:true,skills:[{name:'Agility',level:56,currentLevel:56}]});
const donor={name:'Donor',server:'rs-sdk-demo.fly.dev',at:now-1,bankAt:now-1,bank:[{id:333,name:'Trout',count:10}]};
const request={from:'start',to:'target',count:10,capacity:10,budget:{coins:0,food:0},context:{account:'Courier',server:'rs-sdk-demo.fly.dev',at:now,maxAgeMs:300000},resources:{held:{rope:999},facts:{'skill:agility:56':true}},stops:[{holder:'Donor',bank:'pickup',reserved:0,outbound:{coins:0,food:0,accessible:true},onward:{coins:0,food:0,accessible:true}}]};
const report=(c:any)=>reconcilePreparation([{item:'Trout',count:10}],[donor,c],['Courier','Donor'],now);

test('ordinary observed guild facts reach actual route consumer, caller assertions stay powerless',()=>{
 const leg=(token:string)=>({runTicks:2,tiles:4,gates:[{id:'guild',source:'pinned guild source',requires:[[token]]}]});
 const gated={...model,cache:{...model.cache,legs:{'start>pickup':leg('quest:legendsquest:50'),'pickup>target':leg('unlock:prayer-guild')}}};
 const facts={varps:{qp:32},questStages:{legendsquest:50},unlocks:['prayer-guild']};
 expect(preparationRoute(report({...courier(),guildFacts:facts}),gated,'Trout',request).selected).not.toBeNull();
 expect(preparationRoute(report({...courier(),guildFacts:{...facts,questStages:{legendsquest:1}}}),gated,'Trout',request).selected).toBeNull();
 expect(preparationRoute(report(courier()),gated,'Trout',{...request,resources:{facts:{'quest:legendsquest:50':true,'unlock:prayer-guild':true}}} as any).selected).toBeNull();
 expect(preparationRoute(report({...courier(),at:now-300001,guildFacts:facts}),gated,'Trout',request).selected).toBeNull();
});

test('guild facts keep unknown membership/private stages explicit and require observed QP thresholds',()=>{
 const c={...courier(),guildFacts:{varps:{qp:31},questStages:{heroquest:15,legendsquest:1},unlocks:['dwarf-tower']}};
 const tokens=['questpoints:32','quest:heroquest:15','quest:legendsquest:50','unlock:dwarf-tower','unlock:prayer-guild'];
 expect(observedRouteResources(c,'Courier',c.server,now,tokens).resources.facts).toEqual({'questpoints:32':false,'quest:heroquest:15':true,'quest:legendsquest:50':null,'unlock:dwarf-tower':true,'unlock:prayer-guild':null});
 const missing=observedRouteResources(courier(),'Courier',c.server,now,tokens).resources.facts;
 expect(Object.values(missing!).every(v=>v===null)).toBe(true);
});

test('CastleWars banner restriction requires exact worn observation or an actually observed other team',()=>{
 const token='cw:not-own-banner:0:castlewars_saradomin_banner';
 const fact=(a:any)=>observedRouteResources(a,'Courier',a.server,now,[token]).resources.facts![token];
 expect(fact({...courier(),equipment:[{id:4037,count:1}],guildFacts:{castlewarsTeam:0}})).toBe(false);
 expect(fact({...courier(),equipment:[{id:4037,count:1}],guildFacts:{castlewarsTeam:1}})).toBe(true);
 expect(fact({...courier(),equipment:[{id:4037,count:1}]})).toBeNull();
 expect(fact({...courier(),equipment:undefined,guildFacts:{castlewarsTeam:0}})).toBeNull();
 expect(fact({...courier(),equipment:undefined,guildFacts:{castlewarsTeam:1}})).toBe(true);
 expect(fact(courier())).toBe(true);
 expect(fact({...courier(),equipmentObserved:false})).toBeNull();
 expect(fact({...courier(),equipmentObserved:undefined})).toBeNull();
 expect(fact({...courier(),equipment:[{id:4037,count:1}],guildFacts:{castlewarsTeam:2}})).toBeNull();
});

test('CW main gate route needs the observed own team OR exact current open-door fact',()=>{
 const open='door-open:0:2426:3088',team='cw:team:0';
 const leg={runTicks:2,tiles:4,gates:[{id:'saradomin-main',source:'pinned castlewars_maindoor.rs2',requires:[[team],[open]]}]};
 const gated={...model,cache:{...model.cache,legs:{'start>pickup':leg,'pickup>target':leg}}};
 const attempt=(c:any,req:any=request)=>preparationRoute(report(c),gated,'Trout',req).selected;
 expect(attempt({...courier(),guildFacts:{castlewarsTeam:0},doorStates:{'0,2426,3088':false}})).not.toBeNull();
 expect(attempt({...courier(),guildFacts:{castlewarsTeam:1},doorStates:{'0,2426,3088':true}})).not.toBeNull();
 expect(attempt({...courier(),guildFacts:{castlewarsTeam:1},doorStates:{'0,2426,3088':false}})).toBeNull();
 expect(attempt({...courier(),guildFacts:{castlewarsTeam:1}})).toBeNull();
 expect(attempt({...courier(),guildFacts:{castlewarsTeam:1},doorStates:{}},{...request,resources:{facts:{[open]:true,[team]:true}}})).toBeNull();
 for(const changes of [{at:now-300001},{at:now+1},{server:'other-server'}])expect(attempt({...courier(),...changes,doorStates:{'0,2426,3088':true}})).toBeNull();
});

test('door states distinguish closed from unknown and reject another anchor/plane or malformed truth',()=>{
 const tokens=['door-open:0:2426:3088','door-open:1:2426:3088','door-open:0:2427:3088','cw:team:0','cw:team:1'];
 const actor={...courier(),doorStates:{'0,2426,3088':false,'0,2427,3088':'true'},guildFacts:{castlewarsTeam:1}};
 const facts=observedRouteResources(actor,'Courier',actor.server,now,tokens).resources.facts;
 expect(facts).toEqual({'door-open:0:2426:3088':false,'door-open:1:2426:3088':null,'door-open:0:2427:3088':null,'cw:team:0':false,'cw:team:1':true});
 expect(observedRouteResources({...actor,doorStates:undefined,guildFacts:{castlewarsTeam:2}},'Courier',actor.server,now,tokens).resources.facts).toEqual(Object.fromEntries(tokens.map(t=>[t,null])));
});

test('caller-supplied carried items and facts cannot fabricate transport readiness',()=>{
 expect(preparationRoute(report(courier(0)),model,'Trout',request).selected).toBeNull();
 const low={...courier(),skills:[{name:'Agility',level:55,currentLevel:55}]};
 expect(preparationRoute(report(low),model,'Trout',request).selected).toBeNull();
});
test('fresh actual carried exact IDs and current stat facts support both legs',()=>{
 expect(preparationRoute(report(courier()),model,'Trout',request).selected).not.toBeNull();
 expect(preparationRoute(report(courier(1)),model,'Trout',request).selected).toBeNull();
});
test('bank stock, notes and stale/future/foreign snapshots never become carried rope',()=>{
 for(const c of [{...courier(0),bank:[{id:954,count:10}]},{...courier(),inventory:[{id:955,baseId:954,count:2}]},{...courier(),at:now-300001},{...courier(),at:now+1},{...courier(),server:'foreign'}]){
  expect(preparationRoute(report(c),model,'Trout',request).selected).toBeNull();
 }
});
test('declared reservations stay restrictive after caller held/facts are replaced',()=>{
 expect(preparationRoute(report(courier()),model,'Trout',{...request,resources:{...request.resources,reserved:{rope:1}}}).selected).toBeNull();
});
test('missing carried coin observation cannot use an asserted budget, but a known worn alternative can',()=>{
 const gate=(requires:string[][])=>({id:'toll',source:'pinned',requires});
 const leg=(requires:string[][])=>({runTicks:2,tiles:4,gates:[gate(requires)]});
 const cashModel={...model,cache:{...model.cache,legs:{'start>pickup':leg([['coins:1']]),'pickup>target':leg([['coins:1']])}}};
 const unknown={...courier(),inventory:undefined,equipment:[{id:1171,count:1}]};
 const req={...request,budget:{coins:100,food:0}};
 expect(preparationRoute(report(unknown),cashModel,'Trout',req).selected).toBeNull();
 const alternative={...cashModel,cache:{...cashModel.cache,legs:{'start>pickup':leg([['coins:1'],['item:wooden_shield:worn']]),'pickup>target':leg([['coins:1'],['item:wooden_shield:worn']])}}};
 expect(preparationRoute(report(unknown),alternative,'Trout',req).selected).not.toBeNull();
});
test('stat gates use current drained/boosted values and never substitute a legacy base level',()=>{
 const drained={...courier(),skills:[{name:'Agility',level:56,currentLevel:55}]};
 expect(preparationRoute(report(drained),model,'Trout',request).selected).toBeNull();
 const boosted={...courier(),skills:[{name:'Agility',level:55,currentLevel:56}]};
 expect(preparationRoute(report(boosted),model,'Trout',request).selected).not.toBeNull();
 const legacy={...courier(),skills:[{name:'Agility',level:56}]};
 expect(preparationRoute(report(legacy),model,'Trout',request).selected).toBeNull();
});
test('an explicitly sourced STAT_BASE gate uses base level independently of a drained current stat',()=>{
 const leg=(token:string)=>({runTicks:2,tiles:4,gates:[{id:'monastery',source:'pinned base-prayer gate',requires:[[token]]}]});
 const withBase={...model,cache:{...model.cache,legs:{'start>pickup':leg('base-skill:prayer:31'),'pickup>target':leg('base-skill:prayer:31')}}};
 const prayer={...courier(),skills:[{name:'Prayer',level:31,currentLevel:0}]};
 expect(preparationRoute(report(prayer),withBase,'Trout',request).selected).not.toBeNull();
 const withCurrent={...withBase,cache:{...withBase.cache,legs:{'start>pickup':leg('skill:prayer:31'),'pickup>target':leg('skill:prayer:31')}}};
 expect(preparationRoute(report(prayer),withCurrent,'Trout',request).selected).toBeNull();
});
